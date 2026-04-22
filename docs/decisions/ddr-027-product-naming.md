# DDR-027 — Product naming: Stratum

**Date:** 2026-04-22 · **Status:** accepted
**Resolves:** Confusion from directory name (`sdk-orchestrator`) not matching internal name (`SLE`)

## Context

The product had two names in active use:
- **`sdk-orchestrator`** — directory name, vague, sounds like internal infrastructure
- **`SLE` (Software Lifecycle Engine)** — used in docs, generic, collides with SUSE Linux Enterprise

Neither name reflected the core visual/architectural identity of the product: a **layered, multi-dimensional DAG** where nodes are organized into groups (layers), giving the graph depth (2.5D–3D structure).

## Options considered

| Option | Pros | Cons |
|--------|------|------|
| **Stratum** | Latin for "layer" — directly maps to layered DAG groups; clean CLI (`stratum init`, `stratum run`); distinctive; no known collision | Less "graph" in the name |
| Graphite | Graph root + "write" metaphor; graphite is stacked 3D layers (matches DAG groups) | Collides with graphite.dev (code review tool) |
| Graphene | Graph family, cutting-edge | Graphene is explicitly 2D (single atom layer) — contradicts the 2.5D/3D DAG structure |
| Graphenix / Graphex | Graph-rooted, distinctive | Invented words, harder to remember |
| Loom | Short, weaving metaphor | Doesn't convey graph/layered structure |
| Vertex | Graph node, clean | Google Vertex AI collision |
| Lattice | 3D interconnected structure | Generic, overused in tech |

## Decision

The product is named **Stratum**.

Key naming assets:
- **CLI:** `stratum` (e.g., `stratum init`, `stratum run`, `stratum discover`)
- **Package:** `@stratum/sdk`
- **Directory:** rename `sdk-orchestrator/` → `stratum/` (or `stratum/docs/`)

Rationale: Stratum literally means "a layer" — the DAG groups ARE strata. A multi-layered graph of strata is the exact mental model. The word is short (7 letters), memorable, easy to type, and unclaimed in the developer tools space.

## Consequences
- All docs, CLI commands, and package names migrate from SLE/sdk-orchestrator to Stratum
- The internal concept of "layers" now has a direct linguistic anchor
- `sdk-orchestrator/` directory should be renamed to align
