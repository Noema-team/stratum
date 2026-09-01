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
  CheckpointApplicationRepository,
} from '../storage/repositories.js';
import { getWorkflow } from '../workflow/registry.js';
import type { ExecutorRegistry } from '../execution/registry.js';
import { resolveRepositories, selectAdapter } from '../execution/dispatch-primitive.js';
import { LeaseManager } from '../scheduler/lease-manager.js';
import { DEFAULT_SCHEDULER_CONFIG } from '../scheduler/types.js';
import type { CheckpointResolver } from '../execution/checkpoint-resolver.js';

// ============================================================================
// ResumeService — resolves a checkpoint Decision and continues the same run.
//
// Lifecycle (approve):
//   1. Strict 9-field linkage validation — fail closed, no defaults
//   2. Verify Decision pending + WorkflowRun halted at checkpoint
//   3. Derive continuation step (step after the checkpoint in the workflow def)
//   4. Acquire repository write leases (same invariant as Scheduler.tryDispatch)
//   5. Atomically: close StepExecution(waiting→succeeded) + resolve Decision +
//      WorkItem(needs_decision→running) + advance WorkflowRun cursor +
//      create new StepExecution(state='dispatched')
//   6. Call adapter.execute() with the same workflowRunId and continuationStepId
//   7. Update WorkItem state based on the result
//   8. Release leases (in finally)
//
// Lifecycle (reject):
//   1. Same validation through step 2
//   4. Atomically: StepExecution→cancelled + Decision→resolved + WorkItem→cancelled
//      + WorkflowRun→halted (all in one transaction; no execution)
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
  private readonly leaseManager: LeaseManager;
  private readonly leaseExpiryMs: number;

  private readonly checkpointResolver: CheckpointResolver | null;
  private readonly checkpointApplicationRepo: CheckpointApplicationRepository;

  constructor(
    private readonly db: Database.Database,
    workspaceId: string,
    private readonly registry: ExecutorRegistry,
    config: { leaseExpiryMs?: number } = {},
    workService?: WorkService,
    checkpointResolver?: CheckpointResolver,
  ) {
    this.workService = workService ?? new WorkService(db, workspaceId);
    this.decisionRepo = new DecisionRepository(db);
    this.runRepo = new WorkflowRunRepository(db);
    this.workItemRepo = new WorkItemRepository(db);
    this.stepExecRepo = new StepExecutionRepository(db);
    this.repoRepo = new RepositoryRepository(db);
    this.leaseManager = new LeaseManager(db);
    this.leaseExpiryMs = config.leaseExpiryMs ?? DEFAULT_SCHEDULER_CONFIG.leaseExpiryMs;
    this.checkpointResolver = checkpointResolver ?? null;
    this.checkpointApplicationRepo = new CheckpointApplicationRepository(db);
  }

  async resume(
    decisionId: string,
    resolution: Decision['resolution'],
  ): Promise<void> {

    // ── (1a) Resolution is required; selectedOptionId is required. ────────────
    if (!resolution) {
      throw new ResumeServiceError('Resolution is required', 'MISSING_RESOLUTION');
    }
    if (!resolution.selectedOptionId) {
      throw new ResumeServiceError(
        'resolution.selectedOptionId is required',
        'MISSING_OPTION_ID',
      );
    }

    // ── (1b) Load Decision; verify pending. ───────────────────────────────────
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

    // ── (1c) Decision must be type 'checkpoint'. ──────────────────────────────
    if (decision.type !== 'checkpoint') {
      throw new ResumeServiceError(
        `Decision '${decisionId}' has type '${decision.type}', expected 'checkpoint'`,
        'WRONG_TYPE',
      );
    }

    // ── (1d) selectedOptionId must exist in Decision.options. ─────────────────
    const selectedOption = decision.options?.find(o => o.id === resolution.selectedOptionId);
    if (!selectedOption) {
      throw new ResumeServiceError(
        `Option '${resolution.selectedOptionId}' is not valid for Decision '${decisionId}'`,
        'INVALID_OPTION',
      );
    }

    // ── (1e) Strict 9-field linkage validation. ───────────────────────────────
    // All three WorkItem IDs must be present and equal:
    //   decision.workItemId === subjectRef.workItemId === run.work_item_id
    // Plus: subjectRef.workflowRunId === run.run_id
    //       subjectRef.stepId (required) === run.awaiting_checkpoint

    if (!decision.workItemId) {
      throw new ResumeServiceError(
        'Decision.workItemId is required for checkpoint resume',
        'MISSING_DECISION_WORK_ITEM_ID',
      );
    }

    const subjectRef = decision.subjectRef as {
      workflowRunId?: string;
      workItemId?: string;
      stepId?: string;
    };
    const { workflowRunId, workItemId: subjectWorkItemId, stepId: checkpointStepIdRef } = subjectRef;

    if (!workflowRunId) {
      throw new ResumeServiceError(
        'Decision.subjectRef.workflowRunId is required for checkpoint resume',
        'MISSING_RUN_ID',
      );
    }
    if (!subjectWorkItemId) {
      throw new ResumeServiceError(
        'Decision.subjectRef.workItemId is required for checkpoint resume',
        'MISSING_SUBJECT_WORK_ITEM_ID',
      );
    }
    if (!checkpointStepIdRef) {
      throw new ResumeServiceError(
        'Decision.subjectRef.stepId is required for checkpoint resume',
        'MISSING_CHECKPOINT_STEP_ID',
      );
    }
    if (decision.workItemId !== subjectWorkItemId) {
      throw new ResumeServiceError(
        `Decision.workItemId '${decision.workItemId}' does not match subjectRef.workItemId '${subjectWorkItemId}'`,
        'WORK_ITEM_MISMATCH',
      );
    }

    // ── (2) Load and verify WorkflowRun is halted at a checkpoint. ────────────
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

    // WorkflowRun.work_item_id is required — standalone runs (NULL) cannot have
    // human-in-the-loop checkpoints since there is no WorkItem to transition.
    if (!run.work_item_id) {
      throw new ResumeServiceError(
        `WorkflowRun '${workflowRunId}' has no work_item_id — cannot resolve checkpoint`,
        'MISSING_RUN_WORK_ITEM_ID',
      );
    }

    // All three WorkItem IDs must agree.
    const workItemId = run.work_item_id;
    if (subjectWorkItemId !== workItemId) {
      throw new ResumeServiceError(
        `subjectRef.workItemId '${subjectWorkItemId}' does not match WorkflowRun.work_item_id '${workItemId}'`,
        'WORK_ITEM_MISMATCH',
      );
    }
    if (decision.workItemId !== workItemId) {
      throw new ResumeServiceError(
        `Decision.workItemId '${decision.workItemId}' does not match WorkflowRun.work_item_id '${workItemId}'`,
        'WORK_ITEM_MISMATCH',
      );
    }

    // subjectRef.stepId must exactly match run.awaiting_checkpoint.
    if (checkpointStepIdRef !== run.awaiting_checkpoint) {
      throw new ResumeServiceError(
        `Decision.subjectRef.stepId '${checkpointStepIdRef}' does not match run.awaiting_checkpoint '${run.awaiting_checkpoint}'`,
        'CHECKPOINT_STEP_MISMATCH',
      );
    }

    // ── (3) Derive the natural continuation step (step after the checkpoint). ─
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
    const naturalNextStepId = def.steps[checkpointIdx + 1]?.id ?? null;

    // Load WorkItem for the ExecutionRequest.
    const workItem = this.workItemRepo.findById(workItemId);
    if (!workItem) {
      throw new ResumeServiceError(`WorkItem '${workItemId}' not found`, 'WORK_ITEM_NOT_FOUND');
    }

    const now = new Date().toISOString();

    // Find the 'waiting' StepExecution(s) for this run so we can close them.
    const waitingExecs = this.stepExecRepo
      .listByWorkflowRun(workflowRunId)
      .filter(se => se.state === 'waiting');

    // ── (4a) Adapter selection BEFORE resolver — same logic as Scheduler.tryDispatch.
    // Must happen before resolveCheckpoint so a retry after resolver success + crash
    // does not fail at "no adapter" after the side effect was already applied.
    const adapter = selectAdapter(this.registry);
    if (!adapter) {
      throw new ResumeServiceError(
        'No execution adapter available for resume',
        'NO_ADAPTER',
      );
    }

    // (4b) Repository resolution — fail closed; missing repository is a kernel error.
    const repositories = resolveRepositories(workItem.repositoryIds, this.repoRepo);

    // (4c) Acquire repository write leases BEFORE resolver — same invariant as Scheduler.
    const toLease = workItem.repositoryIds.length > 0 ? workItem.repositoryIds : [null as string | null];
    for (const repoId of toLease) {
      const lease = this.leaseManager.tryAcquireWrite(workItemId, repoId, this.leaseExpiryMs);
      if (!lease) {
        this.leaseManager.releaseAll(workItemId);
        throw new ResumeServiceError(
          `Cannot acquire write lease for repository '${repoId ?? '(none)'}' — another item holds it`,
          'LEASE_CONFLICT',
        );
      }
    }

    // ── (3b) Execute checkpoint side effects via resolver, then commit or cancel.
    // Leases are held for the duration so retries cannot race with another dispatch.
    // leaseManager.releaseAll is called in the outer finally below.
    try {
      // ── Journal: write APPLYING before any side effects ──────────────────────
      // 'modify' is the only option that keeps the Decision pending with no side
      // effects — it doesn't need a journal row and can be retried freely.
      let continuationStepId: string | null;
      let journaledResolution: { remainAtCheckpoint: boolean; incrementRevision: boolean; cancel: boolean };

      if (resolution.selectedOptionId === 'modify') {
        // modify: no journal, no finalization — call resolver for optional effects and return.
        if (this.checkpointResolver) {
          await this.checkpointResolver.resolveCheckpoint({
            workflowId: run.workflow_id,
            stepId: run.awaiting_checkpoint!,
            decisionId,
            selectedOptionId: 'modify',
            rationale: resolution.rationale ?? undefined,
            workflowRunId,
            iteration: run.iteration,
            revision: run.revision,
          });
        }
        return;
      }

      const appRow = this.checkpointApplicationRepo.createOrLoadApplying({
        decisionId,
        workflowRunId,
        workflowId: run.workflow_id,
        stepId: run.awaiting_checkpoint!,
        iteration: run.iteration,
        revisionBefore: run.revision,
        selectedOptionId: resolution.selectedOptionId!,
        rationale: resolution.rationale ?? undefined,
      });

      if (appRow.state === 'applied') {
        // Primitive already ran — skip it and use the stored resolution.
        continuationStepId = appRow.continuationStepId;
        journaledResolution = {
          remainAtCheckpoint: appRow.remainAtCheckpoint,
          incrementRevision: appRow.incrementRevision,
          cancel: appRow.cancel,
        };
      } else {
        // APPLYING — execute the primitive.
        let rawResolution: import('../execution/checkpoint-resolver.js').CheckpointResolution = {
          remainAtCheckpoint: false,
          incrementRevision: false,
          cancel: resolution.selectedOptionId === 'reject',
        };

        if (this.checkpointResolver) {
          rawResolution = await this.checkpointResolver.resolveCheckpoint({
            workflowId: run.workflow_id,
            stepId: run.awaiting_checkpoint!,
            decisionId,
            selectedOptionId: resolution.selectedOptionId!,
            rationale: resolution.rationale ?? undefined,
            workflowRunId,
            iteration: run.iteration,
            revision: run.revision,
          });
        }

        journaledResolution = {
          remainAtCheckpoint: rawResolution.remainAtCheckpoint,
          incrementRevision: rawResolution.incrementRevision,
          cancel: rawResolution.cancel,
        };

        // Compute the resolved continuation step now so it can be stored in the journal.
        if (rawResolution.remainAtCheckpoint || rawResolution.cancel) {
          continuationStepId = null;
        } else {
          continuationStepId =
            rawResolution.overrideContinuationStepId !== undefined
              ? rawResolution.overrideContinuationStepId === '__next__'
                ? naturalNextStepId
                : rawResolution.overrideContinuationStepId
              : naturalNextStepId;
        }

        // Mark APPLIED — stores the exact resolution for crash recovery.
        this.checkpointApplicationRepo.markApplied(decisionId, {
          continuationStepId,
          remainAtCheckpoint: rawResolution.remainAtCheckpoint,
          incrementRevision: rawResolution.incrementRevision,
          cancel: rawResolution.cancel,
        });
      }

      // If the resolver says "remain at checkpoint" (e.g. sharding modify),
      // leave the Decision pending and the run halted — nothing to commit.
      if (journaledResolution.remainAtCheckpoint) {
        return;
      }

      // ── Cancel path (fully atomic — no execution) ───────────────────────────
      if (journaledResolution.cancel) {
        this.db.transaction(() => {
          for (const se of waitingExecs) {
            this.stepExecRepo.updateState(se.id, 'cancelled', { completedAt: now });
          }
          this.workService.resolveDecision(decisionId, resolution, 'cancelled');
          this.runRepo.update({
            ...run,
            status: 'halted',
            current_step_id: run.awaiting_checkpoint!,
            awaiting_checkpoint: null,
            updated_at: now,
          });
        })();
        return;
      }

      // ── Continue path ────────────────────────────────────────────────────────
      // continuationStepId is already resolved (journal stores the definitive value).

      // (5) Atomic transition:
      //   • close waiting StepExecution(s) → 'succeeded'
      //   • resolve Decision + WorkItem(needs_decision → running)
      //   • advance WorkflowRun cursor past the checkpoint (optionally bumping revision)
      //   • create new StepExecution(state='dispatched')
      const stepExecutionId = randomUUID();

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
          revision: journaledResolution.incrementRevision ? run.revision + 1 : run.revision,
          updated_at: now,
        });
        if (continuationStepId) {
          this.stepExecRepo.save({
            id: stepExecutionId,
            workItemId,
            workflowRunId,
            stepId: continuationStepId,
            executor: adapter.id,
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
      //     The engine's INSERT OR IGNORE is a no-op (WorkflowRun row already exists).
      let execResult;
      try {
        execResult = await adapter.execute({
          stepExecutionId,
          workItemId,
          workflowRunId,
          stepId: continuationStepId,
          workflowId: run.workflow_id,
          repositories,
          goal: workItem.goal,
          acceptanceCriteria: workItem.acceptanceCriteria,
          constraints: workItem.constraints,
          permissions: { pushBranch: false, createPr: false, merge: false },
          budget: {},
          workflowParameters: run.resolvedParameters,
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
        // Fail closed — require checkpointStepId and non-empty options in the first
        // DecisionRequest. A missing contract is an adapter bug; mark run failed.
        const nextDecisionReq = execResult.decisionRequests[0];
        if (!execResult.checkpointStepId || !nextDecisionReq || !nextDecisionReq.options.length) {
          this.stepExecRepo.updateState(stepExecutionId, 'failed', {
            completedAt: doneAt,
            failure: {
              code: 'invalid_checkpoint_contract',
              message: 'blocked outcome missing checkpointStepId or non-empty DecisionRequest options',
            },
          });
          this.workService.fail({ workItemId, reason: 'invalid_checkpoint_contract' });
          return;
        }
        this.stepExecRepo.updateState(stepExecutionId, 'waiting', { completedAt: doneAt });
        const nextDecisionOptions = nextDecisionReq.options;
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
            options: nextDecisionOptions,
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
    } finally {
      this.leaseManager.releaseAll(workItemId);
    }
  }
}
