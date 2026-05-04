# Intake and Sharding

**Type:** spec · **Status:** draft · **Updated:** 2026-04-22
**Depends on:** DDR-013, DDR-017, DDR-024, DDR-025, DDR-026
**Source material:** SLE-019 (full rewrite)

## Overview

The intake and sharding pipeline transforms free-floating project documents into
independently executable tasks with explicit context declarations. It sits
between document authoring and the job dispatch layer, ensuring that every task
the system creates is coherent, well-scoped, and declares exactly which artifact
sections its executing agent will need.

The pipeline is not a required step for every cycle. It activates when documents
exist in `.sle/project-docs/` or when the user explicitly requests it. When
bypassed, the context manager operates in inference mode (role-based defaults)
and the system degrades gracefully.

**Pipeline flow:**

```
User brings documents (free-floating)
        │
        ▼
Document intake — parse, index, promote
        │
        ▼
Coherence gate — static analysis, blocks on contradictions
        │
        ▼
Task sharding — collaborative task decomposition
        │
        ▼
Sharding approval — human checkpoint (cycle.awaiting_sharding_approval)
        │
        ▼
Task creation — TaskStore.createTask per shard
        │
        ▼
Link index update — structural backlinks from declarations
        │
        ▼
Job system dispatch — context manager in declared mode
```

**Canonical types:** [../reference/types.md](../reference/types.md) §11.
**State machine:** [state-machine.md](state-machine.md) §Intra-cycle transitions.
**DDR decisions:** [../decisions/DECISION-BRIEFS.md](../decisions/DECISION-BRIEFS.md).

---

## Data model

### IntakeDocument

Every document that enters the pipeline carries structured metadata used by the
coherence checker, link index, and context manager.

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
```

| Field | Purpose |
|-------|---------|
| `id` | Stable slug derived from filename. Used in `doc:{id}` references. |
| `filename` | Relative to `.sle/project-docs/`. |
| `status` | Lifecycle state. `ungraphed` → `promoted` → `superseded`. |
| `sections` | Parsed heading structure with token estimates per section. |
| `promoted_to_node` | Set when the document enters a cycle's context for the first time. |

### DocumentSection

```typescript
interface DocumentSection {
  id: string
  heading: string
  tokens: number
  anchor: string
}
```

Sections enable precise context references. Instead of loading an entire
4,000-token document, a task can declare `doc:requirements#auth-section` (400
tokens). The context manager resolves the anchor to the relevant subsection.

### CoherenceReport

```typescript
interface CoherenceReport {
  status: 'clean' | 'flagged' | 'blocked'
  findings: CoherenceFinding[]
  document_count: number
  checked_at: string
}
```

Produced by the coherence gate. Stored at `.sle/coherence-report.json`.

- `clean`: no findings. Pipeline proceeds automatically.
- `flagged`: warnings only. User acknowledges, pipeline proceeds.
- `blocked`: at least one blocking finding. Pipeline halts until resolved.

### CoherenceFinding

```typescript
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

Findings reference documents by their typed prefix format (DDR-025).
`document_a` and `document_b` are `doc:{key}` references. `section_a` and
`section_b` are anchor strings matching `DocumentSection.anchor`.

### ShardingProposal

```typescript
interface ShardingProposal {
  tasks: SLETask[]
  total_estimated_tokens: number
  coherence_report: CoherenceReport
  approved_by_user: boolean
  approved_at?: string
}
```

The collaborative output of the sharding phase. Stored at
`.sle/sharding-proposal.yaml`. Only created after the coherence gate passes.
Mutually exclusive with non-sharded plan execution — a cycle either shards or
it does not.

### SLETask

```typescript
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
```

Full definition: `SLETask` in [../reference/types.md](../reference/types.md) §11.

Tasks are the unit of work the job system dispatches. Each task optionally
carries a `TaskContextDeclaration` that switches the context manager from
inferred mode to declared mode.

### TaskContextDeclaration

```typescript
interface TaskContextDeclaration {
  task_id: string
  slices: ArtifactRef[]
  intent: string
}
```

Full definition: `TaskContextDeclaration` in [../reference/types.md](../reference/types.md) §11.

The `slices` array uses typed artifact references (DDR-025):

```
slices:
  - "doc:requirements"
  - "doc:architecture"
  - "node:auth:implementation"
