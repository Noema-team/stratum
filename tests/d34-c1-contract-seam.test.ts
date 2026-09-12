// D.34 C1 — the output-contract seam (DDR-034 §5), no real contract registered.
//
// Locks the C1 acceptance criteria from docs/developmentPlan/d34-output-contracts.md:
//
//   - the pinned schema-projection adapter: generated, deterministic, and
//     annotation keys that must resolve against the projection;
//   - the result-repair policy: separate budget/counter from format repair;
//   - the runner contract path: decode → validate → reviewVerdict /
//     deriveRoute → materialize → the EXISTING gated write pipeline, with
//     the model never authoring bytes, paths, or schema versions;
//   - fail-closed authoring/negotiation errors: proposal with no registered
//     contract; contract registered but materialized bytes produced
//     (rule 4); review contract without reviewVerdict; fail-route step whose
//     contract lacks deriveRoute — all before any LLM call where applicable;
//   - the result-repair seam on BOTH execution paths: one bounded in-step
//     repair (MAX_RESULT_REPAIRS = 1), its own result_repairs counter,
//     exhaustion failing closed BEFORE write/provenance, and — critically —
//     zero workflow-iteration consumption;
//   - identity: contracts carry no id; the registry key (the workflow's
//     declared outputArtifact.type) is the only contract identity.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import { AgentRunner } from '../src/agent-runner.js';
import { AgentLoop, type IMultiTurnProvider, type MultiTurnResult, type MultiTurnParams } from '../src/agent-loop.js';
import type { RunArtifactManager } from '../src/run-artifacts.js';
import type { ILLMProvider, LLMCompletionParams, LLMCompletionResult } from '../src/llm-provider.js';
import type { ContextManager } from '../src/context-manager.js';
import type { AssembledContext } from '../src/types.js';
import type { StepRunContext } from '../src/workflow/types.js';
import type { ArtifactRepository } from '../src/storage/repositories.js';
import {
  type ResultTransport,
  type StepResult,
  type TransportContext,
  MAX_RESULT_REPAIRS,
  resultRepairDecision,
  resultRepairExhaustedDiagnostic,
  resultKindNegotiationDiagnostic,
  TransportParseError,
} from '../src/transport/step-result.js';
import {
  type OutputContract,
  type ContractDefect,
  toJsonSchema,
  validateSchemaAnnotations,
  renderSchemaTeaching,
} from '../src/workflow/contracts.js';

// ─── Projection adapter (pinned) ──────────────────────────────────────────────

const SAMPLE_SCHEMA = z.object({
  goal: z.string(),
  facts: z.array(z.object({ id: z.string(), status: z.enum(['KNOWN', 'ASSUMED']) })),
  closure: z.string().optional(),
});

test('D.34.C1: toJsonSchema is a generated, deterministic, self-contained projection — GOLDEN-PINNED', () => {
  const a = toJsonSchema(SAMPLE_SCHEMA);
  const b = toJsonSchema(SAMPLE_SCHEMA);
  assert.deepEqual(a, b, 'projection must be deterministic');
  // C1 review fix — the ENTIRE generated projection is pinned. This is the
  // golden: a zod-to-json-schema bump or adapter-option change that alters
  // provider-facing schemas in ANY way fails here and requires regenerating
  // this fixture in the same commit (DDR-034 §5.1). Do not weaken to
  // field-by-field assertions.
  assert.deepEqual(a, {
    type: 'object',
    properties: {
      goal: { type: 'string' },
      facts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            status: { type: 'string', enum: ['KNOWN', 'ASSUMED'] },
          },
          required: ['id', 'status'],
          additionalProperties: false,
        },
      },
      closure: { type: 'string' },
    },
    required: ['goal', 'facts'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  });
});

test('D.34.C1: schema annotation keys are mechanically validated against the projection', () => {
  const ok = validateSchemaAnnotations(SAMPLE_SCHEMA, {
    root: 'Judge the ledger honestly.',
    fields: { '/goal': 'One concrete outcome.', '/facts': 'The ledger.', '/facts/items/status': 'Epistemic status.' },
  });
  assert.deepEqual(ok, { ok: true });

  const bad = validateSchemaAnnotations(SAMPLE_SCHEMA, {
    fields: { '/goals': 'typo — not a field', '/facts/items/kind': 'not in this schema' },
  });
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.equal(bad.errors.length, 2);
    assert.match(bad.errors[0], /\/goals.*does not resolve/);
    assert.match(bad.errors[1], /\/facts\/items\/kind.*does not resolve/);
  }
});

