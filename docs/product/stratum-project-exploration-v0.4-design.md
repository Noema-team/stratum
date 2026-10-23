# Stratum v0.4 — Project Exploration and Process Promotion

**Status:** Product direction and five product decisions approved; implementation design below is proposed and awaits authorization.
**Date:** 2026-10-23
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

## Approved product decisions

1. **Project-owned exploration may explicitly read one linked repository.** No repository access is inferred. With no repository selected, exploration must have no Project repository content available to Goose. With one selected, use an isolated, pinned, read-only snapshot and existing per-operation permissions.
2. **Repository-mismatched Process association is historical-only.** Preserve the conversation link and provenance, but do not continue repository-backed work through that session for a Process whose accepted repository scope does not include the mounted repository. Start a new Process-owned AgentSession in the target scope.
3. **Do not add a Project knowledge record type in the first slice.** Association remains distinct from recording an update/proposal, accepting reusable knowledge, amending accepted intent, and authorizing execution. Use existing update/proposal flows only; leave new knowledge acceptance for a later decision.
4. **For a new Process, suggest the exploration's repository as editable context, never as authorization.** The user explicitly accepts the Process definition and repository scope. Scope mismatch keeps the old conversation historical and requires a new Process session.
5. **Do not present unqualified provider-backed behavior.** Goose qualification remains an independent gate. The interface must not simulate an agent conversation to fill this gap; whether any UI-only/session-persistence work can ship before qualification is an implementation/release decision, not a change to this product direction.

Claims transferred into existing Process records preserve `(sessionId, eventSeq)`, remain identified as agent claims, and are drafts until a user records them. Missing source events are reported as unavailable, never substituted by sequence number alone.

## User journey

### Start and investigate

From a Project Overview, the user selects **Start exploration**, enters an initial question, and chooses either **No repository** or one linked repository. The confirmation names the Project, repository identity (if any), pinned snapshot, and read-only access. The user can inspect or cancel before the first prompt is sent.

The exploration page shows its Project breadcrumb, question, repository scope, last-observed session state, complete messages, and source details. It offers follow-up prompts and **Record finding** from a completed agent message. Each prompt remains idempotent across refresh/reconnect. Unavailable runtime, interrupted prompts, and missing provider configuration are explicit states with recovery guidance; the UI does not simulate a live agent.

### Promote to an existing Process

The user chooses **Add to a Process**, then selects an active or paused Process in the same Project. The review screen shows the Process's accepted intent/version alongside the exploration's repository snapshot and the exact source messages or user-authored summary being carried forward.

If the user confirms association, Stratum links the exploration to that Process without yet recording knowledge, changing accepted intent, or authorizing execution. The user may separately record a user-authored update or create a proposal. Each resulting record links to the exploration session and exact event sequence. The Process definition/version remains unchanged unless the user separately enters and accepts the versioned amendment flow. The exploration remains visible in Project history and linked to that one Process. The user returns to the Process at the chosen record, or to its overview if they only associated it. Reusable knowledge acceptance is out of this slice.

If the Process is in another Project, it is not selectable. If the exploration has a repository snapshot and that canonical repository identity is absent from the target Process's accepted repository set, association is historical-only. The session remains pinned to its original repository and commit; it cannot continue as work for a Process using different repositories. The UI must state that a new Process-owned session in the target Process's authorized repository scope is required before further repository-backed work. If repository identity matches, the user reviews the pinned commit shown in the association screen; the current Process model does not declare a required commit. A no-repository exploration stays without repository access after association.

### Promote to a new Process

The user chooses **Create a Process**, reviews and edits title, intent, desired outcomes, constraints, and repository scope, then explicitly accepts. The repository scope must be selected by the user; suggested fields from the conversation remain drafts until edited/accepted. Stratum creates the Process and accepted definition version 1, then associates the exploration with it. It does not create execution work or authorize tools.

The exploration can become an active Process-owned session only if it passes the promotion-eligibility rules below. Otherwise it is associated as historical context and the user starts a new Process-owned session. No remount, snapshot substitution, or permission carry-over is allowed.

### Return later

Project Overview lists explorations with last observed activity and state, distinct from Process attention. Direct links reopen the same exploration and event cursor. After promotion, the Project history and Process both link to the same conversation identity; there is one transcript and one provenance chain, not copied messages.

## Proposed implementation model

```text
Project (visibility and repository-membership boundary)
  ├── AgentSession (Project-owned conversation identity; optional Process ownership/link)
  │     └── RuntimeWorkspace (optional repository snapshot; one-time operation permissions)
  └── Process (accepted, versioned intent and human decisions)
        └── linked exploration(s) as source/context, not authority
```

