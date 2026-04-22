# What is SLE?

**Type:** overview · **Status:** draft · **Updated:** 2026-04-22
**Related:** [architecture.md](architecture.md), [cycle-model.md](cycle-model.md)

## What this is

The Software Lifecycle Engine (SLE) is a closed-loop system that transforms
human intent into working, validated software — and keeps it working over time.
It is not a code generator, a chat interface, or a task runner. It is an
orchestration layer that manages a living codebase through repeated cycles of
designing, building, validating, and evolving, where each cycle produces a
locked, versioned, tested artifact set. The user drives intent. The system
drives execution.

```
intent → design → plan → build → validate → evaluate → snapshot
         ↑                                              │
         └──────── failure feedback (bounded loop) ─────┘
```

## Why it exists

Building software with LLMs today is ad-hoc. A developer pastes a prompt,
gets code, pastes it into a file, runs tests manually, spots a bug, pastes
another prompt, and repeats. Each turn is stateless — the LLM has no memory
of what it built last week, no awareness of the project's architecture
constraints, and no structured way to validate that its output actually works.

SLE exists to close that gap. It gives the LLM a project-sized memory (the
artifact store), a structured execution path (the DAG), bounded iteration
(gates and caps), and a human in the loop at decision points. The result is
a system where the developer states what they want, the system figures out
how to build it and prove it works, and every step is auditable.

The core insight: **intent is cheap, validation is expensive, and the loop
between them must be bounded.** An unbounded LLM loop either diverges or
consumes unpredictable resources. SLE replaces that with a deterministic DAG
where every cycle either completes (all validation categories pass) or halts
cleanly (iteration cap hit, partial report generated, user notified).

## Key ideas

### 1. Intent-driven development

The user provides intent — a natural-language description of what to build,
change, or fix. The system translates that intent into architecture, plans,
tests, and implementation. The user never writes code directly through SLE;
they describe outcomes and the system produces them.

Intent flows through three session types, each with different outputs:

| Session | Trigger | What it produces |
|---------|---------|-------------------|
| Discovery | `sle discover` | Foundational project documents (product brief, constraints, system description, project plan) |
| Chat | `sle chat` | Decisions captured to `decisions.md`; optional context for the next cycle |
| Cycle | `sle start "intent"` | A versioned, validated artifact snapshot |

Discovery runs once per project. Cycles run repeatedly. Chat is always
available regardless of what else is happening.

### 2. Autonomous agents in bounded roles

SLE does not use a single general-purpose LLM. It uses ten specialized agent
roles, each with a narrowly defined responsibility and a constrained view of
the project:

| Role | Purpose | When active |
|------|---------|-------------|
| **Facilitator** | Asks questions, captures decisions, structures discovery output | Discovery, Chat |
| **Explorer** | Investigates unknowns, runs spikes, produces research findings | EXPLORE node (user-initiated only) |
| **Designer** | Owns requirements and architecture documents | DESIGN node |
| **Critic** | Reviews architecture for flaws before planning proceeds | CRITIQUE node (deep/research depth) |
| **Planner** | Produces step-level implementation plan and test-plan | PLAN node |
| **Tester** | Writes executable test scripts from requirements alone (never sees implementation) | TEST node |
| **Builder** | Produces implementation code and instrumented test scripts | BUILD node |
| **Debugger** | Diagnoses gate failures from run artifacts | DEBUG node (on validation failure) |
| **Evaluator** | Produces structured verdict on whether intent was satisfied | EVALUATE node |
| **Historian** | Maintains append-only decision audit trail | HISTORY node |

Each role receives only the artifact slice it needs — the Tester never sees
the architecture, the Builder never sees the Tester's reasoning. This
separation is not cosmetic. It enforces a test-driven discipline: tests are
derived from requirements, implementation satisfies tests, and the validation
gate proves the match.

### 3. Human in the loop at decision points

The system runs autonomously within a cycle but pauses for human judgment at
configured gates:

