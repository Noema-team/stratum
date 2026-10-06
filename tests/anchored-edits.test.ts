// BUILD Edit Protocol v1 — anchored-edit primitive + contract validation/staging.
//
// Zero-model qualification per docs/specs/build-edit-protocol-v1.md §7(2).
// Includes the campaign regression-impossibility pins: V9-1 (model-supplied
// hunk counts), V9-3 (model-supplied oldStart positions), V11-2 (truncated
// SLE-PATCH transport marker) must be structurally unrepresentable.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';

import {
  mintAnchorId,
  anchorRecordFromSliceResult,
  AnchorRegistry,
  spliceLineSpan,
  spansOverlap,
  renderSpanDiff,
  renderCreatedFileDiff,
} from '../src/workflow/anchored-edits.js';
import {
  createBuildChangesetActionContract,
  BuildEditProposalSchema,
  BUILD_CHANGESET_ARTIFACT_TYPE,
} from '../src/workflow/methodology/build-changeset-contract.js';

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

// ─── Anchor minting + registry scoping ────────────────────────────────────────

const RECORD = {
  path: 'apps/ai-server/rag-worker-service/main.py',
  base_sha256: sha256('DEFAULT_FAILURE_STAGE = "consume"\n\n\ndef process_document(doc):\n    return doc\n'),
  start_line: 1,
  end_line: 1,
  content_sha256: sha256('DEFAULT_FAILURE_STAGE = "consume"'),
};

test('P1.1: anchor ids are deterministic and distinct per binding', () => {
  const a = mintAnchorId(RECORD);
  const b = mintAnchorId({ ...RECORD });
  assert.equal(a, b);
  assert.match(a, /^src_[0-9a-f]{16}$/);
  const other = mintAnchorId({ ...RECORD, end_line: 2 });
  assert.notEqual(a, other);
  const otherContent = mintAnchorId({ ...RECORD, content_sha256: sha256('different') });
  assert.notEqual(a, otherContent);
});

test('P1.2: the registry is the run scope — same execution remints identically, another execution cannot resolve', () => {
  const registryA = new AnchorRegistry();
  const minted = registryA.mint(RECORD);
  const reminted = registryA.mint({ ...RECORD });
  assert.equal(minted.anchor_id, reminted.anchor_id);
  assert.ok(registryA.resolve(minted.anchor_id));
  const registryB = new AnchorRegistry();
  assert.equal(registryB.resolve(minted.anchor_id), undefined, 'anchor from another execution is unknown');
  assert.equal(registryB.list().length, 0);
});

test('P1.3: anchorRecordFromSliceResult accepts exact tool-result shapes and rejects everything else', () => {
  const ok = anchorRecordFromSliceResult({
    path: 'a/b.py', totalLines: 5, totalBytes: 80, sha256: RECORD.base_sha256,
    startLine: 1, endLine: 1, truncated: false, content: 'DEFAULT_FAILURE_STAGE = "consume"',
  });
  assert.ok(ok);
  assert.equal(ok!.path, 'a/b.py');
  assert.equal(ok!.content_sha256, sha256('DEFAULT_FAILURE_STAGE = "consume"'));
  assert.equal(anchorRecordFromSliceResult({ path: 'a.py' }), null);
  assert.equal(anchorRecordFromSliceResult({ path: 'a.py', sha256: 'nothex', startLine: 1, endLine: 1, content: '' }), null);
  assert.equal(anchorRecordFromSliceResult('not an object'), null);
});

// ─── Exact span splicing ──────────────────────────────────────────────────────

test('P1.4: splicing preserves untouched bytes exactly, including all whitespace', () => {
  const file = 'alpha = 1\n  indented   \n\ndef f():\n    return 2\n';
  const out = spliceLineSpan(file, 2, 2, '  replaced   \n  lines');
  assert.equal(out, 'alpha = 1\n  replaced   \n  lines\n\ndef f():\n    return 2\n');
});

test('P1.5: trailing-newline edges — replacing the last logical line keeps the final newline', () => {
  const file = 'a\nb\n';
  assert.equal(spliceLineSpan(file, 2, 2, 'x'), 'a\nx\n');
  // file NOT ending in a newline stays without one
  assert.equal(spliceLineSpan('a\nb', 2, 2, 'x'), 'a\nx');
});

