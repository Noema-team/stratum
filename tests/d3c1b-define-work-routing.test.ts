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
import { canonicalizeDefinitionContent } from './fixtures/canonical-definition.js';
import { parseDefinition, validateDefinitionArtifactText } from '../src/workflow/methodology/definition-artifact.js';
import { createReviewRouteDeriver } from '../src/workflow/methodology/readiness-artifact.js';
// D.3d.5 commit 2 — test runners drive the same deterministic definition gate as production.
const TEST_INPUT_VALIDATORS = { definition: validateDefinitionArtifactText };
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
  GAP_CLASSIFICATION,
  GAP_CLASSIFICATION_PRECEDENCE,
  READINESS_RUBRIC,
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
  // D.3d.5 commit 2 — scripted definitions are canonical artifacts.
  content = canonicalizeDefinitionContent(content);
  return [
    '<!-- SLE-OUTPUT', 'role: explorer', 'node: define-work',
    'artifacts:', '  - id: definition', `    path: ${outPath}`, '-->', '',
    `## ${outPath}`, '', content,
  ].join('\n');
}

// D.3d.5 commit 3 — review outputs carry structured gap classifications in
// canonical front matter (the artifact FILE body); Stratum derives the route
// deterministically — the classification, never a model-declared token,
// drives routing. `classification` is the legacy route-token shorthand
// ('refine'|'defer'|'human'|'explore') mapped to its classification; pass an
// array to classify multiple gaps (precedence then applies mechanically).
const CLASSIFICATION_FOR_TOKEN: Record<string, string> = {
  refine: 'CAN_RESOLVE',
  defer: 'DEFER',
  human: 'HUMAN_DECISION',
  explore: 'EXPLORE_AS_WORK',
};

