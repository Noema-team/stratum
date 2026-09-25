// Transport-hardening PR — deterministic provider-level streaming tests.
//
// Covers the SSE transport regime of OpenAICompatibleMultiTurnProvider:
//   • SSE framing split across arbitrary network chunks
//   • multiple SSE events in one network chunk
//   • streamed text accumulation
//   • streamed tool calls (identity delta + argument fragments)
//   • tool-call arguments fragmented across multiple deltas
//   • multiple tool calls in one turn (interleaved indexes)
//   • finish_reason mapping (parity with the legacy non-streaming mapping)
//   • token/usage accounting when available (usage-only trailing chunk)
//   • clean stream termination ([DONE], and end-without-[DONE] after finish)
//   • remote disconnect before completion → transport error, NEVER partial success
//   • malformed / truncated SSE → fail closed
//   • AbortSignal propagation
//   • multibyte UTF-8 split across network chunks
//
// All tests are offline: the wire is authored by the test via real Response
// objects whose bodies are ReadableStreams (see tests/sse-test-utils.ts).

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OpenAICompatibleMultiTurnProvider } from '../src/llm-provider.js';
import { SseStreamAccumulator, SseParseError } from '../src/sse-accumulator.js';
import { AgentLoop, type AgentLoopResult } from '../src/agent-loop.js';
import { RunArtifactManager } from '../src/run-artifacts.js';
import { sseResponse, jsonResponse, failingResponse, chunk, openrouterProductionFixture, type SseEvent } from './sse-test-utils.js';
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

function withFetch(body: () => Response, captured?: { body?: Record<string, unknown>; signal?: AbortSignal | null }): void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    if (captured) {
      captured.body = JSON.parse(init!.body as string);
      captured.signal = init!.signal ?? null;
    }
    return body();
  }) as typeof fetch;
  // Restore is the test's job via finally; keep a handle on the test object.
  (globalThis as { __restoreFetch?: () => void }).__restoreFetch = () => {
    globalThis.fetch = original;
  };
}

const TOOL: MultiTurnParams['tools'][number] = {
  name: 'read_file',
  description: 'Read a file.',
  input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
};

// ─── Accumulator unit tests (pure, no fetch at all) ───────────────────────────

test('accumulator: SSE framing split across arbitrary chunk boundaries', () => {
  const wire = sseEventize([
    chunk({ content: 'Hel' }),
    chunk({ content: 'lo' }, 'stop'),
    '[DONE]',
  ]);
  const acc = new SseStreamAccumulator();
  // Feed one character at a time — maximally hostile framing.
  for (const ch of wire) acc.feed(ch);
  acc.end();
  const a = acc.assemble();
  assert.equal(a.text, 'Hello');
  assert.equal(a.finishReason, 'stop');
  assert.equal(a.sawDone, true);
});

test('accumulator: multiple SSE events in one chunk', () => {
  const acc = new SseStreamAccumulator();
  acc.feed(`data: ${JSON.stringify(chunk({ content: 'a' }))}\n\ndata: ${JSON.stringify(chunk({ content: 'b' }))}\n\ndata: ${JSON.stringify(chunk({ content: 'c' }, 'stop'))}\n\n`);
  acc.end();
  assert.equal(acc.assemble().text, 'abc');
});

test('accumulator: CRLF framing and comment/keep-alive lines', () => {
  const acc = new SseStreamAccumulator();
  acc.feed(': keep-alive\r\n\r\ndata: ' + JSON.stringify(chunk({ content: 'x' })) + '\r\n\r\n: ping\r\n\r\ndata: ' + JSON.stringify(chunk({}, 'stop')) + '\r\n\r\n');
  acc.end();
  const a = acc.assemble();
  assert.equal(a.text, 'x');
  assert.equal(a.finishReason, 'stop');
});

test('accumulator: multiple data lines in one event are joined with newline (SSE spec)', () => {
  // A JSON payload split across two data lines reassembles to valid JSON.
  const payload = JSON.stringify(chunk({ content: 'y' }, 'stop'));
  const half = Math.floor(payload.length / 2);
  const acc = new SseStreamAccumulator();
  acc.feed(`data: ${payload.slice(0, half)}\ndata: ${payload.slice(half)}\n\n`);
  acc.end();
  assert.equal(acc.assemble().text, 'y');
});

test('accumulator: tool-call arguments fragmented across deltas + two interleaved tool calls', () => {
  const acc = new SseStreamAccumulator();
  const events: Array<object> = [
    chunk({ tool_calls: [{ index: 0, id: 'call_a', function: { name: 'read_file', arguments: '{"pa' } }] }),
    chunk({ tool_calls: [{ index: 1, id: 'call_b', function: { name: 'list_directory', arguments: '{"dir"' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: 'th":"docs/x.md"}' } }] }),
    chunk({ tool_calls: [{ index: 1, function: { arguments: ':\"docs"}' } }] }),
    chunk({}, 'tool_calls'),
  ];
  for (const e of events) acc.feed(`data: ${JSON.stringify(e)}\n\n`);
  acc.end();
  const a = acc.assemble();
  assert.deepEqual(a.toolCalls, [
    { id: 'call_a', name: 'read_file', arguments: '{"path":"docs/x.md"}' },
    { id: 'call_b', name: 'list_directory', arguments: '{"dir":"docs"}' },
  ]);
  assert.equal(a.finishReason, 'tool_calls');
});

