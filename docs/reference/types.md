# Types

**Type:** reference · **Status:** draft · **Updated:** 2026-04-22

Authoritative TypeScript type reference for the SLE system. When types conflict
with inline examples in other documents, this file wins.

> **DDR changes.** Types marked with ⚡ differ from the original vision docs
> (SLE-001, SLE-024) due to Phase 0 architecture decisions. The ADR is noted
> inline and summarised at the end.

---

## 1 — Enumerations & Primitives

Foundational discriminated values shared across all layers.

```typescript
export type ProjectType = 'api' | 'ui' | 'library' | 'research' | 'custom'
```
Kind of project being managed.

```typescript
export type PlanningDepth = 'minimal' | 'standard' | 'deep' | 'research'
```
Controls reasoning passes, Critic activation, and artifact slice size.

```typescript
export type SystemStatus = 'idle' | 'discovering'
```
⚡ **DDR-020, DDR-021, DDR-031.** `chatting` removed (orthogonal session layer); `confirming` removed (flag on a run record). `cycling`/`halted`/`complete` removed: under concurrent workflow runs there is no single project-wide "running" state. Per-run progress lives entirely on `WorkflowRun.status` (§4). `SystemStatus` now describes only the discovery lifecycle; clients derive "is any work in progress" from `active_workflow_run_count` (§4), not from `meta.status`.

```typescript
export type WorkflowRunStatus = 'active' | 'halted' | 'complete'
```
⚡ **DDR-031.** Replaces `CycleOutcome`. Scoped to a single `WorkflowRun`, not the system. `awaiting_*` is no longer a separate axis — see `WorkflowRun.awaiting_checkpoint` (§4).

```typescript
export type DiscoveryStatus = 'not_started' | 'in_progress' | 'complete'
```
Whether a discovery session has been run for this project.

```typescript
export type AgentRole =
  | 'designer' | 'explorer' | 'planner' | 'tester' | 'builder'
  | 'debugger' | 'evaluator' | 'critic' | 'historian' | 'facilitator'
```
⚡ **DDR-019.** Expanded from 6 to 10 roles. Added `designer`, `explorer`, `tester`, `debugger`. See SLE-024 §4 for responsibilities.

```typescript
export type GeneratorRole = AgentRole | 'discovery'
```
Agent roles plus the `discovery` pseudo-role for artifacts generated during discovery.

```typescript
export type ValidationMethod = 'llm' | 'executable' | 'both'
```
How a validation category is checked.

```typescript
export type CategoryStatus = 'passed' | 'failed' | 'pending' | 'skipped'
```
Current status of a validation category.

```typescript
export type CapBehavior = 'halt_with_report' | 'user_prompt' | 'force_pass'
```
What happens when the iteration cap is hit.

```typescript
export type ErrorBehavior = 'halt' | 'retry_once' | 'notify_and_wait'
```
What happens on an unrecoverable error.

```typescript
export type TimeoutAction = 'auto_approve' | 'halt' | 'notify_and_wait'
```
What happens when user approval times out.

```typescript
export type SummaryFormat = 'markdown' | 'html' | 'json'
```
Output format for the user-facing workflow-run summary.

```typescript
export type TestCommandFormat = 'shell' | 'npm_script' | 'makefile'
```
How test commands are presented in the summary.

```typescript
export type ArtifactFormat = 'markdown' | 'json' | 'yaml'
```
Format of a generated artifact file.

```typescript
export type OutputType = 'executable' | 'html' | 'markdown'
```
Kind of generated output.

```typescript
export type GeneratedAt = 'gate_pass' | 'run_end' | 'always'
```
When a generated output is produced.

```typescript
export type LLMProvider = 'openai_compatible' | 'anthropic'
```
Supported LLM provider backends.

```typescript
export type ArtifactScope = 'project' | 'group' | 'run' | 'ephemeral'
```
⚡ **DDR-025.** Artifact resolution scope. `run` artifacts live under `.sle/runs/{id}/`; `ephemeral` artifacts are in-memory daemon state, never persisted to disk.

