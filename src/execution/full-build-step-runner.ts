import { promises as fs } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import type { WorkflowStep, StepRunner, StepRunContext, StepRunOutcome, StepResult } from '../workflow/types.js';
import type { CriticAgent } from '../critic-agent.js';
import type { ConfirmService } from '../confirm-service.js';
import type { ExecService, ValidationGateService } from '../exec-gate.js';
import type { SnapshotService } from '../snapshot-service.js';
import type { SummariseService } from '../summarise-service.js';
import type { RuntimeMapManager } from '../runtime-map.js';
import type { RunArtifactManager } from '../run-artifacts.js';
import type { ShardingService } from '../sharding-service.js';
import type { ScopingService } from '../scoping-service.js';
import type { AgentStepRunner } from './agent-step-runner.js';
import { updateArtifactEntries } from '../workflow/artifact-utils.js';
import type { CheckpointResolution, CheckpointResolver, CheckpointResolverInput } from './checkpoint-resolver.js';

// All service dependencies for the full-build workflow's step execution.
// This keeps full-build-specific concerns (CriticAgent, ValidationGateService,
// sharding, scoping, etc.) outside of WorkflowEngine.
export interface FullBuildStepRunnerDeps {
  agentStepRunner: AgentStepRunner;
  mapManager: RuntimeMapManager;
  runArtifacts: RunArtifactManager;
  projectRoot: string;
  criticAgent?: CriticAgent;
  confirmService: ConfirmService;
  execService: ExecService;
  validationGateService: ValidationGateService;
  snapshotService: SnapshotService;
  summariseService: SummariseService;
  shardingService?: ShardingService;
  scopingService?: ScopingService;
}

export interface FullBuildCallbacks {
  onCheckpoint: (workflowRunId: string, stepId: string, iteration: number) => Promise<'approve' | 'halt'>;
  onConfirmGate: (workflowRunId: string, iteration: number) => Promise<'approve' | 'revise' | 'halt'>;
  onShardingGate: (workflowRunId: string, iteration: number) => Promise<'approve' | 'reject' | 'modify' | 'halt'>;
}

// StepRunner implementation for the full-build workflow. Implements the three
// optional kind-override methods so WorkflowEngine has zero knowledge of
// full-build step IDs, services, or callback contracts.
export class FullBuildStepRunner implements StepRunner, CheckpointResolver {
  // Per-run critique retry counts. Keyed by workflowRunId to support concurrent runs.
  private readonly _critiqueRetries = new Map<string, number>();

  constructor(
    private readonly deps: FullBuildStepRunnerDeps,
    private readonly callbacks: FullBuildCallbacks,
  ) {}

  // -- run (produce + review kinds) -----------------------------------------

  // D.1b — every branch below that dispatches on a bare step.id is
  // full-build-specific and must only fire for full-build itself; a
  // non-full-build workflow that happens to reuse one of these step ids
  // (e.g. 'debug', 'confirm') must not accidentally trigger full-build's
  // service calls. See docs/developmentPlan/d1a-declarative-contract-spike.md §5.
  async run(step: WorkflowStep, ctx: StepRunContext): Promise<StepRunOutcome> {
    if (ctx.workflowId === 'full-build') {
      if (step.kind === 'review') {
        if (step.id === 'critique') return this.executeCritique(step, ctx);
        if (step.id === 'validation_gate') return this.executeValidationGate(ctx);
      }
      if (step.id === 'scoping.produce') return this.executeScopingProduce(ctx);
      if (step.id === 'summarise') return this.executeSummarise(ctx);
      if (step.id === 'debug') return this.executeDebug(step, ctx);
    }
    return this.deps.agentStepRunner.run(step, ctx);
  }

  // -- handleCheckpoint (checkpoint kind) ------------------------------------

