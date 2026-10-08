// P2-B — BUILD Edit Protocol v1.1 deterministic closure.
//
// Operator-approved mechanics (P2-B only; the repair-reserve P2-A was REJECTED
// on forensic evidence):
//   A. missing `creates` canonicalizes to [] (strict outer object kept)
//   B. policy-specialized action surface: when the frozen authority leaves
//      zero legal create targets, the MODEL-FACING schema omits `creates`
//      (a submitted creates is an unknown-key rejection — never silently
//      discarded); the projection can only narrow
//   C. deterministic one-line boundary composition: same path + same base
//      sha256 + B.start === A.end + A's replacement final line === B's
//      replacement first line byte-for-byte → Stratum composes
//      span=[A.start,B.end], replacement=A+B[1:] (chains included). Any other
//      overlap keeps today's overlapping-edits rejection
//   D. truthful unknown-anchor repair instruction (never demands a withdrawn
//      repository tool)
//
// The authoritative post-submission checks (path safety, extension, task
// authorization, no-overwrite, base-staleness, overlap re-check) are unchanged
// and run at stage regardless of the model-facing projection.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import {
  createBuildChangesetActionContract,
  BuildEditProposalSchema,
  BuildEditProposalNoCreatesSchema,
  type BuildEditProposal,
} from '../src/workflow/methodology/build-changeset-contract.js';
import { createActionAcceptor } from '../src/workflow/action-contracts.js';
import type { SourceAnchor } from '../src/workflow/anchored-edits.js';

const contract = createBuildChangesetActionContract();
const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

// ─── synthetic repository ─────────────────────────────────────────────────────

const PATH = 'src/service/worker.py';
const BASE_LINES = Array.from({ length: 24 }, (_, i) => `line = ${i + 1}  # original-${i + 1}`);
const BASE = BASE_LINES.join('\n') + '\n';
const BASE_SHA = sha256(BASE);

interface AnchorSpec { start: number; end: number; base?: string; path?: string }
function mintAnchor(spec: AnchorSpec): SourceAnchor {
  const path = spec.path ?? PATH;
  const base_sha256 = spec.base ?? BASE_SHA;
  const content = BASE_LINES.slice(spec.start - 1, spec.end).join('\n');
  const anchor_id =
    'src_' + createHash('sha256').update([path, base_sha256, String(spec.start), String(spec.end), sha256(content)].join('\0'), 'utf8').digest('hex').slice(0, 16);
  return { anchor_id, path, base_sha256, start_line: spec.start, end_line: spec.end, content_sha256: sha256(content) };
}

function harness(...minted: SourceAnchor[]) {
  const anchors = new Map<string, SourceAnchor>();
  for (const a of minted) {
    anchors.set(a.anchor_id, a);
  }
  return {
    anchors,
    validateCtx: { workItemId: 'wi', resolveAnchor: (id: string) => anchors.get(id) },
    stageCtxFactory: (fileContent: string) => ({
      workItemId: 'wi',
      io: {
        readFile: async (p: string) => {
          assert.equal(p, PATH);
          return fileContent;
        },
        fileExists: async () => false,
      },
      resolveStageAnchor: (id: string) => anchors.get(id),
    }),
  };
}

const edit = (a: SourceAnchor, replacement: string) => ({ anchor_id: a.anchor_id, replacement });

// ─── A. missing creates → canonical [] ────────────────────────────────────────

test('P2B.A1: a proposal without `creates` parses with the canonical empty default', () => {
  const parsed = BuildEditProposalSchema.parse({ edits: [{ anchor_id: 'src_x', replacement: 'y' }] });
  assert.deepEqual(parsed.creates, []);
  const explicit = BuildEditProposalSchema.parse({ edits: [{ anchor_id: 'src_x', replacement: 'y' }], creates: [] });
  assert.deepEqual(parsed, explicit);
});

test('P2B.A2: the outer object stays strict — unknown keys are still decode rejections', () => {
  const result = BuildEditProposalSchema.safeParse({ edits: [], creates: [], hunk_count: 2 });
  assert.equal(result.success, false);
  assert.match(JSON.stringify((result as any).error.issues), /Unrecognized key/);
});

test('P2B.A3: a non-empty creates still parses and still flows to authoritative checks', () => {
  const parsed = BuildEditProposalSchema.parse({ edits: [], creates: [{ path: 'new_file.py', content: 'x' }] });
  assert.equal(parsed.creates.length, 1);
  // authoritative rejection for an unauthorized create remains a validate defect:
  const defects = contract.validate!(parsed, { workItemId: 'wi', resolveAnchor: () => undefined, editPolicy: { appliesToSteps: ['build'], allowedEditPaths: [PATH], requiredEditPaths: [PATH] } });
  assert.ok(defects.some((d) => d.code === 'unauthorized-create-path'), 'unauthorized-create-path must still fire');
});

