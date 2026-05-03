# Tasks Dashboard

**Type:** spec · **Status:** draft · **Updated:** 2026-05-01
**Depends on:** ui-shell.md, beads-integration.md, daemon-api-endpoints.md, document-linking.md
**Source material:** vision/SLE-018-tasks-dashboard.md
**Resolves:** —

## Overview

The tasks dashboard is the content layer of the Overview page (see
ui-shell.md). It provides the extensible widget system that renders alongside
the fixed panels (Actions Required, Active Jobs, Tasks, Sharding Review, Recent
Activity, Documents). The page chrome, navigation, and fixed-panel layout are
defined in ui-shell.md; this spec covers only the dashboard content area.

The dashboard combines two capabilities:

1. **Multi-level task system** — tasks scoped to nodes, groups, or the whole
   project, with lifecycle tracking, Beads sync, and AI-suggested task flows.
2. **Modular widget-based layout** — the system auto-generates widgets based on
   project state; the user controls placement, sizing, and visibility via
   drag-and-drop.

The dashboard consumes the daemon API exclusively (daemon-api-endpoints.md) and
receives real-time updates over the daemon's single WebSocket connection
(`ws://localhost:7700/events`). It does not implement business logic — all
mutations are dispatched to the daemon and reflected via events.

The layout is persisted to `.sle/dashboard/` as JSON files, enabling
version-controlled dashboard configurations per user per project. The widget
system is extensible: auto-generated widgets appear based on project heuristics,
and user-added widgets are persisted alongside them.

---

## Data model

### Task

The dashboard's task model extends the daemon's `SLETask` (beads-integration.md)
with level scoping, priority ranking, pinning, and source attribution.

```typescript
interface TaskLink {
  target_type: 'artifact' | 'document' | 'task' | 'cycle'
  target_id: string
  relationship: 'blocks' | 'blocked_by' | 'related_to' | 'produces' | 'consumes'
}

interface Task {
  id: string
  title: string
  description?: string
  level: 'node' | 'group' | 'project'
  status: 'todo' | 'in_progress' | 'done' | 'cancelled'
  priority: 'low' | 'medium' | 'high' | 'critical'
  pinned: boolean
  source: 'user' | 'cycle' | 'ai_suggestion'
  assignee: string | null
  parent_group_id?: string
  parent_node_id?: string
  suggested?: boolean
  links: TaskLink[]
  created_at: string
  updated_at: string
  completed_at: string | null
}
```

**Field mapping to SLETask (beads-integration.md):**

| Task field | SLETask field | Mapping |
|---|---|---|
| `id` | `id` | Direct |
| `title` | `title` | Direct |
| `description` | `description` | Direct |
| `status: 'todo'` | `status: 'open'` | Dashboard uses `todo`; daemon uses `open` |
| `status: 'in_progress'` | `status: 'in_progress'` | Direct |
| `status: 'done'` | `status: 'closed'` | Dashboard uses `done`; daemon uses `closed` |
| `status: 'cancelled'` | N/A | Dashboard-local; daemon has no cancelled state |
| `priority` | `priority` | Dashboard uses labels; daemon uses 1–4 numeric |
| `created_at` | `created_at` | Direct |
| `updated_at` | `updated_at` | Direct |

Fields `level`, `pinned`, `source`, `parent_group_id`, `parent_node_id`, and
`suggested` are dashboard-local metadata stored in `.sle/tasks/` files, not in
the Beads task store.

### Task levels

| Level | Scope | Beads sync | Parent refs | Storage |
|---|---|---|---|---|
| `node` | Single node in a group layer | Optional | `parent_group_id` + `parent_node_id` required | `.sle/tasks/groups/{group_id}/nodes/{node_id}.json` |
| `group` | Feature group (spans layers) | Always (bead) | `parent_group_id` required | `.sle/tasks/groups/{group_id}/group-tasks.json` |
| `project` | Whole project, cross-cutting | Always (epic) | None | `.sle/tasks/project-tasks.json` |

Node-level tasks are the finest granularity. Group-level tasks track feature work
that spans multiple layers. Project-level tasks track cross-cutting concerns.

### Task status mapping

The dashboard uses a four-state lifecycle. The mapping between dashboard states
and daemon/Beads states is bidirectional:

| Dashboard status | Daemon status | Beads status | Transitions from |
|---|---|---|---|
| `todo` | `open` | `open` | Initial state, accepted AI suggestion |
| `in_progress` | `in_progress` | `in_progress` | `todo` |
| `done` | `closed` | `closed` | `in_progress` |
| `cancelled` | N/A (dashboard-only) | N/A | `todo`, `in_progress` |

