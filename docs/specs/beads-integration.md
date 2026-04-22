# Beads Integration

**Type:** spec · **Status:** draft · **Updated:** 2026-04-22
**Depends on:** DDR-024, DDR-021, DDR-025
**Source material:** SLE-006 (full rewrite)
**Resolves:** G37, G29

## Overview

Beads is a Git-native, Dolt-powered issue tracker designed for AI agent
workflows. The SLE daemon integrates with Beads through a `TaskStore` provider
interface — it does not re-implement Beads functionality. When Beads is
unavailable (local-only mode), the system falls back to a local task file.

Beads solves three problems for SLE:

1. **Agent memory across sessions.** Issues persist decisions, blockers, and
   context across daemon restarts and context window resets.
2. **Dependency-aware task discovery.** `bd ready` returns only tasks with no
   open blockers — agents never pick up blocked work.
3. **Semantic compaction.** `bd compact` summarises old closed issues using an
   LLM, replacing naive truncation with semantic memory decay.

The integration surface is narrow: the daemon calls into a `TaskStore`
implementation, which either delegates to `bd` CLI commands (BeadsTaskStore) or
reads/writes `.sle/tasks.yaml` (LocalTaskStore). The DAG runner never shells
out to `bd` directly.

**Three-remote model (context):**

```
code remote (git)
  └── source code, rule files, agent.md, map.yaml

issues remote (dolt — Beads)          ← Beads owns this entirely
  └── .beads/ directory
  └── Dolt database
  └── independent history from code

docs remote (git — .server)
  └── documentation artifacts
```

The issues remote has its own history, branches, and sync cycle. SLE never
merges it with the code remote. Beads manages it via `bd push` / `bd pull`.

---

## Data model

### TaskStore provider interface

The provider interface abstracts task persistence. Selected at `sle init`,
immutable within a session.

```typescript
interface TaskStore {
  createTask(task: Omit<SLETask, 'id' | 'created_at' | 'updated_at'>): Promise<SLETask>
  getReadyTasks(): Promise<SLETask[]>
  updateStatus(id: string, status: SLETask['status']): Promise<void>
  closeTask(id: string): Promise<void>
  getStale(): Promise<SLETask[]>
}
```

Two implementations:

| Provider | Storage | When |
|---|---|---|
| `BeadsTaskStore` | Dolt remote via `bd` CLI | Default — full feature parity, cross-device sync |
| `LocalTaskStore` | `.sle/tasks.yaml` | Local-only mode — no DoltHub account needed |

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

Both providers produce and consume the same `SLETask` shape. The context manager
does not know which provider is active — it calls `getReadyTasks()` and receives
`SLETask[]` regardless.

### TaskContextDeclaration

```typescript
interface TaskContextDeclaration {
  task_id: string
  slices: ArtifactRef[]
  intent: string
}
```

When present on a task, the context manager enters `declared` assembly mode.
See [context-manager.md](context-manager.md) §Assembly modes.

### Session state

```typescript
interface SessionState {
  session_id: string
  daemon_pid: number
  claimed_task: string
  claimed_at: string
  cycle: number
  iteration: number
}
```

Stored at `.sle/session-state.json`. Written immediately after a task is
claimed. Deleted on clean exit after claim resolution. Its presence on daemon
start indicates the previous session exited uncleanly.

### ResolveExit outcome

```typescript
type ResolveExitOutcome =
  | 'completed'
  | 'halted'
  | 'user_halt'
  | 'error'
  | 'crash'
```

Extended from SLE-006's original four-value enum to include `error` (G37).
The `error` outcome covers infrastructure and provider failures that are neither
user-initiated halts nor daemon crashes.

| Outcome | Condition | Store action |
|---|---|---|
| `completed` | SNAPSHOT locked, all validation passed | `closeTask` with version ID |
| `halted` | VALIDATION gate cap hit or unrecoverable error | `unclaim` + comment with failure context |
| `user_halt` | `sle halt` issued by user | `unclaim` + comment with halt context |
| `error` | Infrastructure failure (E013, E025, E032, E044) | `unclaim` + comment with error details |
| `crash` | Daemon process killed, no `finally` ran | Stale claim resolution on next start (E091) |

