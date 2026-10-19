# Proposal: Stratum as a collaborative, agent-native development workspace

**Status:** DISCUSSION / proposal only — not an accepted DDR, specification, or implementation authorization  
**Date:** 2026-10-19  
**Target repository:** `Noema-team/stratum`  
**Scope:** Product direction, domain boundaries, external runtime reuse, proof plan  
**Relationship to existing decisions:** This proposal does **not** supersede DDR-031–041, alter current pilots, or authorize a platform-wide rewrite. Any pivot in priority or contract must be approved separately.

---

## 0. Executive summary

**Proposed direction:** Evolve Stratum into a single application in which people and AI agents plan, discuss, implement, review, and track software work. Keep Stratum's deterministic execution/evidence core. Bring interactive agent sessions and multi-machine runtime capabilities into the same user experience, initially by integrating Paseo rather than recreating its runtime. Make OMP Supervisor an optional supervised execution integration *later*, not an initial platform dependency.

**Preferred approach:** **build on Stratum**, rather than restart from scratch, but treat most of its current UI as replaceable. Build the project-management and chat experience together in a narrow end-to-end slice, rather than finishing a PM system before attaching agents.

**Core distinction:**
- A **Task** is project-management intent, potentially owned by a person or agent and not necessarily executable.
- A **WorkItem** is Stratum's existing bounded execution contract for a workflow.
- An **AgentSession** is a durable interactive runtime conversation bound to a host, workspace, and provider session.
- A **WorkflowRun** records Stratum-controlled execution under its existing engine.
- A future **OMP Run** belongs to OMP's independent authority; Stratum links and projects its state instead of recreating that state machine.

**Not decided by this document:** exact schema, deployment platform, full UX, whether to retain Paseo SDK long-term or adopt Hub's outbound relationship, or whether to formalize a separate Task entity. These must be validated.

### Why propose a change?

The experience of combining a PM application with Paseo and OMP revealed a practical mismatch: task organization exists, but interactive coding, persistent chat, runtime orchestration, evidence, and human decisions are spread across different interfaces. The user still does most engineering work *inside Paseo*, without an ordinary path that makes OMP beneficial in day-to-day use.

The target is **one coherent working environment**, not another general-purpose agent framework plus an external task board.

---

## 1. Source baseline and evidence levels

This proposal distinguishes **observed implementation**, **documented external behavior**, and **proposed design**.

Repositories examined:

