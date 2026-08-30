import { test } from 'node:test';
import { strict as assert } from 'assert';
import { openDatabase } from '../src/storage/database.js';
import {
  WorkspaceRepository,
  ProjectRepository,
  RepositoryRepository,
  ObjectiveRepository,
  WorkItemRepository,
  StepExecutionRepository,
  DecisionRepository,
  PolicyRepository,
  EvidenceRepository,
  ArtifactRepository,
  EventRepository,
} from '../src/storage/repositories.js';
import type {
  Workspace, Project, Repository, Objective,
  WorkItem, StepExecution, Decision, Evidence, DomainEvent, PolicyConfig,
} from '../src/domain/index.js';
import type { ArtifactRecord } from '../src/storage/repositories.js';

// ============================================================================
// Helpers
// ============================================================================

function freshDb() {
  return openDatabase(':memory:');
}

const NOW = new Date().toISOString();
const WS_ID  = '00000000-0000-0000-0000-000000000001';
const P_ID   = '00000000-0000-0000-0000-000000000002';
const R_ID   = '00000000-0000-0000-0000-000000000003';
const OBJ_ID = '00000000-0000-0000-0000-000000000004';
const WI_ID  = '00000000-0000-0000-0000-000000000005';
const SE_ID  = '00000000-0000-0000-0000-000000000006';
const DEC_ID = '00000000-0000-0000-0000-000000000007';
const EV_ID  = '00000000-0000-0000-0000-000000000008';
const ART_ID = '00000000-0000-0000-0000-000000000009';
const EVT_ID = '00000000-0000-0000-0000-00000000000a';

const WS: Workspace = { id: WS_ID, name: 'Magnor', createdAt: NOW };

const PROJ: Project = {
  id: P_ID, workspaceId: WS_ID, name: 'Stratum',
  description: undefined,
  status: 'active', priority: 1, createdAt: NOW, updatedAt: NOW,
};

const REPO: Repository = {
  id: R_ID, projectId: P_ID, provider: 'github',
  remote: 'git@github.com:noema-team/stratum.git',
  defaultBranch: 'main', status: 'active',
  localWorkspace: undefined,
};

const OBJ: Objective = {
  id: OBJ_ID, projectId: P_ID,
  title: 'Fix race', description: 'Eliminate dispatch race condition',
  priority: 2, status: 'active',
  constraints: [{ description: 'No API change' }],
  successCriteria: [{ description: 'All race tests pass' }],
};

const WI: WorkItem = {
  id: WI_ID, projectId: P_ID, repositoryIds: [R_ID],
  title: 'Fix race condition', goal: 'Remove race in scheduler',
  workflowId: 'draft-artifact', state: 'ready',
  priority: 1,
  objectiveId: undefined,
  parentId: undefined,
  acceptanceCriteria: [], constraints: [], requiredEvidence: [],
  dependencies: [], createdAt: NOW, updatedAt: NOW,
};

const SE: StepExecution = {
  id: SE_ID, workItemId: WI_ID,
  workflowRunId: 'draft-artifact-1-i1-20260829T100000Z',
  stepId: 'produce', executor: 'stratum-agent',
  state: 'dispatched', attempt: 1,
  startedAt: undefined,
  completedAt: undefined,
  tokens: undefined,
  cost: undefined,
  failure: undefined,
};

const DEC: Decision = {
  id: DEC_ID, projectId: P_ID, workItemId: WI_ID,
  type: 'checkpoint',
  subjectRef: { workflowRunId: 'draft-artifact-1-i1-20260829T100000Z', stepId: 'checkpoint' },
  title: 'Confirm fix scope', summary: 'Please confirm the race fix scope.',
  options: [{ id: 'confirm', label: 'Confirm' }, { id: 'cancel', label: 'Cancel' }],
  impact: 'low', reversibility: 'easy', urgency: 'blocking',
  status: 'pending',
  recommendedOptionId: undefined,
  recommendationReason: undefined,
  resolution: undefined,
};

