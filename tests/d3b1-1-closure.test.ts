// D.3b1.1 — closure pass fixing four review-identified blockers in the
// D.3b1 architecture (accepted, but not yet closed): a Git-tracked-symlink
// read escape, a production LLM factory that could never actually reach
// AgentLoop's multi-turn path, Objective human intent never reaching
// execution context, and define-work's instructions depending on a
// Stratum-repo-only doc path. See src/tools.ts, src/llm-provider.ts,
// src/execution/dispatch-primitive.ts, and
// src/workflow/methodology/definition-readiness.ts.
//
// The D.3b1.1 factory-level multi-turn regression (Item 2) lives in
// tests/llm-provider.test.ts, next to the existing createLLMProvider type
// tests it extends.
//
// Part A: symlink-safe read authority (src/tools.ts) — real filesystem,
//         real git, real symlinks. The secret target must never be
//         returned in any of the three deny cases.
// Part B: Objective human-intent threading — resolveObjectiveContext unit
//         behavior, Scheduler and ResumeService regressions proving
//         objectiveContext reaches ExecutionRequest and that dispatch/
//         resume fails closed before execution when it cannot be resolved,
//         and a ContextManager rendering test proving the Objective section
//         is visibly separate from the WorkItem section.
// Part C: the combined end-to-end proof — Objective intent reaches
//         synthesis, synthesis takes the multi-turn path and reads a
//         Git-tracked repository file, the resulting Definition records the
//         observed fact as KNOWN/source: repository, the readiness review
//         stays on the single-turn requiresReviewVerdict path and passes,
//         and the run commits.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { handleToolCall, listGitTrackedFiles } from '../src/tools.js';
import { ContextManager, DEFAULT_CONFIG } from '../src/context-manager.js';
import { AgentRunner } from '../src/agent-runner.js';
import { AgentStepRunner } from '../src/execution/agent-step-runner.js';
import { WorkflowEngine, registerWorkflow } from '../src/workflow/index.js';
import { DynamicLLMProvider } from '../src/llm-provider.js';
import { openDatabase } from '../src/storage/database.js';
import {
  ArtifactRepository,
  WorkspaceRepository,
  ProjectRepository,
  WorkItemRepository,
  ObjectiveRepository,
  WorkflowRunRepository,
  DecisionRepository,
  StepExecutionRepository,
} from '../src/storage/repositories.js';
import { ExecutorRegistry } from '../src/execution/registry.js';
import { Scheduler } from '../src/scheduler/scheduler.js';
import { ResumeService } from '../src/services/resume-service.js';
import { resolveObjectiveContext } from '../src/execution/dispatch-primitive.js';
import type { WorkflowEngineDeps, WorkflowEngineOptions, StepRunContext } from '../src/workflow/types.js';
import type { ExecutionAdapter, ExecutionRequest, ExecutionResult } from '../src/execution/types.js';
import type { ILLMProvider, LLMCompletionParams, LLMCompletionResult } from '../src/llm-provider.js';
import type { IMultiTurnProvider, MultiTurnParams, MultiTurnResult, ToolUseBlock } from '../src/agent-loop.js';
import type { Objective, WorkItem } from '../src/domain/index.js';

// ============================================================================
// Part A — symlink-safe read authority (real fs, real git, real symlinks)
// ============================================================================

function gitInit(root: string): void {
  execFileSync('git', ['init', '-q'], { cwd: root });
}
function gitAdd(root: string, ...paths: string[]): void {
  execFileSync('git', ['add', ...paths], { cwd: root });
}

