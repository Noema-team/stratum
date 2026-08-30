import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import type { ExecutorRegistry } from '../execution/registry.js';
import type { ExecutionAdapter } from '../execution/types.js';
import type { WorkItem } from '../domain/index.js';
import { WorkService } from '../services/work-service.js';
import { WorkItemRepository, StepExecutionRepository } from '../storage/repositories.js';
import { getWorkflow } from '../workflow/registry.js';
import { LeaseManager } from './lease-manager.js';
import type { SchedulerConfig, DispatchResult } from './types.js';
import { DEFAULT_SCHEDULER_CONFIG } from './types.js';

// The scheduler is deterministic and initially simple (DDR-032 §16).
//
// Responsibilities per tick():
//   1. Expire stale leases
//   2. Find all READY work items (priority-ordered)
//   3. For each candidate, check: deps met, not already active, concurrency
//      limits, repo write leases, adapter availability
//   4. Dispatch: create StepExecution + transition WorkItem to running + call adapter
//   5. On adapter result: update StepExecution + transition WorkItem state
//   6. Release leases
//
// Execution is sequential within a tick — parallelism is left for a later phase.
export class Scheduler {
  private readonly workRepo: WorkItemRepository;
  private readonly stepExecRepo: StepExecutionRepository;
  private readonly workService: WorkService;
  private readonly leaseManager: LeaseManager;
  private readonly config: SchedulerConfig;

  constructor(
    private readonly db: Database.Database,
    workspaceId: string,
    private readonly registry: ExecutorRegistry,
    config: Partial<SchedulerConfig> = {},
  ) {
    this.config = { ...DEFAULT_SCHEDULER_CONFIG, ...config };
    this.workRepo = new WorkItemRepository(db);
    this.stepExecRepo = new StepExecutionRepository(db);
    this.workService = new WorkService(db, workspaceId);
    this.leaseManager = new LeaseManager(db);
  }

  async tick(): Promise<DispatchResult[]> {
    this.leaseManager.expireOld();

    const candidates = this.workRepo.listAllByState('ready');
    const results: DispatchResult[] = [];

    for (const item of candidates) {
      const result = await this.tryDispatch(item);
      results.push(result);
    }

    return results;
  }

