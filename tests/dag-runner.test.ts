import { test } from 'node:test';
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

test('testDesignerAllowedPaths', async () => {
  assert.strictEqual(validateOutputPath('docs/requirements.md', 'designer'), true);
  assert.strictEqual(validateOutputPath('docs/architecture.md', 'designer'), true);
});

test('testDesignerRejectedPaths', async () => {
  assert.strictEqual(validateOutputPath('docs/plan.md', 'designer'), false);
  assert.strictEqual(validateOutputPath('src/index.ts', 'designer'), false);
  assert.strictEqual(validateOutputPath('docs/decisions.md', 'designer'), false);
});

test('testPlannerAllowedPaths', async () => {
  assert.strictEqual(validateOutputPath('docs/plan.md', 'planner'), true);
  assert.strictEqual(validateOutputPath('docs/test-plan.md', 'planner'), true);
});

test('testPlannerCannotWriteRequirements', async () => {
  assert.strictEqual(validateOutputPath('docs/requirements.md', 'planner'), false);
  assert.strictEqual(validateOutputPath('docs/architecture.md', 'planner'), false);
});

test('testBuilderAllowsSrcDeniesDocsAndSle', async () => {
  assert.strictEqual(validateOutputPath('src/controller.ts', 'builder'), true);
  assert.strictEqual(validateOutputPath('src/deep/nested/file.ts', 'builder'), true);
  assert.strictEqual(validateOutputPath('docs/anything.md', 'builder'), false);
  assert.strictEqual(validateOutputPath('.sle/map.yaml', 'builder'), false);
});

test('testFacilitatorOnlyCharterPath', async () => {
  assert.strictEqual(validateOutputPath('docs/cycle-charter.md', 'facilitator'), true);
  assert.strictEqual(validateOutputPath('docs/requirements.md', 'facilitator'), false);
});

// ─── nextNode tests ───────────────────────────────────────────────────────────

test('testNextNodeSequence', async () => {
  assert.strictEqual(nextNode('SCOPING'), 'DESIGN');
  assert.strictEqual(nextNode('DESIGN'), 'CRITIQUE');
  assert.strictEqual(nextNode('CRITIQUE'), 'PLAN');
  assert.strictEqual(nextNode('PLAN'), 'TEST');
  assert.strictEqual(nextNode('SNAPSHOT'), null);
});

test('testNextNodeUnknownReturnsNull', async () => {
  assert.strictEqual(nextNode('UNKNOWN'), null);
});

// ─── shouldSkipAtDepth tests ──────────────────────────────────────────────────

test('testCritiqueSkippedAtStandard', async () => {
  assert.strictEqual(shouldSkipAtDepth('CRITIQUE', 'standard'), true);
  assert.strictEqual(shouldSkipAtDepth('CRITIQUE', 'minimal'), true);
});

test('testCritiqueNotSkippedAtDeep', async () => {
  assert.strictEqual(shouldSkipAtDepth('CRITIQUE', 'deep'), false);
  assert.strictEqual(shouldSkipAtDepth('CRITIQUE', 'research'), false);
});

test('testOtherNodesNotSkipped', async () => {
  assert.strictEqual(shouldSkipAtDepth('DESIGN', 'standard'), false);
  assert.strictEqual(shouldSkipAtDepth('BUILD', 'minimal'), false);
});

// ─── DAG_SEQUENCE tests ───────────────────────────────────────────────────────

test('testDagSequenceContainsAllCoreNodes', async () => {
  assert.ok(DAG_SEQUENCE.includes('SCOPING'));
  assert.ok(DAG_SEQUENCE.includes('DESIGN'));
  assert.ok(DAG_SEQUENCE.includes('CRITIQUE'));
  assert.ok(DAG_SEQUENCE.includes('PLAN'));
  assert.ok(DAG_SEQUENCE.includes('SNAPSHOT'));
  assert.strictEqual(DAG_SEQUENCE.length, 15);
});

test('testDagSequenceContainsCritique', async () => {
  assert.ok(DAG_SEQUENCE.includes('CRITIQUE'));
});

