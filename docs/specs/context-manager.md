# Context Manager

**Type:** spec · **Status:** draft · **Updated:** 2026-04-22
**Depends on:** DDR-019, DDR-020, DDR-022, DDR-023, DDR-025
**Source material:** SLE-007

## Overview

The context manager assembles the context window that every agent call receives.
It is the primary mechanism that keeps the system bounded — without it, token
costs grow unboundedly across iterations and the system becomes incoherent.

**Core invariant: no agent ever receives raw conversation history.**

Instead, each agent call receives a precisely assembled window built from five
components, each with a hard token budget. The total target is under 3,500
tokens per call regardless of how many cycles have run or how large the
artifact store has grown.

The context manager is pure computation — no LLM calls, no external services.
It reads artifacts from disk, applies slice rules and token budgets, and
produces a structured `AssembledContext` ready for the agent invocation layer.

**Canonical types:** [../reference/types.md](../reference/types.md) §7.
**Artifact keys per role:** [../reference/artifact-registry.md](../reference/artifact-registry.md) §Role input summary.
**DDR decisions:** [../decisions/DECISION-BRIEFS.md](../decisions/DECISION-BRIEFS.md).

---

## Data model

### Five-component window

Every agent call receives exactly these five components, assembled in this
order:

```
┌─────────────────────────────────────┐
│ 1. System prompt        ~500 tokens │  role + behavioral rules
│ 2. Artifact slices     ~2000 tokens │  only what this role needs
│ 3. State summary        ~300 tokens │  current cycle, iteration, depth
│ 4. Task                 ~200 tokens │  specific instruction this turn
│ 5. Failure context      ~400 tokens │  FailureReport — only on retry
└─────────────────────────────────────┘
                    total target: ~3,400 tokens (components sum; hard ceiling is 3,500)
                    hard ceiling: 4000 tokens
```

Component 5 is absent on iteration 1. On retry iterations it replaces the
token budget that would otherwise go to passing category results.

### AssembledContext

```typescript
interface AssembledContext {
  system_prompt: string
  artifact_slices: Record<string, string>
  state_summary: string
  task: string
  failure_context?: string
  token_count: number
  truncated: string[]
}
```

Full definition: `AssembledContext` in [../reference/types.md](../reference/types.md) §7.

### SliceRule

```typescript
interface SliceRule {
  artifact_id: string
  mode: 'full' | 'last_n_entries' | 'last_cycle' | 'summary_only'
  max_entries?: number
  max_tokens?: number
  never_truncate?: boolean
}
```

| Field | Purpose |
|-------|---------|
| `artifact_id` | Typed artifact reference: `doc:{key}` or `node:{group}:{key}` (DDR-025) |
| `mode` | How the artifact content is loaded |
| `max_entries` | Cap on entry count when mode is `last_n_entries` |
| `max_tokens` | Hard token cap for this artifact regardless of mode |
| `never_truncate` | If `true`, this artifact is exempt from budget truncation |

### ContextManagerConfig

```typescript
interface ContextManagerConfig {
  artifact_slice_size: number
  summary_max_tokens: number
  system_prompt_max_tokens: number
  hard_ceiling: number
}
```

Populated from `planning.yaml`. `hard_ceiling` is always 4000 and is not
configurable.

### Assembly modes

```typescript
type ContextAssemblyMode = 'declared' | 'inferred'
```

Full definition: `ContextAssemblyMode` in [../reference/types.md](../reference/types.md) §1.

| Mode | Condition | Behavior |
|------|-----------|----------|
| `declared` | Beads tasks carry `TaskContextDeclaration` | Precise section-level refs from task declarations. No inference, no truncation of declared sections. |
| `inferred` | No declared tasks, or `--no-intake` | Role-based slice defaults from this document. May truncate to fit token budget. |

In `declared` mode, `TaskContextDeclaration.slices` uses typed prefixes:

```yaml
slices:
  - "doc:requirements"
  - "doc:architecture"
  - "node:auth:implementation"
```

In `inferred` mode, the context manager falls back to the role-specific default
slices defined in §Context slices.

---

## Behavior

### Assembly algorithm

The context manager assembles the window in this order on every agent call:

```
assemble(role, state, config, map, failureReport?) → AssembledContext

1. Resolve assembly mode
   - If task has TaskContextDeclaration → declared mode
   - Else → inferred mode

2. System prompt (Component 1)
   - buildSystemPrompt(role, config)
   - Fixed structure, role-specific description and output format
   - Budget: config.system_prompt_max_tokens (~500)

3. Artifact slices (Component 2)
   - If declared mode: load declared refs from TaskContextDeclaration
   - If inferred mode: load role default slices from §Context slices
   - Apply per-artifact SliceRule (mode, max_entries, max_tokens)
   - Enforce total token budget: config.artifact_slice_size (~2000)
   - Record truncated artifact IDs

4. State summary (Component 3)
   - buildStateSummary(state, map)
   - Generated from map.yaml — not by an LLM call
   - Budget: config.summary_max_tokens (~300)

5. Task (Component 4)
   - state.current_task
   - Written by DAG runner based on current node and cycle state
   - Budget: ~200 tokens

6. Failure context (Component 5) — only on retry
   - If state.iteration > 1 AND failureReport is present:
     formatFailureReport(failureReport)
   - Budget: ~400 tokens

7. Validate total token count
   - If total > hard_ceiling: log warning, truncate lowest-priority slices
   - Record final token_count and truncated list

8. Return AssembledContext
```

