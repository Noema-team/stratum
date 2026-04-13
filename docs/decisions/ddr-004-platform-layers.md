# DDR-004 — Platform layer placement

**Date:** 2026-04-13 · **Status:** accepted
**Resolves:** —

## Context
SLE needs to be placed within the existing 4-layer platform architecture (Layer 1: infrastructure, Layer 2: AI Executor, Layer 3: applications, Layer 4: CLI/UI).

## Options considered
| Option | Pros | Cons |
|--------|------|------|
| SLE primarily at Layer 3, delegates execution to Layer 2 | Reuses AI Executor as-is; clean separation of concerns | Execution requires cross-layer communication |
| SLE at Layer 2 alongside the AI Executor | Tighter coupling with execution | Breaks the platform boundary rule; SLE is an application not an executor |
| SLE entirely at Layer 4 | Simpler for CLI-driven workflows | No daemon process; loses background capability |

## Decision
SLE lives primarily at Layer 3, delegates execution to Layer 2.

## Consequences
- CLI (`sle run`, `sle status`) at Layer 4
- SDK daemon (DAG runner, context manager, rule loader) at Layer 3
- Agent runtime (LLM calls) at Layer 3 inside daemon process
- Execution plane (generated test scripts) at Layer 2 — submitted to AI Executor
- Cycle metadata and iteration history in Layer 1 PostgreSQL (`sle_*` tables)
- Event streaming and approval gates in Layer 1 Redis pub/sub
- Artifact snapshots and reports in Layer 1 MinIO
- The AI Executor is reused as-is and does not know about SLE