  async handleCheckpoint(step: WorkflowStep, ctx: StepRunContext): Promise<StepResult> {
    const { workflowRunId, iteration } = ctx;
    if (ctx.workflowId === 'full-build') {
      if (step.id === 'confirm') return this.executeConfirm(workflowRunId, iteration);
      if (step.id === 'sharding_approval') return this.executeShardingApproval(step, workflowRunId, iteration);
      if (step.id === 'scoping.checkpoint') return this.executeScopingCheckpoint(step, workflowRunId, iteration);
    }
    // Generic checkpoint fallback — used by full-build steps it doesn't
    // special-case, and by every step of every other workflow.
    await this.markRunning(step.id, workflowRunId, iteration);
    const action = await this.callbacks.onCheckpoint(workflowRunId, step.id, iteration);
    if (action === 'halt') return { outcome: 'checkpoint_set', next_step_id: null };
    await this.markComplete(step.id, workflowRunId, iteration, []);
    return { outcome: 'completed', next_step_id: '__next__' };
  }

  // -- handleExecute (execute kind) -----------------------------------------
  // full-build-only for now: 'execute' has no generic implementation yet, so
  // a non-full-build workflow using this kind fails closed rather than
  // silently running full-build's ExecService against an unrelated workflow.

  async handleExecute(step: WorkflowStep, ctx: StepRunContext): Promise<StepResult> {
    const { workflowRunId, iteration } = ctx;
    if (ctx.workflowId !== 'full-build') {
      await this.markRunning(step.id, workflowRunId, iteration);
      await this.deps.runArtifacts.updateNodeStatus(workflowRunId, iteration, step.id, {
        status: 'failed',
        completed_at: new Date().toISOString(),
      });
      return {
        outcome: 'failed',
        next_step_id: null,
        error: `'execute' step kind has no generic implementation yet — workflow '${ctx.workflowId}' must provide its own StepRunner.handleExecute`,
      };
    }
    await this.markRunning(step.id, workflowRunId, iteration);
    await this.deps.execService.run(workflowRunId, iteration);
    await this.markComplete(step.id, workflowRunId, iteration, []);
    return { outcome: 'completed', next_step_id: '__next__' };
  }

  // -- handleCommit (commit kind) -------------------------------------------

  async handleCommit(step: WorkflowStep, ctx: StepRunContext): Promise<StepResult> {
    const { workflowRunId, iteration } = ctx;
    await this.markRunning(step.id, workflowRunId, iteration);
    if (ctx.workflowId === 'full-build' && step.id === 'snapshot') {
      await this.deps.snapshotService.run(workflowRunId, iteration);
      if (step.logs_decision) {
        // Fold former HISTORY step: append decision record to docs/decisions.md.
        // This is an advisory write; failures are non-fatal.
        const decisionsPath = path.join(this.deps.projectRoot, 'docs', 'decisions.md');
        const planningDepth = ctx.workflowParameters?.['planning_depth'] as string | undefined;
        const entry = [
          '',
          `## ${workflowRunId} / iteration ${iteration} — ${new Date().toISOString()}`,
          '',
          `**Goal:** ${ctx.goal}`,
          ...(planningDepth ? [`**Planning depth:** ${planningDepth}`] : []),
          `**Iteration:** ${iteration}`,
          `**Status:** complete`,
          '',
        ].join('\n');
        try {
          await fs.mkdir(path.dirname(decisionsPath), { recursive: true });
          await fs.appendFile(decisionsPath, entry, 'utf8');
        } catch {
          // non-fatal: decisions.md append is advisory
        }
      }
    }
    await this.markComplete(step.id, workflowRunId, iteration, []);
    return { outcome: 'completed', next_step_id: null };
  }

  // -- CheckpointResolver seam -----------------------------------------------
  // Executes the side effects that belong to a specific checkpoint (approve,
  // revise, reject, modify) and returns a resolution descriptor that tells
  // ResumeService how to advance — or not advance — the WorkflowRun cursor.
  // A thrown error leaves the run safely halted; ResumeService must NOT commit
  // any state transition when this method throws.
  //
  // Idempotency: a durable receipt is written AFTER all side effects succeed.
  // On retry the receipt is returned verbatim — effects are never re-applied.
  // A corrupt/unreadable receipt fails closed (throws).

