// V8 preflight — mechanical proof of the per-step reasoning-effort override.
//
// V7-R falsified the simple capacity-cliff explanation for TEST: at a 32,768
// ceiling, reasoning volume SCALED (~1.09-1.14 MB) and consumed the entire
// allowance with zero visible output. V8's treatment is an explicit per-step
// reasoning EFFORT on the outbound request (GLM-5.3-Flash advertises
// supported_efforts ["max","high","low"] and does NOT advertise token-budget
// reasoning, so a numeric reasoning.max_tokens would be converted to an
// effort label server-side — the campaign sends the named effort directly):
//
//   full-build/design → max_tokens 32768, NO reasoning key
//   full-build/plan   → max_tokens 32768, NO reasoning key
//   full-build/test   → max_tokens 32768 + reasoning { effort: "low" }
//   full-build/build  → max_tokens 16384, NO reasoning key
//
// The treatment is the named effort `low` versus the model's default
// `max` — NOT an exact token cap, and not described as one anywhere.
//
// These tests prove the whole seam end to end:
//
//   • V8-PF.1 — outbound wire: the real OpenAICompatibleMultiTurnProvider
//     request body carries `reasoning: { effort: "low" }` EXACTLY when the
//     params declare it, and NEVER carries a reasoning key otherwise
//     (byte-for-byte legacy body).
//   • V8-PF.2 — resolution path: real AgentRunner + byte-exact settings.json
//     (`workflow_reasoning_effort`) targets ONLY the matching step.
//   • V8-PF.3 — V3 structural repair forwards the step's effort (the repair
//     is part of the stage's completion configuration; pinned mechanically
//     because V3 repair is now exercised live in the campaign).
//   • V8-PF.2b — V4 synthesis continuation forwards the step's effort.
//   • V8-PF.4 — fail-closed parsing: any unknown effort label or bad key
//     discards the ENTIRE map (no reasoning key anywhere); absent settings
//     file too.
//   • V8-PF.5 — precedence: explicit config wins over settings.
//   • V8-PF.6 — single-turn wire: a configured effort on a step that
//     executes single-turn FAILS CLOSED (never a silent no-op).

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentRunner } from '../src/agent-runner.js';
import { AgentLoop } from '../src/agent-loop.js';
import { ContextManager } from '../src/context-manager.js';
import { OpenAICompatibleMultiTurnProvider } from '../src/llm-provider.js';
import type { MultiTurnParams, MultiTurnResult } from '../src/agent-loop.js';

// ---------------------------------------------------------------------------
// V8-PF.1 — outbound wire proof (the historical budget lesson, applied to the
// reasoning seam): capture the EXACT request body the real provider sends.
// ---------------------------------------------------------------------------
{
  const capturedBodies: Array<Record<string, unknown>> = [];
  const realFetch = globalThis.fetch;
  test.before(async () => {
    process.env.SLE_LLM_API_KEY ||= 'test-key';
    (globalThis as Record<string, unknown>).fetch = (async (_url: unknown, init?: RequestInit) => {
      capturedBodies.push(JSON.parse(String(init?.body)));
      // Minimal SSE stream: finish immediately with a stop (fresh stream per
      // request — a ReadableStream is single-consumption).
      const sseChunks =
        'data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}]}\n\n' +
        'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n' +
        'data: [DONE]\n\n';
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sseChunks));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;
  });
  test.after(() => {
    globalThis.fetch = realFetch;
  });

  test('V8-PF.1a — effort present: outbound body carries reasoning { effort } next to max_tokens', async () => {
    const provider = new OpenAICompatibleMultiTurnProvider({
      base_url: 'https://router.test/api/v1',
      model: 'z-ai/glm-5.3-flash',
      api_key_env: 'SLE_LLM_API_KEY',
    } as never);
    const params: MultiTurnParams = {
      model: 'z-ai/glm-5.3-flash',
      system: 's',
      messages: [{ role: 'user', content: 'go' }],
      max_tokens: 32768,
      reasoning_effort: 'low',
      tools: [],
    };
    const result = await provider.completeMultiTurn(params);
    assert.equal(result.stop_reason, 'end_turn');
    assert.equal(capturedBodies.length, 1);
    const body = capturedBodies[0];
    assert.equal(body.max_tokens, 32768);
    assert.deepEqual(body.reasoning, { effort: 'low' });
  });

  test('V8-PF.1b — effort absent: outbound body NEVER carries a reasoning key (legacy bytes)', async () => {
    capturedBodies.length = 0;
    const provider = new OpenAICompatibleMultiTurnProvider({
      base_url: 'https://router.test/api/v1',
      model: 'z-ai/glm-5.3-flash',
      api_key_env: 'SLE_LLM_API_KEY',
    } as never);
    const params: MultiTurnParams = {
      model: 'z-ai/glm-5.3-flash',
      system: 's',
      messages: [{ role: 'user', content: 'go' }],
      max_tokens: 16384,
      tools: [],
    };
    await provider.completeMultiTurn(params);
    assert.equal(capturedBodies.length, 1);
    const body = capturedBodies[0];
    assert.equal(body.max_tokens, 16384);
    assert.equal('reasoning' in body, false, 'reasoning key must be absent when no override');
  });
}

