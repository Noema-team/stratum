import { test } from 'node:test';
import { strict as assert } from 'assert';
import {
  validateTransition,
  computeStateContext,
  StateMachine,
  TransitionRejection,
} from '../src/state-machine.js';
import type { TransitionId, StateContext, TransitionResult } from '../src/state-machine.js';
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

function makeIdleMap(): RuntimeMap {
  return makeBaseMap();
}

function makeIdleDiscoveryCompleteMap(): RuntimeMap {
  const map = makeBaseMap();
  map.discovery.status = 'complete';
  map.discovery.completed_at = '2026-05-08T13:00:00Z';
  return map;
}

function makeDiscoveringMap(): RuntimeMap {
  const map = makeBaseMap();
  map.meta.status = 'discovering';
  map.discovery.status = 'in_progress';
  map.discovery.current_round = 1;
  return map;
}

function makeCyclingMap(opts?: {
  iteration?: number;
  maxIterations?: number;
  revision?: number;
  flags?: { scoping?: boolean; confirmation?: boolean; sharding?: boolean };
  validationOutcome?: 'passed' | 'failed' | 'halted';
}): RuntimeMap {
  const map = makeBaseMap();
  map.meta.status = 'cycling';
  map.meta.cycle = 1;
  map.discovery.status = 'complete';
  map.discovery.completed_at = '2026-05-08T13:00:00Z';
  map.cycle.number = 1;
  map.cycle.iteration = opts?.iteration ?? 1;
  map.cycle.revision = opts?.revision ?? 0;
  map.cycle.max_iterations = opts?.maxIterations ?? 5;
  map.cycle.started_at = '2026-05-08T14:00:00Z';
  map.cycle.outcome = 'cycling';
  map.cycle.awaiting_scoping = opts?.flags?.scoping ?? false;
  map.cycle.awaiting_confirmation = opts?.flags?.confirmation ?? false;
  map.cycle.awaiting_sharding_approval = opts?.flags?.sharding ?? false;
  map.validation.gate.last_outcome = opts?.validationOutcome ?? 'passed';
  return map;
}

function makeHaltedMap(): RuntimeMap {
  const map = makeBaseMap();
  map.meta.status = 'halted';
  map.meta.cycle = 1;
  map.discovery.status = 'complete';
  map.discovery.completed_at = '2026-05-08T13:00:00Z';
  map.cycle.number = 1;
  map.cycle.iteration = 3;
  map.cycle.revision = 1;
  map.cycle.started_at = '2026-05-08T14:00:00Z';
  map.cycle.completed_at = '2026-05-08T15:00:00Z';
  map.cycle.outcome = 'halted';
  return map;
}

function makeCompleteMap(): RuntimeMap {
  const map = makeBaseMap();
  map.meta.status = 'complete';
  map.meta.cycle = 1;
  map.discovery.status = 'complete';
  map.discovery.completed_at = '2026-05-08T13:00:00Z';
  map.cycle.number = 1;
  map.cycle.iteration = 2;
  map.cycle.revision = 0;
  map.cycle.started_at = '2026-05-08T14:00:00Z';
  map.cycle.completed_at = '2026-05-08T15:00:00Z';
  map.cycle.outcome = 'completed';
  return map;
}

function createSM(map: RuntimeMap): { sm: StateMachine; mgr: InMemoryMapManager } {
  const mgr = new InMemoryMapManager(map);
  const sm = new StateMachine(mgr);
  return { sm, mgr };
}

test('testT1Valid', async () => {
  const map = makeIdleMap();
  const { sm, mgr } = createSM(map);

  const result = await sm.startDiscovery();

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.transition, 'T1');
  assert.strictEqual(result.from, 'idle');
  assert.strictEqual(result.to, 'discovering');

  const after = mgr.getMap();
  assert.strictEqual(after.meta.status, 'discovering');
  assert.strictEqual(after.discovery.status, 'in_progress');
  assert.strictEqual(after.discovery.current_round, 1);
});

test('testT1InvalidState', async () => {
  const map = makeCyclingMap();
  const { sm } = createSM(map);
  const result = await sm.startDiscovery();

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error!.code, 'invalid_transition');
  assert.strictEqual(result.from, 'cycling');
});

test('testT1FailsDiscoveryComplete', async () => {
  const map = makeIdleDiscoveryCompleteMap();
  const validation = validateTransition('T1', map);
  assert.strictEqual(validation.valid, false);
  assert.strictEqual(validation.errorCode, 'invalid_transition');
});

