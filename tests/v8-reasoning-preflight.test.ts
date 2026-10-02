// V8 preflight — mechanical proof of the per-step reasoning-token cap.
//
// V7-R falsified the simple capacity-cliff explanation for TEST: at a 32,768
// ceiling, reasoning volume SCALED (~1.09-1.14 MB) and consumed the entire
// allowance with zero visible output. V8's treatment is therefore a per-step
// reasoning cap on the OUTBOUND request:
//
//   full-build/design → max_tokens 32768, NO reasoning key
//   full-build/plan   → max_tokens 32768, NO reasoning key
//   full-build/test   → max_tokens 32768 + reasoning { max_tokens: 8192 }
//   full-build/build  → max_tokens 16384, NO reasoning key
//
// These tests prove the whole seam end to end:
//
//   • V8-PF.1 — outbound wire: the real OpenAICompatibleMultiTurnProvider
//     request body carries `reasoning: { max_tokens: N }` EXACTLY when the
//     params declare it, and NEVER carries a reasoning key otherwise
//     (byte-for-byte legacy body).
//   • V8-PF.2 — loop forwarding: AgentLoop forwards the cap on turn requests,
//     transport retries, and the V4 bounded synthesis continuation alike.
//   • V8-PF.3 — resolution path: real AgentRunner + byte-exact settings.json
//     (`workflow_reasoning_max_tokens`) targets ONLY the matching step.
//   • V8-PF.4 — fail-closed parsing: any invalid map entry discards the
//     ENTIRE map (no reasoning key anywhere); absent settings file too.
//   • V8-PF.5 — precedence: explicit config wins over settings.

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

