import { test } from 'node:test';
// §29.1 Invariant tests + §29.2 State-machine property tests (DDR-032)
//
// Each exported testXxx function exercises a named invariant from the spec.
// The tests are deterministic, in-memory, and require no running daemon.

import { openDatabase } from '../src/storage/database.js';
import { WorkService, WorkServiceError } from '../src/services/work-service.js';
import { WorkItemRepository, EventRepository, DecisionRepository } from '../src/storage/repositories.js';
import { isWorkItemTerminal } from '../src/domain/index.js';
import type { WorkItem, WorkItemState } from '../src/domain/index.js';
import type Database from 'better-sqlite3';

// ============================================================================
// Helpers
// ============================================================================

function makeDb(): Database.Database {
  return openDatabase(':memory:');
}

const WS = 'ws-invariant';
const PROJ = 'proj-invariant';

function seed(db: Database.Database): void {
  db.prepare("INSERT INTO workspaces (id, name, created_at) VALUES (?,?,?)").run(WS, 'Test', new Date().toISOString());
  const now = new Date().toISOString();
  db.prepare("INSERT INTO projects (id, workspace_id, name, status, priority, created_at, updated_at) VALUES (?,?,?,?,?,?,?)").run(PROJ, WS, 'Proj', 'active', 0, now, now);
}

function svc(db: Database.Database, opts: Parameters<typeof WorkService>[2] = {}): WorkService {
  return new WorkService(db, WS, opts);
}

function makeItem(db: Database.Database, partial: Partial<WorkItem> = {}): WorkItem {
  const repo = new WorkItemRepository(db);
  const item: WorkItem = {
    id: crypto.randomUUID(),
    projectId: PROJ,
    repositoryIds: [],
    title: 'Test work item',
    goal: 'Test goal',
    state: 'draft',
    priority: 0,
    workflowId: 'full-build',
    acceptanceCriteria: [],
    constraints: [],
    requiredEvidence: [],
    dependencies: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...partial,
  };
  repo.save(item);
  return item;
}

function assertThrows(fn: () => unknown, codeFragment?: string): void {
  let threw = false;
  try { fn(); } catch (e) {
    threw = true;
    if (codeFragment) {
      const code = e instanceof WorkServiceError ? e.code : String(e);
      if (!code.includes(codeFragment)) throw new Error(`Expected error code to include "${codeFragment}", got: ${code}`);
    }
  }
  if (!threw) throw new Error('Expected an error to be thrown but none was');
}

// ── All legal states ───────────────────────────────────────────────────────
const ALL_STATES: WorkItemState[] = [
  'draft', 'ready', 'running', 'in_review',
  'needs_decision', 'blocked', 'paused',
  'completed', 'failed', 'cancelled',
];
const TERMINAL_STATES: WorkItemState[] = ['completed', 'failed', 'cancelled'];
const NON_TERMINAL_STATES = ALL_STATES.filter(s => !TERMINAL_STATES.includes(s));

// ============================================================================
// §29.1 Invariant tests
// ============================================================================

// Invariant: "cancelled work never dispatches" — a cancelled item cannot be
// transitioned to running through any path.
test('testCancelledWorkNeverDispatches', async () => {
  const db = makeDb();
  seed(db);
  const s = svc(db);
  const item = makeItem(db);

  s.markReady({ workItemId: item.id });
  s.cancel({ workItemId: item.id, reason: 'test' });

  // Cannot go to ready
  assertThrows(() => s.markReady({ workItemId: item.id }), 'TERMINAL_STATE');
  // Cannot go to running
  assertThrows(() => s.startRunning({ workItemId: item.id }), 'TERMINAL_STATE');
});

