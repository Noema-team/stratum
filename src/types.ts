import { z } from 'zod';

export type NodeStatus = 'pending' | 'running' | 'complete' | 'failed' | 'skipped';

// ============================================================================
// 1 — Enumerations & Primitives
// ============================================================================

export type ProjectType = 'api' | 'ui' | 'library' | 'research' | 'custom';
export type PlanningDepth = 'minimal' | 'standard' | 'deep' | 'research';
export type SystemStatus = 'idle' | 'discovering' | 'cycling' | 'halted' | 'complete';
export type CycleOutcome = 'cycling' | 'completed' | 'halted';
export type DiscoveryStatus = 'not_started' | 'in_progress' | 'complete';
export type DiscoveryMode = 'full' | 'solo';
export type AgentRole =
  | 'designer'
  | 'explorer'
  | 'planner'
  | 'tester'
  | 'builder'
  | 'debugger'
  | 'evaluator'
  | 'critic'
  | 'historian'
  | 'facilitator';
export type GeneratorRole = AgentRole | 'discovery';
export type ValidationMethod = 'llm' | 'executable' | 'both';
export type CategoryStatus = 'passed' | 'failed' | 'pending' | 'skipped';
export type CapBehavior = 'halt_with_report' | 'user_prompt' | 'force_pass';
export type ErrorBehavior = 'halt' | 'retry_once' | 'notify_and_wait';
export type TimeoutAction = 'auto_approve' | 'halt' | 'notify_and_wait';
export type SummaryFormat = 'markdown' | 'html' | 'json';
export type TestCommandFormat = 'shell' | 'npm_script' | 'makefile';
export type ArtifactFormat = 'markdown' | 'json' | 'yaml';
export type OutputType = 'executable' | 'html' | 'markdown';
export type GeneratedAt = 'gate_pass' | 'cycle_end' | 'always';
export type LLMProvider = 'openai_compatible' | 'anthropic';
export type ArtifactScope = 'project' | 'group' | 'run' | 'ephemeral';
export type ArtifactRef = `doc:${string}` | `node:${string}:${string}`;
export type ContextAssemblyMode = 'declared' | 'inferred';
export type SourceWeight = 'user_defined' | 'cycle_produced' | 'inferred';
export type TagPrefix = 'next-cycle' | 'scope' | 'area';
export type VersionBump = 'major' | 'minor' | 'patch';
export type SubPhase = 'static-check' | 'llm-check' | 'exec-check';
export type OpenQuestionBlocking = `phase:${number}` | 'not_blocking';

// ============================================================================
// Zod Enums for validation
// ============================================================================

export const ProjectTypeEnum = z.enum(['api', 'ui', 'library', 'research', 'custom']);
export const PlanningDepthEnum = z.enum(['minimal', 'standard', 'deep', 'research']);
export const SystemStatusEnum = z.enum(['idle', 'discovering', 'cycling', 'halted', 'complete']);
export const CycleOutcomeEnum = z.enum(['cycling', 'completed', 'halted']);
export const DiscoveryStatusEnum = z.enum(['not_started', 'in_progress', 'complete']);
export const DiscoveryModeEnum = z.enum(['full', 'solo']);
export const AgentRoleEnum = z.enum([
  'designer',
  'explorer',
  'planner',
  'tester',
  'builder',
  'debugger',
  'evaluator',
  'critic',
  'historian',
  'facilitator',
]);
export const GeneratorRoleEnum = z.union([AgentRoleEnum, z.literal('discovery')]);
export const ValidationMethodEnum = z.enum(['llm', 'executable', 'both']);
export const CategoryStatusEnum = z.enum(['passed', 'failed', 'pending', 'skipped']);
export const CapBehaviorEnum = z.enum(['halt_with_report', 'user_prompt', 'force_pass']);
export const ErrorBehaviorEnum = z.enum(['halt', 'retry_once', 'notify_and_wait']);
export const TimeoutActionEnum = z.enum(['auto_approve', 'halt', 'notify_and_wait']);
export const SummaryFormatEnum = z.enum(['markdown', 'html', 'json']);
export const TestCommandFormatEnum = z.enum(['shell', 'npm_script', 'makefile']);
export const ArtifactFormatEnum = z.enum(['markdown', 'json', 'yaml']);
export const OutputTypeEnum = z.enum(['executable', 'html', 'markdown']);
export const GeneratedAtEnum = z.enum(['gate_pass', 'cycle_end', 'always']);
export const LLMProviderEnum = z.enum(['openai_compatible', 'anthropic']);
export const ArtifactScopeEnum = z.enum(['project', 'group', 'run', 'ephemeral']);
export const ContextAssemblyModeEnum = z.enum(['declared', 'inferred']);
export const SourceWeightEnum = z.enum(['user_defined', 'cycle_produced', 'inferred']);
export const TagPrefixEnum = z.enum(['next-cycle', 'scope', 'area']);
export const VersionBumpEnum = z.enum(['major', 'minor', 'patch']);
export const SubPhaseEnum = z.enum(['static-check', 'llm-check', 'exec-check']);
export const NodeStatusEnum = z.enum(['pending', 'running', 'complete', 'failed', 'skipped']);

