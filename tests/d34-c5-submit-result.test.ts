// D.34 C5 — the submit-result transport (DDR-034 §6): the preferred
// side-effect-free return channel for multi-turn contract steps.
//
// THE C5 GATE (the acceptance invariant under everything below): switching
// the wire from textual proposal submission to submit_result changes ONLY
// the wire. Decoding, methodology validation, materialization, route
// derivation, provenance, and repair budgets are identical — every test
// here observes the proposal/acceptor/materialization seams behaving
// exactly as they did on the textual channel.
//
// Locks the C5 acceptance criteria from docs/developmentPlan/d34-output-contracts.md:
//   - negotiation in resolveResultTransport: schema-carrying step on a
//     genuinely multi-turn provider → submit-result; everything else
//     textual; explicit override always wins;
//   - the tool is generated from resultSchemaJson (the contract's
//     projection) — never hand-written;
//   - submission on BOTH multi-turn provider paths (Anthropic SDK wire and
//     OpenRouter/OpenAI wire), mapped to the loop's shared tool_use shape;
//   - rejection continuation via tool_result, same acceptor, same budget;
//   - fail-closed cardinality (the C4 rule) on the tool channel too;
//   - end_turn without submission is an 'absent' format defect (bounded
//     repair), never silently accepted;
//   - the negotiated transport is recorded in run metadata;
//   - legacy multi-turn steps (no contract) are untouched: no submission
//     tool offered, textual bytes path intact.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveResultTransport, TextualSleOutputTransport, SLE_OPEN, SLE_CLOSE } from '../src/transport/textual-sle-output.js';
import { SubmitResultTransport } from '../src/transport/submit-result-transport.js';
import { SUBMIT_RESULT_TOOL_NAME } from '../src/transport/step-result.js';
import { toJsonSchema, renderSchemaTeaching } from '../src/workflow/contracts.js';
import { DEFINITION_PROPOSAL_SCHEMA, renderDefinition, type DefinitionProposal } from '../src/workflow/methodology/definition-contract.js';
import { buildAgentRunner } from '../src/application.js';
import type { ILLMProvider, LLMCompletionParams, LLMCompletionResult } from '../src/llm-provider.js';
import type { ContextManager } from '../src/context-manager.js';
import type { AssembledContext } from '../src/types.js';
import type { StepRunContext } from '../src/workflow/types.js';
import type { RunArtifactManager } from '../src/run-artifacts.js';
import type { ArtifactRepository } from '../src/storage/repositories.js';
import { AnthropicSDKProvider, type AnthropicClientLike } from '../src/anthropic-provider.js';
import { OpenAICompatibleMultiTurnProvider } from '../src/llm-provider.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SCHEMA_JSON = toJsonSchema(DEFINITION_PROPOSAL_SCHEMA);
const SCHEMA_TEXT = renderSchemaTeaching({
  modelSchema: DEFINITION_PROPOSAL_SCHEMA,
} as never);

const CTX = {
  role: 'explorer' as const,
  requiresReviewVerdict: false,
  execution: 'multi-turn' as const,
  nodeId: 'synthesize-definition',
  declaredArtifactId: 'definition',
  declaredOutputPath: '.sle/work/w/definition.md',
  expectedArtifacts: 1,
  resultSchemaText: SCHEMA_TEXT,
  resultSchemaJson: SCHEMA_JSON as Record<string, unknown>,
};

const VALID_PROPOSAL: DefinitionProposal = {
  goal: 'Ship the widget',
  facts: [{ id: 'F1', statement: 'It must ship.', status: 'KNOWN', source: 'human' }],
  bodyMarkdown: 'Notes.',
};

const INVALID_PROPOSAL = {
  goal: 'Ship the widget',
  facts: [{ id: 'F1', statement: 'Decided.', status: 'DECIDED', source: 'decision' }],
  bodyMarkdown: '',
};

const mt = { completeMultiTurn: () => {} };

// ─── Negotiation ──────────────────────────────────────────────────────────────

test('D.34.C5 NEGOTIATION: schema-carrying step on a multi-turn provider → submit-result', () => {
  const t = resolveResultTransport(mt as never, undefined, { resultSchemaJson: SCHEMA_JSON });
  assert.equal(t.name, 'submit-result');
  assert.ok(t instanceof SubmitResultTransport);
});

