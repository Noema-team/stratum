import { z } from 'zod';
import {
  type ProjectType,
  type RuntimeConfig,
  type PlanningConfig,
  type ArtifactsConfig,
  type ExitConfig,
  type UserValidationConfig,
  type SummaryConfig,
  type AgentsConfig,
  type AgentLLMConfig,
  type ValidationRuleCategory,
  type StaticAnalysisConfig,
  type ContainerConfig,
  RuntimeConfigSchema,
  PlanningSchema,
  ValidationSchema,
  ArtifactsSchema,
  ExitSchema,
  UserValidationSchema,
  SummarySchema,
  AgentsSchema,
} from './types.js';

export const RULE_FILE_NAMES = [
  'planning',
  'validation',
  'artifacts',
  'exit',
  'user_validation',
  'summary',
  'agents',
] as const;

export type RuleFileName = (typeof RULE_FILE_NAMES)[number];

export const LOADING_ORDER: RuleFileName[] = [
  'planning',
  'agents',
  'artifacts',
  'validation',
  'exit',
  'user_validation',
  'summary',
];

export interface ValidationError {
  path: string;
  message: string;
}

export interface ValidationResult {
  success: boolean;
  errors: ValidationError[];
}

export interface ConsistencyWarning {
  type: 'orphaned_category' | 'unknown_generator' | 'duplicate_category' | 'duplicate_artifact' | 'depth_critic_mismatch';
  message: string;
  path: string;
}

const DEFAULT_LLM: AgentLLMConfig = {
  provider: 'openai_compatible',
  base_url: 'https://api.openai.com/v1',
  model: 'gpt-4o',
  api_key_env: 'OPENAI_API_KEY',
};

const DEFAULT_PROVIDERS: Record<string, AgentLLMConfig> = {
  openai: {
    provider: 'openai_compatible',
    base_url: 'https://api.openai.com/v1',
    api_key_env: 'OPENAI_API_KEY',
    model: 'gpt-4o',
  },
  openrouter: {
    provider: 'openai_compatible',
    base_url: 'https://openrouter.ai/api/v1',
    api_key_env: 'OPENROUTER_API_KEY',
    model: 'gpt-4o',
  },
  glm: {
    provider: 'openai_compatible',
    base_url: 'https://open.bigmodel.cn/api/paas/v4',
    api_key_env: 'GLM_API_KEY',
    model: 'gpt-4o',
  },
  zai: {
    provider: 'openai_compatible',
    base_url: 'https://api.zai.dev/v1',
    api_key_env: 'ZAI_API_KEY',
    model: 'gpt-4o',
  },
  anthropic: {
    provider: 'anthropic',
    api_key_env: 'ANTHROPIC_API_KEY',
    model: 'claude-sonnet-4-20250514',
  },
};

const STATIC_ANALYSIS_DEFAULT: StaticAnalysisConfig = {
  lint: {
    command: 'npx eslint src/ --format json',
    enabled: true,
    pass_criteria: { max_errors: 0, max_warnings: 50 },
  },
  typecheck: {
    command: 'npx tsc --noEmit',
    enabled: true,
    pass_criteria: { max_errors: 0 },
  },
  complexity: {
    command: 'npx complexity-report --format json --threshold 15 src/',
    enabled: true,
    pass_criteria: { max_complexity: 15 },
  },
};

const CONTAINER_DEFAULT: ContainerConfig = {
  base_image: 'node:20-slim',
  install_command: 'npm install',
  timeout_ms: 120000,
};

const CORRECTNESS_CATEGORY: ValidationRuleCategory = {
  name: 'correctness',
  method: 'both',
  executable: {
    runner: 'scripts/test_correctness.ts',
    timeout_ms: 30000,
    output_format: 'json',
  },
  llm: {
    artifact_slice: ['doc:requirements', 'doc:src'],
    prompt_template: '.sle/prompts/correctness_check.md',
    pass_threshold: 0.85,
  },
  pass_criteria: {
    executable: 'all_pass',
    llm: 'verdict_pass',
  },
  on_fail: {
    feed_to: 'planner',
    include: ['failed_tests', 'llm_issues'],
  },
};

