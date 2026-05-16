import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { ConfirmService, ConfirmServiceError } from '../src/confirm-service.js';
import { validateOutputPath } from '../src/agent-runner.js';
import { buildCycleStateContext } from '../src/dag-runner.js';
import type { RuntimeMap, RuntimeMapManager } from '../src/runtime-map.js';
import type { ManifestNodeEntry } from '../src/run-artifacts.js';

console.log('# Running Phase H (TEST Node + CONFIRM Gate) tests...');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeBaseMap(): RuntimeMap {
  return {
    meta: {
      status: 'cycling',
      cycle: 1,
      version_id: '123e4567-e89b-12d3-a456-426614174000',
      initialized_at: '2026-05-08T12:00:00Z',
      updated_at: '2026-05-08T12:00:00Z',
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
      status: 'complete',
      mode: 'full',
      completed_at: '2026-05-08T13:00:00Z',
      artifacts: [],
      current_round: 0,
      total_rounds: 1,
      current_phase: 0,
      total_phases: 0,
      open_questions_count: 0,
      blocking_questions_count: 0,
    },
    cycle: {
      number: 1,
      iteration: 1,
      revision: 0,
      max_iterations: 5,
      planning_depth: 'standard',
      started_at: '2026-05-08T14:00:00Z',
      outcome: 'cycling',
      approval_gate: null,
      awaiting_scoping: false,
      awaiting_confirmation: false,
      awaiting_sharding_approval: false,
    },
    artifacts: [],
  } as unknown as RuntimeMap;
}

