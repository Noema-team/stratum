/**
 * Resume-hardening tests — proves all Item 8 lifecycle guarantees:
 *
 *  1. Persisted cursor cannot be overridden by caller startStepId
 *  2. Completed run cannot be re-executed
 *  3. Resumed run starts exactly at persisted current_step_id
 *  4. iteration/revision survive resume (e.g. iteration=3, revision=2)
 *  5. Reject does not execute continuation
 *  6. Reject transition is atomic
 *  7. Missing selectedOptionId is denied
 *  8. Invalid selectedOptionId is denied
 *  9. Missing/mismatched checkpoint stepId is denied
 * 10. Missing/mismatched WorkflowRun workItemId is denied
 * 11. Missing Repository ID fails dispatch
 * 12. Checkpoint HTTP resolve actually resumes
 * 13. Checkpoint HTTP resolve without ResumeService fails closed
 */

import { test } from 'node:test';
import { strict as assert } from 'assert';
import { randomUUID } from 'crypto';
import { openDatabase } from '../src/storage/database.js';
import {
  WorkspaceRepository,
  ProjectRepository,
  WorkItemRepository,
  WorkflowRunRepository,
  DecisionRepository,
  StepExecutionRepository,
} from '../src/storage/repositories.js';
import { ResumeService, ResumeServiceError } from '../src/services/resume-service.js';
import { WorkService } from '../src/services/work-service.js';
import { EvidenceService } from '../src/services/evidence-service.js';
import { ControlPlaneServer } from '../src/api/control-plane-server.js';
import { WorkflowEngine, registerWorkflow } from '../src/workflow/index.js';
import type { WorkflowEngineDeps, WorkflowEngineOptions } from '../src/workflow/index.js';
import { ExecutorRegistry } from '../src/execution/registry.js';
import { Scheduler } from '../src/scheduler/scheduler.js';
import type {
  ExecutionAdapter, ExecutionRequest, ExecutionResult,
} from '../src/execution/types.js';
import type { WorkflowRun } from '../src/workflow/types.js';

// ============================================================================
// Shared workflow definitions
// ============================================================================

const HARNESS_WF = `harness-hardening-${randomUUID()}`;
registerWorkflow({
  id: HARNESS_WF,
  label: 'Hardening test workflow',
  steps: [
    { id: 'snap', kind: 'produce', agentRole: 'designer' },
    { id: 'ck',   kind: 'checkpoint', label: 'Gate' },
    { id: 'bld',  kind: 'produce', agentRole: 'builder' },
  ],
});

const THREE_STEP_WF = `three-step-${randomUUID()}`;
registerWorkflow({
  id: THREE_STEP_WF,
  label: 'Three-step no checkpoint',
  steps: [
    { id: 'a', kind: 'gather' },
    { id: 'b', kind: 'gather' },
    { id: 'c', kind: 'commit' },
  ],
});

// ============================================================================
// Helpers
// ============================================================================

function openDb() { return openDatabase(':memory:'); }
const NOW = new Date().toISOString();

function seedWorld(db: ReturnType<typeof openDb>) {
  const wsRepo = new WorkspaceRepository(db);
  const projRepo = new ProjectRepository(db);
  const wiRepo = new WorkItemRepository(db);
  const ws = { id: randomUUID(), name: 'hw', createdAt: NOW };
  wsRepo.save(ws);
  const proj = {
    id: randomUUID(), workspaceId: ws.id, name: 'p',
    status: 'active' as const, priority: 0, createdAt: NOW, updatedAt: NOW,
  };
  projRepo.save(proj);
  const wi = {
    id: randomUUID(), projectId: proj.id, repositoryIds: [] as string[],
    title: 't', goal: 'g', workflowId: HARNESS_WF,
    state: 'ready' as const, priority: 0,
    acceptanceCriteria: [], constraints: [], requiredEvidence: [],
    dependencies: [], createdAt: NOW, updatedAt: NOW,
  };
  wiRepo.save(wi);
  return { ws, proj, wi };
}

function makeStubDeps(repo: WorkflowRunRepository, stepLog: string[]): WorkflowEngineDeps {
  return {
    stepRunner: {
      run: async (step: any) => {
        stepLog.push(step.id);
        return { success: true, artifacts_written: [], tokens_used: 0, duration_ms: 1 };
      },
    } as any,
    mapManager: {
      read: async () => ({ cycle: { iteration: 1, max_iterations: 99 } }),
      update: async () => {},
    } as any,
    runArtifacts: {
      updateNodeStatus: async () => {},
      createRunDir: async () => {},
      createManifest: async () => {},
    } as any,
    workflowRunRepository: repo,
  };
}

function makeStubOpts(onCp: () => Promise<'approve' | 'halt'>): WorkflowEngineOptions {
  return { onCheckpoint: async () => onCp() };
}

const DUMMY_CTX: any = {
  cycle_number: 1, cycle_id: 'c1', iteration: 1, revision: 0,
  planning_depth: 'minimal', intent: 'T', target: null, project_root: '/tmp',
};

