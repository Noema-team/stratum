# Local-Only Mode

**Type:** guide · **Updated:** 2026-05-02
**Source:** SLE-006 (Beads integration), specs/beads-integration, specs/init-and-discovery

## What is local-only mode?

Local-only mode runs the SLE daemon without Beads (issue tracker) and DoltHub
(remote sync). The daemon uses `LocalTaskStore` instead of `BeadsTaskStore`,
reading and writing tasks to a flat YAML file at `.sle/tasks.yaml`.

**Use local-only mode when:**

- You are a solo developer with no need for cross-device task sync
- You work in an air-gapped or restricted network environment
- You are evaluating SLE and want to try it without setting up DoltHub

**What you keep:**

- Full cycle execution through the DAG runner
- Artifact generation and validation
- Discovery, intake, and sharding
- Crash recovery and stale claim detection
- All 10 agent roles and customisable rule files

**What you lose:**

- Issue tracking with `bd` commands (`bd ready`, `bd show`, etc.)
- Cross-device sync via DoltHub (`bd push` / `bd pull`)
- Semantic compaction of closed issues (`bd compact`)
- CLI passthrough commands (`sle beads` namespace)
- Multi-agent collaboration via shared task state

For the full provider comparison, see specs/beads-integration §Provider internals.

---

## Enabling local-only mode

### During init

Run `sle init` and select `local` when prompted for the task store provider
(step 3b):

```
? Task store provider:
  ❯ local   — flat file (.sle/tasks.yaml), no sync
    beads   — Dolt-backed issues via bd CLI, cross-device sync
```

This creates `.sle/tasks.yaml` with an empty task list and records the choice in
`map.yaml`:

```yaml
task_store:
  type: local
  path: ".sle/tasks.yaml"
```

The init sequence skips Beads setup entirely — no `bd init`, no DoltHub remote,
no `.beads/` directory. No `bd` binary is required on the system.

Non-interactive equivalent:

```bash
sle init \
  --name "my-project" \
  --description "REST API for item management" \
  --type api \
  --task-store local
```

See specs/init-and-discovery §Step 3b for the full step sequence.

### After init

Edit `map.yaml` to switch an existing project to local-only:

```yaml
task_store:
  type: local
  path: ".sle/tasks.yaml"
```

Then `sle init --reset --task-store local`. Per init-and-discovery constraint 3,
the task store provider is fixed after init — changing it requires a reset.
The daemon reads `task_store.type` at startup and instantiates
`LocalTaskStore`. If `.sle/tasks.yaml` does not exist, it is created on first
task write. Switching from Beads to local does not migrate existing Beads
issues — see §Transitioning to Beads later for the reverse path.

### Task management in local mode

Use the `sle task` namespace instead of `sle beads`:

| Command | Action |
|---------|--------|
| `sle task list` | List all tasks |
| `sle task show {id}` | Show task details |
| `sle task create "title"` | Create a new task |
| `sle task close {id}` | Close a task |

These commands read and write `.sle/tasks.yaml` directly. No subprocess calls to
`bd`.

---

## Stealth mode (with Beads installed)

Stealth mode is for users who have Beads installed and configured but want SLE
to operate independently of the Beads issue tracker. SLE uses `LocalTaskStore`
for task management, but the Beads binary and `.beads/` directory remain
available for other workflows.

### Enabling stealth mode

Stealth mode is selected during `sle init` when you choose `local` as the task
store provider. If Beads is detected on the system, init offers to enable
stealth mode — SLE uses `LocalTaskStore` while `bd` remains available for other
workflows.

Set it explicitly in `map.yaml`:

```yaml
task_store:
  type: local
  path: ".sle/tasks.yaml"
beads:
  stealth: true
```

When `beads.stealth` is `true`, the daemon:

- Never calls `bd` commands for task operations
- Does not check Beads remote connectivity during startup
- Still fires Beads hooks if they are configured (see §Beads hooks)

When `beads.stealth` is absent or `false` and `task_store.type` is `local`, the
daemon ignores Beads entirely — no hooks fire, no connectivity checks.

---

## Beads hooks

Hooks are scripts that run at specific points in the SLE cycle. They are
available in both Beads and local-only modes, though some hooks are more useful
with Beads enabled.

### Available hooks

| Hook | When it fires | Typical use |
|------|--------------|-------------|
| `pre_cycle` | Before the DAG runner starts a cycle | Validate environment, notify external systems |
| `post_cycle` | After cycle completes (any outcome) | Log results, trigger CI, send notifications |
| `on_failure` | When a cycle exits with `halted`, `error`, or `crash` | Alert on-call, capture diagnostics |
| `on_artifact_change` | After any artifact is written or updated | Sync to external storage, trigger builds |

### Configuring hooks

Add hooks to `map.yaml` under `beads.hooks`:

