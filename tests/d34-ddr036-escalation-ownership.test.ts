// DDR-036 — escalation-ownership regressions. Every test here pins a
// failure signature actually observed in E4-A/E4-B qualification (see
// docs/decisions/ddr-036-escalation-ownership.md and eval-reports/E4B-review.md),
// or the adversarial variant the operator pre-registered:
//
//   1. a human decision can never lose the original gap/fact identity;
//   2. a resolved Decision can never be applied to the wrong fact;
//   3. decisionRef must be the real persisted Decision id — the model
//      cannot invent or omit it (it cannot author it AT ALL);
//   4. a Decision resolved for fact A cannot mark fact B DECIDED;
//   5. EXPLORE_AS_WORK cannot route to commit without its artifact
//      (workflow-level composition via the runner's declared-output
//      invariant + the contract path);
//   6. an exploration need stays linked to the exact originating fact;
//   + adversarial: a legacy/unlinked decision-request never gets its target
//     inferred from prose; an identity-bearing field submitted by the model
//     is rejected as unknown, never stripped.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { renderDefinition, definitionProposalFromPersisted } from '../src/workflow/methodology/definition-contract.js';
import { parseDefinition } from '../src/workflow/methodology/definition-artifact.js';
import { READINESS_OUTPUT_CONTRACT } from '../src/workflow/methodology/readiness-contract.js';
import { renderReadiness } from '../src/workflow/methodology/readiness-contract.js';
import {
  createDecisionRequestOutputContract,
  createDecisionApplicationOutputContract,
  createExplorationNeedOutputContract,
  DECISION_REQUEST_PROPOSAL_SCHEMA,
  DECISION_APPLICATION_PROPOSAL_SCHEMA,
  parseExplorationNeed,
  renderExplorationNeed,
} from '../src/workflow/methodology/escalation-contracts.js';
import type { OutputContractContext } from '../src/workflow/contracts.js';

// ─── fixture builders ─────────────────────────────────────────────────────────

const DECISION_ID = 'dec-e2d-7f3a';
const WORK_ITEM = 'wi-ddr036';

const BASE_DEFINITION = renderDefinition({
  goal: 'Make Evershift multiplayer-capable',
  facts: [
    { id: 'current-single-player', statement: 'The game runs a single local simulation tick.', status: 'KNOWN', source: 'repository' },
    { id: 'cross-platform-scope', statement: 'Whether cross-platform support belongs to this increment is undecided.', status: 'UNKNOWN', source: 'human' },
    { id: 'sync-latency-feasibility', statement: 'Whether prediction can meet the latency budget is unmeasured.', status: 'UNKNOWN', source: 'human' },
  ],
  bodyMarkdown: '## Context\nSingle-player today.',
});

function readinessArtifact(gaps: Array<Record<string, unknown>>): string {
  return renderReadiness({
    verdict: 'fail',
    gaps: gaps as never,
    bodyMarkdown: 'review body',
  });
}

const HUMAN_GAP_READINESS = readinessArtifact([
  {
    target: 'cross-platform scope is undecided',
    factId: 'cross-platform-scope',
    description: 'The scope boundary is not decidable by an engineer.',
    classification: 'HUMAN_DECISION',
    reason: 'Product scope authority belongs to the human.',
    closure: 'A human chooses whether cross-platform is in this increment.',
  },
  {
    target: 'latency feasibility is unmeasured',
    factId: 'sync-latency-feasibility',
    description: 'Prediction latency has never been measured.',
    classification: 'EXPLORE_AS_WORK',
    reason: 'Requires building a measurement, not reading.',
    closure: 'A bounded benchmark answers it.',
  },
]);

function decisionRequestJson(targetFactId: string): string {
  return (
    JSON.stringify(
      {
        type: 'human_decision',
        targetFactId,
        title: 'Cross-platform scope',
        summary: 'Does cross-platform belong to this increment?',
        options: [
          { id: 'same-platform', label: 'Same-platform only', description: 'Ship multiplayer on current platforms.' },
          { id: 'cross-platform', label: 'Include cross-platform', description: 'Require cross-platform play now.' },
        ],
      },
      null,
      2,
    ) + '\n'
  );
}

