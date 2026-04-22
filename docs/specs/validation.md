# Validation

**Type:** spec · **Status:** draft · **Updated:** 2026-04-17
**Depends on:** DDR-022, DDR-023
**Source material:** SLE-003 (renamed phases), SLE-022

## Overview

The validation system determines whether a cycle's implementation meets its
requirements. It runs three sequential sub-phases inside the EXEC node, then
a deterministic VALIDATION gate evaluates the combined results.

Validation is agent-separated, hybrid-TDD, tri-phase, and container-isolated:

1. **Agent-separated.** The Tester designs tests from requirements only. The
   Builder writes code to satisfy those tests. Neither sees the other's output
   during generation.

2. **Hybrid TDD.** Tests are generated before the BUILD phase (from
   requirements), not during or after. The Builder receives the test suite as
   a contract it must satisfy.

3. **Tri-phase.** Three sub-phases run sequentially: `static-check`,
   `llm-check`, and `exec-check`. Static runs first globally; if it fails, the
   remaining sub-phases are skipped.

4. **Container-isolated.** All sub-phases run inside a fresh Docker container
   per iteration. The container is destroyed after results are captured.

The gate is deterministic — a pure function of sub-phase results with no LLM
involvement, no user input, and no external services.

### Sub-phase naming (G10)

The original SLE-003 names "Phase 0 / Phase 1 / Phase 2" are replaced:

| Old name | New name | Purpose |
|---|---|---|
| Phase 0 | `static-check` | Lint, typecheck, complexity |
| Phase 1 | `llm-check` | Semantic correctness via LLM reasoning |
| Phase 2 | `exec-check` | Functional correctness via executable tests |

### Relationship to DAG

Validation occurs at two DAG nodes:

1. **EXEC** — runs all three sub-phases inside the Docker container
2. **VALIDATION_GATE** — evaluates results deterministically, no LLM

On gate pass → EVALUATE → SUMMARISE → SNAPSHOT. On fail → DEBUG → iteration
loop back to PLAN. See [dag-execution.md](dag-execution.md) for the full flow.

---

## Data model

### Sub-phase identifiers

```
type SubPhase = 'static-check' | 'llm-check' | 'exec-check'
```

Execution order is fixed: `static-check` → `llm-check` → `exec-check`.
`static-check` runs once for the entire iteration (not per category). If it
fails, `llm-check` and `exec-check` are skipped entirely.

### Validation method

```
type ValidationMethod = 'llm' | 'executable' | 'both'
```

| Method | `static-check` | `llm-check` | `exec-check` |
|---|---|---|---|
| `llm` | Yes (global) | Yes | No |
| `executable` | Yes (global) | No | Yes |
| `both` | Yes (global) | Yes | Yes |

### Category status

```
type CategoryStatus = 'passed' | 'failed' | 'pending' | 'skipped'
```

Tracked in `map.yaml → validation.categories[].status`. Starts at `pending`,
transitions to `passed`, `failed`, or `skipped` after the gate evaluates.

### Static analysis result

```typescript
interface StaticAnalysisResult {
  lint: {
    errors: number
    warnings: number
    output: string
  }
  typecheck: {
    errors: number
    output: string
  }
  complexity: {
    files_over_threshold: Array<{
      file: string
      complexity: number
      threshold: number
    }>
    max: number
  }
  passed: boolean
}
```

`passed` is computed from thresholds in `validation.yaml → static_analysis`:

```
static.passed =
  lint.errors <= max_errors
  AND typecheck.errors <= max_errors
  AND complexity.files_over_threshold.length == 0
```

### LLM check result

```typescript
interface LLMCheckResult {
  verdict: 'pass' | 'fail'
  issues: string[]
  confidence: number
  evidence: string[]
}
```

Produced per category by the `llm-check` sub-phase. The gate uses the
`pass_threshold` from `validation.yaml` to determine if a `pass` verdict with
low confidence still fails (default threshold: 0.85).

### Executable check result

```typescript
interface ExecCheckResult {
  passed_cases: string[]
  failed_cases: string[]
  errors: string[]
  metrics: Record<string, number>
}
```

Produced per category by the `exec-check` sub-phase. `errors` are runtime
errors (separate from assertion failures in `failed_cases`). `metrics` is an
open map of category-specific values.

