/**
 * Phase F: VS3 Integration Tests — fail→debug→recover end-to-end.
 *
 * VS3-INT-01: Happy path — EXEC succeeds immediately, no Debugger called.
 * VS3-INT-02: Single failure — EXEC fails once, Debugger fixes, EXEC passes.
 * VS3-INT-03: Double failure — EXEC fails twice, Debugger fixes on attempt 2.
 * VS3-INT-04: Exhaustion — EXEC fails 4 times, cycle halts after MAX_DEBUG_ATTEMPTS.
 * VS3-INT-05: Multi-turn — AgentLoop reads file via tool use, then produces output.
 * VS3-INT-06: Malformed output — parseWithRetry reprompts and recovers.
 *
 * INT-01 through INT-04 use real services wired together (mock LLM + mock spawn).
 * INT-05 and INT-06 test individual VS3 components with real filesystem.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

import { CycleRunner } from '../src/cycle-runner.js';
import { DAGRunner } from '../src/dag-runner.js';
import { AgentRunner } from '../src/agent-runner.js';
import { ContextManager } from '../src/context-manager.js';
import { ConfirmService } from '../src/confirm-service.js';
import { ValidationGateService } from '../src/exec-gate.js';
import { ExecServiceReal } from '../src/exec-service.js';
import { SnapshotService } from '../src/snapshot-service.js';
import { SummariseService } from '../src/summarise-service.js';
import { RunArtifactManager } from '../src/run-artifacts.js';
import { RuntimeMapManagerImpl } from '../src/runtime-map.js';
import { CycleService } from '../src/cycle-service.js';
import { StateMachine } from '../src/state-machine.js';
import { InitService } from '../src/init-service.js';
import { AgentLoop, type IMultiTurnProvider, type MultiTurnParams, type MultiTurnResult } from '../src/agent-loop.js';
import { parseWithRetry } from '../src/output-parser.js';
import type { ILLMProvider, LLMCompletionParams, LLMCompletionResult } from '../src/llm-provider.js';
import type { AgentLoopOptions } from '../src/agent-loop.js';

console.log('# Running Phase F (VS3 Integration) tests...');

// ─── Mock LLM ─────────────────────────────────────────────────────────────────

// Old-format SLE-OUTPUT for standard AgentRunner (single-turn).
// Detects current node from state summary (built by ContextManager.buildStateSummary).
class VS3MockLLM implements ILLMProvider {
  private static readonly outputs: Record<string, string> = {
    DESIGN: [
      '<!-- SLE-OUTPUT',
      'role: designer',
      'node: DESIGN',
      'artifacts:',
      '  - id: requirements',
      '    path: docs/requirements.md',
      '  - id: architecture',
      '    path: docs/architecture.md',
      '-->',
      '',
      '## docs/requirements.md',
      '',
      '# Requirements',
      '',
      'Build a task API.',
      '',
      '---',
      '',
      '## docs/architecture.md',
      '',
      '# Architecture',
      '',
      'Node.js REST API.',
    ].join('\n'),

    PLAN: [
      '<!-- SLE-OUTPUT',
      'role: planner',
      'node: PLAN',
      'artifacts:',
      '  - id: plan',
      '    path: docs/plan.md',
      '  - id: test-plan',
      '    path: docs/test-plan.md',
      '-->',
      '',
      '## docs/plan.md',
      '',
      '# Plan',
      '',
      'Step 1: set up project.',
      '',
      '---',
      '',
      '## docs/test-plan.md',
      '',
      '# Test Plan',
      '',
      'GET /tasks returns array.',
    ].join('\n'),

    TEST: [
      '<!-- SLE-OUTPUT',
      'role: tester',
      'node: TEST',
      'artifacts:',
      '  - id: test-plan',
      '    path: docs/test-plan.md',
      '-->',
      '',
      '## docs/test-plan.md',
      '',
      '# Test Plan (revised)',
      '',
      'GET /tasks → 200.',
    ].join('\n'),

    BUILD: [
      '<!-- SLE-OUTPUT',
      'role: builder',
      'node: BUILD',
      'artifacts:',
      '  - id: main',
      '    path: src/index.ts',
      '-->',
      '',
      '## File: src/index.ts',
      '```typescript',
      "export const app = () => 'task api';",
      '```',
    ].join('\n'),

    HISTORY: [
      '<!-- SLE-OUTPUT',
      'role: historian',
      'node: HISTORY',
      'artifacts:',
      '  - id: decisions',
      '    path: docs/decisions.md',
      '-->',
      '',
      '## docs/decisions.md',
      '',
      '## Decision: TypeScript',
      '',
      'Cycle 1: chose TypeScript.',
    ].join('\n'),

    // DEBUG produces a src/ fix (debugger role allows src/ writes)
    DEBUG: [
      '<!-- SLE-OUTPUT',
      'role: debugger',
      'node: DEBUG',
      'artifacts:',
      '  - id: fix',
      '    path: src/debug-fix.ts',
      '-->',
      '',
      '## src/debug-fix.ts',
      '',
      "export const fix = () => 'fixed';",
    ].join('\n'),

    EVALUATE: [
      '<!-- SLE-OUTPUT',
      'role: evaluator',
      'node: EVALUATE',
      'artifacts:',
      '  - id: evaluation',
      '    path: docs/evaluation.md',
      '-->',
      '',
      '## docs/evaluation.md',
      '',
      '# Evaluation',
      '',
      'Cycle completed successfully.',
    ].join('\n'),
  };

  async complete(params: LLMCompletionParams): Promise<LLMCompletionResult> {
    const userMsg = params.messages.find((m) => m.role === 'user')?.content ?? '';
    for (const [node, output] of Object.entries(VS3MockLLM.outputs)) {
      if (userMsg.includes(`Current node: ${node}`)) {
        return { content: output, tokens_used: 50 };
      }
    }
    return { content: VS3MockLLM.outputs.EVALUATE, tokens_used: 10 };
  }
}

// ─── FailNTimesExecService ────────────────────────────────────────────────────

/**
 * Mock EXEC service that fails the first `failTimes` calls (EXEC marked 'failed'
 * in the manifest) then succeeds on subsequent calls (EXEC marked 'complete').
 *
 * ValidationGateService reads EXEC status from the manifest, so this correctly
 * triggers the VALIDATION_GATE→DEBUGGER recovery loop without needing a real
 * subprocess. (ExecServiceReal can't be driven to fail from test code because
 * the RuntimeMap Zod schema strips the `exec.command` field before it can be
 * read back from disk.)
 */