function ctx(overrides: Partial<OutputContractContext> = {}): OutputContractContext {
  return {
    workItemId: WORK_ITEM,
    inputArtifacts: {
      '.sle/work/wi-ddr036/definition.md': BASE_DEFINITION,
      '.sle/work/wi-ddr036/readiness.md': HUMAN_GAP_READINESS,
      '.sle/work/wi-ddr036/decision-request.json': decisionRequestJson('cross-platform-scope'),
    },
    decisionContext: {
      decisionId: DECISION_ID,
      selectedOptionId: 'same-platform',
      selectedOptionLabel: 'Same-platform only',
      rationale: 'Ship the increment first.',
      targetFactId: 'cross-platform-scope',
    },
    ...overrides,
  };
}

const findDecision = (ref: string) =>
  ref === DECISION_ID ? { workItemId: WORK_ITEM } : undefined;

// ─── 1. escalation identity is required at the readiness boundary ─────────────

describe('DDR-036 regression: readiness gap identity', () => {
  it('an escalating gap without factId is a defect (E4: identity lost to prose)', () => {
    const defects = READINESS_OUTPUT_CONTRACT.validate!(
      {
        verdict: 'fail',
        gaps: [
          {
            target: 'scope question',
            description: 'undecided',
            classification: 'HUMAN_DECISION',
            reason: 'product authority',
            closure: 'a human decides',
          },
        ],
        bodyMarkdown: '',
      } as never,
      ctx(),
    );
    assert.ok(defects.some((d) => d.code === 'GAP_FACT_ID_MISSING'));
  });

  it('a factId that does not exist in the current Definition is a defect', () => {
    const defects = READINESS_OUTPUT_CONTRACT.validate!(
      {
        verdict: 'fail',
        gaps: [
          {
            target: 'scope question',
            factId: 'invented-fact-id',
            description: 'undecided',
            classification: 'HUMAN_DECISION',
            reason: 'product authority',
            closure: 'a human decides',
          },
        ],
        bodyMarkdown: '',
      } as never,
      ctx(),
    );
    assert.ok(defects.some((d) => d.code === 'GAP_FACT_ID_UNRESOLVED'));
  });

  it('CAN_RESOLVE without factId stays legitimate (a missing entry is itself the defect)', () => {
    const defects = READINESS_OUTPUT_CONTRACT.validate!(
      {
        verdict: 'fail',
        gaps: [
          {
            target: 'missing acceptance criterion',
            description: 'no acceptance for requirement X',
            classification: 'CAN_RESOLVE',
            reason: 'derivable',
            closure: 'add the criterion',
          },
        ],
        bodyMarkdown: '',
      } as never,
      ctx(),
    );
    assert.deepEqual(defects, []);
  });
});

// ─── 2/3. decision-request: selection validated, linkage always materialized ──

describe('DDR-036 regression: decision-request linkage', () => {
  const contract = createDecisionRequestOutputContract();

  it('a request whose targetFactId is not a current HUMAN_DECISION gap is a defect (cannot lose the gap)', () => {
    const defects = contract.validate(
      {
        type: 'human_decision',
        targetFactId: 'sync-latency-feasibility', // EXPLORE_AS_WORK, not HUMAN_DECISION
        title: 't',
        summary: 's',
        options: [{ id: 'a', label: 'A', description: 'a' }],
      },
      ctx(),
    );
    assert.ok(defects.some((d) => d.code === 'DECISION_REQUEST_TARGET_NOT_HUMAN_GAP'));
  });

  it('materialized bytes ALWAYS carry targetFactId', () => {
    const bytes = contract.materialize(
      {
        type: 'human_decision',
        targetFactId: 'cross-platform-scope',
        title: 't',
        summary: 's',
        options: [{ id: 'a', label: 'A', description: 'a' }],
      },
      ctx(),
    );
    const parsed = JSON.parse(bytes);
    assert.equal(parsed.targetFactId, 'cross-platform-scope');
  });

  it('no readable readiness → fail closed, never guessed', () => {
    const defects = contract.validate(
      {
        type: 'human_decision',
        targetFactId: 'cross-platform-scope',
        title: 't',
        summary: 's',
        options: [{ id: 'a', label: 'A', description: 'a' }],
      },
      ctx({ inputArtifacts: undefined }),
    );
    assert.ok(defects.some((d) => d.code === 'READINESS_UNAVAILABLE'));
  });
});

