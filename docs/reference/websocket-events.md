# WebSocket Events

**Type:** reference · **Status:** draft · **Updated:** 2026-04-22

Consolidated catalogue of all WebSocket events for the SDK daemon.
Every event the daemon can emit or receive, grouped by subsystem.

Resolves: G5a (consolidated event catalogue), G36 (action.required event).

---

## Event envelope

All messages share a common envelope:

```typescript
interface SLEEvent {
  type: string
  cycle: number
  iteration: number
  timestamp: string
  payload: unknown
}
```

Chat events carry an additional `session_id` field at the top level.

### Direction convention

| Symbol | Meaning |
|--------|---------|
| **S→C** | Server (daemon) sends to client |
| **C→S** | Client sends to daemon |

---

## 1. System lifecycle

Events that track the top-level system state machine.

**System states (mutually exclusive):**
`idle` · `discovering` · `cycling` · `halted` · `complete`

**Orthogonal flags (set on the cycle record, not states):**
- `cycle.awaiting_confirmation: boolean` — confirm gate reached (DDR-021)
- `cycle.awaiting_sharding_approval: boolean` — sharding proposal awaiting review (DDR-026)

**Chat is orthogonal (DDR-020):** chat sessions are always available
regardless of system state. See §5 for chat events.

| # | Event name | Dir | Payload type | Trigger |
|---|-----------|-----|-------------|---------|
| 1.1 | `system.state_changed` | S→C | `StateChangedPayload` | System state transitions to a new value |
| 1.2 | `system.ready` | S→C | `{ version, pid, uptime_ms }` | Daemon startup validation passes, accepting connections |
| 1.3 | `system.shutdown` | S→C | `{ reason: 'graceful' \| 'error', message? }` | Daemon is shutting down |

```typescript
interface StateChangedPayload {
  previous: string
  current: 'idle' | 'discovering' | 'cycling' | 'halted' | 'complete'
  cycle?: number
  awaiting_confirmation?: boolean
  awaiting_sharding_approval?: boolean
  reason?: string
}
```

> **Note (1.1):** New event — consolidated from G5a. Previously, state
> transitions were implied by cycle events only. `system.state_changed`
> provides an explicit signal for UI state machines.

---

## 2. DAG execution

Events emitted as the DAG runner progresses through nodes within a cycle.

| # | Event name | Dir | Payload type | Trigger |
|---|-----------|-----|-------------|---------|
| 2.1 | `cycle.started` | S→C | `CycleStartedPayload` | New cycle begins |
| 2.2 | `cycle.completed` | S→C | `CycleCompletedPayload` | Cycle finishes successfully |
| 2.3 | `cycle.halted` | S→C | `CycleHaltedPayload` | Cycle halted (cap hit, error, or user action) |
| 2.4 | `cycle.iteration_started` | S→C | `IterationStartedPayload` | New iteration begins within a cycle |
| 2.5 | `node.started` | S→C | `NodeStartedPayload` | A DAG node begins execution |
| 2.6 | `node.completed` | S→C | `NodeCompletedPayload` | A DAG node finishes execution |

```typescript
interface CycleStartedPayload {
  goal: string
  depth: 'standard' | 'deep' | 'research'
  categories_pending: string[]
  max_iterations: number
  session_id: string
}

interface CycleCompletedPayload {
  version_id: string
  summary_path: string
  iterations_used: number
  categories_validated: string[]
}

interface CycleHaltedPayload {
  reason: 'user_halt' | 'max_iterations' | 'error' | 'crash'
  iteration: number
  report_path: string
  message?: string
}

interface IterationStartedPayload {
  iteration: number
  failure_context_present: boolean
}

interface NodeStartedPayload {
  node_id: string
  agent_role?: string
  input_summary?: string
}

interface NodeCompletedPayload {
  node_id: string
  outcome: 'success' | 'failure' | 'skipped'
  duration_ms: number
  artifact_ids_written?: string[]
  error?: string
}
```

> **Note (2.4):** New event — consolidated from G5a. Previously, iteration
> boundaries were implied by node sequences. This event makes iteration
> transitions explicit.

---

## 3. Validation

Events emitted during the validation fan-out and gate evaluation phases.

| # | Event name | Dir | Payload type | Trigger |
|---|-----------|-----|-------------|---------|
| 3.1 | `validation.category.started` | S→C | `CategoryStartedPayload` | A validation category begins its fan-out |
| 3.2 | `validation.category.completed` | S→C | `CategoryCompletedPayload` | A validation category finishes |
| 3.3 | `gate.result` | S→C | `GateResultPayload` | Gate evaluates category results — pass or fail |

```typescript
interface CategoryStartedPayload {
  category: string
  method: 'static' | 'llm' | 'executable'
  node_id: string
}

interface CategoryCompletedPayload {
  category: string
  result: {
    passed: boolean
    tests_total: number
    tests_passed: number
    tests_failed: number
    duration_ms: number
  }
}

interface GateResultPayload {
  outcome: 'pass' | 'fail'
  failed_categories: string[]
  passed_categories: string[]
  iteration: number
  will_retry: boolean
}
```

