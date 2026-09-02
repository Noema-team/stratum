import type { CapHitAction } from '../workflow/types.js';
import type { PlanningDepth } from '../types.js';

// ============================================================================
// Full-build workflow parameter contract
// ============================================================================

const VALID_DEPTHS = new Set<string>(['minimal', 'standard', 'deep', 'research']);
const VALID_CAP_HITS = new Set(['halt', 'force_pass', 'user_prompt']);

export interface FullBuildParameters {
  planning_depth: PlanningDepth;
  max_iterations: number;
  on_cap_hit: 'halt' | 'force_pass' | 'user_prompt';
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

  return {
    planning_depth: (depth as PlanningDepth | undefined) ?? 'minimal',
    max_iterations: (maxIter as number | undefined) ?? DEFAULT_MAX_ITERATIONS,
    on_cap_hit: (capHit as FullBuildParameters['on_cap_hit'] | undefined) ?? 'halt',
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
