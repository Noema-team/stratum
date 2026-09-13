// D.34 C4 — the Definition output contract, wired (DDR-034 §7, §8.3):
// semantic proposal, zod single-authority schema, deterministic renderer,
// validateDefinition wrapped verbatim, and — the C4 gate requirement — the
// contract working on BOTH current execution paths, including the
// multi-turn textual fallback through a provider that actually exposes
// completeMultiTurn.
//
// Locks the C4 acceptance criteria from docs/developmentPlan/d34-output-contracts.md:
//   - golden-byte fixtures: renderDefinition output pinned exactly (§10.8);
//   - round-trip: render → parseDefinition → semantic equality; stability:
//     render ∘ fromPersisted ∘ render is the identity;
//   - the LOAD PATH proves old canonical bytes render forward (format
//     unchanged);
//   - validateDefinitionProposal wraps validateDefinition verbatim — same
//     defect codes/messages, findDecision closure with work-item ownership;
//   - annotation conformance against the generated projection;
//   - multi-turn proposal mode: delimited single-JSON teaching, extraction
//     with absent-vs-malformed taxonomy, mode-correct repair; legacy
//     multi-turn bytes path unchanged when no schema is injected;
//   - E2E through buildAgentRunner on BOTH paths: single-turn produce with
//     in-step result repair and fail-closed exhaustion; multi-turn produce
//     (provider WITH completeMultiTurn) end to end; a non-contract produce
//     step on the same multi-turn runner stays legacy-materialized.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFINITION_PROPOSAL_SCHEMA,
  createDefinitionOutputContract,
  renderDefinition,
  definitionProposalFromPersisted,
  validateDefinitionProposal,
  type DefinitionProposal,
} from '../src/workflow/methodology/definition-contract.js';
import { parseDefinition } from '../src/workflow/methodology/definition-artifact.js';
import {
  createResultAcceptor,
  renderSchemaTeaching,
  toJsonSchema,
  validateSchemaAnnotations,
} from '../src/workflow/contracts.js';
import { TextualSleOutputTransport, SLE_OPEN, SLE_CLOSE } from '../src/transport/textual-sle-output.js';
import { AgentRunner } from '../src/agent-runner.js';
import { buildAgentRunner } from '../src/application.js';
import type { ILLMProvider, LLMCompletionParams, LLMCompletionResult } from '../src/llm-provider.js';
import type { ContextManager } from '../src/context-manager.js';
import type { AssembledContext } from '../src/types.js';
import type { StepRunContext } from '../src/workflow/types.js';
import type { RunArtifactManager } from '../src/run-artifacts.js';
import type { ArtifactRepository } from '../src/storage/repositories.js';
import { DEFINE_WORK } from '../src/workflow/builtins/define-work.js';
import { DEFINITION_CONTRACT } from '../src/workflow/methodology/definition-readiness.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const FULL_PROPOSAL: DefinitionProposal = {
  goal: 'Ship the widget',
  facts: [
    {
      id: 'F1',
      statement: 'The widget must ship.',
      status: 'KNOWN',
      source: 'human',
      kind: 'product-intent',
    },
    {
      id: 'F2',
      statement: 'Timeout: value is 30s per the design doc',
      status: 'DECIDED',
      source: 'decision',
      decisionRef: 'D-9',
    },
    {
      id: 'F3',
      statement: 'Rate limits are unknown',
      status: 'UNKNOWN',
      source: 'investigation',
    },
  ],
  constraints: [{ description: 'No new runtime dependencies', type: 'must' }],
  requirements: ['Widget ships Friday', 'P95 latency under 200ms'],
  nonGoals: ['Multiplayer sync'],
  acceptance: [{ description: 'All existing tests pass' }],
  bodyMarkdown: '## Design\n\nUse the existing scheduler.\n',
};

const MINIMAL_PROPOSAL: DefinitionProposal = {
  goal: 'Ship the widget',
  facts: [],
  bodyMarkdown: '',
};

// ─── Golden bytes (DDR-034 §10.8: a one-byte diff is a review event) ──────────

test('D.34.C4 GOLDEN: full proposal renders exact canonical bytes', () => {
  assert.equal(renderDefinition(FULL_PROPOSAL), `---
schemaVersion: 1
goal: Ship the widget
facts:
  - id: F1
    statement: The widget must ship.
    status: KNOWN
    source: human
    kind: product-intent
  - id: F2
    statement: "Timeout: value is 30s per the design doc"
    status: DECIDED
    source: decision
    decisionRef: D-9
  - id: F3
    statement: Rate limits are unknown
    status: UNKNOWN
    source: investigation
constraints:
  - description: No new runtime dependencies
    type: must
requirements:
  - Widget ships Friday
  - P95 latency under 200ms
nonGoals:
  - Multiplayer sync
acceptance:
  - description: All existing tests pass
---

## Design

Use the existing scheduler.
`);
});