const EV: Evidence = {
  id: EV_ID, workItemId: WI_ID,
  type: 'github.ci', source: 'github-actions',
  status: 'passed',
  payload: { conclusion: 'success' },
  collectedAt: NOW,
  stepExecutionId: undefined,
  subjectRef: undefined,
  candidateRef: undefined,
  collectorId: undefined,
};

const ART: ArtifactRecord = {
  id: ART_ID, workItemId: WI_ID,
  workflowRunId: 'draft-artifact-1-i1-20260829T100000Z',
  type: 'design-document',
  ref: 'node:stratum:architecture',
  path: '.sle/artifacts/architecture.md',
  hash: 'abc123',
  createdAt: NOW,
  stepExecutionId: undefined,
};

const EVT: DomainEvent = {
  id: EVT_ID, schemaVersion: 1,
  type: 'work.state_changed',
  workspaceId: WS_ID, projectId: P_ID, workItemId: WI_ID,
  occurredAt: NOW,
  payload: { from: 'draft', to: 'ready' },
  workflowRunId: undefined,
};

function seedAll(db: ReturnType<typeof freshDb>) {
  new WorkspaceRepository(db).save(WS);
  new ProjectRepository(db).save(PROJ);
  new RepositoryRepository(db).save(REPO);
  new ObjectiveRepository(db).save(OBJ);
  new WorkItemRepository(db).save(WI);
}

// ============================================================================
// Workspace
// ============================================================================

test('testWorkspaceSaveAndFind', () => {
  const db = freshDb();
  const repo = new WorkspaceRepository(db);
  repo.save(WS);
  const found = repo.findById(WS_ID);
  assert.deepEqual(found, WS);
});

test('testWorkspaceList', () => {
  const db = freshDb();
  const repo = new WorkspaceRepository(db);
  repo.save(WS);
  assert.equal(repo.list().length, 1);
});

test('testWorkspaceIdempotencyConstraint', () => {
  const db = freshDb();
  const repo = new WorkspaceRepository(db);
  repo.save(WS);
  assert.throws(() => repo.save(WS), /UNIQUE constraint/);
});

test('testWorkspaceFindMissing', () => {
  const db = freshDb();
  assert.equal(new WorkspaceRepository(db).findById('missing'), undefined);
});

// ============================================================================
// Project
// ============================================================================

test('testProjectSaveAndFind', () => {
  const db = freshDb();
  new WorkspaceRepository(db).save(WS);
  const repo = new ProjectRepository(db);
  repo.save(PROJ);
  const found = repo.findById(P_ID);
  assert.deepEqual(found, PROJ);
});

test('testProjectForeignKeyEnforced', () => {
  const db = freshDb();
  const repo = new ProjectRepository(db);
  // workspace doesn't exist — should throw
  assert.throws(() => repo.save(PROJ), /FOREIGN KEY constraint/);
});

test('testProjectListByWorkspace', () => {
  const db = freshDb();
  new WorkspaceRepository(db).save(WS);
  const repo = new ProjectRepository(db);
  repo.save(PROJ);
  const list = repo.listByWorkspace(WS_ID);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, P_ID);
});

test('testProjectUpdateStatus', () => {
  const db = freshDb();
  new WorkspaceRepository(db).save(WS);
  const repo = new ProjectRepository(db);
  repo.save(PROJ);
  repo.updateStatus(P_ID, 'paused', NOW);
  assert.equal(repo.findById(P_ID)!.status, 'paused');
});

// ============================================================================
// Repository (SCM)
// ============================================================================

test('testRepositorySaveAndFind', () => {
  const db = freshDb();
  new WorkspaceRepository(db).save(WS);
  new ProjectRepository(db).save(PROJ);
  const repo = new RepositoryRepository(db);
  repo.save(REPO);
  const found = repo.findById(R_ID);
  assert.deepEqual(found, REPO);
});

test('testRepositoryListByProject', () => {
  const db = freshDb();
  new WorkspaceRepository(db).save(WS);
  new ProjectRepository(db).save(PROJ);
  const repo = new RepositoryRepository(db);
  repo.save(REPO);
  assert.equal(repo.listByProject(P_ID).length, 1);
});

