# Workflow Execution

**Type:** spec · **Status:** draft · **Updated:** 2026-06-21
**Depends on:** DDR-019, DDR-020, DDR-021, DDR-022, DDR-023, DDR-025, DDR-026, DDR-031
**Source material:** SLE-002 (full rewrite), SLE-024 §5; merges former dag-execution.md
**Supersedes:** dag-execution.md (deleted — content merged here and into step-kind-reference.md)

## Overview

This document specifies how the daemon executes a **workflow run** — one
instance of a `WorkflowDefinition` walking its step graph. Every unit of
work in the system, from a one-artifact `draft-artifact` run to the full
build-test-review pipeline (`full-build`), is a workflow run governed by the
same six-step-kind execution model (DDR-031).

A workflow run begins when the user (or the chat router) dispatches
`POST /api/v2/workflow-runs` and ends when either a `commit` step locks a
result (success) or the run halts with a partial report (failure, cap, or
user abort). Between those two endpoints, the daemon walks the run's step
graph step by step, pausing at `checkpoint` steps and looping on `review`
failure via `on_fail` routing.

Workflow execution is the core coordination mechanism. Everything else in
the system — context assembly, artifact storage, agent invocation,
validation — exists to serve a run's progression from step to step. Unlike
the former single fixed DAG, multiple workflow runs may be **active
concurrently**, as long as they don't claim the same artifact (DDR-031,
"Concurrency: artifact-level claims, not project-wide locking").

**Canonical types:** [../reference/types.md](../reference/types.md).
**State machine:** [state-machine.md](state-machine.md).
**Step kind reference:** [step-kind-reference.md](step-kind-reference.md).
**Authoring new workflows:** [workflow-authoring.md](workflow-authoring.md).
**DDR decisions:** [../decisions/ddr-031-workflow-generalization.md](../decisions/ddr-031-workflow-generalization.md).

---

## Data model

### Step kinds

```
type StepKind = 'gather' | 'produce' | 'review' | 'checkpoint' | 'execute' | 'commit'
```

Six generic kinds replace the former 15-value `DAGNode` enum. A
`WorkflowDefinition` composes any number of step instances of these six
kinds into a directed graph. `full-build`, the built-in workflow that
reproduces today's fixed pipeline, uses 14 step instances (SCOPING's
checkpoint decomposes into 3, HISTORY folds into a `commit`'s
`logs_decision` flag rather than its own step) — see
[step-kind-reference.md](step-kind-reference.md) for the full mapping.

Full type definitions: `StepKind`, `WorkflowStep`, `WorkflowDefinition` in
[../reference/types.md](../reference/types.md) §4.

### Workflow run state

```
interface WorkflowRun {
  run_id:              string
  workflow_id:         string
  target:              { group?: string; layer?: string; node_key?: string }
  status:              'active' | 'halted' | 'complete'
  current_step_id:     string
  iteration:           number
  revision:            number
  awaiting_checkpoint:  string | null
  claimed_artifacts:   ArtifactClaim[]
  started_at:          string
  updated_at:          string
}
```

Tracked in `map.yaml → workflow_runs.{run_id}`. Updated atomically when the
daemon transitions between steps. Replaces the former singular
`cycle.dag` — there is no longer one project-wide DAG state, only N
independent `WorkflowRun` records, one per active run.

### Step event

```
interface DAGEvent {
  node:      string      // step_id
  type:      'enter' | 'exit' | 'error' | 'skip'
  timestamp: string
  data?:     unknown
}
```

Appended to a per-run history array on every step transition. The history is
the complete execution trace of that run. It is not pruned within a run.

### Counters

| Counter | Field | Increments when | Resets when |
|---|---|---|---|
| **Iteration** | `WorkflowRun.iteration` | `full-build`'s validation `review` step fails | New workflow run |
| **Revision** | `WorkflowRun.revision` | User modifies plan at the CONFIRM `checkpoint` step | New iteration |

Revisions happen within a single iteration. In `full-build`, iterations span
the full BUILD → EXEC → VALIDATION_GATE arc, reframed as the build `produce`
→ `execute` → validation `review` arc. See §Iteration rules for detail.
Iteration/revision counters are a `full-build`-specific convention used by
its `review` steps' `on_fail` routing — other workflows are not required to
use them, but may.