// ArtifactRef is a template literal type, validated with custom logic
export const ArtifactRefSchema = z.string().refine(
  (val) => /^(doc:[a-zA-Z0-9_-]+|node:[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+)$/.test(val),
  'ArtifactRef must be either doc:key or node:group:key'
);

// OpenQuestionBlocking template literal validation
export const OpenQuestionBlockingSchema = z.union([
  z.string().regex(/^phase:\d+$/, 'Must be phase:N where N is a number'),
  z.literal('not_blocking'),
]);

// ============================================================================
// 2 — System State
// ============================================================================

export interface ChatState {
  session_open: boolean;
  session_id?: string;
  started_at?: string;
}

export const ChatStateSchema = z.object({
  session_open: z.boolean(),
  session_id: z.string().optional(),
  started_at: z.string().datetime().optional(),
});

export interface CycleFlags {
  awaiting_scoping: boolean;
  awaiting_confirmation: boolean;
  awaiting_sharding_approval: boolean;
}

export const CycleFlagsSchema = z.object({
  awaiting_scoping: z.boolean().default(false),
  awaiting_confirmation: z.boolean().default(false),
  awaiting_sharding_approval: z.boolean().default(false),
});

// ============================================================================
// 3 — Agent Roles
// ============================================================================

export interface AgentLLMConfig {
  provider: LLMProvider;
  base_url?: string;
  api_key_env: string;
  model: string;
}

export const AgentLLMConfigSchema = z.object({
  provider: LLMProviderEnum,
  base_url: z.string().url().optional(),
  api_key_env: z.string().min(1, 'api_key_env required'),
  model: z.string().min(1, 'model required'),
});

export interface AgentRoleConfig {
  active: boolean;
  node: string | null;
  llm: AgentLLMConfig;
  temperature: number;
  max_tokens: number;
  system_prompt: string;
  artifact_slice: string[];
  outputs: string[];
  conditional: boolean;
  condition?: string;
  constraints?: string[];
  append_only?: boolean;
  session_types?: string[];
  trigger_node?: string;
}

export const AgentRoleConfigSchema = z.object({
  active: z.boolean(),
  node: z.string().nullable(),
  llm: AgentLLMConfigSchema,
  temperature: z.number(),
  max_tokens: z.number().positive(),
  system_prompt: z.string(),
  artifact_slice: z.array(ArtifactRefSchema),
  outputs: z.array(z.string()),
  conditional: z.boolean().default(false),
  condition: z.string().optional(),
  constraints: z.array(z.string()).optional(),
  append_only: z.boolean().optional(),
  session_types: z.array(z.string()).optional(),
  trigger_node: z.string().optional(),
});

export interface AgentsConfig {
  defaults: {
    llm: AgentLLMConfig;
    temperature: number;
    max_tokens: number;
    system_prompt_root: string;
  };
  providers: Record<string, AgentLLMConfig>;
  agents: Record<string, AgentRoleConfig>;
}

export const AgentsSchema = z.object({
  defaults: z.object({
    llm: AgentLLMConfigSchema,
    temperature: z.number(),
    max_tokens: z.number().positive(),
    system_prompt_root: z.string(),
  }),
  providers: z.record(z.string(), AgentLLMConfigSchema),
  agents: z.record(z.string(), AgentRoleConfigSchema),
}).refine(
  (data) => 'planner' in data.agents,
  { message: 'planner agent role is required' },
);

export interface AgentInput {
  role: AgentRole;
  context: AssembledContext;
  instruction: string;
}

export interface AgentResult {
  role: AgentRole;
  output: unknown;
  tokens_used: number;
  duration_ms: number;
}

// ============================================================================
// 4 — DAG & Cycle
// ============================================================================

export enum DAGNode {
  SCOPING = 'SCOPING',
  DESIGN = 'DESIGN',
  CRITIQUE = 'CRITIQUE',
  PLAN = 'PLAN',
  TEST = 'TEST',
  SHARDING_APPROVAL = 'SHARDING_APPROVAL',
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

export const DAGNodeEnum = z.nativeEnum(DAGNode);

export interface DAGState {
  current: DAGNode;
  iteration: number;
  max_iterations: number;
  started_at: string;
  history: DAGEvent[];
}

export const DAGStateSchema: z.ZodSchema<DAGState> = z.lazy(() =>
  z.object({
    current: DAGNodeEnum,
    iteration: z.number().nonnegative(),
    max_iterations: z.number().positive(),
    started_at: z.string().datetime(),
    history: z.array(DAGEventSchema),
  })
);

export interface DAGEvent {
  node: DAGNode;
  type: 'enter' | 'exit' | 'error' | 'skip';
  timestamp: string;
  data?: unknown;
}

export const DAGEventSchema: z.ZodSchema<DAGEvent> = z.lazy(() =>
  z.object({
    node: DAGNodeEnum,
    type: z.enum(['enter', 'exit', 'error', 'skip']),
    timestamp: z.string().datetime(),
    data: z.unknown().optional(),
  })
);

export interface CycleState {
  number: number;
  iteration: number;
  revision: number;
  max_iterations: number;
  planning_depth: PlanningDepth;
  started_at: string;
  completed_at?: string;
  outcome: CycleOutcome;
  approval_gate: 'after_planning' | 'after_gate_pass' | null;
  awaiting_scoping: boolean;
  awaiting_confirmation: boolean;
  awaiting_sharding_approval: boolean;
  last_summary?: { path: string; generated_at: string };
}

export const CycleStateSchema = z.object({
  number: z.number().nonnegative(),
  iteration: z.number().nonnegative(),
  revision: z.number().nonnegative(),
  max_iterations: z.number().positive(),
  planning_depth: PlanningDepthEnum,
  started_at: z.string().datetime(),
  completed_at: z.string().datetime().optional(),
  outcome: CycleOutcomeEnum,
  approval_gate: z.union([z.literal('after_planning'), z.literal('after_gate_pass'), z.null()]),
  awaiting_scoping: z.boolean(),
  awaiting_confirmation: z.boolean(),
  awaiting_sharding_approval: z.boolean(),
  last_summary: z
    .object({
      path: z.string(),
      generated_at: z.string().datetime(),
    })
    .optional(),
});

export interface CycleExecutionSummary {
  version_id: string;
  cycle: number;
  nodes_completed: DAGNode[];
  iterations_used: number;
  total_revisions: number;
  failed_at?: { node: DAGNode; reason: string };
  duration_ms: number;
  agent_runs: Record<AgentRole, number>;
}

export const CycleExecutionSummarySchema = z.object({
  version_id: z.string(),
  cycle: z.number().nonnegative(),
  nodes_completed: z.array(DAGNodeEnum),
  iterations_used: z.number().positive(),
  total_revisions: z.number().nonnegative(),
  failed_at: z
    .object({
      node: DAGNodeEnum,
      reason: z.string(),
    })
    .optional(),
  duration_ms: z.number().nonnegative(),
  agent_runs: z.record(AgentRoleEnum, z.number().nonnegative()),
});

export interface VersionSnapshot {
  version_id: string;
  cycle: number;
  iteration: number;
  revision: number;
  locked_at: string;
  artifact_hashes: Record<string, string>;
  category_results: CategoryResult[];
  outcome: 'completed' | 'halted';
  version_bump: VersionBump;
  deployable: boolean;
  changed_nodes: string[];
}

export const VersionSnapshotSchema: z.ZodSchema<VersionSnapshot> = z.lazy(() =>
  z.object({
    version_id: z.string(),
    cycle: z.number().nonnegative(),
    iteration: z.number().nonnegative(),
    revision: z.number().nonnegative(),
    locked_at: z.string().datetime(),
    artifact_hashes: z.record(z.string(), z.string()),
    category_results: z.array(CategoryResultSchema),
    outcome: z.enum(['completed', 'halted']),
    version_bump: VersionBumpEnum,
    deployable: z.boolean(),
    changed_nodes: z.array(z.string()),
  })
);

// ============================================================================
// 5 — Artifacts
// ============================================================================

export interface ArtifactRule {
  id: string;
  path?: string;
  generator: GeneratorRole;
  required: boolean;
  append_only: boolean;
  format: ArtifactFormat;
}

export const ArtifactRuleSchema = z.object({
  id: z.string().min(1),
  path: z.string().optional(),
  generator: GeneratorRoleEnum,
  required: z.boolean(),
  append_only: z.boolean().default(false),
  format: ArtifactFormatEnum,
});

export interface GeneratedOutputRule {
  id: string;
  path: string;
  type: OutputType;
  generated_at: GeneratedAt;
}

export const GeneratedOutputRuleSchema = z.object({
  id: z.string().min(1),
  path: z.string(),
  type: OutputTypeEnum,
  generated_at: GeneratedAtEnum,
});

export interface ArtifactsConfig {
  artifacts: ArtifactRule[];
  generated_outputs: GeneratedOutputRule[];
}

export const ArtifactsSchema = z.object({
  artifacts: z.array(ArtifactRuleSchema).min(1),
  generated_outputs: z.array(GeneratedOutputRuleSchema),
});

export interface ArtifactEntry {
  path: string;
  generator: GeneratorRole;
  required: boolean;
  append_only?: boolean;
  scope?: ArtifactScope;
  source_weight?: SourceWeight;
  version_produced?: string;
  last_updated: string;
  dirty: boolean;
}

export const ArtifactEntrySchema = z.object({
  path: z.string(),
  generator: GeneratorRoleEnum,
  required: z.boolean(),
  append_only: z.boolean().optional(),
  scope: ArtifactScopeEnum.optional(),
  source_weight: SourceWeightEnum.optional(),
  version_produced: z.string().optional(),
  last_updated: z.string().datetime(),
  dirty: z.boolean(),
});

export interface GeneratedOutput {
  path: string;
  type: OutputType;
}

export const GeneratedOutputSchema = z.object({
  path: z.string(),
  type: OutputTypeEnum,
});

// ============================================================================
// 6 — Validation
// ============================================================================

export interface ValidationRuleCategory {
  name: string;
  method: ValidationMethod;
  executable?: {
    runner: string;
    timeout_ms: number;
    output_format: 'json';
  };
  llm?: {
    artifact_slice: string[];
    prompt_template: string;
    pass_threshold: number;
  };
  pass_criteria: {
    executable?: 'all_pass' | 'any_pass' | `threshold:${number}` | Record<string, number>;
    llm?: 'verdict_pass' | string;
  };
  on_fail: {
    feed_to: 'planner' | 'evaluator';
    include: string[];
  };
}

export const ValidationRuleCategorySchema = z.object({
  name: z.string().min(1),
  method: ValidationMethodEnum,
  executable: z
    .object({
      runner: z.string(),
      timeout_ms: z.number().positive(),
      output_format: z.literal('json'),
    })
    .optional(),
  llm: z
    .object({
      artifact_slice: z.array(ArtifactRefSchema),
      prompt_template: z.string(),
      pass_threshold: z.number().min(0).max(1),
    })
    .optional(),
  pass_criteria: z.object({
    executable: z
      .union([
        z.literal('all_pass'),
        z.literal('any_pass'),
        z.string().regex(/^threshold:\d+$/),
        z.record(z.string(), z.number()),
      ])
      .optional(),
    llm: z.union([z.literal('verdict_pass'), z.string()]).optional(),
  }),
  on_fail: z.object({
    feed_to: z.enum(['planner', 'evaluator']),
    include: z.array(z.string()),
  }),
}).refine(
  (data) => {
    if (data.method === 'executable' || data.method === 'both') return !!data.executable;
    return true;
  },
  { message: 'executable config required when method is executable or both', path: ['executable'] },
).refine(
  (data) => {
    if (data.method === 'llm' || data.method === 'both') return !!data.llm;
    return true;
  },
  { message: 'llm config required when method is llm or both', path: ['llm'] },
);

export interface StaticAnalysisCheck {
  command: string;
  enabled: boolean;
  pass_criteria: Record<string, number>;
}

export const StaticAnalysisCheckSchema = z.object({
  command: z.string(),
  enabled: z.boolean(),
  pass_criteria: z.record(z.string(), z.number()),
});

export interface StaticAnalysisConfig {
  lint: StaticAnalysisCheck;
  typecheck: StaticAnalysisCheck;
  complexity: StaticAnalysisCheck;
}

export const StaticAnalysisConfigSchema = z.object({
  lint: StaticAnalysisCheckSchema,
  typecheck: StaticAnalysisCheckSchema,
  complexity: StaticAnalysisCheckSchema,
});

export interface ContainerConfig {
  base_image: string;
  install_command: string;
  timeout_ms: number;
}

export const ContainerConfigSchema = z.object({
  base_image: z.string(),
  install_command: z.string(),
  timeout_ms: z.number().positive(),
});

export interface ValidationConfig {
  static_analysis: StaticAnalysisConfig;
  container: ContainerConfig;
  categories: ValidationRuleCategory[];
}

export const ValidationSchema = z.object({
  static_analysis: StaticAnalysisConfigSchema,
  container: ContainerConfigSchema,
  categories: z.array(ValidationRuleCategorySchema).min(1),
});

export interface CategoryResult {
  name: string;
  method: ValidationMethod;
  llm?: {
    verdict: 'pass' | 'fail';
    confidence: number;
    issues: string[];
    evidence: string[];
  };
  executable?: {
    passed: boolean;
    passed_cases: string[];
    failed_cases: string[];
    errors: string[];
    metrics: Record<string, number>;
  };
  passed: boolean;
}

export const CategoryResultSchema: z.ZodSchema<CategoryResult> = z.lazy(() =>
  z.object({
    name: z.string(),
    method: ValidationMethodEnum,
    llm: z
      .object({
        verdict: z.enum(['pass', 'fail']),
        confidence: z.number().min(0).max(1),
        issues: z.array(z.string()),
        evidence: z.array(z.string()),
      })
      .optional(),
    executable: z
      .object({
        passed: z.boolean(),
        passed_cases: z.array(z.string()),
        failed_cases: z.array(z.string()),
        errors: z.array(z.string()),
        metrics: z.record(z.string(), z.number()),
      })
      .optional(),
    passed: z.boolean(),
  })
);

export interface GateResult {
  passed: boolean;
  category_results: CategoryResult[];
  static_analysis: StaticAnalysisResult;
  failed_categories: string[];
  failure_report?: FailureReport;
}

export const GateResultSchema: z.ZodSchema<GateResult> = z.lazy(() =>
  z.object({
    passed: z.boolean(),
    category_results: z.array(CategoryResultSchema),
    static_analysis: StaticAnalysisResultSchema,
    failed_categories: z.array(z.string()),
    failure_report: FailureReportSchema.optional(),
  })
);

export interface StaticAnalysisResult {
  lint: {
    errors: number;
    warnings: number;
    output: string;
  };
  typecheck: {
    errors: number;
    output: string;
  };
  complexity: {
    files_over_threshold: Array<{
      file: string;
      complexity: number;
      threshold: number;
    }>;
    max: number;
  };
  passed: boolean;
}

export const StaticAnalysisResultSchema = z.object({
  lint: z.object({
    errors: z.number().nonnegative(),
    warnings: z.number().nonnegative(),
    output: z.string(),
  }),
  typecheck: z.object({
    errors: z.number().nonnegative(),
    output: z.string(),
  }),
  complexity: z.object({
    files_over_threshold: z.array(
      z.object({
        file: z.string(),
        complexity: z.number().positive(),
        threshold: z.number().positive(),
      })
    ),
    max: z.number().nonnegative(),
  }),
  passed: z.boolean(),
});

export interface FailureReport {
  cycle: number;
  iteration: number;
  run_dir: string;
  run_id: string;
  quick_summary: string;
  failed_categories: string[];
  passed_categories: string[];
}

export const FailureReportSchema = z.object({
  cycle: z.number().nonnegative(),
  iteration: z.number().nonnegative(),
  run_dir: z.string(),
  run_id: z.string(),
  quick_summary: z.string(),
  failed_categories: z.array(z.string()),
  passed_categories: z.array(z.string()),
});

export interface ValidationCategory {
  name: string;
  method: ValidationMethod;
  status: CategoryStatus;
  last_run?: string;
  executable?: string;
  prompt_template?: string;
}

export const ValidationCategorySchema = z.object({
  name: z.string(),
  method: ValidationMethodEnum,
  status: CategoryStatusEnum,
  last_run: z.string().datetime().optional(),
  executable: z.string().optional(),
  prompt_template: z.string().optional(),
});

export interface ValidationGate {
  mode: 'all_must_pass';
  last_outcome: 'passed' | 'failed' | 'halted';
  failed_categories: string[];
}

export const ValidationGateSchema = z.object({
  mode: z.literal('all_must_pass'),
  last_outcome: z.enum(['passed', 'failed', 'halted']),
  failed_categories: z.array(z.string()),
});

// ============================================================================
// 7 — Context Assembly
// ============================================================================

export interface AssembledContext {
  system_prompt: string;
  artifact_slices: Record<string, string>;
  state_summary: string;
  task: string;
  failure_context?: string;
  knowledge_context?: string;
  token_count: number;
  truncated: string[];
}

export const AssembledContextSchema = z.object({
  system_prompt: z.string(),
  artifact_slices: z.record(z.string(), z.string()),
  state_summary: z.string(),
  task: z.string(),
  failure_context: z.string().optional(),
  knowledge_context: z.string().optional(),
  token_count: z.number().nonnegative(),
  truncated: z.array(z.string()),
});

export interface SliceRule {
  artifact_id: string;
  mode: 'full' | 'summary';
  max_entries?: number;
  max_tokens?: number;
  never_truncate?: boolean;
  source_weight?: SourceWeight;
}

export const SliceRuleSchema = z.object({
  artifact_id: z.string(),
  mode: z.enum(['full', 'summary']),
  max_entries: z.number().positive().optional(),
  max_tokens: z.number().positive().optional(),
  never_truncate: z.boolean().optional(),
  source_weight: SourceWeightEnum.optional(),
});

export interface ContextManagerConfig {
  artifact_slice_size: number;
  summary_max_tokens: number;
  system_prompt_max_tokens: number;
  hard_ceiling: number;
}

export const ContextManagerConfigSchema = z.object({
  artifact_slice_size: z.number().positive(),
  summary_max_tokens: z.number().positive(),
  system_prompt_max_tokens: z.number().positive(),
  hard_ceiling: z.number().positive(),
});

// ============================================================================
// 8 — Configuration
// ============================================================================

export interface PlanningConfig {
  depth: PlanningDepth;
  max_iterations: number;
  artifact_slice_size: number;
  summary_max_tokens: number;
  system_prompt_max_tokens: number;
  reasoning_passes: Record<PlanningDepth, number>;
  critic_enabled: boolean | null;
  on_depth_change: 're_plan' | 'continue';
}

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
});

