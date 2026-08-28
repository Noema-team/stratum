# Configuring Validation

**Type:** guide · **Updated:** 2026-05-02
**Source:** SLE-004 (validation framework), specs/validation, specs/validation-prompts

---

## How validation works

Validation determines whether a workflow run's implementation meets its requirements. It runs after BUILD and produces a deterministic pass/fail verdict that drives whether the run completes or iterates.

### Three sub-phases

Every validation run executes three sub-phases in order:

1. **`static-check`** — Linting, type checking, complexity analysis. Runs once globally. If it fails, the remaining sub-phases are skipped.

2. **`llm-check`** — Semantic correctness via LLM reasoning. The LLM evaluates whether the implementation satisfies requirements as intended, not just as written. Runs per category in parallel.

3. **`exec-check`** — Functional correctness via executable test scripts inside a fresh Docker container. No LLM involvement. Runs per category in parallel alongside `llm-check`.

`static-check` is a global gate — it must pass before the category-level sub-phases fan out.

### Where validation runs in full-build's step graph

Validation occupies two steps in the `full-build` workflow:

- **EXEC** (execute) — runs all three sub-phases inside a Docker container
- **VALIDATION_GATE** (review) — evaluates results deterministically with no LLM

On pass → EVALUATE → SUMMARISE → SNAPSHOT. On fail (`on_fail`) → the Debug step → iteration loop back to PLAN. See [workflow-execution.md](../specs/workflow-execution.md) and [step-kind-reference.md](../specs/step-kind-reference.md) for the full step flow.

### Validation categories

The system ships with ten built-in categories:

| Category | Primary concern | Default method |
|---|---|---|
| `correctness` | Logic, outputs, contracts, edge cases | `both` |
| `performance` | Speed, memory, throughput, p95 latency | `both` |
| `security` | Auth, injection, secrets, surface area | `both` |
| `usability` | UX, error messages, discoverability | `both` |
| `reliability` | Retries, degradation, error handling | `both` |
| `maintainability` | Complexity, coverage, documentation | `llm` |
| `observability` | Logs, metrics, traces, alerting | `both` |
| `scalability` | Load, concurrency, elasticity | `both` |
| `compatibility` | APIs, platforms, versions, contracts | `both` |
| `compliance` | GDPR, licensing, regulations | `llm` |

The Planner may emit additional categories at planning time (e.g., `accessibility`, `data_integrity`). These follow the same interface as built-in categories.

### Pass/fail criteria

The gate operates in `all_must_pass` mode — every active category must pass for the gate to pass. There is no partial pass or weighted scoring.

For each category, pass criteria depend on the `method`:

- **`llm`** — `verdict == 'pass' AND confidence >= pass_threshold`
- **`executable`** — `failed_cases.length == 0 AND errors.length == 0`
- **`both`** — both the LLM and executable criteria must be met

---

## The validation.yaml file

### Location

```
.sle/rules/validation.yaml
```

Created during `sle init`. The daemon reads it at startup and at the start of each workflow run.

### Structure

```yaml
categories:
  - name: correctness
    method: both
    ...
  - name: performance
    method: both
    ...

static_analysis:
  max_errors: 0
  complexity_threshold: 15
  lint_command: ...
  typecheck_command: ...

run_artifacts:
  retention:
    keep_last_n_runs: 10
    keep_failed_runs: true
    keep_passed_runs: false
  ...

gate:
  mode: all_must_pass
```

### Default configuration

Defaults by project type (set during `sle init`):

| Project type | Active categories |
|---|---|
| `api` | correctness · performance · security |
| `ui` | correctness · usability · performance |
| `library` | correctness · compatibility · maintainability |
| `research` | correctness |
| `custom` | correctness only |

Edit `validation.yaml` when you need to add, remove, or tune categories beyond these defaults.

---

## Customizing validation categories

### Adding a new category

Add a new entry to the `categories` list in `validation.yaml`:

```yaml
categories:
  - name: accessibility
    method: llm
    llm:
      artifact_slice:
        - requirements.md
        - "src/**/*"
      prompt_template: accessibility_check
      pass_threshold: 0.85
    pass_criteria:
      llm: verdict_pass
    on_fail:
      feed_to: planner
      include:
        - issues
        - evidence
```

