// D.3b0 — permanent regression suite for the three generic contracts D.3's
// define-work workflow needs, proven independently of define-work itself
// (unfamiliar synthetic workflow/step ids, never registering 'define-work'):
//
//   A. the opt-in semantic review verdict contract (requiresReviewVerdict)
//   B. WorkItem context threading (objectiveId/constraints/acceptanceCriteria)
//   C. declarative artifact-ref placeholder materialization ({workItemId}/{objectiveId})
//
// See docs/developmentPlan/ for the D.3a contract these seams implement
// against. No StepKind, AgentRole, domain entity, WorkProposal, or Decision
// routing is added here — see the D.3b0 commit message for the exact scope.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'crypto';
import { ContextManager, DEFAULT_CONFIG } from '../src/context-manager.js';
import { AgentRunner } from '../src/agent-runner.js';
import { WorkflowEngine, registerWorkflow, FULL_BUILD } from '../src/workflow/index.js';
import { materializeTemplate, materializeStepRunContext } from '../src/workflow/artifact-refs.js';
import { StratumAgentAdapter } from '../src/execution/stratum-agent-adapter.js';
import { openDatabase } from '../src/storage/database.js';
import {
  ArtifactRepository,
  WorkspaceRepository,
  ProjectRepository,
  WorkItemRepository,
  ObjectiveRepository,
} from '../src/storage/repositories.js';
import { Scheduler } from '../src/scheduler/scheduler.js';
import { ExecutorRegistry } from '../src/execution/registry.js';
import type {
  StepRunContext,
  WorkflowDefinition,
  WorkflowEngineDeps,
  WorkflowEngineOptions,
} from '../src/workflow/types.js';
import type { AssembledContext } from '../src/types.js';
import type { ILLMProvider, LLMCompletionParams, LLMCompletionResult } from '../src/llm-provider.js';
import type { RunArtifactManager } from '../src/run-artifacts.js';
import type { ExecutionAdapter, ExecutionRequest, ExecutionResult, CapabilitySet } from '../src/execution/types.js';
import type { Objective, WorkItem, Workspace, Project } from '../src/domain/index.js';

const ROOT = '/project-d3b0';

function ctxFor(stepId: string, overrides: Partial<StepRunContext> = {}): StepRunContext {
  return {
    workflowRunId: 'd3b0-run-1',
    workflowId: 'a-workflow-id-that-does-not-exist-in-the-registry',
    stepId,
    iteration: 1,
    revision: 0,
    goal: 'Prove the D.3b0 generic seams independently of define-work',
    projectRoot: ROOT,
    ...overrides,
  };
}

// ============================================================================
// Shared fixtures — AgentRunner harness (mirrors tests/declarative-workflow-contract.test.ts)
// ============================================================================

class MockLLMProvider implements ILLMProvider {
  constructor(private response: string) {}
  async complete(_params: LLMCompletionParams): Promise<LLMCompletionResult> {
    return { content: this.response, tokens_used: 10, duration_ms: 1 };
  }
}

class ThrowingLLMProvider implements ILLMProvider {
  async complete(_params: LLMCompletionParams): Promise<LLMCompletionResult> {
    throw new Error('provider unreachable');
  }
}

class MockContextManager {
  constructor(private ctx: AssembledContext) {}
  async assemble(): Promise<AssembledContext> { return this.ctx; }
}

class MockRunArtifactManager {
  async writeNodeOutput(): Promise<void> {}
  [key: string]: unknown;
}

function baseAssembledContext(): AssembledContext {
  return {
    system_prompt: 'You are an explorer.',
    artifact_slices: {},
    state_summary: '## Current State',
    task: 'Review the Definition for readiness.',
    token_count: 10,
    truncated: [],
  };
}

type ContextManagerLike = import('../src/context-manager.js').ContextManager;

function makeAgentRunner(opts: {
  fsMock: typeof import('fs').promises;
  llmProvider: ILLMProvider;
  artifactRepository?: ArtifactRepository;
}): AgentRunner {
  const cm = new MockContextManager(baseAssembledContext());
  const ram = new MockRunArtifactManager();
  return new AgentRunner(
    cm as unknown as ContextManagerLike,
    opts.llmProvider,
    ROOT,
    ram as unknown as RunArtifactManager,
    { model: 'test-model' },
    opts.fsMock,
    opts.artifactRepository,
  );
}

