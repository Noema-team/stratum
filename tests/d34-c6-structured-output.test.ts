// D.34 C6 — the native structured-output capability + the review-step
// structured channel (DDR-034 §6): native structured output is another WIRE
// capability, NOT a new contract path.
//
// THE C6 GATE: a readiness review executed through completeStructured must
// produce the same ReadinessProposal semantics, go through the same
// decode/validate/typed-route/materialize pipeline, and yield byte-identical
// readiness output and identical routing to the textual review channel.
//
// Additional locked requirements:
//   - fallback by CAPABILITY, not provider name: a provider without
//     completeStructured keeps the existing textual review path unchanged;
//   - the structured channel slots into the EXISTING single-turn review
//     policy — produce steps keep the C5 submit_result negotiation; this
//     seam never reopens multi-turn review.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildAgentRunner } from '../src/application.js';
import { AgentRunner } from '../src/agent-runner.js';
import type { ILLMProvider, LLMCompletionParams, LLMCompletionResult } from '../src/llm-provider.js';
import type { IStructuredProvider, StructuredCompletionParams, StructuredCompletionResult } from '../src/llm-provider.js';
import type { ContextManager } from '../src/context-manager.js';
import type { AssembledContext } from '../src/types.js';
import type { StepRunContext } from '../src/workflow/types.js';
import type { RunArtifactManager } from '../src/run-artifacts.js';
import type { ArtifactRepository } from '../src/storage/repositories.js';
import { DynamicLLMProvider, OpenAICompatibleStructuredProvider } from '../src/llm-provider.js';
import { AnthropicSDKProvider, type AnthropicClientLike } from '../src/anthropic-provider.js';
import { toJsonSchema } from '../src/workflow/contracts.js';
import { validateDefinitionArtifactText } from '../src/workflow/methodology/definition-artifact.js';
import { READINESS_OUTPUT_CONTRACT, renderReadiness, type ReadinessProposal } from '../src/workflow/methodology/readiness-contract.js';
import { SUBMIT_RESULT_TOOL_NAME } from '../src/transport/step-result.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const VALID_DEFINITION = `---
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

const FAIL_PROPOSAL: ReadinessProposal = {
  verdict: 'fail',
  gaps: [
    {
      target: 'F1',
      factId: 'F1',
      description: 'Scope membership undecided',
      classification: 'HUMAN_DECISION',
      reason: 'Only a human can authorize the boundary.',
      closure: 'Record a Decision and mark F1 DECIDED.',
    },
  ],
  bodyMarkdown: 'Review notes.',
};

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

/**
 * Single-turn review provider. `structured` flips the CAPABILITY on or off —
 * the same provider class proves both sides of the capability probe. The
 * method is an OWN PROPERTY, assigned only when genuinely present — the same
 * honest-capability discipline DynamicLLMProvider uses (the runner's probe
 * is method presence, not behavior).
 */
class ReviewProvider implements ILLMProvider {
  public completeCalls: LLMCompletionParams[] = [];
  public structuredCalls: StructuredCompletionParams[] = [];
  // Capability probe target — present ONLY when genuinely structured.
  completeStructured?: (params: StructuredCompletionParams) => Promise<StructuredCompletionResult>;
  constructor(
    structured: boolean,
    private structuredValues: unknown[],
    private textualReplies: string[] = [],
  ) {
    if (structured) {
      this.completeStructured = async (params) => {
        this.structuredCalls.push(params);
        const i = Math.min(this.structuredCalls.length - 1, this.structuredValues.length - 1);
        return { value: this.structuredValues[i], tokens_used: 10, duration_ms: 1 };
      };
    }
  }
  async complete(params: LLMCompletionParams): Promise<LLMCompletionResult> {
    this.completeCalls.push(params);
    if (this.textualReplies.length === 0) throw new Error('textual complete() must not be called on the structured wire');
    const r = this.textualReplies[Math.min(this.completeCalls.length - 1, this.textualReplies.length - 1)];
    return { content: r, tokens_used: 10, duration_ms: 1 };
  }
}