export interface ExitConfig {
  conditions: {
    all_categories_pass: boolean;
    requirements_met: boolean;
  };
  on_cap_hit: CapBehavior;
  halt_behavior: {
    write_partial_report: boolean;
    notify_user: boolean;
    block_version_snapshot: boolean;
    preserve_decisions: boolean;
  };
  on_error: {
    behavior: ErrorBehavior;
    write_error_report: boolean;
    block_version_snapshot: boolean;
  };
}

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
});

export interface UserValidationConfig {
  approval_required: boolean;
  review_at: ('after_planning' | 'after_gate_pass')[];
  prompts: Record<string, string>;
  timeout_minutes: number;
  on_timeout: TimeoutAction;
  auto_approve_on_rerun: boolean;
}

export const UserValidationSchema = z.object({
  approval_required: z.boolean(),
  review_at: z.array(z.enum(['after_planning', 'after_gate_pass'])).min(1),
  prompts: z.record(z.string(), z.string()),
  timeout_minutes: z.number().int().min(1),
  on_timeout: TimeoutActionEnum,
  auto_approve_on_rerun: z.boolean(),
});

export interface SummaryConfig {
  format: SummaryFormat;
  sections: string[];
  test_command_format: TestCommandFormat;
  show_confidence_scores: boolean;
  show_failed_test_ids: boolean;
  what_was_built_max_tokens: number;
  next_steps_max_count: number;
  output_path: string;
}