### Checkpoint pointer

```
WorkflowRun.awaiting_checkpoint: string | null
```

Replaces the former three boolean cycle flags (`awaiting_scoping`,
`awaiting_confirmation`, `awaiting_sharding_approval`) with a single
nullable pointer to the `step_id` of the `checkpoint` step currently
pausing the run, or `null` if none. Since any workflow may declare any
number of `checkpoint` steps, a fixed enum of flags no longer fits — the
nullable pointer preserves the old exclusivity rule (at most one pause point
active per run) by construction, not by convention.

`WorkflowRun.awaiting_checkpoint` does not change `meta.status`, which
remains `idle | discovering` project-wide regardless of how many runs are
paused (DDR-031).

See [state-machine.md](state-machine.md) §Per-run transitions for the
checkpoint transition table.

### Artifact references

All artifact slice references use typed prefixes (DDR-025), unchanged by
this generalization:

| Prefix | Scope | Example | Resolution |
|---|---|---|---|
| `doc:{key}` | Project-level document | `doc:requirements`, `doc:architecture` | `.sle/project-docs/` |
| `node:{group}:{key}` | Group-level node | `node:rate-limiting:architecture` | `.sle/project-graph/layers/` |

### Run artifacts

Produced during `execute` steps and consumed by the failure-path `produce`
step (the `full-build`-specific role formerly called DEBUG). Stored under
`.sle/runs/{id}/`:

| Path | Produced by | Consumed by |
|---|---|---|
| `manifest.json` | Daemon (review step) | Context manager, Debugger |
| `ai/context-pack.md` | Daemon (review step) | Debugger, Planner (via context) |
| `tests/{category}/result.json` | `execute` step scripts | Review step, context-pack generator |
| `metrics/*.json` | `execute` step scripts | Context-pack generator |
| `traces/*.jsonl` | `execute` step scripts | Context-pack generator |
| `logs/{service}.log` | `execute` step scripts | Context-pack generator |

---

## Behavior

### Generic step flow

```
gather       — assemble context, no artifact produced
  │
  ▼
produce      — LLM-driven artifact generation
  │
  ▼
review       — pass/fail evaluation; on_fail routes to a named produce step
  │
  ├── pass → next step
  └── fail → on_fail.target_step_id (produce), or halt at iteration cap
  │
checkpoint   — pause for human input; sets awaiting_checkpoint, then clears it
  │
execute      — run code/tests; non-LLM, deterministic
  │
commit       — write + version-bump + claim-release; optional logs_decision
```

A `WorkflowDefinition` wires these six kinds into whatever graph its
authoring document declares (see
[workflow-authoring.md](workflow-authoring.md)). The only universal rules
are: a `review` step's `on_fail` target must be a `produce` step in the same
workflow; a `commit` step releases every artifact claim it acquired; a
`checkpoint` step is the only kind that can set `awaiting_checkpoint`.

### `full-build`'s step flow (worked example)

```
gather → produce → checkpoint   (SCOPING, decomposed — produces doc:cycle-charter)
  │
  ▼
produce (DESIGN, Designer role)
  │
  ▼
review (CRITIQUE, conditional — depth: deep | research only)
  │  on_fail → DESIGN's produce step
  │
  ▼
produce (PLAN, Planner role — also the iteration-retry entry point)
  │
  ▼
produce (TEST, Tester role)
  │
  ▼
checkpoint (SHARDING_APPROVAL, conditional)
  │
  ▼
checkpoint (CONFIRM, optional per user_validation.yaml)
  │
  ▼
produce (BUILD, Builder role)
  │
  ▼
execute (EXEC, non-LLM test runner)
  │
  ▼
review (VALIDATION_GATE)
  ├── pass → produce (EVALUATE) → produce (SUMMARISE) → commit (SNAPSHOT, logs_decision: true)
  └── fail → produce (DEBUG, failure path) → PLAN's produce step (iteration loop)
              or a halt-report commit at the iteration cap
```

`full-build` is the canonical worked example that proves the six step kinds
are sufficient to reproduce today's entire pipeline behaviorally unchanged.
Its exact step-by-step definitions are in
[step-kind-reference.md](step-kind-reference.md).

### Happy path (no conditionals triggered)