function makeHarness(provider: ILLMProvider) {
  const root = mkdtempSync(join(tmpdir(), 'd34-c6-'));
  mkdirSync(join(root, '.sle/work/w'), { recursive: true });
  writeFileSync(join(root, '.sle/work/w/definition.md'), VALID_DEFINITION, 'utf-8');
  const artifacts = new RecordingArtifacts();
  const rawOutputs: string[] = [];
  const runner = buildAgentRunner(
    new ScriptedContextManager(),
    provider,
    root,
    {
      writeNodeOutput: async (_r: unknown, _i: unknown, _n: unknown, content: string) => {
        rawOutputs.push(content);
      },
      updateNodeStatus: async () => {},
    } as unknown as RunArtifactManager,
    'test-model',
    artifacts,
    4096,
  );
  return { runner, artifacts, rawOutputs, root };
}

function reviewCtx(root: string): StepRunContext {
  // Literal run paths (the engine materializes placeholders upstream).
  return {
    workflowRunId: 'r', workflowId: 'define-work', stepId: 'definition-readiness-review',
    iteration: 1, revision: 0, goal: 'g',
    projectRoot: root, role: 'explorer',
    requiresReviewVerdict: true,
    inputValidator: 'definition',
    inputArtifactRefs: ['.sle/work/w/definition.md'],
    outputArtifact: { type: 'definition-readiness', ref: 'definition-readiness:{objectiveId}', path: '.sle/work/w/readiness.md' },
    on_fail_routes: {
      refine: { target_step_id: 'refine-definition', iteration_loop: true },
      human: { target_step_id: 'prepare-human-decision' },
    },
  } as unknown as StepRunContext;
}

// ─── THE C6 GATE: structured review ≡ textual review ─────────────────────────

test('D.34.C6 GATE: structured and textual review channels yield byte-identical output and identical routing', async () => {
  const structured = makeHarness(new ReviewProvider(true, [structuredCopy(FAIL_PROPOSAL)]));
  const textual = makeHarness(new ReviewProvider(false, [], [JSON.stringify(FAIL_PROPOSAL)]));

  const viaStructured = await structured.runner.run('explorer', reviewCtx(structured.root));
  const viaTextual = await textual.runner.run('explorer', reviewCtx(textual.root));

  assert.equal(viaStructured.success, true, viaStructured.error);
  assert.equal(viaTextual.success, true, viaTextual.error);
  // Byte-identical SYSTEM output.
  const sBytes = readFileSync(join(structured.root, '.sle/work/w/readiness.md'), 'utf-8');
  const tBytes = readFileSync(join(textual.root, '.sle/work/w/readiness.md'), 'utf-8');
  assert.equal(sBytes, renderReadiness(FAIL_PROPOSAL), 'structured wire → renderer bytes');
  assert.equal(sBytes, tBytes, 'the two wires are byte-identical');
  // Identical typed routing.
  assert.equal(viaStructured.reviewVerdict, 'fail');
  assert.equal(viaStructured.reviewRoute, 'human');
  assert.equal(viaStructured.reviewVerdict, viaTextual.reviewVerdict);
  assert.equal(viaStructured.reviewRoute, viaTextual.reviewRoute);
  // Identical provenance shape.
  assert.deepEqual(structured.artifacts.saved.map((s) => s.ref), textual.artifacts.saved.map((s) => s.ref));
});

function structuredCopy(p: ReadinessProposal): unknown {
  return JSON.parse(JSON.stringify(p));
}

test('D.34.C6 GATE: the schema reaching the provider API IS the contract projection', async () => {
  const provider = new ReviewProvider(true, [structuredCopy(FAIL_PROPOSAL)]);
  const h = makeHarness(provider);
  await h.runner.run('explorer', reviewCtx(h.root));
  assert.equal(provider.structuredCalls.length, 1);
  assert.deepEqual(
    provider.structuredCalls[0].schema,
    toJsonSchema(READINESS_OUTPUT_CONTRACT.modelSchema),
    'the projection — never a hand-written schema',
  );
  assert.equal(provider.structuredCalls[0].schemaName, 'definition-readiness');
  // Semantics ride in the message; NO envelope syntax is taught.
  const userMsg = provider.structuredCalls[0].messages[0].content;
  assert.ok(!userMsg.includes('SLE-OUTPUT'), 'no envelope teaching on the structured wire');
  assert.match(userMsg, /RESULT SHAPE/, 'field-meaning annotations still taught');
});

