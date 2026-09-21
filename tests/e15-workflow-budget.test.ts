// E15/A6 — the per-(workflow,step) completion-budget override.
//
// Pilot A5 died at turn 19 on stop_reason=max_tokens at ONE precise point:
// define-work / synthesize-definition, with the frozen global 16,384
// completion budget exhausted mid-generation. A6 changes exactly ONE
// behavioral variable: define-work/synthesize-definition → 32,768. Every
// other step — including the not-yet-exercised later define-work stages
// (definition-readiness-review, refine-definition) and full-build — keeps
// 16,384. The override is a declarative settings map keyed by
// "workflowId/stepId", read strictly (fail-closed whole map) by the runner
// from its projectRoot — required because the frozen pilot driver's
// 8-argument buildAgentRunner call cannot pass new arguments.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentRunner, type AgentRunnerConfig } from '../src/agent-runner.js';
import { buildAgentRunner } from '../src/application.js';
import { MAX_AGENT_TURNS } from '../src/agent-loop.js';
import { MAX_RESULT_REPAIRS } from '../src/transport/step-result.js';
import type { ContextManager } from '../src/context-manager.js';
import type { AssembledContext } from '../src/types.js';
import type { StepRunContext } from '../src/workflow/types.js';
import type { RunArtifactManager } from '../src/run-artifacts.js';
import type { ILLMProvider, LLMCompletionParams } from '../src/llm-provider.js';

const GLOBAL_BUDGET = 16384;
const SYNTH_BUDGET = 32768;
const OVERRIDE = { 'define-work/synthesize-definition': SYNTH_BUDGET };

class CapturingMultiTurnProvider implements ILLMProvider {
  public calls: LLMCompletionParams[] = [];
  async complete(): Promise<never> {
    throw new Error('single-turn path must not be used in this test');
  }
  async completeMultiTurn(params: any): Promise<any> {
    this.calls.push(params);
    // Terminate each run with an unparsable end_turn: the budget rides the
    // REQUEST, so what matters is the captured max_tokens — including the
    // format-repair continuation call the empty turn triggers.
    return { stop_reason: 'end_turn', text: '', tool_uses: [], tokens_used: 1 };
  }
}

class StubContextManager implements ContextManager {
  async assemble(): Promise<AssembledContext> {
    return { system_prompt: 's', artifact_slices: {}, state_summary: 'st', task: 't', token_count: 1, truncated: [] };
  }
}

function ctxWith(workflowId: string, stepId: string, root: string): StepRunContext {
  return {
    workflowRunId: 'r', workflowId, stepId,
    iteration: 1, revision: 0, goal: 'g', projectRoot: root, role: 'explorer',
    outputArtifact: { type: 'definition', ref: 'definition:{objectiveId}', path: '.sle/work/w/definition.md' },
  } as unknown as StepRunContext;
}

function makeRunner(root: string, provider: ILLMProvider, config?: Partial<AgentRunnerConfig>): AgentRunner {
  return new AgentRunner(new StubContextManager(), provider, root, { writeNodeOutput: async () => {}, updateNodeStatus: async () => {} } as unknown as RunArtifactManager, { model: 'test-model', max_tokens: GLOBAL_BUDGET, ...config });
}

function writeSettings(root: string, extra: Record<string, unknown>): string {
  mkdirSync(join(root, '.sle'), { recursive: true });
  const p = join(root, '.sle', 'settings.json');
  writeFileSync(p, JSON.stringify({ max_tokens: GLOBAL_BUDGET, ...extra }), 'utf-8');
  return p;
}

async function expectBudget(root: string, workflowId: string, stepId: string, expected: number, config?: Partial<AgentRunnerConfig>): Promise<void> {
  const provider = new CapturingMultiTurnProvider();
  const runner = makeRunner(root, provider, config);
  await runner.run('explorer', ctxWith(workflowId, stepId, root));
  assert.ok(provider.calls.length >= 1, `${workflowId}/${stepId} must make at least one provider call`);
  assert.ok(
    provider.calls.every((c) => c.max_tokens === expected),
    `${workflowId}/${stepId}: every captured call (${provider.calls.length}, incl. any repair continuation) must use ${expected}, got ${JSON.stringify(provider.calls.map((c) => c.max_tokens))}`,
  );
}