The `cancelled` state is dashboard-local. When a task is cancelled in the
dashboard, the daemon is instructed to close the task with a cancellation
comment. The daemon sees it as `closed`; the dashboard records the cancellation
in its local metadata.

### Priority

```typescript
type TaskPriority = 'low' | 'medium' | 'high' | 'critical'
```

| Priority label | Daemon numeric | Sort weight | Color |
|---|---|---|---|
| `critical` | 1 | Highest | Red |
| `high` | 2 | High | Orange |
| `medium` | 3 | Default | Blue |
| `low` | 4 | Low | Gray |

### Pin state

```typescript
interface PinState {
  task_id: string
  pinned: boolean
  pin_source: 'user' | 'system'
  pinned_at?: string
}
```

Pinning is tracked in `.sle/tasks/pins.json`. System pins are automatic:
tasks enter `in_progress` and are auto-pinned; tasks enter `done` and are
auto-unpinned. User pins persist across status changes until manually removed.

### Task source

```typescript
type TaskSource = 'user' | 'cycle' | 'ai_suggestion'
```

| Source | Origin | Initial status |
|---|---|---|
| `user` | Manual creation via UI or CLI | `todo` |
| `cycle` | SLE cycle produces artifacts with incomplete coverage | `todo` |
| `ai_suggestion` | Planner/Critic identifies gaps | Pre-acceptance (suggested) |

AI-suggested tasks start in a pre-acceptance state: `suggested: true` and status
`todo`, but rendered with a dashed border and "Suggested" badge. The user must
explicitly accept the suggestion before the task enters normal `todo` flow.

### DashboardWidget

```typescript
interface DashboardWidget {
  id: string
  type: WidgetType
  title: string
  position: { x: number; y: number; w: number; h: number }
  collapsed: boolean
  source: 'auto_generated' | 'user'
  config?: Record<string, unknown>
}

type WidgetType =
  | 'group_health_strip'
  | 'test_coverage_trend'
  | 'cycle_history'
  | 'uncovered_requirements'
  | 'recent_activity'
  | 'code_stats'
  | 'task_summary'
  | 'pinned_notes'
  | 'task_board'
  | 'quick_write'
  | 'ai_assistant'
  | 'pinned_groups'
  | 'document_browser'
  | 'scope_draft_list'
  | 'next_cycle_targets'
```

`position` uses a grid coordinate system where `x` and `y` are column/row
indices, `w` and `h` are span in grid units. The grid has 4 columns on desktop,
2 on tablet, 1 on phone.

### Auto-generated widgets

Auto-generated widgets are proposed by the system based on project state. They
are stored in `.sle/dashboard/widgets/auto-generated/` and rendered with a
pulsing border to indicate they are proposals. The user can accept (persist),
dismiss, or customize them.

| Widget | Trigger | Data source |
|---|---|---|
| `group_health_strip` | Always | `GET /api/v2/map` — group layer-completion dots |
| `test_coverage_trend` | Tests exist | Cycle report history |
| `cycle_history` | Cycles completed | `GET /api/v2/cycles` — pass/fail/halted |
| `uncovered_requirements` | Requirements without tests | `GET /api/v2/artifacts` + link index |
| `recent_activity` | Always | File changes + task mutations since last visit |
| `code_stats` | Code exists | File index — lines, files, deps |
| `task_summary` | Tasks exist | `GET /api/v2/tasks` — counts per level, overdue |

### User-controlled widgets

User widgets are explicitly added from the widget palette. They are stored in
`.sle/dashboard/widgets/user/`.

| Widget | Description | Config |
|---|---|---|
| `pinned_notes` | Markdown notes, color-coded | `{ color: string, content: string }` |
| `task_board` | Kanban at chosen level | `{ level: 'node' \| 'group' \| 'project' }` |
| `quick_write` | Minimal input for ideas | `{ default_scope: string }` |
| `ai_assistant` | Project-aware chat with action buttons | `{ session_id: string }` |
| `pinned_groups` | Expanded view of specific groups | `{ group_ids: string[] }` |
| `document_browser` | Searchable document tree | `{ root_scope: string }` |
| `scope_draft_list` | Active scope drafts with node counts and tag counts (DDR-028) | `{ }` |
| `next_cycle_targets` | Nodes tagged `#next-cycle`, grouped by group (DDR-028) | `{ }` |

### QuickWriteEntry

```typescript
interface QuickWriteEntry {
  id: string
  text: string
  suggested_scope: 'node' | 'document' | 'task' | 'note'
  disposition?: 'node' | 'document' | 'task' | 'note'
  created_at: string
}
```

The quick-write scratchpad accepts freeform text and suggests a scope. The user
chooses a disposition:

| Disposition | Action |
|---|---|
| `node` | Create a node-level task scoped to current context |
| `document` | Open document editor with text as seed |
| `task` | Create a new task (group or project level) |
| `note` | Create a pinned dashboard note with the text |

