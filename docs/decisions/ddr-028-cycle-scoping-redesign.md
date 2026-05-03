# DDR-028 — Cycle scoping redesign: pre-cycle discussion + guided Phase 1

**Date:** 2026-05-02 · **Status:** proposed
**Affects:** dag-execution.md, conversation.md, project-overview.md, ui-shell.md, tasks-dashboard.md, user-flow.md, context-manager.md, prompt-templates.md, daemon-api-endpoints.md, types.md, state-machine.md

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

Introduce a **tag system** on nodes, layers, and groups:

- Tags use `#` prefix: `#next-cycle`, `#scope:{draft-id}`, `#area:security`, etc.
- Tags can be applied at the **node level** (entire node is relevant), **layer level** (specific layer within a node), or **group level** (all layers in a group)
- Tags can be applied at any time — during pre-cycle discussion, at node/layer creation time, or independently. Marking is not limited to the pre-cycle discussion phase.
- Tags are set/removed through: chat (Facilitator proposes, user confirms), graph right-click context menu, or direct API
- `#next-cycle` means **priority, not exclusion**: tagged nodes/layers are loaded first and truncated last. The Planner still has access to the full graph via linking and reasoning. Untagged nodes are available but lower priority.
- When a cycle starts, all `#next-cycle` tagged nodes/layers are primary inputs
- After cycle completion, `#next-cycle` tags are cleared only on nodes/layers the cycle actually modified. Untouched tags persist for the next cycle.
- Tag system is extensible — can be used for backlog, categorization, filtering beyond cycles

### Scope realism

The Facilitator assesses scope realism primarily through thorough, objective reasoning about the scope, goals, and requirements — evaluating completeness, internal consistency, feasibility, and potential risks. Quantitative metrics (node count, token count, feature group limits) serve as secondary signals only, since a narrow scope can have extensive detail and an out-of-scope idea can be a single sentence. The assessment must be flexible, consistent, and reliable — avoiding rigid limits that don't account for context.

### Revised DAG flow (final)

New DAG node: `SCOPING` replaces INTENT, INTAKE, CONTEXT_ASSEMBLY, and EXPLORE.

```
Pre-cycle (outside DAG):
  User + Facilitator chat → tag nodes with #next-cycle → create scope draft → user triggers cycle

DAG:
  SCOPING (new, Facilitator-led)
    │  Pulls in tagged nodes/layers + scope draft + existing artifacts
    │  Facilitator in 'scoping' mode guides structured discussion
    │  Output: doc:cycle-charter
    │
    ▼
  DESIGN
    │  Designer produces architecture.md + requirements.md
    │  Charter provides focused scope (richer than old goal string)
    │
    ▼
  CRITIQUE (conditional — depth: deep | research only)
    │  Reviews DESIGN output
    │
    ▼
  PLAN
    │  Planner reads charter + architecture + requirements
    │  Produces plan.md, test-plan.md (+ build-plan.md at deep/research)
    │
    ▼
  TEST → [SHARDING_APPROVAL] → CONFIRM → BUILD → HISTORY → EXEC
    │
    ▼
  VALIDATION_GATE
    ├── PASS → EVALUATE → SUMMARISE → SNAPSHOT → complete
    └── FAIL → DEBUG → PLAN → ... (iteration loop)
```

Nodes dropped from current DAG:
- INTENT — replaced by cycle-charter from SCOPING
- INTAKE — absorbed into pre-cycle discussion + SCOPING
- CONTEXT_ASSEMBLY — absorbed into SCOPING (charter creation includes context pull)
- EXPLORE — absorbed into pre-cycle discussion (user explores with Facilitator before committing)

Nodes kept unchanged: DESIGN, CRITIQUE, PLAN, TEST, SHARDING_APPROVAL, CONFIRM, BUILD, HISTORY, EXEC, VALIDATION_GATE, DEBUG, EVALUATE, SUMMARISE, SNAPSHOT

### Source weighting in context assembly

User-tagged nodes/layers get higher priority in the context manager's truncation
order. The `source_weight` field on `SliceRule` controls this:

```
'user_defined' > 'cycle_produced' > 'inferred'
```

All relevant sources are always loaded — weighting only affects truncation order
when the token budget is exceeded. No source is silently excluded unless
physically impossible to fit (logged in `truncated[]`).

### Facilitator scoping permissions

The Facilitator gains a scoped exception to conversation.md constraint 2:
- **Can produce:** `doc:cycle-charter` (run scope), `doc:cycle-scope-draft` (project scope)
- **Cannot produce:** build artifacts, test artifacts, validation artifacts, or graph nodes
- Full node creation by the Facilitator is deferred to post-MVP

### Borrowed from current DAG

See §Revised DAG flow above for the complete new DAG. The current 17-node DAG reduces to 14 nodes (4 dropped, 1 new). All remaining nodes keep their current behavior and agent assignments.

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

## Explicitly deferred

**Node locking during cycles.** The concept of locking nodes/layers that are being modified by a running cycle was discussed. Decision: defer until the two-stage scoping model is implemented and real-world usage reveals whether conflicts actually occur. The current committed-state-only principle (cycles write to staging, graph shows committed state) may be sufficient.

