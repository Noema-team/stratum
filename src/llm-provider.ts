import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import type { AgentLLMConfig } from './types.js';
import type { IMultiTurnProvider, MultiTurnParams, MultiTurnResult, MultiTurnMessage } from './agent-loop.js';
import { AnthropicSDKProvider } from './anthropic-provider.js';
import { SseStreamAccumulator, SseParseError } from './sse-accumulator.js';

export interface LLMCompletionParams {
  model: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  temperature: number;
  max_tokens: number;
}

export interface LLMCompletionResult {
  content: string;
  tokens_used: number;
  duration_ms: number;
}

export interface ILLMProvider {
  complete(params: LLMCompletionParams): Promise<LLMCompletionResult>;
}

// ─── D.34 C6 — the native structured-output capability ────────────────────────
//
// A provider implements completeStructured ONLY when it can genuinely
// constrain a completion to a JSON Schema natively (no textual envelope,
// no tool loop): OpenAI-wire endpoints via response_format json_schema,
// Anthropic via a forced single-tool extraction call. Presence of the
// method is the capability probe — the same structural duck-typing
// AgentRunner uses for completeMultiTurn; a provider that lacks the
// capability leaves the method genuinely absent (DynamicLLMProvider syncs
// it exactly like multi-turn), so fallback is by CAPABILITY, never by
// provider name.
//
// C6 boundary: the structured channel slots into the EXISTING execution
// policy — review steps run single-turn, and this is their capability-1
// wire. Produce steps keep the C5 negotiation (submit_result on the
// multi-turn loop); this seam never reopens multi-turn review.

export interface StructuredCompletionParams {
  model: string;
  system?: string;
  /** Conversation turns (system handled separately). Repair re-issues
   *  carry the previous assistant turn + the repair instruction. */
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  max_tokens: number;
  /** THE generated projection from the step's registered output contract. */
  schema: Record<string, unknown>;
  /** Optional tool/schema name surfaced to the provider API. */
  schemaName?: string;
  /**
   * C6 review closure 3 — sampling parity: the structured wire must not
   * silently change the model's sampling configuration relative to the
   * textual wire. The runner passes the SAME value it passes to complete()
   * (runnerConfig.temperature ?? RUNNER_DEFAULTS.temperature), and both
   * native providers forward it on the wire.
   */
  temperature?: number;
}

export interface StructuredCompletionResult {
  /** The provider's parsed structured value (already an object). */
  value: unknown;
  tokens_used: number;
  duration_ms: number;
}

export interface IStructuredProvider {
  completeStructured(params: StructuredCompletionParams): Promise<StructuredCompletionResult>;
}

export const LLMCompletionParamsSchema = z.object({
  model: z.string().min(1),
  messages: z.array(
    z.object({
      role: z.enum(['system', 'user', 'assistant']),
      content: z.string(),
    })
  ).min(1),
  temperature: z.number().min(0).max(2),
  max_tokens: z.number().int().positive(),
});

export const LLMCompletionResultSchema = z.object({
  content: z.string(),
  tokens_used: z.number().nonnegative(),
  duration_ms: z.number().nonnegative(),
});

export class OpenAICompatibleProvider implements ILLMProvider {
  protected baseUrl: string;
  protected apiKey: string;
  protected defaultModel: string;

  constructor(config: AgentLLMConfig) {
    this.baseUrl = (config.base_url || 'https://api.openai.com/v1').replace(/\/$/, '');
    this.apiKey = process.env[config.api_key_env] || process.env.SLE_LLM_API_KEY || '';
    this.defaultModel = config.model;

    if (!this.apiKey) {
      throw new Error(
        `API key not found. Set ${config.api_key_env} or SLE_LLM_API_KEY environment variable.`
      );
    }
  }

