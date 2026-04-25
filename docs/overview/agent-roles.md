# Agent Roles

**Type:** overview · **Status:** draft · **Updated:** 2026-04-17
**Related:** [cycle-model.md](cycle-model.md), [../reference/artifact-registry.md](../reference/artifact-registry.md)

## What this is

This document defines all ten agent roles in the SDK Orchestrator system. Each
role is a named, scoped LLM context with specific artifact inputs, outputs, and
constraints. Roles are not interchangeable. No agent may read or produce
artifacts outside its defined scope.

This document synthesises the role definitions from SLE-024 §4 with the
design decisions recorded in DDR-007, DDR-019, DDR-020, DDR-022, and DDR-023.
Where a DDR modifies the original vision, the change is noted inline and
summarised in [§Key decisions that changed roles](#key-decisions-that-changed-roles).

## Why it exists

The system routes every LLM call through a named role. Without a single
reference defining each role's purpose, inputs, outputs, and constraints,
two problems emerge:

1. **Context leakage** — an agent receives artifacts it should not see,
   biasing its output (e.g., Tester seeing Builder code).
2. **Artifact ownership conflicts** — two agents write the same artifact,
   creating race conditions and unclear provenance.

This document prevents both. It is the authoritative source for "what does
role X read, produce, and never touch."

## Key ideas

### Roles are not general-purpose

Every LLM call is scoped to exactly one role. The role determines:

- **Which artifacts the agent reads** — the context slice assembled by the
  context manager (SLE-007).
- **Which artifacts the agent produces** — the output contract the daemon
  validates before accepting the result.
- **What the agent is forbidden from doing** — hard constraints preventing
  cross-contamination.

A role cannot improvise outside its contract. If the Designer needs
information only the Explorer could gather, the system runs the Explorer
first — the Designer does not improvise research.

### Roles are grouped by session type

Two groups exist:

| Group | Session types | Roles |
|-------|---------------|-------|
| **Discovery + Chat** | `sle discover`, `sle chat` | Facilitator |
| **Cycle** | `sle start "intent"` | Explorer, Designer, Planner, Tester, Builder, Debugger, Evaluator, Critic, Historian |

The Facilitator never participates in cycle nodes. Cycle roles never
participate in discovery or chat. The only overlap is context: cycle roles
read the artifacts the Facilitator produced during discovery.

### Role isolation is enforced at the DAG level

The DAG (defined in [cycle-model.md](cycle-model.md)) controls which nodes
execute and in what order. Each node activates exactly one agent role
(except DESIGN, which activates Designer and optionally Critic). The daemon
assembles the context slice for each role before the LLM call. The agent
never chooses its own inputs.

### Outputs become the next role's inputs

The DAG is a data-flow pipeline. The Designer's output becomes the Planner's
input, the Planner's output becomes the Tester's input, and so on. A late
change to one role's output format cascades downstream, making artifact
ownership a first-class concern.

## The ten roles — summary

| Role | DAG node(s) | Session | Primary purpose | Produces |
|------|-------------|---------|-----------------|----------|
| Facilitator | — (discovery/chat) | Discovery, Chat | Ask questions, capture decisions | Discovery docs, decisions |
| Explorer | EXPLORE (conditional) | Cycle | Research design space, run spikes | Research findings |
| Designer | DESIGN | Cycle | Define what to build | `architecture.md`, `requirements.md` |
| Planner | PLAN | Cycle | Define how to build it | `plan.md`, `test-plan.md` |
| Tester | TEST | Cycle | Write unbiased test scripts | Test scripts per category |
| Builder | BUILD | Cycle | Implement code to satisfy tests | Implementation code |
| Debugger | DEBUG (on gate fail) | Cycle | Diagnose root cause of failures | Fix recommendation |
| Evaluator | EVALUATE | Cycle | Judge if intent was satisfied | `evaluation.md` |
| Critic | DESIGN (post-Designer) | Cycle | Review architecture for issues | Blocking issues, warnings |
| Historian | HISTORY | Cycle | Record audit trail | `decisions.md` entries |

## Role definitions

### 1. Facilitator

**Purpose:** The Facilitator is the human-facing role for discovery and chat sessions. It asks
questions, surfaces context, structures answers, and captures decisions. It
does not plan, build, or evaluate.

**DAG node:** None. The Facilitator operates outside the cycle DAG, in
discovery and chat sessions.

**Reads:**

| Artifact | When |
|----------|------|
| `agent.md` + `map.yaml` | Bootstrap pair — every call |
| Discovery documents (in progress) | During discovery rounds |
| `.sle/chat-history.jsonl` | Chat session resumption |
| Cycle artifacts (read-only) | Decision mode: architecture, plan, evaluation |

**Produces:**

| Artifact | When |
|----------|------|
| `docs/product-brief.md` | Discovery Round 1 |
| `docs/success-definition.md` | Discovery Round 2 |
| `docs/constraints.md` | Discovery Round 3 |
| `docs/stakeholders.md` | Discovery Round 4 |
| `docs/system-description.md` | Discovery synthesis |
| `docs/vision.md` | Discovery synthesis |
| `docs/open-questions.md` | Discovery synthesis |
| `docs/project-plan.md` | Discovery planning loop |
| `docs/decisions.md` (entries) | Both sessions |

**Key constraints:**

- Cannot write or modify code, start or stop cycles, or modify rule files
  or `map.yaml`.
- Cannot modify cycle artifacts (architecture, plan, implementation).
- Two operational modes (DDR-020):
  - **Chat mode** — freeform Q&A with project and cycle context
  - **Decision mode** — triggered by pending actions (gates, approvals);
    user can act, ask questions, or add context before deciding

**DDR changes:** DDR-020 redefined the Facilitator from a single-mode
discovery role into a dual-mode role (chat + decision). The context manager
now assembles different slices depending on which mode is active.

### 2. Explorer

**Purpose:** Investigate a design space, run spikes, and map out possibilities
before committing to a design. The Explorer produces research findings that
inform the Designer's architecture decisions.

**DAG node:** EXPLORE (conditional, before DESIGN).

**Reads:**

| Artifact | When |
|----------|------|
| `agent.md` + `map.yaml` | Bootstrap pair |
| User intent | From INTENT node |
| Discovery documents | Full set |
| Prior evaluation | If revisiting a cycle |

**Produces:**

| Artifact | When |
|----------|------|
| Research findings document | Spike results, design options, tradeoff analysis |
| Tagged output: `explore:user-guided` | Always — source attribution |

**Key constraints:**

- User-initiated only (DDR-023). The daemon does not auto-trigger exploration
  based on heuristics or planning depth.
- Interactive process: rounds of discussion between user and Explorer,
  guided by the user's questions.
- Runs before DESIGN, between cycles, or on demand.
- Does not produce architecture, plans, or implementation.
- Cost is user-visible and user-controlled.
- Automatic gap detection is a separate system — not the Explorer (DDR-023).

**DDR changes:** DDR-023 clarified that the Explorer is exclusively

---

### 3. Designer

**Purpose:** Define what the system should build. The Designer translates
user intent and discovery context into an architecture and a requirements
document. It owns the "what" — system shape, component boundaries, and the
contract between intent and implementation.

**DAG node:** DESIGN.

**Reads:**

| Artifact | When |
|----------|------|
| `agent.md` + `map.yaml` | Bootstrap pair |
| User intent | From INTENT node |
| Discovery documents | Full set |
| Prior architecture | If revisiting |
| `docs/decisions.md` | Last 3 entries |
| Explorer research findings | If EXPLORE ran |
| Critic review (if present) | If previous DESIGN was blocked |

**Produces:**

| Artifact | When |
|----------|------|
| `docs/architecture.md` | Every DESIGN invocation |
| `docs/requirements.md` | Every DESIGN invocation |

**Key constraints:**

- Owns both `architecture.md` and `requirements.md` (DDR-019).
- Does not produce step-level plans or test plans (Planner's scope).
- Output is reviewed by the Critic before the Planner runs (DDR-022).

**DDR changes:** DDR-019 assigned `requirements.md` ownership to the
Designer. Previously, requirements ownership was ambiguous. The rationale:
requirements define *what* to build (design intent), not *how* (steps).
This created a clean separation — Designer owns the contract, Planner owns
the execution plan.

### 4. Planner

**Purpose:** Define how to build what the Designer specified. The Planner
translates architecture and requirements into step-level implementation
instructions and a test plan.

**DAG node:** PLAN.

**Reads:**

| Artifact | When |
|----------|------|
| `agent.md` + `map.yaml` | Bootstrap pair |
| `docs/architecture.md` | Designer's output (read-only) |
| `docs/requirements.md` | Designer's output (read-only) |
| `docs/decisions.md` | Last 3 entries |
| Prior evaluation | If revisiting |
| Critic review | If Critic ran at DESIGN |

**Produces:**

| Artifact | When |
|----------|------|
| `docs/plan.md` | Step-level implementation plan |
| `docs/test-plan.md` | Test strategy per validation category |

**Key constraints:**

- Owns `plan.md` and `test-plan.md` (DDR-019).
- Reads but does not modify `architecture.md` or `requirements.md`.
- Does not produce architecture or requirements.
- May include an INTAKE sub-phase for declared context assembly mode.
- Output is not reviewed by the Critic (DDR-022) — plan-level issues surface
  during execution and at the validation gate.

**DDR changes:** DDR-019 split the original Planner into Designer + Planner.
The Planner lost ownership of architecture and requirements, gained exclusive
ownership of `plan.md` and `test-plan.md`.

### 5. Tester

**Purpose:** Write test scripts that verify the implementation satisfies the
requirements — without seeing the implementation. The Tester is the TDD
enforcement mechanism: tests derived from requirements, not from code.

**DAG node:** TEST.

**Reads:**

| Artifact | When |
|----------|------|
| `agent.md` + `map.yaml` | Bootstrap pair |
| `docs/requirements.md` | Designer's output |
| `docs/test-plan.md` | Planner's output |

**Produces:**

| Artifact | When |
|----------|------|
| `scripts/test_{category}.ts` | One per active validation category |

**Key constraints:**

- **Never sees Builder output** (DDR-007). The core TDD separation.
  The Tester reads requirements and the test plan only. It does not receive
  `architecture.md`, implementation code, or any Builder-produced artifact.
- Generates one test script per active validation category.
- Defines pass criteria and test IDs for each script.
- Does NOT run tests — the Execution Plane (L4) handles execution.
- Does NOT review implementation — the LLM validation sub-phase handles that.
- Test scripts become a contract for the Builder to satisfy during BUILD.

**DDR changes:** DDR-007 introduced the Tester as a separate agent from the
Builder. Previously the Builder wrote both implementation and tests.
DDR-007 established that tests written by the code author are inherently
biased toward the implementation. The Tester's context slice was narrowed to
exclude all Builder output.

### 6. Builder

**Purpose:** Implement code that satisfies the requirements and passes the
test scripts. The Builder receives the architecture, requirements, and test
scripts as its contract and produces implementation code.

**DAG node:** BUILD.

**Reads:**

| Artifact | When |
|----------|------|
| `agent.md` + `map.yaml` | Bootstrap pair |
| `docs/requirements.md` | Designer's output |
| `docs/architecture.md` | Designer's output |
| `docs/test-plan.md` | Planner's output |
| Test scripts | Tester's output — the contract to satisfy |

**Produces:**

| Artifact | When |
|----------|------|
| Implementation code | Source files in project |
| Instrumented test scripts | Modified from Tester's originals, ready for EXEC |

**Key constraints:**

- Produces implementation only. Does not write requirements, architecture,
  or plans.
- Receives test scripts as a contract — must satisfy them, not modify pass
  criteria.
- Never sees Tester's internal reasoning — only the final test scripts.
- Output is validated by the Execution Plane (L4), not by another agent.
- Runs only after user approval if the CONFIRM gate is active.

**DDR changes:** DDR-007 removed test authoring from the Builder. The
Builder now receives test scripts as a contract rather than writing them
itself.

### 7. Debugger

**Purpose:** Diagnose why the validation gate failed. The Debugger is the
first role to read run artifacts after a gate failure. It diagnoses only —
it does not plan or build. Its output feeds the next PLAN node.

**DAG node:** DEBUG (activated only on VALIDATION gate failure).

**Reads:**

| Artifact | When |
|----------|------|
| Run manifest | `.sle/runs/{id}/manifest.json` |
| Context pack | `.sle/runs/{id}/ai/context-pack.md` |
| Failed category results | Per-category `result.json` for failed categories |
| Metrics, traces, logs | Run artifact directory |

**Produces:**

| Artifact | When |
|----------|------|
| FailureReport | Root-cause diagnosis + focused fix recommendation |

**Key constraints:**

- Only activates when the VALIDATION gate fails. Never runs on a passing
  cycle.
- Does not produce implementation code or tests — diagnosis only.
- Does not modify artifacts directly. Its output is injected into the
  Planner's context for the next iteration.
- The FailureReport feeds the next PLAN node: DEBUG → PLAN → TEST → BUILD →
  EXEC → VALIDATION gate.
- Does not run if the cycle hits the iteration cap — the cycle halts.

**DDR changes:** None. The Debugger role is unchanged from SLE-024.

### 8. Evaluator

**Purpose:** Judge whether the implementation satisfied the original user
intent. The Evaluator runs after the validation gate passes — it does not
check code quality (the gate's job) but whether the result matches what the
user asked for.

**DAG node:** EVALUATE.

**Reads:**

| Artifact | When |
|----------|------|
| `agent.md` + `map.yaml` | Bootstrap pair |
| User intent | From INTENT node |
| `docs/requirements.md` | Designer's output |
| `docs/evaluation.md` | Prior cycle evaluation (if revisiting) |
| `docs/test-plan.md` | Planner's output |
| Run artifacts | Manifest + context pack |

**Produces:**

| Artifact | When |
|----------|------|
| `docs/evaluation.md` | Structured verdict: did implementation satisfy intent? |

**Key constraints:**

- Runs after the VALIDATION gate passes — never on a failed cycle.
- Does not re-run tests or check code style (the gate already did that).
- Produces a structured verdict that the next cycle's Planner reads.
- Output is human-readable and surfaces in the cycle summary.

**DDR changes:** None. The Evaluator role is unchanged from SLE-024.

### 9. Critic

**Purpose:** Review the Designer's architecture and requirements for
structural issues before planning begins. The Critic catches flawed
architecture early, preventing wasted work in PLAN, TEST, and BUILD.

**DAG node:** DESIGN (after Designer completes, before PLAN begins — DDR-022).

**Reads:**

| Artifact | When |
|----------|------|
| `agent.md` + `map.yaml` | Bootstrap pair |
| `docs/architecture.md` | Designer's output |
| `docs/requirements.md` | Designer's output |
| Project context | Discovery documents |
| `docs/decisions.md` | Full history |
| Prior evaluation | If revisiting |

**Produces:**

| Artifact | When |
|----------|------|
| Review output | Blocking issues, warnings, suggestions |

**Key constraints:**

- Triggered after DESIGN node completes, before PLAN node begins (DDR-022).
- Only runs at `depth: deep` or `depth: research` planning depth.
  At `depth: minimal` and `depth: standard`, the Critic is inactive.
- Does NOT review the Planner's output — plan issues surface during
  execution and at the validation gate.
- Reviews architecture + requirements, not plan + test-plan (DDR-022).
- At `depth: research`, the Critic performs multi-pass review. At
  `depth: deep`, a single review pass.
- Can block the cycle (raise blocking issues that force a DESIGN re-run).

**DDR changes:** DDR-022 moved the Critic from post-PLAN to post-DESIGN.
Catching flawed architecture before planning is higher leverage than catching
plan-level issues after planning. The DAG flow changed from
`... → PLAN → CRITIQUE → ...` to `... → DESIGN → CRITIQUE → PLAN → ...`.

### 10. Historian

**Purpose:** Record a concise audit trail. The Historian appends entries to
`decisions.md` after every agent turn, creating a persistent log of what
decisions were made and why.

**DAG node:** HISTORY.

**Reads:**

| Artifact | When |
|----------|------|
| `docs/decisions.md` | Full document (append target) |
| Current node context | Whatever the preceding agent produced |

**Produces:**

| Artifact | When |
|----------|------|
| `docs/decisions.md` entries | 2–3 sentence audit entries, appended |

**Key constraints:**

- Append-only. Never modifies or deletes existing entries.
- Produces concise entries (2–3 sentences).
- Runs after every agent turn — not just at cycle end.
- Future is under review (SLE-024 §9). Its audit-trail function may be
  function may be achievable without a real-time LLM call, potentially
  replaced by structured logging and periodic summarisation.

**DDR changes:** None. The Historian role is unchanged from SLE-024, though
its long-term status is under review.

## Key decisions that changed roles

| DDR | What changed | Before (SLE-024) | After |
|-----|-------------|-------------------|-------|
| DDR-007 | Tester is a separate agent from Builder | Builder wrote both implementation and tests | Tester writes tests from requirements only; Builder produces implementation only |
| DDR-019 | Designer/Planner ownership split | Single "Planner" produced architecture, requirements, plan, test-plan | Designer owns `architecture.md` + `requirements.md`; Planner owns `plan.md` + `test-plan.md` |
| DDR-020 | Facilitator has two modes | Facilitator was discovery-only, single mode | Facilitator operates in chat mode (freeform Q&A) and decision mode (gate actions, approvals) |
| DDR-022 | Critic runs at DESIGN node | Critic reviewed post-PLAN | Critic reviews architecture + requirements at DESIGN, before planning |
| DDR-023 | Explorer is user-initiated only | EXPLORE was "conditional — when unknowns flagged" (ambiguous trigger) | EXPLORE is explicitly user-initiated; automatic gap detection is a separate daemon mechanism |

## Role interaction map

```
User intent
     │
     ▼
┌──────────┐  research findings   ┌──────────┐
│ Explorer │ ───────────────────► │ Designer │
│(optional)│                      │          │
└──────────┘                      └────┬─────┘
  (DDR-023:                            │ architecture.md
   user-initiated)                     │ requirements.md
                                       │
                            ┌──────────┘
                            │
                       ┌────▼─────┐
                       │  Critic  │ (DDR-022: at DESIGN node,
                       │          │  deep/research depth only)
                       └────┬─────┘
                            │ review output
                            ▼
                       ┌──────────┐
                       │ Planner  │
                       │          │──► plan.md
                       └────┬─────┘     test-plan.md
                            │
                 ┌──────────┼──────────┐
                 ▼                         ▼
            ┌──────────┐            ┌──────────┐
            │  Tester  │            │ Builder  │
            │          │            │          │
            │ reads:   │            │ reads:   │
            │ reqs,    │  contract  │ arch,    │
            │ test-plan│───────────►│ reqs,    │
            │          │  (scripts) │ test-plan│
            └──────────┘            └────┬─────┘
  (DDR-007: never sees                    │
   Builder output)                        ▼
                                    ┌──────────┐
                                    │   EXEC   │ (L4, no agent)
                                    └────┬─────┘
                                         │
                               ┌─────────┼─────────┐
                               ▼                   ▼
                          ┌─────────┐         ┌──────────┐
                          │  PASS   │         │  FAIL    │
                          └────┬────┘         └────┬─────┘
                               │                   ▼
                               ▼              ┌──────────┐
                          ┌──────────┐        │ Debugger │──► FailureReport
                          │Evaluator │        └──────────┘     │
                          └────┬─────┘                          ▼
                               │                          next PLAN node
                               ▼
                     ┌───────────────┐
                     │   Historian   │ (every turn, append-only)
                     └───────────────┘
```

## Artifact ownership by role

| Artifact | Written by | Read by |
|----------|-----------|---------|
| `docs/architecture.md` | Designer | Planner, Builder, Critic, Evaluator |
| `docs/requirements.md` | Designer | Planner, Tester, Builder, Evaluator |
| `docs/plan.md` | Planner | Builder (deep+ only) |
| `docs/test-plan.md` | Planner | Tester, Builder, Evaluator |
| Test scripts (`test_{cat}.ts`) | Tester | Builder (as contract), EXEC (L4) |
| Implementation code | Builder | EXEC (L4), Debugger (via run artifacts) |
| `docs/evaluation.md` | Evaluator | Planner (next cycle), Critic |
| `docs/decisions.md` | Historian, Facilitator | All roles (last 3 for Planner) |
| Research findings | Explorer | Designer |
| FailureReport | Debugger | Planner (next iteration) |
| Review output | Critic | Designer (if blocking), Planner |
| Discovery documents (8 files) | Facilitator | All cycle roles |

## Context isolation summary

| Constraint | Roles affected | Enforced by |
|-----------|---------------|-------------|
| Tester never sees Builder output | Tester, Builder | Context manager (SLE-007) |
| Builder never sees Tester's reasoning | Builder, Tester | Context manager (SLE-007) |
| Planner does not write architecture or requirements | Planner | DDR-019, output contract |
| Designer does not write plans or test plans | Designer | DDR-019, output contract |
| Explorer is user-initiated only | Explorer | DDR-023, DAG trigger logic |
| Critic only reviews at DESIGN node | Critic | DDR-022, DAG node placement |
| Debugger only activates on gate failure | Debugger | DAG trigger logic |
| Facilitator cannot modify cycle artifacts | Facilitator | DDR-020, output contract |
| Historian is append-only | Historian | Output contract |

## How it fits

Agent roles sit at **Layer 3 (Agent runtime)**. The daemon (**Layer 2**)
invokes them at DAG nodes. Outputs flow through the artifact store (Layer 2)
to downstream roles or the Execution Plane (**Layer 4**).

| Specification | Relationship to agent roles |
|--------------|---------------------------|
| [cycle-model.md](cycle-model.md) | Defines the DAG nodes that activate each role |
| [../reference/artifact-registry.md](../reference/artifact-registry.md) | Defines the schemas for artifacts each role produces |
| SLE-007 (Context manager) | Assembles the artifact slice each role reads |
| SLE-004 (Rule files) | Configures planning depth, which affects Critic activation |
| DDR-020 (Chat state) | Defines Facilitator's dual-mode behaviour |
| DDR-023 (Explore trigger) | Separates user-initiated EXPLORE from automatic gap detection |

## See also

- [DDR-007](../decisions/ddr-007-tester-agent.md) — Tester/Builder separation
- [DDR-019](../decisions/ddr-019-designer-planner-ownership.md) — Designer/Planner artifact ownership
- [DDR-020](../decisions/ddr-020-state-machine-chat.md) — Facilitator chat and decision modes
- [DDR-022](../decisions/ddr-022-critic-timing.md) — Critic at DESIGN node
- [DDR-023](../decisions/ddr-023-explore-trigger.md) — Explorer user-initiated trigger
- [SLE-024](../../vision/SLE-024-system-reference.md) — System reference (original role definitions)
- [cycle-model.md](cycle-model.md) — DAG node sequence and gate definitions
- [../reference/artifact-registry.md](../reference/artifact-registry.md) — Artifact schemas and locations
