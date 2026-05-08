import { strict as assert } from 'assert';
import { RuntimeMap, createInitialMap } from '../src/runtime-map.js';
import {
  SystemStatus,
  SystemStatusEnum,
  DiscoveryStatus,
  DiscoveryStatusEnum,
} from '../src/types.js';
import {
  StateMachine,
  TransitionResult,
  StateContext,
  computeStateContext,
  TransitionId,
} from '../src/state-machine.js';

// ============================================================================
// Mock RuntimeMapManager
// ============================================================================

class MockMapManager {
  private map: RuntimeMap;

  constructor(map: RuntimeMap) {
    this.map = map;
  }

  async read(): Promise<RuntimeMap> {
    return structuredClone(this.map);
  }

  async write(map: RuntimeMap): Promise<void> {
    this.map = map;
  }

  async update(fn: (map: RuntimeMap) => RuntimeMap): Promise<void> {
    this.map = fn(structuredClone(this.map));
  }

  getVersion(): string {
    return 'test-version';
  }
}

// ============================================================================
// Helpers
// ============================================================================

function createTestMap(): RuntimeMap {
  return createInitialMap({
    projectName: 'test',
    projectType: 'api',
    codeRemote: { url: 'https://github.com/test/repo.git', branch: 'main' },
    issuesRemote: { type: 'git', url: 'https://github.com/test/issues', branch: 'main' },
    docsRemote: { url: 'https://github.com/test/docs.git', pending: false },
    taskStore: { type: 'local' },
    agents: {},
  });
}

// ============================================================================
// Test 1: StateContext Computation
// ============================================================================

export async function testStateContextFromInitialMap() {
  const map = createTestMap();
  const ctx = computeStateContext(map);

  assert.strictEqual(ctx.state, 'idle');
  assert.strictEqual(ctx.active_session_id, null);
  assert.strictEqual(ctx.active_cycle_id, null);
  assert.strictEqual(ctx.discovery_status, 'not_started');
  assert.strictEqual(ctx.iteration, 0);
  assert.strictEqual(ctx.revision, 0);
}

// ============================================================================
// Test 2: T1 - idle -> discovering (valid)
// ============================================================================

export async function testT1IdleToDiscovering() {
  const map = createTestMap();
  const manager = new MockMapManager(map);
  const sm = new StateMachine(manager);

  const result = await sm.transition('T1');

  assert.strictEqual(result.success, true);
  const updated = await manager.read();
  assert.strictEqual(updated.meta.status, 'discovering');
}

// ============================================================================
// Test 3: T1 blocked when discovery_status is complete
// ============================================================================

export async function testT1BlockedWhenDiscoveryComplete() {
  const map = createTestMap();
  map.discovery.status = 'complete';
  const manager = new MockMapManager(map);
  const sm = new StateMachine(manager);

  const result = await sm.transition('T1');

  assert.strictEqual(result.success, false);
  assert(result.error);
}

// ============================================================================
// Test 4: T2 - discovering -> idle
// ============================================================================

export async function testT2DiscoveringToIdle() {
  const map = createTestMap();
  map.meta.status = 'discovering';
  map.discovery.status = 'in_progress';
  map.discovery.current_round = 4;
  map.discovery.total_rounds = 4;
  const manager = new MockMapManager(map);
  const sm = new StateMachine(manager);

  const result = await sm.transition('T2');

  assert.strictEqual(result.success, true);
  const updated = await manager.read();
  assert.strictEqual(updated.discovery.status, 'complete');
}

// ============================================================================
// Test 5: T3 - idle -> cycling (valid, discovery complete)
// ============================================================================

export async function testT3IdleToCyclingDiscoveryComplete() {
  const map = createTestMap();
  map.discovery.status = 'complete';
  const manager = new MockMapManager(map);
  const sm = new StateMachine(manager);

  const result = await sm.transition('T3');

  assert.strictEqual(result.success, true);
  const updated = await manager.read();
  assert.strictEqual(updated.meta.status, 'cycling');
  assert.strictEqual(updated.cycle.iteration, 1);
  assert.strictEqual(updated.cycle.revision, 0);
}

// ============================================================================
// Test 6: T3 blocked when discovery not complete
// ============================================================================

