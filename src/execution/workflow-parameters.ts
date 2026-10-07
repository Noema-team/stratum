import type { CapHitAction, EditPolicy } from '../workflow/types.js';
import type { PlanningDepth } from '../types.js';
import { parseEditPolicyShape } from '../workflow/edit-policy.js';
import { parseDefinitionSourceRef } from './definition-source.js';

// ============================================================================
// Full-build workflow parameter contract
// ============================================================================

const VALID_DEPTHS = new Set<string>(['minimal', 'standard', 'deep', 'research']);
const VALID_CAP_HITS = new Set(['halt', 'force_pass', 'user_prompt']);

export interface FullBuildParameters {
  planning_depth: PlanningDepth;
  max_iterations: number;
  on_cap_hit: 'halt' | 'force_pass' | 'user_prompt';
  // DDR-041 — exact reference to the completed define-work WorkItem whose
  // canonical Definition this run implements. Resolved and integrity-pinned
  // by StratumAgentAdapter at dispatch (see definition-source.ts); frozen
  // into WorkflowRun.resolvedParameters with the other parameters.
  definitionSource?: { workItemId: string };
  // E27r — task edit authorization. Strictly validated here (fail-closed,
  // shared shape rules with the engine) and preserved into
  // WorkflowRun.resolvedParameters so initial dispatch and resume use exactly
  // the same frozen policy. The appliesToSteps → real-workflow-step check
  // needs the workflow definition and stays in WorkflowEngine.run
  // (validateEditPolicyTargets) — it fails the run before any step executes.
  editPolicy?: EditPolicy;
}

// Strict validator: throws on explicit invalid values (not silently defaults).
// Absent fields receive their defaults; present-but-invalid fields are rejected.
// Default iteration cap for full-build. Chosen to be finite so that a run
// cannot loop indefinitely; callers may override via max_iterations.
const DEFAULT_MAX_ITERATIONS = 10;

export function validateFullBuildParams(raw?: Record<string, unknown>): FullBuildParameters {
  if (!raw) {
    return { planning_depth: 'minimal', max_iterations: DEFAULT_MAX_ITERATIONS, on_cap_hit: 'halt' };
  }

  const depth = raw['planning_depth'];
  if (depth !== undefined && !(typeof depth === 'string' && VALID_DEPTHS.has(depth))) {
    throw new Error(
      `Invalid planning_depth '${depth}'. Must be one of: ${[...VALID_DEPTHS].join(', ')}`
    );
  }

  const maxIter = raw['max_iterations'];
  if (maxIter !== undefined && !(typeof maxIter === 'number' && Number.isInteger(maxIter) && maxIter > 0)) {
    throw new Error(
      `Invalid max_iterations '${maxIter}'. Must be a positive integer.`
    );
  }

  const capHit = raw['on_cap_hit'];
  if (capHit !== undefined && !(typeof capHit === 'string' && VALID_CAP_HITS.has(capHit))) {
    throw new Error(
      `Invalid on_cap_hit '${capHit}'. Must be one of: ${[...VALID_CAP_HITS].join(', ')}`
    );
  }

  // DDR-041 — strict shape gate: if a definitionSource is declared it must be
  // the exact single-key reference (deep validation happens at dispatch in
  // definition-source.ts; this keeps the frozen contract honest).
  const definitionSource = raw['definitionSource'];
  if (definitionSource !== undefined && !parseDefinitionSourceRef(definitionSource)) {
    throw new Error(
      `Invalid definitionSource '${JSON.stringify(definitionSource)}'. Must be { workItemId: <non-empty string> }`
    );
  }

  // E27r / P1-R seam correction — the task editPolicy is part of the frozen
  // parameter contract. It is validated with the SAME strict fail-closed
  // shape rules the engine enforces (parseEditPolicyShape) and PRESERVED
  // into the normalized parameters, so it reaches WorkflowRun.resolved-
  // Parameters and StepRunContext.editPolicy. Before this correction the
  // whitelist below silently dropped the policy: every campaign run (V8–P1)
  // executed with no edit policy at all. Unknown keys are still NOT passed
  // through — only explicitly contracted parameters flow to the engine.
  const editPolicy = raw['editPolicy'];
  if (editPolicy !== undefined) {
    parseEditPolicyShape(editPolicy); // throws on any deviation — no silent "no policy" degradation
  }

  return {
    planning_depth: (depth as PlanningDepth | undefined) ?? 'minimal',
    max_iterations: (maxIter as number | undefined) ?? DEFAULT_MAX_ITERATIONS,
    on_cap_hit: (capHit as FullBuildParameters['on_cap_hit'] | undefined) ?? 'halt',
    ...(definitionSource !== undefined
      ? { definitionSource: parseDefinitionSourceRef(definitionSource)! }
      : {}),
    ...(editPolicy !== undefined ? { editPolicy: parseEditPolicyShape(editPolicy) } : {}),
  };
}

// Maps the on_cap_hit string value to the generic CapHitAction.
// force_pass → route to 'evaluate'; user_prompt is recorded debt (treated as halt).
export function fullBuildCapHitAction(on_cap_hit?: FullBuildParameters['on_cap_hit']): CapHitAction {
  if (on_cap_hit === 'force_pass') {
    return { action: 'route', targetStepId: 'evaluate' };
  }
  // halt and user_prompt both halt; user_prompt as a real Decision flow is documented debt.
  return { action: 'halt' };
}
