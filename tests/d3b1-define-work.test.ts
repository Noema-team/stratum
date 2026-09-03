// D.3b1 — registers and proves the define-work workflow itself, on top of
// D.3b0's generic seams (semantic review verdict, WorkItem context
// threading, placeholder materialization). See
// docs/developmentPlan/d3b1-define-work.md for the full design rationale.
//
// Part A: the provider capability seam (DynamicLLMProvider) and the
//         regression proving a requiresReviewVerdict step stays on the
//         single-turn path even when the provider supports multi-turn.
// Part B: a generic repository-inspection proof — synthetic workflow/step
//         ids, never define-work or readiness-specific ids — showing a
//         produce step can use AgentLoop to inspect real Git-tracked
//         repository content (including a path outside src/), is denied an
//         untracked path, and still produces exactly its declared output
//         under its role's ceiling.
// Part C: define-work's own structure and end-to-end behavior (CAN_RESOLVE
//         refinement loop to a pass, and cap exhaustion failing closed with
//         artifacts preserved).

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ContextManager, DEFAULT_CONFIG } from '../src/context-manager.js';
import { AgentRunner } from '../src/agent-runner.js';
import { AgentStepRunner } from '../src/execution/agent-step-runner.js';
import { WorkflowEngine, DEFINE_WORK, getWorkflow } from '../src/workflow/index.js';
import { DynamicLLMProvider } from '../src/llm-provider.js';
import { openDatabase } from '../src/storage/database.js';
import {
  ArtifactRepository,
  WorkspaceRepository,
  ProjectRepository,
  WorkItemRepository,
} from '../src/storage/repositories.js';
import type { WorkflowEngineDeps, WorkflowEngineOptions } from '../src/workflow/types.js';
import type { ILLMProvider, LLMCompletionParams, LLMCompletionResult } from '../src/llm-provider.js';
import type {
  IMultiTurnProvider,
  MultiTurnParams,
  MultiTurnResult,
  ToolUseBlock,
} from '../src/agent-loop.js';

// ============================================================================
// Part A — provider capability seam
// ============================================================================

class BareProvider implements ILLMProvider {
  async complete(_p: LLMCompletionParams): Promise<LLMCompletionResult> {
    return { content: 'ok', tokens_used: 1, duration_ms: 1 };
  }
}

class DualCapabilityProvider implements ILLMProvider, IMultiTurnProvider {
  multiTurnCalls = 0;
  async complete(_p: LLMCompletionParams): Promise<LLMCompletionResult> {
    return { content: 'ok', tokens_used: 1, duration_ms: 1 };
  }
  async completeMultiTurn(_p: MultiTurnParams): Promise<MultiTurnResult> {
    this.multiTurnCalls++;
    return { stop_reason: 'end_turn', text: '', tool_uses: [], tokens_used: 1 };
  }
}

test('D.3b1: DynamicLLMProvider exposes completeMultiTurn only when the wrapped provider actually supports it', async () => {
  const bare = new BareProvider();
  const dyn = new DynamicLLMProvider(bare);
  assert.notEqual(typeof (dyn as any).completeMultiTurn, 'function', 'a bare provider must leave the capability absent');

  const dual = new DualCapabilityProvider();
  dyn.setProvider(dual);
  assert.equal(typeof (dyn as any).completeMultiTurn, 'function', 'a dual-capability provider must expose the capability');
  await (dyn as any).completeMultiTurn({ model: 'x', system: '', messages: [], max_tokens: 1, tools: [] });
  assert.equal(dual.multiTurnCalls, 1, 'the wrapper must actually forward the call');

  dyn.setProvider(bare);
  assert.notEqual(typeof (dyn as any).completeMultiTurn, 'function', 'swapping back to a bare provider must remove the capability again, not leave a stale promise');
});

