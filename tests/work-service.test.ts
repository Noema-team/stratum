import { test } from 'node:test';
import { strict as assert } from 'assert';
import { randomUUID } from 'crypto';
import { openDatabase } from '../src/storage/database.js';
import {
  WorkspaceRepository,
  ProjectRepository,
  WorkItemRepository,
  DecisionRepository,
  EventRepository,
} from '../src/storage/repositories.js';
import { WorkService, WorkServiceError } from '../src/services/work-service.js';
import type { Workspace, Project, WorkItem } from '../src/domain/index.js';

// ============================================================================
// Fixtures
// ============================================================================

const WS_ID = '00000000-0000-0000-0000-000000000001';
const PROJ_ID = '00000000-0000-0000-0000-000000000002';
const NOW = new Date().toISOString();

const WORKSPACE: Workspace = { id: WS_ID, name: 'Test', createdAt: NOW };
const PROJECT: Project = {
  id: PROJ_ID, workspaceId: WS_ID, name: 'P1',
  status: 'active', priority: 0, createdAt: NOW, updatedAt: NOW,
};

function makeItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: randomUUID(),
    projectId: PROJ_ID,
    repositoryIds: [],
    title: 'Test item', goal: 'Do something',
    workflowId: 'draft-artifact',
    state: 'draft',
    priority: 0,
    acceptanceCriteria: [], constraints: [], requiredEvidence: [],
    dependencies: [],
    createdAt: NOW, updatedAt: NOW,
    ...overrides,
  };
}

function makeDecisionPayload() {
  return {
    type: 'checkpoint' as const,
    subjectRef: { workflowRunId: 'run-1', stepId: 'confirm' },
    title: 'Confirm scope',
    summary: 'Please confirm',
    options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }],
    impact: 'medium' as const,
    reversibility: 'easy' as const,
    urgency: 'blocking' as const,
  };
}

function setup() {
  const db = openDatabase(':memory:');
  const workspaces = new WorkspaceRepository(db);
  const projects = new ProjectRepository(db);
  const items = new WorkItemRepository(db);
  const events = new EventRepository(db);
  const decisions = new DecisionRepository(db);
  const svc = new WorkService(db, WS_ID);

  workspaces.save(WORKSPACE);
  projects.save(PROJECT);

  return { db, items, events, decisions, svc };
}

// ============================================================================
// Forward path: draft → ready → running → in_review → completed
// ============================================================================

test('testForwardLifecycle', () => {
  const { items, svc } = setup();
  const item = makeItem();
  items.save(item);

  const ready = svc.markReady({ workItemId: item.id });
  assert.equal(ready.state, 'ready');

  const running = svc.startRunning({ workItemId: item.id });
  assert.equal(running.state, 'running');

  const inReview = svc.markInReview({ workItemId: item.id });
  assert.equal(inReview.state, 'in_review');

  const completed = svc.complete({ workItemId: item.id });
  assert.equal(completed.state, 'completed');
});

test('testStatePersistedAfterTransition', () => {
  const { items, svc } = setup();
  const item = makeItem();
  items.save(item);

  svc.markReady({ workItemId: item.id });
  const loaded = items.findById(item.id);
  assert.equal(loaded?.state, 'ready');
});

// ============================================================================
// Terminal state guard
// ============================================================================

test('testNoTransitionFromCompleted', () => {
  const { items, svc } = setup();
  const item = makeItem({ state: 'completed' });
  items.save(item);

  assert.throws(
    () => svc.cancel({ workItemId: item.id }),
    (e: WorkServiceError) => e.code === 'TERMINAL_STATE',
  );
});

test('testNoTransitionFromCancelled', () => {
  const { items, svc } = setup();
  const item = makeItem({ state: 'cancelled' });
  items.save(item);

  assert.throws(
    () => svc.fail({ workItemId: item.id, reason: 'late' }),
    (e: WorkServiceError) => e.code === 'TERMINAL_STATE',
  );
});

test('testNoTransitionFromFailed', () => {
  const { items, svc } = setup();
  const item = makeItem({ state: 'failed' });
  items.save(item);

  assert.throws(
    () => svc.markReady({ workItemId: item.id }),
    (e: WorkServiceError) => e.code === 'TERMINAL_STATE',
  );
});

// ============================================================================
// Invalid transitions
// ============================================================================

