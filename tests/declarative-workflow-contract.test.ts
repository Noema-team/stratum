// D.1b/D.1c — permanent regression suite for the declarative workflow-step
// contract. Supersedes the deleted observational spike
// (tests/d1a-declarative-contract-spike.test.ts); see
// docs/developmentPlan/d1a-declarative-contract-spike.md for the full
// design rationale, including the D.1c review corrections (internal path
// traversal, inputArtifactRefs scoping, provenance versioning, the
// /work/:id/artifacts endpoint — tested separately in tests/api.test.ts).
//
// Exercises the real, unmodified-by-mocks: ContextManager, AgentRunner
// (agent-runner.ts), StratumAgentAdapter, and FullBuildStepRunner code
// paths. Uses synthetic, unfamiliar step ids and a workflow id
// ('define-work') that does not exist in the registry, matching the
// original spike's approach.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { ContextManager, DEFAULT_CONFIG } from '../src/context-manager.js';
import { AgentRunner } from '../src/agent-runner.js';
import { FullBuildStepRunner } from '../src/execution/full-build-step-runner.js';
import { StratumAgentAdapter } from '../src/execution/stratum-agent-adapter.js';
import { openDatabase } from '../src/storage/database.js';
import { ArtifactRepository, WorkspaceRepository, ProjectRepository, WorkItemRepository } from '../src/storage/repositories.js';
import type { StepRunContext, WorkflowStep } from '../src/workflow/types.js';
import type { AssembledContext } from '../src/types.js';
import type { ILLMProvider, LLMCompletionParams, LLMCompletionResult } from '../src/llm-provider.js';
import type { RunArtifactManager } from '../src/run-artifacts.js';

// ─── Shared fixtures ───────────────────────────────────────────────────────

const ROOT = '/project';

function docPath(key: string): string {
  return `/project/.sle/project-docs/${key}.md`;
}

function ctxFor(stepId: string, overrides: Partial<StepRunContext> = {}): StepRunContext {
  return {
    workflowRunId: 'spike-run-1',
    workflowId: 'define-work', // a workflow id that does not exist in the registry
    stepId,
    iteration: 1,
    revision: 0,
    goal: 'Make Evershift multiplayer-capable',
    projectRoot: ROOT,
    ...overrides,
  };
}

function makeFsMock(files: Record<string, string> = {}): typeof import('fs').promises {
  return {
    readFile: async (filePath: unknown) => {
      const p = filePath as string;
      if (p in files) return files[p];
      const err = Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      throw err;
    },
  } as unknown as typeof import('fs').promises;
}

// ============================================================================
// Part 1 — ContextManager: instruction + inputArtifactRefs
// ============================================================================

test('D.1b: a declared instruction reaches the assembled task text, ahead of the legacy step-id map', async () => {
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, makeFsMock());
  const result = await cm.assemble('explorer', ctxFor('investigate-domain', {
    instruction: 'Investigate whether the repository already has networking code.',
  }));

  assert.ok(result.task.startsWith('Investigate whether the repository already has networking code.'));
  assert.ok(!result.task.includes('Execute the investigate-domain step.'));
});

test('D.1b: without a declared instruction, full-build\'s legacy task-description behavior is unchanged', async () => {
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, makeFsMock());
  const result = await cm.assemble('designer', ctxFor('DESIGN', { workflowId: 'full-build' }));

  assert.ok(result.task.startsWith('Design the requirements and architecture'));
});

test('D.1b: declared inputArtifactRefs fully replace the role\'s default slice set (not additive)', async () => {
  const files = {
    [docPath('special-finding')]: 'a fact only this step should see',
    [docPath('system-description')]: 'role-default content the step did NOT ask for',
  };
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, makeFsMock(files));

  const result = await cm.assemble('explorer', ctxFor('investigate-domain', {
    inputArtifactRefs: ['doc:special-finding'],
  }));

  assert.ok('special-finding' in result.artifact_slices, 'declared ref should be loaded');
  assert.ok(
    !('system-description' in result.artifact_slices),
    'explorer\'s default slice set (EXPLORER_SLICES) must not leak in when refs are declared'
  );
});