  async complete(params: LLMCompletionParams): Promise<LLMCompletionResult> {
    LLMCompletionParamsSchema.parse(params);

    const start = Date.now();
    const url = `${this.baseUrl}/chat/completions`;

    const body = {
      model: params.model || this.defaultModel,
      messages: params.messages,
      temperature: params.temperature,
      max_tokens: params.max_tokens,
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'unknown error');
      throw new Error(
        `LLM API request failed: ${response.status} ${response.statusText} — ${errorBody}`
      );
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
      usage?: { total_tokens: number };
    };

    const content = data.choices?.[0]?.message?.content ?? '';
    const tokensUsed = data.usage?.total_tokens ?? 0;

    const result: LLMCompletionResult = {
      content,
      tokens_used: tokensUsed,
      duration_ms: Date.now() - start,
    };

    LLMCompletionResultSchema.parse(result);
    return result;
  }
}

// D.3d — genuine multi-turn (tool-calling) support for an OpenAI-compatible
// endpoint, using the OpenAI chat-completions `tools`/`tool_calls` wire
// format that OpenRouter (and OpenAI itself) both speak natively. This is
// not "faking" multi-turn capability onto a provider that lacks it — a
// tool-calling-capable model reached through OpenRouter genuinely executes
// the same tool_use/tool_result round trip AgentLoop already drives for
// AnthropicSDKProvider (see agent-loop.ts); only the wire format differs.
// Kept as a separate class (rather than changing OpenAICompatibleProvider
// itself) so plain openai_compatible/glm configurations — whose target
// model or endpoint may not support tool calling — are unaffected; only
// the 'openrouter' case in createLLMProvider() below opts into it.
//
// ─── Transport regime: streaming (transport-hardening PR) ─────────────────────
//
// completeMultiTurn uses `stream: true` (SSE). Regimes, by contrast:
//
//   1. NON-STREAMING LEGACY (all other providers/wires): one HTTP request,
//      zero response bytes until the entire generation completes. A flow that
//      sits byte-idle for the full generation time is exposed to idle-flow
//      termination anywhere on the path (see pilot-a evidence/
//      transport-investigation/ — attempts 20/21 died this way at 8.8/13.1 min,
//      cause unattributed). Failure before any bytes or mid-JSON-body is a
//      thrown fetch/parse error — never a partial success.
//
//   2. STREAMING (this class): response bytes flow continuously during
//      generation (SSE deltas; measured largest inter-chunk gap 0.28 s on the
//      pilot route), so the flow is never byte-idle mid-generation.
//      • Failure BEFORE FIRST BYTE (connect/TLS/request-reject): thrown before
//        any content exists — identical in kind to regime 1.
//      • Failure MID-STREAM (remote disconnect, malformed/truncated SSE):
//        thrown as a transport error. If a finish_reason was already received,
//        the generation itself is complete and only trailing bytes (e.g. the
//        usage chunk) were lost — the assembled result is still valid; a
//        disconnect BEFORE finish_reason never yields a result (no partial
//        generation is ever returned as a successful completed model turn).
//
// REGIME BOUNDARY (comparability): switching a wire between regimes 1 and 2
// changes transport semantics and failure modes; it must never be done
// silently inside an experiment — see pilot journal transport_investigation_closed.
//
// The SSE parse/assembly itself lives in src/sse-accumulator.ts — a pure,
// deterministically testable state machine (framing splits, multi-event
// chunks, fragmented tool-call arguments, usage capture, fail-closed
// truncation/malformation semantics).
export class OpenAICompatibleMultiTurnProvider extends OpenAICompatibleProvider implements IMultiTurnProvider {
  async completeMultiTurn(params: MultiTurnParams): Promise<MultiTurnResult> {
    const model = params.model || this.defaultModel;
    const messages = buildOpenAIToolMessages(params.system, params.messages);
    const tools = params.tools.map((t) => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model, messages, max_tokens: params.max_tokens, tools, tool_choice: 'auto',
        // E3b — sampling parity: forward the temperature the runner runs
        // everywhere else; absent leaves the provider default (legacy).
        ...(params.temperature !== undefined && { temperature: params.temperature }),
        // Transport regime 2 — SSE streaming (see regime boundary above).
        stream: true,
      }),
      // Transport-boundary cancellation: honored only when the caller supplies
      // a signal (MultiTurnParams.signal); no orchestrator caller does today.
      ...(params.signal && { signal: params.signal }),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'unknown error');
      throw new Error(`LLM API request failed: ${response.status} ${response.statusText} — ${errorBody}`);
    }
    if (!response.body) {
      throw new Error('LLM API request failed: streaming response has no body');
    }

    const accumulator = new SseStreamAccumulator();
    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    try {
      for (;;) {
        try {
          const readResult = await reader.read();
          if (readResult.done) break;
          accumulator.feed(decoder.decode(readResult.value, { stream: true }));
        } catch (err) {
          // Explicit caller cancellation is NEVER converted to success — not
          // even after finish_reason. "finish_reason seen ⇒ disconnect is
          // benign" is a statement about REMOTE trailing loss, not a license
          // to override the caller's cancel: rethrow the abort as-is (the
          // original error object, so cause chains and identity survive).
          if (isAbortError(err)) throw err;
          // SSE contract violations keep their own (fail-closed) error type.
          if (err instanceof SseParseError) throw err;
          // Remote disconnect / socket error. After finish_reason the
          // accumulator is in its terminal semantic state (enforced in
          // SseStreamAccumulator: only usage-only chunks are legal after the
          // terminal finish_reason), so nothing semantic can be lost — only
          // trailing bytes (usage) were at risk. Before it, this is a hard
          // transport failure.
          if (accumulator.hasFinishReason) break;
          const cause = (err as { cause?: { code?: string; message?: string } }).cause;
          // Preserve the original error as `cause`: AgentLoop's
          // describeTransportFailure extracts evidence from
          // err.cause / err.cause.code / err.cause.cause.code — the exact
          // machinery that classified pilot attempts 20/21. Dropping the
          // chain would regress transport-failure evidence to a bare message.
          throw new Error(
            `LLM stream failed before completion (transport): ${(err as Error).message}`
            + `${cause?.code ? ` [${cause.code}]` : ''}`
            + ` — no partial generation is returned`,
            { cause: err },
          );
        }
      }
      accumulator.feed(decoder.decode()); // flush any buffered multibyte tail
      accumulator.end();
    } finally {
      reader.releaseLock();
    }

    const assembled = accumulator.assemble(); // throws if finish_reason never arrived

    const toolUses = assembled.toolCalls.map((tc) => ({
      type: 'tool_use' as const,
      id: tc.id,
      name: tc.name,
      input: parseToolArguments(tc.arguments),
    }));

    const stopReason =
      assembled.finishReason === 'length' ? 'max_tokens'
      : (assembled.finishReason === 'tool_calls' || toolUses.length > 0) ? 'tool_use'
      : 'end_turn';

    return {
      stop_reason: stopReason,
      text: assembled.text,
      tool_uses: toolUses,
      tokens_used: assembled.totalTokens ?? 0,
    };
  }
}

