# DDR-025 — Typed prefix for artifact slice references

**Date:** 2026-04-17 · **Status:** accepted
**Resolves:** G30

## Context

SLE-017 introduces a document/node split: documents are project-scoped entities (e.g., `requirements.md`), nodes are group-scoped entities (e.g., the "Rate Limiting" group's architecture node). Both can contain sections that agents need. SLE-007's artifact slices reference artifacts by key (e.g., `requirements`, `architecture`) with no way to distinguish between a project-level document and a group-level node. If both share the same key, the context manager has no rule for which to load.

## Options considered

| Option | Format | Example | Pros | Cons |
|--------|--------|---------|------|------|
| A | Typed prefix | `doc:requirements`, `node:rate-limiting:architecture` | Unambiguous, machine-parseable, consistent | Verbose |
| B | Default to doc, explicit for nodes | `requirements` (doc), `node:rate-limiting:architecture` | Shorter for common case | Two formats to remember; implicit behavior |
| C | Path-based | `docs/requirements.md`, `nodes/rate-limiting/architecture` | Maps to filesystem, familiar | Ties context assembly to file layout; breaks if storage changes |

## Decision

All artifact slice references use a typed prefix. `doc:{key}` for project-level documents, `node:{group}:{key}` for group-level nodes.

## Consequences

- Reference format: `doc:requirements`, `doc:architecture`, `node:rate-limiting:architecture`, `node:auth:implementation`
- Context manager resolves `doc:` references against `.sle/project-docs/`
- Context manager resolves `node:` references against `.sle/project-graph/layers/`
- SLE-007 slice definitions use this format throughout
- SLE-008 prompt templates use this format when referencing artifacts
- map.yaml `artifacts.files` entries gain a `scope` field: `project` or `group`
- Wildcard references are allowed: `node:*:architecture` loads architecture nodes from all groups (use with caution due to token budget)
- Existing references without a prefix are migration baggage — treat as `doc:` for backward compatibility during transition, then remove
