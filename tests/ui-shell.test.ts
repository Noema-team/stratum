import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { request as httpRequest } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DaemonServer } from '../src/daemon.js';
import type { StateAPI } from '../src/state-api.js';
import type { InitService } from '../src/init-service.js';
import { createInitialMap } from '../src/runtime-map.js';

// ─── Minimal Mock implementations for static serving tests ─────────────────

class MockStateAPI {
  async health(): Promise<any> { return { ok: true, data: {} }; }
  async info(): Promise<any> { return { ok: true, data: {} }; }
  async getSystemState(): Promise<any> { return { ok: true, data: { state: 'idle' } }; }
  onStateChanged(): () => void { return () => {}; }
}

class MockInitService {
  async getStatus(): Promise<any> { return { ok: true, data: { initialised: true } }; }
}

class MockDiscoveryService {}
class MockCycleService {
  async getCurrent() {
    return { cycle_id: null };
  }
}
class MockScopingService {}
class MockConfirmService {}

class MockIntakeService {
  async runIntake() {
    return [
      { id: 'brief', title: 'E2E Design Brief', sections: [], status: 'promoted' }
    ];
  }
}

// ─── Test helpers ────────────────────────────────────────────────────────────

function makeRequest(
  server: DaemonServer,
  method: string,
  path: string,
  body?: unknown
): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const port = server.getPort();
    const req = httpRequest(
      { hostname: '127.0.0.1', port, method, path, headers: body ? { 'Content-Type': 'application/json' } : {} },
      (res) => {
        let data = '';
        res.on('data', (chunk: string) => { data += chunk; });
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode as number,
            headers: res.headers as Record<string, string>,
            body: data,
          });
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function startServer(): Promise<DaemonServer> {
  const sleDir = path.join(process.cwd(), '.sle');
  await fs.mkdir(sleDir, { recursive: true });
  const mapPath = path.join(sleDir, 'map.yaml');
  const { dump: dumpYaml } = await import('js-yaml');
  const initialMap = createInitialMap({
    projectName: 'test-project',
    projectType: 'api',
    codeRemote: { url: 'https://github.com/test/test.git', branch: 'main' },
    issuesRemote: { type: 'git', url: 'https://github.com/test/test/issues', branch: 'main' },
    docsRemote: { url: 'https://docs.test.com', pending: false },
    taskStore: { type: 'local' },
    agents: {
      facilitator: {
        active: true,
        node: null,
        llm: { provider: 'openai_compatible', api_key_env: 'OPENAI_API_KEY', model: 'gpt-4o' },
      },
    },
  });
  await fs.writeFile(mapPath, dumpYaml(initialMap), 'utf8');

  const server = new DaemonServer();
  const stateAPI = new MockStateAPI() as unknown as StateAPI;
  const initService = new MockInitService() as unknown as InitService;
  const discoveryService = new MockDiscoveryService() as unknown as any;
  const cycleService = new MockCycleService() as unknown as any;
  const scopingService = new MockScopingService() as unknown as any;
  const confirmService = new MockConfirmService() as unknown as any;
  const intakeService = new MockIntakeService() as unknown as any;
  const llmProvider = {
    setProvider: () => {}
  };
  
  await server.start(
    { port: 0 },
    {
      stateAPI,
      initService,
      discoveryService,
      cycleService,
      scopingService,
      confirmService,
      intakeService,
      llmProvider,
      pidFile: { writePidFile: async () => {}, removePidFile: async () => {} },
    }
  );
  return server;
}

// ─── Test definitions ────────────────────────────────────────────────────────

// These four tests require a built UI (dist/ directory). Skip when not available.
import { existsSync } from 'node:fs';
const HAS_DIST = existsSync(path.join(process.cwd(), 'dist'));

test('testIndexHtmlServing', { skip: !HAS_DIST ? 'dist/ not built' : false }, async () => {
  const server = await startServer();
  const res = await makeRequest(server, 'GET', '/');

  assert.strictEqual(res.statusCode, 200);
  assert.match(res.headers['content-type'] || '', /text\/html/);
  assert.match(res.body, /<!DOCTYPE html>/);
  assert.match(res.body, /Stratum Developer Dashboard/);

  await server.stop();
});

test('testIndexCssServing', { skip: !HAS_DIST ? 'dist/ not built' : false }, async () => {
  const server = await startServer();
  const res = await makeRequest(server, 'GET', '/index.css');

  assert.strictEqual(res.statusCode, 200);
  assert.match(res.headers['content-type'] || '', /text\/css/);
  assert.match(res.body, /--font-mono/);

  await server.stop();
});

test('testIndexJsServing', { skip: !HAS_DIST ? 'dist/ not built' : false }, async () => {
  const server = await startServer();
  const res = await makeRequest(server, 'GET', '/index.js');

  assert.strictEqual(res.statusCode, 200);
  assert.match(res.headers['content-type'] || '', /application\/javascript/);
  assert.match(res.body, /const state =/);

  await server.stop();
});

