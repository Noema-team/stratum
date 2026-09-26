// V3 — bounded structural repair: one validator-driven repair turn.
//
// Pins the preregistered semantics (pilot-a evidence/v3-preregistration.json):
//   • a producer-contract shortfall on an otherwise completed stage output
//     grants EXACTLY ONE repair turn, only when the workflow declared
//     structuralRepair;
//   • the SAME validator reruns on the repair output and its verdict is
//     final (pass → stage continues; fail → stage failure, evidence kept);
//   • the repair instruction is GENERIC + validator-derived (exact error,
//     declared contract, submitted output) and never hardcodes requirements;
//   • the full evidence trail (original output, findings, instruction,
//     repair output, second validation) is persisted and never overwritten;
//   • absent the flag, behavior is byte-for-byte legacy (immediate fail,
//     single invocation).

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentRunner, type AgentRunnerConfig } from '../src/agent-runner.js';
import {
  buildStructuralRepairInstruction,
  persistStructuralRepairEvidence,
} from '../src/bounded-structural-repair.js';
import { ScopingService } from '../src/scoping-service.js';
import { ContextManager, DEFAULT_CONFIG } from '../src/context-manager.js';
import type { RunArtifactManager } from '../src/run-artifacts.js';
import type { ArtifactRepository } from '../src/storage/repositories.js';
import type { StepRunContext } from '../src/workflow/types.js';

const REQUIREMENTS = '# Requirements\n\nThe worker failure payload must carry error_message and stage.\n';
const ARCHITECTURE = '# Architecture\n\nprocess_document composes the payload; no rag-api changes.\n';
const PURPOSE = '## Purpose\n\nMake RAG failures diagnosable.\n';

function envelope(sections: Array<{ path: string; content: string }>): string {
  const body = sections
    .map((s) => `<<<SLE-ARTIFACT path="${s.path}">>>\n${s.content.trimEnd()}\n<<<END-SLE-ARTIFACT>>>`)
    .join('\n');
  return `<<<SLE-OUTPUT>>>\n${body}\n<<<END-SLE-OUTPUT>>>\n`;
}

class ScriptedProvider {
  calls = 0;
  instructions: string[] = [];
  toolsOffered: Array<unknown[]> = [];
  repairToolUses: unknown[][] = [];
  constructor(private scripts: Array<string | Error>) {}
  async complete() {
    throw new Error('v3: single-turn path not expected');
  }
  async completeMultiTurn(params: {
    messages: Array<{ role: string; content: unknown }>;
    tools?: unknown[];
  }) {
    const script = this.scripts[Math.min(this.calls, this.scripts.length - 1)];
    const callIndex = this.calls;
    this.calls += 1;
    this.toolsOffered.push(params.tools ?? []);
    // capture the LAST user message (the repair instruction on the repair turn)
    const last = params.messages[params.messages.length - 1];
    this.instructions.push(typeof last.content === 'string' ? last.content : JSON.stringify(last.content));
    if (script instanceof Error) throw script;
    const toolUses = this.repairToolUses[callIndex] ?? [];
    return { stop_reason: 'end_turn', text: script, tool_uses: toolUses, tokens_used: 10 };
  }
}

function makeRunner(root: string, provider: ScriptedProvider): AgentRunner {
  const cm = new ContextManager(root, DEFAULT_CONFIG);
  return new AgentRunner(
    cm,
    provider as never,
    root,
    { updateNodeStatus: async () => {}, writeNodeOutput: async () => {} } as unknown as RunArtifactManager,
    { model: 'test' } satisfies Partial<AgentRunnerConfig> as AgentRunnerConfig,
    undefined,
    undefined as unknown as ArtifactRepository,
  );
}

function ctx(root: string, overrides: Partial<Record<string, unknown>> = {}): StepRunContext {
  return {
    workflowRunId: 'v3-run',
    workflowId: 'full-build',
    stepId: 'design',
    iteration: 1,
    revision: 0,
    goal: 'v3 bounded structural repair probe',
    projectRoot: root,
    instruction: 'Produce your artifacts.',
    authorizedOutputs: ['docs/requirements.md', 'docs/architecture.md'],
    ...overrides,
  } as never;
}

const MISSING = envelope([{ path: 'docs/requirements.md', content: REQUIREMENTS }]);
const COMPLETE = envelope([
  { path: 'docs/requirements.md', content: REQUIREMENTS },
  { path: 'docs/architecture.md', content: ARCHITECTURE },
]);

function evidencePath(root: string, name = 'design.structural-repair.json'): string {
  return join(root, '.sle', 'runs', 'v3-run', '1', 'node-outputs', name);
}

// ─── 1. repair PASS: exactly one extra invocation, stage continues ───────────

