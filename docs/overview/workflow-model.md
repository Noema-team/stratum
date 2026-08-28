# Workflow Model

**Type:** overview · **Status:** draft · **Updated:** 2026-06-21
**Related:** [what-is-sle.md](what-is-sle.md), [../specs/workflow-execution.md](../specs/workflow-execution.md), [../specs/step-kind-reference.md](../specs/step-kind-reference.md)

---

## What this is

A **workflow run** is the fundamental unit of work in SLE. A `WorkflowRun` is
one instance of a `WorkflowDefinition` — a skill-style document made of
composable steps — executing against a specific target. It takes a user's
intent and produces a validated, versioned snapshot of project artifacts, or
halts with a report explaining why it could not (DDR-031).

SLE ships with one built-in workflow, `full-build`, which is today's full
build-test-review pipeline expressed in the new generic step primitives. It
also ships a second, tiny built-in workflow, `draft-artifact`, used both for
small one-off work ("draft one spec file from a template") and as the way
users author new workflows themselves — no bespoke workflow-builder UI is
needed (DDR-031, decision 10).

This document walks through `full-build` as the worked example: the sequence
of steps the system runs through, the decision points where humans or
machines choose what happens next, and the iteration model that governs
retries when validation fails. It is conceptual. It explains *what happens
and why*, not how individual steps are implemented or how the daemon tracks
state internally. For implementation detail, see the specifications linked in
[See also](#see-also).

---

## Why it exists

Without a defined workflow model, every LLM-assisted development tool faces
the same problems: unbounded context growth, unpredictable cost, no clear
completion criteria, and no way to recover from failure. The workflow model
solves these by giving every unit of work a composable structure with:

- A **bounded context window** for every agent call, assembled surgically by
  the daemon rather than passing raw conversation history.
- **Explicit checkpoints** — points where a human decides whether to proceed
  — and **explicit reviews** — points where the machine decides whether the
  output is valid.
- **A deterministic exit** — every workflow run either produces a locked
  snapshot or a report explaining why it could not.
- **Bounded iteration** — a configurable cap on retries, with cached results
  for categories that already passed.

A workflow run is the smallest unit that can be trusted. Anything smaller is
incomplete; anything larger is a project phase spanning multiple runs.

Unlike the single fixed pipeline this model replaces, workflows are
composable and there can be many of them. Several workflow runs may be
active at once — different groups, different layers, even different steps
within the same group — as long as they don't claim the same artifact
(DDR-031). `full-build` is one workflow among potentially many; it is not a
privileged, hard-coded concept anymore.

---

## Key ideas

### System states vs. per-run states

The system as a whole is always in exactly one of two states. Workflow runs
are tracked independently, alongside — not as part of — system state
(DDR-031).

| System state | Meaning |
|---|---|
| `idle` | No discovery session running. Daemon ready to accept work. |
| `discovering` | A discovery session is running — the Facilitator is gathering project context. |

Discovery is the one piece of work that stays project-wide and singular,
because it bootstraps the project graph everything else depends on. Workflow
runs are not part of this state machine at all. Each `WorkflowRun` carries
its own status:

| Per-run state (`WorkflowRun.status`) | Meaning |
|---|---|
| `active` | This run is executing — somewhere in its own step graph, across any number of iterations and pause points. |
| `halted` | This run stopped before completing — iteration cap hit, user halted, or unrecoverable error. |
| `complete` | This run finished — all validation passed, snapshot locked. |

Two things that are *not* states at either level:

- **Chat** is an orthogonal session layer, always available regardless of
  system state or how many runs are active (DDR-020).
- **Checkpoint pauses** are expressed as a single nullable pointer on the run
  record (`WorkflowRun.awaiting_checkpoint`), not as a top-level state. A run
  can only be paused at one checkpoint at a time, by construction (DDR-031).

```
          ┌───────┐
   ┌─────│  idle  │◄─────────────────────┐
   │     └───┬────┘                      │
   │         │ sle discover               │
   │         ▼                            │
   │    ┌──────────┐                      │
   │    │discovering│──────────────────────┘
   │    └──────────┘
   └─────────────────────────────────── (back to idle)

   Workflow runs are tracked separately — any number active concurrently,
   each independently transitioning active → halted | complete.
```

### The full-build workflow

Below is `full-build`'s full step graph — the worked example proving the six
generic step kinds (`gather`, `produce`, `review`, `checkpoint`, `execute`,
`commit`) reproduce today's entire pipeline, behaviorally unchanged. Steps
run top-to-bottom. Indented branches show conditional paths and loops.

```
SCOPING  (gather → produce → checkpoint)
    │  Daemon builds a run charter from user input and project state.
    │  Replaces the former INTENT + CONTEXT_ASSEMBLY + EXPLORE sequence (DDR-028).
    │  May conditionally trigger the Explorer for unknowns.
    ▼
DESIGN  (produce)
    │  Designer produces requirements + architecture.
    │  At deep/research depth, the Critic reviews here (DDR-022).
    ▼
[CRITIQUE]  (review) ← conditional (deep/research depth only)
    │  Critic reviews architecture + requirements (DDR-022).
    │  on_fail → back to DESIGN (Designer revises).
    │  All clear → proceed to PLAN.
    ▼
PLAN  (produce)
    │  Planner reads Designer output, produces:
    │    · implementation plan (step-level)
    │    · test-plan (per-category coverage)
    │    · sharding proposal (if intake sub-phase ran)
    ▼
TEST  (produce)
    │  Tester writes test scripts from requirements only.
    │  Never sees architecture or implementation — TDD separation.
    │  Produces one test script per active validation category.
    ▼
[SHARDING APPROVAL]  (checkpoint) ← conditional (intake produced a proposal)
    │  WorkflowRun.awaiting_checkpoint = this step's id (DDR-026)
    │  Facilitator in decision mode.
    │  User reviews task boundaries, context declarations, dependencies.
    │  approve → proceed  |  modify → revise and re-present
    ▼
CONFIRM  (checkpoint)
    │  WorkflowRun.awaiting_checkpoint = this step's id (DDR-021)
    │  Run status stays active. Facilitator in decision mode (DDR-020).
    │  User reviews: plan steps, test coverage, requirement mapping.
    │  approve → BUILD  |  modify → back to TEST  |  halt → run ends
    ▼
BUILD  (produce)
    │  Builder reads confirmed plan + architecture + test-plan.
    │  Produces implementation code + one executable test script per category.
    │  Test scripts are self-contained: no LLM, no daemon, structured JSON.
    ▼
EXEC  (execute) ← validation fan-out, all categories in parallel
    │  Per category, three sub-phases in order:
    │    1. static-check  (lint, typecheck) — fail skips remaining
    │    2. llm-check     (semantic review)
    │    3. exec-check    (run test scripts in Docker)
    ▼
VALIDATION_GATE  (review) ← deterministic, no LLM
    │
    ├── PASS ──────────────────────────── FAIL
    │         │                              │
    │         ▼                              ▼
    │     EVALUATE  (produce)           DEBUG  (produce — on_fail target)
    │     Evaluator assesses            Debugger reads run artifacts +
    │     whether result satisfies      failed category slices. Produces
    │     the original intent.          FailureReport with root causes.
    │         │                              │
    │         ▼                              │ iteration counter
    │     SUMMARISE  (produce)              │ increments
    │     Produce user-facing summary       │
    │     with what was built, what         ▼
    │     changed, how to test.         ┌────────┐
    │         │                         │  PLAN  │ ◄── iteration loop
    │         ▼                         │(retry) │     starts here
    │     SNAPSHOT  (commit,            └────────┘
    │     logs_decision: true)               │
    │     Assign version. Lock state.        ▼
    │     Commit artifacts + release    TEST → CONFIRM → BUILD →
    │     claim. Logs Historian entry    EXEC → VALIDATION_GATE
    │     as a side effect.              (loops until PASS or iteration cap)
    ▼
  WORKFLOW RUN COMPLETE
```

The full step-by-step mapping from the old 15-node pipeline to the six
generic kinds is in
[../specs/step-kind-reference.md](../specs/step-kind-reference.md). Notably:
HISTORY is no longer a standalone step — it folds into SNAPSHOT's `commit` as
a `logs_decision: true` side effect. DEBUG is not a separate step kind — it is
`VALIDATION_GATE`'s `on_fail` target, a `produce` step like any other.

### The two checkpoints/gate

There are exactly two human checkpoints and one machine review gate in every
`full-build` run. They are fundamentally different and must not be confused.

| | CONFIRM checkpoint | VALIDATION_GATE review |
|---|---|---|
| **Where** | After TEST, before BUILD | After EXEC, before EVALUATE |
| **Who decides** | Human | Machine (deterministic) |
| **What is reviewed** | Plan steps, test coverage, sharding proposal | Category pass/fail results |
| **How expressed** | `WorkflowRun.awaiting_checkpoint` | `validation.gate.last_outcome` in map.yaml |
| **On approve/pass** | Proceed to BUILD | Proceed to EVALUATE |
| **On modify/fail** | Back to TEST (re-derive affected tests) | `on_fail` → DEBUG → PLAN (new iteration) |
| **LLM involved** | No — human reads and decides | No — boolean logic on structured results |

The CONFIRM checkpoint is the last point where a human can steer the run
before code is written. After this checkpoint, the system runs autonomously
through BUILD, EXEC, and VALIDATION_GATE.

VALIDATION_GATE is the moment of truth. It is purely mechanical — every
active category must pass for the review to pass. There is no partial
credit.

### Human checkpoints

`full-build` has two human checkpoints. Both use the same mechanism: the
single `awaiting_checkpoint` pointer on the run record, with the Facilitator
operating in decision mode (structured actions rather than freeform Q&A).

**Sharding approval checkpoint**

Appears only when the intake sub-phase has run — when project documents exist
and the Planner produced a sharding proposal. The user reviews:

- Task boundaries — are the proposed tasks the right granularity?
- Context declarations — does each task reference the right document sections?
- Dependencies — are task dependencies correct?

This is a separate checkpoint from CONFIRM (DDR-026). It runs after PLAN
produces the proposal, before CONFIRM presents the plan and tests.

**CONFIRM checkpoint**

The primary human checkpoint. The user reviews the full plan:

- Plan steps — what will be built, in what order
- Test coverage — which requirements are covered by which tests
- Test criteria — acceptance criteria for each test

The user can approve, modify plan steps (triggers test re-derivation), modify
test criteria (no re-derivation), or halt the run.

Multiple revision rounds are allowed within a single iteration. Each round
increments a revision counter (separate from the iteration counter), visible
in the CONFIRM prompt. If `user_validation.yaml` has `approval_required:
false`, the CONFIRM checkpoint is skipped entirely.

### The iteration model

A workflow run does not always succeed on the first try. When
VALIDATION_GATE fails, the system does not start over — it loops back with
failure context injected so the next attempt can focus on what went wrong.

**How it works:**

1. VALIDATION_GATE fails. One or more categories did not pass.
2. The Debugger reads run artifacts and failed category slices. It produces
   a `FailureReport` identifying root causes.
3. The iteration counter increments.
4. The system loops back to the PLAN step. The Planner receives the
   `FailureReport` in its context — it sees only what failed and why.
5. The Planner rewrites only the sections relevant to the failed categories.
   It does not start from scratch.
6. The run executes TEST → CONFIRM → BUILD → EXEC → VALIDATION_GATE again.
7. Repeat until all categories pass, or the iteration cap is hit.

**What the iteration loop skips:**

On retry, the system goes directly to PLAN — it does not re-run DESIGN or
CRITIQUE. Architecture and requirements are not re-derived unless the failure
is structural (flagged by the Debugger as a blocking issue).

**What is cached:**

Passing categories are never re-run. If correctness passed on iteration 1 but
performance failed, iteration 2 only rebuilds and retests the components
relevant to performance. The context manager enforces this — the Planner's
slice includes only failed category context.

**The iteration cap:**

Configured in `planning.yaml → max_iterations` (per workflow run, DDR-031).
When the cap is hit, the run halts. A partial report is generated showing
which categories failed and why. `decisions.md` entries from all iterations
are preserved — nothing is lost. No version snapshot is locked (unless
`exit.yaml` overrides this).

**Exit conditions:**

| Condition | Outcome | Snapshot locked |
|---|---|---|
| All categories pass | `complete` | Yes |
| Iteration cap hit | `halted` | No (unless `force_pass`) |
| User halts explicitly | `halted` | No |
| Unrecoverable error | `halted` | No |

### Revisions vs iterations

The system tracks two counters per run. They measure different things.

| | Revision | Iteration |
|---|---|---|
| **When it increments** | User modifies plan at CONFIRM checkpoint | VALIDATION_GATE fails |
| **What it measures** | How many times the plan was adjusted before building | How many full build+validate attempts were made |
| **Scope** | Within a single iteration | Across the entire run |
| **Where it resets** | Run starts fresh | New workflow run begins |

A run can have many revisions within iteration 1 and still be iteration 1.
Revisions happen *before* the build. Iterations happen *after* validation.

What changes between revisions:

| What | How |
|---|---|
| Plan steps | Modified per user's edit |
| Test scripts | Regenerated against modified plan (affected categories only) |
| Iteration counter | Not incremented |

What changes between iterations:

| What | How |
|---|---|
| Planner context | Includes FailureReport + failed category slices only |
| Builder output | Regenerated from scratch |
| Tester output | Regenerated from scratch |
| decisions.md | Historian appends new entry (via the SNAPSHOT commit's `logs_decision`) |
| Passing categories | Not retested — results cached from previous iteration |

### Planning depth and the Critic

Planning depth controls how much reasoning happens before the Builder runs.
Set in `planning.yaml`, overridable per workflow run with `--depth`.

| Depth | Reasoning passes | Critic active | When to use |
|---|---|---|---|
| `minimal` | 1 | No | Prototyping, quick iteration |
| `standard` | 2 (draft + self-review) | No | Normal development |
| `deep` | 3 | Yes — 1 pass at DESIGN | Production systems |
| `research` | 4+ | Yes — multi-pass at DESIGN | Complex architecture decisions |

At `minimal` and `standard` depth, the CRITIQUE step is skipped entirely. The
Designer produces architecture and requirements, and the run proceeds
directly to PLAN.

At `deep` depth, the Critic runs one pass after the Designer, reviewing
architecture and requirements for blocking issues. If blocking issues are
found, the Designer revises and the Critic reviews again — up to a pass
limit.

At `research` depth, the Critic runs multiple passes. Each time it reviews
the revised output and produces a new critique, until no blocking issues
remain or the pass limit is reached. This is the only depth where the
Critic's feedback loop can significantly extend run duration.

The Critic does not modify artifacts. It produces a critique object that the
daemon injects into the Designer's next pass. This separation ensures the
Designer retains full ownership of `requirements.md` and `architecture.md`
(DDR-019).

### Agent roles in the workflow run

Each step is executed by a specific agent role. Roles are not interchangeable
— each receives a curated artifact slice and is forbidden from touching
artifacts outside its scope.

| Role | Step | What it produces | Key constraint |
|---|---|---|---|
| **Explorer** | SCOPING (conditional) | Research findings, benchmarks | Triggered by SCOPING when unknowns are flagged |
| **Designer** | DESIGN | `requirements.md`, `architecture.md` | Owns both artifacts (DDR-019) |
| **Critic** | CRITIQUE | Blocking issues, warnings, suggestions | Reviews Designer output (DDR-022). Deep/research only. |
| **Planner** | PLAN | Implementation plan, test-plan, sharding proposal | Reads Designer output. Owns plan + test-plan (DDR-019). |
| **Tester** | TEST | Executable test scripts (one per category) | Never sees architecture or implementation — TDD separation |
| **Builder** | BUILD | Implementation code + test scripts | Reads confirmed plan, architecture, test-plan |
| **Debugger** | DEBUG (failure path of VALIDATION_GATE) | Root-cause diagnosis, FailureReport | Only runs on review failure. Diagnoses only. |
| **Evaluator** | EVALUATE | Structured verdict against original intent | Reads requirements, test-plan, run artifacts |
| **Historian** | SNAPSHOT (`logs_decision: true`) | 2–3 sentence audit entry | Appends to `decisions.md` after every agent turn |

The context manager assembles a separate artifact slice for each role —
typically under 3,500 tokens per call. No role sees the full project. Each
sees only what it needs to do its job.

### Context assembly

Every agent call receives a surgical context window assembled by the daemon.
This is the primary mechanism that keeps context costs bounded across many
iterations. The context window contains five components:

1. **System prompt** — role definition + behavioral rules (~500 tokens)
2. **Artifact slices** — only the documents this role needs (~2,000 tokens)
3. **System state summary** — run id, iteration, depth (~300 tokens)
4. **Task for this turn** — specific instruction for this call (~200 tokens)
5. **Failure context** — FailureReport from previous iteration, if any (~400 tokens)

On retry iterations, the FailureReport replaces category results. The agent
sees only what failed and why — not the full history of everything that
succeeded.

---

## Beyond full-build

`full-build` is the largest, most structured built-in workflow — but it is
just one `WorkflowDefinition` among potentially many. The other built-in,
`draft-artifact`, composes the same six step kinds into a much smaller
graph (gather context → produce one artifact → checkpoint for approval →
commit), and doubles as the mechanism for authoring entirely new workflows:
authoring one is running `draft-artifact` with output type "workflow
definition." A new `WorkflowDefinition`, once committed, becomes visible to
the chat router immediately — the same claim/commit mechanism as any other
artifact, with no special-cased creation endpoint (DDR-031, decision 10).

Because workflow runs claim artifacts rather than holding a project-wide
lock, multiple runs — a `full-build` against one group and a
`draft-artifact` against an unrelated document, say — can be active at the
same time, as long as their claimed artifacts don't overlap.

---

## How it fits

The workflow model sits at the center of the SLE system. It depends on:

- **Discovery** having run first — `full-build` requires the foundational
  documents that discovery produces (product brief, success definition,
  constraints, system description). Other, smaller workflows may not.
- **Rule files** being loaded — `planning.yaml` sets depth, `validation.yaml`
  defines categories, `user_validation.yaml` configures checkpoint behavior.
- **Beads** for task tracking — tasks are claimed before BUILD and closed
  after SNAPSHOT.

Each workflow run produces artifacts that flow into the next:

- `evaluation.md` from the Evaluator feeds into the next `full-build` run's
  Planner and Critic.
- `decisions.md` is append-only across all workflow runs — the project's
  audit trail.
- Each SNAPSHOT increments the version, so the next run starts from a known
  baseline.

A project phase (as defined in `project-plan.md`) spans multiple workflow
runs. Each run handles one coherent unit of work — a single feature, a bug
fix, a refactoring, or something as small as a single drafted artifact. The
workflow model ensures each unit is validated before it is locked.

---

## See also

| Document | What it covers |
|---|---|
| [../specs/workflow-execution.md](../specs/workflow-execution.md) | Formal execution spec — flow diagrams, retry semantics, API contracts |
| [../specs/step-kind-reference.md](../specs/step-kind-reference.md) | The six step kinds, plus full-build's complete step-by-step reference |
| [../specs/workflow-authoring.md](../specs/workflow-authoring.md) | How a `WorkflowDefinition` is authored as a skill-style document |
| [../specs/state-machine.md](../specs/state-machine.md) | Formal state machine specification |
| [../reference/types.md](../reference/types.md) | Authoritative TypeScript types (`SystemStatus`, `WorkflowRun`, `StepKind`) |
| [../reference/map-yaml-schema.md](../reference/map-yaml-schema.md) | Workflow run record fields (`awaiting_checkpoint`, claimed artifacts) |
| [agent-roles.md](agent-roles.md) | Detailed role descriptions and artifact ownership |
| [../decisions/ddr-031-workflow-generalization.md](../decisions/ddr-031-workflow-generalization.md) | The decision record for this generalization |
| [DECISION-BRIEFS.md](../decisions/DECISION-BRIEFS.md) | DDR-019 through DDR-026 architecture decisions |
