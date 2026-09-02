import { test } from 'node:test';
import { strict as assert } from 'assert';
import { randomUUID } from 'crypto';
import { openDatabase } from '../src/storage/database.js';
import {
  WorkspaceRepository,
  ProjectRepository,
  WorkItemRepository,
  ArtifactRepository,
} from '../src/storage/repositories.js';
import { WorkService } from '../src/services/work-service.js';
import { EvidenceService } from '../src/services/evidence-service.js';
import { ControlPlaneServer } from '../src/api/control-plane-server.js';
import type { Workspace, Project, WorkItem } from '../src/domain/index.js';

// ============================================================================
// Helpers
// ============================================================================

function openTestDb() { return openDatabase(':memory:'); }

function makeWorkspace(): Workspace {
  return { id: randomUUID(), name: 'ws', createdAt: new Date().toISOString() };
}

function makeProject(workspaceId: string): Project {
  const now = new Date().toISOString();
  return { id: randomUUID(), workspaceId, name: 'proj', status: 'active', priority: 0, createdAt: now, updatedAt: now };
}

function makeWorkItem(projectId: string): WorkItem {
  const now = new Date().toISOString();
  return {
    id: randomUUID(), projectId, repositoryIds: [], title: 'Test item', goal: 'Do the thing',
    workflowId: 'draft-artifact', state: 'draft', priority: 0,
    acceptanceCriteria: [], constraints: [], requiredEvidence: [], dependencies: [],
    createdAt: now, updatedAt: now,
  };
}

let _port = 19100;
function nextPort() { return ++_port; }

async function withServer(
  fn: (baseUrl: string, ctx: { workItem: WorkItem; project: Project; workspace: Workspace; workService: WorkService; db: ReturnType<typeof openTestDb> }) => Promise<void>,
): Promise<void> {
  const db = openTestDb();
  const wsRepo = new WorkspaceRepository(db);
  const prRepo = new ProjectRepository(db);
  const wiRepo = new WorkItemRepository(db);

  const ws = makeWorkspace();
  const proj = makeProject(ws.id);
  const wi = makeWorkItem(proj.id);

  wsRepo.save(ws);
  prRepo.save(proj);
  wiRepo.save(wi);

  const workService = new WorkService(db, ws.id);
  const evidenceService = new EvidenceService(db);

  const srv = new ControlPlaneServer({ db, workspaceId: ws.id, workService, evidenceService, port: nextPort() });
  await srv.listen();
  const base = `http://localhost:${srv.port}`;
  try {
    await fn(base, { workItem: wi, project: proj, workspace: ws, workService, db });
  } finally {
    await srv.close();
    db.close();
  }
}