const CATEGORY_DEFAULTS: Record<ProjectType, ValidationRuleCategory[]> = {
  api: [
    CORRECTNESS_CATEGORY,
    {
      name: 'performance',
      method: 'both',
      executable: {
        runner: 'scripts/bench.ts',
        timeout_ms: 60000,
        output_format: 'json',
      },
      llm: {
        artifact_slice: ['doc:requirements', 'doc:architecture'],
        prompt_template: '.sle/prompts/performance_check.md',
        pass_threshold: 0.80,
      },
      pass_criteria: {
        executable: { p95_ms: 200, error_rate: 0.001 },
        llm: 'verdict_pass',
      },
      on_fail: {
        feed_to: 'planner',
        include: ['metrics', 'llm_issues'],
      },
    },
    {
      name: 'security',
      method: 'llm',
      llm: {
        artifact_slice: ['doc:requirements', 'doc:architecture', 'doc:src'],
        prompt_template: '.sle/prompts/security_check.md',
        pass_threshold: 0.90,
      },
      pass_criteria: {
        llm: 'verdict_pass',
      },
      on_fail: {
        feed_to: 'planner',
        include: ['llm_issues'],
      },
    },
  ],
  ui: [
    CORRECTNESS_CATEGORY,
    {
      name: 'usability',
      method: 'both',
      executable: {
        runner: 'scripts/test_usability.ts',
        timeout_ms: 30000,
        output_format: 'json',
      },
      llm: {
        artifact_slice: ['doc:requirements', 'doc:src'],
        prompt_template: '.sle/prompts/usability_check.md',
        pass_threshold: 0.80,
      },
      pass_criteria: {
        executable: 'all_pass',
        llm: 'verdict_pass',
      },
      on_fail: {
        feed_to: 'planner',
        include: ['failed_tests', 'llm_issues'],
      },
    },
    {
      name: 'performance',
      method: 'both',
      executable: {
        runner: 'scripts/bench.ts',
        timeout_ms: 60000,
        output_format: 'json',
      },
      llm: {
        artifact_slice: ['doc:requirements', 'doc:architecture'],
        prompt_template: '.sle/prompts/performance_check.md',
        pass_threshold: 0.80,
      },
      pass_criteria: {
        executable: { p95_ms: 200, error_rate: 0.001 },
        llm: 'verdict_pass',
      },
      on_fail: {
        feed_to: 'planner',
        include: ['metrics', 'llm_issues'],
      },
    },
  ],
  library: [
    CORRECTNESS_CATEGORY,
    {
      name: 'compatibility',
      method: 'llm',
      llm: {
        artifact_slice: ['doc:requirements', 'doc:architecture'],
        prompt_template: '.sle/prompts/compatibility_check.md',
        pass_threshold: 0.85,
      },
      pass_criteria: {
        llm: 'verdict_pass',
      },
      on_fail: {
        feed_to: 'planner',
        include: ['llm_issues'],
      },
    },
    {
      name: 'maintainability',
      method: 'llm',
      llm: {
        artifact_slice: ['doc:requirements', 'doc:architecture', 'doc:src'],
        prompt_template: '.sle/prompts/maintainability_check.md',
        pass_threshold: 0.75,
      },
      pass_criteria: {
        llm: 'verdict_pass',
      },
      on_fail: {
        feed_to: 'planner',
        include: ['llm_issues'],
      },
    },
  ],
  research: [
    CORRECTNESS_CATEGORY,
    {
      name: 'reproducibility',
      method: 'executable',
      executable: {
        runner: 'scripts/test_reproducibility.ts',
        timeout_ms: 120000,
        output_format: 'json',
      },
      pass_criteria: {
        executable: 'all_pass',
      },
      on_fail: {
        feed_to: 'planner',
        include: ['failed_tests'],
      },
    },
  ],
  custom: [CORRECTNESS_CATEGORY],
};

const PLANNING_DEFAULTS: Record<ProjectType, PlanningConfig> = {
  api: {
    depth: 'standard',
    max_iterations: 5,
    artifact_slice_size: 2000,
    summary_max_tokens: 400,
    system_prompt_max_tokens: 500,
    reasoning_passes: { minimal: 1, standard: 2, deep: 3, research: 4 },
    critic_enabled: null,
    on_depth_change: 're_plan',
  },
  ui: {
    depth: 'standard',
    max_iterations: 5,
    artifact_slice_size: 2000,
    summary_max_tokens: 400,
    system_prompt_max_tokens: 500,
    reasoning_passes: { minimal: 1, standard: 2, deep: 3, research: 4 },
    critic_enabled: null,
    on_depth_change: 're_plan',
  },
  library: {
    depth: 'standard',
    max_iterations: 5,
    artifact_slice_size: 2000,
    summary_max_tokens: 400,
    system_prompt_max_tokens: 500,
    reasoning_passes: { minimal: 1, standard: 2, deep: 3, research: 4 },
    critic_enabled: null,
    on_depth_change: 're_plan',
  },
  research: {
    depth: 'research',
    max_iterations: 10,
    artifact_slice_size: 4000,
    summary_max_tokens: 400,
    system_prompt_max_tokens: 500,
    reasoning_passes: { minimal: 1, standard: 2, deep: 3, research: 4 },
    critic_enabled: true,
    on_depth_change: 're_plan',
  },
  custom: {
    depth: 'minimal',
    max_iterations: 5,
    artifact_slice_size: 2000,
    summary_max_tokens: 400,
    system_prompt_max_tokens: 500,
    reasoning_passes: { minimal: 1, standard: 2, deep: 3, research: 4 },
    critic_enabled: null,
    on_depth_change: 're_plan',
  },
};

