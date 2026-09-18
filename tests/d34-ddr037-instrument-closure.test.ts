// DDR-037 — instrument-closure regressions. Every test here pins a finding
// from the E4 residual failure audit (eval-reports/E4D-residual-audit.md in
// the E4-D evidence clone; see docs/decisions/ddr-037-instrument-closure.md):
//
//   1. a near-miss factId rejection must expose the exact legal candidate
//      set (repair-interface closure — E4-D inv3);
//   2. a missing factId on an escalating gap must expose the legal set AND
//      the CAN_RESOLVE fallback rule (E4-D inv5 degraded near-miss →
//      omission under the old, informationally deficient repair);
//   3. the readiness contract's initial teaching surfaces the exact fact
//      IDs of the current Definition BEFORE the first submission;
//   4. that candidate list is derived ONLY from the trusted declared
//      definition.md input — different ledger, different list; no ledger,
//      no list (never invented);
//   5. it is a pure ephemeral projection — no persisted second authority;
//      the static teaching path is byte-stable when the hook is absent;
//   6. the HISTORICAL rejected GLM proposals, byte-for-byte: correcting
//      ONLY the factId values flips them to fully accepted — the audit's
//      deterministic counterfactual, pinned forever;
//   7. the MATURE fixture now supplies the repository-verified event-source
//      knowledge it always documented, so a competent v1 draft can record
//      the wiring KNOWN with repository provenance;
//   8. the MATURE oracle still demands iteration 1 — corrected fixture,
//      NOT a loosened criterion;
//   9. a reviewer that invents an unnecessary gap still fails that oracle.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { MATURE_OBJECTIVE } from './fixtures/d3d/fixtures.js';
import {
  READINESS_OUTPUT_CONTRACT,
  READINESS_PROPOSAL_SCHEMA,
} from '../src/workflow/methodology/readiness-contract.js';
import { parseDefinition } from '../src/workflow/methodology/definition-artifact.js';
import {
  renderResultTeaching,
  renderSchemaTeaching,
  toJsonSchema,
} from '../src/workflow/contracts.js';
import type { OutputContractContext } from '../src/workflow/contracts.js';

// ─── historical E4-D evidence (byte-for-byte) ─────────────────────────────────

const FIX = 'fixtures/d34/ddr037';

function loadFixture(name: string): string {
  return readFileSync(new URL(`${FIX}/${name}`, import.meta.url), 'utf8');
}

const INV3_PROPOSAL = loadFixture('glm-e4d-inv3-rejected-readiness-proposal.json');
const INV3_DEFINITION = loadFixture('glm-e4d-inv3-definition.md');
const INV5_PROPOSAL = loadFixture('glm-e4d-inv5-rejected-readiness-proposal.json');
const INV5_DEFINITION = loadFixture('glm-e4d-inv5-definition.md');

function ctxWithDefinition(definitionText: string): OutputContractContext {
  return { inputArtifacts: { 'definition.md': definitionText } };
}

function decodeAndValidate(text: string, ctx: OutputContractContext) {
  const decoded = READINESS_PROPOSAL_SCHEMA.safeParse(JSON.parse(text));
  assert.ok(decoded.success, 'fixture proposals must decode');
  return READINESS_OUTPUT_CONTRACT.validate!(decoded.data, ctx);
}

function ledgerIds(definitionText: string): string[] {
  return parseDefinition(definitionText).definition.facts.map((f) => f.id);
}

// ─── 1 + 2: repair-interface closure ──────────────────────────────────────────

