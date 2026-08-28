# map.yaml Schema

**Type:** reference · **Status:** draft · **Updated:** 2026-06-21

Authoritative schema for `map.yaml` — the single source of runtime truth for
every agent and interface connecting to an SLE project. Generated once at
`sle init`, regenerated automatically after every workflow-run step.

Any agent bootstrapping into a session reads `agent.md` first, which references
this file. `map.yaml` describes reality. `agent.md` describes intent. They are
never merged.

**New fields in this revision (DDR-031 — workflow generalization):**

| Field | Source | Resolves |
|---|---|---|
| `workflow_runs` (map, replaces singular `cycle`) | DDR-031 | WG-001, WG-003 |
| `workflow_runs.{run_id}.awaiting_checkpoint` | DDR-031 | collapses the 3 flag fields below |
| `workflow_runs.{run_id}.claimed_artifacts` | DDR-031 | artifact-level claim contract |
| `meta.completed_run_count` (replaces `meta.cycle`) | DDR-031 | WG-003 |
| `history[*].workflow_run_id` / `workflow_id` (replaces `history[*].cycle`) | DDR-031 | — |

**Prior fields (still present, now scoped per-run instead of project-wide):**

| Field | Source | Resolves |
|---|---|---|
| `workflow_runs.{run_id}.approval_gate.*` | G27 | G27 |
| `workflow_runs.{run_id}.steps_completed` | G31 | G31 |
| `workflow_runs.{run_id}.current_step_id` | G31 | G31 |
| `workflow_runs.{run_id}.roles_completed` | G31 | G31 |
| `artifacts.files[*].scope` | DDR-025 | G30 |
| `chat` | DDR-020 | 4.4.1 |
| `workflow_runs.{run_id}.last_run` | DDR-022 | 4.4.2 |

---

## Annotated YAML schema