test('D.34.C6 WIRE: single-shot — complete() never called on the structured channel, no format repairs', async () => {
  const provider = new ReviewProvider(true, [structuredCopy(FAIL_PROPOSAL)]);
  const h = makeHarness(provider);
  const result = await h.runner.run('explorer', reviewCtx(h.root));
  assert.equal(result.success, true, result.error);
  assert.equal(provider.completeCalls.length, 0, 'the textual completion API is never used');
  // Same observable shape as a clean textual single-turn run: format_repairs
  // present at zero (no envelope → no format repair ever occurred).
  assert.equal(result.format_repairs, 0, 'no format repair on the structured wire (same shape as clean textual runs)');
  // The raw record is the structured reply itself.
  assert.deepEqual(JSON.parse(h.rawOutputs.at(-1)!), structuredCopy(FAIL_PROPOSAL));
});

// ─── Repair semantics: same budgets, same pipeline ────────────────────────────

test('D.34.C6 REPAIR: methodology defect → same acceptor instruction, same budget, then success', async () => {
  const bad = { verdict: 'fail', gaps: [], bodyMarkdown: '' };
  const provider = new ReviewProvider(true, [bad, structuredCopy(FAIL_PROPOSAL)]);
  const h = makeHarness(provider);
  const result = await h.runner.run('explorer', reviewCtx(h.root));
  assert.equal(result.success, true, result.error);
  assert.equal(result.result_repairs, 1, 'same result-repair budget as every other wire');
  // The re-issue carried the previous assistant turn (raw JSON) + the SAME repair instruction.
  const msgs = provider.structuredCalls[1].messages;
  assert.equal(msgs.length, 3);
  assert.equal(msgs[1].role, 'assistant');
  assert.deepEqual(JSON.parse(msgs[1].content), bad);
  assert.match(msgs[2].content, /FAIL_WITHOUT_GAPS/, 'the acceptor text — identical across wires');
  assert.equal(readFileSync(join(h.root, '.sle/work/w/readiness.md'), 'utf-8'), renderReadiness(FAIL_PROPOSAL));
});

test('D.34.C6 REPAIR: exhaustion fails closed before write/provenance', async () => {
  const bad = { verdict: 'fail', gaps: [], bodyMarkdown: '' };
  const provider = new ReviewProvider(true, [bad, bad]);
  const h = makeHarness(provider);
  const result = await h.runner.run('explorer', reviewCtx(h.root));
  assert.equal(result.success, false);
  assert.match(result.error!, /result repair is exhausted/);
  assert.equal(h.artifacts.saved.length, 0, 'no provenance');
  assert.equal(existsSync(join(h.root, '.sle/work/w/readiness.md')), false, 'no bytes written');
});

// ─── Fallback by capability, not provider name ────────────────────────────────

test('D.34.C6 FALLBACK: a provider WITHOUT the capability keeps the textual review path unchanged', async () => {
  const textualReply = JSON.stringify(FAIL_PROPOSAL);
  const provider = new ReviewProvider(false, [], [textualReply]);
  const h = makeHarness(provider);
  const result = await h.runner.run('explorer', reviewCtx(h.root));
  assert.equal(result.success, true, result.error);
  assert.equal(provider.structuredCalls.length, 0, 'no structured call — capability absent');
  // The textual proposal teaching (C3 wire) was in the message.
  const userMsg = provider.completeCalls[0].messages.at(-1)!.content;
  assert.match(userMsg, /SINGLE JSON object/);
  assert.equal(readFileSync(join(h.root, '.sle/work/w/readiness.md'), 'utf-8'), renderReadiness(FAIL_PROPOSAL));
});