```typescript
export type ArtifactRef = `doc:${string}` | `node:${string}:${string}`
```
⚡ **DDR-025.** Typed prefix for artifact slice references. `doc:{key}` for project documents, `node:{group}:{key}` for group-level nodes.

```typescript
export type ContextAssemblyMode = 'declared' | 'inferred'
```
How the context manager assembles slices. `declared` uses Beads task declarations; `inferred` uses role-based defaults.

```typescript
export type SourceWeight = 'user_defined' | 'workflow_run_produced' | 'inferred'
```
Priority order for context truncation: `user_defined` truncated last, `inferred` truncated first. DDR-028 SC-005. ⚡ **DDR-031.** Was `cycle_produced`.

```typescript
export type TagPrefix = 'next-run' | 'scope' | 'area'
```
DDR-028. Extensible tag prefix for the node tagging system. `#next-run` marks nodes as priority for the upcoming workflow run. `#scope:{draft-id}` links to a scope draft. `#area:{name}` for categorization. ⚡ **DDR-031.** Was `next-cycle`.

```typescript
export interface NodeTag {
  prefix: TagPrefix
  value?: string
  source: 'user' | 'facilitator' | 'system'
  applied_at: string
}
```
DDR-028. Tag applied to nodes, layers, or groups. Tags are applied by users, the Facilitator, or the system and tracked per node.

```typescript
export type VersionBump = 'major' | 'minor' | 'patch'
```
Semver bump type for a workflow run's terminal commit. DDR-028 SC-014.

```typescript
export type SubPhase = 'static-check' | 'llm-check' | 'exec-check'
```
Validation sub-phase identifiers. Execution order is fixed: `static-check` → `llm-check` → `exec-check`.

```typescript
export type OpenQuestionBlocking = `phase:${number}` | 'not_blocking'
```
Whether an open question blocks a specific discovery phase.

---

## 2 — System State

```typescript
export interface ChatState {
  session_open: boolean
  session_id?: string
  started_at?: string
}
```
⚡ **DDR-020.** Chat is tracked as an orthogonal session layer, not a system state.

⚡ **DDR-021, DDR-026, DDR-028, DDR-031.** The fixed 3-flag set (`awaiting_scoping` / `awaiting_confirmation` / `awaiting_sharding_approval`) is removed. Any workflow can declare any number of checkpoint steps, so a fixed enum of flag names no longer fits. Replaced by `WorkflowRun.awaiting_checkpoint: string | null` (§4) — a single nullable pointer to the id of the step currently paused. This preserves the old exclusivity rule (at most one pause point active at a time) by construction rather than by convention.

---

## 3 — Agent Roles

### 3.1 — Role configuration

```typescript
export interface AgentLLMConfig {
  provider: LLMProvider
  base_url?: string
  api_key_env: string
  model: string
}
```
LLM provider settings for a single agent role.

```typescript
export interface AgentRoleConfig {
  active: boolean
  step_id: string | null
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
  trigger_step_id?: string
}
```
Configuration for one agent role in `agents.yaml`.