const ARTIFACTS_DEFAULT: ArtifactsConfig = {
  artifacts: [
    { id: 'requirements', path: 'docs/requirements.md', generator: 'designer', required: true, append_only: false, format: 'markdown' },
    { id: 'architecture', path: 'docs/architecture.md', generator: 'designer', required: true, append_only: false, format: 'markdown' },
    { id: 'test-plan', path: 'docs/test-plan.md', generator: 'planner', required: true, append_only: false, format: 'markdown' },
    { id: 'plan', path: 'docs/plan.md', generator: 'planner', required: true, append_only: false, format: 'markdown' },
    { id: 'decisions', path: 'docs/decisions.md', generator: 'historian', required: true, append_only: true, format: 'markdown' },
    { id: 'evaluation', path: 'docs/evaluation.md', generator: 'evaluator', required: true, append_only: false, format: 'markdown' },
    { id: 'build-plan', path: 'docs/build-plan.md', generator: 'planner', required: false, append_only: false, format: 'markdown' },
  ],
  generated_outputs: [
    { id: 'test_runner', path: 'scripts/run-tests.ts', type: 'executable', generated_at: 'gate_pass' },
    { id: 'validation_report', path: 'reports/validation-latest.html', type: 'html', generated_at: 'gate_pass' },
    { id: 'changelog', path: 'reports/changelog-{{version_id}}.md', type: 'markdown', generated_at: 'gate_pass' },
  ],
};

const EXIT_DEFAULT: ExitConfig = {
  conditions: {
    all_categories_pass: true,
    requirements_met: true,
  },
  on_cap_hit: 'halt_with_report',
  halt_behavior: {
    write_partial_report: true,
    notify_user: true,
    block_version_snapshot: true,
    preserve_decisions: true,
  },
  on_error: {
    behavior: 'halt',
    write_error_report: true,
    block_version_snapshot: true,
  },
};

const USER_VALIDATION_DEFAULT: UserValidationConfig = {
  approval_required: true,
  review_at: ['after_planning', 'after_gate_pass'],
  prompts: {
    after_planning: `The Planner has recommended the following validation categories:\n{{categories}}\n\nYou can accept, remove categories, or add new ones.\nRespond with your confirmed list or type "accept" to use as-is.`,
    after_gate_pass: `Cycle {{cycle}} has completed. All validation categories passed.\n\n{{summary}}\n\nType "approve" to lock version {{version_id}}, or describe changes\nyou want before the snapshot is locked.`,
  },
  timeout_minutes: 60,
  on_timeout: 'auto_approve',
  auto_approve_on_rerun: false,
};

const SUMMARY_DEFAULT: SummaryConfig = {
  format: 'markdown',
  sections: ['what_was_built', 'what_changed', 'category_results', 'how_to_test', 'next_steps'],
  test_command_format: 'shell',
  show_confidence_scores: true,
  show_failed_test_ids: true,
  what_was_built_max_tokens: 300,
  next_steps_max_count: 3,
  output_path: 'reports/summary-{{version_id}}.md',
};