test('P1.6: empty replacement deletes the span outright', () => {
  assert.equal(spliceLineSpan('a\nb\nc\n', 2, 2, ''), 'a\nc\n');
  assert.equal(spliceLineSpan('a\nb\n', 1, 2, ''), '');
});

test('P1.7: multi-span splicing bottom-up keeps coordinates valid', () => {
  const file = 'l1\nl2\nl3\nl4\nl5\n';
  // splice line 5 first, then line 1 — descending start order
  let out = spliceLineSpan(file, 5, 5, 'L5');
  out = spliceLineSpan(out, 1, 1, 'L1');
  assert.equal(out, 'L1\nl2\nl3\nl4\nL5\n');
});

test('P1.8: out-of-bounds spans throw (fail closed)', () => {
  assert.throws(() => spliceLineSpan('a\n', 1, 5, 'x'));
  assert.throws(() => spliceLineSpan('a\n', 0, 1, 'x'));
});

test('P1.9: spansOverlap detects intersection and adjacency is allowed', () => {
  assert.ok(spansOverlap({ start_line: 1, end_line: 3 }, { start_line: 3, end_line: 5 }));
  assert.ok(!spansOverlap({ start_line: 1, end_line: 3 }, { start_line: 4, end_line: 5 }));
});

// ─── Audit diff (evidence) ────────────────────────────────────────────────────

test('P1.10: span-derived audit diffs are deterministic, truthful, and context-clamped', () => {
  const before = 'a\nb\nc\nd\ne\nf\ng\nh\n';
  const d1 = renderSpanDiff('x.py', before, [{ oldStartLine: 4, oldLineCount: 1, newLines: ['D'] }]);
  const d2 = renderSpanDiff('x.py', before, [{ oldStartLine: 4, oldLineCount: 1, newLines: ['D'] }]);
  assert.equal(d1, d2);
  assert.match(d1, /^--- a\/x\.py\n\+\+\+ b\/x\.py\n/);
  assert.match(d1, /@@ -1,7 \+1,7 @@/);
  assert.match(d1, /-d\n\+D\n/);
  // two spans in one file: ascending hunks, the second's context clamped
  const two = renderSpanDiff('x.py', before, [
    { oldStartLine: 1, oldLineCount: 1, newLines: ['A1'] },
    { oldStartLine: 4, oldLineCount: 1, newLines: ['D1'] },
  ]);
  const headers = two.match(/@@ -\d+,\d+ \+\d+,\d+ @@/g)!;
  assert.equal(headers.length, 2);
  assert.match(two, /-a\n\+A1\n/);
  assert.match(two, /-d\n\+D1\n/);
  // delta correctness: the second hunk's NEW-side start reflects the +0 delta
  // (both spans 1→1), so headers stay aligned
  assert.deepEqual(headers, ['@@ -1,3 +1,3 @@', '@@ -4,4 +4,4 @@']);
  // deletion span: zero inserted lines
  const del = renderSpanDiff('x.py', before, [{ oldStartLine: 2, oldLineCount: 2, newLines: [] }]);
  assert.match(del, /@@ -1,6 \+1,4 @@/);
  assert.match(del, /-b\n-c\n/);
  // created files render as pure additions
  const created = renderCreatedFileDiff('new.py', 'x = 1\ny = 2\n');
  assert.match(created, /@@ -0,0 \+1,2 @@/);
  assert.match(created, /\+x = 1\n\+y = 2/);
});

// ─── Schema strictness — the campaign regression pins ─────────────────────────

test('P1.11 (V9-1 regression): a model-supplied hunk-count field is a schema rejection, not a parse hazard', () => {
  const v9_1_shape = {
    edits: [{ anchor_id: 'src_ab12cd34ef56ab12', replacement: 'x', old_count: 6, new_count: 7 }],
    creates: [],
  };
  const parsed = BuildEditProposalSchema.safeParse(v9_1_shape);
  assert.equal(parsed.success, false, 'unknown keys are rejected by the strict schema');
});

