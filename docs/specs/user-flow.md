# User Flow

**Type:** spec · **Status:** draft · **Updated:** 2026-06-21
**Depends on:** [ui-shell.md](ui-shell.md), [tasks-dashboard.md](tasks-dashboard.md), [project-overview.md](project-overview.md), [conversation.md](conversation.md), [state-machine.md](state-machine.md), [workflow-execution.md](workflow-execution.md), [step-kind-reference.md](step-kind-reference.md), [workflow-authoring.md](workflow-authoring.md)
**Source material:** vision/SLE-023-user-flow.md, DDR-031
**Resolves:** G2 (outdated SLE-001 anchor — user flow reflects full system), G3 (overloaded "layer" term — use "tier" for architecture, "layer" for lifecycle)

## Overview

The user flow spec defines how a person moves through the SLE interface during a
session. The interface presents three co-present surfaces — Overview, Chat,
Graph — connected by a live status indicator. Workflow runs execute in the
background; the user interacts with the product, not the step graph.

Design principle: **"The workflow run is background; interface is product."**
The user should rarely think about steps directly. They interact with the
product (overview, chat, graph) while one or more workflow runs happen behind
the scenes. Gate panels appear as modal overlays only when a run needs a human
decision at one of its `checkpoint` steps.

All interaction happens across the three surfaces. The user may freely switch
between them at any time. Gate panels overlay whichever surface is active —
they never force a tab switch.

Because multiple workflow runs can be active concurrently (DDR-031), the
Overview surface's Active Jobs panel is a list, not a singleton — the
flows below describe the behavior of one run at a time, but nothing here
assumes only one run exists.

### Terminology

- **Tier** = architecture tiers (Tier 0–4 in the platform). Never "layer."
- **Layer** = lifecycle layers only (Research, Spikes, Design, Plans,
  Implementation, Code, Notes, Hosting). Never used for architecture.
