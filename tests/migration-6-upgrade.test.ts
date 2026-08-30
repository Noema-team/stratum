/**
 * Migration 6 upgrade tests.
 *
 * 1. Happy path: a pre-M6 database with valid FK references survives Migration 6
 *    without data loss or FK violations.
 *
 * 2. Atomicity regression: a pre-M6 database with an orphaned workflow_run
 *    (work_item_id referencing a non-existent work_item) must cause Migration 6
 *    to fail, roll back the schema change, and leave M6 absent from _migrations.
 */

import { test } from 'node:test';
import { strict as assert } from 'assert';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import Database from 'better-sqlite3';
import { openDatabase } from '../src/storage/database.js';

// Apply only migrations 1–5 (exclude migration 6) to simulate a pre-M6 database.
function openDatabaseUpToMigration5(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Bootstrap migration tracker.
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id         INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  // We can't easily re-run the migration runner with a subset, so we reproduce
  // the schema manually up to migration 5 (step_executions without 'waiting',
  // workflow_runs without FK).  This exactly mirrors what a real database running
  // migrations 1-5 would look like.
  db.exec(`
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      name TEXT NOT NULL, description TEXT,
      status TEXT NOT NULL CHECK(status IN ('active','paused','archived')),
      priority INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE repositories (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
      provider TEXT NOT NULL CHECK(provider IN ('github')),
      remote TEXT NOT NULL, default_branch TEXT NOT NULL,
      local_workspace TEXT,
      status TEXT NOT NULL CHECK(status IN ('active','disabled'))
    );
    CREATE TABLE objectives (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
      title TEXT NOT NULL, description TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK(status IN ('draft','active','completed','cancelled')),
      constraints_json TEXT NOT NULL DEFAULT '[]',
      success_criteria_json TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE work_items (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
      objective_id TEXT REFERENCES objectives(id),
      repository_ids_json TEXT NOT NULL DEFAULT '[]',
      title TEXT NOT NULL, goal TEXT NOT NULL, workflow_id TEXT NOT NULL,
      state TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0,
      acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
      constraints_json TEXT NOT NULL DEFAULT '[]',
      required_evidence_json TEXT NOT NULL DEFAULT '[]',
      parent_id TEXT REFERENCES work_items(id),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE work_dependencies (
      work_item_id TEXT NOT NULL REFERENCES work_items(id),
      depends_on_id TEXT NOT NULL REFERENCES work_items(id),
      PRIMARY KEY (work_item_id, depends_on_id)
    );
    CREATE TABLE step_executions (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL REFERENCES work_items(id),
      workflow_run_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      executor TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('dispatched','running','succeeded','failed','cancelled')),
      attempt INTEGER NOT NULL DEFAULT 1 CHECK(attempt >= 1),
      started_at TEXT, completed_at TEXT, cost_json TEXT, tokens INTEGER, failure_json TEXT
    );
    CREATE TABLE decisions (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
      work_item_id TEXT REFERENCES work_items(id), type TEXT NOT NULL,
      subject_ref_json TEXT NOT NULL DEFAULT '{}',
      title TEXT NOT NULL, summary TEXT NOT NULL,
      options_json TEXT NOT NULL DEFAULT '[]',
      recommended_option_id TEXT, recommendation_reason TEXT,
      impact TEXT NOT NULL CHECK(impact IN ('low','medium','high','critical')),
      reversibility TEXT NOT NULL CHECK(reversibility IN ('easy','moderate','hard','irreversible')),
      urgency TEXT NOT NULL CHECK(urgency IN ('low','normal','high','immediate')),
      status TEXT NOT NULL CHECK(status IN ('pending','resolved','rejected','expired')),
      resolution_json TEXT
    );
    CREATE TABLE evidence (
      id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL REFERENCES work_items(id),
      step_execution_id TEXT REFERENCES step_executions(id),
      type TEXT NOT NULL, source TEXT NOT NULL,
      candidate_ref TEXT, collector_id TEXT, subject_ref TEXT,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL, collected_at TEXT NOT NULL
    );
    CREATE TABLE artifacts (
      id TEXT PRIMARY KEY,
      work_item_id TEXT REFERENCES work_items(id),
      workflow_run_id TEXT,
      step_execution_id TEXT REFERENCES step_executions(id),
      type TEXT NOT NULL, ref TEXT, path TEXT, hash TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE events (
      id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL DEFAULT 1,
      type TEXT NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      project_id TEXT REFERENCES projects(id),
      work_item_id TEXT REFERENCES work_items(id),
      workflow_run_id TEXT, occurred_at TEXT NOT NULL, payload_json TEXT NOT NULL
    );
    CREATE TABLE policies (project_id TEXT PRIMARY KEY, config_json TEXT NOT NULL);
    CREATE TABLE scheduler_leases (
      id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL REFERENCES work_items(id),
      repository_id TEXT, lease_type TEXT NOT NULL CHECK(lease_type IN ('write','read')),
      acquired_at TEXT NOT NULL, expires_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL
    );
    CREATE TABLE api_tokens (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL, expires_at TEXT, last_used_at TEXT, revoked_at TEXT
    );
    CREATE TABLE audit_events (
      id TEXT PRIMARY KEY, token_id TEXT REFERENCES api_tokens(id),
      action TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT NOT NULL,
      details_json TEXT, ip_address TEXT, occurred_at TEXT NOT NULL
    );
    CREATE TABLE notification_channels (
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('webhook')),
      config_json TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
    );
    CREATE TABLE workflow_runs (
      run_id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL,
      work_item_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('active','halted','complete')),
      current_step_id TEXT NOT NULL,
      iteration INTEGER NOT NULL DEFAULT 1, revision INTEGER NOT NULL DEFAULT 0,
      awaiting_checkpoint TEXT, started_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    INSERT INTO _migrations VALUES (1, '2025-01-01T00:00:00.000Z');
    INSERT INTO _migrations VALUES (2, '2025-01-01T00:00:00.000Z');
    INSERT INTO _migrations VALUES (3, '2025-01-01T00:00:00.000Z');
    INSERT INTO _migrations VALUES (4, '2025-01-01T00:00:00.000Z');
    INSERT INTO _migrations VALUES (5, '2025-01-01T00:00:00.000Z');
  `);

  return db;
}