```yaml
meta:
  sle_version: "2.0.0"
  generated_at: "2026-04-17T10:00:00Z"
  project_type: api
  completed_run_count: 4
  version_id: "v0.4.0"
  status: idle


project:
  name: "my-project"
  description: "One line description of the project"
  root: "."
  language: typescript
  runtime: node


remotes:
  code:
    type: git
    url: "git@github.com:org/my-project.git"
    branch: main

  issues:
    type: dolt
    url: "dolthub://org/my-project-issues"
    local_dir: ".beads"
    bd_prefix: "mp"

  docs:
    type: git
    url: "git@github.com:org/my-project.server.git"
    branch: main
    local_dir: ".server"
    mount: docs/


agents:
  explorer:
    active: false
    model: null
    temperature: null
    max_tokens: null
    system_prompt: ".sle/prompts/explorer.md"

  designer:
    active: true
    model: "claude-sonnet-4-20250514"
    temperature: 0.3
    max_tokens: 8000
    system_prompt: ".sle/prompts/designer.md"

  planner:
    active: true
    model: "claude-sonnet-4-20250514"
    temperature: 0.3
    max_tokens: 8000
    system_prompt: ".sle/prompts/planner.md"

  tester:
    active: true
    model: "claude-sonnet-4-20250514"
    temperature: 0.1
    max_tokens: 8000
    system_prompt: ".sle/prompts/tester.md"

  builder:
    active: true
    model: "claude-sonnet-4-20250514"
    temperature: 0.2
    max_tokens: 16000
    system_prompt: ".sle/prompts/builder.md"

  debugger:
    active: true
    model: "claude-sonnet-4-20250514"
    temperature: 0.2
    max_tokens: 8000
    system_prompt: ".sle/prompts/debugger.md"

  evaluator:
    active: true
    model: "claude-sonnet-4-20250514"
    temperature: 0.1
    max_tokens: 4000
    system_prompt: ".sle/prompts/evaluator.md"

  critic:
    active: true
    model: "claude-sonnet-4-20250514"
    temperature: 0.5
    max_tokens: 4000
    system_prompt: ".sle/prompts/critic.md"

  historian:
    active: true
    model: "claude-sonnet-4-20250514"
    temperature: 0.1
    max_tokens: 2000
    system_prompt: ".sle/prompts/historian.md"

  facilitator:
    active: true
    model: "claude-sonnet-4-20250514"
    temperature: 0.4
    max_tokens: 4000
    system_prompt: ".sle/prompts/facilitator.md"


artifacts:
  root: "docs/"

  files:
    requirements:
      path: "docs/requirements.md"
      generator: designer
      scope: project
      required: true
      last_updated: "2026-04-17T09:50:00Z"
      dirty: false

    architecture:
      path: "docs/architecture.md"
      generator: designer
      scope: project
      required: true
      last_updated: "2026-04-17T09:50:00Z"
      dirty: false

    research_findings:
      path: "docs/research-findings.md"
      generator: explorer
      scope: project
      required: false
      last_updated: null
      dirty: false

    test-plan:
      path: "docs/test-plan.md"
      generator: planner
      scope: project
      required: true
      last_updated: "2026-04-17T09:50:00Z"
      dirty: false

    decisions:
      path: "docs/decisions.md"
      generator: historian
      scope: project
      required: true
      append_only: true
      last_updated: "2026-04-17T09:58:00Z"
      dirty: false

    evaluation:
      path: "docs/evaluation.md"
      generator: evaluator
      scope: project
      required: true
      last_updated: "2026-04-17T09:55:00Z"
      dirty: false

    build-plan:
      path: "docs/build-plan.md"
      generator: planner
      scope: project
      required: false
      last_updated: "2026-04-17T06:00:00Z"
      dirty: false

    rate_limiting_architecture:
      path: ".sle/project-graph/layers/rate-limiting/architecture.md"
      generator: designer
      scope: group
      group: "rate-limiting"
      required: false
      last_updated: "2026-04-17T09:50:00Z"
      dirty: false

  generated_outputs:
    test_runner:
      path: "scripts/run-tests.ts"
      type: executable
    validation_report:
      path: "reports/validation-latest.html"
      type: html
    changelog:
      path: "reports/changelog-v0.4.0.md"
      type: markdown


rules:
  root: ".sle/rules/"

  files:
    planning:           ".sle/rules/planning.yaml"
    validation:         ".sle/rules/validation.yaml"
    artifacts:          ".sle/rules/artifacts.yaml"
    exit:               ".sle/rules/exit.yaml"
    user_validation:    ".sle/rules/user_validation.yaml"
    summary:            ".sle/rules/summary.yaml"
    agents:             ".sle/rules/agents.yaml"

  overrides:
    planning:           ".sle/overrides/planning.yaml"


validation:
  categories:
    - name: correctness
      method: both
      status: passed
      last_run: "2026-04-17T09:55:00Z"
      executable: "scripts/test_correctness.ts"
      prompt_template: ".sle/prompts/correctness_check.md"

    - name: performance
      method: both
      status: passed
      last_run: "2026-04-17T09:55:10Z"
      executable: "scripts/bench.ts"
      prompt_template: ".sle/prompts/performance_check.md"

    - name: security
      method: llm
      status: passed
      last_run: "2026-04-17T09:55:20Z"
      prompt_template: ".sle/prompts/security_check.md"

  gate:
    mode: all_must_pass
    last_outcome: passed
    failed_categories: []


context:
  slice_size_tokens: 2000
  summary_max_tokens: 400

  agent_slices:
    explorer:
      - "doc:requirements"
      - "doc:evaluation"
      - "doc:decisions"

    designer:
      - "doc:requirements"
      - "doc:architecture"
      - "doc:decisions"
      - "doc:evaluation"

    planner:
      - "doc:requirements"
      - "doc:architecture"
      - "doc:decisions"
      - "doc:evaluation"

    tester:
      - "doc:requirements"
      - "doc:test-plan"

    builder:
      - "doc:requirements"
      - "doc:architecture"
      - "doc:test-plan"

    debugger:
      - "doc:requirements"
      - "doc:test-plan"

    historian:
      - "doc:decisions"

    evaluator:
      - "doc:requirements"
      - "doc:evaluation"
      - "doc:test-plan"

    critic:
      - "doc:architecture"
      - "doc:evaluation"

    facilitator:
      - "doc:requirements"
      - "doc:architecture"
      - "doc:test-plan"
      - "doc:decisions"


interfaces:
  daemon:
    port: 7700
    protocol: "ws+rest"
    pid_file: ".sle/daemon.pid"

  cli:
    package: "@sle/cli"
    version: "2.0.0"

  web:
    package: "@sle/web"
    version: "2.0.0"
    mobile_ready: true

  obsidian:
    package: "@sle/obsidian"
    version: "2.0.0"
    vault_path: "~/notes/my-project"


chat:
  session_open: false
  session_id: null
  mode: freeform


workflow_runs:
  full-build-4-i1-20260417T090000Z:
    workflow_id: full-build
    target:
      group: null
      layer: null
      node_key: null
    status: complete
    iteration: 1
    revision: 0
    started_at: "2026-04-17T09:00:00Z"
    completed_at: "2026-04-17T09:58:00Z"

    awaiting_checkpoint: null

    approval_gate:
      gate: "after_planning"
      decision: "approved"
      approved_categories:
        - correctness
        - performance
        - security
      decided_at: "2026-04-17T09:30:00Z"

    steps_completed:
      - "scoping_gather"
      - "scoping_produce"
      - "scoping_checkpoint"
      - "design"
      - "plan"
      - "test"
      - "sharding_approval"
      - "confirm"
      - "build"
      - "exec"
      - "validation_gate"
      - "evaluate"
      - "summarise"
      - "snapshot"

    current_step_id: null

    roles_completed:
      - "designer"
      - "planner"
      - "tester"
      - "builder"
      - "historian"
      - "evaluator"
      - "critic"
      - "facilitator"

    claimed_artifacts: []

    last_summary:
      path: "reports/summary-v0.4.0.md"
      generated_at: "2026-04-17T09:58:00Z"

    last_run:
      run_id: "full-build-4-i1-20260417T090000Z"
      started_at: "2026-04-17T09:00:00Z"
      completed_at: "2026-04-17T09:58:00Z"
      iteration_count: 1
      outcome: complete

    updated_at: "2026-04-17T09:58:00Z"


graph:
  groups:
    - id: "rate-limiting"
      name: "Rate Limiting"
      status: active
      nodes: 4
      completed: 3

    - id: "auth"
      name: "Authentication"
      status: active
      nodes: 6
      completed: 6

  layers:
    - id: "requirements"
      name: "Requirements"
      node_count: 3

    - id: "architecture"
      name: "Architecture"
      node_count: 3

    - id: "implementation"
      name: "Implementation"
      node_count: 12

    - id: "test"
      name: "Test"
      node_count: 8

  link_count: 47
  last_rebuilt_at: "2026-04-17T09:00:00Z"


history:
  - workflow_run_id: "full-build-1-i1-20260410T080000Z"
    workflow_id: full-build
    version_id: "v0.1.0"
    outcome: complete
    started_at: "2026-04-10T08:00:00Z"
    completed_at: "2026-04-10T08:45:00Z"
    summary_path: "reports/summary-v0.1.0.md"

  - workflow_run_id: "full-build-2-i1-20260412T090000Z"
    workflow_id: full-build
    version_id: "v0.2.0"
    outcome: complete
    started_at: "2026-04-12T09:00:00Z"
    completed_at: "2026-04-12T09:50:00Z"
    summary_path: "reports/summary-v0.2.0.md"

  - workflow_run_id: "full-build-3-i1-20260415T100000Z"
    workflow_id: full-build
    version_id: "v0.3.0"
    outcome: complete
    started_at: "2026-04-15T10:00:00Z"
    completed_at: "2026-04-15T10:55:00Z"
    summary_path: "reports/summary-v0.3.0.md"

  - workflow_run_id: "full-build-4-i1-20260417T090000Z"
    workflow_id: full-build
    version_id: "v0.4.0"
    outcome: complete
    started_at: "2026-04-17T09:00:00Z"
    completed_at: "2026-04-17T09:58:00Z"
    summary_path: "reports/summary-v0.4.0.md"


discovery:
  status: complete
  artifacts:
    - "docs/requirements.md"
    - "docs/architecture.md"
  current_phase: 3
  total_phases: 3
  open_questions_count: 2
  blocking_questions_count: 0


repo:
  src: "src/"
  tests: "tests/"
  scripts: "scripts/"
  docs: "docs/"
  config: ".sle/"

  entry_points:
    - "src/index.ts"

  key_files:
    - path: "src/index.ts"
      role: "main entry point"
    - path: "src/workflow/runner.ts"
      role: "workflow execution engine"
    - path: "src/rules/loader.ts"
      role: "YAML rule loader"
    - path: "src/sdk/daemon.ts"
      role: "SDK daemon"
```

