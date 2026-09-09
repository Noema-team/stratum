// D.3d.5 commit 2 — canonical structured Definition + deterministic
// DefinitionValidator.
//
// Locks the new boundary:
//
//   LLM proposes a Definition artifact (YAML front matter + markdown body)
//     → parseDefinition (the SINGLE owner of the syntax; fail closed)
//     → validateDefinition (mechanical invariants ONLY)
//        ├ invalid → structured defects → CAN_RESOLVE → existing refine path
//        └ valid   → semantic readiness review (LLM) — as before
//
// The authority-boundary tests are as important as the validation tests:
// the validator must refuse to answer any semantic question (gap
// classification, route selection, default reasonableness, scope
// sufficiency) — those stay with semantic review.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseDefinition,
  validateDefinition,
  validateDefinitionArtifactText,
  createDefinitionInputValidator,
  DefinitionParseError,
  DEFINITION_SCHEMA_VERSION,
  type CanonicalDefinition,
} from '../src/workflow/methodology/definition-artifact.js';
import { DecisionRepository } from '../src/storage/repositories.js';
import { openDatabase } from '../src/storage/database.js';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { AgentRunner } from '../src/agent-runner.js';
import { AgentStepRunner } from '../src/execution/agent-step-runner.js';
import { WorkflowEngine, DEFINE_WORK } from '../src/workflow/index.js';
import { ContextManager, DEFAULT_CONFIG } from '../src/context-manager.js';
import type { WorkflowEngineDeps, StepRunContext } from '../src/workflow/types.js';
import type { ILLMProvider, LLMCompletionParams, LLMCompletionResult, MultiTurnParams, MultiTurnResult } from '../src/llm-provider.js';
import { driveDefineWorkRun } from './fixtures/d3d/harness.js';
import { EARLY_FIXTURE_FILES, EARLY_OBJECTIVE } from './fixtures/d3d/fixtures.js';
import type { RunArtifactManager } from '../src/run-artifacts.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fact(over: Partial<CanonicalDefinition['facts'][number]> & { id: string }): CanonicalDefinition['facts'][number] {
  return { statement: `statement for ${over.id}`, status: 'KNOWN', source: 'human', ...over } as CanonicalDefinition['facts'][number];
}

function canonical(over: Partial<CanonicalDefinition> = {}): CanonicalDefinition {
  return {
    schemaVersion: DEFINITION_SCHEMA_VERSION,
    goal: 'A single concrete outcome.',
    facts: [],
    ...over,
  };
}

