# Stratum Product Experience v0.3

**Status:** Proposed UX and product specification; not ratified and not implementation authorization.  
**Date:** 2026-10-22  
**Decision context:** DDR-042 accepts the Process-centric product priority and initial application scope. It does not ratify this document or every feature in the earlier Process-Centric Product Model draft.  
**Companion:** [Annotated wireframes and interaction states](stratum-product-experience-wireframes-v0.3.md)  
**Baseline inspected:** `feat/process-agent-sessions-v0.2` at `0875c35f6e3b4e24e4219a9ef69f6f14c982ae83`

## 1. Product recommendation

Stratum should help a person maintain a clear understanding of a project's goals and move important work forward with agents. A Process is the durable place for one ongoing effort: its accepted intention, relevant context, proposals, decisions, evidence, and unresolved next steps.

The product should feel like a connected project workspace, not a task database with a chat panel. A person can enter through Home, orient in a Project, work inside a Process, and return later without reconstructing the story from transcripts. The common path is:

> Understand the situation → investigate or continue → inspect evidence → decide what is accepted → choose the next bounded action.

The Process Workspace is the core experience and should be designed first. Project Overview and global Home are progressively broader views over the same persisted facts and actions, not separate state machines. Conversation-first exploration is a proposed entry path that must attach to the same Project and later connect to a Process without changing what the conversation was authorized to access.

This document extends the direction of [DDR-042](../decisions/ddr-042-process-centric-application.md) and the accepted [Process Application v0.1](stratum-process-application-v0.1.md). It does not authorize implementation, change execution-kernel contracts, or qualify the current Goose integration. The full provider-backed runtime campaign remains separately blocked as recorded in the [v0.2 qualification preflight](stratum-v0.2-goose-qualification-report.md).

## 2. What is established, implemented, and proposed

| Status | Product capability or decision | Current evidence and limits |
| --- | --- | --- |
| Accepted direction | Projects are the context boundary. A Process is a durable effort toward an outcome, not an executable WorkItem. The application is delivered in bounded end-to-end increments. | [DDR-042](../decisions/ddr-042-process-centric-application.md). |
| Implemented | Projects and Objectives; explicit project/repository membership; Process definitions and lifecycle; versioned accepted amendments; proposal/review history; activity; project activity feed; unresolved-item handling; bookmarkable navigation. | [v0.1](stratum-process-application-v0.1.md) and [functional maturity](process-application-functional-maturity.md). This is a local single-user application, not multi-user collaboration or RBAC. |
| Implemented, awaiting real-runtime qualification | One persistent read-only Goose AgentSession per Process; pinned repository snapshot; one-time read permissions; durable prompt identities and events; browser refresh/reconnect; recovery controls; completed-message provenance. | [v0.2](stratum-agent-enabled-processes-v0.2.md). Simulated ACP and Docker checks are not provider-backed acceptance. |
| Established boundary | Agent claims do not accept Process intent, complete a Process, grant a permission, or authorize a kernel WorkItem. Agents propose; deterministic Stratum services validate and materialize authorized state. Repository sharing does not share Process history. | DDR-042 plus [DDR-032](../decisions/ddr-032-control-plane-migration.md), [DDR-034](../decisions/ddr-034-models-propose-stratum-materializes.md), and [DDR-041](../decisions/ddr-041-definition-execution-handoff.md). |
| Proposed UX | Process-first conversation surface; an explicitly project-owned exploratory conversation that can be promoted; a concise Project Overview and global Home; provenance-aware accepted knowledge; evidence-led proposal cards; integrated navigation and responsive states. | This v0.3 specification. Product-owner review is required before implementation. |

The earlier [Process-Centric Product Model v0.1](process-centric-product-model-v0.1.md) remains a design draft. Its Explore, Manage, Coordinate journeys and Project Overview concepts inform this specification, but its wider multi-agent model and sketches are not automatically accepted. Existing technical concepts should appear in the UI only when they explain a real status, permission, evidence source, or recovery action.