test('D.34.C6 FALLBACK: a step WITHOUT a registered contract stays textual even on a structured-capable provider', async () => {
  const provider = new ReviewProvider(true, []);
  const h = makeHarness(provider);
  const ctx = {
    workflowRunId: 'r', workflowId: 'define-work', stepId: 'record-notes',
    iteration: 1, revision: 0, goal: 'g',
    projectRoot: h.root, role: 'explorer',
    outputArtifact: { type: 'notes', ref: 'notes:{objectiveId}', path: '.sle/work/w/notes.md' },
  } as unknown as StepRunContext;
  provider.textualReplies.push([
    '<!-- SLE-OUTPUT',
    'role: explorer',
    'node: prepare-human-decision',
    'artifacts:',
    '  - id: notes',
    '    path: .sle/work/w/notes.md',
    '-->',
    '',
    '## .sle/work/w/notes.md',
    '',
    'legacy free-form bytes',
  ].join('\n'));
  const result = await h.runner.run('explorer', ctx);
  assert.equal(result.success, true, result.error);
  assert.equal(provider.structuredCalls.length, 0, 'no schema → no structured call (capability alone is not enough)');
  assert.equal(readFileSync(join(h.root, '.sle/work/w/notes.md'), 'utf-8'), 'legacy free-form bytes');
});

// ─── C6 boundary: produce steps keep the C5 negotiation ───────────────────────

test('D.34.C6 BOUNDARY: a produce step on a provider with BOTH capabilities stays on submit_result, single-shot structured unused', async () => {
  const root = mkdtempSync(join(tmpdir(), 'd34-c6-boundary-'));
  const provider = new BothCapabilitiesProvider();
  const artifacts = new RecordingArtifacts();
  const runner = buildAgentRunner(
    new ScriptedContextManager(),
    provider,
    root,
    { writeNodeOutput: async () => {}, updateNodeStatus: async () => {} } as unknown as RunArtifactManager,
    'test-model',
    artifacts,
    4096,
  );
  const ctx = {
    workflowRunId: 'r', workflowId: 'define-work', stepId: 'synthesize-definition',
    iteration: 1, revision: 0, goal: 'g',
    projectRoot: root, role: 'explorer',
    outputArtifact: { type: 'definition', ref: 'definition:{objectiveId}', path: '.sle/work/w/definition.md' },
  } as unknown as StepRunContext;
  const result = await runner.run('explorer', ctx);
  assert.equal(result.success, true, result.error);
  assert.equal(provider.structuredCalls.length, 0, 'structured output is the REVIEW channel, not a produce bypass');
  assert.ok(
    provider.multiTurnTools.some((t: any) => t.name === SUBMIT_RESULT_TOOL_NAME),
    'produce negotiation is unchanged (C5)',
  );
  assert.match(readFileSync(join(root, '.sle/work/w/definition.md'), 'utf-8'), /^---\nschemaVersion: 1\n/);
});

class BothCapabilitiesProvider implements ILLMProvider, IStructuredProvider {
  public structuredCalls: StructuredCompletionParams[] = [];
  public multiTurnTools: Array<{ name: string }> = [];
  async complete(): Promise<LLMCompletionResult> {
    throw new Error('single-turn complete() must not be used for multi-turn produce');
  }
  async completeStructured(params: StructuredCompletionParams): Promise<StructuredCompletionResult> {
    this.structuredCalls.push(params);
    return { value: {}, tokens_used: 1, duration_ms: 1 };
  }
  async completeMultiTurn(params: any): Promise<any> {
    this.multiTurnTools = params.tools;
    return {
      stop_reason: 'tool_use',
      text: '',
      tool_uses: [{ id: 's1', name: SUBMIT_RESULT_TOOL_NAME, input: {
        goal: 'Ship the widget',
        facts: [{ id: 'F1', statement: 'It must ship.', status: 'KNOWN', source: 'human' }],
        bodyMarkdown: '',
      } }],
      tokens_used: 10,
    };
  }
}

