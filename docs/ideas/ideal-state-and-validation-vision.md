# Stratum — Ideal State, Validation Model, and Optimization Vision

**Date:** 2026-04-24
**Status:** discussion
**Context:** Synthesis of all designed features, borrowed ideas, and identified gaps. Addresses three questions: (1) what possibilities does the full system unlock, (2) is the validation model clearly defined, and (3) how does optimization/telemetry work.

---

## 1. The Ideal State — What Stratum Becomes

### 1.1 The System Today (as designed)

Stratum is already the most thoroughly spec'd autonomous software lifecycle system in existence. The v2 docs define:

- **10 specialized agent roles** with enforced context isolation
- **A fixed DAG** (12 nodes) governing every cycle
- **Tri-phase validation** (static → LLM → executable) with a deterministic gate
- **7 YAML rule files** governing all behavior — no code changes to alter system behavior
- **10 built-in validation categories** (correctness, performance, security, usability, reliability, maintainability, observability, scalability, compatibility, compliance)
- **Bounded iteration** with failure reports and category caching
- **Git-native snapshots** for every completed cycle
- **3 interfaces** (CLI, Web UI, Obsidian plugin)
- **Context manager** assembling ~3,500 tokens per agent call
- **Discovery and Chat** session types alongside the Cycle

### 1.2 With Borrowed Ideas Added

From Hermes integration (hermes-stratum-integration.md):
- **Hermes as agent runtime** — subagents with scoped toolsets replace raw LLM calls
- **Self-improving prompts** — agents propose behavioral adjustments, humans approve
- **AgentRuntime interface** — pluggable: DirectLLMRuntime or HermesRuntime

From Space Agent (space-agent-research.md):
- **Prompt includes** — `*.system.include.md` / `*.transient.include.md` files injected into the prompt pipeline. Agents write to their own prompt over time.
- **Self-writing memory** — Evaluator proposes behavioral notes, human approves, loaded as standing context in future cycles
- **Git-backed artifact history** — adaptive debounced commits within cycles, rollback capability
- **Transient context layer** — ephemeral daemon state in every agent call
- **Layered filesystem for all config** — L0/L1/L2 for prompts, skills, and agent configs

### 1.3 What This Enables — The Full Vision

When all of this is built, here's what a developer experience looks like:

**Day 1: Project Setup**
```
$ stratum discover
```
The Facilitator asks questions. Over several rounds it produces: product brief, success definition, constraints, system description, project plan. The Planner auto-selects validation categories based on project type (`api` → correctness + performance + security). The user reviews at the CONFIRM gate.

**Day 2-10: Building**
```
$ stratum start "Implement user authentication with JWT and role-based access control"
```
The system runs a cycle. Designer produces requirements and architecture. Critic reviews (at `deep` depth). Planner produces step-level plan. Tester writes tests from requirements alone. CONFIRM gate — user reviews the plan and tests. Builder implements. EXEC runs validation in Docker. Gate evaluates deterministically.

If performance category fails (p95 latency > 200ms), the Debugger diagnoses, the Planner revises just the performance-relevant code, and the cycle retries — only re-running the performance category, not correctness or security.

After several cycles, the Evaluator notices patterns and writes to `behavioral.md`:
```
This project uses JWT. Avoid session-based patterns.
The auth module requires timing-safe string comparison for token validation.
```
These become standing context for all future Planner and Builder calls.

**Day 30: Optimization**
```
$ stratum start "Optimize the items API — p95 latency is 340ms, target is under 100ms"
```
The Planner creates an `optimization` validation category with specific thresholds. The Tester writes benchmarks. The Builder instruments the code. EXEC runs the benchmarks and produces traces, flamegraphs, and percentile data.

But the system doesn't stop at "make it faster." The performance validation category catches regressions. The observability category verifies that the new code has proper metrics. The reliability category checks that the optimization doesn't break error handling. All categories must pass.

