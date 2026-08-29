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

export function testBuiltinsRegistered() {
  assert(getWorkflow('full-build') !== undefined, 'full-build must be registered');
  assert(getWorkflow('draft-artifact') !== undefined, 'draft-artifact must be registered');
}

export function testUnknownWorkflowReturnsUndefined() {
  assert.equal(getWorkflow('non-existent-workflow'), undefined);
}

export function testRegisterUserWorkflow() {
  const custom: WorkflowDefinition = {
    id: 'my-custom-workflow',
    label: 'Custom',
    steps: [{ id: 'produce', kind: 'produce', agentRole: 'designer' }],
  };
  registerWorkflow(custom);
  assert.deepEqual(getWorkflow('my-custom-workflow'), custom);
}

export function testRegisterRejectsBuiltinId() {
  assert.throws(
    () => registerWorkflow({ id: 'full-build', label: 'X', steps: [] }),
    /reserved/,
  );
  assert.throws(
    () => registerWorkflow({ id: 'draft-artifact', label: 'X', steps: [] }),
    /reserved/,
  );
}

export function testListWorkflowIds() {
  const ids = listWorkflowIds();
  assert.ok(ids.includes('full-build'));
  assert.ok(ids.includes('draft-artifact'));
}

export function testBuiltinIdSet() {
  assert.ok(BUILTIN_IDS.has('full-build'));
  assert.ok(BUILTIN_IDS.has('draft-artifact'));
  assert.ok(!BUILTIN_IDS.has('something-else'));
}

// ============================================================================
// full-build definition integrity
// ============================================================================

export function testFullBuildStepCount() {
  // SCOPING decomposes to 3, plus DESIGN, CRITIQUE, PLAN, TEST, SHARDING_APPROVAL,
  // CONFIRM, BUILD, EXEC, VALIDATION_GATE, DEBUG, EVALUATE, SUMMARISE, SNAPSHOT = 16
  assert.equal(FULL_BUILD.steps.length, 16, `expected 16 steps, got ${FULL_BUILD.steps.length}`);
}

export function testFullBuildStepIds() {
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
}

export function testFullBuildKinds() {
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
}

export function testCritiqueHasSkipCondition() {
  const critique = FULL_BUILD.steps.find(s => s.id === 'critique');
  assert.ok(critique?.skip_if, 'critique must have a skip_if predicate');
  const ctx = { runId: 'r', workflowId: 'full-build', iteration: 1, revision: 0, planningDepth: 'minimal' as const };
  assert.equal(critique!.skip_if!(ctx), true, 'should skip at minimal depth');
  assert.equal(critique!.skip_if!({ ...ctx, planningDepth: 'standard' }), true, 'should skip at standard depth');
  assert.equal(critique!.skip_if!({ ...ctx, planningDepth: 'deep' }), false, 'should NOT skip at deep');
  assert.equal(critique!.skip_if!({ ...ctx, planningDepth: 'research' }), false, 'should NOT skip at research');
}

export function testValidationGateHasOnFail() {
  const vg = FULL_BUILD.steps.find(s => s.id === 'validation_gate');
  assert.ok(vg?.on_fail, 'validation_gate must have on_fail');
  assert.equal(vg!.on_fail!.target_step_id, 'debug');
  assert.equal(vg!.on_fail!.iteration_loop, true, 'validation_gate on_fail should set iteration_loop');
}

export function testSnapshotLogsDecision() {
  const snapshot = FULL_BUILD.steps.find(s => s.id === 'snapshot');
  assert.equal(snapshot?.logs_decision, true, 'snapshot step should have logs_decision: true (HISTORY folded in)');
}

export function testFullBuildMaxIterations() {
  assert.ok(typeof FULL_BUILD.max_iterations === 'number' && FULL_BUILD.max_iterations > 0);
}

// ============================================================================
// draft-artifact definition integrity
// ============================================================================

export function testDraftArtifactSteps() {
  const ids = DRAFT_ARTIFACT.steps.map(s => s.id);
  assert.ok(ids.includes('gather'), 'draft-artifact needs gather');
  assert.ok(ids.includes('produce'), 'draft-artifact needs produce');
  assert.ok(ids.includes('commit'), 'draft-artifact needs commit');
}