// ─── Capability plumbing (DynamicLLMProvider syncs like multi-turn) ───────────

test('D.34.C6 CAPABILITY: DynamicLLMProvider syncs completeStructured honestly across provider swaps', () => {
  const structuredProvider = new ReviewProvider(true, []);
  const plainProvider = new ReviewProvider(false, []);
  const dyn = new DynamicLLMProvider(structuredProvider);
  assert.equal(typeof (dyn as { completeStructured?: unknown }).completeStructured, 'function', 'capability present when genuinely implemented');
  dyn.setProvider(plainProvider);
  assert.equal((dyn as { completeStructured?: unknown }).completeStructured, undefined, 'capability genuinely absent after swap');
  dyn.setProvider(structuredProvider);
  assert.equal(typeof (dyn as { completeStructured?: unknown }).completeStructured, 'function', 'and restored');
});

// ─── C6 review closures ───────────────────────────────────────────────────────

// Closure 1 — structured is REVIEW-ONLY by INVARIANT: a structured-only
// provider (no completeMultiTurn) must NOT run a Definition produce step
// through the structured channel; the C4 textual single-turn proposal path
// stays the produce fallback.
test('D.34.C6 CLOSURE 1: a structured-only provider runs Definition produce on the TEXTUAL path', async () => {
  const root = mkdtempSync(join(tmpdir(), 'd34-c6-c1-'));
  const provider = new ReviewProvider(true, [{ hijacked: true }]);
  const artifacts = new RecordingArtifacts();
  const runner = buildAgentRunner(
    new ScriptedContextManager(),
    provider,
    root,
    { writeNodeOutput: async () => {}, updateNodeStatus: async () => {} } as unknown as RunArtifactManager,
    'test-model',
    artifacts,
    4096,
  );
  const ctx = {
    workflowRunId: 'r', workflowId: 'define-work', stepId: 'synthesize-definition',
    iteration: 1, revision: 0, goal: 'g',
    projectRoot: root, role: 'explorer',
    outputArtifact: { type: 'definition', ref: 'definition:{objectiveId}', path: '.sle/work/w/definition.md' },
  } as unknown as StepRunContext;
  // The C4 textual single-turn proposal wire (pure JSON reply).
  provider.textualReplies.push(JSON.stringify({
    goal: 'Ship the widget',
    facts: [{ id: 'F1', statement: 'It must ship.', status: 'KNOWN', source: 'human' }],
    bodyMarkdown: '',
  }));
  const result = await runner.run('explorer', ctx);
  assert.equal(result.success, true, result.error);
  assert.equal(provider.structuredCalls.length, 0, 'completeStructured NOT called for a produce step — by invariant');
  assert.equal(provider.completeCalls.length, 1, 'the C4 textual proposal channel handled the produce step');
  assert.match(readFileSync(join(root, '.sle/work/w/definition.md'), 'utf-8'), /^---\nschemaVersion: 1\n/, 'renderer bytes');
});

