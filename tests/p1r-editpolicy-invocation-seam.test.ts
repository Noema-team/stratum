// P1-R seam correction — the full-build invocation contract must preserve a
// valid task editPolicy into normalizedParams (→ WorkflowRun.resolved-
// Parameters → StepRunContext.editPolicy) and fail closed on every deviation.
//
// Campaign forensics (evidence/p1-forensics/test-build-boundary-forensics.md,
// journal b33721f/b095e98) established the defect: validateFullBuildParams
// reconstructed a whitelist that silently DROPPED workflowParameters.editPolicy,
// so every campaign run (V8–P1) executed BUILD with no edit policy at all —
// unauthorized-create-path and requiredEditPaths enforcement were inert.
//
// Pinned here (seam level):
//   S1. a valid policy round-trips verbatim through validateFullBuildParams
//   S2. the fail-closed shape matrix (each deviation throws; nothing degrades
//       to "no policy")
//   S3. unknown parameters are still NOT passed through
//   S4. resolveWorkflowInvocation('full-build') carries the policy into
//       normalizedParams (the exact object frozen into the WorkflowRun)
//   S5. the engine's target-step gate still fails an unknown appliesToSteps
//       id at run() start, before any step executes (the shape/target
//       responsibilities stay split seam ↔ engine without drift)

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { validateFullBuildParams } from '../src/execution/workflow-parameters.js';
import { resolveWorkflowInvocation } from '../src/execution/workflow-invocation.js';
import { validateEditPolicyTargets } from '../src/workflow/engine.js';
import { getWorkflow, registerWorkflow } from '../src/workflow/registry.js';
import type { WorkflowDefinition } from '../src/workflow/types.js';

const FROZEN_POLICY = {
  appliesToSteps: ['build'],
  allowedEditPaths: ['apps/ai-server/rag-worker-service/main.py'],
  requiredEditPaths: ['apps/ai-server/rag-worker-service/main.py'],
};

// ─── S1. valid policy is preserved verbatim ───────────────────────────────────

test('P1R-S1: validateFullBuildParams preserves a valid editPolicy into the normalized parameters', () => {
  const params = validateFullBuildParams({
    planning_depth: 'minimal',
    max_iterations: 3,
    on_cap_hit: 'halt',
    editPolicy: FROZEN_POLICY,
  });
  assert.deepEqual(params.editPolicy, FROZEN_POLICY);
  // the policy is preserved with its exact declared strings — no silent
  // canonicalization between the frozen contract and the engine
  assert.equal(params.editPolicy!.allowedEditPaths[0], 'apps/ai-server/rag-worker-service/main.py');
});

test('P1R-S1b: absent editPolicy still yields no policy (genuinely absent, not malformed)', () => {
  const params = validateFullBuildParams({ planning_depth: 'minimal' });
  assert.equal(params.editPolicy, undefined);
  const empty = validateFullBuildParams(undefined);
  assert.equal(empty.editPolicy, undefined);
});

// ─── S2. fail-closed shape matrix ─────────────────────────────────────────────

