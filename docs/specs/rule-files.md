# Rule Files

**Type:** spec · **Status:** draft · **Updated:** 2026-04-17
**Depends on:** DDR-002, DDR-023
**Source material:** SLE-004, reference/agents-yaml-schema.md

## Overview

All SLE system behavior is governed by seven YAML rule files. No behavior is
hardcoded in the application. Changing how the system behaves means editing a
rule file — not touching code.

The seven files (DDR-002):

| File | Purpose | Per-project-type variance |
|---|---|---|
| `planning.yaml` | Reasoning depth, iteration caps, token budgets | Depth, iterations, slice size, critic |
| `validation.yaml` | Static analysis, container config, validation categories | Category set per type |
| `artifacts.yaml` | Document declarations, generators, generated outputs | None |
| `exit.yaml` | Cycle completion conditions, cap-hit and error behavior | None |
| `user_validation.yaml` | Approval gates, prompts, timeouts | None |
| `summary.yaml` | Summary format, sections, output path | None |
| `agents.yaml` | Agent roles, LLM providers, per-role overrides | None (DDR-002) |

File locations:

```
.sle/
  rules/
    planning.yaml
    validation.yaml
    artifacts.yaml
    exit.yaml
    user_validation.yaml
    summary.yaml
    agents.yaml
  overrides/
    planning.yaml
    ...
  prompts/
    correctness_check.md
    performance_check.md
    ...
```

Global defaults ship with `@sle/sdk`. Project-level files in `.sle/rules/`
override specific fields. Override files in `.sle/overrides/` layer on top of
project rules. The rule loader merges all three layers at daemon start.

Per-project-type default values:
[reference/rule-file-defaults.md](../reference/rule-file-defaults.md)

---

## Data model

### Loading order

The rule loader runs once at daemon start and produces a single `RuntimeConfig`
object injected into the DAG runner. Files are loaded in dependency order:

```
1. planning.yaml      (depth, critic_enabled → affect which agents activate)
2. agents.yaml        (agent roles, LLM config → affect all downstream)
3. artifacts.yaml     (document declarations → affect validation, summary)
4. validation.yaml    (categories, static analysis → depends on artifacts)
5. exit.yaml          (conditions → depends on validation categories)
6. user_validation.yaml (approval gates → depends on validation categories)
7. summary.yaml       (format, sections → depends on artifacts, validation)
```

### Merge semantics

```
global defaults (shipped with @sle/sdk)
  ↓ deep merge
.sle/rules/{file}.yaml  (project rules — written at sle init)
  ↓ deep merge
.sle/overrides/{file}.yaml  (optional, user-created)
  ↓
RuntimeConfig
```

Deep merge means nested keys override individually. A project rule file that
sets only `planning.max_iterations: 3` does not wipe out other `planning`
defaults.

**Array merge rule:** Arrays are replaced wholesale, not merged element-wise.
If `.sle/rules/validation.yaml` defines `categories: [...]`, it replaces the
global default categories entirely. Override files follow the same rule.

**agents.yaml merge chain** (4-layer resolution):

```
defaults.llm                        (shipped with @sle/sdk)
  ↓ deep merge
.sle/rules/agents.yaml → defaults  (project-level default overrides)
  ↓ deep merge per agent
.sle/rules/agents.yaml → agents.*  (per-role overrides)
  ↓ deep merge
.sle/overrides/agents.yaml          (user-created, highest priority)
  ↓
RuntimeConfig
```

Resolution order for each agent field:

1. Agent-level override in `.sle/overrides/agents.yaml`
2. Agent-level override in `.sle/rules/agents.yaml`
3. Default in `.sle/rules/agents.yaml → defaults`
4. Shipped default from `@sle/sdk`

`temperature`, `max_tokens`, and `system_prompt` resolve identically:
agent-level override wins, then `defaults`, then shipped values.

### RuntimeConfig

```typescript
export interface RuntimeConfig {
  planning: PlanningConfig
  validation: ValidationConfig
  artifacts: ArtifactsConfig
  exit: ExitConfig
  user_validation: UserValidationConfig
  summary: SummaryConfig
  agents: AgentsConfig
}
```