test('accumulator: truncated stream (no finish_reason) fails closed', () => {
  const acc = new SseStreamAccumulator();
  acc.feed(`data: ${JSON.stringify(chunk({ content: 'partial' }))}\n\n`);
  acc.end();
  assert.throws(() => acc.assemble(), SseParseError);
});

test('accumulator: malformed JSON data payload fails closed', () => {
  const acc = new SseStreamAccumulator();
  assert.throws(() => acc.feed('data: {"choices": [broken\n\n'), SseParseError);
});

test('accumulator: non-SSE junk line fails closed', () => {
  const acc = new SseStreamAccumulator();
  assert.throws(() => acc.feed('this is not sse\n\n'), SseParseError);
});

// ─── Provider-level tests (mocked fetch, real Response streams) ───────────────

test('provider: streamed text accumulates into MultiTurnResult (end_turn)', async () => {
  withFetch(() => sseResponse([
    chunk({ content: 'Hel' }),
    chunk({ content: 'lo world' }),
    chunk({}, 'stop', { total_tokens: 7 }),
    '[DONE]',
  ]));
  try {
    const provider = new OpenAICompatibleMultiTurnProvider(CONFIG);
    const result = await provider.completeMultiTurn(baseParams());
    assert.equal(result.text, 'Hello world');
    assert.equal(result.stop_reason, 'end_turn');
    assert.equal(result.tokens_used, 7);
    assert.equal(result.tool_uses.length, 0);
  } finally {
    (globalThis as { __restoreFetch?: () => void }).__restoreFetch?.();
  }
});

test('provider: wire carries stream:true and forwards AbortSignal when supplied', async () => {
  const captured: { body?: Record<string, unknown>; signal?: AbortSignal | null } = {};
  const controller = new AbortController();
  withFetch(() => sseResponse([chunk({}, 'stop'), '[DONE]']), captured);
  try {
    const provider = new OpenAICompatibleMultiTurnProvider(CONFIG);
    await provider.completeMultiTurn(baseParams({ signal: controller.signal }));
    assert.equal(captured.body!.stream, true, 'the streaming wire must declare stream:true');
    assert.equal(captured.signal, controller.signal, 'the transport must forward the caller AbortSignal');
  } finally {
    (globalThis as { __restoreFetch?: () => void }).__restoreFetch?.();
  }
});

test('provider: no signal supplied → wire omits it (legacy-identical call shape apart from stream:true)', async () => {
  const captured: { body?: Record<string, unknown>; signal?: AbortSignal | null } = {};
  withFetch(() => sseResponse([chunk({}, 'stop'), '[DONE]']), captured);
  try {
    const provider = new OpenAICompatibleMultiTurnProvider(CONFIG);
    await provider.completeMultiTurn(baseParams());
    assert.ok(captured.signal === null || captured.signal === undefined, 'no AbortSignal on the wire unless the caller supplies one');
    assert.ok(!('signal' in captured.body!), 'request body must not carry a signal field');
  } finally {
    (globalThis as { __restoreFetch?: () => void }).__restoreFetch?.();
  }
});

