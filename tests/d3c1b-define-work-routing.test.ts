// D.3c1b — applies the generic D.3c1a bounded semantic-review routing
// contract and the D.3c0 dynamic Decision/checkpoint contract to the REAL
// define-work workflow (src/workflow/builtins/define-work.ts), wiring all
// four D.3a gap classifications (CAN_RESOLVE/DEFER/HUMAN_DECISION/
// EXPLORE_AS_WORK) onto their own dedicated resolution paths. See
// src/workflow/methodology/definition-readiness.ts for the prompt-contract
// constants these steps compose (READINESS_ROUTE_CONTRACT,
// DEFER_APPLICATION_CONTRACT, HUMAN_DECISION_PREPARE_CONTRACT,
// HUMAN_DECISION_APPLY_CONTRACT, EXPLORATION_NEED_CONTRACT).
//
// CAN_RESOLVE end-to-end coverage (refine -> refine-definition -> pass ->
// commit, and cap exhaustion failing closed) lives in
// tests/d3b1-define-work.test.ts, updated for the new on_fail_routes
// contract — not duplicated here. This file covers what D.3c1b actually
// adds:
//
// Part A: DEFER, including at the final allowed iteration (never touches
//         the iteration counter, never hits the cap).
// Part B: HUMAN_DECISION end-to-end via the real production-style
//         control-plane path — Scheduler -> durable Decision ->
//         ResumeService -> DecisionContext -> the Definition actually
//         records DECIDED/source:decision/the real Decision id.
// Part C: EXPLORE_AS_WORK — an exploration-need Artifact is recorded and
//         the run terminates cleanly with the Definition still not-ready;
//         no WorkItem/WorkProposal is created.
// Part D: precedence — GAP_CLASSIFICATION_PRECEDENCE is locked both as an
//         exported order and as the literal order it appears in the actual
//         instruction text define-work's review steps carry.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ContextManager, DEFAULT_CONFIG } from '../src/context-manager.js';
import { AgentRunner } from '../src/agent-runner.js';
import { AgentStepRunner } from '../src/execution/agent-step-runner.js';
import { WorkflowEngine, DEFINE_WORK } from '../src/workflow/index.js';
import { StratumAgentAdapter } from '../src/execution/stratum-agent-adapter.js';
import { ExecutorRegistry } from '../src/execution/registry.js';
import { Scheduler } from '../src/scheduler/scheduler.js';
import { ResumeService } from '../src/services/resume-service.js';
import { resolveObjectiveContext } from '../src/execution/dispatch-primitive.js';
import { openDatabase } from '../src/storage/database.js';
import {
  ArtifactRepository,
  WorkspaceRepository,
  ProjectRepository,
  ObjectiveRepository,
  WorkItemRepository,
  WorkflowRunRepository,
  DecisionRepository,
} from '../src/storage/repositories.js';
import {
  GAP_CLASSIFICATION_PRECEDENCE,
  READINESS_ROUTE_CONTRACT,
} from '../src/workflow/methodology/definition-readiness.js';
import type { WorkflowEngineDeps, WorkflowEngineOptions } from '../src/workflow/types.js';
import type { ILLMProvider, LLMCompletionParams, LLMCompletionResult } from '../src/llm-provider.js';
import type { Objective } from '../src/domain/index.js';

// ============================================================================
// Shared fixtures
// ============================================================================

function makeRunArtifactsStub() {
  return {
    async writeNodeOutput() {},
    async updateNodeStatus() {},
    async createRunDir() {},
    async createManifest() {},
  } as any;
}

class SequenceLLMProvider implements ILLMProvider {
  calls: LLMCompletionParams[] = [];
  constructor(private responses: Array<string | ((params: LLMCompletionParams) => string)>) {}
  async complete(params: LLMCompletionParams): Promise<LLMCompletionResult> {
    this.calls.push(params);
    const entry = this.responses[this.calls.length - 1] ?? '';
    const content = typeof entry === 'function' ? entry(params) : entry;
    return { content, tokens_used: 10, duration_ms: 1 };
  }
}

