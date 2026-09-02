// Resolves workflow-specific invocation parameters for a given workflowId.
// StratumAgentAdapter calls this seam so it never imports workflow-specific
// parameter schemas directly — new workflows register here, not in the adapter.

import { validateFullBuildParams, fullBuildCapHitAction } from './workflow-parameters.js';
import type { CapHitAction } from '../workflow/types.js';

export interface WorkflowInvocation {
  maxIterations: number | undefined;
  normalizedParams: Record<string, unknown>;
  onCapHit: (workflowRunId: string, stepId: string, iteration: number) => Promise<CapHitAction>;
}

export function resolveWorkflowInvocation(
  workflowId: string,
  rawParameters: Record<string, unknown> | undefined,
): WorkflowInvocation {
  if (workflowId === 'full-build') {
    const params = validateFullBuildParams(rawParameters);
    return {
      maxIterations: params.max_iterations,
      normalizedParams: { ...params },
      onCapHit: async () => fullBuildCapHitAction(params.on_cap_hit),
    };
  }

  // Generic fallback: pass raw parameters through; no iteration cap semantics.
  return {
    maxIterations: undefined,
    normalizedParams: rawParameters ?? {},
    onCapHit: async () => ({ action: 'halt' as const }),
  };
}
