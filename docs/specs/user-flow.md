# User Flow

**Type:** spec · **Status:** draft · **Updated:** 2026-05-01
**Depends on:** [ui-shell.md](ui-shell.md), [tasks-dashboard.md](tasks-dashboard.md), [project-overview.md](project-overview.md), [conversation.md](conversation.md), [state-machine.md](state-machine.md), [dag-execution.md](dag-execution.md)
**Source material:** vision/SLE-023-user-flow.md
**Resolves:** G2 (outdated SLE-001 anchor — user flow reflects full system), G3 (overloaded "layer" term — use "tier" for architecture, "layer" for lifecycle)

## Overview

The user flow spec defines how a person moves through the SLE interface during a
session. The interface presents three co-present surfaces — Overview, Chat,
Graph — connected by a live status indicator. Cycles run in the background; the
user interacts with the product, not the DAG.

Design principle: **"Cycle is background; interface is product."** The user
should rarely think about the DAG. They interact with the product (overview,
chat, graph) while cycles happen behind the scenes. Gate panels appear as modal
overlays only when the system needs a human decision.

All interaction happens across the three surfaces. The user may freely switch
between them at any time. Gate panels overlay whichever surface is active —
they never force a tab switch.

### Terminology

- **Tier** = architecture tiers (Tier 0–4 in the platform). Never "layer."
- **Layer** = lifecycle layers only (Research, Spikes, Design, Plans,
  Implementation, Code, Notes, Hosting). Never used for architecture.
- **Surface** = one of the three interface tabs: Overview, Chat, Graph.
- **Gate panel** = modal overlay that appears when the system requires a human
  decision (CONFIRM gate, gate pass, sharding approval).

---

## Data model

### Surface state

```typescript
type SurfaceState = 'overview' | 'chat' | 'graph'
```

The user is always on exactly one surface. Stored client-side. The daemon does
not track which surface is active — surfaces are a presentation concern.

### Gate panel

```typescript
interface GatePanel {
  type: 'confirm' | 'gate_pass' | 'sharding_approval'
  cycle_id: string
  node: DAGNode
  iteration: number
  presented_at: string
}
```

Produced by the daemon when a cycle reaches a human checkpoint. The daemon emits
a WebSocket event (`dag.confirm_requested`, `dag.sharding_requested`, or a new
`dag.gate_pass_requested`). The UI renders the panel as a modal overlay on the
active surface.

Only one gate panel is presented at a time. At most one cycle flag
(`awaiting_confirmation`, `awaiting_sharding_approval`) is `true` at a time
(per [state-machine.md](state-machine.md) §Flag exclusivity).

### Notification badge

```typescript
interface NotificationBadge {
  type: 'gate_pending' | 'cycle_complete' | 'cycle_error' | 'new_task'
  surface: SurfaceState
  count: number
  latest_at: string
}
```

Displayed on surface tabs to indicate state changes the user should be aware of.
Badge counts reset when the user views the relevant panel or acknowledges the
notification.

Badge rendering rules:

| Badge type | Where displayed | Cleared when |
|---|---|---|
| `gate_pending` | All surface tabs | User opens gate panel |
| `cycle_complete` | Overview tab | User views Recent Activity |
| `cycle_error` | All surface tabs | User views error report |
| `new_task` | Overview tab (Tasks panel) | User views Tasks panel |

### User flow context

```typescript
interface UserFlowContext {
  active_surface: SurfaceState
  running_cycle_id?: string
  pending_gates: GatePanel[]
  notifications: NotificationBadge[]
}
```

Assembled client-side from WebSocket events and REST API responses. The daemon
does not store this as a single object — it is a view model derived from
system state, cycle state, and notification state.

### Live status indicator

```typescript
interface LiveStatus {
  connected: boolean
  active_cycle: boolean
  pending_gate: boolean
  last_event_at: string
}
```

Rendered as `[● live]` in the UI shell when `connected = true` and
`active_cycle = true`. When `pending_gate = true`, the indicator changes to
`[● gate]`. When `connected = false`, it shows `[○ disconnected]`.

---

## Behavior

### Entry points