### Layout file

```typescript
interface DashboardLayout {
  version: number
  grid_columns: 4 | 2 | 1
  widgets: DashboardWidget[]
  last_modified: string
  user_id: string
}
```

### Dashboard preferences

```typescript
interface DashboardPreferences {
  theme: 'light' | 'dark' | 'system'
  refresh_interval_ms: number
  default_task_level: 'node' | 'group' | 'project'
  show_ai_suggestions: boolean
  compact_mode: boolean
}
```

### File-based storage layout

```
.sle/dashboard/
├── layout.json                        — widget positions/sizes/collapsed state
├── preferences.json                   — theme, refresh intervals
├── widgets/
│   ├── auto-generated/                — proposed widgets
│   │   └── {widget_type}.json
│   └── user/                          — user-added configs
│       └── {widget_id}.json

.sle/tasks/
├── project-tasks.json                 — project-level tasks
├── groups/
│   └── {group_id}/
│       ├── group-tasks.json           — group-level tasks
│       └── nodes/
│           └── {node_id}.json         — node-level tasks
├── pins.json                          — pin state for all tasks
└── beads-sync.json                    — sync state metadata
```

### Task lifecycle FSM

```
                 ┌──────────────────────────────────────────┐
                 │              AI suggestion                │
                 │  (suggested=true, dashed border, badge)  │
                 └──────────────────┬───────────────────────┘
                                    │ accept
                                    ▼
  ┌─────────┐   start    ┌──────────────┐   complete   ┌──────┐
  │  todo   │ ──────────▶│ in_progress  │ ────────────▶│ done │
  └────┬────┘            └──────┬───────┘              └──────┘
       │                        │
       │  cancel                │ cancel
       ▼                        ▼
  ┌───────────┐          ┌───────────┐
  │ cancelled │          │ cancelled │
  └───────────┘          └───────────┘
```

Valid transitions:

| From | To | Trigger |
|---|---|---|
| (AI suggestion) | `todo` | User accepts suggestion |
| `todo` | `in_progress` | User starts work / claims task |
| `in_progress` | `done` | User completes / daemon resolves as completed |
| `todo` | `cancelled` | User cancels |
| `in_progress` | `cancelled` | User cancels |
| `done` | `todo` | User reopens (rare) |

Reopened tasks (`done` → `todo`) are allowed via a "Reopen" action. The daemon
reopens the task as `open` with a comment.

---

## Behavior

### Dashboard initialization

On load, the dashboard performs the following sequence:

1. `GET /api/v2/system/state` — determine current daemon state
2. `GET /api/v2/tasks` — load all tasks
3. `GET /api/v2/cycles?limit=10` — load recent cycle history
4. `GET /api/v2/map` — load group and artifact metadata
5. Read `.sle/dashboard/layout.json` — load persisted widget layout
6. Read `.sle/dashboard/preferences.json` — load user preferences
7. Read `.sle/tasks/pins.json` — load pin state
8. Establish WebSocket connection for real-time updates
9. Evaluate auto-generated widget triggers against loaded data
10. Propose new auto-generated widgets not in current layout

Steps 1–4 are REST calls to the daemon. Steps 5–7 read local files served by
the UI shell. Steps 8–10 are client-side logic.

### Widget rendering lifecycle

Each widget follows a consistent lifecycle:

1. **Evaluate trigger** — check if the widget's data source has content
2. **Render proposal** (auto-generated only) — pulsing border, "Add to dashboard" button
3. **Load data** — fetch from REST endpoint or local file
4. **Render content** — display widget body
5. **Subscribe to updates** — listen for relevant WebSocket events
6. **Update on event** — re-fetch data or patch in-place

Auto-generated widgets that the user has dismissed are tracked in the layout
file with `collapsed: true` and a `dismissed_at` timestamp. They are not
re-proposed for 7 days.

### Kanban board behavior

The task board widget renders tasks as a Kanban board with level tabs and
status columns.

**Level tabs:** `[node] [group] [all]`

- `node` — shows only node-level tasks
- `group` — shows only group-level tasks
- `all` — shows all tasks, grouped by level then status

**Columns by status:** `Todo | In Progress | Done`

Cancelled tasks are hidden by default. A "Show cancelled" toggle reveals them
in a fourth column.

**Tag filtering (DDR-028):**

The filter bar includes a "Tagged #next-cycle" filter option. When active:
- Only tasks linked to nodes tagged `#next-cycle` are shown
- Task cards linked to tagged nodes show a tag indicator (orange dot)
- Tagged tasks are visually prioritized at the top of their column

**Card rendering:**