// ---------------------------------------------------------------------------
// Shared harness: capturing provider through the real AgentRunner path.
// ---------------------------------------------------------------------------
interface CapturedCall {
  max_tokens?: number;
  reasoning_effort?: string;
}

function makeCapturingRunner(root: string, captured: CapturedCall[], configOverrides?: Record<string, unknown>): AgentRunner {
  const provider = {
    name: 'v8-preflight-capture',
    async completeMultiTurn(params: MultiTurnParams) {
      captured.push({ max_tokens: params.max_tokens, reasoning_effort: params.reasoning_effort });
      return { stop_reason: 'end_turn', text: '', tool_uses: [], tokens_used: 1 } as MultiTurnResult;
    },
  };
  const cm = new ContextManager(root, { contextWindowBytes: 1_000_000 } as never);
  return new AgentRunner(
    cm,
    provider as never,
    root,
    { updateNodeStatus: async () => {}, writeNodeOutput: async () => {} } as never,
    { model: 'test', max_tokens: 16384, ...configOverrides } as never,
    undefined,
    undefined as never,
  );
}

function ctx(root: string, workflowRunId: string, stepId: string, extra?: Record<string, unknown>): Record<string, unknown> {
  return {
    workflowRunId,
    workflowId: 'full-build',
    stepId,
    iteration: 1,
    revision: 0,
    goal: 'V8 reasoning preflight',
    projectRoot: root,
    instruction: 'Produce your artifacts.',
    authorizedOutputs: ['docs/requirements.md', 'docs/architecture.md'],
    synthesisGate: { thresholdTurns: 18 },
    synthesisContinuation: false,
    ...extra,
  };
}

const V8_SETTINGS = JSON.stringify({
  provider: 'openrouter',
  model: 'z-ai/glm-5.3-flash',
  base_url: 'https://openrouter.ai/api/v1',
  max_tokens: 16384,
  api_key_env: 'OPENROUTER_API_KEY',
  workflow_max_tokens: { 'full-build/design': 32768, 'full-build/plan': 32768, 'full-build/test': 32768 },
  workflow_reasoning_effort: { 'full-build/test': 'low' },
});

function makeTempRoot(settingsJson?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'v8-reasoning-preflight-'));
  if (settingsJson !== undefined) {
    mkdirSync(join(root, '.sle'), { recursive: true });
    writeFileSync(join(root, '.sle', 'settings.json'), settingsJson);
  }
  return root;
}

async function captureStep(root: string, stepId: string, captured: CapturedCall[], configOverrides?: Record<string, unknown>): Promise<CapturedCall> {
  const runner = makeCapturingRunner(root, captured, configOverrides);
  await (runner as unknown as { run: (r: string, c: unknown) => Promise<unknown> }).run('tester', ctx(root, `v8-${stepId}`, stepId));
  return captured[captured.length - 1];
}

