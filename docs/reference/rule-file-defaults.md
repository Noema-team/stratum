# Rule File Defaults

**Type:** reference · **Status:** draft · **Updated:** 2026-04-17

Per-file default values for all 7 rule files (DDR-002). Annotated YAML for each
file with per-project-type variants where they differ.

---

## Merge order

```
global defaults (shipped with @sle/sdk)
  ↓ deep merge
.sle/rules/{file}.yaml  (project rules — written at init)
  ↓ deep merge
.sle/overrides/{file}.yaml  (optional, user-created)
  ↓
RuntimeConfig
```

---

## planning.yaml

```yaml
depth: standard                  # enum: minimal | standard | deep | research
max_iterations: 5                # integer
artifact_slice_size: 2000        # integer (tokens)
summary_max_tokens: 400          # integer (tokens)
system_prompt_max_tokens: 500    # integer (tokens)
reasoning_passes:                # map<PlanningDepth, integer>
  minimal: 1
  standard: 2
  deep: 3
  research: 4
critic_enabled: null             # boolean | null (null = infer from depth)
on_depth_change: re_plan         # enum: re_plan | continue
```

### Per-project-type overrides

| Field | `api` | `ui` | `library` | `research` | `custom` |
|---|---|---|---|---|---|
| `depth` | standard | standard | standard | research | minimal |
| `max_iterations` | 5 | 5 | 5 | 10 | 5 |
| `artifact_slice_size` | 2000 | 2000 | 2000 | 4000 | 2000 |
| `critic_enabled` | null | null | null | true | null |

> **DDR-023:** `depth` does NOT auto-trigger EXPLORE. EXPLORE is user-initiated only. Automatic gap detection is a separate mechanism — see `specs/validation.md`.

---

## validation.yaml

### Static analysis and container (all project types)

```yaml
static_analysis:
  lint:
    command: "npx eslint src/ --format json"    # string
    enabled: true                                # boolean
    pass_criteria:
      max_errors: 0                              # integer
      max_warnings: 50                           # integer
  typecheck:
    command: "npx tsc --noEmit"                  # string
    enabled: true
    pass_criteria:
      max_errors: 0
  complexity:
    command: "npx complexity-report --format json --threshold 15 src/"  # string
    enabled: true
    pass_criteria:
      max_complexity: 15                         # integer

container:
  base_image: "node:20-slim"                     # string
  install_command: "npm install"                 # string
  timeout_ms: 120000                             # integer
```

### Shared category — `correctness` (all project types)

Every project type includes this category as the first entry in `categories[]`:

```yaml
- name: correctness                             # string
  method: both                                  # enum: llm | executable | both
  executable:
    runner: scripts/test_correctness.ts         # path
    timeout_ms: 30000                           # integer
    output_format: json                         # enum: json
  llm:
    artifact_slice: [requirements, src]         # string[]
    prompt_template: .sle/prompts/correctness_check.md  # path
    pass_threshold: 0.85                        # float 0–1
  pass_criteria:
    executable: all_pass                        # all_pass | any_pass | threshold:{n} | map
    llm: verdict_pass                           # verdict_pass | confidence:{n}
  on_fail:
    feed_to: planner                            # planner | evaluator
    include: [failed_tests, llm_issues]         # string[]
```

### Per-project-type — additional categories

The sections below show only the categories beyond `correctness` for each project type.

**`api`** — correctness, performance, security

```yaml
- name: performance
  method: both
  executable:
    runner: scripts/bench.ts
    timeout_ms: 60000
    output_format: json
  llm:
    artifact_slice: [requirements, architecture]
    prompt_template: .sle/prompts/performance_check.md
    pass_threshold: 0.80
  pass_criteria:
    executable:
      p95_ms: 200                               # integer (metric threshold)
      error_rate: 0.001                          # float (metric threshold)
    llm: verdict_pass
  on_fail:
    feed_to: planner
    include: [metrics, llm_issues]

- name: security
  method: llm
  llm:
    artifact_slice: [requirements, architecture, src]
    prompt_template: .sle/prompts/security_check.md
    pass_threshold: 0.90
  pass_criteria:
    llm: verdict_pass
  on_fail:
    feed_to: planner
    include: [llm_issues]
```

**`ui`** — correctness, usability, performance

