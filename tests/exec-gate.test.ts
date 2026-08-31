import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  ExecService,
  ValidationGateService,
  VALIDATION_REQUIRED_NODES,
} from '../src/exec-gate.js';
import type { RuntimeMap, RuntimeMapManager } from '../src/runtime-map.js';
import type { RunManifest, ManifestNodeEntry } from '../src/run-artifacts.js';
import type { FailureReport } from '../src/types.js';
import { ExecServiceReal } from '../src/exec-service.js';

// Mock ExecServiceReal.prototype.run to be a fast synchronous stub for wrapper tests
ExecServiceReal.prototype.run = async function(workflowRunId: string, iteration: number) {
  await this.runArtifacts.updateNodeStatus(workflowRunId, iteration, 'EXEC', {
    status: 'running',
    started_at: new Date().toISOString(),
  } as any);
  await this.runArtifacts.updateNodeStatus(workflowRunId, iteration, 'EXEC', {
    status: 'complete',
    exit_code: 0,
    timed_out: false,
  } as any);
  await this.mapManager.update((m: any) => {
    const completed = [...(m.meta.dag?.completed_nodes ?? [])];
    if (!completed.includes('EXEC')) {
      completed.push('EXEC');
    }
    return {
      ...m,
      meta: {
        ...m.meta,
        dag: m.meta.dag
          ? {
              ...m.meta.dag,
              current_node: 'VALIDATION_GATE',
              completed_nodes: completed,
              exec_result: { exit_code: 0, timed_out: false },
            }
          : undefined,
      },
    };
  });
  return {
    next_node: 'VALIDATION_GATE' as const,
    exit_code: 0,
    stdout: '',
    stderr: '',
    timed_out: false,
    success: true,
  };
};