export const SummarySchema = z.object({
  format: SummaryFormatEnum,
  sections: z.array(z.string()).min(1),
  test_command_format: TestCommandFormatEnum,
  show_confidence_scores: z.boolean(),
  show_failed_test_ids: z.boolean(),
  what_was_built_max_tokens: z.number().int().min(50).max(2000),
  next_steps_max_count: z.number().int().min(0).max(20),
  output_path: z.string(),
});

export interface RuntimeConfig {
  planning: PlanningConfig;
  validation: ValidationConfig;
  artifacts: ArtifactsConfig;
  exit: ExitConfig;
  user_validation: UserValidationConfig;
  summary: SummaryConfig;
  agents: AgentsConfig;
}

export const RuntimeConfigSchema = z.object({
  planning: PlanningSchema,
  validation: ValidationSchema,
  artifacts: ArtifactsSchema,
  exit: ExitSchema,
  user_validation: UserValidationSchema,
  summary: SummarySchema,
  agents: AgentsSchema,
});

// ============================================================================
// 9 — Init & Discovery
// ============================================================================

export interface InitState {
  last_completed_step: number;
  project: {
    name: string;
    description: string;
    description_long?: string;
    type: ProjectType;
  };
  remotes: {
    code: { url: string; branch: string };
    issues: { url: string; prefix: string; local_only: boolean };
    docs: { url: string; pending: boolean };
  };
  task_store: {
    provider: 'beads' | 'local';
  };
  beads_initialised: boolean;
  docs_cloned: boolean;
  committed: boolean;
}