// ============================================================================
// Objective
// ============================================================================

test('testObjectiveSaveAndFind', () => {
  const db = freshDb();
  new WorkspaceRepository(db).save(WS);
  new ProjectRepository(db).save(PROJ);
  const repo = new ObjectiveRepository(db);
  repo.save(OBJ);
  const found = repo.findById(OBJ_ID);
  assert.deepEqual(found, OBJ);
});

test('testObjectiveConstraintsRoundTrip', () => {
  const db = freshDb();
  new WorkspaceRepository(db).save(WS);
  new ProjectRepository(db).save(PROJ);
  const repo = new ObjectiveRepository(db);
  repo.save(OBJ);
  const found = repo.findById(OBJ_ID)!;
  assert.equal(found.constraints[0].description, 'No API change');
  assert.equal(found.successCriteria[0].description, 'All race tests pass');
});

// ============================================================================
// WorkItem
// ============================================================================

test('testWorkItemSaveAndFind', () => {
  const db = freshDb();
  seedAll(db);
  const repo = new WorkItemRepository(db);
  const found = repo.findById(WI_ID);
  assert.deepEqual(found, WI);
});

test('testWorkItemListByState', () => {
  const db = freshDb();
  seedAll(db);
  const repo = new WorkItemRepository(db);
  assert.equal(repo.listByState(P_ID, 'ready').length, 1);
  assert.equal(repo.listByState(P_ID, 'running').length, 0);
});

test('testWorkItemUpdateState', () => {
  const db = freshDb();
  seedAll(db);
  const repo = new WorkItemRepository(db);
  repo.updateState(WI_ID, 'running', NOW);
  assert.equal(repo.findById(WI_ID)!.state, 'running');
});

test('testWorkItemDependenciesRoundTrip', () => {
  const db = freshDb();
  seedAll(db);
  // create a second work item that depends on the first
  const dep: WorkItem = { ...WI, id: '00000000-0000-0000-0000-000000000099', dependencies: [WI_ID] };
  const repo = new WorkItemRepository(db);
  repo.save(dep);
  const found = repo.findById(dep.id)!;
  assert.deepEqual(found.dependencies, [WI_ID]);
});

test('testWorkItemSelfDependencyRejected', () => {
  const db = freshDb();
  seedAll(db);
  const repo = new WorkItemRepository(db);
  assert.throws(() => repo.addDependency(WI_ID, WI_ID), /CHECK constraint/);
});

// ============================================================================
// StepExecution
// ============================================================================

test('testStepExecutionSaveAndFind', () => {
  const db = freshDb();
  seedAll(db);
  const repo = new StepExecutionRepository(db);
  repo.save(SE);
  const found = repo.findById(SE_ID);
  assert.deepEqual(found, SE);
});

test('testStepExecutionUpdateState', () => {
  const db = freshDb();
  seedAll(db);
  const repo = new StepExecutionRepository(db);
  repo.save(SE);
  repo.updateState(SE_ID, 'succeeded', { completedAt: NOW });
  const found = repo.findById(SE_ID)!;
  assert.equal(found.state, 'succeeded');
  assert.equal(found.completedAt, NOW);
});

test('testStepExecutionWithFailure', () => {
  const db = freshDb();
  seedAll(db);
  const repo = new StepExecutionRepository(db);
  repo.save(SE);
  repo.updateState(SE_ID, 'failed', {
    completedAt: NOW,
    failure: { code: 'TIMEOUT', message: 'Agent timed out' },
  });
  const found = repo.findById(SE_ID)!;
  assert.equal(found.state, 'failed');
  assert.equal(found.failure?.code, 'TIMEOUT');
});

test('testStepExecutionListByWorkflowRun', () => {
  const db = freshDb();
  seedAll(db);
  const repo = new StepExecutionRepository(db);
  repo.save(SE);
  const list = repo.listByWorkflowRun(SE.workflowRunId);
  assert.equal(list.length, 1);
});

