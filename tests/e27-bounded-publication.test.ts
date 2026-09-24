// E27 — protected TEST artifacts + bounded source-edit publication.
//
// Zero-model qualification per the post-A18 ruling. Fixtures derive from
// attempt 18: TEST's original contract-test artifact (24,350 B,
// sha256 b3b30497…) was overwritten by BUILD's narrower replacement
// (20,284 B, sha256 6b026ca9…), and BUILD published no worker-side fix
// because E23 had elided the 96 KB source before synthesis.
//
// Scenarios (ruling §D):
//   1. TEST publishes its regression test; the provenance row pins the hash.
//   2. BUILD cannot overwrite the protected test — pre-write rejection, no
//      partial publication, TEST's bytes untouched on disk.
//   3. A valid bounded source edit applies against the pinned worker file.
//   4. A stale base hash fails without modifying the tree.
//   5. A conflicting patch fails without publication.
//   6. rag-api (denied prefix) is rejected.
//   7. Malformed / unauthorized paths remain rejected.
//   8. Success returns affected paths + verified hashes.
//   9. A changeset with no authorized source change cannot complete BUILD.
//  10. E21/E22/E23/E25/E26 suites remain green outside the integration
//      points (verified by the full `npm run verify` run).
//  P1. All validation happens BEFORE any write: a later invalid patch leaves
//      the tree untouched.
//  P2. A disk error mid-write is NOT claimed transactional: the step fails
//      with the exact partial-publication evidence.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { AgentRunner, type AgentRunnerConfig } from '../src/agent-runner.js';
import type { RunArtifactManager } from '../src/run-artifacts.js';
import type { ArtifactRepository, ArtifactRecord } from '../src/storage/repositories.js';
import { ContextManager, DEFAULT_CONFIG } from '../src/context-manager.js';
import { WorkflowEngine, registerWorkflow } from '../src/workflow/index.js';
import type { WorkflowEngineDeps } from '../src/workflow/index.js';

