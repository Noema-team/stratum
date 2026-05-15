import { strict as assert } from 'node:assert';
import { request as httpRequest } from 'node:http';
import { DaemonServer } from '../src/daemon.js';
import type { StateAPI, HealthData, FullState, TransitionResponseData, TransitionRequest } from '../src/state-api.js';
import type { APIResponse, APIError } from '../src/types.js';
import type { InitService, InitRequest } from '../src/init-service.js';

// ─── Mock implementations ────────────────────────────────────────────

class MockStateAPI {
  private _state = 'idle';
  private _discStatus = 'not_started';

  async health(): Promise<APIResponse<HealthData>> {
    return {
      ok: true, data: { status: 'healthy', uptime_ms: 100, version: '0.1.0' },
      meta: { request_id: 'r1', timestamp: new Date().toISOString() },
    };
  }

  async info(): Promise<APIResponse<{ version: string; pid: number; port: number; started_at: string; uptime_ms: number; project_root: string; sle_version: string }>> {
    return {
      ok: true, data: { version: '0.1.0', pid: 12345, port: 7700, started_at: new Date().toISOString(), uptime_ms: 100, project_root: '/tmp/test', sle_version: '2.0.0' },
      meta: { request_id: 'r2', timestamp: new Date().toISOString() },
    };
  }

  async getSystemState(): Promise<APIResponse<Record<string, unknown>>> {
    return {
      ok: true, data: { state: this._state, discovery_status: this._discStatus, active_session_id: null, active_cycle_id: null, iteration: 0, revision: 0, awaiting_scoping: false, awaiting_confirmation: false, awaiting_sharding_approval: false, chat: { session_open: false } },
      meta: { request_id: 'r3', timestamp: new Date().toISOString() },
    };
  }

  async transition(req: TransitionRequest): Promise<APIResponse<Record<string, unknown>> | APIError> {
    if (req.target === 'discovering') {
      this._state = 'discovering'; this._discStatus = 'in_progress';
      return { ok: true, data: { previous: 'idle', current: 'discovering', cycle_id: null }, meta: { request_id: 'r4', timestamp: new Date().toISOString() } };
    }
    return { ok: false, error: { code: 'invalid_transition', message: '', details: { from: this._state, to: req.target, allowed: ['discovering'] } }, meta: { request_id: 'r5', timestamp: new Date().toISOString() } };
  }

  onStateChanged(): () => void { return () => {}; }
}

class MockInitService {
  private _done = false;
  async init(request: Record<string, unknown>): Promise<APIResponse<Record<string, unknown>> | APIError> {
    if (this._done) return { ok: false, error: { code: 'already_initialised', message: '' }, meta: { request_id: 'r', timestamp: '' } };
    this._done = true;
    return { ok: true, data: { status: 'complete', step: 10, message: 'OK', files_created: ['.sle/map.yaml'] }, meta: { request_id: 'r', timestamp: '' } };
  }
  async resume(): Promise<APIResponse<Record<string, unknown>> | APIError> {
    return { ok: true, data: { status: 'complete', step: 10, message: 'OK', files_created: [] }, meta: { request_id: 'r', timestamp: '' } };
  }
  async getStatus(): Promise<APIResponse<Record<string, unknown>>> {
    return { ok: true, data: { initialised: this._done, current_step: this._done ? 10 : null, total_steps: 10, last_file_created: null }, meta: { request_id: 'r', timestamp: '' } };
  }
  async reset(): Promise<APIResponse<Record<string, unknown>> | APIError> {
    return { ok: true, data: { removed: [] }, meta: { request_id: 'r', timestamp: '' } };
  }
}

class MockCycleService {
  private _cycling = false;
  private _halted = false;

  async start(params: { intent: string; depth?: string; force?: boolean }) {
    if (this._cycling) throw Object.assign(new Error('A cycle is already active.'), { code: 'cycle_already_active' });
    this._cycling = true;
    return { cycle_id: 'c1', cycle_number: 1, planning_depth: 'standard', intent: params.intent, started_at: new Date().toISOString(), initial_node: 'SCOPING' };
  }
  async getCurrent() {
    return { cycle_id: this._cycling ? 'c1' : null, cycle_number: 1, iteration: 1, revision: 0, planning_depth: 'standard', intent: null, started_at: undefined, completed_at: undefined, outcome: 'cycling', max_iterations: 5, approval_gate: null, awaiting_scoping: false, awaiting_confirmation: false, awaiting_sharding_approval: false };
  }
  async halt() {
    if (!this._cycling) throw Object.assign(new Error('Not cycling.'), { code: 'invalid_transition' });
    this._cycling = false; this._halted = true;
  }
  async acknowledgeHalt() {
    if (!this._halted) throw Object.assign(new Error('Not halted.'), { code: 'invalid_transition' });
    this._halted = false;
  }
  async resume() {
    if (!this._halted) throw Object.assign(new Error('Not halted.'), { code: 'invalid_transition' });
    this._halted = false; this._cycling = true;
  }
}

