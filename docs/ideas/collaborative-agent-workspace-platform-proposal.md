# Proposal: Stratum as a collaborative, agent-native development workspace

**Status:** DISCUSSION / proposal only — not an accepted DDR, specification, or implementation authorization  
**Date:** 2026-10-19  
**Target repository:** `Noema-team/stratum`  
**Scope:** Product direction, domain boundaries, external runtime reuse, proof plan  
**Relationship to existing decisions:** This proposal does **not** supersede DDR-031–041, alter current pilots, or authorize a platform-wide rewrite. Any pivot in priority or contract must be approved separately.

> **REVISION 2 (2026-10-19) — Engine boundary and host-runtime pivot.** This revision supersedes the earlier recommendation to integrate Paseo as Stratum's agent runtime. Stratum is now proposed as a standalone agent-native platform that **owns its host runtime** (workspaces, session lifecycle, tool policy, streaming, sandboxing) and an **engine-neutral runtime interface** of its own design. The **agent engine becomes a replaceable component** behind that interface: the Agent Client Protocol (ACP) is the **preferred initial mechanism for Goose**, while Pi can initially bind through its native TypeScript SDK. ACP is an integration mechanism, not a claim that every engine must speak it. Paseo is demoted to an **architectural reference** — its proven designs (durable session identity, timeline recovery, idempotent dispatch) inform the host runtime without becoming a dependency. Unchanged by this revision: the Task / WorkItem / AgentSession / WorkflowRun domain separation and the engineering-kernel boundary (§4's authority lists change owner names accordingly: Paseo daemon → Stratum host runtime + engine). Rewritten: §5, §6; amended: §0–§4, §8–§13. Evidence spikes for Goose and Pi are specified in §6.6 and must precede any engine commitment; the spike harnesses are preserved under `docs/research/engine-spikes/`. **This document remains DISCUSSION only: nothing here authorizes implementation, and the product pivot is neither ratified nor executed by this revision** — existing DDR-031–041 are untouched, and any priority change requires its own future DDR (see §8).

---

## 0. Executive summary

**Proposed direction:** Evolve Stratum into a single application in which people and AI agents plan, discuss, implement, review, and track software work. Keep Stratum's deterministic execution/evidence core. Build Stratum's own **host runtime** for interactive agent sessions — workspaces, durable session identity, tool/permission brokering, sandboxing and streaming — and drive replaceable **agent engines** through a **Stratum-owned, engine-neutral runtime interface**: ACP for Goose initially, Pi's native SDK initially for Pi. Paseo serves as an architectural reference for this runtime, not as a dependency. Make OMP Supervisor an optional supervised execution integration *later*, not an initial platform dependency.

**Preferred approach:** **build on Stratum**, rather than restart from scratch, but treat most of its current UI as replaceable. Build the project-management and chat experience together in a narrow end-to-end slice, rather than finishing a PM system before attaching agents.

**Core distinction:**
- A **Task** is project-management intent, potentially owned by a person or agent and not necessarily executable.
- A **WorkItem** is Stratum's existing bounded execution contract for a workflow.
- An **AgentSession** is a durable interactive runtime conversation bound to a host, a workspace, and an engine-side session handle — owned by the Stratum host runtime, not by any engine's product.
- A **WorkflowRun** records Stratum-controlled execution under its existing engine.
- A future **OMP Run** belongs to OMP's independent authority; Stratum links and projects its state instead of recreating that state machine.

**Two separate decisions (Revision 2):**
1. **What Stratum owns:** project management, users/collaboration, agent-session identity, workspaces, sandboxes, tool policy, multi-machine management and orchestration — plus a **Stratum-owned, engine-neutral runtime interface** that engines bind to.
2. **What executes the reasoning loop:** a replaceable agent engine — Goose, Pi, or a future engine. ACP is the preferred initial binding for Goose; Pi can initially bind through its native SDK. The interface contract is Stratum's; the wire mechanism per engine is an implementation choice.

Stratum is therefore neither a Paseo clone nor a Goose frontend. Particular implementations may be borrowed from either without inheriting their product design.

**Not decided by this document:** exact schema, deployment platform, full UX, whether the engine boundary should eventually move from ACP to direct engine-library embedding (e.g., Goose GDK crates or Pi SDK in-process), and whether these logical domains should ever become separate deployed services. These must be validated — see §6.6.

### Why propose a change?

The experience of combining a PM application with Paseo and OMP revealed a practical mismatch: task organization exists, but interactive coding, persistent chat, runtime orchestration, evidence, and human decisions are spread across different interfaces. The user still does most engineering work *inside Paseo*, without an ordinary path that makes OMP beneficial in day-to-day use.

