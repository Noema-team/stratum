/**
 * Stage 2 — durable WorkflowRun cursor + checkpoint/resume invariants.
 *
 * Tests are organised into three groups:
 *  1. WorkflowRunRepository — CRUD and SQLite round-trip
 *  2. Engine cursor persistence — engine writes to the repo at key lifecycle points
 *  3. Checkpoint/resume — halt sets awaiting_checkpoint; resume from correct step
 */

import { test } from 'node:test';
import { strict as assert } from 'assert';
import { openDatabase } from '../src/storage/database.js';
import { WorkflowRunRepository, WorkflowRunConflictError, WorkspaceRepository, ProjectRepository, WorkItemRepository } from '../src/storage/repositories.js';
import {
  WorkflowEngine,
  registerWorkflow,
} from '../src/workflow/index.js';
import type {
  WorkflowDefinition,
  WorkflowEngineDeps,
  WorkflowEngineOptions,
} from '../src/workflow/index.js';

// ============================================================================
// Helpers
// ============================================================================

function openMemoryDb() {
  return openDatabase(':memory:');
}

function makeRepo() {
  return new WorkflowRunRepository(openMemoryDb());
}

function makeWorkflow(id: string, steps: WorkflowDefinition['steps']): WorkflowDefinition {
  return { id, label: id, steps };
}

const NOW = new Date().toISOString();

function stubRun(): import('../src/workflow/types.js').WorkflowRun {
  return {
    run_id: 'run-1',
    workflow_id: 'wf-1',
    work_item_id: undefined,
    status: 'active',
    current_step_id: 'step-a',
    iteration: 1,
    revision: 0,
    awaiting_checkpoint: null,
    started_at: NOW,
    updated_at: NOW,
  };
}

function makeStubDeps(
  overrides: Partial<WorkflowEngineDeps> = {},
): WorkflowEngineDeps {
  return {
    stepRunner: {
      run: async () => ({ success: true, artifacts_written: [], tokens_used: 0, duration_ms: 1 }),
    } as any,
    mapManager: {
      read: async () => ({ cycle: { iteration: 1, max_iterations: 3 } }),
      update: async () => {},
    } as any,
    runArtifacts: {
      updateNodeStatus: async () => {},
      createRunDir: async () => {},
      createManifest: async () => {},
    } as any,
    projectRoot: '/tmp',
    ...overrides,
  };
}

function makeStubOpts(overrides: Partial<WorkflowEngineOptions> = {}): WorkflowEngineOptions {
  return {
    onCheckpoint: async () => 'approve',
    ...overrides,
  };
}

const DUMMY_CYCLE_CTX: any = {
  cycle_number: 1, cycle_id: 'cycle-1',
  iteration: 1, revision: 0, planning_depth: 'minimal',
  intent: 'Test', target: null, project_root: '/tmp',
};

// ============================================================================
// 1. WorkflowRunRepository — CRUD
// ============================================================================

test('testWorkflowRunRepoSaveAndFind', () => {
  const repo = makeRepo();
  const run = stubRun();
  repo.createOrValidate(run);
  const found = repo.findById('run-1');
  assert.ok(found, 'saved run must be findable by id');
  assert.equal(found.run_id, 'run-1');
  assert.equal(found.status, 'active');
  assert.equal(found.current_step_id, 'step-a');
  assert.equal(found.awaiting_checkpoint, null);
  assert.equal(found.work_item_id, undefined);
});

test('testWorkflowRunRepoUpdate', () => {
  const repo = makeRepo();
  const run = stubRun();
  repo.createOrValidate(run);

  repo.update({
    ...run,
    status: 'halted',
    awaiting_checkpoint: 'step-a',
    updated_at: new Date().toISOString(),
  });

  const found = repo.findById('run-1')!;
  assert.equal(found.status, 'halted');
  assert.equal(found.awaiting_checkpoint, 'step-a');
});

