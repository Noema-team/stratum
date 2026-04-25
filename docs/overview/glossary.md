# Glossary

**Type:** overview · **Status:** draft · **Updated:** 2026-04-22
**Related:** [what-is-sle.md](what-is-sle.md)

## Why it exists

A single source of truth for every term used across the SLE v2 documentation.
When two documents use the same word differently, this document is the
tiebreaker. If a term is not listed here, it has not been formally defined.

The glossary resolves terminology drift across 22 spec files and 7 reference
docs. Terms like "tier" vs "layer", "cycle" vs "session", "depth" vs "planning
mode", and "artifact" vs "document" have been used inconsistently in earlier
drafts; this file anchors canonical forms. Each entry has a one-line definition
and a pointer to the spec or decision record that covers it in detail.

## Key ideas

The most contested and frequently confused terms in the documentation set:

**Tier vs Layer.** Two unrelated concepts that shared the word "layer" until
DDR-004 resolved the collision. **Tier** now refers exclusively to the
platform-architecture stack (Tiers 0–4: Host, Interface, Daemon, Agent Runtime,
Execution Plane). **Layer** refers exclusively to lifecycle content categories
within a knowledge-graph group (Research, Spikes, Design, Plans, Implementation,
Code, Notes, Hosting). See [Contested terms → G03](#g03--layer-naming-collision)
and [architecture.md](architecture.md).

**Cycle vs Session.** A **cycle** is one complete pass from user intent through
the DAG to a validated, versioned artifact snapshot (or clean halt). A
**session** is one unit of interaction with the system — of which there are
three types: discovery, chat, and cycle. A session may contain zero or more
cycles. See [cycle-model.md](cycle-model.md), SLE-002.

**Depth vs Planning mode.** **Planning depth** is the canonical term for the
configuration controlling reasoning passes, Critic activation, and artifact
slice size. Four levels: `minimal | standard | deep | research`. Do not use
"planning mode" — it is deprecated. See SLE-004.

**Artifact vs Document.** An **artifact** is a versioned file produced by a
role or the daemon, tracked by the artifact store with a known location and
schema. A **document** is a project-scoped entity in the knowledge graph living
in `.sle/project-docs/`. All artifacts are documents, but not all documents are
artifacts. See DDR-013.

## How it fits

This glossary supports the broader overview documentation set:

- [agent-roles.md](agent-roles.md) — canonical definitions for all agent roles
  and their responsibilities
- [architecture-overview.md](architecture-overview.md) — the five-tier platform
  architecture and data-flow model
- [what-is-sle.md](what-is-sle.md) — high-level product description and
  motivation

---

## Terms

| Term | Definition | See also |
|------|-----------|----------|
| **agent** | An LLM call in the context of a named role, with a specific artifact slice and output contract | SLE-007, [agent-roles.md](agent-roles.md) |
| **agent.md** | Human-authored bootstrap file read by every agent before work begins. Written once at `sle init`; never modified by the system | SLE-001, `map.yaml` |
| **AgentRole** | The TypeScript union type naming every role the daemon can dispatch: `explorer \| designer \| planner \| tester \| builder \| debugger \| evaluator \| critic \| historian \| facilitator` | [agent-roles.md](agent-roles.md), SLE-024 §4 |
| **artifact** | A versioned file produced by a role or the daemon, with a known location and schema | SLE-024 §7 |
| **artifact slice** | The subset of the artifact store loaded into one agent call's context window, assembled by the context manager | SLE-007 |
| **artifact store** | The daemon subsystem that reads, writes, and versions all project artifacts across the three remotes | SLE-005 |
| **backlog** | A latent-work queue separate from Beads. Backlog items can be promoted to Beads issues and then to active cycle tasks | SLE-021 |
| **Beads** | The Git-native issue tracker (`bd`) backed by Dolt. Manages active tasks and agent memory across sessions | SLE-006 |
| **bootstrap pair** | `agent.md` + `map.yaml` — the two files every agent reads before doing any work | SLE-001 |
| **build node** | DAG node where the Builder role produces implementation code and instrumented test scripts. Always after TEST and CONFIRM GATE | [cycle-model.md](cycle-model.md), SLE-024 §5.1 |
| **Builder** | Agent role at the BUILD node. Receives requirements + architecture + test-plan; produces implementation and test scripts. Never sees Tester reasoning | [agent-roles.md](agent-roles.md), SLE-024 §4.2 |
| **category** | A named validation concern (e.g. correctness, performance, security) with its own test script and three sub-phases | SLE-003 |
| **chat session** | An always-available, orthogonal interaction mode using the Facilitator role. Independent of system state; never blocks a running cycle | SLE-012 |
| **Critic** | Agent role at the DESIGN node (deep/research depth only). Reviews architecture for blocking issues before detailed planning begins | DDR-022, SLE-024 §4.2 |
| **cycle** | One pass from user intent to a validated, versioned artifact snapshot (or a clean halt) | [cycle-model.md](cycle-model.md), SLE-002 |
| **CycleOutcome** | The terminal state of a cycle: `complete \| halted`. Used in version snapshots and reports | SLE-001 types, SLE-024 §2 |
| **cycle roles** | The nine agent roles active during a development cycle: Explorer, Designer, Planner, Tester, Builder, Debugger, Evaluator, Critic, Historian | [agent-roles.md](agent-roles.md) |
| **DAG** | Directed Acyclic Graph — the fixed node sequence the daemon walks through each cycle iteration | SLE-002, SLE-024 §5.1 |
| **Debug node** | Conditional DAG node activated only on VALIDATION GATE failure. The Debugger diagnoses root cause and feeds a diagnosis to the next PLAN node | SLE-024 §5.1 |
| **Debugger** | Agent role at the DEBUG node. First consumer of run artifacts after gate failure. Produces root-cause diagnosis; does not plan or build | [agent-roles.md](agent-roles.md), SLE-024 §4.2 |
| **declared mode** | Context assembly using Beads task declarations (`TaskContextDeclaration`) as precise section references. Preferred over inferred mode | DDR-016, SLE-024 §6.2 |
| **design node** | DAG node where the Designer role produces architecture decisions and system shape. Critic may review here at deep/research depth | SLE-024 §5.1 |
| **Designer** | Agent role at the DESIGN node. Produces architecture, system shape, and component boundaries. Owns the architecture artifact | DDR-019, [agent-roles.md](agent-roles.md) |
| **discovery** | A one-time structured session (`sle discover`) that produces 6–8 foundational documents all subsequent cycles depend on | SLE-011 |
| **document** | A project-scoped entity in the knowledge graph (e.g. `decisions.md`, `README`). Lives in `.sle/project-docs/`. Distinct from nodes and source files | DDR-013 |
| **eval-check** | See *exec-check* | |
| **Evaluator** | Agent role at the EVALUATE node. Produces a structured verdict on whether the implementation satisfied the user's intent | [agent-roles.md](agent-roles.md), SLE-024 §4.2 |
| **exec-check** | The executable validation sub-phase — generated test scripts run in an isolated Docker container. No LLM involvement | SLE-003, SLE-024 §5.4 |
| **execution plane** | Tier 4 — the execution environment for generated scripts and Docker containers. Pure execution, no LLM | SLE-001, [architecture.md](architecture.md) |
| **Execution tier** | See *tier (platform)* | |
| **Executor** | The Debug node's agent role. See *Debugger* | |
| **EXPLORE node** | Conditional DAG node activated when unknowns are flagged in the intent or by the daemon. The Explorer role investigates before design begins | DDR-023, SLE-024 §5.1 |
| **Explorer** | Agent role at the EXPLORE node (conditional). Produces research findings, spike results, and benchmarks injected into Designer context | DDR-023, [agent-roles.md](agent-roles.md) |
| **Facilitator** | The only agent role active in discovery and chat sessions. Asks questions, captures decisions; never builds or plans | SLE-011, SLE-012 |
| **FailureReport** | A structured summary of validation failure: cycle/iteration numbers, run directory pointer, failed and passed categories, quick summary | SLE-022 |
| **gate** | A decision point in the DAG where the cycle branches based on outcomes. Two types exist: CONFIRM GATE and VALIDATION GATE | SLE-024 §5.2 |
| **gate (CONFIRM)** | Human approval point after TEST, before BUILD. User can approve, modify (sending back to TEST), or halt | SLE-024 §5.2 |
| **gate (VALIDATION)** | Machine decision point after EXEC. Deterministic boolean logic on all category results — no LLM involved. Pass → EVALUATE; fail → DEBUG → retry | SLE-024 §5.2 |
| **group** | A feature-scoped collection of nodes in the knowledge graph. Each group stacks nodes across the 8 lifecycle layers | SLE-016 |
| **historian** | Agent role that runs after every agent turn, appending a 2–3 sentence audit entry to `decisions.md`. Under review for potential replacement by structured logging | SLE-024 §4.2 |
| **host tier** | Tier 0 — the stable server base (Debian, SSH, tmux, Docker). Never project-specific | SLE-001, [architecture.md](architecture.md) |
| **inferred mode** | Context assembly using role-based artifact slice defaults when no declared tasks exist. Fallback for ad-hoc cycles | DDR-016, SLE-024 §6.2 |
| **intent** | The user's goal for a cycle, passed as a string to `sle start`. Includes optional planning depth override and session ID | SLE-002 |
| **interface tier** | Tier 1 — the developer-facing surfaces: CLI, web app, Obsidian plugin. Thin clients; no system logic lives here | SLE-001, [architecture.md](architecture.md) |
| **iteration** | One full BUILD → EXEC → VALIDATION GATE attempt within a cycle. Increments when the VALIDATION GATE fails | SLE-024 §5.3 |
| **layer** | A content-organization category within a group in the knowledge graph. The 8 baseline layers are: Research, Spikes, Design, Plans, Implementation, Code, Notes, Hosting | DDR-012, [architecture.md](architecture.md) |
| **layer status** | The fill state of a lifecycle layer within a group: `filled \| partial \| empty \| not_applicable` | DDR-012 |
| **lifecycle layer** | See *layer*. Qualified form used when disambiguation from platform tiers is needed | DDR-012 |
| **link index** | The daemon subsystem that maintains bidirectional `[[wikilink]]` connections between nodes, documents, and source files. Serves as agent working memory | SLE-017, DDR-018 |
| **llm-check** | The LLM validation sub-phase — semantic correctness check per category. Runs in Tier 3 (agent runtime) | SLE-003, SLE-024 §5.4 |
| **map.yaml** | Auto-generated system-state file, regenerated after every DAG node. Read by all agents as the second half of the bootstrap pair. Never edited by humans | SLE-001 |
| **module** | A registered content processor in the modular dashboard system. Fires on configured triggers (node type, state, layer, group) | SLE-015 |
| **node** | A group-scoped work unit in the knowledge graph, tied to one lifecycle layer (e.g. the "Rate Limiting" group's architecture node). Lives in `.sle/project-graph/layers/` | DDR-013 |
| **phase (project)** | A milestone chunk of work in `docs/project-plan.md` spanning multiple cycles (Phase 1, Phase 2, …). Do not confuse with validation sub-phases | SLE-011 |
| **planning depth** | Configuration controlling reasoning passes, Critic activation, and artifact slice size. Four levels: `minimal \| standard \| deep \| research` | SLE-004, SLE-024 §6.1 |
| **Planner** | Agent role at the PLAN node. Receives requirements + architecture + decisions + evaluation; produces specific implementation steps and test-plan | DDR-019, [agent-roles.md](agent-roles.md) |
| **platform tier** | See *tier (platform)* | |
| **revision** | A plan modification made by the user at the CONFIRM GATE within one iteration. Resets to TEST for re-derivation | SLE-024 §5.3 |
| **round** | A single interaction step within a discovery session (Round 1–4) | SLE-011 |
| **rule file** | One of the YAML configuration files in `.sle/rules/` that governs system behavior at runtime. Seven files: planning, validation, artifacts, exit, user_validation, summary, agents | SLE-004, DDR-002 |
| **run** | One execution of the EXEC phase — produces a run artifact directory under `.sle/runs/{id}/` | SLE-022 |
| **run artifact** | Structured outputs from a validation run: manifest.json, context-pack.md, test results, metrics, traces, logs | SLE-022 |
| **session** | One unit of interaction with the system. Three types: discovery, chat, cycle | SLE-024 §3 |
| **snapshot** | The locked, versioned artifact set produced on cycle completion. Identified by a version ID | SLE-002 |
| **source file** | A filesystem file (e.g. `src/middleware/rate-limit.ts`) linked as a target from code-layer nodes. Not embedded in the graph | DDR-013 |
| **static-check** | The static analysis validation sub-phase — lint, typecheck, complexity. Runs first; blocks llm-check and exec-check if it fails | SLE-003, SLE-024 §5.4 |
| **sub-phase** | One of the three validation checks within a category: static-check, llm-check, exec-check. Do not call these "phases" (reserved for project milestones) | SLE-024 §5.4 |
| **SystemStatus** | The daemon's top-level state value: `idle \| discovering \| cycling \| confirming \| halted \| complete`. Exactly one is active at any time | SLE-024 §2 |
| **Tester** | Agent role at the TEST node. Produces executable test scripts from requirements and test-plan only. Never sees Builder implementation or architecture — this is the TDD separation | DDR-010, [agent-roles.md](agent-roles.md) |
| **three-remote model** | Code remote (git) + issues remote (Dolt/Beads) + docs remote (git at `.server/`) — three independent histories, never merged | SLE-001 |
| **tier (platform)** | A system-architecture tier in the 5-tier stack. Tiers 0–4: Host, Interface, Daemon, Agent Runtime, Execution Plane. Qualified form: "platform tier" | DDR-004, [architecture.md](architecture.md) |
| **tier 0 — host** | The stable server base (Debian, SSH, tmux, Docker). Never project-specific. Platform tier | |
| **tier 1 — interface** | Developer-facing surfaces: CLI, web app, Obsidian plugin. Thin clients. Platform tier | |
| **tier 2 — daemon** | The SDK daemon (@sle/sdk, port 7700). The only tier that knows everything: DAG runner, rule loader, context manager, artifact store, Beads bridge, gate logic. Platform tier | |
| **tier 3 — agent runtime** | LLM calls and structured outputs. All agent roles execute here. Platform tier | |
| **tier 4 — execution plane** | Generated scripts and Docker containers. Pure execution, no LLM. Platform tier | |
| **token budget** | Hard cap on tokens per component in an agent's context window. The full assembled context is capped at 4000 tokens | SLE-007 |
| **validation** | The process of checking that a cycle's output meets all configured criteria across active categories | SLE-003 |
| **validation category** | See *category*. A named concern with its own sub-phases and pass criteria, declared in `validation.yaml` | SLE-003, SLE-004 |
| **wikilink** | The `[[target]]` syntax used to create bidirectional links between nodes, documents, and source files in the knowledge graph | DDR-013, SLE-017 |

---

### About qualified terms

When two concepts could share a name, this glossary assigns a **primary term**
to the more frequently referenced concept and a **qualified form** for
disambiguation. The primary term should be used unqualified in context where no
ambiguity exists. The qualified form should be used in cross-cutting or
introductory documents.

| Primary term | Qualified form | Disambiguated from |
|-------------|----------------|-------------------|
| tier | platform tier | lifecycle layer |
| layer | lifecycle layer | platform tier |
| phase | project phase (or just "phase") | validation sub-phase |
| node | DAG node / graph node | DAG node when in cycle context; graph node when in knowledge-graph context |

---

## Contested terms

These terms required resolution because two specs used the same word for
different concepts. The chosen naming is listed below.

### G03 — "layer" naming collision

**The collision.** Two unrelated architectural concepts share the word "layer":

| Concept | Old name | What it means | Count |
|---------|----------|--------------|-------|
| System-architecture stack (Host, Interface, Daemon, Agent Runtime, Execution Plane) | "platform layer" (Layer 0–4) | Infrastructure tiers the daemon runs on and through | 5 |
| Knowledge-graph content categories within a group (Research, Spikes, Design, Plans, Implementation, Code, Notes, Hosting) | "lifecycle layer" | Artifact organization within the product graph | 8 + custom |

Using unqualified "layer" for both creates ambiguity. When a spec says "this
operates at Layer 3" it is unclear whether that refers to the agent runtime tier
or a lifecycle content band.

**Proposed resolution (pending human confirmation):**

- Rename platform layers to **tiers** (Tier 0–4). This aligns with the
  conventional meaning of "tier" as an infrastructure stack level. The v2
  docs already use "tier" in this glossary and in `architecture.md`.
- Keep lifecycle layers as **layers**. The 8 baseline layers (DDR-012) are
  already widely referenced as layers in SLE-016, SLE-017, and the knowledge
  graph. "Layer" naturally conveys horizontal content bands within a group.
- Use qualified forms when disambiguation is needed: "platform tier" and
  "lifecycle layer."

| Concept | Chosen term | Qualified form |
|---------|------------|----------------|
| Infrastructure stack (0–4) | tier | platform tier |
| Content categories in a group | layer | lifecycle layer |

**Status:** Accepted (2026-04-17). Platform layers → tiers, lifecycle layers → layers.

### DDR-012 — Baseline lifecycle layers

The 8 fixed layers are standard for every project. Users can add custom layers
per-project (not per-group), which appear after Hosting in the group stack.

| # | Layer | What it holds |
|---|-------|-------------|
| 1 | Research | Exploration findings, external references, spike results |
| 2 | Spikes | Time-boxed investigations with clear pass/fail outcomes |
| 3 | Design | Architecture decisions, system shape, component boundaries |
| 4 | Plans | Implementation steps, test-plans, context declarations |
| 5 | Implementation | Source code, configuration, generated scripts |
| 6 | Code | File metadata (path, line count, coverage) linking to source files |
| 7 | Notes | Documentation, operational runbooks, inline knowledge |
| 8 | Hosting | Deployment config, infrastructure definitions, environment specs |

Custom layers: user-defined, project-scoped, appear after Hosting. Names must
not collide with the baseline 8. AI can suggest custom layers but user must
approve.

### DDR-013 — Document vs node vs source file

| Entity | Scope | Storage | Who writes |
|--------|-------|---------|-----------|
| **Document** | Project | `.sle/project-docs/` | Human or Facilitator (discovery) |
| **Node** | Group | `.sle/project-graph/layers/` | SLE cycle agents |
| **Source file** | Filesystem | `src/`, `scripts/`, etc. | Builder role; linked from code-layer nodes |

All three entity types connect via `[[wikilink]]` with bidirectional backlinks.
SLE cycles can create and modify nodes freely but can only suggest document
changes (user approval required).

### "Phase" reservation

The word **phase** is reserved for project milestones (Phase 1, Phase 2, …) as
defined in `docs/project-plan.md`. Validation sub-steps are called **sub-phases**
(static-check, llm-check, exec-check) — never "phases." This prevents confusion
between project-level milestones and per-category validation steps.

### "Node" dual usage

The word **node** appears in two contexts:

1. **DAG node** — a step in the cycle's directed acyclic graph (INTENT, DESIGN,
   PLAN, BUILD, etc.). Always qualified as "DAG node" in cycle-context docs.
2. **Graph node** — a work unit in the knowledge graph, scoped to a group and
   tied to a lifecycle layer. Always qualified as "graph node" or just "node"
   in knowledge-graph contexts.

Both are correct uses of "node." The disambiguating prefix (DAG vs graph)
should be used on first mention in any document that could touch both concepts.

### Alternative G03 resolutions not chosen

For completeness, these alternatives were considered and rejected in favour of
the tier/layer split:

| Alternative | Why rejected |
|-------------|-------------|
| Rename lifecycle layers to "phases" | "Phase" is already reserved for project milestones (DDR-012, SLE-011). Adding a third meaning would worsen collision |
| Rename lifecycle layers to "domains" | "Domain" carries DDD connotations (bounded context, domain model) that don't match the content-organization meaning |
| Rename lifecycle layers to "bands" | Unconventional term; adds a novel concept where an existing one ("layer") already fits naturally |
| Keep both as "layer" with mandatory qualifiers | Prone to dropped qualifiers over time; readers will skim past the adjective and land on the noun |
| Rename platform layers to "stack levels" | Verbose; "stack level" is not a widely used term in architecture literature. "Tier" is more conventional |

## See also

- [types.md](../specs/types.md) — canonical type definitions for all enums,
  interfaces, and data structures referenced in this glossary
- [state-machine.md](../specs/state-machine.md) — state terminology and
  transition definitions (`SystemStatus`, cycle states, gate outcomes)
- [context-manager.md](../specs/context-manager.md) — loading mode
  terminology (declared mode vs inferred mode, artifact slicing)