function mockFs(files: Record<string, string> = {}): { mock: typeof import('fs').promises; written: Record<string, string> } {
  const written: Record<string, string> = {};
  const mock = {
    mkdir: async () => {},
    writeFile: async (filePath: unknown, content: unknown) => { written[filePath as string] = content as string; },
    appendFile: async (filePath: unknown, content: unknown) => {
      const key = filePath as string;
      written[key] = (written[key] ?? '') + (content as string);
    },
    readFile: async (filePath: unknown) => {
      const p = filePath as string;
      if (p in files) return files[p];
      const err = Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      throw err;
    },
  } as unknown as typeof import('fs').promises;
  return { mock, written };
}

function testDb(): { artifacts: ArtifactRepository; workItemId: string } {
  const db = openDatabase(':memory:');
  const now = new Date().toISOString();
  new WorkspaceRepository(db).save({ id: 'ws-1', name: 'test workspace', createdAt: now });
  new ProjectRepository(db).save({
    id: 'proj-1', workspaceId: 'ws-1', name: 'test project',
    status: 'active', priority: 0, createdAt: now, updatedAt: now,
  });
  new WorkItemRepository(db).save({
    id: 'wi-1', projectId: 'proj-1', repositoryIds: [],
    title: 'test work item', goal: 'test goal', workflowId: 'a-workflow-id-that-does-not-exist-in-the-registry',
    state: 'running', priority: 0,
    acceptanceCriteria: [], constraints: [], requiredEvidence: [],
    dependencies: [], createdAt: now, updatedAt: now,
  });
  return { artifacts: new ArtifactRepository(db), workItemId: 'wi-1' };
}

// Builds an SLE-OUTPUT preamble with an optional `verdict:` line, mirroring
// the declarative-workflow-contract.test.ts helper of the same name.
function sleOutput(
  artifacts: Array<{ id: string; path: string }>,
  sections: Array<{ path: string; content: string }>,
  verdict?: string,
): string {
  const preamble = [
    '<!-- SLE-OUTPUT',
    'role: explorer',
    'node: readiness-review',
    ...(verdict !== undefined ? [`verdict: ${verdict}`] : []),
    'artifacts:',
    ...artifacts.map((a) => `  - id: ${a.id}\n    path: ${a.path}`),
    '-->',
  ].join('\n');
  const body = sections.map((s) => `## ${s.path}\n\n${s.content}`).join('\n\n---\n\n');
  return `${preamble}\n\n${body}`;
}

// ============================================================================
// Part A.1 — AgentRunner: semantic verdict parsing
// ============================================================================

test('D.3b0: verdict:pass on an opted-in step is exposed as reviewVerdict=pass on a successful execution', async () => {
  const output = sleOutput(
    [{ id: 'readiness', path: '.sle/work/readiness.md' }],
    [{ path: '.sle/work/readiness.md', content: 'All seven dimensions pass.' }],
    'pass',
  );
  const { mock } = mockFs();
  const runner = makeAgentRunner({ fsMock: mock, llmProvider: new MockLLMProvider(output) });

  const ctx = ctxFor('readiness-review', { requiresReviewVerdict: true });
  const result = await runner.run('explorer', ctx);

  assert.ok(result.success, `expected success, got: ${result.error}`);
  assert.equal(result.reviewVerdict, 'pass');
});

test('D.3b0: verdict:fail is a successful execution (not an execution failure), and its artifact/provenance is preserved', async () => {
  const { artifacts, workItemId } = testDb();
  const output = sleOutput(
    [{ id: 'readiness', path: '.sle/work/readiness.md' }],
    [{ path: '.sle/work/readiness.md', content: 'Dimension 6 (acceptance) fails: no criteria stated.' }],
    'fail',
  );
  const { mock, written } = mockFs();
  const runner = makeAgentRunner({ fsMock: mock, llmProvider: new MockLLMProvider(output), artifactRepository: artifacts });

  const ctx = ctxFor('readiness-review', {
    workItemId,
    requiresReviewVerdict: true,
    outputArtifact: { type: 'definition-readiness', ref: 'definition-readiness:obj-1', path: '.sle/work/readiness.md' },
  });
  const result = await runner.run('explorer', ctx);

  assert.ok(result.success, `expected success, got: ${result.error}`);
  assert.equal(result.reviewVerdict, 'fail');
  assert.ok(written['/project-d3b0/.sle/work/readiness.md']?.includes('Dimension 6'), 'the semantic-fail artifact must still be written to disk');
  const rows = artifacts.listByWorkflowRun('d3b0-run-1');
  assert.equal(rows.length, 1, 'a semantic-fail review artifact must still be recorded as provenance');
  assert.equal(rows[0].ref, 'definition-readiness:obj-1');
});