**Split Chat + Graph view.** The concept of showing Chat and Graph simultaneously so the user can discuss scope while seeing/interacting with the graph. Decision: defer to post-MVP. The UI shell design should not prevent this layout, but building it is not in scope for the scoping redesign.

**Facilitator node creation.** Allowing the Facilitator to create graph nodes (not just scoping artifacts). Decision: deferred to post-MVP. The Facilitator produces `doc:cycle-scope-draft` and `doc:cycle-charter` only. Nodes are created by the user (graph right-click) or the DAG runner.

## Open questions

| ID | Question | Impact | Status |
|----|----------|--------|--------|
| SC-001 | What are realistic scope heuristics? (token count, node count, feature group limits) | Facilitator guidance quality | Resolved: qualitative assessment primary, quantitative secondary — see Scope realism section |
| SC-002 | Should `sle start "goal"` still work as a quick-start bypass? — Resolved: yes, auto-generates minimal scope draft from goal string, skips informal pre-cycle chat, still goes through guided Phase 1. | Backward compatibility, simplicity | Resolved: yes |
| SC-003 | Can tags be applied to groups (not just nodes/layers)? — Resolved: yes, groups are taggable. Tagging a group implies all its layers. | Tag system scope | Resolved: yes |
| SC-004 | Should the scope draft be editable in the Graph tab or only in Chat? | UI surface for scoping | Resolved: Chat-only for creation/editing. Node tagging via Chat (Facilitator proposes) or Graph (right-click). Split Chat+Graph view deferred to post-MVP. |
| SC-005 | How does the Planner weight user-created nodes vs cycle-produced nodes in its context? | Planner behavior | Resolved: `source_weight` on SliceRule controls truncation order (`user_defined > cycle_produced > inferred`). All sources always loaded — weighting never excludes. |
| SC-006 | What happens to `#next-cycle` tags if the user starts a cycle but doesn't include all tagged nodes? | Tag cleanup semantics | Resolved: `#next-cycle` means priority, not exclusion. Tags cleared only on nodes/layers the cycle actually modifies. Untouched tags persist. Planner reasons over full graph via linking. |
| SC-007 | Should the guided Phase 1 discussion have a maximum number of rounds? | Cycle latency | Resolved: configurable via `planning.yaml → scoping.max_rounds` (default 5, hard cap 10). |
| SC-008 | How does this interact with the existing depth_override mechanism? | Planner configuration | Resolved: orthogonal. Charter is the *what* (scope), depth is the *how deep* (planner output detail). No change needed. |
| SC-009 | How does the revised flow handle the DESIGN node? Currently the Designer produces architecture.md and requirements.md which the Planner reads. If DESIGN is removed from the cycle, how are these artifacts produced or updated? | DAG structure, Critic dependency | Resolved: keep DESIGN. Charter feeds into DESIGN as richer, more focused input. Designer still produces architecture.md + requirements.md. Critic still reviews DESIGN. Pipeline: SCOPING → DESIGN → [CRITIQUE] → PLAN → ... |
| SC-010 | The Facilitator currently cannot write cycle artifacts (conversation.md constraint 2). Producing doc:cycle-charter during Phase 1 violates this. Should cycle-charter be classified as a pre-cycle artifact, or should constraint 2 be revised? | Facilitator permissions | Resolved: scoped exception — Facilitator can produce scoping artifacts (charter, scope-draft) only. Cannot produce execution artifacts. Full node creation deferred. |
| SC-011 | 6 current DAG nodes are unaccounted for in the revised flow: CONTEXT_ASSEMBLY, DESIGN, HISTORY, EXEC, EVALUATE, SUMMARISE. Each needs explicit placement or removal rationale. | DAG completeness | Resolved: DESIGN kept (per SC-009). CONTEXT_ASSEMBLY absorbed into SCOPING. HISTORY, EXEC, EVALUATE, SUMMARISE all kept in current positions. Dropped nodes: INTENT (replaced by charter), INTAKE (absorbed into pre-cycle + SCOPING), EXPLORE (absorbed into pre-cycle chat), CONTEXT_ASSEMBLY (absorbed into SCOPING). |
| SC-012 | Should a `FacilitatorMode = 'scoping'` be added for the guided Phase 1 discussion? Currently only 'chat' and 'decision' modes exist. | conversation.md, prompt-templates.md | Resolved: yes. MVP: explicit toggle in mode switcher. Post-MVP: seamless auto-detection. |
| SC-013 | state-machine.md is missing from the Affects list. Phase 1 scoping needs an `awaiting_scoping` flag similar to `awaiting_confirmation`. | state-machine.md | Resolved: yes. Add `awaiting_scoping` flag to cycle record. Same pattern as `awaiting_confirmation` — boolean, at most one flag true at a time. |
| SC-014 | Should the project have a semver-like versioning system where each cycle bumps a version (major/minor/hotfix)? Would make graph navigation easier and provide context for node relevance. | Graph navigation, artifact lifecycle | Open — captured for future DDR. Complex: touches entire artifact lifecycle, not just scoping. |
