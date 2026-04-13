# DDR-006 — Security validation — deferred

**Date:** 2026-04-13 · **Status:** accepted
**Resolves:** —

## Context
The validation architecture supports adding categories via `validation.yaml`. A decision was needed on whether to include a `security` category in the MVP.

## Options considered
| Option | Pros | Cons |
|--------|------|------|
| Defer security validation to post-MVP | Reduces MVP complexity; architecture already supports adding it later | No security checks in first release |
| Include security validation in MVP | More thorough validation from the start | Requires dependency audit tooling, input sanitization checks, and potentially SAST integration — unjustified complexity for first build |

## Decision
Security validation (SQL injection, auth bypass, surface area analysis) is explicitly post-MVP. The validation architecture supports adding a `security` category via `validation.yaml`, but the MVP ships with `correctness` only.

## Consequences
- MVP ships with `correctness` as the only validation category
- The `security` category will require dependency audit tooling, input sanitization checks, and potentially SAST integration when added post-MVP
- The architecture is designed to accommodate this addition without structural changes
