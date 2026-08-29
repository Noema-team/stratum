import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import type { WorkItem, WorkItemState, DomainEvent, Decision } from '../domain/index.js';
import type { PolicyEvaluation } from '../domain/policy.js';
import { isWorkItemTerminal } from '../domain/index.js';
import { WorkItemRepository, DecisionRepository, EventRepository } from '../storage/repositories.js';

// ============================================================================
// Transition table — explicit enumeration of every permitted edge.
// ============================================================================

type Transition = {
  from: WorkItemState | WorkItemState[];
  to: WorkItemState;
};

const TRANSITIONS: Transition[] = [
  // Forward path
  { from: 'draft',            to: 'ready' },
  { from: 'ready',            to: 'running' },
  { from: 'running',          to: 'in_review' },
  { from: 'in_review',        to: 'completed' },

  // Side-state entry (any non-terminal primary or side state may enter these)
  { from: ['draft', 'ready', 'running', 'in_review', 'paused'], to: 'needs_decision' },
  { from: ['draft', 'ready', 'running', 'in_review', 'paused', 'needs_decision'], to: 'blocked' },
  { from: ['draft', 'ready', 'running', 'in_review', 'needs_decision', 'blocked'], to: 'paused' },

  // Recovery from side states
  { from: 'needs_decision',   to: 'running' },   // decision resolved, run continues
  { from: 'needs_decision',   to: 'in_review' }, // decision resolved, work is reviewed
  { from: 'needs_decision',   to: 'blocked' },   // decision resolved but blocked remains
  { from: 'blocked',          to: 'ready' },     // dependency or obstruction cleared
  { from: 'blocked',          to: 'running' },   // obstruction cleared mid-run
  { from: 'paused',           to: 'ready' },     // resumed, not yet started
  { from: 'paused',           to: 'running' },   // resumed, execution continues

  // Terminal (any non-terminal state may reach these)
  { from: ['draft', 'ready', 'running', 'in_review', 'needs_decision', 'blocked', 'paused'], to: 'failed' },
  { from: ['draft', 'ready', 'running', 'in_review', 'needs_decision', 'blocked', 'paused'], to: 'cancelled' },
];

function isTransitionAllowed(from: WorkItemState, to: WorkItemState): boolean {
  for (const t of TRANSITIONS) {
    const froms = Array.isArray(t.from) ? t.from : [t.from];
    if (froms.includes(from) && t.to === to) return true;
  }
  return false;
}

// ============================================================================
// Error types
// ============================================================================

export class WorkServiceError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'WorkServiceError';
  }
}

// ============================================================================
// Transition request shapes
// ============================================================================

export interface ReadyRequest {
  workItemId: string;
}

export interface RunRequest {
  workItemId: string;
  /** Guard: all blocking dependencies must be completed before dispatch */
  dependencyOverride?: boolean;
}

export interface InReviewRequest {
  workItemId: string;
}

export interface CompleteRequest {
  workItemId: string;
}

export interface NeedsDecisionRequest {
  workItemId: string;
  /** The decision to mint and link */
  decision: Omit<Decision, 'id' | 'projectId' | 'workItemId' | 'status'>;
}

export interface BlockRequest {
  workItemId: string;
  reason: string;
}

export interface PauseRequest {
  workItemId: string;
}

export interface ResumeRequest {
  workItemId: string;
  /** If true, go directly to running; otherwise go to ready */
  resumeRunning?: boolean;
}

export interface CancelRequest {
  workItemId: string;
  reason?: string;
}

export interface FailRequest {
  workItemId: string;
  reason: string;
}

// ============================================================================
// WorkService
// ============================================================================

export interface WorkServiceOptions {
  // When provided, WorkService.complete() calls this to verify evidence policy.
  // If the guard returns 'deny', the transition is rejected with EVIDENCE_POLICY_DENIED.
  evidenceGuard?: (workItem: WorkItem) => PolicyEvaluation;
}

export class WorkService {
  private readonly items: WorkItemRepository;
  private readonly decisions: DecisionRepository;
  private readonly events: EventRepository;
  private readonly evidenceGuard?: (workItem: WorkItem) => PolicyEvaluation;

  constructor(
    private readonly db: Database.Database,
    private readonly workspaceId: string,
    opts: WorkServiceOptions = {},
  ) {
    this.items = new WorkItemRepository(db);
    this.decisions = new DecisionRepository(db);
    this.events = new EventRepository(db);
    this.evidenceGuard = opts.evidenceGuard;
  }

