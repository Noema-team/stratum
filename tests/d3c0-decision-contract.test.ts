// D.3c0 — generic dynamic Decision/checkpoint contract. Extends the
// existing checkpoint seam (WorkflowEngine -> checkpoint -> StratumAgentAdapter
// -> getCheckpointDecisionOptions -> static approve/reject) so a workflow can
// declaratively supply a validated dynamic DecisionRequest instead, while
// reusing the existing ExecutionResult.decisionRequests -> Scheduler ->
// Decision -> ResumeService lifecycle unchanged. See src/workflow/types.ts
// (WorkflowStep.decisionRequestArtifact, DecisionContext),
// src/execution/decision-request.ts (structural validation),
// src/execution/stratum-agent-adapter.ts (read/validate/fail-closed), and
// src/services/resume-service.ts (DecisionContext construction+threading).
//
// Every workflow/step id here is synthetic and unfamiliar — this proves the
// mechanism generically, never via define-work or any HUMAN_DECISION-
// specific branch (WorkflowEngine itself is untouched by any of this).
//
// Part A: dynamic DecisionRequest at the adapter boundary — reaches
//         ExecutionResult unchanged; malformed/missing/duplicate-id/empty-
//         options payloads fail closed; a non-opt-in checkpoint (including
//         full-build) is byte-for-byte unchanged.
// Part B: DecisionContext threading — ResumeService constructs it from the
//         resolved Decision and threads it to a resumed continuation step
//         only when that step opts in; Scheduler's initial dispatch never
//         has one; existing strict linkage/idempotency guards are unweakened.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { StratumAgentAdapter } from '../src/execution/stratum-agent-adapter.js';
import { getCheckpointDecisionOptions } from '../src/execution/checkpoint-resolver.js';
import { parseDecisionRequest } from '../src/execution/decision-request.js';
import { ExecutorRegistry } from '../src/execution/registry.js';
import { Scheduler } from '../src/scheduler/scheduler.js';
import { ResumeService, ResumeServiceError } from '../src/services/resume-service.js';
import { registerWorkflow, getWorkflow } from '../src/workflow/registry.js';
import { openDatabase } from '../src/storage/database.js';
import {
  WorkspaceRepository,
  ProjectRepository,
  WorkItemRepository,
  DecisionRepository,
  WorkflowRunRepository,
  StepExecutionRepository,
} from '../src/storage/repositories.js';
import type { WorkflowEngineDeps, WorkflowEngineOptions } from '../src/workflow/engine.js';
import type { StepRunner, StepRunContext, StepRunOutcome, DecisionContext } from '../src/workflow/types.js';
import type { ExecutionAdapter, ExecutionRequest, ExecutionResult } from '../src/execution/types.js';
import type { WorkItem } from '../src/domain/index.js';
import { ContextManager, DEFAULT_CONFIG } from '../src/context-manager.js';

// ============================================================================
// Part A — dynamic DecisionRequest at the adapter boundary
// ============================================================================

const D3C0_DYNAMIC_WF = `d3c0-dynamic-checkpoint-${randomUUID()}`;
registerWorkflow({
  id: D3C0_DYNAMIC_WF,
  label: 'D.3c0 dynamic checkpoint harness',
  steps: [
    { id: 'produce-request', kind: 'produce', agentRole: 'explorer' },
    {
      id: 'gate',
      kind: 'checkpoint',
      decisionRequestArtifact: '.sle/work/{workItemId}/decision-request.json',
    },
    { id: 'after', kind: 'produce', agentRole: 'explorer' },
  ],
});

const D3C0_GENERIC_WF = `d3c0-generic-checkpoint-${randomUUID()}`;
registerWorkflow({
  id: D3C0_GENERIC_WF,
  label: 'D.3c0 generic (non-opt-in) checkpoint harness',
  steps: [
    { id: 'gate', kind: 'checkpoint' }, // no decisionRequestArtifact — must behave exactly as before
    { id: 'after', kind: 'produce', agentRole: 'explorer' },
  ],
});

