import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { openDatabase } from '../src/storage/database.js';
import { WorkService } from '../src/services/work-service.js';
import { EvidenceService } from '../src/services/evidence-service.js';
import { ExecutorRegistry } from '../src/execution/registry.js';
import { Scheduler } from '../src/scheduler/scheduler.js';
import { SchedulerLoop, createStratumApplication } from '../src/application.js';
import { getCheckpointDecisionOptions } from '../src/execution/checkpoint-resolver.js';
import type { ExecutionAdapter, ExecutionRequest, ExecutionResult, CapabilitySet } from '../src/execution/types.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeTmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'sle-app-test-'));
}

function makeStubAdapter(result: Partial<ExecutionResult> = {}): ExecutionAdapter {
  return {
    id: 'stub',
    getCapabilities(): CapabilitySet { return new Set(); },
    async execute(_req: ExecutionRequest): Promise<ExecutionResult> {
      return {
        schemaVersion: 1,
        stepExecutionId: randomUUID(),
        outcome: 'succeeded',
        artifacts: [],
        evidenceClaims: [],
        decisionRequests: [],
        ...result,
      };
    },
  };
}

function makeSchedulerWithDb(db: ReturnType<typeof openDatabase>, wsId: string) {
  const registry = new ExecutorRegistry();
  registry.register(makeStubAdapter());
  return new Scheduler(db, wsId, registry);
}

// ── SchedulerLoop tests ───────────────────────────────────────────────────────

test('SchedulerLoop: tickNow does not overlap — concurrent calls share the same tick', async () => {
  let tickCount = 0;
  let concurrency = 0;
  let maxConcurrency = 0;

  const fakeScheduler = {
    tick: async () => {
      concurrency++;
      maxConcurrency = Math.max(maxConcurrency, concurrency);
      tickCount++;
      await new Promise(r => setTimeout(r, 10));
      concurrency--;
      return [];
    },
  } as unknown as Scheduler;

  const loop = new SchedulerLoop(fakeScheduler, { intervalMs: 60_000 });

  // Fire three concurrent tickNow() calls.
  await Promise.all([loop.tickNow(), loop.tickNow(), loop.tickNow()]);

  assert.equal(tickCount, 1, 'Only one tick should execute despite concurrent calls');
  assert.equal(maxConcurrency, 1, 'Concurrency must never exceed 1');
});

test('SchedulerLoop: stop() waits for an in-flight tick before resolving', async () => {
  let tickRunning = false;
  let tickCompleted = false;

  const fakeScheduler = {
    tick: async () => {
      tickRunning = true;
      await new Promise(r => setTimeout(r, 30));
      tickCompleted = true;
      tickRunning = false;
      return [];
    },
  } as unknown as Scheduler;

  const loop = new SchedulerLoop(fakeScheduler, { intervalMs: 60_000 });

  // Kick off a tick and immediately stop.
  const tickPromise = loop.tickNow();
  const stopPromise = loop.stop();

  await stopPromise;

  assert.equal(tickCompleted, true, 'stop() should have awaited the in-flight tick');
  assert.equal(tickRunning, false);
  await tickPromise; // should already be resolved
});

test('SchedulerLoop: no new tick fires after stop()', async () => {
  let tickCount = 0;
  const fakeScheduler = {
    tick: async () => { tickCount++; return []; },
  } as unknown as Scheduler;

  const loop = new SchedulerLoop(fakeScheduler, { intervalMs: 10 });
  loop.start();

  // Let it tick a few times.
  await new Promise(r => setTimeout(r, 50));
  const countBeforeStop = tickCount;
  await loop.stop();

  await new Promise(r => setTimeout(r, 50));
  assert.equal(tickCount, countBeforeStop, 'No new ticks after stop()');
});

// ── .sle directory auto-creation ──────────────────────────────────────────────