  // --------------------------------------------------------------------------
  // Forward path transitions
  // --------------------------------------------------------------------------

  markReady(req: ReadyRequest): WorkItem {
    return this.transition(req.workItemId, 'ready', {
      guardFn: () => {},
      eventType: 'work.ready',
    });
  }

  startRunning(req: RunRequest): WorkItem {
    return this.transition(req.workItemId, 'running', {
      guardFn: (item) => {
        if (!req.dependencyOverride) {
          this.assertDependenciesCompleted(item);
        }
      },
      eventType: 'work.started',
    });
  }

  markInReview(req: InReviewRequest): WorkItem {
    return this.transition(req.workItemId, 'in_review', {
      guardFn: () => {},
      eventType: 'work.state_changed',
      extraPayload: { to: 'in_review' },
    });
  }

  complete(req: CompleteRequest): WorkItem {
    return this.transition(req.workItemId, 'completed', {
      guardFn: (item) => {
        this.assertNoPendingDecisions(item);
        if (this.evidenceGuard) {
          const evaluation = this.evidenceGuard(item);
          if (evaluation.outcome !== 'allow') {
            throw new WorkServiceError(
              `Completion blocked by evidence policy: ${evaluation.reason}`,
              'EVIDENCE_POLICY_DENIED',
            );
          }
        }
      },
      eventType: 'work.completed',
    });
  }

  // --------------------------------------------------------------------------
  // Side-state transitions
  // --------------------------------------------------------------------------

  needsDecision(req: NeedsDecisionRequest): { workItem: WorkItem; decision: Decision } {
    const item = this.loadItem(req.workItemId);
    this.assertTransitionAllowed(item.state, 'needs_decision');
    this.assertNotTerminal(item.state);

    const decision: Decision = {
      id: randomUUID(),
      projectId: item.projectId,
      workItemId: item.id,
      status: 'pending',
      ...req.decision,
    };

    const updated = this.db.transaction((): WorkItem => {
      this.decisions.save(decision);
      const wi = this.applyTransition(item, 'needs_decision');
      this.appendEvent(wi, 'decision.requested', {
        decisionId: decision.id,
        decisionType: decision.type,
      });
      return wi;
    })();

    return { workItem: updated, decision };
  }

  block(req: BlockRequest): WorkItem {
    return this.transition(req.workItemId, 'blocked', {
      guardFn: () => {},
      eventType: 'work.state_changed',
      extraPayload: { to: 'blocked', reason: req.reason },
    });
  }

  pause(req: PauseRequest): WorkItem {
    return this.transition(req.workItemId, 'paused', {
      guardFn: () => {},
      eventType: 'work.state_changed',
      extraPayload: { to: 'paused' },
    });
  }

  resume(req: ResumeRequest): WorkItem {
    const item = this.loadItem(req.workItemId);
    if (item.state !== 'paused') {
      throw new WorkServiceError(
        `Cannot resume WorkItem in state '${item.state}' — must be paused`,
        'INVALID_STATE',
      );
    }
    const to: WorkItemState = req.resumeRunning ? 'running' : 'ready';
    this.assertTransitionAllowed(item.state, to);

    return this.db.transaction((): WorkItem => {
      const wi = this.applyTransition(item, to);
      this.appendEvent(wi, 'work.state_changed', { to, resumed: true });
      return wi;
    })();
  }

  cancel(req: CancelRequest): WorkItem {
    return this.transition(req.workItemId, 'cancelled', {
      guardFn: () => {},
      eventType: 'work.state_changed',
      extraPayload: { to: 'cancelled', reason: req.reason },
    });
  }

  fail(req: FailRequest): WorkItem {
    return this.transition(req.workItemId, 'failed', {
      guardFn: () => {},
      eventType: 'work.state_changed',
      extraPayload: { to: 'failed', reason: req.reason },
    });
  }

  // --------------------------------------------------------------------------
  // Decision resolution — clears needs_decision and resumes
  // --------------------------------------------------------------------------

