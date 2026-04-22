# DDR-023 — EXPLORE trigger: user-initiated and automatic are separate

**Date:** 2026-04-17 · **Status:** accepted
**Resolves:** G23

## Context

SLE-024 marks the EXPLORE node as "conditional — when unknowns flagged" but defines nothing about who flags unknowns, what triggers exploration, or what format the output takes. G23 identifies this as a gap blocking EXPLORE node implementation.

Two distinct use cases emerged during discussion that should not be conflated:

1. **Creative exploration** — user wants to investigate a design space, run spikes, map out ideas and possibilities before committing to a design. This is interactive and human-guided.
2. **Automatic gap detection** — daemon finds ambiguities, contradictions, or missing information in existing artifacts. This is analytical and machine-driven.

These are separate concerns with different triggers, interaction patterns, and trust levels. Their outputs must be tracked separately.

## Options considered

| Option | Model | Pros | Cons |
|--------|-------|------|------|
| A | Single EXPLORE node, user-initiated only | Simple, user controls cost | Misses opportunities for automatic gap detection |
| B | Single EXPLORE node, daemon heuristic trigger | Catches unknowns automatically | User loses control over cost; conflates creative and analytical work |
| C | Two separate mechanisms: user-initiated EXPLORE + automatic gap detection | Clear separation of intent and trust; user retains control | Two systems to build; more spec surface |

## Decision

EXPLORE is user-initiated only. Gap detection is a separate automatic mechanism. Their outputs are tracked separately.

### User-initiated EXPLORE

- **Trigger:** User explicitly requests exploration through the intent or Facilitator
- **Process:** Interactive — rounds of discussion between user and Explorer agent, guided by the user's questions and direction
- **Output:** Research findings document (spike results, design options, tradeoff analysis), clearly attributed as user-guided exploration
- **When:** Before DESIGN (as a pre-cycle step), or between cycles, or on demand
- **Cost:** User-visible and user-controlled

### Automatic gap detection

- **Trigger:** Daemon runs automatically at defined points (e.g., during context assembly, after DESIGN, after PLAN)
- **Process:** Non-interactive — daemon checks for ambiguities, contradictions, missing references, and gaps in existing artifacts
- **Output:** Flagged issues surfaced to user via Facilitator, clearly attributed as automatic detection
- **When:** TBD — to be specified in `specs/dag-execution.md` and `specs/validation.md`
- **Relationship to existing specs:** The coherence gate (SLE-019) already performs gap detection during intake. This extends the pattern to other points in the cycle.

## Consequences

- EXPLORE node in the DAG is user-initiated only — no heuristic triggering
- `planning.depth: research` or `deep` in rule files does NOT auto-trigger EXPLORE (this overrides SLE-024's implication)
- Automatic gap detection is a separate system, specified in `specs/validation.md` or a dedicated section of `specs/dag-execution.md`
- Research findings from user-initiated EXPLORE are tagged with source type `explore:user-guided`
- Flagged issues from automatic gap detection are tagged with source type `detection:automatic`
- The DAG flow: user triggers EXPLORE (optional) → CONTEXT ASSEMBLY → DESIGN → ...
- Explorer agent prompt template is tuned for interactive exploration, not gap detection
- Gap detection does not need a dedicated agent role — it can reuse the Evaluator or a lightweight daemon check