test('D.34.C4 GOLDEN: minimal proposal — explicit empty facts, omitted optionals, empty body', () => {
  assert.equal(renderDefinition(MINIMAL_PROPOSAL), `---
schemaVersion: 1
goal: Ship the widget
facts: []
---
`);
});

test('D.34.C4 GOLDEN: CRLF normalization is representation-level only, final newline exactly one', () => {
  const bytes = renderDefinition({
    ...MINIMAL_PROPOSAL,
    bodyMarkdown: 'Line one.\r\nLine two.\r\n\r\n\r\n',
  });
  assert.ok(!bytes.includes('\r'), 'no CR in canonical bytes');
  assert.ok(bytes.endsWith('Line two.\n'), 'exactly one final newline; trailing blank lines are envelope policy, content kept verbatim above');
});

// ─── Round-trip / stability / load path (format UNCHANGED) ────────────────────

test('D.34.C4 ROUND-TRIP: render → parseDefinition → semantic equality', () => {
  const bytes = renderDefinition(FULL_PROPOSAL);
  const reparsed = definitionProposalFromPersisted(bytes);
  assert.deepEqual(reparsed, FULL_PROPOSAL);
});

test('D.34.C4 STABILITY: render ∘ fromPersisted ∘ render is the identity', () => {
  const once = renderDefinition(FULL_PROPOSAL);
  const twice = renderDefinition(definitionProposalFromPersisted(once));
  assert.equal(twice, once);
});

test('D.34.C4 LOAD PATH: pre-D.34 canonical bytes (as the gate/parser always read them) render forward unchanged', () => {
  const legacy = `---
schemaVersion: 1
goal: "Ship the widget"
facts:
  - id: F1
    statement: "The widget must ship."
    status: KNOWN
    source: human
    kind: product-intent
---

Body.`;
  // The parser is the load path and is unchanged.
  const { definition, body } = parseDefinition(legacy);
  assert.equal(definition.goal, 'Ship the widget');
  assert.equal(body, '\nBody.');
  const rebytes = renderDefinition(definitionProposalFromPersisted(legacy));
  // Canonical state survives a full render→parse cycle on legacy bytes.
  const first = definitionProposalFromPersisted(legacy);
  const again = definitionProposalFromPersisted(rebytes);
  assert.deepEqual(again.goal, first.goal);
  assert.deepEqual(again.facts, first.facts);
  // Renderer-stable on legacy-derived proposals.
  assert.equal(renderDefinition(again), rebytes);
  // The legacy body content is preserved verbatim under the envelope policy.
  assert.ok(rebytes.endsWith('---\n\nBody.\n'), `legacy body preserved, got: ${JSON.stringify(rebytes.slice(-20))}`);
});

// ─── Mechanical validation: validateDefinition wrapped VERBATIM ───────────────

const BASE_CTX = { workItemId: 'w-1' };

function baseValid(): DefinitionProposal {
  return {
    goal: 'Ship the widget',
    facts: [{ id: 'F1', statement: 'It must ship.', status: 'KNOWN', source: 'human' }],
    bodyMarkdown: '',
  };
}

test('D.34.C4 VALIDATE: a schema-valid proposal with clean ledger yields zero defects', () => {
  assert.deepEqual(validateDefinitionProposal(baseValid(), BASE_CTX), []);
});

test('D.34.C4 VALIDATE: duplicate fact ids surface FACT_DUPLICATE_ID with the exact validator wording', () => {
  const defects = validateDefinitionProposal(
    {
      ...baseValid(),
      facts: [
        { id: 'F1', statement: 'One.', status: 'KNOWN', source: 'human' },
        { id: 'F1', statement: 'Two.', status: 'ASSUMED', source: 'human' },
      ],
    },
    BASE_CTX,
  );
  assert.equal(defects.length, 1);
  assert.equal(defects[0].code, 'FACT_DUPLICATE_ID');
  assert.equal(defects[0].ref, 'F1');
  assert.match(defects[0].message, /occurs more than once/);
});

