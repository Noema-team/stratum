import { test } from 'node:test';
import { strict as assert } from 'assert';
import {
  RULE_FILE_NAMES,
  LOADING_ORDER,
  generateDefaults,
  deepMerge,
  mergeRuleLayers,
  validateRuleFile,
  validateCrossFileConsistency,
  RuleFileError,
} from '../src/rule-files.js';
import type {
  ProjectType,
  RuntimeConfig,
  PlanningConfig,
  ValidationRuleCategory,
  AgentRoleConfig,
} from '../src/types.js';
import { RuntimeConfigSchema } from '../src/types.js';

const PROJECT_TYPES: ProjectType[] = ['api', 'ui', 'library', 'research', 'custom'];

const PLANNING_DEPTH_MAP: Record<ProjectType, string> = {
  api: 'standard',
  ui: 'standard',
  library: 'standard',
  research: 'research',
  custom: 'minimal',
};

const CATEGORY_COUNT_MAP: Record<ProjectType, number> = {
  api: 3,
  ui: 3,
  library: 3,
  research: 2,
  custom: 1,
};

test('testConstantsRuleFileNames', async () => {
  assert.strictEqual(RULE_FILE_NAMES.length, 7);
  assert.ok(RULE_FILE_NAMES.includes('planning'));
  assert.ok(RULE_FILE_NAMES.includes('validation'));
  assert.ok(RULE_FILE_NAMES.includes('artifacts'));
  assert.ok(RULE_FILE_NAMES.includes('exit'));
  assert.ok(RULE_FILE_NAMES.includes('user_validation'));
  assert.ok(RULE_FILE_NAMES.includes('summary'));
  assert.ok(RULE_FILE_NAMES.includes('agents'));
});

test('testConstantsLoadingOrder', async () => {
  assert.strictEqual(LOADING_ORDER[0], 'planning');
  assert.strictEqual(LOADING_ORDER[1], 'agents');
  assert.strictEqual(LOADING_ORDER[2], 'artifacts');
  assert.strictEqual(LOADING_ORDER[3], 'validation');
  assert.strictEqual(LOADING_ORDER[4], 'exit');
  assert.strictEqual(LOADING_ORDER[5], 'user_validation');
  assert.strictEqual(LOADING_ORDER[6], 'summary');
  assert.strictEqual(LOADING_ORDER.length, 7);
});

test('testGenerateDefaultsAllTypesValid', async () => {
  for (const pt of PROJECT_TYPES) {
    const config = generateDefaults(pt);
    const result = RuntimeConfigSchema.safeParse(config);
    assert.ok(result.success, `generateDefaults('${pt}') fails schema: ${result.success === false ? JSON.stringify(result.error.issues) : ''}`);
  }
});

test('testGenerateDefaultsPlanningDepth', async () => {
  for (const pt of PROJECT_TYPES) {
    const config = generateDefaults(pt);
    assert.strictEqual(config.planning.depth, PLANNING_DEPTH_MAP[pt], `depth mismatch for ${pt}`);
  }
});

test('testGenerateDefaultsPlanningResearchOverrides', async () => {
  const research = generateDefaults('research');
  assert.strictEqual(research.planning.depth, 'research');
  assert.strictEqual(research.planning.max_iterations, 10);
  assert.strictEqual(research.planning.artifact_slice_size, 4000);
  assert.strictEqual(research.planning.critic_enabled, true);
});

test('testGenerateDefaultsPlanningCustomOverrides', async () => {
  const custom = generateDefaults('custom');
  assert.strictEqual(custom.planning.depth, 'minimal');
  assert.strictEqual(custom.planning.max_iterations, 5);
  assert.strictEqual(custom.planning.critic_enabled, null);
});

test('testGenerateDefaultsPlanningReasoningPasses', async () => {
  for (const pt of PROJECT_TYPES) {
    const config = generateDefaults(pt);
    assert.strictEqual(config.planning.reasoning_passes.minimal, 1);
    assert.strictEqual(config.planning.reasoning_passes.standard, 2);
    assert.strictEqual(config.planning.reasoning_passes.deep, 3);
    assert.strictEqual(config.planning.reasoning_passes.research, 4);
  }
});