// Invariant: "completed work cannot be executed again"
test('testCompletedWorkCannotBeReExecuted', async () => {
  const db = makeDb();
  seed(db);
  const s = svc(db);
  const item = makeItem(db, { state: 'in_review' });

  s.complete({ workItemId: item.id });

  assertThrows(() => s.markReady({ workItemId: item.id }), 'TERMINAL_STATE');
  assertThrows(() => s.startRunning({ workItemId: item.id }), 'TERMINAL_STATE');
  assertThrows(() => s.pause({ workItemId: item.id }), 'TERMINAL_STATE');
});

// Invariant: "state changes emit durable events" — every transition must
// produce at least one event record in the DB.
test('testEveryTransitionEmitsDurableEvent', async () => {
  const db = makeDb();
  seed(db);
  const s = svc(db);
  const events = new EventRepository(db);

  const item = makeItem(db);
  const before = events.listByWorkspace(WS).length;

  s.markReady({ workItemId: item.id });
  const after = events.listByWorkspace(WS).length;

  if (after <= before) throw new Error('markReady must emit at least one durable event');
});

// Invariant: "duplicate events do not duplicate side effects" — calling the
// same transition twice on a terminal item must error, not silently create
// a second event.
test('testDuplicateTransitionOnTerminalErrors', async () => {
  const db = makeDb();
  seed(db);
  const s = svc(db);
  const item = makeItem(db, { state: 'in_review' });

  s.complete({ workItemId: item.id });
  const events = new EventRepository(db);
  const countAfterFirst = events.listByWorkspace(WS).length;

  assertThrows(() => s.complete({ workItemId: item.id }), 'TERMINAL_STATE');
  const countAfterSecond = events.listByWorkspace(WS).length;

  if (countAfterSecond !== countAfterFirst) {
    throw new Error('Failed transition must not emit additional events');
  }
});

// Invariant: "blocked dependencies prevent dispatch" — a work item with an
// incomplete dependency cannot transition to running.
test('testBlockedDependencyPreventsDispatch', async () => {
  const db = makeDb();
  seed(db);
  const s = svc(db);

  const dep = makeItem(db); // starts in draft — not completed
  const item = makeItem(db);

  // Link item → dep
  db.prepare("INSERT INTO work_dependencies (work_item_id, depends_on_id) VALUES (?,?)").run(item.id, dep.id);

  s.markReady({ workItemId: item.id });
  assertThrows(() => s.startRunning({ workItemId: item.id }), 'DEPENDENCY');
});

// Invariant: dependency check is lifted when the dependency completes.
test('testDependencyClearedAllowsDispatch', async () => {
  const db = makeDb();
  seed(db);
  const s = svc(db);

  const dep = makeItem(db, { state: 'in_review' });
  const item = makeItem(db);

  db.prepare("INSERT INTO work_dependencies (work_item_id, depends_on_id) VALUES (?,?)").run(item.id, dep.id);

  s.complete({ workItemId: dep.id });
  s.markReady({ workItemId: item.id });
  // Should NOT throw — dependency is now complete
  s.startRunning({ workItemId: item.id });
});

// Invariant: "completion cannot occur without required evidence" — when an
// evidence guard is installed, complete() must reject if it returns 'deny'.
test('testCompletionRequiresEvidence', async () => {
  const db = makeDb();
  seed(db);
  const s = svc(db, {
    evidenceGuard: () => ({ outcome: 'deny', reason: 'CI evidence missing' }),
  });

  const item = makeItem(db, { state: 'in_review' });
  assertThrows(() => s.complete({ workItemId: item.id }), 'EVIDENCE_POLICY_DENIED');
});

// Invariant: when evidence guard allows, completion proceeds.
test('testCompletionAllowedWhenEvidencePresent', async () => {
  const db = makeDb();
  seed(db);
  const s = svc(db, {
    evidenceGuard: () => ({ outcome: 'allow' }),
  });

  const item = makeItem(db, { state: 'in_review' });
  const result = s.complete({ workItemId: item.id });
  if (result.state !== 'completed') throw new Error(`Expected completed, got ${result.state}`);
});