### PlanningDepth

```typescript
type PlanningDepth = 'minimal' | 'standard' | 'deep' | 'research'
```

### PlanningConfig

```typescript
export interface PlanningConfig {
  depth: PlanningDepth
  max_iterations: number
  artifact_slice_size: number
  summary_max_tokens: number
  system_prompt_max_tokens: number
  reasoning_passes: Record<PlanningDepth, number>
  critic_enabled: boolean | null
  on_depth_change: 're_plan' | 'continue'
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `depth` | enum | `standard` | Planning depth for this project |
| `max_iterations` | integer | `5` | Iteration cap before exit.yaml fires |
| `artifact_slice_size` | integer | `2000` | Token budget per artifact in context |
| `summary_max_tokens` | integer | `400` | Token budget for decisions.md injection |
| `system_prompt_max_tokens` | integer | `500` | Token budget for system prompt |
| `reasoning_passes` | map | per depth | LLM calls the Planner makes per depth |
| `critic_enabled` | bool \| null | `null` | Override Critic activation. `null` = infer from depth |
| `on_depth_change` | enum | `re_plan` | Behavior when depth changes mid-project |

### ValidationConfig

```typescript
export interface ValidationConfig {
  static_analysis: StaticAnalysisConfig
  container: ContainerConfig
  categories: ValidationRuleCategory[]
}
```

### ValidationRuleCategory

```typescript
export interface ValidationRuleCategory {
  name: string
  method: 'llm' | 'executable' | 'both'
  executable?: {
    runner: string
    timeout_ms: number
    output_format: 'json'
  }
  llm?: {
    artifact_slice: string[]
    prompt_template: string
    pass_threshold: number
  }
  pass_criteria: {
    executable?: 'all_pass' | 'any_pass' | `threshold:${number}` | Record<string, number>
    llm?: 'verdict_pass' | string
  }
  on_fail: {
    feed_to: 'planner' | 'evaluator'
    include: string[]
  }
}
```

### StaticAnalysisConfig

```typescript
export interface StaticAnalysisCheck {
  command: string
  enabled: boolean
  pass_criteria: Record<string, number>
}

export interface StaticAnalysisConfig {
  lint: StaticAnalysisCheck
  typecheck: StaticAnalysisCheck
  complexity: StaticAnalysisCheck
}
```

### ContainerConfig

```typescript
export interface ContainerConfig {
  base_image: string
  install_command: string
  timeout_ms: number
}
```

### ArtifactsConfig

```typescript
export interface ArtifactRule {
  id: string
  path?: string
  generator: 'designer' | 'explorer' | 'planner' | 'tester' | 'builder' | 'debugger' | 'historian' | 'evaluator' | 'critic' | 'facilitator' | 'discovery'
  required: boolean
  append_only: boolean
  format: 'markdown' | 'json' | 'yaml'
}
```

Ephemeral artifacts omit `path` — resolved from in-memory daemon state, not disk.

**Artifact scope resolution:**

| Scope | Resolution strategy |
|-------|---------------------|
| `project` | `.sle/project-docs/{key}.md` or `docs/{key}.md` |
| `group` | `.sle/project-graph/layers/{group}/{key}.md` |
| `run` | `.sle/runs/{id}/{key}` |
| `ephemeral` | In-memory daemon state (no disk path) |

### ExitConfig

```typescript
export interface ExitConfig {
  conditions: {
    all_categories_pass: boolean
    requirements_met: boolean
  }
  on_cap_hit: 'halt_with_report' | 'user_prompt' | 'force_pass'
  halt_behavior: {
    write_partial_report: boolean
    notify_user: boolean
    block_version_snapshot: boolean
    preserve_decisions: boolean
  }
  on_error: {
    behavior: 'halt' | 'retry_once' | 'notify_and_wait'
    write_error_report: boolean
    block_version_snapshot: boolean
  }
}
```

### UserValidationConfig

```typescript
export interface UserValidationConfig {
  approval_required: boolean
  review_at: ('after_planning' | 'after_gate_pass')[]
  prompts: Record<string, string>
  timeout_minutes: number
  on_timeout: 'auto_approve' | 'halt' | 'notify_and_wait'
  auto_approve_on_rerun: boolean
}
```

### SummaryConfig

```typescript
export interface SummaryConfig {
  format: 'markdown' | 'html' | 'json'
  sections: string[]
  test_command_format: 'shell' | 'npm_script' | 'makefile'
  show_confidence_scores: boolean
  show_failed_test_ids: boolean
  what_was_built_max_tokens: number
  next_steps_max_count: number
  output_path: string
}
```

### AgentsConfig

Full schema and per-role reference:
[reference/agents-yaml-schema.md](../reference/agents-yaml-schema.md)

```typescript
export interface AgentLLMConfig {
  provider: 'openai_compatible' | 'anthropic'
  base_url?: string
  model: string
  api_key_env: string
}

