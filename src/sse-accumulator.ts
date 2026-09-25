// ============================================================================
// SSE stream accumulator — the deterministic parse boundary for streaming
// chat-completions responses (OpenAI/OpenRouter `stream: true` wire).
//
// Scope (transport-hardening PR): this is deliberately a PURE state machine,
// separate from the fetch call, so every wire pathology can be tested
// deterministically without a network:
//   • SSE framing split across arbitrary network chunks (partial lines and
//     partial `data:` payloads buffered until a complete event arrives)
//   • multiple SSE events carried in one network chunk
//   • CRLF and LF event framing; SSE comment/keep-alive lines (": ...") ignored
//   • multiple `data:` lines in one event (joined with \n per SSE spec)
//   • streamed text accumulation across deltas
//   • streamed tool calls: first delta carries {index,id,function.name},
//     later deltas append function.arguments fragments, keyed by `index`
//     (tool-call arguments fragmented across deltas; multiple tool calls
//     interleaved in one turn)
//   • finish_reason captured (last value wins)
//   • usage captured from whichever chunk carries it (OpenRouter sends a
//     final usage-only chunk; no stream_options required)
//   • `data: [DONE]` termination handled
//
// Failure semantics (the hard rule): NO PARTIAL GENERATION is ever presented
// as a successful result. A stream that ends without a finish_reason, or a
// `data:` payload that is not valid JSON, raises. The provider layer turns
// these into thrown transport errors — identical in kind to the legacy
// non-streaming path's failure mode, never a degraded success.
// ============================================================================

export class SseParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SseParseError';
  }
}

interface StreamedChatChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { total_tokens?: number } | null;
}

export interface AssembledStream {
  text: string;
  /** Tool calls assembled from deltas, ordered by first appearance. */
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  finishReason: string | null;
  totalTokens: number | null;
  sawDone: boolean;
}

export class SseStreamAccumulator {
  private lineBuffer = '';
  private eventLines: string[] = [];
  private textParts: string[] = [];
  /** key: tool_calls[].index (OpenAI's assembly key across deltas) */
  private toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
  /** first-appearance order of tool-call indexes */
  private toolCallOrder: number[] = [];
  private finishReason: string | null = null;
  private totalTokens: number | null = null;
  private sawDone = false;

  /** Feed one decoded network chunk (anywhere it may be split). */
  feed(decoded: string): void {
    this.lineBuffer += decoded;
    let nl: number;
    while ((nl = this.lineBuffer.indexOf('\n')) !== -1) {
      let line = this.lineBuffer.slice(0, nl);
      this.lineBuffer = this.lineBuffer.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this.handleLine(line);
    }
  }

  /** Signal end-of-stream: flushes a trailing line without newline, then the trailing event. */
  end(): void {
    if (this.lineBuffer.length > 0) {
      const line = this.lineBuffer;
      this.lineBuffer = '';
      this.handleLine(line.endsWith('\r') ? line.slice(0, -1) : line);
    }
    if (this.eventLines.length > 0) {
      const lines = this.eventLines;
      this.eventLines = [];
      this.handleEvent(lines);
    }
  }

  private handleLine(line: string): void {
    // Blank line = event boundary in SSE framing.
    if (line === '') {
      if (this.eventLines.length > 0) {
        const lines = this.eventLines;
        this.eventLines = [];
        this.handleEvent(lines);
      }
      return;
    }
    // SSE comment / keep-alive line.
    if (line.startsWith(':')) return;
    // Only `data:` fields carry OpenAI chat-completions payloads; event/id/retry
    // are legal SSE fields that this wire never uses — tolerated and ignored.
    if (line.startsWith('data:')) {
      this.eventLines.push(line.slice('data:'.length).replace(/^ /, ''));
    }
    // Any other non-blank, non-ignored line is not valid SSE — fail closed
    // rather than silently dropping bytes.
    else {
      throw new SseParseError(`unexpected SSE field line: ${JSON.stringify(line.slice(0, 120))}`);
    }
  }