```

The `intent` field carries the task-specific goal. The context manager injects
it as the task component (Component 4) of the assembled context window.

### TaskStore provider

```typescript
interface TaskStore {
  createTask(task: Omit<SLETask, 'id' | 'created_at' | 'updated_at'>): Promise<SLETask>
  getReadyTasks(): Promise<SLETask[]>
  updateStatus(id: string, status: SLETask['status']): Promise<void>
  closeTask(id: string): Promise<void>
  getStale(): Promise<SLETask[]>
  addDependency(taskId: string, dependencyTaskId: string): Promise<void>
}
```

Two implementations (DDR-024):

| Provider | Storage | When used |
|----------|---------|-----------|
| `BeadsTaskStore` | Beads issues via `bd` CLI | Default when Beads configured |
| `LocalTaskStore` | `.sle/tasks.yaml` | Fallback when Beads unavailable |

Selection is configured at `sle init` and stored in `map.yaml → remotes.issues.local_only`.

### ArtifactRef

```typescript
type ArtifactRef = `doc:${string}` | `node:${string}:${string}`
```

Typed prefix format (DDR-025). All context declarations, coherence findings,
and link index entries use this format. Unprefixed references are treated as
`doc:{key}` for backward compatibility during transition.

| Prefix | Scope | Resolution |
|--------|-------|------------|
| `doc:{key}` | Project-level document | `.sle/project-docs/{key}.md` |
| `node:{group}:{key}` | Group-level node | `.sle/project-graph/layers/{group}/{key}.md` |

Wildcard form `node:*:{key}` loads the named artifact from every group. Use
sparingly — it consumes token budget proportional to group count.

---

## Behavior

### Deployment modes

The pipeline activates at different points depending on how the user invokes the
system. It is never mandatory.

| Trigger | Mode | Intake runs? | Context mode |
|---------|------|-------------|--------------|
| `sle start` + docs in `project-docs/` | Inline (auto) | Yes, within PLAN node | Declared after approval |
| `sle start --intake` | Forced | Yes, within PLAN node | Declared after approval |
| `sle start --no-intake` | Bypassed | No | Inferred |
| `sle start` + no docs | Bypassed (auto) | No | Inferred |
| `sle intake` standalone | Pre-prime | Yes, dedicated session | N/A (primes for later) |
| `sle intake --auto-approve` | Pre-prime (non-interactive) | Yes | N/A |

In inline mode, the intake sub-phase runs inside the PLAN node. It is not a
separate DAG node — the Planner includes intake as part of its planning pass.
When a sharding proposal emerges from the Planner, the `SHARDING_APPROVAL`
DAG node activates (DDR-026).

In bypassed mode, the context manager operates in inferred mode for the entire
cycle. No coherence check runs, no sharding proposal is produced, and no
`TaskContextDeclaration` is attached to any task.

### Pipeline step 1 — Document intake

Documents enter the system as free-floating files in `.sle/project-docs/`. They
start as `ungraphed` — no node owns them, no cycle references them.

```
.sle/
└── project-docs/
    ├── product-brief.md       ← ungraphed
    ├── api-contract.md        ← ungraphed
    └── architecture.md        ← ungraphed
```

**Parsing:**

When the intake pipeline activates, the daemon scans `.sle/project-docs/` and
builds an `IntakeDocument` record for each file:

1. Read the file.
2. Derive `id` from the filename (slugify, strip extension).
3. Extract `title` from the first `#` heading.
4. Parse `sections` by walking `##` headings. Estimate tokens per section.
5. Write metadata to `.sle/project-docs/{filename}#meta` (sidecar JSON).
6. Set `status` to `ungraphed`.

**Promotion:**

When a document enters a cycle's context — either because the Planner references
it during intake or the user explicitly mentions it — the daemon promotes it:

1. Create a document node at `doc:{id}` in the project graph.
2. Set `IntakeDocument.status` to `promoted`.
3. Set `IntakeDocument.promoted_to_node` to the new node ID.
4. All downstream nodes in that cycle auto-link back to the document.
5. The document receives backlinks from every node that references it.

Promotion is automatic on use. The user does not manually promote documents.

### Pipeline step 2 — Coherence gate

The coherence gate is a blocking checkpoint between document intake and task
sharding. It runs before any task is created. It is pure static analysis — no
LLM calls, deterministic, fast.

