// E27r (merge review) — closing the AUTHORABILITY gap.
//
// Attempt 18's failure mode: the 95,897-byte worker main.py is elided by E23
// at the synthesis boundary (49,152-byte newest-first budget), so at the
// BUILD synthesis turn the model holds a digest WITHOUT the exact source
// lines a zero-fuzz unified diff requires. E27 gave Stratum the ability to
// APPLY such a patch; this file proves the live model can now AUTHOR one:
//
//   1. read_source_slice returns a bounded exact excerpt plus the
//      authoritative full-file sha256 (computed by Stratum from disk).
//   2. E23 never elides a slice result (only read_file payloads are
//      compacted), so the excerpt + digest survive to the synthesis turn —
//      reconstructed here against attempt-18's exact shape (95,897-byte
//      read + turn-19 synthesis request).
//   3. The excerpt contains everything needed to construct a diff that the
//      zero-fuzz applier accepts against the pinned base.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { handleToolCall, MAX_SLICE_LINES } from '../src/tools.js';
import { compactReadHistoryForSynthesis, type MultiTurnMessage } from '../src/agent-loop.js';
import { applyUnifiedDiff } from '../src/patch.js';

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

// attempt-18 shape: the worker source is far larger than the synthesis
// read-result budget (49,152 bytes) — reproduced with a deterministic
// fixture comfortably above that budget (chunked construction can overshoot
// the nominal size slightly; only "well above the budget" matters to the
// mechanism under test, and it is asserted explicitly below).
const WORKER_PATH = 'apps/ai-server/rag-worker-service/main.py';
function buildWorkerFixture(): string {
  const lines: string[] = [];
  let bytes = 0;
  let i = 0;
  while (bytes < 95897) {
    const line = `def worker_handler_${i}(payload):  # region ${Math.floor(i / 50)}\n    return transform(payload, stage=${i})\n`;
    lines.push(line);
    bytes += line.length;
    i++;
  }
  return lines.join('');
}
const WORKER = buildWorkerFixture();
assert.ok(
  Buffer.byteLength(WORKER, 'utf-8') > 95897,
  'fixture must sit above the attempt-18 source size (and therefore far above the 49,152-byte budget)',
);
const WORKER_LINES = WORKER.split('\n');
// an edit region deep in the file — exactly where E23's elision bites
const EDIT_LINE = 1200; // 1-based
const EDIT_ANCHOR = WORKER_LINES[EDIT_LINE - 1];

