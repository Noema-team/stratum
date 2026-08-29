import { randomUUID } from 'crypto';
import type { DAGNodeId } from '../agent-runner.js';
import type { DAGRunner } from '../dag-runner.js';
import { updateArtifactEntries } from '../dag-runner.js';
import type { CycleStateContext } from '../context-manager.js';
import type { CriticAgent } from '../critic-agent.js';
import type { ConfirmService } from '../confirm-service.js';
import type { ExecService, ValidationGateService } from '../exec-gate.js';
import type { SnapshotService } from '../snapshot-service.js';
import type { SummariseService } from '../summarise-service.js';
import type { RuntimeMapManager } from '../runtime-map.js';
import type { RunArtifactManager } from '../run-artifacts.js';
import type { ShardingService } from '../sharding-service.js';
import type { ScopingService } from '../scoping-service.js';
import type { FailureReport } from '../types.js';
import type {
  WorkflowDefinition,
  WorkflowRunResult,
  WorkflowStep,
  WorkflowStepContext,
  StepResult,
} from './types.js';
import { getWorkflow } from './registry.js';
import yaml from 'js-yaml';
import { promises as fs } from 'node:fs';
import path from 'node:path';

// ============================================================================
// WorkflowEngine dependencies — matches CycleRunnerDeps structurally
// ============================================================================

export interface WorkflowEngineDeps {
  dagRunner: DAGRunner;
  confirmService: ConfirmService;
  execService: ExecService;
  validationGateService: ValidationGateService;
  snapshotService: SnapshotService;
  summariseService: SummariseService;
  mapManager: RuntimeMapManager;
  runArtifacts: RunArtifactManager;
  projectRoot?: string;
  criticAgent?: CriticAgent;
  shardingService?: ShardingService;
  scopingService?: ScopingService;
}

export interface WorkflowEngineOptions {
  /** Called when a checkpoint step is entered; resolves when user approves/halts */
  onCheckpoint: (
    runId: string,
    stepId: string,
    cycleNumber: number,
    iteration: number,
  ) => Promise<'approve' | 'halt'>;

  /** Called specifically for CONFIRM checkpoint — supports approve/revise/halt */
  onConfirmGate: (
    cycleNumber: number,
    iteration: number,
  ) => Promise<'approve' | 'revise' | 'halt'>;

  /** Called for SHARDING_APPROVAL checkpoint */
  onShardingGate: (
    cycleNumber: number,
    iteration: number,
  ) => Promise<'approve' | 'reject' | 'modify'>;
}

// ============================================================================
// WorkflowEngine
// ============================================================================

export class WorkflowEngine {
  constructor(
    private readonly deps: WorkflowEngineDeps,
    private readonly opts: WorkflowEngineOptions,
  ) {}

  // --------------------------------------------------------------------------
  // run — execute a workflow definition from the given start step
  // --------------------------------------------------------------------------

