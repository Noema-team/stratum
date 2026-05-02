# DDR-028 — Cycle scoping redesign: pre-cycle discussion + guided Phase 1

**Date:** 2026-05-02 · **Status:** proposed
**Affects:** dag-execution.md, conversation.md, project-overview.md, ui-shell.md, tasks-dashboard.md, user-flow.md, context-manager.md, prompt-templates.md, daemon-api-endpoints.md, types.md

## Context

The current cycle definition mechanism is a single-shot goal string (`sle start "goal"`) passed to the Planner. The Planner reads existing artifacts and produces a plan autonomously. The user's only control point is the CONFIRM gate review.

Problems with the current approach:

- The user has limited control over cycle scope before the Planner runs
- No mechanism to mark specific nodes/layers as relevant for the next cycle
- No structured way for user + AI to collaboratively define what a cycle should accomplish
- Out-of-scope ideas have no home — they're either lost or jammed into an oversized cycle
- The Planner receives a vague goal string rather than a well-defined scope document

The user wants:

- Rich control over what a cycle produces before implementation starts
- AI-facilitated discussion to help define realistic, grounded scope
- Ability to mark nodes and individual layers as "relevant for next cycle"
- A clear separation between pre-cycle exploration and formal cycle execution
- Out-of-scope ideas captured for future cycles

## Decision

### Two-stage scoping model

**Stage 1: Pre-cycle discussion (Facilitator-led, informal)**

- Happens in the Chat tab at any time, no cycle running
- User discusses what they want to accomplish with the Facilitator
- Together they mark nodes and/or individual layers as relevant for the next cycle
- Together they produce a **cycle-scope draft** — an informal document capturing scope, purpose, and initial requirements
- Out-of-scope ideas are captured to the backlog (or a dedicated deferred-ideas section)
- The user can iterate on this as many times as they want — no commitment
- When satisfied, the user triggers the formal cycle

**Stage 2: Guided Phase 1 (Facilitator-led, structured, within cycle)**

- Triggered when user starts the cycle (`sle start --scope <draft-id>` or UI action)
- First phase of the DAG is a structured scoping discussion
- Pulls in: all marked-relevant nodes/layers + the cycle-scope draft + existing artifacts
- Facilitator guides the user through a predefined discussion structure to nail down exact scope, purpose, and requirements
- Output: a formal `doc:cycle-charter` artifact (scope, purpose, requirements, boundaries, deferred items)
- This replaces the current single-shot INTENT + INTAKE approach

### Node/layer tagging system

Introduce a **tag system** on nodes and layers:

- Tags are key-value pairs: `@next-cycle`, `@scope:{draft-id}`, `@area:security`, etc.
- Tags can be applied at the **node level** (entire node is relevant) or **layer level** (specific layer within a node)
- Tags are set/removed through: chat (Facilitator proposes, user confirms), graph right-click context menu, or direct API
- When a cycle starts, all `@next-cycle` tagged nodes/layers are pulled in
- After cycle completion, `@next-cycle` tags are cleared on affected nodes/layers
- Tag system is extensible — can be used for backlog, categorization, filtering beyond cycles

### Scope realism

- The Facilitator should have heuristics for realistic cycle scope (e.g., "one feature group", "3-5 requirements", "single module")
- Exact mechanism TBD — could be token budget limits, node count limits, or experience-based heuristics from the Planner
- This needs further discussion — captured as open question below

### Revised cycle phases

