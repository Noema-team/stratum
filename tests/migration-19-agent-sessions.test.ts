import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MIGRATIONS, runMigrations } from '../src/storage/database.js';

const workspaceId = '91000000-0000-4000-8000-000000000001';
const projectId = '91000000-0000-4000-8000-000000000002';
const repositoryId = '91000000-0000-4000-8000-000000000003';
const processId = '91000000-0000-4000-8000-000000000004';
const runtimeWorkspaceId = '91000000-0000-4000-8000-000000000005';
const sessionId = '91000000-0000-4000-8000-000000000006';
const now = '2026-10-23T12:00:00.000Z';

function atVersion18(db: Database.Database): void {
  db.pragma('foreign_keys = ON');
  runMigrations(db, 18);
  assert.equal((db.prepare('SELECT MAX(id) AS id FROM _migrations').get() as { id: number }).id, 18);
  assert.equal(MIGRATIONS.length, 19);
}

function seedV18AgentRecords(db: Database.Database, withDanglingEvent = false): void {
  db.prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)').run(workspaceId, 'Workspace', now);
  db.prepare(`INSERT INTO projects (id,workspace_id,name,status,priority,created_at,updated_at)
    VALUES (?,?,?,'active',0,?,?)`).run(projectId, workspaceId, 'Project', now, now);
  db.prepare(`INSERT INTO repositories (id,project_id,provider,remote,default_branch,local_workspace,status,canonical_identity)
    VALUES (?,?, 'github','https://github.com/example/project.git','main','/old/checkout','active','github:example/project')`)
    .run(repositoryId, projectId);
  db.prepare('INSERT INTO project_repositories (project_id,repository_id,linked_at) VALUES (?,?,?)').run(projectId, repositoryId, now);
  db.prepare(`INSERT INTO app_processes (id,project_id,title,intent,desired_outcomes_json,constraints_json,lifecycle,current_focus,created_at,updated_at)
    VALUES (?,?, 'Investigate','Understand the codebase','[]','[]','active','Investigating',?,?)`).run(processId, projectId, now, now);
  db.prepare('INSERT INTO app_process_repositories (process_id,repository_id) VALUES (?,?)').run(processId, repositoryId);
  db.prepare(`INSERT INTO app_runtime_workspaces (id,project_id,process_id,repository_id,host_path,repository_commit,access_mode,engine_state_path,status,created_at)
    VALUES (?,?,?,?,?,?,'read_only',?,'ready',?)`).run(runtimeWorkspaceId, projectId, processId, repositoryId, '/old/runtime/workspace', 'a'.repeat(40), '/old/runtime/session', now);
  db.prepare(`INSERT INTO app_agent_sessions (id,project_id,process_id,workspace_id,engine,engine_session_id,lifecycle,created_by,created_at,updated_at,last_event_seq)
    VALUES (?,?,?,?,? ,?,'outcome_unknown','local-user',?,?,1)`)
    .run(sessionId, projectId, processId, runtimeWorkspaceId, 'goose-acp', 'goose-native-session', now, now);
  db.prepare(`INSERT INTO app_agent_session_events (session_id,seq,event_type,payload_json,created_at)
    VALUES (?,1,'agent_message_complete','{"text":"preserve this event"}',?)`).run(sessionId, now);
  db.prepare(`INSERT INTO app_agent_session_operations (id,session_id,idempotency_key,kind,prompt_text,status,created_at,updated_at)
    VALUES ('91000000-0000-4000-8000-000000000007',?,'prompt-key','prompt','Preserve this uncertain prompt','outcome_unknown',?,?)`)
    .run(sessionId, now, now);
  db.prepare(`INSERT INTO app_agent_session_permissions (id,session_id,engine_request_id,operation_json,status,created_at,decided_at,decided_by)
    VALUES ('91000000-0000-4000-8000-000000000008',?,'goose-request','{"path":"/workspace/README.md"}','interrupted',?,?,'local-user')`)
    .run(sessionId, now, now);
  if (withDanglingEvent) {
    db.pragma('foreign_keys = OFF');
    db.prepare(`INSERT INTO app_agent_session_events (session_id,seq,event_type,payload_json,created_at)
      VALUES ('missing-agent-session',1,'corrupt_fixture','{}',?)`).run(now);
    db.pragma('foreign_keys = ON');
  }
}

function preservedRows(db: Database.Database) {
  return {
    session: db.prepare(`SELECT id,project_id,process_id,workspace_id,engine,engine_session_id,lifecycle,error_message,
      created_by,created_at,updated_at,last_event_seq FROM app_agent_sessions WHERE id=?`).get(sessionId),
    workspace: db.prepare(`SELECT id,project_id,process_id,repository_id,host_path,repository_commit,access_mode,
      engine_state_path,status,created_at,closed_at FROM app_runtime_workspaces WHERE id=?`).get(runtimeWorkspaceId),
    events: db.prepare('SELECT * FROM app_agent_session_events WHERE session_id=? ORDER BY seq').all(sessionId),
    operations: db.prepare('SELECT * FROM app_agent_session_operations WHERE session_id=? ORDER BY id').all(sessionId),
    permissions: db.prepare('SELECT * FROM app_agent_session_permissions WHERE session_id=? ORDER BY id').all(sessionId),
  };
}