test('D.34.C4 VALIDATE: DECIDED provenance pairing is enforced mechanically (conflict + missing ref + stray ref)', () => {
  const defects = validateDefinitionProposal(
    {
      ...baseValid(),
      facts: [
        { id: 'F1', statement: 'Decided but wrong source.', status: 'DECIDED', source: 'human' },
        { id: 'F2', statement: 'Decision source on non-DECIDED.', status: 'KNOWN', source: 'decision' },
        { id: 'F3', statement: 'Stray ref.', status: 'KNOWN', source: 'human', decisionRef: 'D-1' },
      ],
    },
    BASE_CTX,
  );
  const codes = defects.map((d) => d.code).sort();
  assert.deepEqual(codes, ['DECISION_REF_MISSING', 'DECISION_REF_STRAY', 'STATUS_SOURCE_CONFLICT', 'STATUS_SOURCE_CONFLICT']);
});

test('D.34.C4 VALIDATE: provenance rule — repository-claim may not be KNOWN on human authority alone', () => {
  const defects = validateDefinitionProposal(
    {
      ...baseValid(),
      facts: [{ id: 'F1', statement: 'The build uses Vite.', status: 'KNOWN', source: 'human', kind: 'repository-claim' }],
    },
    BASE_CTX,
  );
  assert.equal(defects.length, 1);
  assert.equal(defects[0].code, 'PROVENANCE_UNCONFIRMED');
});

test('D.34.C4 VALIDATE: DECIDED reference resolution through the composition-root closure, with work-item ownership', () => {
  const deps = {
    findDecision: (ref: string) => (ref === 'D-9' ? { workItemId: 'w-1' } : ref === 'D-other' ? { workItemId: 'w-2' } : undefined),
  };
  const ok = validateDefinitionProposal(
    { ...baseValid(), facts: [{ id: 'F1', statement: 'x', status: 'DECIDED', source: 'decision', decisionRef: 'D-9' }] },
    BASE_CTX,
    deps,
  );
  assert.deepEqual(ok, [], 'a same-work-item Decision resolves');
  const borrowed = validateDefinitionProposal(
    { ...baseValid(), facts: [{ id: 'F1', statement: 'x', status: 'DECIDED', source: 'decision', decisionRef: 'D-other' }] },
    BASE_CTX,
    deps,
  );
  assert.deepEqual(borrowed.map((d) => d.code), ['DECISION_REF_UNRESOLVED'], 'another work item\'s Decision is not authority here');
  const invented = validateDefinitionProposal(
    { ...baseValid(), facts: [{ id: 'F1', statement: 'x', status: 'DECIDED', source: 'decision', decisionRef: 'D-none' }] },
    BASE_CTX,
    deps,
  );
  assert.deepEqual(invented.map((d) => d.code), ['DECISION_REF_UNRESOLVED']);
});

// ─── Projection + annotations ─────────────────────────────────────────────────

const CONTRACT = createDefinitionOutputContract();

test('D.34.C4 PROJECTION: annotation keys resolve; enums and strictness project', () => {
  assert.deepEqual(validateSchemaAnnotations(CONTRACT.modelSchema, CONTRACT.schemaAnnotations), { ok: true });
  const projection = toJsonSchema(CONTRACT.modelSchema) as Record<string, any>;
  assert.equal(projection.additionalProperties, false);
  const status = projection.properties.facts.items.properties.status;
  assert.deepEqual(status.enum, ['KNOWN', 'ASSUMED', 'UNKNOWN', 'DECIDED', 'DEFERRED']);
  assert.deepEqual(
    projection.properties.facts.items.properties.source.enum,
    ['human', 'repository', 'artifact', 'investigation', 'decision'],
  );
  // schemaVersion is NOT the model's business.
  assert.equal(projection.properties.schemaVersion, undefined);
});

