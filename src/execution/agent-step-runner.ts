// AgentStepRunner bridges the generic StepRunner interface (used by WorkflowEngine)
// to the legacy AgentRunner, which takes a DAGNodeId and a CycleStateContext.
//
// The mapping from agentRole → DAGNodeId lives here, outside src/workflow/, so
// the engine itself stays free of legacy DAG semantics.

import type { AgentRunner, DAGNodeId } from '../agent-runner.js';
import type { CycleStateContext } from '../context-manager.js';
import type { StepRunner, StepRunContext, StepRunOutcome, WorkflowStep } from '../workflow/types.js';

const ROLE_TO_NODE: Record<string, DAGNodeId> = {
  facilitator: 'SCOPING',
  designer:    'DESIGN',
  critic:      'CRITIQUE',
  planner:     'PLAN',
  tester:      'TEST',
  builder:     'BUILD',
  evaluator:   'EVALUATE',
  debugger:    'DEBUG',
  historian:   'SUMMARISE',
};

export class AgentStepRunner implements StepRunner {
  constructor(private readonly agentRunner: AgentRunner) {}

  async run(step: WorkflowStep, ctx: StepRunContext): Promise<StepRunOutcome> {
    const role = step.agentRole ?? 'builder';
    const nodeId = ROLE_TO_NODE[role] ?? role.toUpperCase();

    // Reconstruct the CycleStateContext from StepRunContext (backward compat).
    // New code should not depend on the legacy fields in _legacyCycleState.
    const cycleState: CycleStateContext = ctx._legacyCycleState
      ? (ctx._legacyCycleState as unknown as CycleStateContext)
      : {
          cycle_number: ctx.cycleNumber,
          iteration: ctx.iteration,
          planning_depth: ctx.planningDepth,
          intent: ctx.goal,
          current_node: nodeId,
        };

    const result = await this.agentRunner.run(nodeId, cycleState);

    return {
      success: result.success,
      artifacts_written: result.artifacts_written,
      tokens_used: result.tokens_used,
      duration_ms: result.duration_ms,
      error: result.error,
    };
  }
}
