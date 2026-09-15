// E3b — glm multi-turn opt-in + multi-turn sampling parity.
//
// Pins: the 'glm' provider kind exposes completeMultiTurn (E2 evidence: the
// series degraded glm to the single-turn wire — 15/15 reasoning-budget
// TRANSPORT exhaustion; probe evidence: the Z.ai endpoint executes the
// multi-turn wire correctly on the exact request shape), the multi-turn wire
// carries temperature when the caller sets it (sampling parity with the
// single-turn/structured wires — C6 review closure 3 semantics), and the
// legacy wire shape (temperature unset) stays byte-for-byte unchanged.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLLMProvider } from '../src/llm-provider.js';

test('E3b: the glm provider kind opts into the multi-turn tool wire', () => {
  const root = mkdtempSync(join(tmpdir(), 'e3b-'));
  try {
    const originalKey = process.env.GLM_API_KEY;
    process.env.GLM_API_KEY = 'test-key-for-capability-probe';
    try {
      const provider = createLLMProvider({
        provider: 'glm',
        model: 'glm-5.3-flash',
        api_key_env: 'GLM_API_KEY',
      });
      assert.equal(
        typeof (provider as { completeMultiTurn?: unknown }).completeMultiTurn,
        'function',
        'glm must expose completeMultiTurn (capability probe must pass)',
      );
    } finally {
      if (originalKey === undefined) delete process.env.GLM_API_KEY;
      else process.env.GLM_API_KEY = originalKey;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('E3b: the multi-turn wire forwards the runner temperature (sampling parity)', async () => {
  const realFetch = globalThis.fetch;
  let capturedBody: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
    capturedBody = JSON.parse(init.body);
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'done' }, finish_reason: 'stop' }],
        usage: { total_tokens: 1 },
      }),
    } as unknown as Response;
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
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'done' }, finish_reason: 'stop' }],
        usage: { total_tokens: 1 },
      }),
    } as unknown as Response;
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