### map.yaml fields

**Beads mode:**

```yaml
remotes:
  issues:
    type: dolt
    url: "dolthub://org/my-project-issues"
    local_dir: ".beads"
    bd_prefix: "mp"
```

**Local mode:**

```yaml
task_store:
  type: local
  path: ".sle/tasks.yaml"
```

The `bd_prefix` prefixes all Beads task IDs (`mp-a1b2`) to prevent collisions
in multi-project setups. Local task IDs use format `local-{random_8char}`.

---

## Behavior

### DAG integration points

The DAG runner integrates with the task store at four points.

#### 1. Before Planner — getReadyTasks

```
context manager
  └── calls taskStore.getReadyTasks()
        └── BeadsTaskStore: bd ready --json
        └── LocalTaskStore: read .sle/tasks.yaml, filter status=open
              └── returns: SLETask[] with no open blockers
```

The context manager injects the ready task list into the Planner's context.
The Planner selects which ready task to work on. If no tasks are returned,
the daemon halts the cycle: "No ready tasks. Create issues first."

In declared mode, each task's `context_declarations` override the Planner's
default artifact slices. In inferred mode, the Planner uses role defaults.

#### 2. After Planner — claim

```
planner selects task mp-a1b2
  └── taskStore.updateStatus('mp-a1b2', 'in_progress')
        └── BeadsTaskStore: bd update mp-a1b2 --claim --json
        └── LocalTaskStore: write status=in_progress to .sle/tasks.yaml
```

Atomic claim prevents concurrent agents from picking the same task. If the
claim fails (E090), the Planner selects the next ready task. Session state is
written immediately after a successful claim.

#### 3. After Historian — comment

```
historian writes decisions.md delta
  └── BeadsTaskStore: bd comment mp-a1b2 {delta} --json
  └── LocalTaskStore: append to .sle/tasks.yaml comments array
```

Gives the task its own thread of progress notes. In local mode, comments are
stored under the task's `comments` field and are never compacted.

#### 4. After cycle exit — resolveExit

Every cycle exit path calls `resolveExit` in a `finally` block:

```typescript
try {
  await runCycle(intent, config)
} finally {
  await resolveExit(sessionState.claimed_task, cycle.outcome, {
    version_id: cycle.version_id,
    reason: cycle.exit_reason,
    report_path: cycle.report_path
  })
  await deleteSessionState()
}
```

The `finally` block covers all crash scenarios except `SIGKILL`. `SIGKILL` is
handled by stale claim detection on next daemon start.

`resolveExit` dispatches based on outcome:

| Outcome | Store action | Comment |
|---|---|---|
| `completed` | `closeTask(taskId)` | "Completed in {version_id}" |
| `halted` | `updateStatus(taskId, 'open')` | "SLE halted: {reason}. Report: {report_path}" |
| `user_halt` | `updateStatus(taskId, 'open')` | "Halted by user. Iteration {n}. Work incomplete." |
| `error` | `updateStatus(taskId, 'open')` | "SLE error: {reason}. Details: {report_path}" |
| `crash` | No action here — stale claim resolution on next start | — |

### Unclaim-on-failure policy

On every non-completion exit, the task returns to `open` with a comment.
`blocked` is never set by SLE — it is reserved for Beads dependency wiring.
A failed SLE cycle is not a dependency issue; the work is available to retry.
This ensures tasks are never permanently hidden from `getReadyTasks()`.

### Stale claim recovery

A stale claim is a task left `in_progress` by a daemon that is no longer
running.

**Detection on daemon start:**

