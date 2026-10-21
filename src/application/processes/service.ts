import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { AppProcessRepository, RepositoryRepository, type AppProcess, type AppProcessActivity, type AppProcessActivityKind, type AppProcessLifecycle } from '../../storage/repositories.js';
import { ProjectRepository } from '../../storage/repositories.js';

export class ProcessServiceError extends Error {
  constructor(message: string, readonly code: 'INVALID' | 'NOT_FOUND' | 'CONFLICT') { super(message); }
}

export interface CreateProcessInput {
  title: string; intent: string; objectiveId?: string; desiredOutcomes?: string[];
  constraints?: string[]; repositoryIds?: string[];
}
export interface ProcessOverviewItem extends AppProcess {
  attention?: 'Review required' | 'Revision requested';
  lastActivity?: AppProcessActivity;
}

export class ProcessService {
  private readonly processes: AppProcessRepository;
  private readonly repositories: RepositoryRepository;
  private readonly projects: ProjectRepository;
  constructor(private readonly db: Database.Database, private readonly workspaceId: string) {
    this.processes = new AppProcessRepository(db);
    this.repositories = new RepositoryRepository(db);
    this.projects = new ProjectRepository(db);
  }

  list(projectId: string): ProcessOverviewItem[] {
    this.requireProject(projectId);
    return this.processes.listByProject(projectId).map(process => {
      const activity = this.processes.listActivity(process.id);
      const proposalIndex = activity.findIndex(item => item.kind === 'proposal');
      const reviewIndex = activity.findIndex(item => item.kind === 'review');
      const attention: ProcessOverviewItem['attention'] = proposalIndex >= 0 && (reviewIndex < 0 || proposalIndex < reviewIndex)
        ? 'Review required'
        : reviewIndex >= 0 && activity[reviewIndex].outcome === 'revise' ? 'Revision requested' : undefined;
      return { ...process, attention, lastActivity: activity[0] };
    });
  }

  create(projectId: string, input: CreateProcessInput): AppProcess {
    this.requireProject(projectId);
    const title = input.title.trim(); const intent = input.intent.trim();
    if (!title || title.length > 160) throw new ProcessServiceError('title must be between 1 and 160 characters', 'INVALID');
    if (!intent || intent.length > 10000) throw new ProcessServiceError('intent must be between 1 and 10000 characters', 'INVALID');
    const objectives = this.db.prepare('SELECT project_id FROM objectives WHERE id=?').get(input.objectiveId) as { project_id: string } | undefined;
    if (input.objectiveId && (!objectives || objectives.project_id !== projectId)) throw new ProcessServiceError('objective must belong to this project', 'INVALID');
    const repositoryIds = [...new Set(input.repositoryIds ?? [])];
    if (repositoryIds.some(id => !this.repositories.isLinkedToProject(projectId, id))) throw new ProcessServiceError('repositories must be linked to this project', 'INVALID');
    const now = new Date().toISOString();
    const process: AppProcess = { id: randomUUID(), projectId, objectiveId: input.objectiveId,
      title, intent, desiredOutcomes: input.desiredOutcomes ?? [], constraints: input.constraints ?? [],
      lifecycle: 'active', currentFocus: 'Planning', repositoryIds, createdAt: now, updatedAt: now };
    const save = this.db.transaction(() => {
      this.processes.save(process);
      this.processes.addActivity({ id: randomUUID(), processId: process.id, kind: 'update', title: 'Process created', body: intent, createdAt: now }, 'Planning');
    });
    save();
    return this.processes.findById(process.id)!;
  }

  get(id: string): { process: AppProcess; activity: AppProcessActivity[] } {
    const process = this.processes.findById(id);
    if (!process || !this.projectInWorkspace(process.projectId)) throw new ProcessServiceError(`Process '${id}' not found`, 'NOT_FOUND');
    return { process, activity: this.processes.listActivity(id) };
  }

  addActivity(id: string, kind: AppProcessActivityKind, title: string, body: string, outcome?: string): AppProcessActivity {
    const { process } = this.get(id);
    if (process.lifecycle !== 'active') throw new ProcessServiceError('only active Processes can receive updates', 'CONFLICT');
    if (!title.trim() || !body.trim()) throw new ProcessServiceError('title and body are required', 'INVALID');
    if (kind === 'decision' && !outcome) throw new ProcessServiceError('decisions require an outcome', 'INVALID');
    const activity: AppProcessActivity = { id: randomUUID(), processId: id, kind, title: title.trim(), body: body.trim(), outcome, createdAt: new Date().toISOString() };
    this.processes.addActivity(activity);
    return activity;
  }

  setLifecycle(id: string, lifecycle: AppProcessLifecycle, outcome?: string): AppProcess {
    const { process } = this.get(id);
    if (process.lifecycle === 'cancelled' || process.lifecycle === 'completed') throw new ProcessServiceError('terminal Processes cannot change lifecycle', 'CONFLICT');
    if (lifecycle === 'completed' && !outcome?.trim()) throw new ProcessServiceError('completing a Process requires an accepted outcome summary', 'INVALID');
    const updatedAt = new Date().toISOString();
    this.processes.updateLifecycle(id, lifecycle, updatedAt);
    this.processes.addActivity({ id: randomUUID(), processId: id, kind: 'decision', title: lifecycle === 'completed' ? 'Outcome accepted' : `Process ${lifecycle}`,
      body: outcome?.trim() || `Lifecycle changed from ${process.lifecycle} to ${lifecycle}.`, outcome: lifecycle === 'completed' ? 'accepted' : lifecycle, createdAt: updatedAt });
    return this.processes.findById(id)!;
  }

  private requireProject(projectId: string): void {
    if (!this.projectInWorkspace(projectId)) throw new ProcessServiceError(`Project '${projectId}' not found`, 'NOT_FOUND');
  }
  private projectInWorkspace(projectId: string): boolean { return this.projects.findById(projectId)?.workspaceId === this.workspaceId; }
}
