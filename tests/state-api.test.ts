import { strict as assert } from 'assert';
import { StateAPI } from '../src/state-api.js';
import type {
  FullState,
  TransitionResponseData,
  StateChangedEvent,
  TransitionRequest,
} from '../src/state-api.js';
import type { RuntimeMap, RuntimeMapManager } from '../src/runtime-map.js';

class InMemoryMapManager implements RuntimeMapManager {
  private map: RuntimeMap;

  constructor(initial: RuntimeMap) {
    this.map = JSON.parse(JSON.stringify(initial));
  }

  async read(): Promise<RuntimeMap> {
    return JSON.parse(JSON.stringify(this.map));
  }

  async write(map: RuntimeMap): Promise<void> {
    this.map = JSON.parse(JSON.stringify(map));
  }

  async update(fn: (map: RuntimeMap) => RuntimeMap): Promise<void> {
    const current = await this.read();
    const updated = fn(current);
    this.map = JSON.parse(JSON.stringify(updated));
  }

  getVersion(): string {
    return this.map.meta.version_id;
  }

  getMap(): RuntimeMap {
    return JSON.parse(JSON.stringify(this.map));
  }
}

function makeBaseMap(): RuntimeMap {
  return JSON.parse(JSON.stringify({
    meta: {
      status: 'idle',
      cycle: 0,
      version_id: '123e4567-e89b-12d3-a456-426614174000',
      initialized_at: '2026-05-08T12:00:00Z',
      updated_at: '2026-05-08T12:00:00Z',
    },
    project: {
      name: 'test-project',
      description: 'A test project',
      type: 'api',
    },
    remotes: {
      code: { type: 'git', url: 'https://github.com/org/repo.git', branch: 'main' },
      issues: { type: 'git', url: 'https://github.com/org/issues', branch: 'main' },
      docs: { url: 'https://github.com/org/docs.git', pending: false },
    },
    task_store: { type: 'local' },
    agents: {
      designer: {
        active: true,
        node: 'design',
        llm: { provider: 'openai_compatible', api_key_env: 'OPENAI_API_KEY', model: 'gpt-4o' },
      },
    },
    discovery: {
      status: 'not_started',
      mode: 'full',
      artifacts: [],
      current_round: 0,
      total_rounds: 1,
      current_phase: 0,
      total_phases: 0,
      open_questions_count: 0,
      blocking_questions_count: 0,
    },
    cycle: {
      number: 0,
      iteration: 0,
      revision: 0,
      max_iterations: 5,
      planning_depth: 'standard',
      started_at: '2026-05-08T12:00:00Z',
      outcome: 'cycling',
      approval_gate: null,
      awaiting_scoping: false,
      awaiting_confirmation: false,
      awaiting_sharding_approval: false,
    },
    chat: { session_open: false },
    artifacts: [],
    validation: {
      categories: [],
      gate: { mode: 'all_must_pass', last_outcome: 'halted', failed_categories: [] },
    },
  }));
}

function makeDiscoveryCompleteMap(): RuntimeMap {
  const map = makeBaseMap();
  map.discovery.status = 'complete';
  map.discovery.completed_at = '2026-05-08T13:00:00Z';
  return map;
}

function makeDiscoveringMap(): RuntimeMap {
  const map = makeBaseMap();
  map.meta.status = 'discovering';
  map.discovery.status = 'in_progress';
  map.discovery.current_round = 4;
  map.discovery.total_rounds = 4;
  return map;
}

function makeCyclingMap(): RuntimeMap {
  const map = makeDiscoveryCompleteMap();
  map.meta.status = 'cycling';
  map.cycle.number = 1;
  map.cycle.iteration = 1;
  map.cycle.started_at = '2026-05-08T14:00:00Z';
  map.validation.gate.last_outcome = 'halted';
  return map;
}

function makeHaltedMap(): RuntimeMap {
  const map = makeCyclingMap();
  map.meta.status = 'halted';
  map.cycle.outcome = 'halted';
  map.cycle.completed_at = '2026-05-08T15:00:00Z';
  return map;
}

function makeCompleteMap(): RuntimeMap {
  const map = makeCyclingMap();
  map.meta.status = 'complete';
  map.cycle.outcome = 'completed';
  map.cycle.completed_at = '2026-05-08T15:00:00Z';
  map.validation.gate.last_outcome = 'passed';
  return map;
}