```
detectStaleClaimsOnStart():
  sessionState = readSessionState()       // .sle/session-state.json
  if !sessionState: return                // clean exit last time

  if isProcessAlive(sessionState.daemon_pid):
    return                               // another daemon is running

  resolveStaleClaim(sessionState.claimed_task, sessionState.cycle, sessionState.iteration)
```

**Resolution:**

```
resolveStaleClaim(taskId, cycle, iteration):
  post comment to taskId:
    "SLE daemon crashed during cycle {cycle}, iteration {iteration}.
     Work is incomplete. Task returned to open pool."
  taskStore.updateStatus(taskId, 'open')
  deleteSessionState()
```

After resolution, the daemon presents the crash recovery prompt (E002). The
task is already `open` at this point. If the user resumes, the daemon
re-claims immediately. If halt/restart, the task stays `open` and surfaces in
the next `getReadyTasks()` call.

### Provider internals

#### BeadsTaskStore

Wraps `bd` subprocess calls. All methods spawn `bd` with `--json` and return
typed objects.

```typescript
class BeadsTaskStore implements TaskStore {
  private beadsDir: string

  private async run(args: string[]): Promise<unknown> {
    const result = await execa('bd', [...args, '--json'], {
      env: { ...process.env, BEADS_DIR: this.beadsDir }
    })
    return JSON.parse(result.stdout)
  }

  async getReadyTasks(): Promise<SLETask[]> {
    await this.pull()
    return (await this.run(['ready'])).map(normalizeBeadsTask)
  }

  async createTask(task): Promise<SLETask> {
    const args = ['create', task.title, '-p', String(task.priority)]
    if (task.description) args.push('--body', task.description)
    for (const dep of task.dependencies ?? []) args.push('--depends-on', dep)
    return normalizeBeadsTask(await this.run(args))
  }

  async updateStatus(id, status): Promise<void> {
    if (status === 'in_progress') {
      await this.run(['update', id, '--claim'])
    } else {
      await this.run(['update', id, '--status', status, '--assignee', ''])
    }
  }

  async closeTask(id): Promise<void> {
    await this.run(['close', id])
  }

  async getStale(): Promise<SLETask[]> {
    return (await this.run(['list', '--status', 'in_progress']))
      .filter(t => isStale(t))
      .map(normalizeBeadsTask)
  }

  async comment(id: string, body: string): Promise<void> {
    await this.run(['comment', id, body])
  }

  async pull(): Promise<void> {
    await this.run(['pull', 'origin']).catch(() => {})
  }

  async push(): Promise<void> {
    await this.run(['push', 'origin']).catch(() => {})
  }
}
```

`normalizeBeadsTask` maps `bd --json` output to `SLETask`. Direct field
mapping: `id`→`id`, `title`→`title`, `body`→`description`, `priority`→
`priority` (1–4), `status`→`status`, `dependencies`→`dependencies`.
Fields `labels`, `parent`, `assignee` are ignored (not in `SLETask`).

#### LocalTaskStore

Reads and writes `.sle/tasks.yaml` using the same `SLETask` schema. No
subprocess calls. Atomic file writes (write to temp, rename).

```typescript
class LocalTaskStore implements TaskStore {
  private path: string

  private async readAll(): Promise<SLETask[]> {
    return YAML.parse(await fs.readFile(this.path, 'utf-8')).tasks ?? []
  }

  private async writeAll(tasks: SLETask[]): Promise<void> {
    await fs.writeFile(this.path, YAML.stringify({ tasks }))
  }

  async createTask(task): Promise<SLETask> {
    const tasks = await this.readAll()
    const newTask: SLETask = {
      ...task,
      id: generateLocalId(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }
    tasks.push(newTask)
    await this.writeAll(tasks)
    return newTask
  }

  async getReadyTasks(): Promise<SLETask[]> {
    const tasks = await this.readAll()
    return tasks.filter(t => {
      if (t.status !== 'open') return false
      return t.dependencies.every(depId => {
        const dep = tasks.find(d => d.id === depId)
        return dep?.status === 'closed'
      })
    })
  }

  async updateStatus(id, status): Promise<void> {
    const tasks = await this.readAll()
    const task = tasks.find(t => t.id === id)
    if (!task) throw new TaskNotFoundError(id)
    task.status = status
    task.updated_at = new Date().toISOString()
    await this.writeAll(tasks)
  }

  async closeTask(id): Promise<void> {
    await this.updateStatus(id, 'closed')
  }

  async getStale(): Promise<SLETask[]> {
    const threshold = getStaleThreshold()
    return (await this.readAll()).filter(t =>
      t.status === 'in_progress' &&
      Date.now() - new Date(t.updated_at).getTime() > threshold
    )
  }
}
```