test('testT2Valid', async () => {
  const map = makeDiscoveringMap();
  const { sm, mgr } = createSM(map);

  const result = await sm.endDiscovery();

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.transition, 'T2');
  assert.strictEqual(result.from, 'discovering');
  assert.strictEqual(result.to, 'idle');

  const after = mgr.getMap();
  assert.strictEqual(after.meta.status, 'idle');
  assert.strictEqual(after.discovery.status, 'complete');
  assert.ok(typeof after.discovery.completed_at === 'string');
  assert.ok(after.discovery.completed_at!.length > 0);
});

test('testT2InvalidState', async () => {
  const map = makeIdleMap();
  const validation = validateTransition('T2', map);
  assert.strictEqual(validation.valid, false);
  assert.strictEqual(validation.errorCode, 'invalid_transition');
});

test('testT2PreconditionNotTerminalRound', async () => {
  const map = makeDiscoveringMap();
  map.discovery.total_rounds = 4;
  map.discovery.current_round = 1;
  const validation = validateTransition('T2', map);
  assert.strictEqual(validation.valid, false);
});

test('testT3Valid', async () => {
  const map = makeIdleDiscoveryCompleteMap();
  const originalCycle = map.meta.cycle;
  const { sm, mgr } = createSM(map);

  const result = await sm.startCycle();

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.transition, 'T3');
  assert.strictEqual(result.from, 'idle');
  assert.strictEqual(result.to, 'cycling');

  const after = mgr.getMap();
  assert.strictEqual(after.meta.status, 'cycling');
  assert.strictEqual(after.meta.cycle, originalCycle + 1);
  assert.strictEqual(after.cycle.number, originalCycle + 1);
  assert.strictEqual(after.cycle.iteration, 1);
  assert.strictEqual(after.cycle.revision, 0);
  assert.ok(typeof after.cycle.started_at === 'string');
  assert.ok(after.cycle.started_at!.length > 0);
  assert.strictEqual(after.cycle.completed_at, undefined);
  assert.strictEqual(after.cycle.outcome, 'cycling');
  assert.strictEqual(after.cycle.approval_gate, null);
  assert.strictEqual(after.cycle.awaiting_scoping, false);
  assert.strictEqual(after.cycle.awaiting_confirmation, false);
  assert.strictEqual(after.cycle.awaiting_sharding_approval, false);
});

test('testT3InvalidState', async () => {
  const map = makeCyclingMap();
  const validation = validateTransition('T3', map);
  assert.strictEqual(validation.valid, false);
  assert.strictEqual(validation.errorCode, 'invalid_transition');
});

test('testT3DiscoveryGuard', async () => {
  const map = makeIdleMap();
  const validation = validateTransition('T3', map);
  assert.strictEqual(validation.valid, false);
  assert.strictEqual(validation.errorCode, 'discovery_required');
});

test('testT4Valid', async () => {
  const map = makeCyclingMap({ iteration: 1 });
  const { sm, mgr } = createSM(map);

  const result = await sm.retryIteration();

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.transition, 'T4');
  assert.strictEqual(result.from, 'cycling');
  assert.strictEqual(result.to, 'cycling');

  const after = mgr.getMap();
  assert.strictEqual(after.cycle.iteration, 2);
  assert.strictEqual(after.cycle.revision, 0);
  assert.strictEqual(after.cycle.awaiting_scoping, false);
  assert.strictEqual(after.cycle.awaiting_confirmation, false);
  assert.strictEqual(after.cycle.awaiting_sharding_approval, false);
});

test('testT4InvalidState', async () => {
  const map = makeIdleMap();
  const validation = validateTransition('T4', map);
  assert.strictEqual(validation.valid, false);
  assert.strictEqual(validation.errorCode, 'invalid_transition');
});

test('testT4IterationCapReached', async () => {
  const map = makeCyclingMap({ iteration: 5, maxIterations: 5 });
  const validation = validateTransition('T4', map);
  assert.strictEqual(validation.valid, false);
});