test('V3.1: producer-contract shortfall triggers ONE repair turn; repaired output is adopted and materialized', async () => {
  const root = mkdtempSync(join(tmpdir(), 'v3-'));
  const provider = new ScriptedProvider([MISSING, COMPLETE]);
  try {
    const result = await makeRunner(root, provider).run('designer', ctx(root, { structuralRepair: true }));
    assert.equal(result.success, true, result.error);
    assert.equal(provider.calls, 2, 'exactly one repair invocation (2 total loop runs)');
    assert.deepEqual([...result.artifacts_written].sort(), ['docs/architecture.md', 'docs/requirements.md']);
    assert.equal(readFileSync(join(root, 'docs/architecture.md'), 'utf-8'), ARCHITECTURE.trimEnd());

    const ev = JSON.parse(readFileSync(evidencePath(root), 'utf-8'));
    assert.equal(ev.stage_id, 'design');
    assert.equal(ev.validator, 'producer-contract');
    assert.equal(ev.original_output, MISSING, 'original rejected output preserved verbatim');
    assert.match(ev.validation_error, /producer contract is unsatisfied/);
    assert.match(ev.validation_error, /docs\/architecture\.md/);
    assert.match(ev.output_contract, /docs\/requirements\.md/);
    assert.match(ev.output_contract, /docs\/architecture\.md/);
    assert.equal(ev.repair_output, COMPLETE, 'repair output preserved verbatim');
    assert.deepEqual(ev.second_validation, { ok: true, error: null });
    // ONE model inference for the repair, with NO repository tools offered:
    assert.equal(provider.toolsOffered[1].length, 0, 'repair completion is tool-less by construction');
    assert.ok(provider.instructions[1].includes(MISSING.trimEnd()));
    // the instruction carried the exact validator error + contract + original
    assert.match(ev.repair_instruction, /producer contract is unsatisfied/);
    assert.match(ev.repair_instruction, /docs\/architecture\.md/);
    assert.ok(ev.repair_instruction.includes(MISSING.trimEnd()));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── 2. repair FAIL: same validator rejects the repair → stage failure ───────

test('V3.2: repair that fails the same validator fails the stage — never a third invocation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'v3-'));
  const provider = new ScriptedProvider([MISSING, MISSING]);
  try {
    const result = await makeRunner(root, provider).run('designer', ctx(root, { structuralRepair: true }));
    assert.equal(result.success, false);
    assert.equal(provider.calls, 2, 'one repair only — no retries beyond it');
    assert.match(result.error!, /bounded structural repair was attempted and the same validator rejected/);
    assert.ok(!existsSync(join(root, 'docs/requirements.md')), 'still publishes nothing');
    const ev = JSON.parse(readFileSync(evidencePath(root), 'utf-8'));
    assert.deepEqual(ev.second_validation, { ok: false, error: ev.validation_error.match(/missing mandatory outputs.*/) ? ev.second_validation.error : ev.second_validation.error });
    assert.equal(ev.second_validation.ok, false);
    assert.match(ev.second_validation.error!, /architecture/);
    assert.equal(ev.original_output, MISSING);
    assert.equal(ev.repair_output, MISSING);
    // P2 — truthful accounting: the rejected repair's tokens count toward
    // the stage total (10 original + 10 repair).
    assert.equal(result.tokens_used, 20, 'failed repair tokens are still accounted');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── 3. legacy: absent flag → immediate fail, single invocation ──────────────

test('V3.3: absent structuralRepair flag keeps legacy behavior — immediate fail, no repair, no evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'v3-'));
  const provider = new ScriptedProvider([MISSING]);
  try {
    const result = await makeRunner(root, provider).run('designer', ctx(root));
    assert.equal(result.success, false);
    assert.equal(provider.calls, 1);
    assert.match(result.error!, /producer contract is unsatisfied/);
    assert.ok(!existsSync(evidencePath(root)), 'no repair evidence on the legacy path');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── 4. non-repairable classes never trigger a repair ────────────────────────

test('V3.4: extras-only contract violations are NOT repaired (over-production is not the incomplete-submission class)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'v3-'));
  const provider = new ScriptedProvider([COMPLETE]);
  try {
    const result = await makeRunner(root, provider).run(
      'designer',
      ctx(root, { structuralRepair: true, authorizedOutputs: ['docs/requirements.md'] }),
    );
    assert.equal(result.success, false);
    assert.equal(provider.calls, 1, 'no repair for the extras class');
    assert.match(result.error!, /outside its authorized output set/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('V3.5: unsafe output paths never reach the repair seam — transport rejects them and the loop fails closed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'v3-'));
  const provider = new ScriptedProvider([envelope([{ path: '../escape.md', content: 'x' }])]);
  try {
    const result = await makeRunner(root, provider).run('designer', ctx(root, { structuralRepair: true }));
    assert.equal(result.success, false);
    // The transport rejects the unsafe path at parse time (its own bounded
    // format-repair re-issue happens INSIDE the loop — that is legacy E10
    // behavior, not the V3 structural repair). The step fails with the
    // parse diagnostic, the structural gates are never reached, and no
    // repair evidence exists.
    assert.match(result.error!, /malformed result block/);
    assert.match(result.error!, /\.\./);
    assert.doesNotMatch(result.error!, /bounded structural repair/);
    assert.ok(!existsSync(evidencePath(root)), 'no V3 evidence for a pre-gate parse failure');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── 5. repair invocation itself fails ───────────────────────────────────────

test('V3.6: provider failure ON the repair turn fails the stage with the original rejection + evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'v3-'));
  const provider = new ScriptedProvider([MISSING, new Error('transport died mid-repair')]);
  try {
    const result = await makeRunner(root, provider).run('designer', ctx(root, { structuralRepair: true }));
    assert.equal(result.success, false);
    assert.equal(provider.calls, 2);
    assert.match(result.error!, /repair turn itself failed/);
    assert.match(result.error!, /producer contract is unsatisfied/);
    const ev = JSON.parse(readFileSync(evidencePath(root), 'utf-8'));
    assert.equal(ev.repair_output, '');
    assert.match(ev.repair_invocation_error!, /transport died mid-repair/);
    assert.equal(ev.second_validation.ok, false);
    assert.equal(result.tokens_used, 10, 'a completion that never happened costs nothing');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── 6. the instruction is generic — no hardcoded requirements ───────────────

test('V3.7: the repair instruction template hardcodes no requirement — everything is validator/contract-derived', () => {
  const instruction = buildStructuralRepairInstruction({
    validatorError: 'VALIDATOR-SAYS-THIS',
    contractText: 'CONTRACT-SAYS-THIS',
    originalOutput: 'ORIGINAL-OUTPUT-HERE',
  });
  assert.ok(instruction.includes('VALIDATOR-SAYS-THIS'));
  assert.ok(instruction.includes('CONTRACT-SAYS-THIS'));
  assert.ok(instruction.includes('ORIGINAL-OUTPUT-HERE'));
  assert.doesNotMatch(instruction, /## Purpose/);
  assert.doesNotMatch(instruction, /architecture\.md/);
  assert.match(instruction, /without changing/);
  assert.match(instruction, /same validator will rerun/);
});

// ─── 7. evidence never overwrites ────────────────────────────────────────────

test('V3.8: evidence persistence never overwrites an existing record', async () => {
  const root = mkdtempSync(join(tmpdir(), 'v3-'));
  const fs = await import('fs/promises');
  try {
    const existing = { stage_id: 'earlier' };
    mkdirSync(join(root, '.sle', 'runs', 'v3-run', '1', 'node-outputs'), { recursive: true });
    writeFileSync(evidencePath(root), JSON.stringify(existing));
    const written = await persistStructuralRepairEvidence(root, 'v3-run', 1, 'design', {
      stage_id: 'design', validator: 'v', original_output: 'o', validation_error: 'e',
      output_contract: 'c', repair_instruction: 'i', repair_output: 'r',
      second_validation: { ok: true, error: null }, repair_invocation_error: null,
      invoked_at: 'now',
    }, fs);
    assert.notEqual(written, evidencePath(root));
    assert.match(written, /structural-repair-2\.json$/);
    assert.equal(JSON.parse(readFileSync(evidencePath(root), 'utf-8')).stage_id, 'earlier');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── 8. charter gate (scoping) ───────────────────────────────────────────────

const CHARTER_NO_PURPOSE = envelope([
  { path: 'docs/cycle-charter.md', content: '# Cycle Charter\n\n## Scope\n\nORIGINAL scope text.\n' },
]);
const CHARTER_FIXED = envelope([
  { path: 'docs/cycle-charter.md', content: `# Cycle Charter\n\n## Scope\n\nORIGINAL scope text.\n\n${PURPOSE}\n` },
]);
const CHARTER_CHANGED_STILL_INVALID = envelope([
  { path: 'docs/cycle-charter.md', content: '# Cycle Charter\n\n## Scope\n\nCHANGED scope text, still no Purpose heading.\n' },
]);

function makeScoping(root: string, provider: ScriptedProvider): ScopingService {
  const runner = makeRunner(root, provider);
  const mapManager = { update: async (_fn: unknown) => {} } as never;
  return new ScopingService(runner, mapManager, root);
}

function scopingCtx(root: string, structuralRepair: boolean): StepRunContext {
  return {
    workflowRunId: 'v3-run',
    workflowId: 'full-build',
    stepId: 'scoping.produce',
    iteration: 1,
    revision: 0,
    goal: 'v3 charter repair probe',
    projectRoot: root,
    instruction: 'Draft the cycle charter.',
    outputArtifact: { path: 'docs/cycle-charter.md' },
    structuralRepair,
  } as never;
}

test('V3.9: charter missing ## Purpose → one repair turn → validator passes → begin() succeeds', async () => {
  const root = mkdtempSync(join(tmpdir(), 'v3-'));
  const provider = new ScriptedProvider([CHARTER_NO_PURPOSE, CHARTER_FIXED]);
  try {
    const service = makeScoping(root, provider);
    const result = await service.begin(scopingCtx(root, true));
    assert.equal(result.awaiting_scoping, true);
    assert.match(result.draft, /## Purpose/);
    assert.equal(provider.calls, 2);
    const onDisk = readFileSync(join(root, 'docs/cycle-charter.md'), 'utf-8');
    assert.match(onDisk, /## Purpose/, 'the repaired charter is the published material');
    assert.match(onDisk, /ORIGINAL scope text/, 'accepted candidate kept the original scope');
    assert.ok(onDisk.includes('Make RAG failures diagnosable'), 'the ACCEPTED candidate bytes are what got published');
    const ev = JSON.parse(readFileSync(evidencePath(root, 'scoping.produce.structural-repair.json'), 'utf-8'));
    assert.equal(ev.validator, 'charter-structure');
    assert.match(ev.original_output, /ORIGINAL scope text/);
    assert.doesNotMatch(ev.original_output, /## Purpose/);
    assert.match(ev.validation_error, /Scope and\/or Purpose/);
    assert.deepEqual(ev.second_validation, { ok: true, error: null });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('V3.10: a REJECTED repair never replaces the workspace charter (validator has publication authority)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'v3-'));
  const provider = new ScriptedProvider([CHARTER_NO_PURPOSE, CHARTER_CHANGED_STILL_INVALID]);
  try {
    const service = makeScoping(root, provider);
    await assert.rejects(
      service.begin(scopingCtx(root, true)),
      (err: Error) => {
        assert.match(err.message, /bounded structural repair was attempted/);
        return true;
      },
    );
    assert.equal(provider.calls, 2);
    // The repair candidate said CHANGED — and was rejected — so the workspace
    // artifact must still carry the ORIGINAL bytes.
    const onDisk = readFileSync(join(root, 'docs/cycle-charter.md'), 'utf-8');
    assert.match(onDisk, /ORIGINAL scope text/, 'original charter intact');
    assert.doesNotMatch(onDisk, /CHANGED scope text/, 'rejected repair was never published');
    const ev = JSON.parse(readFileSync(evidencePath(root, 'scoping.produce.structural-repair.json'), 'utf-8'));
    assert.equal(ev.second_validation.ok, false);
    assert.match(ev.repair_output, /CHANGED scope text/, 'the rejected repair is preserved as evidence');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('V3.12: adversarial — a repair reply that requests repository tools gets NO execution and NO second turn', async () => {
  const root = mkdtempSync(join(tmpdir(), 'v3-'));
  const provider = new ScriptedProvider([MISSING, 'No envelope here at all, just prose.']);
  provider.repairToolUses[1] = [{ type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'apps/ai-server/rag-worker-service/main.py' } }];
  try {
    const result = await makeRunner(root, provider).run('designer', ctx(root, { structuralRepair: true }));
    assert.equal(result.success, false, 'a tool-requesting, envelope-less repair reply fails the stage');
    assert.equal(provider.calls, 2, 'exactly one repair completion — no continuation');
    assert.equal(provider.toolsOffered[1].length, 0, 'no tools were offered to the repair completion');
    assert.match(result.error!, /bounded structural repair/);
    const ev = JSON.parse(readFileSync(evidencePath(root), 'utf-8'));
    // The tool request is irrelevant by construction: with tools:[] the
    // reply is plain text, the transport rejects it, and no tool can run.
    assert.match(ev.repair_invocation_error!, /unparseable/);
    // nothing was read or written by any tool: the fixture tree has no
    // requirements.md anywhere — a tool execution would have no observable
    // write path, and the artifacts_written list stays empty.
    assert.equal(result.artifacts_written.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('V3.11: charter gate without the flag keeps legacy behavior', async () => {
  const root = mkdtempSync(join(tmpdir(), 'v3-'));
  const provider = new ScriptedProvider([CHARTER_NO_PURPOSE]);
  try {
    const service = makeScoping(root, provider);
    await assert.rejects(
      service.begin(scopingCtx(root, false)),
      (err: Error) => {
        assert.match(err.message, /Scope and\/or Purpose/);
        assert.doesNotMatch(err.message, /bounded structural repair/);
        return true;
      },
    );
    assert.equal(provider.calls, 1);
    assert.ok(!existsSync(evidencePath(root, 'scoping.produce.structural-repair.json')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