[DDR-035](../decisions/ddr-035-post-d34-operational-pivot.md) still governs evidence-driven engineering and the execution roadmap; DDR-042 changes product priority without erasing kernel authority, evidence contracts, or qualification discipline. Designing this experience does not justify speculative runtime architecture. Keep the real Goose campaign separate, and do not alter a running qualification campaign to improve the design.

## 3. Product principles

1. **Show the work's meaning before its machinery.** Lead with the accepted goal, current situation, evidence, and next decision. Reveal session, runtime, and kernel details on demand.
2. **Keep authority legible.** An agent suggestion is a claim. A proposal is awaiting a human outcome. Acceptance records a Process decision. Execution requires its own explicit authorization and policy path.
3. **Make status traceable.** Every displayed status must come from a persisted Process record, an observed runtime state with a freshness marker, or an explicitly identified external evidence source. Never infer progress from optimistic prose, a session being idle, or a percentage.
4. **Preserve the story.** Rejected alternatives and revised intent remain visible with their reasons. New work adds history; it does not erase it.
5. **Put consequential choices beside their context.** The person should be able to inspect a proposal and its evidence, ask a follow-up, and decide without copying text among disconnected forms.
6. **Progressively disclose detail.** A concise summary is the default. Full events, transcript, permission scope, operation IDs, and recovery diagnostics remain available when useful.
7. **Respect Project boundaries.** Project-owned conversations, knowledge, decisions, and Process history remain private to their Project even when repositories are shared.
8. **Prefer a small useful loop.** Make one Process easy to understand, continue, review, and resume before adding coordination machinery.

## 4. Navigation and information architecture

Use a three-level hierarchy with a project-wide conversation entry point:

```text
Home
└── Project
    ├── Overview
    ├── Processes
    │   └── Process Workspace
    ├── Conversations
    ├── Knowledge & decisions
    └── Repositories & resources
```

The persistent primary navigation contains **Home** and **Projects**. A Project context header identifies the current Project and provides its Overview, Processes, Conversations, Knowledge, and Resources destinations. Within a Process, a breadcrumb (`Home / Evershift / Improve NPC movement`) and an anchored Process header preserve orientation. Opening an attention item should land on the exact proposal, permission, or evidence section, not merely the Process top.

Keep the main work surface as one Process page with an overview and an activity/conversation stream. Use contextual panels or drawers for evidence details, proposal comparison, and raw transcript. Avoid making the conversation, history, evidence, and review separate destinations that make users lose the Process context.

The Project Overview and Home are concise action lists. They show a few prioritized facts and links into the owning Project or Process. They do not replicate every Process or every event. On narrow screens, navigation collapses, attention and current situation precede secondary context, and drawers become full-screen sheets.

### Status model shown to users

Keep these dimensions separate rather than inventing one composite state:

| Dimension | Display | Source |
| --- | --- | --- |
| Process lifecycle | Active, Paused, Completed | Accepted Process lifecycle record. |
| Attention | Needs your decision, Permission needed, Waiting for agent, Blocked, No action needed | Derived only from explicit unresolved records and observed current session state. Each badge links to its source. |
| Proposal | Awaiting review, Revision requested, Deferred, Accepted, Rejected | Proposal-linked decision record. |
| Agent session | Starting, Working, Waiting for permission, Idle, Interrupted, Outcome uncertain, Stopped, Failed | Persisted AgentSession lifecycle; include last observed time when not live. |
| Evidence | Current for source revision, Older revision, Unverified, Unavailable | Origin and freshness of the evidence; do not upgrade a claim to verified automatically. |

“Next step” may be shown as a suggested action when the records support it. Label it as a suggestion, identify the reason, and let the human choose. Do not imply that an agent session's lifecycle is Process progress.

## 5. Process Workspace — primary experience