test('testT5Valid', async () => {
  const map = makeCyclingMap({ flags: { scoping: true, confirmation: false, sharding: false } });
  const { sm, mgr } = createSM(map);

  const result = await sm.halt('user');

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.transition, 'T5');
  assert.strictEqual(result.from, 'cycling');
  assert.strictEqual(result.to, 'halted');

  const after = mgr.getMap();
  assert.strictEqual(after.meta.status, 'halted');
  assert.strictEqual(after.cycle.outcome, 'halted');
  assert.ok(typeof after.cycle.completed_at === 'string');
  assert.ok(after.cycle.completed_at!.length > 0);
  assert.strictEqual(after.cycle.awaiting_scoping, false);
  assert.strictEqual(after.cycle.awaiting_confirmation, false);
  assert.strictEqual(after.cycle.awaiting_sharding_approval, false);
});

test('testT5InvalidState', async () => {
  const map = makeIdleMap();
  const validation = validateTransition('T5', map);
  assert.strictEqual(validation.valid, false);
});

test('testT6Valid', async () => {
  const map = makeCyclingMap({ iteration: 5, maxIterations: 5 });
  const { sm, mgr } = createSM(map);

  const result = await sm.halt('cap_exceeded');

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.transition, 'T6');
  assert.strictEqual(result.from, 'cycling');
  assert.strictEqual(result.to, 'halted');

  const after = mgr.getMap();
  assert.strictEqual(after.meta.status, 'halted');
  assert.strictEqual(after.cycle.outcome, 'halted');
  assert.ok(typeof after.cycle.completed_at === 'string');
  assert.strictEqual(after.cycle.awaiting_scoping, false);
  assert.strictEqual(after.cycle.awaiting_confirmation, false);
  assert.strictEqual(after.cycle.awaiting_sharding_approval, false);
});

test('testT6InvalidState', async () => {
  const map = makeIdleMap();
  const validation = validateTransition('T6', map);
  assert.strictEqual(validation.valid, false);
});

test('testT6PreconditionBelowCap', async () => {
  const map = makeCyclingMap({ iteration: 3, maxIterations: 5 });
  const validation = validateTransition('T6', map);
  assert.strictEqual(validation.valid, false);
});

test('testT7Valid', async () => {
  const map = makeCyclingMap({ flags: { confirmation: true } });
  const { sm, mgr } = createSM(map);

  const result = await sm.halt('error');

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.transition, 'T7');
  assert.strictEqual(result.from, 'cycling');
  assert.strictEqual(result.to, 'halted');

  const after = mgr.getMap();
  assert.strictEqual(after.meta.status, 'halted');
  assert.strictEqual(after.cycle.outcome, 'halted');
  assert.ok(typeof after.cycle.completed_at === 'string');
  assert.strictEqual(after.cycle.awaiting_scoping, false);
  assert.strictEqual(after.cycle.awaiting_confirmation, false);
  assert.strictEqual(after.cycle.awaiting_sharding_approval, false);
});

test('testT7InvalidState', async () => {
  const map = makeHaltedMap();
  const validation = validateTransition('T7', map);
  assert.strictEqual(validation.valid, false);
});

test('testT5T6T7DistinctTransitionIds', async () => {
  const r5 = validateTransition('T5', makeCyclingMap());
  const r6 = validateTransition('T6', makeCyclingMap({ iteration: 5, maxIterations: 5 }));
  const r7 = validateTransition('T7', makeCyclingMap());
  assert.strictEqual(r5.valid, true);
  assert.strictEqual(r6.valid, true);
  assert.strictEqual(r7.valid, true);
});

test('testT8Valid', async () => {
  const map = makeCyclingMap({ validationOutcome: 'passed', flags: { sharding: true } });
  const { sm, mgr } = createSM(map);

  const result = await sm.completeCycle();

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.transition, 'T8');
  assert.strictEqual(result.from, 'cycling');
  assert.strictEqual(result.to, 'complete');

  const after = mgr.getMap();
  assert.strictEqual(after.meta.status, 'complete');
  assert.strictEqual(after.cycle.outcome, 'completed');
  assert.ok(typeof after.cycle.completed_at === 'string');
  assert.strictEqual(after.cycle.awaiting_scoping, false);
  assert.strictEqual(after.cycle.awaiting_confirmation, false);
  assert.strictEqual(after.cycle.awaiting_sharding_approval, false);
});

test('testT8InvalidState', async () => {
  const map = makeIdleMap();
  const validation = validateTransition('T8', map);
  assert.strictEqual(validation.valid, false);
});

test('testT8ValidationNotPassed', async () => {
  const map = makeCyclingMap({ validationOutcome: 'failed' });
  const validation = validateTransition('T8', map);
  assert.strictEqual(validation.valid, false);
});

