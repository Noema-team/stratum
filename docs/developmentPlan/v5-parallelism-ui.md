# Vertical Slice 5: Critic, Intake Pipeline & WebSocket Events

**Type:** implementation plan · **Status:** complete · **Updated:** 2026-05-26
**Slice:** v5 · **Prerequisites:** VS4 Complete (Docker execution pool, Link Index, standard REST API)

---

## Implementation Progress

| Phase | Component | Status | Commit |
|-------|-----------|--------|--------|
| A | Critic Agent Integration |  Complete | `3b8b4657` |
| B | Document Intake + Coherence Gate |  Complete | `f9efdf05` |
| C | Task Sharding + SHARDING_APPROVAL |  Complete | `02145330` |
| D | WebSocket Event Bus |  Complete | `20a1f421` |
| E | Integration Tests |  Complete | `44b1feb` |

---

## 1. Overview

### What this slice delivers

After VS5, the system can:

1. Run the Critic agent at `deep`/`research` planning depth — reviewing Designer output and feeding structured critique back for revision before the PLAN node
2. Parse free-floating project documents into structured `IntakeDocument` records with section-level metadata
3. Run a deterministic coherence gate (3 layers) that checks document consistency, task independence, and runtime staleness
4. Decompose work into sharded tasks via collaborative sharding with human approval at the `SHARDING_APPROVAL` DAG node
5. Switch the context manager from inferred mode to declared mode when tasks carry `TaskContextDeclaration`
6. Broadcast the full WebSocket event catalogue (62 events across 14 groups) to connected clients in real-time

### Why this structure

VS4 built the execution infrastructure (Docker containers, validation, link index, context budgeting). VS5 activates the intelligence layer: the Critic agent improves design quality at higher planning depths, and the intake pipeline transforms documents into precisely scoped tasks with explicit context declarations. The WebSocket event bus ties everything together for real-time observability.

The Critic and intake pipeline are independent systems but share a dependency on the DAG runner modifications. The WebSocket bus is a cross-cutting concern that activates events from all prior slices.

### Deliberate deferrals

| Item | Why deferred | Where it goes |
|---|---|---|
| Explorer agent | Conditional trigger from SCOPING; not on critical path | VS6 |
| Chat / facilitator decision mode | Orthogonal to Critic + intake | VS6 |
| Knowledge engine (Cognee) | Large external dependency | Post-MVP |
| UI Shell / dashboard | Separate concern; WebSocket events prepare the surface | VS6 |
| BeadsTaskStore (full implementation) | Requires `bd` CLI; LocalTaskStore sufficient | Post-MVP |
| Tier 3 semantic links | Requires Cognee | Post-MVP |
| Layer 3 runtime coherence (file watcher) | Requires long-running daemon + file watcher | Post-MVP |

### Scope summary

| In scope | Out of scope |
|---|---|
| Critic agent at deep/research depth | Explorer agent |
| CritiqueResult with blocking/warnings/suggestions | Chat mode, facilitator decision mode |
| Critic feedback loop (Designer → Critic → Designer revise) | Knowledge engine |
| Document intake (parse, index, promote from `.sle/project-docs/`) | UI Shell |
| Coherence gate Layer 1 (document coherence) | BeadsTaskStore full implementation |
| Coherence gate Layer 2 (task coherence during sharding) | File watcher (runtime coherence) |
| Task sharding (collaborative decomposition) | Cognee semantic links |
| SHARDING_APPROVAL DAG node (human checkpoint) | Obsidian plugin |
| TaskContextDeclaration + declared context mode | CI/CD hooks |
| Task creation in LocalTaskStore | |
| Link index update (structural_declaration links) | |
| Full WebSocket event catalogue (62 events) | |
| Client-to-daemon WebSocket commands | |

### Estimated complexity

| Component | Effort | Risk |
|---|---|---|
| Critic agent + feedback loop | High | Medium (LLM prompt, pass limit logic) |
| Document intake + coherence gate | High | Medium (deterministic checks, cross-reference resolution) |
| Task sharding + SHARDING_APPROVAL | High | Medium (collaborative flow, Layer 2 checks) |
| Declared context mode | Medium | Low (resolves existing SliceRule infrastructure) |
| WebSocket event bus | Medium | Low (well-defined event catalogue) |

---

## 2. Dependency Map

