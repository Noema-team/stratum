/**
 * Checkpoint recovery tests — Blocker 5 of A.2 correction.
 *
 * Verifies that resolveCheckpoint is crash-safe and idempotent via the receipt
 * mechanism, and that all full-build checkpoint types are handled correctly
 * on first attempt and on retry.
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

test('CONFIRM approve: first call returns {overrideContinuationStepId: build}', async () => {
  const root = makeTmpRoot();
  try {
    const confirmService = makeConfirmService();
    const runner = makeRunner(root, { confirmService });
    const wrid = randomUUID();
    const decisionId = randomUUID();

    const res = await runner.resolveCheckpoint({
      workflowId: 'full-build',
      stepId: 'confirm',
      decisionId,
      selectedOptionId: 'approve',
      workflowRunId: wrid,
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

test('CONFIRM approve: receipt gate prevents double-apply on retry', async () => {
  const root = makeTmpRoot();
  try {
    const confirmService = makeConfirmService();
    const runner = makeRunner(root, { confirmService });
    const wrid = randomUUID();
    const decisionId = randomUUID();

    const input = {
      workflowId: 'full-build',
      stepId: 'confirm',
      decisionId,
      selectedOptionId: 'approve',
      workflowRunId: wrid,
      iteration: 1,
      revision: 0,
    };

    const res1 = await runner.resolveCheckpoint(input);
    const res2 = await runner.resolveCheckpoint(input); // retry

    // Same resolution returned both times.
    assert.deepEqual(res1, res2);
    // confirmService.approve() called exactly once — receipt gate short-circuited retry.
    assert.deepEqual(confirmService.calls, ['approve']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CONFIRM approve partial recovery: no receipt + not_awaiting_confirmation + map=false → build routing', async () => {
  const root = makeTmpRoot();
  try {
    // Simulate: approve() completed both effects (map updated) but receipt was never written.
    // On retry: approve() throws not_awaiting_confirmation, map shows awaiting_confirmation=false.
    const mapManager = makeMapManager({ awaiting_confirmation: false });
    const confirmService = makeConfirmService({ throwCode: 'not_awaiting_confirmation' });
    const runner = makeRunner(root, { mapManager, confirmService });
    const wrid = randomUUID();
    const decisionId = randomUUID();

    const res = await runner.resolveCheckpoint({
      workflowId: 'full-build',
      stepId: 'confirm',
      decisionId,
      selectedOptionId: 'approve',
      workflowRunId: wrid,
      iteration: 1,
      revision: 0,
    });

    assert.equal(res.overrideContinuationStepId, 'build', 'recovery must produce build routing');
    assert.equal(res.cancel, false);
    assert.equal(res.incrementRevision, false);

    // Receipt is written after recovery so a subsequent retry doesn't re-recover.
    const res2 = await runner.resolveCheckpoint({
      workflowId: 'full-build',
      stepId: 'confirm',
      decisionId,
      selectedOptionId: 'approve',
      workflowRunId: wrid,
      iteration: 1,
      revision: 0,
    });
    assert.deepEqual(res, res2);
    // approve() called once (threw on the recovery attempt); retry served from receipt.
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
    const wrid = randomUUID();
    const decisionId = randomUUID();

    const res = await runner.resolveCheckpoint({
      workflowId: 'full-build',
      stepId: 'confirm',
      decisionId,
      selectedOptionId: 'revise',
      workflowRunId: wrid,
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

test('CONFIRM revise: retry returns same TEST routing (no re-application)', async () => {
  const root = makeTmpRoot();
  try {
    const confirmService = makeConfirmService();
    const runner = makeRunner(root, { confirmService });
    const wrid = randomUUID();
    const decisionId = randomUUID();

    const input = {
      workflowId: 'full-build',
      stepId: 'confirm',
      decisionId,
      selectedOptionId: 'revise',
      workflowRunId: wrid,
      iteration: 1,
      revision: 0,
    };

    const res1 = await runner.resolveCheckpoint(input);
    const res2 = await runner.resolveCheckpoint(input);

    assert.equal(res1.overrideContinuationStepId, 'test');
    assert.deepEqual(res1, res2);
    // revise() called once; retry served from receipt.
    assert.deepEqual(confirmService.calls, ['revise']);
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
    const wrid = randomUUID();

    await runner.resolveCheckpoint({
      workflowId: 'full-build',
      stepId: 'confirm',
      decisionId: randomUUID(),
      selectedOptionId: 'revise',
      rationale: 'needs-more-tests',
      workflowRunId: wrid,
      iteration: 1,
      revision: 0,
    });

    assert.equal(captured[0], 'needs-more-tests');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── SCOPING approve ────────────────────────────────────────────────────────────

test('SCOPING approve: scopingService.approve() called; run-artifact=complete; retry safe', async () => {
  const root = makeTmpRoot();
  try {
    const scopingService = makeScopingService();
    const runArtifacts = makeRunArtifacts(root);
    const runner = makeRunner(root, { scopingService, runArtifacts });
    const wrid = randomUUID();
    const decisionId = randomUUID();

    const input = {
      workflowId: 'full-build',
      stepId: 'scoping.checkpoint',
      decisionId,
      selectedOptionId: 'approve',
      workflowRunId: wrid,
      iteration: 1,
      revision: 0,
    };

    const res1 = await runner.resolveCheckpoint(input);

    assert.equal(res1.remainAtCheckpoint, false);
    assert.equal(res1.cancel, false);
    // scopingService.approve() was called.
    assert.deepEqual(scopingService.calls, ['approve']);
    // Run-artifact marked complete.
    assert.ok(
      runArtifacts.statusLog.some(e => e.startsWith('scoping.checkpoint:complete')),
      'scoping.checkpoint should be marked complete in run-artifacts',
    );

    // Retry: receipt found; scopingService.approve() not called again.
    const res2 = await runner.resolveCheckpoint(input);
    assert.deepEqual(res1, res2);
    assert.equal(scopingService.calls.length, 1, 'scopingService.approve() must not be called twice');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── SHARDING approve ───────────────────────────────────────────────────────────

test('SHARDING approve: tasks created once; run-artifact=complete with .sle/tasks.yaml; retry safe', async () => {
  const root = makeTmpRoot();
  try {
    const shardingService = makeShardingService();
    const runArtifacts = makeRunArtifacts(root);
    const runner = makeRunner(root, { shardingService, runArtifacts });
    const wrid = randomUUID();
    const decisionId = randomUUID();

    // Write a minimal proposal file.
    const sle = join(root, '.sle');
    mkdirSync(sle, { recursive: true });
    writeFileSync(join(sle, 'sharding-proposal.yaml'), 'tasks:\n  - id: T-1\n    title: "task one"\n', 'utf8');

    const input = {
      workflowId: 'full-build',
      stepId: 'sharding_approval',
      decisionId,
      selectedOptionId: 'approve',
      workflowRunId: wrid,
      iteration: 1,
      revision: 0,
    };

    const res1 = await runner.resolveCheckpoint(input);

    assert.equal(res1.remainAtCheckpoint, false);
    assert.equal(res1.cancel, false);
    assert.deepEqual(shardingService.calls, ['createTasksFromProposal']);
    assert.ok(
      runArtifacts.statusLog.some(e => e.startsWith('sharding_approval:complete')),
      'sharding_approval should be marked complete',
    );

    // Retry: receipt served; tasks not created again.
    const res2 = await runner.resolveCheckpoint(input);
    assert.deepEqual(res1, res2);
    assert.equal(shardingService.calls.length, 1, 'createTasksFromProposal must not be called twice');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── SHARDING reject ────────────────────────────────────────────────────────────

test('SHARDING reject: proposal removed; run-artifact=skipped(user_rejected_sharding); retry safe', async () => {
  const root = makeTmpRoot();
  try {
    const runArtifacts = makeRunArtifacts(root);
    const runner = makeRunner(root, { runArtifacts });
    const wrid = randomUUID();
    const decisionId = randomUUID();

    // Write proposal.
    const sle = join(root, '.sle');
    mkdirSync(sle, { recursive: true });
    const proposalPath = join(sle, 'sharding-proposal.yaml');
    writeFileSync(proposalPath, 'tasks: []', 'utf8');

    const input = {
      workflowId: 'full-build',
      stepId: 'sharding_approval',
      decisionId,
      selectedOptionId: 'reject',
      workflowRunId: wrid,
      iteration: 1,
      revision: 0,
    };

    const res1 = await runner.resolveCheckpoint(input);

    assert.equal(res1.remainAtCheckpoint, false);
    assert.equal(res1.cancel, false);

    // Proposal file removed.
    await assert.rejects(fs.access(proposalPath), 'proposal file should have been deleted');

    // Run-artifact marked skipped with correct reason.
    assert.ok(
      runArtifacts.statusLog.some(e => e === 'sharding_approval:skipped'),
      'sharding_approval should be marked skipped',
    );

    // Retry: receipt served.
    const res2 = await runner.resolveCheckpoint(input);
    assert.deepEqual(res1, res2);
    // statusLog still has exactly one skipped entry (unlink is idempotent, no double-skip from receipt).
    const skipCount = runArtifacts.statusLog.filter(e => e === 'sharding_approval:skipped').length;
    assert.equal(skipCount, 1, 'updateNodeStatus(skipped) must only run once');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── SHARDING modify ────────────────────────────────────────────────────────────

test('SHARDING modify: returns remainAtCheckpoint=true; no receipt written', async () => {
  const root = makeTmpRoot();
  try {
    const runArtifacts = makeRunArtifacts(root);
    const runner = makeRunner(root, { runArtifacts });
    const wrid = randomUUID();
    const decisionId = randomUUID();

    const res = await runner.resolveCheckpoint({
      workflowId: 'full-build',
      stepId: 'sharding_approval',
      decisionId,
      selectedOptionId: 'modify',
      workflowRunId: wrid,
      iteration: 1,
      revision: 0,
    });

    assert.equal(res.remainAtCheckpoint, true);
    assert.equal(res.cancel, false);

    // No receipt should exist — decision stays pending.
    const receiptDir = runArtifacts.runDir(wrid, 1);
    const receiptPath = join(receiptDir, `checkpoint-receipt-${decisionId}.json`);
    await assert.rejects(
      fs.access(receiptPath),
      'no receipt should be written for modify — decision stays pending',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Fail-closed: corrupt receipt ───────────────────────────────────────────────

test('Corrupt receipt: throws instead of silently re-applying', async () => {
  const root = makeTmpRoot();
  try {
    const runArtifacts = makeRunArtifacts(root);
    const runner = makeRunner(root, { runArtifacts });
    const wrid = randomUUID();
    const decisionId = randomUUID();

    // Write a corrupt receipt.
    const receiptDir = runArtifacts.runDir(wrid, 1);
    mkdirSync(receiptDir, { recursive: true });
    writeFileSync(join(receiptDir, `checkpoint-receipt-${decisionId}.json`), '{not valid json', 'utf8');

    await assert.rejects(
      runner.resolveCheckpoint({
        workflowId: 'full-build',
        stepId: 'confirm',
        decisionId,
        selectedOptionId: 'approve',
        workflowRunId: wrid,
        iteration: 1,
        revision: 0,
      }),
      /Corrupt checkpoint receipt/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Corrupt receipt: receipt with missing required fields throws', async () => {
  const root = makeTmpRoot();
  try {
    const runArtifacts = makeRunArtifacts(root);
    const runner = makeRunner(root, { runArtifacts });
    const wrid = randomUUID();
    const decisionId = randomUUID();

    // Write a receipt that has no resolution field.
    const receiptDir = runArtifacts.runDir(wrid, 1);
    mkdirSync(receiptDir, { recursive: true });
    writeFileSync(
      join(receiptDir, `checkpoint-receipt-${decisionId}.json`),
      JSON.stringify({ decisionId, stepId: 'confirm', selectedOptionId: 'approve' }),
      'utf8',
    );

    await assert.rejects(
      runner.resolveCheckpoint({
        workflowId: 'full-build',
        stepId: 'confirm',
        decisionId,
        selectedOptionId: 'approve',
        workflowRunId: wrid,
        iteration: 1,
        revision: 0,
      }),
      /Corrupt checkpoint receipt/,
    );
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

test('Generic approve (unknown workflow): cancel=false, no receipt mismatch on retry', async () => {
  const root = makeTmpRoot();
  try {
    const runner = makeRunner(root);
    const decisionId = randomUUID();

    const input = {
      workflowId: 'some-other-workflow',
      stepId: 'any_checkpoint',
      decisionId,
      selectedOptionId: 'approve',
      workflowRunId: randomUUID(),
      iteration: 1,
      revision: 0,
    };

    const res1 = await runner.resolveCheckpoint(input);
    assert.equal(res1.cancel, false);

    const res2 = await runner.resolveCheckpoint(input);
    assert.deepEqual(res1, res2);
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

test('Receipt mismatch: different stepId for same decisionId → throws', async () => {
  const root = makeTmpRoot();
  try {
    const runner = makeRunner(root);
    const wrid = randomUUID();
    const decisionId = randomUUID();

    // Write first resolution.
    await runner.resolveCheckpoint({
      workflowId: 'some-other-workflow',
      stepId: 'step-a',
      decisionId,
      selectedOptionId: 'approve',
      workflowRunId: wrid,
      iteration: 1,
      revision: 0,
    });

    // Attempt with different stepId for same decisionId.
    await assert.rejects(
      runner.resolveCheckpoint({
        workflowId: 'some-other-workflow',
        stepId: 'step-b',
        decisionId,
        selectedOptionId: 'approve',
        workflowRunId: wrid,
        iteration: 1,
        revision: 0,
      }),
      /Checkpoint receipt mismatch/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