test('D.34.C5 NEGOTIATION: no schema → textual (legacy bytes path untouched)', () => {
  const t = resolveResultTransport(mt as never, undefined, {});
  assert.equal(t.name, 'textual-sle-output');
  const t2 = resolveResultTransport(mt as never, undefined);
  assert.equal(t2.name, 'textual-sle-output');
});

test('D.34.C5 NEGOTIATION: no multi-turn capability → textual (single-turn proposal mode stays)', () => {
  const t = resolveResultTransport({}, undefined, { resultSchemaJson: SCHEMA_JSON });
  assert.equal(t.name, 'textual-sle-output');
});

test('D.34.C5 NEGOTIATION: an explicit override always wins', () => {
  const override = new TextualSleOutputTransport();
  const t = resolveResultTransport(mt as never, override, { resultSchemaJson: SCHEMA_JSON });
  assert.equal(t, override);
});

// ─── The tool channel ─────────────────────────────────────────────────────────

test('D.34.C5 TOOL: generated from resultSchemaJson — schema, never hand-written', () => {
  const t = new SubmitResultTransport();
  const tool = t.resultSubmissionTool(CTX);
  assert.equal(tool!.name, SUBMIT_RESULT_TOOL_NAME);
  assert.deepEqual(tool!.input_schema, SCHEMA_JSON, 'the tool input schema IS the contract projection');
  assert.equal(t.resultSubmissionTool({ ...CTX, resultSchemaJson: undefined }), undefined, 'never invent a schema');
});

test('D.34.C5 TOOL: submission extraction — none/single/object/stringified', () => {
  const t = new SubmitResultTransport();
  const readTurn = [{ type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'x' } }];
  assert.equal(t.extractToolSubmission(readTurn, CTX), undefined, 'read-tool turn delegates');
  const submit = { type: 'tool_use', id: 't2', name: SUBMIT_RESULT_TOOL_NAME, input: VALID_PROPOSAL };
  const one = t.extractToolSubmission([submit], CTX);
  assert.deepEqual(one, { kind: 'proposal', value: VALID_PROPOSAL });
  const stringified = t.extractToolSubmission(
    [{ type: 'tool_use', id: 't3', name: SUBMIT_RESULT_TOOL_NAME, input: JSON.stringify(VALID_PROPOSAL) }],
    CTX,
  );
  assert.deepEqual(stringified, { kind: 'proposal', value: VALID_PROPOSAL }, 'stringified payload tolerated');
});

// D.34 C5 review closure — submit_result is TERMINAL and EXCLUSIVE for its
// turn: a turn that both requests more information and declares the final
// authoritative result is contradictory; a proposal that becomes canonical
// state must never be accepted while a co-declared investigation request is
// silently ignored (the loop would return success before the read ever ran).
test('D.34.C5 TOOL: a mixed read+submission turn fails closed as malformed', () => {
  const t = new SubmitResultTransport();
  const mixed = [
    { type: 'tool_use', id: 'r1', name: 'read_file', input: { path: 'x' } },
    { type: 'tool_use', id: 's1', name: SUBMIT_RESULT_TOOL_NAME, input: VALID_PROPOSAL },
  ];
  let caught: any;
  try {
    (t as any).extractToolSubmission(mixed, CTX);
  } catch (e) {
    caught = e;
  }
  assert.ok(caught, 'read + valid submission must NOT be accepted');
  assert.equal(caught.name, 'TransportParseError');
  assert.equal(caught.kind, 'malformed');
  assert.match(caught.reason, /investigate with read tools on EARLIER turns, then call submit_result alone/);
  const threeWay = [
    { type: 'tool_use', id: 'r1', name: 'list_directory', input: { path: '.' } },
    { type: 'tool_use', id: 'r2', name: 'read_file', input: { path: 'y' } },
    { type: 'tool_use', id: 's1', name: SUBMIT_RESULT_TOOL_NAME, input: VALID_PROPOSAL },
  ];
  let caught2: any;
  try {
    (t as any).extractToolSubmission(threeWay, CTX);
  } catch (e) {
    caught2 = e;
  }
  assert.ok(caught2, 'even with two reads, the submission turn stays fail-closed');
  assert.equal(caught2.name, 'TransportParseError');
  assert.equal(caught2.kind, 'malformed');
});

