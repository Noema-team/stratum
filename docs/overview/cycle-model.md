# Cycle Model

**Type:** overview · **Status:** draft · **Updated:** 2026-04-17
**Related:** [what-is-sle.md](what-is-sle.md), [../specs/state-machine.md](../specs/state-machine.md)

---

## What this is

A development cycle is the fundamental unit of work in SLE. It takes a user's
intent and produces a validated, versioned snapshot of project artifacts — or
halts with a report explaining why it could not.

This document walks through what happens during a single cycle: the sequence of
nodes the system runs through, the decision points where humans or machines
choose what happens next, and the iteration model that governs retries when
validation fails.

It is conceptual. It explains *what happens and why*, not how individual nodes
are implemented or how the daemon tracks state internally. For implementation
detail, see the specifications linked in [See also](#see-also).

---

## Why it exists

Without a defined cycle model, every LLM-assisted development tool faces the
same problems: unbounded context growth, unpredictable cost, no clear completion
criteria, and no way to recover from failure. The cycle model solves these by
giving every unit of work a fixed structure with:

- A **bounded context window** for every agent call, assembled surgically by
  the daemon rather than passing raw conversation history.
- **Two explicit gates** — one where a human decides whether to proceed, one
  where the machine decides whether the output is valid.
- **A deterministic exit** — every cycle either produces a locked snapshot or a
  report explaining why it could not.
- **Bounded iteration** — a configurable cap on retries, with cached results for
  categories that already passed.

The cycle is the smallest unit that can be trusted. Anything smaller is
incomplete; anything larger is a project phase spanning multiple cycles.

---

## Key ideas

### System states

The system is always in exactly one of five states. They are mutually exclusive.

| State | Meaning |
|---|---|
| `idle` | No active session. Daemon running, ready to accept work. |
| `discovering` | A discovery session is running — the Facilitator is gathering project context. |
| `cycling` | A development cycle is executing. The system stays in this state through all nodes, all iterations, and all pause points. |
| `halted` | The cycle stopped before completing — iteration cap hit, user halted, or unrecoverable error. |
| `complete` | The cycle finished — all validation passed, snapshot locked. Returns to `idle`. |

Two things that are *not* system states:

- **Chat** is an orthogonal session layer, always available regardless of system
  state (DDR-020). It does not appear in the state machine.
- **Confirming** is expressed as a boolean flag on the cycle record
  (`cycle.awaiting_confirmation`), not as a top-level state. When this flag is
  `true`, `meta.status` is still `cycling` (DDR-021).

```
          ┌───────┐
   ┌─────│  idle  │◄─────────────────────┐
   │     └───┬────┘                      │
   │         │ sle discover / sle start  │
   │    ┌────┴─────┐                     │
   │    ▼          ▼                     │
   │ ┌──────────┐ ┌────────┐             │
   │ │discovering│ │cycling │             │
   │ └──────────┘ └───┬────┘             │
   │        ┌─────────┼─────────┐        │
   │        ▼         ▼         ▼        │
   │   ┌────────┐ ┌────────┐             │
   │   │ halted │ │complete│─────────────┘
   │   └────────┘ └────────┘
   └─────────────────────────────────── (back to idle)
```

### The cycle flow

Below is the full cycle DAG. Nodes run top-to-bottom. Indented branches show
conditional paths and loops.

```
SCOPING
    │  Daemon builds a cycle-charter from user input and project state.
    │  Replaces INTENT + CONTEXT_ASSEMBLY + EXPLORE (DDR-028).
    │  May conditionally trigger the Explorer for unknowns.
    ▼
DESIGN
    │  Designer produces requirements + architecture.
    │  At deep/research depth, the Critic reviews here (DDR-022).
    ▼
[CRITIQUE]  ← conditional (deep/research depth only)
    │  Critic reviews architecture + requirements (DDR-022).
    │  Blocking issues → Designer revises.
    │  All clear → proceed to PLAN.
    ▼
PLAN
    │  Planner reads Designer output, produces:
    │    · implementation plan (step-level)
    │    · test-plan (per-category coverage)
    │    · sharding proposal (if intake sub-phase ran)
    ▼
TEST
    │  Tester writes test scripts from requirements only.
    │  Never sees architecture or implementation — TDD separation.
    │  Produces one test script per active validation category.
    ▼
[SHARDING APPROVAL]  ← conditional (intake produced a proposal)
    │  cycle.awaiting_sharding_approval = true (DDR-026)
    │  Facilitator in decision mode.
    │  User reviews task boundaries, context declarations, dependencies.
    │  approve → proceed  |  modify → revise and re-present
    ▼
CONFIRM GATE
    │  cycle.awaiting_confirmation = true (DDR-021)
    │  meta.status stays cycling. Facilitator in decision mode (DDR-020).
    │  User reviews: plan steps, test coverage, requirement mapping.
    │  approve → BUILD  |  modify → back to TEST  |  halt → cycle ends
    ▼
BUILD
    │  Builder reads confirmed plan + architecture + test-plan.
    │  Produces implementation code + one executable test script per category.
    │  Test scripts are self-contained: no LLM, no daemon, structured JSON.
    ▼
HISTORY
    │  Historian appends 2–3 sentence entry to decisions.md (append-only).
    │  Records: what was done, why, what changed.
    ▼
EXEC  ← validation fan-out, all categories in parallel
    │  Per category, three sub-phases in order:
    │    1. static-check  (lint, typecheck) — fail skips remaining
    │    2. llm-check     (semantic review)
    │    3. exec-check    (run test scripts in Docker)
    ▼
VALIDATION GATE  ← deterministic, no LLM
    │
    ├── PASS ──────────────────────────── FAIL
    │         │                              │
    │         ▼                              ▼
    │     EVALUATE                       DEBUG
    │     Evaluator assesses            Debugger reads run artifacts +
    │     whether result satisfies      failed category slices. Produces
    │     the original intent.          FailureReport with root causes.
    │         │                              │
    │         ▼                              │ iteration counter
    │     SUMMARISE                         │ increments
    │     Produce user-facing summary       │
    │     with what was built, what         ▼
    │     changed, how to test.         ┌────────┐
    │         │                         │  PLAN  │ ◄── iteration loop
    │         ▼                         │(retry) │     starts here
    │     SNAPSHOT                      └────────┘
    │     Assign version. Lock state.        │
    │     Commit artifacts.                  ▼
    │     meta.status → idle.           TEST → CONFIRM → BUILD →
    │                                   HISTORY → EXEC → GATE
    │                                   (loops until PASS or iteration cap)
    ▼
  CYCLE COMPLETE
```

### The two gates

There are exactly two decision points in every cycle. They are fundamentally
different and must not be confused.

| | CONFIRM gate | VALIDATION gate |
|---|---|---|
| **Where** | After TEST, before BUILD | After EXEC, before EVALUATE |
| **Who decides** | Human | Machine (deterministic) |
| **What is reviewed** | Plan steps, test coverage, sharding proposal | Category pass/fail results |
| **How expressed** | `cycle.awaiting_confirmation` flag | `validation.gate.last_outcome` in map.yaml |
| **On approve/pass** | Proceed to BUILD | Proceed to EVALUATE |
| **On modify/fail** | Back to TEST (re-derive affected tests) | Back to DEBUG → PLAN (new iteration) |
| **LLM involved** | No — human reads and decides | No — boolean logic on structured results |

The CONFIRM gate is the last point where a human can steer the cycle before
code is written. After this gate, the system runs autonomously through BUILD,
EXEC, and VALIDATION.

The VALIDATION gate is the moment of truth. It is purely mechanical — every
active category must pass for the gate to pass. There is no partial credit.

### Human checkpoints

The cycle has two human checkpoints. Both use the same mechanism: a boolean
flag on the cycle record, with the Facilitator operating in decision mode
(structured actions rather than freeform Q&A).

**Sharding approval** (`cycle.awaiting_sharding_approval`)

Appears only when the intake sub-phase has run — when project documents exist
and the Planner produced a sharding proposal. The user reviews:

- Task boundaries — are the proposed tasks the right granularity?
- Context declarations — does each task reference the right document sections?
- Dependencies — are task dependencies correct?

This is a separate step from the CONFIRM gate (DDR-026). It runs after PLAN
produces the proposal, before the CONFIRM gate presents the plan and tests.

**CONFIRM gate** (`cycle.awaiting_confirmation`)

The primary human checkpoint. The user reviews the full plan:

- Plan steps — what will be built, in what order
- Test coverage — which requirements are covered by which tests
- Test criteria — acceptance criteria for each test

The user can approve, modify plan steps (triggers test re-derivation), modify
test criteria (no re-derivation), or halt the cycle.

Multiple revision rounds are allowed within a single iteration. Each round
increments a revision counter (separate from the iteration counter), visible in
the CONFIRM prompt. If `user_validation.yaml` has `approval_required: false`,
the CONFIRM gate is skipped entirely.

### The iteration model

A cycle does not always succeed on the first try. When the VALIDATION gate
fails, the system does not start over — it loops back with failure context
injected so the next attempt can focus on what went wrong.

**How it works:**

1. The VALIDATION gate fails. One or more categories did not pass.
2. The Debugger reads run artifacts and failed category slices. It produces a
   `FailureReport` identifying root causes.
3. The iteration counter increments.
4. The system loops back to the PLAN node. The Planner receives the
   `FailureReport` in its context — it sees only what failed and why.
5. The Planner rewrites only the sections relevant to the failed categories.
   It does not start from scratch.
6. The cycle runs TEST → CONFIRM → BUILD → HISTORY → EXEC → VALIDATION GATE
   again.
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

Configured in `planning.yaml → max_iterations`. When the cap is hit, the cycle
halts. A partial report is generated showing which categories failed and why.
`decisions.md` entries from all iterations are preserved — nothing is lost. No
version snapshot is locked (unless `exit.yaml` overrides this).

**Exit conditions:**

| Condition | Outcome | Snapshot locked |
|---|---|---|
| All categories pass | `completed` | Yes |
| Iteration cap hit | `halted` | No (unless `force_pass`) |
| User halts explicitly | `halted` | No |
| Unrecoverable error | `halted` | No |

### Revisions vs iterations

The system tracks two counters. They measure different things.

| | Revision | Iteration |
|---|---|---|
| **When it increments** | User modifies plan at CONFIRM gate | VALIDATION gate fails |
| **What it measures** | How many times the plan was adjusted before building | How many full build+validate attempts were made |
| **Scope** | Within a single iteration | Across the entire cycle |
| **Where it resets** | Cycle starts fresh | New cycle begins |

A cycle can have many revisions within iteration 1 and still be iteration 1.
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
| decisions.md | Historian appends new entry |
| Passing categories | Not retested — results cached from previous iteration |

### Planning depth and the Critic

Planning depth controls how much reasoning happens before the Builder runs. Set
in `planning.yaml`, overridable per cycle with `--depth`.

| Depth | Reasoning passes | Critic active | When to use |
|---|---|---|---|
| `minimal` | 1 | No | Prototyping, quick iteration |
| `standard` | 2 (draft + self-review) | No | Normal development |
| `deep` | 3 | Yes — 1 pass at DESIGN | Production systems |
| `research` | 4+ | Yes — multi-pass at DESIGN | Complex architecture decisions |

At `minimal` and `standard` depth, the CRITIQUE node is skipped entirely.
The Designer produces architecture and requirements, and the cycle proceeds
directly to PLAN.

At `deep` depth, the Critic runs one pass after the Designer, reviewing
architecture and requirements for blocking issues. If blocking issues are
found, the Designer revises and the Critic reviews again — up to a pass limit.

At `research` depth, the Critic runs multiple passes. Each time it reviews the
revised output and produces a new critique, until no blocking issues remain or
the pass limit is reached. This is the only depth where the Critic's feedback
loop can significantly extend cycle duration.

The Critic does not modify artifacts. It produces a critique object that the
daemon injects into the Designer's next pass. This separation ensures the
Designer retains full ownership of `requirements.md` and `architecture.md`
(DDR-019).

### Agent roles in the cycle

Each node is executed by a specific agent role. Roles are not interchangeable —
each receives a curated artifact slice and is forbidden from touching artifacts
outside its scope.

| Role | Node | What it produces | Key constraint |
|---|---|---|---|
| **Explorer** | SCOPING (conditional) | Research findings, benchmarks | Triggered by SCOPING when unknowns are flagged |
| **Designer** | DESIGN | `requirements.md`, `architecture.md` | Owns both artifacts (DDR-019) |
| **Critic** | CRITIQUE | Blocking issues, warnings, suggestions | Reviews Designer output (DDR-022). Deep/research only. |
| **Planner** | PLAN | Implementation plan, test-plan, sharding proposal | Reads Designer output. Owns plan + test-plan (DDR-019). |
| **Tester** | TEST | Executable test scripts (one per category) | Never sees architecture or implementation — TDD separation |
| **Builder** | BUILD | Implementation code + test scripts | Reads confirmed plan, architecture, test-plan |
| **Debugger** | DEBUG | Root-cause diagnosis, FailureReport | Only runs on gate failure. Diagnoses only. |
| **Evaluator** | EVALUATE | Structured verdict against original intent | Reads requirements, test-plan, run artifacts |
| **Historian** | HISTORY | 2–3 sentence audit entry | Appends to `decisions.md` after every agent turn |

The context manager assembles a separate artifact slice for each role —
typically under 3,500 tokens per call. No role sees the full project. Each
sees only what it needs to do its job.

### Context assembly

Every agent call receives a surgical context window assembled by the daemon.
This is the primary mechanism that keeps context costs bounded across many
iterations. The context window contains five components:

1. **System prompt** — role definition + behavioral rules (~500 tokens)
2. **Artifact slices** — only the documents this role needs (~2,000 tokens)
3. **System state summary** — cycle number, iteration, depth (~300 tokens)
4. **Task for this turn** — specific instruction for this call (~200 tokens)
5. **Failure context** — FailureReport from previous iteration, if any (~400 tokens)

On retry iterations, the FailureReport replaces category results. The agent
sees only what failed and why — not the full history of everything that
succeeded.

---

## How it fits

The cycle model sits at the center of the SLE system. It depends on:

- **Discovery** having run first — cycles require the foundational documents
  that discovery produces (product brief, success definition, constraints,
  system description).
- **Rule files** being loaded — `planning.yaml` sets depth, `validation.yaml`
  defines categories, `user_validation.yaml` configures gate behavior.
- **Beads** for task tracking — tasks are claimed before BUILD and closed after
  SNAPSHOT.

The cycle produces artifacts that flow into the next cycle:

- `evaluation.md` from the Evaluator feeds into the next cycle's Planner and
  Critic.
- `decisions.md` is append-only across all cycles — the project's audit trail.
- Each SNAPSHOT increments the version, so the next cycle starts from a known
  baseline.

A project phase (as defined in `project-plan.md`) spans multiple cycles. Each
cycle handles one coherent unit of work — a single feature, a bug fix, a
refactoring. The cycle model ensures each unit is validated before it is locked.

---

## See also

| Document | What it covers |
|---|---|
| [SLE-002 — DAG + task lifecycle](../../vision/SLE-002-dag-task-lifecycle.md) | Full node definitions, TypeScript types, exit conditions |
| [SLE-024 — System reference](../../vision/SLE-024-system-reference.md) | §5 cycle anatomy, agent roles, artifact registry |
| [../specs/state-machine.md](../specs/state-machine.md) | Formal state machine specification |
| [../reference/types.md](../reference/types.md) | Authoritative TypeScript types (SystemStatus, CycleOutcome) |
| [../reference/map-yaml-schema.md](../reference/map-yaml-schema.md) | Cycle record fields (awaiting_confirmation, awaiting_sharding_approval) |
| [agent-roles.md](agent-roles.md) | Detailed role descriptions and artifact ownership |
| [DECISION-BRIEFS.md](../decisions/DECISION-BRIEFS.md) | DDR-019 through DDR-026 architecture decisions |
