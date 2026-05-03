# Artifact Registry

**Type:** reference · **Status:** draft · **Updated:** 2026-04-22

Canonical registry of every artifact the system produces or consumes. Each entry
defines who generates it, where it lives, what scope it covers, and which roles
read it. Use this document to answer: "who writes this file?" and "which agents
need this in their context window?"

Resolves: **G28** (artifact definitions for all 10 roles), **G30** (typed slice
references via DDR-025).

---

## Reference format

All artifact keys use typed prefixes (DDR-025):

| Prefix | Scope | Resolution | Example |
|--------|-------|------------|---------|
| `doc:` | Project | `.sle/project-docs/` | `doc:requirements` |
| `node:{group}:` | Group | `.sle/project-graph/layers/` | `node:auth:architecture` |

Wildcard form `node:*:architecture` loads the named artifact from every group
(use sparingly — token budget).

The `scope` column in every table below is one of:

| Scope | Meaning | Resolution |
|-------|---------|------------|
| `project` | Single instance per project | `.sle/project-docs/{key}.md` or `docs/{key}.md` |
| `group` | One instance per feature group | `.sle/project-graph/layers/{group}/{key}.md` |
| `run` | One instance per validation run | `.sle/runs/{id}/{key}` |
| `ephemeral` | In-memory, never persisted | Resolved from daemon state by scope |
| `system` | Daemon-maintained. Not produced by an agent role. | — |

---

## Discovery phase

Produced once per project by the Facilitator during `sle discover`. These
documents feed every subsequent session type — cycle, chat, and future
discovery revisits.

| Key | Type | Scope | Generator | Description |
|-----|------|-------|-----------|-------------|
| `doc:product-brief` | markdown | project | Facilitator (Round 1) | What is being built and why. Problem statement, target users, core value. |
| `doc:success-definition` | markdown | project | Facilitator (Round 2) | Measurable success criteria. Consumed by Evaluator to produce verdicts. |
| `doc:constraints` | markdown | project | Facilitator (Round 3) | Technical, business, and operational constraints. Consumed by Critic for compliance checks. |
| `doc:stakeholders` | markdown | project | Facilitator (Round 4) | Who the system serves, their needs, and priority ordering. |
| `doc:system-description` | markdown | project | Facilitator (synthesis) | System shape, boundaries, major components, and data flows. Read by all cycle roles. |
| `doc:vision` | markdown | project | Facilitator (synthesis) | Long-term direction. Provides context for Designer architecture decisions. |
| `doc:open-questions` | markdown | project | Facilitator (synthesis) | Unresolved questions. Triggers Explorer investigations. |
| `doc:project-plan` | markdown | project | Facilitator (planning loop) | Phase breakdown with cycle targets and milestone definitions. Written to Beads as Phase 1 tasks. |

**Discovery structure variants** (SLE-024 §6.3):

| Structure | Rounds | Documents produced |
|-----------|--------|-------------------|
| `full` | 4 rounds + synthesis + planning | All 8 documents above |
| `solo` | 2 rounds + synthesis + planning | `doc:product-brief`, `doc:success-definition`, `doc:system-description`, `doc:vision`, `doc:open-questions`, `doc:project-plan` |

---

## Scoping phase

Produced during the SCOPING node (DDR-028). The Facilitator creates scope
artifacts that replace the old goal string as the Designer's and Planner's
primary input. `doc:cycle-scope-draft` may also be created during pre-cycle
chat before the SCOPING node runs.

| Key | Type | Scope | Generator | Required | Description |
|-----|------|-------|-----------|----------|-------------|
| `doc:cycle-scope-draft` | markdown | project | Facilitator (DDR-028 SC-010) | false | Informal scope document created during pre-cycle chat. Captures scope, purpose, initial requirements, and deferred items. Not a formal cycle artifact — serves as input to SCOPING node. |
| `doc:cycle-charter` | markdown | run | Facilitator (DDR-028 SC-010) | true | Formal scope document produced by the SCOPING node. Defines scope, purpose, requirements, boundaries, version_bump intent, and deferred items. Replaces the old goal string as the Planner's primary input. |