The Process Workspace answers four things immediately: **what did we agree to do, what is known now, what needs attention, and what can I do next?** It keeps the active conversation beside the durable history and makes a consequential decision specific to one proposal version.

### 5.1 Page structure

- **Process header:** title, lifecycle, Project breadcrumb, accepted definition version, last meaningful activity, and actions to amend, pause/resume, or complete.
- **Accepted intention:** goal, why it matters, success criteria, constraints, and repository/resource scope. A compact current version is always visible; prior versions are inspectable.
- **Current situation:** a short record-derived overview grouped into accomplished, in progress, unresolved, blocked, and needs-you. Each item links to its event, evidence, proposal, or session. Agent-generated summaries are clearly labeled as claims until reviewed.
- **Work room:** the AgentSession conversation and relevant human updates in chronological context. Show complete agent messages as the readable default; expose raw chunks/events in diagnostics only. Show runtime freshness and permission state without presenting these as accepted outcomes.
- **Decision queue:** pending proposal, definition amendment, or permission card with the exact action and scope. Keep proposal review distinct from tool permission and execution authorization.
- **Evidence rail:** files, commits, tests, PRs, measurements, or source links cited by the current proposal. Show source, revision, result, freshness, and limitations. If evidence is unavailable, say so.
- **History:** accepted decisions, rejected alternatives, revisions, and major activity, newest first with filters. Transcript search and raw session details are secondary.

### 5.2 Accepted intention and amendments

Display the accepted definition as the contract for the Process: desired outcome, success conditions, constraints, and explicit repository scope. A proposed amendment is shown separately with a before/after summary and the reason for change. Accepting it creates the next accepted version; rejecting it leaves the current version unchanged. A Process decision never widens an AgentSession permission or authorizes execution by itself.

### 5.3 Current situation without invented progress

The default situation summary is assembled from persisted facts: completed/accepted records, latest explicit update, active or interrupted session, pending review/permission, and unresolved acknowledgment. Each entry carries a source link and timestamp. A generated summary can be offered as a draft, but must cite the records it summarizes and remain visibly unreviewed until a human accepts or edits it.

Do not show progress percentages, “on track,” inferred ownership, or a confident completion statement without an explicit source and semantics. If the app cannot establish what is happening, display **Status unknown** with the last observed time and a recovery action.

### 5.4 Conversation and collaboration

Conversation is the working surface for investigation, questions, and follow-up. It is contextualized by the accepted Process definition and Project knowledge selected for the turn. Users can switch between the complete-message view and source/evidence details without leaving the Process. Prompts are durable operations; refreshing or reconnecting reads existing state and never resends a prompt.

The initial experience supports one AgentSession, consistent with v0.2. Design the page so a later session list can fit, but do not imply simultaneous agents or a coordinator. Human collaborators and multiple agents are later capabilities requiring their own identity, permission, and concurrency decisions.

### 5.5 Proposal and review experience

A proposal card starts with a plain-language summary and includes:

- The exact proposal and version being considered.
- Why it is proposed, expected benefit, alternatives and tradeoffs.
- Supporting evidence with source and freshness.
- Known uncertainty, missing evidence, and risks.
- A clear statement of what acceptance records or authorizes.
- Actions: **Accept proposal**, **Request revision**, **Defer**, **Reject**, or **Ask a question**.

Actions are contextual. **Accept proposal** accepts the named direction or Process record only. If implementation is a separate step, show that it still needs a separately scoped execution authorization. The review card must not contain a generic “approve agent” control. Revision requests preserve the proposal and append the request; a revision is a new proposal version, not an overwrite. Deferred proposals remain discoverable and can be reopened.

When a complete agent finding is in the conversation, offer **Ask a follow-up**, **Record an update**, or **Draft a proposal from this finding** inline. Drafting should prefill a review card with provenance; it should not submit the proposal automatically or require manual copying. The user reviews and edits the claim, evidence, and scope before creating it.