test('testGenerateDefaultsCategoryCounts', async () => {
  for (const pt of PROJECT_TYPES) {
    const config = generateDefaults(pt);
    assert.strictEqual(
      config.validation.categories.length,
      CATEGORY_COUNT_MAP[pt],
      `category count mismatch for ${pt}`
    );
  }
});

test('testGenerateDefaultsCorrectnessFirstCategory', async () => {
  for (const pt of PROJECT_TYPES) {
    const config = generateDefaults(pt);
    assert.strictEqual(config.validation.categories[0].name, 'correctness');
    assert.strictEqual(config.validation.categories[0].method, 'both');
  }
});

test('testGenerateDefaultsApiCategories', async () => {
  const config = generateDefaults('api');
  const names = config.validation.categories.map(c => c.name);
  assert.deepStrictEqual(names, ['correctness', 'performance', 'security']);
});

test('testGenerateDefaultsUiCategories', async () => {
  const config = generateDefaults('ui');
  const names = config.validation.categories.map(c => c.name);
  assert.deepStrictEqual(names, ['correctness', 'usability', 'performance']);
});

test('testGenerateDefaultsLibraryCategories', async () => {
  const config = generateDefaults('library');
  const names = config.validation.categories.map(c => c.name);
  assert.deepStrictEqual(names, ['correctness', 'compatibility', 'maintainability']);
});

test('testGenerateDefaultsResearchCategories', async () => {
  const config = generateDefaults('research');
  const names = config.validation.categories.map(c => c.name);
  assert.deepStrictEqual(names, ['correctness', 'reproducibility']);
});

test('testGenerateDefaultsCustomCategories', async () => {
  const config = generateDefaults('custom');
  const names = config.validation.categories.map(c => c.name);
  assert.deepStrictEqual(names, ['correctness']);
});

test('testGenerateDefaultsArtifacts', async () => {
  const config = generateDefaults('api');
  const ids = config.artifacts.artifacts.map(a => a.id);
  assert.ok(ids.includes('requirements'));
  assert.ok(ids.includes('architecture'));
  assert.ok(ids.includes('test-plan'));
  assert.ok(ids.includes('plan'));
  assert.ok(ids.includes('decisions'));
  assert.ok(ids.includes('evaluation'));
  assert.ok(ids.includes('build-plan'));
});

test('testGenerateDefaultsPlanArtifact', async () => {
  const config = generateDefaults('api');
  const plan = config.artifacts.artifacts.find(a => a.id === 'plan');
  assert.ok(plan, 'plan artifact missing');
  assert.strictEqual(plan.path, 'docs/plan.md');
  assert.strictEqual(plan.generator, 'planner');
  assert.strictEqual(plan.required, true);
  assert.strictEqual(plan.append_only, false);
});

test('testGenerateDefaultsDecisionsAppendOnly', async () => {
  const config = generateDefaults('api');
  const decisions = config.artifacts.artifacts.find(a => a.id === 'decisions');
  assert.ok(decisions);
  assert.strictEqual(decisions.append_only, true);
  assert.strictEqual(decisions.generator, 'historian');
});

test('testGenerateDefaultsGeneratedOutputs', async () => {
  const config = generateDefaults('api');
  assert.strictEqual(config.artifacts.generated_outputs.length, 3);
  assert.strictEqual(config.artifacts.generated_outputs[0].id, 'test_runner');
  assert.strictEqual(config.artifacts.generated_outputs[1].id, 'validation_report');
  assert.strictEqual(config.artifacts.generated_outputs[2].id, 'changelog');
});

test('testGenerateDefaultsExitConfig', async () => {
  const config = generateDefaults('api');
  assert.strictEqual(config.exit.conditions.all_categories_pass, true);
  assert.strictEqual(config.exit.conditions.requirements_met, true);
  assert.strictEqual(config.exit.on_cap_hit, 'halt_with_report');
  assert.strictEqual(config.exit.on_error.behavior, 'halt');
  assert.strictEqual(config.exit.halt_behavior.preserve_decisions, true);
});