export const InitStateSchema = z.object({
  last_completed_step: z.number().nonnegative(),
  project: z.object({
    name: z.string().min(1),
    description: z.string().min(1),
    description_long: z.string().optional(),
    type: ProjectTypeEnum,
  }),
  remotes: z.object({
    code: z.object({
      url: z.string().url(),
      branch: z.string(),
    }),
    issues: z.object({
      url: z.string().url(),
      prefix: z.string(),
      local_only: z.boolean(),
    }),
    docs: z.object({
      url: z.string().url(),
      pending: z.boolean(),
    }),
  }),
  task_store: z.object({
    provider: z.enum(['beads', 'local']),
  }),
  beads_initialised: z.boolean(),
  docs_cloned: z.boolean(),
  committed: z.boolean(),
});

export interface InitOptions {
  name?: string;
  description?: string;
  type?: ProjectType;
  code_remote?: string;
  issues_remote?: string;
  docs_remote?: string;
  prefix?: string;
  no_editor?: boolean;
  no_daemon?: boolean;
  resume?: boolean;
  reset?: boolean;
  non_interactive?: boolean;
}

export const InitOptionsSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  type: ProjectTypeEnum.optional(),
  code_remote: z.string().url().optional(),
  issues_remote: z.string().url().optional(),
  docs_remote: z.string().url().optional(),
  prefix: z.string().optional(),
  no_editor: z.boolean().optional(),
  no_daemon: z.boolean().optional(),
  resume: z.boolean().optional(),
  reset: z.boolean().optional(),
  non_interactive: z.boolean().optional(),
});