---

## 4. Gates & human actions

Events related to approval gates, confirmation prompts, and the action-required
panel. Includes the new `action.required` event (G36).

| # | Event name | Dir | Payload type | Trigger |
|---|-----------|-----|-------------|---------|
| 4.1 | `approval.required` | S→C | `ApprovalRequiredPayload` | A gate requires human approval before proceeding |
| 4.2 | `approval.respond` | C→S | `ApprovalRespondPayload` | Client responds to an approval prompt |
| 4.3 | `categories.confirm` | C→S | `CategoriesConfirmPayload` | Client confirms category selection after planning |
| 4.4 | `action.required` | S→C | `ActionRequiredPayload` | Any action needing human attention — gate approvals, blocked issues, flagged decisions, stale tasks (G36) |

```typescript
interface ApprovalRequiredPayload {
  gate: 'after_planning' | 'after_gate_pass' | 'sharding_review'
  prompt: string
  cycle: number
  iteration: number
  categories?: string[]
  sharding_proposal?: {
    task_count: number
    summary: string
  }
}

interface ApprovalRespondPayload {
  gate: string
  decision: 'approve' | 'reject'
  message?: string
  categories?: string[]
}

interface CategoriesConfirmPayload {
  categories: string[]
}
```

### 4.4 action.required — payload schema (G36)

```typescript
type ActionType =
  | 'gate_approval'
  | 'sharding_approval'
  | 'blocked_issue'
  | 'decision_flagged'
  | 'stale_task'
  | 'session_handoff'

interface ActionRequiredPayload {
  action_id: string
  action_type: ActionType
  priority: 'critical' | 'high' | 'medium' | 'low'
  title: string
  description: string
  context: {
    cycle?: number
    iteration?: number
    node_id?: string
    categories?: string[]
    task_id?: string
    issue_id?: string
  }
  available_responses: Array<{
    id: string
    label: string
    type: 'approve' | 'reject' | 'edit' | 'dismiss' | 'view'
  }>
  expires_at?: string
}
```

**Priority rules:**

| Action type | Default priority | Overrides |
|-------------|-----------------|-----------|
| `gate_approval` | critical | — |
| `sharding_approval` | high | — |
| `blocked_issue` | high | medium if issue is non-blocking |
| `decision_flagged` | medium | — |
| `stale_task` | medium | low if no active cycle |
| `session_handoff` | low | — |

**When emitted:**

| Action type | Emitted when |
|-------------|-------------|
| `gate_approval` | Confirm gate reached (`cycle.awaiting_confirmation = true`) |
| `sharding_approval` | Sharding proposal ready (`cycle.awaiting_sharding_approval = true`, DDR-026) |
| `blocked_issue` | A Beads issue is blocked and cannot proceed |
| `decision_flagged` | Chat decision capture suggested or Historian flags a decision |
| `stale_task` | A sharded task's source documents changed after sharding (SLE-019) |
| `session_handoff` | Agent session needs human review or continuation |

**Relationship to `approval.required`:** `approval.required` is retained for
backward compatibility with the specific gate approval flow (SLE-005). When a
gate triggers, the daemon emits *both* `approval.required` and
`action.required` (action_type `gate_approval`). Clients that only handle
`approval.required` continue to work. New clients should prefer
`action.required` for a unified action panel.

> **Note (4.4):** New event — resolves G36. The "Actions required" panel
> (SLE-020) listens to this single event type for all human-action surfaces.

---

## 5. Chat / conversation

Events for conversation mode (SLE-012). Chat is orthogonal to system state
(DDR-020) — these events are emitted regardless of whether the system is idle,
cycling, discovering, halted, or complete.

Chat events carry a top-level `session_id` field in addition to the standard
envelope.

| # | Event name | Dir | Payload type | Trigger |
|---|-----------|-----|-------------|---------|
| 5.1 | `chat.message` | S→C | `ChatMessagePayload` | A message is sent in the conversation (user or facilitator) |
| 5.2 | `chat.decision_captured` | S→C | `DecisionCapturedPayload` | A detected decision is persisted to decisions.md |

```typescript
interface ChatMessagePayload {
  role: 'user' | 'facilitator'
  content: string
  sources?: string[]
  decision_detected?: {
    id: string
    summary: string
    rationale: string
    scope: string
  }
}
```

```typescript
interface DecisionCapturedPayload {
  decision_id: string
  path: string
  summary: string
}
```

**chat.message** is emitted for both user and facilitator messages. When the
Facilitator detects a decision, `decision_detected` is included. The client
may present a capture prompt. If the user confirms, `chat.decision_captured`
follows.

> **Note:** Chat events do not carry `cycle` or `iteration` fields from the
> standard envelope. These fields are set to `0` when no cycle is active.

---

## 6. Run artifacts

Events emitted during validation execution as run artifacts are written
incrementally (SLE-022). These enable live progress display in the Active Jobs
panel and the graph dashboard.