// D.34 C4 review closure 1 — the ENTIRE generated provider-facing JSON
// Schema is golden-pinned (the C2 rule: "as C2/C3" means the full freeze,
// not sampled assertions). This projection IS the runtime protocol taught
// to every producing model; dependency/adapter/schema changes require
// regenerating this golden and reviewing the complete diff (DDR-034 §5.1).
test('D.34.C4 GOLDEN PROJECTION: the generated JSON Schema is pinned in full', () => {
  assert.deepEqual(toJsonSchema(DEFINITION_PROPOSAL_SCHEMA), {
    type: 'object',
    properties: {
      goal: { type: 'string' },
      facts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            statement: { type: 'string' },
            status: { type: 'string', enum: ['KNOWN', 'ASSUMED', 'UNKNOWN', 'DECIDED', 'DEFERRED'] },
            source: { type: 'string', enum: ['human', 'repository', 'artifact', 'investigation', 'decision'] },
            kind: { type: 'string', enum: ['product-intent', 'repository-claim'] },
            decisionRef: { type: 'string' },
            evidenceRef: { type: 'string' },
          },
          required: ['id', 'statement', 'status', 'source'],
          additionalProperties: false,
        },
      },
      constraints: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            type: { type: 'string', enum: ['must', 'must_not', 'prefer', 'prefer_not'] },
          },
          required: ['description', 'type'],
          additionalProperties: false,
        },
      },
      requirements: { type: 'array', items: { type: 'string' } },
      nonGoals: { type: 'array', items: { type: 'string' } },
      acceptance: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            met: { type: 'boolean' },
          },
          required: ['description'],
          additionalProperties: false,
        },
      },
      bodyMarkdown: { type: 'string' },
    },
    required: ['goal', 'facts', 'bodyMarkdown'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  });
});

test('D.34.C4 DECODE AUTHORITY: unknown fields and blank-trim refinements are decode defects (never projected)', () => {
  const r1 = DEFINITION_PROPOSAL_SCHEMA.safeParse({ ...baseValid(), schemaVersion: 1 });
  assert.equal(r1.success, false, 'schemaVersion is system-injected, not proposed');
  const r2 = DEFINITION_PROPOSAL_SCHEMA.safeParse({ ...baseValid(), goal: '   ' });
  assert.equal(r2.success, false, 'non-empty-after-trim is decode-authoritative');
});

test('D.34.C4 ACCEPTOR: decode and validate defects render as result-repair instructions', () => {
  const acceptor = createResultAcceptor(CONTRACT, BASE_CTX, 'definition');
  const bad = acceptor({ goal: 'x', facts: 'nope', bodyMarkdown: '' });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.repairInstruction, /output contract for 'definition'/);
  const decidedNoRef = acceptor({
    goal: 'x',
    facts: [{ id: 'F1', statement: 's', status: 'DECIDED', source: 'decision' }],
    bodyMarkdown: '',
  });
  assert.equal(decidedNoRef.ok, false);
  if (!decidedNoRef.ok) assert.match(decidedNoRef.repairInstruction, /DECISION_REF_MISSING/);
});

// ─── Multi-turn proposal mode (the C4 gate requirement) ───────────────────────

const DEF_SCHEMA_TEXT = renderSchemaTeaching(CONTRACT);
const MT_CTX = {
  role: 'explorer' as const,
  requiresReviewVerdict: false,
  execution: 'multi-turn' as const,
  nodeId: 'synthesize-definition',
  declaredArtifactId: 'definition',
  declaredOutputPath: '.sle/work/w/definition.md',
  expectedArtifacts: 1,
  resultSchemaText: DEF_SCHEMA_TEXT,
};

test('D.34.C4 MT TRANSPORT: proposal teaching keeps the delimiters, drops the section envelope', () => {
  const t = new TextualSleOutputTransport();
  const teaching = t.formatInstruction(MT_CTX);
  assert.ok(teaching.includes(SLE_OPEN) && teaching.includes(SLE_CLOSE), 'delimiters remain the compliance signal');
  assert.ok(teaching.includes('SINGLE JSON object'), 'payload framing');
  assert.ok(teaching.includes(DEF_SCHEMA_TEXT), 'generated schema embedded verbatim');
  assert.ok(!teaching.includes('### '), "no '### <path>' section teaching in proposal mode");
});

test('D.34.C4 MT TRANSPORT: delimited JSON extracts as a proposal-kind result', () => {
  const t = new TextualSleOutputTransport();
  const value = { goal: 'g', facts: [], bodyMarkdown: '' };
  const plain = t.extractProduce(`${SLE_OPEN}\n${JSON.stringify(value)}\n${SLE_CLOSE}`, MT_CTX);
  assert.deepEqual(plain, { kind: 'proposal', value });
  const fenced = t.extractProduce(`${SLE_OPEN}\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\`\n${SLE_CLOSE}`, MT_CTX);
  assert.equal(fenced.kind, 'proposal');
  // tool-loop chatter before the final block is exactly the multi-turn shape
  const withChatter = t.extractProduce(`I read three files.\n${SLE_OPEN}\n${JSON.stringify(value)}\n${SLE_CLOSE}`, MT_CTX);
  assert.equal(withChatter.kind, 'proposal');
  assert.throws(
    () => t.extractProduce('prose only, no delimiters', MT_CTX),
    (e: Error) => e.name === 'TransportParseError' && (e as any).kind === 'absent',
  );
  assert.throws(
    () => t.extractProduce(`${SLE_OPEN}\n{"goal":`, MT_CTX),
    (e: Error) => e.name === 'TransportParseError' && (e as any).kind === 'malformed',
  );
  assert.throws(
    () => t.extractProduce(`${SLE_OPEN}\nno json\n${SLE_CLOSE}`, MT_CTX),
    (e: Error) => e.name === 'TransportParseError' && (e as any).kind === 'malformed',
  );
});