test('D.34.C5 TOOL: fail-closed cardinality — multiple submissions are malformed, never selected among', () => {
  const t = new SubmitResultTransport();
  const two = [
    { type: 'tool_use', id: 'a', name: SUBMIT_RESULT_TOOL_NAME, input: { goal: 'first' } },
    { type: 'tool_use', id: 'b', name: SUBMIT_RESULT_TOOL_NAME, input: { goal: 'second' } },
  ];
  assert.throws(
    () => t.extractToolSubmission(two, CTX),
    (e: Error) => e.name === 'TransportParseError' && (e as any).kind === 'malformed' && /EXACTLY ONE/.test((e as any).reason),
  );
});

test('D.34.C5 TOOL: end_turn without submission is an absent format defect', () => {
  const t = new SubmitResultTransport();
  assert.throws(
    () => t.extractProduce('{"goal":"sneaky — final text is NOT the result"}', CTX),
    (e: Error) => e.name === 'TransportParseError' && (e as any).kind === 'absent',
  );
});

test('D.34.C5 TEACHING: tool framing, schema embedded, no textual-envelope syntax', () => {
  const t = new SubmitResultTransport();
  const teaching = t.formatInstruction(CTX);
  assert.ok(teaching.includes(SUBMIT_RESULT_TOOL_NAME));
  assert.ok(teaching.includes('EXACTLY ONCE'), 'cardinality taught');
  assert.ok(teaching.includes(SCHEMA_TEXT), 'annotations ride along');
  assert.ok(!teaching.includes(SLE_OPEN) && !teaching.includes('### '), 'no textual-envelope teaching');
  const repair = t.repairInstruction(CTX, 'absent');
  assert.match(repair, new RegExp(SUBMIT_RESULT_TOOL_NAME));
  assert.ok(!repair.includes('SLE-OUTPUT'));
  const rejection = t.toolRejectionTurn('tu_1', 'REASON: DECISION_REF_MISSING');
  assert.deepEqual(rejection, { type: 'tool_result', tool_use_id: 'tu_1', content: 'REASON: DECISION_REF_MISSING' });
});

// ─── E2E through buildAgentRunner (multi-turn provider with real tools) ───────

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

interface TurnSpec {
  stop_reason: 'end_turn' | 'tool_use';
  text?: string;
  tool_uses?: Array<{ id: string; name: string; input: unknown }>;
}

class ScriptedToolProvider implements ILLMProvider {
  public multiTurnCalls: Array<{ messages: unknown; tools: Array<{ name: string }> }> = [];
  private turn = 0;
  constructor(private turns: TurnSpec[]) {}
  async complete(_params: LLMCompletionParams): Promise<LLMCompletionResult> {
    throw new Error('single-turn path must not be used in this test');
  }
  async completeMultiTurn(params: any): Promise<any> {
    this.multiTurnCalls.push({ messages: params.messages, tools: params.tools });
    const i = Math.min(this.turn, this.turns.length - 1);
    this.turn++;
    const t = this.turns[i];
    return { stop_reason: t.stop_reason, text: t.text ?? '', tool_uses: t.tool_uses ?? [], tokens_used: 10 };
  }
}

function makeHarness(turns: TurnSpec[]) {
  const root = mkdtempSync(join(tmpdir(), 'd34-c5-'));
  const provider = new ScriptedToolProvider(turns);
  const artifacts = new RecordingArtifacts();
  const runner = buildAgentRunner(
    new ScriptedContextManager(),
    provider,
    root,
    {
      writeNodeOutput: async () => {},
      updateNodeStatus: async () => {},
    } as unknown as RunArtifactManager,
    'test-model',
    artifacts,
    4096,
  );
  return { runner, provider, artifacts, root };
}

function synthesizeCtx(root: string): StepRunContext {
  return {
    workflowRunId: 'r', workflowId: 'define-work', stepId: 'synthesize-definition',
    iteration: 1, revision: 0, goal: 'g',
    projectRoot: root, role: 'explorer',
    outputArtifact: { type: 'definition', ref: 'definition:{objectiveId}', path: '.sle/work/w/definition.md' },
  } as unknown as StepRunContext;
}