test('provider: streamed tool call — identity delta then fragmented arguments', async () => {
  withFetch(() => sseResponse([
    chunk({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"path":"' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: 'docs/a.md"}' } }] }),
    chunk({}, 'tool_calls'),
    '[DONE]',
  ]));
  try {
    const provider = new OpenAICompatibleMultiTurnProvider(CONFIG);
    const result = await provider.completeMultiTurn(baseParams({ tools: [TOOL] }));
    assert.equal(result.stop_reason, 'tool_use');
    assert.equal(result.tool_uses.length, 1);
    assert.equal(result.tool_uses[0].id, 'call_1');
    assert.equal(result.tool_uses[0].name, 'read_file');
    assert.deepStrictEqual(result.tool_uses[0].input, { path: 'docs/a.md' });
  } finally {
    (globalThis as { __restoreFetch?: () => void }).__restoreFetch?.();
  }
});

test('provider: multiple tool calls in one turn, interleaved indexes', async () => {
  withFetch(() => sseResponse([
    chunk({ tool_calls: [{ index: 0, id: 'c0', function: { name: 'read_file', arguments: '{"path":"x"}' } }] }),
    chunk({ tool_calls: [{ index: 1, id: 'c1', function: { name: 'list_directory', arguments: '{"dir":"d"}' } }] }),
    chunk({}, 'tool_calls'),
    '[DONE]',
  ]));
  try {
    const provider = new OpenAICompatibleMultiTurnProvider(CONFIG);
    const result = await provider.completeMultiTurn(baseParams({ tools: [TOOL] }));
    assert.equal(result.tool_uses.length, 2);
    assert.deepEqual(result.tool_uses.map((t) => t.name), ['read_file', 'list_directory']);
    assert.deepEqual(result.tool_uses.map((t) => t.id), ['c0', 'c1']);
  } finally {
    (globalThis as { __restoreFetch?: () => void }).__restoreFetch?.();
  }
});

test('provider: finish_reason mapping parity — stop→end_turn, length→max_tokens, tool_use wins when tool calls present even at stop', async () => {
  const eventsFor = (finish: string, withTool: boolean): SseEvent[] => withTool
    ? [chunk({ tool_calls: [{ index: 0, id: 'c', function: { name: 'read_file', arguments: '{}' } }] }), chunk({}, finish), '[DONE]']
    : [chunk({ content: 't' }), chunk({}, finish), '[DONE]'];
  let events: SseEvent[] = [];
  withFetch(() => sseResponse(events));
  try {
    const provider = new OpenAICompatibleMultiTurnProvider(CONFIG);
    events = eventsFor('stop', false);
    assert.equal((await provider.completeMultiTurn(baseParams())).stop_reason, 'end_turn');
    events = eventsFor('length', false);
    assert.equal((await provider.completeMultiTurn(baseParams())).stop_reason, 'max_tokens');
    events = eventsFor('tool_calls', true);
    assert.equal((await provider.completeMultiTurn(baseParams({ tools: [TOOL] }))).stop_reason, 'tool_use');
    // Legacy parity: tool calls present but finish_reason 'stop' still maps to tool_use.
    events = eventsFor('stop', true);
    assert.equal((await provider.completeMultiTurn(baseParams({ tools: [TOOL] }))).stop_reason, 'tool_use');
  } finally {
    (globalThis as { __restoreFetch?: () => void }).__restoreFetch?.();
  }
});

test('provider: usage captured from trailing usage-only chunk (after finish_reason)', async () => {
  withFetch(() => sseResponse([
    chunk({ content: 'done' }, 'stop'),
    { choices: [], usage: { total_tokens: 123 } },
    '[DONE]',
  ]));
  try {
    const provider = new OpenAICompatibleMultiTurnProvider(CONFIG);
    const result = await provider.completeMultiTurn(baseParams());
    assert.equal(result.tokens_used, 123);
    assert.equal(result.text, 'done');
  } finally {
    (globalThis as { __restoreFetch?: () => void }).__restoreFetch?.();
  }
});

test('provider: clean termination without [DONE] (stream ends after finish_reason) succeeds', async () => {
  // OpenRouter-compatible servers may close the stream after the finish chunk.
  withFetch(() => sseResponse([chunk({ content: 'ok' }, 'stop', { total_tokens: 3 })]));
  try {
    const provider = new OpenAICompatibleMultiTurnProvider(CONFIG);
    const result = await provider.completeMultiTurn(baseParams());
    assert.equal(result.text, 'ok');
    assert.equal(result.tokens_used, 3);
  } finally {
    (globalThis as { __restoreFetch?: () => void }).__restoreFetch?.();
  }
});

test('provider: remote disconnect mid-stream (before finish_reason) THROWS — no partial generation', async () => {
  withFetch(() => failingResponse(new Error('other side closed'), `data: ${JSON.stringify(chunk({ content: 'partial te' }))}\n\n`));
  try {
    const provider = new OpenAICompatibleMultiTurnProvider(CONFIG);
    await assert.rejects(
      provider.completeMultiTurn(baseParams()),
      /LLM stream failed before completion \(transport\)[\s\S]*no partial generation/,
    );
  } finally {
    (globalThis as { __restoreFetch?: () => void }).__restoreFetch?.();
  }
});

test('provider: remote disconnect with zero bytes (failure before first byte) THROWS', async () => {
  withFetch(() => failingResponse(Object.assign(new Error('terminated'), { cause: { code: 'UND_ERR_SOCKET', message: 'other side closed' } })));
  try {
    const provider = new OpenAICompatibleMultiTurnProvider(CONFIG);
    await assert.rejects(
      provider.completeMultiTurn(baseParams()),
      /UND_ERR_SOCKET/,
    );
  } finally {
    (globalThis as { __restoreFetch?: () => void }).__restoreFetch?.();
  }
});

test('provider: disconnect AFTER finish_reason still yields the completed result (usage chunk loss tolerated)', async () => {
  withFetch(() => failingResponse(new Error('trailing connection lost'), `data: ${JSON.stringify(chunk({ content: 'complete' }, 'stop', { total_tokens: 9 }))}\n\n`));
  try {
    const provider = new OpenAICompatibleMultiTurnProvider(CONFIG);
    const result = await provider.completeMultiTurn(baseParams());
    assert.equal(result.text, 'complete');
    assert.equal(result.tokens_used, 9);
  } finally {
    (globalThis as { __restoreFetch?: () => void }).__restoreFetch?.();
  }
});

test('provider: malformed SSE mid-stream (invalid JSON data line) THROWS — fail closed', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      controller.enqueue(enc.encode(`data: ${JSON.stringify(chunk({ content: 'ok so far' }))}\n\n`));
      controller.enqueue(enc.encode('data: {{{not-json\n\n'));
      controller.close();
    },
  });
  withFetch(() => new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
  try {
    const provider = new OpenAICompatibleMultiTurnProvider(CONFIG);
    await assert.rejects(provider.completeMultiTurn(baseParams()), SseParseError);
  } finally {
    (globalThis as { __restoreFetch?: () => void }).__restoreFetch?.();
  }
});

