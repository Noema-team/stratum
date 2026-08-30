import { test } from 'node:test';
import { strict as assert } from 'assert';
import {
  getWorkflow,
  listWorkflowIds,
  registerWorkflow,
  stepCount,
  BUILTIN_IDS,
  FULL_BUILD,
  DRAFT_ARTIFACT,
  WorkflowEngine,
} from '../src/workflow/index.js';
import type { WorkflowDefinition, WorkflowEngineDeps, WorkflowEngineOptions } from '../src/workflow/index.js';

// ============================================================================
// Registry
// ============================================================================

test('testBuiltinsRegistered', () => {
  assert(getWorkflow('full-build') !== undefined, 'full-build must be registered');
  assert(getWorkflow('draft-artifact') !== undefined, 'draft-artifact must be registered');
});

test('testUnknownWorkflowReturnsUndefined', () => {
  assert.equal(getWorkflow('non-existent-workflow'), undefined);
});

test('testRegisterUserWorkflow', () => {
  const custom: WorkflowDefinition = {
    id: 'my-custom-workflow',
    label: 'Custom',
    steps: [{ id: 'produce', kind: 'produce', agentRole: 'designer' }],
  };
  registerWorkflow(custom);
  assert.deepEqual(getWorkflow('my-custom-workflow'), custom);
});

test('testRegisterRejectsBuiltinId', () => {
  assert.throws(
    () => registerWorkflow({ id: 'full-build', label: 'X', steps: [] }),
    /reserved/,
  );
  assert.throws(
    () => registerWorkflow({ id: 'draft-artifact', label: 'X', steps: [] }),
    /reserved/,
  );
});

test('testListWorkflowIds', () => {
  const ids = listWorkflowIds();
  assert.ok(ids.includes('full-build'));
  assert.ok(ids.includes('draft-artifact'));
});

test('testBuiltinIdSet', () => {
  assert.ok(BUILTIN_IDS.has('full-build'));
  assert.ok(BUILTIN_IDS.has('draft-artifact'));
  assert.ok(!BUILTIN_IDS.has('something-else'));
});

// ============================================================================
// full-build definition integrity
// ============================================================================

test('testFullBuildStepCount', () => {
  // SCOPING decomposes to 3, plus DESIGN, CRITIQUE, PLAN, TEST, SHARDING_APPROVAL,
  // CONFIRM, BUILD, EXEC, VALIDATION_GATE, DEBUG, EVALUATE, SUMMARISE, SNAPSHOT = 16
  assert.equal(FULL_BUILD.steps.length, 16, `expected 16 steps, got ${FULL_BUILD.steps.length}`);
});

test('testFullBuildStepIds', () => {
  const ids = FULL_BUILD.steps.map(s => s.id);
  const required = [
    'scoping.gather', 'scoping.produce', 'scoping.checkpoint',
    'design', 'critique', 'plan', 'test',
    'sharding_approval', 'confirm',
    'build', 'exec', 'validation_gate',
    'debug', 'evaluate', 'summarise', 'snapshot',
  ];
  for (const id of required) {
    assert.ok(ids.includes(id), `full-build should have step '${id}'`);
  }
});

test('testFullBuildKinds', () => {
  const kindOf = (id: string) => FULL_BUILD.steps.find(s => s.id === id)?.kind;
  assert.equal(kindOf('scoping.gather'), 'gather');
  assert.equal(kindOf('scoping.produce'), 'produce');
  assert.equal(kindOf('scoping.checkpoint'), 'checkpoint');
  assert.equal(kindOf('design'), 'produce');
  assert.equal(kindOf('critique'), 'review');
  assert.equal(kindOf('plan'), 'produce');
  assert.equal(kindOf('test'), 'produce');
  assert.equal(kindOf('sharding_approval'), 'checkpoint');
  assert.equal(kindOf('confirm'), 'checkpoint');
  assert.equal(kindOf('build'), 'produce');
  assert.equal(kindOf('exec'), 'execute');
  assert.equal(kindOf('validation_gate'), 'review');
  assert.equal(kindOf('debug'), 'produce');
  assert.equal(kindOf('evaluate'), 'produce');
  assert.equal(kindOf('summarise'), 'produce');
  assert.equal(kindOf('snapshot'), 'commit');
});