test('D.3b0: a missing verdict on an opted-in step fails closed as an execution failure', async () => {
  const output = sleOutput(
    [{ id: 'readiness', path: '.sle/work/readiness.md' }],
    [{ path: '.sle/work/readiness.md', content: 'No verdict line at all.' }],
    // verdict omitted entirely
  );
  const { mock } = mockFs();
  const runner = makeAgentRunner({ fsMock: mock, llmProvider: new MockLLMProvider(output) });

  const ctx = ctxFor('readiness-review', { requiresReviewVerdict: true });
  const result = await runner.run('explorer', ctx);

  assert.equal(result.success, false);
  assert.equal(result.reviewVerdict, undefined);
  assert.match(result.error ?? '', /requires a review verdict/);
});

test('D.3b0: an invalid verdict value fails closed', async () => {
  const output = sleOutput(
    [{ id: 'readiness', path: '.sle/work/readiness.md' }],
    [{ path: '.sle/work/readiness.md', content: 'garbled verdict' }],
    'maybe',
  );
  const { mock } = mockFs();
  const runner = makeAgentRunner({ fsMock: mock, llmProvider: new MockLLMProvider(output) });

  const ctx = ctxFor('readiness-review', { requiresReviewVerdict: true });
  const result = await runner.run('explorer', ctx);

  assert.equal(result.success, false);
  assert.match(result.error ?? '', /requires a review verdict/);
});

test('D.3b0: a non-opted-in step never inspects verdict at all — legacy AgentRunner behavior unchanged', async () => {
  const output = sleOutput(
    [{ id: 'readiness', path: '.sle/work/readiness.md' }],
    [{ path: '.sle/work/readiness.md', content: 'no verdict, no opt-in, and that is fine' }],
    // no verdict, and ctx.requiresReviewVerdict is absent below
  );
  const { mock } = mockFs();
  const runner = makeAgentRunner({ fsMock: mock, llmProvider: new MockLLMProvider(output) });

  const result = await runner.run('explorer', ctxFor('some-legacy-step'));

  assert.ok(result.success, `expected success, got: ${result.error}`);
  assert.equal(result.reviewVerdict, undefined);
});

test('D.3b0: a transport/LLM failure is an execution failure, never treated as a semantic verdict', async () => {
  const runner = makeAgentRunner({ fsMock: mockFs().mock, llmProvider: new ThrowingLLMProvider() });
  const result = await runner.run('explorer', ctxFor('readiness-review', { requiresReviewVerdict: true }));

  assert.equal(result.success, false);
  assert.match(result.error ?? '', /LLM call failed/);
  assert.equal(result.reviewVerdict, undefined, 'a transport failure must never be reported as a semantic verdict');
});

test('D.3b0: an output-parsing failure (malformed preamble) is an execution failure, never a semantic NOT_READY', async () => {
  const runner = makeAgentRunner({ fsMock: mockFs().mock, llmProvider: new MockLLMProvider('not SLE output at all') });
  const result = await runner.run('explorer', ctxFor('readiness-review', { requiresReviewVerdict: true }));

  assert.equal(result.success, false);
  assert.match(result.error ?? '', /Output parsing failed/);
  assert.equal(result.reviewVerdict, undefined);
});

// ============================================================================
// Part A.2 — WorkflowEngine.executeReview: routing on the semantic verdict
// ============================================================================

function makeStubDeps(overrides: Partial<WorkflowEngineDeps> = {}): WorkflowEngineDeps {
  return {
    stepRunner: {
      run: async () => ({ success: true, artifacts_written: [], tokens_used: 0, duration_ms: 1 }),
    } as any,
    mapManager: { read: async () => ({ artifacts: [] }), update: async () => {} } as any,
    runArtifacts: {
      updateNodeStatus: async () => {},
      createRunDir: async () => {},
      createManifest: async () => {},
    } as any,
    projectRoot: '/tmp/d3b0-engine',
    ...overrides,
  };
}

function makeStubOpts(overrides: Partial<WorkflowEngineOptions> = {}): WorkflowEngineOptions {
  return { onCheckpoint: async () => 'approve', ...overrides };
}

test('D.3b0: requiresReviewVerdict:true routes on_pass when the semantic verdict is pass', async () => {
  registerWorkflow({
    id: 'd3b0-review-pass',
    label: 'D.3b0 review pass',
    steps: [
      { id: 'review', kind: 'review', requiresReviewVerdict: true, on_pass: { target_step_id: 'done' }, on_fail: { target_step_id: 'blocked' } },
      { id: 'done', kind: 'commit' },
      { id: 'blocked', kind: 'commit' },
    ],
  });
  const deps = makeStubDeps({
    stepRunner: { run: async () => ({ success: true, reviewVerdict: 'pass', artifacts_written: [], tokens_used: 0, duration_ms: 1 }) } as any,
  });
  const engine = new WorkflowEngine(deps, makeStubOpts());
  const result = await engine.run('d3b0-review-pass', 'r1', 'Test');

  assert.equal(result.status, 'complete');
  assert.equal(result.final_step_id, 'done');
});