// ─── B. policy-specialized action surface ─────────────────────────────────────

test('P2B.B1: with zero legal create targets the model-facing schema omits creates entirely', () => {
  const projected = contract.projectModelSchema!({ workItemId: 'wi', createsAuthorized: false });
  assert.equal(projected, BuildEditProposalNoCreatesSchema);
  const json = { edits: [{ anchor_id: 'src_x', replacement: 'y' }] } as unknown;
  assert.equal(projected.safeParse(json).success, true);
  // an explicit creates — even EMPTY — is an unknown-key decode rejection,
  // never silently discarded:
  const withCreates = projected.safeParse({ edits: [], creates: [] });
  assert.equal(withCreates.success, false);
  assert.match(JSON.stringify((withCreates as any).error.issues), /Unrecognized key/);
});

test('P2B.B2: absent/true createsAuthorized keeps the ordinary full surface', () => {
  assert.equal(contract.projectModelSchema!({ workItemId: 'wi' }), BuildEditProposalSchema);
  assert.equal(contract.projectModelSchema!({ workItemId: 'wi', createsAuthorized: true }), BuildEditProposalSchema);
  // ordinary create support retained end-to-end shape-wise
  assert.equal(BuildEditProposalSchema.safeParse({ edits: [], creates: [{ path: 'n.py', content: 'x' }] }).success, true);
});

test('P2B.B3: the projection can only narrow — every projected-valid payload is valid under the canonical schema', () => {
  // structural: the narrowed schema is the canonical shape minus the creates key
  const keys = Object.keys(BuildEditProposalNoCreatesSchema.shape);
  assert.deepEqual(keys, ['edits']);
  assert.deepEqual(Object.keys(BuildEditProposalSchema.shape).sort(), ['creates', 'edits']);
  // and the same edits payload decodes under both
  const payload = { edits: [{ anchor_id: 'src_x', replacement: 'y' }] };
  assert.equal(BuildEditProposalNoCreatesSchema.safeParse(payload).success, true);
  assert.equal(BuildEditProposalSchema.safeParse(payload).success, true);
});

test('P2B.B4: the acceptor decodes through the projected schema (and canonicalizes for validate)', () => {
  const anchor = mintAnchor({ start: 1, end: 2 });
  const resolve = (id: string) => (id === anchor.anchor_id ? anchor : undefined);
  const narrowedCtx = { workItemId: 'wi', createsAuthorized: false, resolveAnchor: resolve };
  const acceptor = createActionAcceptor(contract, narrowedCtx as never, 'build-changeset');
  // narrowed surface: edits-only decodes fine and validates (anchor resolves)
  const ok = acceptor({ edits: [{ anchor_id: anchor.anchor_id, replacement: 'y' }] });
  assert.equal(ok.ok, true);
  // an explicit creates under the narrowed surface is a SCHEMA (unknown-key)
  // rejection naming the key — never silently discarded:
  const rejected = acceptor({ edits: [{ anchor_id: anchor.anchor_id, replacement: 'y' }], creates: [] });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.match(rejected.repairInstruction, /creates/);
  // an unknown anchor under the narrowed surface still reaches semantic
  // validation as unknown-anchor (the canonicalized decode didn't mask it):
  const unknownAnchor = acceptor({ edits: [{ anchor_id: 'src_fabricated', replacement: 'y' }] });
  assert.equal(unknownAnchor.ok, false);
  if (!unknownAnchor.ok) assert.match(unknownAnchor.repairInstruction, /unknown-anchor/);
});

// ─── C. deterministic boundary composition ────────────────────────────────────

const a5_10 = mintAnchor({ start: 5, end: 10 });
const a10_15 = mintAnchor({ start: 10, end: 15 });
const a3_6 = mintAnchor({ start: 3, end: 6 });
const a6_9 = mintAnchor({ start: 6, end: 9 });
const a9_12 = mintAnchor({ start: 9, end: 12 });
const a8_15 = mintAnchor({ start: 8, end: 15 });
const a5_15 = mintAnchor({ start: 5, end: 15 });
const a12_18 = mintAnchor({ start: 12, end: 18 });
const otherFile = mintAnchor({ start: 5, end: 10, path: 'src/service/other.py' });
const staleBase = mintAnchor({ start: 5, end: 10, base: sha256('different bytes\n') });

