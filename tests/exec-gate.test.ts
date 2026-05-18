import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  ExecService,
  ValidationGateService,
  VALIDATION_REQUIRED_NODES,
} from '../src/exec-gate.js';
import { nextNode } from '../src/dag-runner.js';
import type { RuntimeMap, RuntimeMapManager } from '../src/runtime-map.js';
import type { RunManifest, ManifestNodeEntry } from '../src/run-artifacts.js';
import type { FailureReport } from '../src/types.js';

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
    _cn: number, _it: number, nodeId: string, update: Partial<ManifestNodeEntry>
  ): Promise<void> {
    this.updates.push({ node: nodeId, update });
    const existing = this.manifest.nodes.find((n) => n.id === nodeId);
    if (existing) {
      Object.assign(existing, update);
    }
  }

  async readManifest(_cn: number, _it: number): Promise<RunManifest> {
    return JSON.parse(JSON.stringify(this.manifest));
  }

  async writeFailureReport(_cn: number, _it: number, report: FailureReport): Promise<void> {
    this.failureReports.push(report);
  }

  runDir(_cn: number, _it: number): string {
    return `.sle/runs/${_cn}-${_it}`;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

// ─── nextNode sequence ────────────────────────────────────────────────────────

test('nextNode: EXEC → VALIDATION_GATE', () => {
  assert.strictEqual(nextNode('EXEC'), 'VALIDATION_GATE');
});

test('nextNode: VALIDATION_GATE → EVALUATE', () => {
  assert.strictEqual(nextNode('VALIDATION_GATE'), 'EVALUATE');
});

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

  const result = await svc.run(1, 1);

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.passed, true);
});

test('ExecService: next_node is VALIDATION_GATE', async () => {
  const mgr = new InMemoryMapManager();
  const artifacts = new MockRunArtifacts();
  const svc = new ExecService(mgr, artifacts as never);

  const result = await svc.run(1, 1);

  assert.strictEqual(result.next_node, 'VALIDATION_GATE');
});

test('ExecService: marks EXEC running then complete in manifest', async () => {
  const mgr = new InMemoryMapManager();
  const artifacts = new MockRunArtifacts();
  const svc = new ExecService(mgr, artifacts as never);

  await svc.run(1, 1);

  const runningUpdate = artifacts.updates.find((u) => u.update.status === 'running' && u.node === 'EXEC');
  const completeUpdate = artifacts.updates.find((u) => u.update.status === 'complete' && u.node === 'EXEC');
  assert.ok(runningUpdate, 'should mark EXEC as running');
  assert.ok(completeUpdate, 'should mark EXEC as complete');
});

test('ExecService: advances dag current_node to VALIDATION_GATE', async () => {
  const mgr = new InMemoryMapManager();
  const artifacts = new MockRunArtifacts();
  const svc = new ExecService(mgr, artifacts as never);

  await svc.run(1, 1);

  const map = await mgr.read();
  const dag = (map.meta as Record<string, unknown> & { dag?: { current_node: string } }).dag;
  assert.strictEqual(dag?.current_node, 'VALIDATION_GATE');
});

test('ExecService: adds EXEC to completed_nodes in dag', async () => {
  const mgr = new InMemoryMapManager();
  const artifacts = new MockRunArtifacts();
  const svc = new ExecService(mgr, artifacts as never);

  await svc.run(1, 1);

  const map = await mgr.read();
  const dag = (map.meta as Record<string, unknown> & { dag?: { completed_nodes: string[] } }).dag;
  assert.ok(dag?.completed_nodes.includes('EXEC'));
});

test('ExecService: duration_ms is 0 (stub)', async () => {
  const mgr = new InMemoryMapManager();
  const artifacts = new MockRunArtifacts();
  const svc = new ExecService(mgr, artifacts as never);

  const result = await svc.run(1, 1);

  assert.strictEqual(result.duration_ms, 0);
});

// ─── ValidationGateService tests (passing) ────────────────────────────────────

test('ValidationGate: passes when BUILD and EXEC are complete', async () => {
  const manifest = makeManifest({ BUILD: 'complete', EXEC: 'complete' });
  const mgr = new InMemoryMapManager();
  const artifacts = new MockRunArtifacts(manifest);
  const svc = new ValidationGateService(mgr, artifacts as never);

  const result = await svc.run(1, 1, 'test-cycle-1');

  assert.strictEqual(result.passed, true);
  assert.strictEqual(result.next_node, 'EVALUATE');
  assert.deepStrictEqual(result.failed_nodes, []);
});