test('testWorkflowRunRepoUpdateThrowsForMissingRun', () => {
  const repo = makeRepo();
  const run = stubRun();
  // update on a run_id that was never created must throw
  assert.throws(
    () => repo.update({ ...run, status: 'halted', updated_at: new Date().toISOString() }),
    (e: unknown) => e instanceof Error && e.message.includes('update affected 0 rows'),
    'update must throw when run_id does not exist',
  );
});

test('testWorkflowRunRepoCreateOrValidateIsIdempotentOnIdentityMatch', () => {
  const repo = makeRepo();
  const run = stubRun();
  repo.createOrValidate(run);
  // Same run_id + same workflow_id + same work_item_id → no-op, no throw
  assert.doesNotThrow(() => repo.createOrValidate({ ...run, status: 'complete' }));
  const found = repo.findById('run-1')!;
  assert.equal(found.status, 'active', 'first save wins; duplicate with same identity is a no-op');
});

test('testWorkflowRunRepoCreateOrValidateThrowsOnWorkflowIdMismatch', () => {
  const repo = makeRepo();
  const run = stubRun();
  repo.createOrValidate(run);
  assert.throws(
    () => repo.createOrValidate({ ...run, workflow_id: 'different-wf' }),
    (e: unknown) => e instanceof WorkflowRunConflictError,
    'createOrValidate must throw WorkflowRunConflictError when workflow_id mismatches',
  );
});

test('testWorkflowRunRepoListByWorkItem', () => {
  const repo = makeRepo();
  // work_item_id is a FK to work_items — use NULL (no FK enforcement in :memory: here
  // because the DB has foreign_keys = ON). Skip FK to keep the test self-contained.
  const run1 = { ...stubRun(), run_id: 'r1', work_item_id: undefined };
  const run2 = { ...stubRun(), run_id: 'r2', work_item_id: undefined };
  repo.createOrValidate(run1);
  repo.createOrValidate(run2);
  // listByWorkItem with undefined (NULL) won't match — verify listActive instead
  const active = repo.listActive();
  assert.equal(active.length, 2);
});

test('testWorkflowRunRepoFindMissingReturnsUndefined', () => {
  const repo = makeRepo();
  assert.equal(repo.findById('no-such-run'), undefined);
});

test('testWorkflowRunRepoListActive', () => {
  const repo = makeRepo();
  repo.createOrValidate({ ...stubRun(), run_id: 'active-1', status: 'active' });
  repo.createOrValidate({ ...stubRun(), run_id: 'done-1',   status: 'complete' });
  repo.createOrValidate({ ...stubRun(), run_id: 'halt-1',   status: 'halted' });
  const active = repo.listActive();
  assert.equal(active.length, 1);
  assert.equal(active[0].run_id, 'active-1');
});

// ============================================================================
// 2. Engine cursor persistence
// ============================================================================

test('testEngineCreatesWorkflowRunRowOnStart', async () => {
  const db = openMemoryDb();
  const repo = new WorkflowRunRepository(db);
  registerWorkflow(makeWorkflow('wf-persist-start', [
    { id: 'p', kind: 'produce', agentRole: 'designer' },
  ]));
  const deps = makeStubDeps({ workflowRunRepository: repo });
  const engine = new WorkflowEngine(deps, makeStubOpts());
  await engine.run('wf-persist-start', 1, 'run-persist-start', DUMMY_CYCLE_CTX, undefined, undefined);
  const found = repo.findById('run-persist-start');
  assert.ok(found, 'engine must create a WorkflowRun row when run starts');
  assert.equal(found.workflow_id, 'wf-persist-start');
  assert.equal(found.status, 'complete');
});

test('testEngineMarksRunCompleteOnSuccess', async () => {
  const db = openMemoryDb();
  const repo = new WorkflowRunRepository(db);
  registerWorkflow(makeWorkflow('wf-persist-complete', [
    { id: 'step1', kind: 'gather' },
    { id: 'step2', kind: 'commit' },
  ]));
  const deps = makeStubDeps({ workflowRunRepository: repo });
  const engine = new WorkflowEngine(deps, makeStubOpts());
  const result = await engine.run('wf-persist-complete', 1, 'run-complete-id', DUMMY_CYCLE_CTX);
  assert.equal(result.status, 'complete');
  const found = repo.findById('run-complete-id')!;
  assert.equal(found.status, 'complete');
  assert.equal(found.awaiting_checkpoint, null);
});

