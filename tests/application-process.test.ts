import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { openDatabase, MIGRATIONS } from '../src/storage/database.js';
import { WorkspaceRepository, ProjectRepository, AppProcessRepository, RepositoryRepository } from '../src/storage/repositories.js';
import { ProcessService, ProcessServiceError } from '../src/application/processes/service.js';

test('application Processes keep their own review history and never create kernel WorkItems', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'stratum-process-'));
  const db = openDatabase(path.join(directory, 'test.db'));
  try {
    const now = new Date().toISOString();
    const workspaces = new WorkspaceRepository(db); const projects = new ProjectRepository(db);
    const workspaceId = '00000000-0000-4000-8000-000000000001';
    const projectId = '00000000-0000-4000-8000-000000000002';
    workspaces.save({ id: workspaceId, name: 'Workspace', createdAt: now });
    projects.save({ id: projectId, workspaceId, name: 'Project', status: 'active', priority: 0, createdAt: now, updatedAt: now });
    const service = new ProcessService(db, workspaceId);
    const process = service.create(projectId, { title: 'Improve movement', intent: 'Make movement feel natural', desiredOutcomes: ['No navigation regressions'] });
    db.exec(`CREATE TRIGGER reject_paused_history BEFORE INSERT ON app_process_activity WHEN NEW.title='Process paused' BEGIN SELECT RAISE(ABORT,'simulated history failure'); END`);
    assert.throws(() => service.setLifecycle(process.id, 'paused'), /simulated history failure/);
    assert.equal(service.get(process.id).process.lifecycle, 'active', 'a failed history write rolls back the lifecycle update');
    db.exec('DROP TRIGGER reject_paused_history');
    const firstProposal = service.addActivity(process.id, 'proposal', 'Navigation approach', 'Try a smoother path planner.');
    assert.equal(service.list(projectId)[0].attention, 'Review required');
    assert.throws(() => service.addActivity(process.id, 'review', 'Incomplete review', 'No decision yet.'), ProcessServiceError);
    service.addActivity(process.id, 'review', 'First review', 'The proposal needs another pass.', 'revise', firstProposal.proposalId);
    assert.equal(service.list(projectId)[0].attention, 'Revision requested');
    const secondProposal = service.addActivity(process.id, 'proposal', 'Revised approach', 'Keep current pathing and tune acceleration.');
    service.addActivity(process.id, 'review', 'Second review', 'The tradeoff is acceptable.', 'accepted', secondProposal.proposalId);
    assert.equal(service.list(projectId)[0].attention, undefined);
    const detail = service.get(process.id);
    assert.equal(detail.activity.length, 5);
    assert.equal(detail.activity[0].outcome, 'accepted');
    assert.equal(detail.process.lifecycle, 'active');
    assert.throws(() => service.setLifecycle(process.id, 'completed'), ProcessServiceError);
    service.setLifecycle(process.id, 'completed', 'Accepted because the new approach meets the desired outcome.');
    assert.equal(service.get(process.id).process.lifecycle, 'completed');
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM work_items').get() as { count: number }).count, 0);
    assert.throws(() => service.addActivity(process.id, 'update', 'Late update', 'Should not be accepted.'), ProcessServiceError);
  } finally {
    db.close(); rmSync(directory, { recursive: true, force: true });
  }
});

test('Process reads and Objective links are scoped to the owning workspace and project', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'stratum-process-scope-'));
  const db = openDatabase(path.join(directory, 'test.db'));
  try {
    const now = new Date().toISOString(); const workspaces = new WorkspaceRepository(db); const projects = new ProjectRepository(db);
    const firstWorkspace = '10000000-0000-4000-8000-000000000001'; const secondWorkspace = '10000000-0000-4000-8000-000000000002';
    const firstProject = '10000000-0000-4000-8000-000000000003'; const secondProject = '10000000-0000-4000-8000-000000000004';
    workspaces.save({ id: firstWorkspace, name: 'A', createdAt: now }); workspaces.save({ id: secondWorkspace, name: 'B', createdAt: now });
    projects.save({ id: firstProject, workspaceId: firstWorkspace, name: 'A', status: 'active', priority: 0, createdAt: now, updatedAt: now });
    projects.save({ id: secondProject, workspaceId: secondWorkspace, name: 'B', status: 'active', priority: 0, createdAt: now, updatedAt: now });
    const objectiveId = '10000000-0000-4000-8000-000000000005';
    db.prepare(`INSERT INTO objectives (id,project_id,title,description,priority,status,constraints_json,success_criteria_json,created_at,updated_at)
      VALUES (?,?,?, ?,0,'active','[]','[]',?,?)`).run(objectiveId, firstProject, 'Outcome', 'Description', now, now);
    const first = new ProcessService(db, firstWorkspace); const second = new ProcessService(db, secondWorkspace);
    const process = first.create(firstProject, { title: 'Research', intent: 'Understand the issue', objectiveId });
    assert.throws(() => second.get(process.id), ProcessServiceError);
    assert.throws(() => first.create(firstProject, { title: 'Invalid link', intent: 'Test', objectiveId: '10000000-0000-4000-8000-000000000006' }), ProcessServiceError);
    assert.deepEqual(first.list(firstProject).map(item => item.id), [process.id]);
    assert.deepEqual(second.list(secondProject), []);
    assert.equal(new AppProcessRepository(db).findById(process.id)?.objectiveId, objectiveId);
  } finally {
    db.close(); rmSync(directory, { recursive: true, force: true });
  }
});