The target is **one coherent working environment**, not another general-purpose agent framework plus an external task board.

---

### Discussion outcome (2026-10-19): separate domains and four identities

**Confirmed direction for this proposal:** `Task`, `WorkItem`, `AgentSession`, and `WorkflowRun` should remain **distinct first-class concepts**. Project management/collaboration logic should be separated from the existing Stratum **engineering execution kernel**.

This is an **agreed product/architecture direction within the draft discussion**, not an accepted DDR or permission to migrate existing code. Exact persistence schemas, APIs, roles, package layout and deployment remain open.

The separation has three parts:

1. **Collaboration/application domain (new):** organizations, human/service identities, membership and grants, projects/repo mapping, ordinary Tasks, planning, discussion, task assignment, UI, and explicit initiation of execution. A Task may never be executable. Its `ready` state must never automatically trigger the kernel.
2. **Stratum engineering kernel (existing):** bounded WorkItems, Scheduler, workflow definitions, WorkflowRuns, execution adapters, Decisions, evidence, verification and deterministic lifecycle. The kernel is **headless and independently invocable**. It is a supervised workflow/execution core—not itself a language model or code generator. An external builder/provider actually generates code through an adapter.
3. **Interactive agent runtime — Stratum Host Runtime (new; Revision 2):** host-local workspaces, durable agent-session identity, chat turns, timelines, engine process lifecycle, tool/permission brokering and sandboxing. Engines (Goose initially) execute the reasoning loop behind ACP. The application owns session records and policy; the engine owns its own reasoning and tool loop for the duration of a turn.

```text
                  Stratum application / collaboration
       Project ── Task ── discussion / planning / assignments
                          │                        │
              explicit execution handoff       attach chat
                          │                        │
                          ▼                        ▼
                 Stratum engineering        Stratum host runtime
                      kernel                AgentSession / workspace
                  WorkItem / Run            tool policy / sandbox
                  decision / evidence       streaming / recovery
                          │                        │
                  ExecutionAdapter          engine bindings
                          │                  (ACP · native SDK)
                  builder / tests           Goose (first) · Pi · …
                  reviewer                       engines

          Optional later: OMP is a separate execution authority.
```

**Boundary rule:** Collaboration can propose and authorize a bounded execution request; the kernel then owns the execution state. The kernel returns status, evidence and authoritative allowed actions; the application projects them and does not reimplement the state machine. A chat turn, idle agent or PR state cannot implicitly complete a WorkItem. Interactive sessions can exist without Tasks or WorkItems.

**Deployment rule:** Logical separation does **not** require microservices, network RPC, multiple databases or splitting this repository now. Prefer named domain modules and narrow typed interfaces in the existing TypeScript codebase. Extract services only if a demonstrated deployment, isolation, scale or independent-lifecycle need justifies it. In particular, do not remove the existing Stratum `Project`/`Objective`/`Workspace` contracts from the kernel without a separate compatibility and ownership design.

**Initial vertical slice:** One Stratum Task links to one AgentSession owned by the Stratum host runtime (Goose engine behind ACP) and optionally creates one bounded Stratum WorkItem via an explicit handoff. Prove that all three lifecycles and their permissions remain independent, and that browser reconnect and kernel restart do not duplicate or infer completion.

---

## 1. Source baseline and evidence levels

This proposal distinguishes **observed implementation**, **documented external behavior**, and **proposed design**.

Repositories examined:

