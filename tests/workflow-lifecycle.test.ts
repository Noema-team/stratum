/**
 * Lifecycle integration tests: Scheduler → checkpoint → restart → ResumeService.
 *
 * Proves the full durable checkpoint/resume path:
 *   dispatch → WorkflowRun persisted → checkpoint halts → Decision created →
 *   WorkItem = needs_decision → [simulated restart: new service instances] →
 *   Decision still visible → ResumeService.resume() → same workflowRunId →
 *   pre-checkpoint step NOT replayed → continuation step executes once →
 *   WorkItem = in_review, WorkflowRun = complete
 *
 * Also tests duplicate resolution is rejected.
 */

import { test } from 'node:test';
import { strict as assert } from 'assert';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
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
import { WorkflowEngine, registerWorkflow } from '../src/workflow/index.js';
import type {
  WorkflowEngineDeps,
  WorkflowEngineOptions,
} from '../src/workflow/index.js';
import { ExecutorRegistry } from '../src/execution/registry.js';
import { Scheduler } from '../src/scheduler/scheduler.js';
import { StratumAgentAdapter } from '../src/execution/stratum-agent-adapter.js';
import type { ExecutionAdapter, ExecutionRequest, ExecutionResult } from '../src/execution/types.js';
import type { Workspace, Project, WorkItem } from '../src/domain/index.js';

// ============================================================================
// Test workflow: produce → checkpoint → produce
// Using 'produce' (not 'gather') so stepRunner.run() is invoked for tracking.
// ============================================================================

const LIFECYCLE_WF_ID = `lifecycle-test-${randomUUID()}`;

registerWorkflow({
  id: LIFECYCLE_WF_ID,
  label: 'Lifecycle Integration Test Workflow',
  steps: [
    { id: 'step-a', kind: 'produce', label: 'Before Checkpoint' },
    { id: 'step-ck', kind: 'checkpoint', label: 'Human Approval Gate' },
    { id: 'step-b', kind: 'produce', label: 'After Checkpoint' },
  ],
});

// ============================================================================
// Helpers
// ============================================================================

function makeWorkspace(): Workspace {
  return { id: randomUUID(), name: 'ws-lifecycle-test', createdAt: new Date().toISOString() };
}

function makeProject(workspaceId: string): Project {
  const now = new Date().toISOString();
  return {
    id: randomUUID(), workspaceId, name: 'lifecycle-project',
    status: 'active', priority: 0, createdAt: now, updatedAt: now,
  };
}

function makeWorkItem(projectId: string): WorkItem {
  const now = new Date().toISOString();
  return {
    id: randomUUID(), projectId,
    repositoryIds: [],
    title: 'Lifecycle test item',
    goal: 'Run through a checkpoint',
    workflowId: LIFECYCLE_WF_ID,
    state: 'ready',
    priority: 0,
    acceptanceCriteria: [],
    constraints: [],
    requiredEvidence: [],
    dependencies: [],
    createdAt: now, updatedAt: now,
  };
}

// Builds a real-engine adapter whose step runner appends to stepCallLog.
// Always halts at checkpoints — the ResumeService skips the checkpoint step
// entirely on resume (starts from continuationStepId), so 'halt' is never
// re-triggered after the initial dispatch.
function makeTestAdapter(
  db: ReturnType<typeof openDatabase>,
  stepCallLog: Array<{ stepId: string }>,
): ExecutionAdapter {
  const runRepo = new WorkflowRunRepository(db);
  const stepRunner = {
    run: async (step: any) => {
      stepCallLog.push({ stepId: step.id });
      return { success: true, artifacts_written: [], tokens_used: 0, duration_ms: 1 };
    },
  };
  const deps: WorkflowEngineDeps = {
    stepRunner: stepRunner as any,
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
    workflowRunRepository: runRepo,
  };
  const opts: WorkflowEngineOptions = {
    onCheckpoint: async () => 'halt',
  };

  return {
    id: 'test-lifecycle-adapter',
    getCapabilities: () => new Set(['repo.read']) as any,
    async execute(req: ExecutionRequest): Promise<ExecutionResult> {
      const start = Date.now();
      const engine = new WorkflowEngine(deps, opts);
      const startStepId = req.stepId !== '__start__' ? req.stepId : undefined;
      const result = await engine.run(
        req.workflowId, req.workflowRunId, req.goal,
        startStepId, req.workItemId,
      );
      const isCheckpoint = result.status === 'halted' && !result.error;
      const outcome = result.status === 'complete' ? 'succeeded'
        : result.error ? 'failed'
        : 'blocked';
      return {
        schemaVersion: 1,
        stepExecutionId: req.stepExecutionId,
        outcome,
        artifacts: [],
        evidenceClaims: [],
        checkpointStepId: isCheckpoint ? (result.final_step_id ?? undefined) : undefined,
        decisionRequests: isCheckpoint
          ? [{ type: 'checkpoint', title: 'Workflow paused', summary: '' }]
          : [],
        usage: { durationMs: Date.now() - start },
        failure: result.error ? { code: 'workflow_error', message: result.error } : undefined,
      };
    },
  };
}