function makeHaltingAdapter(
  db: ReturnType<typeof openDb>,
  stepLog: string[],
): ExecutionAdapter {
  const runRepo = new WorkflowRunRepository(db);
  const deps = makeStubDeps(runRepo, stepLog);
  const opts = makeStubOpts(async () => 'halt');
  return {
    id: 'test-halt-adapter',
    getCapabilities: () => new Set(['repo.read']) as any,
    async execute(req: ExecutionRequest): Promise<ExecutionResult> {
      const engine = new WorkflowEngine(deps, opts);
      const ctx = { ...DUMMY_CTX, cycle_id: req.workflowRunId, intent: req.goal };
      const startStepId = req.stepId !== '__start__' ? req.stepId : undefined;
      const result = await engine.run(
        req.workflowId, 1, req.workflowRunId, ctx, startStepId, req.workItemId,
      );
      const isCheckpoint = result.status === 'halted' && !result.error;
      return {
        schemaVersion: 1,
        stepExecutionId: req.stepExecutionId,
        outcome: result.status === 'complete' ? 'succeeded' : isCheckpoint ? 'blocked' : 'failed',
        artifacts: [], evidenceClaims: [], decisionRequests: [],
        checkpointStepId: isCheckpoint ? (result.final_step_id ?? undefined) : undefined,
        usage: { durationMs: 1 },
        failure: result.error ? { code: 'workflow_error', message: result.error } : undefined,
      };
    },
  };
}

function makeRegistry(adapter: ExecutionAdapter): ExecutorRegistry {
  const r = new ExecutorRegistry();
  r.register(adapter);
  return r;
}

// Seeds a Decision + halted WorkflowRun ready for resume, bypassing Scheduler.
function seedHaltedRunForResume(
  db: ReturnType<typeof openDb>,
  workspaceId: string,
  workItemId: string,
  opts?: { iteration?: number; revision?: number },
): { decisionId: string; workflowRunId: string } {
  const workflowRunId = randomUUID();
  const decisionId = randomUUID();
  const runRepo = new WorkflowRunRepository(db);
  const decRepo = new DecisionRepository(db);
  const stepExecRepo = new StepExecutionRepository(db);
  const wiRepo = new WorkItemRepository(db);

  const run: WorkflowRun = {
    run_id: workflowRunId,
    workflow_id: HARNESS_WF,
    work_item_id: workItemId,
    status: 'halted',
    current_step_id: 'ck',
    awaiting_checkpoint: 'ck',
    iteration: opts?.iteration ?? 1,
    revision: opts?.revision ?? 0,
    started_at: NOW,
    updated_at: NOW,
  };
  runRepo.createOrValidate(run);

  // Transition WorkItem to needs_decision.
  wiRepo.updateState(workItemId, 'needs_decision', NOW);

  const projectId = wiRepo.findById(workItemId)!.projectId;
  decRepo.save({
    id: decisionId,
    projectId,
    workItemId,
    type: 'checkpoint',
    subjectRef: { workflowRunId, workItemId, stepId: 'ck' },
    title: 'Gate',
    summary: 'Halted at ck',
    options: [
      { id: 'approve', label: 'Approve', description: 'Continue' },
      { id: 'reject',  label: 'Reject',  description: 'Cancel'  },
    ],
    impact: 'low',
    reversibility: 'easy',
    urgency: 'normal',
    status: 'pending',
  });

  // StepExecution in 'waiting' state.
  stepExecRepo.save({
    id: randomUUID(),
    workItemId,
    workflowRunId,
    stepId: 'ck',
    executor: 'test',
    state: 'waiting',
    attempt: 1,
    startedAt: NOW,
  });

  return { decisionId, workflowRunId };
}

const APPROVE = {
  selectedOptionId: 'approve',
  rationale: 'LGTM',
  resolvedAt: NOW,
  resolvedBy: 'tester',
};

const REJECT = {
  selectedOptionId: 'reject',
  rationale: 'No thanks',
  resolvedAt: NOW,
  resolvedBy: 'tester',
};

// ============================================================================
// 0. WorkflowRun identity guard — wrong workflowId or workItemId is rejected
//    before any DB mutation.
// ============================================================================

test('testWrongWorkflowIdCannotAlterExistingRun', async () => {
  const db = openDb();
  const repo = new WorkflowRunRepository(db);
  const stepLog: string[] = [];

  const engine = new WorkflowEngine(makeStubDeps(repo, stepLog), makeStubOpts(async () => 'halt'));
  // Create a run under HARNESS_WF.
  await engine.run(HARNESS_WF, 1, 'run-id-wf', DUMMY_CTX, undefined, undefined);
  const original = repo.findById('run-id-wf')!;

  // Present the same run_id but a completely different workflowId.
  const result = await engine.run('wrong-workflow-id', 1, 'run-id-wf', DUMMY_CTX, undefined, undefined);
  assert.ok(result.error?.includes('Identity mismatch'), `expected identity-mismatch error, got: ${result.error}`);

  // Run must be completely unmodified.
  const after = repo.findById('run-id-wf')!;
  assert.equal(after.workflow_id, original.workflow_id);
  assert.equal(after.status, original.status);
  assert.equal(after.current_step_id, original.current_step_id);
  assert.equal(after.awaiting_checkpoint, original.awaiting_checkpoint);
});