class InMemoryMapManager implements RuntimeMapManager {
  public map: RuntimeMap;
  constructor(initial?: RuntimeMap) {
    this.map = JSON.parse(JSON.stringify(initial ?? makeBaseMap()));
  }
  async read(): Promise<RuntimeMap> { return JSON.parse(JSON.stringify(this.map)); }
  async update(fn: (m: RuntimeMap) => RuntimeMap): Promise<void> {
    this.map = JSON.parse(JSON.stringify(fn(JSON.parse(JSON.stringify(this.map)))));
  }
  async write(m: RuntimeMap): Promise<void> { this.map = JSON.parse(JSON.stringify(m)); }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

// RunArtifactManager mock — tracks updateNodeStatus calls
class MockRunArtifacts {
  public updates: Array<{ node: string; update: Partial<ManifestNodeEntry> }> = [];
  async updateNodeStatus(_cn: number, _it: number, nodeId: string, update: Partial<ManifestNodeEntry>): Promise<void> {
    this.updates.push({ node: nodeId, update });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

// ─── TEST node write-path tests ───────────────────────────────────────────────

test('tester: allows docs/test-plan.md', () => {
  assert.strictEqual(validateOutputPath('docs/test-plan.md', 'tester'), true);
});

test('tester: allows .sle/runs/ prefix paths', () => {
  assert.strictEqual(validateOutputPath('.sle/runs/1-1/tests/api.test.ts', 'tester'), true);
  assert.strictEqual(validateOutputPath('.sle/runs/2-3/tests/auth.spec.ts', 'tester'), true);
});

test('tester: blocks docs/plan.md', () => {
  assert.strictEqual(validateOutputPath('docs/plan.md', 'tester'), false);
});

test('tester: blocks docs/requirements.md', () => {
  assert.strictEqual(validateOutputPath('docs/requirements.md', 'tester'), false);
});

test('tester: blocks src/ paths', () => {
  assert.strictEqual(validateOutputPath('src/index.ts', 'tester'), false);
});

// ─── ConfirmService.gate() tests ──────────────────────────────────────────────

test('gate: sets awaiting_confirmation=true in map', async () => {
  const mgr = new InMemoryMapManager();
  const artifacts = new MockRunArtifacts();
  const svc = new ConfirmService(mgr, artifacts as never);

  await svc.gate(1, 1);

  const map = await mgr.read();
  assert.strictEqual(map.cycle.awaiting_confirmation, true);
});

test('gate: marks CONFIRM as running in manifest', async () => {
  const mgr = new InMemoryMapManager();
  const artifacts = new MockRunArtifacts();
  const svc = new ConfirmService(mgr, artifacts as never);

  await svc.gate(1, 1);

  assert.strictEqual(artifacts.updates.length, 1);
  assert.strictEqual(artifacts.updates[0].node, 'CONFIRM');
  assert.strictEqual(artifacts.updates[0].update.status, 'running');
});

test('gate: sets dag current_node to CONFIRM', async () => {
  const base = makeBaseMap();
  (base.meta as Record<string, unknown>).dag = {
    current_node: 'TEST',
    completed_nodes: ['SCOPING', 'DESIGN', 'PLAN', 'TEST'],
  };
  const mgr = new InMemoryMapManager(base);
  const artifacts = new MockRunArtifacts();
  const svc = new ConfirmService(mgr, artifacts as never);

  await svc.gate(1, 1);

  const map = await mgr.read();
  assert.strictEqual((map.meta as Record<string, unknown> & { dag?: { current_node: string } }).dag?.current_node, 'CONFIRM');
});

// ─── ConfirmService.approve() tests ──────────────────────────────────────────

test('approve: clears awaiting_confirmation', async () => {
  const base = makeBaseMap();
  (base.cycle as Record<string, unknown>).awaiting_confirmation = true;
  const mgr = new InMemoryMapManager(base);
  const artifacts = new MockRunArtifacts();
  const svc = new ConfirmService(mgr, artifacts as never);

  await svc.approve(1, 1);

  const map = await mgr.read();
  assert.strictEqual(map.cycle.awaiting_confirmation, false);
});

test('approve: returns next_node=BUILD', async () => {
  const base = makeBaseMap();
  (base.cycle as Record<string, unknown>).awaiting_confirmation = true;
  const mgr = new InMemoryMapManager(base);
  const svc = new ConfirmService(mgr, new MockRunArtifacts() as never);

  const result = await svc.approve(1, 1);

  assert.strictEqual(result.next_node, 'BUILD');
  assert.strictEqual(result.approved, true);
});

test('approve: advances dag current_node to BUILD', async () => {
  const base = makeBaseMap();
  (base.cycle as Record<string, unknown>).awaiting_confirmation = true;
  (base.meta as Record<string, unknown>).dag = { current_node: 'CONFIRM', completed_nodes: [] };
  const mgr = new InMemoryMapManager(base);
  const svc = new ConfirmService(mgr, new MockRunArtifacts() as never);

  await svc.approve(1, 1);

  const map = await mgr.read();
  assert.strictEqual((map.meta as Record<string, unknown> & { dag?: { current_node: string } }).dag?.current_node, 'BUILD');
});

test('approve: adds CONFIRM to completed_nodes', async () => {
  const base = makeBaseMap();
  (base.cycle as Record<string, unknown>).awaiting_confirmation = true;
  (base.meta as Record<string, unknown>).dag = { current_node: 'CONFIRM', completed_nodes: ['SCOPING', 'DESIGN', 'PLAN', 'TEST'] };
  const mgr = new InMemoryMapManager(base);
  const svc = new ConfirmService(mgr, new MockRunArtifacts() as never);

  await svc.approve(1, 1);

  const map = await mgr.read();
  const dag = (map.meta as Record<string, unknown> & { dag?: { completed_nodes: string[] } }).dag;
  assert.ok(dag?.completed_nodes.includes('CONFIRM'));
});

test('approve: marks CONFIRM complete in manifest', async () => {
  const base = makeBaseMap();
  (base.cycle as Record<string, unknown>).awaiting_confirmation = true;
  const mgr = new InMemoryMapManager(base);
  const artifacts = new MockRunArtifacts();
  const svc = new ConfirmService(mgr, artifacts as never);

  await svc.approve(1, 1);

  const confirmUpdate = artifacts.updates.find((u) => u.update.status === 'complete');
  assert.ok(confirmUpdate, 'expected a complete status update');
  assert.strictEqual(confirmUpdate?.node, 'CONFIRM');
});

test('approve: throws not_awaiting_confirmation when flag is false', async () => {
  const mgr = new InMemoryMapManager(); // awaiting_confirmation defaults to false
  const svc = new ConfirmService(mgr, new MockRunArtifacts() as never);

  await assert.rejects(
    () => svc.approve(1, 1),
    (err: Error & { code?: string }) => {
      assert.strictEqual(err.code, 'not_awaiting_confirmation');
      return true;
    }
  );
});

// ─── ConfirmService.revise() tests ───────────────────────────────────────────

test('revise: increments revision count', async () => {
  const base = makeBaseMap();
  (base.cycle as Record<string, unknown>).awaiting_confirmation = true;
  (base.cycle as Record<string, unknown>).revision = 0;
  const mgr = new InMemoryMapManager(base);
  const svc = new ConfirmService(mgr, new MockRunArtifacts() as never);

  const result = await svc.revise(1, 1);

  assert.strictEqual(result.revision_count, 1);
  const map = await mgr.read();
  assert.strictEqual(map.cycle.revision, 1);
});

test('revise: returns next_node=PLAN', async () => {
  const base = makeBaseMap();
  (base.cycle as Record<string, unknown>).awaiting_confirmation = true;
  const mgr = new InMemoryMapManager(base);
  const svc = new ConfirmService(mgr, new MockRunArtifacts() as never);

  const result = await svc.revise(1, 1);

  assert.strictEqual(result.next_node, 'PLAN');
});

test('revise: stores revision note in map', async () => {
  const base = makeBaseMap();
  (base.cycle as Record<string, unknown>).awaiting_confirmation = true;
  const mgr = new InMemoryMapManager(base);
  const svc = new ConfirmService(mgr, new MockRunArtifacts() as never);

  await svc.revise(1, 1, 'Please add error handling to the plan');

  const map = await mgr.read();
  assert.strictEqual((map.cycle as Record<string, unknown>).revision_note, 'Please add error handling to the plan');
});

test('revise: clears awaiting_confirmation', async () => {
  const base = makeBaseMap();
  (base.cycle as Record<string, unknown>).awaiting_confirmation = true;
  const mgr = new InMemoryMapManager(base);
  const svc = new ConfirmService(mgr, new MockRunArtifacts() as never);

  await svc.revise(1, 1, 'revise please');

  const map = await mgr.read();
  assert.strictEqual(map.cycle.awaiting_confirmation, false);
});

test('revise: sets dag current_node back to PLAN', async () => {
  const base = makeBaseMap();
  (base.cycle as Record<string, unknown>).awaiting_confirmation = true;
  (base.meta as Record<string, unknown>).dag = { current_node: 'CONFIRM', completed_nodes: ['PLAN', 'TEST'] };
  const mgr = new InMemoryMapManager(base);
  const svc = new ConfirmService(mgr, new MockRunArtifacts() as never);

  await svc.revise(1, 1);

  const map = await mgr.read();
  assert.strictEqual((map.meta as Record<string, unknown> & { dag?: { current_node: string } }).dag?.current_node, 'PLAN');
});

test('revise: throws not_awaiting_confirmation when flag is false', async () => {
  const mgr = new InMemoryMapManager();
  const svc = new ConfirmService(mgr, new MockRunArtifacts() as never);

  await assert.rejects(
    () => svc.revise(1, 1, 'note'),
    (err: Error & { code?: string }) => {
      assert.strictEqual(err.code, 'not_awaiting_confirmation');
      return true;
    }
  );
});

// ─── revision context flows into CycleStateContext ───────────────────────────

test('buildCycleStateContext: includes revision_count from map', () => {
  const base = makeBaseMap();
  (base.cycle as Record<string, unknown>).revision = 2;
  const ctx = buildCycleStateContext(base, 'PLAN');
  assert.strictEqual(ctx.revision_count, 2);
});

test('buildCycleStateContext: includes revision_note from map', () => {
  const base = makeBaseMap();
  (base.cycle as Record<string, unknown>).revision = 1;
  (base.cycle as Record<string, unknown>).revision_note = 'Add auth flows to plan';
  const ctx = buildCycleStateContext(base, 'PLAN');
  assert.strictEqual(ctx.revision_note, 'Add auth flows to plan');
});

test('buildCycleStateContext: revision_note absent when not set', () => {
  const base = makeBaseMap();
  const ctx = buildCycleStateContext(base, 'PLAN');
  assert.strictEqual(ctx.revision_note, undefined);
});

// ─── Full CONFIRM lifecycle ───────────────────────────────────────────────────

test('full confirm lifecycle: gate → approve', async () => {
  const base = makeBaseMap();
  const mgr = new InMemoryMapManager(base);
  const artifacts = new MockRunArtifacts();
  const svc = new ConfirmService(mgr, artifacts as never);

  // Gate: pauses DAG
  await svc.gate(1, 1);
  let map = await mgr.read();
  assert.strictEqual(map.cycle.awaiting_confirmation, true);

  // Approve: advances to BUILD
  const result = await svc.approve(1, 1);
  assert.strictEqual(result.next_node, 'BUILD');
  map = await mgr.read();
  assert.strictEqual(map.cycle.awaiting_confirmation, false);
});

test('full confirm lifecycle: gate → revise → gate → approve', async () => {
  const base = makeBaseMap();
  const mgr = new InMemoryMapManager(base);
  const svc = new ConfirmService(mgr, new MockRunArtifacts() as never);

  // First pass: gate → revise
  await svc.gate(1, 1);
  const reviseResult = await svc.revise(1, 1, 'Add more detail');
  assert.strictEqual(reviseResult.revision_count, 1);
  assert.strictEqual(reviseResult.next_node, 'PLAN');

  // Second pass: gate → approve
  await svc.gate(1, 1);
  const approveResult = await svc.approve(1, 1);
  assert.strictEqual(approveResult.next_node, 'BUILD');
  const map = await mgr.read();
  assert.strictEqual(map.cycle.revision, 1);
  assert.strictEqual(map.cycle.awaiting_confirmation, false);
});

console.log('# ✅ All Phase H tests passed!');
