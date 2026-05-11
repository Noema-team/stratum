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

async function testConstantsRuleFileNames() {
  assert.strictEqual(RULE_FILE_NAMES.length, 7);
  assert.ok(RULE_FILE_NAMES.includes('planning'));
  assert.ok(RULE_FILE_NAMES.includes('validation'));
  assert.ok(RULE_FILE_NAMES.includes('artifacts'));
  assert.ok(RULE_FILE_NAMES.includes('exit'));
  assert.ok(RULE_FILE_NAMES.includes('user_validation'));
  assert.ok(RULE_FILE_NAMES.includes('summary'));
  assert.ok(RULE_FILE_NAMES.includes('agents'));
}

async function testConstantsLoadingOrder() {
  assert.strictEqual(LOADING_ORDER[0], 'planning');
  assert.strictEqual(LOADING_ORDER[1], 'agents');
  assert.strictEqual(LOADING_ORDER[2], 'artifacts');
  assert.strictEqual(LOADING_ORDER[3], 'validation');
  assert.strictEqual(LOADING_ORDER[4], 'exit');
  assert.strictEqual(LOADING_ORDER[5], 'user_validation');
  assert.strictEqual(LOADING_ORDER[6], 'summary');
  assert.strictEqual(LOADING_ORDER.length, 7);
}

async function testGenerateDefaultsAllTypesValid() {
  for (const pt of PROJECT_TYPES) {
    const config = generateDefaults(pt);
    const result = RuntimeConfigSchema.safeParse(config);
    assert.ok(result.success, `generateDefaults('${pt}') fails schema: ${result.success === false ? JSON.stringify(result.error.issues) : ''}`);
  }
}

async function testGenerateDefaultsPlanningDepth() {
  for (const pt of PROJECT_TYPES) {
    const config = generateDefaults(pt);
    assert.strictEqual(config.planning.depth, PLANNING_DEPTH_MAP[pt], `depth mismatch for ${pt}`);
  }
}

async function testGenerateDefaultsPlanningResearchOverrides() {
  const research = generateDefaults('research');
  assert.strictEqual(research.planning.depth, 'research');
  assert.strictEqual(research.planning.max_iterations, 10);
  assert.strictEqual(research.planning.artifact_slice_size, 4000);
  assert.strictEqual(research.planning.critic_enabled, true);
}

async function testGenerateDefaultsPlanningCustomOverrides() {
  const custom = generateDefaults('custom');
  assert.strictEqual(custom.planning.depth, 'minimal');
  assert.strictEqual(custom.planning.max_iterations, 5);
  assert.strictEqual(custom.planning.critic_enabled, null);
}

async function testGenerateDefaultsPlanningReasoningPasses() {
  for (const pt of PROJECT_TYPES) {
    const config = generateDefaults(pt);
    assert.strictEqual(config.planning.reasoning_passes.minimal, 1);
    assert.strictEqual(config.planning.reasoning_passes.standard, 2);
    assert.strictEqual(config.planning.reasoning_passes.deep, 3);
    assert.strictEqual(config.planning.reasoning_passes.research, 4);
  }
}

async function testGenerateDefaultsCategoryCounts() {
  for (const pt of PROJECT_TYPES) {
    const config = generateDefaults(pt);
    assert.strictEqual(
      config.validation.categories.length,
      CATEGORY_COUNT_MAP[pt],
      `category count mismatch for ${pt}`
    );
  }
}

async function testGenerateDefaultsCorrectnessFirstCategory() {
  for (const pt of PROJECT_TYPES) {
    const config = generateDefaults(pt);
    assert.strictEqual(config.validation.categories[0].name, 'correctness');
    assert.strictEqual(config.validation.categories[0].method, 'both');
  }
}

async function testGenerateDefaultsApiCategories() {
  const config = generateDefaults('api');
  const names = config.validation.categories.map(c => c.name);
  assert.deepStrictEqual(names, ['correctness', 'performance', 'security']);
}

async function testGenerateDefaultsUiCategories() {
  const config = generateDefaults('ui');
  const names = config.validation.categories.map(c => c.name);
  assert.deepStrictEqual(names, ['correctness', 'usability', 'performance']);
}

