/**
 * Phase L: CycleRunner — unit tests + full integration test.
 *
 * Unit tests verify routing logic (CONFIRM gate, failure handling, depth skips).
 * Integration test runs the full DESIGN→SNAPSHOT cycle with real services and
 * a node-aware mock LLM, proving the complete VS2 slice end-to-end.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

import { CycleRunner } from '../src/cycle-runner.js';
import { DAGRunner, nextNode } from '../src/dag-runner.js';
import { AgentRunner } from '../src/agent-runner.js';
import { ContextManager } from '../src/context-manager.js';
import { ConfirmService } from '../src/confirm-service.js';
import { ExecService, ValidationGateService } from '../src/exec-gate.js';
import { SnapshotService } from '../src/snapshot-service.js';
import { RunArtifactManager } from '../src/run-artifacts.js';
import { RuntimeMapManagerImpl } from '../src/runtime-map.js';
import { CycleService } from '../src/cycle-service.js';
import { StateMachine } from '../src/state-machine.js';
import { InitService } from '../src/init-service.js';
import type { RuntimeMap, RuntimeMapManager } from '../src/runtime-map.js';
import type { ManifestNodeEntry } from '../src/run-artifacts.js';
import type { CycleStateContext } from '../src/context-manager.js';
import type { ILLMProvider, LLMCompletionParams, LLMCompletionResult } from '../src/llm-provider.js';
import type { AgentRunResult } from '../src/agent-runner.js';

console.log('# Running Phase L (CycleRunner + Integration) tests...');

// ─── Mock primitives (unit tests) ─────────────────────────────────────────────

function makeBaseMap(): RuntimeMap {
  return {
    meta: {
      status: 'cycling', cycle: 1,
      version_id: 'v1', initialized_at: '2026-05-08T12:00:00Z', updated_at: '2026-05-08T12:00:00Z',
      dag: { current_node: null, completed_nodes: [], iteration: 1, revision: 0, started_at: '2026-05-08T14:00:00Z', nodes: {} },
    },
    project: { name: 'test', description: 'test', type: 'api' },
    remotes: {
      code: { type: 'git', url: 'https://github.com/org/repo.git', branch: 'main' },
      issues: { type: 'git', url: 'https://github.com/org/issues.git', branch: 'main' },
      docs: { url: 'https://github.com/org/docs.git', pending: false },
    },
    task_store: { type: 'local' }, agents: {},
    discovery: {
      status: 'complete', mode: 'full', completed_at: '2026-05-08T13:00:00Z',
      artifacts: [], current_round: 0, total_rounds: 1,
      current_phase: 0, total_phases: 0, open_questions_count: 0, blocking_questions_count: 0,
    },
    cycle: {
      number: 1, iteration: 1, revision: 0, max_iterations: 5,
      planning_depth: 'standard', started_at: '2026-05-08T14:00:00Z',
      outcome: 'cycling', approval_gate: null,
      awaiting_scoping: false, awaiting_confirmation: false, awaiting_sharding_approval: false,
    },
    artifacts: [],
  } as unknown as RuntimeMap;
}

class InMemoryMapManager implements RuntimeMapManager {
  public map: RuntimeMap;
  constructor(initial?: RuntimeMap) { this.map = JSON.parse(JSON.stringify(initial ?? makeBaseMap())); }
  async read(): Promise<RuntimeMap> { return JSON.parse(JSON.stringify(this.map)); }
  async update(fn: (m: RuntimeMap) => RuntimeMap): Promise<void> {
    this.map = JSON.parse(JSON.stringify(fn(JSON.parse(JSON.stringify(this.map)))));
  }
  async write(m: RuntimeMap): Promise<void> { this.map = JSON.parse(JSON.stringify(m)); }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

// Tracks which nodes the DAGRunner mock was called with
class MockDAGRunner {
  public calls: string[] = [];
  private failOn: string | null;

  constructor(failOn?: string) { this.failOn = failOn ?? null; }

  async runNode(
    nodeId: string,
    _state: CycleStateContext
  ): Promise<AgentRunResult & { next_node: string | null }> {
    this.calls.push(nodeId);
    if (nodeId === this.failOn) {
      return {
        success: false, next_node: null, artifacts_written: [],
        tokens_used: 0, duration_ms: 0, raw_output_path: '',
        error: `${nodeId} failed`,
      };
    }
    return {
      success: true, next_node: nextNode(nodeId), artifacts_written: [],
      tokens_used: 10, duration_ms: 50, raw_output_path: '',
    };
  }

  async skipNode(nodeId: string): Promise<void> { this.calls.push(`skip:${nodeId}`); }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

class MockConfirmService {
  public gateCalls = 0;
  async gate(): Promise<void> { this.gateCalls++; }
  async approve() { return { approved: true, next_node: 'BUILD' as const }; }
  async revise() { return { revision_count: 1, next_node: 'PLAN' as const }; }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

class MockExecService {
  async run() {
    return { success: true, passed: true, next_node: 'VALIDATION_GATE' as const, duration_ms: 0 };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

class MockValidationGateService {
  constructor(private pass = true) {}
  async run() {
    if (this.pass) return { passed: true, next_node: 'EVALUATE' as const, failed_nodes: [] };
    return {
      passed: false, next_node: null as null, failed_nodes: ['BUILD'],
      failure_report: {
        cycle: 1, iteration: 1, run_dir: '.sle/runs/1-1',
        run_id: 'c1', quick_summary: 'BUILD failed', failed_categories: ['BUILD'],
        passed_categories: ['EXEC'],
      },
    };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

class MockSnapshotService {
  public ran = false;
  async run() {
    this.ran = true;
    return { success: true, snapshot_dir: '/tmp/snap/1-1', snapshot_id: 'snap-id', artifacts_copied: [] };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

class MockRunArtifactsForRunner {
  async readManifest() {
    return { cycle_id: 'test-cycle-1', cycle_number: 1, iteration: 1, planning_depth: 'standard', started_at: '', outcome: 'in_progress' as const, nodes: [] };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

function makeRunner(overrides: Partial<{
  dagRunner: MockDAGRunner;
  confirmService: MockConfirmService;
  execService: MockExecService;
  validationGateService: MockValidationGateService;
  snapshotService: MockSnapshotService;
  mapManager: InMemoryMapManager;
}> = {}) {
  const mgr = overrides.mapManager ?? new InMemoryMapManager();
  return {
    runner: new CycleRunner({
      dagRunner: (overrides.dagRunner ?? new MockDAGRunner()) as never,
      confirmService: (overrides.confirmService ?? new MockConfirmService()) as never,
      execService: (overrides.execService ?? new MockExecService()) as never,
      validationGateService: (overrides.validationGateService ?? new MockValidationGateService()) as never,
      snapshotService: (overrides.snapshotService ?? new MockSnapshotService()) as never,
      mapManager: mgr,
      runArtifacts: new MockRunArtifactsForRunner() as never,
    }),
    mgr,
  };
}

// ─── Unit tests ───────────────────────────────────────────────────────────────

test('CycleRunner: full happy path completes DESIGN→SNAPSHOT', async () => {
  const dagRunner = new MockDAGRunner();
  const snapshot = new MockSnapshotService();
  const { runner } = makeRunner({ dagRunner, snapshotService: snapshot });

  const result = await runner.run({ onConfirmGate: async () => 'approve' });

  assert.strictEqual(result.completed, true);
  assert.strictEqual(result.final_node, null);
  assert.ok(snapshot.ran, 'snapshot should have run');
});

test('CycleRunner: LLM nodes called in correct order', async () => {
  const dagRunner = new MockDAGRunner();
  const { runner } = makeRunner({ dagRunner });

  await runner.run({ onConfirmGate: async () => 'approve' });

  // After null start → DESIGN, should go DESIGN→PLAN→TEST→(CONFIRM auto-approve)→BUILD→HISTORY→(EXEC)→(VALIDATION_GATE)→EVALUATE→SUMMARISE→(SNAPSHOT)
  const llmNodes = dagRunner.calls.filter(c => !c.startsWith('skip:'));
  assert.deepStrictEqual(
    llmNodes,
    ['DESIGN', 'PLAN', 'TEST', 'BUILD', 'HISTORY', 'EVALUATE', 'SUMMARISE']
  );
});

test('CycleRunner: CONFIRM gate is called', async () => {
  const confirmService = new MockConfirmService();
  const { runner } = makeRunner({ confirmService });

  await runner.run({ onConfirmGate: async () => 'approve' });

  assert.strictEqual(confirmService.gateCalls, 1);
});

test('CycleRunner: CONFIRM halt stops the cycle', async () => {
  const { runner } = makeRunner();

  const result = await runner.run({ onConfirmGate: async () => 'halt' });

  assert.strictEqual(result.completed, false);
  assert.strictEqual(result.final_node, 'CONFIRM');
});

test('CycleRunner: CONFIRM revise sends back to PLAN', async () => {
  const dagRunner = new MockDAGRunner();
  const confirmService = new MockConfirmService();
  let callCount = 0;
  const { runner } = makeRunner({ dagRunner, confirmService });

  // Revise once, then approve
  const result = await runner.run({
    onConfirmGate: async () => {
      callCount++;
      return callCount === 1 ? 'revise' : 'approve';
    },
  });

  assert.strictEqual(result.completed, true);
  assert.strictEqual(confirmService.gateCalls, 2, 'gate called twice (revise + approve pass)');
  // PLAN should appear twice in dagRunner calls
  const planCalls = dagRunner.calls.filter(c => c === 'PLAN');
  assert.strictEqual(planCalls.length, 2);
});

test('CycleRunner: LLM node failure returns completed=false', async () => {
  const dagRunner = new MockDAGRunner('PLAN');
  const { runner } = makeRunner({ dagRunner });

  const result = await runner.run({ onConfirmGate: async () => 'approve' });

  assert.strictEqual(result.completed, false);
  assert.strictEqual(result.final_node, 'PLAN');
  assert.ok(result.error?.includes('PLAN failed'));
});

test('CycleRunner: validation gate failure returns completed=false with report', async () => {
  const validationGateService = new MockValidationGateService(false);
  const { runner } = makeRunner({ validationGateService });

  const result = await runner.run({ onConfirmGate: async () => 'approve' });

  assert.strictEqual(result.completed, false);
  assert.strictEqual(result.final_node, 'VALIDATION_GATE');
  assert.ok(result.failure_report, 'failure_report should be present');
  assert.ok(result.failure_report!.failed_categories.includes('BUILD'));
});

test('CycleRunner: snapshot_dir returned on success', async () => {
  const { runner } = makeRunner();

  const result = await runner.run({ onConfirmGate: async () => 'approve' });

  assert.strictEqual(result.snapshot_dir, '/tmp/snap/1-1');
});

test('CycleRunner: SCOPING skipped when dag starts at SCOPING', async () => {
  const base = makeBaseMap();
  (base.meta as Record<string, unknown>).dag = { current_node: 'SCOPING', completed_nodes: [] };
  const dagRunner = new MockDAGRunner();
  const mgr = new InMemoryMapManager(base);
  const { runner } = makeRunner({ dagRunner, mapManager: mgr });

  const result = await runner.run({ onConfirmGate: async () => 'approve' });

  assert.strictEqual(result.completed, true);
  // SCOPING should NOT appear in dagRunner calls (it's skipped silently)
  assert.ok(!dagRunner.calls.includes('SCOPING'));
  // DESIGN should be the first LLM node called
  assert.strictEqual(dagRunner.calls[0], 'DESIGN');
});

// ─── Integration test setup ───────────────────────────────────────────────────

// Mock LLM that returns valid SLE-OUTPUT per DAG node, detected from state summary
class NodeAwareMockLLM implements ILLMProvider {
  private static readonly outputs: Record<string, string> = {
    DESIGN: [
      '<!-- SLE-OUTPUT',
      'role: designer',
      'node: DESIGN',
      'artifacts:',
      '  - id: requirements',
      '    path: docs/requirements.md',
      '  - id: architecture',
      '    path: docs/architecture.md',
      '-->',
      '',
      '## docs/requirements.md',
      '',
      '# Requirements',
      '',
      'Build a task manager REST API.',
      '',
      '---',
      '',
      '## docs/architecture.md',
      '',
      '# Architecture',
      '',
      'Express.js REST API.',
    ].join('\n'),

    PLAN: [
      '<!-- SLE-OUTPUT',
      'role: planner',
      'node: PLAN',
      'artifacts:',
      '  - id: plan',
      '    path: docs/plan.md',
      '  - id: test-plan',
      '    path: docs/test-plan.md',
      '-->',
      '',
      '## docs/plan.md',
      '',
      '# Plan',
      '',
      'Step 1: Setup project.',
      '',
      '---',
      '',
      '## docs/test-plan.md',
      '',
      '# Test Plan',
      '',
      'Test GET /tasks.',
    ].join('\n'),

    TEST: [
      '<!-- SLE-OUTPUT',
      'role: tester',
      'node: TEST',
      'artifacts:',
      '  - id: test-plan',
      '    path: docs/test-plan.md',
      '-->',
      '',
      '## docs/test-plan.md',
      '',
      '# Test Plan (revised)',
      '',
      'GET /tasks returns array.',
    ].join('\n'),

    BUILD: [
      '<!-- SLE-OUTPUT',
      'role: builder',
      'node: BUILD',
      'artifacts:',
      '  - id: main',
      '    path: src/index.ts',
      '-->',
      '',
      '## File: src/index.ts',
      '```typescript',
      "export const app = () => 'task manager api';",
      '```',
    ].join('\n'),

    HISTORY: [
      '<!-- SLE-OUTPUT',
      'role: historian',
      'node: HISTORY',
      'artifacts:',
      '  - id: decisions',
      '    path: docs/decisions.md',
      '-->',
      '',
      '## docs/decisions.md',
      '',
      '## Decision: TypeScript',
      '',
      'Cycle 1: chose TypeScript.',
    ].join('\n'),

    EVALUATE: [
      '<!-- SLE-OUTPUT',
      'role: evaluator',
      'node: EVALUATE',
      'artifacts:',
      '  - id: criteria',
      '    path: docs/evaluation-criteria.md',
      '-->',
      '',
      '## docs/evaluation-criteria.md',
      '',
      '# Evaluation Criteria',
      '',
      'Code quality: acceptable.',
    ].join('\n'),

    SUMMARISE: [
      '<!-- SLE-OUTPUT',
      'role: historian',
      'node: SUMMARISE',
      'artifacts:',
      '  - id: cycle-summary',
      '    path: docs/cycle-summary.md',
      '-->',
      '',
      '## docs/cycle-summary.md',
      '',
      '# Cycle 1 Summary',
      '',
      'Task manager API implemented.',
    ].join('\n'),
  };

  async complete(params: LLMCompletionParams): Promise<LLMCompletionResult> {
    const userMsg = params.messages.find((m) => m.role === 'user')?.content ?? '';
    for (const [node, output] of Object.entries(NodeAwareMockLLM.outputs)) {
      if (userMsg.includes(`Current node: ${node}`)) {
        return { content: output, tokens_used: 50 };
      }
    }
    return { content: NodeAwareMockLLM.outputs.HISTORY, tokens_used: 50 };
  }
}

async function setupProjectDir(): Promise<string> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'sle-cycle-integration-'));
  execSync('git init', { cwd: tmpDir, stdio: 'ignore' });
  execSync('git remote add origin https://github.com/test/cycle-int-test.git', {
    cwd: tmpDir, stdio: 'ignore',
  });
  return tmpDir;
}

async function runInit(root: string): Promise<void> {
  const svc = new InitService({ projectRoot: root });
  const result = await svc.init({
    project_name: 'cycle-integration-test',
    project_type: 'api',
    task_store: 'local',
    daemon_port: 7700,
    docs_remote: null,
    non_interactive: true,
    no_editor: true,
  });
  assert.strictEqual((result as { ok: boolean }).ok, true, 'init must succeed');
}

// ─── Integration test ─────────────────────────────────────────────────────────

test('Integration: full cycle DESIGN→SNAPSHOT with mock LLM', async () => {
  const root = await setupProjectDir();
  try {
    // 1. Init project
    await runInit(root);

    // 2. Wire up real services
    const mapPath = join(root, '.sle', 'map.yaml');
    const mapManager = new RuntimeMapManagerImpl({ mapPath });
    const stateMachine = new StateMachine(mapManager);
    const runArtifacts = new RunArtifactManager({ projectRoot: root });
    const cycleService = new CycleService(stateMachine, mapManager, runArtifacts);

    // 3. Start cycle (force=true bypasses discovery requirement)
    const cycleRecord = await cycleService.start({
      intent: 'Build a task manager REST API',
      force: true,
    });
    assert.ok(cycleRecord.cycle_number > 0, 'cycle should have started');
    assert.ok(cycleRecord.cycle_id, 'cycle_id should be set');

    // 4. Wire up cycle execution services
    const llm = new NodeAwareMockLLM();
    const contextManager = new ContextManager(root);
    const agentRunner = new AgentRunner(
      contextManager, llm, root, runArtifacts, { model: 'mock-model' }
    );
    const dagRunner = new DAGRunner(agentRunner, mapManager, runArtifacts);
    const confirmService = new ConfirmService(mapManager, runArtifacts);
    const execService = new ExecService(mapManager, runArtifacts);
    const validationGateService = new ValidationGateService(mapManager, runArtifacts);
    const snapshotService = new SnapshotService(mapManager, runArtifacts, root);

    const cycleRunner = new CycleRunner({
      dagRunner, confirmService, execService, validationGateService,
      snapshotService, mapManager, runArtifacts,
    });

    // 5. Run the full cycle (auto-approve CONFIRM gate)
    const result = await cycleRunner.run({
      onConfirmGate: async () => 'approve',
    });

    // 6. Assert top-level result
    assert.strictEqual(result.completed, true, `cycle should complete, error: ${result.error}`);
    assert.strictEqual(result.final_node, null, 'no hanging final_node');
    assert.ok(result.snapshot_dir, 'snapshot_dir should be set');

    // 7. Assert key artifacts were written
    const reqMd = await fs.readFile(join(root, 'docs/requirements.md'), 'utf-8');
    assert.ok(reqMd.includes('Requirements'), 'requirements.md written by DESIGN');

    const planMd = await fs.readFile(join(root, 'docs/plan.md'), 'utf-8');
    assert.ok(planMd.includes('Plan'), 'plan.md written by PLAN');

    const srcIndex = await fs.readFile(join(root, 'src/index.ts'), 'utf-8');
    assert.ok(srcIndex.includes('task manager'), 'src/index.ts written by BUILD');

    const evalMd = await fs.readFile(join(root, 'docs/evaluation-criteria.md'), 'utf-8');
    assert.ok(evalMd.includes('Evaluation'), 'evaluation-criteria.md written by EVALUATE');

    const summaryMd = await fs.readFile(join(root, 'docs/cycle-summary.md'), 'utf-8');
    assert.ok(summaryMd.includes('Summary'), 'cycle-summary.md written by SUMMARISE');

    // 8. Assert snapshot exists with metadata
    const snapJson = await fs.readFile(join(result.snapshot_dir!, 'snapshot.json'), 'utf-8');
    const snapMeta = JSON.parse(snapJson) as { snapshot_id: string; cycle: number; artifacts: string[] };
    assert.ok(snapMeta.snapshot_id, 'snapshot.json has snapshot_id');
    assert.strictEqual(snapMeta.cycle, 1);

    // 9. Assert manifest finalized as complete
    const manifest = await runArtifacts.readManifest(
      cycleRecord.cycle_number,
      1
    );
    assert.strictEqual(manifest.outcome, 'complete', 'manifest should be finalized as complete');

    // 10. Assert dag completed_nodes includes all expected nodes
    const finalMap = await mapManager.read();
    const dag = (finalMap.meta as Record<string, unknown> & { dag?: { completed_nodes: string[] } }).dag;
    const expected = ['DESIGN', 'PLAN', 'TEST', 'BUILD', 'HISTORY', 'EXEC', 'VALIDATION_GATE', 'EVALUATE', 'SUMMARISE', 'SNAPSHOT'];
    for (const node of expected) {
      assert.ok(
        dag?.completed_nodes.includes(node),
        `${node} should be in completed_nodes`
      );
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

console.log('# ✅ All Phase L tests passed!');
