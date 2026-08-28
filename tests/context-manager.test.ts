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

// Artifact paths now live under .sle/project-docs/
function docPath(key: string): string {
  return `/project/.sle/project-docs/${key}.md`;
}

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
    [docPath('requirements')]: '# Requirements\nContent here.',
    [docPath('test-plan')]: '# Test Plan\nTest here.',
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
    [docPath('requirements')]: '# Requirements\nContent.',
    // test-plan.md missing
  });
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, fsMock);
  const result = await cm.assemble('tester', baseState());

  assert.ok('requirements' in result.artifact_slices, 'requirements missing');
  assert.ok(!('test-plan' in result.artifact_slices), 'test-plan should be absent');
}

async function testExplorerRoleLoadsExpectedSlices() {
  // Explorer looks for system-description, open-questions, constraints, evaluation, cycle-charter
  // With none present, slices should be empty
  const fsMock = makeFsMock({});
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, fsMock);
  const result = await cm.assemble('explorer', baseState());

  assert.deepStrictEqual(result.artifact_slices, {});
}

async function testExplorerRoleLoadsWhenFilesExist() {
  const fsMock = makeFsMock({
    [docPath('system-description')]: '# System\nOverview.',
    [docPath('open-questions')]: '# Questions\nUnknowns.',
  });
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, fsMock);
  const result = await cm.assemble('explorer', baseState());

  assert.ok('system-description' in result.artifact_slices);
  assert.ok('open-questions' in result.artifact_slices);
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
        cycle: 1,
        iteration: 1,
        run_id: 'run-001',
        run_dir: '/project/.sle/runs/run-001',
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
        cycle: 1,
        iteration: 1,
        run_id: 'run-001',
        run_dir: '/project/.sle/runs/run-001',
        failed_categories: ['correctness', 'coverage'],
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
    [docPath('requirements')]: '# Requirements\nContent.',
    [docPath('architecture')]: '# Architecture\nContent.',
  });
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, fsMock);
  const result = await cm.assemble('critic', baseState());

  assert.ok(result.token_count > 0);
}

async function testTruncationWhenArtifactExceedsSliceSize() {
  const bigContent = 'x'.repeat(100_000);
  const fsMock = makeFsMock({
    [docPath('test-plan')]: bigContent,
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
    [docPath('requirements')]: 'Short content.',
  });
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, fsMock);
  const result = await cm.assemble('tester', baseState());

  assert.deepStrictEqual(result.truncated, []);
}

async function testHardCeilingEnforced() {
  const bigContent = 'y'.repeat(50_000);
  // Facilitator (chat mode) loads: product-brief, system-description, vision, open-questions, project-plan
  const fsMock = makeFsMock({
    [docPath('system-description')]: bigContent,
    [docPath('open-questions')]: bigContent,
  });
  const smallConfig = { ...DEFAULT_CONFIG, hard_ceiling: 2_000, artifact_slice_size: 100_000 };
  const cm = new ContextManager(ROOT, smallConfig, fsMock);
  const result = await cm.assemble('facilitator', baseState());

  assert.ok(result.token_count <= 2_100, `token_count ${result.token_count} exceeds ceiling`);
}

async function testBuilderRoleLoadsArtifactsAtDeepDepth() {
  const fsMock = makeFsMock({
    [docPath('requirements')]: '# Req',
    [docPath('architecture')]: '# Arch',
    [docPath('test-plan')]: '# Tests',
    [docPath('plan')]: '# Plan',
    [docPath('build-plan')]: '# Build Plan',
  });
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, fsMock);
  const result = await cm.assemble('builder', baseState({ current_node: 'BUILD', planning_depth: 'deep' }));

  assert.ok('requirements' in result.artifact_slices, 'requirements missing');
  assert.ok('architecture' in result.artifact_slices, 'architecture missing');
  assert.ok('test-plan' in result.artifact_slices, 'test-plan missing');
  assert.ok('plan' in result.artifact_slices, 'plan missing at deep depth');
  assert.ok('build-plan' in result.artifact_slices, 'build-plan missing at deep depth');
}

