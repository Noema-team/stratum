import { openDatabase } from '../src/storage/database.js';
import { ControlPlaneServer } from '../src/api/control-plane-server.js';
import { WorkService } from '../src/services/work-service.js';
import { EvidenceService } from '../src/services/evidence-service.js';
import { TokenStore } from '../src/auth/token-store.js';
import type Database from 'better-sqlite3';

// ============================================================================
// Helpers
// ============================================================================

let _port = 19300;
function nextPort(): number { return _port++; }

function makeDb(): Database.Database {
  return openDatabase(':memory:');
}

function seedWorkspace(db: Database.Database, id: string): void {
  db.prepare("INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)").run(
    id, 'Test Workspace', new Date().toISOString(),
  );
}

interface Ctx {
  base: string;
  server: ControlPlaneServer;
  tokens: TokenStore;
  db: Database.Database;
}

async function withServer(fn: (ctx: Ctx) => Promise<void>, requireAuth = false): Promise<void> {
  const db = makeDb();
  const wsId = 'ws-dash-test';
  seedWorkspace(db, wsId);
  const port = nextPort();
  const workService = new WorkService(db);
  const evidenceService = new EvidenceService(db);
  const tokens = new TokenStore(db);
  const server = new ControlPlaneServer({ db, workspaceId: wsId, workService, evidenceService, port, requireAuth });
  await server.listen();
  try {
    await fn({ base: `http://localhost:${port}`, server, tokens, db });
  } finally {
    await server.close();
  }
}

// ============================================================================
// Dashboard route tests
// ============================================================================

export async function testDashboardRootReturnsHtml() {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/`);
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('text/html')) throw new Error(`Expected HTML content-type, got ${ct}`);
    const body = await res.text();
    if (!body.includes('<title>Stratum</title>')) throw new Error('Missing <title>Stratum</title> in dashboard');
  });
}

export async function testDashboardPathReturnsHtml() {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/dashboard`);
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('text/html')) throw new Error(`Expected HTML content-type, got ${ct}`);
    const body = await res.text();
    if (!body.includes('STRATUM')) throw new Error('Missing STRATUM header in dashboard');
  });
}

export async function testDashboardDoesNotRequireAuth() {
  await withServer(async ({ base }) => {
    // Dashboard is always accessible without auth (it handles its own token prompt)
    const res = await fetch(`${base}/`);
    if (res.status !== 200) throw new Error(`Dashboard should be reachable without token, got ${res.status}`);
  }, true);
}

export async function testDashboardContainsExpectedTabs() {
  await withServer(async ({ base }) => {
    const body = await (await fetch(`${base}/`)).text();
    const tabs = ['Needs You', 'Work', 'Projects', 'Activity'];
    for (const tab of tabs) {
      if (!body.includes(tab)) throw new Error(`Missing tab: ${tab}`);
    }
  });
}

export async function testDashboardContainsApiCalls() {
  await withServer(async ({ base }) => {
    const body = await (await fetch(`${base}/`)).text();
    // The JS should reference the control-plane API paths
    if (!body.includes('/attention')) throw new Error('Dashboard JS should reference /attention');
    if (!body.includes('/projects')) throw new Error('Dashboard JS should reference /projects');
    if (!body.includes('/events')) throw new Error('Dashboard JS should reference /events');
  });
}

export async function testDashboardDoesNotInterceptApiRoutes() {
  await withServer(async ({ base }) => {
    // API routes must still work
    const res = await fetch(`${base}/attention`);
    if (res.status !== 200) throw new Error(`/attention should still return 200, got ${res.status}`);
    const data = await res.json() as { ok: boolean };
    if (!data.ok) throw new Error('/attention response should have ok:true');
  });
}

export async function testDashboardDoesNotInterceptApiRoutesWithAuth() {
  await withServer(async ({ base, tokens }) => {
    const { token } = tokens.create('test');
    const res = await fetch(`${base}/attention`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status !== 200) throw new Error(`Expected 200 from /attention with token, got ${res.status}`);
  }, true);
}

export async function testDashboardHtmlContainsTokenInput() {
  await withServer(async ({ base }) => {
    const body = await (await fetch(`${base}/`)).text();
    if (!body.includes('strat_')) throw new Error('Auth prompt should mention token prefix');
    if (!body.includes('token-input')) throw new Error('Auth form should have token-input element');
  });
}

export async function testDashboardMethodNotAllowed() {
  await withServer(async ({ base }) => {
    // POST to / should go through the JSON router and return 404 (no route), not the HTML dashboard
    const res = await fetch(`${base}/`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    // POST / has no route — router returns 404
    if (res.status !== 404) throw new Error(`POST / should return 404, got ${res.status}`);
  });
}
