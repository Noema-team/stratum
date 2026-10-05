// BUILD Edit Protocol v1 — runner-level integration (docs/specs/build-edit-protocol-v1.md §7(2)).
//
// Full-pipeline qualification with a scripted multi-turn provider:
// investigation turn (read_source_slice mints an anchor into the tool result)
// → submit_result proposal → in-loop acceptor → staging → publication gates
// → writes → integrity → provenance. Includes the in-loop repair path, repair
// exhaustion, cross-execution anchor rejection, the textual-patch-cannot-
// reach-the-applier pin, and legacy-path byte-invariance.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';

import { AgentRunner, type AgentRunnerConfig } from '../src/agent-runner.js';
import type { RunArtifactManager } from '../src/run-artifacts.js';
import type { ArtifactRepository, ArtifactRecord } from '../src/storage/repositories.js';
import { ContextManager, DEFAULT_CONFIG } from '../src/context-manager.js';
import type { MultiTurnResult } from '../src/agent-loop.js';
import { SUBMIT_RESULT_TOOL_NAME } from '../src/transport/step-result.js';
import {
  createBuildChangesetActionContract,
  BUILD_CHANGESET_ARTIFACT_TYPE,
} from '../src/workflow/methodology/build-changeset-contract.js';

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

const WORKER_PATH = 'apps/ai-server/rag-worker-service/main.py';
const WORKER_ORIGINAL = 'DEFAULT_FAILURE_STAGE = "consume"\n\n\ndef process_document(doc):\n    return doc\n';
const WORKER_PATCHED =
  'DEFAULT_FAILURE_STAGE = "consume"\nFAILURE_STAGE_FALLBACK = "processing"\n\n\ndef process_document(doc):\n    return doc\n';
const NEW_FILE_PATH = 'apps/ai-server/rag-worker-service/failure_payload.py';
const NEW_FILE_CONTENT = 'FAILURE_STAGE = "processing"\n';

// ─── Harness ──────────────────────────────────────────────────────────────────

function makeRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'p1-build-'));
  mkdirSync(join(root, 'apps/ai-server/rag-worker-service'), { recursive: true });
  writeFileSync(join(root, WORKER_PATH), WORKER_ORIGINAL);
  // read authority = git-tracked files (git ls-files reads the index)
  execSync('git init -q && git add -A', { cwd: root });
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
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

interface ToolUseShape { type: 'tool_use'; id: string; name: string; input: unknown }

class ScriptedProvider {
  private turn = 0;
  /** Every tool_result content block the loop sent back, in order. */
  readonly toolResultContents: string[] = [];
  readonly requests: Array<{ tools: Array<{ name: string }>; messageCount: number }> = [];
  constructor(private readonly script: MultiTurnResult[]) {}
  async complete(): Promise<never> {
    throw new Error('p1: single-turn path not expected');
  }
  async completeMultiTurn(params: {
    messages: Array<{ role: string; content: unknown }>;
    tools: ReadonlyArray<{ name: string }>;
  }): Promise<MultiTurnResult> {
    this.requests.push({ tools: params.tools.map((t) => ({ name: t.name })), messageCount: params.messages.length });
    const last = params.messages[params.messages.length - 1];
    if (last && last.role === 'user' && Array.isArray(last.content)) {
      for (const block of last.content as Array<{ type: string; content?: string }>) {
        if (block.type === 'tool_result' && typeof block.content === 'string') {
          this.toolResultContents.push(block.content);
        }
      }
    }
    return this.script[this.turn++] ?? { stop_reason: 'end_turn', text: '', tool_uses: [], tokens_used: 1 };
  }
}

function readSliceTurn(id: string, path: string, startLine = 1, lineCount = 5): MultiTurnResult {
  return {
    stop_reason: 'tool_use',
    text: '',
    tool_uses: [{ type: 'tool_use', id, name: 'read_source_slice', input: { path, startLine, lineCount } }],
    tokens_used: 7,
  };
}

