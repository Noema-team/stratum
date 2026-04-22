# DDR-026 — Sharding approval is a separate step before CONFIRM

**Date:** 2026-04-17 · **Status:** accepted
**Resolves:** G38

## Context

SLE-019 defines a sharding approval step: after the Planner produces a sharding proposal, the user reviews task boundaries, context declarations, and dependencies. The proposal can be large — potentially dozens of tasks. SLE-020 and SLE-023 don't mention where this lives in the UI.

Embedding sharding approval in the CONFIRM gate panel alongside plan steps and test coverage would make the panel unwieldy. Sharding and plan approval are different concerns — sharding determines what tasks exist, plan approval determines how those tasks are implemented.

## Options considered

| Option | Model | Pros | Cons |
|--------|-------|------|------|
| A | Tab within CONFIRM gate panel | Everything in one place | Panel gets crowded; different concerns mixed |
| B | Separate step before CONFIRM | Clean separation; each interaction is focused; sharding approved before plan is generated | Two sequential human checkpoints |
| C | Background via Facilitator | No dedicated panel | Hard to see full sharding picture; less structured |

## Decision

Sharding approval is a separate step before CONFIRM, using the same flag pattern as DDR-021. `cycle.awaiting_sharding_approval: boolean` on the cycle record. The Facilitator enters decision mode for this interaction.

## Consequences

- DAG flow: ... → INTAKE → SHARDING APPROVAL (human) → DESIGN → ... → CONFIRM (human) → BUILD → ...
- Sharding approval uses `cycle.awaiting_sharding_approval` flag, `meta.status` stays `cycling`
- The Facilitator presents the sharding proposal in decision mode: user can review tasks, ask clarifying questions, approve/reject/modify
- This is the first human checkpoint — it validates task boundaries before any design or planning work
- UI has a dedicated sharding review panel (specified in `specs/ui-shell.md`)
- The user flow (`specs/user-flow.md`) shows two distinct pause points: sharding approval and CONFIRM gate
