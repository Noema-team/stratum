// P2-B — REAL AgentRunner qualification (review correction 4).
//
// End-to-end through AgentRunner.run with a scripted multi-turn provider —
// pins the frozen main.py-only editPolicy regime at the actual seams:
//   - the disk-derived no-create authority (createsAuthorized computed from
//     file existence BEFORE any model call)
//   - the ACTUAL EMITTED submit_result wire schema (the input_schema the
//     provider received) — creates omitted under the narrowed authority
//   - the ACTUAL teaching text — zero create-field teaching when narrowed
//   - in-loop acceptance + canonicalization (edits-only proposal, no creates
//     key), the unknown-key rejection of an explicit creates, and the repair
//     path through the real loop budget
//   - authoritative composition evidence records persisted VERBATIM by the
//     runner and retrievable from the anchors manifest on disk
//   - a genuinely nonexistent authorized target RETAINS create support
//   - no-policy workflows remain byte-identical at the wire surface

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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
const WORKER_PATCHED = 'DEFAULT_FAILURE_STAGE = "consume"\nFAILURE_STAGE_FALLBACK = "processing"\n\n\ndef process_document(doc):\n    return doc\n';
const NEW_FILE_PATH = 'apps/ai-server/rag-worker-service/failure_payload.py';
const NEW_FILE_CONTENT = 'FAILURE_STAGE = "processing"\n';
const WORKER_PATCHED_SINGLE = 'DEFAULT_FAILURE_STAGE = "consume"\nFAILURE_STAGE_FALLBACK = "processing"\n\ndef process_document(doc):\n    return doc\n';

// ─── Harness (same shape as build-action-contract.test.ts) ────────────────────

function makeRoot(withNewFile = false): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'p2b-runner-'));
  mkdirSync(join(root, 'apps/ai-server/rag-worker-service'), { recursive: true });
  writeFileSync(join(root, WORKER_PATH), WORKER_ORIGINAL);
  if (withNewFile) writeFileSync(join(root, NEW_FILE_PATH), 'placeholder\n');
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

interface ToolDefShape { name: string; input_schema?: Record<string, unknown> }

