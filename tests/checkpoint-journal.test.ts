/**
 * Checkpoint journal integration recovery tests (A.3).
 *
 * Verifies the APPLYING → APPLIED → finalization state machine under crash
 * scenarios, exercised through real ResumeService.resume() calls with a
 * real SQLite DB and controllable spy services.
 *
 * Scenarios:
 * 1. Finalization-failure recovery — APPLIED but not finalized → retry succeeds
 * 2. Mismatched-option retry → fail closed
 * 3. Rationale mismatch retry → fail closed
 * 4. APPLYING recovery — seeded APPLYING row → retry becomes APPLIED + finalized
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';

import { openDatabase } from '../src/storage/database.js';
import { ResumeService, ResumeServiceError } from '../src/services/resume-service.js';
import { WorkService } from '../src/services/work-service.js';
import { ExecutorRegistry } from '../src/execution/registry.js';
import { registerWorkflow } from '../src/workflow/registry.js';
import {
  WorkspaceRepository,
  ProjectRepository,
  WorkItemRepository,
  DecisionRepository,
  WorkflowRunRepository,
  StepExecutionRepository,
  CheckpointApplicationRepository,
} from '../src/storage/repositories.js';
import type { CheckpointApplication } from '../src/storage/repositories.js';
import type { ExecutionAdapter, ExecutionRequest, ExecutionResult, CapabilitySet } from '../src/execution/types.js';
import type { CheckpointResolver, CheckpointResolverInput, CheckpointResolution } from '../src/execution/checkpoint-resolver.js';
import type { Workspace, Project, WorkItem } from '../src/domain/index.js';

// ── Test workflow ─────────────────────────────────────────────────────────────

const JOURNAL_TEST_WF_ID = `journal-test-${randomUUID()}`;
registerWorkflow({
  id: JOURNAL_TEST_WF_ID,
  label: 'Journal recovery test workflow',
  steps: [
    { id: 'step-a', kind: 'produce', label: 'Before checkpoint' },
    { id: 'confirm', kind: 'checkpoint', label: 'Confirm checkpoint' },
    { id: 'step-b', kind: 'produce', label: 'After checkpoint' },
  ],
});

// ── Stub adapter (stratum-agent id for selectAdapter()) ───────────────────────

function makeStubAdapter(): ExecutionAdapter {
  return {
    id: 'stratum-agent',
    getCapabilities(): CapabilitySet { return new Set(); },
    async execute(_req: ExecutionRequest): Promise<ExecutionResult> {
      return {
        schemaVersion: 1,
        stepExecutionId: randomUUID(),
        outcome: 'succeeded',
        artifacts: [],
        evidenceClaims: [],
        decisionRequests: [],
      };
    },
  };
}

// ── SpyResolver ───────────────────────────────────────────────────────────────

class SpyResolver implements CheckpointResolver {
  public calls: CheckpointResolverInput[] = [];
  private throwOnCall: number | null;
  private readonly resolution: CheckpointResolution;

  constructor(opts: { throwOnCall?: number; resolution?: CheckpointResolution } = {}) {
    this.throwOnCall = opts.throwOnCall ?? null;
    this.resolution = opts.resolution ?? {
      overrideContinuationStepId: 'step-b',
      remainAtCheckpoint: false,
      incrementRevision: false,
      cancel: false,
    };
  }

  async resolveCheckpoint(input: CheckpointResolverInput): Promise<CheckpointResolution> {
    this.calls.push(input);
    if (this.throwOnCall !== null && this.calls.length === this.throwOnCall) {
      throw new Error('SpyResolver: forced failure');
    }
    return this.resolution;
  }
}

// ── ThrowingWorkService ───────────────────────────────────────────────────────

class ThrowingWorkService extends WorkService {
  private throwOnResolveCall: number | null;
  private resolveCount = 0;

  constructor(db: ReturnType<typeof openDatabase>, wsId: string, throwOnResolveCall?: number) {
    super(db, wsId);
    this.throwOnResolveCall = throwOnResolveCall ?? null;
  }

  resolveDecision(...args: Parameters<WorkService['resolveDecision']>) {
    this.resolveCount++;
    if (this.throwOnResolveCall !== null && this.resolveCount === this.throwOnResolveCall) {
      throw new Error('ThrowingWorkService: forced finalization failure');
    }
    return super.resolveDecision(...args);
  }
}

// ── DB seeding ────────────────────────────────────────────────────────────────

interface JournalHarness {
  db: ReturnType<typeof openDatabase>;
  wsId: string;
  decisionId: string;
  runId: string;
  workItemId: string;
}

function seedJournalHarness(): JournalHarness {
  const db = openDatabase(':memory:');
  const now = new Date().toISOString();
  const wsId = randomUUID();
  const projectId = randomUUID();
  const workItemId = randomUUID();
  const runId = randomUUID();
  const decisionId = randomUUID();

  new WorkspaceRepository(db).save({ id: wsId, name: 'ws', createdAt: now } as Workspace);
  new ProjectRepository(db).save({
    id: projectId, workspaceId: wsId, name: 'p',
    status: 'active', priority: 0, createdAt: now, updatedAt: now,
  } as Project);
  new WorkItemRepository(db).save({
    id: workItemId, projectId, repositoryIds: [],
    title: 't', goal: 'g', workflowId: JOURNAL_TEST_WF_ID,
    state: 'needs_decision', priority: 0,
    acceptanceCriteria: [], constraints: [], requiredEvidence: [],
    dependencies: [], createdAt: now, updatedAt: now,
  } as WorkItem);
  new WorkflowRunRepository(db).createOrValidate({
    run_id: runId, workflow_id: JOURNAL_TEST_WF_ID, work_item_id: workItemId,
    status: 'halted', current_step_id: 'confirm',
    iteration: 1, revision: 0, awaiting_checkpoint: 'confirm',
    started_at: now, updated_at: now,
  });
  new DecisionRepository(db).save({
    id: decisionId, projectId, workItemId, type: 'checkpoint',
    subjectRef: { workflowRunId: runId, workItemId, stepId: 'confirm' },
    title: 'Journal test', summary: 'test',
    options: [
      { id: 'approve', label: 'Approve', description: '' },
      { id: 'revise', label: 'Revise', description: '' },
    ],
    impact: 'low', reversibility: 'easy', urgency: 'normal', status: 'pending',
  } as any);

  return { db, wsId, decisionId, runId, workItemId };
}

function makeRegistry(): ExecutorRegistry {
  const r = new ExecutorRegistry();
  r.register(makeStubAdapter());
  return r;
}

// ── Test 1: Finalization-failure recovery ─────────────────────────────────────

test('Journal: APPLIED row with failed finalization → retry succeeds, revision increments once', async () => {
  const { db, wsId, decisionId, runId } = seedJournalHarness();

  const registry = makeRegistry();
  const resolver = new SpyResolver({
    resolution: { overrideContinuationStepId: 'step-b', remainAtCheckpoint: false, incrementRevision: true, cancel: false },
  });

  // First call: resolver succeeds + markApplied succeeds, but finalization (resolveDecision) throws.
  const throwingWs = new ThrowingWorkService(db, wsId, 1);
  const resumeSvc1 = new ResumeService(db, wsId, registry, {}, throwingWs, resolver);

  await assert.rejects(
    () => resumeSvc1.resume(decisionId, { selectedOptionId: 'revise' }),
    /ThrowingWorkService: forced finalization failure/,
    'first resume should propagate the finalization error',
  );

  // After first resume: journal should be APPLIED, Decision still pending, run still halted.
  const journalRow = new CheckpointApplicationRepository(db).findByDecisionId(decisionId) as CheckpointApplication;
  assert.equal(journalRow.state, 'applied', 'journal row must be APPLIED after resolver+markApplied succeed');
  assert.equal(journalRow.incrementRevision, true, 'resolution stored in journal');
  assert.equal(journalRow.continuationStepId, 'step-b');

  const decisionAfterFirst = new DecisionRepository(db).findById(decisionId)!;
  assert.equal(decisionAfterFirst.status, 'pending', 'Decision must still be pending after finalization failure');

  const runAfterFirst = new WorkflowRunRepository(db).findById(runId)!;
  assert.equal(runAfterFirst.status, 'halted', 'WorkflowRun must still be halted after finalization failure');
  assert.equal(runAfterFirst.revision, 0, 'revision must not have been incremented yet');

  // Second call: resolver is NOT called again (APPLIED row found); finalization succeeds.
  const goodWs = new WorkService(db, wsId);
  const resumeSvc2 = new ResumeService(db, wsId, registry, {}, goodWs, resolver);

  await resumeSvc2.resume(decisionId, { selectedOptionId: 'revise' });

  // After second resume: finalization should have succeeded.
  const decisionAfterRetry = new DecisionRepository(db).findById(decisionId)!;
  assert.equal(decisionAfterRetry.status, 'resolved', 'Decision must be resolved after successful retry');

  const runAfterRetry = new WorkflowRunRepository(db).findById(runId)!;
  assert.equal(runAfterRetry.status, 'active', 'WorkflowRun must be active after successful finalization');
  assert.equal(runAfterRetry.revision, 1, 'revision must be incremented exactly once');

  // Resolver was called only once (first attempt) — second attempt used APPLIED journal row.
  assert.equal(resolver.calls.length, 1, 'resolver must not be called on retry if APPLIED');

  db.close();
});

// ── Test 2: Mismatched-option retry ───────────────────────────────────────────

test('Journal: resolver throws → APPLYING row exists → retry with different option → fail closed', async () => {
  const { db, wsId, decisionId } = seedJournalHarness();

  const registry = makeRegistry();
  // Resolver throws on first call — APPLYING row written but markApplied never called.
  const throwingResolver = new SpyResolver({ throwOnCall: 1 });
  const resumeSvc = new ResumeService(db, wsId, registry, {}, undefined, throwingResolver);

  await assert.rejects(
    () => resumeSvc.resume(decisionId, { selectedOptionId: 'revise' }),
    /SpyResolver: forced failure/,
    'first resume should propagate resolver error',
  );

  // APPLYING row exists for 'revise'.
  const row = new CheckpointApplicationRepository(db).findByDecisionId(decisionId)!;
  assert.equal(row.state, 'applying');
  assert.equal(row.selectedOptionId, 'revise');

  // Retry with 'approve' — different option → conflict → fail closed.
  const resumeSvc2 = new ResumeService(db, wsId, registry, {});
  await assert.rejects(
    () => resumeSvc2.resume(decisionId, { selectedOptionId: 'approve' }),
    /selected_option_id mismatch/i,
    'retry with different option must fail closed',
  );

  db.close();
});

// ── Test 3: Rationale mismatch ────────────────────────────────────────────────

test('Journal: APPLYING row with rationale-A → retry with rationale-B → fail closed', async () => {
  const { db, wsId, decisionId } = seedJournalHarness();

  const registry = makeRegistry();
  const throwingResolver = new SpyResolver({ throwOnCall: 1 });
  const resumeSvc = new ResumeService(db, wsId, registry, {}, undefined, throwingResolver);

  await assert.rejects(
    () => resumeSvc.resume(decisionId, { selectedOptionId: 'revise', rationale: 'reason-A' }),
    /SpyResolver: forced failure/,
  );

  // APPLYING row exists with rationale='reason-A'.
  const row = new CheckpointApplicationRepository(db).findByDecisionId(decisionId)!;
  assert.equal(row.state, 'applying');
  assert.equal(row.rationale, 'reason-A');

  // Retry with different rationale → fail closed.
  const resumeSvc2 = new ResumeService(db, wsId, registry, {});
  await assert.rejects(
    () => resumeSvc2.resume(decisionId, { selectedOptionId: 'revise', rationale: 'reason-B' }),
    /rationale mismatch/i,
    'retry with different rationale must fail closed',
  );

  db.close();
});

// ── Test 4: APPLYING recovery ─────────────────────────────────────────────────

test('Journal: seeded APPLYING row → retry re-enters primitive → APPLIED → finalization succeeds', async () => {
  const { db, wsId, decisionId, runId } = seedJournalHarness();

  // Seed an APPLYING row directly (simulating crash after INSERT but before primitive completed).
  const now = new Date().toISOString();
  const runRepo = new WorkflowRunRepository(db);
  const run = runRepo.findById(runId)!;

  db.prepare(`
    INSERT INTO checkpoint_applications
      (decision_id, workflow_run_id, workflow_id, step_id, iteration,
       revision_before, selected_option_id, state, started_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'applying', ?)
  `).run(decisionId, run.run_id, run.workflow_id, 'confirm', 1, 0, 'approve', now);

  // Verify APPLYING row exists.
  const seededRow = new CheckpointApplicationRepository(db).findByDecisionId(decisionId)!;
  assert.equal(seededRow.state, 'applying');

  // Retry with same input → re-enters primitive → journal becomes APPLIED → finalization.
  const registry = makeRegistry();
  const resolver = new SpyResolver({
    resolution: { overrideContinuationStepId: 'step-b', remainAtCheckpoint: false, incrementRevision: false, cancel: false },
  });
  const resumeSvc = new ResumeService(db, wsId, registry, {}, undefined, resolver);

  await resumeSvc.resume(decisionId, { selectedOptionId: 'approve' });

  // Journal is now APPLIED.
  const journalRow = new CheckpointApplicationRepository(db).findByDecisionId(decisionId)!;
  assert.equal(journalRow.state, 'applied');
  assert.equal(journalRow.continuationStepId, 'step-b');

  // Finalization succeeded.
  const decisionRow = new DecisionRepository(db).findById(decisionId)!;
  assert.equal(decisionRow.status, 'resolved');

  const runAfter = runRepo.findById(runId)!;
  assert.equal(runAfter.status, 'active');
  assert.equal(runAfter.current_step_id, 'step-b');

  // Resolver was called once (the APPLYING → re-enter path).
  assert.equal(resolver.calls.length, 1, 'resolver must be called once for APPLYING recovery');

  db.close();
});
