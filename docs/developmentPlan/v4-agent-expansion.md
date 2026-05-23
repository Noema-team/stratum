# Vertical Slice 4: Hardened Infrastructure & APIs

**Type:** implementation plan · **Status:** not started · **Updated:** 2026-05-23
**Slice:** v4 · **Prerequisites:** VS3 Complete (Real subprocess EXEC, multi-turn agents, debugger loop)

---

## Implementation Progress

| Phase | Component | Status | Commit |
|-------|-----------|--------|--------|
| A | Job Dispatch Worker Pool | ☐ Not started | — |
| B | Tri-Phase Validation Engine | ☐ Not started | — |
| C | Document Link Index | ☐ Not started | — |
| D | Context Manager Budgeting | ☐ Not started | — |
| E | REST Endpoint Alignment | ☐ Not started | — |
| F | Integration Tests | ☐ Not started | — |

---

## 1. Overview

### What this slice delivers

After VS4, the system can:

1. Execute test scripts inside Docker containers with resource limits, network isolation, and structured result collection
2. Run full tri-phase validation (static-check → llm-check → exec-check) with category fan-out and deterministic gating
3. Maintain a persistent link index connecting documents, nodes, and source files via auto-generated and manual wikilinks
4. Assemble precisely budgeted 5-component context windows (~3,500 tokens hard ceiling) with per-role slice matrices
5. Serve spec-compliant REST endpoints with Zod-validated request/response envelopes

### Why this structure

VS2 proved the cycle structure with stubbed EXEC. VS3 hardened it with real subprocess execution, typed output contracts, and the Debugger loop. VS4 replaces the subprocess EXEC with full Docker container management, adds the specification-grade validation engine, and builds the memory and context systems that agents need for quality output at scale.

The phase order reflects real dependencies: Docker containers host validation runs; the link index provides the artifact graph that the context manager uses to assemble per-role slices; and the REST alignment layer exposes all of this to the API surface.

### Deliberate deferrals

| Item | Why deferred | Where it goes |
|---|---|---|
| Critic agent (deep/research depth) | Requires CRITIQUE DAG node; separate agent concern | VS5 |
| Explorer agent | Conditional trigger; not on critical path | VS5 |
| SHARDING_APPROVAL gate | Requires intake pipeline | VS5 |
| Chat / facilitator decision mode | Orthogonal to infrastructure | VS5 |
| Intake pipeline (document intake → sharding) | Requires SHARDING_APPROVAL + TaskContextDeclaration flow | VS5 |
| Knowledge engine (Cognee) | Large external dependency | Post-MVP |
| UI Shell | Separate concern; daemon API is the interface | VS6 |
| BeadsTaskStore (full implementation) | Requires `bd` CLI; LocalTaskStore sufficient | Post-MVP |
| Tier 3 semantic links (Cognee) | Requires knowledge engine | Post-MVP |
| File watcher (incremental link index) | Requires daemon long-running process; startup reindex sufficient for VS4 | Post-MVP |

### Scope summary

| In scope | Out of scope |
|---|---|
| Docker worker pool (create, run, collect, destroy containers) | Critic agent, Explorer agent |
| Full tri-phase validation (static + llm + exec sub-phases) | Sharding pipeline, intake documents |
| Category fan-out with parallel llm-check / exec-check | Chat mode, facilitator decision mode |
| Deterministic VALIDATION_GATE with FailureReport (G24) | Knowledge engine (Cognee) |
| Category caching across iterations | UI Shell, dashboard |
| Link index (forward links, backlinks, file index, document index) | Tier 3 semantic links |
| Wikilink parser (`[[doc:key]]`, `[[node:g:k]]`, `[[src/path]]`) | BeadsTaskStore full implementation |
| Auto-linking tiers 1–2 (structural_dag, structural_declaration, contextual_execution) | File watcher (incremental index) |
| 5-component context window with hard 3,500-token ceiling | Declared context mode (requires intake pipeline) |
| SliceRule enforcement with source_weight truncation priority | UI widget system |
| Per-role slice matrices (Designer, Planner, Tester, Builder, etc.) | WebSocket event expansion |
| REST endpoint alignment with Zod-validated envelopes | Extended API (remaining 50+ endpoints) |

### Estimated complexity

| Component | Effort | Risk |
|---|---|---|
| Docker worker pool + job lifecycle | Very High | High (Docker API, container lifecycle, error recovery) |
| Tri-phase validation engine | High | Medium (deterministic logic, but complex fan-out) |
| Document link index | High | Medium (incremental rebuild, backlink computation) |
| Context manager budgeting | High | Medium (token counting, truncation edge cases) |
| REST endpoint alignment | Medium | Low (schema validation, standard patterns) |
| Integration tests | Medium | Low |

---

## 2. Dependency Map

```
External spec dependencies (this slice consumes):
  job-dispatch.md           Worker pool, job lifecycle, container spec, dispatch plan, result collection
  validation.md             Sub-phases, category model, gate logic, FailureReport (G24), run artifacts
  document-linking.md       Link index, forward/backlinks, wikilinks, auto-link tiers, file/document index
  context-manager.md        Five-component window, SliceRule, per-role slice tables, truncation priority
  daemon-api-endpoints.md   REST endpoint schemas, APIResponse<T>, APIError, request validation
  types.md                  SubPhase, ValidationMethod, CategoryStatus, SourceWeight, ArtifactRef
  run-artifacts.md          Run directory structure, manifest schema, context-pack path
  dag-node-reference.md     EXEC, VALIDATION_GATE node definitions
  dag-execution.md          EXEC delegates to job dispatch

This slice produces (consumed by VS5+):
  VS5: Critic agent, Explorer agent, intake pipeline, SHARDING_APPROVAL
  VS6: UI Shell reading WebSocket events from real validation runs
```