test('D.3b0: requiresReviewVerdict:true routes on_fail when the semantic verdict is fail', async () => {
  registerWorkflow({
    id: 'd3b0-review-fail',
    label: 'D.3b0 review fail',
    steps: [
      { id: 'review', kind: 'review', requiresReviewVerdict: true, on_pass: { target_step_id: 'done' }, on_fail: { target_step_id: 'blocked' } },
      { id: 'done', kind: 'commit' },
      { id: 'blocked', kind: 'commit' },
    ],
  });
  const deps = makeStubDeps({
    stepRunner: { run: async () => ({ success: true, reviewVerdict: 'fail', artifacts_written: [], tokens_used: 0, duration_ms: 1 }) } as any,
  });
  const engine = new WorkflowEngine(deps, makeStubOpts());
  const result = await engine.run('d3b0-review-fail', 'r2', 'Test');

  assert.equal(result.status, 'complete');
  assert.equal(result.final_step_id, 'blocked', 'a semantic fail must route through on_fail, not halt');
});

test('D.3b0: requiresReviewVerdict:true halts (does not route on_fail) on an execution failure', async () => {
  registerWorkflow({
    id: 'd3b0-review-exec-fail',
    label: 'D.3b0 review exec fail',
    steps: [
      { id: 'review', kind: 'review', requiresReviewVerdict: true, on_pass: { target_step_id: 'done' }, on_fail: { target_step_id: 'blocked' } },
      { id: 'done', kind: 'commit' },
      { id: 'blocked', kind: 'commit' },
    ],
  });
  const deps = makeStubDeps({
    stepRunner: { run: async () => ({ success: false, artifacts_written: [], tokens_used: 0, duration_ms: 1, error: 'provider boom' }) } as any,
  });
  const engine = new WorkflowEngine(deps, makeStubOpts());
  const result = await engine.run('d3b0-review-exec-fail', 'r3', 'Test');

  assert.equal(result.status, 'halted');
  assert.equal(result.final_step_id, 'review', 'must halt at the review step, not advance to on_fail\'s target');
  assert.ok(result.error?.includes('provider boom'));
});

test('D.3b0: requiresReviewVerdict:true halts when execution succeeded but no verdict was produced', async () => {
  registerWorkflow({
    id: 'd3b0-review-missing-verdict',
    label: 'D.3b0 review missing verdict',
    steps: [
      { id: 'review', kind: 'review', requiresReviewVerdict: true, on_pass: { target_step_id: 'done' }, on_fail: { target_step_id: 'blocked' } },
      { id: 'done', kind: 'commit' },
      { id: 'blocked', kind: 'commit' },
    ],
  });
  const deps = makeStubDeps({
    stepRunner: { run: async () => ({ success: true, artifacts_written: [], tokens_used: 0, duration_ms: 1 }) } as any,
  });
  const engine = new WorkflowEngine(deps, makeStubOpts());
  const result = await engine.run('d3b0-review-missing-verdict', 'r4', 'Test');

  assert.equal(result.status, 'halted');
  assert.equal(result.final_step_id, 'review');
});

test('D.3b0: requiresReviewVerdict:true halts when the verdict value is invalid', async () => {
  registerWorkflow({
    id: 'd3b0-review-invalid-verdict',
    label: 'D.3b0 review invalid verdict',
    steps: [
      { id: 'review', kind: 'review', requiresReviewVerdict: true, on_pass: { target_step_id: 'done' }, on_fail: { target_step_id: 'blocked' } },
      { id: 'done', kind: 'commit' },
      { id: 'blocked', kind: 'commit' },
    ],
  });
  const deps = makeStubDeps({
    stepRunner: { run: async () => ({ success: true, reviewVerdict: 'maybe' as any, artifacts_written: [], tokens_used: 0, duration_ms: 1 }) } as any,
  });
  const engine = new WorkflowEngine(deps, makeStubOpts());
  const result = await engine.run('d3b0-review-invalid-verdict', 'r5', 'Test');

  assert.equal(result.status, 'halted');
  assert.equal(result.final_step_id, 'review');
});