**Day 60: Self-Improving System**
After 50+ cycles, the system has:
- A `behavioral.md` with 40+ project-specific patterns
- 50 locked snapshots the Evaluator can reference
- Cognee-indexed cycle history searchable by semantic query
- Per-role prompt includes tuned to this specific project
- Validation categories custom-tailored to the project's domain

The Planner knows this project. The Builder knows the conventions. The Tester knows the edge cases. The system is faster, more accurate, and less prone to iteration than it was on day 1 — not because the LLM got better, but because the *deterministic scaffolding around it* accumulated institutional knowledge.

### 1.4 Possibility Map

| What you can do | How Stratum enables it | Without Stratum |
|---|---|---|
| **Build a feature from intent alone** | `stratum start "..."` → full cycle with validation | Manual prompt → code → test → debug loop |
| **Know that built code actually works** | Tri-phase validation (static + LLM + executable) + deterministic gate | Run tests manually, hope you covered everything |
| **Never repeat the same mistake** | Self-writing memory (behavioral.md) + Cognee cross-cycle search | Paste the same fix instructions every session |
| **Optimize with evidence** | Performance category produces traces, percentiles, flamegraphs; optimization loop is a regular cycle | Manual profiling, ad-hoc benchmarks |
| **Change system behavior without code** | Edit YAML rule files — different depth, different categories, different thresholds | Modify agent prompts, restart, hope |
| **Rollback any change** | Git-backed snapshots per cycle + artifact history with time travel | `git revert` and pray |
| **Build with different quality levels** | `--depth minimal` for prototyping, `--depth research` for critical systems | Same process regardless of stakes |
| **Trust the validation** | Tester never sees implementation (TDD separation), gate is deterministic boolean logic | Tests written by the same person who wrote the code |
| **Scale validation to the domain** | Planner can add categories (`accessibility`, `data_integrity`, `offline_support`) | Hard-coded test suite |
| **Use any LLM** | agents.yaml configures provider per role; HermesRuntime for tool access | Locked to one provider |

---

## 2. The Validation Model — Current State

### 2.1 What's Defined

The validation system is **extremely well-defined** (see `specs/validation.md`, 888 lines). Here's the complete model:

**Three sub-phases, sequential:**

```
static-check (lint, typecheck, complexity)
  ↓ must pass
llm-check (semantic correctness — does this satisfy intent?)
  ↓ must pass (confidence ≥ 0.85)
exec-check (functional correctness — do tests pass in Docker?)
  ↓ must pass
→ GATE: deterministic boolean on all results
```

**Three validation methods per category:**

| Method | static-check | llm-check | exec-check |
|---|---|---|---|
| `llm` | Yes | Yes | No |
| `executable` | Yes | No | Yes |
| `both` | Yes | Yes | Yes |

**10 built-in categories:** correctness, performance, security, usability, reliability, maintainability, observability, scalability, compatibility, compliance.

**Per-project templates:** API projects get correctness + performance + security by default. UI projects get correctness + usability + performance.

**LLM-defined categories:** The Planner can add new categories at planning time. The user confirms before BUILD.

**Run artifacts:** Each validation run produces a structured directory with manifest, context-pack, per-category results, metrics, traces, and logs.

**Category caching:** Passing categories are never re-run on retry. Only failed categories are re-executed.

### 2.2 What's NOT Defined — Dynamic Category Selection

The spec says "the Planner may emit additional categories beyond the built-ins at planning time." But it doesn't define **how** the Planner decides which categories to add. Currently:

1. `sle init` sets default categories based on project type (from `validation.yaml`)
2. The Planner *can* append categories during the PLAN node
3. The user confirms at the CONFIRM gate

**What's missing:**

- **No heuristic for category selection.** The Planner relies entirely on LLM judgment to decide "this feature needs accessibility testing" or "this is a database migration, add data_integrity." There's no rule-based fallback.
- **No category discovery from intent.** If the user says "build a login form," the system should auto-suggest `security` and `usability` without waiting for the Planner to think of it.
- **No progressive category activation.** Categories are either active or not. There's no concept of "activate observability after 3 cycles" or "activate scalability when the codebase exceeds N modules."
- **No category dependency graph.** Some categories logically depend on others (e.g., `scalability` presupposes `performance` passing). The spec doesn't enforce this.

