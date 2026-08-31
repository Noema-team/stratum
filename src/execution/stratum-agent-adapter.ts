import { WorkflowEngine } from '../workflow/engine.js';
import { getWorkflow } from '../workflow/registry.js';
import type { WorkflowEngineDeps, WorkflowEngineOptions } from '../workflow/engine.js';
import type { ExecutionAdapter, ExecutionRequest, ExecutionResult, CapabilitySet, ExecutorCapability } from './types.js';
import { validateFullBuildParams, fullBuildCapHitAction } from './workflow-parameters.js';

const STRATUM_CAPABILITIES: ReadonlySet<ExecutorCapability> = new Set<ExecutorCapability>([
  'repo.read',
  'repo.write',
  'shell',
  'tests.run',
  'long_context',
  'structured_output',
]);

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

    // Load the frozen resolved parameters from the persisted WorkflowRun, if available.
    // On resume the engine will overwrite with the persisted value anyway, but this
    // lets the adapter pass the right parameters on initial dispatch too.
    const persistedRun = this.engineDeps.workflowRunRepository?.findById(request.workflowRunId);
    const rawParams = persistedRun?.resolvedParameters ?? request.workflowParameters;

    // Strict validation — throws on explicit invalid values (not silently defaults).
    const params = validateFullBuildParams(rawParams);

    // Per-request cap-hit behavior overrides the injected engineOpts when specified.
    const mergedOpts: WorkflowEngineOptions = params.on_cap_hit
      ? {
          ...this.engineOpts,
          onCapHit: async () => fullBuildCapHitAction(params.on_cap_hit),
        }
      : this.engineOpts;

    const engine = new WorkflowEngine(this.engineDeps, mergedOpts);
    const result = await engine.run(
      request.workflowId,
      1,
      request.workflowRunId,
      request.goal,
      entryStepId,
      request.workItemId,
      params.max_iterations,
      rawParams,
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