### Component 1 — System prompt

The system prompt defines the agent's role and behavioral constraints. Same
structure for every role — only the role-specific section differs.

```
You are the {role} agent in an SLE cycle.

## Your role
{role_description}

## What you must not do
- Modify map.yaml directly
- Write to artifact paths not in your assigned slice
- Call bd commands directly — use the provided task context
- Exceed the scope of your current task

## Output format
{role_output_format}

## Artifacts in your context
The following documents are provided below. Read them before responding.
{artifact_list}
```

The `{artifact_list}` section is generated by the context manager from the
resolved artifact slices — it lists each artifact by its typed reference and
title so the agent knows what it has access to.

Role descriptions for all 10 roles are defined in [prompt-templates.md](prompt-templates.md).

### Component 2 — Artifact slices

The artifact slice is the most important component. It determines what
knowledge each agent has access to — and crucially, what it does not.

#### Slice loading rules

**1. Typed reference resolution (DDR-025):**

All artifact references use typed prefixes. The context manager resolves each
reference to a file path:

| Prefix | Resolution |
|--------|------------|
| `doc:{key}` | `.sle/project-docs/{key}.md` (or appropriate extension per artifact format) |
| `node:{group}:{key}` | `.sle/project-graph/layers/{group}/{key}.md` |
| `doc:{key}` (scope: ephemeral) | Resolved from in-memory daemon state — no disk access |

Wildcard form `node:*:{key}` loads the named artifact from every group.
Use sparingly — it consumes token budget proportional to group count.

**2. Loading modes:**

| Mode | Behavior |
|------|----------|
| `full` | Load the entire artifact. No truncation unless total budget exceeded. |
| `last_n_entries` | Load only the last N entries (for append-only artifacts like decisions). |
| `last_cycle` | Load only the most recent cycle's content (for evaluation, failure reports). |
| `summary_only` | Load a pre-generated summary if available, otherwise load full with truncation. |

Default loading modes per artifact key:

| Artifact | Default mode | Notes |
|----------|-------------|-------|
| `doc:requirements` | `full` | Never truncated (`never_truncate: true`) |
| `doc:architecture` | `full` | Never truncated (`never_truncate: true`) |
| `doc:test-plan` | `full` | Never truncated for Tester; truncated for other roles if budget exceeded |
| `doc:decisions` | `last_n_entries: 3` | Historian gets `full` — it is the append target |
| `doc:evaluation` | `last_cycle` | Only the most recent evaluation entry |
| `doc:plan`                  | `full`              | Only loaded at `deep`+ depth |
| `doc:build-plan`           | `full`              | Only present at `deep`/`research` depth after PLAN node |
| `doc:research-findings`     | `full`              | Only present when EXPLORE node ran |
| `doc:debug-diagnosis` | `full` | Ephemeral — only present on retry, only for Planner/Debugger |
| `doc:critique-report` | `full` | Only present at `deep`/`research` depth after CRITIQUE node. Project-scoped persistent design review. |
| `doc:cycle-critique` | `full` | Per-cycle structured critique fed back to Designer. Run-scoped — ephemeral across cycles. Present whenever CRITIQUE node ran. |

**3. Token budget enforcement:**

After loading each artifact, the context manager counts tokens. If the
cumulative slice exceeds `artifact_slice_size`, it truncates from the oldest
content first — never from the start of a document, always from the middle or
end where entries are oldest.

Truncation priority (lowest priority truncated first):

| Priority | Artifact | Notes |
|----------|----------|-------|
| 1 (truncate first) | `doc:evaluation` | Historical, can be summarized |
| 2 | `doc:decisions` | Only the loaded entries at risk, not the full file |
| 3                   | `doc:plan`             | Step-level detail is secondary |
| 3.5                 | `doc:build-plan`       | Implementation expansion — secondary to plan steps |
| 4                   | `doc:test-plan`        | Test coverage detail is secondary (except for Tester) |
| 5 (truncate last) | `doc:research-findings` | Recent research is directly relevant |
| — | `doc:requirements` | Never truncated |
| — | `doc:architecture` | Never truncated |

`doc:requirements` and `doc:architecture` are never truncated. If they alone
exceed the budget, the context manager logs a warning and the budget ceiling
is temporarily raised for that call only.

```
enforceTokenBudget(slices, budget):
  total = countTokens(slices)
  if total <= budget: return slices

  for artifact in truncationOrder:
    if total <= budget: break
    if slices[artifact] exists AND artifact.not_never_truncate:
      slices[artifact] = truncateFromMiddle(slices[artifact], ...)
      total = countTokens(slices)

  return slices
```

**4. Source file injection (Builder only):**

For the Builder, `source_files` is a special slice key that resolves to the
implementation files most relevant to the current task. The context manager
uses the `repo.key_files` list from `map.yaml` to select files by path pattern.

