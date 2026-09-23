// E23 — synthesis-boundary deterministic tool-result compaction.
//
// Live evidence (A10 attempts 12–13): gated steps reach synthesis cleanly
// (zero repairs) while the provider truncates the synthesis completion
// against REMAINING CONTEXT — the cut point moved DOWN (31,997 → 27,984
// chars) as the requested completion budget moved UP (32,768 → 65,536,
// probe-verified). The loop retains every full read_file payload, so ~18
// investigation turns leave the synthesis request without headroom.
//
// E23 compacts ONLY at the synthesis transition, ONLY old read_file
// payloads, by a frozen newest-first byte budget. Invariants pinned here
// (zero-model):
//   1. no compaction before synthesis (investigation requests carry full
//      payloads; without a budget nothing is ever compacted);
//   2. at the transition, old read_file payloads are replaced per the
//      newest-first budget (largest oldest reads elided first);
//   3. retained reads remain byte-identical;
//   4. assistant tool_use / tool_result id pairing remains structurally
//      valid (blocks are never deleted, only their payload replaced);
//   5. system prompt, initial task, transport teaching, and the E21
//      synthesis instruction are byte-identical and never compacted;
//      list_directory results are never compacted;
//   6. repair/rejection/submission turns are never compacted (unit: only
//      read_file results are eligible);
//   7. compaction evidence is bounded metadata (byte totals, counts,
//      elided path+bytes+sha256) — original bytes recoverable from the
//      pinned repo; the record is persisted in the run's loop metadata;
//   8. without synthesisGate the loop is byte-for-byte legacy (full
//      payloads everywhere, no compaction record);
//   9. E21 threshold stays 18; the full-build gate carries the
//      preregistered 49,152-byte budget on exactly the four artifact steps;
//  10. E22 marker framing is unchanged (still taught; still parsed).
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  AgentLoop,
  SYNTHESIS_PHASE_INSTRUCTION,
  compactReadHistoryForSynthesis,
  type MultiTurnMessage,
  type MultiTurnParams,
  type MultiTurnResult,
  type ToolUseBlock,
  type SynthesisCompactionRecord,
} from '../src/agent-loop.js';
import { RunArtifactManager } from '../src/run-artifacts.js';
import {
  FULL_BUILD,
  SYNTHESIS_GATE_TURNS,
  SYNTHESIS_READ_RESULT_BUDGET_BYTES,
} from '../src/workflow/builtins/full-build.js';
import { TextualSleOutputTransport } from '../src/transport/textual-sle-output.js';

// ─── scripted provider ───────────────────────────────────────────────────────

interface RecordedCall {
  turn: number;
  toolNames: string[];
  system: string;
  messages: MultiTurnMessage[];
  payloadByToolUseId: Map<string, string>; // tool_use_id -> result content (length via ref equality kept simple)
}

class ScriptedInvestigator {
  calls: RecordedCall[] = [];
  private turn = 0;
  constructor(
    private readonly reads: string[], // one tool_use per investigation turn: 'read:<path>' or 'list:<path>'
    private readonly artifact: { path: string; content: string },
  ) {}
  async completeMultiTurn(params: MultiTurnParams): Promise<MultiTurnResult> {
    this.turn++;
    const payloadByToolUseId = new Map<string, string>();
    for (const m of params.messages) {
      if (m.role === 'user' && Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b.type === 'tool_result') payloadByToolUseId.set(b.tool_use_id, b.content);
        }
      }
    }
    this.calls.push({
      turn: this.turn,
      toolNames: params.tools.map((t) => t.name),
      system: params.system,
      messages: structuredClone(params.messages),
      payloadByToolUseId,
    });
    if (this.turn <= this.reads.length) {
      const spec = this.reads[this.turn - 1];
      const [kind, p] = [spec.slice(0, spec.indexOf(':')), spec.slice(spec.indexOf(':') + 1)];
      const tu: ToolUseBlock = {
        id: `tu-${this.turn}`,
        name: kind === 'read' ? 'read_file' : 'list_directory',
        input: { path: p },
      };
      return { stop_reason: 'tool_use', text: '', tool_uses: [tu], tokens_used: 10 };
    }
    return {
      stop_reason: 'end_turn',
      text:
        `<<<SLE-OUTPUT>>>\n<<<SLE-ARTIFACT path="${this.artifact.path}">>>\n` +
        `${this.artifact.content}\n<<<END-SLE-ARTIFACT>>>\n<<<END-SLE-OUTPUT>>>`,
      tool_uses: [],
      tokens_used: 50,
    };
  }
}