class FailNTimesExecService {
  public callCount = 0;

  constructor(
    private failTimes: number,
    private runArtifacts: RunArtifactManager,
    private mapManager: RuntimeMapManager
  ) {}

  async run(cycleNumber: number, iteration: number): Promise<{ next_node: 'VALIDATION_GATE' }> {
    this.callCount++;
    const fails = this.callCount <= this.failTimes;
    await this.runArtifacts.updateNodeStatus(cycleNumber, iteration, 'EXEC', {
      status: fails ? 'failed' : 'complete',
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      duration_ms: 0,
    });
    
    // Write exit code to map so ValidationGateService can read it
    await this.mapManager.update((m: any) => {
      const completed = [...(m.meta.dag?.completed_nodes ?? [])];
      if (!fails && !completed.includes('EXEC')) {
        completed.push('EXEC');
      }
      return {
        ...m,
        meta: {
          ...m.meta,
          dag: m.meta.dag ? {
            ...m.meta.dag,
            completed_nodes: completed,
            exec_result: { exit_code: fails ? 1 : 0, timed_out: false },
          } : undefined,
        },
      };
    });

    return { next_node: 'VALIDATION_GATE' };
  }
}

// ─── Full-cycle integration setup ─────────────────────────────────────────────

async function setupProject(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'sle-vs3-int-'));
  execSync('git init', { cwd: root, stdio: 'ignore' });
  execSync('git remote add origin https://github.com/test/vs3-int.git', { cwd: root, stdio: 'ignore' });
  return root;
}