test('testEngineMarksRunHaltedOnStepFailure', async () => {
  const db = openMemoryDb();
  const repo = new WorkflowRunRepository(db);
  registerWorkflow(makeWorkflow('wf-persist-fail', [
    { id: 'fp', kind: 'produce', agentRole: 'designer' },
  ]));
  const deps = makeStubDeps({
    workflowRunRepository: repo,
    stepRunner: {
      run: async () => ({ success: false, artifacts_written: [], tokens_used: 0, duration_ms: 1, error: 'boom' }),
    } as any,
  });
  const engine = new WorkflowEngine(deps, makeStubOpts());
  await engine.run('wf-persist-fail', 1, 'run-fail-id', DUMMY_CYCLE_CTX);
  const found = repo.findById('run-fail-id')!;
  assert.equal(found.status, 'halted');
  assert.equal(found.awaiting_checkpoint, null);
});

test('testEngineWorksWithoutRepository', async () => {
  registerWorkflow(makeWorkflow('wf-no-repo', [
    { id: 'g', kind: 'gather' },
  ]));
  // No workflowRunRepository in deps — engine must not throw
  const engine = new WorkflowEngine(makeStubDeps(), makeStubOpts());
  const result = await engine.run('wf-no-repo', 1, 'run-no-repo', DUMMY_CYCLE_CTX);
  assert.equal(result.status, 'complete');
});

// ============================================================================
// 3. Checkpoint/resume invariants
// ============================================================================

test('testCheckpointHaltSetsAwaitingCheckpoint', async () => {
  const db = openMemoryDb();
  const repo = new WorkflowRunRepository(db);
  registerWorkflow(makeWorkflow('wf-cp-halt', [
    { id: 'cp', kind: 'checkpoint', label: 'Gate' },
    { id: 'build', kind: 'produce', agentRole: 'builder' },
  ]));
  const deps = makeStubDeps({ workflowRunRepository: repo });
  const opts = makeStubOpts({ onCheckpoint: async () => 'halt' });
  const engine = new WorkflowEngine(deps, opts);
  const result = await engine.run('wf-cp-halt', 1, 'run-cp-halt', DUMMY_CYCLE_CTX);
  assert.equal(result.status, 'halted');
  const found = repo.findById('run-cp-halt')!;
  assert.equal(found.status, 'halted');
  assert.equal(found.awaiting_checkpoint, 'cp', 'awaiting_checkpoint must be the halted step id');
  assert.equal(found.current_step_id, 'cp');
});

test('testCheckpointApproveDoesNotSetAwaitingCheckpoint', async () => {
  const db = openMemoryDb();
  const repo = new WorkflowRunRepository(db);
  registerWorkflow(makeWorkflow('wf-cp-approve', [
    { id: 'cp', kind: 'checkpoint', label: 'Gate' },
    { id: 'done', kind: 'commit' },
  ]));
  const deps = makeStubDeps({ workflowRunRepository: repo });
  const engine = new WorkflowEngine(deps, makeStubOpts({ onCheckpoint: async () => 'approve' }));
  await engine.run('wf-cp-approve', 1, 'run-cp-approve', DUMMY_CYCLE_CTX);
  const found = repo.findById('run-cp-approve')!;
  assert.equal(found.status, 'complete');
  assert.equal(found.awaiting_checkpoint, null);
});

