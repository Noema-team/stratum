/**
 * Commit C.2 — UI authority convergence + application E2E
 *
 * Tests:
 *  1. Dashboard Decision resolution sends valid DecisionResolution (not_found on bad body)
 *  2. observability/summary is workspace-scoped
 *  3. E2E: WorkItem → Scheduler tick (checkpoint) → Decision in /attention → resolve via HTTP → in_review
 *  4. observability/summary cross-workspace isolation
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { openDatabase } from '../src/storage/database.js';
import { WorkService } from '../src/services/work-service.js';
import { EvidenceService } from '../src/services/evidence-service.js';
import { ResumeService } from '../src/services/resume-service.js';
import { ExecutorRegistry } from '../src/execution/registry.js';
import { Scheduler } from '../src/scheduler/scheduler.js';
import { ControlPlaneServer } from '../src/api/control-plane-server.js';
import {
  WorkspaceRepository,
  ProjectRepository,
  WorkItemRepository,
  DecisionRepository,
  WorkflowRunRepository,
} from '../src/storage/repositories.js';
import { getCheckpointDecisionOptions } from '../src/execution/checkpoint-resolver.js';
import type { ExecutionAdapter, ExecutionRequest, ExecutionResult, CapabilitySet } from '../src/execution/types.js';
import type { Workspace, Project } from '../src/domain/index.js';

// ── helpers ────────────────────────────────────────────────────────────────────

function makeTmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'sle-c2-test-'));
}

let _port = 19600;
function nextPort(): number { return _port++; }

interface TestHarness {
  url: string;
  db: ReturnType<typeof openDatabase>;
  workspaceId: string;
  projectId: string;
  workService: WorkService;
  scheduler: Scheduler;
  server: ControlPlaneServer;
  tmpRoot: string;
  stop(): Promise<void>;
}

// Builds a checkpoint-then-succeed stub adapter.
// First call → blocked/checkpoint at stepId 'confirm', also inserts WorkflowRun row
//   so ResumeService can find it.
// Subsequent calls → succeeded.
function makeCheckpointAdapter(db: ReturnType<typeof openDatabase>, stepId = 'confirm'): ExecutionAdapter {
  let calls = 0;
  const runRepo = new WorkflowRunRepository(db);
  return {
    id: 'stratum-agent',
    getCapabilities(): CapabilitySet { return new Set(); },
    async execute(req: ExecutionRequest): Promise<ExecutionResult> {
      calls++;
      if (calls === 1) {
        // Insert a halted WorkflowRun so ResumeService's strict linkage check succeeds.
        const now = new Date().toISOString();
        runRepo.createOrValidate({
          run_id: req.workflowRunId,
          workflow_id: req.workflowId,
          work_item_id: req.workItemId,
          status: 'halted',
          current_step_id: stepId,
          iteration: 1,
          revision: 0,
          awaiting_checkpoint: stepId,
          started_at: now,
          updated_at: now,
        });
        return {
          schemaVersion: 1,
          stepExecutionId: req.stepExecutionId,
          outcome: 'blocked',
          artifacts: [],
          evidenceClaims: [],
          checkpointStepId: stepId,
          decisionRequests: [{
            type: 'checkpoint',
            title: 'Workflow paused',
            summary: `Waiting at step: ${stepId}`,
            options: getCheckpointDecisionOptions('full-build', stepId),
          }],
          usage: { durationMs: 1 },
        };
      }
      return {
        schemaVersion: 1,
        stepExecutionId: req.stepExecutionId,
        outcome: 'succeeded',
        artifacts: [],
        evidenceClaims: [],
        decisionRequests: [],
        usage: { durationMs: 1 },
      };
    },
  };
}

async function makeHarness(adapterFactory?: (db: ReturnType<typeof openDatabase>) => ExecutionAdapter): Promise<TestHarness> {
  const tmpRoot = makeTmpRoot();
  const db = openDatabase(':memory:');
  const workspaceId = randomUUID();
  const now = new Date().toISOString();

  const workspace: Workspace = { id: workspaceId, name: 'test-ws', createdAt: now };
  new WorkspaceRepository(db).save(workspace);

  const projectId = randomUUID();
  const project: Project = {
    id: projectId, workspaceId, name: 'test-project',
    status: 'active', priority: 0, createdAt: now, updatedAt: now,
  };
  new ProjectRepository(db).save(project);

  const evidenceService = new EvidenceService(db);
  const workService = new WorkService(db, workspaceId, {
    evidenceGuard: evidenceService.asGuard(),
  });

  const registry = new ExecutorRegistry();
  registry.register((adapterFactory ?? makeCheckpointAdapter)(db));

  const resumeService = new ResumeService(db, workspaceId, registry, {}, workService);
  const scheduler = new Scheduler(db, workspaceId, registry, {}, workService);

  const port = nextPort();
  const server = new ControlPlaneServer({
    db,
    workspaceId,
    workService,
    evidenceService,
    resumeService,
    port,
  });
  await server.listen();

  return {
    url: `http://localhost:${port}`,
    db,
    workspaceId,
    projectId,
    workService,
    scheduler,
    server,
    tmpRoot,
    async stop() {
      await server.close();
      db.close();
      rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}

async function apiFetch(url: string, method = 'GET', body?: unknown) {
  const opts: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  return res.json() as Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string } }>;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

test('C2.dash: resolve Decision with valid DecisionResolution body → ok', async () => {
  const h = await makeHarness();
  try {
    // Create work item via service directly then seed a Decision for it.
    const wi = h.workService.createWorkItem({
      projectId: h.projectId, title: 'dash-test', goal: 'g', workflowId: 'full-build',
    });
    h.workService.markReady({ workItemId: wi.id });
    await h.scheduler.tick(); // → running → needs_decision (checkpoint)

    const wi2 = new WorkItemRepository(h.db).findById(wi.id);
    assert.equal(wi2?.state, 'needs_decision', 'WorkItem should be needs_decision after checkpoint tick');

    const decisions = new DecisionRepository(h.db).listByWorkItem(wi.id);
    assert.equal(decisions.length, 1, 'One Decision should exist');
    const decisionId = decisions[0].id;

    // POST with valid DecisionResolution (what the fixed dashboard sends)
    const res = await apiFetch(`${h.url}/decisions/${decisionId}/resolve`, 'POST', {
      resolution: { selectedOptionId: 'approve', resolvedAt: new Date().toISOString() },
    });
    assert.equal(res.ok, true, `resolve should succeed — got: ${JSON.stringify(res)}`);

    // WorkItem should now be in_review (resume ran the stub a second time → succeeded)
    const wi3 = new WorkItemRepository(h.db).findById(wi.id);
    assert.equal(wi3?.state, 'in_review', `WorkItem should be in_review after resolve — got: ${wi3?.state}`);
  } finally {
    await h.stop();
  }
});

test('C2.dash: resolve Decision with old broken body shape → bad_request', async () => {
  const h = await makeHarness();
  try {
    const wi = h.workService.createWorkItem({
      projectId: h.projectId, title: 'dash-broken', goal: 'g', workflowId: 'full-build',
    });
    h.workService.markReady({ workItemId: wi.id });
    await h.scheduler.tick();

    const decisions = new DecisionRepository(h.db).listByWorkItem(wi.id);
    assert.equal(decisions.length, 1);
    const decisionId = decisions[0].id;

    // Old shape: { optionId, resolution: optionId } — should fail schema validation
    const res = await apiFetch(`${h.url}/decisions/${decisionId}/resolve`, 'POST', {
      optionId: 'approve',
      resolution: 'approve',
    });
    assert.equal(res.ok, false, 'old body shape should be rejected');
    assert.equal(res.error?.code, 'bad_request');
  } finally {
    await h.stop();
  }
});

test('C2.obs: observability/summary only counts WorkItems in this workspace', async () => {
  const h = await makeHarness();
  try {
    // Workspace A: create and run a WorkItem (becomes in_review after full E2E)
    const wiA = h.workService.createWorkItem({
      projectId: h.projectId, title: 'obs-a', goal: 'g', workflowId: 'full-build',
    });
    h.workService.markReady({ workItemId: wiA.id });
    await h.scheduler.tick(); // → running → needs_decision

    // Workspace B: create a separate DB entry with a failed WorkItem
    const wsB = randomUUID();
    new WorkspaceRepository(h.db).save({ id: wsB, name: 'ws-b', createdAt: new Date().toISOString() });
    const projB: Project = {
      id: randomUUID(), workspaceId: wsB, name: 'proj-b',
      status: 'active', priority: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    new ProjectRepository(h.db).save(projB);
    const wsBWorkService = new WorkService(h.db, wsB, {});
    const wiB = wsBWorkService.createWorkItem({
      projectId: projB.id, title: 'obs-b', goal: 'g', workflowId: 'full-build',
    });
    wsBWorkService.markReady({ workItemId: wiB.id });
    // Manually fail workspace B's item
    wsBWorkService.fail({ workItemId: wiB.id, reason: 'test_fail' });

    // Workspace A's summary should report needs_decision=1, failed=0
    const res = await apiFetch(`${h.url}/observability/summary`);
    assert.equal(res.ok, true);
    const counts = (res.data as { counts: Record<string, number> }).counts;
    assert.equal(counts.needsDecision, 1, `Workspace A should see needsDecision=1, got: ${JSON.stringify(counts)}`);
    assert.equal(counts.failed, 0, `Workspace A should not see Workspace B's failed item — got failed=${counts.failed}`);
  } finally {
    await h.stop();
  }
});

test('C2.e2e: full vertical — WorkItem → checkpoint → /attention → resolve → in_review', async () => {
  const h = await makeHarness();
  try {
    // 1. Create WorkItem via HTTP (POST /projects/:id/work)
    const createRes = await apiFetch(`${h.url}/projects/${h.projectId}/work`, 'POST', {
      title: 'e2e-work', goal: 'Ship the feature', workflowId: 'full-build',
    });
    assert.equal(createRes.ok, true, `create work failed: ${JSON.stringify(createRes)}`);
    const workItemId = (createRes.data as { id: string }).id;

    // 2. Mark ready via HTTP (POST /work/:id/ready)
    const readyRes = await apiFetch(`${h.url}/work/${workItemId}/ready`, 'POST');
    assert.equal(readyRes.ok, true, `mark ready failed: ${JSON.stringify(readyRes)}`);

    // 3. Scheduler tick: stub returns blocked/checkpoint at 'confirm'
    await h.scheduler.tick();

    // 4. WorkItem should be needs_decision
    const stateRes = await apiFetch(`${h.url}/work/${workItemId}`);
    assert.equal(stateRes.ok, true);
    assert.equal((stateRes.data as { state: string }).state, 'needs_decision',
      `expected needs_decision after checkpoint tick — got: ${(stateRes.data as { state: string }).state}`);

    // 5. /attention should surface the Decision
    const attnRes = await apiFetch(`${h.url}/attention`);
    assert.equal(attnRes.ok, true);
    const items = attnRes.data as Array<{ category: string; decisionId?: string }>;
    const decisionItem = items.find(i => i.category === 'decision_required');
    assert.ok(decisionItem, `/attention should include a decision_required item — got: ${JSON.stringify(items)}`);
    assert.ok(decisionItem!.decisionId, '/attention item must carry decisionId');

    // 6. Resolve via HTTP with valid DecisionResolution (what the fixed dashboard sends)
    const resolveRes = await apiFetch(`${h.url}/decisions/${decisionItem!.decisionId}/resolve`, 'POST', {
      resolution: { selectedOptionId: 'approve', resolvedAt: new Date().toISOString() },
    });
    assert.equal(resolveRes.ok, true, `resolve failed: ${JSON.stringify(resolveRes)}`);

    // 7. WorkItem should now be in_review (ResumeService ran stub again → succeeded)
    const finalRes = await apiFetch(`${h.url}/work/${workItemId}`);
    assert.equal(finalRes.ok, true);
    assert.equal((finalRes.data as { state: string }).state, 'in_review',
      `expected in_review after resolve — got: ${(finalRes.data as { state: string }).state}`);

    // 8. /attention should be empty (no more pending items)
    const attnFinal = await apiFetch(`${h.url}/attention`);
    assert.equal(attnFinal.ok, true);
    const remaining = (attnFinal.data as unknown[]).filter(
      (i: unknown) => (i as { category: string }).category === 'decision_required',
    );
    assert.equal(remaining.length, 0, `no decision_required items should remain — got: ${JSON.stringify(attnFinal.data)}`);
  } finally {
    await h.stop();
  }
});

test('C2.ws: countByStateInWorkspace scopes correctly via repository', () => {
  const db = openDatabase(':memory:');
  const wsA = randomUUID();
  const wsB = randomUUID();
  const now = new Date().toISOString();

  new WorkspaceRepository(db).save({ id: wsA, name: 'a', createdAt: now });
  new WorkspaceRepository(db).save({ id: wsB, name: 'b', createdAt: now });

  const projA: Project = { id: randomUUID(), workspaceId: wsA, name: 'pA', status: 'active', priority: 0, createdAt: now, updatedAt: now };
  const projB: Project = { id: randomUUID(), workspaceId: wsB, name: 'pB', status: 'active', priority: 0, createdAt: now, updatedAt: now };
  new ProjectRepository(db).save(projA);
  new ProjectRepository(db).save(projB);

  const wsSvcA = new WorkService(db, wsA, {});
  const wsSvcB = new WorkService(db, wsB, {});

  // Create 2 running items in A, 3 failed in B
  for (let i = 0; i < 2; i++) {
    const wi = wsSvcA.createWorkItem({ projectId: projA.id, title: `a${i}`, goal: 'g', workflowId: 'full-build' });
    wsSvcA.markReady({ workItemId: wi.id });
    wsSvcA.startRunning({ workItemId: wi.id, workflowRunId: randomUUID() });
  }
  for (let i = 0; i < 3; i++) {
    const wi = wsSvcB.createWorkItem({ projectId: projB.id, title: `b${i}`, goal: 'g', workflowId: 'full-build' });
    wsSvcB.markReady({ workItemId: wi.id });
    wsSvcB.fail({ workItemId: wi.id, reason: 'err' });
  }

  const repo = new WorkItemRepository(db);

  // Scoped counts
  assert.equal(repo.countByStateInWorkspace(wsA, 'running'), 2);
  assert.equal(repo.countByStateInWorkspace(wsA, 'failed'), 0);
  assert.equal(repo.countByStateInWorkspace(wsB, 'running'), 0);
  assert.equal(repo.countByStateInWorkspace(wsB, 'failed'), 3);

  // Global (unscoped) still sees all
  assert.equal(repo.countAllByState('running'), 2);
  assert.equal(repo.countAllByState('failed'), 3);

  db.close();
});