function readinessOutput(
  verdict: 'pass' | 'fail',
  classification: string | string[] | undefined,
  content: string,
  outPath: string,
): string {
  const gaps = (classification === undefined ? [] : Array.isArray(classification) ? classification : [classification])
    .map((c) => ({
      target: 'gap-under-review',
      description: content.slice(0, 80),
      classification: CLASSIFICATION_FOR_TOKEN[c] ?? c,
      reason: 'see body',
    }));
  const fm = [
    '---',
    'schemaVersion: 1',
    'gaps:',
    ...(gaps.length > 0 ? gaps.map((g) => '  - ' + JSON.stringify({ closure: 'see body', ...g })) : ['  []']),
    '---',
  ].join('\n');
  const lines = ['<!-- SLE-OUTPUT', 'role: explorer', 'node: define-work', `verdict: ${verdict}`];
  lines.push('artifacts:', '  - id: readiness', `    path: ${outPath}`, '-->', '');
  lines.push(`## ${outPath}`, '', fm, '', content);
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
    const agentRunner = new AgentRunner(cm, provider, root, makeRunArtifactsStub(), { model: 'test', inputValidators: TEST_INPUT_VALIDATORS, deriveReviewRoute: createReviewRouteDeriver() }, undefined, artifacts);
    const engine = makeEngine(agentRunner, root);

    const result = await engine.run(
      'define-work', `run-defer-${randomUUID()}`, 'Add real-time multiplayer to Evershift',
      undefined, workItemId, undefined, undefined, objectiveId, [], [],
    );

    assert.equal(result.status, 'complete', result.error);
    assert.equal(result.final_step_id, 'commit');
    assert.equal(result.iterations_used, 1, 'DEFER must never increment iteration');

    const finalDefinition = await fs.readFile(path.join(root, definitionPath), 'utf-8');
    assert.ok(finalDefinition.includes('"status":"DEFERRED"'));
    assert.ok(!finalDefinition.includes('"status":"ASSUMED"'), 'the DEFER gap must not remain ASSUMED after apply-deferred-gaps');
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
    const agentRunner = new AgentRunner(cm, provider, root, makeRunArtifactsStub(), { model: 'test', inputValidators: TEST_INPUT_VALIDATORS, deriveReviewRoute: createReviewRouteDeriver() }, undefined, artifacts);
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
    assert.ok(finalDefinition.includes('"status":"DEFERRED"'), 'the DEFER gap must still be markable DEFERRED at the final allowed iteration');
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
    const agentRunner = new AgentRunner(cm, provider, root, makeRunArtifactsStub(), { model: 'test', inputValidators: TEST_INPUT_VALIDATORS, deriveReviewRoute: createReviewRouteDeriver() }, undefined, artifacts);
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
  const agentRunner = new AgentRunner(cm, provider, root, makeRunArtifactsStub(), { model: 'test', inputValidators: TEST_INPUT_VALIDATORS, deriveReviewRoute: createReviewRouteDeriver() }, undefined, artifacts);
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
    assert.ok(finalDefinition.includes('"status":"DECIDED"'), 'the fact must become DECIDED');
    assert.ok(finalDefinition.includes('"source":"decision"'), 'the fact\'s source must become decision');
    assert.ok(finalDefinition.includes(`"decisionRef":"${decision.id}"`), 'the Definition must reference the REAL resolved Decision id');
    assert.ok(finalDefinition.includes('"selected":"dedicated-server"'), 'the Definition must record the human\'s actual selected option');

    const resolvedDecision = decisionRepo.findById(decision.id);
    assert.equal(resolvedDecision?.status, 'resolved');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// D.3c1b.1 — two distinct HUMAN_DECISION facts, resolved one at a time
// through the SAME reusable human-decision-checkpoint step id (unlike
// D.3c0.2's chained-checkpoint test, which used two DIFFERENT checkpoint
// step ids). Proves re-entering one checkpoint step twice within the same
// WorkflowRun carries no cross-Decision journal/cursor/linkage defect.

const RECONNECT_DECISION_REQUEST = {
  type: 'human_decision',
  title: 'Reconnect policy after disconnection',
  summary: 'The bounded scope needs a policy for what happens when a player disconnects mid-session.',
  options: [
    { id: 'resume-session', label: 'Resume session', description: 'The player can rejoin and resume where they left off.' },
    { id: 'restart-session', label: 'Restart session', description: 'The player must restart the session from the beginning.' },
    { id: 'no-reconnect', label: 'No reconnect', description: 'A disconnected player cannot rejoin this session.' },
  ],
};

const AUTHORITY_STATEMENT = 'Which network authority model multiplayer uses.';
const RECONNECT_STATEMENT = 'What happens when a player disconnects mid-session.';

function unknownFactLine(id: string, statement: string): string {
  return `- id: ${id}\n  statement: ${statement}\n  status: UNKNOWN\n  source: human`;
}
function decidedFactLine(id: string, statement: string, decisionId: string, selectedOptionId: string): string {
  return `- id: ${id}\n  statement: ${statement}\n  status: DECIDED\n  source: decision\n  decision: ${decisionId}\n  selected: ${selectedOptionId}`;
}
// Extracts the (real, previously-unknown) Decision id + selected option id
// straight out of the assembled "## Human Decision" context, exactly as the
// single-decision test above does, then rewrites the WHOLE fact ledger
// (factId's fact becomes DECIDED; priorFactsText carries every other fact
// forward unchanged) — matching outputArtifact's single-section-overwrite
// contract (apply-human-decision's declared output is the whole Definition,
// not a diff).
function applyDecisionResponse(
  factId: string, statement: string, priorFactsText: string,
): (params: LLMCompletionParams) => string {
  return (params: LLMCompletionParams): string => {
    const userMessage = String(params.messages[1]?.content ?? '');
    const decisionIdMatch = userMessage.match(/Decision id: `([^`]+)`/);
    const optionIdMatch = userMessage.match(/option id: `([^`]+)`/);
    assert.ok(decisionIdMatch, `expected a rendered Decision id in the assembled context: ${userMessage}`);
    assert.ok(optionIdMatch, `expected a rendered selected option id: ${userMessage}`);
    const decisionId = decisionIdMatch![1];
    const selectedOptionId = optionIdMatch![1];
    return definitionOutput(
      `## Facts\n${priorFactsText}\n${decidedFactLine(factId, statement, decisionId, selectedOptionId)}`,
      `.sle/work/${WI_REPEATED_CHECKPOINT}/definition.md`,
    );
  };
}

// D.3d.5 commit 2 — facts are canonical now: read them through the typed
// parser (JSON flow style has no markdown bullets to regex).
function extractFactBlock(text: string, factId: string): string {
  const m = text.match(new RegExp(`- id: ${factId}[\\s\\S]*?(?=\\n- id: |$)`));
  if (m) return m[0];
  try {
    const fact = parseDefinition(text).definition.facts.find((f) => f.id === factId);
    return fact ? JSON.stringify(fact) : '';
  } catch {
    return '';
  }
}

const WI_REPEATED_CHECKPOINT = 'wi-human-repeated';

test('D.3c1b.1: two HUMAN_DECISION facts resolve one at a time through the SAME reusable human-decision-checkpoint step id, with no cross-Decision journal/cursor/linkage defect', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'd3c1b-human-repeated-'));
  try {
    const workItemId = WI_REPEATED_CHECKPOINT;
    const definitionPath = `.sle/work/${workItemId}/definition.md`;
    const readinessPath = `.sle/work/${workItemId}/readiness.md`;
    const decisionRequestPath = `.sle/work/${workItemId}/decision-request.json`;

    const db = openDatabase(':memory:');
    const objective = makeObjective('proj-d3c1b-human-repeated');
    new WorkspaceRepository(db).save({ id: 'ws-d3c1b-human-repeated', name: 'ws', createdAt: objective.createdAt });
    new ProjectRepository(db).save({
      id: 'proj-d3c1b-human-repeated', workspaceId: 'ws-d3c1b-human-repeated', name: 'proj', status: 'active', priority: 0,
      createdAt: objective.createdAt, updatedAt: objective.createdAt,
    });
    new ObjectiveRepository(db).save(objective);
    new WorkItemRepository(db).save({
      id: workItemId, projectId: 'proj-d3c1b-human-repeated', objectiveId: objective.id, repositoryIds: [],
      title: 'Definition work item', goal: 'Add real-time multiplayer to Evershift', workflowId: 'define-work',
      state: 'ready', priority: 0,
      acceptanceCriteria: [], constraints: [], requiredEvidence: [],
      dependencies: [], createdAt: objective.createdAt, updatedAt: objective.createdAt,
    });
    const artifacts = new ArtifactRepository(db);

    // Index 6 (round B's apply-human-decision) is assigned once decisionA's
    // real id is known, between the two resume() calls — see below.
    const responses: Array<string | ((params: LLMCompletionParams) => string)> = [
      // 0: synthesize-definition — two open HUMAN_DECISION facts.
      definitionOutput(
        `## Facts\n${unknownFactLine('authority-model', AUTHORITY_STATEMENT)}\n${unknownFactLine('reconnect-policy', RECONNECT_STATEMENT)}`,
        definitionPath,
      ),
      // 1: definition-readiness-review — fail/human, chooses authority-model first.
      readinessOutput(
        'fail', 'human',
        'HUMAN_DECISION — fact authority-model: a genuine product tradeoff. HUMAN_DECISION — ' +
        'fact reconnect-policy: also a genuine product tradeoff, not yet asked (one checkpoint asks one question).',
        readinessPath,
      ),
      // 2: prepare-human-decision — request A (authority-model).
      jsonOutput(AUTHORITY_DECISION_REQUEST, decisionRequestPath),
      // 3: apply-human-decision — round A: authority-model becomes DECIDED.
      applyDecisionResponse('authority-model', AUTHORITY_STATEMENT, unknownFactLine('reconnect-policy', RECONNECT_STATEMENT)),
      // 4: post-human-readiness-review — fail/human again, reconnect-policy now the sole blocker.
      readinessOutput(
        'fail', 'human',
        'HUMAN_DECISION — fact reconnect-policy: a genuine product tradeoff only a human can authorize. authority-model is DECIDED.',
        readinessPath,
      ),
      // 5: prepare-human-decision — request B (reconnect-policy), SAME step id as request A.
      jsonOutput(RECONNECT_DECISION_REQUEST, decisionRequestPath),
      // 6: (placeholder — replaced below once Decision A's real id is known)
      '',
      // 7: post-human-readiness-review — passes.
      readinessOutput('pass', undefined, 'All seven dimensions pass; both facts are DECIDED.', readinessPath),
    ];
    const provider = new SequenceLLMProvider(responses);

    const adapter = makeProductionAdapter(root, db, artifacts, provider);
    const registry = new ExecutorRegistry();
    registry.register(adapter);

    const scheduler = new Scheduler(db, 'ws-d3c1b-human-repeated', registry);
    const dispatchResults = await scheduler.tick();
    assert.equal(dispatchResults[0].outcome, 'dispatched', JSON.stringify(dispatchResults[0]));
    const workflowRunId = dispatchResults[0].workflowRunId!;

    const decisionRepo = new DecisionRepository(db);
    const afterFirstDispatch = decisionRepo.listByWorkItem(workItemId);
    assert.equal(afterFirstDispatch.length, 1, 'exactly one Decision (A) must exist after initial dispatch');
    const decisionA = afterFirstDispatch[0];
    assert.equal(decisionA.title, AUTHORITY_DECISION_REQUEST.title);

    const resumeService = new ResumeService(db, 'ws-d3c1b-human-repeated', registry);
    await resumeService.resume(decisionA.id, {
      selectedOptionId: 'dedicated-server',
      rationale: 'Consistency matters more than hosting cost for this increment.',
      resolvedAt: new Date().toISOString(),
      resolvedBy: 'reviewer@example.com',
    });

    // ── Intermediate state: Decision B now pending, at the SAME checkpoint
    // step id Decision A used, within the SAME WorkflowRun. ──────────────
    const afterRoundA = decisionRepo.listByWorkItem(workItemId);
    assert.equal(afterRoundA.length, 2, 'exactly two Decisions must exist now — A and B, no third');
    const decisionAResolved = afterRoundA.find((d) => d.id === decisionA.id)!;
    const decisionB = afterRoundA.find((d) => d.id !== decisionA.id)!;
    assert.equal(decisionAResolved.status, 'resolved');
    assert.equal(decisionB.status, 'pending');
    assert.notEqual(decisionA.id, decisionB.id);
    assert.equal(decisionB.title, RECONNECT_DECISION_REQUEST.title);

    const runAfterRoundA = new WorkflowRunRepository(db).findById(workflowRunId);
    assert.equal(runAfterRoundA?.status, 'halted');
    assert.equal(runAfterRoundA?.current_step_id, 'human-decision-checkpoint');
    assert.equal(runAfterRoundA?.awaiting_checkpoint, 'human-decision-checkpoint');

    const subjectRefA = decisionAResolved.subjectRef as { workflowRunId?: string; stepId?: string };
    const subjectRefB = decisionB.subjectRef as { workflowRunId?: string; stepId?: string };
    assert.equal(subjectRefA.workflowRunId, workflowRunId);
    assert.equal(subjectRefB.workflowRunId, workflowRunId, 'Decision B must belong to the SAME WorkflowRun as Decision A');
    assert.equal(subjectRefA.stepId, 'human-decision-checkpoint');
    assert.equal(subjectRefB.stepId, 'human-decision-checkpoint', 'Decision B is raised at the same reusable checkpoint step id');

    const definitionAfterRoundA = await fs.readFile(path.join(root, definitionPath), 'utf-8');
    assert.ok(definitionAfterRoundA.includes(`"decisionRef":"${decisionA.id}"`), 'the Definition must already reference Decision A\'s real id');
    const factAAfterRoundA = extractFactBlock(definitionAfterRoundA, 'authority-model');
    assert.ok(factAAfterRoundA.includes('"status":"DECIDED"') && factAAfterRoundA.includes('"source":"decision"'));
    const factBAfterRoundA = extractFactBlock(definitionAfterRoundA, 'reconnect-policy');
    assert.ok(factBAfterRoundA.includes('"status":"UNKNOWN"'), 'fact B must NOT have been silently marked DECIDED');
    assert.ok(!factBAfterRoundA.includes('DECIDED'));

    // ── Resolve Decision B — the SECOND pass through the SAME checkpoint step. ──
    responses[6] = applyDecisionResponse(
      'reconnect-policy', RECONNECT_STATEMENT,
      decidedFactLine('authority-model', AUTHORITY_STATEMENT, decisionA.id, 'dedicated-server'),
    );

    await resumeService.resume(decisionB.id, {
      selectedOptionId: 'resume-session',
      rationale: 'Players should not lose progress on a transient disconnect.',
      resolvedAt: new Date().toISOString(),
      resolvedBy: 'reviewer@example.com',
    });

    const finalRun = new WorkflowRunRepository(db).findById(workflowRunId);
    assert.equal(finalRun?.status, 'complete', `expected the SAME WorkflowRun to complete via commit; got status=${finalRun?.status}`);

    const finalDecisions = decisionRepo.listByWorkItem(workItemId);
    assert.equal(finalDecisions.length, 2, 'no third Decision must have been created');
    assert.ok(finalDecisions.every((d) => d.status === 'resolved'), 'both Decisions must be resolved');

    const finalDefinition = await fs.readFile(path.join(root, definitionPath), 'utf-8');
    assert.ok(finalDefinition.includes(`"decisionRef":"${decisionA.id}"`), 'the Definition must reference Decision A\'s real id');
    assert.ok(finalDefinition.includes(`"decisionRef":"${decisionB.id}"`), 'the Definition must reference Decision B\'s real id');
    const factAFinal = extractFactBlock(finalDefinition, 'authority-model');
    const factBFinal = extractFactBlock(finalDefinition, 'reconnect-policy');
    assert.ok(factAFinal.includes('"status":"DECIDED"') && factAFinal.includes('"source":"decision"'));
    assert.ok(factBFinal.includes('"status":"DECIDED"') && factBFinal.includes('"source":"decision"'));
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
    const agentRunner = new AgentRunner(cm, provider, root, makeRunArtifactsStub(), { model: 'test', inputValidators: TEST_INPUT_VALIDATORS, deriveReviewRoute: createReviewRouteDeriver() }, undefined, artifacts);
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
    assert.ok(finalDefinition.includes('"status":"UNKNOWN"'));
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

// ── D.3d.3 — every readiness-review step receives the drafter's contract ──────
//
// The DeepSeek Pro live qualification (D.3d Layer B, PARTIAL observations #2
// and #5) exposed what happens when the readiness reviewer does not see the
// Definition contract: the reviewer passed (and in #5 explicitly PASSED) a
// Definition whose fact ledger omitted every authoritative supplied fact,
// because the rubric's consistency and risky-assumptions dimensions are only
// judgeable against the contract that defines what KNOWN/ASSUMED/UNKNOWN
// mean. The review steps run single-turn and cannot read any methodology
// document at runtime, so the contract must be composed into the
// instruction itself — for ALL THREE readiness-review steps, not just the
// first one.

test('D.3d.3: every readiness-review step receives the DEFINITION_CONTRACT in its instruction', () => {
  const reviewStepIds = ['definition-readiness-review', 'post-defer-readiness-review', 'post-human-readiness-review'];
  // Distinctive fragments that exist only inside DEFINITION_CONTRACT — if
  // the contract is dropped from an instruction, these vanish with it.
  const contractFragments = ['Fact ledger rules:', 'status is exactly one of:', 'source records where the fact came from:'];
  for (const stepId of reviewStepIds) {
    const step = DEFINE_WORK.steps.find((s) => s.id === stepId)!;
    assert.ok(step, `expected step ${stepId} to exist`);
    const instruction = step.instruction ?? '';
    for (const fragment of contractFragments) {
      assert.ok(
        instruction.includes(fragment),
        `${stepId}'s instruction must include the DEFINITION_CONTRACT fragment '${fragment}' — a readiness reviewer without the Definition contract cannot judge ledger/epistemic discipline`,
      );
    }
    // The contract must precede the rubric: the reviewer reads the contract
    // as the definition of the artifact BEFORE judging it against the rubric.
    const contractIdx = instruction.indexOf('Fact ledger rules:');
    const rubricIdx = instruction.indexOf('seven dimensions');
    assert.ok(
      contractIdx !== -1 && rubricIdx !== -1 && contractIdx < rubricIdx,
      `${stepId}: DEFINITION_CONTRACT must appear before the readiness rubric in the instruction`,
    );
  }
});

// ============================================================================
// D.3d.4 — the semantic-contract correction, driven by cross-model evidence.
//
// DeepSeek V4 Pro (4/5 PARTIAL runs) and GLM 5.3 Flash (1/1) independently
// converged on escalating "what does loyalty do here?" as HUMAN_DECISION
// when the Objective stated "NPCs have loyalty" beside "faction relations
// affect dialogue and trade" — a reasonable reading of an authority
// boundary the input never settled. The GLM run additionally showed the
// reviewer routing straight to `human` while the Definition's ledger
// weakened every authoritative fact: having DEFINITION_CONTRACT in context
// (D.3d.3) is not the same as contract compliance being an explicit
// readiness precondition that participates in route precedence. These two
// tests lock the two generic methodology corrections so they cannot
// silently regress.
// ============================================================================

test('D.3d.4: GAP_CLASSIFICATION forbids manufacturing relationships between independently stated facts', () => {
  // The constants wrap lines, so match against normalized whitespace.
  const text = GAP_CLASSIFICATION.replace(/\s+/g, ' ');
  // The rule lives in the HUMAN_DECISION block — it refines exactly the
  // boundary where DeepSeek Pro and GLM 5.3 Flash failed.
  const humanBlock = text.slice(text.indexOf('- HUMAN_DECISION'), text.indexOf('- DEFER'));
  assert.ok(
    humanBlock.includes('a fact being MENTIONED in the Objective does not imply that it participates'),
    'the HUMAN_DECISION block must state that mentioning a fact does not imply participation in every behavior',
  );
  assert.ok(
    humanBlock.includes('Never manufacture a relationship between independently stated facts'),
    'the HUMAN_DECISION block must forbid manufacturing relationships and treating their absence as an open scope question',
  );
  assert.ok(
    humanBlock.includes('only a relationship actually required to satisfy the stated goal'),
    'the rule must be bounded: only goal/requirement/constraint/acceptance-required relationships need resolving',
  );
  // The rule must NOT override repository provenance: resting epistemic
  // status defers to DEFINITION_CONTRACT's one epistemic rule — the Redis
  // counterexample: an unconnected repository-state claim must not become
  // KNOWN/source:human merely because the Objective mentions it.
  assert.ok(
    humanBlock.includes('requires no relationship to be invented or resolved'),
    'the rule must state the resting consequence: no relationship to invent or resolve',
  );
  assert.ok(
    humanBlock.includes('the epistemic status and provenance DEFINITION_CONTRACT requires'),
    'the resting epistemic status must defer to DEFINITION_CONTRACT, not be fixed by this rule',
  );
  assert.ok(
    humanBlock.includes('an assertion about repository reality is not KNOWN merely because the Objective states it'),
    'the rule must preserve the product-intent vs repository-assertion distinction',
  );
  assert.ok(
    humanBlock.includes('still requires repository or investigation evidence first'),
    'repository-state assertions must still require verification before KNOWN',
  );
});

test('D.3d.4: READINESS_RUBRIC makes contract compliance an explicit CAN_RESOLVE precondition that outranks human escalation', () => {
  const rubric = READINESS_RUBRIC.replace(/\s+/g, ' ');
  const preconditionIdx = rubric.indexOf('verify the Definition obeys DEFINITION_CONTRACT');
  assert.ok(preconditionIdx !== -1, 'the rubric must open with a contract-compliance precondition');
  const dimensionsIdx = rubric.indexOf('1. Outcome');
  assert.ok(
    preconditionIdx < dimensionsIdx,
    'the contract-compliance precondition must appear BEFORE the seven dimensions',
  );
  // All three defect classes the live qualification exposed must be named.
  assert.ok(rubric.includes('absent from the ledger'), 'absence from the ledger must be a named contract defect');
  assert.ok(rubric.includes('silently weakened to ASSUMED/UNKNOWN'), 'silent weakening must be a named contract defect');
  assert.ok(rubric.includes('provenance it does not have'), 'invalid provenance must be a named contract defect');
  // The precondition must apply ONE epistemic rule — the same distinction
  // DEFINITION_CONTRACT draws — not a competing one:
  assert.ok(
    rubric.includes('authoritative product/domain intent is KNOWN (source: human)'),
    'stated product/domain intent must be KNOWN with source: human',
  );
  assert.ok(
    rubric.includes('NOT KNOWN merely because the Objective states it'),
    'a repository-state assertion must not become KNOWN merely because the Objective states it',
  );
  assert.ok(
    rubric.includes('ASSUMED, source: human until repository or investigation evidence'),
    'repository-state assertions must follow the existing verification rule',
  );
  // The precedence consequence is the operational point: contract defects
  // are CAN_RESOLVE and refine before any human question.
  assert.ok(
    rubric.includes('CAN_RESOLVE Definition defect'),
    'contract defects must be classified CAN_RESOLVE',
  );
  assert.ok(
    /refine comes first/.test(rubric),
    'the rubric must state that refine precedes human escalation when both a ledger defect and a candidate question exist',
  );
});

// ============================================================================
// D.3c1b.1 — DEFER runtime semantics: DEFER is not blocking. These lock the
// wording fix so the runtime instruction can never regress to saying a
// DEFER fact "blocks" the candidate bounded scope (see GAP_CLASSIFICATION:
// "the gap is real but does NOT block the bounded scope").
// ============================================================================

test('D.3c1b.1: READINESS_ROUTE_CONTRACT\'s defer route line never says the DEFER gap itself blocks the candidate scope', () => {
  const text = READINESS_ROUTE_CONTRACT(['CAN_RESOLVE', 'DEFER', 'HUMAN_DECISION', 'EXPLORE_AS_WORK']);
  const deferLine = text.split('\n').find((l) => l.trim().startsWith('- defer'));
  assert.ok(deferLine, `expected a '- defer' route line in: ${text}`);
  assert.ok(/does not block/i.test(deferLine!), `the defer route line must explicitly say the gap does not block: "${deferLine}"`);
  assert.ok(
    !/DEFER gap (?:is |remains )?blocking|blocking DEFER gap|\bremains blocking\b/i.test(deferLine!),
    `the defer route line must never call the DEFER gap itself blocking: "${deferLine}"`,
  );
  assert.ok(/DEFERRED/.test(deferLine!), 'the defer route line must describe the required DEFERRED ledger transition');

  // The other three routes ARE genuinely blocking — the fix must not have
  // swept blocking language off of them too.
  for (const token of ['refine', 'human', 'explore']) {
    const line = text.split('\n').find((l) => l.trim().startsWith(`- ${token}`));
    assert.ok(line, `expected a '- ${token}' route line`);
    assert.ok(/blocks?/i.test(line!), `the ${token} route line must still say its gap blocks the candidate scope: "${line}"`);
  }
});

test('D.3c1b.1: READINESS_ROUTE_CONTRACT states the DEFER finalization rule — a DEFER-classified fact must already be DEFERRED before verdict:pass', () => {
  const text = READINESS_ROUTE_CONTRACT(['CAN_RESOLVE', 'DEFER', 'HUMAN_DECISION', 'EXPLORE_AS_WORK']);
  assert.ok(/status: DEFERRED/.test(text), 'expected the finalization rule to name the required DEFERRED status');
  assert.ok(/verdict: pass/.test(text), 'expected the finalization rule to be phrased against verdict: pass eligibility');
  // A review step that does not declare a defer route at all (post-defer-
  // readiness-review) has no defer route line and no defer-specific
  // finalization rule to state — never rendered when 'DEFER' isn't in scope.
  const noDefer = READINESS_ROUTE_CONTRACT(['CAN_RESOLVE', 'HUMAN_DECISION', 'EXPLORE_AS_WORK']);
  assert.ok(!/status: DEFERRED/.test(noDefer));
  assert.ok(!noDefer.split('\n').some((l) => l.trim().startsWith('- defer')));
});

test('D.3c1b.1: READINESS_ROUTE_CONTRACT never implies the DEFERRED transition is what makes a DEFER gap non-blocking — it is already non-blocking; the transition is ledger bookkeeping for pass-eligibility', () => {
  const text = READINESS_ROUTE_CONTRACT(['CAN_RESOLVE', 'DEFER', 'HUMAN_DECISION', 'EXPLORE_AS_WORK']);
  // The gap is non-blocking from the moment it is correctly classified
  // DEFER — the DEFERRED transition changes pass-eligibility bookkeeping,
  // never whether the gap blocks the scope. None of these phrasings may
  // appear anywhere in the rendered contract.
  for (const antipattern of [/becomes? non-blocking/i, /no longer blocking/i]) {
    assert.ok(!antipattern.test(text), `READINESS_ROUTE_CONTRACT must never say a DEFER gap "${antipattern}" — it is already non-blocking: ${text}`);
  }
  // The positive fix: DEFER's non-blocking status is stated up front (the
  // route line), and the finalization rule is framed as ledger bookkeeping/
  // pass-eligibility, not as a change in whether the gap blocks the scope.
  const deferLine = text.split('\n').find((l) => l.trim().startsWith('- defer'));
  assert.ok(/does not block/i.test(deferLine ?? ''));
  assert.ok(/does not complete the required ledger bookkeeping/i.test(text));
  assert.ok(/already non-blocking/i.test(text));
});

test('D.3c1b.1: no define-work step instruction reintroduces the specific "DEFER gap ... blocking" phrasing this closure fixed', () => {
  // Targeted literal-phrase regression locks (not a generic classifier —
  // "DEFER was never blocking" is correct wording and must NOT trip this):
  // the two exact antipatterns the D.3c1b.1 fix removed from
  // READINESS_ROUTE_CONTRACT's rendered output and post-defer-readiness-
  // review's instruction, respectively.
  const antipatterns = [/DEFER gap (?:is |remains )?blocking/i, /blocking DEFER gap/i, /no longer a blocking gap/i];
  for (const step of DEFINE_WORK.steps) {
    const instruction = step.instruction ?? '';
    for (const pattern of antipatterns) {
      assert.ok(!pattern.test(instruction), `step '${step.id}' instruction must not reintroduce "${pattern}"`);
    }
  }
});

test('D.3c1b.1: post-defer-readiness-review\'s instruction explicitly says DEFER was never blocking, not merely "no longer" blocking', () => {
  const postDefer = DEFINE_WORK.steps.find((s) => s.id === 'post-defer-readiness-review')!;
  assert.match(postDefer.instruction ?? '', /DEFER was never blocking/);
});