test('testCannotSkipReadyToRunning', () => {
  const { items, svc } = setup();
  const item = makeItem({ state: 'draft' });
  items.save(item);

  assert.throws(
    () => svc.startRunning({ workItemId: item.id }),
    (e: WorkServiceError) => e.code === 'INVALID_TRANSITION',
  );
});

test('testCannotCompleteFromRunning', () => {
  const { items, svc } = setup();
  const item = makeItem({ state: 'running' });
  items.save(item);

  assert.throws(
    () => svc.complete({ workItemId: item.id }),
    (e: WorkServiceError) => e.code === 'INVALID_TRANSITION',
  );
});

// ============================================================================
// Dependency guard
// ============================================================================

test('testDependencyMustBeCompletedBeforeDispatch', () => {
  const { items, svc } = setup();

  const dep = makeItem({ state: 'running' });
  items.save(dep);

  const item = makeItem({ state: 'ready', dependencies: [dep.id] });
  items.save(item);

  assert.throws(
    () => svc.startRunning({ workItemId: item.id }),
    (e: WorkServiceError) => e.code === 'DEPENDENCY_NOT_COMPLETED',
  );
});

test('testDependencyOverrideBypassesCheck', () => {
  const { items, svc } = setup();

  const dep = makeItem({ state: 'running' });
  items.save(dep);

  const item = makeItem({ state: 'ready', dependencies: [dep.id] });
  items.save(item);

  const running = svc.startRunning({ workItemId: item.id, dependencyOverride: true });
  assert.equal(running.state, 'running');
});

test('testDispatchAllowedWhenDependencyCompleted', () => {
  const { items, svc } = setup();

  const dep = makeItem({ state: 'completed' });
  items.save(dep);

  const item = makeItem({ state: 'ready', dependencies: [dep.id] });
  items.save(item);

  const running = svc.startRunning({ workItemId: item.id });
  assert.equal(running.state, 'running');
});

// ============================================================================
// Side states
// ============================================================================

test('testPauseAndResume', () => {
  const { items, svc } = setup();
  const item = makeItem({ state: 'running' });
  items.save(item);

  const paused = svc.pause({ workItemId: item.id });
  assert.equal(paused.state, 'paused');

  const resumed = svc.resume({ workItemId: item.id });
  assert.equal(resumed.state, 'ready');
});

test('testPauseAndResumeRunning', () => {
  const { items, svc } = setup();
  const item = makeItem({ state: 'running' });
  items.save(item);

  svc.pause({ workItemId: item.id });
  const running = svc.resume({ workItemId: item.id, resumeRunning: true });
  assert.equal(running.state, 'running');
});

test('testResumeOnlyAllowedFromPaused', () => {
  const { items, svc } = setup();
  const item = makeItem({ state: 'running' });
  items.save(item);

  assert.throws(
    () => svc.resume({ workItemId: item.id }),
    (e: WorkServiceError) => e.code === 'INVALID_STATE',
  );
});

test('testBlockAndUnblock', () => {
  const { items, svc } = setup();
  const item = makeItem({ state: 'running' });
  items.save(item);

  const blocked = svc.block({ workItemId: item.id, reason: 'CI down' });
  assert.equal(blocked.state, 'blocked');

  const ready = svc.markReady({ workItemId: item.id });
  assert.equal(ready.state, 'ready');
});

test('testCancelFromAnyNonTerminal', () => {
  const { items, svc } = setup();

  for (const state of ['draft', 'ready', 'running', 'in_review', 'paused', 'blocked', 'needs_decision'] as const) {
    const item = makeItem({ state });
    items.save(item);
    const cancelled = svc.cancel({ workItemId: item.id });
    assert.equal(cancelled.state, 'cancelled', `cancel from '${state}' should work`);
  }
});

test('testFailFromAnyNonTerminal', () => {
  const { items, svc } = setup();

  for (const state of ['draft', 'ready', 'running', 'in_review', 'paused', 'blocked', 'needs_decision'] as const) {
    const item = makeItem({ state });
    items.save(item);
    const failed = svc.fail({ workItemId: item.id, reason: 'error' });
    assert.equal(failed.state, 'failed', `fail from '${state}' should work`);
  }
});

// ============================================================================
// needs_decision + decision resolution
// ============================================================================

test('testNeedsDecisionMintsDecision', () => {
  const { items, svc } = setup();
  const item = makeItem({ state: 'running' });
  items.save(item);

  const { workItem, decision } = svc.needsDecision({
    workItemId: item.id,
    decision: makeDecisionPayload(),
  });

  assert.equal(workItem.state, 'needs_decision');
  assert.equal(decision.status, 'pending');
  assert.equal(decision.workItemId, item.id);
});

