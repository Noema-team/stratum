// DDR-041 — trusted Definition → execution handoff.
//
// E5 preflight (static) falsified H1: nothing connected define-work's
// committed canonical Definition to a full-build WorkItem's execution input
// without operator translation. These tests pin the closed invariant:
//
//   define-work WorkItem A (completed, recorded definition artifact)
//     → execution WorkItem B declares definitionSource: { workItemId: A }
//     → StratumAgentAdapter resolves it through D.1 provenance (sha256-pinned)
//     → every StepRunContext carries the verbatim authoritative Definition
//     → ContextManager renders it under its own AUTHORITATIVE DEFINITION
//       header, full bytes, never truncated
//     → the reference is frozen into WorkflowRun.resolvedParameters at initial
//       dispatch and restored on resume — never re-read from a mutable field
//
// and the fail-closed matrix: wrong shape, missing deps, wrong project,
// wrong objective, not-completed source, zero/ambiguous provenance, mutated
// bytes (hash mismatch), structurally invalid bytes, oversized bytes, and
// cross-work-item substitution (no filename/recency/text inference).
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import {
  openDatabase,
} from '../src/storage/database.js';
import {
  WorkspaceRepository, ProjectRepository, ObjectiveRepository,
  WorkItemRepository, ArtifactRepository, WorkflowRunRepository,
} from '../src/storage/repositories.js';
import type { Database } from 'better-sqlite3';
import type { WorkItem } from '../src/domain/work-item.js';

import {
  resolveDefinitionSource, parseDefinitionSourceRef,
  MAX_AUTHORITATIVE_DEFINITION_BYTES,
} from '../src/execution/definition-source.js';
import { validateFullBuildParams } from '../src/execution/workflow-parameters.js';
import { resolveWorkflowInvocation } from '../src/execution/workflow-invocation.js';
import { ContextManager } from '../src/context-manager.js';
import { DEFAULT_CONFIG, ContextBudgetExceededError } from '../src/context-manager.js';
import type { StepRunContext } from '../src/workflow/types.js';

// Part D harness — real StratumAgentAdapter + FullBuildStepRunner + WorkflowEngine
// over the seeded authority chain (spy agent/services capture StepRunContext).
import { StratumAgentAdapter } from '../src/execution/stratum-agent-adapter.js';
import { FullBuildStepRunner } from '../src/execution/full-build-step-runner.js';
import { AgentStepRunner } from '../src/execution/agent-step-runner.js';
import { WorkflowEngine } from '../src/workflow/engine.js';
import { AgentRunner } from '../src/agent-runner.js';
import type { WorkflowEngineDeps, WorkflowEngineOptions } from '../src/workflow/engine.js';
import type { ExecutionRequest } from '../src/execution/types.js';
import type { RuntimeMap, RuntimeMapManager } from '../src/runtime-map.js';
import type { AgentRunResult } from '../src/agent-runner.js';
import type { FailureReport, PlanningDepth } from '../src/types.js';

class CtxCapturingAgentRunner {
  public ctxs: StepRunContext[] = [];
  async run(_role: string, ctx: StepRunContext): Promise<AgentRunResult> {
    this.ctxs.push(ctx);
    return { success: true, next_node: null as never, artifacts_written: [], tokens_used: 0, duration_ms: 1, raw_output_path: '' };
  }
  [key: string]: unknown;
}

class SpyRunArtifacts {
  private reports = new Map<string, FailureReport>();
  async updateNodeStatus(): Promise<void> {}
  async createRunDir(): Promise<void> {}
  async createManifest(): Promise<void> {}
  async readManifest() {
    return { cycle_id: 'r', cycle_number: 1, iteration: 1, planning_depth: 'minimal' as const, started_at: '', outcome: 'in_progress' as const, nodes: [] };
  }
  async writeFailureReport(cn: number, iter: number, r: FailureReport): Promise<void> {
    this.reports.set(`${cn}-${iter}`, r);
  }
  async readFailureReport(cn: number, iter: number): Promise<FailureReport | null> {
    return this.reports.get(`${cn}-${iter}`) ?? null;
  }
  [key: string]: unknown;
}