async function testBuilderExcludesPlanAtStandardDepth() {
  const fsMock = makeFsMock({
    [docPath('requirements')]: '# Req',
    [docPath('architecture')]: '# Arch',
    [docPath('test-plan')]: '# Tests',
    [docPath('plan')]: '# Plan — should not appear',
  });
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, fsMock);
  const result = await cm.assemble('builder', baseState({ current_node: 'BUILD', planning_depth: 'standard' }));

  assert.ok('requirements' in result.artifact_slices);
  assert.ok('architecture' in result.artifact_slices);
  assert.ok(!('plan' in result.artifact_slices), 'plan should be absent at standard depth');
}

async function testNullCurrentNode() {
  const fsMock = makeFsMock({});
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, fsMock);
  const result = await cm.assemble('designer', baseState({ current_node: null }));

  assert.ok(result.task.length > 0, 'task empty with null node');
  assert.ok(result.state_summary.includes('not started'), 'null node not shown');
}

async function testEphemeralArtifactsInjected() {
  const fsMock = makeFsMock({});
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, fsMock);
  const result = await cm.assemble(
    'planner',
    baseState({
      iteration: 2,
      failure_report: {
        cycle: 1,
        iteration: 1,
        run_id: 'run-001',
        run_dir: '/project/.sle/runs/run-001',
        failed_categories: ['correctness'],
        passed_categories: [],
        quick_summary: 'Correctness failed.',
      },
      ephemeral: {
        'doc:debug-diagnosis': 'Root cause: missing null check on line 42.',
      },
    })
  );

  assert.ok('debug-diagnosis' in result.artifact_slices, 'ephemeral debug-diagnosis not injected');
  assert.ok(result.artifact_slices['debug-diagnosis'].includes('null check'));
}

async function testFacilitatorChatMode() {
  const fsMock = makeFsMock({
    [docPath('system-description')]: '# System\nDetails.',
    [docPath('open-questions')]: '# Questions\nUnknowns.',
  });
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, fsMock);
  const result = await cm.assemble('facilitator', baseState({ facilitator_mode: 'chat' }));

  assert.ok('system-description' in result.artifact_slices);
  assert.ok('open-questions' in result.artifact_slices);
}

async function testFacilitatorDecisionMode() {
  const fsMock = makeFsMock({
    [docPath('plan')]: '# Plan\nSteps.',
    [docPath('test-plan')]: '# Test Plan\nTests.',
  });
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, fsMock);
  const result = await cm.assemble('facilitator', baseState({ facilitator_mode: 'decision' }));

  assert.ok('plan' in result.artifact_slices, 'plan missing in decision mode');
  assert.ok('test-plan' in result.artifact_slices, 'test-plan missing in decision mode');
}

async function testFacilitatorScopingMode() {
  const fsMock = makeFsMock({
    [docPath('cycle-scope-draft')]: '# Scope Draft\nDraft.',
    [docPath('cycle-charter')]: '# Charter\nCharter.',
  });
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, fsMock);
  const result = await cm.assemble('facilitator', baseState({ facilitator_mode: 'scoping' }));

  assert.ok('cycle-scope-draft' in result.artifact_slices, 'scope-draft missing in scoping mode');
  assert.ok('cycle-charter' in result.artifact_slices, 'cycle-charter missing in scoping mode');
}

async function testTesterNeverReceivesArchitecture() {
  const fsMock = makeFsMock({
    [docPath('requirements')]: '# Req',
    [docPath('architecture')]: '# ARCH — must not appear',
    [docPath('test-plan')]: '# Tests',
  });
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, fsMock);
  const result = await cm.assemble('tester', baseState({ current_node: 'TEST' }));

  assert.ok(!('architecture' in result.artifact_slices), 'TDD violation: Tester received architecture');
  assert.ok('requirements' in result.artifact_slices);
  assert.ok('test-plan' in result.artifact_slices);
}