class NeverRunStepRunner implements StepRunner {
  async run(): Promise<StepRunOutcome> {
    throw new Error('run() should not be called in these checkpoint-focused tests');
  }
}

function makeAdapter(projectRoot: string): StratumAgentAdapter {
  const engineDeps: WorkflowEngineDeps = {
    stepRunner: new NeverRunStepRunner(),
    mapManager: { read: async () => ({ artifacts: [] }), update: async () => {} } as any,
    runArtifacts: {
      updateNodeStatus: async () => {}, createRunDir: async () => {}, createManifest: async () => {},
    } as any,
    projectRoot,
  };
  // Matches production wiring (application.ts): the inline callback always
  // halts — real resolutions come via ResumeService.
  const engineOpts: WorkflowEngineOptions = { onCheckpoint: async () => 'halt' };
  return new StratumAgentAdapter(engineDeps, engineOpts);
}

function makeRequest(overrides: Partial<ExecutionRequest>): ExecutionRequest {
  return {
    stepExecutionId: 'se-1',
    workItemId: 'wi-1',
    workflowRunId: `run-${Math.random().toString(36).slice(2)}`,
    stepId: 'gate',
    workflowId: D3C0_DYNAMIC_WF,
    repositories: [],
    goal: 'D.3c0 checkpoint test',
    acceptanceCriteria: [],
    constraints: [],
    permissions: { pushBranch: false, createPr: false, merge: false },
    budget: {},
    ...overrides,
  };
}

const AUTHORITY_MODEL_REQUEST = {
  type: 'human_decision',
  title: 'Which authority model should multiplayer use?',
  summary: 'The candidate synchronization approach needs a network authority model before Definition can be ready.',
  options: [
    { id: 'server-authoritative', label: 'Server-authoritative', description: 'Route all game state through a dedicated server for highest consistency.' },
    { id: 'host-authoritative', label: 'Host-authoritative', description: 'One player\'s client is authoritative — cheaper, less consistent.' },
    { id: 'peer-to-peer', label: 'Peer-to-peer', description: 'No single authority — hardest to keep consistent, no hosting cost.' },
  ],
};

async function writeDecisionRequest(root: string, workItemId: string, content: unknown): Promise<void> {
  const dir = path.join(root, '.sle', 'work', workItemId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'decision-request.json'), JSON.stringify(content), 'utf-8');
}