```typescript
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
Top-level agents configuration. No duplicate roles; `planner` is required.

### 3.2 — Role input/output

```typescript
export interface AgentInput {
  role: AgentRole
  context: AssembledContext
  instruction: string
}
```
Input to a single agent invocation.

```typescript
export interface AgentResult {
  role: AgentRole
  output: unknown
  tokens_used: number
  duration_ms: number
}
```
Output from a single agent invocation.

### 3.3 — Artifact ownership ⚡ DDR-019

| Role | Reads | Writes |
|------|-------|--------|
| Designer | Discovery docs + intent + prior architecture + decisions | `architecture.md`, `requirements.md` |
| Explorer | Intent + discovery docs + prior evaluation | Research findings, spike results |
| Planner | `architecture.md` + `requirements.md` + decisions (last 3) + evaluation | `test-plan.md`, `plan.md`, `build-plan.md` (deep/research only) |
| Tester | `requirements.md` + `test-plan.md` | Executable test scripts |
| Builder | `requirements.md` + `architecture.md` + `test-plan.md` + `plan.md` (deep+) + `build-plan.md` (deep+) | Implementation + instrumented test scripts |
| Debugger | Run artifacts + failed category slices | Root-cause diagnosis |
| Evaluator | `requirements.md` + `evaluation.md` + `test-plan.md` + run artifacts | Structured verdict |
| Critic | `architecture.md` + `evaluation.md` | Blocking issues / warnings |
| Historian | `decisions.md` (full, append target) | Audit entry |
| Facilitator | Project context + workflow-run context (mode-dependent) | Triggers: Decision captures (written by Historian) |

---

## 4 — Workflow execution

⚡ **DDR-031.** This section replaces the old "DAG & Cycle" section. The fixed
15-value `DAGNode` enum and the singular `CycleState` record are gone — see
[workflow-execution.md](../specs/workflow-execution.md) for the full model and
[step-kind-reference.md](../specs/step-kind-reference.md) for the per-kind
behavior reference. `full-build` (the old fixed DAG) and `draft-artifact` are
now `WorkflowDefinition`s built on the six `StepKind` values below, not
hard-coded pipeline stages.

```typescript
export type StepKind = 'gather' | 'produce' | 'review' | 'checkpoint' | 'execute' | 'commit'
```
⚡ **DDR-031.** Replaces `DAGNode`. `gather` assembles context (no artifact produced). `produce` is LLM-driven artifact generation. `review` is pass/fail evaluation, deterministic where possible, and declares an `on_fail` route. `checkpoint` pauses for human input. `execute` runs code/tests, non-LLM. `commit` writes + version-bumps + releases a claim, with an optional decision-log append (`logs_decision`) — this folds in the old HISTORY node's behavior rather than keeping it as a separate stage. The old DEBUG node is not a 7th kind either: it is any `review` step's `on_fail: { action: 'produce', target_step_id }` failure path.

```typescript
export interface WorkflowStep {
  id: string
  kind: StepKind
  agent_role?: AgentRole
  prompt_template?: string
  input_context: ArtifactRef[]
  output_artifact?: ArtifactOutputSpec
  on_fail?: { action: 'halt' | 'produce'; target_step_id?: string }
  logs_decision?: boolean
}
```
⚡ **DDR-031.** One step in a `WorkflowDefinition`. `agent_role` is required for `gather`/`produce`/`review`, absent for `checkpoint`/`execute`-only/`commit`-only steps. `on_fail` is meaningful only on `review` steps. `logs_decision` is meaningful only on `commit` steps.

```typescript
export interface ArtifactOutputSpec {
  ref_pattern: string
  scope: ArtifactScope
}
```
⚡ **DDR-031.** What a step writes and where — e.g. `node:{group}:architecture` at `scope: 'group'`, or `doc:cycle-charter` at `scope: 'run'`.

```typescript
export interface WorkflowDefinition {
  id: string
  version: number
  trigger: { description: string; examples?: string[] }
  steps: WorkflowStep[]
  checkpoints: string[]
  output_contract: { artifacts: ArtifactOutputSpec[] }
  created_by: 'builtin' | 'user'
  created_at: string
}
```
⚡ **DDR-031.** A skill-style document describing one composable unit of work. `trigger.description` is matched against free-form chat by the workflow-select router (see conversation.md). `checkpoints` is the subset of `steps[].id` where `kind === 'checkpoint'`. Stored per-project at `.sle/workflows/{id}.md` (front-matter mirrors this shape; per-step instruction bodies live in the markdown body — see workflow-authoring.md). `full-build` and `draft-artifact` are `created_by: 'builtin'` and their ids are reserved.

```typescript
export interface WorkflowRun {
  run_id: string
  workflow_id: string
  target: { group?: string; layer?: string; node_key?: string }
  status: WorkflowRunStatus
  current_step_id: string
  iteration: number
  revision: number
  awaiting_checkpoint: string | null
  claimed_artifacts: ArtifactClaim[]
  started_at: string
  updated_at: string
}
```
⚡ **DDR-031.** Replaces `CycleState`. One instance of a `WorkflowDefinition` executing against a specific target. Multiple `WorkflowRun`s may be `active` simultaneously, each tracked independently — there is no project-wide singular run record. `run_id` format: `{workflow_id}-{run_seq}-i{iteration}-{ISO8601}`, where `run_seq` is a per-`workflow_id` monotonic counter (replaces the old `c{cycle}-i{iteration}-{ISO8601}`, which depended on a single global cycle counter that no longer exists under concurrency).

```typescript
export interface ArtifactClaim {
  artifact_ref: ArtifactRef
  claimed_by_run_id: string
  claimed_at: string
  artifact_version_at_claim: number
}
```
⚡ **DDR-031.** Generalizes the `concurrent_modification` optimistic-concurrency pattern (intake-and-sharding.md) and the Beads atomic task claim (beads-integration.md) from "tasks only" to "any artifact a workflow run is about to write." Stored at `.sle/claims/{artifact-ref-slug}.json`, one file per claimed artifact, deleted on release. A claim attempt that conflicts with another active run's claim is rejected immediately (`claim_conflict`) — not retried with backoff, unlike `concurrent_modification`'s transient-race retry, because a claim is held for an entire step's duration and represents real contention, not a brief read/write race.

```typescript
export interface ArtifactVersion {
  artifact_ref: ArtifactRef
  version: number
  committed_by_run_id: string | null
  committed_at: string | null
}
```
⚡ **DDR-031.** Version numbers live on the artifact's own metadata (front-matter `version:` for docs, a sibling `.meta.json` for node content) — this type describes that metadata's shape, it is not a separate store. A commit step verifies `artifact.version === claim.artifact_version_at_claim` before writing; mismatch (should not occur under the dispatch-time-rejection model above except via a bug or manual edit) is the distinct error `stale_claim_commit`, which halts the run without auto-retry.

```typescript
export interface VersionSnapshot {
  version_id: string
  workflow_run_id: string
  iteration: number
  revision: number
  locked_at: string
  artifact_hashes: Record<string, string>
  category_results: CategoryResult[]
  outcome: 'completed' | 'halted'
  version_bump: VersionBump
  deployable: boolean
  changed_artifacts: string[]
}
```
DDR-028 SC-014. Immutable snapshot produced by a workflow run's terminal `commit` step, stored in `.sle/versions/{version_id}/`. `artifact_hashes` maps artifact keys to content hashes for provenance. `deployable` is `true` only when `outcome === 'completed'` and all categories pass. ⚡ **DDR-031.** `cycle` → `workflow_run_id`, `changed_nodes` → `changed_artifacts`.

---

## 5 — Artifacts

### 5.1 — Rule definitions

```typescript
export interface ArtifactRule {
  id: string
  path?: string
  generator: GeneratorRole
  required: boolean
  append_only: boolean
  format: ArtifactFormat
}
```
Artifact declaration in `artifacts.yaml`. Ephemeral artifacts omit `path` — resolved from in-memory daemon state, not disk.

```typescript
export interface GeneratedOutputRule {
  id: string
  path: string
  type: OutputType
  generated_at: GeneratedAt
}
```
Generated output declaration in `artifacts.yaml`.

```typescript
export interface ArtifactsConfig {
  artifacts: ArtifactRule[]
  generated_outputs: GeneratedOutputRule[]
}
```
Top-level artifacts configuration.

### 5.2 — Runtime entries (map.yaml)

```typescript
export interface ArtifactEntry {
  path: string
  generator: GeneratorRole
  required: boolean
  append_only?: boolean
  scope?: ArtifactScope
  source_weight?: SourceWeight
  version_produced?: string
  last_updated: string
  dirty: boolean
}
```
⚡ **DDR-025, DDR-028.** Added optional `scope` field. `source_weight` added for context truncation priority (DDR-028 SC-005). `version_produced` added for provenance tracking (DDR-028 SC-014, post-MVP).

```typescript
export interface GeneratedOutput {
  path: string
  type: OutputType
}
```
Tracked generated output in `map.yaml`.

---

## 6 — Validation

### 6.1 — Configuration

```typescript
export interface ValidationRuleCategory {
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
A single validation category definition in `validation.yaml`.

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

```typescript
export interface StaticAnalysisResult {
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

```typescript
export interface ContainerConfig {
  base_image: string
  install_command: string
  timeout_ms: number
}
```

```typescript
export interface ValidationConfig {
  static_analysis: StaticAnalysisConfig
  container: ContainerConfig
  categories: ValidationRuleCategory[]
}
```
Top-level validation configuration.

### 6.2 — Runtime results

```typescript
export interface CategoryResult {
  name: string
  method: ValidationMethod
  llm?: {
    verdict: 'pass' | 'fail'
    confidence: number
    issues: string[]
    evidence: string[]
  }
  executable?: {
    passed: boolean
    passed_cases: string[]
    failed_cases: string[]
    errors: string[]
    metrics: Record<string, number>
  }
  passed: boolean
}
```
Result from running one validation category.

```typescript
export interface GateResult {
  passed: boolean
  category_results: CategoryResult[]
  static_analysis: StaticAnalysisResult
  failed_categories: string[]
  failure_report?: FailureReport
}
```
Aggregated result from the VALIDATION gate.

```typescript
export interface FailureReport {
  iteration: number
  run_dir: string
  run_id: string
  quick_summary: string
  failed_categories: string[]
  passed_categories: string[]
}
```
Structured report injected into the next Planner iteration on gate failure.
Carries `run_dir` pointing to the run artifact directory (not inline content).
The context manager reads the run directory directly for Component 5.

### 6.3 — map.yaml tracked state

```typescript
export interface ValidationCategory {
  name: string
  method: ValidationMethod
  status: CategoryStatus
  last_run?: string
  executable?: string
  prompt_template?: string
}
```
Tracked validation category state in `map.yaml`.

```typescript
export interface ValidationGate {
  mode: 'all_must_pass'
  last_outcome: 'passed' | 'failed' | 'halted'
  failed_categories: string[]
}
```
Tracked gate state in `map.yaml`.

---

## 7 — Context Assembly

```typescript
export interface AssembledContext {
  system_prompt: string
  artifact_slices: Record<string, string>
  state_summary: string
  task: string
  failure_context?: string
  knowledge_context?: string
  token_count: number
  truncated: string[]
}
```
The assembled context window for one agent invocation. `knowledge_context` is
present only when the knowledge engine is enabled, healthy, and returns relevant
results within token budget. See knowledge-engine.md §Context enhancement.

---

## 8 — Configuration (Rule Files)

All seven YAML rule files merge into `RuntimeConfig` at daemon start.

### 8.1 — planning.yaml

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

### 8.2 — exit.yaml

```typescript
export interface ExitConfig {
  conditions: {
    all_categories_pass: boolean
    requirements_met: boolean
  }
  on_cap_hit: CapBehavior
  halt_behavior: {
    write_partial_report: boolean
    notify_user: boolean
    block_version_snapshot: boolean
    preserve_decisions: boolean
  }
  on_error: {
    behavior: ErrorBehavior
    write_error_report: boolean
    block_version_snapshot: boolean
  }
}
```

### 8.3 — user_validation.yaml

```typescript
export interface UserValidationConfig {
  approval_required: boolean
  review_at: ('after_planning' | 'after_gate_pass')[]
  prompts: Record<string, string>
  timeout_minutes: number
  on_timeout: TimeoutAction
  auto_approve_on_rerun: boolean
}
```

### 8.4 — summary.yaml

```typescript
export interface SummaryConfig {
  format: SummaryFormat
  sections: string[]
  test_command_format: TestCommandFormat
  show_confidence_scores: boolean
  show_failed_test_ids: boolean
  what_was_built_max_tokens: number
  next_steps_max_count: number
  output_path: string
}
```

### 8.5 — Composite

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
Merged configuration from all seven rule files.

---

## 9 — Init & Discovery

### 9.1 — Init

```typescript
export interface InitState {
  last_completed_step: number
  project: {
    name: string
    description: string
    description_long?: string
    type: ProjectType
  }
  remotes: {
    code: { url: string; branch: string }
    issues: { url: string; prefix: string; local_only: boolean }
    docs: { url: string; pending: boolean }
  }
  beads_initialised: boolean
  docs_cloned: boolean
  committed: boolean
}
```
Persistent state for the `sle init` wizard.

```typescript
export interface InitOptions {
  name?: string
  description?: string
  type?: ProjectType
  code_remote?: string
  issues_remote?: string
  docs_remote?: string
  prefix?: string
  no_editor?: boolean
  no_daemon?: boolean
  resume?: boolean
  reset?: boolean
  non_interactive?: boolean
}
```
CLI flags for `sle init`.

### 9.2 — Discovery

```typescript
export interface OpenQuestion {
  title: string
  status: 'open' | 'resolved'
  blocking: OpenQuestionBlocking
  owner?: string
  resolve_by?: string
  context: string
}
```
An unresolved question surfaced during discovery.

```typescript
export interface DiscoveryState {
  status: DiscoveryStatus
  completed_at?: string
  artifacts: string[]
  current_phase: number
  total_phases: number
  open_questions_count: number
  blocking_questions_count: number
}
```
Discovery session state tracked in `map.yaml`.

---

## 10 — map.yaml (RuntimeMap)

The annotated YAML schema with field descriptions is in [reference/map-yaml-schema.md](map-yaml-schema.md). Below are the supplementary types used by `RuntimeMap` but not covered elsewhere in this file.

```typescript
export interface GitRemote {
  type: 'git'
  url: string
  branch: string
}
```

```typescript
export interface DoltRemote {
  type: 'dolt'
  url: string
  local_dir: string
  bd_prefix: string
}
```

```typescript
export interface AgentMdMapRef {
  map: string
}
```

Reference to map.yaml from agent.md.

---

## 11 — Task Store ⚡ DDR-024

```typescript
export interface SLETask {
  id: string
  title: string
  description: string
  status: 'open' | 'in_progress' | 'blocked' | 'closed'
  priority: number
  dependencies: string[]
  context_declarations?: TaskContextDeclaration[]
  created_at: string
  updated_at: string
  stale?: boolean
}
```
A single task in the system, stored in Beads or local fallback.

```typescript
export interface TaskContextDeclaration {
  task_id: string
  slices: ArtifactRef[]
  intent: string
}
```
Declared context references for a task. Used in `declared` context assembly mode.

```typescript
export interface TaskStore {
  createTask(task: Omit<SLETask, 'id' | 'created_at' | 'updated_at'>): Promise<SLETask>
  getReadyTasks(): Promise<SLETask[]>
  updateStatus(id: string, status: SLETask['status']): Promise<void>
  closeTask(id: string): Promise<void>
  getStale(): Promise<SLETask[]>
  addDependency(taskId: string, dependencyTaskId: string): Promise<void>
}
```
⚡ **DDR-024.** Provider interface for task persistence. Two implementations: `BeadsTaskStore` (delegates to `bd` CLI) and `LocalTaskStore` (reads/writes `.sle/tasks.yaml`).

---

## 12 — Zod Validation Schemas

Schemas for validating all seven rule files at daemon start. Invalid config = daemon refuses to start with field path and line number.

```typescript
import { z } from 'zod'

export const PlanningDepthEnum = z.enum(['minimal', 'standard', 'deep', 'research'])
export const ValidationMethodEnum = z.enum(['llm', 'executable', 'both'])
export const AgentRoleEnum = z.enum([
  'designer', 'explorer', 'planner', 'tester', 'builder',
  'debugger', 'evaluator', 'critic', 'historian', 'facilitator',
])
export const LLMProviderEnum = z.enum(['openai_compatible', 'anthropic'])
export const CapBehaviorEnum = z.enum(['halt_with_report', 'user_prompt', 'force_pass'])
export const ErrorBehaviorEnum = z.enum(['halt', 'retry_once', 'notify_and_wait'])
export const TimeoutActionEnum = z.enum(['auto_approve', 'halt', 'notify_and_wait'])
export const SummaryFormatEnum = z.enum(['markdown', 'html', 'json'])
export const TestCommandFormatEnum = z.enum(['shell', 'npm_script', 'makefile'])
export const ArtifactFormatEnum = z.enum(['markdown', 'json', 'yaml'])
export const OutputTypeEnum = z.enum(['executable', 'html', 'markdown'])
export const GeneratedAtEnum = z.enum(['gate_pass', 'run_end', 'always'])
```

```typescript
export const PlanningSchema = z.object({
  depth: PlanningDepthEnum,
  max_iterations: z.number().int().min(1).max(50),
  artifact_slice_size: z.number().int().min(500).max(10000),
  summary_max_tokens: z.number().int().min(100).max(2000),
  system_prompt_max_tokens: z.number().int().min(100).max(2000),
  reasoning_passes: z.object({
    minimal: z.number().int().min(1),
    standard: z.number().int().min(1),
    deep: z.number().int().min(1),
    research: z.number().int().min(1),
  }),
  critic_enabled: z.boolean().nullable(),
  on_depth_change: z.enum(['re_plan', 'continue']),
})
```

```typescript
const ExecutableConfigSchema = z.object({
  runner: z.string().min(1),
  timeout_ms: z.number().int().min(1000),
  output_format: z.literal('json'),
})

const LLMConfigSchema = z.object({
  artifact_slice: z.array(z.string().min(1)).min(1),
  prompt_template: z.string().min(1),
  pass_threshold: z.number().min(0).max(1),
})

const PassCriteriaSchema = z.object({
  executable: z.union([
    z.enum(['all_pass', 'any_pass']),
    z.string().regex(/^threshold:\d+$/),
    z.record(z.string(), z.number()),
  ]).optional(),
  llm: z.string().optional(),
})

const OnFailSchema = z.object({
  feed_to: z.enum(['planner', 'evaluator']),
  include: z.array(z.string().min(1)).min(1),
})

const ValidationCategorySchema = z.object({
  name: z.string().min(1),
  method: ValidationMethodEnum,
  executable: ExecutableConfigSchema.optional(),
  llm: LLMConfigSchema.optional(),
  pass_criteria: PassCriteriaSchema,
  on_fail: OnFailSchema,
}).refine(
  (data) => {
    if (data.method === 'executable' || data.method === 'both') return data.executable !== undefined
    return true
  },
  { message: 'executable config required when method includes executable' },
).refine(
  (data) => {
    if (data.method === 'llm' || data.method === 'both') return data.llm !== undefined
    return true
  },
  { message: 'llm config required when method includes llm' },
)

const StaticAnalysisCheckSchema = z.object({
  command: z.string().min(1),
  enabled: z.boolean(),
  pass_criteria: z.record(z.string(), z.number()),
})

const StaticAnalysisConfigSchema = z.object({
  lint: StaticAnalysisCheckSchema,
  typecheck: StaticAnalysisCheckSchema,
  complexity: StaticAnalysisCheckSchema,
})

const ContainerConfigSchema = z.object({
  base_image: z.string().min(1),
  install_command: z.string().min(1),
  timeout_ms: z.number().int().min(1000),
})

export const ValidationSchema = z.object({
  static_analysis: StaticAnalysisConfigSchema,
  container: ContainerConfigSchema,
  categories: z.array(ValidationCategorySchema).min(1),
})
```

```typescript
const ArtifactRuleSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1).optional(),
  generator: z.enum([
    'designer', 'explorer', 'planner', 'tester', 'builder',
    'debugger', 'evaluator', 'critic', 'historian', 'facilitator', 'discovery',
  ]),
  required: z.boolean(),
  append_only: z.boolean(),
  format: ArtifactFormatEnum,
})

const GeneratedOutputRuleSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  type: OutputTypeEnum,
  generated_at: GeneratedAtEnum,
})

export const ArtifactsSchema = z.object({
  artifacts: z.array(ArtifactRuleSchema).min(1),
  generated_outputs: z.array(GeneratedOutputRuleSchema),
})
```

```typescript
export const ExitSchema = z.object({
  conditions: z.object({
    all_categories_pass: z.boolean(),
    requirements_met: z.boolean(),
  }),
  on_cap_hit: CapBehaviorEnum,
  halt_behavior: z.object({
    write_partial_report: z.boolean(),
    notify_user: z.boolean(),
    block_version_snapshot: z.boolean(),
    preserve_decisions: z.boolean(),
  }),
  on_error: z.object({
    behavior: ErrorBehaviorEnum,
    write_error_report: z.boolean(),
    block_version_snapshot: z.boolean(),
  }),
})
```

```typescript
export const UserValidationSchema = z.object({
  approval_required: z.boolean(),
  review_at: z.array(z.enum(['after_planning', 'after_gate_pass'])).min(1),
  prompts: z.record(z.string(), z.string()),
  timeout_minutes: z.number().int().min(1),
  on_timeout: TimeoutActionEnum,
  auto_approve_on_rerun: z.boolean(),
})
```

```typescript
export const SummarySchema = z.object({
  format: SummaryFormatEnum,
  sections: z.array(z.string().min(1)).min(1),
  test_command_format: TestCommandFormatEnum,
  show_confidence_scores: z.boolean(),
  show_failed_test_ids: z.boolean(),
  what_was_built_max_tokens: z.number().int().min(50).max(2000),
  next_steps_max_count: z.number().int().min(0).max(20),
  output_path: z.string().min(1),
})
```

```typescript
const AgentLLMConfigSchema = z.object({
  provider: LLMProviderEnum,
  base_url: z.string().url().optional(),
  model: z.string().min(1),
  api_key_env: z.string().min(1),
})

