import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { generateDefaults, validateRuleFile, type RuleFileName } from '../src/rule-files.js';
import type { ProjectType } from '../src/types.js';

// ─── Tests ───────────────────────────────────────────────────────────

test('testGenerateDefaultsCreatesAllSections', async () => {
  const config = generateDefaults('api');
  assert.ok(config.planning);
  assert.ok(config.validation);
  assert.ok(config.artifacts);
  assert.ok(config.exit);
  assert.ok(config.user_validation);
  assert.ok(config.summary);
  assert.ok(config.agents);
});

test('testGeneratedPlanningPassesValidation', async () => {
  const config = generateDefaults('api');
  const result = validateRuleFile('planning', config.planning);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.errors.length, 0);
});

test('testGeneratedAgentsIncludesAllRoles', async () => {
  const config = generateDefaults('api');
  const result = validateRuleFile('agents', config.agents);
  assert.strictEqual(result.success, true);

  const agents = config.agents.agents;
  const agentKeys = Object.keys(agents);
  assert.ok(agentKeys.length >= 10, `Expected 10+ agent roles, got ${agentKeys.length}`);

  // Known roles in the SLE agent system
  assert.ok(agents.designer, 'missing designer');
  assert.ok(agents.explorer, 'missing explorer');
  assert.ok(agents.planner, 'missing planner');
  assert.ok(agents.tester, 'missing tester');
  assert.ok(agents.builder, 'missing builder');
  assert.ok(agents.debugger, 'missing debugger');
  assert.ok(agents.evaluator, 'missing evaluator');
  assert.ok(agents.critic, 'missing critic');
  assert.ok(agents.historian, 'missing historian');
  assert.ok(agents.facilitator, 'missing facilitator');
});

test('testValidateDetectsInvalidYAML', async () => {
  const invalid = { planning_depth: 'invalid_depth' };
  const result = validateRuleFile('planning', invalid);
  assert.strictEqual(result.success, false);
  assert.ok(result.errors.length > 0);
});

test('testGenerateDefaultsAllTypesHavePlanning', async () => {
  const types: ProjectType[] = ['api', 'ui', 'library', 'research', 'custom'];
  for (const type of types) {
    const config = generateDefaults(type);
    assert.ok(config, `generateDefaults failed for type ${type}`);
    assert.ok(config.planning, `planning missing for ${type}`);
    assert.ok(config.planning.depth, `planning.depth missing for ${type}`);
  }
});

test('testValidateWrongRuleFile', async () => {
  const result = validateRuleFile('planning' as RuleFileName, {});
  assert.strictEqual(result.success, false);
  assert.ok(result.errors.length > 0);
});

test('testValidateUnknownFile', async () => {
  const result = validateRuleFile('unknown' as RuleFileName, {});
  assert.strictEqual(result.success, false);
});

test('testGeneratedExitConfigDefaults', async () => {
  const config = generateDefaults('api');
  const result = validateRuleFile('exit', config.exit);
  assert.strictEqual(result.success, true);
  assert.strictEqual(config.exit.on_cap_hit, 'halt_with_report');
});

test('testGeneratedSummaryConfig', async () => {
  const config = generateDefaults('api');
  const result = validateRuleFile('summary', config.summary);
  assert.strictEqual(result.success, true);
});

test('testGeneratedValidationConfig', async () => {
  const config = generateDefaults('api');
  const result = validateRuleFile('validation', config.validation);
  assert.strictEqual(result.success, true);
});

test('testGenerateAllTypesHasAllSections', async () => {
  const types: ProjectType[] = ['api', 'ui', 'library', 'research', 'custom'];
  const sections = ['planning', 'validation', 'artifacts', 'exit', 'user_validation', 'summary', 'agents'];
  for (const type of types) {
    const config = generateDefaults(type);
    for (const section of sections) {
      const content = (config as unknown as Record<string, unknown>)[section];
      assert.ok(content, `Missing section '${section}' for type ${type}`);
    }
  }
});

// ─── Runner ──────────────────────────────────────────────────────────
