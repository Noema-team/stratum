# DAG Node Reference

**Type:** spec · **Status:** draft · **Updated:** 2026-04-17
**Parent:** [dag-execution.md](dag-execution.md)
**Depends on:** [types.md](types.md), [dag-execution.md](dag-execution.md)
**Source material:** SLE-002 (split from dag-execution.md)

## Overview

This spec is the per-node reference for all 15 DAG nodes that make up one cycle
iteration. Nodes span four layers — L1 (Interface), L2 (Daemon), L3 (Agent
Runtime), and L4 (Execution Plane) — and are executed in strict sequence by the
daemon's DAG runner. Each node definition specifies its layer, agent role,
conditional activation rules, inputs, outputs, success criteria, and failure
handling. For flow diagrams, iteration rules, retry semantics, and the overall
API contracts, see the parent spec [dag-execution.md](dag-execution.md).

DDR-028: INTENT, CONTEXT_ASSEMBLY, and EXPLORE replaced by SCOPING (node 1). Any
remaining references to the old nodes are historical.

## Data model

The canonical `DAGNode` enum is defined in [types.md](types.md) §5. All 15
values, in execution order:

| # | Node | Conditional? | Activation condition |
|---|------|-------------|----------------------|
| 1 | `SCOPING` | No | — |
| 2 | `DESIGN` | No | — |
| 3 | `CRITIQUE` | Yes | `planning.depth` is `deep` or `research` |
| 4 | `PLAN` | No | — |
| 5 | `TEST` | No | — |
| 6 | `SHARDING_APPROVAL` | Yes | Planner produced a sharding proposal (DDR-026) |
| 7 | `CONFIRM` | Yes | `user_validation.yaml → approval_required` is true |
| 8 | `BUILD` | No | — |
| 9 | `HISTORY` | No | — |
| 10 | `EXEC` | No | — |
| 11 | `VALIDATION_GATE` | No | — |
| 12 | `DEBUG` | Yes | VALIDATION_GATE outcome is fail |
| 13 | `EVALUATE` | No | — |
| 14 | `SUMMARISE` | No | — |
| 15 | `SNAPSHOT` | No | — |

Six nodes are conditional. When a conditional node is skipped, the daemon
advances to the next node without incrementing the iteration counter.

## Node definitions

### Node 1 — SCOPING

| Field | Value |
|-------|-------|
| **Layer** | L1 — Scoping |
| **Agent role** | Facilitator (scoping mode) |
| **Conditional** | No |
| **User checkpoint** | Yes — guided discussion, max rounds configurable |
| **DDR** | DDR-028 |

**Purpose.** First node in every cycle. Replaces the former INTENT → CONTEXT_ASSEMBLY → EXPLORE sequence. The Facilitator guides the user through a structured discussion to produce a formal `doc:cycle-charter`.

**Inputs:**
- Tagged nodes/layers (all `#next-cycle` tagged elements)
- `doc:cycle-scope-draft` (if created during pre-cycle chat)
- Existing project artifacts (architecture, requirements, decisions)
- `quick_start_goal` (if cycle started via `sle start "goal"` — auto-generates minimal scope)

**Process:**
1. Load tagged nodes/layers and scope draft into context
2. Facilitator switches to 'scoping' mode
3. Guided discussion: scope, purpose, requirements, boundaries, deferred items
4. Facilitator infers `version_bump` from scope/purpose (patch default, minor for features, major for rewrites)
5. User can override version_bump during discussion
6. Max rounds: configurable via `planning.yaml → scoping.max_rounds` (default 5, hard cap 10)
7. On max rounds exceeded: cycle halts with `scoping_timeout` error

**Outputs:**
- `doc:cycle-charter` — formal scope document (scope, purpose, requirements, boundaries, version_bump, deferred items)

**`awaiting_scoping` flag:** Set to true when waiting for user input during discussion. Follows same exclusivity pattern as `awaiting_confirmation`.

**Skip conditions:**
- If `quick_start_goal` is provided: SCOPING runs with minimal context, auto-generates charter from goal string, skips guided discussion. Charter is produced immediately.
- SCOPING cannot be fully skipped — charter is required for DESIGN.

