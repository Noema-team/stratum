import assert from 'node:assert/strict';
import test from 'node:test';
import { clearPendingAgentPrompt, readPendingAgentPrompt, savePendingAgentPrompt, type StringStorage } from '../web/src/agent-session-prompt.js';

test('browser prompt retry keeps the same key and text after an accepted response is lost', () => {
  const values = new Map<string, string>();
  const storage: StringStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } };
  const prompt = { sessionId: 'session-1', key: 'key-1', text: 'Inspect the readme' };
  savePendingAgentPrompt(storage, prompt);

  // Simulate browser reload after the server accepted the first request but its response was lost.
  const afterReload = readPendingAgentPrompt(storage, 'session-1');
  assert.deepEqual(afterReload, prompt);
  let dispatches = 0;
  const idempotentServer = new Map<string, string>();
  const accept = (key: string, text: string) => { if (idempotentServer.has(key)) return idempotentServer.get(key); idempotentServer.set(key, text); dispatches++; return text; };
  accept(prompt.key, prompt.text); // First request reaches the server; its response is lost.
  const retry = readPendingAgentPrompt(storage, 'session-1')!;
  accept(retry.key, retry.text);
  assert.deepEqual(idempotentServer.get(prompt.key), prompt.text);
  assert.equal(dispatches, 1);

  clearPendingAgentPrompt(storage, 'session-1');
  assert.equal(readPendingAgentPrompt(storage, 'session-1'), null);
});
