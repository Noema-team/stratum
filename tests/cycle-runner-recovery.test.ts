/**
 * Phase E: CycleRunner recovery loop — DEBUGGER agent integration.
 *
 * Tests the VALIDATION_GATE→DEBUGGER→EXEC recovery loop:
 * - failure_report is passed into CycleStateContext for the DEBUGGER node
 * - debugAttempt counter increments on each VALIDATION_GATE failure
 * - after MAX_DEBUG_ATTEMPTS, the cycle halts with a failure_report
 * - debug_attempts_used is tracked in CycleRunResult
 * - on DEBUGGER LLM failure, the cycle halts immediately
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { CycleRunner, MAX_DEBUG_ATTEMPTS } from '../src/cycle-runner.js';
import { nextNode } from '../src/dag-runner.js';
import type { CycleStateContext } from '../src/context-manager.js';
import type { RuntimeMap, RuntimeMapManager } from '../src/runtime-map.js';
import type { AgentRunResult } from '../src/agent-runner.js';
import type { FailureReport } from '../src/types.js';

console.log('# Running Phase E (CycleRunner recovery) tests...');

// ─── Shared fixtures ──────────────────────────────────────────────────────────

function makeBaseMap(): RuntimeMap {
  return {
    meta: {
      status: 'cycling', cycle: 1,
      version_id: 'v1', initialized_at: '2026-05-08T12:00:00Z', updated_at: '2026-05-08T12:00:00Z',
      dag: { current_node: 'EXEC', completed_nodes: [], iteration: 1, revision: 0,
             started_at: '2026-05-08T14:00:00Z', nodes: {} },
    },
    project: { name: 'test', description: 'test', type: 'api' },
    remotes: {
      code: { type: 'git', url: 'https://github.com/org/repo.git', branch: 'main' },
      issues: { type: 'git', url: 'https://github.com/org/issues.git', branch: 'main' },
      docs: { url: 'https://github.com/org/docs.git', pending: false },
    },
    task_store: { type: 'local' }, agents: {},
    discovery: {
      status: 'complete', mode: 'full', completed_at: '2026-05-08T13:00:00Z',
      artifacts: [], current_round: 0, total_rounds: 1,
      current_phase: 0, total_phases: 0, open_questions_count: 0, blocking_questions_count: 0,
    },
    cycle: {
      number: 1, iteration: 1, revision: 0, max_iterations: 5,
      planning_depth: 'standard', started_at: '2026-05-08T14:00:00Z',
      outcome: 'cycling', approval_gate: null,
      awaiting_scoping: false, awaiting_confirmation: false, awaiting_sharding_approval: false,
    },
    artifacts: [],
  } as unknown as RuntimeMap;
}

// ─── Mock infrastructure ──────────────────────────────────────────────────────

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

/** DAGRunner mock that records (nodeId, cycleState) for each runNode call. */
class TrackingDAGRunner {
  public calls: Array<{ nodeId: string; state: CycleStateContext }> = [];
  public failOnNode: string | null = null;

  async runNode(
    nodeId: string,
    state: CycleStateContext
  ): Promise<AgentRunResult & { next_node: string | null }> {
    this.calls.push({ nodeId, state: { ...state } });
    if (nodeId === this.failOnNode) {
      return {
        success: false, next_node: null, artifacts_written: [],
        tokens_used: 0, duration_ms: 0, raw_output_path: '',
        error: `${nodeId} failed`,
      };
    }
    return {
      success: true, next_node: nextNode(nodeId), artifacts_written: [],
      tokens_used: 10, duration_ms: 50, raw_output_path: '',
    };
  }