---

## Design phase

Produced during the DESIGN node. The Designer reads the cycle charter from the
SCOPING node and produces requirements and architecture. The Critic
reviews both at the DESIGN node when `planning.depth` is `deep` or `research`
(DDR-022).

| Key | Type | Scope | Generator | Description |
|-----|------|-------|-----------|-------------|
| `doc:research-findings` | markdown | project | Explorer | Research findings, spike results, benchmarks, tradeoff analysis. Tagged `explore:user-guided` (DDR-023). Injected into Designer context when EXPLORE runs. |
| `doc:requirements` | markdown | project | Designer | Functional and non-functional requirements — what to build. Owned by Designer per DDR-019. Consumed by Planner (reads), Tester (reads), Builder (reads), Evaluator (reads). |
| `doc:architecture` | markdown | project | Designer | Architecture decisions, system shape, component boundaries, data models, API contracts. Owned by Designer per DDR-019. Consumed by Planner (reads), Builder (reads), Critic (reads), Evaluator (reads). Tester does NOT see this — TDD separation (G22). |
| `doc:critique-report` | markdown | project | Critic | Persistent architecture review: blocking issues, warnings, suggestions. Only produced at `deep` or `research` planning depth (DDR-022). Persists across cycles. |
| `doc:cycle-critique` | json | run | Critic | Structured per-cycle critique output fed back to Designer during CRITIQUE→DESIGN iteration. Ephemeral — not persisted across cycles. |

### Explorer trigger and output

Explorer is user-initiated only (DDR-023). It does not auto-trigger from
`planning.depth` settings. Output is tagged by source:

| Source tag | Mechanism | Interactive? |
|------------|-----------|-------------|
| `explore:user-guided` | User explicitly requests exploration via intent or Facilitator | Yes — rounds of discussion |
| `detection:automatic` | Daemon gap detection at defined points in the cycle | No — flagged to user via Facilitator |

Automatic gap detection is a separate mechanism with its own output channel,
not routed through the Explorer agent.

---

## Planning phase

Produced during the PLAN node. The Planner reads Designer output
(`doc:requirements`, `doc:architecture`) and produces step-level plans.
The optional INTAKE sub-phase runs within the PLAN node when documents are
present (SLE-019).

| Key | Type | Scope | Generator | Description |
|-----|------|-------|-----------|-------------|
| `doc:plan` | markdown | project | Planner | Step-level implementation plan. Specific file, module, and endpoint targets with ordering and dependency declarations. |
| `doc:test-plan` | markdown | project | Planner | Test coverage plan per validation category. Maps requirements to test scenarios. Consumed by Tester (contract) and Evaluator (coverage check). |
| `doc:build-plan` | markdown | project | Planner | Implementation expansion: target files, interfaces, patterns, integration points. Derives from `doc:plan` 1:1. Only produced at `deep` or `research` depth. |

### Intake sub-phase artifacts (SLE-019)

Produced within the PLAN node when documents exist in `.sle/project-docs/`
or when `--intake` is passed. Intake is an embeddable pipeline, not a
separate node.

| Key | Type | Scope | Generator | Description |
|-----|------|-------|-----------|-------------|
| `.sle/coherence-report.json` | json | project | Daemon (static analysis) | Cross-reference integrity, terminology consistency, contradiction detection, completeness, dangling references. Status: `clean`, `flagged`, or `blocked`. |
| `.sle/sharding-proposal.yaml` | yaml | project | Planner + User | Collaborative task decomposition. Each task is a `SLETask` with `TaskContextDeclaration`. Blocked on coherence gate passing. |
| `.sle/tasks.yaml` | yaml | project | Daemon | Local-only task store (DDR-024). Written when Beads is unavailable. Mirrors `SLETask` type from SLE-019. |

Promoted document nodes are created when ungraphed documents enter a cycle:

| Key | Type | Scope | Generator | Description |
|-----|------|-------|-----------|-------------|
| `doc:{document-id}` | markdown | project | Daemon (auto-promotion) | Ungraphed document promoted to a graphed node on first use. Receives backlinks from all downstream consumers. |

