import { strict as assert } from 'assert';
import { CycleService } from '../src/cycle-service.js';
import { StateMachine } from '../src/state-machine.js';
import type { RuntimeMap, RuntimeMapManager } from '../src/runtime-map.js';
import type { RunManifest, ContextPack } from '../src/run-artifacts.js';
import type { RunArtifactManager } from '../src/run-artifacts.js';

// ─── In-memory run artifact manager ─────────────────────────────────────────

class InMemoryRunArtifactManager implements RunArtifactManager {
  private dirs = new Set<string>();
  private manifests = new Map<string, RunManifest>();
  private packs = new Map<string, ContextPack>();

  private key(c: number, i: number): string { return `${c}-${i}`; }

  runDir(c: number, i: number): string { return `.sle/runs/${this.key(c, i)}`; }
  async createRunDir(c: number, i: number): Promise<string> {
    this.dirs.add(this.key(c, i));
    return this.runDir(c, i);
  }
  async createManifest(params: { cycleId: string; cycleNumber: number; iteration: number; planningDepth: import('../src/types.js').PlanningDepth }): Promise<void> {
    this.manifests.set(this.key(params.cycleNumber, params.iteration), {
      cycle_id: params.cycleId,
      cycle_number: params.cycleNumber,
      iteration: params.iteration,
      planning_depth: params.planningDepth,
      started_at: new Date().toISOString(),
      outcome: 'in_progress',
      nodes: [],
    });
  }
  async readManifest(c: number, i: number): Promise<RunManifest> {
    const m = this.manifests.get(this.key(c, i));
    if (!m) throw new Error(`No manifest for ${c}-${i}`);
    return JSON.parse(JSON.stringify(m)) as RunManifest;
  }
  async updateManifest(c: number, i: number, updater: (m: RunManifest) => RunManifest): Promise<void> {
    const m = await this.readManifest(c, i);
    this.manifests.set(this.key(c, i), updater(m));
  }
  async updateNodeStatus(c: number, i: number, nodeId: string, update: Record<string, unknown>): Promise<void> {
    await this.updateManifest(c, i, (m) => ({
      ...m,
      nodes: m.nodes.map((n) => n.id === nodeId ? { ...n, ...update } : n),
    }));
  }
  async finalizeManifest(c: number, i: number, outcome: 'complete' | 'halted'): Promise<void> {
    await this.updateManifest(c, i, (m) => ({ ...m, outcome, completed_at: new Date().toISOString() }));
  }
  async writeContextPack(c: number, i: number, pack: ContextPack): Promise<void> {
    this.packs.set(this.key(c, i), pack);
  }
  async readContextPack(c: number, i: number): Promise<ContextPack> {
    return this.packs.get(this.key(c, i)) ?? {};
  }
  async writeNodeOutput(_c: number, _i: number, _nodeId: string, _content: string): Promise<void> {}
  async dirExists(c: number, i: number): Promise<boolean> {
    return this.dirs.has(this.key(c, i));
  }
  getDirs(): Set<string> { return this.dirs; }
  getManifest(c: number, i: number): RunManifest | undefined { return this.manifests.get(this.key(c, i)); }
}

// ─── In-memory map manager ───────────────────────────────────────────────────

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
    this.map = JSON.parse(JSON.stringify(fn(current)));
  }

  getVersion(): string {
    return this.map.meta.version_id;
  }

  getMap(): RuntimeMap {
    return JSON.parse(JSON.stringify(this.map));
  }
}

// ─── Base map factory ────────────────────────────────────────────────────────