function submitTurn(id: string, proposal: unknown): MultiTurnResult {
  return {
    stop_reason: 'tool_use',
    text: '',
    tool_uses: [{ type: 'tool_use', id, name: SUBMIT_RESULT_TOOL_NAME, input: proposal }],
    tokens_used: 9,
  };
}

function makeRunner(root: string, provider: ScriptedProvider, repository: RecordingArtifactRepository): AgentRunner {
  const cm = new ContextManager(root, DEFAULT_CONFIG);
  return new AgentRunner(
    cm,
    provider as never,
    root,
    { updateNodeStatus: async () => {}, writeNodeOutput: async () => {} } as unknown as RunArtifactManager,
    {
      model: 'test',
      actionContracts: { [BUILD_CHANGESET_ARTIFACT_TYPE]: createBuildChangesetActionContract() },
    } satisfies Partial<AgentRunnerConfig> as AgentRunnerConfig,
    undefined,
    repository as unknown as ArtifactRepository,
  );
}

function ctx(root: string, opts: { runId?: string; editPolicy?: { allowedEditPaths: string[]; requiredEditPaths: string[] } } = {}) {
  return {
    workflowRunId: opts.runId ?? 'p1-run',
    workflowId: 'full-build',
    stepId: 'build',
    iteration: 1,
    revision: 0,
    goal: 'p1 anchored-edit probe',
    projectRoot: root,
    instruction: 'Publish the failure-payload fix.',
    actionArtifact: { type: BUILD_CHANGESET_ARTIFACT_TYPE },
    ...(opts.editPolicy ? { editPolicy: opts.editPolicy } : {}),
  } as never;
}

/** Extract the anchor minted into the read_source_slice tool result. */
function mintedAnchor(provider: ScriptedProvider): { anchor_id: string; path: string; start_line: number; end_line: number } {
  const sliceResults = provider.toolResultContents
    .map((c) => { try { return JSON.parse(c) as Record<string, unknown>; } catch { return null; } })
    .filter((v): v is Record<string, unknown> => v !== null && typeof v.anchor === 'object');
  assert.equal(sliceResults.length >= 1, true, 'expected an anchor-augmented slice result');
  const anchor = sliceResults[0].anchor as Record<string, unknown>;
  return anchor as { anchor_id: string; path: string; start_line: number; end_line: number };
}

// ─── Happy path ───────────────────────────────────────────────────────────────