| Entry point | Default surface | Primary content |
|---|---|---|
| App open | Overview | Active Jobs, Tasks, Documents, Recent Activity |
| Gate interrupt | Any surface (modal overlay) | Gate panel overlays active tab |
| Standalone exploration | Chat | Free exchange with Facilitator |
| Structure navigation | Graph | Nodes by group/layer → click to open or "ask about this" → Chat scoped |
| Cycle initiation | Overview or Graph | Tasks panel or scoped node → start cycle |

### Primary session flow

The typical user session follows this sequence. The user is not required to
follow this exact path — surfaces are freely switchable at any time.

```
1. Open app
   │  Overview surface loads (default landing)
   │  Active Jobs panel shows running cycles
   │  Tasks panel shows available tasks
   │  Recent Activity shows latest changes
   │
2. Cycle reaches CONFIRM gate
   │  Gate panel appears as modal overlay on active surface
   │  User reviews plan, optionally modifies, approves
   │  Badge: gate_pending on all tabs
   │
3. Switch to Chat tab
   │  Explore ideas, make decisions
   │  No cycle needed — Facilitator reads discovery docs + knowledge base
   │  Decision detection may surface capture prompts
   │
4. Gate pass panel appears (mid-chat, if cycle completes validation)
   │  Modal overlay on Chat surface
   │  User locks snapshot → version locked, cycle complete
   │
5. Return to Overview
   │  Cycle complete, version locked
   │  New tasks auto-created
   │  Recent Activity updated
   │
6. Open Graph tab
   │  Navigate structure by group/layer
   │  Scope a new cycle to a specific node
   │  "Start cycle" on node → cycle initiation
```

### Surface behaviors

#### Overview surface

The default landing surface. Shows:

| Panel | Content | Update mechanism |
|---|---|---|
| Active Jobs | Running cycles, current node, iteration count | WebSocket `node.started`, `node.completed` |
| Tasks | Available tasks from Beads integration | WebSocket `cycle_complete` triggers auto-creation |
| Documents | Recent document changes | WebSocket artifact events |
| Recent Activity | Timeline of cycle completions, decisions, snapshots | WebSocket events, aggregated on surface load |

The Overview surface observes running cycles. It does not control them — cycle
control actions (approve, halt, resume) are routed through the REST API, not
through Overview panels.

#### Chat surface

Provides access to the Facilitator. Chat is standalone — no cycle dependency.
Full behavior is defined in [conversation.md](conversation.md).

Chat-cycle integration rules:

| Rule | Detail |
|---|---|
| Facilitator reads cycle state | Current node, iteration, validation status |
| Facilitator cannot modify cycle | No write access to cycle artifacts or DAG state |
| Chat works without a cycle | Reads discovery docs + knowledge base |
| Chat history persisted | `.sle/chat-history.jsonl` |

When the user scopes Chat to a Graph node (via "Ask about this"), the
Facilitator's context includes the node's artifacts as additional context
slices. The scoping is informational — it does not restrict the conversation.

#### Graph surface

Structural navigation of the project. Nodes are organized by group and lifecycle
layer. The user can:

- Browse nodes by group/layer
- Click a node to open its artifacts
- Use "Ask about this" to switch to Chat with node context
- Use "Start cycle" on a node to initiate a cycle scoped to that node

Graph-initiated cycles set the cycle's scope to the selected node. The Planner
receives the node's artifact slices as additional context.

### Decision points

The system presents gate panels at human checkpoints. Gate panels are modal
overlays — they do not navigate the user away from the active surface.

#### CONFIRM gate (post-planning, post-testing)

Presented when `cycle.awaiting_confirmation = true`.

| User action | Effect |
|---|---|
| Approve | Builder starts immediately. Gate panel dismisses. |
| Modify plan | Edit/reorder steps, add constraints. Triggers test regeneration. Re-presents at CONFIRM. Revision counter increments. |
| Halt cycle | Clean stop. Partial report generated. Cycle transitions to `halted`. |

This is the primary decision point in the cycle flow. The user reviews the
plan, tests, and coverage before giving the Builder permission to proceed.

#### Gate pass panel (post-validation)

Presented when all validation categories pass and the EVALUATE node confirms
the implementation satisfies the intent.

| User action | Effect |
|---|---|
| Lock snapshot | Version locked, cycle complete, transitions to `idle`. |
| Run tests locally | User verification before locking. Cycle pauses. |
| Reject | Cycle halted. |