  // resolveCheckpoint is a pure action primitive — idempotency is handled at the
  // ResumeService layer via the SQLite checkpoint_applications journal (A.3).
  async resolveCheckpoint(input: CheckpointResolverInput): Promise<CheckpointResolution> {
    const { workflowId, stepId, selectedOptionId, rationale, workflowRunId, iteration } = input;

    let resolution: CheckpointResolution;

    if (workflowId === 'full-build') {
      if (stepId === 'confirm') {
        if (selectedOptionId === 'approve') {
          resolution = await this.applyConfirmApprove(workflowRunId, iteration);
        } else if (selectedOptionId === 'revise') {
          resolution = await this.applyConfirmRevise(workflowRunId, iteration, rationale);
        } else {
          throw new Error(`Unknown option '${selectedOptionId}' for confirm checkpoint`);
        }
      } else if (stepId === 'scoping.checkpoint') {
        if (selectedOptionId !== 'approve') {
          throw new Error(`Unknown option '${selectedOptionId}' for scoping.checkpoint`);
        }
        resolution = await this.applyScopingApprove(stepId, workflowRunId, iteration);
      } else if (stepId === 'sharding_approval') {
        if (selectedOptionId === 'modify') {
          // modify: no side effects — decision stays pending.
          return { remainAtCheckpoint: true, incrementRevision: false, cancel: false };
        } else if (selectedOptionId === 'reject') {
          resolution = await this.applyShardingReject(stepId, workflowRunId, iteration);
        } else if (selectedOptionId === 'approve') {
          const proposalPath = path.join(this.deps.projectRoot, '.sle', 'sharding-proposal.yaml');
          const proposalContent = await this.safeReadFile(proposalPath);
          if (!proposalContent) throw new Error('No sharding proposal found to approve');
          resolution = await this.applyShardingApprove(stepId, workflowRunId, iteration, proposalContent);
        } else {
          throw new Error(`Unknown option '${selectedOptionId}' for sharding_approval checkpoint`);
        }
      } else {
        resolution = this.genericCheckpointResolution(selectedOptionId, stepId);
      }
    } else {
      resolution = this.genericCheckpointResolution(selectedOptionId, stepId);
    }

    return resolution;
  }

  // -- Shared checkpoint action primitives -----------------------------------
  // Called by BOTH the inline checkpoint handlers (executeConfirm, etc.) and
  // the durable resolveCheckpoint path. Owning ALL side effects here means
  // first-attempt and retry routing are structurally identical.

  private async applyConfirmApprove(
    workflowRunId: string,
    iteration: number,
  ): Promise<CheckpointResolution> {
    try {
      await this.deps.confirmService.approve(workflowRunId, iteration);
    } catch (err: any) {
      if (err.code !== 'not_awaiting_confirmation') throw err;
      // approve() throws only after completing both effects (artifact + RuntimeMap).
      // So awaiting_confirmation=false means the operation fully succeeded.
      const map = await this.deps.mapManager.read();
      if (map.cycle.awaiting_confirmation !== false) {
        throw new Error('CONFIRM approve recovery: unexpected RuntimeMap state');
      }
      return { overrideContinuationStepId: 'build', remainAtCheckpoint: false, incrementRevision: false, cancel: false };
    }
    return { overrideContinuationStepId: 'build', remainAtCheckpoint: false, incrementRevision: false, cancel: false };
  }

  private async applyConfirmRevise(
    workflowRunId: string,
    iteration: number,
    rationale?: string,
  ): Promise<CheckpointResolution> {
    try {
      await this.deps.confirmService.revise(workflowRunId, iteration, rationale);
    } catch (err: any) {
      if (err.code !== 'not_awaiting_confirmation') throw err;
      // revise() throws only after completing both effects (artifact + RuntimeMap).
      const map = await this.deps.mapManager.read();
      if (map.cycle.awaiting_confirmation !== false) {
        throw new Error('CONFIRM revise recovery: unexpected RuntimeMap state');
      }
      return { overrideContinuationStepId: 'test', remainAtCheckpoint: false, incrementRevision: true, cancel: false };
    }
    return { overrideContinuationStepId: 'test', remainAtCheckpoint: false, incrementRevision: true, cancel: false };
  }

