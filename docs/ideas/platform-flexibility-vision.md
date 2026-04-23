# Platform Flexibility Vision

Open-source roadmap for transforming SLE from an opinionated dev tool into a
configurable workflow platform.

---

## Core Idea

SLE's engine — DAG runner, gate evaluator, loop handler, step executor — is
domain-agnostic. The software development lifecycle is just one application of
it. By exposing the configuration layer, users can define their own flows for
any structured AI workflow.

## User-Configurable Primitives

| Primitive | Description |
|-----------|-------------|
| **Steps** | Callable units — LLM call, script, API request, human approval, arbitrary function |
| **Gates** | Boolean checkpoints between steps — validation, approval, quality checks, custom predicates |
| **Loops** | Retry/iterate on failure — max iterations, backoff strategy, exit conditions |
| **Layers** | User-defined visual/organizational groupings in the graph (not hardcoded to 5) |
| **Transitions** | Rules that move a node from one state to another — custom per flow |

## Example Use Cases

| Use Case | Flow |
|----------|------|
| Software dev cycle (current SLE) | plan → build → validate → evolve |
| Code review pipeline | lint → AI review → human gate → merge |
| Content production | research → draft → fact-check gate → edit → publish |
| Data pipeline | extract → transform → validate gate → load → monitor |
| QA automation | generate tests → run → coverage gate → report → fix loop |
| Research workflow | hypothesis → literature search → synthesis → peer review gate → document |

All built on the same engine, defined in configuration.

## Build Order: Opinionated First, Flexible Second

### Phase 1 — Ship Opinionated (Month 1-2)

Build SLE as a focused dev tool with hardcoded flow. Make it excellent at one
thing. Ship it, get users, learn what they actually want to change.

Goals:
- Working dev cycle: intent → plan → build → validate → gate
- Strong defaults, minimal config
- Real users running real cycles

### Phase 2 — Identify Seams (Month 3-4)

Extract the first extension points based on what users ask to customize. The
seams become the configuration surface.

Likely candidates:
- Custom step types (users want to add their own tools)
- Gate predicates (users want domain-specific quality checks)
- Loop strategies (users want different retry behavior)
- Layer definitions (users want different graph views)

### Phase 3 — Open Configuration (Month 5+)

Expose the configuration layer: YAML/JSON flow definitions, custom step types,
pluggable gates, user-defined layers. By this point abstractions are informed
by real usage.

Configuration surface:
- Flow definition files (steps, gates, loops, transitions)
- Step type registry (built-in + user plugins)
- Gate library (composable predicates)
- Layer schema (user-defined graph structure)
- Prompt template overrides per step

## Architectural Principle: Engine / Domain Split

From day one, separate:

- **Engine** (`@sle/engine`) — DAG runner, gate evaluator, loop handler, step
  executor, event bus. Knows nothing about software development.
- **Domain** (`@sle/dev-flow`) — the software development lifecycle as a
  configuration of the engine. Step definitions, agent roles, prompt templates,
  validation rules.

Even if tightly coupled at first, keeping them in separate packages makes the
extraction clean and allows third-party domain packs later
(`@sle/content-flow`, `@sle/data-pipeline`, etc.).

## Open Source Strategy

- **MIT or Apache 2.0 license** — permissive, encourages adoption
- **Monorepo** with clear package boundaries
- **Plugin API** as a public interface — semantically versioned, documented
- **Domain packs** as separate installable packages (`npm install @sle/dev-flow`)
- **Community flows** — curated registry of user-submitted flow configurations

## Risks

**Over-abstracting early.** The most common platform failure mode is building
for flexibility before understanding what users actually need to change. The
opinionated-first approach mitigates this: real usage drives abstraction.

**Configuration complexity.** A system that can do anything often does nothing
well out of the box. Every flow should have a one-command quickstart with sane
defaults. Opinionated defaults with escape hatches, not blank slates.

**Scope creep.** The platform vision expands the surface area enormously. Resist
building for hypothetical use cases. Ship the dev tool, let demand pull the
platform features out.