| # | Event name | Dir | Payload type | Trigger |
|---|-----------|-----|-------------|---------|
| 6.1 | `run.artifact_written` | S→C | `RunArtifactWrittenPayload` | A single artifact file is written to the run directory |
| 6.2 | `run.manifest_ready` | S→C | `RunManifestReadyPayload` | manifest.json is generated and written |
| 6.3 | `run.context_pack_ready` | S→C | `RunContextPackReadyPayload` | context-pack.md is generated |

```typescript
interface RunArtifactWrittenPayload {
  run_id: string
  path: string
  category?: string
  size_bytes?: number
}
```

```typescript
interface RunManifestReadyPayload {
  run_id: string
  run_dir: string
  manifest: RunManifest
}
```

```typescript
interface RunContextPackReadyPayload {
  run_id: string
  run_dir: string
  failed_categories: string[]
  passed_categories: string[]
}
```

The Active Jobs panel (SLE-020) listens to `run.manifest_ready` for
per-category pass/fail status. The graph dashboard (SLE-013) listens to
`run.artifact_written` for live node status during execution.

---

## 7. Artifacts

Events for project artifact changes.

| # | Event name | Dir | Payload type | Trigger |
|---|-----------|-----|-------------|---------|
| 7.1 | `artifact.updated` | S→C | `ArtifactUpdatedPayload` | An artifact file is written or modified |

```typescript
interface ArtifactUpdatedPayload {
  artifact_id: string
  path: string
  version?: string
  size_bytes?: number
}
```

---

## 8. Errors

| # | Event name | Dir | Payload type | Trigger |
|---|-----------|-----|-------------|---------|
| 8.1 | `error` | S→C | `ErrorPayload` | Any error during daemon operation |

```typescript
interface ErrorPayload {
  message: string
  code?: string
  node_id?: string
  recoverable: boolean
  context?: Record<string, unknown>
}
```

---

## Summary table

All events at a glance. The "Source" column indicates where the event was
originally defined.

| # | Event | Dir | Source | Group |
|---|-------|-----|--------|-------|
| 1.1 | `system.state_changed` | S→C | **G5a (new)** | System lifecycle |
| 1.2 | `system.ready` | S→C | **G5a (new)** | System lifecycle |
| 1.3 | `system.shutdown` | S→C | **G5a (new)** | System lifecycle |
| 2.1 | `cycle.started` | S→C | SLE-005 | DAG execution |
| 2.2 | `cycle.completed` | S→C | SLE-005 | DAG execution |
| 2.3 | `cycle.halted` | S→C | SLE-005 | DAG execution |
| 2.4 | `cycle.iteration_started` | S→C | **G5a (new)** | DAG execution |
| 2.5 | `node.started` | S→C | SLE-005 | DAG execution |
| 2.6 | `node.completed` | S→C | SLE-005 | DAG execution |
| 3.1 | `validation.category.started` | S→C | SLE-005 | Validation |
| 3.2 | `validation.category.completed` | S→C | SLE-005 | Validation |
| 3.3 | `gate.result` | S→C | SLE-005 | Validation |
| 4.1 | `approval.required` | S→C | SLE-005 | Gates & actions |
| 4.2 | `approval.respond` | C→S | SLE-005 | Gates & actions |
| 4.3 | `categories.confirm` | C→S | SLE-005 | Gates & actions |
| 4.4 | `action.required` | S→C | **G36 (new)** | Gates & actions |
| 5.1 | `chat.message` | S→C | SLE-012 | Chat |
| 5.2 | `chat.decision_captured` | S→C | SLE-012 | Chat |
| 6.1 | `run.artifact_written` | S→C | SLE-022 | Run artifacts |
| 6.2 | `run.manifest_ready` | S→C | SLE-022 | Run artifacts |
| 6.3 | `run.context_pack_ready` | S→C | SLE-022 | Run artifacts |
| 7.1 | `artifact.updated` | S→C | SLE-005 | Artifacts |
| 8.1 | `error` | S→C | SLE-005 | Errors |

**Totals:** 23 events (18 server→client, 3 client→server, 2 additional server→client alongside existing gate events).

**New events (G5a + G36):** `system.state_changed`, `system.ready`,
`system.shutdown`, `cycle.iteration_started`, `action.required`.

**Existing events:** All others sourced from SLE-005, SLE-012, SLE-022.

---

## Design decisions applied

| ID | Decision | Effect on events |
|----|----------|-----------------|
| DDR-020 | Chat is orthogonal to system state | Chat events (§5) carry `session_id`, not system state. `chatting` is not a system state. |
| DDR-021 | `confirming` is a flag, not a state | `system.state_changed` emits `awaiting_confirmation: boolean` in payload. System state stays `cycling`. |
| DDR-026 | Sharding approval uses `cycle.awaiting_sharding_approval` | `action.required` with `action_type: 'sharding_approval'` is emitted. `approval.required` with `gate: 'sharding_review'` is also emitted for backward compatibility. |
| G5a | Consolidated event catalogue | This document. All WebSocket events from SLE-005, SLE-012, SLE-022 in one reference. |
| G36 | `action.required` event for human action panel | §4.4 defines the full payload with action types, priorities, and available responses. |