```
SCOPING → DESIGN → PLAN → TEST → CONFIRM → BUILD
→ EXEC → VALIDATION_GATE → EVALUATE → SUMMARISE → SNAPSHOT
```

(Names retained here as informal labels for `full-build`'s step instances;
HISTORY no longer appears as a separate stop — it is the `logs_decision:
true` side effect of the SNAPSHOT commit.)

### Full path with all conditionals

```
SCOPING → DESIGN → CRITIQUE → PLAN → TEST
→ SHARDING_APPROVAL → CONFIRM → BUILD → EXEC → VALIDATION_GATE
→ (fail) → DEBUG → PLAN → TEST → CONFIRM → BUILD → EXEC
→ VALIDATION_GATE → (pass) → EVALUATE → SUMMARISE → SNAPSHOT
```

---

## Step definitions

All of `full-build`'s step instances are defined with their layer, agent
role, inputs, outputs, success criteria, and failure handling in
[step-kind-reference.md](step-kind-reference.md).

---

## Iteration rules

### Iteration lifecycle

A single `full-build` run may run multiple iterations before its validation
`review` step passes. Each iteration may include multiple revision rounds at
the CONFIRM checkpoint.

```
iteration 1:
  PLAN → TEST → [SHARDING_APPROVAL] → CONFIRM
    ├── approve → BUILD → EXEC → VALIDATION_GATE
    │                             FAIL
    └── modify → TEST → CONFIRM (revision loop)
                                   ↓
                             iteration 2:
                               DEBUG → PLAN → TEST → CONFIRM → BUILD
                               → EXEC → VALIDATION_GATE
                                   FAIL
                                   ↓
                             ... (repeat until PASS or cap)

iteration N (cap reached):
  VALIDATION_GATE FAIL → HALT
```

### What changes between iterations

| What | How |
|---|---|
| Planner artifact slice | Includes FailureReport + failed category slices only |
| Builder output | Regenerated from scratch (not patched) |
| Tester output | Regenerated from scratch |
| decisions.md | Appended via the next commit step's `logs_decision` |
| map.yaml | `WorkflowRun` updated after every step transition |
| Passing categories | NOT retested — results cached from previous iteration |

The context manager enforces category caching. On retry, the Planner's slice
includes only the failed categories' context. Passing categories retain
their `CategoryResult` from the previous iteration.

### What changes between revisions (within one iteration)

| What | How |
|---|---|
| Plan steps | Modified per user's `PlanModification` payload |
| Test scripts | Regenerated against modified plan (affected categories only) |
| Revision counter | Incremented on each revise cycle |
| Iteration counter | NOT incremented |

### Iteration loop boundaries

The iteration loop starts at PLAN's `produce` step (not DESIGN's). Architecture
and requirements are not re-derived unless the Debugger flags a structural
failure as a blocking issue. In that case, the daemon may loop back to
DESIGN's `produce` step — this is the only scenario where the iteration loop
extends above PLAN.

**Structural failure escalation:**

```
if Debugger.FailureReport contains a blocking issue tagged 'structural':
  loop back to DESIGN's produce step (Designer revises architecture + requirements)
else:
  loop back to PLAN's produce step (Planner adjusts plan + test-plan)
```

This escalation is rare. It increments the iteration counter normally. The
Designer receives the Debugger's structural diagnosis alongside the normal
FailureReport.

### Iteration cap

Configured in `planning.yaml → max_iterations`. When the cap is reached:

1. Write partial report with cap-exceeded notice
2. Preserve `decisions.md` entries from all iterations
3. Execute `exit.yaml → on_cap_hit` behavior:

| Behavior | Effect |
|---|---|
| `halt_with_report` | Halt run. No commit. Partial report written. |
| `user_prompt` | Pause. Ask user: continue (reset cap) or halt? |
| `force_pass` | Commit anyway. Not recommended. |

---

## Human checkpoints

### Overview

`full-build` declares three `checkpoint` steps. All use the same mechanism:
`WorkflowRun.awaiting_checkpoint` is set to the paused step's id, with the
Facilitator operating in decision mode.

```
SCOPING → ... → PLAN → TEST → SHARDING_APPROVAL → CONFIRM → BUILD → ...
 checkpoint                    checkpoint          checkpoint
 (scoping)                     (sharding)          (plan approval)
```

