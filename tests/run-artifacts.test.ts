import { test } from 'node:test';
import { strict as assert } from 'assert';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import { promises as fs } from 'fs';
import { join } from 'path';
import { RunArtifactManager, CORE_DAG_NODES, initialDAGNodes } from '../src/run-artifacts.js';

const RUN_ID = 'abc123de-0000-0000-0000-000000000001';
const RUN_ID2 = 'abc123de-0000-0000-0000-000000000002';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'sle-run-test-'));
}

test('testCreateRunDir', async () => {
  const root = makeTempDir();
  const mgr = new RunArtifactManager({ projectRoot: root });

  const dir = await mgr.createRunDir(RUN_ID, 1);

  assert.strictEqual(dir, join(root, '.sle', 'runs', RUN_ID, '1'));
  const entries = await fs.readdir(join(root, '.sle', 'runs', RUN_ID, '1'));
  assert.ok(entries.includes('validation'));
  assert.ok(entries.includes('node-outputs'));
});

test('testCreateManifest', async () => {
  const root = makeTempDir();
  const mgr = new RunArtifactManager({ projectRoot: root });
  await mgr.createRunDir(RUN_ID, 1);

  await mgr.createManifest({
    cycleId: RUN_ID,
    cycleNumber: 1,
    iteration: 1,
    planningDepth: 'standard',
  });

  const content = await fs.readFile(join(root, '.sle', 'runs', RUN_ID, '1', 'manifest.json'), 'utf-8');
  const manifest = JSON.parse(content);
  assert.strictEqual(manifest.cycle_id, RUN_ID);
  assert.strictEqual(manifest.cycle_number, 1);
  assert.strictEqual(manifest.iteration, 1);
  assert.strictEqual(manifest.planning_depth, 'standard');
  assert.strictEqual(manifest.outcome, 'in_progress');
  assert.ok(Array.isArray(manifest.nodes));
  assert.strictEqual(manifest.nodes.length, CORE_DAG_NODES.length);
  assert.ok(typeof manifest.started_at === 'string');
});

test('testManifestInitializesAllNodesAsPending', async () => {
  const root = makeTempDir();
  const mgr = new RunArtifactManager({ projectRoot: root });
  await mgr.createRunDir(RUN_ID, 1);
  await mgr.createManifest({ cycleId: RUN_ID, cycleNumber: 1, iteration: 1, planningDepth: 'standard' });

  const manifest = await mgr.readManifest(RUN_ID, 1);
  assert.strictEqual(manifest.nodes.length, 14);
  for (const node of manifest.nodes) {
    assert.strictEqual(node.status, 'pending');
    assert.deepStrictEqual(node.artifacts_written, []);
  }
  const ids = manifest.nodes.map((n) => n.id);
  assert.ok(ids.includes('SCOPING'));
  assert.ok(ids.includes('DESIGN'));
  assert.ok(ids.includes('SNAPSHOT'));
});

test('testUpdateNodeStatusRunning', async () => {
  const root = makeTempDir();
  const mgr = new RunArtifactManager({ projectRoot: root });
  await mgr.createRunDir(RUN_ID, 1);
  await mgr.createManifest({ cycleId: RUN_ID, cycleNumber: 1, iteration: 1, planningDepth: 'standard' });

  const startedAt = new Date().toISOString();
  await mgr.updateNodeStatus(RUN_ID, 1, 'SCOPING', { status: 'running', started_at: startedAt });

  const manifest = await mgr.readManifest(RUN_ID, 1);
  const scoping = manifest.nodes.find((n) => n.id === 'SCOPING');
  assert.ok(scoping !== undefined);
  assert.strictEqual(scoping!.status, 'running');
  assert.strictEqual(scoping!.started_at, startedAt);
  // Other nodes unaffected
  const design = manifest.nodes.find((n) => n.id === 'DESIGN');
  assert.strictEqual(design!.status, 'pending');
});

