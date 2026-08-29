import { randomUUID } from 'crypto';
import type { CycleStateContext } from '../context-manager.js';
import type { RuntimeMapManager } from '../runtime-map.js';
import type { RunArtifactManager } from '../run-artifacts.js';
import type {
  WorkflowDefinition,
  WorkflowRunResult,
  WorkflowStep,
  WorkflowStepContext,
  StepResult,
  StepRunner,
  StepRunContext,
} from './types.js';
import { getWorkflow } from './registry.js';
import { updateArtifactEntries } from './artifact-utils.js';

// ============================================================================
// WorkflowEngine dependencies
// ============================================================================

export interface WorkflowEngineDeps {
  stepRunner: StepRunner;
  mapManager: RuntimeMapManager;
  runArtifacts: RunArtifactManager;
  projectRoot?: string;
}

export interface WorkflowEngineOptions {
  // Generic checkpoint callback — invoked for checkpoint steps when the runner
  // does not provide handleCheckpoint. Resolves to 'approve' (continue) or
  // 'halt' (pause the run).
  onCheckpoint: (
    runId: string,
    stepId: string,
    cycleNumber: number,
    iteration: number,
  ) => Promise<'approve' | 'halt'>;
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

    while (stepIndex < def.steps.length) {
      const step = def.steps[stepIndex];

      const stepCtx: WorkflowStepContext = {
        runId,
        workflowId,
        iteration: cycleState.iteration,
        revision: 0,
        planningDepth: cycleState.planning_depth,
      };

      if (step.skip_if?.(stepCtx)) {
        await this.skipStep(step, cycleNumber, cycleState.iteration);
        stepIndex++;
        continue;
      }

      const result = await this.executeStep(step, def, cycleNumber, cycleState);

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
        return {
          run_id: runId,
          status: 'halted',
          final_step_id: step.id,
          iterations_used: cycleState.iteration,
          error: undefined,
        };
      }