### 5.6 Evidence and continuity

Evidence opens in a side panel or sheet while preserving the Process header and current decision. A compact evidence row states what it demonstrates and what it does not. Code evidence is pinned to a repository commit; CI and review evidence is tied to its exact candidate revision and freshness. Agent citations remain agent claims unless independently checked or explicitly accepted under a defined evidence policy.

History groups activity into understandable moments: investigation, proposal, decision, candidate, verification, and outcome. Users can inspect the original event or transcript, but should not need to read the transcript to know why a proposal was rejected. A completed Process remains searchable with its accepted outcome, evidence references, unresolved caveats, and reusable knowledge candidates.

## 6. Project Overview and global Home

### 6.1 Project Overview

Opening a Project should answer: where are we, what needs my attention, what are agents/people doing, what changed, and what can I do next? Put these in this order:

1. Project purpose and accepted priorities.
2. **Needs your attention:** decisions, permission requests, blocked work, and explicit unknown states, with owner and age.
3. **Current Processes:** active and paused efforts with accepted goal, current record-derived situation, and next supported action.
4. **Meaningful changes:** accepted decisions, completed investigations, changed definitions, evidence outcomes, and linked external updates since the user's last visit when reliably available.
5. **Project context:** accepted knowledge, unresolved risks/questions, repository/resource links, and conversations.

The existing process counts and chronological activity feed can be reused, but counts are secondary and do not imply health. Agent activity must distinguish “last observed” from “live.” Empty states should offer a direct action: start an exploration, create a Process, or link a repository.

### 6.2 Global Home

Home is a cross-Project attention inbox, not a dashboard copy of every Project. Show:

- Items requiring a human action, grouped by action type and sorted by urgency/age.
- The most recent meaningful changes across Projects, with links to the source records.
- Processes with an agent waiting for permission, an interrupted session, or an uncertain operation.
- Recently active Projects and a small “continue conversation” list.
- Quick actions to start a Project conversation or create a Process.

Each Home item identifies the Project, Process, exact request, and scope. Dismissing an item is not the same as deciding it; preserve the underlying record. The first release can use a derived query over persisted app records and should avoid email, push notifications, unread counters, or background summarization infrastructure.

## 7. Conversation-first exploration and promotion

Conversation before a defined Process is a product need in the model draft, but v0.2 currently requires the AgentSession to belong to a Process. Keep Project ownership explicit and avoid a hidden Process that users never intended to create.

### 7.1 Options

| Option | Benefits | Costs and risks |
| --- | --- | --- |
| Create a hidden/draft Process at first message | Keeps the current session-to-Process relationship. | Misrepresents exploration as an ongoing Process; confuses draft with accepted intent; can pollute Process counts and attention. |
| Let AgentSession be Project-owned with no Process until promotion | Small change to the current ownership concept; preserves session identity and makes the user journey honest. | Requires nullable Process association and clear Project-level permission/context; promotion must validate repository scope and transfer no authority. |
| Add a general Conversation aggregate that may contain multiple sessions and Processes | Flexible for future multi-agent conversations. | Adds a new abstraction and many-to-many lifecycle before the need is demonstrated. |

### 7.2 Recommendation

Use a Project-owned exploratory conversation backed initially by one durable AgentSession whose `processId` association is optional. The Project remains the ownership/visibility boundary before and after promotion. Do not create a Process until the user accepts the proposed intent. On promotion:

1. The agent may draft a Process title, intent, outcomes, constraints, and relevant findings from the conversation.
2. The user edits and accepts the definition. Stratum creates the Process with accepted definition version one and records the source conversation and cited event references.
3. The same AgentSession identity, transcript, operation IDs, and permission history remain intact and become associated with the Process. Promotion does not replay prompts or rewrite prior event provenance.
4. The repository scope must be explicit. Only a repository authorized for that Process may remain usable. If the exploratory session's workspace does not match the accepted repository scope, it becomes read-only history and the user starts a new Process-linked session; do not silently remount or widen access.
5. A prior permission applies only to its exact one-time operation. Promotion grants no new tool permission and does not turn an agent claim into an accepted fact.