// Closure 2 — response-side cardinality is authoritative on the Anthropic
// structured wire: 0 → fail, 1 → accept, 2 → fail.
test('D.34.C6 CLOSURE 2: Anthropic structured extraction enforces EXACTLY ONE result tool block', async () => {
  const schema = toJsonSchema(READINESS_OUTPUT_CONTRACT.modelSchema);
  const makeClient = (content: unknown[]) => ({
    messages: { create: async () => ({ stop_reason: 'tool_use', content, usage: { input_tokens: 1, output_tokens: 1 } } as never) },
  });
  const block = { type: 'tool_use', id: 'a', name: 'definition-readiness', input: structuredCopy(FAIL_PROPOSAL) };
  const second = { type: 'tool_use', id: 'b', name: 'definition-readiness', input: { verdict: 'pass', gaps: [], bodyMarkdown: '' } };

  const one = new AnthropicSDKProvider('k', { client: makeClient([block]) as unknown as AnthropicClientLike, defaultModel: 'm' });
  const ok = await one.completeStructured({ model: 'm', messages: [{ role: 'user', content: 'x' }], max_tokens: 10, schema, schemaName: 'definition-readiness' });
  assert.deepEqual(ok.value, structuredCopy(FAIL_PROPOSAL), 'exactly one block → accepted');

  const zero = new AnthropicSDKProvider('k', { client: makeClient([{ type: 'text', text: 'prose' }]) as unknown as AnthropicClientLike, defaultModel: 'm' });
  await assert.rejects(
    () => zero.completeStructured({ model: 'm', messages: [{ role: 'user', content: 'x' }], max_tokens: 10, schema, schemaName: 'definition-readiness' }),
    /returned 0 result tool blocks; expected exactly one/,
  );

  const two = new AnthropicSDKProvider('k', { client: makeClient([block, second]) as unknown as AnthropicClientLike, defaultModel: 'm' });
  await assert.rejects(
    () => two.completeStructured({ model: 'm', messages: [{ role: 'user', content: 'x' }], max_tokens: 10, schema, schemaName: 'definition-readiness' }),
    /returned 2 result tool blocks; expected exactly one/,
    'competing semantic results fail closed — never the first one selected',
  );

  // The API layer was ASKED not to emit parallel calls (response-side check above stays authoritative).
  const captured: Array<any> = [];
  const capClient: AnthropicClientLike = {
    messages: { create: async (params) => { captured.push(params); return { stop_reason: 'tool_use', content: [block], usage: {} } as never; } },
  };
  await new AnthropicSDKProvider('k', { client: capClient, defaultModel: 'm' }).completeStructured({
    model: 'm', messages: [{ role: 'user', content: 'x' }], max_tokens: 10, schema, schemaName: 'definition-readiness',
  });
  assert.equal((captured[0].tool_choice as any).disable_parallel_tool_use, true);
});

// Closure 3 — sampling parity: the structured wire forwards the SAME
// temperature the textual wire gets, on both provider request shapes.
test('D.34.C6 CLOSURE 3: temperature parity — runner → params → both provider wires', async () => {
  // Runner side: a non-default runnerConfig temperature reaches completeStructured.
  const root = mkdtempSync(join(tmpdir(), 'd34-c6-c3-'));
  mkdirSync(join(root, '.sle/work/w'), { recursive: true });
  writeFileSync(join(root, '.sle/work/w/definition.md'), VALID_DEFINITION, 'utf-8');
  const provider = new ReviewProvider(true, [structuredCopy(FAIL_PROPOSAL)]);
  const runner = new AgentRunner(
    new ScriptedContextManager(),
    provider,
    root,
    { writeNodeOutput: async () => {} } as unknown as RunArtifactManager,
    { model: 'test-model', temperature: 0.2, outputContracts: { 'definition-readiness': READINESS_OUTPUT_CONTRACT }, inputValidators: { definition: validateDefinitionArtifactText } },
    undefined,
    new RecordingArtifacts(),
  );
  const result = await runner.run('explorer', reviewCtx(root));
  assert.equal(result.success, true, result.error);
  assert.equal(provider.structuredCalls[0].temperature, 0.2, 'the runner passes its configured temperature, not silence');

  // OpenAI wire: body.temperature carries it.
  process.env.SLE_LLM_API_KEY = process.env.SLE_LLM_API_KEY || 'test-key';
  const captured: Array<any> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: any, init: any) => {
    captured.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{}', } }], usage: {} }) } as never;
  }) as never;
  try {
    const oai = new OpenAICompatibleStructuredProvider({
      provider: 'openrouter', base_url: 'https://openrouter.ai/api/v1', model: 'm', api_key_env: 'SLE_LLM_API_KEY',
    });
    await oai.completeStructured({
      model: 'm', messages: [{ role: 'user', content: 'x' }], max_tokens: 10,
      schema: {}, schemaName: 'definition-readiness', temperature: 0.2,
    });
    assert.equal(captured[0].temperature, 0.2, 'OpenAI wire forwards temperature');
  } finally {
    globalThis.fetch = realFetch;
  }

  // Anthropic wire: messages.create carries it.
  const anthropicCaptured: Array<any> = [];
  const aClient: AnthropicClientLike = {
    messages: { create: async (params) => { anthropicCaptured.push(params); return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'a', name: 'definition-readiness', input: {} }], usage: {} } as never; } },
  };
  await new AnthropicSDKProvider('k', { client: aClient, defaultModel: 'm' }).completeStructured({
    model: 'm', messages: [{ role: 'user', content: 'x' }], max_tokens: 10,
    schema: {}, schemaName: 'definition-readiness', temperature: 0.2,
  });
  assert.equal(anthropicCaptured[0].temperature, 0.2, 'Anthropic wire forwards temperature');
});