describe('DDR-037 A — factId defects expose the legal candidate set', () => {
  it('near-miss factId (UNRESOLVED) repair lists every legal id of the current Definition', () => {
    const defects = decodeAndValidate(INV3_PROPOSAL, ctxWithDefinition(INV3_DEFINITION));
    const unresolved = defects.filter((d) => d.code === 'GAP_FACT_ID_UNRESOLVED');
    assert.ok(unresolved.length >= 1, 'historical rejection must reproduce');
    for (const id of ledgerIds(INV3_DEFINITION)) {
      for (const d of unresolved) {
        assert.ok(d.message.includes(id), `repair for ${id} must name the legal candidate`);
      }
    }
    assert.ok(unresolved.every((d) => d.message.includes('never invent or paraphrase')));
  });

  it('missing factId (MISSING) repair lists the legal set AND the CAN_RESOLVE fallback rule', () => {
    const defects = decodeAndValidate(INV5_PROPOSAL, ctxWithDefinition(INV5_DEFINITION));
    const missing = defects.filter((d) => d.code === 'GAP_FACT_ID_MISSING');
    assert.ok(missing.length >= 1, 'historical rejection must reproduce');
    for (const id of ledgerIds(INV5_DEFINITION)) {
      for (const d of missing) {
        assert.ok(d.message.includes(id), `repair for ${id} must name the legal candidate`);
      }
    }
    assert.ok(missing.every((d) => d.message.includes('CAN_RESOLVE')));
  });

  it('without a resolvable ledger the messages stay informationally honest (no invented ids)', () => {
    const defects = decodeAndValidate(INV3_PROPOSAL, { workItemId: 'wi' });
    const factIdDefects = defects.filter(
      (d) => d.code.startsWith('GAP_FACT_ID') || d.code === 'GAP_LEDGER_UNAVAILABLE',
    );
    assert.ok(factIdDefects.length >= 1, 'no-ledger ctx must still fail closed on fact identity');
    for (const d of factIdDefects) {
      for (const id of ledgerIds(INV3_DEFINITION)) {
        assert.ok(!d.message.includes(id), 'no legal-set claim without the trusted ledger');
      }
    }
  });
});

// ─── 3 + 4 + 5: the initial candidate-list teaching ───────────────────────────

describe('DDR-037 C — context teaching is a pure projection of the canonical ledger', () => {
  it('surfaces the exact fact IDs of the current Definition before the first submission', () => {
    const teaching = READINESS_OUTPUT_CONTRACT.contextTeaching!(ctxWithDefinition(INV3_DEFINITION));
    assert.ok(teaching !== undefined);
    for (const id of ledgerIds(INV3_DEFINITION)) {
      assert.ok(teaching.includes(`- ${id}`), `candidate list must contain ${id}`);
    }
    assert.ok(teaching.includes('VALID FACT IDs'));
  });

  it('is derived ONLY from the trusted declared definition.md input', () => {
    const a = READINESS_OUTPUT_CONTRACT.contextTeaching!(ctxWithDefinition(INV3_DEFINITION));
    const b = READINESS_OUTPUT_CONTRACT.contextTeaching!(ctxWithDefinition(INV3_DEFINITION));
    assert.equal(a, b, 'deterministic: same trusted context, same projection');
    const other = READINESS_OUTPUT_CONTRACT.contextTeaching!(ctxWithDefinition(INV5_DEFINITION));
    assert.notEqual(a, other, 'different ledger, different list');
    for (const id of ledgerIds(INV3_DEFINITION)) {
      if (!ledgerIds(INV5_DEFINITION).includes(id)) {
        assert.ok(!other.includes(`- ${id}`), 'stale ids must not leak across ledgers');
      }
    }
  });

  it('never invents a list: absent or unparseable ledger contributes nothing', () => {
    assert.equal(READINESS_OUTPUT_CONTRACT.contextTeaching!({ workItemId: 'wi' }), undefined);
    assert.equal(
      READINESS_OUTPUT_CONTRACT.contextTeaching!({ inputArtifacts: { 'definition.md': 'not a definition' } }),
      undefined,
    );
  });

  it('renderResultTeaching appends the projection and stays byte-stable without a hook or context', () => {
    const base = renderSchemaTeaching(READINESS_OUTPUT_CONTRACT);
    assert.equal(renderResultTeaching(READINESS_OUTPUT_CONTRACT), base);
    assert.equal(renderResultTeaching(READINESS_OUTPUT_CONTRACT, { workItemId: 'wi' }), base);
    const full = renderResultTeaching(READINESS_OUTPUT_CONTRACT, ctxWithDefinition(INV3_DEFINITION));
    assert.ok(full.startsWith(base));
    assert.ok(full.length > base.length);
    assert.ok(full.includes('- f-xplat-undecided'));
  });

  it('no persisted second authority: the schema stays an unconstrained optional string', () => {
    const projection = toJsonSchema(READINESS_PROPOSAL_SCHEMA) as {
      properties?: { gaps?: { items?: { properties?: Record<string, unknown> } } };
    };
    const factId = projection.properties?.gaps?.items?.properties?.factId as { type?: string } | undefined;
    assert.ok(factId !== undefined, '/gaps/items/factId must resolve against the projection');
    assert.equal(factId.type, 'string');
    assert.equal(READINESS_PROPOSAL_SCHEMA.shape.gaps.element.shape.factId.isOptional(), true);
  });
});

