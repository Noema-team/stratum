# DDR-011 — Plan modification at CONFIRM gate

**Date:** 2026-04-13 · **Status:** accepted
**Resolves:** —

## Context
Users need a human-in-the-loop checkpoint to review and modify the plan and test suite before any code is written. The question is what modifications are allowed and how the system responds.

## Options considered
| Option | Pros | Cons |
|--------|------|------|
| Allow structured plan modifications at CONFIRM gate with re-derivation | Primary human checkpoint; system stays consistent; hybrid TDD contract preserved | More complex gate logic |
| Read-only review at CONFIRM gate (approve/reject only) | Simpler | No way to correct plan issues without restarting the cycle |
| Allow modifications at any gate | Maximum flexibility | Breaks validation chain; stale tests possible |
| Allow direct raw file editing | Unrestricted | Inconsistent state; hard to validate |

## Decision
Users can modify the proposed plan at the CONFIRM gate (between TEST and BUILD) through a structured API. Modifications trigger re-derivation of downstream artifacts to maintain system consistency.

## Consequences
- Allowed modifications: edit step descriptions, reorder steps, add/remove steps, edit test acceptance criteria
- Modification triggers re-derivation: plan changes → re-run TEST phase → regenerate affected tests → CONFIRM again
- Multiple revision rounds allowed; unchanged categories keep cached results
- Excluded from MVP: editing code at post-BUILD gates, modifying DAG structure, modifying validation rules mid-cycle, direct artifact editing
- Daemon endpoint: `POST /cycle/:id/revise` with `PlanModification` payload