function definitionOutput(content: string, outPath: string): string {
  return [
    '<!-- SLE-OUTPUT', 'role: explorer', 'node: define-work',
    'artifacts:', '  - id: definition', `    path: ${outPath}`, '-->', '',
    `## ${outPath}`, '', content,
  ].join('\n');
}

function readinessOutput(verdict: 'pass' | 'fail', route: string | undefined, content: string, outPath: string): string {
  const lines = ['<!-- SLE-OUTPUT', 'role: explorer', 'node: define-work', `verdict: ${verdict}`];
  if (route !== undefined) lines.push(`route: ${route}`);
  lines.push('artifacts:', '  - id: readiness', `    path: ${outPath}`, '-->', '', `## ${outPath}`, '', content);
  return lines.join('\n');
}

function jsonOutput(content: unknown, outPath: string): string {
  return [
    '<!-- SLE-OUTPUT', 'role: explorer', 'node: define-work',
    'artifacts:', '  - id: doc', `    path: ${outPath}`, '-->', '',
    `## ${outPath}`, '', JSON.stringify(content),
  ].join('\n');
}

function makeEngine(agentRunner: AgentRunner, root: string): WorkflowEngine {
  const engineDeps: WorkflowEngineDeps = {
    stepRunner: new AgentStepRunner(agentRunner),
    mapManager: { read: async () => ({ artifacts: [] }), update: async () => {} } as any,
    runArtifacts: makeRunArtifactsStub(),
    projectRoot: root,
  };
  const engineOpts: WorkflowEngineOptions = { onCheckpoint: async () => 'halt' };
  return new WorkflowEngine(engineDeps, engineOpts);
}

function seedWorkItem(db: ReturnType<typeof openDatabase>, workItemId: string): void {
  const now = new Date().toISOString();
  new WorkspaceRepository(db).save({ id: 'ws-d3c1b', name: 'ws', createdAt: now });
  new ProjectRepository(db).save({
    id: 'proj-d3c1b', workspaceId: 'ws-d3c1b', name: 'proj', status: 'active', priority: 0, createdAt: now, updatedAt: now,
  });
  new WorkItemRepository(db).save({
    id: workItemId, projectId: 'proj-d3c1b', repositoryIds: [],
    title: 'Definition work item', goal: 'Add real-time multiplayer to Evershift', workflowId: 'define-work',
    state: 'running', priority: 0,
    acceptanceCriteria: [], constraints: [], requiredEvidence: [],
    dependencies: [], createdAt: now, updatedAt: now,
  });
}

// ============================================================================
// Part A — DEFER, including at the final allowed iteration
// ============================================================================

