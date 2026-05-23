import Anthropic from '@anthropic-ai/sdk';
import type { ILLMProvider, LLMCompletionParams, LLMCompletionResult } from './llm-provider.js';
import type { MultiTurnParams, MultiTurnResult, IMultiTurnProvider } from './agent-loop.js';

// ─── Error types ──────────────────────────────────────────────────────────────

export class LLMProviderError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly statusCode?: number
  ) {
    super(message);
    this.name = 'LLMProviderError';
  }
}

// ─── Minimal injectable interface (for tests) ─────────────────────────────────

export interface AnthropicClientLike {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

// ─── AnthropicSDKProvider ─────────────────────────────────────────────────────

export class AnthropicSDKProvider implements ILLMProvider, IMultiTurnProvider {
  private client: AnthropicClientLike;
  private defaultModel: string;

  constructor(
    apiKey: string,
    options?: { defaultModel?: string; client?: AnthropicClientLike }
  ) {
    this.defaultModel = options?.defaultModel ?? 'claude-sonnet-4-6';
    this.client = options?.client ?? new Anthropic({ apiKey });
  }

  async complete(params: LLMCompletionParams): Promise<LLMCompletionResult> {
    const start = Date.now();
    const model = params.model || this.defaultModel;

    // Separate system message from conversation turns
    const systemMessages = params.messages.filter((m) => m.role === 'system');
    const turns = params.messages.filter((m) => m.role !== 'system') as Array<
      Anthropic.MessageParam
    >;

    // Build system array with cache_control on the combined system text
    const systemText = systemMessages.map((m) => m.content).join('\n\n');
    const systemParam: Anthropic.TextBlockParam[] = systemText
      ? [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }]
      : [];

    const createParams: Anthropic.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: params.max_tokens,
      messages: turns,
      ...(systemParam.length > 0 && { system: systemParam }),
    };

    let message: Anthropic.Message;
    try {
      message = await this.client.messages.create(createParams);
    } catch (err) {
      throw this.mapError(err);
    }

    const textBlock = message.content.find(
      (b): b is Anthropic.TextBlock => b.type === 'text'
    );
    const content = textBlock?.text ?? '';
    const tokensUsed =
      (message.usage?.input_tokens ?? 0) + (message.usage?.output_tokens ?? 0);

    return {
      content,
      tokens_used: tokensUsed,
      duration_ms: Date.now() - start,
    };
  }

  async completeMultiTurn(params: MultiTurnParams): Promise<MultiTurnResult> {
    const model = params.model || this.defaultModel;

    // Build system array with cache_control
    const systemParam: Anthropic.TextBlockParam[] = params.system
      ? [{ type: 'text', text: params.system, cache_control: { type: 'ephemeral' } }]
      : [];

    // Map messages to Anthropic.MessageParam format
    const messagesParam: Anthropic.MessageParam[] = params.messages.map((msg) => {
      if (typeof msg.content === 'string') {
        return { role: msg.role, content: msg.content };
      }

      const content = msg.content.map((block) => {
        if (block.type === 'text') {
          return { type: 'text' as const, text: block.text };
        }
        if (block.type === 'tool_use') {
          return {
            type: 'tool_use' as const,
            id: block.id,
            name: block.name,
            input: block.input as Record<string, unknown>,
          };
        }
        if (block.type === 'tool_result') {
          return {
            type: 'tool_result' as const,
            tool_use_id: block.tool_use_id,
            content: block.content,
          };
        }
        throw new Error(`Unsupported block type: ${(block as any).type}`);
      });
      return { role: msg.role, content };
    });

    const createParams: Anthropic.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: params.max_tokens,
      messages: messagesParam,
      ...(systemParam.length > 0 && { system: systemParam }),
      tools: params.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema as any,
      })),
    };

    let message: Anthropic.Message;
    try {
      message = await this.client.messages.create(createParams);
    } catch (err) {
      throw this.mapError(err);
    }

    const textBlock = message.content.find(
      (b): b is Anthropic.TextBlock => b.type === 'text'
    );
    const text = textBlock?.text ?? '';

    const toolUses = message.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
      .map((b) => ({
        type: 'tool_use' as const,
        id: b.id,
        name: b.name,
        input: b.input,
      }));

    const tokensUsed =
      (message.usage?.input_tokens ?? 0) + (message.usage?.output_tokens ?? 0);

    return {
      stop_reason: message.stop_reason ?? 'end_turn',
      text,
      tool_uses: toolUses,
      tokens_used: tokensUsed,
    };
  }

  private mapError(err: unknown): LLMProviderError {
    if (err instanceof Anthropic.AuthenticationError) {
      return new LLMProviderError(err.message, false, err.status);
    }
    if (err instanceof Anthropic.RateLimitError) {
      return new LLMProviderError(err.message, true, err.status);
    }
    if (err instanceof Anthropic.InternalServerError) {
      // 529 (overloaded) and 500 are both retryable
      return new LLMProviderError(err.message, true, err.status);
    }
    if (err instanceof Anthropic.APIError) {
      // Other API errors (400 bad request, etc.) are not retryable
      const retryable = err.status != null && err.status >= 500;
      return new LLMProviderError(err.message, retryable, err.status);
    }
    const message = err instanceof Error ? err.message : String(err);
    return new LLMProviderError(message, false);
  }
}
