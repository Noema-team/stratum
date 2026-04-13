# DDR-008 — Isolated Docker container per validation cycle

**Date:** 2026-04-13 · **Status:** accepted
**Resolves:** —

## Context
Validation cycles need a clean, reproducible execution environment. A decision was needed on container scope and lifecycle.

## Options considered
| Option | Pros | Cons |
|--------|------|------|
| Fresh Docker container per validation cycle | Clean state every cycle; no artifacts leak between cycles; simpler lifecycle | Container creation overhead per cycle |
| Fresh container per validation category | More isolated per check | More complex lifecycle management |
| Shared container across cycles | Faster startup | Artifacts can leak between cycles; state pollution |
| Run directly on host | Simplest; no Docker dependency | No isolation; environment differences between runs |

## Decision
Each validation cycle runs in a fresh Docker container built from a framework-specific base image determined at `sle init`.

## Consequences
- Container lifecycle: create → build → dependency install → lint/typecheck/complexity → test execution → results captured → destroy
- All checks run in the same environment per cycle
- Container is separate from deployment — exists only for verification
- New dependency: Docker API client in SLE daemon (Docker Engine API via Unix socket)
- Base images are framework-specific (e.g., `node:20-slim` for Node, `python:3.12-slim` for Python)