export interface AgentRoleConfig {
  active: boolean
  node: string | null
  llm: AgentLLMConfig
  temperature: number
  max_tokens: number
  system_prompt: string
  artifact_slice: string[]
  outputs: string[]
  conditional: boolean
  condition?: string
  constraints?: string[]
  append_only?: boolean
  session_types?: string[]
  trigger_node?: string
}

export interface AgentsConfig {
  defaults: {
    llm: AgentLLMConfig
    temperature: number
    max_tokens: number
    system_prompt_root: string
  }
  providers: Record<string, AgentLLMConfig>
  agents: Record<string, AgentRoleConfig>
}
```

10 agent roles: designer, explorer, planner, tester, builder, debugger,
evaluator, critic, historian, facilitator.

---

## Behavior

### Rule loader

The rule loader runs once at daemon start:

1. Read all 7 files from the three-layer merge chain
2. Validate each file against its schema (see Validation below)
3. Deep merge in order: global defaults → `.sle/rules/` → `.sle/overrides/`
4. Resolve cross-file references (e.g., `critic_enabled` affects agent activation)
5. Produce `RuntimeConfig` and inject into DAG runner

If any file is invalid, the daemon refuses to start and reports the exact field
and line number of the error.

### Schema validation

The loader validates each file against its schema before merging. Validation
rules:

| File | Required top-level keys | Invariants |
|---|---|---|
| `planning.yaml` | `depth`, `max_iterations` | `max_iterations >= 1`; `depth` must be valid enum |
| `validation.yaml` | `static_analysis`, `container`, `categories` | Category names unique; `method` determines which sub-configs are required |
| `artifacts.yaml` | `artifacts` | Artifact IDs unique; paths relative; `required` artifacts must have `generator` |
| `exit.yaml` | `conditions`, `on_cap_hit` | `on_cap_hit` must be valid enum |
| `user_validation.yaml` | `approval_required` | `review_at` entries must be valid enum values |
| `summary.yaml` | `format`, `sections` | `sections` entries must be from known set |
| `agents.yaml` | `defaults`, `agents` | Agent keys must be from known role set; `conditional: true` requires `condition` |

### LLM write boundary

The LLM may append to `validation.yaml → categories[]` at planning time. This
is the only runtime modification the LLM is permitted to make.

The LLM cannot modify:

- `planning.yaml` — any field
- `artifacts.yaml` — any field
- `exit.yaml` — any field
- `user_validation.yaml` — any field
- `summary.yaml` — any field
- `agents.yaml` — any field
- `validation.yaml → categories[*]` for existing categories
- `validation.yaml` — any field outside `categories[]`

Enforced by the daemon: all rule file writes go through a gated write API that
checks the caller identity and field path before committing.

### planning.yaml — behavioral rules

**Depth behavior:**

| Depth | Reasoning passes | Critic | Artifact slice | Use case |
|---|---|---|---|---|
| `minimal` | 1 | No | 1000 tokens | Prototyping |
| `standard` | 2 | No | 2000 tokens | Normal dev |
| `deep` | 3 | Yes (1 pass) | 3000 tokens | Production |
| `research` | 4+ | Yes (multi-pass) | 4000 tokens | Complex architecture |

**Critic activation (DDR-022):**

`critic_enabled` resolves as follows:

1. If `critic_enabled: true` → Critic runs
2. If `critic_enabled: false` → Critic does not run
3. If `critic_enabled: null` → infer from `depth`:
   - `deep` or `research` → Critic runs at DESIGN node
   - `minimal` or `standard` → Critic does not run

When active, the Critic runs at the DESIGN node (DDR-022), reviewing the
Designer's output (architecture + requirements). DAG flow becomes:
`SCOPING (conditional) → DESIGN → CRITIQUE → PLAN → TEST → CONFIRM → BUILD → ...`

**SCOPING / Explorer trigger (DDR-023, updated DDR-028):**

`planning.depth` does NOT auto-trigger the Explorer. The Explorer is now
triggered by the SCOPING node (DDR-028) when unknowns are flagged. Automatic gap
detection is a separate mechanism — see [validation.md](validation.md).

**Depth change mid-project:**

`on_depth_change` controls what happens when the user changes `depth` between
cycles:

| Value | Behavior |
|---|---|
| `re_plan` | Discard current plan, re-plan from scratch with new depth |
| `continue` | Continue with existing plan, new depth applies to next cycle only |

**Token budget enforcement:**

The context manager respects `artifact_slice_size` by truncating artifact
content to fit within the token budget. `summary_max_tokens` limits the
decisions.md injection. `system_prompt_max_tokens` limits the system prompt
template size. Truncation is suffix-preserving: the most recent content is
kept when truncation is necessary.

### validation.yaml — behavioral rules

**Static analysis execution:**

Static analysis (lint, typecheck, complexity) runs before test execution inside
the Docker container. If any check fails, tests are skipped. Configuration:

| Check | Default command | Pass criteria |
|---|---|---|
| `lint` | `npx eslint src/ --format json` | `max_errors: 0`, `max_warnings: 50` |
| `typecheck` | `npx tsc --noEmit` | `max_errors: 0` |
| `complexity` | `npx complexity-report --format json --threshold 15 src/` | `max_complexity: 15` |

Commands are determined at `sle init` based on project type. All checks can be
individually disabled via `enabled: false`.

**Container isolation:**

All test execution runs inside a fresh Docker container per iteration. Container
config:

| Field | Default | Description |
|---|---|---|
| `base_image` | `node:20-slim` | Determined at `sle init` by project type |
| `install_command` | `npm install` | Dependency installation |
| `timeout_ms` | `120000` | Overall container timeout |

**Category selection per project type:**

| Project type | Default active categories |
|---|---|
| `api` | correctness, performance, security |
| `ui` | correctness, usability, performance |
| `library` | correctness, compatibility, maintainability |
| `research` | correctness, reproducibility |
| `custom` | correctness only |

Every project type includes `correctness` as the first category. The Planner
may append additional categories at planning time — the user confirms before
BUILD starts.

**Category method determines sub-phases:**

| Method | `static-check` | `llm-check` | `exec-check` |
|---|---|---|---|
| `llm` | Yes (global) | Yes | No |
| `executable` | Yes (global) | No | Yes |
| `both` | Yes (global) | Yes | Yes |

**Category pass criteria:**

| `pass_criteria.executable` | Meaning |
|---|---|
| `all_pass` | `failed.length == 0 AND errors.length == 0` |
| `any_pass` | At least one test passed |
| `threshold:{n}` | At least n% of tests passed |
| map of metric thresholds | All named metrics within threshold |

**On-fail routing:**

`on_fail.feed_to` determines which agent receives failure context:

| Value | Target | When |
|---|---|---|
| `planner` | Planner agent | Default — for fixable issues |
| `evaluator` | Evaluator agent | For structural/design issues |

`on_fail.include` controls what context is injected: `failed_tests`,
`llm_issues`, `metrics`, or any combination.

### artifacts.yaml — behavioral rules

**Artifact declarations:**

| ID | Path | Generator | Required | Append-only |
|---|---|---|---|---|
| `requirements` | `docs/requirements.md` | designer | Yes | No |
| `architecture` | `docs/architecture.md` | designer | Yes | No |
| `test-plan` | `docs/test-plan.md` | planner | Yes | No |
| `plan` | `docs/plan.md` | planner | Yes | No |
| `decisions` | `docs/decisions.md` | historian | Yes | Yes |
| `evaluation` | `docs/evaluation.md` | evaluator | Yes | No |
| `build-plan` | `docs/build-plan.md` | planner | No | No |

Identical across all project types. Variance comes from `validation.yaml`
controlling which categories run.

**Required artifacts block cycle completion.** If a required artifact's file
does not exist when the cycle attempts to complete, the cycle fails.

**Append-only artifacts** are never overwritten — the system only appends new
entries. `decisions.md` uses this to maintain a chronological log.

**Generated outputs** are produced at specific lifecycle points:

| ID | Type | Generated at |
|---|---|---|
| `test_runner` | executable | gate_pass |
| `validation_report` | html | gate_pass |
| `changelog` | markdown | gate_pass |

`generated_at` controls when:

| Value | Meaning |
|---|---|
| `gate_pass` | After validation gate passes |
| `cycle_end` | After cycle completes (pass or fail) |
| `always` | After every iteration |

`build-plan` is optional and only generated at `deep` or `research` depth. `plan` is always produced at all depths.

### exit.yaml — behavioral rules

**Cycle completion requires both conditions:**

1. `all_categories_pass: true` — the validation gate must pass
2. `requirements_met: true` — a post-gate LLM sanity check reads
   `requirements.md` and the evaluation report and confirms the implementation
   satisfies the stated requirements

If `requirements_met` fails after gate pass, the cycle returns to the gate as a
special retry with only the requirements alignment context injected.

**Iteration cap behavior:**

When `planning.yaml → max_iterations` is reached without passing:

| `on_cap_hit` | Behavior |
|---|---|
| `halt_with_report` | Write partial report, notify user, block snapshot |
| `user_prompt` | Pause cycle, ask user: continue or halt |
| `force_pass` | Lock snapshot despite failures (not recommended) |

**Halt behavior:**

| Field | Default | Description |
|---|---|---|
| `write_partial_report` | `true` | Generate reports even on halt |
| `notify_user` | `true` | Push notification to all interfaces |
| `block_version_snapshot` | `true` | Do not lock a version on halt |
| `preserve_decisions` | `true` | Always keep decisions.md intact |

**Error behavior:**

| `on_error.behavior` | Action |
|---|---|
| `halt` | Stop immediately, write error report |
| `retry_once` | One retry attempt, then halt |
| `notify_and_wait` | Notify user, wait for manual resolution |

Errors include: daemon crash, script timeout, Docker unavailable, container
start failure.

### user_validation.yaml — behavioral rules

**Approval gates:**

When `approval_required: true`, the system pauses at configured review points:

| Point | When | Template variables |
|---|---|---|
| `after_planning` | After Planner produces categories, before BUILD | `{{categories}}` |
| `after_gate_pass` | After validation passes, before version snapshot | `{{cycle}}`, `{{summary}}`, `{{version_id}}` |

The user can accept, modify, or reject at each gate.

**Disabling approval:**

Setting `approval_required: false` skips all gate points. The system completes
cycles without pausing. Useful in CI pipelines or for low-stakes automation.

**Timeout behavior:**

| `on_timeout` | Action when user doesn't respond within `timeout_minutes` |
|---|---|
| `auto_approve` | Proceed as if user approved |
| `halt` | Stop the cycle |
| `notify_and_wait` | Re-notify and continue waiting |

`auto_approve_on_rerun: false` ensures automated re-runs (e.g., CI) still
respect approval gates unless explicitly set to `true`.

### summary.yaml — behavioral rules

**Sections (ordered):**

| Section | Content |
|---|---|
| `what_was_built` | 2–4 sentence LLM paragraph from decisions.md delta, max `what_was_built_max_tokens` tokens |
| `what_changed` | Artifact-level diff list (not line-level) |
| `category_results` | Markdown table: Category, Method, LLM verdict, Confidence, Tests passed, Tests failed, Status |
| `how_to_test` | Exact commands per `test_command_format` for each generated test script |
| `next_steps` | Up to `next_steps_max_count` LLM suggestions from evaluation.md |

`sections[]` is ordered — the summary renders sections in array order. Remove a
section from the array to disable it.

**Test command formats:**

| Format | Example |
|---|---|
| `shell` | `npx ts-node scripts/test_correctness.ts` |
| `npm_script` | `npm run test:correctness` |
| `makefile` | `make test-correctness` |

**Output path** supports template variable `{{version_id}}`. Default:
`reports/summary-{{version_id}}.md`.

**Display options:**

| Field | Default | Effect |
|---|---|---|
| `show_confidence_scores` | `true` | Include LLM confidence in category_results table |
| `show_failed_test_ids` | `true` | Include individual failed test IDs |

### agents.yaml — behavioral rules

Full schema: [reference/agents-yaml-schema.md](../reference/agents-yaml-schema.md)

**10 agent roles:**

| Role | Node | Conditional | Trigger | Active by default |
|---|---|---|---|---|
| Designer | `design` | No | — | Yes |
| Explorer | `explore` | Yes | `user_initiated` (DDR-023) | No |
| Planner | `plan` | No | — | Yes |
| Tester | `test` | No | — | Yes |
| Builder | `build` | No | — | Yes |
| Debugger | `debug` | Yes | `gate_failure` | Yes |
| Evaluator | `evaluate` | No | — | Yes |
| Critic | `critique` | Yes | `depth_deep_or_research` (DDR-022) | Yes |
| Historian | `history` | No | — | Yes |
| Facilitator | null | No | — | Yes |

**Key behaviors:**

- **Designer** owns `requirements.md` + `architecture.md` (DDR-019)
- **Explorer** is user-initiated only; not auto-triggered by `planning.depth`
  (DDR-023)
- **Planner** owns `test-plan.md` + `plan.md` + `build-plan.md` (deep/research only) (DDR-019)
- **Tester** has constraint `never_sees_builder_output` — TDD separation
- **Builder** has the highest token budget (16000) and receives test scripts as
  a contract
- **Debugger** only activates on gate failure; diagnoses only — never plans or
  builds
- **Critic** runs at the DESIGN node (DDR-022), reviews architecture +
  requirements. Only at `deep` or `research` depth
- **Historian** is append-only — never overwrites decisions.md
- **Facilitator** operates in discovery and chat sessions only, never builds

**Provider configuration:**

| Provider | `provider` value | `base_url` |
|---|---|---|
| OpenAI | `openai_compatible` | `https://api.openai.com/v1` |
| OpenRouter | `openai_compatible` | `https://openrouter.ai/api/v1` |
| GLM (ZhipuAI) | `openai_compatible` | `https://open.bigmodel.cn/api/paas/v4` |
| Zai Coding Plan | `openai_compatible` | Zai endpoint |
| Claude (Anthropic) | `anthropic` | null (native SDK) |

