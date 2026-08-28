# Step Kind Reference

**Type:** spec · **Status:** draft · **Updated:** 2026-06-21
**Parent:** [workflow-execution.md](workflow-execution.md)
**Depends on:** [types.md](../reference/types.md), [workflow-execution.md](workflow-execution.md), DDR-031
**Source material:** SLE-002 (split from dag-execution.md); merges former dag-node-reference.md
**Supersedes:** dag-node-reference.md (deleted — content merged here)

## Overview

This spec has two halves:

1. **The six generic step kinds** — `gather`, `produce`, `review`,
   `checkpoint`, `execute`, `commit` — the building blocks every
   `WorkflowDefinition` composes (DDR-031). This is what
   [workflow-authoring.md](workflow-authoring.md) cites when describing what
   a new workflow may declare.
2. **`full-build`'s step instances** — the worked example that proves the
   six kinds are sufficient to reproduce today's entire pipeline
   behaviorally unchanged. These are the same 15 nodes the system has always
   executed, now expressed as step instances of the six kinds, spanning four
   layers — L1 (Interface), L2 (Daemon), L3 (Agent Runtime), and L4
   (Execution Plane).

For flow diagrams, iteration rules, retry semantics, and the overall API
contracts, see the parent spec
[workflow-execution.md](workflow-execution.md).

DDR-028: INTENT, CONTEXT_ASSEMBLY, and EXPLORE replaced by SCOPING (step
group 1). DDR-031: the 15-value `DAGNode` enum replaced by six `StepKind`
values; any remaining references to the old enum name are historical.

## Part 1 — The six step kinds

### Generic shape

Every step instance in every `WorkflowDefinition` is one of:

| Kind | LLM? | Produces an artifact? | Can pause for human input? | Can fail and route elsewhere? |
|---|---|---|---|---|
| `gather` | No | No | No | No |
| `produce` | Yes | Yes | No | No (but may be an `on_fail` target) |
| `review` | Usually no (deterministic where possible) | No (a verdict, not an artifact) | No | Yes — via `on_fail` |
| `checkpoint` | No | No | Yes | No |
| `execute` | No | No (writes run artifacts, not project artifacts) | No | No |
| `commit` | No | Yes (writes + version-bumps) | No | No |

```
interface WorkflowStep {
  id:               string
  kind:             StepKind
  agent_role?:      AgentRole
  prompt_template?: string
  input_context:    ArtifactRef[]
  output_artifact?: ArtifactOutputSpec
  on_fail?:         { action: 'halt' | 'produce'; target_step_id?: string }
  logs_decision?:   boolean
}
```

Full type definitions: `StepKind`, `WorkflowStep`, `WorkflowDefinition` in
[../reference/types.md](../reference/types.md) §4.

### `gather`

Assembles context for a later step — reads existing artifacts, tagged
nodes/layers, or prior run output — and produces nothing of its own. Always
followed by a `produce` or `checkpoint` step that consumes what it
assembled. `full-build`'s SCOPING group's first step is a `gather`.

### `produce`

The LLM-driven workhorse. Invokes an agent role with assembled context and
writes one or more artifacts. Most of `full-build`'s steps (DESIGN, PLAN,
TEST, BUILD, DEBUG, EVALUATE, SUMMARISE, and SCOPING's middle step) are
`produce` steps. A `produce` step may be the `on_fail` target of a `review`
step elsewhere in the same workflow — this is how retry/debug loops are
expressed without a dedicated 7th step kind.

### `review`