| Repo | Observed revision | Relevant evidence |
| --- | --- | --- |
| [Stratum](https://github.com/Noema-team/stratum) | `b6dbcd36c18a42ee4d9e9ea4bfa987b5018d0783` (2026-10-02) | [README](https://github.com/Noema-team/stratum/blob/b6dbcd36c18a42ee4d9e9ea4bfa987b5018d0783/README.md), [domain](https://github.com/Noema-team/stratum/tree/b6dbcd36c18a42ee4d9e9ea4bfa987b5018d0783/src/domain), [SQLite schema](https://github.com/Noema-team/stratum/blob/b6dbcd36c18a42ee4d9e9ea4bfa987b5018d0783/src/storage/database.ts), [Scheduler](https://github.com/Noema-team/stratum/blob/b6dbcd36c18a42ee4d9e9ea4bfa987b5018d0783/src/scheduler/scheduler.ts), [ExecutionAdapter](https://github.com/Noema-team/stratum/blob/b6dbcd36c18a42ee4d9e9ea4bfa987b5018d0783/src/execution/types.ts), [API](https://github.com/Noema-team/stratum/blob/b6dbcd36c18a42ee4d9e9ea4bfa987b5018d0783/src/api/control-plane-server.ts) |
| [Paseo](https://github.com/getpaseo/paseo) | `b6dde61a7f56eff276196f6670d9705bd45a9849` (2026-10-19) | [architecture](https://github.com/getpaseo/paseo/blob/b6dde61a7f56eff276196f6670d9705bd45a9849/docs/architecture.md), [agent lifecycle](https://github.com/getpaseo/paseo/blob/b6dde61a7f56eff276196f6670d9705bd45a9849/docs/agent-lifecycle.md), [timeline sync](https://github.com/getpaseo/paseo/blob/b6dde61a7f56eff276196f6670d9705bd45a9849/docs/timeline-sync.md), [permissions](https://github.com/getpaseo/paseo/blob/b6dde61a7f56eff276196f6670d9705bd45a9849/docs/permissions.md), [SDK](https://github.com/getpaseo/paseo/blob/b6dde61a7f56eff276196f6670d9705bd45a9849/public-docs/sdk/agents.md) |
| [Paseo Hub](https://github.com/getpaseo/hub) | `7cbdd52023565eb1dcd940f24f5490e2593d090a` (2026-10-17) | [README](https://github.com/getpaseo/hub/blob/7cbdd52023565eb1dcd940f24f5490e2593d090a/README.md), [AgentSessions](https://github.com/getpaseo/hub/blob/7cbdd52023565eb1dcd940f24f5490e2593d090a/src/agent-sessions/index.ts), [API guide](https://github.com/getpaseo/hub/blob/7cbdd52023565eb1dcd940f24f5490e2593d090a/docs/public-api.md) |
| [Goose](https://github.com/aaif-goose/goose) | `main` as of 2026-10-19; `goose-agent` crate `0.1.0-alpha.12` (crates.io, 2026-10-13) | Apache-2.0; [architecture](https://github.com/aaif-goose/goose/blob/main/documentation/docs/goose-architecture/goose-architecture.md); [goose-agent README](https://github.com/aaif-goose/goose/blob/main/crates/goose-agent/README.md) (operation-driven state machine, persisted-conversation re-derivation, session loader/persistence traits, cancellation, wasm32/JS-host build); [roaming guide](https://github.com/aaif-goose/goose/blob/main/documentation/docs/guides/roaming-agents.md) (Iroh/QUIC ACP transport, all-or-nothing peer trust); Linux Foundation / AAIF governance |
| [Pi](https://github.com/earendil-works/pi) | `main` as of 2026-10-19 | MIT; [SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md) (in-process `createAgentSession`, persistent `SessionManager`, subscribe/steer/abort); [containerization note](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/containerization.md) — no built-in permission system; sandboxing is the host's job |

This is a **source review**, not a full runtime penetration test, exhaustive code audit, or proof that any of these integrations can yet be connected safely. Claims below are scoped accordingly.

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

### Task versus existing WorkItem — agreed conceptual separation

**Agreed direction:** introduce a separate lightweight **Task** domain rather than teaching the current `WorkItem` to represent every human planning item.

Current `WorkItem` includes `workflowId`, required evidence, acceptance criteria, repository IDs, workflow-specific parameters, and states whose `ready` transition feeds the Scheduler. Making a normal PM task `ready` must not accidentally authorize a build.

The alternative—evolving WorkItem with a `task_only | executable` discriminator—was considered but is **not the current design direction**. It would expand a tested execution contract merely to support ordinary collaboration. Retain it only as historical context; exact Task schema and migration remain subject to a separate design/review.

| Object | Primary truth | Typical lifecycle |
| --- | --- | --- |
| Task (proposed) | Team intent, ownership, status | backlog / planned / in progress / done; configurable policy |
| WorkItem (current) | Bounded Stratum execution contract | draft / ready / running / in_review / completed; existing side states |
| AgentSession (host runtime) | Durable conversation identity | initializing / idle / running / error / closed; archived separately |
| WorkflowRun (Stratum) | Deterministic workflow execution | Existing engine and durable cursor/decision ownership |
| PR / CI (GitHub) | Repository review and check truth | GitHub owns these records |
| OMP Run (future) | Supervised engineering authority | OMP owns states, qualification and available actions |

**No automatic equivalences:** `AgentSession idle` does not mean `Task done`; `PR merged` does not by itself mean `WorkItem completed`; `Task done` must not silently accept an OMP WorkRequest.

### Cross-system bindings

The Stratum database may store a typed, minimal runtime locator, for example:

```ts
type RuntimeAgentRef = {
  engine: "goose" | "pi";     // engine behind the ACP boundary
  hostId: string;             // stable Stratum host ID
  engineSessionId: string;    // engine-owned session handle (e.g. ACP session id)
  hostWorkspaceId: string;    // host-runtime-owned workspace record
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

### Stratum host runtime owns *(scope adjusted in Revision 2)*

- Engine processes launched under its supervision, engine session handles, workspace files/worktrees and terminals.
- The durable AgentSession record, the append-only session event log, and Stratum's canonical timeline projection.
- Tool/permission policy: what an engine may do, surfaced through the tool broker and sandbox — never delegated to an engine's own permission modes as the point of truth.
- Whether a requested runtime operation was accepted/executed, and idempotency of launch/prompt intents.

### The engine (via its binding: ACP or native SDK) owns

- The reasoning loop and its own tool execution for the duration of a turn.
- Its native session store and resume semantics; Stratum references engine session handles, never engine-internal formats.
- Nothing about Stratum Task/WorkItem state: an engine outcome is a claim, not a completion.

### GitHub owns

- Repository identity, branches/commits, PRs, reviews, check runs and merge state.
- Stratum stores typed references and snapshots/receipts, never replaces GitHub's authority.

### OMP (future optional adapter) owns

- WorkRequest binding and run lifecycle, exact candidate/SHA qualification and lawful actions.
- Stratum may initiate *explicit* accepted handoffs, display OMP's projection, and invoke only OMP-declared actions subject to fresh authorization.
- Stratum must not import OMP's internal state predicates or auto-accept an OMP run because its own Task transitioned.

### Threat model: multi-user versus host-local permissions

The core security problem is **not only authenticating the web UI**. A server authorized to control agent engine processes has broad power over repositories, terminals, files and everything the engines can reach — engines run with the host's privileges unless sandboxed. (Paseo's [documented permission model](https://github.com/getpaseo/paseo/blob/b6dde61a7f56eff276196f6670d9705bd45a9849/docs/permissions.md) being primarily daemon-wide was one of the observations that motivated Revision 2: Stratum must own this boundary itself.)

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

## 5. Session/runtime properties the host runtime must have

*(Rewritten in Revision 2. Previously: "Paseo's agent/session concepts worth reusing." Paseo remains the richest observed implementation of these properties, so its design is retained as the primary reference — but the properties below are now requirements on the **Stratum host runtime**, satisfied against whatever engine sits behind ACP.)*

### Durable identity distinct from runtime process

The host runtime persists an AgentSession record with engine, configuration, workspace/cwd, engine session handle, runtime status, parentage and timestamps. A `closed` session is not necessarily archived or deleted; it may be resumed later. Do not equate a live engine process with the durable conversation. (Reference: Paseo agent records; Goose's persisted sessions with `session/load`; Pi's `SessionManager` with branching persisted JSONL.)

### Engine session handles, not a universal replay protocol

Engines own their own session IDs and resume semantics (Goose ACP `session/load`; Pi restores by constructing a session over its `SessionManager`). **Do not invent a universal message replay protocol** as a substitute. Stratum stores the engine's identifiers and drives engine-specific resume behavior behind the ACP boundary or the engine SDK.

### Hierarchical agents

Parent-child relationships and detach/archive behavior belong to runtime lifecycle. These do not automatically imply parent/child PM Tasks. Expose them, but keep task decomposition separate.

### Two paths for the timeline

```text
live stream (ACP session/update, SDK events): low latency, possibly delta shaped
authoritative fetch: session/transcript from engine or host-owned append-only log
```

The client should retain a current accepted timeline and catch up after reconnect; it must not mistake socket connectivity for complete history. Because the host runtime (not the engine product) now owns session records, Stratum should **append every observed engine event to its own durable session log** as the authoritative projection, with the engine's transcript as the recovery source. This avoids both inventing transcript facts and replaying engine messages twice. Stratum-controlled approvals and evidence require their own durable records regardless.

### Idempotent agent launch and prompt delivery

The host runtime must distinguish request IDs (one RPC attempt) from durable idempotency keys (one intent) and message IDs (one submission). A lost acknowledgment must not launch a second engine process or send a second prompt on retry. Outcome-unknown states must be explicit when execution could have occurred but the receipt was lost. (Reference: Paseo Hub's request/idempotency-key separation; ACP has no built-in idempotency, so this is host-runtime responsibility.)

### Permissions and subagent containment

A parent spawning child sessions is useful, but delegation can multiply runtime cost and filesystem reach. The host runtime needs explicit launch permissions, host/project boundaries, resource budgets and user attention on permission requests. Do not equate arbitrary agent-spawn capability with authorized Task creation. Note the engine-posture difference (verified 2026-10-19): **Pi ships no permission system by design** and explicitly delegates isolation to the host/container; **Goose** has its own permission plumbing — the host runtime's tool broker, not the engine, must be Stratum's policy point of truth, so engine-level permission modes must be configured to defer to the platform, and any permission requests surfaced over ACP (`session/request_permission`) must be mediated by the host, never auto-approved by the UI.

Relevant source: [Paseo lifecycle](https://github.com/getpaseo/paseo/blob/b6dde61a7f56eff276196f6670d9705bd45a9849/docs/agent-lifecycle.md), [timeline sync](https://github.com/getpaseo/paseo/blob/b6dde61a7f56eff276196f6670d9705bd45a9849/docs/timeline-sync.md), [agent storage](https://github.com/getpaseo/paseo/blob/b6dde61a7f56eff276196f6670d9705bd45a9849/packages/server/src/server/agent/agent-storage.ts), [Goose goose-agent README](https://github.com/aaif-goose/goose/blob/main/crates/goose-agent/README.md), [Pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md).

---

## 6. Stratum host runtime: single host first, engines behind ACP

*(Rewritten in Revision 2. Previously: "Multi-machine architecture: connector first, distributed framework later" — a Paseo-connector design. Stratum now owns the runtime; multi-machine remains gated on single-host evidence.)*

The host runtime is the component where the concepts borrowed from Paseo — durable remote sessions, workspace placement, reconnection, agent lifecycle and process supervision — actually belong, reimplemented under Stratum's ownership and authority model.

Proposed logical topology:

```text
Browser / mobile UI
       |
Stratum API + project/task/auth DB
       |
Stratum host runtime (single host first)
  ├── Workspace manager (checkouts, worktrees, lifecycle)
  ├── AgentSession manager (durable records; engine handles)
  ├── Engine connector (ACP)  ──►  Goose (first)  ·  Pi  ·  future engines
  ├── Tool / permission broker (filesystem, shell, git, MCP)
  └── Sandbox manager (OS-level isolation; separate responsibility)
```

**First iteration:** one trusted host process launches and controls one engine (Goose over ACP stdio). Stratum owns the session record, the append-only event log, the tool/permission policy and the streaming projection; the engine owns the reasoning loop for the duration of each turn.

**Later:** more engines behind the same connector interface, then more hosts with durable host identity, status, credential rotation, reconnect reconciliation, placement policy and offline behavior — each gated on evidence from real use of the previous step.

### 6.1 Stratum owns an engine-neutral runtime interface

The contract that survives engine churn is **Stratum's own internal interface** — an `EngineConnector` boundary defined and versioned by Stratum, expressing what the host runtime needs: create/open/list sessions, prompt, steer, cancel, stream events, request permission mediation, and report terminal states. How each engine binds to it is an implementation choice:

- **Goose (initial):** bind via the **Agent Client Protocol (ACP)** — `session/new`, `session/load`, `session/prompt`, `session/cancel`, streamed `session/update`, `session/request_permission`. ACP is the preferred mechanism for Goose because it exists today and requires no engine-internal coupling. **ACP is not asserted as the universal contract for every engine.**
- **Pi (initial):** bind via Pi's **native TypeScript SDK** (`createAgentSession`, `SessionManager.open`, subscribe/steer/abort) inside the host process. Its SDK is purpose-built for embedding, and forcing it through ACP would add a process boundary for no benefit.

Rules:

- Stratum's persisted schema references **Stratum session records plus an engine-handle locator**, never engine-internal storage formats.
- Per-engine connectors adapt engine semantics (ACP methods, SDK calls) into the internal interface; a second engine must not require schema or product changes.
- A lost RPC reply must be resolved by session listing + host-side intent records, never by blind re-creation.

### 6.2 Goose: candidate engine, and what we verified

- **Governance/license:** Apache-2.0, Linux Foundation (AAIF) — low fork/dependency risk.
- **ACP:** first-class (`session/new|load|list|prompt|cancel`, steering, cancellation); a `test_acp_client.py` exists in-repo.
- **`goose-agent` crate (GDK):** an operation-driven agent state machine that re-derives every decision from persisted conversation ("the whole agent's behavior is a function of the persisted conversation, not of in-memory loop state"), with host-implemented `SessionLoader`/`EffectHandler` traits, typed tool operations, cancellation finalizers, and a **wasm32 build that runs in a JavaScript host without tokio**. This is architecturally the closest observed match to Stratum's needs — and it is `0.1.0-alpha.12` (7 releases in ~9 weeks, ~1.5k LOC, zero stability promise, currently the extraction of goose's internal `state_machine`). **Observation only; not a dependency until stable.**
- **Roaming (`goose-roaming`):** Iroh/QUIC peer-to-peer ACP transport, crate with zero dependency on goose core, wasm bindings for browser clients. Verified trust model is **all-or-nothing per peer public key** ("an accepted peer gets goose's full ACP surface — effectively remote shell access"; no roles), and revocation does not kill already-forked OS processes. Evaluate as a *transport candidate* for the multi-host phase only; it is **not** Stratum's security architecture. If reused, run one roam identity per project/host-process so acceptance maps to a Stratum-scoped grant.

### 6.3 Pi: comparator engine

- MIT, TypeScript-first; `@earendil-works/pi-coding-agent` SDK embeds the agent **in-process** (`createAgentSession`, subscribe/steer/followUp/abort, persistent branching `SessionManager`, full resource-loader control). Lower embedding friction for Stratum's TS codebase, and session durability is a first-class Pi concept.
- No built-in permission system — isolation is explicitly the host's job (containerization patterns documented). For Stratum this is clean: the platform owns policy end-to-end.
- Potential host-runtime overlap: Pi's `pi-durable` (durable conversation/task/document runtime) may cover part of the session-projection layer; assess license/fit if the SDK path is chosen.

### 6.4 Engine decision matrix

Judge engines on measured behavior, not stars or language:

| Axis | What to measure |
| --- | --- |
| Coding task success | Same task + model + verification passes for both |
| Efficiency | Tokens, model requests, wall time, cost per successful task |
| Resource usage | Idle/active memory, process startup, session-restore overhead |
| Control | Permission interception over ACP, cancellation cleanliness, resume fidelity, streaming shape |
| Extensibility | Can Stratum supply tools/storage/policies without forking? |
| Isolation | Does the engine behave correctly inside a constrained workspace/sandbox? |
| Authority ownership | Who owns the transcript of record — engine store or host log? |

### 6.5 Sandboxes are a separate responsibility

Do not rely on Goose or Pi alone to make agent execution safe. The sandbox manager establishes real filesystem, process and network restrictions enclosing the engine process and anything it launches; permission prompts and tool allowlists are not substitutes for OS isolation. Pi's documentation states this explicitly; Goose's own docs mark skills/filesystem discovery as "not a secure file-open API." For any multi-user design this is mandatory, not optional.

### 6.6 Required spikes before any engine commitment

Reproducible harnesses live in [`docs/research/engine-spikes/`](../research/engine-spikes/README.md) with tested versions, configuration assumptions, acceptance criteria (G1–G5), bounded timeouts and cost limits. Findings land beside them.

1. **Spike A — Goose over ACP** (throwaway script, no Stratum code): spawn `goose` ACP server; `session/new` → `session/prompt` → stream → `session/cancel` mid-turn → kill client → restart → `session/load` → assert no duplicated turns; capture a `session/request_permission` round-trip.
2. **Spike B — Pi via TS SDK:** identical task, in-process; same assertions; record LOC, control points, transcript ownership.
3. **Spike C (optional, informational):** build `goose-agent` for wasm32 and drive it from Node; no commitment.

**Gate:** reconnect recovery with zero duplicate turns/prompts on the primary path. If a binding cannot express a needed control (permission granularity, context injection, streaming shape), or measured overhead is material against model latency, revisit that engine's binding choice (e.g., GDK embedding for Goose, or a different transport) — with the alpha-churn caveat above.

### 6.7 Offline/recovery rules to prove

- Known host disconnected: show **offline/stale**, not `idle` or success.
- Browser disconnect: engine keeps running under the host runtime; reconnect rehydrates the existing session and missing timeline from the host-owned log.
- Engine/RPC timeout during creation/send: resolve by `session/list` + host intent records; never blindly create a new session.
- Engine process exits mid-turn: report error/uncertain outcome; no fabricated successful completion.
- Host replacement: preserve old host IDs as history, avoid rehoming sessions based on path/name.
- Multiple watchers: one shared authoritative status; no browser-specific mutation of agent lifecycle.

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

**DDR-035** says Era II should prioritize evidence-driven pilots, not speculative Era III infrastructure, and that "no architectural milestone is planned in advance" — a real run's observed deficiency is the only valid trigger for new architecture. The proposed platform path overlaps the document's historical Era III aspirations, and Revision 2 (owning a host runtime) increases that tension rather than reducing it. The conflict is real: **a deliberate product-priority decision is needed before diverting execution-roadmap effort.**

The proposed reconciliation (to be tested, not assumed): the deficiency trigger has arguably already fired — the author's daily engineering work *is* the run, and interface fragmentation (tasks in one place, interactive agents in another, evidence in a third) is the observed violation. Recorded in the existing deficiency format with tier/evidence/frequency, the single-host vertical slice becomes the **narrow patch to an observed violation**, and the §6.6 engine spikes are evidence-gathering, not architecture. **Ratifying this framing requires a separate future DDR (the next available number — DDR-036 through DDR-041 are already assigned); this proposal does not authorize the pivot, and no existing DDR records its acceptance.** Building beyond the slice — multi-host, RBAC, org features — remains gated on new evidence from real use of the slice.

This PR does not declare that conflict resolved. A narrow interaction proof can be authorized separately, with explicit scope and success criteria, while the existing supervised experiment sequence remains intact.

Do not rewrite `WorkItem` states, modify active pilots or refactor the Scheduler as part of this documentation PR.

---

## 9. Alternatives and recommendation

| Alternative | Strength | Weakness | Assessment |
| --- | --- | --- | --- |
| New monorepo from scratch | Freedom of design | Discards Stratum's verified domain/workflow/evidence investment | Not preferred |
| Fork Paseo as the whole product | Mature agent UX/runtime | Large provider/client maintenance burden; PM domain still missing | Avoid initially |
| Fork Paseo Hub as Stratum | Already has orgs, outbound daemons, execution plumbing | Early-stage; its workflow/triggers are not Stratum's WorkItem/Decision model | Worth an isolated comparison |
| Integrate Paseo as Stratum's runtime *(Revision 1 recommendation)* | Fastest path to durable sessions; no runtime to build | Daemon-wide permission model conflicts with Stratum's tenancy goals; runtime roadmap owned elsewhere; Hub dependency immature | Superseded — retained as design reference |
| Finish full PM first, bolt on agents | Familiar incremental feature order | Repeats the fragmentation problem | Avoid |
| Build on Stratum + Stratum host runtime + engines behind ACP (Goose first) | Reuses Stratum authority/evidence; Stratum owns the session lifecycle and policy; engine replaceability is real, not aspirational | Must re-solve the hard runtime problems Paseo solved (reconnect recovery, idempotent dispatch, resume) | **Preferred working hypothesis** |

Do not pre-commit to a wholesale microservice split or a new multi-tenant distributed-worker platform. The single-host host runtime is in scope; the multi-host fabric is evidence-gated. Start with modules and explicit adapter interfaces; extract services only when concrete deployment/security/evidence constraints require it.

---

## 10. Evidence-driven path to a product slice

### Phase 0 — accept/adjust the domain boundary (design only)

The four concepts are separate by agreed direction. Decide their exact references, operation ownership, authorization, and lifecycle handoff while preserving existing persistence and workflow invariants. Record an accepted DDR before migrating schema.

### Phase 0.5 — engine spikes *(added in Revision 2)*

Run §6.6's spikes before any Stratum code: Goose over ACP, Pi via TS SDK, same deterministic task and gate (reconnect recovery, zero duplicate turns, permission interception observed). Findings recorded under `docs/research/`. This is evidence-gathering under DDR-035's discipline, not architecture.

### Phase 1 — one trusted host, session-first vertical slice

On one existing Stratum deployment and the Stratum host runtime launching one engine (Goose over ACP):

1. Open a Project and create or inspect a planning Task.
2. Select a host workspace; launch or attach an agent through the **server-side** host runtime's engine connector.
3. Show initial and follow-up prompts, full tool/event timeline, permission request (mediated by the host's tool broker), running/idle/error.
4. Reopen browser and recover exactly the existing agent; prove no duplicate launch/message.
5. Link and unlink this session from a Task without changing the engine-native session identity.

**Gate:** demonstrably useful in an actual development session; correct reconnect and independent Task/AgentSession identity. This is the first implementation slice, not a requirement to finish all PM screens.

### Phase 2 — team-access and host authority prototype

Add actual human identities/memberships and enforce resource permission checks for task, session, timeline and control operations. Test two users with different project access, including direct RPC and WebSocket subscriptions. Do not provide shared remote team access until isolation has been proven.

### Phase 3 — GitHub/PR end-to-end slice

Connect a real repo, show branch/diff/PR/check facts, and finish one Task through an authorized code review/merge handoff. Prove that a stale PR head invalidates projected quality evidence.

### Phase 4 — multi-host proof

Two hosts with different worktrees, stable identity and reconnect. Compare the Stratum transport options with a small measured spike — `goose-roaming` (Iroh/QUIC; all-or-nothing peer trust, so one identity per project/host-process), a Stratum-hosted outbound bridge, and (only if its capability gaps have closed) a Hub-style outbound relationship as comparator. Record which capabilities are missing before designing custom transport.

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

1. **Domain — direction agreed:** Separate `Task`, `WorkItem`, `AgentSession`, and `WorkflowRun`; define their exact relations, transaction boundaries and ownership without modifying existing kernel contracts prematurely.
2. **UX entry point:** Task-first versus conversation-first default; both must ultimately work.
3. **Membership model:** Organization/project roles and permissions; how to scope observation and host control safely.
4. **Host model:** Are connected machines user-owned, team-owned, or both? What is the trust boundary?
5. **Engine boundary (Revision 2):** The internal `EngineConnector` contract is Stratum-owned; initial bindings are ACP for Goose and the native SDK for Pi. Confirm both with §6.6 spikes. Under what measured evidence do we revisit a binding (Goose GDK embedding, Pi transport changes), and which controls must the internal interface expose before a second engine can be added without rework?
6. **Conversation persistence:** How much transcript metadata can Stratum cache, versus treating the engine's session store as recovery source — and is the host-owned append-only session log the authority for Stratum projections?
7. **Delegation:** Which actor may launch subagents, allocate worktrees, issue tasks or request additional permissions?
8. **GitHub identity:** Installation ownership, repo mapping, PR head binding, and human merge permission.
9. **Work orchestration:** How does an interactive session become a bounded workflow without silently manufacturing authority?
10. **DDR-035 priority:** What explicitly changes in the existing experiment roadmap, and what remains frozen?
11. **Packaging:** Single Node process, modular service, or later separated web/worker services? Defer until trust and deployment constraints are known.
12. **OMP:** When does OMP provide measured value, and which project workflows actually need its stronger supervision?

### Proposed first decision

**With the four-object boundary agreed in principle, define the ownership and handoff contracts** between the collaboration domain, existing engineering kernel, and the Stratum host runtime's AgentSession records. This is the next architectural hinge: it affects schema, APIs, UX and every later adapter — engine-side and kernel-side.

---

## 12. Explicit non-goals and stop conditions

**Not in the initial implementation:**
- A new generic LLM/agent runtime or another engine product replacing existing engines. *(Amended in Revision 2: the single-host Stratum host runtime is in scope; what remains out of scope is a *multi-tenant* runtime fabric.)*
- A fork of Paseo's or Goose's entire desktop/daemon stack.
- A generic distributed scheduler, Kubernetes-like WorkerNode fabric or arbitrary computer-use platform. The multi-host fabric is evidence-gated behind the single-host slice.
- Full replacement of Stratum's existing WorkflowEngine or accepted DDR contracts.
- Autonomous merge, deployment, or acceptance triggered by chat text.
- Declaring multi-user security complete merely because a login UI exists.
- Importing all of Paseo Hub's workflow model into Stratum.
- Taking a dependency on the Goose GDK crates or any engine-internal library before stability and the §6.6 gate justify it.
- Delivering every PM feature before the first working agent session.

**Stop and revisit the proposed direction if:**
- A chosen binding (ACP for Goose, the native SDK for Pi) cannot provide essential session controls (permission interception, resume, cancellation) without engine-specific escapes that break the engine-neutral interface.
- The host runtime's tool broker cannot enforce the intended collaboration boundary on top of engine behavior.
- Resume/timeline semantics (engine or host log) are not reliable enough for multi-user supervision.
- Engine control model and host authority create unresolvable competing claims (e.g., engine-side permission modes that cannot defer to the platform).
- The first vertical slice does not improve real daily engineering flow compared with using Paseo or a raw engine CLI directly.

---

## 13. Suggested review outcome

This document is intentionally **DISCUSSION**. Reviewing/merging the Markdown file does not by itself authorize implementation or supersede an accepted DDR.

The review should result in:
1. Agreement or corrections to the product vision, the now-agreed logical domain separation, and the Revision 2 engine-boundary pivot.
2. A reviewed ownership/handoff contract for Task ↔ WorkItem ↔ AgentSession ↔ WorkflowRun.
3. Sign-off on the §6.6 spike scope (Goose ACP, Pi SDK) and its gate criteria.
4. A trusted-host, one-agent-session prototype scope and measurable acceptance criteria.
5. An explicit decision about DDR-035 roadmap impact (the DDR-036 deficiency-recording route, or explicit supersession).
6. Only then, one or more narrow DDRs/specs and implementation PRs.

**Guiding principle:** Stratum owns project meaning, identity, authorization, planning, the host runtime's session lifecycle and policy, and its existing deterministic execution/evidence boundaries. Engines (Goose first, behind ACP) execute reasoning loops without owning platform truth. Paseo is an architectural reference, not a dependency. GitHub owns repo/PR truth. OMP can later plug in as a separate stronger supervised-execution authority.