// ─── 6: the audit counterfactual, pinned on the historical bytes ─────────────

describe('DDR-037 E — historical E4-D counterfactual regression', () => {
  it('inv3: correcting ONLY the two invented factIds flips rejection to full acceptance', () => {
    const corrected = INV3_PROPOSAL
      .replaceAll('"cross-platform-increment-membership"', '"f-xplat-undecided"')
      .replaceAll('"netcore-approach-feasibility"', '"f-csp-unmeasured"');
    assert.notEqual(corrected, INV3_PROPOSAL, 'substitution must touch bytes');
    assert.deepEqual(decodeAndValidate(corrected, ctxWithDefinition(INV3_DEFINITION)), []);
  });

  it('inv5: inserting ONLY the two omitted factIds flips rejection to full acceptance', () => {
    const proposal = JSON.parse(INV5_PROPOSAL);
    proposal.gaps[0].factId = 'f-cross-platform-undecided';
    proposal.gaps[1].factId = 'f-prediction-feasibility';
    assert.deepEqual(decodeAndValidate(JSON.stringify(proposal), ctxWithDefinition(INV5_DEFINITION)), []);
  });

  it('the uncorrected historical proposals still reproduce their historical rejections', () => {
    const inv3 = decodeAndValidate(INV3_PROPOSAL, ctxWithDefinition(INV3_DEFINITION));
    assert.ok(inv3.some((d) => d.code === 'GAP_FACT_ID_UNRESOLVED' && d.ref === 'cross-platform-increment-membership'));
    const inv5 = decodeAndValidate(INV5_PROPOSAL, ctxWithDefinition(INV5_DEFINITION));
    assert.ok(inv5.every((d) => d.code === 'GAP_FACT_ID_MISSING'));
  });
});

// ─── 7 + 8 + 9: MATURE fixture closure, strictness preserved ──────────────────

describe('DDR-037 D — MATURE fixture is genuinely mature, criterion unchanged', () => {
  it('the objective now supplies the repository-verified event-source knowledge', () => {
    const text = JSON.stringify(MATURE_OBJECTIVE);
    assert.ok(text.includes('src/domain/objective-events.ts'));
    assert.ok(text.includes('ObjectiveEventRepository.listByObjective'));
    assert.ok(text.includes('already recorded'));
  });

  it('the harness oracle still demands iteration 1 — corrected fixture, not a loosened bar (pins 8+9)', () => {
    const harnessSource = readFileSync(new URL('./fixtures/d3d/harness.ts', import.meta.url), 'utf8');
    const pinLine = harnessSource
      .split('\n')
      .find((l) => l.includes("check('iterations = 1'"));
    assert.ok(pinLine !== undefined, 'the iterations = 1 check must remain the MATURE criterion');
    assert.ok(
      pinLine!.includes('iterationsUsed === 1'),
      'and it must still compare against exactly 1',
    );
  });

  it('the readiness schema annotation teaches exact-copy semantics for /gaps/items/factId', () => {
    const note = READINESS_OUTPUT_CONTRACT.schemaAnnotations?.fields?.['/gaps/items/factId'];
    assert.ok(note !== undefined);
    assert.ok(note!.includes('EXACTLY'));
    assert.ok(note!.includes('CAN_RESOLVE'));
  });
});