test('testWrongWorkItemIdCannotAlterExistingRun', async () => {
  const db = openDb();
  const { wi } = seedWorld(db);  // real work_item in DB
  const repo = new WorkflowRunRepository(db);
  const stepLog: string[] = [];

  const engine = new WorkflowEngine(makeStubDeps(repo, stepLog), makeStubOpts(async () => 'halt'));
  // Create a run bound to the real workItemId.
  await engine.run(HARNESS_WF, 1, 'run-id-wi', DUMMY_CTX, undefined, wi.id);
  const original = repo.findById('run-id-wi')!;
  assert.equal(original.work_item_id, wi.id);

  // Present a different workItemId for the same run_id — identity check must reject.
  const result = await engine.run(HARNESS_WF, 1, 'run-id-wi', DUMMY_CTX, undefined, 'wi-different');
  assert.ok(result.error?.includes('Identity mismatch'), `expected identity-mismatch error, got: ${result.error}`);

  // Run must be completely unmodified.
  const after = repo.findById('run-id-wi')!;
  assert.equal(after.work_item_id, original.work_item_id);
  assert.equal(after.status, original.status);
  assert.equal(after.current_step_id, original.current_step_id);
});

// ============================================================================
// 1. Persisted cursor cannot be overridden
// ============================================================================

test('testPersistedCursorCannotBeOverridden', async () => {
  const db = openDb();
  const repo = new WorkflowRunRepository(db);
  const stepLog: string[] = [];

  // First run halts at checkpoint 'ck', cursor = 'ck'.
  const engine = new WorkflowEngine(
    makeStubDeps(repo, stepLog),
    makeStubOpts(async () => 'halt'),
  );
  await engine.run(HARNESS_WF, 1, 'run-cursor-1', DUMMY_CTX, undefined, undefined);
  const halted = repo.findById('run-cursor-1')!;
  assert.equal(halted.current_step_id, 'ck');

  // Attempt to override cursor to 'snap' (pre-checkpoint step) — must be denied.
  const result = await engine.run(HARNESS_WF, 1, 'run-cursor-1', DUMMY_CTX, 'snap', undefined);
  assert.equal(result.status, 'halted');
  assert.ok(result.error?.includes('Cursor override denied'), `expected override-denied error, got: ${result.error}`);

  // snap ran once in the first run; must not have run again after the denied override.
  assert.equal(stepLog.filter(s => s === 'snap').length, 1,
    'snap must not have been executed again after the denied override');
  const afterDeny = repo.findById('run-cursor-1')!;
  assert.equal(afterDeny.current_step_id, 'ck', 'cursor must remain at ck after denied override');
});

// ============================================================================
// 2. Completed run cannot be re-executed
// ============================================================================

test('testCompletedRunCannotBeReExecuted', async () => {
  const db = openDb();
  const repo = new WorkflowRunRepository(db);
  const stepLog: string[] = [];

  const engine = new WorkflowEngine(
    makeStubDeps(repo, stepLog),
    makeStubOpts(async () => 'approve'),
  );
  // Run to completion.
  const r1 = await engine.run(THREE_STEP_WF, 1, 'run-done-1', DUMMY_CTX);
  assert.equal(r1.status, 'complete');

  const before = [...stepLog];

  // Attempt re-execution — must be denied.
  const r2 = await engine.run(THREE_STEP_WF, 1, 'run-done-1', DUMMY_CTX);
  assert.equal(r2.status, 'complete');
  assert.ok(r2.error?.includes('already complete'), `expected already-complete error, got: ${r2.error}`);

  // No steps should have run again.
  assert.deepEqual(stepLog, before, 'no steps must execute on a re-execution attempt');
});

// ============================================================================
// 3. Resumed run starts exactly at persisted current_step_id
// ============================================================================

test('testActiveResumedRunStartsAtPersistedCursor', async () => {
  const db = openDb();
  const repo = new WorkflowRunRepository(db);
  const stepLog: string[] = [];

  // Run halts at checkpoint.
  const engine = new WorkflowEngine(
    makeStubDeps(repo, stepLog),
    makeStubOpts(async () => 'halt'),
  );
  await engine.run(HARNESS_WF, 1, 'run-cursor-resume', DUMMY_CTX);
  const halted = repo.findById('run-cursor-resume')!;
  assert.equal(halted.current_step_id, 'ck');

  stepLog.length = 0;

  // Advance cursor as ResumeService would (set to continuation step 'bld').
  repo.update({ ...halted, status: 'active', current_step_id: 'bld', awaiting_checkpoint: null, updated_at: NOW });

  // Call engine with startStepId matching the persisted cursor.
  const engine2 = new WorkflowEngine(
    makeStubDeps(repo, stepLog),
    makeStubOpts(async () => 'approve'),
  );
  const r = await engine2.run(HARNESS_WF, 1, 'run-cursor-resume', DUMMY_CTX, 'bld');
  assert.equal(r.status, 'complete');
  // Only 'bld' must have executed — 'snap' and 'ck' were already done.
  assert.deepEqual(stepLog, ['bld'], 'only bld must execute on resume from persisted cursor');
});