test('P2B.C1: boundary-adjacent compatible edits compose — no overlapping-edits defect', () => {
  const proposal: BuildEditProposal = {
    edits: [edit(a5_10, 'line = 5  # rewritten-A\nline = 10  # shared-boundary'), edit(a10_15, 'line = 10  # shared-boundary\nline = 15  # rewritten-B')],
    creates: [],
  };
  const defects = contract.validate!(proposal, harness(a5_10, a10_15).validateCtx);
  assert.deepEqual(defects.map((d) => d.code), [], JSON.stringify(defects));
});

test('P2B.C2: staged bytes equal the mechanical merge (A + B[1:] spliced once)', async () => {
  const replA = 'line = 5  # rewritten-A\nline = 10  # shared-boundary';
  const replB = 'line = 10  # shared-boundary\nline = 15  # rewritten-B';
  const proposal: BuildEditProposal = { edits: [edit(a5_10, replA), edit(a10_15, replB)], creates: [] };
  const h = harness(a5_10, a10_15);
  const outcome = await contract.stage(proposal, h.stageCtxFactory(BASE) as never);
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    const composed = outcome.changeset.edits.find((e) => e.op === 'replace')!;
    // span = [5,15]; replacement = A + B[1:]
    const expected = BASE_LINES.slice(0, 4).concat(replA.split('\n').concat(replB.split('\n').slice(1))).join('\n') + '\n'
      + BASE_LINES.slice(15).join('\n') + '\n';
    assert.equal(composed.content, expected);
    assert.equal(composed.after_sha256, sha256(expected));
    // evidence: the composition is recorded with source anchors in ascending order
    assert.deepEqual(composed.composed_from, [a5_10.anchor_id, a10_15.anchor_id]);
  }
});

test('P2B.C3: three-anchor chains compose transitively — every join satisfies the rule', async () => {
  const r1 = 'line = 3  # r1\nline = 6  # j1';
  const r2 = 'line = 6  # j1\nline = 9  # j2';
  const r3 = 'line = 9  # j2\nline = 12  # r3';
  const proposal: BuildEditProposal = { edits: [edit(a3_6, r1), edit(a6_9, r2), edit(a9_12, r3)], creates: [] };
  const h = harness(a3_6, a6_9, a9_12);
  const defects = contract.validate!(proposal, h.validateCtx);
  assert.deepEqual(defects.map((d) => d.code), []);
  const outcome = await contract.stage(proposal, h.stageCtxFactory(BASE) as never);
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    const composed = outcome.changeset.edits.find((e) => e.op === 'replace')!;
    assert.deepEqual(composed.composed_from, [a3_6.anchor_id, a6_9.anchor_id, a9_12.anchor_id]);
    const expected = BASE_LINES.slice(0, 2)
      .concat((r1 + '\n' + r2.split('\n').slice(1).join('\n') + '\n' + r3.split('\n').slice(1).join('\n')).split('\n'))
      .join('\n') + '\n' + BASE_LINES.slice(12).join('\n') + '\n';
    assert.equal(composed.content, expected);
  }
});

test('P2B.C4: overlap of more than one source line still rejects', () => {
  const proposal: BuildEditProposal = {
    edits: [edit(a5_10, 'x'), edit(a8_15, 'y')], // [5,10] vs [8,15] share 8,9,10
    creates: [],
  };
  const defects = contract.validate!(proposal, harness(a5_10, a8_15).validateCtx);
  assert.ok(defects.some((d) => d.code === 'overlapping-edits'), JSON.stringify(defects));
});

test('P2B.C5: one-line touch with a boundary line differing by one byte still rejects', () => {
  const proposal: BuildEditProposal = {
    edits: [
      edit(a5_10, 'line = 5  # rewritten-A\nline = 10  # shared-boundary-V1'),
      edit(a10_15, 'line = 10  # shared-boundary-V2\nline = 15  # rewritten-B'),
    ],
    creates: [],
  };
  const defects = contract.validate!(proposal, harness(a5_10, a10_15).validateCtx);
  assert.ok(defects.some((d) => d.code === 'overlapping-edits'), JSON.stringify(defects));
});

test('P2B.C6: different base sha256 across the join still rejects', () => {
  const proposal: BuildEditProposal = {
    edits: [edit(a5_10, 'line = 5  # A\nline = 10  # shared'), edit(staleBase, 'line = 10  # shared\nline = 15  # B')],
    creates: [],
  };
  const defects = contract.validate!(proposal, harness(a5_10, staleBase).validateCtx);
  assert.ok(defects.some((d) => d.code === 'overlapping-edits'), JSON.stringify(defects));
});