test('P1.20: investigation mints an anchor; a valid proposal publishes replace+create through every gate', async () => {
  const { root, cleanup } = makeRoot();
  const repository = new RecordingArtifactRepository();
  const provider = new ScriptedProvider([
    readSliceTurn('t1', WORKER_PATH, 1, 1),
    submitTurn('t2', {
      edits: [], // placeholder — replaced below once the expected anchor is derived
      creates: [{ path: NEW_FILE_PATH, content: NEW_FILE_CONTENT }],
    }),
  ]);
  // The anchor id is deterministic from the binding, but build the proposal
  // the way the model would: from the minted tool result. Script turn 2 with a
  // lazy proposal via a subclassing trick: simplest is to pre-compute it here.
  const registryAnchor = {
    path: WORKER_PATH,
    base_sha256: sha256(WORKER_ORIGINAL),
    start_line: 1,
    end_line: 1,
    content_sha256: sha256('DEFAULT_FAILURE_STAGE = "consume"'),
  };
  const expectedAnchorId = `src_${createHash('sha256').update(
    [registryAnchor.path, registryAnchor.base_sha256, '1', '1', registryAnchor.content_sha256].join('\0'),
    'utf8',
  ).digest('hex').slice(0, 16)}`;
  provider.script[1] = submitTurn('t2', {
    edits: [{ anchor_id: expectedAnchorId, replacement: 'DEFAULT_FAILURE_STAGE = "consume"\nFAILURE_STAGE_FALLBACK = "processing"' }],
    creates: [{ path: NEW_FILE_PATH, content: NEW_FILE_CONTENT }],
  });
  try {
    const result = await makeRunner(root, provider, repository)
      .run('builder', ctx(root, { editPolicy: { allowedEditPaths: [WORKER_PATH, NEW_FILE_PATH], requiredEditPaths: [WORKER_PATH] } }));
    assert.equal(result.success, true, result.error);

    // disk bytes exact — whitespace and untouched lines from STRATUM, not the model
    assert.equal(readFileSync(join(root, WORKER_PATH), 'utf-8'), WORKER_PATCHED);
    assert.equal(readFileSync(join(root, NEW_FILE_PATH), 'utf-8'), NEW_FILE_CONTENT);
    assert.deepEqual([...result.artifacts_written].sort(), [NEW_FILE_PATH, WORKER_PATH].sort());

    // the tool result the model saw carried the anchor
    const anchor = mintedAnchor(provider);
    assert.equal(anchor.anchor_id, expectedAnchorId);

    // run summary
    assert.equal(result.anchored_edits!.length, 2);
    const replaceRow = result.anchored_edits!.find((e) => e.op === 'replace')!;
    assert.equal(replaceRow.path, WORKER_PATH);
    assert.equal(replaceRow.anchor_id, expectedAnchorId);
    assert.equal(replaceRow.base_hash, sha256(WORKER_ORIGINAL));
    assert.equal(replaceRow.result_hash, sha256(WORKER_PATCHED));
    // the replace also rides the legacy staged-edit summary shape
    assert.equal(result.patches_applied!.length, 1);
    assert.equal(result.patches_applied![0].result_hash, sha256(WORKER_PATCHED));

    // provenance: applied-edit (mechanism-truthful) + produced-file (create)
    const appliedEdit = repository.saved.find((r) => r.type === 'applied-edit');
    assert.ok(appliedEdit, 'applied-edit provenance row recorded');
    assert.equal(appliedEdit!.ref, `applied-edit:build:${WORKER_PATH}`);
    const producedFile = repository.saved.find((r) => r.type === 'produced-file' && r.path === NEW_FILE_PATH);
    assert.ok(producedFile, 'produced-file provenance row recorded for the create');

    // evidence: anchor manifest + Stratum-generated audit diff
    const nodeDir = join(root, '.sle', 'runs', 'p1-run', '1', 'node-outputs');
    const manifest = JSON.parse(readFileSync(join(nodeDir, 'build-anchors.json'), 'utf-8'));
    assert.equal(manifest.anchors.length, 1);
    assert.equal(manifest.anchors[0].anchor_id, expectedAnchorId);
    const audit = readFileSync(join(nodeDir, 'build-anchored-diff.patch'), 'utf-8');
    assert.match(audit, /\+FAILURE_STAGE_FALLBACK = "processing"/);
    assert.match(audit, /\+FAILURE_STAGE = "processing"/);

    // submission tool was offered alongside the read tools
    const investigation = provider.requests[0];
    assert.ok(investigation.tools.some((t) => t.name === SUBMIT_RESULT_TOOL_NAME));
    assert.ok(investigation.tools.some((t) => t.name === 'read_source_slice'));
  } finally {
    cleanup();
  }
});

// ─── In-loop result repair ────────────────────────────────────────────────────

test('P1.21: an unknown anchor is rejected in-loop with a bounded repair; the corrected resubmission publishes', async () => {
  const { root, cleanup } = makeRoot();
  const repository = new RecordingArtifactRepository();
  const provider = new ScriptedProvider([
    readSliceTurn('t1', WORKER_PATH),
    submitTurn('t2', { edits: [{ anchor_id: 'src_ffffffffffffffff', replacement: 'x' }], creates: [] }),
    submitTurn('t3', { edits: [], creates: [{ path: NEW_FILE_PATH, content: NEW_FILE_CONTENT }] }),
  ]);
  try {
    const result = await makeRunner(root, provider, repository).run('builder', ctx(root));
    assert.equal(result.success, true, result.error);
    assert.equal(result.result_repairs, 1);
    // the rejection named the defect class
    assert.ok(provider.toolResultContents.some((c) => c.includes('unknown-anchor')));
    // the create landed
    assert.equal(readFileSync(join(root, NEW_FILE_PATH), 'utf-8'), NEW_FILE_CONTENT);
  } finally {
    cleanup();
  }
});