// ─── harness ─────────────────────────────────────────────────────────────────

function makeRoot(files: Record<string, string>): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'e23-loop-'));
  for (const [p, content] of Object.entries(files)) {
    const abs = join(root, p);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const CHARTER = { path: 'docs/cycle-charter.md', content: '## Scope\ns\n\n## Purpose\np' };

function makeLoop(
  root: string,
  provider: unknown,
  gate?: { thresholdTurns: number; readResultBudgetBytes?: number },
  role: 'facilitator' | 'builder' = 'facilitator',
): AgentLoop {
  // E24 — builder flavor mirrors the real build step: builder role, NO
  // declared single artifact, open artifact set.
  const builder = role === 'builder';
  return new AgentLoop(provider as never, {
    model: 'e23-model',
    max_tokens: 512,
    projectRoot: root,
    role,
    workflowRunId: 'e23-run',
    iteration: 1,
    nodeId: builder ? 'build' : 'scoping.produce',
    runArtifacts: new RunArtifactManager({ projectRoot: root }),
    listTrackedFiles: async () => ['src/big.ts', 'src/mid.ts', 'src/small.ts', 'src'],
    ...(builder ? {} : { declaredArtifactId: 'cycle_charter', declaredOutputPath: CHARTER.path, expectedArtifacts: 1 }),
    ...(gate ? { synthesisGate: gate } : {}),
  });
}

function readResults(messages: MultiTurnMessage[]): Array<{ id: string; content: string }> {
  const out: Array<{ id: string; content: string }> = [];
  for (const m of messages) {
    if (m.role === 'user' && Array.isArray(m.content)) {
      for (const b of m.content) if (b.type === 'tool_result') out.push({ id: b.tool_use_id, content: b.content });
    }
  }
  return out;
}

function toolUseIds(messages: MultiTurnMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (const b of m.content) {
        const tu = b as Partial<ToolUseBlock>;
        if (typeof tu.id === 'string' && typeof tu.name === 'string') ids.add(tu.id);
      }
    }
  }
  return ids;
}

// ─── shared fixture: 3 reads (30k, 10k, 5k) + 1 listing, threshold 3 ─────────

const BIG = 'B'.repeat(30000);
const MID = 'M'.repeat(10000);
const SMALL = 'S'.repeat(5000);
const READS = ['read:src/big.ts', 'read:src/mid.ts', 'read:src/small.ts', 'list:src'];
const GATE = { thresholdTurns: 4, readResultBudgetBytes: 16384 };

// ─── 1. no compaction before synthesis ───────────────────────────────────────

test('E23.1: investigation requests carry FULL read payloads — no compaction before the gate', async () => {
  const { root, cleanup } = makeRoot({ 'src/big.ts': BIG, 'src/mid.ts': MID, 'src/small.ts': SMALL });
  try {
    const provider = new ScriptedInvestigator(READS, CHARTER);
    const result = await makeLoop(root, provider, GATE).run('SYSTEM', 'produce');
    assert.ok(result.success, result.error);
    // Turns 2..4 (investigation; turn 1 has no results yet): every read
    // result so far is full.
    for (const call of provider.calls.slice(1, GATE.thresholdTurns)) {
      const results = readResults(call.messages);
      assert.ok(results.some((r) => r.content === BIG), `turn ${call.turn}: big payload full`);
      assert.ok(results.every((r) => !r.content.startsWith('[earlier read_file result elided')), `turn ${call.turn}: no elision markers`);
    }
  } finally {
    cleanup();
  }
});