### Category result

```typescript
interface CategoryResult {
  name: string
  method: ValidationMethod
  llm?: LLMCheckResult
  executable?: ExecCheckResult
  passed: boolean
}
```

Aggregated per-category result. `passed` is computed by the gate. `llm` is
present for `method: 'both'` or `'llm'`; `executable` for `'both'` or
`'executable'`.

### Gate result

```typescript
interface GateResult {
  passed: boolean
  static_analysis: StaticAnalysisResult
  category_results: CategoryResult[]
  failed_categories: string[]
  failure_report?: FailureReport
}
```

The gate's final output. `passed` is `true` only if static analysis passed and
every active category passed.

### FailureReport (authoritative — G24)

The `FailureReport` from SLE-022 supersedes the SLE-003 version. It carries a
run directory reference instead of inline failure details, enabling richer
context for the Debugger and Planner.

```typescript
interface FailureReport {
  cycle: number
  iteration: number
  run_dir: string
  run_id: string
  quick_summary: string
  failed_categories: string[]
  passed_categories: string[]
}
```

`run_dir` points to `.sle/runs/{run_id}/`. The context manager reads the
manifest and context-pack from this directory directly. The report itself is a
lightweight pointer with an orientation summary.

This replaces the SLE-003 inline version which carried `static_analysis` and
`failed_categories` detail inline.

### Run manifest

```typescript
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
```

Produced by the gate node after evaluating results. The context manager reads
this first to locate all other artifacts.

### Category run result

