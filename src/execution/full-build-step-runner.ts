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
  onShardingGate: (workflowRunId: string, iteration: number) => Promise<'approve' | 'reject' | 'modify'>;
}

// StepRunner implementation for the full-build workflow. Implements the three
// optional kind-override methods so WorkflowEngine has zero knowledge of
// full-build step IDs, services, or callback contracts.
export class FullBuildStepRunner implements StepRunner {
  // Per-run critique retry counts. Keyed by workflowRunId to support concurrent runs.
  private readonly _critiqueRetries = new Map<string, number>();

  constructor(
    private readonly deps: FullBuildStepRunnerDeps,
    private readonly callbacks: FullBuildCallbacks,
  ) {}

  // -- run (produce + review kinds) -----------------------------------------

  async run(step: WorkflowStep, ctx: StepRunContext): Promise<StepRunOutcome> {
    if (step.kind === 'review') {
      if (step.id === 'critique') return this.executeCritique(step, ctx);
      if (step.id === 'validation_gate') return this.executeValidationGate(ctx);
    }
    if (step.id === 'scoping.produce') return this.executeScopingProduce(ctx);
    if (step.id === 'summarise') return this.executeSummarise(ctx);
    if (step.id === 'debug') return this.executeDebug(step, ctx);
    return this.deps.agentStepRunner.run(step, ctx);
  }

  // -- handleCheckpoint (checkpoint kind) ------------------------------------

  async handleCheckpoint(step: WorkflowStep, ctx: StepRunContext): Promise<StepResult> {
    const { workflowRunId, iteration } = ctx;
    if (step.id === 'confirm') return this.executeConfirm(workflowRunId, iteration);
    if (step.id === 'sharding_approval') return this.executeShardingApproval(step, workflowRunId, iteration);
    if (step.id === 'scoping.checkpoint') return this.executeScopingCheckpoint(step, workflowRunId, iteration);
    // Generic checkpoint fallback.
    await this.markRunning(step.id, workflowRunId, iteration);
    const action = await this.callbacks.onCheckpoint(workflowRunId, step.id, iteration);
    if (action === 'halt') return { outcome: 'checkpoint_set', next_step_id: null };
    await this.markComplete(step.id, workflowRunId, iteration, []);
    return { outcome: 'completed', next_step_id: '__next__' };
  }

  // -- handleExecute (execute kind) -----------------------------------------

  async handleExecute(step: WorkflowStep, ctx: StepRunContext): Promise<StepResult> {
    const { workflowRunId, iteration } = ctx;
    await this.markRunning(step.id, workflowRunId, iteration);
    await this.deps.execService.run(workflowRunId, iteration);
    await this.markComplete(step.id, workflowRunId, iteration, []);
    return { outcome: 'completed', next_step_id: '__next__' };
  }

  // -- handleCommit (commit kind) -------------------------------------------

  async handleCommit(step: WorkflowStep, ctx: StepRunContext): Promise<StepResult> {
    const { workflowRunId, iteration } = ctx;
    await this.markRunning(step.id, workflowRunId, iteration);
    if (step.id === 'snapshot') {
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
      const reviseResult = await this.deps.confirmService.revise(workflowRunId, iteration);
      return {
        outcome: 'completed',
        next_step_id: this.confirmNodeToStepId(reviseResult.next_node),
        _increment_revision: true,
      };
    }

    const approveResult = await this.deps.confirmService.approve(workflowRunId, iteration);
    return {
      outcome: 'completed',
      next_step_id: this.confirmNodeToStepId(approveResult.next_node) ?? '__next__',
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

    await this.deps.mapManager.update(m => ({ ...m, cycle: { ...m.cycle, awaiting_scoping: false } }));

    if (action === 'halt') return { outcome: 'checkpoint_set', next_step_id: null };
    await this.markComplete(step.id, workflowRunId, iteration, []);
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

    await this.deps.mapManager.update(m => ({ ...m, cycle: { ...m.cycle, awaiting_sharding_approval: false } }));

    if (action === 'approve') {
      if (!this.deps.shardingService) {
        throw new Error('ShardingService is required for sharding_approval approve');
      }
      const proposal = yaml.load(proposalContent) as any;
      await this.deps.shardingService.createTasksFromProposal(proposal);
      await this.markComplete(step.id, workflowRunId, iteration, ['.sle/tasks.yaml']);
    } else if (action === 'reject') {
      try { await fs.unlink(proposalPath); } catch {}
      await this.skipStep(step, workflowRunId, iteration, 'user_rejected_sharding');
    } else {
      // modify — loop back to this checkpoint
      return { outcome: 'completed', next_step_id: step.id };
    }

    return { outcome: 'completed', next_step_id: '__next__' };
  }

  // Translate a legacy DAGNodeId from ConfirmService into a step id.
  private confirmNodeToStepId(nodeId: string | null): string | null {
    if (!nodeId) return null;
    const MAP: Record<string, string> = {
      'TEST': 'test', 'PLAN': 'plan', 'DESIGN': 'design', 'CONFIRM': 'confirm', 'BUILD': 'build',
    };
    return MAP[nodeId] ?? nodeId.toLowerCase();
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