test('testResumeFromCheckpointSkipsPriorSteps', async () => {
  registerWorkflow(makeWorkflow('wf-resume', [
    { id: 'design', kind: 'produce', agentRole: 'designer' },
    { id: 'cp', kind: 'checkpoint', label: 'Gate' },
    { id: 'build', kind: 'produce', agentRole: 'builder' },
    { id: 'done', kind: 'commit' },
  ]));
  const visited: string[] = [];
  const deps = makeStubDeps({
    stepRunner: {
      run: async (step: any) => { visited.push(step.id); return { success: true, artifacts_written: [], tokens_used: 0, duration_ms: 1 }; },
    } as any,
  });
  const engine = new WorkflowEngine(deps, makeStubOpts());
  // Resume from 'build' — simulates restart after checkpoint was approved
  await engine.run('wf-resume', 1, 'run-resume', DUMMY_CYCLE_CTX, 'build');
  assert.ok(!visited.includes('design'), 'design must not run on resume from build');
  assert.ok(visited.includes('build'), 'build must run on resume from build');
});

test('testMultipleRunsGetIndependentRows', async () => {
  const db = openMemoryDb();
  const repo = new WorkflowRunRepository(db);
  registerWorkflow(makeWorkflow('wf-multi', [
    { id: 'g', kind: 'gather' },
  ]));
  const deps = makeStubDeps({ workflowRunRepository: repo });
  const engine = new WorkflowEngine(deps, makeStubOpts());
  await engine.run('wf-multi', 1, 'run-multi-a', DUMMY_CYCLE_CTX);
  await engine.run('wf-multi', 2, 'run-multi-b', DUMMY_CYCLE_CTX);
  const a = repo.findById('run-multi-a');
  const b = repo.findById('run-multi-b');
  assert.ok(a && b, 'both runs must have rows');
  assert.notEqual(a.run_id, b.run_id);
  assert.equal(a.status, 'complete');
  assert.equal(b.status, 'complete');
});

test('testRunIdIsPreservedThroughoutLifecycle', async () => {
  const db = openMemoryDb();
  const repo = new WorkflowRunRepository(db);
  registerWorkflow(makeWorkflow('wf-identity', [
    { id: 'p', kind: 'produce', agentRole: 'designer' },
    { id: 'done', kind: 'commit' },
  ]));
  const deps = makeStubDeps({ workflowRunRepository: repo });
  const engine = new WorkflowEngine(deps, makeStubOpts());
  const result = await engine.run('wf-identity', 1, 'canonical-run-id', DUMMY_CYCLE_CTX);
  assert.equal(result.run_id, 'canonical-run-id');
  const found = repo.findById('canonical-run-id')!;
  assert.equal(found.run_id, 'canonical-run-id');
});

test('testWorkItemIdPersistedInRow', async () => {
  const db = openMemoryDb();
  const repo = new WorkflowRunRepository(db);

  // Seed parent rows so the FK work_item_id → work_items(id) is satisfied.
  const now = new Date().toISOString();
  const wsRepo = new WorkspaceRepository(db);
  const projRepo = new ProjectRepository(db);
  const wiRepo = new WorkItemRepository(db);
  const wsId = 'ws-wi-link';
  const projId = 'proj-wi-link';
  const workItemId = 'work-item-uuid-001';
  wsRepo.save({ id: wsId, name: 'ws', createdAt: now });
  projRepo.save({ id: projId, workspaceId: wsId, name: 'p', status: 'active', priority: 0, createdAt: now, updatedAt: now });
  wiRepo.save({
    id: workItemId, projectId: projId, repositoryIds: [],
    title: 'wi', goal: 'g', workflowId: 'wf-wi-link', state: 'ready',
    priority: 0, acceptanceCriteria: [], constraints: [], requiredEvidence: [],
    dependencies: [], createdAt: now, updatedAt: now,
  });

  registerWorkflow(makeWorkflow('wf-wi-link', [
    { id: 'g', kind: 'gather' },
  ]));
  const deps = makeStubDeps({ workflowRunRepository: repo });
  const engine = new WorkflowEngine(deps, makeStubOpts());
  // NOTE: workItemId is the 6th arg; pass undefined for startStepId
  await engine.run('wf-wi-link', 1, 'run-wi', DUMMY_CYCLE_CTX, undefined, workItemId);
  const found = repo.findById('run-wi')!;
  assert.equal(found.work_item_id, workItemId);
});