test('testMigration6PreservesExistingRowsAndFKIntegrity', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'stratum-migration6-'));
  const dbPath = join(tmpDir, 'stratum.db');

  try {
    // Build a pre-migration-6 database with real rows.
    const dbPre = openDatabaseUpToMigration5(dbPath);
    const now = '2025-06-01T00:00:00.000Z';

    dbPre.exec(`
      INSERT INTO workspaces VALUES ('ws-m6', 'workspace', '${now}');
      INSERT INTO projects VALUES ('proj-m6', 'ws-m6', 'project', NULL, 'active', 0, '${now}', '${now}');
      INSERT INTO work_items VALUES (
        'wi-m6', 'proj-m6', NULL, '[]', 'item', 'goal', 'wf-m6',
        'running', 0, '[]', '[]', '[]', NULL, '${now}', '${now}'
      );
    `);

    // Insert a step_execution (pre-M6: no 'waiting' state allowed).
    dbPre.exec(`
      INSERT INTO step_executions
        (id, work_item_id, workflow_run_id, step_id, executor, state, attempt, started_at)
      VALUES ('se-m6', 'wi-m6', 'run-m6', 'step-1', 'test-adapter', 'succeeded', 1, '${now}');
    `);

    // Insert evidence referencing the step_execution.
    dbPre.exec(`
      INSERT INTO evidence
        (id, work_item_id, step_execution_id, type, source, status, payload_json, collected_at)
      VALUES ('ev-m6', 'wi-m6', 'se-m6', 'test', 'test', 'valid', '{}', '${now}');
    `);

    // Insert artifact referencing the step_execution.
    dbPre.exec(`
      INSERT INTO artifacts (id, work_item_id, step_execution_id, type, created_at)
      VALUES ('art-m6', 'wi-m6', 'se-m6', 'output', '${now}');
    `);

    // Insert a workflow_run (pre-M6: no FK on work_item_id).
    dbPre.exec(`
      INSERT INTO workflow_runs
        (run_id, workflow_id, work_item_id, status, current_step_id, iteration, revision,
         awaiting_checkpoint, started_at, updated_at)
      VALUES ('run-m6', 'wf-m6', 'wi-m6', 'active', 'step-1', 1, 0, NULL, '${now}', '${now}');
    `);

    dbPre.close();

    // Now open with the full migration runner — should apply migration 6 cleanly.
    const dbPost = openDatabase(dbPath);

    // Evidence and artifact rows must still be present and referencing the
    // renamed step_executions table (FK preserved through table recreation).
    const ev = dbPost.prepare('SELECT * FROM evidence WHERE id = ?').get('ev-m6') as any;
    assert.ok(ev, 'evidence row must survive migration 6');
    assert.equal(ev.step_execution_id, 'se-m6', 'evidence.step_execution_id must be preserved');

    const art = dbPost.prepare('SELECT * FROM artifacts WHERE id = ?').get('art-m6') as any;
    assert.ok(art, 'artifact row must survive migration 6');
    assert.equal(art.step_execution_id, 'se-m6', 'artifact.step_execution_id must be preserved');

    // StepExecution row must still be present.
    const se = dbPost.prepare('SELECT * FROM step_executions WHERE id = ?').get('se-m6') as any;
    assert.ok(se, 'step_execution row must survive migration 6');
    assert.equal(se.state, 'succeeded');

    // WorkflowRun must still be present with FK intact.
    const run = dbPost.prepare('SELECT * FROM workflow_runs WHERE run_id = ?').get('run-m6') as any;
    assert.ok(run, 'workflow_run row must survive migration 6');
    assert.equal(run.work_item_id, 'wi-m6');
    assert.equal(run.status, 'active');

    // The new 'waiting' state must be accepted after migration 6.
    dbPost.prepare(`
      INSERT INTO step_executions
        (id, work_item_id, workflow_run_id, step_id, executor, state, attempt, started_at)
      VALUES ('se-waiting', 'wi-m6', 'run-m6', 'ck-1', 'test-adapter', 'waiting', 1, ?)
    `).run(now);
    const seWaiting = dbPost.prepare('SELECT state FROM step_executions WHERE id = ?').get('se-waiting') as any;
    assert.equal(seWaiting.state, 'waiting', 'waiting state must be accepted after migration 6');

    dbPost.close();
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// Migration atomicity regression: orphaned workflow_run must cause M6 to fail
// atomically — schema rollback + absent _migrations row.
// ============================================================================

test('testMigration6AtomicityWithOrphanedWorkflowRun', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'stratum-migration6-atom-'));
  const dbPath = join(tmpDir, 'stratum.db');

  try {
    // Build pre-M6 schema with an ORPHANED workflow_run (work_item_id references
    // a work_item that does not exist). Migration 6 must detect this violation
    // via PRAGMA foreign_key_check and roll back entirely.
    const dbPre = openDatabaseUpToMigration5(dbPath);
    const now = '2025-06-01T00:00:00.000Z';

    dbPre.exec(`
      INSERT INTO workspaces VALUES ('ws-atom', 'workspace', '${now}');
      INSERT INTO projects VALUES ('proj-atom', 'ws-atom', 'project', NULL, 'active', 0, '${now}', '${now}');
      -- Intentionally orphaned: 'wi-MISSING' does not exist in work_items.
      INSERT INTO workflow_runs
        (run_id, workflow_id, work_item_id, status, current_step_id, iteration, revision,
         awaiting_checkpoint, started_at, updated_at)
      VALUES ('run-orphan', 'wf-1', 'wi-MISSING', 'active', 'step-1', 1, 0, NULL, '${now}', '${now}');
    `);
    dbPre.close();

    // Attempting to apply migration 6 must throw (FK violation detected inside
    // the transaction, causing the whole migration to roll back).
    assert.throws(
      () => openDatabase(dbPath),
      /FK violations/,
      'openDatabase must throw when migration 6 would introduce FK violations',
    );

    // Verify M6 is absent from _migrations — the migration runner must not have
    // committed the tracking row.
    const dbCheck = new Database(dbPath);
    try {
      const row = dbCheck
        .prepare('SELECT COUNT(*) as cnt FROM _migrations WHERE id = 6')
        .get() as { cnt: number };
      assert.equal(row.cnt, 0, 'Migration 6 must NOT be recorded in _migrations after rollback');

      // The workflow_runs table must still have no FK constraint (pre-M6 schema):
      // the CREATE TABLE workflow_runs_v6 DDL was rolled back.
      const tableInfo = dbCheck
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='workflow_runs'")
        .get() as { sql: string } | undefined;
      assert.ok(tableInfo, 'workflow_runs table must still exist after failed migration');
      assert.ok(
        !tableInfo.sql.includes('REFERENCES work_items'),
        'workflow_runs must NOT have FK on work_item_id after rolled-back migration',
      );
    } finally {
      dbCheck.close();
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