**Error conditions:**
- `scoping_timeout` — max rounds exceeded
- `charter_validation_failed` — charter missing required fields (scope, purpose)

---

### Node 2 — DESIGN

| Field | Value |
|---|---|
| **Layer** | L3 (Agent Runtime) |
| **Agent role** | Designer |
| **Conditional** | No |
| **Inputs** | `doc:cycle-charter` from SCOPING + discovery docs + prior architecture + decisions |
| **Outputs** | `architecture.md`, `requirements.md` |

The Designer is the sole owner of `architecture.md` and `requirements.md`
(DDR-019). No other role writes these files. The Designer reads the cycle
charter, discovery documents, and existing project artifacts.

At `minimal` depth, the Designer runs one reasoning pass. At `standard`, two
passes (draft + self-review). At `deep` and `research`, the Designer produces
an initial draft, then the Critic reviews it (see Node 3 — CRITIQUE).

Artifact references:
- Reads: `doc:product-brief`, `doc:system-description`, `doc:constraints`, `doc:vision`, `doc:open-questions`, `doc:decisions` (last 3 entries)
- Writes: `doc:architecture`, `doc:requirements`

**Success criteria:** Both `architecture.md` and `requirements.md` are written
and pass structural validation (non-empty, correct format). Requirements
include section-level references that the Tester and Planner can consume.

**Failure handling:** If the Designer cannot produce coherent output (empty or
structurally invalid), the node errors. The cycle retries once if
`exit.yaml → on_error → behavior = retry_once`, otherwise halts.

---

### Node 3 — CRITIQUE

| Field | Value |
|---|---|
| **Layer** | L3 (Agent Runtime) |
| **Agent role** | Critic |
| **Conditional** | Yes — `planning.depth` is `deep` or `research` only |
| **Inputs** | `architecture.md` + `requirements.md` + project context + decisions |
| **Outputs** | Structured critique fed back to Designer as `doc:cycle-critique` (run-scoped). At `deep`/`research` depth, also writes `doc:critique-report` (project-scoped) for persistent design review. |

The Critic reviews the Designer's output at the DESIGN node — **not** at the
PLAN node (DDR-022). It does not modify artifacts directly. It produces a
critique object that the daemon injects into the Designer's next reasoning
pass.

```
interface CritiqueResult {
  blocking_issues:  string[]
  warnings:         string[]
  suggestions:      string[]
  pass:             boolean
}
```

**Activation rule:**

```
depth = minimal | standard → skip CRITIQUE, proceed to PLAN
depth = deep                → 1 Critic pass after Designer
depth = research            → multiple Critic passes (up to pass limit)
```

**Pass limit:** The Critic loop runs at most `reasoning_passes[depth] - 1`
times. At `deep`, one Critic pass. At `research`, up to 3 passes. If blocking
issues persist after the limit, the Critic's warnings are logged and the cycle
proceeds — the Critic does not block indefinitely.

**Feedback loop:**

```
Designer draft → Critic → blocking issues found → Designer revises
→ Critic re-reviews → ... → all clear (or pass limit) → proceed to PLAN
```

The Critic reads `doc:architecture` and `doc:evaluation` (prior cycle).

**Success criteria:** `CritiqueResult.pass = true` OR pass limit reached. All
blocking issues resolved or explicitly carried forward as warnings.

**Failure handling:** If the Critic itself errors (LLM failure), the cycle
proceeds without critique — a warning is logged. The Critic is advisory, not
blocking, at the system level.

---

### Node 4 — PLAN

| Field | Value |
|---|---|
| **Layer** | L3 (Agent Runtime) |
| **Agent role** | Planner |
| **Conditional** | No |
| **Inputs** | `doc:cycle-charter` + `architecture.md` + `requirements.md` + decisions (last 3 entries) + evaluation (last cycle) + FailureReport (iteration > 1) |
| **Outputs** | `plan.md`, `test-plan.md`, `build-plan.md` (deep/research only), sharding proposal (conditional) |