const AGENTS_DEFAULT: AgentsConfig = {
  defaults: {
    llm: { ...DEFAULT_LLM },
    temperature: 0.3,
    max_tokens: 8000,
    system_prompt_root: '.sle/prompts',
  },
  providers: { ...DEFAULT_PROVIDERS },
  agents: {
    designer: {
      active: true,
      node: 'design',
      llm: { ...DEFAULT_LLM },
      temperature: 0.3,
      max_tokens: 8000,
      system_prompt: '.sle/prompts/designer.md',
      artifact_slice: ['doc:requirements', 'doc:architecture', 'doc:decisions', 'doc:evaluation'],
      outputs: ['doc:requirements', 'doc:architecture'],
      conditional: false,
    },
    explorer: {
      active: false,
      node: 'explore',
      llm: { ...DEFAULT_LLM },
      temperature: 0.5,
      max_tokens: 8000,
      system_prompt: '.sle/prompts/explorer.md',
      artifact_slice: ['doc:requirements', 'doc:evaluation', 'doc:decisions'],
      outputs: ['doc:research_findings'],
      conditional: true,
      condition: 'user_initiated',
    },
    planner: {
      active: true,
      node: 'plan',
      llm: { ...DEFAULT_LLM },
      temperature: 0.3,
      max_tokens: 8000,
      system_prompt: '.sle/prompts/planner.md',
      artifact_slice: ['doc:requirements', 'doc:architecture', 'doc:decisions', 'doc:evaluation'],
      outputs: ['doc:test-plan', 'doc:plan', 'doc:build-plan'],
      conditional: false,
    },
    tester: {
      active: true,
      node: 'test',
      llm: { ...DEFAULT_LLM },
      temperature: 0.1,
      max_tokens: 8000,
      system_prompt: '.sle/prompts/tester.md',
      artifact_slice: ['doc:requirements', 'doc:test-plan'],
      outputs: ['scripts/test_{category}.ts'],
      conditional: false,
      constraints: ['never_sees_builder_output'],
    },
    builder: {
      active: true,
      node: 'build',
      llm: { ...DEFAULT_LLM },
      temperature: 0.2,
      max_tokens: 16000,
      system_prompt: '.sle/prompts/builder.md',
      artifact_slice: ['doc:requirements', 'doc:architecture', 'doc:test-plan'],
      outputs: ['src/**', 'scripts/test_{category}.ts'],
      conditional: false,
    },
    debugger: {
      active: true,
      node: 'debug',
      llm: { ...DEFAULT_LLM },
      temperature: 0.2,
      max_tokens: 8000,
      system_prompt: '.sle/prompts/debugger.md',
      artifact_slice: ['doc:requirements', 'doc:test-plan'],
      outputs: ['debug:diagnosis', 'debug:fix_recommendation'],
      conditional: true,
      condition: 'gate_failure',
    },
    evaluator: {
      active: true,
      node: 'evaluate',
      llm: { ...DEFAULT_LLM },
      temperature: 0.1,
      max_tokens: 4000,
      system_prompt: '.sle/prompts/evaluator.md',
      artifact_slice: ['doc:requirements', 'doc:evaluation', 'doc:test-plan'],
      outputs: ['doc:evaluation'],
      conditional: false,
    },
    critic: {
      active: true,
      node: 'critique',
      llm: { ...DEFAULT_LLM },
      temperature: 0.5,
      max_tokens: 4000,
      system_prompt: '.sle/prompts/critic.md',
      artifact_slice: ['doc:architecture', 'doc:requirements', 'doc:evaluation'],
      outputs: ['critique:verdict', 'critique:issues', 'critique:suggestions'],
      conditional: true,
      condition: 'depth_deep_or_research',
      trigger_node: 'design',
    },
    historian: {
      active: true,
      node: 'history',
      llm: { ...DEFAULT_LLM },
      temperature: 0.1,
      max_tokens: 2000,
      system_prompt: '.sle/prompts/historian.md',
      artifact_slice: ['doc:decisions'],
      outputs: ['doc:decisions'],
      conditional: false,
      append_only: true,
    },
    facilitator: {
      active: true,
      node: null,
      llm: { ...DEFAULT_LLM },
      temperature: 0.4,
      max_tokens: 4000,
      system_prompt: '.sle/prompts/facilitator.md',
      artifact_slice: ['doc:requirements', 'doc:architecture', 'doc:test-plan', 'doc:decisions'],
      outputs: [
        'discovery:product_brief',
        'discovery:success_definition',
        'discovery:constraints',
        'discovery:stakeholders',
        'discovery:system_description',
        'discovery:vision',
        'discovery:open_questions',
        'discovery:project_plan',
      ],
      conditional: false,
      session_types: ['discovery', 'chat'],
    },
  },
};

export function generateDefaults(projectType: ProjectType): RuntimeConfig {
  return {
    planning: PLANNING_DEFAULTS[projectType],
    validation: {
      static_analysis: STATIC_ANALYSIS_DEFAULT,
      container: CONTAINER_DEFAULT,
      categories: CATEGORY_DEFAULTS[projectType],
    },
    artifacts: ARTIFACTS_DEFAULT,
    exit: EXIT_DEFAULT,
    user_validation: USER_VALIDATION_DEFAULT,
    summary: SUMMARY_DEFAULT,
    agents: AGENTS_DEFAULT,
  };
}

