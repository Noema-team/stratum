// E26 — producer–consumer contract for the full-build artifact steps
// (operator ruling on the attempt-17 discovery).
//
// Attempts 8–17's DESIGN/PLAN/TEST "completions" never materialized a file:
// the transport taught '.sle/work/…' while the role ceilings only permit
// specific docs/ paths, so every section was dropped at parse and the step
// silently succeeded. E25 made that visible; E26 fixes the contract:
//
//   DESIGN → docs/requirements.md + docs/architecture.md (both mandatory)
//   PLAN   → docs/plan.md + docs/test-plan.md            (both mandatory)
//   TEST   → at least one executable test under apps/ai-server/tests/
//
// Pins (zero-model):
//   1. A DESIGN-shaped envelope at the authorized paths materializes BOTH
//      documents, reported and hashed (replay-shaped from the preserved
//      attempt responses, split per the new contract).
//   2. A missing mandatory output fails the step closed with a precise
//      diagnostic.
//   3. The preserved '.sle/work/…' shape STILL fails — no widening back.
//   4. PLAN materializes both plan documents.
//   5. TEST's executable tests materialize inside the repo tree where
//      EXEC/validation run them; the step contract (not a global role
//      widening) grants exactly that directory; an unauthorized extra
//      section fails.
//   6. Teaching renders the exact contract per step.
//   7. BUILD's E25 open-set behavior is unchanged.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { AgentRunner, type AgentRunnerConfig, checkAuthorizedOutputs, matchesAuthorizedOutput } from '../src/agent-runner.js';
import { TextualSleOutputTransport } from '../src/transport/textual-sle-output.js';
import type { TransportContext } from '../src/transport/step-result.js';
import type { RunArtifactManager } from '../src/run-artifacts.js';
import type { ArtifactRepository, ArtifactRecord } from '../src/storage/repositories.js';
import { ContextManager, DEFAULT_CONFIG } from '../src/context-manager.js';
import { FULL_BUILD } from '../src/workflow/builtins/full-build.js';

// ─── fixtures, replay-shaped from the preserved attempt responses ────────────

const REQUIREMENTS = '# Requirements\n\nThe worker failure payload must carry error_message, stage, retryable.\n';
const ARCHITECTURE = '# Architecture\n\nprocess_document composes the payload; no rag-api changes.\n';
const PLAN = '# Plan\n\n1. Add _derive_retryable\n2. Extend payload construction\n';
const TEST_PLAN = '# Test plan\n\nContract test under apps/ai-server/tests/integration.\n';
const TEST_FILE = 'import pytest\n\ndef test_failure_payload_carries_stage():\n    assert True\n';

function envelope(sections: Array<{ path: string; content: string }>): string {
  const body = sections
    .map((s) => `<<<SLE-ARTIFACT path="${s.path}">>>\n${s.content.trimEnd()}\n<<<END-SLE-ARTIFACT>>>`)
    .join('\n');
  return `<<<SLE-OUTPUT>>>\n${body}\n<<<END-SLE-OUTPUT>>>`;
}

class RecordingArtifactRepository implements Partial<ArtifactRepository> {
  saved: ArtifactRecord[] = [];
  findByWorkflowRunRefAndHash(_runId: string, ref: string, hash: string): ArtifactRecord | undefined {
    return this.saved.find((r) => r.ref === ref && r.hash === hash);
  }
  listByWorkflowRun(runId: string): ArtifactRecord[] {
    return this.saved.filter((r) => r.workflowRunId === runId);
  }
  save(record: ArtifactRecord): void {
    this.saved.push(record);
  }
}

function makeRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'e26-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function makeRunner(root: string, reply: string, repository?: RecordingArtifactRepository): AgentRunner {
  const provider = {
    async complete() {
      throw new Error('e26: single-turn path not expected');
    },
    async completeMultiTurn() {
      return { stop_reason: 'end_turn', text: reply, tool_uses: [], tokens_used: 10 };
    },
  };
  const cm = new ContextManager(root, DEFAULT_CONFIG);
  return new AgentRunner(
    cm,
    provider as never,
    root,
    { updateNodeStatus: async () => {}, writeNodeOutput: async () => {} } as unknown as RunArtifactManager,
    { model: 'test' } satisfies Partial<AgentRunnerConfig> as AgentRunnerConfig,
    undefined,
    repository as unknown as ArtifactRepository,
  );
}