The Planner reads the cycle charter and the Designer's output, then produces
step-level implementation instructions and a test-plan (DDR-019). It does not
write `requirements.md` or `architecture.md`.

Artifact references:
- Reads: `doc:cycle-charter`, `doc:architecture`, `doc:requirements`, `doc:decisions`, `doc:evaluation`
- Writes: `doc:plan`, `doc:test-plan`, `doc:build-plan` (deep/research only)

**Sharding proposal (conditional):**

The Planner may produce a sharding proposal alongside the plan if its own
analysis determines the work benefits from task decomposition. The proposal
is reviewed at the SHARDING_APPROVAL node (DDR-026).

```
interface ShardingProposal {
  tasks: {
    title:                string
    description:          string
    context_declarations: ArtifactRef[]
    acceptance_criteria:  string[]
    dependencies:         string[]
  }[]
}
```

**On retry iterations (iteration > 1):**

The Planner receives the `FailureReport` from the Debugger. It rewrites only
the sections of `plan.md` and `test-plan.md` relevant to the failed categories.
It does not start from scratch. The context manager enforces this by including
only failed category slices in the Planner's artifact window.

**Category recommendations:** The Planner emits a `categories` block in
`test-plan.md` listing the validation categories it recommends. These become
candidates for user confirmation at the CONFIRM gate.

**Success criteria:** `plan.md` and `test-plan.md` written. Plan includes
numbered steps with clear descriptions. Test-plan includes per-category
coverage mapping with requirement references.

**Failure handling:** If the Planner cannot produce a plan (e.g., requirements
are incoherent), the node errors. On retry, the Debugger's FailureReport
provides context for the Planner to adjust.

**Depth note:** At `deep`/`research` depth, the Planner additionally produces
`doc:build-plan` — implementation expansion deriving 1:1 from `doc:plan`.

---

### Node 5 — TEST

| Field | Value |
|---|---|
| **Layer** | L3 (Agent Runtime) |
| **Agent role** | Tester |
| **Conditional** | No |
| **Inputs** | `requirements.md` + `test-plan.md` |
| **Outputs** | Executable test scripts (one per active validation category) |

The Tester writes test scripts from requirements only. It never sees the
architecture or the Builder's implementation — this is the TDD separation.

Test scripts are:
- Written to `scripts/test_{category}.ts` (or `.sh` for simpler categories)
- Self-contained — no LLM calls, no daemon calls
- Structured JSON output to stdout
- Runnable independently: `npx ts-node scripts/test_correctness.ts`

Artifact references:
- Reads: `doc:requirements`, `doc:test-plan`
- Writes: `scripts/test_{category}.ts`

**Success criteria:** One test script per active validation category. Each
script is syntactically valid and produces the expected JSON schema on a dry
run. Test-plan coverage mapping is complete — every requirement has at least
one test.

**Failure handling:** If a test script fails dry-run validation, the Tester
retries that script once. If it still fails, the node errors and the cycle
halts (unrecoverable — cannot validate without test scripts).

---

### Node 6 — SHARDING_APPROVAL

| Field | Value |
|---|---|
| **Layer** | L1+L2 (Interface + Daemon) |
| **Agent role** | Facilitator (decision mode) |
| **Conditional** | Yes — only when Planner produced a sharding proposal (DDR-026) |
| **Inputs** | Sharding proposal from Planner |
| **Outputs** | Approved or rejected proposal |

Sharding approval is a separate human checkpoint before the CONFIRM gate
(DDR-026). It validates task boundaries, context declarations, and dependencies
before the user reviews the plan and tests.

**Activation rule:**

```
if sharding_proposal exists → set awaiting_sharding_approval = true
else → skip, proceed to CONFIRM
```

**Flag behavior:**

| Action | Flag state | Effect |
|---|---|---|
| Approve | `awaiting_sharding_approval = false` | Proceed to CONFIRM. Beads tasks created, link index updated. |
| Reject | `awaiting_sharding_approval = false` | Proceed to CONFIRM without sharding. Planner re-plans without split. |
| Modify | Flag stays `true` | Proposal revised and re-presented. |