Mixed provider routing is supported — override `llm` at the agent level to
route specific agents through different providers. All other fields inherit
from `defaults`.

---

## API contract

### Get rule file

```
GET /api/v2/rules/{file}

Response 200:
{
  "file":               string,
  "content":            object,
  "source":             "defaults" | "rules" | "overrides" | "merged",
  "merged_from": {
    "defaults":         object,
    "rules":            object | null,
    "overrides":        object | null
  }
}

Response 404:
{ "error": "unknown_rule_file", "valid_files": string[] }
```

Returns the merged content of a rule file. Query parameter `source` controls
which layer is returned:

| `source` value | Returns |
|---|---|
| `defaults` | Shipped defaults only |
| `rules` | `.sle/rules/{file}.yaml` only |
| `overrides` | `.sle/overrides/{file}.yaml` only |
| `merged` (default) | Fully merged RuntimeConfig slice |

### Update rule file

```
PUT /api/v2/rules/{file}

Request:
{
  "content":    object,
  "layer":      "rules" | "overrides"
}

Response 200:
{
  "file":               string,
  "layer":              string,
  "validation_errors":  null
}

Response 400:
{
  "error":               "validation_failed",
  "validation_errors": [
    { "path": string, "message": string, "line": number | null }
  ]
}

Response 403:
{ "error": "llm_write_boundary", "path": string, "reason": string }
```

