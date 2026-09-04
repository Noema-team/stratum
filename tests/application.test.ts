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
import { ResumeService } from '../src/services/resume-service.js';
import { SchedulerLoop, createStratumApplication, buildAgentRunner } from '../src/application.js';
import { getCheckpointDecisionOptions } from '../src/execution/checkpoint-resolver.js';
import {
  WorkspaceRepository,
  ProjectRepository,
  WorkItemRepository,
  DecisionRepository,
  WorkflowRunRepository,
  ArtifactRepository,
} from '../src/storage/repositories.js';
import { registerWorkflow } from '../src/workflow/registry.js';
import { ContextManager } from '../src/context-manager.js';
import { RunArtifactManager } from '../src/run-artifacts.js';
import type { ILLMProvider, LLMCompletionParams, LLMCompletionResult } from '../src/llm-provider.js';
import type { ExecutionAdapter, ExecutionRequest, ExecutionResult, CapabilitySet } from '../src/execution/types.js';
import type { Workspace, Project, WorkItem } from '../src/domain/index.js';

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

// ── D.3b1.2: resolved application model reaches AgentRunner ───────────────────
//
// createStratumApplication() previously constructed AgentRunner with its
// runnerConfig argument undefined, so AgentRunner defaulted to
// { model: 'default' } — a truthy sentinel that, for a provider resolving
// `params.model || this.defaultModel` (e.g. AnthropicSDKProvider), silently
// overrode the actually-configured model. buildAgentRunner is the exact
// composition-root seam createStratumApplication now delegates to; this
// exercises it directly against a capturing single-turn provider stub.

class CapturingLLMProvider implements ILLMProvider {
  calls: LLMCompletionParams[] = [];
  async complete(params: LLMCompletionParams): Promise<LLMCompletionResult> {
    this.calls.push(params);
    return {
      content: [
        '<!-- SLE-OUTPUT', 'role: explorer', 'node: probe', 'artifacts:',
        '  - id: probe', '    path: .sle/work/probe.md', '-->', '',
        '## .sle/work/probe.md', '', 'ok',
      ].join('\n'),
      tokens_used: 1, duration_ms: 1,
    };
  }
}