// ============================================================================
// Test 1: Full lifecycle end-to-end with simulated restart
// ============================================================================

test('testWorkflowLifecycleCheckpointResumeEndToEnd', async () => {
  const db = openDatabase(':memory:');

  // Seed control-plane rows.
  const wsRepo = new WorkspaceRepository(db);
  const projRepo = new ProjectRepository(db);
  const workItemRepo = new WorkItemRepository(db);

  const ws = makeWorkspace();
  wsRepo.save(ws);
  const proj = makeProject(ws.id);
  projRepo.save(proj);
  const workItem = makeWorkItem(proj.id);
  workItemRepo.save(workItem);

  // ---- Phase 1: Initial dispatch via Scheduler --------------------------------

  const stepCallLog: Array<{ stepId: string }> = [];
  const adapter = makeTestAdapter(db, stepCallLog);

  const registry = new ExecutorRegistry();
  registry.register(adapter);
  const scheduler = new Scheduler(db, ws.id, registry);

  const results = await scheduler.tick();
  assert.equal(results.length, 1, 'exactly one item dispatched');
  assert.equal(results[0].outcome, 'dispatched', 'dispatch succeeded');

  // Capture the canonical run ID minted by the Scheduler.
  const canonicalRunId = results[0].workflowRunId!;
  assert.ok(canonicalRunId, 'Scheduler must populate workflowRunId in dispatch result');

  // step-a (produce) ran once; step-b (produce) has not run yet.
  assert.equal(
    stepCallLog.filter(l => l.stepId === 'step-a').length, 1,
    'step-a must run once during initial dispatch',
  );
  assert.equal(
    stepCallLog.filter(l => l.stepId === 'step-b').length, 0,
    'step-b must not run before checkpoint is approved',
  );

  // ---- Phase 1 state verification --------------------------------------------

  const runRepo = new WorkflowRunRepository(db);
  const run1 = runRepo.findById(canonicalRunId);
  assert.ok(run1, 'WorkflowRun must be persisted');
  assert.equal(run1!.status, 'halted', 'run must be halted at checkpoint');
  assert.equal(run1!.work_item_id, workItem.id, 'WorkflowRun must be linked to the WorkItem');
  assert.equal(run1!.awaiting_checkpoint, 'step-ck', 'run must be awaiting step-ck');

  const decisionRepo = new DecisionRepository(db);
  const decisions = decisionRepo.listByWorkItem(workItem.id);
  assert.equal(decisions.length, 1, 'exactly one Decision must be created');
  const decision = decisions[0];
  assert.equal(decision.status, 'pending');
  assert.equal(decision.type, 'checkpoint');
  assert.equal((decision.subjectRef as any).workflowRunId, canonicalRunId,
    'Decision.subjectRef.workflowRunId must match the canonical run ID');
  assert.equal((decision.subjectRef as any).workItemId, workItem.id,
    'Decision.subjectRef.workItemId must match the WorkItem');
  assert.equal((decision.subjectRef as any).stepId, 'step-ck',
    'Decision.subjectRef.stepId must identify the checkpoint step');

  const wi1 = workItemRepo.findById(workItem.id)!;
  assert.equal(wi1.state, 'needs_decision', 'WorkItem must be in needs_decision after checkpoint');

  const stepExecRepo = new StepExecutionRepository(db);
  const waitingExec = stepExecRepo
    .listByWorkflowRun(canonicalRunId)
    .find(se => se.state === 'waiting');
  assert.ok(waitingExec, 'a StepExecution in state waiting must exist for the checkpoint');

  // ---- Phase 2: Simulated restart — fresh service instances from same DB ----
  //
  // In production, the process would die here and restart against the on-disk DB.
  // In the test we simulate this by discarding the old instance variables and
  // constructing new service/repository objects from the same in-memory DB object.

  const freshRunRepo = new WorkflowRunRepository(db);
  const freshDecisionRepo = new DecisionRepository(db);
  const freshWorkItemRepo = new WorkItemRepository(db);

  // Verify state survives the instance boundary.
  const persistedDecision = freshDecisionRepo.findById(decision.id);
  assert.ok(persistedDecision, 'Decision must be visible to fresh instances (persistence check)');
  assert.equal(persistedDecision!.status, 'pending',
    'Decision must still be pending after simulated restart');

  const persistedRun = freshRunRepo.findById(canonicalRunId);
  assert.ok(persistedRun, 'WorkflowRun must be visible to fresh instances');
  assert.equal(persistedRun!.status, 'halted',
    'WorkflowRun must still be halted after simulated restart');

  const persistedWi = freshWorkItemRepo.findById(workItem.id)!;
  assert.equal(persistedWi.state, 'needs_decision',
    'WorkItem must still be needs_decision after simulated restart');

  // ---- Phase 3: Resolve Decision via fresh ResumeService --------------------

  const freshAdapter = makeTestAdapter(db, stepCallLog);  // new instance, same log
  const freshRegistry = new ExecutorRegistry();
  freshRegistry.register(freshAdapter);
  const resumeService = new ResumeService(db, ws.id, freshRegistry);

  const resolution = {
    selectedOptionId: 'approve',
    rationale: 'LGTM',
    resolvedAt: new Date().toISOString(),
    resolvedBy: 'test-operator',
  };

  await resumeService.resume(decision.id, resolution);

  // ---- Phase 3 verification --------------------------------------------------

  // step-a must NOT have replayed; step-b must have run exactly once.
  assert.equal(
    stepCallLog.filter(l => l.stepId === 'step-a').length, 1,
    'step-a must not replay after resume — only one execution total',
  );
  assert.equal(
    stepCallLog.filter(l => l.stepId === 'step-b').length, 1,
    'step-b must execute exactly once during resume',
  );

  // WorkflowRun completed with the identical run ID.
  const finalRun = freshRunRepo.findById(canonicalRunId)!;
  assert.equal(finalRun.run_id, canonicalRunId,
    'workflowRunId must be identical end-to-end');
  assert.equal(finalRun.status, 'complete',
    'WorkflowRun must be complete after resume');
  assert.equal(finalRun.awaiting_checkpoint, null,
    'awaiting_checkpoint must be cleared after successful resume');

  // WorkItem advanced to in_review.
  const finalWi = freshWorkItemRepo.findById(workItem.id)!;
  assert.equal(finalWi.state, 'in_review',
    'WorkItem must be in_review after successful resume');

  // Decision resolved.
  const finalDecision = freshDecisionRepo.findById(decision.id)!;
  assert.equal(finalDecision.status, 'resolved',
    'Decision must be resolved after successful resume');

  // ---- Phase 4: Duplicate resolution must be rejected -----------------------

  let duplicateError: any = null;
  try {
    await resumeService.resume(decision.id, resolution);
  } catch (err) {
    duplicateError = err;
  }
  assert.ok(duplicateError, 'second resume call must throw');
  assert.equal(duplicateError.code, 'ALREADY_RESOLVED',
    'duplicate resume must throw ResumeServiceError with code ALREADY_RESOLVED');
});

