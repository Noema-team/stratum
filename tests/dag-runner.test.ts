import { strict as assert } from 'assert';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import { promises as fs } from 'fs';
import { join } from 'path';
import {
  DAGRunner,
  DAG_SEQUENCE,
  nextNode,
  shouldSkipAtDepth,
  updateArtifactEntries,
} from '../src/dag-runner.js';
import { validateOutputPath } from '../src/agent-runner.js';
import type { AgentRunner, AgentRunResult, DAGNodeId } from '../src/agent-runner.js';
import type { CycleStateContext } from '../src/context-manager.js';
import type { RuntimeMap, RuntimeMapManager } from '../src/runtime-map.js';
import type { RunArtifactManager, RunManifest } from '../src/run-artifacts.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'sle-dag-test-'));
}

function makeBaseMap(overrides: Partial<RuntimeMap['meta']> = {}): RuntimeMap {
  return {
    meta: {
      status: 'cycling',
      cycle: 1,
      version_id: '123e4567-e89b-12d3-a456-426614174000',
      initialized_at: '2026-05-08T12:00:00Z',
      updated_at: '2026-05-08T12:00:00Z',
      dag: {
        current_node: null,
        completed_nodes: [],
        iteration: 1,
        revision: 0,
        started_at: '2026-05-08T14:00:00Z',
        nodes: {
          SCOPING: { status: 'complete' },
          DESIGN: { status: 'pending' },
          PLAN: { status: 'pending' },
        },
      },
      ...overrides,
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
      status: 'complete', mode: 'full', completed_at: '2026-05-08T13:00:00Z',
      artifacts: [], current_round: 0, total_rounds: 1,
      current_phase: 0, total_phases: 0,
      open_questions_count: 0, blocking_questions_count: 0,
    },
    cycle: {
      number: 1, iteration: 1, revision: 0, max_iterations: 5,
      planning_depth: 'standard', started_at: '2026-05-08T14:00:00Z',
      outcome: 'cycling', approval_gate: null,
      awaiting_scoping: false, awaiting_confirmation: false, awaiting_sharding_approval: false,
    },
    artifacts: [],
    chat: { session_open: false },
    validation: { categories: [], gate: { mode: 'all_must_pass', last_outcome: 'passed', failed_categories: [] } },
  } as RuntimeMap;
}

// ─── In-memory mocks ──────────────────────────────────────────────────────────

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

class InMemoryRunArtifactManager implements RunArtifactManager {
  public nodeStatuses: Record<string, Record<string, unknown>> = {};
  public nodeOutputs: Record<string, string> = {};