```
Dependency flow within this slice:

  Phase A (Job Dispatch Worker Pool)
    |
    v
  Phase B (Tri-Phase Validation Engine)     ← depends on A (validation runs inside containers)
    |
    |
    |
  Phase C (Document Link Index)             ← independent of A/B (parallel track)
    |
    v
  Phase D (Context Manager Budgeting)       ← depends on C (backlink injection into slices)
    |
    v
  Phase E (REST Endpoint Alignment)         ← depends on A+B (dispatch/validation endpoints) + D (context endpoints)
    |
    v
  Phase F (Integration Tests)               ← depends on all phases
```

---

## 3. Implementation Phases

### Phase A: Job Dispatch Worker Pool

**Spec reference:** `job-dispatch.md` (complete document)
**Implements:** Docker-based worker pool that replaces VS3's subprocess EXEC with containerized execution.

#### Types (from `job-dispatch.md` §Data model)

```typescript
type JobType = 'static-check' | 'llm-check' | 'exec-check' | 'task-execution'

type JobStatus =
  | 'queued' | 'preparing' | 'running' | 'collecting'
  | 'completed' | 'failed' | 'cancelled' | 'timed_out'

type JobPriority = 0 | 1 | 2 | 3

interface Job {
  id: string
  type: JobType
  status: JobStatus
  priority: JobPriority
  created_at: string
  started_at: string | null
  completed_at: string | null
  cycle_id: string
  iteration: number
  run_id: string
  category: string | null
  sub_phase: SubPhase | null
  task_id: string | null
  task_context_declaration: TaskContextDeclaration | null
  container_id: string | null
  context_pack_path: string | null
  result: JobResult | null
  error: JobError | null
}

interface JobResult {
  exit_code: number
  stdout: string
  stderr: string
  artifacts: Record<string, string>
  duration_ms: number
  metrics: Record<string, number>
}

interface JobError {
  code: JobErrorCode
  message: string
  recoverable: boolean
  container_exit_code: number | null
  docker_error: string | null
  retry_count: number
}

type WorkerStatus = 'idle' | 'busy' | 'draining' | 'dead'

interface Worker {
  id: string
  status: WorkerStatus
  container_id: string | null
  current_job_id: string | null
  last_heartbeat: string
  total_jobs_completed: number
  total_errors: number
}

interface WorkerPoolConfig {
  max_workers: number
  min_workers: number
  idle_timeout_ms: number
  heartbeat_interval_ms: number
  max_heartbeat_misses: number
  container_startup_timeout_ms: number
}

interface ContainerSpec {
  image: string
  install_command: string
  timeout_ms: number
  env: Record<string, string>
  mount_points: MountPoint[]
  resource_limits: ResourceLimits
  network_mode: 'none' | 'bridge'
}

interface DispatchPlan {
  run_id: string
  cycle_id: string
  iteration: number
  created_at: string
  jobs: DispatchPlanJob[]
  static_gate: StaticGate
}

interface DispatchPlanJob {
  job_type: JobType
  category: string | null
  sub_phase: SubPhase | null
  depends_on: string[]
  priority: JobPriority
}

interface StaticGate {
  job_id: string
  blocks: string[]
}
```

#### Standard mount layout

| Host path | Container path | Read-only | Content |
|---|---|---|---|
| `{run_dir}` | `/sle/run` | No | Run output directory |
| `{project_root}` | `/sle/project` | Yes | Implementation source |
| `{scripts_dir}` | `/sle/scripts` | Yes | Test scripts |
| `{context_pack_path}` | `/sle/context/context-pack.md` | Yes | Assembled context |

#### Resource limits (defaults)

| Resource | Default | Docker flag |
|---|---|---|
| `memory_mb` | 512 | `--memory` |
| `cpu_cores` | 1.0 | `--cpus` |
| `disk_mb` | 512 | `--storage-opt` |
| `pids_max` | 256 | `--pids-limit` |

#### Dispatch lifecycle (from `job-dispatch.md` §Behavior)

```
DAG enters EXEC node
  → Create DispatchPlan (read active categories, generate job IDs)
  → Create run directory
  → Enqueue static-check job (priority 0)
  → Await static-check result
     PASS → release llm-check + exec-check jobs, fan-out all categories
     FAIL → skip remaining jobs, mark categories skipped
  → Dispatch worker pool (workers pull from priority queue)
  → Collect results (7-step: exit code, stdout/stderr, structured result, artifacts, metrics, JobResult, status)
  → Finalize run directory (manifest.json, tests/summary.json)
  → Destroy containers
  → DAG proceeds to VALIDATION_GATE
```

#### Worker pool management

Pool starts at `min_workers` (1), scales up to `max_workers` (`min(cpu_count, 8)`) based on queue depth. Scale-down when idle > `idle_timeout_ms`. Dead workers (missed 3 heartbeats) are replaced automatically.

#### Container environment variables

| Variable | Value |
|---|---|
| `SLE_RUN_DIR` | `/sle/run` |
| `SLE_RUN_ID` | `{run_id}` |
| `SLE_CYCLE` | `{cycle_number}` |
| `SLE_ITERATION` | `{iteration_number}` |
| `SLE_CATEGORY` | `{category_name}` |
| `SLE_SUB_PHASE` | `{sub_phase}` |
| `SLE_PROJECT_ROOT` | `/sle/project` |
| `SLE_SCRIPTS_DIR` | `/sle/scripts` |
| `SLE_TIMEOUT_MS` | `{timeout_ms}` |

#### map.yaml extension

```typescript
interface JobDispatchState {
  pool_size: number
  active_jobs: number
  queued_jobs: number
  last_dispatch_at: string | null
  last_collect_at: string | null
  worker_errors: number
}
```

Stored in `map.yaml → dispatch`. Updated after every job status transition.