async function testSourceFilesInjectedForBuilder() {
  const fsMock = makeFsMock({
    [docPath('requirements')]: '# Req',
    [docPath('architecture')]: '# Arch',
    '/project/src/service.ts': 'export class Service {}',
  });
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, fsMock);
  const result = await cm.assemble(
    'builder',
    baseState({ source_files: ['src/service.ts'] })
  );

  assert.ok('service' in result.artifact_slices, 'source file not injected for builder');
  assert.ok(result.artifact_slices['service'].includes('Service'));
}

async function testDebuggerLoadsRunArtifacts() {
  const fsMock = makeFsMock({
    '/project/.sle/runs/run-001/manifest.json': '{"status":"failed"}',
    '/project/.sle/runs/run-001/ai/context-pack.md': '# Context Pack\nDetails.',
    [docPath('architecture')]: '# Arch',
  });
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, fsMock);
  const result = await cm.assemble(
    'debugger',
    baseState({
      failure_report: {
        cycle: 1,
        iteration: 1,
        run_id: 'run-001',
        run_dir: '/project/.sle/runs/run-001',
        failed_categories: ['correctness'],
        passed_categories: [],
        quick_summary: 'Tests failed.',
      },
    })
  );

  assert.ok('manifest' in result.artifact_slices, 'manifest not loaded');
  assert.ok('context-pack' in result.artifact_slices, 'context-pack not loaded');
  assert.ok('architecture' in result.artifact_slices, 'architecture not loaded');
}

// ─── Runner ──────────────────────────────────────────────────────────────────

async function runAllTests() {
  console.log('Running Context Manager tests...\n');

  const tests: Array<{ name: string; fn: () => Promise<void> }> = [
    { name: 'state summary contains all 5 fields', fn: testStateSummaryContainsAllFields },
    { name: 'task description contains node intent', fn: testTaskDescriptionContainsNodeAndIntent },
    { name: 'artifact slices loaded per role (tester)', fn: testArtifactSlicesLoadedForRole },
    { name: 'missing artifact files skipped gracefully', fn: testMissingArtifactFilesSkipped },
    { name: 'explorer role returns empty slices when no files', fn: testExplorerRoleLoadsExpectedSlices },
    { name: 'explorer role loads correct slices when files exist', fn: testExplorerRoleLoadsWhenFilesExist },
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
    { name: 'builder loads plan and build-plan at deep depth', fn: testBuilderRoleLoadsArtifactsAtDeepDepth },
    { name: 'builder excludes plan at standard depth', fn: testBuilderExcludesPlanAtStandardDepth },
    { name: 'null current_node handled gracefully', fn: testNullCurrentNode },
    { name: 'ephemeral artifacts injected into context', fn: testEphemeralArtifactsInjected },
    { name: 'facilitator chat mode loads correct slices', fn: testFacilitatorChatMode },
    { name: 'facilitator decision mode loads plan + test-plan', fn: testFacilitatorDecisionMode },
    { name: 'facilitator scoping mode loads charter + scope-draft', fn: testFacilitatorScopingMode },
    { name: 'tester never receives architecture (TDD isolation)', fn: testTesterNeverReceivesArchitecture },
    { name: 'source_files injected for builder role', fn: testSourceFilesInjectedForBuilder },
    { name: 'debugger loads run artifacts from failure_report.run_dir', fn: testDebuggerLoadsRunArtifacts },
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
    console.error(`\n❌ ${failures.length}/${tests.length} tests FAILED:`);
    for (const f of failures) {
      console.error(`  - ${f.name}`);
      console.error(`    ${f.error instanceof Error ? f.error.message : String(f.error)}`);
    }
    throw failures[0].error;
  }

  console.log(`\n✅ All ${tests.length} tests passed!`);
}

runAllTests();