test('D.3b0: a non-opt-in review step keeps its exact legacy routing (success -> on_pass, failure -> on_fail)', async () => {
  registerWorkflow({
    id: 'd3b0-legacy-review',
    label: 'D.3b0 legacy review',
    steps: [
      { id: 'review', kind: 'review', on_pass: { target_step_id: 'done' }, on_fail: { target_step_id: 'blocked' } },
      { id: 'done', kind: 'commit' },
      { id: 'blocked', kind: 'commit' },
    ],
  });

  const passDeps = makeStubDeps({
    stepRunner: { run: async () => ({ success: true, artifacts_written: [], tokens_used: 0, duration_ms: 1 }) } as any,
  });
  const passResult = await new WorkflowEngine(passDeps, makeStubOpts()).run('d3b0-legacy-review', 'r6a', 'Test');
  assert.equal(passResult.final_step_id, 'done', 'legacy success must still route on_pass');

  const failDeps = makeStubDeps({
    stepRunner: { run: async () => ({ success: false, artifacts_written: [], tokens_used: 0, duration_ms: 1, error: 'x' }) } as any,
  });
  const failResult = await new WorkflowEngine(failDeps, makeStubOpts()).run('d3b0-legacy-review', 'r6b', 'Test');
  assert.equal(failResult.status, 'complete');
  assert.equal(failResult.final_step_id, 'blocked', 'legacy execution failure (success:false) must still route on_fail, unlike an opted-in step');
});

test('D.3b0: full-build never opts any step into requiresReviewVerdict (structural — full-build must remain unchanged)', () => {
  for (const step of FULL_BUILD.steps) {
    assert.notEqual(step.requiresReviewVerdict, true, `full-build step '${step.id}' must not declare requiresReviewVerdict`);
  }
});

// ============================================================================
// Part B — WorkItem context threading
// ============================================================================

test('D.3b0: includeWorkItemContext:true renders constraints and acceptance criteria into the assembled task text', async () => {
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, mockFs().mock);
  const result = await cm.assemble('explorer', ctxFor('readiness-review', {
    includeWorkItemContext: true,
    workItemConstraints: [{ description: 'Must use the existing Artifact machinery', type: 'must' }],
    workItemAcceptanceCriteria: [{ description: 'Readiness rubric passes for the bounded scope' }],
  }));

  assert.ok(result.task.includes('Must use the existing Artifact machinery'), 'constraint text must be rendered');
  assert.ok(result.task.includes('Readiness rubric passes for the bounded scope'), 'acceptance criterion text must be rendered');
});

test('D.3b0: without includeWorkItemContext, the same constraints/acceptance criteria are NOT rendered (legacy context unchanged)', async () => {
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, mockFs().mock);
  const result = await cm.assemble('explorer', ctxFor('readiness-review', {
    // includeWorkItemContext intentionally omitted
    workItemConstraints: [{ description: 'Must use the existing Artifact machinery', type: 'must' }],
    workItemAcceptanceCriteria: [{ description: 'Readiness rubric passes for the bounded scope' }],
  }));

  assert.ok(!result.task.includes('Must use the existing Artifact machinery'));
  assert.ok(!result.task.includes('Readiness rubric passes for the bounded scope'));
});

test('D.3b0: goal remains available via ctx.goal regardless of includeWorkItemContext', async () => {
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, mockFs().mock);
  const result = await cm.assemble('explorer', ctxFor('readiness-review', {
    goal: 'A very specific bounded goal',
    includeWorkItemContext: false,
  }));
  assert.ok(result.task.includes('A very specific bounded goal'));
});

test('D.3b0: WorkflowEngine threads workItemConstraints/workItemAcceptanceCriteria onto StepRunContext for every step, gated rendering only by the step\'s own includeWorkItemContext flag', async () => {
  registerWorkflow({
    id: 'd3b0-context-threading',
    label: 'D.3b0 context threading',
    steps: [
      { id: 'opted-in', kind: 'produce', agentRole: 'explorer', includeWorkItemContext: true },
      { id: 'not-opted-in', kind: 'produce', agentRole: 'explorer' },
    ],
  });

  const captured: StepRunContext[] = [];
  const deps = makeStubDeps({
    stepRunner: {
      run: async (_step: unknown, ctx: StepRunContext) => {
        captured.push(ctx);
        return { success: true, artifacts_written: [], tokens_used: 0, duration_ms: 1 };
      },
    } as any,
  });

  const constraints = [{ description: 'must not exceed budget', type: 'must' }];
  const acceptanceCriteria = [{ description: 'definition is ready' }];

  await new WorkflowEngine(deps, makeStubOpts()).run(
    'd3b0-context-threading', 'r7', 'Test', undefined, 'wi-thread', undefined, undefined,
    'obj-thread', constraints, acceptanceCriteria,
  );

  assert.equal(captured.length, 2);
  assert.deepStrictEqual(captured[0].workItemConstraints, constraints, 'data is threaded onto ctx regardless of opt-in');
  assert.deepStrictEqual(captured[0].workItemAcceptanceCriteria, acceptanceCriteria);
  assert.equal(captured[0].includeWorkItemContext, true, 'the opted-in step carries the flag');
  assert.equal(captured[1].includeWorkItemContext, undefined, 'the non-opted-in step does not carry the flag, even though the same data is present');
  assert.deepStrictEqual(captured[1].workItemConstraints, constraints, 'data presence alone must not imply rendering — see the ContextManager tests above');
});