function baseMap(depth: PlanningDepth = 'minimal'): RuntimeMap {
  return {
    meta: { status: 'cycling', cycle: 1, version_id: 'v1', initialized_at: '', updated_at: '',
      dag: { current_node: null, completed_nodes: [], iteration: 1, revision: 0, started_at: '', nodes: {} } },
    project: { name: 'test', description: 'test', type: 'api' },
    remotes: { code: { type: 'git', url: 'https://github.com/o/r.git', branch: 'main' }, issues: { type: 'git', url: 'https://github.com/o/r.git', branch: 'main' }, docs: { url: 'https://github.com/o/d.git', pending: false } },
    task_store: { type: 'local' }, agents: {}, discovery: { status: 'complete', mode: 'full', completed_at: '', artifacts: [], current_round: 0, total_rounds: 1, current_phase: 0, total_phases: 0, open_questions_count: 0, blocking_questions_count: 0 },
    cycle: { number: 1, iteration: 1, revision: 0, max_iterations: 10, planning_depth: depth, started_at: '', outcome: 'cycling', approval_gate: null, awaiting_scoping: false, awaiting_confirmation: false, awaiting_sharding_approval: false },
    artifacts: [],
  } as unknown as RuntimeMap;
}

class InMemMapManager implements RuntimeMapManager {
  public map: RuntimeMap;
  constructor(depth: PlanningDepth = 'minimal') { this.map = baseMap(depth); }
  async read() { return JSON.parse(JSON.stringify(this.map)); }
  async update(fn: (m: RuntimeMap) => RuntimeMap) { this.map = fn(JSON.parse(JSON.stringify(this.map))); }
  async write(m: RuntimeMap) { this.map = m; }
  [key: string]: unknown;
}

// Real canonical Definition bytes (pinned E4-G inv 4 artifact — parses).
const FIXTURE_DEFINITION = readFileSync(
  join(import.meta.dirname, 'fixtures/d34/ddr039/e4g-inv4-definition.md'),
  'utf8',
);

interface Seed {
  db: Database;
  root: string;
  ws: WorkspaceRepository; proj: ProjectRepository; obj: ObjectiveRepository;
  wi: WorkItemRepository; art: ArtifactRepository;
  projectId: string;
  sourceWiId: string;
  executionWiId: string;
  definitionPath: string;
  cleanup: () => void;
}

