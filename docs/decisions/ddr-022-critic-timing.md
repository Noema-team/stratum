# DDR-022 — Critic reviews at DESIGN node, not PLAN node

**Date:** 2026-04-17 · **Status:** accepted
**Resolves:** G16

## Context

SLE-001 and SLE-002 place the Critic after the Planner (post-PLAN review). SLE-024 moves the Critic to the DESIGN node, reviewing architecture before planning begins. With DDR-019 deciding that the Designer owns both `architecture.md` and `requirements.md`, the Critic's review target at DESIGN is now clearly defined.

Reviewing at DESIGN is higher leverage: a flawed architecture produces bad plans regardless of how well they're written. Catching structural issues before planning prevents wasted work in PLAN, TEST, and BUILD.

## Options considered

| Option | Timing | Reviews | Pros | Cons |
|--------|--------|---------|------|------|
| A | DESIGN node | Architecture + requirements | Catches structural issues early; prevents wasted planning work | Misses plan-level issues (step ordering, test gaps) |
| B | PLAN node | Plan + test-plan | Catches plan-specific issues | Structural issues cascade — wasted planning work before review |
| C | Both (two reviews) | Architecture at DESIGN, plan at PLAN | Catches everything | Double LLM cost and cycle time |

## Decision

The Critic runs once at the DESIGN node, reviewing the Designer's output (`architecture.md` + `requirements.md`).

## Consequences

- Critic is triggered after DESIGN node completes, before PLAN node begins
- Critic reads: architecture + requirements + project context + decisions
- Critic does NOT review the Planner's output — plan-level issues surface during execution and the gate
- DAG flow becomes: EXPLORE (conditional) → DESIGN → CRITIQUE → PLAN → TEST → CONFIRM → BUILD → ...
- SLE-001 and SLE-002 must be updated to reflect Critic at DESIGN, not PLAN
- At `depth: research` or `depth: deep`, the Critic produces a more thorough review (per SLE-024)
- The Critic's prompt template must be updated to review architecture + requirements (not plan + test-plan)