test('E23.1b: a gate WITHOUT a budget never compacts (opt-in by budget, not by gate alone)', async () => {
  const { root, cleanup } = makeRoot({ 'src/big.ts': BIG, 'src/mid.ts': MID, 'src/small.ts': SMALL });
  try {
    const provider = new ScriptedInvestigator(READS, CHARTER);
    const result = await makeLoop(root, provider, { thresholdTurns: READS.length }).run('SYSTEM', 'produce');
    assert.ok(result.success, result.error);
    assert.equal(result.context_compaction, undefined, 'no compaction record without a budget');
    const last = provider.calls.at(-1)!;
    assert.ok(readResults(last.messages).some((r) => r.content === BIG), 'big payload still full at synthesis');
  } finally {
    cleanup();
  }
});

// ─── 2+3. transition compaction: newest-first budget, retained bytes intact ──

test('E23.2/3: at the transition the 30k read is elided newest-first-budget; 10k+5k stay byte-identical', async () => {
  const { root, cleanup } = makeRoot({ 'src/big.ts': BIG, 'src/mid.ts': MID, 'src/small.ts': SMALL });
  try {
    const provider = new ScriptedInvestigator(READS, CHARTER);
    const result = await makeLoop(root, provider, GATE).run('SYSTEM', 'produce');
    assert.ok(result.success, result.error);

    const synth = provider.calls[GATE.thresholdTurns]; // first synthesis request
    const results = readResults(synth.messages);
    assert.equal(results.length, 4, 'all four tool_result blocks still present (payloads replaced, never deleted)');

    const big = results.find((r) => r.id === 'tu-1')!;
    const mid = results.find((r) => r.id === 'tu-2')!;
    const small = results.find((r) => r.id === 'tu-3')!;
    const listing = results.find((r) => r.id === 'tu-4')!;

    assert.ok(big.content.startsWith('[earlier read_file result elided for synthesis context:'), 'oldest largest read elided');
    assert.ok(big.content.includes('path=src/big.ts'), 'marker names the path');
    assert.ok(big.content.includes(`bytes=${BIG.length}`), 'marker names the byte size');
    assert.ok(big.content.includes(`sha256=${createHash('sha256').update(BIG).digest('hex')}`), 'marker pins the original payload hash');
    assert.equal(mid.content, MID, 'retained read byte-identical');
    assert.equal(small.content, SMALL, 'retained read byte-identical');
    assert.ok(!listing.content.startsWith('[earlier'), 'list_directory results are never compacted');

    const rec: SynthesisCompactionRecord = result.context_compaction!;
    assert.equal(rec.phase, 'synthesis');
    assert.equal(rec.policy, 'newest-first');
    assert.equal(rec.budget_bytes, 16384);
    assert.equal(rec.original_read_result_bytes, 45000);
    assert.equal(rec.retained_read_result_bytes, 15000);
    assert.deepEqual([rec.elided_result_count, rec.retained_result_count], [1, 2]);
    assert.deepEqual(rec.elided, [{ path: 'src/big.ts', bytes: 30000, sha256: createHash('sha256').update(BIG).digest('hex') }]);
  } finally {
    cleanup();
  }
});

// ─── 4. structural validity of the tool protocol ─────────────────────────────

test('E23.4: every tool_result still pairs with an assistant tool_use id after compaction', async () => {
  const { root, cleanup } = makeRoot({ 'src/big.ts': BIG, 'src/mid.ts': MID, 'src/small.ts': SMALL });
  try {
    const provider = new ScriptedInvestigator(READS, CHARTER);
    const result = await makeLoop(root, provider, GATE).run('SYSTEM', 'produce');
    assert.ok(result.success, result.error);
    for (const call of provider.calls) {
      const ids = toolUseIds(call.messages);
      for (const r of readResults(call.messages)) {
        assert.ok(ids.has(r.id), `turn ${call.turn}: tool_result ${r.id} has a matching tool_use`);
      }
    }
  } finally {
    cleanup();
  }
});

// ─── 5. never-compacted conversation elements ────────────────────────────────

