// E3b — multi-turn wire coverage (the wire class the 'glm' provider kind
// used to reach; E11 removed the Coding Plan provider, so the factory-level
// test below now pins its REMOVAL while the wire itself stays covered via
// the direct OpenAICompatibleMultiTurnProvider constructions below and the
// 'openrouter' factory case).
//
// Pins: 'glm' is rejected by the factory (E11 removal — fail closed, never a
// silent fallback), the multi-turn wire carries temperature when the caller
// sets it (sampling parity with the single-turn/structured wires — C6 review
// closure 3 semantics), and the legacy wire shape (temperature unset) stays
// byte-for-byte unchanged. NOTE (transport-hardening PR): the multi-turn wire
// now streams (`stream: true`) — stubs speak SSE via tests/sse-test-utils.ts.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLLMProvider } from '../src/llm-provider.js';
import { sseResponse, chunk } from './sse-test-utils.js';

test('E11: the glm (Z.ai Coding Plan) provider kind is rejected by the factory', () => {
  const root = mkdtempSync(join(tmpdir(), 'e3b-'));
  try {
    assert.throws(
      () =>
        createLLMProvider({
          provider: 'glm' as never,
          model: 'glm-5.3-flash',
          api_key_env: 'GLM_API_KEY',
        }),
      /Unknown LLM provider: glm/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('E3b: the multi-turn wire forwards the runner temperature (sampling parity)', async () => {
  const realFetch = globalThis.fetch;
  let capturedBody: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
    capturedBody = JSON.parse(init.body);
    return sseResponse([chunk({ content: 'done' }, 'stop', { total_tokens: 1 }), '[DONE]']);
  }) as typeof fetch;
  try {
    const { OpenAICompatibleMultiTurnProvider } = await import('../src/llm-provider.js');
    process.env.E3B_TEST_API_KEY = 'test-key';
    const provider = new OpenAICompatibleMultiTurnProvider({
      provider: 'openai_compatible',
      base_url: 'https://example.invalid/v1',
      model: 'm',
      api_key_env: 'E3B_TEST_API_KEY',
    } as never);
    await provider.completeMultiTurn({
      model: 'm',
      system: 's',
      messages: [{ role: 'user', content: 'u' }],
      max_tokens: 16,
      temperature: 0.7,
      tools: [],
    });
    assert.ok(capturedBody, 'the wire call must happen');
    assert.equal(capturedBody!.temperature, 0.7, 'the multi-turn wire must carry temperature');
  } finally {
    delete process.env.E3B_TEST_API_KEY;
    globalThis.fetch = realFetch;
  }
});

test('E3b: temperature absent on the multi-turn wire keeps legacy byte-for-byte behavior', async () => {
  const realFetch = globalThis.fetch;
  let capturedBody: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
    capturedBody = JSON.parse(init.body);
    return sseResponse([chunk({ content: 'done' }, 'stop', { total_tokens: 1 }), '[DONE]']);
  }) as typeof fetch;
  try {
    const { OpenAICompatibleMultiTurnProvider } = await import('../src/llm-provider.js');
    process.env.E3B_TEST_API_KEY = 'test-key';
    const provider = new OpenAICompatibleMultiTurnProvider({
      provider: 'openai_compatible',
      base_url: 'https://example.invalid/v1',
      model: 'm',
      api_key_env: 'E3B_TEST_API_KEY',
    } as never);
    await provider.completeMultiTurn({
      model: 'm',
      system: 's',
      messages: [{ role: 'user', content: 'u' }],
      max_tokens: 16,
      tools: [],
    });
    assert.equal(
      'temperature' in (capturedBody ?? {}),
      false,
      'legacy wire shape: no temperature key when unset',
    );
  } finally {
    delete process.env.E3B_TEST_API_KEY;
    globalThis.fetch = realFetch;
  }
});