export interface OpenQuestion {
  title: string;
  status: 'open' | 'resolved';
  blocking: OpenQuestionBlocking;
  owner?: string;
  resolve_by?: string;
  context: string;
}

export const OpenQuestionSchema = z.object({
  title: z.string().min(1),
  status: z.enum(['open', 'resolved']),
  blocking: OpenQuestionBlockingSchema,
  owner: z.string().optional(),
  resolve_by: z.string().optional(),
  context: z.string(),
});

export interface DiscoveryState {
  status: DiscoveryStatus;
  mode: DiscoveryMode;
  completed_at?: string;
  artifacts: string[];
  current_round: number;
  total_rounds: number;
  current_phase: number;
  total_phases: number;
  open_questions_count: number;
  blocking_questions_count: number;
}

export const DiscoveryStateSchema = z.object({
  status: DiscoveryStatusEnum,
  mode: DiscoveryModeEnum,
  completed_at: z.string().datetime().optional(),
  artifacts: z.array(z.string()),
  current_round: z.number().nonnegative(),
  total_rounds: z.number().nonnegative(),
  current_phase: z.number().nonnegative(),
  total_phases: z.number().nonnegative(),
  open_questions_count: z.number().nonnegative(),
  blocking_questions_count: z.number().nonnegative(),
});

