import { strict as assert } from 'assert';
import { ContextManager, DEFAULT_CONFIG, CycleStateContext } from '../src/context-manager.js';
import type { AgentRole } from '../src/types.js';

// ─── In-memory FS mock ────────────────────────────────────────────────────────

function makeFsMock(files: Record<string, string>): typeof import('fs').promises {
  return {
    readFile: async (filePath: unknown) => {
      const p = filePath as string;
      if (p in files) return files[p];
      const err = Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      throw err;
    },
  } as unknown as typeof import('fs').promises;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ROOT = '/project';

function baseState(overrides: Partial<CycleStateContext> = {}): CycleStateContext {
  return {
    cycle_number: 1,
    iteration: 1,
    planning_depth: 'standard',
    intent: 'Build a widget',
    current_node: 'DESIGN',
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

async function testStateSummaryContainsAllFields() {
  const fsMock = makeFsMock({});
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, fsMock);
  const result = await cm.assemble('designer', baseState());

  assert.ok(result.state_summary.includes('Cycle: 1'), 'cycle_number missing');
  assert.ok(result.state_summary.includes('Iteration: 1'), 'iteration missing');
  assert.ok(result.state_summary.includes('standard'), 'planning_depth missing');
  assert.ok(result.state_summary.includes('DESIGN'), 'current_node missing');
  assert.ok(result.state_summary.includes('Build a widget'), 'intent missing');
}

async function testTaskDescriptionContainsNodeAndIntent() {
  const fsMock = makeFsMock({});
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, fsMock);
  const result = await cm.assemble('designer', baseState({ current_node: 'PLAN' }));

  assert.ok(result.task.includes('Build a widget'), 'intent not in task');
  assert.ok(result.task.length > 0, 'task is empty');
}

async function testArtifactSlicesLoadedForRole() {
  const fsMock = makeFsMock({
    '/project/docs/requirements.md': '# Requirements\nContent here.',
    '/project/docs/test-plan.md': '# Test Plan\nTest here.',
  });
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, fsMock);
  const result = await cm.assemble('tester', baseState({ current_node: 'TEST' }));

  assert.ok('requirements' in result.artifact_slices, 'requirements slice missing');
  assert.ok('test-plan' in result.artifact_slices, 'test-plan slice missing');
  assert.ok(result.artifact_slices['requirements'].includes('Requirements'));
  assert.ok(result.artifact_slices['test-plan'].includes('Test Plan'));
}

async function testMissingArtifactFilesSkipped() {
  const fsMock = makeFsMock({
    '/project/docs/requirements.md': '# Requirements\nContent.',
    // test-plan.md missing
  });
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, fsMock);
  const result = await cm.assemble('tester', baseState());

  assert.ok('requirements' in result.artifact_slices, 'requirements missing');
  assert.ok(!('test-plan' in result.artifact_slices), 'test-plan should be absent');
}

async function testExplorerRoleHasNoArtifacts() {
  const fsMock = makeFsMock({
    '/project/docs/requirements.md': '# Req',
  });
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, fsMock);
  const result = await cm.assemble('explorer', baseState());

  assert.deepStrictEqual(result.artifact_slices, {});
}

async function testSystemPromptLoadsAgentMdAndRolePrompt() {
  const fsMock = makeFsMock({
    '/project/agent.md': '# Agent Global',
    '/project/.sle/prompts/designer.md': '# Designer Role',
  });
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, fsMock);
  const result = await cm.assemble('designer', baseState());

  assert.ok(result.system_prompt.includes('Agent Global'), 'agent.md not loaded');
  assert.ok(result.system_prompt.includes('Designer Role'), 'role prompt not loaded');
}

async function testSystemPromptWorksWithMissingAgentMd() {
  const fsMock = makeFsMock({
    '/project/.sle/prompts/builder.md': '# Builder',
  });
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, fsMock);
  const result = await cm.assemble('builder', baseState());

  assert.ok(result.system_prompt.includes('Builder'));
}

async function testSystemPromptEmptyWhenNoFiles() {
  const fsMock = makeFsMock({});
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, fsMock);
  const result = await cm.assemble('critic', baseState());

  assert.strictEqual(result.system_prompt, '');
}

async function testFailureContextNotInjectedOnIteration1() {
  const fsMock = makeFsMock({});
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, fsMock);
  const result = await cm.assemble(
    'designer',
    baseState({
      iteration: 1,
      failure_report: {
        iteration: 1,
        failed_categories: ['correctness'],
        passed_categories: ['style'],
        quick_summary: 'Tests failed.',
      },
    })
  );

  assert.strictEqual(result.failure_context, undefined, 'failure_context injected on iteration 1');
}

async function testFailureContextInjectedOnIteration2() {
  const fsMock = makeFsMock({});
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, fsMock);
  const result = await cm.assemble(
    'designer',
    baseState({
      iteration: 2,
      failure_report: {
        iteration: 1,
        failed_categories: [
          'correctness',
          'coverage',
        ],
        passed_categories: ['style'],
        quick_summary: 'Two categories failed.',
      },
    })
  );

  assert.ok(result.failure_context !== undefined, 'failure_context missing on iteration 2');
  assert.ok(result.failure_context!.includes('correctness'), 'failed category missing');
  assert.ok(result.failure_context!.includes('Two categories failed.'), 'summary missing');
}

async function testFailureContextNotInjectedWithoutReport() {
  const fsMock = makeFsMock({});
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, fsMock);
  const result = await cm.assemble('designer', baseState({ iteration: 2 }));

  assert.strictEqual(result.failure_context, undefined);
}

