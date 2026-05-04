# DAG Execution

**Type:** spec · **Status:** draft · **Updated:** 2026-04-22
**Depends on:** DDR-019, DDR-020, DDR-021, DDR-022, DDR-023, DDR-025, DDR-026
**Source material:** SLE-002 (full rewrite), SLE-024 §5

## Overview

This document specifies the DAG (directed acyclic graph) that governs every
development cycle. The DAG defines the exact sequence of nodes the daemon
executes, the conditions under which nodes are skipped or repeated, the two
decision gates where control flow diverges, and the data that flows between
nodes.

A cycle begins when the user starts a cycle (`sle start`) and ends when
either a validated snapshot is locked (success) or the cycle halts with a
partial report (failure, cap, or user abort). Between those two endpoints, the
daemon walks the DAG node by node, pausing at human checkpoints and looping on
validation failure.

The DAG is the core coordination mechanism. Everything else in the system —
context assembly, artifact storage, agent invocation, validation — exists to
serve the DAG's progression from node to node.

**Canonical types:** [../reference/types.md](../reference/types.md).
**State machine:** [state-machine.md](state-machine.md).
**DDR decisions:** [../decisions/DECISION-BRIEFS.md](../decisions/DECISION-BRIEFS.md).

---

## Data model

### DAG nodes

```
enum DAGNode {
  SCOPING           = 'SCOPING',
  DESIGN            = 'DESIGN',
  CRITIQUE          = 'CRITIQUE',
  PLAN              = 'PLAN',
  TEST              = 'TEST',
  SHARDING_APPROVAL = 'SHARDING_APPROVAL',
  CONFIRM           = 'CONFIRM',
  BUILD             = 'BUILD',
  HISTORY           = 'HISTORY',
  EXEC              = 'EXEC',
  VALIDATION_GATE   = 'VALIDATION_GATE',
  DEBUG             = 'DEBUG',
  EVALUATE          = 'EVALUATE',
  SUMMARISE         = 'SUMMARISE',
  SNAPSHOT          = 'SNAPSHOT',
}
```

15 nodes total. DDR-028: INTENT, CONTEXT_ASSEMBLY, EXPLORE replaced by SCOPING.

Full type definition: `DAGNode` in [../reference/types.md](../reference/types.md) §4.

### DAG state

```
interface DAGState {
  current:          DAGNode
  iteration:        number
  max_iterations:   number
  started_at:       string
  history:          DAGEvent[]
}
```

Tracked in `map.yaml → cycle.dag`. Updated atomically when the daemon
transitions between nodes.

### DAG event

```
interface DAGEvent {
  node:      DAGNode
  type:      'enter' | 'exit' | 'error' | 'skip'
  timestamp: string
  data?:     unknown
}
```

Appended to `DAGState.history` on every node transition. The history is the
complete execution trace of the cycle. It is not pruned within a cycle.

### Counters

| Counter | Field | Increments when | Resets when |
|---|---|---|---|
| **Iteration** | `cycle.iteration` | VALIDATION_GATE fails | New cycle |
| **Revision** | `cycle.revision` | User modifies plan at CONFIRM | New iteration |

Revisions happen within a single iteration. Iterations span the full BUILD →
EXEC → VALIDATION_GATE arc. See §Iteration rules for detail.

### Cycle record flags

| Flag | Set when | Cleared when |
|---|---|---|
| `cycle.awaiting_scoping` | SCOPING node waiting for user input | User provides input or max rounds exceeded |
| `cycle.awaiting_confirmation` | CONFIRM gate reached | User approves, modifies, or halts |
| `cycle.awaiting_sharding_approval` | Planner produces sharding proposal | User approves or rejects the proposal |

All flags are boolean fields on the cycle record in `map.yaml`. They do not
change `meta.status` (remains `cycling`). At most one is `true` at a time.

See [state-machine.md](state-machine.md) §Intra-cycle transitions for the
flag transition table.

### Artifact references

All artifact slice references use typed prefixes (DDR-025):

| Prefix | Scope | Example | Resolution |
|---|---|---|---|
| `doc:{key}` | Project-level document | `doc:requirements`, `doc:architecture` | `.sle/project-docs/` |
| `node:{group}:{key}` | Group-level node | `node:rate-limiting:architecture` | `.sle/project-graph/layers/` |