const submit = (input: unknown, id = 'sub1') => ({ id, name: SUBMIT_RESULT_TOOL_NAME, input });

test('D.34.C5 E2E: read tools + one submission → proposal decoded, SYSTEM bytes, provenance, metadata', async () => {
  const h = makeHarness([
    { stop_reason: 'tool_use', tool_uses: [{ id: 'r1', name: 'list_directory', input: { path: '.' } }] },
    { stop_reason: 'tool_use', tool_uses: [submit(VALID_PROPOSAL)] },
  ]);
  const result = await h.runner.run('explorer', synthesizeCtx(h.root));
  assert.equal(result.success, true, result.error);
  const written = readFileSync(join(h.root, '.sle/work/w/definition.md'), 'utf-8');
  assert.equal(written, renderDefinition(VALID_PROPOSAL), 'wire changed; materialization did not');
  assert.equal(h.artifacts.saved.length, 1, 'provenance recorded');
  assert.equal(result.result_repairs, undefined, 'clean run: no repair counter');
  // The submission tool was offered with the contract projection as its schema.
  const tools = h.provider.multiTurnCalls[0].tools;
  const offered = tools.find((t) => t.name === SUBMIT_RESULT_TOOL_NAME);
  assert.ok(offered, 'submit_result offered alongside read tools');
  // The negotiated transport is part of the run record.
  const meta = JSON.parse(readFileSync(join(h.root, '.sle/runs/r/1/node-outputs/synthesize-definition-loop.json'), 'utf-8'));
  assert.equal(meta.result_transport, 'submit-result');
});

test('D.34.C5 E2E: rejection continues via tool_result carrying the acceptor instruction', async () => {
  const h = makeHarness([
    { stop_reason: 'tool_use', tool_uses: [submit(INVALID_PROPOSAL)] },
    { stop_reason: 'tool_use', tool_uses: [submit({ ...INVALID_PROPOSAL, facts: [{ id: 'F1', statement: 'Decided.', status: 'DECIDED', source: 'decision', decisionRef: 'D-1' }] })] },
  ]);
  const result = await h.runner.run('explorer', synthesizeCtx(h.root));
  assert.equal(result.success, true, result.error);
  assert.equal(result.result_repairs, 1, 'same repair budget and counter as the textual channel');
  // The rejection was delivered as a tool_result payload (the wire change),
  // with the SAME acceptor instruction text (the semantics that did not change).
  const msgs = h.provider.multiTurnCalls[1].messages as Array<{ role: string; content: unknown }>;
  const last = msgs.at(-1) as { role: string; content: Array<{ type: string; content: string }> };
  assert.equal(last.role, 'user');
  const block = last.content.at(-1);
  assert.equal(block.type, 'tool_result');
  assert.match(block.content, /DECISION_REF_MISSING/);
  const written = readFileSync(join(h.root, '.sle/work/w/definition.md'), 'utf-8');
  assert.ok(written.includes('decisionRef: D-1'), 'repaired proposal materialized');
});

test('D.34.C5 E2E: exhaustion fails closed before write/provenance', async () => {
  const h = makeHarness([
    { stop_reason: 'tool_use', tool_uses: [submit(INVALID_PROPOSAL)] },
    { stop_reason: 'tool_use', tool_uses: [submit(INVALID_PROPOSAL)] },
  ]);
  const result = await h.runner.run('explorer', synthesizeCtx(h.root));
  assert.equal(result.success, false);
  assert.match(result.error!, /result repair is exhausted/);
  assert.equal(result.result_repairs, 1);
  assert.equal(h.artifacts.saved.length, 0, 'no provenance');
  assert.equal(existsSync(join(h.root, '.sle/work/w/definition.md')), false, 'no bytes written');
});

test('D.34.C5 E2E: end_turn without submission → bounded format repair, then success', async () => {
  const h = makeHarness([
    { stop_reason: 'end_turn', text: 'I finished my analysis. (no submission)' },
    { stop_reason: 'tool_use', tool_uses: [submit(VALID_PROPOSAL)] },
  ]);
  const result = await h.runner.run('explorer', synthesizeCtx(h.root));
  assert.equal(result.success, true, result.error);
  assert.equal(result.format_repairs, 1, 'format repair (absent), separate from result repair');
  assert.equal(readFileSync(join(h.root, '.sle/work/w/definition.md'), 'utf-8'), renderDefinition(VALID_PROPOSAL));
});

