import type { RuntimeMapManager } from '../runtime-map.js';
import type { RunArtifactManager } from '../run-artifacts.js';
import type { WorkflowRunRepository } from '../storage/repositories.js';
import type { PlanningDepth } from '../types.js';
import type {
  CapHitAction,
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
  // Called when the iteration cap is reached. Default: halt.
  // Returning { action: 'route', targetStepId } skips to that step and continues.
  onCapHit?: (
    workflowRunId: string,
    stepId: string,
    iteration: number,
  ) => Promise<CapHitAction>;
}

const VALID_DEPTHS = new Set<string>(['minimal', 'standard', 'deep', 'research']);

function extractPlanningDepth(params?: Record<string, unknown>): PlanningDepth {
  const d = params?.['planning_depth'];
  return (typeof d === 'string' && VALID_DEPTHS.has(d)) ? (d as PlanningDepth) : 'minimal';
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
  // goal is the human-readable intent for this run (formerly cycleStateCtx.intent).
  // resolvedParameters are the validated, frozen workflow parameters for this run.
  // They are persisted on WorkflowRun at initial dispatch and re-read on resume —
  // the caller must never re-derive them from WorkItem on resume.
  //
  // Cursor invariant: WorkflowRun.current_step_id = the next step eligible
  // to execute. The cursor is advanced to the next step only after the
  // current step completes successfully — it is never left pointing at a
  // step that has already been completed.
  //
  // Iteration tracking: the engine maintains a local iteration counter that
  // starts from 1 (or the persisted value on resume). The engine does not read
  // back from mapManager to determine the current iteration.
  //
  // Fail-closed: when workflowRunRepository is injected, any failure to persist
  // a lifecycle transition propagates as an error, preventing the engine from
  // falsely claiming a transition succeeded.
  // --------------------------------------------------------------------------

  async run(
    workflowId: string,
    cycleNumber: number,
    workflowRunId: string,
    goal: string,
    startStepId?: string,
    workItemId?: string,
    maxIterations?: number,
    resolvedParameters?: Record<string, unknown>,
  ): Promise<WorkflowRunResult> {

    // ---- SQLite cursor ownership --------------------------------------------
    // For existing runs, the persisted cursor is authoritative. Callers may not
    // override it. This prevents replaying completed segments or skipping steps.
    const existingRun = this.deps.workflowRunRepository?.findById(workflowRunId) ?? null;

    if (existingRun !== null) {
      // Identity guard: reject before any mutation if the caller presents a
      // different workflow or workItem binding than what was stored.
      if (existingRun.workflow_id !== workflowId) {
        return {
          run_id: workflowRunId,
          status: 'halted',
          final_step_id: existingRun.current_step_id,
          iterations_used: existingRun.iteration,
          error: `Identity mismatch: run '${workflowRunId}' is bound to workflow '${existingRun.workflow_id}', caller presented '${workflowId}'`,
        };
      }
      const storedWorkItemId = existingRun.work_item_id ?? undefined;
      if (storedWorkItemId !== workItemId) {
        return {
          run_id: workflowRunId,
          status: 'halted',
          final_step_id: existingRun.current_step_id,
          iterations_used: existingRun.iteration,
          error: `Identity mismatch: run '${workflowRunId}' is bound to workItem '${existingRun.work_item_id ?? 'none'}', caller presented '${workItemId ?? 'none'}'`,
        };
      }

      // Completed runs cannot be re-executed.
      if (existingRun.status === 'complete') {
        return {
          run_id: workflowRunId,
          status: 'complete',
          final_step_id: null,
          iterations_used: existingRun.iteration,
          error: `WorkflowRun '${workflowRunId}' is already complete — re-execution denied`,
        };
      }
      // SQLite cursor is authoritative; caller override is denied.
      if (startStepId && startStepId !== existingRun.current_step_id) {
        return {
          run_id: workflowRunId,
          status: 'halted',
          final_step_id: existingRun.current_step_id,
          iterations_used: existingRun.iteration,
          error: `Cursor override denied: persisted cursor is '${existingRun.current_step_id}', caller requested '${startStepId}'`,
        };
      }
      // Use persisted cursor as the authoritative start step.
      startStepId = existingRun.current_step_id;
      // Restore frozen parameters from the persisted run (not from the caller).
      resolvedParameters = existingRun.resolvedParameters ?? resolvedParameters;
    }

    const planningDepth = extractPlanningDepth(resolvedParameters);

    const def = getWorkflow(workflowId);
    if (!def) {
      const now = new Date().toISOString();
      const iter = existingRun?.iteration ?? 1;
      const rev = existingRun?.revision ?? 0;
      const haltStep = existingRun?.current_step_id ?? startStepId ?? '__unknown__';
      if (!existingRun) {
        await this.saveRunCursor(workflowRunId, workflowId, workItemId, resolvedParameters, {
          status: 'halted',
          current_step_id: haltStep,
          iteration: iter,
          revision: rev,
          awaiting_checkpoint: null,
          started_at: now,
          updated_at: now,
        });
      }
      await this.updateRunCursor(workflowRunId, {
        status: 'halted',
        current_step_id: haltStep,
        iteration: iter,
        revision: rev,
        awaiting_checkpoint: null,
      });
      return {
        run_id: workflowRunId,
        status: 'halted',
        final_step_id: null,
        iterations_used: iter,
        error: `Unknown workflow '${workflowId}'`,
      };
    }

    const startIndex = startStepId
      ? def.steps.findIndex(s => s.id === startStepId)
      : 0;

    if (startIndex === -1) {
      const now = new Date().toISOString();
      const iter = existingRun?.iteration ?? 1;
      const rev = existingRun?.revision ?? 0;
      const haltStep = existingRun?.current_step_id ?? startStepId ?? '__invalid__';
      if (!existingRun) {
        await this.saveRunCursor(workflowRunId, workflowId, workItemId, resolvedParameters, {
          status: 'halted',
          current_step_id: haltStep,
          iteration: iter,
          revision: rev,
          awaiting_checkpoint: null,
          started_at: now,
          updated_at: now,
        });
      }
      await this.updateRunCursor(workflowRunId, {
        status: 'halted',
        current_step_id: haltStep,
        iteration: iter,
        revision: rev,
        awaiting_checkpoint: null,
      });
      return {
        run_id: workflowRunId,
        status: 'halted',
        final_step_id: startStepId ?? null,
        iterations_used: iter,
        error: `Step '${startStepId}' not found in workflow '${workflowId}'`,
      };
    }

    // Local authoritative iteration counter.
    let iteration = 1;
    let revision = 0;

    const startedAt = new Date().toISOString();

    // Save initial cursor: current_step_id = startStep = "next step eligible to execute".
    // createOrValidate — idempotent on resume (row already exists with correct identity).
    await this.saveRunCursor(workflowRunId, workflowId, workItemId, resolvedParameters, {
      status: 'active',
      current_step_id: def.steps[startIndex].id,
      iteration,
      revision,
      awaiting_checkpoint: null,
      started_at: startedAt,
      updated_at: startedAt,
    });

    // Load persisted iteration/revision — for existing runs, authoritative values
    // from before the halt (e.g. iteration > 1 for iterative workflows).
    // For new runs, loads back exactly what was just written.
    if (this.deps.workflowRunRepository) {
      const persisted = existingRun ?? this.deps.workflowRunRepository.findById(workflowRunId);
      if (persisted) {
        iteration = persisted.iteration;
        revision = persisted.revision;
      }
    }

    // Initialize iteration-1 run directory and manifest for fresh runs.
    // This is observability infrastructure only — failure must not abort execution.
    if (!existingRun) {
      const stepIds = def.steps.map(s => s.id);
      try {
        await this.deps.runArtifacts.createRunDir(cycleNumber, iteration);
        await this.deps.runArtifacts.createManifest({
          cycleId: workflowRunId,
          cycleNumber,
          iteration,
          planningDepth,
          stepIds,
          ifNotExists: true,
        });
      } catch {
        // non-fatal: runArtifacts are legacy observability, not control-plane state
      }
    }

    let stepIndex = startIndex;

    while (stepIndex < def.steps.length) {
      const step = def.steps[stepIndex];

      const stepCtx: WorkflowStepContext = {
        runId: workflowRunId,
        workflowId,
        iteration,
        revision,
        planningDepth,
      };

      if (step.skip_if?.(stepCtx)) {
        await this.skipStep(step, cycleNumber, iteration);
        // Cursor was already pointing to this step; advance to next.
        const nextIndex = stepIndex + 1;
        if (nextIndex < def.steps.length) {
          await this.updateRunCursor(workflowRunId, {
            status: 'active',
            current_step_id: def.steps[nextIndex].id,
            iteration, revision, awaiting_checkpoint: null,
          });
        }
        stepIndex = nextIndex;
        continue;
      }

      // Cursor is already pointing at step.id (set by previous advance or init save).
      // Execute the step.
      const ctx = this.makeStepRunContext(step, cycleNumber, iteration, revision, planningDepth, goal, workflowId, workflowRunId, resolvedParameters);
      const result = await this.executeStep(step, cycleNumber, iteration, ctx, workflowRunId);

      // Generic revision increment — produced by confirm-revise (and any future step
      // that signals a plan revision without starting a new iteration).
      if (result._increment_revision === true) {
        revision += 1;
      }

      // ---- failure -----------------------------------------------------------
      if (result.outcome === 'failed') {
        // Cursor stays at step.id (already set) — a retry/restart re-executes from here.
        await this.updateRunCursor(workflowRunId, {
          status: 'halted',
          current_step_id: step.id,
          iteration, revision, awaiting_checkpoint: null,
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
          iteration, revision, awaiting_checkpoint: step.id,
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
          await this.updateRunCursor(workflowRunId, {
            status: 'halted',
            current_step_id: step.id,
            iteration, revision, awaiting_checkpoint: null,
          });
          return {
            run_id: workflowRunId,
            status: 'halted',
            final_step_id: step.id,
            iterations_used: iteration,
            error: `on_fail target '${result.next_step_id}' not found`,
          };
        }

        if ((result as any)._iterate === true) {
          // Increment iteration locally — authoritative. The FullBuildStepRunner's
          // mapManager.update() is an advisory legacy sync, not the source of truth.
          iteration += 1;
          revision = 0;  // new iteration resets revision

          const capResult = await this.checkIterationCap(def, iteration, workflowRunId, step.id, revision, maxIterations);
          if (capResult !== null) {
            if ('_route' in capResult) {
              // route action: skip to the named step and continue.
              const forceIndex = def.steps.findIndex(s => s.id === (capResult as any)._route);
              if (forceIndex !== -1) {
                await this.updateRunCursor(workflowRunId, {
                  status: 'active',
                  current_step_id: def.steps[forceIndex].id,
                  iteration, revision, awaiting_checkpoint: null,
                });
                stepIndex = forceIndex;
                continue;
              }
            }
            return capResult as WorkflowRunResult;
          }

          // Advance cursor to loop target with updated iteration.
          await this.updateRunCursor(workflowRunId, {
            status: 'active',
            current_step_id: def.steps[targetIndex].id,
            iteration, revision, awaiting_checkpoint: null,
          });

          const stepIds = def.steps.map(s => s.id);
          try {
            await this.deps.runArtifacts.createRunDir(cycleNumber, iteration);
            await this.deps.runArtifacts.createManifest({
              cycleId: workflowRunId,
              cycleNumber,
              iteration,
              planningDepth,
              stepIds,
            });
          } catch {
            // non-fatal: runArtifacts are legacy observability, not control-plane state
          }
        } else {
          await this.updateRunCursor(workflowRunId, {
            status: 'active',
            current_step_id: def.steps[targetIndex].id,
            iteration, revision, awaiting_checkpoint: null,
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
          iteration, revision, awaiting_checkpoint: null,
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
        await this.updateRunCursor(workflowRunId, {
          status: 'active',
          current_step_id: def.steps[nextIndex].id,
          iteration, revision, awaiting_checkpoint: null,
        });
      }
      stepIndex = nextIndex;
    }

    // Loop ended: all steps executed sequentially to completion.
    const lastStepId = def.steps[def.steps.length - 1]?.id ?? null;
    await this.updateRunCursor(workflowRunId, {
      status: 'complete',
      current_step_id: lastStepId ?? '',
      iteration, revision, awaiting_checkpoint: null,
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
    iteration: number,
    ctx: StepRunContext,
    workflowRunId: string,
  ): Promise<StepResult & { _iterate?: true }> {
    switch (step.kind) {
      case 'gather':     return this.executeGather(step, cycleNumber, iteration);
      case 'produce':    return this.executeProduce(step, cycleNumber, iteration, ctx, workflowRunId);
      case 'review':     return this.executeReview(step, cycleNumber, iteration, ctx, workflowRunId);
      case 'checkpoint': return this.executeCheckpoint(step, cycleNumber, iteration, ctx, workflowRunId);
      case 'execute':    return this.executeExec(step, cycleNumber, iteration, ctx, workflowRunId);
      case 'commit':     return this.executeCommit(step, cycleNumber, iteration, ctx, workflowRunId);
    }
  }

  // -- gather ----------------------------------------------------------------

  private async executeGather(
    step: WorkflowStep,
    cycleNumber: number,
    iteration: number,
  ): Promise<StepResult> {
    await this.markRunning(step.id, cycleNumber, iteration);
    await this.markComplete(step.id, cycleNumber, iteration, []);
    return { outcome: 'completed', next_step_id: '__next__' };
  }

  // -- produce ---------------------------------------------------------------

  private async executeProduce(
    step: WorkflowStep,
    cycleNumber: number,
    iteration: number,
    ctx: StepRunContext,
    _workflowRunId: string,
  ): Promise<StepResult & { _iterate?: true }> {
    const start = Date.now();
    await this.markRunning(step.id, cycleNumber, iteration);

    const result = await this.deps.stepRunner.run(step, ctx);

    if (!result.success) {
      await this.deps.runArtifacts.updateNodeStatus(cycleNumber, iteration, step.id, {
        status: 'failed',
        completed_at: new Date().toISOString(),
        duration_ms: result.duration_ms,
      });
      return { outcome: 'failed', next_step_id: null, error: result.error };
    }

    await this.markComplete(step.id, cycleNumber, iteration, result.artifacts_written);
    if (result.artifacts_written.length > 0) {
      await updateArtifactEntries(this.deps.mapManager, result.artifacts_written, step.agentRole ?? 'builder');
    }
    // A produce step may signal routing override and/or iteration increment (e.g. debug step).
    const nextStepId = result.next_step_id ?? '__next__';
    return {
      outcome: 'completed',
      next_step_id: nextStepId,
      _iterate: result._iterate,
      artifacts_written: result.artifacts_written,
      tokens_used: result.tokens_used,
      duration_ms: Date.now() - start,
    } as StepResult & { _iterate?: true };
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
    iteration: number,
    ctx: StepRunContext,
    _workflowRunId: string,
  ): Promise<StepResult & { _iterate?: true }> {
    const start = Date.now();
    await this.markRunning(step.id, cycleNumber, iteration);

    const result = await this.deps.stepRunner.run(step, ctx);

    if (!result.success) {
      await this.markComplete(step.id, cycleNumber, iteration, []);
      return {
        outcome: 'completed',
        next_step_id: step.on_fail?.target_step_id ?? null,
        _iterate: step.on_fail?.iteration_loop ? true : undefined,
        duration_ms: Date.now() - start,
      };
    }

    await this.markComplete(step.id, cycleNumber, iteration, result.artifacts_written);
    const passTarget = step.on_pass?.target_step_id ?? '__next__';
    return { outcome: 'completed', next_step_id: passTarget, duration_ms: Date.now() - start };
  }

  // -- checkpoint ------------------------------------------------------------
  // Delegates to stepRunner.handleCheckpoint if defined; otherwise calls the
  // generic onCheckpoint callback with the canonical workflowRunId.

  private async executeCheckpoint(
    step: WorkflowStep,
    cycleNumber: number,
    iteration: number,
    ctx: StepRunContext,
    workflowRunId: string,
  ): Promise<StepResult> {
    if (this.deps.stepRunner.handleCheckpoint) {
      return this.deps.stepRunner.handleCheckpoint(step, ctx);
    }
    await this.markRunning(step.id, cycleNumber, iteration);
    const action = await this.opts.onCheckpoint(workflowRunId, step.id, cycleNumber, iteration);
    if (action === 'halt') return { outcome: 'checkpoint_set', next_step_id: null };
    await this.markComplete(step.id, cycleNumber, iteration, []);
    return { outcome: 'completed', next_step_id: '__next__' };
  }

  // -- execute ---------------------------------------------------------------

  private async executeExec(
    step: WorkflowStep,
    cycleNumber: number,
    iteration: number,
    ctx: StepRunContext,
    _workflowRunId: string,
  ): Promise<StepResult> {
    if (this.deps.stepRunner.handleExecute) {
      return this.deps.stepRunner.handleExecute(step, ctx);
    }
    await this.markRunning(step.id, cycleNumber, iteration);
    await this.markComplete(step.id, cycleNumber, iteration, []);
    return { outcome: 'completed', next_step_id: '__next__' };
  }

  // -- commit ----------------------------------------------------------------

  private async executeCommit(
    step: WorkflowStep,
    cycleNumber: number,
    iteration: number,
    ctx: StepRunContext,
    _workflowRunId: string,
  ): Promise<StepResult> {
    if (this.deps.stepRunner.handleCommit) {
      return this.deps.stepRunner.handleCommit(step, ctx);
    }
    await this.markRunning(step.id, cycleNumber, iteration);
    await this.markComplete(step.id, cycleNumber, iteration, []);
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

  // makeStepRunContext receives all fields explicitly — the engine never derives
  // context from external sources or legacy CycleStateContext.
  private makeStepRunContext(
    step: WorkflowStep,
    cycleNumber: number,
    iteration: number,
    revision: number,
    planningDepth: PlanningDepth,
    goal: string,
    workflowId: string,
    workflowRunId: string,
    resolvedParameters?: Record<string, unknown>,
  ): StepRunContext {
    return {
      workflowRunId,
      workflowId,
      stepId: step.id,
      role: step.agentRole,
      cycleNumber,
      iteration,
      revision,
      planningDepth,
      goal,
      projectRoot: this.deps.projectRoot ?? process.cwd(),
      workflowParameters: resolvedParameters,
    };
  }

  // --------------------------------------------------------------------------
  // WorkflowRun persistence — fail-closed when repo is injected.
  //
  // saveRunCursor: createOrValidate — idempotent on identity match; throws on collision.
  // updateRunCursor: UPDATE — throws if row not found (fail-closed).
  // --------------------------------------------------------------------------

  private async saveRunCursor(
    runId: string,
    workflowId: string,
    workItemId: string | undefined,
    resolvedParameters: Record<string, unknown> | undefined,
    fields: Omit<WorkflowRun, 'run_id' | 'workflow_id' | 'work_item_id' | 'resolvedParameters'>,
  ): Promise<void> {
    if (!this.deps.workflowRunRepository) return;
    this.deps.workflowRunRepository.createOrValidate({
      run_id: runId,
      workflow_id: workflowId,
      work_item_id: workItemId,
      resolvedParameters,
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
    revision: number,
    externalMaxIterations?: number,
  ): Promise<WorkflowRunResult | { _route: string } | null> {
    const cap = externalMaxIterations ?? def.max_iterations ?? Infinity;
    if (iteration < cap) return null;

    const capAction: CapHitAction = this.opts.onCapHit
      ? await this.opts.onCapHit(workflowRunId, stepId, iteration)
      : { action: 'halt' };

    if (capAction.action === 'route') {
      return { _route: capAction.targetStepId };
    }
    // halt
    await this.updateRunCursor(workflowRunId, {
      status: 'halted',
      current_step_id: stepId,
      iteration, revision, awaiting_checkpoint: null,
    });
    return {
      run_id: workflowRunId,
      status: 'halted',
      final_step_id: stepId,
      iterations_used: iteration,
      error: `Iteration cap (${cap}) reached`,
    };
  }
}