The Facilitator operates in decision mode during this node — structured
actions (approve/reject/modify) rather than freeform Q&A. The user can ask
clarifying questions via chat (which remains available in all states per
DDR-020) before deciding.

**Success criteria:** User has approved or rejected the proposal.
`awaiting_sharding_approval = false`.

**Failure handling:** Timeout behavior governed by
`user_validation.yaml → on_timeout`. No iteration increment — this is a
pause, not a retry.

---

### Node 7 — CONFIRM

| Field | Value |
|---|---|
| **Layer** | L1+L2 (Interface + Daemon) |
| **Agent role** | Facilitator (decision mode) |
| **Conditional** | Configurable via `user_validation.yaml → approval_required` |
| **Inputs** | Plan steps + test suite + requirement coverage mapping + sharding status |
| **Outputs** | Approved or modified plan. `revision` counter may increment. |

The primary human checkpoint (DDR-021). The daemon pauses the DAG and pushes
a confirmation request to all connected interfaces. `meta.status` remains
`cycling`. `cycle.awaiting_confirmation = true`.

**What the user sees:**

Note: User sees `doc:plan` steps only. `doc:build-plan` is never presented at CONFIRM.

1. Proposed plan steps with descriptions and constraints
2. Test suite with requirement coverage mapping
3. Per-category test criteria
4. Sharding status (approved / not proposed)
5. Revision counter (how many times the plan has been revised in this iteration)

**User actions:**

| Action | Flag state | Effect |
|---|---|---|
| Approve | `awaiting_confirmation = false` | Proceed to BUILD |
| Modify plan steps | Flag stays `true` | `revision++`, DAG resumes at TEST for re-derivation |
| Modify test criteria | Flag stays `true` | Criteria updated. No TEST re-run. Re-present at CONFIRM. |
| Halt | `awaiting_confirmation = false` | Cycle halts (meta.status → halted) |

**Modification payload:**

```
POST /api/v2/cycles/{cycle_id}/revise

interface PlanModification {
  steps?: {
    add?:    { description: string; after_step?: string; constraints?: string[] }[]
    remove?: { step_id: string; reason?: string }[]
    reorder?: { step_id: string; new_position: number }[]
    edit?:   { step_id: string; description?: string; constraints?: string[] }[]
  }
  test_criteria?: {
    test_id:        string
    new_assertions: string[]
  }[]
}
```

**Re-derivation rule:** Plan step modifications trigger re-run of the TEST
phase. The Tester regenerates test scripts against the modified plan.
Unchanged categories keep cached test results — only categories affected by
the modification are regenerated. Test criteria-only changes skip
re-generation.

**Revision loop:**

```
CONFIRM (modify) → TEST (re-derive affected) → CONFIRM (re-present)
     └── modify again → TEST → CONFIRM (repeat until approve or halt)
```

Multiple revision rounds are allowed within one iteration. The revision
counter is visible in the CONFIRM prompt. The iteration counter is NOT
incremented by revisions.

**Skip condition:** If `user_validation.yaml → approval_required: false`,
this node is skipped. The DAG proceeds directly from TEST to BUILD.
`awaiting_confirmation` is never set.

**Success criteria:** User approves. `awaiting_confirmation = false`.

**Failure handling:** Timeout governed by `user_validation.yaml → timeout_minutes`
and `on_timeout` action. Halt action triggers transition to `halted`.

---

### Node 8 — BUILD

| Field | Value |
|---|---|
| **Layer** | L3 (Agent Runtime) |
| **Agent role** | Builder |
| **Conditional** | No |
| **Inputs** | `requirements.md` + `architecture.md` + confirmed plan + test-plan + `build-plan` (deep/research only) |
| **Outputs** | Implementation code + one executable test script per active category |

The Builder reads the confirmed plan, architecture, and test-plan. It produces
implementation code and instrumented test scripts for each active validation
category.

Artifact references:
- Reads: `doc:requirements`, `doc:architecture`, `doc:plan`, `doc:test-plan`, `doc:build-plan` (deep/research only)
- Writes: Implementation files, `scripts/test_{category}.ts`

