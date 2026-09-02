import { test } from 'node:test';
import { openDatabase } from '../src/storage/database.js';
import { TokenStore } from '../src/auth/token-store.js';
import { AuditLogger } from '../src/audit/audit-logger.js';
import { NotificationService } from '../src/notifications/notification-service.js';
import { ControlPlaneServer } from '../src/api/control-plane-server.js';
import { WorkService } from '../src/services/work-service.js';
import { EvidenceService } from '../src/services/evidence-service.js';
import type Database from 'better-sqlite3';

// ============================================================================
// Helpers
// ============================================================================

function makeDb(): Database.Database {
  return openDatabase(':memory:');
}

function seedWorkspace(db: Database.Database, workspaceId: string): void {
  db.prepare("INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)").run(
    workspaceId, 'Test Workspace', new Date().toISOString(),
  );
}

let _port = 19200;
function nextPort(): number { return _port++; }

interface TestServerCtx {
  db: Database.Database;
  workspaceId: string;
  server: ControlPlaneServer;
  base: string;
  tokens: TokenStore;
}

async function withAuthServer(
  fn: (ctx: TestServerCtx) => Promise<void>,
  requireAuth = true,
): Promise<void> {
  const db = makeDb();
  const workspaceId = 'ws-auth-test';
  seedWorkspace(db, workspaceId);
  const port = nextPort();
  const workService = new WorkService(db);
  const evidenceService = new EvidenceService(db);
  const server = new ControlPlaneServer({
    db, workspaceId, workService, evidenceService, port, requireAuth,
  });
  const tokens = new TokenStore(db);
  await server.listen();
  try {
    await fn({ db, workspaceId, server, base: `http://localhost:${port}`, tokens });
  } finally {
    await server.close();
  }
}

