# Vertical Slice 6: UI Shell & Dashboard

**Type:** implementation plan · **Status:** not started · **Updated:** 2026-05-23
**Slice:** v6 · **Prerequisites:** VS5 Complete (Critic agent, intake pipeline, WebSocket events)

---

## Implementation Progress

| Phase | Component | Status | Commit |
|-------|-----------|--------|--------|
| A | UI Shell Foundation | ☐ Not started | — |
| B | Overview Page + Fixed Panels | ☐ Not started | — |
| C | Chat Page | ☐ Not started | — |
| D | Graph Page | ☐ Not started | — |
| E | Tasks Dashboard Widgets | ☐ Not started | — |
| F | Integration Tests | ☐ Not started | — |

---

## 1. Overview

### What this slice delivers

After VS6, the system has a browser-based interface that:

1. Renders three flat pages (Overview, Chat, Graph) behind a persistent navigation bar
2. Consumes the daemon REST API and WebSocket event stream for real-time state
3. Displays the Overview page with 6 fixed panels (Actions Required, Active Jobs, Tasks, Sharding Review, Recent Activity, Documents)
4. Supports gate modal overlays for CONFIRM, SHARDING_APPROVAL, and scoping interactions
5. Provides a Chat page for persistent Facilitator conversations independent of cycle state
6. Renders the Graph page as a force-directed layout of the committed project artifact graph
7. Supports extensible dashboard widgets (16 types) with drag-and-drop layout persisted to `.sle/dashboard/`

### Why this structure

VS1–VS5 built the complete backend: init, discovery, cycle execution, Docker validation, link index, context manager, Critic agent, intake pipeline, and WebSocket events. VS6 is the rendering layer — a thin client over the daemon API. It contains no business logic; all mutations are dispatched to the daemon and reflected via events.

The shell is built as a local HTML/JS single-page application, served by the daemon on the same port (7700). No build step, no framework dependency — vanilla JS + CSS with WebSocket for real-time updates.

### Deliberate deferrals

| Item | Why deferred | Where it goes |
|---|---|---|
| Explorer agent | Conditional trigger from SCOPING | Post-MVP |
| Knowledge engine (Cognee) | Large external dependency | Post-MVP |
| Obsidian plugin | Requires plugin architecture | Post-MVP |
| BeadsTaskStore full UI | Requires `bd` CLI integration | Post-MVP |
| Chat streaming (SSE) | API-006 unresolved | Post-MVP |
| Mobile-responsive layout | Desktop-first for MVP | Post-MVP |
| Drag-and-drop widget reordering | Complex interaction; static layout sufficient | Post-MVP |

### Scope summary

| In scope | Out of scope |
|---|---|
| 3-page SPA (Overview, Chat, Graph) | Explorer agent |
| Persistent navigation bar | Knowledge engine (Cognee) |
| 6 fixed panels on Overview page | Obsidian plugin |
| Gate modal overlays (CONFIRM, SHARDING_APPROVAL, scoping) | Chat streaming |
| Chat page with Facilitator conversation | Mobile-responsive layout |
| Graph page with force-directed artifact layout | Drag-and-drop widget reordering |
| 16 widget types with configurable layout | BeadsTaskStore UI integration |
| Dashboard layout persisted to `.sle/dashboard/` | |
| WebSocket real-time updates for all panels | |
| Served by daemon on port 7700 | |

---

## 2. Dependency Map

```
External spec dependencies (this slice consumes):
  ui-shell.md               3-page architecture, shell state, panel data models, gate overlays
  tasks-dashboard.md         Widget system, task levels, priority, pin state, auto-generation
  daemon-api-endpoints.md    All REST endpoints consumed by UI
  daemon-api.md              WebSocket events, connection lifecycle
  conversation.md            Facilitator chat modes
  document-linking.md        Graph page data (forward links, backlinks, file/document index)
  project-overview.md        Graph page force-directed layout, node rendering

This slice consumes (from VS1–VS5):
  All REST endpoints (53 of 85 implemented)
  All WebSocket events (62 events)
  Daemon HTTP server on port 7700
```