The Builder does not run the tests. It produces them for the EXEC node. Test
scripts are self-contained (no LLM, no daemon, structured JSON output).

**On retry iterations:** The Builder regenerates from scratch — it does not
patch the previous iteration's output. However, the context manager limits
its slice to failed-category-relevant content only.

**Success criteria:** Implementation code written. One test script per active
category. All scripts produce valid JSON on a dry run.

**Failure handling:** If the Builder produces invalid code (syntax errors in
generated scripts), the node errors. The cycle retries if within iteration cap.

---

### Node 9 — HISTORY

| Field | Value |
|---|---|
| **Layer** | L3 (Agent Runtime) |
| **Agent role** | Historian |
| **Conditional** | No |
| **Inputs** | `decisions.md` (full file, append target) |
| **Outputs** | 2–3 sentence entry appended to `decisions.md` |

The Historian runs after BUILD (and conceptually after every agent turn). It
appends a structured entry to `decisions.md`, which is `append_only: true` —
the system never overwrites or deletes entries.

Entry format:

```
## {ISO timestamp} — cycle {n}, iteration {i}, {node_name}

{What was done this turn. Why (key decision or constraint). What changed.}
```

Artifact references:
- Reads: `doc:decisions` (full)
- Writes: `doc:decisions` (append)

**Success criteria:** Entry appended. File still valid markdown.

**Failure handling:** If the append fails (file locked, disk full), log a
warning and proceed. `decisions.md` is important but not blocking — the cycle
continues and the entry is reconstructed from DAG history.

---

### Node 10 — EXEC

| Field | Value |
|---|---|
| **Layer** | L4 (Execution Plane) |
| **Agent role** | None (generated scripts in Docker) |
| **Conditional** | No |
| **Inputs** | Confirmed categories, generated test scripts, implementation code |
| **Outputs** | `CategoryResult[]` — one per active category |

All categories run in parallel. Within each category, three sub-phases execute
in order:

| Sub-phase | Layer | LLM? | What it checks | Fail effect |
|---|---|---|---|---|
| `static-check` | L4 (Docker) | No | Lint, typecheck, complexity | Skip remaining sub-phases |
| `llm-check` | L3 | Yes | Semantic correctness | Mark category as failed |
| `exec-check` | L4 (Docker) | No | Functional correctness — run test scripts | Mark category as failed |

`static-check` runs first. If it fails for a category, `llm-check` and
`exec-check` are skipped for that category.

```
interface CategoryResult {
  name:       string
  method:     ValidationMethod
  llm?: {
    verdict:    'pass' | 'fail'
    confidence: number
    issues:     string[]
    evidence:   string[]
  }
  executable?: {
    passed:        boolean
    passed_cases:  string[]
    failed_cases:  string[]
    errors:        string[]
    metrics:       Record<string, number>
  }
  passed: boolean
}
```

Run artifacts are written to `.sle/runs/{run_id}/` for consumption by DEBUG.

**Success criteria:** All sub-phases complete for all categories. Each
`CategoryResult` has a definitive `passed: boolean`.

**Failure handling:** Individual sub-phase failures are recorded in the
`CategoryResult` — they do not crash the node. EXEC always completes for all
categories. Node-level failure (e.g., Docker unavailable) triggers halt.

---

### Node 11 — VALIDATION_GATE

| Field | Value |
|---|---|
| **Layer** | L2 (Daemon) |
| **Agent role** | None (deterministic) |
| **Conditional** | No |
| **Inputs** | `CategoryResult[]` from all active categories |
| **Outputs** | `GateResult` — pass or fail |

The VALIDATION gate is implemented in the daemon — no LLM involvement. It
applies deterministic boolean logic: all active categories must pass.

```
interface GateResult {
  passed:            boolean
  categories:        CategoryResult[]
  failed_categories: string[]
  failure_report?:   FailureReport
}
```

**On PASS:**

1. Write `validation.gate.last_outcome: passed` to `map.yaml`
2. Clear `validation.gate.failed_categories`
3. Proceed to EVALUATE