test('D.34.C1: renderSchemaTeaching embeds the generated projection plus structured annotations only', () => {
  const contract: OutputContract<{ goal: string }> = {
    modelSchema: z.object({ goal: z.string() }),
    schemaAnnotations: { root: 'One goal.', fields: { '/goal': 'Concrete.' } },
    materialize: (v) => `goal: ${v.goal}\n`,
  };
  const text = renderSchemaTeaching(contract);
  assert.match(text, /json-schema\.org\/draft-07/);
  assert.match(text, /One goal\./);
  assert.match(text, /\/goal: Concrete\./);
});

// ─── Result-repair policy ─────────────────────────────────────────────────────

test('D.34.C1: result repair is bounded at exactly one attempt, separate from format repair', () => {
  assert.equal(MAX_RESULT_REPAIRS, 1);
  assert.deepEqual(resultRepairDecision(0), { action: 'repair' });
  assert.deepEqual(resultRepairDecision(1), { action: 'fail-closed' });
  const diag = resultRepairExhaustedDiagnostic('definition', 'bad shape', 3, 1);
  assert.match(diag, /result repair is exhausted/);
  assert.match(diag, /output contract 'definition'/);
  assert.match(diag, /1 result-repair attempt/);
  const nego = resultKindNegotiationDiagnostic('definition', 'materialized bytes');
  assert.match(nego, /negotiation error/);
  assert.match(nego, /fail closed/);
});

// ─── Fixtures: proposal transport + scripted provider + runner harness ───────

/** A transport whose replies are JSON proposals — stands in for the C5/C6
 *  semantic channels to prove the C1 seam end to end. No provider capability
 *  is faked: the seam contract is what is under test. */
class ProposalTransport implements ResultTransport {
  readonly name = 'json-proposal';
  formatInstruction(): string {
    return 'Reply with a single JSON object: {"goal":"..."}';
  }
  extractProduce(raw: string): StepResult {
    return this.extractSingleTurn(raw);
  }
  extractSingleTurn(raw: string): StepResult {
    try {
      return { kind: 'proposal', value: JSON.parse(raw) };
    } catch (err) {
      throw new TransportParseError('invalid JSON proposal', raw, (err as Error).message);
    }
  }
  repairInstruction(): string {
    return 'Reply with a single valid proposal JSON object.';
  }
}

/** Materialized-bytes transport for the rule-4 negotiation test. Emits the
 *  step's DECLARED path (a bytes transport mirrors what the textual fallback
 *  does — sections carry the declared output path). */
class MaterializedTransport implements ResultTransport {
  readonly name = 'materialized';
  formatInstruction(): string { return 'emit bytes'; }
  extractProduce(_raw: string, ctx: TransportContext): StepResult {
    return { kind: 'materialized', artifacts: [{ path: ctx.declaredOutputPath ?? '.sle/work/w/x.md', content: 'bytes' }] };
  }
  extractSingleTurn(_raw: string, ctx: TransportContext): StepResult {
    return { kind: 'materialized', artifacts: [{ path: ctx.declaredOutputPath ?? '.sle/work/w/x.md', content: 'bytes' }] };
  }
  repairInstruction(): string { return 'emit bytes'; }
}

class ScriptedProvider implements ILLMProvider {
  public calls: LLMCompletionParams[] = [];
  constructor(private replies: string[]) {}
  async complete(params: LLMCompletionParams): Promise<LLMCompletionResult> {
    this.calls.push(params);
    const reply = this.replies[Math.min(this.calls.length - 1, this.replies.length - 1)];
    return { content: reply, tokens_used: 10, duration_ms: 1 };
  }
}

class ScriptedContextManager implements ContextManager {
  async assemble(): Promise<AssembledContext> {
    return {
      system_prompt: 'sys',
      artifact_slices: {},
      state_summary: 'state',
      task: 'task',
      token_count: 1,
      truncated: [],
    };
  }
}