// Seeds the full authority chain: workspace → project → objective →
// completed define-work WorkItem A with an on-disk canonical Definition and
// its D.1 provenance row → ready execution WorkItem B referencing A.
function seed(overrides: {
  executionObjectiveId?: string | null;
  executionObjectiveDifferent?: boolean;
  executionProjectId?: string;
  sourceState?: string;
  sourceDefinitionRef?: string;
  recordDefinition?: boolean;
  recordSecondDefinitionRef?: boolean;
  mutateDefinitionAfterRecording?: boolean;
  definitionBytes?: string;
} = {}): Seed {
  const root = mkdtempSync(join(tmpdir(), 'ddr041-'));
  const db = openDatabase(':memory:');

  const ws = new WorkspaceRepository(db);
  const proj = new ProjectRepository(db);
  const obj = new ObjectiveRepository(db);
  const wi = new WorkItemRepository(db);
  const art = new ArtifactRepository(db);
  const now = new Date().toISOString();

  const workspaceId = randomUUID();
  ws.save({ id: workspaceId, name: 'ws', createdAt: now });

  const projectId = randomUUID();
  proj.save({
    id: projectId, workspaceId, name: 'p', description: 'p',
    status: 'active', priority: 0, createdAt: now, updatedAt: now,
  });

  const objectiveId = randomUUID();
  obj.save({
    id: objectiveId, projectId, title: 'o', description: 'o', priority: 0,
    status: 'active', constraints: [], successCriteria: [], createdAt: now, updatedAt: now,
  });

  const sourceWiId = randomUUID();
  const source: WorkItem = {
    id: sourceWiId, projectId,
    objectiveId,
    repositoryIds: [], title: 'Define the work', goal: 'define',
    workflowId: 'define-work', state: (overrides.sourceState ?? 'completed') as WorkItem['state'],
    priority: 0, acceptanceCriteria: [], constraints: [], requiredEvidence: [],
    dependencies: [], createdAt: now, updatedAt: now,
  };
  wi.save(source);

  const bytes = overrides.definitionBytes ?? FIXTURE_DEFINITION;
  const definitionPath = `.sle/work/${sourceWiId}/definition.md`;
  mkdirSync(join(root, `.sle/work/${sourceWiId}`), { recursive: true });
  writeFileSync(join(root, definitionPath), bytes);
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (overrides.recordDefinition !== false) {
    art.save({
      id: randomUUID(), workItemId: sourceWiId, workflowRunId: `run-${sourceWiId}`,
      type: 'definition', ref: overrides.sourceDefinitionRef ?? `definition:${objectiveId}`,
      path: definitionPath, hash, createdAt: now,
    });
  }
  if (overrides.recordSecondDefinitionRef) {
    const otherPath = `.sle/work/${sourceWiId}/definition-alt.md`;
    writeFileSync(join(root, otherPath), bytes);
    art.save({
      id: randomUUID(), workItemId: sourceWiId, workflowRunId: `run-${sourceWiId}`,
      type: 'definition', ref: `definition-alt:${objectiveId}`,
      path: otherPath, hash, createdAt: now,
    });
  }
  if (overrides.mutateDefinitionAfterRecording) {
    writeFileSync(join(root, definitionPath), bytes + '\n<!-- mutated -->');
  }

  const executionWiId = randomUUID();
  let executionObjectiveId = overrides.executionObjectiveId === null ? undefined : (overrides.executionObjectiveId ?? objectiveId);
  if (overrides.executionObjectiveDifferent) {
    const objective2Id = randomUUID();
    obj.save({
      id: objective2Id, projectId, title: 'o2', description: 'o2', priority: 0,
      status: 'active', constraints: [], successCriteria: [], createdAt: now, updatedAt: now,
    });
    executionObjectiveId = objective2Id;
  }
  const execution: WorkItem = {
    id: executionWiId,
    projectId: overrides.executionProjectId ?? projectId,
    objectiveId: executionObjectiveId,
    repositoryIds: [], title: 'Implement the work', goal: 'implement',
    workflowId: 'full-build', state: 'ready',
    priority: 0, acceptanceCriteria: [], constraints: [], requiredEvidence: [],
    dependencies: [], createdAt: now, updatedAt: now,
  };
  wi.save(execution);

  return {
    db, root, ws, proj, obj, wi, art,
    projectId, sourceWiId, executionWiId, definitionPath,
    cleanup: () => { try { rmSync(root, { recursive: true, force: true }); } catch {} db.close(); },
  };
}

async function resolveFor(s: Seed, ref: unknown, opts: { withDeps?: boolean } = {}) {
  return resolveDefinitionSource(
    ref,
    { workItemId: s.executionWiId },
    opts.withDeps === false
      ? { projectRoot: s.root }
      : { workItemRepository: s.wi, artifactRepository: s.art, projectRoot: s.root },
  );
}

// ============================================================================
// Part A — resolver: happy path + fail-closed matrix
// ============================================================================

test('ddr041: resolves the recorded canonical Definition with exact bytes and hash', async () => {
  const s = seed();
  try {
    const r = await resolveFor(s, { workItemId: s.sourceWiId });
    assert.ok(r.ok, `expected ok, got: ${!r.ok && r.failure.message}`);
    assert.equal(r.value.sourceWorkItemId, s.sourceWiId);
    assert.equal(r.value.path, s.definitionPath);
    assert.equal(r.value.content, FIXTURE_DEFINITION);
    assert.equal(r.value.sha256, createHash('sha256').update(FIXTURE_DEFINITION).digest('hex'));
  } finally { s.cleanup(); }
});

test('ddr041: invalid reference shapes fail closed (extra keys, non-string, empty)', async () => {
  const s = seed();
  try {
    for (const bad of [{ workItemId: 'x', extra: 1 }, { id: 'x' }, { workItemId: 42 }, {}, 'define-work']) {
      const r = await resolveFor(s, bad);
      assert.ok(!r.ok && r.failure.code === 'invalid_definition_source', JSON.stringify(bad));
    }
  } finally { s.cleanup(); }
});

test('ddr041: declared source without configured repositories fails closed', async () => {
  const s = seed();
  try {
    const r = await resolveFor(s, { workItemId: s.sourceWiId }, { withDeps: false });
    assert.ok(!r.ok && r.failure.code === 'missing_definition_source_dependencies');
  } finally { s.cleanup(); }
});