Only one checkpoint per run can be active at a time — `awaiting_checkpoint`
is a single nullable pointer, not a set, so this is true by construction.
Other workflow runs' checkpoints are entirely independent: two different
runs may each have their own `awaiting_checkpoint` set concurrently, since
each run carries its own `WorkflowRun` record.

### Checkpoint 0 — SCOPING

**Pointer value:** the SCOPING `checkpoint` step's id (e.g. `scoping.checkpoint`).

**When:** the SCOPING `gather`→`produce`→`checkpoint` sequence reaches its
checkpoint step, waiting for user input during guided discussion.

**Presented by:** Facilitator in scoping mode.

**User reviews:**

- Scope — what is included and excluded from this run
- Purpose — what the run aims to achieve
- Requirements — what must be satisfied
- Boundaries — what is explicitly deferred
- Version bump — whether the inferred semver bump is correct

**Actions:**

| Action | Effect |
|---|---|
| Provide input | Facilitator processes input, continues discussion |
| Approve charter | `awaiting_checkpoint = null`, charter produced, proceed to DESIGN |
| Halt | Run halts (`WorkflowRun.status → 'halted'`) |

**DDR reference:** DDR-028, DDR-031

### Checkpoint 1 — Sharding approval

**Pointer value:** the SHARDING_APPROVAL `checkpoint` step's id.

**When:** After PLAN's `produce` step emits a sharding proposal (only if the
Planner's analysis determined the work benefits from task decomposition).

**Presented by:** Facilitator in decision mode.

**User reviews:**

- Task boundaries — are the proposed tasks the right granularity?
- Context declarations — does each task reference the right document sections?
- Dependencies — are task dependencies correct?

**Actions:**

| Action | Effect |
|---|---|
| Approve | Create Beads tasks, update link index, proceed to CONFIRM |
| Reject | Proceed to CONFIRM without sharding. Planner re-plans without split. |
| Modify | Revise proposal, re-present at SHARDING_APPROVAL |

**DDR reference:** DDR-026

### Checkpoint 2 — CONFIRM gate

**Pointer value:** the CONFIRM `checkpoint` step's id.

**When:** After TEST's `produce` step completes, before BUILD's `produce`
step begins.

**Presented by:** Facilitator in decision mode.

**User reviews:**

- Plan steps — what will be built, in what order
- Test coverage — which requirements are covered by which tests
- Test criteria — acceptance criteria for each test
- Revision count — how many times the plan has been revised

**Actions:**

| Action | Effect |
|---|---|
| Approve | Proceed to BUILD |
| Modify plan steps | `revision++` → TEST (re-derive affected tests) → CONFIRM |
| Modify test criteria | Update criteria → CONFIRM (no TEST re-run) |
| Halt | Run halts (`WorkflowRun.status → 'halted'`) |

**Revision flow:**

```
CONFIRM (modify plan steps)
  │
  ▼
TEST
  │  Regenerate test scripts for affected categories only.
  │  Unchanged categories keep cached results.
  │
  ▼
CONFIRM (re-present)
  │  Revision counter visible in prompt.
  │  User can approve, modify again, or halt.
  │
  └── modify → TEST → CONFIRM (repeat)
```

**DDR reference:** DDR-021, DDR-020 (Facilitator decision mode), DDR-031

---

## API contract

### Start a workflow run

```
POST /api/v2/workflow-runs

Request:
{
  "workflow_id":     string,                      // defaults to "full-build"
  "target":          { "group"?: string; "layer"?: string; "node_key"?: string } | null,
  "scope_draft_id":  string | null,
  "version_bump":    'major' | 'minor' | 'patch' | null,
  "quick_start_goal": string | null,
  "depth_override":  PlanningDepth | null,
  "category_hints":  string[] | null
}

Response 201:
{
  "run_id":      string,
  "workflow_id": string,
  "current_step_id": string,
  "started_at":  string
}

Response 409:
{
  "error":  "claim_conflict",
  "conflicting_run_id": string,
  "artifact_ref": string,
  "reason": "This artifact is already claimed by an active workflow run."
}

Response 403:
{
  "error":  "discovery_required",
  "reason": "Run 'sle discover' first, or use --force to bypass."
}
```