The gate pass panel is the final checkpoint before a version is locked.

#### Sharding approval

Presented when `cycle.awaiting_sharding_approval = true`. Full behavior defined
in [dag-execution.md](dag-execution.md) §Checkpoint 1 — Sharding approval.

### Integration points between surfaces

| From | To | Mechanism |
|---|---|---|
| Overview → Chat | Tab switch | Chat observes running cycles read-only |
| Overview → Graph | Tab switch | — |
| Graph → Chat | "Ask about this" action on a node | Switches to Chat tab with node context injected |
| Graph → Cycle start | "Start cycle" on node/group | Initiates cycle scoped to node |
| Any surface → Gate panel | Modal overlay | Overlays active tab; does not switch surface |
| Chat → Overview | Gate notification badge | Badge on all surface tabs |
| Cycle completion → Overview | Recent Activity auto-update | WebSocket event triggers panel refresh |
| Cycle completion → Tasks | New task auto-created | Post-cycle task creation hook |

### Flow: Cycle observation

The user watches a running cycle through Active Jobs on the Overview surface
without intervening:

```
1. Cycle running (meta.status = cycling)
   │  Active Jobs panel shows: cycle ID, current node, iteration count
   │  Live status indicator: [● live]
   │
2. DAG progresses through nodes
   │  WebSocket events update Active Jobs in real time
   │  Node transitions: EXPLORE → DESIGN → PLAN → TEST → CONFIRM → ...
   │
3. Auto-retry on validation failure
   │  Status update in Active Jobs: "Iteration 2 — PLAN"
   │  NO gate panel (auto-retry does not interrupt the user)
   │
4. Iteration cap hit
   │  Badge: "Cycle 7 halted — cap reached"
   │  User acknowledges, triages
```

Key principle: auto-retry failures do NOT produce gate panels. Only
decision-requiring pause points produce gate panels. The user observes progress
through Active Jobs status updates.

### Flow: Standalone chat

Chat with no cycle running:

```
1. User switches to Chat tab
   │  No running cycle (meta.status = idle)
   │  Facilitator reads discovery docs + knowledge base
   │
2. Freeform exchange
   │  User asks questions, explores ideas
   │  Decision detection runs on user messages
   │  Capture suggestions surfaced for high-confidence decisions
   │
3. User may initiate cycle from chat
   │  Natural language: "start a cycle for X"
   │  Daemon detects intent, constructs cycle start request
   │  ChatContext injected into Planner
```

### Flow: Graph-initiated cycle

```
1. User navigates to Graph tab
   │  Nodes organized by group and lifecycle layer
   │
2. User selects a node
   │  Node detail panel shows artifacts, status, history
   │
3. User clicks "Start cycle"
   │  Cycle initiation scoped to that node
   │  Planner receives node artifacts as additional context
   │  User switches to Overview (or stays on Graph)
   │
4. Cycle runs
   │  Active Jobs panel shows progress
   │  Gate panels overlay active surface when needed
```

### Flow: Gate rejection / halt

```
CONFIRM gate:
  User halts → cycle transitions to halted
  Partial report generated
  Badge: "Cycle halted" on all tabs
  User acknowledges → cycle transitions to idle
  Recent Activity updated

Gate pass panel:
  User rejects → cycle halted
  Same recovery flow as halt

Iteration cap hit:
  Auto-halt, no gate panel
  Badge: "Cycle N halted — cap reached"
  User acknowledges, triages
```

---

## API contract

The user flow does not define new REST endpoints. It consumes existing endpoints
from dependent specs. The following endpoints are used by the UI to assemble the
user flow context:

### System and cycle state

| Endpoint | Purpose | Source spec |
|---|---|---|
| `GET /api/v2/system/state` | Current system state, cycle flags, chat session | [state-machine.md](state-machine.md) |
| `GET /api/v2/cycles/{cycle_id}` | Cycle detail (iteration, revision, dag_state, flags) | [dag-execution.md](dag-execution.md) |

### Gate actions