```yaml
- name: usability
  method: both
  executable:
    runner: scripts/test_usability.ts
    timeout_ms: 30000
    output_format: json
  llm:
    artifact_slice: [requirements, src]
    prompt_template: .sle/prompts/usability_check.md
    pass_threshold: 0.80
  pass_criteria:
    executable: all_pass
    llm: verdict_pass
  on_fail:
    feed_to: planner
    include: [failed_tests, llm_issues]

- name: performance
  method: both
  executable:
    runner: scripts/bench.ts
    timeout_ms: 60000
    output_format: json
  llm:
    artifact_slice: [requirements, architecture]
    prompt_template: .sle/prompts/performance_check.md
    pass_threshold: 0.80
  pass_criteria:
    executable:
      p95_ms: 200
      error_rate: 0.001
    llm: verdict_pass
  on_fail:
    feed_to: planner
    include: [metrics, llm_issues]
```

**`library`** — correctness, compatibility, maintainability

```yaml
- name: compatibility
  method: llm
  llm:
    artifact_slice: [requirements, architecture]
    prompt_template: .sle/prompts/compatibility_check.md
    pass_threshold: 0.85
  pass_criteria:
    llm: verdict_pass
  on_fail:
    feed_to: planner
    include: [llm_issues]

- name: maintainability
  method: llm
  llm:
    artifact_slice: [requirements, architecture, src]
    prompt_template: .sle/prompts/maintainability_check.md
    pass_threshold: 0.75
  pass_criteria:
    llm: verdict_pass
  on_fail:
    feed_to: planner
    include: [llm_issues]
```

**`research`** — correctness, reproducibility

```yaml
- name: reproducibility
  method: executable
  executable:
    runner: scripts/test_reproducibility.ts
    timeout_ms: 120000
    output_format: json
  pass_criteria:
    executable: all_pass
  on_fail:
    feed_to: planner
    include: [failed_tests]
```

**`custom`** — correctness only (no additional categories).

---

## artifacts.yaml

Identical across all project types. Variance comes from `validation.yaml` controlling which categories run.

```yaml
artifacts:
  - id: requirements              # string
    path: docs/requirements.md    # string (relative path)
    generator: planner            # planner | builder | historian | evaluator | critic | facilitator | discovery
    required: true                # boolean
    append_only: false            # boolean
    format: markdown              # markdown | json | yaml

  - id: architecture
    path: docs/architecture.md
    generator: planner
    required: true
    append_only: false
    format: markdown

  - id: test_plan
    path: docs/test-plan.md
    generator: planner
    required: true
    append_only: false
    format: markdown

  - id: decisions
    path: docs/decisions.md
    generator: historian
    required: true
    append_only: true
    format: markdown

  - id: evaluation
    path: docs/evaluation.md
    generator: evaluator
    required: true
    append_only: false
    format: markdown

  - id: build-plan
    path: docs/build-plan.md
    generator: planner
    required: false
    append_only: false
    format: markdown

generated_outputs:
  - id: test_runner               # string
    path: scripts/run-tests.ts    # string (relative path)
    type: executable              # executable | html | markdown
    generated_at: gate_pass       # gate_pass | cycle_end | always

  - id: validation_report
    path: reports/validation-latest.html
    type: html
    generated_at: gate_pass

  - id: changelog
    path: reports/changelog-{{version_id}}.md
    type: markdown
    generated_at: gate_pass
```

---

## exit.yaml

Identical across all project types.

```yaml
conditions:
  all_categories_pass: true      # boolean
  requirements_met: true         # boolean

on_cap_hit: halt_with_report    # halt_with_report | user_prompt | force_pass

halt_behavior:
  write_partial_report: true     # boolean
  notify_user: true              # boolean
  block_version_snapshot: true   # boolean
  preserve_decisions: true       # boolean

on_error:
  behavior: halt                 # halt | retry_once | notify_and_wait
  write_error_report: true       # boolean
  block_version_snapshot: true   # boolean
```

---

## user_validation.yaml

Identical across all project types.

```yaml
approval_required: true          # boolean

review_at:                       # (after_planning | after_gate_pass)[]
  - after_planning
  - after_gate_pass

prompts:
  after_planning: |              # string (template with {{categories}})
    The Planner has recommended the following validation categories:
    {{categories}}

    You can accept, remove categories, or add new ones.
    Respond with your confirmed list or type "accept" to use as-is.

  after_gate_pass: |             # string (template with {{cycle}}, {{summary}}, {{version_id}})
    Cycle {{cycle}} has completed. All validation categories passed.

    {{summary}}

    Type "approve" to lock version {{version_id}}, or describe changes
    you want before the snapshot is locked.

timeout_minutes: 60              # integer
on_timeout: auto_approve         # auto_approve | halt | notify_and_wait
auto_approve_on_rerun: false     # boolean
```