      if (result.outcome === 'completed' && result.next_step_id && result.next_step_id !== '__next__') {
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

        if ('_iterate' in (result as any)) {
          const updatedMap = await this.deps.mapManager.read();
          cycleState = { ...cycleState, iteration: updatedMap.cycle.iteration };

          const capResult = await this.checkIterationCap(def, updatedMap.cycle.iteration, runId, step.id);
          if (capResult) return capResult;

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

      if (result.next_step_id === null) {
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
    cycleState: CycleStateContext,
  ): Promise<StepResult & { _iterate?: true }> {
    switch (step.kind) {
      case 'gather':     return this.executeGather(step, cycleNumber, cycleState);
      case 'produce':    return this.executeProduce(step, cycleNumber, cycleState);
      case 'review':     return this.executeReview(step, cycleNumber, cycleState);
      case 'checkpoint': return this.executeCheckpoint(step, cycleNumber, cycleState);
      case 'execute':    return this.executeExec(step, cycleNumber, cycleState);
      case 'commit':     return this.executeCommit(step, cycleNumber, cycleState);
    }
  }

  // -- gather ----------------------------------------------------------------

  private async executeGather(
    step: WorkflowStep,
    cycleNumber: number,
    cycleState: CycleStateContext,
  ): Promise<StepResult> {
    await this.markRunning(step.id, cycleNumber, cycleState.iteration);
    await this.markComplete(step.id, cycleNumber, cycleState.iteration, []);
    return { outcome: 'completed', next_step_id: '__next__' };
  }

  // -- produce ---------------------------------------------------------------

  private async executeProduce(
    step: WorkflowStep,
    cycleNumber: number,
    cycleState: CycleStateContext,
  ): Promise<StepResult> {
    const start = Date.now();
    await this.markRunning(step.id, cycleNumber, cycleState.iteration);

    const ctx = this.makeStepRunContext(cycleNumber, cycleState);
    const result = await this.deps.stepRunner.run(step, ctx);

    if (!result.success) {
      await this.deps.runArtifacts.updateNodeStatus(cycleNumber, cycleState.iteration, step.id, {
        status: 'failed',
        completed_at: new Date().toISOString(),
        duration_ms: result.duration_ms,
      });
      return { outcome: 'failed', next_step_id: null, error: result.error };
    }

    await this.markComplete(step.id, cycleNumber, cycleState.iteration, result.artifacts_written);
    if (result.artifacts_written.length > 0) {
      await updateArtifactEntries(this.deps.mapManager, result.artifacts_written, step.agentRole ?? 'builder');
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
  // Generic: delegates to stepRunner.run() and routes on failure via on_fail.
  // Full-build-specific review logic (critique, validation_gate) lives in
  // FullBuildStepRunner.run(), not here.

  private async executeReview(
    step: WorkflowStep,
    cycleNumber: number,
    cycleState: CycleStateContext,
  ): Promise<StepResult & { _iterate?: true }> {
    const start = Date.now();
    await this.markRunning(step.id, cycleNumber, cycleState.iteration);

    const ctx = this.makeStepRunContext(cycleNumber, cycleState);
    const result = await this.deps.stepRunner.run(step, ctx);

    if (!result.success) {
      await this.markComplete(step.id, cycleNumber, cycleState.iteration, []);
      if (step.on_fail?.iteration_loop) {
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

    await this.markComplete(step.id, cycleNumber, cycleState.iteration, result.artifacts_written);
    return { outcome: 'completed', next_step_id: '__next__', duration_ms: Date.now() - start };
  }

  // -- checkpoint ------------------------------------------------------------
  // Delegates to stepRunner.handleCheckpoint if defined; otherwise calls the
  // generic onCheckpoint callback. Full-build checkpoint logic lives in
  // FullBuildStepRunner.handleCheckpoint().

  private async executeCheckpoint(
    step: WorkflowStep,
    cycleNumber: number,
    cycleState: CycleStateContext,
  ): Promise<StepResult> {
    if (this.deps.stepRunner.handleCheckpoint) {
      const ctx = this.makeStepRunContext(cycleNumber, cycleState);
      return this.deps.stepRunner.handleCheckpoint(step, ctx);
    }
    await this.markRunning(step.id, cycleNumber, cycleState.iteration);
    const action = await this.opts.onCheckpoint(randomUUID(), step.id, cycleNumber, cycleState.iteration);
    if (action === 'halt') return { outcome: 'checkpoint_set', next_step_id: null };
    await this.markComplete(step.id, cycleNumber, cycleState.iteration, []);
    return { outcome: 'completed', next_step_id: '__next__' };
  }

  // -- execute ---------------------------------------------------------------
  // Delegates to stepRunner.handleExecute if defined; otherwise no-ops and
  // advances. Full-build execute logic (sandbox) lives in FullBuildStepRunner.

  private async executeExec(
    step: WorkflowStep,
    cycleNumber: number,
    cycleState: CycleStateContext,
  ): Promise<StepResult> {
    if (this.deps.stepRunner.handleExecute) {
      const ctx = this.makeStepRunContext(cycleNumber, cycleState);
      return this.deps.stepRunner.handleExecute(step, ctx);
    }
    await this.markRunning(step.id, cycleNumber, cycleState.iteration);
    await this.markComplete(step.id, cycleNumber, cycleState.iteration, []);
    return { outcome: 'completed', next_step_id: '__next__' };
  }

  // -- commit ----------------------------------------------------------------
  // Delegates to stepRunner.handleCommit if defined; otherwise marks complete
  // and ends the workflow. Full-build commit logic (snapshot) lives in
  // FullBuildStepRunner.handleCommit().

  private async executeCommit(
    step: WorkflowStep,
    cycleNumber: number,
    cycleState: CycleStateContext,
  ): Promise<StepResult> {
    if (this.deps.stepRunner.handleCommit) {
      const ctx = this.makeStepRunContext(cycleNumber, cycleState);
      return this.deps.stepRunner.handleCommit(step, ctx);
    }
    await this.markRunning(step.id, cycleNumber, cycleState.iteration);
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
    await this.deps.runArtifacts.updateNodeStatus(cycleNumber, iteration, step.id, {
      status: 'skipped',
      completed_at: new Date().toISOString(),
      skip_reason: reason ?? 'condition_not_met',
    });
  }

  private async markRunning(stepId: string, cycleNumber: number, iteration: number): Promise<void> {
    await this.deps.runArtifacts.updateNodeStatus(cycleNumber, iteration, stepId, {
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
    await this.deps.runArtifacts.updateNodeStatus(cycleNumber, iteration, stepId, {
      status: 'complete',
      completed_at: new Date().toISOString(),
      artifacts_written: artifactsWritten,
    });
  }

  private makeStepRunContext(cycleNumber: number, cycleState: CycleStateContext): StepRunContext {
    return {
      workflowRunId: String((cycleState as any).cycle_id ?? randomUUID()),
      cycleNumber,
      iteration: cycleState.iteration,
      planningDepth: cycleState.planning_depth,
      goal: String(cycleState.intent ?? ''),
      projectRoot: this.deps.projectRoot ?? process.cwd(),
      _legacyCycleState: cycleState as unknown as Record<string, unknown>,
    };
  }

  private async checkIterationCap(
    def: WorkflowDefinition,
    iteration: number,
    runId: string,
    stepId: string,
  ): Promise<WorkflowRunResult | null> {
    const maxIterations = def.max_iterations ?? Infinity;
    if (iteration < maxIterations) return null;
    return {
      run_id: runId,
      status: 'halted',
      final_step_id: stepId,
      iterations_used: iteration,
      error: `Iteration cap (${maxIterations}) reached`,
    };
  }
}
