// V4-D1 — synthesis-exhaustion wire observation (OBSERVATION-ONLY).
//
// The V4 evaluable block failed 3/3 on `max_tokens` + zero visible text at
// the first forced DESIGN synthesis turn. The open causal question: what
// consumed the completion ceiling before visible output? This change makes
// the SSE transport OBSERVE the wire — reasoning-channel presence/counts,
// usage breakdown (completion/reasoning/prompt tokens), stream identity —
// WITHOUT changing any request, semantic, or contract behavior.
//
// Invariants pinned here:
//   • the crucial diagnostic shape — reasoning activity + ZERO delta.content
//     + finish_reason "length" — assembles to empty text with a faithful
//     observation (reasoning counted in chunks/bytes, reasoning_tokens from
//     the usage breakdown);
//   • reasoning TEXT is never retained anywhere in the assembled result;
//   • no request mutation: the wire carries exactly what the provider sent
//     before D1 (no reasoning settings, no budget changes);
//   • post-finish reasoning deltas remain inert and uncounted (contract
//     unchanged);
//   • identity/usage fields: last-supplied usage wins, first-supplied
//     identity wins, strings bounded;
//   • the observation flows through the provider (MultiTurnResult), the loop
//     failure observation, and the runner's failure `-loop.json` evidence.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SseStreamAccumulator } from '../src/sse-accumulator.js';
import { OpenAICompatibleMultiTurnProvider } from '../src/llm-provider.js';
import { AgentLoop } from '../src/agent-loop.js';
import { AgentRunner } from '../src/agent-runner.js';
import { ContextManager } from '../src/context-manager.js';
import { sseResponse } from './sse-test-utils.js';
import type { MultiTurnParams } from '../src/agent-loop.js';

process.env.STREAMING_TEST_API_KEY = 'test-key';

const CONFIG = {
  provider: 'openrouter',
  api_key_env: 'STREAMING_TEST_API_KEY',
  model: 'test-model',
} as const;

function baseParams(overrides: Partial<MultiTurnParams> = {}): MultiTurnParams {
  return {
    model: 'test-model',
    system: 'sys',
    messages: [{ role: 'user', content: 'u' }],
    max_tokens: 100,
    tools: [],
    ...overrides,
  };
}

function withFetch(body: () => Response): void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => body()) as typeof fetch;
  (globalThis as { __restoreFetch?: () => void }).__restoreFetch = () => {
    globalThis.fetch = original;
  };
}

function feedAll(acc: SseStreamAccumulator, events: Array<object | '[DONE]'>): void {
  for (const e of events) {
    acc.feed(e === '[DONE]' ? 'data: [DONE]\n\n' : `data: ${JSON.stringify(e)}\n\n`);
  }
}

// ─── Accumulator unit tests (pure, no fetch) ────────────────────────────────

test('V4D1.1: THE crucial shape — reasoning activity + zero content + finish_reason length assembles to empty text with a faithful observation', () => {
  const acc = new SseStreamAccumulator();
  const events: object[] = [
    { id: 'gen-abc123', model: 'z-ai/glm-5.3-flash', provider: 'zhipu-high-context', choices: [{ delta: { role: 'assistant' } }] },
    { choices: [{ delta: { reasoning: '私は最初に' } }] },
    { choices: [{ delta: { reasoning: '要件を分析する…' } }] },
    { choices: [{ delta: {} }] },
    { choices: [{ delta: {}, finish_reason: 'length' }] },
    { choices: [{ delta: { content: '' } }], usage: { total_tokens: 32768, prompt_tokens: 54011, completion_tokens: 32768, completion_tokens_details: { reasoning_tokens: 32712 } } },
    '[DONE]',
  ];
  for (const e of events) {
    acc.feed(typeof e === 'string' ? `data: [DONE]\n\n` : `data: ${JSON.stringify(e)}\n\n`);
  }
  acc.end();
  const a = acc.assemble();
  assert.equal(a.text, '');
  assert.equal(a.finishReason, 'length');
  const w = a.wireObservation;
  assert.equal(w.reasoning_chunks, 2);
  assert.equal(w.reasoning_bytes, Buffer.byteLength('私は最初に要件を分析する…', 'utf8'));
  assert.deepEqual(w.reasoning_fields, ['reasoning']);
  assert.equal(w.content_bytes, 0);
  assert.equal(w.tool_call_fragments, 0);
  assert.equal(w.finish_reason, 'length');
  assert.equal(w.completion_tokens, 32768);
  assert.equal(w.reasoning_tokens, 32712);
  assert.equal(w.prompt_tokens, 54011);
  assert.equal(w.total_tokens, 32768);
  assert.equal(w.stream_id, 'gen-abc123');
  assert.equal(w.model, 'z-ai/glm-5.3-flash');
  assert.equal(w.provider, 'zhipu-high-context');
  // The reasoning TEXT must not be retained anywhere in the assembled result.
  const dumped = JSON.stringify(a);
  assert.ok(!dumped.includes('私'), 'reasoning text leaked into assembled result');
});