This is the smallest coherent ownership model, but it is a new product/data decision requiring owner approval and a separate implementation design. An alternative is to delay repository access in pre-Process exploration and keep the initial conversation project-context-only; user research should determine whether that restriction is acceptable before implementation.

## 8. Durable Project knowledge

Knowledge should be concise, reviewable, and traceable—not an agent-maintained wiki and not a transcript digest treated as truth.

### 8.1 Knowledge states

1. **Agent claim:** statement in a message or proposed finding. It is attributed to its AgentSession and event; it is not verified or accepted.
2. **Supported finding:** a human or agent links evidence that bears on the statement. Verification describes the evidence and its limits; it does not grant authority.
3. **Accepted knowledge:** a human accepts a concise statement for Project or Process reuse, with supporting sources, scope, assumptions, accepted time, and review trigger. This records human judgment, not universal truth.
4. **Superseded or needs review:** new evidence, repository revision, changed assumptions, or a conflicting decision makes prior knowledge less reliable. Keep it in history and point to the replacement or review reason.

**Accepted knowledge still is not execution authorization.** It can inform future briefings but cannot authorize a tool, code change, WorkItem, merge, or Process completion.

### 8.2 Capture and use

For the first slice, reuse Process updates, accepted proposal/review records, definition versions, and event provenance. Let a user mark an accepted conclusion as reusable within its Process. Do not build a cross-Process knowledge store yet. The next increment may add a small Project-level knowledge list with a human-authored statement, scope, source references, accepted-by/time, assumptions, and a “review when” condition. Do not automatically ingest every agent response.

Future agent briefings should include only relevant accepted knowledge and active Process constraints, with links to sources and version context. The user should be able to inspect and correct the briefing. Keep retrieval bounded and explain inclusion; never include private context from another Project merely because the repository is shared.

## 9. Concrete user journeys

### Scenario A — Explore an unclear problem

- **Entry:** Evershift Project → **Start an exploration**. The user writes: “NPCs bunch up near doorways. Can you investigate what is happening before we choose a fix?”
- **Interaction:** Stratum opens a Project-owned conversation, shows selected repository scope and access boundary, and starts an agent session. The agent inspects only authorized sources; findings appear as complete messages with event/evidence links. The user asks follow-ups.
- **Promotion:** “Turn this into a Process” opens an editable draft: *Improve NPC crowd movement*, goal, no-regression constraints, options, evidence, and open question. User accepts the v1 definition.
- **Persistent records:** Project-owned conversation/session; prompt operations and events; accepted Process v1; promotion link and source event references; any explicitly recorded findings/proposals. Session identity is preserved if repository scope remains valid.
- **Result:** The user can continue in the new Process and understands which statements are claims, which findings have evidence, and what remains undecided.

### Scenario B — Manage an ongoing improvement

- **Entry:** Home review item or Evershift → Process *Improve terrain performance*.
- **Interaction:** Header presents accepted success conditions and constraints. Current situation says investigation is complete, Candidate B is proposed, and a visual regression test is missing. User opens candidate evidence, asks for the missing test, and reviews a versioned proposal.
- **Decision loop:** User requests a revision. The original proposal and reason remain. Agent submits a revised proposal with evidence; user accepts the direction. Any execution requires a separate existing authorized path. Resulting test/PR evidence is attached to the exact candidate. User may reject the candidate and continue another iteration.
- **Persistent records:** Definition version, proposals and linked reviews, conversation operations/events, evidence source/revision, accepted or rejected outcomes, and explicit Process outcome.
- **Result:** Rejection does not erase the attempt; accepted Process intent remains stable; no proposal action silently dispatches or completes a kernel WorkItem.

### Scenario C — Return after several days

