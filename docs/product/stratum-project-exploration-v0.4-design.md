# Stratum v0.4 — Project Exploration and Process Promotion

**Status:** Proposed design for product review; not implementation authorization. Nothing in the proposed decisions below is approved until product review accepts it.
**Date:** 2026-10-22
**Depends on:** v0.3 P0 at `c8388c6247d5469af0715f22864f49cad831dbc1`, stacked on `feat/process-agent-sessions-v0.2`.
**Related:** [v0.3 product experience](stratum-product-experience-v0.3.md), [v0.3 wireframes](stratum-product-experience-wireframes-v0.3.md), [v0.2 AgentSessions](stratum-agent-enabled-processes-v0.2.md), [DDR-042](../decisions/ddr-042-process-centric-application.md).

## Purpose

Let a user begin with a question in a Project, investigate it with a durable conversation, and then either keep exploring or carry the work into an existing or newly accepted Process. A Process remains the durable authority for accepted intent and decisions. Project exploration does not create a hidden Process or imply that an agent claim is accepted.

This increment addresses the product gap left by v0.3 P0. It does not qualify Goose, add writable execution, create Project knowledge storage, or change kernel authority. Provider-backed use remains gated by the separate Goose qualification campaign.

## Approved architectural invariants

These are existing constraints from DDR-042, the accepted authority decisions it references, and the v0.2 implementation. This design must preserve them.

- A Project is the visibility and permission boundary. Shared repository identity does not share Project history, decisions, sessions, or private context.
- Process intent is versioned and human-accepted. Agent text is a claim; neither association nor a Process decision itself authorizes execution.
- Stratum services validate and materialize authorized state. Application actions do not create or mutate kernel WorkItems or WorkflowRuns unless a separately authorized handoff exists.
- AgentSession operations are durable and idempotent. Browser refresh/reconnect reads existing state and events; it never resends a prompt. Uncertain delivery is not silently retried.
- Repository access is explicit, pinned, isolated, read-only, and fail-closed. A permission applies only to its exact operation. No promotion can widen a mounted workspace or transfer a permission to another operation.
- Existing Process-owned sessions, event history, operation records, workspace identity, and permission records must remain valid across any migration.

## Proposed product decisions

1. **An exploration is Project-owned from creation.** Its stable AgentSession ID is the exploration/conversation identity, with its existing Project ID as owner before any Process association. Every read, prompt, event, permission, recovery, and promotion request must resolve authorization from that Project-owned session identity; no Process lookup is required to establish ownership. A Process link is optional and added only by explicit promotion. It remains visible only within its Project.
2. **One exploration has one durable AgentSession for the first slice.** Do not add a generic multi-session Conversation aggregate. A later need for multiple sessions can justify a distinct model.
3. **Repository context is explicit and read-only.** At creation, the user may choose no repository or one repository already linked to the Project. If selected, capture the canonical repository identity and pinned commit in a managed read-only workspace. Show this scope before starting. Do not infer access from a shared repository or another Process.
4. **Promotion is explicit, one-way, and to at most one Process.** It preserves the same AgentSession ID, event sequence, prompt operations, workspace snapshot, and provenance. It never replays prompts, rewrites old events, widens a workspace, or transfers a permission decision to a different operation. Both new- and existing-Process promotion retain links back to the original conversation and exact source event(s).
5. **Association, knowledge acceptance, intent amendment, and execution authorization are separate actions.** Association links the conversation to a Process and grants no authority. A finding becomes Process knowledge only through a separate human acceptance action and provenance-bearing record. Changing accepted intent requires the existing versioned amendment flow. Execution requires its own explicit authorization and policy path; none of the prior actions implies it.
6. **Claims retain provenance and uncertainty.** Any finding carried forward cites `(sessionId, eventSeq)`, is marked as an agent claim, and remains a draft until the user chooses to record it. Missing source events are reported as unavailable, never substituted by sequence number alone.

## User journey

### Start and investigate

From a Project Overview, the user selects **Start exploration**, enters an initial question, and chooses either **No repository** or one linked repository. The confirmation names the Project, repository identity (if any), pinned snapshot, and read-only access. The user can inspect or cancel before the first prompt is sent.

The exploration page shows its Project breadcrumb, question, repository scope, last-observed session state, complete messages, and source details. It offers follow-up prompts and **Record finding** from a completed agent message. Each prompt remains idempotent across refresh/reconnect. Unavailable runtime, interrupted prompts, and missing provider configuration are explicit states with recovery guidance; the UI does not simulate a live agent.

### Promote to an existing Process

The user chooses **Add to a Process**, then selects an active or paused Process in the same Project. The review screen shows the Process's accepted intent/version alongside the exploration's repository snapshot and the exact source messages or user-authored summary being carried forward.