test('ValidationGate: no FailureReport written on pass', async () => {
  const manifest = makeManifest({ BUILD: 'complete', EXEC: 'complete' });
  const mgr = new InMemoryMapManager();
  const artifacts = new MockRunArtifacts(manifest);
  const svc = new ValidationGateService(mgr, artifacts as never);

  await svc.run(1, 1, 'test-cycle-1');

  assert.strictEqual(artifacts.failureReports.length, 0);
});

test('ValidationGate: advances dag to EVALUATE on pass', async () => {
  const manifest = makeManifest({ BUILD: 'complete', EXEC: 'complete' });
  const mgr = new InMemoryMapManager();
  const artifacts = new MockRunArtifacts(manifest);
  const svc = new ValidationGateService(mgr, artifacts as never);

  await svc.run(1, 1, 'test-cycle-1');

  const map = await mgr.read();
  const dag = (map.meta as Record<string, unknown> & { dag?: { current_node: string } }).dag;
  assert.strictEqual(dag?.current_node, 'EVALUATE');
});

test('ValidationGate: marks VALIDATION_GATE complete in manifest on pass', async () => {
  const manifest = makeManifest({ BUILD: 'complete', EXEC: 'complete' });
  const mgr = new InMemoryMapManager();
  const artifacts = new MockRunArtifacts(manifest);
  const svc = new ValidationGateService(mgr, artifacts as never);

  await svc.run(1, 1, 'test-cycle-1');

  const completeUpdate = artifacts.updates.find(
    (u) => u.node === 'VALIDATION_GATE' && u.update.status === 'complete'
  );
  assert.ok(completeUpdate, 'VALIDATION_GATE should be marked complete');
});

// ─── ValidationGateService tests (failing) ────────────────────────────────────

test('ValidationGate: fails when BUILD is not complete', async () => {
  const manifest = makeManifest({ BUILD: 'failed', EXEC: 'complete' });
  const mgr = new InMemoryMapManager();
  const artifacts = new MockRunArtifacts(manifest);
  const svc = new ValidationGateService(mgr, artifacts as never);

  const result = await svc.run(1, 1, 'test-cycle-1');

  assert.strictEqual(result.passed, false);
  assert.strictEqual(result.next_node, null);
  assert.ok(result.failed_nodes.includes('BUILD'));
});

test('ValidationGate: fails when EXEC is not complete', async () => {
  const manifest = makeManifest({ BUILD: 'complete', EXEC: 'pending' });
  const mgr = new InMemoryMapManager();
  const artifacts = new MockRunArtifacts(manifest);
  const svc = new ValidationGateService(mgr, artifacts as never);

  const result = await svc.run(1, 1, 'test-cycle-1');

  assert.strictEqual(result.passed, false);
  assert.ok(result.failed_nodes.includes('EXEC'));
});

test('ValidationGate: writes FailureReport on failure', async () => {
  const manifest = makeManifest({ BUILD: 'failed', EXEC: 'complete' });
  const mgr = new InMemoryMapManager();
  const artifacts = new MockRunArtifacts(manifest);
  const svc = new ValidationGateService(mgr, artifacts as never);

  const result = await svc.run(1, 1, 'test-cycle-1');

  assert.strictEqual(artifacts.failureReports.length, 1);
  assert.ok(result.failure_report, 'result should include failure_report');
  assert.ok(result.failure_report!.failed_categories.includes('BUILD'));
  assert.strictEqual(result.failure_report!.cycle, 1);
  assert.strictEqual(result.failure_report!.iteration, 1);
});

test('ValidationGate: FailureReport has correct passed_categories', async () => {
  const manifest = makeManifest({ BUILD: 'failed', EXEC: 'complete' });
  const mgr = new InMemoryMapManager();
  const artifacts = new MockRunArtifacts(manifest);
  const svc = new ValidationGateService(mgr, artifacts as never);

  const result = await svc.run(1, 1, 'cycle-abc');

  assert.ok(result.failure_report!.passed_categories.includes('EXEC'));
  assert.ok(!result.failure_report!.passed_categories.includes('BUILD'));
});

test('ValidationGate: marks VALIDATION_GATE failed in manifest on failure', async () => {
  const manifest = makeManifest({ BUILD: 'failed', EXEC: 'failed' });
  const mgr = new InMemoryMapManager();
  const artifacts = new MockRunArtifacts(manifest);
  const svc = new ValidationGateService(mgr, artifacts as never);

  await svc.run(1, 1, 'test-cycle-1');

  const failedUpdate = artifacts.updates.find(
    (u) => u.node === 'VALIDATION_GATE' && u.update.status === 'failed'
  );
  assert.ok(failedUpdate, 'VALIDATION_GATE should be marked failed');
});