```
resolveSourceSlice(intent.goal, map.repo.key_files, budget=800)
```

The source slice is loaded after document slices. If the document slice budget
is already exceeded, the source slice is skipped entirely rather than
truncating documents.

### Component 3 — State summary

A short, structured summary of the current cycle state. Generated by the
context manager from `map.yaml` — not by an LLM call.

```
Cycle: 4 | Iteration: 2 | Depth: standard | Status: running
Active categories: correctness · performance · security
Last gate outcome: failed (iteration 1)
Version: v0.3.0 → targeting v0.4.0
```

On iteration 1 the last gate outcome line is omitted. On retry iterations it
is prominent — the agent knows it is on a retry before reading anything else.

Format is fixed plain text, not markdown. Kept short deliberately — this is
orientation, not information.

### Component 4 — Task

The specific instruction for this agent turn. Written by the DAG runner based
on the current node and cycle state.

Examples:

**Designer, iteration 1:**
```
Design the system for the following goal:
"Add rate limiting to the POST /items endpoint — 100 requests per minute
per API key, return 429 on breach."

Produce: requirements.md, architecture.md.
Base your design on the discovery documents provided.
```

**Planner, iteration 1:**
```
Plan the implementation for the goal described in requirements.md and
architecture.md.

Produce: plan.md, test-plan.md.
Recommend validation categories appropriate for this change.
```

**Planner, iteration 2 (retry):**
```
The previous iteration failed validation. See the FailureReport below.
Revise only the sections of plan.md and test-plan.md relevant to the
failed categories. Do not rewrite passing sections.

Failed categories: performance, security
```

**Tester:**
```
Write executable test scripts for the requirements in doc:requirements
and the test plan in doc:test-plan.

Produce one test script per active validation category:
  - doc:test-script:correctness
  - doc:test-script:performance
  - doc:test-script:security

Each script must: output JSON to stdout, exit 0 on pass, exit 1 on fail.
Scripts must be self-contained — no imports from implementation code.
```

**Builder:**
```
Implement the system as specified in doc:requirements and doc:architecture.
Satisfy the test contracts defined in the test scripts.

Produce:
  - Implementation code (node:{group}:implementation)
  - Instrumented test scripts (scripts/test-{category}.ts)
  - Aggregated test runner (scripts/run-tests.ts)
```

**Historian:**
```
The Builder has completed its turn. Write a 2-3 sentence entry to
doc:decisions describing what was implemented, what key decisions were
made, and what changed from the previous state. Be specific about the
implementation choices, not just the outcome.
```

### Component 5 — Failure context

Only present on iteration > 1. Contains the structured `FailureReport` from
the previous gate failure.

```
## Failure context (iteration 1 → 2)

The following categories failed:

### performance
Phase: executable
Failed tests:
  - bench:p95_latency — p95 was 340ms, threshold is 200ms
  - bench:error_rate  — error rate was 0.8%, threshold is 0.1%
Metrics: { p95_ms: 340, error_rate: 0.008 }

### security
Phase: llm
Issues identified:
  - API key is logged in plaintext in the request handler
  - Rate limit counter stored in process memory — not shared across
    instances, ineffective in multi-process deployment
Confidence: 0.92
```

**Passing categories are never included in the failure context.** The Planner
receives no information about categories that already passed — this keeps the
retry focused on what actually needs to change.

When the Debugger has produced a `doc:debug-diagnosis`, it is included as an
additional section after the failure context. Both `doc:debug-diagnosis` and
`FailureReport` are ephemeral artifacts — they are resolved from daemon state,
not read from disk. The daemon injects them directly into the assembled context.

```
### Debug diagnosis
Root cause: Rate limiter uses a per-process Map instead of Redis.
The counter resets on process restart and is not shared across instances.
Recommendation: Replace with Redis-backed counter with TTL expiry.
```

---

## Context slices

### Overview

Each role receives a specific set of artifact slices. The slice assignments
implement role separation: the Tester never sees architecture (TDD separation),
the Historian only sees decisions, and the Facilitator's slices depend on
which mode it is operating in.

All references use typed prefixes (DDR-025). The context manager resolves
these to file contents within the token budget.

### Designer

**DAG node:** DESIGN
**DDR reference:** DDR-019 (Designer owns requirements + architecture)

The Designer has the broadest input context. It reads all discovery documents,
the intent, prior architecture (if revising), and recent decisions. This
ensures architecture decisions are grounded in project context.

| Slice | Mode | Budget | Notes |
|-------|------|--------|-------|
| `doc:product-brief` | `full` | 300 | What is being built and why |
| `doc:success-definition` | `full` | 200 | Measurable success criteria |
| `doc:constraints` | `full` | 200 | Technical and business constraints |
| `doc:stakeholders` | `summary_only` | 100 | Who the system serves |
| `doc:system-description` | `full` | 300 | System shape, boundaries, data flows |
| `doc:vision` | `summary_only` | 150 | Long-term direction |
| `doc:open-questions` | `full` | 100 | Unresolved questions |
| `doc:project-plan` | `summary_only` | 100 | Phase breakdown, cycle targets |
| `doc:research-findings` | `full` | 200 | Only present when EXPLORE node ran (DDR-023) |
| `doc:architecture` | `full` | 400 | Prior architecture — present on revision, absent on first design |
| `doc:requirements` | `full` | 300 | Prior requirements — present on revision |
| `doc:evaluation` | `last_cycle` | 150 | Prior evaluation for context |
| `doc:decisions` | `last_n_entries: 3` | 100 | Recent decisions |
| `agent.md` | `full` | 200 | Project conventions and constraints |