### 2.3 What's NOT Defined — Optimization / Telemetry

This is the biggest gap. The validation system can *detect* performance problems (the `performance` category with its p95 latency checks), but it has no mechanism for **continuous optimization**:

- **No built-in telemetry system.** The spec has traces and metrics in the run artifact schema, but these are generated *during validation runs only*. There's no always-on telemetry that monitors the built system in production or during development.
- **No bottleneck detection.** The performance category can tell you "p95=340ms exceeds threshold 200ms," but it doesn't tell you *why*. The trace summary in context-pack.md shows the hottest path, but the system doesn't have an agent role dedicated to performance analysis.
- **No optimization loop.** Validation says "pass" or "fail." It doesn't say "this is 3x slower than it could be, and here's the specific bottleneck to fix."
- **No benchmark regression tracking.** Each cycle produces metrics, but there's no cross-cycle comparison. The Evaluator could note "p95 degraded from 120ms to 340ms" but this isn't automated.

---

## 3. Proposals for the Gaps

### 3.1 Dynamic Validation Category Selection

**Proposal: Intent-driven category rules + Planner augmentation**

Add a `category_rules` section to `validation.yaml`:

```yaml
category_rules:
  triggers:
    - keywords: ["auth", "login", "password", "session", "token", "jwt"]
      suggest: [security]
      confidence: 0.9

    - keywords: ["form", "input", "button", "modal", "dialog", "ui"]
      suggest: [usability, accessibility]
      confidence: 0.8

    - keywords: ["database", "migration", "query", "index", "schema"]
      suggest: [reliability, data_integrity]
      confidence: 0.85

    - keywords: ["cache", "queue", "worker", "batch", "stream"]
      suggest: [scalability, performance]
      confidence: 0.85

    - keywords: ["api", "endpoint", "route", "handler"]
      suggest: [security, compatibility]
      confidence: 0.8

  progressive:
    - after_cycles: 5
      activate: [maintainability]
      reason: "Codebase is growing — check complexity and documentation"

    - after_cycles: 10
      activate: [observability]
      reason: "System is complex enough to need logging and metrics validation"

    - on_codebase_size_exceeds: 50  # modules
      activate: [scalability]
      reason: "Codebase large enough to warrant scalability checks"

  dependencies:
    scalability: [performance]
    compliance: [security]
    accessibility: [usability]
```

**How it works:**

1. **At `stratum start`:** The daemon parses the user's intent against `category_rules.triggers`. If keywords match, suggested categories are flagged as "auto-suggested."
2. **At PLAN node:** The Planner receives the auto-suggested categories plus the LLM's own judgment. It produces a final category list.
3. **At CONFIRM gate:** The user sees which categories are active and why (auto-suggested vs. Planner-added vs. default). They can add, remove, or modify.
4. **Progressive activation** happens between cycles — the daemon checks `category_rules.progressive` and auto-activates categories with a note in `decisions.md`.
5. **Dependency enforcement** — if the Planner activates `scalability`, `performance` is automatically included.

**This is NOT dynamic in the sense of "the LLM picks categories at runtime."** The rules are deterministic. The LLM suggests, the rules narrow, the human confirms.

### 3.2 The Telemetry and Optimization System

**Problem:** Validation catches performance regressions after the fact. But for systems that need to be highly optimized, the developer needs *continuous* performance awareness — not just "fail if p95 > 200ms" but "here's what's slow, why it's slow, and what to do about it."

**Proposal: Add a new validation mode — `optimization` — and a new agent capability — `telemetry builder`**

#### 3.2.1 The `optimization` validation category

A specialized category that goes beyond pass/fail:

```yaml
# In validation.yaml
categories:
  - name: optimization
    method: both
    executable:
      runner: "node"
      timeout_ms: 60000
      output_format: json
    llm:
      artifact_slice: [requirements.md, architecture.md]
      prompt_template: .sle/prompts/optimization_check.md
      pass_threshold: 0.8
    pass_criteria:
      executable: threshold_based
      thresholds:
        p50_ms: 50
        p95_ms: 100
        p99_ms: 200
        memory_peak_mb: 128
        cpu_utilization_pct: 70
    on_fail:
      feed_to: planner
      include: [metrics, traces, flamegraph, bottleneck_report]
```

The key difference from the existing `performance` category: **optimization produces a structured bottleneck report, not just pass/fail.**

```typescript
interface OptimizationResult {
  passed: boolean
  benchmarks: Array<{
    name: string
    metric: string
    value: number
    threshold: number
    passed: boolean
  }>
  bottleneck_report: {
    primary_bottleneck: {
      location: string        // file:line
      type: 'cpu' | 'memory' | 'io' | 'network' | 'lock_contention'
      description: string
      percentage_of_total: number
    }
    secondary_bottlenecks: Array<{
      location: string
      type: string
      description: string
      percentage_of_total: number
    }>
    recommendations: string[]
  }
  flamegraph_path?: string    // path within run directory
  trace_summary: {
    hottest_path: string[]    // ordered list of call sites
    total_duration_ms: number
    breakdown: Record<string, number>  // call site → ms
  }
}
```

#### 3.2.2 The Telemetry Builder — a Builder mode, not a new role

Instead of creating a new agent role, the **Builder** gains a mode triggered by the optimization category:

When the Planner's plan includes the optimization category, the Builder produces **two additional outputs** alongside the implementation:

1. **Instrumentation code** — the Builder wraps critical paths with timing, memory, and throughput collection. This is not manual profiling — the Builder generates instrumentation based on the architecture it reads.

2. **A benchmark suite** — separate from the Tester's correctness tests. These are load tests, stress tests, and microbenchmarks that exercise the code paths most likely to be bottlenecks based on the architecture.

The instrumentation produces a telemetry stream during EXEC:

```
$RUN_DIR/telemetry/
  metrics.jsonl          ← streaming metrics (latency, memory, throughput per operation)
  traces.jsonl           ← distributed trace spans
  flamegraph.json        ← collapsed stack frames (compatible with speedscope)
  bottleneck-report.json ← structured analysis from the benchmark runner
```

The benchmark runner is a test script, but instead of assertions it produces the `OptimizationResult` structure.

#### 3.2.3 How the optimization loop works

```
stratum start "Optimize the items API — p95 is 340ms, target 100ms"
  │
  ├─ DESIGN: Designer notes performance target, flags hot paths
  ├─ PLAN: Planner activates optimization category, creates
  │        benchmark plan and instrumentation strategy
  ├─ TEST: Tester writes correctness tests (as normal)
  ├─ CONFIRM: User reviews plan including optimization targets
  ├─ BUILD: Builder produces implementation + instrumentation + benchmarks
  ├─ EXEC:
  │   ├─ correctness: exec-check (tests pass)
  │   ├─ optimization: exec-check (benchmarks run, telemetry collected)
  │   └─ optimization: bottleneck-report.json generated
  ├─ GATE:
  │   ├─ correctness: PASS
  │   └─ optimization: FAIL (p95=310ms, primary bottleneck: N+1 query at items.ts:47)
  ├─ DEBUG: Debugger reads bottleneck-report.json, produces FailureReport
  ├─ PLAN (retry): Planner focuses on items.ts:47, adds eager loading
  ├─ BUILD: Regenerates implementation with fix
  ├─ EXEC: Re-runs only optimization (correctness cached)
  ├─ GATE:
  │   ├─ correctness: PASS (cached)
  │   └─ optimization: PASS (p95=87ms)
  └─ SNAPSHOT: Locked with benchmarks showing 4x improvement
```

#### 3.2.4 Cross-cycle benchmark regression tracking

Add a new section to `map.yaml`:

