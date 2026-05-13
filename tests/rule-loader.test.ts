import { strict as assert } from 'node:assert';
import { generateDefaults, validateRuleFile, type RuleFileName } from '../src/rule-files.js';
import type { ProjectType } from '../src/types.js';

// ─── Tests ───────────────────────────────────────────────────────────

async function testGenerateDefaultsCreatesAllSections() {
  const config = generateDefaults('api');
  assert.ok(config.planning);
  assert.ok(config.validation);
  assert.ok(config.artifacts);
  assert.ok(config.exit);
  assert.ok(config.user_validation);
  assert.ok(config.summary);
  assert.ok(config.agents);
}

async function testGeneratedPlanningPassesValidation() {
  const config = generateDefaults('api');
  const result = validateRuleFile('planning', config.planning);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.errors.length, 0);
}

async function testGeneratedAgentsIncludesAllRoles() {
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
}

async function testValidateDetectsInvalidYAML() {
  const invalid = { planning_depth: 'invalid_depth' };
  const result = validateRuleFile('planning', invalid);
  assert.strictEqual(result.success, false);
  assert.ok(result.errors.length > 0);
}

async function testGenerateDefaultsAllTypesHavePlanning() {
  const types: ProjectType[] = ['api', 'ui', 'library', 'research', 'custom'];
  for (const type of types) {
    const config = generateDefaults(type);
    assert.ok(config, `generateDefaults failed for type ${type}`);
    assert.ok(config.planning, `planning missing for ${type}`);
    assert.ok(config.planning.depth, `planning.depth missing for ${type}`);
  }
}

async function testValidateWrongRuleFile() {
  const result = validateRuleFile('planning' as RuleFileName, {});
  assert.strictEqual(result.success, false);
  assert.ok(result.errors.length > 0);
}

async function testValidateUnknownFile() {
  const result = validateRuleFile('unknown' as RuleFileName, {});
  assert.strictEqual(result.success, false);
}

async function testGeneratedExitConfigDefaults() {
  const config = generateDefaults('api');
  const result = validateRuleFile('exit', config.exit);
  assert.strictEqual(result.success, true);
  assert.strictEqual(config.exit.on_cap_hit, 'halt_with_report');
}

async function testGeneratedSummaryConfig() {
  const config = generateDefaults('api');
  const result = validateRuleFile('summary', config.summary);
  assert.strictEqual(result.success, true);
}

async function testGeneratedValidationConfig() {
  const config = generateDefaults('api');
  const result = validateRuleFile('validation', config.validation);
  assert.strictEqual(result.success, true);
}

async function testGenerateAllTypesHasAllSections() {
  const types: ProjectType[] = ['api', 'ui', 'library', 'research', 'custom'];
  const sections = ['planning', 'validation', 'artifacts', 'exit', 'user_validation', 'summary', 'agents'];
  for (const type of types) {
    const config = generateDefaults(type);
    for (const section of sections) {
      const content = (config as unknown as Record<string, unknown>)[section];
      assert.ok(content, `Missing section '${section}' for type ${type}`);
    }
  }
}

// ─── Runner ──────────────────────────────────────────────────────────

async function runAllTests() {
  const tests = [
    { name: 'Generate defaults creates all 7 rule sections', fn: testGenerateDefaultsCreatesAllSections },
    { name: 'Generated planning.yaml passes Zod validation', fn: testGeneratedPlanningPassesValidation },
    { name: 'Generated agents.yaml includes all 10+ roles', fn: testGeneratedAgentsIncludesAllRoles },
    { name: 'Validate detects invalid rule config', fn: testValidateDetectsInvalidYAML },
    { name: 'Generate defaults for all types has planning_depth', fn: testGenerateDefaultsAllTypesHavePlanning },
    { name: 'Validate empty config fails', fn: testValidateWrongRuleFile },
    { name: 'Validate unknown file returns success false', fn: testValidateUnknownFile },
    { name: 'Generated exit config has correct defaults', fn: testGeneratedExitConfigDefaults },
    { name: 'Generated summary config validates', fn: testGeneratedSummaryConfig },
    { name: 'Generated validation config validates', fn: testGeneratedValidationConfig },
    { name: 'Generate all types produces all 7 sections', fn: testGenerateAllTypesHasAllSections },
  ];

  const failures: Array<{ name: string; error: unknown }> = [];

  for (const test of tests) {
    try {
      await test.fn();
      console.log(`  ✓ ${test.name}`);
    } catch (error) {
      console.error(`  ✗ ${test.name}`);
      failures.push({ name: test.name, error });
    }
  }

  if (failures.length > 0) {
    console.error(`\n❌ ${failures.length}/${tests.length} Phase E rule-loader tests FAILED:`);
    for (const f of failures) {
      console.error(`  - ${f.name}: ${f.error}`);
    }
    throw failures[0].error;
  }

  console.log(`\n✅ All ${tests.length} Phase E rule-loader tests passed!`);
}

runAllTests();