test('D.3c1b: DEFER routes to apply-deferred-gaps, marks the fact DEFERRED (never KNOWN), and does not increment iteration', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'd3c1b-defer-'));
  try {
    const workItemId = 'wi-defer-1';
    const objectiveId = 'obj-defer-1';
    const definitionPath = `.sle/work/${workItemId}/definition.md`;
    const readinessPath = `.sle/work/${workItemId}/readiness.md`;

    const db = openDatabase(':memory:');
    seedWorkItem(db, workItemId);
    const artifacts = new ArtifactRepository(db);

    const provider = new SequenceLLMProvider([
      definitionOutput(
        '## Facts\n- id: legacy-ui-migration\n  statement: The legacy UI migration is out of scope for this bounded increment.\n  status: ASSUMED\n  source: human',
        definitionPath,
      ),
      readinessOutput(
        'fail', 'defer',
        'DEFER — fact legacy-ui-migration: real gap, does not block the candidate bounded scope (multiplayer networking); closure would require a separate, later increment.',
        readinessPath,
      ),
      // apply-deferred-gaps: converts the fact to DEFERRED.
      definitionOutput(
        '## Facts\n- id: legacy-ui-migration\n  statement: The legacy UI migration is out of scope for this bounded increment.\n  status: DEFERRED\n  source: human',
        definitionPath,
      ),
      // post-defer-readiness-review: passes — nothing else blocking.
      readinessOutput('pass', undefined, 'All seven dimensions pass; legacy-ui-migration is DEFERRED, not blocking.', readinessPath),
    ]);

    const cm = new ContextManager(root, DEFAULT_CONFIG);
    const agentRunner = new AgentRunner(cm, provider, root, makeRunArtifactsStub(), { model: 'test' }, undefined, artifacts);
    const engine = makeEngine(agentRunner, root);

    const result = await engine.run(
      'define-work', `run-defer-${randomUUID()}`, 'Add real-time multiplayer to Evershift',
      undefined, workItemId, undefined, undefined, objectiveId, [], [],
    );

    assert.equal(result.status, 'complete', result.error);
    assert.equal(result.final_step_id, 'commit');
    assert.equal(result.iterations_used, 1, 'DEFER must never increment iteration');

    const finalDefinition = await fs.readFile(path.join(root, definitionPath), 'utf-8');
    assert.ok(finalDefinition.includes('status: DEFERRED'));
    assert.ok(!finalDefinition.includes('status: ASSUMED'), 'the DEFER gap must not remain ASSUMED after apply-deferred-gaps');
    assert.ok(!/status: KNOWN/.test(finalDefinition), 'DEFERRED is not resolution — it must never become KNOWN');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('D.3c1b: a genuine non-blocking DEFER gap can be marked DEFERRED at the FINAL allowed iteration — no iteration 5 attempted, no cap hit', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'd3c1b-defer-cap-'));
  try {
    const workItemId = 'wi-defer-cap';
    const objectiveId = 'obj-defer-cap';
    const definitionPath = `.sle/work/${workItemId}/definition.md`;
    const readinessPath = `.sle/work/${workItemId}/readiness.md`;

    const db = openDatabase(':memory:');
    seedWorkItem(db, workItemId);
    const artifacts = new ArtifactRepository(db);

    // Three CAN_RESOLVE refine rounds consume iterations 1->4 (the workflow's
    // max_iterations), landing exactly at iteration 4 — the final allowed
    // iteration, with no further refine iteration available. The DEFER gap
    // discovered there must still resolve via apply-deferred-gaps (which
    // never touches the iteration counter), not be rejected merely because
    // iteration 5 is unavailable.
    const provider = new SequenceLLMProvider([
      definitionOutput('Definition v1.', definitionPath),
      readinessOutput('fail', 'refine', 'v1: missing acceptance criteria.', readinessPath),
      definitionOutput('Definition v2.', definitionPath),
      readinessOutput('fail', 'refine', 'v2: missing acceptance criteria still.', readinessPath),
      definitionOutput('Definition v3.', definitionPath),
      readinessOutput('fail', 'refine', 'v3: missing acceptance criteria still.', readinessPath),
      definitionOutput(
        '## Facts\n- id: legacy-ui-migration\n  statement: Out of scope for this increment.\n  status: ASSUMED\n  source: human',
        definitionPath,
      ),
      // At iteration 4 (the final allowed iteration): the only remaining gap
      // is a genuine non-blocking DEFER — never route refine again (a 5th
      // iteration is unavailable) and never let the cap swallow this.
      readinessOutput('fail', 'defer', 'DEFER — legacy-ui-migration: real gap, does not block this bounded scope.', readinessPath),
      definitionOutput(
        '## Facts\n- id: legacy-ui-migration\n  statement: Out of scope for this increment.\n  status: DEFERRED\n  source: human',
        definitionPath,
      ),
      readinessOutput('pass', undefined, 'All seven dimensions pass; legacy-ui-migration is DEFERRED.', readinessPath),
    ]);

    const cm = new ContextManager(root, DEFAULT_CONFIG);
    const agentRunner = new AgentRunner(cm, provider, root, makeRunArtifactsStub(), { model: 'test' }, undefined, artifacts);
    const engine = makeEngine(agentRunner, root);

    const result = await engine.run(
      'define-work', `run-defer-cap-${randomUUID()}`, 'Add real-time multiplayer to Evershift',
      undefined, workItemId, undefined, undefined, objectiveId, [], [],
    );

    assert.equal(result.status, 'complete', result.error);
    assert.equal(result.final_step_id, 'commit');
    assert.equal(result.iterations_used, 4, 'three refine rounds must have advanced iteration to exactly the cap (4)');
    assert.ok(!/Iteration cap/.test(result.error ?? ''), 'DEFER at the final iteration must never trip the cap');

    const finalDefinition = await fs.readFile(path.join(root, definitionPath), 'utf-8');
    assert.ok(finalDefinition.includes('status: DEFERRED'), 'the DEFER gap must still be markable DEFERRED at the final allowed iteration');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('D.3c1b: post-defer-readiness-review does not offer another defer route — a residual DEFER gap after apply-deferred-gaps fails closed', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'd3c1b-defer-residual-'));
  try {
    const workItemId = 'wi-defer-residual';
    const objectiveId = 'obj-defer-residual';
    const definitionPath = `.sle/work/${workItemId}/definition.md`;
    const readinessPath = `.sle/work/${workItemId}/readiness.md`;

    const db = openDatabase(':memory:');
    seedWorkItem(db, workItemId);
    const artifacts = new ArtifactRepository(db);

    const provider = new SequenceLLMProvider([
      definitionOutput('Definition v1.', definitionPath),
      readinessOutput('fail', 'defer', 'DEFER — some-fact: real gap, non-blocking.', readinessPath),
      // apply-deferred-gaps fails to do its job (bug/edge case) — the fact
      // stays ASSUMED. post-defer-readiness-review must not offer 'defer'
      // again (no unbounded non-iterating loop) — a route token outside its
      // declared table fails closed via AgentRunner's own gate.
      definitionOutput('Definition v1 (unchanged — apply-deferred-gaps did not convert the fact).', definitionPath),
      readinessOutput('fail', 'defer', 'DEFER still present — should never be offered here.', readinessPath),
    ]);

    const cm = new ContextManager(root, DEFAULT_CONFIG);
    const agentRunner = new AgentRunner(cm, provider, root, makeRunArtifactsStub(), { model: 'test' }, undefined, artifacts);
    const engine = makeEngine(agentRunner, root);

    const result = await engine.run(
      'define-work', `run-defer-residual-${randomUUID()}`, 'goal',
      undefined, workItemId, undefined, undefined, objectiveId, [], [],
    );

    assert.equal(result.status, 'halted');
    assert.equal(result.final_step_id, 'post-defer-readiness-review');
    assert.match(result.error ?? '', /route/, 'an undeclared "defer" token on post-defer-readiness-review must fail closed via the route-gate');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// Part B — HUMAN_DECISION end-to-end via the real production control plane
// ============================================================================

function makeObjective(projectId: string, overrides: Partial<Objective> = {}): Objective {
  const now = new Date().toISOString();
  return {
    id: randomUUID(), projectId,
    title: 'Add real-time multiplayer to Evershift',
    description: 'Players can join and play a shared Evershift session together in real time.',
    priority: 0, status: 'active',
    constraints: [], successCriteria: [],
    createdAt: now, updatedAt: now,
    ...overrides,
  };
}

function makeProductionAdapter(
  root: string, db: ReturnType<typeof openDatabase>, artifacts: ArtifactRepository, provider: ILLMProvider,
): StratumAgentAdapter {
  const cm = new ContextManager(root, DEFAULT_CONFIG);
  const agentRunner = new AgentRunner(cm, provider, root, makeRunArtifactsStub(), { model: 'test' }, undefined, artifacts);
  const engineDeps: WorkflowEngineDeps = {
    stepRunner: new AgentStepRunner(agentRunner),
    mapManager: { read: async () => ({ artifacts: [] }), update: async () => {} } as any,
    runArtifacts: makeRunArtifactsStub(),
    projectRoot: root,
    workflowRunRepository: new WorkflowRunRepository(db),
  };
  const engineOpts: WorkflowEngineOptions = { onCheckpoint: async () => 'halt' };
  return new StratumAgentAdapter(engineDeps, engineOpts, artifacts);
}

const AUTHORITY_DECISION_REQUEST = {
  type: 'human_decision',
  title: 'Multiplayer authority model',
  summary: 'The bounded scope needs one authority model before synchronization behavior can be specified.',
  options: [
    { id: 'host-authoritative', label: 'Host-authoritative', description: 'One player\'s client is authoritative.' },
    { id: 'dedicated-server', label: 'Dedicated server', description: 'Route all game state through a dedicated server.' },
    { id: 'peer-to-peer', label: 'Peer-to-peer', description: 'No single authority.' },
  ],
};

test('D.3c1b: HUMAN_DECISION end-to-end — Scheduler creates the durable Decision, ResumeService threads DecisionContext, and the Definition records DECIDED/source:decision/the real Decision id', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'd3c1b-human-'));
  try {
    const workItemId = 'wi-human-1';
    const definitionPath = `.sle/work/${workItemId}/definition.md`;
    const readinessPath = `.sle/work/${workItemId}/readiness.md`;
    const decisionRequestPath = `.sle/work/${workItemId}/decision-request.json`;

    const db = openDatabase(':memory:');
    const objective = makeObjective('proj-d3c1b-human');
    new WorkspaceRepository(db).save({ id: 'ws-d3c1b-human', name: 'ws', createdAt: objective.createdAt });
    new ProjectRepository(db).save({
      id: 'proj-d3c1b-human', workspaceId: 'ws-d3c1b-human', name: 'proj', status: 'active', priority: 0,
      createdAt: objective.createdAt, updatedAt: objective.createdAt,
    });
    new ObjectiveRepository(db).save(objective);
    new WorkItemRepository(db).save({
      id: workItemId, projectId: 'proj-d3c1b-human', objectiveId: objective.id, repositoryIds: [],
      title: 'Definition work item', goal: 'Add real-time multiplayer to Evershift', workflowId: 'define-work',
      state: 'ready', priority: 0,
      acceptanceCriteria: [], constraints: [], requiredEvidence: [],
      dependencies: [], createdAt: objective.createdAt, updatedAt: objective.createdAt,
    });
    const artifacts = new ArtifactRepository(db);

    // The apply-human-decision response is generated dynamically: it reads
    // the real Decision id and selected option straight out of the
    // assembled "## Human Decision" context (see
    // ContextManager.formatDecisionContext) — this proves the Definition
    // consumes the ACTUAL resolved Decision, not a value the test
    // hardcoded ahead of time (the Decision does not exist until Scheduler
    // creates it during this same test).
    const applyHumanDecisionResponse = (params: LLMCompletionParams): string => {
      const userMessage = String(params.messages[1]?.content ?? '');
      const decisionIdMatch = userMessage.match(/Decision id: `([^`]+)`/);
      const optionIdMatch = userMessage.match(/option id: `([^`]+)`/);
      assert.ok(decisionIdMatch, `expected a rendered Decision id in the assembled context: ${userMessage}`);
      assert.ok(optionIdMatch, `expected a rendered selected option id: ${userMessage}`);
      const decisionId = decisionIdMatch![1];
      const selectedOptionId = optionIdMatch![1];
      return definitionOutput(
        '## Facts\n' +
        `- id: authority-model\n  statement: Which network authority model multiplayer uses.\n  status: DECIDED\n  source: decision\n  decision: ${decisionId}\n  selected: ${selectedOptionId}`,
        definitionPath,
      );
    };

    const provider = new SequenceLLMProvider([
      // 0: synthesize-definition — a Definition with one open HUMAN_DECISION fact.
      definitionOutput(
        '## Facts\n- id: authority-model\n  statement: Which network authority model multiplayer uses.\n  status: UNKNOWN\n  source: human',
        definitionPath,
      ),
      // 1: definition-readiness-review — fail/human.
      readinessOutput(
        'fail', 'human',
        'HUMAN_DECISION — fact authority-model: a genuine product tradeoff only a human can authorize.',
        readinessPath,
      ),
      // 2: prepare-human-decision — a single validated DecisionRequest.
      jsonOutput(AUTHORITY_DECISION_REQUEST, decisionRequestPath),
      // 3: apply-human-decision — dynamic, extracts the real Decision id.
      applyHumanDecisionResponse,
      // 4: post-human-readiness-review — passes.
      readinessOutput('pass', undefined, 'All seven dimensions pass; authority-model is DECIDED.', readinessPath),
    ]);

    const adapter = makeProductionAdapter(root, db, artifacts, provider);
    const registry = new ExecutorRegistry();
    registry.register(adapter);

    const scheduler = new Scheduler(db, 'ws-d3c1b-human', registry);
    const dispatchResults = await scheduler.tick();
    assert.equal(dispatchResults[0].outcome, 'dispatched', JSON.stringify(dispatchResults[0]));
    const workflowRunId = dispatchResults[0].workflowRunId!;

    const decisionRepo = new DecisionRepository(db);
    const pending = decisionRepo.listByWorkItem(workItemId);
    assert.equal(pending.length, 1, 'exactly one Decision must have been created');
    const decision = pending[0];
    assert.equal(decision.title, AUTHORITY_DECISION_REQUEST.title);
    assert.equal(decision.summary, AUTHORITY_DECISION_REQUEST.summary);
    assert.deepStrictEqual(decision.options, AUTHORITY_DECISION_REQUEST.options);
    assert.equal(decision.status, 'pending');

    const resumeService = new ResumeService(db, 'ws-d3c1b-human', registry);
    await resumeService.resume(decision.id, {
      selectedOptionId: 'dedicated-server',
      rationale: 'Consistency matters more than hosting cost for this increment.',
      resolvedAt: new Date().toISOString(),
      resolvedBy: 'reviewer@example.com',
    });

    const run = new WorkflowRunRepository(db).findById(workflowRunId);
    assert.equal(run?.status, 'complete', `expected the run to complete via commit; got status=${run?.status}`);

    const finalWorkItem = new WorkItemRepository(db).findById(workItemId);
    assert.equal(finalWorkItem?.state, 'in_review');

    const finalDefinition = await fs.readFile(path.join(root, definitionPath), 'utf-8');
    assert.ok(finalDefinition.includes('status: DECIDED'), 'the fact must become DECIDED');
    assert.ok(finalDefinition.includes('source: decision'), 'the fact\'s source must become decision');
    assert.ok(finalDefinition.includes(`decision: ${decision.id}`), 'the Definition must reference the REAL resolved Decision id');
    assert.ok(finalDefinition.includes('selected: dedicated-server'), 'the Definition must record the human\'s actual selected option');

    const resolvedDecision = decisionRepo.findById(decision.id);
    assert.equal(resolvedDecision?.status, 'resolved');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// Part C — EXPLORE_AS_WORK
// ============================================================================

test('D.3c1b: EXPLORE_AS_WORK records a bounded exploration need and terminates cleanly — Definition stays not-ready, no WorkItem/WorkProposal is created', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'd3c1b-explore-'));
  try {
    const workItemId = 'wi-explore-1';
    const objectiveId = 'obj-explore-1';
    const definitionPath = `.sle/work/${workItemId}/definition.md`;
    const readinessPath = `.sle/work/${workItemId}/readiness.md`;
    const explorationPath = `.sle/work/${workItemId}/exploration-need.md`;

    const db = openDatabase(':memory:');
    seedWorkItem(db, workItemId);
    const artifacts = new ArtifactRepository(db);

    const provider = new SequenceLLMProvider([
      definitionOutput(
        '## Facts\n- id: sync-latency-budget\n  statement: Whether client-side prediction can hit the target latency budget.\n  status: UNKNOWN\n  source: human',
        definitionPath,
      ),
      readinessOutput(
        'fail', 'explore',
        'EXPLORE_AS_WORK — fact sync-latency-budget: answering requires a prototype/benchmark, not reading or reasoning.',
        readinessPath,
      ),
      definitionOutput(
        'Exact question: can client-side prediction hit the <100ms target latency budget?\n' +
        'Why not CAN_RESOLVE: no existing measurement exists in this repository.\n' +
        'Proposed method: prototype + benchmark.\n' +
        'Expected evidence: measured round-trip latency under simulated network conditions.\n' +
        'Exit criterion: a measured latency figure the Definition can cite.',
        explorationPath,
      ),
    ]);

    const cm = new ContextManager(root, DEFAULT_CONFIG);
    const agentRunner = new AgentRunner(cm, provider, root, makeRunArtifactsStub(), { model: 'test' }, undefined, artifacts);
    const engine = makeEngine(agentRunner, root);

    const workflowRunId = `run-explore-${randomUUID()}`;
    const result = await engine.run(
      'define-work', workflowRunId, 'goal',
      undefined, workItemId, undefined, undefined, objectiveId, [], [],
    );

    assert.equal(result.status, 'complete', result.error);
    assert.equal(result.final_step_id, 'commit');
    assert.equal(result.iterations_used, 1, 'EXPLORE_AS_WORK must never increment iteration');

    const explorationNeed = await fs.readFile(path.join(root, explorationPath), 'utf-8');
    assert.ok(explorationNeed.includes('Exact question'));
    assert.ok(explorationNeed.includes('Exit criterion'));

    // The Definition's fact ledger is untouched by this path — the fact
    // stays exactly as the readiness review found it (UNKNOWN), the
    // Definition remains not-ready. No WorkItem-creation or WorkProposal
    // mechanism exists anywhere in this workflow to have run.
    const finalDefinition = await fs.readFile(path.join(root, definitionPath), 'utf-8');
    assert.ok(finalDefinition.includes('status: UNKNOWN'));
    assert.ok(!finalDefinition.includes('status: KNOWN'), 'EXPLORE_AS_WORK must never mark the fact KNOWN/resolved');

    const workItemRows = new WorkItemRepository(db);
    assert.equal(workItemRows.findById(workItemId)?.state, 'running', 'no new/transitioned WorkItem beyond the one already dispatched for this run');

    const explorationArtifacts = artifacts.listByWorkflowRun(workflowRunId).filter((a) => a.type === 'exploration-need');
    assert.equal(explorationArtifacts.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// Part D — precedence
// ============================================================================

test('D.3c1b: GAP_CLASSIFICATION_PRECEDENCE is CAN_RESOLVE, DEFER, HUMAN_DECISION, EXPLORE_AS_WORK, in that exact order', () => {
  assert.deepStrictEqual(GAP_CLASSIFICATION_PRECEDENCE, ['CAN_RESOLVE', 'DEFER', 'HUMAN_DECISION', 'EXPLORE_AS_WORK']);
});

test('D.3c1b: READINESS_ROUTE_CONTRACT renders precedence in exactly GAP_CLASSIFICATION_PRECEDENCE order for a review step declaring all four routes', () => {
  const text = READINESS_ROUTE_CONTRACT(['CAN_RESOLVE', 'DEFER', 'HUMAN_DECISION', 'EXPLORE_AS_WORK']);
  const indices = GAP_CLASSIFICATION_PRECEDENCE.map((c) => text.indexOf(c, text.indexOf('precedence')));
  for (let i = 1; i < indices.length; i++) {
    assert.ok(indices[i] > indices[i - 1], `expected '${GAP_CLASSIFICATION_PRECEDENCE[i]}' to appear after '${GAP_CLASSIFICATION_PRECEDENCE[i - 1]}' in the precedence listing`);
  }
});

test('D.3c1b: definition-readiness-review\'s actual instruction text locks CAN_RESOLVE before DEFER before HUMAN_DECISION before EXPLORE_AS_WORK', () => {
  const review = DEFINE_WORK.steps.find((s) => s.id === 'definition-readiness-review')!;
  const instruction = review.instruction ?? '';
  const precedenceSection = instruction.slice(instruction.indexOf('precedence'));
  let lastIndex = -1;
  for (const classification of GAP_CLASSIFICATION_PRECEDENCE) {
    const idx = precedenceSection.indexOf(classification);
    assert.ok(idx !== -1, `expected '${classification}' to appear in the precedence section`);
    assert.ok(idx > lastIndex, `expected '${classification}' to appear after the previous classification in precedence order`);
    lastIndex = idx;
  }
});