```
Dependency flow within this slice:

  Phase A (UI Shell Foundation)          ← HTML/CSS shell, WebSocket client, router
    |
    v
  Phase B (Overview Page + Fixed Panels) ← depends on A (shell, WebSocket)
    |
    v
  Phase C (Chat Page)                    ← depends on A (shell, WebSocket)
    |
    v
  Phase D (Graph Page)                   ← depends on A (shell) + link index API
    |
    v
  Phase E (Tasks Dashboard Widgets)      ← depends on B (Overview page) + task APIs
    |
    v
  Phase F (Integration Tests)            ← depends on all phases
```

---

## 3. Implementation Phases

### Phase A: UI Shell Foundation

**Spec reference:** `ui-shell.md` §Overview, §Navigation, §Data model
**Implements:** HTML shell, CSS layout, WebSocket client, page router, navigation bar.

#### Shell state

```typescript
interface ShellState {
  active_page: PageRoute
  daemon_connected: boolean
  system_state: SystemStatus
  active_overlay: OverlayKind | null
  graph_detail_node: string | null
}

type PageRoute = 'overview' | 'chat' | 'graph'

type OverlayKind =
  | 'confirm_gate'
  | 'gate_pass'
  | 'sharding_approval'
  | 'artifact_detail'
```

#### HTML structure

```
<!DOCTYPE html>
<html>
  <head> ... </head>
  <body>
    <nav id="navbar">
      <!-- Project name | Overview | Chat | Graph | System status indicator -->
    </nav>
    <main id="page-content">
      <!-- Dynamically rendered page content -->
    </main>
    <div id="overlay-container">
      <!-- Gate modals rendered here -->
    </div>
    <div id="connection-status">
      <!-- WebSocket connection indicator -->
    </div>
  </body>
</html>
```

#### WebSocket client

```typescript
class SLEWebSocketClient {
  private ws: WebSocket | null = null
  private reconnectTimer: number | null = null

  connect(url: string): void
  disconnect(): void
  on(event: string, handler: (payload: unknown) => void): void
  send(command: object): void

  // Auto-reconnect with exponential backoff (1s, 2s, 4s, max 30s)
  // On reconnect: call GET /system/state to synchronize
}
```

Connection lifecycle:
1. Connect to `ws://localhost:7700/events`
2. Receive `system.ready` event (state snapshot)
3. Subscribe to event stream
4. On disconnect: auto-reconnect with backoff
5. On reconnect: call `GET /system/state` to synchronize

#### Page router

Simple hash-based routing: `#overview`, `#chat`, `#graph`. Default: `#overview`. No nested routes for MVP.

#### Navigation bar

- Left: project name (from `GET /info`)
- Center: three page tabs (Overview, Chat, Graph)
- Right: system status indicator (idle/cycling/halted/complete, color-coded)
- Connection status dot (green = connected, red = disconnected, yellow = reconnecting)

#### CSS foundation

- CSS Grid layout for pages and panels
- CSS custom properties for theming
- No external CSS framework
- Fixed navbar (48px), content area fills remaining viewport
- Panel grid: 4 columns desktop, 2 tablet, 1 mobile

#### Static file serving

Daemon serves `src/ui/` directory at `GET /` and `GET /ui/*`. HTML, CSS, JS files served with correct MIME types.

**Acceptance criteria:**
- HTML shell renders with navbar, page content area, overlay container
- Hash-based router switches between Overview, Chat, Graph
- WebSocket client connects to `ws://localhost:7700/events`
- Auto-reconnect on disconnect with exponential backoff
- `system.ready` event received on connect
- Navigation bar shows project name, page tabs, system status
- Connection status indicator updates on connect/disconnect/reconnect
- Static files served by daemon at `/` and `/ui/*`

**Tests needed:**
- Unit: ShellState initialization
- Unit: hash router — `#overview`, `#chat`, `#graph` route correctly
- Unit: WebSocket client — connect, on event, send command
- Unit: WebSocket client — auto-reconnect on disconnect
- Unit: navigation bar renders project name and system status
- Integration: daemon serves static files at `/`
- Integration: WebSocket client receives `system.ready` on connect