async function testGenerateDefaultsLibraryCategories() {
  const config = generateDefaults('library');
  const names = config.validation.categories.map(c => c.name);
  assert.deepStrictEqual(names, ['correctness', 'compatibility', 'maintainability']);
}

async function testGenerateDefaultsResearchCategories() {
  const config = generateDefaults('research');
  const names = config.validation.categories.map(c => c.name);
  assert.deepStrictEqual(names, ['correctness', 'reproducibility']);
}

async function testGenerateDefaultsCustomCategories() {
  const config = generateDefaults('custom');
  const names = config.validation.categories.map(c => c.name);
  assert.deepStrictEqual(names, ['correctness']);
}

async function testGenerateDefaultsArtifacts() {
  const config = generateDefaults('api');
  const ids = config.artifacts.artifacts.map(a => a.id);
  assert.ok(ids.includes('requirements'));
  assert.ok(ids.includes('architecture'));
  assert.ok(ids.includes('test-plan'));
  assert.ok(ids.includes('plan'));
  assert.ok(ids.includes('decisions'));
  assert.ok(ids.includes('evaluation'));
  assert.ok(ids.includes('build-plan'));
}

async function testGenerateDefaultsPlanArtifact() {
  const config = generateDefaults('api');
  const plan = config.artifacts.artifacts.find(a => a.id === 'plan');
  assert.ok(plan, 'plan artifact missing');
  assert.strictEqual(plan.path, 'docs/plan.md');
  assert.strictEqual(plan.generator, 'planner');
  assert.strictEqual(plan.required, true);
  assert.strictEqual(plan.append_only, false);
}

async function testGenerateDefaultsDecisionsAppendOnly() {
  const config = generateDefaults('api');
  const decisions = config.artifacts.artifacts.find(a => a.id === 'decisions');
  assert.ok(decisions);
  assert.strictEqual(decisions.append_only, true);
  assert.strictEqual(decisions.generator, 'historian');
}

async function testGenerateDefaultsGeneratedOutputs() {
  const config = generateDefaults('api');
  assert.strictEqual(config.artifacts.generated_outputs.length, 3);
  assert.strictEqual(config.artifacts.generated_outputs[0].id, 'test_runner');
  assert.strictEqual(config.artifacts.generated_outputs[1].id, 'validation_report');
  assert.strictEqual(config.artifacts.generated_outputs[2].id, 'changelog');
}

async function testGenerateDefaultsExitConfig() {
  const config = generateDefaults('api');
  assert.strictEqual(config.exit.conditions.all_categories_pass, true);
  assert.strictEqual(config.exit.conditions.requirements_met, true);
  assert.strictEqual(config.exit.on_cap_hit, 'halt_with_report');
  assert.strictEqual(config.exit.on_error.behavior, 'halt');
  assert.strictEqual(config.exit.halt_behavior.preserve_decisions, true);
}

async function testGenerateDefaultsUserValidation() {
  const config = generateDefaults('api');
  assert.strictEqual(config.user_validation.approval_required, true);
  assert.deepStrictEqual(config.user_validation.review_at, ['after_planning', 'after_gate_pass']);
  assert.strictEqual(config.user_validation.timeout_minutes, 60);
  assert.strictEqual(config.user_validation.on_timeout, 'auto_approve');
  assert.strictEqual(config.user_validation.auto_approve_on_rerun, false);
}

async function testGenerateDefaultsSummary() {
  const config = generateDefaults('api');
  assert.strictEqual(config.summary.format, 'markdown');
  assert.strictEqual(config.summary.test_command_format, 'shell');
  assert.strictEqual(config.summary.what_was_built_max_tokens, 300);
  assert.strictEqual(config.summary.next_steps_max_count, 3);
  assert.strictEqual(config.summary.output_path, 'reports/summary-{{version_id}}.md');
  assert.deepStrictEqual(config.summary.sections, [
    'what_was_built', 'what_changed', 'category_results', 'how_to_test', 'next_steps',
  ]);
}