// ─── 4. decision-application: the mechanical transition is unauthoable ────────

describe('DDR-036 regression: decision-application merge', () => {
  const contract = createDecisionApplicationOutputContract({ findDecision });

  it('the target fact transitions DECIDED on the REAL Decision id; every other fact carries over verbatim', () => {
    const bytes = contract.materialize(
      { bodyMarkdown: 'Resolution recorded.' },
      ctx(),
    );
    const { definition } = parseDefinition(bytes);
    const decided = definition.facts.find((f) => f.id === 'cross-platform-scope');
    assert.equal(decided?.status, 'DECIDED');
    assert.equal(decided?.source, 'decision');
    assert.equal(decided?.decisionRef, DECISION_ID);
    // untouched facts — byte-stable statements
    const other = definition.facts.find((f) => f.id === 'sync-latency-feasibility');
    assert.equal(other?.status, 'UNKNOWN');
    assert.equal(other?.decisionRef, undefined);
    const persisted = definition.facts.find((f) => f.id === 'current-single-player');
    assert.equal(persisted?.status, 'KNOWN');
  });

  it('the model has NO field for identity: decisionRef/status/targetFactId in a proposal are unknown-key rejections', () => {
    const rejected = DECISION_APPLICATION_PROPOSAL_SCHEMA.safeParse({
      bodyMarkdown: 'x',
      decisionRef: 'dec-invented',
      status: 'DECIDED',
      targetFactId: 'other-fact',
    });
    assert.ok(!rejected.success);
    const unrecognized = rejected.error.issues.filter((i) => i.code === 'unrecognized_keys') as unknown as Array<{ keys?: string[] }>;
    assert.ok(unrecognized.length >= 1);
    const named = unrecognized.flatMap((i) => i.keys ?? []).join(',');
    for (const field of ['decisionRef', 'status', 'targetFactId']) {
      assert.ok(named.includes(field), `${field} must be rejected as unknown, never stripped`);
    }
  });

  it('adversarial: a Decision for fact A can never mark fact B — there is no path to another fact', () => {
    // The proposal carries no fact array at all; the merge maps ONLY the
    // trusted target. Simulate the strongest attack: section replacement
    // attempting to smuggle a second DECIDED via constraints.
    const bytes = contract.materialize(
      {
        constraints: [{ description: 'Same-platform only this increment.', type: 'must' }],
        bodyMarkdown: 'Scope settled.',
      },
      ctx(),
    );
    const { definition } = parseDefinition(bytes);
    assert.equal(definition.facts.filter((f) => f.status === 'DECIDED').length, 1);
    assert.equal(definition.facts.filter((f) => f.status === 'DECIDED')[0].id, 'cross-platform-scope');
  });

  it('adversarial: a legacy/unlinked decision-request NEVER gets its target inferred from prose', () => {
    const legacy = ctx({
      inputArtifacts: {
        '.sle/work/wi-ddr036/definition.md': BASE_DEFINITION,
        '.sle/work/wi-ddr036/readiness.md': HUMAN_GAP_READINESS,
        '.sle/work/wi-ddr036/decision-request.json': JSON.stringify({
          type: 'human_decision',
          title: 'Cross-platform scope',
          summary: 'Does cross-platform belong to this increment?',
          options: [{ id: 'a', label: 'A', description: 'a' }],
        }),
      },
    });
    const defects = contract.validate({ bodyMarkdown: 'x' }, legacy);
    assert.ok(defects.some((d) => d.code === 'DECISION_APPLICATION_LEGACY_UNLINKED'));
  });

  it('a diverged request (target fact absent from the ledger) fails explicitly', () => {
    const diverged = ctx({
      inputArtifacts: {
        '.sle/work/wi-ddr036/definition.md': BASE_DEFINITION,
        '.sle/work/wi-ddr036/readiness.md': HUMAN_GAP_READINESS,
        '.sle/work/wi-ddr036/decision-request.json': decisionRequestJson('fact-that-vanished'),
      },
      decisionContext: {
        decisionId: DECISION_ID,
        selectedOptionId: 'same-platform',
        targetFactId: 'fact-that-vanished', // durable + request AGREE on a fact the ledger lost
      },
    });
    const defects = contract.validate({ bodyMarkdown: 'x' }, diverged);
    assert.ok(defects.some((d) => d.code === 'DECISION_APPLICATION_TARGET_MISSING'));
  });

  it('REVIEW CLOSURE: a valid-A → valid-B request substitution after the checkpoint fails closed — neither fact changes', () => {
    // The durable Decision was created for fact A (threaded authoritatively
    // through DecisionContext); the mutable request artifact now VALIDLY
    // targets fact B. No model misbehavior — application must still refuse.
    const substituted = ctx({
      inputArtifacts: {
        '.sle/work/wi-ddr036/definition.md': BASE_DEFINITION,
        '.sle/work/wi-ddr036/readiness.md': HUMAN_GAP_READINESS,
        // both facts exist and are legitimately in the ledger — the
        // substitution is fully "valid" from the request's perspective
        '.sle/work/wi-ddr036/decision-request.json': decisionRequestJson('sync-latency-feasibility'),
      },
    });
    const defects = contract.validate({ bodyMarkdown: 'x' }, substituted);
    assert.ok(defects.some((d) => d.code === 'DECISION_APPLICATION_TARGET_MISMATCH'));
    // and materialization refuses too — neither fact transitions
    assert.throws(() => contract.materialize({ bodyMarkdown: 'x' }, substituted));
  });

  it('REVIEW CLOSURE: a Decision without its durable target binding fails closed (never inferred from the request alone)', () => {
    const unlinked = ctx({ decisionContext: { decisionId: DECISION_ID, selectedOptionId: 'same-platform' } });
    const defects = contract.validate({ bodyMarkdown: 'x' }, unlinked);
    assert.ok(defects.some((d) => d.code === 'DECISION_APPLICATION_DECISION_UNLINKED'));
  });

  it('without a resolved DecisionContext the application fails closed', () => {
    const defects = contract.validate({ bodyMarkdown: 'x' }, ctx({ decisionContext: undefined }));
    assert.ok(defects.some((d) => d.code === 'DECISION_APPLICATION_NO_RESOLVED_DECISION'));
  });

  it('the merged Definition must still pass the full deterministic validator — an invented decision id fails', () => {
    const defects = contract.validate(
      { bodyMarkdown: 'x' },
      ctx({ decisionContext: { decisionId: 'dec-not-in-repo', selectedOptionId: 'same-platform', targetFactId: 'cross-platform-scope' } }),
    );
    // findDecision only resolves DECISION_ID → the merge's decisionRef does
    // not resolve → the Definition validator rejects it.
    assert.ok(defects.some((d) => d.code === 'DECISION_REF_UNRESOLVED' || /decisionRef/.test(d.message)));
  });
});