**Total budget:** ~2,500 tokens (uses elevated budget — Designer's context is
the broadest of any role)

**On first design (no prior artifacts):** `doc:architecture`, `doc:requirements`,
`doc:evaluation`, and `doc:decisions` are absent. Budget is redistributed to
discovery docs.

**On structural failure escalation (DEBUG → DESIGN):** The Designer additionally
receives `doc:debug-diagnosis` (full, ~200 tokens) injected before the task
component.

### Explorer

**DAG node:** EXPLORE (conditional, user-initiated only)
**DDR reference:** DDR-023 (user-initiated, tagged `explore:user-guided`)

The Explorer investigates unknowns flagged by the user. It reads the system
description, open questions, and constraints to focus its research.

| Slice | Mode | Budget | Notes |
|-------|------|--------|-------|
| `doc:system-description` | `full` | 300 | System boundaries and components |
| `doc:open-questions` | `full` | 150 | Questions to investigate |
| `doc:constraints` | `full` | 200 | Technical constraints to respect |
| `doc:evaluation` | `last_cycle` | 150 | Prior evaluation for context |
| Intent | `full` | 100 | Current goal — provides focus for research |
| `agent.md` | `full` | 200 | Project conventions |

**Total budget:** ~1,100 tokens

The Explorer's output (`doc:research-findings`) is tagged `explore:user-guided`.
It is injected into the Designer's context when EXPLORE completes before DESIGN.

### Planner

**DAG node:** PLAN
**DDR reference:** DDR-019 (Planner reads Designer output, produces plan + test-plan)

The Planner reads the Designer's architecture and requirements. It does not
write requirements — the Designer owns those (DDR-019).

| Slice | Mode | Budget | Notes |
|-------|------|--------|-------|
| `doc:requirements` | `full` | 400 | Never truncated |
| `doc:architecture` | `full` | 400 | Never truncated |
| `doc:decisions` | `last_n_entries: 3` | 100 | Recent decisions |
| `doc:evaluation` | `last_cycle` | 150 | Prior evaluation for context |
| `doc:critique-report` | `full` | 200 | Only present at `deep`/`research` depth after CRITIQUE. Project-scoped persistent design review. |
| `doc:cycle-critique` | `full` | 200 | Per-cycle critique fed back to Designer. Run-scoped — ephemeral across cycles. Present whenever CRITIQUE ran. |
| `doc:debug-diagnosis` | `full` | 200 | Only present on retry — Debugger's root-cause analysis. Ephemeral — bypasses standard disk resolution, injected by daemon directly into assembled context. |

**Total budget:** ~1,450 tokens (base) + ~400 (failure context on retry)

**On retry (iteration > 1):** Artifact slices narrow. The Planner receives
slices only for artifacts relevant to failed categories:

```
narrowSlicesForRetry(sliceKeys, failureReport):
  always = ['doc:requirements', 'doc:architecture']
  failedCategoryArtifacts = failureReport.failed_categories
    .flatMap(c => getArtifactsForCategory(c.name, map))
  return unique([...always, ...failedCategoryArtifacts])
```

If security failed but correctness passed, the Planner does not receive
`doc:test-plan` sections about correctness tests — only security-relevant
sections.

### Tester

**DAG node:** TEST
**DDR reference:** G22 (TDD separation — Tester never sees architecture or implementation)

The Tester has the most constrained context. It reads only requirements and
the test plan — never architecture, implementation source, or Builder output.
This enforces TDD separation: tests are derived from what the system should do,
not how it is implemented.

| Slice | Mode | Budget | Notes |
|-------|------|--------|-------|
| `doc:requirements` | `full` | 600 | The sole source of truth for what to test |
| `doc:test-plan` | `full` | 400 | Test coverage plan per category |

**Total budget:** ~1,000 tokens

**Explicitly excluded:**
- `doc:architecture` — Tester must not know implementation details
- `doc:plan` — step-level implementation plans are irrelevant to testing
- `doc:research-findings` — research context is not needed for test derivation
- `source_files` — implementation code must not influence test design
- `doc:evaluation` — prior evaluations should not bias test design

**On retry:** The Tester receives the same slices — requirements and test-plan.
If the Planner revised the test-plan for failed categories, the Tester sees
the updated plan. The Tester is always regenerated from scratch on each
iteration, not patched.

### Builder

**DAG node:** BUILD

The Builder reads requirements, architecture, and the test plan. It also sees
the Tester's test scripts as contracts to satisfy — but never the Tester's
internal reasoning.