function ctx(root: string, authorizedOutputs: string[]) {
  return {
    workflowRunId: 'e26-run',
    workflowId: 'full-build',
    stepId: 'probe',
    iteration: 1,
    revision: 0,
    goal: 'e26 producer-consumer contract probe',
    projectRoot: root,
    instruction: 'Produce your artifacts.',
    authorizedOutputs,
  } as never;
}

// ─── 1+2. DESIGN contract ─────────────────────────────────────────────────────

const DESIGN_OUT = ['docs/requirements.md', 'docs/architecture.md'];

test('E26.1: DESIGN replay at authorized paths materializes both documents, reported and hashed', async () => {
  const { root, cleanup } = makeRoot();
  const repository = new RecordingArtifactRepository();
  const reply = envelope([
    { path: 'docs/requirements.md', content: REQUIREMENTS },
    { path: 'docs/architecture.md', content: ARCHITECTURE },
  ]);
  try {
    const result = await makeRunner(root, reply, repository).run('designer', ctx(root, DESIGN_OUT));
    assert.equal(result.success, true, result.error);
    assert.deepEqual([...result.artifacts_written].sort(), [...DESIGN_OUT].sort());
    assert.equal(readFileSync(join(root, 'docs/requirements.md'), 'utf-8'), REQUIREMENTS.trimEnd());
    assert.equal(readFileSync(join(root, 'docs/architecture.md'), 'utf-8'), ARCHITECTURE.trimEnd());
    const hashes = new Map(repository.saved.map((r) => [r.path, r.hash]));
    assert.equal(hashes.get('docs/requirements.md'), createHash('sha256').update(REQUIREMENTS.trimEnd()).digest('hex'));
    assert.equal(hashes.get('docs/architecture.md'), createHash('sha256').update(ARCHITECTURE.trimEnd()).digest('hex'));
  } finally {
    cleanup();
  }
});

test('E26.2: DESIGN missing one mandatory document fails the step closed with a precise diagnostic', async () => {
  const { root, cleanup } = makeRoot();
  const reply = envelope([{ path: 'docs/requirements.md', content: REQUIREMENTS }]);
  try {
    const result = await makeRunner(root, reply).run('designer', ctx(root, DESIGN_OUT));
    assert.equal(result.success, false);
    assert.match(result.error!, /producer contract is unsatisfied/);
    assert.match(result.error!, /docs\/architecture\.md/);
    assert.ok(!existsSync(join(root, 'docs/requirements.md')), 'a contract-violating run publishes nothing');
  } finally {
    cleanup();
  }
});

// ─── 3. the preserved '.sle/work/…' shape still fails ────────────────────────

test('E26.3: the historical single-doc .sle/work envelope still fails — no widening back', async () => {
  const { root, cleanup } = makeRoot();
  const reply = envelope([{ path: '.sle/work/wi-define-108-a8/design.md', content: '# Design\n' }]);
  try {
    const result = await makeRunner(root, reply).run('designer', ctx(root, DESIGN_OUT));
    assert.equal(result.success, false);
    assert.match(result.error!, /producer contract is unsatisfied/);
    assert.match(result.error!, /\.sle\/work\/wi-define-108-a8\/design\.md/, 'diagnostic names the dropped historical path');
  } finally {
    cleanup();
  }
});

// ─── 4. PLAN contract ─────────────────────────────────────────────────────────

test('E26.4: PLAN replay materializes both plan documents', async () => {
  const { root, cleanup } = makeRoot();
  const repository = new RecordingArtifactRepository();
  const reply = envelope([
    { path: 'docs/plan.md', content: PLAN },
    { path: 'docs/test-plan.md', content: TEST_PLAN },
  ]);
  try {
    const result = await makeRunner(root, reply, repository).run('planner', ctx(root, ['docs/plan.md', 'docs/test-plan.md']));
    assert.equal(result.success, true, result.error);
    assert.deepEqual([...result.artifacts_written].sort(), ['docs/plan.md', 'docs/test-plan.md']);
    assert.equal(repository.saved.length, 2);
  } finally {
    cleanup();
  }
});

// ─── 5. TEST contract: executable tests in the tree, scoped authorization ────