async function testTokenCountIsPositive() {
  const fsMock = makeFsMock({
    '/project/agent.md': 'Agent instructions.',
    '/project/docs/requirements.md': '# Requirements\nContent.',
    '/project/docs/architecture.md': '# Architecture\nContent.',
  });
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, fsMock);
  const result = await cm.assemble('critic', baseState());

  assert.ok(result.token_count > 0);
}

async function testTruncationWhenArtifactExceedsSliceSize() {
  const bigContent = 'x'.repeat(100_000);
  const fsMock = makeFsMock({
    '/project/docs/test-plan.md': bigContent,
  });
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, fsMock);
  const result = await cm.assemble('tester', baseState());

  const slice = result.artifact_slices['test-plan'];
  assert.ok(slice !== undefined, 'slice missing');
  assert.ok(slice.length <= DEFAULT_CONFIG.artifact_slice_size * 4 + 100, 'slice too large');
  assert.ok(result.truncated.includes('test-plan'), 'truncated not recorded');
  assert.ok(slice.includes('[...earlier content truncated...]'), 'truncation marker missing');
}

async function testTruncatedEmptyWhenNoTruncation() {
  const fsMock = makeFsMock({
    '/project/docs/requirements.md': 'Short content.',
  });
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, fsMock);
  const result = await cm.assemble('tester', baseState());

  assert.deepStrictEqual(result.truncated, []);
}

async function testHardCeilingEnforced() {
  const bigContent = 'y'.repeat(50_000);
  const fsMock = makeFsMock({
    '/project/docs/discovery-summary.md': bigContent,
    '/project/docs/cycle-charter.md': bigContent,
  });
  const smallConfig = { ...DEFAULT_CONFIG, hard_ceiling: 2_000, artifact_slice_size: 100_000 };
  const cm = new ContextManager(ROOT, smallConfig, fsMock);
  const result = await cm.assemble('facilitator', baseState());

  assert.ok(result.token_count <= 2_100, `token_count ${result.token_count} exceeds ceiling`);
}

async function testBuilderRoleLoadsAllFourArtifacts() {
  const fsMock = makeFsMock({
    '/project/docs/requirements.md': '# Req',
    '/project/docs/architecture.md': '# Arch',
    '/project/docs/plan.md': '# Plan',
    '/project/docs/test-plan.md': '# Tests',
  });
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, fsMock);
  const result = await cm.assemble('builder', baseState({ current_node: 'BUILD' }));

  assert.ok('requirements' in result.artifact_slices);
  assert.ok('architecture' in result.artifact_slices);
  assert.ok('plan' in result.artifact_slices);
  assert.ok('test-plan' in result.artifact_slices);
}

async function testNullCurrentNode() {
  const fsMock = makeFsMock({});
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, fsMock);
  const result = await cm.assemble('designer', baseState({ current_node: null }));

  assert.ok(result.task.length > 0, 'task empty with null node');
  assert.ok(result.state_summary.includes('not started'), 'null node not shown');
}

// ─── Runner ──────────────────────────────────────────────────────────────────

async function runAllTests() {
  console.log('Running Phase C (Context Manager) tests...\n');

  const tests: Array<{ name: string; fn: () => Promise<void> }> = [
    { name: 'state summary contains all 5 fields', fn: testStateSummaryContainsAllFields },
    { name: 'task description contains node intent', fn: testTaskDescriptionContainsNodeAndIntent },
    { name: 'artifact slices loaded per role (tester)', fn: testArtifactSlicesLoadedForRole },
    { name: 'missing artifact files skipped gracefully', fn: testMissingArtifactFilesSkipped },
    { name: 'explorer role returns empty artifact_slices', fn: testExplorerRoleHasNoArtifacts },
    { name: 'system prompt loads agent.md + role prompt', fn: testSystemPromptLoadsAgentMdAndRolePrompt },
    { name: 'system prompt works with missing agent.md', fn: testSystemPromptWorksWithMissingAgentMd },
    { name: 'system prompt empty when no files exist', fn: testSystemPromptEmptyWhenNoFiles },
    { name: 'failure context not injected on iteration 1', fn: testFailureContextNotInjectedOnIteration1 },
    { name: 'failure context injected on iteration 2', fn: testFailureContextInjectedOnIteration2 },
    { name: 'failure context absent when no report', fn: testFailureContextNotInjectedWithoutReport },
    { name: 'token_count is positive', fn: testTokenCountIsPositive },
    { name: 'artifact truncated at artifact_slice_size', fn: testTruncationWhenArtifactExceedsSliceSize },
    { name: 'truncated array empty when no truncation', fn: testTruncatedEmptyWhenNoTruncation },
    { name: 'hard ceiling enforced across artifacts', fn: testHardCeilingEnforced },
    { name: 'builder role loads all 4 artifacts', fn: testBuilderRoleLoadsAllFourArtifacts },
    { name: 'null current_node handled gracefully', fn: testNullCurrentNode },
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
    console.error(`\n❌ ${failures.length}/${tests.length} Phase C tests FAILED:`);
    for (const f of failures) {
      console.error(`  - ${f.name}`);
      console.error(`    ${f.error instanceof Error ? f.error.message : String(f.error)}`);
    }
    throw failures[0].error;
  }

  console.log(`\n✅ All ${tests.length} Phase C tests passed!`);
}

runAllTests();