**Three layers of coherence:**

#### Layer 1 — Document coherence (before tasks exist)

Validates the document set as a whole. Runs as a structured check on parsed
document metadata and cross-references.

| Check | Description |
|-------|-------------|
| Cross-reference integrity | Every entity mentioned in one document that is defined in another has a matching definition |
| Terminology consistency | Same concept is not referred to by different names across documents |
| Contradiction detection | A decision in Document A does not directly contradict a constraint in Document B |
| Completeness | Documents required by the planned task scope exist and are non-empty |
| Dangling references | No document references a section, entity, or document that does not exist |

Each check produces zero or more `CoherenceFinding` entries. The overall report
status is derived from the highest severity:

```
if any finding has severity 'blocking':  status = 'blocked'
elif any finding has severity 'warning':  status = 'flagged'
else:                                     status = 'clean'
```

**Gate flow:**

```
Document intake
        │
        ▼
Coherence checker (automated)
        │
        ├── clean → proceed to sharding
        │
        └── flagged → present to user
                  │
                  ├── user resolves → re-run checker → proceed
                  │
                  └── user overrides warning → proceed with warning logged
```

`blocked` findings halt the pipeline. The user must resolve contradictions or
undefined references before proceeding. `flagged` warnings are shown but do not
halt — the user can acknowledge and proceed.

The coherence report is written to `.sle/coherence-report.json` regardless of
outcome. It is re-read by the Facilitator when presenting findings to the user.

#### Layer 2 — Task coherence (during sharding)

When documents are sharded into tasks, each task is checked for:

| Check | Description |
|-------|-------------|
| Independence | The task can complete without needing output from another task running in parallel |
| Declared context completeness | Every document section the task needs is listed in its `TaskContextDeclaration` |
| No duplicate scope | Two tasks do not claim ownership of the same implementation target |
| Boundary clarity | It is unambiguous when this task is done (derived from acceptance criteria) |
| Acceptance verifiability | Each acceptance criterion is a statement checkable by the Tester agent |

Tasks that fail Layer 2 are returned to the sharding phase for revision. The
sharding loop repeats until all tasks pass.

#### Layer 3 — Runtime coherence (during execution)

When a document is modified while tasks derived from it are in-flight:

1. All tasks that declare a reference to the modified document (or section)
   are flagged as `stale: true`.
2. Stale tasks are paused before their jobs are dispatched.
3. The user is notified via the Facilitator.
4. The user can re-shard, update task declarations, or proceed as-is.

Runtime coherence prevents agents from operating on context that no longer
reflects the current document state.

### Pipeline step 3 — Task sharding

Sharding is collaborative. The Planner proposes task boundaries, the user
reviews, and both iterate until the task set is correct.

**Sharding rules:**

**Rule 1 — One implementation target per task.** Each task owns exactly one
scope — a specific file, module, or endpoint. Two tasks must not declare the
same scope.

**Rule 2 — Sections over whole files.** Context declarations prefer
`doc:{key}#{section}` over `doc:{key}` alone. Whole-file references are allowed
only when the entire document is genuinely needed.

**Rule 3 — Token budget awareness.** The sum of `estimated_tokens` across all
declared context for a single task must fit within the context manager's
artifact slice budget (~2000 tokens) minus system prompt overhead. Tasks that
exceed this are split or their context is narrowed.

**Rule 4 — Explicit dependencies.** If Task B needs the output of Task A, the
dependency is declared explicitly in `SLETask.dependencies`. No hidden ordering
assumptions.

**Rule 5 — Acceptance criteria are verifiable.** Each acceptance criterion must
be a statement checkable by the Tester agent (pass/fail against a specific
condition). Vague criteria are rejected by the Layer 2 coherence check.

**Sharding flow:**

```
Coherence gate passes
        │
        ▼
Planner proposes task decomposition
        │
        ▼
Layer 2 coherence check on proposed tasks
        │
        ├── all pass → proceed to sharding approval
        │
        └── any fail → Planner revises → re-check (loop)
```

### Pipeline step 4 — Sharding approval

Sharding approval is a separate human checkpoint before the CONFIRM gate
(DDR-026). It uses the `cycle.awaiting_sharding_approval` flag on the cycle
record. `meta.status` stays `cycling`.

