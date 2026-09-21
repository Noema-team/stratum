// E19 — deterministic scoping publication qualification (post-A8).
//
// A8 crossed H1 (clean autonomous define-work → DDR-041 → Gate B → real
// full-build model execution) and died at the scoping publication seam with
// three findings that reduce to two contract gaps:
//
//   Gap 1 — scoping.produce declared NO outputArtifact: the facilitator chose
//     its own path in the transport envelope (A8: .sle/work/<wi>/scoping.md),
//     the step runner REPORTED docs/cycle-charter.md as written regardless
//     (artifacts_written was unconditional), and ScopingService.approve later
//     failed no_scoping_draft because nothing had materialized the file.
//   Gap 2 — producer/consumer syntax mismatch: the scoping prompt taught
//     sections conceptually ("1. **Scope**") while approve() validates the
//     exact heading grammar (^#{1,3}\s*scope\b) — A8's charter
//     ("## 1. Scope statement") would have failed approval even if placed.
//
// E19 proves, with ZERO model calls (scripted provider, real AgentRunner /
// ContextManager / ScopingService / map state):
//
//   1. the declared output artifact (CYCLE_CHARTER_OUTPUT) fails the step
//      closed at the exact-path boundary when the model emits any other path
//      (the A8 shape) — no approval state, no checkpoint, no file;
//   2. a canonical charter at the declared path materializes to the real
//      file, passes structural validation inside begin() BEFORE any approval
//      state, and flows through approve() (checkpoint → DESIGN reachable);
//   3. a charter with A8's heading style fails closed at begin()
//      (charter_validation_failed) — the deterministic consumer never sees
//      an artifact it cannot accept;
//   4. FullBuildStepRunner.executeScopingProduce propagates real failures
//      and passes the DECLARED step through when ScopingService is absent
//      (the former bare literal silently dropped the declaration).

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ContextManager, DEFAULT_CONFIG } from '../src/context-manager.js';
import { AgentRunner } from '../src/agent-runner.js';
import { RunArtifactManager } from '../src/run-artifacts.js';
import { ScopingService, validateCharterStructure } from '../src/scoping-service.js';
import { FullBuildStepRunner } from '../src/execution/full-build-step-runner.js';
import { CYCLE_CHARTER_OUTPUT } from '../src/workflow/builtins/full-build.js';
import type { RuntimeMapManager } from '../src/runtime-map.js';
import type { StepRunContext, StepRunner, StepRunOutcome, WorkflowStep } from '../src/workflow/types.js';
import type { RuntimeMap } from '../src/runtime-map.js';
import type { ILLMProvider, LLMCompletionParams, LLMCompletionResult } from '../src/llm-provider.js';
import type { IMultiTurnProvider, MultiTurnParams, MultiTurnResult } from '../src/agent-loop.js';
import type { AgentStepRunner } from '../src/execution/agent-step-runner.js';

// ─── scripted provider ────────────────────────────────────────────────────────

// Multi-turn wire — the same transport the live A8 run used (the facilitator
// emitted a <<<SLE-OUTPUT>>> block carrying its own declared path).
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

function sleOutput(path: string, content: string): string {
  return `<<<SLE-OUTPUT>>>\n### ${path}\n${content}\n<<<END-SLE-OUTPUT>>>`;
}

// The A8 charter's substance, trimmed — including its heading style that
// approve() deterministically rejects.
const A8_STYLE_CHARTER = [
  '# Scoping — wi-define-108-a8',
  '',
  '- **Intent:** rag-worker → rag-api: failure payload contract mismatch',
  '',
  '## 1. Scope statement',
  '',
  'One production file changes: apps/ai-server/rag-worker-service/main.py.',
  '',
  '## 2. Purpose',
  '',
  'Align the worker failure payload with the api contract.',
].join('\n');

const CANONICAL_CHARTER = [
  '# Cycle Charter',
  '',
  '## Scope',
  '',
  'One production file changes: apps/ai-server/rag-worker-service/main.py, and only inside process_document.',
  '',
  '## Purpose',
  '',
  'Align the worker failure payload with the api contract so failures persist with message and stage.',
  '',
  '## Requirements',
  '',
  '- Worker publishes error_message and stage on failure',
  '- One contract test locks the payload shape',
  '',
  '## Boundaries',
  '',
  '- rag-api-service changes not at all',
  '',
  '## Version bump',
  '',
  'patch',
  '',
  '## Deferred items',
  '',
  '- Retryable derivation',
].join('\n');