const AgentRoleConfigSchema = z.object({
  active: z.boolean(),
  step_id: z.string().nullable(),
  llm: AgentLLMConfigSchema,
  temperature: z.number(),
  max_tokens: z.number().int(),
  system_prompt: z.string().min(1),
  artifact_slice: z.array(z.string().min(1)),
  outputs: z.array(z.string().min(1)),
  conditional: z.boolean(),
  condition: z.string().optional(),
  constraints: z.array(z.string().min(1)).optional(),
  append_only: z.boolean().optional(),
  session_types: z.array(z.string().min(1)).optional(),
  trigger_step_id: z.string().optional(),
})

export const AgentsSchema = z.object({
  defaults: z.object({
    llm: AgentLLMConfigSchema,
    temperature: z.number(),
    max_tokens: z.number().int(),
    system_prompt_root: z.string().min(1),
  }),
  providers: z.record(z.string(), AgentLLMConfigSchema),
  agents: z.record(AgentRoleEnum, AgentRoleConfigSchema),
}).refine(
  (data) => 'planner' in data.agents,
  { message: 'planner agent role is required' },
)
```

```typescript
export const RuntimeConfigSchema = z.object({
  planning: PlanningSchema,
  validation: ValidationSchema,
  artifacts: ArtifactsSchema,
  exit: ExitSchema,
  user_validation: UserValidationSchema,
  summary: SummarySchema,
  agents: AgentsSchema,
})
```

**DDR change tracking:** See `sle-v2-docs-plan.md` Phase 0 decisions summary for the full list of type changes from DDR-019 through DDR-026.
