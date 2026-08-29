import { test } from 'node:test';
import { strict as assert } from 'assert';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import { promises as fs } from 'fs';
import { join } from 'path';
import { DAGRunner, buildCycleStateContext, nextNode } from '../src/dag-runner.js';
import { ContextManager } from '../src/context-manager.js';
import { DEFAULT_CONFIG } from '../src/context-manager.js';
import type { AgentRunner, AgentRunResult, DAGNodeId } from '../src/agent-runner.js';
import { buildUserMessage } from '../src/agent-runner.js';
import type { CycleStateContext } from '../src/context-manager.js';
import type { RuntimeMap, RuntimeMapManager } from '../src/runtime-map.js';
import type { RunArtifactManager, RunManifest } from '../src/run-artifacts.js';
import type { FailureReport } from '../src/types.js';
import { RunArtifactManager as RealRunArtifactManager } from '../src/run-artifacts.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'sle-plan-test-'));
}

function makeBaseMap(overrides: Partial<RuntimeMap['cycle']> = {}): RuntimeMap {
  return {
    meta: {
      status: 'cycling',
      cycle: 1,
      version_id: '123e4567-e89b-12d3-a456-426614174000',
      initialized_at: '2026-05-08T12:00:00Z',
      updated_at: '2026-05-08T12:00:00Z',
      dag: {
        current_node: 'PLAN',
        completed_nodes: ['SCOPING', 'DESIGN'],
        iteration: 1,
        revision: 0,
        started_at: '2026-05-08T14:00:00Z',
        nodes: { PLAN: { status: 'pending' } },
      },
    },
    project: { name: 'test', description: 'test', type: 'api' },
    remotes: {
      code: { type: 'git', url: 'https://github.com/org/repo.git', branch: 'main' },
      issues: { type: 'git', url: 'https://github.com/org/issues.git', branch: 'main' },
      docs: { url: 'https://github.com/org/docs.git', pending: false },
    },
    task_store: { type: 'local' },
    agents: {},
    discovery: {
      status: 'complete', mode: 'full', completed_at: '2026-05-08T13:00:00Z',
      artifacts: [], current_round: 0, total_rounds: 1,
      current_phase: 0, total_phases: 0,
      open_questions_count: 0, blocking_questions_count: 0,
    },
    cycle: {
      number: 1, iteration: 1, revision: 0, max_iterations: 5,
      planning_depth: 'standard', started_at: '2026-05-08T14:00:00Z',
      outcome: 'cycling', approval_gate: null,
      awaiting_scoping: false, awaiting_confirmation: false, awaiting_sharding_approval: false,
      intent: 'Build a widget system',
      ...overrides,
    } as RuntimeMap['cycle'],
    artifacts: [],
    chat: { session_open: false },
    validation: { categories: [], gate: { mode: 'all_must_pass', last_outcome: 'passed', failed_categories: [] } },
  } as RuntimeMap;
}

// ─── In-memory mocks ──────────────────────────────────────────────────────────