async function apiFetch(
  base: string,
  path: string,
  opts: { method?: string; body?: unknown; token?: string } = {},
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

// ============================================================================
// TokenStore unit tests
// ============================================================================

test('testTokenStoreCreateAndValidate', async () => {
  const db = makeDb();
  const store = new TokenStore(db);
  const { token, record } = store.create('test-token');
  if (!token.startsWith('strat_')) throw new Error('Token must start with strat_');
  if (!record.id) throw new Error('Record must have id');
  const ctx = store.validate(token);
  if (!ctx) throw new Error('Valid token must authenticate');
  if (ctx.tokenName !== 'test-token') throw new Error('Wrong token name in ctx');
});

test('testTokenStoreInvalidToken', async () => {
  const db = makeDb();
  const store = new TokenStore(db);
  const ctx = store.validate('strat_notreal');
  if (ctx !== null) throw new Error('Garbage token should not authenticate');
});

test('testTokenStoreWrongPrefix', async () => {
  const db = makeDb();
  const store = new TokenStore(db);
  store.create('tok');
  const ctx = store.validate('Bearer something');
  if (ctx !== null) throw new Error('Wrong-prefix token should not authenticate');
});

test('testTokenStoreRevoke', async () => {
  const db = makeDb();
  const store = new TokenStore(db);
  const { token, record } = store.create('revoke-me');
  const before = store.validate(token);
  if (!before) throw new Error('Token should be valid before revoke');
  const ok = store.revoke(record.id);
  if (!ok) throw new Error('revoke should return true for existing id');
  const after = store.validate(token);
  if (after !== null) throw new Error('Token should be invalid after revoke');
});

test('testTokenStoreRevokeUnknown', async () => {
  const db = makeDb();
  const store = new TokenStore(db);
  const result = store.revoke('does-not-exist');
  if (result !== false) throw new Error('revoke of unknown id should return false');
});

test('testTokenStoreList', async () => {
  const db = makeDb();
  const store = new TokenStore(db);
  store.create('a');
  store.create('b');
  const list = store.list();
  if (list.length !== 2) throw new Error(`Expected 2 tokens, got ${list.length}`);
  const names = list.map(t => t.name).sort();
  if (names[0] !== 'a' || names[1] !== 'b') throw new Error('Wrong names in list');
});

// ============================================================================
// AuditLogger unit tests
// ============================================================================

test('testAuditLoggerLog', async () => {
  const db = makeDb();
  const logger = new AuditLogger(db);
  const event = logger.log('decision.resolved', 'decision', 'dec-1', {
    details: { outcome: 'approved' },
    ipAddress: '127.0.0.1',
  });
  if (!event.id) throw new Error('Event must have id');
  if (event.action !== 'decision.resolved') throw new Error('Wrong action');
  if (event.resourceType !== 'decision') throw new Error('Wrong resourceType');
  if (event.resourceId !== 'dec-1') throw new Error('Wrong resourceId');
  if ((event.details as Record<string, unknown>)?.outcome !== 'approved') throw new Error('Wrong details');
});

test('testAuditLoggerListByResource', async () => {
  const db = makeDb();
  const logger = new AuditLogger(db);
  logger.log('work.paused', 'work', 'w-1');
  logger.log('work.resumed', 'work', 'w-1');
  logger.log('work.cancelled', 'work', 'w-2');
  const evts = logger.listByResource('work', 'w-1');
  if (evts.length !== 2) throw new Error(`Expected 2, got ${evts.length}`);
  for (const e of evts) {
    if (e.resourceId !== 'w-1') throw new Error('Wrong resource filtered');
  }
});

test('testAuditLoggerListRecent', async () => {
  const db = makeDb();
  const logger = new AuditLogger(db);
  for (let i = 0; i < 5; i++) logger.log('work.paused', 'work', `w-${i}`);
  const all = logger.listRecent(10);
  if (all.length !== 5) throw new Error(`Expected 5, got ${all.length}`);
  const limited = logger.listRecent(2);
  if (limited.length !== 2) throw new Error(`Expected 2, got ${limited.length}`);
});

// ============================================================================
// NotificationService unit tests
// ============================================================================

test('testNotificationServiceAddWebhook', async () => {
  const db = makeDb();
  const svc = new NotificationService(db);
  const record = svc.addWebhook('my-hook', { url: 'https://example.com/hook' });
  if (!record.id) throw new Error('Record must have id');
  if (record.name !== 'my-hook') throw new Error('Wrong name');
  if (record.config.url !== 'https://example.com/hook') throw new Error('Wrong url');
  if (!record.enabled) throw new Error('Must be enabled');
});

test('testNotificationServiceListChannels', async () => {
  const db = makeDb();
  const svc = new NotificationService(db);
  svc.addWebhook('a', { url: 'https://a.example.com' });
  svc.addWebhook('b', { url: 'https://b.example.com' });
  const list = svc.listChannels();
  if (list.length !== 2) throw new Error(`Expected 2, got ${list.length}`);
});

test('testNotificationServiceRemoveChannel', async () => {
  const db = makeDb();
  const svc = new NotificationService(db);
  const r = svc.addWebhook('removable', { url: 'https://example.com' });
  const removed = svc.removeChannel(r.id);
  if (!removed) throw new Error('removeChannel should return true');
  const removed2 = svc.removeChannel('nonexistent');
  if (removed2) throw new Error('removeChannel of unknown id should return false');
});

// ============================================================================
// HTTP API — auth enforcement
// ============================================================================

test('testAuthRequiredReturns401WithNoToken', async () => {
  await withAuthServer(async ({ base }) => {
    const r = await apiFetch(base, '/attention');
    if (r.status !== 401) throw new Error(`Expected 401, got ${r.status}`);
  });
});

test('testAuthRequiredReturns401WithBadToken', async () => {
  await withAuthServer(async ({ base }) => {
    const r = await apiFetch(base, '/attention', { token: 'strat_badtoken' });
    if (r.status !== 401) throw new Error(`Expected 401, got ${r.status}`);
  });
});

test('testAuthValidTokenAllows200', async () => {
  await withAuthServer(async ({ base, tokens }) => {
    const { token } = tokens.create('test');
    const r = await apiFetch(base, '/attention', { token });
    if (r.status !== 200) throw new Error(`Expected 200, got ${r.status}`);
  });
});

test('testAuthDisabledAllowsNoToken', async () => {
  await withAuthServer(async ({ base }) => {
    const r = await apiFetch(base, '/attention');
    if (r.status !== 200) throw new Error(`Expected 200 without auth, got ${r.status}`);
  }, false);
});

// ============================================================================
// HTTP API — token management endpoints
// ============================================================================

test('testCreateTokenEndpoint', async () => {
  await withAuthServer(async ({ base, tokens }) => {
    const admin = tokens.create('admin');
    const r = await apiFetch(base, '/tokens', {
      method: 'POST',
      body: { name: 'new-token' },
      token: admin.token,
    });
    if (r.status !== 200) throw new Error(`Expected 200, got ${r.status}`);
    const data = (r.body as { ok: boolean; data: { token: string; id: string } }).data;
    if (!data.token.startsWith('strat_')) throw new Error('Returned token should start with strat_');
  });
});

test('testCreateTokenRequiresName', async () => {
  await withAuthServer(async ({ base, tokens }) => {
    const admin = tokens.create('admin');
    const r = await apiFetch(base, '/tokens', {
      method: 'POST',
      body: {},
      token: admin.token,
    });
    if (r.status !== 400) throw new Error(`Expected 400, got ${r.status}`);
  });
});

test('testListTokensEndpoint', async () => {
  await withAuthServer(async ({ base, tokens }) => {
    const admin = tokens.create('admin');
    tokens.create('extra');
    const r = await apiFetch(base, '/tokens', { token: admin.token });
    if (r.status !== 200) throw new Error(`Expected 200, got ${r.status}`);
    const data = (r.body as { data: unknown[] }).data;
    if (data.length < 2) throw new Error(`Expected at least 2 tokens, got ${data.length}`);
  });
});

test('testRevokeTokenEndpoint', async () => {
  await withAuthServer(async ({ base, tokens }) => {
    const admin = tokens.create('admin');
    const { record } = tokens.create('to-revoke');
    const r = await apiFetch(base, `/tokens/${record.id}`, {
      method: 'DELETE',
      token: admin.token,
    });
    if (r.status !== 200) throw new Error(`Expected 200, got ${r.status}`);
    const revokedAgain = await apiFetch(base, `/tokens/${record.id}`, {
      method: 'DELETE',
      token: admin.token,
    });
    if (revokedAgain.status !== 404) throw new Error(`Expected 404 for already-revoked, got ${revokedAgain.status}`);
  });
});

// ============================================================================
// HTTP API — audit log endpoints
// ============================================================================

test('testAuditEndpointListRecent', async () => {
  await withAuthServer(async ({ base, tokens, db }) => {
    const admin = tokens.create('admin');
    const logger = new AuditLogger(db);
    logger.log('work.paused', 'work', 'w-1');
    const r = await apiFetch(base, '/audit', { token: admin.token });
    if (r.status !== 200) throw new Error(`Expected 200, got ${r.status}`);
    const data = (r.body as { data: unknown[] }).data;
    if (data.length < 1) throw new Error('Expected at least one audit event');
  });
});

test('testAuditEndpointByResource', async () => {
  await withAuthServer(async ({ base, tokens, db }) => {
    const admin = tokens.create('admin');
    const logger = new AuditLogger(db);
    logger.log('work.paused', 'work', 'w-42');
    logger.log('work.resumed', 'work', 'w-42');
    const r = await apiFetch(base, '/audit/work/w-42', { token: admin.token });
    if (r.status !== 200) throw new Error(`Expected 200, got ${r.status}`);
    const data = (r.body as { data: unknown[] }).data;
    if (data.length !== 2) throw new Error(`Expected 2 events, got ${data.length}`);
  });
});

// ============================================================================
// HTTP API — notification channel endpoints
// ============================================================================

test('testCreateNotificationChannel', async () => {
  await withAuthServer(async ({ base, tokens }) => {
    const admin = tokens.create('admin');
    const r = await apiFetch(base, '/notifications/channels', {
      method: 'POST',
      body: { name: 'my-hook', config: { url: 'https://example.com/hook' } },
      token: admin.token,
    });
    if (r.status !== 200) throw new Error(`Expected 200, got ${r.status}`);
    const data = (r.body as { data: { id: string; name: string } }).data;
    if (!data.id) throw new Error('Missing channel id');
    if (data.name !== 'my-hook') throw new Error('Wrong channel name');
  });
});

test('testCreateNotificationChannelRequiresUrl', async () => {
  await withAuthServer(async ({ base, tokens }) => {
    const admin = tokens.create('admin');
    const r = await apiFetch(base, '/notifications/channels', {
      method: 'POST',
      body: { name: 'hook', config: {} },
      token: admin.token,
    });
    if (r.status !== 400) throw new Error(`Expected 400, got ${r.status}`);
  });
});

test('testListNotificationChannels', async () => {
  await withAuthServer(async ({ base, tokens }) => {
    const admin = tokens.create('admin');
    await apiFetch(base, '/notifications/channels', {
      method: 'POST',
      body: { name: 'hook-a', config: { url: 'https://a.example.com' } },
      token: admin.token,
    });
    const r = await apiFetch(base, '/notifications/channels', { token: admin.token });
    if (r.status !== 200) throw new Error(`Expected 200, got ${r.status}`);
    const data = (r.body as { data: unknown[] }).data;
    if (data.length < 1) throw new Error('Expected at least 1 channel');
  });
});

test('testDeleteNotificationChannel', async () => {
  await withAuthServer(async ({ base, tokens }) => {
    const admin = tokens.create('admin');
    const create = await apiFetch(base, '/notifications/channels', {
      method: 'POST',
      body: { name: 'deletable', config: { url: 'https://example.com' } },
      token: admin.token,
    });
    const channelId = (create.body as { data: { id: string } }).data.id;
    const del = await apiFetch(base, `/notifications/channels/${channelId}`, {
      method: 'DELETE',
      token: admin.token,
    });
    if (del.status !== 200) throw new Error(`Expected 200, got ${del.status}`);
    const del2 = await apiFetch(base, `/notifications/channels/${channelId}`, {
      method: 'DELETE',
      token: admin.token,
    });
    if (del2.status !== 404) throw new Error(`Expected 404 for already-deleted, got ${del2.status}`);
  });
});
