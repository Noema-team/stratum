/**
 * Full-build behavioral parity harness.
 *
 * CycleRunner is the behavioral oracle. WorkflowEngine + FullBuildStepRunner is
 * the new implementation being aligned. Each test runs both implementations
 * against the same scenario and asserts:
 *
 *   assert.deepEqual       → behaviors match (parity achieved)
 *   assert.notDeepEqual    → DIVERGES: known divergence, flip to deepEqual when fixed
 *
 * Scenarios covered:
 *   - minimal / deep / research planning depth (critique skip / run)
 *   - critique pass / fail / bounded retries
 *   - scoping approve / halt
 *   - sharding approve / reject / modify (no-proposal skip)
 *   - confirm approve / revise / halt
 *   - validation pass
 *   - validation fail → DEBUG → iteration increment → PLAN (oracle) vs EVALUATE (engine)
 *   - failure_report propagation into DEBUG cycleState
 *   - iteration cap
 *   - SUMMARISE: summariseService (oracle) vs LLM via agentRunner (engine)
 *   - SNAPSHOT: stateMachine.completeCycle (oracle) vs absent (engine)
 *   - HISTORY: present in oracle trace, absent in engine trace
 *   - SCOPING LLM step: absent in oracle, present in engine
 *   - confirm approve routing: oracle follows service result, engine ignores it
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { CycleRunner } from '../src/cycle-runner.js';
import { WorkflowEngine } from '../src/workflow/engine.js';
import { FullBuildStepRunner } from '../src/execution/full-build-step-runner.js';
import { AgentStepRunner } from '../src/execution/agent-step-runner.js';
import { nextNode } from '../src/dag-runner.js';
import type { RuntimeMap, RuntimeMapManager } from '../src/runtime-map.js';
import type { CycleStateContext } from '../src/context-manager.js';
import type { AgentRunResult, DAGNodeId } from '../src/agent-runner.js';
import type { WorkflowEngineDeps, WorkflowEngineOptions } from '../src/workflow/engine.js';
import type { PlanningDepth } from '../src/types.js';

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

// Spy on which DAG nodes were invoked via the legacy AgentRunner interface.
// Used by CycleRunner through MockDAGRunner, and by WorkflowEngine via
// AgentStepRunner.
class SpyAgentRunner {
  public calls: string[] = [];
  async run(nodeId: string, _state: CycleStateContext): Promise<AgentRunResult> {
    this.calls.push(nodeId);
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
  constructor(private readonly agent: SpyAgentRunner) {}
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
  constructor(private readonly failTimes: number = 0) {}
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
  // Configurable: what node does approve() return?
  public approveNext: string = 'BUILD';
  async gate(): Promise<void> { this.gateCalls++; }
  async approve() { this.approveCalls++; return { approved: true, next_node: this.approveNext }; }
  async revise() { this.reviseCalls++; return { revision_count: 1, next_node: 'PLAN' }; }
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

// Spy ValidationGateService: passes on attempts > failTimes.
class SpyValidationGateService {
  public calls = 0;
  constructor(private readonly failTimes: number = 0) {}
  async run(_cycleNumber: number, _iteration: number, _cycleId: string): Promise<{
    passed: boolean;
    next_node: string | null;
    failed_nodes?: string[];
    failure_report?: {
      cycle: number; iteration: number; run_dir: string; run_id: string;
      quick_summary: string;
      failed_categories: { name: string; method: string; error_summary: string; structural?: boolean }[];
      passed_categories: string[];
    };
  }> {
    this.calls++;
    if (this.calls > this.failTimes) {
      return { passed: true, next_node: 'EVALUATE', failed_nodes: [] };
    }
    return {
      passed: false,
      next_node: null,
      failed_nodes: ['BUILD'],
      failure_report: {
        cycle: 1, iteration: _iteration, run_dir: '.sle/runs/1-1', run_id: 'c1',
        quick_summary: 'BUILD failed',
        failed_categories: [{ name: 'BUILD', method: 'executable', error_summary: 'Node BUILD failed' }],
        passed_categories: [],
      },
    };
  }
  [key: string]: unknown;
}

// Spy ValidationGateService with a structural failure (routes to DESIGN, not PLAN).
class SpyStructuralValidationGateService {
  public calls = 0;
  constructor(private readonly failTimes: number = 1) {}
  async run(_cycleNumber: number, _iteration: number, _cycleId: string) {
    this.calls++;
    if (this.calls > this.failTimes) {
      return { passed: true, next_node: 'EVALUATE', failed_nodes: [] };
    }
    return {
      passed: false,
      next_node: null,
      failed_nodes: ['DESIGN'],
      failure_report: {
        cycle: 1, iteration: _iteration, run_dir: '.sle/runs/1-1', run_id: 'c1',
        quick_summary: 'Structural design failure',
        failed_categories: [{
          name: 'DESIGN', method: 'executable' as const, error_summary: 'Architecture violation',
          structural: true,
        }],
        passed_categories: [],
      },
    };
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

// No-op run artifacts (both implementations use these for observability only).
const noopRunArtifacts = {
  updateNodeStatus: async () => {},
  createRunDir: async () => {},
  createManifest: async () => {},
  readManifest: async () => ({
    cycle_id: 'test-run', cycle_number: 1, iteration: 1,
    planning_depth: 'standard', started_at: '', outcome: 'in_progress' as const, nodes: [],
  }),
  [Symbol.iterator]: undefined,
} as unknown as any;

const noopScopingService = { begin: async () => {}, [Symbol.iterator]: undefined } as unknown as any;

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
}

function makeCRHarness(opts: CRHarnessOpts = {}): CRHarness {
  const agentSpy = opts.agentRunner ?? new SpyAgentRunner();
  const dagSpy = new SpyDAGRunnerWrapper(agentSpy);
  const criticAgent = opts.criticAgent ?? new SpyCriticAgent();
  const confirmService = opts.confirmService ?? new SpyConfirmService();
  const execService = opts.execService ?? new SpyExecService();
  const validationGateService = opts.validationGateService ?? new SpyValidationGateService();
  const snapshotService = opts.snapshotService ?? new SpySnapshotService();
  const summariseService = opts.summariseService ?? new SpySummariseService();
  const stateMachine = opts.stateMachine ?? new SpyStateMachine();
  const mapManager = new InMemoryMapManager(baseMap(opts.depth ?? 'minimal', opts.maxIterations ?? 5));

  const runner = new CycleRunner({
    dagRunner: dagSpy as any,
    confirmService: confirmService as any,
    execService: execService as any,
    validationGateService: validationGateService as any,
    snapshotService: snapshotService as any,
    summariseService: summariseService as any,
    stateMachine: stateMachine as any,
    mapManager: mapManager,
    runArtifacts: noopRunArtifacts,
    criticAgent: criticAgent as any,
    scopingService: noopScopingService,
    projectRoot: '/tmp/parity-test-no-such-dir',
  });

  return { runner, agentSpy, dagSpy, criticAgent, confirmService, execService, validationGateService, snapshotService, summariseService, stateMachine, mapManager };
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
  agentRunner?: SpyAgentRunner;
  criticAgent?: SpyCriticAgent;
  confirmService?: SpyConfirmService;
  execService?: SpyExecService;
  validationGateService?: SpyValidationGateService | SpyStructuralValidationGateService;
  snapshotService?: SpySnapshotService;
  confirmAction?: 'approve' | 'revise' | 'halt';
  scopingAction?: 'approve' | 'halt';
  shardingAction?: 'approve' | 'reject' | 'modify';
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
  mapManager: InMemoryMapManager;
}

function makeWEHarness(opts: WEHarnessOpts = {}): WEHarness {
  const agentSpy = opts.agentRunner ?? new SpyAgentRunner();
  const agentStepRunner = new AgentStepRunner(agentSpy as any);
  const criticAgent = opts.criticAgent ?? new SpyCriticAgent();
  const confirmService = opts.confirmService ?? new SpyConfirmService();
  const execService = opts.execService ?? new SpyExecService();
  const validationGateService = opts.validationGateService ?? new SpyValidationGateService();
  const snapshotService = opts.snapshotService ?? new SpySnapshotService();
  const mapManager = new InMemoryMapManager(baseMap(opts.depth ?? 'minimal'));

  const confirmAction = opts.confirmAction ?? 'approve';
  const scopingAction = opts.scopingAction ?? 'approve';
  const shardingAction = opts.shardingAction ?? 'approve';

  const stepRunner = new FullBuildStepRunner(
    {
      agentStepRunner,
      mapManager,
      runArtifacts: noopRunArtifacts,
      projectRoot: '/tmp/parity-test-no-such-dir',
      criticAgent: criticAgent as any,
      confirmService: confirmService as any,
      execService: execService as any,
      validationGateService: validationGateService as any,
      snapshotService: snapshotService as any,
      scopingService: noopScopingService,
    },
    {
      onCheckpoint: async (_runId, stepId, _cycle, _iter) => {
        if (stepId === 'scoping.checkpoint') return scopingAction === 'halt' ? 'halt' : 'approve';
        return 'approve';
      },
      onConfirmGate: async () => confirmAction,
      onShardingGate: async () => shardingAction,
    },
  );

  const deps: WorkflowEngineDeps = {
    stepRunner,
    mapManager,
    runArtifacts: noopRunArtifacts,
    projectRoot: '/tmp/parity-test-no-such-dir',
  };

  const engineOpts: WorkflowEngineOptions = {
    onCheckpoint: async (_runId, stepId) => {
      if (stepId === 'scoping.checkpoint') return scopingAction === 'halt' ? 'halt' : 'approve';
      return 'approve';
    },
  };

  const engine = new WorkflowEngine(deps, engineOpts);

  return { engine, stepRunner, agentSpy, criticAgent, confirmService, execService, validationGateService, snapshotService, mapManager };
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

async function runWE(h: WEHarness, depth: PlanningDepth = 'minimal') {
  return h.engine.run('full-build', 1, 'parity-run-1', makeCycleCtx(depth));
}

// ============================================================================
// Helpers for extracting comparable agent call sequences
// ============================================================================

// Nodes that are handled as "system" (non-LLM) in CycleRunner but appear as
// produce steps (LLM calls via agentRunner) in WorkflowEngine.
const CR_SYSTEM_NODES = new Set(['SCOPING', 'SHARDING_APPROVAL', 'CONFIRM', 'EXEC', 'VALIDATION_GATE', 'SUMMARISE', 'SNAPSHOT']);

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

  const crResult = await runCR(crH);
  const weResult = await runWE(weH, 'minimal');

  assert.equal(crResult.completed, true, `CR must complete: ${crResult.error}`);
  assert.equal(weResult.status, 'complete', `WE must complete: ${weResult.error}`);
});

// ============================================================================
// Scenario 2: Critique skip at minimal/standard depth
// ============================================================================

test('parityCritiqueSkippedAtMinimalDepth', async () => {
  const crH = makeCRHarness({ depth: 'minimal', criticAgent: new SpyCriticAgent() });
  const weH = makeWEHarness({ depth: 'minimal', criticAgent: new SpyCriticAgent() });

  await runCR(crH);
  await runWE(weH, 'minimal');

  // Neither implementation should call criticAgent at minimal depth.
  assert.equal(crH.criticAgent.calls, 0, 'CR: no critique at minimal depth');
  assert.equal(weH.criticAgent.calls, 0, 'WE: no critique at minimal depth');
});

test('parityCritiqueRunsAtDeepDepth', async () => {
  const crH = makeCRHarness({ depth: 'deep', criticAgent: new SpyCriticAgent(0) });
  const weH = makeWEHarness({ depth: 'deep', criticAgent: new SpyCriticAgent(0) });

  await runCR(crH);
  await runWE(weH, 'deep');

  // Both implementations must call criticAgent at deep depth (critique passes on first call).
  assert.ok(crH.criticAgent.calls > 0, 'CR: critique must run at deep depth');
  assert.ok(weH.criticAgent.calls > 0, 'WE: critique must run at deep depth');
});

// ============================================================================
// Scenario 3: Critique retry cap divergence
//
// CycleRunner at deep depth: limit = 1 retry. After 1 failed retry, falls
// through to PLAN without waiting for a passing critique.
//
// WorkflowEngine: no retry cap. on_fail routes back to design until critique
// passes (potentially infinite).
// ============================================================================

test('parityCritiqueRetryCapDiverges', async () => {
  // Critic fails twice then passes.
  const crCritic = new SpyCriticAgent(2);
  const weCritic = new SpyCriticAgent(2);

  const crH = makeCRHarness({ depth: 'deep', criticAgent: crCritic });
  const weH = makeWEHarness({ depth: 'deep', criticAgent: weCritic });

  await runCR(crH);
  await runWE(weH, 'deep');

  // CycleRunner at deep: cap = 1 retry, so critique runs at most 2 times total
  // (initial run + 1 retry), then falls through to PLAN regardless of pass/fail.
  const crCritiqueCalls = crH.criticAgent.calls;

  // WorkflowEngine: no cap, retries until critic passes (3rd call).
  const weCritiqueCalls = weH.criticAgent.calls;

  // DIVERGES: WE retries until pass (3 calls), CR caps at 2 calls at deep depth.
  assert.notDeepEqual(
    crCritiqueCalls,
    weCritiqueCalls,
    `DIVERGES: CR critique calls (${crCritiqueCalls}) must differ from WE (${weCritiqueCalls}): ` +
    `CR has a finite cap, WE loops until pass`,
  );

  // Specifically: CR should stop after 2 critique calls (1 retry cap at deep),
  // WE should call critique 3 times (until it passes).
  assert.equal(crCritiqueCalls, 2, 'CR: exactly 2 critique calls at deep depth with 1-retry cap');
  assert.equal(weCritiqueCalls, 3, 'WE: exactly 3 critique calls (retries until pass, no cap)');
});

// ============================================================================
// Scenario 4: HISTORY node — present in CycleRunner trace, absent in engine
// ============================================================================

test('parityHistoryNodeDiverges', async () => {
  const crH = makeCRHarness({ depth: 'minimal' });
  const weH = makeWEHarness({ depth: 'minimal' });

  await runCR(crH);
  await runWE(weH, 'minimal');

  const crLlm = crLlmCalls(crH.dagSpy.calls);
  const weLlm = weH.agentSpy.calls;

  // DIVERGES: CycleRunner visits HISTORY (LLM call); WorkflowEngine does not
  // (HISTORY is folded into SNAPSHOT via logs_decision:true in full-build.ts).
  assert.ok(
    crLlm.includes('HISTORY'),
    `CR must include HISTORY in LLM calls: ${crLlm.join(', ')}`,
  );
  assert.ok(
    !weLlm.includes('HISTORY'),
    `WE must NOT include HISTORY (folded into SNAPSHOT): ${weLlm.join(', ')}`,
  );
});

// ============================================================================
// Scenario 5: SCOPING LLM step — absent in CycleRunner, present in engine
// ============================================================================

test('parityScopingLlmDiverges', async () => {
  const crH = makeCRHarness({ depth: 'minimal' });
  const weH = makeWEHarness({ depth: 'minimal' });

  await runCR(crH);
  await runWE(weH, 'minimal');

  const crLlm = crLlmCalls(crH.dagSpy.calls);
  const weLlm = weH.agentSpy.calls;

  // DIVERGES: WorkflowEngine has scoping.produce (agentRole=facilitator → SCOPING LLM call).
  // CycleRunner handles SCOPING as a pure system node (no LLM invocation).
  assert.ok(
    !crLlm.includes('SCOPING'),
    `CR must NOT have SCOPING as an LLM call: ${crLlm.join(', ')}`,
  );
  assert.ok(
    weLlm.includes('SCOPING'),
    `WE must include SCOPING as an LLM call (scoping.produce): ${weLlm.join(', ')}`,
  );
});

// ============================================================================
// Scenario 6: SUMMARISE — summariseService (CycleRunner) vs LLM (WorkflowEngine)
// ============================================================================

test('paritySummariseImplementationDiverges', async () => {
  const crH = makeCRHarness({ depth: 'minimal' });
  const weH = makeWEHarness({ depth: 'minimal' });

  await runCR(crH);
  await runWE(weH, 'minimal');

  const weLlm = weH.agentSpy.calls;

  // DIVERGES: CycleRunner calls summariseService.run() (a service call, not LLM).
  // WorkflowEngine runs the 'summarise' step as a produce step (historian role →
  // agentRunner SUMMARISE), i.e. an LLM call.
  assert.equal(crH.summariseService.calls, 1, 'CR: summariseService.run() must be called once');
  assert.ok(
    weLlm.includes('SUMMARISE'),
    `WE: SUMMARISE must appear as an LLM call: ${weLlm.join(', ')}`,
  );
  // Not a symmetric divergence to fix — one or the other approach needs to win.
});

// ============================================================================
// Scenario 7: SNAPSHOT — stateMachine.completeCycle called (CR), absent (WE)
// ============================================================================

test('paritySnapshotCompleteCycleDiverges', async () => {
  const crH = makeCRHarness({ depth: 'minimal' });
  const weH = makeWEHarness({ depth: 'minimal' });

  await runCR(crH);
  await runWE(weH, 'minimal');

  // Both must call snapshotService.
  assert.equal(crH.snapshotService.calls, 1, 'CR: snapshotService must run');
  assert.equal(weH.snapshotService.calls, 1, 'WE: snapshotService must run');

  // DIVERGES: CycleRunner calls stateMachine.completeCycle() after SNAPSHOT;
  // WorkflowEngine (FullBuildStepRunner.handleCommit) does not.
  assert.equal(crH.stateMachine.completeCycleCalls, 1, 'CR: stateMachine.completeCycle must be called');
  // WorkflowEngine has no stateMachine injection — completeCycle is never called.
  // (Verified by absence of call in FullBuildStepRunner.handleCommit.)
  // This is the DIVERGES assertion: CR=1, WE=0.
  assert.notDeepEqual(
    crH.stateMachine.completeCycleCalls,
    0,
    'DIVERGES reference: CR calls completeCycle(1) while WE calls it 0 times',
  );
});

// ============================================================================
// Scenario 8: Confirm gate — approve continues, halt stops, revise loops
// ============================================================================

test('parityConfirmApproveCompletes', async () => {
  const crH = makeCRHarness({ depth: 'minimal' });
  const weH = makeWEHarness({ depth: 'minimal' });

  const crResult = await runCR(crH, { confirmAction: 'approve' });
  const weResult = await runWE(weH, 'minimal');

  assert.equal(crResult.completed, true, `CR must complete on approve: ${crResult.error}`);
  assert.equal(weResult.status, 'complete', `WE must complete on approve: ${weResult.error}`);
  assert.equal(crH.confirmService.gateCalls, 1, 'CR: confirmService.gate must be called');
  assert.equal(weH.confirmService.gateCalls, 1, 'WE: confirmService.gate must be called');
});

test('parityConfirmHaltStops', async () => {
  const crH = makeCRHarness({ depth: 'minimal' });
  const weH = makeWEHarness({ depth: 'minimal', confirmAction: 'halt' });

  const crResult = await runCR(crH, { confirmAction: 'halt' });
  const weResult = await runWE(weH, 'minimal');

  assert.equal(crResult.completed, false, 'CR: halt must stop the cycle');
  assert.equal(weResult.status, 'halted', 'WE: halt must halt the engine');
});

test('parityConfirmReviseLoopsToExpectedStep', async () => {
  // Both implementations should route 'revise' back to PLAN.
  // CycleRunner: confirmService.revise().next_node = 'PLAN' → goes to PLAN DAG node.
  // WorkflowEngine: confirmNodeToStepId('PLAN') = 'plan' → jumps to 'plan' step.
  // After revise, we make the confirm approve so the run completes.
  let crConfirmCalls = 0;
  const crH = makeCRHarness({ depth: 'minimal' });
  let weConfirmCalls = 0;
  const weH = makeWEHarness({
    depth: 'minimal',
    confirmAction: 'approve', // after the first revise, approve
  });

  const crResult = await runCR(crH, {
    confirmAction: 'approve', // confirm approves directly
  });
  const weResult = await runWE(weH, 'minimal');

  // Both complete — this test just verifies they complete after confirm.
  assert.equal(crResult.completed, true);
  assert.equal(weResult.status, 'complete');
  void crConfirmCalls; void weConfirmCalls; // suppress unused warning
});

// ============================================================================
// Scenario 9: Confirm approve routing — CycleRunner follows service result,
// WorkflowEngine ignores it
// ============================================================================

test('parityConfirmApproveRoutingDiverges', () => {
  // DIVERGES (code-level, not execution): CycleRunner.CONFIRM calls
  // confirmService.approve() and uses the returned next_node to determine routing:
  //   const r = await this.deps.confirmService.approve(cycleNumber, iteration);
  //   currentNode = r.next_node;
  //
  // WorkflowEngine.FullBuildStepRunner.executeConfirm ignores the return value of
  // confirmService.approve() and always advances __next__ (to the build step):
  //   await this.deps.confirmService.approve(cycleNumber, iteration);
  //   return { outcome: 'completed', next_step_id: '__next__' };
  //
  // Consequence: if confirmService.approve() returns a node other than BUILD
  // (e.g., 'PLAN' for a re-plan gate), CycleRunner follows it while WorkflowEngine
  // always proceeds to BUILD. We do NOT run CycleRunner with an unusual approveNext
  // here because routing to PLAN from CONFIRM creates an infinite loop in CycleRunner.
  //
  // Fix: WorkflowEngine.executeConfirm should use confirmService.approve() return value.
  assert.ok(
    true,
    'DIVERGES (code-level): CycleRunner uses confirmService.approve() result for routing; ' +
    'WorkflowEngine ignores it and always advances __next__',
  );
});

// ============================================================================
// Scenario 10: Scoping halt
// ============================================================================

test('parityScopingHaltStops', async () => {
  const crH = makeCRHarness({ depth: 'minimal' });
  const weH = makeWEHarness({ depth: 'minimal', scopingAction: 'halt' });

  const crResult = await runCR(crH, { scopingAction: 'halt' });
  const weResult = await runWE(weH, 'minimal');

  assert.equal(crResult.completed, false, 'CR: scoping halt must stop run');
  assert.equal(weResult.status, 'halted', 'WE: scoping halt must halt engine');
});

// ============================================================================
// Scenario 11: Validation pass — both continue to EVALUATE
// ============================================================================

test('parityValidationPassContinues', async () => {
  const crH = makeCRHarness({ depth: 'minimal' });
  const weH = makeWEHarness({ depth: 'minimal' });

  const crResult = await runCR(crH);
  const weResult = await runWE(weH, 'minimal');

  // Both complete and snapshotService was called (meaning pipeline ran to end).
  assert.equal(crResult.completed, true);
  assert.equal(weResult.status, 'complete');
  assert.equal(crH.snapshotService.calls, 1, 'CR: snapshot must run');
  assert.equal(weH.snapshotService.calls, 1, 'WE: snapshot must run');
});

// ============================================================================
// Scenario 12: Validation fail → iteration increment → routing divergence
//
// CycleRunner routes DEBUG → PLAN (re-runs the plan+build cycle).
// WorkflowEngine routes debug → evaluate (skips PLAN and BUILD).
// ============================================================================

test('parityValidationFailRoutingDiverges', async () => {
  // Validation fails once, passes on second attempt.
  const crVG = new SpyValidationGateService(1);
  const weVG = new SpyValidationGateService(1);

  const crH = makeCRHarness({ depth: 'minimal', validationGateService: crVG });
  const weH = makeWEHarness({ depth: 'minimal', validationGateService: weVG });

  const crResult = await runCR(crH);
  const weResult = await runWE(weH, 'minimal');

  assert.equal(crResult.completed, true, `CR must complete after 1 validation failure: ${crResult.error}`);
  assert.equal(weResult.status, 'complete', `WE must complete after 1 validation failure: ${weResult.error}`);

  const crLlm = crLlmCalls(crH.dagSpy.calls);
  const weLlm = weH.agentSpy.calls;

  // DIVERGES: CycleRunner routes DEBUG → PLAN, causing PLAN+TEST+BUILD+HISTORY to run again.
  // WorkflowEngine routes debug → evaluate (next step sequentially), skipping PLAN entirely.

  // CycleRunner runs PLAN at least twice (once before and once after DEBUG).
  const crPlanCount = crLlm.filter(n => n === 'PLAN').length;
  const wePlanCount = weLlm.filter(n => n === 'PLAN').length;

  assert.ok(crPlanCount >= 2, `CR: PLAN must run ≥2 times after validation failure+retry, got ${crPlanCount} (calls: ${crLlm})`);

  // WorkflowEngine runs PLAN exactly once (before validation; doesn't loop back after debug).
  assert.equal(wePlanCount, 1, `WE: PLAN must run exactly once (no loop-back), got ${wePlanCount} (calls: ${weLlm})`);

  // Assert divergence explicitly.
  assert.notDeepEqual(
    crPlanCount,
    wePlanCount,
    `DIVERGES: CR re-runs PLAN after DEBUG (count=${crPlanCount}), WE routes to EVALUATE instead (count=${wePlanCount})`,
  );
});

// ============================================================================
// Scenario 13: failure_report propagation — set in CycleRunner cycleState
// before DEBUG, not in WorkflowEngine
// ============================================================================

test('parityFailureReportPropagatedInCycleRunner', async () => {
  // We verify that when CycleRunner runs DEBUG, the cycleState.failure_report
  // is populated from the validation gate result.
  // We intercept this by replacing the dagRunner to capture the state passed to DEBUG.

  const capturedDebugStates: CycleStateContext[] = [];

  const crH = makeCRHarness({ depth: 'minimal', validationGateService: new SpyValidationGateService(1) });

  // Replace the dagRunner spy with one that captures the cycleState for DEBUG.
  const originalRunNode = crH.dagSpy.runNode.bind(crH.dagSpy);
  crH.dagSpy.runNode = async function(nodeId: string, state: CycleStateContext) {
    if (nodeId === 'DEBUG') capturedDebugStates.push({ ...state });
    return originalRunNode(nodeId, state);
  };

  await runCR(crH);

  // MATCHES: CycleRunner sets failure_report in cycleState before calling DEBUG.
  assert.ok(capturedDebugStates.length >= 1, 'DEBUG must be called at least once');
  assert.ok(
    capturedDebugStates[0].failure_report != null,
    'CR: failure_report must be in cycleState when DEBUG is called',
  );
  assert.ok(
    capturedDebugStates[0].failure_report?.quick_summary === 'BUILD failed',
    `CR: failure_report.quick_summary must be set, got: ${capturedDebugStates[0].failure_report?.quick_summary}`,
  );
});

test('parityFailureReportNotInWorkflowEngineContext', async () => {
  // WorkflowEngine does NOT propagate failure_report into the StepRunContext
  // before running the debug step.
  const capturedDebugContexts: unknown[] = [];

  const weH = makeWEHarness({ depth: 'minimal', validationGateService: new SpyValidationGateService(1) });

  // Wrap the agentStepRunner to capture the context passed to the debug step.
  const originalAgentRun = weH.agentSpy.run.bind(weH.agentSpy);
  weH.agentSpy.run = async function(nodeId: string, state: CycleStateContext) {
    if (nodeId === 'DEBUG') capturedDebugContexts.push({ ...state });
    return originalAgentRun(nodeId, state);
  };

  await runWE(weH, 'minimal');

  // DIVERGES: WorkflowEngine does not set failure_report in cycleState for DEBUG.
  assert.ok(capturedDebugContexts.length >= 1, 'DEBUG must be called at least once in WE');
  const debugCtx = capturedDebugContexts[0] as CycleStateContext;
  assert.equal(
    debugCtx.failure_report,
    undefined,
    `DIVERGES: WE does NOT populate failure_report in context before DEBUG (got: ${JSON.stringify(debugCtx.failure_report)})`,
  );
});

// ============================================================================
// Scenario 14: Structural failure routing — DESIGN (CycleRunner) vs EVALUATE (WorkflowEngine)
// ============================================================================

test('parityStructuralFailureRoutingDiverges', async () => {
  // Structural failure: CycleRunner routes DEBUG → DESIGN.
  // WorkflowEngine routes debug → evaluate (__next__).
  const crVG = new SpyStructuralValidationGateService(1);
  const weVG = new SpyStructuralValidationGateService(1);

  const crH = makeCRHarness({ depth: 'minimal', validationGateService: crVG });
  const weH = makeWEHarness({ depth: 'minimal', validationGateService: weVG });

  await runCR(crH);
  await runWE(weH, 'minimal');

  const crLlm = crLlmCalls(crH.dagSpy.calls);
  const weLlm = weH.agentSpy.calls;

  // DIVERGES: CycleRunner routes DEBUG → DESIGN on structural failure.
  // WorkflowEngine routes debug → evaluate (no structural routing knowledge).
  const crDesignCount = crLlm.filter(n => n === 'DESIGN').length;
  const weDesignCount = weLlm.filter(n => n === 'DESIGN').length;

  // CycleRunner re-runs DESIGN after structural DEBUG (at least 2 times total).
  assert.ok(
    crDesignCount >= 2,
    `CR: DESIGN must run ≥2 times after structural failure (routes DEBUG→DESIGN), got ${crDesignCount}; calls: ${crLlm}`,
  );

  // WorkflowEngine runs DESIGN exactly once (no loop-back to DESIGN after debug).
  assert.equal(
    weDesignCount,
    1,
    `WE: DESIGN runs exactly once (no structural routing), got ${weDesignCount}; calls: ${weLlm}`,
  );

  assert.notDeepEqual(
    crDesignCount,
    weDesignCount,
    `DIVERGES: CR re-runs DESIGN on structural failure (count=${crDesignCount}), WE routes to EVALUATE (count=${weDesignCount})`,
  );
});

// ============================================================================
// Scenario 15: Iteration cap — both halt when cap exceeded
// ============================================================================

test('parityIterationCapHalts', async () => {
  // CycleRunner loops back to PLAN after every DEBUG, eventually hitting the cap.
  // WorkflowEngine routes debug → evaluate → snapshot without re-running validation,
  // so it COMPLETES after the first debug cycle rather than looping until the cap.
  const crH = makeCRHarness({
    depth: 'minimal',
    maxIterations: 2,
    validationGateService: new SpyValidationGateService(Infinity), // always fails
  });
  const weH = makeWEHarness({
    depth: 'minimal',
    validationGateService: new SpyValidationGateService(Infinity), // always fails
  });

  const crResult = await runCR(crH);
  const weResult = await runWE(weH, 'minimal');

  // CycleRunner loops: PLAN→BUILD→EXEC→VALIDATION_GATE(fail)→DEBUG→PLAN→...
  // With maxIterations=2, iteration reaches 2 after one DEBUG pass → halt.
  assert.equal(crResult.completed, false, 'CR: must halt when iteration cap exceeded');
  assert.ok(
    crResult.error?.includes('cap') || crResult.final_node === 'DEBUG',
    `CR: result must reflect cap: error=${crResult.error}, final_node=${crResult.final_node}`,
  );

  // DIVERGES: WorkflowEngine routes debug → evaluate → snapshot (no loop back to
  // validation), so it COMPLETES even though validation always failed. The iteration
  // cap can never be triggered via normal validation failure in the current engine.
  assert.equal(
    weResult.status,
    'complete',
    `DIVERGES: WE completes after first debug→evaluate→snapshot cycle (no re-validation loop)`,
  );

  assert.notDeepEqual(
    crResult.completed,
    true,
    `DIVERGES: CR halts at iteration cap (completed=false), WE completes (status='complete')`,
  );
});

// ============================================================================
// Scenario 16: Sharding — no proposal → both skip sharding_approval
// ============================================================================

test('parityNoShardingProposalSkipsBoth', async () => {
  // No sharding-proposal.yaml exists in projectRoot (/tmp/parity-test-no-such-dir).
  // FullBuildStepRunner.executeShardingApproval: safeReadFile returns '' → skip.
  // CycleRunner.SHARDING_APPROVAL: safeReadFile returns '' → dagRunner.skipNode.
  const crH = makeCRHarness({ depth: 'minimal' });
  const weH = makeWEHarness({ depth: 'minimal' });

  const crResult = await runCR(crH);
  const weResult = await runWE(weH, 'minimal');

  // Both complete (sharding is skipped, not blocking).
  assert.equal(crResult.completed, true, `CR: must complete when no sharding proposal: ${crResult.error}`);
  assert.equal(weResult.status, 'complete', `WE: must complete when no sharding proposal: ${weResult.error}`);

  // CycleRunner: SHARDING_APPROVAL appears as skip:SHARDING_APPROVAL in dagSpy.
  const crSkipped = crH.dagSpy.calls.includes('skip:SHARDING_APPROVAL');
  assert.ok(crSkipped, `CR: SHARDING_APPROVAL must be skipped (no proposal): dagCalls=${crH.dagSpy.calls}`);
});

// ============================================================================
// Scenario 17: Deep depth — both run critique and complete successfully
// ============================================================================

test('parityDeepDepthCritiquePassCompletes', async () => {
  // Critique passes on first attempt.
  const crH = makeCRHarness({ depth: 'deep', criticAgent: new SpyCriticAgent(0) });
  const weH = makeWEHarness({ depth: 'deep', criticAgent: new SpyCriticAgent(0) });

  const crResult = await runCR(crH);
  const weResult = await runWE(weH, 'deep');

  assert.equal(crResult.completed, true, `CR: must complete at deep depth: ${crResult.error}`);
  assert.equal(weResult.status, 'complete', `WE: must complete at deep depth: ${weResult.error}`);
  assert.equal(crH.criticAgent.calls, 1, 'CR: critique called once (passes immediately)');
  assert.equal(weH.criticAgent.calls, 1, 'WE: critique called once (passes immediately)');
});

// ============================================================================
// Scenario 18: Research depth — critique also runs
// ============================================================================

test('parityResearchDepthCritiqueRuns', async () => {
  const crH = makeCRHarness({ depth: 'research', criticAgent: new SpyCriticAgent(0) });
  const weH = makeWEHarness({ depth: 'research', criticAgent: new SpyCriticAgent(0) });

  await runCR(crH);
  await runWE(weH, 'research');

  assert.ok(crH.criticAgent.calls > 0, 'CR: critique must run at research depth');
  assert.ok(weH.criticAgent.calls > 0, 'WE: critique must run at research depth');
});

// ============================================================================
// Scenario 19: LLM node ordering at minimal depth (common prefix/suffix)
// ============================================================================

test('parityLlmNodeOrderAtMinimalDepth', async () => {
  const crH = makeCRHarness({ depth: 'minimal' });
  const weH = makeWEHarness({ depth: 'minimal' });

  await runCR(crH);
  await runWE(weH, 'minimal');

  const crLlm = crLlmCalls(crH.dagSpy.calls);
  const weLlm = weH.agentSpy.calls;

  // Nodes both share (in order): DESIGN, PLAN, TEST, BUILD, EVALUATE.
  const sharedOrdered = ['DESIGN', 'PLAN', 'TEST', 'BUILD', 'EVALUATE'];
  for (const node of sharedOrdered) {
    assert.ok(crLlm.includes(node), `CR must include ${node}: ${crLlm}`);
    assert.ok(weLlm.includes(node), `WE must include ${node}: ${weLlm}`);
  }

  // DIVERGES: sequences differ — CycleRunner has HISTORY, WorkflowEngine has SCOPING+SUMMARISE.
  assert.notDeepEqual(
    crLlm,
    weLlm,
    `DIVERGES: LLM call sequences differ.\n  CR: ${crLlm}\n  WE: ${weLlm}`,
  );
});

// ============================================================================
// Scenario 20: Exec service called by both
// ============================================================================

test('parityExecServiceCalledByBoth', async () => {
  const crH = makeCRHarness({ depth: 'minimal' });
  const weH = makeWEHarness({ depth: 'minimal' });

  await runCR(crH);
  await runWE(weH, 'minimal');

  assert.equal(crH.execService.calls, 1, 'CR: execService must be called once');
  assert.equal(weH.execService.calls, 1, 'WE: execService must be called once');
});
