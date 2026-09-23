// E27r (merge review) — patch TRANSPORT tightening: the diff payload is
// preserved byte-for-byte (never trimmed), patch cardinality and size are
// bounded, and only the literal "\ No newline at end of file" marker is
// accepted.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { parseAgentOutputV3 } from '../src/output-parser.js';
import { applyUnifiedDiff, PatchApplyError } from '../src/patch.js';

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

function envelopeWithPatches(patches: string[]): string {
  return `<<<SLE-OUTPUT>>>\n${patches.join('\n')}\n<<<END-SLE-OUTPUT>>>`;
}

test('transport: a trailing-whitespace "+" line survives parsing byte-for-byte (no trim)', () => {
  const diff = [
    '--- a/src/x.py',
    '+++ b/src/x.py',
    '@@ -1,2 +1,3 @@',
    ' A = 1',
    '+    ',
    ' B = 2',
  ].join('\n');
  const raw = envelopeWithPatches([
    `<<<SLE-PATCH path="src/x.py" base="${sha256('A = 1\nB = 2\n')}">>>\n${diff}\n<<<END-SLE-PATCH>>>`,
  ]);
  const parsed = parseAgentOutputV3(raw, 'builder');
  assert.ok(parsed.patches, 'patch parsed');
  // the '+    ' line keeps its four trailing spaces — trimming it would turn
  // a meaningful (whitespace-only) added line into an empty addition
  assert.ok(parsed.patches![0].diff.includes('+    \n'), 'trailing whitespace preserved');
  // and the applier reproduces it exactly
  const out = applyUnifiedDiff('A = 1\nB = 2\n', parsed.patches![0].diff);
  assert.equal(out, 'A = 1\n    \nB = 2\n');
});

test('transport: interior blank lines in the payload are preserved (leading blank kept verbatim)', () => {
  const diff = [
    '',
    '--- a/src/x.py',
    '+++ b/src/x.py',
    '@@ -1,1 +1,2 @@',
    ' A = 1',
    '+B = 2',
  ].join('\n');
  const raw = envelopeWithPatches([
    `<<<SLE-PATCH path="src/x.py" base="${sha256('A = 1\n')}">>>\n${diff}\n<<<END-SLE-PATCH>>>`,
  ]);
  const parsed = parseAgentOutputV3(raw, 'builder');
  assert.ok(parsed.patches![0].diff.startsWith('\n--- a/src/x.py'), 'leading blank line preserved');
  // ... and the applier tolerates the leading blank before the headers
  const out = applyUnifiedDiff('A = 1\n', parsed.patches![0].diff);
  assert.equal(out, 'A = 1\nB = 2\n');
});

test('transport: patch count is bounded together with sections (no unbounded side channel)', () => {
  const patches: string[] = [];
  for (let i = 0; i < 21; i++) {
    const p = `src/f${i}.py`;
    patches.push(
      `<<<SLE-PATCH path="${p}" base="${sha256(`A = ${i}\n`)}">>>\n--- a/${p}\n+++ b/${p}\n@@ -1,1 +1,2 @@\n A = ${i}\n+B = ${i}\n<<<END-SLE-PATCH>>>`,
    );
    // files need not exist for the COUNT bound — parsing happens first
  }
  assert.throws(() => parseAgentOutputV3(envelopeWithPatches(patches), 'builder'), /more than 20 sections\+patches/);
});

test('transport: an oversize patch payload is rejected at parse time', () => {
  const filler = '+' + 'x'.repeat(40 * 1024); // > 32 KB single-line addition
  const diff = ['--- a/src/big.py', '+++ b/src/big.py', '@@ -1,1 +1,2 @@', ' A = 1', filler].join('\n');
  const raw = envelopeWithPatches([
    `<<<SLE-PATCH path="src/big.py" base="${sha256('A = 1\n')}">>>\n${diff}\n<<<END-SLE-PATCH>>>`,
  ]);
  assert.throws(() => parseAgentOutputV3(raw, 'builder'), /32 KB/);
});

test('patch: a malformed no-newline marker is rejected — only the exact literal is accepted', () => {
  const good = ['--- a/f', '+++ b/f', '@@ -1 +1 @@', '-x', '+x'].join('\n') + '\n';
  const withBadMarker = ['--- a/f', '+++ b/f', '@@ -1 +1 @@', '-x', '\\ No newline at end of file (git)', '+y', '+x'].join('\n') + '\n';
  assert.throws(() => applyUnifiedDiff('x\n', withBadMarker), PatchApplyError);
  assert.doesNotThrow(() => applyUnifiedDiff('x\n', good));
  // the exact literal in the post-hunk position still works
  const postHunk = ['--- a/f', '+++ b/f', '@@ -1 +1 @@', '-x', '+x', '\\ No newline at end of file'].join('\n') + '\n';
  assert.equal(applyUnifiedDiff('x\n', postHunk), 'x');
  // an arbitrary '\'-led line AFTER the hunk is malformed too
  const postHunkBad = ['--- a/f', '+++ b/f', '@@ -1 +1 @@', '-x', '+x', '\\ odd marker'].join('\n') + '\n';
  assert.throws(() => applyUnifiedDiff('x\n', postHunkBad), PatchApplyError);
});