// ─── stack builder ────────────────────────────────────────────────────────────

function baseMap(): RuntimeMap {
  return {
    project: { name: 'e19', description: 'e19', type: 'custom' },
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

interface Stack {
  root: string;
  provider: ScriptedProvider;
  scoping: ScopingService;
  map: InMemoryMapManager;
  ctx: StepRunContext;
  cleanup: () => Promise<void>;
}

async function makeStack(content: string): Promise<Stack> {
  const root = mkdtempSync(join(tmpdir(), 'e19-scoping-'));
  await mkdir(join(root, 'docs'), { recursive: true });
  const provider = new ScriptedProvider(content);
  const cm = new ContextManager(root, { ...DEFAULT_CONFIG });
  const ram = new RunArtifactManager({ projectRoot: root });
  const agentRunner = new AgentRunner(cm, provider, root, ram, { model: 'e19-model' });
  const map = new InMemoryMapManager();
  const scoping = new ScopingService(agentRunner, map, root);
  const ctx: StepRunContext = {
    workflowRunId: 'e19-run', workflowId: 'full-build', stepId: 'scoping.produce',
    role: 'facilitator', facilitatorMode: 'scoping',
    iteration: 1, revision: 0, goal: 'align worker failure payload',
    projectRoot: root,
    outputArtifact: { ...CYCLE_CHARTER_OUTPUT },
  };
  return {
    root, provider, scoping, map, ctx,
    cleanup: async () => rmSync(root, { recursive: true, force: true }),
  };
}

// ─── 1. Gap 1: the A8 shape fails closed at the exact-path boundary ──────────

test('E19: A8-shape output (model-declared .sle path) fails closed at the declared-path boundary — no approval state, no checkpoint, no file', async () => {
  // Reproduces A8 verbatim: the model wrote a substantive charter but
  // declared .sle/work/wi-define-108-a8/scoping.md in its output envelope.
  const s = await makeStack(sleOutput('.sle/work/wi-define-108-a8/scoping.md', A8_STYLE_CHARTER));
  try {
    await assert.rejects(
      () => s.scoping.begin(s.ctx),
      (e: any) => e.code === 'scoping_failed',
      'begin() must surface the AgentRunner failure (wrong output path) as a failed step',
    );
    assert.strictEqual(s.map.map.cycle.awaiting_scoping, false, 'awaiting_scoping must NEVER be set for a failed produce');
    await assert.rejects(() => readFile(join(s.root, 'docs/cycle-charter.md')), 'the declared file must not exist');
    await assert.rejects(() => readFile(join(s.root, '.sle/work/wi-define-108-a8/scoping.md')), 'the model-declared path must not be materialized either');
    assert.ok(s.provider.calls >= 1);
  } finally {
    await s.cleanup();
  }
});

// ─── 2. canonical charter → materialization → validation → approval ──────────

test('E19: canonical charter at the declared path materializes, passes begin()-time structural validation, and approves — DESIGN reachable', async () => {
  const s = await makeStack(sleOutput('docs/cycle-charter.md', CANONICAL_CHARTER));
  try {
    const begun = await s.scoping.begin(s.ctx);
    assert.ok(begun.draft.includes('## Scope'));
    assert.strictEqual(begun.awaiting_scoping, true);
    const onDisk = await readFile(join(s.root, 'docs/cycle-charter.md'), 'utf-8');
    assert.ok(onDisk.includes('One production file changes'), 'the charter must be materialized to the REAL declared file');
    assert.strictEqual(s.map.map.cycle.awaiting_scoping, true, 'approval state set only AFTER the charter exists and validates');

    const approved = await s.scoping.approve(1, 1);
    assert.strictEqual(approved.awaiting_scoping, false);
    assert.strictEqual(s.map.map.cycle.awaiting_scoping, false);
  } finally {
    await s.cleanup();
  }
});

// ─── 3. Gap 2: A8's heading style fails closed BEFORE any approval state ─────

test('E19: right path, A8 heading style ("## 1. Scope statement") — begin() fails charter_validation_failed, awaiting_scoping never set', async () => {
  const s = await makeStack(sleOutput('docs/cycle-charter.md', A8_STYLE_CHARTER));
  try {
    // The transport-level machinery succeeds (path matches, one section) —
    // materialization happens; the STRUCTURAL consumer rejects it before any
    // approval state or checkpoint can exist.
    await assert.rejects(
      () => s.scoping.begin(s.ctx),
      (e: any) => e.code === 'charter_validation_failed' && /## Scope/.test(e.message),
    );
    assert.strictEqual(s.map.map.cycle.awaiting_scoping, false);
    const onDisk = await readFile(join(s.root, 'docs/cycle-charter.md'), 'utf-8');
    assert.ok(onDisk.includes('## 1. Scope statement'), 'the invalid file exists but never reached an approval state');
  } finally {
    await s.cleanup();
  }
});

test('E19: validateCharterStructure accepts exactly what approve() always accepted', () => {
  assert.deepStrictEqual(validateCharterStructure('# Charter\n\n## Scope\n\n## Purpose\n'), { ok: true });
  assert.deepStrictEqual(validateCharterStructure('### Scope\n\n## Purpose\n'), { ok: true });
  assert.strictEqual(validateCharterStructure(A8_STYLE_CHARTER).ok, false);
  assert.strictEqual(validateCharterStructure('## Purpose only\n').ok, false);
});

// ─── 4. FullBuildStepRunner truthfulness ──────────────────────────────────────

class RecordingStepRunner implements StepRunner {
  readonly seen: Array<{ step: WorkflowStep; ctx: StepRunContext }> = [];
  constructor(private readonly outcome?: StepRunOutcome) {}
  async run(step: WorkflowStep, ctx: StepRunContext): Promise<StepRunOutcome> {
    this.seen.push({ step, ctx });
    return this.outcome ?? { success: true, artifacts_written: [], tokens_used: 0, duration_ms: 0 };
  }
}

function makeFullBuildRunner(deps: Partial<ConstructorParameters<typeof FullBuildStepRunner>[0]> & Record<string, unknown>) {
  return new FullBuildStepRunner(deps as never, {
    onCheckpoint: async () => 'halt',
    onConfirmGate: async () => 'halt',
    onShardingGate: async () => 'halt',
  });
}

test('E19: executeScopingProduce propagates real failure — the step that reported artifacts_written unconditionally in A8 now fails', async () => {
  // Real stack with the A8 heading defect: begin() rejects.
  const s = await makeStack(sleOutput('docs/cycle-charter.md', A8_STYLE_CHARTER));
  try {
    const runner = makeFullBuildRunner({
      agentStepRunner: new RecordingStepRunner(),
      mapManager: s.map,
      runArtifacts: new RunArtifactManager({ projectRoot: s.root }),
      projectRoot: s.root,
      confirmService: {}, execService: {}, validationGateService: {},
      snapshotService: {}, summariseService: {},
      scopingService: s.scoping,
    });
    await assert.rejects(
      () => runner.run({ id: 'scoping.produce', kind: 'produce', agentRole: 'facilitator' } as WorkflowStep, s.ctx),
      (e: any) => e.code === 'charter_validation_failed',
      'the produce step must FAIL, never report success for a charter no consumer can accept',
    );
  } finally {
    await s.cleanup();
  }
});

test('E19: without a ScopingService, the DECLARED step (with its outputArtifact) reaches AgentStepRunner — the bare-literal drop is gone', async () => {
  const s = await makeStack(sleOutput('docs/cycle-charter.md', CANONICAL_CHARTER));
  try {
    const recorder = new RecordingStepRunner();
    const runner = makeFullBuildRunner({
      agentStepRunner: recorder,
      mapManager: s.map,
      runArtifacts: new RunArtifactManager({ projectRoot: s.root }),
      projectRoot: s.root,
      confirmService: {}, execService: {}, validationGateService: {},
      snapshotService: {}, summariseService: {},
      // scopingService deliberately absent — the fallback path
    });
    const declaredStep: WorkflowStep = {
      id: 'scoping.produce', kind: 'produce', agentRole: 'facilitator', templateId: 'scoping',
      outputArtifact: { ...CYCLE_CHARTER_OUTPUT },
    };
    await runner.run(declaredStep, s.ctx);
    assert.strictEqual(recorder.seen.length, 1);
    assert.deepStrictEqual(recorder.seen[0].step.outputArtifact, CYCLE_CHARTER_OUTPUT),
      'the fallback must forward the step WITH its declaration';
  } finally {
    await s.cleanup();
  }
});