test('testCritiqueHasSkipCondition', () => {
  const critique = FULL_BUILD.steps.find(s => s.id === 'critique');
  assert.ok(critique?.skip_if, 'critique must have a skip_if predicate');
  const ctx = { runId: 'r', workflowId: 'full-build', iteration: 1, revision: 0, planningDepth: 'minimal' as const };
  assert.equal(critique!.skip_if!(ctx), true, 'should skip at minimal depth');
  assert.equal(critique!.skip_if!({ ...ctx, planningDepth: 'standard' }), true, 'should skip at standard depth');
  assert.equal(critique!.skip_if!({ ...ctx, planningDepth: 'deep' }), false, 'should NOT skip at deep');
  assert.equal(critique!.skip_if!({ ...ctx, planningDepth: 'research' }), false, 'should NOT skip at research');
});

test('testValidationGateHasOnFail', () => {
  const vg = FULL_BUILD.steps.find(s => s.id === 'validation_gate');
  assert.ok(vg?.on_fail, 'validation_gate must have on_fail');
  assert.equal(vg!.on_fail!.target_step_id, 'debug');
  assert.equal(vg!.on_fail!.iteration_loop, true, 'validation_gate on_fail should set iteration_loop');
});

test('testSnapshotLogsDecision', () => {
  const snapshot = FULL_BUILD.steps.find(s => s.id === 'snapshot');
  assert.equal(snapshot?.logs_decision, true, 'snapshot step should have logs_decision: true (HISTORY folded in)');
});

test('testFullBuildMaxIterations', () => {
  assert.ok(typeof FULL_BUILD.max_iterations === 'number' && FULL_BUILD.max_iterations > 0);
});

// ============================================================================
// draft-artifact definition integrity
// ============================================================================

test('testDraftArtifactSteps', () => {
  const ids = DRAFT_ARTIFACT.steps.map(s => s.id);
  assert.ok(ids.includes('gather'), 'draft-artifact needs gather');
  assert.ok(ids.includes('produce'), 'draft-artifact needs produce');
  assert.ok(ids.includes('commit'), 'draft-artifact needs commit');
});

test('testDraftArtifactKinds', () => {
  const kindOf = (id: string) => DRAFT_ARTIFACT.steps.find(s => s.id === id)?.kind;
  assert.equal(kindOf('gather'), 'gather');
  assert.equal(kindOf('produce'), 'produce');
  assert.equal(kindOf('commit'), 'commit');
});

test('testStepCount', () => {
  assert.equal(stepCount('full-build'), FULL_BUILD.steps.length);
  assert.equal(stepCount('draft-artifact'), DRAFT_ARTIFACT.steps.length);
  assert.equal(stepCount('no-such-workflow'), 0);
});

// ============================================================================
// WorkflowEngine — runs via stub dependencies
// ============================================================================

function makeStubDeps(overrides: Partial<WorkflowEngineDeps> = {}): WorkflowEngineDeps {
  return {
    stepRunner: {
      run: async (_step: unknown, _ctx: unknown) => ({
        success: true,
        artifacts_written: [],
        tokens_used: 0,
        duration_ms: 1,
      }),
    } as any,
    mapManager: {
      read: async () => ({ cycle: { iteration: 1, max_iterations: 3 } }),
      update: async () => {},
    } as any,
    runArtifacts: {
      updateNodeStatus: async () => {},
      createRunDir: async () => {},
      createManifest: async () => {},
    } as any,
    projectRoot: '/tmp',
    ...overrides,
  };
}

function makeStubOpts(overrides: Partial<WorkflowEngineOptions> = {}): WorkflowEngineOptions {
  return {
    onCheckpoint: async () => 'approve',
    ...overrides,
  };
}

function makeSimpleWorkflow(steps: WorkflowDefinition['steps']): WorkflowDefinition {
  return { id: 'test-wf', label: 'Test', steps };
}

const DUMMY_CYCLE_CTX: any = {
  cycle_number: 1,
  cycle_id: 'cycle-1',
  iteration: 1,
  revision: 0,
  planning_depth: 'minimal',
  intent: 'Test',
  target: null,
  project_root: '/tmp',
};