test('testGenerateDefaultsUserValidation', async () => {
  const config = generateDefaults('api');
  assert.strictEqual(config.user_validation.approval_required, true);
  assert.deepStrictEqual(config.user_validation.review_at, ['after_planning', 'after_gate_pass']);
  assert.strictEqual(config.user_validation.timeout_minutes, 60);
  assert.strictEqual(config.user_validation.on_timeout, 'auto_approve');
  assert.strictEqual(config.user_validation.auto_approve_on_rerun, false);
});

test('testGenerateDefaultsSummary', async () => {
  const config = generateDefaults('api');
  assert.strictEqual(config.summary.format, 'markdown');
  assert.strictEqual(config.summary.test_command_format, 'shell');
  assert.strictEqual(config.summary.what_was_built_max_tokens, 300);
  assert.strictEqual(config.summary.next_steps_max_count, 3);
  assert.strictEqual(config.summary.output_path, 'reports/summary-{{version_id}}.md');
  assert.deepStrictEqual(config.summary.sections, [
    'what_was_built', 'what_changed', 'category_results', 'how_to_test', 'next_steps',
  ]);
});

test('testGenerateDefaultsAgentsTenRoles', async () => {
  const config = generateDefaults('api');
  const agentKeys = Object.keys(config.agents.agents);
  assert.strictEqual(agentKeys.length, 10);
  for (const role of ['designer', 'explorer', 'planner', 'tester', 'builder', 'debugger', 'evaluator', 'critic', 'historian', 'facilitator']) {
    assert.ok(agentKeys.includes(role), `missing agent role: ${role}`);
  }
});

test('testGenerateDefaultsExplorerDisabled', async () => {
  const config = generateDefaults('api');
  assert.strictEqual(config.agents.agents.explorer.active, false);
  assert.strictEqual(config.agents.agents.explorer.conditional, true);
  assert.strictEqual(config.agents.agents.explorer.condition, 'user_initiated');
});

test('testGenerateDefaultsBuilderMaxTokens', async () => {
  const config = generateDefaults('api');
  assert.strictEqual(config.agents.agents.builder.max_tokens, 16000);
});

test('testGenerateDefaultsCriticConditional', async () => {
  const config = generateDefaults('api');
  assert.strictEqual(config.agents.agents.critic.conditional, true);
  assert.strictEqual(config.agents.agents.critic.condition, 'depth_deep_or_research');
  assert.strictEqual(config.agents.agents.critic.trigger_node, 'design');
});

test('testGenerateDefaultsFacilitatorNullNode', async () => {
  const config = generateDefaults('api');
  assert.strictEqual(config.agents.agents.facilitator.node, null);
  assert.deepStrictEqual(config.agents.agents.facilitator.session_types, ['discovery', 'chat']);
});

test('testGenerateDefaultsHistorianAppendOnly', async () => {
  const config = generateDefaults('api');
  assert.strictEqual(config.agents.agents.historian.append_only, true);
});

test('testGenerateDefaultsTesterConstraints', async () => {
  const config = generateDefaults('api');
  assert.deepStrictEqual(config.agents.agents.tester.constraints, ['never_sees_builder_output']);
});

test('testGenerateDefaultsProviders', async () => {
  const config = generateDefaults('api');
  assert.ok(config.agents.providers.openai);
  assert.ok(config.agents.providers.openrouter);
  assert.ok(config.agents.providers.glm);
  assert.ok(config.agents.providers.zai);
  assert.ok(config.agents.providers.anthropic);
});

test('testGenerateDefaultsStaticAnalysis', async () => {
  const config = generateDefaults('api');
  assert.strictEqual(config.validation.static_analysis.lint.enabled, true);
  assert.strictEqual(config.validation.static_analysis.typecheck.enabled, true);
  assert.strictEqual(config.validation.static_analysis.complexity.enabled, true);
  assert.strictEqual(config.validation.static_analysis.lint.pass_criteria.max_errors, 0);
  assert.strictEqual(config.validation.static_analysis.complexity.pass_criteria.max_complexity, 15);
});

test('testGenerateDefaultsContainer', async () => {
  const config = generateDefaults('api');
  assert.strictEqual(config.validation.container.base_image, 'node:20-slim');
  assert.strictEqual(config.validation.container.install_command, 'npm install');
  assert.strictEqual(config.validation.container.timeout_ms, 120000);
});