- **Surface** = one of the three interface tabs: Overview, Chat, Graph.
- **Gate panel** = modal overlay that appears when a workflow run's
  `checkpoint` step sets `awaiting_checkpoint`, requiring a human decision
  (e.g. the SCOPING checkpoint, the CONFIRM checkpoint, sharding approval).

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
  type: 'confirm' | 'gate_pass' | 'sharding_approval' | string
  run_id: string
  workflow_id: string
  step_id: string
  iteration: number
  presented_at: string
}
```

Produced by the daemon when a workflow run reaches one of its `checkpoint`
steps. The daemon emits a `workflow_run.checkpoint_requested` WebSocket event
carrying the `step_id` that triggered the pause. The UI renders the panel as a
modal overlay on the active surface.

At most one gate panel per run is presented at a time — `WorkflowRun.
awaiting_checkpoint` is a single nullable pointer, so a run can only be paused
at one checkpoint at once (per [state-machine.md](state-machine.md)
§Checkpoint pointer). Different runs may each have their own gate panel open
concurrently; the UI queues additional panels and presents them one at a time
on the active surface.

### Notification badge

```typescript
interface NotificationBadge {
  type: 'gate_pending' | 'run_complete' | 'run_error' | 'new_task'
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
| `run_complete` | Overview tab | User views Recent Activity |
| `run_error` | All surface tabs | User views error report |
| `new_task` | Overview tab (Tasks panel) | User views Tasks panel |

### User flow context

```typescript
interface UserFlowContext {
  active_surface: SurfaceState
  active_run_ids: string[]
  pending_gates: GatePanel[]
  notifications: NotificationBadge[]
}
```

Assembled client-side from WebSocket events and REST API responses. The daemon
does not store this as a single object — it is a view model derived from
system state, the set of active `WorkflowRun`s, and notification state.

### Live status indicator

```typescript
interface LiveStatus {
  connected: boolean
  active_run_count: number
  pending_gate: boolean
  last_event_at: string
}
```

Rendered as `[● live]` in the UI shell when `connected = true` and
`active_run_count > 0`. When `pending_gate = true`, the indicator changes to
`[● gate]`. When `connected = false`, it shows `[○ disconnected]`.

---

## Behavior

### Entry points

| Entry point | Default surface | Primary content |
|---|---|---|
| App open | Overview | Actions Required, Active Jobs, Tasks, Sharding Review, Recent Activity, Documents |
| Gate interrupt | Any surface (modal overlay) | Gate panel overlays active tab |
| Standalone exploration | Chat | Free exchange with Facilitator |
| Structure navigation | Graph | Nodes by group/layer → click to open or "ask about this" → Chat scoped |
| Workflow initiation | Overview or Graph | Tasks panel or scoped node → start a workflow run |

### Primary session flow

The typical user session follows this sequence, using `full-build` (the
built-in long-running workflow) as the worked example. The user is not
required to follow this exact path — surfaces are freely switchable at any
time, and a short workflow (e.g. `draft-artifact`) collapses most of this
into a single gather → produce → checkpoint → commit pass.

```
1. Open app
   │  Overview surface loads (default landing)
   │  Actions Required panel shows pending gates (if any)
   │  Active Jobs panel shows running workflow runs
   │  Tasks panel shows available tasks
   │  Sharding Review visible if sharding proposal pending
   │  Recent Activity shows latest changes
   │  Documents panel shows recent changes
   │
2. Explore project (Graph/Overview)
   │  Navigate structure, review artifacts
   │  Open Chat → discuss what to build with Facilitator
   │
3. Pre-run scoping (DDR-028)
   │  Together with Facilitator, tag nodes and create scope draft
   │  Nodes tagged #next-run, scope draft approved
   │
4. Trigger a workflow run
   │  "New run" button → selects scope draft or quick-start goal, picks a
   │  workflow (defaults to full-build) — see conversation.md §Workflow selection
   │  SCOPING's gather/produce/checkpoint steps run (guided discussion in Chat
   │  if not quick-start)
   │
5. Charter produced → step graph continues
   │  DESIGN → CRITIQUE → PLAN → TEST → ...
   │
6. CONFIRM checkpoint
   │  Gate panel appears as modal overlay on active surface
   │  User reviews plan, optionally modifies, approves
   │  Badge: gate_pending on all tabs
   │
7. Build, Validation, Gate pass
   │  User monitors via Active Jobs
   │  Gate pass panel → commit step → version committed, run complete
   │
8. Return to Overview
   │  Run complete, artifact version committed
   │  New tasks auto-created
   │  Recent Activity updated
```

### Surface behaviors

#### Overview surface

The default landing surface. Shows:

| Panel | Content | Update mechanism |
|---|---|---|
| Actions Required | Gates, approvals, blocked issues | WebSocket `workflow_run.checkpoint_changed`, gate events |
| Active Jobs | Running workflow runs, current step, iteration count | WebSocket `step.started`, `step.completed` |
| Tasks | Available tasks from Beads integration | WebSocket `workflow_run.committed` triggers auto-creation |
| Sharding Review | Sharding proposals (conditional, visible only when pending) | WebSocket `workflow_run.checkpoint_requested` (sharding step) |
| Recent Activity | Timeline of run completions, decisions, commits | WebSocket events, aggregated on surface load |
| Documents | Recent document changes | WebSocket artifact events |

Below these fixed panels, the Overview page hosts the extensible widget
dashboard defined in [tasks-dashboard.md](tasks-dashboard.md). The fixed panels
and the widget dashboard together constitute the Overview page's content — there
is no separate dashboard page.

The Overview surface observes running workflow runs. It does not control
them — run control actions (approve, halt, resume) are routed through the
REST API, not through Overview panels.

#### Chat surface

Provides access to the Facilitator. Chat is standalone — no workflow-run
dependency. Full behavior is defined in [conversation.md](conversation.md).

Chat-run integration rules:

| Rule | Detail |
|---|---|
| Facilitator reads run state | Current step, iteration, validation status, for any active run |
| Facilitator cannot modify a run | No write access to run artifacts or step state |
| Chat works without a run | Reads discovery docs + knowledge base |
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
- Use "Start workflow" on a node to dispatch a workflow run targeting that node

Graph-initiated runs set the run's `target` to the selected node. The Planner
(or equivalent role in a non-`full-build` workflow) receives the node's
artifact slices as additional context.

### Decision points

The system presents gate panels at human checkpoints — any `checkpoint` step
in the active workflow's definition. Gate panels are modal overlays — they do
not navigate the user away from the active surface.

#### SCOPING (DDR-028)

Presented when the SCOPING `checkpoint` step sets `awaiting_checkpoint`.

| User action | Effect |
|---|---|
| Approve charter | Run-charter accepted. Run proceeds to DESIGN. |
| Refine scope | User provides additional guidance. SCOPING's gather/produce loop continues. |
| Halt run | Clean stop. Run transitions to `halted`. |

The SCOPING decision point replaces the former INTENT/CONTEXT_ASSEMBLY/EXPLORE
nodes. It is the first human checkpoint in `full-build`, where the user
reviews and approves the run-charter before the step graph continues to
DESIGN.

#### CONFIRM gate (post-planning, post-testing)

Presented when the CONFIRM `checkpoint` step sets `awaiting_checkpoint`.

| User action | Effect |
|---|---|
| Approve | Builder starts immediately. Gate panel dismisses. |
| Modify plan | Edit/reorder steps, add constraints. Triggers test regeneration. Re-presents at CONFIRM. Revision counter increments. |
| Halt run | Clean stop. Partial report generated. Run transitions to `halted`. |

This is the primary decision point in `full-build`. The user reviews the
plan, tests, and coverage before giving the Builder permission to proceed.

#### Gate pass panel (post-validation)

Presented when all validation categories pass and the EVALUATE `produce` step
confirms the implementation satisfies the intent.

| User action | Effect |
|---|---|
| Commit | Version committed, run complete, transitions to `idle` for that run. |
| Run tests locally | User verification before committing. Run pauses. |
| Reject | Run halted. |

The gate pass panel is the final checkpoint before a version is committed.

#### Sharding approval

Presented when the SHARDING_APPROVAL `checkpoint` step sets
`awaiting_checkpoint`. Full behavior defined in
[workflow-execution.md](workflow-execution.md) §Checkpoint 1 — Sharding
approval.

### Integration points between surfaces

| From | To | Mechanism |
|---|---|---|
| Overview → Chat | Tab switch | Chat observes running workflow runs read-only |
| Overview → Graph | Tab switch | — |
| Graph → Chat | "Ask about this" action on a node | Switches to Chat tab with node context injected |
| Graph → Run start | "Start workflow" on node/group | Dispatches a workflow run targeting the node |
| Any surface → Gate panel | Modal overlay | Overlays active tab; does not switch surface |
| Chat → Overview | Gate notification badge | Badge on all surface tabs |
| Run completion → Overview | Recent Activity auto-update | WebSocket event triggers panel refresh |
| Run completion → Tasks | New task auto-created | Post-run task creation hook |

### Flow: Workflow run observation

The user watches a running workflow run through Active Jobs on the Overview surface
without intervening:

```
1. Run active (WorkflowRun.status = 'active')
   │  Active Jobs panel shows: run ID, current step, iteration count
   │  Live status indicator: [● live]
   │
2. The step graph progresses
   │  WebSocket events update Active Jobs in real time
   │  Step transitions: SCOPING → DESIGN → PLAN → TEST → CONFIRM → ...
   │
3. Auto-retry on validation failure
   │  Status update in Active Jobs: "Iteration 2 — PLAN"
   │  NO gate panel (auto-retry does not interrupt the user)
   │
4. Iteration cap hit
   │  Badge: "Run {run_id} halted — cap reached"
   │  User acknowledges, triages
```

Key principle: auto-retry failures do NOT produce gate panels. Only
decision-requiring pause points produce gate panels. The user observes progress
through Active Jobs status updates.

### Flow: Standalone chat

Chat with no workflow run active:

```
1. User switches to Chat tab
   │  No active runs (system status = idle)
   │  Facilitator reads discovery docs + knowledge base
   │
2. Freeform exchange
   │  User asks questions, explores ideas
   │  Decision detection runs on user messages
   │  Capture suggestions surfaced for high-confidence decisions
   │  (captured to decisions.md; see decisions/DECISION-BRIEFS.md for format)
   │
3. User may initiate a workflow run from chat
   │  Natural language: "review the auth contract" or "start a build for X"
   │  Facilitator matches free text against workflow trigger descriptions
   │  (see conversation.md §Workflow selection), confirms with the user,
   │  then dispatches via POST /api/v2/workflow-runs
   │  ChatContext injected into the workflow's first step
   │
4. Pre-run actions available (DDR-028)
   │  Tag nodes/layers for next run (#next-run)
   │  Create/edit scope drafts
   │  These actions are available in chat mode, not just scoping mode
```

### Flow: Graph-initiated workflow run

```
1. User navigates to Graph tab
   │  Nodes organized by group and lifecycle layer
   │
2. User selects node(s)
   │  Node detail panel shows artifacts, status, history
   │  Nodes get tagged #next-run automatically
   │
3. User clicks "Start workflow"
   │  User picks a workflow (or accepts the default, full-build)
   │  Run starts with scope_draft_id or quick_start_goal
   │  SCOPING's gather/produce/checkpoint steps run (may be quick-start bypass)
   │  Charter produced
   │
4. Run continues through DESIGN → CRITIQUE → PLAN → ...
   │  Active Jobs panel shows progress
   │  Gate panels overlay active surface when needed
```

### Flow: Pre-run scoping

```
1. User opens Chat (idle state)
   │
2. User discusses intent with Facilitator: "I want to add rate limiting"
   │
3. Facilitator identifies relevant nodes/layers, proposes tagging
   │
4. User confirms tags: #next-run on rate-limiting group nodes
   │
5. Facilitator proposes scope draft
   │
6. User reviews and approves scope draft
   │
7. User clicks "Start workflow" → selects scope draft
   │
8. Run starts → SCOPING steps run → charter produced
```

### Flow: Gate rejection / halt

```
CONFIRM checkpoint:
  User halts → run transitions to halted
  Partial report generated
  Badge: "Run halted" on all tabs
  User acknowledges → run transitions to idle
  Recent Activity updated

Gate pass panel:
  User rejects → run halted
  Same recovery flow as halt

Iteration cap hit:
  Auto-halt, no gate panel
  Badge: "Run {run_id} halted — cap reached"
  User acknowledges, triages
```

---

## API contract

The user flow does not define new REST endpoints. It consumes existing endpoints
from dependent specs. The following endpoints are used by the UI to assemble the
user flow context:

### System and workflow-run state

| Endpoint | Purpose | Source spec |
|---|---|---|
| `GET /api/v2/system/state` | Current system state, active run summary, chat session | [state-machine.md](state-machine.md) |
| `GET /api/v2/workflow-runs/{run_id}` | Run detail (iteration, revision, current step, awaiting_checkpoint) | [workflow-execution.md](workflow-execution.md) |

### Gate actions

| Endpoint | Purpose | Source spec |
|---|---|---|
| `POST /api/v2/workflow-runs/{run_id}/approve` | Approve at CONFIRM or gate pass | [workflow-execution.md](workflow-execution.md) |
| `POST /api/v2/workflow-runs/{run_id}/revise` | Modify plan at CONFIRM | [workflow-execution.md](workflow-execution.md) |
| `POST /api/v2/workflow-runs/{run_id}/halt` | Halt run | [workflow-execution.md](workflow-execution.md) |
| `POST /api/v2/workflow-runs/{run_id}/sharding/approve` | Approve sharding | [workflow-execution.md](workflow-execution.md) |
| `POST /api/v2/workflow-runs/{run_id}/sharding/reject` | Reject sharding | [workflow-execution.md](workflow-execution.md) |

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
| `workflow_run.checkpoint_changed` | Render/dismiss gate panel overlay, update badges | [state-machine.md](state-machine.md) |
| `step.started` | Update Active Jobs step display | [workflow-execution.md](workflow-execution.md) |
| `step.completed` | Update Active Jobs step display | [workflow-execution.md](workflow-execution.md) |
| `gate.result` | Update Active Jobs with pass/fail, trigger badges | [workflow-execution.md](workflow-execution.md) |
| `workflow_run.checkpoint_requested` | Render the relevant gate panel on active surface | [workflow-execution.md](workflow-execution.md) |
| `workflow_run.checkpoint_cleared` | Dismiss the relevant gate panel | [workflow-execution.md](workflow-execution.md) |
| `workflow_run.committed` | Update Recent Activity, clear run badges | [workflow-execution.md](workflow-execution.md) |
| `chat.message` | Render chat messages | [conversation.md](conversation.md) |
| `chat.decision_captured` | Update notification badges | [conversation.md](conversation.md) |
| `chat.session_changed` | Update chat session state | [conversation.md](conversation.md) |

### Gate pass actions

Gate pass is a checkpoint like any other — approving it uses the same generic
endpoint as CONFIRM and other checkpoints. There is no dedicated "commit"
endpoint; the version commit happens asynchronously inside the run's `commit`
step once the checkpoint is cleared, and the UI learns the commit completed
via the `workflow_run.committed` WebSocket event (which carries the new
version id), not via the approve response.

```
POST /api/v2/workflow-runs/{run_id}/approve

Response 200:
{
  "run_id":          string,
  "current_step_id": string
}

Response 409:
{
  "error":  "not_awaiting_checkpoint",
  "reason": "No checkpoint is awaiting approval for this run."
}

POST /api/v2/workflow-runs/{run_id}/run-tests-locally

Response 200:
{
  "run_id":      string,
  "test_run_id": string,
  "status":      "started"
}
```

The approve endpoint is documented in full in
[workflow-execution.md](workflow-execution.md). It is restated here as the
user flow's required API surface for gate pass interactions. `run-tests-locally`
is open — see UF-006.

---

## Error cases

### Error states and recovery

| State | Notification | Recovery |
|---|---|---|
| Gate fail (auto-retry) | Status update in Active Jobs (no panel, no badge) | System retries automatically. User observes in Active Jobs. |
| Iteration cap hit | Badge: "Run {run_id} halted — cap reached" | User acknowledges, triages. Partial report available. |
| Unrecoverable error | Badge: "Run {run_id} error — see report" | User reads report, decides next action. |

Auto-retry failures do NOT interrupt the user. Only decision-requiring pause
points produce gate panels.

### Surface-level error handling

| Error | Surface | Condition | Recovery |
|---|---|---|---|
| WebSocket disconnect | All | Network interruption or daemon crash | Live status shows `[○ disconnected]`. UI retries connection. Surface shows last-known state. |
| Stale state | Overview | UI state diverges from daemon | Re-fetch `GET /api/v2/system/state` on reconnect. Reconcile. |
| Gate action timeout | Any | User does not respond to gate panel | Gate panel remains until user acts. No auto-dismiss. Run stays paused. |
| Chat Facilitator error | Chat | LLM timeout or provider error | Error message in chat. User may retry. Session stays open. |

### Cross-surface error propagation

Errors do not propagate between surfaces. If Chat encounters a Facilitator
error, Overview and Graph continue to function. If a workflow run errors, the
badge appears on all tabs, but each surface handles the notification
independently. Because runs are independent (DDR-031), an error in one run
never affects any other concurrently active run.

---

## Constraints

1. **Gate panels are modal overlays.** They render on whichever tab is active.
   They never navigate the user to a different surface. Dismissing a gate panel
   returns the user to the surface they were on.

2. **Auto-retry failures do not produce gate panels.** Only decision-requiring
   pause points (CONFIRM, gate pass, sharding approval, or any other
   `checkpoint` step) produce gate panels. Validation failures that trigger
   automatic retries update Active Jobs only.

3. **Chat is standalone.** Chat works without any workflow run active. The
   Facilitator reads discovery docs and the knowledge base. No run dependency.

4. **Facilitator is read-only re: run state.** The Facilitator can observe a
   run's state (current step, iteration, validation status) but cannot modify
   the run or its artifacts.

5. **Free surface switching.** The user may switch between Overview, Chat, and
   Graph at any time, regardless of system state. Gate panels overlay the active
   surface but do not lock the user to it.

6. **Terminology: "tier" vs. "layer."** "Tier" refers to architecture tiers
   (Tier 0–4). "Layer" refers to lifecycle layers only (Research, Spikes,
   Design, Plans, Implementation, Code, Notes, Hosting). Never use "layer" for
   both meanings.

7. **Approval actions via API only.** Run approval actions (approve, halt,
   revise) are routed through the REST API from the Actions Required panel on the Overview surface or
   gate panel overlays. The Facilitator cannot execute approval actions.

8. **Single gate panel per run.** At most one gate panel per run is visible,
   enforced by `WorkflowRun.awaiting_checkpoint` being a single nullable
   pointer. Multiple concurrently active runs may each present their own gate
   panel; the UI queues and presents them one at a time.

9. **Notification badges are surface-local.** Badges are rendered per-surface
   tab. Clearing a badge on one surface clears it on all surfaces for that
   notification type.

10. **Gate pass rejection recovery is unspecified.** The vision doc does not
    define what happens after a user rejects at the gate pass. The run halts,
    but the subsequent user flow (re-run, modify scope, etc.) is an open
    question.

---

## Open questions

| ID | Question | Impact | Status |
|---|---|---|---|
| UF-001 | What happens when the user rejects at gate pass? Does the run halt permanently, or can the user re-initiate from the halted state with modifications? | Recovery flow completeness | Open |
| UF-002 | How does the UI behave during network disconnection or offline mode? Should surfaces queue actions and replay on reconnect? | Reliability, UX during network issues | Open |
| UF-003 | What is the expected behavior if the daemon crashes during a running workflow run? Does the UI detect the crash and surface a recovery panel? | Crash recovery, data loss prevention | Open |
| UF-004 | Are there mobile-specific flows that differ from the three-surface desktop model? The vision doc does not differentiate. | Responsive design, touch interactions | Open |
| UF-005 | Are notification badges persisted across sessions? If the user closes and reopens the app, do unread badges persist? | Session continuity, state persistence | Open |
| UF-006 | How does "Run tests locally" at gate pass work? Does the daemon orchestrate a local test run, or does the user run tests manually outside the system? | Gate pass flow completeness | Open |
| UF-007 | ~~Should the Graph surface support multi-node selection for scoped cycles, or is single-node scoping sufficient?~~ Resolved by DDR-028: tag system allows tagging multiple nodes independently with `#next-run`, replacing the need for ad-hoc multi-node selection. | — | Resolved (DDR-028) |
| UF-008 | What is the expected behavior when a gate panel appears while the user is mid-conversation in Chat? Does the conversation pause, or can the user continue chatting while the gate panel is open? | Modal behavior, chat interruption policy | Open |
| UF-009 | Should the live status indicator show which step is currently executing, or only that a workflow run is active? With multiple concurrent runs, should it show a count, a list, or just the most recent? | Information density, surface clutter | Open |
| UF-010 | Can the user dismiss a gate panel without acting on it (e.g., "remind me later")? If so, how does the system re-present it, especially with multiple queued gate panels from different runs? | Gate panel lifecycle, run blocking | Open |
| UF-011 | When multiple workflow runs are active concurrently, how should the Active Jobs panel prioritize or group them (by workflow, by group, by recency)? | Information density with concurrency | Open |
