/**
 * Full-build contract test suite (WorkflowEngine-only).
 *
 * This suite preserves behavioral knowledge independently of CycleRunner.
 * It tests the WorkflowEngine + FullBuildStepRunner implementation directly,
 * covering all behavioral contracts that were previously validated by the
 * parity harness but expressed without any oracle dependency.
 *
 * After CycleRunner is removed, this suite is the permanent record of
 * what the full-build workflow is contractually required to do.
 *
 * Contracts verified:
 *   - Happy path (minimal): completes, calls all expected services once
 *   - decisions.md: SNAPSHOT writes goal, depth, iteration, status
 *   - Critique skip (minimal/standard), run (deep/research), retry cap (deep=1, research=3)
 *   - SCOPING: scopingService.begin() called; agentSpy sees 'SCOPING'
 *   - SCOPING halt: engine halts at scoping.checkpoint
 *   - CONFIRM approve: routes to BUILD, completes
 *   - CONFIRM revise: loops to TEST, increments revision, re-presents CONFIRM
 *   - CONFIRM halt: engine halts at confirm
 *   - Validation pass: EVALUATE and SNAPSHOT run
 *   - Validation fail → DEBUG → failure_report.failure_report loaded → PLAN
 *   - Structural failure → DEBUG → failure_report.structural → DESIGN
 *   - Iteration cap (halt): engine halts with error message, same iterations_used
 *   - Iteration cap (force_pass): engine routes to evaluate, completes
 *   - Sharding no-proposal: skipped, pipeline continues
 *   - Sharding approve: createTasksFromProposal called, pipeline continues
 *   - Sharding reject: proposal file deleted, pipeline continues
 *   - Sharding modify: checkpoint loops until approve
 *
 * NOTE: _critiqueRetries is process-local (resets on restart).
 * This is execution-recovery debt — tracked but not fixed here.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { WorkflowEngine } from '../src/workflow/engine.js';
import { FullBuildStepRunner } from '../src/execution/full-build-step-runner.js';
import { AgentStepRunner } from '../src/execution/agent-step-runner.js';
import type { RuntimeMap, RuntimeMapManager } from '../src/runtime-map.js';
import type { CycleStateContext } from '../src/context-manager.js';
import type { AgentRunResult } from '../src/agent-runner.js';
import type { WorkflowEngineDeps, WorkflowEngineOptions } from '../src/workflow/engine.js';
import type { FailureReport, PlanningDepth } from '../src/types.js';

// ============================================================================
// Test spies — all in-memory, no filesystem except when testing file effects
// ============================================================================

class SpyRunArtifacts {
  private reports = new Map<string, FailureReport>();
  async updateNodeStatus(): Promise<void> {}
  async createRunDir(): Promise<void> {}
  async createManifest(): Promise<void> {}
  async readManifest() {
    return {
      cycle_id: 'test-run', cycle_number: 1, iteration: 1,
      planning_depth: 'standard', started_at: '', outcome: 'in_progress' as const, nodes: [],
    };
  }
  async writeFailureReport(cycleNumber: number, iteration: number, report: FailureReport): Promise<void> {
    this.reports.set(`${cycleNumber}-${iteration}`, report);
  }
  async readFailureReport(cycleNumber: number, iteration: number): Promise<FailureReport | null> {
    return this.reports.get(`${cycleNumber}-${iteration}`) ?? null;
  }
  [key: string]: unknown;
}

class SpyAgentRunner {
  public calls: string[] = [];
  public capturedStates: Map<string, CycleStateContext[]> = new Map();
  async run(nodeId: string, state: CycleStateContext): Promise<AgentRunResult> {
    this.calls.push(nodeId);
    const existing = this.capturedStates.get(nodeId) ?? [];
    existing.push({ ...state });
    this.capturedStates.set(nodeId, existing);
    return {
      success: true,
      next_node: null,
      artifacts_written: [],
      tokens_used: 0,
      duration_ms: 1,
      raw_output_path: '',
    };
  }
  [key: string]: unknown;
}

class SpyCriticAgent {
  public calls = 0;
  private readonly failTimes: number;
  constructor(failTimes = 0) { this.failTimes = failTimes; }
  async critique(_args: unknown) {
    this.calls++;
    const pass = this.calls > this.failTimes;
    return { pass, blocking_issues: pass ? [] : ['blocking'], warnings: [], suggestions: [] };
  }
  [key: string]: unknown;
}

class SpyConfirmService {
  public gateCalls = 0;
  public approveCalls = 0;
  public reviseCalls = 0;
  public approveNext = 'BUILD';
  async gate(): Promise<void> { this.gateCalls++; }
  async approve() { this.approveCalls++; return { approved: true, next_node: this.approveNext }; }
  async revise() { this.reviseCalls++; return { revision_count: this.reviseCalls, next_node: 'TEST' }; }
  [key: string]: unknown;
}

class SpyExecService {
  public calls = 0;
  async run() { this.calls++; return { success: true, passed: true, next_node: 'VALIDATION_GATE' as const, duration_ms: 0 }; }
  [key: string]: unknown;
}

class SpyValidationGateService {
  public calls = 0;
  private readonly failTimes: number;
  private readonly runArtifacts?: SpyRunArtifacts;
  constructor(failTimes = 0, runArtifacts?: SpyRunArtifacts) {
    this.failTimes = failTimes;
    this.runArtifacts = runArtifacts;
  }
  async run(cycleNumber: number, iteration: number, _id: string) {
    this.calls++;
    if (this.calls > this.failTimes) return { passed: true, next_node: 'EVALUATE', failed_nodes: [] };
    const report: FailureReport = {
      cycle: 1, iteration, run_dir: '.sle/runs/1-1', run_id: 'c1',
      quick_summary: 'BUILD failed',
      failed_categories: [{ name: 'BUILD', method: 'executable', error_summary: 'Node BUILD failed' }],
      passed_categories: [],
    };
    await this.runArtifacts?.writeFailureReport(cycleNumber, iteration, report);
    return { passed: false, next_node: null, failed_nodes: ['BUILD'], failure_report: report };
  }
  [key: string]: unknown;
}

class SpyStructuralValidationGateService {
  public calls = 0;
  private readonly failTimes: number;
  private readonly runArtifacts?: SpyRunArtifacts;
  constructor(failTimes = 1, runArtifacts?: SpyRunArtifacts) {
    this.failTimes = failTimes;
    this.runArtifacts = runArtifacts;
  }
  async run(cycleNumber: number, iteration: number, _id: string) {
    this.calls++;
    if (this.calls > this.failTimes) return { passed: true, next_node: 'EVALUATE', failed_nodes: [] };
    const report: FailureReport = {
      cycle: 1, iteration, run_dir: '.sle/runs/1-1', run_id: 'c1',
      quick_summary: 'Structural failure',
      failed_categories: [{ name: 'DESIGN', method: 'executable' as const, error_summary: 'Arch violation', structural: true }],
      passed_categories: [],
    };
    await this.runArtifacts?.writeFailureReport(cycleNumber, iteration, report);
    return { passed: false, next_node: null, failed_nodes: ['DESIGN'], failure_report: report };
  }
  [key: string]: unknown;
}

class SpySnapshotService {
  public calls = 0;
  async run() { this.calls++; return { success: true, snapshot_dir: '/tmp', snapshot_id: 'snap', artifacts_copied: [] }; }
  [key: string]: unknown;
}

class SpySummariseService {
  public calls = 0;
  async run() { this.calls++; return { success: true, summary_path: 'docs/cycle-summary.md' }; }
  [key: string]: unknown;
}

class SpyShardingService {
  public createCalls = 0;
  public lastProposal: unknown;
  async createTasksFromProposal(p: unknown) { this.createCalls++; this.lastProposal = p; }
  [key: string]: unknown;
}

function baseMap(depth: PlanningDepth = 'minimal'): RuntimeMap {
  return {
    meta: {
      status: 'cycling', cycle: 1,
      version_id: 'v1', initialized_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      dag: { current_node: null, completed_nodes: [], iteration: 1, revision: 0, started_at: '2026-01-01T00:00:00Z', nodes: {} },
    },
    project: { name: 'test', description: 'test', type: 'api' },
    remotes: {
      code: { type: 'git', url: 'https://github.com/org/repo.git', branch: 'main' },
      issues: { type: 'git', url: 'https://github.com/org/issues.git', branch: 'main' },
      docs: { url: 'https://github.com/org/docs.git', pending: false },
    },
    task_store: { type: 'local' }, agents: {},
    discovery: {
      status: 'complete', mode: 'full', completed_at: '2026-01-01T00:00:00Z',
      artifacts: [], current_round: 0, total_rounds: 1,
      current_phase: 0, total_phases: 0, open_questions_count: 0, blocking_questions_count: 0,
    },
    cycle: {
      number: 1, iteration: 1, revision: 0, max_iterations: 5,
      planning_depth: depth, started_at: '2026-01-01T00:00:00Z',
      outcome: 'cycling', approval_gate: null,
      awaiting_scoping: false, awaiting_confirmation: false, awaiting_sharding_approval: false,
    },
    artifacts: [],
  } as unknown as RuntimeMap;
}

class InMemoryMapManager implements RuntimeMapManager {
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

interface HarnessOpts {
  depth?: PlanningDepth;
  projectRoot?: string;
  agentRunner?: SpyAgentRunner;
  criticAgent?: SpyCriticAgent;
  confirmService?: SpyConfirmService;
  execService?: SpyExecService;
  validationGateService?: SpyValidationGateService | SpyStructuralValidationGateService;
  snapshotService?: SpySnapshotService;
  summariseService?: SpySummariseService;
  shardingService?: SpyShardingService;
  runArtifacts?: SpyRunArtifacts;
  confirmAction?: 'approve' | 'revise' | 'halt';
  scopingAction?: 'approve' | 'halt';
  shardingAction?: 'approve' | 'reject' | 'modify';
  onCapHit?: WorkflowEngineOptions['onCapHit'];
  onConfirmGateFn?: () => Promise<'approve' | 'revise' | 'halt'>;
  onShardingGateFn?: (cycle: number, iter: number) => Promise<'approve' | 'reject' | 'modify'>;
}

interface Harness {
  engine: WorkflowEngine;
  stepRunner: FullBuildStepRunner;
  agentSpy: SpyAgentRunner;
  criticAgent: SpyCriticAgent;
  confirmService: SpyConfirmService;
  execService: SpyExecService;
  validationGateService: SpyValidationGateService | SpyStructuralValidationGateService;
  snapshotService: SpySnapshotService;
  summariseService: SpySummariseService;
  shardingService: SpyShardingService;
  runArtifacts: SpyRunArtifacts;
  mapManager: InMemoryMapManager;
  projectRoot: string;
  cleanup: () => void;
}

function makeHarness(opts: HarnessOpts = {}): Harness {
  const projectRoot = opts.projectRoot ?? mkdtempSync(path.join(tmpdir(), 'contract-'));
  const cleanup = opts.projectRoot
    ? () => {}
    : () => { try { rmSync(projectRoot, { recursive: true, force: true }); } catch {} };

  const depth = opts.depth ?? 'minimal';
  const agentSpy = opts.agentRunner ?? new SpyAgentRunner();
  const agentStepRunner = new AgentStepRunner(agentSpy as any);
  const runArtifacts = opts.runArtifacts ?? new SpyRunArtifacts();
  const criticAgent = opts.criticAgent ?? new SpyCriticAgent(0);
  const confirmService = opts.confirmService ?? new SpyConfirmService();
  const execService = opts.execService ?? new SpyExecService();
  const validationGateService = opts.validationGateService ?? new SpyValidationGateService(0, runArtifacts);
  const snapshotService = opts.snapshotService ?? new SpySnapshotService();
  const summariseService = opts.summariseService ?? new SpySummariseService();
  const shardingService = opts.shardingService ?? new SpyShardingService();
  const mapManager = new InMemoryMapManager(depth);

  const confirmAction = opts.confirmAction ?? 'approve';
  const onConfirmGateFn = opts.onConfirmGateFn ?? (async () => confirmAction as 'approve' | 'revise' | 'halt');
  const scopingAction = opts.scopingAction ?? 'approve';
  const onShardingGateFn = opts.onShardingGateFn ?? (async () => (opts.shardingAction ?? 'approve') as 'approve' | 'reject' | 'modify');

  const scopingService = {
    begin: async (_c: number, _i: number, state: CycleStateContext) => {
      await agentSpy.run('SCOPING', state);
      return { draft: '', charter_path: 'docs/cycle-charter.md', awaiting_scoping: true as const };
    },
  };

  const stepRunner = new FullBuildStepRunner(
    {
      agentStepRunner,
      mapManager,
      runArtifacts: runArtifacts as any,
      projectRoot,
      criticAgent: criticAgent as any,
      confirmService: confirmService as any,
      execService: execService as any,
      validationGateService: validationGateService as any,
      snapshotService: snapshotService as any,
      summariseService: summariseService as any,
      shardingService: shardingService as any,
      scopingService: scopingService as any,
    },
    {
      onCheckpoint: async (_runId, stepId) => {
        if (stepId === 'scoping.checkpoint') return scopingAction === 'halt' ? 'halt' : 'approve';
        return 'approve';
      },
      onConfirmGate: onConfirmGateFn,
      onShardingGate: onShardingGateFn,
    },
  );

  const engine = new WorkflowEngine(
    { stepRunner, mapManager, runArtifacts: runArtifacts as any, projectRoot },
    {
      onCheckpoint: async (_runId, stepId) => {
        if (stepId === 'scoping.checkpoint') return scopingAction === 'halt' ? 'halt' : 'approve';
        return 'approve';
      },
      onCapHit: opts.onCapHit,
    },
  );

  return { engine, stepRunner, agentSpy, criticAgent, confirmService, execService, validationGateService, snapshotService, summariseService, shardingService, runArtifacts, mapManager, projectRoot, cleanup };
}

function ctx(depth: PlanningDepth = 'minimal'): CycleStateContext {
  return { cycle_number: 1, iteration: 1, planning_depth: depth, intent: 'contract test', current_node: null };
}

async function run(h: Harness, depth: PlanningDepth = 'minimal', maxIterations?: number) {
  return h.engine.run('full-build', 1, 'contract-run-1', ctx(depth), undefined, undefined, maxIterations);
}

// ============================================================================
// Contract 1: Happy path — completes, all services called once
// ============================================================================

test('contractHappyPathCompletes', async () => {
  const h = makeHarness();
  try {
    const result = await run(h);

    assert.equal(result.status, 'complete', `must complete: ${result.error}`);
    assert.equal(result.iterations_used, 1, 'must use 1 iteration');
    assert.equal(h.execService.calls, 1, 'execService must be called once');
    assert.equal(h.snapshotService.calls, 1, 'snapshotService must be called once');
    assert.equal(h.summariseService.calls, 1, 'summariseService must be called once');

    // Core LLM nodes all ran
    for (const node of ['DESIGN', 'PLAN', 'TEST', 'BUILD', 'EVALUATE']) {
      assert.ok(h.agentSpy.calls.includes(node), `${node} must run`);
    }

    // SCOPING ran via scopingService.begin()
    assert.ok(h.agentSpy.calls.includes('SCOPING'), 'SCOPING must run via scopingService');

    // SUMMARISE did NOT run via agentSpy (uses summariseService directly)
    const summariseCalls = h.agentSpy.calls.filter(n => n === 'SUMMARISE').length;
    assert.equal(summariseCalls, 0, 'SUMMARISE must not appear in agentSpy (uses summariseService)');

    // HISTORY did NOT run (folded into SNAPSHOT via logs_decision)
    assert.ok(!h.agentSpy.calls.includes('HISTORY'), 'HISTORY must not appear (folded into SNAPSHOT)');
  } finally {
    h.cleanup();
  }
});

// ============================================================================
// Contract 2: decisions.md content — SNAPSHOT writes real content
// ============================================================================

test('contractDecisionsmdHasRealContent', async () => {
  const h = makeHarness();
  try {
    await run(h);

    const decisionsPath = path.join(h.projectRoot, 'docs', 'decisions.md');
    const content = readFileSync(decisionsPath, 'utf8');

    assert.ok(content.includes('contract test'), 'decisions.md must contain goal');
    assert.ok(content.includes('minimal'), 'decisions.md must contain planning depth');
    assert.ok(content.includes('**Iteration:** 1'), 'decisions.md must contain iteration');
    assert.ok(content.includes('**Status:** complete'), 'decisions.md must contain status');
    assert.ok(content.includes('## Cycle 1.1'), 'decisions.md must contain cycle header');
  } finally {
    h.cleanup();
  }
});

// ============================================================================
// Contract 3: Critique skip at minimal, run at deep/research
// ============================================================================

test('contractCritiqueSkippedAtMinimal', async () => {
  const critic = new SpyCriticAgent();
  const h = makeHarness({ criticAgent: critic });
  try {
    await run(h, 'minimal');
    assert.equal(critic.calls, 0, 'critique must not run at minimal depth');
  } finally { h.cleanup(); }
});

test('contractCritiqueRunsAtDeep', async () => {
  const critic = new SpyCriticAgent(0);
  const h = makeHarness({ depth: 'deep', criticAgent: critic });
  try {
    await run(h, 'deep');
    assert.equal(critic.calls, 1, 'critique must run once at deep depth (passes immediately)');
  } finally { h.cleanup(); }
});

test('contractCritiqueRetryCapDeep', async () => {
  // Critic always fails. deep cap = 1 retry → 2 total calls, then falls through.
  const critic = new SpyCriticAgent(Infinity);
  const h = makeHarness({ depth: 'deep', criticAgent: critic });
  try {
    const result = await run(h, 'deep');
    assert.equal(result.status, 'complete', `must complete after critique cap: ${result.error}`);
    assert.equal(critic.calls, 2, 'critique must be called exactly twice (cap=1 retry) then fall through');
  } finally { h.cleanup(); }
});

test('contractCritiqueRetryCapResearch', async () => {
  // research cap = 3 retries → 4 total calls, then falls through.
  const critic = new SpyCriticAgent(Infinity);
  const h = makeHarness({ depth: 'research', criticAgent: critic });
  try {
    const result = await run(h, 'research');
    assert.equal(result.status, 'complete', `must complete after research critique cap: ${result.error}`);
    assert.equal(critic.calls, 4, 'critique must be called exactly 4 times (cap=3 retries) then fall through');
  } finally { h.cleanup(); }
});

// ============================================================================
// Contract 4: SCOPING — scopingService.begin() called; halt stops pipeline
// ============================================================================

test('contractScopingServiceCalled', async () => {
  const h = makeHarness();
  try {
    await run(h);
    assert.ok(h.agentSpy.calls.includes('SCOPING'), 'scopingService.begin() must call agentSpy with SCOPING');
    assert.equal(h.agentSpy.calls.indexOf('SCOPING'), 0, 'SCOPING must be first LLM call');
  } finally { h.cleanup(); }
});

test('contractScopingHaltStops', async () => {
  const h = makeHarness({ scopingAction: 'halt' });
  try {
    const result = await run(h);
    assert.equal(result.status, 'halted', 'engine must halt on scoping approval rejection');
    // No LLM nodes after SCOPING should have run
    assert.ok(!h.agentSpy.calls.includes('DESIGN'), 'DESIGN must not run after scoping halt');
  } finally { h.cleanup(); }
});

// ============================================================================
// Contract 5: CONFIRM approve, revise, halt
// ============================================================================

test('contractConfirmApproveCompletes', async () => {
  const cs = new SpyConfirmService();
  const h = makeHarness({ confirmService: cs, confirmAction: 'approve' });
  try {
    const result = await run(h);
    assert.equal(result.status, 'complete');
    assert.equal(cs.gateCalls, 1, 'confirmService.gate must be called once');
    assert.equal(cs.approveCalls, 1, 'confirmService.approve must be called once');
    assert.equal(cs.reviseCalls, 0, 'confirmService.revise must not be called on approve');
  } finally { h.cleanup(); }
});

test('contractConfirmHaltStops', async () => {
  const h = makeHarness({ confirmAction: 'halt' });
  try {
    const result = await run(h);
    assert.equal(result.status, 'halted', 'engine must halt on confirm halt');
    // BUILD must not have run
    assert.ok(!h.agentSpy.calls.includes('BUILD'), 'BUILD must not run after confirm halt');
  } finally { h.cleanup(); }
});

test('contractConfirmReviseLoopsToTestIncrementsRevision', async () => {
  // Revise once, then approve. Verifies: TEST re-runs, CONFIRM re-presents, revision increments.
  let gateCalls = 0;
  const cs = new SpyConfirmService();
  const h = makeHarness({
    confirmService: cs,
    onConfirmGateFn: async () => {
      gateCalls++;
      return gateCalls === 1 ? 'revise' : 'approve';
    },
  });

  try {
    const result = await run(h);

    assert.equal(result.status, 'complete', `must complete after revise+approve: ${result.error}`);
    assert.equal(cs.reviseCalls, 1, 'revise must be called once');
    assert.equal(cs.approveCalls, 1, 'approve must be called once');
    assert.ok(cs.gateCalls >= 2, `gate must be called ≥2 times, got ${cs.gateCalls}`);

    // TEST must have run at least twice (initial + post-revise)
    const testCount = h.agentSpy.calls.filter(n => n === 'TEST').length;
    assert.ok(testCount >= 2, `TEST must run ≥2 times after revise→TEST, got ${testCount}`);

    // CONFIRM must have been presented at least twice
    assert.ok(gateCalls >= 2, 'confirm gate must re-present after revise');
  } finally { h.cleanup(); }
});

// ============================================================================
// Contract 6: Validation pass — EVALUATE and SNAPSHOT run
// ============================================================================

test('contractValidationPassRunsEvaluateAndSnapshot', async () => {
  const h = makeHarness();
  try {
    const result = await run(h);
    assert.equal(result.status, 'complete');
    assert.ok(h.agentSpy.calls.includes('EVALUATE'), 'EVALUATE must run on validation pass');
    assert.equal(h.snapshotService.calls, 1, 'snapshotService must run on validation pass');
  } finally { h.cleanup(); }
});

// ============================================================================
// Contract 7: Validation fail → failure_report → DEBUG → PLAN
// ============================================================================

test('contractValidationFailDebugLoadFailureReportToPlan', async () => {
  const ra = new SpyRunArtifacts();
  const vg = new SpyValidationGateService(1, ra);  // fails once, then passes
  const h = makeHarness({ validationGateService: vg, runArtifacts: ra });

  try {
    const result = await run(h);
    assert.equal(result.status, 'complete', `must complete after 1 failure: ${result.error}`);

    // DEBUG was called
    assert.ok(h.agentSpy.calls.includes('DEBUG'), 'DEBUG must run after validation failure');

    // failure_report was loaded into cycleState before DEBUG
    const debugStates = h.agentSpy.capturedStates.get('DEBUG') ?? [];
    assert.ok(debugStates.length >= 1, 'DEBUG must be called at least once');
    const debugState = debugStates[0] as any;
    assert.ok(debugState.failure_report != null, 'failure_report must be set in state when DEBUG runs');
    assert.equal(debugState.failure_report.quick_summary, 'BUILD failed');

    // PLAN ran at least twice (initial + post-debug)
    const planCount = h.agentSpy.calls.filter(n => n === 'PLAN').length;
    assert.ok(planCount >= 2, `PLAN must run ≥2 times after DEBUG→PLAN, got ${planCount}`);
  } finally { h.cleanup(); }
});

// ============================================================================
// Contract 8: Structural validation fail → DEBUG → DESIGN
// ============================================================================

test('contractStructuralFailDebugRoutesToDesign', async () => {
  const ra = new SpyRunArtifacts();
  const vg = new SpyStructuralValidationGateService(1, ra);
  const h = makeHarness({ validationGateService: vg, runArtifacts: ra });

  try {
    const result = await run(h);
    assert.equal(result.status, 'complete', `must complete after structural failure: ${result.error}`);

    // DEBUG was called
    assert.ok(h.agentSpy.calls.includes('DEBUG'), 'DEBUG must run after structural failure');

    // failure_report has structural=true flag
    const debugStates = h.agentSpy.capturedStates.get('DEBUG') ?? [];
    const debugState = debugStates[0] as any;
    const hasStructural = debugState.failure_report?.failed_categories?.some((c: any) => c.structural) ?? false;
    assert.ok(hasStructural, 'failure_report must have structural=true category');

    // DESIGN ran at least twice (initial + post-debug)
    const designCount = h.agentSpy.calls.filter(n => n === 'DESIGN').length;
    assert.ok(designCount >= 2, `DESIGN must run ≥2 times after structural DEBUG→DESIGN, got ${designCount}`);
  } finally { h.cleanup(); }
});

// ============================================================================
// Contract 9: Iteration cap — halt with error message
// ============================================================================

test('contractIterationCapHalts', async () => {
  const ra = new SpyRunArtifacts();
  const vg = new SpyValidationGateService(Infinity, ra);  // always fails
  const h = makeHarness({ validationGateService: vg, runArtifacts: ra });

  try {
    const result = await run(h, 'minimal', 2);
    assert.equal(result.status, 'halted', 'engine must halt when cap exceeded');
    assert.ok(result.error?.includes('cap'), `error must mention cap: ${result.error}`);
    assert.equal(result.iterations_used, 2, 'iterations_used must equal the cap');
  } finally { h.cleanup(); }
});

// ============================================================================
// Contract 10: Iteration cap force_pass — routes to evaluate, completes
// ============================================================================

test('contractIterationCapForcePassCompletes', async () => {
  const ra = new SpyRunArtifacts();
  const vg = new SpyValidationGateService(Infinity, ra);
  const h = makeHarness({
    validationGateService: vg,
    runArtifacts: ra,
    onCapHit: async () => 'force_pass',
  });

  try {
    const result = await run(h, 'minimal', 2);
    assert.equal(result.status, 'complete', `force_pass must complete: ${result.error}`);
    assert.ok(h.agentSpy.calls.includes('EVALUATE'), 'EVALUATE must run on force_pass');
    assert.equal(h.snapshotService.calls, 1, 'SNAPSHOT must run on force_pass');
  } finally { h.cleanup(); }
});

// ============================================================================
// Contract 11: Sharding — no proposal → skipped, pipeline continues
// ============================================================================

test('contractNoShardingProposalContinues', async () => {
  const h = makeHarness();  // no .sle/sharding-proposal.yaml
  try {
    const result = await run(h);
    assert.equal(result.status, 'complete', 'must complete when no sharding proposal');
    assert.equal(h.shardingService.createCalls, 0, 'shardingService must not be called');
  } finally { h.cleanup(); }
});

// ============================================================================
// Contract 12: Sharding approve — createTasksFromProposal called
// ============================================================================

test('contractShardingApproveCreatesTasks', async () => {
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'contract-shard-'));
  try {
    mkdirSync(path.join(projectRoot, '.sle'), { recursive: true });
    writeFileSync(
      path.join(projectRoot, '.sle', 'sharding-proposal.yaml'),
      'shards:\n  - id: shard-1\n    name: First shard\n',
    );

    const ss = new SpyShardingService();
    const h = makeHarness({ projectRoot, shardingAction: 'approve', shardingService: ss });
    const result = await h.engine.run('full-build', 1, 'contract-shard-run', ctx());

    assert.equal(result.status, 'complete', `must complete after sharding approve: ${result.error}`);
    assert.equal(ss.createCalls, 1, 'shardingService.createTasksFromProposal must be called once');
    assert.ok(ss.lastProposal != null, 'proposal must be passed to shardingService');
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// Contract 13: Sharding reject — proposal file deleted, pipeline continues
// ============================================================================

test('contractShardingRejectDeletesProposal', async () => {
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'contract-reject-'));
  try {
    mkdirSync(path.join(projectRoot, '.sle'), { recursive: true });
    const proposalPath = path.join(projectRoot, '.sle', 'sharding-proposal.yaml');
    writeFileSync(proposalPath, 'shards:\n  - id: shard-1\n');

    const h = makeHarness({ projectRoot, shardingAction: 'reject' });
    const result = await h.engine.run('full-build', 1, 'contract-reject-run', ctx());

    assert.equal(result.status, 'complete', `must complete after sharding reject: ${result.error}`);
    assert.equal(h.shardingService.createCalls, 0, 'shardingService must not be called on reject');

    let exists = true;
    try { readFileSync(proposalPath); } catch { exists = false; }
    assert.equal(exists, false, 'sharding proposal file must be deleted on reject');
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// Contract 14: Sharding modify — checkpoint loops until approve
// ============================================================================

test('contractShardingModifyLoopsToApprove', async () => {
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'contract-modify-'));
  try {
    mkdirSync(path.join(projectRoot, '.sle'), { recursive: true });
    writeFileSync(
      path.join(projectRoot, '.sle', 'sharding-proposal.yaml'),
      'shards:\n  - id: shard-1\n',
    );

    let shardingCalls = 0;
    const ss = new SpyShardingService();
    const h = makeHarness({
      projectRoot,
      shardingService: ss,
      onShardingGateFn: async () => {
        shardingCalls++;
        return shardingCalls <= 2 ? 'modify' : 'approve';
      },
    });
    const result = await h.engine.run('full-build', 1, 'contract-modify-run', ctx());

    assert.equal(result.status, 'complete', `must complete after modify×2+approve: ${result.error}`);
    assert.equal(shardingCalls, 3, 'sharding gate must be called 3 times (modify, modify, approve)');
    assert.equal(ss.createCalls, 1, 'shardingService.createTasksFromProposal must be called once on approve');
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// Contract 15: WorkflowRun stays active during run, complete at end
// (Verified via WorkflowEngine return value — no WorkflowRunRepository injected)
// ============================================================================

test('contractWorkflowRunResultReachesComplete', async () => {
  const h = makeHarness();
  try {
    const result = await run(h);
    assert.equal(result.status, 'complete');
    assert.equal(result.run_id, 'contract-run-1');
    assert.ok(result.final_step_id != null, 'final_step_id must be set');
  } finally { h.cleanup(); }
});

// ============================================================================
// Contract 16: SUMMARISE uses summariseService, not agentSpy
// ============================================================================

test('contractSummariseUsesSummariseService', async () => {
  const ss = new SpySummariseService();
  const h = makeHarness({ summariseService: ss });
  try {
    await run(h);
    assert.equal(ss.calls, 1, 'summariseService.run must be called once');
    assert.ok(!h.agentSpy.calls.includes('SUMMARISE'), 'SUMMARISE must not appear in agentSpy calls');
  } finally { h.cleanup(); }
});

// ============================================================================
// Contract 17: EXEC service called exactly once per iteration
// ============================================================================

test('contractExecCalledOnce', async () => {
  const es = new SpyExecService();
  const h = makeHarness({ execService: es });
  try {
    await run(h);
    assert.equal(es.calls, 1, 'execService.run must be called exactly once');
  } finally { h.cleanup(); }
});

// ============================================================================
// NOTE: _critiqueRetries is process-local (resets on process restart).
// This is execution-recovery debt — not fixed in this pass.
// The retry counter is held in FullBuildStepRunner._critiqueRetries Map<runId, number>.
// A process restart drops the map → the effective retry budget resets.
// Durable fix would persist the count to runArtifacts or WorkflowRun state.
// ============================================================================