function createAPI(map: RuntimeMap): StateAPI {
  const manager = new InMemoryMapManager(map);
  return new StateAPI(manager, {
    version: '0.1.0',
    sleVersion: '2.0.0',
    port: 7700,
    projectRoot: '/tmp/test-project',
    startedAt: new Date('2026-05-08T12:00:00Z'),
  });
}

async function testHealthReturns200() {
  const api = createAPI(makeBaseMap());
  const result = await api.health();
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.status, 'healthy');
  assert.strictEqual(result.data.version, '0.1.0');
  assert.strictEqual(typeof result.data.uptime_ms, 'number');
  assert.ok(result.data.uptime_ms >= 0);
  assert.ok(result.meta);
  assert.ok(result.meta!.request_id);
  assert.ok(result.meta!.timestamp);
}

async function testInfoReturnsDaemonInfo() {
  const api = createAPI(makeBaseMap());
  const result = await api.info();
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.version, '0.1.0');
  assert.strictEqual(result.data.sle_version, '2.0.0');
  assert.strictEqual(result.data.port, 7700);
  assert.strictEqual(result.data.project_root, '/tmp/test-project');
  assert.strictEqual(result.data.started_at, '2026-05-08T12:00:00.000Z');
  assert.strictEqual(typeof result.data.pid, 'number');
  assert.ok(result.data.pid > 0);
  assert.strictEqual(typeof result.data.uptime_ms, 'number');
}

async function testGetStateReturnsIdle() {
  const api = createAPI(makeBaseMap());
  const result = await api.getSystemState();
  assert.strictEqual(result.ok, true);
  const data = result.data as FullState;
  assert.strictEqual(data.state, 'idle');
  assert.strictEqual(data.discovery_status, 'not_started');
  assert.strictEqual(data.active_session_id, null);
  assert.strictEqual(data.active_cycle_id, null);
  assert.strictEqual(data.iteration, 0);
  assert.strictEqual(data.revision, 0);
  assert.strictEqual(data.awaiting_scoping, false);
  assert.strictEqual(data.awaiting_confirmation, false);
  assert.strictEqual(data.awaiting_sharding_approval, false);
  assert.strictEqual(data.chat.session_open, false);
}

async function testGetStateReturnsDiscovering() {
  const api = createAPI(makeDiscoveringMap());
  const result = await api.getSystemState();
  assert.strictEqual(result.ok, true);
  const data = result.data as FullState;
  assert.strictEqual(data.state, 'discovering');
  assert.strictEqual(data.discovery_status, 'in_progress');
}

async function testGetStateReturnsCycling() {
  const api = createAPI(makeCyclingMap());
  const result = await api.getSystemState();
  assert.strictEqual(result.ok, true);
  const data = result.data as FullState;
  assert.strictEqual(data.state, 'cycling');
  assert.strictEqual(data.iteration, 1);
}

async function testTransitionIdleToDiscovering() {
  const api = createAPI(makeBaseMap());
  const result = await api.transition({ target: 'discovering', trigger: 'sle discover' });
  assert.strictEqual(result.ok, true);
  const data = result.data as TransitionResponseData;
  assert.strictEqual(data.previous, 'idle');
  assert.strictEqual(data.current, 'discovering');
}

async function testTransitionDiscoveringToIdle() {
  const api = createAPI(makeDiscoveringMap());
  const result = await api.transition({ target: 'idle', trigger: 'discovery_complete' });
  assert.strictEqual(result.ok, true);
  const data = result.data as TransitionResponseData;
  assert.strictEqual(data.previous, 'discovering');
  assert.strictEqual(data.current, 'idle');
}

async function testTransitionIdleToCycling() {
  const api = createAPI(makeDiscoveryCompleteMap());
  const result = await api.transition({ target: 'cycling', trigger: 'sle start' });
  assert.strictEqual(result.ok, true);
  const data = result.data as TransitionResponseData;
  assert.strictEqual(data.previous, 'idle');
  assert.strictEqual(data.current, 'cycling');
}

async function testTransitionCyclingToHalted() {
  const api = createAPI(makeCyclingMap());
  const result = await api.transition({ target: 'halted', trigger: 'sle halt' });
  assert.strictEqual(result.ok, true);
  const data = result.data as TransitionResponseData;
  assert.strictEqual(data.previous, 'cycling');
  assert.strictEqual(data.current, 'halted');
}

