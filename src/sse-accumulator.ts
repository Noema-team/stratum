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
//   • finish_reason captured — FIRST value wins and is terminal; an
//     IDENTICAL repeat is an idempotent trailer/usage carrier (real
//     OpenRouter wire); a DIFFERENT repeat is a contract violation
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

    // Post-finish trust boundary — STRUCTURAL containers first. After the
    // terminal finish_reason, ANY malformed shape must fail closed as an
    // SseParseError: a plain TypeError here (e.g. `'content' in 123`, or
    // `.choices` on a null payload) would be misclassified by the provider's
    // catch as benign post-finish transport loss and return success. Validate
    // chunk → choices → choice → delta containers BEFORE any field access;
    // the field-level checks below are then safe. JSON.parse's `as` types are
    // compile-time only — the wire can send any JSON shape.
    if (this.finishReason !== null) {
      const describe = (v: unknown): string =>
        v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
      if (chunk === null || typeof chunk !== 'object' || Array.isArray(chunk)) {
        throw new SseParseError(
          `malformed post-finish chunk payload (expected object, got ${describe(chunk)}) — stream contract violation`,
        );
      }
      const choices: unknown = (chunk as { choices?: unknown }).choices;
      if (choices !== undefined && choices !== null && !Array.isArray(choices)) {
        throw new SseParseError(
          `malformed post-finish choices field (expected absent|null|array, got ${describe(choices)}) — stream contract violation`,
        );
      }
      const c: unknown = Array.isArray(choices) ? choices[0] : undefined;
      if (c !== undefined && (c === null || typeof c !== 'object' || Array.isArray(c))) {
        throw new SseParseError(
          `malformed post-finish choice (expected object, got ${describe(c)}) — stream contract violation`,
        );
      }
      const d: unknown = (c as { delta?: unknown } | undefined)?.delta;
      if (d !== undefined && d !== null && (typeof d !== 'object' || Array.isArray(d))) {
        throw new SseParseError(
          `malformed post-finish delta (expected object, got ${describe(d)}) — stream contract violation`,
        );
      }
    }

    const choice = chunk.choices?.[0];
    // Terminal semantic state: the FIRST non-null finish_reason completes the
    // model's generation. The provider treats "finish_reason seen" as the
    // boundary that makes a subsequent transport failure benign — that claim
    // is only true if the accumulator can no longer change semantic state
    // afterwards. Enforce it: after finish_reason only inert trailing data is
    // legal. What is inert is defined by the REAL OpenRouter wire (captured
    // live, see tests/openrouter-streaming.test.ts production fixture):
    //   • delta.content absent | null | "" (the finish chunk itself and the
    //     usage carrier both carry content:"" — the literal empty string only;
    //     whitespace is NEVER normalized and stays semantic)
    //   • delta.tool_calls absent or empty
    //   • finish_reason absent/null, or EXACTLY equal to the recorded value
    //     (an identical repeat is an idempotent trailer/usage carrier, not a
    //     new semantic event; a DIFFERENT reason means a second terminal
    //     boundary — a violation)
    //   • role/usage metadata; [DONE]; EOF
    // Anything else — non-empty content, tool-call deltas, a changed finish
    // reason — is a contract violation.
    if (this.finishReason !== null) {
      const delta = choice?.delta;
      // RUNTIME-STRICT validation of the inert post-finish field set. JSON.parse
      // types are compile-time lies — the network can send ANY JSON type, and a
      // malformed value here must (a) never mutate semantic state and (b) always
      // be an SseParseError (never a plain TypeError, which the provider would
      // misclassify as benign post-finish transport loss).
      if (delta && 'content' in delta && delta.content != null) {
        if (typeof delta.content !== 'string') {
          throw new SseParseError(
            `malformed post-finish content field (expected absent|null|"", got ${typeof delta.content}) — stream contract violation`,
          );
        }
        if (delta.content !== '') {
          throw new SseParseError(
            `non-empty content delta after finish_reason (${JSON.stringify(delta.content.slice(0, 40))}) — stream contract violation (empty string is inert; whitespace is content)`,
          );
        }
      }
      if (delta && 'tool_calls' in delta) {
        if (!Array.isArray(delta.tool_calls)) {
          throw new SseParseError(
            `malformed post-finish tool_calls field (expected absent or array, got ${delta.tool_calls === null ? 'null' : typeof delta.tool_calls}) — stream contract violation`,
          );
        }
        if (delta.tool_calls.length > 0) {
          throw new SseParseError('tool-call delta after finish_reason — stream contract violation');
        }
      }
      const repeatedFinish = choice?.finish_reason;
      if (repeatedFinish != null) {
        if (typeof repeatedFinish !== 'string') {
          throw new SseParseError(
            `malformed post-finish finish_reason field (expected string, got ${typeof repeatedFinish}) — stream contract violation`,
          );
        }
        if (repeatedFinish !== this.finishReason) {
          throw new SseParseError(
            `finish_reason changed after the terminal finish_reason (${JSON.stringify(this.finishReason)} → ${JSON.stringify(repeatedFinish)}) — stream contract violation`,
          );
        }
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

  /**
   * Explicitly discard unparsed trailing transport bytes after the terminal
   * finish_reason — e.g. a HALF-received usage event left in the line/event
   * buffer when the connection dropped mid-trailer. Failing to call this
   * before `end()` would parse the truncated event and turn a COMPLETED
   * generation into a failure. Safe by the terminal-state invariant: fully
   * parsed post-finish events are rejected on arrival, so buffered-but-
   * unparsed bytes can never carry semantic weight. Misuse guard: calling
   * this before semantic completion would discard real bytes — fail loudly.
   */
  abandonTrailingBytesAfterFinish(): void {
    if (this.finishReason === null) {
      throw new SseParseError(
        'abandonTrailingBytesAfterFinish() called before finish_reason — refusing to discard possibly-semantic bytes',
      );
    }
    this.lineBuffer = '';
    this.eventLines = [];
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