  async run(
    workflowId: string,
    cycleNumber: number,
    cycleId: string,
    cycleStateCtx: CycleStateContext,
    startStepId?: string,
  ): Promise<WorkflowRunResult> {
    const def = getWorkflow(workflowId);
    if (!def) {
      return {
        run_id: randomUUID(),
        status: 'halted',
        final_step_id: null,
        iterations_used: cycleStateCtx.iteration,
        error: `Unknown workflow '${workflowId}'`,
      };
    }

    const runId = randomUUID();
    const startIndex = startStepId
      ? def.steps.findIndex(s => s.id === startStepId)
      : 0;

    if (startIndex === -1) {
      return {
        run_id: runId,
        status: 'halted',
        final_step_id: startStepId ?? null,
        iterations_used: cycleStateCtx.iteration,
        error: `Step '${startStepId}' not found in workflow '${workflowId}'`,
      };
    }

    let stepIndex = startIndex;
    let cycleState = cycleStateCtx;
    let criticPasses = 0;
    let failureReport: FailureReport | undefined;

    while (stepIndex < def.steps.length) {
      const step = def.steps[stepIndex];

      const stepCtx: WorkflowStepContext = {
        runId,
        workflowId,
        iteration: cycleState.iteration,
        revision: 0,
        planningDepth: cycleState.planning_depth,
      };

      // Evaluate skip condition
      if (step.skip_if?.(stepCtx)) {
        await this.skipStep(step, cycleNumber, cycleState.iteration);
        stepIndex++;
        continue;
      }

      const result = await this.executeStep(
        step, def, cycleNumber, cycleId, cycleState, failureReport, criticPasses,
      );

      if (result.outcome === 'failed') {
        return {
          run_id: runId,
          status: 'halted',
          final_step_id: step.id,
          iterations_used: cycleState.iteration,
          error: result.error,
        };
      }

      if (result.outcome === 'checkpoint_set') {
        // Checkpoint — run is paused; caller is responsible for resuming via API
        return {
          run_id: runId,
          status: 'halted',
          final_step_id: step.id,
          iterations_used: cycleState.iteration,
          error: undefined,
        };
      }

      // Handle on_fail routing for review steps
      if (result.outcome === 'completed' && result.next_step_id && result.next_step_id !== '__next__') {
        // on_fail route — jump to the named step
        const targetIndex = def.steps.findIndex(s => s.id === result.next_step_id);
        if (targetIndex === -1) {
          return {
            run_id: runId,
            status: 'halted',
            final_step_id: step.id,
            iterations_used: cycleState.iteration,
            error: `on_fail target '${result.next_step_id}' not found`,
          };
        }

        // Handle iteration loop metadata from the engine state communicated via result
        if ('_iterate' in (result as any)) {
          const updatedMap = await this.deps.mapManager.read();
          cycleState = { ...cycleState, iteration: updatedMap.cycle.iteration };

          // Check iteration cap
          const capResult = await this.checkIterationCap(def, updatedMap.cycle.iteration, runId, cycleState);
          if (capResult) return capResult;

          // Create new iteration run artifacts
          try {
            await this.deps.runArtifacts.createRunDir(cycleNumber, cycleState.iteration);
            await this.deps.runArtifacts.createManifest({
              cycleId,
              cycleNumber,
              iteration: cycleState.iteration,
              planningDepth: cycleState.planning_depth,
            });
          } catch {
            // non-fatal
          }
        }

        stepIndex = targetIndex;
        continue;
      }

      // Advance to next step
      if (result.next_step_id === null) {
        // Workflow complete
        return {
          run_id: runId,
          status: 'complete',
          final_step_id: step.id,
          iterations_used: cycleState.iteration,
        };
      }

      stepIndex++;
    }

    return {
      run_id: runId,
      status: 'complete',
      final_step_id: def.steps[def.steps.length - 1]?.id ?? null,
      iterations_used: cycleState.iteration,
    };
  }

  // --------------------------------------------------------------------------
  // executeStep — dispatch to kind-specific handler
  // --------------------------------------------------------------------------

  private async executeStep(
    step: WorkflowStep,
    def: WorkflowDefinition,
    cycleNumber: number,
    cycleId: string,
    cycleState: CycleStateContext,
    failureReport: FailureReport | undefined,
    criticPasses: number,
  ): Promise<StepResult & { _iterate?: true }> {
    switch (step.kind) {
      case 'gather':   return this.executeGather(step, cycleNumber, cycleState);
      case 'produce':  return this.executeProduce(step, cycleNumber, cycleState);
      case 'review':   return this.executeReview(step, def, cycleNumber, cycleId, cycleState, failureReport, criticPasses);
      case 'checkpoint': return this.executeCheckpoint(step, cycleNumber, cycleState);
      case 'execute':  return this.executeExec(step, cycleNumber, cycleState);
      case 'commit':   return this.executeCommit(step, cycleNumber, cycleState);
    }
  }

  // -- gather ----------------------------------------------------------------

