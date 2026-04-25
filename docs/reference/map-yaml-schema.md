# map.yaml Schema

**Type:** reference · **Status:** draft · **Updated:** 2026-04-17

Authoritative schema for `map.yaml` — the single source of runtime truth for
every agent and interface connecting to an SLE project. Generated once at
`sle init`, regenerated automatically after every cycle.

Any agent bootstrapping into a session reads `agent.md` first, which references
this file. `map.yaml` describes reality. `agent.md` describes intent. They are
never merged.

**New fields in this revision:**

| Field | Source | Resolves |
|---|---|---|
| `cycle.awaiting_confirmation` | DDR-021 | G21, G27 |
| `cycle.awaiting_sharding_approval` | DDR-026 | G38 |
| `cycle.approval_gate.decision` | G27 | G27 |
| `cycle.approval_gate.approved_categories` | G27 | G27 |
| `cycle.approval_gate.decided_at` | G27 | G27 |
| `cycle.nodes_completed` | G31 | G31 |
| `cycle.current_node` | G31 | G31 |
| `cycle.roles_completed` | G31 | G31 |
| `artifacts.files[*].scope` | DDR-025 | G30 |
| `chat` | DDR-020 | 4.4.1 |
| `cycle.last_run` | DDR-022 | 4.4.2 |

---

## Annotated YAML schema