---

## Section reference

### `meta`

| Field | Type | Description |
|---|---|---|
| `sle_version` | string | Version of SLE that generated this file |
| `generated_at` | ISO 8601 | Timestamp of last regeneration |
| `project_type` | enum | Template used at init: `api` · `ui` · `library` · `research` · `custom` |
| `completed_run_count` | integer | ⚡ **DDR-031.** Increments with every completed workflow run, across all workflow ids. Was `cycle`. Kept as a single global counter (not per-workflow-id) because version numbering and changelog generation want one incrementing integer. |
| `version_id` | string | Semver of last locked version snapshot |
| `status` | enum | Current system state (see below) |

**`meta.status` values:**

| Value | Meaning |
|---|---|
| `idle` | No discovery running. There may or may not be active workflow runs — see `workflow_runs` |
| `discovering` | `sle discover` in progress |

⚡ **DDR-031.** `cycling` · `halted` · `complete` are removed from `SystemStatus`.
Under concurrent workflow runs there is no single project-wide "running"
state — per-run progress lives entirely on each entry in `workflow_runs`.
Clients derive "is any work in progress" from `workflow_runs` (count entries
with `status: active`), not from `meta.status`.

Per DDR-020, chat is not a system state — it is an orthogonal session.
Per DDR-021, `confirming` is not a top-level state — it is expressed as
`workflow_runs.{run_id}.awaiting_checkpoint`.