Promotion never transfers visibility or ownership out of the Project or changes prior record meaning. The AgentSession ID remains stable. Distinguish two states: **historically associated** means the session remains Project-owned with no Process ownership and is shown as source/context on exactly one Process; **active Process-owned** means its `process_id` points to that Process and it may continue only under that Process's current scope and session rules. An associated session cannot be attached to another Process. A user who wants to reuse a finding elsewhere creates a new user-authored record there with an explicit source reference and Project access check.

The existing v0.2 schema already stores `project_id` on `app_agent_sessions`, but requires `process_id`; each runtime workspace also requires a Process ID and repository checkout. The smallest model change keeps `app_agent_sessions` as the only conversation engine and uses two distinct nullable columns: `process_id` continues to mean active Process ownership (and enforces one active session per Process); `associated_process_id` records a historical association when the session cannot become active Process-owned. Exactly one target may be recorded in `associated_process_id`; the same target is required if `process_id` is set. The migration backfills both columns from `process_id` for existing sessions. No second Conversation/Exploration table, transcript, operation, permission, or recovery subsystem is introduced. The existing `project_id` is the required owner and authorization root before Process association. Every session endpoint/service path authorizes from the session's Project; selected repository membership is checked at creation and again for each operation. Process ownership/association can only be set once. Promotion of a new Process and ownership/association must be atomic; promotion to an existing Process validates same-Project ownership and eligibility in the linking transaction.

Retain `project_id` and selected repository/snapshot as stable authority inputs; make Process ownership optional on both session and runtime workspace. For SQLite, use the next append-only migration (Migration 19 on the current baseline). Existing Process-owned sessions stay `process_id`-owned, with the same IDs, workspace IDs, repository IDs, commit/path, engine identifiers, lifecycle, events, operations, permissions, timestamps, and uniqueness behavior. Backfill their `associated_process_id` to the same existing Process. New explorations have `process_id NULL`; historical association uses `associated_process_id`, while eligible active handoff sets both session and workspace `process_id` plus `associated_process_id` to the same Process. Rebuild only the session/workspace tables and affected indexes needed for nullable ownership and repository-free workspace support; preserve child tables and their FK targets. Add one nullable dispatched-prompt field to operations if required to persist the exact Process context envelope. Keep the one-active-session-per-Process partial unique index over `process_id` for active lifecycle states. No repository/session permission is inferred from nullable values.

The migration must run atomically under the repository's established SQLite migration runner, which disables FK enforcement only around the migration transaction and runs `PRAGMA foreign_key_check` before recording the migration. On any DDL, copy, validation, or FK-check failure, rollback must restore the original schema/data and leave the migration unrecorded; the runner must restore `foreign_keys=ON` in all cases. Tests must seed existing Process sessions with every child-record kind, snapshot all preserved columns/IDs/counts, run the migration, and compare them; assert the active-session index still rejects a second active Process-owned session; assert `foreign_key_check` is empty. Inject a failure after table rebuild/copy but before migration recording, assert schema/data/migration ledger are unchanged and FKs are on, then rerun successfully. Also test clean upgrade and restart after migration. No destructive or lossy fallback is permitted.

### Promotion eligibility and Process context

Historical association is permitted only within the same Project, is idempotent, and never makes the session active Process-owned. It may be recorded while the session is running or has an unresolved operation because it does not affect runtime state; the UI labels the link historical-only and does not present the session as Process work.

Active Process ownership handoff is allowed only when all checks pass in one transaction: (a) same Project; (b) target Process active and has no other nonterminal Process-owned AgentSession, preserving the existing unique constraint; (c) source session lifecycle is `idle`; (d) no pending/in-flight/`outcome_unknown` operation, no pending permission, and no unreconciled ACP request; (e) repository scope is compatible; and (f) no prior Process association. Prompt admission and promotion must serialize per session: if prompt dispatch wins, promotion sees the durable in-flight operation and is ineligible; if handoff wins, the next prompt uses Process context. Compatibility means an empty workspace may hand off only to a Process with no repository scope; a repository-backed session may hand off only when that canonical repository identity is included in the target Process's accepted repository IDs. If the Process includes additional repositories, the handoff does not expose them through this session. If the selected repository is absent (the target uses different repositories), the association is historical-only. The existing model does not pin an expected commit in Process definition, so show the current session commit for explicit review and preserve it unchanged; never infer or silently substitute a target commit. A failed eligibility check leaves the session Project-owned and permits only an explicit historical association. It never stops or cancels work as a side effect.