Unlike the former single-cycle model, this endpoint does not return 409
`session_conflict` for unrelated work — only for an actual artifact claim
conflict. Multiple workflow runs may be active project-wide at once.

### Get workflow run state

```
GET /api/v2/workflow-runs/{run_id}

Response 200:
{
  "run_id":       string,
  "workflow_id":  string,
  "iteration":    number,
  "revision":     number,
  "status":       'active' | 'halted' | 'complete',
  "current_step_id": string,
  "awaiting_checkpoint": string | null,
  "claimed_artifacts": ArtifactClaim[],
  "started_at":   string,
  "completed_at": string | null
}

Response 404:
{
  "error": "run_not_found"
}
```

### Revise plan at CONFIRM checkpoint

```
POST /api/v2/workflow-runs/{run_id}/revise

Request:
{
  "steps": {
    "add":     [{ "description": string, "after_step": string, "constraints": string[] }] | null,
    "remove":  [{ "step_id": string, "reason": string }] | null,
    "reorder": [{ "step_id": string, "new_position": number }] | null,
    "edit":    [{ "step_id": string, "description": string, "constraints": string[] }] | null
  } | null,
  "test_criteria": [{ "test_id": string, "new_assertions": string[] }] | null
}

Response 200:
{
  "run_id":    string,
  "revision":  number,
  "affected_categories": string[],
  "current_step_id": string
}

Response 409:
{
  "error":  "not_awaiting_checkpoint",
  "reason": "The CONFIRM checkpoint is not active for this run."
}
```

### Approve at checkpoint

```
POST /api/v2/workflow-runs/{run_id}/approve

Response 200:
{
  "run_id":    string,
  "current_step_id": string
}

Response 409:
{
  "error":  "not_awaiting_checkpoint",
  "reason": "No checkpoint is awaiting approval for this run."
}
```

### Halt workflow run

```
POST /api/v2/workflow-runs/{run_id}/halt

Response 200:
{
  "run_id":   string,
  "status":   "halted",
  "partial_report": {
    "iterations_used":   number,
    "failed_categories": string[],
    "last_gate_result":  GateResult | null
  }
}

Response 409:
{
  "error":  "halt_not_active",
  "status":  "halted" | "complete",
  "reason": "Can only halt an active workflow run."
}
```

### Sharding approval actions

```
POST /api/v2/workflow-runs/{run_id}/sharding/approve

Response 200:
{
  "run_id":    string,
  "tasks_created": number
}

POST /api/v2/workflow-runs/{run_id}/sharding/reject

Response 200:
{
  "run_id": string
}

POST /api/v2/workflow-runs/{run_id}/sharding/modify

Request:
{
  "tasks": {
    "add":    [{ "title": string, "description": string, "context_declarations": ArtifactRef[] }] | null,
    "remove": [{ "task_index": number }] | null,
    "edit":   [{ "task_index": number, "title": string, "description": string }] | null
  }
}

Response 200:
{
  "run_id": string,
  "proposal": ShardingProposal
}
```

### WebSocket events

```
event: workflow_run.started
{
  "run_id":      string,
  "workflow_id": string,
  "target":      { "group"?: string; "layer"?: string; "node_key"?: string } | null,
  "goal":        string,
  "depth":       'minimal' | 'standard' | 'deep' | 'research',
  "max_iterations": number,
  "timestamp":   string
}

event: workflow_run.completed
{
  "run_id":      string,
  "version_id":  string,
  "summary_path": string,
  "iterations_used": number,
  "categories_validated": string[],
  "timestamp":   string
}

event: workflow_run.halted
{
  "run_id":   string,
  "reason":   'user_halt' | 'max_iterations' | 'error' | 'crash',
  "iteration": number,
  "report_path": string,
  "message"?: string,
  "timestamp": string
}

event: workflow_run.iteration_started
{
  "run_id":    string,
  "iteration": number,
  "failure_context_present": boolean,
  "timestamp": string
}

event: step.started
{
  "run_id":    string,
  "workflow_id": string,
  "step_id":   string,
  "kind":      StepKind,
  "iteration": number,
  "revision":  number,
  "timestamp": string
}

event: step.completed
{
  "run_id":    string,
  "step_id":   string,
  "outcome":   "completed" | "skipped" | "failed",
  "duration_ms": number,
  "timestamp": string
}

event: gate.result
{
  "run_id":      string,
  "step_id":     string,           // the review step, e.g. "validation_gate"
  "passed":      boolean,
  "failed_categories": string[],
  "iteration":   number,
  "timestamp":   string
}

event: workflow_run.checkpoint_requested
{
  "run_id":    string,
  "step_id":   string,
  "revision":  number,
  "plan_summary"?: {
    "step_count":      number,
    "test_count":      number,
    "coverage_pct":    number
  },
  "timestamp": string
}

event: workflow_run.checkpoint_cleared
{
  "run_id":   string,
  "step_id":  string,
  "timestamp": string
}

event: workflow_run.committed
{
  "run_id":     string,
  "version_id": string,
  "timestamp":  string
}
```

