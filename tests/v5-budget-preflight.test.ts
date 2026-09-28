// V5 preflight — mechanical proof of the DESIGN completion-budget override.
//
// V4-D1 discovered the pilot procedure wrote unsupported FLAT settings keys
// (`workflow_max_tokens_design`), which Stratum's strict reader never reads;
// every V2/V3/V4 run therefore used the driver's global 16,384 budget. V5
// changes ONLY `full-build/design` via the REAL settings shape:
//
//   { "workflow_max_tokens": { "full-build/design": 32768 } }
//
// These tests drive the real AgentRunner budget-resolution path
// (constructor → resolveWorkflowBudgetOverridesFromSettings →
// completionBudgetFor → AgentLoop max_tokens → provider params) with a
// capturing provider, and fail closed if the override does not land exactly:
//
//   • map shape → design 32768, control step (plan) 16384
//   • the previously-wrong flat-key shape must NOT be mistaken for the
//     override (both steps stay at the global 16384)
//   • any invalid map entry discards the ENTIRE map (fail-closed contract)
//   • absent settings → global budget everywhere

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentRunner } from '../src/agent-runner.js';
import { ContextManager } from '../src/context-manager.js';
import type { MultiTurnParams } from '../src/agent-loop.js';

const GLOBAL_BUDGET = 16384;
const DESIGN_BUDGET = 32768;

interface CapturedCall {
  max_tokens?: number;
  model?: string;
}

function makeCapturingRunner(root: string, captured: CapturedCall[]): AgentRunner {
  const provider = {
    name: 'v5-preflight-capture',
    async completeMultiTurn(params: MultiTurnParams) {
      captured.push({ max_tokens: params.max_tokens, model: params.model });
      return { stop_reason: 'end_turn', text: '', tool_uses: [], tokens_used: 1 };
    },
  };
  const cm = new ContextManager(root, { contextWindowBytes: 1_000_000 } as never);
  return new AgentRunner(
    cm,
    provider as never,
    root,
    { updateNodeStatus: async () => {}, writeNodeOutput: async () => {} } as never,
    { model: 'test', max_tokens: GLOBAL_BUDGET } as never,
    undefined,
    undefined as never,
  );
}

function ctx(root: string, workflowRunId: string, stepId: string): Record<string, unknown> {
  return {
    workflowRunId,
    workflowId: 'full-build',
    stepId,
    iteration: 1,
    revision: 0,
    goal: 'V5 budget preflight',
    projectRoot: root,
    instruction: 'Produce your artifacts.',
    authorizedOutputs: ['docs/requirements.md', 'docs/architecture.md'],
    synthesisGate: { thresholdTurns: 18 },
    synthesisContinuation: false,
  };
}

async function captureStepBudgets(
  root: string,
  settingsJson: string,
): Promise<{ design: number | undefined; plan: number | undefined }> {
  mkdirSync(join(root, '.sle'), { recursive: true });
  writeFileSync(join(root, '.sle', 'settings.json'), settingsJson, 'utf8');
  const captured: CapturedCall[] = [];
  const runner = makeCapturingRunner(root, captured);
  await runner.run('designer', ctx(root, 'v5-preflight-design', 'design') as never);
  await runner.run('planner', ctx(root, 'v5-preflight-plan', 'plan') as never);
  assert.ok(captured.length >= 2, 'both steps must have reached the provider');
  return { design: captured[0].max_tokens, plan: captured[captured.length - 1].max_tokens };
}

test('V5-PF.1: REAL settings map shape — full-build/design gets 32768, control full-build/plan stays 16384', async () => {
  const root = mkdtempSync(join(tmpdir(), 'v5pf-'));
  try {
    const budgets = await captureStepBudgets(
      root,
      JSON.stringify({ workflow_max_tokens: { 'full-build/design': DESIGN_BUDGET } }),
    );
    assert.equal(budgets.design, DESIGN_BUDGET, 'design override MUST reach the provider params');
    assert.equal(budgets.plan, GLOBAL_BUDGET, 'control step MUST stay at the global budget');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('V5-PF.2: the previously-wrong FLAT-key shape must NOT be mistaken for the override', async () => {
  const root = mkdtempSync(join(tmpdir(), 'v5pf-'));
  try {
    const budgets = await captureStepBudgets(
      root,
      JSON.stringify({
        // the exact shape the V2–V4 procedure wrote — inert by contract
        workflow_max_tokens_define: 32768,
        workflow_max_tokens_design: DESIGN_BUDGET,
        workflow_max_tokens_plan: 32768,
        workflow_max_tokens_test: 65536,
        workflow_max_tokens_build: 65536,
      }),
    );
    assert.equal(budgets.design, GLOBAL_BUDGET, 'flat keys must be ignored — design stays global');
    assert.equal(budgets.plan, GLOBAL_BUDGET, 'flat keys must be ignored — plan stays global');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('V5-PF.3: fail-closed — one invalid map entry discards the ENTIRE map', async () => {
  const root = mkdtempSync(join(tmpdir(), 'v5pf-'));
  try {
    const budgets = await captureStepBudgets(
      root,
      JSON.stringify({ workflow_max_tokens: { 'full-build/design': DESIGN_BUDGET, 'full-build/test': 0 } }),
    );
    assert.equal(budgets.design, GLOBAL_BUDGET, 'invalid map must be discarded whole — never partial');
    assert.equal(budgets.plan, GLOBAL_BUDGET);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('V5-PF.4: absent settings → global budget everywhere (the actual V4 regime)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'v5pf-'));
  try {
    mkdirSync(join(root, '.sle'), { recursive: true });
    writeFileSync(
      join(root, '.sle', 'settings.json'),
      JSON.stringify({ provider: 'openrouter', model: 'z-ai/glm-5.3-flash', max_tokens: GLOBAL_BUDGET }),
      'utf8',
    );
    const budgets = await captureStepBudgets(root, JSON.stringify({ provider: 'openrouter', max_tokens: GLOBAL_BUDGET }));
    assert.equal(budgets.design, GLOBAL_BUDGET);
    assert.equal(budgets.plan, GLOBAL_BUDGET);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