- **CONFIRM gate** (after TEST, before BUILD) — the human reviews the plan
  and test suite. They can approve, request modifications (which return to
  TEST for re-derivation), or halt the cycle entirely.
- **VALIDATION gate** (after EXEC) — this is machine-driven (deterministic
  boolean logic on all category results, no LLM involvement), but the human
  can configure what happens on failure: retry with feedback, prompt for
  input, or halt with a report.

The Facilitator serves as the interface at these pause points. It has two
modes ([DDR-020](../decisions/ddr-020-state-machine-chat.md)):

- **Chat mode** — freeform Q&A with project and cycle context. Always
  available, regardless of system state.
- **Decision mode** — triggered by pending actions (gate approval, sharding
  approval, halt resolution). The user can act immediately, ask clarifying
  questions, or add context before deciding.

This is not a suggestion — the default configuration requires human approval
at the CONFIRM gate. Fully automated runs are possible but opt-in.

### 4. Validation-first execution

Every cycle ends with validation, not with code. The system does not consider
a cycle complete until every configured validation category passes. Categories
are defined in `validation.yaml` and can be extended per project.

Each category runs through sub-phases:

```
static-check (lint, typecheck, complexity)
  ↓ pass
llm-check (semantic correctness — does this satisfy the intent?)
  ↓ pass
exec-check (functional correctness — do generated tests pass in Docker?)
```

If static-check fails, the downstream phases are skipped — there is no point
asking an LLM whether broken code is semantically correct. If any category
fails, the gate produces a structured `FailureReport` and injects it into the
next Planner iteration. Passing categories are never re-run.

This dual-phase pattern (LLM reasoning + executable verification) catches
different classes of problems. The LLM can spot logical gaps that tests miss.
The executable phase can catch runtime errors that the LLM cannot predict.
Both must agree for a category to pass.

The canonical types for validation results, gate outcomes, and failure reports
are defined in [../reference/types.md](../reference/types.md) (§6).

### 5. Local-first with optional remote services

SLE stores all project state in a `.sle/` directory within the project root.
This includes rule files, runtime state (`map.yaml`), chat history, run
artifacts, and the task store. The system works fully offline with no external
dependencies.

Optional integrations enhance but are not required:

| Service | Role | Degraded without it |
|---------|------|---------------------|
| **Beads** (Dolt) | Issue tracking, agent memory, cross-device task sync | Local task fallback via `.sle/tasks.yaml` ([DDR-024](../decisions/ddr-024-beads-required-or-optional.md)) |
| **Code remote** (Git) | Source code versioning, rule file storage | No code history |
| **Docs remote** (Git) | Independent documentation versioning | Docs share code repo history |
| **LLM provider** | Agent reasoning | System cannot run cycles |

The `TaskStore` provider interface abstracts over Beads and local mode. The
context manager reads from whichever store is active — no code changes in
context assembly when switching between them.

The three-remote model (code, issues, docs) gives each concern its own
history. Documentation can be branched and rolled back independently from
code. Issue history survives code repo resets. Code can be open-sourced
without exposing internal docs.

### 6. Rules as configuration

All system behavior is governed by seven YAML rule files in `.sle/rules/`:

| File | Controls |
|------|----------|
| `planning.yaml` | Depth levels, iteration cap, reasoning passes, artifact slice sizes |
| `validation.yaml` | Active categories, methods, pass criteria, prompt templates |
| `artifacts.yaml` | Which documents to generate, format, required flag |
| `exit.yaml` | Cycle exit conditions, cap behavior, halt policy |
| `user_validation.yaml` | When to pause for human approval, prompt template, timeout |
| `summary.yaml` | User-facing summary format, sections, test command style |
| `agents.yaml` | Agent roles, system prompts, LLM provider config per role |

Adding a new validation category means adding a YAML entry and a prompt
template. No code changes. Changing planning depth is a single field. Two
projects with different rule files produce completely different system
behavior from the same SLE daemon.

The Planner may append new categories to `validation.yaml` at planning time
but cannot modify any other rule file. This boundary keeps the loop bounded
and predictable regardless of LLM output.

