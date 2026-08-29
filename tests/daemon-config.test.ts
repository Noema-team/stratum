import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseCLIArgs } from '../src/daemon-config.js';

test('testParseStartWithNoOpen', async () => {
  const args = ['node', 'cli.js', 'start', '--port', '8080', '--foreground', '--no-open'];
  const result = parseCLIArgs(args);
  assert.strictEqual(result.command, 'start');
  assert.strictEqual(result.port, 8080);
  assert.strictEqual(result.foreground, true);
  assert.strictEqual(result.noOpen, true);
});

test('testParseStartWithoutNoOpen', async () => {
  const args = ['node', 'cli.js', 'start', '--foreground'];
  const result = parseCLIArgs(args);
  assert.strictEqual(result.command, 'start');
  assert.strictEqual(result.foreground, true);
  assert.strictEqual(result.noOpen, undefined);
});