For an eligible handoff, the next user prompt (not an unsolicited automatic turn) must include a server-generated Process context envelope containing the accepted Process definition and version, Project/Process IDs, repository identity and pinned snapshot, and the user prompt. Persist the exact dispatched prompt envelope with its operation before ACP dispatch, while retaining the user's original prompt separately for display/idempotency. The envelope is refreshed from authoritative Process state for each new prompt; it does not rewrite prior transcript or re-send old messages. If this context cannot be constructed or persisted, do not dispatch. Historical-only sessions receive no Process context and cannot continue under the Process link; the user starts a new Process-owned session, which receives the ordinary Process briefing. Context injection must not change Goose permissions or available tools.

### Repository-free exploration under the existing runtime

“No repository” means no Project/Process checkout, source file, or repository path is mounted or readable by Goose. It still needs the existing Goose container and ACP runtime. Extend the workspace representation with an explicit `workspace_mode` (`repository_snapshot` or `empty`) and nullable repository metadata. For `empty`, create a session-private empty host directory, mount only that directory read-only at `/workspace`, and keep Goose engine state in its separate existing per-session writable directory. Do not use the Project root, Stratum checkout, a Process workspace, or a shared temporary directory as the empty workspace. File-read mediation may only address the empty `/workspace`, so every attempted repository read fails closed; no host paths or repository IDs are synthesized. Explicitly verify that Goose/provider configuration and credentials are not stored in the mounted empty directory. Runtime start/recovery must accept the empty mode without Git-root/remote checks, while preserving container isolation and cleanup.

This mode also needs no-repository-compatible schema: nullable `repository_id` and `repository_commit`, and a workspace path whose meaning is governed by `workspace_mode`; for `repository_snapshot`, all repository fields and the managed snapshot path are required; for `empty`, persist the private empty-directory path, no repository ID or commit, and `access_mode='read_only'`. Use CHECK constraints to enforce the two valid combinations. Existing rows migrate as `repository_snapshot`. Keep Docker required and fail closed if the isolated empty workspace cannot be created/mounted. This is not host execution or a provider-free simulated conversation.

### Session lifecycle and navigation

Promotion changes the optional Process association only; it does not change AgentSession lifecycle. `starting`, `idle`, `running`, `awaiting_permission`, `interrupted`, `outcome_unknown`, `stopped`, and `failed` retain their v0.2 meanings. Promotion must not dispatch, resume, stop, reconcile, or acknowledge an uncertain operation. If a server restart occurs during promotion, the association transaction is either wholly committed or absent; ordinary restart recovery then marks/reconciles session state under existing v0.2 rules without resending a prompt. If the browser reconnects, it reloads the same session ID and event cursor, then discovers the association from persisted state. An in-flight operation remains subject to existing uncertain-outcome handling. Direct Project and Process links resolve to the same AgentSession and event identities.

## Scope and access rules

- Exploration is local single-user in this increment, consistent with the current application's qualification limits; do not imply multi-user privacy/RBAC guarantees.
- A repository must already be linked to the selected Project. Repository sharing with another Project does not share its exploration history, permission decisions, or Process records.
- No repository content is mounted unless explicitly selected. Repository-free exploration uses only a private empty read-only `/workspace`; selected-repository exploration uses one pinned snapshot.
- Path validation, symlink containment, file size/type restrictions, and human permission mediation remain in force. Deny unsupported capabilities before a human approval prompt.
- Permission decisions remain one-time and tied to their exact ACP operation. Promotion grants no permission, and Process acceptance cannot override runtime isolation.
- Existing Process decisions, proposals, versioned intent, and kernel WorkItems remain untouched except for explicit user-triggered Process activity/proposal creation through existing services.
- If a Process repository set changes after association, the session's original workspace does not change. Continuing requires validation against the new authorized scope or a new correctly scoped session.

## Bounded v0.4 implementation plan

This plan is proposed, documentation-only, and not implementation authorization. Keep changes within the existing Stratum application, AgentSession services, SQLite migration path, and Goose ACP runtime; do not create a second conversation engine.