test('D.3c0: a valid dynamic DecisionRequest reaches ExecutionResult unchanged', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'd3c0-dynamic-'));
  try {
    await writeDecisionRequest(root, 'wi-1', AUTHORITY_MODEL_REQUEST);
    const adapter = makeAdapter(root);

    const result = await adapter.execute(makeRequest({}));

    assert.equal(result.outcome, 'blocked', `expected blocked, got: ${result.outcome} (${result.failure?.message})`);
    assert.equal(result.checkpointStepId, 'gate');
    assert.equal(result.decisionRequests.length, 1);
    assert.deepStrictEqual(result.decisionRequests[0], AUTHORITY_MODEL_REQUEST);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('D.3c0: a malformed DecisionRequest payload fails closed before any Decision could be created', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'd3c0-malformed-'));
  try {
    // Missing 'summary' — structurally invalid.
    await writeDecisionRequest(root, 'wi-1', {
      type: 'human_decision', title: 'X', options: [{ id: 'a', label: 'A', description: 'a' }],
    });
    const adapter = makeAdapter(root);

    const result = await adapter.execute(makeRequest({}));

    assert.equal(result.outcome, 'failed');
    assert.equal(result.checkpointStepId, undefined, 'no checkpoint must be reported for a failed dynamic request');
    assert.deepStrictEqual(result.decisionRequests, []);
    assert.equal(result.failure?.code, 'invalid_decision_request');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('D.3c0: a missing declared DecisionRequest artifact fails closed', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'd3c0-missing-'));
  try {
    // Never written.
    const adapter = makeAdapter(root);

    const result = await adapter.execute(makeRequest({}));

    assert.equal(result.outcome, 'failed');
    assert.deepStrictEqual(result.decisionRequests, []);
    assert.equal(result.failure?.code, 'missing_decision_request');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('D.3c0: duplicate option ids in a DecisionRequest fail closed', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'd3c0-dupids-'));
  try {
    await writeDecisionRequest(root, 'wi-1', {
      type: 'human_decision', title: 'X', summary: 'Y',
      options: [
        { id: 'same', label: 'A', description: 'a' },
        { id: 'same', label: 'B', description: 'b' },
      ],
    });
    const adapter = makeAdapter(root);

    const result = await adapter.execute(makeRequest({}));

    assert.equal(result.outcome, 'failed');
    assert.equal(result.failure?.code, 'invalid_decision_request');
    assert.match(result.failure?.message ?? '', /unique/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('D.3c0: an empty options list in a DecisionRequest fails closed', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'd3c0-emptyopts-'));
  try {
    await writeDecisionRequest(root, 'wi-1', { type: 'human_decision', title: 'X', summary: 'Y', options: [] });
    const adapter = makeAdapter(root);

    const result = await adapter.execute(makeRequest({}));

    assert.equal(result.outcome, 'failed');
    assert.equal(result.failure?.code, 'invalid_decision_request');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('D.3c0: an option with an empty id/label/description fails closed', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'd3c0-emptyfield-'));
  try {
    await writeDecisionRequest(root, 'wi-1', {
      type: 'human_decision', title: 'X', summary: 'Y',
      options: [{ id: 'a', label: '', description: 'a' }],
    });
    const adapter = makeAdapter(root);

    const result = await adapter.execute(makeRequest({}));

    assert.equal(result.outcome, 'failed');
    assert.equal(result.failure?.code, 'invalid_decision_request');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('parseDecisionRequest: malformed JSON fails closed with a clear reason', () => {
  const result = parseDecisionRequest('{not json');
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /Malformed DecisionRequest JSON/);
});

test('D.3c0: a non-opt-in generic checkpoint still gets exactly the current static approve/reject behavior', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'd3c0-generic-'));
  try {
    const adapter = makeAdapter(root);

    const result = await adapter.execute(makeRequest({ workflowId: D3C0_GENERIC_WF, stepId: 'gate' }));

    assert.equal(result.outcome, 'blocked', result.failure?.message);
    assert.equal(result.checkpointStepId, 'gate');
    assert.deepStrictEqual(result.decisionRequests, [{
      type: 'checkpoint',
      title: 'Workflow paused',
      summary: 'Waiting at step: gate',
      options: getCheckpointDecisionOptions(D3C0_GENERIC_WF, 'gate'),
    }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('D.3c0: full-build never declares decisionRequestArtifact — its checkpoint behavior is structurally unchanged', () => {
  const fullBuild = getWorkflow('full-build');
  assert.ok(fullBuild, 'full-build must still be registered');
  const checkpointSteps = fullBuild!.steps.filter((s) => s.kind === 'checkpoint');
  assert.ok(checkpointSteps.length > 0, 'sanity: full-build has at least one checkpoint step');
  for (const step of checkpointSteps) {
    assert.equal(
      step.decisionRequestArtifact, undefined,
      `full-build step '${step.id}' must not opt into the dynamic mechanism — its checkpoint behavior must stay exactly the static approve/reject path`,
    );
  }
});

// ============================================================================
// Part B — DecisionContext threading (ResumeService continuation only)
// ============================================================================

const D3C0_RESUME_WF = `d3c0-resume-harness-${randomUUID()}`;
registerWorkflow({
  id: D3C0_RESUME_WF,
  label: 'D.3c0 resume harness',
  steps: [
    { id: 'snap', kind: 'produce', agentRole: 'designer' },
    { id: 'ck', kind: 'checkpoint', label: 'Gate' }, // generic — proves DecisionContext threading is independent of Part A's dynamic-request mechanism
    { id: 'after-decision', kind: 'produce', agentRole: 'builder', includeDecisionContext: true },
  ],
});

class CapturingStepRunner implements StepRunner {
  calls: Array<{ stepId: string; ctx: StepRunContext }> = [];
  async run(step: { id: string }, ctx: StepRunContext): Promise<StepRunOutcome> {
    this.calls.push({ stepId: step.id, ctx });
    return { success: true, artifacts_written: [], tokens_used: 0, duration_ms: 1 };
  }
}

function makeResumeAdapter(stepRunner: StepRunner): StratumAgentAdapter {
  const engineDeps: WorkflowEngineDeps = {
    stepRunner,
    mapManager: { read: async () => ({ artifacts: [] }), update: async () => {} } as any,
    runArtifacts: {
      updateNodeStatus: async () => {}, createRunDir: async () => {}, createManifest: async () => {},
    } as any,
  };
  const engineOpts: WorkflowEngineOptions = { onCheckpoint: async () => 'halt' };
  return new StratumAgentAdapter(engineDeps, engineOpts);
}

function openDb() { return openDatabase(':memory:'); }
const NOW = new Date().toISOString();

function seedWorld(db: ReturnType<typeof openDb>, workflowId: string) {
  const wsRepo = new WorkspaceRepository(db);
  const projRepo = new ProjectRepository(db);
  const wiRepo = new WorkItemRepository(db);
  const ws = { id: randomUUID(), name: 'd3c0-ws', createdAt: NOW };
  wsRepo.save(ws);
  const proj = { id: randomUUID(), workspaceId: ws.id, name: 'p', status: 'active' as const, priority: 0, createdAt: NOW, updatedAt: NOW };
  projRepo.save(proj);
  const wi: WorkItem = {
    id: randomUUID(), projectId: proj.id, repositoryIds: [],
    title: 't', goal: 'Decide the multiplayer authority model', workflowId,
    state: 'ready', priority: 0,
    acceptanceCriteria: [], constraints: [], requiredEvidence: [],
    dependencies: [], createdAt: NOW, updatedAt: NOW,
  };
  wiRepo.save(wi);
  return { ws, proj, wi };
}

function seedHaltedRun(db: ReturnType<typeof openDb>, workspaceId: string, workItemId: string, workflowId: string, projectId: string) {
  const workflowRunId = randomUUID();
  const decisionId = randomUUID();
  const runRepo = new WorkflowRunRepository(db);
  const decRepo = new DecisionRepository(db);
  const stepExecRepo = new StepExecutionRepository(db);
  const wiRepo = new WorkItemRepository(db);

  runRepo.createOrValidate({
    run_id: workflowRunId, workflow_id: workflowId, work_item_id: workItemId,
    status: 'halted', current_step_id: 'ck', awaiting_checkpoint: 'ck',
    iteration: 1, revision: 0, started_at: NOW, updated_at: NOW,
  });
  wiRepo.updateState(workItemId, 'needs_decision', NOW);
  decRepo.save({
    id: decisionId, projectId, workItemId, type: 'checkpoint',
    subjectRef: { workflowRunId, workItemId, stepId: 'ck' },
    title: 'Which authority model should multiplayer use?',
    summary: 'Halted at ck',
    options: [
      { id: 'server-authoritative', label: 'Server-authoritative', description: 'Route through a dedicated server.' },
      { id: 'host-authoritative', label: 'Host-authoritative', description: 'One client is authoritative.' },
    ],
    impact: 'medium', reversibility: 'medium', urgency: 'normal', status: 'pending',
  });
  stepExecRepo.save({
    id: randomUUID(), workItemId, workflowRunId, stepId: 'ck', executor: 'test',
    state: 'waiting', attempt: 1, startedAt: NOW,
  });
  return { decisionId, workflowRunId };
}

test('D.3c0: the human\'s selectedOptionId + rationale reach an opted-in resumed step as DecisionContext', async () => {
  const db = openDb();
  const { ws, proj, wi } = seedWorld(db, D3C0_RESUME_WF);
  const { decisionId } = seedHaltedRun(db, ws.id, wi.id, D3C0_RESUME_WF, proj.id);

  const capturing = new CapturingStepRunner();
  const adapter = makeResumeAdapter(capturing);
  const registry = new ExecutorRegistry();
  registry.register(adapter);

  const svc = new ResumeService(db, ws.id, registry);
  const resolvedAt = new Date().toISOString();
  await svc.resume(decisionId, {
    selectedOptionId: 'server-authoritative',
    rationale: 'Consistency matters more than hosting cost for this increment.',
    resolvedAt,
    resolvedBy: 'reviewer@example.com',
  });

  const afterCall = capturing.calls.find((c) => c.stepId === 'after-decision');
  assert.ok(afterCall, `expected the continuation step to run; calls: ${capturing.calls.map(c => c.stepId).join(', ')}`);
  const expected: DecisionContext = {
    decisionId,
    selectedOptionId: 'server-authoritative',
    selectedOptionLabel: 'Server-authoritative',
    rationale: 'Consistency matters more than hosting cost for this increment.',
    resolvedAt,
    resolvedBy: 'reviewer@example.com',
  };
  assert.deepStrictEqual(afterCall!.ctx.decisionContext, expected);
});

test('D.3c0: DecisionContext is absent on initial Scheduler dispatch', async () => {
  const db = openDb();
  const { ws, wi } = seedWorld(db, 'draft-artifact');

  let captured: ExecutionRequest | undefined;
  const adapter: ExecutionAdapter = {
    id: 'stratum-agent',
    getCapabilities: () => new Set(['repo.read']) as any,
    async execute(req: ExecutionRequest): Promise<ExecutionResult> {
      captured = req;
      return {
        schemaVersion: 1, stepExecutionId: req.stepExecutionId, outcome: 'succeeded',
        artifacts: [], evidenceClaims: [], decisionRequests: [], usage: { durationMs: 1 },
      };
    },
  };
  const registry = new ExecutorRegistry();
  registry.register(adapter);
  const scheduler = new Scheduler(db, ws.id, registry);
  const results = await scheduler.tick();

  assert.equal(results[0].outcome, 'dispatched');
  assert.equal(captured?.decisionContext, undefined, 'initial dispatch must never carry a DecisionContext');
  void wi;
});

test('D.3c0: DecisionContext is not rendered into the assembled context without includeDecisionContext', async () => {
  const root = '/project-d3c0';
  const mockFsModule = {
    mkdir: async () => {}, writeFile: async () => {}, appendFile: async () => {},
    readFile: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
  } as unknown as typeof import('fs').promises;
  const cm = new ContextManager(root, DEFAULT_CONFIG, mockFsModule);

  const decisionContext: DecisionContext = {
    decisionId: 'dec-1', selectedOptionId: 'server-authoritative', selectedOptionLabel: 'Server-authoritative',
  };

  const result = await cm.assemble('explorer', {
    workflowRunId: 'r1', workflowId: 'd3c0-render-test', stepId: 'after-decision',
    iteration: 1, revision: 0, goal: 'test', projectRoot: root,
    // includeDecisionContext intentionally omitted
    decisionContext,
  } as any);

  assert.ok(!result.task.includes('## Human Decision'));
  assert.ok(!result.task.includes('Server-authoritative'));
});

test('D.3c0: includeDecisionContext renders the resolved decision under its own header', async () => {
  const root = '/project-d3c0';
  const mockFsModule = {
    mkdir: async () => {}, writeFile: async () => {}, appendFile: async () => {},
    readFile: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
  } as unknown as typeof import('fs').promises;
  const cm = new ContextManager(root, DEFAULT_CONFIG, mockFsModule);

  const decisionContext: DecisionContext = {
    decisionId: 'dec-1', selectedOptionId: 'server-authoritative', selectedOptionLabel: 'Server-authoritative',
    rationale: 'Consistency wins here.', resolvedBy: 'reviewer@example.com', resolvedAt: '2026-01-01T00:00:00.000Z',
  };

  const result = await cm.assemble('explorer', {
    workflowRunId: 'r1', workflowId: 'd3c0-render-test', stepId: 'after-decision',
    iteration: 1, revision: 0, goal: 'test', projectRoot: root,
    includeDecisionContext: true,
    decisionContext,
  } as any);

  assert.ok(result.task.includes('## Human Decision'));
  assert.ok(result.task.includes('Server-authoritative'));
  assert.ok(result.task.includes('Consistency wins here.'));
});

test('D.3c0: invalid cross-linked checkpoint resume remains rejected by the existing strict linkage checks', async () => {
  const db = openDb();
  const { ws, proj, wi } = seedWorld(db, D3C0_RESUME_WF);
  const { decisionId } = seedHaltedRun(db, ws.id, wi.id, D3C0_RESUME_WF, proj.id);

  // Seed a second, real WorkItem so the corrupted foreign key still points
  // at something that exists (renaming wi's own id would violate the FK
  // constraints other rows already hold on it).
  const other: WorkItem = {
    id: randomUUID(), projectId: proj.id, repositoryIds: [],
    title: 'other', goal: 'unrelated', workflowId: D3C0_RESUME_WF,
    state: 'ready', priority: 0,
    acceptanceCriteria: [], constraints: [], requiredEvidence: [],
    dependencies: [], createdAt: NOW, updatedAt: NOW,
  };
  new WorkItemRepository(db).save(other);

  // Corrupt the linkage: point the WorkflowRun at a different WorkItem than
  // the Decision references.
  db.prepare('UPDATE workflow_runs SET work_item_id = ? WHERE work_item_id = ?').run(other.id, wi.id);

  const capturing = new CapturingStepRunner();
  const adapter = makeResumeAdapter(capturing);
  const registry = new ExecutorRegistry();
  registry.register(adapter);
  const svc = new ResumeService(db, ws.id, registry);

  await assert.rejects(
    () => svc.resume(decisionId, { selectedOptionId: 'server-authoritative', resolvedAt: NOW }),
    (err: unknown) => {
      assert.ok(err instanceof ResumeServiceError);
      assert.equal((err as ResumeServiceError).code, 'WORK_ITEM_MISMATCH');
      return true;
    },
  );
  assert.equal(capturing.calls.length, 0, 'the continuation must never run when linkage validation rejects the resume');
});

test('D.3c0: resuming an already-resolved Decision twice remains rejected (idempotency unweakened)', async () => {
  const db = openDb();
  const { ws, proj, wi } = seedWorld(db, D3C0_RESUME_WF);
  const { decisionId } = seedHaltedRun(db, ws.id, wi.id, D3C0_RESUME_WF, proj.id);

  const capturing = new CapturingStepRunner();
  const adapter = makeResumeAdapter(capturing);
  const registry = new ExecutorRegistry();
  registry.register(adapter);
  const svc = new ResumeService(db, ws.id, registry);

  await svc.resume(decisionId, { selectedOptionId: 'server-authoritative', resolvedAt: NOW });
  assert.equal(capturing.calls.filter((c) => c.stepId === 'after-decision').length, 1);

  await assert.rejects(
    () => svc.resume(decisionId, { selectedOptionId: 'server-authoritative', resolvedAt: NOW }),
    (err: unknown) => {
      assert.ok(err instanceof ResumeServiceError);
      assert.equal((err as ResumeServiceError).code, 'ALREADY_RESOLVED');
      return true;
    },
  );
  // No second continuation execution.
  assert.equal(capturing.calls.filter((c) => c.stepId === 'after-decision').length, 1);
});