class RecordingArtifacts implements ArtifactRepository {
  public saved: Array<{ ref: string; hash: string; path: string }> = [];
  save(record: { ref: string; hash: string; path: string } & Record<string, unknown>): void {
    this.saved.push({ ref: record['ref'] as string, hash: record['hash'] as string, path: record['path'] as string });
  }
  findByWorkflowRunRefAndHash(): unknown {
    return undefined;
  }
}

function makeCtx(overrides: Partial<StepRunContext> = {}): StepRunContext {
  return {
    workflowRunId: 'run-1',
    workflowId: 'define-work',
    stepId: 'test-step',
    iteration: 1,
    revision: 0,
    goal: 'g',
    projectRoot: '/proj',
    role: 'explorer',
    outputArtifact: { type: 'test-artifact', ref: 'test:{objectiveId}', path: '.sle/work/w/test-artifact.md' },
    ...overrides,
  } as StepRunContext;
}

interface Harness {
  runner: AgentRunner;
  provider: ScriptedProvider;
  written: Record<string, string>;
  artifacts: RecordingArtifacts;
  root: string;
}

function makeRunner(
  replies: string[],
  opts: {
    contracts?: Record<string, OutputContract<unknown>>;
    transport?: ResultTransport;
  } = {},
): Harness {
  const root = mkdtempSync(join(tmpdir(), 'd34-c1-'));
  const provider = new ScriptedProvider(replies);
  const written: Record<string, string> = {};
  const fsMock = {
    mkdir: async () => {},
    writeFile: async (p: unknown, c: unknown) => { written[p as string] = c as string; },
    appendFile: async (p: unknown, c: unknown) => { written[p as string] = (written[p as string] ?? '') + (c as string); },
    readFile: async (p: unknown) => {
      if (p in written) return written[p as string];
      throw Object.assign(new Error(`ENOENT: ${String(p)}`), { code: 'ENOENT' });
    },
  } as unknown as typeof import('fs').promises;
  const artifacts = new RecordingArtifacts();
  const runner = new AgentRunner(
    new ScriptedContextManager(),
    provider,
    root,
    { writeNodeOutput: async () => {} } as unknown as RunArtifactManager,
    {
      model: 'test-model',
      ...(opts.contracts ? { outputContracts: opts.contracts } : {}),
      resultTransport: opts.transport ?? new ProposalTransport(),
    },
    fsMock,
    artifacts,
  );
  return { runner, provider, written, artifacts, root };
}

const SIMPLE_CONTRACT: OutputContract<{ goal: string }> = {
  modelSchema: z.object({ goal: z.string() }),
  materialize: (v) => `goal: ${v.goal}\n`,
};

// ─── Runner contract path: happy path, repair, exhaustion ─────────────────────

test('D.34.C1: an accepted proposal is materialized by the system at the declared path, with provenance', async () => {
  const h = makeRunner([JSON.stringify({ goal: 'Ship the widget' })], {
    contracts: { 'test-artifact': SIMPLE_CONTRACT },
  });
  const result = await h.runner.run('explorer', makeCtx());
  assert.equal(result.success, true, result.error);
  // C1 review fix — zero repairs are not externally visible.
  assert.equal('result_repairs' in result, false, 'no result_repairs key when no repair occurred');
  const writtenPath = join(h.root, '.sle/work/w/test-artifact.md');
  assert.equal(h.written[writtenPath], 'goal: Ship the widget\n', 'canonical bytes are SYSTEM-rendered from the proposal');
  assert.equal(h.artifacts.saved.length, 1);
  assert.equal(h.artifacts.saved[0].ref, 'test:{objectiveId}');
});

test('D.34.C1: a decode defect triggers exactly one in-step result repair — no workflow iteration consumed', async () => {
  const h = makeRunner(
    [JSON.stringify({ goal: 42 }), JSON.stringify({ goal: 'Fixed' })],
    { contracts: { 'test-artifact': SIMPLE_CONTRACT } },
  );
  const ctx = makeCtx({ iteration: 2 });
  const result = await h.runner.run('explorer', ctx);
  assert.equal(result.success, true, result.error);
  assert.equal(result.result_repairs, 1);
  assert.equal(result.format_repairs, 0, 'decode defects are RESULT repairs, not format repairs');
  assert.equal(h.provider.calls.length, 2, 'one original call + one repair call');
  // The repair continuation carries the ORIGINAL conversation plus the repair instruction.
  const repairCall = h.provider.calls[1];
  assert.equal(repairCall.messages.length, 4, 'system+user, then assistant reply + repair instruction');
  assert.match(repairCall.messages[3].content, /rejected by the output contract/);
  // ctx.iteration is untouched by result repair — the workflow loop is not involved.
  assert.equal(ctx.iteration, 2);
  assert.equal(h.written[join(h.root, '.sle/work/w/test-artifact.md')], 'goal: Fixed\n');
});

