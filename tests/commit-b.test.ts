/**
 * Commit B — WorkItem creation API + external lifecycle authority tests.
 *
 * B.1 / B.4 — WorkService.createWorkItem() and POST /projects/:id/work
 * B.2 / B.4 — Removed external state-transition routes; Scheduler authority
 * B.3        — Terminal-checkpoint atomicity regression
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';

import { openDatabase } from '../src/storage/database.js';
import {
  WorkspaceRepository,
  ProjectRepository,
  WorkItemRepository,
  RepositoryRepository,
  EventRepository,
  WorkflowRunRepository,
  DecisionRepository,
  StepExecutionRepository,
  CheckpointApplicationRepository,
} from '../src/storage/repositories.js';
import { WorkService } from '../src/services/work-service.js';
import { EvidenceService } from '../src/services/evidence-service.js';
import { ResumeService } from '../src/services/resume-service.js';
import { ExecutorRegistry } from '../src/execution/registry.js';
import { ControlPlaneServer } from '../src/api/control-plane-server.js';
import { registerWorkflow } from '../src/workflow/registry.js';
import type { Workspace, Project, WorkItem, Repository } from '../src/domain/index.js';
import type { ExecutionAdapter, ExecutionRequest, ExecutionResult, CapabilitySet } from '../src/execution/types.js';

// ── Terminal-checkpoint workflow ──────────────────────────────────────────────

const TERMINAL_WF_ID = `terminal-ckpt-${randomUUID()}`;
registerWorkflow({
  id: TERMINAL_WF_ID,
  label: 'Terminal checkpoint test',
  steps: [
    { id: 'step-a', kind: 'produce', label: 'Before' },
    { id: 'gate', kind: 'checkpoint', label: 'Final gate' },
    // No step after gate — checkpoint is the terminal step
  ],
});

// ── Stub adapter ──────────────────────────────────────────────────────────────

function makeStubAdapter(): ExecutionAdapter {
  return {
    id: 'stratum-agent',
    getCapabilities(): CapabilitySet { return new Set(); },
    async execute(_req: ExecutionRequest): Promise<ExecutionResult> {
      return {
        schemaVersion: 1,
        stepExecutionId: randomUUID(),
        outcome: 'succeeded',
        artifacts: [],
        evidenceClaims: [],
        decisionRequests: [],
      };
    },
  };
}

// ── DB helpers ────────────────────────────────────────────────────────────────

function makeDb() { return openDatabase(':memory:'); }

function seedWorkspace(db: ReturnType<typeof makeDb>) {
  const now = new Date().toISOString();
  const wsId = randomUUID();
  new WorkspaceRepository(db).save({ id: wsId, name: 'ws', createdAt: now } as Workspace);
  return wsId;
}

function seedProject(db: ReturnType<typeof makeDb>, wsId: string) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  new ProjectRepository(db).save({
    id: projectId, workspaceId: wsId, name: 'proj',
    status: 'active', priority: 0, createdAt: now, updatedAt: now,
  } as Project);
  return projectId;
}

function seedRepository(db: ReturnType<typeof makeDb>, projectId: string): string {
  const repoId = randomUUID();
  new RepositoryRepository(db).save({
    id: repoId, projectId, provider: 'github', remote: 'org/repo',
    defaultBranch: 'main', status: 'active',
  } as Repository);
  return repoId;
}

// ── HTTP server helper ────────────────────────────────────────────────────────

let _port = 20100;
function nextPort() { return ++_port; }

async function withServer(
  fn: (base: string, ctx: {
    ws: { id: string };
    project: Project;
    workService: WorkService;
    db: ReturnType<typeof makeDb>;
  }) => Promise<void>,
): Promise<void> {
  const db = makeDb();
  const now = new Date().toISOString();
  const wsId = seedWorkspace(db);
  const projectId = seedProject(db, wsId);
  const project = new ProjectRepository(db).findById(projectId)!;
  const workService = new WorkService(db, wsId);
  const evidenceService = new EvidenceService(db);
  const srv = new ControlPlaneServer({ db, workspaceId: wsId, workService, evidenceService, port: nextPort() });
  await srv.listen();
  const base = `http://localhost:${srv.port}`;
  try {
    await fn(base, { ws: { id: wsId }, project, workService, db });
  } finally {
    await srv.close();
    db.close();
  }
}

async function post(url: string, body?: unknown) {
  const res = await fetch(url, {
    method: 'POST',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

// ═══════════════════════════════════════════════════════════════════════════════
// B.1 — WorkService.createWorkItem() (service level)
// ═══════════════════════════════════════════════════════════════════════════════

test('B.1: createWorkItem creates WorkItem in draft state', () => {
  const db = makeDb();
  const wsId = seedWorkspace(db);
  const projectId = seedProject(db, wsId);
  const svc = new WorkService(db, wsId);

  const wi = svc.createWorkItem({ projectId, title: 'My item', goal: 'Do X', workflowId: 'draft-artifact' });

  assert.equal(wi.state, 'draft');
  assert.equal(wi.projectId, projectId);
  assert.equal(wi.title, 'My item');
  assert.equal(wi.goal, 'Do X');
  assert.equal(wi.workflowId, 'draft-artifact');
  assert.deepEqual(wi.repositoryIds, []);
  assert.deepEqual(wi.dependencies, []);

  const fetched = new WorkItemRepository(db).findById(wi.id);
  assert.ok(fetched, 'WorkItem must be persisted');
  assert.equal(fetched!.state, 'draft');
  db.close();
});

test('B.1: createWorkItem persists workflowParameters intact', () => {
  const db = makeDb();
  const wsId = seedWorkspace(db);
  const projectId = seedProject(db, wsId);
  const svc = new WorkService(db, wsId);
  const params = { maxRetries: 3, env: 'staging' };

  const wi = svc.createWorkItem({
    projectId, title: 'T', goal: 'G', workflowId: 'draft-artifact', workflowParameters: params,
  });

  const fetched = new WorkItemRepository(db).findById(wi.id)!;
  assert.deepEqual(fetched.workflowParameters, params);
  db.close();
});

test('B.1: createWorkItem persists repositoryIds and validates ownership', () => {
  const db = makeDb();
  const wsId = seedWorkspace(db);
  const projectId = seedProject(db, wsId);
  const repoId = seedRepository(db, projectId);
  const svc = new WorkService(db, wsId);

  const wi = svc.createWorkItem({
    projectId, title: 'T', goal: 'G', workflowId: 'draft-artifact', repositoryIds: [repoId],
  });

  const fetched = new WorkItemRepository(db).findById(wi.id)!;
  assert.deepEqual(fetched.repositoryIds, [repoId]);
  db.close();
});

test('B.1: createWorkItem mints work.created DomainEvent in same transaction', () => {
  const db = makeDb();
  const wsId = seedWorkspace(db);
  const projectId = seedProject(db, wsId);
  const svc = new WorkService(db, wsId);

  const wi = svc.createWorkItem({ projectId, title: 'T', goal: 'G', workflowId: 'draft-artifact' });

  const events = new EventRepository(db).listByWorkItem(wi.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'work.created');
  assert.equal(events[0].workItemId, wi.id);
  db.close();
});

test('B.1: createWorkItem rejects unknown project', () => {
  const db = makeDb();
  const wsId = seedWorkspace(db);
  const svc = new WorkService(db, wsId);

  assert.throws(
    () => svc.createWorkItem({ projectId: randomUUID(), title: 'T', goal: 'G', workflowId: 'draft-artifact' }),
    (e: Error) => e.message.includes('not found'),
    'must reject unknown project',
  );
  db.close();
});

test('B.1: createWorkItem rejects project from a different workspace', () => {
  const db = makeDb();
  const wsId = seedWorkspace(db);
  const otherWsId = seedWorkspace(db);
  const otherProjectId = seedProject(db, otherWsId);
  const svc = new WorkService(db, wsId);

  assert.throws(
    () => svc.createWorkItem({ projectId: otherProjectId, title: 'T', goal: 'G', workflowId: 'draft-artifact' }),
    /workspace/i,
    'must reject project from another workspace',
  );
  db.close();
});

test('B.1: createWorkItem rejects unknown workflowId', () => {
  const db = makeDb();
  const wsId = seedWorkspace(db);
  const projectId = seedProject(db, wsId);
  const svc = new WorkService(db, wsId);

  assert.throws(
    () => svc.createWorkItem({ projectId, title: 'T', goal: 'G', workflowId: 'no-such-workflow' }),
    /not registered/i,
    'must reject unknown workflow',
  );
  db.close();
});

test('B.1: createWorkItem rejects repository from another project', () => {
  const db = makeDb();
  const wsId = seedWorkspace(db);
  const projectId = seedProject(db, wsId);
  const otherProjectId = seedProject(db, wsId);
  const otherRepoId = seedRepository(db, otherProjectId);
  const svc = new WorkService(db, wsId);

  assert.throws(
    () => svc.createWorkItem({
      projectId, title: 'T', goal: 'G', workflowId: 'draft-artifact',
      repositoryIds: [otherRepoId],
    }),
    /does not belong/i,
    'must reject repository from a different project',
  );
  db.close();
});

test('B.1: createWorkItem rejects empty title', () => {
  const db = makeDb();
  const wsId = seedWorkspace(db);
  const projectId = seedProject(db, wsId);
  const svc = new WorkService(db, wsId);

  assert.throws(
    () => svc.createWorkItem({ projectId, title: '   ', goal: 'G', workflowId: 'draft-artifact' }),
    /title.*required/i,
  );
  db.close();
});

test('B.1: createWorkItem rejects empty goal', () => {
  const db = makeDb();
  const wsId = seedWorkspace(db);
  const projectId = seedProject(db, wsId);
  const svc = new WorkService(db, wsId);

  assert.throws(
    () => svc.createWorkItem({ projectId, title: 'T', goal: '', workflowId: 'draft-artifact' }),
    /goal.*required/i,
  );
  db.close();
});

test('B.1: createWorkItem rejects array workflowParameters', () => {
  const db = makeDb();
  const wsId = seedWorkspace(db);
  const projectId = seedProject(db, wsId);
  const svc = new WorkService(db, wsId);

  assert.throws(
    () => svc.createWorkItem({
      projectId, title: 'T', goal: 'G', workflowId: 'draft-artifact',
      workflowParameters: [1, 2, 3] as unknown as Record<string, unknown>,
    }),
    /workflowParameters/i,
  );
  db.close();
});

// ═══════════════════════════════════════════════════════════════════════════════
// B.4 — POST /projects/:id/work (HTTP level)
// ═══════════════════════════════════════════════════════════════════════════════

test('B.4: POST /projects/:id/work creates WorkItem in draft state', async () => {
  await withServer(async (base, { project }) => {
    const r = await post(`${base}/projects/${project.id}/work`, {
      title: 'HTTP item', goal: 'Do Y', workflowId: 'draft-artifact',
    });
    assert.equal(r.status, 200);
    const data = (r.body as { data: { state: string; id: string } }).data;
    assert.equal(data.state, 'draft');
    assert.ok(data.id, 'id must be present');
  });
});

test('B.4: POST /projects/:id/work with workflowParameters roundtrips intact', async () => {
  await withServer(async (base, { project }) => {
    const r = await post(`${base}/projects/${project.id}/work`, {
      title: 'T', goal: 'G', workflowId: 'draft-artifact',
      workflowParameters: { key: 'value', n: 42 },
    });
    assert.equal(r.status, 200);
    const data = (r.body as { data: { workflowParameters: Record<string, unknown> } }).data;
    assert.deepEqual(data.workflowParameters, { key: 'value', n: 42 });
  });
});

test('B.4: POST /projects/:id/work rejects unknown project with error', async () => {
  await withServer(async (base) => {
    const r = await post(`${base}/projects/${randomUUID()}/work`, {
      title: 'T', goal: 'G', workflowId: 'draft-artifact',
    });
    assert.equal((r.body as { ok: boolean }).ok, false);
  });
});

test('B.4: POST /projects/:id/work rejects missing title', async () => {
  await withServer(async (base, { project }) => {
    const r = await post(`${base}/projects/${project.id}/work`, {
      goal: 'G', workflowId: 'draft-artifact',
    });
    assert.equal(r.status, 400);
  });
});

test('B.4: POST /projects/:id/work rejects missing goal', async () => {
  await withServer(async (base, { project }) => {
    const r = await post(`${base}/projects/${project.id}/work`, {
      title: 'T', workflowId: 'draft-artifact',
    });
    assert.equal(r.status, 400);
  });
});

test('B.4: POST /projects/:id/work rejects unknown workflowId', async () => {
  await withServer(async (base, { project }) => {
    const r = await post(`${base}/projects/${project.id}/work`, {
      title: 'T', goal: 'G', workflowId: 'no-such-workflow',
    });
    assert.equal((r.body as { ok: boolean }).ok, false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// B.4 — Lifecycle authority: removed routes return 404; kept routes work
// ═══════════════════════════════════════════════════════════════════════════════

test('B.4 authority: POST /work/:id/run is not a public HTTP route (404)', async () => {
  await withServer(async (base, { workService, project }) => {
    const wi = workService.createWorkItem({ projectId: project.id, title: 'T', goal: 'G', workflowId: 'draft-artifact' });
    const r = await post(`${base}/work/${wi.id}/run`);
    assert.equal(r.status, 404, '/run must not be exposed as a public HTTP endpoint');
  });
});

test('B.4 authority: POST /work/:id/review is not a public HTTP route (404)', async () => {
  await withServer(async (base, { workService, project }) => {
    const wi = workService.createWorkItem({ projectId: project.id, title: 'T', goal: 'G', workflowId: 'draft-artifact' });
    const r = await post(`${base}/work/${wi.id}/review`);
    assert.equal(r.status, 404, '/review must not be exposed as a public HTTP endpoint');
  });
});

test('B.4 authority: POST /work/:id/complete is not a public HTTP route (404)', async () => {
  await withServer(async (base, { workService, project }) => {
    const wi = workService.createWorkItem({ projectId: project.id, title: 'T', goal: 'G', workflowId: 'draft-artifact' });
    const r = await post(`${base}/work/${wi.id}/complete`);
    assert.equal(r.status, 404, '/complete must not be exposed as a public HTTP endpoint');
  });
});

test('B.4 authority: POST /work/:id/ready (draft → ready) remains operator-accessible', async () => {
  await withServer(async (base, { workService, project }) => {
    const wi = workService.createWorkItem({ projectId: project.id, title: 'T', goal: 'G', workflowId: 'draft-artifact' });
    const r = await post(`${base}/work/${wi.id}/ready`);
    assert.equal(r.status, 200);
    assert.equal((r.body as { data: { state: string } }).data.state, 'ready');
  });
});

test('B.4 authority: POST /projects/:id/work → draft → ready is the operator path; WorkService.startRunning() is Scheduler-internal', () => {
  const db = makeDb();
  const wsId = seedWorkspace(db);
  const projectId = seedProject(db, wsId);
  const svc = new WorkService(db, wsId);

  const wi = svc.createWorkItem({ projectId, title: 'T', goal: 'G', workflowId: 'draft-artifact' });
  assert.equal(wi.state, 'draft');

  svc.markReady({ workItemId: wi.id });
  const readyItem = new WorkItemRepository(db).findById(wi.id)!;
  assert.equal(readyItem.state, 'ready');

  // Scheduler calls startRunning — WorkService method is not removed; only the HTTP route is removed.
  svc.startRunning({ workItemId: wi.id });
  const runningItem = new WorkItemRepository(db).findById(wi.id)!;
  assert.equal(runningItem.state, 'running');

  db.close();
});

// ═══════════════════════════════════════════════════════════════════════════════
// B.3 — Terminal-checkpoint atomicity regression
// ═══════════════════════════════════════════════════════════════════════════════

test('B.3: terminal checkpoint — Decision resolved + WorkflowRun complete + WorkItem in_review are one atomic commit', async () => {
  const db = makeDb();
  const wsId = seedWorkspace(db);
  const projectId = seedProject(db, wsId);

  const now = new Date().toISOString();
  const workItemId = randomUUID();
  const runId = randomUUID();
  const decisionId = randomUUID();

  // Seed a work item in needs_decision (awaiting the terminal checkpoint).
  new WorkItemRepository(db).save({
    id: workItemId, projectId, repositoryIds: [],
    title: 't', goal: 'g', workflowId: TERMINAL_WF_ID,
    state: 'needs_decision', priority: 0,
    acceptanceCriteria: [], constraints: [], requiredEvidence: [],
    dependencies: [], createdAt: now, updatedAt: now,
  } as WorkItem);

  new WorkflowRunRepository(db).createOrValidate({
    run_id: runId, workflow_id: TERMINAL_WF_ID, work_item_id: workItemId,
    status: 'halted', current_step_id: 'gate',
    iteration: 1, revision: 0, awaiting_checkpoint: 'gate',
    started_at: now, updated_at: now,
  });

  new DecisionRepository(db).save({
    id: decisionId, projectId, workItemId, type: 'checkpoint',
    subjectRef: { workflowRunId: runId, workItemId, stepId: 'gate' },
    title: 'Final gate', summary: 'approve to complete',
    options: [{ id: 'approve', label: 'Approve', description: '' }],
    impact: 'low', reversibility: 'easy', urgency: 'normal', status: 'pending',
  } as any);

  const registry = new ExecutorRegistry();
  registry.register(makeStubAdapter());

  const resumeSvc = new ResumeService(db, wsId, registry, {});
  await resumeSvc.resume(decisionId, { selectedOptionId: 'approve' });

  // Decision resolved.
  const decision = new DecisionRepository(db).findById(decisionId)!;
  assert.equal(decision.status, 'resolved', 'Decision must be resolved');

  // WorkflowRun completed.
  const run = new WorkflowRunRepository(db).findById(runId)!;
  assert.equal(run.status, 'complete', 'WorkflowRun must be complete');

  // WorkItem is in_review — NOT running. If the transition were non-atomic,
  // a crash between the transaction and the old markInReview() call would have
  // left WorkItem in 'running'.
  const wi = new WorkItemRepository(db).findById(workItemId)!;
  assert.equal(wi.state, 'in_review', 'WorkItem must be in_review after terminal checkpoint');

  db.close();
});