#### .sle/tasks.yaml schema

```yaml
tasks:
  - id: local-a3f7b2c1
    title: "Add rate limiting to POST /items"
    description: "100 req/min per API key, 429 on breach"
    status: open
    priority: 2
    dependencies: []
    context_declarations:
      - task_id: local-a3f7b2c1
        slices:
          - "doc:requirements"
          - "doc:architecture"
        intent: "Implement rate limiting middleware"
    created_at: "2026-04-22T10:00:00Z"
    updated_at: "2026-04-22T10:00:00Z"
    comments:
      - body: "SLE halted after 3 iterations. Failed: performance."
        timestamp: "2026-04-22T11:30:00Z"
```

### Sync

Beads sync operates independently of git sync.

| Event | BeadsTaskStore | LocalTaskStore |
|---|---|---|
| Before `getReadyTasks` | `bd pull origin` | No-op |
| After `closeTask` | `bd push origin` | No-op |
| On error | Sync deferred, retry later | N/A |

Sync failures (E092) are non-blocking. The cycle continues with local state.

### Agent memory

#### Compaction

`bd compact` sends old closed issue content to the LLM for summarisation.
Full content is replaced by the summary and marked as compacted.

SLE triggers compaction automatically:
- After every 10 completed cycles
- When `.beads/beads.db` exceeds configured size threshold
- On `sle beads compact` (manual)

Compaction is not available in local mode. E095 (compaction failure) is a
warning — old issues retain full content.

#### Session handoff

At session end, the daemon calls the handoff provider:

```
BeadsTaskStore: bd prime
LocalTaskStore: generate handoff from .sle/tasks.yaml
```

The handoff contains open tasks, recent activity, blocked tasks, and last
cycle outcome. Included in the user-facing summary after version snapshot.

### Issue hierarchy

SLE mirrors its feature structure in Beads' epic/bead hierarchy. The Planner
creates issues under the appropriate epic via `createTask` with a `parent`
field. In local mode, epics are tasks with children computed from dependency
relationships.

### CLI passthrough

`sle beads` namespace passes through to `bd` (Beads mode only):

| Command | Maps to |
|---|---|
| `sle beads ready` | `bd ready --json` (formatted) |
| `sle beads prime` | `bd prime` |
| `sle beads compact` | `bd compact` |
| `sle beads create "title"` | `bd create "title" -p 2` |
| `sle beads show {id}` | `bd show {id}` |
| `sle beads close {id}` | `bd close {id} "message"` |

Local mode uses `sle task` namespace (`list`, `show`, `create`, `close`).

Direct `bd` usage always works alongside `BeadsTaskStore`.

---

## API contract

### Get ready tasks

```
GET /api/v2/tasks/ready

Response 200:
{
  "tasks":              SLETask[],
  "store_type":         "beads" | "local",
  "synced_at":          string | null
}

Response 503:
{
  "error":              "task_store_unavailable",
  "store_type":         "beads",
  "reason":             "bd subprocess failed or Dolt remote unreachable"
}
```

### Claim task

```
POST /api/v2/tasks/{task_id}/claim

Response 200:
{
  "task_id":            string,
  "status":             "in_progress",
  "claimed_at":         string
}

Response 409:
{
  "error":              "task_already_claimed",
  "task_id":            string,
  "current_status":     string
}
```

