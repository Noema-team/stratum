// End-to-end proof: draft-artifact workflow runs on the generic engine with
// no DAGRunner, CycleRunner, AgentRunner, or stepToNodeId mappings.
//
// The StepRunner stub records which steps ran and what agentRole each received,
// proving that the engine passes step config (not legacy node IDs) to the runner.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { StratumAgentAdapter } from '../src/execution/stratum-agent-adapter.js';
import { DRAFT_ARTIFACT } from '../src/workflow/builtins/draft-artifact.js';
import type { WorkflowEngineDeps, WorkflowEngineOptions } from '../src/workflow/engine.js';
import type { StepRunner, StepRunOutcome, WorkflowStep, StepRunContext } from '../src/workflow/types.js';
import type { ExecutionRequest } from '../src/execution/types.js';
import { registerWorkflow, getWorkflow } from '../src/workflow/registry.js';

// Ensure draft-artifact is registered (it's registered on module load via builtins).
// getWorkflow returns undefined only if the id was never registered.
test('draft-artifact is registered in the workflow registry', () => {
  assert.ok(getWorkflow('draft-artifact') !== undefined);
});

function makeStubStepRunner(): { runner: StepRunner; calls: Array<{ stepId: string; agentRole?: string }> } {
  const calls: Array<{ stepId: string; agentRole?: string }> = [];
  const runner: StepRunner = {
    async run(step: WorkflowStep, _ctx: StepRunContext): Promise<StepRunOutcome> {
      calls.push({ stepId: step.id, agentRole: step.agentRole });
      return { success: true, artifacts_written: [], tokens_used: 0, duration_ms: 1 };
    },
  };
  return { runner, calls };
}

function makeEngineDeps(stepRunner: StepRunner): WorkflowEngineDeps {
  return {
    stepRunner,
    confirmService: { gate: async () => {}, approve: async () => ({ next_node: 'BUILD' }), revise: async () => ({ next_node: 'TEST', revision_count: 1 }) } as any,
    execService: { run: async () => ({ next_node: 'VALIDATION_GATE' }) } as any,
    validationGateService: { run: async () => ({ passed: true, next_node: 'EVALUATE' }) } as any,
    snapshotService: { run: async () => ({ snapshot_dir: '/tmp' }) } as any,
    summariseService: { run: async () => ({ success: true }) } as any,
    mapManager: { read: async () => ({ cycle: { iteration: 1, max_iterations: 3 } }), update: async () => {} } as any,
    runArtifacts: { updateNodeStatus: async () => {}, createRunDir: async () => {}, createManifest: async () => {} } as any,
    projectRoot: '/tmp',
  };
}

function makeEngineOpts(): WorkflowEngineOptions {
  return {
    onCheckpoint: async () => 'approve',
    onConfirmGate: async () => 'approve',
    onShardingGate: async () => 'approve',
  };
}

function makeRequest(partial: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return {
    stepExecutionId: 'se-1',
    workItemId: 'wi-1',
    workflowRunId: 'run-1',
    stepId: '__start__',
    workflowId: 'draft-artifact',
    repositories: [],
    goal: 'Write a hello world function',
    acceptanceCriteria: [{ description: 'Must return hello' }],
    constraints: [],
    permissions: { pushBranch: false, createPr: false, merge: false },
    budget: {},
    ...partial,
  };
}

test('draft-artifact: adapter runs to completion with stepRunner stub', async () => {
  const { runner, calls } = makeStubStepRunner();
  const adapter = new StratumAgentAdapter(makeEngineDeps(runner), makeEngineOpts());

  const result = await adapter.execute(makeRequest());

  assert.equal(result.outcome, 'succeeded', `Expected succeeded, got ${result.outcome}: ${result.failure?.message}`);
  assert.equal(result.schemaVersion, 1);
});

test('draft-artifact: engine calls stepRunner for produce step (not a legacy DAGNodeId)', async () => {
  const { runner, calls } = makeStubStepRunner();
  const adapter = new StratumAgentAdapter(makeEngineDeps(runner), makeEngineOpts());

  await adapter.execute(makeRequest());

  // The produce step must appear in calls with its actual step id 'produce',
  // not a DAGNodeId like 'DESIGN'.
  const produceCall = calls.find(c => c.stepId === 'produce');
  assert.ok(produceCall, `Expected a 'produce' step call; got calls: ${JSON.stringify(calls)}`);
  assert.equal(produceCall.agentRole, 'designer', 'produce step must carry agentRole from WorkflowStep config');

  // Confirm no legacy node IDs appear — the runner receives step objects, not strings.
  const legacyIds = ['DESIGN', 'BUILD', 'SCOPING', 'SNAPSHOT'];
  for (const id of legacyIds) {
    assert.ok(!calls.some(c => c.stepId === id), `Legacy DAGNodeId '${id}' must not reach stepRunner`);
  }
});

test('draft-artifact: only gather, produce, commit steps run', async () => {
  const { runner, calls } = makeStubStepRunner();
  const adapter = new StratumAgentAdapter(makeEngineDeps(runner), makeEngineOpts());

  await adapter.execute(makeRequest());

  // gather is no-op (no stepRunner call), produce and nothing else.
  const stepIds = calls.map(c => c.stepId);
  assert.ok(stepIds.includes('produce'), 'produce must run');
  // commit is a no-op commit step (no stepRunner call either)
  assert.ok(!stepIds.includes('gather'), 'gather is a no-op step — stepRunner must not be called');
  assert.ok(!stepIds.includes('commit'), 'commit is a no-op step — stepRunner must not be called');
});

test('draft-artifact: stepRunner failure halts workflow with failed outcome', async () => {
  const failRunner: StepRunner = {
    async run(_step, _ctx) {
      return { success: false, artifacts_written: [], tokens_used: 0, duration_ms: 1, error: 'model_timeout' };
    },
  };
  const adapter = new StratumAgentAdapter(makeEngineDeps(failRunner), makeEngineOpts());

  const result = await adapter.execute(makeRequest());

  assert.equal(result.outcome, 'failed');
  assert.ok(result.failure?.message?.includes('model_timeout'), `Expected model_timeout in failure: ${JSON.stringify(result.failure)}`);
});

test('draft-artifact: entry step derived from workflow definition (not hard-coded)', async () => {
  // Verify the adapter uses the first step from the workflow def as the entry,
  // even if request.stepId is the sentinel '__start__'.
  const { runner, calls } = makeStubStepRunner();
  const adapter = new StratumAgentAdapter(makeEngineDeps(runner), makeEngineOpts());

  // '__start__' is the sentinel meaning "use the workflow's first step"
  await adapter.execute(makeRequest({ stepId: '__start__' }));

  // First step of draft-artifact is 'gather' (kind: 'gather', no stepRunner call).
  // Confirm the produce step ran — proving the whole workflow sequence was executed.
  assert.ok(calls.some(c => c.stepId === 'produce'), 'produce must run when entry resolves from workflow def');
});