Validates the content against the file's schema before writing. If validation
fails, no changes are persisted. The gated write API enforces the LLM write
boundary.

### Append validation category (LLM-permitted)

```
POST /api/v2/rules/validation/categories

Request:
{
  "category":   ValidationRuleCategory,
  "caller":     "planner"
}

Response 201:
{
  "name":       string,
  "position":   number
}

Response 403:
{ "error": "unauthorized_caller", "allowed_callers": ["planner"] }

Response 409:
{ "error": "duplicate_category", "name": string }

Response 422:
{
  "error":               "validation_failed",
  "validation_errors": [
    { "path": string, "message": string }
  ]
}
```

The only write endpoint the LLM may call. Validates the category schema before
appending. Rejects duplicate names. Rejects modifications to existing
categories.

### Validate rule file (dry run)

```
POST /api/v2/rules/{file}/validate

Request:
{
  "content":    object
}

Response 200:
{
  "valid":              true,
  "validation_errors":  null
}

Response 422:
{
  "valid":              false,
  "validation_errors": [
    { "path": string, "message": string, "line": number | null }
  ]
}
```

Validates content without persisting. Used by the CLI and editor integrations
to provide real-time feedback.

### Get runtime config (resolved)

```
GET /api/v2/rules/_runtime

Response 200:
{
  "planning":          PlanningConfig,
  "validation":        ValidationConfig,
  "artifacts":         ArtifactsConfig,
  "exit":              ExitConfig,
  "user_validation":   UserValidationConfig,
  "summary":           SummaryConfig,
  "agents":            AgentsConfig
}
```

