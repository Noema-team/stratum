import { WorkflowEngine } from '../workflow/engine.js';
import { getWorkflow } from '../workflow/registry.js';
import type { WorkflowEngineDeps, WorkflowEngineOptions } from '../workflow/engine.js';
import type { ExecutionAdapter, ExecutionRequest, ExecutionResult, CapabilitySet, ExecutorCapability } from './types.js';
import type { PlanningDepth } from '../types.js';

const STRATUM_CAPABILITIES: ReadonlySet<ExecutorCapability> = new Set<ExecutorCapability>([
  'repo.read',
  'repo.write',
  'shell',
  'tests.run',
  'long_context',
  'structured_output',
]);

const VALID_DEPTHS = new Set<PlanningDepth>(['minimal', 'standard', 'deep', 'research']);
const VALID_CAP_HITS = new Set(['halt', 'force_pass', 'user_prompt']);

// Full-build-specific parameters extracted from ExecutionRequest.workflowParameters.
interface FullBuildParameters {
  planning_depth: PlanningDepth;
  max_iterations?: number;
  on_cap_hit?: 'halt' | 'force_pass' | 'user_prompt';
}

function extractFullBuildParams(raw?: Record<string, unknown>): FullBuildParameters {
  const depth = raw?.['planning_depth'];
  const maxIter = raw?.['max_iterations'];
  const capHit = raw?.['on_cap_hit'];
  return {
    planning_depth: (typeof depth === 'string' && VALID_DEPTHS.has(depth as PlanningDepth))
      ? (depth as PlanningDepth)
      : 'minimal',
    max_iterations: (typeof maxIter === 'number' && maxIter > 0) ? maxIter : undefined,
    on_cap_hit: (typeof capHit === 'string' && VALID_CAP_HITS.has(capHit))
      ? (capHit as FullBuildParameters['on_cap_hit'])
      : undefined,
  };
}

// Maps an ExecutionRequest onto WorkflowEngine.run() and translates the result.
// The engineDeps/engineOpts are injected so adapters in tests can use stubs.
export class StratumAgentAdapter implements ExecutionAdapter {
  readonly id = 'stratum-agent';

  constructor(
    private readonly engineDeps: WorkflowEngineDeps,
    private readonly engineOpts: WorkflowEngineOptions,
  ) {}

  getCapabilities(): CapabilitySet {
    return STRATUM_CAPABILITIES;
  }

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const start = Date.now();

    // Derive the entry step from the workflow definition instead of hard-coding.
    const def = getWorkflow(request.workflowId);
    const entryStepId = request.stepId !== '__start__'
      ? request.stepId
      : (def?.steps[0]?.id ?? 'scoping.gather');

    // Extract workflow-specific run parameters from workflowParameters seam.
    const params = extractFullBuildParams(request.workflowParameters);

    // Load persisted WorkflowRun to recover iteration/revision on resume.
    // For fresh runs the row doesn't exist yet, so defaults (1/0) apply.
    const persistedRun = this.engineDeps.workflowRunRepository?.findById(request.workflowRunId);

    // Build the cycle context the engine expects from what the scheduler provides.
    const cycleCtx: Record<string, unknown> = {
      cycle_number: 1,
      cycle_id: request.workflowRunId,
      iteration: persistedRun?.iteration ?? 1,
      revision: persistedRun?.revision ?? 0,
      planning_depth: params.planning_depth,
      intent: request.goal,
      current_node: null,
      target: null,
      project_root: this.engineDeps.projectRoot ?? process.cwd(),
    };

    // Per-request cap-hit behavior overrides the injected engineOpts when specified.
    const mergedOpts: WorkflowEngineOptions = params.on_cap_hit
      ? { ...this.engineOpts, onCapHit: async () => params.on_cap_hit! }
      : this.engineOpts;

    const engine = new WorkflowEngine(this.engineDeps, mergedOpts);
    const result = await engine.run(
      request.workflowId,
      1,
      request.workflowRunId,
      cycleCtx as any,
      entryStepId,
      request.workItemId,
      params.max_iterations,
    );

    // 'halted' without an error means the workflow is waiting at a checkpoint —
    // that is a structured 'blocked' outcome, not a failure.
    const isCheckpoint = result.status === 'halted' && !result.error;
    const outcome: ExecutionResult['outcome'] =
      result.status === 'complete' ? 'succeeded'
      : result.error ? 'failed'
      : 'blocked';

    return {
      schemaVersion: 1,
      stepExecutionId: request.stepExecutionId,
      outcome,
      artifacts: [],
      evidenceClaims: [],
      checkpointStepId: isCheckpoint ? (result.final_step_id ?? undefined) : undefined,
      decisionRequests: isCheckpoint
        ? [{ type: 'checkpoint', title: 'Workflow paused', summary: `Waiting at step: ${result.final_step_id ?? 'unknown'}` }]
        : [],
      usage: { durationMs: Date.now() - start },
      failure: result.error
        ? { code: 'workflow_error', message: result.error }
        : undefined,
    };
  }

  async cancel(_stepExecutionId: string): Promise<void> {
    // TODO: signal a running engine to halt when async execution is introduced
  }
}