test('ddr041: missing execution WorkItem fails closed', async () => {
  const s = seed();
  try {
    const r = await resolveDefinitionSource(
      { workItemId: s.sourceWiId },
      { workItemId: randomUUID() },
      { workItemRepository: s.wi, artifactRepository: s.art, projectRoot: s.root },
    );
    assert.ok(!r.ok && r.failure.code === 'execution_work_item_not_found');
  } finally { s.cleanup(); }
});

test('ddr041: missing source WorkItem fails closed', async () => {
  const s = seed();
  try {
    const r = await resolveFor(s, { workItemId: randomUUID() });
    assert.ok(!r.ok && r.failure.code === 'source_work_item_not_found');
  } finally { s.cleanup(); }
});

test('ddr041: cross-project source fails closed', async () => {
  const s = seed();
  try {
    const otherProject = randomUUID();
    const wsId = (s.db.prepare('SELECT workspace_id AS w FROM projects WHERE id = ?')
      .get(s.projectId) as { w: string }).w;
    const now = new Date().toISOString();
    s.proj.save({
      id: otherProject, workspaceId: wsId, name: 'other',
      status: 'active', priority: 0, createdAt: now, updatedAt: now,
    });
    const executionOther = randomUUID();
    s.wi.save({
      id: executionOther, projectId: otherProject, objectiveId: undefined,
      repositoryIds: [], title: 't', goal: 'g', workflowId: 'full-build', state: 'ready',
      priority: 0, acceptanceCriteria: [], constraints: [], requiredEvidence: [],
      dependencies: [], createdAt: now, updatedAt: now,
    });
    const r = await resolveDefinitionSource(
      { workItemId: s.sourceWiId },
      { workItemId: executionOther },
      { workItemRepository: s.wi, artifactRepository: s.art, projectRoot: s.root },
    );
    assert.ok(!r.ok && r.failure.code === 'source_project_mismatch', !r.ok ? r.failure.code : 'ok');
  } finally { s.cleanup(); }
});

test('ddr041: objective mismatch fails closed when the execution WorkItem expects an Objective', async () => {
  const s = seed({ executionObjectiveDifferent: true });
  try {
    const r = await resolveFor(s, { workItemId: s.sourceWiId });
    assert.ok(!r.ok && r.failure.code === 'objective_mismatch');
  } finally { s.cleanup(); }
});

test('ddr041: source WorkItem not completed fails closed', async () => {
  const s = seed({ sourceState: 'ready' });
  try {
    const r = await resolveFor(s, { workItemId: s.sourceWiId });
    assert.ok(!r.ok && r.failure.code === 'source_work_item_not_completed');
  } finally { s.cleanup(); }
});

test('ddr041: zero recorded definition artifacts fails closed (no provenance, no inference)', async () => {
  const s = seed({ recordDefinition: false });
  try {
    const r = await resolveFor(s, { workItemId: s.sourceWiId });
    assert.ok(!r.ok && r.failure.code === 'source_definition_not_found');
  } finally { s.cleanup(); }
});

test('ddr041: multiple distinct definition artifacts fails closed (ambiguous)', async () => {
  const s = seed({ recordSecondDefinitionRef: true });
  try {
    const r = await resolveFor(s, { workItemId: s.sourceWiId });
    assert.ok(!r.ok && r.failure.code === 'ambiguous_source_definition');
  } finally { s.cleanup(); }
});

test('ddr041: post-recording mutation fails closed on the hash pin', async () => {
  const s = seed({ mutateDefinitionAfterRecording: true });
  try {
    const r = await resolveFor(s, { workItemId: s.sourceWiId });
    assert.ok(!r.ok && r.failure.code === 'definition_hash_mismatch');
  } finally { s.cleanup(); }
});

test('ddr041: structurally invalid definition bytes fail closed', async () => {
  const s = seed({ definitionBytes: 'not a definition artifact\n' });
  try {
    const r = await resolveFor(s, { workItemId: s.sourceWiId });
    assert.ok(!r.ok && r.failure.code === 'invalid_definition');
  } finally { s.cleanup(); }
});

