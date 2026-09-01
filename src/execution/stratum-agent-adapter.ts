import { WorkflowEngine } from '../workflow/engine.js';
import { getWorkflow } from '../workflow/registry.js';
import type { WorkflowEngineDeps, WorkflowEngineOptions } from '../workflow/engine.js';
import type { ExecutionAdapter, ExecutionRequest, ExecutionResult, CapabilitySet, ExecutorCapability } from './types.js';
import { resolveWorkflowInvocation } from './workflow-invocation.js';

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

    // Derive the entry step from the workflow definition.
    // For unknown workflows the engine's own unknown-workflow path fails closed.
    const def = getWorkflow(request.workflowId);
    const entryStepId = request.stepId !== '__start__'
      ? request.stepId
      : def?.steps[0]?.id;

    // Load frozen resolved parameters from the persisted WorkflowRun when available.
    const persistedRun = this.engineDeps.workflowRunRepository?.findById(request.workflowRunId);
    const rawParams = persistedRun?.resolvedParameters ?? request.workflowParameters;

    // Resolve workflow-specific parameter contract and cap semantics via seam.
    const invocation = resolveWorkflowInvocation(request.workflowId, rawParams);

    const mergedOpts: WorkflowEngineOptions = {
      ...this.engineOpts,
      onCapHit: invocation.onCapHit,
    };

    const engine = new WorkflowEngine(this.engineDeps, mergedOpts);
    const result = await engine.run(
      request.workflowId,
      request.workflowRunId,
      request.goal,
      entryStepId,
      request.workItemId,
      invocation.maxIterations,
      invocation.normalizedParams,
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