test('D.34.C1: a validate defect feeds structured defect wording into the repair instruction', async () => {
  const withValidate: OutputContract<{ goal: string }> = {
    ...SIMPLE_CONTRACT,
    validate: (v): readonly ContractDefect[] =>
      v.goal.length < 5 ? [{ code: 'GOAL_TOO_SHORT', message: 'goal must be at least 5 characters' }] : [],
  };
  const h = makeRunner(
    [JSON.stringify({ goal: 'hi' }), JSON.stringify({ goal: 'Adequate goal' })],
    { contracts: { 'test-artifact': withValidate } },
  );
  const result = await h.runner.run('explorer', makeCtx());
  assert.equal(result.success, true, result.error);
  assert.equal(result.result_repairs, 1);
  assert.match(h.provider.calls[1].messages[3].content, /GOAL_TOO_SHORT/);
});

test('D.34.C1: result-repair exhaustion fails closed BEFORE write — no artifact bytes, no provenance', async () => {
  const h = makeRunner(
    [JSON.stringify({ goal: 42 }), JSON.stringify({ wrong: 'still bad' })],
    { contracts: { 'test-artifact': SIMPLE_CONTRACT } },
  );
  const result = await h.runner.run('explorer', makeCtx());
  assert.equal(result.success, false);
  assert.match(result.error ?? '', /result repair is exhausted/);
  assert.equal(result.result_repairs, 1);
  assert.equal(result.artifacts_written.length, 0);
  assert.deepEqual(Object.keys(h.written), [], 'no artifact bytes may be written');
  assert.equal(h.artifacts.saved.length, 0, 'no provenance may be recorded');
});

// ─── Fail-closed authoring / negotiation errors ───────────────────────────────

test('D.34.C1 (review fix): a legacy run with an empty registry has exactly the pre-C1 observable shape', async () => {
  const h = makeRunner(['<!-- SLE-OUTPUT\nrole: explorer\nnode: n\nartifacts:\n  - id: x\n    path: .sle/work/w/x.md\n-->\n\n## .sle/work/w/x.md\n\nlegacy bytes'], {
    transport: new MaterializedTransport(),
    // no contracts — the zero-behavior-change configuration
  });
  const result = await h.runner.run('explorer', makeCtx());
  assert.equal(result.success, true, result.error);
  // result_repairs must not exist at all — not even as a zero.
  assert.equal('result_repairs' in result, false, 'legacy runs must not gain a result_repairs key');
  assert.deepEqual(
    Object.keys(result).sort(),
    ['artifacts_written', 'duration_ms', 'format_repairs', 'raw_output_path', 'reviewRoute', 'reviewVerdict', 'success', 'tokens_used'],
    'observable shape is byte-for-byte the pre-C1 legacy shape (reviewVerdict/reviewRoute present as undefined, exactly as before)',
  );
});

test('D.34.C1 (review fix): adversarial artifact type names on an empty registry are UNREGISTERED, never phantom contracts', async () => {
  for (const adversarial of ['toString', 'constructor', '__proto__']) {
    const h = makeRunner(['irrelevant materialized bytes'], {
      transport: new MaterializedTransport(),
      // registry deliberately EMPTY — Object.prototype members must not resolve
    });
    const result = await h.runner.run('explorer', makeCtx({ outputArtifact: { type: adversarial, ref: 'x', path: '.sle/work/w/x.md' } }));
    assert.equal(result.success, true, `${adversarial}: legacy path must run unchanged (error: ${result.error})`);
    assert.equal('result_repairs' in result, false, `${adversarial}: must not enter the contract path`);
    assert.equal(h.artifacts.saved.length, 1, `${adversarial}: legacy write+provenance pipeline intact`);
  }
});