**DAG placement:**

```
... → PLAN → TEST → SHARDING_APPROVAL → CONFIRM → BUILD → ...
```

> **Design tradeoff (DDR-026):** Sharding approval is placed after TEST, meaning
> tests are written against the full plan before sharding is reviewed. If the
> user rejects the sharding proposal, the Planner re-plans as a single task and
> tests must be regenerated. This was accepted as preferable to the alternative
> (sharding between PLAN and TEST), which would require writing tests twice for
> the sharded case — once during initial TEST and again after sharding modifies
> task boundaries.

The `SHARDING_APPROVAL` DAG node only activates when the Planner produced a
sharding proposal. When the cycle runs without intake (bypassed mode), this
node is skipped entirely.

**Approval flow:**

1. The Planner produces a `ShardingProposal`.
2. The daemon sets `cycle.awaiting_sharding_approval = true`.
3. The Facilitator enters decision mode and presents the proposal.
4. The user reviews task boundaries, context declarations, and dependencies.

**User actions:**

| Action | Effect |
|--------|--------|
| Approve | Create tasks in TaskStore, update link index, clear flag, proceed to CONFIRM |
| Reject | Clear flag, proceed to CONFIRM without sharding. Planner re-plans as a single task. |
| Modify | Revise proposal (add/remove/edit tasks), re-present at SHARDING_APPROVAL |

On approval, each `SLETask` in the proposal is persisted via `TaskStore.createTask`.
The Planner's full `TaskContextDeclaration` is stored alongside each task. In
`BeadsTaskStore`, it is serialized into the issue's notes field. In
`LocalTaskStore`, it is written to `.sle/tasks.yaml`.

After all tasks are created, dependency wiring runs:

```
for each task.dependencies entry:
  TaskStore.addDependency(task.id, dependency_task_id)
```

This ensures `getReadyTasks()` returns only unblocked tasks in dependency order.

### Pipeline step 5 — Task creation

Task creation delegates to the active `TaskStore` provider (DDR-024).

#### BeadsTaskStore

Delegates to `bd` CLI commands:

```
bd create --title {title} --type task --priority {priority}
bd dep add {blocked_task} {blocking_task}
```

The `TaskContextDeclaration` is serialized as JSON into the Beads issue's notes
field. Staleness is tracked by writing `STALE:` prefix in the notes.

| SLETask field | Beads field |
|---------------|-------------|
| `id` | Issue slug |
| `title` | Title |
| `description` | Description body |
| `priority` | Priority (0–4) |
| `dependencies` | Beads dependency links |
| `status` | Issue status |
| `context_declarations` | Notes field (JSON) |

#### LocalTaskStore

Reads and writes `.sle/tasks.yaml` using the same `SLETask` schema. No CLI
commands involved — direct file I/O.

```yaml
tasks:
  - id: task-implement-jwt-auth
    title: "Implement JWT validation middleware"
    description: "Create the JWT validation middleware..."
    status: open
    priority: 1
    dependencies: []
    context_declarations:
      - task_id: task-implement-jwt-auth
        slices:
          - "doc:requirements"
          - "doc:architecture"
          - "node:auth:implementation"
        intent: "Implement JWT validation middleware..."
    created_at: "2026-04-22T10:00:00Z"
    updated_at: "2026-04-22T10:00:00Z"
```

Staleness is tracked by the `stale: boolean` field directly on each task entry.

### Pipeline step 6 — Link index update

After task creation, structural backlinks are injected into the link index
(SLE-017). These are Tier 1 links — free, always accurate, derived directly
from the task declarations.

For each task with a `TaskContextDeclaration`:

```
for each slice in declaration.slices:
  linkIndex.addLink(
    source: task.id,
    target: slice,
    type: 'structural'
  )
```

When a document section is viewed, its backlink panel shows every task that
declared a reference to it. This is the shared working memory agents query
before starting work.

**Three link tiers:**

| Tier | Source | When created |
|------|--------|-------------|
| Structural | Task declarations (auto) | At task creation |
| Contextual | Agent execution (observed) | During EXEC, when the context manager loads a declared slice |
| Semantic | Cognee (post-MVP) | After execution, pluggable |

Tier 1 is on the critical path. Tier 2 is recorded but does not block. Tier 3
is out of scope for this spec.