```yaml
beads:
  hooks:
    pre_cycle:
      command: ".sle/hooks/pre-cycle.sh"
      timeout_ms: 5000
    post_cycle:
      command: ".sle/hooks/post-cycle.sh"
      timeout_ms: 10000
    on_failure:
      command: ".sle/hooks/on-failure.sh"
      timeout_ms: 5000
    on_artifact_change:
      command: ".sle/hooks/on-artifact.sh"
      timeout_ms: 3000
```

Each hook specifies a command (path to an executable script) and an optional
timeout. If a hook exceeds its timeout, the daemon logs a warning and continues
the cycle. Hook failures never halt the cycle.

### Writing a hook script

Hook scripts receive context through environment variables:

| Variable | Contents | Available in |
|----------|----------|-------------|
| `SLE_CYCLE_ID` | Current cycle identifier | All hooks |
| `SLE_TASK_ID` | Claimed task ID (or `none`) | `pre_cycle`, `post_cycle`, `on_failure` |
| `SLE_OUTCOME` | Cycle outcome (`completed`, `halted`, `error`, `crash`) | `post_cycle`, `on_failure` |
| `SLE_VERSION_ID` | Snapshot version (e.g., `v1.2.3`) | `post_cycle` (completed only) |
| `SLE_ARTIFACT_PATH` | Path to the changed artifact | `on_artifact_change` |
| `SLE_ARTIFACT_TYPE` | Artifact type prefix (`doc:`, `code:`, `test:`) | `on_artifact_change` |
| `SLE_PROJECT_ROOT` | Absolute path to project root | All hooks |
| `SLE_EXIT_REASON` | Human-readable exit reason | `on_failure` |
| `SLE_REPORT_PATH` | Path to cycle report | `on_failure` |

Example `post_cycle` hook:

```bash
#!/usr/bin/env bash
set -euo pipefail
echo "$(date -Iseconds) cycle=${SLE_CYCLE_ID} task=${SLE_TASK_ID} outcome=${SLE_OUTCOME} version=${SLE_VERSION_ID:-none}" \
  >> "${SLE_PROJECT_ROOT}/.sle/cycle-log.tsv"
```

Example `on_failure` hook:

```bash
#!/usr/bin/env bash
set -euo pipefail
curl -sf -X POST "https://hooks.example.com/alert" \
  -H "Content-Type: application/json" \
  -d "{\"text\": \"SLE cycle ${SLE_CYCLE_ID} failed: ${SLE_OUTCOME}\"}" \
  || true
```

### Hook execution order

When multiple hooks are configured for the same event, they run in
configuration order. If `on_failure` fires, it runs before `post_cycle` — both
fire on a failed cycle, but `on_failure` executes first.

### Hooks in local-only mode

Hooks fire regardless of the task store provider. In local-only mode, hooks are
the primary extension point for integrating SLE with external systems since
Beads CLI passthrough (`sle beads`) is unavailable.

---

## Issue tracking hierarchy (when Beads is enabled)

When Beads is the active task store, SLE mirrors its feature structure in
Beads' built-in hierarchy:

```
Project
  └── Epic (phase-level grouping)
        └── Task (individual work item)
              └── Sub-task (optional decomposition)
```

### How SLE maps to this hierarchy

- **Project** — the SLE project itself, set during `bd init`
- **Epic** — corresponds to a discovery phase (see specs/init-and-discovery
  §Planning loop). The Planner creates epic-level issues via `createTask` with
  a `parent` field.
- **Task** — maps to an `SLETask` claimed and resolved during a cycle. The DAG
  runner claims one task per cycle via `taskStore.updateStatus(id,
  'in_progress')`.
- **Sub-task** — optional further decomposition within a task. Not created
  automatically by SLE; managed manually via `bd create --parent {id}`.

Beads task IDs use the project prefix (e.g., `mp-a1b2`) to prevent collisions
in multi-project setups. The prefix is configured during `sle init` step 3b and
stored in `map.yaml → remotes.issues.bd_prefix`.

### Local mode: flat task tracking

In local-only mode, there is no hierarchy. All tasks are stored as a flat list
in `.sle/tasks.yaml`:

```yaml
tasks:
  - id: local-a3f7b2c1
    title: "Add rate limiting to POST /items"
    description: "100 req/min per API key, 429 on breach"
    status: open
    priority: 2
    dependencies:
      - local-e4d5c6b7
    created_at: "2026-04-22T10:00:00Z"
    updated_at: "2026-04-22T10:00:00Z"
    comments:
      - body: "SLE halted after 3 iterations. Failed: performance."
        timestamp: "2026-04-22T11:30:00Z"
```

Local task IDs use the format `local-{random_8char}`. Dependencies are tracked
by ID reference: `getReadyTasks()` returns only tasks whose dependencies are all
`closed`. There is no parent/child nesting — epics and sub-tasks are not
represented.