```
External spec dependencies (this slice consumes):
  dag-node-reference.md     CRITIQUE node (node 3), SHARDING_APPROVAL node (6), activation conditions
  intake-and-sharding.md    6-step pipeline, IntakeDocument, CoherenceReport, ShardingProposal, TaskContextDeclaration
  daemon-api.md             WebSocket events, client commands, connection lifecycle
  context-manager.md        Declared mode, TaskContextDeclaration resolution
  document-linking.md       structural_declaration auto-links, document promotion
  validation.md             CategoryResult types used in context declarations
  types.md                  ArtifactRef, TaskContextDeclaration, SLETask, TaskStore

This slice produces (consumed by VS6+):
  VS6: UI Shell consuming WebSocket events, Explorer agent
  Post-MVP: BeadsTaskStore, Cognee, file watcher (runtime coherence)
```

```
Dependency flow within this slice:

  Phase A (Critic Agent)                ← independent (modifies dag-runner.ts)
    |
    v
  Phase B (Document Intake + Coherence)  ← independent of A
    |
    v
  Phase C (Task Sharding + SHARDING_APPROVAL) ← depends on B (intake produces documents)
    |                                         depends on A (critic may run in same cycle)
    v
  Phase D (WebSocket Event Bus)          ← depends on A+B+C (emits events from all)
    |
    v
  Phase E (Integration Tests)            ← depends on all phases
```

---

## 3. Implementation Phases

### Phase A: Critic Agent Integration

**Spec reference:** `dag-node-reference.md` §Node 3 — CRITIQUE
**Implements:** Critic agent that reviews Designer output at deep/research depth, with structured feedback loop and pass limits.

#### Types

```typescript
interface CritiqueResult {
  blocking_issues: string[]
  warnings: string[]
  suggestions: string[]
  pass: boolean
}
```

#### Activation rule

```
depth = minimal | standard → skip CRITIQUE, proceed to PLAN
depth = deep                → 1 Critic pass after Designer
depth = research            → multiple Critic passes (up to pass limit)
```

#### Critic inputs

