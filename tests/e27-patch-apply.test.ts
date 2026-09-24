// E27 unit pins for the strict zero-fuzz unified-diff applier.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { applyUnifiedDiff, PatchApplyError } from '../src/patch.js';

const D = (lines: string[]): string => lines.join('\n') + '\n';

test('patch: insertion between context lines applies exactly', () => {
  const out = applyUnifiedDiff('a\nb\nc\n', D([
    '--- a/f', '+++ b/f', '@@ -1,3 +1,4 @@', ' a', '+bb', ' b', ' c',
  ]));
  assert.equal(out, 'a\nbb\nb\nc\n');
});

test('patch: removal + replacement in one hunk', () => {
  const out = applyUnifiedDiff('one\ntwo\nthree\n', D([
    '--- a/f', '+++ b/f', '@@ -1,3 +1,3 @@', ' one', '-two', '+TWO', ' three',
  ]));
  assert.equal(out, 'one\nTWO\nthree\n');
});

test('patch: multiple hunks in order', () => {
  const out = applyUnifiedDiff('l1\nl2\nl3\nl4\nl5\n', D([
    '--- a/f', '+++ b/f', '@@ -1,2 +1,2 @@', ' l1', '-l2', '+L2',
    '@@ -4,2 +4,3 @@', ' l4', ' l5', '+l6',
  ]));
  assert.equal(out, 'l1\nL2\nl3\nl4\nl5\nl6\n');
});

test('patch: no-newline markers handled on both sides', () => {
  // old file lacks trailing newline; new file gains one (context line last)
  const out = applyUnifiedDiff('x', D([
    '--- a/f', '+++ b/f', '@@ -1 +1 @@', '-x', '\\ No newline at end of file', '+x',
  ]));
  assert.equal(out, 'x\n');
  // old has newline, new loses it
  const out2 = applyUnifiedDiff('x\n', D([
    '--- a/f', '+++ b/f', '@@ -1 +1 @@', '-x', '+x', '\\ No newline at end of file',
  ]));
  assert.equal(out2, 'x');
});

test('patch: overlapping hunks fail closed', () => {
  assert.throws(() => applyUnifiedDiff('a\nb\nc\n', D([
    '--- a/f', '+++ b/f', '@@ -1,3 +1,3 @@', ' a', '-b', '+B', ' c', '@@ -2,2 +2,2 @@', '-c', '+C',
  ])), PatchApplyError);
});

test('patch: wrong line counts fail closed', () => {
  assert.throws(() => applyUnifiedDiff('a\nb\n', D([
    '--- a/f', '+++ b/f', '@@ -1,3 +1,3 @@', ' a', ' b',
  ])), PatchApplyError);
});

test('patch: context mismatch names the exact original line', () => {
  assert.throws(() => applyUnifiedDiff('a\nX\nc\n', D([
    '--- a/f', '+++ b/f', '@@ -1,3 +1,3 @@', ' a', '-b', '+B', ' c',
  ])), (err: unknown) => {
    assert.ok(err instanceof PatchApplyError);
    assert.match(err.message, /original line 2 is 'X'/);
    return true;
  });
});

test('patch: empty diff and non-diff content fail closed', () => {
  assert.throws(() => applyUnifiedDiff('a\n', ''), PatchApplyError);
  assert.throws(() => applyUnifiedDiff('a\n', 'just some prose\n'), PatchApplyError);
});