For categories using `llm` or `both`, create a prompt template at `.sle/prompts/{category}_check.md` (see [LLM validation prompts](#llm-validation-prompts)). For categories using `executable` or `both`, the Tester agent generates scripts at `scripts/test_{category}.ts` during the TEST step.

### Enabling and disabling built-in categories

Remove a category from the `categories` list to disable it. Add it back to re-enable it. Prompt templates and category definitions remain available even when disabled — they are simply not executed.

For example, to enable only `correctness` and `performance`:

```yaml
categories:
  - name: correctness
    method: both
    pass_criteria:
      executable: all_pass
      llm: verdict_pass
    on_fail:
      feed_to: planner
      include:
        - issues
  - name: performance
    method: both
    pass_criteria:
      executable: all_pass
      llm: verdict_pass
    on_fail:
      feed_to: planner
      include:
        - issues
        - metrics
```

### Setting severity thresholds

Each category's LLM confidence threshold is set via `pass_threshold` in the category definition. A `pass` verdict with `confidence < pass_threshold` is treated as a failure. Raise the threshold for categories where you want higher certainty; lower it where you want more leniency.

Default thresholds by category (from specs/validation-prompts.md §Template inventory):

| Category | Default `pass_threshold` |
|---|---|
| correctness | 0.85 |
| performance | 0.80 |
| security | 0.90 |
| usability | 0.80 |
| reliability | 0.85 |
| maintainability | 0.75 |
| compliance | 0.90 |
| observability | 0.80 |
| scalability | 0.80 |
| compatibility | 0.85 |

### YAML override examples

Switch performance to executable-only with a relaxed p95 threshold:

```yaml
  - name: performance
    method: executable
    executable:
      runner: scripts/test_performance.ts
      timeout_ms: 30000
      output_format: json
    pass_criteria:
      executable: "threshold:p95_ms:500"
    on_fail:
      feed_to: planner
      include:
        - metrics
```

Run security as LLM-only for a library with no HTTP surface, routing failures to the Evaluator:

```yaml
  - name: security
    method: llm
    llm:
      artifact_slice:
        - requirements.md
        - "src/**/*"
      prompt_template: security_check
      pass_threshold: 0.90
    pass_criteria:
      llm: verdict_pass
    on_fail:
      feed_to: evaluator
      include:
        - issues
        - evidence
```

---

## LLM validation prompts

### How prompt templates are selected

The `llm-check` sub-phase resolves templates in this order:

1. `.sle/prompts/{category}_check.md` — project-local override
2. System default template shipped with the daemon

If the category requires `llm-check` but no template is found:
- `method: 'both'` → downgraded to `method: 'executable'` with a warning
- `method: 'llm'` → category is skipped with a warning

### The meta-template for generating new category prompts

When the Planner emits a new category not covered by built-in templates, a prompt template is generated following the six-part meta-template process defined in [validation-prompts.md](../specs/validation-prompts.md) §Meta-template:

1. **Role statement** — one sentence identifying the reviewer role
2. **Artifact list** — which artifacts the category needs
3. **Checklist** — at least three subsections with 3-5 specific checks each
4. **Reasoning guidance** — strategy paragraph
5. **Severity guide** — what constitutes low/medium/high/critical
6. **Output format** — the standard `LLMCheckOutput` JSON schema

Generated templates must pass the same structural validation as built-in templates before being persisted.

### Customizing prompt templates

Edit `.sle/prompts/{category}_check.md` to change how the LLM evaluates a category. Templates are markdown — no daemon code changes required.

Every template must contain exactly six sections in order:

```markdown
# {category} validation

## Your role

...

## What you have been given

...

## What to check

### Subsection 1
- check item
- check item

### Subsection 2
- check item
- check item

### Subsection 3
- check item
- check item

## How to reason

...

## Output format

...
```

Validation rules enforced at daemon start:

- Output format must contain both `pass` and `fail` verdict options
- At least three `###` subsections under `## What to check`
- Template must be under 2,000 tokens
- Template must reference at least one artifact by name

An invalid template prevents the daemon from starting. Fix or remove the file to resolve.

If the system default is updated after you created a project-local override, the daemon logs a staleness warning. It does not overwrite your override — you must update it manually.

### Template inventory

The full list of built-in and stub templates is in [validation-prompts.md](../specs/validation-prompts.md) §Template inventory. Core templates (correctness, performance, security) ship with full checklist content. Stub templates are functional but minimal — expand them by adding more detailed checklist items.

Manage templates at runtime via the API:

```bash
curl -s http://localhost:7700/api/v2/validation/templates | jq .

curl -s http://localhost:7700/api/v2/validation/templates/correctness | jq .content

curl -X PUT http://localhost:7700/api/v2/validation/templates/accessibility \
  -H "Content-Type: text/markdown" \
  --data-binary @.sle/prompts/accessibility_check.md

curl -X DELETE http://localhost:7700/api/v2/validation/templates/accessibility
```

---

## Static checks

### What static-check covers

`static-check` runs first, once per iteration, globally — not per-category. Three deterministic checks:

| Check | Tool (configurable) | What it catches |
|---|---|---|
| `lint` | ESLint, Ruff, etc. | Syntax errors, style violations, unused imports |
| `typecheck` | tsc, mypy, etc. | Type errors, mismatched signatures |
| `complexity` | Cyclomatic analysis | Files exceeding complexity threshold |

All three must pass. Pass condition:

```
lint.errors <= max_errors
AND typecheck.errors <= max_errors
AND complexity.files_over_threshold.length == 0
```

If any check fails, the gate fails immediately and remaining sub-phases are skipped.

### Configuring static check rules

Edit `validation.yaml → static_analysis`:

```yaml
static_analysis:
  max_errors: 0
  complexity_threshold: 15
  lint_command: "npx eslint src/ --format json"
  typecheck_command: "npx tsc --noEmit --pretty false"
```

Commands are determined at `sle init` based on project type. Set `max_errors: 0` for strict enforcement, or increase it to tolerate warnings during incremental migration. `complexity_threshold` sets the maximum cyclomatic complexity per file.

---

## Execution checks

### What exec-check covers

`exec-check` runs test scripts inside the Docker container with no LLM. It catches functional failures, performance regressions, and runtime errors.

Each test script outputs structured JSON to stdout:

```json
{
  "passed_cases": ["req-001-happy-path"],
  "failed_cases": ["req-003-edge-case"],
  "errors": [],
  "metrics": { "p95_ms": 180, "throughput_rps": 1200 }
}
```

### Test runner configuration

Each category with `method: executable` or `both` specifies its runner:

```yaml
categories:
  - name: correctness
    method: both
    executable:
      runner: scripts/test_correctness.ts
      timeout_ms: 60000
      output_format: json
    llm:
      artifact_slice:
        - requirements.md
        - "src/**/*"
      prompt_template: correctness_check
      pass_threshold: 0.85
    pass_criteria:
      executable: all_pass
      llm: verdict_pass
    on_fail:
      feed_to: planner
      include:
        - issues
```

The `runner` path is relative to the project root. The Tester generates these scripts during the TEST step. `timeout_ms` bounds execution time — scripts that exceed it are treated as failed.

### Coverage thresholds

Use threshold-based pass criteria instead of requiring all cases to pass:

```yaml
pass_criteria:
  executable: "threshold:p95_ms:200"
```

Multiple thresholds as a map:

```yaml
pass_criteria:
  executable:
    p95_ms: 200
    error_rate: 0.01
```

---

## Validation results

### Reading the validation report

After each run, artifacts are written to `.sle/runs/{run_id}/`:

```
.sle/runs/{run_id}/
  manifest.json
  ai/context-pack.md
  tests/summary.json
  tests/{category}/result.json
  static-analysis/results.json
```

The `manifest.json` is the entry point — it records the run outcome, failed/passed categories, and artifact locations. The `context-pack.md` provides a deterministic narrative summary (code-generated, not LLM-produced) for the Debugger and Planner.

### FailureReport structure

When the gate fails, it produces a `FailureReport`:

```typescript
interface FailureReport {
  iteration: number
  run_dir: string
  run_id: string
  quick_summary: string
  failed_categories: string[]
  passed_categories: string[]
}
```

The report is a lightweight pointer — it carries `run_dir` rather than inline details. The Debugger and Planner read artifacts directly from `.sle/runs/{run_id}/` via the context manager.

### What happens on validation failure

When the gate fails:

1. `map.yaml` is updated — failed categories get `status: failed`, passed get `status: passed`
2. A `FailureReport` is constructed and injected into the Planner's context
3. The workflow run proceeds to the Debug step → `iteration++` → PLAN

If `iteration < max_iterations`, the Planner retries. Passing categories are **not re-run** — their results are cached, keeping iteration cost proportional to what failed.

If `iteration >= max_iterations`, the workflow run halts per `exit.yaml → on_cap_hit`:

| Behavior | Effect |
|---|---|
| `halt_with_report` | Write partial report, halt, no commit |
| `user_prompt` | Pause and ask whether to continue or halt |
| `force_pass` | Commit despite failures (not recommended) |

Cache is invalidated on plan revision (CONFIRM modify) or structural failure escalation (Debug step → DESIGN), but survives normal iteration increments.

### Re-running validation after fixes

Trigger a re-run of specific categories during an active workflow run:

```bash
curl -X POST http://localhost:7700/api/v2/workflow-runs/{run_id}/validation/rerun \
  -H "Content-Type: application/json" \
  -d '{"categories": ["performance"]}'
```

Passing categories from the previous run are preserved (category caching applies). Returns 409 if the workflow run is not active.

Monitor progress via WebSocket events (`run.phase_completed`, `run.category_completed`, `run.manifest_ready`, `gate.result`).

Inspect validation state:

```bash
curl -s http://localhost:7700/api/v2/workflow-runs/{run_id}/validation | jq .

curl -s http://localhost:7700/api/v2/workflow-runs/{run_id}/runs/{run_id} | jq .
```
