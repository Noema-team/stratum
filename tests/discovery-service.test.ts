import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiscoveryService } from '../src/discovery-service.js';
import type { RuntimeMap, RuntimeMapManager } from '../src/runtime-map.js';

// ─── Mock implementations ────────────────────────────────────────────

class MockRuntimeMapManager implements RuntimeMapManager {
  private map: RuntimeMap;

  constructor(initial?: RuntimeMap) {
    this.map = initial || JSON.parse(JSON.stringify({
      meta: {
        status: 'idle',
        cycle: 0,
        version_id: 'test-version',
        initialized_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      project: { name: 'test', description: '', type: 'api' },
      remotes: {
        code: { type: 'git', url: '', branch: '' },
        issues: { type: 'git', url: '', branch: '' },
        docs: { url: '', pending: false },
      },
      task_store: { type: 'local' },
      agents: {},
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
        started_at: null,
        outcome: null,
        approval_gate: null,
      },
      chat: { session_open: false },
      artifacts: [],
      validation: {
        categories: [],
        gate: { mode: 'all_must_pass', last_outcome: null, failed_categories: [] },
      },
    }));
  }

  async read(): Promise<RuntimeMap> { return JSON.parse(JSON.stringify(this.map)); }
  async write(map: RuntimeMap): Promise<void> { this.map = JSON.parse(JSON.stringify(map)); }
  async update(fn: (map: RuntimeMap) => RuntimeMap): Promise<void> {
    const current = await this.read();
    this.map = JSON.parse(JSON.stringify(fn(current)));
  }
  getVersion(): string { return this.map.meta.version_id; }
  getMap(): RuntimeMap { return JSON.parse(JSON.stringify(this.map)); }
}

class MockStateAPI {
  private _currentState: string = 'idle';

  async transition(request: { target: string; trigger: string }): Promise<{ ok: boolean; data?: unknown; error?: { code: string } }> {
    if (request.target === 'discovering') {
      this._currentState = 'discovering';
      return { ok: true, data: { previous: 'idle', current: 'discovering' } };
    }
    if (request.target === 'idle') {
      this._currentState = 'idle';
      return { ok: true, data: { previous: 'discovering', current: 'idle' } };
    }
    return { ok: false, error: { code: 'invalid_transition' } };
  }

  async health(): Promise<unknown> { return { ok: true, data: { status: 'healthy' } }; }
  async info(): Promise<unknown> { return { ok: true, data: {} }; }
  async getSystemState(): Promise<unknown> { return { ok: true, data: { state: this._currentState } }; }
  onStateChanged(): () => void { return () => {}; }
}

// ─── Tests ───────────────────────────────────────────────────────────

async function testStartTransitionsToDiscovering() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'sle-disc-test-'));
  const mapManager = new MockRuntimeMapManager();
  const stateAPI = new MockStateAPI() as never;
  const service = new DiscoveryService(stateAPI, mapManager, tmpDir);

  const session = await service.start(tmpDir, { mode: 'solo' });
  assert.strictEqual(session.mode, 'solo');
  assert.strictEqual(session.current_round, 1);

  // Check map updated to in_progress
  const map = await mapManager.read();
  assert.strictEqual(map.discovery.status, 'in_progress');

  await fs.rm(tmpDir, { recursive: true, force: true });
}

async function testStartReturnsSessionData() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'sle-disc-test-'));
  const mapManager = new MockRuntimeMapManager();
  const stateAPI = new MockStateAPI() as never;
  const service = new DiscoveryService(stateAPI, mapManager, tmpDir);

  const session = await service.start(tmpDir, { mode: 'solo' });
  assert.ok(session.session_id);
  assert.strictEqual(session.current_round, 1);
  assert.strictEqual(session.total_rounds, 1);
  assert.strictEqual(session.round_status, 'collecting');

  await fs.rm(tmpDir, { recursive: true, force: true });
}

async function testSubmitResponseCreatesDraft() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'sle-disc-test-'));
  const mapManager = new MockRuntimeMapManager();
  const stateAPI = new MockStateAPI() as never;
  const service = new DiscoveryService(stateAPI, mapManager, tmpDir);

  const session = await service.start(tmpDir, { mode: 'solo' });
  const result = await service.submitResponse(session.session_id, session.current_round);

  assert.strictEqual(result.round, 1);
  assert.strictEqual(result.status, 'drafting');

  await fs.rm(tmpDir, { recursive: true, force: true });
}

