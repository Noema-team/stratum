// Commit C — Control-plane route consolidation tests
//
// Covers:
//   1. Route inventory / absence — legacy cycle/halt/resume routes are not exposed
//   2. Workspace isolation — cross-workspace reads are rejected (not found, not forbidden)
//   3. Compatibility routes — /api/v2/info, /api/v2/system/state, /api/v2/settings
//   4. Application composition — createStratumApplication() creates no DaemonServer
//
// Does NOT test WorkflowEngine, DaemonServer internals, or service-layer units.

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

let _port = 19200;
function nextPort() { return ++_port; }

interface ServerCtx {
  workItem: WorkItem;
  project: Project;
  workspace: Workspace;
  workService: WorkService;
  db: ReturnType<typeof openTestDb>;
}

async function withServer(
  fn: (baseUrl: string, ctx: ServerCtx) => Promise<void>,
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

  const srv = new ControlPlaneServer({
    db, workspaceId: ws.id, workService, evidenceService, port: nextPort(),
  });
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
// 1. Route inventory / absence
// Legacy cycle, halt, and resume routes must not exist in ControlPlaneServer.
// Any request to these paths must return 404.
// ============================================================================

test('C.route: GET /api/v2/cycles/current is not exposed', async () => {
  await withServer(async (base) => {
    const r = await get(`${base}/api/v2/cycles/current`);
    assert.equal(r.status, 404);
  });
});

test('C.route: POST /api/v2/cycles/halt is not exposed', async () => {
  await withServer(async (base) => {
    const r = await post(`${base}/api/v2/cycles/halt`);
    assert.equal(r.status, 404);
  });
});

test('C.route: POST /api/v2/cycles/resume is not exposed', async () => {
  await withServer(async (base) => {
    const r = await post(`${base}/api/v2/cycles/resume`);
    assert.equal(r.status, 404);
  });
});

test('C.route: POST /api/v2/cycles/current/approve is not exposed', async () => {
  await withServer(async (base) => {
    const r = await post(`${base}/api/v2/cycles/current/approve`);
    assert.equal(r.status, 404);
  });
});

test('C.route: POST /api/v2/cycles/start is not exposed', async () => {
  await withServer(async (base) => {
    const r = await post(`${base}/api/v2/cycles/start`, { intent: 'test' });
    assert.equal(r.status, 404);
  });
});

test('C.route: GET /api/v2/discovery/status is not exposed', async () => {
  await withServer(async (base) => {
    const r = await get(`${base}/api/v2/discovery/status`);
    assert.equal(r.status, 404);
  });
});

test('C.route: GET /api/v2/links is not exposed', async () => {
  await withServer(async (base) => {
    const r = await get(`${base}/api/v2/links`);
    assert.equal(r.status, 404);
  });
});

test('C.route: GET /api/v2/system/flags is not exposed', async () => {
  await withServer(async (base) => {
    const r = await get(`${base}/api/v2/system/flags`);
    assert.equal(r.status, 404);
  });
});

// ============================================================================
// 2. Workspace isolation
// Resources from a different workspace must not be visible through this server.
// The response must be 404 — not 403 — so existence is not revealed.
// ============================================================================

test('C.scope: cross-workspace WorkItem read is rejected', async () => {
  await withServer(async (base, { db }) => {
    const ws2 = makeWorkspace();
    const proj2 = makeProject(ws2.id);
    const wi2 = makeWorkItem(proj2.id);

    new WorkspaceRepository(db).save(ws2);
    new ProjectRepository(db).save(proj2);
    new WorkItemRepository(db).save(wi2);

    const r = await get(`${base}/work/${wi2.id}`);
    assert.equal(r.status, 404, 'cross-workspace WorkItem must be not found');
  });
});

test('C.scope: cross-workspace project work listing is rejected', async () => {
  await withServer(async (base, { db }) => {
    const ws2 = makeWorkspace();
    const proj2 = makeProject(ws2.id);
    new WorkspaceRepository(db).save(ws2);
    new ProjectRepository(db).save(proj2);

    const r = await get(`${base}/projects/${proj2.id}/work`);
    assert.equal(r.status, 404, 'cross-workspace project work list must be not found');
  });
});

test('C.scope: cross-workspace project GET is rejected', async () => {
  await withServer(async (base, { db }) => {
    const ws2 = makeWorkspace();
    const proj2 = makeProject(ws2.id);
    new WorkspaceRepository(db).save(ws2);
    new ProjectRepository(db).save(proj2);

    const r = await get(`${base}/projects/${proj2.id}`);
    assert.equal(r.status, 404, 'cross-workspace project must be not found');
  });
});

test('C.scope: cross-workspace ready transition is rejected', async () => {
  await withServer(async (base, { db }) => {
    const ws2 = makeWorkspace();
    const proj2 = makeProject(ws2.id);
    const wi2 = makeWorkItem(proj2.id);

    new WorkspaceRepository(db).save(ws2);
    new ProjectRepository(db).save(proj2);
    new WorkItemRepository(db).save(wi2);

    const r = await post(`${base}/work/${wi2.id}/ready`);
    assert.equal(r.status, 404, 'cross-workspace ready must be not found');
  });
});

test('C.scope: cross-workspace evidence read is rejected', async () => {
  await withServer(async (base, { db }) => {
    const ws2 = makeWorkspace();
    const proj2 = makeProject(ws2.id);
    const wi2 = makeWorkItem(proj2.id);

    new WorkspaceRepository(db).save(ws2);
    new ProjectRepository(db).save(proj2);
    new WorkItemRepository(db).save(wi2);

    const r = await get(`${base}/work/${wi2.id}/evidence`);
    assert.equal(r.status, 404, 'cross-workspace evidence must be not found');
  });
});

test('C.scope: cross-workspace events read is rejected', async () => {
  await withServer(async (base, { db }) => {
    const ws2 = makeWorkspace();
    const proj2 = makeProject(ws2.id);
    const wi2 = makeWorkItem(proj2.id);

    new WorkspaceRepository(db).save(ws2);
    new ProjectRepository(db).save(proj2);
    new WorkItemRepository(db).save(wi2);

    const r = await get(`${base}/work/${wi2.id}/events`);
    assert.equal(r.status, 404, 'cross-workspace events must be not found');
  });
});

// ============================================================================
// 3. Retired compat routes (/api/v2/*) — all now return 404
// ============================================================================

test('C.compat: GET /api/v2/info is not exposed (retired)', async () => {
  await withServer(async (base) => {
    const r = await get(`${base}/api/v2/info`);
    assert.equal(r.status, 404);
  });
});

test('C.compat: GET /api/v2/system/state is not exposed (retired)', async () => {
  await withServer(async (base) => {
    const r = await get(`${base}/api/v2/system/state`);
    assert.equal(r.status, 404);
  });
});

test('C.compat: GET /api/v2/settings is not exposed (retired)', async () => {
  await withServer(async (base) => {
    const r = await get(`${base}/api/v2/settings`);
    assert.equal(r.status, 404);
  });
});

// ============================================================================
// 4. Application composition
// createStratumApplication() must not instantiate DaemonServer.
// ============================================================================

test('C.composition: createStratumApplication source does not import DaemonServer', async () => {
  // Check that the application module source does not reference DaemonServer.
  // This guards against accidental re-introduction of the dual-server pattern.
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');

  const dir = dirname(fileURLToPath(import.meta.url));
  const appSrc = readFileSync(join(dir, '../src/application.ts'), 'utf8');

  assert.ok(
    !appSrc.includes('DaemonServer'),
    'application.ts must not reference DaemonServer',
  );
  assert.ok(
    !appSrc.includes('daemon.js') && !appSrc.includes("'./daemon'"),
    'application.ts must not import daemon.ts',
  );
});

test('C.composition: createStratumApplication returns controlPlaneServer and schedulerLoop only', async () => {
  // Import and call createStratumApplication, verify the returned object shape.
  // Uses a temp dir for projectRoot so no actual .sle/ is written during the test.
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { randomUUID: uuid } = await import('node:crypto');

  const db = openTestDb();
  const ws = makeWorkspace();
  new WorkspaceRepository(db).save(ws);
  db.close();

  const projectRoot = mkdtempSync(join(tmpdir(), 'stratum-test-'));
  try {
    const { createStratumApplication } = await import('../src/application.js');
    const app = createStratumApplication({
      projectRoot,
      workspaceId: uuid(),
      dbPath: ':memory:',
      port: nextPort(),
    });

    assert.ok('controlPlaneServer' in app, 'must have controlPlaneServer');
    assert.ok('schedulerLoop' in app, 'must have schedulerLoop');
    assert.ok('start' in app, 'must have start()');
    assert.ok('stop' in app, 'must have stop()');
    assert.ok(!('daemonServer' in app), 'must NOT have daemonServer');

    // Verify server is a ControlPlaneServer (has port and listen/close)
    assert.ok(typeof (app.controlPlaneServer as any).port === 'number');

  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 5. Canonical routes still work after scope guard addition
// ============================================================================

test('C.canonical: same-workspace WorkItem read still works', async () => {
  await withServer(async (base, { workItem }) => {
    const r = await get(`${base}/work/${workItem.id}`);
    assert.equal(r.status, 200);
    assert.equal((r.body as { data: { id: string } }).data.id, workItem.id);
  });
});

test('C.canonical: same-workspace project GET still works', async () => {
  await withServer(async (base, { project }) => {
    const r = await get(`${base}/projects/${project.id}`);
    assert.equal(r.status, 200);
    assert.equal((r.body as { data: { id: string } }).data.id, project.id);
  });
});

test('C.canonical: same-workspace evidence read still works', async () => {
  await withServer(async (base, { workItem }) => {
    const r = await get(`${base}/work/${workItem.id}/evidence`);
    assert.equal(r.status, 200);
    assert.deepEqual((r.body as { data: unknown[] }).data, []);
  });
});

test('C.canonical: same-workspace events read still works', async () => {
  await withServer(async (base, { workItem }) => {
    const r = await get(`${base}/work/${workItem.id}/events`);
    assert.equal(r.status, 200);
    assert.deepEqual((r.body as { data: unknown[] }).data, []);
  });
});
