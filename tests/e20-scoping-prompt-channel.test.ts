// E20 — scoping prompt channel + clean outcome terminal (post-A10 attempt 1).
//
// A10 attempt 1 reached the first real full-build model invocation on a real
// frozen Definition. The E19 machinery held (the model wrote ONE section at
// the EXACT declared path — the A8 path/materialization gaps stay closed),
// and the deterministic consumer correctly rejected the charter BEFORE any
// approval state. But two deterministic seams surfaced:
//
//   F-d — the charter grammar taught in FACILITATOR_SCOPING_TEMPLATE (PR #34)
//     is INERT in the execution path: ContextManager.loadSystemPrompt reads
//     only {projectRoot}/.sle/prompts/<role>.md (absent in the pilot), so the
//     model never saw the ## Scope / ## Purpose grammar. It produced a
//     substantively excellent charter under its own heading vocabulary
//     ("## In scope") and the consumer correctly failed it.
//     Fix: teach the grammar in the SAME channel that already teaches the
//     declared output path (buildTaskDescription's declared-artifact line —
//     the channel PROVEN to reach the model), for scoping.produce only.
//
//   F-e — begin()'s failure threw OUT of executeScopingProduce, escaping the
//     engine's outcome path: the WorkItem was failed but the run row stayed
//     ACTIVE and the manifest node RUNNING (inconsistent terminal state).
//     Fix: surface begin() failures as a failed StepRunOutcome so the engine
//     records node failed + run halted cleanly.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ContextManager, DEFAULT_CONFIG } from '../src/context-manager.js';
import { FullBuildStepRunner } from '../src/execution/full-build-step-runner.js';
import { ScopingService, validateCharterStructure } from '../src/scoping-service.js';
import { AgentRunner } from '../src/agent-runner.js';
import { RunArtifactManager } from '../src/run-artifacts.js';
import { CYCLE_CHARTER_OUTPUT } from '../src/workflow/builtins/full-build.js';
import type { RuntimeMapManager } from '../src/runtime-map.js';
import type { RuntimeMap } from '../src/runtime-map.js';
import type { StepRunContext, WorkflowStep } from '../src/workflow/types.js';
import type { ILLMProvider, LLMCompletionParams, LLMCompletionResult } from '../src/llm-provider.js';
import type { IMultiTurnProvider, MultiTurnParams, MultiTurnResult } from '../src/agent-loop.js';

// ─── F-d: the grammar must be present in the channel the model actually sees ─

