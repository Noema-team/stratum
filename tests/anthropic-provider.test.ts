/**
 * Phase A: AnthropicSDKProvider — 12 unit tests.
 *
 * All tests inject a mock Anthropic client. No real API calls are made.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import Anthropic from '@anthropic-ai/sdk';
import {
  AnthropicSDKProvider,
  LLMProviderError,
  type AnthropicClientLike,
} from '../src/anthropic-provider.js';
import type { LLMCompletionParams } from '../src/llm-provider.js';

// ─── Mock client factory ──────────────────────────────────────────────────────

interface MockClientCall {
  params: Anthropic.MessageCreateParamsNonStreaming;
}

function makeMockClient(options?: {
  response?: Partial<Anthropic.Message>;
  throws?: Error;
}): { client: AnthropicClientLike; calls: MockClientCall[] } {
  const calls: MockClientCall[] = [];
  const defaultResponse: Anthropic.Message = {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'Hello from mock.' }],
    model: 'claude-sonnet-4-6',
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  };
  const client: AnthropicClientLike = {
    messages: {
      create: async (params) => {
        calls.push({ params });
        if (options?.throws) throw options.throws;
        return { ...defaultResponse, ...options?.response } as Anthropic.Message;
      },
    },
  };
  return { client, calls };
}

function makeParams(overrides: Partial<LLMCompletionParams> = {}): LLMCompletionParams {
  return {
    model: 'claude-sonnet-4-6',
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello.' },
    ],
    temperature: 0.7,
    max_tokens: 1024,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test('AnthropicSDKProvider: initialises with API key', () => {
  const { client } = makeMockClient();
  const provider = new AnthropicSDKProvider('sk-test-key', { client });
  assert.ok(provider instanceof AnthropicSDKProvider);
});

test('AnthropicSDKProvider: complete() maps request to Anthropic SDK params correctly', async () => {
  const { client, calls } = makeMockClient();
  const provider = new AnthropicSDKProvider('sk-test', { client });
  const params = makeParams({ model: 'claude-opus-4-7', max_tokens: 2048 });

  await provider.complete(params);

  assert.strictEqual(calls.length, 1);
  const call = calls[0].params;
  assert.strictEqual(call.model, 'claude-opus-4-7');
  assert.strictEqual(call.max_tokens, 2048);
});

test('AnthropicSDKProvider: system prompt is marked with cache_control ephemeral', async () => {
  const { client, calls } = makeMockClient();
  const provider = new AnthropicSDKProvider('sk-test', { client });

  await provider.complete(makeParams());

  const system = calls[0].params.system as Anthropic.TextBlockParam[] | undefined;
  assert.ok(Array.isArray(system), 'system should be an array');
  assert.strictEqual(system![0].type, 'text');
  assert.deepStrictEqual(system![0].cache_control, { type: 'ephemeral' });
  assert.ok(system![0].text.includes('helpful assistant'), 'system text should contain content');
});

test('AnthropicSDKProvider: response mapped to LLMCompletionResult shape', async () => {
  const { client } = makeMockClient({
    response: {
      content: [{ type: 'text', text: 'Mapped response.' }],
      usage: { input_tokens: 20, output_tokens: 8, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  });
  const provider = new AnthropicSDKProvider('sk-test', { client });

  const result = await provider.complete(makeParams());

  assert.strictEqual(result.content, 'Mapped response.');
  assert.strictEqual(result.tokens_used, 28); // 20 + 8
  assert.ok(result.duration_ms >= 0);
});

test('AnthropicSDKProvider: AuthenticationError maps to LLMProviderError { retryable: false }', async () => {
  const authError = new Anthropic.AuthenticationError(
    401,
    { error: { type: 'authentication_error', message: 'Invalid API key' } },
    'Invalid API key',
    {} as never
  );
  const { client } = makeMockClient({ throws: authError });
  const provider = new AnthropicSDKProvider('sk-bad', { client });

  await assert.rejects(
    () => provider.complete(makeParams()),
    (err: LLMProviderError) => {
      assert.ok(err instanceof LLMProviderError);
      assert.strictEqual(err.retryable, false);
      assert.strictEqual(err.statusCode, 401);
      return true;
    }
  );
});

test('AnthropicSDKProvider: RateLimitError maps to LLMProviderError { retryable: true }', async () => {
  const rateLimitError = new Anthropic.RateLimitError(
    429,
    { error: { type: 'rate_limit_error', message: 'Rate limit exceeded' } },
    'Rate limit exceeded',
    {} as never
  );
  const { client } = makeMockClient({ throws: rateLimitError });
  const provider = new AnthropicSDKProvider('sk-test', { client });

  await assert.rejects(
    () => provider.complete(makeParams()),
    (err: LLMProviderError) => {
      assert.ok(err instanceof LLMProviderError);
      assert.strictEqual(err.retryable, true);
      assert.strictEqual(err.statusCode, 429);
      return true;
    }
  );
});

test('AnthropicSDKProvider: InternalServerError (529) maps to LLMProviderError { retryable: true }', async () => {
  const overloadedError = new Anthropic.InternalServerError(
    529,
    { error: { type: 'overloaded_error', message: 'API overloaded' } },
    'API overloaded',
    {} as never
  );
  const { client } = makeMockClient({ throws: overloadedError });
  const provider = new AnthropicSDKProvider('sk-test', { client });

  await assert.rejects(
    () => provider.complete(makeParams()),
    (err: LLMProviderError) => {
      assert.ok(err instanceof LLMProviderError);
      assert.strictEqual(err.retryable, true);
      assert.strictEqual(err.statusCode, 529);
      return true;
    }
  );
});

test('AnthropicSDKProvider: model override respected', async () => {
  const { client, calls } = makeMockClient();
  const provider = new AnthropicSDKProvider('sk-test', {
    defaultModel: 'claude-haiku-4-5-20251001',
    client,
  });

  await provider.complete(makeParams({ model: 'claude-opus-4-7' }));

  assert.strictEqual(calls[0].params.model, 'claude-opus-4-7');
});

test('AnthropicSDKProvider: default model used when model not specified in params', async () => {
  const { client, calls } = makeMockClient();
  const provider = new AnthropicSDKProvider('sk-test', {
    defaultModel: 'claude-haiku-4-5-20251001',
    client,
  });

  await provider.complete(makeParams({ model: '' }));

  assert.strictEqual(calls[0].params.model, 'claude-haiku-4-5-20251001');
});

test('AnthropicSDKProvider: max_tokens passed through correctly', async () => {
  const { client, calls } = makeMockClient();
  const provider = new AnthropicSDKProvider('sk-test', { client });

  await provider.complete(makeParams({ max_tokens: 4096 }));

  assert.strictEqual(calls[0].params.max_tokens, 4096);
});

test('D.3b1.2: AnthropicSDKProvider.complete() forwards temperature unchanged, preserving the ILLMProvider contract the old REST provider honored', async () => {
  const { client, calls } = makeMockClient();
  const provider = new AnthropicSDKProvider('sk-test', { client });

  await provider.complete(makeParams({ temperature: 0.3 }));

  assert.strictEqual((calls[0].params as { temperature?: number }).temperature, 0.3);
});

test('AnthropicSDKProvider: user/assistant messages passed through unmodified', async () => {
  const { client, calls } = makeMockClient();
  const provider = new AnthropicSDKProvider('sk-test', { client });
  const params = makeParams({
    messages: [
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: 'What is 2+2?' },
      { role: 'assistant', content: '4.' },
      { role: 'user', content: 'And 3+3?' },
    ],
  });

  await provider.complete(params);

  const sentMessages = calls[0].params.messages as Anthropic.MessageParam[];
  assert.strictEqual(sentMessages.length, 3); // system stripped, 3 turns remain
  assert.strictEqual(sentMessages[0].role, 'user');
  assert.strictEqual(sentMessages[0].content, 'What is 2+2?');
  assert.strictEqual(sentMessages[1].role, 'assistant');
  assert.strictEqual(sentMessages[2].role, 'user');
});

test('AnthropicSDKProvider: cache_control not set on user messages', async () => {
  const { client, calls } = makeMockClient();
  const provider = new AnthropicSDKProvider('sk-test', { client });

  await provider.complete(makeParams());

  const messages = calls[0].params.messages as Anthropic.MessageParam[];
  for (const msg of messages) {
    // User/assistant messages should be plain strings, not arrays with cache_control
    assert.ok(
      typeof msg.content === 'string',
      `message content should be a plain string, not an object with cache_control`
    );
  }
});