- **Entry:** Home lists one exact proposal awaiting review, one read permission request, and one interrupted session. Each card shows Project, Process, age, and exact action.
- **Interaction:** The user reviews the proposal in its Process with evidence and alternatives. They then inspect the permission's normalized path and approve or deny only that read. For the interrupted session, they inspect last-seen status and explicitly reconnect; an uncertain prompt is restored for inspection and never automatically resent.
- **Persistent records:** Decision and permission decision, timestamps, session reconciliation events, and any unknown-operation acknowledgment. Home derives its items from these records.
- **Result:** The user sees meaningful changes without reading raw transcripts and can distinguish “needs me” from “runtime state unknown.”

### Scenario D — Preserve a no-code conclusion

- **Entry:** A Process explores an architecture choice.
- **Interaction:** An agent claims Design X will stall at high occupancy. User links benchmark output and code revision, checks the result, then records a concise supported finding. The user accepts: “Do not use Design X for crowded scenes; benchmark set B observed p95 stall of 240 ms at 80 agents.” Assumptions and source commit are visible.
- **Maintenance:** A later benchmark contradicts the threshold; the note becomes **Needs review**, not silently rewritten. A new accepted statement supersedes it with the reason.
- **Persistent records:** Source AgentSession/events, evidence references, human acceptance, scope/assumptions, and supersession history.
- **Result:** The Process may complete without code. Future work can reuse the conclusion and inspect its basis.

### Scenario E — Future multi-agent collaboration

- **Entry:** A future Process has separate research and test-design sessions.
- **Interaction:** The user sees two independent session cards with owners, last activity, current permission/operation, and the proposal or evidence each produced. An activity stream groups events under their source session. Conflicting findings are shown side by side; Stratum does not blend them into consensus automatically.
- **Decision:** Human selects further investigation or accepts/rejects a proposal. Coordination or scheduling is not implied by displaying the sessions.
- **Persistent records:** Independent AgentSession identities, source events, operation states, evidence, and Process decisions.
- **Result:** The shared Process provides common intention and review context while sessions retain separate histories. This is future UX only; no coordinator or scheduler is designed here.

## 10. Capability gap analysis

| UX capability | Current implementation | Reuse | Extension or new capability |
| --- | --- | --- | --- |
| Understand Process intent and versions | Accepted definition versions, amendments, history | Definition editor/read view, activity links | Better hierarchy and current-situation projection; avoid adding a new lifecycle. |
| See attention and meaningful changes | Project Process cards and chronological activity; explicit unresolved proposals | Existing attention and activity records | Cross-Project Home query; exact anchors to proposal/permission/evidence; freshness and “last observed” labels. |
| Converse within a Process | One read-only Goose session per Process in a separate panel | Durable sessions, prompts, events, permission actions, reconnect controls | Integrate complete messages into the Process work room; show evidence references inline. Real provider behavior remains unqualified. |
| Promote an exploration | Not implemented; v0.2 requires owning Process | Existing session IDs and Process definition/amendment workflow | Project-owned conversation state, optional Process link, user-confirmed promotion, repository-scope validation; data/API work requires separate design. |
| Review proposals with evidence | Proposal/review records exist; completed message can be recorded as update/proposal with source provenance | Existing proposal form, review endpoint, source event reference | Inline draft from finding, evidence/alternative fields, exact authorization statement, revision comparison. No automatic acceptance. |
| Preserve accepted knowledge | Versioned Process definitions and activity; no explicit knowledge lifecycle | Process updates, accepted proposals, event provenance | Human-accepted scoped note, evidence links, assumptions and review/supersession signal. Start Process-local before Project-wide retrieval. |
| Inspect GitHub and quality evidence | Repository identities and local checkout link; no integrated PR/CI evidence view in this app slice | Repository link and evidence provenance concepts | External provider integration and freshness-aware evidence; keep CI authority external and consume its records. |
| Multiple people/agents | Local single-user actor, one nonterminal AgentSession per Process | Process/session identities and history | Identity/RBAC, concurrency, multiple session presentation and conflict handling; explicitly later. |
| Recovery and reload | Hash navigation, event cursor, durable prompt identities, reconnect controls | Existing implementation | Better user explanation and recovery path. Actual provider-backed restoration still needs qualification. |