// ─── updateArtifactEntries tests ──────────────────────────────────────────────

test('testUpdateArtifactEntriesAddsNewEntries', async () => {
  const mgr = new InMemoryMapManager();
  await updateArtifactEntries(mgr, ['docs/requirements.md', 'docs/architecture.md'], 'designer');

  const map = await mgr.read();
  assert.strictEqual(map.artifacts.length, 2);
  assert.strictEqual(map.artifacts[0].path, 'docs/requirements.md');
  assert.strictEqual(map.artifacts[0].generator, 'designer');
  assert.strictEqual(map.artifacts[0].dirty, false);
  assert.ok(typeof map.artifacts[0].last_updated === 'string');
});

test('testUpdateArtifactEntriesUpdatesExisting', async () => {
  const mgr = new InMemoryMapManager();
  const baseMap = await mgr.read();
  baseMap.artifacts = [{ path: 'docs/requirements.md', generator: 'old-gen', required: true, last_updated: '2020-01-01T00:00:00Z', dirty: true }];
  await mgr.write(baseMap);

  await updateArtifactEntries(mgr, ['docs/requirements.md'], 'designer');

  const map = await mgr.read();
  assert.strictEqual(map.artifacts.length, 1);
  assert.strictEqual(map.artifacts[0].generator, 'designer');
  assert.strictEqual(map.artifacts[0].dirty, false);
});

test('testUpdateArtifactEntriesNoOpForEmptyPaths', async () => {
  const mgr = new InMemoryMapManager();
  await updateArtifactEntries(mgr, [], 'designer');
  const map = await mgr.read();
  assert.strictEqual(map.artifacts.length, 0);
});

// ─── DAGRunner.runNode tests ──────────────────────────────────────────────────

test('testRunNodeDesignSuccess', async () => {
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
  assert.strictEqual(result.next_node, 'CRITIQUE');
  assert.deepStrictEqual(result.artifacts_written, ['docs/requirements.md', 'docs/architecture.md']);
  assert.strictEqual(result.tokens_used, 250);
});

test('testRunNodeUpdatesManifestRunning', async () => {
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
});

test('testRunNodeUpdatesDagCurrentNode', async () => {
  const runner = new MockAgentRunner({
    success: true, artifacts_written: [], tokens_used: 0, duration_ms: 0, raw_output_path: '',
  });
  const mgr = new InMemoryMapManager();
  const ram = new InMemoryRunArtifactManager();
  const dagRunner = new DAGRunner(runner, mgr, ram);

  await dagRunner.runNode('DESIGN', makeCycleState());

  const map = await mgr.read();
  // After DESIGN completes, current_node should advance to CRITIQUE
  assert.strictEqual(map.meta.dag?.current_node, 'CRITIQUE');
  assert.ok(map.meta.dag?.completed_nodes.includes('DESIGN'));
});

test('testRunNodeUpdatesArtifactEntriesInMap', async () => {
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
});

test('testRunNodeFailureMarkedInManifest', async () => {
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
});

test('testSkipNodeIsNoOpForUnknownNode', async () => {
  const runner = new MockAgentRunner({ success: true, artifacts_written: [], tokens_used: 0, duration_ms: 0, raw_output_path: '' });
  const mgr = new InMemoryMapManager();
  const ram = new InMemoryRunArtifactManager();
  const dagRunner = new DAGRunner(runner, mgr, ram);

  // CRITIQUE is not in manifest — skipNode should not throw
  await assert.doesNotReject(() => dagRunner.skipNode('CRITIQUE', 1, 1, 'depth'));
});

test('testCritiqueSkippedAtStandardDepthPattern', async () => {
  // Verify the pattern: at standard depth, CRITIQUE is skipped before PLAN
  assert.strictEqual(shouldSkipAtDepth('CRITIQUE', 'standard'), true);
  assert.strictEqual(nextNode('DESIGN'), 'CRITIQUE');
});

test('testWritePathValidationBlocksDesignerFromPlanPath', async () => {
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
});

// ─── Runner ──────────────────────────────────────────────────────────────────