test('provider: truncated SSE stream (ends mid-event, no finish_reason) THROWS — no partial success', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      controller.enqueue(enc.encode(`data: ${JSON.stringify(chunk({ content: 'half a' }))}\n\ndata: {"choices": [{"del`));
      controller.close(); // stream ends mid-event, no finish_reason, no [DONE]
    },
  });
  withFetch(() => new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
  try {
    const provider = new OpenAICompatibleMultiTurnProvider(CONFIG);
    // Fail-closed either way: a mid-event end surfaces as a malformed-payload
    // parse error; a clean-event-boundary end without finish_reason surfaces
    // as "stream ended without finish_reason". Both are SseParseError.
    await assert.rejects(provider.completeMultiTurn(baseParams()), SseParseError);
  } finally {
    (globalThis as { __restoreFetch?: () => void }).__restoreFetch?.();
  }
});

test('provider: non-2xx response keeps the legacy error contract', async () => {
  withFetch(() => new Response('{"error":{"message":"rate limited"}}', { status: 429, statusText: 'Too Many Requests' }));
  try {
    const provider = new OpenAICompatibleMultiTurnProvider(CONFIG);
    await assert.rejects(provider.completeMultiTurn(baseParams()), /429 Too Many Requests/);
  } finally {
    (globalThis as { __restoreFetch?: () => void }).__restoreFetch?.();
  }
});

test('provider: non-SSE 200 JSON body (wrong content regime) THROWS — never silently mis-parsed', async () => {
  withFetch(() => jsonResponse({ choices: [{ message: { content: 'legacy shape' }, finish_reason: 'stop' }] }));
  try {
    const provider = new OpenAICompatibleMultiTurnProvider(CONFIG);
    await assert.rejects(provider.completeMultiTurn(baseParams()), SseParseError);
  } finally {
    (globalThis as { __restoreFetch?: () => void }).__restoreFetch?.();
  }
});

test('provider: multibyte UTF-8 split across network chunks decodes losslessly', async () => {
  const text = 'defn ✓ 多字节 émigré — ok';
  withFetch(() => sseResponse([chunk({ content: text }, 'stop', { total_tokens: 5 }), '[DONE]'], { splitEvery: 1 }));
  try {
    const provider = new OpenAICompatibleMultiTurnProvider(CONFIG);
    const result = await provider.completeMultiTurn(baseParams());
    assert.equal(result.text, text);
  } finally {
    (globalThis as { __restoreFetch?: () => void }).__restoreFetch?.();
  }
});

// ─── helper ───────────────────────────────────────────────────────────────────

function sseEventize(events: SseEvent[]): string {
  return events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('');
}

// ─── Review fixes: terminal semantic state, strict index, cancellation, cause chain ──

test('accumulator: tool-call delta WITHOUT an index fails closed (never coerced to index 0)', () => {
  const acc = new SseStreamAccumulator();
  acc.feed(`data: ${JSON.stringify(chunk({ content: 'x' }))}\n\n`);
  assert.throws(
    () => acc.feed(`data: ${JSON.stringify(chunk({ tool_calls: [{ id: 'c', function: { name: 'read_file', arguments: '{}' } }] }))}\n\n`),
    SseParseError,
  );
});

test('accumulator: index-less fragment after an existing call attaches to NOTHING (review scenario)', () => {
  const acc = new SseStreamAccumulator();
  acc.feed(`data: ${JSON.stringify(chunk({ tool_calls: [{ index: 0, id: 'call_0', function: { name: 'read_file', arguments: '{"path":"' } }] }))}\n\n`);
  // Malformed fragment for a DIFFERENT call arrives without an index — must
  // throw, never silently merge into call_0's arguments.
  assert.throws(
    () => acc.feed(`data: ${JSON.stringify(chunk({ tool_calls: [{ function: { arguments: 'secret.md"}' } }] }))}\n\n`),
    SseParseError,
  );
  // The regression this pins: call_0 carries ONLY its own original fragment —
  // the index-less 'secret.md"}' fragment must not have been merged into it.
  acc.feed(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\n`);
  acc.end();
  const a = acc.assemble();
  assert.equal(a.toolCalls.length, 1);
  assert.equal(a.toolCalls[0].arguments, '{"path":"');
  assert.notEqual(a.toolCalls[0].arguments, '{"path":"secret.md"}');
});

test('accumulator: NON-EMPTY content delta AFTER finish_reason is a contract violation', () => {
  const acc = new SseStreamAccumulator();
  acc.feed(`data: ${JSON.stringify(chunk({ content: 'done' }, 'stop'))}\n\n`);
  assert.throws(
    () => acc.feed(`data: ${JSON.stringify(chunk({ content: 'sneaky extra' }))}\n\n`),
    /non-empty content delta after finish_reason/,
  );
});

test('accumulator: a DIFFERENT second finish_reason is a contract violation (terminal value never replaced)', () => {
  const acc = new SseStreamAccumulator();
  acc.feed(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\n`);
  assert.throws(
    () => acc.feed(`data: ${JSON.stringify(chunk({ content: null }, 'tool_calls'))}\n\n`),
    /finish_reason changed after the terminal finish_reason/,
  );
});

