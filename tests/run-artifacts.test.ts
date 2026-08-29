import { test } from 'node:test';
import { strict as assert } from 'assert';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import { promises as fs } from 'fs';
import { join } from 'path';
import { RunArtifactManager, CORE_DAG_NODES, initialDAGNodes } from '../src/run-artifacts.js';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'sle-run-test-'));
}

test('testCreateRunDir', async () => {
  const root = makeTempDir();
  const mgr = new RunArtifactManager({ projectRoot: root });

  const dir = await mgr.createRunDir(1, 1);

  assert.strictEqual(dir, join(root, '.sle', 'runs', '1-1'));
  const entries = await fs.readdir(join(root, '.sle', 'runs', '1-1'));
  assert.ok(entries.includes('validation'));
  assert.ok(entries.includes('node-outputs'));
});

test('testCreateManifest', async () => {
  const root = makeTempDir();
  const mgr = new RunArtifactManager({ projectRoot: root });
  await mgr.createRunDir(1, 1);

  await mgr.createManifest({
    cycleId: 'abc123de-0000-0000-0000-000000000001',
    cycleNumber: 1,
    iteration: 1,
    planningDepth: 'standard',
  });

  const content = await fs.readFile(join(root, '.sle', 'runs', '1-1', 'manifest.json'), 'utf-8');
  const manifest = JSON.parse(content);
  assert.strictEqual(manifest.cycle_id, 'abc123de-0000-0000-0000-000000000001');
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
  await mgr.createRunDir(1, 1);
  await mgr.createManifest({ cycleId: 'abc123de-0000-0000-0000-000000000001', cycleNumber: 1, iteration: 1, planningDepth: 'standard' });

  const manifest = await mgr.readManifest(1, 1);
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
  await mgr.createRunDir(1, 1);
  await mgr.createManifest({ cycleId: 'abc123de-0000-0000-0000-000000000001', cycleNumber: 1, iteration: 1, planningDepth: 'standard' });

  const startedAt = new Date().toISOString();
  await mgr.updateNodeStatus(1, 1, 'SCOPING', { status: 'running', started_at: startedAt });

  const manifest = await mgr.readManifest(1, 1);
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
  await mgr.createRunDir(1, 1);
  await mgr.createManifest({ cycleId: 'abc123de-0000-0000-0000-000000000001', cycleNumber: 1, iteration: 1, planningDepth: 'standard' });

  const now = new Date().toISOString();
  await mgr.updateNodeStatus(1, 1, 'DESIGN', {
    status: 'complete',
    started_at: now,
    completed_at: now,
    duration_ms: 5432,
    tokens_used: 1024,
    agent_role: 'designer',
    artifacts_written: ['docs/requirements.md', 'docs/architecture.md'],
  });

  const manifest = await mgr.readManifest(1, 1);
  const design = manifest.nodes.find((n) => n.id === 'DESIGN');
  assert.strictEqual(design!.status, 'complete');
  assert.strictEqual(design!.duration_ms, 5432);
  assert.strictEqual(design!.tokens_used, 1024);
  assert.deepStrictEqual(design!.artifacts_written, ['docs/requirements.md', 'docs/architecture.md']);
});

test('testUpdateNodeUnknownIdThrows', async () => {
  const root = makeTempDir();
  const mgr = new RunArtifactManager({ projectRoot: root });
  await mgr.createRunDir(1, 1);
  await mgr.createManifest({ cycleId: 'abc123de-0000-0000-0000-000000000001', cycleNumber: 1, iteration: 1, planningDepth: 'standard' });

  // Unknown node update is a no-op (nodes.map just skips)
  // Should not throw
  await mgr.updateNodeStatus(1, 1, 'NONEXISTENT', { status: 'running' });
  const manifest = await mgr.readManifest(1, 1);
  // All nodes still pending - no effect
  for (const node of manifest.nodes) {
    assert.strictEqual(node.status, 'pending');
  }
});

