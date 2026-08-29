import { WorkflowEngine } from '../workflow/engine.js';
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

    // Build the cycle context the engine expects from what the scheduler provides.
    const cycleCtx: Record<string, unknown> = {
      cycle_number: 1,
      cycle_id: request.workflowRunId,
      iteration: 1,
      revision: 0,
      planning_depth: 'minimal',
      intent: request.goal,
      target: null,
      project_root: this.engineDeps.projectRoot ?? '/tmp',
    };

    const engine = new WorkflowEngine(this.engineDeps, this.engineOpts);
    const result = await engine.run(
      request.workflowId,
      1,
      request.workflowRunId,
      cycleCtx as any,
      request.stepId,
    );

    return {
      schemaVersion: 1,
      stepExecutionId: request.stepExecutionId,
      outcome: result.status === 'complete' ? 'succeeded' : 'failed',
      artifacts: [],
      evidenceClaims: [],
      decisionRequests: [],
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