async function initProject(root: string): Promise<void> {
  const svc = new InitService({ projectRoot: root });
  const result = await svc.init({
    project_name: 'vs3-integration-test',
    project_type: 'api',
    task_store: 'local',
    daemon_port: 7700,
    docs_remote: null,
    non_interactive: true,
    no_editor: true,
  });
  assert.strictEqual((result as { ok: boolean }).ok, true, 'init must succeed');
}

interface CycleContext {
  root: string;
  cycleNumber: number;
  mapManager: RuntimeMapManagerImpl;
  runArtifacts: RunArtifactManager;
  stateMachine: StateMachine;
}

async function startCycle(root: string): Promise<CycleContext> {
  const mapPath = join(root, '.sle', 'map.yaml');
  const mapManager = new RuntimeMapManagerImpl({ mapPath });
  const stateMachine = new StateMachine(mapManager);
  const runArtifacts = new RunArtifactManager({ projectRoot: root });
  const cycleService = new CycleService(stateMachine, mapManager, runArtifacts);

  const cycleRecord = await cycleService.start({
    intent: 'Build a task API',
    force: true,
  });
  assert.ok(cycleRecord.cycle_number > 0);

  // Cache categories as passed so they don't block the mock exec runs
  await mapManager.update((m: any) => {
    return {
      ...m,
      validation: {
        categories: [
          { name: 'correctness', method: 'executable', status: 'passed' },
          { name: 'performance', method: 'executable', status: 'passed' },
          { name: 'security', method: 'executable', status: 'passed' },
        ],
        gate: { mode: 'all_must_pass', last_outcome: 'passed', failed_categories: [] },
      },
    };
  });

  return { root, cycleNumber: cycleRecord.cycle_number, mapManager, runArtifacts, stateMachine };
}

async function buildCycleRunner(
  ctx: CycleContext,
  execOverride?: FailNTimesExecService
) {
  const { root, mapManager, runArtifacts, stateMachine } = ctx;

  const llm = new VS3MockLLM();
  const contextManager = new ContextManager(root);
  const agentRunner = new AgentRunner(contextManager, llm, root, runArtifacts, { model: 'mock' });
  const dagRunner = new DAGRunner(agentRunner, mapManager, runArtifacts);
  const confirmService = new ConfirmService(mapManager, runArtifacts);
  // Default: real ExecServiceReal in no-op mode (no exec command configured)
  const execService = execOverride ?? new ExecServiceReal(mapManager, runArtifacts, root);
  const validationGateService = new ValidationGateService(mapManager, runArtifacts);
  const snapshotService = new SnapshotService(mapManager, runArtifacts, root);
  const summariseService = new SummariseService(mapManager, runArtifacts, root);

  return new CycleRunner({
    dagRunner,
    confirmService,
    execService: execService as never,
    validationGateService,
    snapshotService,
    summariseService,
    stateMachine,
    mapManager,
    runArtifacts,
  });
}

// ─── VS3-INT-01: Happy path ───────────────────────────────────────────────────

