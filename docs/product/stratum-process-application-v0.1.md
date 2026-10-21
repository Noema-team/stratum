# Stratum Process Application v0.1

**Status:** accepted product direction; initial implementation in progress
**Date:** 2026-10-21
**Decision:** [DDR-042](../decisions/ddr-042-process-centric-application.md)
**Source design:** [Process-Centric Product Model v0.1](process-centric-product-model-v0.1.md) (preserved as a draft, not ratified in full)

## Product intent

Stratum helps a person understand and advance a project's continuing intentions. A Project overview should answer what is active, what needs attention, what changed, and what the person can do next. A Process keeps the intent, proposals, decisions, reviews, evidence references, and outcome together across sessions and attempts.

## Object boundaries

- **Project** is the application's context and visibility boundary.
- **Objective** describes an intended outcome or milestone. It can contain multiple ongoing efforts.
- **Process** is an ongoing effort toward an outcome; it may link to an Objective or stand alone.
- **WorkItem** remains a bounded execution contract in the engineering kernel. Process actions do not authorize or mutate it.
- **Repository** is a code resource with explicit many-to-many Project links. Shared code does not share planning records or private context.
- **AgentSession** and **RuntimeWorkspace** are future runtime records. They will link to a Process without defining its lifecycle.

The v0.1 UI uses the term Process. It does not introduce a parallel application Task. Process lifecycle and the dimensions of focus, attention, iteration, and runtime activity remain distinct; only lifecycle is authoritative in the first implementation.

## Initial user journey

1. Select a Project and review its active, paused, and completed Processes.
2. Create a Process with a title, intent, optional Objective, desired outcomes, constraints, and explicitly linked repositories.
3. Record updates, proposals, reviews, and scoped decision outcomes in a durable timeline.
4. Request a revision, accept or reject a proposal, pause the Process, or mark its outcome complete.
5. Return later and continue from its persisted state and review history.

The first useful proof supports two Projects that link the same repository without sharing Process history, and multiple proposal/review rounds on one Process. Kernel WorkItems remain unchanged throughout.

## Initial screen structure

### Project Overview

- Project selector and project description.
- Counts for active, paused, and completed Processes.
- Process cards with title, intent, lifecycle, and last update.
- Primary action to create a Process.
- Explicit repository links and a link action.
- Link to the existing execution control plane for kernel work.

### Process Workspace

- Intent, desired outcomes, constraints, optional Objective, and linked repositories.
- Persisted activity and review history, newest first.
- Entry form for update, proposal, review, or decision with an explicit outcome.
- Pause, resume, and complete actions.
- Clear statement that completing the Process does not change kernel execution state.

The overview is a projection of persisted application records, not a new state machine. Later runtime and GitHub observations must include provenance and freshness. Do not derive completion or attention from agent-generated prose.

## Persistence and access

Process records belong to one Project and may optionally point to an Objective in that same Project. Their repository links must be explicit Project memberships. API operations validate that the Project belongs to the running workspace; Process reads and writes must apply the same scope. Process activity remains separate from kernel Decisions and Events until an explicit integration is designed.

Repository membership uses a join table so the existing repository primary keys remain stable for WorkItems and evidence. The legacy `repositories.project_id` field remains temporarily for compatibility; the join table is the membership source for new reads and authorization checks.

## Deferred from the first increment

Goose/ACP host integration, session resume, sandbox enforcement, live agent events, GitHub PR/CI evidence, conversation promotion, multiple agents, cross-host recovery, multi-user authorization, and Process-to-WorkItem handoff. These require further product and security decisions and their own acceptance gates.

## Acceptance checks

- A Project can create and reopen a Process after a server restart.
- A Process can preserve at least two proposal/review rounds, including a rejected or revised attempt.
- Pausing or completing a Process leaves the kernel WorkItem table and lifecycle untouched.
- A repository can be linked to two Projects while their Processes and histories remain distinct.
- A Process cannot link an Objective or repository outside its Project.
- The current execution dashboard continues to serve its existing routes.
