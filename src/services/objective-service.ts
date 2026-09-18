import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import type { ZodError } from 'zod';
import type { Objective, ObjectiveStatus, DomainEvent } from '../domain/index.js';
import { ObjectiveSchema } from '../domain/index.js';
import { ObjectiveRepository, ProjectRepository, EventRepository } from '../storage/repositories.js';

// ============================================================================
// D.2 — ObjectiveService
//
// Objective is the durable human-intent container above WorkItems:
//   Project -> Objective -> WorkItems
// Objective answers "what outcome are we pursuing?"; a WorkItem answers
// "what bounded work has been authorized?". This service does not decide
// what work exists — it only owns the Objective's own small lifecycle
// (draft -> active -> completed, or -> cancelled), already fully declared
// by ObjectiveStatusEnum and the objectives table's CHECK constraint. No
// new lifecycle is introduced here — these three guarded methods are the
// first thing to enforce transitions that were already legal in the schema.
// ============================================================================

export class ObjectiveServiceError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'ObjectiveServiceError';
  }
}

export interface CreateObjectiveRequest {
  projectId: string;
  title: string;
  description: string;
  priority?: number;
  constraints?: Objective['constraints'];
  successCriteria?: Objective['successCriteria'];
}

// Every edge already implied by ObjectiveStatusEnum + the objectives table's
// CHECK constraint — draft is the entry state; completed/cancelled are terminal.
const OBJECTIVE_TRANSITIONS: Record<ObjectiveStatus, ObjectiveStatus[]> = {
  draft: ['active', 'cancelled'],
  active: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

export class ObjectiveService {
  private readonly objectives: ObjectiveRepository;
  private readonly projects: ProjectRepository;
  private readonly events: EventRepository;

  constructor(
    private readonly db: Database.Database,
    private readonly workspaceId: string,
  ) {
    this.objectives = new ObjectiveRepository(db);
    this.projects = new ProjectRepository(db);
    this.events = new EventRepository(db);
  }

  // --------------------------------------------------------------------------
  // Create
  // --------------------------------------------------------------------------

  create(req: CreateObjectiveRequest): Objective {
    if (!req.title?.trim()) {
      throw new ObjectiveServiceError('title is required and must be non-empty', 'INVALID_TITLE');
    }
    if (!req.description?.trim()) {
      throw new ObjectiveServiceError('description is required and must be non-empty', 'INVALID_DESCRIPTION');
    }
    if (req.priority !== undefined && (!Number.isInteger(req.priority) || req.priority < 0)) {
      throw new ObjectiveServiceError('priority must be a non-negative integer', 'INVALID_PRIORITY');
    }

    const project = this.projects.findById(req.projectId);
    if (!project) {
      throw new ObjectiveServiceError(`Project '${req.projectId}' not found`, 'NOT_FOUND');
    }
    if (project.workspaceId !== this.workspaceId) {
      throw new ObjectiveServiceError(
        `Project '${req.projectId}' does not belong to this workspace`,
        'WORKSPACE_MISMATCH',
      );
    }

    const now = new Date().toISOString();
    const candidate: Objective = {
      id: randomUUID(),
      projectId: req.projectId,
      title: req.title.trim(),
      description: req.description.trim(),
      priority: req.priority ?? 0,
      status: 'draft',
      constraints: req.constraints ?? [],
      successCriteria: req.successCriteria ?? [],
      createdAt: now,
      updatedAt: now,
    };

    // D.2.1 — the HTTP handler only checks that constraints/successCriteria
    // are arrays; it does not (and should not duplicate logic to) validate
    // their element shape. This is the single choke point everything routes
    // through before ObjectiveRepository.save(), so it is where the full
    // domain invariant — "anything persisted must satisfy ObjectiveSchema" —
    // is actually enforced, reusing the existing schema rather than a second
    // hand-written one.
    const parsed = ObjectiveSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new ObjectiveServiceError(
        `Objective failed validation: ${summarizeZodError(parsed.error)}`,
        'BAD_REQUEST',
      );
    }
    const objective = parsed.data;

    this.db.transaction(() => {
      this.objectives.save(objective);
      this.appendEvent(objective, 'objective.created', { title: objective.title, priority: objective.priority });
    })();

    return objective;
  }

  // --------------------------------------------------------------------------
  // Read — both fail closed across workspace boundaries.
  // --------------------------------------------------------------------------

  findById(id: string): Objective | undefined {
    const objective = this.objectives.findById(id);
    if (!objective || !this.inWorkspace(objective.projectId)) return undefined;
    return objective;
  }

  listByProject(projectId: string): Objective[] {
    if (!this.inWorkspace(projectId)) {
      throw new ObjectiveServiceError(`Project '${projectId}' not found`, 'NOT_FOUND');
    }
    return this.objectives.listByProject(projectId);
  }

  // --------------------------------------------------------------------------
  // Guarded lifecycle — not yet exposed over HTTP in D.2; callers use these
  // rather than ObjectiveRepository.updateStatus() directly so the transition
  // table above stays the single source of truth for what's legal.
  // --------------------------------------------------------------------------

  activate(id: string): Objective {
    return this.transition(id, 'active', 'objective.activated');
  }

  complete(id: string): Objective {
    return this.transition(id, 'completed', 'objective.completed');
  }

  cancel(id: string): Objective {
    return this.transition(id, 'cancelled', 'objective.cancelled');
  }

  // --------------------------------------------------------------------------
  // Internal
  // --------------------------------------------------------------------------

  private inWorkspace(projectId: string): boolean {
    const project = this.projects.findById(projectId);
    return project?.workspaceId === this.workspaceId;
  }

  private loadOwned(id: string): Objective {
    const objective = this.objectives.findById(id);
    if (!objective || !this.inWorkspace(objective.projectId)) {
      throw new ObjectiveServiceError(`Objective '${id}' not found`, 'NOT_FOUND');
    }
    return objective;
  }

  private transition(id: string, to: ObjectiveStatus, eventType: string): Objective {
    const objective = this.loadOwned(id);
    if (!OBJECTIVE_TRANSITIONS[objective.status].includes(to)) {
      throw new ObjectiveServiceError(
        `Transition from '${objective.status}' to '${to}' is not permitted`,
        'INVALID_TRANSITION',
      );
    }

    const now = new Date().toISOString();
    const updated: Objective = { ...objective, status: to, updatedAt: now };

    this.db.transaction(() => {
      this.objectives.updateStatus(id, to, now);
      this.appendEvent(updated, eventType, { from: objective.status, to });
    })();

    return updated;
  }

  private appendEvent(objective: Objective, type: string, payload: Record<string, unknown>): void {
    const event: DomainEvent = {
      id: randomUUID(),
      schemaVersion: 1,
      type,
      workspaceId: this.workspaceId,
      projectId: objective.projectId,
      occurredAt: new Date().toISOString(),
      payload,
    };
    this.events.append(event);
  }
}

// A short, client-safe summary of a ZodError — never expose the raw error
// object (internal path structure, Zod's own message wording for schema
// internals) to a caller. One line per issue, e.g.:
//   "constraints.0: Required; successCriteria.1.description: Required"
function summarizeZodError(error: ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('; ');
}
