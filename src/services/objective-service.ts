import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import type { Objective, ObjectiveStatus, DomainEvent } from '../domain/index.js';
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
    const objective: Objective = {
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
