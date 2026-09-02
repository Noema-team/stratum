/**
 * CheckpointApplicationRepository contract tests (A.3).
 *
 * Verifies migration DDL, FK integrity, idempotency semantics, state transitions,
 * fail-closed conflict detection, and exact resolution persistence across DB reopen.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { openDatabase } from '../src/storage/database.js';
import {
  CheckpointApplicationRepository,
  CheckpointApplicationConflictError,
  WorkspaceRepository,
  ProjectRepository,
  WorkItemRepository,
  DecisionRepository,
  WorkflowRunRepository,
} from '../src/storage/repositories.js';
import type { CheckpointApplicationInput } from '../src/storage/repositories.js';
import type { Workspace, Project, WorkItem } from '../src/domain/index.js';

// ── Test-DB setup helpers ─────────────────────────────────────────────────────

function makeInMemDb() {
  return openDatabase(':memory:');
}

interface SeedResult {
  decisionId: string;
  runId: string;
  workItemId: string;
  projectId: string;
  wsId: string;
}

function seedRequiredRows(db: ReturnType<typeof openDatabase>): SeedResult {
  const now = new Date().toISOString();
  const wsId = randomUUID();
  const projectId = randomUUID();
  const workItemId = randomUUID();
  const runId = randomUUID();
  const decisionId = randomUUID();

  new WorkspaceRepository(db).save({ id: wsId, name: 'ws', createdAt: now });
  new ProjectRepository(db).save({
    id: projectId, workspaceId: wsId, name: 'p',
    status: 'active', priority: 0, createdAt: now, updatedAt: now,
  } as Project);
  new WorkItemRepository(db).save({
    id: workItemId, projectId, repositoryIds: [],
    title: 't', goal: 'g', workflowId: 'full-build',
    state: 'needs_decision', priority: 0,
    acceptanceCriteria: [], constraints: [], requiredEvidence: [],
    dependencies: [], createdAt: now, updatedAt: now,
  } as WorkItem);
  new WorkflowRunRepository(db).createOrValidate({
    run_id: runId, workflow_id: 'full-build', work_item_id: workItemId,
    status: 'halted', current_step_id: 'confirm',
    iteration: 1, revision: 0, awaiting_checkpoint: 'confirm',
    started_at: now, updated_at: now,
  });
  new DecisionRepository(db).save({
    id: decisionId, projectId, workItemId, type: 'checkpoint',
    subjectRef: { workflowRunId: runId, workItemId, stepId: 'confirm' },
    title: 'Test', summary: 'test',
    options: [{ id: 'approve', label: 'Approve', description: '' }],
    impact: 'low', reversibility: 'easy', urgency: 'normal', status: 'pending',
  } as any);

  return { decisionId, runId, workItemId, projectId, wsId };
}

function makeInput(seed: SeedResult, overrides: Partial<CheckpointApplicationInput> = {}): CheckpointApplicationInput {
  return {
    decisionId: seed.decisionId,
    workflowRunId: seed.runId,
    workflowId: 'full-build',
    stepId: 'confirm',
    iteration: 1,
    revisionBefore: 0,
    selectedOptionId: 'approve',
    ...overrides,
  };
}

// ── Migration: table exists ───────────────────────────────────────────────────

test('Migration 8: checkpoint_applications table is created', () => {
  const db = makeInMemDb();
  const result = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='checkpoint_applications'",
  ).get();
  assert.ok(result, 'checkpoint_applications table should exist after migration');
  db.close();
});

test('Migration 8: checkpoint_applications has required columns', () => {
  const db = makeInMemDb();
  const cols = db.pragma('table_info(checkpoint_applications)') as { name: string }[];
  const names = cols.map(c => c.name);
  for (const col of [
    'decision_id', 'workflow_run_id', 'workflow_id', 'step_id', 'iteration',
    'revision_before', 'selected_option_id', 'rationale', 'state',
    'continuation_step_id', 'remain_at_checkpoint', 'increment_revision',
    'cancel', 'started_at', 'applied_at',
  ]) {
    assert.ok(names.includes(col), `column '${col}' should exist`);
  }
  db.close();
});

// ── FK integrity ──────────────────────────────────────────────────────────────

test('FK integrity: inserting with non-existent decision_id fails', () => {
  const db = makeInMemDb();
  assert.throws(
    () => {
      db.prepare(`
        INSERT INTO checkpoint_applications
          (decision_id, workflow_run_id, workflow_id, step_id, iteration,
           revision_before, selected_option_id, state, started_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'applying', ?)
      `).run('no-such-decision', 'no-such-run', 'wf', 'step', 1, 0, 'approve', new Date().toISOString());
    },
    /FOREIGN KEY|foreign key/i,
    'should reject missing decision FK',
  );
  db.close();
});

// ── createOrLoadApplying: basic idempotency ───────────────────────────────────

test('createOrLoadApplying: inserts APPLYING row and returns it', () => {
  const db = makeInMemDb();
  const seed = seedRequiredRows(db);
  const repo = new CheckpointApplicationRepository(db);

  const row = repo.createOrLoadApplying(makeInput(seed));

  assert.equal(row.state, 'applying');
  assert.equal(row.decisionId, seed.decisionId);
  assert.equal(row.selectedOptionId, 'approve');
  assert.equal(row.rationale, null);
  db.close();
});

test('createOrLoadApplying: same input twice returns same row (idempotent)', () => {
  const db = makeInMemDb();
  const seed = seedRequiredRows(db);
  const repo = new CheckpointApplicationRepository(db);
  const input = makeInput(seed);

  const row1 = repo.createOrLoadApplying(input);
  const row2 = repo.createOrLoadApplying(input);

  assert.equal(row1.decisionId, row2.decisionId);
  assert.equal(row1.state, row2.state);
  assert.equal(row1.startedAt, row2.startedAt);
  db.close();
});

// ── createOrLoadApplying: conflict detection ──────────────────────────────────

test('createOrLoadApplying: different selectedOptionId → CheckpointApplicationConflictError', () => {
  const db = makeInMemDb();
  const seed = seedRequiredRows(db);
  const repo = new CheckpointApplicationRepository(db);

  repo.createOrLoadApplying(makeInput(seed, { selectedOptionId: 'approve' }));

  assert.throws(
    () => repo.createOrLoadApplying(makeInput(seed, { selectedOptionId: 'revise' })),
    CheckpointApplicationConflictError,
    'should fail closed on option mismatch',
  );
  db.close();
});

test('createOrLoadApplying: rationale mismatch → CheckpointApplicationConflictError', () => {
  const db = makeInMemDb();
  const seed = seedRequiredRows(db);
  const repo = new CheckpointApplicationRepository(db);

  repo.createOrLoadApplying(makeInput(seed, { rationale: 'reason-A' }));

  assert.throws(
    () => repo.createOrLoadApplying(makeInput(seed, { rationale: 'reason-B' })),
    CheckpointApplicationConflictError,
    'should fail closed on rationale mismatch',
  );
  db.close();
});

test('createOrLoadApplying: null and undefined rationale treated as same (no conflict)', () => {
  const db = makeInMemDb();
  const seed = seedRequiredRows(db);
  const repo = new CheckpointApplicationRepository(db);

  repo.createOrLoadApplying(makeInput(seed, { rationale: undefined }));
  // Should NOT throw — undefined normalizes to null
  const row = repo.createOrLoadApplying(makeInput(seed, { rationale: undefined }));
  assert.equal(row.rationale, null);
  db.close();
});

test('createOrLoadApplying: step_id mismatch → CheckpointApplicationConflictError', () => {
  const db = makeInMemDb();
  const seed = seedRequiredRows(db);
  const repo = new CheckpointApplicationRepository(db);

  repo.createOrLoadApplying(makeInput(seed, { stepId: 'confirm' }));

  assert.throws(
    () => repo.createOrLoadApplying(makeInput(seed, { stepId: 'scoping.checkpoint' })),
    CheckpointApplicationConflictError,
  );
  db.close();
});

test('createOrLoadApplying: iteration mismatch → CheckpointApplicationConflictError', () => {
  const db = makeInMemDb();
  const seed = seedRequiredRows(db);
  const repo = new CheckpointApplicationRepository(db);

  repo.createOrLoadApplying(makeInput(seed, { iteration: 1 }));

  assert.throws(
    () => repo.createOrLoadApplying(makeInput(seed, { iteration: 2 })),
    CheckpointApplicationConflictError,
  );
  db.close();
});

// ── markApplied: state transition ─────────────────────────────────────────────

test('markApplied: APPLYING → APPLIED succeeds and stores resolution', () => {
  const db = makeInMemDb();
  const seed = seedRequiredRows(db);
  const repo = new CheckpointApplicationRepository(db);

  repo.createOrLoadApplying(makeInput(seed));
  repo.markApplied(seed.decisionId, {
    continuationStepId: 'build',
    remainAtCheckpoint: false,
    incrementRevision: false,
    cancel: false,
  });

  const row = repo.findByDecisionId(seed.decisionId)!;
  assert.equal(row.state, 'applied');
  assert.equal(row.continuationStepId, 'build');
  assert.equal(row.remainAtCheckpoint, false);
  assert.equal(row.incrementRevision, false);
  assert.equal(row.cancel, false);
  assert.ok(row.appliedAt !== null, 'appliedAt should be set');
  db.close();
});

test('markApplied: APPLIED row with same resolution is idempotent (no conflict)', () => {
  const db = makeInMemDb();
  const seed = seedRequiredRows(db);
  const repo = new CheckpointApplicationRepository(db);
  const resolution = { continuationStepId: 'test', remainAtCheckpoint: false, incrementRevision: true, cancel: false };

  repo.createOrLoadApplying(makeInput(seed));
  repo.markApplied(seed.decisionId, resolution);

  // Calling markApplied again with the same resolution is idempotent.
  assert.doesNotThrow(() => repo.markApplied(seed.decisionId, resolution));
  db.close();
});

test('markApplied: APPLIED resolution cannot be rewritten with different values', () => {
  const db = makeInMemDb();
  const seed = seedRequiredRows(db);
  const repo = new CheckpointApplicationRepository(db);

  repo.createOrLoadApplying(makeInput(seed));
  repo.markApplied(seed.decisionId, { continuationStepId: 'build', remainAtCheckpoint: false, incrementRevision: false, cancel: false });

  assert.throws(
    () => repo.markApplied(seed.decisionId, { continuationStepId: 'test', remainAtCheckpoint: false, incrementRevision: true, cancel: false }),
    CheckpointApplicationConflictError,
    'should fail closed on resolution rewrite attempt',
  );
  db.close();
});

// ── Resolution flags persist correctly ───────────────────────────────────────

test('APPLIED row returns correct continuation/revision/cancel flags (revise case)', () => {
  const db = makeInMemDb();
  const seed = seedRequiredRows(db);
  const repo = new CheckpointApplicationRepository(db);

  repo.createOrLoadApplying(makeInput(seed, { selectedOptionId: 'revise' }));
  repo.markApplied(seed.decisionId, {
    continuationStepId: 'test',
    remainAtCheckpoint: false,
    incrementRevision: true,
    cancel: false,
  });

  const row = repo.findByDecisionId(seed.decisionId)!;
  assert.equal(row.continuationStepId, 'test');
  assert.equal(row.incrementRevision, true);
  assert.equal(row.cancel, false);
  assert.equal(row.remainAtCheckpoint, false);
  db.close();
});

test('APPLIED row returns correct flags for cancel case', () => {
  const db = makeInMemDb();
  const seed = seedRequiredRows(db);
  const repo = new CheckpointApplicationRepository(db);

  repo.createOrLoadApplying(makeInput(seed, { selectedOptionId: 'reject' }));
  repo.markApplied(seed.decisionId, {
    continuationStepId: null,
    remainAtCheckpoint: false,
    incrementRevision: false,
    cancel: true,
  });

  const row = repo.findByDecisionId(seed.decisionId)!;
  assert.equal(row.cancel, true);
  assert.equal(row.continuationStepId, null);
  db.close();
});

// ── Exact resolution survives DB reopen ───────────────────────────────────────

test('Exact resolution survives DB reopen/restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sle-ckpt-store-'));
  const dbPath = join(dir, 'test.db');
  try {
    let seed: SeedResult;
    {
      const db = openDatabase(dbPath);
      seed = seedRequiredRows(db);
      const repo = new CheckpointApplicationRepository(db);
      repo.createOrLoadApplying(makeInput(seed, { selectedOptionId: 'revise', rationale: 'review-needed' }));
      repo.markApplied(seed.decisionId, {
        continuationStepId: 'test',
        remainAtCheckpoint: false,
        incrementRevision: true,
        cancel: false,
      });
      db.close();
    }

    // Reopen.
    {
      const db2 = openDatabase(dbPath);
      const repo2 = new CheckpointApplicationRepository(db2);
      const row = repo2.findByDecisionId(seed.decisionId)!;

      assert.ok(row, 'row should survive DB reopen');
      assert.equal(row.state, 'applied');
      assert.equal(row.selectedOptionId, 'revise');
      assert.equal(row.rationale, 'review-needed');
      assert.equal(row.continuationStepId, 'test');
      assert.equal(row.incrementRevision, true);
      assert.equal(row.cancel, false);
      assert.equal(row.remainAtCheckpoint, false);
      db2.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── createOrLoadApplying on APPLIED row returns it unchanged ──────────────────

test('createOrLoadApplying on an already-APPLIED row returns the APPLIED row', () => {
  const db = makeInMemDb();
  const seed = seedRequiredRows(db);
  const repo = new CheckpointApplicationRepository(db);
  const input = makeInput(seed);

  repo.createOrLoadApplying(input);
  repo.markApplied(seed.decisionId, {
    continuationStepId: 'build',
    remainAtCheckpoint: false,
    incrementRevision: false,
    cancel: false,
  });

  // Re-calling createOrLoadApplying with same identity → returns APPLIED row.
  const row = repo.createOrLoadApplying(input);
  assert.equal(row.state, 'applied');
  assert.equal(row.continuationStepId, 'build');
  db.close();
});
