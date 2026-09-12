// D.34 C2 — the Readiness output contract (DDR-034 §7): semantic proposal,
// zod single-authority schema, deterministic renderer, hooks. Proven
// INDEPENDENTLY of the live workflow — the contract is NOT registered in
// production yet (that is C3).
//
// Locks the C2 acceptance criteria from docs/developmentPlan/d34-output-contracts.md:
//   - golden-byte fixtures: renderReadiness output pinned exactly; any byte
//     change (js-yaml bump, option change, envelope change) fails here and
//     requires regenerating the fixture in the same commit;
//   - round-trip: render → parseReadinessArtifact → semantic equality;
//   - stability: render ∘ fromPersisted ∘ render is the identity;
//   - projection: the ENTIRE generated JSON Schema golden-pinned (provider-
//     facing freeze), with explicit fidelity assertions — the
//     non-empty-after-trim refinements are decode-authoritative and
//     deliberately NOT projected;
//   - annotation conformance: the real schemaAnnotations keys resolve
//     against the real projection;
//   - hooks: reviewVerdict; deriveRoute delegates to the EXISTING pure
//     deriveReviewRoute precedence (unchanged semantics, typed input);
//   - seam integration: createResultAcceptor on this contract produces
//     result-repair instructions for decode defects.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  READINESS_OUTPUT_CONTRACT,
  READINESS_PROPOSAL_SCHEMA,
  renderReadiness,
  readinessProposalFromPersisted,
  validateReadinessProposal,
  type ReadinessProposal,
} from '../src/workflow/methodology/readiness-contract.js';
import { parseReadinessArtifact } from '../src/workflow/methodology/readiness-artifact.js';
import {
  createResultAcceptor,
  toJsonSchema,
  validateSchemaAnnotations,
} from '../src/workflow/contracts.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const FAIL_PROPOSAL: ReadinessProposal = {
  verdict: 'fail',
  gaps: [
    {
      target: 'F3',
      description: 'Networking latency claim is unverified',
      classification: 'CAN_RESOLVE',
      reason: 'Repository inspection can confirm it.',
      closure: 'Inspect the repository and mark F3 KNOWN.',
    },
    {
      target: 'F7',
      description: 'Cross-platform scope undecided',
      classification: 'HUMAN_DECISION',
      reason: 'Product tradeoff only a human can authorize.',
      closure: 'Record a Decision and mark F7 DECIDED.',
    },
  ],
  bodyMarkdown: '## Review notes\n\nThe goal is clear; two gaps block.\n',
};

const PASS_EMPTY: ReadinessProposal = { verdict: 'pass', gaps: [], bodyMarkdown: '' };

const PASS_BODY: ReadinessProposal = {
  verdict: 'pass',
  gaps: [],
  bodyMarkdown: 'Rationale: all seven dimensions pass.\r\n\r\nNo gaps.\r\n\r\n',
};

// ─── Golden bytes (DDR-034 §10.8: a one-byte diff is a review event) ─────────

test('D.34.C2 GOLDEN: fail proposal with typed gaps renders exact canonical bytes', () => {
  assert.equal(renderReadiness(FAIL_PROPOSAL), `---
schemaVersion: 1
gaps:
  - target: F3
    description: Networking latency claim is unverified
    classification: CAN_RESOLVE
    reason: Repository inspection can confirm it.
    closure: Inspect the repository and mark F3 KNOWN.
  - target: F7
    description: Cross-platform scope undecided
    classification: HUMAN_DECISION
    reason: Product tradeoff only a human can authorize.
    closure: Record a Decision and mark F7 DECIDED.
---

## Review notes

The goal is clear; two gaps block.
`);
});

test('D.34.C2 GOLDEN: pass with no gaps and empty body ends at the closing --- newline', () => {
  // §10.3: gaps: [] is meaningful and rendered explicitly.
  // §10.7: empty body → artifact ends at the closing --- newline.
  assert.equal(renderReadiness(PASS_EMPTY), '---\nschemaVersion: 1\ngaps: []\n---\n');
});

test('D.34.C2 GOLDEN: CRLF normalizes to LF and the final-newline policy holds — content untouched', () => {
  // §10.6: newline-level normalization only; §10.5: no trimming/reflow of
  // body content (interior blank lines preserved verbatim).
  assert.equal(
    renderReadiness(PASS_BODY),
    '---\nschemaVersion: 1\ngaps: []\n---\n\nRationale: all seven dimensions pass.\n\nNo gaps.\n',
  );
});

// ─── Round-trip + stability ───────────────────────────────────────────────────