Full event catalogue: [../reference/websocket-events.md](../reference/websocket-events.md).

---

## Error cases

### Step-level errors

| Error | Step | Condition | Response |
|---|---|---|---|
| `scoping_timeout` | SCOPING checkpoint | Max rounds exceeded (`planning.yaml → scoping.max_rounds`) | 409 with scoping state |
| `charter_validation_failed` | SCOPING produce | Charter missing required fields (scope, purpose) | Halt run (unrecoverable) |
| `discovery_required` | SCOPING gather | No discovery, no `--force` | 403 with message |
| `agent_timeout` | Any `produce` step | Agent call exceeds timeout | Retry once, then halt |
| `agent_empty_output` | DESIGN, PLAN, TEST, BUILD `produce` steps | Agent produced empty/invalid output | Retry once, then halt |
| `llm_provider_error` | Any `produce`/`review` step | Provider returns 5xx or rate limit | Retry with backoff (3 attempts), then halt |
| `docker_unavailable` | EXEC `execute` step | Docker daemon not running | Halt run (unrecoverable) |
| `test_script_invalid` | TEST, BUILD `produce` steps | Generated script has syntax errors | Retry once, then halt |
| `commit_failed` | SNAPSHOT `commit` step | Remote unavailable | Write local, retry push in background |
| `debugger_no_diagnosis` | DEBUG `produce` step (failure path) | Debugger cannot produce root cause | Generate minimal FailureReport, proceed |

### Checkpoint/review-level errors

| Error | Condition | Response |
|---|---|---|
| `invalid_transition` | Step transition not in the workflow's declared graph | 409 with allowed transitions |
| `claim_conflict` | A different active run already claims the target artifact | 409 at dispatch, not retried |
| `stale_claim_commit` | Artifact version changed since claim was acquired | Halt run, no auto-retry |
| `not_awaiting_checkpoint` | Revise/approve when no checkpoint is active | 409 |
| `revision_on_halted` | Attempt to revise a halted run | 409 |

### Cap behaviors

| `on_cap_hit` value | Effect |
|---|---|
| `halt_with_report` | Write partial report, halt, no commit |
| `user_prompt` | Pause, ask user to continue or halt |
| `force_pass` | Commit despite failures (not recommended) |

### Error configuration

Error behavior is configured in `exit.yaml`:

```
interface ExitConfig {
  on_cap_hit: CapBehavior
  on_error: {
    behavior:      ErrorBehavior
    write_error_report:  boolean
    block_version_snapshot: boolean
  }
  halt_behavior: {
    write_partial_report:    boolean
    notify_user:             boolean
    block_version_snapshot:  boolean
    preserve_decisions:      boolean
  }
}
```

Full type: `ExitConfig` in [../reference/types.md](../reference/types.md) §8.2.

---

## Constraints

1. **Concurrent runs allowed.** Multiple workflow runs may be active
   project-wide at once. The only contention rule is artifact-level claims
   (DDR-031) — unrelated runs never block each other.

2. **No project-wide session lock.** `meta.status` no longer gates whether a
   new run can start; only an artifact claim conflict does.

3. **Designer ownership.** Only the Designer writes `architecture.md` and
   `requirements.md`. All other roles read these files (DDR-019).

4. **Planner ownership.** Only the Planner writes `plan.md`, `test-plan.md`,
   and `build-plan.md` (deep/research only) (DDR-019).

5. **TDD separation.** The Tester never sees the Builder's implementation or
   the architecture. It writes tests from requirements only.