## 11. Prioritized roadmap and first vertical slice

### P0 — Coherent core experience

1. **Process Workspace orientation and decision loop.** Reorder existing fields around accepted intention, current situation, work/conversation, evidence, pending decisions, and history. Add source links and freshness to summaries; keep agent claims distinct. Turn completed findings into inline update/proposal drafts with provenance. Use existing Process and AgentSession records; do not add a new state machine.
2. **Project Overview and Home attention path.** Reuse existing activity/attention records to show exact pending action → Process anchor → evidence → decision. Keep Home small and only include cross-Project items the local user's records establish.
3. **Real Goose qualification.** Continue as a separate gated track. The v0.2 preflight report identifies missing provider configuration. Do not expose the current integration as qualified before the real campaign passes its gates.
4. **Conversation-first ownership decision.** Validate the project-owned exploratory conversation recommendation. If approved, design the minimal persistence and permission transition separately before implementation.

### P1 — Deeper continuity and evidence

- Implement project-owned exploration and user-confirmed promotion after ownership approval.
- Add Process-local reusable knowledge candidates, then a small Project knowledge list with provenance, scope, correction, and review triggers.
- Add relevant PR, commit, test, and CI evidence views with source revision and freshness; consume external evidence rather than duplicating CI.
- Improve return-after-absence summary from actual persisted events, with citations and explicit uncertainty.

### P2 — Advanced coordination

- Multiple concurrent AgentSessions per Process and clear independent activity/proposal provenance.
- Multiple human collaborators, ownership, notifications, and access controls.
- Broader integrations or automation only when an observed need justifies them. No scheduler or generic orchestration platform is proposed here.

### Recommended first slice

Deliver the **Process Workspace decision loop** on an existing Process: orient from accepted intent; inspect a record-grounded situation; continue or reconnect the single session; draft a proposal from a completed finding; inspect its provenance; request revision or accept/reject/defer; and return after reload to the same decision and history. This is the smallest complete experience that uses the strongest existing foundation without first changing AgentSession ownership. Gate release of any live Goose affordance on the separate provider-backed qualification.

## 12. Product-owner decisions before implementation

1. Approve the Process Workspace-first priority and the Home/Project/Process hierarchy, or change the priority order.
2. Decide whether exploration may read a selected repository before a Process exists. If yes, approve a Project-owned session with optional Process association; if no, approve context-only exploration or a draft Process model.
3. Confirm whether promotion is one-way (conversation remains linked to one Process) or may associate one exploration with multiple Processes. This spec recommends one Process per promoted conversation initially.
4. Define who may accept reusable knowledge in the current single-user product and what evidence is sufficient to label a finding “supported.”
5. Approve that “accept proposal” accepts only the named Process direction and never implicitly grants execution permission.
6. Confirm the P0 vertical slice and require real Goose qualification before enabling the agent collaboration surface outside a bounded local trial.

## 13. Acceptance criteria for design review

The proposed experience is ready for implementation planning when a reviewer can trace each scenario through the screens and answer:

- What is accepted, what is only claimed, what evidence supports it, and who decided?
- What exact action is requested, and what will that action authorize?
- Where does the conversation belong before and after promotion, and which permissions remain in effect?
- How will the user recover after reload, unavailable runtime, or uncertain prompt outcome without duplicate work?
- Which source record supports every attention, progress, and freshness label?
- Can the user understand the Process without reading the full transcript?

The companion [wireframes](stratum-product-experience-wireframes-v0.3.md) specifies representative screen contents, key interactions, and responsive/unavailable states.
