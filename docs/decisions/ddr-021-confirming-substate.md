# DDR-021 — Confirming is a flag on the cycle record, not a top-level state

**Date:** 2026-04-17 · **Status:** accepted
**Resolves:** G21

## Context

SLE-024 §2 draws `confirming` as a peer node of `idle`, `cycling`, and `halted` in the state diagram, but its own notes state "`confirming` is a sub-state, not a full system state." This contradiction makes the state machine unimplementable — code that branches on `meta.status === 'confirming'` would behave differently depending on whether the implementation treats it as a peer or a sub-state.

The CONFIRM gate sits between TEST and BUILD in the DAG. When reached, the cycle pauses for human approval. Conceptually, the cycle hasn't stopped — it's paused at a specific point within an active cycle.

## Options considered

| Option | Model | `meta.status` | Pros | Cons |
|--------|-------|---------------|------|------|
| A | Top-level state | `confirming` | Explicit, easy to query "is system waiting?" | Breaks on restart (special resume logic needed), conceptually misleading (cycle hasn't ended) |
| B | Flag on cycle record | stays `cycling` | Simpler state machine, cleaner restart, consistent with DDR-020 decision model | Must check cycle record to detect waiting state, not just `meta.status` |

## Decision

`confirming` is not a system state. It is expressed as `cycle.awaiting_confirmation: boolean` on the cycle record. `meta.status` remains `cycling` throughout. The Facilitator enters decision mode (per DDR-020) when this flag is true.

## Consequences

- System states are now: `idle | discovering | cycling | halted | complete`
- `confirming` is removed from the state machine diagram
- `map.yaml` adds `cycle.awaiting_confirmation: boolean`
- Daemon restart during a gate: system reads `cycle.awaiting_confirmation`, re-enters decision mode at the correct gate — no special state transition logic needed
- UI queries `cycle.awaiting_confirmation` (not `meta.status`) to determine if a decision is pending
- The same pattern applies to other pause points (e.g., sharding approval could use `cycle.awaiting_sharding_approval`)
- SLE-024 §2 and map-yaml-schema.md must be updated to remove `confirming` from the state enum
