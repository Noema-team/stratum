# UI Shell & Navigation

| Type | Status | Updated |
|------|--------|---------|
| Spec | Draft | 2026-05-01 |

**Depends on:** daemon-api-endpoints.md, conversation.md, document-linking.md, run-artifacts.md, state-machine.md
**Companion specs:** tasks-dashboard.md expands the Overview page; project-overview.md defines the Graph page data model and interactions; conversation.md defines Chat behavior; user-flow.md defines end-to-end navigation flows; backlog-system.md defines the backlog panel (post-MVP).
**Source material:** vision/SLE-020-ui-shell-navigation.md, decisions/ddr-026-sharding-approval-ui.md
**Resolves:** A4 (Web UI spec from Round 1)

## Overview

The UI shell is the browser-based interface to a running SLE daemon. It presents
three flat pages — Overview, Chat, Graph — behind a persistent navigation bar
and consumes the daemon's REST API and WebSocket event stream to render live
project state. The shell does not host business logic; it is a thin rendering
layer over the daemon API defined in daemon-api-endpoints.md.

The Overview page is the project dashboard and the only page where mutation
happens. It combines fixed panels (Actions Required, Active Jobs, Tasks,
Sharding Review, Recent Activity, Documents) with the extensible widget system
defined in tasks-dashboard.md. Fixed panels always appear; widgets are
user-configurable. The Chat page is a persistent Facilitator conversation
independent of workflow-run state — it can discuss a CONFIRM checkpoint but
cannot approve or halt one. The Graph page renders the committed project
artifact graph as a force-directed layout, reflecting stable state only. The
Graph page data model is defined in project-overview.md.

Gate panels are modal overlays, not page navigations. When the daemon emits
`workflow_run.checkpoint_requested` for a CONFIRM or SHARDING_APPROVAL
checkpoint, an overlay appears over whichever page the user is on. Approval
and rejection actions happen inside the overlay and close it on completion.
This keeps the user's navigation context intact during interruption.

## Data model

### Page route

```typescript
type PageRoute = 'overview' | 'chat' | 'graph'
```

Three pages, flat navigation, no nested routes for MVP.

### Navigation state

```typescript
interface ShellState {
  active_page: PageRoute
  daemon_connected: boolean
  system_state: SystemStatus
  active_workflow_run_count: number
  active_overlay: OverlayKind | null
  graph_detail_node: string | null
}

type OverlayKind =
  | 'confirm_gate'
  | 'gate_pass'
  | 'sharding_approval'
  | 'artifact_detail'

type SystemStatus =
  | 'idle'
  | 'discovering'
```

`daemon_connected` tracks whether the WebSocket to `ws://localhost:7700/events`
is open. `system_state` is the project-wide state — per-run progress lives on
each `WorkflowRun.status` in `ActiveJobsPanel`, not here (DDR-031 decision 5).
`active_overlay` is `null` unless a gate event arrives or the user selects a
graph node that opens the detail panel.

### Tasks panel data

```typescript
interface TasksPanel {
  tasks: Array<{
    id: string
    title: string
    status: 'open' | 'in_progress' | 'blocked' | 'closed'
    assignee: string | null
    age_minutes: number
  }>
}
```

Sourced from `GET /api/v2/tasks` and `GET /api/v2/tasks/ready`. Polled on page
load and refreshed on `task.claimed` / `task.resolved` WebSocket events.

### Active Jobs panel data

```typescript
interface ActiveJobsPanel {
  workflow_runs: Array<{
    run_id: string
    workflow_id: string
    status: 'active' | 'halted' | 'complete'
    current_step_id: string
    iteration: number
    revision: number
    awaiting_checkpoint: string | null
    agents: Array<{
      name: string
      step_id: string
      progress: number
      elapsed_ms: number
    }>
    validation: Array<{
      category: string
      phase: 'static' | 'llm' | 'executable'
      status: 'pending' | 'running' | 'passed' | 'failed'
    }>
  }>
}
```

One entry per active `WorkflowRun` — multiple runs render as multiple cards
(DDR-031 decision 5/9). Populated initially from `GET /api/v2/workflow-runs`
and, per run, `GET /api/v2/workflow-runs/{run_id}/dispatch`. Updated in real
time by `workflow_run.started`, `workflow_run.completed`, `workflow_run.halted`,
`dispatch.progress`, `validation.progress`, `step.started`, `step.completed`,
and `run.artifact_written` WebSocket events.

### Actions-required panel data

```typescript
interface ActionsRequiredPanel {
  gates: Array<{
    kind: 'confirm' | 'gate_pass' | 'sharding_approval' | 'scoping'
    run_id: string
    iteration: number
    revision: number
    priority: 'critical' | 'normal'
    summary: string
    created_at: string
  }>
  blocked_tasks: Array<{
    task_id: string
    title: string
    blocker: string
  }>
}
```

