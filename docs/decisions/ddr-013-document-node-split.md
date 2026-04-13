# DDR-013 — Document / node split & linking

**Date:** 2026-04-13 · **Status:** accepted
**Resolves:** SLE-017

## Context
The system needs to distinguish between group-scoped nodes, project-scoped documents, and filesystem source files. A decision was needed on scope, ownership, and how these entity types connect.

## Options considered
| Option | Pros | Cons |
|--------|------|------|
| Nodes (group scope), documents (project scope), source files (linked targets, not graph nodes) | Clear separation of scope and ownership; source files stay on filesystem | More entity types to manage |
| Everything as graph nodes | Uniform model | Source files don't belong in the graph; breaks separation of concerns |
| Nodes and documents only, source files embedded | Simpler model | Bloats graph with file contents |

## Decision
Nodes have group scope, documents have project scope, and source files are linked targets not embedded in the graph.

## Consequences
- Nodes live in `.sle/project-graph/layers/` (e.g., spikes, plans, requirements, code metadata)
- Documents live in `.sle/project-docs/` (e.g., README, decisions.md, architecture overview, style guide)
- Source/test files live on the filesystem (e.g., `src/middleware/rate-limit.ts`)
- All three entity types connect via `[[wikilink]]` syntax with bidirectional backlinks
- SLE cycles can create/modify nodes freely but can only suggest document changes (user approval required)
- Code layer nodes hold metadata (path, line count, coverage) and link to actual files