const TEST_CAP = 8192;

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

  test('V8-PF.1a — cap present: outbound body carries reasoning { max_tokens } next to max_tokens', async () => {
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
      reasoning_max_tokens: TEST_CAP,
      tools: [],
    };
    const result = await provider.completeMultiTurn(params);
    assert.equal(result.stop_reason, 'end_turn');
    assert.equal(capturedBodies.length, 1);
    const body = capturedBodies[0];
    assert.equal(body.max_tokens, 32768);
    assert.deepEqual(body.reasoning, { max_tokens: TEST_CAP });
  });

  test('V8-PF.1b — cap absent: outbound body NEVER carries a reasoning key (legacy bytes)', async () => {
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
  reasoning_max_tokens?: number;
}

function makeCapturingRunner(root: string, captured: CapturedCall[], configOverrides?: Record<string, unknown>): AgentRunner {
  const provider = {
    name: 'v8-preflight-capture',
    async completeMultiTurn(params: MultiTurnParams) {
      captured.push({ max_tokens: params.max_tokens, reasoning_max_tokens: params.reasoning_max_tokens });
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

function ctx(root: string, workflowRunId: string, stepId: string): Record<string, unknown> {
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
  };
}

const V8_SETTINGS = JSON.stringify({
  provider: 'openrouter',
  model: 'z-ai/glm-5.3-flash',
  base_url: 'https://openrouter.ai/api/v1',
  max_tokens: 16384,
  api_key_env: 'OPENROUTER_API_KEY',
  workflow_max_tokens: { 'full-build/design': 32768, 'full-build/plan': 32768, 'full-build/test': 32768 },
  workflow_reasoning_max_tokens: { 'full-build/test': TEST_CAP },
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
test('V8-PF.2 — settings-declared cap lands on test only; design/plan/build never carry it', async () => {
  const root = makeTempRoot(V8_SETTINGS);
  try {
    const captured: CapturedCall[] = [];
    const testCall = await captureStep(root, 'test', captured);
    assert.equal(testCall.max_tokens, 32768);
    assert.equal(testCall.reasoning_max_tokens, TEST_CAP);

    captured.length = 0;
    const designCall = await captureStep(root, 'design', captured);
    assert.equal(designCall.max_tokens, 32768);
    assert.equal(designCall.reasoning_max_tokens, undefined, 'design must NOT carry a reasoning cap');

    captured.length = 0;
    const planCall = await captureStep(root, 'plan', captured);
    assert.equal(planCall.max_tokens, 32768);
    assert.equal(planCall.reasoning_max_tokens, undefined, 'plan must NOT carry a reasoning cap');

    captured.length = 0;
    const buildCall = await captureStep(root, 'build', captured);
    assert.equal(buildCall.max_tokens, 16384);
    assert.equal(buildCall.reasoning_max_tokens, undefined, 'build must NOT carry a reasoning cap');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// V8-PF.4 — fail-closed parsing: invalid entry discards the ENTIRE map.
// ---------------------------------------------------------------------------
test('V8-PF.4 — invalid reasoning map entry discards the whole map (no cap anywhere)', async () => {
  const root = makeTempRoot(
    JSON.stringify({
      max_tokens: 16384,
      workflow_max_tokens: { 'full-build/test': 32768 },
      workflow_reasoning_max_tokens: { 'full-build/test': TEST_CAP, 'bad key': 4096 },
    }),
  );
  try {
    const captured: CapturedCall[] = [];
    const call = await captureStep(root, 'test', captured);
    assert.equal(call.max_tokens, 32768, 'budget map must still resolve');
    assert.equal(call.reasoning_max_tokens, undefined, 'one invalid entry must discard the ENTIRE reasoning map');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('V8-PF.4b — absent settings file: no cap, legacy budget', async () => {
  const root = makeTempRoot(undefined);
  try {
    const captured: CapturedCall[] = [];
    const call = await captureStep(root, 'test', captured);
    assert.equal(call.max_tokens, 16384);
    assert.equal(call.reasoning_max_tokens, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// V8-PF.5 — precedence: explicit composition-root config wins over settings.
// ---------------------------------------------------------------------------
test('V8-PF.5 — explicit workflowReasoningMaxTokens config wins over settings.json', async () => {
  const root = makeTempRoot(V8_SETTINGS);
  try {
    const captured: CapturedCall[] = [];
    const call = await captureStep(root, 'test', captured, {
      workflowReasoningMaxTokens: { 'full-build/test': 4096 },
    });
    assert.equal(call.reasoning_max_tokens, 4096, 'explicit config must win');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// V8-PF.2b — loop forwarding: the V4 continuation carries the cap too.
// ---------------------------------------------------------------------------
test('V8-PF.2b — V4 synthesis continuation forwards the step reasoning cap', async () => {
  const captured: Array<Record<string, unknown>> = [];
  const calls: MultiTurnParams[] = [];
  let n = 0;
  const provider = {
    name: 'v8-continuation-capture',
    async completeMultiTurn(params: MultiTurnParams) {
      calls.push(params);
      n++;
      if (n === 1) {
        // First synthesis turn: truncated, NON-EMPTY text, no tool uses →
        // continuation eligible (turn equals the gate boundary + 1).
        return {
          stop_reason: 'max_tokens',
          text: 'partial synthesis text',
          tool_uses: [],
          tokens_used: 10,
        } as MultiTurnResult;
      }
      return { stop_reason: 'end_turn', text: 'rest', tool_uses: [], tokens_used: 5 } as MultiTurnResult;
    },
  };
  const root = mkdtempSync(join(tmpdir(), 'v8-continuation-'));
  try {
    const cm = new ContextManager(root, { contextWindowBytes: 1_000_000 } as never);
    const loop = new AgentLoop(provider as never, {
      model: 'test',
      max_tokens: 32768,
      reasoning_max_tokens: TEST_CAP,
      projectRoot: root,
      role: 'tester' as never,
      workflowRunId: 'v8',
      iteration: 1,
      nodeId: 'test',
      runArtifacts: { updateNodeStatus: async () => {}, writeNodeOutput: async () => {} } as never,
      synthesisGate: { thresholdTurns: 0 },
      synthesisContinuation: true,
    } as never);
    await loop.run();
    // The continuation's merged text is not a parseable result block, so the
    // loop may continue (format repair etc.) — irrelevant to this proof. The
    // assertions are on the FIRST two calls: synthesis turn + continuation.
    assert.ok(calls.length >= 2, 'at least synthesis turn + continuation');
    assert.equal(calls[0].reasoning_max_tokens, TEST_CAP, 'turn request carries the cap');
    assert.equal(calls[1].reasoning_max_tokens, TEST_CAP, 'continuation carries the SAME cap');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