test('P1.12 (V9-3 regression): no positional fields exist anywhere in the proposal schema', async () => {
  const v9_3_shape = {
    edits: [{ anchor_id: 'src_ab12cd34ef56ab12', replacement: 'x', old_start: 1020, oldStart: 1020 }],
    creates: [],
  };
  assert.equal(BuildEditProposalSchema.safeParse(v9_3_shape).success, false);
  // And the JSON-Schema projection the model is TAUGHT declares only the two fields.
  const contract = createBuildChangesetActionContract();
  const { toJsonSchema } = await import('../src/workflow/contracts.js');
  const projection = toJsonSchema(contract.modelSchema) as Record<string, any>;
  const editItem = projection.properties.edits.items;
  assert.deepEqual(Object.keys(editItem.properties).sort(), ['anchor_id', 'replacement']);
  const createItem = projection.properties.creates.items;
  assert.deepEqual(Object.keys(createItem.properties).sort(), ['content', 'path']);
  assert.equal(editItem.additionalProperties, false);
});

test('P1.13 (V11-2 regression): a textual SLE-PATCH block cannot reach the applier — the protocol accepts only structured proposals', () => {
  // The v1.2 marker that the campaign watched corrupt SIX times has no
  // representation in the proposal: a truncated tag is just an unknown-key /
  // wrong-type decode rejection, and no string field is ever parsed as a patch.
  const truncatedMarker = '<<<SLE-PATCH path="apps/ai-server/rag-worker-service/main.py" base="7d';
  const proposal = { edits: [{ anchor_id: truncatedMarker, replacement: 'x' }], creates: [] };
  // Parses only as an (opaque) anchor id — which the registry will reject as
  // unknown. No code path treats any proposal string as diff syntax.
  const parsed = BuildEditProposalSchema.parse(proposal);
  assert.equal(parsed.edits[0].anchor_id, truncatedMarker);
  const contract = createBuildChangesetActionContract();
  const defects = contract.validate!(parsed, {});
  assert.equal(defects.length, 1);
  assert.equal(defects[0].code, 'unknown-anchor');
});

// ─── validate (in-loop, repairable) ───────────────────────────────────────────

function makeContract() {
  return createBuildChangesetActionContract();
}

test('P1.14: validate — empty changeset, unknown/duplicate anchors, overlaps, unauthorized paths, create rules', () => {
  const contract = makeContract();
  const registry = new AnchorRegistry();
  const anchor1 = registry.mint({ ...RECORD });
  const anchor2 = registry.mint({ ...RECORD, start_line: 3, end_line: 4, content_sha256: sha256('def f():') });
  const ctx = { resolveAnchor: (id: string) => registry.resolve(id) };

  // empty
  let defects = contract.validate!({ edits: [], creates: [] }, ctx);
  assert.equal(defects.length, 1);
  assert.equal(defects[0].code, 'empty-changeset');

  // valid baseline passes with zero defects
  defects = contract.validate!(
    { edits: [{ anchor_id: anchor1.anchor_id, replacement: 'new' }], creates: [] },
    ctx,
  );
  assert.equal(defects.length, 0);

  // unknown + duplicate anchors
  defects = contract.validate!(
    {
      edits: [
        { anchor_id: 'src_0000000000000000', replacement: 'x' },
        { anchor_id: anchor1.anchor_id, replacement: 'x' },
        { anchor_id: anchor1.anchor_id, replacement: 'y' },
      ],
      creates: [],
    },
    ctx,
  );
  assert.ok(defects.some((d) => d.code === 'unknown-anchor'));
  assert.ok(defects.some((d) => d.code === 'duplicate-anchor'));

  // overlap on the same file
  defects = contract.validate!(
    {
      edits: [
        { anchor_id: anchor1.anchor_id, replacement: 'x' },
        { anchor_id: anchor2.anchor_id, replacement: 'y' },
      ],
      creates: [],
    },
    ctx,
  );
  // anchor1 covers [1,1], anchor2 [3,4] — adjacent, NOT overlapping; shift 2 to [1,2] shape
  assert.equal(defects.length, 0);
  const anchorOverlap = registry.mint({ ...RECORD, start_line: 1, end_line: 2, content_sha256: sha256('DEFAULT_FAILURE_STAGE = "consume"\n\n') });
  defects = contract.validate!(
    {
      edits: [
        { anchor_id: anchor1.anchor_id, replacement: 'x' },
        { anchor_id: anchorOverlap.anchor_id, replacement: 'y' },
      ],
      creates: [],
    },
    ctx,
  );
  assert.ok(defects.some((d) => d.code === 'overlapping-edits'));

  // editPolicy authorization
  const policyCtx = {
    resolveAnchor: (id: string) => registry.resolve(id),
    editPolicy: { appliesToSteps: ['build'], allowedEditPaths: ['other/file.py'], requiredEditPaths: [] },
  };
  defects = contract.validate!({ edits: [{ anchor_id: anchor1.anchor_id, replacement: 'x' }], creates: [] }, policyCtx);
  assert.ok(defects.some((d) => d.code === 'unauthorized-edit-path'));
  defects = contract.validate!({ edits: [], creates: [{ path: 'other/new.py', content: 'x' }] }, policyCtx);
  assert.ok(defects.some((d) => d.code === 'unauthorized-create-path'));

  // create path rules: unsafe, extension, duplicate, conflict with an edit
  defects = contract.validate!(
    {
      edits: [{ anchor_id: anchor1.anchor_id, replacement: 'x' }],
      creates: [
        { path: '../escape.py', content: 'x' },
        { path: 'new/file.exe', content: 'x' },
        { path: 'new/ok.py', content: 'x' },
        { path: 'new/ok.py', content: 'y' },
        { path: RECORD.path, content: 'z' },
      ],
    },
    ctx,
  );
  assert.ok(defects.some((d) => d.code === 'unsafe-create-path'));
  assert.ok(defects.some((d) => d.code === 'create-extension-not-allowed'));
  assert.ok(defects.some((d) => d.code === 'duplicate-create-path'));
  assert.ok(defects.some((d) => d.code === 'path-conflict'));
});