test('testResolveDecisionResumesItem', () => {
  const { items, svc } = setup();
  const item = makeItem({ state: 'running' });
  items.save(item);

  const { decision } = svc.needsDecision({
    workItemId: item.id,
    decision: makeDecisionPayload(),
  });

  const { workItem: resumed, decision: resolved } = svc.resolveDecision(
    decision.id,
    { selectedOptionId: 'yes', resolvedAt: new Date().toISOString() },
    'running',
  );

  assert.equal(resumed.state, 'running');
  assert.equal(resolved.status, 'resolved');
});

test('testCannotResolveAlreadyResolvedDecision', () => {
  const { items, svc } = setup();
  const item = makeItem({ state: 'running' });
  items.save(item);

  const { decision } = svc.needsDecision({
    workItemId: item.id,
    decision: makeDecisionPayload(),
  });

  svc.resolveDecision(decision.id, { selectedOptionId: 'yes', resolvedAt: new Date().toISOString() });

  assert.throws(
    () => svc.resolveDecision(decision.id, { selectedOptionId: 'yes', resolvedAt: new Date().toISOString() }),
    (e: WorkServiceError) => e.code === 'INVALID_STATUS',
  );
});

test('testCompletionBlockedByPendingDecision', () => {
  const { items, svc } = setup();
  const item = makeItem({ state: 'running' });
  items.save(item);

  svc.needsDecision({ workItemId: item.id, decision: makeDecisionPayload() });
  // item is now needs_decision; transition to in_review via resolveDecision then try to complete
  // without resolving, complete on needs_decision should fail (INVALID_TRANSITION first)
  assert.throws(
    () => svc.complete({ workItemId: item.id }),
    (e: WorkServiceError) => e.code === 'INVALID_TRANSITION',
  );
});

test('testCompletionBlockedByPendingDecisionFromInReview', () => {
  const { items, decisions, svc } = setup();
  const item = makeItem({ state: 'running' });
  items.save(item);

  svc.markInReview({ workItemId: item.id });

  // Inject a pending decision directly without changing work item state
  decisions.save({
    id: randomUUID(),
    projectId: PROJ_ID,
    workItemId: item.id,
    type: 'checkpoint',
    subjectRef: { workflowRunId: 'run-1', stepId: 'confirm' },
    title: 'Pending gate',
    summary: 'Needs resolution',
    options: [{ id: 'yes', label: 'Yes' }],
    impact: 'medium',
    reversibility: 'easy',
    urgency: 'blocking',
    status: 'pending',
  });

  // complete() should throw because there's a pending decision
  assert.throws(
    () => svc.complete({ workItemId: item.id }),
    (e: WorkServiceError) => e.code === 'PENDING_DECISIONS',
  );
});

// ============================================================================
// Event emission
// ============================================================================

test('testEventsEmittedOnTransition', () => {
  const { items, events, svc } = setup();
  const item = makeItem();
  items.save(item);

  svc.markReady({ workItemId: item.id });
  svc.startRunning({ workItemId: item.id });
  svc.markInReview({ workItemId: item.id });
  svc.complete({ workItemId: item.id });

  const log = events.listByWorkItem(item.id);
  assert.equal(log.length, 4, 'one event per transition');

  const types = log.map(e => e.type);
  assert.ok(types.includes('work.ready'));
  assert.ok(types.includes('work.started'));
  assert.ok(types.includes('work.state_changed'));
  assert.ok(types.includes('work.completed'));
});

test('testEventWorkspaceAndProjectLinked', () => {
  const { items, events, svc } = setup();
  const item = makeItem();
  items.save(item);

  svc.markReady({ workItemId: item.id });

  const log = events.listByWorkspace(WS_ID);
  assert.ok(log.length > 0);
  const ev = log[0];
  assert.equal(ev.workspaceId, WS_ID);
  assert.equal(ev.projectId, PROJ_ID);
  assert.equal(ev.workItemId, item.id);
});

// ============================================================================
// Not-found guard
// ============================================================================

test('testNotFoundThrows', () => {
  const { svc } = setup();

  assert.throws(
    () => svc.markReady({ workItemId: '00000000-0000-0000-0000-000000000099' }),
    (e: WorkServiceError) => e.code === 'NOT_FOUND',
  );
});
