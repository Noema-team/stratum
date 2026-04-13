# DDR-009 — Static analysis as validation sub-phases

**Date:** 2026-04-13 · **Status:** accepted
**Resolves:** —

## Context
Static analysis (linting, type checking, complexity) needs to be integrated into the validation cycle. A decision was needed on where and how these checks run.

## Options considered
| Option | Pros | Cons |
|--------|------|------|
| Three static analysis checks run inside test container BEFORE executable tests | Fails fast; no point running tests on code that doesn't compile or has lint errors | Adds steps before test execution |
| Static analysis runs after tests | Tests execute sooner | Wastes time running tests on code with compile errors |
| Static analysis runs as a separate parallel phase | Faster overall | More complex orchestration; requires separate environment |
| No static analysis in MVP | Simplest | Misses obvious code quality issues |

## Decision
Three deterministic static analysis checks (lint, typecheck, complexity) run inside the test container BEFORE the executable test phase.

## Consequences
- Commands are determined at `sle init` based on project type and can be overridden in `.sle/rules/validation.yaml`
- Static analysis runs first; if any check fails, the cycle skips executable tests and goes straight to the gate with a FailureReport
- Configuration lives in `validation.yaml` under `static_analysis:` with per-check commands, enabled flags, and pass criteria
- These are deterministic tool runs (not LLM-powered) producing structured output