test('V4D1.2: reasoning_content alias field is observed and labeled', () => {
  const acc = new SseStreamAccumulator();
  feedAll(acc, [
    { choices: [{ delta: { reasoning_content: 'plan the charter sections' } }] },
    { choices: [{ delta: { reasoning_content: '…continue' } }] },
    { choices: [{ delta: { reasoning_content: '…end' }, finish_reason: 'length' }] },
    '[DONE]',
  ]);
  acc.end();
  const a = acc.assemble();
  assert.equal(a.text, '');
  assert.equal(a.wireObservation.reasoning_chunks, 3);
  assert.deepEqual(a.wireObservation.reasoning_fields, ['reasoning_content']);
  assert.ok(a.wireObservation.reasoning_bytes > 0);
  assert.ok(!JSON.stringify(a).includes('plan the charter sections'), 'reasoning text leaked');
});

test('V4D1.3: mixed stream — reasoning + partial content + tool fragments all counted independently', () => {
  const acc = new SseStreamAccumulator();
  feedAll(acc, [
    { choices: [{ delta: { reasoning: 'think' } }] },
    { choices: [{ delta: { content: '<<<SLE-OUTPUT>>>' } }] },
    { choices: [{ delta: { reasoning: ' more' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 't1', function: { name: 'read_file', arguments: '{"pa' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"x"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'length' }] },
    '[DONE]',
  ]);
  acc.end();
  const a = acc.assemble();
  assert.equal(a.text, '<<<SLE-OUTPUT>>>');
  assert.equal(a.toolCalls.length, 1);
  const w = a.wireObservation;
  assert.equal(w.reasoning_chunks, 2);
  assert.equal(w.reasoning_bytes, Buffer.byteLength('think more', 'utf8'));
  assert.equal(w.content_bytes, Buffer.byteLength('<<<SLE-OUTPUT>>>', 'utf8'));
  assert.equal(w.tool_call_fragments, 2);
});

test('V4D1.4: no reasoning, no breakdown — observation reports zeros and nulls honestly', () => {
  const acc = new SseStreamAccumulator();
  feedAll(acc, [
    { choices: [{ delta: { content: 'hello' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
    { choices: [{ delta: {} }], usage: { total_tokens: 42 } },
    '[DONE]',
  ]);
  acc.end();
  const w = acc.assemble().wireObservation;
  assert.equal(w.reasoning_chunks, 0);
  assert.equal(w.reasoning_bytes, 0);
  assert.deepEqual(w.reasoning_fields, []);
  assert.equal(w.completion_tokens, null);
  assert.equal(w.reasoning_tokens, null);
  assert.equal(w.prompt_tokens, null);
  assert.equal(w.total_tokens, 42);
  assert.equal(w.stream_id, null);
  assert.equal(w.provider, null);
});

test('V4D1.5: post-finish reasoning deltas stay inert and uncounted (contract unchanged)', () => {
  const acc = new SseStreamAccumulator();
  feedAll(acc, [
    { choices: [{ delta: { reasoning: 'pre-finish thinking' } }] },
    { choices: [{ delta: {}, finish_reason: 'length' }] },
    { choices: [{ delta: { reasoning: 'POST-FINISH must be ignored' } }] },
    { choices: [{ delta: { reasoning_content: 'also post' } }], usage: { total_tokens: 7 } },
    '[DONE]',
  ]);
  acc.end();
  const a = acc.assemble();
  assert.equal(a.finishReason, 'length');
  const w = a.wireObservation;
  assert.equal(w.reasoning_chunks, 1);
  assert.equal(w.reasoning_bytes, Buffer.byteLength('pre-finish thinking', 'utf8'));
  assert.ok(!JSON.stringify(a).includes('POST-FINISH'), 'post-finish reasoning leaked');
});

test('V4D1.6: identity fields — first value wins; overlong strings bounded; usage — last value wins', () => {
  const acc = new SseStreamAccumulator();
  const longId = 'g'.repeat(500);
  feedAll(acc, [
    { id: longId, model: 'first-model', provider: 'first-provider', choices: [{ delta: {} }] },
    { id: 'second-id', model: 'second-model', provider: 'second-provider', choices: [{ delta: {} }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { total_tokens: 1, completion_tokens: 1 } },
    { choices: [{ delta: {} }], usage: { total_tokens: 2, completion_tokens: 2, completion_tokens_details: { reasoning_tokens: 0 } } },
    '[DONE]',
  ]);
  acc.end();
  const w = acc.assemble().wireObservation;
  assert.equal(w.stream_id, 'g'.repeat(200), 'identity bounded to 200 chars, first value kept');
  assert.equal(w.model, 'first-model');
  assert.equal(w.provider, 'first-provider');
  assert.equal(w.total_tokens, 2);
  assert.equal(w.completion_tokens, 2);
  assert.equal(w.reasoning_tokens, 0);
});

test('V4D1.7: framing independence — reasoning deltas split across arbitrary network chunks', () => {
  const acc = new SseStreamAccumulator();
  const wire =
    `data: ${JSON.stringify({ choices: [{ delta: { reasoning: 'a'.repeat(100) } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: { reasoning: 'b'.repeat(50) } }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n\ndata: [DONE]\n\n`;
  // feed in hostile 7-byte chunks
  for (let i = 0; i < wire.length; i += 7) acc.feed(wire.slice(i, i + 7));
  acc.end();
  const w = acc.assemble().wireObservation;
  assert.equal(w.reasoning_chunks, 2);
  assert.equal(w.reasoning_bytes, 150);
  assert.equal(w.finish_reason, 'length');
});

// ─── Provider-level integration (mocked fetch, real Response streams) ───────

test('V4D1.8: provider surfaces the observation on MultiTurnResult without mutating the request', async () => {
  let capturedBody: Record<string, unknown> | undefined;
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    capturedBody = JSON.parse(init!.body as string);
    return sseResponse([
      { id: 'gen-1', provider: 'routeprovider', choices: [{ delta: { reasoning: 'silent reasoning' } }] },
      { choices: [{ delta: {}, finish_reason: 'length' }] },
      { choices: [{ delta: { content: '' } }], usage: { total_tokens: 100, prompt_tokens: 10, completion_tokens: 90, completion_tokens_details: { reasoning_tokens: 88 } } },
      '[DONE]',
    ] as never);
  }) as typeof fetch;
  try {
    const provider = new OpenAICompatibleMultiTurnProvider(CONFIG);
    const result = await provider.completeMultiTurn(baseParams());
    assert.equal(result.text, '');
    assert.equal(result.stop_reason, 'max_tokens');
    assert.ok(result.wire_observation, 'observation present');
    assert.equal(result.wire_observation!.reasoning_chunks, 1);
    assert.equal(result.wire_observation!.reasoning_tokens, 88);
    assert.equal(result.wire_observation!.provider, 'routeprovider');
    // No request mutation: the body carries no reasoning controls.
    assert.ok(!('reasoning' in (capturedBody ?? {})), 'reasoning request field must not be introduced');
    assert.ok(!('reasoning_effort' in (capturedBody ?? {})), 'reasoning_effort request field must not be introduced');
    assert.equal(capturedBody!['max_tokens'], 100, 'completion ceiling unchanged');
  } finally {
    globalThis.fetch = original;
  }
});

// ─── Loop-level: observation lands in the failure evidence channels ─────────

test('V4D1.9: loop failure observation carries wire_observation with no extra model calls', async () => {
  const root = mkdtempSync(join(tmpdir(), 'v4d1-'));
  try {
    const { RunArtifactManager } = await import('../src/run-artifacts.js');
    const wireObservation = {
      reasoning_chunks: 5,
      reasoning_bytes: 412,
      reasoning_fields: ['reasoning'],
      content_bytes: 0,
      tool_call_fragments: 0,
      finish_reason: 'length',
      completion_tokens: 32768,
      reasoning_tokens: 32755,
      prompt_tokens: 54011,
      total_tokens: 32768,
      stream_id: 'gen-x',
      model: 'z-ai/glm-5.3-flash',
      provider: 'zhipu-high-context',
    };
    let call = 0;
    const provider = {
      name: 'fake',
      async completeMultiTurn() {
        call += 1;
        return {
          stop_reason: 'max_tokens',
          text: '',
          tool_uses: [],
          tokens_used: 32768,
          wire_observation: wireObservation,
        };
      },
    };
    const loop = new AgentLoop(provider as never, {
      model: 'v4-model',
      max_tokens: 512,
      projectRoot: root,
      role: 'designer',
      workflowRunId: 'v4d1-run',
      iteration: 1,
      nodeId: 'design',
      runArtifacts: new RunArtifactManager({ projectRoot: root }),
      listTrackedFiles: async () => [],
      synthesisGate: { thresholdTurns: 18 },
      synthesisContinuation: false,
    } as never);
    const result = await loop.run('system', 'produce');
    assert.equal(result.success, false);
    assert.ok(result.failure_observation, 'failure observation present');
    assert.deepEqual(result.failure_observation!.wire_observation, wireObservation, 'observation on the failure channel');
    assert.equal(result.failure_observation!.text_length, 0);
    assert.equal(result.failure_observation!.stop_reason, 'max_tokens');
    assert.equal(call, 1, 'no extra model calls — observation is passive');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── Runner-level: the archived failure evidence carries the observation ────

test('V4D1.10: runner persists wire_observation in the failure -loop.json evidence file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'v4d1-'));
  const wireObservation = {
    reasoning_chunks: 9,
    reasoning_bytes: 733,
    reasoning_fields: ['reasoning'],
    content_bytes: 0,
    tool_call_fragments: 0,
    finish_reason: 'length',
    completion_tokens: 32768,
    reasoning_tokens: 32740,
    prompt_tokens: 54011,
    total_tokens: 32768,
    stream_id: 'gen-runner',
    model: 'z-ai/glm-5.3-flash',
    provider: 'zhipu-high-context',
  };
  const provider = {
    name: 'fake',
    async completeMultiTurn() {
      return {
        stop_reason: 'max_tokens',
        text: '',
        tool_uses: [],
        tokens_used: 32768,
        wire_observation: wireObservation,
      };
    },
  };
  try {
    const cm = new ContextManager(root, { contextWindowBytes: 1_000_000 } as never);
    const runner = new AgentRunner(
      cm,
      provider as never,
      root,
      { updateNodeStatus: async () => {}, writeNodeOutput: async () => {} } as never,
      { model: 'test' } as never,
      undefined,
      undefined as never,
    );
    const result = await runner.run('designer', {
      workflowRunId: 'v4d1-run',
      workflowId: 'full-build',
      stepId: 'design',
      iteration: 1,
      revision: 0,
      goal: 'g',
      projectRoot: root,
      instruction: 'Produce your artifacts.',
      authorizedOutputs: ['docs/requirements.md', 'docs/architecture.md'],
      synthesisGate: { thresholdTurns: 0 },
      synthesisContinuation: false,
    } as never);
    assert.equal(result.success, false);
    const metaPath = join(root, '.sle', 'runs', 'v4d1-run', '1', 'node-outputs', 'design-loop.json');
    assert.ok(existsSync(metaPath), 'failure-path loop json written');
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    assert.deepEqual(meta.wire_observation, wireObservation, 'the archived evidence carries the wire observation');
    assert.equal(meta.failed, true);
    assert.equal(meta.stop_reason, 'max_tokens');
    assert.equal(meta.text_length, 0);
    assert.ok(!JSON.stringify(meta).includes('reasoning text'), 'no reasoning text in evidence');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