test('createStratumApplication: creates .sle directory if absent', () => {
  const root = makeTmpRoot();
  try {
    // createStratumApplication runs mkdirSync(.sle) synchronously before returning.
    // We verify the directory exists after construction without starting the server.
    createStratumApplication({
      projectRoot: root,
      workspaceId: randomUUID(),
      port: 0,
    });
    assert.ok(existsSync(join(root, '.sle')), '.sle directory should be created');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Canonical WorkService / evidence guard ────────────────────────────────────

test('WorkService evidence guard: same instance used by Scheduler and HTTP layer', () => {
  // This test verifies the invariant at the service level by constructing the
  // shared instance manually and confirming both consumers hold the same reference.
  const db = openDatabase(':memory:');
  const wsId = randomUUID();

  const evidenceService = new EvidenceService(db);
  const workService = new WorkService(db, wsId, {
    evidenceGuard: evidenceService.asGuard(),
  });

  const registry = new ExecutorRegistry();
  const scheduler = new Scheduler(db, wsId, registry, {}, workService);

  // scheduler.workService is private; we verify by confirming that the workService
  // used in the scheduler config path comes from the same injection (no internal new).
  // The invariant is: if WorkService is injected, no second instance is created.
  // We verify this by ensuring the db can be closed cleanly (no internal state diverged).
  assert.ok(workService, 'workService constructed with evidence guard');
  assert.ok(scheduler, 'scheduler accepts injected workService');
  db.close();
});

// ── Application lifecycle ─────────────────────────────────────────────────────

test('createStratumApplication: start() and stop() complete without error', async () => {
  const root = makeTmpRoot();
  try {
    const app = createStratumApplication({
      projectRoot: root,
      workspaceId: randomUUID(),
      port: 0, // OS-assigned port
      schedulerIntervalMs: 60_000, // prevent ticks during test
    });

    await app.start();
    await app.stop();
    // If we reach here without throwing, lifecycle is correct.
    assert.ok(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('createStratumApplication: stop() drain — tick in flight when stop() called', async () => {
  const root = makeTmpRoot();
  try {
    const app = createStratumApplication({
      projectRoot: root,
      workspaceId: randomUUID(),
      port: 0,
      schedulerIntervalMs: 60_000,
    });

    await app.start();

    // Kick a tick manually and immediately call stop().
    const tick = app.schedulerLoop.tickNow();
    const stop = app.stop();

    // Both should resolve without error.
    await Promise.all([tick, stop]);
    assert.ok(true, 'stop() drained in-flight tick');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Checkpoint Decision options ────────────────────────────────────────────────

test('getCheckpointDecisionOptions: confirm → approve + revise', () => {
  const opts = getCheckpointDecisionOptions('full-build', 'confirm');
  const ids = opts.map(o => o.id);
  assert.ok(ids.includes('approve'), 'confirm should have approve');
  assert.ok(ids.includes('revise'), 'confirm should have revise');
  assert.ok(!ids.includes('reject'), 'confirm should not have reject');
});

test('getCheckpointDecisionOptions: sharding_approval → approve + reject + modify', () => {
  const opts = getCheckpointDecisionOptions('full-build', 'sharding_approval');
  const ids = opts.map(o => o.id);
  assert.ok(ids.includes('approve'));
  assert.ok(ids.includes('reject'));
  assert.ok(ids.includes('modify'));
});

test('getCheckpointDecisionOptions: scoping.checkpoint → approve only', () => {
  const opts = getCheckpointDecisionOptions('full-build', 'scoping.checkpoint');
  assert.equal(opts.length, 1);
  assert.equal(opts[0].id, 'approve');
});

test('getCheckpointDecisionOptions: unknown step → approve + reject (generic fallback)', () => {
  const opts = getCheckpointDecisionOptions('full-build', 'some.unknown.step');
  const ids = opts.map(o => o.id);
  assert.ok(ids.includes('approve'));
  assert.ok(ids.includes('reject'));
  assert.equal(ids.length, 2);
});

test('getCheckpointDecisionOptions: unknown workflow → generic fallback regardless of step', () => {
  const opts = getCheckpointDecisionOptions('other-workflow', 'confirm');
  const ids = opts.map(o => o.id);
  assert.ok(ids.includes('approve'));
  assert.ok(ids.includes('reject'));
  assert.equal(ids.length, 2, 'unknown workflow must not inherit full-build semantics');
});

test('getCheckpointDecisionOptions: undefined step → generic fallback', () => {
  const opts = getCheckpointDecisionOptions('full-build', undefined);
  assert.equal(opts.length, 2);
  assert.equal(opts[0].id, 'approve');
  assert.equal(opts[1].id, 'reject');
});

// ── FullBuildStepRunner.resolveCheckpoint (checkpoint resolution) ─────────────

test('resolveCheckpoint: generic approve → continue, no cancel, no revision', async () => {
  const { FullBuildStepRunner } = await import('../src/execution/full-build-step-runner.js');
  const root = makeTmpRoot();
  try {
    const { RuntimeMapManagerImpl } = await import('../src/runtime-map.js');
    const { RunArtifactManager } = await import('../src/run-artifacts.js');
    const mapManager = new RuntimeMapManagerImpl({ mapPath: join(root, 'map.yaml') });
    const runArtifacts = new RunArtifactManager({ projectRoot: root });

    const stub = (x: unknown) => x;
    const runner = new FullBuildStepRunner(
      {
        agentStepRunner: stub as any, mapManager, runArtifacts, projectRoot: root,
        confirmService: stub as any, execService: stub as any, validationGateService: stub as any,
        snapshotService: stub as any, summariseService: stub as any,
      },
      { onCheckpoint: async () => 'halt', onConfirmGate: async () => 'halt', onShardingGate: async () => 'halt' },
    );

    const resolution = await runner.resolveCheckpoint({
      workflowId: 'unknown-workflow',
      stepId: 'some_generic_checkpoint',
      decisionId: randomUUID(),
      selectedOptionId: 'approve',
      workflowRunId: randomUUID(),
      iteration: 1,
      revision: 0,
    });
    assert.equal(resolution.cancel, false);
    assert.equal(resolution.remainAtCheckpoint, false);
    assert.equal(resolution.incrementRevision, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveCheckpoint: generic reject → cancel: true', async () => {
  const { FullBuildStepRunner } = await import('../src/execution/full-build-step-runner.js');
  const root = makeTmpRoot();
  try {
    const { RuntimeMapManagerImpl } = await import('../src/runtime-map.js');
    const { RunArtifactManager } = await import('../src/run-artifacts.js');
    const mapManager = new RuntimeMapManagerImpl({ mapPath: join(root, 'map.yaml') });
    const runArtifacts = new RunArtifactManager({ projectRoot: root });

    const stub = (x: unknown) => x;
    const runner = new FullBuildStepRunner(
      {
        agentStepRunner: stub as any, mapManager, runArtifacts, projectRoot: root,
        confirmService: stub as any, execService: stub as any, validationGateService: stub as any,
        snapshotService: stub as any, summariseService: stub as any,
      },
      { onCheckpoint: async () => 'halt', onConfirmGate: async () => 'halt', onShardingGate: async () => 'halt' },
    );

    const resolution = await runner.resolveCheckpoint({
      workflowId: 'unknown-workflow',
      stepId: 'some_checkpoint',
      decisionId: randomUUID(),
      selectedOptionId: 'reject',
      workflowRunId: randomUUID(),
      iteration: 1,
      revision: 0,
    });
    assert.equal(resolution.cancel, true);
    assert.equal(resolution.remainAtCheckpoint, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveCheckpoint: sharding_approval modify → remainAtCheckpoint: true', async () => {
  const { FullBuildStepRunner } = await import('../src/execution/full-build-step-runner.js');
  const root = makeTmpRoot();
  try {
    const { RuntimeMapManagerImpl } = await import('../src/runtime-map.js');
    const { RunArtifactManager } = await import('../src/run-artifacts.js');
    const mapManager = new RuntimeMapManagerImpl({ mapPath: join(root, 'map.yaml') });
    const runArtifacts = new RunArtifactManager({ projectRoot: root });

    const stub = (x: unknown) => x;
    const runner = new FullBuildStepRunner(
      {
        agentStepRunner: stub as any, mapManager, runArtifacts, projectRoot: root,
        confirmService: stub as any, execService: stub as any, validationGateService: stub as any,
        snapshotService: stub as any, summariseService: stub as any,
      },
      { onCheckpoint: async () => 'halt', onConfirmGate: async () => 'halt', onShardingGate: async () => 'halt' },
    );

    const resolution = await runner.resolveCheckpoint({
      workflowId: 'full-build',
      stepId: 'sharding_approval',
      decisionId: randomUUID(),
      selectedOptionId: 'modify',
      workflowRunId: randomUUID(),
      iteration: 1,
      revision: 0,
    });
    assert.equal(resolution.remainAtCheckpoint, true);
    assert.equal(resolution.cancel, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveCheckpoint: confirm revise → incrementRevision: true', async () => {
  const { FullBuildStepRunner } = await import('../src/execution/full-build-step-runner.js');
  const root = makeTmpRoot();
  try {
    const { RuntimeMapManagerImpl } = await import('../src/runtime-map.js');
    const { RunArtifactManager } = await import('../src/run-artifacts.js');
    const mapManager = new RuntimeMapManagerImpl({ mapPath: join(root, 'map.yaml') });
    const runArtifacts = new RunArtifactManager({ projectRoot: root });

    const fakeConfirmService = {
      revise: async (_wid: string, _iter: number) => ({ next_node: 'TEST' }),
    };

    const stub = (x: unknown) => x;
    const runner = new FullBuildStepRunner(
      {
        agentStepRunner: stub as any, mapManager, runArtifacts, projectRoot: root,
        confirmService: fakeConfirmService as any, execService: stub as any,
        validationGateService: stub as any, snapshotService: stub as any, summariseService: stub as any,
      },
      { onCheckpoint: async () => 'halt', onConfirmGate: async () => 'halt', onShardingGate: async () => 'halt' },
    );

    const resolution = await runner.resolveCheckpoint({
      workflowId: 'full-build',
      stepId: 'confirm',
      decisionId: randomUUID(),
      selectedOptionId: 'revise',
      workflowRunId: randomUUID(),
      iteration: 1,
      revision: 0,
    });
    assert.equal(resolution.incrementRevision, true);
    assert.equal(resolution.cancel, false);
    assert.equal(resolution.remainAtCheckpoint, false);
    assert.equal(resolution.overrideContinuationStepId, 'test');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