### Run artifacts

Produced during EXEC and consumed by DEBUG. Stored under `.sle/runs/{id}/`:

| Path | Produced by | Consumed by |
|---|---|---|
| `manifest.json` | Daemon (gate node) | Context manager, Debugger |
| `ai/context-pack.md` | Daemon (gate node) | Debugger, Planner (via context) |
| `tests/{category}/result.json` | EXEC scripts | Gate node, context-pack generator |
| `metrics/*.json` | EXEC scripts | Context-pack generator |
| `traces/*.jsonl` | EXEC scripts | Context-pack generator |
| `logs/{service}.log` | EXEC scripts | Context-pack generator |

---

## Behavior

### DAG flow diagram

```
SCOPING (Facilitator-led, guided discussion)
  │  Input: tagged nodes/layers + scope draft (if any) + existing artifacts
  │  Output: doc:cycle-charter
  │  User interaction: Facilitator guides structured discussion
  │  awaiting_scoping flag: set when waiting for user input
  │
  ▼
DESIGN (Designer agent)
  │  Input: cycle-charter + existing architecture/requirements
  │  Output: doc:architecture, doc:requirements
  │
  ▼
CRITIQUE (conditional — depth: deep | research only)
  │  Reviews DESIGN output
  │
  ▼
PLAN (Planner agent)
  │  Input: charter + architecture + requirements + decisions
  │  Output: doc:plan, doc:test-plan (doc:build-plan at deep/research)
  │
  ▼
TEST → [SHARDING_APPROVAL] → CONFIRM → BUILD → HISTORY → EXEC
  │
  ▼
VALIDATION_GATE
  ├── PASS → EVALUATE → SUMMARISE → SNAPSHOT → complete
  └── FAIL → DEBUG → PLAN → ... (iteration loop)
```

### Happy path (no conditionals triggered)

```
SCOPING → DESIGN → PLAN → TEST → CONFIRM → BUILD
→ HISTORY → EXEC → VALIDATION_GATE → EVALUATE → SUMMARISE → SNAPSHOT
```

### Full path with all conditionals

```
SCOPING → DESIGN → CRITIQUE → PLAN → TEST
→ SHARDING_APPROVAL → CONFIRM → BUILD → HISTORY → EXEC → VALIDATION_GATE
→ (fail) → DEBUG → PLAN → TEST → CONFIRM → BUILD → HISTORY → EXEC
→ VALIDATION_GATE → (pass) → EVALUATE → SUMMARISE → SNAPSHOT
```

---

## Node definitions

All 15 DAG nodes are defined with their layer, agent role, inputs, outputs, success criteria, and failure handling in [dag-node-reference.md](dag-node-reference.md).

---

## Iteration rules

### Iteration lifecycle

A single cycle may run multiple iterations before the VALIDATION gate passes.
Each iteration may include multiple revision rounds at the CONFIRM gate.

```
iteration 1:
  PLAN → TEST → [SHARDING_APPROVAL] → CONFIRM
    ├── approve → BUILD → HISTORY → EXEC → VALIDATION_GATE
    │                                       FAIL
    └── modify → TEST → CONFIRM (revision loop)
                                         ↓
                                   iteration 2:
                                     DEBUG → PLAN → TEST → CONFIRM → BUILD
                                     → HISTORY → EXEC → VALIDATION_GATE
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
| decisions.md | Historian appends a new entry |
| map.yaml | Updated after every gate decision |
| Passing categories | NOT retested — results cached from previous iteration |

The context manager enforces category caching. On retry, the Planner's slice
includes only the failed categories' context. Passing categories retain their
`CategoryResult` from the previous iteration.

### What changes between revisions (within one iteration)

| What | How |
|---|---|
| Plan steps | Modified per user's `PlanModification` payload |
| Test scripts | Regenerated against modified plan (affected categories only) |
| Revision counter | Incremented on each revise cycle |
| Iteration counter | NOT incremented |

### Iteration loop boundaries

The iteration loop starts at PLAN (not DESIGN). Architecture and requirements
are not re-derived unless the Debugger flags a structural failure as a
blocking issue. In that case, the daemon may loop back to DESIGN — this is
the only scenario where the iteration loop extends above PLAN.

**Structural failure escalation:**

```
if Debugger.FailureReport contains a blocking issue tagged 'structural':
  loop back to DESIGN (Designer revises architecture + requirements)