test('D.34.C2 ROUND-TRIP: render → parseReadinessArtifact → semantic equality', () => {
  const { readiness } = parseReadinessArtifact(renderReadiness(FAIL_PROPOSAL));
  assert.equal(readiness.schemaVersion, 1, 'schemaVersion is system-injected');
  assert.deepEqual(readiness.gaps, FAIL_PROPOSAL.gaps, 'typed gaps survive the byte round trip exactly');
  const rebuilt = readinessProposalFromPersisted(renderReadiness(FAIL_PROPOSAL), 'fail');
  assert.equal(rebuilt.bodyMarkdown, FAIL_PROPOSAL.bodyMarkdown, 'body survives the envelope exactly (one blank line is renderer-owned)');
});

test('D.34.C2 STABILITY: render ∘ fromPersisted ∘ render is the identity', () => {
  for (const [proposal, verdict] of [
    [FAIL_PROPOSAL, 'fail'],
    [PASS_EMPTY, 'pass'],
    [PASS_BODY, 'pass'],
  ] as const) {
    const bytes = renderReadiness(proposal);
    const rebuilt = readinessProposalFromPersisted(bytes, verdict);
    assert.equal(rebuilt.verdict, verdict);
    assert.equal(renderReadiness(rebuilt), bytes, 're-rendering the decoded proposal must reproduce the exact bytes');
  }
});

// ─── Projection golden + fidelity ─────────────────────────────────────────────

test('D.34.C2 PROJECTION GOLDEN: the entire provider-facing JSON Schema is pinned', () => {
  // Provider-facing freeze: a zod/zod-to-json-schema/adapter change that
  // alters ANY byte of the projection fails here. Regenerate in the same
  // commit with the diff reviewed.
  assert.deepEqual(toJsonSchema(READINESS_PROPOSAL_SCHEMA), {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['pass', 'fail'] },
      gaps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            target: { type: 'string' },
            description: { type: 'string' },
            classification: { type: 'string', enum: ['CAN_RESOLVE', 'DEFER', 'HUMAN_DECISION', 'EXPLORE_AS_WORK'] },
            reason: { type: 'string' },
            closure: { type: 'string' },
          },
          required: ['target', 'description', 'classification', 'reason'],
          additionalProperties: false,
        },
      },
      bodyMarkdown: { type: 'string' },
    },
    required: ['verdict', 'gaps', 'bodyMarkdown'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  });
});

test('D.34.C2 FIDELITY: non-empty-after-trim refinements are decode-authoritative, NOT projected', () => {
  const projection = toJsonSchema(READINESS_PROPOSAL_SCHEMA) as Record<string, unknown>;
  const gapsItems = ((((projection['properties'] as Record<string, unknown>)['gaps'] as Record<string, unknown>)['items'] as Record<string, unknown>)['properties'] as Record<string, unknown>);
  // The refinement is invisible to providers (plain string) — decode is the
  // authority. No hand-maintained mirror schema "fixes" this.
  assert.deepEqual(gapsItems['target'], { type: 'string' });
  // …and decode DOES enforce it:
  const decode = READINESS_PROPOSAL_SCHEMA.safeParse({
    verdict: 'fail',
    gaps: [{ target: '   ', description: 'd', classification: 'CAN_RESOLVE', reason: 'r' }],
    bodyMarkdown: '',
  });
  assert.equal(decode.success, false, 'whitespace-only target is a producer-result defect at decode');
});

test('D.34.C2 ANNOTATIONS: the real schemaAnnotations keys resolve against the real projection', () => {
  const result = validateSchemaAnnotations(
    READINESS_OUTPUT_CONTRACT.modelSchema,
    READINESS_OUTPUT_CONTRACT.schemaAnnotations,
  );
  assert.deepEqual(result, { ok: true });
});

// ─── Decode authority (schema-level mechanical rules) ────────────────────────

test('D.34.C2 DECODE: classification enum membership is enforced mechanically at the schema', () => {
  const decode = READINESS_PROPOSAL_SCHEMA.safeParse({
    verdict: 'fail',
    gaps: [{ target: 'F1', description: 'd', classification: 'MADE_UP_CLASS', reason: 'r' }],
    bodyMarkdown: '',
  });
  assert.equal(decode.success, false, 'unknown classifications can never reach route derivation');
});

test('D.34.C2 DECODE: closure is optional but non-empty when present; extra fields rejected', () => {
  const base = { verdict: 'fail', gaps: [{ target: 'F1', description: 'd', classification: 'DEFER', reason: 'r' }], bodyMarkdown: '' };
  assert.equal(READINESS_PROPOSAL_SCHEMA.safeParse(base).success, true);
  assert.equal(
    READINESS_PROPOSAL_SCHEMA.safeParse({ ...base, gaps: [{ ...base.gaps[0], closure: '  ' }] }).success,
    false,
  );
  assert.equal(
    READINESS_PROPOSAL_SCHEMA.safeParse({ ...base, schemaVersion: 1 }).success,
    false,
    'schemaVersion is system-owned — the model cannot even carry it',
  );
});

// ─── Hooks ────────────────────────────────────────────────────────────────────