**On FAIL:**

1. Write `validation.gate.last_outcome: failed` to `map.yaml`
2. Populate `validation.gate.failed_categories`
3. Proceed to DEBUG (which produces `FailureReport`)
4. Increment `iteration`
5. Check `iteration ≥ max_iterations`
   - Cap not hit → proceed to PLAN (iteration loop)
   - Cap hit → execute `exit.yaml → on_cap_hit` behavior → HALT

**Success criteria:** Gate decision made. `GateResult` produced.

**Failure handling:** This node does not fail — it is pure logic. If category
results are malformed, the node errors and the cycle halts (unrecoverable).

---

### Node 12 — DEBUG

| Field | Value |
|---|---|
| **Layer** | L3 (Agent Runtime) |
| **Agent role** | Debugger |
| **Conditional** | Yes — only when VALIDATION_GATE fails |
| **Inputs** | Run artifacts (manifest + context-pack) + failed category slices |
| **Outputs** | Diagnosis injected into Planner context (uses FailureReport from gate) |

The Debugger is the first role to read run artifacts after a gate failure. It
diagnoses — it does not plan or build. Its output feeds the next PLAN node.

```
interface FailureReport {
  cycle:              number
  iteration:          number
  run_dir:            string
  run_id:             string
  quick_summary:      string
  failed_categories:  string[]
  passed_categories:  string[]
}
```

See types.md §6.2 for the canonical definition. The Debugger reads run artifacts
from `run_dir` to produce its diagnosis.

Artifact references:
- Reads: run artifacts from `.sle/runs/{id}/`
- Writes: `doc:debug-diagnosis` (ephemeral — resolved from daemon state, not disk) and `FailureReport` (ephemeral)

**Success criteria:** Diagnosis produced for each failed category in the
FailureReport, with root causes derived from run artifacts.

**Failure handling:** If the Debugger cannot produce a diagnosis, the
FailureReport from the gate is passed to the Planner as-is. The cycle still
proceeds to PLAN — the Planner works with whatever diagnostic information
is available.

---

### Node 13 — EVALUATE

| Field | Value |
|---|---|
| **Layer** | L3 (Agent Runtime) |
| **Agent role** | Evaluator |
| **Conditional** | No |
| **Inputs** | `requirements.md` + `evaluation.md` (prior) + `test-plan.md` + run artifacts |
| **Outputs** | Structured verdict: did the implementation satisfy the original intent? |

The Evaluator produces `evaluation.md` — a structured assessment of whether
the implementation met the user's intent. This document feeds into the next
cycle's Planner and Critic.

Artifact references:
- Reads: `doc:requirements`, `doc:evaluation`, `doc:test-plan`
- Writes: `doc:evaluation`

**Success criteria:** `evaluation.md` written. Includes verdict (satisfied /
partially satisfied / not satisfied), evidence per requirement, and
recommendations for the next cycle.

**Failure handling:** If the Evaluator errors, the cycle still proceeds to
SUMMARISE. A placeholder evaluation is generated from the category results.

---

### Node 14 — SUMMARISE

| Field | Value |
|---|---|
| **Layer** | L3+L2 (Agent content + Daemon formatting) |
| **Agent role** | None (daemon formats, LLM generates content) |
| **Conditional** | No |
| **Inputs** | `decisions.md` delta + category results + generated artifacts config |
| **Outputs** | User-facing summary + generated report artifacts |

Produces three generated artifacts (configured in `artifacts.yaml`):

| Artifact | Format | Description |
|---|---|---|
| `reports/validation-latest.html` | HTML | Per-category results table with verdicts and confidence |
| `scripts/run-tests.ts` | TypeScript | Aggregated test runner for independent verification |
| `reports/changelog-{version}.md` | Markdown | Digest of decisions.md entries from this cycle |

Summary sections (configured in `summary.yaml`):

1. **What was built** — from decisions.md delta
2. **What changed** — artifact-level diff from previous version
3. **Category results** — per-category pass/fail with confidence scores
4. **How to test** — shell commands for each test script
5. **Next steps** — suggestions for the next cycle