test('testT9Valid', async () => {
  const map = makeCompleteMap();
  map.cycle.awaiting_scoping = true;
  const { sm, mgr } = createSM(map);

  const result = await sm.acknowledgeComplete();

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.transition, 'T9');
  assert.strictEqual(result.from, 'complete');
  assert.strictEqual(result.to, 'idle');

  const after = mgr.getMap();
  assert.strictEqual(after.meta.status, 'idle');
  assert.strictEqual(after.cycle.awaiting_scoping, false);
  assert.strictEqual(after.cycle.awaiting_confirmation, false);
  assert.strictEqual(after.cycle.awaiting_sharding_approval, false);
});

test('testT9InvalidState', async () => {
  const map = makeIdleMap();
  const validation = validateTransition('T9', map);
  assert.strictEqual(validation.valid, false);
});

test('testT10Valid', async () => {
  const map = makeHaltedMap();
  map.cycle.awaiting_confirmation = true;
  const { sm, mgr } = createSM(map);

  const result = await sm.acknowledgeHalt();

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.transition, 'T10');
  assert.strictEqual(result.from, 'halted');
  assert.strictEqual(result.to, 'idle');

  const after = mgr.getMap();
  assert.strictEqual(after.meta.status, 'idle');
  assert.strictEqual(after.cycle.awaiting_scoping, false);
  assert.strictEqual(after.cycle.awaiting_confirmation, false);
  assert.strictEqual(after.cycle.awaiting_sharding_approval, false);
});

test('testT10InvalidState', async () => {
  const map = makeCyclingMap();
  const validation = validateTransition('T10', map);
  assert.strictEqual(validation.valid, false);
});

test('testT11Valid', async () => {
  const map = makeIdleMap();
  assert.strictEqual(map.discovery.status, 'not_started');
  const originalCycle = map.meta.cycle;
  const { sm, mgr } = createSM(map);

  const result = await sm.startCycle(true);

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.transition, 'T11');
  assert.strictEqual(result.from, 'idle');
  assert.strictEqual(result.to, 'cycling');

  const after = mgr.getMap();
  assert.strictEqual(after.meta.status, 'cycling');
  assert.strictEqual(after.meta.cycle, originalCycle + 1);
  assert.strictEqual(after.cycle.number, originalCycle + 1);
  assert.strictEqual(after.cycle.iteration, 1);
  assert.strictEqual(after.cycle.revision, 0);
  assert.ok(typeof after.cycle.started_at === 'string');
  assert.strictEqual(after.cycle.completed_at, undefined);
  assert.strictEqual(after.cycle.outcome, 'cycling');
  assert.strictEqual(after.cycle.approval_gate, null);
  assert.strictEqual(after.cycle.awaiting_scoping, false);
  assert.strictEqual(after.cycle.awaiting_confirmation, false);
  assert.strictEqual(after.cycle.awaiting_sharding_approval, false);
});

test('testT11InvalidState', async () => {
  const map = makeDiscoveringMap();
  const validation = validateTransition('T11', map);
  assert.strictEqual(validation.valid, false);
});

test('testT11BypassesDiscoveryGuard', async () => {
  const map = makeIdleMap();
  assert.strictEqual(map.discovery.status, 'not_started');
  const t3Result = validateTransition('T3', map);
  assert.strictEqual(t3Result.valid, false);
  assert.strictEqual(t3Result.errorCode, 'discovery_required');
  const t11Result = validateTransition('T11', map);
  assert.strictEqual(t11Result.valid, true);
});

test('testT12Valid', async () => {
  const map = makeHaltedMap();
  const preservedIteration = map.cycle.iteration;
  const { sm, mgr } = createSM(map);

  const result = await sm.resume();

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.transition, 'T12');
  assert.strictEqual(result.from, 'halted');
  assert.strictEqual(result.to, 'cycling');

  const after = mgr.getMap();
  assert.strictEqual(after.meta.status, 'cycling');
  assert.strictEqual(after.cycle.outcome, 'cycling');
  assert.strictEqual(after.cycle.completed_at, undefined);
  assert.strictEqual(after.cycle.iteration, preservedIteration);
  assert.strictEqual(after.cycle.awaiting_scoping, false);
  assert.strictEqual(after.cycle.awaiting_confirmation, false);
  assert.strictEqual(after.cycle.awaiting_sharding_approval, false);
});

test('testT12InvalidState', async () => {
  const map = makeIdleMap();
  const validation = validateTransition('T12', map);
  assert.strictEqual(validation.valid, false);
});