async function get(url: string) {
  const res = await fetch(url);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function post(url: string, body?: unknown) {
  const res = await fetch(url, {
    method: 'POST',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

// ============================================================================
// Router
// ============================================================================

test('testRouterReturns404ForUnknown', async () => {
  await withServer(async (base) => {
    const r = await get(`${base}/unknown/path`);
    assert.equal(r.status, 404);
    assert.equal((r.body as { ok: boolean }).ok, false);
  });
});

// ============================================================================
// Projects
// ============================================================================

test('testProjectsList', async () => {
  await withServer(async (base, { project }) => {
    const r = await get(`${base}/projects`);
    assert.equal(r.status, 200);
    const data = (r.body as { data: { id: string }[] }).data;
    assert.ok(data.some(p => p.id === project.id));
  });
});

test('testProjectsGetById', async () => {
  await withServer(async (base, { project }) => {
    const r = await get(`${base}/projects/${project.id}`);
    assert.equal(r.status, 200);
    assert.equal((r.body as { data: { id: string } }).data.id, project.id);
  });
});

test('testProjectsGetByIdNotFound', async () => {
  await withServer(async (base) => {
    const r = await get(`${base}/projects/${randomUUID()}`);
    assert.equal(r.status, 404);
  });
});

// ============================================================================
// Work items
// ============================================================================

test('testWorkGetById', async () => {
  await withServer(async (base, { workItem }) => {
    const r = await get(`${base}/work/${workItem.id}`);
    assert.equal(r.status, 200);
    const data = (r.body as { data: { id: string; state: string } }).data;
    assert.equal(data.id, workItem.id);
    assert.equal(data.state, 'draft');
  });
});

test('testWorkGetByIdNotFound', async () => {
  await withServer(async (base) => {
    const r = await get(`${base}/work/${randomUUID()}`);
    assert.equal(r.status, 404);
  });
});

test('testProjectWorkList', async () => {
  await withServer(async (base, { workItem, project }) => {
    const r = await get(`${base}/projects/${project.id}/work`);
    assert.equal(r.status, 200);
    const data = (r.body as { data: { id: string }[] }).data;
    assert.ok(data.some(w => w.id === workItem.id));
  });
});

test('testProjectWorkListFilterByState', async () => {
  await withServer(async (base, { project }) => {
    const r = await get(`${base}/projects/${project.id}/work?state=ready`);
    assert.equal(r.status, 200);
    const data = (r.body as { data: unknown[] }).data;
    assert.equal(data.length, 0);
  });
});

test('testWorkReady', async () => {
  await withServer(async (base, { workItem }) => {
    const r = await post(`${base}/work/${workItem.id}/ready`);
    assert.equal(r.status, 200);
    assert.equal((r.body as { data: { state: string } }).data.state, 'ready');
  });
});

test('testWorkPause_removedRoute', async () => {
  await withServer(async (base, { workItem }) => {
    // /pause is not a public HTTP endpoint — pause/cancel/fail/block require
    // cooperative cancellation semantics that are not yet implemented.
    const r = await post(`${base}/work/${workItem.id}/pause`);
    assert.equal(r.status, 404, '/pause must not be a public HTTP route');
  });
});

test('testWorkCancel_removedRoute', async () => {
  await withServer(async (base, { workItem }) => {
    const r = await post(`${base}/work/${workItem.id}/cancel`, { reason: 'no longer needed' });
    assert.equal(r.status, 404, '/cancel must not be a public HTTP route');
  });
});

test('testWorkFail_removedRoute', async () => {
  await withServer(async (base, { workItem }) => {
    const r = await post(`${base}/work/${workItem.id}/fail`, { reason: 'something broke' });
    assert.equal(r.status, 404, '/fail must not be a public HTTP route');
  });
});

test('testWorkInvalidTransitionReturnsError', async () => {
  await withServer(async (base, { workItem }) => {
    // /complete was removed — returns 404 with ok:false.
    const r = await post(`${base}/work/${workItem.id}/complete`);
    assert.equal((r.body as { ok: boolean }).ok, false);
  });
});

// ============================================================================
// Evidence
// ============================================================================

test('testEvidenceEmptyInitially', async () => {
  await withServer(async (base, { workItem }) => {
    const r = await get(`${base}/work/${workItem.id}/evidence`);
    assert.equal(r.status, 200);
    assert.deepEqual((r.body as { data: unknown[] }).data, []);
  });
});

test('testEvidenceRecord', async () => {
  await withServer(async (base, { workItem }) => {
    const r = await post(`${base}/work/${workItem.id}/evidence`, {
      type: 'github.ci',
      source: 'github',
      status: 'passed',
      payload: { sha: 'abc123' },
    });
    assert.equal(r.status, 200);
    const data = (r.body as { data: { type: string; status: string } }).data;
    assert.equal(data.type, 'github.ci');
    assert.equal(data.status, 'passed');
  });
});

test('testEvidenceRequiresFields', async () => {
  await withServer(async (base, { workItem }) => {
    const r = await post(`${base}/work/${workItem.id}/evidence`, { type: 'github.ci' });
    assert.equal(r.status, 400);
  });
});

// ============================================================================
// Artifacts (D.1c — docs/developmentPlan/d1a-declarative-contract-spike.md §4)
// ============================================================================

test('testArtifactsEmptyInitially', async () => {
  await withServer(async (base, { workItem }) => {
    const r = await get(`${base}/work/${workItem.id}/artifacts`);
    assert.equal(r.status, 200);
    assert.deepEqual((r.body as { data: unknown[] }).data, []);
  });
});

test('testArtifactsReturnsLatestPerRef', async () => {
  await withServer(async (base, { workItem, db }) => {
    const artifacts = new ArtifactRepository(db);
    const now = new Date().toISOString();
    artifacts.save({
      id: 'a1', workItemId: workItem.id, workflowRunId: 'run-1',
      type: 'definition', ref: 'definition:definition', path: '.sle/work/definition.md',
      hash: 'hashA', createdAt: now,
    });
    // A second, later version of the same ref — only the latest should be returned.
    artifacts.save({
      id: 'a2', workItemId: workItem.id, workflowRunId: 'run-1',
      type: 'definition', ref: 'definition:definition', path: '.sle/work/definition.md',
      hash: 'hashB', createdAt: now,
    });

    const r = await get(`${base}/work/${workItem.id}/artifacts`);
    assert.equal(r.status, 200);
    const data = (r.body as { data: Array<{ ref: string; hash: string; path: string }> }).data;
    assert.equal(data.length, 1, 'only the current version of the ref should be returned, not full history');
    assert.equal(data[0].ref, 'definition:definition');
    assert.equal(data[0].hash, 'hashB');
    // Metadata only — no field carries file content, only its recorded path.
    assert.equal(data[0].path, '.sle/work/definition.md');
  });
});

test('testArtifactsNotFoundForUnknownWorkItem', async () => {
  await withServer(async (base) => {
    const r = await get(`${base}/work/does-not-exist/artifacts`);
    assert.equal(r.status, 404);
  });
});

test('testArtifactsWorkspaceIsolation', async () => {
  await withServer(async (base, { db }) => {
    // A WorkItem in a completely different workspace, with an artifact
    // recorded against it, must not be reachable through this server
    // (configured for the first workspace) even though the id is valid.
    const wsB: Workspace = { id: randomUUID(), name: 'ws-b', createdAt: new Date().toISOString() };
    new WorkspaceRepository(db).save(wsB);
    const projB = makeProject(wsB.id);
    new ProjectRepository(db).save(projB);
    const wiB = makeWorkItem(projB.id);
    new WorkItemRepository(db).save(wiB);
    new ArtifactRepository(db).save({
      id: 'a-b1', workItemId: wiB.id, workflowRunId: 'run-b',
      type: 'definition', ref: 'definition:definition', path: '.sle/work/definition.md',
      hash: 'hashB', createdAt: new Date().toISOString(),
    });

    const r = await get(`${base}/work/${wiB.id}/artifacts`);
    assert.equal(r.status, 404, 'a WorkItem belonging to another workspace must not be visible through this endpoint');
  });
});

// ============================================================================
// Events
// ============================================================================

test('testEventsReturnsWorkspaceEvents', async () => {
  await withServer(async (base, { workItem }) => {
    await post(`${base}/work/${workItem.id}/ready`);
    const r = await get(`${base}/events`);
    assert.equal(r.status, 200);
    assert.ok((r.body as { data: unknown[] }).data.length >= 1);
  });
});

test('testWorkItemEvents', async () => {
  await withServer(async (base, { workItem }) => {
    await post(`${base}/work/${workItem.id}/ready`);
    const r = await get(`${base}/work/${workItem.id}/events`);
    assert.equal(r.status, 200);
    assert.ok((r.body as { data: unknown[] }).data.length >= 1);
  });
});

// ============================================================================
// Workflows
// ============================================================================

test('testWorkflowsList', async () => {
  await withServer(async (base) => {
    const r = await get(`${base}/workflows`);
    assert.equal(r.status, 200);
    assert.ok((r.body as { data: unknown[] }).data.length >= 2);
  });
});

test('testWorkflowsGetById', async () => {
  await withServer(async (base) => {
    const r = await get(`${base}/workflows/draft-artifact`);
    assert.equal(r.status, 200);
    assert.equal((r.body as { data: { id: string } }).data.id, 'draft-artifact');
  });
});

test('testWorkflowsNotFound', async () => {
  await withServer(async (base) => {
    const r = await get(`${base}/workflows/no-such`);
    assert.equal(r.status, 404);
  });
});

// ============================================================================
// Attention
// ============================================================================

test('testAttentionEmptyWhenNoIssues', async () => {
  await withServer(async (base) => {
    const r = await get(`${base}/attention`);
    assert.equal(r.status, 200);
    assert.deepEqual((r.body as { data: unknown[] }).data, []);
  });
});

test('testAttentionSurfacesFailedWorkItems', async () => {
  // /fail is not a public HTTP endpoint; use WorkService directly to put the item in failed state.
  await withServer(async (base, { workItem, workService }) => {
    workService.fail({ workItemId: workItem.id, reason: 'broke' });
    const r = await get(`${base}/attention`);
    assert.equal(r.status, 200);
    const data = (r.body as { data: { category: string; workItemId: string }[] }).data;
    assert.ok(data.some(i => i.category === 'work_failed' && i.workItemId === workItem.id));
  });
});
