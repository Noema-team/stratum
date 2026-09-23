// E25 — BUILD publication integrity (operator ruling on attempt 16).
//
// Attempt 16 proved the model can generate a substantial implementation
// proposal; it also proved Stratum could NOT publish it: the builder shipped
// a valid SLE envelope whose single section declared a '.sle/work/…' path,
// the parser dropped it (role-forbidden) with a warning, the warning was
// lost, the runner wrote zero files and reported success, and EXEC +
// validation ran against an unchanged tree.
//
// Qualification pins (zero-model):
//   1. Teaching: an undeclared builder step is taught per-file blocks at
//      repository-relative paths — never '.sle/work/…' (unwritable for the
//      role); each block must carry the complete final file contents.
//   2. The EXACT attempt-16 envelope now fails the step closed, with the
//      dropped-path warning as the diagnostic — never a silent zero-file
//      success.
//   3. A permitted multi-file artifact materializes byte-exact, reports
//      artifacts_written accurately, and records per-file hashed provenance
//      rows (type 'produced-file') without a fake static output path.
//   4. Declared single-output behavior is unchanged (shape, recording).
//   5. A reported write that did not land on disk is a publication-
//      integrity failure, not a success.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { AgentRunner, type AgentRunnerConfig } from '../src/agent-runner.js';
import { TextualSleOutputTransport } from '../src/transport/textual-sle-output.js';
import type { TransportContext } from '../src/transport/step-result.js';
import type { RunArtifactManager } from '../src/run-artifacts.js';
import type { ArtifactRepository, ArtifactRecord } from '../src/storage/repositories.js';
import { ContextManager, DEFAULT_CONFIG } from '../src/context-manager.js';

// ─── attempt-16 fixture: the exact envelope BUILD shipped ────────────────────

const ATTEMPT16_ENVELOPE = [
  'Build step complete. All changes are specified below in the implementation artifact.',
  '<<<SLE-OUTPUT>>>',
  '<<<SLE-ARTIFACT path=".sle/work/wi-define-108-a8/implementation.md">>>',
  '# Build — rag-worker → rag-api failure payload contract alignment',
  '',
  '## Summary of changes',
  '',
  '| # | File | Change |',
  '|---|------|--------|',
  '| 1 | apps/ai-server/rag-worker-service/main.py | Add DEFAULT_FAILURE_STAGE |',
  '<<<END-SLE-ARTIFACT>>>',
  '<<<END-SLE-OUTPUT>>>',
].join('\n');

const CODE_MAIN = 'DEFAULT_FAILURE_STAGE = "consume"\n\ndef process_document(doc):\n    return doc\n';
const CODE_TEST = 'def test_payload_carries_stage():\n    assert DEFAULT_FAILURE_STAGE == "consume"\n';

// ─── harness ─────────────────────────────────────────────────────────────────

interface SavedRecord extends ArtifactRecord {}

class RecordingArtifactRepository implements Partial<ArtifactRepository> {
  saved: SavedRecord[] = [];
  findByWorkflowRunRefAndHash(_runId: string, ref: string, hash: string): ArtifactRecord | undefined {
    return this.saved.find((r) => r.ref === ref && r.hash === hash);
  }
  save(record: ArtifactRecord): void {
    this.saved.push(record);
  }
}

function makeRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'e25-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function makeRunner(
  root: string,
  reply: string,
  repository?: RecordingArtifactRepository,
  fsOverride?: typeof import('fs').promises,
): AgentRunner {
  const provider = {
    async complete() {
      throw new Error('e25: single-turn path not expected');
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
    fsOverride,
    repository as unknown as ArtifactRepository,
  );
}

function buildCtx(root: string, outputArtifact?: { type: string; ref: string; path: string }) {
  return {
    workflowRunId: 'e25-run',
    workflowId: 'full-build',
    stepId: 'build',
    iteration: 1,
    revision: 0,
    goal: 'e25 publication integrity probe',
    projectRoot: root,
    instruction: 'Implement the fix.',
    ...(outputArtifact ? { outputArtifact } : {}),
  } as never;
}

const UNDECLARED_BUILDER_CTX: TransportContext = {
  role: 'builder',
  requiresReviewVerdict: false,
  execution: 'multi-turn',
};

// ─── 1. teaching ─────────────────────────────────────────────────────────────

test('E25.1: undeclared builder teaching — per-file blocks, repo-relative, no .sle example, complete contents rule', () => {
  const teaching = new TextualSleOutputTransport().formatInstruction(UNDECLARED_BUILDER_CTX);
  assert.ok(!teaching.includes('.sle/work/'), 'must never teach .sle/work to the builder (role-forbidden)');
  assert.ok(
    teaching.includes('one artifact block per file you created or modified'),
    'open artifact set is taught as one block per actual file',
  );
  assert.ok(
    teaching.includes('COMPLETE final contents of one real source or test'),
    'blocks are taught as complete file contents, never a plan or description',
  );
  assert.ok(teaching.includes("never a path under '.sle/' or 'docs/'"), 'forbidden prefixes named explicitly');
});

test('E25.1b: declared-path teaching is unchanged for declared steps', () => {
  const teaching = new TextualSleOutputTransport().formatInstruction({
    role: 'facilitator',
    requiresReviewVerdict: false,
    execution: 'multi-turn',
    declaredArtifactId: 'cycle_charter',
    declaredOutputPath: 'docs/cycle-charter.md',
    expectedArtifacts: 1,
  });
  assert.ok(teaching.includes('path="docs/cycle-charter.md"'), 'declared example intact');
  assert.ok(!teaching.includes('per file you created or modified'), 'per-file teaching is undeclared-only');
  assert.ok(teaching.includes('Never emit more than one artifact block.'), 'single-artifact rule intact');
});

// ─── 2. the exact attempt-16 envelope fails closed ───────────────────────────

test('E25.2: attempt-16 envelope replay — role-dropped section fails the step, nothing written, diagnostic carries the warning', async () => {
  const { root, cleanup } = makeRoot();
  try {
    const runner = makeRunner(root, ATTEMPT16_ENVELOPE);
    const result = await runner.run('builder', buildCtx(root));
    assert.equal(result.success, false, 'a zero-usable-output step must NOT succeed');
    assert.match(result.error!, /no usable output sections/);
    assert.match(result.error!, /\.sle\/work\/wi-define-108-a8\/implementation\.md/, 'diagnostic names the dropped path');
    assert.match(result.error!, /not permitted/, 'diagnostic carries the parser warning');
    assert.equal(result.artifacts_written.length, 0);
    assert.ok(!existsSync(join(root, '.sle', 'work', 'wi-define-108-a8', 'implementation.md')), 'nothing materialized');
  } finally {
    cleanup();
  }
});

// ─── 3. permitted multi-file artifact: materialize + report + provenance ─────

test('E25.3: two permitted code/test files materialize byte-exact, reported accurately, hashed provenance recorded', async () => {
  const { root, cleanup } = makeRoot();
  const repository = new RecordingArtifactRepository();
  const reply = [
    '<<<SLE-OUTPUT>>>',
    '<<<SLE-ARTIFACT path="apps/ai-server/rag-worker-service/main.py">>>',
    CODE_MAIN.trimEnd(),
    '<<<END-SLE-ARTIFACT>>>',
    '<<<SLE-ARTIFACT path="apps/ai-server/tests/integration/test_failure_payload.py">>>',
    CODE_TEST.trimEnd(),
    '<<<END-SLE-ARTIFACT>>>',
    '<<<END-SLE-OUTPUT>>>',
  ].join('\n');
  try {
    const runner = makeRunner(root, reply, repository);
    const result = await runner.run('builder', buildCtx(root));
    assert.equal(result.success, true, result.error);
    assert.deepEqual(
      [...result.artifacts_written].sort(),
      [
        'apps/ai-server/rag-worker-service/main.py',
        'apps/ai-server/tests/integration/test_failure_payload.py',
      ],
      'artifacts_written reports exactly the produced set',
    );
    const mainOnDisk = readFileSync(join(root, 'apps/ai-server/rag-worker-service/main.py'), 'utf-8');
    const testOnDisk = readFileSync(
      join(root, 'apps/ai-server/tests/integration/test_failure_payload.py'),
      'utf-8',
    );
    assert.ok(mainOnDisk.includes('DEFAULT_FAILURE_STAGE'), 'code file on disk');
    assert.ok(testOnDisk.includes('test_payload_carries_stage'), 'test file on disk');
    assert.equal(repository.saved.length, 2, 'one provenance row per produced file');
    const byRef = new Map(repository.saved.map((r) => [r.ref, r]));
    for (const [p, content] of [
      ['apps/ai-server/rag-worker-service/main.py', mainOnDisk],
      ['apps/ai-server/tests/integration/test_failure_payload.py', testOnDisk],
    ] as const) {
      const row = byRef.get(`produced-file:${p}`);
      assert.ok(row, `provenance row for ${p}`);
      assert.equal(row!.type, 'produced-file');
      assert.equal(row!.path, p);
      assert.equal(row!.hash, createHash('sha256').update(content).digest('hex'), 'hash matches disk bytes');
    }
  } finally {
    cleanup();
  }
});

// ─── 4. declared single-output behavior unchanged ────────────────────────────

test('E25.4: declared single-output step — recording unchanged, no produced-file rows', async () => {
  const { root, cleanup } = makeRoot();
  const repository = new RecordingArtifactRepository();
  const reply = [
    '<<<SLE-OUTPUT>>>',
    '<<<SLE-ARTIFACT path="docs/cycle-charter.md">>>',
    '## Scope\ns\n\n## Purpose\np',
    '<<<END-SLE-ARTIFACT>>>',
    '<<<END-SLE-OUTPUT>>>',
  ].join('\n');
  try {
    const runner = makeRunner(root, reply, repository);
    const result = await runner.run(
      'facilitator',
      buildCtx(root, { type: 'cycle-charter', ref: 'doc:cycle-charter', path: 'docs/cycle-charter.md' }),
    );
    assert.equal(result.success, true, result.error);
    assert.deepEqual(result.artifacts_written, ['docs/cycle-charter.md']);
    assert.equal(repository.saved.length, 1, 'exactly the declared-output row');
    assert.equal(repository.saved[0].type, 'cycle-charter');
    assert.equal(repository.saved[0].ref, 'doc:cycle-charter');
    assert.ok(existsSync(join(root, 'docs/cycle-charter.md')));
  } finally {
    cleanup();
  }
});

// ─── 5. publication integrity: a write that did not land fails the step ──────

test('E25.5: reported write missing on disk (or wrong size) is a publication-integrity failure', async () => {
  const { root, cleanup } = makeRoot();
  const reply = [
    '<<<SLE-OUTPUT>>>',
    '<<<SLE-ARTIFACT path="apps/ai-server/rag-worker-service/main.py">>>',
    CODE_MAIN.trimEnd(),
    '<<<END-SLE-ARTIFACT>>>',
    '<<<END-SLE-OUTPUT>>>',
  ].join('\n');
  // fs wrapper whose writeFile silently no-ops — the step must fail closed.
  const blackHoleFs = new Proxy(fsPromises, {
    get(target, prop, receiver) {
      if (prop === 'writeFile') return async () => undefined;
      return Reflect.get(target, prop, receiver);
    },
  }) as typeof import('fs').promises;
  try {
    const runner = makeRunner(root, reply, undefined, blackHoleFs);
    const result = await runner.run('builder', buildCtx(root));
    assert.equal(result.success, false, 'a phantom write must not be reported as success');
    assert.match(result.error!, /publication integrity failure/);
  } finally {
    cleanup();
  }
});