async function testGenerateDefaultsAgentsTenRoles() {
  const config = generateDefaults('api');
  const agentKeys = Object.keys(config.agents.agents);
  assert.strictEqual(agentKeys.length, 10);
  for (const role of ['designer', 'explorer', 'planner', 'tester', 'builder', 'debugger', 'evaluator', 'critic', 'historian', 'facilitator']) {
    assert.ok(agentKeys.includes(role), `missing agent role: ${role}`);
  }
}

async function testGenerateDefaultsExplorerDisabled() {
  const config = generateDefaults('api');
  assert.strictEqual(config.agents.agents.explorer.active, false);
  assert.strictEqual(config.agents.agents.explorer.conditional, true);
  assert.strictEqual(config.agents.agents.explorer.condition, 'user_initiated');
}

async function testGenerateDefaultsBuilderMaxTokens() {
  const config = generateDefaults('api');
  assert.strictEqual(config.agents.agents.builder.max_tokens, 16000);
}

async function testGenerateDefaultsCriticConditional() {
  const config = generateDefaults('api');
  assert.strictEqual(config.agents.agents.critic.conditional, true);
  assert.strictEqual(config.agents.agents.critic.condition, 'depth_deep_or_research');
  assert.strictEqual(config.agents.agents.critic.trigger_node, 'design');
}

async function testGenerateDefaultsFacilitatorNullNode() {
  const config = generateDefaults('api');
  assert.strictEqual(config.agents.agents.facilitator.node, null);
  assert.deepStrictEqual(config.agents.agents.facilitator.session_types, ['discovery', 'chat']);
}

async function testGenerateDefaultsHistorianAppendOnly() {
  const config = generateDefaults('api');
  assert.strictEqual(config.agents.agents.historian.append_only, true);
}

async function testGenerateDefaultsTesterConstraints() {
  const config = generateDefaults('api');
  assert.deepStrictEqual(config.agents.agents.tester.constraints, ['never_sees_builder_output']);
}

async function testGenerateDefaultsProviders() {
  const config = generateDefaults('api');
  assert.ok(config.agents.providers.openai);
  assert.ok(config.agents.providers.openrouter);
  assert.ok(config.agents.providers.glm);
  assert.ok(config.agents.providers.zai);
  assert.ok(config.agents.providers.anthropic);
}

async function testGenerateDefaultsStaticAnalysis() {
  const config = generateDefaults('api');
  assert.strictEqual(config.validation.static_analysis.lint.enabled, true);
  assert.strictEqual(config.validation.static_analysis.typecheck.enabled, true);
  assert.strictEqual(config.validation.static_analysis.complexity.enabled, true);
  assert.strictEqual(config.validation.static_analysis.lint.pass_criteria.max_errors, 0);
  assert.strictEqual(config.validation.static_analysis.complexity.pass_criteria.max_complexity, 15);
}

async function testGenerateDefaultsContainer() {
  const config = generateDefaults('api');
  assert.strictEqual(config.validation.container.base_image, 'node:20-slim');
  assert.strictEqual(config.validation.container.install_command, 'npm install');
  assert.strictEqual(config.validation.container.timeout_ms, 120000);
}

async function testDeepMergeFlat() {
  const base = { a: 1, b: 2, c: 3 };
  const result = deepMerge(base, { b: 20 });
  assert.deepStrictEqual(result, { a: 1, b: 20, c: 3 });
}

async function testDeepMergeNested() {
  const base = { a: { x: 1, y: 2 }, b: 3 };
  const result = deepMerge(base, { a: { y: 20 } });
  assert.deepStrictEqual(result, { a: { x: 1, y: 20 }, b: 3 });
}

async function testDeepMergeArrayReplaceWholesale() {
  const base = { items: [1, 2, 3] };
  const result = deepMerge(base, { items: [10, 20] });
  assert.deepStrictEqual(result, { items: [10, 20] });
}

async function testDeepMergeUndefinedSkipped() {
  const base = { a: 1, b: 2, c: 3 };
  const result = deepMerge(base, { b: undefined, c: 30 });
  assert.deepStrictEqual(result, { a: 1, b: 2, c: 30 });
}