console.log('# Running Phase J (EXEC stub + Validation Gate) tests...');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeBaseMap(): RuntimeMap {
  return {
    meta: {
      status: 'cycling',
      cycle: 1,
      version_id: '123e4567-e89b-12d3-a456-426614174000',
      initialized_at: '2026-05-08T12:00:00Z',
      updated_at: '2026-05-08T12:00:00Z',
      dag: {
        current_node: 'EXEC',
        completed_nodes: ['SCOPING', 'DESIGN', 'PLAN', 'TEST', 'CONFIRM', 'BUILD', 'HISTORY'],
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
    },
    validation: {
      categories: [
        { name: 'correctness', status: 'passed' },
        { name: 'performance', status: 'passed' },
        { name: 'security', status: 'passed' },
      ],
      gate: { mode: 'all_must_pass', last_outcome: 'pending', failed_categories: [] },
    },
    artifacts: [],
  } as unknown as RuntimeMap;
}

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

function makeManifest(nodeStatuses: Record<string, 'pending' | 'running' | 'complete' | 'failed' | 'skipped'>): RunManifest {
  const nodes: ManifestNodeEntry[] = Object.entries(nodeStatuses).map(([id, status]) => ({
    id,
    status,
    artifacts_written: [],
  }));
  return {
    cycle_id: 'test-cycle-1',
    cycle_number: 1,
    iteration: 1,
    planning_depth: 'standard',
    started_at: '2026-05-08T14:00:00Z',
    outcome: 'in_progress',
    nodes,
  };
}

class MockRunArtifacts {
  public updates: Array<{ node: string; update: Partial<ManifestNodeEntry> }> = [];
  public manifest: RunManifest;
  public failureReports: FailureReport[] = [];

  constructor(manifest?: RunManifest) {
    this.manifest = manifest ?? makeManifest({
      BUILD: 'complete', EXEC: 'complete',
    });
  }

  async updateNodeStatus(
    _cn: string, _it: number, nodeId: string, update: Partial<ManifestNodeEntry>
  ): Promise<void> {
    this.updates.push({ node: nodeId, update });
    const existing = this.manifest.nodes.find((n) => n.id === nodeId);
    if (existing) {
      Object.assign(existing, update);
    }
  }

  async readManifest(_cn: string, _it: number): Promise<RunManifest> {
    return JSON.parse(JSON.stringify(this.manifest));
  }

  async writeFailureReport(_cn: string, _it: number, report: FailureReport): Promise<void> {
    this.failureReports.push(report);
  }

  runDir(_cn: string, _it: number): string {
    return `.sle/runs/${_cn}-${_it}`;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

// ─── VALIDATION_REQUIRED_NODES ────────────────────────────────────────────────

test('VALIDATION_REQUIRED_NODES contains BUILD and EXEC', () => {
  assert.ok(VALIDATION_REQUIRED_NODES.includes('BUILD'));
  assert.ok(VALIDATION_REQUIRED_NODES.includes('EXEC'));
});

// ─── ExecService tests ────────────────────────────────────────────────────────

test('ExecService: always returns success=true', async () => {
  const mgr = new InMemoryMapManager();
  const artifacts = new MockRunArtifacts();
  const svc = new ExecService(mgr, artifacts as never);

  const result = await svc.run('test-run-1', 1);

  assert.strictEqual(result.success, true);
});

test('ExecService: next_node is VALIDATION_GATE', async () => {
  const mgr = new InMemoryMapManager();
  const artifacts = new MockRunArtifacts();
  const svc = new ExecService(mgr, artifacts as never);

  const result = await svc.run('test-run-1', 1);

  assert.strictEqual(result.next_node, 'VALIDATION_GATE');
});

test('ExecService: marks EXEC running then complete in manifest', async () => {
  const mgr = new InMemoryMapManager();
  const artifacts = new MockRunArtifacts();
  const svc = new ExecService(mgr, artifacts as never);

  await svc.run('test-run-1', 1);

  const runningUpdate = artifacts.updates.find((u) => u.update.status === 'running' && u.node === 'EXEC');
  const completeUpdate = artifacts.updates.find((u) => u.update.status === 'complete' && u.node === 'EXEC');
  assert.ok(runningUpdate, 'should mark EXEC as running');
  assert.ok(completeUpdate, 'should mark EXEC as complete');
});

test('ExecService: advances dag current_node to VALIDATION_GATE', async () => {
  const mgr = new InMemoryMapManager();
  const artifacts = new MockRunArtifacts();
  const svc = new ExecService(mgr, artifacts as never);

  await svc.run('test-run-1', 1);

  const map = await mgr.read();
  const dag = (map.meta as Record<string, unknown> & { dag?: { current_node: string } }).dag;
  assert.strictEqual(dag?.current_node, 'VALIDATION_GATE');
});

test('ExecService: adds EXEC to completed_nodes in dag', async () => {
  const mgr = new InMemoryMapManager();
  const artifacts = new MockRunArtifacts();
  const svc = new ExecService(mgr, artifacts as never);

  await svc.run('test-run-1', 1);

  const map = await mgr.read();
  const dag = (map.meta as Record<string, unknown> & { dag?: { completed_nodes: string[] } }).dag;
  assert.ok(dag?.completed_nodes.includes('EXEC'));
});

// ─── ValidationGateService tests ──────────────────────────────────────────────

test('ValidationGate: passes when all active categories are cached as passed', async () => {
  const mgr = new InMemoryMapManager();
  const artifacts = new MockRunArtifacts();
  const svc = new ValidationGateService(mgr, artifacts as never);

  const result = await svc.run('test-cycle-1', 1);

  assert.strictEqual(result.passed, true);
  assert.strictEqual(result.next_node, 'EVALUATE');
  assert.deepStrictEqual(result.failed_nodes, []);
});

test('ValidationGate: no FailureReport written on pass', async () => {
  const mgr = new InMemoryMapManager();
  const artifacts = new MockRunArtifacts();
  const svc = new ValidationGateService(mgr, artifacts as never);

  await svc.run('test-cycle-1', 1);

  assert.strictEqual(artifacts.failureReports.length, 0);
});

test('ValidationGate: advances dag to EVALUATE on pass', async () => {
  const mgr = new InMemoryMapManager();
  const artifacts = new MockRunArtifacts();
  const svc = new ValidationGateService(mgr, artifacts as never);

  await svc.run('test-cycle-1', 1);

  const map = await mgr.read();
  const dag = (map.meta as Record<string, unknown> & { dag?: { current_node: string } }).dag;
  assert.strictEqual(dag?.current_node, 'EVALUATE');
});

test('ValidationGate: marks VALIDATION_GATE complete in manifest on pass', async () => {
  const mgr = new InMemoryMapManager();
  const artifacts = new MockRunArtifacts();
  const svc = new ValidationGateService(mgr, artifacts as never);

  await svc.run('test-cycle-1', 1);

  const completeUpdate = artifacts.updates.find(
    (u) => u.node === 'VALIDATION_GATE' && u.update.status === 'complete'
  );
  assert.ok(completeUpdate, 'VALIDATION_GATE should be marked complete');
});

test('ValidationGate: fails when static analysis fails (exit_code !== 0)', async () => {
  const baseMap = makeBaseMap();
  (baseMap.meta as any).dag = {
    current_node: 'VALIDATION_GATE',
    completed_nodes: ['EXEC'],
    exec_result: { exit_code: 1, timed_out: false },
  };
  const mgr = new InMemoryMapManager(baseMap);
  const artifacts = new MockRunArtifacts();
  const svc = new ValidationGateService(mgr, artifacts as never);

  const result = await svc.run('test-cycle-1', 1);

  assert.strictEqual(result.passed, false);
  assert.strictEqual(result.next_node, null);
});

test('ValidationGate: fails when a category is failed', async () => {
  const baseMap = makeBaseMap();
  baseMap.validation = {
    categories: [
      { name: 'correctness', status: 'failed' },
      { name: 'performance', status: 'passed' },
      { name: 'security', status: 'passed' },
    ],
    gate: { mode: 'all_must_pass', last_outcome: 'pending', failed_categories: [] },
  };
  const mgr = new InMemoryMapManager(baseMap);
  const artifacts = new MockRunArtifacts();
  const svc = new ValidationGateService(mgr, artifacts as never);

  const result = await svc.run('test-cycle-1', 1);

  assert.strictEqual(result.passed, false);
  assert.ok(result.failed_nodes.includes('correctness'));
});

test('ValidationGate: writes FailureReport on failure', async () => {
  const baseMap = makeBaseMap();
  baseMap.validation = {
    categories: [
      { name: 'correctness', status: 'failed' },
      { name: 'performance', status: 'passed' },
      { name: 'security', status: 'passed' },
    ],
    gate: { mode: 'all_must_pass', last_outcome: 'pending', failed_categories: [] },
  };
  const mgr = new InMemoryMapManager(baseMap);
  const artifacts = new MockRunArtifacts();
  const svc = new ValidationGateService(mgr, artifacts as never);

  const result = await svc.run('test-cycle-1', 1);

  assert.strictEqual(artifacts.failureReports.length, 1);
  assert.ok(result.failure_report, 'result should include failure_report');
  assert.ok(result.failure_report!.failed_categories.some((c) => c.name === 'correctness'));
  assert.strictEqual(result.failure_report!.cycle, 0);
  assert.strictEqual(result.failure_report!.iteration, 1);
});

test('ValidationGate: FailureReport has correct passed_categories', async () => {
  const baseMap = makeBaseMap();
  baseMap.validation = {
    categories: [
      { name: 'correctness', status: 'failed' },
      { name: 'performance', status: 'passed' },
      { name: 'security', status: 'passed' },
    ],
    gate: { mode: 'all_must_pass', last_outcome: 'pending', failed_categories: [] },
  };
  const mgr = new InMemoryMapManager(baseMap);
  const artifacts = new MockRunArtifacts();
  const svc = new ValidationGateService(mgr, artifacts as never);

  const result = await svc.run('cycle-abc', 1);

  assert.ok(result.failure_report!.passed_categories.includes('performance'));
  assert.ok(!result.failure_report!.passed_categories.includes('correctness'));
});

test('ValidationGate: marks VALIDATION_GATE failed in manifest on failure', async () => {
  const baseMap = makeBaseMap();
  baseMap.validation = {
    categories: [
      { name: 'correctness', status: 'failed' },
      { name: 'performance', status: 'passed' },
      { name: 'security', status: 'passed' },
    ],
    gate: { mode: 'all_must_pass', last_outcome: 'pending', failed_categories: [] },
  };
  const mgr = new InMemoryMapManager(baseMap);
  const artifacts = new MockRunArtifacts();
  const svc = new ValidationGateService(mgr, artifacts as never);

  await svc.run('test-cycle-1', 1);

  const failedUpdate = artifacts.updates.find(
    (u) => u.node === 'VALIDATION_GATE' && u.update.status === 'failed'
  );
  assert.ok(failedUpdate, 'VALIDATION_GATE should be marked failed');
});

test('ValidationGate: sets dag current_node to null on failure', async () => {
  const baseMap = makeBaseMap();
  baseMap.validation = {
    categories: [
      { name: 'correctness', status: 'failed' },
      { name: 'performance', status: 'passed' },
      { name: 'security', status: 'passed' },
    ],
    gate: { mode: 'all_must_pass', last_outcome: 'pending', failed_categories: [] },
  };
  const mgr = new InMemoryMapManager(baseMap);
  const artifacts = new MockRunArtifacts();
  const svc = new ValidationGateService(mgr, artifacts as never);

  await svc.run('test-cycle-1', 1);

  const map = await mgr.read();
  const dag = (map.meta as Record<string, unknown> & { dag?: { current_node: string | null } }).dag;
  assert.strictEqual(dag?.current_node, null);
});

test('ValidationGate: FailureReport quick_summary mentions failed categories', async () => {
  const baseMap = makeBaseMap();
  baseMap.validation = {
    categories: [
      { name: 'correctness', status: 'failed' },
      { name: 'performance', status: 'passed' },
      { name: 'security', status: 'passed' },
    ],
    gate: { mode: 'all_must_pass', last_outcome: 'pending', failed_categories: [] },
  };
  const mgr = new InMemoryMapManager(baseMap);
  const artifacts = new MockRunArtifacts();
  const svc = new ValidationGateService(mgr, artifacts as never);

  const result = await svc.run('test-cycle-1', 1);

  assert.ok(result.failure_report!.quick_summary.includes('categories failed'));
});

test('ValidationGate: failed_categories are FailureCategory objects', async () => {
  const baseMap = makeBaseMap();
  baseMap.validation = {
    categories: [
      { name: 'correctness', status: 'failed' },
      { name: 'performance', status: 'passed' },
      { name: 'security', status: 'passed' },
    ],
    gate: { mode: 'all_must_pass', last_outcome: 'pending', failed_categories: [] },
  };
  const mgr = new InMemoryMapManager(baseMap);
  const artifacts = new MockRunArtifacts();
  const svc = new ValidationGateService(mgr, artifacts as never);

  const result = await svc.run('test-cycle-1', 1);

  assert.strictEqual(result.failure_report!.failed_categories[0].name, 'correctness');
  assert.strictEqual(result.failure_report!.failed_categories[0].method, 'executable');
  assert.ok(result.failure_report!.failed_categories.every((c) => typeof c === 'object' && c !== null));
});

test('ValidationGate: sets validation.gate.last_outcome=passed on pass', async () => {
  const mgr = new InMemoryMapManager();
  const artifacts = new MockRunArtifacts();
  const svc = new ValidationGateService(mgr, artifacts as never);

  await svc.run('test-cycle-1', 1);

  const map = await mgr.read();
  assert.strictEqual((map as never as { validation: { gate: { last_outcome: string } } }).validation.gate.last_outcome, 'passed');
});

test('ValidationGate: sets validation.gate.last_outcome=failed on failure', async () => {
  const baseMap = makeBaseMap();
  baseMap.validation = {
    categories: [
      { name: 'correctness', status: 'failed' },
      { name: 'performance', status: 'passed' },
      { name: 'security', status: 'passed' },
    ],
    gate: { mode: 'all_must_pass', last_outcome: 'pending', failed_categories: [] },
  };
  const mgr = new InMemoryMapManager(baseMap);
  const artifacts = new MockRunArtifacts();
  const svc = new ValidationGateService(mgr, artifacts as never);

  await svc.run('test-cycle-1', 1);

  const map = await mgr.read();
  assert.strictEqual((map as never as { validation: { gate: { last_outcome: string } } }).validation.gate.last_outcome, 'failed');
});

// ─── Full EXEC → VALIDATION_GATE flow ─────────────────────────────────────────

test('full flow: ExecService run then ValidationGate pass', async () => {
  const mgr = new InMemoryMapManager();
  const artifacts = new MockRunArtifacts();

  // EXEC runs first
  const execSvc = new ExecService(mgr, artifacts as never);
  const execResult = await execSvc.run(1, 1);
  assert.strictEqual(execResult.success, true);

  // After EXEC, VALIDATION_GATE evaluates
  const gateSvc = new ValidationGateService(mgr, artifacts as never);
  const gateResult = await gateSvc.run(1, 1, 'test-cycle-1');
  assert.strictEqual(gateResult.passed, true);
  assert.strictEqual(gateResult.next_node, 'EVALUATE');
});

console.log('# ✅ All Phase J tests passed!');