test('testUpdateNodeStatusComplete', async () => {
  const root = makeTempDir();
  const mgr = new RunArtifactManager({ projectRoot: root });
  await mgr.createRunDir(RUN_ID, 1);
  await mgr.createManifest({ cycleId: RUN_ID, cycleNumber: 1, iteration: 1, planningDepth: 'standard' });

  const now = new Date().toISOString();
  await mgr.updateNodeStatus(RUN_ID, 1, 'DESIGN', {
    status: 'complete',
    started_at: now,
    completed_at: now,
    duration_ms: 5432,
    tokens_used: 1024,
    agent_role: 'designer',
    artifacts_written: ['docs/requirements.md', 'docs/architecture.md'],
  });

  const manifest = await mgr.readManifest(RUN_ID, 1);
  const design = manifest.nodes.find((n) => n.id === 'DESIGN');
  assert.strictEqual(design!.status, 'complete');
  assert.strictEqual(design!.duration_ms, 5432);
  assert.strictEqual(design!.tokens_used, 1024);
  assert.deepStrictEqual(design!.artifacts_written, ['docs/requirements.md', 'docs/architecture.md']);
});

test('testUpdateNodeUnknownIdAddsEntry', async () => {
  const root = makeTempDir();
  const mgr = new RunArtifactManager({ projectRoot: root });
  await mgr.createRunDir(RUN_ID, 1);
  await mgr.createManifest({ cycleId: RUN_ID, cycleNumber: 1, iteration: 1, planningDepth: 'standard' });

  // Unknown node: added dynamically (observability, non-fatal)
  await mgr.updateNodeStatus(RUN_ID, 1, 'NONEXISTENT', { status: 'running' });
  const manifest = await mgr.readManifest(RUN_ID, 1);

  const added = manifest.nodes.find((n) => n.id === 'NONEXISTENT');
  assert.ok(added, 'unknown node should be added to manifest');
  assert.strictEqual(added!.status, 'running');

  // Original nodes unaffected
  for (const node of manifest.nodes.filter((n) => n.id !== 'NONEXISTENT')) {
    assert.strictEqual(node.status, 'pending');
  }
});

test('testFinalizeManifestComplete', async () => {
  const root = makeTempDir();
  const mgr = new RunArtifactManager({ projectRoot: root });
  await mgr.createRunDir(RUN_ID, 1);
  await mgr.createManifest({ cycleId: RUN_ID, cycleNumber: 1, iteration: 1, planningDepth: 'standard' });

  await mgr.finalizeManifest(RUN_ID, 1, 'complete');

  const manifest = await mgr.readManifest(RUN_ID, 1);
  assert.strictEqual(manifest.outcome, 'complete');
  assert.ok(typeof manifest.completed_at === 'string');
});

test('testFinalizeManifestHalted', async () => {
  const root = makeTempDir();
  const mgr = new RunArtifactManager({ projectRoot: root });
  await mgr.createRunDir(RUN_ID, 1);
  await mgr.createManifest({ cycleId: RUN_ID, cycleNumber: 1, iteration: 1, planningDepth: 'standard' });

  await mgr.finalizeManifest(RUN_ID, 1, 'halted');

  const manifest = await mgr.readManifest(RUN_ID, 1);
  assert.strictEqual(manifest.outcome, 'halted');
  assert.ok(typeof manifest.completed_at === 'string');
});

test('testWriteAndReadContextPack', async () => {
  const root = makeTempDir();
  const mgr = new RunArtifactManager({ projectRoot: root });
  await mgr.createRunDir(RUN_ID, 3);

  const pack = {
    SCOPING: {
      system_prompt_tokens: 500,
      artifact_slices: [{ artifact_id: 'discovery', tokens: 800, truncated: false }],
      state_summary_tokens: 120,
      total_tokens: 1420,
    },
  };
  await mgr.writeContextPack(RUN_ID, 3, pack);

  // Written as markdown with JSON code block at ai/context-pack.md
  const raw = await fs.readFile(join(root, '.sle', 'runs', RUN_ID, '3', 'ai', 'context-pack.md'), 'utf-8');
  assert.ok(raw.startsWith('# Context Pack'));
  assert.ok(raw.includes('```json'));

  const read = await mgr.readContextPack(RUN_ID, 3);
  assert.deepStrictEqual(read, pack);
});

test('testReadContextPackMissing', async () => {
  const root = makeTempDir();
  const mgr = new RunArtifactManager({ projectRoot: root });
  await mgr.createRunDir(RUN_ID, 1);

  const pack = await mgr.readContextPack(RUN_ID, 1);
  assert.deepStrictEqual(pack, {});
});

test('testWriteNodeOutput', async () => {
  const root = makeTempDir();
  const mgr = new RunArtifactManager({ projectRoot: root });
  await mgr.createRunDir(RUN_ID, 1);

  await mgr.writeNodeOutput(RUN_ID, 1, 'DESIGN', '# Design Output\n\nSome content here.');

  const content = await fs.readFile(join(root, '.sle', 'runs', RUN_ID, '1', 'node-outputs', 'design.md'), 'utf-8');
  assert.strictEqual(content, '# Design Output\n\nSome content here.');
});