  private async executeGather(
    step: WorkflowStep,
    cycleNumber: number,
    cycleState: CycleStateContext,
  ): Promise<StepResult> {
    await this.markRunning(step.id, cycleNumber, cycleState.iteration);
    // Gather is a no-artifact assembly step; context manager does the work on the next produce call.
    await this.markComplete(step.id, cycleNumber, cycleState.iteration, []);
    return { outcome: 'completed', next_step_id: '__next__' };
  }

  // -- produce ---------------------------------------------------------------

  private async executeProduce(
    step: WorkflowStep,
    _cycleNumber: number,
    cycleState: CycleStateContext,
  ): Promise<StepResult> {
    const start = Date.now();
    const nodeId = this.stepToNodeId(step.id);
    // DAGRunner handles: markRunning, agentRunner.run, markComplete, artifact entries
    const result = await this.deps.dagRunner.runNode(nodeId as DAGNodeId, cycleState);

    if (!result.success) {
      return { outcome: 'failed', next_step_id: null, error: result.error };
    }

    return {
      outcome: 'completed',
      next_step_id: '__next__',
      artifacts_written: result.artifacts_written,
      tokens_used: result.tokens_used,
      duration_ms: Date.now() - start,
    };
  }

  // -- review ----------------------------------------------------------------

  private async executeReview(
    step: WorkflowStep,
    def: WorkflowDefinition,
    cycleNumber: number,
    cycleId: string,
    cycleState: CycleStateContext,
    _failureReport: FailureReport | undefined,
    criticPasses: number,
  ): Promise<StepResult & { _iterate?: true }> {
    const start = Date.now();
    await this.markRunning(step.id, cycleNumber, cycleState.iteration);

    // CRITIQUE — uses CriticAgent directly (DDR-022)
    if (step.id === 'critique') {
      return this.executeCritiqueReview(step, cycleNumber, cycleState, criticPasses, start);
    }

    // VALIDATION_GATE — deterministic pass/fail (DDR-031 constraint 9)
    if (step.id === 'validation_gate') {
      return this.executeValidationGateReview(step, def, cycleNumber, cycleId, cycleState, start);
    }

    // Generic review — delegates to DAGRunner
    const nodeId = this.stepToNodeId(step.id);
    const result = await this.deps.dagRunner.runNode(nodeId as DAGNodeId, cycleState);
    if (!result.success) {
      return { outcome: 'failed', next_step_id: null, error: result.error };
    }
    return { outcome: 'completed', next_step_id: '__next__', duration_ms: Date.now() - start };
  }

  private async executeCritiqueReview(
    step: WorkflowStep,
    cycleNumber: number,
    cycleState: CycleStateContext,
    criticPasses: number,
    start: number,
  ): Promise<StepResult> {
    const projectRoot = this.deps.projectRoot ?? process.cwd();

    const [architecture, requirements, contextSummary, decisions, priorEvaluation] = await Promise.all([
      this.safeReadFile(path.join(projectRoot, 'docs/architecture.md')),
      this.safeReadFile(path.join(projectRoot, 'docs/requirements.md')),
      this.safeReadFile(path.join(projectRoot, 'docs/discovery-summary.md')),
      this.safeReadFile(path.join(projectRoot, 'docs/decisions.md')),
      this.safeReadFile(path.join(projectRoot, 'docs/evaluation.md')),
    ]);

    if (!this.deps.criticAgent) {
      throw new Error('CriticAgent is required for the critique review step');
    }

    const result = await this.deps.criticAgent.critique({
      architecture, requirements, contextSummary, decisions, priorEvaluation,
    });

    const content = `# Critique\n\n## Blocking Issues\n${
      result.blocking_issues.map(i => `- ${i}`).join('\n') || 'None'
    }\n\n## Warnings\n${
      result.warnings.map(w => `- ${w}`).join('\n') || 'None'
    }\n\n## Suggestions\n${
      result.suggestions.map(s => `- ${s}`).join('\n') || 'None'
    }`;

    const written = ['docs/cycle-critique.md'];
    await this.safeWriteFile(path.join(projectRoot, 'docs/cycle-critique.md'), content);
    if (cycleState.planning_depth === 'deep' || cycleState.planning_depth === 'research') {
      written.push('docs/critique-report.md');
      await this.safeWriteFile(path.join(projectRoot, 'docs/critique-report.md'), content);
    }

    await this.markComplete(step.id, cycleNumber, cycleState.iteration, written);
    await updateArtifactEntries(this.deps.mapManager, written, 'critic');

    const passLimit = cycleState.planning_depth === 'deep' ? 1 : 3;
    if (!result.pass && criticPasses < passLimit) {
      return {
        outcome: 'completed',
        next_step_id: step.on_fail?.target_step_id ?? '__next__',
        artifacts_written: written,
        duration_ms: Date.now() - start,
      };
    }

    return { outcome: 'completed', next_step_id: '__next__', artifacts_written: written, duration_ms: Date.now() - start };
  }