---

## Testing phase

Produced during the TEST node. The Tester reads `doc:requirements` and
`doc:test-plan` only — never architecture, implementation, or Builder output
(G22, TDD separation constraint enforced by context manager slice).

| Key | Type | Scope | Generator | Description |
|-----|------|-------|-----------|-------------|
| `doc:test-script:{category}` | typescript | project | Tester | Executable test script for one validation category. Self-contained: no LLM calls, no network calls, no imports from implementation code. Each test tagged with the requirement it covers. One produced per active validation category defined in `validation.yaml`. |

---

## Building phase

Produced during the BUILD node. The Builder reads `doc:requirements`,
`doc:architecture`, and `doc:test-plan`. The Builder never sees the Tester's
internal reasoning — only the final test scripts as a contract to satisfy.

| Key | Type | Scope | Generator | Description |
|-----|------|-------|-----------|-------------|
| `scripts/test-{category}.ts` | typescript | project | Builder | Instrumented test scripts ready for Docker execution. Derived from Tester's test contracts with execution harness, assertions, and coverage instrumentation. |
| `scripts/run-tests.ts` | typescript | project | Builder | Aggregated test runner for all categories. Used by EXEC phase and CI. Generated after CONFIRM gate approval. |
| `node:{group}:implementation` | source | group | Builder | Implementation code for the group's scope. The primary BUILD output. Written to the project source tree and tracked as a group node. |

---

## Execution phase (run artifacts)

Produced during the EXEC node (Layer 4, Docker container). These are structured
outputs from a single validation run, consumed by the VALIDATION gate,
Debugger, and context manager. Full detail: SLE-022.

| Key | Type | Scope | Generator | Description |
|-----|------|-------|-----------|-------------|
| `.sle/runs/{id}/manifest.json` | json | run | Daemon (gate node) | Run entrypoint. Run ID, cycle/iteration, category list, timestamps, overall status. First artifact the context manager reads on failure. |
| `.sle/runs/{id}/ai/context-pack.md` | markdown | run | Daemon (gate node) | Narrative summary of run results for LLM consumption. Includes per-category results, metric highlights, log excerpts, and trace analysis. ~800–1200 tokens for 2–3 failed categories. |
| `.sle/runs/{id}/tests/{category}/result.json` | json | run | EXEC scripts | Per-category pass/fail with test names, error messages, and assertion details. |
| `.sle/runs/{id}/metrics/{category}.json` | json | run | EXEC scripts | Quantitative metrics per category: p50/p95/p99 latencies, throughput, memory, error rates. |
| `.sle/runs/{id}/traces/{category}.jsonl` | jsonl | run | EXEC scripts | Distributed trace spans per category. Hot-path identification for performance failures. |
| `.sle/runs/{id}/logs/{service}.log` | text | run | EXEC scripts | Service logs captured during execution. Relevant lines extracted into context-pack by gate node. |

---

## Validation and evaluation phase

Produced after the VALIDATION gate. The gate itself is deterministic — no
LLM involvement. On failure, the Debugger diagnoses; on pass, the Evaluator
verdicts.

| Key | Type | Scope | Generator | Description |
|-----|------|-------|-----------|-------------|
| `doc:debug-diagnosis` | markdown | ephemeral | Debugger | Ephemeral — feeds next PLAN iteration, only on gate failure. Resolved from daemon state, not persisted across cycles. |
| `FailureReport` | json | ephemeral | Debugger | In-memory root-cause diagnosis injected into Planner context on retry. Never written to disk. |
| `doc:evaluation` | markdown | project | Evaluator | Structured verdict: did implementation satisfy intent? Reads requirements, test-plan, and run artifacts. Consumed by Planner (next cycle) and Critic. Persists across cycles. |
| `reports/validation-latest.html` | html | project | Daemon (gate pass) | Human-readable validation report. Links to previous versions. Overwritten each cycle. |
| `reports/changelog-{version}.md` | markdown | project | Daemon (gate pass) | Cycle changelog. Versioned snapshot of what changed. |
| `.sle/snapshots/{version}/` | directory | project | Daemon (SNAPSHOT node) | Locked, versioned artifact set. Created on cycle completion. Immutable once written. |