test('ddr041: oversized definition fails closed explicitly — never silently truncated', async () => {
  const s = seed({ definitionBytes: FIXTURE_DEFINITION + '\n'.padEnd(MAX_AUTHORITATIVE_DEFINITION_BYTES + 10, 'x') });
  try {
    const r = await resolveFor(s, { workItemId: s.sourceWiId });
    assert.ok(!r.ok && r.failure.code === 'definition_too_large');
    assert.ok(r.failure.message.includes('boundary limitation'));
  } finally { s.cleanup(); }
});

test('ddr041: no cross-work-item substitution — a different WorkItem\'s Definition cannot satisfy A\'s reference', async () => {
  // A has NO recorded definition; C (same project/objective) has one. The
  // reference to A must fail — identity is exact, never inferred.
  const s = seed({ recordDefinition: false });
  try {
    const now = new Date().toISOString();
    const cId = randomUUID();
    s.wi.save({
      id: cId, projectId: s.projectId, objectiveId: undefined,
      repositoryIds: [], title: 'C', goal: 'c', workflowId: 'define-work', state: 'completed',
      priority: 0, acceptanceCriteria: [], constraints: [], requiredEvidence: [],
      dependencies: [], createdAt: now, updatedAt: now,
    });
    const cPath = `.sle/work/${cId}/definition.md`;
    mkdirSync(join(s.root, `.sle/work/${cId}`), { recursive: true });
    writeFileSync(join(s.root, cPath), FIXTURE_DEFINITION);
    s.art.save({
      id: randomUUID(), workItemId: cId, workflowRunId: `run-${cId}`,
      type: 'definition', ref: 'definition:other', path: cPath,
      hash: createHash('sha256').update(FIXTURE_DEFINITION).digest('hex'), createdAt: now,
    });
    const r = await resolveFor(s, { workItemId: s.sourceWiId });
    assert.ok(!r.ok && r.failure.code === 'source_definition_not_found');
  } finally { s.cleanup(); }
});

// ============================================================================
// Part B — parameter contract + invocation seam
// ============================================================================

test('ddr041: full-build parameter contract carries a valid definitionSource, rejects invalid ones', () => {
  const ok = validateFullBuildParams({ definitionSource: { workItemId: 'wi-1' } });
  assert.deepEqual(ok.definitionSource, { workItemId: 'wi-1' });

  assert.throws(() => validateFullBuildParams({ definitionSource: { workItemId: 'x', nope: 1 } }));
  assert.throws(() => validateFullBuildParams({ definitionSource: { id: 'x' } }));
  assert.throws(() => validateFullBuildParams({ definitionSource: 'wi-1' }));
  assert.equal(validateFullBuildParams({}).definitionSource, undefined);
});

test('ddr041: parseDefinitionSourceRef accepts only the exact single-key shape', () => {
  assert.deepEqual(parseDefinitionSourceRef({ workItemId: 'a' }), { workItemId: 'a' });
  assert.equal(parseDefinitionSourceRef({ workItemId: '' }), undefined);
  assert.equal(parseDefinitionSourceRef(null), undefined);
});

test('ddr041: generic invocation passthrough preserves definitionSource (non-full-build workflows)', () => {
  const inv = resolveWorkflowInvocation('draft-artifact', { definitionSource: { workItemId: 'wi-1' } });
  assert.deepEqual(inv.normalizedParams['definitionSource'], { workItemId: 'wi-1' });
});

// ============================================================================
// Part C — model-visible rendering (ContextManager)
// ============================================================================

test('ddr041: ContextManager renders the Definition verbatim under its own authoritative header', async () => {
  const s = seed();
  try {
    mkdirSync(join(s.root, '.sle/project-docs'), { recursive: true });
    writeFileSync(join(s.root, '.sle/project-docs/requirements.md'), '# Requirements\nlegacy doc content');

    const cm = new ContextManager(s.root);
    const sha = createHash('sha256').update(FIXTURE_DEFINITION).digest('hex');
    const ctx: StepRunContext = {
      workflowRunId: 'r', workflowId: 'full-build', stepId: 'build', role: 'builder',
      iteration: 1, revision: 0, goal: 'implement', projectRoot: s.root,
      workItemId: s.executionWiId,
      inputArtifactRefs: undefined, // role-default context path — unchanged by DDR-041
      authoritativeDefinition: {
        sourceWorkItemId: s.sourceWiId, artifactId: 'a', ref: `definition:x`,
        path: s.definitionPath, sha256: sha, content: FIXTURE_DEFINITION,
      },
    };
    const assembled = await cm.assemble('builder', ctx);
    // Verbatim, full bytes, own header, provenance visible.
    assert.ok(assembled.task.includes('## AUTHORITATIVE DEFINITION'));
    assert.ok(assembled.task.includes(FIXTURE_DEFINITION), 'definition bytes must appear verbatim');
    assert.ok(assembled.task.includes(s.sourceWiId));
    assert.ok(assembled.task.includes(sha));
    // Existing role-default context remains (doc slices still assembled).
    assert.ok(Object.keys(assembled.artifact_slices).some((k) => k.includes('requirements')),
      `role-default slices must remain: ${Object.keys(assembled.artifact_slices).join(', ')}`);
    // No truncation flag on the authoritative content.
    assert.ok(!assembled.truncated.includes('definition'), `unexpected truncation: ${assembled.truncated.join(',')}`);
  } finally { s.cleanup(); }
});