test('testEngineRunsGatherStep', async () => {
  registerWorkflow(makeSimpleWorkflow([
    { id: 'g', kind: 'gather', label: 'Gather' },
  ]));

  const engine = new WorkflowEngine(makeStubDeps(), makeStubOpts());
  const result = await engine.run('test-wf', 1, 'c1', DUMMY_CYCLE_CTX);
  assert.equal(result.status, 'complete');
});

test('testEngineRunsProduceStep', async () => {
  registerWorkflow(makeSimpleWorkflow([
    { id: 'p', kind: 'produce', agentRole: 'designer' },
  ]));

  let called = false;
  const deps = makeStubDeps({
    stepRunner: {
      run: async () => { called = true; return { success: true, artifacts_written: [], tokens_used: 0, duration_ms: 1 }; },
    } as any,
  });

  const engine = new WorkflowEngine(deps, makeStubOpts());
  await engine.run('test-wf', 1, 'c1', DUMMY_CYCLE_CTX);
  assert.ok(called, 'stepRunner.run should have been called for produce step');
});

test('testEngineHaltsOnProduceFailure', async () => {
  registerWorkflow(makeSimpleWorkflow([
    { id: 'p', kind: 'produce', agentRole: 'designer' },
  ]));

  const deps = makeStubDeps({
    stepRunner: {
      run: async () => ({ success: false, artifacts_written: [], tokens_used: 0, duration_ms: 1, error: 'agent timeout' }),
    } as any,
  });

  const engine = new WorkflowEngine(deps, makeStubOpts());
  const result = await engine.run('test-wf', 1, 'c1', DUMMY_CYCLE_CTX);
  assert.equal(result.status, 'halted');
  assert.ok(result.error?.includes('agent timeout'));
});

test('testEngineSkipsConditionalStep', async () => {
  registerWorkflow(makeSimpleWorkflow([
    { id: 'p', kind: 'produce', agentRole: 'designer' },
    { id: 'r', kind: 'review', skip_if: () => true, on_fail: { target_step_id: 'p' } },
    { id: 'c', kind: 'commit' },
  ]));

  const visited: string[] = [];
  const deps = makeStubDeps({
    stepRunner: {
      run: async (step: any) => { visited.push(String(step.id)); return { success: true, artifacts_written: [], tokens_used: 0, duration_ms: 1 }; },
    } as any,
  });

  const engine = new WorkflowEngine(deps, makeStubOpts());
  await engine.run('test-wf', 1, 'c1', DUMMY_CYCLE_CTX);
  // 'r' is skipped — should not appear in stepRunner calls
  assert.ok(!visited.includes('r'), 'review step should have been skipped');
});

test('testEngineHaltsForUnknownWorkflow', async () => {
  const engine = new WorkflowEngine(makeStubDeps(), makeStubOpts());
  const result = await engine.run('definitely-not-registered', 1, 'c1', DUMMY_CYCLE_CTX);
  assert.equal(result.status, 'halted');
  assert.ok(result.error?.includes('Unknown workflow'));
});

test('testCheckpointHaltsPropagates', async () => {
  registerWorkflow(makeSimpleWorkflow([
    { id: 'cp', kind: 'checkpoint', label: 'Gate' },
    { id: 'p', kind: 'produce', agentRole: 'designer' },
  ]));

  const opts = makeStubOpts({ onCheckpoint: async () => 'halt' });
  const engine = new WorkflowEngine(makeStubDeps(), opts);
  const result = await engine.run('test-wf', 1, 'c1', DUMMY_CYCLE_CTX);
  assert.equal(result.status, 'halted');
  assert.equal(result.final_step_id, 'cp');
});

// ============================================================================
// WorkflowRun identity invariants
// ============================================================================

test('testEngineResultRunIdMatchesSuppliedId', async () => {
  registerWorkflow(makeSimpleWorkflow([
    { id: 'p', kind: 'produce', agentRole: 'designer' },
  ]));
  const engine = new WorkflowEngine(makeStubDeps(), makeStubOpts());
  const result = await engine.run('test-wf', 1, 'supplied-run-id-abc', DUMMY_CYCLE_CTX);
  assert.equal(result.run_id, 'supplied-run-id-abc', 'result.run_id must echo caller-supplied ID');
});

