import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import { promises as realFs } from 'fs';
import { SnapshotService } from '../src/snapshot-service.js';
import { DAGRunner, nextNode } from '../src/dag-runner.js';
import { roleForNode } from '../src/agent-runner.js';
import type { AgentRunResult } from '../src/agent-runner.js';
import type { CycleStateContext } from '../src/context-manager.js';
import type { RuntimeMap, RuntimeMapManager } from '../src/runtime-map.js';
import type { ManifestNodeEntry, SnapshotMetadata } from '../src/run-artifacts.js';

// Augment import — snapshot-service.ts exports SnapshotMetadata; run-artifacts.ts does not
import type { SnapshotMetadata as SM } from '../src/snapshot-service.js';

console.log('# Running Phase K (EVALUATE + SUMMARISE + SNAPSHOT) tests...');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'sle-snapshot-test-'));
}

function makeCycleState(overrides: Partial<CycleStateContext> = {}): CycleStateContext {
  return {
    cycle_number: 1, iteration: 1, planning_depth: 'standard',
    intent: 'Build a widget system', current_node: 'EVALUATE', ...overrides,
  };
}

function makeBaseMap(artifactPaths: string[] = []): RuntimeMap {
  return {
    meta: {
      status: 'cycling', cycle: 1,
      version_id: '123e4567-e89b-12d3-a456-426614174000',
      initialized_at: '2026-05-08T12:00:00Z', updated_at: '2026-05-08T12:00:00Z',
      dag: {
        current_node: 'SNAPSHOT',
        completed_nodes: ['SCOPING', 'DESIGN', 'PLAN', 'TEST', 'CONFIRM',
                          'BUILD', 'HISTORY', 'EXEC', 'VALIDATION_GATE', 'EVALUATE', 'SUMMARISE'],
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
    artifacts: artifactPaths.map((p) => ({
      path: p, generator: 'builder', required: true,
      last_updated: '2026-05-08T14:30:00Z', dirty: false,
    })),
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

class MockRunArtifacts {
  public updates: Array<{ node: string; update: Partial<ManifestNodeEntry> }> = [];
  public finalizedOutcome: string | null = null;

  async updateNodeStatus(_cn: number, _it: number, nodeId: string, update: Partial<ManifestNodeEntry>): Promise<void> {
    this.updates.push({ node: nodeId, update });
  }
  async finalizeManifest(_cn: number, _it: number, outcome: string): Promise<void> {
    this.finalizedOutcome = outcome;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

class MockAgentRunner {
  public calls: Array<{ node: string }> = [];
  constructor(private result: AgentRunResult) {}
  async run(node: string, _state: CycleStateContext): Promise<AgentRunResult> {
    this.calls.push({ node });
    return this.result;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

// ─── Role mappings ────────────────────────────────────────────────────────────

test('roleForNode: EVALUATE → evaluator', () => {
  assert.strictEqual(roleForNode('EVALUATE'), 'evaluator');
});

test('roleForNode: SUMMARISE → historian', () => {
  assert.strictEqual(roleForNode('SUMMARISE'), 'historian');
});

test('roleForNode: SNAPSHOT → undefined (system node)', () => {
  assert.strictEqual(roleForNode('SNAPSHOT'), undefined);
});

// ─── nextNode sequence ────────────────────────────────────────────────────────

test('nextNode: EVALUATE → SUMMARISE', () => {
  assert.strictEqual(nextNode('EVALUATE'), 'SUMMARISE');
});

test('nextNode: SUMMARISE → SNAPSHOT', () => {
  assert.strictEqual(nextNode('SUMMARISE'), 'SNAPSHOT');
});

test('nextNode: SNAPSHOT → null (end of DAG)', () => {
  assert.strictEqual(nextNode('SNAPSHOT'), null);
});

// ─── DAGRunner: EVALUATE node ─────────────────────────────────────────────────

test('DAGRunner EVALUATE: advances to SUMMARISE', async () => {
  const mgr = new InMemoryMapManager();
  (mgr.map.meta as Record<string, unknown>).dag = { current_node: 'EVALUATE', completed_nodes: [] };
  const artifacts = new MockRunArtifacts();
  const runner = new MockAgentRunner({
    success: true,
    artifacts_written: ['docs/evaluation-criteria.md'],
    tokens_used: 300, duration_ms: 600, raw_output_path: '',
  });
  const dag = new DAGRunner(runner as never, mgr, artifacts as never);

  const result = await dag.runNode('EVALUATE', makeCycleState({ current_node: 'EVALUATE' }));

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.next_node, 'SUMMARISE');
});

test('DAGRunner EVALUATE: artifact entries have generator=evaluator', async () => {
  const mgr = new InMemoryMapManager();
  (mgr.map.meta as Record<string, unknown>).dag = { current_node: 'EVALUATE', completed_nodes: [] };
  const artifacts = new MockRunArtifacts();
  const runner = new MockAgentRunner({
    success: true,
    artifacts_written: ['docs/evaluation-criteria.md'],
    tokens_used: 200, duration_ms: 400, raw_output_path: '',
  });
  const dag = new DAGRunner(runner as never, mgr, artifacts as never);

  await dag.runNode('EVALUATE', makeCycleState({ current_node: 'EVALUATE' }));

  const map = await mgr.read();
  const entry = map.artifacts.find((a: { path: string }) => a.path === 'docs/evaluation-criteria.md');
  assert.ok(entry);
  assert.strictEqual((entry as Record<string, unknown>).generator, 'evaluator');
});

// ─── DAGRunner: SUMMARISE node ────────────────────────────────────────────────

test('DAGRunner SUMMARISE: advances to SNAPSHOT', async () => {
  const mgr = new InMemoryMapManager();
  (mgr.map.meta as Record<string, unknown>).dag = { current_node: 'SUMMARISE', completed_nodes: [] };
  const artifacts = new MockRunArtifacts();
  const runner = new MockAgentRunner({
    success: true,
    artifacts_written: ['docs/cycle-summary.md'],
    tokens_used: 250, duration_ms: 500, raw_output_path: '',
  });
  const dag = new DAGRunner(runner as never, mgr, artifacts as never);

  const result = await dag.runNode('SUMMARISE', makeCycleState({ current_node: 'SUMMARISE' }));

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.next_node, 'SNAPSHOT');
});

test('DAGRunner SUMMARISE: artifact entries have generator=historian', async () => {
  const mgr = new InMemoryMapManager();
  (mgr.map.meta as Record<string, unknown>).dag = { current_node: 'SUMMARISE', completed_nodes: [] };
  const artifacts = new MockRunArtifacts();
  const runner = new MockAgentRunner({
    success: true,
    artifacts_written: ['docs/cycle-summary.md'],
    tokens_used: 200, duration_ms: 400, raw_output_path: '',
  });
  const dag = new DAGRunner(runner as never, mgr, artifacts as never);

  await dag.runNode('SUMMARISE', makeCycleState({ current_node: 'SUMMARISE' }));

  const map = await mgr.read();
  const entry = map.artifacts.find((a: { path: string }) => a.path === 'docs/cycle-summary.md');
  assert.ok(entry);
  assert.strictEqual((entry as Record<string, unknown>).generator, 'historian');
});

// ─── SnapshotService tests ────────────────────────────────────────────────────

test('SnapshotService: returns success=true', async () => {
  const root = makeTempDir();
  const mgr = new InMemoryMapManager(makeBaseMap([]));
  const artifacts = new MockRunArtifacts();
  const svc = new SnapshotService(mgr, artifacts as never, root);

  const result = await svc.run(1, 1);

  assert.strictEqual(result.success, true);
});

test('SnapshotService: creates snapshot directory', async () => {
  const root = makeTempDir();
  const mgr = new InMemoryMapManager(makeBaseMap([]));
  const artifacts = new MockRunArtifacts();
  const svc = new SnapshotService(mgr, artifacts as never, root);

  const result = await svc.run(1, 1);

  const stat = await realFs.stat(result.snapshot_dir);
  assert.ok(stat.isDirectory(), 'snapshot_dir should be a directory');
});

test('SnapshotService: writes snapshot.json metadata', async () => {
  const root = makeTempDir();
  const mgr = new InMemoryMapManager(makeBaseMap([]));
  const artifacts = new MockRunArtifacts();
  const svc = new SnapshotService(mgr, artifacts as never, root);

  const result = await svc.run(1, 1);

  const metaPath = join(result.snapshot_dir, 'snapshot.json');
  const meta: SM = JSON.parse(await realFs.readFile(metaPath, 'utf-8'));
  assert.ok(meta.snapshot_id, 'snapshot_id should be set');
  assert.strictEqual(meta.cycle, 1);
  assert.strictEqual(meta.iteration, 1);
  assert.ok(meta.created_at, 'created_at should be set');
  assert.ok(Array.isArray(meta.artifacts));
});

test('SnapshotService: copies artifact files to snapshot dir', async () => {
  const root = makeTempDir();

  // Create source artifact
  await realFs.mkdir(join(root, 'docs'), { recursive: true });
  await realFs.writeFile(join(root, 'docs', 'requirements.md'), '# Requirements\n\nContent.', 'utf-8');
  await realFs.writeFile(join(root, 'docs', 'plan.md'), '# Plan\n\nStep 1.', 'utf-8');

  const mgr = new InMemoryMapManager(makeBaseMap(['docs/requirements.md', 'docs/plan.md']));
  const artifacts = new MockRunArtifacts();
  const svc = new SnapshotService(mgr, artifacts as never, root);

  const result = await svc.run(1, 1);

  assert.deepStrictEqual(result.artifacts_copied.sort(), ['docs/plan.md', 'docs/requirements.md']);

  // Verify files exist in snapshot dir
  const reqSnap = await realFs.readFile(join(result.snapshot_dir, 'docs/requirements.md'), 'utf-8');
  assert.ok(reqSnap.includes('Requirements'));
  const planSnap = await realFs.readFile(join(result.snapshot_dir, 'docs/plan.md'), 'utf-8');
  assert.ok(planSnap.includes('Step 1'));
});

test('SnapshotService: skips missing artifact files gracefully', async () => {
  const root = makeTempDir();

  // Only create one of the two artifacts
  await realFs.mkdir(join(root, 'docs'), { recursive: true });
  await realFs.writeFile(join(root, 'docs', 'requirements.md'), '# Requirements', 'utf-8');
  // docs/plan.md intentionally not created

  const mgr = new InMemoryMapManager(makeBaseMap(['docs/requirements.md', 'docs/plan.md']));
  const artifacts = new MockRunArtifacts();
  const svc = new SnapshotService(mgr, artifacts as never, root);

  const result = await svc.run(1, 1);

  // Only the existing file should be copied
  assert.deepStrictEqual(result.artifacts_copied, ['docs/requirements.md']);
  assert.strictEqual(result.success, true);
});

test('SnapshotService: marks SNAPSHOT running then complete in manifest', async () => {
  const root = makeTempDir();
  const mgr = new InMemoryMapManager(makeBaseMap([]));
  const artifacts = new MockRunArtifacts();
  const svc = new SnapshotService(mgr, artifacts as never, root);

  await svc.run(1, 1);

  const runningUpdate = artifacts.updates.find((u) => u.node === 'SNAPSHOT' && u.update.status === 'running');
  const completeUpdate = artifacts.updates.find((u) => u.node === 'SNAPSHOT' && u.update.status === 'complete');
  assert.ok(runningUpdate, 'SNAPSHOT should be marked running');
  assert.ok(completeUpdate, 'SNAPSHOT should be marked complete');
});

test('SnapshotService: finalizes manifest as complete', async () => {
  const root = makeTempDir();
  const mgr = new InMemoryMapManager(makeBaseMap([]));
  const artifacts = new MockRunArtifacts();
  const svc = new SnapshotService(mgr, artifacts as never, root);

  await svc.run(1, 1);

  assert.strictEqual(artifacts.finalizedOutcome, 'complete');
});

test('SnapshotService: sets dag current_node to null after completion', async () => {
  const root = makeTempDir();
  const mgr = new InMemoryMapManager(makeBaseMap([]));
  const artifacts = new MockRunArtifacts();
  const svc = new SnapshotService(mgr, artifacts as never, root);

  await svc.run(1, 1);

  const map = await mgr.read();
  const dag = (map.meta as Record<string, unknown> & { dag?: { current_node: string | null } }).dag;
  assert.strictEqual(dag?.current_node, null);
});

test('SnapshotService: adds SNAPSHOT to completed_nodes', async () => {
  const root = makeTempDir();
  const mgr = new InMemoryMapManager(makeBaseMap([]));
  const artifacts = new MockRunArtifacts();
  const svc = new SnapshotService(mgr, artifacts as never, root);

  await svc.run(1, 1);

  const map = await mgr.read();
  const dag = (map.meta as Record<string, unknown> & { dag?: { completed_nodes: string[] } }).dag;
  assert.ok(dag?.completed_nodes.includes('SNAPSHOT'));
});

test('SnapshotService: returns unique snapshot_id per run', async () => {
  const root = makeTempDir();
  const mgr1 = new InMemoryMapManager(makeBaseMap([]));
  const mgr2 = new InMemoryMapManager(makeBaseMap([]));
  const svc1 = new SnapshotService(mgr1, new MockRunArtifacts() as never, root);
  const svc2 = new SnapshotService(mgr2, new MockRunArtifacts() as never, root);

  const r1 = await svc1.run(1, 1);
  const r2 = await svc2.run(1, 1);

  assert.notStrictEqual(r1.snapshot_id, r2.snapshot_id);
});

test('SnapshotService: snapshotDir uses correct path pattern', () => {
  const root = '/project';
  const svc = new SnapshotService(
    new InMemoryMapManager() as never,
    new MockRunArtifacts() as never,
    root
  );
  const dir = svc.snapshotDir(3, 2);
  assert.ok(dir.includes('.sle'));
  assert.ok(dir.includes('snapshots'));
  assert.ok(dir.includes('3-2'));
});

test('SnapshotService: snapshot.json lists only successfully copied files', async () => {
  const root = makeTempDir();

  // Create only one file
  await realFs.mkdir(join(root, 'docs'), { recursive: true });
  await realFs.writeFile(join(root, 'docs', 'architecture.md'), '# Arch', 'utf-8');

  const mgr = new InMemoryMapManager(makeBaseMap(['docs/architecture.md', 'docs/missing.md']));
  const artifacts = new MockRunArtifacts();
  const svc = new SnapshotService(mgr, artifacts as never, root);

  const result = await svc.run(1, 1);

  const meta: SM = JSON.parse(
    await realFs.readFile(join(result.snapshot_dir, 'snapshot.json'), 'utf-8')
  );
  assert.deepStrictEqual(meta.artifacts, ['docs/architecture.md']);
});

console.log('# ✅ All Phase K tests passed!');