test('E23.5: system, initial task, E21 instruction byte-identical; instruction appended AFTER compaction, exactly once', async () => {
  const { root, cleanup } = makeRoot({ 'src/big.ts': BIG, 'src/mid.ts': MID, 'src/small.ts': SMALL });
  try {
    const provider = new ScriptedInvestigator(READS, CHARTER);
    const result = await makeLoop(root, provider, GATE).run('SYSTEM PROMPT BYTES', 'produce the charter now');
    assert.ok(result.success, result.error);
    for (const call of provider.calls) assert.equal(call.system, 'SYSTEM PROMPT BYTES');
    const firstTask = provider.calls[0].messages[0].content;
    assert.equal(provider.calls[0].messages[0].role, 'user');
    assert.ok(typeof firstTask === 'string' && firstTask.startsWith('produce the charter now'), 'initial task present');
    for (const call of provider.calls) {
      assert.equal(call.messages[0].content, firstTask, 'initial task (with its transport teaching) byte-identical in every request');
    }
    const synth = provider.calls[GATE.thresholdTurns];
    const instructionTurns = synth.messages.filter(
      (m) => m.role === 'user' && typeof m.content === 'string' && m.content === SYNTHESIS_PHASE_INSTRUCTION,
    );
    assert.equal(instructionTurns.length, 1, 'the E21 instruction appears exactly once, byte-identical');
  } finally {
    cleanup();
  }
});

// ─── 6. only read_file results are eligible (repairs/submissions untouched) ──

test('E23.6: unit — repair strings and non-read_file tool results are never compacted', () => {
  const payload30k = 'X'.repeat(30000);
  const messages: MultiTurnMessage[] = [
    { role: 'user', content: 'task' },
    // A read_file result over any small budget → elided.
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-r', name: 'read_file', input: { path: 'a.ts' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-r', content: payload30k }] },
    // A repair exchange: assistant reply + user repair instruction (strings) — never touched.
    { role: 'assistant', content: 'unparseable reply' },
    { role: 'user', content: 'The previous output was not parseable. Reason: x' },
    // A submit_result tool result (non-repository tool) — never touched.
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-s', name: 'submit_result', input: { body: 'x' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-s', content: '{"ok":true}' }] },
  ];
  const rec = compactReadHistoryForSynthesis(messages, 16384);
  assert.ok(rec);
  assert.equal(rec!.elided_result_count, 1);
  assert.deepEqual(rec!.elided, [{ path: 'a.ts', bytes: 30000, sha256: createHash('sha256').update(payload30k).digest('hex') }]);
  // Repair exchange untouched.
  assert.equal(messages[4].content, 'The previous output was not parseable. Reason: x');
  assert.equal(messages[3].content, 'unparseable reply');
  // submit_result payload untouched.
  const sResult = readResults(messages).find((r) => r.id === 'tu-s')!;
  assert.equal(sResult.content, '{"ok":true}');
});

test('E23.6b: unit — no read_file results at all → no record', () => {
  const messages: MultiTurnMessage[] = [
    { role: 'user', content: 'task' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-l', name: 'list_directory', input: { path: '' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-l', content: '[]' }] },
  ];
  assert.equal(compactReadHistoryForSynthesis(messages, 16384), null);
});

// ─── 7. evidence is persisted ────────────────────────────────────────────────

test('E23.7: the compaction record is persisted in the run loop metadata', async () => {
  const { root, cleanup } = makeRoot({ 'src/big.ts': BIG, 'src/mid.ts': MID, 'src/small.ts': SMALL });
  try {
    const provider = new ScriptedInvestigator(READS, CHARTER);
    const result = await makeLoop(root, provider, GATE).run('SYSTEM', 'produce');
    assert.ok(result.success, result.error);
    const meta = JSON.parse(
      readFileSync(join(root, '.sle', 'runs', 'e23-run', '1', 'node-outputs', 'scoping.produce-loop.json'), 'utf-8'),
    );
    assert.ok(meta.context_compaction, 'context_compaction persisted');
    assert.equal(meta.context_compaction.budget_bytes, 16384);
    assert.equal(meta.context_compaction.original_read_result_bytes, 45000);
    // Bounded metadata only: no payload bytes in the record.
    assert.ok(!JSON.stringify(meta.context_compaction).includes(BIG), 'the record never carries payload bytes');
  } finally {
    cleanup();
  }
});