// D.34 C4 review closure 2 — CARDINALITY is fail-closed: exactly one
// proposal block per reply. Competing semantic results must never be
// silently resolved by the transport (this channel feeds deterministic
// validation and canonical state); multiple blocks are malformed and take
// the existing bounded format repair.
test('D.34.C4 MT TRANSPORT: multiple proposal blocks fail closed as malformed', () => {
  const t = new TextualSleOutputTransport();
  const block = (goal: string) => `${SLE_OPEN}\n${JSON.stringify({ goal, facts: [], bodyMarkdown: '' })}\n${SLE_CLOSE}`;
  const twoBlocks = `${block('first')}\n\nCorrection:\n\n${block('second')}`;
  assert.throws(
    () => t.extractProduce(twoBlocks, MT_CTX),
    (e: Error) =>
      e.name === 'TransportParseError' &&
      (e as any).kind === 'malformed' &&
      /more than one result block/.test((e as any).reason),
    'two complete blocks → malformed',
  );
  assert.throws(
    () => t.extractProduce(`${block('first')}\n\n${SLE_OPEN}\n{"goal":`, MT_CTX),
    (e: Error) => e.name === 'TransportParseError' && (e as any).kind === 'malformed',
    'trailing opened-but-unclosed second block → malformed',
  );
  assert.throws(
    () => t.extractProduce(`${block('first')}\n${SLE_CLOSE}`, MT_CTX),
    (e: Error) => e.name === 'TransportParseError' && (e as any).kind === 'malformed',
    'a second closing delimiter → malformed',
  );
  // Exactly one block still parses (control).
  const one = t.extractProduce(block('only'), MT_CTX);
  assert.deepEqual(one, { kind: 'proposal', value: { goal: 'only', facts: [], bodyMarkdown: '' } });
});

test('D.34.C4 MT TRANSPORT: repair instructions are mode-correct on both executions', () => {
  const t = new TextualSleOutputTransport();
  const mt = t.repairInstruction(MT_CTX, 'malformed', 'bad json');
  assert.match(mt, new RegExp(SLE_OPEN));
  assert.match(mt, /SINGLE valid JSON object/);
  const st = t.repairInstruction(
    { ...MT_CTX, execution: 'single-turn' as const },
    'malformed',
    'bad json',
  );
  assert.ok(!st.includes('SLE-OUTPUT'), 'single-turn proposal repair never teaches the multi-turn envelope');
  assert.match(st, /SINGLE valid JSON object/);
});

test('D.34.C4 MT TRANSPORT: legacy multi-turn bytes path is byte-for-byte unchanged when no schema is injected', () => {
  const t = new TextualSleOutputTransport();
  const legacyCtx = { role: 'explorer' as const, requiresReviewVerdict: false, execution: 'multi-turn' as const };
  const teaching = t.formatInstruction(legacyCtx);
  assert.ok(teaching.includes('### '), 'legacy section teaching intact');
  assert.ok(!teaching.includes('JSON object'), 'no proposal framing on the legacy path');
  const raw = `${SLE_OPEN}\n### .sle/work/w/x.md\nbytes here\n${SLE_CLOSE}`;
  const result = t.extractProduce(raw, legacyCtx);
  assert.equal(result.kind, 'materialized');
  assert.deepEqual(result.kind === 'materialized' ? result.artifacts : null, [
    { path: '.sle/work/w/x.md', content: 'bytes here' },
  ]);
});

// ─── E2E through buildAgentRunner ─────────────────────────────────────────────

class ScriptedContextManager implements ContextManager {
  async assemble(): Promise<AssembledContext> {
    return { system_prompt: 's', artifact_slices: {}, state_summary: 'st', task: 't', token_count: 1, truncated: [] };
  }
}

class RecordingArtifacts implements ArtifactRepository {
  readonly saved: Array<{ ref: string; hash: string }> = [];
  save(r: any): void {
    this.saved.push({ ref: r.ref, hash: r.hash });
  }
  findByWorkflowRunRefAndHash(): undefined {
    return undefined;
  }
}