1. Append-only atomic migration for optional Process ownership/association and explicit repository/empty workspace modes, with rollback and FK tests described above.
2. Project-owned exploration create/list/detail using the existing AgentSession ID, event, operation, permission, recovery, and ACP pathways; authorize each operation from Project ownership. Add a private empty read-only workspace or an explicitly selected Project-linked repository snapshot.
3. Draft a finding from an exact completed message and preserve `(sessionId,eventSeq)` through save/reload.
4. Implement same-Project historical association and eligible active Process ownership handoff. Existing-Process association creates no Process record until the user separately selects update or proposal. New-Process promotion atomically creates the accepted definition version 1 and associates/hands off the session; it does not accept knowledge or authorize execution.
5. For an eligible active handoff, supply persisted Process context on the next user prompt. For historical-only association or incompatible repository scope, retain the session as Project-owned history and require a new Process-owned session for further Process work.
6. Provide direct Project/Process navigation and explicit lifecycle, unavailable, historical-only, and scope-mismatch states. Do not imply provider qualification.

Out of scope: multi-agent or multi-session conversations, multi-user collaboration, Project knowledge, automatic summarization as accepted truth, repository writes, shell/terminal tools, execution handoff, kernel changes, cross-Project promotion, merge/deploy, and changing Goose provider architecture.

## Acceptance criteria for implementation review

The following tests are required before v0.4 implementation review can be accepted. Passing simulated ACP tests does not qualify provider-backed behavior; the Goose campaign remains a separate gate.

Concrete automated integration tests should demonstrate:

- Exploration starts without creating a Process and is isolated to its Project.
- Repository-free exploration runs in an isolated container with an empty read-only `/workspace`; repository file reads fail and no host/Project/Stratum path is mounted. Selected-repository exploration remains confined to its pinned read-only snapshot.
- Invalid/out-of-workspace/symlink-escape reads are refused before human permission is requested.
- Refresh, reconnect, and server restart preserve exploration identity and do not duplicate prompts.
- A finding saved from one message retains exact session and sequence provenance, including when that source is unavailable.
- Existing-Process historical association links the same session and exact events but leaves `process_id` null; a separate user action records an update or proposal, preserves accepted definition version, and rejects a cross-Project target.
- Eligible active handoff succeeds only for an idle session with no in-flight/uncertain operation or pending permission, matching scope, and no other nonterminal Process-owned session. It sets Process ownership atomically and keeps the one-active-session constraint intact.
- A Process with an existing active AgentSession rejects active handoff; it may only receive a historical association, and that link cannot be used to dispatch prompts as Process work.
- A prompt racing with promotion is admitted exactly once under serialized session state: either its intent is persisted before promotion and makes active handoff ineligible, or handoff commits first and the prompt persists the Process context envelope.
- New-Process promotion accepts the user-edited definition as version 1 and associates the same session/source events atomically when eligible; no knowledge acceptance, intent amendment, or execution authorization is implied.
- After active handoff, the next user prompt includes and persists the correct accepted Process definition/version and repository scope before ACP dispatch; prior transcript/events are unchanged. Historical-only associations receive no injected Process context.
- For target Process A with repository R1 and exploration pinned to R2, association produces historical context only, leaves the R2 workspace unchanged, and blocks further Process work through that association; a new Process-owned session may use only target-authorized repositories.
- For matching repository identity, active handoff shows and preserves the existing pinned commit; tests prove promotion never changes the snapshot. A Process with a different repository set cannot gain that workspace through the association.
- Restart during an in-flight prompt or promotion preserves atomic association and existing uncertain-operation semantics; browser reconnect restores the same session/event cursor without duplicate prompt dispatch.
- Re-promoting or promoting to a second Process is rejected; concurrent/retried promotion cannot create duplicate Process links or duplicate activity.
- Migration tests upgrade a representative existing database; verify all session/workspace/event/operation/permission IDs and values, active-session uniqueness, and `foreign_key_check`; inject a mid-migration failure and prove rollback leaves the original schema/data/ledger intact with foreign keys re-enabled; retry succeeds.
- Full repository verification passes; provider-backed qualification is reported separately.

## Remaining blockers and boundaries

- Product direction and the five listed product decisions are approved. The remaining blocker to implementation is review/authorization of this revised implementation design; no implementation has started.
- Provider-backed Goose qualification remains a separate blocker to any claim or release of qualified live-agent behavior, not a reason to merge or expand this design.
- Exact migration statement ordering and user-facing copy may be resolved during implementation, provided the specified rollback, foreign-key, ownership, scope, and clarity requirements are met.

## Relationship to existing roadmap

This proposal refines the v0.3 product document's deferred Project-owned exploration item. It does not supersede v0.3 P0, the v0.2 qualification report, or DDR-042. Keep any implementation branch stacked on the accepted v0.3 revision and its v0.2 prerequisite. Do not merge v0.3 directly to `main` or conflate this product increment with qualification of the Goose runtime.