### Context assembly modes

The intake pipeline determines how the context manager assembles slices for all
downstream agent calls.

#### Declared mode (resolver)

When tasks carry `TaskContextDeclaration`, the context manager resolves declared
references directly — no inference, no role-based defaults, no truncation of
declared sections.

```
assembleDeclared(task, role, config):
  slices = {}
  for each ref in task.context_declarations.slices:
    content = resolveArtifactRef(ref)
    slices[ref] = content

  enforceTokenBudget(slices, config.artifact_slice_size)
  return assembleFromResolvedSlices(role, state, slices, task)
```

#### Inferred mode (legacy)

When no `TaskContextDeclaration` exists, the context manager falls back to
role-based slice defaults defined in the context manager spec. This is the
path for cycles that bypass intake.

```
assembleInferred(role, config):
  defaults = getRoleDefaults(role)
  slices = loadSlices(defaults)
  enforceTokenBudget(slices, config.artifact_slice_size)
  return assembleFromInferredSlices(role, state, slices)
```

**Mode selection per invocation:**

```
resolveMode(task?, role):
  if task exists AND task.context_declarations is not empty:
    return 'declared'
  else:
    return 'inferred'
```

The mode is per-invocation, not per-cycle. A cycle with multiple tasks may use
declared mode for some agent calls and inferred mode for others.

### Staleness tracking

When a document is modified after tasks have been created from it:

```
onDocumentModified(documentId, sectionId?):
  affected = taskStore.getTasksReferencing(documentId, sectionId?)
  for each task in affected:
    task.stale = true
    taskStore.updateStale(task.id, true)
```

In `BeadsTaskStore`:

```
bd update {id} --notes "STALE: doc:{key}#{section} was modified"
```

In `LocalTaskStore`:

```yaml
tasks:
  - id: task-implement-jwt-auth
    stale: true
```

The job system checks `task.stale` before dispatching. A stale task is not
dispatched until the user clears the flag. The user can re-shard, update
declarations, or confirm the task is still valid.

### Document lifecycle

Documents follow a strict lifecycle:

```
ungraphed → promoted → superseded
```

| Status | Meaning | Transition trigger |
|--------|---------|-------------------|
| `ungraphed` | Exists in `project-docs/` but not yet referenced by any cycle | → `promoted` on first use |
| `promoted` | Has a graphed node; backlinks from consuming nodes | → `superseded` when replaced |
| `superseded` | Replaced by a newer document; preserved for history | Terminal |

Superseded documents remain in `.sle/project-docs/` for history. Their backlinks
are preserved but marked as historical. The context manager never loads a
superseded document into an agent's context window.

### Relationship to the DAG

The intake pipeline is embedded within the DAG, not separate from it.

```
SCOPING → DESIGN → [CRITIQUE] → PLAN → TEST → [SHARDING_APPROVAL] → CONFIRM
→ BUILD → HISTORY → EXEC → VALIDATION_GATE → ...
```

The intake sub-phase runs inside the PLAN node. When the Planner encounters
documents in `.sle/project-docs/`, it runs intake (parse → coherence → shard)
as part of its planning pass. The output is a `ShardingProposal` that activates
the `SHARDING_APPROVAL` node.

On retry (iteration > 1), the intake pipeline does not re-run. Tasks created in
the first iteration persist. Only runtime coherence (Layer 3) checks for
staleness on retry.

---

## API contract

### Run intake pipeline

Triggers the intake pipeline as a standalone operation, outside a cycle.

```
POST /api/v2/intake

Request:
{
  "auto_approve":  boolean,
  "documents":     string[] | null
}

Response 200:
{
  "coherence_report":  CoherenceReport,
  "proposal":          ShardingProposal | null,
  "tasks_created":     number
}

Response 409:
{
  "error":  "session_conflict",
  "state":  SystemStatus,
  "reason": "Cannot run intake while a cycle is active."
}
```

When `auto_approve` is `true`, the sharding proposal is approved automatically
if the coherence gate passes with status `clean` or `flagged`. When `false`,
the proposal is created but not approved — the user must call the approve
endpoint.

When `documents` is `null`, all files in `.sle/project-docs/` are processed.
When provided, only the listed filenames are processed.

### Get coherence report

