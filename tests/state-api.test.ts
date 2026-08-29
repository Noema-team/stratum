import { test } from 'node:test';
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

test('testHealthReturns200', async () => {
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
});

test('testInfoReturnsDaemonInfo', async () => {
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
});

test('testGetStateReturnsIdle', async () => {
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
});

test('testGetStateReturnsDiscovering', async () => {
  const api = createAPI(makeDiscoveringMap());
  const result = await api.getSystemState();
  assert.strictEqual(result.ok, true);
  const data = result.data as FullState;
  assert.strictEqual(data.state, 'discovering');
  assert.strictEqual(data.discovery_status, 'in_progress');
});

test('testGetStateReturnsCycling', async () => {
  const api = createAPI(makeCyclingMap());
  const result = await api.getSystemState();
  assert.strictEqual(result.ok, true);
  const data = result.data as FullState;
  assert.strictEqual(data.state, 'cycling');
  assert.strictEqual(data.iteration, 1);
});

test('testTransitionIdleToDiscovering', async () => {
  const api = createAPI(makeBaseMap());
  const result = await api.transition({ target: 'discovering', trigger: 'sle discover' });
  assert.strictEqual(result.ok, true);
  const data = result.data as TransitionResponseData;
  assert.strictEqual(data.previous, 'idle');
  assert.strictEqual(data.current, 'discovering');
});

test('testTransitionDiscoveringToIdle', async () => {
  const api = createAPI(makeDiscoveringMap());
  const result = await api.transition({ target: 'idle', trigger: 'discovery_complete' });
  assert.strictEqual(result.ok, true);
  const data = result.data as TransitionResponseData;
  assert.strictEqual(data.previous, 'discovering');
  assert.strictEqual(data.current, 'idle');
});

test('testTransitionIdleToCycling', async () => {
  const api = createAPI(makeDiscoveryCompleteMap());
  const result = await api.transition({ target: 'cycling', trigger: 'sle start' });
  assert.strictEqual(result.ok, true);
  const data = result.data as TransitionResponseData;
  assert.strictEqual(data.previous, 'idle');
  assert.strictEqual(data.current, 'cycling');
});

test('testTransitionCyclingToHalted', async () => {
  const api = createAPI(makeCyclingMap());
  const result = await api.transition({ target: 'halted', trigger: 'sle halt' });
  assert.strictEqual(result.ok, true);
  const data = result.data as TransitionResponseData;
  assert.strictEqual(data.previous, 'cycling');
  assert.strictEqual(data.current, 'halted');
});

test('testTransitionHaltedToIdle', async () => {
  const api = createAPI(makeHaltedMap());
  const result = await api.transition({ target: 'idle', trigger: 'acknowledge' });
  assert.strictEqual(result.ok, true);
  const data = result.data as TransitionResponseData;
  assert.strictEqual(data.previous, 'halted');
  assert.strictEqual(data.current, 'idle');
});

test('testTransitionHaltedToCycling', async () => {
  const api = createAPI(makeHaltedMap());
  const result = await api.transition({ target: 'cycling', trigger: 'sle resume' });
  assert.strictEqual(result.ok, true);
  const data = result.data as TransitionResponseData;
  assert.strictEqual(data.previous, 'halted');
  assert.strictEqual(data.current, 'cycling');
});

test('testTransitionCompleteToIdle', async () => {
  const api = createAPI(makeCompleteMap());
  const result = await api.transition({ target: 'idle', trigger: 'acknowledge' });
  assert.strictEqual(result.ok, true);
  const data = result.data as TransitionResponseData;
  assert.strictEqual(data.previous, 'complete');
  assert.strictEqual(data.current, 'idle');
});

test('testInvalidTransitionReturns409', async () => {
  const api = createAPI(makeBaseMap());
  const result = await api.transition({ target: 'halted', trigger: 'invalid' });
  assert.strictEqual(result.ok, false);
  const err = result as { ok: false; error: { code: string; details: { from: string; to: string; allowed: string[] } } };
  assert.strictEqual(err.error.code, 'invalid_transition');
  assert.strictEqual(err.error.details.from, 'idle');
  assert.strictEqual(err.error.details.to, 'halted');
  assert.ok(err.error.details.allowed.includes('discovering'));
  assert.ok(err.error.details.allowed.includes('cycling'));
});

