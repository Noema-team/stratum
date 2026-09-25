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