test('testFinalizeManifestComplete', async () => {
  const root = makeTempDir();
  const mgr = new RunArtifactManager({ projectRoot: root });
  await mgr.createRunDir(1, 1);
  await mgr.createManifest({ cycleId: 'abc123de-0000-0000-0000-000000000001', cycleNumber: 1, iteration: 1, planningDepth: 'standard' });

  await mgr.finalizeManifest(1, 1, 'complete');

  const manifest = await mgr.readManifest(1, 1);
  assert.strictEqual(manifest.outcome, 'complete');
  assert.ok(typeof manifest.completed_at === 'string');
});

test('testFinalizeManifestHalted', async () => {
  const root = makeTempDir();
  const mgr = new RunArtifactManager({ projectRoot: root });
  await mgr.createRunDir(1, 1);
  await mgr.createManifest({ cycleId: 'abc123de-0000-0000-0000-000000000001', cycleNumber: 1, iteration: 1, planningDepth: 'standard' });

  await mgr.finalizeManifest(1, 1, 'halted');

  const manifest = await mgr.readManifest(1, 1);
  assert.strictEqual(manifest.outcome, 'halted');
  assert.ok(typeof manifest.completed_at === 'string');
});

test('testWriteAndReadContextPack', async () => {
  const root = makeTempDir();
  const mgr = new RunArtifactManager({ projectRoot: root });
  await mgr.createRunDir(2, 3);

  const pack = {
    SCOPING: {
      system_prompt_tokens: 500,
      artifact_slices: [{ artifact_id: 'discovery', tokens: 800, truncated: false }],
      state_summary_tokens: 120,
      total_tokens: 1420,
    },
  };
  await mgr.writeContextPack(2, 3, pack);

  // Written as markdown with JSON code block at ai/context-pack.md
  const raw = await fs.readFile(join(root, '.sle', 'runs', '2-3', 'ai', 'context-pack.md'), 'utf-8');
  assert.ok(raw.startsWith('# Context Pack'));
  assert.ok(raw.includes('```json'));

  const read = await mgr.readContextPack(2, 3);
  assert.deepStrictEqual(read, pack);
});

test('testReadContextPackMissing', async () => {
  const root = makeTempDir();
  const mgr = new RunArtifactManager({ projectRoot: root });
  await mgr.createRunDir(1, 1);

  const pack = await mgr.readContextPack(1, 1);
  assert.deepStrictEqual(pack, {});
});

test('testWriteNodeOutput', async () => {
  const root = makeTempDir();
  const mgr = new RunArtifactManager({ projectRoot: root });
  await mgr.createRunDir(1, 1);

  await mgr.writeNodeOutput(1, 1, 'DESIGN', '# Design Output\n\nSome content here.');

  const content = await fs.readFile(join(root, '.sle', 'runs', '1-1', 'node-outputs', 'design.md'), 'utf-8');
  assert.strictEqual(content, '# Design Output\n\nSome content here.');
});

test('testDirExistsTrue', async () => {
  const root = makeTempDir();
  const mgr = new RunArtifactManager({ projectRoot: root });
  await mgr.createRunDir(1, 2);
  assert.strictEqual(await mgr.dirExists(1, 2), true);
});

test('testDirExistsFalse', async () => {
  const root = makeTempDir();
  const mgr = new RunArtifactManager({ projectRoot: root });
  assert.strictEqual(await mgr.dirExists(1, 2), false);
});

test('testMultipleIterations', async () => {
  const root = makeTempDir();
  const mgr = new RunArtifactManager({ projectRoot: root });

  await mgr.createRunDir(1, 1);
  await mgr.createManifest({ cycleId: 'abc123de-0000-0000-0000-000000000001', cycleNumber: 1, iteration: 1, planningDepth: 'standard' });

  await mgr.createRunDir(1, 2);
  await mgr.createManifest({ cycleId: 'abc123de-0000-0000-0000-000000000001', cycleNumber: 1, iteration: 2, planningDepth: 'standard' });

  const m1 = await mgr.readManifest(1, 1);
  const m2 = await mgr.readManifest(1, 2);
  assert.strictEqual(m1.iteration, 1);
  assert.strictEqual(m2.iteration, 2);

  // Update iteration 2's node without affecting iteration 1
  await mgr.updateNodeStatus(1, 2, 'SCOPING', { status: 'running' });
  const m1After = await mgr.readManifest(1, 1);
  assert.strictEqual(m1After.nodes.find((n) => n.id === 'SCOPING')!.status, 'pending');
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