// ─── 8. legacy parity ────────────────────────────────────────────────────────

test('E23.8: without a gate the loop is byte-for-byte legacy — full payloads everywhere, no record', async () => {
  const { root, cleanup } = makeRoot({ 'src/big.ts': BIG, 'src/mid.ts': MID, 'src/small.ts': SMALL });
  try {
    const provider = new ScriptedInvestigator(READS, CHARTER);
    const result = await makeLoop(root, provider).run('SYSTEM', 'produce');
    assert.ok(result.success, result.error);
    assert.equal(result.context_compaction, undefined);
    for (const call of provider.calls) {
      assert.ok(call.toolNames.includes('read_file'), `turn ${call.turn}: read tools never withdrawn`);
      if (call.turn < 2) continue; // turn 1 carries no tool results yet
      const results = readResults(call.messages);
      assert.ok(results.some((r) => r.content === BIG), `turn ${call.turn}: big payload full`);
    }
  } finally {
    cleanup();
  }
});

// ─── 9+10. E21/E22 constants and scope pinned ────────────────────────────────

test('E23.9: E21 threshold 18; the preregistered 49152-byte budget rides the full-build artifact steps — BUILD included since E24', () => {
  assert.equal(SYNTHESIS_GATE_TURNS, 18);
  assert.equal(SYNTHESIS_READ_RESULT_BUDGET_BYTES, 49152);
  const gated = ['scoping.produce', 'design', 'plan', 'test', 'build'];
  for (const step of FULL_BUILD.steps) {
    if (gated.includes(step.id)) {
      assert.deepEqual(step.synthesisGate, { thresholdTurns: 18, readResultBudgetBytes: 49152 }, `step ${step.id}`);
    } else {
      assert.equal(step.synthesisGate, undefined, `step ${step.id} must stay ungated`);
    }
  }
});

test('E23.10: E22 marker framing unchanged — still taught and still the parsing path', () => {
  const teaching = new TextualSleOutputTransport().formatInstruction({
    role: 'facilitator', requiresReviewVerdict: false, execution: 'multi-turn',
    declaredArtifactId: 'cycle_charter', declaredOutputPath: 'docs/cycle-charter.md', expectedArtifacts: 1,
  });
  assert.ok(teaching.includes('<<<SLE-ARTIFACT path="docs/cycle-charter.md">>>'));
  assert.ok(teaching.includes('the content is opaque'));
});

// ─── E24: BUILD joins the gated set ──────────────────────────────────────────
// Operator preregistration: BUILD runs the same AgentLoop with the same read
// tools; code materializes from the final artifact response; its attempt-14
// failure signature is the one E21/E23 were qualified for. Pins: no single
// outputArtifact assumption; multi-artifact synthesis through the ordinary
// textual channel; compaction never touches code/output artifacts.

class ScriptedBuilder {
  calls: RecordedCall[] = [];
  private turn = 0;
  constructor(
    private readonly reads: string[],
    private readonly sections: Array<{ path: string; content: string }>,
  ) {}
  async completeMultiTurn(params: MultiTurnParams): Promise<MultiTurnResult> {
    this.turn++;
    const payloadByToolUseId = new Map<string, string>();
    for (const m of params.messages) {
      if (m.role === 'user' && Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b.type === 'tool_result') payloadByToolUseId.set(b.tool_use_id, b.content);
        }
      }
    }
    this.calls.push({
      turn: this.turn,
      toolNames: params.tools.map((t) => t.name),
      system: params.system,
      messages: structuredClone(params.messages),
      payloadByToolUseId,
    });
    if (this.turn <= this.reads.length) {
      const spec = this.reads[this.turn - 1];
      const [kind, p] = [spec.slice(0, spec.indexOf(':')), spec.slice(spec.indexOf(':') + 1)];
      const tu: ToolUseBlock = {
        id: `tu-${this.turn}`,
        name: kind === 'read' ? 'read_file' : 'list_directory',
        input: { path: p },
      };
      return { stop_reason: 'tool_use', text: '', tool_uses: [tu], tokens_used: 10 };
    }
    const body = this.sections
      .map((s) => `<<<SLE-ARTIFACT path="${s.path}">>>\n${s.content}\n<<<END-SLE-ARTIFACT>>>`)
      .join('\n');
    return {
      stop_reason: 'end_turn',
      text: `<<<SLE-OUTPUT>>>\n${body}\n<<<END-SLE-OUTPUT>>>`,
      tool_uses: [],
      tokens_used: 50,
    };
  }
}