test('testEngineErrorResultRunIdMatchesSuppliedId', async () => {
  const engine = new WorkflowEngine(makeStubDeps(), makeStubOpts());
  const result = await engine.run('no-such-workflow', 1, 'canonical-xyz', DUMMY_CYCLE_CTX);
  assert.equal(result.run_id, 'canonical-xyz', 'error result must return caller-supplied ID, not a fresh UUID');
});

test('testEngineBadStartStepRunIdMatchesSuppliedId', async () => {
  registerWorkflow(makeSimpleWorkflow([
    { id: 'only-step', kind: 'produce', agentRole: 'designer' },
  ]));
  const engine = new WorkflowEngine(makeStubDeps(), makeStubOpts());
  const result = await engine.run('test-wf', 1, 'run-bad-step', DUMMY_CYCLE_CTX, 'nonexistent-step');
  assert.equal(result.run_id, 'run-bad-step', 'bad startStepId error must return caller-supplied ID');
});

test('testStepRunContextReceivesCanonicalWorkflowRunId', async () => {
  registerWorkflow(makeSimpleWorkflow([
    { id: 'p', kind: 'produce', agentRole: 'designer' },
  ]));
  const capturedIds: string[] = [];
  const deps = makeStubDeps({
    stepRunner: {
      run: async (_step: unknown, ctx: any) => {
        capturedIds.push(ctx.workflowRunId);
        return { success: true, artifacts_written: [], tokens_used: 0, duration_ms: 1 };
      },
    } as any,
  });
  const engine = new WorkflowEngine(deps, makeStubOpts());
  await engine.run('test-wf', 1, 'ctx-test-run-id', DUMMY_CYCLE_CTX);
  assert.equal(capturedIds.length, 1);
  assert.equal(capturedIds[0], 'ctx-test-run-id', 'StepRunContext.workflowRunId must equal caller-supplied ID');
});

test('testCheckpointCallbackReceivesCanonicalWorkflowRunId', async () => {
  registerWorkflow(makeSimpleWorkflow([
    { id: 'cp', kind: 'checkpoint', label: 'Gate' },
  ]));
  const capturedRunIds: string[] = [];
  const opts = makeStubOpts({
    onCheckpoint: async (runId) => { capturedRunIds.push(runId); return 'approve'; },
  });
  const engine = new WorkflowEngine(makeStubDeps(), opts);
  await engine.run('test-wf', 1, 'checkpoint-run-id', DUMMY_CYCLE_CTX);
  assert.equal(capturedRunIds.length, 1);
  assert.equal(capturedRunIds[0], 'checkpoint-run-id', 'onCheckpoint must receive canonical workflowRunId');
});

test('testTwoRunsProduceDifferentRunIds', async () => {
  registerWorkflow(makeSimpleWorkflow([
    { id: 'p', kind: 'produce', agentRole: 'designer' },
  ]));
  const engine = new WorkflowEngine(makeStubDeps(), makeStubOpts());
  const r1 = await engine.run('test-wf', 1, 'run-id-first', DUMMY_CYCLE_CTX);
  const r2 = await engine.run('test-wf', 1, 'run-id-second', DUMMY_CYCLE_CTX);
  assert.equal(r1.run_id, 'run-id-first');
  assert.equal(r2.run_id, 'run-id-second');
  assert.notEqual(r1.run_id, r2.run_id, 'two separate runs with distinct supplied IDs must not share a run_id');
});

test('testConfirmCheckpointApproveAdvances', async () => {
  registerWorkflow(makeSimpleWorkflow([
    { id: 'confirm', kind: 'checkpoint', label: 'CONFIRM' },
    { id: 'build', kind: 'produce', agentRole: 'builder' },
    { id: 'done', kind: 'commit' },
  ]));

  const visited: string[] = [];
  const deps = makeStubDeps({
    stepRunner: {
      run: async (step: any) => { visited.push(String(step.id)); return { success: true, artifacts_written: [], tokens_used: 0, duration_ms: 1 }; },
    } as any,
  });

  // Generic onCheckpoint 'approve' advances through all checkpoints, including 'confirm'.
  const engine = new WorkflowEngine(deps, makeStubOpts({ onCheckpoint: async () => 'approve' }));
  const result = await engine.run('test-wf', 1, 'c1', DUMMY_CYCLE_CTX);
  assert.equal(result.status, 'complete');
  assert.ok(visited.some(v => v === 'build'), 'build step should have run after CONFIRM approval');
});