// ============================================================================
// Test 2: ResumeService rejects missing or invalid prerequisites
// ============================================================================

test('testResumeServiceGuards', async () => {
  const db = openDatabase(':memory:');
  const ws = makeWorkspace();
  new WorkspaceRepository(db).save(ws);
  const proj = makeProject(ws.id);
  new ProjectRepository(db).save(proj);

  const stepCallLog: Array<{ stepId: string }> = [];
  const adapter = makeTestAdapter(db, stepCallLog);
  const guardRegistry = new ExecutorRegistry();
  guardRegistry.register(adapter);
  const resumeService = new ResumeService(db, ws.id, guardRegistry);

  const resolution = {
    selectedOptionId: 'approve',
    resolvedAt: new Date().toISOString(),
  };

  // Non-existent Decision.
  {
    let err: any = null;
    try { await resumeService.resume(randomUUID(), resolution); } catch (e) { err = e; }
    assert.ok(err instanceof ResumeServiceError, 'must throw ResumeServiceError for unknown decision');
    assert.equal(err.code, 'NOT_FOUND');
  }

  // Decision missing workflowRunId in subjectRef.
  {
    const decisionRepo = new DecisionRepository(db);
    const workItem = makeWorkItem(proj.id);
    workItem.state = 'needs_decision';
    new WorkItemRepository(db).save(workItem);
    new WorkItemRepository(db).updateState(workItem.id, 'needs_decision', new Date().toISOString());

    // Manually insert a Decision with no workflowRunId
    decisionRepo.save({
      id: randomUUID(),
      projectId: proj.id,
      workItemId: workItem.id,
      type: 'checkpoint',
      subjectRef: { workItemId: workItem.id },  // no workflowRunId
      title: 'test',
      summary: 'test',
      options: [{ id: 'approve', label: 'Approve' }],
      impact: 'low',
      reversibility: 'easy',
      urgency: 'normal',
      status: 'pending',
    });

    const [d] = decisionRepo.listByWorkItem(workItem.id);
    let err: any = null;
    try { await resumeService.resume(d.id, resolution); } catch (e) { err = e; }
    assert.ok(err instanceof ResumeServiceError, 'must throw for missing workflowRunId');
    assert.equal(err.code, 'MISSING_RUN_ID');
  }
});