| Slice | Mode | Budget | Notes |
|-------|------|--------|-------|
| `doc:requirements` | `full` | 400 | Never truncated |
| `doc:architecture` | `full` | 400 | Never truncated |
| `doc:test-plan`              | `full` | 300 | Test coverage specification |
| `doc:plan`                   | `full` | 200 | Step-level plan (deep+ only) |
| `doc:build-plan`             | `full` | 400 | Implementation expansion (deep+ only) |
| `doc:test-script:{category}` | `full` | 300 | Test contracts — one per active category |
| `source_files`               | `full` | 600 | Implementation files from `repo.key_files` (reduced from 800 to fit deep+ artifacts) |

**Total budget:** ~2,200 tokens

The `source_files` slice is loaded after document slices. If the document slice
budget is exceeded, source files are skipped. If source files exceed 800 tokens,
oldest files are truncated first.

The Builder never sees the Tester's internal reasoning — only the final test
scripts as executable contracts.

### Debugger

**DAG node:** DEBUG (conditional — only on VALIDATION gate failure)

The Debugger reads run artifacts from the failed validation run. Its context
is narrowly focused on what failed and why.

| Slice | Mode | Budget | Notes |
|-------|------|--------|-------|
| `.sle/runs/{id}/manifest.json` | `full` | 100 | Run entrypoint — what ran, when, overall status |
| `.sle/runs/{id}/ai/context-pack.md` | `full` | 600 | Narrative summary of failed categories |
| `.sle/runs/{id}/tests/{category}/result.json` | `full` | 200 | Per-category results for failed categories only |
| `.sle/runs/{id}/metrics/{category}.json` | `full` | 200 | Quantitative metrics for failed categories |
| `.sle/runs/{id}/traces/{category}.jsonl` | `last_n_entries: 20` | 200 | Recent trace spans for hot-path identification |
| `doc:architecture` | `full` | 400 | Architecture context for understanding failure |

**Total budget:** ~1,700 tokens

The Debugger does NOT receive:
- `doc:requirements` — it diagnoses technical root causes, not requirement gaps
- `doc:test-plan` — test coverage is not relevant to debugging
- Passing category artifacts — only failed categories are loaded

The `{id}` in paths is the current run ID from the failure report. The
Debugger operates on a single run — it does not compare across runs.

### Evaluator

**DAG node:** EVALUATE

The Evaluator reads requirements, test-plan, prior evaluation, and current run
artifacts to produce a structured verdict on whether the implementation
satisfied the intent.

| Slice | Mode | Budget | Notes |
|-------|------|--------|-------|
| `doc:requirements` | `full` | 400 | What was supposed to be built |
| `doc:test-plan` | `full` | 300 | What coverage was planned |
| `doc:evaluation` | `last_cycle` | 150 | Prior evaluation for continuity |
| `.sle/runs/{id}/ai/context-pack.md` | `full` | 400 | Current run results narrative |
| `.sle/runs/{id}/manifest.json`              | `full`        | 100 | Run metadata |
| `doc:build-plan`                            | `summary_only`| 100 | Implementation expansion (deep+ only, summary only) |

**Total budget:** ~1,350 tokens

### Critic

**DAG node:** CRITIQUE (conditional — only at `deep`/`research` depth)
**DDR reference:** DDR-022 (Critic reviews at DESIGN node, not PLAN node)

The Critic reviews the Designer's architecture and requirements before the
Planner runs. It identifies blocking issues, warnings, and suggestions.

| Slice | Mode | Budget | Notes |
|-------|------|--------|-------|
| `doc:architecture` | `full` | 500 | Primary review target |
| `doc:requirements` | `full` | 400 | Secondary review target |
| `doc:evaluation` | `last_cycle` | 150 | Prior evaluation — avoids repeating known issues |
| `doc:constraints` | `full` | 200 | Compliance checks against stated constraints |
| `doc:system-description` | `full` | 200 | System shape for structural consistency checks |
| `doc:decisions` | `last_n_entries: 3` | 100 | Recent decisions for context |
| `doc:cycle-critique` | write | — | Per-cycle critique fed back to Designer |
| `doc:critique-report` | write | — | Persistent design review (deep/research only) |

**Total budget:** ~1,550 tokens

The Critic does NOT receive:
- `doc:plan` — it reviews architecture, not step-level plans (DDR-022)
- `doc:test-plan` — test coverage is not its concern
- Discovery documents (except `doc:system-description` and `doc:constraints`)
- Run artifacts — it runs before BUILD, so no run artifacts exist yet

### Historian

**DAG node:** HISTORY

The Historian has the most constrained input context. It reads only the full
decisions log — it is the append target.

| Slice | Mode | Budget | Notes |
|-------|------|--------|-------|
| `doc:decisions` | `full` | 1000 | Full file — append target. No truncation. |

**Total budget:** ~1,000 tokens

The Historian does not read requirements, architecture, test plans, or any
other artifact. It produces short audit entries based on the task instruction,
which the DAG runner populates with a summary of what just happened (which
agent ran, what it produced, whether it was a retry).

### Facilitator

**DAG node:** No single node — operates across sessions.
**DDR reference:** DDR-020 (orthogonal chat layer), Facilitator has two modes.

The Facilitator is unique: it has two operating modes with different context
assemblies. The mode is determined by the system state and cycle flags, not by
a DAG node.

#### Chat mode