A pass/fail evaluation. Deterministic where possible (e.g. `full-build`'s
VALIDATION_GATE is pure boolean logic, no LLM); may also be LLM-assisted
(e.g. `full-build`'s CRITIQUE). On failure, a `review` step's `on_fail`
declares either `{ action: 'halt' }` or `{ action: 'produce', target_step_id }`
— the latter routes the run to a named `produce` step to retry. This single
mechanism replaces what used to be a dedicated DEBUG node: any `review` step
may declare a retry target, `full-build`'s validation gate is simply the one
existing case that uses it.

### `checkpoint`

Pauses the run for human input. Sets `WorkflowRun.awaiting_checkpoint` to
its own step id on entry, clears it to `null` on exit (approve, modify, or
halt). `full-build` declares three: SCOPING's checkpoint, SHARDING_APPROVAL,
and CONFIRM.

### `execute`

Runs code or tests deterministically — no LLM involvement. Writes run
artifacts under `.sle/runs/{id}/` for a later `review` or `produce` step to
consume. `full-build`'s EXEC is the only `execute` step in the built-in
presets, but workflow authors may declare more (e.g. a linter-only
`draft-artifact` variant).

### `commit`

The terminal write: persists artifacts, bumps the relevant version, releases
every artifact claim the run holds, and optionally appends a decision-log
entry via `logs_decision: true`. **HISTORY folds into `commit`** as this
optional side effect rather than remaining its own step — it was already
specified as non-blocking, append-only, "log and proceed" behavior bundled
with a write, never an independently gated stage (DDR-031). `full-build`'s
SNAPSHOT is a `commit` step with `logs_decision: true`.

---

## Part 2 — `full-build`'s step instances

The canonical `StepKind` type and `full-build`'s `WorkflowDefinition` are
defined in [types.md](../reference/types.md) §4. `full-build`'s steps, in
execution order:

| # | Step (informal label) | Kind | Conditional? | Activation condition |
|---|------|------|-------------|----------------------|
| 1a | `SCOPING.gather` | gather | No | — |
| 1b | `SCOPING.produce` | produce | No | — |
| 1c | `SCOPING.checkpoint` | checkpoint | No | — |
| 2 | `DESIGN` | produce | No | — |
| 3 | `CRITIQUE` | review | Yes | `planning.depth` is `deep` or `research` |
| 4 | `PLAN` | produce | No | — |
| 5 | `TEST` | produce | No | — |
| 6 | `SHARDING_APPROVAL` | checkpoint | Yes | Planner produced a sharding proposal (DDR-026) |
| 7 | `CONFIRM` | checkpoint | Yes | `user_validation.yaml → approval_required` is true |
| 8 | `BUILD` | produce | No | — |
| 9 | `EXEC` | execute | No | — |
| 10 | `VALIDATION_GATE` | review | No | — |
| 11 | `DEBUG` | produce (failure path of VALIDATION_GATE) | Yes | VALIDATION_GATE outcome is fail |
| 12 | `EVALUATE` | produce | No | — |
| 13 | `SUMMARISE` | produce | No | — |
| 14 | `SNAPSHOT` | commit (`logs_decision: true`) | No | — |

14 step instances (the former 15-node count, with HISTORY folded into
SNAPSHOT's `logs_decision` flag and SCOPING expanded into 3 explicit steps —
net change of zero standalone gated stages). Six are conditional. When a
conditional step is skipped, the daemon advances to the next step without
incrementing the iteration counter.

## Step definitions

### Step 1 — SCOPING (gather → produce → checkpoint)

| Field | Value |
|-------|-------|
| **Layer** | L1 — Scoping |
| **Agent role** | Facilitator (scoping mode) |
| **Kind** | gather → produce → checkpoint |
| **Conditional** | No |
| **User checkpoint** | Yes — guided discussion, max rounds configurable |
| **DDR** | DDR-028, DDR-031 |

**Purpose.** First step group in every `full-build` run. Replaces the former
INTENT → CONTEXT_ASSEMBLY → EXPLORE sequence. The Facilitator guides the
user through a structured discussion to produce a formal `doc:cycle-charter`.

**Inputs (gather):**
- Tagged nodes/layers (all `#next-run` tagged elements)
- `doc:cycle-scope-draft` (if created during pre-run chat)
- Existing project artifacts (architecture, requirements, decisions)
- `quick_start_goal` (if the run was dispatched via `sle run full-build "goal"`
  — auto-generates minimal scope)

**Process (produce):**
1. Load tagged nodes/layers and scope draft into context
2. Facilitator switches to 'scoping' mode
3. Guided discussion: scope, purpose, requirements, boundaries, deferred items
4. Facilitator infers `version_bump` from scope/purpose (patch default, minor for features, major for rewrites)
5. User can override version_bump during discussion
6. Max rounds: configurable via `planning.yaml → scoping.max_rounds` (default 5, hard cap 10)
7. On max rounds exceeded: run halts with `scoping_timeout` error

**Outputs:**
- `doc:cycle-charter` — formal scope document (scope, purpose, requirements, boundaries, version_bump, deferred items)

**Checkpoint behavior:** `WorkflowRun.awaiting_checkpoint` is set to this
checkpoint step's id when waiting for user input during discussion. Follows
the same exclusivity guarantee as every other checkpoint in the run.

**Skip conditions:**
- If `quick_start_goal` is provided: the gather/produce steps run with
  minimal context, auto-generate the charter from the goal string, and skip
  the checkpoint's guided discussion. Charter is produced immediately.
- The SCOPING group cannot be fully skipped — charter is required for DESIGN.

**Error conditions:**
- `scoping_timeout` — max rounds exceeded
- `charter_validation_failed` — charter missing required fields (scope, purpose)

---

### Step 2 — DESIGN

| Field | Value |
|---|---|
| **Layer** | L3 (Agent Runtime) |
| **Agent role** | Designer |
| **Kind** | produce |
| **Conditional** | No |
| **Inputs** | `doc:cycle-charter` from SCOPING + discovery docs + prior architecture + decisions |
| **Outputs** | `architecture.md`, `requirements.md` |

The Designer is the sole owner of `architecture.md` and `requirements.md`
(DDR-019). No other role writes these files. The Designer reads the run
charter, discovery documents, and existing project artifacts.

At `minimal` depth, the Designer runs one reasoning pass. At `standard`, two
passes (draft + self-review). At `deep` and `research`, the Designer produces
an initial draft, then the Critic reviews it (see Step 3 — CRITIQUE).

Artifact references:
- Reads: `doc:product-brief`, `doc:system-description`, `doc:constraints`, `doc:vision`, `doc:open-questions`, `doc:decisions` (last 3 entries)
- Writes: `doc:architecture`, `doc:requirements`

**Success criteria:** Both `architecture.md` and `requirements.md` are written
and pass structural validation (non-empty, correct format). Requirements
include section-level references that the Tester and Planner can consume.

**Failure handling:** If the Designer cannot produce coherent output (empty or
structurally invalid), the step errors. The run retries once if
`exit.yaml → on_error → behavior = retry_once`, otherwise halts.

---

### Step 3 — CRITIQUE

| Field | Value |
|---|---|
| **Layer** | L3 (Agent Runtime) |
| **Agent role** | Critic |
| **Kind** | review |
| **Conditional** | Yes — `planning.depth` is `deep` or `research` only |
| **Inputs** | `architecture.md` + `requirements.md` + project context + decisions |
| **Outputs** | Structured critique fed back to Designer as `doc:cycle-critique` (run-scoped). At `deep`/`research` depth, also writes `doc:critique-report` (project-scoped) for persistent design review. |
| **`on_fail`** | `{ action: 'produce', target_step_id: 'DESIGN' }` |

The Critic reviews the Designer's output at the DESIGN step — **not** at the
PLAN step (DDR-022). It does not modify artifacts directly. It produces a
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
issues persist after the limit, the Critic's warnings are logged and the run
proceeds — the Critic does not block indefinitely.

**Feedback loop:**

```
Designer draft → Critic → blocking issues found → Designer revises
→ Critic re-reviews → ... → all clear (or pass limit) → proceed to PLAN
```

The Critic reads `doc:architecture` and `doc:evaluation` (prior run).

**Success criteria:** `CritiqueResult.pass = true` OR pass limit reached. All
blocking issues resolved or explicitly carried forward as warnings.

**Failure handling:** If the Critic itself errors (LLM failure), the run
proceeds without critique — a warning is logged. The Critic is advisory, not
blocking, at the system level.

---

### Step 4 — PLAN

| Field | Value |
|---|---|
| **Layer** | L3 (Agent Runtime) |
| **Agent role** | Planner |
| **Kind** | produce |
| **Conditional** | No |
| **Inputs** | `doc:cycle-charter` + `architecture.md` + `requirements.md` + decisions (last 3 entries) + evaluation (last run) + FailureReport (iteration > 1) |
| **Outputs** | `plan.md`, `test-plan.md`, `build-plan.md` (deep/research only), sharding proposal (conditional) |

The Planner reads the run charter and the Designer's output, then produces
step-level implementation instructions and a test-plan (DDR-019). It does not
write `requirements.md` or `architecture.md`. This is also the iteration-retry
entry point — `VALIDATION_GATE`'s `on_fail` and `CRITIQUE`'s structural-failure
escalation both route here (or to DESIGN, in the structural case).

Artifact references:
- Reads: `doc:cycle-charter`, `doc:architecture`, `doc:requirements`, `doc:decisions`, `doc:evaluation`
- Writes: `doc:plan`, `doc:test-plan`, `doc:build-plan` (deep/research only)

**Sharding proposal (conditional):**

The Planner may produce a sharding proposal alongside the plan if its own
analysis determines the work benefits from task decomposition. The proposal
is reviewed at the SHARDING_APPROVAL step (DDR-026).

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
candidates for user confirmation at the CONFIRM checkpoint.

**Success criteria:** `plan.md` and `test-plan.md` written. Plan includes
numbered steps with clear descriptions. Test-plan includes per-category
coverage mapping with requirement references.

**Failure handling:** If the Planner cannot produce a plan (e.g., requirements
are incoherent), the step errors. On retry, the Debugger's FailureReport
provides context for the Planner to adjust.

**Depth note:** At `deep`/`research` depth, the Planner additionally produces
`doc:build-plan` — implementation expansion deriving 1:1 from `doc:plan`.

---

### Step 5 — TEST

| Field | Value |
|---|---|
| **Layer** | L3 (Agent Runtime) |
| **Agent role** | Tester |
| **Kind** | produce |
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
retries that script once. If it still fails, the step errors and the run
halts (unrecoverable — cannot validate without test scripts).

---

### Step 6 — SHARDING_APPROVAL

| Field | Value |
|---|---|
| **Layer** | L1+L2 (Interface + Daemon) |
| **Agent role** | Facilitator (decision mode) |
| **Kind** | checkpoint |
| **Conditional** | Yes — only when Planner produced a sharding proposal (DDR-026) |
| **Inputs** | Sharding proposal from Planner |
| **Outputs** | Approved or rejected proposal |

Sharding approval is a separate human checkpoint before the CONFIRM
checkpoint (DDR-026). It validates task boundaries, context declarations, and
dependencies before the user reviews the plan and tests.

**Activation rule:**

```
if sharding_proposal exists → set awaiting_checkpoint = this step's id
else → skip, proceed to CONFIRM
```

**Checkpoint behavior:**

| Action | Pointer state | Effect |
|---|---|---|
| Approve | `awaiting_checkpoint = null` | Proceed to CONFIRM. Beads tasks created, link index updated. |
| Reject | `awaiting_checkpoint = null` | Proceed to CONFIRM without sharding. Planner re-plans without split. |
| Modify | Pointer stays set to this step | Proposal revised and re-presented. |

The Facilitator operates in decision mode during this step — structured
actions (approve/reject/modify) rather than freeform Q&A. The user can ask
clarifying questions via chat (which remains available in all states per
DDR-020) before deciding.

**Success criteria:** User has approved or rejected the proposal.
`awaiting_checkpoint = null`.

**Failure handling:** Timeout behavior governed by
`user_validation.yaml → on_timeout`. No iteration increment — this is a
pause, not a retry.

---

### Step 7 — CONFIRM

| Field | Value |
|---|---|
| **Layer** | L1+L2 (Interface + Daemon) |
| **Agent role** | Facilitator (decision mode) |
| **Kind** | checkpoint |
| **Conditional** | Configurable via `user_validation.yaml → approval_required` |
| **Inputs** | Plan steps + test suite + requirement coverage mapping + sharding status |
| **Outputs** | Approved or modified plan. `revision` counter may increment. |

The primary human checkpoint (DDR-021). The daemon pauses this run's step
graph and pushes a confirmation request to all connected interfaces. Other
active workflow runs are unaffected — `meta.status` remains
`idle | discovering` project-wide. `WorkflowRun.awaiting_checkpoint` is set
to this step's id.

**What the user sees:**

Note: User sees `doc:plan` steps only. `doc:build-plan` is never presented at CONFIRM.

1. Proposed plan steps with descriptions and constraints
2. Test suite with requirement coverage mapping
3. Per-category test criteria
4. Sharding status (approved / not proposed)
5. Revision counter (how many times the plan has been revised in this iteration)

**User actions:**

| Action | Pointer state | Effect |
|---|---|---|
| Approve | `awaiting_checkpoint = null` | Proceed to BUILD |
| Modify plan steps | Pointer stays set to this step | `revision++`, run resumes at TEST for re-derivation |
| Modify test criteria | Pointer stays set to this step | Criteria updated. No TEST re-run. Re-present at CONFIRM. |
| Halt | `awaiting_checkpoint = null` | Run halts (`WorkflowRun.status → 'halted'`) |

**Modification payload:**

```
POST /api/v2/workflow-runs/{run_id}/revise

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
step. The Tester regenerates test scripts against the modified plan.
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
this step is skipped. The run proceeds directly from TEST to BUILD.
`awaiting_checkpoint` is never set for this step.

**Success criteria:** User approves. `awaiting_checkpoint = null`.

**Failure handling:** Timeout governed by `user_validation.yaml → timeout_minutes`
and `on_timeout` action. Halt action triggers `WorkflowRun.status → 'halted'`.

---

### Step 8 — BUILD

| Field | Value |
|---|---|
| **Layer** | L3 (Agent Runtime) |
| **Agent role** | Builder |
| **Kind** | produce |
| **Conditional** | No |
| **Inputs** | `requirements.md` + `architecture.md` + confirmed plan + test-plan + `build-plan` (deep/research only) |
| **Outputs** | Implementation code + one executable test script per active category |

The Builder reads the confirmed plan, architecture, and test-plan. It produces
implementation code and instrumented test scripts for each active validation
category.

Artifact references:
- Reads: `doc:requirements`, `doc:architecture`, `doc:plan`, `doc:test-plan`, `doc:build-plan` (deep/research only)
- Writes: Implementation files, `scripts/test_{category}.ts`

The Builder does not run the tests. It produces them for the EXEC step. Test
scripts are self-contained (no LLM, no daemon, structured JSON output).

**On retry iterations:** The Builder regenerates from scratch — it does not
patch the previous iteration's output. However, the context manager limits
its slice to failed-category-relevant content only.

**Success criteria:** Implementation code written. One test script per active
category. All scripts produce valid JSON on a dry run.

**Failure handling:** If the Builder produces invalid code (syntax errors in
generated scripts), the step errors. The run retries if within iteration cap.

---

### Step 9 — EXEC

| Field | Value |
|---|---|
| **Layer** | L4 (Execution Plane) |
| **Agent role** | None (generated scripts in Docker) |
| **Kind** | execute |
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
`CategoryResult` — they do not crash the step. EXEC always completes for all
categories. Step-level failure (e.g., Docker unavailable) triggers halt.

---

### Step 10 — VALIDATION_GATE

| Field | Value |
|---|---|
| **Layer** | L2 (Daemon) |
| **Agent role** | None (deterministic) |
| **Kind** | review |
| **Conditional** | No |
| **Inputs** | `CategoryResult[]` from all active categories |
| **Outputs** | `GateResult` — pass or fail |
| **`on_fail`** | `{ action: 'produce', target_step_id: 'DEBUG' }` |

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
3. Proceed to DEBUG (`on_fail` target — produces `FailureReport`)
4. Increment `iteration`
5. Check `iteration ≥ max_iterations`
   - Cap not hit → proceed to PLAN (iteration loop)
   - Cap hit → execute `exit.yaml → on_cap_hit` behavior → HALT

**Success criteria:** Gate decision made. `GateResult` produced.

**Failure handling:** This step does not fail — it is pure logic. If category
results are malformed, the step errors and the run halts (unrecoverable).

---

### Step 11 — DEBUG

| Field | Value |
|---|---|
| **Layer** | L3 (Agent Runtime) |
| **Agent role** | Debugger |
| **Kind** | produce (the `on_fail` target of VALIDATION_GATE) |
| **Conditional** | Yes — only when VALIDATION_GATE fails |
| **Inputs** | Run artifacts (manifest + context-pack) + failed category slices |
| **Outputs** | Diagnosis injected into Planner context (uses FailureReport from gate) |

The Debugger is the first role to read run artifacts after a gate failure. It
diagnoses — it does not plan or build. Its output feeds the next PLAN step.
DEBUG is not a distinct step kind — it is simply the `produce` step that
VALIDATION_GATE's `on_fail` names as its retry target (DDR-031). Any `review`
step in any workflow may declare an analogous `on_fail` target; this is the
one existing case.

```
interface FailureReport {
  run_id:             string
  workflow_id:        string
  iteration:          number
  run_dir:            string
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
FailureReport from the gate is passed to the Planner as-is. The run still
proceeds to PLAN — the Planner works with whatever diagnostic information
is available.

---

### Step 12 — EVALUATE

| Field | Value |
|---|---|
| **Layer** | L3 (Agent Runtime) |
| **Agent role** | Evaluator |
| **Kind** | produce |
| **Conditional** | No |
| **Inputs** | `requirements.md` + `evaluation.md` (prior) + `test-plan.md` + run artifacts |
| **Outputs** | Structured verdict: did the implementation satisfy the original intent? |

The Evaluator produces `evaluation.md` — a structured assessment of whether
the implementation met the user's intent. This document feeds into the next
run's Planner and Critic. EVALUATE is modeled as `produce`, not `review`
(DDR-031, WG-002) — it generates a verdict artifact; VALIDATION_GATE already
owns the halt/proceed decision, so EVALUATE has no independent blocking
failure mode.

Artifact references:
- Reads: `doc:requirements`, `doc:evaluation`, `doc:test-plan`
- Writes: `doc:evaluation`

**Success criteria:** `evaluation.md` written. Includes verdict (satisfied /
partially satisfied / not satisfied), evidence per requirement, and
recommendations for the next run.

**Failure handling:** If the Evaluator errors, the run still proceeds to
SUMMARISE. A placeholder evaluation is generated from the category results.

---

### Step 13 — SUMMARISE

| Field | Value |
|---|---|
| **Layer** | L3+L2 (Agent content + Daemon formatting) |
| **Agent role** | None (daemon formats, LLM generates content) |
| **Kind** | produce |
| **Conditional** | No |
| **Inputs** | `decisions.md` delta + category results + generated artifacts config |
| **Outputs** | User-facing summary + generated report artifacts |

Produces three generated artifacts (configured in `artifacts.yaml`):

| Artifact | Format | Description |
|---|---|---|
| `reports/validation-latest.html` | HTML | Per-category results table with verdicts and confidence |
| `scripts/run-tests.ts` | TypeScript | Aggregated test runner for independent verification |
| `reports/changelog-{version}.md` | Markdown | Digest of decisions.md entries from this run |

Summary sections (configured in `summary.yaml`):

1. **What was built** — from decisions.md delta
2. **What changed** — artifact-level diff from previous version
3. **Category results** — per-category pass/fail with confidence scores
4. **How to test** — shell commands for each test script
5. **Next steps** — suggestions for the next run

**Pause point:** If `user_validation.yaml → review_at` includes
`after_gate_pass`, the daemon pauses here before SNAPSHOT. Otherwise, proceeds
directly.

**Success criteria:** Summary generated. All three report artifacts written.

**Failure handling:** If report generation fails, a minimal text summary is
produced. The run still proceeds to SNAPSHOT — reports are best-effort.

---

### Step 14 — SNAPSHOT

| Field | Value |
|---|---|
| **Layer** | L2 (Daemon) |
| **Agent role** | None (daemon operation) |
| **Kind** | commit (`logs_decision: true`) |
| **Conditional** | No |
| **Inputs** | All artifacts, generated outputs, summary, evaluation |
| **Outputs** | Locked version entry in `map.yaml` |

The terminal step. It:

1. Assigns the next `version_id` (semver, auto-incremented)
2. Writes final state to `map.yaml`
3. Appends a decisions.md entry (`logs_decision: true` — this is HISTORY's
   former behavior, now a side effect of this commit rather than its own
   step, per DDR-031)
4. Releases every artifact claim in `WorkflowRun.claimed_artifacts`
5. Commits `map.yaml` + `decisions.md` + `docs/` to the docs remote
6. Commits generated scripts to the code remote
7. Sets `WorkflowRun.status → 'complete'`

Entry format (the decision-log append, formerly HISTORY's node-specific
behavior):

```
## {ISO timestamp} — {workflow_id} run {run_seq}, iteration {i}, {step_id}

{What was done this turn. Why (key decision or constraint). What changed.}
```

```
interface VersionSnapshot {
  version_id:         string
  workflow_run_id:    string
  iteration:          number
  revision:           number
  locked_at:          string
  artifact_hashes:    Record<string, string>
  category_results:   CategoryResult[]
  outcome:            'completed' | 'halted'
  version_bump:       'major' | 'minor' | 'patch'
  deployable:         boolean
  changed_artifacts:  string[]
}
```

Does NOT commit if `exit.yaml → halt_behavior → block_version_snapshot: true`
and outcome is `halted`. (This code path only applies if SNAPSHOT is reached
via a `force_pass` override.)

After commit, the project-wide `meta.completed_run_count` increments by one.
`WorkflowRun.status` transitions directly to `complete` — there is no
intermediate project-wide state transition, since `meta.status` was never
`cycling` to begin with (DDR-031).

**Success criteria:** Version locked. Artifacts committed. Claims released.
`WorkflowRun.status → 'complete'`.

**Failure handling:** If commit fails (remote unavailable), the snapshot is
written locally and the commit is retried. The run is still considered
complete — the snapshot exists in `map.yaml`. A background process handles
the push. Claims are released regardless of remote-push outcome — they gate
artifact contention, not remote durability.

## Constraints

These constraints apply across multiple steps and are stated here as a
consolidated reference to avoid repetition in individual step definitions.

1. **Concurrent runs allowed.** Multiple `full-build` runs (and runs of other
   workflows) may be active at once. A new run is rejected only on a
   `claim_conflict` — an actual contested artifact, not a project-wide
   session lock. The daemon enforces this at L2 via the artifact claim
   registry (DDR-031), not via `active_cycle_id`.
2. **TDD separation (Tester vs Builder).** The Tester never sees architecture
   or implementation. The Builder never sees Tester reasoning. They share only
   `requirements.md` and `test-plan.md`. This separation is enforced by the
   context manager's artifact slicing.
3. **Designer ownership.** The Designer is the sole writer of `architecture.md`
   and `requirements.md` (DDR-019). No other role modifies these artifacts.
4. **Critic is advisory, not blocking.** If the Critic cannot resolve all
   blocking issues within the pass limit, the run proceeds with warnings.
   The Critic never halts the run at the system level.
5. **Revision ≠ iteration.** Plan modifications at the CONFIRM checkpoint
   increment the `revision` counter, not the `iteration` counter. The
   iteration counter increments only on VALIDATION_GATE failure.
6. **SCOPING is always first in `full-build`.** Its three-step group is the
   first in every `full-build` run. It must produce `doc:cycle-charter`
   before DESIGN can start.
7. **VALIDATION_GATE is deterministic.** No LLM involvement. Pure boolean
   logic: all active categories must pass. The daemon applies this at L2.
8. **Decision logging is non-blocking.** If the commit step's
   `logs_decision` append to `decisions.md` fails, the run continues. The
   entry is reconstructed from run history.
9. **Context budget cap.** Every agent call receives at most 3,500 tokens in its
   assembled context. The context manager truncates slices as needed and records
   what was truncated.

## Open questions

No open questions specific to individual step definitions. See
[workflow-execution.md](workflow-execution.md) for run-level open questions
including iteration cap defaults, Critic pass-limit tuning, and the
decision-log's long-term role (structured logging vs append-only markdown).
