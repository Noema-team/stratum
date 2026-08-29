import { test } from 'node:test';
// §29.4 End-to-end integration test — new control-plane stack (DDR-032)
//
// Exercises the full flow without a real claude binary:
//   WorkService.markReady() → Scheduler.tick() with echo adapter
//   → EvidenceService.record() → WorkService.complete()
//   → verify state, events, StepExecution all consistent.

import { openDatabase } from '../src/storage/database.js';
import { WorkService } from '../src/services/work-service.js';
import { EvidenceService } from '../src/services/evidence-service.js';
import { Scheduler } from '../src/scheduler/scheduler.js';
import { ExecutorRegistry } from '../src/execution/registry.js';
import { ClaudeCodeAdapter } from '../src/execution/claude-code-adapter.js';
import {
  WorkItemRepository,
  StepExecutionRepository,
  EventRepository,
  EvidenceRepository,
} from '../src/storage/repositories.js';
import type { WorkItem } from '../src/domain/index.js';
import type Database from 'better-sqlite3';

// ============================================================================
// Helpers
// ============================================================================

const WS = 'ws-e2e';
const PROJ = 'proj-e2e';

function makeDb(): Database.Database {
  return openDatabase(':memory:');
}

function seed(db: Database.Database): void {
  db.prepare("INSERT INTO workspaces (id, name, created_at) VALUES (?,?,?)").run(WS, 'E2E Workspace', new Date().toISOString());
  const now = new Date().toISOString();
  db.prepare("INSERT INTO projects (id, workspace_id, name, status, priority, created_at, updated_at) VALUES (?,?,?,?,?,?,?)").run(PROJ, WS, 'E2E Project', 'active', 0, now, now);
}

function makeItem(db: Database.Database, partial: Partial<WorkItem> = {}): WorkItem {
  const repo = new WorkItemRepository(db);
  const item: WorkItem = {
    id: crypto.randomUUID(),
    projectId: PROJ,
    workspaceId: WS,
    title: 'Integration test work item',
    goal: 'Write a hello world function',
    state: 'draft',
    priority: 'normal',
    workflowId: 'full-build',
    repositoryIds: [],
    dependencies: [],
    acceptanceCriteria: [{ description: 'Must return "hello"' }],
    constraints: [{ description: 'Use TypeScript' }],
    requiredEvidence: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...partial,
  };
  repo.save(item);
  return item;
}

// ============================================================================
// §29.4 Integration tests
// ============================================================================

// Full happy path: draft → ready → running (via Scheduler+echo) → in_review → completed.
test('testFullNewStackHappyPath', async () => {
  const db = makeDb();
  seed(db);

  // Use 'echo' as a stand-in binary — it exits 0 immediately.
  const adapter = new ClaudeCodeAdapter({ binaryPath: 'echo', defaultTimeoutMs: 5000 });
  const registry = new ExecutorRegistry();
  registry.register(adapter);

  const workService = new WorkService(db, WS);
  const scheduler = new Scheduler(db, WS, registry);
  const events = new EventRepository(db);
  const steps = new StepExecutionRepository(db);
  const items = new WorkItemRepository(db);

  // Create a work item and advance it to ready.
  const item = makeItem(db);
  workService.markReady({ workItemId: item.id });

  const beforeEvents = events.listByWorkspace(WS).length;

  // Scheduler tick dispatches it.
  const results = await scheduler.tick();
  if (results.length === 0) throw new Error('Scheduler must dispatch at least one item');

  const dispatchResult = results.find(r => r.workItemId === item.id);
  if (!dispatchResult) throw new Error(`No dispatch result for item ${item.id}`);
  if (dispatchResult.outcome !== 'dispatched') {
    throw new Error(`Expected dispatched, got ${dispatchResult.outcome}`);
  }

  // After echo exits 0, scheduler marks it in_review.
  const afterDispatch = items.findById(item.id);
  if (!afterDispatch) throw new Error('WorkItem disappeared after dispatch');
  if (afterDispatch.state !== 'in_review') {
    throw new Error(`Expected in_review after adapter success, got ${afterDispatch.state}`);
  }

  // StepExecution must exist and be in succeeded state.
  if (!dispatchResult.stepExecutionId) throw new Error('stepExecutionId missing from dispatch result');
  const step = steps.findById(dispatchResult.stepExecutionId);
  if (!step) throw new Error('StepExecution not recorded');
  if (step.state !== 'succeeded') throw new Error(`Expected StepExecution.state = succeeded, got ${step.state}`);
  if (step.executor !== 'claude-code') throw new Error(`Expected executor claude-code, got ${step.executor}`);

  // Events grew during dispatch.
  const afterEvents = events.listByWorkspace(WS).length;
  if (afterEvents <= beforeEvents) throw new Error('Events must grow during dispatch');

  // Complete the item.
  const completed = workService.complete({ workItemId: item.id });
  if (completed.state !== 'completed') throw new Error(`Expected completed, got ${completed.state}`);

  // Final event count must be even larger.
  const finalEvents = events.listByWorkspace(WS).length;
  if (finalEvents <= afterEvents) throw new Error('Events must grow on complete()');
});