- `doc:architecture` + `doc:requirements` (Designer's output)
- Project context + decisions
- `doc:evaluation` (prior cycle, if exists)

#### Critic outputs

- `doc:cycle-critique` — per-cycle structured critique fed back to Designer (run-scoped, ephemeral)
- At `deep`/`research`: also writes `doc:critique-report` (project-scoped, persistent design review)

#### Feedback loop

```
Designer draft → Critic → blocking issues found → Designer revises
→ Critic re-reviews → ... → all clear (or pass limit) → proceed to PLAN
```

#### Pass limits

| Depth | Max critic passes | Behavior at limit |
|---|---|---|
| `standard` / `minimal` | 0 | CRITIQUE skipped entirely |
| `deep` | 1 | One critique pass. If issues remain, they become warnings and cycle proceeds. |
| `research` | 3 | Up to 3 passes. After limit, blocking issues become warnings. |

**Key constraint:** The Critic is advisory at the system level. If the Critic itself errors (LLM failure), the cycle proceeds without critique — a warning is logged.

#### DAG runner modifications

```typescript
// In dag-runner.ts:
// After DESIGN node completes:
if (planning_depth === 'deep' || planning_depth === 'research') {
  currentNode = 'CRITIQUE'
  // After CRITIQUE: if CritiqueResult.pass === false AND passes < limit:
  //   route back to DESIGN with critique injected
  // After CRITIQUE: if pass OR limit reached:
  //   proceed to PLAN (warnings logged but non-blocking)
}
```

#### Context for Designer revision

When the Critic returns `pass: false`, the Designer receives:
- Original context (unchanged)
- `doc:cycle-critique` injected as an additional artifact slice
- Task instruction: "Revise architecture and requirements to address the following critique"

**Acceptance criteria:**
- CRITIQUE node skipped at `minimal` and `standard` depth (status: `skipped`, reason: `depth`)
- CRITIQUE activated at `deep` depth: 1 critic pass
- CRITIQUE activated at `research` depth: up to 3 passes
- Blocking issues cause Designer revision loop
- Pass limit enforcement: after limit, blocking issues become warnings
- Critic LLM failure → cycle proceeds without critique (warning logged)
- `doc:cycle-critique` written to run artifacts
- `doc:critique-report` written at deep/research (project-scoped)
- DAG manifest records CRITIQUE node with pass count

**Tests needed:**
- Unit: CRITIQUE skipped at `minimal` depth
- Unit: CRITIQUE skipped at `standard` depth
- Unit: CRITIQUE activated at `deep` depth — 1 pass
- Unit: CRITIQUE activated at `research` depth — up to 3 passes
- Unit: CritiqueResult.pass = true → proceed to PLAN immediately
- Unit: CritiqueResult.pass = false, passes < limit → Designer revision
- Unit: CritiqueResult.pass = false, passes = limit → warnings logged, proceed to PLAN
- Unit: Critic LLM failure → warning logged, proceed to PLAN
- Unit: `doc:cycle-critique` written to run artifacts
- Unit: `doc:critique-report` written at deep depth
- Unit: Designer receives critique as additional context slice on revision
- Integration: deep depth cycle — DESIGN → CRITIQUE → (revise) → DESIGN → CRITIQUE → PLAN

**Target: ~14 tests (11 unit + 3 integration)**

---

### Phase B: Document Intake + Coherence Gate

**Spec reference:** `intake-and-sharding.md` §Pipeline steps 1–2, §Data model
**Implements:** Document parsing from `.sle/project-docs/`, section extraction, coherence checking.

#### Types

```typescript
interface IntakeDocument {
  id: string
  filename: string
  title: string
  description: string
  tags: string[]
  status: 'ungraphed' | 'promoted' | 'superseded'
  source: 'user' | 'sle_suggested'
  version: number
  sections: DocumentSection[]
  last_modified: string
  promoted_to_node?: string
}

interface DocumentSection {
  id: string
  heading: string
  tokens: number
  anchor: string
}

interface CoherenceReport {
  status: 'clean' | 'flagged' | 'blocked'
  findings: CoherenceFinding[]
  document_count: number
  checked_at: string
}

interface CoherenceFinding {
  type: 'contradiction' | 'undefined_reference' | 'terminology_conflict' | 'missing_document'
  severity: 'blocking' | 'warning'
  document_a: string
  document_b?: string
  section_a?: string
  section_b?: string
  description: string
}
```

#### Pipeline step 1 — Document intake

When the intake pipeline activates (inline within PLAN node, or standalone `sle intake`), the daemon scans `.sle/project-docs/`:

1. Read each file
2. Derive `id` from filename (slugify, strip extension)
3. Extract `title` from first `#` heading
4. Parse `sections` by walking `##` headings, estimate tokens per section
5. Write metadata to sidecar JSON
6. Set `status` to `ungraphed`

#### Document promotion

When a document enters a cycle's context:

1. Create a document node at `doc:{id}` in the project graph
2. Set `IntakeDocument.status` to `promoted`
3. Set `promoted_to_node` to the new node ID
4. All downstream nodes auto-link back to the document
5. Document receives backlinks from referencing nodes

Promotion is automatic on use. Not manual.

#### Pipeline step 2 — Coherence gate (Layer 1)

Deterministic static analysis — no LLM calls. Runs before any task is created.

**Checks:**

| Check | Description |
|---|---|
| Cross-reference integrity | Every entity mentioned in one document that is defined in another has a matching definition |
| Terminology consistency | Same concept not referred to by different names across documents |
| Contradiction detection | A decision in Document A does not directly contradict a constraint in Document B |
| Completeness | Documents required by the planned task scope exist and are non-empty |
| Dangling references | No document references a section, entity, or document that does not exist |

Each check produces `CoherenceFinding` entries. Overall status:

```
if any finding has severity 'blocking':  status = 'blocked'
elif any finding has severity 'warning':  status = 'flagged'
else:                                     status = 'clean'
```

**Gate flow:**

```
Document intake → Coherence checker
  clean → proceed to sharding
  flagged → present to user → acknowledge or resolve → proceed
  blocked → user must resolve → re-run checker
```

Coherence report written to `.sle/coherence-report.json` regardless of outcome.

#### Deployment modes

| Trigger | Mode | Intake runs? | Context mode |
|---|---|---|---|
| `sle start` + docs in `project-docs/` | Inline (auto) | Yes, within PLAN node | Declared after approval |
| `sle start --intake` | Forced | Yes, within PLAN node | Declared after approval |
| `sle start --no-intake` | Bypassed | No | Inferred |
| `sle start` + no docs | Bypassed (auto) | No | Inferred |
| `sle intake` standalone | Pre-prime | Yes, dedicated session | N/A |

**Acceptance criteria:**
- `.sle/project-docs/` scanned, `IntakeDocument` records created for each file
- Title extracted from first `#` heading
- Sections parsed from `##` headings with token estimates
- Documents start as `ungraphed`, promoted to `promoted` on first use
- Coherence gate runs 5 deterministic checks
- `blocked` findings halt pipeline until resolved
- `flagged` warnings shown but do not halt (user acknowledges)
- `clean` reports proceed automatically
- Coherence report persisted to `.sle/coherence-report.json`
- Document promotion creates link index entries
- Bypassed mode skips intake entirely

**Tests needed:**
- Unit: document parsing — title from `#`, sections from `##`
- Unit: document parsing — token estimation per section
- Unit: document ID derived from filename (slugify)
- Unit: promotion — `ungraphed` → `promoted` on first use
- Unit: promotion — creates link index entry
- Unit: coherence: cross-reference integrity check
- Unit: coherence: terminology consistency check
- Unit: coherence: contradiction detection
- Unit: coherence: completeness check
- Unit: coherence: dangling reference check
- Unit: coherence status derivation (clean/flagged/blocked)
- Unit: blocked finding halts pipeline
- Unit: flagged warning proceeds after acknowledge
- Integration: full intake flow (scan → parse → coherence → report)
- Integration: standalone intake (`sle intake`)

**Target: ~16 tests (13 unit + 3 integration)**

---

### Phase C: Task Sharding + SHARDING_APPROVAL

**Spec reference:** `intake-and-sharding.md` §Pipeline steps 3–6, `dag-node-reference.md` §Node 6 — SHARDING_APPROVAL
**Implements:** Collaborative task decomposition, Layer 2 coherence, human approval gate, task creation, link index update, declared context mode.

**Depends on:** Phase B (intake produces documents; sharding operates on them)

#### Types

```typescript
interface ShardingProposal {
  tasks: SLETask[]
  total_estimated_tokens: number
  coherence_report: CoherenceReport
  approved_by_user: boolean
  approved_at?: string
}

interface SLETask {
  id: string
  title: string
  description: string
  status: 'open' | 'in_progress' | 'blocked' | 'closed'
  priority: number
  dependencies: string[]
  context_declarations?: TaskContextDeclaration[]
  created_at: string
  updated_at: string
  stale?: boolean
}

interface TaskContextDeclaration {
  task_id: string
  slices: ArtifactRef[]
  intent: string
}
```

#### Pipeline step 3 — Task sharding

Collaborative: Planner proposes, user reviews, both iterate until correct.

**Sharding rules:**

| Rule | Description |
|---|---|
| One implementation target per task | Each task owns exactly one scope — a file, module, or endpoint |
| Sections over whole files | Context declarations prefer `doc:{key}#{section}` over `doc:{key}` |
| Token budget awareness | Sum of declared context tokens must fit in ~2000 token budget |
| Explicit dependencies | If Task B needs Task A's output, declare in `dependencies[]` |
| Acceptance criteria verifiable | Each criterion checkable by Tester agent (pass/fail) |

**Sharding flow:**

```
Coherence gate passes → Planner proposes task decomposition
  → Layer 2 coherence check on proposed tasks
    all pass → proceed to SHARDING_APPROVAL
    any fail → Planner revises → re-check (loop)
```

#### Layer 2 coherence (task coherence)

| Check | Description |
|---|---|
| Independence | Task can complete without needing parallel task output |
| Declared context completeness | Every needed document section listed in `TaskContextDeclaration` |
| No duplicate scope | Two tasks don't claim same implementation target |
| Boundary clarity | Unambiguous when task is done |
| Acceptance verifiability | Each criterion checkable by Tester agent |

Tasks that fail Layer 2 are returned to sharding for revision.

#### Pipeline step 4 — SHARDING_APPROVAL

DAG placement: `... → PLAN → TEST → SHARDING_APPROVAL → CONFIRM → BUILD → ...`

Only activates when Planner produced a sharding proposal. Skipped in bypassed mode.

**Approval flow:**

1. Planner produces `ShardingProposal`
2. Daemon sets `cycle.awaiting_sharding_approval = true`
3. Facilitator presents proposal to user
4. User actions:

| Action | Effect |
|---|---|
| Approve | Create tasks in TaskStore, update link index, clear flag, proceed to CONFIRM |
| Reject | Clear flag, proceed to CONFIRM without sharding. Planner re-plans as single task. |
| Modify | Revise proposal (add/remove/edit tasks), re-present at SHARDING_APPROVAL |

#### Pipeline step 5 — Task creation

On approval, each `SLETask` is persisted via `TaskStore.createTask()`. Dependencies wired via `TaskStore.addDependency()`.

In `LocalTaskStore`: writes to `.sle/tasks.yaml`:
```yaml
tasks:
  - id: task-implement-jwt-auth
    title: "Implement JWT validation middleware"
    description: "..."
    status: open
    priority: 1
    dependencies: []
    context_declarations:
      - task_id: task-implement-jwt-auth
        slices: ["doc:requirements", "doc:architecture", "node:auth:implementation"]
        intent: "Implement JWT validation middleware..."
    created_at: "2026-04-22T10:00:00Z"
    updated_at: "2026-04-22T10:00:00Z"
```

#### Pipeline step 6 — Link index update

After task creation, structural backlinks injected into link index:

```
for each slice in declaration.slices:
  linkIndex.addLink(source: task.id, target: slice, type: 'structural_declaration')
```

#### Declared context mode

When tasks carry `TaskContextDeclaration`, the context manager switches from inferred to declared mode:

```
resolveMode(task?, role):
  if task exists AND task.context_declarations is not empty:
    return 'declared'
  else:
    return 'inferred'
```

In declared mode:
- Load declared refs from `TaskContextDeclaration.slices`
- No inference, no role-based defaults
- Declared sections are not truncated (budget permitting)
- If declared slices exceed budget: truncate in source_weight order, log warning

#### Staleness tracking

When a document is modified after tasks reference it:

```
onDocumentModified(documentId):
  affected = taskStore.getTasksReferencing(documentId)
  for each task in affected:
    task.stale = true
```

Stale tasks are not dispatched until user clears the flag.

#### REST endpoints (Phase C)

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/v2/intake` | Run intake pipeline (standalone) |
| `GET` | `/api/v2/intake/coherence` | Get coherence report |
| `POST` | `/api/v2/intake/coherence/resolve` | Resolve a blocking finding |
| `GET` | `/api/v2/intake/sharding` | Get sharding proposal |
| `PATCH` | `/api/v2/intake/sharding` | Modify sharding proposal |
| `POST` | `/api/v2/intake/sharding/approve` | Approve sharding proposal |
| `POST` | `/api/v2/intake/sharding/reject` | Reject sharding proposal |
| `GET` | `/api/v2/intake/documents` | List intake documents |
| `POST` | `/api/v2/intake/documents/:id/promote` | Promote document |
| `GET` | `/api/v2/intake/taskstore` | Get TaskStore status |
| `POST` | `/api/v2/cycles/current/shards/approve` | Approve at SHARDING_APPROVAL gate |
| `POST` | `/api/v2/cycles/current/shards/reject` | Reject at SHARDING_APPROVAL gate |

**Acceptance criteria:**
- Planner produces `ShardingProposal` with `SLETask[]` entries
- Layer 2 coherence checks all 5 rules on proposed tasks
- Tasks failing Layer 2 returned to Planner for revision
- SHARDING_APPROVAL gate sets `awaiting_sharding_approval = true`
- Approve: tasks created in LocalTaskStore, link index updated, flag cleared
- Reject: flag cleared, no tasks created, Planner re-plans as single task
- Modify: proposal revised, Layer 2 re-checked, re-presented
- Declared context mode resolves `TaskContextDeclaration.slices`
- Staleness tracking flags tasks when referenced documents change
- All 12 new REST endpoints return correct response shapes
- Flag exclusivity: `awaiting_sharding_approval` and `awaiting_confirmation` mutually exclusive

**Tests needed:**
- Unit: sharding rule enforcement (one target per task, sections over files, budget)
- Unit: Layer 2 coherence — independence check
- Unit: Layer 2 coherence — context completeness
- Unit: Layer 2 coherence — no duplicate scope
- Unit: Layer 2 coherence — boundary clarity
- Unit: Layer 2 coherence — acceptance verifiability
- Unit: Layer 2 fail → Planner revision loop
- Unit: SHARDING_APPROVAL approve → tasks created in LocalTaskStore
- Unit: SHARDING_APPROVAL reject → no tasks, flag cleared
- Unit: SHARDING_APPROVAL modify → proposal revised, re-checked
- Unit: flag exclusivity (awaiting_sharding_approval vs awaiting_confirmation)
- Unit: declared mode resolves TaskContextDeclaration.slices
- Unit: declared mode does not truncate declared sections (budget permitting)
- Unit: staleness tracking flags tasks on document modification
- Unit: link index updated with structural_declaration links on task creation
- Integration: full sharding flow (coherence → proposal → approve → tasks → links)
- Integration: SHARDING_APPROVAL in cycle context (PLAN → TEST → SHARDING_APPROVAL → CONFIRM)
- Integration: reject → Planner re-plans as single task

**Target: ~20 tests (15 unit + 5 integration)**

---

### Phase D: WebSocket Event Bus

**Spec reference:** `daemon-api.md` §WebSocket events, `websocket-events.md` (complete catalogue)
**Implements:** Full event broadcasting, client commands, connection lifecycle.

**Depends on:** Phases A+B+C (events emitted from Critic, intake, sharding)

#### Event format

All events are JSON. Dotted event names. Flat envelope.

```typescript
interface SLEEvent<T = unknown> {
  type: string
  cycle?: string
  iteration?: number
  timestamp: string
  payload: T
}
```

#### Event groups (62 server-to-client events)

| Group | Events | Count |
|---|---|---|
| System lifecycle | `system.state_changed`, `system.ready`, `system.shutdown` | 3 |
| DAG execution | `cycle.started`, `cycle.completed`, `cycle.halted`, `cycle.iteration_started`, `node.started`, `node.completed` | 6 |
| Validation | `validation.category.started`, `validation.category.completed`, `gate.result` | 3 |
| Gates & actions | `approval.required`, `action.required` | 2 |
| Chat | `chat.message`, `chat.decision_captured`, `chat.session_changed` | 3 |
| Run artifacts | `run.artifact_written`, `run.manifest_ready`, `run.context_pack_ready` | 3 |
| Artifacts | `artifact.updated` | 1 |
| Errors | `error` | 1 |
| Init / Discovery | `init.step_completed`, `init.complete`, `discovery.round_started`, `discovery.draft_ready`, `discovery.round_approved`, `discovery.complete` | 6 |
| Intake / sharding | `intake.coherence_checked`, `intake.sharding_proposed`, `intake.sharding_approved`, `intake.sharding_rejected`, `intake.document_promoted`, `intake.task_stale` | 6 |
| Job dispatch | `dispatch.started`, `dispatch.job_status_changed`, `dispatch.static_gate_passed`, `dispatch.static_gate_failed`, `dispatch.category_completed`, `dispatch.completed`, `dispatch.worker_status_changed` | 7 |
| Task / store | `task.claimed`, `task.resolved`, `task.comment_added`, `task.stale_detected`, `task_store.sync` | 5 |
| Document linking | `link.created`, `link.deleted`, `link.index_rebuilt`, `link.index_updated`, `link.file_updated` | 5 |
| Content & modules | `content.written`, `content.deleted`, `module.triggered`, `module.completed`, `module.failed`, `module.registered` | 6 |

#### Client-to-daemon commands (WebSocket)

```typescript
{ type: "approval.respond", gate: string, decision: "approve" | "reject", message?: string }
{ type: "categories.confirm", categories: string[] }
```

#### Connection lifecycle

```
1. Client connects to ws://localhost:7700/events
2. Daemon sends system.ready event (current state snapshot)
3. Daemon sends buffered events since client's last connection (if reconnect)
4. Client subscribes to event stream
5. Daemon pushes all subsequent events
6. Client may send commands
7. On disconnect → client removed from broadcast list
8. No event buffering after disconnect — fire-and-forget
```

#### Concurrent client handling

Multiple clients may connect simultaneously. All receive all events. REST commands serialized (409 `session_conflict` on concurrent state changes). Read endpoints never blocked.

#### Event routing

Events are emitted at specific points in the daemon:

| Event | Emitted by |
|---|---|
| `cycle.started` | CycleService.start() |
| `node.started` / `node.completed` | DAGRunner.runNode() |
| `validation.category.*` | ValidationEngine (Phase B of VS4) |
| `gate.result` | ValidationGateService |
| `dispatch.*` | DockerWorkerPool (Phase A of VS4) |
| `intake.*` | IntakeService (Phase B+C of VS5) |
| `link.*` | LinkIndex (Phase C of VS4) |
| `system.*` | Daemon lifecycle |

**Acceptance criteria:**
- EventBus class manages client connections and broadcasts
- All 62 event types emitted at correct daemon operation points
- Events use dotted format (`cycle.started`, `dispatch.job_status_changed`)
- Client-to-daemon commands processed (`approval.respond`, `categories.confirm`)
- Multiple clients receive all events simultaneously
- `system.ready` sent on client connect
- Disconnected clients removed from broadcast list (no buffering)
- Concurrent state-changing commands return 409
- Event payloads match spec schema for each event type
- Events correlated with REST request_id when triggered by REST call

**Tests needed:**
- Unit: EventBus — client connect → receives `system.ready`
- Unit: EventBus — broadcast to multiple clients
- Unit: EventBus — client disconnect → removed from list
- Unit: event format — dotted name, flat envelope, ISO timestamp
- Unit: client command `approval.respond` → processed
- Unit: client command `categories.confirm` → processed
- Unit: concurrent state change → 409 `session_conflict`
- Integration: `cycle.started` event emitted on POST /cycles/start
- Integration: `node.started` / `node.completed` emitted during DAG execution
- Integration: `dispatch.*` events emitted during EXEC node
- Integration: `intake.*` events emitted during intake pipeline
- Integration: `gate.result` emitted after validation gate evaluation

**Target: ~15 tests (7 unit + 8 integration)**

---

### Phase E: Integration Tests

**Spec reference:** Cross-cutting (all above phases)
**Implements:** End-to-end acceptance tests for VS5.

**Test scenarios:**

| Test | Description | Expected |
|---|---|---|
| VS5-INT-01 | Deep depth cycle: DESIGN → CRITIQUE → (revise) → DESIGN → CRITIQUE → PLAN → ... | Cycle completes, 2 CRITIQUE passes recorded |
| VS5-INT-02 | Standard depth cycle: CRITIQUE skipped | CRITIQUE status: `skipped`, reason: `depth` |
| VS5-INT-03 | Intake pipeline: documents → coherence → sharding → approve → tasks | Tasks in LocalTaskStore, link index updated |
| VS5-INT-04 | Intake pipeline: coherence blocked → resolve → proceed | Pipeline halts, then proceeds after resolution |
| VS5-INT-05 | SHARDING_APPROVAL in cycle: PLAN → TEST → SHARDING_APPROVAL → approve → CONFIRM | Flag set/cleared correctly, tasks created |
| VS5-INT-06 | SHARDING_APPROVAL reject → Planner re-plans as single task | No tasks in store, cycle continues |
| VS5-INT-07 | Declared context mode: task with TaskContextDeclaration | Context assembled from declared slices, not role defaults |
| VS5-INT-08 | WebSocket: full event stream for a cycle with intake | All relevant events received by client |

**Mock strategy:**
- LLM: `NodeAwareMockLLM` from VS3, extended with Critic responses
- Docker: Mock worker pool from VS4
- File system: Real temp directory

**Target: ~8 integration tests**

---

## 4. Types Inventory

### Critic types (Phase A)

```typescript
interface CritiqueResult {
  blocking_issues: string[]
  warnings: string[]
  suggestions: string[]
  pass: boolean
}
```

### Intake types (Phase B)

```typescript
interface IntakeDocument { ... }
interface DocumentSection { ... }
interface CoherenceReport { ... }
interface CoherenceFinding { ... }
```

### Sharding types (Phase C)

```typescript
interface ShardingProposal { ... }
interface SLETask { ... }
interface TaskContextDeclaration { ... }
```

### WebSocket types (Phase D)

```typescript
interface SLEEvent<T = unknown> { ... }
```

---

## 5. API Endpoint Inventory

### New endpoints added in VS5

| Method | Path | Response 200 | Error codes |
|---|---|---|---|
| `POST` | `/intake` | `APIResponse<IntakeResult>` | 409: `session_conflict` |
| `GET` | `/intake/coherence` | `APIResponse<CoherenceReport>` | 404: `no_coherence_report` |
| `POST` | `/intake/coherence/resolve` | `APIResponse<CoherenceReport>` | 404: `finding_not_found`, 409: `finding_not_blocking` |
| `GET` | `/intake/sharding` | `APIResponse<ShardingProposal>` | 404: `no_sharding_proposal` |
| `PATCH` | `/intake/sharding` | `APIResponse<ShardingProposal>` | 400: `invalid_proposal` |
| `POST` | `/intake/sharding/approve` | `APIResponse<{ tasks_created: number }>` | — |
| `POST` | `/intake/sharding/reject` | `APIResponse<{ rejected: true }>` | — |
| `GET` | `/intake/documents` | `APIResponse<{ documents: IntakeDocument[] }>` | — |
| `POST` | `/intake/documents/:id/promote` | `APIResponse<{ document, node_id }>` | 404: `document_not_found` |
| `GET` | `/intake/taskstore` | `APIResponse<{ provider, tasks_count, stale_count, ready_count }>` | — |
| `POST` | `/cycles/current/shards/approve` | `APIResponse<{ approved_at }>` | 409: `not_awaiting_sharding_approval` |
| `POST` | `/cycles/current/shards/reject` | `APIResponse<{ rejected_at }>` | 409: `not_awaiting_sharding_approval` |

**Total new VS5 endpoints: 12**
**Cumulative total (VS1–VS5): 53 of 85 endpoints (~62%)**

---

## 6. Test Strategy

### Unit tests per phase

| Phase | Test count (est.) | Key test areas |
|---|---|---|
| A: Critic Agent | ~14 | Activation rules, feedback loop, pass limits, LLM failure handling |
| B: Document Intake + Coherence | ~16 | Document parsing, promotion, 5 coherence checks, gate flow |
| C: Task Sharding + SHARDING_APPROVAL | ~20 | Sharding rules, Layer 2 coherence, approval flow, declared mode, staleness |
| D: WebSocket Event Bus | ~15 | EventBus, event format, client commands, concurrent access |
| E: Integration Tests | ~8 | Full cycle with Critic, intake, sharding, WebSocket |

**Total estimated: ~73 new tests**
**Cumulative with VS1–VS4 (~430 tests): ~503 tests**

---

## 7. File Inventory

New files created in this slice:

```
src/
  critic-agent.ts              Phase A — Critic agent, CritiqueResult, feedback loop
  intake-service.ts            Phase B — Document parsing, coherence gate, document promotion
  sharding-service.ts          Phase C — Task sharding, SHARDING_APPROVAL gate, task creation
  event-bus.ts                 Phase D — EventBus, client management, broadcast
  dag-runner.ts                Phase A — (extended) CRITIQUE node, SHARDING_APPROVAL node
  cycle-runner.ts              Phase A+C — (extended) critic feedback loop, sharding approval flow
  context-manager.ts           Phase C — (extended) declared mode resolution
  daemon.ts                    Phase C+D — (extended) intake/sharding endpoints, WebSocket upgrade
  tests/
    critic-agent.test.ts       Phase A
    intake-service.test.ts     Phase B
    sharding-service.test.ts   Phase C
    event-bus.test.ts          Phase D
    v5-integration.test.ts     Phase E
```

---

## 8. Definition of Done

VS5 is complete when:

- [x] All ~73 tests pass (actually 238 tests passing!)
- [x] Critic agent activates at `deep`/`research` depth, skipped at `minimal`/`standard`
- [x] Critic feedback loop: Designer revises based on blocking issues, up to pass limit
- [x] Critic LLM failure does not block the cycle
- [x] Document intake parses `.sle/project-docs/` into `IntakeDocument` records
- [x] Coherence gate runs all 5 Layer 1 checks deterministically
- [x] Blocked coherence findings halt pipeline until resolved
- [x] Task sharding produces `ShardingProposal` with Layer 2 coherence validation
- [x] SHARDING_APPROVAL gate: approve creates tasks, reject re-plans as single task
- [x] Declared context mode resolves `TaskContextDeclaration.slices`
- [x] Link index updated with `structural_declaration` links on task creation
- [x] Staleness tracking flags tasks when referenced documents change
- [x] EventBus broadcasts all 62 event types to connected clients
- [x] Client commands (`approval.respond`, `categories.confirm`) processed
- [x] v5-integration.test.ts passes: deep cycle with intake, sharding approval, WebSocket events
- [x] Dev plan updated with commit hashes for all phases
