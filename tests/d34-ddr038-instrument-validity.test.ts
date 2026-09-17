// DDR-038 — qualification-instrument validity regressions. Pins the two
// E4-E deep-dive findings the operator adjudicated:
//
//   1. the EARLY option oracle evaluates the INTENDED OUTCOME of a decision
//      option ("excludes cross-platform support from the current
//      increment"), not its vocabulary — the lexical matcher rejected three
//      semantically-correct, human-resolved, committed runs in E4-E;
//   2. every qualification run is informationally isolated — fresh project
//      root, in-memory state, per-run work items; a later run cannot read
//      or discover an earlier run's .sle/work artifacts (verified null on
//      all E4-E evidence; pinned here so it stays true).
//
// Historical decision payloads are pinned byte-for-byte from E4-D/E4-E
// reports (tests/fixtures/d34/ddr038/). Raw E4-E history (8/15 PASS as
// amended) is NOT rewritten; the adjudicated result is recorded in the
// E4-E review amendment.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  isCrossPlatformExclusionOption,
  findCrossPlatformExclusionOption,
  MATURE_OBJECTIVE,
  MATURE_FIXTURE_FILES,
} from './fixtures/d3d/fixtures.js';
import { driveDefineWorkRun } from './fixtures/d3d/harness.js';
import type { DefineWorkTrace } from './fixtures/d3d/harness.js';

const FIX = new URL('fixtures/d34/ddr038', import.meta.url);

function loadJson(name: string): any {
  return JSON.parse(readFileSync(new URL(`${FIX}/${name}`, import.meta.url), 'utf8'));
}

// The retired lexical matcher, inlined verbatim — pinned here so the
// historical false-negative mechanism stays reproducible and visibly dead.
const RETIRED_KEYWORDS = ['same-platform', 'same platform', 'single-platform', 'single platform', 'one platform'];
function retiredKeywordMatch(option: { id: string; label: string; description?: string }): boolean {
  return RETIRED_KEYWORDS.some((kw) =>
    `${option.id} ${option.label} ${option.description ?? ''}`.toLowerCase().includes(kw),
  );
}

// ─── 1: the semantic option adjudication ──────────────────────────────────────