else:
  loop back to PLAN (Planner adjusts plan + test-plan)
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
| `halt_with_report` | Halt. No snapshot. Partial report written. |
| `user_prompt` | Pause. Ask user: continue (reset cap) or halt? |
| `force_pass` | Lock snapshot anyway. Not recommended. |

---

## Human checkpoints

### Overview

The DAG has three human checkpoints. All use the same mechanism: a boolean
flag on the cycle record, with the Facilitator operating in decision mode.

```
SCOPING → ... → PLAN → TEST → SHARDING_APPROVAL → CONFIRM → BUILD → ...
  flag 0                    flag 1              flag 2
(scoping)               (sharding)          (plan approval)
```

At most one flag is `true` at a time. The system does not prompt for scoping,
sharding approval, and plan confirmation concurrently.

### Checkpoint 0 — SCOPING

**Flag:** `cycle.awaiting_scoping`

**When:** SCOPING node is active and waiting for user input during guided discussion.

**Presented by:** Facilitator in scoping mode.

**User reviews:**

- Scope — what is included and excluded from this cycle
- Purpose — what the cycle aims to achieve
- Requirements — what must be satisfied
- Boundaries — what is explicitly deferred
- Version bump — whether the inferred semver bump is correct

**Actions:**

| Action | Effect |
|---|---|
| Provide input | Facilitator processes input, continues discussion |
| Approve charter | `awaiting_scoping = false`, charter produced, proceed to DESIGN |
| Halt | Cycle halts (meta.status → halted) |

**DDR reference:** DDR-028

### Checkpoint 1 — Sharding approval

**Flag:** `cycle.awaiting_sharding_approval`

**When:** After PLAN produces a sharding proposal (only if Planner's
analysis determined the work benefits from task decomposition).

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

**Flag:** `cycle.awaiting_confirmation`

**When:** After TEST completes, before BUILD begins.

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
| Halt | Cycle halts (meta.status → halted) |

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

**DDR reference:** DDR-021, DDR-020 (Facilitator decision mode)

---

## API contract

### Start cycle

```
POST /api/v2/cycles

Request:
{
  "scope_draft_id":  string | null,
  "version_bump":    'major' | 'minor' | 'patch' | null,
  "quick_start_goal": string | null,
  "depth_override":  PlanningDepth | null,
  "category_hints":  string[] | null
}

Response 201:
{
  "cycle_id":    string,
  "dag_state":   DAGState,
  "started_at":  string
}

Response 409:
{
  "error":  "session_conflict",
  "state":  SystemStatus,
  "reason": "A session is already active. Halt or complete before starting."
}

Response 403:
{
  "error":  "discovery_required",
  "reason": "Run 'sle discover' first, or use --force to bypass."
}
```

### Get cycle state

```
GET /api/v2/cycles/{cycle_id}

Response 200:
{
  "cycle_id":     string,
  "number":       number,
  "iteration":    number,
  "revision":     number,
  "outcome":      CycleOutcome,
  "dag_state":    DAGState,
  "flags": {
    "awaiting_scoping":             boolean,
    "awaiting_confirmation":        boolean,
    "awaiting_sharding_approval":   boolean
  },
  "started_at":   string,
  "completed_at": string | null
}

Response 404:
{
  "error": "cycle_not_found"
}
```

### Revise plan at CONFIRM gate

```
POST /api/v2/cycles/{cycle_id}/revise

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
  "cycle_id":  string,
  "revision":  number,
  "affected_categories": string[],
  "dag_state": DAGState
}

Response 409:
{
  "error":  "not_awaiting_confirmation",
  "reason": "CONFIRM gate is not active for this cycle."
}
```

### Approve at gate

```
POST /api/v2/cycles/{cycle_id}/approve

Response 200:
{
  "cycle_id":  string,
  "dag_state": DAGState
}

Response 409:
{
  "error":  "not_awaiting_confirmation",
  "reason": "No gate is awaiting approval for this cycle."
}
```

