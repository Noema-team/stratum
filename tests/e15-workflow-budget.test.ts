// E15/A6 — the per-workflow completion-budget override.
//
// Pilot A5 died at turn 19 on stop_reason=max_tokens (the frozen global
// 16,384 completion budget) with five turn slots unused. A6 changes exactly
// ONE variable: define-work's completion budget → 32,768 via a declarative
// settings section (`workflow_max_tokens`), read strictly by the runner from
// its projectRoot (the pilot driver's frozen call shape passes no new
// arguments) or by explicit composition-root config. Everything else —
// global budget, turn cap, repair budget, retry policy, teaching — is
// pinned unchanged here or by the existing suites.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import { AgentRunner, type AgentRunnerConfig } from '../src/agent-runner.js';
import { buildAgentRunner } from '../src/application.js';
import { MAX_AGENT_TURNS } from '../src/agent-loop.js';
import { MAX_RESULT_REPAIRS } from '../src/transport/step-result.js';
import type { ContextManager } from '../src/context-manager.js';
import type { AssembledContext } from '../src/types.js';
import type { StepRunContext } from '../src/workflow/types.js';
import type { RunArtifactManager } from '../src/run-artifacts.js';
import type { ILLMProvider, LLMCompletionParams, LLMCompletionResult } from '../src/llm-provider.js';

const GLOBAL_BUDGET = 16384;
const DEFINE_BUDGET = 32768;

class CapturingMultiTurnProvider implements ILLMProvider {
  public calls: LLMCompletionParams[] = [];
  async complete(_params: LLMCompletionParams): Promise<LLMCompletionResult> {
    throw new Error('single-turn path must not be used in this test');
  }
  async completeMultiTurn(params: any): Promise<any> {
    this.calls.push(params);
    // Terminate immediately with a valid textual proposal-shaped turn is not
    // needed — the budget rides the REQUEST, so one captured call suffices;
    // then end the run with an unparsable end_turn (failure paths are fine:
    // the assertion is on the captured request, not the result).
    return { stop_reason: 'end_turn', text: '', tool_uses: [], tokens_used: 1 };
  }
}

class StubContextManager implements ContextManager {
  async assemble(): Promise<AssembledContext> {
    return { system_prompt: 's', artifact_slices: {}, state_summary: 'st', task: 't', token_count: 1, truncated: [] };
  }
}

function ctxWith(workflowId: string, root: string): StepRunContext {
  return {
    workflowRunId: 'r', workflowId, stepId: 'synthesize-definition',
    iteration: 1, revision: 0, goal: 'g', projectRoot: root, role: 'explorer',
    outputArtifact: { type: 'definition', ref: 'definition:{objectiveId}', path: '.sle/work/w/definition.md' },
  } as unknown as StepRunContext;
}

function makeRunner(root: string, provider: ILLMProvider, config?: Partial<AgentRunnerConfig>): AgentRunner {
  return new AgentRunner(new StubContextManager(), provider, root, { writeNodeOutput: async () => {}, updateNodeStatus: async () => {} } as unknown as RunArtifactManager, { model: 'test-model', max_tokens: GLOBAL_BUDGET, ...config });
}

