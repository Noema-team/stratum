// DDR-039 — oracle identity join regressions. E4-G inv 4 (EARLY) proved the
// lexical platform-scope Decision selector selectable by a DIFFERENT
// Decision that merely cited the cross-platform fact: the run raised a
// session-topology question first (whose option text mentions "the host
// platform constrains the cross-platform question (f2)") and then the
// genuine scope question, bound to fact F2 by the DDR-036 durable
// targetFactId and offering the exclusion option the human resolved to.
// The lexical find() took the topology Decision and failed six checks.
//
// This closure replaces "which Decision sounds like the scope Decision"
// with "which Decision owns the platform-scope fact" — the fact is still
// found semantically in the final Definition, then joined by exact
// targetFactId, failing closed on zero or multiple matches on either side.
// Fixtures pinned byte-for-byte from the E4-G inv 4 persisted evidence:
// the Definition as committed, the two Decisions as recorded, and the
// scope Decision's targetFactId (F2) from its persisted decision-request
// artifact (work/wi-d3d-early/decision-request.json).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { oracleEarly, findFactsAboutWithIds, type DefineWorkTrace, type DecisionSummary } from './fixtures/d3d/harness.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, 'fixtures/d34/ddr039');

const E4G_INV4_DEFINITION = readFileSync(join(FIXTURES, 'e4g-inv4-definition.md'), 'utf8');
const E4G_INV4_DECISIONS: Array<DecisionSummary & { targetFactId?: string }> = JSON.parse(
  readFileSync(join(FIXTURES, 'e4g-inv4-decisions.json'), 'utf8'),
).decisions;
// The scope Decision is the one bound to F2 by the persisted request
// artifact; the topology Decision is pinned UNBOUND (its first durable
// attempt provably carried no targetFactId — cycle 1's apply-human-decision
// was rejected DECISION_APPLICATION_DECISION_UNLINKED).
const TOPOLOGY_DECISION = { ...E4G_INV4_DECISIONS[0], targetFactId: undefined };
const SCOPE_DECISION = { ...E4G_INV4_DECISIONS[1], targetFactId: 'F2' };

const JOIN_CHECK_NAMES = [
  'a Decision genuinely concerns whether cross-platform support belongs in this bounded increment',
  'the platform-scope Decision offers a legitimate same-platform-only option and was resolved to it',
];

function traceOf(definitionText: string, decisions: DecisionSummary[]): DefineWorkTrace {
  return {
    scenarioId: 'early',
    workflowRunId: 'test-run',
    finalStatus: 'complete',
    finalStepId: 'commit',
    iterationsUsed: 1,
    steps: [],
    decisions,
    artifacts: [],
    definitionText,
    readinessText: '',
    explorationNeedText: 'latency/frame budget feasibility must be measured',
    toolUseRoundTrips: 1,
    noExtraWorkItemsCreated: true,
  };
}

function scopeChecks(trace: DefineWorkTrace) {
  return oracleEarly(trace).checks.filter((c) => JOIN_CHECK_NAMES.includes(c.name));
}