async function testDeepMergeDeeplyNested() {
  const base = { a: { b: { c: { d: 1 } } } };
  const result = deepMerge(base, { a: { b: { c: { d: 99 } } } });
  assert.deepStrictEqual(result, { a: { b: { c: { d: 99 } } } });
}

async function testDeepMergeNullOverride() {
  const base = { a: { x: 1 }, b: 2 };
  const result = deepMerge(base, { a: null });
  assert.deepStrictEqual(result, { a: null, b: 2 });
}

async function testMergeRuleLayersNoOverrides() {
  const defaults = generateDefaults('api');
  const result = mergeRuleLayers(defaults, {});
  assert.strictEqual(result.planning.depth, 'standard');
  assert.strictEqual(result.planning.max_iterations, 5);
}

async function testMergeRuleLayersWithRules() {
  const defaults = generateDefaults('api');
  const result = mergeRuleLayers(defaults, {
    planning: { max_iterations: 3 } as any,
  });
  assert.strictEqual(result.planning.max_iterations, 3);
  assert.strictEqual(result.planning.depth, 'standard');
}

async function testMergeRuleLayersWithOverrides() {
  const defaults = generateDefaults('api');
  const result = mergeRuleLayers(
    defaults,
    { planning: { max_iterations: 3 } as any },
    { planning: { max_iterations: 7 } as any }
  );
  assert.strictEqual(result.planning.max_iterations, 7);
}

async function testMergeRuleLayersInvalidThrows() {
  const defaults = generateDefaults('api');
  assert.throws(() => {
    mergeRuleLayers(defaults, { planning: { depth: 'invalid' } as any });
  }, RuleFileError);
}

async function testValidateRuleFileValidPlanning() {
  const config = generateDefaults('api');
  const result = validateRuleFile('planning', config.planning);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.errors.length, 0);
}

async function testValidateRuleFileInvalidPlanning() {
  const result = validateRuleFile('planning', { depth: 'bad', max_iterations: -1 });
  assert.strictEqual(result.success, false);
  assert.ok(result.errors.length > 0);
}

async function testValidateRuleFileValidAgents() {
  const config = generateDefaults('api');
  const result = validateRuleFile('agents', config.agents);
  assert.strictEqual(result.success, true);
}

async function testValidateRuleFileInvalidAgents() {
  const result = validateRuleFile('agents', { defaults: {} });
  assert.strictEqual(result.success, false);
}

async function testValidateRuleFileValidArtifacts() {
  const config = generateDefaults('api');
  const result = validateRuleFile('artifacts', config.artifacts);
  assert.strictEqual(result.success, true);
}

async function testValidateRuleFileValidValidation() {
  const config = generateDefaults('api');
  const result = validateRuleFile('validation', config.validation);
  assert.strictEqual(result.success, true);
}

async function testValidateRuleFileValidExit() {
  const config = generateDefaults('api');
  const result = validateRuleFile('exit', config.exit);
  assert.strictEqual(result.success, true);
}

async function testValidateRuleFileValidUserValidation() {
  const config = generateDefaults('api');
  const result = validateRuleFile('user_validation', config.user_validation);
  assert.strictEqual(result.success, true);
}

async function testValidateRuleFileValidSummary() {
  const config = generateDefaults('api');
  const result = validateRuleFile('summary', config.summary);
  assert.strictEqual(result.success, true);
}

async function testValidateRuleFileAllTypes() {
  for (const pt of PROJECT_TYPES) {
    const config = generateDefaults(pt);
    for (const fileName of RULE_FILE_NAMES) {
      const section = config[fileName as keyof RuntimeConfig];
      const result = validateRuleFile(fileName, section);
      assert.strictEqual(result.success, true, `validateRuleFile('${fileName}', '${pt}') failed`);
    }
  }
}

async function testValidateCrossFileConsistencyClean() {
  for (const pt of PROJECT_TYPES) {
    const config = generateDefaults(pt);
    const warnings = validateCrossFileConsistency(config);
    assert.strictEqual(warnings.length, 0, `unexpected warnings for ${pt}: ${JSON.stringify(warnings)}`);
  }
}

async function testValidateCrossFileConsistencyUnknownGenerator() {
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
}