// ============================================================================
// Decision
// ============================================================================

test('testDecisionSaveAndFind', () => {
  const db = freshDb();
  seedAll(db);
  const repo = new DecisionRepository(db);
  repo.save(DEC);
  const found = repo.findById(DEC_ID);
  assert.deepEqual(found, DEC);
});

test('testDecisionListPending', () => {
  const db = freshDb();
  seedAll(db);
  const repo = new DecisionRepository(db);
  repo.save(DEC);
  assert.equal(repo.listPending(P_ID).length, 1);
});

test('testDecisionResolve', () => {
  const db = freshDb();
  seedAll(db);
  const repo = new DecisionRepository(db);
  repo.save(DEC);
  const resolution = { selectedOptionId: 'confirm', resolvedAt: NOW };
  repo.updateStatus(DEC_ID, 'resolved', resolution);
  const found = repo.findById(DEC_ID)!;
  assert.equal(found.status, 'resolved');
  assert.equal(found.resolution?.selectedOptionId, 'confirm');
  assert.equal(repo.listPending(P_ID).length, 0);
});

// ============================================================================
// Policy
// ============================================================================

test('testPolicyUpsertAndFind', () => {
  const db = freshDb();
  seedAll(db);
  const repo = new PolicyRepository(db);
  const config: PolicyConfig = {
    projectId: P_ID,
    merge: { humanApproval: true },
    agentPermissions: { pushBranch: 'allowed', createPr: 'allowed', merge: 'denied' },
  };
  repo.upsertPolicy(config);
  const found = repo.findByProject(P_ID);
  assert.deepEqual(found, config);
});

test('testPolicyUpsertUpdates', () => {
  const db = freshDb();
  seedAll(db);
  const repo = new PolicyRepository(db);
  const v1: PolicyConfig = { projectId: P_ID, merge: { humanApproval: true } };
  const v2: PolicyConfig = { projectId: P_ID, merge: { humanApproval: false } };
  repo.upsertPolicy(v1);
  repo.upsertPolicy(v2);
  assert.equal(repo.findByProject(P_ID)!.merge?.humanApproval, false);
});

// ============================================================================
// Evidence
// ============================================================================

test('testEvidenceSaveAndFind', () => {
  const db = freshDb();
  seedAll(db);
  const repo = new EvidenceRepository(db);
  repo.save(EV);
  const found = repo.findById(EV_ID);
  assert.deepEqual(found, EV);
});

test('testEvidencePayloadRoundTrip', () => {
  const db = freshDb();
  seedAll(db);
  const repo = new EvidenceRepository(db);
  const ev: Evidence = { ...EV, payload: { nested: { score: 9.5, tags: ['ok'] } } };
  repo.save(ev);
  assert.deepEqual(repo.findById(EV_ID)!.payload, ev.payload);
});

test('testEvidenceListByType', () => {
  const db = freshDb();
  seedAll(db);
  const repo = new EvidenceRepository(db);
  repo.save(EV);
  assert.equal(repo.listByType(WI_ID, 'github.ci').length, 1);
  assert.equal(repo.listByType(WI_ID, 'ci_toolkit.semantic_review').length, 0);
});

// ============================================================================
// Artifact
// ============================================================================

test('testArtifactSaveAndFind', () => {
  const db = freshDb();
  seedAll(db);
  const repo = new ArtifactRepository(db);
  repo.save(ART);
  const found = repo.findById(ART_ID);
  assert.deepEqual(found, ART);
});

test('testArtifactListByWorkflowRun', () => {
  const db = freshDb();
  seedAll(db);
  const repo = new ArtifactRepository(db);
  repo.save(ART);
  assert.equal(repo.listByWorkflowRun(ART.workflowRunId!).length, 1);
});

// ============================================================================
// EventRepository — ordering and append-only semantics
// ============================================================================