test('P1.22: repair exhaustion fails closed with nothing written', async () => {
  const { root, cleanup } = makeRoot();
  const repository = new RecordingArtifactRepository();
  const provider = new ScriptedProvider([
    readSliceTurn('t1', WORKER_PATH),
    submitTurn('t2', { edits: [{ anchor_id: 'src_ffffffffffffffff', replacement: 'x' }], creates: [] }),
    submitTurn('t3', { edits: [{ anchor_id: 'src_eeeeeeeeeeeeeeee', replacement: 'y' }], creates: [] }),
  ]);
  try {
    const result = await makeRunner(root, provider, repository).run('builder', ctx(root));
    assert.equal(result.success, false);
    assert.match(result.error!, /result repair is exhausted/);
    assert.match(result.error!, /unknown-anchor|was not issued/);
    assert.equal(readFileSync(join(root, WORKER_PATH), 'utf-8'), WORKER_ORIGINAL, 'tree untouched');
    assert.ok(!existsSync(join(root, '.sle', 'runs', 'p1-run', '1', 'node-outputs', 'build-anchors.json')));
  } finally {
    cleanup();
  }
});

// ─── editPolicy violations are repairable in-loop ─────────────────────────────

test('P1.23: an out-of-scope create is rejected with unauthorized-create-path and repairs', async () => {
  const { root, cleanup } = makeRoot();
  const repository = new RecordingArtifactRepository();
  const provider = new ScriptedProvider([
    readSliceTurn('t1', WORKER_PATH),
    submitTurn('t2', { edits: [], creates: [{ path: 'docs/sneaky.md', content: 'x' }] }),
    submitTurn('t3', { edits: [], creates: [{ path: NEW_FILE_PATH, content: NEW_FILE_CONTENT }] }),
  ]);
  try {
    const result = await makeRunner(root, provider, repository)
      .run('builder', ctx(root, { editPolicy: { allowedEditPaths: [WORKER_PATH, NEW_FILE_PATH], requiredEditPaths: [] } }));
    assert.equal(result.success, true, result.error);
    assert.ok(provider.toolResultContents.some((c) => c.includes('unauthorized-create-path')));
    assert.ok(!existsSync(join(root, 'docs/sneaky.md')));
    assert.equal(readFileSync(join(root, NEW_FILE_PATH), 'utf-8'), NEW_FILE_CONTENT);
  } finally {
    cleanup();
  }
});

// ─── Cross-execution anchors ──────────────────────────────────────────────────

test('P1.24: an anchor minted in another step execution is unknown — no cross-run reuse', async () => {
  const { root, cleanup } = makeRoot();
  const repository = new RecordingArtifactRepository();
  // Execution 1 mints an anchor (investigation only; ends without submission).
  const provider1 = new ScriptedProvider([
    readSliceTurn('t1', WORKER_PATH),
    { stop_reason: 'end_turn', text: 'no submission', tool_uses: [], tokens_used: 1 },
  ]);
  const runner1 = makeRunner(root, provider1, repository);
  await runner1.run('builder', ctx(root, { runId: 'run-1' }));
  // run-1 failed on absent submission — but its ANCHOR existed only in its own
  // registry, which is gone. Execution 2 references a well-formed id.
  const provider2 = new ScriptedProvider([
    submitTurn('t2', { edits: [{ anchor_id: mintFrom(provider1), replacement: 'x' }], creates: [] }),
    submitTurn('t3', { edits: [], creates: [{ path: NEW_FILE_PATH, content: NEW_FILE_CONTENT }] }),
  ]);
  try {
    const result = await makeRunner(root, provider2, repository).run('builder', ctx(root, { runId: 'run-2' }));
    assert.equal(result.success, true, result.error);
    assert.ok(provider2.toolResultContents.some((c) => c.includes('unknown-anchor')));
  } finally {
    cleanup();
  }
});