async function testValidateCrossFileConsistencyDuplicateArtifact() {
  const config = generateDefaults('api');
  config.artifacts.artifacts.push({ ...config.artifacts.artifacts[0] });
  const warnings = validateCrossFileConsistency(config);
  const found = warnings.filter(w => w.type === 'duplicate_artifact');
  assert.strictEqual(found.length, 1);
}

async function testValidateCrossFileConsistencyDuplicateCategory() {
  const config = generateDefaults('api');
  config.validation.categories.push({ ...config.validation.categories[0] });
  const warnings = validateCrossFileConsistency(config);
  const found = warnings.filter(w => w.type === 'duplicate_category');
  assert.strictEqual(found.length, 1);
}

async function testValidateCrossFileConsistencyDepthCriticMismatch() {
  const config = generateDefaults('api');
  config.planning.critic_enabled = true;
  config.agents.agents.critic.active = false;
  const warnings = validateCrossFileConsistency(config);
  const mismatch = warnings.find(w => w.type === 'depth_critic_mismatch');
  assert.ok(mismatch, 'expected depth_critic_mismatch warning');
}

async function testRuleFileErrorClass() {
  const err = new RuleFileError('test_code', 'test message', [{ path: 'a.b', message: 'bad' }]);
  assert.strictEqual(err.name, 'RuleFileError');
  assert.strictEqual(err.code, 'test_code');
  assert.strictEqual(err.message, 'test message');
  assert.strictEqual(err.errors.length, 1);
  assert.ok(err instanceof Error);
}

async function testMergeArrayReplaceWholesale() {
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
}

async function testMergeDoesNotMutateDefaults() {
  const original = generateDefaults('api');
  const origIterations = original.planning.max_iterations;
  const origDepth = original.planning.depth;
  mergeRuleLayers(original, { planning: { max_iterations: 10 } as any });
  assert.strictEqual(original.planning.max_iterations, origIterations);
  assert.strictEqual(original.planning.depth, origDepth);
}