// ─── 5/6. exploration-need: linked, canonical, and composition-enforced ──────

describe('DDR-036 regression: exploration-need', () => {
  const contract = createExplorationNeedOutputContract();

  it('stays linked to the exact originating fact; a non-EXPLORE_AS_WORK target is a defect', () => {
    const defects = contract.validate(
      {
        targetFactId: 'cross-platform-scope', // HUMAN_DECISION gap
        question: 'q',
        whyNotResolvableByReading: 'w',
        requiredWork: 'r',
        completionEvidence: 'c',
      },
      ctx(),
    );
    assert.ok(defects.some((d) => d.code === 'EXPLORATION_NEED_TARGET_NOT_EXPLORE_GAP'));
  });

  it('canonical bytes carry versioned front matter with the fact linkage', () => {
    const bytes = contract.materialize(
      {
        targetFactId: 'sync-latency-feasibility',
        question: 'Can prediction meet the latency budget?',
        whyNotResolvableByReading: 'No measurement exists.',
        requiredWork: 'Benchmark prototype.',
        completionEvidence: 'Measured frame budget report.',
      },
      ctx(),
    );
    assert.ok(bytes.startsWith('---\n'));
    const parsed = parseExplorationNeed(bytes);
    assert.ok(parsed.ok && !parsed.legacy);
    if (parsed.ok && !parsed.legacy) {
      assert.equal(parsed.value.targetFactId, 'sync-latency-feasibility');
    }
  });

  it('legacy free-form markdown loads tolerant and legacy — carrying NO linkage authority', () => {
    const parsed = parseExplorationNeed('# Exploration\nSome free-form need.');
    assert.ok(parsed.ok && parsed.legacy);
  });

  it('REVIEW CLOSURE: the canonical body survives render → parse exactly, and re-render is byte-stable', () => {
    const proposal = {
      targetFactId: 'sync-latency-feasibility',
      question: 'Can prediction meet the budget?',
      whyNotResolvableByReading: 'No measurement exists.',
      requiredWork: 'Benchmark prototype.',
      completionEvidence: 'Measured frame budget report.',
      bodyMarkdown: 'important human explanation\n\nwith paragraphs — preserved exactly',
    };
    const bytes = renderExplorationNeed(proposal, ctx());
    const parsed = parseExplorationNeed(bytes);
    assert.ok(parsed.ok && !parsed.legacy);
    if (parsed.ok && !parsed.legacy) {
      assert.equal(parsed.value.bodyMarkdown, proposal.bodyMarkdown, 'the body must survive the envelope exactly');
      assert.equal(renderExplorationNeed(parsed.value, ctx()), bytes, 'render ∘ parse ∘ render is the identity');
    }
  });

  it('EXPLORE_AS_WORK cannot silently finish: the contract path writes exactly one artifact at the declared path (workflow composition)', async () => {
    // Workflow-level composition via the real harness: the explore route
    // runs record-exploration-need, whose declared output invariant +
    // registered contract means a successful step ALWAYS leaves the
    // canonical artifact behind, and commit follows only after success.
    // Driven end-to-end in tests/d3d-behavioral-qualification.test.ts
    // (EARLY scenario) — here we pin the mechanism the composition relies
    // on: a valid proposal materializes deterministic canonical bytes.
    const bytes = renderExplorationNeed(
      {
        targetFactId: 'sync-latency-feasibility',
        question: 'q',
        whyNotResolvableByReading: 'w',
        requiredWork: 'r',
        completionEvidence: 'c',
      },
      ctx(),
    );
    assert.ok(parseExplorationNeed(bytes).ok);
  });
});

// ─── compatibility posture ────────────────────────────────────────────────────

describe('DDR-036 regression: additive persisted compatibility', () => {
  it('a new readiness artifact with factId parses via the tolerant load path', async () => {
    const { parseReadinessArtifact } = await import('../src/workflow/methodology/readiness-artifact.js');
    const parsed = parseReadinessArtifact(HUMAN_GAP_READINESS);
    assert.equal(parsed.readiness.gaps[0].factId, 'cross-platform-scope');
  });

  it('an OLD readiness artifact without factId still parses (legacy)', async () => {
    const { parseReadinessArtifact } = await import('../src/workflow/methodology/readiness-artifact.js');
    const legacy = renderReadiness({
      verdict: 'fail',
      gaps: [
        {
          target: 't',
          description: 'd',
          classification: 'HUMAN_DECISION',
          reason: 'r',
          closure: 'c',
        },
      ] as never,
      bodyMarkdown: '',
    });
    const parsed = parseReadinessArtifact(legacy);
    assert.equal(parsed.readiness.gaps[0].factId, undefined);
  });
});