// ============================================================================
// Part C.1 — artifact-refs.ts: placeholder materialization (unit level)
// ============================================================================

test('D.3b0: a template with no placeholders is returned unchanged', () => {
  const result = materializeTemplate('.sle/work/definition.md', { workItemId: 'wi-1', objectiveId: 'obj-1' });
  assert.ok(result.ok);
  if (result.ok) assert.equal(result.value, '.sle/work/definition.md');
});

test('D.3b0: {workItemId} and {objectiveId} are substituted correctly', () => {
  const pathResult = materializeTemplate('.sle/work/{workItemId}/definition.md', { workItemId: 'wi-abc', objectiveId: 'obj-xyz' });
  assert.ok(pathResult.ok);
  if (pathResult.ok) assert.equal(pathResult.value, '.sle/work/wi-abc/definition.md');

  const refResult = materializeTemplate('definition:{objectiveId}', { workItemId: 'wi-abc', objectiveId: 'obj-xyz' });
  assert.ok(refResult.ok);
  if (refResult.ok) assert.equal(refResult.value, 'definition:obj-xyz');
});

test('D.3b0: an unknown placeholder fails closed', () => {
  const result = materializeTemplate('.sle/work/{bogus}/x.md', { workItemId: 'wi-1', objectiveId: 'obj-1' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /Unknown placeholder.*bogus/);
});

test('D.3b0: a required placeholder with no value for this run fails closed', () => {
  const result = materializeTemplate('definition:{objectiveId}', { workItemId: 'wi-1', objectiveId: undefined });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /Required placeholder.*objectiveId/);
});

test('D.3b0: materializeStepRunContext materializes both outputArtifact.ref and .path, and every inputArtifactRefs entry', () => {
  const ctx = ctxFor('synthesize-definition', {
    workItemId: 'wi-1',
    objectiveId: 'obj-1',
    outputArtifact: { type: 'definition', ref: 'definition:{objectiveId}', path: '.sle/work/{workItemId}/definition.md' },
    inputArtifactRefs: ['definition:{objectiveId}', '.sle/work/{workItemId}/readiness.md', 'doc:static-ref'],
  });
  const result = materializeStepRunContext(ctx);

  assert.ok(result.ok, !result.ok ? result.error : undefined);
  if (!result.ok) return;
  assert.deepStrictEqual(result.value.outputArtifact, {
    type: 'definition', ref: 'definition:obj-1', path: '.sle/work/wi-1/definition.md',
  });
  assert.deepStrictEqual(result.value.inputArtifactRefs, [
    'definition:obj-1', '.sle/work/wi-1/readiness.md', 'doc:static-ref',
  ]);
});

test('D.3b0: a context with neither outputArtifact nor inputArtifactRefs is returned unchanged', () => {
  const ctx = ctxFor('gather', { workItemId: 'wi-1', objectiveId: 'obj-1' });
  const result = materializeStepRunContext(ctx);
  assert.ok(result.ok);
  if (result.ok) assert.equal(result.value, ctx, 'workflows with no placeholders must be a true no-op, not a clone');
});

test('D.3b0: two different WorkItems materialize the same template to different, non-colliding paths', () => {
  const a = materializeTemplate('.sle/work/{workItemId}/definition.md', { workItemId: 'wi-AAA' });
  const b = materializeTemplate('.sle/work/{workItemId}/definition.md', { workItemId: 'wi-BBB' });
  assert.ok(a.ok && b.ok);
  if (a.ok && b.ok) assert.notEqual(a.value, b.value);
});

// ============================================================================
// Part C.2 — WorkflowEngine integration: materialize before any mutation
// ============================================================================

function materializationWorkflow(id: string): WorkflowDefinition {
  return {
    id,
    label: 'D.3b0 materialization',
    steps: [
      {
        id: 'synthesize-definition',
        kind: 'produce',
        agentRole: 'explorer',
        outputArtifact: { type: 'definition', ref: 'definition:{objectiveId}', path: '.sle/work/{workItemId}/definition.md' },
      },
    ],
  };
}

