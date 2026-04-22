# DDR-019 — Designer owns requirements.md

**Date:** 2026-04-17 · **Status:** accepted
**Resolves:** G11

## Context

SLE-024 splits the original Planner role into Designer (system shape, architecture) and Planner (specific implementation steps, test-plan). The artifact `requirements.md` previously belonged to the Planner (SLE-002), but after the split its ownership became ambiguous. Requirements define *what* to build — which is design intent, closer to the Designer's concern than the Planner's step-level detail.

This blocks G7 (SLE-002 DAG rewrite — node definitions need settled artifact ownership) and G8 (SLE-007 context manager slices depend on who reads vs writes each artifact).

## Options considered

| Option | Owner | Pros | Cons |
|--------|-------|------|------|
| A | Designer | Requirements are design intent ("what to build"); clean separation — Designer owns what, Planner owns how | Designer's output broadens; Planner must wait for Designer before planning |
| B | Planner | Requirements feed directly into test-plan; single owner for the implementation contract | Requirements become implementation-focused, may miss structural/design concerns |
| C | Shared (Designer drafts, Planner refines) | Both perspectives inform requirements | Two-writer ambiguity; harder to enforce context slice boundaries; artifacts may shift between roles mid-cycle |

## Decision

The Designer produces `requirements.md`. The Planner reads it as input and produces the test-plan and step-level implementation plan.

## Consequences

- Designer outputs: `architecture.md`, `requirements.md`
- Planner outputs: `test-plan.md`, `plan.md` (step-level)
- Planner's context slice: reads `architecture.md` + `requirements.md`, does not write either
- Designer's context slice: reads discovery docs + intent + prior architecture + decisions
- The DAG flow is: EXPLORE (conditional) → DESIGN (Designer writes architecture + requirements) → PLAN (Planner writes test-plan + plan)
- Critic (per DDR-022) reviews Designer's output, which now includes both architecture and requirements
- SLE-002 and SLE-007 must reflect this ownership split when rewritten
- Tester reads `requirements.md` (Designer's output) + `test-plan.md` (Planner's output) — the separation constraint (Tester never sees Builder output) is unaffected
