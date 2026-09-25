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

import { OpenAICompatibleMultiTurnProvider } from '../src/llm-provider.js';
import { SseStreamAccumulator, SseParseError } from '../src/sse-accumulator.js';
import { sseResponse, jsonResponse, failingResponse, chunk, type SseEvent } from './sse-test-utils.js';
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