test('testEventAppendAndFind', () => {
  const db = freshDb();
  const repo = new EventRepository(db);
  repo.append(EVT);
  const found = repo.findById(EVT_ID);
  assert.deepEqual(found, EVT);
});

test('testEventOrdering', () => {
  const db = freshDb();
  const repo = new EventRepository(db);
  const t1 = '2026-08-29T10:00:00.000Z';
  const t2 = '2026-08-29T10:00:01.000Z';
  const t3 = '2026-08-29T10:00:02.000Z';
  const e1: DomainEvent = { ...EVT, id: '00000000-0000-0000-0001-000000000001', occurredAt: t3 };
  const e2: DomainEvent = { ...EVT, id: '00000000-0000-0000-0001-000000000002', occurredAt: t1 };
  const e3: DomainEvent = { ...EVT, id: '00000000-0000-0000-0001-000000000003', occurredAt: t2 };
  // Insert out of chronological order
  repo.append(e1);
  repo.append(e2);
  repo.append(e3);
  const list = repo.listByWorkspace(WS_ID);
  assert.equal(list[0].occurredAt, t1);
  assert.equal(list[1].occurredAt, t2);
  assert.equal(list[2].occurredAt, t3);
});

test('testEventIdempotencyConstraint', () => {
  const db = freshDb();
  const repo = new EventRepository(db);
  repo.append(EVT);
  assert.throws(() => repo.append(EVT), /UNIQUE constraint/);
});

test('testEventListAfterCursor', () => {
  const db = freshDb();
  const repo = new EventRepository(db);
  const t1 = '2026-08-29T10:00:00.000Z';
  const t2 = '2026-08-29T10:00:01.000Z';
  const t3 = '2026-08-29T10:00:02.000Z';
  repo.append({ ...EVT, id: '00000000-0000-0000-0002-000000000001', occurredAt: t1 });
  repo.append({ ...EVT, id: '00000000-0000-0000-0002-000000000002', occurredAt: t2 });
  repo.append({ ...EVT, id: '00000000-0000-0000-0002-000000000003', occurredAt: t3 });
  const page = repo.listAfter(WS_ID, t1, 10);
  assert.equal(page.length, 2);
  assert.equal(page[0].occurredAt, t2);
});

test('testEventListByType', () => {
  const db = freshDb();
  const repo = new EventRepository(db);
  repo.append(EVT);
  repo.append({ ...EVT, id: '00000000-0000-0000-0003-000000000001', type: 'work.completed' });
  assert.equal(repo.listByType(WS_ID, 'work.state_changed').length, 1);
  assert.equal(repo.listByType(WS_ID, 'work.completed').length, 1);
  assert.equal(repo.listByType(WS_ID, 'project.created').length, 0);
});

// ============================================================================
// Transaction rollback
// ============================================================================

test('testTransactionRollback', () => {
  const db = freshDb();
  const wsRepo = new WorkspaceRepository(db);
  const projRepo = new ProjectRepository(db);
  wsRepo.save(WS);

  try {
    db.transaction(() => {
      projRepo.save(PROJ);
      // Force an error mid-transaction: duplicate workspace ID
      wsRepo.save(WS);
    })();
  } catch {
    // expected
  }

  // Project must not have been committed
  assert.equal(projRepo.findById(P_ID), undefined);
});

// ============================================================================
// Restart persistence
// ============================================================================

test('testRestartPersistence', () => {
  const path = `/tmp/stratum-test-${Date.now()}.db`;
  try {
    // Session 1 — write
    const db1 = openDatabase(path);
    new WorkspaceRepository(db1).save(WS);
    new ProjectRepository(db1).save(PROJ);
    db1.close();

    // Session 2 — read back
    const db2 = openDatabase(path);
    const ws = new WorkspaceRepository(db2).findById(WS_ID);
    const proj = new ProjectRepository(db2).findById(P_ID);
    db2.close();

    assert.deepEqual(ws, WS);
    assert.deepEqual(proj, PROJ);
  } finally {
    try { require('fs').unlinkSync(path); } catch { /* ignore */ }
  }
});