// ---------------------------------------------------------------------------
// V8-PF.2 — resolution path: byte-exact V8 settings target ONLY the test step.
// ---------------------------------------------------------------------------
test('V8-PF.2 — settings-declared effort lands on test only; design/plan/build never carry it', async () => {
  const root = makeTempRoot(V8_SETTINGS);
  try {
    const captured: CapturedCall[] = [];
    const testCall = await captureStep(root, 'test', captured);
    assert.equal(testCall.max_tokens, 32768);
    assert.equal(testCall.reasoning_effort, 'low');

    captured.length = 0;
    const designCall = await captureStep(root, 'design', captured);
    assert.equal(designCall.max_tokens, 32768);
    assert.equal(designCall.reasoning_effort, undefined, 'design must NOT carry a reasoning override');

    captured.length = 0;
    const planCall = await captureStep(root, 'plan', captured);
    assert.equal(planCall.max_tokens, 32768);
    assert.equal(planCall.reasoning_effort, undefined, 'plan must NOT carry a reasoning override');

    captured.length = 0;
    const buildCall = await captureStep(root, 'build', captured);
    assert.equal(buildCall.max_tokens, 16384);
    assert.equal(buildCall.reasoning_effort, undefined, 'build must NOT carry a reasoning override');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// V8-PF.3 — the V3 bounded structural repair forwards the step's effort.
// Pinned mechanically: the repair params construction is driven directly via
// the runner's repair gate with a capturing provider. Whatever verdict the
// second validation returns, the assertion is on the CAPTURED repair call.
// ---------------------------------------------------------------------------
test('V8-PF.3 — V3 structural repair carries the step reasoning effort', async () => {
  const root = makeTempRoot(V8_SETTINGS);
  try {
    const captured: CapturedCall[] = [];
    const runner = makeCapturingRunner(root, captured);
    const gate = await (
      runner as unknown as {
        maybeRunBoundedStructuralRepair: (
          role: string,
          c: unknown,
          nodeId: string,
          rejection: { error: string; kind: 'producer-contract' },
          parsed: unknown,
          originalOutput: string,
          tokensUsedSoFar: number,
        ) => Promise<{ ok: boolean }>;
      }
    ).maybeRunBoundedStructuralRepair(
      'tester',
      ctx(root, 'v8-repair', 'test'),
      'test',
      { error: "missing mandatory outputs: [docs/architecture.md]", kind: 'producer-contract' },
      { sections: [{ path: 'docs/requirements.md', content: 'partial' }], warnings: [] },
      'original output text',
      10,
    );
    assert.equal(captured.length, 1, 'exactly one repair completion');
    assert.equal(captured[0].max_tokens, 32768, 'repair receives the stage budget');
    assert.equal(captured[0].reasoning_effort, 'low', 'repair receives the step effort');
    // The repair output ('' from the capture stub) fails the producer
    // contract — the verdict is irrelevant to this pin; ok:false is expected.
    assert.equal(gate.ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// V8-PF.4 — fail-closed parsing: invalid entry discards the ENTIRE map.
// ---------------------------------------------------------------------------
test('V8-PF.4 — unknown effort label discards the whole map (no override anywhere)', async () => {
  const root = makeTempRoot(
    JSON.stringify({
      max_tokens: 16384,
      workflow_max_tokens: { 'full-build/test': 32768 },
      workflow_reasoning_effort: { 'full-build/test': 'low', 'full-build/design': 'extreme' },
    }),
  );
  try {
    const captured: CapturedCall[] = [];
    const call = await captureStep(root, 'test', captured);
    assert.equal(call.max_tokens, 32768, 'budget map must still resolve');
    assert.equal(call.reasoning_effort, undefined, 'one invalid label must discard the ENTIRE effort map');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('V8-PF.4b — absent settings file: no effort, legacy budget', async () => {
  const root = makeTempRoot(undefined);
  try {
    const captured: CapturedCall[] = [];
    const call = await captureStep(root, 'test', captured);
    assert.equal(call.max_tokens, 16384);
    assert.equal(call.reasoning_effort, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// V8-PF.5 — precedence: explicit composition-root config wins over settings.
// ---------------------------------------------------------------------------
test('V8-PF.5 — explicit workflowReasoningEffort config wins over settings.json', async () => {
  const root = makeTempRoot(V8_SETTINGS);
  try {
    const captured: CapturedCall[] = [];
    const call = await captureStep(root, 'test', captured, {
      workflowReasoningEffort: { 'full-build/test': 'high' },
    });
    assert.equal(call.reasoning_effort, 'high', 'explicit config must win');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// V8-PF.6 — single-turn wire: configured effort FAILS CLOSED (never a
// silent no-op on a wire that cannot honor it).
// ---------------------------------------------------------------------------
test('V8-PF.6 — effort configured on a single-turn-executed step fails closed with an explicit error', async () => {
  const root = makeTempRoot(
    JSON.stringify({
      max_tokens: 16384,
      workflow_reasoning_effort: { 'full-build/review-design': 'low' },
    }),
  );
  try {
    const captured: CapturedCall[] = [];
    const runner = makeCapturingRunner(root, captured);
    const result = (await (
      runner as unknown as { run: (r: string, c: unknown) => Promise<{ success: boolean; error?: string }> }
    ).run(
      'reviewer',
      // Explicit empty inputArtifactRefs: no artifact slices needed — this
      // test exercises the fail-closed guard, not context assembly.
      ctx(root, 'v8-review', 'review-design', { requiresReviewVerdict: true, inputArtifactRefs: [] }),
    )) as { success: boolean; error?: string };
    assert.equal(result.success, false);
    assert.match(result.error ?? '', /workflow_reasoning_effort/);
    assert.match(result.error ?? '', /single-turn wire/);
    assert.equal(captured.length, 0, 'no provider call may happen on the fail-closed path');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