  resolveDecision(
    decisionId: string,
    resolution: Decision['resolution'],
    resumeTo: 'running' | 'in_review' | 'blocked' = 'running',
  ): { workItem: WorkItem; decision: Decision } {
    if (!resolution) throw new WorkServiceError('Resolution is required', 'MISSING_RESOLUTION');

    const decision = this.decisions.findById(decisionId);
    if (!decision) throw new WorkServiceError(`Decision '${decisionId}' not found`, 'NOT_FOUND');
    if (decision.status !== 'pending') {
      throw new WorkServiceError(
        `Decision '${decisionId}' is already '${decision.status}'`,
        'INVALID_STATUS',
      );
    }
    if (!decision.workItemId) {
      throw new WorkServiceError('Decision has no linked WorkItem', 'NO_WORK_ITEM');
    }

    const item = this.loadItem(decision.workItemId);
    if (item.state !== 'needs_decision') {
      throw new WorkServiceError(
        `WorkItem is in state '${item.state}', expected 'needs_decision'`,
        'INVALID_STATE',
      );
    }
    this.assertTransitionAllowed('needs_decision', resumeTo);

    const updated = this.db.transaction((): WorkItem => {
      this.decisions.updateStatus(decisionId, 'resolved', resolution);
      const wi = this.applyTransition(item, resumeTo);
      this.appendEvent(wi, 'decision.resolved', {
        decisionId,
        selectedOptionId: resolution.selectedOptionId,
        resumedTo: resumeTo,
      });
      return wi;
    })();

    const resolvedDecision = this.decisions.findById(decisionId)!;
    return { workItem: updated, decision: resolvedDecision };
  }

  // --------------------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------------------

  private loadItem(id: string): WorkItem {
    const item = this.items.findById(id);
    if (!item) throw new WorkServiceError(`WorkItem '${id}' not found`, 'NOT_FOUND');
    return item;
  }

  private assertNotTerminal(state: WorkItemState): void {
    if (isWorkItemTerminal(state)) {
      throw new WorkServiceError(
        `WorkItem is in terminal state '${state}' — no further transitions allowed`,
        'TERMINAL_STATE',
      );
    }
  }

  private assertTransitionAllowed(from: WorkItemState, to: WorkItemState): void {
    if (!isTransitionAllowed(from, to)) {
      throw new WorkServiceError(
        `Transition from '${from}' to '${to}' is not permitted`,
        'INVALID_TRANSITION',
      );
    }
  }

  private assertDependenciesCompleted(item: WorkItem): void {
    for (const depId of item.dependencies) {
      const dep = this.items.findById(depId);
      if (!dep) {
        throw new WorkServiceError(
          `Dependency '${depId}' not found`,
          'DEPENDENCY_NOT_FOUND',
        );
      }
      if (!isWorkItemTerminal(dep.state) || dep.state !== 'completed') {
        throw new WorkServiceError(
          `Dependency '${depId}' is in state '${dep.state}' — must be 'completed' before dispatch`,
          'DEPENDENCY_NOT_COMPLETED',
        );
      }
    }
  }

  private assertNoPendingDecisions(item: WorkItem): void {
    const pending = this.decisions.listPending(item.projectId).filter(d => d.workItemId === item.id);
    if (pending.length > 0) {
      throw new WorkServiceError(
        `WorkItem '${item.id}' has ${pending.length} unresolved Decision(s) — resolve them before completing`,
        'PENDING_DECISIONS',
      );
    }
  }

  private applyTransition(item: WorkItem, to: WorkItemState): WorkItem {
    const now = new Date().toISOString();
    this.items.updateState(item.id, to, now);
    return { ...item, state: to, updatedAt: now };
  }

  private appendEvent(
    item: WorkItem,
    type: string,
    extraPayload: Record<string, unknown> = {},
  ): void {
    const event: DomainEvent = {
      id: randomUUID(),
      schemaVersion: 1,
      type,
      workspaceId: this.workspaceId,
      projectId: item.projectId,
      workItemId: item.id,
      occurredAt: new Date().toISOString(),
      payload: { from: item.state, ...extraPayload },
    };
    this.events.append(event);
  }

  private transition(
    workItemId: string,
    to: WorkItemState,
    opts: {
      guardFn: (item: WorkItem) => void;
      eventType: string;
      extraPayload?: Record<string, unknown>;
    },
  ): WorkItem {
    const item = this.loadItem(workItemId);
    this.assertNotTerminal(item.state);
    this.assertTransitionAllowed(item.state, to);
    opts.guardFn(item);

    return this.db.transaction((): WorkItem => {
      const wi = this.applyTransition(item, to);
      this.appendEvent(wi, opts.eventType, { to, ...(opts.extraPayload ?? {}) });
      return wi;
    })();
  }
}