  private async applyScopingApprove(
    stepId: string,
    workflowRunId: string,
    iteration: number,
  ): Promise<CheckpointResolution> {
    if (!this.deps.scopingService) {
      throw new Error('ScopingService is required for scoping.checkpoint approval');
    }
    await this.deps.scopingService.approve(iteration, iteration);
    await this.markComplete(stepId, workflowRunId, iteration, []);
    return { remainAtCheckpoint: false, incrementRevision: false, cancel: false };
  }

  private async applyShardingApprove(
    stepId: string,
    workflowRunId: string,
    iteration: number,
    proposalContent: string,
  ): Promise<CheckpointResolution> {
    if (!this.deps.shardingService) {
      throw new Error('ShardingService is required for sharding_approval approval');
    }
    const proposal = yaml.load(proposalContent) as any;
    await this.deps.shardingService.createTasksFromProposal(proposal);
    await this.markComplete(stepId, workflowRunId, iteration, ['.sle/tasks.yaml']);
    return { remainAtCheckpoint: false, incrementRevision: false, cancel: false };
  }

  private async applyShardingReject(
    stepId: string,
    workflowRunId: string,
    iteration: number,
  ): Promise<CheckpointResolution> {
    const proposalPath = path.join(this.deps.projectRoot, '.sle', 'sharding-proposal.yaml');
    try { await fs.unlink(proposalPath); } catch {}
    await this.deps.runArtifacts.updateNodeStatus(workflowRunId, iteration, stepId, {
      status: 'skipped',
      completed_at: new Date().toISOString(),
      skip_reason: 'user_rejected_sharding',
    });
    return { remainAtCheckpoint: false, incrementRevision: false, cancel: false };
  }

  private genericCheckpointResolution(selectedOptionId: string, stepId: string): CheckpointResolution {
    if (selectedOptionId === 'reject') {
      return { remainAtCheckpoint: false, incrementRevision: false, cancel: true };
    }
    if (selectedOptionId === 'approve') {
      return { remainAtCheckpoint: false, incrementRevision: false, cancel: false };
    }
    throw new Error(`Unknown option '${selectedOptionId}' for checkpoint '${stepId}'`);
  }

  // -- review helpers -------------------------------------------------------

  private async executeCritique(_step: WorkflowStep, ctx: StepRunContext): Promise<StepRunOutcome> {
    const { projectRoot } = this.deps;
    const { workflowRunId } = ctx;
    const planningDepth = ctx.workflowParameters?.['planning_depth'] as string | undefined;
    const start = Date.now();

    if (!this.deps.criticAgent) {
      throw new Error('CriticAgent is required for the critique step');
    }

    // Critique retry cap: deep = 1 retry, research = 3 retries.
    // After cap is hit, fall through to PLAN regardless of critique result.
    const limit = planningDepth === 'deep' ? 1 : planningDepth === 'research' ? 3 : Infinity;
    const retries = this._critiqueRetries.get(workflowRunId) ?? 0;

    const [architecture, requirements, contextSummary, decisions, priorEvaluation] = await Promise.all([
      this.safeReadFile(path.join(projectRoot, 'docs/architecture.md')),
      this.safeReadFile(path.join(projectRoot, 'docs/requirements.md')),
      this.safeReadFile(path.join(projectRoot, 'docs/discovery-summary.md')),
      this.safeReadFile(path.join(projectRoot, 'docs/decisions.md')),
      this.safeReadFile(path.join(projectRoot, 'docs/evaluation.md')),
    ]);

    const result = await this.deps.criticAgent.critique({
      architecture, requirements, contextSummary, decisions, priorEvaluation,
    });

    const content = `# Critique\n\n## Blocking Issues\n${
      result.blocking_issues.map((i: string) => `- ${i}`).join('\n') || 'None'
    }\n\n## Warnings\n${
      result.warnings.map((w: string) => `- ${w}`).join('\n') || 'None'
    }\n\n## Suggestions\n${
      result.suggestions.map((s: string) => `- ${s}`).join('\n') || 'None'
    }`;

    const written = ['docs/cycle-critique.md'];
    await this.safeWriteFile(path.join(projectRoot, 'docs/cycle-critique.md'), content);
    if (planningDepth === 'deep' || planningDepth === 'research') {
      written.push('docs/critique-report.md');
      await this.safeWriteFile(path.join(projectRoot, 'docs/critique-report.md'), content);
    }

    // updateArtifactEntries here because executeReview does not call it for review steps.
    await updateArtifactEntries(this.deps.mapManager, written, 'critic');

    if (!result.pass && retries >= limit) {
      // Retry cap reached: fall through to PLAN regardless.
      this._critiqueRetries.delete(workflowRunId);
      return {
        success: true,
        artifacts_written: written,
        tokens_used: 0,
        duration_ms: Date.now() - start,
      };
    }

    if (!result.pass) {
      this._critiqueRetries.set(workflowRunId, retries + 1);
    } else {
      this._critiqueRetries.delete(workflowRunId);
    }

    return {
      success: result.pass,
      artifacts_written: written,
      tokens_used: 0,
      duration_ms: Date.now() - start,
      error: result.pass ? undefined : 'Critique failed — blocking issues found',
    };
  }

