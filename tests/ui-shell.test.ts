import { strict as assert } from 'node:assert';
import { request as httpRequest } from 'node:http';
import { DaemonServer } from '../src/daemon.js';
import type { StateAPI } from '../src/state-api.js';
import type { InitService } from '../src/init-service.js';

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
  path: string
): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const port = server.getPort();
    const req = httpRequest(
      { hostname: '127.0.0.1', port, method, path },
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
    req.end();
  });
}

async function startServer(): Promise<DaemonServer> {
  const server = new DaemonServer();
  const stateAPI = new MockStateAPI() as unknown as StateAPI;
  const initService = new MockInitService() as unknown as InitService;
  const discoveryService = new MockDiscoveryService() as unknown as any;
  const cycleService = new MockCycleService() as unknown as any;
  const scopingService = new MockScopingService() as unknown as any;
  const confirmService = new MockConfirmService() as unknown as any;
  const intakeService = new MockIntakeService() as unknown as any;
  
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
      pidFile: { writePidFile: async () => {}, removePidFile: async () => {} },
    }
  );
  return server;
}

// ─── Test definitions ────────────────────────────────────────────────────────

async function testIndexHtmlServing() {
  const server = await startServer();
  const res = await makeRequest(server, 'GET', '/');
  
  assert.strictEqual(res.statusCode, 200);
  assert.match(res.headers['content-type'] || '', /text\/html/);
  assert.match(res.body, /<!DOCTYPE html>/);
  assert.match(res.body, /Stratum Developer Dashboard/);
  
  await server.stop();
}

async function testIndexCssServing() {
  const server = await startServer();
  const res = await makeRequest(server, 'GET', '/index.css');
  
  assert.strictEqual(res.statusCode, 200);
  assert.match(res.headers['content-type'] || '', /text\/css/);
  assert.match(res.body, /--font-mono/);
  
  await server.stop();
}

async function testIndexJsServing() {
  const server = await startServer();
  const res = await makeRequest(server, 'GET', '/index.js');
  
  assert.strictEqual(res.statusCode, 200);
  assert.match(res.headers['content-type'] || '', /application\/javascript/);
  assert.match(res.body, /const state =/);
  
  await server.stop();
}

async function testSPAFallback() {
  const server = await startServer();
  // Call a client-side route without dot/extension
  const res = await makeRequest(server, 'GET', '/overview');
  
  assert.strictEqual(res.statusCode, 200);
  assert.match(res.headers['content-type'] || '', /text\/html/);
  assert.match(res.body, /<!DOCTYPE html>/);
  
  await server.stop();
}

async function testTraversalSecurity() {
  const server = await startServer();
  
  // Test directory traversal attempt using relative pathing
  const res = await makeRequest(server, 'GET', '/../package.json');
  
  // Either 403 Forbidden or 404 Not Found since it is sanitized and mapped inside public/
  // The daemon uses .startsWith(publicRoot) check which throws 403 or sanitizes to 'package.json' in public
  assert.ok(res.statusCode === 403 || res.statusCode === 404);
  
  await server.stop();
}

async function testNonExistentFileReturns404() {
  const server = await startServer();
  
  const res = await makeRequest(server, 'GET', '/non-existent-file.txt');
  assert.strictEqual(res.statusCode, 404);
  
  await server.stop();
}

async function testIntakeDocumentsServing() {
  const server = await startServer();
  const res = await makeRequest(server, 'GET', '/api/v2/intake/documents');
  
  assert.strictEqual(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.strictEqual(data.ok, true);
  assert.ok(Array.isArray(data.data.documents));
  assert.strictEqual(data.data.documents[0].id, 'brief');
  
  await server.stop();
}

async function testIntakeTaskstoreServing() {
  const server = await startServer();
  const res = await makeRequest(server, 'GET', '/api/v2/intake/taskstore');
  
  assert.strictEqual(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.strictEqual(data.ok, true);
  assert.ok(Array.isArray(data.data.tasks));
  
  await server.stop();
}

// ─── Test Runner ────────────────────────────────────────────────────────────

async function runAllTests() {
  const tests = [
    { name: 'GET / returns 200 and serves index.html', fn: testIndexHtmlServing },
    { name: 'GET /index.css returns 200 and serves index.css', fn: testIndexCssServing },
    { name: 'GET /index.js returns 200 and serves index.js', fn: testIndexJsServing },
    { name: 'GET /overview (SPA Route) falls back to index.html', fn: testSPAFallback },
    { name: 'GET /../package.json (Traversal) returns 403/404', fn: testTraversalSecurity },
    { name: 'GET /non-existent-file.txt returns 404', fn: testNonExistentFileReturns404 },
    { name: 'GET /api/v2/intake/documents returns 200 with documents list', fn: testIntakeDocumentsServing },
    { name: 'GET /api/v2/intake/taskstore returns 200 with tasks list', fn: testIntakeTaskstoreServing },
  ];

  const failures: Array<{ name: string; error: unknown }> = [];

  console.log('Running UI Shell & Static Serving integration tests...');
  for (const test of tests) {
    try {
      await test.fn();
      console.log(`  ✓ ${test.name}`);
    } catch (error) {
      console.error(`  ✗ ${test.name}`);
      failures.push({ name: test.name, error });
    }
  }

  if (failures.length > 0) {
    console.error(`\n❌ ${failures.length}/${tests.length} UI Shell tests FAILED:`);
    for (const f of failures) {
      console.error(`  - ${f.name}: ${f.error}`);
    }
    throw failures[0].error;
  }

  console.log(`\n✅ All ${tests.length} UI Shell & Static Serving integration tests passed!`);
}

runAllTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
