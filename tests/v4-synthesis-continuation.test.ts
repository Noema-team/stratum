// V4 — bounded synthesis continuation: one tool-less continuation of a
// truncated FIRST synthesis completion.
//
// Pins the mechanism exactly as scoped for review (pilot-a V4 directive):
//   • eligibility is narrow and mechanical — step declared the policy, the
//     truncated completion is past the E21 synthesis boundary, it carries
//     NON-EMPTY visible text, and the one-continuation budget is unspent;
//   • the continuation is ONE direct provider call with tools: [] — same
//     synthesis state (history + assistant partial + ONE deterministic
//     instruction), no repository tools, no new investigation;
//   • the merged candidate (segment1 + segment2, in order) enters the
//     ORDINARY parse path — same transport, same contract, same repairs;
//   • anything else fails closed: a second max_tokens, a non-terminal
//     state, a tool request, a transport failure, zero visible text;
//   • both segments are preserved VERBATIM as never-overwritten evidence;
//   • absent the flag, behavior is byte-for-byte legacy (immediate fail).
//
// V3 evidence basis (evidence/v3-synthesis-failure-diagnosis.json): 3/3 V3
// runs died at the E21-forced synthesis turn with finish_reason=length;
// two pre-envelope partials (2447 B / 10462 B) and one zero-text.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentLoop, SYNTHESIS_CONTINUATION_INSTRUCTION } from '../src/agent-loop.js';
import { RunArtifactManager } from '../src/run-artifacts.js';
import { AgentRunner, type AgentRunnerConfig } from '../src/agent-runner.js';
import { ContextManager, DEFAULT_CONFIG } from '../src/context-manager.js';
import type { RunArtifactManager as RAM } from '../src/run-artifacts.js';
import type { ArtifactRepository } from '../src/storage/repositories.js';
import type { StepRunContext } from '../src/workflow/types.js';
import type { MultiTurnParams, MultiTurnResult } from '../src/agent-loop.js';

const REQUIREMENTS = '# Requirements\n\nThe worker failure payload must carry error_message and stage.\n';
const ARCHITECTURE = '# Architecture\n\nprocess_document composes the payload; no rag-api changes.\n';

function envelope(sections: Array<{ path: string; content: string }>): string {
  const body = sections
    .map((s) => `<<<SLE-ARTIFACT path="${s.path}">>>\n${s.content.trimEnd()}\n<<<END-SLE-ARTIFACT>>>`)
    .join('\n');
  return `<<<SLE-OUTPUT>>>\n${body}\n<<<END-SLE-OUTPUT>>>\n`;
}

// A complete envelope split at an arbitrary point: the truncated synthesis
// produced the first half, the continuation supplies the rest — the merge
// is byte-exact by construction.
const FULL = envelope([
  { path: 'docs/requirements.md', content: REQUIREMENTS },
  { path: 'docs/architecture.md', content: ARCHITECTURE },
]);
const SEG1 = FULL.slice(0, Math.floor(FULL.length / 2));
const SEG2 = FULL.slice(Math.floor(FULL.length / 2));

interface CallRecord {
  tools: Array<{ name: string }>;
  messageCount: number;
  lastUserContent: string;
  penultimateRole: string;
  penultimateContent: string;
}

class SynthProvider {
  calls: CallRecord[] = [];
  /** per-call injected tool_uses (call index → blocks); default none */
  injectToolUses: Array<unknown[] | null> = [];
  constructor(
    private plan: Array<{ stop?: string; text: string; throw?: Error }>,
  ) {}
  async completeMultiTurn(params: MultiTurnParams): Promise<MultiTurnResult> {
    const i = this.calls.length;
    const msgs = params.messages;
    this.calls.push({
      tools: (params.tools ?? []).map((t) => ({ name: (t as { name: string }).name })),
      messageCount: msgs.length,
      lastUserContent: typeof msgs[msgs.length - 1].content === 'string' ? (msgs[msgs.length - 1].content as string) : JSON.stringify(msgs[msgs.length - 1].content),
      penultimateRole: msgs.length >= 2 ? msgs[msgs.length - 2].role : '',
      penultimateContent: msgs.length >= 2 && typeof msgs[msgs.length - 2].content === 'string' ? (msgs[msgs.length - 2].content as string) : '',
    });
    const step = this.plan[Math.min(i, this.plan.length - 1)];
    if (step.throw) throw step.throw;
    return { stop_reason: step.stop ?? 'end_turn', text: step.text, tool_uses: (this.injectToolUses[i] ?? []) as never, tokens_used: 10 };
  }
}