Both providers produce the same `SLETask` shape (see specs/beads-integration
§SLETask), so the DAG runner and context manager are provider-agnostic. They
call `getReadyTasks()` and receive `SLETask[]` regardless of the backing store.

### Dependency handling

In local mode, `getReadyTasks()` resolves the dependency graph at read time:
it reads all tasks from `.sle/tasks.yaml`, filters for `status: open`, and
returns only those whose `dependencies` array references tasks with
`status: closed`. This matches the behaviour of `bd ready` in Beads mode,
except dependencies are resolved in-process from the YAML file rather than
delegated to `bd ready --json`.

---

## Transitioning to Beads later

You can start with local-only mode and add Beads when you need collaboration
features, remote sync, or semantic compaction.

### Prerequisites

- Install the `bd` CLI (Beads binary)
- Create a DoltHub account and repository for issues
- Ensure `.sle/tasks.yaml` has no tasks with status `in_progress` (complete or
  halt any active cycles first)

### Migration to Beads

```bash
sle init --reset --task-store beads \
  --remote dolthub://org/my-project-issues \
  --prefix mp
```

This command:

1. Runs `bd init --quiet --prefix mp` in the project root
2. Adds the DoltHub remote via `bd remote add origin`
3. Installs Beads hooks via `bd hooks install`
4. Creates Beads issues for each task in `.sle/tasks.yaml` that has status
   `open` or `blocked`
5. Preserves task titles, descriptions, priorities, and dependency
   relationships
6. Pushes to DoltHub via `bd push origin`

After migration, update `map.yaml`:

```yaml
task_store:
  type: beads

remotes:
  issues:
    type: dolt
    url: "dolthub://org/my-project-issues"
    local_dir: ".beads"
    bd_prefix: "mp"
```

Restart the daemon to activate `BeadsTaskStore`:

```bash
sle daemon start
```

### What migrates and what does not

| Data | Migrates? | Notes |
|------|-----------|-------|
| Open tasks | Yes | Created as Beads issues with matching priority and dependencies |
| Blocked tasks | Yes | Dependencies wired via `bd dep add` |
| Closed tasks | No | Local history stays in `.sle/tasks.yaml`; not retroactively imported |
| Task comments | No | Comments are local-only; they are not migrated to Beads |
| `context_declarations` | Yes | Preserved on each task during creation |
| Artifact history (`map.yaml`) | Yes | `map.yaml` is independent of the task store |

### No data loss guarantee

Artifacts and `map.yaml` are independent of the task store. Switching providers
does not affect generated artifacts (`.server/docs/`), cycle history in
`map.yaml`, rule files (`.sle/rules/`), agent prompts (`.sle/prompts/`), or
`agent.md`. The local `.sle/tasks.yaml` file is preserved after migration —
delete it manually once you have verified the Beads issues are correct.

---

## Troubleshooting

### Beads connection refused in local-only mode

If you see errors referencing `bd` or Beads connectivity in local-only mode, the
daemon is likely configured for the wrong provider. Check `map.yaml`:

```yaml
task_store:
  type: local
  path: ".sle/tasks.yaml"
```

If `type` is `beads`, change it to `local` and run `sle init --reset --task-store local`. If the
error occurs at init (E103), re-run: `sle init --resume --task-store local`.

### Hooks not firing

Hooks fire only when configured in `map.yaml` under `beads.hooks`. Check
that the hook path is correct and the script is executable (`chmod +x`), the
`timeout_ms` value is sufficient, and the script exits with code 0.

In stealth mode, `beads.stealth: true` must be set for hooks to fire when
`task_store.type` is `local`. Without the `stealth` flag, local-only mode skips
the hooks subsystem entirely.

### Sync errors when re-enabling Beads

After migrating from local to Beads, sync errors (E092) indicate a connectivity
or authentication problem with the DoltHub remote. Verify the remote URL in
`map.yaml → remotes.issues.url`, test with `bd pull origin`, and check
authentication with `bd remote`.

Sync errors are non-blocking — the cycle continues with local state and retries
on the next `getReadyTasks()` call.

### Corrupted tasks.yaml

If `.sle/tasks.yaml` contains invalid YAML or missing fields, the daemon starts
degraded (`local_store_corrupted`). Run `sle task list` to see parseable tasks
and errors, then edit the file to fix invalid entries. Required fields per task:
`id`, `title`, `status`, `priority`, `dependencies`, `created_at`, `updated_at`.

### Daemon refuses to start after provider switch

The daemon validates task store consistency at startup (specs/daemon-api
§Startup sequence). If `task_store.type` is `local` but `.sle/tasks.yaml` is
missing, create an empty task file:

```yaml
tasks: []
```

If `task_store.type` is `beads` but `.beads/` is missing, run `sle init --reset --task-store beads`
before starting the daemon.
