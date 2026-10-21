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
    service.setLifecycle(process.id, 'completed', 'Accepted because the new approach meets the desired outcome.', true);
    assert.equal(service.get(process.id).process.lifecycle, 'completed');
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM work_items').get() as { count: number }).count, 0);
    assert.throws(() => service.addActivity(process.id, 'update', 'Late update', 'Should not be accepted.'), ProcessServiceError);
  } finally {
    db.close(); rmSync(directory, { recursive: true, force: true });
  }
});

test('Process definition amendments are proposed, accepted or rejected, versioned, and durable across restart', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'stratum-process-amendments-'));
  const dbPath = path.join(directory, 'test.db');
  let db = openDatabase(dbPath);
  const workspaceId = '50000000-0000-4000-8000-000000000001'; const projectId = '50000000-0000-4000-8000-000000000002';
  const now = new Date().toISOString();
  new WorkspaceRepository(db).save({ id: workspaceId, name: 'Workspace', createdAt: now });
  new ProjectRepository(db).save({ id: projectId, workspaceId, name: 'Project', status: 'active', priority: 0, createdAt: now, updatedAt: now });
  let processId = '';
  try {
    const service = new ProcessService(db, workspaceId);
    const process = service.create(projectId, { title: 'Improve movement', intent: 'Make movement feel natural', desiredOutcomes: ['Responsive steering'], constraints: ['Preserve navigation'] });
    processId = process.id;
    assert.equal(service.get(process.id).definitionVersions[0].version, 1);
    const rejected = service.proposeAmendment(process.id, { definition: { intent: 'Replace movement entirely' }, reason: 'Rejected scope expansion' });
    assert.equal(service.get(process.id).process.intent, 'Make movement feel natural', 'proposal leaves accepted definition unchanged');
    service.decideAmendment(process.id, rejected.id, 'reject');
    assert.equal(service.get(process.id).process.intent, 'Make movement feel natural');
    const accepted = service.proposeAmendment(process.id, { definition: { intent: 'Make movement predictable and responsive', desiredOutcomes: ['Predictable steering'] }, reason: 'Investigation clarified success criteria' });
    service.decideAmendment(process.id, accepted.id, 'accept');
    service.addActivity(process.id, 'update', 'Testing', 'Validated the new steering criteria.');
    const detail = service.get(process.id);
    assert.equal(detail.process.intent, 'Make movement predictable and responsive');
    assert.deepEqual(detail.definitionVersions.map(version => version.version), [2, 1]);
    assert.equal(detail.activity[0].definitionVersion, 2);
    assert.equal(detail.activity.find(item => item.amendmentId === rejected.id)?.definitionVersion, 1);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM work_items').get() as { count: number }).count, 0);
  } finally { db.close(); }
  try {
    db = openDatabase(dbPath);
    const resumed = new ProcessService(db, workspaceId).get(processId);
    assert.equal(resumed.process.intent, 'Make movement predictable and responsive');
    assert.deepEqual(resumed.definitionVersions.map(version => version.version), [2, 1]);
    assert.equal(resumed.amendments.find(amendment => amendment.reason === 'Rejected scope expansion')?.status, 'rejected');
    assert.ok(resumed.activity.some(item => item.definitionVersion === 1));
    assert.ok(resumed.activity.some(item => item.definitionVersion === 2));
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('deferred proposals remain visible, can be reopened, and completion requires explicit unresolved acknowledgment', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'stratum-process-unresolved-'));
  const db = openDatabase(path.join(directory, 'test.db'));
  try {
    const now = new Date().toISOString(); const workspaceId = '60000000-0000-4000-8000-000000000001'; const projectId = '60000000-0000-4000-8000-000000000002';
    new WorkspaceRepository(db).save({ id: workspaceId, name: 'Workspace', createdAt: now });
    new ProjectRepository(db).save({ id: projectId, workspaceId, name: 'Project', status: 'active', priority: 0, createdAt: now, updatedAt: now });
    const service = new ProcessService(db, workspaceId);
    const deferredProcess = service.create(projectId, { title: 'Review approach', intent: 'Decide on the approach.' });
    const proposal = service.addActivity(deferredProcess.id, 'proposal', 'Option A', 'Use the current architecture.');
    service.addActivity(deferredProcess.id, 'review', 'Deferred', 'Revisit after the dependency audit.', 'deferred', proposal.proposalId);
    assert.equal(service.list(projectId)[0].nextAction, 'Reconsider deferred proposal: Option A');
    assert.equal(service.get(deferredProcess.id).deferredProposals.length, 1);
    service.reopenDeferredProposal(deferredProcess.id, proposal.proposalId!);
    assert.equal(service.list(projectId).find(item => item.id === deferredProcess.id)?.attention, 'Review required');
    service.addActivity(deferredProcess.id, 'review', 'Accepted', 'The audit supports this approach.', 'accepted', proposal.proposalId);
    service.setLifecycle(deferredProcess.id, 'completed', 'The approach was accepted after review.');

    const unresolved = service.create(projectId, { title: 'Known follow-up', intent: 'Keep the follow-up visible.' });
    service.addActivity(unresolved.id, 'proposal', 'Performance check', 'Run a follow-up check later.');
    assert.throws(() => service.setLifecycle(unresolved.id, 'completed', 'The main effort is complete.'), /acknowledge unresolved/);
    service.setLifecycle(unresolved.id, 'completed', 'The main effort is complete.', true);
    assert.match(service.get(unresolved.id).activity[0].body, /Acknowledged unresolved items: Performance check/);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM work_items').get() as { count: number }).count, 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM workflow_runs').get() as { count: number }).count, 0);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('Project activity feed is chronological and can include multiple events from one Process', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'stratum-process-feed-'));
  const db = openDatabase(path.join(directory, 'test.db'));
  try {
    const now = new Date().toISOString(); const workspaceId = '70000000-0000-4000-8000-000000000001'; const projectId = '70000000-0000-4000-8000-000000000002';
    new WorkspaceRepository(db).save({ id: workspaceId, name: 'Workspace', createdAt: now });
    new ProjectRepository(db).save({ id: projectId, workspaceId, name: 'Project', status: 'active', priority: 0, createdAt: now, updatedAt: now });
    const service = new ProcessService(db, workspaceId);
    const first = service.create(projectId, { title: 'First process', intent: 'Track work.' });
    const second = service.create(projectId, { title: 'Second process', intent: 'Track other work.' });
    const repository = new AppProcessRepository(db);
    const event = (processId: string, title: string, day: number) => repository.addActivity({ id: `70000000-0000-4000-8000-${String(day).padStart(12, '0')}`,
      processId, kind: 'update', title, body: title, createdAt: `2099-01-0${day}T00:00:00.000Z` });
    event(first.id, 'First update', 1); event(second.id, 'Second process update', 2); event(first.id, 'Latest update', 3);
    assert.deepEqual(service.activityFeed(projectId, 2).map(item => item.title), ['Latest update', 'Second process update']);
    assert.deepEqual(service.activityFeed(projectId, 3).map(item => item.title), ['Latest update', 'Second process update', 'First update']);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
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

test('proposal migration resolves explicitly reviewed history and preserves ambiguous proposals as pending', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'stratum-proposal-migration-'));
  const databasePath = path.join(directory, 'test.db');
  const legacy = new Database(databasePath);
  const workspaceId = '40000000-0000-4000-8000-000000000001';
  const projectId = '40000000-0000-4000-8000-000000000002';
  const processId = '40000000-0000-4000-8000-000000000003';
  const proposalOne = '40000000-0000-4000-8000-000000000004';
  const reviewOne = '40000000-0000-4000-8000-000000000005';
  const proposalTwo = '40000000-0000-4000-8000-000000000006';
  const reviewTwo = '40000000-0000-4000-8000-000000000007';
  try {
    legacy.pragma('foreign_keys = ON');
    legacy.exec('CREATE TABLE _migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    for (const [index, migration] of MIGRATIONS.slice(0, 13).entries()) {
      legacy.exec(migration);
      legacy.prepare('INSERT INTO _migrations (id,applied_at) VALUES (?,?)').run(index + 1, new Date().toISOString());
    }
    const timestamp = (second: number) => `2026-01-01T00:00:0${second}.000Z`;
    legacy.prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)').run(workspaceId, 'Legacy', timestamp(0));
    legacy.prepare(`INSERT INTO projects (id,workspace_id,name,status,priority,created_at,updated_at) VALUES (?,?,?,'active',0,?,?)`).run(projectId, workspaceId, 'Legacy project', timestamp(0), timestamp(0));
    legacy.prepare(`INSERT INTO app_processes (id,project_id,title,intent,lifecycle,current_focus,created_at,updated_at) VALUES (?,?,? ,?,'active','Planning',?,?)`).run(processId, projectId, 'Legacy process', 'Keep decisions', timestamp(0), timestamp(0));
    const insert = legacy.prepare(`INSERT INTO app_process_activity (id,process_id,kind,title,body,outcome,created_at) VALUES (?,?,?,?,?,?,?)`);
    insert.run(proposalOne, processId, 'proposal', 'Resolved proposal', 'A proposal', null, timestamp(1));
    insert.run(reviewOne, processId, 'review', 'Accepted review', 'Explicit decision', 'accepted', timestamp(2));
    insert.run(proposalTwo, processId, 'proposal', 'Ambiguous proposal', 'Another proposal', null, timestamp(3));
    insert.run(reviewTwo, processId, 'review', 'Outcome-free review', 'No explicit decision', null, timestamp(4));
    legacy.exec(MIGRATIONS[13]);
    legacy.prepare('INSERT INTO _migrations (id,applied_at) VALUES (?,?)').run(14, new Date().toISOString());
  } finally { legacy.close(); }
  try {
    const migrated = openDatabase(databasePath);
    try {
      assert.equal((migrated.prepare('SELECT COUNT(*) AS count FROM _migrations WHERE id=15').get() as { count: number }).count, 1, 'the upgrade applies the new reconciliation migration');
      const proposalRows = migrated.prepare('SELECT id,status FROM app_process_proposals ORDER BY id').all() as { id: string; status: string }[];
      assert.deepEqual(proposalRows, [{ id: proposalOne, status: 'accepted' }, { id: proposalTwo, status: 'pending' }]);
      const linkedReview = migrated.prepare('SELECT proposal_id FROM app_process_activity WHERE id=?').get(reviewOne) as { proposal_id: string };
      assert.equal(linkedReview.proposal_id, proposalOne);
      const pendingReview = migrated.prepare('SELECT proposal_id FROM app_process_activity WHERE id=?').get(reviewTwo) as { proposal_id?: string };
      assert.equal(pendingReview.proposal_id, null);
    } finally { migrated.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