| Endpoint | Purpose | Source spec |
|---|---|---|
| `POST /api/v2/cycles/{cycle_id}/approve` | Approve at CONFIRM or gate pass | [dag-execution.md](dag-execution.md) |
| `POST /api/v2/cycles/{cycle_id}/revise` | Modify plan at CONFIRM | [dag-execution.md](dag-execution.md) |
| `POST /api/v2/cycles/{cycle_id}/halt` | Halt cycle | [dag-execution.md](dag-execution.md) |
| `POST /api/v2/cycles/{cycle_id}/sharding/approve` | Approve sharding | [dag-execution.md](dag-execution.md) |
| `POST /api/v2/cycles/{cycle_id}/sharding/reject` | Reject sharding | [dag-execution.md](dag-execution.md) |

### Chat

| Endpoint | Purpose | Source spec |
|---|---|---|
| `POST /api/v2/chat/session/open` | Open chat session | [conversation.md](conversation.md) |
| `DELETE /api/v2/chat/session` | Close chat session | [conversation.md](conversation.md) |
| `POST /api/v2/chat/message` | Send message to Facilitator | [conversation.md](conversation.md) |

### WebSocket events consumed by UI

The UI subscribes to the shared WebSocket at `ws://localhost:7700/events` and
uses the following events to update surfaces and render gate panels:

| Event | UI effect | Source spec |
|---|---|---|
| `system.state_changed` | Update Active Jobs, live status indicator | [state-machine.md](state-machine.md) |
| `cycle.flag_changed` | Render/dismiss gate panel overlay, update badges | [state-machine.md](state-machine.md) |
| `node.started` | Update Active Jobs node display | [dag-execution.md](dag-execution.md) |
| `node.completed` | Update Active Jobs node display | [dag-execution.md](dag-execution.md) |
| `gate.result` | Update Active Jobs with pass/fail, trigger badges | [dag-execution.md](dag-execution.md) |
| `dag.confirm_requested` | Render CONFIRM gate panel on active surface | [dag-execution.md](dag-execution.md) |
| `dag.sharding_requested` | Render sharding approval panel on active surface | [dag-execution.md](dag-execution.md) |
| `dag.snapshot_locked` | Update Recent Activity, clear cycle badges | [dag-execution.md](dag-execution.md) |
| `chat.message` | Render chat messages | [conversation.md](conversation.md) |
| `chat.decision_captured` | Update notification badges | [conversation.md](conversation.md) |
| `chat.session_changed` | Update chat session state | [conversation.md](conversation.md) |

### Gate pass WebSocket event

The gate pass panel requires a WebSocket event not yet defined in
dag-execution.md:

```
event: dag.gate_pass_requested
{
  "cycle_id":    string,
  "iteration":   number,
  "snapshot_preview": {
    "version_id":    string,
    "files_changed": number,
    "tests_passed":  number
  },
  "timestamp": string
}
```

This event signals that all validation has passed, EVALUATE is complete, and the
user may lock the snapshot or request local test verification.

### Gate pass actions

```
POST /api/v2/cycles/{cycle_id}/lock-snapshot

Response 200:
{
  "cycle_id":   string,
  "version_id": string,
  "locked_at":  string
}

Response 409:
{
  "error":  "not_awaiting_gate_pass",
  "reason": "Cycle has not reached gate pass state."
}

POST /api/v2/cycles/{cycle_id}/run-tests-locally

Response 200:
{
  "cycle_id":    string,
  "test_run_id": string,
  "status":      "started"
}
```

These endpoints are candidates for dag-execution.md. They are documented here as
the user flow's required API surface for gate pass interactions.

---

## Error cases

### Error states and recovery

| State | Notification | Recovery |
|---|---|---|
| Gate fail (auto-retry) | Status update in Active Jobs (no panel, no badge) | System retries automatically. User observes in Active Jobs. |
| Iteration cap hit | Badge: "Cycle N halted — cap reached" | User acknowledges, triages. Partial report available. |
| Unrecoverable error | Badge: "Cycle N error — see report" | User reads report, decides next action. |

Auto-retry failures do NOT interrupt the user. Only decision-requiring pause
points produce gate panels.

### Surface-level error handling