---

## summary.yaml

Identical across all project types.

```yaml
format: markdown                 # markdown | html | json

sections:                        # string[] (ordered)
  - what_was_built
  - what_changed
  - category_results
  - how_to_test
  - next_steps

test_command_format: shell       # shell | npm_script | makefile
show_confidence_scores: true     # boolean
show_failed_test_ids: true       # boolean
what_was_built_max_tokens: 300   # integer
next_steps_max_count: 3          # integer
output_path: reports/summary-{{version_id}}.md  # string (template path)
```

---

## agents.yaml

Identical across all project types (DDR-002). Users customize by editing `llm.provider`, `llm.base_url`, `llm.model`, and `llm.api_key_env` after init.

```yaml
agents:
  - role: planner                # planner | builder | historian | evaluator | critic | facilitator
    system_prompt: |
      You are the Planner agent. Your job is to reason about the user's intent,
      analyze the current codebase state, and produce a structured plan that the
      Builder can execute. You also select validation categories and generate
      test script stubs.

      Output a JSON object with keys: plan, files_to_create, files_to_modify,
      categories, test_scripts.
    llm:
      provider: openai_compatible  # openai_compatible | anthropic
      base_url: https://api.openai.com/v1  # string
      model: gpt-4o                # string
      api_key_env: OPENAI_API_KEY  # string (env var name)

  - role: builder
    system_prompt: |
      You are the Builder agent. You receive a plan from the Planner and produce
      the actual file contents. For each file, output the full content — do not
      use placeholders or partial implementations.

      Output a JSON object with keys: files (path→content map), test_scripts
      (category→script content map).
    llm:
      provider: openai_compatible
      base_url: https://api.openai.com/v1
      model: gpt-4o
      api_key_env: OPENAI_API_KEY

  - role: historian
    system_prompt: |
      You are the Historian agent. You maintain the decisions.md file by appending
      entries that describe what was decided, why, and what alternatives were
      considered. You also update the repo key_files in map.yaml.

      Output a JSON object with keys: decisions_entry, key_files_updates.
    llm:
      provider: openai_compatible
      base_url: https://api.openai.com/v1
      model: gpt-4o
      api_key_env: OPENAI_API_KEY

  - role: evaluator
    system_prompt: |
      You are the Evaluator agent. After the gate passes, you write evaluation.md
      summarizing what worked, what didn't, and what should change next cycle.

      Output a JSON object with keys: summary, recommendations.
    llm:
      provider: openai_compatible
      base_url: https://api.openai.com/v1
      model: gpt-4o
      api_key_env: OPENAI_API_KEY

  - role: critic
    system_prompt: |
      You are the Critic agent. You review the Planner's output before it reaches
      the Builder. You look for gaps, inconsistencies, and risks. You do not
      produce code — you produce a critique.

      Output a JSON object with keys: approved (boolean), issues (string[]),
      suggestions (string[]).
    llm:
      provider: openai_compatible
      base_url: https://api.openai.com/v1
      model: gpt-4o
      api_key_env: OPENAI_API_KEY

  - role: facilitator
    system_prompt: |
      You are the Facilitator agent for project discovery. You do NOT have access
      to the codebase. You ask questions, listen to answers, and structure the
      user's responses into coherent discovery documents.

      Rules:
      - Ask one focused question (or a tight cluster of 2-3 related questions) per turn
      - Do not ask long lists of questions at once
      - Read all previously approved artifacts before each round
      - Never assume — if something is unclear, ask
      - Produce complete drafts only when you have enough information
    llm:
      provider: openai_compatible
      base_url: https://api.openai.com/v1
      model: gpt-4o
      api_key_env: OPENAI_API_KEY
```

### Supported LLM providers

| Provider | `provider` value | `base_url` |
|---|---|---|
| OpenAI | `openai_compatible` | `https://api.openai.com/v1` |
| OpenRouter | `openai_compatible` | `https://openrouter.ai/api/v1` |
| GLM (ZhipuAI) | `openai_compatible` | `https://open.bigmodel.cn/api/paas/v4` |
| Zai Coding Plan | `openai_compatible` | Zai endpoint |
| Claude (Anthropic) | `anthropic` | N/A (native SDK) |

---

## LLM write boundary

The LLM may only append new categories to `validation.yaml → categories[]` at planning time. No other modifications to any rule file are permitted at runtime. Enforced by the daemon's gated write API.