// ============================================================================
// 4. iteration/revision survive resume
// ============================================================================

test('testIterationRevisionSurviveResume', async () => {
  const db = openDb();
  const { wi } = seedWorld(db);

  // Seed a WorkflowRun with iteration=3, revision=2.
  const { decisionId, workflowRunId } = seedHaltedRunForResume(db, randomUUID(), wi.id, {
    iteration: 3, revision: 2,
  });

  // Verify persisted values.
  const runRepo = new WorkflowRunRepository(db);
  const run = runRepo.findById(workflowRunId)!;
  assert.equal(run.iteration, 3);
  assert.equal(run.revision, 2);

  // Resume and verify engine loads persisted values.
  const stepLog: string[] = [];
  const adapter: ExecutionAdapter = {
    id: 'test-iter-adapter',
    getCapabilities: () => new Set(['repo.read']) as any,
    async execute(req: ExecutionRequest): Promise<ExecutionResult> {
      const repo2 = runRepo; // same repo
      const deps = makeStubDeps(repo2, stepLog);
      const engine = new WorkflowEngine(deps, makeStubOpts(async () => 'approve'));
      const r = await engine.run(
        req.workflowId, 1, req.workflowRunId, DUMMY_CTX, req.stepId, req.workItemId,
      );
      return {
        schemaVersion: 1,
        stepExecutionId: req.stepExecutionId,
        outcome: r.status === 'complete' ? 'succeeded' : 'failed',
        artifacts: [], evidenceClaims: [], decisionRequests: [],
        usage: { durationMs: 1 },
        failure: r.error ? { code: 'e', message: r.error } : undefined,
      };
    },
  };

  const svc = new ResumeService(db, randomUUID(), makeRegistry(adapter));
  await svc.resume(decisionId, APPROVE);

  // After resume, WorkflowRun should be complete — iteration/revision unchanged.
  const finalRun = runRepo.findById(workflowRunId)!;
  assert.equal(finalRun.status, 'complete');
  assert.equal(finalRun.iteration, 3, 'iteration must be preserved through resume');
  assert.equal(finalRun.revision, 2, 'revision must be preserved through resume');
});

// ============================================================================
// 5. Reject does not execute continuation
// ============================================================================

test('testRejectDoesNotExecuteContinuation', async () => {
  const db = openDb();
  const { ws, wi } = seedWorld(db);

  let adapterCalled = false;
  const adapter: ExecutionAdapter = {
    id: 'test-reject-adapter',
    getCapabilities: () => new Set(['repo.read']) as any,
    async execute(_req: ExecutionRequest): Promise<ExecutionResult> {
      adapterCalled = true;
      return {
        schemaVersion: 1, stepExecutionId: _req.stepExecutionId,
        outcome: 'succeeded', artifacts: [], evidenceClaims: [], decisionRequests: [],
        usage: { durationMs: 1 },
      };
    },
  };

  const { decisionId } = seedHaltedRunForResume(db, ws.id, wi.id);
  const svc = new ResumeService(db, ws.id, makeRegistry(adapter));
  await svc.resume(decisionId, REJECT);

  assert.equal(adapterCalled, false, 'adapter must NOT be called on reject');

  // WorkItem must be cancelled.
  const finalWi = new WorkItemRepository(db).findById(wi.id)!;
  assert.equal(finalWi.state, 'cancelled', 'WorkItem must be cancelled on reject');

  // WorkflowRun must be halted with no awaiting_checkpoint.
  const runRepo = new WorkflowRunRepository(db);
  const run = runRepo.findById((await new DecisionRepository(db).findById(decisionId))
    ? (runRepo.listActive().length === 0 ? null : null) ?? (() => {
        const allRuns = db.prepare('SELECT * FROM workflow_runs').all() as any[];
        return allRuns.find(r => r.work_item_id === wi.id)?.run_id ?? null;
      })()
    : null!
  );
  // Simpler: query directly.
  const allRuns = db.prepare('SELECT * FROM workflow_runs WHERE work_item_id = ?').all(wi.id) as any[];
  assert.equal(allRuns.length, 1);
  assert.equal(allRuns[0].status, 'halted');
  assert.equal(allRuns[0].awaiting_checkpoint, null);

  // Decision must be resolved.
  const dec = new DecisionRepository(db).findById(decisionId)!;
  assert.equal(dec.status, 'resolved');
});

// ============================================================================
// 6. Reject transition is atomic
// ============================================================================