```
GET /api/v2/intake/coherence

Response 200:
{
  "report":  CoherenceReport
}

Response 404:
{
  "error": "no_coherence_report",
  "reason": "No intake pipeline has run for the current session."
}
```

Returns the most recent coherence report, whether from a standalone intake run
or from the intake sub-phase within a cycle.

### Resolve coherence finding

```
POST /api/v2/intake/coherence/resolve

Request:
{
  "finding_index":  number,
  "action":         "resolved" | "suppressed",
  "resolution":     string | null
}

Response 200:
{
  "report":  CoherenceReport
}

Response 404:
{
  "error": "finding_not_found"
}

Response 409:
{
  "error":  "finding_not_blocking",
  "reason": "Only blocking findings require explicit resolution."
}
```

Resolving a blocking finding marks it as addressed and re-runs the coherence
check. If all blocking findings are resolved, the report status updates to
`clean` or `flagged`.

Suppressing a warning finding acknowledges it without requiring changes. The
finding remains in the report for audit purposes but no longer blocks.

### Get sharding proposal

```
GET /api/v2/intake/sharding

Response 200:
{
  "proposal":  ShardingProposal
}

Response 404:
{
  "error": "no_sharding_proposal",
  "reason": "No sharding proposal exists. Intake may not have run."
}
```

### Modify sharding proposal

```
PATCH /api/v2/intake/sharding

Request:
{
  "tasks": {
    "add":     [{ "title": string, "description": string, "slices": ArtifactRef[], "dependencies": string[], "priority": number }] | null,
    "remove":  [{ "task_index": number }] | null,
    "edit":    [{ "task_index": number, "title": string | null, "description": string | null, "slices": ArtifactRef[] | null, "dependencies": string[] | null, "priority": number | null }] | null
  }
}

Response 200:
{
  "proposal":  ShardingProposal
}

Response 400:
{
  "error":  "invalid_proposal",
  "reason": string
}
```

Modifies the sharding proposal and re-runs the Layer 2 coherence check. If any
task fails the check, the response includes the failures and the proposal is
not updated.

### Sharding approval actions

These endpoints mirror the DAG-level sharding approval endpoints in
dag-execution.md but are scoped to standalone intake sessions.

```
POST /api/v2/intake/sharding/approve

Response 200:
{
  "tasks_created": number
}

POST /api/v2/intake/sharding/reject

Response 200:
{
  "rejected": true
}
```

On approval, all tasks in the proposal are created via `TaskStore.createTask`.
Dependencies are wired. The link index is updated with structural backlinks.

On rejection, the proposal is discarded. Tasks are not created. The user can
re-run the intake pipeline to produce a new proposal.

### Get task store status

```
GET /api/v2/intake/taskstore

Response 200:
{
  "provider":    "beads" | "local",
  "tasks_count": number,
  "stale_count": number,
  "ready_count": number
}
```

Returns the current state of the active `TaskStore` provider. Useful for
debugging and for the Facilitator to report task status to the user.

### List intake documents

```
GET /api/v2/intake/documents

Response 200:
{
  "documents":  IntakeDocument[]
}
```

Returns all documents currently tracked by the intake pipeline, regardless of
status. Includes promoted and superseded documents.

### Promote document

```
POST /api/v2/intake/documents/{document_id}/promote

Response 200:
{
  "document":  IntakeDocument,
  "node_id":   string
}

Response 404:
{
  "error": "document_not_found"
}

Response 409:
{
  "error":  "already_promoted",
  "node_id": string
}
```

Manually promotes an ungraphed document. Creates a `doc:{id}` node in the
project graph and updates the document's status. If the document is already
promoted, returns 409 with the existing node ID.

### WebSocket events

```
event: intake.coherence_checked
{
  "status":           "clean" | "flagged" | "blocked",
  "finding_count":    number,
  "blocking_count":   number,
  "timestamp":        string
}

event: intake.sharding_proposed
{
  "task_count":            number,
  "total_estimated_tokens": number,
  "timestamp":             string
}

event: intake.sharding_approved
{
  "tasks_created":  number,
  "timestamp":      string
}

event: intake.sharding_rejected
{
  "timestamp": string
}

event: intake.document_promoted
{
  "document_id": string,
  "node_id":     string,
  "timestamp":   string
}

event: intake.task_stale
{
  "task_id":      string,
  "document_id":  string,
  "section_id":   string | null,
  "timestamp":    string
}
```

