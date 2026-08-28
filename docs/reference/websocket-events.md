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
  run_id: string | null
  workflow_id: string | null
  iteration: number
  timestamp: string
  payload: unknown
}
```

`run_id`/`workflow_id` are `null` for events not scoped to a workflow run
(system lifecycle, chat, init/discovery). Chat events carry an additional
`session_id` field at the top level.

### Direction convention

| Symbol | Meaning |
|--------|---------|
| **S→C** | Server (daemon) sends to client |
| **C→S** | Client sends to daemon |

---

## 1. System lifecycle

Events that track the top-level system state machine.

**System states (mutually exclusive, project-wide):**
`idle` · `discovering` (DDR-031)

Per-run progress (`active | halted | complete`) lives on each
`WorkflowRun.status`, not on system-wide state — see §2 for run lifecycle
events. A derived `active_workflow_run_count` is included in
`system.state_changed` payloads for display purposes only.

**Checkpoint pointer (per run, not a system-wide flag):**
`WorkflowRun.awaiting_checkpoint: string | null` (DDR-031) — see §2.

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
  current: 'idle' | 'discovering'
  active_workflow_run_count: number
  reason?: string
}
```

> **Note (1.1):** New event — consolidated from G5a. Previously, state
> transitions were implied by cycle events only. `system.state_changed`
> provides an explicit signal for UI state machines.

---

## 2. Workflow run execution

Events emitted as the daemon walks a workflow run's step graph (DDR-031).
Multiple runs may be active concurrently — every event in this group carries
`run_id` so clients can demultiplex.

| # | Event name | Dir | Payload type | Trigger |
|---|-----------|-----|-------------|---------|
| 2.1 | `workflow_run.started` | S→C | `WorkflowRunStartedPayload` | New workflow run begins |
| 2.2 | `workflow_run.completed` | S→C | `WorkflowRunCompletedPayload` | Workflow run finishes successfully |
| 2.3 | `workflow_run.halted` | S→C | `WorkflowRunHaltedPayload` | Workflow run halted (cap hit, error, or user action) |
| 2.4 | `workflow_run.iteration_started` | S→C | `IterationStartedPayload` | New iteration begins within a run |
| 2.5 | `step.started` | S→C | `StepStartedPayload` | A step begins execution |
| 2.6 | `step.completed` | S→C | `StepCompletedPayload` | A step finishes execution |
| 2.7 | `workflow_run.checkpoint_requested` | S→C | `CheckpointRequestedPayload` | A `checkpoint` step pauses the run, awaiting input |
| 2.8 | `workflow_run.checkpoint_cleared` | S→C | `CheckpointClearedPayload` | A checkpoint is cleared (approved, revised, or rejected) |
| 2.9 | `workflow_run.committed` | S→C | `WorkflowRunCommittedPayload` | A `commit` step locks a new version |

```typescript
interface WorkflowRunStartedPayload {
  run_id: string
  workflow_id: string
  target: { group?: string; layer?: string; node_key?: string } | null
  goal: string
  depth: 'minimal' | 'standard' | 'deep' | 'research'
  max_iterations: number
  session_id: string
}

interface WorkflowRunCompletedPayload {
  run_id: string
  version_id: string
  summary_path: string
  iterations_used: number
  categories_validated: string[]
}

interface WorkflowRunHaltedPayload {
  run_id: string
  reason: 'user_halt' | 'max_iterations' | 'error' | 'crash'
  iteration: number
  report_path: string
  message?: string
}

interface IterationStartedPayload {
  run_id: string
  iteration: number
  failure_context_present: boolean
}

interface StepStartedPayload {
  run_id: string
  workflow_id: string
  step_id: string
  kind: 'gather' | 'produce' | 'review' | 'checkpoint' | 'execute' | 'commit'
  agent_role?: string
  input_summary?: string
}

interface StepCompletedPayload {
  run_id: string
  step_id: string
  outcome: 'success' | 'failure' | 'skipped'
  duration_ms: number
  artifact_ids_written?: string[]
  error?: string
}

interface CheckpointRequestedPayload {
  run_id: string
  step_id: string
  revision: number
  plan_summary?: { step_count: number; test_count: number; coverage_pct: number }
}

interface CheckpointClearedPayload {
  run_id: string
  step_id: string
}

interface WorkflowRunCommittedPayload {
  run_id: string
  version_id: string
}
```