```typescript
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

Written by test scripts to `$RUN_DIR/tests/{category}/result.json`.

### Validation configuration

```typescript
interface ValidationRuleCategory {
  name: string
  method: ValidationMethod
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

Declared in `validation.yaml`. The `pass_threshold` is the minimum confidence
for the `llm-check` sub-phase (default 0.85).

### Run artifact schema

```typescript
interface RunArtifactSchema {
  always: Array<{
    path: string
    generated_by: 'gate' | 'static_analysis_phase'
  }>
  categories: Record<string, Array<{
    path: string
    format: 'json' | 'jsonl' | 'junit' | 'text'
    required: boolean
    description?: string
  }>>
  services: {
    enabled: boolean
    path_template: string
    tail_lines: number
  }
  retention: {
    keep_last_n_runs: number
    keep_failed_runs: boolean
    keep_passed_runs: boolean
  }
}
```

Declared in `validation.yaml → run_artifacts`. Different project types declare
different schemas — an API emits traces and percentiles; a library emits only
test results and lint output.

### map.yaml tracked state

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

Tracked in `map.yaml → validation` and `map.yaml → last_run`. The context
manager reads `last_run.run_dir` to locate the most recent run artifacts.

---

## Behavior

### Sub-phase execution order

```
static-check (once, global)
  ├── lint, typecheck, complexity
  ├── result → $RUN_DIR/static-analysis/results.json
  └── fail → skip remaining sub-phases, gate receives static failure only

if static-check passed:
  Category fan-out (all active categories in parallel)
    for each active category C:
      if C.method == 'both' or 'llm':
        llm-check for C
          Input: artifact slice + prompt template
          Output: { verdict, issues, confidence, evidence }
          → $RUN_DIR/tests/C/result.json

      if C.method == 'both' or 'executable':
        exec-check for C
          Input: test script + $RUN_DIR env var
          Output: { passed[], failed[], errors[], metrics }
          → $RUN_DIR/tests/C/result.json

    llm-check and exec-check run in parallel per category

EXEC node complete → VALIDATION_GATE evaluates
```

### static-check — deterministic mechanical verification

Runs inside the Docker container. Three checks, all deterministic:

| Check | Tool (configurable) | Output |
|---|---|---|
| `lint` | ESLint / Ruff / etc. | `{ errors, warnings, output }` |
| `typecheck` | tsc / mypy / etc. | `{ errors, output }` |
| `complexity` | cyclomatic analysis | `{ files_over_threshold, max }` |

All three must pass. If any fails, the validation run short-circuits.
Configuration in `validation.yaml → static_analysis`. Commands determined at
`sle init` based on project type.

### llm-check — semantic correctness verification

The LLM receives an artifact slice relevant to the category and reasons about
whether the implementation satisfies requirements as intended, not just as
written.

Input per category: artifact slice from `validation.yaml` + prompt template
from `.sle/prompts/{category}_check.md`.

Output (structured JSON):

```json
{
  "verdict": "pass | fail",
  "issues": ["issue 1", "issue 2"],
  "confidence": 0.92,
  "evidence": ["artifact passage informing verdict"]
}
```

Pass criteria: `verdict == 'pass' AND confidence >= pass_threshold`.

What it catches:
- Implementation that passes tests but misunderstands requirements
- Architectural decisions locally correct but globally incoherent
- Missing edge cases executable tests do not cover
- Security surface issues missed by automated scanners

### exec-check — functional correctness verification

The Builder's instrumented test scripts run in isolation inside the Docker
container with no LLM involvement.

Input per category: test script path, timeout, `$RUN_DIR` environment variable.

Output (structured JSON to stdout):

```json
{
  "passed_cases": ["req-001-happy-path"],
  "failed_cases": ["req-003-edge-case"],
  "errors": [],
  "metrics": { "p95_ms": 180, "throughput_rps": 1200 }
}
```

Pass criteria: `failed_cases.length == 0 AND errors.length == 0`. For
threshold-based categories (e.g., performance), metrics are evaluated against
`pass_criteria.executable` thresholds.

What it catches:
- Functional failures (wrong return values, broken APIs)
- Performance regressions (p95 exceeds threshold)
- Runtime errors the LLM phase could not detect

### Why all three are required

| Scenario | static-check | llm-check | exec-check |
|---|---|---|---|
| Type error in generated code | Yes | No | No |
| Unused import / dead code | Yes | No | No |
| Cyclomatic complexity over threshold | Yes | No | No |
| Implementation correct but misses intent | No | Yes | No |
| Tests pass but architecture is wrong | No | Yes | No |
| Requirement met literally, not in spirit | No | Yes | No |
| Security surface missed by scanner | No | Yes | No |
| Assertion failure in unit test | No | No | Yes |
| p95 latency regression | No | No | Yes |
| Runtime crash on null input | No | No | Yes |

### Run directory structure

```
.sle/runs/
  {run_id}/                          ← c{cycle}-i{iteration}-{ISO8601}
    manifest.json                    ← always present
    ai/
      context-pack.md                ← always present
    tests/
      summary.json                   ← always present
      {category}/
        result.json                  ← per-category result
        junit.xml                    ← if category uses junit runner
    static-analysis/
      results.json                   ← lint + typecheck + complexity
    logs/                            ← if map.yaml declares services
      {service}.log
    traces/                          ← if performance category active
      request-map.jsonl
      flamegraph.json
    metrics/                         ← if performance category active
      percentiles.json
      error-rates.json
```

### context-pack.md — deterministic AI narrative

Generated by the gate node from structured outputs. No LLM call. Assembled
section by section:

1. **Summary** — counts from `tests/summary.json`
2. **Failed categories** — full detail: test results, metrics, trace summary,
   log excerpt (errors/warnings only, last 20 lines)
3. **Passed categories** — single line each (no detail)
4. **Static analysis** — from `static-analysis/results.json`

Token budget: ~400 tokens for failed categories. The context manager reads
this when assembling failure context for the Planner on retry iterations.

### The VALIDATION gate

The gate is DAG node `VALIDATION_GATE`. Deterministic: pure function of
sub-phase results.

#### Pass condition

```
1. static-check:
   static_analysis.passed must be true
   If false → gate FAIL, skip category evaluation

2. Per-category (only if static passed):
   for every active category C:

     if C.method == 'both':
       C.llm.verdict == 'pass'
       AND C.llm.confidence >= C.pass_threshold
       AND C.executable.failed_cases.length == 0
       AND C.executable.errors.length == 0

     if C.method == 'llm':
       C.llm.verdict == 'pass'
       AND C.llm.confidence >= C.pass_threshold

     if C.method == 'executable':
       C.executable.failed_cases.length == 0
       AND C.executable.errors.length == 0

3. Gate decision:
   static passes AND every active category passes → PASS
   any check fails → FAIL
```

Mode is `all_must_pass`. No partial pass, no weighted scoring.

#### On PASS

Update `map.yaml`: `gate.last_outcome: passed`, all categories `status: passed`,
`last_run.outcome: passed`.

Generate: `manifest.json`, `context-pack.md`, `tests/summary.json`,
`reports/validation-latest.html`, `scripts/run-tests.ts` (user-runnable),
`reports/changelog-{version}.md`.

Destroy container → DAG → EVALUATE → SUMMARISE → SNAPSHOT.

#### On FAIL

Update `map.yaml`: `gate.last_outcome: failed`, failed categories
`status: failed`, passed categories `status: passed`, `last_run.outcome: failed`.

Generate: `manifest.json`, `context-pack.md`, `tests/summary.json`.

Construct `FailureReport`: `{ cycle, iteration, run_dir, run_id, quick_summary,
failed_categories, passed_categories }`.

Destroy container → DAG → DEBUG → `iteration++`. If
`iteration < max_iterations` → PLAN (FailureReport injected). If
`iteration >= max_iterations` → HALT (`exit.yaml.on_cap_hit`).

### Quick summary generation

Generated by code (not LLM): `{passed_count}/{total_count} categories passed.
{per-failed-category first issue}.`

Example: `2/3 categories passed. Performance: p95=340ms (threshold 200ms).
Security: API key logged in plaintext at auth.ts:23.`

### Category caching across iterations

Passing categories are never re-run on retry. This keeps iteration cost
proportional to what failed.

**Mechanism:**

1. Gate writes each category's `CategoryResult` to the run directory
2. On next iteration, context manager loads passing categories' results
3. EXEC node only runs sub-phases for `failed` or `pending` categories
4. Gate merges cached results with new results before evaluating

**What is cached vs not:**

| Cached | Not cached |
|---|---|
| Passing category `CategoryResult` | Failed category results |
| `CategoryStatus: passed` in map.yaml | Static analysis (re-runs every iteration) |

**Invalidation:**

- Scoped to the current cycle
- Invalidated on plan revision (CONFIRM modify)
- Invalidated on structural failure escalation (DEBUG → DESIGN)
- Survives iteration increments (normal retry)

The context manager enforces this by only including failed categories' context
in the Planner's artifact slice. The Builder regenerates all code from scratch,
but only test scripts for failed categories are re-executed.

### Iteration cap

Configured in `planning.yaml → max_iterations`. When the cap is reached:

| `exit.yaml → on_cap_hit` | Effect |
|---|---|
| `halt_with_report` | Write partial report, halt, no snapshot |
| `user_prompt` | Pause, ask user: continue or halt? |
| `force_pass` | Lock snapshot despite failures (not recommended) |

---

## Validation categories

Categories are declared in `validation.yaml` and reflected in
`map.yaml → validation.categories`. The Planner may append new categories at
planning time — the user confirms before BUILD starts.

### Built-in categories

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

### Template defaults by project type

| Project type | Default active categories |
|---|---|
| `api` | correctness · performance · security |
| `ui` | correctness · usability · performance |
| `library` | correctness · compatibility · maintainability |
| `research` | correctness · reproducibility |
| `custom` | correctness only |

### LLM-defined categories

The Planner may emit additional categories beyond the built-ins at planning
time. These follow the same `ValidationRuleCategory` interface and are persisted
to `validation.yaml`. Examples: `accessibility`, `data_integrity`,
`reproducibility`, `localization`, `offline_support`.

### Per-category llm-check artifact slices

| Category | Artifacts | Focus |
|---|---|---|
| `correctness` | requirements.md, src/**/* | Intent match, edge cases, data contracts |
| `performance` | requirements.md, architecture.md | Bottlenecks, caching, async patterns |
| `security` | requirements.md, architecture.md, src/**/* | Auth boundaries, input validation, secrets |
| `usability` | requirements.md, src/**/* | Error messages, discoverability, defaults |
| `reliability` | requirements.md, architecture.md | Retries, graceful degradation, timeouts |
| `maintainability` | src/**/*, architecture.md | Complexity, module cohesion, coverage |

Prompt templates for each category live in `.sle/prompts/{category}_check.md`.
They are user-editable markdown files. Each outputs structured JSON:
`{ verdict, issues, confidence, evidence }`.

---

## Tester agent — TDD enforcement

The Tester is one of ten agent roles, separate from the Builder. It writes test
scripts from requirements only. Full role definition:
[../overview/agent-roles.md](../overview/agent-roles.md).

**Inputs:** `requirements.md`, `test-plan.md`, active category list.
**Outputs:** One script per category (`scripts/test_{category}.ts`),
requirement-to-test mapping, pass criteria.

**Hard constraints:** Never sees Builder implementation or Designer architecture.
Scripts are self-contained (no LLM/network calls). Each test tagged with
requirement ID. Does not run tests — EXEC node handles execution.

**Test script contract:** JSON to stdout, exit 0/1, tagged with `testId` and
`requirementId`, user-runnable after cycle. Builder receives scripts as a
contract — may instrument but may not modify pass criteria.

---

## API contract

### Get validation status

```
GET /api/v2/cycles/{cycle_id}/validation

Response 200:
{
  "run_id":               string | null,
  "iteration":            number,
  "static_analysis": {
    "status":             "passed" | "failed" | "pending" | "skipped",
    "lint_errors":        number | null,
    "typecheck_errors":   number | null,
    "complexity_violations": number | null
  },
  "categories": [
    {
      "name":             string,
      "method":           ValidationMethod,
      "status":           CategoryStatus,
      "last_run":         string | null,
      "cached_from_run":  string | null
    }
  ],
  "gate": {
    "last_outcome":       "passed" | "failed" | "halted" | null,
    "failed_categories":  string[]
  }
}

Response 404:
{ "error": "cycle_not_found" }
```

### Get run artifacts

```
GET /api/v2/cycles/{cycle_id}/runs/{run_id}

Response 200:
{
  "manifest":    RunManifest,
  "categories":  Record<string, CategoryRunResult>,
  "static":      StaticAnalysisResult
}

Response 404:
{ "error": "run_not_found" }
```

### Get run artifact file

```
GET /api/v2/cycles/{cycle_id}/runs/{run_id}/files/{path}

Response 200:
  Content-Type based on file extension
  Body: file contents

Response 404:
{ "error": "file_not_found" }
```

`path` is relative to the run directory. Only paths declared in
`manifest.artifacts` are served — arbitrary file access is blocked.

### Rerun categories

```
POST /api/v2/cycles/{cycle_id}/validation/rerun

Request:
{ "categories": string[] }

Response 200:
{ "run_id": string, "categories": string[], "status": "started" }

Response 409:
{ "error": "not_cycling", "reason": "Can only rerun validation during an active cycle." }

Response 422:
{ "error": "invalid_categories", "unknown": string[], "valid_categories": string[] }
```

Triggers a new EXEC run for the specified categories only. Passing categories
from the previous run are preserved (category caching applies).

### WebSocket events

| Event | Payload | When |
|---|---|---|
| `run.phase_completed` | `cycle_id, run_id, phase, passed, timestamp` | Each sub-phase finishes |
| `run.category_completed` | `cycle_id, run_id, category, passed, timestamp` | Each category finishes |
| `run.manifest_ready` | `cycle_id, run_id, manifest` | Manifest written |
| `run.context_pack_ready` | `cycle_id, run_id` | Context pack written |
| `dag.gate_result` | `cycle_id, passed, failed_categories, iteration, timestamp` | Gate evaluates |

Full event catalogue: [../reference/websocket-events.md](../reference/websocket-events.md).

---

## Error cases

### Sub-phase errors

| Error | Sub-phase | Condition | Response |
|---|---|---|---|
| `static_analysis_failure` | `static-check` | Threshold exceeded | Gate FAIL, skip remaining |
| `llm_verdict_fail` | `llm-check` | `verdict == 'fail'` | Category failed |
| `llm_low_confidence` | `llm-check` | `confidence < pass_threshold` | Category failed |
| `llm_provider_error` | `llm-check` | Provider 5xx or rate limit | Retry (3x backoff), then halt |
| `test_assertion_failure` | `exec-check` | Test case failed | Category failed |
| `test_runtime_error` | `exec-check` | Script crash or timeout | Category failed, error captured |
| `test_script_missing` | `exec-check` | Script not found in container | Halt cycle |
| `docker_unavailable` | `static-check` | Docker daemon not running | Halt cycle |
| `container_start_failed` | `static-check` | Container creation failed | Halt cycle |

### Gate errors

| Error | Condition | Response |
|---|---|---|
| `invalid_transition` | Gate evaluation outside EXEC completion | 409 |
| `missing_category_result` | Active category with no result | Halt cycle |
| `manifest_write_failed` | Cannot write manifest.json | Halt, preserve partial |
| `context_pack_generation_failed` | Cannot assemble context-pack | Proceed without it |

---

## Constraints

1. **Deterministic gate.** The VALIDATION gate is a pure function of category
   results. No LLM, no user input, no external services.

2. **Sequential sub-phases.** `static-check` runs first. If it fails,
   `llm-check` and `exec-check` are skipped.

3. **Parallel category fan-out.** Within `llm-check` and `exec-check`, all
   active categories run in parallel. Categories are independent.

4. **All categories must pass.** Mode is `all_must_pass`. No partial pass, no
   weighted scoring (except `force_pass` in `exit.yaml`).

5. **TDD separation.** The Tester never sees the Builder's implementation or
   the Designer's architecture. The context manager enforces this.

6. **Builder separation.** The Builder never sees the Tester's reasoning —
   only the final test scripts as a contract.

7. **Container isolation.** All sub-phases run in a fresh Docker container per
   iteration. Container destroyed after results captured.

8. **Category caching.** Passing categories are never re-run on retry. Cache
   invalidated on plan revision or structural failure escalation.

9. **FailureReport is a pointer (G24).** Carries `run_dir`, not inline detail.
   Debugger and Planner read run artifacts directly.

10. **context-pack.md is code-generated.** Assembled by the gate node, not an
    LLM. LLM generation would add latency and a circular dependency.

11. **Sub-phase naming (G10).** `static-check`, `llm-check`, `exec-check` are
    canonical. "Phase 0/1/2" is deprecated.

12. **Run artifact retention.** Runs retained for project lifetime. Failed runs
    always retained regardless of retention policy.

13. **Iteration cap enforcement.** Gate checks `iteration < max_iterations`
    before allowing retry.

14. **Static analysis is mandatory.** `static-check` always runs, even for
    categories with `method: 'llm'`. Global prerequisite.

15. **Category results are immutable.** Once written to the run directory, they
    are not modified.

16. **LLM confidence threshold.** `pass` verdict with `confidence <
    pass_threshold` is a failure. Default 0.85.

17. **No network access in exec-check.** Test scripts are self-contained — no
    calls to the daemon or external services.

---

## Open questions

| ID | Question | Impact | Status |
|---|---|---|---|
| VAL-001 | Should `static-check` produce per-file granularity in the context-pack, or is the aggregate count sufficient for the Planner? | Planner context window, fix specificity | Open |
| VAL-002 | What is the maximum wall-clock timeout for the entire EXEC node before forcing a halt? | Resource bounding | Open |
| VAL-003 | Should `llm-check` results be cacheable across iterations if the artifact slice has not changed? | LLM cost optimization | Open |
| VAL-004 | Should a category that consistently fails with the same root cause across iterations escalate differently? | Iteration efficiency | Open |
| VAL-005 | Should the user be able to waive a failing category for the current cycle without using `force_pass`? | User control granularity | Open |
| VAL-006 | DDR-023: When should automatic gap detection run during validation? Possible timing: after `static-check` fail, after gate fail, or as part of the DEBUG node. | Gap detection timing, iteration integration | Open |
| VAL-007 | Should run artifact directories be gitignored by default, or committed as project history? | Repository size, audit persistence | Open |
| VAL-008 | What happens when `llm-check` and `exec-check` disagree for the same category (LLM says pass, tests fail, or vice versa)? | Gate semantics, trust hierarchy | Open |
| VAL-009 | Should the Tester have access to previous iteration FailureReports to avoid regenerating tests that fail the same way? | Tester context scope | Open |
| VAL-010 | How many LLM-defined categories can the Planner add before the system flags potential runaway? | Resource bounding | Open |