function makeBaseMap(opts?: { discoveryComplete?: boolean; status?: RuntimeMap['meta']['status'] }): RuntimeMap {
  return {
    meta: {
      status: opts?.status ?? 'idle',
      cycle: 0,
      version_id: '123e4567-e89b-12d3-a456-426614174000',
      initialized_at: '2026-05-08T12:00:00Z',
      updated_at: '2026-05-08T12:00:00Z',
    },
    project: { name: 'test', description: 'test', type: 'api' },
    remotes: {
      code: { type: 'git', url: 'https://github.com/org/repo.git', branch: 'main' },
      issues: { type: 'git', url: 'https://github.com/org/issues.git', branch: 'main' },
      docs: { url: 'https://github.com/org/docs.git', pending: false },
    },
    task_store: { type: 'local' },
    agents: {},
    discovery: {
      status: opts?.discoveryComplete ? 'complete' : 'not_started',
      mode: 'full',
      completed_at: opts?.discoveryComplete ? '2026-05-08T13:00:00Z' : undefined,
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
  };
}

function makeHaltedMap(): RuntimeMap {
  const map = makeBaseMap({ discoveryComplete: true });
  map.meta.status = 'halted';
  map.meta.cycle = 1;
  map.meta.active_cycle_id = 'cycle-uuid-1234-5678-90ab-cdefabcdef12';
  map.cycle.number = 1;
  map.cycle.iteration = 2;
  map.cycle.revision = 0;
  map.cycle.intent = 'Add user authentication to the API';
  map.cycle.started_at = '2026-05-08T14:00:00Z';
  map.cycle.completed_at = '2026-05-08T15:00:00Z';
  map.cycle.outcome = 'halted';
  return map;
}

function createService(map: RuntimeMap): {
  svc: CycleService;
  mgr: InMemoryMapManager;
  ram: InMemoryRunArtifactManager;
} {
  const mgr = new InMemoryMapManager(map);
  const sm = new StateMachine(mgr);
  const ram = new InMemoryRunArtifactManager();
  const svc = new CycleService(sm, mgr, ram as unknown as import('../src/run-artifacts.js').RunArtifactManager);
  return { svc, mgr, ram };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function testStartCycleWithDiscoveryComplete() {
  const map = makeBaseMap({ discoveryComplete: true });
  const { svc, mgr, ram } = createService(map);

  const result = await svc.start({ intent: 'Add user authentication to the API' });

  assert.ok(typeof result.cycle_id === 'string' && result.cycle_id.length > 0);
  assert.strictEqual(result.cycle_number, 1);
  assert.strictEqual(result.planning_depth, 'standard');
  assert.strictEqual(result.intent, 'Add user authentication to the API');
  assert.ok(typeof result.started_at === 'string');
  assert.strictEqual(result.initial_node, 'SCOPING');

  const after = mgr.getMap();
  assert.strictEqual(after.meta.status, 'cycling');
  assert.strictEqual(after.meta.cycle, 1);
  assert.strictEqual(after.meta.active_cycle_id, result.cycle_id);
  assert.strictEqual(after.cycle.number, 1);
  assert.strictEqual(after.cycle.iteration, 1);
  assert.strictEqual(after.cycle.revision, 0);
  assert.strictEqual(after.cycle.intent, 'Add user authentication to the API');

  // Phase B: run dir created and manifest written
  assert.ok(ram.getDirs().has('1-1'));
  const manifest = ram.getManifest(1, 1);
  assert.ok(manifest !== undefined);
  assert.strictEqual(manifest!.cycle_id, result.cycle_id);
  assert.strictEqual(manifest!.outcome, 'in_progress');

  // Phase B: DAG state initialized in map
  const dag = after.meta.dag;
  assert.ok(dag !== undefined);
  assert.strictEqual(dag!.current_node, null);
  assert.deepStrictEqual(dag!.completed_nodes, []);
  assert.strictEqual(dag!.iteration, 1);
  assert.strictEqual(dag!.revision, 0);
  assert.ok(dag!.nodes['SCOPING'] !== undefined);
  assert.strictEqual(dag!.nodes['SCOPING'].status, 'pending');
  assert.ok(dag!.nodes['SNAPSHOT'] !== undefined);
}

async function testStartCycleCustomDepth() {
  const map = makeBaseMap({ discoveryComplete: true });
  const { svc, mgr, ram } = createService(map);

  const result = await svc.start({
    intent: 'Refactor the database layer completely',
    depth: 'deep',
  });

  assert.strictEqual(result.planning_depth, 'deep');
  const after = mgr.getMap();
  assert.strictEqual(after.cycle.planning_depth, 'deep');
}

async function testStartCycleWithForceBypassesDiscovery() {
  const map = makeBaseMap({ discoveryComplete: false });
  const { svc, mgr, ram } = createService(map);

  const result = await svc.start({
    intent: 'Bootstrap the initial project structure',
    force: true,
  });

  assert.strictEqual(result.cycle_number, 1);
  const after = mgr.getMap();
  assert.strictEqual(after.meta.status, 'cycling');
}

async function testStartCycleRequiresDiscovery() {
  const map = makeBaseMap({ discoveryComplete: false });
  const { svc } = createService(map);

  try {
    await svc.start({ intent: 'Add user authentication to the API' });
    assert.fail('Expected error not thrown');
  } catch (err) {
    const error = err as Error & { code?: string };
    assert.strictEqual(error.code, 'discovery_required');
  }
}

async function testStartCycleAlreadyActive() {
  const map = makeBaseMap({ discoveryComplete: true });
  map.meta.status = 'cycling';
  map.meta.cycle = 1;
  map.cycle.number = 1;
  map.cycle.iteration = 1;
  map.cycle.outcome = 'cycling';
  const { svc } = createService(map);

  try {
    await svc.start({ intent: 'Another cycle attempt here' });
    assert.fail('Expected error not thrown');
  } catch (err) {
    const error = err as Error & { code?: string };
    assert.strictEqual(error.code, 'cycle_already_active');
  }
}

async function testStartCycleIntentTooShort() {
  const map = makeBaseMap({ discoveryComplete: true });
  const { svc } = createService(map);

  try {
    await svc.start({ intent: 'short' });
    assert.fail('Expected error not thrown');
  } catch (err) {
    const error = err as Error & { code?: string };
    assert.strictEqual(error.code, 'invalid_intent');
  }
}

async function testGetCurrent() {
  const map = makeBaseMap({ discoveryComplete: true });
  map.meta.status = 'cycling';
  map.meta.cycle = 1;
  map.meta.active_cycle_id = 'abc123de-f012-3456-7890-abcdef123456';
  map.cycle.number = 1;
  map.cycle.iteration = 2;
  map.cycle.revision = 1;
  map.cycle.intent = 'Add user authentication to the API';
  map.cycle.planning_depth = 'deep';
  const { svc } = createService(map);

  const record = await svc.getCurrent();

  assert.strictEqual(record.cycle_id, 'abc123de-f012-3456-7890-abcdef123456');
  assert.strictEqual(record.cycle_number, 1);
  assert.strictEqual(record.iteration, 2);
  assert.strictEqual(record.revision, 1);
  assert.strictEqual(record.planning_depth, 'deep');
  assert.strictEqual(record.intent, 'Add user authentication to the API');
  assert.strictEqual(record.outcome, 'cycling');
}

async function testHaltCycle() {
  const map = makeBaseMap({ discoveryComplete: true });
  map.meta.status = 'cycling';
  map.meta.cycle = 1;
  map.cycle.number = 1;
  map.cycle.iteration = 1;
  map.cycle.outcome = 'cycling';
  const { svc, mgr, ram } = createService(map);

  await svc.halt();

  const after = mgr.getMap();
  assert.strictEqual(after.meta.status, 'halted');
  assert.strictEqual(after.cycle.outcome, 'halted');
}

async function testHaltWhenNotCycling() {
  const map = makeBaseMap({ discoveryComplete: true });
  const { svc } = createService(map);

  try {
    await svc.halt();
    assert.fail('Expected error not thrown');
  } catch (err) {
    const error = err as Error & { code?: string };
    assert.ok(error.code !== undefined);
  }
}

async function testAcknowledgeHalt() {
  const map = makeHaltedMap();
  const { svc, mgr, ram } = createService(map);

  await svc.acknowledgeHalt();

  const after = mgr.getMap();
  assert.strictEqual(after.meta.status, 'idle');
  assert.strictEqual(after.meta.active_cycle_id ?? null, null);
}

async function testAcknowledgeHaltWhenNotHalted() {
  const map = makeBaseMap({ discoveryComplete: true });
  const { svc } = createService(map);

  try {
    await svc.acknowledgeHalt();
    assert.fail('Expected error not thrown');
  } catch (err) {
    const error = err as Error & { code?: string };
    assert.ok(error.code !== undefined);
  }
}

async function testResumeCycle() {
  const map = makeHaltedMap();
  const { svc, mgr, ram } = createService(map);

  await svc.resume();

  const after = mgr.getMap();
  assert.strictEqual(after.meta.status, 'cycling');
  assert.strictEqual(after.cycle.outcome, 'cycling');
  assert.strictEqual(after.cycle.iteration, 2);
}

async function testResumeWhenNotHalted() {
  const map = makeBaseMap({ discoveryComplete: true });
  const { svc } = createService(map);

  try {
    await svc.resume();
    assert.fail('Expected error not thrown');
  } catch (err) {
    const error = err as Error & { code?: string };
    assert.ok(error.code !== undefined);
  }
}

async function testFullCycleLifecycle() {
  const map = makeBaseMap({ discoveryComplete: true });
  const { svc, mgr, ram } = createService(map);

  const startResult = await svc.start({ intent: 'Implement the full auth system now' });
  assert.strictEqual(mgr.getMap().meta.status, 'cycling');
  assert.ok(startResult.cycle_id.length > 0);

  await svc.halt();
  assert.strictEqual(mgr.getMap().meta.status, 'halted');
  assert.strictEqual(mgr.getMap().meta.active_cycle_id, startResult.cycle_id);

  await svc.resume();
  assert.strictEqual(mgr.getMap().meta.status, 'cycling');

  await svc.halt();
  assert.strictEqual(mgr.getMap().meta.status, 'halted');

  await svc.acknowledgeHalt();
  assert.strictEqual(mgr.getMap().meta.status, 'idle');
  assert.strictEqual(mgr.getMap().meta.active_cycle_id ?? null, null);
}

async function testSecondCycleGetsNewId() {
  const map = makeBaseMap({ discoveryComplete: true });
  const { svc, mgr, ram } = createService(map);

  const first = await svc.start({ intent: 'First cycle of work here' });
  await svc.halt();
  await svc.acknowledgeHalt();

  const second = await svc.start({ intent: 'Second cycle of work here' });

  assert.notStrictEqual(first.cycle_id, second.cycle_id);
  assert.strictEqual(second.cycle_number, 2);
  assert.strictEqual(mgr.getMap().meta.active_cycle_id, second.cycle_id);
}

// ─── Phase B tests ───────────────────────────────────────────────────────────

async function testDAGStateInitializedOnStart() {
  const map = makeBaseMap({ discoveryComplete: true });
  const { svc, mgr } = createService(map);

  await svc.start({ intent: 'Add user authentication to the API' });

  const dagState = await svc.getDAGState();
  assert.ok(dagState !== null);
  assert.strictEqual(dagState!.current_node, null);
  assert.deepStrictEqual(dagState!.completed_nodes, []);
  assert.strictEqual(dagState!.iteration, 1);
  assert.strictEqual(dagState!.revision, 0);

  // All 14 core nodes initialized as pending
  const nodeIds = Object.keys(dagState!.nodes);
  assert.ok(nodeIds.includes('SCOPING'));
  assert.ok(nodeIds.includes('DESIGN'));
  assert.ok(nodeIds.includes('SNAPSHOT'));
  assert.strictEqual(nodeIds.length, 14);
  for (const node of Object.values(dagState!.nodes)) {
    assert.strictEqual(node.status, 'pending');
  }
}

async function testDAGStateClearedOnAcknowledge() {
  const map = makeHaltedMap();
  const { svc, mgr } = createService(map);

  await svc.acknowledgeHalt();

  const dagState = await svc.getDAGState();
  assert.strictEqual(dagState, null);
  assert.strictEqual(mgr.getMap().meta.dag, undefined);
}

async function testGetCurrentRunReturnsNullWhenNotCycling() {
  const map = makeBaseMap({ discoveryComplete: true });
  const { svc } = createService(map);
  const run = await svc.getCurrentRun();
  assert.strictEqual(run, null);
}

async function testGetCurrentRunReturnsManifestWhenCycling() {
  const map = makeBaseMap({ discoveryComplete: true });
  const { svc, ram } = createService(map);

  const result = await svc.start({ intent: 'Add user authentication to the API' });
  const run = await svc.getCurrentRun();

  assert.ok(run !== null);
  assert.strictEqual(run!.cycle_id, result.cycle_id);
  assert.strictEqual(run!.cycle_number, 1);
  assert.strictEqual(run!.iteration, 1);
  assert.strictEqual(run!.outcome, 'in_progress');
}

async function testRunDirCreatedOnStart() {
  const map = makeBaseMap({ discoveryComplete: true });
  const { svc, ram } = createService(map);

  await svc.start({ intent: 'Add user authentication to the API' });

  assert.ok(ram.getDirs().has('1-1'), 'Run dir 1-1 should be created');
  const manifest = ram.getManifest(1, 1);
  assert.ok(manifest !== undefined);
  assert.strictEqual(manifest!.planning_depth, 'standard');
}

async function testHaltFinalizesManifest() {
  const map = makeBaseMap({ discoveryComplete: true });
  const { svc, ram } = createService(map);

  await svc.start({ intent: 'Add user authentication to the API' });
  await svc.halt();

  const manifest = ram.getManifest(1, 1);
  assert.ok(manifest !== undefined);
  assert.strictEqual(manifest!.outcome, 'halted');
  assert.ok(manifest!.completed_at !== undefined);
}

// ─── Runner ──────────────────────────────────────────────────────────────────

async function runAllTests() {
  console.log('Running Phase A+B (Cycle Service + Run Artifacts) tests...\n');

  const tests: Array<{ name: string; fn: () => Promise<void> }> = [
    { name: 'start: discovery complete → cycling state', fn: testStartCycleWithDiscoveryComplete },
    { name: 'start: custom planning depth', fn: testStartCycleCustomDepth },
    { name: 'start: force bypasses discovery check', fn: testStartCycleWithForceBypassesDiscovery },
    { name: 'start: error discovery_required', fn: testStartCycleRequiresDiscovery },
    { name: 'start: error cycle_already_active', fn: testStartCycleAlreadyActive },
    { name: 'start: error invalid_intent (too short)', fn: testStartCycleIntentTooShort },
    { name: 'getCurrent: returns cycle record', fn: testGetCurrent },
    { name: 'halt: cycling → halted', fn: testHaltCycle },
    { name: 'halt: error when not cycling', fn: testHaltWhenNotCycling },
    { name: 'acknowledgeHalt: halted → idle, clears cycle_id', fn: testAcknowledgeHalt },
    { name: 'acknowledgeHalt: error when not halted', fn: testAcknowledgeHaltWhenNotHalted },
    { name: 'resume: halted → cycling, iteration preserved', fn: testResumeCycle },
    { name: 'resume: error when not halted', fn: testResumeWhenNotHalted },
    { name: 'full lifecycle: start → halt → resume → halt → acknowledge', fn: testFullCycleLifecycle },
    { name: 'second cycle gets new UUID and incremented number', fn: testSecondCycleGetsNewId },
    { name: 'DAG state initialized on cycle start', fn: testDAGStateInitializedOnStart },
    { name: 'DAG state cleared on acknowledge-halt', fn: testDAGStateClearedOnAcknowledge },
    { name: 'getCurrentRun: null when not cycling', fn: testGetCurrentRunReturnsNullWhenNotCycling },
    { name: 'getCurrentRun: manifest when cycling', fn: testGetCurrentRunReturnsManifestWhenCycling },
    { name: 'run dir created on cycle start', fn: testRunDirCreatedOnStart },
    { name: 'halt finalizes manifest with halted outcome', fn: testHaltFinalizesManifest },
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
    console.error(`\n❌ ${failures.length}/${tests.length} Phase A tests FAILED:`);
    for (const f of failures) {
      console.error(`  - ${f.name}`);
      console.error(`    ${f.error instanceof Error ? f.error.message : String(f.error)}`);
    }
    throw failures[0].error;
  }

  console.log(`\n✅ All ${tests.length} Phase A tests passed!`);
}

runAllTests();
