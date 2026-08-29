import { WorkflowEngine } from '../workflow/engine.js';
import { getWorkflow } from '../workflow/registry.js';
import type { WorkflowEngineDeps, WorkflowEngineOptions } from '../workflow/engine.js';
import type { ExecutionAdapter, ExecutionRequest, ExecutionResult, CapabilitySet, ExecutorCapability } from './types.js';

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

    // Build the cycle context the engine expects from what the scheduler provides.
    // _legacyCycleState is passed through for adapters that still need it.
    const cycleCtx: Record<string, unknown> = {
      cycle_number: 1,
      cycle_id: request.workflowRunId,
      iteration: 1,
      revision: 0,
      planning_depth: 'minimal',
      intent: request.goal,
      current_node: null,
      target: null,
      project_root: this.engineDeps.projectRoot ?? process.cwd(),
    };

    const engine = new WorkflowEngine(this.engineDeps, this.engineOpts);
    const result = await engine.run(
      request.workflowId,
      1,
      request.workflowRunId,
      cycleCtx as any,
      entryStepId,
    );

    // 'halted' without an error means the workflow is waiting at a checkpoint —
    // that is a structured 'blocked' outcome, not a failure.
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
      decisionRequests: result.status === 'halted' && !result.error
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
