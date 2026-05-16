import { z } from 'zod';
import type { AgentLLMConfig } from './types.js';

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

export function createLLMProvider(config: AgentLLMConfig): ILLMProvider {
  switch (config.provider) {
    case 'openai_compatible':
      return new OpenAICompatibleProvider(config);
    case 'anthropic':
      return new AnthropicProvider(config);
    default:
      throw new Error(`Unknown LLM provider: ${(config as { provider: string }).provider}`);
  }
}