test('testInvalidTransitionFromIdleToComplete', async () => {
  const api = createAPI(makeBaseMap());
  const result = await api.transition({ target: 'complete', trigger: 'invalid' });
  assert.strictEqual(result.ok, false);
  const err = result as { ok: false; error: { code: string } };
  assert.strictEqual(err.error.code, 'invalid_transition');
});

test('testInvalidTransitionFromIdleToHalted', async () => {
  const api = createAPI(makeBaseMap());
  const result = await api.transition({ target: 'halted', trigger: 'invalid' });
  assert.strictEqual(result.ok, false);
  const err = result as { ok: false; error: { code: string } };
  assert.strictEqual(err.error.code, 'invalid_transition');
});

test('testInvalidTransitionIdleToCyclingWithoutDiscovery', async () => {
  const api = createAPI(makeBaseMap());
  const result = await api.transition({ target: 'cycling', trigger: 'sle start' });
  assert.strictEqual(result.ok, false);
  const err = result as { ok: false; error: { code: string } };
  assert.ok(err.error.code === 'discovery_required' || err.error.code === 'invalid_transition');
});

test('testStateChangedEventEmitted', async () => {
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
});

test('testStateChangedEventForMultipleTransitions', async () => {
  const api = createAPI(makeBaseMap());
  const events: StateChangedEvent[] = [];
  api.onStateChanged((e) => events.push(e));

  await api.transition({ target: 'discovering', trigger: 'sle discover' });
  await api.transition({ target: 'idle', trigger: 'discovery_complete' });

  assert.strictEqual(events.length, 2);
  assert.strictEqual(events[0].current, 'discovering');
  assert.strictEqual(events[1].current, 'idle');
});

test('testUnsubscribeFromEvents', async () => {
  const api = createAPI(makeBaseMap());
  const events: StateChangedEvent[] = [];
  const unsub = api.onStateChanged((e) => events.push(e));

  await api.transition({ target: 'discovering', trigger: 'sle discover' });
  assert.strictEqual(events.length, 1);

  unsub();
  await api.transition({ target: 'idle', trigger: 'discovery_complete' });
  assert.strictEqual(events.length, 1);
});

test('testResponseMetaFields', async () => {
  const api = createAPI(makeBaseMap());
  const health = await api.health();
  assert.ok(health.meta);
  assert.ok(health.meta!.request_id);
  assert.strictEqual(health.meta!.request_id.length, 36);

  const info = await api.info();
  assert.ok(info.meta);
  assert.ok(info.meta!.request_id);
  assert.notStrictEqual(health.meta!.request_id, info.meta!.request_id);
});

test('testErrorResponseMetaFields', async () => {
  const api = createAPI(makeBaseMap());
  const result = await api.transition({ target: 'cycling', trigger: 'invalid' });
  assert.strictEqual(result.ok, false);
  const err = result as { ok: false; meta: { request_id: string; timestamp: string } };
  assert.ok(err.meta);
  assert.ok(err.meta.request_id);
  assert.ok(err.meta.timestamp);
});

test('testAllowedTargetsList', async () => {
  const api = createAPI(makeBaseMap());
  const result = await api.transition({ target: 'halted', trigger: 'invalid' });
  assert.strictEqual(result.ok, false);
  const err = result as { ok: false; error: { details: { allowed: string[] } } };
  assert.ok(err.error.details.allowed.includes('discovering'));
  assert.ok(!err.error.details.allowed.includes('halted'));
});

test('testDiscoveryRequiredErrorForT3', async () => {
  const api = createAPI(makeBaseMap());
  const result = await api.transition({ target: 'cycling', trigger: 'sle start' });
  assert.strictEqual(result.ok, false);
  const err = result as { ok: false; error: { code: string } };
  assert.strictEqual(err.error.code, 'discovery_required');
});