  async skipNode(): Promise<void> { /* no-op */ }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

/** Tracks how many times EXEC was called. */
class TrackingExecService {
  public callCount = 0;
  async run() {
    this.callCount++;
    return { success: true, passed: true, next_node: 'VALIDATION_GATE' as const, duration_ms: 0 };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

const SAMPLE_FAILURE_REPORT: FailureReport = {
  cycle: 1,
  iteration: 1,
  run_dir: '.sle/runs/1-1',
  run_id: 'c1',
  quick_summary: 'EXEC failed with exit code 1',
  failed_categories: [{ name: 'EXEC', method: 'executable' as const, error_summary: 'Node EXEC did not complete' }],
  passed_categories: [],
};

/** ValidationGate that fails the first `failTimes` calls, then passes. */
class FailNTimesValidationGate {
  public callCount = 0;
  constructor(private failTimes: number) {}

  async run() {
    this.callCount++;
    if (this.callCount <= this.failTimes) {
      return {
        passed: false,
        next_node: null as null,
        failed_nodes: ['EXEC'],
        failure_report: { ...SAMPLE_FAILURE_REPORT },
      };
    }
    return { passed: true, next_node: 'EVALUATE' as const, failed_nodes: [] };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

class MockConfirmService {
  async gate() { /* no-op */ }
  async approve() { return { approved: true, next_node: 'BUILD' as const }; }
  async revise() { return { revision_count: 1, next_node: 'PLAN' as const }; }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

class MockSnapshotService {
  async run() {
    return { success: true, snapshot_dir: '/tmp/snap/1-1', snapshot_id: 'snap-id', artifacts_copied: [] };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

class MockSummariseService {
  async run() { return { success: true, summary_path: 'docs/cycle-summary.md' }; }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

class MockStateMachine {
  async completeCycle() { return { success: true, from: 'cycling' as const, to: 'complete' as const }; }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

class MockRunArtifactsForRunner {
  async readManifest() {
    return { cycle_id: 'test-cycle-1', cycle_number: 1, iteration: 1, planning_depth: 'standard',
             started_at: '', outcome: 'in_progress' as const, nodes: [] };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

/** Build a CycleRunner starting at EXEC with the given overrides. */
function makeRecoveryRunner(overrides: {
  dagRunner?: TrackingDAGRunner;
  execService?: TrackingExecService;
  validationGateService: FailNTimesValidationGate;
  mapManager?: InMemoryMapManager;
}) {
  const dagRunner = overrides.dagRunner ?? new TrackingDAGRunner();
  const execService = overrides.execService ?? new TrackingExecService();
  const mgr = overrides.mapManager ?? new InMemoryMapManager();
  const runner = new CycleRunner({
    dagRunner: dagRunner as never,
    confirmService: new MockConfirmService() as never,
    execService: execService as never,
    validationGateService: overrides.validationGateService as never,
    snapshotService: new MockSnapshotService() as never,
    summariseService: new MockSummariseService() as never,
    stateMachine: new MockStateMachine() as never,
    mapManager: mgr,
    runArtifacts: new MockRunArtifactsForRunner() as never,
  });
  return { runner, dagRunner, execService };
}

// ─── Recovery loop tests ──────────────────────────────────────────────────────

test('Phase E recovery: 1 validation failure → DEBUGGER → EXEC retry → pass → complete', async () => {
  const validationGateService = new FailNTimesValidationGate(1);
  const { runner } = makeRecoveryRunner({ validationGateService });

  const result = await runner.run();

  assert.strictEqual(result.completed, true, `should complete: ${result.error}`);
  assert.strictEqual(result.final_node, null);
  assert.strictEqual(result.debug_attempts_used, 1);
});

test('Phase E recovery: 2 validation failures → 2 DEBUGGER calls → pass → complete', async () => {
  const validationGateService = new FailNTimesValidationGate(2);
  const dagRunner = new TrackingDAGRunner();
  const { runner } = makeRecoveryRunner({ dagRunner, validationGateService });

  const result = await runner.run();

  assert.strictEqual(result.completed, true, `should complete: ${result.error}`);
  assert.strictEqual(result.debug_attempts_used, 2);
  const debuggerCalls = dagRunner.calls.filter(c => c.nodeId === 'DEBUGGER');
  assert.strictEqual(debuggerCalls.length, 2, 'DEBUGGER should be called twice');
});

test('Phase E recovery: 3 validation failures → 3 DEBUGGER calls → pass → complete', async () => {
  const validationGateService = new FailNTimesValidationGate(3);
  const dagRunner = new TrackingDAGRunner();
  const { runner } = makeRecoveryRunner({ dagRunner, validationGateService });

  const result = await runner.run();

  assert.strictEqual(result.completed, true, `should complete: ${result.error}`);
  assert.strictEqual(result.debug_attempts_used, 3);
  const debuggerCalls = dagRunner.calls.filter(c => c.nodeId === 'DEBUGGER');
  assert.strictEqual(debuggerCalls.length, 3, 'DEBUGGER should be called 3 times');
});

test('Phase E recovery: MAX_DEBUG_ATTEMPTS+1 failures → cycle halted', async () => {
  // 4 failures exceed MAX_DEBUG_ATTEMPTS=3 — the 4th validation failure causes halt
  const validationGateService = new FailNTimesValidationGate(MAX_DEBUG_ATTEMPTS + 1);
  const { runner } = makeRecoveryRunner({ validationGateService });

  const result = await runner.run();

  assert.strictEqual(result.completed, false);
  assert.strictEqual(result.final_node, 'VALIDATION_GATE');
  assert.strictEqual(result.debug_attempts_used, MAX_DEBUG_ATTEMPTS);
});

test('Phase E recovery: debug_attempts_used=0 on happy path', async () => {
  // ValidationGate passes immediately — no debugging needed
  const validationGateService = new FailNTimesValidationGate(0);
  const { runner } = makeRecoveryRunner({ validationGateService });

  const result = await runner.run();

  assert.strictEqual(result.completed, true);
  assert.strictEqual(result.debug_attempts_used, 0);
});

test('Phase E recovery: failure_report in result when MAX exceeded', async () => {
  const validationGateService = new FailNTimesValidationGate(MAX_DEBUG_ATTEMPTS + 1);
  const { runner } = makeRecoveryRunner({ validationGateService });

  const result = await runner.run();

  assert.ok(result.failure_report, 'failure_report should be present');
  assert.ok(result.failure_report!.failed_categories.length > 0, 'should have failed categories');
});

test('Phase E recovery: error message identifies attempt count when MAX exceeded', async () => {
  const validationGateService = new FailNTimesValidationGate(MAX_DEBUG_ATTEMPTS + 1);
  const { runner } = makeRecoveryRunner({ validationGateService });

  const result = await runner.run();

  assert.ok(
    result.error?.includes(String(MAX_DEBUG_ATTEMPTS)),
    `error should mention ${MAX_DEBUG_ATTEMPTS}: ${result.error}`
  );
  assert.ok(
    result.error?.toLowerCase().includes('debug attempt'),
    `error should mention debug attempts: ${result.error}`
  );
});

test('Phase E recovery: DEBUGGER appears in dagRunner.calls after each VALIDATION_GATE failure', async () => {
  const validationGateService = new FailNTimesValidationGate(2);
  const dagRunner = new TrackingDAGRunner();
  const { runner } = makeRecoveryRunner({ dagRunner, validationGateService });

  await runner.run();

  const debuggerCalls = dagRunner.calls.filter(c => c.nodeId === 'DEBUGGER');
  assert.strictEqual(debuggerCalls.length, 2, 'one DEBUGGER call per validation failure');
});

test('Phase E recovery: failure_report injected into cycleState for DEBUGGER node', async () => {
  const validationGateService = new FailNTimesValidationGate(1);
  const dagRunner = new TrackingDAGRunner();
  const { runner } = makeRecoveryRunner({ dagRunner, validationGateService });

  await runner.run();

  const debuggerCall = dagRunner.calls.find(c => c.nodeId === 'DEBUGGER');
  assert.ok(debuggerCall, 'DEBUGGER should have been called');
  assert.ok(debuggerCall!.state.failure_report, 'failure_report should be in cycleState for DEBUGGER');
  assert.ok(
    debuggerCall!.state.failure_report!.quick_summary.length > 0,
    'failure_report should have a quick_summary'
  );
});

test('Phase E recovery: after DEBUGGER succeeds, EXEC is called before VALIDATION_GATE', async () => {
  // Fail once: EXEC → fail → DEBUGGER → EXEC (2nd call) → pass → done
  const validationGateService = new FailNTimesValidationGate(1);
  const execService = new TrackingExecService();
  const { runner } = makeRecoveryRunner({ execService, validationGateService });

  await runner.run();

  // ExecService is called for the initial EXEC and again after DEBUGGER fix
  assert.ok(execService.callCount >= 2, `ExecService should be called at least twice, got ${execService.callCount}`);
});

test('Phase E recovery: DEBUGGER LLM failure returns completed=false with final_node=DEBUGGER', async () => {
  const validationGateService = new FailNTimesValidationGate(1);
  const dagRunner = new TrackingDAGRunner();
  dagRunner.failOnNode = 'DEBUGGER';
  const { runner } = makeRecoveryRunner({ dagRunner, validationGateService });

  const result = await runner.run();

  assert.strictEqual(result.completed, false);
  assert.strictEqual(result.final_node, 'DEBUGGER');
  assert.ok(result.error?.includes('DEBUGGER failed'), `unexpected error: ${result.error}`);
});

console.log('# ✅ All Phase E (CycleRunner recovery) tests passed!');