**Pause point:** If `user_validation.yaml → review_at` includes
`after_gate_pass`, the daemon pauses here before SNAPSHOT. Otherwise, proceeds
directly.

**Success criteria:** Summary generated. All three report artifacts written.

**Failure handling:** If report generation fails, a minimal text summary is
produced. The cycle still proceeds to SNAPSHOT — reports are best-effort.

---

### Node 15 — SNAPSHOT

| Field | Value |
|---|---|
| **Layer** | L2 (Daemon) |
| **Agent role** | None (daemon operation) |
| **Conditional** | No |
| **Inputs** | All artifacts, generated outputs, summary, evaluation |
| **Outputs** | Locked version entry in `map.yaml` |

The terminal node. It:

1. Assigns the next `version_id` (semver, auto-incremented)
2. Writes final state to `map.yaml`
3. Commits `map.yaml` + `decisions.md` + `docs/` to the docs remote
4. Commits generated scripts to the code remote
5. Sets `meta.status → complete`
6. `complete → idle` transition follows automatically (see state-machine.md T9)

```
interface VersionSnapshot {
  version_id:       string
  cycle:            number
  iteration:        number
  revision:         number
  locked_at:        string
  artifact_hashes:  Record<string, string>
  category_results: CategoryResult[]
  outcome:          'completed' | 'halted'
  version_bump:     'major' | 'minor' | 'patch'  // DDR-028 SC-014
  deployable:       boolean                       // DDR-028 SC-014
  changed_nodes:    string[]                      // DDR-028 SC-014 D3
}
```

Does NOT commit if `exit.yaml → halt_behavior → block_version_snapshot: true`
and outcome is `halted`. (This code path only applies if SNAPSHOT is reached
via a `force_pass` override.)

After snapshot, `map.yaml → meta.status` transitions to `complete`, then
immediately to `idle`.

**Success criteria:** Version locked. Artifacts committed. State transitioned
to `complete`.

**Failure handling:** If commit fails (remote unavailable), the snapshot is
written locally and the commit is retried. The cycle is still considered
complete — the snapshot exists in `map.yaml`. A background process handles
the push.

## Constraints

These constraints apply across multiple nodes and are stated here as a
consolidated reference to avoid repetition in individual node definitions.

1. **Single active cycle.** Only one cycle is active at a time. SCOPING rejects
   with 409 `session_conflict` if `meta.status ≠ idle`. The daemon enforces
   this at L2.
2. **TDD separation (Tester vs Builder).** The Tester never sees architecture
   or implementation. The Builder never sees Tester reasoning. They share only
   `requirements.md` and `test-plan.md`. This separation is enforced by the
   context manager's artifact slicing.
3. **Designer ownership.** The Designer is the sole writer of `architecture.md`
   and `requirements.md` (DDR-019). No other role modifies these artifacts.
4. **Critic is advisory, not blocking.** If the Critic cannot resolve all
   blocking issues within the pass limit, the cycle proceeds with warnings.
   The Critic never halts the DAG at the system level.
5. **Revision ≠ iteration.** Plan modifications at the CONFIRM gate increment
   the `revision` counter, not the `iteration` counter. The iteration counter
   increments only on VALIDATION_GATE failure.
6. **SCOPING is always first.** SCOPING is the first DAG node in every cycle.
   It must produce `doc:cycle-charter` before DESIGN can start.
7. **VALIDATION_GATE is deterministic.** No LLM involvement. Pure boolean
   logic: all active categories must pass. The daemon applies this at L2.
8. **History is non-blocking.** If the Historian cannot append to `decisions.md`,
   the cycle continues. The entry is reconstructed from DAG history.
9. **Context budget cap.** Every agent call receives at most 3,500 tokens in its
   assembled context. The context manager truncates slices as needed and records
   what was truncated.

## Open questions

No open questions specific to individual node definitions. See
[dag-execution.md](dag-execution.md) for DAG-level open questions including
iteration cap defaults, Critic pass-limit tuning, and the Historian's long-term
role (structured logging vs append-only markdown).

