import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  OpenAICompatibleProvider,
  AnthropicProvider,
  createLLMProvider,
  LLMCompletionParamsSchema,
  LLMCompletionResultSchema,
  DynamicLLMProvider,
  type ILLMProvider,
} from '../src/llm-provider.js';
import type { AgentLLMConfig } from '../src/types.js';

const TEST_CONFIG: AgentLLMConfig = {
  provider: 'openai_compatible',
  api_key_env: 'TEST_LLM_API_KEY',
  model: 'test-model',
};

const ANTHROPIC_CONFIG: AgentLLMConfig = {
  provider: 'anthropic',
  api_key_env: 'TEST_LLM_API_KEY',
  model: 'claude-3',
};

function mockFetchSuccess(responseBody: unknown): void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  (globalThis.fetch as { __restore?: () => void }).__restore = () => {
    globalThis.fetch = originalFetch;
  };
}

function mockFetchError(status: number, body: string): void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    return new Response(body, { status });
  };
  (globalThis.fetch as { __restore?: () => void }).__restore = () => {
    globalThis.fetch = originalFetch;
  };
}

function restoreFetch(): void {
  const f = globalThis.fetch as { __restore?: () => void };
  if (f.__restore) f.__restore();
}

test('testOpenAICompatibleProviderReturnsStructuredResponse', async () => {
  process.env.TEST_LLM_API_KEY = 'test-key-123';
  const provider = new OpenAICompatibleProvider(TEST_CONFIG);

  mockFetchSuccess({
    choices: [{ message: { content: 'Hello from LLM' } }],
    usage: { total_tokens: 42 },
  });

  try {
    const result = await provider.complete({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Hello' }],
      temperature: 0.7,
      max_tokens: 100,
    });

    assert.strictEqual(result.content, 'Hello from LLM');
    assert.strictEqual(result.tokens_used, 42);
    assert.strictEqual(typeof result.duration_ms, 'number');
    assert.ok(result.duration_ms >= 0);
  } finally {
    restoreFetch();
    delete process.env.TEST_LLM_API_KEY;
  }
});

test('testOpenAICompatibleProviderUsesApiKeyFromEnv', async () => {
  process.env.TEST_LLM_API_KEY = 'test-key-123';
  const provider = new OpenAICompatibleProvider(TEST_CONFIG);
  assert.ok(provider instanceof OpenAICompatibleProvider);
  delete process.env.TEST_LLM_API_KEY;
});

test('testOpenAICompatibleProviderFallsBackToSleKey', async () => {
  delete process.env.TEST_LLM_API_KEY;
  process.env.SLE_LLM_API_KEY = 'fallback-key';
  const provider = new OpenAICompatibleProvider(TEST_CONFIG);
  assert.ok(provider instanceof OpenAICompatibleProvider);
  delete process.env.SLE_LLM_API_KEY;
});

test('testOpenAICompatibleProviderThrowsOnMissingKey', async () => {
  delete process.env.TEST_LLM_API_KEY;
  delete process.env.SLE_LLM_API_KEY;
  assert.throws(
    () => new OpenAICompatibleProvider(TEST_CONFIG),
    /API key not found/
  );
});

test('testOpenAICompatibleProviderThrowsOnApiError', async () => {
  process.env.TEST_LLM_API_KEY = 'test-key';
  const provider = new OpenAICompatibleProvider(TEST_CONFIG);

  mockFetchError(429, 'Rate limited');

  try {
    await assert.rejects(
      () => provider.complete({
        model: 'test-model',
        messages: [{ role: 'user', content: 'Hello' }],
        temperature: 0.7,
        max_tokens: 100,
      }),
      /LLM API request failed: 429/
    );
  } finally {
    restoreFetch();
    delete process.env.TEST_LLM_API_KEY;
  }
});

test('testOpenAICompatibleProviderHandlesEmptyChoices', async () => {
  process.env.TEST_LLM_API_KEY = 'test-key';
  const provider = new OpenAICompatibleProvider(TEST_CONFIG);

  mockFetchSuccess({ choices: [], usage: { total_tokens: 0 } });

  try {
    const result = await provider.complete({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Hello' }],
      temperature: 0.5,
      max_tokens: 50,
    });

    assert.strictEqual(result.content, '');
    assert.strictEqual(result.tokens_used, 0);
  } finally {
    restoreFetch();
    delete process.env.TEST_LLM_API_KEY;
  }
});

