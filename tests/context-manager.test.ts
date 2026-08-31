import { test } from 'node:test';
import { strict as assert } from 'assert';
import { ContextManager, DEFAULT_CONFIG } from '../src/context-manager.js';
import type { StepRunContext } from '../src/workflow/types.js';
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

function baseState(overrides: Partial<StepRunContext> = {}): StepRunContext {
  return {
    workflowRunId: 'test-run-1',
    workflowId: 'full-build',
    stepId: 'DESIGN',
    cycleNumber: 1,
    iteration: 1,
    revision: 0,
    planningDepth: 'standard',
    goal: 'Build a widget',
    projectRoot: ROOT,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test('testStateSummaryContainsAllFields', async () => {
  const fsMock = makeFsMock({});
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, fsMock);
  const result = await cm.assemble('designer', baseState());

  assert.ok(result.state_summary.includes('Cycle: 1'), 'cycle_number missing');
  assert.ok(result.state_summary.includes('Iteration: 1'), 'iteration missing');
  assert.ok(result.state_summary.includes('standard'), 'planning_depth missing');
  assert.ok(result.state_summary.includes('DESIGN'), 'current_node missing');
  assert.ok(result.state_summary.includes('Build a widget'), 'intent missing');
});

test('testTaskDescriptionContainsNodeAndIntent', async () => {
  const fsMock = makeFsMock({});
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, fsMock);
  const result = await cm.assemble('designer', baseState({ stepId: 'PLAN' }));

  assert.ok(result.task.includes('Build a widget'), 'intent not in task');
  assert.ok(result.task.length > 0, 'task is empty');
});

test('testArtifactSlicesLoadedForRole', async () => {
  const fsMock = makeFsMock({
    [docPath('requirements')]: '# Requirements\nContent here.',
    [docPath('test-plan')]: '# Test Plan\nTest here.',
  });
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, fsMock);
  const result = await cm.assemble('tester', baseState({ stepId: 'TEST' }));

  assert.ok('requirements' in result.artifact_slices, 'requirements slice missing');
  assert.ok('test-plan' in result.artifact_slices, 'test-plan slice missing');
  assert.ok(result.artifact_slices['requirements'].includes('Requirements'));
  assert.ok(result.artifact_slices['test-plan'].includes('Test Plan'));
});

test('testMissingArtifactFilesSkipped', async () => {
  const fsMock = makeFsMock({
    [docPath('requirements')]: '# Requirements\nContent.',
    // test-plan.md missing
  });
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, fsMock);
  const result = await cm.assemble('tester', baseState());

  assert.ok('requirements' in result.artifact_slices, 'requirements missing');
  assert.ok(!('test-plan' in result.artifact_slices), 'test-plan should be absent');
});

test('testExplorerRoleLoadsExpectedSlices', async () => {
  // Explorer looks for system-description, open-questions, constraints, evaluation, cycle-charter
  // With none present, slices should be empty
  const fsMock = makeFsMock({});
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, fsMock);
  const result = await cm.assemble('explorer', baseState());

  assert.deepStrictEqual(result.artifact_slices, {});
});

test('testExplorerRoleLoadsWhenFilesExist', async () => {
  const fsMock = makeFsMock({
    [docPath('system-description')]: '# System\nOverview.',
    [docPath('open-questions')]: '# Questions\nUnknowns.',
  });
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, fsMock);
  const result = await cm.assemble('explorer', baseState());

  assert.ok('system-description' in result.artifact_slices);
  assert.ok('open-questions' in result.artifact_slices);
});

test('testSystemPromptLoadsAgentMdAndRolePrompt', async () => {
  const fsMock = makeFsMock({
    '/project/agent.md': '# Agent Global',
    '/project/.sle/prompts/designer.md': '# Designer Role',
  });
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, fsMock);
  const result = await cm.assemble('designer', baseState());

  assert.ok(result.system_prompt.includes('Agent Global'), 'agent.md not loaded');
  assert.ok(result.system_prompt.includes('Designer Role'), 'role prompt not loaded');
});

test('testSystemPromptWorksWithMissingAgentMd', async () => {
  const fsMock = makeFsMock({
    '/project/.sle/prompts/builder.md': '# Builder',
  });
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, fsMock);
  const result = await cm.assemble('builder', baseState());

  assert.ok(result.system_prompt.includes('Builder'));
});

test('testSystemPromptEmptyWhenNoFiles', async () => {
  const fsMock = makeFsMock({});
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, fsMock);
  const result = await cm.assemble('critic', baseState());

  assert.strictEqual(result.system_prompt, '');
});

