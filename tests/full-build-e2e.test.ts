/**
 * Full-build E2E: WorkflowEngine + FullBuildStepRunner + real AgentRunner
 * + real ContextManager + real RunArtifactManager + queue-based mock LLM.
 *
 * Verifies: DESIGN/PLAN/TEST/BUILD/EVALUATE artifacts reach disk; ContextManager
 * assembles context (LLM receives system+user messages); decisions.md appended by
 * snapshot; engine reaches complete.  A second test covers the validation-failure
 * path: DEBUG runs with real AgentRunner and failure_report in context.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

import { WorkflowEngine } from '../src/workflow/engine.js';
import { FullBuildStepRunner } from '../src/execution/full-build-step-runner.js';
import { AgentStepRunner } from '../src/execution/agent-step-runner.js';
import { AgentRunner } from '../src/agent-runner.js';
import { ContextManager } from '../src/context-manager.js';
import { RunArtifactManager } from '../src/run-artifacts.js';
import { SUBMIT_RESULT_TOOL_NAME } from '../src/transport/step-result.js';
import {
  BUILD_CHANGESET_ARTIFACT_TYPE,
  createBuildChangesetActionContract,
} from '../src/workflow/methodology/build-changeset-contract.js';
import type { WorkflowEngineDeps, WorkflowEngineOptions } from '../src/workflow/engine.js';
import type { FullBuildCallbacks } from '../src/execution/full-build-step-runner.js';
import type { ILLMProvider, LLMCompletionParams, LLMCompletionResult } from '../src/llm-provider.js';
import type { MultiTurnMessage, MultiTurnResult } from '../src/agent-loop.js';
import type { RuntimeMap, RuntimeMapManager } from '../src/runtime-map.js';
import type { FailureReport, PlanningDepth } from '../src/types.js';
import type { CycleStateContext } from '../src/context-manager.js';

// ============================================================================
// Mock LLM
// ============================================================================

const BUILD_TARGET = 'src/index.ts';

class QueueLLM implements ILLMProvider {
  public calls: LLMCompletionParams[] = [];
  private queue: string[];
  // BUILD protocol v1 — the desired full content of the build target per
  // BUILD execution. Iteration 1 creates the file; later iterations read it
  // (tracked via git add after the create) and anchor-replace the whole span.
  private buildQueue: string[];

  constructor(responses: string[], buildContents: string[], private projectRoot: string) {
    this.queue = [...responses];
    this.buildQueue = [...buildContents];
  }

  async complete(params: LLMCompletionParams): Promise<LLMCompletionResult> {
    this.calls.push(params);
    const content = this.queue.shift() ?? sleStd('docs/fallback.md', 'fallback');
    return { content, tokens_used: 10, duration_ms: 0 };
  }

  async completeMultiTurn(params: {
    messages: MultiTurnMessage[];
    tools: ReadonlyArray<{ name: string }>;
  }): Promise<MultiTurnResult> {
    // Keep the git index in sync with published creates: a later BUILD
    // iteration's loop computes its tracked-file read authority at loop
    // start, so the file created by the previous iteration must be indexed
    // before that loop begins (the inter-iteration steps call through here).
    try {
      execSync('git add -A', { cwd: this.projectRoot });
    } catch {
      // not a repo / git missing — reads of created files would then fail
      // closed, which is the protocol's own discipline
    }
    this.calls.push(params as LLMCompletionParams);
    // BUILD protocol v1 — only the BUILD step negotiates the submit_result
    // tool (its actionArtifact projects the changeset schema); every other
    // produce step is on the plain textual multi-turn wire (read tools only).
    const isBuildStep = params.tools.some((t) => t.name === SUBMIT_RESULT_TOOL_NAME);
    if (!isBuildStep) {
      const content = this.queue.shift() ?? sleStd('docs/fallback.md', 'fallback');
      return { stop_reason: 'end_turn', text: content, tool_uses: [], tokens_used: 10 };
    }
    const nextDesired = () => this.buildQueue.shift() ?? 'export const x = 1;';
    const last = params.messages[params.messages.length - 1];
    const toolResults: string[] =
      last && last.role === 'user' && Array.isArray(last.content)
        ? (last.content as Array<{ type: string; content?: string }>)
            .filter((b) => b.type === 'tool_result' && typeof b.content === 'string')
            .map((b) => b.content as string)
        : [];
    if (toolResults.length === 0) {
      if (existsSync(path.join(this.projectRoot, BUILD_TARGET))) {
        // refinement iteration: read the exact region, then replace it
        return {
          stop_reason: 'tool_use',
          text: '',
          tool_uses: [{ type: 'tool_use', id: 'e2e-read', name: 'read_source_slice', input: { path: BUILD_TARGET } }],
          tokens_used: 10,
        };
      }
      return {
        stop_reason: 'tool_use',
        text: '',
        tool_uses: [{
          type: 'tool_use',
          id: 'e2e-submit',
          name: SUBMIT_RESULT_TOOL_NAME,
          input: { edits: [], creates: [{ path: BUILD_TARGET, content: nextDesired() }] },
        }],
        tokens_used: 10,
      };
    }
    // second turn: anchor the read span and replace it wholesale
    const slice = JSON.parse(toolResults[toolResults.length - 1]) as {
      anchor: { anchor_id: string };
    };
    return {
      stop_reason: 'tool_use',
      text: '',
      tool_uses: [{
        type: 'tool_use',
        id: 'e2e-submit',
        name: SUBMIT_RESULT_TOOL_NAME,
        input: { edits: [{ anchor_id: slice.anchor.anchor_id, replacement: nextDesired() }], creates: [] },
      }],
      tokens_used: 10,
    };
  }
}

// Standard role output format (designer, planner, tester, evaluator, debugger).
// ALL produce steps run the multi-turn wire now (the provider is multi-turn
// capable), so the textual envelope is the multi-turn artifact-block form.
function sleStd(filePath: string, content: string): string {
  return sleStdMulti([[filePath, content]]);
}

function sleStdMulti(docs: Array<[string, string]>): string {
  const body = docs.map(([p, c]) => `<<<SLE-ARTIFACT path="${p}">>>\n${c.trimEnd()}\n<<<END-SLE-ARTIFACT>>>`).join('\n');
  return `<<<SLE-OUTPUT>>>\n${body}\n<<<END-SLE-OUTPUT>>>`;
}

// ============================================================================
// InMemMapManager (same lightweight stub as in other test files)
// ============================================================================

function baseMap(depth: PlanningDepth = 'minimal'): RuntimeMap {
  return {
    meta: { status: 'cycling', cycle: 1, version_id: 'v1', initialized_at: '', updated_at: '',
      dag: { current_node: null, completed_nodes: [], iteration: 1, revision: 0, started_at: '', nodes: {} } },
    project: { name: 'test', description: 'e2e', type: 'api' },
    remotes: { code: { type: 'git', url: 'https://github.com/o/r.git', branch: 'main' }, issues: { type: 'git', url: 'https://github.com/o/r.git', branch: 'main' }, docs: { url: 'https://github.com/o/d.git', pending: false } },
    task_store: { type: 'local' }, agents: {},
    discovery: { status: 'complete', mode: 'full', completed_at: '', artifacts: [], current_round: 0, total_rounds: 1, current_phase: 0, total_phases: 0, open_questions_count: 0, blocking_questions_count: 0 },
    cycle: { number: 1, iteration: 1, revision: 0, max_iterations: 10, planning_depth: depth, started_at: '', outcome: 'cycling', approval_gate: null, awaiting_scoping: false, awaiting_confirmation: false, awaiting_sharding_approval: false },
    artifacts: [],
  } as unknown as RuntimeMap;
}

class InMemMapManager implements RuntimeMapManager {
  public map: RuntimeMap;
  constructor(depth: PlanningDepth = 'minimal') { this.map = baseMap(depth); }
  async read() { return JSON.parse(JSON.stringify(this.map)); }
  async update(fn: (m: RuntimeMap) => RuntimeMap) { this.map = fn(JSON.parse(JSON.stringify(this.map))); }
  async write(m: RuntimeMap) { this.map = JSON.parse(JSON.stringify(m)); }
  [key: string]: unknown;
}

// ============================================================================
// VGS spy that can fail N times, writing a real failure report to disk
// ============================================================================

class E2EVgsService {
  private calls = 0;
  private readonly failTimes: number;
  private readonly runArtifacts: RunArtifactManager;

  constructor(failTimes: number, runArtifacts: RunArtifactManager) {
    this.failTimes = failTimes;
    this.runArtifacts = runArtifacts;
  }

  async run(workflowRunId: string, iteration: number) {
    this.calls++;
    if (this.calls > this.failTimes) return { passed: true, next_node: 'EVALUATE', failed_nodes: [] };
    const report: FailureReport = {
      cycle: 0, iteration, run_dir: `.sle/runs/${workflowRunId}/${iteration}`, run_id: workflowRunId,
      quick_summary: 'Build failed in e2e test', failed_categories: [], passed_categories: [],
    };
    await this.runArtifacts.writeFailureReport(workflowRunId, iteration, report);
    return { passed: false, next_node: null, failed_nodes: ['BUILD'], failure_report: report };
  }
}

// ============================================================================
// Harness factory
// ============================================================================

interface E2EHarnessOpts {
  llmResponses: string[];
  // BUILD protocol v1 — desired content of the build target per BUILD
  // execution (iteration order). The BUILD step submits anchored proposals
  // through submit_result (creates on iteration 1, anchor-replace after).
  buildContents: string[];
  vgsFailTimes?: number;
}

function makeE2EHarness(opts: E2EHarnessOpts) {
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'e2e-test-'));
  // read authority = git-tracked files; BUILD refinement iterations re-read
  // the target before anchoring, and the driver stages creates with git add.
  try {
    execSync('git init -q && git add -A', { cwd: projectRoot });
  } catch {
    // git unavailable: the build driver's reads would fail closed (observable)
  }
  const cleanup = () => { try { rmSync(projectRoot, { recursive: true, force: true }); } catch {} };

  const llm = new QueueLLM(opts.llmResponses, opts.buildContents, projectRoot);
  const contextManager = new ContextManager(projectRoot);
  const runArtifacts = new RunArtifactManager({ projectRoot });
  const agentRunner = new AgentRunner(contextManager, llm, projectRoot, runArtifacts, {
    model: 'default',
    actionContracts: { [BUILD_CHANGESET_ARTIFACT_TYPE]: createBuildChangesetActionContract() },
  });
  const agentStepRunner = new AgentStepRunner(agentRunner);
  const mapManager = new InMemMapManager();

  const callbacks: FullBuildCallbacks = {
    onCheckpoint: async () => 'approve',
    onConfirmGate: async () => 'approve',
    onShardingGate: async () => 'approve',
  };

  const scopingService = {
    begin: async (_c: number, _i: number, _state: CycleStateContext) => ({
      draft: '', charter_path: 'docs/cycle-charter.md', awaiting_scoping: true as const,
    }),
    approve: async (_cycleNumber: number, _iteration: number) => {},
  };

  const vgsFailTimes = opts.vgsFailTimes ?? 0;
  const vgsService = new E2EVgsService(vgsFailTimes, runArtifacts);

  const snapshotCalls: Array<[number, number]> = [];
  const summariseCalls: Array<[number, number]> = [];

  const stepRunner = new FullBuildStepRunner({
    agentStepRunner,
    mapManager,
    runArtifacts,
    projectRoot,
    criticAgent: { critique: async () => ({ pass: true, blocking_issues: [], warnings: [], suggestions: [] }) } as any,
    confirmService: {
      gate: async () => {},
      approve: async () => ({ next_node: 'BUILD' }),
      revise: async () => ({ next_node: 'TEST', revision_count: 1 }),
    } as any,
    execService: {
      run: async () => ({ success: true, passed: true, next_node: 'VALIDATION_GATE' as const, duration_ms: 0 }),
    } as any,
    validationGateService: vgsService as any,
    snapshotService: {
      run: async (cn: number, iter: number) => { snapshotCalls.push([cn, iter]); },
    } as any,
    summariseService: {
      run: async (cn: number, iter: number) => { summariseCalls.push([cn, iter]); },
    } as any,
    shardingService: undefined,
    scopingService: scopingService as any,
  }, callbacks);

  const engineDeps: WorkflowEngineDeps = {
    stepRunner,
    mapManager,
    runArtifacts,
    projectRoot,
  };

  const engineOpts: WorkflowEngineOptions = {
    onCheckpoint: async () => 'approve',
  };

  return {
    engine: new WorkflowEngine(engineDeps, engineOpts),
    llm,
    runArtifacts,
    projectRoot,
    snapshotCalls,
    summariseCalls,
    cleanup,
  };
}

function makeCycleCtx(projectRoot: string): CycleStateContext {
  return {
    cycle_number: 1,
    cycle_id: `run-e2e-${Math.random().toString(36).slice(2)}`,
    iteration: 1,
    revision: 0,
    planning_depth: 'minimal',
    intent: 'E2E integration test',
    current_node: null,
    target: null,
    project_root: projectRoot,
  } as unknown as CycleStateContext;
}

// ============================================================================
// Tests
// ============================================================================

test('e2eHappyPathArtifactsReachDisk', async () => {
  const responses = [
    sleStdMulti([['docs/requirements.md', '# Requirements\nTest feature.'], ['docs/architecture.md', '# Architecture\nModular.']]), // DESIGN
    sleStdMulti([['docs/plan.md', '# Plan\nStep 1.'], ['docs/test-plan.md', '# Tests\nTest A.']]),                                  // PLAN
    sleStd('apps/ai-server/tests/integration/test_e2e.py', 'def test_e2e():\n    assert True'),                                     // TEST (executable)
    // BUILD runs on the anchored-edit protocol (submit_result), driven by buildContents
    sleStd('docs/evaluation.md', '# Evaluation\nPassed.'),            // EVALUATE
  ];

  const { engine, llm, projectRoot, snapshotCalls, summariseCalls, cleanup } = makeE2EHarness({ llmResponses: responses, buildContents: ['export const x = 1;'] });

  try {
    const ctx = makeCycleCtx(projectRoot);
    const workflowRunId = ctx.cycle_id as string;

    const result = await engine.run('full-build', workflowRunId, 'E2E integration test', undefined, undefined, undefined, { planning_depth: 'minimal' });

    assert.equal(result.status, 'complete', `expected complete, got: ${result.status} — ${result.error}`);

    // Artifacts reach disk
    assert.ok(existsSync(path.join(projectRoot, 'docs/requirements.md')), 'docs/requirements.md missing');
    assert.ok(existsSync(path.join(projectRoot, 'docs/architecture.md')), 'docs/architecture.md missing');
    assert.ok(existsSync(path.join(projectRoot, 'docs/plan.md')), 'docs/plan.md missing');
    assert.ok(existsSync(path.join(projectRoot, 'docs/test-plan.md')), 'docs/test-plan.md missing');
    assert.ok(existsSync(path.join(projectRoot, 'apps/ai-server/tests/integration/test_e2e.py')), 'executable test missing');
    assert.ok(existsSync(path.join(projectRoot, 'src/index.ts')), 'src/index.ts missing');
    assert.ok(existsSync(path.join(projectRoot, 'docs/evaluation.md')), 'docs/evaluation.md missing');

    // Artifact content is correct
    const reqContent = await readFile(path.join(projectRoot, 'docs/requirements.md'), 'utf-8');
    assert.ok(reqContent.includes('Requirements'), `docs/requirements.md content: ${reqContent}`);

    // ContextManager assembled context: each LLM call received messages ending
    // with the user turn (multi-turn investigation turns may carry tool results).
    assert.equal(llm.calls.length, 5, `expected 5 LLM calls, got ${llm.calls.length}`);
    for (const call of llm.calls) {
      assert.ok(call.messages.length >= 1,
        `expected at least one message, got ${call.messages.length} messages`);
      assert.equal(call.messages[call.messages.length - 1].role, 'user',
        'last message should be user');
    }

    // Summarise ran
    assert.equal(summariseCalls.length, 1, 'summarise should run once');

    // Snapshot ran
    assert.equal(snapshotCalls.length, 1, 'snapshot should run once');

    // decisions.md appended by snapshot step
    assert.ok(existsSync(path.join(projectRoot, 'docs/decisions.md')), 'docs/decisions.md missing');

  } finally { cleanup(); }
});

test('e2eValidationFailPathDebugRunsWithFailureReport', async () => {
  // VGS fails iteration 1, passes on iteration 2.
  // LLM call sequence: DESIGN, PLAN, TEST, BUILD, DEBUG, PLAN, TEST, BUILD, EVALUATE
  const responses = [
    sleStdMulti([['docs/requirements.md', '# Requirements'], ['docs/architecture.md', '# Architecture']]), // DESIGN (iter 1)
    sleStdMulti([['docs/plan.md', '# Plan'], ['docs/test-plan.md', '# Tests']]),                           // PLAN (iter 1)
    sleStd('apps/ai-server/tests/integration/test_e2e.py', 'def test_e2e():\n    assert True'),           // TEST (iter 1)
    // BUILD iter 1 runs on the anchored-edit protocol (creates) — see buildContents
    sleStd('src/debug.md', '# Debug\nFixed the issue.'),             // DEBUG (iter 1)
    sleStdMulti([['docs/plan.md', '# Plan v2'], ['docs/test-plan.md', '# Tests v2']]),                     // PLAN (iter 2)
    sleStd('apps/ai-server/tests/integration/test_e2e.py', 'def test_e2e_v2():\n    assert True'),        // TEST (iter 2)
    // BUILD iter 2 anchor-replaces the whole span — see buildContents
    sleStd('docs/evaluation.md', '# Evaluation\nAll passed.'),       // EVALUATE (iter 2)
  ];

  const { engine, llm, runArtifacts, projectRoot, cleanup } = makeE2EHarness({
    llmResponses: responses,
    buildContents: ['export const x = 1;', 'export const x = 2;'],
    vgsFailTimes: 1,
  });

  try {
    const ctx = makeCycleCtx(projectRoot);
    const workflowRunId = ctx.cycle_id as string;

    const result = await engine.run('full-build', workflowRunId, 'E2E integration test', undefined, undefined, undefined, { planning_depth: 'minimal' });

    assert.equal(result.status, 'complete',
      `expected complete, got: ${result.status} — ${result.error}`);

    // 10 LLM invocations: 7 textual turns + BUILD's 3 (iter-1 create, iter-2 read, iter-2 submit)
    assert.equal(llm.calls.length, 10, `expected 10 LLM calls, got ${llm.calls.length}`);

    // Failure report was written to disk by VGS
    const report = await runArtifacts.readFailureReport(workflowRunId, 1);
    assert.ok(report !== null, 'failure report should exist on disk after VGS failure');
    assert.ok(report!.quick_summary.includes('e2e test'), `unexpected summary: ${report!.quick_summary}`);

    // Iteration 2 artifacts overwrite iteration 1 on disk
    const src = await readFile(path.join(projectRoot, 'src/index.ts'), 'utf-8');
    assert.ok(src.includes('x = 2'), 'iteration 2 build should overwrite iteration 1');

    // decisions.md present
    assert.ok(existsSync(path.join(projectRoot, 'docs/decisions.md')), 'docs/decisions.md missing');

  } finally { cleanup(); }
});