### Halt cycle

```
POST /api/v2/cycles/{cycle_id}/halt

Response 200:
{
  "cycle_id":   string,
  "outcome":    "halted",
  "partial_report": {
    "iterations_used":   number,
    "failed_categories": string[],
    "last_gate_result":  GateResult | null
  }
}

Response 409:
{
  "error":  "halt_not_cycling",
  "state":  SystemStatus,
  "reason": "Can only halt a cycling session."
}
```

### Sharding approval actions

```
POST /api/v2/cycles/{cycle_id}/sharding/approve

Response 200:
{
  "cycle_id":    string,
  "tasks_created": number
}

POST /api/v2/cycles/{cycle_id}/sharding/reject

Response 200:
{
  "cycle_id": string
}

POST /api/v2/cycles/{cycle_id}/sharding/modify

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
  "cycle_id": string,
  "proposal": ShardingProposal
}
```

### WebSocket events

```
event: node.started
{
  "cycle_id":  string,
  "node":      DAGNode,
  "iteration": number,
  "revision":  number,
  "timestamp": string
}

event: node.completed
{
  "cycle_id":  string,
  "node":      DAGNode,
  "outcome":   "completed" | "skipped" | "failed",
  "duration_ms": number,
  "timestamp": string
}

event: gate.result
{
  "cycle_id":    string,
  "gate":        "VALIDATION_GATE",
  "passed":      boolean,
  "failed_categories": string[],
  "iteration":   number,
  "timestamp":   string
}

event: dag.confirm_requested
{
  "cycle_id":  string,
  "revision":  number,
  "plan_summary": {
    "step_count":      number,
    "test_count":      number,
    "coverage_pct":    number
  },
  "timestamp": string
}

event: dag.sharding_requested
{
  "cycle_id":     string,
  "task_count":   number,
  "timestamp":    string
}

event: dag.snapshot_locked
{
  "cycle_id":   string,
  "version_id": string,
  "timestamp":  string
}
```

Full event catalogue: [../reference/websocket-events.md](../reference/websocket-events.md).

---

## Error cases

### Node-level errors

| Error | Node | Condition | Response |
|---|---|---|---|
| `scoping_timeout` | SCOPING | Max rounds exceeded (`planning.yaml → scoping.max_rounds`) | 409 with scoping state |
| `charter_validation_failed` | SCOPING | Charter missing required fields (scope, purpose) | Halt cycle (unrecoverable) |
| `discovery_required` | SCOPING | No discovery, no `--force` | 403 with message |
| `agent_timeout` | Any L3 node | Agent call exceeds timeout | Retry once, then halt |
| `agent_empty_output` | DESIGN, PLAN, TEST, BUILD | Agent produced empty/invalid output | Retry once, then halt |
| `llm_provider_error` | Any L3 node | Provider returns 5xx or rate limit | Retry with backoff (3 attempts), then halt |
| `docker_unavailable` | EXEC | Docker daemon not running | Halt cycle (unrecoverable) |
| `test_script_invalid` | TEST, BUILD | Generated script has syntax errors | Retry once, then halt |
| `snapshot_commit_failed` | SNAPSHOT | Remote unavailable | Write local, retry push in background |
| `debugger_no_diagnosis` | DEBUG | Debugger cannot produce root cause | Generate minimal FailureReport, proceed |

### Gate-level errors

| Error | Condition | Response |
|---|---|---|
| `invalid_transition` | State transition not in table | 409 with allowed transitions |
| `flag_conflict` | Both awaiting flags set simultaneously | 409 |
| `not_awaiting_confirmation` | Revise/approve when no CONFIRM gate active | 409 |
| `revision_on_halted` | Attempt to revise a halted cycle | 409 |

### Cap behaviors

| `on_cap_hit` value | Effect |
|---|---|
| `halt_with_report` | Write partial report, halt, no snapshot |
| `user_prompt` | Pause, ask user to continue or halt |
| `force_pass` | Lock snapshot despite failures (not recommended) |

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

1. **No concurrent cycles.** Only one cycle may be active at a time. `active_cycle_id` is singular.