test('testSPAFallback', { skip: !HAS_DIST ? 'dist/ not built' : false }, async () => {
  const server = await startServer();
  // Call a client-side route without dot/extension
  const res = await makeRequest(server, 'GET', '/overview');

  assert.strictEqual(res.statusCode, 200);
  assert.match(res.headers['content-type'] || '', /text\/html/);
  assert.match(res.body, /<!DOCTYPE html>/);

  await server.stop();
});

test('testTraversalSecurity', async () => {
  const server = await startServer();
  
  // Test directory traversal attempt using relative pathing
  const res = await makeRequest(server, 'GET', '/../package.json');
  
  // Either 403 Forbidden or 404 Not Found since it is sanitized and mapped inside public/
  // The daemon uses .startsWith(publicRoot) check which throws 403 or sanitizes to 'package.json' in public
  assert.ok(res.statusCode === 403 || res.statusCode === 404);
  
  await server.stop();
});

test('testNonExistentFileReturns404', async () => {
  const server = await startServer();
  
  const res = await makeRequest(server, 'GET', '/non-existent-file.txt');
  assert.strictEqual(res.statusCode, 404);
  
  await server.stop();
});

test('testIntakeDocumentsServing', async () => {
  const server = await startServer();
  const res = await makeRequest(server, 'GET', '/api/v2/intake/documents');
  
  assert.strictEqual(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.strictEqual(data.ok, true);
  assert.ok(Array.isArray(data.data.documents));
  assert.strictEqual(data.data.documents[0].id, 'brief');
  
  await server.stop();
});

test('testIntakeTaskstoreServing', async () => {
  const server = await startServer();
  const res = await makeRequest(server, 'GET', '/api/v2/intake/taskstore');
  
  assert.strictEqual(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.strictEqual(data.ok, true);
  assert.ok(Array.isArray(data.data.tasks));
  
  await server.stop();
});

test('testChatMessagePosting', async () => {
  const server = await startServer();

  const openRes = await makeRequest(server, 'POST', '/api/v2/chat/session/open', {});
  if (openRes.statusCode !== 200 && openRes.statusCode !== 204) {
    console.error('[Chat Test] Open session failed:', openRes.statusCode, openRes.body);
  }
  assert.ok(openRes.statusCode === 200 || openRes.statusCode === 204, `Expected 200 or 204, got ${openRes.statusCode}`);

  if (openRes.statusCode === 200) {
    const openData = JSON.parse(openRes.body);
    assert.strictEqual(openData.ok, true);
    assert.strictEqual(openData.data.session_open, true);
  }

  const res = await makeRequest(server, 'POST', '/api/v2/chat/message', { content: 'hello test' });
  
  assert.strictEqual(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.strictEqual(data.ok, true);
  assert.strictEqual(data.data.role, 'user');
  
  await server.stop();
});

test('testSettingsEndpoints', async () => {
  const server = await startServer();

  // 1. Assert GET /api/v2/settings returns default settings with masked key
  const getRes = await makeRequest(server, 'GET', '/api/v2/settings');
  assert.strictEqual(getRes.statusCode, 200);
  const getData = JSON.parse(getRes.body);
  assert.strictEqual(getData.ok, true);
  assert.strictEqual(getData.data.provider, 'openai_compatible');
  assert.ok('api_key' in getData.data);

  // 2. Assert POST /api/v2/settings successfully validates and saves configuration
  const postRes = await makeRequest(server, 'POST', '/api/v2/settings', {
    provider: 'openrouter',
    base_url: 'https://openrouter.ai/api/v1',
    model: 'google/gemini-2.5-pro',
    api_key: 'my-secret-key-123'
  });
  assert.strictEqual(postRes.statusCode, 200);
  const postData = JSON.parse(postRes.body);
  assert.strictEqual(postData.ok, true);
  assert.strictEqual(postData.data.provider, 'openrouter');
  assert.strictEqual(postData.data.model, 'google/gemini-2.5-pro');
  assert.strictEqual(postData.data.api_key, '••••••••');

  // 3. Assert GET /api/v2/settings now returns the updated and masked settings
  const getRes2 = await makeRequest(server, 'GET', '/api/v2/settings');
  assert.strictEqual(getRes2.statusCode, 200);
  const getData2 = JSON.parse(getRes2.body);
  assert.strictEqual(getData2.data.provider, 'openrouter');
  assert.strictEqual(getData2.data.model, 'google/gemini-2.5-pro');
  assert.strictEqual(getData2.data.api_key, '••••••••');

  await server.stop();

  // Clean up settings.json so we leave the repository in pristine state
  try {
    const fsPromises = (await import('node:fs/promises'));
    const path = (await import('node:path')).default;
    const settingsFile = path.join(process.cwd(), '.sle', 'settings.json');
    await fsPromises.unlink(settingsFile).catch(() => {});
  } catch {}
});

