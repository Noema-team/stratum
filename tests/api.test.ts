import { test } from 'node:test';
import { strict as assert } from 'assert';
import { randomUUID } from 'crypto';
import { openDatabase } from '../src/storage/database.js';
import {
  WorkspaceRepository,
  ProjectRepository,
  WorkItemRepository,
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
  fn: (baseUrl: string, ctx: { workItem: WorkItem; project: Project; workspace: Workspace }) => Promise<void>,
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
    await fn(base, { workItem: wi, project: proj, workspace: ws });
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

test('testWorkPause', async () => {
  await withServer(async (base, { workItem }) => {
    await post(`${base}/work/${workItem.id}/ready`);
    await post(`${base}/work/${workItem.id}/run`);
    const r = await post(`${base}/work/${workItem.id}/pause`);
    assert.equal(r.status, 200);
    assert.equal((r.body as { data: { state: string } }).data.state, 'paused');
  });
});

test('testWorkCancel', async () => {
  await withServer(async (base, { workItem }) => {
    await post(`${base}/work/${workItem.id}/ready`);
    const r = await post(`${base}/work/${workItem.id}/cancel`, { reason: 'no longer needed' });
    assert.equal(r.status, 200);
    assert.equal((r.body as { data: { state: string } }).data.state, 'cancelled');
  });
});

test('testWorkFailRequiresReason', async () => {
  await withServer(async (base, { workItem }) => {
    const r = await post(`${base}/work/${workItem.id}/fail`, {});
    assert.equal(r.status, 400);
  });
});

test('testWorkFailWithReason', async () => {
  await withServer(async (base, { workItem }) => {
    const r = await post(`${base}/work/${workItem.id}/fail`, { reason: 'something broke' });
    assert.equal(r.status, 200);
    assert.equal((r.body as { data: { state: string } }).data.state, 'failed');
  });
});

test('testWorkInvalidTransitionReturnsError', async () => {
  await withServer(async (base, { workItem }) => {
    // draft → complete is not a valid transition
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
  await withServer(async (base, { workItem }) => {
    await post(`${base}/work/${workItem.id}/fail`, { reason: 'broke' });
    const r = await get(`${base}/attention`);
    assert.equal(r.status, 200);
    const data = (r.body as { data: { category: string; workItemId: string }[] }).data;
    assert.ok(data.some(i => i.category === 'work_failed' && i.workItemId === workItem.id));
  });
});