test('D.3b1.2: buildAgentRunner threads the resolved application model into AgentRunner, not the "default" sentinel', async () => {
  const root = makeTmpRoot();
  try {
    const db = openDatabase(':memory:');
    const provider = new CapturingLLMProvider();
    const cm = new ContextManager(root);
    const runArtifacts = new RunArtifactManager({ projectRoot: root });
    const artifactRepository = new ArtifactRepository(db);

    const agentRunner = buildAgentRunner(cm, provider, root, runArtifacts, 'claude-configured-model', artifactRepository);

    const result = await agentRunner.run('explorer', {
      workflowRunId: 'r1', workflowId: 'd3b1-2-model-probe', stepId: 'probe',
      iteration: 1, revision: 0, goal: 'probe', projectRoot: root,
      outputArtifact: { type: 'probe', ref: 'probe:1', path: '.sle/work/probe.md' },
    } as any);

    assert.ok(result.success, result.error);
    assert.equal(provider.calls.length, 1);
    assert.equal(
      provider.calls[0].model, 'claude-configured-model',
      'AgentRunner must send the resolved application model, not the "default" sentinel',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Canonical WorkService / evidence guard ────────────────────────────────────

// ── WorkService injection: observable via TrackedWorkService ──────────────────
// Subclass WorkService to intercept and record calls — proves the injected
// instance is invoked for state transitions, not a silently-created second one.

class TrackedWorkService extends WorkService {
  readonly log: string[] = [];

  startRunning(req: Parameters<WorkService['startRunning']>[0]) {
    this.log.push('startRunning');
    return super.startRunning(req);
  }

  needsDecision(req: Parameters<WorkService['needsDecision']>[0]) {
    this.log.push('needsDecision');
    return super.needsDecision(req);
  }

  resolveDecision(...args: Parameters<WorkService['resolveDecision']>) {
    this.log.push('resolveDecision');
    return super.resolveDecision(...args);
  }
}

// Register a minimal test workflow with a checkpoint step for ResumeService tests.
const WS_INJECTION_WF_ID = `ws-injection-test-${randomUUID()}`;
registerWorkflow({
  id: WS_INJECTION_WF_ID,
  label: 'WorkService injection test workflow',
  steps: [
    { id: 'step-a', kind: 'produce', label: 'Before checkpoint' },
    { id: 'step-ck', kind: 'checkpoint', label: 'Checkpoint' },
    { id: 'step-b', kind: 'produce', label: 'After checkpoint' },
  ],
});

test('WorkService injection: Scheduler.startRunning invokes the injected instance', async () => {
  const db = openDatabase(':memory:');
  const wsId = randomUUID();

  // Set up the minimal DB state: workspace + project + work item in 'ready'.
  const now = new Date().toISOString();
  const workspace: Workspace = { id: wsId, name: 'ws', createdAt: now };
  new WorkspaceRepository(db).save(workspace);

  const project: Project = {
    id: randomUUID(), workspaceId: wsId, name: 'p',
    status: 'active', priority: 0, createdAt: now, updatedAt: now,
  };
  new ProjectRepository(db).save(project);

  const item: WorkItem = {
    id: randomUUID(), projectId: project.id, repositoryIds: [],
    title: 'injection-test', goal: 'test', workflowId: 'full-build',
    state: 'ready', priority: 0,
    acceptanceCriteria: [], constraints: [], requiredEvidence: [],
    dependencies: [], createdAt: now, updatedAt: now,
  };
  new WorkItemRepository(db).save(item);

  // Inject the tracked service into Scheduler.
  // The stub must use id 'stratum-agent' so selectAdapter() finds it.
  const workService = new TrackedWorkService(db, wsId);
  const registry = new ExecutorRegistry();
  registry.register({ ...makeStubAdapter({ outcome: 'succeeded' }), id: 'stratum-agent' });
  const scheduler = new Scheduler(db, wsId, registry, {}, workService);

  await scheduler.tick();

  assert.ok(
    workService.log.includes('startRunning'),
    `Scheduler must call injected workService.startRunning — got: ${JSON.stringify(workService.log)}`,
  );
  db.close();
});

test('WorkService injection: ResumeService.resolveDecision invokes the injected instance', async () => {
  const db = openDatabase(':memory:');
  const wsId = randomUUID();
  const now = new Date().toISOString();

  // Set up workspace + project.
  const workspace: Workspace = { id: wsId, name: 'ws', createdAt: now };
  new WorkspaceRepository(db).save(workspace);
  const project: Project = {
    id: randomUUID(), workspaceId: wsId, name: 'p',
    status: 'active', priority: 0, createdAt: now, updatedAt: now,
  };
  new ProjectRepository(db).save(project);

  // Work item in 'needs_decision' state (direct insert bypasses transition guards).
  const workItemId = randomUUID();
  const item: WorkItem = {
    id: workItemId, projectId: project.id, repositoryIds: [],
    title: 'resume-injection-test', goal: 'test', workflowId: WS_INJECTION_WF_ID,
    state: 'needs_decision', priority: 0,
    acceptanceCriteria: [], constraints: [], requiredEvidence: [],
    dependencies: [], createdAt: now, updatedAt: now,
  };
  new WorkItemRepository(db).save(item);

  // WorkflowRun halted at the checkpoint step.
  const runId = randomUUID();
  new WorkflowRunRepository(db).createOrValidate({
    run_id: runId,
    workflow_id: WS_INJECTION_WF_ID,
    work_item_id: workItemId,
    status: 'halted',
    current_step_id: 'step-ck',
    iteration: 1,
    revision: 0,
    awaiting_checkpoint: 'step-ck',
    started_at: now,
    updated_at: now,
  });

  // Decision referencing the run.
  const decisionId = randomUUID();
  new DecisionRepository(db).save({
    id: decisionId,
    projectId: project.id,
    workItemId,
    type: 'checkpoint',
    subjectRef: { workflowRunId: runId, workItemId, stepId: 'step-ck' },
    title: 'Resume test',
    summary: 'test',
    options: [{ id: 'approve', label: 'Approve', description: 'continue' }],
    impact: 'low',
    reversibility: 'easy',
    urgency: 'normal',
    status: 'pending',
  });

  // Inject the tracked service into ResumeService.
  // The stub must use id 'stratum-agent' so selectAdapter() finds it.
  const workService = new TrackedWorkService(db, wsId);
  const registry = new ExecutorRegistry();
  registry.register({ ...makeStubAdapter({ outcome: 'succeeded' }), id: 'stratum-agent' });
  const resumeService = new ResumeService(db, wsId, registry, {}, workService);

  await resumeService.resume(decisionId, { selectedOptionId: 'approve' });

  assert.ok(
    workService.log.includes('resolveDecision'),
    `ResumeService must call injected workService.resolveDecision — got: ${JSON.stringify(workService.log)}`,
  );
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
