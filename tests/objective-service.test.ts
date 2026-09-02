/**
 * D.2 — ObjectiveService.
 *
 * Objective is the durable human-intent container above WorkItems:
 *   Project -> Objective -> WorkItems
 * These tests cover the service directly (create/read/list, guarded
 * lifecycle, workspace isolation, restart persistence). WorkItem linkage
 * validation lives in tests/commit-b.test.ts (WorkService.createWorkItem);
 * the /projects/:id/objectives and /objectives/:id HTTP routes are covered
 * in tests/api.test.ts.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';

import { openDatabase } from '../src/storage/database.js';
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
// Persistence — survives a fresh service instance against the same DB file
// ============================================================================

test('D.2: an Objective persists across a fresh ObjectiveService instance (restart)', () => {
  const db = makeDb();
  const wsId = seedWorkspace(db);
  const projectId = seedProject(db, wsId);
  const created = new ObjectiveService(db, wsId).create({ projectId, title: 'T', description: 'D' });

  // Simulate a restart: a brand-new service instance over the same db handle.
  const reloaded = new ObjectiveService(db, wsId).findById(created.id);

  assert.deepEqual(reloaded, created);
  db.close();
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