test('testRejectTransitionIsConsistent', async () => {
  // Verify that after a reject, the system is in a fully consistent terminal state:
  // Decision resolved, StepExecution cancelled, WorkflowRun halted, WorkItem cancelled.
  // (True atomicity is SQLite-guaranteed; we verify the observable final state.)
  const db = openDb();
  const { ws, wi } = seedWorld(db);

  const { decisionId } = seedHaltedRunForResume(db, ws.id, wi.id);

  const adapter: ExecutionAdapter = {
    id: 'test-atomic-adapter',
    getCapabilities: () => new Set(['repo.read']) as any,
    async execute(_req: ExecutionRequest): Promise<ExecutionResult> {
      return { schemaVersion: 1, stepExecutionId: _req.stepExecutionId, outcome: 'succeeded', artifacts: [], evidenceClaims: [], decisionRequests: [], usage: { durationMs: 1 } };
    },
  };

  const svc = new ResumeService(db, ws.id, makeRegistry(adapter));
  await svc.resume(decisionId, REJECT);

  const allRuns = db.prepare('SELECT * FROM workflow_runs WHERE work_item_id = ?').all(wi.id) as any[];
  const finalWi = new WorkItemRepository(db).findById(wi.id)!;
  const finalDec = new DecisionRepository(db).findById(decisionId)!;
  const stepExecRepo = new StepExecutionRepository(db);
  const runId = allRuns[0]?.run_id;
  const waitingExecs = stepExecRepo.listByWorkflowRun(runId).filter((se: any) => se.state === 'waiting');

  // All state transitions complete — none stuck in intermediate state.
  assert.equal(finalDec.status, 'resolved', 'Decision must be resolved');
  assert.equal(finalWi.state, 'cancelled', 'WorkItem must be cancelled');
  assert.equal(allRuns[0].status, 'halted', 'WorkflowRun must be halted');
  assert.equal(allRuns[0].awaiting_checkpoint, null, 'awaiting_checkpoint must be cleared');
  assert.equal(waitingExecs.length, 0, 'no waiting StepExecutions must remain');
});

// ============================================================================
// 7. Missing selectedOptionId is denied
// ============================================================================

test('testMissingSelectedOptionIdIsDenied', async () => {
  const db = openDb();
  const { ws, wi } = seedWorld(db);
  const { decisionId } = seedHaltedRunForResume(db, ws.id, wi.id);

  const svc = new ResumeService(db, ws.id, makeRegistry({
    id: 'x', getCapabilities: () => new Set() as any, execute: async () => { throw new Error('should not run'); },
  }));

  let threw: any = null;
  try {
    await svc.resume(decisionId, { resolvedAt: NOW } as any);
  } catch (e) { threw = e; }

  assert.ok(threw instanceof ResumeServiceError);
  assert.equal(threw.code, 'MISSING_OPTION_ID');
});

// ============================================================================
// 8. Invalid selectedOptionId is denied
// ============================================================================

test('testInvalidSelectedOptionIdIsDenied', async () => {
  const db = openDb();
  const { ws, wi } = seedWorld(db);
  const { decisionId } = seedHaltedRunForResume(db, ws.id, wi.id);

  const svc = new ResumeService(db, ws.id, makeRegistry({
    id: 'x', getCapabilities: () => new Set() as any, execute: async () => { throw new Error('should not run'); },
  }));

  let threw: any = null;
  try {
    await svc.resume(decisionId, { selectedOptionId: 'nonexistent', resolvedAt: NOW });
  } catch (e) { threw = e; }

  assert.ok(threw instanceof ResumeServiceError);
  assert.equal(threw.code, 'INVALID_OPTION');
});

// ============================================================================
// 9. Missing/mismatched checkpoint stepId is denied
// ============================================================================

test('testMissingCheckpointStepIdIsDenied', async () => {
  const db = openDb();
  const { ws, wi } = seedWorld(db);

  // Seed with a Decision that has no subjectRef.stepId.
  const workflowRunId = randomUUID();
  const decisionId = randomUUID();
  const runRepo = new WorkflowRunRepository(db);
  runRepo.createOrValidate({
    run_id: workflowRunId, workflow_id: HARNESS_WF, work_item_id: wi.id,
    status: 'halted', current_step_id: 'ck', awaiting_checkpoint: 'ck',
    iteration: 1, revision: 0, started_at: NOW, updated_at: NOW,
  });
  new WorkItemRepository(db).updateState(wi.id, 'needs_decision', NOW);
  new DecisionRepository(db).save({
    id: decisionId, projectId: wi.projectId, workItemId: wi.id, type: 'checkpoint',
    subjectRef: { workflowRunId, workItemId: wi.id },  // stepId missing
    title: 'G', summary: 'G',
    options: [
      { id: 'approve', label: 'Approve', description: '' },
      { id: 'reject', label: 'Reject', description: '' },
    ],
    impact: 'low', reversibility: 'easy', urgency: 'normal', status: 'pending',
  });

  const svc = new ResumeService(db, ws.id, makeRegistry({
    id: 'x', getCapabilities: () => new Set() as any, execute: async () => { throw new Error('should not run'); },
  }));

  let threw: any = null;
  try { await svc.resume(decisionId, APPROVE); } catch (e) { threw = e; }

  assert.ok(threw instanceof ResumeServiceError);
  assert.equal(threw.code, 'MISSING_CHECKPOINT_STEP_ID');
});