| Element | Indicator |
|---|---|
| Level | `●` = node, `◆` = project (no symbol for group) |
| Priority | Color bar on left edge (red/orange/blue/gray) |
| Pinned | Pin icon at top-right |
| AI suggestion | Dashed border + "Suggested" badge |
| Done | `✓` with completion timestamp |
| Source | Subtle icon (user=circle, cycle=arrow, AI=spark) |

**Sorting within columns:**

1. Pinned tasks first
2. Priority descending (critical → low)
3. Updated_at descending (most recent first)

### Task CRUD operations

**Create task:**

1. User clicks "New task" or uses quick-write with `task` disposition
2. Dashboard presents creation form: title, description, level, priority, group/node assignment
3. If level is `group` or `project`, dashboard calls `POST /api/v2/tasks` with task data
4. If level is `node`, dashboard creates the task in `.sle/tasks/groups/{group_id}/nodes/{node_id}.json`
5. Dashboard writes task metadata (level, source, parent refs) to local storage
6. Task appears in the Kanban board under `todo`

**Edit task:**

1. User clicks task card to open detail panel
2. User modifies fields (title, description, priority, level)
3. Dashboard calls `POST /api/v2/tasks/{task_id}/comments` to record the edit
4. Dashboard updates local metadata file
5. WebSocket event `task.claimed` or `task.resolved` may follow if status changed

**Delete task:**

1. User clicks "Delete" on task detail panel
2. Dashboard confirms via dialog
3. For daemon-synced tasks: dashboard sets status to `cancelled` via `POST /api/v2/tasks/{task_id}/close` with cancellation message
4. For node-level tasks: dashboard removes from local file
5. Pin state is cleaned up

**Accept AI suggestion:**

1. User clicks "Accept" on a suggested task card
2. Dashboard sets `suggested: false`, source remains `ai_suggestion`
3. Task transitions from pre-acceptance to normal `todo`
4. If the task should sync to Beads (group or project level), dashboard calls `POST /api/v2/tasks` to create it in the daemon's task store

### Pinning behavior

**User-initiated pin:**

1. User clicks pin icon on task card
2. Dashboard updates `pins.json`: `pinned: true`, `pin_source: 'user'`, `pinned_at: now`
3. Task card moves to top of its Kanban column
4. Pinned indicator appears on card

**System-initiated pin:**

1. Task transitions to `in_progress` (via `task.claimed` WebSocket event)
2. Dashboard checks pin state in `pins.json`
3. If not already pinned: auto-pin with `pin_source: 'system'`
4. Task appears in the pinned section at the top of the dashboard

**Auto-unpin:**

1. Task transitions to `done` (via `task.resolved` WebSocket event with outcome `completed`)
2. Dashboard checks `pin_source`: if `system`, auto-unpin
3. If `pin_source: 'user'`, the pin persists — user must manually unpin

**Pin persistence:**

Pins are stored in `.sle/tasks/pins.json` as an array of `PinState` objects.
This file is the single source of truth for pin state. It is read on dashboard
load and updated on every pin/unpin action.

### Quick-write flow

1. User types freeform text into quick-write scratchpad
2. Client sends text to AI assistant for scope suggestion
3. Dashboard presents scope suggestion with options: `Node | Document | Task | Note`
4. User selects disposition
5. Dashboard executes the corresponding action:

| Disposition | Action |
|---|---|
| `node` | Create node-level task in `.sle/tasks/groups/{group_id}/nodes/{node_id}.json` |
| `document` | Navigate to document editor with text as initial content |
| `task` | `POST /api/v2/tasks` with title from text, then open task detail |
| `note` | Create a `pinned_notes` widget with text as content |

6. Quick-write entry is recorded in local storage for history

Dispositions are always user-chosen. The system suggests but never auto-applies
a disposition.

### Task targeting for cycles

When starting a cycle from the dashboard, the user can target a specific task:

1. User clicks "Start cycle" on a task card or from the cycle control bar
2. Dashboard passes task ID to the cycle start flow: `sle start "..." --task {task_id}`
3. The daemon claims the task and runs the cycle
4. WebSocket events (`task.claimed`, `dispatch.progress`, `cycle.completed`) update the dashboard in real time

This integrates with the daemon's cycle start endpoint:

```
POST /api/v2/cycles
{
  "goal": string,
  "task_id": string,
  "scope_draft_id"?: string
}
```

**Scope draft integration (DDR-028):**

- A task can be linked to a scope draft via `scope_draft_id`
- "Start cycle" button on task cards now opens the scope draft selector
  (if scope drafts exist) or falls back to quick-start goal entry
- `POST /api/v2/cycles` with `scope_draft_id` instead of just `goal`

### Beads sync for tasks

Group and project level tasks sync with the Beads task store via the daemon:

