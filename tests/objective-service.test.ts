/**
 * D.2 / D.2.1 — ObjectiveService.
 *
 * Objective is the durable human-intent container above WorkItems:
 *   Project -> Objective -> WorkItems
 * These tests cover the service directly (create/read/list, malformed
 * nested-data rejection, guarded lifecycle, workspace isolation, real
 * file-backed restart persistence, migration-compatibility backfill).
 * WorkItem linkage validation lives in tests/commit-b.test.ts
 * (WorkService.createWorkItem); the /projects/:id/objectives and
 * /objectives/:id HTTP routes (including the D.2.1 malformed-payload
 * case) are covered in tests/api.test.ts.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import { openDatabase, MIGRATIONS } from '../src/storage/database.js';
import { WorkspaceRepository, ProjectRepository, ObjectiveRepository } from '../src/storage/repositories.js';
import { ObjectiveService, ObjectiveServiceError } from '../src/services/objective-service.js';
import type { Workspace, Project } from '../src/domain/index.js';

function makeDb() { return openDatabase(':memory:'); }

function seedWorkspace(db: ReturnType<typeof makeDb>): string {
  const wsId = randomUUID();
  new WorkspaceRepository(db).save({ id: wsId, name: 'ws', createdAt: new Date().toISOString() } as Workspace);
  return wsId;
}

function seedProject(db: ReturnType<typeof makeDb>, wsId: string): string {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  new ProjectRepository(db).save({
    id: projectId, workspaceId: wsId, name: 'proj',
    status: 'active', priority: 0, createdAt: now, updatedAt: now,
  } as Project);
  return projectId;
}

// ============================================================================
// Create / read / list
// ============================================================================

test('D.2: create() persists an Objective in draft status', () => {
  const db = makeDb();
  const wsId = seedWorkspace(db);
  const projectId = seedProject(db, wsId);
  const svc = new ObjectiveService(db, wsId);

  const objective = svc.create({ projectId, title: 'Make Evershift multiplayer-capable', description: 'desc' });

  assert.equal(objective.projectId, projectId);
  assert.equal(objective.status, 'draft');
  assert.equal(objective.priority, 0);
  assert.deepEqual(objective.constraints, []);
  assert.deepEqual(objective.successCriteria, []);
  assert.ok(objective.createdAt);
  assert.ok(objective.updatedAt);
  db.close();
});

test('D.2: create() retains supplied priority/constraints/successCriteria', () => {
  const db = makeDb();
  const wsId = seedWorkspace(db);
  const projectId = seedProject(db, wsId);
  const svc = new ObjectiveService(db, wsId);

  const objective = svc.create({
    projectId, title: 'T', description: 'D', priority: 5,
    constraints: [{ description: 'must not break X' }],
    successCriteria: [{ description: 'Y is achieved' }],
  });

  assert.equal(objective.priority, 5);
  assert.equal(objective.constraints.length, 1);
  assert.equal(objective.successCriteria.length, 1);
  db.close();
});

test('D.2: findById() retrieves a created Objective', () => {
  const db = makeDb();
  const wsId = seedWorkspace(db);
  const projectId = seedProject(db, wsId);
  const svc = new ObjectiveService(db, wsId);

  const created = svc.create({ projectId, title: 'T', description: 'D' });
  const fetched = svc.findById(created.id);

  assert.deepEqual(fetched, created);
  db.close();
});

test('D.2: listByProject() lists Objectives for that Project', () => {
  const db = makeDb();
  const wsId = seedWorkspace(db);
  const projectId = seedProject(db, wsId);
  const svc = new ObjectiveService(db, wsId);

  svc.create({ projectId, title: 'A', description: 'D' });
  svc.create({ projectId, title: 'B', description: 'D' });

  const list = svc.listByProject(projectId);
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((o) => o.title).sort(), ['A', 'B']);
  db.close();
});

test('D.2: create() rejects an empty title', () => {
  const db = makeDb();
  const wsId = seedWorkspace(db);
  const projectId = seedProject(db, wsId);
  const svc = new ObjectiveService(db, wsId);

  assert.throws(() => svc.create({ projectId, title: '  ', description: 'D' }), /title/i);
  db.close();
});

test('D.2: create() rejects an empty description', () => {
  const db = makeDb();
  const wsId = seedWorkspace(db);
  const projectId = seedProject(db, wsId);
  const svc = new ObjectiveService(db, wsId);

  assert.throws(() => svc.create({ projectId, title: 'T', description: '' }), /description/i);
  db.close();
});

// ============================================================================
// D.2.1 — nested-element validation via ObjectiveSchema (not hand-rolled)
// ============================================================================

test('D.2.1: create() rejects constraints containing null', () => {
  const db = makeDb();
  const wsId = seedWorkspace(db);
  const projectId = seedProject(db, wsId);
  const svc = new ObjectiveService(db, wsId);

  assert.throws(
    () => svc.create({ projectId, title: 'T', description: 'D', constraints: [null as any] }),
    ObjectiveServiceError,
  );
  assert.equal(new ObjectiveRepository(db).listByProject(projectId).length, 0, 'nothing must be persisted');
  db.close();
});

test('D.2.1: create() rejects a constraint object missing the required description field', () => {
  const db = makeDb();
  const wsId = seedWorkspace(db);
  const projectId = seedProject(db, wsId);
  const svc = new ObjectiveService(db, wsId);

  assert.throws(
    () => svc.create({ projectId, title: 'T', description: 'D', constraints: [{ foo: 'bar' } as any] }),
    ObjectiveServiceError,
  );
  db.close();
});

test('D.2.1: create() rejects a successCriteria object missing the required description field', () => {
  const db = makeDb();
  const wsId = seedWorkspace(db);
  const projectId = seedProject(db, wsId);
  const svc = new ObjectiveService(db, wsId);

  assert.throws(
    () => svc.create({ projectId, title: 'T', description: 'D', successCriteria: [{ met: true } as any] }),
    ObjectiveServiceError,
  );
  db.close();
});

test('D.2.1: create() rejects a constraint with an invalid type enum value', () => {
  const db = makeDb();
  const wsId = seedWorkspace(db);
  const projectId = seedProject(db, wsId);
  const svc = new ObjectiveService(db, wsId);

  assert.throws(
    () => svc.create({
      projectId, title: 'T', description: 'D',
      constraints: [{ description: 'x', type: 'not-a-real-type' } as any],
    }),
    ObjectiveServiceError,
  );
  db.close();
});

test('D.2.1: a rejected create() surfaces an ObjectiveServiceError, not a raw ZodError', () => {
  const db = makeDb();
  const wsId = seedWorkspace(db);
  const projectId = seedProject(db, wsId);
  const svc = new ObjectiveService(db, wsId);

  try {
    svc.create({ projectId, title: 'T', description: 'D', constraints: [null as any] });
    assert.fail('expected create() to throw');
  } catch (e) {
    assert.ok(e instanceof ObjectiveServiceError, `expected ObjectiveServiceError, got ${(e as Error)?.constructor?.name}`);
    assert.equal((e as ObjectiveServiceError).code, 'BAD_REQUEST');
    // Must not leak Zod's internal error shape (e.g. an `issues` array) to the caller.
    assert.equal((e as any).issues, undefined);
  }
  db.close();
});

test('D.2.1: valid constraint/successCriteria elements are still accepted', () => {
  const db = makeDb();
  const wsId = seedWorkspace(db);
  const projectId = seedProject(db, wsId);
  const svc = new ObjectiveService(db, wsId);

  const objective = svc.create({
    projectId, title: 'T', description: 'D',
    constraints: [{ description: 'must not break X', type: 'must_not' }],
    successCriteria: [{ description: 'Y is achieved', met: false }],
  });

  assert.equal(objective.constraints[0].type, 'must_not');
  assert.equal(objective.successCriteria[0].met, false);
  db.close();
});

test('D.2: create() rejects an unknown project', () => {
  const db = makeDb();
  const wsId = seedWorkspace(db);
  const svc = new ObjectiveService(db, wsId);

  assert.throws(
    () => svc.create({ projectId: randomUUID(), title: 'T', description: 'D' }),
    /not found/i,
  );
  db.close();
});

// ============================================================================
// Persistence
// ============================================================================

test('D.2: an Objective persists across a fresh ObjectiveService instance (same handle)', () => {
  const db = makeDb();
  const wsId = seedWorkspace(db);
  const projectId = seedProject(db, wsId);
  const created = new ObjectiveService(db, wsId).create({ projectId, title: 'T', description: 'D' });

  // A brand-new service instance over the same db handle — cheap sanity
  // check that the repository doesn't rely on in-process caching. Does not
  // by itself prove real restart persistence — see the file-backed test below.
  const reloaded = new ObjectiveService(db, wsId).findById(created.id);

  assert.deepEqual(reloaded, created);
  db.close();
});

test('D.2.1: an Objective persists across a real close/reopen of a file-backed DB (restart)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'objective-restart-'));
  const dbPath = path.join(dir, 'stratum.db');
  try {
    const db1 = openDatabase(dbPath);
    const wsId = seedWorkspace(db1);
    const projectId = seedProject(db1, wsId);
    const created = new ObjectiveService(db1, wsId).create({
      projectId, title: 'T', description: 'D', priority: 4,
      constraints: [{ description: 'must not break X' }],
      successCriteria: [{ description: 'Y is achieved' }],
    });
    db1.close();

    // Reopen — a genuinely new process would do exactly this.
    const db2 = openDatabase(dbPath);
    const reloaded = new ObjectiveService(db2, wsId).findById(created.id);

    assert.deepEqual(reloaded, created, 'payload and timestamps must survive close/reopen unchanged');
    db2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// D.2.1 — migration-compatibility: backfilling pre-D.2.1 NULL timestamps
// ============================================================================

test('D.2.1: opening a DB with a pre-existing NULL-timestamp Objective row backfills it into a valid Objective', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'objective-migration-'));
  const dbPath = path.join(dir, 'stratum.db');
  try {
    // Construct the DB at exactly the migration-9 checkpoint (created_at/
    // updated_at exist and are nullable, but nothing backfills them yet —
    // the state every DB that predates migration 10 was left in), then
    // insert an Objective row the way raw SQL would have before
    // ObjectiveService/migration 10 existed: NULL timestamps.
    const raw = new Database(dbPath);
    raw.exec('CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    const recordMigration = raw.prepare('INSERT INTO _migrations (id, applied_at) VALUES (?, ?)');
    for (let i = 0; i < 9; i++) {
      raw.exec(MIGRATIONS[i]);
      recordMigration.run(i + 1, new Date().toISOString());
    }

    const now = new Date().toISOString();
    const wsId = randomUUID();
    raw.prepare('INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)').run(wsId, 'ws', now);
    const projectId = randomUUID();
    raw.prepare(`
      INSERT INTO projects (id, workspace_id, name, status, priority, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(projectId, wsId, 'proj', 'active', 0, now, now);
    const objectiveId = randomUUID();
    raw.prepare(`
      INSERT INTO objectives
        (id, project_id, title, description, priority, status, constraints_json, success_criteria_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
    `).run(objectiveId, projectId, 'Pre-D.2.1 objective', 'desc', 0, 'draft', '[]', '[]');
    raw.close();

    // Now open it the normal way — this must run migration 10 and backfill.
    const db = openDatabase(dbPath);
    const found = new ObjectiveRepository(db).findById(objectiveId);

    assert.ok(found, 'the pre-existing row must still be readable');
    assert.ok(found!.createdAt, 'created_at must be backfilled, not null');
    assert.ok(found!.updatedAt, 'updated_at must be backfilled, not null');
    assert.equal(
      found!.updatedAt, found!.createdAt,
      'updated_at backfill policy: fall back to created_at when both were missing',
    );
    // The resulting row must satisfy the same contract a freshly-created
    // Objective does — a fresh ObjectiveService instance can read it back
    // as a normal, fully-valid Objective.
    const viaService = new ObjectiveService(db, wsId).findById(objectiveId);
    assert.deepEqual(viaService, found);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('D.2.1: an existing non-null Objective timestamp is left untouched by the backfill migration', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'objective-migration-preserve-'));
  const dbPath = path.join(dir, 'stratum.db');
  try {
    const raw = new Database(dbPath);
    raw.exec('CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    const recordMigration = raw.prepare('INSERT INTO _migrations (id, applied_at) VALUES (?, ?)');
    for (let i = 0; i < 9; i++) {
      raw.exec(MIGRATIONS[i]);
      recordMigration.run(i + 1, new Date().toISOString());
    }

    const originalCreatedAt = '2026-01-01T00:00:00.000Z';
    const originalUpdatedAt = '2026-01-02T00:00:00.000Z';
    const now = new Date().toISOString();
    const wsId = randomUUID();
    raw.prepare('INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)').run(wsId, 'ws', now);
    const projectId = randomUUID();
    raw.prepare(`
      INSERT INTO projects (id, workspace_id, name, status, priority, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(projectId, wsId, 'proj', 'active', 0, now, now);
    const objectiveId = randomUUID();
    raw.prepare(`
      INSERT INTO objectives
        (id, project_id, title, description, priority, status, constraints_json, success_criteria_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(objectiveId, projectId, 'Already timestamped', 'desc', 0, 'draft', '[]', '[]', originalCreatedAt, originalUpdatedAt);
    raw.close();

    const db = openDatabase(dbPath);
    const found = new ObjectiveRepository(db).findById(objectiveId)!;

    assert.equal(found.createdAt, originalCreatedAt, 'a non-null created_at must be preserved exactly');
    assert.equal(found.updatedAt, originalUpdatedAt, 'a non-null updated_at must be preserved exactly');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// Workspace isolation — fail closed
// ============================================================================

test('D.2: create() rejects a Project belonging to another workspace', () => {
  const db = makeDb();
  const wsId = seedWorkspace(db);
  const otherWsId = seedWorkspace(db);
  const otherProjectId = seedProject(db, otherWsId);
  const svc = new ObjectiveService(db, wsId);

  assert.throws(
    () => svc.create({ projectId: otherProjectId, title: 'T', description: 'D' }),
    /workspace/i,
  );
  db.close();
});

test('D.2: findById() returns undefined for an Objective in another workspace', () => {
  const db = makeDb();
  const wsId = seedWorkspace(db);
  const otherWsId = seedWorkspace(db);
  const otherProjectId = seedProject(db, otherWsId);
  const other = new ObjectiveService(db, otherWsId).create({ projectId: otherProjectId, title: 'T', description: 'D' });

  const svc = new ObjectiveService(db, wsId);
  assert.equal(svc.findById(other.id), undefined, 'cross-workspace lookup must fail closed, not leak the row');
  db.close();
});

test('D.2: listByProject() rejects a Project belonging to another workspace', () => {
  const db = makeDb();
  const wsId = seedWorkspace(db);
  const otherWsId = seedWorkspace(db);
  const otherProjectId = seedProject(db, otherWsId);
  const svc = new ObjectiveService(db, wsId);

  assert.throws(() => svc.listByProject(otherProjectId), /not found/i);
  db.close();
});

// ============================================================================
// Guarded lifecycle — draft -> active -> completed, or -> cancelled
// ============================================================================

test('D.2: activate() moves draft -> active', () => {
  const db = makeDb();
  const wsId = seedWorkspace(db);
  const projectId = seedProject(db, wsId);
  const svc = new ObjectiveService(db, wsId);
  const objective = svc.create({ projectId, title: 'T', description: 'D' });

  const activated = svc.activate(objective.id);

  assert.equal(activated.status, 'active');
  assert.equal(svc.findById(objective.id)!.status, 'active');
});

test('D.2: complete() moves active -> completed', () => {
  const db = makeDb();
  const wsId = seedWorkspace(db);
  const projectId = seedProject(db, wsId);
  const svc = new ObjectiveService(db, wsId);
  const objective = svc.create({ projectId, title: 'T', description: 'D' });
  svc.activate(objective.id);

  const completed = svc.complete(objective.id);

  assert.equal(completed.status, 'completed');
});

test('D.2: complete() rejects direct draft -> completed (must go through active)', () => {
  const db = makeDb();
  const wsId = seedWorkspace(db);
  const projectId = seedProject(db, wsId);
  const svc = new ObjectiveService(db, wsId);
  const objective = svc.create({ projectId, title: 'T', description: 'D' });

  assert.throws(() => svc.complete(objective.id), /not permitted/i);
});

test('D.2: cancel() is allowed from draft and from active', () => {
  const db = makeDb();
  const wsId = seedWorkspace(db);
  const projectId = seedProject(db, wsId);
  const svc = new ObjectiveService(db, wsId);

  const fromDraft = svc.create({ projectId, title: 'T1', description: 'D' });
  assert.equal(svc.cancel(fromDraft.id).status, 'cancelled');

  const fromActive = svc.create({ projectId, title: 'T2', description: 'D' });
  svc.activate(fromActive.id);
  assert.equal(svc.cancel(fromActive.id).status, 'cancelled');
});

test('D.2: no transition is permitted from a terminal status (completed or cancelled)', () => {
  const db = makeDb();
  const wsId = seedWorkspace(db);
  const projectId = seedProject(db, wsId);
  const svc = new ObjectiveService(db, wsId);

  const completed = svc.create({ projectId, title: 'T1', description: 'D' });
  svc.activate(completed.id);
  svc.complete(completed.id);
  assert.throws(() => svc.cancel(completed.id), /not permitted/i);

  const cancelled = svc.create({ projectId, title: 'T2', description: 'D' });
  svc.cancel(cancelled.id);
  assert.throws(() => svc.activate(cancelled.id), /not permitted/i);
});

test('D.2: guarded transitions never bypass ObjectiveRepository.updateStatus directly', () => {
  // Regression guard: the repository's raw updateStatus() has no transition
  // table of its own — it is meant to be called only through the service.
  // This asserts the service actually enforces the table (rather than, say,
  // silently forwarding any status), so a caller cannot walk around it.
  const db = makeDb();
  const wsId = seedWorkspace(db);
  const projectId = seedProject(db, wsId);
  const svc = new ObjectiveService(db, wsId);
  const objective = svc.create({ projectId, title: 'T', description: 'D' });

  assert.throws(() => svc.complete(objective.id), ObjectiveServiceError);
});