If the user confirms association, Stratum links the exploration to that Process without yet recording knowledge, changing accepted intent, or authorizing execution. The user then separately chooses whether to record a user-authored update, create a proposal, or accept a supported knowledge item where that capability exists. Each resulting record links to the exploration session and exact event sequence. The Process definition/version remains unchanged unless the user separately enters and accepts the versioned amendment flow. The exploration remains visible in Project history and linked to that one Process. The user returns to the Process at the chosen record, or to its overview if they only associated it.

If the Process is in another Project, it is not selectable. If the exploration has a repository snapshot and that canonical repository identity is absent from the target Process's accepted repository set, association may preserve the conversation as historical context only. The session remains pinned to its original repository and commit; it cannot continue as work for a Process using different repositories. The UI must state that a new Process-linked session in the target Process's authorized repository scope is required before further repository-backed work. If repository identity matches but the target's intended revision/scope differs, keep the existing pinned snapshot unchanged and require explicit review under the target Process's current policy before continuing; never substitute a commit or remount the workspace during promotion. A no-repository exploration stays without repository access after association.

### Promote to a new Process

The user chooses **Create a Process**, reviews and edits title, intent, desired outcomes, constraints, and repository scope, then explicitly accepts. The repository scope must be selected by the user; suggested fields from the conversation remain drafts until edited/accepted. Stratum creates the Process and accepted definition version 1, then associates the exploration with it. It does not create execution work or authorize tools.

The same session can continue only if its existing pinned workspace's canonical repository identity is within the accepted Process repository scope, its pinned snapshot remains the one already mounted, and all ordinary session/runtime checks pass. If the new Process uses a different repository, or requires a different snapshot, the exploration is associated as historical context and the user starts a new Process-linked session. No remount, snapshot substitution, or permission carry-over is allowed.

### Return later

Project Overview lists explorations with last observed activity and state, distinct from Process attention. Direct links reopen the same exploration and event cursor. After promotion, the Project history and Process both link to the same conversation identity; there is one transcript and one provenance chain, not copied messages.

## Proposed ownership and authority model

```text
Project (visibility and repository-membership boundary)
  ├── Exploration (durable user/agent conversation, zero or one Process link)
  │     └── AgentSession (one pinned workspace; one-time operation permissions)
  └── Process (accepted, versioned intent and human decisions)
        └── linked exploration(s) as source/context, not authority
```

Promotion adds a link; it does not transfer ownership out of the Project or change the meaning of prior records. The AgentSession ID remains stable and is the conversation identity before and after promotion. A linked exploration cannot be promoted to a second Process. If the user wants to reuse a finding elsewhere, they must create a new user-authored record there with an explicit source reference and Project access check.

The existing v0.2 schema already stores `project_id` on `app_agent_sessions`, but requires `process_id`; each runtime workspace also requires a Process ID. The proposed smallest migration is to make those Process associations optional while retaining AgentSession as the single conversation engine and stable identity. Do not add a second Conversation/Exploration aggregate or duplicate transcript, operation, permission, and recovery machinery. The existing `project_id` becomes the required owner used for authorization before Process association. Add Project ownership checks to every session endpoint/service path; verify selected repository membership in that Project at creation and again for each operation. The Process link, once set, is immutable. Promotion of a new Process and association must be atomic; association to an existing Process must validate same-Project ownership and target eligibility in the same transaction as linking.

Retain `project_id` and the selected repository/snapshot as the workspace's stable authority inputs; make `process_id` optional on the workspace. Authorization must derive from Project ownership and explicit repository membership, never from nullable Process fields interpreted permissively. For SQLite, the preferred migration is an append-only migration that rebuilds only the affected session/workspace tables and indexes with foreign keys preserved, copies all existing rows verbatim, then validates row counts and references before recording completion. Existing Process sessions retain their same Process ID and workspace/session/event/operation/permission identities. Adjust the active-session uniqueness index to enforce one active session per non-null Process where required, while allowing Project-owned explorations; do not invent another runtime/session table. The exact migration mechanics and failure/rollback behavior remain implementation details for a reviewed implementation plan.

### Session lifecycle and navigation

Promotion changes the optional Process association only; it does not change AgentSession lifecycle. `starting`, `idle`, `running`, `awaiting_permission`, `interrupted`, `outcome_unknown`, `stopped`, and `failed` retain their v0.2 meanings. Promotion must not dispatch, resume, stop, reconcile, or acknowledge an uncertain operation. If a server restart occurs during promotion, the association transaction is either wholly committed or absent; ordinary restart recovery then marks/reconciles session state under existing v0.2 rules without resending a prompt. If the browser reconnects, it reloads the same session ID and event cursor, then discovers the association from persisted state. An in-flight operation remains subject to existing uncertain-outcome handling. Direct Project and Process links resolve to the same AgentSession and event identities.

## Scope and access rules