> **Note (2.4):** New event — consolidated from G5a. Previously, iteration
> boundaries were implied by node sequences. This event makes iteration
> transitions explicit.
>
> **Note (DDR-031):** This group replaces the former cycle-scoped events
> (`cycle.started/completed/halted/iteration_started`, `node.started/
> completed`, `cycle.flag_changed`, `dag.confirm_requested`,
> `dag.sharding_requested`, `dag.snapshot_locked`). `node.*` becomes
> `step.*` since steps are no longer DAG-fixed nodes. The three former
> checkpoint-specific events (`cycle.flag_changed`, `dag.confirm_requested`,
> `dag.sharding_requested`) collapse into the single generic
> `workflow_run.checkpoint_requested`/`checkpoint_cleared` pair, since any
> `checkpoint` step uses the same `awaiting_checkpoint` pointer mechanism.
> `dag.snapshot_locked` becomes `workflow_run.committed`.

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
  run_id: string
  category: string
  method: 'static' | 'llm' | 'executable'
  step_id: string
}

interface CategoryCompletedPayload {
  run_id: string
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
  run_id: string
  step_id: string
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
  run_id: string
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
    run_id?: string
    iteration?: number
    step_id?: string
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
| `stale_task` | medium | low if no active workflow run |
| `session_handoff` | low | — |

**When emitted:**

| Action type | Emitted when |
|-------------|-------------|
| `gate_approval` | A checkpoint step is reached (`WorkflowRun.awaiting_checkpoint` set) |
| `sharding_approval` | Sharding proposal ready (the sharding `checkpoint` step is reached, DDR-026) |
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
(DDR-020) — these events are emitted regardless of system state or how many
workflow runs are active.

Chat events carry a top-level `session_id` field in addition to the standard
envelope.

| # | Event name | Dir | Payload type | Trigger |
|---|-----------|-----|-------------|---------|
| 5.1 | `chat.message` | S→C | `ChatMessagePayload` | A message is sent in the conversation (user or facilitator) |
| 5.2 | `chat.decision_captured` | S→C | `DecisionCapturedPayload` | A detected decision is persisted to decisions.md |
| 5.3 | `chat.session_changed` | S→C | `ChatSessionChangedPayload` | Chat session opened or closed |

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

```typescript
interface ChatSessionChangedPayload {
  session_open: boolean
  timestamp: string
}
```

**chat.message** is emitted for both user and facilitator messages. When the
Facilitator detects a decision, `decision_detected` is included. The client
may present a capture prompt. If the user confirms, `chat.decision_captured`
follows.

> **Note:** Chat events do not carry `run_id`/`workflow_id` or `iteration`
> fields from the standard envelope. These fields are `null`/`0` since chat
> is not scoped to any particular workflow run.

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

## 9. Init / Discovery

Events emitted during `sle init` and `sle discover`. Init events may fire before
the daemon is fully accepting connections — they are written to the event stream
as soon as the WebSocket server binds.

| # | Event name | Dir | Payload type | Trigger |
|---|-----------|-----|-------------|---------|
| 9.1 | `init.step_completed` | S→C | `InitStepCompletedPayload` | An init step finishes |
| 9.2 | `init.complete` | S→C | `InitCompletePayload` | All init steps succeed |

```typescript
interface InitStepCompletedPayload {
  step: number
  name: string
  status: 'success' | 'failed'
  message: string
}
```

```typescript
interface InitCompletePayload {
  files_created: string[]
  task_store: 'beads' | 'local'
  daemon_port: number
}
```

| # | Event name | Dir | Payload type | Trigger |
|---|-----------|-----|-------------|---------|
| 9.3 | `discovery.round_started` | S→C | `DiscoveryRoundStartedPayload` | A discovery round begins |
| 9.4 | `discovery.draft_ready` | S→C | `DiscoveryDraftReadyPayload` | Facilitator produces a draft for user review |
| 9.5 | `discovery.round_approved` | S→C | `DiscoveryRoundApprovedPayload` | User approves a round |
| 9.6 | `discovery.complete` | S→C | `DiscoveryCompletePayload` | All discovery rounds and planning finish |

```typescript
interface DiscoveryRoundStartedPayload {
  session_id: string
  round: number
  opening_question: string
}
```

```typescript
interface DiscoveryDraftReadyPayload {
  session_id: string
  round: number
  artifact_path: string
}
```

```typescript
interface DiscoveryRoundApprovedPayload {
  session_id: string
  round: number
  artifact_path: string
  next_round: number | null
}
```

```typescript
interface DiscoveryCompletePayload {
  session_id: string
  artifacts: string[]
  total_phases: number
}
```

---

## 10. Intake / sharding

Events from the document intake and task sharding pipeline (SLE-019). Emitted
when the pipeline runs inline (inside PLAN node) or standalone (`sle intake`).

| # | Event name | Dir | Payload type | Trigger |
|---|-----------|-----|-------------|---------|
| 10.1 | `intake.coherence_checked` | S→C | `IntakeCoherenceCheckedPayload` | Coherence gate completes |
| 10.2 | `intake.sharding_proposed` | S→C | `IntakeShardingProposedPayload` | Planner produces a sharding proposal |
| 10.3 | `intake.sharding_approved` | S→C | `IntakeShardingApprovedPayload` | User approves sharding proposal |
| 10.4 | `intake.sharding_rejected` | S→C | `IntakeShardingRejectedPayload` | User rejects sharding proposal |
| 10.5 | `intake.document_promoted` | S→C | `IntakeDocumentPromotedPayload` | An ungraphed document is promoted to a node |
| 10.6 | `intake.task_stale` | S→C | `IntakeTaskStalePayload` | A task's source document changes after creation |

```typescript
interface IntakeCoherenceCheckedPayload {
  status: 'clean' | 'flagged' | 'blocked'
  finding_count: number
  blocking_count: number
}
```

```typescript
interface IntakeShardingProposedPayload {
  task_count: number
  total_estimated_tokens: number
}
```

```typescript
interface IntakeShardingApprovedPayload {
  tasks_created: number
}
```

```typescript
interface IntakeShardingRejectedPayload {}
```

```typescript
interface IntakeDocumentPromotedPayload {
  document_id: string
  node_id: string
}
```

```typescript
interface IntakeTaskStalePayload {
  task_id: string
  document_id: string
  section_id: string | null
}
```

---

## 11. Job dispatch

Events from the execution plane's job dispatcher (L4). Emitted when a
workflow run's `execute` step spawns Docker containers for validation runs.
The worker pool is a shared resource (DDR-031) — these events interleave
with task-dispatch jobs on the same pool; see
[../specs/job-dispatch.md](../specs/job-dispatch.md).

| # | Event name | Dir | Payload type | Trigger |
|---|-----------|-----|-------------|---------|
| 11.1 | `dispatch.started` | S→C | `DispatchStartedPayload` | Dispatch begins for a workflow run |
| 11.2 | `dispatch.job_status_changed` | S→C | `DispatchJobStatusChangedPayload` | A job transitions between statuses |
| 11.3 | `dispatch.static_gate_passed` | S→C | `DispatchStaticGatePassedPayload` | Static check passes, releasing category jobs |
| 11.4 | `dispatch.static_gate_failed` | S→C | `DispatchStaticGateFailedPayload` | Static check fails, cancelling remaining jobs |
| 11.5 | `dispatch.category_completed` | S→C | `DispatchCategoryCompletedPayload` | All sub-phases finish for a category |
| 11.6 | `dispatch.completed` | S→C | `DispatchCompletedPayload` | All jobs in the dispatch finish |
| 11.7 | `dispatch.worker_status_changed` | S→C | `DispatchWorkerStatusChangedPayload` | A worker pool member changes status |

```typescript
interface DispatchStartedPayload {
  workflow_run_id: string
  dispatch_id: string
  total_jobs: number
  mode: 'workflow_run_validation' | 'task-execution'
}
```

```typescript
interface DispatchJobStatusChangedPayload {
  workflow_run_id: string
  dispatch_id: string
  job_id: string
  previous: string
  current: string
}
```

```typescript
interface DispatchStaticGatePassedPayload {
  workflow_run_id: string
  dispatch_id: string
  released_jobs: string[]
}
```

```typescript
interface DispatchStaticGateFailedPayload {
  workflow_run_id: string
  dispatch_id: string
  cancelled_jobs: string[]
}
```

```typescript
interface DispatchCategoryCompletedPayload {
  workflow_run_id: string
  category: string
  passed: boolean
  duration_ms: number
}
```

```typescript
interface DispatchCompletedPayload {
  workflow_run_id: string
  dispatch_id: string
  total_jobs: number
  completed: number
  failed: number
  duration_ms: number
}
```

```typescript
interface DispatchWorkerStatusChangedPayload {
  worker_id: string
  previous: string
  current: string
}
```

---

## 12. Task / store

Events from the TaskStore provider layer (BeadsTaskStore or LocalTaskStore).
These cover task lifecycle operations triggered by workflow-run step
integration points and the resolveExit flow.

| # | Event name | Dir | Payload type | Trigger |
|---|-----------|-----|-------------|---------|
| 12.1 | `task.claimed` | S→C | `TaskClaimedPayload` | A task is claimed (status → in_progress) |
| 12.2 | `task.resolved` | S→C | `TaskResolvedPayload` | resolveExit completes for a task |
| 12.3 | `task.comment_added` | S→C | `TaskCommentAddedPayload` | A comment is appended to a task |
| 12.4 | `task.stale_detected` | S→C | `TaskStaleDetectedPayload` | A task is flagged as stale |
| 12.5 | `task_store.sync` | S→C | `TaskStoreSyncPayload` | Beads push/pull completes |

```typescript
interface TaskClaimedPayload {
  task_id: string
  claimed_by: string
}
```

```typescript
interface TaskResolvedPayload {
  task_id: string
  outcome: 'completed' | 'halted' | 'user_halt' | 'error' | 'crash'
  new_status: string
}
```

```typescript
interface TaskCommentAddedPayload {
  task_id: string
  body: string
  source: 'historian' | 'user' | 'system'
}
```

```typescript
interface TaskStaleDetectedPayload {
  task_id: string
  stale_for_ms: number
}
```

```typescript
interface TaskStoreSyncPayload {
  direction: 'push' | 'pull'
  success: boolean
  error: string | null
}
```

---

## 13. Document linking

Events from the document linking subsystem. Emitted when links between documents
are created, deleted, or when the link index is rebuilt.

| # | Event name | Dir | Payload type | Trigger |
|---|-----------|-----|-------------|---------|
| 13.1 | `link.created` | S→C | `LinkCreatedPayload` | A new link is established |
| 13.2 | `link.deleted` | S→C | `LinkDeletedPayload` | An existing link is removed |
| 13.3 | `link.index_rebuilt` | S→C | `LinkIndexRebuiltPayload` | Full link index is rebuilt |
| 13.4 | `link.index_updated` | S→C | `LinkIndexUpdatedPayload` | Incremental link index update |
| 13.5 | `link.file_updated` | S→C | `LinkFileUpdatedPayload` | A file's links are re-extracted |

```typescript
interface LinkCreatedPayload {
  link_id: string
  source: { doc: string; heading?: string }
  target: { doc: string; heading?: string }
  link_type: string
}

interface LinkDeletedPayload {
  link_id: string
  source: { doc: string; heading?: string }
  target: { doc: string; heading?: string }
}

interface LinkIndexRebuiltPayload {
  link_count: number
  file_count: number
  duration_ms: number
}

interface LinkIndexUpdatedPayload {
  added: number
  removed: number
}

interface LinkFileUpdatedPayload {
  path: string
  affected_backlinks: number
}
```

---

## 14. Content & modules

Events from the content storage and module execution subsystems.

| # | Event name | Dir | Payload type | Trigger |
|---|-----------|-----|-------------|---------|
| 14.1 | `content.written` | S→C | `ContentWrittenPayload` | Content written to a graph node |
| 14.2 | `content.deleted` | S→C | `ContentDeletedPayload` | Content removed from a node |
| 14.3 | `module.triggered` | S→C | `ModuleTriggeredPayload` | Processing module begins execution |
| 14.4 | `module.completed` | S→C | `ModuleCompletedPayload` | Processing module finishes successfully |
| 14.5 | `module.failed` | S→C | `ModuleFailedPayload` | Processing module fails |
| 14.6 | `module.registered` | S→C | `ModuleRegisteredPayload` | New module registered with daemon |

```typescript
interface ContentWrittenPayload {
  node_id: string
  format: string
  size_bytes: number
  checksum: string
}

interface ContentDeletedPayload {
  node_id: string
}

interface ModuleTriggeredPayload {
  module_id: string
  trigger_type: string
  node_count: number
}

interface ModuleCompletedPayload {
  module_id: string
  annotations: number
  derived_nodes: number
  duration_ms: number
}

interface ModuleFailedPayload {
  module_id: string
  error_code: string
  message: string
}

interface ModuleRegisteredPayload {
  module_id: string
  layer: string
  enabled: boolean
}
```

---

## Summary table

All events at a glance. The "Source" column indicates where the event was
originally defined.

| # | Event | Dir | Source | Group |
|---|-------|-----|--------|-------|
| 1.1 | `system.state_changed` | S→C | G5a (new) | System lifecycle |
| 1.2 | `system.ready` | S→C | G5a (new) | System lifecycle |
| 1.3 | `system.shutdown` | S→C | G5a (new) | System lifecycle |
| 2.1 | `workflow_run.started` | S→C | SLE-005 | Workflow run execution |
| 2.2 | `workflow_run.completed` | S→C | SLE-005 | Workflow run execution |
| 2.3 | `workflow_run.halted` | S→C | SLE-005 | Workflow run execution |
| 2.4 | `workflow_run.iteration_started` | S→C | G5a (new) | Workflow run execution |
| 2.5 | `step.started` | S→C | SLE-005 | Workflow run execution |
| 2.6 | `step.completed` | S→C | SLE-005 | Workflow run execution |
| 2.7 | `workflow_run.checkpoint_requested` | S→C | SLE-005 | Workflow run execution |
| 2.8 | `workflow_run.checkpoint_cleared` | S→C | SLE-005 | Workflow run execution |
| 2.9 | `workflow_run.committed` | S→C | SLE-005 | Workflow run execution |
| 3.1 | `validation.category.started` | S→C | SLE-005 | Validation |
| 3.2 | `validation.category.completed` | S→C | SLE-005 | Validation |
| 3.3 | `gate.result` | S→C | SLE-005 | Validation |
| 4.1 | `approval.required` | S→C | SLE-005 | Gates & actions |
| 4.2 | `approval.respond` | C→S | SLE-005 | Gates & actions |
| 4.3 | `categories.confirm` | C→S | SLE-005 | Gates & actions |
| 4.4 | `action.required` | S→C | G36 (new) | Gates & actions |
| 5.1 | `chat.message` | S→C | SLE-012 | Chat |
| 5.2 | `chat.decision_captured` | S→C | SLE-012 | Chat |
| 5.3 | `chat.session_changed` | S→C | SLE-012 | Chat |
| 6.1 | `run.artifact_written` | S→C | SLE-022 | Run artifacts |
| 6.2 | `run.manifest_ready` | S→C | SLE-022 | Run artifacts |
| 6.3 | `run.context_pack_ready` | S→C | SLE-022 | Run artifacts |
| 7.1 | `artifact.updated` | S→C | SLE-005 | Artifacts |
| 8.1 | `error` | S→C | SLE-005 | Errors |
| 9.1 | `init.step_completed` | S→C | SLE-009 | Init / Discovery |
| 9.2 | `init.complete` | S→C | SLE-009 | Init / Discovery |
| 9.3 | `discovery.round_started` | S→C | SLE-011 | Init / Discovery |
| 9.4 | `discovery.draft_ready` | S→C | SLE-011 | Init / Discovery |
| 9.5 | `discovery.round_approved` | S→C | SLE-011 | Init / Discovery |
| 9.6 | `discovery.complete` | S→C | SLE-011 | Init / Discovery |
| 10.1 | `intake.coherence_checked` | S→C | SLE-019 | Intake / sharding |
| 10.2 | `intake.sharding_proposed` | S→C | SLE-019 | Intake / sharding |
| 10.3 | `intake.sharding_approved` | S→C | SLE-019 | Intake / sharding |
| 10.4 | `intake.sharding_rejected` | S→C | SLE-019 | Intake / sharding |
| 10.5 | `intake.document_promoted` | S→C | SLE-019 | Intake / sharding |
| 10.6 | `intake.task_stale` | S→C | SLE-019 | Intake / sharding |
| 11.1 | `dispatch.started` | S→C | SLE-020 | Job dispatch |
| 11.2 | `dispatch.job_status_changed` | S→C | SLE-020 | Job dispatch |
| 11.3 | `dispatch.static_gate_passed` | S→C | SLE-020 | Job dispatch |
| 11.4 | `dispatch.static_gate_failed` | S→C | SLE-020 | Job dispatch |
| 11.5 | `dispatch.category_completed` | S→C | SLE-020 | Job dispatch |
| 11.6 | `dispatch.completed` | S→C | SLE-020 | Job dispatch |
| 11.7 | `dispatch.worker_status_changed` | S→C | SLE-020 | Job dispatch |
| 12.1 | `task.claimed` | S→C | SLE-006 | Task / store |
| 12.2 | `task.resolved` | S→C | SLE-006 | Task / store |
| 12.3 | `task.comment_added` | S→C | SLE-006 | Task / store |
| 12.4 | `task.stale_detected` | S→C | SLE-006 | Task / store |
| 12.5 | `task_store.sync` | S→C | SLE-006 | Task / store |
| 13.1 | `link.created` | S→C | SLE-025 | Document linking |
| 13.2 | `link.deleted` | S→C | SLE-025 | Document linking |
| 13.3 | `link.index_rebuilt` | S→C | SLE-025 | Document linking |
| 13.4 | `link.index_updated` | S→C | SLE-025 | Document linking |
| 13.5 | `link.file_updated` | S→C | SLE-025 | Document linking |
| 14.1 | `content.written` | S→C | SLE-024 | Content & modules |
| 14.2 | `content.deleted` | S→C | SLE-024 | Content & modules |
| 14.3 | `module.triggered` | S→C | SLE-024 | Content & modules |
| 14.4 | `module.completed` | S→C | SLE-024 | Content & modules |
| 14.5 | `module.failed` | S→C | SLE-024 | Content & modules |
| 14.6 | `module.registered` | S→C | SLE-024 | Content & modules |

**Totals:** 63 events (61 server→client, 2 client→server).

**New events (Phase 4):** 39 events from init/discovery (§9), intake/sharding (§10), job dispatch (§11), task/store (§12), workflow run execution (§2), document linking (§13), and content/modules (§14).

**Prior events:** 24 events from Phases 1–3 (§1–§8).

---

## Design decisions applied

| ID | Decision | Effect on events |
|----|----------|-----------------|
| DDR-020 | Chat is orthogonal to system state | Chat events (§5) carry `session_id`, not system state. `chatting` is not a system state. |
| DDR-021 | Confirmation is a per-run checkpoint, not a system-wide flag | `workflow_run.checkpoint_requested`/`checkpoint_cleared` (§2) carry `WorkflowRun.awaiting_checkpoint`. System state stays `idle`/`discovering` regardless (DDR-031). |
| DDR-026 | Sharding approval is a `checkpoint` step like any other | `action.required` with `action_type: 'sharding_approval'` is emitted. `approval.required` with `gate: 'sharding_review'` is also emitted for backward compatibility. |
| G5a | Consolidated event catalogue | This document. All WebSocket events from SLE-005, SLE-012, SLE-022 in one reference. |
| G36 | `action.required` event for human action panel | §4.4 defines the full payload with action types, priorities, and available responses. |
| DDR-031 | Workflow run generalization | §2 replaces all cycle/DAG-scoped events with workflow-run-scoped equivalents (`workflow_run.*`, `step.*`). Events carry `run_id` instead of `cycle`/`cycle_id` throughout, since N runs may be active concurrently. |