**Target: ~10 tests (5 unit + 5 integration)**

---

### Phase B: Overview Page + Fixed Panels

**Spec reference:** `ui-shell.md` §Overview page, §Fixed panels, §Gate overlays
**Implements:** Six fixed panels, gate modal overlays, real-time WebSocket updates.

**Depends on:** Phase A (shell, WebSocket client)

#### Fixed panels

| Panel | Data source | WebSocket refresh events |
|---|---|---|
| Actions Required | `GET /system/state` (flags) | `approval.required`, `action.required` |
| Active Jobs | `GET /cycles/current`, `GET /dispatch/status` | `node.started`, `node.completed`, `dispatch.*` |
| Tasks | `GET /tasks`, `GET /tasks/ready` | `task.claimed`, `task.resolved` |
| Sharding Review | `GET /intake/sharding` | `intake.sharding_proposed` |
| Recent Activity | WebSocket event buffer | `cycle.completed`, `artifact.updated`, `task.*` |
| Documents | `GET /links` | `link.created`, `link.index_updated` |

#### Panel data models

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

interface ActiveJobsPanel {
  cycles: Array<{
    cycle_id: string
    current_node: DAGNode
    iteration: number
    revision: number
    agents: Array<{
      name: string
      node: DAGNode
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

interface ActionsRequiredPanel {
  gates: Array<{
    kind: 'confirm' | 'gate_pass' | 'sharding_approval' | 'scoping'
    cycle_id: string
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

interface RecentActivityPanel {
  events: Array<{
    id: string
    kind: 'cycle_completed' | 'artifact_updated' | 'task_created' | 'task_resolved'
    summary: string
    timestamp: string
    cycle_id?: string
    task_id?: string
  }>
}

interface DocumentsPanel {
  recent_artifacts: Array<{
    id: string
    path: string
    category: string
    updated_at: string
  }>
}
```

#### Gate modal overlays

Gate panels are modal overlays, not page navigations. When the daemon emits a gate event, an overlay appears over whichever page the user is on.

**Confirm gate overlay:**
- Shows plan summary and test paths
- Approve button → `POST /cycles/current/approve`
- Revise button → opens text input → `POST /cycles/current/revise`

**Sharding approval overlay:**
- Shows sharding proposal with task list
- Approve button → `POST /cycles/current/shards/approve`
- Reject button → `POST /cycles/current/shards/reject`
- Modify button → opens task editor → `PATCH /intake/sharding`

**Scoping overlay:**
- Opens Chat page in scoping mode (navigates to `#chat?mode=scoping`)

**Artifact detail overlay:**
- Shows artifact content (markdown rendered)
- Shows backlinks from link index
- Close button dismisses

#### Real-time update strategy

1. On page load: fetch initial data from REST endpoints
2. Subscribe to WebSocket events
3. On event: update relevant panel data and re-render
4. On `system.state_changed`: refresh all panels

**Acceptance criteria:**
- Overview page renders all 6 fixed panels
- Each panel populated from correct REST endpoint
- Panels update in real-time on WebSocket events
- Actions Required panel shows active gates with correct priority
- Active Jobs panel shows current cycle with agent progress
- Tasks panel shows task list with status
- Sharding Review panel shows proposal when pending
- Recent Activity panel shows reverse-chronological event feed (capped at 50)
- Documents panel shows recent artifacts sorted by recency
- Confirm gate overlay appears on `approval.required` event
- Sharding approval overlay appears on `intake.sharding_proposed` event
- Approve/revise/reject actions dispatch correct REST calls
- Overlays close after action completes

**Tests needed:**
- Unit: each panel data model renders correctly
- Unit: panel update on WebSocket event (mock event → panel re-renders)
- Unit: Actions Required panel derives gates from system state flags
- Unit: Recent Activity panel caps at 50 entries
- Unit: Confirm gate overlay — approve dispatches POST
- Unit: Confirm gate overlay — revise dispatches POST with feedback
- Unit: Sharding overlay — approve/reject dispatches correct calls
- Integration: Overview page loads, fetches data, renders all panels
- Integration: WebSocket event triggers panel update
- Integration: Gate overlay flow (appear → approve → close)

**Target: ~15 tests (7 unit + 8 integration)**

---

### Phase C: Chat Page

**Spec reference:** `ui-shell.md` §Chat page, `conversation.md` §Chat mode
**Implements:** Persistent Facilitator conversation independent of cycle state.

#### Chat panel state

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
  mode: 'chat' | 'scoping' | 'decision'
  waiting_for_response: boolean
}
```

#### Chat behavior

- Independent of system state (can chat during cycling, halted, idle)
- `POST /api/v2/chat/message` sends user message
- WebSocket `chat.message` event receives Facilitator response
- Chat never blocks, delays, or cancels state transitions
- Scoping mode: entered when user clicks scoping gate from Actions Required

#### Chat UI

- Message list (reverse-chronological, auto-scroll to bottom)
- Input field with send button
- Mode indicator (chat / scoping / decision)
- Decision capture: when Facilitator detects a decision, highlighted with confirm button
- Source citations: Facilitator response includes `sources[]`, rendered as clickable links

**Acceptance criteria:**
- Chat page renders message list and input field
- User message dispatched via REST
- Facilitator response received via WebSocket and appended
- Chat mode displayed correctly
- Scoping mode entered from gate overlay
- Decision capture rendered with confirm button
- Source citations rendered as links
- Chat session persists across page navigation

**Tests needed:**
- Unit: ChatPanelState initialization
- Unit: message list update on WebSocket `chat.message`
- Unit: mode switching (chat → scoping → chat)
- Unit: decision detection rendering
- Integration: send message → receive response → render
- Integration: scoping mode entered from gate overlay

**Target: ~8 tests (4 unit + 4 integration)**

---

### Phase D: Graph Page

**Spec reference:** `ui-shell.md` §Graph page, `project-overview.md`
**Implements:** Force-directed layout of the committed project artifact graph.

#### Graph data source

```typescript
interface GraphData {
  nodes: Array<{
    id: string
    label: string
    kind: 'document' | 'node' | 'source_file' | 'test_file'
    group: string | null
    scope: 'project' | 'group' | null
  }>
  edges: Array<{
    source: string
    target: string
    type: 'structural_dag' | 'structural_declaration' | 'contextual_execution' | 'manual'
  }>
}
```

Sourced from `GET /links` (all forward links) + `GET /links/backlinks/:key`.

#### Graph rendering

- Force-directed layout using vanilla Canvas or SVG
- Node types color-coded by kind (document, node, source_file, test_file)
- Edge types styled by link_type (solid for structural, dashed for contextual, dotted for manual)
- Click node → opens `artifact_detail` overlay
- Zoom + pan controls
- Stable state only — reflects committed artifacts, not in-progress work

**Acceptance criteria:**
- Graph page renders nodes and edges from link index
- Node types visually distinguishable (color-coded)
- Edge types visually distinguishable (line style)
- Click node opens artifact detail overlay
- Zoom and pan controls functional
- Graph reflects committed state (not in-progress)

**Tests needed:**
- Unit: GraphData construction from link index response
- Unit: node kind color mapping
- Unit: edge type line style mapping
- Integration: Graph page renders from live link index

**Target: ~5 tests (3 unit + 2 integration)**

---

### Phase E: Tasks Dashboard Widgets

**Spec reference:** `tasks-dashboard.md` (complete document)
**Implements:** Extensible widget system with 16 widget types, layout persistence.

**Depends on:** Phase B (Overview page renders widgets)

#### Widget types

```typescript
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

interface DashboardWidget {
  id: string
  type: WidgetType
  title: string
  position: { x: number; y: number; w: number; h: number }
  collapsed: boolean
  source: 'auto_generated' | 'user'
  config?: Record<string, unknown>
}
```

#### Task levels

| Level | Scope | Storage |
|---|---|---|
| `node` | Single node in a group layer | `.sle/tasks/groups/{group_id}/nodes/{node_id}.json` |
| `group` | Feature group (spans layers) | `.sle/tasks/groups/{group_id}/group-tasks.json` |
| `project` | Whole project, cross-cutting | `.sle/tasks/project-tasks.json` |

#### Task priority

| Priority label | Daemon numeric | Color |
|---|---|---|
| `critical` | 1 | Red |
| `high` | 2 | Orange |
| `medium` | 3 | Blue |
| `low` | 4 | Gray |

#### Pin state

```typescript
interface PinState {
  task_id: string
  pinned: boolean
  pin_source: 'user' | 'system'
  pinned_at?: string
}
```

System auto-pins on `in_progress`, auto-unpins on `done`. User pins persist across status changes.

#### Auto-generated widgets

System proposes widgets based on project state. Stored in `.sle/dashboard/widgets/auto-generated/`. Rendered with pulsing border. User accepts (persists) or dismisses.

#### Layout persistence

Dashboard layout persisted to `.sle/dashboard/layout.json`:
```json
{
  "widgets": [
    { "id": "w1", "type": "task_board", "position": { "x": 0, "y": 0, "w": 2, "h": 2 }, ... }
  ]
}
```

Grid: 4 columns desktop. Widget positions are grid coordinates.

#### Widget data sources

Each widget type maps to specific daemon endpoints:

| Widget | Data source |
|---|---|
| `group_health_strip` | `GET /links` (group-scoped nodes) |
| `test_coverage_trend` | `GET /validation/runs/current` (across iterations) |
| `cycle_history` | `GET /cycles` (completed cycle summaries) |
| `task_summary` | `GET /tasks` |
| `task_board` | `GET /tasks`, `GET /tasks/ready` |
| `document_browser` | `GET /links` (document-scoped) |
| `recent_activity` | WebSocket event buffer |
| `code_stats` | `GET /links` (file index stats) |

**Acceptance criteria:**
- Widget system renders configurable widgets on Overview page
- 16 widget types defined, each with correct data source
- Widgets positioned on 4-column grid
- Layout persisted to `.sle/dashboard/layout.json`
- Layout loaded on page refresh
- Auto-generated widgets appear with pulsing border
- User accepts/dismisses auto-generated widgets
- Task board widget shows tasks grouped by status
- Task levels (node/group/project) rendered correctly
- Priority color coding (critical=red, high=orange, medium=blue, low=gray)
- Pin state tracked in `.sle/tasks/pins.json`
- System auto-pins on `in_progress`, auto-unpins on `done`
- Collapsed widgets show only title bar

**Tests needed:**
- Unit: DashboardWidget position on 4-column grid
- Unit: layout serialization to JSON
- Unit: layout deserialization from JSON
- Unit: auto-generated widget rendered with pulsing border
- Unit: task priority color mapping
- Unit: pin state — system auto-pin on in_progress
- Unit: pin state — system auto-unpin on done
- Unit: task status mapping (dashboard ↔ daemon)
- Unit: widget data source resolution per type
- Integration: Overview page renders widgets from layout.json
- Integration: accept auto-generated widget → persisted to layout
- Integration: dismiss auto-generated widget → removed
- Integration: task board shows tasks grouped by status

**Target: ~15 tests (9 unit + 6 integration)**

---

### Phase F: Integration Tests

**Spec reference:** Cross-cutting (all above phases)
**Implements:** End-to-end acceptance tests for VS6.

**Test scenarios:**

| Test | Description | Expected |
|---|---|---|
| VS6-INT-01 | Shell loads, connects to WebSocket, shows Overview page | All 6 panels populated |
| VS6-INT-02 | Cycle starts → Active Jobs panel updates in real-time | Events flow, panel refreshes |
| VS6-INT-03 | CONFIRM gate → overlay appears → approve → overlay closes | Gate flow end-to-end |
| VS6-INT-04 | SHARDING_APPROVAL → overlay → approve → tasks created | Sharding flow end-to-end |
| VS6-INT-05 | Chat page → send message → receive response | Chat flow end-to-end |
| VS6-INT-06 | Graph page → renders nodes from link index | Correct node/edge count |
| VS6-INT-07 | Dashboard widgets → auto-generated → accept → persisted | Widget lifecycle |

**Target: ~7 integration tests**

---

## 4. Types Inventory

### Shell types (Phase A)

```typescript
type PageRoute = 'overview' | 'chat' | 'graph'
type OverlayKind = 'confirm_gate' | 'gate_pass' | 'sharding_approval' | 'artifact_detail'
interface ShellState { ... }
```

### Panel types (Phase B)

```typescript
interface TasksPanel { ... }
interface ActiveJobsPanel { ... }
interface ActionsRequiredPanel { ... }
interface RecentActivityPanel { ... }
interface DocumentsPanel { ... }
```

### Chat types (Phase C)

```typescript
interface ChatPanelState { ... }
```

### Graph types (Phase D)

```typescript
interface GraphData { ... }
```

### Dashboard types (Phase E)

```typescript
type WidgetType = 'group_health_strip' | 'test_coverage_trend' | ...
interface DashboardWidget { ... }
interface Task { ... }
interface TaskLink { ... }
interface PinState { ... }
```

---

## 5. File Inventory

New files created in this slice:

```
src/ui/
  index.html                  Phase A — Shell HTML
  styles.css                  Phase A — CSS foundation
  shell.js                    Phase A — Shell state, router, WebSocket client
  overview.js                 Phase B — Overview page + fixed panels + gate overlays
  chat.js                     Phase C — Chat page
  graph.js                    Phase D — Graph page (force-directed layout)
  dashboard.js                Phase E — Widget system, layout persistence
  components/
    navbar.js                 Phase A
    panel.js                  Phase B — Generic panel component
    overlay.js                Phase B — Gate overlay component
    widget.js                 Phase E — Generic widget component
src/
  daemon.ts                   Phase A — (extended) static file serving
  tests/
    ui-shell.test.ts          Phase A
    overview.test.ts          Phase B
    chat.test.ts              Phase C
    graph.test.ts             Phase D
    dashboard.test.ts         Phase E
    v6-integration.test.ts    Phase F
```

---

## 6. Test Strategy

### Unit tests per phase

| Phase | Test count (est.) | Key test areas |
|---|---|---|
| A: UI Shell Foundation | ~10 | Router, WebSocket client, navbar, static serving |
| B: Overview + Fixed Panels | ~15 | Panel rendering, WebSocket updates, gate overlays |
| C: Chat Page | ~8 | Message flow, mode switching, decision capture |
| D: Graph Page | ~5 | Graph data construction, rendering |
| E: Tasks Dashboard Widgets | ~15 | Widget layout, task levels, priority, pin state |
| F: Integration Tests | ~7 | Full UI flow with daemon |

**Total estimated: ~60 new tests**
**Cumulative with VS1–VS5 (~503 tests): ~563 tests**

---

## 7. Definition of Done

VS6 is complete when:

- [ ] All ~60 tests pass
- [ ] Shell renders 3 pages with navigation, system status, connection indicator
- [ ] WebSocket client connects, auto-reconnects, receives events
- [ ] Overview page shows all 6 fixed panels populated from REST endpoints
- [ ] Panels update in real-time on WebSocket events
- [ ] Confirm gate overlay appears/disappears on gate events
- [ ] Sharding approval overlay appears/disappears on proposal events
- [ ] Chat page sends/receives messages with Facilitator
- [ ] Graph page renders artifact graph from link index
- [ ] Dashboard renders configurable widgets on Overview page
- [ ] Widget layout persisted to `.sle/dashboard/layout.json`
- [ ] Auto-generated widgets appear and can be accepted/dismissed
- [ ] Task board shows tasks with correct status, priority, and level
- [ ] v6-integration.test.ts passes: full UI flow with daemon
- [ ] Dev plan updated with commit hashes for all phases