---

### `project`

| Field | Type | Description |
|---|---|---|
| `name` | string | Project identifier |
| `description` | string | One-line description |
| `root` | string | Relative to repo root |
| `language` | string | Primary language |
| `runtime` | string | Runtime environment |

Never changes after init unless manually edited in `agent.md` and re-synced.

---

### `remotes`

Three remotes with independent histories — never merged:

| Remote | Type | Holds |
|---|---|---|
| `code` | git | Source code, rule files, `agent.md`, `map.yaml` |
| `issues` | dolt | Beads issue tracker (via `bd`) |
| `docs` | git | Documentation, mounted at `docs/` |

**`code` fields:** `type` · `url` · `branch`

**`issues` fields:** `type` · `url` · `local_dir` · `bd_prefix`

**`docs` fields:** `type` · `url` · `branch` · `local_dir` · `mount`

The `docs` remote is checked out at `.server/` alongside the repo root. The
`mount` field tells the SDK where to expose it in the working tree.

---

### `agents`

Per-role agent configuration. Populated from `agents.yaml` at daemon startup.

| Field | Type | Description |
|---|---|---|
| `active` | boolean | Whether this role participates in workflow runs |
| `model` | string \| null | LLM model identifier |
| `temperature` | number \| null | Sampling temperature |
| `max_tokens` | number \| null | Maximum output tokens |
| `system_prompt` | string | Path to SLE-008 prompt template |

Roles: `explorer` · `designer` · `planner` · `tester` · `builder` · `debugger`
· `evaluator` · `critic` · `historian` · `facilitator`

---

### `artifacts`

**`artifacts.files` entries:**

| Field | Type | Description |
|---|---|---|
| `path` | string | Relative path from repo root |
| `generator` | enum | Which agent role writes this file |
| `scope` | enum | **DDR-025:** `project` or `group` |
| `group` | string? | Group ID (only when `scope: group`) |
| `required` | boolean | A `full-build` run cannot complete without it |
| `append_only` | boolean? | System will never overwrite, only append |
| `last_updated` | ISO 8601 \| null | Timestamp of last write |
| `dirty` | boolean | Modified since last version snapshot |