test('testDeepMergeFlat', async () => {
  const base = { a: 1, b: 2, c: 3 };
  const result = deepMerge(base, { b: 20 });
  assert.deepStrictEqual(result, { a: 1, b: 20, c: 3 });
});

test('testDeepMergeNested', async () => {
  const base = { a: { x: 1, y: 2 }, b: 3 };
  const result = deepMerge(base, { a: { y: 20 } });
  assert.deepStrictEqual(result, { a: { x: 1, y: 20 }, b: 3 });
});

test('testDeepMergeArrayReplaceWholesale', async () => {
  const base = { items: [1, 2, 3] };
  const result = deepMerge(base, { items: [10, 20] });
  assert.deepStrictEqual(result, { items: [10, 20] });
});

test('testDeepMergeUndefinedSkipped', async () => {
  const base = { a: 1, b: 2, c: 3 };
  const result = deepMerge(base, { b: undefined, c: 30 });
  assert.deepStrictEqual(result, { a: 1, b: 2, c: 30 });
});

test('testDeepMergeDeeplyNested', async () => {
  const base = { a: { b: { c: { d: 1 } } } };
  const result = deepMerge(base, { a: { b: { c: { d: 99 } } } });
  assert.deepStrictEqual(result, { a: { b: { c: { d: 99 } } } });
});

test('testDeepMergeNullOverride', async () => {
  const base = { a: { x: 1 }, b: 2 };
  const result = deepMerge(base, { a: null });
  assert.deepStrictEqual(result, { a: null, b: 2 });
});

test('testMergeRuleLayersNoOverrides', async () => {
  const defaults = generateDefaults('api');
  const result = mergeRuleLayers(defaults, {});
  assert.strictEqual(result.planning.depth, 'standard');
  assert.strictEqual(result.planning.max_iterations, 5);
});

test('testMergeRuleLayersWithRules', async () => {
  const defaults = generateDefaults('api');
  const result = mergeRuleLayers(defaults, {
    planning: { max_iterations: 3 } as any,
  });
  assert.strictEqual(result.planning.max_iterations, 3);
  assert.strictEqual(result.planning.depth, 'standard');
});

test('testMergeRuleLayersWithOverrides', async () => {
  const defaults = generateDefaults('api');
  const result = mergeRuleLayers(
    defaults,
    { planning: { max_iterations: 3 } as any },
    { planning: { max_iterations: 7 } as any }
  );
  assert.strictEqual(result.planning.max_iterations, 7);
});

test('testMergeRuleLayersInvalidThrows', async () => {
  const defaults = generateDefaults('api');
  assert.throws(() => {
    mergeRuleLayers(defaults, { planning: { depth: 'invalid' } as any });
  }, RuleFileError);
});

test('testValidateRuleFileValidPlanning', async () => {
  const config = generateDefaults('api');
  const result = validateRuleFile('planning', config.planning);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.errors.length, 0);
});

test('testValidateRuleFileInvalidPlanning', async () => {
  const result = validateRuleFile('planning', { depth: 'bad', max_iterations: -1 });
  assert.strictEqual(result.success, false);
  assert.ok(result.errors.length > 0);
});

test('testValidateRuleFileValidAgents', async () => {
  const config = generateDefaults('api');
  const result = validateRuleFile('agents', config.agents);
  assert.strictEqual(result.success, true);
});

test('testValidateRuleFileInvalidAgents', async () => {
  const result = validateRuleFile('agents', { defaults: {} });
  assert.strictEqual(result.success, false);
});

test('testValidateRuleFileValidArtifacts', async () => {
  const config = generateDefaults('api');
  const result = validateRuleFile('artifacts', config.artifacts);
  assert.strictEqual(result.success, true);
});

test('testValidateRuleFileValidValidation', async () => {
  const config = generateDefaults('api');
  const result = validateRuleFile('validation', config.validation);
  assert.strictEqual(result.success, true);
});

test('testValidateRuleFileValidExit', async () => {
  const config = generateDefaults('api');
  const result = validateRuleFile('exit', config.exit);
  assert.strictEqual(result.success, true);
});

test('testValidateRuleFileValidUserValidation', async () => {
  const config = generateDefaults('api');
  const result = validateRuleFile('user_validation', config.user_validation);
  assert.strictEqual(result.success, true);
});