// ─── stage (authoritative) ────────────────────────────────────────────────────

const WORKER_ORIGINAL = 'DEFAULT_FAILURE_STAGE = "consume"\n\n\ndef process_document(doc):\n    return doc\n';
const WORKER_PATH = 'apps/ai-server/rag-worker-service/main.py';

function memIo(files: Map<string, string>) {
  return {
    readFile: async (rel: string) => {
      const v = files.get(rel);
      if (v === undefined) throw new Error('ENOENT');
      return v;
    },
    fileExists: async (rel: string) => files.has(rel),
  };
}

test('P1.15: stage — exact replacement bytes from disk, create rules, staleness, no-op drop', async () => {
  const contract = makeContract();
  const registry = new AnchorRegistry();
  const anchor = registry.mint({
    path: WORKER_PATH,
    base_sha256: sha256(WORKER_ORIGINAL),
    start_line: 1,
    end_line: 1,
    content_sha256: sha256('DEFAULT_FAILURE_STAGE = "consume"'),
  });
  const files = new Map<string, string>([[WORKER_PATH, WORKER_ORIGINAL]]);
  const ctx = {
    io: memIo(files),
    resolveStageAnchor: (id: string) => registry.resolve(id),
  };

  // replace line 1 with two lines + create a new file
  const outcome = await contract.stage(
    {
      edits: [{ anchor_id: anchor.anchor_id, replacement: 'DEFAULT_FAILURE_STAGE = "consume"\nFAILURE_STAGE_FALLBACK = "processing"' }],
      creates: [{ path: 'apps/ai-server/rag-worker-service/failure_payload.py', content: 'STAGE = "processing"\n' }],
    },
    ctx,
  );
  assert.ok(outcome.ok, JSON.stringify(outcome));
  assert.equal(outcome.changeset.edits.length, 2);
  const replace = outcome.changeset.edits.find((e) => e.op === 'replace')!;
  const create = outcome.changeset.edits.find((e) => e.op === 'create')!;
  assert.equal(replace.path, WORKER_PATH);
  assert.equal(replace.content, 'DEFAULT_FAILURE_STAGE = "consume"\nFAILURE_STAGE_FALLBACK = "processing"\n\n\ndef process_document(doc):\n    return doc\n');
  assert.equal(replace.before_sha256, sha256(WORKER_ORIGINAL));
  assert.equal(replace.after_sha256, sha256(replace.content));
  assert.match(replace.diff, /-DEFAULT_FAILURE_STAGE = "consume"\n\+DEFAULT_FAILURE_STAGE = "consume"\n\+FAILURE_STAGE_FALLBACK = "processing"/);
  assert.equal(create.path, 'apps/ai-server/rag-worker-service/failure_payload.py');
  assert.equal(create.before_sha256, null);
  assert.match(create.diff, /\+STAGE = "processing"/);

  // stale base (disk changed under the anchor)
  files.set(WORKER_PATH, WORKER_ORIGINAL.replace('consume', 'consume-v2'));
  const stale = await contract.stage(
    { edits: [{ anchor_id: anchor.anchor_id, replacement: 'x' }], creates: [] },
    ctx,
  );
  assert.equal(stale.ok, false);
  assert.match(stale.error, /stale/);

  // create on an existing path fails closed
  files.set(WORKER_PATH, WORKER_ORIGINAL);
  const exists = await contract.stage(
    { edits: [], creates: [{ path: WORKER_PATH, content: 'x' }] },
    ctx,
  );
  assert.equal(exists.ok, false);
  assert.match(exists.error, /already exists/);

  // no-op replace (identical bytes) is dropped from the changeset
  const noop = await contract.stage(
    { edits: [{ anchor_id: anchor.anchor_id, replacement: 'DEFAULT_FAILURE_STAGE = "consume"' }], creates: [] },
    ctx,
  );
  assert.ok(noop.ok);
  assert.equal(noop.changeset.edits.length, 0);

  // unknown anchor at stage time (cross-execution) fails closed
  const foreign = await contract.stage(
    { edits: [{ anchor_id: 'src_ffffffffffffffff', replacement: 'x' }], creates: [] },
    ctx,
  );
  assert.equal(foreign.ok, false);
  assert.match(foreign.error, /was not issued/);
});