test('D.34.C1 (review fix): an own registry entry is honored even for an Object.prototype member name', async () => {
  const h = makeRunner([JSON.stringify({ goal: 'G' })], {
    contracts: { toString: SIMPLE_CONTRACT },
  });
  const result = await h.runner.run('explorer', makeCtx({ outputArtifact: { type: 'toString', ref: 'x:{o}', path: '.sle/work/w/x.md' } }));
  assert.equal(result.success, true, result.error);
  assert.equal(h.written[join(h.root, '.sle/work/w/x.md')], 'goal: G\n', 'an OWN property is a genuine registration');
});

// ─── Fail-closed authoring / negotiation errors ───────────────────────────────

test('D.34.C1: a proposal with NO registered contract fails closed (no repair attempted)', async () => {
  const h = makeRunner([JSON.stringify({ goal: 'G' })]);
  const result = await h.runner.run('explorer', makeCtx());
  assert.equal(result.success, false);
  assert.match(result.error ?? '', /negotiation error/);
  assert.match(result.error ?? '', /no output contract is registered/);
  assert.equal(h.provider.calls.length, 1, 'fail closed — no repair call');
  assert.deepEqual(Object.keys(h.written), []);
});

test('D.34.C1 (rule 4): contract registered but the transport produced materialized bytes — fail closed', async () => {
  const h = makeRunner(['irrelevant'], {
    contracts: { 'test-artifact': SIMPLE_CONTRACT },
    transport: new MaterializedTransport(),
  });
  const result = await h.runner.run('explorer', makeCtx());
  assert.equal(result.success, false);
  assert.match(result.error ?? '', /negotiation error/);
  assert.match(result.error ?? '', /materialized bytes where an output contract is registered/);
  assert.deepEqual(Object.keys(h.written), []);
});

test('D.34.C1: a review contract without reviewVerdict fails closed BEFORE the LLM call', async () => {
  const h = makeRunner(['never called'], {
    contracts: { 'test-artifact': SIMPLE_CONTRACT },
  });
  const result = await h.runner.run('explorer', makeCtx({ requiresReviewVerdict: true }));
  assert.equal(result.success, false);
  assert.match(result.error ?? '', /provides no reviewVerdict/);
  assert.match(result.error ?? '', /no LLM call/);
  assert.equal(h.provider.calls.length, 0);
});

test('D.34.C1: a fail-route step whose contract lacks deriveRoute fails closed BEFORE the LLM call', async () => {
  const h = makeRunner(['never called'], {
    contracts: {
      // Has reviewVerdict (so the reviewVerdict authoring check passes) but
      // no deriveRoute — the deriveRoute check is the one that must fire.
      'test-artifact': { ...SIMPLE_CONTRACT, reviewVerdict: () => 'fail' as const },
    },
  });
  const result = await h.runner.run('explorer', makeCtx({
    requiresReviewVerdict: true,
    on_fail_routes: { refine: { target_step_id: 'refine' }, human: { target_step_id: 'human' } },
  }));
  assert.equal(result.success, false);
  assert.match(result.error ?? '', /provides no deriveRoute/);
  assert.equal(h.provider.calls.length, 0);
});

// ─── Review contract: verdict + typed route derivation ────────────────────────

test('D.34.C1: review verdict and route come from the typed proposal — never artifact parse-back', async () => {
  const reviewContract: OutputContract<{ goal: string; verdict: 'pass' | 'fail' }> = {
    modelSchema: z.object({ goal: z.string(), verdict: z.enum(['pass', 'fail']) }),
    reviewVerdict: (v) => v.verdict,
    deriveRoute: (v, routes) =>
      v.verdict === 'fail' ? { ok: true, route: routes.includes('refine') ? 'refine' : routes[0] } : { ok: false, error: 'pass carries no route' },
    materialize: (v) => `goal: ${v.goal}\nverdict: ${v.verdict}\n`,
  };
  const h = makeRunner(
    [JSON.stringify({ goal: 'G', verdict: 'fail' })],
    { contracts: { 'test-artifact': reviewContract } },
  );
  const result = await h.runner.run('explorer', makeCtx({
    requiresReviewVerdict: true,
    on_fail_routes: { refine: { target_step_id: 'refine' }, human: { target_step_id: 'human' } },
  }));
  assert.equal(result.success, true, result.error);
  assert.equal(result.reviewVerdict, 'fail');
  assert.equal(result.reviewRoute, 'refine', 'route derived from typed proposal via the contract hook');
  // A semantic-fail review artifact is still written and provenanced, exactly like a pass.
  assert.equal(result.artifacts_written.length, 1);
  assert.equal(h.artifacts.saved.length, 1);
});

