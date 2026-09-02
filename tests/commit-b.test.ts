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
} from '../src/storage/repositories.js';
import { WorkService } from '../src/services/work-service.js';
import { EvidenceService } from '../src/services/evidence-service.js';
import { ResumeService } from '../src/services/resume-service.js';
import { Scheduler } from '../src/scheduler/index.js';
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

test('B.1: createWorkItem rejects null workflowParameters', () => {
  const db = makeDb();
  const wsId = seedWorkspace(db);
  const projectId = seedProject(db, wsId);
  const svc = new WorkService(db, wsId);

  assert.throws(
    () => svc.createWorkItem({
      projectId, title: 'T', goal: 'G', workflowId: 'draft-artifact',
      workflowParameters: null as unknown as Record<string, unknown>,
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

// ── Malformed optional field rejection ───────────────────────────────────────

test('B.4: POST /projects/:id/work rejects repositoryIds as non-array string', async () => {
  await withServer(async (base, { project }) => {
    const r = await post(`${base}/projects/${project.id}/work`, {
      title: 'T', goal: 'G', workflowId: 'draft-artifact',
      repositoryIds: 'repo-id',
    });
    assert.equal(r.status, 400, 'repositoryIds as string must be rejected');
  });
});

test('B.4: POST /projects/:id/work rejects priority as non-number string', async () => {
  await withServer(async (base, { project }) => {
    const r = await post(`${base}/projects/${project.id}/work`, {
      title: 'T', goal: 'G', workflowId: 'draft-artifact',
      priority: 'high',
    });
    assert.equal(r.status, 400, 'priority as string must be rejected');
  });
});

test('B.4: POST /projects/:id/work rejects acceptanceCriteria as non-array', async () => {
  await withServer(async (base, { project }) => {
    const r = await post(`${base}/projects/${project.id}/work`, {
      title: 'T', goal: 'G', workflowId: 'draft-artifact',
      acceptanceCriteria: 'pass everything',
    });
    assert.equal(r.status, 400, 'acceptanceCriteria as string must be rejected');
  });
});

test('B.4: POST /projects/:id/work rejects workflowParameters as array', async () => {
  await withServer(async (base, { project }) => {
    const r = await post(`${base}/projects/${project.id}/work`, {
      title: 'T', goal: 'G', workflowId: 'draft-artifact',
      workflowParameters: [1, 2, 3],
    });
    assert.equal(r.status, 400, 'workflowParameters as array must be rejected');
  });
});

test('B.4: POST /projects/:id/work rejects workflowParameters as null', async () => {
  await withServer(async (base, { project }) => {
    const r = await post(`${base}/projects/${project.id}/work`, {
      title: 'T', goal: 'G', workflowId: 'draft-artifact',
      workflowParameters: null,
    });
    assert.equal(r.status, 400, 'workflowParameters as null must be rejected');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// B.4 — Lifecycle authority: removed routes return 404; kept route works
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

test('B.4 authority: POST /work/:id/pause is not a public HTTP route (404)', async () => {
  await withServer(async (base, { workService, project }) => {
    const wi = workService.createWorkItem({ projectId: project.id, title: 'T', goal: 'G', workflowId: 'draft-artifact' });
    const r = await post(`${base}/work/${wi.id}/pause`);
    assert.equal(r.status, 404, '/pause must not be exposed as a public HTTP endpoint');
  });
});

test('B.4 authority: POST /work/:id/cancel is not a public HTTP route (404)', async () => {
  await withServer(async (base, { workService, project }) => {
    const wi = workService.createWorkItem({ projectId: project.id, title: 'T', goal: 'G', workflowId: 'draft-artifact' });
    const r = await post(`${base}/work/${wi.id}/cancel`);
    assert.equal(r.status, 404, '/cancel must not be exposed as a public HTTP endpoint');
  });
});

test('B.4 authority: POST /work/:id/resume is not a public HTTP route (404)', async () => {
  await withServer(async (base, { workService, project }) => {
    const wi = workService.createWorkItem({ projectId: project.id, title: 'T', goal: 'G', workflowId: 'draft-artifact' });
    const r = await post(`${base}/work/${wi.id}/resume`);
    assert.equal(r.status, 404, '/resume must not be exposed as a public HTTP endpoint');
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

// ═══════════════════════════════════════════════════════════════════════════════
// B.4 — Scheduler authority: only Scheduler.tick() moves ready → running
// ═══════════════════════════════════════════════════════════════════════════════

test('B.4 Scheduler authority: tick() creates StepExecution + workflowRunId + moves WorkItem to running', async () => {
  const db = makeDb();
  const wsId = seedWorkspace(db);
  const projectId = seedProject(db, wsId);
  const svc = new WorkService(db, wsId);

  // Create and advance to ready via the operator path.
  const wi = svc.createWorkItem({ projectId, title: 'T', goal: 'G', workflowId: 'draft-artifact' });
  svc.markReady({ workItemId: wi.id });

  // Confirm WorkItem is ready before tick.
  const before = new WorkItemRepository(db).findById(wi.id)!;
  assert.equal(before.state, 'ready', 'WorkItem must be ready before tick');

  // No StepExecutions yet.
  const stepsBefore = new StepExecutionRepository(db).listByWorkItem(wi.id);
  assert.equal(stepsBefore.length, 0, 'No StepExecutions before tick');

  // Scheduler.tick() — injected stub adapter returns succeeded immediately.
  const registry = new ExecutorRegistry();
  registry.register(makeStubAdapter());
  const scheduler = new Scheduler(db, wsId, registry);
  const results = await scheduler.tick();

  assert.equal(results.length, 1);
  assert.equal(results[0].outcome, 'dispatched', `expected dispatched, got: ${results[0].outcome}`);
  assert.equal(results[0].workItemId, wi.id);

  // Scheduler minted a StepExecution with a workflowRunId.
  const steps = new StepExecutionRepository(db).listByWorkItem(wi.id);
  assert.ok(steps.length > 0, 'Scheduler must have created at least one StepExecution');
  assert.ok(steps[0].workflowRunId, 'Scheduler must mint a workflowRunId on the StepExecution');

  // WorkItem was moved through running (stub completes immediately → in_review or completed).
  const after = new WorkItemRepository(db).findById(wi.id)!;
  assert.notEqual(after.state, 'ready', 'WorkItem must no longer be ready after tick');
  assert.notEqual(after.state, 'draft', 'WorkItem must not be in draft after tick');

  db.close();
});

test('B.4 Scheduler authority: no HTTP route can independently force ready → running', async () => {
  await withServer(async (base, { workService, project }) => {
    const wi = workService.createWorkItem({ projectId: project.id, title: 'T', goal: 'G', workflowId: 'draft-artifact' });
    workService.markReady({ workItemId: wi.id });

    // Attempt to move to running via each removed route.
    const runResult = await post(`${base}/work/${wi.id}/run`);
    assert.equal(runResult.status, 404, '/run must not force running');

    // WorkItem must still be ready — no HTTP route changed its state.
    const stillReady = await fetch(`${base}/work/${wi.id}`);
    const body = (await stillReady.json()) as { data: { state: string } };
    assert.equal(body.data.state, 'ready', 'WorkItem must remain ready when HTTP routes are blocked');
  });
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

  const decision = new DecisionRepository(db).findById(decisionId)!;
  assert.equal(decision.status, 'resolved', 'Decision must be resolved');

  const run = new WorkflowRunRepository(db).findById(runId)!;
  assert.equal(run.status, 'complete', 'WorkflowRun must be complete');

  // WorkItem is in_review — NOT running. Pre-fix, a crash between the
  // transaction commit and the old markInReview() call would leave it running.
  const wi = new WorkItemRepository(db).findById(workItemId)!;
  assert.equal(wi.state, 'in_review', 'WorkItem must be in_review after terminal checkpoint');

  db.close();
});