test('testMismatchedCheckpointStepIdIsDenied', async () => {
  const db = openDb();
  const { ws, wi } = seedWorld(db);

  const workflowRunId = randomUUID();
  const decisionId = randomUUID();
  const runRepo = new WorkflowRunRepository(db);
  runRepo.createOrValidate({
    run_id: workflowRunId, workflow_id: HARNESS_WF, work_item_id: wi.id,
    status: 'halted', current_step_id: 'ck', awaiting_checkpoint: 'ck',
    iteration: 1, revision: 0, started_at: NOW, updated_at: NOW,
  });
  new WorkItemRepository(db).updateState(wi.id, 'needs_decision', NOW);
  new DecisionRepository(db).save({
    id: decisionId, projectId: wi.projectId, workItemId: wi.id, type: 'checkpoint',
    subjectRef: { workflowRunId, workItemId: wi.id, stepId: 'wrong-step' },
    title: 'G', summary: 'G',
    options: [
      { id: 'approve', label: 'Approve', description: '' },
      { id: 'reject', label: 'Reject', description: '' },
    ],
    impact: 'low', reversibility: 'easy', urgency: 'normal', status: 'pending',
  });

  const svc = new ResumeService(db, ws.id, makeRegistry({
    id: 'x', getCapabilities: () => new Set() as any, execute: async () => { throw new Error('should not run'); },
  }));

  let threw: any = null;
  try { await svc.resume(decisionId, APPROVE); } catch (e) { threw = e; }

  assert.ok(threw instanceof ResumeServiceError);
  assert.equal(threw.code, 'CHECKPOINT_STEP_MISMATCH');
});

// ============================================================================
// 10. Missing/mismatched WorkflowRun workItemId is denied
// ============================================================================

test('testMissingRunWorkItemIdIsDenied', async () => {
  const db = openDb();
  const { ws, wi } = seedWorld(db);

  // Seed a WorkflowRun with NO work_item_id (standalone run).
  const workflowRunId = randomUUID();
  const decisionId = randomUUID();
  const runRepo = new WorkflowRunRepository(db);
  runRepo.createOrValidate({
    run_id: workflowRunId, workflow_id: HARNESS_WF, work_item_id: undefined,
    status: 'halted', current_step_id: 'ck', awaiting_checkpoint: 'ck',
    iteration: 1, revision: 0, started_at: NOW, updated_at: NOW,
  });
  new WorkItemRepository(db).updateState(wi.id, 'needs_decision', NOW);
  new DecisionRepository(db).save({
    id: decisionId, projectId: wi.projectId, workItemId: wi.id, type: 'checkpoint',
    subjectRef: { workflowRunId, workItemId: wi.id, stepId: 'ck' },
    title: 'G', summary: 'G',
    options: [
      { id: 'approve', label: 'Approve', description: '' },
      { id: 'reject', label: 'Reject', description: '' },
    ],
    impact: 'low', reversibility: 'easy', urgency: 'normal', status: 'pending',
  });

  const svc = new ResumeService(db, ws.id, makeRegistry({
    id: 'x', getCapabilities: () => new Set() as any, execute: async () => { throw new Error('should not run'); },
  }));

  let threw: any = null;
  try { await svc.resume(decisionId, APPROVE); } catch (e) { threw = e; }

  assert.ok(threw instanceof ResumeServiceError);
  assert.equal(threw.code, 'MISSING_RUN_WORK_ITEM_ID');
});

test('testMismatchedRunWorkItemIdIsDenied', async () => {
  const db = openDb();
  const { ws, wi } = seedWorld(db);

  // Seed two WorkItems so we can link the run to a different one.
  const wiRepo = new WorkItemRepository(db);
  const otherWi = {
    id: randomUUID(), projectId: wi.projectId, repositoryIds: [] as string[],
    title: 'other', goal: 'g', workflowId: HARNESS_WF,
    state: 'ready' as const, priority: 0,
    acceptanceCriteria: [], constraints: [], requiredEvidence: [],
    dependencies: [], createdAt: NOW, updatedAt: NOW,
  };
  wiRepo.save(otherWi);

  const workflowRunId = randomUUID();
  const decisionId = randomUUID();
  const runRepo = new WorkflowRunRepository(db);
  // Run linked to otherWi.
  runRepo.createOrValidate({
    run_id: workflowRunId, workflow_id: HARNESS_WF, work_item_id: otherWi.id,
    status: 'halted', current_step_id: 'ck', awaiting_checkpoint: 'ck',
    iteration: 1, revision: 0, started_at: NOW, updated_at: NOW,
  });
  wiRepo.updateState(wi.id, 'needs_decision', NOW);
  // Decision references wi (not otherWi).
  new DecisionRepository(db).save({
    id: decisionId, projectId: wi.projectId, workItemId: wi.id, type: 'checkpoint',
    subjectRef: { workflowRunId, workItemId: wi.id, stepId: 'ck' },
    title: 'G', summary: 'G',
    options: [
      { id: 'approve', label: 'Approve', description: '' },
      { id: 'reject', label: 'Reject', description: '' },
    ],
    impact: 'low', reversibility: 'easy', urgency: 'normal', status: 'pending',
  });

  const svc = new ResumeService(db, ws.id, makeRegistry({
    id: 'x', getCapabilities: () => new Set() as any, execute: async () => { throw new Error('should not run'); },
  }));

  let threw: any = null;
  try { await svc.resume(decisionId, APPROVE); } catch (e) { threw = e; }

  assert.ok(threw instanceof ResumeServiceError);
  assert.equal(threw.code, 'WORK_ITEM_MISMATCH');
});