Returns the fully merged `RuntimeConfig` as loaded by the rule loader. This is
the exact object injected into the DAG runner.

### WebSocket events

| Event | Payload | When |
|---|---|---|
| `rules.file_updated` | `file, layer, updated_by` | Any rule file written |
| `rules.validation_failed` | `file, errors[]` | Validation fails on write attempt |
| `rules.category_added` | `name, caller, position` | LLM appends validation category |

---

## Error cases

### Loading errors

| Error | Condition | Response |
|---|---|---|
| `file_not_found` | Required rule file missing from `.sle/rules/` | Daemon refuses to start. `sle init` must be run first |
| `parse_error` | YAML syntax error in any rule file | Daemon refuses to start. Reports file, line, column |
| `schema_violation` | Valid YAML but doesn't match schema | Daemon refuses to start. Reports exact field path |
| `invalid_depth` | `planning.depth` not in enum set | Daemon refuses to start |
| `duplicate_category` | Two categories with same `name` in validation.yaml | Daemon refuses to start |
| `duplicate_artifact` | Two artifacts with same `id` in artifacts.yaml | Daemon refuses to start |
| `missing_required_field` | Required top-level key absent | Daemon refuses to start |
| `unknown_agent_role` | Agent key not in known role set | Daemon refuses to start |