// ============================================================================
// Part D — lifecycle: dispatch → checkpoint halt → frozen reference → resume
// (real StratumAgentAdapter + FullBuildStepRunner + WorkflowEngine + real
// WorkflowRun/WorkItem/Artifact repositories; spy agent captures contexts)
// ============================================================================

interface LifecycleHarness {
  s: Seed;
  agentSpy: CtxCapturingAgentRunner;
  runRepo: WorkflowRunRepository;
  makeAdapter: (checkpoint: 'halt' | 'approve') => StratumAgentAdapter;
  makeRequest: (workflowRunId: string, params: Record<string, unknown>, stepId?: string) => ExecutionRequest;
}

function lifecycleHarness(): LifecycleHarness {
  const s = seed();
  const agentSpy = new CtxCapturingAgentRunner();
  const agentStepRunner = new AgentStepRunner(agentSpy as never);
  const runArtifacts = new SpyRunArtifacts();
  const mapManager = new InMemMapManager('minimal');
  const runRepo = new WorkflowRunRepository(s.db);

  const makeAdapter = (checkpoint: 'halt' | 'approve') => {
    const stepRunner = new FullBuildStepRunner({
      agentStepRunner,
      mapManager,
      runArtifacts: runArtifacts as never,
      projectRoot: s.root,
      criticAgent: { critique: async () => ({ pass: true, blocking_issues: [], warnings: [], suggestions: [] }) } as never,
      confirmService: { gate: async () => {}, approve: async () => ({ next_node: 'BUILD' }) } as never,
      execService: { run: async () => ({ success: true, passed: true, next_node: 'VALIDATION_GATE' as const, duration_ms: 0 }) } as never,
      validationGateService: { run: async () => ({ passed: true, next_node: 'EVALUATE', failed_nodes: [] }) } as never,
      snapshotService: { run: async () => {} } as never,
      summariseService: { run: async () => ({ success: true, summary_path: 'docs/cycle-summary.md' }) } as never,
      shardingService: undefined,
      scopingService: {
        begin: async (ctx: StepRunContext) => {
          await agentSpy.run('facilitator', ctx);
          return { draft: '', charter_path: 'docs/cycle-charter.md', awaiting_scoping: true as const };
        },
        approve: async () => {},
      } as never,
    }, {
      onCheckpoint: async () => checkpoint,
      onConfirmGate: async () => 'approve',
      onShardingGate: async () => 'approve',
    });

    const engineDeps: WorkflowEngineDeps = {
      stepRunner,
      mapManager,
      runArtifacts: runArtifacts as never,
      projectRoot: s.root,
      workflowRunRepository: runRepo,
      workItemRepository: s.wi,
    };
    const engineOpts: WorkflowEngineOptions = {
      onCheckpoint: async () => checkpoint,
    };
    return new StratumAgentAdapter(engineDeps, engineOpts, s.art);
  };

  const makeRequest = (
    workflowRunId: string,
    params: Record<string, unknown>,
    stepId?: string,
  ): ExecutionRequest => ({
    stepExecutionId: randomUUID(),
    workItemId: s.executionWiId,
    workflowRunId,
    stepId: stepId ?? '__start__',
    workflowId: 'full-build',
    repositories: [],
    goal: 'implement the defined work',
    acceptanceCriteria: [],
    constraints: [],
    permissions: { pushBranch: false, createPr: false, merge: false },
    budget: {},
    workflowParameters: params,
  });

  return { s, agentSpy, runRepo, makeAdapter, makeRequest };
}