test('ValidationGate: sets dag current_node to null on failure', async () => {
  const manifest = makeManifest({ BUILD: 'failed', EXEC: 'complete' });
  const mgr = new InMemoryMapManager();
  const artifacts = new MockRunArtifacts(manifest);
  const svc = new ValidationGateService(mgr, artifacts as never);

  await svc.run(1, 1, 'test-cycle-1');

  const map = await mgr.read();
  const dag = (map.meta as Record<string, unknown> & { dag?: { current_node: string | null } }).dag;
  assert.strictEqual(dag?.current_node, null);
});

test('ValidationGate: FailureReport quick_summary mentions failed nodes', async () => {
  const manifest = makeManifest({ BUILD: 'pending', EXEC: 'pending' });
  const mgr = new InMemoryMapManager();
  const artifacts = new MockRunArtifacts(manifest);
  const svc = new ValidationGateService(mgr, artifacts as never);

  const result = await svc.run(1, 1, 'test-cycle-1');

  assert.ok(result.failure_report!.quick_summary.includes('BUILD'));
});

test('ValidationGate: failed_categories are plain strings', async () => {
  const manifest = makeManifest({ BUILD: 'failed', EXEC: 'complete' });
  const mgr = new InMemoryMapManager();
  const artifacts = new MockRunArtifacts(manifest);
  const svc = new ValidationGateService(mgr, artifacts as never);

  const result = await svc.run(1, 1, 'test-cycle-1');

  assert.strictEqual(result.failure_report!.failed_categories[0], 'BUILD');
  assert.ok(result.failure_report!.failed_categories.every((c) => typeof c === 'string'));
});

test('ValidationGate: sets validation.gate.last_outcome=passed on pass', async () => {
  const manifest = makeManifest({ BUILD: 'complete', EXEC: 'complete' });
  const baseMap = {
    ...makeBaseMap(),
    validation: {
      categories: [],
      gate: { mode: 'all_must_pass' as const, last_outcome: 'halted' as const, failed_categories: [] },
    },
  };
  const mgr = new InMemoryMapManager(baseMap as never);
  const artifacts = new MockRunArtifacts(manifest);
  const svc = new ValidationGateService(mgr, artifacts as never);

  await svc.run(1, 1, 'test-cycle-1');

  const map = await mgr.read();
  assert.strictEqual((map as never as { validation: { gate: { last_outcome: string } } }).validation.gate.last_outcome, 'passed');
});

test('ValidationGate: sets validation.gate.last_outcome=failed on failure', async () => {
  const manifest = makeManifest({ BUILD: 'failed', EXEC: 'complete' });
  const baseMap = {
    ...makeBaseMap(),
    validation: {
      categories: [],
      gate: { mode: 'all_must_pass' as const, last_outcome: 'halted' as const, failed_categories: [] },
    },
  };
  const mgr = new InMemoryMapManager(baseMap as never);
  const artifacts = new MockRunArtifacts(manifest);
  const svc = new ValidationGateService(mgr, artifacts as never);

  await svc.run(1, 1, 'test-cycle-1');

  const map = await mgr.read();
  assert.strictEqual((map as never as { validation: { gate: { last_outcome: string } } }).validation.gate.last_outcome, 'failed');
});

// ─── Full EXEC → VALIDATION_GATE flow ─────────────────────────────────────────

test('full flow: ExecService run then ValidationGate pass', async () => {
  const manifest = makeManifest({ BUILD: 'complete', EXEC: 'pending' });
  const mgr = new InMemoryMapManager();
  const artifacts = new MockRunArtifacts(manifest);

  // EXEC runs first
  const execSvc = new ExecService(mgr, artifacts as never);
  const execResult = await execSvc.run(1, 1);
  assert.strictEqual(execResult.passed, true);

  // After EXEC, manifest has EXEC=complete
  const gateSvc = new ValidationGateService(mgr, artifacts as never);
  const gateResult = await gateSvc.run(1, 1, 'test-cycle-1');
  assert.strictEqual(gateResult.passed, true);
  assert.strictEqual(gateResult.next_node, 'EVALUATE');
});

console.log('# ✅ All Phase J tests passed!');