export async function testT3BlockedDiscoveryNotComplete() {
  const map = createTestMap();
  const manager = new MockMapManager(map);
  const sm = new StateMachine(manager);

  const result = await sm.transition('T3');

  assert.strictEqual(result.success, false);
  assert(result.error);
  assert(
    result.error!.reason.includes('Precondition') || result.error!.reason.includes('discovery'),
    `Expected precondition error, got: ${result.error!.reason}`
  );
}

// ============================================================================
// Test 7: T11 - idle -> cycling with --force (bypasses discovery guard)
// ============================================================================

export async function testT11ForceBypassDiscovery() {
  const map = createTestMap();
  const manager = new MockMapManager(map);
  const sm = new StateMachine(manager);

  const result = await sm.transition('T11');

  assert.strictEqual(result.success, true);
  const updated = await manager.read();
  assert.strictEqual(updated.meta.status, 'cycling');
}

// ============================================================================
// Test 8: T4 - cycling -> cycling (retry iteration)
// ============================================================================

export async function testT4RetryIteration() {
  const map = createTestMap();
  map.meta.status = 'cycling';
  map.cycle.iteration = 2;
  const manager = new MockMapManager(map);
  const sm = new StateMachine(manager);

  const result = await sm.transition('T4');

  assert.strictEqual(result.success, true);
  const updated = await manager.read();
  assert.strictEqual(updated.cycle.iteration, 3);
}

// ============================================================================
// Test 9: T4 blocked when iteration cap reached
// ============================================================================

export async function testT4BlockedAtCap() {
  const map = createTestMap();
  map.meta.status = 'cycling';
  map.cycle.iteration = 5;
  const manager = new MockMapManager(map);
  const sm = new StateMachine(manager);

  const result = await sm.transition('T4');

  assert.strictEqual(result.success, false);
}

// ============================================================================
// Test 10: T5 - cycling -> halted (user halt)
// ============================================================================

export async function testT5UserHalt() {
  const map = createTestMap();
  map.meta.status = 'cycling';
  const manager = new MockMapManager(map);
  const sm = new StateMachine(manager);

  const result = await sm.transition('T5');

  assert.strictEqual(result.success, true);
  const updated = await manager.read();
  assert.strictEqual(updated.meta.status, 'halted');
}

// ============================================================================
// Test 11: T6 - cycling -> halted (cap exceeded)
// ============================================================================

export async function testT6CapExceeded() {
  const map = createTestMap();
  map.meta.status = 'cycling';
  map.cycle.iteration = 5;
  map.cycle.max_iterations = 5;
  const manager = new MockMapManager(map);
  const sm = new StateMachine(manager);

  const result = await sm.transition('T6');

  assert.strictEqual(result.success, true);
  const updated = await manager.read();
  assert.strictEqual(updated.meta.status, 'halted');
}

// ============================================================================
// Test 12: T7 - cycling -> halted (unrecoverable error)
// ============================================================================

export async function testT7ErrorHalt() {
  const map = createTestMap();
  map.meta.status = 'cycling';
  const manager = new MockMapManager(map);
  const sm = new StateMachine(manager);

  const result = await sm.transition('T7');

  assert.strictEqual(result.success, true);
  const updated = await manager.read();
  assert.strictEqual(updated.meta.status, 'halted');
}

// ============================================================================
// Test 13: T8 - cycling -> complete
// ============================================================================

export async function testT8CyclingToComplete() {
  const map = createTestMap();
  map.meta.status = 'cycling';
  map.validation.gate.last_outcome = 'passed';
  const manager = new MockMapManager(map);
  const sm = new StateMachine(manager);

  const result = await sm.transition('T8');

  assert.strictEqual(result.success, true);
  const updated = await manager.read();
  assert.strictEqual(updated.meta.status, 'complete');
}

// ============================================================================
// Test 14: T9 - complete -> idle
// ============================================================================

export async function testT9CompleteToIdle() {
  const map = createTestMap();
  map.meta.status = 'complete';
  map.cycle.number = 1;
  map.cycle.iteration = 3;
  map.cycle.revision = 2;
  const manager = new MockMapManager(map);
  const sm = new StateMachine(manager);

  const result = await sm.transition('T9');

  assert.strictEqual(result.success, true);
  const updated = await manager.read();
  assert.strictEqual(updated.meta.status, 'idle');
}