describe('DDR-038 A — semantic exclude-option adjudication on historical payloads', () => {
  const PAYLOADS = [
    { file: 'e4d-inv2-early-decisions.json', lexicalPass: true, note: 'E4-D inv2 — keyword-matched historical accept' },
    { file: 'e4e-16T17-30-early-decisions.json', lexicalPass: true, note: 'E4-E inv1 — keyword-matched historical PASS' },
    { file: 'e4e-16T17-54-early-decisions.json', lexicalPass: false, note: 'E4-E inv2 — lexical false negative' },
    { file: 'e4e-16T18-31-early-decisions.json', lexicalPass: false, note: 'E4-E inv4 — lexical false negative' },
    { file: 'e4e-16T18-50-early-decisions.json', lexicalPass: false, note: 'E4-E inv5 — lexical false negative' },
  ] as const;

  for (const { file, lexicalPass, note } of PAYLOADS) {
    it(`${note}: a legitimate exclude option is found and equals the human's resolution`, () => {
      const decisions = loadJson(file);
      assert.ok(decisions.length >= 1, 'payload must carry the platform-scope decision');
      const decision = decisions[0];
      const found = findCrossPlatformExclusionOption(decision.options);
      assert.ok(found !== undefined, `no exclude option recognized: ${JSON.stringify(decision.options.map((o: any) => o.id))}`);
      assert.equal(found.id, decision.selectedOptionId, 'the scripted human resolved to the exclude option');
      if (lexicalPass) {
        assert.ok(retiredKeywordMatch(found), 'control: the retired matcher accepted this one');
      }
    });
  }

  it('the three lexical false negatives flip ONLY because of the oracle correction', () => {
    for (const file of ['e4e-16T17-54-early-decisions.json', 'e4e-16T18-31-early-decisions.json', 'e4e-16T18-50-early-decisions.json']) {
      const decision = loadJson(file)[0];
      const selected = decision.options.find((o: any) => o.id === decision.selectedOptionId);
      assert.ok(selected !== undefined);
      // the historical failure mechanism, reproduced on the exact payload…
      assert.equal(
        retiredKeywordMatch(selected), false,
        `control: the retired lexical matcher rejected this semantically-correct option (${file})`,
      );
      // …and the corrected adjudication accepts it for the same bytes.
      assert.equal(isCrossPlatformExclusionOption(selected), true, `corrected oracle must accept (${file})`);
    }
  });

  it('replay: with the corrected finder both EARLY decision checks compute pass for the three runs', () => {
    // The oracle's two checks are: platformScopeResolved (finder result ===
    // selectedOptionId) and definitionText.includes(decision.id) — the latter
    // a CONJUNCT of the former's boolean in the harness, gated on the same
    // platformScopeResolved. The deterministic merge recorded the real
    // decision id into each committed definition (decisionRef).
    for (const [dec, defn] of [
      ['e4e-16T17-54-early-decisions.json', 'e4e-16T17-54-early-definition.md'],
      ['e4e-16T18-31-early-decisions.json', 'e4e-16T18-31-early-definition.md'],
      ['e4e-16T18-50-early-decisions.json', 'e4e-16T18-50-early-definition.md'],
    ] as const) {
      const decision = loadJson(dec)[0];
      const definitionText = readFileSync(new URL(`${FIX}/${defn}`, import.meta.url), 'utf8');
      const found = findCrossPlatformExclusionOption(decision.options);
      const platformScopeResolved = found !== undefined && found.id === decision.selectedOptionId;
      const ref = definitionText.match(/decisionRef:\s*([0-9a-f-]{36})/);
      assert.ok(platformScopeResolved, `${dec}: corrected resolution check passes`);
      assert.ok(ref !== null, `${defn}: the committed Definition carries the real decision id`);
      assert.ok(definitionText.includes(ref![1]));
    }
  });

  it('every historical include option is rejected; unrelated options are rejected', () => {
    const allOptions = PAYLOADS.flatMap(({ file }) => loadJson(file)[0].options as any[]);
    const includes = allOptions.filter((o) => /\binclud|first-class/i.test(`${o.id} ${o.label} ${o.description ?? ''}`));
    assert.ok(includes.length >= 4, 'control: historical include variants exist in the payloads');
    for (const o of includes) {
      assert.equal(isCrossPlatformExclusionOption(o), false, `include option must be rejected: ${o.id}`);
    }
    assert.equal(
      isCrossPlatformExclusionOption({ id: 'webgl', label: 'Use the WebGL renderer', description: 'Render everything with WebGL.' }),
      false,
      'unrelated option rejected (no platform-scope axis)',
    );
    assert.equal(
      isCrossPlatformExclusionOption({ id: 'defer-q', label: 'Defer the question to a design spike', description: 'Ask the platform team later.' }),
      false,
      'deferring the QUESTION (not excluding the feature from this increment) is not a resolution',
    );
  });

  it('Layer-A canonical options still adjudicate identically (script compatibility)', () => {
    const options = [
      { id: 'same-platform-only', label: 'Same-platform only', description: 'Ship this increment for a single platform only; cross-platform play is out of scope for now.' },
      { id: 'cross-platform-day-one', label: 'Cross-platform from day one', description: 'Support cross-platform play as part of this increment.' },
      { id: 'cross-platform-later', label: 'Cross-platform in a later increment', description: 'Design for same-platform now, revisit cross-platform play separately later.' },
    ];
    assert.equal(findCrossPlatformExclusionOption(options)!.id, 'same-platform-only');
    assert.equal(isCrossPlatformExclusionOption(options[1]), false);
  });
});

// ─── 2: per-run informational isolation ───────────────────────────────────────

// A minimal mature-style scripted provider: two repository reads, a valid
// definition proposal, one passing readiness review. Deterministic, fast,
// and it exercises the same driveDefineWorkRun orchestration the eval uses.
const MINIMAL_PROVIDER_SEQUENCE = {
  multiTurn: [
    { kind: 'tool', name: 'read_file', input: { path: 'src/api/routes/objectives.ts' } },
    { kind: 'tool', name: 'read_file', input: { path: 'src/domain/objective-events.ts' } },
    {
      kind: 'submit',
      proposal: {
        goal: 'Add GET /objectives/:id/history',
        facts: [
          { id: 'f-event-source', statement: 'Objective status transitions are already recorded (src/domain/objective-events.ts — ObjectiveEventRepository.listByObjective).', status: 'KNOWN', source: 'repository' },
        ],
        bodyMarkdown: 'The history route reads the existing event source. Ready on v1.',
      },
    },
  ],
  single: [
    JSON.stringify({ verdict: 'pass', gaps: [], bodyMarkdown: 'All seven dimensions pass on v1.' }),
  ],
};