function makeLoop(
  root: string,
  provider: SynthProvider,
  opts: { thresholdTurns: number; synthesisContinuation?: boolean },
): AgentLoop {
  return new AgentLoop(provider as never, {
    model: 'v4-model',
    max_tokens: 512,
    projectRoot: root,
    role: 'designer',
    workflowRunId: 'v4-run',
    iteration: 1,
    nodeId: 'design',
    runArtifacts: new RunArtifactManager({ projectRoot: root }),
    listTrackedFiles: async () => [],
    synthesisGate: { thresholdTurns: opts.thresholdTurns },
    ...(opts.synthesisContinuation ? { synthesisContinuation: true } : {}),
  });
}

// ─── 1. the happy path: one continuation, merged text parses, stage succeeds ──

test('V4.1: truncated synthesis + ONE tool-less continuation → merged text parses normally', async () => {
  const root = mkdtempSync(join(tmpdir(), 'v4-'));
  // threshold 0 → turn 1 IS a synthesis turn (announcement + no tools)
  const provider = new SynthProvider([
    { stop: 'max_tokens', text: SEG1 },
    { text: SEG2 },
  ]);
  try {
    const result = await makeLoop(root, provider, { thresholdTurns: 0, synthesisContinuation: true }).run('system', 'produce');
    assert.ok(result.success, `expected success, got: ${result.error}`);
    assert.equal(provider.calls.length, 2, 'exactly one continuation invocation');

    // The continuation call: NO tools at all, same synthesis state —
    // history + the truncated partial as the assistant turn + ONE
    // deterministic instruction.
    const cont = provider.calls[1];
    assert.equal(cont.tools.length, 0, 'continuation is tool-less by construction');
    // history (task + synthesis announcement) + assistant partial + instruction
    assert.equal(cont.messageCount, 4);
    assert.equal(cont.penultimateRole, 'assistant');
    assert.equal(cont.penultimateContent, SEG1, 'segment 1 is preserved as the assistant turn verbatim');
    assert.equal(cont.lastUserContent, SYNTHESIS_CONTINUATION_INSTRUCTION);

    // Truthful accounting: both completions counted.
    assert.equal(result.turns_taken, 2, 'the continuation is a real provider invocation');
    assert.equal(result.tokens_used, 20, 'tokens from BOTH completions');

    // Segments preserved verbatim on the result.
    assert.deepEqual(result.synthesis_continuation, {
      segment1: SEG1,
      segment2: SEG2,
      continuation_stop_reason: 'end_turn',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── 2. second max_tokens → fail closed, one continuation max ────────────────

test('V4.2: a second max_tokens on the continuation fails closed; segments preserved; no third call', async () => {
  const root = mkdtempSync(join(tmpdir(), 'v4-'));
  const provider = new SynthProvider([
    { stop: 'max_tokens', text: SEG1 },
    { stop: 'max_tokens', text: 'more and more' },
    { text: 'NEVER REACHED' },
  ]);
  try {
    const result = await makeLoop(root, provider, { thresholdTurns: 0, synthesisContinuation: true }).run('system', 'produce');
    assert.equal(result.success, false);
    assert.match(result.error!, /synthesis continuation did not terminate normally: max_tokens/);
    assert.equal(provider.calls.length, 2, 'ONE continuation maximum');
    assert.deepEqual(result.synthesis_continuation, {
      segment1: SEG1,
      segment2: 'more and more',
      continuation_stop_reason: 'max_tokens',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── 3. non-terminal states and tool requests fail closed ────────────────────

test('V4.3: a continuation that requests tools (tool_use) fails closed — nothing executes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'v4-'));
  const provider = new SynthProvider([
    { stop: 'max_tokens', text: SEG1 },
    { stop: 'tool_use', text: '' },
  ]);
  try {
    const result = await makeLoop(root, provider, { thresholdTurns: 0, synthesisContinuation: true }).run('system', 'produce');
    assert.equal(result.success, false);
    assert.match(result.error!, /synthesis continuation did not terminate normally: tool_use/);
    assert.equal(provider.calls[1].tools.length, 0, 'no tools were offered to smuggle investigation in');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('V4.4: a continuation transport failure is ordinary transport classification, evidence carries the cause', async () => {
  const root = mkdtempSync(join(tmpdir(), 'v4-'));
  const provider = new SynthProvider([
    { stop: 'max_tokens', text: SEG1 },
    { text: '', throw: new Error('socket cut mid-continuation') },
  ]);
  try {
    const result = await makeLoop(root, provider, { thresholdTurns: 0, synthesisContinuation: true }).run('system', 'produce');
    assert.equal(result.success, false);
    assert.match(result.error!, /LLM call failed during synthesis continuation: socket cut mid-continuation/);
    assert.match(result.failure_observation!.transport_failure!.error_name, /Error/);
    assert.equal(result.synthesis_continuation!.segment1, SEG1);
    assert.equal(result.synthesis_continuation!.segment2, '');
    assert.match(result.synthesis_continuation!.error!, /transport failure/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── 4. eligibility boundaries: zero text, investigation phase, no flag ──────

test('V4.5: a ZERO-TEXT synthesis truncation is never continued (the V3-1 plan signature fails as before)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'v4-'));
  const provider = new SynthProvider([
    { stop: 'max_tokens', text: '' },
    { text: 'NEVER REACHED' },
  ]);
  try {
    const result = await makeLoop(root, provider, { thresholdTurns: 0, synthesisContinuation: true }).run('system', 'produce');
    assert.equal(result.success, false);
    assert.match(result.error!, /Agent exhausted max_tokens without producing a result block/);
    assert.equal(provider.calls.length, 1, 'nothing meaningful to continue — no continuation call');
    assert.equal(result.synthesis_continuation, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('V4.6: a max_tokens truncation during the INVESTIGATION phase (at/before the boundary) is never continued', async () => {
  const root = mkdtempSync(join(tmpdir(), 'v4-'));
  const provider = new SynthProvider([
    { stop: 'max_tokens', text: 'partial investigation prose' },
    { text: 'NEVER REACHED' },
  ]);
  try {
    // threshold 2: turn 1 is still an investigation turn.
    const result = await makeLoop(root, provider, { thresholdTurns: 2, synthesisContinuation: true }).run('system', 'produce');
    assert.equal(result.success, false);
    assert.match(result.error!, /Agent exhausted max_tokens without producing a result block/);
    assert.equal(provider.calls.length, 1, 'the continuation exists only past the E21 boundary');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('V4.7: without the step-declared flag, behavior is byte-for-byte legacy', async () => {
  const root = mkdtempSync(join(tmpdir(), 'v4-'));
  const provider = new SynthProvider([
    { stop: 'max_tokens', text: SEG1 },
    { text: 'NEVER REACHED' },
  ]);
  try {
    const result = await makeLoop(root, provider, { thresholdTurns: 0 }).run('system', 'produce');
    assert.equal(result.success, false);
    assert.match(result.error!, /Agent exhausted max_tokens without producing a result block/);
    assert.equal(provider.calls.length, 1);
    assert.equal(result.synthesis_continuation, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── 5. the merged candidate goes through the ORDINARY parse path ────────────

test('V4.8: a merged candidate that is still unparseable fails via the ordinary format-repair path (no special-casing)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'v4-'));
  const provider = new SynthProvider([
    { stop: 'max_tokens', text: 'plain prose, no envelope at all' },
    { text: 'more prose, still no envelope' },
    { text: 'still no envelope' },
    { text: 'and again' },
  ]);
  try {
    const result = await makeLoop(root, provider, { thresholdTurns: 0, synthesisContinuation: true }).run('system', 'produce');
    assert.equal(result.success, false, 'an envelope-less merge is unparseable → format repairs → exhausted → fail');
    assert.ok((result.format_repairs ?? 0) >= 1, 'the merged text entered the ordinary parse/repair path');
    assert.match(result.error!, /format repair|envelope|pars/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── 6. runner-level: flag plumbing + verbatim evidence persistence ──────────

class RunnerSynthProvider {
  calls: Array<{ tools: unknown[] }> = [];
  async completeMultiTurn(params: MultiTurnParams): Promise<MultiTurnResult> {
    const i = this.calls.length;
    this.calls.push({ tools: params.tools ?? [] });
    if (i === 0) return { stop_reason: 'max_tokens', text: SEG1, tool_uses: [], tokens_used: 10 };
    return { stop_reason: 'end_turn', text: SEG2, tool_uses: [], tokens_used: 10 };
  }
}

function makeRunner(root: string, provider: unknown): AgentRunner {
  const cm = new ContextManager(root, DEFAULT_CONFIG);
  return new AgentRunner(
    cm,
    provider as never,
    root,
    { updateNodeStatus: async () => {}, writeNodeOutput: async () => {} } as unknown as RAM,
    { model: 'test' } satisfies Partial<AgentRunnerConfig> as AgentRunnerConfig,
    undefined,
    undefined as unknown as ArtifactRepository,
  );
}

function ctx(root: string, overrides: Partial<Record<string, unknown>> = {}): StepRunContext {
  return {
    workflowRunId: 'v4-run',
    workflowId: 'full-build',
    stepId: 'design',
    iteration: 1,
    revision: 0,
    goal: 'v4 bounded synthesis continuation probe',
    projectRoot: root,
    instruction: 'Produce your artifacts.',
    authorizedOutputs: ['docs/requirements.md', 'docs/architecture.md'],
    synthesisGate: { thresholdTurns: 0 },
    synthesisContinuation: true,
    ...overrides,
  } as never;
}

test('V4.9: runner adopts the continued output and persists both segments verbatim (never overwritten)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'v4-'));
  const provider = new RunnerSynthProvider();
  try {
    const result = await makeRunner(root, provider).run('designer', ctx(root));
    assert.ok(result.success, result.error);
    assert.deepEqual([...result.artifacts_written].sort(), ['docs/architecture.md', 'docs/requirements.md']);

    const evidencePath = join(root, '.sle', 'runs', 'v4-run', '1', 'node-outputs', 'design.synthesis-continuation.json');
    assert.ok(existsSync(evidencePath), 'continuation evidence persisted beside the node outputs');
    const ev = JSON.parse(readFileSync(evidencePath, 'utf-8'));
    assert.equal(ev.node_id, 'design');
    assert.equal(ev.segment1, SEG1, 'segment 1 verbatim');
    assert.equal(ev.segment2, SEG2, 'segment 2 verbatim');
    assert.equal(ev.continuation_stop_reason, 'end_turn');
    assert.equal(ev.segment1_bytes, Buffer.byteLength(SEG1, 'utf8'));
    assert.equal(ev.segment2_bytes, Buffer.byteLength(SEG2, 'utf8'));
    assert.equal(provider.calls[1].tools.length, 0, 'the continuation the runner executed was tool-less');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('V4.11: adversarial — max_tokens on a LATER synthesis turn (after an ordinary format repair) is never continued', async () => {
  const root = mkdtempSync(join(tmpdir(), 'v4-'));
  const provider = new SynthProvider([
    { stop: 'end_turn', text: 'first synthesis attempt, unparseable prose' },
    { stop: 'max_tokens', text: 'partial text on the SECOND synthesis turn' },
    { text: 'NEVER REACHED' },
  ]);
  try {
    const result = await makeLoop(root, provider, { thresholdTurns: 0, synthesisContinuation: true }).run('system', 'produce');
    assert.equal(result.success, false);
    assert.match(result.error!, /Agent exhausted max_tokens without producing a result block/, 'the legacy failure fires — the continuation belongs to the FIRST synthesis completion only');
    assert.equal(provider.calls.length, 2, 'one ordinary format repair consumed the second slot; NO continuation call');
    assert.equal(result.synthesis_continuation, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('V4.12: adversarial — a tool request beside a VALID continuation segment is rejected independently of stop_reason', async () => {
  const root = mkdtempSync(join(tmpdir(), 'v4-'));
  // Same plan as V4.1's success, but the continuation smuggles a read_file
  // request BESIDE the perfectly valid segment 2. The seam must enforce its
  // own tool-less invariant, not trust the correlated stop_reason.
  const provider = new SynthProvider([
    { stop: 'max_tokens', text: SEG1 },
    { text: SEG2 },
  ]);
  provider.injectToolUses = [null, [{ type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'src/index.ts' } }]];
  try {
    const result = await makeLoop(root, provider, { thresholdTurns: 0, synthesisContinuation: true }).run('system', 'produce');
    assert.equal(result.success, false);
    assert.match(result.error!, /synthesis continuation attempted tool use while continuation is tool-less \(1 request\(s\)\)/);
    assert.equal(provider.calls.length, 2, 'exactly one continuation — rejected before any adoption');
    assert.equal(result.failure_observation!.stop_reason, 'end_turn', 'failure_observation describes the continuation turn itself');
    // Counterfactual: the IDENTICAL bytes with tool_uses=[] are the V4.1
    // adopted-repair success — so the rejection is attributable to the tool
    // request alone.
    const clean = new SynthProvider([
      { stop: 'max_tokens', text: SEG1 },
      { text: SEG2 },
    ]);
    const root2 = mkdtempSync(join(tmpdir(), 'v4-'));
    try {
      const ok = await makeLoop(root2, clean, { thresholdTurns: 0, synthesisContinuation: true }).run('system', 'produce');
      assert.ok(ok.success, 'identical bytes without the tool request pass (V4.1)');
    } finally {
      rmSync(root2, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('V4.10: workflow declares synthesisContinuation on the gated producer steps only', async () => {
  const { FULL_BUILD } = await import('../src/workflow/builtins/full-build.js');
  const byId = Object.fromEntries(FULL_BUILD.steps.map((s) => [s.id, s as unknown as Record<string, unknown>]));
  for (const id of ['scoping.produce', 'design', 'plan', 'test', 'build']) {
    assert.equal(byId[id].synthesisContinuation, true, `${id} declares the continuation policy`);
    assert.ok(byId[id].synthesisGate, `${id} is gate-bound (the boundary exists; BUILD's gate is the E24-qualified pair)`);
  }
  for (const id of ['scoping.gather', 'scoping.checkpoint', 'confirm', 'critique']) {
    assert.notEqual(byId[id].synthesisContinuation, true, `${id} must not declare the policy`);
  }
});