The `scope` field (DDR-025) enables the context manager to resolve typed
references: `doc:{key}` loads project-scoped artifacts, `node:{group}:{key}`
loads group-scoped artifacts. Group-scoped entries carry an additional `group`
field identifying the owning group.

**`artifacts.generated_outputs` entries:**

| Field | Type | Description |
|---|---|---|
| `path` | string | Relative path from repo root |
| `type` | enum | `executable` · `html` · `markdown` |

---

### `rules`

| Field | Type | Description |
|---|---|---|
| `root` | string | Directory containing rule files |
| `files` | map | Rule name → path mapping |
| `overrides` | map? | Project-level overrides (optional) |

Seven rule files: `planning` · `validation` · `artifacts` · `exit` ·
`user_validation` · `summary` · `agents`. `planning.yaml → max_iterations`
and `scoping.max_rounds` apply per workflow run, not globally — two
concurrent runs each get their own iteration/round budget.

---

### `validation`

**`validation.categories` entries:**

| Field | Type | Description |
|---|---|---|
| `name` | string | Category identifier |
| `method` | enum | `llm` · `executable` · `both` |
| `status` | enum | `passed` · `failed` · `pending` · `skipped` |
| `last_run` | ISO 8601? | Timestamp of last validation run |
| `executable` | path? | Script path (if method includes executable) |
| `prompt_template` | path? | Markdown prompt file (if method includes llm) |

**`validation.gate`:**

| Field | Type | Description |
|---|---|---|
| `mode` | enum | Currently `all_must_pass` |
| `last_outcome` | enum | `passed` · `failed` · `halted` |
| `failed_categories` | string[] | Populated when gate fails |

---

### `context`

Controls which artifact slices each agent role receives.

| Field | Type | Description |
|---|---|---|
| `slice_size_tokens` | integer | Max tokens per artifact slice |
| `summary_max_tokens` | integer | Max tokens for summary slices |
| `agent_slices` | map | Role → list of typed artifact refs (DDR-025 format) |

All references use typed prefixes per DDR-025: `doc:{key}` for project-level
documents, `node:{group}:{key}` for group-level nodes. Wildcard form
`node:*:{key}` loads from all groups (use with caution).

---

### `interfaces`

| Interface | Fields |
|---|---|
| `daemon` | `port` · `protocol` · `pid_file` |
| `cli` | `package` · `version` |
| `web` | `package` · `version` · `mobile_ready` |
| `obsidian` | `package` · `version` · `vault_path` |

All interfaces except `daemon` are optional.

---

### `chat`

Orthogonal chat session state (DDR-020). Chat is not a system state — it
operates independently of any workflow run. Multiple chat sessions may occur
while zero or more workflow runs are active.

| Field | Type | Description |
|---|---|---|
| `session_open` | boolean | Whether a chat session is currently active |
| `session_id` | string \| null | Unique session identifier (null when no session) |
| `mode` | enum | `freeform` · `decision` · `scoping` · `workflow_select` |

In `freeform` mode the user chats with the Facilitator without constraint.
In `decision` mode the Facilitator presents options and records a structured
choice (used by approval gates). In `workflow_select` mode the Facilitator has
proposed a `WorkflowMatchCandidate` and is awaiting the user's confirm/reject
(DDR-031) — see conversation.md.

---

### `workflow_runs`