| Repo | Observed revision | Relevant evidence |
| --- | --- | --- |
| [Stratum](https://github.com/Noema-team/stratum) | `b6dbcd36c18a42ee4d9e9ea4bfa987b5018d0783` (2026-10-02) | [README](https://github.com/Noema-team/stratum/blob/b6dbcd36c18a42ee4d9e9ea4bfa987b5018d0783/README.md), [domain](https://github.com/Noema-team/stratum/tree/b6dbcd36c18a42ee4d9e9ea4bfa987b5018d0783/src/domain), [SQLite schema](https://github.com/Noema-team/stratum/blob/b6dbcd36c18a42ee4d9e9ea4bfa987b5018d0783/src/storage/database.ts), [Scheduler](https://github.com/Noema-team/stratum/blob/b6dbcd36c18a42ee4d9e9ea4bfa987b5018d0783/src/scheduler/scheduler.ts), [ExecutionAdapter](https://github.com/Noema-team/stratum/blob/b6dbcd36c18a42ee4d9e9ea4bfa987b5018d0783/src/execution/types.ts), [API](https://github.com/Noema-team/stratum/blob/b6dbcd36c18a42ee4d9e9ea4bfa987b5018d0783/src/api/control-plane-server.ts) |
| [Paseo](https://github.com/getpaseo/paseo) | `b6dde61a7f56eff276196f6670d9705bd45a9849` (2026-10-19) | [architecture](https://github.com/getpaseo/paseo/blob/b6dde61a7f56eff276196f6670d9705bd45a9849/docs/architecture.md), [agent lifecycle](https://github.com/getpaseo/paseo/blob/b6dde61a7f56eff276196f6670d9705bd45a9849/docs/agent-lifecycle.md), [timeline sync](https://github.com/getpaseo/paseo/blob/b6dde61a7f56eff276196f6670d9705bd45a9849/docs/timeline-sync.md), [permissions](https://github.com/getpaseo/paseo/blob/b6dde61a7f56eff276196f6670d9705bd45a9849/docs/permissions.md), [SDK](https://github.com/getpaseo/paseo/blob/b6dde61a7f56eff276196f6670d9705bd45a9849/public-docs/sdk/agents.md) |
| [Paseo Hub](https://github.com/getpaseo/hub) | `7cbdd52023565eb1dcd940f24f5490e2593d090a` (2026-10-17) | [README](https://github.com/getpaseo/hub/blob/7cbdd52023565eb1dcd940f24f5490e2593d090a/README.md), [AgentSessions](https://github.com/getpaseo/hub/blob/7cbdd52023565eb1dcd940f24f5490e2593d090a/src/agent-sessions/index.ts), [API guide](https://github.com/getpaseo/hub/blob/7cbdd52023565eb1dcd940f24f5490e2593d090a/docs/public-api.md) |

This is a **source review**, not a full runtime penetration test, exhaustive code audit, or proof that Stratum and Paseo can yet be connected safely. Claims below are scoped accordingly.

### Current Stratum: what exists

- SQLite-backed `Workspace`, `Project`, `Repository`, `Objective`, `WorkItem`, `Decision`, `Evidence`, `Artifact`, and `Event` domains, with migrations.
- WorkItem dependency tracking and states, a Scheduler with concurrency decisions and repository leases, an `ExecutionAdapter` interface, and generic workflows via `WorkflowEngine`.
- Durable workflow checkpoints/decisions; typed evidence collection and GitHub CI/review adapter *interfaces*.
- A REST control-plane and a basic dashboard, not a full team collaboration application.
- Token-based API authentication; request identity represents a **token**, not an organization member with project/resource grants.
- Existing legacy project-scoped chat, distinct from a complete, multi-host provider-session management plane.

Evidence: [Stratum README](https://github.com/Noema-team/stratum/blob/b6dbcd36c18a42ee4d9e9ea4bfa987b5018d0783/README.md), [work routes](https://github.com/Noema-team/stratum/blob/b6dbcd36c18a42ee4d9e9ea4bfa987b5018d0783/src/api/handlers/work.ts), [auth context](https://github.com/Noema-team/stratum/blob/b6dbcd36c18a42ee4d9e9ea4bfa987b5018d0783/src/auth/types.ts), [GitHub adapter](https://github.com/Noema-team/stratum/blob/b6dbcd36c18a42ee4d9e9ea4bfa987b5018d0783/src/evidence/github/adapter.ts).

**Important scope warning:** A GitHub evidence adapter *contract* is not proof that all desired GitHub App/PR management and authorization UX already exists. Similarly, existing chat persistence is not Paseo-style persistent agent sessions.

### Current Paseo: what exists

- Host-local daemon managing providers, native provider-session handles, agent records and lifecycles, workspaces/worktrees, and streamed timelines.
- Agent states that distinguish `initializing`, `running`, `idle`, `error`, and persisted `closed`, with archive separate.
- Resume and agent-to-agent/subagent relationships, including parentage and detachment.
- Live WebSocket streams paired with authoritative paginated timeline fetch, cursor/epoch and gap recovery.
- Published `@getpaseo/client` interface; sessions remain active when an SDK client disconnects.
- Multiple daemon connections in its app; optional encrypted relay; permissions at the daemon boundary.

Paseo's durable agent record is **not the same thing as an immutable chat transcript**. Its canonical timeline projection is reconstructed from provider history where applicable. Preserve independent Stratum evidence for decisions and verification requiring durable audit.

### Current Paseo Hub: what exists

- A separate, opt-in central service with outbound daemon relationships, organizational users, invitations, and external triggers.
- Hub-side agent-session/execution mapping to daemon, agent and workspace; idempotent creation/message delivery and session continuation behavior.
- A self-hostable product, but its own README calls it early development with possible breaking changes/data loss.
- Public API is narrower than all of Hub's internal UI/runtime behavior; validate capabilities before choosing it as Stratum's runtime transport.

**Critical security fact:** Paseo documents permissions as daemon-wide today; scoped workspace grants are a future direction, not an established enforcement boundary. Giving Stratum one broadly privileged Paseo/Hub credential does not itself enforce Stratum's future per-project roles.

---

## 2. Product vision and intended daily experience

Stratum should unify:

1. **Project management:** organizations, members, role grants, projects, repository ownership, tasks/backlogs, assignments, dependencies, priorities, planning, milestones, and human collaboration.
2. **Agent workspace:** durable conversations, prompt/turn history, provider choice, agent spawning, subagents, local worktrees, terminals, diffs, permissions, interruptions, and attention.
3. **Engineering evidence/control:** WorkItems, workflows, run lifecycles, verification, decisions, reviews, pull requests, qualified outcomes, and failure reports.

The **normal path** should be:

```text
Open project
   ├── discuss in an unstructured agent conversation
   │       └── optionally create/link a Task
   └── open an existing Task
           ├── human discussion
           ├── attach/start AgentSession on selected host/workspace
           ├── inspect code/diff/PR/CI
           └── optionally authorize a bounded WorkItem
                     └── Stratum workflow (or later OMP run)
```

A chat should not require a task. A task should not require a workflow. A workflow's outcome should not be inferred from a chat message.

**Product criterion:** For normal engineering work, users should not have to switch between a task board, Paseo chat, and another orchestration console merely to manage one work item.

### UX surfaces to explore (not a frozen UI spec)

- **Project view:** backlog/board/list, linked repos, milestones, collaborators, agent activity.
- **Task view:** intent/acceptance criteria, assignees, linked sessions, PRs, runs, evidence, discussion, actions.
- **Agent view:** conversation timeline, tool events, pending permissions, workspace/branch, agent children, host health.
- **Attention view:** the set of human decisions needing review, deduplicated and backed by authoritative run/task evidence.
- **Engineering view:** diff/PR/CI, proof artifacts, verification provenance and any available supervised-execution actions.
- **Admin:** organization membership, grants, host enrollment, secrets, audit history, revocation.

The same Task and AgentSession should be reachable from different views without creating competing records.

---

## 3. Proposed domain model and ownership

```text
Organization
  ├── Users / Memberships / Roles and grants
  └── Project
        ├── Repositories / GitHub mappings
        ├── Objectives / Milestones
        ├── Tasks
        │     ├── Assignees / Dependencies / Comments
        │     ├── AgentSession links (0..N)
        │     ├── WorkItem links (0..N)
        │     └── PR / Evidence references
        └── WorkItems (existing Stratum authority)
              └── WorkflowRuns / StepExecutions / Decisions / Evidence

Host (runtime identity; may be linked to multiple projects)
  └── RuntimeWorkspace (host-local checkout/cwd)
        └── AgentSession (host+workspace+provider-native handle)
              ├── Turns / timeline
              └── Child sessions

Future external execution:
  WorkItem or accepted handoff ──> OMP WorkRequest ──> OMP Run
                                  (OMP authority)
```

### Task versus existing WorkItem — recommendation, not settled

**Recommendation:** introduce a separate lightweight **Task** domain rather than teaching the current `WorkItem` to represent every human planning item.

Current `WorkItem` includes `workflowId`, required evidence, acceptance criteria, repository IDs, workflow-specific parameters, and states whose `ready` transition feeds the Scheduler. Making a normal PM task `ready` must not accidentally authorize a build.

The alternative is to evolve WorkItem with an explicit `task_only | executable` discriminator and stricter dispatch rules. This may reduce duplication but expands an already-tested execution contract. Treat that as a **decision to test before migration**, not an assumed foregone conclusion.

| Object | Primary truth | Typical lifecycle |
| --- | --- | --- |
| Task (proposed) | Team intent, ownership, status | backlog / planned / in progress / done; configurable policy |
| WorkItem (current) | Bounded Stratum execution contract | draft / ready / running / in_review / completed; existing side states |
| AgentSession (Paseo runtime) | Durable conversation identity | initializing / idle / running / error / closed; archived separately |
| WorkflowRun (Stratum) | Deterministic workflow execution | Existing engine and durable cursor/decision ownership |
| PR / CI (GitHub) | Repository review and check truth | GitHub owns these records |
| OMP Run (future) | Supervised engineering authority | OMP owns states, qualification and available actions |

**No automatic equivalences:** `AgentSession idle` does not mean `Task done`; `PR merged` does not by itself mean `WorkItem completed`; `Task done` must not silently accept an OMP WorkRequest.

### Cross-system bindings

The Stratum database may store a typed, minimal runtime locator, for example:

```ts
type RuntimeAgentRef = {
  provider: "paseo";
  hostId: string;             // stable Stratum host ID
  daemonAgentId: string;      // Paseo-owned
  daemonWorkspaceId: string;  // Paseo-owned
};

type AgentSessionLink = {
  projectId: string;
  taskId?: string;
  agentRef: RuntimeAgentRef;
  visibility: "interactive" | "background";
};

type ExecutionBinding = {
  workItemId: string;
  runtime: "stratum" | "omp";
  externalRunId?: string;
};
```

These are **illustrative**, not migration-ready schema definitions. Exact ID uniqueness, cardinality, membership, revocation, and multi-project references require design.

Do not use a raw local `cwd` as a global project/session identity; two hosts can have identical paths referring to different checkouts. Resolve project/repo equivalents via explicit mapping and Git identity, preserving host-local identifiers.

---

## 4. Authority and security boundaries

### Stratum owns

- Human identities, organization and project membership, role/grant policy, planning and Task states.
- Task-to-agent/work-item relationships, request provenance and authorization for initiating work.
- Existing Stratum WorkItem, Scheduler, WorkflowRun, Decision, Evidence lifecycle.
- UI projection and audit of actions invoked on connected runtimes.

### Paseo daemon owns

- Provider processes and sessions, native resume handles, workspace files/worktrees and terminals.
- Actual agent interrupt/stop/archive semantics and provider permissions.
- Its own canonical agent timeline projection, timeline subscriptions, transport state.
- Whether a requested runtime operation was accepted/executed.

### GitHub owns

- Repository identity, branches/commits, PRs, reviews, check runs and merge state.
- Stratum stores typed references and snapshots/receipts, never replaces GitHub's authority.

### OMP (future optional adapter) owns

- WorkRequest binding and run lifecycle, exact candidate/SHA qualification and lawful actions.
- Stratum may initiate *explicit* accepted handoffs, display OMP's projection, and invoke only OMP-declared actions subject to fresh authorization.
- Stratum must not import OMP's internal state predicates or auto-accept an OMP run because its own Task transitioned.

### Threat model: multi-user versus host-local permissions

The core security problem is **not only authenticating the web UI**. A server authorized to control a Paseo daemon may have broad power over the daemon's repositories, terminals, files and agents. Paseo's [documented permission model](https://github.com/getpaseo/paseo/blob/b6dde61a7f56eff276196f6670d9705bd45a9849/docs/permissions.md) is primarily daemon-wide today.

Required policy:

- Enforce Stratum organization/project grants on **all** reads, live subscriptions, create/send/interrupt/archive operations and files/diffs, not just on rendered buttons.
- Never hand a user's browser a broadly privileged daemon token as a shortcut.
- Avoid exposing host-local daemon ports or Stratum's old optional-auth API to the public network.
- Give each host connector the minimum practical capability; separate hosts/OS users/security domains where same-daemon isolation is not defensible.
- Human and machine/service identities must be distinct; service credentials should be individually revocable.
- Validate user-initiated actions against fresh state; audit actor, resource, intent, target, result and correlation IDs.
- Repository instructions, agent messages and tool output are untrusted content, not authorization.
- Sensitive credentials should remain with the trusted runtime or a mediated secret boundary, never be added to arbitrary agent prompts or events.

This security boundary must precede access by multiple unrelated collaborators. A limited **single-user prototype on one trusted host** may precede full RBAC, but it must not be described as securely multi-tenant.

---

## 5. Paseo's agent/session concepts worth reusing

### Durable identity distinct from runtime process

Paseo persists an Agent record with provider, configuration, workspace/cwd, persistence handle, runtime status, parentage and timestamps. A `closed` session is not necessarily archived or deleted; it may be resumed later. Do not equate a live process with the durable conversation.

### Native provider handles

Claude, Codex, ACP and other providers have their own session IDs and resume semantics. **Do not invent a universal message replay protocol** as a substitute. Stratum should store Paseo identifiers and use provider-specific behavior through Paseo's stable SDK/daemon contract.

### Hierarchical agents

Parent-child relationships and detach/archive behavior belong to runtime lifecycle. These do not automatically imply parent/child PM Tasks. Expose them, but keep task decomposition separate.

### Two paths for the timeline

```text
live WS stream: low latency, possibly delta shaped
authoritative fetch: pages, cursor, epoch, gap recovery
```

The client should retain a current accepted timeline and catch up after reconnect; it must not mistake socket connectivity for complete history. A backend integration should avoid both inventing transcript facts and replaying provider messages twice. Stratum-controlled approvals and evidence require their own durable records.

### Idempotent agent launch and prompt delivery

Hub/daemon contracts distinguish request IDs (one RPC attempt) from durable idempotency keys (one intent) and message IDs (one submission). A lost acknowledgment must not launch a second agent on retry. Outcome-unknown states must be explicit when execution could have occurred but the receipt was lost.

### Permissions and subagent containment

A parent spawning child sessions is useful, but delegation can multiply runtime cost and filesystem reach. The new platform needs explicit launch permissions, host/project boundaries, resource budgets and user attention on permission requests. Do not equate arbitrary agent-spawn capability with authorized Task creation.

Relevant source: [Paseo lifecycle](https://github.com/getpaseo/paseo/blob/b6dde61a7f56eff276196f6670d9705bd45a9849/docs/agent-lifecycle.md), [timeline sync](https://github.com/getpaseo/paseo/blob/b6dde61a7f56eff276196f6670d9705bd45a9849/docs/timeline-sync.md), [agent storage](https://github.com/getpaseo/paseo/blob/b6dde61a7f56eff276196f6670d9705bd45a9849/packages/server/src/server/agent/agent-storage.ts).

---

## 6. Multi-machine architecture: connector first, distributed framework later

Proposed logical topology:

```text
Browser / mobile UI
       |
Stratum API + project/task/auth DB
       |
Host registry / AgentRuntimeConnector
       |
  +----+----------------------+
  |                           |
Paseo daemon A             Paseo daemon B
(laptop)                   (GPU/build server)
  |                           |
provider sessions           provider sessions
worktrees                   worktrees
```

**First iteration:** connect one reachable, trusted Paseo daemon using the published `@getpaseo/client` interface. Stratum stores the link and renders real agent state; all runtime operations go through one server-side adapter.

**Later:** more hosts with durable host identity, status, credential rotation, reconnect reconciliation, placement policy and offline behavior.

### Direct SDK vs Hub vs custom bridge

| Choice | Benefit | Risk/uncertainty | Current recommendation |
| --- | --- | --- | --- |
| Paseo SDK / direct daemon connection | Fastest supported session and agent API; minimal code | Needs reachable host and server-side credential boundary | **Start here** |
| Paseo Hub as separate runtime service | Outbound daemon connection, session mapping, organizations, idempotent execution/continuation | Early-stage, different product control plane, full interactive access may not be covered by public API | **Spike before committing** |
| Stratum-hosted outbound bridge | Precise UX/control and tenancy fit | Must build auth, transport, reconnect, command receipts, recovery | Only after measured limitation |

Paseo Hub's daemon relationship is opt-in and outbound. It currently supports **one Hub relationship per daemon** and has `hub.execute` authority that is not inherently per-Stratum-project scoped. Do not simply assume Hub solves multi-tenant authorization.

**No duplicate schedulers by accident:** Paseo can run concurrent agents; Stratum already has a Scheduler. The initial interactive session path should use Paseo without pretending to be a Stratum WorkflowRun. A separate adapter can later use Stratum's Scheduler to authorize/coordinate structured WorkItems across hosts.

### Offline/recovery rules to prove

- Known host disconnected: show **offline/stale**, not `idle` or success.
- Browser disconnect: agent continues on daemon; reconnect rehydrates existing session and missing timeline.
- RPC timeout during creation/send: query by stable intent/receipt; never blindly create a new session.
- Provider process exits mid-turn: report error/uncertain outcome; no fabricated successful completion.
- Host replacement: preserve old host IDs as history, avoid rehoming sessions based on path/name.
- Multiple watchers: one shared authoritative status, no browser-specific mutation of agent lifecycle.

---

## 7. GitHub and collaboration integration

Plan GitHub as a **source-linked domain**, not an execution substitute.

Desired later user-facing facts:
- Link repositories to Projects through explicit GitHub installation/authorization.
- Connect Task ↔ branch/commit/PR/check run/review by typed identity and head SHA.
- Render diffs and review state in agent/task context.
- Observe PR/CI changes with webhook delivery receipts and idempotent reconciliation.
- Post progress and reference links only through authorized actions.
- Evidence collector retains actual candidate SHA and source, and refuses stale/mismatched evidence where required.
- **Merges remain explicit human/policy actions**, never implied by task completion.

Stratum's [GitHub evidence adapter](https://github.com/Noema-team/stratum/blob/b6dbcd36c18a42ee4d9e9ea4bfa987b5018d0783/src/evidence/github/adapter.ts) gives a typed starting point for CI/review collection, **not** a finished project-wide GitHub integration.

Avoid moving ci-toolkit logic or GitHub's merge authority into Stratum. See existing DDR-035.

---

## 8. Relationship to existing Stratum architecture and DDR-035

This is a product-surface proposal, not a replacement of the execution kernel.

Preserve:

- `WorkService`/Scheduler ownership of WorkItem transitions and leases.
- `ExecutionAdapter`, workflow definitions and typed step/results.
- Durable Decisions and evidence-backed completion.
- The rule that models propose; Stratum services validate and materialize authoritative state.
- External CI evidence and GitHub merge ownership.
- Frozen/immutable revision handling and bounded pilots.

**DDR-035** says Era II should prioritize evidence-driven pilots, not speculative Era III infrastructure. The proposed collaborative UI/runtime path overlaps the document's historical Era III aspirations. The conflict is real: **a deliberate product-priority decision is needed before diverting execution-roadmap effort**.

This PR does not declare that conflict resolved. A narrow interaction proof can be authorized separately, with explicit scope and success criteria, while the existing supervised experiment sequence remains intact.

Do not rewrite `WorkItem` states, modify active pilots or refactor the Scheduler as part of this documentation PR.

---

## 9. Alternatives and recommendation

| Alternative | Strength | Weakness | Assessment |
| --- | --- | --- | --- |
| New monorepo from scratch | Freedom of design | Discards Stratum's verified domain/workflow/evidence investment | Not preferred |
| Fork Paseo as the whole product | Mature agent UX/runtime | Large provider/client maintenance burden; PM domain still missing | Avoid initially |
| Fork Paseo Hub as Stratum | Already has orgs, outbound daemons, execution plumbing | Early-stage; its workflow/triggers are not Stratum's WorkItem/Decision model | Worth an isolated comparison |
| Finish full PM first, bolt on agents | Familiar incremental feature order | Repeats the fragmentation problem | Avoid |
| Build on Stratum + new UI + Paseo runtime connector | Reuses Stratum authority/evidence and existing agent runtime | Requires careful task/session boundaries and team auth | **Preferred working hypothesis** |

Do not pre-commit to a wholesale microservice split or a new distributed-worker platform. Start with modules and explicit adapter interfaces; extract services only when concrete deployment/security/evidence constraints require it.

---

## 10. Evidence-driven path to a product slice

### Phase 0 — accept/adjust the domain boundary (design only)

Decide how `Task`, `WorkItem`, `AgentSession`, and `WorkflowRun` relate. Preserve current persistence and workflow invariants. Record a short decision before migrating schema.

### Phase 1 — one trusted host, session-first vertical slice

On one existing Stratum deployment and one Paseo daemon:

1. Open a Project and create or inspect a planning Task.
2. Select a host/workspace; launch or attach an agent through the **server-side** Paseo SDK adapter.
3. Show initial and follow-up prompts, full tool/event timeline, permission request, running/idle/error.
4. Reopen browser and recover exactly the existing agent; prove no duplicate launch/message.
5. Link and unlink this session from a Task without changing provider-native session identity.

**Gate:** demonstrably useful in an actual development session; correct reconnect and independent Task/AgentSession identity. This is the first implementation slice, not a requirement to finish all PM screens.

### Phase 2 — team-access and host authority prototype

Add actual human identities/memberships and enforce resource permission checks for task, session, timeline and control operations. Test two users with different project access, including direct RPC and WebSocket subscriptions. Do not provide shared remote team access until isolation has been proven.

### Phase 3 — GitHub/PR end-to-end slice

Connect a real repo, show branch/diff/PR/check facts, and finish one Task through an authorized code review/merge handoff. Prove that a stale PR head invalidates projected quality evidence.

### Phase 4 — multi-host proof

Two daemons with different worktrees, stable identity and reconnect. Compare direct SDK reachability against Hub/outbound bridge with a small measured spike. Record which capabilities are missing before designing custom transport.

### Phase 5 — Stratum structured execution from the same UX

Take an authorized Task and construct a bounded WorkItem under existing Stratum workflow rules. Keep interactive session state separate from workflow execution. Reuse decisions/evidence instead of inventing new completion rules.

### Phase 6 — optional OMP backend

Test an explicit `Stratum Task/WorkItem → OMP WorkRequest` handoff. Show projected action legality, run evidence, and a human acceptance path. Do not make OMP a required dependency for normal interactive sessions.

### Minimum end-to-end acceptance scenario

```text
Project → Task → select host → create agent → discuss → modify worktree
  → review diff → link PR/CI → explicit human completion
```

Must pass: authoritative session restoration, permissions, truthful offline states, no duplicate dispatch, and no task/completion inference from model prose.

---

## 11. Open discussion decisions (do not implement by assumption)

1. **Domain:** Separate `Task` from `WorkItem`, or add an explicit non-executable planning mode to WorkItem?
2. **UX entry point:** Task-first versus conversation-first default; both must ultimately work.
3. **Membership model:** Organization/project roles and permissions; how to scope observation and host control safely.
4. **Host model:** Are connected machines user-owned, team-owned, or both? What is the trust boundary?
5. **Runtime integration:** Paseo SDK first with future Hub option, or an early Hub compatibility spike to avoid transport rework?
6. **Conversation persistence:** How much transcript metadata can Stratum cache, versus treating Paseo provider history as source truth?
7. **Delegation:** Which actor may launch subagents, allocate worktrees, issue tasks or request additional permissions?
8. **GitHub identity:** Installation ownership, repo mapping, PR head binding, and human merge permission.
9. **Work orchestration:** How does an interactive session become a bounded workflow without silently manufacturing authority?
10. **DDR-035 priority:** What explicitly changes in the existing experiment roadmap, and what remains frozen?
11. **Packaging:** Single Node process, modular service, or later separated web/worker services? Defer until trust and deployment constraints are known.
12. **OMP:** When does OMP provide measured value, and which project workflows actually need its stronger supervision?

### Proposed first decision

**Agree or reject the four-object boundary** (`Task`, `WorkItem`, `AgentSession`, `WorkflowRun`), and define which owner has authority over each. This is the architectural hinge: it affects schema, APIs, UX and every later adapter.

---

## 12. Explicit non-goals and stop conditions

**Not in the initial implementation:**
- A new generic LLM/agent runtime replacing Paseo.
- A fork of Paseo's entire Expo/Electron/daemon stack.
- A generic distributed scheduler, Kubernetes-like WorkerNode fabric or arbitrary computer-use platform.
- Full replacement of Stratum's existing WorkflowEngine or accepted DDR contracts.
- Autonomous merge, deployment, or acceptance triggered by chat text.
- Declaring multi-user security complete merely because a login UI exists.
- Importing all of Paseo Hub's workflow model into Stratum.
- Delivering every PM feature before the first working agent session.

**Stop and revisit the proposed direction if:**
- Paseo's SDK cannot provide essential session controls without major invasive changes.
- Host/daemon permissions cannot enforce the intended collaboration boundary.
- Resume/timeline semantics are not reliable enough for multi-user supervision.
- Connecting the two control models creates unresolvable competing authority.
- The first vertical slice does not improve real daily engineering flow compared with using Paseo directly.

---

## 13. Suggested review outcome

This document is intentionally **DISCUSSION**. Reviewing/merging the Markdown file does not by itself authorize implementation or supersede an accepted DDR.

The review should result in:
1. Agreement or corrections to the product vision.
2. A decision on the four-object boundary.
3. A trusted-host, one-agent-session prototype scope and measurable acceptance criteria.
4. An explicit decision about DDR-035 roadmap impact.
5. Only then, one or more narrow DDRs/specs and implementation PRs.

**Guiding principle:** Stratum owns project meaning, identity, authorization, planning and its existing deterministic execution/evidence boundaries. Paseo initially owns interactive provider execution and agent-session mechanics. GitHub owns repo/PR truth. OMP can later plug in as a separate stronger supervised-execution authority.