test('testOpenAICompatibleProviderUsesCustomBaseUrl', async () => {
  process.env.TEST_LLM_API_KEY = 'test-key';
  const config: AgentLLMConfig = {
    provider: 'openai_compatible',
    api_key_env: 'TEST_LLM_API_KEY',
    model: 'test-model',
    base_url: 'https://custom.api.example.com/v1',
  };

  let capturedUrl = '';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL) => {
    capturedUrl = input.toString();
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: 'ok' } }],
        usage: { total_tokens: 1 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  };

  try {
    const provider = new OpenAICompatibleProvider(config);
    await provider.complete({
      model: 'test-model',
      messages: [{ role: 'user', content: 'test' }],
      temperature: 0.5,
      max_tokens: 10,
    });

    assert.ok(capturedUrl.startsWith('https://custom.api.example.com/v1/'));
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.TEST_LLM_API_KEY;
  }
});

test('testAnthropicProviderReturnsStructuredResponse', async () => {
  process.env.TEST_LLM_API_KEY = 'test-key';
  const provider = new AnthropicProvider(ANTHROPIC_CONFIG);

  mockFetchSuccess({
    content: [{ type: 'text', text: 'Hello from Anthropic' }],
    usage: { input_tokens: 10, output_tokens: 5 },
  });

  try {
    const result = await provider.complete({
      model: 'claude-3',
      messages: [{ role: 'user', content: 'Hello' }],
      temperature: 0.7,
      max_tokens: 100,
    });

    assert.strictEqual(result.content, 'Hello from Anthropic');
    assert.strictEqual(result.tokens_used, 15);
    assert.ok(result.duration_ms >= 0);
  } finally {
    restoreFetch();
    delete process.env.TEST_LLM_API_KEY;
  }
});