async function testTransitionHaltedToIdle() {
  const api = createAPI(makeHaltedMap());
  const result = await api.transition({ target: 'idle', trigger: 'acknowledge' });
  assert.strictEqual(result.ok, true);
  const data = result.data as TransitionResponseData;
  assert.strictEqual(data.previous, 'halted');
  assert.strictEqual(data.current, 'idle');
}

async function testTransitionHaltedToCycling() {
  const api = createAPI(makeHaltedMap());
  const result = await api.transition({ target: 'cycling', trigger: 'sle resume' });
  assert.strictEqual(result.ok, true);
  const data = result.data as TransitionResponseData;
  assert.strictEqual(data.previous, 'halted');
  assert.strictEqual(data.current, 'cycling');
}

async function testTransitionCompleteToIdle() {
  const api = createAPI(makeCompleteMap());
  const result = await api.transition({ target: 'idle', trigger: 'acknowledge' });
  assert.strictEqual(result.ok, true);
  const data = result.data as TransitionResponseData;
  assert.strictEqual(data.previous, 'complete');
  assert.strictEqual(data.current, 'idle');
}

async function testInvalidTransitionReturns409() {
  const api = createAPI(makeBaseMap());
  const result = await api.transition({ target: 'halted', trigger: 'invalid' });
  assert.strictEqual(result.ok, false);
  const err = result as { ok: false; error: { code: string; details: { from: string; to: string; allowed: string[] } } };
  assert.strictEqual(err.error.code, 'invalid_transition');
  assert.strictEqual(err.error.details.from, 'idle');
  assert.strictEqual(err.error.details.to, 'halted');
  assert.ok(err.error.details.allowed.includes('discovering'));
  assert.ok(err.error.details.allowed.includes('cycling'));
}

async function testInvalidTransitionFromIdleToComplete() {
  const api = createAPI(makeBaseMap());
  const result = await api.transition({ target: 'complete', trigger: 'invalid' });
  assert.strictEqual(result.ok, false);
  const err = result as { ok: false; error: { code: string } };
  assert.strictEqual(err.error.code, 'invalid_transition');
}

async function testInvalidTransitionFromIdleToHalted() {
  const api = createAPI(makeBaseMap());
  const result = await api.transition({ target: 'halted', trigger: 'invalid' });
  assert.strictEqual(result.ok, false);
  const err = result as { ok: false; error: { code: string } };
  assert.strictEqual(err.error.code, 'invalid_transition');
}

async function testInvalidTransitionIdleToCyclingWithoutDiscovery() {
  const api = createAPI(makeBaseMap());
  const result = await api.transition({ target: 'cycling', trigger: 'sle start' });
  assert.strictEqual(result.ok, false);
  const err = result as { ok: false; error: { code: string } };
  assert.ok(err.error.code === 'discovery_required' || err.error.code === 'invalid_transition');
}

async function testStateChangedEventEmitted() {
  const api = createAPI(makeBaseMap());
  const events: StateChangedEvent[] = [];
  api.onStateChanged((e) => events.push(e));

  await api.transition({ target: 'discovering', trigger: 'sle discover' });

  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].previous, 'idle');
  assert.strictEqual(events[0].current, 'discovering');
  assert.strictEqual(events[0].trigger, 'sle discover');
  assert.ok(events[0].timestamp);
  const parsed = new Date(events[0].timestamp);
  assert.ok(!isNaN(parsed.getTime()));
}

async function testStateChangedEventForMultipleTransitions() {
  const api = createAPI(makeBaseMap());
  const events: StateChangedEvent[] = [];
  api.onStateChanged((e) => events.push(e));

  await api.transition({ target: 'discovering', trigger: 'sle discover' });
  await api.transition({ target: 'idle', trigger: 'discovery_complete' });

  assert.strictEqual(events.length, 2);
  assert.strictEqual(events[0].current, 'discovering');
  assert.strictEqual(events[1].current, 'idle');
}

async function testUnsubscribeFromEvents() {
  const api = createAPI(makeBaseMap());
  const events: StateChangedEvent[] = [];
  const unsub = api.onStateChanged((e) => events.push(e));

  await api.transition({ target: 'discovering', trigger: 'sle discover' });
  assert.strictEqual(events.length, 1);

  unsub();
  await api.transition({ target: 'idle', trigger: 'discovery_complete' });
  assert.strictEqual(events.length, 1);
}

