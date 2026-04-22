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
export type SystemStatus = 'idle' | 'discovering' | 'cycling' | 'halted' | 'complete'
```
⚡ **DDR-020, DDR-021.** `chatting` removed (orthogonal session layer); `confirming` removed (flag on cycle record). Was `'idle' | 'running' | 'awaiting_approval' | 'halted'` in init-specs.

```typescript
export type CycleOutcome = 'running' | 'completed' | 'halted'
```
⚡ **DDR-020, DDR-021.** `awaiting_approval` removed; approval waiting is expressed via `cycle.awaiting_confirmation` flag. Aligns with SLE-024 §5 naming (G18).

```typescript
export type DiscoveryStatus = 'not_started' | 'complete'
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
Output format for the user-facing cycle summary.

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
export type GeneratedAt = 'gate_pass' | 'cycle_end' | 'always'
```
When a generated output is produced.

```typescript
export type LLMProvider = 'openai_compatible' | 'anthropic'
```
Supported LLM provider backends.

```typescript
export type ArtifactScope = 'project' | 'group'
```
⚡ **DDR-025.** Whether an artifact is project-level or group-level.

```typescript
export type ArtifactRef = `doc:${string}` | `node:${string}:${string}`
```
⚡ **DDR-025.** Typed prefix for artifact slice references. `doc:{key}` for project documents, `node:{group}:{key}` for group-level nodes.

```typescript
export type ContextAssemblyMode = 'declared' | 'inferred'
```
How the context manager assembles slices. `declared` uses Beads task declarations; `inferred` uses role-based defaults.

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

```typescript
export interface CycleFlags {
  awaiting_confirmation: boolean
  awaiting_sharding_approval: boolean
}
```
⚡ **DDR-021, DDR-026.** Pause-point flags on the cycle record. `meta.status` remains `cycling` when these are true.

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
  role: AgentRole
  system_prompt: string
  llm: AgentLLMConfig
}
```
Configuration for one agent role in `agents.yaml`.

```typescript
export interface AgentsConfig {
  agents: AgentRoleConfig[]
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
| Planner | `architecture.md` + `requirements.md` + decisions (last 3) + evaluation | `test-plan.md`, `plan.md` |
| Tester | `requirements.md` + `test-plan.md` | Executable test scripts |
| Builder | `requirements.md` + `architecture.md` + `test-plan.md` | Implementation + instrumented test scripts |
| Debugger | Run artifacts + failed category slices | Root-cause diagnosis |
| Evaluator | `requirements.md` + `evaluation.md` + `test-plan.md` + run artifacts | Structured verdict |
| Critic | `architecture.md` + `evaluation.md` | Blocking issues / warnings |
| Historian | `decisions.md` (full, append target) | Audit entry |
| Facilitator | Project context + cycle context (mode-dependent) | Decisions captured to `decisions.md` |

---

## 4 — DAG & Cycle

```typescript
export enum DAGNode {
  INTENT = 'INTENT',
  CONTEXT_ASSEMBLY = 'CONTEXT_ASSEMBLY',
  EXPLORE = 'EXPLORE',
  DESIGN = 'DESIGN',
  PLAN = 'PLAN',
  TEST = 'TEST',
  CONFIRM = 'CONFIRM',
  BUILD = 'BUILD',
  HISTORY = 'HISTORY',
  EXEC = 'EXEC',
  VALIDATION_GATE = 'VALIDATION_GATE',
  DEBUG = 'DEBUG',
  EVALUATE = 'EVALUATE',
  SUMMARISE = 'SUMMARISE',
  SNAPSHOT = 'SNAPSHOT',
}
```
⚡ **Expanded from init-specs.** Added nodes per SLE-024 §5.1. Init-specs had `PLAN`, `CONFIRM`, `BUILD`, `VALIDATE_LLM`, `VALIDATE_EXEC`, `GATE`, `COMPLETE`.

```typescript
export interface DAGState {
  current: DAGNode
  iteration: number
  max_iterations: number
  started_at: string
  history: DAGEvent[]
}
```
Current position and history of the DAG runner.

```typescript
export interface DAGEvent {
  node: DAGNode
  type: 'enter' | 'exit' | 'error'
  timestamp: string
  data?: unknown
}
```
An event recorded as the DAG runner moves between nodes.

```typescript
export interface CycleState {
  number: number
  iteration: number
  revision: number
  max_iterations: number
  planning_depth: PlanningDepth
  started_at: string
  completed_at?: string
  outcome: CycleOutcome
  approval_gate: 'after_planning' | 'after_gate_pass' | null
  awaiting_confirmation: boolean
  awaiting_sharding_approval: boolean
  last_summary?: { path: string; generated_at: string }
}
```
⚡ **DDR-021, DDR-026.** Added `revision`, `awaiting_confirmation`, `awaiting_sharding_approval`. Removed `status` — system state is tracked at `meta.status`.

---

## 5 — Artifacts

### 5.1 — Rule definitions

```typescript
export interface ArtifactRule {
  id: string
  path: string
  generator: GeneratorRole
  required: boolean
  append_only: boolean
  format: ArtifactFormat
}
```
Artifact declaration in `artifacts.yaml`.

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
  last_updated: string
  dirty: boolean
}
```
⚡ **DDR-025.** Added optional `scope` field to distinguish project vs group artifacts.

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
export interface ValidationConfig {
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
  categories: CategoryResult[]
  failed_categories: string[]
  failure_report?: FailureReport
}
```
Aggregated result from the VALIDATION gate.

```typescript
export interface FailedCategoryDetail {
  name: string
  phase: 'llm' | 'executable' | 'both'
  llm_issues?: string[]
  failed_tests?: string[]
  errors?: string[]
  metrics?: Record<string, number>
}
```
Detail on one failed category within a failure report.

```typescript
export interface FailureReport {
  cycle: number
  iteration: number
  failed_categories: FailedCategoryDetail[]
}
```
Structured report injected into the next Planner iteration on gate failure.

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
  token_count: number
  truncated: string[]
}
```
The assembled context window for one agent invocation.

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
export const GeneratedAtEnum = z.enum(['gate_pass', 'cycle_end', 'always'])
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
  llm: z.enum(['verdict_pass']).optional(),
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

export const ValidationSchema = z.object({
  categories: z.array(ValidationCategorySchema).min(1),
})
```

```typescript
const ArtifactRuleSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
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
  role: AgentRoleEnum,
  system_prompt: z.string().min(1),
  llm: AgentLLMConfigSchema,
})

export const AgentsSchema = z.object({
  agents: z.array(AgentRoleConfigSchema).min(1),
}).refine(
  (data) => {
    const roles = data.agents.map(a => a.role)
    return new Set(roles).size === roles.length
  },
  { message: 'duplicate agent roles not allowed' },
).refine(
  (data) => data.agents.some(a => a.role === 'planner'),
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