test('E24.1: BUILD carries the frozen gate but still declares NO outputArtifact — no single-artifact assumption', () => {
  const build = FULL_BUILD.steps.find((s) => s.id === 'build') as
    | { id: string; kind: string; agentRole: string; templateId: string; outputArtifact?: unknown; synthesisGate?: unknown }
    | undefined;
  assert.ok(build, 'build step exists');
  assert.deepEqual(build.synthesisGate, { thresholdTurns: 18, readResultBudgetBytes: 49152 });
  assert.equal(build.outputArtifact, undefined, 'BUILD must keep its open artifact set');
  assert.equal(build.kind, 'produce');
  assert.equal(build.agentRole, 'builder');
  assert.equal(build.templateId, 'build');
});

test('E24.2: gated BUILD-style run — read tools vanish at synthesis, multiple code sections materialize byte-exact, compaction runs but never touches code', async () => {
  const CODE_A = 'def reconcile(event):\n    return {"error": event.get("error_message"), "stage": "consume"}';
  const CODE_B = 'RETRYABLE_CODES = {" throttlingexception", " timeoutexception"}';
  const provider = new ScriptedBuilder(['read:src/heavy.ts', 'list:src'], [
    { path: 'apps/ai-server/rag-worker-service/reconcile.py', content: CODE_A },
    { path: 'apps/ai-server/rag-worker-service/codes.py', content: CODE_B },
  ]);
  const { root, cleanup } = makeRoot({ 'src/heavy.ts': 'H'.repeat(20000) });
  try {
    const loop = makeLoop(root, provider, { thresholdTurns: 2, readResultBudgetBytes: 8192 }, 'builder');
    const res = await loop.run('build the fix for issue #108');
    assert.ok(res.success, 'gated build run ships through the ordinary textual channel');

    // E21 at BUILD: tools withdrawn at the synthesis turn…
    const shipTurn = provider.calls[provider.calls.length - 1];
    assert.deepEqual(shipTurn.toolNames, [], 'synthesis turn offers no read tools');

    // …and the multi-section artifact materializes byte-exact (E22 framing).
    const sections = (res as unknown as { parsedOutput: { sections: Array<{ path: string; content: string }> } }).parsedOutput.sections;
    assert.equal(sections.length, 2, 'multiple code sections materialize');
    assert.equal(sections[0].path, 'apps/ai-server/rag-worker-service/reconcile.py');
    assert.equal(sections[0].content, CODE_A, 'code section A byte-exact — never compacted');
    assert.equal(sections[1].path, 'apps/ai-server/rag-worker-service/codes.py');
    assert.equal(sections[1].content, CODE_B, 'code section B byte-exact — never compacted');

    // E23 at BUILD: compaction ran, only the old read payload was elided,
    // and the evidence record carries no code/output payload bytes.
    const rec = (res as unknown as { context_compaction?: SynthesisCompactionRecord }).context_compaction;
    assert.ok(rec, 'compaction evidence present on the build path');
    assert.deepEqual(rec!.elided.map((e) => e.path), ['src/heavy.ts']);
    assert.ok(!JSON.stringify(rec).includes('reconcile'), 'record carries no code payload');
  } finally {
    cleanup();
  }
});