// Invariant: "executor failure cannot corrupt work state" — fail() on a
// running item moves it to failed, not into an undefined state.
test('testExecutorFailureProducesFailedState', async () => {
  const db = makeDb();
  seed(db);
  const s = svc(db);

  const item = makeItem(db, { state: 'running' });
  const result = s.fail({ workItemId: item.id, reason: 'executor crash' });

  if (result.state !== 'failed') throw new Error(`Expected failed, got ${result.state}`);
  if (!isWorkItemTerminal(result.state)) throw new Error('failed must be a terminal state');
});

// Invariant: fail() requires a reason.
test('testFailRequiresReason', async () => {
  const db = makeDb();
  seed(db);
  const s = svc(db);
  const item = makeItem(db, { state: 'running' });

  assertThrows(() => s.fail({ workItemId: item.id, reason: '' }));
});

// Invariant: needsDecision mints exactly one Decision record.
test('testNeedsDecisionMintsExactlyOneDecision', async () => {
  const db = makeDb();
  seed(db);
  const s = svc(db);
  const item = makeItem(db, { state: 'running' });
  const decisions = new DecisionRepository(db);

  const before = decisions.listByWorkItem(item.id).length;
  s.needsDecision({
    workItemId: item.id,
    decision: {
      type: 'checkpoint',
      title: 'Review required',
      summary: 'Please review',
      subjectRef: { workItemId: item.id },
      options: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }],
      impact: 'low',
      reversibility: 'easy',
      urgency: 'blocking',
    },
  });
  const after = decisions.listByWorkItem(item.id).length;

  if (after !== before + 1) throw new Error(`Expected exactly 1 new decision, got ${after - before}`);
});

// Invariant: resolving a decision on a pending item transitions it back to running.
test('testResolveDecisionRestoresRunning', async () => {
  const db = makeDb();
  seed(db);
  const s = svc(db);
  const item = makeItem(db, { state: 'running' });

  const { decision } = s.needsDecision({
    workItemId: item.id,
    decision: {
      type: 'checkpoint',
      title: 'Approve',
      summary: 'Go ahead?',
      subjectRef: { workItemId: item.id },
      options: [{ id: 'approve', label: 'Approve' }],
      impact: 'low',
      reversibility: 'easy',
      urgency: 'blocking',
    },
  });

  const { workItem } = s.resolveDecision(
    decision.id,
    { selectedOptionId: 'approve', resolvedAt: new Date().toISOString() },
    'running',
  );
  if (workItem.state !== 'running') throw new Error(`Expected running after resolve, got ${workItem.state}`);
});

// ============================================================================
// §29.2 State-machine property tests
// ============================================================================

// Property: isWorkItemTerminal is consistent with what the transition table allows.
test('testTerminalStatesAreImmovable', async () => {
  const db = makeDb();
  seed(db);

  for (const state of TERMINAL_STATES) {
    if (!isWorkItemTerminal(state)) {
      throw new Error(`isWorkItemTerminal(${state}) should be true`);
    }
  }

  for (const state of NON_TERMINAL_STATES) {
    if (isWorkItemTerminal(state)) {
      throw new Error(`isWorkItemTerminal(${state}) should be false`);
    }
  }
});

// Property: any non-terminal state can reach 'cancelled'.
test('testAnyCancellableStateCanBeCancelled', async () => {
  const cancellable: WorkItemState[] = [
    'draft', 'ready', 'running', 'in_review', 'needs_decision', 'blocked', 'paused',
  ];

  for (const state of cancellable) {
    const db = makeDb();
    seed(db);
    const s = svc(db);
    const item = makeItem(db, { state });
    const result = s.cancel({ workItemId: item.id, reason: 'test' });
    if (result.state !== 'cancelled') {
      throw new Error(`cancel() from '${state}' produced '${result.state}' instead of 'cancelled'`);
    }
  }
});