---

## Error cases

### Coherence gate errors

| Error | Condition | Response |
|-------|-----------|----------|
| `coherence_blocked` | Coherence report status is `blocked` | Halt pipeline. Present findings to user. User must resolve before proceeding. |
| `coherence_check_failed` | Static analysis throws an exception (corrupt document, invalid encoding) | Halt pipeline. Log error with document ID. User must fix the document. |
| `finding_not_found` | Resolve endpoint called with invalid `finding_index` | 404 |
| `finding_not_blocking` | Resolve endpoint called on a warning finding with action `resolved` | 409. Warnings can only be suppressed, not resolved. |

### Sharding errors

| Error | Condition | Response |
|-------|-----------|----------|
| `duplicate_scope` | Two tasks in the proposal claim the same implementation target | Layer 2 check fails. Return tasks with conflicting scopes. Planner must revise. |
| `context_over_budget` | A task's declared context exceeds the token budget | Layer 2 check fails. Return task ID and token estimate. Planner must narrow context. |
| `circular_dependency` | Task dependency graph contains a cycle | Layer 2 check fails. Return cycle path. Planner must break the cycle. |
| `vague_acceptance` | An acceptance criterion fails verifiability check | Layer 2 check fails. Return task ID and criterion. Planner must rephrase. |
| `missing_declaration` | A task has no `TaskContextDeclaration` | Warning only. Task proceeds without declaration (context manager uses inferred mode). |
| `invalid_proposal` | Modification produces an empty task list or a malformed task | 400 with reason. Proposal is not updated. |
| `no_sharding_proposal` | Attempt to approve/reject when no proposal exists | 404 |

### Task store errors

| Error | Condition | Response |
|-------|-----------|----------|
| `beads_unavailable` | `BeadsTaskStore` cannot reach `bd` CLI or DoltHub | Fall back to `LocalTaskStore` if configured. If not configured, halt pipeline with error. |
| `task_creation_failed` | `TaskStore.createTask` throws (disk full, permission denied, Beads API error) | Halt pipeline. Log error. Partial tasks may exist — clean up before retry. |
| `dependency_wire_failed` | `TaskStore.addDependency` fails for a task pair | Log warning. Task is created but dependency is not wired. Manual fix required. |
| `local_store_corrupt` | `.sle/tasks.yaml` is malformed or unparseable | Halt pipeline. Log error with file path. User must fix or delete the file. |
| `concurrent_modification` | `.sle/tasks.yaml` changed between read and write | Retry with backoff (3 attempts). If still failing, halt and log. |

### Document errors

| Error | Condition | Response |
|-------|-----------|----------|
| `document_not_found` | Referenced document does not exist in `project-docs/` | 404 |
| `document_empty` | Document file exists but is empty (0 bytes) | Log warning. Skip document in coherence check. |
| `document_unparseable` | Document contains invalid UTF-8 or binary content | Log error with filename. Skip document. |
| `already_promoted` | Attempt to promote a document that is already `promoted` | 409 with existing node ID |
| `section_not_found` | A context declaration references a section anchor that does not exist in the document | Log warning. Load entire document instead of section. |
| `document_superseded` | Attempt to promote a superseded document | 409. Superseded documents cannot be re-promoted. |

### Pipeline-level errors

| Error | Condition | Response |
|-------|-----------|----------|
| `session_conflict` | Standalone intake attempted while a cycle is active | 409 with current system state |
| `intake_not_configured` | TaskStore provider not configured at init | Halt. Run `sle init` to configure. |
| `stale_proposal` | Sharding approval attempted on a proposal whose coherence report is stale (documents changed) | Re-run coherence gate automatically. If still clean, proceed. If not, present new findings. |

---

## Constraints

1. **Coherence gate is a prerequisite.** No task is created until the coherence
   report status is `clean` or `flagged`. `blocked` findings must be resolved
   or suppressed before the pipeline proceeds (DDR-017).

2. **Sharding before CONFIRM.** Sharding approval is a separate checkpoint
   that runs before the CONFIRM gate, not embedded within it (DDR-026).

3. **Flag exclusivity.** At most one of `cycle.awaiting_confirmation` and
   `cycle.awaiting_sharding_approval` may be `true` at a time.