test('D.3b1.1: a Git-tracked symlink pointing outside the project root is denied — the secret target must never be returned', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'd3b1-1-symlink-outside-'));
  const outside = mkdtempSync(path.join(tmpdir(), 'd3b1-1-outside-'));
  try {
    const secretPath = path.join(outside, 'secret.txt');
    await fs.writeFile(secretPath, 'TOP SECRET — outside the repository entirely', 'utf-8');

    gitInit(root);
    await fs.symlink(secretPath, path.join(root, 'escape.txt'));
    gitAdd(root, 'escape.txt');

    const trackedFiles = new Set(await listGitTrackedFiles(root));
    assert.ok(trackedFiles.has('escape.txt'), 'sanity: the symlink itself must be tracked');

    const result = await handleToolCall('read_file', { path: 'escape.txt' }, root, fs, trackedFiles);
    assert.ok(!result.content.includes('TOP SECRET'), 'the secret target must never be returned');
    assert.deepStrictEqual(JSON.parse(result.content), { error: 'path not permitted' });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('D.3b1.1: a Git-tracked symlink to untracked content (.env) inside the repo is denied — the secret target must never be returned', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'd3b1-1-symlink-env-'));
  try {
    gitInit(root);
    // Deliberately untracked — never added to git.
    await fs.writeFile(path.join(root, '.env'), 'SECRET=do-not-read-me', 'utf-8');
    await fs.symlink(path.join(root, '.env'), path.join(root, 'link-to-env.txt'));
    gitAdd(root, 'link-to-env.txt');

    const trackedFiles = new Set(await listGitTrackedFiles(root));
    assert.ok(trackedFiles.has('link-to-env.txt'), 'sanity: the symlink itself must be tracked');
    assert.ok(!trackedFiles.has('.env'), 'sanity: the real target must NOT be tracked');

    const result = await handleToolCall('read_file', { path: 'link-to-env.txt' }, root, fs, trackedFiles);
    assert.ok(!result.content.includes('do-not-read-me'), 'the secret target must never be returned');
    assert.deepStrictEqual(JSON.parse(result.content), { error: 'path not permitted' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('D.3b1.1: a tracked path whose parent directory has been replaced by a symlink on disk is denied — the secret target must never be returned', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'd3b1-1-symlink-parent-'));
  const attackerTarget = mkdtempSync(path.join(tmpdir(), 'd3b1-1-attacker-'));
  try {
    gitInit(root);
    await fs.mkdir(path.join(root, 'subdir'));
    await fs.writeFile(path.join(root, 'subdir', 'file.txt'), 'normal tracked content', 'utf-8');
    gitAdd(root, 'subdir/file.txt');

    // The index still lists subdir/file.txt as tracked, even after subdir
    // itself is replaced on disk below — this is exactly the scenario the
    // lexical-only check could not catch.
    const trackedFiles = new Set(await listGitTrackedFiles(root));
    assert.ok(trackedFiles.has('subdir/file.txt'), 'sanity: the path must be tracked');

    await fs.rm(path.join(root, 'subdir'), { recursive: true, force: true });
    await fs.writeFile(path.join(attackerTarget, 'file.txt'), 'TOP SECRET — attacker-controlled content', 'utf-8');
    await fs.symlink(attackerTarget, path.join(root, 'subdir'));

    const result = await handleToolCall('read_file', { path: 'subdir/file.txt' }, root, fs, trackedFiles);
    assert.ok(!result.content.includes('TOP SECRET'), 'the secret target must never be returned');
    assert.deepStrictEqual(JSON.parse(result.content), { error: 'path not permitted' });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(attackerTarget, { recursive: true, force: true });
  }
});