test('E15/A6: explicit config override — define-work receives 32768, other workflows keep the global 16384', async () => {
  const root = mkdtempSync(join(tmpdir(), 'e15-explicit-'));
  try {
    const defineProvider = new CapturingMultiTurnProvider();
    const otherProvider = new CapturingMultiTurnProvider();
    // (Each run may legitimately make >1 provider call — e.g. a format
    // repair continuation — so assertions cover ALL captured calls.)
    const runner = makeRunner(root, defineProvider, { workflowMaxTokens: { 'define-work': DEFINE_BUDGET } });
    await runner.run('explorer', ctxWith('define-work', root));
    const runner2 = makeRunner(root, otherProvider, { workflowMaxTokens: { 'define-work': DEFINE_BUDGET } });
    await runner2.run('explorer', ctxWith('full-build', root));

    assert.ok(defineProvider.calls.length >= 1);
    assert.ok(defineProvider.calls.every((c) => c.max_tokens === DEFINE_BUDGET), 'every define-work generation call must use the override');
    assert.ok(otherProvider.calls.length >= 1);
    assert.ok(otherProvider.calls.every((c) => c.max_tokens === GLOBAL_BUDGET), 'non-define-work must keep the existing global budget');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('E15/A6: declarative settings override — the frozen 8-arg construction path picks up workflow_max_tokens from projectRoot', async () => {
  const root = mkdtempSync(join(tmpdir(), 'e15-settings-'));
  try {
    mkdirSync(join(root, '.sle'), { recursive: true });
    writeFileSync(join(root, '.sle', 'settings.json'), JSON.stringify({ max_tokens: GLOBAL_BUDGET, workflow_max_tokens: { 'define-work': DEFINE_BUDGET } }), 'utf-8');
    const defineProvider = new CapturingMultiTurnProvider();
    const otherProvider = new CapturingMultiTurnProvider();
    // NO explicit workflowMaxTokens — the runner must resolve the override
    // from projectRoot (the pilot driver cannot pass new arguments).
    const runner = makeRunner(root, defineProvider);
    await runner.run('explorer', ctxWith('define-work', root));
    const runner2 = makeRunner(root, otherProvider);
    await runner2.run('explorer', ctxWith('full-build', root));

    assert.ok(defineProvider.calls.length >= 1);
    assert.ok(defineProvider.calls.every((c) => c.max_tokens === DEFINE_BUDGET), 'settings-declared override must reach the define-work generation path');
    assert.ok(otherProvider.calls.length >= 1);
    assert.ok(otherProvider.calls.every((c) => c.max_tokens === GLOBAL_BUDGET));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('E15/A6: backward compatibility — absent, empty, or invalid overrides leave global behavior untouched', async () => {
  const variants: Array<Record<string, unknown> | undefined> = [
    undefined,
    {},
    { workflow_max_tokens: {} },
    { workflow_max_tokens: { 'define-work': 0 } },
    { workflow_max_tokens: { 'define-work': -5 } },
    { workflow_max_tokens: { 'define-work': 1.5 } },
    { workflow_max_tokens: { 'define-work': 'big' } },
    { workflow_max_tokens: 'define-work' },
  ];
  for (const settings of variants) {
    const root = mkdtempSync(join(tmpdir(), 'e15-compat-'));
    try {
      mkdirSync(join(root, '.sle'), { recursive: true });
      writeFileSync(join(root, '.sle', 'settings.json'), JSON.stringify({ max_tokens: GLOBAL_BUDGET, ...(settings ?? {}) }), 'utf-8');
      const provider = new CapturingMultiTurnProvider();
      const runner = makeRunner(root, provider);
      await runner.run('explorer', ctxWith('define-work', root));
      assert.strictEqual(provider.calls[0].max_tokens, GLOBAL_BUDGET, `variant ${JSON.stringify(settings)} must fall back to the global budget`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('E15/A6: buildAgentRunner threads the explicit override for composition roots that pass it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'e15-bar-'));
  try {
    const provider = new CapturingMultiTurnProvider();
    const runner = buildAgentRunner(
      new StubContextManager(), provider, root,
      { writeNodeOutput: async () => {}, updateNodeStatus: async () => {} } as unknown as RunArtifactManager,
      'test-model', undefined as never, GLOBAL_BUDGET, undefined,
      { 'define-work': DEFINE_BUDGET },
    );
    await runner.run('explorer', ctxWith('define-work', root));
    assert.strictEqual(provider.calls[0].max_tokens, DEFINE_BUDGET);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('E15/A6: frozen experiment constants are untouched', () => {
  assert.strictEqual(MAX_AGENT_TURNS, 24);
  assert.strictEqual(MAX_RESULT_REPAIRS, 1);
});