  async updateNodeStatus(_cn: number, _it: number, nodeId: string, update: Record<string, unknown>): Promise<void> {
    this.nodeStatuses[nodeId] = { ...(this.nodeStatuses[nodeId] ?? {}), ...update };
  }
  async writeNodeOutput(_cn: number, _it: number, nodeId: string, content: string): Promise<void> {
    this.nodeOutputs[nodeId] = content;
  }
  // Stubs for unused methods
  async createRunDir() { return ''; }
  async createManifest() {}
  async readManifest(_cn: number, _it: number): Promise<RunManifest> {
    return { cycle_id: 'test', cycle_number: 1, iteration: 1, planning_depth: 'standard', started_at: '', outcome: 'in_progress', nodes: [] };
  }
  async updateManifest() {}
  async finalizeManifest() {}
  async writeContextPack() {}
  async readContextPack() { return {}; }
  async dirExists() { return false; }
  runDir() { return ''; }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

class MockAgentRunner implements AgentRunner {
  public calls: Array<{ node: string; state: CycleStateContext }> = [];
  constructor(private result: AgentRunResult | Error) {}
  async run(node: string, state: CycleStateContext): Promise<AgentRunResult> {
    this.calls.push({ node, state });
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

function makeCycleState(overrides: Partial<CycleStateContext> = {}): CycleStateContext {
  return {
    cycle_number: 1, iteration: 1, planning_depth: 'standard',
    intent: 'Build a widget system', current_node: 'DESIGN', ...overrides,
  };
}

// ─── validateOutputPath tests ─────────────────────────────────────────────────

async function testDesignerAllowedPaths() {
  assert.strictEqual(validateOutputPath('docs/requirements.md', 'designer'), true);
  assert.strictEqual(validateOutputPath('docs/architecture.md', 'designer'), true);
}

async function testDesignerRejectedPaths() {
  assert.strictEqual(validateOutputPath('docs/plan.md', 'designer'), false);
  assert.strictEqual(validateOutputPath('src/index.ts', 'designer'), false);
  assert.strictEqual(validateOutputPath('docs/decisions.md', 'designer'), false);
}

async function testPlannerAllowedPaths() {
  assert.strictEqual(validateOutputPath('docs/plan.md', 'planner'), true);
  assert.strictEqual(validateOutputPath('docs/test-plan.md', 'planner'), true);
}

async function testPlannerCannotWriteRequirements() {
  assert.strictEqual(validateOutputPath('docs/requirements.md', 'planner'), false);
  assert.strictEqual(validateOutputPath('docs/architecture.md', 'planner'), false);
}

async function testBuilderAllowsSrcDeniesDocsAndSle() {
  assert.strictEqual(validateOutputPath('src/controller.ts', 'builder'), true);
  assert.strictEqual(validateOutputPath('src/deep/nested/file.ts', 'builder'), true);
  assert.strictEqual(validateOutputPath('docs/anything.md', 'builder'), false);
  assert.strictEqual(validateOutputPath('.sle/map.yaml', 'builder'), false);
}

async function testFacilitatorOnlyCharterPath() {
  assert.strictEqual(validateOutputPath('docs/cycle-charter.md', 'facilitator'), true);
  assert.strictEqual(validateOutputPath('docs/requirements.md', 'facilitator'), false);
}

// ─── nextNode tests ───────────────────────────────────────────────────────────

async function testNextNodeSequence() {
  assert.strictEqual(nextNode('SCOPING'), 'DESIGN');
  assert.strictEqual(nextNode('DESIGN'), 'PLAN');
  assert.strictEqual(nextNode('PLAN'), 'TEST');
  assert.strictEqual(nextNode('SNAPSHOT'), null);
}

async function testNextNodeUnknownReturnsNull() {
  assert.strictEqual(nextNode('CRITIQUE'), null);
  assert.strictEqual(nextNode('UNKNOWN'), null);
}

// ─── shouldSkipAtDepth tests ──────────────────────────────────────────────────

async function testCritiqueSkippedAtStandard() {
  assert.strictEqual(shouldSkipAtDepth('CRITIQUE', 'standard'), true);
  assert.strictEqual(shouldSkipAtDepth('CRITIQUE', 'minimal'), true);
}

async function testCritiqueNotSkippedAtDeep() {
  assert.strictEqual(shouldSkipAtDepth('CRITIQUE', 'deep'), false);
  assert.strictEqual(shouldSkipAtDepth('CRITIQUE', 'research'), false);
}

async function testOtherNodesNotSkipped() {
  assert.strictEqual(shouldSkipAtDepth('DESIGN', 'standard'), false);
  assert.strictEqual(shouldSkipAtDepth('BUILD', 'minimal'), false);
}

// ─── DAG_SEQUENCE tests ───────────────────────────────────────────────────────

async function testDagSequenceContainsAllCoreNodes() {
  assert.ok(DAG_SEQUENCE.includes('SCOPING'));
  assert.ok(DAG_SEQUENCE.includes('DESIGN'));
  assert.ok(DAG_SEQUENCE.includes('PLAN'));
  assert.ok(DAG_SEQUENCE.includes('SNAPSHOT'));
  assert.strictEqual(DAG_SEQUENCE.length, 12);
}

async function testDagSequenceDoesNotContainCritique() {
  assert.ok(!DAG_SEQUENCE.includes('CRITIQUE'));
}

// ─── updateArtifactEntries tests ──────────────────────────────────────────────

async function testUpdateArtifactEntriesAddsNewEntries() {
  const mgr = new InMemoryMapManager();
  await updateArtifactEntries(mgr, ['docs/requirements.md', 'docs/architecture.md'], 'designer');

  const map = await mgr.read();
  assert.strictEqual(map.artifacts.length, 2);
  assert.strictEqual(map.artifacts[0].path, 'docs/requirements.md');
  assert.strictEqual(map.artifacts[0].generator, 'designer');
  assert.strictEqual(map.artifacts[0].dirty, false);
  assert.ok(typeof map.artifacts[0].last_updated === 'string');
}

async function testUpdateArtifactEntriesUpdatesExisting() {
  const mgr = new InMemoryMapManager();
  const baseMap = await mgr.read();
  baseMap.artifacts = [{ path: 'docs/requirements.md', generator: 'old-gen', required: true, last_updated: '2020-01-01T00:00:00Z', dirty: true }];
  await mgr.write(baseMap);

  await updateArtifactEntries(mgr, ['docs/requirements.md'], 'designer');

  const map = await mgr.read();
  assert.strictEqual(map.artifacts.length, 1);
  assert.strictEqual(map.artifacts[0].generator, 'designer');
  assert.strictEqual(map.artifacts[0].dirty, false);
}

async function testUpdateArtifactEntriesNoOpForEmptyPaths() {
  const mgr = new InMemoryMapManager();
  await updateArtifactEntries(mgr, [], 'designer');
  const map = await mgr.read();
  assert.strictEqual(map.artifacts.length, 0);
}

// ─── DAGRunner.runNode tests ──────────────────────────────────────────────────

async function testRunNodeDesignSuccess() {
  const root = makeTempDir();
  const lOutput = `<!-- SLE-OUTPUT
role: designer
node: DESIGN
artifacts:
  - id: requirements
    path: docs/requirements.md
  - id: architecture
    path: docs/architecture.md
-->

## docs/requirements.md

# Requirements

Feature A required.

---

## docs/architecture.md

# Architecture

Use microservices.`;

  await fs.mkdir(join(root, 'docs'), { recursive: true });

  const agentResult: AgentRunResult = {
    success: true,
    artifacts_written: ['docs/requirements.md', 'docs/architecture.md'],
    tokens_used: 250,
    duration_ms: 800,
    raw_output_path: join(root, '.sle/runs/1-1/node-outputs/design.md'),
  };
  const runner = new MockAgentRunner(agentResult);
  const mgr = new InMemoryMapManager();
  const ram = new InMemoryRunArtifactManager();
  const dagRunner = new DAGRunner(runner, mgr, ram);

  const result = await dagRunner.runNode('DESIGN', makeCycleState());

  assert.strictEqual(result.success, true, `Expected success, got: ${result.error}`);
  assert.strictEqual(result.node, 'DESIGN');
  assert.strictEqual(result.next_node, 'PLAN');
  assert.deepStrictEqual(result.artifacts_written, ['docs/requirements.md', 'docs/architecture.md']);
  assert.strictEqual(result.tokens_used, 250);
}

async function testRunNodeUpdatesManifestRunning() {
  const runner = new MockAgentRunner({
    success: true, artifacts_written: ['docs/requirements.md'],
    tokens_used: 10, duration_ms: 5, raw_output_path: '',
  });
  const mgr = new InMemoryMapManager();
  const ram = new InMemoryRunArtifactManager();
  const dagRunner = new DAGRunner(runner, mgr, ram);

  await dagRunner.runNode('DESIGN', makeCycleState());

  // Should have seen 'running' then 'complete' status updates
  assert.ok('status' in (ram.nodeStatuses['DESIGN'] ?? {}));
  assert.strictEqual(ram.nodeStatuses['DESIGN'].status, 'complete');
}

async function testRunNodeUpdatesDagCurrentNode() {
  const runner = new MockAgentRunner({
    success: true, artifacts_written: [], tokens_used: 0, duration_ms: 0, raw_output_path: '',
  });
  const mgr = new InMemoryMapManager();
  const ram = new InMemoryRunArtifactManager();
  const dagRunner = new DAGRunner(runner, mgr, ram);

  await dagRunner.runNode('DESIGN', makeCycleState());

  const map = await mgr.read();
  // After DESIGN completes, current_node should advance to PLAN
  assert.strictEqual(map.meta.dag?.current_node, 'PLAN');
  assert.ok(map.meta.dag?.completed_nodes.includes('DESIGN'));
}

async function testRunNodeUpdatesArtifactEntriesInMap() {
  const runner = new MockAgentRunner({
    success: true, artifacts_written: ['docs/requirements.md', 'docs/architecture.md'],
    tokens_used: 100, duration_ms: 500, raw_output_path: '',
  });
  const mgr = new InMemoryMapManager();
  const ram = new InMemoryRunArtifactManager();
  const dagRunner = new DAGRunner(runner, mgr, ram);

  await dagRunner.runNode('DESIGN', makeCycleState());

  const map = await mgr.read();
  assert.ok(map.artifacts.some((a) => a.path === 'docs/requirements.md' && a.generator === 'designer'));
  assert.ok(map.artifacts.some((a) => a.path === 'docs/architecture.md' && a.generator === 'designer'));
}

async function testRunNodeFailureMarkedInManifest() {
  const runner = new MockAgentRunner({
    success: false, artifacts_written: [], tokens_used: 5, duration_ms: 100, raw_output_path: '',
    error: 'Output parsing failed',
  });
  const mgr = new InMemoryMapManager();
  const ram = new InMemoryRunArtifactManager();
  const dagRunner = new DAGRunner(runner, mgr, ram);

  const result = await dagRunner.runNode('DESIGN', makeCycleState());

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.next_node, null);
  assert.ok(result.error?.includes('Output parsing failed'));
  assert.strictEqual(ram.nodeStatuses['DESIGN'].status, 'failed');
}

async function testSkipNodeIsNoOpForUnknownNode() {
  const runner = new MockAgentRunner({ success: true, artifacts_written: [], tokens_used: 0, duration_ms: 0, raw_output_path: '' });
  const mgr = new InMemoryMapManager();
  const ram = new InMemoryRunArtifactManager();
  const dagRunner = new DAGRunner(runner, mgr, ram);

  // CRITIQUE is not in manifest — skipNode should not throw
  await assert.doesNotReject(() => dagRunner.skipNode('CRITIQUE', 1, 1, 'depth'));
}

async function testCritiqueSkippedAtStandardDepthPattern() {
  // Verify the pattern: at standard depth, CRITIQUE is skipped before PLAN
  assert.strictEqual(shouldSkipAtDepth('CRITIQUE', 'standard'), true);
  // DESIGN's next in DAG_SEQUENCE is PLAN (CRITIQUE not present)
  assert.strictEqual(nextNode('DESIGN'), 'PLAN');
}

async function testWritePathValidationBlocksDesignerFromPlanPath() {
  const runner = new MockAgentRunner({
    success: false,
    artifacts_written: [],
    tokens_used: 0,
    duration_ms: 0,
    raw_output_path: '',
    error: "Role 'designer' is not permitted to write 'docs/plan.md'",
  });
  const mgr = new InMemoryMapManager();
  const ram = new InMemoryRunArtifactManager();
  const dagRunner = new DAGRunner(runner, mgr, ram);

  const result = await dagRunner.runNode('DESIGN', makeCycleState());

  assert.strictEqual(result.success, false);
  assert.ok(result.error?.includes("not permitted"));
  assert.strictEqual(result.next_node, null);
}

// ─── Runner ──────────────────────────────────────────────────────────────────

async function runAllTests() {
  console.log('Running Phase F (DAG Runner + DESIGN Node) tests...\n');

  const tests: Array<{ name: string; fn: () => Promise<void> }> = [
    { name: 'validateOutputPath: designer allowed paths', fn: testDesignerAllowedPaths },
    { name: 'validateOutputPath: designer rejected paths', fn: testDesignerRejectedPaths },
    { name: 'validateOutputPath: planner allowed paths', fn: testPlannerAllowedPaths },
    { name: 'validateOutputPath: planner cannot write requirements', fn: testPlannerCannotWriteRequirements },
    { name: 'validateOutputPath: builder allows src/, denies docs/ and .sle/', fn: testBuilderAllowsSrcDeniesDocsAndSle },
    { name: 'validateOutputPath: facilitator only charter path', fn: testFacilitatorOnlyCharterPath },
    { name: 'nextNode: full sequence', fn: testNextNodeSequence },
    { name: 'nextNode: unknown node returns null', fn: testNextNodeUnknownReturnsNull },
    { name: 'shouldSkipAtDepth: CRITIQUE skipped at standard/minimal', fn: testCritiqueSkippedAtStandard },
    { name: 'shouldSkipAtDepth: CRITIQUE not skipped at deep/research', fn: testCritiqueNotSkippedAtDeep },
    { name: 'shouldSkipAtDepth: other nodes not skipped', fn: testOtherNodesNotSkipped },
    { name: 'DAG_SEQUENCE: contains all 12 core nodes', fn: testDagSequenceContainsAllCoreNodes },
    { name: 'DAG_SEQUENCE: does not contain CRITIQUE', fn: testDagSequenceDoesNotContainCritique },
    { name: 'updateArtifactEntries: adds new entries', fn: testUpdateArtifactEntriesAddsNewEntries },
    { name: 'updateArtifactEntries: updates existing entries', fn: testUpdateArtifactEntriesUpdatesExisting },
    { name: 'updateArtifactEntries: no-op for empty paths', fn: testUpdateArtifactEntriesNoOpForEmptyPaths },
    { name: 'DAGRunner.runNode: DESIGN success → next=PLAN', fn: testRunNodeDesignSuccess },
    { name: 'DAGRunner.runNode: updates manifest running→complete', fn: testRunNodeUpdatesManifestRunning },
    { name: 'DAGRunner.runNode: advances dag current_node', fn: testRunNodeUpdatesDagCurrentNode },
    { name: 'DAGRunner.runNode: updates artifact entries in map', fn: testRunNodeUpdatesArtifactEntriesInMap },
    { name: 'DAGRunner.runNode: failure marked in manifest', fn: testRunNodeFailureMarkedInManifest },
    { name: 'DAGRunner.skipNode: no-op for CRITIQUE (not in manifest)', fn: testSkipNodeIsNoOpForUnknownNode },
    { name: 'CRITIQUE skipped at standard depth → DESIGN→PLAN', fn: testCritiqueSkippedAtStandardDepthPattern },
    { name: 'write path validation blocks designer from plan.md', fn: testWritePathValidationBlocksDesignerFromPlanPath },
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
      console.error(`    ${f.error instanceof Error ? f.error.message : String(f.error)}`);
    }
    throw failures[0].error;
  }

  console.log(`\n✅ All ${tests.length} Phase F tests passed!`);
}

runAllTests();
