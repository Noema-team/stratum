import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import type { AgentLLMConfig } from './types.js';
import type { IMultiTurnProvider, MultiTurnParams, MultiTurnResult, MultiTurnMessage } from './agent-loop.js';
import { AnthropicSDKProvider } from './anthropic-provider.js';

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
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'unknown error');
      throw new Error(`LLM API request failed: ${response.status} ${response.statusText} — ${errorBody}`);
    }

    const data = await response.json() as {
      choices: Array<{
        message: { content: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
        finish_reason: string;
      }>;
      usage?: { total_tokens: number };
    };

    const choice = data.choices?.[0];
    const message = choice?.message;
    const finishReason = choice?.finish_reason ?? 'stop';
    const rawToolCalls = message?.tool_calls ?? [];

    const toolUses = rawToolCalls.map((tc) => ({
      type: 'tool_use' as const,
      id: tc.id,
      name: tc.function.name,
      input: parseToolArguments(tc.function.arguments),
    }));

    const stopReason =
      finishReason === 'length' ? 'max_tokens'
      : (finishReason === 'tool_calls' || toolUses.length > 0) ? 'tool_use'
      : 'end_turn';

    return {
      stop_reason: stopReason,
      text: message?.content ?? '',
      tool_uses: toolUses,
      tokens_used: data.usage?.total_tokens ?? 0,
    };
  }
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
  }
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
// implementation. openai_compatible/glm stay single-turn-only — they are
// not faked into multi-turn capability. openrouter DOES get genuine
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
    case 'glm': {
      const glmConfig: AgentLLMConfig = {
        ...config,
        // Default to Z.AI Coding Plan endpoint.
        // For standard Z.AI use: https://api.z.ai/api/paas/v4
        // For mainland CN use: https://open.bigmodel.cn/api/paas/v4
        base_url: config.base_url || 'https://api.z.ai/api/coding/paas/v4',
        model: config.model || 'glm-4',
        api_key_env: config.api_key_env || 'GLM_API_KEY',
      };
      return new OpenAICompatibleProvider(glmConfig);
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
      // openai_compatible/glm above which stay single-turn-only.
      return new OpenAICompatibleMultiTurnProvider(orConfig);
    }
    default:
      throw new Error(`Unknown LLM provider: ${(config as { provider: string }).provider}`);
  }
}
