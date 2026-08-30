import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import type { Decision } from '../domain/index.js';
import { WorkService } from './work-service.js';
import {
  DecisionRepository,
  WorkflowRunRepository,
  WorkItemRepository,
  StepExecutionRepository,
  RepositoryRepository,
} from '../storage/repositories.js';
import { getWorkflow } from '../workflow/registry.js';
import type { ExecutionAdapter } from '../execution/types.js';

// ============================================================================
// ResumeService — resolves a checkpoint Decision and continues the same run.
//
// Lifecycle:
//   1. Verify Decision is pending
//   2. Verify WorkflowRun is halted at that checkpoint
//   3. Derive continuation step (step after the checkpoint in the workflow def)
//   4. Atomically: resolve Decision + transition WorkItem → 'running' + advance
//      WorkflowRun cursor past the checkpoint + close the waiting StepExecution
//   5. Create a new StepExecution for the resumed segment
//   6. Call adapter.execute() with the same workflowRunId and continuationStepId
//   7. Update WorkItem state based on the result
//
// The engine's INSERT-OR-IGNORE on resume is a no-op (run row already exists).
// Execution starts from continuationStepId — the checkpoint step is never replayed.
// ============================================================================

export class ResumeServiceError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'ResumeServiceError';
  }
}

export class ResumeService {
  private readonly workService: WorkService;
  private readonly decisionRepo: DecisionRepository;
  private readonly runRepo: WorkflowRunRepository;
  private readonly workItemRepo: WorkItemRepository;
  private readonly stepExecRepo: StepExecutionRepository;
  private readonly repoRepo: RepositoryRepository;

  constructor(
    private readonly db: Database.Database,
    workspaceId: string,
    private readonly adapter: ExecutionAdapter,
  ) {
    this.workService = new WorkService(db, workspaceId);
    this.decisionRepo = new DecisionRepository(db);
    this.runRepo = new WorkflowRunRepository(db);
    this.workItemRepo = new WorkItemRepository(db);
    this.stepExecRepo = new StepExecutionRepository(db);
    this.repoRepo = new RepositoryRepository(db);
  }

