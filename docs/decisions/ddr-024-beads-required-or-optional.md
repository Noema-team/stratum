# DDR-024 — Local task fallback when Beads is unavailable

**Date:** 2026-04-17 · **Status:** accepted
**Resolves:** G29

## Context

SLE-019's task sharding pipeline produces tasks, then maps them to Beads issues. If Beads is unavailable (no DoltHub account, local-only mode), tasks are created but have no Beads issue IDs. The context manager uses `bd ready` to surface available tasks — in local-only mode it returns nothing, making sharded tasks effectively lost.

This blocks local-only users from using the intake pipeline entirely, which contradicts the project's local-first philosophy.

## Options considered

| Option | Model | Pros | Cons |
|--------|-------|------|------|
| A | Beads required | Full feature parity, simpler code | Local-only users can't use intake pipeline |
| B | Local fallback (`.sle/tasks.yaml`) | Works without Beads, local-first friendly, follows DDR-005 pattern | Two code paths; no cross-device sync |
| C | Beads required for MVP, local fallback post-MVP | Ships faster | Local-only users blocked until post-MVP |

## Decision

Support local fallback via `.sle/tasks.yaml`. Abstract behind a `TaskStore` provider interface with two implementations: `BeadsTaskStore` and `LocalTaskStore`. This follows the same optional-provider pattern as DDR-005 (Cognee with `NoopProvider`).

## Consequences

- `TaskStore` interface defines: `createTask`, `getReadyTasks`, `updateStatus`, `closeTask`, `getStale`
- `BeadsTaskStore` delegates to `bd` CLI commands (existing behavior)
- `LocalTaskStore` reads/writes `.sle/tasks.yaml` using the same `SLETask` schema
- Task selection is configured at `sle init`: user chooses Beads or local
- Context manager reads from whichever store is active — no code changes in context assembly
- `bd ready` equivalent works in local mode (daemon reads `.sle/tasks.yaml` directly)
- Staleness detection (G35) works in both modes — Beads via `STALE:` prefix, local via `stale: true` field
- Degraded features in local mode: no cross-device sync, no DoltHub UI, no `bd dolt push` for tasks
- `guides/local-only-mode.md` documents which features are degraded