describe('DDR-039 oracle identity join', () => {
  it('pinned E4-G inv 4: both Decisions satisfy the retired lexical predicates — the adversarial property that broke find()', () => {
    // Canary: if anyone reintroduces lexical selection over this text, it
    // selects the topology Decision first — exactly the E4-G inv 4 false
    // negative. Both texts match /cross-?platform/ AND the scope-verb
    // family; only the identity join separates them.
    for (const d of [TOPOLOGY_DECISION, SCOPE_DECISION]) {
      const text = (
        `${d.title} ${d.summary} ` +
        d.options.map((o) => `${o.label} ${o.description ?? ''}`).join(' ')
      ).toLowerCase();
      assert.match(text, /cross-?platform/);
      assert.match(text, /(scope|increment|belongs?|includ|exclud|support)/);
    }
  });

  it('pinned E4-G inv 4: the identity join selects the scope Decision and passes the two misselection-falsified checks', () => {
    // The durable decision ids are unrecoverable (in-memory run state was
    // discarded; persisted evidence carries none), so fixture ids are
    // assigned and the id-citation check is exercised separately below —
    // on the real run its truth depended on the committed Definition
    // citing the scope Decision's real id, which cannot be re-derived
    // from the persisted evidence either way.
    const trace = traceOf(E4G_INV4_DEFINITION, [
      { ...TOPOLOGY_DECISION, selectedOptionId: TOPOLOGY_DECISION.options[0].id },
      { ...SCOPE_DECISION, selectedOptionId: SCOPE_DECISION.options.find((o) => o.id === 'exclude-non-goal')?.id },
    ]);
    const checks = scopeChecks(trace);
    assert.equal(checks.length, 2);
    for (const c of checks) assert.equal(c.pass, true, `${c.name}: ${c.detail}`);
    // The join's selected Decision is the scope one, not the lexically
    // first-matching topology one.
    assert.match(checks[1].detail ?? '', /Does cross-platform support belong/);
  });

  it('the id-citation check still fails when the Definition does not cite the joined Decision\'s real id', () => {
    const trace = traceOf(E4G_INV4_DEFINITION, [
      { ...TOPOLOGY_DECISION, id: 'dec-topology-fixture', selectedOptionId: TOPOLOGY_DECISION.options[0].id },
      { ...SCOPE_DECISION, id: 'dec-scope-fixture', selectedOptionId: 'exclude-non-goal' },
    ]);
    const idCheck = oracleEarly(trace).checks.find(
      (c) => c.name === 'the final Definition references the resolved platform-scope Decision\'s real id',
    );
    assert.ok(idCheck);
    assert.equal(idCheck.pass, false); // pinned Definition cites fact ids, not decision ids
    const withCitation = traceOf(
      E4G_INV4_DEFINITION + '\n## Provenance\n- Scope resolved by decision dec-scope-fixture (exclude-non-goal).\n',
      trace.decisions,
    );
    const idCheck2 = oracleEarly(withCitation).checks.find(
      (c) => c.name === 'the final Definition references the resolved platform-scope Decision\'s real id',
    );
    assert.ok(idCheck2?.pass, idCheck2?.detail);
  });

  it('fails closed when no Decision owns the platform-scope fact', () => {
    const trace = traceOf(E4G_INV4_DEFINITION, [
      { ...TOPOLOGY_DECISION, targetFactId: undefined, selectedOptionId: TOPOLOGY_DECISION.options[0].id },
    ]);
    const checks = scopeChecks(trace);
    assert.ok(checks.every((c) => !c.pass));
    assert.match(checks[0].detail ?? '', /decisions owning fact F2 by targetFactId: 0/);
  });

  it('fails closed when multiple Decisions claim the same platform-scope fact', () => {
    const trace = traceOf(E4G_INV4_DEFINITION, [
      { ...TOPOLOGY_DECISION, targetFactId: 'F2', selectedOptionId: TOPOLOGY_DECISION.options[0].id },
      { ...SCOPE_DECISION, selectedOptionId: 'exclude-non-goal' },
    ]);
    const checks = scopeChecks(trace);
    assert.ok(checks.every((c) => !c.pass));
    assert.match(checks[0].detail ?? '', /decisions owning fact F2 by targetFactId: 2/);
  });

  it('fails closed when the Definition carries multiple cross-platform facts', () => {
    const definition = E4G_INV4_DEFINITION.replace(
      '- id: F10',
      '- id: F10-dup\n    statement: >-\n      A second entry also discussing whether cross-platform play belongs in scope.\n    status: UNKNOWN\n    source: human\n  - id: F10',
    );
    const facts = findFactsAboutWithIds(definition, /cross-?platform/i);
    assert.equal(facts.length, 2);
    const checks = scopeChecks(traceOf(definition, [{ ...SCOPE_DECISION }]));
    assert.ok(checks.every((c) => !c.pass));
    assert.match(checks[0].detail ?? '', /facts about cross-platform: 2/);
  });

  it('fails closed when the Definition carries no cross-platform fact at all', () => {
    const definition = E4G_INV4_DEFINITION.replace(/cross-?platform/gi, 'interconnect');
    const checks = scopeChecks(traceOf(definition, [{ ...SCOPE_DECISION }]));
    assert.ok(checks.every((c) => !c.pass));
    assert.match(checks[0].detail ?? '', /facts about cross-platform: 0/);
  });

  it('findFactsAboutWithIds extracts durable ids on canonical and legacy ledgers', () => {
    assert.deepEqual(
      findFactsAboutWithIds(E4G_INV4_DEFINITION, /cross-?platform/i).map((f) => f.id),
      ['F2'],
    );
    const legacy = [
      '## Facts',
      '- id: f9',
      '  statement: Whether cross-platform play belongs in this bounded increment.',
      '  status: UNKNOWN',
      '  source: human',
      '- id: f10',
      '  statement: The repository has no networking code.',
      '  status: KNOWN',
      '  source: repository',
    ].join('\n');
    assert.deepEqual(
      findFactsAboutWithIds(legacy, /cross-?platform/i).map((f) => f.id),
      ['f9'],
    );
  });
});