**Acceptance criteria:**
- `DockerWorkerPool` manages workers from `min_workers` to `max_workers`
- Job queue ordered by `JobPriority` (0 first)
- Container created per job with correct mounts, env, resource limits, `--network none`
- 7-step result collection writes to `.sle/runs/{run_id}/`
- Heartbeat monitoring marks workers dead after 3 missed intervals
- Dead workers replaced, failed jobs requeued (if `retry_count < max_retries`)
- Static gate blocks all other jobs until static-check passes
- `map.yaml → dispatch` updated on every job transition
- Container cannot write outside `/sle/run` (read-only mounts enforced)
- Network access blocked inside container

**Tests needed:**
- Unit: job queue ordering by priority
- Unit: worker lifecycle (idle → busy → idle)
- Unit: heartbeat monitoring detects dead workers
- Unit: pool scale-up on queue depth
- Unit: pool scale-down on idle timeout
- Unit: static gate blocks category jobs until static-check passes
- Unit: static-check fail → all category jobs cancelled
- Unit: DispatchPlan immutability after creation
- Unit: container spec generation from validation.yaml + defaults
- Integration: full dispatch lifecycle (enqueue → run → collect) with Docker mock
- Integration: result collection (7-step) writes correct artifacts
- Integration: container mount boundary enforced (write to read-only mount fails)
- Integration: container network isolation (curl to external fails)

**Target: ~25 tests (18 unit + 7 integration)**

---

### Phase B: Tri-Phase Validation Engine

**Spec reference:** `validation.md` (complete document)
**Implements:** Three sequential sub-phases, category fan-out, deterministic gate, FailureReport (G24), category caching.

**Depends on:** Phase A (validation runs inside containers from the worker pool)

#### Types (from `validation.md` §Data model)

```typescript
interface StaticAnalysisResult {
  lint: { errors: number; warnings: number; output: string }
  typecheck: { errors: number; output: string }
  complexity: {
    files_over_threshold: Array<{ file: string; complexity: number; threshold: number }>
    max: number
  }
  passed: boolean
}

interface LLMCheckResult {
  verdict: 'pass' | 'fail'
  issues: string[]
  confidence: number
  evidence: string[]
}

interface ExecCheckResult {
  passed_cases: string[]
  failed_cases: string[]
  errors: string[]
  metrics: Record<string, number>
}

interface CategoryResult {
  name: string
  method: ValidationMethod
  llm?: LLMCheckResult
  executable?: ExecCheckResult
  passed: boolean
}

interface GateResult {
  passed: boolean
  static_analysis: StaticAnalysisResult
  category_results: CategoryResult[]
  failed_categories: string[]
  failure_report?: FailureReport
}

interface FailureReport {
  cycle: number
  iteration: number
  run_dir: string
  run_id: string
  quick_summary: string
  failed_categories: string[]
  passed_categories: string[]
}

interface RunManifest {
  run_id: string
  cycle: number
  iteration: number
  timestamp: string
  outcome: 'passed' | 'failed'
  failed_categories: string[]
  passed_categories: string[]
  static_analysis: 'passed' | 'failed' | 'skipped'
  quick_summary: string
  artifacts: {
    context_pack: string
    test_summary: string
    static_analysis: string
    categories: Record<string, string>
    logs?: Record<string, string>
    traces?: string
    metrics?: string
  }
}

interface CategoryRunResult {
  category: string
  phase: 'executable' | 'llm' | 'static'
  passed: boolean
  tests: Array<{
    id: string
    passed: boolean
    expected?: Record<string, unknown>
    actual?: Record<string, unknown>
    message?: string
  }>
  metrics?: Record<string, number>
  duration_ms: number
}
```

#### Sub-phase execution order

```
static-check (once, global, priority 0)
  lint + typecheck + complexity → $RUN_DIR/static-analysis/results.json
  FAIL → skip remaining, gate receives static failure only

if static-check passed:
  Category fan-out (all active categories in parallel)
    for each category C:
      if C.method in ['both', 'llm']:
        llm-check for C → $RUN_DIR/tests/C/result.json
      if C.method in ['both', 'executable']:
        exec-check for C → $RUN_DIR/tests/C/result.json
    llm-check and exec-check run in parallel per category

EXEC complete → VALIDATION_GATE evaluates deterministically
```

#### Deterministic gate evaluation

```typescript
evaluateGate(staticResult, categoryResults): GateResult {
  static_passed = staticResult.passed
  all_categories_passed = categoryResults.every(c => c.passed)
  passed = static_passed && all_categories_passed

  if (!passed) {
    failure_report = {
      cycle, iteration, run_dir, run_id,
      quick_summary: generateSummary(staticResult, categoryResults),
      failed_categories: categoryResults.filter(c => !c.passed).map(c => c.name),
      passed_categories: categoryResults.filter(c => c.passed).map(c => c.name),
    }
  }

  return { passed, static_analysis: staticResult, category_results: categoryResults,
           failed_categories: [...], failure_report }
}
```

#### Category caching across iterations

When a category passes in iteration N, it is **not re-run** in iteration N+1. The gate reads previous results and skips already-passing categories. Only failed categories are dispatched to the worker pool.

```
Iteration 1: all 3 categories run
  correctness: PASS, performance: FAIL, security: PASS

Iteration 2: only performance re-runs
  correctness: CACHED_PASS, performance: PASS, security: CACHED_PASS
```

Cached results are carried forward from the previous iteration's `RunManifest`.

#### Run directory structure

```
.sle/runs/{run_id}/
  manifest.json
  ai/context-pack.md
  tests/
    summary.json
    {category}/result.json
    {category}/junit.xml
  static-analysis/results.json
  logs/{service}.log
  traces/request-map.jsonl
  metrics/percentiles.json
```

#### map.yaml tracked state

```typescript
interface ValidationCategory {
  name: string
  method: ValidationMethod
  status: CategoryStatus
  last_run?: string
  executable?: string
  prompt_template?: string
}

interface ValidationGate {
  mode: 'all_must_pass'
  last_outcome: 'passed' | 'failed' | 'halted'
  failed_categories: string[]
}

interface LastRun {
  run_id: string
  run_dir: string
  outcome: 'passed' | 'failed'
  failed_categories: string[]
  quick_summary: string
  timestamp: string
}
```