test('E15/A6: ONLY define-work/synthesize-definition receives 32768 — every other step keeps the global 16384', async () => {
  const root = mkdtempSync(join(tmpdir(), 'e15-matrix-'));
  try {
    const cfg = { workflowMaxTokens: { ...OVERRIDE } };
    await expectBudget(root, 'define-work', 'synthesize-definition', SYNTH_BUDGET, cfg);
    await expectBudget(root, 'define-work', 'definition-readiness-review', GLOBAL_BUDGET, cfg);
    await expectBudget(root, 'define-work', 'refine-definition', GLOBAL_BUDGET, cfg);
    await expectBudget(root, 'full-build', 'implement-tasks', GLOBAL_BUDGET, cfg);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('E15/A6: repairs/retries inside synthesize-definition retain 32768 (continuation calls ride the same lookup)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'e15-repair-'));
  try {
    const provider = new CapturingMultiTurnProvider();
    const runner = makeRunner(root, provider, { workflowMaxTokens: { ...OVERRIDE } });
    await runner.run('explorer', ctxWith('define-work', 'synthesize-definition', root));
    // The empty end_turn forces the format-repair continuation: an in-run
    // second generation for the SAME step must keep the step's budget.
    assert.ok(provider.calls.length >= 2, 'expected the initial call plus at least one repair continuation');
    assert.ok(provider.calls.every((c) => c.max_tokens === SYNTH_BUDGET), `all in-run calls must retain ${SYNTH_BUDGET}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('E15/A6: the ACTUAL existing 8-argument buildAgentRunner path picks up the settings override (declared before construction)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'e15-8arg-'));
  try {
    writeSettings(root, { workflow_max_tokens: { ...OVERRIDE } });
    const provider = new CapturingMultiTurnProvider();
    // The frozen pilot driver's call shape: exactly the original 8 positional
    // arguments — settings must already be on disk when the runner is built.
    const runner = buildAgentRunner(
      new StubContextManager(), provider, root,
      { writeNodeOutput: async () => {}, updateNodeStatus: async () => {} } as unknown as RunArtifactManager,
      'test-model', undefined as never, GLOBAL_BUDGET, undefined,
    );
    await expectBudgetFrom(runner, provider, root, 'define-work', 'synthesize-definition', SYNTH_BUDGET);
    await expectBudgetFrom(runner, provider, root, 'define-work', 'definition-readiness-review', GLOBAL_BUDGET);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  async function expectBudgetFrom(runner: AgentRunner, provider: CapturingMultiTurnProvider, root: string, workflowId: string, stepId: string, expected: number): Promise<void> {
    provider.calls.length = 0;
    await runner.run('explorer', ctxWith(workflowId, stepId, root));
    assert.ok(provider.calls.length >= 1);
    assert.ok(provider.calls.every((c) => c.max_tokens === expected), `${workflowId}/${stepId}: expected ${expected}`);
  }
});

test('E15/A6: fail-closed whole-map validation — one invalid entry discards the ENTIRE map (no partial overrides)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'e15-failclosed-'));
  try {
    // A valid sibling is present, but the invalid entry must kill the whole map.
    writeSettings(root, { workflow_max_tokens: { ...OVERRIDE, 'define-work/refine-definition': -5 } });
    await expectBudget(root, 'define-work', 'synthesize-definition', GLOBAL_BUDGET);
    await expectBudget(root, 'define-work', 'refine-definition', GLOBAL_BUDGET);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('E15/A6: backward compatibility — absent, empty, or malformed settings leave global behavior untouched', async () => {
  const variants: Array<Record<string, unknown>> = [
    {},
    { workflow_max_tokens: {} },
    { workflow_max_tokens: { 'define-work/synthesize-definition': 0 } },
    { workflow_max_tokens: { 'define-work/synthesize-definition': 1.5 } },
    { workflow_max_tokens: { 'define-work/synthesize-definition': 'big' } },
    { workflow_max_tokens: { 'define-work': 32768 } }, // legacy workflow-only key: not a valid step-scoped key
    { workflow_max_tokens: { 'define-work/': 32768 } },
    { workflow_max_tokens: 'define-work/synthesize-definition' },
  ];
  for (const extra of variants) {
    const root = mkdtempSync(join(tmpdir(), 'e15-compat-'));
    try {
      writeSettings(root, extra);
      await expectBudget(root, 'define-work', 'synthesize-definition', GLOBAL_BUDGET);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('E15/A6: frozen experiment constants are untouched', () => {
  assert.strictEqual(MAX_AGENT_TURNS, 24);
  assert.strictEqual(MAX_RESULT_REPAIRS, 1);
});