### Merge errors

| Error | Condition | Response |
|---|---|---|
| `type_mismatch` | Override field type differs from schema | Reject override, log warning, use rules-layer value |
| `array_merge_conflict` | Array in overrides conflicts with rules-layer array | Override replaces wholesale (documented behavior, not an error) |

### Runtime write errors

| Error | Condition | Response |
|---|---|---|
| `llm_write_boundary` | LLM attempts to write outside `validation.yaml → categories[]` | 403, write blocked |
| `unauthorized_caller` | Non-planner attempts to append category | 403 |
| `duplicate_category` | Category name already exists in `categories[]` | 409 |
| `immutable_category` | Attempt to modify existing category entry | 403 |
| `write_during_cycle` | Write to rule file while cycle is active | 409, write queued until cycle completes |

### Cross-file consistency errors

| Error | Condition | Response |
|---|---|---|
| `orphaned_category` | validation.yaml references artifact not in artifacts.yaml | Warning at load, category runs with reduced context |
| `unknown_generator` | artifacts.yaml references generator not in agents.yaml | Daemon refuses to start |
| `depth_critic_mismatch` | `critic_enabled: true` but critic agent `active: false` | Warning at load, critic_enabled wins |

---

## Constraints

1. **Seven files only (DDR-002).** The system recognizes exactly seven rule
   files. No additional files are loaded. Custom configuration must fit within
   the existing schema or use `.sle/overrides/`.