**When:** `chat.session_open = true` AND no `awaiting_*` flag is set.

The Facilitator answers freeform questions about the project using broad
project and cycle context.

| Slice | Mode | Budget | Notes |
|-------|------|--------|-------|
| `doc:product-brief` | `summary_only` | 150 | Project overview |
| `doc:system-description` | `full` | 300 | System shape |
| `doc:vision` | `summary_only` | 100 | Direction |
| `doc:open-questions` | `full` | 100 | Known unknowns |
| `doc:project-plan` | `summary_only` | 100 | Current phase |
| `.sle/chat-history.jsonl` | `last_n_entries: 20` | 400 | Recent chat messages for continuity |
| `agent.md` | `full` | 200 | Project conventions |

**Total budget:** ~1,350 tokens

#### Decision mode

**When:** `awaiting_confirmation = true` OR `awaiting_sharding_approval = true`.

The Facilitator presents a pending action and relevant artifacts for the user
to review. Context is narrowly focused on the decision at hand.

| Slice | Mode | Budget | Notes |
|-------|------|--------|-------|
| `doc:plan` | `full` | 400 | Plan steps to approve |
| `doc:test-plan` | `full` | 300 | Test coverage to review |
| `doc:test-script:{category}` | `summary_only` | 200 | Test script summaries (not full scripts) |
| `.sle/chat-history.jsonl` | `last_n_entries: 5` | 100 | Minimal chat context |

**Total budget:** ~1,000 tokens

**Excluded:** `doc:build-plan` — Facilitator never shows implementation expansion at CONFIRM.

**Additional context when `awaiting_sharding_approval = true`:**

| Slice | Mode | Budget | Notes |
|-------|------|--------|-------|
| `.sle/sharding-proposal.yaml` | `full` | 300 | Proposed task boundaries |
| `.sle/coherence-report.json` | `summary_only` | 100 | Coherence gate status |

**Modes can coexist.** When `chat.session_open = true` AND an `awaiting_*`
flag is set, the Facilitator operates in both modes simultaneously. Chat-mode
context is used for freeform Q&A; decision-mode context is used when the user
engages with the pending action. The context manager produces two separate
assemblies — one per mode — and the Facilitator switches between them based
on the user's input.

---

## Token budgets and truncation strategy

### Budget allocation

| Component | Default | Configurable via | Notes |
|-----------|---------|-------------------|-------|
| System prompt | 500 | `planning.system_prompt_max_tokens` | Role description + rules |
| Artifact slices | 2000 | `planning.artifact_slice_size` | Role-dependent content |
| State summary | 300 | `planning.summary_max_tokens` | Cycle metadata |
| Task | 200 | — | Fixed per DAG node |
| Failure context | 400 | — | Only on retry |
| **Total target** | **3400** | — | |
| **Hard ceiling** | **4000** | Not configurable | Safety margin for estimator error |

### Per-role budget overrides

Some roles require more or less than the default 2,000-token artifact slice
budget. Overrides are applied automatically based on role:

| Role | Override | Reason |
|------|----------|--------|
| Designer | 2,500 | Broadest input context (discovery docs + architecture) |
| Builder | 2,800 (deep+) | Source files + plan + build-plan injection. ~2,200 at standard/minimal. |
| Tester | 1,000 | Most constrained — only requirements + test-plan |
| Historian | 1,000 | Only reads decisions log |
| Facilitator (chat) | 1,350 | Moderate context for Q&A |
| Facilitator (decision) | 1,000 | Narrow focus on pending action |

All other roles use the default 2,000-token budget.

### Truncation algorithm

When the assembled artifact slices exceed the role's budget:

1. **Identify truncatable artifacts.** Artifacts with `never_truncate: true`
   are excluded. `doc:requirements` and `doc:architecture` are always
   `never_truncate`.

2. **Sort truncatable artifacts by priority.** Lowest priority is truncated
   first. Priority order is defined in §Component 2 — Artifact slices.

3. **Truncate from the middle.** For entry-based artifacts (decisions,
   evaluation), remove the oldest entries first. For continuous text (plan,
   research findings), truncate from the middle of the document, preserving
   the beginning (context) and end (most recent content).

4. **Stop when budget is met.** Once total tokens are within budget, stop
   truncating. Remaining artifacts are loaded in full.

5. **Record truncated artifacts.** Every truncated artifact ID is recorded in
   `AssembledContext.truncated` for auditability.

6. **Log warnings for budget overruns.** If all truncatable artifacts are
   exhausted and the budget is still exceeded, log a warning with the total
   token count and the role name. The hard ceiling (4,000 tokens) is enforced
   as a final safety check.

### Token counting

The context manager uses a lightweight token estimator for budget enforcement.
Accuracy within ~5% is sufficient for budget decisions.

```
countTokens(text) = ceil(text.length / 4)
```

The 5% margin is absorbed by the gap between the ~3,400 token target and the
4,000 token hard ceiling. For precise billing estimation, use the provider
SDK's token counter on the final assembled prompt — but not in the hot path.

---

## Iteration behavior

### Iteration 1

Full artifact slices per role. No failure context. State summary shows
iteration 1. Total window is typically 2,800–3,400 tokens.