export function testDraftArtifactKinds() {
  const kindOf = (id: string) => DRAFT_ARTIFACT.steps.find(s => s.id === id)?.kind;
  assert.equal(kindOf('gather'), 'gather');
  assert.equal(kindOf('produce'), 'produce');
  assert.equal(kindOf('commit'), 'commit');
}

export function testStepCount() {
  assert.equal(stepCount('full-build'), FULL_BUILD.steps.length);
  assert.equal(stepCount('draft-artifact'), DRAFT_ARTIFACT.steps.length);
  assert.equal(stepCount('no-such-workflow'), 0);
}

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
    confirmService: {
      gate: async () => {},
      approve: async () => ({ next_node: 'BUILD' }),
      revise: async () => ({ next_node: 'TEST' }),
    } as any,
    execService: {
      run: async () => ({ next_node: 'VALIDATION_GATE' }),
    } as any,
    validationGateService: {
      run: async () => ({ passed: true, next_node: 'EVALUATE', failure_report: undefined }),
    } as any,
    snapshotService: {
      run: async () => ({ snapshot_dir: '/tmp/snap' }),
    } as any,
    summariseService: {
      run: async () => ({ success: true }),
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
    onConfirmGate: async () => 'approve',
    onShardingGate: async () => 'approve',
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

export async function testEngineRunsGatherStep() {
  registerWorkflow(makeSimpleWorkflow([
    { id: 'g', kind: 'gather', label: 'Gather' },
  ]));

  const engine = new WorkflowEngine(makeStubDeps(), makeStubOpts());
  const result = await engine.run('test-wf', 1, 'c1', DUMMY_CYCLE_CTX);
  assert.equal(result.status, 'complete');
}

export async function testEngineRunsProduceStep() {
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
}

export async function testEngineHaltsOnProduceFailure() {
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
}

export async function testEngineSkipsConditionalStep() {
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
    snapshotService: { run: async () => ({ snapshot_dir: '/tmp' }) } as any,
  });

  const engine = new WorkflowEngine(deps, makeStubOpts());
  await engine.run('test-wf', 1, 'c1', DUMMY_CYCLE_CTX);
  // 'r' is skipped — should not appear in stepRunner calls
  assert.ok(!visited.includes('r'), 'review step should have been skipped');
}

export async function testEngineHaltsForUnknownWorkflow() {
  const engine = new WorkflowEngine(makeStubDeps(), makeStubOpts());
  const result = await engine.run('definitely-not-registered', 1, 'c1', DUMMY_CYCLE_CTX);
  assert.equal(result.status, 'halted');
  assert.ok(result.error?.includes('Unknown workflow'));
}

export async function testCheckpointHaltsPropagates() {
  registerWorkflow(makeSimpleWorkflow([
    { id: 'cp', kind: 'checkpoint', label: 'Gate' },
    { id: 'p', kind: 'produce', agentRole: 'designer' },
  ]));

  const opts = makeStubOpts({ onCheckpoint: async () => 'halt' });
  const engine = new WorkflowEngine(makeStubDeps(), opts);
  const result = await engine.run('test-wf', 1, 'c1', DUMMY_CYCLE_CTX);
  assert.equal(result.status, 'halted');
  assert.equal(result.final_step_id, 'cp');
}

export async function testConfirmCheckpointApproveAdvances() {
  registerWorkflow(makeSimpleWorkflow([
    { id: 'confirm', kind: 'checkpoint', label: 'CONFIRM' },
    { id: 'build', kind: 'produce', agentRole: 'builder' },
    { id: 'snapshot', kind: 'commit', logs_decision: true },
  ]));

  const visited: string[] = [];
  const deps = makeStubDeps({
    stepRunner: {
      run: async (step: any) => { visited.push(String(step.id)); return { success: true, artifacts_written: [], tokens_used: 0, duration_ms: 1 }; },
    } as any,
    snapshotService: { run: async () => ({ snapshot_dir: '/tmp' }) } as any,
  });

  const engine = new WorkflowEngine(deps, makeStubOpts({ onConfirmGate: async () => 'approve' }));
  const result = await engine.run('test-wf', 1, 'c1', DUMMY_CYCLE_CTX);
  assert.equal(result.status, 'complete');
  // Build step should have been called with its step id 'build'
  assert.ok(visited.some(v => v === 'build'), 'build step should have run after CONFIRM approval');
}