test('repository identity can be shared by Projects without sharing Process history', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'stratum-repository-share-'));
  const db = openDatabase(path.join(directory, 'test.db'));
  try {
    const now = new Date().toISOString(); const workspaces = new WorkspaceRepository(db); const projects = new ProjectRepository(db);
    const workspaceId = '20000000-0000-4000-8000-000000000001'; workspaces.save({ id: workspaceId, name: 'Shared', createdAt: now });
    const firstProject = '20000000-0000-4000-8000-000000000002'; const secondProject = '20000000-0000-4000-8000-000000000003';
    projects.save({ id: firstProject, workspaceId, name: 'First', status: 'active', priority: 0, createdAt: now, updatedAt: now });
    projects.save({ id: secondProject, workspaceId, name: 'Second', status: 'active', priority: 0, createdAt: now, updatedAt: now });
    const repositories = new RepositoryRepository(db); const repositoryId = '20000000-0000-4000-8000-000000000004';
    repositories.save({ id: repositoryId, projectId: firstProject, provider: 'github', remote: 'https://github.com/example/shared.git', defaultBranch: 'main', status: 'active' });
    repositories.linkToProject(secondProject, repositoryId);
    assert.equal(repositories.findByRemote('github', 'https://github.com/example/shared.git')?.id, repositoryId);
    assert.deepEqual(repositories.listByProject(firstProject).map(repository => repository.id), [repositoryId]);
    assert.deepEqual(repositories.listByProject(secondProject).map(repository => repository.id), [repositoryId]);
    assert.equal(repositories.listByProject(secondProject)[0].projectId, secondProject);
    const service = new ProcessService(db, workspaceId);
    const first = service.create(firstProject, { title: 'A work', intent: 'Project A context', repositoryIds: [repositoryId] });
    const second = service.create(secondProject, { title: 'B work', intent: 'Project B context', repositoryIds: [repositoryId] });
    assert.notEqual(first.id, second.id);
    assert.deepEqual(service.list(firstProject).map(process => process.id), [first.id]);
    assert.deepEqual(service.list(secondProject).map(process => process.id), [second.id]);
    assert.equal(repositories.isLinkedToWorkspace(workspaceId, repositoryId), true);
  } finally {
    db.close(); rmSync(directory, { recursive: true, force: true });
  }
});

test('repository membership migration preserves existing repository IDs and assigns their original Project link', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'stratum-project-repositories-migration-'));
  const databasePath = path.join(directory, 'test.db');
  const legacy = new Database(databasePath);
  try {
    legacy.pragma('foreign_keys = ON');
    legacy.exec('CREATE TABLE _migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    for (const [index, migration] of MIGRATIONS.slice(0, 11).entries()) {
      legacy.exec(migration);
      legacy.prepare('INSERT INTO _migrations (id,applied_at) VALUES (?,?)').run(index + 1, new Date().toISOString());
    }
    const now = new Date().toISOString();
    const workspaceId = '30000000-0000-4000-8000-000000000001'; const projectId = '30000000-0000-4000-8000-000000000002';
    const repositoryId = '30000000-0000-4000-8000-000000000003';
    legacy.prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)').run(workspaceId, 'Legacy', now);
    legacy.prepare(`INSERT INTO projects (id,workspace_id,name,status,priority,created_at,updated_at) VALUES (?,?,?,'active',0,?,?)`).run(projectId, workspaceId, 'Legacy project', now, now);
    legacy.prepare(`INSERT INTO repositories (id,project_id,provider,remote,default_branch,status) VALUES (?,?,'github',?,'main','active')`).run(repositoryId, projectId, 'https://github.com/example/legacy.git');
    const secondProject = '30000000-0000-4000-8000-000000000004'; const duplicateRepositoryId = '30000000-0000-4000-8000-000000000005';
    legacy.prepare(`INSERT INTO projects (id,workspace_id,name,status,priority,created_at,updated_at) VALUES (?,?,?,'active',0,?,?)`).run(secondProject, workspaceId, 'Second legacy project', now, now);
    legacy.prepare(`INSERT INTO repositories (id,project_id,provider,remote,default_branch,status) VALUES (?,?,'github',?,'main','active')`).run(duplicateRepositoryId, secondProject, 'git@github.com:Example/Legacy.git');
  } finally { legacy.close(); }
  try {
    const migrated = openDatabase(databasePath);
    try {
      const link = migrated.prepare('SELECT project_id,repository_id FROM project_repositories').get() as { project_id: string; repository_id: string };
      assert.deepEqual(link, { project_id: '30000000-0000-4000-8000-000000000002', repository_id: '30000000-0000-4000-8000-000000000003' });
      assert.equal((migrated.prepare('SELECT id FROM repositories WHERE id=?').get(link.repository_id) as { id: string }).id, link.repository_id);
      const identities = migrated.prepare('SELECT DISTINCT canonical_identity FROM repositories').all() as { canonical_identity: string }[];
      assert.deepEqual(identities, [{ canonical_identity: 'github:example/legacy' }]);
      assert.equal((migrated.prepare('SELECT COUNT(*) AS count FROM repositories').get() as { count: number }).count, 2, 'legacy IDs remain intact');
    } finally { migrated.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