test('accumulator: usage-only chunk after finish_reason stays legal (terminal state permits non-semantic data)', () => {
  const acc = new SseStreamAccumulator();
  acc.feed(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\n`);
  acc.feed(`data: ${JSON.stringify({ choices: [], usage: { total_tokens: 55 } })}\n\n`);
  acc.feed('data: [DONE]\n\n');
  acc.end();
  const a = acc.assemble();
  assert.equal(a.totalTokens, 55);
  assert.equal(a.sawDone, true);
});

test('accumulator: data event after [DONE] is a contract violation', () => {
  const acc = new SseStreamAccumulator();
  acc.feed(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\n`);
  acc.feed('data: [DONE]\n\n');
  assert.throws(() => acc.feed(`data: ${JSON.stringify(chunk({ content: 'late' }))}\n\n`), /after \[DONE\]/);
});

const abortErr = (): Error => new DOMException('This operation was aborted', 'AbortError');

test('provider: explicit cancellation mid-stream (before finish) propagates the AbortError — not a transport wrap', async () => {
  withFetch(() => failingResponse(abortErr(), `data: ${JSON.stringify(chunk({ content: 'partial' }))}\n\n`));
  try {
    const provider = new OpenAICompatibleMultiTurnProvider(CONFIG);
    await assert.rejects(provider.completeMultiTurn(baseParams()), (err: unknown) => {
      assert.equal((err as Error).name, 'AbortError');
      assert.ok(!String((err as Error).message).includes('LLM stream failed'), 'cancellation must not be rebranded as remote transport failure');
      return true;
    });
  } finally {
    (globalThis as { __restoreFetch?: () => void }).__restoreFetch?.();
  }
});

test('provider: explicit cancellation AFTER finish_reason still cancels — never downgraded to success', async () => {
  withFetch(() => failingResponse(abortErr(), `data: ${JSON.stringify(chunk({ content: 'complete' }, 'stop', { total_tokens: 4 }))}\n\n`));
  try {
    const provider = new OpenAICompatibleMultiTurnProvider(CONFIG);
    await assert.rejects(provider.completeMultiTurn(baseParams()), (err: unknown) => {
      assert.equal((err as Error).name, 'AbortError', 'caller cancellation wins over the post-finish benign-disconnect rule');
      return true;
    });
  } finally {
    (globalThis as { __restoreFetch?: () => void }).__restoreFetch?.();
  }
});

test('provider: mid-stream transport failure preserves the original error as `cause` (evidence chain)', async () => {
  // Mirror the undici shape seen in pilot attempts 20/21:
  // TypeError(terminated) -> cause SocketError(UND_ERR_SOCKET) -> cause 'other side closed'
  const streamErr = Object.assign(new TypeError('terminated'), {
    cause: { name: 'SocketError', code: 'UND_ERR_SOCKET', message: 'other side closed' },
  });
  let thrown: unknown;
  withFetch(() => failingResponse(streamErr, `data: ${JSON.stringify(chunk({ content: 'partial' }))}\n\n`));
  try {
    const provider = new OpenAICompatibleMultiTurnProvider(CONFIG);
    await provider.completeMultiTurn(baseParams()).catch((e) => { thrown = e; });
    assert.ok(thrown instanceof Error, 'provider must throw');
    assert.match(thrown.message, /LLM stream failed before completion \(transport\)/);
    // The chain must survive: describeTransportFailure reads cause.{name,cause.code}.
    const cause = (thrown as { cause?: { name?: string; cause?: { code?: string } } }).cause;
    assert.equal(cause?.name, 'TypeError', 'original error retained as cause');
    assert.equal(cause?.cause?.code, 'UND_ERR_SOCKET', 'undici cause code retained');
  } finally {
    (globalThis as { __restoreFetch?: () => void }).__restoreFetch?.();
  }
});