test('P1R-S2: every malformed policy fails closed with the canonical message', () => {
  const cases: Array<[string, unknown, RegExp]> = [
    ['null policy', null, /null or non-object/],
    ['array policy', [FROZEN_POLICY], /null or non-object/],
    ['non-object policy', 'build-only', /null or non-object/],
    ['empty appliesToSteps', { ...FROZEN_POLICY, appliesToSteps: [] }, /appliesToSteps must be a non-empty string array/],
    ['non-string appliesToSteps', { ...FROZEN_POLICY, appliesToSteps: [7] }, /appliesToSteps must be a non-empty string array/],
    ['missing appliesToSteps', { allowedEditPaths: ['a.py'], requiredEditPaths: [] }, /appliesToSteps must be a non-empty string array/],
    ['empty allowedEditPaths', { ...FROZEN_POLICY, allowedEditPaths: [] }, /allowedEditPaths must be a non-empty string array/],
    ['missing requiredEditPaths', { appliesToSteps: ['build'], allowedEditPaths: ['a.py'] }, /requiredEditPaths must be a string array/],
    ['non-array requiredEditPaths', { ...FROZEN_POLICY, requiredEditPaths: 'a.py' }, /requiredEditPaths must be a string array/],
    ['traversal path', { ...FROZEN_POLICY, allowedEditPaths: ['../escape/main.py'] }, /allowedEditPaths contains an empty or unsafe path/],
    ['absolute path', { ...FROZEN_POLICY, allowedEditPaths: ['/etc/passwd'] }, /allowedEditPaths contains an empty or unsafe path/],
    ['empty path', { ...FROZEN_POLICY, allowedEditPaths: [''] }, /allowedEditPaths contains an empty or unsafe path/],
    ['duplicate allowed path', { ...FROZEN_POLICY, allowedEditPaths: [FROZEN_POLICY.allowedEditPaths[0], './' + FROZEN_POLICY.allowedEditPaths[0]] }, /allowedEditPaths contains a duplicate path/],
    ['duplicate required path', { ...FROZEN_POLICY, requiredEditPaths: [FROZEN_POLICY.requiredEditPaths[0], FROZEN_POLICY.requiredEditPaths[0]] }, /requiredEditPaths contains a duplicate path/],
    [
      'required not subset of allowed',
      { appliesToSteps: ['build'], allowedEditPaths: ['a/main.py'], requiredEditPaths: ['b/main.py'] },
      /requiredEditPaths must be a subset of allowedEditPaths: 'b\/main.py' is not allowed/,
    ],
  ];
  for (const [label, policy, expected] of cases) {
    assert.throws(
      () => validateFullBuildParams({ planning_depth: 'minimal', editPolicy: policy as never }),
      (err: unknown) => expected.test((err as Error).message) && (err as Error).message.includes('Invalid workflowParameters.editPolicy'),
      `case '${label}' must fail closed with a canonical message`,
    );
  }
});

// ─── S3. no arbitrary passthrough ─────────────────────────────────────────────

test('P1R-S3: unknown workflow parameters are still not passed through to the engine', () => {
  const params = validateFullBuildParams({
    planning_depth: 'minimal',
    editPolicy: FROZEN_POLICY,
    rogue_key: 'must-not-leak',
    another: { nested: true },
  });
  assert.deepEqual(Object.keys(params).sort(), ['editPolicy', 'max_iterations', 'on_cap_hit', 'planning_depth']);
});

// ─── S4. the invocation seam carries the policy end-to-end ────────────────────

test('P1R-S4: resolveWorkflowInvocation(full-build) exposes the frozen policy in normalizedParams', () => {
  const invocation = resolveWorkflowInvocation('full-build', {
    max_iterations: 3,
    editPolicy: FROZEN_POLICY,
  });
  assert.deepEqual(invocation.normalizedParams['editPolicy'], FROZEN_POLICY);
  // identical object content on a second resolution — the frozen contract is
  // deterministic across dispatch and resume revalidation
  const again = resolveWorkflowInvocation('full-build', {
    max_iterations: 3,
    editPolicy: FROZEN_POLICY,
  });
  assert.deepEqual(again.normalizedParams, invocation.normalizedParams);
});

// ─── S5. target-step gate stays with the engine, fail-closed ──────────────────

test('P1R-S5: an appliesToSteps id that names no real workflow step fails the run at dispatch', () => {
  registerWorkflow({
    id: 'p1r-seam-wf',
    steps: [{ id: 'design' }, { id: 'build' }, { id: 'evaluate' }],
  } as unknown as WorkflowDefinition);
  const def = getWorkflow('p1r-seam-wf');
  assert.ok(def);
  const typoPolicy = { ...FROZEN_POLICY, appliesToSteps: ['buidl'] };
  // the SEAM accepts the shape (targets are an engine responsibility — it owns
  // the definition); the ENGINE refuses before any step executes
  const params = validateFullBuildParams({ editPolicy: typoPolicy });
  assert.deepEqual(params.editPolicy, typoPolicy);
  assert.throws(
    () => validateEditPolicyTargets({ editPolicy: typoPolicy }, def!),
    /references unknown workflow step 'buidl'/,
  );
  // a valid target passes the same gate
  validateEditPolicyTargets({ editPolicy: FROZEN_POLICY }, def!);
});