test('Migration 19 preserves Process-owned AgentSession records and active-session uniqueness', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'stratum-migration-19-'));
  const db = new Database(path.join(root, 'upgrade.db'));
  try {
    atVersion18(db);
    seedV18AgentRecords(db);
    const before = preservedRows(db);

    runMigrations(db);

    assert.deepEqual(preservedRows(db), before);
    assert.equal((db.prepare('SELECT associated_process_id FROM app_agent_sessions WHERE id=?').get(sessionId) as { associated_process_id: string }).associated_process_id, processId);
    assert.equal((db.prepare('SELECT workspace_mode FROM app_runtime_workspaces WHERE id=?').get(runtimeWorkspaceId) as { workspace_mode: string }).workspace_mode, 'repository_snapshot');
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    assert.equal((db.pragma('foreign_key_list(app_agent_session_events)') as Array<{ table: string }>).some(row => row.table === 'app_agent_sessions'), true);

    const secondWorkspaceId = '91000000-0000-4000-8000-000000000009';
    const secondSessionId = '91000000-0000-4000-8000-00000000000a';
    db.prepare(`INSERT INTO app_runtime_workspaces (id,project_id,process_id,repository_id,workspace_mode,host_path,repository_commit,
      access_mode,engine_state_path,status,created_at) VALUES (?,?,NULL,NULL,'empty',?,NULL,'read_only',?,'ready',?)`)
      .run(secondWorkspaceId, projectId, '/private/session/workspace', '/private/session', now);
    db.prepare(`INSERT INTO app_agent_sessions (id,project_id,process_id,associated_process_id,workspace_id,engine,lifecycle,created_by,created_at,updated_at)
      VALUES (?,?,NULL,?,?, 'goose-acp','idle','local-user',?,?)`)
      .run(secondSessionId, projectId, processId, secondWorkspaceId, now, now);
    assert.equal((db.prepare('SELECT count(*) AS count FROM app_agent_sessions WHERE associated_process_id=? AND process_id IS NULL').get(processId) as { count: number }).count, 1);

    const duplicateWorkspaceId = '91000000-0000-4000-8000-00000000000b';
    db.prepare(`INSERT INTO app_runtime_workspaces (id,project_id,process_id,repository_id,workspace_mode,host_path,repository_commit,
      access_mode,engine_state_path,status,created_at) VALUES (?,?,?,?, 'repository_snapshot',?,?,'read_only',?,'ready',?)`)
      .run(duplicateWorkspaceId, projectId, processId, repositoryId, '/other/workspace', 'b'.repeat(40), '/other/state', now);
    assert.throws(() => db.prepare(`INSERT INTO app_agent_sessions
      (id,project_id,process_id,associated_process_id,workspace_id,engine,lifecycle,created_by,created_at,updated_at)
      VALUES (?,?, ?, ?, ?, 'goose-acp','running','local-user',?,?)`)
      .run('91000000-0000-4000-8000-00000000000c', projectId, processId, processId, duplicateWorkspaceId, now, now), /UNIQUE constraint failed/);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('Migration 19 failure after table rebuild rolls back schema, data and ledger, then can retry', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'stratum-migration-19-rollback-'));
  const db = new Database(path.join(root, 'rollback.db'));
  try {
    atVersion18(db);
    seedV18AgentRecords(db, true);
    const before = preservedRows(db);
    const violationsBefore = db.pragma('foreign_key_check');
    const schemaBefore = db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_schema
      WHERE tbl_name IN ('app_runtime_workspaces','app_agent_sessions','app_agent_session_events',
        'app_agent_session_operations','app_agent_session_permissions','_migrations') ORDER BY type,name`).all();
    const ledgerBefore = db.prepare('SELECT id,applied_at FROM _migrations ORDER BY id').all();
    assert.equal(violationsBefore.length, 1);

    assert.throws(() => runMigrations(db), /Migration 19 introduced FK violations/);

    assert.deepEqual(preservedRows(db), before);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM _migrations WHERE id=19').get() as { count: number }).count, 0);
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
    assert.equal((db.pragma('table_info(app_agent_sessions)') as Array<{ name: string }>).some(row => row.name === 'associated_process_id'), false);
    assert.equal((db.pragma('table_info(app_runtime_workspaces)') as Array<{ name: string }>).some(row => row.name === 'workspace_mode'), false);
    assert.deepEqual(db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_schema
      WHERE tbl_name IN ('app_runtime_workspaces','app_agent_sessions','app_agent_session_events',
        'app_agent_session_operations','app_agent_session_permissions','_migrations') ORDER BY type,name`).all(), schemaBefore);
    assert.deepEqual(db.prepare('SELECT id,applied_at FROM _migrations ORDER BY id').all(), ledgerBefore);
    assert.deepEqual(db.pragma('foreign_key_check'), violationsBefore);

    db.prepare(`DELETE FROM app_agent_session_events WHERE session_id='missing-agent-session'`).run();
    runMigrations(db);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM _migrations WHERE id=19').get() as { count: number }).count, 1);
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    assert.deepEqual(preservedRows(db), before);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