class InMemoryMapManager implements RuntimeMapManager {
  public map: RuntimeMap;
  constructor(initial?: RuntimeMap) { this.map = JSON.parse(JSON.stringify(initial ?? makeBaseMap())); }
  async read(): Promise<RuntimeMap> { return JSON.parse(JSON.stringify(this.map)); }
  async update(fn: (m: RuntimeMap) => RuntimeMap): Promise<void> {
    this.map = JSON.parse(JSON.stringify(fn(JSON.parse(JSON.stringify(this.map)))));
  }
  async write(m: RuntimeMap): Promise<void> { this.map = JSON.parse(JSON.stringify(m)); }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

class InMemoryRunArtifactManager implements RunArtifactManager {
  public nodeStatuses: Record<string, Record<string, unknown>> = {};
  async updateNodeStatus(_cn: number, _it: number, nodeId: string, update: Record<string, unknown>): Promise<void> {
    this.nodeStatuses[nodeId] = { ...(this.nodeStatuses[nodeId] ?? {}), ...update };
  }
  async writeNodeOutput() {}
  async createRunDir() { return ''; }
  async createManifest() {}
  async readManifest(): Promise<RunManifest> {
    return { cycle_id: 'test', cycle_number: 1, iteration: 1, planning_depth: 'standard', started_at: '', outcome: 'in_progress', nodes: [] };
  }
  async updateManifest() {}
  async finalizeManifest() {}
  async writeContextPack() {}
  async readContextPack() { return {}; }
  async dirExists() { return false; }
  async writeFailureReport() {}
  async readFailureReport() { return null; }
  runDir() { return ''; }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

class MockAgentRunner implements AgentRunner {
  public calls: Array<{ node: string; state: CycleStateContext }> = [];
  constructor(private result: AgentRunResult) {}
  async run(node: string, state: CycleStateContext): Promise<AgentRunResult> {
    this.calls.push({ node, state });
    return this.result;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

// ─── buildCycleStateContext tests ─────────────────────────────────────────────

test('testBuildCycleStateContextFromMap', async () => {
  const map = makeBaseMap();
  const ctx = buildCycleStateContext(map, 'PLAN');

  assert.strictEqual(ctx.cycle_number, 1);
  assert.strictEqual(ctx.iteration, 1);
  assert.strictEqual(ctx.planning_depth, 'standard');
  assert.strictEqual(ctx.intent, 'Build a widget system');
  assert.strictEqual(ctx.current_node, 'PLAN');
  assert.strictEqual(ctx.failure_report, undefined);
});

test('testBuildCycleStateContextWithFailureReport', async () => {
  const map = makeBaseMap({ iteration: 2 });
  const report: FailureReport = {
    cycle: 1,
    iteration: 1,
    run_dir: '.sle/runs/1-1',
    run_id: '1-1',
    quick_summary: 'Tests failed on correctness.',
    failed_categories: ['correctness'],
    passed_categories: ['style'],
  };
  const ctx = buildCycleStateContext(map, 'PLAN', report);

  assert.strictEqual(ctx.iteration, 2);
  assert.deepStrictEqual(ctx.failure_report, report);
});

test('testBuildCycleStateContextNullNode', async () => {
  const map = makeBaseMap();
  const ctx = buildCycleStateContext(map, null);
  assert.strictEqual(ctx.current_node, null);
});

// ─── writeFailureReport / readFailureReport tests ─────────────────────────────

test('testWriteAndReadFailureReport', async () => {
  const root = makeTempDir();
  const ram = new RealRunArtifactManager({ projectRoot: root });
  await ram.createRunDir(1, 1);

  const report: FailureReport = {
    cycle: 1,
    iteration: 1,
    run_dir: '.sle/runs/1-1',
    run_id: '1-1',
    quick_summary: 'Correctness checks failed.',
    failed_categories: [
      { name: 'correctness', method: 'executable' as const, error_summary: 'Correctness check failed' },
      { name: 'coverage', method: 'executable' as const, error_summary: 'Coverage check failed' },
    ],
    passed_categories: ['style'],
  };
  await ram.writeFailureReport(1, 1, report);

  const read = await ram.readFailureReport(1, 1);
  assert.deepStrictEqual(read, report);
});

test('testReadFailureReportMissingReturnsNull', async () => {
  const root = makeTempDir();
  const ram = new RealRunArtifactManager({ projectRoot: root });
  await ram.createRunDir(1, 1);

  const result = await ram.readFailureReport(1, 1);
  assert.strictEqual(result, null);
});

// ─── PLAN node via DAGRunner ───────────────────────────────────────────────────

test('testPlanNodeWritesPlanAndTestPlan', async () => {
  const planResult: AgentRunResult = {
    success: true,
    artifacts_written: ['docs/plan.md', 'docs/test-plan.md'],
    tokens_used: 300,
    duration_ms: 1200,
    raw_output_path: '.sle/runs/1-1/node-outputs/plan.md',
  };
  const runner = new MockAgentRunner(planResult);
  const mgr = new InMemoryMapManager();
  const ram = new InMemoryRunArtifactManager();
  const dagRunner = new DAGRunner(runner, mgr, ram);

  const cycleState: CycleStateContext = {
    cycle_number: 1, iteration: 1, planning_depth: 'standard',
    intent: 'Build a widget system', current_node: 'PLAN',
  };
  const result = await dagRunner.runNode('PLAN', cycleState);

  assert.strictEqual(result.success, true, `Expected success: ${result.error}`);
  assert.strictEqual(result.node, 'PLAN');
  assert.strictEqual(result.next_node, 'TEST');
  assert.deepStrictEqual(result.artifacts_written, ['docs/plan.md', 'docs/test-plan.md']);
  assert.strictEqual(result.tokens_used, 300);
});

test('testPlanNodeAdvancesDagToTest', async () => {
  const runner = new MockAgentRunner({
    success: true, artifacts_written: ['docs/plan.md', 'docs/test-plan.md'],
    tokens_used: 100, duration_ms: 500, raw_output_path: '',
  });
  const mgr = new InMemoryMapManager();
  const ram = new InMemoryRunArtifactManager();
  const dagRunner = new DAGRunner(runner, mgr, ram);

  await dagRunner.runNode('PLAN', {
    cycle_number: 1, iteration: 1, planning_depth: 'standard',
    intent: 'Build widgets', current_node: 'PLAN',
  });

  const map = await mgr.read();
  assert.strictEqual(map.meta.dag?.current_node, 'TEST');
  assert.ok(map.meta.dag?.completed_nodes.includes('PLAN'));
});

test('testPlanNodeUpdatesArtifactEntries', async () => {
  const runner = new MockAgentRunner({
    success: true, artifacts_written: ['docs/plan.md', 'docs/test-plan.md'],
    tokens_used: 100, duration_ms: 500, raw_output_path: '',
  });
  const mgr = new InMemoryMapManager();
  const ram = new InMemoryRunArtifactManager();
  const dagRunner = new DAGRunner(runner, mgr, ram);

  await dagRunner.runNode('PLAN', {
    cycle_number: 1, iteration: 1, planning_depth: 'standard',
    intent: 'Build widgets', current_node: 'PLAN',
  });

  const map = await mgr.read();
  const planEntry = map.artifacts.find((a) => a.path === 'docs/plan.md');
  const testPlanEntry = map.artifacts.find((a) => a.path === 'docs/test-plan.md');
  assert.ok(planEntry, 'docs/plan.md entry missing');
  assert.strictEqual(planEntry!.generator, 'planner');
  assert.ok(testPlanEntry, 'docs/test-plan.md entry missing');
  assert.strictEqual(testPlanEntry!.generator, 'planner');
});

test('testNextNodePlanToTest', async () => {
  assert.strictEqual(nextNode('PLAN'), 'TEST');
});

// ─── Failure context injection ────────────────────────────────────────────────

test('testFailureContextPassedToAgentRunner', async () => {
  const report: FailureReport = {
    cycle: 1, iteration: 1,
    run_dir: '.sle/runs/1-1', run_id: '1-1',
    quick_summary: 'Tests failed.',
    failed_categories: [{ name: 'correctness', method: 'executable' as const, error_summary: 'Correctness check failed' }],
    passed_categories: ['style'],
  };

  const runner = new MockAgentRunner({
    success: true, artifacts_written: ['docs/plan.md', 'docs/test-plan.md'],
    tokens_used: 200, duration_ms: 600, raw_output_path: '',
  });
  const mgr = new InMemoryMapManager();
  const ram = new InMemoryRunArtifactManager();
  const dagRunner = new DAGRunner(runner, mgr, ram);

  const cycleState: CycleStateContext = {
    cycle_number: 1, iteration: 2, planning_depth: 'standard',
    intent: 'Build widgets', current_node: 'PLAN',
    failure_report: report,
  };
  await dagRunner.runNode('PLAN', cycleState);

  assert.strictEqual(runner.calls.length, 1);
  assert.strictEqual(runner.calls[0].state.iteration, 2);
  assert.deepStrictEqual(runner.calls[0].state.failure_report, report);
});

test('testFailureContextInContextAssembly', async () => {
  // Verify the ContextManager includes failure_context for iteration > 1 with a report
  const root = makeTempDir();
  await fs.mkdir(join(root, 'docs'), { recursive: true });
  await fs.writeFile(join(root, 'docs/requirements.md'), '# Req\nContent.', 'utf-8');

  const fsMock = {
    readFile: async (p: unknown) => {
      const key = p as string;
      try { return await fs.readFile(key, 'utf-8'); } catch { return null as unknown as string; }
    },
  } as unknown as typeof import('fs').promises;

  const cm = new ContextManager(root, DEFAULT_CONFIG, fsMock);
  const report: FailureReport = {
    cycle: 1, iteration: 1, run_dir: '.sle/runs/1-1', run_id: '1-1',
    quick_summary: 'Correctness failed.', failed_categories: ['correctness'], passed_categories: ['style'],
  };

  const ctx = await cm.assemble('planner', {
    cycle_number: 1, iteration: 2, planning_depth: 'standard',
    intent: 'Build widgets', current_node: 'PLAN',
    failure_report: report,
  });

  assert.ok(ctx.failure_context !== undefined, 'failure_context should be set on iteration 2');
  assert.ok(ctx.failure_context!.includes('correctness'), 'failed category not in failure_context');
  assert.ok(ctx.failure_context!.includes('Correctness failed.'), 'summary not in failure_context');
});

test('testNoFailureContextOnIteration1', async () => {
  const root = makeTempDir();
  const fsMock = { readFile: async () => { throw new Error('ENOENT'); } } as unknown as typeof import('fs').promises;
  const cm = new ContextManager(root, DEFAULT_CONFIG, fsMock);

  const ctx = await cm.assemble('planner', {
    cycle_number: 1, iteration: 1, planning_depth: 'standard',
    intent: 'Build widgets', current_node: 'PLAN',
    failure_report: {
      cycle: 1, iteration: 0, run_dir: '', run_id: '',
      quick_summary: 'X', failed_categories: ['a'], passed_categories: [],
    },
  });

  // iteration=1, so failure_context should NOT be injected even with report
  assert.strictEqual(ctx.failure_context, undefined);
});

// ─── Planner artifact isolation ───────────────────────────────────────────────

test('testPlannerContextExcludesImplementationFiles', async () => {
  const root = makeTempDir();
  await fs.mkdir(join(root, '.sle', 'project-docs'), { recursive: true });
  await fs.mkdir(join(root, 'src'), { recursive: true });

  // Write all candidate artifact files in the current layout (.sle/project-docs/)
  await fs.writeFile(join(root, '.sle', 'project-docs', 'requirements.md'), '# Req', 'utf-8');
  await fs.writeFile(join(root, '.sle', 'project-docs', 'architecture.md'), '# Arch', 'utf-8');
  await fs.writeFile(join(root, '.sle', 'project-docs', 'cycle-charter.md'), '# Charter', 'utf-8');
  await fs.writeFile(join(root, 'src', 'index.ts'), 'export default {};', 'utf-8');

  const cm = new ContextManager(root, DEFAULT_CONFIG);
  const ctx = await cm.assemble('planner', {
    cycle_number: 1, iteration: 1, planning_depth: 'standard',
    intent: 'Build widgets', current_node: 'PLAN',
  });

  // Planner reads: requirements, architecture, cycle-charter
  assert.ok('requirements' in ctx.artifact_slices, 'requirements should be in planner context');
  assert.ok('architecture' in ctx.artifact_slices, 'architecture should be in planner context');
  assert.ok('cycle-charter' in ctx.artifact_slices, 'cycle-charter should be in planner context');

  // Planner does NOT read src/ implementation files
  assert.ok(!Object.values(ctx.artifact_slices).some(v => v.includes('export default')),
    'src/ files should not appear in planner context');
});

test('testFailureContextInUserMessage', async () => {
  // buildUserMessage includes failure_context when present
  const { AssembledContext } = await import('../src/types.js' as unknown as string) as never;
  void AssembledContext; // unused — just testing buildUserMessage directly

  const ctx = {
    system_prompt: 'You are a planner.',
    artifact_slices: { requirements: '# Req' },
    state_summary: '## State\n- Cycle: 1',
    task: 'Create a plan.',
    failure_context: '## Previous Failure\nCorrectness failed.',
    token_count: 100,
    truncated: [],
  };

  const msg = buildUserMessage(ctx);
  assert.ok(msg.includes('Previous Failure'), 'failure_context missing from user message');
  assert.ok(msg.includes('Correctness failed.'), 'failure summary missing from user message');
});