interface Call { messages: LLMCompletionParams['messages'] }

class SingleTurnProvider implements ILLMProvider {
  public calls: Call[] = [];
  constructor(private replies: string[]) {}
  async complete(params: LLMCompletionParams): Promise<LLMCompletionResult> {
    this.calls.push(params);
    const r = this.replies[Math.min(this.calls.length - 1, this.replies.length - 1)];
    return { content: r, tokens_used: 10, duration_ms: 1 };
  }
}

class MultiTurnProvider implements ILLMProvider {
  public calls: Call[] = [];
  public turns: string[] = [];
  constructor(turns: string[]) {
    this.turns = turns;
  }
  async complete(params: LLMCompletionParams): Promise<LLMCompletionResult> {
    this.calls.push(params);
    return { content: this.turns[0], tokens_used: 10, duration_ms: 1 };
  }
  async completeMultiTurn(params: any): Promise<any> {
    this.calls.push(params as unknown as LLMCompletionParams);
    const i = Math.min(this.calls.length - 1, this.turns.length - 1);
    return { stop_reason: 'end_turn', text: this.turns[i], tool_uses: [], tokens_used: 10 };
  }
}

function makeSingleTurnHarness(replies: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'd34-c4-st-'));
  const provider = new SingleTurnProvider(replies);
  const artifacts = new RecordingArtifacts();
  const runner = buildAgentRunner(
    new ScriptedContextManager(),
    provider,
    root,
    { writeNodeOutput: async () => {} } as unknown as RunArtifactManager,
    'test-model',
    artifacts,
    4096,
  );
  return { runner, provider, artifacts, root };
}

function makeMultiTurnHarness(turns: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'd34-c4-mt-'));
  const provider = new MultiTurnProvider(turns);
  const artifacts = new RecordingArtifacts();
  const runner = buildAgentRunner(
    new ScriptedContextManager(),
    provider,
    root,
    { writeNodeOutput: async () => {} } as unknown as RunArtifactManager,
    'test-model',
    artifacts,
    4096,
  );
  return { runner, provider, artifacts, root };
}

function synthesizeCtx(root: string): StepRunContext {
  // Literal run paths: the ENGINE materializes {workItemId} placeholders
  // before AgentRunner sees the context (these tests exercise the runner
  // directly), so the context carries the already-materialized form.
  return {
    workflowRunId: 'r', workflowId: 'define-work', stepId: 'synthesize-definition',
    iteration: 1, revision: 0, goal: 'g',
    projectRoot: root, role: 'explorer',
    outputArtifact: { type: 'definition', ref: 'definition:{objectiveId}', path: '.sle/work/w/definition.md' },
  } as unknown as StepRunContext;
}

const VALID_ENGINE_JSON = JSON.stringify({
  goal: 'Ship the widget',
  facts: [{ id: 'F1', statement: 'It must ship.', status: 'KNOWN', source: 'human' }],
  bodyMarkdown: 'Notes.',
});

test('D.34.C4 E2E single-turn: synthesize on the contract path writes SYSTEM-rendered bytes', async () => {
  const h = makeSingleTurnHarness([VALID_ENGINE_JSON]);
  const result = await h.runner.run('explorer', synthesizeCtx(h.root));
  assert.equal(result.success, true, result.error);
  assert.equal(result.result_repairs, undefined, 'clean run: no repair counter surfaced');
  assert.equal(h.artifacts.saved.length, 1, 'provenance recorded');
  const written = readFileSync(join(h.root, '.sle/work/w/definition.md'), 'utf-8');
  assert.equal(
    written,
    renderDefinition(DEFINITION_PROPOSAL_SCHEMA.parse(JSON.parse(VALID_ENGINE_JSON))),
    'bytes are SYSTEM-rendered — identical to the pure renderer output',
  );
});

test('D.34.C4 E2E single-turn: methodology defect (DECIDED without decisionRef) → result repair → success', async () => {
  const bad = JSON.stringify({
    goal: 'Ship the widget',
    facts: [{ id: 'F1', statement: 'Decided.', status: 'DECIDED', source: 'decision' }],
    bodyMarkdown: '',
  });
  const h = makeSingleTurnHarness([bad, JSON.stringify({
    goal: 'Ship the widget',
    facts: [{ id: 'F1', statement: 'Decided.', status: 'DECIDED', source: 'decision', decisionRef: 'D-1' }],
    bodyMarkdown: '',
  })]);
  const result = await h.runner.run('explorer', synthesizeCtx(h.root));
  assert.equal(result.success, true, result.error);
  assert.equal(result.result_repairs, 1);
  assert.equal(h.provider.calls.length, 2, 'one repair re-issue');
  assert.match(h.provider.calls[1].messages.at(-1)!.content as string, /DECISION_REF_MISSING/);
  const written = readFileSync(join(h.root, '.sle/work/w/definition.md'), 'utf-8');
  assert.ok(written.includes('decisionRef: D-1'), 'repaired proposal materialized');
});