test('ddr041: lifecycle — dispatch carries the Definition, the reference freezes, resume preserves identical authority', async () => {
  const h = lifecycleHarness();
  const { s, agentSpy, runRepo, makeAdapter, makeRequest } = h;
  const runId = randomUUID();
  const sha = createHash('sha256').update(FIXTURE_DEFINITION).digest('hex');
  try {
    // 1) Initial dispatch — halts at the scoping checkpoint.
    const r1 = await makeAdapter('halt').execute(
      makeRequest(runId, { planning_depth: 'minimal', definitionSource: { workItemId: s.sourceWiId } }),
    );
    assert.equal(r1.outcome, 'blocked', `expected blocked, got ${r1.outcome}: ${r1.failure?.message}`);
    assert.ok(agentSpy.ctxs.length >= 1, 'steps ran before the checkpoint');

    // 2) Every pre-halt step carried the authoritative Definition verbatim.
    for (const ctx of agentSpy.ctxs) {
      assert.equal(ctx.authoritativeDefinition?.content, FIXTURE_DEFINITION, `step ${ctx.stepId} missing verbatim Definition`);
      assert.equal(ctx.authoritativeDefinition?.sha256, sha);
      assert.equal(ctx.authoritativeDefinition?.sourceWorkItemId, s.sourceWiId);
    }

    // 3) The reference is FROZEN into the persisted run's resolvedParameters.
    const persisted = runRepo.findById(runId);
    assert.ok(persisted, 'run persisted');
    assert.deepEqual(persisted!.resolvedParameters?.['definitionSource'], { workItemId: s.sourceWiId });
    assert.equal(persisted!.status, 'halted');

    // 4) A later mutation of the WorkItem's own parameters CANNOT substitute a
    //    different Definition source — the adapter reads the persisted run's
    //    frozen parameters, and the engine restores from the cursor.
    s.db.prepare('UPDATE work_items SET workflow_parameters_json = ? WHERE id = ?')
      .run(JSON.stringify({ planning_depth: 'minimal', definitionSource: { workItemId: 'attacker-substituted' } }), s.executionWiId);

    // 5) Resume exactly as ResumeService does: same run id, parameters from
    //    the persisted run, continuation at the persisted cursor — checkpoints
    //    approve, so the pipeline runs through BUILD to completion.
    const r2 = await makeAdapter('approve').execute(
      makeRequest(
        runId,
        persisted!.resolvedParameters ?? {},
        persisted!.current_step_id,
      ),
    );
    assert.equal(r2.outcome, 'succeeded', `resume failed: ${r2.failure?.message}`);

    // 6) Post-resume steps — including the builder — carry the IDENTICAL
    //    authority: same bytes, same hash, same source. No re-selection.
    const builderCtx = agentSpy.ctxs.find((c) => c.role === 'builder');
    assert.ok(builderCtx, `builder step must run; roles seen: ${agentSpy.ctxs.map((c) => c.role).join(',')}`);
    assert.equal(builderCtx!.authoritativeDefinition?.content, FIXTURE_DEFINITION);
    assert.equal(builderCtx!.authoritativeDefinition?.sha256, sha);
    assert.equal(builderCtx!.authoritativeDefinition?.sourceWorkItemId, s.sourceWiId);

    // 7) Role-default context preserved: builder step still uses the
    //    role-slice path (no inputArtifactRefs override introduced by DDR-041).
    assert.equal(builderCtx!.inputArtifactRefs, undefined);

    // 8) The frozen run parameters were never overwritten by the mutated
    //    WorkItem field or the resumed request.
    assert.deepEqual(runRepo.findById(runId)?.resolvedParameters?.['definitionSource'], { workItemId: s.sourceWiId });
  } finally { s.cleanup(); }
});

test('ddr041: dispatch with a definitionSource that cannot be provenance-verified fails closed BEFORE any step runs', async () => {
  const h = lifecycleHarness();
  const { s, agentSpy, makeAdapter, makeRequest } = h;
  try {
    // Remove the recorded provenance row: the on-disk file still exists, but
    // "a pre-existing file at this path is not sufficient provenance".
    s.db.prepare('DELETE FROM artifacts WHERE work_item_id = ?').run(s.sourceWiId);
    const before = agentSpy.ctxs.length;
    const r = await makeAdapter('approve').execute(
      makeRequest(randomUUID(), { planning_depth: 'minimal', definitionSource: { workItemId: s.sourceWiId } }),
    );
    assert.equal(r.outcome, 'failed');
    assert.equal(r.failure?.code, 'source_definition_not_found');
    assert.equal(agentSpy.ctxs.length, before, 'no model-visible step may run');
  } finally { s.cleanup(); }
});