4. **Flag scope.** Both flags are scoped to the active cycle. They reset to
   `false` when the cycle ends.

5. **One implementation target per task.** Each task owns exactly one scope.
   Two tasks must not declare the same scope.

6. **Sections over whole files.** Context declarations prefer section-level
   references (`doc:{key}#{section}`) over whole-file references (`doc:{key}`).

7. **Token budget enforcement.** A task's declared context must fit within the
   context manager's artifact slice budget. Over-budget tasks are split or
   narrowed during the sharding phase.

8. **Explicit dependencies.** All task dependencies are declared explicitly
   in `SLETask.dependencies`. No hidden ordering assumptions.

9. **Acceptance criteria must be verifiable.** Vague criteria are rejected by
   the Layer 2 coherence check.

10. **Artifact reference format.** All artifact references use typed prefixes:
    `doc:{key}` or `node:{group}:{key}` (DDR-025).

11. **TaskStore abstraction.** Task creation always goes through the
    `TaskStore` interface (DDR-024). The pipeline does not call `bd` commands
    or write `.sle/tasks.yaml` directly.

12. **No LLM in coherence gate.** Layer 1 coherence is pure static analysis.
    It is deterministic, fast, and cheap. No external service calls.

13. **No intake re-run on retry.** On iteration > 1, the intake pipeline does
    not re-run. Tasks persist from the first iteration. Only runtime coherence
    (Layer 3) checks for staleness.

14. **Append-only decisions.** `doc:decisions` is never overwritten. Intake
    events (coherence findings, sharding approvals) are appended as audit
    entries.

15. **Document promotion is automatic.** Users do not manually promote
    documents. Promotion happens on first use in a cycle.

16. **Stale tasks are not dispatched.** The job system checks `task.stale`
    before dispatching. A stale task requires user action before it can proceed.

17. **Superseded documents are terminal.** Once a document is superseded, it
    cannot be re-promoted. A new document file must be created.

18. **Pipeline is optional.** The system works fully without the intake
    pipeline. Bypassed mode (inference) is the default when no documents exist.

---

## Open questions

| ID | Question | Impact | Status |
|----|----------|--------|--------|
| IS-001 | Should the coherence gate support custom checks defined by the user (e.g., project-specific terminology rules), or is the built-in set sufficient? | Extensibility, per-project customization | Open |
| IS-002 | What is the maximum number of tasks a single sharding proposal may contain before the approval UX becomes unwieldy? | UX, resource bounding | Open |
| IS-003 | Should Layer 2 task coherence run automatically after each modification to the proposal, or only when the user submits for review? | Latency vs. correctness trade-off | Open |
| IS-004 | How should the system handle partial task creation — where some tasks are written to the TaskStore but a later task fails? | Transactionality, cleanup behavior | Open |
| IS-005 | Should the coherence gate re-run when a document is modified during the sharding phase (between gate pass and proposal approval)? | Staleness detection timing | Open |
| IS-006 | What is the maximum wall-clock time for a coherence check on a large document set (50+ documents)? | Performance, user experience | Open |
| IS-007 | Should the `TaskStore` provider be switchable after `sle init`, or is it locked for the project lifetime? | Configuration flexibility vs. consistency | Open |
| IS-008 | How should Cognee-powered semantic links (Tier 3) be integrated into the link index without blocking the critical path? | Tier 3 implementation, performance | Open |
| IS-009 | Should the intake pipeline support importing documents from URLs (e.g., Postman collections, external API specs) or only from local files? | Document source flexibility | Open |
| IS-010 | When a sharding proposal is rejected and the Planner re-plans without sharding, should the original proposal be preserved for reference? | Audit trail, UX | Open |
| IS-011 | Should section-level token estimates be recalculated when a document is modified, or cached until the next intake run? | Accuracy vs. performance | Open |
| IS-012 | What happens if a promoted document is deleted from `project-docs/` while tasks referencing it are still open? | Document lifecycle, runtime coherence | Open |
| IS-013 | Should `BeadsTaskStore` and `LocalTaskStore` support migration between providers (e.g., export local tasks to Beads when configured later)? | Provider portability | Open |
| IS-014 | Should the coherence gate check for section-level contradictions (within a single document) or only cross-document issues? | Coherence scope, check complexity | Open |