1. Dashboard creates task via `POST /api/v2/tasks`
2. Daemon routes to active TaskStore (BeadsTaskStore or LocalTaskStore)
3. Dashboard records task level metadata locally

Node-level tasks are optionally synced:

1. Dashboard creates task in local `.sle/tasks/` file
2. User clicks "Promote to Beads" on the task detail panel
3. Dashboard calls `POST /api/v2/tasks` to create in the daemon's task store
4. Dashboard updates local metadata: `beads_id` field added
5. Future status changes are synced bidirectionally via WebSocket events

### Real-time update handling

The dashboard subscribes to WebSocket events and updates widgets in-place:

| Event | Widgets affected | Update |
|---|---|---|
| `cycle.started` | cycle_history, task_summary | Add cycle entry |
| `cycle.completed` | cycle_history, task_summary, recent_activity | Update cycle status, task counts |
| `cycle.halted` | cycle_history, recent_activity | Mark cycle as halted |
| `dispatch.progress` | cycle_history (if cycle widget visible) | Update progress bar |
| `task.claimed` | task_board, task_summary | Move task to In Progress, auto-pin |
| `task.resolved` | task_board, task_summary | Move task to Done, auto-unpin if system pin |
| `task.stale_detected` | task_board, task_summary | Show stale warning badge |
| `run.artifact_written` | recent_activity | Add change entry |
| `link.index_updated` | document_browser, uncovered_requirements | Refresh data |

Client-side optimistic updates are applied for quick-write dispositions and
pin/unpin actions. The server confirms on disposition. If the server rejects,
the optimistic update is rolled back with a toast notification.

### AI assistant panel

The AI assistant widget provides project-aware chat:

1. User opens AI assistant panel (widget or bottom-sheet on mobile)
2. Dashboard calls `POST /api/v2/chat/session/open`
3. User types query or selects a suggested action
4. Dashboard calls `POST /api/v2/chat/message`
5. Response streams via WebSocket `chat.message` events on the shared
   connection (`ws://localhost:7700/events`), with streaming tokens delivered
   incrementally
6. Action buttons in the response (e.g., "Create task", "Start cycle") dispatch
   to the appropriate API endpoint

The AI assistant has access to project context via the daemon's context manager.
It can suggest tasks, explain cycle outcomes, and propose dashboard arrangements.

AI actions that mutate state require explicit user confirmation. Read-only
queries (e.g., "What tasks are overdue?") execute without confirmation.

### Mobile responsive behavior

| Breakpoint | Columns | Behavior |
|---|---|---|
| Desktop (>1200px) | 4 | Full layout, all widgets visible |
| Tablet (768–1200px) | 2 | Widgets reflow to 2 columns, AI assistant full-width at bottom |
| Phone (<768px) | 1 | Stack vertically, auto-gen widgets collapse to summaries, graphs become lists, AI assistant becomes bottom-sheet |

Auto-generated widgets default to collapsed on phone breakpoint. The user can
expand individual widgets. Collapsed widgets show a single-line summary:

- `task_summary`: "12 tasks: 3 todo, 2 in progress, 7 done"
- `cycle_history`: "Last cycle: completed (3 iterations)"
- `code_stats`: "1,247 lines across 34 files"

The grid system recalculates widget positions on breakpoint change. Widget
positions for each breakpoint are stored in the layout file under a
`breakpoints` key.

### Visual indicators

| Indicator | Appearance | Context |
|---|---|---|
| Node level | `●` symbol on task card | Node-scoped task |
| Project level | `◆` symbol on task card | Project-scoped task |
| Pinned | Pin icon, top-right of card | Pinned task |
| Done | `✓` with timestamp | Completed task |
| AI suggestion | Dashed border + "Suggested" badge | Pre-acceptance task |
| Proposed widget | Pulsing border | Auto-generated widget awaiting acceptance |
| Group health dot | `●●●○○●●─` | Layer completion in group health strip (filled=complete, empty=incomplete, dash=not started) |
| Priority | Color bar on card left edge | critical=red, high=orange, medium=blue, low=gray |
| Stale | Warning triangle badge | Stale task detected |

---

## API contract

The dashboard consumes endpoints defined in daemon-api-endpoints.md. Endpoints
are listed here for cross-reference only — the daemon is the single source of
truth.

### Task endpoints consumed

| Endpoint | Method | Purpose | Dashboard usage |
|---|---|---|---|
| `/api/v2/tasks` | GET | List all tasks | Task board, task summary widget |
| `/api/v2/tasks/ready` | GET | Tasks ready to claim | "Start cycle" task picker |
| `/api/v2/tasks` | POST | Create task | Task creation form, quick-write |
| `/api/v2/tasks/{task_id}` | GET | Task detail | Task detail panel |
| `/api/v2/tasks/{task_id}/claim` | POST | Claim task | Start work action |
| `/api/v2/tasks/{task_id}/close` | POST | Close task | Complete task action |
| `/api/v2/tasks/{task_id}/resolve-exit` | POST | Resolve with exit code | Cycle completion handling |