  async resume(
    decisionId: string,
    resolution: Decision['resolution'],
  ): Promise<void> {
    if (!resolution) {
      throw new ResumeServiceError('Resolution is required', 'MISSING_RESOLUTION');
    }

    // (1) Load and verify the Decision is still pending (idempotency guard).
    const decision = this.decisionRepo.findById(decisionId);
    if (!decision) {
      throw new ResumeServiceError(`Decision '${decisionId}' not found`, 'NOT_FOUND');
    }
    if (decision.status !== 'pending') {
      throw new ResumeServiceError(
        `Decision '${decisionId}' is already '${decision.status}' — cannot resume twice`,
        'ALREADY_RESOLVED',
      );
    }

    // (1b) Decision must be a checkpoint type.
    if (decision.type !== 'checkpoint') {
      throw new ResumeServiceError(
        `Decision '${decisionId}' has type '${decision.type}', expected 'checkpoint'`,
        'WRONG_TYPE',
      );
    }

    const subjectRef = decision.subjectRef as {
      workflowRunId?: string;
      workItemId?: string;
      stepId?: string;
    };
    const { workflowRunId, workItemId, stepId: checkpointStepIdRef } = subjectRef;
    if (!workflowRunId) {
      throw new ResumeServiceError(
        'Decision.subjectRef.workflowRunId is required for checkpoint resume',
        'MISSING_RUN_ID',
      );
    }
    if (!workItemId) {
      throw new ResumeServiceError(
        'Decision.subjectRef.workItemId is required for checkpoint resume',
        'MISSING_WORK_ITEM_ID',
      );
    }

    // (1c) Validate selectedOptionId exists in the decision's options.
    const selectedOption = decision.options?.find(o => o.id === resolution?.selectedOptionId);
    if (resolution?.selectedOptionId && !selectedOption) {
      throw new ResumeServiceError(
        `Option '${resolution.selectedOptionId}' is not valid for Decision '${decisionId}'`,
        'INVALID_OPTION',
      );
    }

    // (2) Load and verify WorkflowRun is halted at a checkpoint.
    const run = this.runRepo.findById(workflowRunId);
    if (!run) {
      throw new ResumeServiceError(`WorkflowRun '${workflowRunId}' not found`, 'RUN_NOT_FOUND');
    }
    if (run.status !== 'halted') {
      throw new ResumeServiceError(
        `WorkflowRun '${workflowRunId}' is '${run.status}', expected 'halted'`,
        'INVALID_RUN_STATUS',
      );
    }
    if (!run.awaiting_checkpoint) {
      throw new ResumeServiceError(
        `WorkflowRun '${workflowRunId}' is halted but not awaiting a checkpoint`,
        'NOT_AT_CHECKPOINT',
      );
    }
    // Verify Decision ↔ WorkflowRun linkage.
    if (decision.workItemId !== workItemId) {
      throw new ResumeServiceError(
        `Decision.workItemId '${decision.workItemId}' does not match subjectRef.workItemId '${workItemId}'`,
        'WORK_ITEM_MISMATCH',
      );
    }
    if (run.work_item_id && run.work_item_id !== workItemId) {
      throw new ResumeServiceError(
        `WorkflowRun '${workflowRunId}' is linked to WorkItem '${run.work_item_id}', not '${workItemId}'`,
        'WORK_ITEM_MISMATCH',
      );
    }
    if (checkpointStepIdRef && checkpointStepIdRef !== run.awaiting_checkpoint) {
      throw new ResumeServiceError(
        `Decision.subjectRef.stepId '${checkpointStepIdRef}' does not match run.awaiting_checkpoint '${run.awaiting_checkpoint}'`,
        'CHECKPOINT_STEP_MISMATCH',
      );
    }

    // (3) Derive the continuation step — the step immediately after the checkpoint.
    const def = getWorkflow(run.workflow_id);
    if (!def) {
      throw new ResumeServiceError(`Unknown workflow '${run.workflow_id}'`, 'UNKNOWN_WORKFLOW');
    }
    const checkpointIdx = def.steps.findIndex(s => s.id === run.awaiting_checkpoint);
    if (checkpointIdx === -1) {
      throw new ResumeServiceError(
        `Checkpoint step '${run.awaiting_checkpoint}' not found in workflow '${run.workflow_id}'`,
        'CHECKPOINT_STEP_NOT_FOUND',
      );
    }
    const nextStep = def.steps[checkpointIdx + 1] ?? null;
    const continuationStepId = nextStep?.id ?? null;

    // Load WorkItem for the ExecutionRequest.
    const workItem = this.workItemRepo.findById(workItemId);
    if (!workItem) {
      throw new ResumeServiceError(`WorkItem '${workItemId}' not found`, 'WORK_ITEM_NOT_FOUND');
    }

    const now = new Date().toISOString();
    const isReject = resolution?.selectedOptionId === 'reject';

    // Find the 'waiting' StepExecution(s) for this run so we can close them.
    const waitingExecs = this.stepExecRepo
      .listByWorkflowRun(workflowRunId)
      .filter(se => se.state === 'waiting');

    if (isReject) {
      // Reject path: resolve Decision + cancel WorkItem + halt WorkflowRun — no execution.
      this.db.transaction(() => {
        for (const se of waitingExecs) {
          this.stepExecRepo.updateState(se.id, 'cancelled', { completedAt: now });
        }
        this.workService.resolveDecision(decisionId, resolution, 'running');
        this.runRepo.update({
          ...run,
          status: 'halted',
          current_step_id: run.awaiting_checkpoint!,
          awaiting_checkpoint: null,
          updated_at: now,
        });
      })();
      this.workService.cancel({ workItemId, reason: 'checkpoint rejected' });
      return;
    }

    // Approve path: mint StepExecution inside the same atomic transaction so there
    // is no crash window between the state transition and the new execution record.
    const stepExecutionId = randomUUID();

    // (4) Atomic transition:
    //   • close waiting StepExecution(s) → 'succeeded'
    //   • resolve Decision (its own SAVEPOINT via db.transaction())
    //   • transition WorkItem → 'running' (done inside resolveDecision)
    //   • advance WorkflowRun cursor past the checkpoint
    //   • create new StepExecution (dispatched) — inside the transaction to close crash window
    this.db.transaction(() => {
      for (const se of waitingExecs) {
        this.stepExecRepo.updateState(se.id, 'succeeded', { completedAt: now });
      }
      this.workService.resolveDecision(decisionId, resolution, 'running');
      this.runRepo.update({
        ...run,
        status: continuationStepId ? 'active' : 'complete',
        current_step_id: continuationStepId ?? run.awaiting_checkpoint!,
        awaiting_checkpoint: null,
        updated_at: now,
      });
      if (continuationStepId) {
        this.stepExecRepo.save({
          id: stepExecutionId,
          workItemId,
          workflowRunId,
          stepId: continuationStepId,
          executor: this.adapter.id,
          state: 'dispatched',
          attempt: 1,
          startedAt: now,
        });
      }
    })();

    if (!continuationStepId) {
      // The checkpoint was the last step — workflow is complete.
      this.workService.markInReview({ workItemId });
      return;
    }

    // (6) Execute via adapter — same workflowRunId, starting from the continuation step.
    //     The engine's INSERT OR IGNORE is a no-op (WorkflowRun row already exists with
    //     the cleared checkpoint and updated cursor).
    let execResult;
    try {
      execResult = await this.adapter.execute({
        stepExecutionId,
        workItemId,
        workflowRunId,
        stepId: continuationStepId,
        workflowId: run.workflow_id,
        repositories: workItem.repositoryIds.map(id => {
          const stored = this.repoRepo.findById(id);
          return { id, remote: stored?.remote ?? '', branch: stored?.defaultBranch ?? 'main' };
        }),
        goal: workItem.goal,
        acceptanceCriteria: workItem.acceptanceCriteria,
        constraints: workItem.constraints,
        permissions: { pushBranch: false, createPr: false, merge: false },
        budget: {},
      });
    } catch (err) {
      const completedAt = new Date().toISOString();
      this.stepExecRepo.updateState(stepExecutionId, 'failed', {
        completedAt,
        failure: { code: 'adapter_exception', message: String(err) },
      });
      this.workService.fail({ workItemId, reason: String(err) });
      throw new ResumeServiceError(
        `Adapter threw during resume execution: ${String(err)}`,
        'ADAPTER_EXCEPTION',
      );
    }

    // (7) Handle the resumed execution's result.
    const doneAt = new Date().toISOString();

    if (execResult.outcome === 'succeeded') {
      this.stepExecRepo.updateState(stepExecutionId, 'succeeded', { completedAt: doneAt });
      this.workService.markInReview({ workItemId });
    } else if (execResult.outcome === 'blocked') {
      // Another checkpoint encountered in the continuation segment.
      this.stepExecRepo.updateState(stepExecutionId, 'waiting', { completedAt: doneAt });
      this.workService.needsDecision({
        workItemId,
        decision: {
          type: 'checkpoint',
          subjectRef: {
            workflowRunId,
            workItemId,
            stepId: execResult.checkpointStepId,
          },
          title: 'Workflow reached another checkpoint',
          summary: `Workflow '${run.workflow_id}' paused at step '${execResult.checkpointStepId ?? 'unknown'}'.`,
          options: [
            { id: 'approve', label: 'Approve', description: 'Continue past this checkpoint' },
            { id: 'reject', label: 'Reject', description: 'Cancel the workflow' },
          ],
          recommendedOptionId: 'approve',
          impact: 'medium',
          reversibility: 'easy',
          urgency: 'normal',
        },
      });
    } else {
      const failureInfo = execResult.failure ?? { code: 'execution_failed', message: 'adapter reported failure' };
      this.stepExecRepo.updateState(stepExecutionId, 'failed', {
        completedAt: doneAt,
        failure: failureInfo,
      });
      this.workService.fail({ workItemId, reason: failureInfo.message });
    }
  }
}