test('E26.5: TEST produces executable tests inside the repo tree via its step contract, not a role widening', async () => {
  const { root, cleanup } = makeRoot();
  const reply = envelope([
    { path: 'apps/ai-server/tests/integration/test_failure_payload.py', content: TEST_FILE },
  ]);
  try {
    const result = await makeRunner(root, reply).run('tester', ctx(root, ['apps/ai-server/tests/']));
    assert.equal(result.success, true, result.error);
    assert.deepEqual(result.artifacts_written, ['apps/ai-server/tests/integration/test_failure_payload.py']);
    assert.ok(existsSync(join(root, 'apps/ai-server/tests/integration/test_failure_payload.py')), 'test exists where EXEC/validation run it');
  } finally {
    cleanup();
  }
});

test('E26.5b: TEST refusing to write tests (plan-doc-only reply) fails — another plan doc is not a test', async () => {
  const { root, cleanup } = makeRoot();
  const reply = envelope([{ path: 'docs/test-plan.md', content: TEST_PLAN }]);
  try {
    const result = await makeRunner(root, reply).run('tester', ctx(root, ['apps/ai-server/tests/']));
    assert.equal(result.success, false);
    assert.match(result.error!, /no file produced under: \[apps\/ai-server\/tests\/\]/);
  } finally {
    cleanup();
  }
});

test('E26.5c: a ceiling-allowed but contract-unauthorized extra section fails the step', async () => {
  const { root, cleanup } = makeRoot();
  const reply = envelope([
    { path: 'apps/ai-server/tests/integration/test_failure_payload.py', content: TEST_FILE },
    { path: 'docs/test-plan.md', content: 'another plan doc is not a test\n' },
  ]);
  try {
    const result = await makeRunner(root, reply).run('tester', ctx(root, ['apps/ai-server/tests/']));
    assert.equal(result.success, false);
    assert.match(result.error!, /outside its authorized output set/);
    assert.match(result.error!, /docs\/test-plan\.md/);
  } finally {
    cleanup();
  }
});

// ─── 6. teaching renders the exact contract ──────────────────────────────────

test('E26.6: teaching renders the authorized set — exact paths mandatory, prefix as at-least-one, no .sle example', () => {
  const t = new TextualSleOutputTransport();
  const design = t.formatInstruction({
    role: 'designer', requiresReviewVerdict: false, execution: 'multi-turn',
    authorizedOutputs: DESIGN_OUT,
  } as TransportContext);
  assert.ok(design.includes('docs/requirements.md') && design.includes('docs/architecture.md'));
  assert.ok(design.includes('Emit exactly one artifact block for EACH'));
  assert.ok(!design.includes('.sle/work/'), 'no unwritable example leaks into a contracted step');
  const testTeaching = t.formatInstruction({
    role: 'tester', requiresReviewVerdict: false, execution: 'multi-turn',
    authorizedOutputs: ['apps/ai-server/tests/'],
  } as TransportContext);
  assert.ok(testTeaching.includes('at least one new file under apps/ai-server/tests/'));
});

// ─── 7. BUILD's E25 behavior unchanged ────────────────────────────────────────

test('E26.7: full-build declarations — design/plan/test contracted, scoping declared, build open-set', () => {
  const step = (id: string) => FULL_BUILD.steps.find((s) => s.id === id) as { authorizedOutputs?: string[]; outputArtifact?: unknown };
  assert.deepEqual(step('design')!.authorizedOutputs, DESIGN_OUT);
  assert.deepEqual(step('plan')!.authorizedOutputs, ['docs/plan.md', 'docs/test-plan.md']);
  assert.deepEqual(step('test')!.authorizedOutputs, ['apps/ai-server/tests/']);
  assert.equal(step('build')!.authorizedOutputs, undefined, 'BUILD keeps its E25 open set');
  assert.equal(step('build')!.outputArtifact, undefined, 'BUILD still declares no single artifact');
  assert.ok(step('scoping.produce')!.outputArtifact, 'scoping keeps its declared single output');
});

// ─── matcher unit pins ────────────────────────────────────────────────────────

test('E26.8: contract matcher semantics — exact mandatory, prefix at-least-one, extras rejected', () => {
  assert.ok(matchesAuthorizedOutput('apps/ai-server/tests/x.py', 'apps/ai-server/tests/'));
  assert.ok(!matchesAuthorizedOutput('docs/x.md', 'apps/ai-server/tests/'));
  const missing = checkAuthorizedOutputs(['docs/plan.md'], ['docs/plan.md', 'docs/test-plan.md']);
  assert.equal(missing.ok, false);
  const ok = checkAuthorizedOutputs(['docs/plan.md', 'docs/test-plan.md'], ['docs/plan.md', 'docs/test-plan.md']);
  assert.equal(ok.ok, true);
});