export function deepMerge<T extends Record<string, unknown>>(
  base: T,
  override: Partial<T>
): T {
  const result = { ...base } as Record<string, unknown>;
  for (const key of Object.keys(override as Record<string, unknown>)) {
    const overrideVal = (override as Record<string, unknown>)[key];
    if (overrideVal === undefined) continue;
    const baseVal = result[key];
    if (
      overrideVal !== null &&
      typeof overrideVal === 'object' &&
      !Array.isArray(overrideVal) &&
      baseVal !== null &&
      typeof baseVal === 'object' &&
      !Array.isArray(baseVal)
    ) {
      result[key] = deepMerge(
        baseVal as Record<string, unknown>,
        overrideVal as Record<string, unknown>
      );
    } else {
      result[key] = overrideVal;
    }
  }
  return result as T;
}

export function mergeRuleLayers(
  defaults: RuntimeConfig,
  rules: Partial<RuntimeConfig>,
  overrides?: Partial<RuntimeConfig>
): RuntimeConfig {
  const merged = overrides
    ? deepMerge(deepMerge(defaults as unknown as Record<string, unknown>, rules as Record<string, unknown>), overrides as Record<string, unknown>) as unknown as RuntimeConfig
    : deepMerge(defaults as unknown as Record<string, unknown>, rules as Record<string, unknown>) as unknown as RuntimeConfig;
  return validateRuntimeConfig(merged);
}

function validateRuntimeConfig(config: RuntimeConfig): RuntimeConfig {
  const result = RuntimeConfigSchema.safeParse(config);
  if (!result.success) {
    const errors = result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
    throw new RuleFileError('schema_violation', 'Merged config fails schema validation', errors);
  }
  return result.data as RuntimeConfig;
}

export function validateRuleFile(
  file: RuleFileName,
  content: unknown
): ValidationResult {
  const schemaMap: Record<RuleFileName, z.ZodSchema> = {
    planning: PlanningSchema,
    validation: ValidationSchema,
    artifacts: ArtifactsSchema,
    exit: ExitSchema,
    user_validation: UserValidationSchema,
    summary: SummarySchema,
    agents: AgentsSchema,
  };

  const schema = schemaMap[file];
  if (!schema) {
    return {
      success: false,
      errors: [{ path: '', message: `Unknown rule file: ${file}` }],
    };
  }

  const result = schema.safeParse(content);
  if (result.success) {
    return { success: true, errors: [] };
  }

  return {
    success: false,
    errors: result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  };
}

export function validateCrossFileConsistency(
  config: RuntimeConfig
): ConsistencyWarning[] {
  const warnings: ConsistencyWarning[] = [];
  const knownGenerators = new Set(Object.keys(config.agents.agents));
  knownGenerators.add('discovery');

  for (const artifact of config.artifacts.artifacts) {
    if (!knownGenerators.has(artifact.generator)) {
      warnings.push({
        type: 'unknown_generator',
        message: `Artifact '${artifact.id}' references unknown generator '${artifact.generator}'`,
        path: `artifacts.artifacts.${artifact.id}.generator`,
      });
    }
  }

  const artifactIds = new Set<string>();
  for (const artifact of config.artifacts.artifacts) {
    if (artifactIds.has(artifact.id)) {
      warnings.push({
        type: 'duplicate_artifact',
        message: `Duplicate artifact id '${artifact.id}'`,
        path: `artifacts.artifacts.${artifact.id}`,
      });
    }
    artifactIds.add(artifact.id);
  }

  const categoryNames = new Set<string>();
  for (const category of config.validation.categories) {
    if (categoryNames.has(category.name)) {
      warnings.push({
        type: 'duplicate_category',
        message: `Duplicate category name '${category.name}'`,
        path: `validation.categories.${category.name}`,
      });
    }
    categoryNames.add(category.name);
  }

  if (
    config.planning.critic_enabled === true &&
    config.agents.agents.critic &&
    !config.agents.agents.critic.active
  ) {
    warnings.push({
      type: 'depth_critic_mismatch',
      message: 'critic_enabled is true but critic agent is not active',
      path: 'planning.critic_enabled',
    });
  }

  return warnings;
}

export class RuleFileError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly errors: ValidationError[] = []
  ) {
    super(message);
    this.name = 'RuleFileError';
  }
}
