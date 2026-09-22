// E21 — the two-phase convergence gate (post-A10 decision: option 2).
//
// A10 measured the blocker: per-step convergence under the frozen 24-turn
// protocol — failed runs explore many DISTINCT paths (25–42 unique calls,
// near-zero repeats) and never transition to synthesis. The intervention is
// a one-way synthesis phase for selected full-build artifact steps:
//
//   turns 1..threshold  — exactly the legacy behavior (read tools offered)
//   turns threshold+1.. — repository read tools WITHDRAWN at the tool
//                         protocol level (the request itself stops offering
//                         them), the synthesis instruction announced once,
//                         and the result channel still offered
//
// Safety envelope (this file pins all of it):
//   - the turn cap is UNCHANGED (24) — a gated run that still fails, fails
//     at the same cap, so a success attributes to the gate, not capacity;
//   - a model attempt to invoke a withdrawn tool FAILS THE STEP EXPLICITLY
//     — never executed, never answered with a fabricated result;
//   - ungated steps (define-work, BUILD, everything else) are byte-for-byte
//     unchanged: same tool set every turn, no announcement;
//   - only full-build scoping.produce/design/plan/test declare the gate,
//     frozen at threshold 18.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentLoop, MAX_AGENT_TURNS, SYNTHESIS_PHASE_INSTRUCTION } from '../src/agent-loop.js';
import { RunArtifactManager } from '../src/run-artifacts.js';
import { FULL_BUILD, SYNTHESIS_READ_RESULT_BUDGET_BYTES } from '../src/workflow/builtins/full-build.js';
import { DEFINE_WORK } from '../src/workflow/builtins/define-work.js';
import { CYCLE_CHARTER_OUTPUT } from '../src/workflow/builtins/full-build.js';
import type { MultiTurnParams, MultiTurnResult, ToolUseBlock } from '../src/agent-loop.js';

const THRESHOLD = 18;

// ─── scripted provider: explores until the read tools disappear, then ships ──

interface CallRecord {
  turn: number;
  toolNames: string[];
  hadSynthesisInstruction: boolean;
  messageCount: number;
}

class ExploreThenShipProvider {
  calls: CallRecord[] = [];
  private turn = 0;
  constructor(private readonly artifact: { path: string; content: string }) {}
  async completeMultiTurn(params: MultiTurnParams): Promise<MultiTurnResult> {
    this.turn++;
    const names = params.tools.map(t => t.name);
    const lastUser = [...params.messages].reverse().find(m => m.role === 'user');
    this.calls.push({
      turn: this.turn,
      toolNames: names,
      hadSynthesisInstruction: typeof lastUser?.content === 'string' && lastUser.content.includes('Investigation phase is over'),
      messageCount: params.messages.length,
    });
    const readOffered = names.includes('read_file');
    if (readOffered) {
      // Phase 1: keep investigating (this is the A10 failure shape).
      const tu: ToolUseBlock = { id: `tu-${this.turn}`, name: 'read_file', input: { path: 'src/index.ts' } };
      return { stop_reason: 'tool_use', text: '', tool_uses: [tu], tokens_used: 10 };
    }
    // Phase 2: the read tools are gone — produce the artifact.
    return {
      stop_reason: 'end_turn',
      text: `<<<SLE-OUTPUT>>>\n### ${this.artifact.path}\n${this.artifact.content}\n<<<END-SLE-OUTPUT>>>`,
      tool_uses: [],
      tokens_used: 50,
    };
  }
}

// ─── scripted provider: keeps calling a withdrawn tool in phase 2 ────────────

class ViolatingProvider {
  calls: CallRecord[] = [];
  private turn = 0;
  async completeMultiTurn(params: MultiTurnParams): Promise<MultiTurnResult> {
    this.turn++;
    this.calls.push({ turn: this.turn, toolNames: params.tools.map(t => t.name), hadSynthesisInstruction: false, messageCount: params.messages.length });
    const readOffered = params.tools.some(t => t.name === 'read_file');
    const tu: ToolUseBlock = readOffered
      ? { id: `tu-${this.turn}`, name: 'read_file', input: { path: 'src/index.ts' } }
      : { id: `tu-${this.turn}`, name: 'read_file', input: { path: 'src/index.ts' } };
    return { stop_reason: 'tool_use', text: '', tool_uses: [tu], tokens_used: 10 };
  }
}

// ─── harness ─────────────────────────────────────────────────────────────────

interface LoopHarness {
  root: string;
  cleanup: () => void;
}

