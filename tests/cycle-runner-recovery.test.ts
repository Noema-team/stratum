/**
 * VS7 Phase A: CycleRunner iteration loop — spec-correct DEBUG integration.
 *
 * Per dag-execution.md: VALIDATION_GATE fail → DEBUG → PLAN (not EXEC).
 * The Debugger diagnoses; the Planner re-plans from the diagnosis.
 * Iteration counter increments after DEBUG, before PLAN.
 * Cap is enforced via map.cycle.max_iterations.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { CycleRunner } from '../src/cycle-runner.js';
import { nextNode } from '../src/dag-runner.js';
import type { CycleStateContext } from '../src/context-manager.js';
import type { RuntimeMap, RuntimeMapManager } from '../src/runtime-map.js';
import type { AgentRunResult } from '../src/agent-runner.js';
import type { FailureReport } from '../src/types.js';

console.log('# Running VS7 Phase A (CycleRunner iteration loop) tests...');

// ─── Shared fixtures ──────────────────────────────────────────────────────────

function makeBaseMap(maxIterations = 5): RuntimeMap {
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
      number: 1, iteration: 1, revision: 0, max_iterations: maxIterations,
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
  failed_categories: [{ name: 'correctness', method: 'executable' as const, error_summary: 'tests failed' }],
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
        failed_nodes: ['correctness'],
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
  async halt(_reason: string) { return { success: true }; }
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
  return { runner, dagRunner, execService, mgr };
}

// ─── Iteration loop tests ──────────────────────────────────────────────────────

test('VS7 A: 1 validation failure → DEBUG → PLAN → ... → EXEC retry → pass → complete', async () => {
  const validationGateService = new FailNTimesValidationGate(1);
  const { runner } = makeRecoveryRunner({ validationGateService });

  const result = await runner.run();

  assert.strictEqual(result.completed, true, `should complete: ${result.error}`);
  assert.strictEqual(result.final_node, null);
});

test('VS7 A: 2 validation failures → 2 DEBUG calls → pass → complete', async () => {
  const validationGateService = new FailNTimesValidationGate(2);
  const dagRunner = new TrackingDAGRunner();
  const { runner } = makeRecoveryRunner({ dagRunner, validationGateService });

  const result = await runner.run();

  assert.strictEqual(result.completed, true, `should complete: ${result.error}`);
  const debugCalls = dagRunner.calls.filter(c => c.nodeId === 'DEBUG');
  assert.strictEqual(debugCalls.length, 2, 'DEBUG should be called twice');
});

test('VS7 A: 3 validation failures → 3 DEBUG calls → pass → complete', async () => {
  // max_iterations=5, iteration starts at 1; after 3 failures iteration=4 < 5, continues
  const validationGateService = new FailNTimesValidationGate(3);
  const dagRunner = new TrackingDAGRunner();
  const { runner } = makeRecoveryRunner({ dagRunner, validationGateService });

  const result = await runner.run();

  assert.strictEqual(result.completed, true, `should complete: ${result.error}`);
  const debugCalls = dagRunner.calls.filter(c => c.nodeId === 'DEBUG');
  assert.strictEqual(debugCalls.length, 3, 'DEBUG should be called 3 times');
});

test('VS7 A: iteration counter increments in map after each DEBUG run', async () => {
  const validationGateService = new FailNTimesValidationGate(2);
  const mgr = new InMemoryMapManager();
  const { runner } = makeRecoveryRunner({ validationGateService, mapManager: mgr });

  await runner.run();

  // Started at iteration=1, failed twice → incremented to 3
  assert.strictEqual(mgr.map.cycle.iteration, 3);
});

test('VS7 A: cap reached → cycle halts (max_iterations=5, 4 failures → iteration=5)', async () => {
  // max_iterations=5: after 4 failures iteration becomes 5 ≥ 5 → halt
  const validationGateService = new FailNTimesValidationGate(4);
  const { runner } = makeRecoveryRunner({ validationGateService });

  const result = await runner.run();

  assert.strictEqual(result.completed, false);
  assert.ok(result.error?.includes('cap'), `error should mention cap: ${result.error}`);
});

test('VS7 A: cap halt result includes failure_report', async () => {
  const validationGateService = new FailNTimesValidationGate(4);
  const { runner } = makeRecoveryRunner({ validationGateService });

  const result = await runner.run();

  assert.ok(result.failure_report, 'failure_report should be present on cap halt');
  assert.ok(result.failure_report!.failed_categories.length > 0);
});

test('VS7 A: iterations_used reported correctly', async () => {
  const validationGateService = new FailNTimesValidationGate(0);
  const { runner } = makeRecoveryRunner({ validationGateService });

  const result = await runner.run();

  assert.strictEqual(result.completed, true);
  assert.ok(typeof result.iterations_used === 'number');
});

test('VS7 A: failure_report injected into cycleState for DEBUG node', async () => {
  const validationGateService = new FailNTimesValidationGate(1);
  const dagRunner = new TrackingDAGRunner();
  const { runner } = makeRecoveryRunner({ dagRunner, validationGateService });

  await runner.run();

  const debugCall = dagRunner.calls.find(c => c.nodeId === 'DEBUG');
  assert.ok(debugCall, 'DEBUG should have been called');
  assert.ok(debugCall!.state.failure_report, 'failure_report should be in cycleState for DEBUG');
  assert.ok(
    debugCall!.state.failure_report!.quick_summary.length > 0,
    'failure_report should have a quick_summary'
  );
});

test('VS7 A: after DEBUG, DAG routes to PLAN (not EXEC) — PLAN appears in dagRunner.calls after DEBUG', async () => {
  const validationGateService = new FailNTimesValidationGate(1);
  const dagRunner = new TrackingDAGRunner();
  const { runner } = makeRecoveryRunner({ dagRunner, validationGateService });

  await runner.run();

  const calls = dagRunner.calls.map(c => c.nodeId);
  const debugIdx = calls.lastIndexOf('DEBUG');
  assert.ok(debugIdx >= 0, 'DEBUG should appear in calls');
  // PLAN must appear after the last DEBUG call
  const planAfterDebug = calls.slice(debugIdx + 1).includes('PLAN');
  assert.ok(planAfterDebug, `PLAN should follow DEBUG; calls after DEBUG: ${calls.slice(debugIdx + 1).join(',')}`);
});

test('VS7 A: after DEBUG → PLAN → ... → EXEC is called again (EXEC count ≥ 2)', async () => {
  const validationGateService = new FailNTimesValidationGate(1);
  const execService = new TrackingExecService();
  const { runner } = makeRecoveryRunner({ execService, validationGateService });

  await runner.run();

  assert.ok(execService.callCount >= 2, `ExecService should be called ≥2 times, got ${execService.callCount}`);
});

test('VS7 A: DEBUG LLM failure returns completed=false with final_node=DEBUG', async () => {
  const validationGateService = new FailNTimesValidationGate(1);
  const dagRunner = new TrackingDAGRunner();
  dagRunner.failOnNode = 'DEBUG';
  const { runner } = makeRecoveryRunner({ dagRunner, validationGateService });

  const result = await runner.run();

  assert.strictEqual(result.completed, false);
  assert.strictEqual(result.final_node, 'DEBUG');
  assert.ok(result.error?.includes('DEBUG failed'), `unexpected error: ${result.error}`);
});

test('VS7 A: no DEBUG calls on happy path (gate passes immediately)', async () => {
  const validationGateService = new FailNTimesValidationGate(0);
  const dagRunner = new TrackingDAGRunner();
  const { runner } = makeRecoveryRunner({ dagRunner, validationGateService });

  await runner.run();

  const debugCalls = dagRunner.calls.filter(c => c.nodeId === 'DEBUG');
  assert.strictEqual(debugCalls.length, 0, 'no DEBUG calls on happy path');
});

console.log('# ✅ All VS7 Phase A (CycleRunner iteration loop) tests passed!');