test('D.3b1: a requiresReviewVerdict step stays on the single-turn path even when the provider supports multi-turn, and correctly consumes its verdict', async () => {
  class ThrowingMultiTurnDualProvider implements ILLMProvider, IMultiTurnProvider {
    async complete(_p: LLMCompletionParams): Promise<LLMCompletionResult> {
      return {
        content: [
          '<!-- SLE-OUTPUT',
          'role: explorer',
          'node: readiness-review',
          'verdict: pass',
          'artifacts:',
          '  - id: readiness',
          '    path: .sle/work/readiness.md',
          '-->',
          '',
          '## .sle/work/readiness.md',
          '',
          'All seven dimensions pass.',
        ].join('\n'),
        tokens_used: 10,
        duration_ms: 1,
      };
    }
    async completeMultiTurn(_p: MultiTurnParams): Promise<MultiTurnResult> {
      throw new Error('completeMultiTurn must never be called for a requiresReviewVerdict step');
    }
  }

  const dyn = new DynamicLLMProvider(new ThrowingMultiTurnDualProvider());
  const cm = {
    async assemble() {
      return {
        system_prompt: 'You are an explorer.', artifact_slices: {}, state_summary: '## State',
        task: 'Review.', token_count: 1, truncated: [],
      };
    },
  };
  const ram = { async writeNodeOutput() {} } as any;
  // A mock fs, not the real one: '/project-d3b1' is a synthetic root with no
  // real filesystem backing, so a real fs.mkdir() against it fails outside a
  // root-privileged sandbox (this test only needs to prove the single-turn/
  // verdict-consuming behavior, not a real file write).
  const fsMock = {
    mkdir: async () => {},
    writeFile: async () => {},
    appendFile: async () => {},
    readFile: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
  } as unknown as typeof import('fs').promises;
  const runner = new AgentRunner(cm as any, dyn, '/project-d3b1', ram, { model: 'test' }, fsMock);

  const result = await runner.run('explorer', {
    workflowRunId: 'r1', workflowId: 'synthetic-unfamiliar', stepId: 'review', iteration: 1, revision: 0,
    goal: 'test', projectRoot: '/project-d3b1', requiresReviewVerdict: true,
  } as any);

  assert.ok(result.success, `expected success (single-turn path), got: ${result.error}`);
  assert.equal(result.reviewVerdict, 'pass');
});

// ============================================================================
// Part B — generic repository-inspection proof (real Git repo, real fs)
// ============================================================================

function gitInit(root: string): void {
  execFileSync('git', ['init', '-q'], { cwd: root });
}
function gitAdd(root: string, ...paths: string[]): void {
  execFileSync('git', ['add', ...paths], { cwd: root });
}

class RecordingFs {
  reads: string[] = [];
  wraps(): typeof import('fs').promises {
    return {
      readFile: async (p: unknown, enc: unknown) => {
        this.reads.push(p as string);
        return fs.readFile(p as string, enc as BufferEncoding);
      },
      mkdir: (p: unknown, opts: unknown) => fs.mkdir(p as string, opts as any),
      writeFile: (p: unknown, c: unknown, enc: unknown) => fs.writeFile(p as string, c as string, enc as BufferEncoding),
      appendFile: (p: unknown, c: unknown, enc: unknown) => fs.appendFile(p as string, c as string, enc as BufferEncoding),
      readdir: (p: unknown) => fs.readdir(p as string),
    } as unknown as typeof import('fs').promises;
  }
}

function makeRunArtifactsStub() {
  return {
    async writeNodeOutput() {},
    async updateNodeStatus() {},
  } as any;
}

class ScriptedMultiTurnProvider implements IMultiTurnProvider {
  calls: MultiTurnParams[] = [];
  constructor(private turns: MultiTurnResult[]) {}
  async completeMultiTurn(params: MultiTurnParams): Promise<MultiTurnResult> {
    this.calls.push(params);
    const t = this.turns[this.calls.length - 1];
    if (!t) return { stop_reason: 'end_turn', text: '', tool_uses: [], tokens_used: 1 };
    return t;
  }
}

function toolUseTurn(name: string, input: Record<string, string>, id: string): MultiTurnResult {
  const tu: ToolUseBlock = { type: 'tool_use', id, name, input };
  return { stop_reason: 'tool_use', text: '', tool_uses: [tu], tokens_used: 5 };
}

