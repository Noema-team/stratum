// Deterministic SSE response builders for provider-transport tests.
// No network: each helper returns a REAL `Response` whose body is a
// ReadableStream emitting the given bytes, so the provider's streaming
// read path (getReader/TextDecoder/accumulator) runs exactly as in
// production while every byte on the wire is authored by the test.

export type SseEvent = object | '[DONE]';

/** Serialize one SSE event the way OpenAI-compatible servers do. */
export function sseEvent(event: SseEvent): string {
  return `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`;
}

/**
 * Build a 200 SSE Response from events.
 * `splitEvery` re-chunks the encoded byte stream at arbitrary boundaries
 * (default: one chunk per event) to exercise framing split across network
 * chunks; pass 1 to split mid-character-sequence aggressively.
 */
export function sseResponse(events: SseEvent[], opts?: { splitEvery?: number; contentType?: string }): Response {
  const wire = events.map(sseEvent).join('');
  const bytes = new TextEncoder().encode(wire);
  const step = opts?.splitEvery ?? Math.max(1, bytes.length);
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + step));
      offset += step;
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': opts?.contentType ?? 'text/event-stream' },
  });
}

/** A 200 Response that is not SSE (e.g. a JSON body) — negative-path input. */
export function jsonResponse(payload: object): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** A 200 Response whose stream errors after `bytes` emitted bytes. */
export function failingResponse(err: Error, prefix = ''): Response {
  const bytes = new TextEncoder().encode(prefix);
  let sent = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent && bytes.length > 0) {
        sent = true;
        controller.enqueue(bytes);
        return;
      }
      controller.error(err);
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** OpenAI-style streaming choice chunk. */
export function chunk(
  delta: {
    content?: string | null;
    tool_calls?: Array<{
      index?: number;
      id?: string;
      function?: { name?: string; arguments?: string };
    }>;
  },
  finishReason?: string,
  usage?: { total_tokens: number },
): object {
  return {
    choices: [
      {
        delta,
        ...(finishReason !== undefined ? { finish_reason: finishReason } : {}),
      },
    ],
    ...(usage !== undefined ? { usage } : {}),
  };
}

/**
 * SANITIZED DETERMINISTIC CLONE of a real captured OpenRouter stream
 * (z-ai/glm-5.3-flash, captured live 2026-09-25 during V2 transport
 * qualification; raw bytes preserved in the pilot evidence repo as
 * raw-sse-capture-run3.txt). Ids/model name replaced; structure and byte
 * shapes preserved exactly — including the terminal shape that broke the
 * original PR #45 accumulator:
 *   • the finish chunk itself carries delta.content:""
 *   • the usage carrier REPEATS finish_reason and also carries content:""
 *   • every delta carries role:"assistant"
 * This fixture pins the actual production wire, not a synthetic idealization.
 */
export function openrouterProductionFixture(): { events: SseEvent[]; expected: { toolId: string; arguments: object; totalTokens: number } } {
  const envelope = { id: 'chatcmpl-sanitized0001', model: 'sanitized-model', created: 0 };
  const events: SseEvent[] = [
    // e0 — role + leading whitespace content (real wire opens this way)
    { ...envelope, choices: [{ index: 0, delta: { role: 'assistant', content: ' ' }, finish_reason: null }] },
    // e1 — tool-call identity delta (content:null alongside tool_calls)
    {
      ...envelope,
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          content: null,
          tool_calls: [{ index: 0, id: 'chatcmpl-tool-sanitized0001', type: 'function', function: { name: 'read_file', arguments: '' } }],
        },
        finish_reason: null,
      }],
    },
    // e2 — arguments fragment 1
    {
      ...envelope,
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          content: null,
          tool_calls: [{ index: 0, function: { arguments: '{"path": "pkg/QUALIFICATION-TARGET.md"' } }],
        },
        finish_reason: null,
      }],
    },
    // e3 — arguments fragment 2 (completes the JSON)
    {
      ...envelope,
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          content: null,
          tool_calls: [{ index: 0, function: { arguments: '}' } }],
        },
        finish_reason: null,
      }],
    },
    // e4 — THE FINISH CHUNK: carries content:"" (empty string, not absent)
    { ...envelope, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: 'tool_calls' }] },
    // e5 — USAGE CARRIER: REPEATS finish_reason, again with content:""
    {
      ...envelope,
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 210, completion_tokens: 24, total_tokens: 234 },
    },
    // e6 — terminal
    '[DONE]' as SseEvent,
  ];
  return {
    events,
    expected: {
      toolId: 'chatcmpl-tool-sanitized0001',
      arguments: { path: 'pkg/QUALIFICATION-TARGET.md' },
      totalTokens: 234,
    },
  };
}