function frontMatterArtifact(def: CanonicalDefinition, body = '## Design notes\n\nHuman rationale.'): string {
  // Emit via JSON (valid YAML) to keep the test honest about what a model
  // would produce through the textual transport.
  const fm = [
    '---',
    `schemaVersion: ${def.schemaVersion}`,
    `goal: ${JSON.stringify(def.goal)}`,
    'facts:',
    ...(def.facts.length > 0 ? def.facts.map((f) => '  - ' + JSON.stringify(f)) : ['[]'.length ? '  []' : '']),
    '---',
  ].join('\n');
  return `${fm}\n\n${body}`;
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

test('D.3d.5.2: valid YAML front matter parses into the typed Definition', () => {
  const text = [
    '---',
    'schemaVersion: 1',
    '"goal": "Ship the thing"',
    'facts:',
    '  - {"id":"F1","statement":"Repo has a cache.","status":"KNOWN","source":"repository"}',
    'constraints:',
    '  - {"description":"No new entities","type":"must_not"}',
    '---',
    '## Design notes',
    'Rationale lives here.',
  ].join('\n');
  const { definition, body } = parseDefinition(text);
  assert.equal(definition.schemaVersion, 1);
  assert.equal(definition.goal, 'Ship the thing');
  assert.equal(definition.facts[0].id, 'F1');
  assert.equal(definition.facts[0].status, 'KNOWN');
  assert.equal(definition.constraints?.[0].type, 'must_not');
  assert.ok(body.includes('Rationale lives here.'), 'the human body is preserved separately');
});

test('D.3d.5.2: malformed YAML fails closed', () => {
  const text = '---\nschemaVersion: 1\ngoal: [unclosed\n---\nbody';
  try {
    parseDefinition(text);
    assert.fail('expected DefinitionParseError');
  } catch (err) {
    assert.ok(err instanceof DefinitionParseError);
    assert.equal((err as DefinitionParseError).code, 'YAML_MALFORMED');
  }
});

test('D.3d.5.2: missing front matter fails closed', () => {
  const text = '# Just markdown\n- id: F1\n  status: KNOWN';
  try {
    parseDefinition(text);
    assert.fail('expected DefinitionParseError');
  } catch (err) {
    assert.ok(err instanceof DefinitionParseError);
    assert.equal((err as DefinitionParseError).code, 'FRONT_MATTER_MISSING');
  }
});

test('D.3d.5.2: unsupported schemaVersion fails closed', () => {
  const text = '---\nschemaVersion: 99\ngoal: "x"\nfacts: []\n---\n';
  try {
    parseDefinition(text);
    assert.fail('expected DefinitionParseError');
  } catch (err) {
    assert.ok(err instanceof DefinitionParseError);
    assert.equal((err as DefinitionParseError).code, 'SCHEMA_VERSION_UNSUPPORTED');
  }
});

test('D.3d.5.2: every optional canonical section is structurally validated on parse (no silent casts)', () => {
  const fm = (section: string) =>
    `---\nschemaVersion: 1\ngoal: "g"\nfacts: []\n${section}\n---\nbody`;
  const malformed: Array<[string, string]> = [
    ['constraints not an array', 'constraints: { description: "x" }'],
    ['constraints entry not a mapping', 'constraints:\n  - "be careful"'],
    ['constraint without description', 'constraints:\n  - { type: "must" }'],
    ['constraint with invalid type', 'constraints:\n  - { description: "x", type: "maybe" }'],
    ['requirements not an array', 'requirements: "ship it"'],
    ['requirement not a string', 'requirements:\n  - { text: "ship it" }'],
    ['nonGoals not an array', 'nonGoals: 42'],
    ['nonGoal not a string', 'nonGoals:\n  - [1, 2]'],
    ['acceptance not an array', 'acceptance: "works"'],
    ['acceptance entry not a mapping', 'acceptance:\n  - "two players can join"'],
    ['acceptance without description', 'acceptance:\n  - { met: false }'],
    ['acceptance met not boolean', 'acceptance:\n  - { description: "joins", met: "no" }'],
  ];
  for (const [label, section] of malformed) {
    try {
      parseDefinition(fm(section));
      assert.fail(`expected SHAPE_INVALID for ${label}`);
    } catch (err) {
      assert.ok(err instanceof DefinitionParseError, label);
      assert.equal((err as DefinitionParseError).code, 'SHAPE_INVALID', label);
    }
  }
});

test('D.3d.5.2: fact scalar fields refuse non-scalar YAML values', () => {
  const cases: Array<[string, string]> = [
    ['status as array', '  - {"id":"F1","statement":"s","status":["KNOWN"],"source":"human"}'],
    ['source as object', '  - {"id":"F1","statement":"s","status":"KNOWN","source":{"a":1}}'],
    ['status as null', '  - {"id":"F1","statement":"s","status":null,"source":"human"}'],
    ['kind as number', '  - {"id":"F1","statement":"s","status":"KNOWN","source":"human","kind":7}'],
    ['decisionRef as array', '  - {"id":"F1","statement":"s","status":"DECIDED","source":"decision","decisionRef":["d1"]}'],
    ['evidenceRef as object', '  - {"id":"F1","statement":"s","status":"KNOWN","source":"repository","evidenceRef":{"path":"x"}}'],
  ];
  for (const [label, factLine] of cases) {
    try {
      parseDefinition(`---\nschemaVersion: 1\ngoal: "g"\nfacts:\n${factLine}\n---\nbody`);
      assert.fail(`expected SHAPE_INVALID for ${label}`);
    } catch (err) {
      assert.ok(err instanceof DefinitionParseError, label);
      assert.equal((err as DefinitionParseError).code, 'SHAPE_INVALID', label);
    }
  }
});

test('D.3d.5.2: a fully populated canonical Definition parses into exactly typed sections', () => {
  const { definition } = parseDefinition([
    '---',
    'schemaVersion: 1',
    '"goal": "Full"',
    'facts:',
    '  - {"id":"F1","statement":"Repo claim.","status":"KNOWN","source":"repository","kind":"repository-claim","evidenceRef":"src/x.ts"}',
    '  - {"id":"F2","statement":"Decided.","status":"DECIDED","source":"decision","decisionRef":"d-1"}',
    'constraints:',
    '  - {"description":"No new entities","type":"must_not"}',
    '  - {"description":"Keep p95 under 200ms","type":"must"}',
    'requirements:',
    '  - "Two players can join"',
    'nonGoals:',
    '  - "Matchmaking"',
    'acceptance:',
    '  - {"description":"Two players can join"}',
    '  - {"description":"Session survives reconnect","met":false}',
    '---',
  ].join('\n'));
  assert.equal(definition.constraints?.length, 2);
  assert.equal(definition.requirements?.[0], 'Two players can join');
  assert.equal(definition.nonGoals?.[0], 'Matchmaking');
  assert.equal(definition.acceptance?.[1].met, false);
  assert.equal(definition.facts[0].evidenceRef, 'src/x.ts');
  assert.equal(definition.facts[1].decisionRef, 'd-1');
});

// ─── Facts ───────────────────────────────────────────────────────────────────

test('D.3d.5.2: duplicate fact ids are rejected', () => {
  const result = validateDefinition(canonical({ facts: [fact({ id: 'F1' }), fact({ id: 'F1' })] }));
  assert.equal(result.valid, false);
  assert.ok(result.defects.some((d) => d.code === 'FACT_DUPLICATE_ID' && d.factId === 'F1'));
});

test('D.3d.5.2: invalid status and invalid source are rejected', () => {
  const result = validateDefinition(canonical({
    facts: [fact({ id: 'F1', status: 'PROVEN' as never }), fact({ id: 'F2', source: 'vibes' as never })],
  }));
  assert.equal(result.valid, false);
  assert.ok(result.defects.some((d) => d.code === 'FACT_STATUS_INVALID' && d.factId === 'F1'));
  assert.ok(result.defects.some((d) => d.code === 'FACT_SOURCE_INVALID' && d.factId === 'F2'));
});

test('D.3d.5.2: KNOWN/source:human with explicit product-intent kind is accepted', () => {
  const result = validateDefinition(canonical({
    facts: [fact({ id: 'F1', status: 'KNOWN', source: 'human', kind: 'product-intent' })],
  }));
  assert.equal(result.valid, true, JSON.stringify(result.defects));
});

test('D.3d.5.2: the repository-claim provenance rule is enforced WITHOUT semantic heuristics', () => {
  // The distinction is EXPLICIT in the canonical structure (kind), so the
  // rule is mechanical — the validator never reads the statement text.
  const weakened = validateDefinition(canonical({
    facts: [fact({ id: 'F1', statement: 'The repository already has a Redis cache.', status: 'KNOWN', source: 'human', kind: 'repository-claim' })],
  }));
  assert.equal(weakened.valid, false);
  assert.ok(weakened.defects.some((d) => d.code === 'PROVENANCE_UNCONFIRMED' && d.factId === 'F1'));

  const confirmed = validateDefinition(canonical({
    facts: [fact({ id: 'F1', status: 'KNOWN', source: 'repository', kind: 'repository-claim' })],
  }));
  assert.equal(confirmed.valid, true, JSON.stringify(confirmed.defects));

  // No kind → the validator claims NO authority over provenance adequacy —
  // even for a statement that LOOKS like a repository claim. That judgment
  // stays with semantic review.
  const noKind = validateDefinition(canonical({
    facts: [fact({ id: 'F1', statement: 'The repository already has a Redis cache.', status: 'KNOWN', source: 'human' })],
  }));
  assert.equal(noKind.valid, true, 'without an explicit kind the validator must not heuristic-guess');
});

// ─── References (Decision provenance) ────────────────────────────────────────

test('D.3d.5.2: DECIDED with a valid, resolvable decisionRef is accepted', () => {
  const result = validateDefinition(canonical({
    facts: [fact({ id: 'F1', status: 'DECIDED', source: 'decision', decisionRef: 'dec-123' })],
  }), { decisionExists: (id) => id === 'dec-123' });
  assert.equal(result.valid, true, JSON.stringify(result.defects));
});

test('D.3d.5.2: DECIDED without a decisionRef is rejected', () => {
  const result = validateDefinition(canonical({
    facts: [fact({ id: 'F1', status: 'DECIDED', source: 'decision' })],
  }));
  assert.equal(result.valid, false);
  assert.ok(result.defects.some((d) => d.code === 'DECISION_REF_MISSING' && d.factId === 'F1'));
});

test('D.3d.5.2: a DECIDED fact referencing a nonexistent Decision is rejected when the resolver is supplied', () => {
  const result = validateDefinition(canonical({
    facts: [fact({ id: 'F1', status: 'DECIDED', source: 'decision', decisionRef: 'dec-invented' })],
  }), { decisionExists: () => false });
  assert.equal(result.valid, false);
  assert.ok(result.defects.some((d) => d.code === 'DECISION_REF_UNRESOLVED' && d.factId === 'F1'));
});

test('D.3d.5.2: status/source DECIDED pairing is mechanically enforced', () => {
  const result = validateDefinition(canonical({
    facts: [
      fact({ id: 'F1', status: 'DECIDED', source: 'human', decisionRef: 'dec-1' }),   // DECIDED needs source decision
      fact({ id: 'F2', status: 'UNKNOWN', source: 'decision' }),                       // decision source needs DECIDED
      fact({ id: 'F3', status: 'KNOWN', source: 'human', decisionRef: 'dec-2' }),      // stray decisionRef
    ],
  }));
  assert.equal(result.valid, false);
  assert.ok(result.defects.some((d) => d.code === 'STATUS_SOURCE_CONFLICT' && d.factId === 'F1'));
  assert.ok(result.defects.some((d) => d.code === 'STATUS_SOURCE_CONFLICT' && d.factId === 'F2'));
  assert.ok(result.defects.some((d) => d.code === 'DECISION_REF_STRAY' && d.factId === 'F3'));
});

// ─── Deferral ────────────────────────────────────────────────────────────────

test('D.3d.5.2: DEFERRED bookkeeping — valid accepted, mechanically invalid rejected', () => {
  const valid = validateDefinition(canonical({
    facts: [fact({ id: 'F1', statement: 'Real later-phase gap.', status: 'DEFERRED', source: 'human' })],
  }));
  assert.equal(valid.valid, true, JSON.stringify(valid.defects));

  // decision provenance belongs exclusively to DECIDED facts: a "deferred"
  // fact carrying decision bookkeeping is a mechanical contradiction.
  const invalid = validateDefinition(canonical({
    facts: [fact({ id: 'F1', status: 'DEFERRED', source: 'decision', decisionRef: 'dec-9' })],
  }));
  assert.equal(invalid.valid, false);
  assert.ok(invalid.defects.some((d) => d.code === 'STATUS_SOURCE_CONFLICT'));
  assert.ok(invalid.defects.some((d) => d.code === 'DECISION_REF_STRAY'));
});

// ─── Authority boundary ──────────────────────────────────────────────────────

test('D.3d.5.2: semantically ambiguous Definitions pass structural validation — judgment stays with review', () => {
  // This Definition contains exactly the shape that broke cheap models: an
  // UNKNOWN product question, a risky assumption, a borderline scope item.
  // NONE of that is mechanically decidable, so the validator must accept it.
  const ambiguous = validateDefinition(canonical({
    facts: [
      fact({ id: 'F1', statement: 'Whether cross-platform play belongs in this bounded increment.', status: 'UNKNOWN', source: 'human' }),
      fact({ id: 'F2', statement: 'Whether client-side prediction can meet the latency budget.', status: 'UNKNOWN', source: 'human' }),
      fact({ id: 'F3', statement: 'Matchmaking is probably fine to defer.', status: 'ASSUMED', source: 'investigation' }),
    ],
  }));
  assert.equal(ambiguous.valid, true, JSON.stringify(ambiguous.defects));
  // And it emits no classification-shaped verdicts of any kind.
  for (const d of ambiguous.defects) {
    assert.ok(!/HUMAN_DECISION|EXPLORE_AS_WORK|CAN_RESOLVE|DEFER route/.test(d.code + d.message));
  }
});

test('D.3d.5.2: the validator returns only validity — never classifications or routes', () => {
  const result = validateDefinition(canonical({ facts: [fact({ id: 'F1', status: 'BOGUS' as never })] }));
  assert.deepEqual(Object.keys(result).sort(), ['defects', 'valid']);
  for (const defect of result.defects) {
    assert.deepEqual(Object.keys(defect).sort().filter((k) => k !== 'factId' && k !== 'message'), ['code']);
    assert.ok(!/route|classification|HUMAN_DECISION|EXPLORE|CAN_RESOLVE/i.test(defect.code));
  }
});

// ─── Workflow integration ────────────────────────────────────────────────────

class SequenceLLMProvider implements ILLMProvider {
  calls: LLMCompletionParams[] = [];
  constructor(private responses: string[]) {}
  async complete(params: LLMCompletionParams): Promise<LLMCompletionResult> {
    this.calls.push(params);
    const content = this.responses[this.calls.length - 1] ?? '';
    return { content, tokens_used: 10, duration_ms: 1 };
  }
}

function sleOutput(content: string, path: string): string {
  return [
    '<!-- SLE-OUTPUT', 'role: explorer', 'node: define-work',
    'artifacts:', '  - id: definition', `    path: ${path}`, '-->', '',
    `## ${path}`, '', content,
  ].join('\n');
}

function readinessOutput(verdict: 'pass' | 'fail', content: string, path: string): string {
  const fm = ['---', 'schemaVersion: 1', 'gaps:', '  []', '---'].join('\n');
  const lines = ['<!-- SLE-OUTPUT', 'role: explorer', 'node: define-work', `verdict: ${verdict}`];
  lines.push('artifacts:', '  - id: readiness', `    path: ${path}`, '-->', '', `## ${path}`, '', fm, '', content);
  return lines.join('\n');
}

const V1_DUPLICATE = [
  '---',
  'schemaVersion: 1',
  '"goal": "E2E validator gate"',
  'facts:',
  '  - {"id":"F1","statement":"One fact.","status":"KNOWN","source":"human"}',
  '  - {"id":"F1","statement":"The same id twice.","status":"ASSUMED","source":"human"}',
  '---',
].join('\n');

const V2_FIXED = [
  '---',
  'schemaVersion: 1',
  '"goal": "E2E validator gate"',
  'facts:',
  '  - {"id":"F1","statement":"One fact.","status":"KNOWN","source":"human"}',
  '  - {"id":"F2","statement":"The same id twice — now distinct.","status":"ASSUMED","source":"human"}',
  '---',
].join('\n');

test('D.3d.5.2: validator defects deterministically reach refine WITHOUT calling the readiness reviewer, and a corrected Definition resumes normal review', async () => {
  const root = mkdtempSync(join(tmpdir(), 'd3d5-defval-'));
  try {
    const definitionPath = '.sle/work/wi-gate/definition.md';
    const readinessPath = '.sle/work/wi-gate/readiness.md';

    const provider = new SequenceLLMProvider([
      sleOutput(V1_DUPLICATE, definitionPath),                       // synthesize — duplicate fact id
      // NOTE: no reviewer call here — the deterministic gate must intercept
      sleOutput(V2_FIXED, definitionPath),                           // refine — corrects the defect
      readinessOutput('pass', 'All seven dimensions pass.', readinessPath),
    ]);

    const cm = new ContextManager(root, DEFAULT_CONFIG);
    const agentRunner = new AgentRunner(
      cm, provider, root,
      { updateNodeStatus: async () => {}, writeNodeOutput: async () => {}, createRunDir: async () => {}, createManifest: async () => {} } as unknown as RunArtifactManager,
      { model: 'test', inputValidators: { definition: validateDefinitionArtifactText } },
      undefined, undefined,
    );
    const engineDeps: WorkflowEngineDeps = {
      stepRunner: new AgentStepRunner(agentRunner),
      mapManager: { read: async () => ({ artifacts: [] }), update: async () => {} } as never,
      runArtifacts: { updateNodeStatus: async () => {}, createRunDir: async () => {}, createManifest: async () => {} } as never,
      projectRoot: root,
    };
    const engine = new WorkflowEngine(engineDeps, { onCheckpoint: async () => 'approve' });

    const result = await engine.run(
      'define-work', 'run-gate', 'E2E validator gate', undefined, 'wi-gate',
      undefined, undefined, 'obj-gate',
    );
    assert.equal(result.status, 'complete', result.error);

    // LLM call #1 = synthesize; call #2 = refine (reviewer was SKIPPED);
    // call #3 = readiness review on the corrected Definition.
    assert.equal(provider.calls.length, 3, `expected synthesize→refine→review, got ${provider.calls.length} calls`);
    assert.ok(
      provider.calls[1].messages.some((m) => m.role === 'user' && m.content.includes('Revise the Definition')),
      'the second LLM call must be the refine step (the reviewer never ran on the invalid Definition)',
    );

    // The validator's structured defects reached the refine step's context.
    const refineContext = provider.calls[1].messages.find((m) => m.role === 'user')!.content;
    assert.ok(refineContext.includes('FACT_DUPLICATE_ID'), 'structured defect code reached the refine context');
    assert.ok(refineContext.includes('F1'), 'the defect names the offending fact id');
    assert.ok(refineContext.includes('occurs more than once'), 'the defect carries the explanatory message');

    // After correction, the readiness artifact is the REVIEWER's pass — the
    // normal semantic review resumed and owns the artifact again.
    const finalReadiness = readFileSync(join(root, readinessPath), 'utf-8');
    assert.ok(finalReadiness.includes('All seven dimensions pass.'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('D.3d.5.2: no new workflow concept — the gate reuses the existing refine route on the existing review steps', () => {
  for (const step of DEFINE_WORK.steps) {
    if (step.requiresReviewVerdict !== true) continue;
    assert.equal(step.inputValidator, 'definition', `review step '${step.id}' declares the definition validator`);
    assert.ok(step.on_fail_routes && 'refine' in step.on_fail_routes, `'${step.id}' routes validator defects through the EXISTING refine path`);
    assert.equal(step.kind, 'review', 'the gate rides the existing review step kind — no new StepKind');
  }
  const kinds = new Set(DEFINE_WORK.steps.map((s) => s.kind));
  assert.ok(![...kinds].some((k) => /valid/i.test(k)), 'no VALIDATE step kind was introduced');
});

// ─── Harness parity (commit-2 amendment) ─────────────────────────────────────
//
// driveDefineWorkRun must register the SAME resolver-backed validator
// production registers — not the resolver-less validateDefinitionArtifactText
// instance. Smallest proof: a Layer A run whose synthesized Definition
// carries an INVENTED decisionRef must be intercepted by the harness's own
// gate (refine, reviewer skipped) instead of passing semantic review.

type MultiTurnEntry = MultiTurnResult | ((params: MultiTurnParams) => MultiTurnResult);
type SingleTurnEntry = string | ((params: LLMCompletionParams) => string);

class ScriptedDualModeProvider {
  multiTurnCallCount = 0;
  singleTurnCallCount = 0;
  constructor(private multi: MultiTurnEntry[], private single: SingleTurnEntry[]) {}
  async complete(params: LLMCompletionParams) {
    this.singleTurnCallCount++;
    const entry = this.single[this.singleTurnCallCount - 1] ?? '';
    return { content: typeof entry === 'function' ? entry(params) : entry, tokens_used: 10, duration_ms: 1 };
  }
  async completeMultiTurn(params: MultiTurnParams): Promise<MultiTurnResult> {
    this.multiTurnCallCount++;
    const entry = this.multi[this.multiTurnCallCount - 1];
    if (!entry) return { stop_reason: 'end_turn', text: '', tool_uses: [], tokens_used: 1 };
    return typeof entry === 'function' ? entry(params) : entry;
  }
}

function mtOut(content: string, outPath: string): MultiTurnResult {
  return {
    stop_reason: 'end_turn', tool_uses: [], tokens_used: 10,
    text: ['<<<SLE-OUTPUT>>>', `### ${outPath}`, content, '<<<END-SLE-OUTPUT>>>'].join('\n'),
  };
}

function stPass(content: string, outPath: string): string {
  return ['<!-- SLE-OUTPUT', 'role: explorer', 'node: define-work', 'verdict: pass',
    'artifacts:', '  - id: readiness', `    path: ${outPath}`, '-->', '', `## ${outPath}`, '', content].join('\n');
}

function decidedFactArtifact(decisionRef: string): string {
  return [
    '---',
    'schemaVersion: 1',
    '"goal": "Harness decision-authority parity"',
    'facts:',
    `  - {"id":"F1","statement":"WebSocket transport.","status":"DECIDED","source":"decision","decisionRef":"${decisionRef}"}`,
    '---',
  ].join('\n');
}

test('D.3d.5.2: the harness gate resolves Decisions — an invented decisionRef is refined, not reviewed (parity with production)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'd3d5-harness-parity-'));
  try {
    const definitionPath = '.sle/work/wi-d3d-decision-gate/definition.md';
    const readinessPath = '.sle/work/wi-d3d-decision-gate/readiness.md';
    const corrected = [
      '---',
      'schemaVersion: 1',
      '"goal": "Harness decision-authority parity"',
      'facts:',
      '  - {"id":"F1","statement":"WebSocket transport, still unconfirmed.","status":"ASSUMED","source":"human"}',
      '---',
    ].join('\n');

    const reviewedContexts: string[] = [];
    const provider = new ScriptedDualModeProvider(
      [
        mtOut(decidedFactArtifact('dec-invented-in-harness'), definitionPath),
        mtOut(corrected, definitionPath),
      ],
      [
        (params: LLMCompletionParams) => {
          const context = params.messages.find((m) => m.role === 'user')?.content ?? '';
          reviewedContexts.push(context);
          return stPass('All dimensions pass.', readinessPath);
        },
      ],
    );

    const trace = await driveDefineWorkRun({
      scenarioId: 'decision-gate',
      root,
      fixtureFiles: EARLY_FIXTURE_FILES,
      objectiveIntent: EARLY_OBJECTIVE,
      provider: provider as any,
      resolveDecision: () => undefined, // never reached — no checkpoint in this script
    });

    assert.equal(trace.finalStatus, 'complete', trace.error);
    // synthesize + refine = 2 multi-turn calls; exactly ONE reviewer call,
    // and it saw the CORRECTED Definition (the invented one never reached
    // semantic review).
    assert.equal(provider.multiTurnCallCount, 2, 'the gate must bounce the invented decisionRef to refine');
    assert.equal(provider.singleTurnCallCount, 1, 'the reviewer runs exactly once — on the corrected Definition');
    assert.ok(
      !reviewedContexts[0].includes('dec-invented-in-harness'),
      'the reviewer never saw the invented decisionRef',
    );
    assert.ok(
      reviewedContexts[0].includes('"status":"ASSUMED"'),
      'the reviewer saw the corrected artifact',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── Production Decision resolution (Blocker 2) ──────────────────────────────
//
// DECIDED provenance must resolve against REAL control-plane state through
// the SAME registered-validator path production uses — not just the pure
// validator's {decisionExists} option. These tests construct the validator
// exactly the way the composition root does
// (createDefinitionInputValidator over a real DecisionRepository) and run
// the full define-work workflow through the deterministic gate.

function makeDecision(id: string, workItemId: string): Parameters<DecisionRepository['save']>[0] {
  return {
    id,
    projectId: 'proj-fix',
    workItemId,
    type: 'checkpoint',
    subjectRef: { workItemId },
    title: 'Decide transport',
    summary: 'Which transport the increment uses.',
    options: [{ id: 'opt-1', label: 'WebSocket' }],
    recommendedOptionId: 'opt-1',
    impact: 'medium',
    reversibility: 'easy',
    urgency: 'normal',
    status: 'resolved',
    resolution: { selectedOptionId: 'opt-1', rationale: 'bounded increment', resolvedAt: new Date().toISOString() },
  };
}

function decidedFactDefinition(decisionRef: string): string {
  return [
    '---',
    'schemaVersion: 1',
    '"goal": "Decided provenance gate"',
    'facts:',
    `  - {"id":"F1","statement":"WebSocket transport.","status":"DECIDED","source":"decision","decisionRef":"${decisionRef}"}`,
    '---',
  ].join('\n');
}

function productionValidatorFixture(): { findDecision: (ref: string) => { workItemId?: string } | undefined; close: () => void } {
  const dbPath = join(tmpdir(), `d3d5-dec-${randomUUID()}.db`);
  const db: Database.Database = openDatabase(dbPath);
  // Seed the control-plane rows the Decisions' foreign keys require.
  const now = new Date().toISOString();
  db.prepare("INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)").run('ws-fix', 'fixture', now);
  db.prepare("INSERT INTO projects (id, workspace_id, name, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)")
    .run('proj-fix', 'ws-fix', 'Fixture Project', now, now);
  db.prepare(
    "INSERT INTO work_items (id, project_id, title, goal, workflow_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'define-work', 'backlog', ?, ?)",
  ).run('wi-own', 'proj-fix', 'Own item', 'Own goal', now, now);
  db.prepare(
    "INSERT INTO work_items (id, project_id, title, goal, workflow_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'define-work', 'backlog', ?, ?)",
  ).run('wi-other', 'proj-fix', 'Other item', 'Other goal', now, now);

  const repo = new DecisionRepository(db);
  const ownedId = 'dec-real-owned';
  const otherId = 'dec-real-foreign';
  repo.save(makeDecision(ownedId, 'wi-own'));
  repo.save(makeDecision(otherId, 'wi-other'));
  // The exact closure the composition root builds (application.ts).
  const findDecision = (ref: string) => {
    const d = repo.findById(ref);
    return d ? { workItemId: d.workItemId } : undefined;
  };
  return { repo, findDecision, close: () => db.close() };
}

test('D.3d.5.2: a DECIDED fact referencing a REAL work-item Decision passes the production gate and reaches semantic review', async () => {
  const { findDecision, close } = productionValidatorFixture();
  const root = mkdtempSync(join(tmpdir(), 'd3d5-dec-ok-'));
  try {
    const definitionPath = '.sle/work/wi-own/definition.md';
    const readinessPath = '.sle/work/wi-own/readiness.md';
    const provider = new SequenceLLMProvider([
      sleOutput(decidedFactDefinition('dec-real-owned'), definitionPath),
      readinessOutput('pass', 'Semantic review passed.', readinessPath),
    ]);
    const cm = new ContextManager(root, DEFAULT_CONFIG);
    const agentRunner = new AgentRunner(
      cm, provider, root,
      { updateNodeStatus: async () => {}, writeNodeOutput: async () => {}, createRunDir: async () => {}, createManifest: async () => {} } as unknown as RunArtifactManager,
      { model: 'test', inputValidators: { definition: createDefinitionInputValidator({ findDecision }) } },
      undefined, undefined,
    );
    const engine = new WorkflowEngine({
      stepRunner: new AgentStepRunner(agentRunner),
      mapManager: { read: async () => ({ artifacts: [] }), update: async () => {} } as never,
      runArtifacts: { updateNodeStatus: async () => {}, createRunDir: async () => {}, createManifest: async () => {} } as never,
      projectRoot: root,
    }, { onCheckpoint: async () => 'approve' });

    const result = await engine.run('define-work', 'run-dec-ok', 'Decided provenance gate', undefined, 'wi-own', undefined, undefined, 'obj-dec');
    assert.equal(result.status, 'complete', result.error);
    // Exactly two LLM calls: synthesize + semantic review. No gate rejection.
    assert.equal(provider.calls.length, 2);
    const finalReadiness = readFileSync(join(root, readinessPath), 'utf-8');
    assert.ok(finalReadiness.includes('Semantic review passed.'));
  } finally {
    rmSync(root, { recursive: true, force: true });
    close();
  }
});

test('D.3d.5.2: a DECIDED fact referencing an INVENTED Decision is rejected by the production gate — reviewer skipped, refine informed', async () => {
  const { findDecision, close } = productionValidatorFixture();
  const root = mkdtempSync(join(tmpdir(), 'd3d5-dec-bad-'));
  try {
    const definitionPath = '.sle/work/wi-own/definition.md';
    const readinessPath = '.sle/work/wi-own/readiness.md';
    const provider = new SequenceLLMProvider([
      sleOutput(decidedFactDefinition('dec-invented-0000'), definitionPath),
      // Refine must not merely repeat the invented reference.
      sleOutput(decidedFactDefinition('dec-real-owned'), definitionPath),
      readinessOutput('pass', 'Semantic review passed after correction.', readinessPath),
    ]);
    const cm = new ContextManager(root, DEFAULT_CONFIG);
    const agentRunner = new AgentRunner(
      cm, provider, root,
      { updateNodeStatus: async () => {}, writeNodeOutput: async () => {}, createRunDir: async () => {}, createManifest: async () => {} } as unknown as RunArtifactManager,
      { model: 'test', inputValidators: { definition: createDefinitionInputValidator({ findDecision }) } },
      undefined, undefined,
    );
    const engine = new WorkflowEngine({
      stepRunner: new AgentStepRunner(agentRunner),
      mapManager: { read: async () => ({ artifacts: [] }), update: async () => {} } as never,
      runArtifacts: { updateNodeStatus: async () => {}, createRunDir: async () => {}, createManifest: async () => {} } as never,
      projectRoot: root,
    }, { onCheckpoint: async () => 'approve' });

    const result = await engine.run('define-work', 'run-dec-bad', 'Decided provenance gate', undefined, 'wi-own', undefined, undefined, 'obj-dec');
    assert.equal(result.status, 'complete', result.error);

    // call #1 synthesize, call #2 refine (reviewer SKIPPED), call #3 review.
    assert.equal(provider.calls.length, 3, `expected synthesize→refine→review, got ${provider.calls.length}`);
    const refineContext = provider.calls[1].messages.find((m) => m.role === 'user')!.content;
    assert.ok(refineContext.includes('DECISION_REF_UNRESOLVED'), 'the invented reference surfaces as a deterministic defect');
    assert.ok(refineContext.includes('dec-invented-0000'), 'the defect names the unresolved reference');
  } finally {
    rmSync(root, { recursive: true, force: true });
    close();
  }
});

test('D.3d.5.2: a REAL Decision owned by a DIFFERENT work item is rejected — borrowed authority fails deterministically', async () => {
  const { findDecision, close } = productionValidatorFixture();
  const root = mkdtempSync(join(tmpdir(), 'd3d5-dec-own-'));
  try {
    const definitionPath = '.sle/work/wi-own/definition.md';
    const readinessPath = '.sle/work/wi-own/readiness.md';
    const provider = new SequenceLLMProvider([
      sleOutput(decidedFactDefinition('dec-real-foreign'), definitionPath),
      sleOutput(decidedFactDefinition('dec-real-owned'), definitionPath),
      readinessOutput('pass', 'Semantic review passed after correction.', readinessPath),
    ]);
    const cm = new ContextManager(root, DEFAULT_CONFIG);
    const agentRunner = new AgentRunner(
      cm, provider, root,
      { updateNodeStatus: async () => {}, writeNodeOutput: async () => {}, createRunDir: async () => {}, createManifest: async () => {} } as unknown as RunArtifactManager,
      { model: 'test', inputValidators: { definition: createDefinitionInputValidator({ findDecision }) } },
      undefined, undefined,
    );
    const engine = new WorkflowEngine({
      stepRunner: new AgentStepRunner(agentRunner),
      mapManager: { read: async () => ({ artifacts: [] }), update: async () => {} } as never,
      runArtifacts: { updateNodeStatus: async () => {}, createRunDir: async () => {}, createManifest: async () => {} } as never,
      projectRoot: root,
    }, { onCheckpoint: async () => 'approve' });

    const result = await engine.run('define-work', 'run-dec-own', 'Decided provenance gate', undefined, 'wi-own', undefined, undefined, 'obj-dec');
    assert.equal(result.status, 'complete', result.error);

    assert.equal(provider.calls.length, 3, `expected synthesize→refine→review, got ${provider.calls.length}`);
    const refineContext = provider.calls[1].messages.find((m) => m.role === 'user')!.content;
    assert.ok(refineContext.includes('DECISION_REF_UNRESOLVED'), 'a foreign work item\'s Decision does not resolve for this one');
    assert.ok(refineContext.includes('dec-real-foreign'));
  } finally {
    rmSync(root, { recursive: true, force: true });
    close();
  }
});