test('D.3b1: a Definition-producing explorer receives its instruction, inspects tracked repository files (including one outside src/) via AgentLoop, is denied an untracked path, and produces exactly its declared output', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'd3b1-repo-proof-'));
  try {
    await fs.mkdir(path.join(root, 'tests'), { recursive: true });
    await fs.mkdir(path.join(root, '.sle', 'work', 'wi-repo-proof'), { recursive: true });
    await fs.writeFile(path.join(root, 'tests', 'example.test.ts'), 'test("noop", () => {});', 'utf-8');
    // Deliberately untracked — never added to git — and must never be read.
    await fs.writeFile(path.join(root, '.env'), 'SECRET=do-not-read-me', 'utf-8');

    gitInit(root);
    gitAdd(root, 'tests/example.test.ts');

    const instruction = 'Investigate this repository for an existing networking layer before drafting the Definition.';

    const provider = new ScriptedMultiTurnProvider([
      // 1) inspect a tracked file OUTSIDE src/ — proves technology/path independence.
      toolUseTurn('read_file', { path: 'tests/example.test.ts' }, 'tu_1'),
      // 2) attempt an untracked/forbidden path — must be denied, never actually read.
      toolUseTurn('read_file', { path: '.env' }, 'tu_2'),
      // 3) produce exactly the declared output.
      {
        stop_reason: 'end_turn',
        tool_uses: [],
        tokens_used: 10,
        text: [
          '<<<SLE-OUTPUT>>>',
          '### .sle/work/wi-repo-proof/investigation.md',
          'Inspected tests/example.test.ts. No networking layer found under the tracked tree inspected so far.',
          '<<<END-SLE-OUTPUT>>>',
        ].join('\n'),
      },
    ]);

    const recordingFs = new RecordingFs();
    const cm = new ContextManager(root, DEFAULT_CONFIG, recordingFs.wraps());
    const runner = new AgentRunner(
      cm, provider as unknown as ILLMProvider, root, makeRunArtifactsStub(), { model: 'test' }, recordingFs.wraps(),
    );

    const result = await runner.run('explorer', {
      workflowRunId: 'repo-proof-run', workflowId: 'a-synthetic-workflow-not-define-work',
      stepId: 'investigate-repository', iteration: 1, revision: 0,
      goal: 'Prove technology-independent repository inspection', projectRoot: root,
      instruction,
      outputArtifact: { type: 'investigation', ref: 'investigation:proof', path: '.sle/work/wi-repo-proof/investigation.md' },
    } as any);

    // (4) exactly the declared output, (5) role ceiling + exact-match authority preserved.
    assert.ok(result.success, `expected success, got: ${result.error}`);
    assert.deepStrictEqual(result.artifacts_written, ['.sle/work/wi-repo-proof/investigation.md']);
    const written = await fs.readFile(path.join(root, '.sle/work/wi-repo-proof/investigation.md'), 'utf-8');
    assert.ok(written.includes('No networking layer found'));

    // (1) the declarative instruction actually reached the model's input.
    assert.ok(provider.calls.length >= 1);
    const firstUserMessage = provider.calls[0].messages[0];
    assert.equal(firstUserMessage.role, 'user');
    assert.ok(String(firstUserMessage.content).includes(instruction), 'the declared instruction must reach the assembled task text');

    // (2)/(3) the tracked, outside-src/ file was actually read via the real fs.
    const trackedAbs = path.join(root, 'tests/example.test.ts');
    assert.ok(recordingFs.reads.includes(trackedAbs), 'the tracked file outside src/ must have been read');

    // (6) the untracked path must never reach the filesystem at all.
    const untrackedAbs = path.join(root, '.env');
    assert.ok(!recordingFs.reads.includes(untrackedAbs), 'an untracked/forbidden path must never be read');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('D.3b1: repository inspection remains bounded by AgentLoop\'s existing turn cap — it is not given a second, looser cap', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'd3b1-turn-cap-'));
  try {
    gitInit(root);
    const infiniteToolUse: MultiTurnResult[] = Array.from({ length: 20 }, (_, i) =>
      toolUseTurn('read_file', { path: 'nonexistent.md' }, `tu_${i}`),
    );
    const provider = new ScriptedMultiTurnProvider(infiniteToolUse);
    const cm = { async assemble() {
      return { system_prompt: 's', artifact_slices: {}, state_summary: '', task: 't', token_count: 1, truncated: [] };
    } } as any;
    const runner = new AgentRunner(cm, provider as unknown as ILLMProvider, root, makeRunArtifactsStub(), { model: 'test' });

    const result = await runner.run('explorer', {
      workflowRunId: 'cap-run', workflowId: 'a-synthetic-workflow-not-define-work',
      stepId: 'investigate-repository', iteration: 1, revision: 0, goal: 'test', projectRoot: root,
      instruction: 'Keep reading forever.',
    } as any);

    assert.equal(result.success, false);
    assert.match(result.error ?? '', /turns/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// Part C — define-work: structure and end-to-end behavior
// ============================================================================

test('D.3b1: define-work is registered with the expected structure', () => {
  assert.equal(getWorkflow('define-work'), DEFINE_WORK);
  assert.equal(DEFINE_WORK.max_iterations, 4);
  const ids = DEFINE_WORK.steps.map((s) => s.id);
  assert.deepStrictEqual(ids, ['synthesize-definition', 'refine-definition', 'definition-readiness-review', 'commit']);

  const synth = DEFINE_WORK.steps.find((s) => s.id === 'synthesize-definition')!;
  assert.equal(synth.kind, 'produce');
  assert.equal(synth.outputArtifact?.ref, 'definition:{objectiveId}');
  assert.equal(synth.outputArtifact?.path, '.sle/work/{workItemId}/definition.md');

  const refine = DEFINE_WORK.steps.find((s) => s.id === 'refine-definition')!;
  assert.equal(refine.kind, 'produce');
  assert.ok(refine.skip_if, 'refine-definition must skip on iteration 1');
  assert.equal(refine.skip_if!({ iteration: 1 } as any), true);
  assert.equal(refine.skip_if!({ iteration: 2 } as any), false);
  assert.deepStrictEqual(refine.inputArtifactRefs, [
    '.sle/work/{workItemId}/definition.md', '.sle/work/{workItemId}/readiness.md',
  ]);

  const review = DEFINE_WORK.steps.find((s) => s.id === 'definition-readiness-review')!;
  assert.equal(review.kind, 'review');
  assert.equal(review.requiresReviewVerdict, true);
  assert.equal(review.outputArtifact?.type, 'definition-readiness');
  assert.equal(review.outputArtifact?.ref, 'definition-readiness:{objectiveId}');
  assert.equal(review.on_pass?.target_step_id, 'commit');
  assert.equal(review.on_fail?.target_step_id, 'refine-definition');
  assert.equal(review.on_fail?.iteration_loop, true);
  // Physical materialized path, not the semantic ref — ContextManager does
  // not query ArtifactRepository for definition:{objectiveId}.
  assert.deepStrictEqual(review.inputArtifactRefs, ['.sle/work/{workItemId}/definition.md']);

  const commit = DEFINE_WORK.steps.find((s) => s.id === 'commit')!;
  assert.equal(commit.kind, 'commit');
});

test('D.3b1: no step in define-work is gathered by a no-op context.gather step', () => {
  assert.ok(!DEFINE_WORK.steps.some((s) => s.kind === 'gather'), 'define-work must not carry a ceremonial gather step');
});

// -- end-to-end harness --------------------------------------------------

class SequenceLLMProvider implements ILLMProvider {
  calls: LLMCompletionParams[] = [];
  constructor(private responses: string[]) {}
  async complete(params: LLMCompletionParams): Promise<LLMCompletionResult> {
    this.calls.push(params);
    const content = this.responses[this.calls.length - 1] ?? '';
    return { content, tokens_used: 10, duration_ms: 1 };
  }
}

function definitionOutput(content: string, path: string): string {
  return [
    '<!-- SLE-OUTPUT', 'role: explorer', 'node: define-work',
    'artifacts:', `  - id: definition`, `    path: ${path}`, '-->', '',
    `## ${path}`, '', content,
  ].join('\n');
}

function readinessOutput(verdict: 'pass' | 'fail', content: string, path: string): string {
  return [
    '<!-- SLE-OUTPUT', 'role: explorer', 'node: define-work',
    `verdict: ${verdict}`,
    'artifacts:', `  - id: readiness`, `    path: ${path}`, '-->', '',
    `## ${path}`, '', content,
  ].join('\n');
}

function seedWorkItem(db: ReturnType<typeof openDatabase>, workItemId: string): void {
  const now = new Date().toISOString();
  new WorkspaceRepository(db).save({ id: 'ws-d3b1', name: 'ws', createdAt: now });
  new ProjectRepository(db).save({
    id: 'proj-d3b1', workspaceId: 'ws-d3b1', name: 'proj', status: 'active', priority: 0, createdAt: now, updatedAt: now,
  });
  new WorkItemRepository(db).save({
    id: workItemId, projectId: 'proj-d3b1', repositoryIds: [],
    title: 'Definition work item', goal: 'Make Evershift multiplayer-capable', workflowId: 'define-work',
    state: 'running', priority: 0,
    acceptanceCriteria: [], constraints: [], requiredEvidence: [],
    dependencies: [], createdAt: now, updatedAt: now,
  });
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

test('D.3b1: define-work end-to-end — a failed readiness review triggers CAN_RESOLVE refinement, then a pass commits', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'd3b1-e2e-pass-'));
  try {
    const workItemId = 'wi-e2e-1';
    const objectiveId = 'obj-e2e-1';
    const definitionPath = `.sle/work/${workItemId}/definition.md`;
    const readinessPath = `.sle/work/${workItemId}/readiness.md`;

    const db = openDatabase(':memory:');
    seedWorkItem(db, workItemId);
    const artifacts = new ArtifactRepository(db);

    const provider = new SequenceLLMProvider([
      definitionOutput('Definition v1 — no acceptance criteria yet.', definitionPath),
      readinessOutput('fail', 'Dimension 6 (acceptance) fails: no criteria stated.', readinessPath),
      definitionOutput('Definition v2 — acceptance criteria added.', definitionPath),
      readinessOutput('pass', 'All seven dimensions pass.', readinessPath),
    ]);

    const cm = new ContextManager(root, DEFAULT_CONFIG);
    const agentRunner = new AgentRunner(cm, provider, root, makeRunArtifactsStub(), { model: 'test' }, undefined, artifacts);
    const engine = makeEngine(agentRunner, root);

    const result = await engine.run(
      'define-work', 'run-e2e-1', 'Make Evershift multiplayer-capable', undefined, workItemId,
      undefined, undefined, objectiveId,
      [{ description: 'Must stay same-platform', type: 'must' }],
      [{ description: 'Readiness rubric passes' }],
    );

    assert.equal(result.status, 'complete', result.error);
    assert.equal(result.final_step_id, 'commit');
    assert.equal(result.iterations_used, 2);

    const definitionHistory = artifacts.listByWorkflowRun('run-e2e-1').filter((a) => a.ref === `definition:${objectiveId}`);
    assert.equal(definitionHistory.length, 2, 'v1 and v2 must both be recorded');
    const latestDefinition = artifacts.listLatestByWorkflowRun('run-e2e-1').find((a) => a.ref === `definition:${objectiveId}`);
    assert.equal(latestDefinition?.hash, definitionHistory[1].hash);

    const finalDefinition = await fs.readFile(path.join(root, definitionPath), 'utf-8');
    assert.ok(finalDefinition.includes('Definition v2'));
    const finalReadiness = await fs.readFile(path.join(root, readinessPath), 'utf-8');
    assert.ok(finalReadiness.includes('All seven dimensions pass'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('D.3b1: define-work end-to-end — cap exhaustion fails closed, never forces READY, and preserves the final Definition/readiness artifacts', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'd3b1-e2e-cap-'));
  try {
    const workItemId = 'wi-e2e-cap';
    const objectiveId = 'obj-e2e-cap';
    const definitionPath = `.sle/work/${workItemId}/definition.md`;
    const readinessPath = `.sle/work/${workItemId}/readiness.md`;

    const db = openDatabase(':memory:');
    seedWorkItem(db, workItemId);
    const artifacts = new ArtifactRepository(db);

    // Always fails: v1 review fail, refine -> v2 review fail, refine -> v3
    // review fail, refine -> v4 review fail -> next iteration (5) exceeds
    // max_iterations (4) -> cap hit -> halt.
    const provider = new SequenceLLMProvider([
      definitionOutput('Definition v1.', definitionPath),
      readinessOutput('fail', 'v1: still missing acceptance criteria.', readinessPath),
      definitionOutput('Definition v2.', definitionPath),
      readinessOutput('fail', 'v2: cross-platform decision still open (HUMAN_DECISION, unresolved).', readinessPath),
      definitionOutput('Definition v3.', definitionPath),
      readinessOutput('fail', 'v3: same blocker remains — not a CAN_RESOLVE gap.', readinessPath),
      definitionOutput('Definition v4.', definitionPath),
      readinessOutput('fail', 'v4: same blocker remains, unresolved.', readinessPath),
    ]);

    const cm = new ContextManager(root, DEFAULT_CONFIG);
    const agentRunner = new AgentRunner(cm, provider, root, makeRunArtifactsStub(), { model: 'test' }, undefined, artifacts);
    const engine = makeEngine(agentRunner, root);

    const result = await engine.run(
      'define-work', 'run-e2e-cap', 'Make Evershift multiplayer-capable', undefined, workItemId,
      undefined, undefined, objectiveId, [], [],
    );

    assert.equal(result.status, 'halted');
    assert.match(result.error ?? '', /Iteration cap \(4\) reached/);
    assert.equal(result.iterations_used, 4, 'must never advance to iteration 5 — the cap is enforced, not force-passed');

    // The final (v4) Definition and its readiness review are preserved, not
    // rolled back or deleted, so the named blockers remain inspectable.
    const finalDefinition = await fs.readFile(path.join(root, definitionPath), 'utf-8');
    assert.ok(finalDefinition.includes('Definition v4'));
    const finalReadiness = await fs.readFile(path.join(root, readinessPath), 'utf-8');
    assert.ok(finalReadiness.includes('v4: same blocker remains'));

    const definitionHistory = artifacts.listByWorkflowRun('run-e2e-cap').filter((a) => a.ref === `definition:${objectiveId}`);
    assert.equal(definitionHistory.length, 4, 'all four Definition versions remain in provenance history');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