  private async executeValidationGateReview(
    step: WorkflowStep,
    _def: WorkflowDefinition,
    cycleNumber: number,
    cycleId: string,
    cycleState: CycleStateContext,
    start: number,
  ): Promise<StepResult & { _iterate?: true }> {
    const result = await this.deps.validationGateService.run(cycleNumber, cycleState.iteration, cycleId);
    await this.markComplete(step.id, cycleNumber, cycleState.iteration, []);

    if (!result.passed) {
      if (step.on_fail?.iteration_loop) {
        // Increment iteration counter
        await this.deps.mapManager.update(m => ({
          ...m,
          cycle: { ...m.cycle, iteration: m.cycle.iteration + 1 },
        }));
      }
      return {
        outcome: 'completed',
        next_step_id: step.on_fail?.target_step_id ?? null,
        _iterate: step.on_fail?.iteration_loop ? true : undefined,
        duration_ms: Date.now() - start,
      } as StepResult & { _iterate?: true };
    }

    return { outcome: 'completed', next_step_id: '__next__', duration_ms: Date.now() - start };
  }

  // -- checkpoint ------------------------------------------------------------

  private async executeCheckpoint(
    step: WorkflowStep,
    cycleNumber: number,
    cycleState: CycleStateContext,
  ): Promise<StepResult> {
    // SHARDING_APPROVAL — skip if no proposal file exists
    if (step.id === 'sharding_approval') {
      return this.executeShardingApproval(step, cycleNumber, cycleState);
    }

    // CONFIRM — supports approve/revise/halt
    if (step.id === 'confirm') {
      return this.executeConfirmCheckpoint(step, cycleNumber, cycleState);
    }

    // SCOPING checkpoint — generic
    if (step.id === 'scoping.checkpoint') {
      return this.executeScopingCheckpoint(step, cycleNumber, cycleState);
    }

    // Generic checkpoint
    await this.markRunning(step.id, cycleNumber, cycleState.iteration);
    const action = await this.opts.onCheckpoint(randomUUID(), step.id, cycleNumber, cycleState.iteration);
    if (action === 'halt') {
      return { outcome: 'checkpoint_set', next_step_id: null };
    }
    await this.markComplete(step.id, cycleNumber, cycleState.iteration, []);
    return { outcome: 'completed', next_step_id: '__next__' };
  }

  private async executeScopingCheckpoint(
    step: WorkflowStep,
    cycleNumber: number,
    cycleState: CycleStateContext,
  ): Promise<StepResult> {
    await this.markRunning(step.id, cycleNumber, cycleState.iteration);

    if (!this.deps.scopingService) {
      throw new Error('ScopingService is required for the scoping checkpoint step');
    }

    await this.deps.mapManager.update(m => ({
      ...m,
      cycle: { ...m.cycle, awaiting_scoping: true },
    }));

    const action = await this.opts.onCheckpoint(randomUUID(), step.id, cycleNumber, cycleState.iteration);

    await this.deps.mapManager.update(m => ({
      ...m,
      cycle: { ...m.cycle, awaiting_scoping: false },
    }));

    if (action === 'halt') {
      return { outcome: 'checkpoint_set', next_step_id: null };
    }

    await this.markComplete(step.id, cycleNumber, cycleState.iteration, []);
    return { outcome: 'completed', next_step_id: '__next__' };
  }