test('E20: scoping.produce task text teaches the exact charter grammar (the channel the execution path assembles)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'e20-prompt-'));
  try {
    const cm = new ContextManager(root, { ...DEFAULT_CONFIG });
    const ctx: StepRunContext = {
      workflowRunId: 'e20', workflowId: 'full-build', stepId: 'scoping.produce',
      role: 'facilitator', facilitatorMode: 'scoping',
      iteration: 1, revision: 0, goal: 'align the failure payload', projectRoot: root,
      outputArtifact: { ...CYCLE_CHARTER_OUTPUT },
    };
    const assembled = await cm.assemble('facilitator', ctx);
    // The declared-path line (proven to reach the model in A10 attempt 1)…
    assert.ok(assembled.task.includes("write exactly one artifact section at 'docs/cycle-charter.md'"));
    // …and, in the SAME channel, the exact grammar the deterministic
    // consumer enforces — including the deviation example A10 produced.
    assert.ok(assembled.task.includes('## Scope\n## Purpose\n## Requirements\n## Boundaries\n## Version bump\n## Deferred items'));
    assert.ok(assembled.task.includes('"## In scope"'), 'the A10 deviation must be named as a failure example');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('E20: non-scoping steps with a declared outputArtifact keep byte-identical task text (no grammar leakage)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'e20-parity-'));
  try {
    const cm = new ContextManager(root, { ...DEFAULT_CONFIG });
    const base: StepRunContext = {
      workflowRunId: 'e20', workflowId: 'define-work', stepId: 'synthesize-definition',
      role: 'explorer', iteration: 1, revision: 0, goal: 'draft definition', projectRoot: root,
      outputArtifact: { type: 'definition', ref: 'definition:{objectiveId}', path: '.sle/work/{workItemId}/definition.md' },
    };
    const withE20 = await cm.assemble('explorer', base);
    assert.ok(!withE20.task.includes('## Deferred items'), 'define-work steps must not receive the charter grammar');
    assert.ok(withE20.task.includes("write exactly one artifact section at '.sle/work/{workItemId}/definition.md'"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── F-e: begin() failure surfaces as a failed OUTCOME, not a thrown error ────

class ScriptedProvider implements ILLMProvider, IMultiTurnProvider {
  calls = 0;
  constructor(private readonly content: string) {}
  async complete(_params: LLMCompletionParams): Promise<LLMCompletionResult> {
    this.calls++;
    return { content: this.content, tokens_used: 100, duration_ms: 1 };
  }
  async completeMultiTurn(_params: MultiTurnParams): Promise<MultiTurnResult> {
    this.calls++;
    return { stop_reason: 'end_turn', text: this.content, tool_uses: [], tokens_used: 100 };
  }
}

function baseMap(): RuntimeMap {
  return {
    project: { name: 'e20', description: 'e20', type: 'custom' },
    task_store: { type: 'local' }, agents: {},
    discovery: {
      status: 'complete', mode: 'full', completed_at: '2026-01-01T00:00:00Z',
      artifacts: [], current_round: 0, total_rounds: 1,
      current_phase: 0, total_phases: 0, open_questions_count: 0, blocking_questions_count: 0,
    },
    cycle: {
      number: 1, iteration: 1, revision: 0, max_iterations: 5,
      planning_depth: 'minimal', started_at: '2026-01-01T00:00:00Z',
      outcome: 'cycling', approval_gate: null,
      awaiting_scoping: false, awaiting_confirmation: false, awaiting_sharding_approval: false,
    },
    artifacts: [],
  } as unknown as RuntimeMap;
}

class InMemoryMapManager implements RuntimeMapManager {
  public map: RuntimeMap = baseMap();
  async read() { return JSON.parse(JSON.stringify(this.map)); }
  async update(fn: (m: RuntimeMap) => RuntimeMap) { this.map = fn(JSON.parse(JSON.stringify(this.map))); }
  async write(m: RuntimeMap) { this.map = JSON.parse(JSON.stringify(m)); }
  [key: string]: unknown;
}

function sleOutput(path: string, content: string): string {
  return `<<<SLE-OUTPUT>>>\n### ${path}\n${content}\n<<<END-SLE-OUTPUT>>>`;
}

test('E20: charter with wrong headings → executeScopingProduce RESOLVES with a failed outcome (run/node recorded cleanly), awaiting_scoping never set', async () => {
  const root = mkdtempSync(join(tmpdir(), 'e20-outcome-'));
  try {
    await import('node:fs/promises').then(fs => fs.mkdir(join(root, 'docs'), { recursive: true }));
    // The A10 attempt-1 shape: right path, own heading vocabulary.
    const content = [
      '# Cycle Charter — failure payload alignment',
      '',
      '## In scope',
      'Worker persists error_message and stage.',
      '',
      '## Out of scope (non-goals)',
      'No rag-api changes.',
    ].join('\n');
    const provider = new ScriptedProvider(sleOutput('docs/cycle-charter.md', content));
    const cm = new ContextManager(root, { ...DEFAULT_CONFIG });
    const agentRunner = new AgentRunner(cm, provider, root, new RunArtifactManager({ projectRoot: root }), { model: 'e20' });
    const map = new InMemoryMapManager();
    const scoping = new ScopingService(agentRunner, map, root);
    const runner = new FullBuildStepRunner({
      agentStepRunner: { run: async () => { throw new Error('not used'); } },
      mapManager: map,
      runArtifacts: new RunArtifactManager({ projectRoot: root }),
      projectRoot: root,
      confirmService: {}, execService: {}, validationGateService: {},
      snapshotService: {}, summariseService: {},
      scopingService: scoping,
    } as never, {
      onCheckpoint: async () => 'halt',
      onConfirmGate: async () => 'halt',
      onShardingGate: async () => 'halt',
    });
    const step: WorkflowStep = { id: 'scoping.produce', kind: 'produce', agentRole: 'facilitator', templateId: 'scoping', outputArtifact: { ...CYCLE_CHARTER_OUTPUT } };
    const ctx: StepRunContext = {
      workflowRunId: 'e20-run', workflowId: 'full-build', stepId: 'scoping.produce',
      role: 'facilitator', facilitatorMode: 'scoping',
      iteration: 1, revision: 0, goal: 'align the failure payload', projectRoot: root,
      outputArtifact: { ...CYCLE_CHARTER_OUTPUT },
    };
    const outcome = await runner.run(step, ctx);
    assert.strictEqual(outcome.success, false, 'must be a failed OUTCOME, not a throw');
    assert.ok(outcome.error?.includes('Scope'), 'the error must carry the structural reason verbatim');
    assert.strictEqual(outcome.artifacts_written.length, 0, 'no artifacts reported for a rejected charter');
    assert.strictEqual(map.map.cycle.awaiting_scoping, false, 'no approval state');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('E20: the grammar teaches ScopingService-approved syntax (parity with the deterministic consumer)', () => {
  // Keep the taught grammar and the validator in lockstep: the exact six
  // headings listed in the task channel must all pass validateCharterStructure
  // for Scope/Purpose.
  const charter = ['## Scope', 'body', '## Purpose', 'body', '## Requirements', '', '## Boundaries', '', '## Version bump', '', '## Deferred items', ''].join('\n');
  assert.deepStrictEqual(validateCharterStructure(charter), { ok: true });
});