### Resolve exit

```
POST /api/v2/tasks/{task_id}/resolve-exit

Request:
{
  "outcome":            ResolveExitOutcome,
  "context": {
    "version_id":       string | null,
    "reason":           string | null,
    "report_path":      string | null,
    "cycle":            number,
    "iteration":        number
  }
}

Response 200:
{
  "task_id":            string,
  "outcome":            ResolveExitOutcome,
  "new_status":         string,
  "comment_posted":     boolean
}

Response 500:
{
  "error":              "resolve_exit_failed",
  "task_id":            string,
  "outcome":            ResolveExitOutcome,
  "reason":             "Task store unreachable. Session state preserved for next-start recovery."
}
```

When resolve-exit fails (E097), session state is preserved. Next daemon start
resolves the stale claim via E091.

### Comment on task

```
POST /api/v2/tasks/{task_id}/comments

Request:
{
  "body":               string
}

Response 200:
{
  "task_id":            string,
  "comment_posted":     boolean
}
```

### Get task store status

```
GET /api/v2/tasks/store

Response 200:
{
  "type":               "beads" | "local",
  "available":          boolean,
  "last_sync":          string | null,
  "total_tasks":        number,
  "open_tasks":         number,
  "stale_tasks":        number
}
```

### Create task

```
POST /api/v2/tasks

Request:
{
  "title":              string,
  "description":        string | null,
  "priority":           number,
  "dependencies":       string[] | null,
  "context_declarations": TaskContextDeclaration[] | null
}

Response 201:
{
  "task":               SLETask
}
```

### WebSocket events

```
event: task.claimed
{
  "task_id":      string,
  "claimed_by":   string,
  "timestamp":    string
}

event: task.resolved
{
  "task_id":      string,
  "outcome":      ResolveExitOutcome,
  "new_status":   string,
  "timestamp":    string
}

event: task.comment_added
{
  "task_id":      string,
  "body":         string,
  "source":       "historian" | "user" | "system",
  "timestamp":    string
}

event: task.stale_detected
{
  "task_id":      string,
  "stale_for_ms": number,
  "timestamp":    string
}

event: task_store.sync
{
  "direction":    "push" | "pull",
  "success":      boolean,
  "error":        string | null,
  "timestamp":    string
}
```

---

## Error cases

### Provider errors

| Error | Condition | Response |
|---|---|---|
| E090 | Claim fails — task already claimed or status changed | Select next ready task. Halt if none remain. |
| E091 | Stale claim on daemon start | Auto-resolve: comment + unclaim before user prompt. |
| E097 | `resolveExit` fails — store unreachable | Session state preserved. Next start resolves via E091. |
| E092 | `bd push`/`bd pull` non-zero exit | Sync deferred. Cycle continues with local state. |
| E093 | Task ID not found in store | Claim: select next. Comment/close: skip and log. |
| E094 | Dependency graph inconsistent | Skip unresolvable tasks, return available ones. |
| E095 | `bd compact` fails | Compaction skipped. No cycle impact. |
| E096 | `bd` subprocess unexpected exit or invalid JSON | Bridge method fails. Caller retries or degrades. |
| E098 | `bd create` fails during sharding | Successful tasks remain. Failed logged. No rollback. |
| E099 | `bd dep add` fails during wiring | Skip failed dependency. May affect `bd ready` ordering. |

### Provider selection errors

| Error | Condition | Response |
|---|---|---|
| `task_store_unavailable` | BeadsTaskStore but `bd` not installed or Dolt unreachable | 503. Suggest local mode or install Beads. |
| `task_store_misconfigured` | `task_store.type` conflicts with `remotes.issues` | Daemon refuses to start. |
| `local_store_corrupted` | `.sle/tasks.yaml` invalid YAML or missing fields | Parse what is possible. Daemon starts degraded. |

### Error-to-outcome mapping

