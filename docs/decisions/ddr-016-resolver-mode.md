# DDR-016 — Context manager — resolver mode for declared tasks

**Date:** 2026-04-13 · **Status:** accepted
**Resolves:** SLE-007, SLE-019 (Part 7)

## Context
The context manager (SLE-007) needs to determine what context is relevant for a task. The question is whether it should infer context or resolve explicit declarations.

## Options considered
| Option | Pros | Cons |
|--------|------|------|
| Two modes: resolver (declared tasks) and inference (legacy) | Precise context for sharded tasks; backward compatible with un-sharded cycles | Two codepaths to maintain |
| Resolver mode only | Single codepath; precise context | Breaks backward compatibility with un-sharded cycles |
| Inference mode only | Simpler; no task declarations needed | Context manager has to guess what's relevant; less precise |

## Decision
The context manager operates in two modes: resolver mode (for tasks with explicit `TaskContextDeclaration` from SLE-019 sharding) and inference mode (legacy path for cycles without sharded task declarations).

## Consequences
- Resolver mode is always preferred — it resolves declared document sections precisely with no inference or truncation surprises
- Inference mode is preserved for backward compatibility with un-sharded cycles
- The context manager should never have to guess what's relevant when resolver mode is used
- Tasks produced by the SLE-019 intake pipeline always carry explicit context declarations