export interface DiscoverySessionState {
  session_id: string;
  mode: DiscoveryMode;
  current_round: number;
  round_status: 'collecting' | 'drafting' | 'reviewing';
  completed_rounds: number[];
  artifacts_written: string[];
  open_questions_deferred: OpenQuestion[];
  started_at: string;
  last_interaction_at: string;
}

export const DiscoverySessionStateSchema = z.object({
  session_id: z.string().uuid(),
  mode: DiscoveryModeEnum,
  current_round: z.number().nonnegative(),
  round_status: z.enum(['collecting', 'drafting', 'reviewing']),
  completed_rounds: z.array(z.number().nonnegative()),
  artifacts_written: z.array(z.string()),
  open_questions_deferred: z.array(OpenQuestionSchema),
  started_at: z.string().datetime(),
  last_interaction_at: z.string().datetime(),
});

// ============================================================================
// 10 — Remote configuration
// ============================================================================

export interface GitRemote {
  type: 'git';
  url: string;
  branch: string;
}

export const GitRemoteSchema = z.object({
  type: z.literal('git'),
  url: z.string().url(),
  branch: z.string().min(1),
});

export interface DoltRemote {
  type: 'dolt';
  url: string;
  local_dir: string;
  bd_prefix: string;
}

export const DoltRemoteSchema = z.object({
  type: z.literal('dolt'),
  url: z.string(),
  local_dir: z.string(),
  bd_prefix: z.string(),
});