6. **Builder separation.** The Builder never sees the Tester's internal
   reasoning — only the final test scripts as a contract to satisfy.

7. **Critic placement.** The Critic reviews at DESIGN's `produce` step, not
   PLAN's (DDR-022). It reviews architecture + requirements, not the plan or
   test-plan.

8. **SCOPING is always first in `full-build`.** Its `gather`→`produce`→
   `checkpoint` sequence is the first step group in every `full-build` run.
   It must produce `doc:cycle-charter` before DESIGN can start.

9. **Deterministic gate.** The VALIDATION_GATE `review` step is a pure
   function of category results. No LLM, no user input, no external
   services.

10. **Checkpoint exclusivity.** At most one `checkpoint` step per run may be
    awaiting input at a time — guaranteed structurally by
    `WorkflowRun.awaiting_checkpoint` being a single nullable pointer.

11. **Checkpoint scope.** `awaiting_checkpoint` is scoped to its own run. It
    resets to `null` when the run ends.

12. **Category caching.** Passing categories are never re-run on retry.
    Their `CategoryResult` is preserved across iterations.

13. **Iteration cap enforcement.** Retry is only valid when
    `iteration < max_iterations`. Cap hit triggers halt.

14. **Revision counter scope.** The revision counter resets to 0 at the
    start of each iteration. It increments only on CONFIRM checkpoint
    modification.

15. **Append-only decisions.** `decisions.md` is never overwritten or
    truncated. Entries are preserved across all iterations and runs.

16. **Context budget.** Each agent call targets under 3,500 tokens.
    Truncated slices are recorded in `AssembledContext.truncated`.

17. **Artifact reference format.** All artifact references use typed
    prefixes: `doc:{key}` or `node:{group}:{key}` (DDR-025).

18. **Sharding before CONFIRM.** Sharding approval is a separate checkpoint
    that runs before the CONFIRM checkpoint, not embedded within it
    (DDR-026).

19. **Iteration loop starts at PLAN.** On retry, the loop goes to PLAN's
    `produce` step (or DESIGN's if structural failure). The charter from
    SCOPING is not re-derived.

20. **Claim rejection is immediate, not retried.** A conflicting artifact
    claim at dispatch returns `claim_conflict` immediately — it is never
    retried with backoff (DDR-031), unlike the transient-retry semantics of
    `concurrent_modification`.

---

## Open questions

| ID | Question | Impact | Status |
|---|---|---|---|
| DAG-001 | Should the structural failure escalation (DEBUG → DESIGN) require user confirmation, or is automatic escalation acceptable? | User control vs. run autonomy | Open |
| DAG-002 | What is the maximum number of revision rounds allowed within a single iteration before the system forces a decision? | Resource bounding, UX | Open |
| DAG-003 | How should the system behave if the user modifies plan steps at CONFIRM and the Tester cannot generate tests for the modified plan? | Error handling in revision flow | Open |
| DAG-004 | Should the Critic's pass limit be configurable per planning depth, or is the hardcoded formula (`reasoning_passes - 1`) sufficient? | Flexibility vs. simplicity | Open |
| DAG-005 | What happens to the sharding proposal if the user modifies plan steps at CONFIRM after approving sharding? | Cross-checkpoint consistency | Open |
| DAG-006 | Should run history be persisted across daemon restarts, or regenerated from `map.yaml` state? | Recovery behavior | Open |
| DAG-007 | Is there a maximum wall-clock time for a single workflow run (regardless of iteration count)? | Resource management | Open |
| DAG-008 | Should the EVALUATE step's verdict influence the VALIDATION_GATE review's pass/fail decision, or is it purely informational? | Gate semantics | Open |
| DAG-010 | What is the expected behavior when `force_pass` is configured and the run produces obviously broken output? | Safety guardrails | Open |

> **Note (DDR-028, DDR-031):** Any remaining references to INTENT,
> CONTEXT_ASSEMBLY, EXPLORE, or `DAGNode` are historical. INTENT,
> CONTEXT_ASSEMBLY, and EXPLORE were replaced by SCOPING (DDR-028); the
> 15-value `DAGNode` enum was replaced by the six generic `StepKind` values
> plus `full-build`'s step graph (DDR-031).