  private handleEvent(dataLines: string[]): void {
    const payload = dataLines.join('\n');
    if (payload === '[DONE]') {
      // [DONE] is TERMINAL: any further data event is a stream-contract
      // violation, not a tolerable trailing artifact.
      if (this.sawDone) {
        throw new SseParseError('data event after [DONE] — stream already terminated');
      }
      this.sawDone = true;
      return;
    }
    if (this.sawDone) {
      throw new SseParseError('data event after [DONE] — stream already terminated');
    }
    let chunk: StreamedChatChunk;
    try {
      chunk = JSON.parse(payload) as StreamedChatChunk;
    } catch (err) {
      throw new SseParseError(
        `malformed SSE data payload (not JSON): ${err instanceof Error ? err.message : String(err)} — payload starts: ${JSON.stringify(payload.slice(0, 120))}`,
      );
    }

    const choice = chunk.choices?.[0];
    // Terminal semantic state: the FIRST non-null finish_reason completes the
    // model's generation. The provider treats "finish_reason seen" as the
    // boundary that makes a subsequent transport failure benign — that claim
    // is only true if the accumulator can no longer change semantic state
    // afterwards. Enforce it: after finish_reason only non-semantic trailing
    // data is legal (usage-only chunks, empty keep-alive choices). A second
    // finish_reason or any content/tool delta is a contract violation.
    if (this.finishReason !== null) {
      const delta = choice?.delta;
      const semanticDelta =
        delta !== undefined
        && ((delta.content !== undefined && delta.content !== null) || (delta.tool_calls !== undefined && delta.tool_calls.length > 0));
      if (semanticDelta) {
        throw new SseParseError('semantic delta (content/tool_calls) after finish_reason — stream contract violation');
      }
      if (choice?.finish_reason) {
        throw new SseParseError('second finish_reason after the terminal finish_reason — stream contract violation');
      }
    }

    const delta = choice?.delta;
    if (delta?.content) this.textParts.push(delta.content);
    for (const tc of delta?.tool_calls ?? []) this.applyToolCallDelta(tc);
    if (choice?.finish_reason) this.finishReason = choice.finish_reason;
    if (chunk.usage && typeof chunk.usage.total_tokens === 'number') {
      this.totalTokens = chunk.usage.total_tokens;
    }
  }

  private applyToolCallDelta(tc: {
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }): void {
    // Fail closed on index: tool calls are assembled BY INDEX (OpenAI/
    // OpenRouter streaming contract). A delta without a valid non-negative
    // integer index must never be coerced to index 0 — a malformed fragment
    // would otherwise silently merge into an unrelated tool call.
    const index = tc.index;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
      throw new SseParseError(
        `tool_call delta without a valid non-negative integer index (got ${JSON.stringify(tc.index ?? null)}) — refusing to attach it to an existing tool call`,
      );
    }
    let entry = this.toolCalls.get(index);
    if (!entry) {
      // First delta for this tool call: carries the identity. An arguments
      // fragment arriving without any prior identity delta is assembled under
      // the index as well (tolerant ordering), with empty id/name placeholders
      // that MUST be filled by the time the stream finishes — validated below.
      entry = { id: '', name: '', arguments: '' };
      this.toolCalls.set(index, entry);
      this.toolCallOrder.push(index);
    }
    if (tc.id !== undefined) entry.id += tc.id;
    if (tc.function?.name !== undefined) entry.name += tc.function.name;
    if (tc.function?.arguments !== undefined) entry.arguments += tc.function.arguments;
  }

  /** True once a finish_reason has been observed (the success precondition). */
  get hasFinishReason(): boolean {
    return this.finishReason !== null;
  }

  assemble(): AssembledStream {
    if (this.finishReason === null) {
      throw new SseParseError(
        'stream ended without finish_reason — no partial generation is returned (transport failure mid-stream)',
      );
    }
    const toolCalls = this.toolCallOrder.map((i) => {
      const tc = this.toolCalls.get(i)!;
      if (tc.id === '' || tc.name === '') {
        throw new SseParseError(`tool call at index ${i} ended without complete identity (id/name missing)`);
      }
      return { id: tc.id, name: tc.name, arguments: tc.arguments };
    });
    return {
      text: this.textParts.join(''),
      toolCalls,
      finishReason: this.finishReason,
      totalTokens: this.totalTokens,
      sawDone: this.sawDone,
    };
  }
}
