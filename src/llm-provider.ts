import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import type { AgentLLMConfig } from './types.js';
import type { IMultiTurnProvider, MultiTurnParams, MultiTurnResult } from './agent-loop.js';
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
  private baseUrl: string;
  private apiKey: string;
  private defaultModel: string;

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

// D.3b1.1 — the anthropic case is the one production configuration that
// must return a genuinely multi-turn-capable provider: AnthropicSDKProvider
// implements IMultiTurnProvider against the real Anthropic SDK, so a run
// wired through this factory (as resolveLLMProvider() does) can actually
// take AgentLoop's multi-turn path — DynamicLLMProvider only ever preserves
// a capability that's genuinely present on what it wraps. The REST-based
// AnthropicProvider above stays exported (and covered by its own tests) but
// is no longer reachable from this factory, since it has no multi-turn
// implementation. openai_compatible/glm/openrouter intentionally remain
// single-turn-only — they are not faked into multi-turn capability.
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
      const client = config.base_url ? new Anthropic({ apiKey, baseURL: config.base_url }) : undefined;
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
      return new OpenAICompatibleProvider(orConfig);
    }
    default:
      throw new Error(`Unknown LLM provider: ${(config as { provider: string }).provider}`);
  }
}