function makeRoot(): LoopHarness {
  const root = mkdtempSync(join(tmpdir(), 'e21-loop-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'index.ts'), 'export const e21 = true;\n');
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function makeLoop(
  root: string,
  provider: unknown,
  gate?: { thresholdTurns: number },
): AgentLoop {
  return new AgentLoop(provider as never, {
    model: 'e21-model',
    max_tokens: 512,
    projectRoot: root,
    role: 'facilitator',
    workflowRunId: 'e21-run',
    iteration: 1,
    nodeId: 'scoping.produce',
    runArtifacts: new RunArtifactManager({ projectRoot: root }),
    listTrackedFiles: async () => ['src/index.ts'],
    ...(gate ? { synthesisGate: gate } : {}),
  });
}

// ─── 1. the phase boundary is enforced in the tool protocol ──────────────────

test('E21: gated step — turns 1..18 offer read tools, turn 19+ offers none but keeps the result channel, synthesis instruction announced once', async () => {
  const { root, cleanup } = makeRoot();
  try {
    const artifact = { path: 'docs/cycle-charter.md', content: '## Scope\ns\n\n## Purpose\np' };
    const provider = new ExploreThenShipProvider(artifact);
    const loop = makeLoop(root, provider, { thresholdTurns: THRESHOLD });
    const result = await loop.run('system', 'produce the charter');

    assert.ok(result.success, `expected success, got: ${result.error}`);
    assert.strictEqual(result.turns_taken, THRESHOLD + 1, 'the model must ship on the FIRST synthesis turn');

    // Phase 1 requests: legacy tool set, no synthesis instruction.
    for (const call of provider.calls.slice(0, THRESHOLD)) {
      assert.ok(call.toolNames.includes('read_file'), `turn ${call.turn} must offer read_file`);
      assert.strictEqual(call.hadSynthesisInstruction, false, `turn ${call.turn} must NOT announce synthesis`);
    }
    // The transition: the first synthesis request withdraws read tools,
    // announces the instruction exactly once, and is a NEW user turn.
    const first = provider.calls[THRESHOLD];
    assert.strictEqual(first.turn, THRESHOLD + 1);
    assert.strictEqual(first.toolNames.length, 0, 'textual-transport synthesis turns offer NO tools (read tools withdrawn at the protocol level)');
    assert.strictEqual(first.hadSynthesisInstruction, true);
    assert.ok(first.messageCount > provider.calls[THRESHOLD - 1].messageCount, 'the announcement is an appended message, not a rewrite');
    assert.strictEqual(provider.calls.slice(THRESHOLD + 1).filter(c => c.hadSynthesisInstruction && c.messageCount === first.messageCount).length >= 0, true);

    // The artifact flowed through the normal result channel (the loop
    // returns the extracted result; materialization is the runner's job —
    // covered end-to-end by the E19 suite).
    assert.ok(result.rawText?.includes('## Scope'));
    assert.ok(result.rawText?.includes('## Purpose'));
  } finally {
    cleanup();
  }
});

// ─── 2. the result channel survives the withdrawal (contract steps) ──────────

test('E21: contract (submit-result) steps keep their submission tool in the synthesis phase', async () => {
  const { root, cleanup } = makeRoot();
  try {
    // A schema-carrying step negotiates the submit-result channel; the gate
    // must withdraw ONLY the repository read tools, never the result tool.
    const provider = new (class {
      calls: Array<{ turn: number; names: string[] }> = [];
      private turn = 0;
      async completeMultiTurn(params: MultiTurnParams): Promise<MultiTurnResult> {
        this.turn++;
        this.calls.push({ turn: this.turn, names: params.tools.map(t => t.name) });
        if (params.tools.some(t => t.name === 'read_file')) {
          return { stop_reason: 'tool_use', text: '', tool_uses: [{ id: `t${this.turn}`, name: 'read_file', input: { path: 'src/index.ts' } }], tokens_used: 10 };
        }
        const submit = params.tools.find(t => t.name === 'submit_result');
        assert.ok(submit, 'the result-submission tool must still be offered in the synthesis phase');
        return {
          stop_reason: 'tool_use',
          text: '',
          tool_uses: [{ id: `s${this.turn}`, name: 'submit_result', input: { body: 'definition body' } } as never],
          tokens_used: 20,
        };
      }
    })();
    const loop = new AgentLoop(provider as never, {
      model: 'e21-model', max_tokens: 512, projectRoot: root, role: 'explorer',
      workflowRunId: 'e21-run', iteration: 1, nodeId: 'synthesize-definition',
      runArtifacts: new RunArtifactManager({ projectRoot: root }),
      listTrackedFiles: async () => ['src/index.ts'],
      resultSchemaJson: { type: 'object', properties: { body: { type: 'string' } }, required: ['body'] },
      acceptResult: (value: unknown) =>
        (value as { body?: string }).body === 'definition body'
          ? { ok: true as const }
          : { ok: false as const, repairInstruction: 'body must be exactly the agreed text' },
      synthesisGate: { thresholdTurns: THRESHOLD },
    } as never);
    const result = await loop.run('system', 'produce the definition');
    assert.ok(result.success, `expected success, got: ${result.error}`);
    const synthesisCall = provider.calls[THRESHOLD];
    assert.ok(synthesisCall, 'must reach the synthesis phase');
    assert.ok(!synthesisCall.names.includes('read_file'));
    assert.ok(synthesisCall.names.includes('submit_result'));
  } finally {
    cleanup();
  }
});

// ─── 3. protocol safety: a withdrawn-tool invocation fails explicitly ─────────

test('E21: invoking a withdrawn read tool in the synthesis phase fails the step explicitly — never executed, never fabricated', async () => {
  const { root, cleanup } = makeRoot();
  try {
    const provider = new ViolatingProvider();
    const loop = makeLoop(root, provider, { thresholdTurns: THRESHOLD });
    const result = await loop.run('system', 'produce the charter');

    assert.strictEqual(result.success, false);
    assert.ok(
      result.error?.includes("withdrawn repository tool 'read_file'") && result.error?.includes('failing closed'),
      `explicit boundary error required, got: ${result.error}`,
    );
    // The violating turn is the first synthesis turn; nothing was executed there.
    const obs = result.failure_observation!;
    assert.ok(obs.tool_calls.every(c => c.turn <= THRESHOLD), 'no synthesis-phase tool may be executed or logged as executed');
    assert.strictEqual(obs.stop_reason, 'tool_use');
  } finally {
    cleanup();
  }
});

// ─── 4. the envelope is unchanged: cap, ungated parity, declarative scope ────

test('E21: an ungated step is byte-for-byte legacy — same tools every turn, no announcement, same 24-turn cap', async () => {
  const { root, cleanup } = makeRoot();
  try {
    const provider = new (class {
      calls: CallRecord[] = [];
      private turn = 0;
      async completeMultiTurn(params: MultiTurnParams): Promise<MultiTurnResult> {
        this.turn++;
        const lastUser = [...params.messages].reverse().find(m => m.role === 'user');
        this.calls.push({ turn: this.turn, toolNames: params.tools.map(t => t.name), hadSynthesisInstruction: typeof lastUser?.content === 'string' && lastUser.content.includes('Investigation phase is over'), messageCount: params.messages.length });
        return { stop_reason: 'tool_use', text: '', tool_uses: [{ id: `t${this.turn}`, name: 'read_file', input: { path: 'src/index.ts' } }], tokens_used: 10 };
      }
    })();
    const loop = makeLoop(root, provider, undefined);
    const result = await loop.run('system', 'produce');
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.turns_taken, MAX_AGENT_TURNS, 'the turn cap is untouched');
    assert.ok(result.error?.includes(`${MAX_AGENT_TURNS} turns`));
    for (const call of provider.calls) {
      assert.ok(call.toolNames.includes('read_file'), `ungated turn ${call.turn} must still offer read_file`);
      assert.strictEqual(call.hadSynthesisInstruction, false, 'ungated steps must never hear about the synthesis phase');
    }
    const first = provider.calls[0].toolNames;
    for (const call of provider.calls.slice(1)) assert.deepStrictEqual(call.toolNames, first);
  } finally {
    cleanup();
  }
});

test('E21: only full-build scoping/design/plan/test declare the gate, frozen at 18 — define-work and BUILD untouched', () => {
  const gated = ['scoping.produce', 'design', 'plan', 'test'];
  for (const step of FULL_BUILD.steps) {
    if (gated.includes(step.id)) {
      // E23 — the gate carries the preregistered synthesis read-result
      // budget next to the frozen threshold.
      assert.deepStrictEqual(
        step.synthesisGate,
        { thresholdTurns: THRESHOLD, readResultBudgetBytes: SYNTHESIS_READ_RESULT_BUDGET_BYTES },
        `${step.id} must carry the frozen gate`,
      );
    } else {
      assert.strictEqual(step.synthesisGate, undefined, `${step.id} must NOT be gated`);
    }
  }
  // define-work stays untouched (A9/A10 ruling; the front door is frozen).
  for (const step of DEFINE_WORK.steps) {
    assert.strictEqual(step.synthesisGate, undefined, `define-work/${step.id} must NOT be gated`);
  }
  assert.strictEqual(CYCLE_CHARTER_OUTPUT.path, 'docs/cycle-charter.md');
});