class RecordingProvider {
  private turn = 0;
  readonly toolResultContents: string[] = [];
  /** The FULL tool defs each request carried — the actual emitted wire surface. */
  readonly requestTools: ToolDefShape[][] = [];
  /** Every request's serialized messages — searched for teaching text. */
  readonly requestBlobs: string[] = [];
  constructor(private readonly script: MultiTurnResult[]) {}
  async complete(): Promise<never> {
    throw new Error('p2b: single-turn path not expected');
  }
  async completeMultiTurn(params: {
    messages: Array<{ role: string; content: unknown }>;
    tools: ReadonlyArray<ToolDefShape>;
  }): Promise<MultiTurnResult> {
    this.requestTools.push(params.tools.map((t) => ({ name: t.name, input_schema: t.input_schema })));
    this.requestBlobs.push(JSON.stringify(params.messages));
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
  submitTool(): ToolDefShape {
    const tool = this.requestTools[0]?.find((t) => t.name === SUBMIT_RESULT_TOOL_NAME);
    assert.ok(tool, 'submit_result was offered on the first request');
    return tool!;
  }
  teachingBlob(): string {
    return this.requestBlobs.join('\n');
  }
}

function readSliceTurn(id: string, path: string, startLine: number, lineCount: number): MultiTurnResult {
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

function makeRunner(root: string, provider: RecordingProvider, repository: RecordingArtifactRepository): AgentRunner {
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
    workflowRunId: opts.runId ?? 'p2b-run',
    workflowId: 'full-build',
    stepId: 'build',
    iteration: 1,
    revision: 0,
    goal: 'p2b runner qualification',
    projectRoot: root,
    instruction: 'Publish the failure-stage fix.',
    actionArtifact: { type: BUILD_CHANGESET_ARTIFACT_TYPE },
    ...(opts.editPolicy ? { editPolicy: opts.editPolicy } : {}),
  } as never;
}

/** Deterministically recompute the anchor id the runner mints for a span. */
function expectedAnchorId(start: number, end: number): string {
  const lines = WORKER_ORIGINAL.split('\n');
  const content = lines.slice(start - 1, end).join('\n');
  return (
    'src_' +
    createHash('sha256')
      .update([WORKER_PATH, sha256(WORKER_ORIGINAL), String(start), String(end), sha256(content)].join('\0'), 'utf8')
      .digest('hex')
      .slice(0, 16)
  );
}

function mintedAnchorIds(provider: RecordingProvider): string[] {
  const ids: string[] = [];
  for (const c of provider.toolResultContents) {
    try {
      const v = JSON.parse(c) as { anchor?: { anchor_id?: string } };
      if (v.anchor?.anchor_id) ids.push(v.anchor.anchor_id);
    } catch {
      /* non-slice tool result */
    }
  }
  return ids;
}

// The frozen-policy composition: span [1,2] and span [2,3] share line 2 with a
// byte-identical boundary line — the deterministic closure composes them.
const REPL_A = 'DEFAULT_FAILURE_STAGE = "consume"\nFAILURE_STAGE_FALLBACK = "processing"';
const REPL_B = 'FAILURE_STAGE_FALLBACK = "processing"\n\n';
const COMPOSED = REPL_A + '\n' + REPL_B.split('\n').slice(1).join('\n');

// ─── Q1: frozen main.py-only policy, end-to-end ───────────────────────────────

test('P2B.Q1: main.py-only policy end-to-end — narrowed wire schema, zero create teaching, reject-explicit-creates repair, canonical acceptance, verbatim composition evidence', async () => {
  const { root, cleanup } = makeRoot(false); // NEW_FILE_PATH genuinely absent
  const repository = new RecordingArtifactRepository();
  const anchor12 = expectedAnchorId(1, 2);
  const anchor23 = expectedAnchorId(2, 3);
  const provider = new RecordingProvider([
    readSliceTurn('t1', WORKER_PATH, 1, 2),
    readSliceTurn('t2', WORKER_PATH, 2, 2),
    // first submission: an EXPLICIT creates under the narrowed surface —
    // must be an unknown-key decode rejection (repairable, never discarded)
    submitTurn('t3', { edits: [{ anchor_id: anchor12, replacement: REPL_A }, { anchor_id: anchor23, replacement: REPL_B }], creates: [] }),
    // corrected resubmission: the policy-legal form — creates structurally absent
    submitTurn('t4', { edits: [{ anchor_id: anchor12, replacement: REPL_A }, { anchor_id: anchor23, replacement: REPL_B }] }),
  ]);
  try {
    const result = await makeRunner(root, provider, repository)
      .run('builder', ctx(root, { editPolicy: { allowedEditPaths: [WORKER_PATH], requiredEditPaths: [WORKER_PATH] } }));
    assert.equal(result.success, true, result.error);
    assert.equal(result.result_repairs, 1);

    // ── disk: the composed bytes, exactly ──
    assert.equal(readFileSync(join(root, WORKER_PATH), 'utf-8'), WORKER_PATCHED);
    // no create ever landed (it was structurally inexpressible)
    assert.equal(exists(root, NEW_FILE_PATH), false);

    // ── the ACTUAL EMITTED wire schema the provider received ──
    const submit = provider.submitTool();
    const schema = submit.input_schema as { properties?: Record<string, unknown>; required?: string[] };
    assert.notEqual(schema.properties?.edits, undefined);
    assert.equal(schema.properties?.creates, undefined, 'narrowed authority: creates omitted from the wire schema');
    assert.ok(!schema.required?.includes('creates'));

    // ── the ACTUAL teaching: zero create-field text ──
    const teaching = provider.teachingBlob();
    assert.equal(teaching.includes('/properties/creates'), false, 'no create-field teaching under the narrowed surface');
    assert.ok(teaching.includes('/properties/edits'));

    // ── the rejection named the key; the canonical acceptance followed ──
    assert.ok(provider.toolResultContents.some((c) => c.includes('creates') && c.includes('Unrecognized key')), 'explicit creates rejected naming the key');
    // the accepted proposal carried NO creates key (canonicalized to []):
    // success + exactly one repair prove accept-reject-accept through the loop.

    // ── composition evidence: persisted VERBATIM, retrievable from disk ──
    assert.deepEqual(mintedAnchorIds(provider).sort(), [anchor12, anchor23].sort());
    const manifest = JSON.parse(
      readFileSync(join(root, '.sle', 'runs', 'p2b-run', '1', 'node-outputs', 'build-anchors.json'), 'utf-8'),
    ) as { compositions?: Array<Record<string, unknown>> };
    assert.equal(manifest.compositions?.length, 1);
    assert.deepEqual(manifest.compositions![0], {
      path: WORKER_PATH,
      source_anchor_ids: [anchor12, anchor23],
      start_line: 1,
      end_line: 3,
      replacement_sha256: sha256(COMPOSED),
      result_file_sha256: sha256(WORKER_PATCHED), // independently recomputed from the disk bytes
    });
  } finally {
    cleanup();
  }
});

function exists(root: string, rel: string): boolean {
  try {
    readFileSync(join(root, rel), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

// ─── Q2: a genuinely nonexistent authorized target RETAINS create support ────

test('P2B.Q2: a genuinely nonexistent authorized target retains the full surface — creates on the wire, in teaching, and publishable', async () => {
  const { root, cleanup } = makeRoot(false); // allowed path #2 does NOT exist
  const repository = new RecordingArtifactRepository();
  const anchor12 = expectedAnchorId(1, 2);
  const provider = new RecordingProvider([
    readSliceTurn('t1', WORKER_PATH, 1, 2),
    submitTurn('t2', {
      edits: [{ anchor_id: anchor12, replacement: 'DEFAULT_FAILURE_STAGE = "consume"\nFAILURE_STAGE_FALLBACK = "processing"' }],
      creates: [{ path: NEW_FILE_PATH, content: NEW_FILE_CONTENT }],
    }),
  ]);
  try {
    const result = await makeRunner(root, provider, repository)
      .run('builder', ctx(root, { editPolicy: { allowedEditPaths: [WORKER_PATH, NEW_FILE_PATH], requiredEditPaths: [] } }));
    assert.equal(result.success, true, result.error);
    // full surface on the wire AND in teaching
    const schema = provider.submitTool().input_schema as { properties?: Record<string, unknown> };
    assert.notEqual(schema.properties?.creates, undefined);
    assert.ok(provider.teachingBlob().includes('/properties/creates'));
    // both operations published
    assert.equal(readFileSync(join(root, WORKER_PATH), 'utf-8'), WORKER_PATCHED_SINGLE);
    assert.equal(readFileSync(join(root, NEW_FILE_PATH), 'utf-8'), NEW_FILE_CONTENT);
    // no composition took place — no evidence records
    const manifest = JSON.parse(
      readFileSync(join(root, '.sle', 'runs', 'p2b-run', '1', 'node-outputs', 'build-anchors.json'), 'utf-8'),
    ) as { compositions?: unknown[] };
    assert.equal(manifest.compositions, undefined);
  } finally {
    cleanup();
  }
});

// ─── Q3: no-policy workflows remain unchanged at the wire surface ────────────

test('P2B.Q3: no editPolicy — unchanged full surface (wire schema and teaching carry creates)', async () => {
  const { root, cleanup } = makeRoot(false);
  const repository = new RecordingArtifactRepository();
  const anchor12 = expectedAnchorId(1, 2);
  const provider = new RecordingProvider([
    readSliceTurn('t1', WORKER_PATH, 1, 2),
    submitTurn('t2', {
      edits: [{ anchor_id: anchor12, replacement: 'DEFAULT_FAILURE_STAGE = "consume"\nFAILURE_STAGE_FALLBACK = "processing"' }],
      creates: [{ path: NEW_FILE_PATH, content: NEW_FILE_CONTENT }],
    }),
  ]);
  try {
    const result = await makeRunner(root, provider, repository).run('builder', ctx(root));
    assert.equal(result.success, true, result.error);
    const schema = provider.submitTool().input_schema as { properties?: Record<string, unknown> };
    assert.notEqual(schema.properties?.creates, undefined);
    assert.ok(provider.teachingBlob().includes('/properties/creates'));
    assert.equal(readFileSync(join(root, NEW_FILE_PATH), 'utf-8'), NEW_FILE_CONTENT);
  } finally {
    cleanup();
  }
});