test('testFailureContextNotInjectedOnIteration1', async () => {
  const fsMock = makeFsMock({});
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, fsMock);
  const result = await cm.assemble(
    'designer',
    baseState({
      iteration: 1,
      failureReport: {
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
});

test('testFailureContextInjectedOnIteration2', async () => {
  const fsMock = makeFsMock({});
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, fsMock);
  const result = await cm.assemble(
    'designer',
    baseState({
      iteration: 2,
      failureReport: {
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
});

test('testFailureContextNotInjectedWithoutReport', async () => {
  const fsMock = makeFsMock({});
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, fsMock);
  const result = await cm.assemble('designer', baseState({ iteration: 2 }));

  assert.strictEqual(result.failure_context, undefined);
});

test('testTokenCountIsPositive', async () => {
  const fsMock = makeFsMock({
    '/project/agent.md': 'Agent instructions.',
    [docPath('requirements')]: '# Requirements\nContent.',
    [docPath('architecture')]: '# Architecture\nContent.',
  });
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, fsMock);
  const result = await cm.assemble('critic', baseState());

  assert.ok(result.token_count > 0);
});

test('testTruncationWhenArtifactExceedsSliceSize', async () => {
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
});

test('testTruncatedEmptyWhenNoTruncation', async () => {
  const fsMock = makeFsMock({
    [docPath('requirements')]: 'Short content.',
  });
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, fsMock);
  const result = await cm.assemble('tester', baseState());

  assert.deepStrictEqual(result.truncated, []);
});

test('testHardCeilingEnforced', async () => {
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
});

test('testBuilderRoleLoadsArtifactsAtDeepDepth', async () => {
  const fsMock = makeFsMock({
    [docPath('requirements')]: '# Req',
    [docPath('architecture')]: '# Arch',
    [docPath('test-plan')]: '# Tests',
    [docPath('plan')]: '# Plan',
    [docPath('build-plan')]: '# Build Plan',
  });
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, fsMock);
  const result = await cm.assemble('builder', baseState({ stepId: 'BUILD', planningDepth: 'deep' }));

  assert.ok('requirements' in result.artifact_slices, 'requirements missing');
  assert.ok('architecture' in result.artifact_slices, 'architecture missing');
  assert.ok('test-plan' in result.artifact_slices, 'test-plan missing');
  assert.ok('plan' in result.artifact_slices, 'plan missing at deep depth');
  assert.ok('build-plan' in result.artifact_slices, 'build-plan missing at deep depth');
});

test('testBuilderExcludesPlanAtStandardDepth', async () => {
  const fsMock = makeFsMock({
    [docPath('requirements')]: '# Req',
    [docPath('architecture')]: '# Arch',
    [docPath('test-plan')]: '# Tests',
    [docPath('plan')]: '# Plan — should not appear',
  });
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, fsMock);
  const result = await cm.assemble('builder', baseState({ stepId: 'BUILD', planningDepth: 'standard' }));

  assert.ok('requirements' in result.artifact_slices);
  assert.ok('architecture' in result.artifact_slices);
  assert.ok(!('plan' in result.artifact_slices), 'plan should be absent at standard depth');
});

test('testNullCurrentNode', async () => {
  const fsMock = makeFsMock({});
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, fsMock);
  // stepId is required string — empty string produces a sensible fallback
  const result = await cm.assemble('designer', baseState({ stepId: '' }));

  assert.ok(result.task.length > 0, 'task empty with empty stepId');
});

test('testEphemeralArtifactsInjected', async () => {
  const fsMock = makeFsMock({});
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, fsMock);
  const result = await cm.assemble(
    'planner',
    baseState({
      iteration: 2,
      failureReport: {
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
});

test('testFacilitatorChatMode', async () => {
  const fsMock = makeFsMock({
    [docPath('system-description')]: '# System\nDetails.',
    [docPath('open-questions')]: '# Questions\nUnknowns.',
  });
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, fsMock);
  const result = await cm.assemble('facilitator', baseState({ facilitatorMode: 'chat' }));

  assert.ok('system-description' in result.artifact_slices);
  assert.ok('open-questions' in result.artifact_slices);
});

test('testFacilitatorDecisionMode', async () => {
  const fsMock = makeFsMock({
    [docPath('plan')]: '# Plan\nSteps.',
    [docPath('test-plan')]: '# Test Plan\nTests.',
  });
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, fsMock);
  const result = await cm.assemble('facilitator', baseState({ facilitatorMode: 'decision' }));

  assert.ok('plan' in result.artifact_slices, 'plan missing in decision mode');
  assert.ok('test-plan' in result.artifact_slices, 'test-plan missing in decision mode');
});

test('testFacilitatorScopingMode', async () => {
  const fsMock = makeFsMock({
    [docPath('cycle-scope-draft')]: '# Scope Draft\nDraft.',
    [docPath('cycle-charter')]: '# Charter\nCharter.',
  });
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, fsMock);
  const result = await cm.assemble('facilitator', baseState({ facilitatorMode: 'scoping' }));

  assert.ok('cycle-scope-draft' in result.artifact_slices, 'scope-draft missing in scoping mode');
  assert.ok('cycle-charter' in result.artifact_slices, 'cycle-charter missing in scoping mode');
});

test('testTesterNeverReceivesArchitecture', async () => {
  const fsMock = makeFsMock({
    [docPath('requirements')]: '# Req',
    [docPath('architecture')]: '# ARCH — must not appear',
    [docPath('test-plan')]: '# Tests',
  });
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, fsMock);
  const result = await cm.assemble('tester', baseState({ stepId: 'TEST' }));

  assert.ok(!('architecture' in result.artifact_slices), 'TDD violation: Tester received architecture');
  assert.ok('requirements' in result.artifact_slices);
  assert.ok('test-plan' in result.artifact_slices);
});

test('testSourceFilesInjectedForBuilder', async () => {
  const fsMock = makeFsMock({
    [docPath('requirements')]: '# Req',
    [docPath('architecture')]: '# Arch',
    '/project/src/service.ts': 'export class Service {}',
  });
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, fsMock);
  const result = await cm.assemble(
    'builder',
    baseState({ sourceFiles: ['src/service.ts'] })
  );

  assert.ok('service' in result.artifact_slices, 'source file not injected for builder');
  assert.ok(result.artifact_slices['service'].includes('Service'));
});

test('testDebuggerLoadsRunArtifacts', async () => {
  const fsMock = makeFsMock({
    '/project/.sle/runs/run-001/manifest.json': '{"status":"failed"}',
    '/project/.sle/runs/run-001/ai/context-pack.md': '# Context Pack\nDetails.',
    [docPath('architecture')]: '# Arch',
  });
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, fsMock);
  const result = await cm.assemble(
    'debugger',
    baseState({
      failureReport: {
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
});

// ─── Runner ──────────────────────────────────────────────────────────────────
