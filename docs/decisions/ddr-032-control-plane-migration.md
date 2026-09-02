# DDR-032 — Control plane migration: multi-project orchestration above the workflow kernel

**Date:** 2026-08-28 · **Status:** accepted
**Affects:** additive — a new control-plane layer (projects, objectives, work items, decisions, evidence, policy, scheduler, durable storage) built **on top of** the DDR-031 workflow model. No changes to the DDR-031 spec set.
**Source:** reworked from the untracked draft `STRATUM_CONTROL_PLANE_MIGRATION.md` (derived from branch `claude/vigilant-allen-wxa1nf` before DDR-031 landed). This DDR supersedes that draft.

---

## 0. Relationship to DDR-031

DDR-031 already decided, at the spec level, the generalization this migration originally proposed as its first step:

- The fixed 15-value `DAGNode` enum is replaced by six generic `StepKind` values; the lifecycle is now a `WorkflowDefinition` (`full-build`, `draft-artifact` builtins) — the kernel no longer knows `DESIGN`, `TEST`, `BUILD`, or `DEBUG` exist.
- The singular project-wide cycle is replaced by concurrent `WorkflowRun`s with artifact-level claims.
- Workflow definitions are YAML documents (`.sle/workflows/{id}.md`) with chat-router dispatch — not static TypeScript registrations.

This DDR therefore does **not** re-propose any of that. It does three things:

1. Records what remains **unimplemented in code** from DDR-031 (§5, Phase 4).
2. Adds the **new scope** DDR-031 deliberately did not cover: multi-project/multi-repository control, objectives, scheduling, policy, evidence, decisions, durable events, SQLite persistence, execution adapters, and the attention-first interface.
3. Defines a strict layering so the two models compose without collisions (§7, §9, §19.4).

The rule for all collisions resolved in this DDR: **the DDR-031 specs stay untouched; the control plane layers strictly above them.**

---

## 1. Executive summary

Stratum should not be discarded and a new orchestration platform should not be built from scratch. The repository already contains a substantial amount of useful infrastructure: guarded state transitions, run artifacts, bounded agent roles, validation concepts, confirmation checkpoints, a provider abstraction, a daemon/API, a WebSocket UI channel, context management, recovery behavior, and a sizeable test suite.

The remaining problem is architectural placement. Stratum still combines two different concerns:

1. **Generic orchestration infrastructure** — state, runs, events, scheduling, approvals, execution, evidence, persistence, APIs.
2. **One specific software-development methodology** — scoping, design, critique, planning, tests, sharding, confirmation, build, execution, validation, debugging, evaluation, summarization, snapshotting.

DDR-031 separated these concerns **in the specs**: the methodology became the `full-build` workflow definition; the six `StepKind`s became the generic engine vocabulary. This DDR completes the separation **in the system**: it extracts a stable orchestration kernel, moves the implementation of the current lifecycle into the workflow layer, and adds the control plane above it.

The Stratum mission becomes:

> **Stratum is a control and orchestration plane for autonomous software work. It converts human objectives into bounded work, dispatches agents through replaceable execution adapters, enforces policy, collects independent evidence, and surfaces only decisions that require human attention.**

The target architecture:

```text
CURRENT (post-DDR-031 specs, pre-migration code)

Stratum (one project, .sle/)
└── cycle engine (src/cycle-runner.ts, src/dag-runner.ts)
    ├── state machine
    ├── hard-coded step sequence
    ├── agents
    ├── gates
    ├── execution
    ├── validation
    ├── artifacts
    └── UI


TARGET

Stratum
├── control plane
│   ├── projects
│   ├── objectives
│   ├── attention
│   ├── decisions
│   └── policy
│
├── orchestration kernel
│   ├── work items
│   ├── workflow runs (DDR-031, unchanged semantics)
│   ├── state transitions
│   ├── scheduler
│   ├── events
│   ├── evidence
│   └── artifacts
│
├── workflows
│   ├── full-build            <- builtin (DDR-031)
│   ├── draft-artifact        <- builtin (DDR-031)
│   └── user-authored YAML    <- .sle/workflows/*.md (DDR-031)
│
├── adapters
│   ├── agent executors
│   ├── GitHub
│   ├── ci-toolkit
│   ├── notifications
│   └── storage
│
└── interfaces
    ├── HTTP API
    ├── WebSocket/SSE
    ├── web
    ├── Android
    └── CLI
```

The implementation is evolutionary. No rewrite: introduce generic domain types and persistence beside the current cycle engine, implement the DDR-031 step engine, wrap the existing lifecycle as `full-build` running on it, and only then remove the old single-project assumptions.

---

# 2. The new goal

The system we are building is not primarily an "AI coding agent." It is the layer above coding agents.

The desired operating model:

```text
Human objective
    ↓
Stratum control plane
    ↓
Work decomposition + policy
    ↓
Agent execution
    ↓
Git branch / pull request
    ↓
Mechanical CI + ci-toolkit semantic review
    ↓
Evidence
    ↓
Policy evaluation
    ↓
Human attention only when necessary
```

The developer should primarily manage:

- intent;
- priorities;
- constraints;
- risk tolerance;
- architecture decisions;
- scope changes;
- final approval where policy requires it.

The developer should not normally manage:

- individual agent tool calls;
- agent prompts;
- low-level retries;
- routine test failures;
- normal branch creation;
- internal refactoring choices;
- raw logs;
- ordinary CI remediation;
- which LLM happens to execute a task.

The system must therefore optimize for **human attention efficiency**, not maximum agent visibility.

---

# 3. Architectural laws

These laws are stable design constraints. They are this DDR's core content: none of them are decided by DDR-031, which governs intra-project workflow execution only.

## Law 1 — The core owns state; agents do not

Agents are replaceable workers. Durable project knowledge, work status, decisions, evidence, policies, and history belong to Stratum.

Killing every running agent process must not lose meaningful project state.

## Law 2 — Agents propose actions; policy determines what is allowed

An LLM prompt is never an authorization boundary.

Permissions such as merge, destructive migration, new infrastructure, major dependency addition, scope expansion, or production deployment must be enforced by deterministic policy outside the agent.

## Law 3 — Completion requires evidence, not agent confidence

"Done" is not an agent statement.

Completion requires machine-verifiable evidence appropriate to the work contract: CI status, tests, semantic review, required artifacts, acceptance criteria, or explicit approval.

## Law 4 — Flexibility belongs at explicit boundaries

Optimize for replaceability rather than universal configurability.

Changing Claude to Codex affects an execution adapter, not the domain model. Changing GitHub to another SCM affects a repository adapter, not work semantics.

## Law 5 — Every new concept carries permanent cost

The stable domain vocabulary remains small. New abstractions are introduced only after real duplication or a real capability boundary exists.

## Law 6 — The kernel must remain boring

The kernel contains deterministic orchestration semantics, not clever agent behavior.

Prompt design, model-specific capabilities, code-generation methodology, and project-specific conventions stay outside the kernel. Post-DDR-031 this law is already spec'd for the workflow engine (workflow definitions carry the methodology); this DDR extends it to the whole control plane.

## Law 7 — Independent systems should validate independent claims

The system producing code should not be the only system certifying that code.

Git is the change record. CI is mechanical evidence. `ci-toolkit` is an independent semantic/security review layer. Stratum consumes that evidence rather than replacing it.

---

# 4. Current Stratum: what is worth keeping

The current codebase contains useful foundations. These are preserved or generalized rather than rewritten.

## 4.1 State transition discipline

`src/state-machine.ts` defines explicit transitions with:

- transition IDs;
- source state;
- target state;
- deterministic preconditions;
- deterministic mutation;
- structured rejection.

