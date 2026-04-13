# DDR-007 — Separate Tester agent — Builder does not write tests

**Date:** 2026-04-13 · **Status:** accepted
**Resolves:** —

## Context
The original DAG had PLAN → BUILD → VALIDATE. A decision was needed on who writes tests — the Builder or a dedicated agent.

## Options considered
| Option | Pros | Cons |
|--------|------|------|
| Dedicated Tester agent separate from Builder | Tests are unbiased (requirements-only); prevents tests from being biased toward implementation | Additional agent in the DAG |
| Builder writes tests alongside implementation | Fewer agents; simpler DAG | Tests may be biased toward the implementation rather than testing what was asked for |

## Decision
Introduce a Tester agent as a distinct role from the Builder. The Builder produces implementation only; the Tester produces test scripts only.

## Consequences
- DAG gains a `TEST` node: `PLAN → TEST → BUILD → VALIDATE_LLM → VALIDATE_EXEC → GATE`
- Tester reads requirements only — never sees the Builder's output — preventing biased tests
- Tester generates one test script per active validation category, defines pass criteria and test IDs
- Tester does NOT run tests (Execution Plane handles that) and does NOT review implementation (LLM validation phase does that)
- Test scripts are passed to both the Builder (as a contract to satisfy) and the Execution Plane (as scripts to run)