// Engine harness for the step-scoping tests: captures every StepRunContext
// handed to the stub step runner, keyed by step id (the same stub shape as
// tests/workflow-engine.test.ts).
function scopeCapturingDeps(captured: Map<string, { editPolicy?: unknown }>): WorkflowEngineDeps {
  return {
    stepRunner: {
      run: async (step: { id: string }, stepCtx: { editPolicy?: unknown }) => {
        captured.set(step.id, stepCtx);
        return { success: true, artifacts_written: [], tokens_used: 0, duration_ms: 1 };
      },
    } as unknown as WorkflowEngineDeps['stepRunner'],
    mapManager: {
      read: async () => ({ cycle: { iteration: 1, max_iterations: 3 } }),
      update: async () => {},
    } as unknown as WorkflowEngineDeps['mapManager'],
    runArtifacts: {
      updateNodeStatus: async () => {},
      createRunDir: async () => {},
      createManifest: async () => {},
    } as unknown as WorkflowEngineDeps['runArtifacts'],
    projectRoot: '/tmp',
  };
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

// attempt-18 fixture: TEST's original suite, condensed to a stable marker.
const TEST_SUITE_ORIGINAL = '"""TEST original regression suite (attempt-18 fixture)."""\n\ndef test_seam():\n    assert True\n';
const TEST_SUITE_NARROWER = '"""BUILD narrower replacement (the overwrite that must never happen)."""\n';

const WORKER_PATH = 'apps/ai-server/rag-worker-service/main.py';
const WORKER_ORIGINAL = 'DEFAULT_FAILURE_STAGE = "consume"\n\n\ndef process_document(doc):\n    return doc\n';
const WORKER_PATCH = [
  `--- a/${WORKER_PATH}`,
  `+++ b/${WORKER_PATH}`,
  '@@ -1,5 +1,6 @@',
  ' DEFAULT_FAILURE_STAGE = "consume"',
  '+FAILURE_STAGE_FALLBACK = "processing"',
  ' ',
  ' ',
  ' def process_document(doc):',
  '     return doc',
].join('\n') + '\n';
const WORKER_PATCHED =
  'DEFAULT_FAILURE_STAGE = "consume"\nFAILURE_STAGE_FALLBACK = "processing"\n\n\ndef process_document(doc):\n    return doc\n';

function envelope(sections: Array<{ path: string; content: string }>, patches: Array<{ path: string; base: string; diff: string }> = []): string {
  const parts = [
    ...sections.map((s) => `<<<SLE-ARTIFACT path="${s.path}">>>\n${s.content.trimEnd()}\n<<<END-SLE-ARTIFACT>>>`),
    ...patches.map((p) => `<<<SLE-PATCH path="${p.path}" base="${p.base}">>>\n${p.diff.trimEnd()}\n<<<END-SLE-PATCH>>>`),
  ];
  return `<<<SLE-OUTPUT>>>\n${parts.join('\n')}\n<<<END-SLE-OUTPUT>>>`;
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
  latestHashForPath(runId: string, path: string): string | undefined {
    const rows = this.saved.filter((r) => r.workflowRunId === runId && r.path === path);
    return rows.length ? rows[rows.length - 1].hash : undefined;
  }
}

function makeRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'e27-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

interface RunnerOpts {
  repository: RecordingArtifactRepository;
  stepId: string;
  runId?: string;
  fsOverride?: typeof import('fs').promises;
}

function makeRunner(root: string, reply: string, opts: RunnerOpts): AgentRunner {
  const provider = {
    async complete() { throw new Error('e27: single-turn path not expected'); },
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
    opts.fsOverride,
    opts.repository as unknown as ArtifactRepository,
  );
}

function ctx(root: string, opts: RunnerCtxOpts) {
  return {
    workflowRunId: opts.runId ?? 'e27-run',
    workflowId: 'full-build',
    stepId: opts.stepId,
    iteration: 1,
    revision: 0,
    goal: 'e27 bounded publication probe',
    projectRoot: root,
    instruction: 'Publish.',
    ...(opts.authorizedOutputs ? { authorizedOutputs: opts.authorizedOutputs } : {}),
    ...(opts.editPolicy ? { editPolicy: opts.editPolicy } : {}),
  } as never;
}

interface RunnerCtxOpts {
  stepId: string;
  runId?: string;
  authorizedOutputs?: string[];
  // E27r — task-scoped edit authorization (exact paths), threaded the way
  // the engine threads resolvedParameters.editPolicy.
  editPolicy?: { allowedEditPaths: string[]; requiredEditPaths: string[] };
}

// ─── 1+2. TEST ownership ─────────────────────────────────────────────────────

test('E27.1: TEST publishes its regression suite; the provenance row pins the exact hash', async () => {
  const { root, cleanup } = makeRoot();
  const repository = new RecordingArtifactRepository();
  const reply = envelope([{ path: 'apps/ai-server/tests/integration/test_seam.py', content: TEST_SUITE_ORIGINAL }]);
  try {
    const result = await makeRunner(root, reply, { repository, stepId: 'test' }).run('tester', ctx(root, { stepId: 'test', authorizedOutputs: ['apps/ai-server/tests/'] }));
    assert.equal(result.success, true, result.error);
    assert.equal(repository.latestHashForPath('e27-run', 'apps/ai-server/tests/integration/test_seam.py'), sha256(TEST_SUITE_ORIGINAL.trimEnd()));
  } finally {
    cleanup();
  }
});

test('E27.2: BUILD cannot overwrite the protected TEST artifact — rejected pre-write, tree untouched', async () => {
  const { root, cleanup } = makeRoot();
  const repository = new RecordingArtifactRepository();
  const testPath = 'apps/ai-server/tests/integration/test_seam.py';
  // TEST publishes first.
  await makeRunner(root, envelope([{ path: testPath, content: TEST_SUITE_ORIGINAL }]), { repository, stepId: 'test' })
    .run('tester', ctx(root, { stepId: 'test', authorizedOutputs: ['apps/ai-server/tests/'] }));
  // BUILD ships its narrower replacement PLUS an innocent new file.
  const buildReply = envelope([
    { path: testPath, content: TEST_SUITE_NARROWER },
    { path: 'apps/ai-server/rag-worker-service/new_helper.py', content: 'VALUE = 1\n' },
  ]);
  try {
    const result = await makeRunner(root, buildReply, { repository, stepId: 'build' }).run('builder', ctx(root, { stepId: 'build' }));
    assert.equal(result.success, false);
    assert.match(result.error!, /Protected artifact conflict/);
    assert.match(result.error!, /published by step 'test'/);
    // nothing was written — the innocent file must not have landed either
    assert.ok(!existsSync(join(root, 'apps/ai-server/rag-worker-service/new_helper.py')), 'no partial publication');
    // TEST's bytes are untouched on disk
    assert.equal(readFileSync(join(root, testPath), 'utf-8'), TEST_SUITE_ORIGINAL.trimEnd());
  } finally {
    cleanup();
  }
});

// ─── 3+8. valid bounded source edit ──────────────────────────────────────────

test('E27.3+8: a valid patch applies against the pinned worker file; result hashes are recorded and verified', async () => {
  const { root, cleanup } = makeRoot();
  const repository = new RecordingArtifactRepository();
  mkdirSync(join(root, 'apps/ai-server/rag-worker-service'), { recursive: true });
  writeFileSync(join(root, WORKER_PATH), WORKER_ORIGINAL);
  const reply = envelope([], [{ path: WORKER_PATH, base: sha256(WORKER_ORIGINAL), diff: WORKER_PATCH }]);
  try {
    const result = await makeRunner(root, reply, { repository, stepId: 'build' })
      .run('builder', ctx(root, { stepId: 'build', editPolicy: { allowedEditPaths: [WORKER_PATH], requiredEditPaths: [WORKER_PATH] } }));
    assert.equal(result.success, true, result.error);
    assert.equal(readFileSync(join(root, WORKER_PATH), 'utf-8'), WORKER_PATCHED);
    assert.deepEqual(result.artifacts_written, [WORKER_PATH]);
    assert.equal(result.patches_applied!.length, 1);
    assert.equal(result.patches_applied![0].path, WORKER_PATH);
    assert.equal(result.patches_applied![0].base_hash, sha256(WORKER_ORIGINAL));
    assert.equal(result.patches_applied![0].result_hash, sha256(WORKER_PATCHED));
    const row = repository.saved.find((r) => r.type === 'applied-patch');
    assert.ok(row, 'applied-patch provenance row recorded');
    assert.equal(row!.hash, sha256(WORKER_PATCHED));
    assert.ok(row!.ref!.startsWith('applied-patch:build:'));
  } finally {
    cleanup();
  }
});

// ─── 4+5. stale base / conflicting context ───────────────────────────────────

test('E27.4: a stale base hash fails without modifying the working tree', async () => {
  const { root, cleanup } = makeRoot();
  mkdirSync(join(root, 'apps/ai-server/rag-worker-service'), { recursive: true });
  writeFileSync(join(root, WORKER_PATH), WORKER_ORIGINAL);
  const staleBase = sha256('not the file on disk');
  const reply = envelope([], [{ path: WORKER_PATH, base: staleBase, diff: WORKER_PATCH }]);
  try {
    const result = await makeRunner(root, reply, { repository: new RecordingArtifactRepository(), stepId: 'build' })
      .run('builder', ctx(root, { stepId: 'build' }));
    assert.equal(result.success, false);
    assert.match(result.error!, /stale/);
    assert.equal(readFileSync(join(root, WORKER_PATH), 'utf-8'), WORKER_ORIGINAL, 'tree untouched');
  } finally {
    cleanup();
  }
});

test('E27.5: a conflicting patch (context mismatch) fails without publication', async () => {
  const { root, cleanup } = makeRoot();
  const repository = new RecordingArtifactRepository();
  mkdirSync(join(root, 'apps/ai-server/rag-worker-service'), { recursive: true });
  writeFileSync(join(root, WORKER_PATH), WORKER_ORIGINAL);
  const conflicting = WORKER_PATCH.replace(' DEFAULT_FAILURE_STAGE = "consume"\n', ' DEFAULT_FAILURE_STAGE = "consume-v2"\n');
  const reply = envelope([], [{ path: WORKER_PATH, base: sha256(WORKER_ORIGINAL), diff: conflicting }]);
  try {
    const result = await makeRunner(root, reply, { repository, stepId: 'build' }).run('builder', ctx(root, { stepId: 'build' }));
    assert.equal(result.success, false);
    assert.match(result.error!, /does not apply/);
    assert.equal(readFileSync(join(root, WORKER_PATH), 'utf-8'), WORKER_ORIGINAL);
  } finally {
    cleanup();
  }
});

// ─── 6+7. scope enforcement ──────────────────────────────────────────────────

test('E27.6: a patch targeting rag-api (denied prefix) is rejected', async () => {
  const { root, cleanup } = makeRoot();
  const ragApiPath = 'apps/ai-server/rag-api-service/main.py';
  mkdirSync(join(root, 'apps/ai-server/rag-api-service'), { recursive: true });
  writeFileSync(join(root, ragApiPath), 'def run_transactional_update():\n    pass\n');
  const diff = [
    `--- a/${ragApiPath}`,
    `+++ b/${ragApiPath}`,
    '@@ -1,2 +1,3 @@',
    ' def run_transactional_update():',
    '+    raise AssertionError()',
    '     pass',
  ].join('\n') + '\n';
  const reply = envelope([], [{ path: ragApiPath, base: sha256('def run_transactional_update():\n    pass\n'), diff }]);
  try {
    const result = await makeRunner(root, reply, {
      repository: new RecordingArtifactRepository(), stepId: 'build',
    }).run('builder', ctx(root, { stepId: 'build', editPolicy: { allowedEditPaths: [WORKER_PATH], requiredEditPaths: [WORKER_PATH] } }));
    assert.equal(result.success, false);
    assert.match(result.error!, /outside this task's authorized edit set/);
    assert.equal(readFileSync(join(root, ragApiPath), 'utf-8'), 'def run_transactional_update():\n    pass\n');
  } finally {
    cleanup();
  }
});

test('E27.7: malformed and unauthorized patch paths remain rejected', async () => {
  const { root, cleanup } = makeRoot();
  // '.sle/…' is unsafe/forbidden for the builder even via patch
  const replySle = envelope([], [{ path: '.sle/work/impl.py', base: sha256('x'), diff: '--- a/.sle/work/impl.py\n+++ b/.sle/work/impl.py\n@@ -1,1 +1,2 @@\n x\n+y\n' }]);
  const r1 = await makeRunner(root, replySle, { repository: new RecordingArtifactRepository(), stepId: 'build' })
    .run('builder', ctx(root, { stepId: 'build' }));
  assert.equal(r1.success, false);
  assert.match(r1.error!, /not permitted|Unsafe|does not exist/);
  // tester's contract authorizes only apps/ai-server/tests/ — a patch outside fails
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src/util.py'), 'A = 1\n');
  const replyTester = envelope([], [{ path: 'src/util.py', base: sha256('A = 1\n'), diff: '--- a/src/util.py\n+++ b/src/util.py\n@@ -1,1 +1,2 @@\n A = 1\n+B = 2\n' }]);
  const r2 = await makeRunner(root, replyTester, { repository: new RecordingArtifactRepository(), stepId: 'test' })
    .run('tester', ctx(root, { stepId: 'test', requiresSourceEdit: false }));
  assert.equal(r2.success, false);
  assert.match(r2.error!, /not permitted to modify/);
  cleanup();
});

// ─── 9. no authorized source change → cannot complete ────────────────────────

test('E27.9: BUILD cannot complete on a byte-identical protected republication — no source change published', async () => {
  const { root, cleanup } = makeRoot();
  const repository = new RecordingArtifactRepository();
  const testPath = 'apps/ai-server/tests/integration/test_seam.py';
  await makeRunner(root, envelope([{ path: testPath, content: TEST_SUITE_ORIGINAL }]), { repository, stepId: 'test' })
    .run('tester', ctx(root, { stepId: 'test', authorizedOutputs: ['apps/ai-server/tests/'] }));
  // BUILD re-ships TEST's file byte-identical and nothing else.
  const reply = envelope([{ path: testPath, content: TEST_SUITE_ORIGINAL }]);
  try {
    const result = await makeRunner(root, reply, { repository, stepId: 'build' })
      .run('builder', ctx(root, { stepId: 'build', editPolicy: { allowedEditPaths: [WORKER_PATH], requiredEditPaths: [WORKER_PATH] } }));
    assert.equal(result.success, false);
    // the edit policy rejects the out-of-scope section before anything else:
    // byte-identical or not, TEST's file is not in BUILD's edit set
    assert.match(result.error!, /outside this task's authorized edit set/);
    assert.equal(result.artifacts_written.length, 0);
  } finally {
    cleanup();
  }
});

// ─── P1+P2. partial-failure behavior ─────────────────────────────────────────

test('E27.P1: a later invalid patch prevents ALL writes — validation fully precedes publication', async () => {
  const { root, cleanup } = makeRoot();
  mkdirSync(join(root, 'apps/ai-server/rag-worker-service'), { recursive: true });
  writeFileSync(join(root, WORKER_PATH), WORKER_ORIGINAL);
  const reply = envelope(
    [{ path: 'apps/ai-server/rag-worker-service/new_helper.py', content: 'VALUE = 1\n' }],
    [{ path: WORKER_PATH, base: sha256('stale'), diff: WORKER_PATCH }],
  );
  try {
    const result = await makeRunner(root, reply, { repository: new RecordingArtifactRepository(), stepId: 'build' })
      .run('builder', ctx(root, { stepId: 'build' }));
    assert.equal(result.success, false);
    assert.match(result.error!, /stale/);
    assert.ok(!existsSync(join(root, 'apps/ai-server/rag-worker-service/new_helper.py')), 'the valid section was NOT written');
    assert.equal(readFileSync(join(root, WORKER_PATH), 'utf-8'), WORKER_ORIGINAL);
  } finally {
    cleanup();
  }
});

test('E27.P2: a disk error mid-write fails explicitly with complete partial-publication evidence — no transactional claim', async () => {
  const { root, cleanup } = makeRoot();
  const fileA = 'apps/ai-server/rag-worker-service/a.py';
  const fileB = 'apps/ai-server/rag-worker-service/b.py';
  const failingFs = new Proxy(fsPromises, {
    get(target, prop, receiver) {
      if (prop === 'writeFile') {
        return async (p: unknown, data: unknown, o: unknown) => {
          if (String(p).endsWith('b.py')) throw new Error('EIO simulated disk failure');
          return Reflect.get(target, 'writeFile', receiver).call(target, p, data, o);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as typeof import('fs').promises;
  const reply = envelope([
    { path: fileA, content: 'A = 1\n' },
    { path: fileB, content: 'B = 2\n' },
  ]);
  try {
    const result = await makeRunner(root, reply, { repository: new RecordingArtifactRepository(), stepId: 'build', fsOverride: failingFs })
      .run('builder', ctx(root, { stepId: 'build' }));
    assert.equal(result.success, false);
    assert.match(result.error!, /NOT rolled back/);
    assert.match(result.error!, new RegExp(fileA));
    assert.match(result.error!, new RegExp(fileB));
    // fileA really is on disk (partial publication honestly reported)
    assert.ok(existsSync(join(root, fileA)));
  } finally {
    cleanup();
  }
});

// ─── E27r (merge review) — task-scoped edit authorization ────────────────────

test('E27.R1: an adjacent new file cannot dodge the required edit — and is not published', async () => {
  const { root, cleanup } = makeRoot();
  mkdirSync(join(root, 'apps/ai-server/rag-worker-service'), { recursive: true });
  writeFileSync(join(root, WORKER_PATH), WORKER_ORIGINAL);
  // The old weak formulation counted ANY new non-docs file as a "source
  // change": BUILD could ship helper.py and leave main.py untouched. The
  // edit policy must reject the section pre-write AND fail the required edit.
  const reply = envelope([{ path: 'apps/ai-server/rag-worker-service/helper.py', content: 'VALUE = 1\n' }]);
  try {
    const result = await makeRunner(root, reply, { repository: new RecordingArtifactRepository(), stepId: 'build' })
      .run('builder', ctx(root, { stepId: 'build', editPolicy: { allowedEditPaths: [WORKER_PATH], requiredEditPaths: [WORKER_PATH] } }));
    assert.equal(result.success, false);
    assert.match(result.error!, /outside this task's authorized edit set/);
    assert.ok(!existsSync(join(root, 'apps/ai-server/rag-worker-service/helper.py')), 'no out-of-scope publication');
    assert.equal(readFileSync(join(root, WORKER_PATH), 'utf-8'), WORKER_ORIGINAL);
  } finally {
    cleanup();
  }
});

// ─── E27r (merge review) — legacy artifact restore + ownership ───────────────

test('E27.R2: a restored attempt-18 TEST artifact seeded through E27 ownership is protected', async () => {
  const { root, cleanup } = makeRoot();
  const repository = new RecordingArtifactRepository();
  const testPath = 'apps/ai-server/tests/integration/test_seam.py';
  // What the driver's restore-test-artifact operation does: restore the
  // archived ORIGINAL bytes and insert an owned-by-test provenance row in
  // E27's produced-file:<stepId>:<path> format — because attempt 18's own
  // provenance predates E27 and confers no ownership.
  const originalHash = sha256(TEST_SUITE_ORIGINAL.trimEnd());
  repository.save({
    id: 'art-a18-test-restore', workItemId: 'wi-exec-108',
    workflowRunId: 'e27-run', type: 'produced-file',
    ref: `produced-file:test:${testPath}`, path: testPath, hash: originalHash,
    createdAt: new Date().toISOString(),
  });
  mkdirSync(join(root, 'apps/ai-server/tests/integration'), { recursive: true });
  writeFileSync(join(root, testPath), TEST_SUITE_ORIGINAL.trimEnd());
  // BUILD ships a narrower replacement for the restored artifact.
  const reply = envelope([{ path: testPath, content: TEST_SUITE_NARROWER }]);
  try {
    const result = await makeRunner(root, reply, { repository, stepId: 'build' }).run('builder', ctx(root, { stepId: 'build' }));
    assert.equal(result.success, false);
    assert.match(result.error!, /Protected artifact conflict/);
    assert.match(result.error!, /published by step 'test'/);
    // the restored ORIGINAL bytes are untouched on disk
    assert.equal(readFileSync(join(root, testPath), 'utf-8'), TEST_SUITE_ORIGINAL.trimEnd());
  } finally {
    cleanup();
  }
});

test('E27.R3: a legacy-format provenance row alone does NOT protect — the restore op must seed E27 ownership', async () => {
  const { root, cleanup } = makeRoot();
  const repository = new RecordingArtifactRepository();
  const testPath = 'apps/ai-server/tests/integration/test_seam.py';
  // attempt 18 recorded produced-file:<path> (no stepId). ownedByOther()
  // cannot recognize ownership from this format — which is exactly why the
  // continuation must run the explicit restore operation instead of merely
  // keeping the old rows. This test pins that gap as documented behavior.
  repository.save({
    id: 'art-a18-legacy', workItemId: 'wi-exec-108',
    workflowRunId: 'e27-run', type: 'produced-file',
    ref: `produced-file:${testPath}`, path: testPath, hash: sha256(TEST_SUITE_ORIGINAL.trimEnd()),
    createdAt: new Date().toISOString(),
  });
  mkdirSync(join(root, 'apps/ai-server/tests/integration'), { recursive: true });
  writeFileSync(join(root, testPath), TEST_SUITE_ORIGINAL.trimEnd());
  const reply = envelope([{ path: testPath, content: TEST_SUITE_NARROWER }]);
  try {
    const result = await makeRunner(root, reply, { repository, stepId: 'build' }).run('builder', ctx(root, { stepId: 'build' }));
    // the overwrite SUCCEEDS without E27 ownership — the gap is real
    assert.equal(result.success, true, result.error);
    assert.equal(readFileSync(join(root, testPath), 'utf-8'), TEST_SUITE_NARROWER.trimEnd());
  } finally {
    cleanup();
  }
});

// ─── E27r round 2 — step-scoped policy + current-run ownership ───────────────

test('E27.R4: the edit policy binds ONLY its declared steps — upstream producers unaffected, build receives it', async () => {
  const captured = new Map<string, { editPolicy?: unknown }>();
  registerWorkflow({
    id: 'e27r-scope-wf', label: 'E27R scope',
    steps: (['design', 'plan', 'test', 'build'] as const).map((id) => ({ id, kind: 'produce' as const })),
  });
  const engine = new WorkflowEngine(scopeCapturingDeps(captured), { onCheckpoint: async () => 'approve' });
  const policy = { appliesToSteps: ['build'], allowedEditPaths: [WORKER_PATH], requiredEditPaths: [WORKER_PATH] };
  await engine.run('e27r-scope-wf', 'e27r-run', 'scope probe', undefined, 'wi-e27r', undefined, { editPolicy: policy });
  assert.equal(captured.get('design')!.editPolicy, undefined, 'DESIGN must be unaffected');
  assert.equal(captured.get('plan')!.editPolicy, undefined, 'PLAN must be unaffected');
  assert.equal(captured.get('test')!.editPolicy, undefined, 'TEST must be unaffected');
  assert.deepEqual(captured.get('build')!.editPolicy, policy, 'BUILD receives the exact task policy');
});

test('E27.R4b: malformed edit policies fail at dispatch — never a silently weaker policy', async () => {
  const runWith = async (params: unknown): Promise<void> => {
    registerWorkflow({
      id: 'e27r-malformed-wf', label: 'E27R malformed',
      steps: [{ id: 'build', kind: 'produce' }],
    });
    const engine = new WorkflowEngine(scopeCapturingDeps(new Map()), { onCheckpoint: async () => 'approve' });
    await engine.run('e27r-malformed-wf', 'e27r-run', 'g', undefined, undefined, undefined, params as Record<string, unknown>);
  };
  // null is malformed; only undefined means genuinely absent
  await assert.rejects(() => runWith({ editPolicy: null }), /Invalid workflowParameters\.editPolicy/);
  await assert.rejects(() => runWith({ editPolicy: 'worker-only' }), /Invalid workflowParameters\.editPolicy/);
  // missing / empty appliesToSteps
  await assert.rejects(
    () => runWith({ editPolicy: { allowedEditPaths: [WORKER_PATH], requiredEditPaths: [WORKER_PATH] } }),
    /appliesToSteps/,
  );
  await assert.rejects(
    () => runWith({ editPolicy: { appliesToSteps: [], allowedEditPaths: [WORKER_PATH], requiredEditPaths: [] } }),
    /appliesToSteps/,
  );
  // empty allowed set
  await assert.rejects(
    () => runWith({ editPolicy: { appliesToSteps: ['build'], allowedEditPaths: [], requiredEditPaths: [] } }),
    /allowedEditPaths/,
  );
  // required must be a subset of allowed
  await assert.rejects(
    () => runWith({ editPolicy: { appliesToSteps: ['build'], allowedEditPaths: [WORKER_PATH], requiredEditPaths: ['other.py'] } }),
    /subset/,
  );
  // unsafe and duplicate paths
  await assert.rejects(
    () => runWith({ editPolicy: { appliesToSteps: ['build'], allowedEditPaths: ['../escape.py'], requiredEditPaths: [] } }),
    /unsafe/,
  );
  await assert.rejects(
    () => runWith({ editPolicy: { appliesToSteps: ['build'], allowedEditPaths: [WORKER_PATH, WORKER_PATH], requiredEditPaths: [] } }),
    /duplicate/,
  );
  // genuinely absent → no policy anywhere
  const captured = new Map<string, { editPolicy?: unknown }>();
  registerWorkflow({
    id: 'e27r-absent-wf', label: 'E27R absent',
    steps: [{ id: 'build', kind: 'produce' }],
  });
  await new WorkflowEngine(scopeCapturingDeps(captured), { onCheckpoint: async () => 'approve' })
    .run('e27r-absent-wf', 'e27r-run', 'g', undefined, undefined, undefined, {});
  assert.equal(captured.get('build')!.editPolicy, undefined, 'absent policy stays absent');
});

test('E27.R4c: an appliesToSteps typo fails at dispatch BEFORE any step runs — never a silently unpolicied run', async () => {
  // 'buid' is not a step of the workflow. Without this check every real step
  // would receive editPolicy === undefined — the boundary would vanish on a
  // typo. The run must reject before the first step-runner invocation.
  const captured = new Map<string, { editPolicy?: unknown }>();
  registerWorkflow({
    id: 'e27r-typo-wf', label: 'E27R typo',
    steps: [{ id: 'design', kind: 'produce' }, { id: 'build', kind: 'produce' }],
  });
  const engine = new WorkflowEngine(scopeCapturingDeps(captured), { onCheckpoint: async () => 'approve' });
  await assert.rejects(
    () => engine.run('e27r-typo-wf', 'e27r-run', 'g', undefined, undefined, undefined, {
      editPolicy: {
        appliesToSteps: ['buid'],
        allowedEditPaths: [WORKER_PATH],
        requiredEditPaths: [WORKER_PATH],
      },
    }),
    /unknown workflow step 'buid'/,
  );
  assert.equal(captured.size, 0, 'no step runner was ever invoked');
  // duplicate targets are equally rejected
  registerWorkflow({
    id: 'e27r-dup-target-wf', label: 'E27R dup target',
    steps: [{ id: 'build', kind: 'produce' }],
  });
  await assert.rejects(
    () => new WorkflowEngine(scopeCapturingDeps(new Map()), { onCheckpoint: async () => 'approve' }).run(
      'e27r-dup-target-wf', 'e27r-run', 'g', undefined, undefined, undefined,
      { editPolicy: { appliesToSteps: ['build', 'build'], allowedEditPaths: [WORKER_PATH], requiredEditPaths: [] } },
    ),
    /duplicate step id 'build'/,
  );
});

test('E27.R5: restored ownership protects in the CURRENT run — attempt-18 rows are a different provenance scope', async () => {
  const { root, cleanup } = makeRoot();
  const repository = new RecordingArtifactRepository();
  const testPath = 'apps/ai-server/tests/integration/test_seam.py';
  const originalHash = sha256(TEST_SUITE_ORIGINAL.trimEnd());
  // Attempt 18's historical scope: legacy-format TEST row + BUILD's later
  // replacement row — the two-hashes-for-one-path situation from the review.
  // These rows belong to a DIFFERENT run and must never protect attempt 19
  // (nor be mutated by the restore op).
  repository.save({ id: 'a18-legacy', workflowRunId: 'a18-run', type: 'produced-file', ref: `produced-file:${testPath}`, path: testPath, hash: originalHash, createdAt: '2026-09-23T12:51:34Z' });
  repository.save({ id: 'a18-build', workflowRunId: 'a18-run', type: 'produced-file', ref: `produced-file:build:${testPath}`, path: testPath, hash: sha256(TEST_SUITE_NARROWER.trimEnd()), createdAt: '2026-09-23T13:02:41Z' });
  // Attempt 19's CURRENT run: the restore op seeds the ORIGINAL TEST bytes
  // with test ownership HERE. A historical row alone would protect nothing.
  repository.save({ id: 'restore-row', workflowRunId: 'a19-run', type: 'produced-file', ref: `produced-file:test:${testPath}`, path: testPath, hash: originalHash, createdAt: '2026-09-23T14:00:00Z' });
  mkdirSync(join(root, 'apps/ai-server/tests/integration'), { recursive: true });
  writeFileSync(join(root, testPath), TEST_SUITE_ORIGINAL.trimEnd());
  const reply = envelope([{ path: testPath, content: TEST_SUITE_NARROWER }]);
  try {
    const result = await makeRunner(root, reply, { repository, stepId: 'build' })
      .run('builder', ctx(root, { stepId: 'build', runId: 'a19-run' }));
    assert.equal(result.success, false);
    assert.match(result.error!, /Protected artifact conflict/);
    assert.match(result.error!, /published by step 'test'/);
    // protected BEFORE any write: the restored original bytes are untouched
    assert.equal(readFileSync(join(root, testPath), 'utf-8'), TEST_SUITE_ORIGINAL.trimEnd());
    // attempt 18's historical rows remain untouched evidence (2 rows, incl.
    // BUILD's replacement — tolerated, never mutated)
    assert.equal(repository.saved.filter((r) => r.workflowRunId === 'a18-run').length, 2);
  } finally {
    cleanup();
  }
});

test('E27.R6: ownership resolves to the LATEST row per path even when created_at ties', async () => {
  const { root, cleanup } = makeRoot();
  const repository = new RecordingArtifactRepository();
  const testPath = 'apps/ai-server/tests/integration/test_seam.py';
  // TEST publishes v1, then republishes v2 within the same millisecond:
  // the protected hash must be the later-inserted v2, never the stale v1.
  const v1 = TEST_SUITE_ORIGINAL.trimEnd();
  const v2 = v1 + '\n# iteration-2 pin\n';
  const tie = '2026-09-23T12:51:34.999Z';
  repository.save({ id: 'r6-v1', workflowRunId: 'e27-run', type: 'produced-file', ref: `produced-file:test:${testPath}`, path: testPath, hash: sha256(v1), createdAt: tie });
  repository.save({ id: 'r6-v2', workflowRunId: 'e27-run', type: 'produced-file', ref: `produced-file:test:${testPath}`, path: testPath, hash: sha256(v2), createdAt: tie });
  mkdirSync(join(root, 'apps/ai-server/tests/integration'), { recursive: true });
  writeFileSync(join(root, testPath), v2);
  const reply = envelope([{ path: testPath, content: v1 }]); // BUILD ships the STALE v1
  try {
    const result = await makeRunner(root, reply, { repository, stepId: 'build' }).run('builder', ctx(root, { stepId: 'build' }));
    assert.equal(result.success, false);
    assert.match(result.error!, /Protected artifact conflict/);
    // the conflict is against v2 (the latest), not v1
    assert.match(result.error!, new RegExp(sha256(v2).slice(0, 12)));
    assert.equal(readFileSync(join(root, testPath), 'utf-8'), v2);
  } finally {
    cleanup();
  }
});