| Error | Surface | Condition | Recovery |
|---|---|---|---|
| WebSocket disconnect | All | Network interruption or daemon crash | Live status shows `[○ disconnected]`. UI retries connection. Surface shows last-known state. |
| Stale state | Overview | UI state diverges from daemon | Re-fetch `GET /api/v2/system/state` on reconnect. Reconcile. |
| Gate action timeout | Any | User does not respond to gate panel | Gate panel remains until user acts. No auto-dismiss. Cycle stays paused. |
| Chat Facilitator error | Chat | LLM timeout or provider error | Error message in chat. User may retry. Session stays open. |

### Cross-surface error propagation

Errors do not propagate between surfaces. If Chat encounters a Facilitator
error, Overview and Graph continue to function. If a cycle error occurs, the
badge appears on all tabs, but each surface handles the notification
independently.

---

## Constraints

1. **Gate panels are modal overlays.** They render on whichever tab is active.
   They never navigate the user to a different surface. Dismissing a gate panel
   returns the user to the surface they were on.

2. **Auto-retry failures do not produce gate panels.** Only decision-requiring
   pause points (CONFIRM, gate pass, sharding approval) produce gate panels.
   Validation failures that trigger automatic retries update Active Jobs only.

3. **Chat is standalone.** Chat works without any cycle running. The Facilitator
   reads discovery docs and the knowledge base. No cycle dependency.

4. **Facilitator is read-only re: cycle state.** The Facilitator can observe
   cycle state (current node, iteration, validation status) but cannot modify
   the cycle or its artifacts.

5. **Free surface switching.** The user may switch between Overview, Chat, and
   Graph at any time, regardless of system state. Gate panels overlay the active
   surface but do not lock the user to it.

6. **Terminology: "tier" vs. "layer."** "Tier" refers to architecture tiers
   (Tier 0–4). "Layer" refers to lifecycle layers only (Research, Spikes,
   Design, Plans, Implementation, Code, Notes, Hosting). Never use "layer" for
   both meanings.

7. **Approval actions via API only.** Cycle approval actions (approve, halt,
   revise) are routed through the REST API from the Overview Actions panel or
   gate panel overlays. The Facilitator cannot execute approval actions.

8. **Single gate panel at a time.** At most one gate panel is visible. The
   daemon enforces flag exclusivity (`awaiting_confirmation` and
   `awaiting_sharding_approval` are mutually exclusive).

9. **Notification badges are surface-local.** Badges are rendered per-surface
   tab. Clearing a badge on one surface clears it on all surfaces for that
   notification type.

10. **Gate pass rejection recovery is unspecified.** The vision doc does not
    define what happens after a user rejects at the gate pass. The cycle halts,
    but the subsequent user flow (re-run cycle, modify scope, etc.) is an open
    question.

---

## Open questions

| ID | Question | Impact | Status |
|---|---|---|---|
| UF-001 | What happens when the user rejects at gate pass? Does the cycle halt permanently, or can the user re-initiate from the halted state with modifications? | Recovery flow completeness | Open |
| UF-002 | How does the UI behave during network disconnection or offline mode? Should surfaces queue actions and replay on reconnect? | Reliability, UX during network issues | Open |
| UF-003 | What is the expected behavior if the daemon crashes during a running cycle? Does the UI detect the crash and surface a recovery panel? | Crash recovery, data loss prevention | Open |
| UF-004 | Are there mobile-specific flows that differ from the three-surface desktop model? The vision doc does not differentiate. | Responsive design, touch interactions | Open |
| UF-005 | Are notification badges persisted across sessions? If the user closes and reopens the app, do unread badges persist? | Session continuity, state persistence | Open |
| UF-006 | How does "Run tests locally" at gate pass work? Does the daemon orchestrate a local test run, or does the user run tests manually outside the system? | Gate pass flow completeness | Open |
| UF-007 | Should the Graph surface support multi-node selection for scoped cycles, or is single-node scoping sufficient? | Graph interaction model | Open |
| UF-008 | What is the expected behavior when a gate panel appears while the user is mid-conversation in Chat? Does the conversation pause, or can the user continue chatting while the gate panel is open? | Modal behavior, chat interruption policy | Open |
| UF-009 | Should the live status indicator show which DAG node is currently executing, or only that a cycle is running? | Information density, surface clutter | Open |
| UF-010 | Can the user dismiss a gate panel without acting on it (e.g., "remind me later")? If so, how does the system re-present the gate? | Gate panel lifecycle, cycle blocking | Open |