test('AgentLoop boundary: streamed UND_ERR_SOCKET reaches failure_observation.transport_failure.cause_code', async () => {
  const root = mkdtempSync(join(tmpdir(), 'streaming-loop-'));
  const originalFetch = globalThis.fetch;
  try {
    const streamErr = Object.assign(new TypeError('terminated'), {
      cause: { name: 'SocketError', code: 'UND_ERR_SOCKET', message: 'other side closed' },
    });
    globalThis.fetch = (async () =>
      failingResponse(streamErr, `data: ${JSON.stringify(chunk({ content: 'partial' }))}\n\n`)) as typeof fetch;
    const provider = new OpenAICompatibleMultiTurnProvider(CONFIG);
    const loop = new AgentLoop(provider, {
      model: 'test-model',
      projectRoot: root,
      role: 'explorer',
      workflowRunId: 'r',
      iteration: 1,
      nodeId: 'build',
      runArtifacts: new RunArtifactManager({ projectRoot: root }),
    });
    const result: AgentLoopResult = await loop.run('system', 'user task');
    assert.equal(result.success, false);
    const tf = result.failure_observation!.transport_failure!;
    assert.ok(tf, 'transport_failure must be present on the observation');
    assert.equal(tf.cause_code, 'UND_ERR_SOCKET', 'the evidence machinery must see the undici cause code through the streaming wrapper');
    assert.equal(tf.cause_name, 'TypeError');
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── Review fix 2: partial trailing-event bytes + post-finish disconnect ──────

test('provider: HALF-received trailing usage event + disconnect after finish STILL SUCCEEDS (review blocker)', async () => {
  // Complete generation, then the connection drops MID-usage-event: the
  // buffered truncated event must be abandoned, not parsed into a failure.
  const halfUsage = `data: {"choices":[],"usage":{"to`;
  withFetch(() => failingResponse(
    Object.assign(new TypeError('terminated'), { cause: { name: 'SocketError', code: 'UND_ERR_SOCKET', message: 'other side closed' } }),
    `data: ${JSON.stringify(chunk({ content: 'the full result' }, 'stop'))}\n\n${halfUsage}`,
  ));
  try {
    const provider = new OpenAICompatibleMultiTurnProvider(CONFIG);
    const result = await provider.completeMultiTurn(baseParams());
    assert.equal(result.text, 'the full result', 'completed text preserved');
    assert.equal(result.stop_reason, 'end_turn', 'stop_reason preserved');
    assert.equal(result.tokens_used, 0, 'no completely observed usage → 0');
  } finally {
    (globalThis as { __restoreFetch?: () => void }).__restoreFetch?.();
  }
});

test('provider: disconnect mid-SECOND usage event keeps the last completely observed usage', async () => {
  withFetch(() => failingResponse(
    new Error('trailing connection lost'),
    `data: ${JSON.stringify(chunk({ content: 'result' }, 'stop', { total_tokens: 55 }))}\n\ndata: {"choices":[],"usage":{"total_tok`,
  ));
  try {
    const provider = new OpenAICompatibleMultiTurnProvider(CONFIG);
    const result = await provider.completeMultiTurn(baseParams());
    assert.equal(result.text, 'result');
    assert.equal(result.tokens_used, 55, 'last COMPLETELY observed usage wins; the partial re-send is abandoned');
  } finally {
    (globalThis as { __restoreFetch?: () => void }).__restoreFetch?.();
  }
});

test('provider: partially received [DONE] after finish + disconnect still SUCCEEDS', async () => {
  withFetch(() => failingResponse(new Error('connection reset'), `data: ${JSON.stringify(chunk({ content: 'ok' }, 'stop'))}\n\ndata: [DO`));
  try {
    const provider = new OpenAICompatibleMultiTurnProvider(CONFIG);
    const result = await provider.completeMultiTurn(baseParams());
    assert.equal(result.text, 'ok');
    assert.equal(result.stop_reason, 'end_turn');
  } finally {
    (globalThis as { __restoreFetch?: () => void }).__restoreFetch?.();
  }
});

test('provider: clean EOF mid-trailing-usage-event after finish also SUCCEEDS (same invariant, no error)', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      controller.enqueue(enc.encode(`data: ${JSON.stringify(chunk({ content: 'done' }, 'stop', { total_tokens: 9 }))}\n\ndata: {"choices":[],"usage":{"tot`));
      controller.close(); // clean EOF mid-trailing-event
    },
  });
  withFetch(() => new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
  try {
    const provider = new OpenAICompatibleMultiTurnProvider(CONFIG);
    const result = await provider.completeMultiTurn(baseParams());
    assert.equal(result.text, 'done');
    assert.equal(result.tokens_used, 9, 'last completely observed usage preserved');
  } finally {
    (globalThis as { __restoreFetch?: () => void }).__restoreFetch?.();
  }
});

test('accumulator: abandonTrailingBytesAfterFinish refuses to run before finish (misuse guard)', () => {
  const acc = new SseStreamAccumulator();
  acc.feed(`data: ${JSON.stringify(chunk({ content: 'real semantic bytes' }))}\n\n`);
  assert.throws(() => acc.abandonTrailingBytesAfterFinish(), /before finish_reason/);
});

// ─── Wire-compat fix: the REAL OpenRouter terminal shape (captured live) ──────
// f215272's accumulator failed this exact stream 2/2 in live qualification:
// the finish chunk carries content:"" and the usage carrier REPEATS
// finish_reason. Fixture is a sanitized clone of the captured bytes.

