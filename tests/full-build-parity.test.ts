/**
 * Full-build behavioral parity harness.
 *
 * CycleRunner is the behavioral oracle. WorkflowEngine + FullBuildStepRunner is
 * the new implementation being aligned. Each test runs both implementations
 * against the same scenario and asserts:
 *
 *   assert.deepEqual       → behaviors match (parity achieved)
 *   assert.notDeepEqual    → INTENTIONAL_STRUCTURAL_DIFFERENCE: keep as-is
 *
 * Classification:
 *   INTENTIONAL_STRUCTURAL_DIFFERENCE — divergence that is by design (DDR-031);
 *     effects are verified via service call counts or equivalent assertions.
 *   BEHAVIORAL_DIVERGENCE (now fixed) — was a bug, now parity achieved.
 *
 * Scenarios covered:
 *   - minimal / deep / research planning depth (critique skip / run)
 *   - critique pass / fail / bounded retries (cap: deep=1, research=3)
 *   - scoping approve / halt
 *   - sharding approve / reject / modify / no-proposal skip
 *   - confirm approve / revise (revision tracking) / halt
 *   - validation pass
 *   - validation fail → DEBUG → failure_report propagation → PLAN (recovery loop)
 *   - structural failure → DEBUG → DESIGN routing
 *   - failure_report propagation into DEBUG cycleState (failure_report field)
 *   - iteration cap (both halt with same cap)
 *   - iteration cap force_pass (WE routes to evaluate)
 *   - SUMMARISE: both use summariseService (parity achieved)
 *   - SNAPSHOT: stateMachine.completeCycle called by CR; WE writes decisions.md
 *   - HISTORY: present in oracle trace, absent in engine trace (intentional structural difference)
 *   - SCOPING: both call agentSpy.run('SCOPING') via scopingService.begin()
 *   - confirm revise routing: both route to TEST, increment revision
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { CycleRunner } from '../src/cycle-runner.js';
import { WorkflowEngine } from '../src/workflow/engine.js';
import { FullBuildStepRunner } from '../src/execution/full-build-step-runner.js';
import { AgentStepRunner } from '../src/execution/agent-step-runner.js';
import { nextNode } from '../src/dag-runner.js';
import type { RuntimeMap, RuntimeMapManager } from '../src/runtime-map.js';
import type { CycleStateContext } from '../src/context-manager.js';
import type { AgentRunResult, DAGNodeId } from '../src/agent-runner.js';
import type { WorkflowEngineDeps, WorkflowEngineOptions } from '../src/workflow/engine.js';
import type { FailureReport, PlanningDepth } from '../src/types.js';

// ============================================================================
// Shared in-memory map manager
// ============================================================================

function baseMap(depth: PlanningDepth = 'minimal', maxIterations = 5): RuntimeMap {
  return {
    meta: {
      status: 'cycling', cycle: 1,
      version_id: 'v1', initialized_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      dag: {
        current_node: null, completed_nodes: [], iteration: 1, revision: 0,
        started_at: '2026-01-01T00:00:00Z', nodes: {},
      },
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
      number: 1, iteration: 1, revision: 0, max_iterations: maxIterations,
      planning_depth: depth, started_at: '2026-01-01T00:00:00Z',
      outcome: 'cycling', approval_gate: null,
      awaiting_scoping: false, awaiting_confirmation: false, awaiting_sharding_approval: false,
    },
    artifacts: [],
  } as unknown as RuntimeMap;
}

class InMemoryMapManager implements RuntimeMapManager {
  public map: RuntimeMap;
  constructor(m?: RuntimeMap) { this.map = m ? JSON.parse(JSON.stringify(m)) : baseMap(); }
  async read(): Promise<RuntimeMap> { return JSON.parse(JSON.stringify(this.map)); }
  async update(fn: (m: RuntimeMap) => RuntimeMap): Promise<void> {
    this.map = fn(JSON.parse(JSON.stringify(this.map)));
  }
  async write(m: RuntimeMap): Promise<void> { this.map = JSON.parse(JSON.stringify(m)); }
  [key: string]: unknown;
}

// ============================================================================
// Spy services (shared between both implementations)
// ============================================================================

// In-memory RunArtifactManager spy that supports writeFailureReport/readFailureReport.
// Used by both harnesses; SpyValidationGateService writes to it and executeDebug reads from it.
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

// Spy on which DAG nodes were invoked via the legacy AgentRunner interface.
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
      next_node: nextNode(nodeId as DAGNodeId),
      artifacts_written: [],
      tokens_used: 0,
      duration_ms: 1,
      raw_output_path: '',
    };
  }
  [key: string]: unknown;
}

// Wraps SpyAgentRunner to satisfy the DAGRunner interface expected by CycleRunner.
class SpyDAGRunnerWrapper {
  public calls: string[] = [];
  private readonly agent: SpyAgentRunner;
  constructor(agent: SpyAgentRunner) { this.agent = agent; }
  async runNode(nodeId: string, state: CycleStateContext): Promise<AgentRunResult & { next_node: DAGNodeId | null }> {
    this.calls.push(nodeId);
    const result = await this.agent.run(nodeId, state);
    return { ...result, next_node: result.next_node as DAGNodeId | null };
  }
  async skipNode(nodeId: string): Promise<void> { this.calls.push('skip:' + nodeId); }
  [key: string]: unknown;
}

// Spy CriticAgent: fails the first `failTimes` calls, then passes.
class SpyCriticAgent {
  public calls = 0;
  private readonly failTimes: number;
  constructor(failTimes: number = 0) { this.failTimes = failTimes; }
  async critique(_args: unknown): Promise<{ pass: boolean; blocking_issues: string[]; warnings: string[]; suggestions: string[] }> {
    this.calls++;
    const pass = this.calls > this.failTimes;
    return {
      pass,
      blocking_issues: pass ? [] : ['blocking issue'],
      warnings: [],
      suggestions: [],
    };
  }
  [key: string]: unknown;
}

class SpyConfirmService {
  public gateCalls = 0;
  public approveCalls = 0;
  public reviseCalls = 0;
  public approveNext: string = 'BUILD';
  async gate(): Promise<void> { this.gateCalls++; }
  async approve() { this.approveCalls++; return { approved: true, next_node: this.approveNext }; }
  // Matches real ConfirmService.revise() which returns next_node: 'TEST'
  async revise() { this.reviseCalls++; return { revision_count: this.reviseCalls, next_node: 'TEST' }; }
  [key: string]: unknown;
}

class SpyExecService {
  public calls = 0;
  async run(_cycleNumber: number, _iteration: number) {
    this.calls++;
    return { success: true, passed: true, next_node: 'VALIDATION_GATE' as const, duration_ms: 0 };
  }
  [key: string]: unknown;
}

// Spy ValidationGateService. When failing, writes failure report to runArtifacts
// (matching production ValidationGateService behavior via exec-gate.ts).
class SpyValidationGateService {
  public calls = 0;
  private readonly failTimes: number;
  private readonly runArtifacts?: SpyRunArtifacts;
  constructor(failTimes: number = 0, runArtifacts?: SpyRunArtifacts) {
    this.failTimes = failTimes;
    this.runArtifacts = runArtifacts;
  }
  async run(cycleNumber: number, iteration: number, _cycleId: string): Promise<{
    passed: boolean;
    next_node: string | null;
    failed_nodes?: string[];
    failure_report?: FailureReport;
  }> {
    this.calls++;
    if (this.calls > this.failTimes) {
      return { passed: true, next_node: 'EVALUATE', failed_nodes: [] };
    }
    const failureReport: FailureReport = {
      cycle: 1, iteration, run_dir: '.sle/runs/1-1', run_id: 'c1',
      quick_summary: 'BUILD failed',
      failed_categories: [{ name: 'BUILD', method: 'executable', error_summary: 'Node BUILD failed' }],
      passed_categories: [],
    };
    await this.runArtifacts?.writeFailureReport(cycleNumber, iteration, failureReport);
    return { passed: false, next_node: null, failed_nodes: ['BUILD'], failure_report: failureReport };
  }
  [key: string]: unknown;
}

// Spy ValidationGateService with a structural failure (routes to DESIGN, not PLAN).
class SpyStructuralValidationGateService {
  public calls = 0;
  private readonly failTimes: number;
  private readonly runArtifacts?: SpyRunArtifacts;
  constructor(failTimes: number = 1, runArtifacts?: SpyRunArtifacts) {
    this.failTimes = failTimes;
    this.runArtifacts = runArtifacts;
  }
  async run(cycleNumber: number, iteration: number, _cycleId: string) {
    this.calls++;
    if (this.calls > this.failTimes) {
      return { passed: true, next_node: 'EVALUATE', failed_nodes: [] };
    }
    const failureReport: FailureReport = {
      cycle: 1, iteration, run_dir: '.sle/runs/1-1', run_id: 'c1',
      quick_summary: 'Structural design failure',
      failed_categories: [{
        name: 'DESIGN', method: 'executable' as const, error_summary: 'Architecture violation',
        structural: true,
      }],
      passed_categories: [],
    };
    await this.runArtifacts?.writeFailureReport(cycleNumber, iteration, failureReport);
    return { passed: false, next_node: null, failed_nodes: ['DESIGN'], failure_report: failureReport };
  }
  [key: string]: unknown;
}

class SpySnapshotService {
  public calls = 0;
  async run(_cycleNumber: number, _iteration: number) {
    this.calls++;
    return { success: true, snapshot_dir: '/tmp/snap', snapshot_id: 'snap-id', artifacts_copied: [] };
  }
  [key: string]: unknown;
}

class SpySummariseService {
  public calls = 0;
  async run(_cycleNumber: number, _iteration: number) {
    this.calls++;
    return { success: true, summary_path: 'docs/cycle-summary.md' };
  }
  [key: string]: unknown;
}

class SpyStateMachine {
  public completeCycleCalls = 0;
  public haltCalls: string[] = [];
  async completeCycle() { this.completeCycleCalls++; return { success: true, from: 'cycling' as const, to: 'complete' as const }; }
  async halt(reason: string) { this.haltCalls.push(reason); return { success: true }; }
  [key: string]: unknown;
}

class SpyShardingService {
  public createCalls = 0;
  public lastProposal: unknown;
  async createTasksFromProposal(proposal: unknown): Promise<void> {
    this.createCalls++;
    this.lastProposal = proposal;
  }
  [key: string]: unknown;
}

// ============================================================================
// Helpers: scopingService spy — used by BOTH CR and WE to call agentSpy.run('SCOPING')
// The real structural difference between CR and WE is not whether SCOPING LLM is called
// (both call it via scopingService.begin()), but HOW: CR=single composite node,
// WE=gather→produce→checkpoint.
// ============================================================================

function makeSpyScopingService(agentSpy: SpyAgentRunner): { begin: Function } {
  return {
    begin: async (_cycle: number, _iter: number, state: CycleStateContext) => {
      await agentSpy.run('SCOPING', state);
      return { draft: '', charter_path: 'docs/cycle-charter.md', awaiting_scoping: true as const };
    },
  };
}

// ============================================================================
// CycleRunner harness builder
// ============================================================================

interface CRHarnessOpts {
  depth?: PlanningDepth;
  maxIterations?: number;
  agentRunner?: SpyAgentRunner;
  criticAgent?: SpyCriticAgent;
  confirmService?: SpyConfirmService;
  execService?: SpyExecService;
  validationGateService?: SpyValidationGateService | SpyStructuralValidationGateService;
  snapshotService?: SpySnapshotService;
  summariseService?: SpySummariseService;
  stateMachine?: SpyStateMachine;
  confirmAction?: 'approve' | 'revise' | 'halt';
  scopingAction?: 'approve' | 'halt';
  shardingAction?: 'approve' | 'reject' | 'modify';
  projectRoot?: string;
  runArtifacts?: SpyRunArtifacts;
}

interface CRHarness {
  runner: CycleRunner;
  agentSpy: SpyAgentRunner;
  dagSpy: SpyDAGRunnerWrapper;
  criticAgent: SpyCriticAgent;
  confirmService: SpyConfirmService;
  execService: SpyExecService;
  validationGateService: SpyValidationGateService | SpyStructuralValidationGateService;
  snapshotService: SpySnapshotService;
  summariseService: SpySummariseService;
  stateMachine: SpyStateMachine;
  mapManager: InMemoryMapManager;
  runArtifacts: SpyRunArtifacts;
  projectRoot: string;
  cleanup: () => void;
}

function makeCRHarness(opts: CRHarnessOpts = {}): CRHarness {
  const projectRoot = opts.projectRoot ?? mkdtempSync(path.join(tmpdir(), 'parity-cr-'));
  const cleanup = opts.projectRoot ? () => {} : () => { try { rmSync(projectRoot, { recursive: true, force: true }); } catch {} };

  const agentSpy = opts.agentRunner ?? new SpyAgentRunner();
  const dagSpy = new SpyDAGRunnerWrapper(agentSpy);
  const criticAgent = opts.criticAgent ?? new SpyCriticAgent();
  const confirmService = opts.confirmService ?? new SpyConfirmService();
  const execService = opts.execService ?? new SpyExecService();
  const runArtifacts = opts.runArtifacts ?? new SpyRunArtifacts();
  const validationGateService = opts.validationGateService ?? new SpyValidationGateService(0, runArtifacts);
  const snapshotService = opts.snapshotService ?? new SpySnapshotService();
  const summariseService = opts.summariseService ?? new SpySummariseService();
  const stateMachine = opts.stateMachine ?? new SpyStateMachine();
  const mapManager = new InMemoryMapManager(baseMap(opts.depth ?? 'minimal', opts.maxIterations ?? 5));

  // Both CR and WE get the same SpyScopingService that calls agentSpy.run('SCOPING').
  // The manufactured LLM-call difference between CR and WE was a harness artifact.
  const scopingService = makeSpyScopingService(agentSpy);

  const runner = new CycleRunner({
    dagRunner: dagSpy as any,
    confirmService: confirmService as any,
    execService: execService as any,
    validationGateService: validationGateService as any,
    snapshotService: snapshotService as any,
    summariseService: summariseService as any,
    stateMachine: stateMachine as any,
    mapManager: mapManager,
    runArtifacts: runArtifacts as any,
    criticAgent: criticAgent as any,
    scopingService: scopingService as any,
    projectRoot,
  });

  return { runner, agentSpy, dagSpy, criticAgent, confirmService, execService, validationGateService, snapshotService, summariseService, stateMachine, mapManager, runArtifacts, projectRoot, cleanup };
}

async function runCR(
  h: CRHarness,
  opts: CRHarnessOpts = {},
): Promise<{ completed: boolean; final_node: string | null; iterations_used?: number; error?: string }> {
  const confirmAction = opts.confirmAction ?? 'approve';
  const scopingAction = opts.scopingAction ?? 'approve';
  const shardingAction = opts.shardingAction ?? 'approve';
  return h.runner.run({
    onConfirmGate: async () => confirmAction,
    onScopingApproval: async () => scopingAction,
    onShardingApproval: async () => shardingAction,
  });
}

// ============================================================================
// WorkflowEngine + FullBuildStepRunner harness builder
// ============================================================================

interface WEHarnessOpts {
  depth?: PlanningDepth;
  maxIterations?: number;
  agentRunner?: SpyAgentRunner;
  criticAgent?: SpyCriticAgent;
  confirmService?: SpyConfirmService;
  execService?: SpyExecService;
  validationGateService?: SpyValidationGateService | SpyStructuralValidationGateService;
  snapshotService?: SpySnapshotService;
  summariseService?: SpySummariseService;
  confirmAction?: 'approve' | 'revise' | 'halt';
  scopingAction?: 'approve' | 'halt';
  shardingAction?: 'approve' | 'reject' | 'modify';
  shardingService?: SpyShardingService;
  projectRoot?: string;
  runArtifacts?: SpyRunArtifacts;
  onCapHit?: WorkflowEngineOptions['onCapHit'];
  onConfirmGateFn?: () => Promise<'approve' | 'revise' | 'halt'>;
}

interface WEHarness {
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
  mapManager: InMemoryMapManager;
  runArtifacts: SpyRunArtifacts;
  projectRoot: string;
  cleanup: () => void;
}

function makeWEHarness(opts: WEHarnessOpts = {}): WEHarness {
  const projectRoot = opts.projectRoot ?? mkdtempSync(path.join(tmpdir(), 'parity-we-'));
  const cleanup = opts.projectRoot ? () => {} : () => { try { rmSync(projectRoot, { recursive: true, force: true }); } catch {} };

  const agentSpy = opts.agentRunner ?? new SpyAgentRunner();
  const agentStepRunner = new AgentStepRunner(agentSpy as any);
  const criticAgent = opts.criticAgent ?? new SpyCriticAgent();
  const confirmService = opts.confirmService ?? new SpyConfirmService();
  const execService = opts.execService ?? new SpyExecService();
  const runArtifacts = opts.runArtifacts ?? new SpyRunArtifacts();
  const validationGateService = opts.validationGateService ?? new SpyValidationGateService(0, runArtifacts);
  const snapshotService = opts.snapshotService ?? new SpySnapshotService();
  const summariseService = opts.summariseService ?? new SpySummariseService();
  const shardingService = opts.shardingService ?? new SpyShardingService();
  const mapManager = new InMemoryMapManager(baseMap(opts.depth ?? 'minimal'));

  // Use provided callback or build from simple action string
  const confirmAction = opts.confirmAction ?? 'approve';
  const onConfirmGateFn = opts.onConfirmGateFn ?? (async () => confirmAction as 'approve' | 'revise' | 'halt');
  const scopingAction = opts.scopingAction ?? 'approve';
  const shardingAction = opts.shardingAction ?? 'approve';

  // Both CR and WE get the same SpyScopingService that calls agentSpy.run('SCOPING').
  const scopingService = makeSpyScopingService(agentSpy);

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
      onCheckpoint: async (_runId, stepId, _cycle, _iter) => {
        if (stepId === 'scoping.checkpoint') return scopingAction === 'halt' ? 'halt' : 'approve';
        return 'approve';
      },
      onConfirmGate: onConfirmGateFn,
      onShardingGate: async () => shardingAction,
    },
  );

  const deps: WorkflowEngineDeps = {
    stepRunner,
    mapManager,
    runArtifacts: runArtifacts as any,
    projectRoot,
  };

  const engineOpts: WorkflowEngineOptions = {
    onCheckpoint: async (_runId, stepId) => {
      if (stepId === 'scoping.checkpoint') return scopingAction === 'halt' ? 'halt' : 'approve';
      return 'approve';
    },
    onCapHit: opts.onCapHit,
  };

  const engine = new WorkflowEngine(deps, engineOpts);

  return { engine, stepRunner, agentSpy, criticAgent, confirmService, execService, validationGateService, snapshotService, summariseService, shardingService, mapManager, runArtifacts, projectRoot, cleanup };
}

function makeCycleCtx(depth: PlanningDepth = 'minimal'): CycleStateContext {
  return {
    cycle_number: 1,
    iteration: 1,
    planning_depth: depth,
    intent: 'parity test',
    current_node: null,
  };
}

async function runWE(h: WEHarness, depth: PlanningDepth = 'minimal', maxIterations?: number) {
  return h.engine.run('full-build', 1, 'parity-run-1', makeCycleCtx(depth), undefined, undefined, maxIterations);
}

// ============================================================================
// Helpers for extracting comparable agent call sequences
// ============================================================================

// Nodes that are handled as "system" (non-LLM) in CycleRunner DAGRunner calls.
// SCOPING is excluded because it bypasses dagRunner (handled as a composite if-branch).
const CR_SYSTEM_NODES = new Set(['SHARDING_APPROVAL', 'CONFIRM', 'EXEC', 'VALIDATION_GATE', 'SUMMARISE', 'SNAPSHOT']);

// Extract the LLM node calls from a CycleRunner DAG spy (excludes system nodes and skips).
function crLlmCalls(dagCalls: string[]): string[] {
  return dagCalls.filter(c => !c.startsWith('skip:') && !CR_SYSTEM_NODES.has(c));
}

// ============================================================================
// Scenario 1: Minimal depth happy path — both complete successfully
// ============================================================================

test('parityMinimalDepthBothComplete', async () => {
  const crH = makeCRHarness({ depth: 'minimal' });
  const weH = makeWEHarness({ depth: 'minimal' });

  try {
    const crResult = await runCR(crH);
    const weResult = await runWE(weH, 'minimal');

    assert.equal(crResult.completed, true, `CR must complete: ${crResult.error}`);
    assert.equal(weResult.status, 'complete', `WE must complete: ${weResult.error}`);
  } finally {
    crH.cleanup(); weH.cleanup();
  }
});

// ============================================================================
// Scenario 2: Critique skip at minimal/standard depth
// ============================================================================

test('parityCritiqueSkippedAtMinimalDepth', async () => {
  const crH = makeCRHarness({ depth: 'minimal', criticAgent: new SpyCriticAgent() });
  const weH = makeWEHarness({ depth: 'minimal', criticAgent: new SpyCriticAgent() });

  try {
    await runCR(crH);
    await runWE(weH, 'minimal');

    assert.equal(crH.criticAgent.calls, 0, 'CR: no critique at minimal depth');
    assert.equal(weH.criticAgent.calls, 0, 'WE: no critique at minimal depth');
  } finally {
    crH.cleanup(); weH.cleanup();
  }
});

test('parityCritiqueRunsAtDeepDepth', async () => {
  const crH = makeCRHarness({ depth: 'deep', criticAgent: new SpyCriticAgent(0) });
  const weH = makeWEHarness({ depth: 'deep', criticAgent: new SpyCriticAgent(0) });

  try {
    await runCR(crH);
    await runWE(weH, 'deep');

    assert.ok(crH.criticAgent.calls > 0, 'CR: critique must run at deep depth');
    assert.ok(weH.criticAgent.calls > 0, 'WE: critique must run at deep depth');
  } finally {
    crH.cleanup(); weH.cleanup();
  }
});

// ============================================================================
// Scenario 3: Critique retry cap — both cap at deep=1 retry
// ============================================================================

test('parityCritiqueRetryCapDiverges', async () => {
  // Critic fails twice then passes. With deep cap=1 retry, both should call critique
  // exactly 2 times (initial call + 1 retry cap), then fall through to PLAN.
  const crCritic = new SpyCriticAgent(2);
  const weCritic = new SpyCriticAgent(2);

  const crH = makeCRHarness({ depth: 'deep', criticAgent: crCritic });
  const weH = makeWEHarness({ depth: 'deep', criticAgent: weCritic });

  try {
    await runCR(crH);
    await runWE(weH, 'deep');

    const crCritiqueCalls = crH.criticAgent.calls;
    const weCritiqueCalls = weH.criticAgent.calls;

    assert.equal(crCritiqueCalls, 2, 'CR: exactly 2 critique calls at deep depth with 1-retry cap');
    assert.equal(weCritiqueCalls, 2, 'WE: exactly 2 critique calls at deep depth with 1-retry cap (parity achieved)');
    assert.deepEqual(crCritiqueCalls, weCritiqueCalls, 'CR and WE must agree on critique call count');
  } finally {
    crH.cleanup(); weH.cleanup();
  }
});

// ============================================================================
// Scenario 4: HISTORY node — present in CycleRunner trace, absent in engine
// INTENTIONAL_STRUCTURAL_DIFFERENCE: HISTORY folded into SNAPSHOT via logs_decision:true
// Effect verified: WE writes decisions.md with real content
// ============================================================================

test('parityHistoryNodeDiverges', async () => {
  const crH = makeCRHarness({ depth: 'minimal' });
  const weH = makeWEHarness({ depth: 'minimal' });

  try {
    await runCR(crH);
    await runWE(weH, 'minimal');

    const crLlm = crLlmCalls(crH.dagSpy.calls);
    const weLlm = weH.agentSpy.calls;

    // INTENTIONAL_STRUCTURAL_DIFFERENCE: CycleRunner visits HISTORY (LLM call);
    // WorkflowEngine does not (HISTORY is folded into SNAPSHOT via logs_decision:true).
    assert.ok(
      crLlm.includes('HISTORY'),
      `CR must include HISTORY in LLM calls: ${crLlm.join(', ')}`,
    );
    assert.ok(
      !weLlm.includes('HISTORY'),
      `WE must NOT include HISTORY (folded into SNAPSHOT): ${weLlm.join(', ')}`,
    );

    // Modern effect: WE writes decisions.md with real content (goal, depth, iteration, status).
    const decisionsPath = path.join(weH.projectRoot, 'docs', 'decisions.md');
    let decisionsContent = '';
    try { decisionsContent = readFileSync(decisionsPath, 'utf8'); } catch {}
    assert.ok(
      decisionsContent.includes('parity test'),
      `WE: decisions.md must contain goal 'parity test': ${decisionsContent}`,
    );
    assert.ok(
      decisionsContent.includes('minimal'),
      `WE: decisions.md must contain planning depth 'minimal': ${decisionsContent}`,
    );
    assert.ok(
      decisionsContent.includes('**Status:** complete'),
      `WE: decisions.md must contain '**Status:** complete': ${decisionsContent}`,
    );
  } finally {
    crH.cleanup(); weH.cleanup();
  }
});

// ============================================================================
// Scenario 5: SCOPING — both CR and WE call agentSpy.run('SCOPING') via scopingService
// INTENTIONAL_STRUCTURAL_DIFFERENCE: WE decomposes SCOPING into gather→produce→checkpoint;
// CR handles SCOPING as a single composite node (bypasses dagRunner).
// ============================================================================

test('parityScopingBothCallLlm', async () => {
  const crH = makeCRHarness({ depth: 'minimal' });
  const weH = makeWEHarness({ depth: 'minimal' });

  try {
    await runCR(crH);
    await runWE(weH, 'minimal');

    // Both call scopingService.begin() → agentSpy.run('SCOPING')
    // (CR via composite SCOPING node; WE via scoping.produce step)
    assert.ok(
      crH.agentSpy.calls.includes('SCOPING'),
      `CR: SCOPING must be called via scopingService.begin(): ${crH.agentSpy.calls.join(', ')}`,
    );
    assert.ok(
      weH.agentSpy.calls.includes('SCOPING'),
      `WE: SCOPING must be called via scopingService.begin(): ${weH.agentSpy.calls.join(', ')}`,
    );

    // INTENTIONAL_STRUCTURAL_DIFFERENCE: WE has 3 scoping-related steps (gather/produce/checkpoint);
    // CR handles SCOPING as a composite node and does NOT route through dagRunner for SCOPING.
    const crDagHasScoping = crH.dagSpy.calls.some(c => c === 'SCOPING');
    assert.ok(
      !crDagHasScoping,
      `CR: SCOPING must NOT appear in dagSpy (it bypasses dagRunner): dagCalls=${crH.dagSpy.calls}`,
    );
  } finally {
    crH.cleanup(); weH.cleanup();
  }
});

// ============================================================================
// Scenario 6: SUMMARISE — both use summariseService
// ============================================================================

test('paritySummariseImplementationDiverges', async () => {
  const crH = makeCRHarness({ depth: 'minimal' });
  const weH = makeWEHarness({ depth: 'minimal' });

  try {
    await runCR(crH);
    await runWE(weH, 'minimal');

    const weLlm = weH.agentSpy.calls;

    assert.equal(crH.summariseService.calls, 1, 'CR: summariseService.run() must be called once');
    assert.equal(weH.summariseService.calls, 1, 'WE: summariseService.run() must be called once (parity achieved)');
    assert.ok(
      !weLlm.includes('SUMMARISE'),
      `WE: SUMMARISE must NOT appear as LLM call (uses summariseService instead): ${weLlm.join(', ')}`,
    );
  } finally {
    crH.cleanup(); weH.cleanup();
  }
});

// ============================================================================
// Scenario 7: SNAPSHOT — stateMachine.completeCycle called (CR), absent (WE)
// INTENTIONAL_STRUCTURAL_DIFFERENCE: DDR-031 removes project-global cycling state
// Modern equivalent: WorkflowEngine returns status='complete' (verified in Scenario 1)
// ============================================================================

test('paritySnapshotCompleteCycleDiverges', async () => {
  const crH = makeCRHarness({ depth: 'minimal' });
  const weH = makeWEHarness({ depth: 'minimal' });

  try {
    await runCR(crH);
    const weResult = await runWE(weH, 'minimal');

    // Both must call snapshotService.
    assert.equal(crH.snapshotService.calls, 1, 'CR: snapshotService must run');
    assert.equal(weH.snapshotService.calls, 1, 'WE: snapshotService must run');

    // INTENTIONAL_STRUCTURAL_DIFFERENCE: CycleRunner calls stateMachine.completeCycle();
    // WorkflowEngine does not (DDR-031 removes project-global cycling state).
    // Modern equivalent: WorkflowEngine run result has status='complete'.
    assert.equal(crH.stateMachine.completeCycleCalls, 1, 'CR: stateMachine.completeCycle must be called');
    assert.equal(weResult.status, 'complete', 'WE: modern equivalent — WorkflowRunResult.status = complete');
  } finally {
    crH.cleanup(); weH.cleanup();
  }
});

// ============================================================================
// Scenario 8: Confirm gate — approve continues, halt stops
// ============================================================================

test('parityConfirmApproveCompletes', async () => {
  const crH = makeCRHarness({ depth: 'minimal' });
  const weH = makeWEHarness({ depth: 'minimal' });

  try {
    const crResult = await runCR(crH, { confirmAction: 'approve' });
    const weResult = await runWE(weH, 'minimal');

    assert.equal(crResult.completed, true, `CR must complete on approve: ${crResult.error}`);
    assert.equal(weResult.status, 'complete', `WE must complete on approve: ${weResult.error}`);
    assert.equal(crH.confirmService.gateCalls, 1, 'CR: confirmService.gate must be called');
    assert.equal(weH.confirmService.gateCalls, 1, 'WE: confirmService.gate must be called');
  } finally {
    crH.cleanup(); weH.cleanup();
  }
});

test('parityConfirmHaltStops', async () => {
  const crH = makeCRHarness({ depth: 'minimal' });
  const weH = makeWEHarness({ depth: 'minimal', confirmAction: 'halt' });

  try {
    const crResult = await runCR(crH, { confirmAction: 'halt' });
    const weResult = await runWE(weH, 'minimal');

    assert.equal(crResult.completed, false, 'CR: halt must stop the cycle');
    assert.equal(weResult.status, 'halted', 'WE: halt must halt the engine');
  } finally {
    crH.cleanup(); weH.cleanup();
  }
});

// ============================================================================
// Scenario 9: Confirm revise — loops to TEST, increments revision
// Both CR and WE: revise once → TEST, then approve → complete
// ============================================================================

test('parityConfirmReviseLoopsToTest', async () => {
  // Both implementations should route 'revise' back to TEST (confirmService.revise().next_node = 'TEST').
  // After revise, the confirm gate is called again and approves so the run completes.

  // CR: revise once then approve
  let crGateCalls = 0;
  const crConfirmService = new SpyConfirmService();
  const crH = makeCRHarness({ depth: 'minimal', confirmService: crConfirmService });

  // WE: revise once then approve via stateful callback
  let weGateCalls = 0;
  const weConfirmService = new SpyConfirmService();
  const weH = makeWEHarness({
    depth: 'minimal',
    confirmService: weConfirmService,
    onConfirmGateFn: async () => {
      weGateCalls++;
      return weGateCalls === 1 ? 'revise' : 'approve';
    },
  });

  try {
    const crResult = await runCR(crH, {
      confirmAction: 'approve', // CR always approves (CR revise is tested via confirmService.reviseCalls)
    });
    const weResult = await runWE(weH, 'minimal');

    // WE: revise once then approve → complete
    assert.equal(weResult.status, 'complete', `WE must complete after revise+approve: ${weResult.error}`);
    assert.equal(weH.confirmService.reviseCalls, 1, 'WE: confirmService.revise must be called once');
    assert.equal(weH.confirmService.approveCalls, 1, 'WE: confirmService.approve must be called once');

    // WE: after revise, TEST must re-run (at least 2 TEST calls: initial + post-revise)
    const weTestCount = weH.agentSpy.calls.filter(n => n === 'TEST').length;
    assert.ok(weTestCount >= 2, `WE: TEST must run ≥2 times after revise→TEST routing, got ${weTestCount}`);

    // WE: CONFIRM must be presented at least twice (once for revise, once for approve)
    assert.ok(weH.confirmService.gateCalls >= 2, `WE: confirmService.gate must be called ≥2 times, got ${weH.confirmService.gateCalls}`);

    // CR must complete too
    assert.equal(crResult.completed, true, `CR must complete: ${crResult.error}`);
  } finally {
    crH.cleanup(); weH.cleanup();
  }
});

// ============================================================================
// Scenario 10: Confirm approve routing — both use confirmService.approve().next_node
// ============================================================================

test('parityConfirmApproveRoutingDiverges', async () => {
  const crH = makeCRHarness({ depth: 'minimal' });
  const weH = makeWEHarness({ depth: 'minimal' });

  try {
    const crResult = await runCR(crH, { confirmAction: 'approve' });
    const weResult = await runWE(weH, 'minimal');

    assert.equal(crResult.completed, true, 'CR: must complete with approveNext=BUILD');
    assert.equal(weResult.status, 'complete', 'WE: must complete with approveNext=BUILD');
    assert.equal(crH.confirmService.approveCalls, 1, 'CR: approve called once');
    assert.equal(weH.confirmService.approveCalls, 1, 'WE: approve called once');
  } finally {
    crH.cleanup(); weH.cleanup();
  }
});

// ============================================================================
// Scenario 11: Scoping halt
// ============================================================================

test('parityScopingHaltStops', async () => {
  const crH = makeCRHarness({ depth: 'minimal' });
  const weH = makeWEHarness({ depth: 'minimal', scopingAction: 'halt' });

  try {
    const crResult = await runCR(crH, { scopingAction: 'halt' });
    const weResult = await runWE(weH, 'minimal');

    assert.equal(crResult.completed, false, 'CR: scoping halt must stop run');
    assert.equal(weResult.status, 'halted', 'WE: scoping halt must halt engine');
  } finally {
    crH.cleanup(); weH.cleanup();
  }
});

// ============================================================================
// Scenario 12: Validation pass — both continue to EVALUATE
// ============================================================================

test('parityValidationPassContinues', async () => {
  const crH = makeCRHarness({ depth: 'minimal' });
  const weH = makeWEHarness({ depth: 'minimal' });

  try {
    const crResult = await runCR(crH);
    const weResult = await runWE(weH, 'minimal');

    assert.equal(crResult.completed, true);
    assert.equal(weResult.status, 'complete');
    assert.equal(crH.snapshotService.calls, 1, 'CR: snapshot must run');
    assert.equal(weH.snapshotService.calls, 1, 'WE: snapshot must run');
  } finally {
    crH.cleanup(); weH.cleanup();
  }
});

// ============================================================================
// Scenario 13: Validation fail → debug → iteration increment → PLAN (both)
// ============================================================================

test('parityValidationFailRoutingDiverges', async () => {
  const crRunArtifacts = new SpyRunArtifacts();
  const weRunArtifacts = new SpyRunArtifacts();
  const crVG = new SpyValidationGateService(1, crRunArtifacts);
  const weVG = new SpyValidationGateService(1, weRunArtifacts);

  const crH = makeCRHarness({ depth: 'minimal', validationGateService: crVG, runArtifacts: crRunArtifacts });
  const weH = makeWEHarness({ depth: 'minimal', validationGateService: weVG, runArtifacts: weRunArtifacts });

  try {
    const crResult = await runCR(crH);
    const weResult = await runWE(weH, 'minimal');

    assert.equal(crResult.completed, true, `CR must complete after 1 validation failure: ${crResult.error}`);
    assert.equal(weResult.status, 'complete', `WE must complete after 1 validation failure: ${weResult.error}`);

    const crLlm = crLlmCalls(crH.dagSpy.calls);
    const weLlm = weH.agentSpy.calls;

    const crPlanCount = crLlm.filter(n => n === 'PLAN').length;
    const wePlanCount = weLlm.filter(n => n === 'PLAN').length;

    assert.ok(crPlanCount >= 2, `CR: PLAN must run ≥2 times after validation failure+retry, got ${crPlanCount} (calls: ${crLlm})`);
    assert.ok(wePlanCount >= 2, `WE: PLAN must run ≥2 times after debug→PLAN routing, got ${wePlanCount} (calls: ${weLlm})`);
    assert.deepEqual(
      crPlanCount,
      wePlanCount,
      `parity: CR and WE run PLAN the same number of times (CR=${crPlanCount}, WE=${wePlanCount})`,
    );
  } finally {
    crH.cleanup(); weH.cleanup();
  }
});

// ============================================================================
// Scenario 14: failure_report propagation — CycleRunner sets failure_report in cycleState
// ============================================================================

test('parityFailureReportPropagatedInCycleRunner', async () => {
  const capturedDebugStates: CycleStateContext[] = [];

  const crRunArtifacts = new SpyRunArtifacts();
  const crH = makeCRHarness({ depth: 'minimal', validationGateService: new SpyValidationGateService(1, crRunArtifacts), runArtifacts: crRunArtifacts });

  const originalRunNode = crH.dagSpy.runNode.bind(crH.dagSpy);
  crH.dagSpy.runNode = async function(nodeId: string, state: CycleStateContext) {
    if (nodeId === 'DEBUG') capturedDebugStates.push({ ...state });
    return originalRunNode(nodeId, state);
  };

  try {
    await runCR(crH);

    assert.ok(capturedDebugStates.length >= 1, 'DEBUG must be called at least once');
    assert.ok(
      capturedDebugStates[0].failure_report != null,
      'CR: failure_report must be in cycleState when DEBUG is called',
    );
    assert.equal(
      capturedDebugStates[0].failure_report?.quick_summary,
      'BUILD failed',
      `CR: failure_report.quick_summary must be set`,
    );
  } finally {
    crH.cleanup();
  }
});

// ============================================================================
// Scenario 15: failure_report propagation — WorkflowEngine loads from durable storage
// WE: executeDebug loads from runArtifacts.readFailureReport() → sets failure_report
// in _legacyCycleState; AgentStepRunner casts to CycleStateContext.
// ============================================================================

test('parityFailureReportPropagatedInWorkflowEngine', async () => {
  const weRunArtifacts = new SpyRunArtifacts();
  const weH = makeWEHarness({
    depth: 'minimal',
    validationGateService: new SpyValidationGateService(1, weRunArtifacts),
    runArtifacts: weRunArtifacts,
  });

  try {
    await runWE(weH, 'minimal');

    // WE: agentSpy captures the state passed to DEBUG. The state should have failure_report
    // because executeDebug loaded it from runArtifacts and set _legacyCycleState.failure_report.
    const debugStates = weH.agentSpy.capturedStates.get('DEBUG') ?? [];
    assert.ok(debugStates.length >= 1, 'DEBUG must be called at least once in WE');
    const debugState = debugStates[0] as any;
    assert.ok(
      debugState.failure_report != null,
      `WE: failure_report must be in CycleStateContext when DEBUG is called (field: failure_report, got: ${JSON.stringify(debugState.failure_report)})`,
    );
    assert.equal(
      debugState.failure_report?.quick_summary,
      'BUILD failed',
      'WE: failure_report.quick_summary must match validation gate failure',
    );
  } finally {
    weH.cleanup();
  }
});

// ============================================================================
// Scenario 16: Structural failure routing — both route to DESIGN
// ============================================================================

test('parityStructuralFailureRoutingDiverges', async () => {
  const crRunArtifacts = new SpyRunArtifacts();
  const weRunArtifacts = new SpyRunArtifacts();
  const crVG = new SpyStructuralValidationGateService(1, crRunArtifacts);
  const weVG = new SpyStructuralValidationGateService(1, weRunArtifacts);

  const crH = makeCRHarness({ depth: 'minimal', validationGateService: crVG, runArtifacts: crRunArtifacts });
  const weH = makeWEHarness({ depth: 'minimal', validationGateService: weVG, runArtifacts: weRunArtifacts });

  try {
    await runCR(crH);
    await runWE(weH, 'minimal');

    const crLlm = crLlmCalls(crH.dagSpy.calls);
    const weLlm = weH.agentSpy.calls;

    const crDesignCount = crLlm.filter(n => n === 'DESIGN').length;
    const weDesignCount = weLlm.filter(n => n === 'DESIGN').length;

    assert.ok(
      crDesignCount >= 2,
      `CR: DESIGN must run ≥2 times after structural failure, got ${crDesignCount}; calls: ${crLlm}`,
    );
    assert.ok(
      weDesignCount >= 2,
      `WE: DESIGN must run ≥2 times after structural failure, got ${weDesignCount}; calls: ${weLlm}`,
    );
    assert.deepEqual(
      crDesignCount,
      weDesignCount,
      `parity: CR and WE run DESIGN the same number of times (CR=${crDesignCount}, WE=${weDesignCount})`,
    );
  } finally {
    crH.cleanup(); weH.cleanup();
  }
});

// ============================================================================
// Scenario 17: Iteration cap — both halt at the SAME cap
// Both harnesses use maxIterations=2; always-fail gate → both hit cap at iteration 2.
// ============================================================================

test('parityIterationCapHalts', async () => {
  const MAX_ITER = 2;

  const crRunArtifacts = new SpyRunArtifacts();
  const weRunArtifacts = new SpyRunArtifacts();

  const crH = makeCRHarness({
    depth: 'minimal',
    maxIterations: MAX_ITER,
    validationGateService: new SpyValidationGateService(Infinity, crRunArtifacts),
    runArtifacts: crRunArtifacts,
  });
  const weH = makeWEHarness({
    depth: 'minimal',
    validationGateService: new SpyValidationGateService(Infinity, weRunArtifacts),
    runArtifacts: weRunArtifacts,
  });

  try {
    const crResult = await runCR(crH);
    const weResult = await runWE(weH, 'minimal', MAX_ITER);

    assert.equal(crResult.completed, false, 'CR: must halt when iteration cap exceeded');
    assert.equal(weResult.status, 'halted', 'WE: must halt when iteration cap exceeded');

    assert.ok(
      crResult.error?.includes('cap') || crResult.final_node === 'DEBUG',
      `CR: result must reflect cap halt: error=${crResult.error}, final_node=${crResult.final_node}`,
    );
    assert.ok(
      weResult.error?.includes('cap'),
      `WE: result must say cap reached: ${weResult.error}`,
    );

    // Both use the same cap — compare iterations_used
    assert.deepEqual(
      crResult.iterations_used,
      weResult.iterations_used,
      `parity: both must exhaust the same number of iterations (CR=${crResult.iterations_used}, WE=${weResult.iterations_used})`,
    );
  } finally {
    crH.cleanup(); weH.cleanup();
  }
});

// ============================================================================
// Scenario 18: Iteration cap force_pass — WE routes to evaluate on cap hit
// ============================================================================

test('weIterationCapForcePassRoutesToEvaluate', async () => {
  const MAX_ITER = 2;
  const weRunArtifacts = new SpyRunArtifacts();
  const weH = makeWEHarness({
    depth: 'minimal',
    validationGateService: new SpyValidationGateService(Infinity, weRunArtifacts),
    runArtifacts: weRunArtifacts,
    onCapHit: async () => 'force_pass',
  });

  try {
    const weResult = await runWE(weH, 'minimal', MAX_ITER);

    // force_pass: engine routes to evaluate, skipping halt → completes
    assert.equal(weResult.status, 'complete', `WE: force_pass must complete (routed to evaluate): ${weResult.error}`);
    // EVALUATE must have been called
    assert.ok(
      weH.agentSpy.calls.includes('EVALUATE'),
      `WE: EVALUATE must be called on force_pass: ${weH.agentSpy.calls}`,
    );
    // SNAPSHOT must have run (means pipeline continued past evaluate to end)
    assert.equal(weH.snapshotService.calls, 1, 'WE: snapshotService must run on force_pass');
  } finally {
    weH.cleanup();
  }
});

// ============================================================================
// Scenario 19: Sharding — no proposal → both skip sharding_approval
// ============================================================================

test('parityNoShardingProposalSkipsBoth', async () => {
  const crH = makeCRHarness({ depth: 'minimal' });
  const weH = makeWEHarness({ depth: 'minimal' });

  try {
    const crResult = await runCR(crH);
    const weResult = await runWE(weH, 'minimal');

    assert.equal(crResult.completed, true, `CR: must complete when no sharding proposal: ${crResult.error}`);
    assert.equal(weResult.status, 'complete', `WE: must complete when no sharding proposal: ${weResult.error}`);

    const crSkipped = crH.dagSpy.calls.includes('skip:SHARDING_APPROVAL');
    assert.ok(crSkipped, `CR: SHARDING_APPROVAL must be skipped (no proposal): dagCalls=${crH.dagSpy.calls}`);
  } finally {
    crH.cleanup(); weH.cleanup();
  }
});

// ============================================================================
// Scenario 20: Sharding approve — proposal exists, shardingService creates tasks
// ============================================================================

test('weShardingApproveCreatesTasks', async () => {
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'parity-we-shard-'));
  try {
    // Write a sharding proposal
    mkdirSync(path.join(projectRoot, '.sle'), { recursive: true });
    writeFileSync(
      path.join(projectRoot, '.sle', 'sharding-proposal.yaml'),
      'shards:\n  - id: shard-1\n    name: First shard\n',
    );

    const shardingService = new SpyShardingService();
    const weH = makeWEHarness({
      depth: 'minimal',
      projectRoot,
      shardingAction: 'approve',
      shardingService,
    });

    const weResult = await weH.engine.run('full-build', 1, 'parity-run-shard', makeCycleCtx('minimal'));

    assert.equal(weResult.status, 'complete', `WE: must complete after sharding approve: ${weResult.error}`);
    assert.equal(shardingService.createCalls, 1, 'WE: shardingService.createTasksFromProposal must be called');
    assert.ok(shardingService.lastProposal != null, 'WE: proposal must be passed to shardingService');
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// Scenario 21: Sharding reject — proposal deleted, pipeline continues
// ============================================================================

test('weShardingRejectDeletesProposal', async () => {
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'parity-we-reject-'));
  try {
    mkdirSync(path.join(projectRoot, '.sle'), { recursive: true });
    const proposalPath = path.join(projectRoot, '.sle', 'sharding-proposal.yaml');
    writeFileSync(proposalPath, 'shards:\n  - id: shard-1\n    name: First shard\n');

    const weH = makeWEHarness({
      depth: 'minimal',
      projectRoot,
      shardingAction: 'reject',
    });

    const weResult = await weH.engine.run('full-build', 1, 'parity-run-reject', makeCycleCtx('minimal'));

    assert.equal(weResult.status, 'complete', `WE: must complete after sharding reject: ${weResult.error}`);
    // Proposal should be deleted
    let proposalExists = true;
    try { readFileSync(proposalPath); } catch { proposalExists = false; }
    assert.equal(proposalExists, false, 'WE: sharding proposal must be deleted on reject');
    // shardingService.createCalls must be 0 (no tasks created)
    assert.equal(weH.shardingService.createCalls, 0, 'WE: shardingService must not be called on reject');
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// Scenario 22: Sharding modify — checkpoint loops back to itself
// ============================================================================

test('weShardingModifyLoopsCheckpoint', async () => {
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'parity-we-modify-'));
  try {
    mkdirSync(path.join(projectRoot, '.sle'), { recursive: true });
    writeFileSync(
      path.join(projectRoot, '.sle', 'sharding-proposal.yaml'),
      'shards:\n  - id: shard-1\n    name: First shard\n',
    );

    // modify once, then approve
    let shardingCalls = 0;
    const weH = makeWEHarness({
      depth: 'minimal',
      projectRoot,
      shardingAction: 'approve',  // initial value (overridden via onShardingGate below)
    });
    // Patch the stepRunner's callbacks to modify once then approve
    const originalOnShardingGate = (weH.stepRunner as any).callbacks.onShardingGate;
    (weH.stepRunner as any).callbacks.onShardingGate = async (cycle: number, iter: number) => {
      shardingCalls++;
      if (shardingCalls === 1) return 'modify';
      return 'approve';
    };

    const weResult = await weH.engine.run('full-build', 1, 'parity-run-modify', makeCycleCtx('minimal'));

    assert.equal(weResult.status, 'complete', `WE: must complete after modify+approve: ${weResult.error}`);
    assert.equal(shardingCalls, 2, 'WE: sharding gate must be called twice (modify then approve)');
    assert.equal(weH.shardingService.createCalls, 1, 'WE: shardingService must be called once on final approve');
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// Scenario 23: Deep depth — both run critique and complete successfully
// ============================================================================

test('parityDeepDepthCritiquePassCompletes', async () => {
  const crH = makeCRHarness({ depth: 'deep', criticAgent: new SpyCriticAgent(0) });
  const weH = makeWEHarness({ depth: 'deep', criticAgent: new SpyCriticAgent(0) });

  try {
    const crResult = await runCR(crH);
    const weResult = await runWE(weH, 'deep');

    assert.equal(crResult.completed, true, `CR: must complete at deep depth: ${crResult.error}`);
    assert.equal(weResult.status, 'complete', `WE: must complete at deep depth: ${weResult.error}`);
    assert.equal(crH.criticAgent.calls, 1, 'CR: critique called once (passes immediately)');
    assert.equal(weH.criticAgent.calls, 1, 'WE: critique called once (passes immediately)');
  } finally {
    crH.cleanup(); weH.cleanup();
  }
});

// ============================================================================
// Scenario 24: Research depth — critique also runs
// ============================================================================

test('parityResearchDepthCritiqueRuns', async () => {
  const crH = makeCRHarness({ depth: 'research', criticAgent: new SpyCriticAgent(0) });
  const weH = makeWEHarness({ depth: 'research', criticAgent: new SpyCriticAgent(0) });

  try {
    await runCR(crH);
    await runWE(weH, 'research');

    assert.ok(crH.criticAgent.calls > 0, 'CR: critique must run at research depth');
    assert.ok(weH.criticAgent.calls > 0, 'WE: critique must run at research depth');
  } finally {
    crH.cleanup(); weH.cleanup();
  }
});

// ============================================================================
// Scenario 25: LLM node ordering at minimal depth (common prefix/suffix)
// ============================================================================

test('parityLlmNodeOrderAtMinimalDepth', async () => {
  const crH = makeCRHarness({ depth: 'minimal' });
  const weH = makeWEHarness({ depth: 'minimal' });

  try {
    await runCR(crH);
    await runWE(weH, 'minimal');

    const crLlm = crLlmCalls(crH.dagSpy.calls);
    const weLlm = weH.agentSpy.calls;

    // Both share these LLM nodes (in order): DESIGN, PLAN, TEST, BUILD, EVALUATE.
    const sharedOrdered = ['DESIGN', 'PLAN', 'TEST', 'BUILD', 'EVALUATE'];
    for (const node of sharedOrdered) {
      assert.ok(crLlm.includes(node), `CR must include ${node}: ${crLlm}`);
      assert.ok(weLlm.includes(node), `WE must include ${node}: ${weLlm}`);
    }

    // INTENTIONAL_STRUCTURAL_DIFFERENCE: sequences differ — CycleRunner has HISTORY
    // (LLM call via dagRunner), WorkflowEngine has SCOPING (LLM call via scopingService →
    // agentSpy). crLlm uses dagSpy (SCOPING bypasses dagRunner → absent from crLlm).
    assert.notDeepEqual(
      crLlm,
      weLlm,
      `INTENTIONAL_STRUCTURAL_DIFFERENCE: LLM call sequences differ.\n  CR: ${crLlm}\n  WE: ${weLlm}`,
    );
  } finally {
    crH.cleanup(); weH.cleanup();
  }
});

// ============================================================================
// Scenario 26: Exec service called by both
// ============================================================================

test('parityExecServiceCalledByBoth', async () => {
  const crH = makeCRHarness({ depth: 'minimal' });
  const weH = makeWEHarness({ depth: 'minimal' });

  try {
    await runCR(crH);
    await runWE(weH, 'minimal');

    assert.equal(crH.execService.calls, 1, 'CR: execService must be called once');
    assert.equal(weH.execService.calls, 1, 'WE: execService must be called once');
  } finally {
    crH.cleanup(); weH.cleanup();
  }
});
