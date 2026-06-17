import { strict as assert } from 'assert';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import { promises as fs } from 'fs';
import { join } from 'path';
import { ScopingService } from '../src/scoping-service.js';
import type { AgentRunner, AgentRunResult } from '../src/agent-runner.js';
import type { CycleStateContext } from '../src/context-manager.js';
import type { RuntimeMap, RuntimeMapManager } from '../src/runtime-map.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'sle-scoping-test-'));
}

function makeCycleState(overrides: Partial<CycleStateContext> = {}): CycleStateContext {
  return {
    cycle_number: 1,
    iteration: 1,
    planning_depth: 'standard',
    intent: 'Build a widget system',
    current_node: 'SCOPING',
    ...overrides,
  };
}

// ─── Mock AgentRunner ─────────────────────────────────────────────────────────

class MockAgentRunner implements AgentRunner {
  public calls: Array<{ node: string; state: CycleStateContext }> = [];

  constructor(
    private result: AgentRunResult | Error,
    private charterContent?: string
  ) {}

  async run(node: string, state: CycleStateContext): Promise<AgentRunResult> {
    this.calls.push({ node, state });
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

// ─── In-memory RuntimeMapManager ─────────────────────────────────────────────

function makeBaseMap(): RuntimeMap {
  return {
    meta: {
      status: 'cycling',
      cycle: 1,
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
      status: 'complete',
      mode: 'full',
      completed_at: '2026-05-08T13:00:00Z',
      artifacts: [],
      current_round: 0,
      total_rounds: 1,
      current_phase: 0,
      total_phases: 0,
      open_questions_count: 0,
      blocking_questions_count: 0,
    },
    cycle: {
      number: 1,
      iteration: 1,
      revision: 0,
      max_iterations: 5,
      planning_depth: 'standard',
      started_at: '2026-05-08T14:00:00Z',
      outcome: 'cycling',
      approval_gate: null,
      awaiting_scoping: false,
      awaiting_confirmation: false,
      awaiting_sharding_approval: false,
    },
  };
}

class InMemoryMapManager implements RuntimeMapManager {
  public map: RuntimeMap;

  constructor(initial?: RuntimeMap) {
    this.map = JSON.parse(JSON.stringify(initial ?? makeBaseMap()));
  }

  async read(): Promise<RuntimeMap> { return JSON.parse(JSON.stringify(this.map)); }
  async update(fn: (m: RuntimeMap) => RuntimeMap): Promise<void> {
    this.map = JSON.parse(JSON.stringify(fn(JSON.parse(JSON.stringify(this.map)))));
  }
  async write(m: RuntimeMap): Promise<void> { this.map = JSON.parse(JSON.stringify(m)); }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

// ─── FS mock ──────────────────────────────────────────────────────────────────

function makeFsMock(files: Record<string, string> = {}): {
  mock: typeof import('fs').promises;
  written: Record<string, string>;
} {
  const written: Record<string, string> = { ...files };
  const mock = {
    readFile: async (p: unknown) => {
      const key = p as string;
      if (key in written) return written[key];
      throw Object.assign(new Error(`ENOENT: ${key}`), { code: 'ENOENT' });
    },
  } as unknown as typeof import('fs').promises;
  return { mock, written };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

async function testBeginCallsAgentRunnerWithScopingNode() {
  const root = makeTempDir();
  const charterContent = '# Cycle Charter: 1\n\n## Intent\nBuild a widget system';
  const charterPath = join(root, 'docs', 'cycle-charter.md');
  await fs.mkdir(join(root, 'docs'), { recursive: true });
  await fs.writeFile(charterPath, charterContent, 'utf-8');

  const runResult: AgentRunResult = {
    success: true,
    artifacts_written: ['docs/cycle-charter.md'],
    tokens_used: 150,
    duration_ms: 200,
    raw_output_path: join(root, '.sle/runs/1-1/node-outputs/scoping.md'),
  };
  const runner = new MockAgentRunner(runResult);
  const mgr = new InMemoryMapManager();

  const svc = new ScopingService(runner, mgr, root);
  const result = await svc.begin(1, 1, makeCycleState());

  assert.strictEqual(runner.calls.length, 1);
  assert.strictEqual(runner.calls[0].node, 'SCOPING');
  assert.strictEqual(runner.calls[0].state.current_node, 'SCOPING');
  assert.strictEqual(result.awaiting_scoping, true);
  assert.strictEqual(result.charter_path, 'docs/cycle-charter.md');
}

async function testBeginForcesCurrentNodeToScoping() {
  const root = makeTempDir();
  const charterPath = join(root, 'docs', 'cycle-charter.md');
  await fs.mkdir(join(root, 'docs'), { recursive: true });
  await fs.writeFile(charterPath, '# Charter', 'utf-8');

  const runner = new MockAgentRunner({
    success: true, artifacts_written: ['docs/cycle-charter.md'],
    tokens_used: 10, duration_ms: 5, raw_output_path: '',
  });
  const mgr = new InMemoryMapManager();
  const svc = new ScopingService(runner, mgr, root);

  await svc.begin(1, 1, makeCycleState({ current_node: 'DESIGN' }));

  // Even if cycleState had DESIGN, begin should override to SCOPING
  assert.strictEqual(runner.calls[0].state.current_node, 'SCOPING');
}

async function testBeginSetsAwaitingScopingTrueInMap() {
  const root = makeTempDir();
  await fs.mkdir(join(root, 'docs'), { recursive: true });
  await fs.writeFile(join(root, 'docs', 'cycle-charter.md'), '# Charter', 'utf-8');

  const runner = new MockAgentRunner({
    success: true, artifacts_written: ['docs/cycle-charter.md'],
    tokens_used: 10, duration_ms: 5, raw_output_path: '',
  });
  const mgr = new InMemoryMapManager();
  assert.strictEqual(mgr.map.cycle.awaiting_scoping, false);

  const svc = new ScopingService(runner, mgr, root);
  await svc.begin(1, 1, makeCycleState());

  assert.strictEqual(mgr.map.cycle.awaiting_scoping, true);
}

async function testBeginThrowsWhenAgentRunnerFails() {
  const root = makeTempDir();
  const runner = new MockAgentRunner({
    success: false,
    artifacts_written: [],
    tokens_used: 0,
    duration_ms: 10,
    raw_output_path: '',
    error: 'LLM call failed',
  });
  const mgr = new InMemoryMapManager();
  const svc = new ScopingService(runner, mgr, root);

  await assert.rejects(
    () => svc.begin(1, 1, makeCycleState()),
    /SCOPING node failed/
  );
}

async function testGetDraftReadsCharterFromDisk() {
  const root = makeTempDir();
  await fs.mkdir(join(root, 'docs'), { recursive: true });
  const expected = '# Cycle Charter\n\n## Intent\nBuild a widget';
  await fs.writeFile(join(root, 'docs', 'cycle-charter.md'), expected, 'utf-8');

  const mgr = new InMemoryMapManager();
  const runner = new MockAgentRunner({ success: true, artifacts_written: [], tokens_used: 0, duration_ms: 0, raw_output_path: '' });
  const svc = new ScopingService(runner, mgr, root);

  const draft = await svc.getDraft();
  assert.strictEqual(draft, expected);
}

async function testGetDraftReturnsNullWhenFileAbsent() {
  const root = makeTempDir();
  const mgr = new InMemoryMapManager();
  const runner = new MockAgentRunner({ success: true, artifacts_written: [], tokens_used: 0, duration_ms: 0, raw_output_path: '' });
  const svc = new ScopingService(runner, mgr, root);

  const draft = await svc.getDraft();
  assert.strictEqual(draft, null);
}

async function testSubmitResponseStoresPendingResponse() {
  const root = makeTempDir();
  const mgr = new InMemoryMapManager();
  const runner = new MockAgentRunner({ success: true, artifacts_written: [], tokens_used: 0, duration_ms: 0, raw_output_path: '' });
  const svc = new ScopingService(runner, mgr, root);

  assert.strictEqual(svc.getPendingResponse(), null);
  await svc.submitResponse('Feature A should be async.');
  assert.strictEqual(svc.getPendingResponse(), 'Feature A should be async.');
}

async function testApproveClearsAwaitingScopingFlag() {
  const root = makeTempDir();
  await fs.mkdir(join(root, 'docs'), { recursive: true });
  await fs.writeFile(
    join(root, 'docs', 'cycle-charter.md'),
    '# Charter\n\n## Scope\nWidgets.\n\n## Purpose\nShip widgets.',
    'utf-8'
  );

  const mgr = new InMemoryMapManager();
  mgr.map.cycle.awaiting_scoping = true;

  const runner = new MockAgentRunner({ success: true, artifacts_written: [], tokens_used: 0, duration_ms: 0, raw_output_path: '' });
  const svc = new ScopingService(runner, mgr, root);

  const result = await svc.approve(1, 1);

  assert.strictEqual(result.awaiting_scoping, false);
  assert.strictEqual(result.charter_path, 'docs/cycle-charter.md');
  assert.strictEqual(mgr.map.cycle.awaiting_scoping, false);
}

async function testApproveThrowsWhenNoDraftExists() {
  const root = makeTempDir();
  const mgr = new InMemoryMapManager();
  const runner = new MockAgentRunner({ success: true, artifacts_written: [], tokens_used: 0, duration_ms: 0, raw_output_path: '' });
  const svc = new ScopingService(runner, mgr, root);

  await assert.rejects(
    () => svc.approve(1, 1),
    /No scoping draft available/
  );
}

async function testApproveClearsPendingResponse() {
  const root = makeTempDir();
  await fs.mkdir(join(root, 'docs'), { recursive: true });
  await fs.writeFile(
    join(root, 'docs', 'cycle-charter.md'),
    '# Charter\n\n## Scope\nWidgets.\n\n## Purpose\nShip widgets.',
    'utf-8'
  );

  const mgr = new InMemoryMapManager();
  const runner = new MockAgentRunner({ success: true, artifacts_written: [], tokens_used: 0, duration_ms: 0, raw_output_path: '' });
  const svc = new ScopingService(runner, mgr, root);

  await svc.submitResponse('Some user answers');
  assert.strictEqual(svc.getPendingResponse(), 'Some user answers');

  await svc.approve(1, 1);
  assert.strictEqual(svc.getPendingResponse(), null);
}

async function testFullScopingLifecycle() {
  const root = makeTempDir();
  await fs.mkdir(join(root, 'docs'), { recursive: true });
  const charterContent = `# Cycle Charter: 1

## Intent
Build a widget system

## Scope
Widgets only — no admin UI in this cycle.

## Purpose
Ship a working widget CRUD flow.

## Success criteria
All widget CRUD operations working.`;
  await fs.writeFile(join(root, 'docs', 'cycle-charter.md'), charterContent, 'utf-8');

  const runner = new MockAgentRunner({
    success: true,
    artifacts_written: ['docs/cycle-charter.md'],
    tokens_used: 300,
    duration_ms: 1500,
    raw_output_path: join(root, '.sle/runs/1-1/node-outputs/scoping.md'),
  });
  const mgr = new InMemoryMapManager();
  const svc = new ScopingService(runner, mgr, root);

  // 1. Begin scoping
  const beginResult = await svc.begin(1, 1, makeCycleState());
  assert.strictEqual(beginResult.awaiting_scoping, true);
  assert.ok(beginResult.draft.includes('Cycle Charter'));
  assert.strictEqual(mgr.map.cycle.awaiting_scoping, true);

  // 2. Get draft
  const draft = await svc.getDraft();
  assert.ok(draft?.includes('widget system'));

  // 3. Submit response (optional)
  await svc.submitResponse('Please include error handling.');
  assert.strictEqual(svc.getPendingResponse(), 'Please include error handling.');

  // 4. Approve
  const approveResult = await svc.approve(1, 1);
  assert.strictEqual(approveResult.awaiting_scoping, false);
  assert.strictEqual(mgr.map.cycle.awaiting_scoping, false);
  assert.strictEqual(svc.getPendingResponse(), null);
}

async function testApproveThrowsWhenCharterMissingSections() {
  const root = makeTempDir();
  await fs.mkdir(join(root, 'docs'), { recursive: true });
  await fs.writeFile(join(root, 'docs', 'cycle-charter.md'), '# Charter\n\nSome unstructured text.', 'utf-8');

  const mgr = new InMemoryMapManager();
  const runner = new MockAgentRunner({ success: true, artifacts_written: [], tokens_used: 0, duration_ms: 0, raw_output_path: '' });
  const svc = new ScopingService(runner, mgr, root);

  await assert.rejects(
    () => svc.approve(1, 1),
    /Scope and\/or Purpose/
  );
}

async function testProcessResponseIncrementsRoundCount() {
  const root = makeTempDir();
  const mgr = new InMemoryMapManager();
  const runner = new MockAgentRunner({ success: true, artifacts_written: [], tokens_used: 0, duration_ms: 0, raw_output_path: '' });
  const svc = new ScopingService(runner, mgr, root);

  assert.strictEqual(svc.getRoundCount(), 0);
  await svc.processResponse('Round 1 answer', makeCycleState());
  assert.strictEqual(svc.getRoundCount(), 1);
  await svc.processResponse('Round 2 answer', makeCycleState());
  assert.strictEqual(svc.getRoundCount(), 2);
}

async function testProcessResponseThrowsWhenMaxRoundsExceeded() {
  const root = makeTempDir();
  await fs.mkdir(join(root, '.sle', 'rules'), { recursive: true });
  await fs.writeFile(join(root, '.sle', 'rules', 'planning.yaml'), 'scoping:\n  max_rounds: 2\n', 'utf-8');

  const mgr = new InMemoryMapManager();
  const runner = new MockAgentRunner({ success: true, artifacts_written: [], tokens_used: 0, duration_ms: 0, raw_output_path: '' });
  const svc = new ScopingService(runner, mgr, root);

  await svc.processResponse('Round 1', makeCycleState());
  await svc.processResponse('Round 2', makeCycleState());

  await assert.rejects(
    () => svc.processResponse('Round 3', makeCycleState()),
    /max rounds/
  );
}

async function testSubmitResponseWithCycleStateRunsFacilitator() {
  const root = makeTempDir();
  const mgr = new InMemoryMapManager();
  const runner = new MockAgentRunner({ success: true, artifacts_written: [], tokens_used: 0, duration_ms: 0, raw_output_path: '' });
  const svc = new ScopingService(runner, mgr, root);

  await svc.submitResponse('Add auth.', 1, 1, makeCycleState());

  assert.strictEqual(runner.calls.length, 1);
  assert.strictEqual(runner.calls[0].node, 'SCOPING');
  assert.strictEqual(runner.calls[0].state.ephemeral?.scoping_response, 'Add auth.');
}

// ─── Runner ──────────────────────────────────────────────────────────────────

async function runAllTests() {
  console.log('Running Phase E (Scoping Service) tests...\n');

  const tests: Array<{ name: string; fn: () => Promise<void> }> = [
    { name: 'begin: calls AgentRunner with SCOPING node', fn: testBeginCallsAgentRunnerWithScopingNode },
    { name: 'begin: forces current_node to SCOPING', fn: testBeginForcesCurrentNodeToScoping },
    { name: 'begin: sets awaiting_scoping=true in map', fn: testBeginSetsAwaitingScopingTrueInMap },
    { name: 'begin: throws when AgentRunner fails', fn: testBeginThrowsWhenAgentRunnerFails },
    { name: 'getDraft: reads charter from disk', fn: testGetDraftReadsCharterFromDisk },
    { name: 'getDraft: returns null when file absent', fn: testGetDraftReturnsNullWhenFileAbsent },
    { name: 'submitResponse: stores pending response', fn: testSubmitResponseStoresPendingResponse },
    { name: 'approve: clears awaiting_scoping flag', fn: testApproveClearsAwaitingScopingFlag },
    { name: 'approve: throws when no draft exists', fn: testApproveThrowsWhenNoDraftExists },
    { name: 'approve: clears pending response', fn: testApproveClearsPendingResponse },
    { name: 'approve: throws when charter missing Scope/Purpose sections', fn: testApproveThrowsWhenCharterMissingSections },
    { name: 'processResponse: increments round count', fn: testProcessResponseIncrementsRoundCount },
    { name: 'processResponse: throws scoping_timeout when max rounds exceeded', fn: testProcessResponseThrowsWhenMaxRoundsExceeded },
    { name: 'submitResponse: with cycleState runs facilitator with response in ephemeral context', fn: testSubmitResponseWithCycleStateRunsFacilitator },
    { name: 'full scoping lifecycle: begin → getDraft → response → approve', fn: testFullScopingLifecycle },
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
    console.error(`\n❌ ${failures.length}/${tests.length} Phase E tests FAILED:`);
    for (const f of failures) {
      console.error(`  - ${f.name}`);
      console.error(`    ${f.error instanceof Error ? f.error.message : String(f.error)}`);
    }
    throw failures[0].error;
  }

  console.log(`\n✅ All ${tests.length} Phase E tests passed!`);
}

runAllTests();