async function runAllTests() {
  console.log('Running Phase D (Rule Files) tests...');

  const tests = [
    { name: 'Constants: rule file names', fn: testConstantsRuleFileNames },
    { name: 'Constants: loading order', fn: testConstantsLoadingOrder },

    { name: 'Generate defaults: all types valid', fn: testGenerateDefaultsAllTypesValid },
    { name: 'Generate defaults: planning depth per type', fn: testGenerateDefaultsPlanningDepth },
    { name: 'Generate defaults: research planning overrides', fn: testGenerateDefaultsPlanningResearchOverrides },
    { name: 'Generate defaults: custom planning overrides', fn: testGenerateDefaultsPlanningCustomOverrides },
    { name: 'Generate defaults: reasoning passes', fn: testGenerateDefaultsPlanningReasoningPasses },
    { name: 'Generate defaults: category counts', fn: testGenerateDefaultsCategoryCounts },
    { name: 'Generate defaults: correctness first category', fn: testGenerateDefaultsCorrectnessFirstCategory },
    { name: 'Generate defaults: api categories', fn: testGenerateDefaultsApiCategories },
    { name: 'Generate defaults: ui categories', fn: testGenerateDefaultsUiCategories },
    { name: 'Generate defaults: library categories', fn: testGenerateDefaultsLibraryCategories },
    { name: 'Generate defaults: research categories', fn: testGenerateDefaultsResearchCategories },
    { name: 'Generate defaults: custom categories', fn: testGenerateDefaultsCustomCategories },

    { name: 'Generate defaults: artifact ids', fn: testGenerateDefaultsArtifacts },
    { name: 'Generate defaults: plan artifact', fn: testGenerateDefaultsPlanArtifact },
    { name: 'Generate defaults: decisions append-only', fn: testGenerateDefaultsDecisionsAppendOnly },
    { name: 'Generate defaults: generated outputs', fn: testGenerateDefaultsGeneratedOutputs },

    { name: 'Generate defaults: exit config', fn: testGenerateDefaultsExitConfig },
    { name: 'Generate defaults: user validation', fn: testGenerateDefaultsUserValidation },
    { name: 'Generate defaults: summary config', fn: testGenerateDefaultsSummary },

    { name: 'Generate defaults: 10 agent roles', fn: testGenerateDefaultsAgentsTenRoles },
    { name: 'Generate defaults: explorer disabled', fn: testGenerateDefaultsExplorerDisabled },
    { name: 'Generate defaults: builder max tokens', fn: testGenerateDefaultsBuilderMaxTokens },
    { name: 'Generate defaults: critic conditional', fn: testGenerateDefaultsCriticConditional },
    { name: 'Generate defaults: facilitator null node', fn: testGenerateDefaultsFacilitatorNullNode },
    { name: 'Generate defaults: historian append-only', fn: testGenerateDefaultsHistorianAppendOnly },
    { name: 'Generate defaults: tester constraints', fn: testGenerateDefaultsTesterConstraints },
    { name: 'Generate defaults: providers', fn: testGenerateDefaultsProviders },

    { name: 'Generate defaults: static analysis', fn: testGenerateDefaultsStaticAnalysis },
    { name: 'Generate defaults: container', fn: testGenerateDefaultsContainer },

    { name: 'Deep merge: flat', fn: testDeepMergeFlat },
    { name: 'Deep merge: nested', fn: testDeepMergeNested },
    { name: 'Deep merge: array wholesale', fn: testDeepMergeArrayReplaceWholesale },
    { name: 'Deep merge: undefined skipped', fn: testDeepMergeUndefinedSkipped },
    { name: 'Deep merge: deeply nested', fn: testDeepMergeDeeplyNested },
    { name: 'Deep merge: null override', fn: testDeepMergeNullOverride },

    { name: 'Merge rule layers: no overrides', fn: testMergeRuleLayersNoOverrides },
    { name: 'Merge rule layers: with rules', fn: testMergeRuleLayersWithRules },
    { name: 'Merge rule layers: with overrides', fn: testMergeRuleLayersWithOverrides },
    { name: 'Merge rule layers: invalid throws', fn: testMergeRuleLayersInvalidThrows },
    { name: 'Merge: array replace wholesale', fn: testMergeArrayReplaceWholesale },
    { name: 'Merge: does not mutate defaults', fn: testMergeDoesNotMutateDefaults },

    { name: 'Validate rule file: valid planning', fn: testValidateRuleFileValidPlanning },
    { name: 'Validate rule file: invalid planning', fn: testValidateRuleFileInvalidPlanning },
    { name: 'Validate rule file: valid agents', fn: testValidateRuleFileValidAgents },
    { name: 'Validate rule file: invalid agents', fn: testValidateRuleFileInvalidAgents },
    { name: 'Validate rule file: valid artifacts', fn: testValidateRuleFileValidArtifacts },
    { name: 'Validate rule file: valid validation', fn: testValidateRuleFileValidValidation },
    { name: 'Validate rule file: valid exit', fn: testValidateRuleFileValidExit },
    { name: 'Validate rule file: valid user validation', fn: testValidateRuleFileValidUserValidation },
    { name: 'Validate rule file: valid summary', fn: testValidateRuleFileValidSummary },
    { name: 'Validate rule file: all files all types', fn: testValidateRuleFileAllTypes },

    { name: 'Cross-file: clean config', fn: testValidateCrossFileConsistencyClean },
    { name: 'Cross-file: unknown generator', fn: testValidateCrossFileConsistencyUnknownGenerator },
    { name: 'Cross-file: duplicate artifact', fn: testValidateCrossFileConsistencyDuplicateArtifact },
    { name: 'Cross-file: duplicate category', fn: testValidateCrossFileConsistencyDuplicateCategory },
    { name: 'Cross-file: depth critic mismatch', fn: testValidateCrossFileConsistencyDepthCriticMismatch },

    { name: 'RuleFileError class', fn: testRuleFileErrorClass },
  ];

  for (const test of tests) {
    try {
      await test.fn();
      console.log(`  ✓ ${test.name}`);
    } catch (error) {
      console.error(`  ✗ ${test.name}`);
      throw error;
    }
  }

  console.log(`\n✅ All ${tests.length} Phase D tests passed!`);
}

runAllTests();