// ─── Provider wire shapes ─────────────────────────────────────────────────────

test('D.34.C6 WIRE (OpenAI/OpenRouter): response_format json_schema strict carries the projection', async () => {
  process.env.SLE_LLM_API_KEY = process.env.SLE_LLM_API_KEY || 'test-key';
  const captured: Array<any> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: any, init: any) => {
    captured.push(JSON.parse(init.body));
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(FAIL_PROPOSAL) } }],
        usage: { total_tokens: 9 },
      }),
    } as never;
  }) as never;
  try {
    const provider = new OpenAICompatibleStructuredProvider({
      provider: 'openrouter', base_url: 'https://openrouter.ai/api/v1', model: 'm', api_key_env: 'SLE_LLM_API_KEY',
    });
    const schema = toJsonSchema(READINESS_OUTPUT_CONTRACT.modelSchema);
    const out = await provider.completeStructured({
      model: 'm', system: 's', messages: [{ role: 'user', content: 'go' }], max_tokens: 100,
      schema, schemaName: 'definition-readiness',
    });
    const rf = captured[0].response_format;
    assert.equal(rf.type, 'json_schema');
    assert.equal(rf.json_schema.name, 'definition-readiness');
    assert.equal(rf.json_schema.strict, true);
    assert.deepEqual(rf.json_schema.schema, schema, 'the projection verbatim');
    assert.deepEqual(out.value, structuredCopy(FAIL_PROPOSAL));
    assert.equal(out.tokens_used, 9);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('D.34.C6 WIRE (Anthropic): forced single-tool extraction — input IS the value; no tool block fails closed', async () => {
  const captured: Array<any> = [];
  const client: AnthropicClientLike = {
    messages: {
      create: async (params) => {
        captured.push(params);
        return {
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: 't1', name: 'definition-readiness', input: structuredCopy(FAIL_PROPOSAL) }],
          usage: { input_tokens: 3, output_tokens: 4 },
        } as never;
      },
    },
  };
  const provider = new AnthropicSDKProvider('k', { client, defaultModel: 'm' });
  const schema = toJsonSchema(READINESS_OUTPUT_CONTRACT.modelSchema);
  const out = await provider.completeStructured({
    model: 'm', system: 's', messages: [{ role: 'user', content: 'go' }], max_tokens: 100,
    schema, schemaName: 'definition-readiness',
  });
  const call = captured[0];
  assert.deepEqual(call.tool_choice, { type: 'tool', name: 'definition-readiness', disable_parallel_tool_use: true }, 'choice FORCED — not a tool loop; parallel emission disabled at the API layer');
  assert.equal(call.tools.length, 1);
  assert.deepEqual(call.tools[0].input_schema, schema);
  assert.deepEqual(out.value, structuredCopy(FAIL_PROPOSAL));
  assert.equal(out.tokens_used, 7);

  const emptyClient: AnthropicClientLike = {
    messages: { create: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'prose' }], usage: {} } as never) },
  };
  const strict = new AnthropicSDKProvider('k', { client: emptyClient, defaultModel: 'm' });
  await assert.rejects(
    () => strict.completeStructured({ model: 'm', messages: [{ role: 'user', content: 'x' }], max_tokens: 10, schema }),
    /returned 0 result tool blocks; expected exactly one/,
    'prose from a forced structured call fails closed (zero-block cardinality)',
  );
});