test('D.1b: without declared inputArtifactRefs, role-default slice selection is unchanged', async () => {
  const files = { [docPath('system-description')]: 'role-default content' };
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, makeFsMock(files));

  const result = await cm.assemble('explorer', ctxFor('investigate-domain'));

  assert.ok('system-description' in result.artifact_slices);
});

test('D.1c: an explicit empty inputArtifactRefs means zero slices, not a fall-back to role defaults', async () => {
  const files = { [docPath('system-description')]: 'role-default content' };
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, makeFsMock(files));

  const result = await cm.assemble('explorer', ctxFor('investigate-domain', { inputArtifactRefs: [] }));

  assert.deepStrictEqual(result.artifact_slices, {}, 'declaring [] opts out of role defaults entirely');
});

test('D.1c: a bare-ref traversal is not read', async () => {
  // The "secret" file is registered at a path outside projectRoot; if the
  // traversal were followed, it would resolve there.
  const files = { '/etc/secret': 'top secret' };
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, makeFsMock(files));

  const result = await cm.assemble('explorer', ctxFor('investigate-domain', {
    inputArtifactRefs: ['../../../../etc/secret'],
  }));

  assert.deepStrictEqual(result.artifact_slices, {});
});

test('D.1c: a structured doc: ref traversal is not read', async () => {
  const files = { '/etc/secret': 'top secret' };
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, makeFsMock(files));

  const result = await cm.assemble('explorer', ctxFor('investigate-domain', {
    inputArtifactRefs: ['doc:../../../../etc/secret'],
  }));

  assert.deepStrictEqual(result.artifact_slices, {});
});

test('D.1c: a structured node: ref traversal is not read', async () => {
  const files = { '/etc/secret': 'top secret' };
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, makeFsMock(files));

  const result = await cm.assemble('explorer', ctxFor('investigate-domain', {
    inputArtifactRefs: ['node:../../../../etc:secret'],
  }));

  assert.deepStrictEqual(result.artifact_slices, {});
});

// ============================================================================
// Part 2 — AgentRunner: declared output narrows role authority
// ============================================================================

class MockLLMProvider implements ILLMProvider {
  constructor(private response: string) {}
  async complete(_params: LLMCompletionParams): Promise<LLMCompletionResult> {
    return { content: this.response, tokens_used: 10, duration_ms: 1 };
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
    task: 'Investigate.',
    token_count: 10,
    truncated: [],
  };
}

function sleOutput(artifacts: Array<{ id: string; path: string }>, sections: Array<{ path: string; content: string }>): string {
  const preamble = [
    '<!-- SLE-OUTPUT',
    'role: explorer',
    'node: investigate-domain',
    'artifacts:',
    ...artifacts.map((a) => `  - id: ${a.id}\n    path: ${a.path}`),
    '-->',
  ].join('\n');
  const body = sections.map((s) => `## ${s.path}\n\n${s.content}`).join('\n\n---\n\n');
  return `${preamble}\n\n${body}`;
}

function makeAgentRunner(opts: {
  fsMock: typeof import('fs').promises;
  llmResponse: string;
  artifactRepository?: ArtifactRepository;
}): AgentRunner {
  const cm = new MockContextManager(baseAssembledContext());
  const llm = new MockLLMProvider(opts.llmResponse);
  const ram = new MockRunArtifactManager();
  return new AgentRunner(
    cm as unknown as ContextManagerLike,
    llm,
    ROOT,
    ram as unknown as RunArtifactManager,
    { model: 'test-model' },
    opts.fsMock,
    opts.artifactRepository,
  );
}

// AgentRunner's constructor types its first param as ContextManager (a class);
// tests use a structurally-compatible mock, same pattern as tests/agent-runner.test.ts.
type ContextManagerLike = import('../src/context-manager.js').ContextManager;