**Acceptance criteria:**
- Sub-phases execute in order: static-check → llm-check → exec-check
- static-check failure skips all remaining sub-phases
- Category fan-out: all active categories run in parallel after static-check passes
- llm-check and exec-check run in parallel within each category (method: 'both')
- Deterministic gate: pure function, no LLM, no user input, no external services
- Gate pass → cycle advances to EVALUATE
- Gate fail → FailureReport generated (G24 format), T4 or T6 transition
- Category caching: passing categories not re-dispatched on retry
- RunManifest written with correct outcome, categories, artifact paths
- `map.yaml → validation` and `map.yaml → last_run` updated after gate evaluation

**Tests needed:**
- Unit: static-check failure skips all categories
- Unit: static-check pass enables category fan-out
- Unit: gate evaluation — all pass → gate passes
- Unit: gate evaluation — one category fails → gate fails
- Unit: gate evaluation — static fails → gate fails (regardless of categories)
- Unit: FailureReport generation (G24 format)
- Unit: category caching — passed categories skipped on re-run
- Unit: category caching — all cached + one new → only new runs
- Unit: LLM check pass threshold (confidence < 0.85 → fail)
- Unit: method 'both' — exec passes, llm fails → category fails
- Unit: method 'llm' only — no exec-check dispatched
- Unit: method 'executable' only — no llm-check dispatched
- Unit: RunManifest outcome correctly reflects gate result
- Integration: full tri-phase lifecycle (static → fan-out → collect → gate)
- Integration: gate fail → T4 transition with FailureReport injection

**Target: ~20 tests (13 unit + 7 integration)**

---

### Phase C: Document Link Index

**Spec reference:** `document-linking.md` (complete document)
**Implements:** Persistent link index, wikilink parser, auto-linking tiers 1–2, backlink computation, file/document indexes.

#### Types (from `document-linking.md` §Data model)

```typescript
type LinkEntityKind = 'node' | 'document' | 'source_file' | 'test_file'

type AutoLinkType =
  | 'structural_dag'
  | 'structural_declaration'
  | 'contextual_execution'

type LinkSource =
  | { kind: 'node'; group: string; key: string }
  | { kind: 'document'; key: string }

type LinkTarget =
  | { kind: 'node'; group: string; key: string }
  | { kind: 'document'; key: string }
  | { kind: 'source_file'; path: string }
  | { kind: 'test_file'; path: string }

interface Link {
  id: string
  source: LinkSource
  target: LinkTarget
  link_type: AutoLinkType | 'manual'
  context: string
  created_at: string
  created_by: 'sle' | 'user'
}

interface ForwardLink {
  source: LinkSource
  target: LinkTarget
  link_type: AutoLinkType | 'manual'
  context: string
  created_at: string
}

interface Backlink {
  from: LinkSource
  context: string
  link_type: AutoLinkType | 'manual'
  resolved_label: string
}

interface LinkIndex {
  version: number
  last_rebuilt_at: string
  links: ForwardLink[]
  backlinks: Map<string, Backlink[]>
  file_index: FileIndex
  document_index: DocumentIndex
}

interface FileEntry {
  path: string
  language: string
  last_modified: string
  line_count: number
  referencing_nodes: string[]
  group_id: string | null
  layer: string | null
}

interface FileIndex {
  files: Map<string, FileEntry>
}

interface DocumentEntry {
  key: string
  path: string
  title: string
  description: string
  tags: string[]
  source: 'user' | 'sle_generated' | 'sle_suggested'
  last_modified: string
  modified_by: 'user' | 'sle'
  backlink_count: number
}

interface DocumentIndex {
  documents: Map<string, DocumentEntry>
}
```

#### Storage

```
.sle/link-index/
  forward-links.json
  file-index.json
  document-index.json
```

#### Wikilink parser

Regex for extraction:
```
\[\[(doc:[a-zA-Z0-9_-]+(?:#[a-zA-Z0-9_-]+)?|node:[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+|src/[^\]]+|tests/[^\]]+|group:[a-zA-Z0-9_-]+)\]\]
```

| Wikilink form | Internal resolution |
|---|---|
| `[[doc:{key}]]` | `{ kind: 'document', key }` |
| `[[doc:{key}#{section}]]` | `{ kind: 'document', key }` + section context |
| `[[node:{group}:{key}]]` | `{ kind: 'node', group, key }` |
| `[[src/{path}]]` | `{ kind: 'source_file', path }` |
| `[[tests/{path}]]` | `{ kind: 'test_file', path }` |
| `[[group:{id}]]` | Expands to all nodes in the group |

#### Indexing lifecycle

**Startup (full reindex):**
1. Load `.sle/link-index/forward-links.json`
2. Walk all artifacts in `map.yaml → artifacts.files`
3. Parse each artifact for `[[wikilink]]` patterns
4. Walk source tree (`repo.src`, `repo.tests`) to rebuild `FileIndex`
5. Resolve each link target against artifact registry and filesystem
6. Compute backlink map from forward links
7. Write `map.yaml → graph.link_count` and `graph.last_rebuilt_at`
8. Emit `link.index_rebuilt` WebSocket event

**Incremental update (on artifact mutation):**
1. Parse saved artifact for wikilinks
2. Diff new links against existing forward links for that source
3. Remove stale links, add new links
4. Recompute backlinks for affected targets only
5. Update `map.yaml → graph.link_count`

#### Auto-linking Tier 1: Structural

**From DAG edges (`structural_dag`):** After each node completes, record input→output relationships as links. Links created after downstream node completes successfully.

**From task context declarations (`structural_declaration`):** Each declared `ArtifactRef` becomes a link from the task to that artifact.

#### Auto-linking Tier 2: Contextual