test('testValidateRuleFileValidSummary', async () => {
  const config = generateDefaults('api');
  const result = validateRuleFile('summary', config.summary);
  assert.strictEqual(result.success, true);
});

test('testValidateRuleFileAllTypes', async () => {
  for (const pt of PROJECT_TYPES) {
    const config = generateDefaults(pt);
    for (const fileName of RULE_FILE_NAMES) {
      const section = config[fileName as keyof RuntimeConfig];
      const result = validateRuleFile(fileName, section);
      assert.strictEqual(result.success, true, `validateRuleFile('${fileName}', '${pt}') failed`);
    }
  }
});

test('testValidateCrossFileConsistencyClean', async () => {
  for (const pt of PROJECT_TYPES) {
    const config = generateDefaults(pt);
    const warnings = validateCrossFileConsistency(config);
    assert.strictEqual(warnings.length, 0, `unexpected warnings for ${pt}: ${JSON.stringify(warnings)}`);
  }
});

test('testValidateCrossFileConsistencyUnknownGenerator', async () => {
  const config = generateDefaults('api');
  config.artifacts.artifacts.push({
    id: 'bogus',
    path: 'docs/bogus.md',
    generator: 'nonexistent_agent' as any,
    required: false,
    append_only: false,
    format: 'markdown',
  });
  const warnings = validateCrossFileConsistency(config);
  const found = warnings.filter(w => w.type === 'unknown_generator');
  assert.strictEqual(found.length, 1);
});

test('testValidateCrossFileConsistencyDuplicateArtifact', async () => {
  const config = generateDefaults('api');
  config.artifacts.artifacts.push({ ...config.artifacts.artifacts[0] });
  const warnings = validateCrossFileConsistency(config);
  const found = warnings.filter(w => w.type === 'duplicate_artifact');
  assert.strictEqual(found.length, 1);
});

test('testValidateCrossFileConsistencyDuplicateCategory', async () => {
  const config = generateDefaults('api');
  config.validation.categories.push({ ...config.validation.categories[0] });
  const warnings = validateCrossFileConsistency(config);
  const found = warnings.filter(w => w.type === 'duplicate_category');
  assert.strictEqual(found.length, 1);
});

test('testValidateCrossFileConsistencyDepthCriticMismatch', async () => {
  const config = generateDefaults('api');
  config.planning.critic_enabled = true;
  config.agents.agents.critic.active = false;
  const warnings = validateCrossFileConsistency(config);
  const mismatch = warnings.find(w => w.type === 'depth_critic_mismatch');
  assert.ok(mismatch, 'expected depth_critic_mismatch warning');
});

test('testRuleFileErrorClass', async () => {
  const err = new RuleFileError('test_code', 'test message', [{ path: 'a.b', message: 'bad' }]);
  assert.strictEqual(err.name, 'RuleFileError');
  assert.strictEqual(err.code, 'test_code');
  assert.strictEqual(err.message, 'test message');
  assert.strictEqual(err.errors.length, 1);
  assert.ok(err instanceof Error);
});

test('testMergeArrayReplaceWholesale', async () => {
  const defaults = generateDefaults('api');
  const customCategories: ValidationRuleCategory[] = [
    {
      name: 'custom_cat',
      method: 'llm',
      llm: {
        artifact_slice: ['doc:requirements'],
        prompt_template: '.sle/prompts/custom.md',
        pass_threshold: 0.8,
      },
      pass_criteria: { llm: 'verdict_pass' },
      on_fail: { feed_to: 'planner', include: ['llm_issues'] },
    },
  ];
  const result = mergeRuleLayers(defaults, {
    validation: { categories: customCategories } as any,
  });
  assert.strictEqual(result.validation.categories.length, 1);
  assert.strictEqual(result.validation.categories[0].name, 'custom_cat');
});

test('testMergeDoesNotMutateDefaults', async () => {
  const original = generateDefaults('api');
  const origIterations = original.planning.max_iterations;
  const origDepth = original.planning.depth;
  mergeRuleLayers(original, { planning: { max_iterations: 10 } as any });
  assert.strictEqual(original.planning.max_iterations, origIterations);
  assert.strictEqual(original.planning.depth, origDepth);
});