test('D.34.C4 E2E single-turn: result-repair exhaustion fails closed before write/provenance', async () => {
  const bad = JSON.stringify({
    goal: 'Ship the widget',
    facts: [{ id: 'F1', statement: 'Decided.', status: 'DECIDED', source: 'decision' }],
    bodyMarkdown: '',
  });
  const h = makeSingleTurnHarness([bad, bad]);
  const result = await h.runner.run('explorer', synthesizeCtx(h.root));
  assert.equal(result.success, false);
  assert.match(result.error!, /result repair is exhausted/);
  assert.match(result.error!, /DECISION_REF_MISSING/);
  assert.equal(result.result_repairs, 1);
  assert.equal(h.artifacts.saved.length, 0, 'no provenance');
  assert.equal(existsSync(join(h.root, '.sle/work/w/definition.md')), false, 'no bytes written');
});

// D.34 C5 note — the NEGOTIATED multi-turn wire for contract steps is now
// the submit-result channel (covered exhaustively by the C5 suite). These
// two tests pin the multi-turn TEXTUAL PROPOSAL FALLBACK (DDR-034 §6: the
// textual channel remains intact everywhere) via an explicit transport
// override — the same delimited wire C4 introduced, exercised end to end.
function makeTextualFallbackHarness(replies: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'd34-c4-mtfallback-'));
  const provider = new MultiTurnProvider(replies);
  const artifacts = new RecordingArtifacts();
  const runner = new AgentRunner(
    new ScriptedContextManager(),
    provider,
    root,
    { writeNodeOutput: async () => {} } as unknown as RunArtifactManager,
    {
      model: 'test-model',
      outputContracts: { definition: CONTRACT },
      resultTransport: new TextualSleOutputTransport(),
    },
    undefined,
    artifacts,
  );
  return { runner, provider, artifacts, root };
}

test('D.34.C4 E2E MULTI-TURN (textual fallback): delimited proposal → SYSTEM-rendered bytes', async () => {
  const turn1 = `I inspected the repository.\n${SLE_OPEN}\n${JSON.stringify({
    goal: 'Ship the widget',
    facts: [{ id: 'F1', statement: 'It must ship.', status: 'KNOWN', source: 'human' }],
    bodyMarkdown: 'Notes.',
  })}\n${SLE_CLOSE}`;
  const h = makeTextualFallbackHarness([turn1]);
  const result = await h.runner.run('explorer', synthesizeCtx(h.root));
  assert.equal(result.success, true, result.error);
  const written = readFileSync(join(h.root, '.sle/work/w/definition.md'), 'utf-8');
  assert.equal(
    written,
    renderDefinition(DEFINITION_PROPOSAL_SCHEMA.parse(JSON.parse(turn1.match(/\{[\s\S]*\}/)![0]))),
    'multi-turn textual proposal → SYSTEM-rendered canonical bytes',
  );
  assert.ok(h.provider.calls[0].messages, 'multi-turn provider used (not the single-turn fallback)');
  assert.equal(h.artifacts.saved.length, 1, 'provenance recorded');
});