After each agent invocation, the context manager records which slices were loaded. These become `contextual_execution` links: "agent X was informed by artifact Y."

```typescript
interface ContextualLinkRecord {
  role: AgentRole
  cycle: number
  iteration: number
  dag_node: DAGNode
  loaded_slices: ArtifactRef[]
  truncated_slices: ArtifactRef[]
}
```

#### Backlink computation

Backlinks are computed as the inverse of forward links. Full recompute on startup, incremental update on mutation:

```
On link addition: compute backlink, append to target's array
On link removal: remove matching backlink from target's array
On source deletion: remove all backlinks originating from that source
```

#### Source file indexing

Walk `repo.src` and `repo.test` directories on startup. Record `FileEntry` per file with language (inferred from extension), `last_modified`, `line_count`. Cross-reference against Code layer nodes for `referencing_nodes`, `group_id`, `layer`.

Language inference: `.ts/.tsx` → typescript, `.js/.jsx` → javascript, `.py` → python, `.rs` → rust, `.go` → go.

#### map.yaml extension

```yaml
graph:
  link_count: 47
  last_rebuilt_at: "2026-04-17T09:00:00Z"
```

**Acceptance criteria:**
- `LinkIndex` persisted to `.sle/link-index/` with forward links, file index, document index
- Wikilink parser extracts all 6 wikilink forms
- Full reindex on startup produces correct forward links + backlinks
- Incremental update on artifact mutation diffs correctly
- Auto-link Tier 1: `structural_dag` links created on DAG node completion
- Auto-link Tier 1: `structural_declaration` links created on task context declaration
- Auto-link Tier 2: `contextual_execution` links created after agent invocation
- Backlink map computed as inverse of forward links
- Source file indexing walks `repo.src` + `repo.tests`, infers language from extension
- `map.yaml → graph` updated with link_count and last_rebuilt_at
- Malformed wikilinks logged but do not crash the parser

**Tests needed:**
- Unit: wikilink parser — all 6 forms parsed correctly
- Unit: wikilink parser — malformed links ignored with warning
- Unit: forward link creation and persistence
- Unit: backlink computation from forward links
- Unit: incremental update — diff adds new links, removes stale
- Unit: incremental update — backlinks recomputed for affected targets only
- Unit: `structural_dag` auto-link created on DAG node completion
- Unit: `structural_declaration` auto-link created from TaskContextDeclaration
- Unit: `contextual_execution` auto-link records truncated slices
- Unit: source file indexing — language inference per extension
- Unit: source file indexing — exclude patterns (node_modules, .git, dist)
- Unit: document index populated from map.yaml artifacts (scope: project)
- Integration: full reindex produces correct link count and backlink map
- Integration: artifact mutation triggers incremental update

**Target: ~18 tests (12 unit + 6 integration)**

---

### Phase D: Context Manager Budgeting

**Spec reference:** `context-manager.md` (complete document)
**Implements:** Five-component context window, SliceRule enforcement, per-role slice tables, truncation by source_weight.

**Depends on:** Phase C (link index provides backlink injection into context)

#### Five-component window (hard ceiling: 3,500 tokens)

```
┌─────────────────────────────────────┐
│ 1. System prompt        ~500 tokens │  role + behavioral rules
│ 2. Artifact slices     ~2000 tokens │  only what this role needs
│ 3. State summary        ~300 tokens │  current cycle, iteration, depth
│ 4. Task                 ~200 tokens │  specific instruction this turn
│ 5. Failure context      ~400 tokens │  FailureReport — only on retry
└─────────────────────────────────────┘
                    total target: ~3,400 tokens
                    hard ceiling: 3,500 tokens
```

Component 5 absent on iteration 1. On retry, replaces the token budget that would otherwise go to passing category results.

#### Types (from `context-manager.md` §Data model)

```typescript
type ContextAssemblyMode = 'declared' | 'inferred'

interface SliceRule {
  artifact_id: string
  mode: 'full' | 'last_n_entries' | 'last_cycle' | 'summary_only'
  max_entries?: number
  max_tokens?: number
  never_truncate?: boolean
  source_weight?: SourceWeight
}

interface AssembledContext {
  system_prompt: string
  artifact_slices: Record<string, string>
  state_summary: string
  task: string
  failure_context?: string
  token_count: number
  truncated: string[]
}

interface ContextManagerConfig {
  artifact_slice_size: number
  summary_max_tokens: number
  system_prompt_max_tokens: number
  hard_ceiling: number
}
```

`hard_ceiling` is always 3,500 and is not configurable.

#### Assembly algorithm

```
assemble(role, state, config, map, failureReport?) → AssembledContext

1. Resolve assembly mode
   If task has TaskContextDeclaration → declared mode
   Else → inferred mode

2. System prompt (Component 1) — budget: ~500 tokens
   Fixed structure: role identity, constraints, output format, artifact list

3. Artifact slices (Component 2) — budget: ~2000 tokens
   If declared mode: load declared refs
   If inferred mode: load role default slices from §Context slices
   Apply per-artifact SliceRule (mode, max_entries, max_tokens)
   Enforce total token budget
   Truncate in source_weight order: inferred first, cycle_produced, user_defined last
   Record truncated artifact IDs

4. State summary (Component 3) — budget: ~300 tokens
   Generated from map.yaml — not by an LLM call

5. Task (Component 4) — budget: ~200 tokens
   Written by DAG runner based on current node and cycle state

6. Failure context (Component 5) — only on retry, budget: ~400 tokens
   If iteration > 1 AND failureReport present

7. Validate total token count ≤ hard_ceiling
   If exceeded: truncate lowest-priority slices

8. Return AssembledContext
```

#### Per-role slice tables (inferred mode)