### Iteration 2+ (retry)

Failure context replaces the token budget that would have gone to passing
category results. Only failed category context is shown.

Artifact slices narrow for the Planner and Debugger:
- The Planner receives slices only for artifacts relevant to failed categories.
- The Debugger receives only failed category run artifacts.
- Passing categories retain their `CategoryResult` from the previous iteration
  — they are cached, not re-run.

The Tester is regenerated from scratch with the same slices (requirements +
test-plan). If the Planner revised the test-plan, the Tester sees the update.

The Builder is regenerated from scratch — implementation is never patched.

### Cap iteration

On the final iteration (cap hit), the DAG runner sets a `cap_hit: true` flag
on the cycle state. The context manager does not change its assembly logic —
but the task component changes to instruct the Planner to produce a best-effort
output rather than a complete solution.

---

## Assembly modes in detail

### Declared mode

When a Beads task (or local task in `.sle/tasks.yaml`) carries a
`TaskContextDeclaration`, the context manager uses the declared artifact
references instead of the role defaults.

```typescript
interface TaskContextDeclaration {
  task_id: string
  slices: ArtifactRef[]
  intent: string
}
```

Full definition: `TaskContextDeclaration` in [../reference/types.md](../reference/types.md) §11.

In declared mode:

1. Load each `ArtifactRef` from `slices` using typed prefix resolution.
2. Load all declared refs — no inference, no role-based defaults.
3. Apply the same token budget enforcement as inferred mode.
4. Declared sections are not truncated unless they exceed the per-artifact
   `max_tokens` (if set) or the total slice budget.

Declared mode produces more precise context — the task author specifies exactly
which document sections are relevant. This is the preferred mode for sharded
tasks where each task has a narrow scope.

### Inferred mode

When no `TaskContextDeclaration` exists, the context manager falls back to
role-based defaults defined in §Context slices.

Inferred mode:

1. Look up the role's default slice set.
2. Load each artifact using the specified loading mode.
3. Apply token budget enforcement with truncation.
4. May produce less precise context than declared mode, but is always available.

### Mode selection logic

```
resolveMode(task?, role):
  if task exists AND task.context_declarations is not empty:
    return 'declared'
  else:
    return 'inferred'
```

The mode is determined per-invocation, not per-cycle. A cycle with multiple
tasks may use declared mode for some agent calls and inferred mode for others.

---

## Facilitator dual-mode assembly

The Facilitator's context assembly is more complex than other roles because it
operates in two modes that can coexist (DDR-020).

### Mode determination

```
resolveFacilitatorMode(chatState, cycleFlags):
  modes = []
  if chatState.session_open:
    modes.push('chat')
  if cycleFlags.awaiting_confirmation OR cycleFlags.awaiting_sharding_approval:
    modes.push('decision')
  return modes
```

### Assembly when both modes are active

When both modes are active, the context manager produces two separate
`AssembledContext` instances:

1. **Chat context** — uses chat-mode slices (project context + chat history).
2. **Decision context** — uses decision-mode slices (pending action + relevant artifacts).

The Facilitator agent receives the chat context by default. When the user's
input matches a decision action (approve, reject, modify, halt), the
Facilitator switches to the decision context for that turn.

This dual-assembly is unique to the Facilitator. All other roles produce a
single `AssembledContext` per invocation.

### Chat history management

The `.sle/chat-history.jsonl` slice uses `last_n_entries` mode to limit context.
The default is 20 entries for chat mode and 5 entries for decision mode. This
ensures the Facilitator has conversational continuity without consuming the
entire budget on history.

---

## API contract

### Assemble context

```
POST /api/v2/context/assemble

Request:
{
  "role":               AgentRole,
  "cycle_state":        CycleState,
  "task_id":            string | null,
  "facilitator_mode":   "chat" | "decision" | null
}

Response 200:
{
  "context":            AssembledContext,
  "assembly_mode":      ContextAssemblyMode,
  "role_budget":        number,
  "warnings":           string[]
}

Response 400:
{
  "error":  "invalid_role",
  "role":   string,
  "valid":  AgentRole[]
}

Response 404:
{
  "error":    "artifact_not_found",
  "artifact": string,
  "role":     AgentRole,
  "reason":   "Required artifact does not exist and role demands it."
}
```

### Get slice config

```
GET /api/v2/context/slices/{role}

Response 200:
{
  "role":           AgentRole,
  "slices":         SliceRule[],
  "budget":         number,
  "mode":           "declared" | "inferred",
  "never_truncate": string[]
}

Response 400:
{
  "error": "invalid_role",
  "role":  string
}
```

### Resolve artifact reference

```
GET /api/v2/context/resolve?ref={ArtifactRef}

Response 200:
{
  "ref":      ArtifactRef,
  "path":     string,
  "scope":    ArtifactScope,
  "exists":   boolean,
  "tokens":   number
}

Response 400:
{
  "error":  "invalid_ref",
  "ref":    string,
  "reason": "Artifact reference must match doc:{key} or node:{group}:{key}."
}
```

---

## Error cases