  private async executeShardingApproval(
    step: WorkflowStep,
    cycleNumber: number,
    cycleState: CycleStateContext,
  ): Promise<StepResult> {
    const projectRoot = this.deps.projectRoot ?? process.cwd();
    const proposalPath = path.join(projectRoot, '.sle', 'sharding-proposal.yaml');

    const proposalContent = await this.safeReadFile(proposalPath);
    if (!proposalContent) {
      await this.skipStep(step, cycleNumber, cycleState.iteration, 'no_sharding_proposal');
      return { outcome: 'skipped', next_step_id: '__next__', skip_reason: 'no_sharding_proposal' };
    }

    await this.markRunning(step.id, cycleNumber, cycleState.iteration);
    await this.deps.mapManager.update(m => ({
      ...m,
      cycle: { ...m.cycle, awaiting_sharding_approval: true },
    }));

    const action = await this.opts.onShardingGate(cycleNumber, cycleState.iteration);

    await this.deps.mapManager.update(m => ({
      ...m,
      cycle: { ...m.cycle, awaiting_sharding_approval: false },
    }));

    if (action === 'approve') {
      if (!this.deps.shardingService) {
        throw new Error('ShardingService is required for SHARDING_APPROVAL approve');
      }
      const proposal = yaml.load(proposalContent) as any;
      await this.deps.shardingService.createTasksFromProposal(proposal);
      await this.markComplete(step.id, cycleNumber, cycleState.iteration, ['.sle/tasks.yaml']);
    } else if (action === 'reject') {
      try { await fs.unlink(proposalPath); } catch {}
      await this.skipStep(step, cycleNumber, cycleState.iteration, 'user_rejected_sharding');
    } else {
      // modify — loop back to this checkpoint
      return { outcome: 'completed', next_step_id: step.id };
    }

    return { outcome: 'completed', next_step_id: '__next__' };
  }

  private async executeConfirmCheckpoint(
    _step: WorkflowStep,
    cycleNumber: number,
    cycleState: CycleStateContext,
  ): Promise<StepResult> {
    await this.deps.confirmService.gate(cycleNumber, cycleState.iteration);
    const action = await this.opts.onConfirmGate(cycleNumber, cycleState.iteration);

    if (action === 'halt') return { outcome: 'checkpoint_set', next_step_id: null };

    if (action === 'revise') {
      const reviseResult = await this.deps.confirmService.revise(cycleNumber, cycleState.iteration);
      return { outcome: 'completed', next_step_id: this.nodeIdToStepId(reviseResult.next_node) };
    }

    await this.deps.confirmService.approve(cycleNumber, cycleState.iteration);
    return { outcome: 'completed', next_step_id: '__next__' };
  }

  // -- execute ---------------------------------------------------------------

  private async executeExec(
    step: WorkflowStep,
    cycleNumber: number,
    cycleState: CycleStateContext,
  ): Promise<StepResult> {
    await this.markRunning(step.id, cycleNumber, cycleState.iteration);
    await this.deps.execService.run(cycleNumber, cycleState.iteration);
    await this.markComplete(step.id, cycleNumber, cycleState.iteration, []);
    return { outcome: 'completed', next_step_id: '__next__' };
  }

  // -- commit ----------------------------------------------------------------