`priority` is `critical` for any gate — that run is paused and waiting. Gates
are derived per run from `GET /api/v2/workflow-runs/{run_id}` (`awaiting_checkpoint`
field) and the `workflow_run.checkpoint_requested` WebSocket event, which
carries the `step_id` of the checkpoint (CONFIRM, SHARDING_APPROVAL, or
SCOPING's checkpoint step) to determine `kind`.

**Scoping gate** (`awaiting_checkpoint` pointing at SCOPING's checkpoint step):
- Title: "Scoping Discussion"
- Description: "Review and refine workflow-run scope with the Facilitator"
- Action: Opens chat page in scoping mode (FacilitatorMode `'scoping'`)

### Recent Activity panel data

```typescript
interface RecentActivityPanel {
  events: Array<{
    id: string
    kind: 'workflow_run_completed' | 'artifact_updated' | 'task_created' | 'task_resolved'
    summary: string
    timestamp: string
    run_id?: string
    task_id?: string
  }>
}
```

Shows a reverse-chronological feed of workflow-run completions, artifact
updates, and new/resolved tasks. Populated from WebSocket events and capped
at the last 50 entries.

### Documents panel data

```typescript
interface DocumentsPanel {
  recent_artifacts: Array<{
    id: string
    path: string
    category: string
    updated_at: string
  }>
}
```

Quick-access browser for recent artifacts. Sourced from
`GET /api/v2/links` (artifact nodes sorted by recency). Clicking an artifact
opens the `artifact_detail` overlay.

### Chat panel data

```typescript
interface ChatPanelState {
  session_open: boolean
  messages: Array<{
    ts: string
    role: 'user' | 'facilitator'
    content: string
    sources?: string[]
    decision_detected?: boolean
  }>
  context_indicator: {
    loaded_docs: string[]
    workflow_run_state: string | null
  }
  input_text: string
}
```

History loaded on page open from `GET /api/v2/chat/messages` (if session open).
New messages arrive via `chat.message` WebSocket event. The context indicator
shows which documents the Facilitator has loaded (derived from the last
Facilitator response's `sources` field and current workflow-run state).

### Graph panel data

The Graph page data model is defined in project-overview.md. The shell renders
`ProjectGroup` nodes with their lifecycle layers, `LayerNode` items, and
`ProjectEdge` connections. This interface provides only the shell-level
rendering state.

```typescript
interface GraphPanelState {
  layout: 'group' | 'layer' | 'radial'
  selected_node: string | null
}

interface GraphDetailPanel {
  node_id: string
  label: string
  type: import('project-overview').NodeType
  scope: 'project' | 'group'
  artifact_path: string | null
  links: Array<{
    direction: 'inbound' | 'outbound'
    target_id: string
    target_label: string
    kind: import('project-overview').ProjectEdge['type']
  }>
  content_preview: string | null
}
```

Sourced from `GET /api/v2/links`. Refreshed on `link.index_updated` WebSocket
event. `selected_node` triggers the detail panel, which replaces full-page
content on the Graph page (not an overlay).

### Confirm gate overlay data

```typescript
interface ConfirmGateOverlay {
  run_id: string
  iteration: number
  revision: number
  plan_summary: {
    step_count: number
    test_count: number
    coverage_pct: number
  }
  steps: Array<{
    step_id: string
    description: string
    constraints: string[]
  }>
  test_coverage: Array<{
    category: string
    tests: number
    covered_requirements: number
  }>
  actions: Array<'approve' | 'modify' | 'halt'>
}
```

Populated from `workflow_run.checkpoint_requested` WebSocket event (CONFIRM
checkpoint) plus `GET /api/v2/workflow-runs/{run_id}` for step and coverage
detail.

### Sharding approval overlay data

```typescript
interface ShardingApprovalOverlay {
  run_id: string
  proposal: {
    task_count: number
    tasks: Array<{
      index: number
      title: string
      description: string
      context_declarations: string[]
      dependencies: string[]
    }>
  }
  coherence_report_summary: string
  actions: Array<'approve' | 'reject' | 'modify'>
}
```

Populated from `workflow_run.checkpoint_requested` WebSocket event (SHARDING_APPROVAL
checkpoint) plus `GET /api/v2/workflow-runs/{run_id}` for the full sharding
proposal.

### Gate pass overlay data

```typescript
interface GatePassOverlay {
  run_id: string
  iteration: number
  validation_summary: {
    categories_total: number
    categories_passed: number
    warnings: number
  }
  snapshot_ready: boolean
}
```

Shown after all validation passes. The user reviews the summary and locks a
snapshot via the run's `commit` step. Populated from `gate.result` WebSocket
event plus `GET /api/v2/workflow-runs/{run_id}` for validation detail.
Referenced by user-flow.md.

### Step kind reference

Steps within a run are identified by `step_id`, each backed by one of the
six generic `StepKind` values (`gather`, `produce`, `review`, `checkpoint`,
`execute`, `commit`). See step-kind-reference.md for the full reference and
full-build's step-by-step mapping.

## Behavior

### Shell lifecycle

```
1. Browser loads UI shell
   │
   ▼
2. Establish WebSocket to ws://localhost:7700/events
   │  On success: daemon_connected := true, render [● live] indicator
   │  On failure: daemon_connected := false, render [○ disconnected]
   │  Retry with exponential backoff (250ms, 500ms, 1s, 2s, max 5s)
   │
   ▼
3. Initial data fetch (parallel)
   │  GET /api/v2/system/state    → ShellState.system_state
   │  GET /api/v2/tasks           → TasksPanel.tasks
   │  GET /api/v2/tasks/ready     → TasksPanel.tasks (merged)
   │  GET /api/v2/links           → GraphPanelState.nodes, edges
   │  If session_open: GET /api/v2/chat/messages → ChatPanelState.messages
   │  GET /api/v2/workflow-runs (active) → ActiveJobsPanel
   │  Per active run: GET /api/v2/workflow-runs/{id}/dispatch → ActiveJobsPanel
   │
   ▼
4. Render Overview page (default landing page)
   │
   ▼
5. Event loop — WebSocket messages drive re-renders
   │  system.state_changed         → ShellState.system_state
   │  workflow_run.started         → ActiveJobsPanel (add run)
   │  workflow_run.completed       → ActiveJobsPanel (remove run)
   │  workflow_run.halted          → ActiveJobsPanel (update)
   │  dispatch.progress            → ActiveJobsPanel (agent progress)
   │  step.started / step.completed → ActiveJobsPanel (step progress)
   │  workflow_run.checkpoint_requested → ActionsRequiredPanel + overlay
   │  validation.progress          → ActiveJobsPanel (validation)
   │  chat.message                 → ChatPanelState.messages (append)
   │  chat.session_changed         → ChatPanelState.session_open
   │  link.index_updated           → GraphPanelState (re-fetch links)
   │  run.artifact_written         → ActiveJobsPanel (progress)
   │  task.claimed / task.resolved → TasksPanel (re-fetch tasks)
   │
   ▼
6. User navigates between pages via nav bar
   │  No page unloads data — all three pages retain their state
   │  WebSocket events update all pages regardless of which is active
   │
   ▼
7. Gate overlay appears over active page (not navigation)
   │  User approves/rejects/modifies inside overlay
   │  Overlay closes, page state resumes
```

### Navigation flow

```
┌────────────────────────────────────────────────────────────────────┐
│ [● live]  Overview  |  Chat  |  Graph                             │
└────────────────────────────────────────────────────────────────────┘
      │                  │          │
      ▼                  ▼          ▼
  Overview page      Chat page    Graph page
  ┌────────────┐    ┌──────────┐  ┌──────────────┐
  │ Actions Req│    │ History  │  │ Force-directed│
  │ Active Jobs│    │ Context  │  │ graph canvas  │
  │ Tasks      │    │ Input    │  │ Layout toggle │
  │ Sharding   │    │          │  │               │
  │ Recent Act │    └──────────┘  └──────┬────────┘
  │ Documents  │                        │
  └────────────┘                        ▼
                                   Detail panel
                                   (replaces canvas)

 Overlay (modal, appears over any page):
 ┌─────────────────────────────┐
 │ CONFIRM Gate / Sharding     │
 │ Review content              │
 │ [Approve] [Modify] [Halt]  │
 │ [Reject] [Modify]          │
 └─────────────────────────────┘
```

### Overview page behavior

The Overview page is read-mostly. It displays current state and provides action
buttons for gates. Mutation is limited to: approving/rejecting gates, opening
task detail, and acknowledging state changes.

```
┌─────────────────────────────────────────────────┐
│ Overview                                         │
├─────────────────────────────────────────────────┤
│                                                  │
│ ┌─ Actions Required ──────────────────────────┐ │
│ │ ⚠ CONFIRM checkpoint: full-build-4, iter 2 (12m ago) │ │
│ │   [Review & Approve] [Modify] [Halt]        │ │
│ └─────────────────────────────────────────────┘ │
│                                                  │
│ ┌─ Active Jobs ──────────────────────────────┐   │
│ │ full-build-4 · BUILD · iter 2 · rev 0      │   │
│ │ Builder: ████████░░ 80% · 45s elapsed      │   │
│ │ Validation:                                  │   │
│ │   correctness: ✓ passed                     │   │
│ │   performance: ● running                    │   │
│ │   security: ○ pending                       │   │
│ └─────────────────────────────────────────────┘   │
│                                                  │
│ ┌─ Tasks ────────────────────────────────────┐   │
│ │ #T-31 Rate limiter refactor · in_progress  │   │
│ │   assigned: Builder · age: 2h              │   │
│ │ #T-32 Auth middleware · open · ready       │   │
│ │ #T-33 Logging cleanup · blocked → #T-31   │   │
│ └─────────────────────────────────────────────┘   │
│                                                  │
│ ┌─ Sharding Review ──────────────────────────┐   │
│ │ (empty when no sharding proposal pending)  │   │
│ └─────────────────────────────────────────────┘   │
│                                                  │
│ ┌─ Recent Activity ──────────────────────────┐   │
│ │ full-build-3 completed · 12m ago           │   │
│ │ Artifact: auth-middleware.md · 34m ago     │   │
│ │ Task #T-29 resolved · 1h ago              │   │
│ └─────────────────────────────────────────────┘   │
│                                                  │
│ ┌─ Documents ────────────────────────────────┐   │
│ │ architecture.md · updated 34m ago          │   │
│ │ rate-limiting.md · updated 1h ago          │   │
│ └─────────────────────────────────────────────┘   │
│                                                  │
└──────────────────────────────────────────────────┘
```

Panel priority order (top to bottom):

1. **Actions Required** — always first, highest priority. Shows gates, blocked
   issues, and human decisions. Empty panel is hidden (not shown as blank).
2. **Active Jobs** — live progress for every active `WorkflowRun`. Empty when
   no run is active. Renamed from "Jobs Processing" to align with
   user-flow.md terminology.
3. **Tasks** — Beads tasks. Always shown, even when empty ("No active tasks").
   Renamed from "Active Work" to align with user-flow.md terminology.
4. **Sharding Review** — only visible when some active run's
   `awaiting_checkpoint` points at a SHARDING_APPROVAL checkpoint, or a
   sharding proposal exists from that run.
5. **Recent Activity** — reverse-chronological feed of workflow-run
   completions, artifact updates, and task changes. Always visible, capped at
   last 50 entries. Added per user-flow.md reference.
6. **Documents** — quick-access browser for recent artifacts. Always visible.
   Clicking an artifact opens the `artifact_detail` overlay. Added per
   user-flow.md reference.

The Overview page combines these fixed panels with the extensible widget system
defined in tasks-dashboard.md. Fixed panels always appear; widgets are
user-configurable.

### Actions-required panel flow

```
daemon emits workflow_run.checkpoint_requested (CONFIRM checkpoint)
  │
  ▼
ActionsRequiredPanel receives event
  │  Add gate to panel with priority: critical
  │  If active_overlay is null: auto-open overlay
  │
  ▼
User clicks [Review & Approve] in panel (or overlay is already open)
  │
  ▼
Confirm gate overlay renders with plan steps, test coverage, revision count
  │
  ├── User clicks [Approve]
  │     POST /api/v2/workflow-runs/{run_id}/approve
  │     On 200: close overlay, clear gate from panel
  │     On 409: show error toast ("No checkpoint awaiting approval")
  │
  ├── User clicks [Modify]
  │     Overlay switches to modify mode:
  │       - Editable plan steps (add/remove/reorder/edit)
  │       - Editable test criteria
  │     On submit: POST /api/v2/workflow-runs/{run_id}/revise
  │     On 200: close overlay, Jobs panel shows the TEST step
  │     On 409: show error toast
  │
  └── User clicks [Halt]
        POST /api/v2/workflow-runs/{run_id}/halt
        On 200: close overlay, that run's status → halted
        On 409: show error toast

daemon emits workflow_run.checkpoint_requested (SHARDING_APPROVAL checkpoint)
  │
  ▼
ActionsRequiredPanel receives event
  │  Add sharding gate to panel with priority: critical
  │  Sharding Review panel also becomes visible
  │
  ▼
Sharding approval overlay renders with task list, context declarations,
coherence report summary
  │
  ├── [Approve] → POST /api/v2/workflow-runs/{run_id}/sharding/approve
  │     On 200: close overlay, create Beads tasks, proceed to CONFIRM
  │
  ├── [Reject] → POST /api/v2/workflow-runs/{run_id}/sharding/reject
  │     On 200: close overlay, Planner re-plans without sharding
  │
  └── [Modify] → Overlay enters edit mode (add/remove/edit tasks)
        POST /api/v2/workflow-runs/{run_id}/sharding/modify
        On 200: re-render updated proposal in overlay
```

### Chat page behavior

```
┌──────────────────────────────────────────────────┐
│ Chat                              [ctx: docs ● ] │
├──────────────────────────────────────────────────┤
│                                                   │
│ Facilitator: I've reviewed the rate limiter       │
│ architecture. The Redis-backed approach looks      │
│ sound. Two things to consider: ...                │
│ Sources: doc:architecture, node:rate-limiting:*   │
│                                                   │
│ User: Let's use a sliding window instead of       │
│ fixed window for the rate limiter                 │
│                                                   │
│ Facilitator: You've decided to use a sliding      │
│ window algorithm. Capture this decision?          │
│   [y] Capture  [n] Skip  [e] Edit               │
│                                                   │
│ ──────────────────────────────────────────────    │
│ [Type a message...                    ] [Send]    │
└──────────────────────────────────────────────────┘
```

The chat page is independent of workflow-run state. It works whether the
system is `idle` or `discovering`, and regardless of how many workflow runs
are active, halted, or complete. The Facilitator can observe workflow-run
state (read-only) but cannot trigger, modify, or halt runs.

**Approval separation:** The chat page can discuss a CONFIRM checkpoint in
freeform Q&A. Actual approval happens on the Overview page's Actions Required
panel or via the gate overlay. The chat page renders a banner when a gate is
active:

```
┌──────────────────────────────────────────────────┐
│ ⚠ A CONFIRM checkpoint is active. Review and     │
│ approve on the Overview page.                     │
└──────────────────────────────────────────────────┘
```

**Session open/close:**

```
User opens Chat page (session not open)
  │  POST /api/v2/chat/session/open
  │  On 200: ChatPanelState.session_open := true
  │  Load last N messages from chat-history
  │
  ▼
Freeform exchange loop
  │  User types message, presses Send
  │  POST /api/v2/chat/message { content }
  │  Response streamed via chat.message WebSocket event
  │  Append to ChatPanelState.messages
  │  Update context_indicator from response sources
  │
  ▼
User navigates away from Chat page
  │  Session remains open (does not close on navigation)
  │  chat.message events continue to append to ChatPanelState
  │
  ▼
User closes browser or session timeout
  │  DELETE /api/v2/chat/session (on page unload if possible)
  │  Session closes. History persisted in daemon-side chat-history.jsonl
```

**Pre-run scoping UI (DDR-028):**

When the system is idle and the user wants to start a workflow run:
- "Start scoping" button appears in the chat input area
- Scope draft management: list existing scope drafts, create new one
- Tag indicator panel: show which nodes/layers are tagged `#next-run`
- When a run is in one of full-build's SCOPING steps: chat automatically
  switches to scoping mode (`FacilitatorMode: 'scoping'`) via the
  `workflow_run.checkpoint_requested` WebSocket event for SCOPING's
  checkpoint step

### Graph page behavior

```
┌──────────────────────────────────────────────────┐
│ Graph                    [group ▾] [layer] [radial]│
├──────────────────────────────────────────────────┤
│                                                   │
│         ┌──────────┐                              │
│         │requirements│──────┐                     │
│         └──────────┘      │                      │
│              │             ▼                      │
│         ┌──────────┐  ┌──────────┐               │
│         │architecture│  │ test-plan │              │
│         └──────────┘  └──────────┘               │
│              │             │                      │
│     ┌────────┼────────┐   │                      │
│     ▼        ▼        ▼   ▼                      │
│  ┌─────┐ ┌─────┐ ┌─────┐                        │
│  │auth │ │rate │ │user │                         │
│  │group│ │limit│ │group│                         │
│  └─────┘ └─────┘ └─────┘                        │
│                                                   │
└──────────────────────────────────────────────────┘
```

**Graph data source:** `GET /api/v2/links` returns the full link index from
document-linking.md. Node and edge types are defined in project-overview.md
(`NodeType` union and `ProjectEdge.type`). The shell renders `ProjectGroup`
nodes with their lifecycle layers as a force-directed layout.

**Committed state only.** The graph reflects artifacts that have been committed
via a run's `commit` step (e.g. full-build's SNAPSHOT step). In-progress
workflow-run work does not appear. This prevents the graph from flickering
during execution.

**Workflow-run start UI (DDR-028, resolves UI-001):**

A "New workflow run" button appears on the Overview page (top-right of Active
Jobs panel) and on the Chat page (when idle). Clicking it opens a dialog:
- Choose a workflow (e.g. `full-build`, `draft-artifact`, or a user-authored
  workflow) and target
- Choose scope draft (if any exist) or enter a quick-start goal
- Option to set `version_bump` override
- Starts the run via `POST /api/v2/workflow-runs` with `workflow_id`, `target`,
  and `scope_draft_id` or `quick_start_goal`

**Tag indicators on graph nodes (DDR-028):**

Tagged nodes show colored badges (see project-overview.md §Tag visual indicators).
The filter bar includes a "Tagged for next run" filter option. Right-click
context menu includes tag actions (delegated to project-overview.md §Graph
interactions).

**Layout toggles:**

| Layout | Grouping | Use case |
|---|---|---|
| `group` | Feature group clusters | Understand task boundaries |
| `layer` | Artifact type (docs, tests, impl) | Understand dependency depth |
| `radial` | Hub-and-spoke from requirements | Understand centrality |

**Node selection and detail panel:**

```
User clicks a node on the graph canvas
  │
  ▼
GraphPanelState.selected_node := node_id
  │  Canvas area replaced by GraphDetailPanel
  │  Panel shows: label, type, scope, links (inbound/outbound),
  │  content preview (first 200 chars of artifact)
  │
  ▼
User clicks "Back to graph" or presses Escape
  │  selected_node := null
  │  Canvas area restored
  │
  ▼
User clicks artifact path in detail panel
  │  active_overlay := 'artifact_detail'
  │  Fetch GET /api/v2/artifacts/{id}
  │  Render full artifact content in overlay
```

### Gate overlay behavior

Gate overlays are modal — they block interaction with the underlying page. They
appear when the daemon emits a gate-awaiting event, regardless of which page the
user is viewing.

```
┌────────────────────────────────────────────────────────────┐
│ ░░░░░░░░░░░░░░░░░░░░░░░ (dimmed page behind) ░░░░░░░░░░░ │
│                                                            │
│   ┌─ CONFIRM Checkpoint — full-build-4, Iteration 2 ───┐  │
│   │                                                      │  │
│   │ Plan: 6 steps · 12 tests · 87% coverage · Rev 0    │  │
│   │                                                      │  │
│   │ Step 1: Add rate limiter middleware                  │  │
│   │ Step 2: Configure sliding window parameters         │  │
│   │ Step 3: ...                                         │  │
│   │                                                      │  │
│   │ Test coverage:                                       │  │
│   │   correctness: 8/8 tests                             │  │
│   │   performance: 2/3 tests (1 gap)                    │  │
│   │   security: 2/2 tests                                │  │
│   │                                                      │  │
│   │ [Approve]  [Modify Steps]  [Modify Criteria]  [Halt]│  │
│   │                                                      │  │
│   └──────────────────────────────────────────────────────┘  │
│                                                            │
│ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
└────────────────────────────────────────────────────────────┘
```

**Overlay rules:**

- Only one overlay active at a time
- Overlay is dismissible only by taking an action (approve/modify/halt/reject)
- No "close without action" button — the daemon is paused and waiting
- Overlay cannot be bypassed by navigating to another page
- WebSocket reconnection during overlay: overlay persists, re-fetches state

### Sharding approval flow in UI

The sharding approval is a separate human checkpoint from CONFIRM (DDR-026).
The flow surfaces in two places: the Actions Required panel and the Sharding
Review panel.

```
Run reaches its SHARDING_APPROVAL checkpoint step
  │  WorkflowRun.awaiting_checkpoint := <sharding_approval step_id>
  │  daemon emits workflow_run.checkpoint_requested event
  │
  ▼
Actions Required panel adds sharding gate (priority: critical)
Sharding Review panel becomes visible on Overview page
  │
  ├── User clicks [Review] in Actions Required panel
  │     Sharding approval overlay opens:
  │       - Task list with titles, descriptions, context declarations
  │       - Dependency graph (mini, within overlay)
  │       - Coherence report summary
  │       - Actions: [Approve] [Reject] [Modify]
  │
  ├── [Approve]
  │     POST /api/v2/workflow-runs/{run_id}/sharding/approve
  │     On 200: overlay closes, Beads tasks created, run proceeds
  │     Active Jobs panel updates with new tasks
  │
  ├── [Reject]
  │     POST /api/v2/workflow-runs/{run_id}/sharding/reject
  │     On 200: overlay closes, Planner re-plans without sharding
  │
  └── [Modify]
        Overlay enters edit mode:
          - Add/remove/edit tasks
          - Edit context declarations per task
        POST /api/v2/workflow-runs/{run_id}/sharding/modify
        On 200: overlay re-renders with updated proposal
        User can then approve/reject/modify again
```

### WebSocket connection management

```
Browser opens WebSocket to ws://localhost:7700/events
  │
  ├── onopen
  │     daemon_connected := true
  │     Render [● live] in nav bar
  │     Fetch initial state (parallel REST calls)
  │
  ├── onmessage
  │     Parse event type
  │     Route to appropriate panel state update
  │     Re-render affected panel only (not full page)
  │
  ├── onerror / onclose
  │     daemon_connected := false
  │     Render [○ disconnected] in nav bar
  │     Dim all live panels (show stale timestamp)
  │     Do NOT close overlays — preserve user context
  │
  └── Reconnection
        Exponential backoff: 250ms → 500ms → 1s → 2s → 5s (max)
        On reconnect:
          daemon_connected := true
          Re-fetch full state via REST (catch up on missed events)
          Resume WebSocket listener
```

### WebSocket event routing

| Event | Target panel | Effect |
|---|---|---|
| `system.state_changed` | Nav bar status indicator | Update `system_state`, re-render status |
| `workflow_run.started` | Active Jobs | Add run entry, render step progress |
| `workflow_run.completed` | Active Jobs | Remove run entry, clear gate if present |
| `workflow_run.halted` | Active Jobs | Update run status to halted |
| `step.started` | Active Jobs | Update current step, reset progress |
| `step.completed` | Active Jobs | Update step outcome, advance to next step |
| `dispatch.progress` | Active Jobs | Update agent progress bar and elapsed time |
| `validation.progress` | Active Jobs | Update per-category validation status |
| `run.artifact_written` | Active Jobs | Increment artifact count in progress |
| `workflow_run.checkpoint_requested` | Actions Required + Overlay (+ Sharding, if SHARDING_APPROVAL) | Add gate, auto-open overlay |
| `workflow_run.checkpoint_cleared` | Actions Required + Overlay | Clear gate from panel, close overlay |
| `chat.message` | Chat | Append message to history |
| `chat.session_changed` | Chat | Update session_open state |
| `chat.decision_captured` | Chat | Mark decision as captured in history |
| `link.index_updated` | Graph | Re-fetch links, re-render graph |
| `graph.node_tagged` | Graph | Update node rendering (add badge/border) |
| `graph.node_untagged` | Graph | Update node rendering (remove badge/border) |
| `task.claimed` | Tasks | Re-fetch tasks |
| `task.resolved` | Tasks | Re-fetch tasks |
| `workflow_run.committed` | Active Jobs | Run complete, clear from panel |
| `gate.result` | Active Jobs | Show pass/fail result |

## API contract

### REST endpoints consumed

The UI shell consumes existing daemon endpoints. It does not define new ones.

| Endpoint | Method | Page / Panel | Purpose |
|---|---|---|---|
| `/api/v2/system/state` | `GET` | Nav bar, Overview | System status, flags, chat state |
| `/api/v2/tasks` | `GET` | Tasks | All tasks |
| `/api/v2/tasks/ready` | `GET` | Tasks | Tasks ready to claim (merged) |
| `/api/v2/workflow-runs` | `GET` | Active Jobs | List active workflow runs |
| `/api/v2/workflow-runs/{run_id}` | `GET` | Active Jobs, Overlay | Run state, `awaiting_checkpoint`, step state |
| `/api/v2/workflow-runs/{run_id}/dispatch` | `GET` | Active Jobs | Agent progress, validation status |
| `/api/v2/workflow-runs/{run_id}/approve` | `POST` | Confirm Overlay | Approve CONFIRM checkpoint |
| `/api/v2/workflow-runs/{run_id}/revise` | `POST` | Confirm Overlay | Modify plan at CONFIRM |
| `/api/v2/workflow-runs/{run_id}/halt` | `POST` | Confirm Overlay | Halt the workflow run |
| `/api/v2/workflow-runs/{run_id}/sharding/approve` | `POST` | Sharding Overlay | Approve sharding proposal |
| `/api/v2/workflow-runs/{run_id}/sharding/reject` | `POST` | Sharding Overlay | Reject sharding proposal |
| `/api/v2/workflow-runs/{run_id}/sharding/modify` | `POST` | Sharding Overlay | Modify sharding proposal |
| `/api/v2/chat/session/open` | `POST` | Chat | Open chat session |
| `/api/v2/chat/session` | `DELETE` | Chat | Close chat session |
| `/api/v2/chat/message` | `POST` | Chat | Send user message |
| `/api/v2/links` | `GET` | Graph | Full link index for graph rendering |
| `/api/v2/artifacts/{id}` | `GET` | Graph Detail, Overlay | Artifact content |
| `/api/v2/health` | `GET` | Nav bar (on reconnect) | Verify daemon is alive |

### WebSocket events consumed

Single connection to `ws://localhost:7700/events`. All events from
daemon-api-endpoints.md are consumed. The shell does not emit WebSocket events
— it only listens.

| Event | Consumed by | Used fields |
|---|---|---|
| `system.state_changed` | Nav bar | `current`, `previous` |
| `workflow_run.started` | Active Jobs | `run_id`, `workflow_id` |
| `workflow_run.completed` | Active Jobs | `run_id`, `outcome` |
| `workflow_run.halted` | Active Jobs | `run_id` |
| `step.started` | Active Jobs | `run_id`, `step_id`, `iteration`, `revision` |
| `step.completed` | Active Jobs | `run_id`, `step_id`, `outcome`, `duration_ms` |
| `dispatch.progress` | Active Jobs | `agent_name`, `progress`, `elapsed_ms` |
| `workflow_run.checkpoint_requested` | Actions Required, Overlay, Sharding | `run_id`, `step_id`, `plan_summary` or `task_count` |
| `workflow_run.checkpoint_cleared` | Actions Required, Overlay | `run_id`, `step_id` |
| `validation.progress` | Active Jobs | `category`, `phase`, `status` |
| `chat.message` | Chat | `role`, `content`, `sources`, `decision_detected` |
| `chat.session_changed` | Chat | `session_open` |
| `chat.decision_captured` | Chat | `decision_id`, `summary` |
| `link.index_updated` | Graph | (triggers full re-fetch) |
| `run.artifact_written` | Active Jobs | `run_id`, `path`, `category` |
| `task.claimed` | Tasks | `task_id` (triggers re-fetch) |
| `task.resolved` | Tasks | `task_id` (triggers re-fetch) |
| `gate.result` | Active Jobs | `passed`, `failed_categories`, `iteration` |
| `workflow_run.committed` | Active Jobs | `run_id`, `version_id` |

### Data freshness guarantees

| Data source | Initial load | Update mechanism | Max staleness |
|---|---|---|---|
| System state | Page load | `system.state_changed` WS event | < 1s |
| Tasks | Page load | `task.claimed`/`task.resolved` WS → re-fetch | < 2s |
| Workflow-run state | Page load (if any run active) | `step.*` WS events | < 1s |
| Dispatch progress | Page load (if any run active) | `dispatch.progress` WS event | < 500ms |
| Chat messages | Page load (if session open) | `chat.message` WS event | < 200ms |
| Link index | Page load | `link.index_updated` WS → re-fetch | < 2s |
| Gate status | Per-run `awaiting_checkpoint` | `workflow_run.checkpoint_requested`/`checkpoint_cleared` WS event | < 1s |

## Error cases

### Connection errors

| Error | Condition | Response | Recovery |
|---|---|---|---|
| `ws_connect_failed` | WebSocket handshake fails on initial load | Show full-page "Cannot connect to daemon. Is `sle serve` running?" | Retry with exponential backoff |
| `ws_disconnected` | WebSocket drops during session | Show `[○ disconnected]` in nav bar. Dim live panels. Keep overlays open. | Auto-reconnect with backoff |
| `ws_reconnect_failed` | Reconnection attempts exhausted (5 failures) | Show "Daemon unreachable" banner. Offer manual retry button. | User clicks [Retry] |
| `rest_timeout` | REST call exceeds 10s | Show error toast: "Request timed out" | User retries action |
| `rest_503` | Daemon returns 503 (shutting down) | Show "Daemon is shutting down" banner | Poll `GET /api/v2/health` until available |

### Gate action errors

| Error | Condition | Response | Recovery |
|---|---|---|---|
| `approve_conflict` | `POST /approve` returns 409 (`not_awaiting_checkpoint`) | Error toast: "No checkpoint is awaiting approval" + close overlay | Re-fetch run state |
| `revise_conflict` | `POST /revise` returns 409 (`not_awaiting_checkpoint`) | Error toast: "CONFIRM checkpoint is no longer active" | Re-fetch run state |
| `halt_conflict` | `POST /halt` returns 409 (`halt_not_active`) | Error toast: "Workflow run is no longer active" | Re-fetch run state |
| `sharding_approve_conflict` | `POST /sharding/approve` returns 409 (`not_awaiting_checkpoint`) | Error toast: "Sharding approval is no longer pending" | Re-fetch run state |
| `sharding_reject_conflict` | `POST /sharding/reject` returns 409 (`not_awaiting_checkpoint`) | Error toast: "Sharding approval is no longer pending" | Re-fetch run state |
| `sharding_modify_invalid` | `POST /sharding/modify` returns 400 (invalid task edits) | Highlight invalid fields in overlay. Show validation errors. | User corrects and resubmits |
| `gate_action_network_error` | REST call fails during gate action | Error toast: "Action failed. Check connection." Overlay stays open. | User retries action |

### Chat errors

| Error | Condition | Response | Recovery |
|---|---|---|---|
| `chat_not_open` | `POST /chat/message` returns 409 | Show "Session closed" banner. Offer [Reopen] button. | User clicks [Reopen] |
| `chat_send_failed` | `POST /chat/message` returns 500 | Error toast: "Failed to send message." Message retained in input. | User re-sends |
| `chat_session_expired` | Session auto-closed by daemon (timeout) | Show "Chat session expired" banner. Offer [Resume] button. | User clicks [Resume] → POST /chat/session/open |
| `facilitator_error` | Facilitator LLM call fails | Show Facilitator error message in chat: "I encountered an error processing your message." | User can send a new message |

### Graph errors

| Error | Condition | Response | Recovery |
|---|---|---|---|
| `links_fetch_failed` | `GET /links` returns 500 | Show "Failed to load project graph" placeholder | User navigates away and back, or `link.index_updated` triggers re-fetch |
| `artifact_not_found` | `GET /artifacts/{id}` returns 404 | Show "Artifact no longer exists" in detail panel | User clicks Back to graph |
| `graph_render_error` | Force-directed layout fails (too many nodes, etc.) | Show simplified list view as fallback | N/A — degrades to list |

### State inconsistency

| Error | Condition | Response | Recovery |
|---|---|---|---|
| `stale_overlay` | Overlay is open but system state changed (gate cleared externally) | Close overlay. Show info toast: "Gate was resolved externally." | Re-fetch full state |
| `state_mismatch` | REST response contradicts WebSocket event (e.g., run completed but WS shows active) | REST response wins. Log mismatch at console warning level. | Re-fetch all state via REST |

## Constraints

1. **No business logic in the shell.** The UI shell is a rendering layer. All
   mutation goes through the daemon REST API. The shell does not compute
   workflow-run step state, validate plans, or make decisions about what to
   show — it renders what the daemon tells it.

2. **Gate overlays are modal, not navigational.** Gate panels overlay the
   active page. They do not navigate to a new URL. The user's page context is
   preserved underneath the overlay. Dismissing the overlay returns to the
   previous page state.

3. **Chat cannot trigger or modify workflow runs.** The chat page can observe
   workflow-run state and discuss it in freeform Q&A, but it cannot call
   workflow-run start, halt, approve, or revise endpoints. These actions are
   only available on the Overview page's Actions Required panel and in gate
   overlays.

4. **Approval happens on Overview, not in chat.** Even when a CONFIRM gate is
   active and the chat page is showing, the approve/modify/halt actions are not
   available in the chat interface. Chat can discuss the plan; approval happens
   on Overview via the overlay.

5. **Graph reflects committed state only.** The graph page renders artifacts
   that have been committed via a `commit` step. In-progress workflow-run
   work (uncommitted plan, build output, test results) does not appear on
   the graph.

6. **Sharding approval is separate from the CONFIRM checkpoint.** Two
   distinct human checkpoints exist in full-build's step graph. The UI
   surfaces them as separate overlays with different actions. Sharding
   approval (approve/reject/modify) and the CONFIRM checkpoint
   (approve/modify/halt) are never presented simultaneously.

7. **Three pages, flat navigation, no nested routes.** MVP has exactly three
   pages with a flat nav bar. No sub-routes, no breadcrumbs, no nested layout.
   The Graph detail panel replaces the canvas area but does not change the URL.

8. **No deep linking in MVP.** The shell does not support URL-based routing to
   specific panels, overlays, or graph nodes. Refresh always lands on Overview.

9. **Single WebSocket connection.** The shell maintains exactly one WebSocket
   connection to `ws://localhost:7700/events`. All events flow through it. No
   per-panel connections.

10. **Optimistic updates are prohibited.** The shell does not optimistically
    update state before the daemon confirms. Gate actions show a loading state
    until the REST response arrives. The UI reflects daemon state, not predicted
    state.

11. **No polling for live data.** Live data (jobs processing, validation
    progress, agent progress) arrives exclusively via WebSocket events. REST is
    used only for initial load and reconnection catch-up. No interval polling.

12. **All pages retain state during navigation.** Navigating from Overview to
    Chat does not destroy the Overview panel state. All three pages maintain
    their state simultaneously. WebSocket events update all pages.

13. **Overlay blocks navigation.** When a gate overlay is active, navigating to
    a different page is blocked. The overlay must be resolved first (action
    taken). This prevents the user from ignoring a gate that is blocking the
    daemon.

14. **WebSocket reconnection triggers full REST re-fetch.** On reconnect, the
    shell re-fetches all data via REST to catch up on any events missed during
    disconnection. Event replay from the daemon is not required.

15. **Mobile responsive is deferred.** The MVP targets desktop browsers only.
    Responsive breakpoints, touch interactions, and mobile layouts are
    intentionally out of scope.

16. **Auth and multi-user are out of scope.** The shell assumes a single user
    connecting to a local daemon. No authentication, no session management, no
    multi-user considerations.

## Open questions

| ID | Question | Impact | Status |
|---|---|---|---|
| UI-001 | ~~Where does the user trigger a new workflow run from the UI?~~ Resolved by DDR-028: "New workflow run" button on Chat page + Overview page. Opens dialog with workflow/target selector, scope draft selector, or quick-start goal. | — | Resolved (DDR-028) |
| UI-002 | How much detail should the CONFIRM checkpoint overlay render for plan steps and test criteria? Full text or summary cards? | Overlay complexity, information density | Open |
| UI-003 | Should the workflow-run graph (SLE-013) be a mode on the Graph page or a separate page/overlay? | Navigation structure, graph page scope | Open |
| UI-004 | What are the mobile/responsive breakpoints? When does the three-panel layout collapse? | Layout behavior, CSS architecture | Deferred |
| UI-005 | How should the shell behave when multiple gates arrive in rapid succession (e.g., sharding approval immediately followed by CONFIRM)? | Overlay queueing, user flow | Open |
| UI-006 | Should the chat page support markdown rendering, code highlighting, and file attachment preview? | Chat feature richness, library dependencies | Open |
| UI-007 | How large can the graph get before force-directed layout becomes unusable? Should there be a node count limit with pagination? | Graph rendering performance | Open |
| UI-008 | Should the shell persist user preferences (layout toggle, panel collapse state) in localStorage or daemon config? | Session continuity | Open |
| UI-009 | What technology stack should the UI shell use? (React, Svelte, plain HTML, etc.) | Implementation path, bundle size | Open |
| UI-010 | Should the graph detail panel allow inline artifact editing or remain read-only? | Graph page scope, mutation surface | Open |
| UI-011 | How should the shell surface a workflow run's iteration history (past iterations' gate results)? | Debugging UX, information architecture | Open |
| UI-012 | Should there be a notification system for events that happen while the user is on a different page (e.g., gate arrives while on Graph)? | Cross-page awareness, distraction | Open |