### 7. Git-native artifact versioning

Every completed cycle produces a locked snapshot — an immutable, versioned
copy of all artifacts. Snapshots live under `.sle/snapshots/{version}/` and
are never modified after creation. This means every cycle's output can be
audited, compared, and rolled back to.

Artifacts themselves are tracked in `map.yaml`, which the daemon regenerates
after every DAG node. The full artifact registry — who produces what, who
consumes it, and where it lives — is documented in
[../reference/artifact-registry.md](../reference/artifact-registry.md).

## How it fits

SLE sits between the developer's intent and the running codebase. It does not
replace the developer's editor, version control, or deployment pipeline. It
replaces the ad-hoc prompt → paste → test loop with a structured,
repeatable, auditable process.

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Developer workflow                           │
│                                                                     │
│  ┌──────────┐    ┌─────────────────────────────────┐    ┌────────┐ │
│  │  Intent  │───►│              SLE                │───►│  Code  │ │
│  │          │    │                                 │    │  base  │ │
│  │ "Build   │    │  Discovery → Chat → Cycles      │    │        │ │
│  │  auth    │    │  10 roles · DAG · gates · snaps  │    │ (git   │ │
│  │  system" │    │  validation · rules · artifacts  │    │  repo) │ │
│  └──────────┘    └─────────────────────────────────┘    └────────┘ │
│       │                        │                           │       │
│       │    ┌───────────┐       │     ┌───────────┐        │       │
│       └───►│  Facilit.  │◄──────┘    │  EXEC     │────────┘       │
│            │  (chat)    │  status     │  (Docker) │  test scripts  │
│            └───────────┘             └───────────┘                │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  Interfaces: CLI · Web UI · Obsidian plugin                  │  │
│  │  All thin clients — no system logic, just REST + WebSocket   │  │
│  └──────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

### System states

The system is always in exactly one of five states:

```
idle ──► discovering ──► idle
  │                            ▲
  ├──► cycling ──► complete ───┘
  │       │
  │       └──► halted ────────┘
  │
  └──► (chat is always available, orthogonal to system state)
```

| State | Meaning |
|-------|---------|
| `idle` | No active session. Daemon running, ready for work. |
| `discovering` | A discovery session is producing foundational documents. |
| `cycling` | A development cycle is executing through the DAG. |
| `halted` | Cycle stopped — cap hit, user halt, or unrecoverable error. |
| `complete` | Cycle finished — all validation passed, snapshot locked. Returns to `idle`. |

Chat is not a system state. It is an orthogonal session layer with its own
open/closed state, independent of whatever the system is doing. A user can
chat during `cycling`, `discovering`, or `idle` without affecting the system
state machine ([DDR-020](../decisions/ddr-020-state-machine-chat.md)).

### The cycle DAG

A development cycle is a single pass through a fixed DAG of nodes. This is
the system's execution backbone — every cycle follows this path:

```
EXPLORE (optional, user-initiated)
  ↓
CONTEXT ASSEMBLY ─── daemon loads artifact slices per role
  ↓
DESIGN ─────────── Designer produces requirements + architecture
  ↓
CRITIQUE ───────── Critic reviews (deep/research depth only)
  ↓
PLAN ───────────── Planner produces plan + test-plan
  ↓
TEST ───────────── Tester writes executable scripts from requirements
  ↓
CONFIRM ─────────── human approves or modifies before build
  ↓
BUILD ──────────── Builder produces implementation + instrumented tests
  ↓
HISTORY ────────── Historian appends audit entries
  ↓
EXEC ───────────── validation fan-out (parallel, Docker, no LLM)
  ↓
VALIDATION GATE ─── deterministic: all pass → continue, any fail → retry
  ↓
EVALUATE ────────── Evaluator produces structured verdict
  ↓
SUMMARISE ───────── user-facing summary of what was built
  ↓
SNAPSHOT ────────── locked, versioned artifact set → cycle complete
```

On validation failure, the Debugger diagnoses the root cause from run
artifacts, and the system loops back to PLAN with a `FailureReport` injected
into the Planner's context. The iteration counter increments. When the cap
is hit, the cycle halts with a partial report.

The DAG has two counters that must not be confused:

- **Revision** — increments when the user modifies the plan at the CONFIRM
  gate. Resets when the cycle starts fresh. Happens *before* build.
- **Iteration** — increments when the VALIDATION gate fails. Resets when a
  new cycle begins. Happens *after* validation.

A cycle can have many revisions within iteration 1 and still be iteration 1.

### Planning depth: the speed-quality dial

Planning depth is the primary knob for trading speed against quality. It
controls how many reasoning passes the system performs, whether the Critic
runs, and how much context each agent receives:

| Depth | Passes | Critic | Use when |
|-------|--------|--------|----------|
| `minimal` | 1 | No | Prototyping, quick fixes |
| `standard` | 2 | No | Normal development (default) |
| `deep` | 3 | Yes (1 pass) | Production systems |
| `research` | 4+ | Yes (multi-pass) | Complex architecture, high stakes |

Depth is set in `planning.yaml` and can be overridden per cycle with
`--depth`. It does not control the EXPLORE node — exploration is always
user-initiated regardless of depth setting
([DDR-023](../decisions/ddr-023-explore-trigger.md)).

### Agent bootstrap

Every agent session begins with two files:

1. **`agent.md`** — human-authored project intent, conventions, and
   constraints. Written once at `sle init`, never modified by the system.
2. **`map.yaml`** — auto-generated system state. Regenerated after every
   DAG node, never hand-edited by the human.

Together they answer every question an agent needs before doing work: what
the project is, where the current cycle stands, which artifacts exist, which
rules are active, and which tasks are available. No agent starts work
without reading both.

### The context window

No agent sees the full artifact store. The context manager assembles a
specific slice for each role based on what that role needs to do its job.
The Tester gets requirements and test-plan. The Builder gets requirements,
architecture, and test-plan. The Debugger gets run artifacts and failed
category details. This is not a cost optimization — it is a correctness
constraint. Agents that cannot see unrelated artifacts cannot be influenced
by them.

Context assembly has two modes:

- **Declared mode** — Beads tasks carry precise section-level references.
  The context manager resolves exactly what was requested, no inference.
- **Inferred mode** — no declared tasks. The daemon assigns role-based
  defaults from `map.yaml`, truncating to fit the token budget.

Declared mode is always preferred. Inferred mode is the fallback for ad-hoc
cycles without task declarations.

## What SLE is not

**Not an IDE.** SLE does not provide an editor. It integrates with existing
tools (Obsidian, CLI, web UI) via the daemon's REST + WebSocket API.

**Not a framework.** SLE does not impose structure on the code it produces.
The Builder generates whatever the project requires — Node.js, shell scripts,
TypeScript, configuration files.

**Not an agent.** SLE orchestrates agents but is not itself an agent. The
daemon executes cycles; the Facilitator provides conversation. These are
distinct concerns.

**Not autonomous without oversight.** SLE requires human approval at
configured checkpoints. Fully automated runs are possible but opt-in. The
default is human-in-the-loop at the CONFIRM gate.

**Not dependent on any single service.** The system works locally with no
external accounts. Beads, remote repos, and specific LLM providers are all
optional integrations, not requirements
([DDR-024](../decisions/ddr-024-beads-required-or-optional.md)).

## See also

- [architecture.md](architecture.md) — platform layers, daemon internals, component diagram
- [cycle-model.md](cycle-model.md) — conceptual cycle walkthrough
- [agent-roles.md](agent-roles.md) — all 10 roles, artifact ownership, context slices
- [glossary.md](glossary.md) — terms and definitions
- [../reference/types.md](../reference/types.md) — authoritative TypeScript type reference
- [../reference/artifact-registry.md](../reference/artifact-registry.md) — canonical artifact registry
- [../reference/rule-file-defaults.md](../reference/rule-file-defaults.md) — default values for all seven rule files