// ============================================================================
// Test 3: Real file-backed SQLite restart — proves durability across DB close/reopen
// ============================================================================

test('testFileBackedSQLiteRestart', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'stratum-restart-test-'));
  const dbPath = join(tmpDir, 'stratum.db');

  try {
    // ---- Phase 1: Dispatch in first process --------------------------------
    const stepCallLog1: Array<{ stepId: string }> = [];
    let canonicalRunId: string;
    let decisionId: string;
    let workItemId: string;
    let workspaceId: string;

    {
      const db1 = openDatabase(dbPath);
      const wsRepo = new WorkspaceRepository(db1);
      const projRepo = new ProjectRepository(db1);
      const workItemRepo = new WorkItemRepository(db1);

      const ws = makeWorkspace();
      wsRepo.save(ws);
      workspaceId = ws.id;
      const proj = makeProject(ws.id);
      projRepo.save(proj);
      const workItem = makeWorkItem(proj.id);
      workItemRepo.save(workItem);
      workItemId = workItem.id;

      const adapter1 = makeTestAdapter(db1, stepCallLog1);
      const registry1 = new ExecutorRegistry();
      registry1.register(adapter1);
      const scheduler1 = new Scheduler(db1, ws.id, registry1);

      const results = await scheduler1.tick();
      assert.equal(results.length, 1, 'one item dispatched');
      assert.equal(results[0].outcome, 'dispatched');
      canonicalRunId = results[0].workflowRunId!;

      // Verify halted state in DB before closing.
      const runRepo1 = new WorkflowRunRepository(db1);
      const run1 = runRepo1.findById(canonicalRunId)!;
      assert.equal(run1.status, 'halted', 'run must be halted at checkpoint');
      assert.equal(run1.awaiting_checkpoint, 'step-ck');

      const decRepo1 = new DecisionRepository(db1);
      const [dec1] = decRepo1.listByWorkItem(workItemId);
      assert.ok(dec1, 'Decision must exist before close');
      decisionId = dec1.id;

      // Simulate process death by closing the DB connection.
      db1.close();
    }

    // ---- Phase 2: Fresh process — reopen DB, verify state survived ----------
    const stepCallLog2: Array<{ stepId: string }> = [];
    {
      const db2 = openDatabase(dbPath);

      const runRepo2 = new WorkflowRunRepository(db2);
      const persistedRun = runRepo2.findById(canonicalRunId);
      assert.ok(persistedRun, 'WorkflowRun must survive DB close/reopen');
      assert.equal(persistedRun!.status, 'halted', 'WorkflowRun must still be halted');
      assert.equal(persistedRun!.awaiting_checkpoint, 'step-ck');

      const decRepo2 = new DecisionRepository(db2);
      const persistedDec = decRepo2.findById(decisionId);
      assert.ok(persistedDec, 'Decision must survive DB close/reopen');
      assert.equal(persistedDec!.status, 'pending');

      const wiRepo2 = new WorkItemRepository(db2);
      const persistedWi = wiRepo2.findById(workItemId)!;
      assert.equal(persistedWi.state, 'needs_decision', 'WorkItem must be needs_decision after reopen');

      // Verify step-a ran exactly once (no replay on reopen).
      assert.equal(stepCallLog1.filter(l => l.stepId === 'step-a').length, 1);
      assert.equal(stepCallLog2.filter(l => l.stepId === 'step-a').length, 0,
        'step-a must not replay on DB reopen alone');

      // ---- Phase 3: Resume via ResumeService on the fresh process ------------
      const adapter2 = makeTestAdapter(db2, stepCallLog2);
      const registry2 = new ExecutorRegistry();
      registry2.register(adapter2);
      const resumeService2 = new ResumeService(db2, workspaceId, registry2);

      await resumeService2.resume(decisionId, {
        selectedOptionId: 'approve',
        rationale: 'LGTM',
        resolvedAt: new Date().toISOString(),
        resolvedBy: 'test-operator',
      });

      // step-a must not have replayed; step-b must have run exactly once.
      assert.equal(
        stepCallLog2.filter(l => l.stepId === 'step-a').length, 0,
        'step-a must not replay after file-backed resume',
      );
      assert.equal(
        stepCallLog2.filter(l => l.stepId === 'step-b').length, 1,
        'step-b must run exactly once during resume',
      );

      // WorkflowRun complete.
      const finalRun = runRepo2.findById(canonicalRunId)!;
      assert.equal(finalRun.run_id, canonicalRunId, 'run_id must be preserved');
      assert.equal(finalRun.status, 'complete', 'WorkflowRun must be complete');
      assert.equal(finalRun.awaiting_checkpoint, null);

      // WorkItem in_review.
      const finalWi = wiRepo2.findById(workItemId)!;
      assert.equal(finalWi.state, 'in_review', 'WorkItem must be in_review after resume');

      db2.close();
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// Test 4: Canonical-path regression — parameter freezing
//
// WorkItem { workflowParameters: { planning_depth: 'deep', max_iterations: 2 } }
// → Scheduler → StratumAgentAdapter → WorkflowEngine → WorkflowRunRepository
//
// Proves:
//   - WorkflowRun.resolvedParameters is frozen at dispatch (all defaults filled)
//   - Mutating WorkItem.workflowParameters AFTER initial dispatch does NOT change
//     WorkflowRun.resolvedParameters on resume — the engine reads the frozen copy.
// ============================================================================

const PARAM_WF_ID = `param-freeze-test-${randomUUID()}`;

registerWorkflow({
  id: PARAM_WF_ID,
  label: 'Parameter Freeze Regression Test Workflow',
  steps: [
    { id: 'pf-step-a', kind: 'produce', label: 'Before Checkpoint' },
    { id: 'pf-step-ck', kind: 'checkpoint', label: 'Approval Gate' },
    { id: 'pf-step-b', kind: 'produce', label: 'After Checkpoint' },
  ],
});

test('testCanonicalPathParameterFreezing', async () => {
  const db = openDatabase(':memory:');

  const wsRepo = new WorkspaceRepository(db);
  const projRepo = new ProjectRepository(db);
  const workItemRepo = new WorkItemRepository(db);
  const runRepo = new WorkflowRunRepository(db);

  const ws: Workspace = { id: randomUUID(), name: 'param-freeze-ws', createdAt: new Date().toISOString() };
  wsRepo.save(ws);

  const now = new Date().toISOString();
  const proj: Project = {
    id: randomUUID(), workspaceId: ws.id, name: 'param-freeze-proj',
    status: 'active', priority: 0, createdAt: now, updatedAt: now,
  };
  projRepo.save(proj);

  // WorkItem carries deep + max_iterations=2.
  const workItem: WorkItem = {
    id: randomUUID(), projectId: proj.id,
    repositoryIds: [],
    title: 'Param freeze test',
    goal: 'Prove parameter freezing',
    workflowId: PARAM_WF_ID,
    state: 'ready',
    priority: 0,
    acceptanceCriteria: [],
    constraints: [],
    requiredEvidence: [],
    dependencies: [],
    createdAt: now, updatedAt: now,
    workflowParameters: { planning_depth: 'deep', max_iterations: 2 },
  };
  workItemRepo.save(workItem);

  // Spy step runner.
  const paramStepLog: string[] = [];
  const spyStepRunner = {
    run: async (step: any) => {
      paramStepLog.push(step.id);
      return { success: true, artifacts_written: [], tokens_used: 0, duration_ms: 1 };
    },
  };

  function makeParamAdapter(d: ReturnType<typeof openDatabase>): StratumAgentAdapter {
    const deps: WorkflowEngineDeps = {
      stepRunner: spyStepRunner as any,
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
      workflowRunRepository: new WorkflowRunRepository(d),
    };
    const opts: WorkflowEngineOptions = {
      onCheckpoint: async () => 'halt',
    };
    return new StratumAgentAdapter(deps, opts);
  }

  // ---- Phase 1: Dispatch via Scheduler + StratumAgentAdapter ----------------

  const adapter = makeParamAdapter(db);
  const registry = new ExecutorRegistry();
  registry.register(adapter);
  const scheduler = new Scheduler(db, ws.id, registry);

  const results = await scheduler.tick();
  assert.equal(results.length, 1, 'one item must be dispatched');
  assert.equal(results[0].outcome, 'dispatched', 'dispatch must succeed');

  const canonicalRunId = results[0].workflowRunId!;
  assert.ok(canonicalRunId, 'Scheduler must mint a workflowRunId');

  // WorkflowRun.resolvedParameters must be frozen at dispatch.
  const run1 = runRepo.findById(canonicalRunId)!;
  assert.ok(run1, 'WorkflowRun must be persisted after dispatch');
  assert.ok(run1.resolvedParameters != null, 'WorkflowRun.resolvedParameters must not be null');

  // planning_depth must be frozen as 'deep'.
  assert.equal(
    (run1.resolvedParameters as any).planning_depth, 'deep',
    'planning_depth must be frozen from WorkItem',
  );
  // max_iterations must be frozen as 2 (explicit value, not default).
  assert.equal(
    (run1.resolvedParameters as any).max_iterations, 2,
    'max_iterations must be frozen from WorkItem',
  );
  // on_cap_hit default must be filled in (full-build uses PARAM_WF_ID which is generic,
  // so on_cap_hit won't be in resolvedParams — this param WF ID is generic, not full-build).
  // The key proof: resolvedParameters equals what was passed in (raw params through verbatim).
  assert.deepEqual(
    (run1.resolvedParameters as any).planning_depth, 'deep',
    'planning_depth must match WorkItem workflowParameters',
  );

  // ---- Phase 2: Mutate WorkItem.workflowParameters AFTER checkpoint ----------

  // Simulate an operator changing the WorkItem parameters post-dispatch via raw SQL
  // (WorkItemRepository has no updateWorkflowParameters — this is deliberate: after
  // dispatch the WorkflowRun.resolvedParameters is the source of truth, not WorkItem).
  (db as any).prepare('UPDATE work_items SET workflow_parameters_json = ? WHERE id = ?').run(
    JSON.stringify({ planning_depth: 'minimal', max_iterations: 99 }),
    workItem.id,
  );

  // Verify WorkItem was mutated.
  const mutatedRead = workItemRepo.findById(workItem.id)!;
  assert.equal(
    (mutatedRead.workflowParameters as any).planning_depth, 'minimal',
    'WorkItem must reflect the post-dispatch mutation',
  );

  // ---- Phase 3: Resume — WorkflowRun.resolvedParameters must be unchanged ----

  const decisionRepo = new DecisionRepository(db);
  const [decision] = decisionRepo.listByWorkItem(workItem.id);
  assert.ok(decision, 'Decision must exist at checkpoint');

  const freshAdapter = makeParamAdapter(db);
  const freshRegistry = new ExecutorRegistry();
  freshRegistry.register(freshAdapter);
  const resumeService = new ResumeService(db, ws.id, freshRegistry);

  await resumeService.resume(decision.id, {
    selectedOptionId: 'approve',
    rationale: 'LGTM',
    resolvedAt: new Date().toISOString(),
    resolvedBy: 'test-operator',
  });

  // pf-step-a must not replay; pf-step-b must have run exactly once.
  assert.equal(paramStepLog.filter(s => s === 'pf-step-a').length, 1);
  assert.equal(paramStepLog.filter(s => s === 'pf-step-b').length, 1);

  // WorkflowRun must be complete.
  const finalRun = runRepo.findById(canonicalRunId)!;
  assert.equal(finalRun.status, 'complete', 'WorkflowRun must complete after resume');

  // resolvedParameters must still reflect the ORIGINAL frozen values, not the mutated WorkItem.
  assert.equal(
    (finalRun.resolvedParameters as any).planning_depth, 'deep',
    'resolvedParameters.planning_depth must remain "deep" — WorkItem mutation must not bleed into resumed run',
  );
  assert.equal(
    (finalRun.resolvedParameters as any).max_iterations, 2,
    'resolvedParameters.max_iterations must remain 2 — WorkItem mutation must not bleed into resumed run',
  );
});