test('PRODUCTION WIRE: captured OpenRouter stream assembles end-to-end (finish chunk with content:"" + repeated finish_reason usage carrier)', async () => {
  const fixture = openrouterProductionFixture();
  withFetch(() => sseResponse(fixture.events, { splitEvery: 7 })); // odd byte split: framing stress too
  try {
    const provider = new OpenAICompatibleMultiTurnProvider(CONFIG);
    const result = await provider.completeMultiTurn(baseParams({
      tools: [{ name: 'read_file', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
    }));
    assert.equal(result.stop_reason, 'tool_use', 'finish_reason tool_calls maps to tool_use');
    assert.equal(result.tool_uses.length, 1, 'streamed tool call assembles');
    assert.equal(result.tool_uses[0].name, 'read_file');
    assert.deepEqual(result.tool_uses[0].input, fixture.expected.arguments, 'arguments parse correctly');
    assert.equal(result.tool_uses[0].id, fixture.expected.toolId);
    assert.equal(result.tokens_used, 234, 'usage from the REPEATED-finish carrier is recorded');
    assert.equal(result.text, ' ', 'pre-finish leading whitespace content preserved; empty-string trailer content contributes nothing');
  } finally {
    (globalThis as { __restoreFetch?: () => void }).__restoreFetch?.();
  }
});

test('PRODUCTION WIRE: accumulator accepts the captured terminal shape and reports exactly one terminal state', () => {
  const fixture = openrouterProductionFixture();
  const acc = new SseStreamAccumulator();
  for (const e of fixture.events) {
    if (e === '[DONE]') acc.feed('data: [DONE]\n\n');
    else acc.feed(`data: ${JSON.stringify(e)}\n\n`);
  }
  acc.end();
  const a = acc.assemble();
  assert.equal(a.finishReason, 'tool_calls', 'repeated identical finish_reason does not replace the terminal value');
  assert.equal(a.totalTokens, 234);
  assert.equal(a.sawDone, true);
  assert.equal(a.text, ' ');
  assert.deepEqual(JSON.parse(a.toolCalls[0].arguments), fixture.expected.arguments);
});

test('adversarial: non-empty content after finish_reason rejects', () => {
  const acc = new SseStreamAccumulator();
  acc.feed(`data: ${JSON.stringify(chunk({}, 'tool_calls'))}\n\n`);
  assert.throws(() => acc.feed(`data: ${JSON.stringify(chunk({ content: 'x' }))}\n\n`), /non-empty content delta after finish_reason/);
});

test('adversarial: tool-call delta after finish_reason rejects (finish is terminal for tools too)', () => {
  const acc = new SseStreamAccumulator();
  acc.feed(`data: ${JSON.stringify(chunk({}, 'tool_calls'))}\n\n`);
  assert.throws(
    () => acc.feed(`data: ${JSON.stringify(chunk({ tool_calls: [{ index: 0, function: { arguments: '{"late":true}' } }] }))}\n\n`),
    /tool-call delta after finish_reason/,
  );
});

test('adversarial: a DIFFERENT second finish_reason rejects', () => {
  const acc = new SseStreamAccumulator();
  acc.feed(`data: ${JSON.stringify(chunk({}, 'tool_calls'))}\n\n`);
  assert.throws(() => acc.feed(`data: ${JSON.stringify(chunk({ content: '' }, 'stop'))}\n\n`), /finish_reason changed after the terminal finish_reason/);
});

test('adversarial: REPEATED identical finish_reason with empty content accepts (OpenRouter usage carrier)', () => {
  const acc = new SseStreamAccumulator();
  acc.feed(`data: ${JSON.stringify(chunk({}, 'tool_calls'))}\n\n`);
  acc.feed(`data: ${JSON.stringify(chunk({ content: '' }, 'tool_calls', { total_tokens: 234 }))}\n\n`);
  acc.end();
  const a = acc.assemble();
  assert.equal(a.finishReason, 'tool_calls');
  assert.equal(a.totalTokens, 234);
});

test('adversarial: literal content:"" after finish_reason accepts (inert, per captured wire)', () => {
  const acc = new SseStreamAccumulator();
  acc.feed(`data: ${JSON.stringify(chunk({}, 'tool_calls'))}\n\n`);
  acc.feed(`data: ${JSON.stringify(chunk({ content: '' }))}\n\n`);
  acc.end();
  assert.equal(acc.assemble().finishReason, 'tool_calls');
});

test('adversarial: whitespace-only content after finish_reason REMAINS semantic and rejects (no trim normalization)', () => {
  const acc = new SseStreamAccumulator();
  acc.feed(`data: ${JSON.stringify(chunk({}, 'tool_calls'))}\n\n`);
  assert.throws(() => acc.feed(`data: ${JSON.stringify(chunk({ content: ' ' }))}\n\n`), /non-empty content delta after finish_reason/);
});

// ─── P1 fix: runtime-strict post-finish field types (JSON.parse `as` is a lie) ─

test('adversarial: post-finish content of WRONG TYPE (number) rejects as SseParseError and mutates NOTHING', () => {
  const acc = new SseStreamAccumulator();
  acc.feed(`data: ${JSON.stringify(chunk({ content: 'done' }, 'stop'))}\n\n`);
  assert.throws(
    () => acc.feed(`data: ${JSON.stringify(chunk({ content: 123 as unknown as string }))}\n\n`),
    (err: unknown) => {
      assert.ok(err instanceof SseParseError, 'must be SseParseError, never a plain TypeError');
      assert.match((err as Error).message, /malformed post-finish content field/);
      return true;
    },
  );
  // The malformed value must not have touched the semantic result before throwing.
  acc.end();
  const a = acc.assemble();
  assert.equal(a.text, 'done', 'assembled text unchanged — malformed data cannot mutate post-finish state');
  assert.equal(a.finishReason, 'stop');
});

test('adversarial: post-finish tool_calls: null rejects as SseParseError (never a TypeError the provider would call benign)', () => {
  const acc = new SseStreamAccumulator();
  acc.feed(`data: ${JSON.stringify(chunk({}, 'tool_calls'))}\n\n`);
  assert.throws(
    () => acc.feed(`data: ${JSON.stringify(chunk({ tool_calls: null as unknown as Array<never> }))}\n\n`),
    (err: unknown) => {
      assert.ok(err instanceof SseParseError, `expected SseParseError, got ${(err as Error).name}: ${(err as Error).message}`);
      assert.match((err as Error).message, /malformed post-finish tool_calls field/);
      return true;
    },
  );
});

test('adversarial: post-finish finish_reason of WRONG TYPE (number) rejects as SseParseError', () => {
  const acc = new SseStreamAccumulator();
  acc.feed(`data: ${JSON.stringify(chunk({}, 'tool_calls'))}\n\n`);
  assert.throws(
    () => acc.feed(`data: ${JSON.stringify(chunk({ content: '' }, 123 as unknown as string))}\n\n`),
    (err: unknown) => {
      assert.ok(err instanceof SseParseError, `expected SseParseError, got ${(err as Error).name}: ${(err as Error).message}`);
      assert.match((err as Error).message, /malformed post-finish finish_reason field/);
      return true;
    },
  );
});

// ─── P1 fix 2: structural containers at the post-finish boundary ──────────────
// chunk/choice/delta themselves can be arbitrary JSON — a plain TypeError
// there would be misclassified by the provider as benign post-finish loss.

test('adversarial: post-finish payload `null` rejects as SseParseError (never `.choices` on null)', () => {
  const acc = new SseStreamAccumulator();
  acc.feed(`data: ${JSON.stringify(chunk({ content: 'done' }, 'stop'))}\n\n`);
  assert.throws(
    () => acc.feed('data: null\n\n'),
    (err: unknown) => {
      assert.ok(err instanceof SseParseError, `expected SseParseError, got ${(err as Error).name}: ${(err as Error).message}`);
      assert.match((err as Error).message, /malformed post-finish chunk payload/);
      return true;
    },
  );
  acc.end();
  const a = acc.assemble();
  assert.equal(a.text, 'done', 'semantic state untouched by the malformed container');
  assert.equal(a.finishReason, 'stop');
});

test('adversarial: post-finish choice: 123 rejects as SseParseError', () => {
  const acc = new SseStreamAccumulator();
  acc.feed(`data: ${JSON.stringify(chunk({}, 'tool_calls'))}\n\n`);
  assert.throws(
    () => acc.feed('data: {"choices":[123]}\n\n'),
    (err: unknown) => {
      assert.ok(err instanceof SseParseError, `expected SseParseError, got ${(err as Error).name}: ${(err as Error).message}`);
      assert.match((err as Error).message, /malformed post-finish choice/);
      return true;
    },
  );
});

test('adversarial: post-finish delta: 123 rejects as SseParseError (never `in` on a primitive)', () => {
  const acc = new SseStreamAccumulator();
  acc.feed(`data: ${JSON.stringify(chunk({}, 'tool_calls'))}\n\n`);
  assert.throws(
    () => acc.feed('data: {"choices":[{"delta":123}]}\n\n'),
    (err: unknown) => {
      assert.ok(err instanceof SseParseError, `expected SseParseError, got ${(err as Error).name}: ${(err as Error).message}`);
      assert.match((err as Error).message, /malformed post-finish delta/);
      return true;
    },
  );
});

// ─── P2 fix: the `choices` container itself is runtime-validated ──────────────

test('adversarial: post-finish choices: 123 and choices: {} reject as SseParseError (container chain complete)', () => {
  for (const wire of ['data: {"choices":123}\n\n', 'data: {"choices":{}}\n\n']) {
    const acc = new SseStreamAccumulator();
    acc.feed(`data: ${JSON.stringify(chunk({}, 'tool_calls'))}\n\n`);
    assert.throws(
      () => acc.feed(wire),
      (err: unknown) => {
        assert.ok(err instanceof SseParseError, `expected SseParseError for ${wire.trim()}, got ${(err as Error).name}: ${(err as Error).message}`);
        assert.match((err as Error).message, /malformed post-finish choices field/);
        return true;
      },
      `choices container must fail closed: ${wire.trim()}`,
    );
  }
});