test('P2B.C7: different paths never compose with each other (independent edits)', () => {
  const r = 'line = 5  # rewritten\nline = 10  # tail';
  const proposal: BuildEditProposal = {
    edits: [edit(a5_10, r), edit(otherFile, r)],
    creates: [],
  };
  const defects = contract.validate!(proposal, harness(a5_10, otherFile).validateCtx);
  assert.deepEqual(defects.map((d) => d.code), []);
});

test('P2B.C8: nested spans still reject', () => {
  const proposal: BuildEditProposal = { edits: [edit(a5_15, 'outer'), edit(a8_15, 'inner')], creates: [] };
  const defects = contract.validate!(proposal, harness(a5_15, a8_15).validateCtx);
  assert.ok(defects.some((d) => d.code === 'overlapping-edits'));
});

test('P2B.C9: a composed span overlapping a third edit still rejects', () => {
  const proposal: BuildEditProposal = {
    edits: [
      edit(a5_10, 'line = 5  # A\nline = 10  # shared'),
      edit(a10_15, 'line = 10  # shared\nline = 15  # B'),
      edit(a12_18, 'third'), // [12,18] inside the composed [5,15]
    ],
    creates: [],
  };
  const defects = contract.validate!(proposal, harness(a5_10, a10_15, a12_18).validateCtx);
  assert.ok(defects.some((d) => d.code === 'overlapping-edits'), JSON.stringify(defects));
});

test('P2B.C10: stage re-checks everything independently — a stale base fails even after a valid composition', async () => {
  const proposal: BuildEditProposal = {
    edits: [
      edit(a5_10, 'line = 5  # A\nline = 10  # shared'),
      edit(a10_15, 'line = 10  # shared\nline = 15  # B'),
    ],
    creates: [],
  };
  const h = harness(a5_10, a10_15);
  const tampered = BASE.replace('line = 7  # original-7', 'line = 7  # TAMPERED');
  assert.notEqual(tampered, BASE);
  const outcome = await contract.stage(proposal, h.stageCtxFactory(tampered) as never);
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.match(outcome.error, /stale/);
});

// ─── D. truthful unknown-anchor instruction ───────────────────────────────────

test('P2B.D1: the unknown-anchor repair instruction is truthful about withdrawn tools', () => {
  const proposal: BuildEditProposal = { edits: [{ anchor_id: 'src_fabricated', replacement: 'x' }], creates: [] };
  const defects = contract.validate!(proposal, { workItemId: 'wi', resolveAnchor: () => undefined });
  assert.equal(defects.length, 1);
  assert.equal(defects[0].code, 'unknown-anchor');
  assert.match(defects[0].message, /previously issued by read_source_slice in this execution/);
  assert.match(defects[0].message, /cannot be repaired in this synthesis phase and must fail closed/);
  assert.doesNotMatch(defects[0].message, /re-read the target region/);
});

// ─── regression: the pre-P2B failure modes stay rejected ──────────────────────

test('P2B.R1: a genuine multi-line overlap was rejected before P2B and still is (run-1-style regression guard)', () => {
  // the P1-R campaign forensics pinned that [905,1024]+[1024,1103] with EQUAL
  // boundary lines now composes; the equal-rule must not loosen other cases:
  const proposal: BuildEditProposal = { edits: [edit(a5_10, 'A\nshared'), edit(a8_15, 'B\nshared-tail')], creates: [] };
  const defects = contract.validate!(proposal, harness(a5_10, a8_15).validateCtx);
  assert.ok(defects.some((d) => d.code === 'overlapping-edits'));
});

test('P2B.R2: a real on-disk staging of a composed chain writes exactly the composed bytes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'p2b-stage-'));
  try {
    mkdirSync(join(root, dirname(PATH)), { recursive: true });
    writeFileSync(join(root, PATH), BASE);
    const replA = 'line = 5  # rewritten-A\nline = 10  # shared-boundary';
    const replB = 'line = 10  # shared-boundary\nline = 15  # rewritten-B';
    const proposal: BuildEditProposal = { edits: [edit(a5_10, replA), edit(a10_15, replB)], creates: [] };
    const h = harness(a5_10, a10_15);
    const disk = readFileSync(join(root, PATH), 'utf-8');
    const outcome = await contract.stage(proposal, {
      workItemId: 'wi',
      io: { readFile: async () => disk, fileExists: async () => false },
      resolveStageAnchor: (id: string) => h.anchors.get(id),
    } as never);
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
      const expected = BASE_LINES.slice(0, 4).concat((replA + '\n' + replB.split('\n').slice(1).join('\n')).split('\n')).join('\n') + '\n' + BASE_LINES.slice(15).join('\n') + '\n';
      assert.equal(outcome.changeset.edits[0].content, expected);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