// ============================================================================
// Test 15: T10 - halted -> idle
// ============================================================================

export async function testT10HaltedToIdle() {
  const map = createTestMap();
  map.meta.status = 'halted';
  map.cycle.number = 1;
  map.cycle.iteration = 3;
  map.cycle.revision = 2;
  const manager = new MockMapManager(map);
  const sm = new StateMachine(manager);

  const result = await sm.transition('T10');

  assert.strictEqual(result.success, true);
  const updated = await manager.read();
  assert.strictEqual(updated.meta.status, 'idle');
}

// ============================================================================
// Test 16: T12 - halted -> cycling (resume)
// ============================================================================

export async function testT12HaltedToCyclingResume() {
  const map = createTestMap();
  map.meta.status = 'halted';
  map.cycle.number = 1;
  map.cycle.iteration = 3;
  map.cycle.revision = 2;
  const manager = new MockMapManager(map);
  const sm = new StateMachine(manager);

  const result = await sm.transition('T12');

  assert.strictEqual(result.success, true);
  const updated = await manager.read();
  assert.strictEqual(updated.meta.status, 'cycling');
  assert.strictEqual(updated.cycle.iteration, 3);
}

// ============================================================================
// Test 17: Invalid transition returns error with allowed targets
// ============================================================================

export async function testInvalidTransitionReturnsAllowedTargets() {
  const map = createTestMap();
  map.meta.status = 'cycling';
  const manager = new MockMapManager(map);
  const sm = new StateMachine(manager);

  const result = await sm.transition('T1');

  assert.strictEqual(result.success, false);
  assert(result.error);
  assert(result.error!.allowedTargets);
  assert(result.error!.allowedTargets!.length > 0);
}

// ============================================================================
// Test 18: Flag exclusivity enforcement
// ============================================================================

export async function testFlagExclusivity() {
  const map = createTestMap();
  map.meta.status = 'cycling';
  const manager = new MockMapManager(map);
  const sm = new StateMachine(manager);

  await sm.setFlag('awaiting_scoping', true);
  let updated = await manager.read();
  assert.strictEqual(updated.cycle.awaiting_scoping, true);
  assert.strictEqual(updated.cycle.awaiting_confirmation, false);
  assert.strictEqual(updated.cycle.awaiting_sharding_approval, false);

  await sm.setFlag('awaiting_confirmation', true);
  updated = await manager.read();
  assert.strictEqual(updated.cycle.awaiting_scoping, false);
  assert.strictEqual(updated.cycle.awaiting_confirmation, true);
  assert.strictEqual(updated.cycle.awaiting_sharding_approval, false);
}

// ============================================================================
// Test 19: Flags reset on cycle end
// ============================================================================

export async function testFlagsResetOnCycleEnd() {
  const map = createTestMap();
  map.meta.status = 'cycling';
  map.cycle.awaiting_scoping = true;
  map.validation.gate.last_outcome = 'passed';
  const manager = new MockMapManager(map);
  const sm = new StateMachine(manager);

  const result = await sm.transition('T8');
  assert.strictEqual(result.success, true);

  const updated = await manager.read();
  assert.strictEqual(updated.cycle.awaiting_scoping, false);
  assert.strictEqual(updated.cycle.awaiting_confirmation, false);
  assert.strictEqual(updated.cycle.awaiting_sharding_approval, false);

  const map2 = createTestMap();
  map2.meta.status = 'cycling';
  map2.cycle.awaiting_scoping = true;
  map2.cycle.awaiting_confirmation = true;
  map2.cycle.awaiting_sharding_approval = true;
  const manager2 = new MockMapManager(map2);
  const sm2 = new StateMachine(manager2);

  const result2 = await sm2.transition('T5');
  assert.strictEqual(result2.success, true);

  const updated2 = await manager2.read();
  assert.strictEqual(updated2.cycle.awaiting_scoping, false);
  assert.strictEqual(updated2.cycle.awaiting_confirmation, false);
  assert.strictEqual(updated2.cycle.awaiting_sharding_approval, false);
}

// ============================================================================
// Test 20: Chat independence
// ============================================================================