test('D.3b0: WorkflowEngine materializes placeholders before stepRunner.run is ever called', async () => {
  registerWorkflow(materializationWorkflow('d3b0-materialize-ok'));
  const captured: StepRunContext[] = [];
  const deps = makeStubDeps({
    stepRunner: {
      run: async (_step: unknown, ctx: StepRunContext) => {
        captured.push(ctx);
        return { success: true, artifacts_written: [], tokens_used: 0, duration_ms: 1 };
      },
    } as any,
  });

  const result = await new WorkflowEngine(deps, makeStubOpts()).run(
    'd3b0-materialize-ok', 'r8', 'Test', undefined, 'wi-42', undefined, undefined, 'obj-99',
  );

  assert.equal(result.status, 'complete');
  assert.equal(captured.length, 1);
  assert.deepStrictEqual(captured[0].outputArtifact, {
    type: 'definition', ref: 'definition:obj-99', path: '.sle/work/wi-42/definition.md',
  });
});

test('D.3b0: a missing objectiveId for a declaration requiring {objectiveId} fails before stepRunner.run is called', async () => {
  registerWorkflow(materializationWorkflow('d3b0-materialize-missing-objective'));
  let calls = 0;
  const deps = makeStubDeps({
    stepRunner: { run: async () => { calls++; return { success: true, artifacts_written: [], tokens_used: 0, duration_ms: 1 }; } } as any,
  });

  const result = await new WorkflowEngine(deps, makeStubOpts()).run(
    'd3b0-materialize-missing-objective', 'r9', 'Test', undefined, 'wi-42',
    // objectiveId intentionally omitted
  );

  assert.equal(result.status, 'halted');
  assert.match(result.error ?? '', /objectiveId/);
  assert.equal(calls, 0, 'stepRunner.run (which calls AgentRunner -> the LLM and filesystem) must never be invoked');
});

test('D.3b0: an unknown placeholder in a declared ref fails closed at the engine level, before stepRunner.run is called', async () => {
  registerWorkflow({
    id: 'd3b0-materialize-unknown-placeholder',
    label: 'D.3b0 unknown placeholder',
    steps: [{
      id: 'synthesize-definition', kind: 'produce', agentRole: 'explorer',
      outputArtifact: { type: 'definition', ref: 'definition:{bogus}', path: '.sle/work/{workItemId}/definition.md' },
    }],
  });
  let calls = 0;
  const deps = makeStubDeps({
    stepRunner: { run: async () => { calls++; return { success: true, artifacts_written: [], tokens_used: 0, duration_ms: 1 }; } } as any,
  });

  const result = await new WorkflowEngine(deps, makeStubOpts()).run(
    'd3b0-materialize-unknown-placeholder', 'r10', 'Test', undefined, 'wi-42', undefined, undefined, 'obj-99',
  );

  assert.equal(result.status, 'halted');
  assert.match(result.error ?? '', /Unknown placeholder/);
  assert.equal(calls, 0);
});

test('D.3b0: two engine runs for different WorkItems never target the same materialized output path', async () => {
  registerWorkflow(materializationWorkflow('d3b0-materialize-no-collision'));
  const captured: StepRunContext[] = [];
  const deps = makeStubDeps({
    stepRunner: {
      run: async (_step: unknown, ctx: StepRunContext) => {
        captured.push(ctx);
        return { success: true, artifacts_written: [], tokens_used: 0, duration_ms: 1 };
      },
    } as any,
  });

  await new WorkflowEngine(deps, makeStubOpts()).run(
    'd3b0-materialize-no-collision', 'r11a', 'Test', undefined, 'wi-A', undefined, undefined, 'obj-A',
  );
  await new WorkflowEngine(deps, makeStubOpts()).run(
    'd3b0-materialize-no-collision', 'r11b', 'Test', undefined, 'wi-B', undefined, undefined, 'obj-B',
  );

  assert.equal(captured.length, 2);
  assert.notEqual(captured[0].outputArtifact?.path, captured[1].outputArtifact?.path);
  assert.equal(captured[0].outputArtifact?.path, '.sle/work/wi-A/definition.md');
  assert.equal(captured[1].outputArtifact?.path, '.sle/work/wi-B/definition.md');
});

// ============================================================================
// Part D — objectiveId survives Scheduler -> ExecutionRequest -> adapter -> run context
// ============================================================================

function makeWorkspace(): Workspace {
  return { id: randomUUID(), name: 'd3b0-ws', createdAt: new Date().toISOString() };
}

function makeProject(workspaceId: string): Project {
  const now = new Date().toISOString();
  return { id: randomUUID(), workspaceId, name: 'd3b0-proj', status: 'active', priority: 0, createdAt: now, updatedAt: now };
}

function seedObjective(db: ReturnType<typeof openDatabase>, projectId: string): string {
  const now = new Date().toISOString();
  const id = randomUUID();
  new ObjectiveRepository(db).save({
    id, projectId, title: 'D.3b0 objective', description: 'desc', priority: 0,
    status: 'draft', constraints: [], successCriteria: [], createdAt: now, updatedAt: now,
  } as Objective);
  return id;
}