// ─── Multi-turn continuation ──────────────────────────────────────────────────

class ScriptedMultiTurnProvider implements IMultiTurnProvider {
  public calls: MultiTurnParams[] = [];
  constructor(private replies: string[]) {}
  async completeMultiTurn(params: MultiTurnParams): Promise<MultiTurnResult> {
    this.calls.push(params);
    const reply = this.replies[Math.min(this.calls.length - 1, this.replies.length - 1)];
    return { stop_reason: 'end_turn', text: reply, tool_uses: [], tokens_used: 10 };
  }
}

function makeLoop(provider: IMultiTurnProvider, opts: Record<string, unknown> = {}): AgentLoop {
  return new AgentLoop(provider, {
    model: 'test',
    projectRoot: mkdtempSync(join(tmpdir(), 'd34-loop-')),
    role: 'explorer',
    workflowRunId: 'r',
    iteration: 1,
    nodeId: 'n',
    runArtifacts: { updateNodeStatus: async () => {}, writeNodeOutput: async () => {} } as unknown as RunArtifactManager,
    ...opts,
  });
}

test('D.34.C1: multi-turn — a rejected proposal continues the SAME conversation with the repair instruction', async () => {
  const provider = new ScriptedMultiTurnProvider([
    JSON.stringify({ goal: 42 }),
    JSON.stringify({ goal: 'Fixed in conversation' }),
  ]);
  const loop = makeLoop(provider, {
    resultTransport: new ProposalTransport(),
    acceptResult: (value: unknown) => {
      const parsed = SIMPLE_CONTRACT.modelSchema.safeParse(value);
      return parsed.success
        ? { ok: true }
        : { ok: false, repairInstruction: 'rejected by contract: goal must be a string' };
    },
  });
  const result = await loop.run('sys', 'produce');
  assert.equal(result.success, true, result.error);
  assert.equal(result.result_repairs, 1);
  assert.equal(result.proposal !== undefined, true, 'proposal returned instead of parsedOutput');
  assert.deepEqual((result.proposal!.value as { goal: string }).goal, 'Fixed in conversation');
  assert.equal(provider.calls.length, 2, 'continuation happened inside the same loop');
  assert.equal(provider.calls[1].messages.length, 3, 'initial user + assistant reply + repair instruction');
  assert.match(String(provider.calls[1].messages[2].content), /rejected by contract/);
  assert.equal(result.turns_taken, 2);
});

test('D.34.C1: multi-turn — repair exhaustion fails closed before returning a proposal', async () => {
  const provider = new ScriptedMultiTurnProvider([
    JSON.stringify({ goal: 42 }),
    JSON.stringify({ wrong: 'still the wrong shape' }),
  ]);
  const loop = makeLoop(provider, {
    declaredArtifactId: 'test-artifact',
    resultTransport: new ProposalTransport(),
    acceptResult: (value: unknown) => {
      const parsed = SIMPLE_CONTRACT.modelSchema.safeParse(value);
      return parsed.success ? { ok: true } : { ok: false, repairInstruction: 'shape rejected' };
    },
  });
  const result = await loop.run('sys', 'produce');
  assert.equal(result.success, false);
  assert.match(result.error ?? '', /result repair is exhausted/);
  assert.match(result.error ?? '', /'test-artifact'/);
  assert.equal(result.result_repairs, 1);
  assert.equal(result.proposal, undefined);
});

test('D.34.C1: multi-turn — a proposal with no acceptor registered fails closed', async () => {
  const provider = new ScriptedMultiTurnProvider([JSON.stringify({ goal: 'G' })]);
  const loop = makeLoop(provider, {
    declaredArtifactId: 'undeclared-type',
    resultTransport: new ProposalTransport(),
  });
  const result = await loop.run('sys', 'produce');
  assert.equal(result.success, false);
  assert.match(result.error ?? '', /no result acceptor is registered/);
});