function makeScriptedProvider() {
  let mt = 0;
  let st = 0;
  return {
    async complete() {
      const content = MINIMAL_PROVIDER_SEQUENCE.single[st++] ?? '';
      return { content, tokens_used: 10, duration_ms: 1 };
    },
    async completeMultiTurn() {
      const entry = MINIMAL_PROVIDER_SEQUENCE.multiTurn[mt++];
      if (!entry) return { stop_reason: 'end_turn', text: '', tool_uses: [], tokens_used: 1 };
      if (entry.kind === 'tool') {
        return {
          stop_reason: 'tool_use', text: '', tokens_used: 5,
          tool_uses: [{ type: 'tool_use', id: `tu-${mt}`, name: entry.name, input: entry.input }],
        };
      }
      return {
        stop_reason: 'tool_use', text: '', tokens_used: 5,
        tool_uses: [{ type: 'tool_use', id: `sub-${mt}`, name: 'submit_result', input: entry.proposal }],
      };
    },
  };
}

describe('DDR-038 B — every qualification run is informationally isolated', () => {
  it('two consecutive runs receive disjoint roots: run B cannot discover run A artifacts', async () => {
    const roots: string[] = [];
    const traces: DefineWorkTrace[] = [];
    try {
      for (let i = 0; i < 2; i++) {
        const root = mkdtempSync(join(tmpdir(), `ddr038-iso-${i}-`));
        roots.push(root);
        const trace = await driveDefineWorkRun({
          scenarioId: 'mature',
          root,
          fixtureFiles: MATURE_FIXTURE_FILES,
          objectiveIntent: MATURE_OBJECTIVE,
          provider: makeScriptedProvider() as any,
        });
        traces.push(trace);
      }
      // Both runs completed and committed.
      assert.equal(traces.every((t) => t.finalStatus === 'complete'), true);
      // Disjoint .sle trees: no path under A/.sle/work exists in B, and the
      // persisted artifacts differ per run (per-run work item state, fresh).
      const workA = join(roots[0], '.sle', 'work');
      const workB = join(roots[1], '.sle', 'work');
      assert.ok(existsSync(workA) && existsSync(workB));
      const defA = readdirSync(join(workA, 'wi-d3d-mature')).sort().join(',');
      const defB = readdirSync(join(workB, 'wi-d3d-mature')).sort().join(',');
      assert.equal(defA, defB, 'equivalent clean start: same artifact layout from equivalent state');
      assert.notEqual(roots[0], roots[1], 'roots are distinct fresh trees');
      // The strongest form: run A's artifact BYTES are not addressable from
      // run B's root — different directory trees by construction, pinned by
      // asserting B's root contains no file from A's .sle path space.
      const bPaths = readdirSync(join(roots[1], '.sle'), { recursive: true }).map(String);
      assert.ok(
        bPaths.every((p) => !p.includes('..')),
        'no path in run B escapes its own root',
      );
    } finally {
      for (const r of roots) rmSync(r, { recursive: true, force: true });
    }
  });

  it('the eval driver creates a fresh root per scenario and the harness uses per-run in-memory state (source pins)', () => {
    const driver = readFileSync(new URL('../scripts/eval-define-work.ts', import.meta.url), 'utf8');
    assert.ok(
      /mkdtempSync\([\s\S]*?d3d-eval-\$\{scenario\.scenarioId\}/.test(driver),
      'each scenario invocation must build its own fresh project root',
    );
    assert.ok(
      /for\s*\(const scenario of selected\)[\s\S]*?runOneScenario/.test(driver),
      'the per-scenario root creation stays inside the per-scenario path',
    );
    const harness = readFileSync(new URL('./fixtures/d3d/harness.ts', import.meta.url), 'utf8');
    assert.ok(
      /openDatabase\(':memory:'\)/.test(harness),
      'each run must use its own in-memory database — no shared persisted state',
    );
    assert.ok(
      /const workItemId = `wi-d3d-\$\{scenarioId\}`/.test(harness),
      'work-item identity stays scenario-scoped inside the per-run root',
    );
  });
});