- Exploration is local single-user in this increment, consistent with the current application's qualification limits; do not imply multi-user privacy/RBAC guarantees.
- A repository must already be linked to the selected Project. Repository sharing with another Project does not share its exploration history, permission decisions, or Process records.
- No repository is mounted unless explicitly selected. When selected, the session sees one pinned snapshot mounted read-only under the existing isolated runtime boundary.
- Path validation, symlink containment, file size/type restrictions, and human permission mediation remain in force. Deny unsupported capabilities before a human approval prompt.
- Permission decisions remain one-time and tied to their exact ACP operation. Promotion grants no permission, and Process acceptance cannot override runtime isolation.
- Existing Process decisions, proposals, versioned intent, and kernel WorkItems remain untouched except for explicit user-triggered Process activity/proposal creation through existing services.
- If a Process repository set changes after association, the session's original workspace does not change. Continuing requires validation against the new authorized scope or a new correctly scoped session.

## Bounded implementation slice

The first implementation should deliver only:

1. Project exploration list, create flow, durable conversation view, and unavailable/recovery states.
2. Optional explicit single-repository read-only snapshot, with authorization checks at creation and each file operation.
3. Draft a finding from an exact completed message and preserve source identity through save/reload.
4. Promotion association to either one existing same-Project Process or a newly accepted Process (definition version 1), preserving session identity and source-event provenance.
5. Explicit separate user actions for association, recording a finding/update/proposal, accepting knowledge (if included), amending versioned intent, and authorizing execution; only association and existing update/proposal flows are candidates for this first implementation.
6. Immutable one-Process association, repository mismatch/history-only behavior, direct navigation between Project and Process, and history links after promotion.
7. Migration/upgrade coverage proving existing Process-owned sessions and their workspaces/events/operations/permissions remain intact.

Out of scope: multi-agent or multi-session conversations, multi-user collaboration, Project knowledge, automatic summarization as accepted truth, repository writes, shell/terminal tools, execution handoff, kernel changes, cross-Project promotion, merge/deploy, and changing Goose provider architecture.

## Required gates

The design can proceed to implementation only after product review resolves the questions below. A live-provider release remains separately blocked until the Goose qualification campaign passes; do not use fixtures or simulated ACP as evidence of provider-backed readiness.

Concrete end-to-end acceptance scenarios should demonstrate:

- Exploration starts without creating a Process and is isolated to its Project.
- No-repository exploration receives no repository files; selected-repository exploration is confined to the explicitly pinned read-only snapshot.
- Invalid/out-of-workspace/symlink-escape reads are refused before human permission is requested.
- Refresh, reconnect, and server restart preserve exploration identity and do not duplicate prompts.
- A finding saved from one message retains exact session and sequence provenance, including when that source is unavailable.
- Existing-Process promotion in the same Project links the same session and exact events; a second, separate user action records an update or proposal, preserves accepted definition version, and rejects a cross-Project target.
- New-Process promotion accepts the user-edited definition as version 1 and links the same session/source events atomically; no knowledge acceptance, intent amendment, or execution authorization is implied.
- For target Process A with repository R1 and exploration pinned to R2, association produces historical context only, leaves the R2 workspace unchanged, and blocks further repository-backed work through that association; a new Process-scoped session may use only target-authorized repositories.
- For matching repository identity but a different expected revision, promotion keeps the old pinned commit; tests prove it is never silently replaced.
- Restart during an in-flight prompt or promotion preserves atomic association and existing uncertain-operation semantics; browser reconnect restores the same session/event cursor without duplicate prompt dispatch.
- Re-promoting or promoting to a second Process is rejected; concurrent/retried promotion cannot create duplicate Process links or duplicate activity.
- Migration upgrade tests start from the currently shipped schema and prove prior Process sessions and records still load.
- Full repository verification passes; provider-backed qualification is reported separately.

## Open product decisions

1. Should pre-Process exploration allow explicit read-only repository access, or be context-only? **Recommendation:** allow one explicitly selected linked repository, behind the same isolation and permission rules. This is the largest product/security tradeoff.
2. Should association to an existing Process be allowed when repository identity does not match, with history-only semantics, or should mismatch prevent association entirely? **Recommendation:** allow history-only association with an unmistakable state and no further repository work through that session.
3. Does “knowledge” acceptance belong in the first implementation, or should the increment stop at association plus existing update/proposal actions? **Recommendation:** defer a new knowledge record type; preserve the conceptual distinction and make users choose update or proposal.
4. Should promotion to a new Process default its repository scope to the exploration's repository, offer it as an editable suggestion, or leave scope blank? **Recommendation:** suggest the same repository/commit context for user review, but require explicit acceptance and never infer authorization from that suggestion.
5. What product behavior is acceptable if Goose qualification remains unresolved? **Recommendation:** do not present an unqualified live agent. The product can ship session ownership and UI only when the provider-backed capability is qualified; no simulated conversation should stand in for it.

## Relationship to existing roadmap

This proposal refines the v0.3 product document's deferred Project-owned exploration item. It does not supersede v0.3 P0, the v0.2 qualification report, or DDR-042. Keep any implementation branch stacked on the accepted v0.3 revision and its v0.2 prerequisite. Do not merge v0.3 directly to `main` or conflate this product increment with qualification of the Goose runtime.