export interface AgentMdMapRef {
  map: string;
}

export const AgentMdMapRefSchema = z.object({
  map: z.string(),
});

// ============================================================================
// 11 — Task Store
// ============================================================================

export interface TaskContextDeclaration {
  task_id: string;
  slices: ArtifactRef[];
  intent: string;
}

export const TaskContextDeclarationSchema = z.object({
  task_id: z.string().uuid(),
  slices: z.array(ArtifactRefSchema),
  intent: z.string(),
});

export interface SLETask {
  id: string;
  title: string;
  description: string;
  status: 'open' | 'in_progress' | 'blocked' | 'closed';
  priority: number;
  dependencies: string[];
  context_declarations?: TaskContextDeclaration[];
  created_at: string;
  updated_at: string;
  stale?: boolean;
}

export const SLETaskSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1),
  description: z.string(),
  status: z.enum(['open', 'in_progress', 'blocked', 'closed']),
  priority: z.number().int().min(0),
  dependencies: z.array(z.string().uuid()),
  context_declarations: z.array(TaskContextDeclarationSchema).optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  stale: z.boolean().optional(),
});

export interface TaskStore {
  createTask: (task: Omit<SLETask, 'id' | 'created_at' | 'updated_at'>) => Promise<SLETask>;
  getReadyTasks: () => Promise<SLETask[]>;
  updateStatus: (taskId: string, status: SLETask['status']) => Promise<void>;
  closeTask: (taskId: string) => Promise<void>;
  getStale: () => Promise<SLETask[]>;
  addDependency: (taskId: string, dependencyTaskId: string) => Promise<void>;
}

// ============================================================================
// 12 — Daemon
// ============================================================================

export interface DaemonInfo {
  version: string;
  pid: number;
  port: number;
  started_at: string;
  uptime_ms: number;
  project_root: string;
  sle_version: string;
}

export const DaemonInfoSchema = z.object({
  version: z.string(),
  pid: z.number().positive(),
  port: z.number().positive(),
  started_at: z.string().datetime(),
  uptime_ms: z.number().nonnegative(),
  project_root: z.string(),
  sle_version: z.string(),
});

export interface ConnectionState {
  clients: number;
  subscriptions: string[];
  max_clients: number;
}

export const ConnectionStateSchema = z.object({
  clients: z.number().nonnegative(),
  subscriptions: z.array(z.string()),
  max_clients: z.number().positive(),
});

export interface APIResponse<T> {
  ok: true;
  data: T;
  meta?: {
    request_id: string;
    timestamp: string;
  };
}

export const APIResponseSchema = <T extends z.ZodSchema>(dataSchema: T) =>
  z.object({
    ok: z.literal(true),
    data: dataSchema,
    meta: z
      .object({
        request_id: z.string(),
        timestamp: z.string().datetime(),
      })
      .optional(),
  });

export interface APIError {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  meta: {
    request_id: string;
    timestamp: string;
  };
}

export const APIErrorSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
  meta: z.object({
    request_id: z.string(),
    timestamp: z.string().datetime(),
  }),
});

// ============================================================================
// 13 — Enum exports for reference
// ============================================================================

export interface NodeTag {
  prefix: TagPrefix;
  value?: string;
  source: 'user' | 'facilitator' | 'system';
  applied_at: string;
}

export const NodeTagSchema = z.object({
  prefix: TagPrefixEnum,
  value: z.string().optional(),
  source: z.enum(['user', 'facilitator', 'system']),
  applied_at: z.string().datetime(),
});
