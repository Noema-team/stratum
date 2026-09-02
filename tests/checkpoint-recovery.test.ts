/**
 * Checkpoint primitive behavior tests — verifies that resolveCheckpoint applies
 * the correct side effects for each full-build checkpoint type and returns the
 * expected CheckpointResolution.
 *
 * Idempotency / retry safety are handled at the ResumeService layer via the
 * SQLite checkpoint_applications journal (A.3) and tested in checkpoint-journal.test.ts.
 * Receipt-based tests have been removed.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { FullBuildStepRunner } from '../src/execution/full-build-step-runner.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeTmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'sle-ckpt-recovery-'));
}

/** Minimal mutable RuntimeMap tracker. */
function makeMapManager(initial: { awaiting_confirmation?: boolean; awaiting_scoping?: boolean } = {}) {
  let map: any = {
    cycle: {
      awaiting_confirmation: initial.awaiting_confirmation ?? true,
      awaiting_scoping: initial.awaiting_scoping ?? false,
      revision: 0,
    },
    meta: {},
  };
  return {
    read: async () => JSON.parse(JSON.stringify(map)) as typeof map,
    update: async (fn: (m: any) => any) => { map = fn(map); },
    _get: () => map,
  };
}

/** RunArtifactManager stub that resolves paths into the real tmpdir. */
function makeRunArtifacts(projectRoot: string) {
  const statusLog: string[] = [];
  return {
    statusLog,
    runDir: (wrid: string, iter: number) =>
      join(projectRoot, '.sle', 'runs', wrid, String(iter)),
    updateNodeStatus: async (_wrid: string, _iter: number, nodeId: string, update: any) => {
      statusLog.push(`${nodeId}:${update.status}`);
    },
  };
}

/** ConfirmService-like fake. */
function makeConfirmService(opts: {
  throwCode?: string;
  reviseThrowCode?: string;
  captureNote?: string[];
} = {}) {
  const calls: string[] = [];
  const service = {
    calls,
    gate: async () => {},
    approve: async (_wrid: string, _iter: number) => {
      calls.push('approve');
      if (opts.throwCode) {
        const err: any = new Error(opts.throwCode);
        err.code = opts.throwCode;
        throw err;
      }
      return { approved: true, next_node: 'BUILD' as const };
    },
    revise: async (_wrid: string, _iter: number, note?: string) => {
      calls.push('revise');
      if (opts.captureNote) opts.captureNote.push(note ?? '');
      if (opts.reviseThrowCode) {
        const err: any = new Error(opts.reviseThrowCode);
        err.code = opts.reviseThrowCode;
        throw err;
      }
      return { revision_count: 1, next_node: 'TEST' as const };
    },
  };
  return service;
}

/** ScopingService fake. */
function makeScopingService() {
  const calls: string[] = [];
  return {
    calls,
    approve: async (_cycleNumber: number, _iteration: number) => { calls.push('approve'); },
    begin: async () => {},
  };
}

/** ShardingService fake. */
function makeShardingService() {
  const calls: string[] = [];
  return {
    calls,
    createTasksFromProposal: async (_proposal: any) => { calls.push('createTasksFromProposal'); },
  };
}

const noopCallbacks = {
  onCheckpoint: async () => 'halt' as const,
  onConfirmGate: async () => 'halt' as const,
  onShardingGate: async () => 'halt' as const,
};

const noopStub = (_x: unknown) => _x;

function makeRunner(
  projectRoot: string,
  deps: {
    mapManager?: ReturnType<typeof makeMapManager>;
    runArtifacts?: ReturnType<typeof makeRunArtifacts>;
    confirmService?: ReturnType<typeof makeConfirmService>;
    scopingService?: ReturnType<typeof makeScopingService>;
    shardingService?: ReturnType<typeof makeShardingService>;
  } = {},
): FullBuildStepRunner {
  const mapManager = deps.mapManager ?? makeMapManager();
  const runArtifacts = deps.runArtifacts ?? makeRunArtifacts(projectRoot);
  const confirmService = deps.confirmService ?? makeConfirmService();
  return new FullBuildStepRunner(
    {
      agentStepRunner: noopStub as any,
      mapManager,
      runArtifacts: runArtifacts as any,
      projectRoot,
      confirmService: confirmService as any,
      execService: noopStub as any,
      validationGateService: noopStub as any,
      snapshotService: noopStub as any,
      summariseService: noopStub as any,
      ...(deps.scopingService ? { scopingService: deps.scopingService as any } : {}),
      ...(deps.shardingService ? { shardingService: deps.shardingService as any } : {}),
    },
    noopCallbacks,
  );
}

// ── CONFIRM approve ────────────────────────────────────────────────────────────