test('testDiscoveryGuardT3BlockedT11Bypasses', async () => {
  const map = makeIdleMap();
  const t3 = validateTransition('T3', map);
  assert.strictEqual(t3.valid, false);
  assert.strictEqual(t3.errorCode, 'discovery_required');
  const t11 = validateTransition('T11', map);
  assert.strictEqual(t11.valid, true);
});

test('testIterationCapBoundary', async () => {
  const atCap = makeCyclingMap({ iteration: 5, maxIterations: 5 });
  const t4AtCap = validateTransition('T4', atCap);
  assert.strictEqual(t4AtCap.valid, false);
  const t6AtCap = validateTransition('T6', atCap);
  assert.strictEqual(t6AtCap.valid, true);

  const belowCap = makeCyclingMap({ iteration: 4, maxIterations: 5 });
  const t4Below = validateTransition('T4', belowCap);
  assert.strictEqual(t4Below.valid, true);
  const t6Below = validateTransition('T6', belowCap);
  assert.strictEqual(t6Below.valid, false);
});

test('testDefaultIterationCapZero', async () => {
  const map = makeCyclingMap({ iteration: 1, maxIterations: 0 });
  const t4 = validateTransition('T4', map);
  assert.strictEqual(t4.valid, false);
  const t6 = validateTransition('T6', map);
  assert.strictEqual(t6.valid, true);
});

test('testFlagExclusivity', async () => {
  const map = makeCyclingMap();
  const { sm, mgr } = createSM(map);

  await sm.setFlag('awaiting_scoping', true);
  let after = mgr.getMap();
  assert.strictEqual(after.cycle.awaiting_scoping, true);
  assert.strictEqual(after.cycle.awaiting_confirmation, false);
  assert.strictEqual(after.cycle.awaiting_sharding_approval, false);

  await sm.setFlag('awaiting_confirmation', true);
  after = mgr.getMap();
  assert.strictEqual(after.cycle.awaiting_scoping, false);
  assert.strictEqual(after.cycle.awaiting_confirmation, true);
  assert.strictEqual(after.cycle.awaiting_sharding_approval, false);

  await sm.setFlag('awaiting_sharding_approval', true);
  after = mgr.getMap();
  assert.strictEqual(after.cycle.awaiting_scoping, false);
  assert.strictEqual(after.cycle.awaiting_confirmation, false);
  assert.strictEqual(after.cycle.awaiting_sharding_approval, true);
});

test('testFlagClearSingle', async () => {
  const map = makeCyclingMap({ flags: { scoping: true } });
  const { sm, mgr } = createSM(map);

  await sm.setFlag('awaiting_scoping', false);
  const after = mgr.getMap();
  assert.strictEqual(after.cycle.awaiting_scoping, false);
  assert.strictEqual(after.cycle.awaiting_confirmation, false);
  assert.strictEqual(after.cycle.awaiting_sharding_approval, false);
});

test('testFlagResetOnHaltT5', async () => {
  const map = makeCyclingMap({ flags: { confirmation: true } });
  const { sm, mgr } = createSM(map);
  await sm.halt('user');
  const after = mgr.getMap();
  assert.strictEqual(after.cycle.awaiting_confirmation, false);
  assert.strictEqual(after.cycle.awaiting_scoping, false);
  assert.strictEqual(after.cycle.awaiting_sharding_approval, false);
});

test('testFlagResetOnHaltT6', async () => {
  const map = makeCyclingMap({ iteration: 5, maxIterations: 5, flags: { scoping: true } });
  const { sm, mgr } = createSM(map);
  await sm.halt('cap_exceeded');
  const after = mgr.getMap();
  assert.strictEqual(after.cycle.awaiting_scoping, false);
  assert.strictEqual(after.cycle.awaiting_confirmation, false);
  assert.strictEqual(after.cycle.awaiting_sharding_approval, false);
});

test('testFlagResetOnHaltT7', async () => {
  const map = makeCyclingMap({ flags: { sharding: true } });
  const { sm, mgr } = createSM(map);
  await sm.halt('error');
  const after = mgr.getMap();
  assert.strictEqual(after.cycle.awaiting_sharding_approval, false);
  assert.strictEqual(after.cycle.awaiting_scoping, false);
  assert.strictEqual(after.cycle.awaiting_confirmation, false);
});