| Role | Key slices | Never truncated |
|---|---|---|
| Designer | product-brief, constraints, system-description, architecture, requirements, cycle-charter, agent.md | requirements, architecture |
| Planner | architecture, requirements, cycle-charter, decisions (last 3), evaluation (last cycle) | — |
| Tester | requirements, test-plan | test-plan |
| Builder | requirements, architecture, plan, test-plan, test scripts, source files | — |
| Historian | cycle-charter, decisions | — |
| Evaluator | requirements, test-plan, evaluation criteria, run results | — |
| Debugger | requirements, test-plan, run artifacts, failure reports | — |
| Facilitator (scoping) | discovery artifacts, cycle-charter draft | — |

#### Truncation priority (lowest priority truncated first)

| Priority | Artifact |
|---|---|
| 1 (truncate first) | `doc:evaluation` |
| 2 | `doc:decisions` |
| 3 | `doc:plan` |
| 3.5 | `doc:build-plan` |
| 4 | `doc:test-plan` (except Tester) |
| 5 (truncate last) | `doc:research-findings` |
| — (never) | `doc:requirements`, `doc:architecture` |

`doc:requirements` and `doc:architecture` are never truncated. If they alone exceed budget, a warning is logged and the ceiling is temporarily raised for that call.

#### Slice loading modes

| Mode | Behavior |
|---|---|
| `full` | Entire artifact, no truncation unless total budget exceeded |
| `last_n_entries` | Last N entries (for append-only artifacts) |
| `last_cycle` | Most recent cycle's content only |
| `summary_only` | Pre-generated summary if available, else full with truncation |

**Acceptance criteria:**
- Context assembled for all 8+ in-scope roles
- System prompt = agent.md + role system_prompt from agents.yaml
- State summary includes cycle number, current node, iteration, planning_depth, intent
- Artifact slices loaded from file paths; missing files logged, not fatal
- Token budget enforced: assembled context never exceeds 3,500 tokens
- Truncation follows source_weight order: inferred → cycle_produced → user_defined
- `doc:requirements` and `doc:architecture` never truncated (ceiling raised if needed)
- Failure context injected when iteration > 1
- Failure context does not include passing categories
- Truncation logged in AssembledContext.truncated[]
- Inferred mode uses per-role slice tables
- Declared mode loads from TaskContextDeclaration.slices (prepared for VS5)

**Tests needed:**
- Unit: assemble() produces correct slices per role (8 roles)
- Unit: token budget enforced (mock oversized artifacts → truncation occurs)
- Unit: source_weight truncation order (inferred truncated before cycle_produced, before user_defined)
- Unit: never_truncate enforcement for requirements and architecture
- Unit: failure context injected on iteration 2, absent on iteration 1
- Unit: failure context excludes passing categories
- Unit: state summary contains all required fields
- Unit: missing artifact files handled gracefully (log warning, skip slice)
- Unit: SliceRule mode 'last_n_entries' loads only last N entries
- Unit: SliceRule mode 'last_cycle' loads only most recent cycle
- Unit: total token count in AssembledContext is accurate
- Unit: temporary ceiling raise when requirements + architecture exceed budget
- Unit: declared mode resolves TaskContextDeclaration.slices (prepared for VS5)
- Integration: full assembly for Designer role with real artifacts

**Target: ~18 tests (13 unit + 5 integration)**

---

### Phase E: REST Endpoint Alignment

**Spec reference:** `daemon-api-endpoints.md` (complete document)
**Implements:** Standard API envelopes, Zod request/response validation, remaining v4-relevant endpoints.

**Depends on:** Phase A+B (dispatch/validation endpoints), Phase D (context endpoints)

#### Standard response envelopes

```typescript
interface APIResponse<T> {
  ok: true
  data: T
  meta?: {
    request_id: string
    timestamp: string
  }
}

interface APIError {
  ok: false
  error: {
    code: string
    message: string
    details?: Record<string, unknown>
  }
  meta: {
    request_id: string
    timestamp: string
  }
}
```

All endpoints return either `APIResponse<T>` or `APIError`. `request_id` is UUIDv4. `timestamp` is ISO 8601.

#### Endpoint groups relevant to v4

| Group | Endpoints | Phase |
|---|---|---|
| Health & Info | `GET /health`, `GET /info` | VS1 (existing) |
| System State | `GET /system/state`, `POST /system/state/transition` | VS1 (existing) |
| Cycles | `POST /cycles/start`, `GET /cycles/current`, `POST /cycles/halt`, etc. | VS2 (existing) |
| DAG State | `GET /cycles/current/dag`, `GET /cycles/current/run` | VS2 (existing) |
| Scoping | `GET /scoping/draft`, `POST /scoping/response`, `POST /scoping/approve` | VS2 (existing) |
| Gates | `POST /cycles/current/approve`, `POST /cycles/current/revise` | VS2 (existing) |
| Summary | `GET /cycles/current/summary`, `GET /cycles/:id/snapshot` | VS2 (existing) |
| **Dispatch** | `GET /dispatch/status`, `GET /dispatch/jobs` | **v4 new** |
| **Validation** | `GET /validation/categories`, `GET /validation/runs/current` | **v4 new** |
| **Link Index** | `GET /links`, `GET /links/backlinks/:key`, `POST /links/reindex` | **v4 new** |
| **Context** | `GET /context/current`, `GET /context/slices` | **v4 new** |

#### New v4 endpoints

##### GET /api/v2/dispatch/status

```
Response 200: APIResponse<JobDispatchState>
```

Returns current worker pool state from `map.yaml → dispatch`.

##### GET /api/v2/dispatch/jobs

```
Response 200: APIResponse<{ jobs: Job[]; total: number }>
```

Returns all jobs for the current run.

##### GET /api/v2/validation/categories

```
Response 200: APIResponse<{ categories: ValidationCategory[]; gate: ValidationGate }>
```

Returns validation state from `map.yaml → validation`.

##### GET /api/v2/validation/runs/current

```
Response 200: APIResponse<RunManifest>
Response 404: APIError { code: 'no_current_run' }
```

Returns the current run manifest.

##### GET /api/v2/links