### System endpoints consumed

| Endpoint | Method | Purpose | Dashboard usage |
|---|---|---|---|
| `/api/v2/system/state` | GET | Project status | Dashboard header, cycle controls |
| `/api/v2/cycles` | GET | Cycle history | Cycle history widget |
| `/api/v2/cycles/{cycle_id}` | GET | Cycle details | Cycle detail view |
| `/api/v2/cycles` | POST | Start cycle | "Start cycle" button |
| `/api/v2/map` | GET | Project map | Group health strip, document browser |
| `/api/v2/artifacts` | GET | List artifacts | Code stats, document browser widgets |

### Chat endpoints consumed

| Endpoint | Method | Purpose | Dashboard usage |
|---|---|---|---|
| `/api/v2/chat/session/open` | POST | Open chat session | AI assistant panel |
| `/api/v2/chat/session` | DELETE | Close chat session | AI assistant panel close |
| `/api/v2/chat/message` | POST | Send message | AI assistant input |

### New dashboard-specific endpoints

These endpoints are specified here and will be added to daemon-api-endpoints.md.

**Get dashboard tasks:**

```
GET /api/v2/dashboard/tasks

Query params:
  level: 'node' | 'group' | 'project' | null
  status: 'todo' | 'in_progress' | 'done' | 'cancelled' | null
  pinned: boolean | null
  limit: number (default 100, max 500)

Response 200:
{
  "ok": true,
  "data": {
    "tasks": DashboardTask[],
    "pinned_ids": string[],
    "counts": {
      "node": { "todo": number, "in_progress": number, "done": number, "cancelled": number },
      "group": { "todo": number, "in_progress": number, "done": number, "cancelled": number },
      "project": { "todo": number, "in_progress": number, "done": number, "cancelled": number }
    }
  }
}
```

`DashboardTask` is the daemon's `SLETask` extended with the dashboard's local
metadata (level, pinned, source, suggested, parent refs). The daemon reads these
from `.sle/tasks/` files and merges them.

**Update task pin:**

```
PATCH /api/v2/dashboard/tasks/{task_id}/pin

Request:
{
  "pinned": boolean,
  "pin_source": "user" | "system"
}

Response 200:
{
  "ok": true,
  "data": {
    "task_id": string,
    "pinned": boolean,
    "pin_source": string
  }
}

Response 404: task_not_found
```

**Accept AI suggestion:**

```
POST /api/v2/dashboard/tasks/{task_id}/accept

Response 200:
{
  "ok": true,
  "data": {
    "task_id": string,
    "suggested": false,
    "status": "todo"
  }
}

Response 409:
{
  "ok": false,
  "error": {
    "code": "not_suggested",
    "message": "Task is not an AI suggestion."
  }
}

Response 404: task_not_found
```

**Cancel task:**

```
POST /api/v2/dashboard/tasks/{task_id}/cancel

Request:
{
  "reason": string | null
}

Response 200:
{
  "ok": true,
  "data": {
    "task_id": string,
    "status": "cancelled"
  }
}

Response 409:
{
  "ok": false,
  "error": {
    "code": "invalid_cancel",
    "message": "Cannot cancel a task that is already done."
  }
}

Response 404: task_not_found
```

**Get dashboard summary:**

```
GET /api/v2/dashboard/summary

Response 200:
{
  "ok": true,
  "data": {
    "task_counts": {
      "node": { "todo": number, "in_progress": number, "done": number },
      "group": { "todo": number, "in_progress": number, "done": number },
      "project": { "todo": number, "in_progress": number, "done": number }
    },
    "overdue_tasks": number,
    "pinned_count": number,
    "active_cycle": string | null,
    "last_cycle_outcome": string | null,
    "group_health": Array<{
      "group_id": string,
      "layers": Array<"complete" | "incomplete" | "not_started">
    }>,
    "recent_activity_count": number
  }
}
```

**Promote node task to Beads:**

```
POST /api/v2/dashboard/tasks/{task_id}/promote

Response 200:
{
  "ok": true,
  "data": {
    "task_id": string,
    "beads_id": string
  }
}

Response 409:
{
  "ok": false,
  "error": {
    "code": "not_node_level",
    "message": "Only node-level tasks can be promoted."
  }
}

Response 409:
{
  "ok": false,
  "error": {
    "code": "already_promoted",
    "message": "Task is already synced with Beads."
  }
}

Response 404: task_not_found
```

### WebSocket events consumed