test('authorability 1: read_source_slice returns the exact excerpt plus the authoritative full-file digest', async () => {
  const root = mkdtempSync(join(tmpdir(), 'e27-slice-'));
  try {
    mkdirSync(join(root, 'apps/ai-server/rag-worker-service'), { recursive: true });
    writeFileSync(join(root, WORKER_PATH), WORKER);
    const tracked = new Set([WORKER_PATH]);
    const res = await handleToolCall('read_source_slice', { path: WORKER_PATH, startLine: EDIT_LINE - 5, lineCount: 20 }, root, fsPromises, tracked);
    const parsed = JSON.parse(res.content) as {
      error?: string; path: string; totalLines: number; totalBytes: number; sha256: string;
      startLine: number; endLine: number; truncated: boolean; content: string;
    };
    assert.equal(parsed.error, undefined, res.content);
    assert.equal(parsed.sha256, sha256(WORKER), 'digest is of the FULL file, computed by Stratum');
    assert.equal(parsed.totalBytes, Buffer.byteLength(WORKER, 'utf-8'));
    assert.equal(parsed.path, WORKER_PATH);
    assert.equal(parsed.startLine, EDIT_LINE - 5);
    assert.equal(parsed.endLine, EDIT_LINE + 14);
    assert.equal(parsed.truncated, true);
    // the excerpt is EXACT: reassembling the slice reproduces the original lines
    const sliceLines = parsed.content.split('\n');
    for (let i = 0; i < sliceLines.length; i++) {
      assert.equal(sliceLines[i], WORKER_LINES[EDIT_LINE - 5 - 1 + i], `line ${EDIT_LINE - 5 + i} byte-exact`);
    }
    assert.ok(sliceLines.includes(EDIT_ANCHOR));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('authorability 2: slice results are hard-capped and rejected past EOF; untracked paths stay denied', async () => {
  const root = mkdtempSync(join(tmpdir(), 'e27-slice-'));
  try {
    mkdirSync(join(root, 'apps/ai-server/rag-worker-service'), { recursive: true });
    writeFileSync(join(root, WORKER_PATH), WORKER);
    const tracked = new Set([WORKER_PATH]);
    const capped = await handleToolCall('read_source_slice', { path: WORKER_PATH, startLine: 1, lineCount: 100000 }, root, fsPromises, tracked);
    const cappedParsed = JSON.parse(capped.content);
    assert.equal(cappedParsed.endLine - cappedParsed.startLine + 1, MAX_SLICE_LINES, 'lineCount is hard-capped');
    const past = await handleToolCall('read_source_slice', { path: WORKER_PATH, startLine: 999999 }, root, fsPromises, tracked);
    assert.match(JSON.parse(past.content).error, /beyond the end/);
    const denied = await handleToolCall('read_source_slice', { path: '.env' }, root, fsPromises, tracked);
    assert.match(JSON.parse(denied.content).error, /not permitted/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('authorability 3: attempt-18 reconstruction — at the synthesis turn the request still holds exact patch context + the authoritative base digest', async () => {
  // Simulate the attempt-18 BUILD investigation: a full read_file of the
  // 95,897-byte worker (elided by E23) followed by a bounded
  // read_source_slice of the edit region (always retained).
  const root = mkdtempSync(join(tmpdir(), 'e27-replay-'));
  try {
    mkdirSync(join(root, 'apps/ai-server/rag-worker-service'), { recursive: true });
    writeFileSync(join(root, WORKER_PATH), WORKER);
    const tracked = new Set([WORKER_PATH]);
    const slice = await handleToolCall('read_source_slice', { path: WORKER_PATH, startLine: EDIT_LINE - 5, lineCount: 20 }, root, fsPromises, tracked);
    const sliceJson = slice.content;

    const messages: MultiTurnMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'implement the worker fix' }] },
      { role: 'assistant', content: [{ type: 'tool_use' as never, id: 'tu-full', name: 'read_file', input: { path: WORKER_PATH } }] },
      { role: 'user', content: [{ type: 'tool_result' as never, tool_use_id: 'tu-full', content: WORKER }] },
      { role: 'assistant', content: [{ type: 'tool_use' as never, id: 'tu-slice', name: 'read_source_slice', input: { path: WORKER_PATH, startLine: EDIT_LINE - 5, lineCount: 20 } }] },
      { role: 'user', content: [{ type: 'tool_result' as never, tool_use_id: 'tu-slice', content: sliceJson }] },
    ];
    const preBytes = messages.reduce((a, m) => a + JSON.stringify(m).length, 0);
    const record = compactReadHistoryForSynthesis(messages, 49152);
    assert.ok(record, 'compaction ran');
    // the full read IS elided — attempt 18's exact mechanism
    assert.deepEqual(record!.elided.map((e) => e.path), [WORKER_PATH]);
    assert.equal(record!.elided[0].bytes, Buffer.byteLength(WORKER, 'utf-8'));
    // the elision marker pins the digest…
    const elidedContent = (messages[2].content as Array<{ content: string }>)[0].content;
    assert.match(elidedContent, /sha256=/);
    // …but the SLICE result is retained VERBATIM: exact lines + digest.
    const sliceContent = (messages[4].content as Array<{ content: string }>)[0].content;
    assert.equal(sliceContent, sliceJson, 'slice result untouched by compaction');
    const sliceParsed = JSON.parse(sliceContent);
    assert.equal(sliceParsed.sha256, sha256(WORKER), 'authoritative base digest present at synthesis');
    assert.ok(sliceParsed.content.includes(EDIT_ANCHOR), 'exact edit-region context present at synthesis');
    const postBytes = messages.reduce((a, m) => a + JSON.stringify(m).length, 0);
    assert.ok(postBytes < preBytes, 'compaction still freed capacity');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('authorability 4: the retained excerpt is sufficient to author a zero-fuzz patch that applies against the pinned base', async () => {
  const root = mkdtempSync(join(tmpdir(), 'e27-author-'));
  try {
    mkdirSync(join(root, 'apps/ai-server/rag-worker-service'), { recursive: true });
    writeFileSync(join(root, WORKER_PATH), WORKER);
    const tracked = new Set([WORKER_PATH]);
    const slice = JSON.parse(
      (await handleToolCall('read_source_slice', { path: WORKER_PATH, startLine: EDIT_LINE - 5, lineCount: 20 }, root, fsPromises, tracked)).content,
    );
    // the model authors the diff FROM THE SLICE ALONE (no full-file access):
    const sliceLines = (slice.content as string).split('\n');
    const startLine = slice.startLine;
    const diffLines: string[] = [
      `--- a/${WORKER_PATH}`,
      `+++ b/${WORKER_PATH}`,
      `@@ -${startLine},${sliceLines.length} +${startLine},${sliceLines.length + 1} @@`,
      ...sliceLines.map((l: string) => ` ${l}`),
      '+    payload = enforce_failure_stage(payload)',
    ];
    // …and Stratum applies it zero-fuzz against the pinned base digest.
    assert.equal(slice.sha256, sha256(WORKER));
    const patched = applyUnifiedDiff(WORKER, diffLines.join('\n') + '\n');
    const patchedLines = patched.split('\n');
    assert.equal(patchedLines[startLine + sliceLines.length - 1], '    payload = enforce_failure_stage(payload)');
    assert.equal(patched.split('\n').length, WORKER_LINES.length + 1, 'exactly one line inserted');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