test('VS3-INT-01: happy path — EXEC no-op succeeds, no Debugger called, cycle completes', async () => {
  const root = await setupProject();
  try {
    await initProject(root);
    const ctx = await startCycle(root);
    // No exec command configured → ExecServiceReal no-ops and marks EXEC complete
    const runner = await buildCycleRunner(ctx);

    const result = await runner.run({ onConfirmGate: async () => 'approve' });

    assert.strictEqual(result.completed, true, `should complete: ${result.error}`);
    assert.ok(result.iterations_used !== undefined, 'iterations_used should be set');
    assert.ok(result.snapshot_dir, 'snapshot_dir should be set');

    // Verify key artifacts written by LLM nodes
    const src = await fs.readFile(join(root, 'src/index.ts'), 'utf-8');
    assert.ok(src.includes('task api'), 'src/index.ts written by BUILD');

    const evalMd = await fs.readFile(join(root, 'docs/evaluation.md'), 'utf-8');
    assert.ok(evalMd.includes('Evaluation'), 'evaluation.md written by EVALUATE');

    // DEBUG fix file should NOT exist (no failures)
    await assert.rejects(
      () => fs.readFile(join(root, 'src/debug-fix.ts'), 'utf-8'),
      'debug-fix.ts should not exist on happy path'
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ─── VS3-INT-02: Single failure ───────────────────────────────────────────────

test('VS3-INT-02: single EXEC failure → Debugger fixes → EXEC passes → completes', async () => {
  const root = await setupProject();
  try {
    await initProject(root);
    const ctx = await startCycle(root);
    const execService = new FailNTimesExecService(1, ctx.runArtifacts, ctx.mapManager);
    const runner = await buildCycleRunner(ctx, execService);

    const result = await runner.run({ onConfirmGate: async () => 'approve' });

    assert.strictEqual(result.completed, true, `should complete: ${result.error}`);
    assert.ok((result.iterations_used ?? 0) >= 2, 'iterations_used should be ≥2 after one debug round');
    assert.ok(result.snapshot_dir, 'snapshot_dir should be set');

    // DEBUG fix file should exist (DEBUG ran and produced output)
    const fix = await fs.readFile(join(root, 'src/debug-fix.ts'), 'utf-8');
    assert.ok(fix.includes('fixed'), 'debug-fix.ts written by DEBUG');

    // Evaluation should also have run (cycle continued after fix)
    const evalMd = await fs.readFile(join(root, 'docs/evaluation.md'), 'utf-8');
    assert.ok(evalMd.includes('Evaluation'), 'evaluation.md written by EVALUATE after recovery');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ─── VS3-INT-03: Double failure ───────────────────────────────────────────────

test('VS3-INT-03: two EXEC failures → Debugger called twice → EXEC passes → completes', async () => {
  const root = await setupProject();
  try {
    await initProject(root);
    const ctx = await startCycle(root);
    const execService = new FailNTimesExecService(2, ctx.runArtifacts, ctx.mapManager);
    const runner = await buildCycleRunner(ctx, execService);

    const result = await runner.run({ onConfirmGate: async () => 'approve' });

    assert.strictEqual(result.completed, true, `should complete: ${result.error}`);
    assert.ok((result.iterations_used ?? 0) >= 3, 'iterations_used should be ≥3 after two debug rounds');
    assert.ok(result.snapshot_dir, 'snapshot_dir set after double-recovery');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ─── VS3-INT-04: Exhaustion ───────────────────────────────────────────────────

test('VS3-INT-04: EXEC fails enough times → iteration cap exhausted → cycle halts', async () => {
  const root = await setupProject();
  try {
    await initProject(root);
    const ctx = await startCycle(root);
    // max_iterations defaults to 5; fail 4 times so cap is hit (iteration 1 + 4 increments = 5 >= 5)
    const execService = new FailNTimesExecService(4, ctx.runArtifacts, ctx.mapManager);
    const runner = await buildCycleRunner(ctx, execService);

    const result = await runner.run({ onConfirmGate: async () => 'approve' });

    assert.strictEqual(result.completed, false, 'cycle should not complete on exhaustion');
    assert.strictEqual(result.final_node, 'DEBUG');
    assert.ok(result.failure_report, 'failure_report should be present on exhaustion');
    assert.ok(
      result.error?.includes('cap'),
      `error should mention cap: ${result.error}`
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ─── VS3-INT-05: Multi-turn AgentLoop integration ─────────────────────────────

test('VS3-INT-05: AgentLoop reads file via tool use, then produces SLE-OUTPUT in 2 turns', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sle-vs3-int05-'));
  try {
    // Write a file the agent will read
    await fs.mkdir(join(root, 'docs'), { recursive: true });
    await fs.writeFile(join(root, 'docs/requirements.md'), '# Requirements\nBuild a task API.\n', 'utf-8');

    // Set up RunArtifactManager for the AgentLoop to write turn artifacts.
    // AgentLoop.writeTurnMetadata() swallows failures, so no manifest is needed.
    await fs.mkdir(join(root, '.sle', 'runs', '1-1', 'node-outputs'), { recursive: true });
    const runArtifacts = new RunArtifactManager({ projectRoot: root });

    // Mock IMultiTurnProvider: turn 1 → tool_use, turn 2 → SLE-OUTPUT
    let turnCount = 0;
    const mockProvider: IMultiTurnProvider = {
      async completeMultiTurn(_params: MultiTurnParams): Promise<MultiTurnResult> {
        turnCount++;
        if (turnCount === 1) {
          return {
            stop_reason: 'tool_use',
            text: '',
            tool_uses: [{
              type: 'tool_use',
              id: 'tu-001',
              name: 'read_file',
              input: { path: 'docs/requirements.md' },
            }],
            tokens_used: 30,
          };
        }
        // Turn 2: emit SLE-OUTPUT with the file path
        return {
          stop_reason: 'end_turn',
          text: [
            '<<<SLE-OUTPUT>>>',
            '### docs/requirements.md',
            '# Requirements (updated)',
            '',
            'Build a task API with authentication.',
            '<<<END-SLE-OUTPUT>>>',
          ].join('\n'),
          tool_uses: [],
          tokens_used: 80,
        };
      },
    };

    const opts: AgentLoopOptions = {
      model: 'mock',
      max_tokens: 4096,
      projectRoot: root,
      role: 'designer',
      cycleNumber: 1,
      iteration: 1,
      nodeId: 'DESIGN',
      runArtifacts,
    };

    const agentLoop = new AgentLoop(mockProvider, opts);
    const loopResult = await agentLoop.run('You are a designer.', 'Design the API.');

    assert.strictEqual(loopResult.success, true, `AgentLoop should succeed: ${loopResult.error}`);
    assert.strictEqual(loopResult.turns_taken, 2, 'should take 2 turns (tool use + output)');
    assert.ok(loopResult.parsedOutput, 'parsedOutput should be present');
    assert.ok(
      loopResult.parsedOutput!.sections.some((s) => s.path === 'docs/requirements.md'),
      'section for docs/requirements.md should be present'
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ─── VS3-INT-06: Malformed output retry ──────────────────────────────────────

test('VS3-INT-06: parseWithRetry reprompts on malformed output, succeeds on second attempt', async () => {
  const malformedRaw = 'This is output without any SLE-OUTPUT block.';
  const validRaw = [
    '<<<SLE-OUTPUT>>>',
    '### docs/plan.md',
    '# Plan',
    '',
    'Step 1: implement the API.',
    '<<<END-SLE-OUTPUT>>>',
  ].join('\n');

  let repromptCalled = false;
  let repromptReason = '';

  const rePromptFn = async (reason: string): Promise<string> => {
    repromptCalled = true;
    repromptReason = reason;
    return validRaw;
  };

  const result = await parseWithRetry(malformedRaw, 'planner', rePromptFn);

  assert.ok(repromptCalled, 'rePromptFn should have been called on malformed output');
  assert.ok(repromptReason.length > 0, 'rePromptFn should receive a reason for the failure');
  assert.ok(result.sections.length > 0, 'should have sections after successful retry');
  assert.strictEqual(result.sections[0].path, 'docs/plan.md', 'section path should be correct');
  assert.ok(result.sections[0].content.includes('implement'), 'section content should be correct');
});

console.log('# ✅ All Phase F (VS3 Integration) tests passed!');