// The anchor id from execution 1 is deterministic — recompute it (the
// execution-1 registry is unreachable by construction; that is the point).
function mintFrom(provider: ScriptedProvider): string {
  const anchor = mintedAnchor(provider) as unknown as { anchor_id: string };
  return anchor.anchor_id;
}

// ─── Textual patches cannot reach the applier ─────────────────────────────────

test('P1.25: a textual SLE-PATCH in an end_turn reply is transport-absent — it can never reach disk', async () => {
  const { root, cleanup } = makeRoot();
  const repository = new RecordingArtifactRepository();
  const textualPatch =
    `<<<SLE-PATCH path="${WORKER_PATH}" base="${sha256(WORKER_ORIGINAL)}">>>\n` +
    `--- a/${WORKER_PATH}\n+++ b/${WORKER_PATH}\n@@ -1,2 +1,3 @@\n` +
    ` DEFAULT_FAILURE_STAGE = "consume"\n+HACKED = True\n \n` +
    `<<<END-SLE-PATCH>>>`;
  const provider = new ScriptedProvider([
    { stop_reason: 'end_turn', text: textualPatch, tool_uses: [], tokens_used: 3 },
    { stop_reason: 'end_turn', text: textualPatch, tool_uses: [], tokens_used: 3 },
  ]);
  try {
    const result = await makeRunner(root, provider, repository).run('builder', ctx(root));
    assert.equal(result.success, false);
    assert.match(result.error!, /format repair is exhausted/);
    // the SLE-PATCH payload never landed — the file is byte-identical
    assert.equal(readFileSync(join(root, WORKER_PATH), 'utf-8'), WORKER_ORIGINAL);
  } finally {
    cleanup();
  }
});

// ─── Legacy invariance ────────────────────────────────────────────────────────

test('P1.26: a step WITHOUT the action declaration is byte-for-byte legacy — no anchor in tool results', async () => {
  const { root, cleanup } = makeRoot();
  const repository = new RecordingArtifactRepository();
  const provider = new ScriptedProvider([
    readSliceTurn('t1', WORKER_PATH),
    {
      stop_reason: 'end_turn',
      text:
        `<<<SLE-OUTPUT>>>\n<<<SLE-PATCH path="${WORKER_PATH}" base="${sha256(WORKER_ORIGINAL)}">>>\n` +
        `--- a/${WORKER_PATH}\n+++ b/${WORKER_PATH}\n@@ -1,2 +1,3 @@\n` +
        ` DEFAULT_FAILURE_STAGE = "consume"\n+FAILURE_STAGE_FALLBACK = "processing"\n \n` +
        `<<<END-SLE-PATCH>>>\n<<<END-SLE-OUTPUT>>>`,
      tool_uses: [],
      tokens_used: 3,
    },
  ]);
  const cm = new ContextManager(root, DEFAULT_CONFIG);
  const runner = new AgentRunner(
    cm,
    provider as never,
    root,
    { updateNodeStatus: async () => {}, writeNodeOutput: async () => {} } as unknown as RunArtifactManager,
    { model: 'test' } satisfies Partial<AgentRunnerConfig> as AgentRunnerConfig,
    undefined,
    repository as unknown as ArtifactRepository,
  );
  const legacyCtx = {
    workflowRunId: 'legacy-run',
    workflowId: 'full-build',
    stepId: 'build',
    iteration: 1,
    revision: 0,
    goal: 'legacy invariance probe',
    projectRoot: root,
    instruction: 'Publish.',
  } as never;
  try {
    const result = await runner.run('builder', legacyCtx);
    assert.equal(result.success, true, result.error);
    // no anchor augmentation on the legacy path
    assert.equal(provider.toolResultContents.some((c) => c.includes('"anchor"')), false);
    // the legacy textual patch applied normally
    assert.equal(readFileSync(join(root, WORKER_PATH), 'utf-8'), WORKER_PATCHED);
    assert.equal(result.patches_applied!.length, 1);
    assert.ok(repository.saved.find((r) => r.type === 'applied-patch'));
    // no anchored summary keys
    assert.equal(result.anchored_edits, undefined);
  } finally {
    cleanup();
  }
});