  private async executeValidationGate(
    ctx: StepRunContext,
  ): Promise<StepRunOutcome> {
    const start = Date.now();
    const result = await this.deps.validationGateService.run(ctx.workflowRunId, ctx.iteration);
    return {
      success: result.passed,
      artifacts_written: [],
      tokens_used: 0,
      duration_ms: Date.now() - start,
      error: result.passed ? undefined : (result.failure_report?.quick_summary ?? 'Validation failed'),
    };
  }

  // -- produce helpers -------------------------------------------------------

  private async executeScopingProduce(ctx: StepRunContext): Promise<StepRunOutcome> {
    if (!this.deps.scopingService) {
      return this.deps.agentStepRunner.run(
        { id: 'scoping.produce', kind: 'produce', agentRole: 'facilitator', templateId: 'scoping' },
        ctx,
      );
    }
    const start = Date.now();
    await this.deps.scopingService.begin(ctx);
    return {
      success: true,
      artifacts_written: ['docs/cycle-charter.md'],
      tokens_used: 0,
      duration_ms: Date.now() - start,
    };
  }

  private async executeSummarise(ctx: StepRunContext): Promise<StepRunOutcome> {
    const start = Date.now();
    await this.deps.summariseService.run(ctx.workflowRunId, ctx.iteration);
    return {
      success: true,
      artifacts_written: ['docs/cycle-summary.md'],
      tokens_used: 0,
      duration_ms: Date.now() - start,
    };
  }

  private async executeDebug(
    step: WorkflowStep,
    ctx: StepRunContext,
  ): Promise<StepRunOutcome & { next_step_id?: string; _iterate?: true }> {
    const start = Date.now();

    // Load the durable failure report written by ValidationGateService.
    // Inject it into the context so ContextManager can assemble debugger context.
    const failureReport = await this.deps.runArtifacts.readFailureReport(ctx.workflowRunId, ctx.iteration);
    const debugCtx: StepRunContext = {
      ...ctx,
      ...(failureReport !== null ? { failureReport } : {}),
    };

    const result = await this.deps.agentStepRunner.run(step, debugCtx);
    if (!result.success) {
      return result;
    }
    const hasStructural = failureReport?.failed_categories?.some(c => c.structural) ?? false;
    return {
      success: true,
      artifacts_written: result.artifacts_written,
      tokens_used: result.tokens_used,
      duration_ms: Date.now() - start,
      next_step_id: hasStructural ? 'design' : 'plan',
      _iterate: true,
    };
  }

  // -- checkpoint helpers ---------------------------------------------------

  private async executeConfirm(workflowRunId: string, iteration: number): Promise<StepResult> {
    await this.deps.confirmService.gate(workflowRunId, iteration);
    const action = await this.callbacks.onConfirmGate(workflowRunId, iteration);

    if (action === 'halt') return { outcome: 'checkpoint_set', next_step_id: null };

    if (action === 'revise') {
      const res = await this.applyConfirmRevise(workflowRunId, iteration, undefined);
      return {
        outcome: 'completed',
        next_step_id: res.overrideContinuationStepId ?? null,
        _increment_revision: true,
      };
    }

    const res = await this.applyConfirmApprove(workflowRunId, iteration);
    return {
      outcome: 'completed',
      next_step_id: res.overrideContinuationStepId ?? '__next__',
    };
  }

