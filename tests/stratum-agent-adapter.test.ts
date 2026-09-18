/**
 * Integration tests for StratumAgentAdapter — proves workflowParameters.planning_depth,
 * max_iterations, and on_cap_hit flow from ExecutionRequest through the adapter into
 * WorkflowEngine.run().
 *
 * These tests use real StratumAgentAdapter + FullBuildStepRunner + WorkflowEngine with
 * spy services, not a mock engine. This verifies the actual control-plane wiring.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { StratumAgentAdapter } from '../src/execution/stratum-agent-adapter.js';
import { FullBuildStepRunner } from '../src/execution/full-build-step-runner.js';
import { AgentStepRunner } from '../src/execution/agent-step-runner.js';
import { WorkflowEngine } from '../src/workflow/engine.js';
import type { WorkflowEngineDeps, WorkflowEngineOptions } from '../src/workflow/engine.js';
import type { FullBuildCallbacks } from '../src/execution/full-build-step-runner.js';
import type { ExecutionRequest } from '../src/execution/types.js';
import type { RuntimeMap, RuntimeMapManager } from '../src/runtime-map.js';
import type { AgentRunResult } from '../src/agent-runner.js';
import type { StepRunContext } from '../src/workflow/types.js';
import type { FailureReport, PlanningDepth } from '../src/types.js';
import { resolveWorkflowInvocation } from '../src/execution/workflow-invocation.js';

// ============================================================================
// Spies
// ============================================================================

class SpyRunArtifacts {
  private reports = new Map<string, FailureReport>();
  async updateNodeStatus(): Promise<void> {}
  async createRunDir(): Promise<void> {}
  async createManifest(): Promise<void> {}
  async readManifest() {
    return { cycle_id: 'r', cycle_number: 1, iteration: 1, planning_depth: 'minimal' as const, started_at: '', outcome: 'in_progress' as const, nodes: [] };
  }
  async writeFailureReport(cn: number, iter: number, r: FailureReport): Promise<void> {
    this.reports.set(`${cn}-${iter}`, r);
  }
  async readFailureReport(cn: number, iter: number): Promise<FailureReport | null> {
    return this.reports.get(`${cn}-${iter}`) ?? null;
  }
  [key: string]: unknown;
}

class SpyAgentRunner {
  public calls: string[] = [];
  public lastCtx: StepRunContext | undefined;
  async run(role: string, ctx: StepRunContext): Promise<AgentRunResult> {
    this.calls.push(role);
    this.lastCtx = ctx;
    return { success: true, next_node: null as any, artifacts_written: [], tokens_used: 0, duration_ms: 1, raw_output_path: '' };
  }
  [key: string]: unknown;
}

class SpyValidationGateService {
  private readonly failTimes: number;
  private calls = 0;
  private readonly runArtifacts: SpyRunArtifacts;
  constructor(failTimes: number, runArtifacts: SpyRunArtifacts) {
    this.failTimes = failTimes;
    this.runArtifacts = runArtifacts;
  }
  async run(cn: number, iter: number, _id: string) {
    this.calls++;
    if (this.calls > this.failTimes) return { passed: true, next_node: 'EVALUATE', failed_nodes: [] };
    const report: FailureReport = {
      cycle: 1, iteration: iter, run_dir: '.sle/runs/1-1', run_id: 'r1',
      quick_summary: 'Build failed', failed_categories: [], passed_categories: [],
    };
    await this.runArtifacts.writeFailureReport(cn, iter, report);
    return { passed: false, next_node: null, failed_nodes: ['BUILD'], failure_report: report };
  }
  [key: string]: unknown;
}

function baseMap(depth: PlanningDepth = 'minimal'): RuntimeMap {
  return {
    meta: { status: 'cycling', cycle: 1, version_id: 'v1', initialized_at: '', updated_at: '',
      dag: { current_node: null, completed_nodes: [], iteration: 1, revision: 0, started_at: '', nodes: {} } },
    project: { name: 'test', description: 'test', type: 'api' },
    remotes: { code: { type: 'git', url: 'https://github.com/o/r.git', branch: 'main' }, issues: { type: 'git', url: 'https://github.com/o/r.git', branch: 'main' }, docs: { url: 'https://github.com/o/d.git', pending: false } },
    task_store: { type: 'local' }, agents: {},
    discovery: { status: 'complete', mode: 'full', completed_at: '', artifacts: [], current_round: 0, total_rounds: 1, current_phase: 0, total_phases: 0, open_questions_count: 0, blocking_questions_count: 0 },
    cycle: { number: 1, iteration: 1, revision: 0, max_iterations: 10, planning_depth: depth, started_at: '', outcome: 'cycling', approval_gate: null, awaiting_scoping: false, awaiting_confirmation: false, awaiting_sharding_approval: false },
    artifacts: [],
  } as unknown as RuntimeMap;
}

class InMemMapManager implements RuntimeMapManager {
  public map: RuntimeMap;
  constructor(depth: PlanningDepth = 'minimal') { this.map = baseMap(depth); }
  async read() { return JSON.parse(JSON.stringify(this.map)); }
  async update(fn: (m: RuntimeMap) => RuntimeMap) { this.map = fn(JSON.parse(JSON.stringify(this.map))); }
  async write(m: RuntimeMap) { this.map = JSON.parse(JSON.stringify(m)); }
  [key: string]: unknown;
}

// ============================================================================
// Harness builder
// ============================================================================

interface AdapterHarnessOpts {
  depth?: PlanningDepth;
  vgsFailTimes?: number;
  confirmAction?: 'approve' | 'revise' | 'halt';
  onCapHit?: WorkflowEngineOptions['onCapHit'];
}

// Spy that records whether critique() was invoked.
class SpyCriticAgent {
  public critiqueCalled = false;
  async critique(_req: unknown) {
    this.critiqueCalled = true;
    return { pass: true, blocking_issues: [], warnings: [], suggestions: [] };
  }
}

function makeAdapter(opts: AdapterHarnessOpts = {}): {
  adapter: StratumAgentAdapter;
  agentSpy: SpyAgentRunner;
  criticSpy: SpyCriticAgent;
  runArtifacts: SpyRunArtifacts;
  cleanup: () => void;
} {
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'adapter-test-'));
  const cleanup = () => { try { rmSync(projectRoot, { recursive: true, force: true }); } catch {} };

  const agentSpy = new SpyAgentRunner();
  const criticSpy = new SpyCriticAgent();
  const agentStepRunner = new AgentStepRunner(agentSpy as any);
  const runArtifacts = new SpyRunArtifacts();
  const mapManager = new InMemMapManager(opts.depth ?? 'minimal');

  const callbacks: FullBuildCallbacks = {
    onCheckpoint: async () => 'approve',
    onConfirmGate: async () => (opts.confirmAction ?? 'approve') as 'approve' | 'revise' | 'halt',
    onShardingGate: async () => 'approve',
  };

  const scopingService = {
    begin: async (ctx: StepRunContext) => {
      await agentSpy.run('facilitator', ctx);
      return { draft: '', charter_path: 'docs/cycle-charter.md', awaiting_scoping: true as const };
    },
    approve: async (_cycleNumber: number, _iteration: number) => {},
  };

  const stepRunner = new FullBuildStepRunner({
    agentStepRunner,
    mapManager,
    runArtifacts: runArtifacts as any,
    projectRoot,
    criticAgent: criticSpy as any,
    confirmService: { gate: async () => {}, approve: async () => ({ next_node: 'BUILD' }), revise: async () => ({ next_node: 'TEST', revision_count: 1 }) } as any,
    execService: { run: async () => ({ success: true, passed: true, next_node: 'VALIDATION_GATE' as const, duration_ms: 0 }) } as any,
    validationGateService: new SpyValidationGateService(opts.vgsFailTimes ?? 0, runArtifacts) as any,
    snapshotService: { run: async () => {} } as any,
    summariseService: { run: async () => ({ success: true, summary_path: 'docs/cycle-summary.md' }) } as any,
    shardingService: undefined,
    scopingService: scopingService as any,
  }, callbacks);

  const engineDeps: WorkflowEngineDeps = {
    stepRunner,
    mapManager,
    runArtifacts: runArtifacts as any,
    projectRoot,
  };

  const engineOpts: WorkflowEngineOptions = {
    onCheckpoint: async () => 'approve',
    onCapHit: opts.onCapHit,
  };

  return { adapter: new StratumAgentAdapter(engineDeps, engineOpts), agentSpy, criticSpy, runArtifacts, cleanup };
}

function makeRequest(
  workflowParameters?: Record<string, unknown>,
  overrides: Partial<ExecutionRequest> = {},
): ExecutionRequest {
  return {
    stepExecutionId: 'se-1',
    workItemId: 'wi-1',
    workflowRunId: `run-${Math.random().toString(36).slice(2)}`,
    stepId: '__start__',
    workflowId: 'full-build',
    repositories: [],
    goal: 'Adapter integration test',
    acceptanceCriteria: [],
    constraints: [],
    permissions: { pushBranch: false, createPr: false, merge: false },
    budget: {},
    workflowParameters,
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

test('adapterDeepDepthReachesCritique', async () => {
  const { adapter, criticSpy, cleanup } = makeAdapter({ depth: 'deep' });
  try {
    const result = await adapter.execute(makeRequest({ planning_depth: 'deep' }));
    assert.equal(result.outcome, 'succeeded', `expected succeeded, got: ${result.failure?.message}`);
    assert.ok(criticSpy.critiqueCalled,
      `deep depth must invoke criticAgent.critique()`);
  } finally { cleanup(); }
});

test('adapterMinimalDepthSkipsCritique', async () => {
  const { adapter, criticSpy, cleanup } = makeAdapter();
  try {
    const result = await adapter.execute(makeRequest({ planning_depth: 'minimal' }));
    assert.equal(result.outcome, 'succeeded', `expected succeeded, got: ${result.failure?.message}`);
    assert.ok(!criticSpy.critiqueCalled,
      `minimal depth must skip criticAgent.critique()`);
  } finally { cleanup(); }
});

test('adapterMaxIterationsHaltsAtCap', async () => {
  // VGS always fails → iteration cap kicks in
  const { adapter, cleanup } = makeAdapter({ vgsFailTimes: 99 });
  try {
    const result = await adapter.execute(makeRequest({
      planning_depth: 'minimal',
      max_iterations: 2,
    }));
    assert.equal(result.outcome, 'failed',
      `expected failed at cap; got: ${result.outcome} (${result.failure?.message})`);
    assert.ok(result.failure?.message?.includes('2'),
      `failure message should mention cap of 2: ${result.failure?.message}`);
  } finally { cleanup(); }
});

test('adapterForcePassRoutesToEvaluate', async () => {
  // VGS always fails on first try; force_pass on cap routes to evaluate
  const { adapter, agentSpy, cleanup } = makeAdapter({ vgsFailTimes: 99 });
  try {
    const result = await adapter.execute(makeRequest({
      planning_depth: 'minimal',
      max_iterations: 1,
      on_cap_hit: 'force_pass',
    }));
    assert.equal(result.outcome, 'succeeded',
      `force_pass must succeed; got: ${result.outcome} (${result.failure?.message})`);
    assert.ok(agentSpy.calls.includes('evaluator'),
      `force_pass must route to evaluator; calls: ${agentSpy.calls.join(', ')}`);
  } finally { cleanup(); }
});

// ============================================================================
// resolveWorkflowInvocation seam — non-full-build workflows bypass FullBuildParams
// ============================================================================

test('resolveWorkflowInvocationFullBuildFillsDefaults', () => {
  // full-build: raw params with no max_iterations → defaults filled
  const invocation = resolveWorkflowInvocation('full-build', { planning_depth: 'minimal' });
  assert.equal(invocation.maxIterations, 10, 'full-build must get default max_iterations=10');
  assert.equal((invocation.normalizedParams as any).max_iterations, 10);
  assert.equal((invocation.normalizedParams as any).on_cap_hit, 'halt');
});

test('resolveWorkflowInvocationNonFullBuildPassesRawParams', () => {
  const raw = { some_param: 'value', other: 42 };
  const invocation = resolveWorkflowInvocation('draft-artifact', raw);
  // maxIterations is undefined — no cap imposed
  assert.equal(invocation.maxIterations, undefined, 'non-full-build must not impose max_iterations');
  // params pass through verbatim — no FullBuildParams defaults injected
  assert.deepEqual(invocation.normalizedParams, raw,
    'non-full-build params must not be normalized through FullBuildParams');
  // specifically: full-build defaults must NOT appear
  assert.equal((invocation.normalizedParams as any).planning_depth, undefined,
    'planning_depth default must not be injected for non-full-build workflows');
});

test('resolveWorkflowInvocationNonFullBuildDoesNotThrowOnMissingFullBuildFields', () => {
  // validateFullBuildParams would throw for invalid planning_depth — non-full-build must not
  assert.doesNotThrow(() => {
    resolveWorkflowInvocation('draft-artifact', { planning_depth: 'not-a-valid-depth' });
  }, 'non-full-build must not validate through FullBuildParams schema');
});

// ============================================================================
// D.3b1.2 — ExecutionRequest.objectiveContext -> StepRunContext.objectiveContext
// ============================================================================

test('D.3b1.2: StratumAgentAdapter forwards ExecutionRequest.objectiveContext onto StepRunContext.objectiveContext', async () => {
  const { adapter, agentSpy, cleanup } = makeAdapter();
  try {
    const objectiveContext = {
      id: 'obj-adapter-forwarding',
      title: 'Add real-time multiplayer to Evershift',
      description: 'Players can join and play a shared session together in real time.',
      constraints: [{ description: 'Must stay same-platform', type: 'must' as const }],
      successCriteria: [{ description: 'Two players can join a session' }],
    };

    const result = await adapter.execute(makeRequest(
      { planning_depth: 'minimal' },
      { objectiveContext },
    ));

    assert.equal(result.outcome, 'succeeded', `expected succeeded, got: ${result.failure?.message}`);
    assert.deepStrictEqual(agentSpy.lastCtx?.objectiveContext, objectiveContext,
      'the adapter must forward ExecutionRequest.objectiveContext through WorkflowEngine onto StepRunContext.objectiveContext');
  } finally { cleanup(); }
});