// Property: any non-terminal state can reach 'failed'.
test('testAnyNonTerminalStateCanFail', async () => {
  const failable: WorkItemState[] = [
    'draft', 'ready', 'running', 'in_review', 'needs_decision', 'blocked', 'paused',
  ];

  for (const state of failable) {
    const db = makeDb();
    seed(db);
    const s = svc(db);
    const item = makeItem(db, { state });
    const result = s.fail({ workItemId: item.id, reason: 'error' });
    if (result.state !== 'failed') {
      throw new Error(`fail() from '${state}' produced '${result.state}' instead of 'failed'`);
    }
  }
});

// Property: terminal states reject every transition (fail, cancel, pause, etc.).
test('testTerminalStatesRejectAllTransitions', async () => {
  const terminals: WorkItemState[] = ['completed', 'failed', 'cancelled'];

  for (const state of terminals) {
    const db = makeDb();
    seed(db);
    const s = svc(db);
    const item = makeItem(db, { state });

    assertThrows(() => s.markReady({ workItemId: item.id }), 'TERMINAL_STATE');
    assertThrows(() => s.cancel({ workItemId: item.id }), 'TERMINAL_STATE');
    assertThrows(() => s.pause({ workItemId: item.id }), 'TERMINAL_STATE');
    assertThrows(() => s.fail({ workItemId: item.id, reason: 'x' }), 'TERMINAL_STATE');
  }
});

// Property: paused → resume → ready OR running; never skips states.
test('testResumeFromPausedProducesLegalTargetState', async () => {
  const db1 = makeDb();
  seed(db1);
  const s1 = svc(db1);
  const item1 = makeItem(db1, { state: 'paused' });
  const r1 = s1.resume({ workItemId: item1.id, resumeRunning: false });
  if (r1.state !== 'ready') throw new Error(`resume(resumeRunning=false) → expected ready, got ${r1.state}`);

  const db2 = makeDb();
  seed(db2);
  const s2 = svc(db2);
  const item2 = makeItem(db2, { state: 'paused' });
  const r2 = s2.resume({ workItemId: item2.id, resumeRunning: true });
  if (r2.state !== 'running') throw new Error(`resume(resumeRunning=true) → expected running, got ${r2.state}`);
});

// Property: every state transition is recorded — the event log is monotonically growing.
test('testEventLogGrowsMonotonically', async () => {
  const db = makeDb();
  seed(db);
  const s = svc(db);
  const events = new EventRepository(db);
  const item = makeItem(db);

  const counts: number[] = [];
  counts.push(events.listByWorkspace(WS).length);

  s.markReady({ workItemId: item.id });
  counts.push(events.listByWorkspace(WS).length);

  s.startRunning({ workItemId: item.id });
  counts.push(events.listByWorkspace(WS).length);

  s.pause({ workItemId: item.id });
  counts.push(events.listByWorkspace(WS).length);

  s.resume({ workItemId: item.id });
  counts.push(events.listByWorkspace(WS).length);

  for (let i = 1; i < counts.length; i++) {
    if (counts[i] <= counts[i - 1]) {
      throw new Error(`Event count did not grow: ${counts[i - 1]} → ${counts[i]}`);
    }
  }
});

// Property: schema validity — WorkItem fields are never null/undefined after a transition.
test('testTransitionPreservesSchemaValidity', async () => {
  const db = makeDb();
  seed(db);
  const s = svc(db);
  const item = makeItem(db);

  const result = s.markReady({ workItemId: item.id });

  if (!result.id) throw new Error('id missing after transition');
  if (!result.projectId) throw new Error('projectId missing after transition');
  if (!result.state) throw new Error('state missing after transition');
  if (!result.updatedAt) throw new Error('updatedAt missing after transition');
  if (!result.createdAt) throw new Error('createdAt missing after transition');
});

// Property: unknown work item raises a not-found error, not an unhandled crash.
test('testUnknownWorkItemRaisesNotFound', async () => {
  const db = makeDb();
  seed(db);
  const s = svc(db);

  assertThrows(() => s.markReady({ workItemId: 'does-not-exist' }));
});