```
Query params: ?source=...&target=...&type=...
Response 200: APIResponse<{ links: ForwardLink[]; count: number }>
```

Query the link index with optional filters.

##### GET /api/v2/links/backlinks/:key

```
Response 200: APIResponse<{ backlinks: Backlink[] }>
Response 404: APIError { code: 'entity_not_found' }
```

Returns backlinks for a given entity key.

##### POST /api/v2/links/reindex

```
Response 200: APIResponse<{ link_count: number; duration_ms: number }>
```

Triggers a full link index rebuild.

##### GET /api/v2/context/current

```
Query params: ?role=designer
Response 200: APIResponse<AssembledContext>
```

Returns the assembled context for a given role (dry-run, does not affect cycle).

#### Zod validation

Every request body is validated with Zod before processing. Every response is wrapped in `APIResponse<T>` or `APIError`. Schema validation errors include field path.

```typescript
const TransitionRequestSchema = z.object({
  target: z.enum(['idle', 'discovering', 'cycling', 'halted', 'complete']),
  trigger: z.string().min(1),
  payload: z.record(z.unknown()).nullable().optional(),
})
```

**Acceptance criteria:**
- All existing endpoints wrapped in `APIResponse<T>` / `APIError` envelopes
- All new endpoints return correct response shape
- Zod schemas validate request bodies; invalid requests return 400 with field paths
- `request_id` (UUIDv4) present on all responses
- `timestamp` (ISO 8601) present on all responses
- Dispatch endpoints read from `map.yaml → dispatch`
- Validation endpoints read from `map.yaml → validation` and `last_run`
- Link index endpoints query the in-memory `LinkIndex`
- Context endpoint produces dry-run assembled context

**Tests needed:**
- Unit: `APIResponse<T>` wrapper serializes correctly
- Unit: `APIError` wrapper serializes with field paths
- Unit: Zod schema validation — valid request passes
- Unit: Zod schema validation — invalid request returns 400 with field path
- Integration: `GET /dispatch/status` returns pool state
- Integration: `GET /validation/categories` returns category list
- Integration: `GET /validation/runs/current` returns run manifest
- Integration: `GET /links` with filters returns matching links
- Integration: `GET /links/backlinks/:key` returns backlinks
- Integration: `POST /links/reindex` triggers full rebuild
- Integration: `GET /context/current?role=designer` returns assembled context

**Target: ~15 tests (4 unit + 11 integration)**

---

### Phase F: Integration Tests

**Spec reference:** Cross-cutting (all above phases)
**Implements:** End-to-end acceptance test for VS4.

**Test flow:**

```
1. Create temp project, run sle init, sle discover (solo mode)
2. POST /cycles/start with intent + depth: "deep" (activates full validation)
3. SCOPING → DESIGN → CRITIQUE (skipped at standard; deep activates it — test skips for VS4)
4. Verify DAG advances through PLAN → TEST → CONFIRM → BUILD → HISTORY
5. EXEC node triggers Docker worker pool
   - Verify DispatchPlan created with correct jobs
   - Verify static-check job enqueued at priority 0
   - Verify category fan-out after static-check passes
   - Verify results collected in .sle/runs/{run_id}/
6. VALIDATION_GATE evaluates deterministically
   - Verify RunManifest written with outcome
   - Verify category caching works on iteration 2
7. Link index contains structural_dag links from DAG node transitions
8. Context manager produces budgeted slices for each role
9. GET /dispatch/status returns correct pool state
10. GET /validation/categories returns correct category statuses
11. GET /links returns auto-generated links
12. Verify map.yaml updated correctly throughout
```

**Mock strategy:**
- Docker API: mock container creation, inject pre-configured results
- LLM: `NodeAwareMockLLM` from VS3
- File system: real temp directory

**Acceptance criteria:**
- Full cycle completes with Docker-mocked EXEC
- Worker pool creates correct number of jobs per iteration
- Validation gate produces correct pass/fail verdict
- FailureReport generated on gate failure (G24 format)
- Category caching prevents re-dispatch of passing categories
- Link index contains structural links after DAG completion
- Context manager produces slices under 3,500 tokens
- All new REST endpoints return correct data

**Target: ~8 integration tests**

---

## 4. Types Inventory

### Job dispatch types (Phase A)

```typescript
type JobType = 'static-check' | 'llm-check' | 'exec-check' | 'task-execution'
type JobStatus = 'queued' | 'preparing' | 'running' | 'collecting' | 'completed' | 'failed' | 'cancelled' | 'timed_out'
type JobPriority = 0 | 1 | 2 | 3
type JobErrorCode = 'docker_unavailable' | 'container_start_failed' | 'container_oom_killed' | 'container_timeout' | 'script_missing' | 'script_syntax_error' | 'context_pack_invalid' | 'result_parse_failed' | 'artifact_capture_failed' | 'unknown'
type WorkerStatus = 'idle' | 'busy' | 'draining' | 'dead'
interface Job { ... }
interface JobResult { ... }
interface JobError { ... }
interface Worker { ... }
interface WorkerPoolConfig { ... }
interface ContainerSpec { ... }
interface MountPoint { ... }
interface ResourceLimits { ... }
interface DispatchPlan { ... }
interface DispatchPlanJob { ... }
interface StaticGate { ... }
interface JobDispatchState { ... }
```

### Validation types (Phase B)

```typescript
interface StaticAnalysisResult { ... }
interface LLMCheckResult { ... }
interface ExecCheckResult { ... }
interface CategoryResult { ... }
interface GateResult { ... }
interface FailureReport { ... }
interface RunManifest { ... }
interface CategoryRunResult { ... }
interface ValidationCategory { ... }
interface ValidationGate { ... }
interface LastRun { ... }
```

### Link index types (Phase C)