async function testResponseMetaFields() {
  const api = createAPI(makeBaseMap());
  const health = await api.health();
  assert.ok(health.meta);
  assert.ok(health.meta!.request_id);
  assert.strictEqual(health.meta!.request_id.length, 36);

  const info = await api.info();
  assert.ok(info.meta);
  assert.ok(info.meta!.request_id);
  assert.notStrictEqual(health.meta!.request_id, info.meta!.request_id);
}

async function testErrorResponseMetaFields() {
  const api = createAPI(makeBaseMap());
  const result = await api.transition({ target: 'cycling', trigger: 'invalid' });
  assert.strictEqual(result.ok, false);
  const err = result as { ok: false; meta: { request_id: string; timestamp: string } };
  assert.ok(err.meta);
  assert.ok(err.meta.request_id);
  assert.ok(err.meta.timestamp);
}

async function testAllowedTargetsList() {
  const api = createAPI(makeBaseMap());
  const result = await api.transition({ target: 'halted', trigger: 'invalid' });
  assert.strictEqual(result.ok, false);
  const err = result as { ok: false; error: { details: { allowed: string[] } } };
  assert.ok(err.error.details.allowed.includes('discovering'));
  assert.ok(!err.error.details.allowed.includes('halted'));
}

async function testDiscoveryRequiredErrorForT3() {
  const api = createAPI(makeBaseMap());
  const result = await api.transition({ target: 'cycling', trigger: 'sle start' });
  assert.strictEqual(result.ok, false);
  const err = result as { ok: false; error: { code: string } };
  assert.strictEqual(err.error.code, 'discovery_required');
}

async function runAllTests() {
  const tests = [
    { name: 'health returns 200 with correct shape', fn: testHealthReturns200 },
    { name: 'info returns DaemonInfo fields', fn: testInfoReturnsDaemonInfo },
    { name: 'getSystemState returns idle state', fn: testGetStateReturnsIdle },
    { name: 'getSystemState returns discovering state', fn: testGetStateReturnsDiscovering },
    { name: 'getSystemState returns cycling state', fn: testGetStateReturnsCycling },
    { name: 'transition T1 idle->discovering succeeds', fn: testTransitionIdleToDiscovering },
    { name: 'transition T2 discovering->idle succeeds', fn: testTransitionDiscoveringToIdle },
    { name: 'transition T3 idle->cycling succeeds', fn: testTransitionIdleToCycling },
    { name: 'transition T5 cycling->halted succeeds', fn: testTransitionCyclingToHalted },
    { name: 'transition T10 halted->idle succeeds', fn: testTransitionHaltedToIdle },
    { name: 'transition T12 halted->cycling succeeds', fn: testTransitionHaltedToCycling },
    { name: 'transition T9 complete->idle succeeds', fn: testTransitionCompleteToIdle },
    { name: 'invalid transition returns 409 with allowed list', fn: testInvalidTransitionReturns409 },
    { name: 'idle->complete returns invalid_transition', fn: testInvalidTransitionFromIdleToComplete },
    { name: 'idle->halted returns invalid_transition', fn: testInvalidTransitionFromIdleToHalted },
    { name: 'idle->cycling without discovery returns error', fn: testInvalidTransitionIdleToCyclingWithoutDiscovery },
    { name: 'state_changed event emitted on transition', fn: testStateChangedEventEmitted },
    { name: 'state_changed events for multiple transitions', fn: testStateChangedEventForMultipleTransitions },
    { name: 'unsubscribe from state_changed events', fn: testUnsubscribeFromEvents },
    { name: 'response meta fields present', fn: testResponseMetaFields },
    { name: 'error response meta fields present', fn: testErrorResponseMetaFields },
    { name: 'allowed targets list in error details', fn: testAllowedTargetsList },
    { name: 'discovery_required error for T3 precondition', fn: testDiscoveryRequiredErrorForT3 },
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
    console.error(`\n❌ ${failures.length}/${tests.length} Phase F tests FAILED:`);
    for (const f of failures) {
      console.error(`  - ${f.name}`);
    }
    throw failures[0].error;
  }

  console.log(`\n✅ All ${tests.length} Phase F tests passed!`);
}

runAllTests();