// Cancellation detection for the streaming read loop: undici/Node surface an
// aborted request as a DOMException named 'AbortError', or as an error whose
// `code` (own or on the cause) is 'ABORT_ERR'. Distinct from remote disconnects
// so caller cancellation can never be downgraded to a benign trailing loss.
function isAbortError(err: unknown): boolean {
  const e = err as { name?: string; code?: string; cause?: { code?: string } } | null;
  if (!e) return false;
  return e.name === 'AbortError' || e.code === 'ABORT_ERR' || e.cause?.code === 'ABORT_ERR';
}

// A malformed tool_call.function.arguments string (not valid JSON) fails
// closed to an empty object rather than throwing — handleToolCall (tools.ts)
// then reports a normal tool-result error for a missing/invalid argument,
// the same way it already handles any other malformed tool input.
function parseToolArguments(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// ─── D.34 C6 — native structured output on the OpenAI wire ────────────────────
//
// response_format json_schema (strict) is OpenAI's and OpenRouter's genuine
// constrained-decoding mechanism for tool-calling-capable models. Kept as a
// separate class on the SAME opt-in discipline as the multi-turn provider:
// only the 'openrouter' case opts in; plain openai_compatible/glm endpoints
// are not assumed to support it (fallback by capability — they simply lack
// completeStructured).
export class OpenAICompatibleStructuredProvider extends OpenAICompatibleMultiTurnProvider implements IStructuredProvider {
  async completeStructured(params: StructuredCompletionParams): Promise<StructuredCompletionResult> {
    const start = Date.now();
    const model = params.model || this.defaultModel;
    const messages: Array<Record<string, string>> = [];
    if (params.system) messages.push({ role: 'system', content: params.system });
    for (const m of params.messages) messages.push({ role: m.role, content: m.content });

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: params.max_tokens,
        ...(params.temperature !== undefined && { temperature: params.temperature }),
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: params.schemaName ?? 'result',
            strict: true,
            schema: params.schema,
          },
        },
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'unknown error');
      throw new Error(`LLM API request failed: ${response.status} ${response.statusText} — ${errorBody}`);
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string | null } }>;
      usage?: { total_tokens: number };
    };
    const content = data.choices?.[0]?.message?.content ?? '';
    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch (err) {
      // Native structured output must be schema-shaped JSON; a provider that
      // returns prose violated its own capability contract — fail closed.
      throw new Error(
        `Structured completion returned non-JSON content: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return { value, tokens_used: data.usage?.total_tokens ?? 0, duration_ms: Date.now() - start };
  }
}

// Converts AgentLoop's provider-agnostic MultiTurnMessage[] (Anthropic-
// content-block-shaped: one assistant message carrying an array of
// tool_use blocks, one user message carrying an array of tool_result
// blocks) into the OpenAI wire format, which has no equivalent grouping —
// an assistant tool-calling turn is `tool_calls` on one assistant message,
// and each tool result is its OWN `role: 'tool'` message.
function buildOpenAIToolMessages(system: string, messages: MultiTurnMessage[]): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  if (system) result.push({ role: 'system', content: system });

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      result.push({ role: msg.role, content: msg.content });
      continue;
    }

    const toolUseBlocks = msg.content.filter(
      (b): b is { type: 'tool_use'; id: string; name: string; input: unknown } => b.type === 'tool_use',
    );
    const toolResultBlocks = msg.content.filter(
      (b): b is { type: 'tool_result'; tool_use_id: string; content: string } => b.type === 'tool_result',
    );
    const textBlocks = msg.content.filter(
      (b): b is { type: 'text'; text: string } => b.type === 'text',
    );

    if (toolUseBlocks.length > 0) {
      result.push({
        role: 'assistant',
        content: textBlocks.length > 0 ? textBlocks.map((b) => b.text).join('') : null,
        tool_calls: toolUseBlocks.map((b) => ({
          id: b.id,
          type: 'function',
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        })),
      });
      continue;
    }

    if (toolResultBlocks.length > 0) {
      for (const b of toolResultBlocks) {
        result.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.content });
      }
      continue;
    }

    result.push({ role: msg.role, content: textBlocks.map((b) => b.text).join('') });
  }

  return result;
}

export class AnthropicProvider implements ILLMProvider {
  private apiKey: string;
  private defaultModel: string;
  private baseUrl: string;

  constructor(config: AgentLLMConfig) {
    this.apiKey = process.env[config.api_key_env] || process.env.SLE_LLM_API_KEY || '';
    this.defaultModel = config.model;
    this.baseUrl = (config.base_url || 'https://api.anthropic.com/v1').replace(/\/$/, '');

    if (!this.apiKey) {
      throw new Error(
        `API key not found. Set ${config.api_key_env} or SLE_LLM_API_KEY environment variable.`
      );
    }
  }

  async complete(params: LLMCompletionParams): Promise<LLMCompletionResult> {
    LLMCompletionParamsSchema.parse(params);

    const start = Date.now();
    const url = `${this.baseUrl}/messages`;

    // Anthropic separates system from user/assistant turns
    const systemMessages = params.messages.filter((m) => m.role === 'system');
    const turns = params.messages.filter((m) => m.role !== 'system');

    const body: Record<string, unknown> = {
      model: params.model || this.defaultModel,
      max_tokens: params.max_tokens,
      messages: turns,
    };
    if (systemMessages.length > 0) {
      body.system = systemMessages.map((m) => m.content).join('\n\n');
    }
    if (params.temperature !== undefined) {
      body.temperature = params.temperature;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'unknown error');
      throw new Error(
        `Anthropic API request failed: ${response.status} ${response.statusText} — ${errorBody}`
      );
    }

    const data = await response.json() as {
      content: Array<{ type: string; text: string }>;
      usage?: { input_tokens: number; output_tokens: number };
    };

    const textBlock = data.content?.find((b) => b.type === 'text');
    const content = textBlock?.text ?? '';
    const tokensUsed = data.usage
      ? (data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0)
      : 0;

    const result: LLMCompletionResult = {
      content,
      tokens_used: tokensUsed,
      duration_ms: Date.now() - start,
    };

    LLMCompletionResultSchema.parse(result);
    return result;
  }
}

function supportsMultiTurn(provider: ILLMProvider): provider is ILLMProvider & IMultiTurnProvider {
  return typeof (provider as Partial<IMultiTurnProvider>).completeMultiTurn === 'function';
}

// D.3b1 — the narrowest capability-preserving seam: `completeMultiTurn` is
// only ever present on this instance (as an own, dynamically (re)assigned
// property, not a class method) when the currently-wrapped provider itself
// implements it. AgentRunner's multi-turn detection is exactly
// `typeof provider.completeMultiTurn === 'function'` — if this class
// declared `completeMultiTurn` as an ordinary method, that check would
// always be true regardless of what the wrapped provider actually supports,
// and AgentRunner would select the multi-turn path only to have it throw.
// Declaring it as an optional property and (re)computing it in
// syncMultiTurnCapability() — called from the constructor and every
// setProvider() — keeps the capability honest across provider swaps: a
// provider that doesn't support multi-turn leaves the capability genuinely
// absent, never a promise that fails later.
export class DynamicLLMProvider implements ILLMProvider {
  private activeProvider: ILLMProvider;
  completeMultiTurn?: (params: MultiTurnParams) => Promise<MultiTurnResult>;
  // D.34 C6 — synced exactly like multi-turn: the structured-output
  // capability is genuinely present only when the wrapped provider
  // implements it, so capability probing stays honest across provider swaps.
  completeStructured?: (params: import('./llm-provider.js').StructuredCompletionParams) => Promise<import('./llm-provider.js').StructuredCompletionResult>;

  constructor(initialProvider: ILLMProvider) {
    this.activeProvider = initialProvider;
    this.syncMultiTurnCapability();
  }

  setProvider(provider: ILLMProvider) {
    this.activeProvider = provider;
    this.syncMultiTurnCapability();
  }

  getProvider(): ILLMProvider {
    return this.activeProvider;
  }

  async complete(params: LLMCompletionParams): Promise<LLMCompletionResult> {
    return this.activeProvider.complete(params);
  }

  private syncMultiTurnCapability(): void {
    if (supportsMultiTurn(this.activeProvider)) {
      const provider = this.activeProvider;
      this.completeMultiTurn = (params) => provider.completeMultiTurn(params);
    } else {
      delete this.completeMultiTurn;
    }
    if (supportsStructured(this.activeProvider)) {
      const provider = this.activeProvider;
      this.completeStructured = (params) => provider.completeStructured(params);
    } else {
      delete this.completeStructured;
    }
  }
}

function supportsStructured(provider: ILLMProvider): provider is ILLMProvider & IStructuredProvider {
  return typeof (provider as Partial<IStructuredProvider>).completeStructured === 'function';
}

// D.3b1.2 — AgentLLMConfig.base_url's pre-existing convention (see the old
// AnthropicProvider.complete() above) treats the value as the exact prefix
// placed immediately before '/messages' — a caller configuring the
// standard form 'https://api.anthropic.com/v1' relies on that producing
// '.../v1/messages'. The official SDK instead treats its own `baseURL`
// option as a host/prefix placed before the SDK's OWN fixed '/v1/messages'
// resource path — passing the old convention's value straight through
// would double it into '.../v1/v1/messages'. Stripping a trailing '/v1'
// (the standard existing form) before handing the value to the SDK
// reproduces exactly the old resulting URL. A base_url that does not end
// in '/v1' is passed through unchanged (out of scope — narrower than the
// old provider's fully free-form '/messages' suffixing, but preserves the
// one convention callers actually depend on).
export function anthropicSdkBaseUrl(configBaseUrl: string | undefined): string | undefined {
  if (!configBaseUrl) return undefined;
  const trimmed = configBaseUrl.replace(/\/$/, '');
  return trimmed.endsWith('/v1') ? trimmed.slice(0, -'/v1'.length) : trimmed;
}

// D.3b1.1 — the anthropic case is the one production configuration that
// must return a genuinely multi-turn-capable provider: AnthropicSDKProvider
// implements IMultiTurnProvider against the real Anthropic SDK, so a run
// wired through this factory (as resolveLLMProvider() does) can actually
// take AgentLoop's multi-turn path — DynamicLLMProvider only ever preserves
// a capability that's genuinely present on what it wraps. The REST-based
// AnthropicProvider above stays exported (and covered by its own tests) but
// is no longer reachable from this factory, since it has no multi-turn
// implementation. openai_compatible stays single-turn-only — it is not
// faked into multi-turn capability. openrouter DOES get genuine
// multi-turn capability (OpenAICompatibleMultiTurnProvider, D.3d) since
// OpenRouter's own wire format for tool-calling-capable models is real,
// not faked.
export function createLLMProvider(config: AgentLLMConfig): ILLMProvider {
  switch (config.provider) {
    case 'openai_compatible':
      return new OpenAICompatibleProvider(config);
    case 'anthropic': {
      const apiKey = process.env[config.api_key_env] || process.env.SLE_LLM_API_KEY || '';
      if (!apiKey) {
        throw new Error(
          `API key not found. Set ${config.api_key_env} or SLE_LLM_API_KEY environment variable.`
        );
      }
      const baseURL = anthropicSdkBaseUrl(config.base_url);
      const client = baseURL ? new Anthropic({ apiKey, baseURL }) : undefined;
      return new AnthropicSDKProvider(apiKey, { defaultModel: config.model, client });
    }
    case 'openrouter': {
      const orConfig: AgentLLMConfig = {
        ...config,
        base_url: config.base_url || 'https://openrouter.ai/api/v1',
        model: config.model || 'google/gemini-2.5-pro',
        api_key_env: config.api_key_env || 'OPENROUTER_API_KEY',
      };
      // D.3d — OpenRouter genuinely supports the OpenAI tool-calling wire
      // format for tool-capable models, so it gets real multi-turn
      // capability (OpenAICompatibleMultiTurnProvider above), unlike
      // openai_compatible above which stays single-turn-only.
      // D.34 C6 — it also genuinely supports response_format json_schema
      // (strict), so the structured-output capability rides along; absence
      // of that capability on other providers keeps the textual review
      // fallback as the honest default (probing is by capability).
      return new OpenAICompatibleStructuredProvider(orConfig);
    }
    default:
      throw new Error(`Unknown LLM provider: ${(config as { provider: string }).provider}`);
  }
}
