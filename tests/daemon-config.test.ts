import { strict as assert } from 'node:assert';
import { parseCLIArgs } from '../src/daemon-config.js';

async function testParseStartWithNoOpen() {
  const args = ['node', 'cli.js', 'start', '--port', '8080', '--foreground', '--no-open'];
  const result = parseCLIArgs(args);
  assert.strictEqual(result.command, 'start');
  assert.strictEqual(result.port, 8080);
  assert.strictEqual(result.foreground, true);
  assert.strictEqual(result.noOpen, true);
}

async function testParseStartWithoutNoOpen() {
  const args = ['node', 'cli.js', 'start', '--foreground'];
  const result = parseCLIArgs(args);
  assert.strictEqual(result.command, 'start');
  assert.strictEqual(result.foreground, true);
  assert.strictEqual(result.noOpen, undefined);
}

async function runAllTests() {
  const tests = [
    { name: 'parseStart parses --no-open flag correctly', fn: testParseStartWithNoOpen },
    { name: 'parseStart works without --no-open flag', fn: testParseStartWithoutNoOpen },
  ];

  const failures: Array<{ name: string; error: unknown }> = [];

  for (const test of tests) {
    try {
      await test.fn();
      console.log(`  ✓ ${test.name}`);
    } catch (error) {
      console.error(`  ✗ ${test.name}`);
      failures.push({ name: test.name, error });
    }
  }

  if (failures.length > 0) {
    console.error(`\n❌ ${failures.length}/${tests.length} daemon-config tests FAILED:`);
    for (const f of failures) {
      console.error(`  - ${f.name}: ${f.error}`);
    }
    throw failures[0].error;
  }

  console.log(`\n✅ All ${tests.length} daemon-config tests passed!`);
}

runAllTests();