test('testFlagResetOnCompleteT8', async () => {
  const map = makeCyclingMap({ validationOutcome: 'passed', flags: { confirmation: true } });
  const { sm, mgr } = createSM(map);
  await sm.completeCycle();
  const after = mgr.getMap();
  assert.strictEqual(after.cycle.awaiting_confirmation, false);
  assert.strictEqual(after.cycle.awaiting_scoping, false);
  assert.strictEqual(after.cycle.awaiting_sharding_approval, false);
});

test('testFlagResetOnAcknowledgeCompleteT9', async () => {
  const map = makeCompleteMap();
  map.cycle.awaiting_scoping = true;
  map.cycle.awaiting_confirmation = true;
  const { sm, mgr } = createSM(map);
  await sm.acknowledgeComplete();
  const after = mgr.getMap();
  assert.strictEqual(after.cycle.awaiting_scoping, false);
  assert.strictEqual(after.cycle.awaiting_confirmation, false);
  assert.strictEqual(after.cycle.awaiting_sharding_approval, false);
});

test('testFlagResetOnAcknowledgeHaltT10', async () => {
  const map = makeHaltedMap();
  map.cycle.awaiting_sharding_approval = true;
  const { sm, mgr } = createSM(map);
  await sm.acknowledgeHalt();
  const after = mgr.getMap();
  assert.strictEqual(after.cycle.awaiting_sharding_approval, false);
  assert.strictEqual(after.cycle.awaiting_scoping, false);
  assert.strictEqual(after.cycle.awaiting_confirmation, false);
});

test('testFlagResetOnRetryT4', async () => {
  const map = makeCyclingMap({ iteration: 1, flags: { scoping: true } });
  const { sm, mgr } = createSM(map);
  await sm.retryIteration();
  const after = mgr.getMap();
  assert.strictEqual(after.cycle.awaiting_scoping, false);
  assert.strictEqual(after.cycle.awaiting_confirmation, false);
  assert.strictEqual(after.cycle.awaiting_sharding_approval, false);
});

test('testConfirmModifyIncrementsRevision', async () => {
  const map = makeCyclingMap({ revision: 0 });
  map.cycle.awaiting_confirmation = true;
  const { sm, mgr } = createSM(map);

  await sm.setFlag('awaiting_confirmation', false, 'modify');
  const after = mgr.getMap();
  assert.strictEqual(after.cycle.revision, 1);
  assert.strictEqual(after.cycle.awaiting_confirmation, false);
});

test('testConfirmApproveNoRevisionIncrement', async () => {
  const map = makeCyclingMap({ revision: 0 });
  map.cycle.awaiting_confirmation = true;
  const { sm, mgr } = createSM(map);

  await sm.setFlag('awaiting_confirmation', false, 'approve');
  const after = mgr.getMap();
  assert.strictEqual(after.cycle.revision, 0);
  assert.strictEqual(after.cycle.awaiting_confirmation, false);
});

test('testConfirmHaltTriggersT5', async () => {
  const map = makeCyclingMap();
  map.cycle.awaiting_confirmation = true;
  const { sm, mgr } = createSM(map);

  const result = await sm.setFlag('awaiting_confirmation', false, 'halt');

  assert.ok(result !== undefined);
  assert.strictEqual(result!.success, true);
  assert.strictEqual(result!.transition, 'T5');
  assert.strictEqual(result!.to, 'halted');

  const after = mgr.getMap();
  assert.strictEqual(after.meta.status, 'halted');
  assert.strictEqual(after.cycle.outcome, 'halted');
});

test('testTransitionRejectionClass', async () => {
  const err = new TransitionRejection({
    error: 'invalid_transition',
    from: 'idle',
    to: 'cycling',
    reason: 'test reason',
    allowedTargets: ['discovering', 'cycling'],
  });

  assert.ok(err instanceof TransitionRejection);
  assert.ok(err instanceof Error);
  assert.strictEqual(err.name, 'TransitionRejection');
  assert.strictEqual(err.error, 'invalid_transition');
  assert.strictEqual(err.from, 'idle');
  assert.strictEqual(err.to, 'cycling');
  assert.strictEqual(err.reason, 'test reason');
  assert.deepStrictEqual(err.allowedTargets, ['discovering', 'cycling']);
});

test('testErrorResultProperties', async () => {
  const map = makeIdleMap();
  const { sm } = createSM(map);

  const result = await sm.startCycle();

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.from, 'idle');
  assert.strictEqual(result.to, 'idle');
  assert.strictEqual(result.error!.code, 'discovery_required');
  assert.ok(typeof result.error!.reason === 'string');
  assert.ok(result.error!.reason.length > 0);
  assert.ok(Array.isArray(result.error!.allowedTargets));
  assert.ok(result.error!.allowedTargets.includes('cycling'));
});