```
Pre-cycle (outside DAG):
  User + Facilitator chat → mark nodes → create scope draft → user triggers cycle

Phase 1: SCOPING (new DAG node, Facilitator-led)
  - Pull in tagged nodes/layers + scope draft
  - Guided discussion to finalize scope, purpose, requirements
  - Output: doc:cycle-charter

Phase 2: PLANNING (revised)
  - Planner reads cycle-charter + tagged node content + existing artifacts
  - Produces plan.md, test-plan.md (and optionally build-plan.md)
  - Borrowed from current PLAN node but with richer input

Phase 3: REVIEW (current CONFIRM gate)
  - User reviews plan, modifies steps, approves/halts
  - Sharding approval still applies for multi-task plans
  - Borrowed from current CONFIRM gate

Phase 4: EXECUTION (current pipeline)
  - BUILD → VALIDATE → DEBUG (on failure) → SNAPSHOT
  - Borrowed from current BUILD + VALIDATION + SNAPSHOT nodes
  - Iteration loop on validation failure (unchanged)
```

### Borrowed from current DAG

The current 17-node DAG is not discarded. Elements carried forward:

- SHARDING_APPROVAL → kept in Phase 3 (when Planner shards into multiple tasks)
- EXPLORE → absorbed into pre-cycle discussion (user explores with Facilitator before committing)
- PLAN → becomes Phase 2 (richer input, same Planner agent)
- TEST → kept in Phase 4 (generates test criteria from plan)
- CONFIRM → becomes Phase 3 (user reviews plan)
- BUILD → kept in Phase 4
- VALIDATION_GATE → kept in Phase 4
- DEBUG → kept in Phase 4 (on validation failure)
- SNAPSHOT → kept in Phase 4
- INTENT → replaced by cycle-charter from Phase 1
- INTAKE → absorbed into pre-cycle discussion + Phase 1
- CRITIQUE → kept at deep/research depth in Phase 2

### New artifacts

- `doc:cycle-scope-draft` — informal, created during pre-cycle chat. scope: project. generator: user+facilitator.
- `doc:cycle-charter` — formal, created in Phase 1. scope: run. generator: facilitator. The definitive input for the Planner.

## Consequences

### Positive

- User has rich control over cycle scope before implementation starts
- AI-facilitated discussion produces better-defined cycles
- Tag system is extensible beyond cycle scoping
- Out-of-scope ideas have a home (backlog + deferred section of cycle-charter)
- Pre-cycle discussion is low-commitment — user can explore freely

### Negative

- More complex DAG (new SCOPING node, new artifacts)
- Facilitator needs new capabilities (node tagging, scope draft creation, guided discussion)
- Tag system adds data model complexity
- Cycle start is no longer instant — requires pre-cycle discussion first (though `sle start "goal"` could still work as a quick-start that skips pre-cycle, using the goal as a minimal scope draft)
- All specs that reference the current DAG need updating

### Risks

- Pre-cycle discussion could feel like overhead for simple changes — need a "quick start" path
- Tag system scope creep — need to keep it focused initially
- Phase 1 guided discussion needs careful UX design — too rigid = frustrating, too loose = useless

## Open questions

| ID | Question | Impact | Status |
|----|----------|--------|--------|
| SC-001 | What are realistic scope heuristics? (token count, node count, feature group limits) | Facilitator guidance quality | Open — needs dedicated discussion |
| SC-002 | Should `sle start "goal"` still work as a quick-start bypass? | Backward compatibility, simplicity | Open — proposed yes, with minimal scope draft auto-generated |
| SC-003 | Can tags be applied to groups (not just nodes/layers)? | Tag system scope | Open |
| SC-004 | Should the scope draft be editable in the Graph tab or only in Chat? | UI surface for scoping | Open — proposed Chat for creation, Graph for node marking |
| SC-005 | How does the Planner weight user-created nodes vs cycle-produced nodes in its context? | Planner behavior | Open — needs context-manager update |
| SC-006 | What happens to `@next-cycle` tags if the user starts a cycle but doesn't include all tagged nodes? | Tag cleanup semantics | Open |
| SC-007 | Should the guided Phase 1 discussion have a maximum number of rounds? | Cycle latency | Open |
| SC-008 | How does this interact with the existing depth_override mechanism? | Planner configuration | Open — proposed: scope draft replaces goal string, depth still configurable |