  private async executeScopingCheckpoint(
    step: WorkflowStep,
    workflowRunId: string,
    iteration: number,
  ): Promise<StepResult> {
    if (!this.deps.scopingService) {
      throw new Error('ScopingService is required for the scoping.checkpoint step');
    }
    await this.markRunning(step.id, workflowRunId, iteration);
    await this.deps.mapManager.update(m => ({ ...m, cycle: { ...m.cycle, awaiting_scoping: true } }));

    const action = await this.callbacks.onCheckpoint(workflowRunId, step.id, iteration);

    if (action === 'halt') {
      await this.deps.mapManager.update(m => ({ ...m, cycle: { ...m.cycle, awaiting_scoping: false } }));
      return { outcome: 'checkpoint_set', next_step_id: null };
    }

    // applyScopingApprove calls scopingService.approve() which sets awaiting_scoping=false internally.
    await this.applyScopingApprove(step.id, workflowRunId, iteration);
    return { outcome: 'completed', next_step_id: '__next__' };
  }

  private async executeShardingApproval(
    step: WorkflowStep,
    workflowRunId: string,
    iteration: number,
  ): Promise<StepResult> {
    const proposalPath = path.join(this.deps.projectRoot, '.sle', 'sharding-proposal.yaml');
    const proposalContent = await this.safeReadFile(proposalPath);

    if (!proposalContent) {
      await this.skipStep(step, workflowRunId, iteration, 'no_sharding_proposal');
      return { outcome: 'skipped', next_step_id: '__next__', skip_reason: 'no_sharding_proposal' };
    }

    await this.markRunning(step.id, workflowRunId, iteration);
    await this.deps.mapManager.update(m => ({ ...m, cycle: { ...m.cycle, awaiting_sharding_approval: true } }));

    const action = await this.callbacks.onShardingGate(workflowRunId, iteration);

    if (action === 'halt') {
      await this.deps.mapManager.update(m => ({ ...m, cycle: { ...m.cycle, awaiting_sharding_approval: false } }));
      return { outcome: 'checkpoint_set', next_step_id: null };
    }

    await this.deps.mapManager.update(m => ({ ...m, cycle: { ...m.cycle, awaiting_sharding_approval: false } }));

    if (action === 'approve') {
      await this.applyShardingApprove(step.id, workflowRunId, iteration, proposalContent);
    } else if (action === 'reject') {
      await this.applyShardingReject(step.id, workflowRunId, iteration);
    } else {
      // modify — loop back to this checkpoint
      return { outcome: 'completed', next_step_id: step.id };
    }

    return { outcome: 'completed', next_step_id: '__next__' };
  }

  // -- run artifact helpers -------------------------------------------------

  private async markRunning(stepId: string, workflowRunId: string, iteration: number): Promise<void> {
    await this.deps.runArtifacts.updateNodeStatus(workflowRunId, iteration, stepId, {
      status: 'running',
      started_at: new Date().toISOString(),
    });
  }

  private async markComplete(
    stepId: string,
    workflowRunId: string,
    iteration: number,
    artifactsWritten: string[],
  ): Promise<void> {
    await this.deps.runArtifacts.updateNodeStatus(workflowRunId, iteration, stepId, {
      status: 'complete',
      completed_at: new Date().toISOString(),
      artifacts_written: artifactsWritten,
    });
  }

  private async skipStep(
    step: WorkflowStep,
    workflowRunId: string,
    iteration: number,
    reason?: string,
  ): Promise<void> {
    await this.deps.runArtifacts.updateNodeStatus(workflowRunId, iteration, step.id, {
      status: 'skipped',
      completed_at: new Date().toISOString(),
      skip_reason: reason ?? 'condition_not_met',
    });
  }

  private async safeReadFile(filePath: string): Promise<string> {
    try { return await fs.readFile(filePath, 'utf8'); } catch { return ''; }
  }

  private async safeWriteFile(filePath: string, content: string): Promise<void> {
    try { await fs.writeFile(filePath, content, 'utf8'); } catch {}
  }
}