  private async executeCommit(
    step: WorkflowStep,
    cycleNumber: number,
    cycleState: CycleStateContext,
  ): Promise<StepResult> {
    await this.markRunning(step.id, cycleNumber, cycleState.iteration);

    if (step.id === 'snapshot') {
      await this.deps.snapshotService.run(cycleNumber, cycleState.iteration);
      await this.markComplete(step.id, cycleNumber, cycleState.iteration, []);
      return { outcome: 'completed', next_step_id: null }; // workflow complete
    }

    // Generic commit — writes claim-acquired artifacts and releases claims
    await this.markComplete(step.id, cycleNumber, cycleState.iteration, []);
    return { outcome: 'completed', next_step_id: null };
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private async skipStep(
    step: WorkflowStep,
    cycleNumber: number,
    iteration: number,
    reason?: string,
  ): Promise<void> {
    await this.deps.runArtifacts.updateNodeStatus(cycleNumber, iteration, this.stepToNodeId(step.id), {
      status: 'skipped',
      completed_at: new Date().toISOString(),
      skip_reason: reason ?? 'condition_not_met',
    });
  }

  private async markRunning(stepId: string, cycleNumber: number, iteration: number): Promise<void> {
    await this.deps.runArtifacts.updateNodeStatus(cycleNumber, iteration, this.stepToNodeId(stepId), {
      status: 'running',
      started_at: new Date().toISOString(),
    });
  }

  private async markComplete(
    stepId: string,
    cycleNumber: number,
    iteration: number,
    artifactsWritten: string[],
  ): Promise<void> {
    await this.deps.runArtifacts.updateNodeStatus(cycleNumber, iteration, this.stepToNodeId(stepId), {
      status: 'complete',
      completed_at: new Date().toISOString(),
      artifacts_written: artifactsWritten,
    });
  }

  private async checkIterationCap(
    def: WorkflowDefinition,
    iteration: number,
    runId: string,
    _cycleState: CycleStateContext,
  ): Promise<WorkflowRunResult | null> {
    const maxIterations = def.max_iterations ?? Infinity;
    if (iteration < maxIterations) return null;

    return {
      run_id: runId,
      status: 'halted',
      final_step_id: 'validation_gate',
      iterations_used: iteration,
      error: `Iteration cap (${maxIterations}) reached`,
    };
  }

  // Map step id to the legacy DAGNodeId the AgentRunner/RunArtifacts expects
  private stepToNodeId(stepId: string): string {
    const MAP: Record<string, string> = {
      'scoping.gather': 'SCOPING',
      'scoping.produce': 'SCOPING',
      'scoping.checkpoint': 'SCOPING',
      'design': 'DESIGN',
      'critique': 'CRITIQUE',
      'plan': 'PLAN',
      'test': 'TEST',
      'sharding_approval': 'SHARDING_APPROVAL',
      'confirm': 'CONFIRM',
      'build': 'BUILD',
      'exec': 'EXEC',
      'validation_gate': 'VALIDATION_GATE',
      'debug': 'DEBUG',
      'evaluate': 'EVALUATE',
      'summarise': 'SUMMARISE',
      'snapshot': 'SNAPSHOT',
      // draft-artifact steps
      'gather': 'SCOPING',
      'produce': 'DESIGN',
      'commit': 'SNAPSHOT',
    };
    return MAP[stepId] ?? stepId.toUpperCase();
  }

  // Map legacy DAGNodeId back to step id
  private nodeIdToStepId(nodeId: string | null): string | null {
    if (!nodeId) return null;
    const MAP: Record<string, string> = {
      'TEST': 'test',
      'PLAN': 'plan',
      'DESIGN': 'design',
      'CONFIRM': 'confirm',
      'BUILD': 'build',
    };
    return MAP[nodeId] ?? nodeId.toLowerCase();
  }

  private async safeReadFile(filePath: string): Promise<string> {
    try { return await fs.readFile(filePath, 'utf8'); } catch { return ''; }
  }

  private async safeWriteFile(filePath: string, content: string): Promise<void> {
    try { await fs.writeFile(filePath, content, 'utf8'); } catch {}
  }
}