```typescript
type LinkEntityKind = 'node' | 'document' | 'source_file' | 'test_file'
type AutoLinkType = 'structural_dag' | 'structural_declaration' | 'contextual_execution'
type LinkSource = { kind: 'node'; group: string; key: string } | { kind: 'document'; key: string }
type LinkTarget = { kind: 'node'; ... } | { kind: 'document'; ... } | { kind: 'source_file'; ... } | { kind: 'test_file'; ... }
interface Link { ... }
interface ForwardLink { ... }
interface Backlink { ... }
interface LinkIndex { ... }
interface FileEntry { ... }
interface FileIndex { ... }
interface DocumentEntry { ... }
interface DocumentIndex { ... }
interface ContextualLinkRecord { ... }
```

### Context manager types (Phase D)

```typescript
interface SliceRule { ... }
interface AssembledContext { ... }
interface ContextManagerConfig { ... }
```

---

## 5. API Endpoint Inventory

### New endpoints added in VS4

| Method | Path | Response 200 | Error codes |
|---|---|---|---|
| `GET` | `/dispatch/status` | `APIResponse<JobDispatchState>` | — |
| `GET` | `/dispatch/jobs` | `APIResponse<{ jobs: Job[]; total: number }>` | — |
| `GET` | `/validation/categories` | `APIResponse<{ categories: ValidationCategory[]; gate: ValidationGate }>` | — |
| `GET` | `/validation/runs/current` | `APIResponse<RunManifest>` | 404: `no_current_run` |
| `GET` | `/links` | `APIResponse<{ links: ForwardLink[]; count: number }>` | — |
| `GET` | `/links/backlinks/:key` | `APIResponse<{ backlinks: Backlink[] }>` | 404: `entity_not_found` |
| `POST` | `/links/reindex` | `APIResponse<{ link_count: number; duration_ms: number }>` | — |
| `GET` | `/context/current` | `APIResponse<AssembledContext>` | 400: `missing_role_param` |

**Total new VS4 endpoints: 8**
**Cumulative total (VS1–VS4): 41 of 85 endpoints (~48%)**

All existing endpoints from VS1–VS3 must be re-wrapped in `APIResponse<T>` / `APIError` envelopes (Phase E).

---

## 6. Test Strategy

### Unit tests per phase

| Phase | Test count (est.) | Key test areas |
|---|---|---|
| A: Job Dispatch Worker Pool | ~25 | Job queue, worker lifecycle, heartbeat, pool scaling, static gate, result collection |
| B: Tri-Phase Validation | ~20 | Sub-phase order, gate evaluation, category fan-out, caching, FailureReport |
| C: Document Link Index | ~18 | Wikilink parser, forward/backlinks, auto-link tiers, incremental update, file indexing |
| D: Context Manager Budgeting | ~18 | Per-role slices, token budget, truncation order, failure context, never_truncate |
| E: REST Endpoint Alignment | ~15 | Response envelopes, Zod validation, dispatch/validation/link/context endpoints |
| F: Integration Tests | ~8 | Full cycle with Docker-mocked EXEC, validation, link index, context assembly |

**Total estimated: ~104 new tests**
**Cumulative with VS1–VS3 (~326 tests): ~430 tests**

### Mock strategy

- **Docker API:** Mock Dockerode container creation and execution. Inject pre-configured exit codes, stdout, stderr per test scenario.
- **LLM:** Reuse `NodeAwareMockLLM` from VS3 extended with validation-category-aware responses.
- **File system:** Real temp directories for integration tests. Mock filesystem paths for unit tests.
- **Heartbeat:** Mock timer for heartbeat interval testing.

### Integration test structure

Phase F uses shared context (one temp dir, one daemon) running sequentially. Each step asserts intermediate state before proceeding. Docker API is mocked to inject controlled results per sub-phase.

---

## 7. File Inventory

New files created in this slice:

```
src/
  job-dispatch.ts              Phase A — DockerWorkerPool, DispatchPlan, result collection
  validation-engine.ts         Phase B — Tri-phase execution, gate evaluation, category caching
  link-index.ts                Phase C — LinkIndex manager, backlink computation, incremental update
  wikilink-parser.ts           Phase C — [[wikilink]] syntax extraction and resolution
  context-manager.ts           Phase D — (extended) 5-component assembly, SliceRule enforcement
  daemon.ts                    Phase E — (extended) new endpoints, Zod validation, response envelopes
  types.ts                     Phases A-E — (extended) Job, Worker, Link, Validation types
  tests/
    job-dispatch.test.ts       Phase A
    validation-engine.test.ts  Phase B
    link-index.test.ts         Phase C
    wikilink-parser.test.ts    Phase C
    context-manager-budget.test.ts  Phase D
    rest-endpoints.test.ts     Phase E
    v4-integration.test.ts     Phase F
```

---

## 8. Definition of Done

VS4 is complete when:

- [ ] All ~104 tests pass
- [ ] Docker worker pool creates containers, runs jobs, collects results, destroys containers
- [ ] Static gate blocks category jobs until static-check passes
- [ ] Category fan-out dispatches parallel llm-check + exec-check per category
- [ ] Deterministic gate produces correct pass/fail verdict from category results
- [ ] Category caching prevents re-dispatch of passing categories on retry
- [ ] FailureReport generated in G24 format on gate failure
- [ ] Link index persisted to `.sle/link-index/` with forward links + backlinks
- [ ] Wikilink parser handles all 6 forms
- [ ] Auto-linking Tier 1 (structural_dag + structural_declaration) generates links on DAG completion
- [ ] Context manager assembles 5-component window under 3,500-token ceiling
- [ ] Truncation follows source_weight order: inferred → cycle_produced → user_defined
- [ ] `doc:requirements` and `doc:architecture` never truncated
- [ ] All endpoints return `APIResponse<T>` or `APIError` with request_id + timestamp
- [ ] Zod validation on all request bodies with field-path errors on failure
- [ ] v4-integration.test.ts passes: full cycle with Docker-mocked validation, link index, context assembly
- [ ] Dev plan updated with commit hashes for all phases