export async function testChatIndependence() {
  const cases: Array<{ tid: TransitionId; setup: (map: RuntimeMap) => void }> = [
    { tid: 'T1', setup: (m) => { m.meta.status = 'idle'; } },
    { tid: 'T2', setup: (m) => { m.meta.status = 'discovering'; m.discovery.status = 'in_progress'; m.discovery.current_round = 4; m.discovery.total_rounds = 4; } },
    { tid: 'T3', setup: (m) => { m.meta.status = 'idle'; m.discovery.status = 'complete'; } },
    { tid: 'T4', setup: (m) => { m.meta.status = 'cycling'; } },
    { tid: 'T5', setup: (m) => { m.meta.status = 'cycling'; } },
    { tid: 'T6', setup: (m) => { m.meta.status = 'cycling'; m.cycle.iteration = 5; m.cycle.max_iterations = 5; } },
    { tid: 'T7', setup: (m) => { m.meta.status = 'cycling'; } },
    { tid: 'T8', setup: (m) => { m.meta.status = 'cycling'; m.validation.gate.last_outcome = 'passed'; } },
    { tid: 'T9', setup: (m) => { m.meta.status = 'complete'; } },
    { tid: 'T10', setup: (m) => { m.meta.status = 'halted'; } },
    { tid: 'T11', setup: (m) => { m.meta.status = 'idle'; } },
    { tid: 'T12', setup: (m) => { m.meta.status = 'halted'; } },
  ];

  for (const { tid, setup } of cases) {
    const map = createTestMap();
    setup(map);
    map.chat.session_open = true;
    const manager = new MockMapManager(map);
    const sm = new StateMachine(manager);

    const result = await sm.transition(tid);
    assert.strictEqual(result.success, true, `${tid} should succeed with chat.session_open = true`);
  }
}

// ============================================================================
// Run All Tests
// ============================================================================

export async function runAllTests() {
  console.log('Running Phase C (State Machine) tests...\n');

  console.log('✓ Testing StateContext computation from initial map');
  await testStateContextFromInitialMap();

  console.log('✓ Testing T1 - idle -> discovering (valid)');
  await testT1IdleToDiscovering();

  console.log('✓ Testing T1 blocked when discovery complete');
  await testT1BlockedWhenDiscoveryComplete();

  console.log('✓ Testing T2 - discovering -> idle');
  await testT2DiscoveringToIdle();

  console.log('✓ Testing T3 - idle -> cycling (discovery complete)');
  await testT3IdleToCyclingDiscoveryComplete();

  console.log('✓ Testing T3 blocked when discovery not complete');
  await testT3BlockedDiscoveryNotComplete();

  console.log('✓ Testing T11 - idle -> cycling with --force');
  await testT11ForceBypassDiscovery();

  console.log('✓ Testing T4 - cycling -> cycling (retry iteration)');
  await testT4RetryIteration();

  console.log('✓ Testing T4 blocked when iteration cap reached');
  await testT4BlockedAtCap();

  console.log('✓ Testing T5 - cycling -> halted (user halt)');
  await testT5UserHalt();

  console.log('✓ Testing T6 - cycling -> halted (cap exceeded)');
  await testT6CapExceeded();

  console.log('✓ Testing T7 - cycling -> halted (unrecoverable error)');
  await testT7ErrorHalt();

  console.log('✓ Testing T8 - cycling -> complete');
  await testT8CyclingToComplete();

  console.log('✓ Testing T9 - complete -> idle');
  await testT9CompleteToIdle();

  console.log('✓ Testing T10 - halted -> idle');
  await testT10HaltedToIdle();

  console.log('✓ Testing T12 - halted -> cycling (resume)');
  await testT12HaltedToCyclingResume();

  console.log('✓ Testing invalid transition returns allowed targets');
  await testInvalidTransitionReturnsAllowedTargets();

  console.log('✓ Testing flag exclusivity enforcement');
  await testFlagExclusivity();

  console.log('✓ Testing flags reset on cycle end');
  await testFlagsResetOnCycleEnd();

  console.log('✓ Testing chat independence');
  await testChatIndependence();

  console.log('\n✅ All Phase C tests passed!');
}

runAllTests();