// Seeds the minimal Workspace -> Project -> WorkItem chain the `artifacts`
// table's FK on work_item_id requires, so the "WorkItem linkage" assertions
// exercise a real referential link rather than an unchecked string.
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
    title: 'test work item', goal: 'test goal', workflowId: 'define-work',
    state: 'running', priority: 0,
    acceptanceCriteria: [], constraints: [], requiredEvidence: [],
    dependencies: [], createdAt: now, updatedAt: now,
  });
  return { artifacts: new ArtifactRepository(db), workItemId: 'wi-1' };
}

test('D.1b: an exact declared output is accepted and its provenance recorded', async () => {
  const { artifacts, workItemId } = testDb();
  const output = sleOutput(
    [{ id: 'definition', path: '.sle/work/definition.md' }],
    [{ path: '.sle/work/definition.md', content: 'Definition content.' }],
  );
  const { mock, written } = mockFs();
  const runner = makeAgentRunner({ fsMock: mock, llmResponse: output, artifactRepository: artifacts });

  const ctx = ctxFor('investigate-domain', {
    workItemId,
    workflowRunId: 'run-1',
    outputArtifact: { type: 'research', ref: 'definition:research', path: '.sle/work/definition.md' },
  });
  const result = await runner.run('explorer', ctx);

  assert.ok(result.success, `expected success, got: ${result.error}`);
  assert.deepStrictEqual(result.artifacts_written, ['.sle/work/definition.md']);
  assert.ok(written['/project/.sle/work/definition.md']?.includes('Definition content.'));

  const rows = artifacts.listByWorkflowRun('run-1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].workItemId, workItemId);
  assert.equal(rows[0].workflowRunId, 'run-1');
  assert.equal(rows[0].ref, 'definition:research');
  assert.equal(rows[0].type, 'research');
  assert.equal(rows[0].path, '.sle/work/definition.md');
  assert.ok(rows[0].hash && rows[0].hash.length > 0, 'hash should be recorded');
  assert.equal(rows[0].stepExecutionId, undefined, 'no per-step StepExecution exists yet — must not be invented');
});

test('D.1b: extra output sections are rejected when exactly one is declared (cardinality)', async () => {
  const { artifacts } = testDb();
  const output = sleOutput(
    [
      { id: 'a', path: '.sle/work/a.md' },
      { id: 'b', path: '.sle/work/b.md' },
    ],
    [
      { path: '.sle/work/a.md', content: 'A' },
      { path: '.sle/work/b.md', content: 'B' },
    ],
  );
  const { mock, written } = mockFs();
  const runner = makeAgentRunner({ fsMock: mock, llmResponse: output, artifactRepository: artifacts });

  const ctx = ctxFor('investigate-domain', {
    workflowRunId: 'run-2',
    outputArtifact: { type: 'research', ref: 'definition:research', path: '.sle/work/a.md' },
  });
  const result = await runner.run('explorer', ctx);

  assert.equal(result.success, false);
  assert.match(result.error ?? '', /exactly one output artifact/);
  assert.deepStrictEqual(Object.keys(written), [], 'no file should be written when cardinality is violated');
  assert.equal(artifacts.listByWorkflowRun('run-2').length, 0);
});

test('D.1b: a declared output path outside the role\'s ceiling is rejected — declaration cannot escalate authority', async () => {
  const { artifacts } = testDb();
  const output = sleOutput(
    [{ id: 'evil', path: 'src/evil.ts' }],
    [{ path: 'src/evil.ts', content: 'malicious' }],
  );
  const { mock, written } = mockFs();
  const runner = makeAgentRunner({ fsMock: mock, llmResponse: output, artifactRepository: artifacts });

  const ctx = ctxFor('investigate-domain', {
    workflowRunId: 'run-3',
    // exactly matches what the "LLM" produced, so §6a (cardinality/exact-match)
    // passes — the role ceiling in §6b must still reject it.
    outputArtifact: { type: 'code', ref: 'evil:code', path: 'src/evil.ts' },
  });
  const result = await runner.run('explorer', ctx);

  assert.equal(result.success, false);
  assert.match(result.error ?? '', /not permitted to write/);
  assert.deepStrictEqual(Object.keys(written), [], 'no file should be written when the role ceiling rejects the path');
  assert.equal(artifacts.listByWorkflowRun('run-3').length, 0);
});

test('D.1b: an unsafe traversal path (leaves projectRoot) fails before any write', async () => {
  const { artifacts } = testDb();
  const output = sleOutput(
    [{ id: 'x', path: '../../etc/passwd' }],
    [{ path: '../../etc/passwd', content: 'nope' }],
  );
  const { mock, written } = mockFs();
  const runner = makeAgentRunner({ fsMock: mock, llmResponse: output, artifactRepository: artifacts });

  const ctx = ctxFor('investigate-domain', {
    workflowRunId: 'run-4',
    outputArtifact: { type: 'research', ref: 'x:x', path: '../../etc/passwd' },
  });
  const result = await runner.run('explorer', ctx);

  assert.equal(result.success, false);
  assert.match(result.error ?? '', /Unsafe output path/);
  assert.deepStrictEqual(Object.keys(written), []);
});

test('D.1b: a declared path that is unsafe on its own (even when the produced section is safe and unrelated) is rejected', async () => {
  const { artifacts } = testDb();
  // The produced section itself is safe and would pass §6a's canonicalization,
  // isolating the declared-path check specifically.
  const output = sleOutput(
    [{ id: 'x', path: '.sle/work/fine.md' }],
    [{ path: '.sle/work/fine.md', content: 'fine' }],
  );
  const { mock, written } = mockFs();
  const runner = makeAgentRunner({ fsMock: mock, llmResponse: output, artifactRepository: artifacts });

  const ctx = ctxFor('investigate-domain', {
    workflowRunId: 'run-4b',
    outputArtifact: { type: 'research', ref: 'x:x', path: '../evil.md' },
  });
  const result = await runner.run('explorer', ctx);

  assert.equal(result.success, false);
  assert.match(result.error ?? '', /not a safe project-root-relative path/);
  assert.deepStrictEqual(Object.keys(written), []);
});

test('D.1c: internal traversal that stays inside projectRoot but escapes the declared .sle/work/ ceiling is rejected before any write', async () => {
  // '.sle/work/../../src/evil.ts' resolves to 'src/evil.ts', which:
  //  - is still inside projectRoot (a naive resolve+contain check would pass it);
  //  - literally starts with the string '.sle/work/' (a naive prefix-ceiling
  //    check on the raw string would also pass it);
  //  - but is NOT actually under '.sle/work/' once resolved, and 'explorer'
  //    is not permitted to write to src/.
  // This must be rejected outright (conservative '..'-segment rejection),
  // not resolved-then-checked, per docs/developmentPlan/d1a-declarative-contract-spike.md.
  const { artifacts } = testDb();
  const trickyPath = '.sle/work/../../src/evil.ts';
  const output = sleOutput(
    [{ id: 'x', path: trickyPath }],
    [{ path: trickyPath, content: 'malicious' }],
  );
  const { mock, written } = mockFs();
  const runner = makeAgentRunner({ fsMock: mock, llmResponse: output, artifactRepository: artifacts });

  const ctx = ctxFor('investigate-domain', {
    workflowRunId: 'run-4c',
    outputArtifact: { type: 'code', ref: 'evil:code', path: trickyPath },
  });
  const result = await runner.run('explorer', ctx);

  assert.equal(result.success, false);
  assert.match(result.error ?? '', /Unsafe output path/);
  assert.deepStrictEqual(Object.keys(written), [], 'no file should be written — the traversal must never resolve to src/evil.ts');
  assert.equal(artifacts.listByWorkflowRun('run-4c').length, 0);
});

test('D.1b: an unsafe path also fails for undeclared (legacy) output, not just declared output', async () => {
  // role: 'designer' (not 'builder') — parseAgentOutput dispatches builder
  // output through a different section format (## File: <path>); this test
  // is about the path-safety check, so use the standard `## <path>` format
  // sleOutput() produces, matching a non-builder role.
  const output = sleOutput(
    [{ id: 'x', path: '../../etc/passwd' }],
    [{ path: '../../etc/passwd', content: 'nope' }],
  );
  const { mock, written } = mockFs();
  const runner = makeAgentRunner({ fsMock: mock, llmResponse: output });

  // No ctx.outputArtifact — this is the legacy/undeclared path.
  const result = await runner.run('designer', ctxFor('DESIGN', { workflowId: 'full-build', workflowRunId: 'run-5' }));

  assert.equal(result.success, false);
  assert.match(result.error ?? '', /Unsafe output path/);
  assert.deepStrictEqual(Object.keys(written), []);
});

test('D.1b: retrying the same step does not duplicate the provenance row (idempotent)', async () => {
  const { artifacts, workItemId } = testDb();
  const output = sleOutput(
    [{ id: 'definition', path: '.sle/work/definition.md' }],
    [{ path: '.sle/work/definition.md', content: 'Definition content.' }],
  );
  const ctx = ctxFor('investigate-domain', {
    workItemId,
    workflowRunId: 'run-6',
    outputArtifact: { type: 'research', ref: 'definition:research', path: '.sle/work/definition.md' },
  });

  const { mock: mock1 } = mockFs();
  const runner1 = makeAgentRunner({ fsMock: mock1, llmResponse: output, artifactRepository: artifacts });
  const first = await runner1.run('explorer', ctx);
  assert.ok(first.success);

  // Simulate a retry of the same step (fresh runner/fs, same ctx/artifactRepository).
  const { mock: mock2 } = mockFs();
  const runner2 = makeAgentRunner({ fsMock: mock2, llmResponse: output, artifactRepository: artifacts });
  const second = await runner2.run('explorer', ctx);
  assert.ok(second.success);

  const rows = artifacts.listByWorkflowRun('run-6');
  assert.equal(rows.length, 1, 'retrying the same (workflowRunId, ref) must not create a duplicate row');
});

test('D.1c: refining the same ref within the same workflowRun (changed content) records a new version, not a duplicate', async () => {
  const { artifacts, workItemId } = testDb();
  const ctx = ctxFor('synthesize-definition', {
    workItemId,
    workflowRunId: 'run-refine',
    outputArtifact: { type: 'definition', ref: 'definition:definition', path: '.sle/work/definition.md' },
  });

  const v1 = sleOutput(
    [{ id: 'definition', path: '.sle/work/definition.md' }],
    [{ path: '.sle/work/definition.md', content: 'Definition v1.' }],
  );
  const { mock: mock1 } = mockFs();
  const r1 = await makeAgentRunner({ fsMock: mock1, llmResponse: v1, artifactRepository: artifacts }).run('explorer', ctx);
  assert.ok(r1.success, `v1 should succeed, got: ${r1.error}`);

  // A retry of v1 (identical content) must still not duplicate.
  const { mock: mock1retry } = mockFs();
  await makeAgentRunner({ fsMock: mock1retry, llmResponse: v1, artifactRepository: artifacts }).run('explorer', ctx);
  assert.equal(artifacts.listByWorkflowRun('run-refine').length, 1, 'identical retry of v1 must not duplicate');

  const v2 = sleOutput(
    [{ id: 'definition', path: '.sle/work/definition.md' }],
    [{ path: '.sle/work/definition.md', content: 'Definition v2 — refined after readiness review.' }],
  );
  const { mock: mock2 } = mockFs();
  const r2 = await makeAgentRunner({ fsMock: mock2, llmResponse: v2, artifactRepository: artifacts }).run('explorer', ctx);
  assert.ok(r2.success, `v2 should succeed, got: ${r2.error}`);

  const history = artifacts.listByWorkflowRun('run-refine');
  assert.equal(history.length, 2, 'v1 and v2 are both retained as separate provenance rows');
  assert.notEqual(history[0].hash, history[1].hash);

  const latest = artifacts.listLatestByWorkflowRun('run-refine');
  assert.equal(latest.length, 1, 'exactly one current version is projected for this ref');
  assert.equal(latest[0].hash, history[1].hash, 'the current version reflects v2, not v1');
});

test('D.1c: StratumAgentAdapter projects exactly one current ArtifactReference per logical ref, even with multiple recorded versions', async () => {
  const { artifacts, workItemId } = testDb();
  const runId = 'run-adapter-projection';
  const now = new Date().toISOString();
  artifacts.save({ id: 'a1', workItemId, workflowRunId: runId, type: 'definition', ref: 'definition:definition', path: '.sle/work/definition.md', hash: 'hashA', createdAt: now });
  artifacts.save({ id: 'a2', workItemId, workflowRunId: runId, type: 'definition', ref: 'definition:definition', path: '.sle/work/definition.md', hash: 'hashB', createdAt: now });
  artifacts.save({ id: 'a3', workItemId, workflowRunId: runId, type: 'proposal', ref: 'proposal:proposal', path: '.sle/work/proposal.md', hash: 'hashC', createdAt: now });

  // engine.run() is exercised against an unregistered workflowId so it fails
  // closed immediately (Unknown workflow) without needing a real StepRunner —
  // the artifact projection below happens unconditionally after engine.run()
  // returns, independent of the run's own outcome.
  const dummyStepRunner = { run: async () => ({ success: true, artifacts_written: [], tokens_used: 0, duration_ms: 0 }) };
  const engineDeps = { stepRunner: dummyStepRunner as any, mapManager: {} as any, runArtifacts: {} as any, projectRoot: '/nonexistent-d1c-adapter-test' };
  const engineOpts = { onCheckpoint: async () => 'halt' as const };
  const adapter = new StratumAgentAdapter(engineDeps, engineOpts, artifacts);

  const result = await adapter.execute({
    stepExecutionId: 'se-1',
    workItemId,
    workflowRunId: runId,
    stepId: '__start__',
    workflowId: 'nonexistent-workflow',
    repositories: [],
    goal: 'test',
    acceptanceCriteria: [],
    constraints: [],
    permissions: { pushBranch: false, createPr: false, merge: false },
    budget: {},
  });

  const refs = result.artifacts.map((a) => a.ref).sort();
  assert.deepStrictEqual(refs, ['definition:definition', 'proposal:proposal'], 'exactly one entry per logical ref, not one per version');
  const definitionRef = result.artifacts.find((a) => a.ref === 'definition:definition');
  assert.equal(definitionRef?.type, 'definition');
});

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

// ============================================================================
// Part 3 — FullBuildStepRunner: guarded by workflow identity
// ============================================================================

class SpyCriticAgent {
  calls = 0;
  async critique() { this.calls++; return { pass: true, blocking_issues: [], warnings: [], suggestions: [] }; }
}

class SpyConfirmService {
  gateCalls = 0;
  async gate() { this.gateCalls++; }
}

class SpyExecService {
  calls = 0;
  async run() { this.calls++; return { success: true, passed: true, next_node: 'VALIDATION_GATE' as const, duration_ms: 0 }; }
}

class SpyAgentStepRunner {
  calls: string[] = [];
  async run(step: WorkflowStep) {
    this.calls.push(step.id);
    return { success: true, artifacts_written: [], tokens_used: 0, duration_ms: 1 };
  }
}

class NoopRunArtifacts {
  async updateNodeStatus(): Promise<void> {}
  [key: string]: unknown;
}

// Minimal working RuntimeMapManager stub — executeCritique's pass path calls
// updateArtifactEntries(), which calls mapManager.update(fn).
class StubMapManager {
  private map: { artifacts: unknown[] } = { artifacts: [] };
  async read() { return this.map; }
  async update(fn: (m: { artifacts: unknown[] }) => { artifacts: unknown[] }) { this.map = fn(this.map); }
  async write(m: { artifacts: unknown[] }) { this.map = m; }
  [key: string]: unknown;
}

function makeGuardHarness() {
  const criticAgent = new SpyCriticAgent();
  const confirmService = new SpyConfirmService();
  const execService = new SpyExecService();
  const agentStepRunner = new SpyAgentStepRunner();
  const runArtifacts = new NoopRunArtifacts();

  const stepRunner = new FullBuildStepRunner(
    {
      agentStepRunner: agentStepRunner as any,
      mapManager: new StubMapManager() as any,
      runArtifacts: runArtifacts as any,
      projectRoot: '/nonexistent-d1b-guard-test',
      criticAgent: criticAgent as any,
      confirmService: confirmService as any,
      execService: execService as any,
      validationGateService: {} as any,
      snapshotService: {} as any,
      summariseService: {} as any,
      shardingService: {} as any,
      scopingService: {} as any,
    },
    {
      onCheckpoint: async () => 'approve',
      onConfirmGate: async () => 'halt',
      onShardingGate: async () => 'approve',
    },
  );

  return { stepRunner, criticAgent, confirmService, execService, agentStepRunner };
}

test('D.1b: full-build\'s reserved step ids still route through their special-cased handlers', async () => {
  const { stepRunner, criticAgent, agentStepRunner } = makeGuardHarness();
  const step: WorkflowStep = { id: 'critique', kind: 'review', agentRole: 'critic' };
  const ctx = ctxFor('critique', { workflowId: 'full-build', workflowRunId: 'fb-run' });

  await stepRunner.run(step, ctx);

  assert.equal(criticAgent.calls, 1, 'full-build critique must still call CriticAgent');
  assert.deepStrictEqual(agentStepRunner.calls, [], 'full-build critique must not fall through to the generic runner');
});

test('D.1b: the same step id on a non-full-build workflow does NOT trigger full-build-specific behavior', async () => {
  const { stepRunner, criticAgent, agentStepRunner } = makeGuardHarness();
  const step: WorkflowStep = { id: 'critique', kind: 'review', agentRole: 'explorer' };
  const ctx = ctxFor('critique', { workflowId: 'define-work', workflowRunId: 'dw-run' });

  await stepRunner.run(step, ctx);

  assert.equal(criticAgent.calls, 0, 'a step id colliding with full-build\'s reserved ids must not invoke CriticAgent on another workflow');
  assert.deepStrictEqual(agentStepRunner.calls, ['critique'], 'must fall through to the generic AgentStepRunner instead');
});

test('D.1b: handleExecute still runs full-build\'s ExecService for workflowId === "full-build"', async () => {
  const { stepRunner, execService } = makeGuardHarness();
  const step: WorkflowStep = { id: 'exec', kind: 'execute' };
  const ctx = ctxFor('exec', { workflowId: 'full-build', workflowRunId: 'fb-run-2' });

  const result = await stepRunner.handleExecute!(step, ctx);

  assert.equal(execService.calls, 1);
  assert.equal(result.outcome, 'completed');
});

test('D.1b: handleExecute fails closed for a non-full-build workflow instead of invoking full-build\'s ExecService', async () => {
  const { stepRunner, execService } = makeGuardHarness();
  const step: WorkflowStep = { id: 'run-tests', kind: 'execute' };
  const ctx = ctxFor('run-tests', { workflowId: 'define-work', workflowRunId: 'dw-run-2' });

  const result = await stepRunner.handleExecute!(step, ctx);

  assert.equal(execService.calls, 0, 'full-build\'s ExecService must not run against another workflow');
  assert.equal(result.outcome, 'failed');
});

test('D.1b: handleCheckpoint\'s "confirm" special case only fires for workflowId === "full-build"', async () => {
  const { stepRunner, confirmService } = makeGuardHarness();
  const step: WorkflowStep = { id: 'confirm', kind: 'checkpoint' };

  const fullBuildCtx = ctxFor('confirm', { workflowId: 'full-build', workflowRunId: 'fb-run-3' });
  await stepRunner.handleCheckpoint!(step, fullBuildCtx);
  assert.equal(confirmService.gateCalls, 1, 'full-build confirm must call ConfirmService.gate()');

  const otherCtx = ctxFor('confirm', { workflowId: 'define-work', workflowRunId: 'dw-run-3' });
  await stepRunner.handleCheckpoint!(step, otherCtx);
  assert.equal(confirmService.gateCalls, 1, 'a colliding step id on another workflow must use the generic checkpoint fallback, not ConfirmService');
});
