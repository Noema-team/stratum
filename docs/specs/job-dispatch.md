# Job Dispatch

**Type:** spec · **Status:** draft · **Updated:** 2026-04-22
**Depends on:** DDR-008, DDR-019, DDR-025
**Source material:** SLE-019 §Part 4, SLE-020 (job system), validation.md, dag-execution.md

## Overview

Job dispatch is the execution plane's orchestration layer. It manages the worker
pool that runs test scripts and validation checks inside Docker containers,
handles the full job lifecycle (queue, run, complete, fail), packages context
for container consumption, and collects structured results for the VALIDATION
gate.

The job dispatcher sits between two producers and one consumer:

1. **Producers** — the DAG EXEC node (cycle-scoped validation runs) and the
   Beads task system (declared tasks from SLE-019's sharding pipeline). Both
   produce units of work that need containerized execution.

2. **Consumer** — the VALIDATION gate, which evaluates the combined results of
   all dispatched jobs deterministically.

Job dispatch is L4 (Execution Plane). It does not call LLMs, does not modify
artifacts, and does not make decisions. It runs code in containers and reports
outcomes.

**Relationship to existing specs:**

- [dag-execution.md](dag-execution.md) — EXEC node delegates to job dispatch
- [validation.md](validation.md) — defines what runs inside containers (sub-phases, categories)
- [state-machine.md](state-machine.md) — job dispatch never changes system state
- [context-manager.md](context-manager.md) — produces the context packs that job dispatch injects into containers

**Canonical types:** [../reference/types.md](../reference/types.md).
**DDR decisions:** [../decisions/DECISION-BRIEFS.md](../decisions/DECISION-BRIEFS.md).

---

## Data model

### Job

A job is the fundamental unit of work. Each job represents one container
execution — a single validation category's sub-phase run, or a task-scoped
execution from the Beads system.

```typescript
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
```

### JobType

```typescript
type JobType =
  | 'static_check'
  | 'llm_check'
  | 'exec_check'
  | 'task_execution'
```

| Type | Source | Container | LLM |
|---|---|---|---|
| `static_check` | EXEC node (validation) | Yes | No |
| `llm_check` | EXEC node (validation) | Yes | Yes (inside container) |
| `exec_check` | EXEC node (validation) | Yes | No |
| `task_execution` | Beads task dispatch | Yes | Varies by task |

### JobStatus

```typescript
type JobStatus =
  | 'queued'
  | 'preparing'
  | 'running'
  | 'collecting'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
```

Transition diagram:

```
queued → preparing → running → collecting → completed
                                    │
                                    ├──→ failed
                                    ├──→ timed_out
                                    └──→ cancelled
```

Jobs may transition to `cancelled` from `queued` or `preparing` only. Once
`running`, a job follows through to a terminal state.

### JobPriority

```typescript
type JobPriority = 0 | 1 | 2 | 3
```

| Priority | Value | Used for |
|---|---|---|
| Critical | 0 | `static_check` (must pass before others run) |
| High | 1 | `exec_check`, `task_execution` |
| Normal | 2 | `llm_check` |
| Low | 3 | Deferred re-runs, optional checks |

### SubPhase

```typescript
type SubPhase = 'static-check' | 'llm-check' | 'exec-check'
```

From [validation.md](validation.md). Execution order is fixed:
`static-check` → `llm-check` → `exec-check`. A `static_check` job must
complete before any `llm_check` or `exec_check` jobs for the same iteration
are released from the queue.

### JobResult

```typescript
interface JobResult {
  exit_code: number
  stdout: string
  stderr: string
  artifacts: Record<string, string>
  duration_ms: number
  metrics: Record<string, number>
}
```

`artifacts` maps artifact name to relative path within the run directory:
`{ "result_json": "tests/correctness/result.json" }`.

`metrics` captures quantitative measurements from the container run:
`{ "heap_max_mb": 128, "cpu_peak_pct": 45 }`.

### JobError

```typescript
interface JobError {
  code: JobErrorCode
  message: string
  recoverable: boolean
  container_exit_code: number | null
  docker_error: string | null
  retry_count: number
}
```

### JobErrorCode

```typescript
type JobErrorCode =
  | 'docker_unavailable'
  | 'container_start_failed'
  | 'container_oom_killed'
  | 'container_timeout'
  | 'script_missing'
  | 'script_syntax_error'
  | 'context_pack_invalid'
  | 'result_parse_failed'
  | 'artifact_capture_failed'
  | 'unknown'
```

### Worker

```typescript
interface Worker {
  id: string
  status: WorkerStatus
  container_id: string | null
  current_job_id: string | null
  last_heartbeat: string
  total_jobs_completed: number
  total_errors: number
}
```

### WorkerStatus

```typescript
type WorkerStatus = 'idle' | 'busy' | 'draining' | 'dead'
```

| Status | Meaning |
|---|---|
| `idle` | Available for job assignment |
| `busy` | Executing a job |
| `draining` | Completing current job, will not accept new assignments |
| `dead` | Unresponsive — heartbeat missed for 3 consecutive intervals |

### WorkerPoolConfig

```typescript
interface WorkerPoolConfig {
  max_workers: number
  min_workers: number
  idle_timeout_ms: number
  heartbeat_interval_ms: number
  max_heartbeat_misses: number
  container_startup_timeout_ms: number
}
```

Populated from `validation.yaml → container` plus pool sizing heuristics:

| Field | Default | Source |
|---|---|---|
| `max_workers` | `min(cpu_count, 8)` | System |
| `min_workers` | `1` | System |
| `idle_timeout_ms` | `30000` | `validation.yaml` |
| `heartbeat_interval_ms` | `5000` | System |
| `max_heartbeat_misses` | `3` | System |
| `container_startup_timeout_ms` | `60000` | `validation.yaml` |

### ContainerSpec

```typescript
interface ContainerSpec {
  image: string
  install_command: string
  timeout_ms: number
  env: Record<string, string>
  mount_points: MountPoint[]
  resource_limits: ResourceLimits
  network_mode: 'none' | 'bridge'
}
```

`image` and `install_command` come from `validation.yaml → container`. Per-job
overrides are not supported — all jobs in a cycle use the same base image.

### MountPoint

```typescript
interface MountPoint {
  host_path: string
  container_path: string
  read_only: boolean
}
```

Standard mount layout for every container:

| Host path | Container path | Read-only | Content |
|---|---|---|---|
| `{run_dir}` | `/sle/run` | No | Run output directory |
| `{project_root}` | `/sle/project` | Yes | Implementation source |
| `{scripts_dir}` | `/sle/scripts` | Yes | Test scripts |
| `{context_pack_path}` | `/sle/context/context-pack.md` | Yes | Assembled context |

### ResourceLimits

```typescript
interface ResourceLimits {
  memory_mb: number
  cpu_cores: number
  disk_mb: number
  pids_max: number
}
```

| Resource | Default | Enforced by |
|---|---|---|
| `memory_mb` | `512` | Docker `--memory` |
| `cpu_cores` | `1.0` | Docker `--cpus` |
| `disk_mb` | `512` | Docker `--storage-opt` (where supported) |
| `pids_max` | `256` | Docker `--pids-limit` |

### ContextPack

The context pack is the bridge between the context manager (L2) and the
container (L4). It is a single markdown file containing all information the
containerized scripts need.

```typescript
interface ContextPack {
  run_id: string
  cycle: number
  iteration: number
  category: string | null
  task_id: string | null
  sub_phase: SubPhase | null
  assembled_context_path: string
  validation_config_path: string
  artifact_paths: string[]
}
```

Written to `.sle/runs/{run_id}/ai/context-pack.md` by the gate node (per
validation.md). The job dispatcher does not generate context packs — it reads
them and injects them into containers.

### DispatchPlan

Created at the start of each EXEC node entry. The dispatch plan describes every
job that will run this iteration, their dependencies, and the expected fan-out
structure.

```typescript
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

The dispatch plan is immutable once created. It is the single source of truth
for what runs this iteration.

### map.yaml tracked state

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
Read by the status API for observability.

---

## Behavior

### Dispatch lifecycle within a cycle

The job dispatcher activates when the DAG enters the EXEC node and deactivates
after all results are collected and the container is destroyed.

```
DAG enters EXEC node
    │
    ▼
1. Create DispatchPlan
   Read active categories from map.yaml
   Generate job IDs for each sub-phase × category
   Wire dependencies (static gate blocks everything)
    │
    ▼
2. Create run directory
   .sle/runs/{run_id}/
   Write manifest stub
    │
    ▼
3. Enqueue static_check job
   Priority 0 (critical)
    │
    ▼
4. Await static_check result
   │
   ├── PASS → release llm_check + exec_check jobs to queue
   │          all categories fan out in parallel
   │
   └── FAIL → skip remaining jobs
              mark all categories as skipped
              proceed to collection
    │
    ▼
5. Dispatch worker pool
   Workers pull jobs from priority queue
   Each job: create container → inject context → run → collect
    │
    ▼
6. Collect results
   Per-job: capture stdout, stderr, exit code, artifacts
   Write to .sle/runs/{run_id}/tests/{category}/result.json
    │
    ▼
7. Finalize run directory
   Write manifest.json
   Write context-pack.md (code-generated, not LLM)
   Write tests/summary.json
    │
    ▼
8. Destroy container
    │
    ▼
DAG proceeds to VALIDATION_GATE
```

### Worker pool management

#### Pool sizing

The pool starts at `min_workers` and scales up to `max_workers` based on queue
depth. Scaling is additive — one worker added per scaling event.

```
scaleUp(current_size, queue_depth, max_workers):
  if queue_depth > 0 AND current_size < max_workers:
    return current_size + 1
  return current_size
```

Scale-down occurs when a worker has been `idle` for `idle_timeout_ms`. Idle
workers are destroyed (container removed) but the worker slot is retained at
`min_workers`.

```
scaleDown(workers, min_workers):
  for worker in workers where status == 'idle' AND idle_duration > idle_timeout_ms:
    if total_active_workers > min_workers:
      worker.status = 'draining'
      destroy worker container
```

#### Worker lifecycle

```
Worker created (idle)
    │
    ▼
Job assigned → status: busy
    │
    ▼
Create container from ContainerSpec
    │
    ├── container fails → mark job failed, worker stays idle
    │
    └── container created → inject context pack
        │
        ▼
    Execute job script in container
        │
        ├── timeout → kill container, mark job timed_out
        │
        └── container exits
            │
            ▼
        Capture results (stdout, stderr, artifacts)
            │
            ├── capture fails → mark job failed (artifact_capture_failed)
            │
            └── capture succeeds → write to run directory
                │
                ▼
            Destroy container
                │
                ▼
            Worker status: idle
```

#### Heartbeat monitoring

Each worker sends a heartbeat every `heartbeat_interval_ms`. The dispatcher
checks heartbeats on a fixed interval:

```
checkHeartbeats(workers):
  for worker in workers:
    time_since_heartbeat = now - worker.last_heartbeat
    if time_since_heartbeat > heartbeat_interval_ms * max_heartbeat_misses:
      worker.status = 'dead'
      if worker.current_job_id:
        mark job as failed (error: worker_dead)
        requeue job if retry_count < max_retries
```

Dead workers are replaced by spawning new workers up to `min_workers`.

### Category fan-out

After `static_check` passes, the dispatcher releases all category jobs to the
queue. The fan-out structure per iteration:

```
static_check (priority 0, single job)
    │
    ├── PASS
    │       │
    │       ▼
    │   ┌─────────────────────────────────────────────┐
    │   │  Category fan-out (all active, in parallel)  │
    │   │                                               │
    │   │  correctness      performance     security   │
    │   │    ├── llm_check    ├── llm_check   ├── ...  │
    │   │    └── exec_check   └── exec_check  └── ...  │
    │   └─────────────────────────────────────────────┘
    │
    └── FAIL
            │
            ▼
        All category jobs cancelled
        VALIDATION_GATE receives static failure only
```

Within each category, `llm_check` and `exec_check` run in parallel (no
interdependency). Both depend on `static_check` passing, but not on each other.

Per-category job creation:

```
for category in active_categories:
  if category.method in ['both', 'llm']:
    create job(type: 'llm_check', category: category.name, priority: 2)
  if category.method in ['both', 'executable']:
    create job(type: 'exec_check', category: category.name, priority: 1)
```

Job IDs are deterministic within a run:

```
job_id = "{run_id}-{sub_phase}-{category}"
```

Example: `c4-i2-static-check-all`, `c4-i2-llm-check-correctness`,
`c4-i2-exec-check-security`.

### Context injection

Before a container starts, the dispatcher prepares the execution environment:

1. **Resolve context pack** — read the pre-assembled context pack from
   `.sle/runs/{run_id}/ai/context-pack.md`

2. **Resolve task context** — if `task_context_declaration` is present on the
   job, resolve declared artifact references to file paths (DDR-025)

3. **Set environment variables** in the container:

| Variable | Value | Purpose |
|---|---|---|
| `SLE_RUN_DIR` | `/sle/run` | Where scripts write results |
| `SLE_RUN_ID` | `{run_id}` | Unique run identifier |
| `SLE_CYCLE` | `{cycle_number}` | Current cycle |
| `SLE_ITERATION` | `{iteration_number}` | Current iteration |
| `SLE_CATEGORY` | `{category_name}` | Category being tested |
| `SLE_SUB_PHASE` | `{sub_phase}` | Current sub-phase |
| `SLE_PROJECT_ROOT` | `/sle/project` | Project source mount |
| `SLE_SCRIPTS_DIR` | `/sle/scripts` | Test scripts mount |
| `SLE_TIMEOUT_MS` | `{timeout_ms}` | Script execution deadline |

4. **Mount volumes** — standard mount layout (see MountPoint table)

5. **Write per-job context file** to the run directory:

```typescript
interface JobContext {
  job_id: string
  sub_phase: SubPhase
  category: string | null
  validation_config: ValidationRuleCategory | null
  pass_criteria: Record<string, unknown>
  expected_output_format: 'json'
}
```

Written to `$RUN_DIR/.sle-job-context.json` inside the container. Scripts read
this to understand what is expected.

### Result collection

After a container exits, the dispatcher captures results in this order:

```
1. Read container exit code
   0 → proceed to artifact capture
   non-zero → job may still have partial results

2. Capture stdout and stderr
   Read from container logs (docker logs)
   Truncate at 64KB per stream (configurable)
   Write to $RUN_DIR/.sle-stdout.log and $RUN_DIR/.sle-stderr.log

3. Capture structured result
   Read $RUN_DIR/tests/{category}/result.json from container
   Parse as JSON
   Validate against expected schema per sub_phase:
     - static_check: StaticAnalysisResult
     - llm_check: LLMCheckResult
     - exec_check: ExecCheckResult
   If parse fails → mark job as failed (result_parse_failed)

4. Capture additional artifacts
   Per run_artifacts schema in validation.yaml
   Copy declared artifact paths from container to host run directory
   Skip missing artifacts (log warning)

5. Capture metrics
   Read Docker stats snapshot (memory peak, CPU usage)
   Merge with any metrics the script wrote to $RUN_DIR/metrics/

6. Write JobResult
   Combine all captured data into JobResult
   Write to $RUN_DIR/.sle-job-result.json

7. Update job status
   exit_code == 0 AND result parsed → completed
   exit_code != 0 AND result parsed → failed (with result attached)
   exit_code != 0 AND no result → failed (error only)
```

### Task dispatch mode

When jobs originate from Beads tasks (SLE-019 Mode 5), the dispatch flow
changes:

```
bd ready → surfaces task in dependency order
    │
    ▼
Dispatcher reads task's TaskContextDeclaration from Beads issue notes
    │
    ▼
Resolve declared artifact refs → context pack
    │
    ▼
Create job(type: 'task_execution', task_id: beads_issue_id)
    │
    ▼
Execute in container with declared context
    │
    ▼
Collect result → update Beads issue with outcome
```

Task dispatch uses the same worker pool and container lifecycle as cycle
validation. The difference is the context source (declared vs inferred) and the
result routing (Beads update vs VALIDATION_GATE).

Task dispatch is mutually exclusive with cycle validation dispatch. The worker
pool serves one mode at a time:

| Active mode | Trigger | Pool ownership |
|---|---|---|
| Cycle validation | DAG enters EXEC node | EXEC node owns pool until gate evaluation |
| Task dispatch | `bd ready` returns a task | Pool acquired per task, released after completion |

If the DAG is in `cycling` state, cycle validation takes priority. Task dispatch
waits until the cycle completes or halts.

### Container lifecycle

Each job gets a fresh container. No container reuse between jobs, even within
the same iteration.

```
createContainer(spec, job):
  1. Pull image if not cached (timeout: container_startup_timeout_ms)
  2. Create container with:
     - Image: spec.image
     - Env: spec.env + job-specific vars
     - Mounts: spec.mount_points
     - Resources: spec.resource_limits
     - Network: spec.network_mode
     - WorkDir: /sle/run
  3. Execute install_command (timeout: container_startup_timeout_ms)
  4. Return container_id

runContainer(container_id, command, timeout_ms):
  1. Execute command in container
  2. Stream stdout/stderr to job logger
  3. Wait for exit with timeout
     - Timeout reached → SIGKILL container, return timed_out
  4. Return exit code

destroyContainer(container_id):
  1. Force remove container (ignore errors)
  2. Remove associated volumes
  3. Return success (always — cleanup is best-effort)
```

Container destruction is guaranteed at the end of every job, even on error.
The dispatcher runs a cleanup sweep at the start of each EXEC node to remove
any orphaned containers from previous runs (e.g., after daemon crash).

### Job queue

The job queue is an in-memory priority queue. It is not persisted — if the
daemon crashes during EXEC, the iteration is re-run from scratch (no partial
resume).

Queue ordering:

```
compare(a, b):
  if a.priority != b.priority: return a.priority - b.priority
  if a.created_at != b.created_at: return a.created_at - b.created_at
  return alphabetical by job_id
```

Jobs are dequeued when a worker becomes available. The dispatcher does not
pre-assign jobs — workers pull from the queue.

Blocked jobs (waiting on `static_check`) are held in a pending set, not in the
main queue. When `static_check` completes:

```
releaseBlockedJobs(static_result, pending_set, queue):
  if static_result.passed:
    for job in pending_set:
      queue.enqueue(job)
  else:
    for job in pending_set:
      job.status = 'cancelled'
```

### Dispatch plan generation

When the DAG enters the EXEC node, the dispatcher generates the dispatch plan
for this iteration:

```
generateDispatchPlan(cycle, iteration, categories, run_id):
  plan = { run_id, cycle_id, iteration, jobs: [], static_gate: null }

  static_job = {
    job_type: 'static_check',
    category: null,
    sub_phase: 'static-check',
    depends_on: [],
    priority: 0
  }
  plan.jobs.push(static_job)
  plan.static_gate = { job_id: static_job.id, blocks: [] }

  for category in categories:
    if category.status == 'passed':
      continue

    if category.method in ['both', 'llm']:
      llm_job = {
        job_type: 'llm_check',
        category: category.name,
        sub_phase: 'llm-check',
        depends_on: [static_job.id],
        priority: 2
      }
      plan.jobs.push(llm_job)
      plan.static_gate.blocks.push(llm_job.id)

    if category.method in ['both', 'executable']:
      exec_job = {
        job_type: 'exec_check',
        category: category.name,
        sub_phase: 'exec-check',
        depends_on: [static_job.id],
        priority: 1
      }
      plan.jobs.push(exec_job)
      plan.static_gate.blocks.push(exec_job.id)

  return plan
```

Category caching (per validation.md): categories with `status: passed` from a
previous iteration are excluded from the dispatch plan entirely. Their
`CategoryResult` is preserved and merged at the gate.

### Container image management

The dispatcher maintains a local image cache. On first run per cycle:

1. Check if `container.base_image` exists in local Docker cache
2. If not, pull the image (timeout: `container_startup_timeout_ms`)
3. Tag the pulled image with the cycle ID for tracking

Image pulls are not retried on failure — if the image cannot be pulled, the
EXEC node halts the cycle (`docker_unavailable` error).

The dispatcher does not build custom images. All customization happens through:
- Mount points (injecting project source, scripts, and context)
- Environment variables (runtime configuration)
- Install command (dependency installation at container start)

### Install command execution

The `container.install_command` runs once per container creation, before the
job's main command. It installs project dependencies:

```
createAndPrepareContainer(spec, job):
  container_id = createContainer(spec, job)
  exit_code = runContainer(container_id, spec.install_command, spec.timeout_ms)
  if exit_code != 0:
    destroyContainer(container_id)
    raise ContainerStartFailed(install_command_failed)
  return container_id
```

If the install command fails, the container is destroyed and the job is marked
as failed with `container_start_failed`. The install command is not retried.

---

## API contract

### Internal API (daemon-to-dispatcher)

The dispatcher exposes an internal API used by the DAG runner. These endpoints
are not exposed to external clients.

#### Create dispatch plan

```
POST /internal/dispatch/plan

Request:
{
  "cycle_id":       string,
  "iteration":      number,
  "categories":     ValidationRuleCategory[],
  "run_id":         string,
  "mode":           "cycle_validation" | "task_execution"
}

Response 200:
{
  "plan":           DispatchPlan,
  "total_jobs":     number,
  "blocked_jobs":   number
}
```

#### Start dispatch

```
POST /internal/dispatch/start

Request:
{
  "plan_id":        string,
  "context_pack":   string,
  "container_spec": ContainerSpec
}

Response 200:
{
  "dispatch_id":    string,
  "workers_spawned": number,
  "started_at":     string
}

Response 409:
{
  "error":          "dispatch_already_active",
  "reason":         "A dispatch is already running for this cycle."
}
```

#### Get dispatch status

```
GET /internal/dispatch/{dispatch_id}

Response 200:
{
  "dispatch_id":    string,
  "plan_id":        string,
  "status":         "running" | "completed" | "failed",
  "total_jobs":     number,
  "completed_jobs": number,
  "failed_jobs":    number,
  "pending_jobs":   number,
  "workers": {
    "total":        number,
    "idle":         number,
    "busy":         number,
    "dead":         number
  },
  "started_at":     string,
  "completed_at":   string | null
}
```

#### Collect results

```
POST /internal/dispatch/{dispatch_id}/collect

Response 200:
{
  "dispatch_id":    string,
  "results":        JobResult[],
  "errors":         JobError[],
  "run_dir":        string,
  "manifest_path":  string
}

Response 409:
{
  "error":          "dispatch_not_complete",
  "completed_jobs": number,
  "total_jobs":     number
}
```

#### Cancel dispatch

```
POST /internal/dispatch/{dispatch_id}/cancel

Response 200:
{
  "dispatch_id":    string,
  "cancelled_jobs": number,
  "workers_stopped": number
}
```

#### Dispatch a single task

```
POST /internal/dispatch/task

Request:
{
  "task_id":        string,
  "context_declaration": TaskContextDeclaration,
  "container_spec": ContainerSpec
}

Response 200:
{
  "job_id":         string,
  "dispatch_id":    string,
  "status":         "queued"
}

Response 409:
{
  "error":          "pool_busy",
  "reason":         "Worker pool is owned by a cycle validation run."
}
```

### External API (user-facing)

#### Get dispatch status

```
GET /api/v2/cycles/{cycle_id}/dispatch

Response 200:
{
  "active":             boolean,
  "mode":               "cycle_validation" | "task_execution" | null,
  "total_jobs":         number,
  "completed_jobs":     number,
  "failed_jobs":        number,
  "workers": {
    "total":            number,
    "idle":             number,
    "busy":             number
  },
  "current_sub_phase":  SubPhase | null,
  "category_progress":  Record<string, {
    "llm_check":        "pending" | "running" | "completed" | "failed" | "skipped",
    "exec_check":       "pending" | "running" | "completed" | "failed" | "skipped"
  }>
}

Response 404:
{
  "error": "cycle_not_found"
}
```

#### Get job detail

```
GET /api/v2/cycles/{cycle_id}/dispatch/jobs/{job_id}

Response 200:
{
  "job_id":       string,
  "type":         JobType,
  "status":       JobStatus,
  "category":     string | null,
  "sub_phase":    SubPhase | null,
  "created_at":   string,
  "started_at":   string | null,
  "completed_at": string | null,
  "duration_ms":  number | null,
  "result":       JobResult | null,
  "error":        JobError | null
}

Response 404:
{
  "error": "job_not_found"
}
```

### WebSocket events

```
event: dispatch.started
{
  "cycle_id":      string,
  "dispatch_id":   string,
  "total_jobs":    number,
  "mode":          "cycle_validation" | "task_execution",
  "timestamp":     string
}

event: dispatch.job_status_changed
{
  "cycle_id":      string,
  "dispatch_id":   string,
  "job_id":        string,
  "previous":      JobStatus,
  "current":       JobStatus,
  "timestamp":     string
}

event: dispatch.static_gate_passed
{
  "cycle_id":      string,
  "dispatch_id":   string,
  "released_jobs": string[],
  "timestamp":     string
}

event: dispatch.static_gate_failed
{
  "cycle_id":      string,
  "dispatch_id":   string,
  "cancelled_jobs": string[],
  "timestamp":     string
}

event: dispatch.category_completed
{
  "cycle_id":      string,
  "category":      string,
  "passed":        boolean,
  "duration_ms":   number,
  "timestamp":     string
}

event: dispatch.completed
{
  "cycle_id":      string,
  "dispatch_id":   string,
  "total_jobs":    number,
  "completed":     number,
  "failed":        number,
  "duration_ms":   number,
  "timestamp":     string
}

event: dispatch.worker_status_changed
{
  "worker_id":     string,
  "previous":      WorkerStatus,
  "current":       WorkerStatus,
  "timestamp":     string
}
```

Full event catalogue: [../reference/websocket-events.md](../reference/websocket-events.md).

---

## Error cases

### Container errors

| Error | Condition | Response |
|---|---|---|
| `docker_unavailable` | Docker daemon not running or unreachable | Halt cycle (unrecoverable). Log docker error. |
| `container_start_failed` | Container creation or install command failed | Mark job failed. Retry once. If retry fails, halt cycle. |
| `container_oom_killed` | Container exceeded memory limit | Mark job failed with `container_oom_killed`. Not retried — indicates resource issue. |
| `container_timeout` | Job exceeded `timeout_ms` | SIGKILL container. Mark job `timed_out`. Not retried. |
| `image_pull_failed` | Base image cannot be pulled | Halt cycle (unrecoverable). Suggest checking image name and network. |

### Script errors

| Error | Condition | Response |
|---|---|---|
| `script_missing` | Expected test script not found in container | Halt cycle (unrecoverable). Script should exist from BUILD phase. |
| `script_syntax_error` | Test script has syntax errors, cannot execute | Mark job failed. Not retried — requires BUILD fix. |
| `result_parse_failed` | Script output does not match expected JSON schema | Mark job failed. Capture raw stdout for debugging. |
| `artifact_capture_failed` | Expected artifact file missing from container after run | Mark job failed. Log missing paths. Partial results may still be usable. |

### Worker errors

| Error | Condition | Response |
|---|---|---|
| `worker_dead` | Worker missed 3 consecutive heartbeats | Mark current job failed. Requeue job (if retry budget allows). Spawn replacement worker. |
| `worker_spawn_failed` | Cannot create new worker (Docker error) | Log error. Continue with remaining workers. If all workers dead, halt cycle. |
| `pool_exhausted` | All workers dead and cannot spawn replacements | Halt cycle (unrecoverable). |

### Context errors

| Error | Condition | Response |
|---|---|---|
| `context_pack_invalid` | Context pack file missing or malformed | Halt cycle (unrecoverable). Context assembly should have produced this. |
| `declared_ref_unresolved` | TaskContextDeclaration references artifact that does not exist | Fall back to inferred context. Log warning. |
| `mount_failed` | Volume mount fails on container creation | Mark job failed. Retry once with fresh container. |

### Dispatch errors

| Error | Condition | Response |
|---|---|---|
| `dispatch_already_active` | Attempt to start dispatch while one is running | 409. Only one dispatch per cycle. |
| `dispatch_not_complete` | Attempt to collect results before all jobs finish | 409. Poll until complete. |
| `plan_generation_failed` | Cannot generate dispatch plan (no active categories) | Halt cycle (no work to do). |
| `orphaned_containers` | Containers from previous daemon run detected at startup | Log warning. Destroy all orphaned containers. Proceed. |

### Error recovery strategy

| Error class | Recovery | Retry budget |
|---|---|---|
| Transient (Docker hiccup, network blip) | Retry once | 1 |
| Resource (OOM, timeout) | Fail job, continue | 0 |
| Structural (missing script, bad config) | Halt cycle | 0 |
| Worker death | Requeue job | 1 |

Retries create a fresh container. No retry reuses the container from the failed
attempt.

---

## Constraints

1. **One dispatch per cycle.** At most one active dispatch per cycle. The DAG
   EXEC node owns the worker pool until all jobs complete or the dispatch is
   cancelled.

2. **Fresh container per job.** No container reuse. Each job gets a new
   container that is destroyed after result capture. This guarantees isolation
   between categories and between iterations.

3. **No LLM calls.** The dispatcher does not call LLMs. It runs scripts in
   containers and reports outcomes. LLM calls for `llm_check` happen inside
   the container (the test script makes the LLM call), not in the dispatcher.

4. **No artifact modification.** The dispatcher reads artifacts (context packs,
   test scripts, source code) and writes results (run directory). It never
   modifies project artifacts, rule files, or `map.yaml` directly.

5. **No state transitions.** The dispatcher does not change `meta.status`,
   cycle flags, or iteration counters. State transitions are the DAG runner's
   responsibility.

6. **Static gate is absolute.** `static_check` must pass before any other
   sub-phase runs. No override, no skip, no parallel release. The static gate
   is the first and only synchronization point in the dispatch plan.

7. **Category fan-out is parallel.** After the static gate passes, all
   category jobs (`llm_check` and `exec_check`) run in parallel. There is no
   ordering between categories.

8. **Within-category sub-phase parallelism.** `llm_check` and `exec_check` for
   the same category run in parallel. No ordering between them.

9. **Category caching respected.** Categories with `status: passed` from a
   previous iteration are excluded from the dispatch plan. The dispatcher does
   not re-run passing categories.

10. **Container isolation.** Containers run with `network_mode: none` for
    `exec_check` jobs (no network access). `llm_check` and `static_check` jobs
    may use `network_mode: bridge` if the LLM endpoint requires network access.

11. **Resource limits enforced.** Every container is created with memory, CPU,
    disk, and PID limits. No container runs unbounded.

12. **Timeout is hard.** The `timeout_ms` from `validation.yaml → container` is
    enforced at the Docker level. When exceeded, the container is SIGKILL'd.
    The job is marked `timed_out`, not `failed`.

13. **Result schema validation.** Every captured result JSON is validated
    against the expected schema for the sub-phase before being accepted. Invalid
    results are treated as failures.

14. **Orphan cleanup.** At the start of each EXEC node, the dispatcher scans
    for containers labeled with the cycle ID and destroys any that exist. This
    handles daemon crash recovery.

15. **Deterministic job IDs.** Job IDs are derived from the run ID, sub-phase,
    and category name. They are not random UUIDs. This enables log correlation
    and debugging.

16. **Queue is in-memory.** The job queue is not persisted. Daemon crash during
    EXEC causes the iteration to restart from scratch. No partial results are
    preserved.

17. **Worker pool bounded.** The pool never exceeds `max_workers`. If all
    workers are busy, jobs wait in the queue. No unbounded concurrency.

18. **Task dispatch yields to cycle.** When the system is in `cycling` state,
    task dispatch is blocked. The worker pool is exclusively owned by the
    active cycle's EXEC node.

---

## Open questions

| ID | Question | Impact | Status |
|---|---|---|---|
| JD-001 | Should the dispatcher support container image building from a Dockerfile (for projects that need custom build tools), or is mounting + install command sufficient? | Container flexibility, startup time | Open |
| JD-002 | What is the maximum wall-clock timeout for the entire dispatch (all jobs combined) before forcing a halt, independent of per-job timeouts? | Resource bounding, UX responsiveness | Open |
| JD-003 | Should `llm_check` containers share a persistent LLM connection pool, or does each container open its own connection? | LLM API rate limits, connection efficiency | Open |
| JD-004 | Should the dispatcher persist job results to disk incrementally (as each job completes) or batch-write at the end? | Crash recovery granularity, I/O pattern | Open |
| JD-005 | Can users configure per-category resource limits (e.g., performance tests get more memory), or is one size fits all? | Resource fairness, cost | Open |
| JD-006 | Should the dispatcher support GPU passthrough for categories that require GPU execution (e.g., ML model testing)? | Hardware support, scheduling complexity | Open |
| JD-007 | What happens when the Docker disk fills up mid-dispatch? Should the dispatcher pre-check available disk space? | Reliability, resource exhaustion handling | Open |
| JD-008 | Should task dispatch support concurrent tasks (multiple workers executing different Beads tasks simultaneously), or is it strictly one task at a time? | Throughput, pool management complexity | Open |
| JD-009 | Should the dispatcher expose a streaming API for container stdout/stderr (real-time log tailing), or is post-completion capture sufficient? | Debugging UX, observability | Open |
| JD-010 | Should `static_check` be parallelized internally (lint, typecheck, complexity in parallel), or run sequentially as a single job? | Static check latency, simplicity | Open |