```yaml
benchmarks:
  history:
    - cycle: 4
      iteration: 2
      p50_ms: 45
      p95_ms: 87
      p99_ms: 156
      timestamp: "2026-04-10T14:30:00Z"
    - cycle: 3
      iteration: 1
      p50_ms: 180
      p95_ms: 340
      p99_ms: 620
      timestamp: "2026-04-08T10:15:00Z"
  regression_threshold_pct: 20
```

The daemon compares new benchmark results against the previous best. If any metric regresses by more than `regression_threshold_pct`, the Planner is warned even if the absolute threshold passes.

The Web UI renders this as a performance timeline — p50/p95/p99 plotted over cycles.

#### 3.2.5 The optimization_check prompt template

```markdown
# Optimization Check

You are evaluating whether the implementation meets performance targets.

## Artifacts provided
- requirements.md (performance targets specified here)
- architecture.md (intended data flow, caching strategy)
- bottleneck-report.json (if available from exec-check)

## Evaluate

1. Do the benchmark results meet all thresholds in pass_criteria?
2. If a bottleneck-report is available, is the primary bottleneck
   addressed or acceptable for the current project phase?
3. Are there obvious optimization opportunities the benchmarks
   didn't capture? (e.g., missing cache, unnecessary serialization)
4. Is the instrumentation sufficient to catch future regressions?

## Output

```json
{
  "verdict": "pass|fail",
  "issues": ["..."],
  "confidence": 0.0-1.0,
  "evidence": ["..."]
}
```
```

### 3.3 Self-Improving Validation

Combining the prompt-include pattern from Space Agent with the validation system:

After every cycle, the Evaluator writes a `.sle/prompts/validation-behavioral.system.include.md`:

```markdown
## Validation behavioral notes (auto-generated, cycle 4)

- The project's test runner is vitest, not jest. All test scripts must use
  vitest imports and configuration.
- The database is PostgreSQL. Performance tests should use realistic data
  volumes (10k+ rows) to catch query plan regressions.
- The auth module uses bcrypt with 12 rounds. Security tests must account
  for timing (hash verification >100ms is expected, not a bug).
- Previous performance failures were all N+1 queries. The Planner should
  proactively suggest eager loading for any database-backed endpoint.
```

This gets loaded into every future Planner and Builder call. The validation system *learns* from its own failures.

---

## 4. The Complete Validation Framework — Summary