test('D.34.C4 E2E MULTI-TURN (textual fallback): result repair continues the conversation; exhaustion fails closed', async () => {
  const badObj = JSON.stringify({
    goal: 'Ship the widget',
    facts: [{ id: 'F1', statement: 'Decided.', status: 'DECIDED', source: 'decision' }],
    bodyMarkdown: '',
  });
  const goodObj = JSON.stringify({
    goal: 'Ship the widget',
    facts: [{ id: 'F1', statement: 'Decided.', status: 'DECIDED', source: 'decision', decisionRef: 'D-1' }],
    bodyMarkdown: '',
  });
  const repair = makeTextualFallbackHarness([
    `${SLE_OPEN}\n${badObj}\n${SLE_CLOSE}`,
    `${SLE_OPEN}\n${goodObj}\n${SLE_CLOSE}`,
  ]);
  const ok = await repair.runner.run('explorer', synthesizeCtx(repair.root));
  assert.equal(ok.success, true, ok.error);
  assert.equal(ok.result_repairs, 1);
  assert.match((repair.provider.calls[1] as any).messages.at(-1).content, /DECISION_REF_MISSING/, 'same conversation continued');

  const exhaust = makeTextualFallbackHarness([
    `${SLE_OPEN}\n${badObj}\n${SLE_CLOSE}`,
    `${SLE_OPEN}\n${badObj}\n${SLE_CLOSE}`,
  ]);
  const failed = await exhaust.runner.run('explorer', synthesizeCtx(exhaust.root));
  assert.equal(failed.success, false);
  assert.match(failed.error!, /result repair is exhausted/);
  assert.equal(existsSync(join(exhaust.root, '.sle/work/w/definition.md')), false, 'no bytes written');
  assert.equal(exhaust.artifacts.saved.length, 0, 'no provenance');
});

test('D.34.C4 E2E MULTI-TURN: a non-contract produce step on the SAME runner stays legacy-materialized', async () => {
  const legacySection = `${SLE_OPEN}\n### .sle/work/w/decision-request.json\n{"type":"human_decision"}\n${SLE_CLOSE}`;
  const h = makeMultiTurnHarness([legacySection]);
  const ctx = {
    workflowRunId: 'r', workflowId: 'define-work', stepId: 'prepare-human-decision',
    iteration: 1, revision: 0, goal: 'g',
    projectRoot: h.root, role: 'explorer',
    outputArtifact: { type: 'decision-request', ref: 'dr:{objectiveId}', path: '.sle/work/w/decision-request.json' },
  } as unknown as StepRunContext;
  const result = await h.runner.run('explorer', ctx);
  assert.equal(result.success, true, result.error);
  const written = readFileSync(join(h.root, '.sle/work/w/decision-request.json'), 'utf-8');
  assert.equal(written, '{"type":"human_decision"}', 'model-authored bytes flow through unchanged (no contract for this type)');
});

// ─── Prompts: meaning kept, serialization moved (produce), reviews unchanged ──

test('D.34.C4 PROMPTS: Definition produce steps teach semantic content + epistemics, not YAML', () => {
  for (const stepId of ['synthesize-definition', 'refine-definition', 'apply-deferred-gaps', 'apply-human-decision']) {
    const step = DEFINE_WORK.steps.find((s) => s.id === stepId)!;
    const instruction = step.instruction ?? '';
    assert.ok(!instruction.includes('schemaVersion: 1'), `${stepId}: no YAML shape block (projection teaches it)`);
    assert.ok(!instruction.includes('front matter'), `${stepId}: no front-matter mechanics`);
    assert.ok(instruction.includes('Fact ledger rules:'), `${stepId}: epistemic rules kept verbatim`);
    assert.ok(instruction.includes('the system serializes the artifact itself'), `${stepId}: materializes-authority framing present`);
  }
  const refine = DEFINE_WORK.steps.find((s) => s.id === 'refine-definition')!.instruction ?? '';
  assert.ok(refine.includes('re-submit the complete corrected Definition'), 'refine repair ask is representation-neutral');
});

test('D.34.C4 PROMPTS: review steps keep exactly the C3 shape', () => {
  for (const stepId of ['definition-readiness-review', 'post-defer-readiness-review', 'post-human-readiness-review']) {
    const instruction = DEFINE_WORK.steps.find((s) => s.id === stepId)!.instruction ?? '';
    assert.ok(instruction.includes('Fact ledger rules:'), `${stepId}: epistemics via FOR_REVIEW`);
    assert.ok(!instruction.includes('schemaVersion: 1'), `${stepId}: no serialization mechanics`);
    assert.ok(instruction.includes('The system serializes the readiness artifact itself'), `${stepId}: proposal framing`);
  }
});

test('D.34.C4 METHODOLOGY: the slimmed contract keeps every semantic element', () => {
  assert.ok(DEFINITION_CONTRACT.includes('must | must_not | prefer | prefer_not'), 'constraint vocabulary');
  assert.ok(DEFINITION_CONTRACT.includes('It must not restate the ledger'), 'body rule');
  assert.ok(DEFINITION_CONTRACT.includes('sent back to you with structured defects'), 'deterministic gate');
  assert.ok(DEFINITION_CONTRACT.includes('status is exactly one of:'), 'status vocabulary');
  assert.ok(DEFINITION_CONTRACT.includes('source records where the fact came from:'), 'source vocabulary');
});
