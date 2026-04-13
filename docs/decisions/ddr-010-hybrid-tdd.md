# DDR-010 — Hybrid TDD — tests designed before build, verified after

**Date:** 2026-04-13 · **Status:** accepted
**Resolves:** —

## Context
SLE's cycle needs a test strategy. Pure TDD means tests never adapt after initial creation, while post-build testing risks biased tests.

## Options considered
| Option | Pros | Cons |
|--------|------|------|
| Hybrid TDD — tests designed before build, verified after | Tests are unbiased (requirements-only); LLM validation acts as second opinion; gate can flag uncovered requirements | Not pure TDD |
| Pure TDD — tests never change after initial creation | Strict test-first discipline | Requirements may be ambiguous; some test coverage gaps only appear after seeing code |
| Post-build testing — tests written after implementation | Tests can cover implementation details | Tests may be biased toward the implementation |

## Decision
The Tester agent generates the primary test suite from requirements BEFORE the Builder writes code (TDD-style), with the LLM validation phase acting as a second opinion after build.

## Consequences
- Full flow: Planner → Tester (generates tests from requirements) → Builder (writes code to satisfy tests) → static analysis → test execution → LLM validation → gate
- Tester stays unbiased by reading requirements only
- LLM validation phase catches issues the Tester missed
- Requirement coverage tracking is an open design question — each test should be tagged with the requirement it covers
- Gate should verify every requirement has at least one corresponding test ID