```
event: cycle.started
{
  "cycle_id": string,
  "goal": string,
  "task_id": string | null,
  "timestamp": string
}

event: cycle.completed
{
  "cycle_id": string,
  "outcome": "completed",
  "iterations": number,
  "timestamp": string
}

event: cycle.halted
{
  "cycle_id": string,
  "outcome": "halted" | "user_halt" | "error",
  "reason": string,
  "timestamp": string
}

event: dispatch.progress
{
  "cycle_id": string,
  "total_jobs": number,
  "completed_jobs": number,
  "failed_jobs": number,
  "timestamp": string
}

event: task.claimed
{
  "task_id": string,
  "claimed_by": string,
  "timestamp": string
}

event: task.resolved
{
  "task_id": string,
  "outcome": string,
  "new_status": string,
  "timestamp": string
}

event: task.stale_detected
{
  "task_id": string,
  "stale_for_ms": number,
  "timestamp": string
}

event: run.artifact_written
{
  "artifact_id": string,
  "path": string,
  "size_bytes": number,
  "timestamp": string
}

event: link.index_updated
{
  "added": number,
  "removed": number,
  "timestamp": string
}
```

### WebSocket chat streaming

The AI assistant panel uses the shared WebSocket connection
(`ws://localhost:7700/events`) for streaming chat responses:

```
event: chat.message
{
  "session_id": string,
  "message_id": string,
  "delta": { "content": string },
  "actions": Array<{ "type": "create_task" | "start_cycle" | "pin_task", "params": object }>,
  "done": boolean
}
```

The `delta.content` field carries incremental tokens. When `done` is `true`, the
message is complete and `message_id` is final. Action buttons are extracted from
the `actions` array and rendered for user confirmation.

---

## Error cases

### Task operation errors

| Error code | Condition | Response | Recovery |
|---|---|---|---|
| `task_not_found` | Task ID does not exist in store | 404 with task ID | Client refreshes task list |
| `task_already_claimed` | Claim on a task already in progress | 409 with current status | Client updates card position, shows notification |
| `not_suggested` | Accept on a task that is not an AI suggestion | 409 with task ID | Client hides accept button |
| `invalid_cancel` | Cancel on a task that is `done` or already `cancelled` | 409 with current status | Client refreshes task state |
| `not_node_level` | Promote on a non-node-level task | 409 with task level | Client hides promote button for non-node tasks |
| `already_promoted` | Promote on a task already synced with Beads | 409 with beads_id | Client shows "Already in Beads" state |

### Widget errors

| Error code | Condition | Response | Recovery |
|---|---|---|---|
| `layout_corrupt` | `layout.json` fails to parse | Load system default layout | User reconfigures; log warning |
| `widget_load_failed` | Widget data source returns error | Widget shows error state with retry | User clicks retry or dismisses widget |
| `dashboard_data_stale` | WebSocket disconnect detected | Show "Reconnecting..." banner | Auto-reconnect with exponential backoff |

### Dashboard-specific errors

| Error code | Condition | Response | Recovery |
|---|---|---|---|
| `pin_conflict` | Concurrent pin/unpin from multiple clients | 409 with current pin state | Client re-reads `pins.json` and reconciles |
| `layout_conflict` | Layout file modified externally | Diff and merge or prompt user | Client reloads layout |
| `task_store_unavailable` | Daemon task store is down (503) | Dashboard shows degraded mode — local tasks visible, sync tasks grayed out | Retry on WebSocket reconnect |
| `suggestion_expired` | AI suggestion was invalidated (e.g., underlying gap resolved) | Remove suggestion card, show toast | No user action needed |

### Data consistency errors

| Error code | Condition | Response | Recovery |
|---|---|---|---|
| `optimistic_rollback` | Server rejects optimistic update | Rollback client state, show error toast | User retries action |
| `pin_file_corrupt` | `pins.json` fails to parse | Reset to empty pins, log warning | All pins reset; user re-pins |
| `task_file_corrupt` | Node/group task file invalid JSON | Skip corrupt file, load remaining tasks | Log warning with file path |

---

## Constraints

1. **Dashboard does not own business logic.** All state mutations are dispatched
   to the daemon via REST API. The dashboard is a rendering and interaction
   layer. Task creation, status transitions, and Beads sync are daemon
   responsibilities.

2. **Layout is per-user, per-project.** Widget positions, sizes, and collapsed
   state are stored in `.sle/dashboard/layout.json` keyed by `user_id`. A system
   default layout is used when no user layout exists. Users can reset to the
   default at any time.

3. **AI-suggested tasks require explicit acceptance.** Suggested tasks cannot
   transition to `in_progress` or `done` without first being accepted. The
   "Suggested" badge and dashed border remain until acceptance.