test('P1.16: stage — multi-edit one file applies deterministically and writes once', async () => {
  const contract = makeContract();
  const registry = new AnchorRegistry();
  const a1 = registry.mint({ path: WORKER_PATH, base_sha256: sha256(WORKER_ORIGINAL), start_line: 1, end_line: 1, content_sha256: sha256('DEFAULT_FAILURE_STAGE = "consume"') });
  const a2 = registry.mint({ path: WORKER_PATH, base_sha256: sha256(WORKER_ORIGINAL), start_line: 4, end_line: 4, content_sha256: sha256('def process_document(doc):') });
  const outcome = await contract.stage(
    {
      edits: [
        { anchor_id: a1.anchor_id, replacement: 'DEFAULT_FAILURE_STAGE = "processing"' },
        { anchor_id: a2.anchor_id, replacement: 'async def process_document(doc):' },
      ],
      creates: [],
    },
    { io: memIo(new Map([[WORKER_PATH, WORKER_ORIGINAL]])), resolveStageAnchor: (id) => registry.resolve(id) },
  );
  assert.ok(outcome.ok, JSON.stringify(outcome));
  assert.equal(outcome.changeset.edits.length, 1);
  assert.equal(
    outcome.changeset.edits[0].content,
    'DEFAULT_FAILURE_STAGE = "processing"\n\n\nasync def process_document(doc):\n    return doc\n',
  );
  assert.equal(outcome.changeset.edits[0].anchor_id, `${a1.anchor_id},${a2.anchor_id}`);
});

test('P1.17: the registered artifact type key is stable', () => {
  assert.equal(BUILD_CHANGESET_ARTIFACT_TYPE, 'build-changeset');
});

test('P1.27: id equality never stands in for binding equality — identical bindings dedupe, a colliding different binding fails closed', () => {
  const registry = new AnchorRegistry();
  const binding = {
    path: WORKER_PATH,
    base_sha256: sha256(WORKER_ORIGINAL),
    start_line: 1,
    end_line: 1,
    content_sha256: sha256('DEFAULT_FAILURE_STAGE = "consume"'),
  };
  const first = registry.mint(binding);
  const again = registry.mint({ ...binding });
  assert.equal(first, again, 'identical binding must dedupe to the same anchor object');

  // Fault injection drives the same byId.get(id) branch a genuine ~2^-64
  // sha256-prefix collision would drive: a foreign record already occupies
  // the id the new binding derives to.
  const colliding = { path: 'other.py', base_sha256: sha256('B'), start_line: 500, end_line: 502, content_sha256: sha256('z') };
  const collidingId = mintAnchorId(colliding);
  (registry as unknown as { byId: Map<string, unknown> }).byId.set(collidingId, { ...binding, anchor_id: collidingId });
  assert.throws(() => registry.mint(colliding), /collision across different bindings/);
  assert.equal(registry.resolve(collidingId)?.path, WORKER_PATH, 'the registered record is unchanged — no takeover');
});