2. **Deep merge, not replace.** Nested keys override individually. Array keys
   replace wholesale. This is the only merge strategy.

3. **Three-layer maximum.** Global defaults → `.sle/rules/` →
   `.sle/overrides/`. No deeper nesting, no conditional layers.

4. **Schema validation is strict.** Unknown keys, wrong types, and missing
   required fields are all rejected. Extra keys are not silently ignored.

5. **LLM write boundary.** The LLM may only append new categories to
   `validation.yaml → categories[]`. No other runtime modifications to any
   rule file. Enforced by the gated write API.

6. **Loading order matters.** Files are loaded in dependency order
   (planning → agents → artifacts → validation → exit → user_validation →
   summary). Cross-file references are resolved after all files are loaded.

7. **Daemon refuses to start on invalid config.** No partial loading, no
   fallback to defaults when a project file is malformed. The user must fix
   the error before the daemon can start.

8. **Critic activation follows depth (DDR-022).** When `critic_enabled: null`,
   the Critic runs at DESIGN node for `deep` and `research` depth only. Explicit
   `true` or `false` overrides depth inference.

9. **Explorer is triggered by SCOPING (DDR-023, updated DDR-028).**
   `planning.depth: research` or `deep` does NOT auto-trigger the Explorer.
   The Explorer runs when SCOPING detects unknowns. Automatic gap detection is a
   separate mechanism.

10. **Category caching across iterations.** Passing categories are never re-run
    on retry. Invalidation occurs on plan revision or structural failure
    escalation. Cache is scoped to the current cycle.

11. **Required artifacts block completion.** A cycle cannot complete if any
    artifact with `required: true` is missing. Append-only artifacts are never
    overwritten.

12. **Container isolation for validation.** All test execution runs inside a
    fresh Docker container per iteration. Container is destroyed after results
    are captured.

13. **All categories must pass.** Mode is `all_must_pass`. No partial pass, no
    weighted scoring (except `force_pass` in `exit.yaml`).

14. **RuntimeConfig is immutable during a cycle.** Once loaded, the
    RuntimeConfig is frozen. Changes during a cycle are queued and applied at
    the next daemon restart.

15. **agents.yaml is identical across project types (DDR-002).** Users
    customize by editing `llm.provider`, `llm.base_url`, `llm.model`, and
    `llm.api_key_env` after init.

16. **Override files are optional.** `.sle/overrides/` may not exist. The rule
    loader skips the override layer if the directory or file is absent.

17. **Template variables in paths.** `{{version_id}}` in `summary.yaml` and
    `artifacts.yaml` output paths is resolved at generation time by the
    snapshot system.

---

## Open questions

| ID | Question | Impact | Status |
|---|---|---|---|
| RF-001 | Should the rule loader support environment variable interpolation in YAML values (e.g., `base_image: ${SLE_BASE_IMAGE}`)? | Deployment flexibility, container config | Open |
| RF-002 | Should `.sle/overrides/` support partial files (e.g., only `agents.designer.llm` without the full `agents` schema)? | Override ergonomics | Open |
| RF-003 | What is the maximum allowed size for a rule file before the loader rejects it? | Memory, parse time | Open |
| RF-004 | Should the API support rolling back a rule file change to the previous version? | Undo, safety | Open |
| RF-005 | Should `planning.yaml` support a `depth_overrides` map for per-cycle depth changes without modifying the file? | Temporary depth changes | Open |
| RF-006 | Should `agents.yaml` support custom agent roles beyond the 10 built-in roles? | Extensibility | Open |
| RF-007 | How many LLM-defined categories can the Planner add before the system flags potential runaway? | Resource bounding | Open |
| RF-008 | Should the gated write API support batch category appends (multiple categories in one call)? | LLM planning efficiency | Open |
| RF-009 | Should there be a `sle rules diff` CLI command showing the difference between defaults, rules, and overrides layers? | Debugging, transparency | Open |
| RF-010 | Should `validation.yaml` support category dependencies (e.g., security only runs if correctness passes)? | Execution efficiency, cost | Open |