// ============================================================================
// Part E — DDR-041 review: hard-context-ceiling boundary (fail closed, never
// silently degrade the authoritative Definition)
// ============================================================================

function definitionCtx(over: { root: string; sourceWiId: string; definitionPath: string }): StepRunContext {
  const sha = createHash('sha256').update(FIXTURE_DEFINITION).digest('hex');
  return {
    workflowRunId: 'r', workflowId: 'full-build', stepId: 'build', role: 'builder',
    iteration: 1, revision: 0, goal: 'implement', projectRoot: over.root,
    workItemId: 'wi-exec',
    inputArtifactRefs: undefined,
    authoritativeDefinition: {
      sourceWorkItemId: over.sourceWiId, artifactId: 'a', ref: 'definition:x',
      path: over.definitionPath, sha256: sha, content: FIXTURE_DEFINITION,
    },
  };
}

test('ddr041: a valid Definition that cannot fit the configured context ceiling fails closed — no truncation', async () => {
  const s = seed();
  try {
    // Small configured boundary: the canonical Definition (a few thousand
    // tokens) cannot fit, exactly the review's scenario.
    const smallConfig = { ...DEFAULT_CONFIG, hard_ceiling: 300 };
    const cm = new ContextManager(s.root, smallConfig);
    await assert.rejects(
      cm.assemble('builder', definitionCtx(s)),
      (err: unknown) => {
        assert.ok(err instanceof ContextBudgetExceededError);
        assert.equal(err.code, 'context_budget_exceeded');
        assert.ok(err.message.includes('hard_ceiling of 300'), err.message);
        assert.ok(err.message.includes('AUTHORITATIVE DEFINITION'), err.message);
        assert.ok(err.message.includes('never'), err.message);
        return true;
      },
    );
  } finally { s.cleanup(); }
});

test('ddr041: a Definition that fits assembles within the configured hard ceiling (slices budget around it)', async () => {
  const s = seed();
  try {
    mkdirSync(join(s.root, '.sle/project-docs'), { recursive: true });
    writeFileSync(join(s.root, '.sle/project-docs/requirements.md'), `# Requirements\n${'r'.repeat(20_000)}`);
    const config = { ...DEFAULT_CONFIG, hard_ceiling: 4_000 };
    const cm = new ContextManager(s.root, config);
    const assembled = await cm.assemble('builder', definitionCtx(s));
    // Verbatim bytes present...
    assert.ok(assembled.task.includes(FIXTURE_DEFINITION));
    // ...and the assembled total respects the configured ceiling, allowing
    // only the estimator tolerance the existing ContextManager contract uses
    // (testHardCeilingEnforced allows +5%).
    assert.ok(
      assembled.token_count <= config.hard_ceiling * 1.05,
      `token_count ${assembled.token_count} exceeds ceiling ${config.hard_ceiling}`,
    );
  } finally { s.cleanup(); }
});

test('ddr041: context-budget overflow fails the step with ZERO model calls — no degraded task ever reaches a provider', async () => {
  const s = seed();
  try {
    let modelCalls = 0;
    const provider = {
      complete: async () => {
        modelCalls++;
        return { content: '', tokens_used: 1, duration_ms: 1 };
      },
    };
    const runArtifacts = new SpyRunArtifacts();
    const cm = new ContextManager(s.root, { ...DEFAULT_CONFIG, hard_ceiling: 300 });
    const runner = new AgentRunner(cm, provider, s.root, runArtifacts as never, { model: 'test-model' });
    const result = await runner.run('builder', definitionCtx(s));

    assert.equal(result.success, false);
    assert.ok(result.error?.startsWith('context_budget_exceeded'), `error: ${result.error}`);
    assert.equal(modelCalls, 0, 'no model call may happen on a context-budget failure');
    assert.equal(result.tokens_used, 0);
  } finally { s.cleanup(); }
});