test('testAnthropicProviderSeparatesSystemMessage', async () => {
  process.env.TEST_LLM_API_KEY = 'test-key';
  const provider = new AnthropicProvider(ANTHROPIC_CONFIG);

  let capturedBody: Record<string, unknown> = {};
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url: RequestInfo | URL, init?: RequestInit) => {
    capturedBody = JSON.parse(init?.body as string);
    return new Response(
      JSON.stringify({
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  };

  try {
    await provider.complete({
      model: 'claude-3',
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hi' },
      ],
      temperature: 0.5,
      max_tokens: 50,
    });

    assert.strictEqual(capturedBody.system, 'You are helpful.');
    assert.deepStrictEqual(capturedBody.messages, [{ role: 'user', content: 'Hi' }]);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.TEST_LLM_API_KEY;
  }
});

test('testAnthropicProviderSendsCorrectHeaders', async () => {
  process.env.TEST_LLM_API_KEY = 'my-anthropic-key';
  const provider = new AnthropicProvider(ANTHROPIC_CONFIG);

  let capturedHeaders: Record<string, string> = {};
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url: RequestInfo | URL, init?: RequestInit) => {
    capturedHeaders = Object.fromEntries(new Headers(init?.headers as HeadersInit).entries());
    return new Response(
      JSON.stringify({ content: [{ type: 'text', text: '' }], usage: { input_tokens: 1, output_tokens: 1 } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  };

  try {
    await provider.complete({
      model: 'claude-3',
      messages: [{ role: 'user', content: 'test' }],
      temperature: 0.5,
      max_tokens: 10,
    });

    assert.strictEqual(capturedHeaders['x-api-key'], 'my-anthropic-key');
    assert.ok(capturedHeaders['anthropic-version']);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.TEST_LLM_API_KEY;
  }
});

test('testAnthropicProviderThrowsOnApiError', async () => {
  process.env.TEST_LLM_API_KEY = 'test-key';
  const provider = new AnthropicProvider(ANTHROPIC_CONFIG);

  mockFetchError(401, 'Unauthorized');

  try {
    await assert.rejects(
      () => provider.complete({
        model: 'claude-3',
        messages: [{ role: 'user', content: 'Hello' }],
        temperature: 0.7,
        max_tokens: 100,
      }),
      /Anthropic API request failed: 401/
    );
  } finally {
    restoreFetch();
    delete process.env.TEST_LLM_API_KEY;
  }
});

test('testAnthropicProviderThrowsOnMissingKey', async () => {
  delete process.env.TEST_LLM_API_KEY;
  delete process.env.SLE_LLM_API_KEY;
  assert.throws(
    () => new AnthropicProvider(ANTHROPIC_CONFIG),
    /API key not found/
  );
});

test('testCreateLLMProviderReturnsCorrectType', async () => {
  process.env.TEST_LLM_API_KEY = 'test-key';
  const openai = createLLMProvider(TEST_CONFIG);
  assert.ok(openai instanceof OpenAICompatibleProvider);

  const anthropic = createLLMProvider(ANTHROPIC_CONFIG);
  assert.ok(anthropic instanceof AnthropicProvider);

  const glm = createLLMProvider({
    provider: 'glm',
    base_url: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4',
    api_key_env: 'TEST_LLM_API_KEY'
  });
  assert.ok(glm instanceof OpenAICompatibleProvider);

  const openrouter = createLLMProvider({
    provider: 'openrouter',
    base_url: 'https://openrouter.ai/api/v1',
    model: 'google/gemini-2.5-pro',
    api_key_env: 'TEST_LLM_API_KEY'
  });
  assert.ok(openrouter instanceof OpenAICompatibleProvider);

  delete process.env.TEST_LLM_API_KEY;
});

test('testDynamicLLMProviderDelegatesAndSwaps', async () => {
  const mock1: ILLMProvider = {
    complete: async () => ({ content: 'response-1', tokens_used: 10, duration_ms: 50 })
  };
  const mock2: ILLMProvider = {
    complete: async () => ({ content: 'response-2', tokens_used: 20, duration_ms: 100 })
  };

  const dynamicProvider = new DynamicLLMProvider(mock1);
  const res1 = await dynamicProvider.complete({
    model: 'test',
    messages: [{ role: 'user', content: 'hello' }],
    temperature: 0.5,
    max_tokens: 10
  });
  assert.strictEqual(res1.content, 'response-1');
  assert.strictEqual(dynamicProvider.getProvider(), mock1);

  dynamicProvider.setProvider(mock2);
  const res2 = await dynamicProvider.complete({
    model: 'test',
    messages: [{ role: 'user', content: 'hello' }],
    temperature: 0.5,
    max_tokens: 10
  });
  assert.strictEqual(res2.content, 'response-2');
  assert.strictEqual(dynamicProvider.getProvider(), mock2);
});

test('testCreateLLMProviderThrowsOnUnknownProvider', async () => {
  assert.throws(
    () => createLLMProvider({ provider: 'unknown' as 'openai_compatible', api_key_env: 'KEY', model: 'm' }),
    /Unknown LLM provider/
  );
});

test('testLLMCompletionParamsSchema', async () => {
  const valid = {
    model: 'gpt-4o',
    messages: [{ role: 'system' as const, content: 'You are helpful' }],
    temperature: 0.7,
    max_tokens: 100,
  };
  const result = LLMCompletionParamsSchema.safeParse(valid);
  assert(result.success, 'Valid params should pass');

  const invalidRole = {
    model: 'gpt-4o',
    messages: [{ role: 'invalid', content: 'hi' }],
    temperature: 0.7,
    max_tokens: 100,
  };
  const result2 = LLMCompletionParamsSchema.safeParse(invalidRole);
  assert(!result2.success, 'Invalid role should fail');

  const noMessages = {
    model: 'gpt-4o',
    messages: [],
    temperature: 0.7,
    max_tokens: 100,
  };
  const result3 = LLMCompletionParamsSchema.safeParse(noMessages);
  assert(!result3.success, 'Empty messages should fail');
});

test('testLLMCompletionResultSchema', async () => {
  const valid = { content: 'hello', tokens_used: 10, duration_ms: 100 };
  const result = LLMCompletionResultSchema.safeParse(valid);
  assert(result.success, 'Valid result should pass');

  const negativeTokens = { content: 'hello', tokens_used: -1, duration_ms: 100 };
  const result2 = LLMCompletionResultSchema.safeParse(negativeTokens);
  assert(!result2.success, 'Negative tokens_used should fail');
});
