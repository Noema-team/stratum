import type { CycleStateContext } from '../context-manager.js';
import type { RuntimeMapManager } from '../runtime-map.js';
import type { RunArtifactManager } from '../run-artifacts.js';
import type { WorkflowRunRepository } from '../storage/repositories.js';
import type {
  WorkflowDefinition,
  WorkflowRun,
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
  // When present, the engine durably persists WorkflowRun cursor state and
  // operates in fail-closed mode: persistence failures abort lifecycle transitions.
  workflowRunRepository?: WorkflowRunRepository;
}

export interface WorkflowEngineOptions {
  // Generic checkpoint callback — invoked for checkpoint steps when the runner
  // does not provide handleCheckpoint. Resolves to 'approve' (continue) or
  // 'halt' (pause the run). Receives the canonical workflowRunId.
  onCheckpoint: (
    workflowRunId: string,
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
  // run — execute a workflow definition from the given start step.
  //
  // workflowRunId is the canonical identity for this run, supplied by the
  // caller (Scheduler or adapter). The engine never mints its own run ID —
  // every WorkflowRunResult.run_id echoes the supplied value.
  //
  // Cursor invariant: WorkflowRun.current_step_id = the next step eligible
  // to execute. The cursor is advanced to the next step only after the
  // current step completes successfully — it is never left pointing at a
  // step that has already been completed.
  //
  // Iteration tracking: the engine maintains a local iteration counter that
  // starts from cycleStateCtx.iteration. The engine does not read back from
  // mapManager to determine the current iteration — that would couple run
  // state to project-global cycle state and break concurrent WorkflowRuns.
  // The mapManager write in executeReview (legacy FullBuild compatibility)
  // remains a one-way advisory sync only.
  //
  // Fail-closed: when workflowRunRepository is injected, any failure to persist
  // a lifecycle transition propagates as an error, preventing the engine from
  // falsely claiming a transition succeeded.
  // --------------------------------------------------------------------------

  async run(
    workflowId: string,
    cycleNumber: number,
    workflowRunId: string,
    cycleStateCtx: CycleStateContext,
    startStepId?: string,
    workItemId?: string,
  ): Promise<WorkflowRunResult> {
    const def = getWorkflow(workflowId);
    if (!def) {
      return {
        run_id: workflowRunId,
        status: 'halted',
        final_step_id: null,
        iterations_used: cycleStateCtx.iteration,
        error: `Unknown workflow '${workflowId}'`,
      };
    }

    const startIndex = startStepId
      ? def.steps.findIndex(s => s.id === startStepId)
      : 0;

    if (startIndex === -1) {
      return {
        run_id: workflowRunId,
        status: 'halted',
        final_step_id: startStepId ?? null,
        iterations_used: cycleStateCtx.iteration,
        error: `Step '${startStepId}' not found in workflow '${workflowId}'`,
      };
    }

    // Local authoritative iteration counter. Never read back from mapManager.
    let iteration = cycleStateCtx.iteration;
    let cycleState = { ...cycleStateCtx, iteration };

    const startedAt = new Date().toISOString();

    // Save initial cursor: current_step_id = startStep = "next step eligible to execute".
    // ON CONFLICT DO NOTHING — safe to call on resume (row already exists).
    await this.saveRunCursor(workflowRunId, workflowId, workItemId, {
      status: 'active',
      current_step_id: def.steps[startIndex].id,
      iteration,
      revision: 0,
      awaiting_checkpoint: null,
      started_at: startedAt,
      updated_at: startedAt,
    });

    let stepIndex = startIndex;

    while (stepIndex < def.steps.length) {
      const step = def.steps[stepIndex];
      cycleState = { ...cycleState, iteration };

      const stepCtx: WorkflowStepContext = {
        runId: workflowRunId,
        workflowId,
        iteration,
        revision: 0,
        planningDepth: cycleState.planning_depth,
      };

      if (step.skip_if?.(stepCtx)) {
        await this.skipStep(step, cycleNumber, iteration);
        // Cursor was already pointing to this step; advance to next.
        const nextIndex = stepIndex + 1;
        if (nextIndex < def.steps.length) {
          await this.updateRunCursor(workflowRunId, {
            status: 'active',
            current_step_id: def.steps[nextIndex].id,
            iteration, revision: 0, awaiting_checkpoint: null,
          });
        }
        stepIndex = nextIndex;
        continue;
      }

      // Cursor is already pointing at step.id (set by previous advance or init save).
      // Execute the step.
      const result = await this.executeStep(step, cycleNumber, cycleState, workflowRunId);

      // ---- failure -----------------------------------------------------------
      if (result.outcome === 'failed') {
        // Cursor stays at step.id (already set) — a retry/restart re-executes from here.
        await this.updateRunCursor(workflowRunId, {
          status: 'halted',
          current_step_id: step.id,
          iteration, revision: 0, awaiting_checkpoint: null,
        });
        return {
          run_id: workflowRunId,
          status: 'halted',
          final_step_id: step.id,
          iterations_used: iteration,
          error: result.error,
        };
      }

      // ---- checkpoint halt ---------------------------------------------------
      if (result.outcome === 'checkpoint_set') {
        // Cursor stays at step.id — resuming re-executes the checkpoint (now approved).
        await this.updateRunCursor(workflowRunId, {
          status: 'halted',
          current_step_id: step.id,
          iteration, revision: 0, awaiting_checkpoint: step.id,
        });
        return {
          run_id: workflowRunId,
          status: 'halted',
          final_step_id: step.id,
          iterations_used: iteration,
          error: undefined,
        };
      }

      // ---- explicit routing (on_fail, loop back) -----------------------------
      if (result.outcome === 'completed' && result.next_step_id && result.next_step_id !== '__next__') {
        const targetIndex = def.steps.findIndex(s => s.id === result.next_step_id);
        if (targetIndex === -1) {
          return {
            run_id: workflowRunId,
            status: 'halted',
            final_step_id: step.id,
            iterations_used: iteration,
            error: `on_fail target '${result.next_step_id}' not found`,
          };
        }

        if ('_iterate' in (result as any)) {
          // Increment iteration locally — authoritative. The FullBuildStepRunner's
          // mapManager.update() is an advisory legacy sync, not the source of truth.
          iteration += 1;
          cycleState = { ...cycleState, iteration };

          const capResult = await this.checkIterationCap(def, iteration, workflowRunId, step.id);
          if (capResult) return capResult;

          // Advance cursor to loop target with updated iteration.
          await this.updateRunCursor(workflowRunId, {
            status: 'active',
            current_step_id: def.steps[targetIndex].id,
            iteration, revision: 0, awaiting_checkpoint: null,
          });

          try {
            await this.deps.runArtifacts.createRunDir(cycleNumber, iteration);
            await this.deps.runArtifacts.createManifest({
              cycleId: workflowRunId,
              cycleNumber,
              iteration,
              planningDepth: cycleState.planning_depth,
            });
          } catch {
            // non-fatal: runArtifacts are legacy observability, not control-plane state
          }
        } else {
          await this.updateRunCursor(workflowRunId, {
            status: 'active',
            current_step_id: def.steps[targetIndex].id,
            iteration, revision: 0, awaiting_checkpoint: null,
          });
        }

        stepIndex = targetIndex;
        continue;
      }

      // ---- terminal commit step (next_step_id === null) ----------------------
      if (result.next_step_id === null) {
        await this.updateRunCursor(workflowRunId, {
          status: 'complete',
          current_step_id: step.id,
          iteration, revision: 0, awaiting_checkpoint: null,
        });
        return {
          run_id: workflowRunId,
          status: 'complete',
          final_step_id: step.id,
          iterations_used: iteration,
        };
      }

      // ---- __next__: advance cursor to next sequential step ------------------
      const nextIndex = stepIndex + 1;
      if (nextIndex < def.steps.length) {
        // Crash-boundary: step[I] succeeded; cursor now advances to step[I+1].
        // A crash between this persist and the next step's execution causes step[I+1]
        // to be re-executed on restart (at-least-once for non-idempotent steps).
        await this.updateRunCursor(workflowRunId, {
          status: 'active',
          current_step_id: def.steps[nextIndex].id,
          iteration, revision: 0, awaiting_checkpoint: null,
        });
      }
      stepIndex = nextIndex;
    }

    // Loop ended: all steps executed sequentially to completion.
    const lastStepId = def.steps[def.steps.length - 1]?.id ?? null;
    await this.updateRunCursor(workflowRunId, {
      status: 'complete',
      current_step_id: lastStepId ?? '',
      iteration, revision: 0, awaiting_checkpoint: null,
    });
    return {
      run_id: workflowRunId,
      status: 'complete',
      final_step_id: lastStepId,
      iterations_used: iteration,
    };
  }

  // --------------------------------------------------------------------------
  // executeStep — dispatch to kind-specific handler
  // --------------------------------------------------------------------------

  private async executeStep(
    step: WorkflowStep,
    cycleNumber: number,
    cycleState: CycleStateContext,
    workflowRunId: string,
  ): Promise<StepResult & { _iterate?: true }> {
    switch (step.kind) {
      case 'gather':     return this.executeGather(step, cycleNumber, cycleState);
      case 'produce':    return this.executeProduce(step, cycleNumber, cycleState, workflowRunId);
      case 'review':     return this.executeReview(step, cycleNumber, cycleState, workflowRunId);
      case 'checkpoint': return this.executeCheckpoint(step, cycleNumber, cycleState, workflowRunId);
      case 'execute':    return this.executeExec(step, cycleNumber, cycleState, workflowRunId);
      case 'commit':     return this.executeCommit(step, cycleNumber, cycleState, workflowRunId);
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
    workflowRunId: string,
  ): Promise<StepResult> {
    const start = Date.now();
    await this.markRunning(step.id, cycleNumber, cycleState.iteration);

    const ctx = this.makeStepRunContext(cycleNumber, cycleState, workflowRunId);
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
  // When on_fail.iteration_loop is set, signals the run loop to increment
  // its local iteration counter (the _iterate flag). The FullBuildStepRunner
  // may also write to mapManager as a legacy advisory sync — this is not read
  // back by the engine.

  private async executeReview(
    step: WorkflowStep,
    cycleNumber: number,
    cycleState: CycleStateContext,
    workflowRunId: string,
  ): Promise<StepResult & { _iterate?: true }> {
    const start = Date.now();
    await this.markRunning(step.id, cycleNumber, cycleState.iteration);

    const ctx = this.makeStepRunContext(cycleNumber, cycleState, workflowRunId);
    const result = await this.deps.stepRunner.run(step, ctx);

    if (!result.success) {
      await this.markComplete(step.id, cycleNumber, cycleState.iteration, []);
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
  // generic onCheckpoint callback with the canonical workflowRunId.

  private async executeCheckpoint(
    step: WorkflowStep,
    cycleNumber: number,
    cycleState: CycleStateContext,
    workflowRunId: string,
  ): Promise<StepResult> {
    if (this.deps.stepRunner.handleCheckpoint) {
      const ctx = this.makeStepRunContext(cycleNumber, cycleState, workflowRunId);
      return this.deps.stepRunner.handleCheckpoint(step, ctx);
    }
    await this.markRunning(step.id, cycleNumber, cycleState.iteration);
    const action = await this.opts.onCheckpoint(workflowRunId, step.id, cycleNumber, cycleState.iteration);
    if (action === 'halt') return { outcome: 'checkpoint_set', next_step_id: null };
    await this.markComplete(step.id, cycleNumber, cycleState.iteration, []);
    return { outcome: 'completed', next_step_id: '__next__' };
  }

  // -- execute ---------------------------------------------------------------

  private async executeExec(
    step: WorkflowStep,
    cycleNumber: number,
    cycleState: CycleStateContext,
    workflowRunId: string,
  ): Promise<StepResult> {
    if (this.deps.stepRunner.handleExecute) {
      const ctx = this.makeStepRunContext(cycleNumber, cycleState, workflowRunId);
      return this.deps.stepRunner.handleExecute(step, ctx);
    }
    await this.markRunning(step.id, cycleNumber, cycleState.iteration);
    await this.markComplete(step.id, cycleNumber, cycleState.iteration, []);
    return { outcome: 'completed', next_step_id: '__next__' };
  }

  // -- commit ----------------------------------------------------------------

  private async executeCommit(
    step: WorkflowStep,
    cycleNumber: number,
    cycleState: CycleStateContext,
    workflowRunId: string,
  ): Promise<StepResult> {
    if (this.deps.stepRunner.handleCommit) {
      const ctx = this.makeStepRunContext(cycleNumber, cycleState, workflowRunId);
      return this.deps.stepRunner.handleCommit(step, ctx);
    }
    await this.markRunning(step.id, cycleNumber, cycleState.iteration);
    await this.markComplete(step.id, cycleNumber, cycleState.iteration, []);
    return { outcome: 'completed', next_step_id: null };
  }

  // --------------------------------------------------------------------------
  // RunArtifact helpers (legacy observability — not control-plane state)
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

  // makeStepRunContext receives workflowRunId explicitly — the engine never
  // derives run identity from cycleState (which is legacy full-build state).
  private makeStepRunContext(
    cycleNumber: number,
    cycleState: CycleStateContext,
    workflowRunId: string,
  ): StepRunContext {
    return {
      workflowRunId,
      cycleNumber,
      iteration: cycleState.iteration,
      planningDepth: cycleState.planning_depth,
      goal: String(cycleState.intent ?? ''),
      projectRoot: this.deps.projectRoot ?? process.cwd(),
      _legacyCycleState: cycleState as unknown as Record<string, unknown>,
    };
  }

  // --------------------------------------------------------------------------
  // WorkflowRun persistence — fail-closed when repo is injected.
  //
  // saveRunCursor: INSERT OR IGNORE — idempotent; safe to call on resume.
  // updateRunCursor: UPDATE — always applied; throws on error if repo is set.
  // --------------------------------------------------------------------------

  private async saveRunCursor(
    runId: string,
    workflowId: string,
    workItemId: string | undefined,
    fields: Omit<WorkflowRun, 'run_id' | 'workflow_id' | 'work_item_id'>,
  ): Promise<void> {
    if (!this.deps.workflowRunRepository) return;
    this.deps.workflowRunRepository.save({
      run_id: runId,
      workflow_id: workflowId,
      work_item_id: workItemId,
      ...fields,
    });
  }

  private async updateRunCursor(
    runId: string,
    fields: Pick<WorkflowRun, 'status' | 'current_step_id' | 'iteration' | 'revision' | 'awaiting_checkpoint'>,
  ): Promise<void> {
    if (!this.deps.workflowRunRepository) return;
    this.deps.workflowRunRepository.update({
      run_id: runId,
      workflow_id: '',  // not needed for UPDATE (keyed on run_id)
      work_item_id: undefined,
      started_at: '',   // not needed for UPDATE
      ...fields,
      updated_at: new Date().toISOString(),
    });
  }

  private async checkIterationCap(
    def: WorkflowDefinition,
    iteration: number,
    workflowRunId: string,
    stepId: string,
  ): Promise<WorkflowRunResult | null> {
    const maxIterations = def.max_iterations ?? Infinity;
    if (iteration < maxIterations) return null;
    return {
      run_id: workflowRunId,
      status: 'halted',
      final_step_id: stepId,
      iterations_used: iteration,
      error: `Iteration cap (${maxIterations}) reached`,
    };
  }
}