test('testErrorCodeDiscoveryRequired', async () => {
  const map = makeIdleMap();
  const validation = validateTransition('T3', map);
  assert.strictEqual(validation.errorCode, 'discovery_required');
});

test('testErrorCodeInvalidTransition', async () => {
  const map = makeIdleMap();
  const validation = validateTransition('T5', map);
  assert.strictEqual(validation.errorCode, 'invalid_transition');
});

test('testStateContextIdle', async () => {
  const map = makeIdleMap();
  const ctx = computeStateContext(map);
  assert.strictEqual(ctx.state, 'idle');
  assert.strictEqual(ctx.discovery_status, 'not_started');
  assert.strictEqual(ctx.iteration, 0);
  assert.strictEqual(ctx.revision, 0);
  assert.strictEqual(ctx.active_session_id, null);
  assert.strictEqual(ctx.active_cycle_id, null);
});

test('testStateContextDiscovering', async () => {
  const map = makeDiscoveringMap();
  const ctx = computeStateContext(map);
  assert.strictEqual(ctx.state, 'discovering');
  assert.strictEqual(ctx.discovery_status, 'in_progress');
});

test('testStateContextCycling', async () => {
  const map = makeCyclingMap({ iteration: 3, revision: 2 });
  const ctx = computeStateContext(map);
  assert.strictEqual(ctx.state, 'cycling');
  assert.strictEqual(ctx.discovery_status, 'complete');
  assert.strictEqual(ctx.iteration, 3);
  assert.strictEqual(ctx.revision, 2);
});

test('testStateContextHalted', async () => {
  const map = makeHaltedMap();
  const ctx = computeStateContext(map);
  assert.strictEqual(ctx.state, 'halted');
  assert.strictEqual(ctx.discovery_status, 'complete');
  assert.strictEqual(ctx.iteration, 3);
  assert.strictEqual(ctx.revision, 1);
});

test('testStateContextComplete', async () => {
  const map = makeCompleteMap();
  const ctx = computeStateContext(map);
  assert.strictEqual(ctx.state, 'complete');
  assert.strictEqual(ctx.discovery_status, 'complete');
  assert.strictEqual(ctx.iteration, 2);
  assert.strictEqual(ctx.revision, 0);
});

test('testGetAllowedTransitionsIdle', async () => {
  const { sm } = createSM(makeIdleMap());
  const transitions = await sm.getAllowedTransitions();
  assert.ok(transitions.includes('T1'));
  assert.ok(transitions.includes('T3'));
  assert.ok(transitions.includes('T11'));
  assert.strictEqual(transitions.length, 3);
});

test('testGetAllowedTransitionsDiscovering', async () => {
  const { sm } = createSM(makeDiscoveringMap());
  const transitions = await sm.getAllowedTransitions();
  assert.deepStrictEqual(transitions, ['T2']);
});

test('testGetAllowedTransitionsCycling', async () => {
  const { sm } = createSM(makeCyclingMap());
  const transitions = await sm.getAllowedTransitions();
  assert.ok(transitions.includes('T4'));
  assert.ok(transitions.includes('T5'));
  assert.ok(transitions.includes('T6'));
  assert.ok(transitions.includes('T7'));
  assert.ok(transitions.includes('T8'));
  assert.strictEqual(transitions.length, 5);
});

test('testGetAllowedTransitionsHalted', async () => {
  const { sm } = createSM(makeHaltedMap());
  const transitions = await sm.getAllowedTransitions();
  assert.ok(transitions.includes('T10'));
  assert.ok(transitions.includes('T12'));
  assert.strictEqual(transitions.length, 2);
});

test('testGetAllowedTransitionsComplete', async () => {
  const { sm } = createSM(makeCompleteMap());
  const transitions = await sm.getAllowedTransitions();
  assert.deepStrictEqual(transitions, ['T9']);
});

