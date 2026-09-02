/**
 * Phase A (VS7): DEBUG node — role mapping and output path validation.
 *
 * Verifies that the DEBUG node is correctly wired as the 'debugger' agent role
 * and that the debugger role may write to source/test/script paths.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { validateOutputPath } from '../src/agent-runner.js';

console.log('# Running Phase A (DEBUG agent) tests...');

test('Phase A: debugger role may write to src/', () => {
  assert.strictEqual(validateOutputPath('src/index.ts', 'debugger'), true);
  assert.strictEqual(validateOutputPath('src/utils/helpers.ts', 'debugger'), true);
});

test('Phase A: debugger role may write to tests/', () => {
  assert.strictEqual(validateOutputPath('tests/unit.test.ts', 'debugger'), true);
  assert.strictEqual(validateOutputPath('tests/integration/api.test.ts', 'debugger'), true);
});

test('Phase A: debugger role may write to scripts/', () => {
  assert.strictEqual(validateOutputPath('scripts/deploy.sh', 'debugger'), true);
  assert.strictEqual(validateOutputPath('scripts/build.sh', 'debugger'), true);
});

test('Phase A: debugger role may write to .sle/runs/', () => {
  assert.strictEqual(validateOutputPath('.sle/runs/1-1/debugger.md', 'debugger'), true);
});

test('Phase A: debugger role may NOT write to docs/', () => {
  assert.strictEqual(validateOutputPath('docs/requirements.md', 'debugger'), false);
  assert.strictEqual(validateOutputPath('docs/architecture.md', 'debugger'), false);
  assert.strictEqual(validateOutputPath('docs/plan.md', 'debugger'), false);
});

console.log('# ✅ All Phase A (DEBUG agent) tests passed!');