```yaml
meta:
  sle_version: "2.0.0"
  generated_at: "2026-04-17T10:00:00Z"
  project_type: api
  cycle: 4
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


cycle:
  number: 4
  iteration: 1
  max_iterations: 5
  planning_depth: standard
  started_at: "2026-04-17T09:00:00Z"
  completed_at: "2026-04-17T09:58:00Z"
  outcome: completed

  awaiting_confirmation: false
  awaiting_sharding_approval: false

  approval_gate:
    gate: "after_planning"
    decision: "approved"
    approved_categories:
      - correctness
      - performance
      - security
    decided_at: "2026-04-17T09:30:00Z"

  nodes_completed:
    - "intent"
    - "context_assembly"
    - "explore"
    - "design"
    - "plan"
    - "intake"
    - "sharding_approval"
    - "confirm"
    - "build"
    - "history"
    - "exec"
    - "validation_gate"
    - "evaluate"
    - "summarise"
    - "snapshot"

  current_node: null

  roles_completed:
    - "designer"
    - "planner"
    - "tester"
    - "builder"
    - "historian"
    - "evaluator"
    - "critic"
    - "facilitator"

  last_summary:
    path: "reports/summary-v0.4.0.md"
    generated_at: "2026-04-17T09:58:00Z"

  last_run:
    run_id: "run-20260417-001"
    started_at: "2026-04-17T09:00:00Z"
    completed_at: "2026-04-17T09:58:00Z"
    iteration_count: 1
    outcome: completed


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
  - cycle: 1
    version_id: "v0.1.0"
    outcome: completed
    started_at: "2026-04-10T08:00:00Z"
    completed_at: "2026-04-10T08:45:00Z"
    summary_path: "reports/summary-v0.1.0.md"

  - cycle: 2
    version_id: "v0.2.0"
    outcome: completed
    started_at: "2026-04-12T09:00:00Z"
    completed_at: "2026-04-12T09:50:00Z"
    summary_path: "reports/summary-v0.2.0.md"

  - cycle: 3
    version_id: "v0.3.0"
    outcome: completed
    started_at: "2026-04-15T10:00:00Z"
    completed_at: "2026-04-15T10:55:00Z"
    summary_path: "reports/summary-v0.3.0.md"

  - cycle: 4
    version_id: "v0.4.0"
    outcome: completed
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
    - path: "src/dag/runner.ts"
      role: "DAG execution engine"
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
| `cycle` | integer | Increments with every completed cycle |
| `version_id` | string | Semver of last locked version snapshot |
| `status` | enum | Current system state (see below) |

**`meta.status` values:**

| Value | Meaning |
|---|---|
| `idle` | No cycle or discovery running |
| `discovering` | `sle discover` in progress |
| `cycling` | Cycle DAG is executing (includes pauses at gates) |
| `halted` | Stopped by iteration cap or unrecoverable error |
| `complete` | All cycles finished, no further work queued |

Per DDR-020, chat is not a system state — it is an orthogonal session.
Per DDR-021, `confirming` is not a top-level state — it is expressed as
`cycle.awaiting_confirmation`.

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
| `active` | boolean | Whether this role participates in cycles |
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
| `required` | boolean | Cycle cannot complete without it |
| `append_only` | boolean? | System will never overwrite, only append |
| `last_updated` | ISO 8601 \| null | Timestamp of last write |
| `dirty` | boolean | Modified since last cycle snapshot |

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
`user_validation` · `summary` · `agents`.

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
operates independently of the cycle DAG. Multiple chat sessions may occur
within a single cycle, or outside of any cycle entirely.

| Field | Type | Description |
|---|---|---|
| `session_open` | boolean | Whether a chat session is currently active |
| `session_id` | string \| null | Unique session identifier (null when no session) |
| `mode` | enum | `freeform` · `decision` |

In `freeform` mode the user chats with the Facilitator without constraint.
In `decision` mode the Facilitator presents options and records a structured
choice (used by approval gates).

---

### `cycle`

The core cycle state section. Updated after every node completion for crash
recovery (G31).

**Core fields:**

| Field | Type | Description |
|---|---|---|
| `number` | integer | Current cycle number (0 at init, increments per cycle) |
| `iteration` | integer | Iteration within this cycle (resets on new cycle) |
| `max_iterations` | integer | From `planning.yaml` |
| `planning_depth` | enum | `minimal` · `standard` · `deep` · `research` |
| `started_at` | ISO 8601 | When this cycle started |
| `completed_at` | ISO 8601? | When this cycle completed |
| `outcome` | enum | `completed` · `halted` · `running` |

**Gate flags (DDR-021, DDR-026):**

| Field | Type | Description |
|---|---|---|
| `awaiting_confirmation` | boolean | **DDR-021:** CONFIRM gate pending human response |
| `awaiting_sharding_approval` | boolean | **DDR-026:** Sharding proposal pending human review |

Both are `false` by default. When `true`, `meta.status` stays `cycling`. The
Facilitator enters decision mode. On daemon restart, these flags tell the
system exactly which interaction to resume.

**Approval gate record (G27):**

| Field | Type | Description |
|---|---|---|
| `approval_gate.gate` | string \| null | Gate name: `after_planning` · `after_gate_pass` · `sharding` · null |
| `approval_gate.decision` | enum \| null | `approved` · `rejected` · null |
| `approval_gate.approved_categories` | string[] | Categories confirmed during this gate |
| `approval_gate.decided_at` | ISO 8601 \| null | When the user responded |

Written immediately when the user responds, before resuming the DAG. On crash
recovery, the daemon reads `approval_gate.decision` to determine whether to
re-prompt or resume.

**Progress tracking (G31):**

| Field | Type | Description |
|---|---|---|
| `nodes_completed` | string[] | DAG node IDs completed this iteration |
| `current_node` | string \| null | Node currently executing (null between iterations) |
| `roles_completed` | string[] | Agent roles that have written outputs this iteration |

Written after every node completion, before the next node starts. On daemon
restart, the daemon reads `nodes_completed` to skip already-run nodes and
resumes at `current_node`.

**Summary:**

| Field | Type | Description |
|---|---|---|
| `last_summary.path` | string | Path to the cycle summary document |
| `last_summary.generated_at` | ISO 8601 | When the summary was generated |

**Last run record:**

| Field | Type | Description |
|---|---|---|
| `last_run.run_id` | string | Unique identifier for the most recent run |
| `last_run.started_at` | ISO 8601 | When the run started |
| `last_run.completed_at` | ISO 8601 | When the run completed |
| `last_run.iteration_count` | integer | Number of iterations in this run |
| `last_run.outcome` | CycleOutcome | Final outcome of the run |

---

### `graph`

Project graph metadata — populated after discovery and updated after each cycle.

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

Append-only log of completed cycles. Each entry:

| Field | Type | Description |
|---|---|---|
| `cycle` | integer | Cycle number |
| `version_id` | string | Locked semver snapshot |
| `outcome` | enum | `completed` · `halted` |
| `started_at` | ISO 8601 | When the cycle started |
| `completed_at` | ISO 8601 | When the cycle ended |
| `summary_path` | string | Path to the cycle summary |

The Historian appends entries here after each cycle. Never truncated — provides
full audit trail.

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
| `blocking_questions_count` | integer | Questions blocking cycle start |

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

The Historian updates `key_files` after each cycle based on what changed. The
`entry_points` list is populated during discovery.

---

## Fields that update after every cycle

The system regenerates `map.yaml` by diffing real disk state against the
previous version. Fields that update automatically:

- `meta.generated_at`
- `meta.cycle`
- `meta.version_id`
- `meta.status`
- `artifacts.files[*].last_updated`
- `artifacts.files[*].dirty`
- `artifacts.generated_outputs[*].path`
- `validation.categories[*].status`
- `validation.categories[*].last_run`
- `validation.gate.last_outcome`
- `validation.gate.failed_categories`
- `cycle.*`
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
| `meta.cycle` | `0` |
| `meta.version_id` | `v0.0.0` |
| `meta.status` | `idle` |
| `artifacts.files` | `{}` |
| `artifacts.generated_outputs` | `{}` |
| `cycle.number` | `0` |
| `cycle.iteration` | `0` |
| `cycle.outcome` | `idle` |
| `cycle.awaiting_confirmation` | `false` |
| `cycle.awaiting_sharding_approval` | `false` |
| `cycle.approval_gate.gate` | `null` |
| `cycle.approval_gate.decision` | `null` |
| `cycle.approval_gate.approved_categories` | `[]` |
| `cycle.approval_gate.decided_at` | `null` |
| `cycle.nodes_completed` | `[]` |
| `cycle.current_node` | `null` |
| `cycle.roles_completed` | `[]` |
| `cycle.last_run.run_id` | `null` |
| `cycle.last_run.started_at` | `null` |
| `cycle.last_run.completed_at` | `null` |
| `cycle.last_run.iteration_count` | `0` |
| `cycle.last_run.outcome` | `null` |
| `chat.session_open` | `false` |
| `chat.session_id` | `null` |
| `chat.mode` | `freeform` |
| `graph.groups` | `[]` |
| `graph.layers` | `[]` |
| `history` | `[]` |
| `repo.entry_points` | `[]` |
| `repo.key_files` | `[]` |
| `discovery.status` | `not_started` |

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