```
┌─────────────────────────────────────────────────────────────────┐
│                    VALIDATION FRAMEWORK                          │
│                                                                 │
│  ┌─────────────────┐  ┌─────────────────┐  ┌────────────────┐  │
│  │ Category Source  │  │ Execution Model │  │ Feedback Loop  │  │
│  │                 │  │                 │  │                │  │
│  │ • Project type  │  │ • static-check  │  │ • FailureReport│  │
│  │   defaults      │  │   (lint/type)   │  │   → Debugger   │  │
│  │ • Intent-driven │  │ • llm-check     │  │   → Planner    │  │
│  │   keyword rules │  │   (semantic)    │  │                │  │
│  │ • Planner-added │  │ • exec-check    │  │ • Bottleneck   │  │
│  │   (LLM judgment)│  │   (functional)  │  │   report       │  │
│  │ • Progressive   │  │                 │  │   → Builder    │  │
│  │   activation    │  │ • Docker per    │  │   (optimization)│  │
│  │ • Human at      │  │   iteration     │  │                │  │
│  │   CONFIRM gate  │  │ • Category      │  │ • Behavioral   │  │
│  │                 │  │   caching       │  │   prompt       │  │
│  └─────────────────┘  │ • Deterministic │  │   includes     │  │
│                       │   gate          │  │   (self-tuning)│  │
│  10 built-in cats     └─────────────────┘  └────────────────┘  │
│  + LLM-defined cats                                            │
│  + optimization mode                                            │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ Optimization Layer (optional)                               ││
│  │                                                             ││
│  │ • Instrumentation code generated by Builder                 ││
│  │ • Benchmark suite (separate from correctness tests)         ││
│  │ • Bottleneck report with primary/secondary + recommendations││
│  │ • Flamegraphs and trace analysis                            ││
│  │ • Cross-cycle regression tracking (map.yaml benchmarks)     ││
│  │ • Performance timeline in Web UI                            ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                 │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ Self-Improvement Layer (accumulated over cycles)            ││
│  │                                                             ││
│  │ • behavioral.md — project-specific patterns                 ││
│  │ • validation-behavioral.system.include.md — learned rules   ││
│  │ • Cognee-indexed cycle history — semantic search             ││
│  │ • Cross-cycle benchmark comparison — regression detection    ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

### What exists today (spec'd):

| Component | Status | Location |
|---|---|---|
| Tri-phase validation (static/LLM/exec) | Fully spec'd | `specs/validation.md` |
| 10 built-in categories | Fully spec'd | `specs/validation.md` |
| Deterministic gate | Fully spec'd | `specs/validation.md` |
| Category caching | Fully spec'd | `specs/validation.md` |
| Run artifacts (manifest, context-pack, traces, metrics) | Fully spec'd | `specs/run-artifacts.md` |
| TDD separation (Tester ≠ Builder) | Fully spec'd | `overview/agent-roles.md` |
| FailureReport with run_dir pointer | Fully spec'd | `specs/validation.md` |
| LLM-defined categories (Planner adds) | Spec'd (mechanism undefined) | `specs/validation.md` |
| Per-project type defaults | Fully spec'd | `specs/validation.md` |

### What's new (proposed in this document):

| Component | Status | Section |
|---|---|---|
| Intent-driven category rules | Proposed | §3.1 |
| Progressive category activation | Proposed | §3.1 |
| Category dependency enforcement | Proposed | §3.1 |
| Optimization category with bottleneck report | Proposed | §3.2 |
| Telemetry builder (Builder mode) | Proposed | §3.2 |
| Cross-cycle benchmark regression tracking | Proposed | §3.2 |
| Performance timeline in Web UI | Proposed | §3.2 |
| Self-improving validation via prompt includes | Proposed | §3.3 |

### What's still open:

| Gap | Why it matters |
|---|---|
| **How does the Planner decide which LLM-defined categories to add?** | Currently undefined heuristic. The intent-driven rules help, but edge cases need the LLM to reason. Needs a prompt template for category selection. |
| **How does the system handle conflicting validation results?** | VAL-008 in validation.md: "What happens when llm-check and exec-check disagree?" Still open. |
| **What's the optimization strategy for non-performance concerns?** | Bottleneck detection is spec'd for latency/throughput. Memory optimization, bundle size, startup time, and cold-path optimization need their own benchmark patterns. |
| **How does always-on telemetry integrate with the cycle model?** | The proposal defines telemetry during EXEC. But for production systems, you'd want always-on telemetry that feeds back into future cycles. This requires a runtime component outside the daemon. |
| **How does the system validate distributed systems?** | Current validation runs in a single Docker container. Multi-service validation (API + worker + database + cache) needs a docker-compose-based test harness. |

---

## 5. See also

| Document | Relationship |
|---|---|
| [specs/validation.md](../specs/validation.md) | Authoritative validation spec (888 lines) |
| [specs/run-artifacts.md](../specs/run-artifacts.md) | Run artifact schema and context-pack generation |
| [specs/context-manager.md](../specs/context-manager.md) | Context assembly (5-component window) |
| [specs/rule-files.md](../specs/rule-files.md) | 7 YAML rule file schemas |
| [overview/what-is-sle.md](../overview/what-is-sle.md) | Core concepts |
| [overview/agent-roles.md](../overview/agent-roles.md) | All 10 agent roles |
| [overview/workflow-model.md](../overview/workflow-model.md) | Workflow-run execution model |
| [hermes-stratum-integration.md](hermes-stratum-integration.md) | Hermes integration levels |
| [space-agent-research.md](../research/space-agent-research.md) | Prompt includes, self-writing memory |