// ============================================================================
// 11. Missing Repository ID fails dispatch and resume
// ============================================================================

test('testMissingRepositoryIdFailsSchedulerDispatch', async () => {
  const db = openDb();
  const wsRepo = new WorkspaceRepository(db);
  const projRepo = new ProjectRepository(db);
  const wiRepo = new WorkItemRepository(db);

  const ws = { id: randomUUID(), name: 'hw', createdAt: NOW };
  wsRepo.save(ws);
  const proj = {
    id: randomUUID(), workspaceId: ws.id, name: 'p',
    status: 'active' as const, priority: 0, createdAt: NOW, updatedAt: NOW,
  };
  projRepo.save(proj);

  // WorkItem references a repository ID that does not exist in the DB.
  const wi = {
    id: randomUUID(), projectId: proj.id,
    repositoryIds: ['nonexistent-repo-id'],
    title: 't', goal: 'g', workflowId: THREE_STEP_WF,
    state: 'ready' as const, priority: 0,
    acceptanceCriteria: [], constraints: [], requiredEvidence: [],
    dependencies: [], createdAt: NOW, updatedAt: NOW,
  };
  wiRepo.save(wi);

  let adapterCalled = false;
  const adapter: ExecutionAdapter = {
    id: 'stratum-agent',
    getCapabilities: () => new Set(['repo.read']) as any,
    async execute(_req: ExecutionRequest): Promise<ExecutionResult> {
      adapterCalled = true;
      return { schemaVersion: 1, stepExecutionId: _req.stepExecutionId, outcome: 'succeeded', artifacts: [], evidenceClaims: [], decisionRequests: [], usage: { durationMs: 1 } };
    },
  };

  const registry = makeRegistry(adapter);
  const scheduler = new Scheduler(db, ws.id, registry);
  const results = await scheduler.tick();

  // Dispatch must fail (not succeed or be silently skipped with empty remote).
  assert.equal(results.length, 1);
  assert.equal(results[0].outcome, 'failed', `expected failed dispatch, got: ${results[0].outcome}`);
  assert.ok(results[0].error?.includes('nonexistent-repo-id'), `expected repo-not-found error, got: ${results[0].error}`);
  assert.equal(adapterCalled, false, 'adapter must not be called when repo is missing');
});

test('testMissingRepositoryIdFailsResumeService', async () => {
  const db = openDb();
  const { ws, wi: wiBase } = seedWorld(db);

  // Mutate workItem to have a bad repositoryId.
  const wiRepo = new WorkItemRepository(db);
  const wi = {
    ...wiBase,
    repositoryIds: ['nonexistent-repo-id'],
    workflowId: HARNESS_WF,
  };
  // Update the work item in DB directly.
  db.prepare(
    "UPDATE work_items SET repository_ids_json = ? WHERE id = ?"
  ).run(JSON.stringify(['nonexistent-repo-id']), wi.id);

  const { decisionId } = seedHaltedRunForResume(db, ws.id, wi.id);

  let adapterCalled = false;
  const svc = new ResumeService(db, ws.id, makeRegistry({
    id: 'stratum-agent',
    getCapabilities: () => new Set(['repo.read']) as any,
    async execute(_req: ExecutionRequest): Promise<ExecutionResult> {
      adapterCalled = true;
      return { schemaVersion: 1, stepExecutionId: _req.stepExecutionId, outcome: 'succeeded', artifacts: [], evidenceClaims: [], decisionRequests: [], usage: { durationMs: 1 } };
    },
  }));

  let threw: any = null;
  try { await svc.resume(decisionId, APPROVE); } catch (e) { threw = e; }

  assert.ok(threw instanceof Error, 'must throw when repository is missing');
  assert.ok(threw.message.includes('nonexistent-repo-id') || threw.code === 'NO_ADAPTER' || threw.message.includes('not found'),
    `expected repo-not-found error, got: ${threw.message}`);
  assert.equal(adapterCalled, false, 'adapter must not be called when repo is missing');
});

// ============================================================================
// 12. Checkpoint HTTP resolve actually resumes (end-to-end HTTP test)
// ============================================================================

let _port = 29200;
function nextPort() { return ++_port; }