⚡ **DDR-031.** Replaces the singular `cycle` section. A map keyed by `run_id`,
holding one entry per workflow run that has ever started this project — not
just the currently-active one. Multiple entries may have `status: active`
simultaneously. Updated after every step completion, for the owning run only
(other runs' entries are untouched), for crash recovery (G31).

**Core fields (per entry):**

| Field | Type | Description |
|---|---|---|
| `workflow_id` | string | Which `WorkflowDefinition` this run executes, e.g. `full-build` |
| `target.group` / `target.layer` / `target.node_key` | string? | What this run is scoped to, if anything |
| `status` | enum | `active` · `halted` · `complete` |
| `iteration` | integer | Iteration within this run (increments on validation-gate-equivalent failure) |
| `revision` | integer | Revision within the current iteration (increments on checkpoint modification) |
| `started_at` | ISO 8601 | When this run started |
| `completed_at` | ISO 8601? | When this run completed |

**Checkpoint state (DDR-031, replaces the 3-flag set from DDR-021/DDR-026):**

| Field | Type | Description |
|---|---|---|
| `awaiting_checkpoint` | string \| null | The id of the step currently paused at, or `null`. At most one checkpoint is active per run — this is enforced by the field being a single nullable pointer, not a flag set. |

The Facilitator enters decision mode while this is non-null. On daemon
restart, the daemon reads this field to know exactly which interaction to
resume, per run.

**Approval gate record (G27):**

| Field | Type | Description |
|---|---|---|
| `approval_gate.gate` | string \| null | Gate name: `after_planning` · `after_gate_pass` · `sharding` · null |
| `approval_gate.decision` | enum \| null | `approved` · `rejected` · null |
| `approval_gate.approved_categories` | string[] | Categories confirmed during this gate |
| `approval_gate.decided_at` | ISO 8601 \| null | When the user responded |

Written immediately when the user responds, before resuming the run. On crash
recovery, the daemon reads `approval_gate.decision` to determine whether to
re-prompt or resume.

**Progress tracking (G31):**

| Field | Type | Description |
|---|---|---|
| `steps_completed` | string[] | Step ids completed this iteration |
| `current_step_id` | string \| null | Step currently executing (null between iterations) |
| `roles_completed` | string[] | Agent roles that have written outputs this iteration |

Written after every step completion, before the next step starts. On daemon
restart, the daemon reads `steps_completed` to skip already-run steps and
resumes at `current_step_id`.

**Claimed artifacts (DDR-031):**

| Field | Type | Description |
|---|---|---|
| `claimed_artifacts` | `ArtifactClaim[]` | Artifacts this run currently holds a claim on. Mirrors (does not replace) the per-artifact files at `.sle/claims/{ref-slug}.json` — those files are the source of truth for cross-run conflict checks; this field is a convenience view scoped to one run. |

**Summary:**

| Field | Type | Description |
|---|---|---|
| `last_summary.path` | string | Path to this run's summary document |
| `last_summary.generated_at` | ISO 8601 | When the summary was generated |

**Last run record:**

| Field | Type | Description |
|---|---|---|
| `last_run.run_id` | string | Same as the entry's own key — present for convenience when an entry is passed around detached from its key |
| `last_run.started_at` | ISO 8601 | When the run started |
| `last_run.completed_at` | ISO 8601 | When the run completed |
| `last_run.iteration_count` | integer | Number of iterations in this run |
| `last_run.outcome` | `WorkflowRunStatus` | Final status of the run |

`updated_at` (top-level on the entry): timestamp of the most recent write to
this run's record, regardless of which field changed.

---

### `graph`

Project graph metadata — populated after discovery and updated after each
workflow run that touches the graph.

**`graph.groups` entries:**

| Field | Type | Description |
|---|---|---|
| `id` | string | Group identifier (e.g., `rate-limiting`) |
| `name` | string | Human-readable group name |
| `status` | enum | `active` · `complete` · `blocked` |
| `nodes` | integer | Total nodes in this group |
| `completed` | integer | Completed nodes in this group |

**`graph.layers` entries:**

| Field | Type | Description |
|---|---|---|
| `id` | string | Layer identifier |
| `name` | string | Human-readable layer name |
| `node_count` | integer | Total nodes across all groups in this layer |

| Field | Type | Description |
|---|---|---|
| `link_count` | integer | Total edges in the project graph |
| `last_rebuilt_at` | ISO 8601 | When the graph was last rebuilt |

---

### `history`

Append-only log of completed workflow runs, across all workflow ids. Each
entry:

| Field | Type | Description |
|---|---|---|
| `workflow_run_id` | string | The run's id (matches a `workflow_runs` key at the time it ran, though that entry is not pruned afterward) |
| `workflow_id` | string | Which workflow produced this entry |
| `version_id` | string | Locked semver snapshot |
| `outcome` | enum | `complete` · `halted` |
| `started_at` | ISO 8601 | When the run started |
| `completed_at` | ISO 8601 | When the run ended |
| `summary_path` | string | Path to the run summary |

The Historian appends entries here after each run's terminal commit (via that
commit step's `logs_decision: true`). Never truncated — provides full audit
trail. ⚡ **DDR-031.** `cycle` → `workflow_run_id` + `workflow_id`.

---

### `discovery`

Discovery state — set during `sle discover`, frozen after completion.

| Field | Type | Description |
|---|---|---|
| `status` | enum | `not_started` · `in_progress` · `complete` |
| `artifacts` | string[] | Artifact paths produced by discovery |
| `current_phase` | integer | Current discovery phase (0 before start) |
| `total_phases` | integer | Total discovery phases planned |
| `open_questions_count` | integer | Unresolved questions remaining |
| `blocking_questions_count` | integer | Questions blocking `full-build` start |

Discovery is not itself a workflow (DDR-031) — it stays a distinct
pre-workflow mechanism. `full-build` requires `discovery.status: complete`
before it can start; other workflows may not.

---

### `repo`

Repository structure on disk. Used by agents to navigate the codebase.

| Field | Type | Description |
|---|---|---|
| `src` | string | Source directory path |
| `tests` | string | Test directory path |
| `scripts` | string | Scripts directory path |
| `docs` | string | Documentation directory path |
| `config` | string | Configuration directory path |
| `entry_points` | string[] | Main entry point files |
| `key_files` | object[] | Structurally significant files (path + role) |

The Historian updates `key_files` after each run based on what changed. The
`entry_points` list is populated during discovery.

---

## Fields that update after every workflow-run step

The system regenerates `map.yaml` by diffing real disk state against the
previous version. Fields that update automatically:

- `meta.generated_at`
- `meta.completed_run_count`
- `meta.version_id`
- `meta.status`
- `artifacts.files[*].last_updated`
- `artifacts.files[*].dirty`
- `artifacts.generated_outputs[*].path`
- `validation.categories[*].status`
- `validation.categories[*].last_run`
- `validation.gate.last_outcome`
- `validation.gate.failed_categories`
- `workflow_runs.{run_id}.*` (only the entry for the run that just stepped)
- `chat.session_open`
- `chat.session_id`
- `chat.mode`
- `graph.groups[*].completed`
- `graph.link_count`
- `graph.last_rebuilt_at`
- `history` (appended)
- `repo.key_files`

Fields that never change after init (unless re-synced from `agent.md`):

- `project.*`
- `remotes.*`
- `rules.files`
- `interfaces.*`

---

## Post-init defaults

At `sle init`, the following sections start empty or at zero:

| Section | Init value |
|---|---|
| `meta.completed_run_count` | `0` |
| `meta.version_id` | `v0.0.0` |
| `meta.status` | `idle` |
| `artifacts.files` | `{}` |
| `artifacts.generated_outputs` | `{}` |
| `workflow_runs` | `{}` |
| `chat.session_open` | `false` |
| `chat.session_id` | `null` |
| `chat.mode` | `freeform` |
| `graph.groups` | `[]` |
| `graph.layers` | `[]` |
| `history` | `[]` |
| `repo.entry_points` | `[]` |
| `repo.key_files` | `[]` |
| `discovery.status` | `not_started` |

A new entry is added to `workflow_runs` the moment a run starts (`POST
/api/v2/workflow-runs`), with `status: active`, `iteration: 0`, `revision: 0`,
`awaiting_checkpoint: null`, `claimed_artifacts: []`, `steps_completed: []`,
`current_step_id` set to the workflow's first step, `roles_completed: []`,
and `last_run` fields mirroring the entry's own `run_id`/`started_at` (rest
null/zero until completion).

---

## Template variants

At `sle init`, the project type determines default `validation.categories` and
`context.agent_slices`:

| Project type | Default categories |
|---|---|
| `api` | correctness · performance · security |
| `ui` | correctness · usability · accessibility · performance |
| `library` | correctness · compatibility · maintainability |
| `research` | correctness · reproducibility |
| `custom` | correctness only (user adds more) |

All templates include `correctness`.

---

**TypeScript types for map.yaml fields** are defined in [reference/types.md](types.md).
