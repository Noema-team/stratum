// AgentStepRunner bridges the generic StepRunner interface (used by WorkflowEngine)
// to AgentRunner. The step's agentRole is passed directly — no DAGNodeId mapping.

import type { AgentRunner } from '../agent-runner.js';
import type { StepRunner, StepRunContext, StepRunOutcome, WorkflowStep } from '../workflow/types.js';

export class AgentStepRunner implements StepRunner {
  constructor(private readonly agentRunner: AgentRunner) {}

  async run(step: WorkflowStep, ctx: StepRunContext): Promise<StepRunOutcome> {
    const role = step.agentRole ?? 'builder';
    const result = await this.agentRunner.run(role, ctx);

    return {
      success: result.success,
      artifacts_written: result.artifacts_written,
      tokens_used: result.tokens_used,
      duration_ms: result.duration_ms,
      error: result.error,
      reviewVerdict: result.reviewVerdict,
    };
  }
}