async function testApproveCompletesRound() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'sle-disc-test-'));
  const mapManager = new MockRuntimeMapManager();
  const stateAPI = new MockStateAPI() as never;
  const service = new DiscoveryService(stateAPI, mapManager, tmpDir);

  const session = await service.start(tmpDir, { mode: 'solo' });
  await service.approveRound(session.session_id, session.current_round);

  // After approving the final round, discovery should be complete
  const map = await mapManager.read();
  assert.strictEqual(map.discovery.status, 'complete');

  await fs.rm(tmpDir, { recursive: true, force: true });
}

async function testStartWhenCompleteReturnsError() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'sle-disc-test-'));
  const mapManager = new MockRuntimeMapManager();
  const stateAPI = new MockStateAPI() as never;
  const service = new DiscoveryService(stateAPI, mapManager, tmpDir);

  const session = await service.start(tmpDir, { mode: 'solo' });
  await service.approveRound(session.session_id, session.current_round);

  // Starting again should throw: discovery already complete
  try {
    await service.start(tmpDir, { mode: 'solo' });
    assert.fail('Should have thrown when discovery is complete');
  } catch (err) {
    assert.ok((err as Error).message);
  }

  await fs.rm(tmpDir, { recursive: true, force: true });
}

async function testSoloModeReturns1TotalRound() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'sle-disc-test-'));
  const mapManager = new MockRuntimeMapManager();
  const stateAPI = new MockStateAPI() as never;
  const service = new DiscoveryService(stateAPI, mapManager, tmpDir);

  const session = await service.start(tmpDir, { mode: 'solo' });
  assert.strictEqual(session.total_rounds, 1);

  await fs.rm(tmpDir, { recursive: true, force: true });
}

async function testFullModeReturns4TotalRounds() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'sle-disc-test-'));
  const mapManager = new MockRuntimeMapManager();
  const stateAPI = new MockStateAPI() as never;
  const service = new DiscoveryService(stateAPI, mapManager, tmpDir);

  const session = await service.start(tmpDir, { mode: 'full' });
  assert.strictEqual(session.total_rounds, 4);

  await fs.rm(tmpDir, { recursive: true, force: true });
}

async function testGetStatusAfterStart() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'sle-disc-test-'));
  const mapManager = new MockRuntimeMapManager();
  const stateAPI = new MockStateAPI() as never;
  const service = new DiscoveryService(stateAPI, mapManager, tmpDir);

  const session = await service.start(tmpDir, { mode: 'solo' });
  const status = await service.getStatus(session.session_id);

  assert.strictEqual(status.status, 'in_progress');
  assert.strictEqual(status.mode, 'solo');
  assert.strictEqual(status.current_round, 1);

  await fs.rm(tmpDir, { recursive: true, force: true });
}

// ─── Runner ──────────────────────────────────────────────────────────

async function runAllTests() {
  const tests = [
    { name: 'Start transitions to discovering state', fn: testStartTransitionsToDiscovering },
    { name: 'Start returns session data (session_id, round)', fn: testStartReturnsSessionData },
    { name: 'Submit response creates draft', fn: testSubmitResponseCreatesDraft },
    { name: 'Approve completes the round', fn: testApproveCompletesRound },
    { name: 'Start when discovery is complete returns error', fn: testStartWhenCompleteReturnsError },
    { name: 'Solo mode returns 1 total round', fn: testSoloModeReturns1TotalRound },
    { name: 'Full mode returns 4 total rounds', fn: testFullModeReturns4TotalRounds },
    { name: 'Get status returns in_progress after start', fn: testGetStatusAfterStart },
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
    console.error(`\n❌ ${failures.length}/${tests.length} Phase E discovery-service tests FAILED:`);
    for (const f of failures) {
      console.error(`  - ${f.name}`);
    }
    throw failures[0].error;
  }

  console.log(`\n✅ All ${tests.length} Phase E discovery-service tests passed!`);
}

runAllTests();