test('CONFIRM approve: returns {overrideContinuationStepId: build}', async () => {
  const root = makeTmpRoot();
  try {
    const confirmService = makeConfirmService();
    const runner = makeRunner(root, { confirmService });

    const res = await runner.resolveCheckpoint({
      workflowId: 'full-build',
      stepId: 'confirm',
      decisionId: randomUUID(),
      selectedOptionId: 'approve',
      workflowRunId: randomUUID(),
      iteration: 1,
      revision: 0,
    });

    assert.equal(res.overrideContinuationStepId, 'build');
    assert.equal(res.remainAtCheckpoint, false);
    assert.equal(res.incrementRevision, false);
    assert.equal(res.cancel, false);
    assert.deepEqual(confirmService.calls, ['approve']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CONFIRM approve partial recovery: not_awaiting_confirmation + map=false → build routing', async () => {
  const root = makeTmpRoot();
  try {
    // Simulate: approve() completed both effects (map updated) but resolver crashed.
    // On retry: approve() throws not_awaiting_confirmation, map shows false.
    const mapManager = makeMapManager({ awaiting_confirmation: false });
    const confirmService = makeConfirmService({ throwCode: 'not_awaiting_confirmation' });
    const runner = makeRunner(root, { mapManager, confirmService });

    const res = await runner.resolveCheckpoint({
      workflowId: 'full-build',
      stepId: 'confirm',
      decisionId: randomUUID(),
      selectedOptionId: 'approve',
      workflowRunId: randomUUID(),
      iteration: 1,
      revision: 0,
    });

    assert.equal(res.overrideContinuationStepId, 'build', 'recovery must produce build routing');
    assert.equal(res.cancel, false);
    assert.equal(res.incrementRevision, false);
    assert.equal(confirmService.calls.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── CONFIRM revise ─────────────────────────────────────────────────────────────

test('CONFIRM revise: returns TEST routing with incrementRevision=true', async () => {
  const root = makeTmpRoot();
  try {
    const confirmService = makeConfirmService();
    const runner = makeRunner(root, { confirmService });

    const res = await runner.resolveCheckpoint({
      workflowId: 'full-build',
      stepId: 'confirm',
      decisionId: randomUUID(),
      selectedOptionId: 'revise',
      workflowRunId: randomUUID(),
      iteration: 1,
      revision: 0,
    });

    assert.equal(res.overrideContinuationStepId, 'test');
    assert.equal(res.incrementRevision, true);
    assert.equal(res.cancel, false);
    assert.equal(res.remainAtCheckpoint, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CONFIRM revise: rationale is forwarded as note to confirmService.revise()', async () => {
  const root = makeTmpRoot();
  try {
    const captured: string[] = [];
    const confirmService = makeConfirmService({ captureNote: captured });
    const runner = makeRunner(root, { confirmService });

    await runner.resolveCheckpoint({
      workflowId: 'full-build',
      stepId: 'confirm',
      decisionId: randomUUID(),
      selectedOptionId: 'revise',
      rationale: 'needs-more-tests',
      workflowRunId: randomUUID(),
      iteration: 1,
      revision: 0,
    });

    assert.equal(captured[0], 'needs-more-tests');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── SCOPING approve ────────────────────────────────────────────────────────────

test('SCOPING approve: scopingService.approve() called; run-artifact=complete', async () => {
  const root = makeTmpRoot();
  try {
    const scopingService = makeScopingService();
    const runArtifacts = makeRunArtifacts(root);
    const runner = makeRunner(root, { scopingService, runArtifacts });

    const res = await runner.resolveCheckpoint({
      workflowId: 'full-build',
      stepId: 'scoping.checkpoint',
      decisionId: randomUUID(),
      selectedOptionId: 'approve',
      workflowRunId: randomUUID(),
      iteration: 1,
      revision: 0,
    });

    assert.equal(res.remainAtCheckpoint, false);
    assert.equal(res.cancel, false);
    assert.deepEqual(scopingService.calls, ['approve']);
    assert.ok(
      runArtifacts.statusLog.some(e => e.startsWith('scoping.checkpoint:complete')),
      'scoping.checkpoint should be marked complete in run-artifacts',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── SHARDING approve ───────────────────────────────────────────────────────────

test('SHARDING approve: tasks created; run-artifact=complete with .sle/tasks.yaml', async () => {
  const root = makeTmpRoot();
  try {
    const shardingService = makeShardingService();
    const runArtifacts = makeRunArtifacts(root);
    const runner = makeRunner(root, { shardingService, runArtifacts });

    // Write a minimal proposal file.
    const sle = join(root, '.sle');
    mkdirSync(sle, { recursive: true });
    writeFileSync(join(sle, 'sharding-proposal.yaml'), 'tasks:\n  - id: T-1\n    title: "task one"\n', 'utf8');

    const res = await runner.resolveCheckpoint({
      workflowId: 'full-build',
      stepId: 'sharding_approval',
      decisionId: randomUUID(),
      selectedOptionId: 'approve',
      workflowRunId: randomUUID(),
      iteration: 1,
      revision: 0,
    });

    assert.equal(res.remainAtCheckpoint, false);
    assert.equal(res.cancel, false);
    assert.deepEqual(shardingService.calls, ['createTasksFromProposal']);
    assert.ok(
      runArtifacts.statusLog.some(e => e.startsWith('sharding_approval:complete')),
      'sharding_approval should be marked complete',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── SHARDING reject ────────────────────────────────────────────────────────────

test('SHARDING reject: proposal removed; run-artifact=skipped(user_rejected_sharding)', async () => {
  const root = makeTmpRoot();
  try {
    const runArtifacts = makeRunArtifacts(root);
    const runner = makeRunner(root, { runArtifacts });

    // Write proposal.
    const sle = join(root, '.sle');
    mkdirSync(sle, { recursive: true });
    const proposalPath = join(sle, 'sharding-proposal.yaml');
    writeFileSync(proposalPath, 'tasks: []', 'utf8');

    const res = await runner.resolveCheckpoint({
      workflowId: 'full-build',
      stepId: 'sharding_approval',
      decisionId: randomUUID(),
      selectedOptionId: 'reject',
      workflowRunId: randomUUID(),
      iteration: 1,
      revision: 0,
    });

    assert.equal(res.remainAtCheckpoint, false);
    assert.equal(res.cancel, false);

    // Proposal file removed.
    await assert.rejects(fs.access(proposalPath), 'proposal file should have been deleted');

    // Run-artifact marked skipped with correct reason.
    assert.ok(
      runArtifacts.statusLog.some(e => e === 'sharding_approval:skipped'),
      'sharding_approval should be marked skipped',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── SHARDING modify ────────────────────────────────────────────────────────────

test('SHARDING modify: returns remainAtCheckpoint=true', async () => {
  const root = makeTmpRoot();
  try {
    const runner = makeRunner(root);

    const res = await runner.resolveCheckpoint({
      workflowId: 'full-build',
      stepId: 'sharding_approval',
      decisionId: randomUUID(),
      selectedOptionId: 'modify',
      workflowRunId: randomUUID(),
      iteration: 1,
      revision: 0,
    });

    assert.equal(res.remainAtCheckpoint, true);
    assert.equal(res.cancel, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Fail-closed: CONFIRM partial recovery with unexpected map state ─────────────

test('CONFIRM approve recovery: unexpected map state (awaiting_confirmation=true) → throws', async () => {
  const root = makeTmpRoot();
  try {
    // awaiting_confirmation is STILL true when approve() throws not_awaiting_confirmation
    // — this is an impossible/inconsistent state that should fail closed.
    const mapManager = makeMapManager({ awaiting_confirmation: true });
    const confirmService = makeConfirmService({ throwCode: 'not_awaiting_confirmation' });
    const runner = makeRunner(root, { mapManager, confirmService });

    await assert.rejects(
      runner.resolveCheckpoint({
        workflowId: 'full-build',
        stepId: 'confirm',
        decisionId: randomUUID(),
        selectedOptionId: 'approve',
        workflowRunId: randomUUID(),
        iteration: 1,
        revision: 0,
      }),
      /CONFIRM approve recovery: unexpected RuntimeMap state/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Generic fallback ───────────────────────────────────────────────────────────

test('Generic approve (unknown workflow): cancel=false', async () => {
  const root = makeTmpRoot();
  try {
    const runner = makeRunner(root);

    const res = await runner.resolveCheckpoint({
      workflowId: 'some-other-workflow',
      stepId: 'any_checkpoint',
      decisionId: randomUUID(),
      selectedOptionId: 'approve',
      workflowRunId: randomUUID(),
      iteration: 1,
      revision: 0,
    });

    assert.equal(res.cancel, false);
    assert.equal(res.remainAtCheckpoint, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Generic reject (unknown workflow): cancel=true', async () => {
  const root = makeTmpRoot();
  try {
    const runner = makeRunner(root);

    const res = await runner.resolveCheckpoint({
      workflowId: 'some-other-workflow',
      stepId: 'any_checkpoint',
      decisionId: randomUUID(),
      selectedOptionId: 'reject',
      workflowRunId: randomUUID(),
      iteration: 1,
      revision: 0,
    });

    assert.equal(res.cancel, true);
    assert.equal(res.remainAtCheckpoint, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