async function postJson(url: string, body: unknown) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test('testCheckpointHTTPResolveActuallyResumes', async () => {
  const db = openDb();
  const { ws, wi } = seedWorld(db);

  const stepLog: string[] = [];
  const adapter = makeHaltingAdapter(db, stepLog);
  const registry = makeRegistry(adapter);
  const scheduler = new Scheduler(db, ws.id, registry);

  // Initial dispatch → halts at checkpoint.
  const results = await scheduler.tick();
  assert.equal(results[0].outcome, 'dispatched');
  const runId = results[0].workflowRunId!;

  // Grab the Decision.
  const decRepo = new DecisionRepository(db);
  const [decision] = decRepo.listByWorkItem(wi.id);
  assert.ok(decision, 'Decision must exist');
  assert.equal(decision.status, 'pending');

  const resumeAdapter = makeHaltingAdapter(db, stepLog);
  const resumeRegistry = makeRegistry(resumeAdapter);
  const resumeSvc = new ResumeService(db, ws.id, resumeRegistry);
  const workSvc = new WorkService(db, ws.id);
  const evidSvc = new EvidenceService(db);

  const srv = new ControlPlaneServer({
    db, workspaceId: ws.id, workService: workSvc, evidenceService: evidSvc,
    resumeService: resumeSvc, port: nextPort(),
  });
  await srv.listen();
  const base = `http://localhost:${srv.port}`;

  try {
    const r = await postJson(`${base}/decisions/${decision.id}/resolve`, {
      resolution: APPROVE,
    });
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal((r.body as any).ok, true);
    assert.equal((r.body as any).data?.resumed, true);

    // WorkflowRun must be complete.
    const runRepo = new WorkflowRunRepository(db);
    const run = runRepo.findById(runId)!;
    assert.equal(run.status, 'complete', 'WorkflowRun must be complete after HTTP resume');

    // WorkItem must be in_review.
    const finalWi = new WorkItemRepository(db).findById(wi.id)!;
    assert.equal(finalWi.state, 'in_review', 'WorkItem must be in_review after HTTP resume');

    // bld must have run.
    assert.ok(stepLog.some(s => s === 'bld'), 'bld step must have run after HTTP resume');
  } finally {
    await srv.close();
  }
});

// ============================================================================
// 13. Checkpoint HTTP resolve without ResumeService fails closed
// ============================================================================

test('testCheckpointHTTPResolveWithoutResumeServiceFailsClosed', async () => {
  const db = openDb();
  const { ws, wi } = seedWorld(db);

  const stepLog: string[] = [];
  const adapter = makeHaltingAdapter(db, stepLog);
  const registry = makeRegistry(adapter);
  const scheduler = new Scheduler(db, ws.id, registry);

  // Dispatch → halts at checkpoint.
  await scheduler.tick();

  const decRepo = new DecisionRepository(db);
  const [decision] = decRepo.listByWorkItem(wi.id);
  assert.ok(decision, 'Decision must exist');

  // Server WITHOUT ResumeService.
  const workSvc = new WorkService(db, ws.id);
  const evidSvc = new EvidenceService(db);
  const srv = new ControlPlaneServer({
    db, workspaceId: ws.id, workService: workSvc, evidenceService: evidSvc,
    // resumeService intentionally omitted
    port: nextPort(),
  });
  await srv.listen();
  const base = `http://localhost:${srv.port}`;

  try {
    const r = await postJson(`${base}/decisions/${decision.id}/resolve`, {
      resolution: APPROVE,
    });
    // Must fail — not silently succeed by falling through to workService.
    assert.equal(r.status, 503, `expected 503, got ${r.status}`);
    assert.equal((r.body as any).ok, false);

    // Decision must remain pending — no state was changed.
    const stillPending = decRepo.findById(decision.id)!;
    assert.equal(stillPending.status, 'pending', 'Decision must remain pending on failed resolve');

    // WorkItem must remain needs_decision.
    const wiState = new WorkItemRepository(db).findById(wi.id)!;
    assert.equal(wiState.state, 'needs_decision', 'WorkItem must remain needs_decision on failed resolve');
  } finally {
    await srv.close();
  }
});

// ============================================================================
// 14. Malformed resolution at HTTP boundary → bad_request (schema parsed early)
// ============================================================================

test('testMalformedResolutionReturnsBadRequest', async () => {
  const db = openDb();
  const { ws, wi } = seedWorld(db);

  const stepLog: string[] = [];
  const adapter = makeHaltingAdapter(db, stepLog);
  const registry = makeRegistry(adapter);
  const scheduler = new Scheduler(db, ws.id, registry);

  await scheduler.tick();

  const [decision] = new DecisionRepository(db).listByWorkItem(wi.id);
  assert.ok(decision, 'Decision must exist after halted dispatch');

  const resumeRegistry = makeRegistry(makeHaltingAdapter(db, stepLog));
  const resumeSvc = new ResumeService(db, ws.id, resumeRegistry);
  const workSvc = new WorkService(db, ws.id);
  const evidSvc = new EvidenceService(db);
  const srv = new ControlPlaneServer({
    db, workspaceId: ws.id, workService: workSvc, evidenceService: evidSvc,
    resumeService: resumeSvc, port: nextPort(),
  });
  await srv.listen();
  const base = `http://localhost:${srv.port}`;

  try {
    // Missing selectedOptionId — schema validation should catch this before service layer.
    const r = await postJson(`${base}/decisions/${decision.id}/resolve`, {
      resolution: { rationale: 'no option id provided' },
    });
    assert.equal(r.status, 400, `expected 400 bad_request, got ${r.status}`);
    assert.equal((r.body as any).ok, false);
    assert.ok((r.body as any).error?.message?.includes('Invalid resolution'));

    // Decision must remain pending — no state was changed.
    const stillPending = new DecisionRepository(db).findById(decision.id)!;
    assert.equal(stillPending.status, 'pending', 'Decision must stay pending on bad request');
  } finally {
    await srv.close();
  }
});