4. **Quick-write dispositions are user-chosen.** The system suggests a scope but
   never auto-applies a disposition. The user must confirm `Node | Document |
   Task | Note` before the action executes.

5. **SLE is source of truth for node-level tasks.** Node-level tasks exist in
   `.sle/tasks/groups/{group_id}/nodes/{node_id}.json`. They optionally sync to
   Beads via promotion but the local file is authoritative until promoted.

6. **Auto-generated widgets default to collapsed on mobile.** On screens below
   768px, auto-generated widgets collapse to a single-line summary. User-added
   widgets remain expanded unless the user manually collapses them.

7. **Widget proposals expire after 7 days.** Dismissed auto-generated widgets
   are not re-proposed for 7 days. After 7 days, if the trigger condition still
   holds, the widget is re-proposed.

8. **System pins are transient.** System-initiated pins (auto-pin on
   `in_progress`) are automatically removed when the task reaches `done`. User
   pins persist across all status changes until manually removed.

9. **Cancelled tasks are daemon-closed.** The dashboard's `cancelled` state maps
   to the daemon's `closed` state. The dashboard records cancellation metadata
   locally. The daemon receives a close request with a cancellation message.

10. **WebSocket is the primary update channel.** After initial REST load, all
    updates are delivered via WebSocket events. The dashboard does not poll.
    If the WebSocket disconnects, a reconnection banner appears and a single
    REST re-sync is performed on reconnect.

11. **File-based layout is version-controlled.** `.sle/dashboard/` is intended
    to be committed to the project repository. Layout changes are written
    atomically (write to temp, rename). Merge conflicts in layout files are
    resolved by the client using last-write-wins with user notification.

12. **AI actions require confirmation.** Any AI assistant action that mutates
    state (create task, start cycle, modify artifact) requires explicit user
    confirmation. Read-only queries execute without confirmation.

13. **The `cancelled` status is dashboard-only.** The daemon has no `cancelled`
    concept. Cancelling a dashboard task closes it in the daemon with a
    cancellation comment. The dashboard tracks the cancellation locally.

14. **Beads sync is asynchronous.** Promoting a node-level task to Beads does
    not block the dashboard. The task card shows a "syncing" indicator until
    the `task_store.sync` WebSocket event confirms success or failure.

15. **Performance target: initial load under 2 seconds.** The dashboard must
    render the full layout with data from all widgets within 2 seconds on a
    broadband connection. Widget data is fetched in parallel. Auto-generated
    widget proposals are evaluated client-side from already-loaded data.

---

## Open questions

| ID | Question | Impact | Status |
|---|---|---|---|
| TD-001 | Should the dashboard support multiple Kanban boards (one per group) or always aggregate into a single board? | Layout complexity, widget design | Open |
| TD-002 | What is the maximum number of widgets before the layout engine degrades? | Performance, scrolling behavior | Open |
| TD-003 | Should AI-suggested tasks have an expiration timer (e.g., auto-dismiss after 30 days)? | Stale suggestion accumulation | Open |
| TD-004 | Should the layout file support collaborative editing (multiple users, same project)? | Layout conflict resolution, merge strategy | Open |
| TD-005 | Should the quick-write scratchpad persist history across sessions? | UX continuity, storage growth | Open |
| TD-006 | What is the debounce interval for layout writes during drag-and-drop? | File I/O frequency, merge conflict window | Open |
| TD-007 | Should the AI assistant panel support multi-turn conversation history, or is it single-turn per query? | State management, token budget | Open |
| TD-008 | Should group health strip dots be clickable to navigate to the group detail view? | Navigation design, widget interactivity | Open |
| TD-009 | Should the dashboard support custom widget plugins from users? | Extensibility, security sandboxing | Open |
| TD-010 | What happens when the daemon is unreachable but the UI shell is running? | Offline mode, cached data display | Open |
| TD-011 | Should the cycle history widget support filtering by outcome (pass/fail/halted)? | Widget complexity, API pagination | Open |
| TD-012 | Is there a maximum number of pinned tasks before the pinned section requires scrolling? | Layout overflow, pin UX | Open |
| TD-013 | Should the dashboard expose a CLI equivalent for all dashboard actions (e.g., `sle dashboard pin task-042`)? | CLI/UI feature parity, automation | Open |
| TD-014 | Should node-level tasks that are promoted to Beads retain their node-level scoping metadata, or does it become a standard Beads task? | Data model consistency, round-trip fidelity | Open |
| TD-015 | What is the retry strategy for failed widget data loads? | UX resilience, network error handling | Open |
| TD-016 | ~~How should cycle scoping work from the tasks dashboard?~~ Resolved by DDR-028: scope draft selector on "Start cycle" button, `scope_draft_id` parameter on `POST /api/v2/cycles`. | — | Resolved (DDR-028) |