class MockDiscoveryService {
  private _complete = false;
  async start(): Promise<APIResponse<Record<string, unknown>>> {
    return { ok: true, data: { session_id: 's1', mode: 'solo', current_round: 1, round_status: 'collecting', total_rounds: 1, started_at: new Date().toISOString() }, meta: { request_id: 'r', timestamp: '' } };
  }
  async submitResponse(): Promise<APIResponse<Record<string, unknown>>> {
    return { ok: true, data: { session_id: 's1', round: 1, status: 'drafting' }, meta: { request_id: 'r', timestamp: '' } };
  }
  async approveRound(): Promise<APIResponse<Record<string, unknown>>> {
    this._complete = true;
    return { ok: true, data: { round: 1, approved: true }, meta: { request_id: 'r', timestamp: '' } };
  }
  async getStatus(): Promise<APIResponse<Record<string, unknown>>> {
    return { ok: true, data: { session_id: 's1', status: this._complete ? 'complete' : 'in_progress', mode: 'solo', current_round: 1, total_rounds: 1, artifacts: [], open_questions_count: 0, blocking_questions_count: 0 }, meta: { request_id: 'r', timestamp: '' } };
  }
}

// ─── Test helper ─────────────────────────────────────────────────────

function makeRequest(server: DaemonServer, method: string, path: string, body?: unknown): Promise<{ statusCode: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const port = server.getPort();
    const req = httpRequest(
      { hostname: '127.0.0.1', port, method, path, headers: body ? { 'Content-Type': 'application/json' } : {} },
      (res) => {
        let data = '';
        res.on('data', (chunk: string) => { data += chunk; });
        res.on('end', () => {
          try {
            resolve({ statusCode: res.statusCode as number, body: JSON.parse(data) });
          } catch {
            resolve({ statusCode: res.statusCode as number, body: data });
          }
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function startServer(): Promise<DaemonServer> {
  const server = new DaemonServer();
  const stateAPI = new MockStateAPI() as unknown as StateAPI;
  const initService = new MockInitService() as unknown as InitService;
  const discoveryService = new MockDiscoveryService() as unknown as Record<string, unknown>;
  const cycleService = new MockCycleService() as unknown as Record<string, unknown>;
  return server.start({ port: 0 }, {
    stateAPI,
    initService,
    discoveryService: discoveryService as never,
    cycleService: cycleService as never,
    pidFile: { writePidFile: async () => {}, removePidFile: async () => {} },
  }).then(() => server);
}

// ─── Tests ───────────────────────────────────────────────────────────

async function testServerStartsAndResponds() {
  const server = await startServer();
  const res = await makeRequest(server, 'GET', '/api/v2/health');
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual((res.body as { ok: boolean }).ok, true);
  await server.stop();
}

async function testHealthEndpoint() {
  const server = await startServer();
  const res = await makeRequest(server, 'GET', '/api/v2/health');
  assert.strictEqual(res.statusCode, 200);
  const data = (res.body as { data: { status: string; uptime_ms: number } }).data;
  assert.strictEqual(data.status, 'healthy');
  assert.strictEqual(typeof data.uptime_ms, 'number');
  await server.stop();
}

async function testInfoEndpoint() {
  const server = await startServer();
  const res = await makeRequest(server, 'GET', '/api/v2/info');
  assert.strictEqual(res.statusCode, 200);
  const data = (res.body as { data: { version: string; pid: number } }).data;
  assert.strictEqual(data.version, '0.1.0');
  assert.strictEqual(typeof data.pid, 'number');
  await server.stop();
}

async function testStateEndpoint() {
  const server = await startServer();
  const res = await makeRequest(server, 'GET', '/api/v2/system/state');
  assert.strictEqual(res.statusCode, 200);
  const data = (res.body as { data: { state: string } }).data;
  assert.strictEqual(data.state, 'idle');
  await server.stop();
}

async function testTransitionRejectsInvalid() {
  const server = await startServer();
  const res = await makeRequest(server, 'POST', '/api/v2/system/state/transition', { target: 'halted', trigger: 'invalid' });
  assert.strictEqual((res.body as { ok: boolean }).ok, false);
  await server.stop();
}

async function testTransitionAppliesValid() {
  const server = await startServer();
  const res = await makeRequest(server, 'POST', '/api/v2/system/state/transition', { target: 'discovering', trigger: 'sle discover' });
  assert.strictEqual((res.body as { ok: boolean }).ok, true);
  await server.stop();
}

async function testInitCreatesStructure() {
  const server = await startServer();
  const res = await makeRequest(server, 'POST', '/api/v2/init', { project_name: 'test', project_type: 'api', task_store: 'local', daemon_port: 7700, docs_remote: null, non_interactive: true });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual((res.body as { ok: boolean }).ok, true);
  await server.stop();
}

async function testInitState() {
  const server = await startServer();
  await makeRequest(server, 'POST', '/api/v2/init', { project_name: 'test', project_type: 'api', task_store: 'local', daemon_port: 7700, docs_remote: null, non_interactive: true });
  const res = await makeRequest(server, 'GET', '/api/v2/init/state');
  assert.strictEqual((res.body as { data: { initialised: boolean } }).data.initialised, true);
  await server.stop();
}

async function testDiscoveryStart() {
  const server = await startServer();
  const res = await makeRequest(server, 'POST', '/api/v2/discovery/start', { mode: 'solo' });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual((res.body as { ok: boolean }).ok, true);
  await server.stop();
}

async function testDiscoveryRoundResponse() {
  const server = await startServer();
  const res = await makeRequest(server, 'POST', '/api/v2/discovery/round/1/response?session_id=abc');
  assert.strictEqual((res.body as { data: { round: number } }).data.round, 1);
  await server.stop();
}

async function testDiscoveryRoundApprove() {
  const server = await startServer();
  const res = await makeRequest(server, 'POST', '/api/v2/discovery/round/1/approve?session_id=abc');
  assert.strictEqual((res.body as { data: { approved: boolean } }).data.approved, true);
  await server.stop();
}

async function testJsonParseErrorReturns500() {
  const server = await startServer();
  const res = await new Promise<{ statusCode: number }>((resolve, reject) => {
    const req = httpRequest(
      { hostname: '127.0.0.1', port: server.getPort(), method: 'POST', path: '/api/v2/init', headers: { 'Content-Type': 'application/json' } },
      (res) => {
        let data = '';
        res.on('data', (chunk: string) => { data += chunk; });
        res.on('end', () => resolve({ statusCode: res.statusCode as number }));
      }
    );
    req.write('not json {{{');
    req.end();
  });
  assert.strictEqual(res.statusCode, 500);
  await server.stop();
}

async function testUnknownRouteReturns404() {
  const server = await startServer();
  const res = await makeRequest(server, 'GET', '/api/v2/nonexistent/route');
  assert.strictEqual(res.statusCode, 404);
  await server.stop();
}

async function testInitIdempotent() {
  const server = await startServer();
  const body = { project_name: 'test', project_type: 'api', task_store: 'local', daemon_port: 7700, docs_remote: null, non_interactive: true };
  await makeRequest(server, 'POST', '/api/v2/init', body);
  const res = await makeRequest(server, 'POST', '/api/v2/init', body);
  assert.strictEqual((res.body as { ok: boolean }).ok, false);
  await server.stop();
}

async function testCycleStart() {
  const server = await startServer();
  const res = await makeRequest(server, 'POST', '/api/v2/cycles/start', {
    intent: 'Add user authentication to the API',
  });
  assert.strictEqual(res.statusCode, 200);
  const body = res.body as { ok: boolean; data: { cycle_id: string; initial_node: string } };
  assert.strictEqual(body.ok, true);
  assert.ok(typeof body.data.cycle_id === 'string');
  assert.strictEqual(body.data.initial_node, 'SCOPING');
  await server.stop();
}

async function testCycleStartAlreadyActive() {
  const server = await startServer();
  await makeRequest(server, 'POST', '/api/v2/cycles/start', { intent: 'Add user authentication to the API' });
  const res = await makeRequest(server, 'POST', '/api/v2/cycles/start', { intent: 'A second concurrent intent here' });
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual((res.body as { error: { code: string } }).error.code, 'cycle_already_active');
  await server.stop();
}

async function testCycleGetCurrent() {
  const server = await startServer();
  const res = await makeRequest(server, 'GET', '/api/v2/cycles/current');
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual((res.body as { ok: boolean }).ok, true);
  await server.stop();
}

async function testCycleHalt() {
  const server = await startServer();
  await makeRequest(server, 'POST', '/api/v2/cycles/start', { intent: 'Add user authentication to the API' });
  const res = await makeRequest(server, 'POST', '/api/v2/cycles/halt');
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual((res.body as { data: { halted: boolean } }).data.halted, true);
  await server.stop();
}

async function testCycleAcknowledgeHalt() {
  const server = await startServer();
  await makeRequest(server, 'POST', '/api/v2/cycles/start', { intent: 'Add user authentication to the API' });
  await makeRequest(server, 'POST', '/api/v2/cycles/halt');
  const res = await makeRequest(server, 'POST', '/api/v2/cycles/acknowledge-halt');
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual((res.body as { data: { acknowledged: boolean } }).data.acknowledged, true);
  await server.stop();
}

async function testCycleResume() {
  const server = await startServer();
  await makeRequest(server, 'POST', '/api/v2/cycles/start', { intent: 'Add user authentication to the API' });
  await makeRequest(server, 'POST', '/api/v2/cycles/halt');
  const res = await makeRequest(server, 'POST', '/api/v2/cycles/resume');
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual((res.body as { data: { resumed: boolean } }).data.resumed, true);
  await server.stop();
}

// ─── Runner ──────────────────────────────────────────────────────────

async function runAllTests() {
  const tests = [
    { name: 'InMemoryDaemon starts and responds to health check', fn: testServerStartsAndResponds },
    { name: 'GET /api/v2/health returns 200 with healthy status', fn: testHealthEndpoint },
    { name: 'GET /api/v2/info returns DaemonInfo shape', fn: testInfoEndpoint },
    { name: 'GET /api/v2/system/state returns StateContext', fn: testStateEndpoint },
    { name: 'POST /api/v2/system/state/transition rejects invalid transition', fn: testTransitionRejectsInvalid },
    { name: 'POST /api/v2/system/state/transition applies valid transition', fn: testTransitionAppliesValid },
    { name: 'POST /api/v2/init creates .sle/ structure', fn: testInitCreatesStructure },
    { name: 'GET /api/v2/init/state returns init progress', fn: testInitState },
    { name: 'POST /api/v2/discovery/start transitions to discovering', fn: testDiscoveryStart },
    { name: 'POST /api/v2/discovery/round/1/response returns draft', fn: testDiscoveryRoundResponse },
    { name: 'POST /api/v2/discovery/round/1/approve approves the round', fn: testDiscoveryRoundApprove },
    { name: 'JSON parse error handling returns 500', fn: testJsonParseErrorReturns500 },
    { name: 'Unknown route returns 404', fn: testUnknownRouteReturns404 },
    { name: 'Init idempotent (second call fails)', fn: testInitIdempotent },
    { name: 'POST /api/v2/cycles/start returns cycle record', fn: testCycleStart },
    { name: 'POST /api/v2/cycles/start returns 409 when already active', fn: testCycleStartAlreadyActive },
    { name: 'GET /api/v2/cycles/current returns cycle record', fn: testCycleGetCurrent },
    { name: 'POST /api/v2/cycles/halt returns halted', fn: testCycleHalt },
    { name: 'POST /api/v2/cycles/acknowledge-halt returns acknowledged', fn: testCycleAcknowledgeHalt },
    { name: 'POST /api/v2/cycles/resume returns resumed', fn: testCycleResume },
  ];

  const failures: Array<{ name: string; error: unknown }> = [];

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
    console.error(`\n❌ ${failures.length}/${tests.length} Phase E daemon tests FAILED:`);
    for (const f of failures) {
      console.error(`  - ${f.name}: ${f.error}`);
    }
    throw failures[0].error;
  }

  console.log(`\n✅ All ${tests.length} Phase E+A daemon tests passed!`);
}

runAllTests();