test('D.34.C2 HOOKS: reviewVerdict comes from the proposal; deriveRoute delegates to the existing precedence', () => {
  assert.equal(READINESS_OUTPUT_CONTRACT.reviewVerdict?.(FAIL_PROPOSAL), 'fail');
  const derived = READINESS_OUTPUT_CONTRACT.deriveRoute?.(FAIL_PROPOSAL, ['refine', 'defer', 'human', 'explore']);
  // CAN_RESOLVE outranks HUMAN_DECISION in GAP_CLASSIFICATION_PRECEDENCE —
  // the F3 gap wins; the existing pure precedence function is unchanged.
  assert.deepEqual(derived, { ok: true, route: 'refine' });
  const passDerived = READINESS_OUTPUT_CONTRACT.deriveRoute?.(PASS_EMPTY, ['refine', 'defer', 'human', 'explore']);
  assert.equal(passDerived?.ok, false, 'a pass carries no route — fail closed if derivation is demanded');
});

// ─── Methodology invariants (C2 review correction — validate layer) ──────────

test('D.34.C2 VALIDATE: the three methodology-forbidden combinations are deterministic defects', () => {
  // The existing READINESS_ROUTE_CONTRACT forbids these; zod is structural
  // and must not own the cross-field rule — validate() does.
  const passWithGaps = validateReadinessProposal({
    verdict: 'pass',
    gaps: [{ target: 'F1', description: 'd', classification: 'CAN_RESOLVE', reason: 'r', closure: 'c' }],
    bodyMarkdown: '',
  });
  assert.deepEqual(passWithGaps.map((d) => d.code), ['PASS_WITH_GAPS']);

  const failWithoutGaps = validateReadinessProposal({ verdict: 'fail', gaps: [], bodyMarkdown: '' });
  assert.deepEqual(failWithoutGaps.map((d) => d.code), ['FAIL_WITHOUT_GAPS']);

  const closureMissing = validateReadinessProposal({
    verdict: 'fail',
    gaps: [
      { target: 'F1', description: 'd', classification: 'DEFER', reason: 'r', closure: 'record DEFERRED' },
      { target: 'F2', description: 'd', classification: 'CAN_RESOLVE', reason: 'r' },
    ],
    bodyMarkdown: '',
  });
  assert.deepEqual(closureMissing.map((d) => d.code), ['GAP_CLOSURE_MISSING']);
  assert.equal(closureMissing[0].ref, 'F2', 'the defect names the offending gap target');

  // The valid combinations remain clean.
  assert.deepEqual(validateReadinessProposal(FAIL_PROPOSAL), []);
  assert.deepEqual(validateReadinessProposal(PASS_EMPTY), []);
  assert.deepEqual(validateReadinessProposal(PASS_BODY), []);
});

test('D.34.C2 VALIDATE: the dangerous case — pass + non-empty gaps — can never pass the verdict gate', () => {
  // The reason this correction exists: without validate, a pass-with-gaps
  // proposal would sail through reviewVerdict as 'pass' and its unresolved
  // gaps would never participate in route derivation.
  const acceptor = createResultAcceptor(READINESS_OUTPUT_CONTRACT, {}, 'definition-readiness');
  const result = acceptor({
    verdict: 'pass',
    gaps: [{ target: 'F1', description: 'd', classification: 'HUMAN_DECISION', reason: 'r', closure: 'c' }],
    bodyMarkdown: '',
  });
  assert.equal(result.ok, false, 'an internally contradictory readiness judgment is a producer-result defect');
  if (!result.ok) assert.match(result.repairInstruction, /PASS_WITH_GAPS/);
});

test('D.34.C2 SEAM: the acceptor rejects malformed payloads with a result-repair instruction naming the contract', () => {
  const acceptor = createResultAcceptor(READINESS_OUTPUT_CONTRACT, { workItemId: 'w' }, 'definition-readiness');
  const bad = acceptor({ verdict: 'fail', gaps: [{ target: 7 }], bodyMarkdown: '' });
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.match(bad.repairInstruction, /output contract for 'definition-readiness'/);
    assert.match(bad.repairInstruction, /Re-submit the complete corrected result/);
  }
  const methodologyInvalid = acceptor({
    verdict: 'fail',
    gaps: [{ target: 'F1', description: 'd', classification: 'CAN_RESOLVE', reason: 'r' }],
    bodyMarkdown: 'body',
  });
  assert.equal(methodologyInvalid.ok, false, 'structurally valid but methodology-invalid → validate layer rejects');
  if (!methodologyInvalid.ok) assert.match(methodologyInvalid.repairInstruction, /GAP_CLOSURE_MISSING/);
  const good = acceptor({
    verdict: 'fail',
    gaps: [{ target: 'F1', description: 'd', classification: 'CAN_RESOLVE', reason: 'r', closure: 'c' }],
    bodyMarkdown: 'body',
  });
  assert.deepEqual(good, { ok: true });
});