| Error codes | resolveExit outcome | Store action |
|---|---|---|
| E018, E014, E007, E027 | `halted` | unclaim + comment with failure context |
| E013, E025, E032, E044 | `error` | unclaim + comment with error details |
| E043 (persistent) | `error` | unclaim + comment noting rate limit |
| E002, E015 | `crash` | stale claim resolution on next start (E091) |
| (successful cycle) | `completed` | close with version ID |

---

## Constraints

1. **Provider abstraction.** The DAG runner and context manager interact only
   with the `TaskStore` interface. Provider-specific code is isolated in the two
   implementations.

2. **Single provider per session.** Selected at `sle init`, immutable within a
   daemon session.

3. **Same schema, both providers.** Both produce and consume `SLETask`. The
   context manager and DAG runner are provider-agnostic.

4. **Unclaim on failure, never block.** On every non-completion exit, the task
   returns to `open`. `blocked` is reserved for Beads dependency wiring.

5. **resolveExit is mandatory.** Called in a `finally` block on every exit.
   Only `SIGKILL` bypasses it, handled by stale claim detection on next start.

6. **Session state is ephemeral.** `.sle/session-state.json` is written after
   claim, deleted after `resolveExit`. Never committed to git.

7. **Sync is best-effort.** Sync failure (E092) does not block the cycle. The
   system continues with local state.

8. **Error outcome is distinct.** `error` covers infrastructure failures.
   `halted` covers cap hits and unrecoverable DAG errors. `user_halt` covers
   explicit user action. `crash` covers process termination. Not
   interchangeable (G37).

9. **Local mode has no compaction.** `.sle/tasks.yaml` grows unbounded.
   No `bd compact` equivalent in local mode.

10. **Local mode has no cross-device sync.** Tasks exist only on the local
    machine. Migration to Beads is manual (`sle tasks sync`, post-MVP).

11. **Comments are append-only.** Never reordered or deleted. Chronological
    order in both providers.

12. **Stale detection is uniform.** Both providers implement `getStale()`.
    Beads uses `STALE:` prefix. Local uses `updated_at` threshold. The caller
    does not distinguish.

13. **Claim atomicity.** `updateStatus(id, 'in_progress')` must be atomic.
    Beads guarantees via `bd update --claim`. Local via file locking.

14. **Provider selection in map.yaml.** `task_store.type` is read at daemon
    start and does not change within a session.

15. **No partial writes.** `.sle/tasks.yaml` is written atomically (write to
    temp, rename). Crash during write does not corrupt the file.

---

## Open questions

| ID | Question | Impact | Status |
|---|---|---|---|
| BI-001 | Should `LocalTaskStore` support dependency filtering in `getReadyTasks`, or should dependencies be ignored in local mode? | Local mode task ordering, sharding pipeline | Open |
| BI-002 | What is the stale threshold for both providers? Configurable or hardcoded? | Stale claim detection timing | Open |
| BI-003 | Should `sle tasks sync` (local → Beads migration) be MVP or deferred? | Upgrade path | Open |
| BI-004 | When `BeadsTaskStore` is active but `bd` is not installed, should the daemon fall back to `LocalTaskStore` automatically or refuse to start? | Degraded mode behavior | Open |
| BI-005 | Should `resolveExit` accept a `force: boolean` flag to override outcome-based dispatch? | Recovery scenarios, manual intervention | Open |
| BI-006 | What is the maximum comments-per-task before local mode performance degrades? | Local mode scalability | Open |
| BI-007 | Should `task.stale_detected` WebSocket event include a suggested action? | UI responsiveness | Open |
| BI-008 | Is `bd prime` output consumed programmatically or only displayed? If programmatic, what structured format? | Handoff automation | Open |
| BI-009 | Should `.sle/tasks.yaml` support multiple projects, or one file per project? | Multi-project workspaces | Open |
| BI-010 | Should `error` outcome set `stale: true` to surface differently in `getStale()`? | Stale vs. errored task distinction | Open |