test('D.34.C5 E2E: multiple submissions in one turn → malformed → bounded repair, then success', async () => {
  const h = makeHarness([
    { stop_reason: 'tool_use', tool_uses: [submit({ goal: 'first' }, 's1'), submit({ goal: 'second' }, 's2')] },
    { stop_reason: 'tool_use', tool_uses: [submit(VALID_PROPOSAL)] },
  ]);
  const result = await h.runner.run('explorer', synthesizeCtx(h.root));
  assert.equal(result.success, true, result.error);
  assert.equal(result.format_repairs, 1);
  // BOTH tool_uses were answered (tool protocol), neither payload accepted.
  const msgs = h.provider.multiTurnCalls[1].messages as Array<{ role: string; content: Array<{ type: string; tool_use_id: string }> }>;
  const answered = (msgs.at(-1) as any).content.map((b: any) => b.tool_use_id).sort();
  assert.deepEqual(answered, ['s1', 's2']);
  assert.equal(readFileSync(join(h.root, '.sle/work/w/definition.md'), 'utf-8'), renderDefinition(VALID_PROPOSAL));
});

test('D.34.C5 E2E: mixed read+submission turn fails closed → format repair → sole submission succeeds', async () => {
  // The co-declared read request is NEVER silently ignored: the turn is
  // malformed (terminal-exclusivity rule), both tool_uses are answered, and
  // no result is accepted from that turn; the model then submits alone.
  const h = makeHarness([
    { stop_reason: 'tool_use', tool_uses: [{ id: 'r1', name: 'read_file', input: { path: 'x' } }, submit(VALID_PROPOSAL, 's1')] },
    { stop_reason: 'tool_use', tool_uses: [submit(VALID_PROPOSAL, 's2')] },
  ]);
  const result = await h.runner.run('explorer', synthesizeCtx(h.root));
  assert.equal(result.success, true, result.error);
  assert.equal(result.format_repairs, 1, 'the mixed turn took the FORMAT repair budget');
  assert.equal(result.result_repairs, undefined, 'no result repair — nothing was rejected, nothing was accepted from that turn');
  const msgs = h.provider.multiTurnCalls[1].messages as Array<{ role: string; content: Array<{ type: string; tool_use_id: string; content: string }> }>;
  const blocks = (msgs.at(-1) as any).content;
  assert.deepEqual(blocks.map((b: any) => b.tool_use_id).sort(), ['r1', 's1'], 'every tool_use answered');
  assert.match(blocks[0].content, /investigate with read tools on EARLIER turns/, 'terminal-exclusivity reason delivered');
  // Nothing was materialized from the mixed turn — only the sole submission counts.
  assert.equal(readFileSync(join(h.root, '.sle/work/w/definition.md'), 'utf-8'), renderDefinition(VALID_PROPOSAL));
});

test('D.34.C5 E2E: a legacy (no-contract) step on the SAME runner — no submission tool, textual bytes intact', async () => {
  const legacySection = `${SLE_OPEN}\n### .sle/work/w/decision-request.json\n{"type":"human_decision"}\n${SLE_CLOSE}`;
  const h = makeHarness([
    { stop_reason: 'end_turn', text: `thinking...\n${legacySection}` },
  ]);
  const ctx = {
    workflowRunId: 'r', workflowId: 'define-work', stepId: 'prepare-human-decision',
    iteration: 1, revision: 0, goal: 'g',
    projectRoot: h.root, role: 'explorer',
    outputArtifact: { type: 'decision-request', ref: 'dr:{objectiveId}', path: '.sle/work/w/decision-request.json' },
  } as unknown as StepRunContext;
  const result = await h.runner.run('explorer', ctx);
  assert.equal(result.success, true, result.error);
  assert.ok(!h.provider.multiTurnCalls[0].tools.some((t) => t.name === SUBMIT_RESULT_TOOL_NAME), 'no submission tool on legacy steps');
  const meta = JSON.parse(readFileSync(join(h.root, '.sle/runs/r/1/node-outputs/prepare-human-decision-loop.json'), 'utf-8'));
  assert.equal(meta.result_transport, 'textual-sle-output', 'negotiated transport recorded for the legacy path too');
  assert.equal(readFileSync(join(h.root, '.sle/work/w/decision-request.json'), 'utf-8'), '{"type":"human_decision"}');
});