// Evidence recorded after execution is queryable and linked to the work item.
test('testEvidenceRecordedDuringRun', async () => {
  const db = makeDb();
  seed(db);

  const adapter = new ClaudeCodeAdapter({ binaryPath: 'echo', defaultTimeoutMs: 5000 });
  const registry = new ExecutorRegistry();
  registry.register(adapter);

  const workService = new WorkService(db, WS);
  const evidenceService = new EvidenceService(db);
  const scheduler = new Scheduler(db, WS, registry);
  const evidenceRepo = new EvidenceRepository(db);

  const item = makeItem(db, { state: 'running' });

  const evidence = evidenceService.record({
    workItemId: item.id,
    type: 'test_pass',
    source: 'integration-test',
    status: 'passed',
    payload: { message: 'All tests pass' },
  });

  const listed = evidenceRepo.listByWorkItem(item.id);
  if (listed.length === 0) throw new Error('Evidence must be retrievable by work item');
  if (listed[0].type !== 'test_pass') throw new Error(`Evidence type must be preserved, got ${listed[0].type}`);
  if (listed[0].workItemId !== item.id) throw new Error('Evidence must be linked to work item');
});

// Scheduler skips items whose dependencies are unmet.
test('testSchedulerSkipsDependencyBlocked', async () => {
  const db = makeDb();
  seed(db);

  const adapter = new ClaudeCodeAdapter({ binaryPath: 'echo', defaultTimeoutMs: 5000 });
  const registry = new ExecutorRegistry();
  registry.register(adapter);

  const workService = new WorkService(db, WS);
  const scheduler = new Scheduler(db, WS, registry);
  const items = new WorkItemRepository(db);

  const dep = makeItem(db); // stays in draft — not completed
  const item = makeItem(db);

  // Link item → dep
  db.prepare("INSERT INTO work_dependencies (work_item_id, depends_on_id) VALUES (?,?)").run(item.id, dep.id);

  workService.markReady({ workItemId: item.id });

  const results = await scheduler.tick();
  const result = results.find(r => r.workItemId === item.id);

  // Item should be skipped due to unmet dependency.
  if (!result) throw new Error('Expected a dispatch result for blocked item');
  if (result.outcome !== 'skipped_deps') {
    throw new Error(`Expected skipped_deps, got ${result.outcome}`);
  }

  // Work item must remain in ready — not transitioned.
  const after = items.findById(item.id);
  if (!after) throw new Error('WorkItem disappeared');
  if (after.state !== 'ready') throw new Error(`Expected ready state preserved, got ${after.state}`);
});

// Scheduler dispatch failure → work item transitions to failed, not stuck.
test('testSchedulerFailureTransitionsToFailed', async () => {
  const db = makeDb();
  seed(db);

  // Use a binary that exits non-zero.
  const adapter = new ClaudeCodeAdapter({ binaryPath: 'sh', extraFlags: ['-c', 'exit 1'], defaultTimeoutMs: 5000 });
  const registry = new ExecutorRegistry();
  registry.register(adapter);

  const workService = new WorkService(db, WS);
  const scheduler = new Scheduler(db, WS, registry);
  const items = new WorkItemRepository(db);

  const item = makeItem(db);
  workService.markReady({ workItemId: item.id });

  await scheduler.tick();

  const after = items.findById(item.id);
  if (!after) throw new Error('WorkItem disappeared after failed dispatch');
  if (after.state !== 'failed') {
    throw new Error(`Expected failed state after adapter exit 1, got ${after.state}`);
  }
});

// State integrity: no WorkItem ends in an undefined or unknown state after any flow.
test('testStateIntegrityAfterDispatch', async () => {
  const db = makeDb();
  seed(db);

  const adapter = new ClaudeCodeAdapter({ binaryPath: 'echo', defaultTimeoutMs: 5000 });
  const registry = new ExecutorRegistry();
  registry.register(adapter);

  const workService = new WorkService(db, WS);
  const scheduler = new Scheduler(db, WS, registry);
  const workItems = new WorkItemRepository(db);

  const legalStates = new Set([
    'draft', 'ready', 'running', 'in_review',
    'needs_decision', 'blocked', 'paused',
    'completed', 'failed', 'cancelled',
  ]);

  // Create 3 items, dispatch all.
  for (let i = 0; i < 3; i++) {
    const item = makeItem(db);
    workService.markReady({ workItemId: item.id });
  }

  await scheduler.tick();

  const all = workItems.listByProject(PROJ);
  for (const wi of all) {
    if (!legalStates.has(wi.state)) {
      throw new Error(`WorkItem ${wi.id} ended in illegal state '${wi.state}'`);
    }
  }
});