test('testValidateTransitionTrueCases', async () => {
  assert.strictEqual(validateTransition('T1', makeIdleMap()).valid, true);
  assert.strictEqual(validateTransition('T2', makeDiscoveringMap()).valid, true);
  assert.strictEqual(validateTransition('T3', makeIdleDiscoveryCompleteMap()).valid, true);
  assert.strictEqual(validateTransition('T4', makeCyclingMap()).valid, true);
  assert.strictEqual(validateTransition('T5', makeCyclingMap()).valid, true);
  assert.strictEqual(validateTransition('T7', makeCyclingMap()).valid, true);
  assert.strictEqual(validateTransition('T8', makeCyclingMap({ validationOutcome: 'passed' })).valid, true);
  assert.strictEqual(validateTransition('T9', makeCompleteMap()).valid, true);
  assert.strictEqual(validateTransition('T10', makeHaltedMap()).valid, true);
  assert.strictEqual(validateTransition('T11', makeIdleMap()).valid, true);
  assert.strictEqual(validateTransition('T12', makeHaltedMap()).valid, true);
});

test('testValidateTransitionFalseCases', async () => {
  assert.strictEqual(validateTransition('T1', makeCyclingMap()).valid, false);
  assert.strictEqual(validateTransition('T2', makeIdleMap()).valid, false);
  assert.strictEqual(validateTransition('T3', makeIdleMap()).valid, false);
  assert.strictEqual(validateTransition('T4', makeIdleMap()).valid, false);
  assert.strictEqual(validateTransition('T5', makeIdleMap()).valid, false);
  assert.strictEqual(validateTransition('T8', makeCyclingMap({ validationOutcome: 'failed' })).valid, false);
  assert.strictEqual(validateTransition('T9', makeIdleMap()).valid, false);
  assert.strictEqual(validateTransition('T10', makeIdleMap()).valid, false);
  assert.strictEqual(validateTransition('T12', makeIdleMap()).valid, false);
});

test('testImmutability', async () => {
  const map = makeIdleDiscoveryCompleteMap();
  const original = JSON.parse(JSON.stringify(map));
  const { sm } = createSM(map);

  await sm.startCycle();
  assert.deepStrictEqual(map, original);

  validateTransition('T1', map);
  assert.deepStrictEqual(map, original);
});

test('testImmutabilitySequence', async () => {
  const map = makeBaseMap();
  const original = JSON.parse(JSON.stringify(map));
  const { sm } = createSM(map);

  await sm.startDiscovery();
  assert.deepStrictEqual(map, original);

  await sm.endDiscovery();
  assert.deepStrictEqual(map, original);

  await sm.startCycle();
  assert.deepStrictEqual(map, original);

  await sm.halt('user');
  assert.deepStrictEqual(map, original);
});

test('testFullLifecycle', async () => {
  const map = makeBaseMap();
  map.discovery.total_rounds = 1;
  map.validation.gate.last_outcome = 'passed';
  const { sm, mgr } = createSM(map);

  await sm.startDiscovery();
  assert.strictEqual(mgr.getMap().meta.status, 'discovering');

  await sm.endDiscovery();
  assert.strictEqual(mgr.getMap().meta.status, 'idle');
  assert.strictEqual(mgr.getMap().discovery.status, 'complete');

  await sm.startCycle();
  assert.strictEqual(mgr.getMap().meta.status, 'cycling');
  assert.strictEqual(mgr.getMap().meta.cycle, 1);
  assert.strictEqual(mgr.getMap().cycle.number, 1);
  assert.strictEqual(mgr.getMap().cycle.iteration, 1);

  await sm.retryIteration();
  assert.strictEqual(mgr.getMap().cycle.iteration, 2);

  await sm.completeCycle();
  assert.strictEqual(mgr.getMap().meta.status, 'complete');
  assert.strictEqual(mgr.getMap().cycle.outcome, 'completed');

  await sm.acknowledgeComplete();
  assert.strictEqual(mgr.getMap().meta.status, 'idle');

  await sm.startCycle();
  const final = mgr.getMap();
  assert.strictEqual(final.meta.status, 'cycling');
  assert.strictEqual(final.meta.cycle, 2);
  assert.strictEqual(final.cycle.number, 2);
  assert.strictEqual(final.cycle.iteration, 1);
  assert.strictEqual(final.cycle.revision, 0);
  assert.strictEqual(final.cycle.outcome, 'cycling');
  assert.strictEqual(final.cycle.approval_gate, null);
  assert.strictEqual(final.cycle.awaiting_scoping, false);
  assert.strictEqual(final.cycle.awaiting_confirmation, false);
  assert.strictEqual(final.cycle.awaiting_sharding_approval, false);
  assert.ok(typeof final.cycle.started_at === 'string');
  assert.ok(final.cycle.started_at!.length > 0);
});