test('testDirExistsTrue', async () => {
  const root = makeTempDir();
  const mgr = new RunArtifactManager({ projectRoot: root });
  await mgr.createRunDir(RUN_ID, 2);
  assert.strictEqual(await mgr.dirExists(RUN_ID, 2), true);
});

test('testDirExistsFalse', async () => {
  const root = makeTempDir();
  const mgr = new RunArtifactManager({ projectRoot: root });
  assert.strictEqual(await mgr.dirExists(RUN_ID, 2), false);
});

test('testMultipleIterations', async () => {
  const root = makeTempDir();
  const mgr = new RunArtifactManager({ projectRoot: root });

  await mgr.createRunDir(RUN_ID, 1);
  await mgr.createManifest({ cycleId: RUN_ID, cycleNumber: 1, iteration: 1, planningDepth: 'standard' });

  await mgr.createRunDir(RUN_ID, 2);
  await mgr.createManifest({ cycleId: RUN_ID, cycleNumber: 1, iteration: 2, planningDepth: 'standard' });

  const m1 = await mgr.readManifest(RUN_ID, 1);
  const m2 = await mgr.readManifest(RUN_ID, 2);
  assert.strictEqual(m1.iteration, 1);
  assert.strictEqual(m2.iteration, 2);

  // Update iteration 2's node without affecting iteration 1
  await mgr.updateNodeStatus(RUN_ID, 2, 'SCOPING', { status: 'running' });
  const m1After = await mgr.readManifest(RUN_ID, 1);
  assert.strictEqual(m1After.nodes.find((n) => n.id === 'SCOPING')!.status, 'pending');
});

test('testTwoConcurrentRunsDoNotCollide', async () => {
  const root = makeTempDir();
  const mgr = new RunArtifactManager({ projectRoot: root });

  await mgr.createRunDir(RUN_ID, 1);
  await mgr.createManifest({ cycleId: RUN_ID, cycleNumber: 1, iteration: 1, planningDepth: 'minimal' });

  await mgr.createRunDir(RUN_ID2, 1);
  await mgr.createManifest({ cycleId: RUN_ID2, cycleNumber: 2, iteration: 1, planningDepth: 'deep' });

  await mgr.updateNodeStatus(RUN_ID, 1, 'SCOPING', { status: 'running' });

  // Second run is unaffected
  const m2 = await mgr.readManifest(RUN_ID2, 1);
  assert.strictEqual(m2.nodes.find(n => n.id === 'SCOPING')!.status, 'pending');

  // Paths are different
  const dir1 = mgr.runDir(RUN_ID, 1);
  const dir2 = mgr.runDir(RUN_ID2, 1);
  assert.notStrictEqual(dir1, dir2);
});

test('testWriteAndReadFailureReport', async () => {
  const root = makeTempDir();
  const mgr = new RunArtifactManager({ projectRoot: root });
  await mgr.createRunDir(RUN_ID, 1);

  const report = {
    cycle: 1,
    iteration: 1,
    run_dir: `.sle/runs/${RUN_ID}/1`,
    run_id: RUN_ID,
    quick_summary: 'Test failed',
    failed_categories: [{ name: 'correctness', method: 'executable' as const, error_summary: 'assertion failed' }],
    passed_categories: [],
  };
  await mgr.writeFailureReport(RUN_ID, 1, report);
  const read = await mgr.readFailureReport(RUN_ID, 1);
  assert.deepStrictEqual(read, report);
});

test('testReadFailureReportMissingReturnsNull', async () => {
  const root = makeTempDir();
  const mgr = new RunArtifactManager({ projectRoot: root });
  await mgr.createRunDir(RUN_ID, 1);
  const result = await mgr.readFailureReport(RUN_ID, 1);
  assert.strictEqual(result, null);
});

test('testInitialDAGNodesHelper', async () => {
  const nodes = initialDAGNodes();
  assert.strictEqual(Object.keys(nodes).length, 14);
  assert.strictEqual(nodes['SCOPING'].status, 'pending');
  assert.strictEqual(nodes['SNAPSHOT'].status, 'pending');
  for (const v of Object.values(nodes)) {
    assert.strictEqual(v.status, 'pending');
  }
});

// ─── Runner ──────────────────────────────────────────────────────────────────