This is the correct philosophy. The current lifecycle-specific states move under the workflow layer (per DDR-031's state-machine.md), but explicit guarded transitions remain foundational.

## 4.2 Runtime state validation

`src/runtime-map.ts` provides:

- a formal runtime schema;
- Zod validation;
- atomic-ish writes;
- a mutex around updates;
- a persistence abstraction through `RuntimeMapManager`.

The single YAML map is not sufficient for multi-project orchestration, but schema-first state management is retained.

## 4.3 Run artifacts

`src/run-artifacts.ts` tracks step status, start/end times, token use, generated artifacts, context packs, failure reports, and raw outputs.

This evolves into the generic run/evidence/artifact subsystem (§8.11, §20). Note the spec set already defines the target shape: `WorkflowRun` run-artifacts (workflow-execution.md §Run artifacts) and the artifact registry (artifact-registry.md).

## 4.4 Agent execution boundary

`src/agent-runner.ts` separates context construction, provider execution, output parsing, path validation, and artifacts. The interface is too tied to lifecycle step roles (DDR-030 documents this), but the concept maps naturally to a generic `ExecutionAdapter` (§12).

## 4.5 Provider abstraction

`src/llm-provider.ts` proves provider-specific code can remain behind a narrow boundary. The same pattern applies at the higher `ExecutionAdapter` level for Claude Code, Codex, DeepSeek Harness, local workers, or other executors.

## 4.6 Human gates

`src/confirm-service.ts`, sharding approval, scoping approval, and the daemon's approval callbacks demonstrate the right idea: agents advance autonomously until policy requires human input.

DDR-031 generalizes the hard-coded gate names into the `checkpoint` step kind with a single nullable `awaiting_checkpoint` pointer. This DDR wraps that mechanism in the first-class `Decision` model (§8.8, §19.4) without changing it.

## 4.7 Event-driven UI updates

`src/event-bus.ts` provides a real-time path from runtime events to the web UI. The transport is useful. The event model becomes durable and strongly typed (§14); WebSocket messages become projections of events.

## 4.8 Recovery and bounded loops

The run runner (`src/cycle-runner.ts`) contains iteration caps, failure routing, debugging loops, and halting behavior. These are reliability primitives and are generalized rather than discarded. DDR-031's iteration lifecycle (workflow-execution.md §Iteration rules) specifies the target semantics.

## 4.9 Test investment

Stratum has extensive tests covering runners, providers, confirmation, context, run behavior, and recovery. Migration preserves these tests where behavior remains valid and adds kernel-level invariant tests (§29) before deleting old implementations.

---

# 5. Current Stratum: what must change

Each item below is labeled:

- **Spec-decided (DDR-031), implementation pending** — the specs already prescribe the fix; the code has not caught up. No new decision needed.
- **New scope (this DDR)** — not covered by any spec; this DDR decides it.

## 5.1 The hard-coded step sequence is not a generic kernel

**Status: spec-decided (DDR-031), implementation pending.**

Today `src/dag-runner.ts` hard-codes the legacy lifecycle:

```text
SCOPING → DESIGN → CRITIQUE → PLAN → TEST → SHARDING_APPROVAL →
CONFIRM → BUILD → HISTORY → EXEC → VALIDATION_GATE → DEBUG →
EVALUATE → SUMMARISE → SNAPSHOT
```

DDR-031 replaces this with six `StepKind`s and `WorkflowDefinition`s. The remaining work is the code migration (§28 Phase 4): implement the generic step engine per workflow-execution.md, express `full-build` as a builtin definition, and delete `DAG_SEQUENCE` from the engine.

## 5.2 The run runner has too much methodology-specific branching

**Status: spec-decided in target shape; implementation pending.**

`src/cycle-runner.ts` branches on named lifecycle steps and implements their behavior. It is simultaneously:

- workflow interpreter;
- orchestration engine;
- checkpoint coordinator;
- recovery loop;
- software-development methodology.

These responsibilities split per the DDR-031 model: the engine knows only step kinds, flow rules, iteration caps, and checkpoints; the methodology lives in the workflow definitions and their per-step instruction bodies.

## 5.3 The runtime map assumes one project and one active lifecycle

**Status: spec-decided (map shape), implementation pending; multi-project is new scope.**

The **specs** now define the post-DDR-031 map: `workflow_runs` keyed by `run_id` (replacing singular `cycle`), `completed_run_count`, per-artifact claims, per-workflow run counters (map-yaml-schema.md). The **code** still writes the singular shape.

The remaining limitation is scope: the map is still **one project** (one `.sle/` directory). Multi-project orchestration — many projects, repositories, objectives, concurrent work items — is new scope decided by this DDR (§7, §15).

## 5.4 The event system is ephemeral

**Status: new scope (this DDR).**

The event bus broadcasts over WebSocket. Events are not the durable history of the system.

Durable events are needed for:

- auditability;
- recovery;
- debugging;
- UI reconnection;
- analytics;
- replaying recent activity;
- understanding why a decision was surfaced.

## 5.5 Role-to-step and role-to-path mappings are embedded in the runner

**Status: spec-decided (declarative mapping), implementation pending.**

DDR-031 moves these mappings into the workflow definition: each `WorkflowStep` declares `agent_role`, `prompt_template`, `input_context`, and `output_artifact`. The code still embeds them in the runner.

## 5.6 `daemon.ts` is becoming a composition hotspot

**Status: new scope (this DDR).**

The daemon directly wires state, run, scoping, confirmation, intake, sharding, chat, tags, prompts, settings, links, event handling, and filesystem concerns.

The target API layer delegates to application services. It does not become the place where business rules accumulate.

## 5.7 Stringly typed and `any` boundaries are too common

**Status: new scope (this DDR).**

The control plane needs schema-versioned, typed contracts for:

- domain events;
- execution requests/results;
- decisions;
- evidence;
- policies;
- workflow definitions (already typed in the DDR-031 specs);
- API commands.

`payload: any` is acceptable in an early dashboard event bus; it is not acceptable as the contract between long-lived orchestration components.

## 5.8 There is exactly one project

**Status: new scope (this DDR).**

Every subsystem assumes the daemon's cwd is the project: one `.sle/`, one map, one chat, one lifecycle. The control plane introduces `Workspace`/`Project`/`Repository` (§8.1–8.3) and multi-project scheduling (§16).

---

# 6. Target architecture

The target remains a **modular monolith**.

No microservices. One daemon/application, one database, one canonical API, internally separated modules.

```text
┌──────────────────────────────────────────────────────────────────┐
│                         INTERFACES                               │
│  Web UI          Android client          CLI          API        │
└──────────────────────────────┬───────────────────────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────────┐
│                        CONTROL PLANE                             │
│ Projects · Objectives · Priorities · Decisions · Attention       │
└──────────────────────────────┬───────────────────────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────────┐
│                     ORCHESTRATION KERNEL                         │
│ WorkItems · WorkflowRuns · State · Scheduler · Policy · Evidence  │
└──────────────────────────────┬───────────────────────────────────┘
                               │
                 ┌─────────────┼─────────────┐
                 │             │             │
┌────────────────▼───┐ ┌───────▼────────┐ ┌──▼───────────────────┐
│     WORKFLOWS       │ │ EXEC ADAPTERS  │ │ EXTERNAL ADAPTERS   │
│ full-build (builtin)│ │ Codex          │ │ GitHub              │
│ draft-artifact      │ │ Claude Code    │ │ ci-toolkit          │
│ user YAML (DDR-031) │ │ DeepSeek       │ │ notifications       │
└─────────────────────┘ └────────────────┘ └─────────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────────┐
│                         STORAGE                                 │
│ SQLite + filesystem artifacts (.sle/)                           │
└──────────────────────────────────────────────────────────────────┘
```

---

# 7. Stable domain model

The domain vocabulary is deliberately small, and **layered** so it composes with DDR-031 instead of colliding with it:

```text
Objective              human intent (control plane)
 └─ WorkItem           schedulable unit (control plane)         [new, this DDR]
     └─ WorkflowRun    one execution vs. a target               [DDR-031, unchanged]
         └─ StepExecution   one step/adapter attempt            [new, this DDR]
```

Entities:

| # | Entity | Layer | Defined by |
|---|---|---|---|
| 1 | `Workspace` | control plane | this DDR |
| 2 | `Project` | control plane | this DDR |
| 3 | `Repository` | control plane | this DDR |
| 4 | `Objective` | control plane | this DDR |
| 5 | `WorkItem` | control plane | this DDR |
| 6 | `WorkflowRun` | kernel | **DDR-031** (referenced, not redefined) |
| 7 | `StepExecution` | kernel | this DDR |
| 8 | `Decision` | control plane | this DDR |
| 9 | `Policy` | control plane | this DDR |
| 10 | `Evidence` | kernel | this DDR |
| 11 | `Artifact` | kernel | artifact registry (reference/artifact-registry.md), extended with cross-project provenance |
| 12 | `Event` | kernel | this DDR |

Naming rules enforced during review:

- The bare word "run" never appears in the control-plane tier; it is always `WorkflowRun` (whole workflow execution) or `StepExecution` (single step attempt).
- `WorkItem.workflow_id` references a DDR-031 `WorkflowDefinition` by id (e.g. `full-build`).
- Agents never directly mutate state at any tier; they submit results/requests, and application services validate and apply transitions.

Avoid adding more core nouns unless the new concept has distinct lifecycle rules and cannot be represented cleanly through these.

---

# 8. Entity definitions

## 8.1 Workspace

A top-level control scope. Initially there is exactly one workspace.

```ts
interface Workspace {
  id: UUID;
  name: string;
  createdAt: Timestamp;
}
```

Do not build tenancy or organizational RBAC yet. Keep the entity because it gives the hierarchy a stable root.

## 8.2 Project

A product/system-level unit that can contain one or more repositories. A project corresponds to what today is one `.sle/` directory.

```ts
interface Project {
  id: UUID;
  workspaceId: UUID;
  name: string;
  description?: string;
  status: 'active' | 'paused' | 'archived';
  priority: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
```

Example projects:

- Kodeverket;
- Student Platform;
- Magnor.dev;
- Stratum itself.

## 8.3 Repository

A source repository connected to a project.

```ts
interface Repository {
  id: UUID;
  projectId: UUID;
  provider: 'github';
  remote: string;
  defaultBranch: string;
  localWorkspace?: string;
  status: 'active' | 'disabled';
}
```

A project may contain multiple repositories.

## 8.4 Objective

Human-level intent and priority.

```ts
interface Objective {
  id: UUID;
  projectId: UUID;
  title: string;
  description: string;
  priority: number;
  status: 'draft' | 'active' | 'completed' | 'cancelled';
  constraints: Constraint[];
  successCriteria: Criterion[];
}
```

Objectives are what the human primarily manages.

## 8.5 WorkItem

The atomic schedulable unit in the control plane. A WorkItem dispatches work into a project's workflow engine as a `WorkflowRun`.

```ts
interface WorkItem {
  id: UUID;
  projectId: UUID;
  objectiveId?: UUID;
  repositoryIds: UUID[];

  title: string;
  goal: string;

  workflowId: string;          // DDR-031 WorkflowDefinition id, e.g. 'full-build'
  state: WorkItemState;        // §9
  priority: number;

  acceptanceCriteria: Criterion[];
  constraints: Constraint[];
  requiredEvidence: EvidenceRequirement[];

  parentId?: UUID;
  dependencies: UUID[];

  createdAt: Timestamp;
  updatedAt: Timestamp;
}
```

The kernel understands `WorkItem`; it does not understand `gather`, `produce`, or any workflow's step ids. Whether chat-dispatched workflow runs get an explicit WorkItem or an auto-created implicit one is deliberately open (§39).

## 8.6 StepExecution

One attempt to execute a single workflow step (or a dispatched unit of adapter work) inside a `WorkflowRun`. This replaces the draft's `Run` entity — renamed to avoid colliding with `WorkflowRun`, which is a different (higher) granularity.

```ts
interface StepExecution {
  id: UUID;
  workItemId: UUID;
  workflowRunId: string;       // DDR-031 WorkflowRun.run_id
  stepId: string;              // WorkflowStep.id within that run

  executor: string;            // ExecutionAdapter id, e.g. 'stratum-agent'
  state: 'dispatched' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  attempt: number;

  startedAt?: Timestamp;
  completedAt?: Timestamp;

  cost?: Money;
  tokens?: number;

  failure?: FailureInfo;
}
```

`StepExecution`s are disposable. `WorkItem`s are durable. `WorkflowRun`s are durable for as long as the project's run history is kept (DDR-031 map semantics).

For workflow-internal steps executed by Stratum's own agents, the StepExecution record still exists — with `executor: 'stratum-agent'` — so cost, tokens, retries, and failures are uniformly queryable.

## 8.7 WorkflowRun — referenced, not redefined

`WorkflowRun`, `WorkflowDefinition`, `WorkflowStep`, `StepKind`, `ArtifactClaim`, and `ArtifactVersion` are defined by DDR-031 (types.md §4, workflow-execution.md, workflow-authoring.md) and are **not modified** by this DDR. The control plane treats `.sle/` workflow state as the project-internal source of truth for run execution, exactly as spec'd.

## 8.8 Decision

A first-class request for human judgment. `Decision` **wraps** DDR-031's checkpoint mechanism rather than replacing it (§19.4).

```ts
interface Decision {
  id: UUID;
  projectId: UUID;
  workItemId?: UUID;

  type: 'checkpoint' | 'policy.escalation' | 'merge.approval'
      | 'scope.expansion' | 'budget.overrun' | string;
  subjectRef: {
    workflowRunId?: string;    // set for type: 'checkpoint'
    stepId?: string;
    workItemId?: UUID;
    pullRequestUrl?: string;
  };

  title: string;
  summary: string;

  options: DecisionOption[];
  recommendedOptionId?: string;
  recommendationReason?: string;

  impact: 'low' | 'medium' | 'high' | 'critical';
  reversibility: 'easy' | 'medium' | 'hard' | 'irreversible';
  urgency: 'normal' | 'blocking' | 'urgent';

  status: 'pending' | 'resolved' | 'expired' | 'cancelled';
  resolution?: DecisionResolution;
}
```

`type: 'checkpoint'` decisions are minted automatically when a `WorkflowRun` enters `awaiting_checkpoint`, and resolved through the existing checkpoint-resolve endpoint (which resolves both). All other types are minted by policy evaluation, evidence collection, or the scheduler — things that exist outside any single run.

The impact/reversibility/urgency/recommendation fields are optional metadata a workflow or policy attaches; checkpoint cards get richer for free.

## 8.9 Policy

Deterministic authorization and escalation rules.

```yaml
merge:
  human_approval: true

schema_change:
  approval_required: true

new_infrastructure:
  approval_required: true

new_dependency:
  major: approval_required
  minor: allowed

scope_expansion:
  threshold: medium
  action: approval_required

agent_permissions:
  push_branch: allowed
  create_pr: allowed
  merge: denied
```

Policies are evaluated by code, not merely inserted into prompts.

## 8.10 Evidence

A fact supporting work completion or a policy decision.

```ts
interface Evidence {
  id: UUID;
  workItemId: UUID;
  stepExecutionId?: UUID;

  type: string;                // 'github.ci', 'ci_toolkit.semantic_review', ...
  source: string;
  subjectRef?: string;         // e.g. commit SHA / PR URL

  status: 'passed' | 'failed' | 'informational';
  payload: JsonValue;

  collectedAt: Timestamp;
}
```

Examples:

- GitHub Actions status for commit SHA;
- `ci-toolkit` semantic review result;
- test suite result;
- lint/type-check result;
- generated artifact checksum;
- user approval;
- scope-diff report.

## 8.11 Artifact

Durable outputs of work. The project-internal shape is already spec'd by the artifact registry (`ArtifactRef` + `ArtifactVersion` on front-matter/`.meta.json`, artifact-registry.md). The control plane adds provenance metadata in SQLite: stable artifact ids, hashes, types, which `WorkItem`/`WorkflowRun`/`StepExecution` produced them, and relationships.

Examples: branch; commit; pull request; design document; test plan; generated report; run log; diff; benchmark result.

## 8.12 Event

An immutable fact that something happened.

```ts
interface DomainEvent<T = JsonValue> {
  id: UUID;
  schemaVersion: 1;
  type: string;

  workspaceId: UUID;
  projectId?: UUID;
  workItemId?: UUID;
  workflowRunId?: string;

  occurredAt: Timestamp;
  payload: T;
}
```

Events are durable records. WebSocket/SSE messages are projections of events (§14).

---

# 9. WorkItem state machine

This is the **WorkItem-level** lifecycle. It sits strictly above the run-level machinery and never replaces it: `WorkflowRunStatus` (`active` | `halted` | `complete`, types.md) plus the DDR-031 iteration/checkpoint semantics remain authoritative **inside** a run.

```text
DRAFT
  ↓
READY
  ↓
RUNNING
  ↓
IN_REVIEW
  ↓
COMPLETED
```

Side states:

```text
NEEDS_DECISION
BLOCKED
FAILED
PAUSED
CANCELLED
```

Not every WorkItem visits every state. Transitions remain explicit and guarded.

### Deviations from the original draft, and why

The draft proposed `DRAFT → READY → RUNNING → VALIDATING → READY_FOR_REVIEW → READY_FOR_COMPLETION → COMPLETED` plus `WAITING`. Three trims:

- **`VALIDATING` dropped.** Inside a run, validation is already modeled by `review`/`execute` steps and the validation gate (step-kind-reference.md, validation.md). At the WorkItem level, evidence-readiness is a **derived property** (e.g. `evidence: 3/4 requirements satisfied`), not a state — evidence is first-class state (§20), and states and evidence should not both encode it.
- **`READY_FOR_REVIEW` and `READY_FOR_COMPLETION` merged into `IN_REVIEW`.** The distinction was "unresolved merge-approval Decision exists" — which the `Decision` model already represents. One state plus pending Decisions is enough.
- **`WAITING` dropped.** It overlapped `BLOCKED`. The meaningful distinction is `NEEDS_DECISION` (a human judgment is defined and pending) vs `BLOCKED` (dependency, policy, or technical obstruction with no Decision defined).

### Cross-layer mapping

| WorkflowRun (DDR-031) | WorkItem effect |
|---|---|
| `active` | item is `RUNNING` |
| `halted` with `awaiting_checkpoint` | item → `NEEDS_DECISION`; a `Decision(type: 'checkpoint')` is minted (§19.4) |
| `halted` on iteration cap / error | item → `FAILED` or `BLOCKED`, per policy |
| `complete` | evaluate evidence requirements → `IN_REVIEW` (if Decisions pending) or `COMPLETED` |

Invariant: WorkItem states never mirror run internals (iteration, revision, current step). Anyone needing run detail reads the run, not the item.

### Example transitions

### `READY -> RUNNING`

Requirements:

- all blocking dependencies completed;
- policy allows execution;
- required repository workspace available;
- execution capacity available.

### `RUNNING -> IN_REVIEW`

Requirements:

- the dispatched `WorkflowRun` reached `complete`;
- all mandatory evidence requirements satisfied;
- no unresolved blocking Decision.

### `* -> NEEDS_DECISION`

Triggered when a checkpoint is reached or deterministic escalation policy determines human judgment is needed.

### `* -> BLOCKED`

Triggered when progress cannot continue automatically and no human policy Decision is currently defined.

### WorkItem-level invariants

- completed work cannot be executed again without explicit reopen/version behavior;
- cancelled work never dispatches;
- blocked dependencies prevent dispatch;
- agents cannot directly set WorkItem state;
- every state change emits a durable event.

---

# 10. Workflow model

**Decided by DDR-031.** Workflows are YAML documents — skill-style definitions with front matter and per-step instruction bodies — stored per-project at `.sle/workflows/{id}.md`, with `full-build` and `draft-artifact` as reserved builtins and chat-router dispatch via `trigger.description` matching. Workflow authoring is itself just running `draft-artifact` (workflow-authoring.md).

This DDR adds only two things:

1. **Workflow ownership stays per-project.** The control plane references workflows by id (`WorkItem.workflow_id`); it never embeds step definitions. Cross-project methodology sharing, if ever needed, is template distribution (copy a YAML doc into another project), not a kernel feature.
2. **The kernel-to-workflow contract stays as spec'd:** a workflow step can be scheduled, completed, failed, or request a checkpoint. The scheduler (§16) dispatches WorkflowRuns; it does not interpret step bodies.

No dynamic plugin ecosystem, no bespoke builder UI — both already excluded by DDR-031.

---

# 11. The existing lifecycle as `full-build`

**Decided by DDR-031 at the spec level; implementation pending in code.**

The legacy 15-stage sequence is now expressed as the `full-build` builtin `WorkflowDefinition` over six `StepKind`s. The mapping (authoritative version in step-kind-reference.md):

| Legacy stage | StepKind expression |
|---|---|
| SCOPING | `gather` + `checkpoint` (Checkpoint 0) |
| DESIGN, PLAN, TEST-authoring, BUILD, SUMMARISE | `produce` (different `agent_role`s and templates) |
| CRITIQUE, EVALUATE | `review` |
| SHARDING_APPROVAL, CONFIRM | `checkpoint` (Checkpoints 1–2) |
| HISTORY | folded into `commit` (`logs_decision: true`) |
| EXEC, VALIDATION_GATE | `execute` + `review` |
| DEBUG | not a kind — any `review` step's `on_fail: { action: 'produce' }` route |

The remaining work is ownership in **code**: implement the generic step engine (workflow-execution.md), register the builtins, migrate the runner's per-stage branches into workflow definitions and per-step instruction bodies, and delete `DAG_SEQUENCE` from the engine.

This also already delivers the draft's `direct-code-change` idea: `draft-artifact` **is** that workflow — dispatching short, targeted units of work from chat without paying for the full pipeline.

Later workflow ideas (as user-authored YAML docs, no engine changes):

## `research` — later

```text
FRAME → INVESTIGATE → SYNTHESIZE → VERIFY → DELIVER
```

## `maintenance` — later

```text
DISCOVER → TRIAGE → FIX → VALIDATE → REPORT
```

---

# 12. Execution adapter model

The current `ILLMProvider` abstraction operates too low in the stack for the new goal.

Keep it for internal LLM calls (DDR-030 documents this layer), but introduce a higher-level executor boundary bound to `StepExecution`:

```ts
interface ExecutionAdapter {
  id: string;

  getCapabilities(): CapabilitySet;

  execute(request: ExecutionRequest): Promise<ExecutionResult>;

  cancel?(stepExecutionId: UUID): Promise<void>;
}
```

Example request:

```ts
interface ExecutionRequest {
  stepExecutionId: UUID;
  workItemId: UUID;
  workflowRunId: string;
  stepId: string;
  repository: RepositoryContext;

  goal: string;
  acceptanceCriteria: Criterion[];
  constraints: Constraint[];

  context: ContextReference[];
  permissions: ExecutionPermissions;
  budget: ExecutionBudget;
}
```

Example result:

```ts
interface ExecutionResult {
  schemaVersion: 1;
  stepExecutionId: UUID;
  outcome: 'succeeded' | 'failed' | 'blocked';

  artifacts: ArtifactReference[];
  evidenceClaims: EvidenceClaim[];
  decisionRequests: DecisionRequest[];

  usage?: {
    durationMs: number;
    tokens?: number;
    cost?: number;
  };

  failure?: FailureInfo;
}
```

Potential adapters:

- `StratumAgentAdapter` — reuse the current AgentRunner/AgentLoop for workflow-internal role agents;
- `ClaudeCodeAdapter`;
- `CodexAdapter`;
- `DeepSeekHarnessAdapter`;
- later: remote worker adapters.

The scheduler selects adapters based on capabilities and policy, not project-specific `if` statements.

---

# 13. Agent capability model

Avoid a giant universal model abstraction. Use a small capability set.

```ts
type ExecutorCapability =
  | 'repo.read'
  | 'repo.write'
  | 'shell'
  | 'tests.run'
  | 'browser'
  | 'network'
  | 'long_context'
  | 'structured_output';
```

Work specifies required capabilities. Adapters report available capabilities.

This lets models/tools evolve without forcing the kernel to understand provider-specific features.

---

# 14. Durable event system

Replace:

```text
runtime action
   ↓
WebSocket broadcast
   ↓
client
```

with:

```text
runtime action
   ↓
durable event append
   ↓
projectors/subscribers
   ├── scheduler
   ├── attention service
   ├── notification service
   ├── analytics
   └── WebSocket/SSE broadcaster
```

The system does not need full event sourcing. Current state remains in normalized tables. But every meaningful transition appends an immutable event.

Event namespaces are layered to match §7:

- **Intra-run events** keep the DDR-031 taxonomy exactly: `workflow_run.*`, `step.*` (websocket-events.md). The existing broadcaster becomes a projector over these.
- **Control-plane events** are added by this DDR:

```text
project.created
objective.created
objective.activated
work.created
work.ready
work.started
work.state_changed
work.completed
step_execution.dispatched
step_execution.completed
step_execution.failed
decision.requested
decision.resolved
policy.blocked
evidence.recorded
artifact.created
pr.created
pr.ready
```

Events carry schema versions from the start. `DomainEvent.workflowRunId` (§8.12) is the join key between the two namespaces.

---

# 15. Persistence strategy

## 15.1 Use SQLite first

The control plane needs queryable, concurrent, multi-project durable state. SQLite is the right first database:

- transactions;
- indexing;
- foreign keys;
- atomic updates;
- mature tooling;
- one-file deployment;
- no external infrastructure.

Do not introduce Postgres until there is an actual deployment/scaling reason.

## 15.2 Keep filesystem storage for large artifacts

Do not put every log, diff, snapshot, context pack, and agent transcript into relational rows.

```text
SQLite
  structured state + metadata + indices (control plane)

.sle/  (per project, as today)
  workflow state, runs, claims, artifacts   (DDR-031 shapes)
  artifact store for large/raw artifacts
```

`.sle/` is already untracked in git and gitignored (runtime state never belongs in the repository). The DB stores stable artifact ids, hashes, types, provenance, and relationships (§8.11).

## 15.3 Migration from `.sle/map.yaml`

Do not delete the runtime map immediately.

1. Introduce DB-backed control-plane entities (Workspace/Project/Repository/Objective/WorkItem/Decision/Evidence/Event) beside the existing map.
2. Bring the map implementation up to the post-DDR-031 spec shape (`workflow_runs` map, claims, per-workflow counters) — this is Phase 4 work anyway.
3. Wrap the map in a `ProjectRunStore` interface consumed by the workflow engine; the control plane reads through it.
4. Move write ownership of control-plane facts (projects, objectives, work items, decisions) out of YAML entirely — the map keeps only intra-project run state, as spec'd.
5. Retain optional YAML export/debug view if useful.
6. Remove any compatibility shims once the engine consumes only the spec'd shape.

This avoids a risky flag-day rewrite.

---

# 16. Scheduler

The scheduler is deterministic and initially simple.

Responsibilities:

- find `READY` WorkItems;
- check dependencies;
- check policy;
- check concurrency limits;
- match executor capabilities;
- create/dispatch the `WorkflowRun` (per-project, via the project's engine) and the `StepExecution` records;
- avoid duplicate dispatch;
- handle retry rules;
- stop after budgets/caps are exhausted.

The scheduler does not:

- decide architecture;
- invent objectives;
- modify acceptance criteria;
- interpret arbitrary agent prose;
- contain GitHub-specific behavior.

## 16.1 Initial scheduling policy

- priority order;
- FIFO within equal priority;
- per-project concurrency limit;
- per-repository write concurrency limit;
- global execution limit.

Avoid advanced optimization algorithms until real use provides evidence they are necessary.

## 16.2 Repository write safety — two lease layers

Two agents must not unknowingly mutate the same checkout/worktree, and two runs must not unknowingly write the same artifact. These are two different granularities, and both are already designed:

- **Artifact level (intra-project): solved by DDR-031.** `ArtifactClaim` (types.md) is exactly an exclusive writer lease at artifact granularity — claimed at dispatch, rejected immediately on conflict (`claim_conflict`), released on commit. No new mechanism needed.
- **Repository/worktree level (cross-run): new, this DDR.** Each write-capable execution operates in an isolated branch/worktree/container workspace. At minimum enforce:

```text
repository + workspace/branch target
      ↓
exclusive writer lease
```

Parallel read-only/research work remains unrestricted.

---

# 17. Reliability model

Autonomous execution assumes failure is normal.

Every external action can:

- time out;
- return malformed output;
- partially succeed;
- succeed but lose the response;
- be retried;
- duplicate an event;
- crash mid-run;
- violate expected scope.

The kernel is therefore built around recovery rather than optimistic happy paths.

## 17.1 Idempotency

Every side-effecting operation needs an idempotency strategy. Especially:

- create branch;
- create worktree;
- dispatch step execution;
- create PR;
- post review/comment;
- create decision;
- record evidence;
- merge;
- send notification.

Example:

```text
step execution id: EXEC-391
operation: create PR
idempotency key: EXEC-391:github:create-pr
```

A retry either returns the existing result or safely does nothing.

## 17.2 Leases and heartbeats

Long executions obtain a lease with expiration.

If the worker dies:

```text
lease expires
   ↓
execution becomes orphaned
   ↓
recovery service marks failed/retryable
```

Never leave work permanently "running" because a process disappeared.

## 17.3 Bounded retries

Each work contract includes limits such as:

```yaml
budget:
  max_attempts: 3
  max_runtime_minutes: 60
  max_child_work_items: 10
  max_scope_growth: medium
  max_cost_usd: 5
```

After a cap is hit, escalate or mark blocked/failed. Iteration caps inside a run are already spec'd (workflow-execution.md §Iteration cap); this budget governs the WorkItem and its executions above the run.

Never permit indefinite autonomous retry loops.

## 17.4 Crash recovery

On daemon startup:

1. inspect nonterminal WorkItems, WorkflowRuns, and StepExecutions;
2. verify active worker leases;
3. reconcile GitHub/CI state where relevant;
4. mark orphaned executions;
5. safely resume/retry according to policy;
6. emit recovery events.

---

# 18. Policy engine

Policy begins small and deterministic.

No generic policy language initially. Typed rule evaluators in code with project-level configuration.

Initial rules cover:

- merge permission;
- destructive actions;
- schema migrations;
- new infrastructure;
- dependency additions;
- scope expansion;
- budget overruns;
- production access;
- secret access;
- required evidence;
- human approval thresholds.

Example evaluation:

```ts
interface PolicyEvaluation {
  outcome: 'allow' | 'deny' | 'require_decision';
  reason: string;
  decisionTemplate?: DecisionRequest;
}
```

This is the bridge between autonomy and control.

---

# 19. Decision and attention system

The UI goal depends on this subsystem being excellent.

Not every event becomes a notification. Not every failure becomes a Decision. The attention service surfaces only meaningful human interventions.

## 19.1 What should normally be autonomous

- naming;
- internal refactors within scope;
- test organization;
- routine lint/type fixes;
- ordinary CI retries;
- small implementation choices;
- patch dependency changes allowed by policy;
- retrying transient provider failures.

## 19.2 What should normally require human judgment

- product behavior changes;
- architectural boundary changes;
- major scope expansion;
- database ownership/model changes;
- irreversible migrations;
- new infrastructure services;
- major dependencies;
- material cost increases;
- privacy/security tradeoffs;
- conflicting requirements;
- merge where policy requires human approval.

## 19.3 Decision compression

Agent output is converted into a stable decision schema. A decision card answers, in roughly this order:

1. What is being decided?
2. Why is a decision needed now?
3. What is recommended?
4. Why?
5. What are the realistic alternatives?
6. What is the impact/risk/reversibility?
7. What action can the developer take?

Raw reasoning/logs remain one or more levels deeper.

## 19.4 Checkpoints are the mechanism; Decisions are the record

DDR-031's checkpoint protocol — `awaiting_checkpoint` pointer, checkpoint steps, resolve endpoint — is the **in-run pause mechanism** and is not modified.

This DDR wraps it:

```text
WorkflowRun enters awaiting_checkpoint
   ↓
workflow layer mints Decision
  (type: 'checkpoint', subjectRef: {workflowRunId, stepId})
   ↓
attention service surfaces it (Needs You)
   ↓
existing checkpoint-resolve endpoint
   ↓
Decision resolved + run resumes
```

`Decision` then generalizes to what checkpoints cannot express: policy escalations (`merge.approval`, `budget.overrun`, `scope.expansion`) that exist outside any single run. One attention queue, one durable audit record type, no new gate concepts — the §35 merge-approval card is just a Decision with GitHub/ci-toolkit evidence attached.

---

# 20. Evidence and completion

The kernel treats evidence as first-class state.

A WorkItem defines requirements like:

```yaml
required_evidence:
  - type: github.ci
    status: passed
  - type: ci_toolkit.semantic_review
    blocking_findings: 0
  - type: acceptance_criteria
    satisfied: all
```

Evidence collectors are adapters.

## 20.1 GitHub evidence

- commit exists;
- PR exists;
- PR head SHA;
- branch protection status;
- workflow status;
- review status.

## 20.2 `ci-toolkit` evidence

Stratum consumes `ci-toolkit` output as independent semantic evidence. `ci-toolkit` remains a separate repository/component.

```text
Stratum creates/observes PR
        ↓
GitHub workflows run
        ↓
CI + ci-toolkit produce checks/review
        ↓
Stratum GitHub adapter reads results
        ↓
Evidence records
        ↓
Completion policy evaluates
        ↓
Decision (merge approval) where policy requires
```

Do not make Stratum call its own internal reviewer and then certify itself.

---

# 21. Scope control

Scope drift must be detectable rather than merely discouraged in prompts.

A WorkItem records intended scope through some combination of:

- repository set;
- subsystem/area tags;
- expected files/directories when known;
- forbidden areas;
- expected artifact types;
- dependency/infrastructure constraints.

After execution, a scope analyzer compares actual changes to expected scope:

```text
within_scope
minor_expansion
material_expansion
forbidden_change
```

Policy then decides whether to allow, reject, or request human approval.

This eventually becomes one of the strongest defenses against autonomous agent drift.

---

# 22. Security model

The control plane has significantly more authority than the current single-project daemon. Security boundaries are explicit before remote phone access is introduced.

## 22.1 Principle of least authority

Executors receive only capabilities required for the execution.

A research execution does not automatically receive repository write access. A code execution does not automatically receive production credentials.

## 22.2 Sandboxed execution

Continue the sandbox direction already present in Stratum (`src/exec-service.ts`, `src/exec-gate.ts`).

Write-capable executions preferably run inside isolated containers/workspaces with:

- controlled filesystem mounts;
- explicit network policy;
- explicit environment variables;
- CPU/memory/time limits;
- no host Docker socket;
- no arbitrary host secret inheritance.

## 22.3 Secret broker boundary

No long-lived provider/GitHub/production credentials in generic task context. The execution system injects only the secrets required for the operation.

## 22.4 Remote API authentication

The current local daemon assumptions are not enough for Android/web remote control. Before internet-accessible deployment, add:

- authenticated sessions/API tokens;
- TLS termination;
- CSRF protection for browser mutations where applicable;
- explicit CORS policy;
- rate limiting for sensitive commands;
- audit events for approvals/merges/cancellations;
- secure token storage on Android.

Do not expose the existing unauthenticated daemon directly to the internet.

---

# 23. API architecture

One canonical backend API serves web, Android, and CLI. Frontend clients never implement orchestration semantics.

The single-project daemon API (daemon-api-endpoints.md, DDR-031 shape) remains the intra-project surface. The control-plane API is a new layer above it:

```text
/projects
/repositories
/objectives
/work
/workflows          (list available WorkflowDefinitions per project)
/runs               (WorkflowRuns, read-only projection across projects)
/decisions
/evidence
/artifacts
/events
/attention
```

Representative commands:

```text
POST /objectives
POST /objectives/{id}/activate
POST /work
POST /work/{id}/pause
POST /work/{id}/resume
POST /work/{id}/cancel
POST /work/{id}/redirect
POST /decisions/{id}/resolve
```

Queries:

```text
GET /attention
GET /projects
GET /projects/{id}
GET /work?state=...
GET /work/{id}
GET /work/{id}/evidence
GET /runs/{id}
GET /events?after=...
```

REST first. No GraphQL. WebSocket or SSE only for real-time changes.

---

# 24. Web and Android interface

The default product surface is attention-oriented.

Top-level navigation:

1. **Needs You**
2. **Work**
3. **Projects**
4. **Activity**

## 24.1 Needs You

Default screen. Contains only:

- unresolved blocking Decisions;
- high-impact nonblocking Decisions;
- work requiring approval;
- serious system failures requiring intervention.

## 24.2 Work

Outcome-oriented list of active WorkItems, grouped by project.

Show:

- goal;
- state;
- workflow + current step (read from the WorkflowRun);
- risk;
- current meaningful activity;
- blockers;
- evidence readiness (derived, §9).

Do not center the UI around individual agent processes.

## 24.3 Projects

Strategic view:

- objectives;
- priorities;
- active work;
- policies;
- risk/health;
- repositories.

## 24.4 Activity

Deep observability:

- events;
- WorkflowRuns and StepExecutions;
- agent traces;
- logs;
- token/cost data;
- raw artifacts;
- CI details.

Available but rarely required.

## 24.5 Android strategy

No separate Android backend. Use the canonical Stratum API.

1. responsive web UI first;
2. prove the attention/work interaction model;
3. package or implement Android client once API semantics are stable;
4. push notifications only for actual attention events.

Flutter is a reasonable option if a native APK is desired, but the backend API remains independent of that choice.

---

# 25. Context and architectural memory

Current Stratum already has context management and project-document concepts (context-manager.md). These move out of kernel state and become a service producing context references for executions.

Important durable context:

- project objectives;
- active constraints;
- architecture decisions;
- repository rules;
- relevant historical work;
- required acceptance criteria;
- prior failures/evidence.

## 25.1 Architectural decisions are durable

Major decisions are not left buried in chat transcripts. A structured decision/ADR representation is stored and queryable by future work.

```text
ADR-041
Decision: Do not introduce Redis for scheduling.
Reason: Existing scale does not justify additional infrastructure.
Scope: Kodeverket scheduling.
Status: active.
```

Context assembly then includes relevant active decisions.

## 25.2 Context service is not the source of truth

Context assembly creates a bounded view for an agent. The underlying truth remains in durable entities, repository contents, decisions, and evidence.

---

# 26. Proposed codebase structure

Target structure after migration:

```text
src/
├── domain/
│   ├── workspace.ts
│   ├── project.ts
│   ├── repository.ts
│   ├── objective.ts
│   ├── work-item.ts
│   ├── step-execution.ts
│   ├── decision.ts
│   ├── policy.ts
│   ├── evidence.ts
│   └── event.ts
│
├── kernel/
│   ├── work-state-machine.ts
│   ├── scheduler.ts
│   ├── dispatcher.ts
│   ├── recovery.ts
│   ├── policy-engine.ts
│   ├── completion-engine.ts
│   └── event-store.ts
│
├── application/
│   ├── project-service.ts
│   ├── objective-service.ts
│   ├── work-service.ts
│   ├── decision-service.ts
│   ├── attention-service.ts
│   └── evidence-service.ts
│
├── workflows/
│   ├── registry.ts
│   ├── step-engine.ts        (generic StepKind engine — workflow-execution.md)
│   └── builtin/
│       ├── full-build.ts     (definition + per-step instruction bodies)
│       └── draft-artifact.ts
│
├── execution/
│   ├── adapter.ts
│   ├── registry.ts
│   ├── stratum-agent/        (wraps AgentRunner/AgentLoop)
│   ├── codex/
│   ├── claude-code/
│   └── deepseek-harness/
│
├── adapters/
│   ├── github/
│   ├── ci-toolkit/
│   └── notifications/
│
├── storage/
│   ├── database.ts
│   ├── sqlite/
│   └── project-run-store.ts  (wraps .sle/ run state per DDR-031)
│
├── api/
│   ├── server.ts
│   ├── routes/
│   ├── auth/
│   └── realtime/
│
└── cli/
```

Conventions:

- directories are keyed by DDR-031 ids (`workflows/builtin/full-build.ts`, not `software-development/`);
- persistent state lives under `.sle/` (existing convention; the product is Stratum since DDR-027 but the directory stays `.sle/` — renaming it is churn with no capability gain);
- do not create empty folders/interfaces merely to match this diagram; introduce modules as migration reaches them.

---

# 27. Current-file migration map

Concrete dispositions for the current `src/` tree. Terminology note: "run runner" = `src/cycle-runner.ts` (the legacy cycle engine, to be replaced by the generic step engine).

## `src/state-machine.ts`

**Action:** the lifecycle states migrate to the workflow layer (DDR-031 state-machine.md governs the target); the transition-table style, guards, and tests are preserved and reused for `kernel/work-state-machine.ts`.

## `src/runtime-map.ts`

**Action:** evolve to the post-DDR-031 map shape (`workflow_runs` map, claims, per-workflow counters), then wrap behind `storage/project-run-store.ts`.

Preserve: schema discipline; atomic update philosophy; version checking.

## `src/dag-runner.ts`

**Action:** delete after the generic step engine lands. `DAG_SEQUENCE` and all per-stage routing become the `full-build` builtin definition. Extract only genuinely generic step-flow concepts into `workflows/step-engine.ts`.

## `src/cycle-runner.ts`

**Action:** split heavily.

- per-stage branches → `workflows/builtin/full-build.ts` + per-step instruction bodies;
- iteration caps, failure routing, halting → step engine (already spec'd by workflow-execution.md);
- checkpoint coordination → step engine + Decision minting (§19.4);
- recovery loop → `kernel/recovery.ts`;
- cost/token/failure recording → StepExecution records.

## `src/cycle-service.ts`

**Action:** becomes the run service over WorkflowRuns (`workflows/` layer), speaking the DDR-031 API contract.

## `src/agent-runner.ts`

**Action:** keep as the implementation basis for `StratumAgentAdapter` and workflow-internal role agents (DDR-030 documents this boundary).

Remove global knowledge of step-role mappings from the generic execution boundary — role/output restrictions come from the `WorkflowStep` definition (`agent_role`, `output_artifact`).

## `src/agent-loop.ts`, `src/tools.ts`, `src/output-parser.ts`, `src/anthropic-provider.ts`

**Action:** preserve under the Stratum internal agent executor (`execution/stratum-agent/`). Execution implementation, not kernel logic.

## `src/llm-provider.ts`

**Action:** preserve as the lower-level provider utility for internal agent execution. Not the main cross-agent abstraction (that is `ExecutionAdapter`).

## `src/event-bus.ts`

**Action:** retain the WebSocket broadcasting code as a projector, placed behind the durable event store/subscription infrastructure (§14). Replace `payload: any` with typed/validated payloads for public events.

## `src/run-artifacts.ts`

**Action:** generalize. Split:

- structured run/step metadata → SQLite (StepExecution, run records);
- large/raw artifacts → `.sle/` artifact storage;
- workflow-specific manifest shape → the workflow layer (already spec'd: workflow-execution.md §Run artifacts).

## `src/confirm-service.ts`

**Action:** becomes a producer/consumer of generic Decisions: checkpoint resolution flows through `DecisionService` (§19.4) while keeping the DDR-031 resolve endpoint as the API.

## `src/scoping-service.ts`, `src/critic-agent.ts`, `src/sharding-service.ts`, `src/snapshot-service.ts`, `src/summarise-service.ts`

**Action:** move to the workflow layer (builtin definitions and their services). Sharding's generic child-WorkItem creation moves to `WorkService`; the software-specific decomposition logic stays with `full-build`.

## `src/context-manager.ts`

**Action:** evolve into the execution context service (§25). Remove the assumption that every execution is a run of the current project's main workflow.

## `src/exec-service.ts` / `src/exec-gate.ts`

**Action:** separate sandbox/process execution from validation/completion policy. Sandbox runtime → execution infrastructure. Validation results → `Evidence`.

## `src/discovery-service.ts`, `src/init-service.ts`

**Action:** project onboarding (control plane), not generic orchestration state.

## `src/intake-service.ts`

**Action:** reassess. Document ingestion/context preparation becomes a project-context service; development-specific coherence gates stay with the workflow.

## `src/link-index.ts`, `src/wikilink-parser.ts`

**Action:** keep optional, outside the kernel. Project knowledge/context service (§25).

## `src/rule-files.ts` / `src/rule-loader.ts`

**Action:** preserve schema/config discipline but separate:

- generic Stratum policy/config;
- workflow-level rules;
- executor-specific rules.

## `src/prompt-service.ts` / `src/prompt-templates.ts` / `src/tag-service.ts`

**Action:** workflow/prompt infrastructure and project knowledge (`#next-run` tags, DDR-028) — stay outside the kernel, consumed via workflow definitions (`prompt_template` references).

## `src/chat-service.ts`

**Action:** interface layer. Evolves toward the conversation.md model: chat router selects/dispatches workflows (`trigger.description` matching), which becomes a primary WorkItem creation path.

## `src/state-api.ts`, `src/daemon-config.ts`, `src/pid-file.ts`, `src/daemon.ts`

**Action:** `daemon.ts` shrinks drastically over time. Target responsibilities:

- create application container/dependencies;
- start HTTP server;
- start realtime projector;
- start scheduler/recovery loops;
- shutdown cleanly.

Business rules live in application/kernel modules. `state-api.ts` becomes a read-model projection over events.

## `public/*`

**Action:** keep as the prototype UI, redesigned around Needs You / Work / Projects / Activity rather than the current single-run mental model.

---

# 28. Migration strategy

Incremental strangler migration, not a rewrite. Phase status is tracked against the current tree (post-DDR-031 specs, `main` at `ee590eb`).

## Phase 0 — Freeze architectural direction — ✅ DONE

Completed by DDR-031 + this DDR:

- ~~add this architecture document to the repository~~ → this DDR;
- ~~explicitly mark current cycle/DAG as a methodology~~ → `full-build`/`draft-artifact` WorkflowDefinitions;
- ~~ADR for generic-kernel separation~~ → DDR-031;
- kernel laws → §3 of this DDR;
- "no new top-level lifecycle coupling" rule → reviewer checklist (Appendix B).

Exit criteria met at the spec level. Remaining code-level rule: no new feature is added directly to `src/cycle-runner.ts`/`src/dag-runner.ts` except migration/bugfix work.

## Phase 1 — Introduce generic domain contracts

### Goal

Create the control-plane vocabulary without changing current execution behavior.

### Add

- `Workspace`; `Project`; `Repository`; `Objective`; `WorkItem`; `StepExecution`; `Decision`; `Evidence`; `DomainEvent`;
- Zod schemas and schema versions.

Note: `WorkflowDefinition`, `WorkflowRun`, `WorkflowStep`, `ArtifactClaim`, `ArtifactVersion` already exist as spec'd types (DDR-031) — reference them; do not redefine.

### Do not add yet

- generic plugin system;
- distributed queue;
- Android;
- multiple remote workers.

### Tests

- schema round trips;
- invalid data rejected;
- version field required;
- entity relationship validation.

### Exit criteria

The domain model can represent one current Stratum workflow run (as a WorkItem → WorkflowRun → StepExecutions) without executing it.

## Phase 2 — Add SQLite storage and event log

### Goal

Durable multi-project state beside `.sle/`.

### Add

- DB migrations;
- repository interfaces;
- SQLite implementations;
- transactions;
- append-only domain events;
- artifact metadata table.

### Tables initially

```text
workspaces
projects
repositories
objectives
work_items
work_dependencies
step_executions
decisions
policies
evidence
artifacts
events
```

### Tests

- transaction rollback;
- unique/idempotency constraints;
- concurrency updates;
- restart persistence;
- event ordering.

### Exit criteria

A daemon restart preserves projects, work, decisions, events, and execution state without relying on process memory.

## Phase 3 — Generic WorkService + WorkItem state machine

### Goal

Make the generic work lifecycle authoritative.

### Add

- `WorkService`;
- the §9 guarded state machine;
- dependency checking;
- pause/resume/cancel;
- blocking/decision transitions;
- completion requirements abstraction.

### Critical invariants

- completed work cannot be executed again without explicit reopen/version behavior;
- cancelled work never dispatches;
- blocked dependencies prevent dispatch;
- agents cannot directly set work state;
- state changes emit durable events.

### Exit criteria

A dummy WorkItem moves through the lifecycle entirely through deterministic services.

## Phase 4 — Implement the DDR-031 step engine; run `full-build` on it

### Goal

Close the spec/code gap from DDR-031 and prove the methodology runs under generic work ownership.

### Work

- implement the generic step engine (step kinds, flow rules, iteration lifecycle, checkpoint protocol) per workflow-execution.md;
- bring `runtime-map.ts` to the post-DDR-031 map shape (`workflow_runs`, claims);
- register `full-build` and `draft-artifact` builtins;
- migrate the runner's per-stage branches into definitions + per-step bodies;
- map WorkItem → WorkflowRun lifecycle (§9 cross-layer table);
- mint `Decision(type: 'checkpoint')` on `awaiting_checkpoint`;
- emit generic work/step-execution events;
- delete `src/dag-runner.ts` and the methodology branches in `src/cycle-runner.ts`.

### Compatibility

Acceptable for this phase to keep `.sle/map.yaml` as the intra-project run store (it is the spec'd store).

### Exit criteria

A `WorkItem(workflowId='full-build')` executes the full lifecycle on the generic engine, with generic work/decision state visible through the new API, and `draft-artifact` runs as the lighter second workflow.

## Phase 5 — Executor abstraction + scheduler

### Goal

Decouple work orchestration from the internal agent implementation.

### Add

- `ExecutionAdapter` contract;
- executor registry;
- `StratumAgentAdapter` wrapping current AgentRunner;
- scheduler (§16);
- leases; retry caps; idempotency keys;
- per-project/repository concurrency controls.

### Then add exactly one external executor

Choose one of: Codex; Claude Code; DeepSeek Harness. Not all simultaneously.

### Exit criteria

The same generic work contract is executed by at least two executor implementations without changing kernel code.

## Phase 6 — GitHub + ci-toolkit evidence integration

### Goal

Close the autonomous code-change loop safely.

### Flow

```text
WorkItem
→ executor
→ branch/commit/PR
→ GitHub CI
→ ci-toolkit
→ evidence ingestion
→ completion policy
→ Decision (merge approval)
```

### Add

- GitHub repository adapter;
- stable references to repo/branch/commit/PR;
- CI evidence collector;
- ci-toolkit evidence collector;
- scope-diff evidence;
- completion policy.

### Security invariant

Executor self-report cannot satisfy independent review/CI evidence requirements.

### Exit criteria

A code-change WorkItem reaches `IN_REVIEW` only after external Git/CI/review evidence satisfies policy.

## Phase 7 — Attention-first API and web UI

### Goal

Make Stratum usable as a control plane rather than an engineering dashboard.

### API

Canonical endpoints for: attention; projects; objectives; work; decisions; runs; evidence; events (§23).

### UI

1. Needs You;
2. Work;
3. Projects;
4. Activity.

### Important rule

Do not expose every low-level event as top-level UI state.

### Exit criteria

The developer supervises multiple projects without reading raw agent output during normal operation.

## Phase 8 — Remote/mobile hardening

### Goal

Safe Android/web remote control.

### Add

- authentication; secure session/token model;
- TLS deployment configuration;
- remote authorization checks;
- notification service;
- audit logging for sensitive actions;
- Android client or packaged web client.

### Exit criteria

A phone can securely: see Needs You; resolve Decisions; pause/resume/redirect work; inspect concise project/work status; approve merge where policy permits; drill into evidence when needed.

---

# 29. Testing strategy

The kernel is tested more like a database/workflow engine than an LLM application.

## 29.1 Invariant tests

Mandatory examples:

- agent result cannot bypass policy;
- work cannot complete without mandatory evidence;
- decision-required policy prevents progression;
- duplicate events do not duplicate side effects;
- duplicate executor results do not create duplicate artifacts/PRs;
- cancelled work never dispatches;
- dependency cycles are rejected;
- orphaned execution recovery is deterministic;
- retry caps are enforced;
- executor failure cannot corrupt work state;
- evidence is bound to the correct commit/WorkItem;
- stale CI evidence cannot certify a newer commit;
- an artifact claim conflict rejects the second dispatch (already spec'd by DDR-031 — keep the test at kernel level too).

## 29.2 State-machine property tests

Given any legal state, verify:

- only enumerated transitions are possible;
- every transition preserves schema validity;
- terminal states behave correctly;
- recovery transitions do not silently skip requirements;
- WorkItem states never mirror WorkflowRun internals (§9 invariant).

## 29.3 Adapter contract tests

Every execution adapter passes a shared suite:

- accepts valid request;
- rejects unsupported capabilities;
- produces schema-valid result;
- timeout behavior;
- cancellation behavior where supported;
- malformed agent output is contained;
- no direct mutation of kernel state.

## 29.4 Integration tests

End-to-end fixture:

```text
Objective
→ WorkItem
→ WorkflowRun (dummy/external executor)
→ test Git repository
→ fake/real GitHub adapter
→ evidence
→ Decision
→ completion
```

Keep deterministic fake adapters so CI does not depend on paid model APIs.

---

# 30. Observability

Observability exists deeply without polluting the human control surface.

Record:

- execution duration;
- executor;
- token/cost use;
- retries;
- failure category;
- workflow + step;
- evidence latency;
- decision count;
- human wait time;
- scope expansion;
- PR outcome.

Useful future metrics:

```text
human interventions / completed work item
blocking decision rate
false escalation rate
agent retry rate
CI failure rate after agent completion
semantic review blocker rate
median objective-to-merge time
cost per merged PR
```

The most important system-level metric may eventually be:

> **How much trusted completed work is produced per unit of human attention?**

---

# 31. Anti-bloat rules

Enforced culturally and during reviews.

## 31.1 No abstraction before a second real use

No universal interface because a second provider *might* exist someday. Introduce it at two real implementations or a demonstrably stable boundary.

## 31.2 No microservices initially

One modular monolith.

## 31.3 No generic plugin runtime initially

Static workflow registration (DDR-031 builtins) + user YAML docs is enough.

## 31.4 No arbitrary policy language initially

Typed rules in code + structured config.

## 31.5 No distributed queue initially

SQLite-backed scheduler + worker leases until proven otherwise.

## 31.6 No graph database by default

Relational state and targeted indexes. Project knowledge/linking remains an optional subsystem.

## 31.7 No UI feature without an operator question

Every primary UI element answers a real question: What needs me? What is moving? What is blocked? What changed? Why is this safe to approve? If none — it belongs under Activity/details or should not exist.

## 31.8 Delete compatibility code aggressively

Every temporary compatibility layer has an owner, reason, removal condition, and ideally a tracking issue.

## 31.9 Avoid dumping-ground modules

No generic `utils`, `common`, `misc`, or `manager` modules as architectural junk drawers.

---

# 32. Rot prevention

Autonomous systems create code quickly, which increases the need for deliberate pruning.

Periodic architecture hygiene checks (quarterly or per milestone):

- unused workflow definitions;
- dead executor adapters;
- deprecated schema versions;
- unused event types;
- stale feature flags;
- compatibility layers whose migration is complete;
- duplicated policy rules;
- UI views no longer tied to operator decisions;
- obsolete project configuration.

The default action for dead abstractions is deletion, not indefinite preservation.

---

# 33. Versioning

Version long-lived contracts from the beginning:

- execution request/result;
- events;
- workflow definitions (already versioned per DDR-031 `WorkflowDefinition.version`);
- decision payloads;
- evidence payloads where external producers exist.

Do not version every internal function. Use explicit migrations for database schema and persisted contract changes.

---

# 34. What not to build yet

Explicitly out of initial scope:

- Kubernetes;
- multi-region deployment;
- generalized distributed workflow engine;
- dynamic third-party plugin marketplace;
- arbitrary user-written policy DSL;
- complex RBAC/organizations/teams;
- semantic vector database as a kernel dependency;
- dozens of agent providers;
- self-modifying workflow definitions;
- fully autonomous merging of high-risk changes;
- elaborate cost optimizer;
- advanced priority-learning scheduler;
- event sourcing as the sole state model;
- bespoke Android-only backend.

If one becomes necessary, it is introduced behind an existing boundary.

---

# 35. Recommended first end-to-end target

One concrete vertical slice:

```text
1. User creates objective
   "Fix scheduling race condition"

2. Stratum creates/accepts WorkItem (workflowId: draft-artifact
   or a small code-change workflow)

3. WorkItem enters READY

4. Scheduler dispatches; WorkflowRun created in the project

5. Executor edits an isolated branch/worktree

6. Executor creates commit/PR

7. GitHub CI runs

8. ci-toolkit reviews the PR

9. Stratum records independent Evidence

10. Completion engine evaluates policy

11. Needs You shows:

    Scheduling race condition
    Ready for merge

    ✓ CI passed
    ✓ semantic review clean
    ✓ acceptance criteria satisfied
    ✓ scope unchanged

    Risk: low

    [Merge] [Inspect]

12. User resolves the Decision (merge) per policy

13. WorkItem becomes COMPLETED
```

If the architecture supports this cleanly, the foundation for broader orchestration is correct.

---

# 36. Recommended implementation order inside the repository

A practical PR sequence:

### PR 1 — This DDR + control-plane domain contracts

- this document;
- generic domain schemas (§8);
- no behavior change.

### PR 2 — SQLite persistence

- migrations; repositories; event table; persistence tests.

### PR 3 — WorkItem state machine

- WorkService; transitions; dependency rules; events; invariant tests.

### PR 4 — Decision + evidence models

- DecisionService (incl. checkpoint minting/resolution wiring, dormant until Phase 4);
- EvidenceService;
- policy evaluation skeleton;
- no UI dependency.

### PR 5 — Step engine (DDR-031 implementation)

- generic StepKind engine per workflow-execution.md;
- post-DDR-031 map shape (`workflow_runs`, claims);
- workflow registry + `full-build`/`draft-artifact` builtins;
- checkpoint protocol.

### PR 6 — Run runner extraction

- migrate `src/cycle-runner.ts` per-stage branches into `full-build`;
- WorkItem ↔ WorkflowRun lifecycle mapping;
- delete `src/dag-runner.ts`.

### PR 7 — Executor contract

- `ExecutionAdapter`; wrap existing AgentRunner; shared executor tests.

### PR 8 — Scheduler + leases

- ready queue; concurrency limits; retries; orphan recovery.

### PR 9 — GitHub adapter

- repository/branch/commit/PR refs; idempotent PR creation/lookup.

### PR 10 — ci-toolkit evidence

- ingest CI/review status; commit binding; completion policy.

### PR 11 — Attention API

- `/attention`; decisions; work/project summaries.

### PR 12 — Redesigned web UI

- Needs You; Work; Projects; Activity.

Only after this does the Android client become a priority.

---

# 37. Definition of kernel stability

The kernel is mature when all of the following are true:

1. Kernel code contains no hard-coded software-development step names.
2. Kernel code contains no Claude/Codex/DeepSeek provider-specific logic.
3. Kernel code contains no GitHub-specific workflow assumptions.
4. Work survives daemon restart without agent memory.
5. Multiple projects and repositories coexist.
6. Multiple independent WorkItems run concurrently within configured limits.
7. Every state change is deterministic and recorded.
8. Every side-effecting external action has idempotency behavior.
9. Human-required policy cannot be bypassed by an executor.
10. Completion cannot occur without required evidence.
11. `full-build` runs as a `WorkflowDefinition` on the generic step engine. *(Spec: done, DDR-031. Code: Phase 4 exit criterion.)*
12. At least one lighter workflow (`draft-artifact`) runs through the same engine. *(Spec: done, DDR-031.)*
13. At least two execution adapters can execute compatible work.
14. The UI can be replaced without changing orchestration rules.
15. `ci-toolkit`/CI evidence can independently certify a code-change WorkItem.

---

# 38. Decisions we can make now

Defaults unless implementation evidence proves otherwise:

| Topic | Recommended decision |
|---|---|
| Rewrite vs evolve | Evolve Stratum incrementally |
| Architecture | Modular monolith |
| Database | SQLite |
| Large artifact storage | Filesystem (`.sle/`) initially |
| Kernel abstraction | WorkItem / WorkflowRun (DDR-031) / StepExecution / Decision / Policy / Evidence / Event |
| Current lifecycle | `full-build` and `draft-artifact` are builtin WorkflowDefinitions (DDR-031) |
| Workflow loading | YAML workflow docs + builtin registration — decided by DDR-031 |
| Executor abstraction | Higher-level `ExecutionAdapter` bound to StepExecution |
| Current AgentRunner | Preserved behind the Stratum executor adapter |
| Checkpoints vs Decisions | Checkpoint is the mechanism; Decision is the durable record (§19.4) |
| Events | Durable DB log + realtime projection; intra-run taxonomy per DDR-031 |
| UI | Attention-first, not agent-first |
| Remote clients | One canonical API |
| Android | After web/API semantics stabilize |
| GitHub | Adapter, not kernel dependency |
| ci-toolkit | Independent validation/evidence layer |
| Policy | Typed deterministic rules first |
| Queue | Internal scheduler/leases first |
| Microservices | No |
| Automatic high-risk merge | No |

---

# 39. Questions that should remain deliberately open

Do not prematurely lock these down:

1. Which external executor is integrated first: Codex, Claude Code, or DeepSeek Harness?
2. Whether chat-dispatched workflow runs get an explicit WorkItem, or an implicit one is auto-created (and how it appears in the Work view).
3. Whether Android is ultimately Flutter, native Kotlin, or a packaged web experience.
4. The exact remote worker protocol once execution moves beyond one machine.
5. Whether GitHub polling, webhooks, or a hybrid becomes the long-term evidence ingestion mechanism.
6. How much scope modeling is path-based versus architecture/semantic tags.
7. Whether the current link-index/context system remains valuable after the control-plane split.
8. When SQLite actually becomes a scaling limitation, if ever, for the expected personal/small-team workload.

These do not block the kernel migration. (The original draft's question "TS or declarative workflow definitions?" is closed — DDR-031 decided YAML skill-docs with builtin registration.)

---

# 40. Final target operating experience

The success criterion is not that Stratum can run many agents. It is that many agents can work without demanding constant human supervision.

A normal developer session:

```text
STRATUM

Needs You: 2

Kodeverket
Architecture decision required
Recommended: keep scheduling synchronous
[Approve] [Discuss]

Student Platform
PR ready for merge
✓ CI
✓ semantic review
✓ scope
Risk: low
[Merge] [Inspect]

--------------------------------

Active work: 8
Projects healthy: 3/3
No critical failures
```

The raw reality underneath includes dozens of runs, retries, tool calls, commits, context packs, tests, and model interactions. That complexity remains available for audit and debugging, but it is not the developer's normal interface.

The architectural objective:

> **Increase autonomous engineering throughput while decreasing the amount of system state the human must personally track.**

Stratum already contains many of the required primitives, and its spec set already defines the generic workflow engine. The correct next step is not to add more lifecycle features. It is to implement the spec'd engine, extract and stabilize the orchestration kernel above it, add the control plane, and connect it to independent Git/CI evidence and an attention-first interface.

---

# Appendix A — Source baseline reviewed

This DDR was reworked from the untracked draft `STRATUM_CONTROL_PLANE_MIGRATION.md`, which was derived from branch `claude/vigilant-allen-wxa1nf` **before** the DDR-031 spec generalization landed. The rework aligns that draft with the post-DDR-031 spec set (baseline: `main` at `ee590eb`).

Reviewed with particular attention to:

- `README.md`
- `src/state-machine.ts`
- `src/runtime-map.ts`
- `src/dag-runner.ts`
- `src/cycle-runner.ts`
- `src/agent-runner.ts`
- `src/llm-provider.ts`
- `src/event-bus.ts`
- `src/confirm-service.ts`
- `src/run-artifacts.ts`
- `src/daemon.ts`
- `docs/developmentPlan/implementation-tracking.md`
- `docs/developmentPlan/spec-divergence-audit.md`
- the DDR-031 spec set (types.md, workflow-execution.md, workflow-authoring.md, step-kind-reference.md, map-yaml-schema.md, websocket-events.md)
- current test tree

The plan distinguishes **implemented behavior worth preserving**, **spec-decided behavior awaiting implementation** (DDR-031), and **new control-plane scope** (this DDR).

---

# Appendix B — Architecture review checklist for future PRs

For every meaningful Stratum PR during this migration, reviewers ask:

- Does this logic belong to the kernel, a workflow, an adapter, storage, or UI?
- Is a model/provider detail leaking into the kernel?
- Is a GitHub-specific assumption leaking into generic work semantics?
- Is software-development methodology being hard-coded into orchestration?
- Is durable state being placed inside an agent/session instead of Stratum?
- Does this introduce a new core noun/concept? If so, why is it necessary?
- Is a new abstraction backed by more than one real use?
- Is a side effect idempotent?
- Is the state transition explicit and testable?
- Is completion supported by independent evidence?
- Can policy deny/escalate the action independently of the agent?
- Will this survive restart/crash/retry?
- Does this create compatibility code? What is its removal condition?
- Does this increase what the developer must monitor manually?
- Is the word "run" unqualified anywhere it should be `WorkflowRun` or `StepExecution`?

If a change makes the kernel more intelligent but less deterministic, it receives extra scrutiny.