function makeWorkItem(projectId: string, overrides: Partial<WorkItem> = {}): WorkItem {
  const now = new Date().toISOString();
  return {
    id: randomUUID(), projectId, repositoryIds: [],
    title: 'D.3b0 work item', goal: 'Prove objectiveId threading', workflowId: 'a-workflow-id-that-does-not-exist-in-the-registry',
    state: 'ready', priority: 0,
    acceptanceCriteria: [], constraints: [], requiredEvidence: [],
    dependencies: [], createdAt: now, updatedAt: now,
    ...overrides,
  };
}

class CapturingAdapter implements ExecutionAdapter {
  readonly id = 'd3b0-capturing-adapter';
  requests: ExecutionRequest[] = [];
  getCapabilities(): CapabilitySet { return new Set(['repo.read', 'repo.write']); }
  async execute(req: ExecutionRequest): Promise<ExecutionResult> {
    this.requests.push(req);
    return {
      schemaVersion: 1, stepExecutionId: req.stepExecutionId, outcome: 'succeeded',
      artifacts: [], evidenceClaims: [], decisionRequests: [], usage: { durationMs: 1 },
    };
  }
}

test('D.3b0: Scheduler threads WorkItem.objectiveId into the ExecutionRequest', async () => {
  const db = openDatabase(':memory:');
  const workspace = makeWorkspace();
  new WorkspaceRepository(db).save(workspace);
  const project = makeProject(workspace.id);
  new ProjectRepository(db).save(project);
  const objectiveId = seedObjective(db, project.id);
  const wi = makeWorkItem(project.id, { objectiveId });
  new WorkItemRepository(db).save(wi);

  const adapter = new CapturingAdapter();
  const registry = new ExecutorRegistry();
  registry.register(adapter);
  const scheduler = new Scheduler(db, workspace.id, registry);
  await scheduler.tick();

  assert.equal(adapter.requests.length, 1);
  assert.equal(adapter.requests[0].objectiveId, objectiveId);
});

test('D.3b0: a WorkItem with no Objective threads objectiveId as undefined, not a placeholder value', async () => {
  const db = openDatabase(':memory:');
  const workspace = makeWorkspace();
  new WorkspaceRepository(db).save(workspace);
  const project = makeProject(workspace.id);
  new ProjectRepository(db).save(project);
  const wi = makeWorkItem(project.id); // no objectiveId
  new WorkItemRepository(db).save(wi);

  const adapter = new CapturingAdapter();
  const registry = new ExecutorRegistry();
  registry.register(adapter);
  const scheduler = new Scheduler(db, workspace.id, registry);
  await scheduler.tick();

  assert.equal(adapter.requests.length, 1);
  assert.equal(adapter.requests[0].objectiveId, undefined);
});

test('D.3b0: StratumAgentAdapter forwards ExecutionRequest.objectiveId/constraints/acceptanceCriteria onto StepRunContext', async () => {
  registerWorkflow({
    id: 'd3b0-adapter-threading',
    label: 'D.3b0 adapter threading',
    steps: [{ id: 'start', kind: 'produce', agentRole: 'explorer', includeWorkItemContext: true }],
  });

  const captured: StepRunContext[] = [];
  const engineDeps = makeStubDeps({
    stepRunner: {
      run: async (_step: unknown, ctx: StepRunContext) => {
        captured.push(ctx);
        return { success: true, artifacts_written: [], tokens_used: 0, duration_ms: 1 };
      },
    } as any,
  });
  const engineOpts = makeStubOpts();
  const adapter = new StratumAgentAdapter(engineDeps, engineOpts);

  const constraints = [{ description: 'stay bounded', type: 'must' }];
  const acceptanceCriteria = [{ description: 'proves the seam works' }];

  await adapter.execute({
    stepExecutionId: 'se-1',
    workItemId: 'wi-adapter-1',
    workflowRunId: 'run-adapter-1',
    stepId: '__start__',
    workflowId: 'd3b0-adapter-threading',
    repositories: [],
    goal: 'test',
    objectiveId: 'obj-adapter-1',
    acceptanceCriteria,
    constraints,
    permissions: { pushBranch: false, createPr: false, merge: false },
    budget: {},
  });

  assert.equal(captured.length, 1);
  assert.equal(captured[0].objectiveId, 'obj-adapter-1');
  assert.deepStrictEqual(captured[0].workItemConstraints, constraints);
  assert.deepStrictEqual(captured[0].workItemAcceptanceCriteria, acceptanceCriteria);
});