| Error | Condition | Response |
|-------|-----------|----------|
| `artifact_not_found` | Required artifact (`required: true` in artifacts.yaml) missing from disk | Halt cycle — unrecoverable. Log artifact ID and role. |
| `artifact_empty` | Artifact exists but is empty (0 bytes) | Log warning, skip slice. If required, halt cycle. |
| `budget_exceeded` | Total tokens exceed hard ceiling after all truncation | Log warning with total and role. Proceed with truncated context — do not halt. |
| `invalid_ref` | Artifact reference does not match `doc:{key}` or `node:{group}:{key}` format | Skip the reference. Log warning. |
| `group_not_found` | `node:{group}:{key}` references a group that does not exist in the project graph | Skip the reference. Log warning. |
| `chat_history_corrupt` | `.sle/chat-history.jsonl` contains unparseable lines | Skip corrupt lines. Log warning with line number. |
| `run_artifact_missing` | Debugger context references a run artifact that does not exist | Load what is available. Log warning with missing paths. |
| `declared_ref_unresolved` | TaskContextDeclaration references an artifact that does not exist | Fall back to inferred mode for that role. Log warning. |
| `source_slice_no_files` | Builder's `source_files` resolution finds no matching files | Skip source slice. Builder works from documents only. |

---

## Constraints

1. **No raw conversation history.** No agent ever receives raw conversation
   history. The Facilitator receives structured chat-history entries, which is
   the exception — but these are short, recent entries, not full transcripts.

2. **No full artifact store loading.** The context manager never loads the
   complete artifact store into any single context window. It loads only the
   slices assigned to the requesting role.

3. **Pure computation.** The context manager makes no LLM calls. It is fast,
   deterministic, and cheap. All logic is rule-based.

4. **No writes.** The context manager does not write to any artifact, to
   `map.yaml`, or to any other file. It is read-only.

5. **No cross-agent sharing.** Each agent call receives an independent
   `AssembledContext`. Concurrent agent calls do not share assembled state.

6. **Requirements and architecture never truncated.** `doc:requirements` and
   `doc:architecture` have `never_truncate: true` for all roles that receive
   them. If these alone exceed the budget, the ceiling is raised.

7. **TDD separation enforced.** The Tester's slice set is hardcoded to
   `doc:requirements` and `doc:test-plan` only. The context manager must
   reject any configuration that adds `doc:architecture`, implementation source,
   or Builder output to the Tester's slice.

8. **Artifact reference format.** All slice references use typed prefixes:
   `doc:{key}` or `node:{group}:{key}` (DDR-025). Unprefixed references are
   treated as `doc:{key}` for backward compatibility.

9. **Budget ceiling is hard.** The 4,000-token ceiling is never exceeded.
   If all truncation options are exhausted and the total still exceeds 4,000,
   the context manager truncates `never_truncate` artifacts as a last resort
   and logs a critical warning.

10. **Category caching respected.** On retry, the context manager does not
    include passing category results in any agent's context. Passing categories
    are cached at the gate level.

11. **Designer ownership respected.** Only the Designer's slice includes
    discovery documents. The Planner reads Designer output (`doc:requirements`,
    `doc:architecture`) but does not read discovery docs directly (DDR-019).

12. **Critic placement respected.** The Critic's slice includes architecture
    and requirements but not plan or test-plan (DDR-022). The Critic reviews
    at DESIGN, not PLAN.

13. **Explorer trigger respected.** Explorer context is only assembled when
    the user explicitly flags exploration. `planning.depth` does not trigger
    Explorer context assembly (DDR-023).

14. **Facilitator mode exclusivity.** Each Facilitator assembly produces
    exactly one `AssembledContext` per mode. If both modes are active, two
    separate assemblies are produced — they are never merged.

---

## Open questions

| ID | Question | Impact | Status |
|----|----------|--------|--------|
| CM-001 | Should the Designer's elevated budget (2,500 tokens) scale with discovery document count, or is a fixed cap sufficient? | Budget accuracy, context quality for large projects | Open |
| CM-002 | Should the Debugger receive `doc:requirements` in addition to run artifacts, or is architecture sufficient for root-cause diagnosis? | Debugger context breadth vs. focus | Open |
| CM-003 | Should declared mode support per-section loading (e.g., `doc:architecture#security-layer`) or only per-document loading? | Precision of declared context, implementation complexity | Open |
| CM-004 | What is the optimal number of chat-history entries for Facilitator chat mode? 20 may be too many for short sessions and too few for long ones. | Facilitator context quality, token budget | Open |
| CM-005 | Should the context manager cache assembled contexts within a cycle (same role, same iteration) to avoid re-reading artifacts from disk? | Performance, disk I/O | Open |
| CM-006 | Should the `summary_only` loading mode produce summaries via LLM (costly, high quality) or extract first N lines (cheap, approximate)? | Summary quality, token budget, cost | Open |
| CM-007 | Should the token estimator be replaced with a proper tokenizer (e.g., tiktoken) in production, or is the 5% approximation sufficient? | Billing accuracy, performance | Open |
| CM-008 | How should the context manager handle group-level artifacts (`node:{group}:{key}`) when multiple groups are affected by the same cycle? | Multi-group context assembly, budget scaling | Open |