  private async tryDispatch(item: WorkItem): Promise<DispatchResult> {
    const { id: workItemId, projectId, repositoryIds, workflowId } = item;

    // 1. Dependency gate — all blocking dependencies must be completed.
    if (!this.workRepo.areDependenciesMet(workItemId)) {
      return { workItemId, outcome: 'skipped_deps' };
    }

    // 2. Idempotency — skip if there is already an active step execution.
    if (this.stepExecRepo.findActiveByWorkItem(workItemId)) {
      return { workItemId, outcome: 'skipped_already_active' };
    }

    // 3. Per-project concurrency limit.
    const projectRunning = this.workRepo.countByStateForProject(projectId, 'running');
    if (projectRunning >= this.config.maxConcurrentPerProject) {
      return { workItemId, outcome: 'skipped_concurrency' };
    }

    // 4. Global execution limit.
    const globalRunning = this.workRepo.countAllByState('running');
    if (globalRunning >= this.config.globalExecutionLimit) {
      return { workItemId, outcome: 'skipped_concurrency' };
    }

    // 5. Find an adapter for this workflow.
    const adapter = this.selectAdapter(workflowId);
    if (!adapter) {
      return { workItemId, outcome: 'skipped_no_adapter' };
    }

    // 6. Acquire repository write leases (§16.2).
    const reposToLease = repositoryIds.length > 0 ? repositoryIds : [null];
    for (const repoId of reposToLease) {
      const lease = this.leaseManager.tryAcquireWrite(workItemId, repoId, this.config.leaseExpiryMs);
      if (!lease) {
        this.leaseManager.releaseAll(workItemId);
        return { workItemId, outcome: 'skipped_lease' };
      }
    }

    // 7. Atomically create StepExecution + transition WorkItem to running.
    const stepExecutionId = randomUUID();
    const workflowRunId = randomUUID();
    const now = new Date().toISOString();

    try {
      this.db.transaction(() => {
        this.stepExecRepo.save({
          id: stepExecutionId,
          workItemId,
          workflowRunId,
          stepId: '__start__',
          executor: adapter.id,
          state: 'dispatched',
          attempt: 1,
          startedAt: now,
        });
        // dependencyOverride avoids a redundant re-check (already checked above).
        this.workService.startRunning({ workItemId, dependencyOverride: true });
      })();
    } catch (err) {
      this.leaseManager.releaseAll(workItemId);
      return { workItemId, outcome: 'failed', error: String(err) };
    }

    // 8. Execute via adapter (synchronous in Phase 5 — async dispatch in a later phase).
    try {
      // Derive the workflow's first step from the registered definition.
      const wfDef = getWorkflow(workflowId);
      const entryStepId = wfDef?.steps[0]?.id ?? '__start__';

      // Resolve repository remotes from WorkItem data; default to empty for
      // repositories without a stored remote (caller fills in later phases).
      const repositories = repositoryIds.map(id => ({
        id,
        remote: (item as any).repositories?.find((r: any) => r.id === id)?.remote ?? '',
        branch: (item as any).repositories?.find((r: any) => r.id === id)?.defaultBranch ?? 'main',
      }));

      const execResult = await adapter.execute({
        stepExecutionId,
        workItemId,
        workflowRunId,
        stepId: entryStepId,
        workflowId,
        repositories,
        goal: item.goal,
        acceptanceCriteria: item.acceptanceCriteria,
        constraints: item.constraints,
        permissions: { pushBranch: false, createPr: false, merge: false },
        budget: {
          maxAttempts: this.config.maxAttempts,
        },
      });

      const completedAt = new Date().toISOString();

      if (execResult.outcome === 'succeeded') {
        this.stepExecRepo.updateState(stepExecutionId, 'succeeded', { completedAt });
        this.workService.markInReview({ workItemId });
      } else if (execResult.outcome === 'blocked') {
        // Workflow paused at a human-in-the-loop checkpoint.
        // Mark the step execution 'waiting' (not cancelled — it successfully reached
        // the checkpoint) and create a first-class Decision so operators can track
        // and resolve the pause. WorkItem transitions to 'needs_decision'.
        this.stepExecRepo.updateState(stepExecutionId, 'waiting', { completedAt });
        this.workService.needsDecision({
          workItemId,
          decision: {
            type: 'checkpoint',
            subjectRef: {
              workflowRunId,
              workItemId,
              stepId: execResult.checkpointStepId,
            },
            title: 'Workflow reached a checkpoint',
            summary: `Workflow '${workflowId}' paused at step '${execResult.checkpointStepId ?? 'unknown'}' and requires operator approval to continue.`,
            options: [
              { id: 'approve', label: 'Approve', description: 'Continue the workflow past this checkpoint' },
              { id: 'reject', label: 'Reject', description: 'Cancel the workflow run' },
            ],
            recommendedOptionId: 'approve',
            impact: 'medium',
            reversibility: 'easy',
            urgency: 'normal',
          },
        });
      } else {
        this.stepExecRepo.updateState(stepExecutionId, 'failed', {
          completedAt,
          failure: execResult.failure
            ? { code: execResult.failure.code, message: execResult.failure.message }
            : { code: 'execution_failed', message: 'adapter reported non-success outcome' },
        });
        this.workService.fail({ workItemId, reason: execResult.failure?.message ?? 'execution_failed' });
      }
    } catch (err) {
      this.stepExecRepo.updateState(stepExecutionId, 'failed', {
        completedAt: new Date().toISOString(),
        failure: { code: 'adapter_exception', message: String(err) },
      });
      this.workService.fail({ workItemId, reason: String(err) });
    } finally {
      this.leaseManager.releaseAll(workItemId);
    }

    return { workItemId, outcome: 'dispatched', stepExecutionId, workflowRunId };
  }

  private selectAdapter(_workflowId: string): ExecutionAdapter | undefined {
    // Phase 5: use stratum-agent for all workflows if registered; otherwise fall
    // back to any adapter with repo.read capability. Later phases can match on
    // workflow-specific capability requirements.
    return this.registry.findById('stratum-agent')
      ?? this.registry.findByCapabilities(new Set(['repo.read']));
  }
}
