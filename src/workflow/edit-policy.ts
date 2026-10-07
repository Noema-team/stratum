import type { EditPolicy } from './types.js';
import { toSafeRelativePath } from '../path-safety.js';

// ============================================================================
// Task editPolicy — the ONE strict, fail-closed shape validator.
//
// Consumed at two boundaries that must never drift:
//   1. the full-build invocation seam (src/execution/workflow-parameters.ts) —
//      a declared policy is validated and preserved into normalizedParams /
//      WorkflowRun.resolvedParameters BEFORE WorkflowEngine dispatch;
//   2. WorkflowEngine.resolveEditPolicy (src/workflow/engine.ts) — per-step
//      resolution re-derives the policy from the same frozen shape rules.
//
// Every deviation throws; a malformed or misspelled policy must never
// silently degrade to "no policy". `undefined` means genuinely absent and is
// handled by the callers; `null` is malformed and throws. The policy applies
// ONLY to the steps named in appliesToSteps — every other step receives no
// policy at all (upstream artifact producers must stay unaffected). The
// appliesToSteps → real-workflow-step check needs the workflow definition
// and stays in WorkflowEngine (validateEditPolicyTargets), which runs ONCE
// in run() before any step executes.
// ============================================================================

export function parseEditPolicyShape(raw: unknown): EditPolicy {
  const malformed = (why: string): never => {
    throw new Error(`Invalid workflowParameters.editPolicy (${why}): expected { appliesToSteps: string[], allowedEditPaths: string[], requiredEditPaths: string[] } with exact repository-relative paths`);
  };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return malformed('null or non-object');
  }
  const p = raw as Partial<EditPolicy>;
  const isStringArray = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((e) => typeof e === 'string');
  if (!isStringArray(p.appliesToSteps) || p.appliesToSteps.length === 0) {
    return malformed('appliesToSteps must be a non-empty string array');
  }
  if (!isStringArray(p.allowedEditPaths) || p.allowedEditPaths.length === 0) {
    return malformed('allowedEditPaths must be a non-empty string array');
  }
  if (!isStringArray(p.requiredEditPaths)) {
    return malformed('requiredEditPaths must be a string array');
  }
  const safePaths = (paths: string[], field: string): string[] => {
    const seen = new Set<string>();
    for (const path of paths) {
      const canonical = toSafeRelativePath(path);
      if (canonical === null || canonical === '') {
        return malformed(`${field} contains an empty or unsafe path: '${path}'`);
      }
      if (seen.has(canonical)) return malformed(`${field} contains a duplicate path: '${canonical}'`);
      seen.add(canonical);
    }
    return paths;
  };
  const allowed = safePaths(p.allowedEditPaths, 'allowedEditPaths');
  const required = safePaths(p.requiredEditPaths, 'requiredEditPaths');
  for (const path of required) {
    if (!allowed.includes(path)) {
      return malformed(`requiredEditPaths must be a subset of allowedEditPaths: '${path}' is not allowed`);
    }
  }
  return { appliesToSteps: p.appliesToSteps, allowedEditPaths: allowed, requiredEditPaths: required };
}