// ─── Provider wire shapes (both real multi-turn paths) ────────────────────────

test('D.34.C5 WIRE (Anthropic): the submission tool maps onto the SDK tools list; tool_use blocks map back', async () => {
  const captured: Array<any> = [];
  const client: AnthropicClientLike = {
    messages: {
      create: async (params) => {
        captured.push(params);
        return {
          stop_reason: 'tool_use',
          content: [
            { type: 'text', text: 'submitting' },
            { type: 'tool_use', id: 'tu_9', name: SUBMIT_RESULT_TOOL_NAME, input: VALID_PROPOSAL },
          ],
          usage: { input_tokens: 5, output_tokens: 5 },
        } as never;
      },
    },
  };
  const provider = new AnthropicSDKProvider('k', { client, defaultModel: 'm' });
  const out = await provider.completeMultiTurn({
    model: 'm', system: 's', messages: [{ role: 'user', content: 'go' }], max_tokens: 100,
    tools: [
      { name: 'read_file', description: 'd', input_schema: { type: 'object', properties: {}, required: [] } },
      { name: SUBMIT_RESULT_TOOL_NAME, description: 'submit', input_schema: SCHEMA_JSON },
    ],
  });
  const tools = captured[0].tools;
  const submissionTool = tools.find((t: any) => t.name === SUBMIT_RESULT_TOOL_NAME);
  assert.deepEqual(submissionTool.input_schema, SCHEMA_JSON, 'projection reaches the Anthropic wire as input_schema');
  assert.equal(out.stop_reason, 'tool_use');
  assert.deepEqual(out.tool_uses, [{ type: 'tool_use', id: 'tu_9', name: SUBMIT_RESULT_TOOL_NAME, input: VALID_PROPOSAL }]);
});

test('D.34.C5 WIRE (OpenRouter/OpenAI): the submission tool maps onto function tools; tool_calls map back', async () => {
  process.env.SLE_LLM_API_KEY = process.env.SLE_LLM_API_KEY || 'test-key';
  const captured: Array<any> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: any, init: any) => {
    captured.push(JSON.parse(init.body));
    return {
      ok: true,
      json: async () => ({
        choices: [{
          message: { content: null, tool_calls: [{ id: 'call_1', function: { name: SUBMIT_RESULT_TOOL_NAME, arguments: JSON.stringify(VALID_PROPOSAL) } }] },
          finish_reason: 'tool_calls',
        }],
        usage: { total_tokens: 7 },
      }),
    } as never;
  }) as never;
  try {
    const provider = new OpenAICompatibleMultiTurnProvider({
      provider: 'openrouter', base_url: 'https://openrouter.ai/api/v1', model: 'm', api_key_env: 'SLE_LLM_API_KEY',
    });
    const out = await provider.completeMultiTurn({
      model: 'm', system: 's', messages: [{ role: 'user', content: 'go' }], max_tokens: 100,
      tools: [
        { name: 'read_file', description: 'd', input_schema: { type: 'object', properties: {}, required: [] } },
        { name: SUBMIT_RESULT_TOOL_NAME, description: 'submit', input_schema: SCHEMA_JSON },
      ],
    });
    const tools = captured[0].tools;
    const submissionTool = tools.find((t: any) => t.function?.name === SUBMIT_RESULT_TOOL_NAME);
    assert.deepEqual(submissionTool.function.parameters, SCHEMA_JSON, 'projection reaches the OpenAI wire as parameters');
    assert.equal(out.stop_reason, 'tool_use');
    assert.deepEqual(out.tool_uses, [{ type: 'tool_use', id: 'call_1', name: SUBMIT_RESULT_TOOL_NAME, input: VALID_PROPOSAL }]);
  } finally {
    globalThis.fetch = realFetch;
  }
});