test('D.3b1.1: a Git-tracked symlink to another Git-tracked file is still readable (containment + tracked-target both hold)', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'd3b1-1-symlink-legit-'));
  try {
    gitInit(root);
    await fs.writeFile(path.join(root, 'real.txt'), 'hello from real.txt', 'utf-8');
    await fs.symlink(path.join(root, 'real.txt'), path.join(root, 'alias.txt'));
    gitAdd(root, 'real.txt', 'alias.txt');

    const trackedFiles = new Set(await listGitTrackedFiles(root));
    const result = await handleToolCall('read_file', { path: 'alias.txt' }, root, fs, trackedFiles);
    assert.equal(result.content, 'hello from real.txt');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// Part B — Objective human-intent threading
// ============================================================================

function makeObjective(projectId: string, overrides: Partial<Objective> = {}): Objective {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    projectId,
    title: 'Add real-time multiplayer to Evershift',
    description: 'Players can join and play a shared Evershift session together in real time.',
    priority: 0,
    status: 'active',
    constraints: [{ description: 'Must stay same-platform for this increment', type: 'must' }],
    successCriteria: [{ description: 'Two players can join and play a session together' }],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeWorkItem(projectId: string, overrides: Partial<WorkItem> = {}): WorkItem {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    projectId,
    repositoryIds: [],
    title: 'Define the increment',
    goal: 'Define the next bounded increment',
    workflowId: 'define-work',
    state: 'ready',
    priority: 0,
    acceptanceCriteria: [],
    constraints: [],
    requiredEvidence: [],
    dependencies: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function seedWorkspaceAndProject(db: ReturnType<typeof openDatabase>) {
  const now = new Date().toISOString();
  const ws = { id: randomUUID(), name: 'ws', createdAt: now };
  new WorkspaceRepository(db).save(ws);
  const project = {
    id: randomUUID(), workspaceId: ws.id, name: 'proj', status: 'active' as const,
    priority: 0, createdAt: now, updatedAt: now,
  };
  new ProjectRepository(db).save(project);
  return { ws, project };
}

// -- resolveObjectiveContext: the shared primitive itself --------------------

test('D.3b1.1: resolveObjectiveContext returns undefined when the WorkItem has no objectiveId', () => {
  const db = openDatabase(':memory:');
  const { project } = seedWorkspaceAndProject(db);
  const objectiveRepo = new ObjectiveRepository(db);
  assert.equal(resolveObjectiveContext(undefined, project.id, objectiveRepo), undefined);
});

test('D.3b1.1: resolveObjectiveContext returns the Objective\'s own human intent as an immutable snapshot', () => {
  const db = openDatabase(':memory:');
  const { project } = seedWorkspaceAndProject(db);
  const objectiveRepo = new ObjectiveRepository(db);
  const objective = makeObjective(project.id);
  objectiveRepo.save(objective);

  const snapshot = resolveObjectiveContext(objective.id, project.id, objectiveRepo);
  assert.deepStrictEqual(snapshot, {
    id: objective.id,
    title: objective.title,
    description: objective.description,
    constraints: objective.constraints,
    successCriteria: objective.successCriteria,
  });
});

test('D.3b1.1: resolveObjectiveContext fails closed when the objectiveId does not resolve to any Objective', () => {
  const db = openDatabase(':memory:');
  const { project } = seedWorkspaceAndProject(db);
  const objectiveRepo = new ObjectiveRepository(db);
  assert.throws(
    () => resolveObjectiveContext('does-not-exist', project.id, objectiveRepo),
    /not found/,
  );
});

test('D.3b1.1: resolveObjectiveContext fails closed when the Objective does not belong to the WorkItem\'s project', () => {
  const db = openDatabase(':memory:');
  const { project: ownerProject } = seedWorkspaceAndProject(db);
  const { project: otherProject } = seedWorkspaceAndProject(db);
  const objectiveRepo = new ObjectiveRepository(db);
  const objective = makeObjective(ownerProject.id);
  objectiveRepo.save(objective);

  assert.throws(
    () => resolveObjectiveContext(objective.id, otherProject.id, objectiveRepo),
    /does not belong to project/,
  );
});

// -- Scheduler -----------------------------------------------------------------

test('D.3b1.1: Scheduler threads the WorkItem\'s Objective into ExecutionRequest.objectiveContext', async () => {
  const db = openDatabase(':memory:');
  const { ws, project } = seedWorkspaceAndProject(db);
  const objective = makeObjective(project.id);
  new ObjectiveRepository(db).save(objective);
  const wi = makeWorkItem(project.id, { objectiveId: objective.id, workflowId: 'draft-artifact' });
  new WorkItemRepository(db).save(wi);

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
  assert.ok(captured?.objectiveContext, 'objectiveContext must be threaded to the adapter');
  assert.equal(captured!.objectiveContext!.id, objective.id);
  assert.equal(captured!.objectiveContext!.title, objective.title);
  assert.equal(captured!.objectiveContext!.description, objective.description);
  assert.deepStrictEqual(captured!.objectiveContext!.successCriteria, objective.successCriteria);
});

test('D.3b1.1: Scheduler fails closed (no dispatch, no adapter call) when the WorkItem\'s Objective belongs to a different project', async () => {
  const db = openDatabase(':memory:');
  const { ws, project } = seedWorkspaceAndProject(db);
  const { project: otherProject } = seedWorkspaceAndProject(db);
  const foreignObjective = makeObjective(otherProject.id);
  new ObjectiveRepository(db).save(foreignObjective);
  const wi = makeWorkItem(project.id, { objectiveId: foreignObjective.id, workflowId: 'draft-artifact' });
  const items = new WorkItemRepository(db);
  items.save(wi);

  let adapterCalled = false;
  const adapter: ExecutionAdapter = {
    id: 'stratum-agent',
    getCapabilities: () => new Set(['repo.read']) as any,
    async execute(req: ExecutionRequest): Promise<ExecutionResult> {
      adapterCalled = true;
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

  assert.equal(results[0].outcome, 'failed');
  assert.match(results[0].error ?? '', /does not belong to project/);
  assert.equal(adapterCalled, false, 'adapter must not be called when the Objective cannot be resolved');
  assert.equal(items.findById(wi.id)!.state, 'ready', 'WorkItem must not transition to running on a failed dispatch');
});

// -- ResumeService ---------------------------------------------------------------

const D3B11_RESUME_WF = `d3b1-1-resume-harness-${randomUUID()}`;
registerWorkflow({
  id: D3B11_RESUME_WF,
  label: 'D.3b1.1 resume harness',
  steps: [
    { id: 'snap', kind: 'produce', agentRole: 'designer' },
    { id: 'ck', kind: 'checkpoint', label: 'Gate' },
    { id: 'bld', kind: 'produce', agentRole: 'builder' },
  ],
});

const APPROVE = { selectedOptionId: 'approve', rationale: 'go', resolvedAt: new Date().toISOString(), resolvedBy: 'tester' };

function seedHaltedRun(db: ReturnType<typeof openDatabase>, workItemId: string, workflowId: string) {
  const workflowRunId = randomUUID();
  const decisionId = randomUUID();
  const now = new Date().toISOString();
  new WorkflowRunRepository(db).createOrValidate({
    run_id: workflowRunId, workflow_id: workflowId, work_item_id: workItemId,
    status: 'halted', current_step_id: 'ck', awaiting_checkpoint: 'ck',
    iteration: 1, revision: 0, started_at: now, updated_at: now,
  });
  new WorkItemRepository(db).updateState(workItemId, 'needs_decision', now);
  const projectId = new WorkItemRepository(db).findById(workItemId)!.projectId;
  new DecisionRepository(db).save({
    id: decisionId, projectId, workItemId, type: 'checkpoint',
    subjectRef: { workflowRunId, workItemId, stepId: 'ck' },
    title: 'Gate', summary: 'Halted at ck',
    options: [
      { id: 'approve', label: 'Approve', description: 'Continue' },
      { id: 'reject', label: 'Reject', description: 'Cancel' },
    ],
    impact: 'low', reversibility: 'easy', urgency: 'normal', status: 'pending',
  });
  new StepExecutionRepository(db).save({
    id: randomUUID(), workItemId, workflowRunId, stepId: 'ck', executor: 'test',
    state: 'waiting', attempt: 1, startedAt: now,
  });
  return { decisionId, workflowRunId };
}

test('D.3b1.1: ResumeService threads the WorkItem\'s Objective into ExecutionRequest.objectiveContext on continuation', async () => {
  const db = openDatabase(':memory:');
  const { ws, project } = seedWorkspaceAndProject(db);
  const objective = makeObjective(project.id);
  new ObjectiveRepository(db).save(objective);
  const wi = makeWorkItem(project.id, { objectiveId: objective.id, workflowId: D3B11_RESUME_WF, state: 'ready' });
  new WorkItemRepository(db).save(wi);
  const { decisionId } = seedHaltedRun(db, wi.id, D3B11_RESUME_WF);

  let captured: ExecutionRequest | undefined;
  const adapter: ExecutionAdapter = {
    id: 'test-adapter',
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
  const svc = new ResumeService(db, ws.id, registry);
  await svc.resume(decisionId, APPROVE);

  assert.ok(captured?.objectiveContext, 'objectiveContext must be threaded on resume');
  assert.equal(captured!.objectiveContext!.id, objective.id);
  assert.equal(captured!.objectiveContext!.title, objective.title);
});

test('D.3b1.1: ResumeService fails closed (no adapter call) when the WorkItem\'s Objective belongs to a different project', async () => {
  const db = openDatabase(':memory:');
  const { ws, project } = seedWorkspaceAndProject(db);
  const { project: otherProject } = seedWorkspaceAndProject(db);
  const foreignObjective = makeObjective(otherProject.id);
  new ObjectiveRepository(db).save(foreignObjective);
  const wi = makeWorkItem(project.id, { objectiveId: foreignObjective.id, workflowId: D3B11_RESUME_WF, state: 'ready' });
  new WorkItemRepository(db).save(wi);
  const { decisionId } = seedHaltedRun(db, wi.id, D3B11_RESUME_WF);

  let adapterCalled = false;
  const adapter: ExecutionAdapter = {
    id: 'test-adapter',
    getCapabilities: () => new Set(['repo.read']) as any,
    async execute(req: ExecutionRequest): Promise<ExecutionResult> {
      adapterCalled = true;
      return {
        schemaVersion: 1, stepExecutionId: req.stepExecutionId, outcome: 'succeeded',
        artifacts: [], evidenceClaims: [], decisionRequests: [], usage: { durationMs: 1 },
      };
    },
  };
  const registry = new ExecutorRegistry();
  registry.register(adapter);
  const svc = new ResumeService(db, ws.id, registry);

  await assert.rejects(() => svc.resume(decisionId, APPROVE), /does not belong to project/);
  assert.equal(adapterCalled, false, 'adapter must not be called when the Objective cannot be resolved');
});

// -- ContextManager rendering: separate headers -----------------------------

const ROOT = '/project-d3b1-1';

function ctxFor(overrides: Partial<StepRunContext> = {}): StepRunContext {
  return {
    workflowRunId: 'd3b1-1-run', workflowId: 'a-workflow-id-not-in-the-registry',
    stepId: 'synthesize', iteration: 1, revision: 0,
    goal: 'Prove Objective/WorkItem context are rendered under separate headers',
    projectRoot: ROOT,
    ...overrides,
  };
}

function mockFs(): typeof import('fs').promises {
  return {
    mkdir: async () => {},
    writeFile: async () => {},
    appendFile: async () => {},
    readFile: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
  } as unknown as typeof import('fs').promises;
}

test('D.3b1.1: includeObjectiveContext renders the Objective\'s human intent under a header visibly separate from the WorkItem section', async () => {
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, mockFs());
  const result = await cm.assemble('explorer', ctxFor({
    includeObjectiveContext: true,
    objectiveContext: {
      id: 'obj-1',
      title: 'Add real-time multiplayer to Evershift',
      description: 'Players can join and play a shared session together in real time.',
      constraints: [{ description: 'Must stay same-platform', type: 'must' }],
      successCriteria: [{ description: 'Two players can join a session' }],
    },
    includeWorkItemContext: true,
    workItemConstraints: [{ description: 'Must use the existing Artifact machinery', type: 'must' }],
    workItemAcceptanceCriteria: [{ description: 'Readiness rubric passes for the bounded scope' }],
  }));

  assert.ok(result.task.includes('## Objective — human intent'), 'the Objective section header must be present');
  assert.ok(result.task.includes('Add real-time multiplayer to Evershift'));
  assert.ok(result.task.includes('Players can join and play a shared session together in real time.'));
  assert.ok(result.task.includes('## Current bounded WorkItem'), 'the WorkItem section header must be present and distinct');
  assert.ok(result.task.includes('Must use the existing Artifact machinery'));

  // Provenance must never blur: the Objective header appears before the
  // WorkItem header, and neither section's content bleeds into the other's.
  const objectiveIdx = result.task.indexOf('## Objective — human intent');
  const workItemIdx = result.task.indexOf('## Current bounded WorkItem');
  assert.ok(objectiveIdx < workItemIdx, 'Objective (broader intent) must render before the bounded WorkItem');
});

test('D.3b1.1: without includeObjectiveContext, Objective content is NOT rendered even when objectiveContext is present on ctx', async () => {
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, mockFs());
  const result = await cm.assemble('explorer', ctxFor({
    // includeObjectiveContext intentionally omitted
    objectiveContext: {
      id: 'obj-1', title: 'Add real-time multiplayer to Evershift',
      description: 'Players can join and play a shared session together in real time.',
      constraints: [], successCriteria: [],
    },
  }));

  assert.ok(!result.task.includes('Add real-time multiplayer to Evershift'));
  assert.ok(!result.task.includes('## Objective — human intent'));
});

// ============================================================================
// Part C — combined end-to-end: Objective intent -> multi-turn repository
// read -> KNOWN/source:repository fact -> single-turn review pass -> commit
// ============================================================================

class DualModeProvider implements ILLMProvider, IMultiTurnProvider {
  multiTurnCalls: MultiTurnParams[] = [];
  singleTurnCalls: LLMCompletionParams[] = [];
  constructor(
    private multiTurnSequence: MultiTurnResult[],
    private singleTurnSequence: string[],
  ) {}
  async complete(params: LLMCompletionParams): Promise<LLMCompletionResult> {
    this.singleTurnCalls.push(params);
    const content = this.singleTurnSequence[this.singleTurnCalls.length - 1] ?? '';
    return { content, tokens_used: 10, duration_ms: 1 };
  }
  async completeMultiTurn(params: MultiTurnParams): Promise<MultiTurnResult> {
    this.multiTurnCalls.push(params);
    const result = this.multiTurnSequence[this.multiTurnCalls.length - 1];
    if (!result) return { stop_reason: 'end_turn', text: '', tool_uses: [], tokens_used: 1 };
    return result;
  }
}

function toolUseTurn(name: string, input: Record<string, string>, id: string): MultiTurnResult {
  const tu: ToolUseBlock = { type: 'tool_use', id, name, input };
  return { stop_reason: 'tool_use', text: '', tool_uses: [tu], tokens_used: 5 };
}

function multiTurnDefinitionOutput(content: string, outputPath: string): MultiTurnResult {
  return {
    stop_reason: 'end_turn',
    tool_uses: [],
    tokens_used: 10,
    text: ['<<<SLE-OUTPUT>>>', `### ${outputPath}`, content, '<<<END-SLE-OUTPUT>>>'].join('\n'),
  };
}

function singleTurnReadinessOutput(verdict: 'pass' | 'fail', content: string, outputPath: string): string {
  return [
    '<!-- SLE-OUTPUT', 'role: explorer', 'node: define-work',
    `verdict: ${verdict}`,
    'artifacts:', `  - id: readiness`, `    path: ${outputPath}`, '-->', '',
    `## ${outputPath}`, '', content,
  ].join('\n');
}

function seedDefineWorkItem(db: ReturnType<typeof openDatabase>, workItemId: string, objectiveId: string, objective: Objective): { projectId: string } {
  const now = new Date().toISOString();
  new WorkspaceRepository(db).save({ id: 'ws-d3b1-1', name: 'ws', createdAt: now });
  new ProjectRepository(db).save({
    id: 'proj-d3b1-1', workspaceId: 'ws-d3b1-1', name: 'proj', status: 'active', priority: 0, createdAt: now, updatedAt: now,
  });
  new ObjectiveRepository(db).save(objective);
  new WorkItemRepository(db).save({
    id: workItemId, projectId: 'proj-d3b1-1', objectiveId, repositoryIds: [],
    title: 'Define the increment', goal: 'Add real-time multiplayer to Evershift', workflowId: 'define-work',
    state: 'running', priority: 0,
    acceptanceCriteria: [], constraints: [], requiredEvidence: [],
    dependencies: [], createdAt: now, updatedAt: now,
  });
  return { projectId: 'proj-d3b1-1' };
}

function makeEngine(agentRunner: AgentRunner, root: string): WorkflowEngine {
  const engineDeps: WorkflowEngineDeps = {
    stepRunner: new AgentStepRunner(agentRunner),
    mapManager: { read: async () => ({ artifacts: [] }), update: async () => {} } as any,
    runArtifacts: {
      updateNodeStatus: async () => {}, createRunDir: async () => {}, createManifest: async () => {},
    } as any,
    projectRoot: root,
  };
  const engineOpts: WorkflowEngineOptions = { onCheckpoint: async () => 'approve' };
  return new WorkflowEngine(engineDeps, engineOpts);
}

test('D.3b1.1: define-work end-to-end — Objective intent reaches synthesis, synthesis reads a tracked repository file via the multi-turn path, the fact becomes KNOWN/source:repository, review stays single-turn and passes, and the run commits', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'd3b1-1-e2e-'));
  try {
    const workItemId = 'wi-d3b1-1-e2e';
    const definitionPath = `.sle/work/${workItemId}/definition.md`;
    const readinessPath = `.sle/work/${workItemId}/readiness.md`;

    // A real Git-tracked repository file for the multi-turn path to inspect.
    gitInit(root);
    await fs.mkdir(path.join(root, 'docs'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'docs', 'networking.md'),
      'Evershift currently has no networking layer of any kind.',
      'utf-8',
    );
    gitAdd(root, 'docs/networking.md');

    const db = openDatabase(':memory:');
    const objective = makeObjective('proj-d3b1-1', {
      id: 'obj-d3b1-1-e2e',
      title: 'Add real-time multiplayer to Evershift',
      description: 'Players can join and play a shared Evershift session together in real time.',
    });
    const { projectId } = seedDefineWorkItem(db, workItemId, objective.id, objective);
    const objectiveRepo = new ObjectiveRepository(db);
    const objectiveContext = resolveObjectiveContext(objective.id, projectId, objectiveRepo);
    assert.ok(objectiveContext);

    const artifacts = new ArtifactRepository(db);

    const definitionContent = [
      '## Facts',
      '- id: networking-layer',
      '  statement: Evershift currently has no networking layer of any kind.',
      '  status: KNOWN',
      '  source: repository',
    ].join('\n');

    const provider = new DualModeProvider(
      [
        // synthesize-definition: inspect the tracked repository file, then answer.
        toolUseTurn('read_file', { path: 'docs/networking.md' }, 'tu_1'),
        multiTurnDefinitionOutput(definitionContent, definitionPath),
      ],
      [
        // definition-readiness-review: single-turn, passes on v1.
        singleTurnReadinessOutput('pass', 'All seven dimensions pass.', readinessPath),
      ],
    );
    const dyn = new DynamicLLMProvider(provider);

    const cm = new ContextManager(root, DEFAULT_CONFIG);
    const agentRunner = new AgentRunner(cm, dyn, root, makeRunArtifactsStubC(), { model: 'test' }, undefined, artifacts);
    const engine = makeEngine(agentRunner, root);

    const result = await engine.run(
      'define-work', 'run-d3b1-1-e2e', 'Add real-time multiplayer to Evershift', undefined, workItemId,
      undefined, undefined, objective.id,
      [], [], objectiveContext,
    );

    assert.equal(result.status, 'complete', result.error);
    assert.equal(result.final_step_id, 'commit');
    assert.equal(result.iterations_used, 1, 'v1 must pass immediately — no refinement needed');

    // (1) Objective intent reached synthesis.
    assert.ok(provider.multiTurnCalls.length >= 1);
    const firstUserContent = String((provider.multiTurnCalls[0].messages[0] as any).content);
    assert.ok(firstUserContent.includes(objective.title), 'Objective title must reach the synthesis prompt');
    assert.ok(firstUserContent.includes(objective.description), 'Objective description must reach the synthesis prompt');

    // (2)/(3) synthesis took the multi-turn path and actually read the tracked file.
    assert.equal(provider.multiTurnCalls.length, 2, 'one tool_use turn, then one final answer');
    const toolResultContent = JSON.stringify((provider.multiTurnCalls[1].messages as any[]));
    assert.ok(
      toolResultContent.includes('Evershift currently has no networking layer'),
      'the real content read from the tracked file must be fed back to the model',
    );

    // (4) the resulting Definition records the observed fact as KNOWN/source: repository.
    const finalDefinition = await fs.readFile(path.join(root, definitionPath), 'utf-8');
    assert.ok(finalDefinition.includes('status: KNOWN'));
    assert.ok(finalDefinition.includes('source: repository'));

    // (5) definition-readiness-review stayed on the single-turn path and passed.
    assert.equal(provider.singleTurnCalls.length, 1, 'review must use exactly one single-turn call');
    const definitionArtifacts = artifacts.listByWorkflowRun('run-d3b1-1-e2e').filter((a) => a.type === 'definition');
    assert.equal(definitionArtifacts.length, 1);
    const readinessArtifacts = artifacts.listByWorkflowRun('run-d3b1-1-e2e').filter((a) => a.type === 'definition-readiness');
    assert.equal(readinessArtifacts.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeRunArtifactsStubC() {
  return {
    async writeNodeOutput() {},
    async updateNodeStatus() {},
  } as any;
}