### Validation gate outputs

The gate produces two structured types consumed by the feedback loop:

| Output | Type | Produced when | Consumed by |
|--------|------|---------------|-------------|
| `FailureReport` | json | Gate fails | Debugger → Planner (next iteration via context manager Component 5) |
| Gate pass signal | event | Gate passes | Evaluator node activation |

`FailureReport` carries a `run_dir` pointer (SLE-022 version, supersedes
SLE-003's inline format): `cycle`, `iteration`, `run_dir`, `run_id`,
`quick_summary`, `failed_categories`, `passed_categories`.

---

## History phase

Produced during the HISTORY node, after every agent turn within a cycle.

| Key | Type | Scope | Generator | Description |
|-----|------|-------|-----------|-------------|
| `doc:decisions` | markdown | project | Historian | Append-only decision log. 2–3 sentence audit entries per agent turn. Planner reads last 3 entries; Historian reads full. Under review (G15) — may be replaced by structured logging + periodic summarisation. |

---

## System artifacts

Maintained by the daemon or authored by the human. Not produced by agent roles,
but read by all agents during bootstrap.

| Key | Type | Scope | Generator | Description |
|-----|------|-------|-----------|-------------|
| `agent.md` | markdown | project | Human (once, at init) | Project intent, conventions, and constraints. Written during `sle init` step 7. Never modified by the system after init. Read by all agents as bootstrap. |
| `.sle/map.yaml` | yaml | project | Daemon | System state: meta status, cycle progress, artifact registry, remotes. Regenerated after every DAG node. Never hand-edited. |
| `.sle/rules/planning.yaml` | yaml | project | Human (config) | Planning depth, max iterations, reasoning passes. Read by Planner and Designer. |
| `.sle/rules/validation.yaml` | yaml | project | Human (config) + Planner (categories) | Validation categories, thresholds, run artifact declarations. Planner may append new categories; cannot modify existing entries (LLM write boundary, SLE-004). |
| `.sle/rules/artifacts.yaml` | yaml | project | Human (config) | Artifact path mappings and output schemas. |
| `.sle/rules/exit.yaml` | yaml | project | Human (config) | Exit conditions, iteration caps, halt criteria. |
| `.sle/rules/user_validation.yaml` | yaml | project | Human (config) | CONFIRM gate configuration: enabled, required categories, timeout. |
| `.sle/rules/summary.yaml` | yaml | project | Human (config) | Summary format and content rules for the SUMMARISE node. |
| `.sle/rules/agents.yaml` | yaml | project | Human (config) | LLM provider per role (model, temperature, max_tokens), system prompt reference, active/inactive flag. Schema pending (G14). |
| `.sle/chat-history.jsonl` | jsonl | project | Daemon | Chat session messages. Consumed by Facilitator for session resumption. One line per message with role, content, timestamp. |
| `.sle/prompts/{template}.md` | markdown | project | Daemon (installed at init) | System prompt templates per agent role and validation category. Installed during `sle init` step 8. |

---

## Intake pipeline documents (SLE-019)

Free-floating documents that enter the system through `.sle/project-docs/`.
These are distinct from cycle artifacts — they are upstream input provided by
the user or imported from external sources.

| Key | Type | Scope | Generator | Description |
|-----|------|-------|-----------|-------------|
| `.sle/project-docs/{filename}` | varies | project | User / external import | Ungraphed documents: product briefs, API contracts, ADRs, research summaries, hand-written specs. Promoted to `doc:{id}` nodes on first use in a cycle. |
| `.sle/project-docs/{filename}#meta` | json | project | Daemon | Parsed `IntakeDocument` metadata: id, title, tags, sections with token counts, status (`ungraphed`, `promoted`, `superseded`), version. |

### Document lifecycle states

| Status | Meaning | Next transition |
|--------|---------|-----------------|
| `ungraphed` | Exists in `project-docs/` but not yet referenced by any cycle | → `promoted` (on first use) |
| `promoted` | Has a graphed node; backlinks from consuming nodes | → `superseded` (when a newer version replaces it) |
| `superseded` | Replaced by a newer document; preserved for history | Terminal |

---

## Group-scoped node artifacts

Produced per feature group within the project graph (SLE-016, SLE-017). These
are the downstream outputs — nodes are the group-level counterparts to
project-level documents. Referenced via `node:{group}:{key}`.

| Key pattern | Type | Scope | Generator | Description |
|-------------|------|-------|-----------|-------------|
| `node:{group}:architecture` | markdown | group | Designer | Group-specific architecture: component design within the group's scope. Narrows `doc:architecture` to group boundaries. |
| `node:{group}:requirements` | markdown | group | Designer | Group-specific requirements extracted from `doc:requirements`. Defines acceptance criteria for the group's scope. |
| `node:{group}:implementation` | source | group | Builder | Group's source code output. Tracked in the project graph for link index queries. |
| `node:{group}:tests` | typescript | group | Tester / Builder | Group's test scripts. Tester produces contract tests; Builder instruments them. |
| `node:{group}:design-decisions` | markdown | group | Designer / Planner | Group-level design decisions. Distinct from project-level `doc:decisions`. Records trade-offs specific to the group's domain. |
| `node:{group}:evaluation` | markdown | group | Evaluator | Group-specific evaluation results when evaluation is scoped to a single group. |

---

## Role output summary

Every artifact has exactly one generator role (or the daemon/human). This table
maps each of the 10 agent roles to the artifacts they produce.

### Facilitator (Discovery + Chat + Scoping)

| Output | Scope | Session type |
|--------|-------|-------------|
| `doc:product-brief` | project | Discovery |
| `doc:success-definition` | project | Discovery |
| `doc:constraints` | project | Discovery |
| `doc:stakeholders` | project | Discovery |
| `doc:system-description` | project | Discovery |
| `doc:vision` | project | Discovery |
| `doc:open-questions` | project | Discovery |
| `doc:project-plan` | project | Discovery |
| `doc:cycle-scope-draft` | project | Cycle (pre-scope chat) |
| `doc:cycle-charter` | run | Cycle (SCOPING node) |

### Explorer (EXPLORE node, conditional)

| Output | Scope | Notes |
|--------|-------|-------|
| `doc:research-findings` | project | Tagged `explore:user-guided`. User-initiated only (DDR-023). |

### Designer (DESIGN node)

| Output | Scope | Notes |
|--------|-------|-------|
| `doc:requirements` | project | DDR-019 ownership. What to build. |
| `doc:architecture` | project | DDR-019 ownership. System shape and component boundaries. |

### Critic (DESIGN node, conditional)

| Output | Scope | Notes |
|--------|-------|-------|
| `doc:cycle-critique` | run | Per-cycle structured critique fed back to Designer during CRITIQUE→DESIGN iteration. Ephemeral. |
| `doc:critique-report` | project | Only at `deep`/`research` depth. Persistent design review (DDR-022). |

### Planner (PLAN node)

| Output | Scope | Notes |
|--------|-------|-------|
| `doc:plan` | project | Step-level implementation plan. DDR-019. |
| `doc:test-plan` | project | Per-category test coverage. DDR-019. |
| `doc:build-plan` | project | Implementation expansion. Deep/research only. Derives from `doc:plan` 1:1. DDR-019. |

### Tester (TEST node)

| Output | Scope | Notes |
|--------|-------|-------|
| `doc:test-script:{category}` | project | One per active category. TDD-separated: never sees implementation. |

### Builder (BUILD node)

| Output | Scope | Notes |
|--------|-------|-------|
| `scripts/test-{category}.ts` | project | Instrumented test scripts for EXEC. |
| `scripts/run-tests.ts` | project | Aggregated test runner. |
| `node:{group}:implementation` | group | Implementation code, one per affected group. |

### Debugger (DEBUG node, conditional)

| Output | Scope | Notes |
|--------|-------|-------|
| `doc:debug-diagnosis` | ephemeral | Ephemeral. Only on VALIDATION gate failure. Feeds next PLAN iteration. |
| `FailureReport` | ephemeral | In-memory root-cause diagnosis injected into Planner context on retry. |

### Evaluator (EVALUATE node)

| Output | Scope | Notes |
|--------|-------|-------|
| `doc:evaluation` | project | Structured verdict on intent satisfaction. Persists across cycles. |

### Historian (HISTORY node)

| Output | Scope | Notes |
|--------|-------|-------|
| `doc:decisions` | project | Append-only. 2–3 sentence audit entries per agent turn. |

---

## Role input summary

What each role reads during context assembly. Uses typed prefixes (DDR-025).
The context manager resolves these to specific file contents within the
token budget.

| Role | Artifact slices in (typed refs) |
|------|--------------------------------|
| **Facilitator** | `doc:product-brief`, `doc:system-description`, `doc:vision`, `doc:open-questions`, `doc:project-plan`, `.sle/chat-history.jsonl` |
| **Explorer** | Intent, `doc:system-description`, `doc:open-questions`, prior `doc:evaluation`, `doc:constraints` |
| **Designer** | `doc:cycle-charter`, Intent, discovery docs (all 8), prior `doc:architecture`, prior `doc:evaluation`, `doc:decisions` (last 3), `doc:research-findings` (if EXPLORE ran), `agent.md` |
| **Critic** | `doc:architecture`, `doc:requirements`, prior `doc:evaluation`, `doc:constraints` |
| **Planner** | `doc:cycle-charter`, `doc:requirements`, `doc:architecture`, `doc:decisions` (last 3), prior `doc:evaluation`, `FailureReport` (on retry), `doc:debug-diagnosis` (on retry) |
| **Tester** | `doc:requirements`, `doc:test-plan` only. Explicitly excluded: `doc:architecture`, implementation source, Builder output. |
| **Builder** | `doc:requirements`, `doc:architecture`, `doc:test-plan`, `doc:plan` (deep+), `doc:build-plan` (deep+), `doc:test-script:{category}` (as contract) |
| **Debugger** | `.sle/runs/{id}/manifest.json`, `.sle/runs/{id}/ai/context-pack.md`, failed category result/metrics/traces/logs |
| **Evaluator** | `doc:requirements`, `doc:test-plan`, `doc:evaluation` (prior), run artifacts (current) |
| **Historian** | `doc:decisions` (full — append target) |

---

## Context assembly modes

How the context manager resolves artifact references depends on whether
declared tasks exist (SLE-007, SLE-019):

| Mode | Condition | Resolution |
|------|-----------|------------|
| **Declared** (resolver) | Beads tasks carry `TaskContextDeclaration` | Precise section-level refs from task declarations. No inference, no truncation. |
| **Inferred** (legacy) | No declared tasks, or `--no-intake` | Role-based slice defaults from `map.yaml`. May truncate to fit token budget. |

In declared mode, `DocumentRef` entries use the typed prefix format:

```yaml
context:
  documents:
    - ref: "doc:requirements"
      section: "auth-section"
      mode: full
    - ref: "doc:architecture"
      section: "security-layer"
      mode: full
  nodes:
    - "node:auth:implementation"
  source_files:
    - "src/middleware/base.ts"
```

---

## Cross-reference

| Concept | Spec |
|---------|------|
| Artifact ownership (Designer/Planner split) | DDR-019 |
| Critic timing (at DESIGN node) | DDR-022 |
| Explorer trigger (user-initiated only) | DDR-023 |
| Typed prefix format (`doc:` / `node:`) | DDR-025 |
| Local task fallback (no Beads) | DDR-024 |
| Sharding approval (CONFIRM gate tab) | DDR-026 |
| Scoping phase artifacts (cycle-scope-draft, cycle-charter) | DDR-028 |
| Document intake pipeline | SLE-019 |
| Context manager slices | SLE-007 |
| Run artifacts | SLE-022 |
| Project graph (group nodes) | SLE-016, SLE-017 |
| Agent role definitions | SLE-024 §4 |
| Init sequence (artifact setup) | SLE-009 |
| Validation system | SLE-003 |