2. **No concurrent sessions.** `sle start` is rejected when `meta.status ≠ idle`.

3. **Designer ownership.** Only the Designer writes `architecture.md` and `requirements.md`. All other roles read these files (DDR-019).

4. **Planner ownership.** Only the Planner writes `plan.md`, `test-plan.md`, and `build-plan.md` (deep/research only) (DDR-019).

5. **TDD separation.** The Tester never sees the Builder's implementation or the architecture. It writes tests from requirements only.

6. **Builder separation.** The Builder never sees the Tester's internal reasoning — only the final test scripts as a contract to satisfy.

7. **Critic placement.** The Critic reviews at the DESIGN node, not the PLAN node (DDR-022). It reviews architecture + requirements, not the plan or test-plan.

8. **SCOPING is always first.** SCOPING is the first DAG node in every cycle. It must produce `doc:cycle-charter` before DESIGN can start.

9. **Deterministic gate.** The VALIDATION gate is a pure function of category results. No LLM, no user input, no external services.

10. **Flag exclusivity.** At most one of `awaiting_scoping`, `awaiting_confirmation`, and `awaiting_sharding_approval` may be `true` at a time.

11. **Flag scope.** All flags are scoped to the active cycle. They reset to `false` when the cycle ends.

12. **Category caching.** Passing categories are never re-run on retry. Their `CategoryResult` is preserved across iterations.

13. **Iteration cap enforcement.** Retry (transition T4 in state-machine.md) is only valid when `iteration < max_iterations`. Cap hit triggers halt (T6).

14. **Revision counter scope.** The revision counter resets to 0 at the start of each iteration. It increments only on CONFIRM gate modification.

15. **Append-only decisions.** `decisions.md` is never overwritten or truncated. Entries are preserved across all iterations and cycles.

16. **Context budget.** Each agent call targets under 3,500 tokens. Truncated slices are recorded in `AssembledContext.truncated`.

17. **Artifact reference format.** All artifact references use typed prefixes: `doc:{key}` or `node:{group}:{key}` (DDR-025).

18. **Sharding before CONFIRM.** Sharding approval is a separate checkpoint that runs before the CONFIRM gate, not embedded within it (DDR-026).

19. **Iteration loop starts at PLAN.** On retry, the loop goes to PLAN (or DESIGN if structural failure). The charter from SCOPING is not re-derived.

20. **awaiting_scoping follows flag exclusivity.** `awaiting_scoping` follows the same exclusivity pattern as `awaiting_confirmation` — at most one flag is true at a time.

---

## Open questions

| ID | Question | Impact | Status |
|---|---|---|---|
| DAG-001 | Should the structural failure escalation (DEBUG → DESIGN) require user confirmation, or is automatic escalation acceptable? | User control vs. cycle autonomy | Open |
| DAG-002 | What is the maximum number of revision rounds allowed within a single iteration before the system forces a decision? | Resource bounding, UX | Open |
| DAG-003 | How should the system behave if the user modifies plan steps at CONFIRM and the Tester cannot generate tests for the modified plan? | Error handling in revision flow | Open |
| DAG-004 | Should the Critic's pass limit be configurable per planning depth, or is the hardcoded formula (`reasoning_passes - 1`) sufficient? | Flexibility vs. simplicity | Open |
| DAG-005 | What happens to the sharding proposal if the user modifies plan steps at CONFIRM after approving sharding? | Cross-checkpoint consistency | Open |
| DAG-006 | Should DAG history be persisted across daemon restarts, or regenerated from `map.yaml` state? | Recovery behavior | Open |
| DAG-007 | Is there a maximum wall-clock time for a single cycle (regardless of iteration count)? | Resource management | Open |
| DAG-008 | Should the EVALUATE node's verdict influence the VALIDATION gate's pass/fail decision, or is it purely informational? | Gate semantics | Open |
| DAG-010 | What is the expected behavior when `force_pass` is configured and the cycle produces obviously broken output? | Safety guardrails | Open |

> **Note (DDR-028):** Any remaining references to INTENT, CONTEXT_ASSEMBLY, or EXPLORE are historical. These nodes were replaced by SCOPING.
