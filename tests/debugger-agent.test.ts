/**
 * Phase E: DEBUGGER node — role mapping and output path validation.
 *
 * Verifies that DEBUGGER is correctly wired as the 'debugger' agent role,
 * that the debugger role may write to source/test/script paths, and that
 * MAX_DEBUG_ATTEMPTS is set to the expected value.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { roleForNode, validateOutputPath } from '../src/agent-runner.js';
import { MAX_DEBUG_ATTEMPTS } from '../src/cycle-runner.js';

console.log('# Running Phase E (DEBUGGER agent) tests...');

test('Phase E: roleForNode(DEBUGGER) resolves to debugger role', () => {
  assert.strictEqual(roleForNode('DEBUGGER'), 'debugger');
});

test('Phase E: debugger role may write to src/', () => {
  assert.strictEqual(validateOutputPath('src/index.ts', 'debugger'), true);
  assert.strictEqual(validateOutputPath('src/utils/helpers.ts', 'debugger'), true);
});

test('Phase E: debugger role may write to tests/', () => {
  assert.strictEqual(validateOutputPath('tests/unit.test.ts', 'debugger'), true);
  assert.strictEqual(validateOutputPath('tests/integration/api.test.ts', 'debugger'), true);
});

test('Phase E: debugger role may write to scripts/', () => {
  assert.strictEqual(validateOutputPath('scripts/deploy.sh', 'debugger'), true);
  assert.strictEqual(validateOutputPath('scripts/build.sh', 'debugger'), true);
});

test('Phase E: debugger role may write to .sle/runs/', () => {
  assert.strictEqual(validateOutputPath('.sle/runs/1-1/debugger.md', 'debugger'), true);
});

test('Phase E: debugger role may NOT write to docs/', () => {
  assert.strictEqual(validateOutputPath('docs/requirements.md', 'debugger'), false);
  assert.strictEqual(validateOutputPath('docs/architecture.md', 'debugger'), false);
  assert.strictEqual(validateOutputPath('docs/plan.md', 'debugger'), false);
});

test('Phase E: MAX_DEBUG_ATTEMPTS constant is 3', () => {
  assert.strictEqual(MAX_DEBUG_ATTEMPTS, 3);
});

console.log('# ✅ All Phase E (DEBUGGER agent) tests passed!');
