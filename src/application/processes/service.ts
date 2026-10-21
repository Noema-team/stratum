import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { AppProcessRepository, RepositoryRepository, type AppProcess, type AppProcessActivity, type AppProcessActivityKind, type AppProcessLifecycle, type AppProcessDefinition, type AppProcessAmendment, type AppProcessDefinitionVersion } from '../../storage/repositories.js';
import { ProjectRepository } from '../../storage/repositories.js';

export class ProcessServiceError extends Error {
  constructor(message: string, readonly code: 'INVALID' | 'NOT_FOUND' | 'CONFLICT') { super(message); }
}

export interface CreateProcessInput {
  title: string; intent: string; objectiveId?: string; desiredOutcomes?: string[];
  constraints?: string[]; repositoryIds?: string[];
}
export interface ProcessOverviewItem extends AppProcess {
  attention?: 'Review required' | 'Revision requested' | 'Amendment proposed' | 'Deferred proposal';
  lastActivity?: AppProcessActivity;
  nextAction?: string;
  unresolvedCount: number;
}
export interface ProposeAmendmentInput { definition: Partial<AppProcessDefinition>; reason: string }

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
      const pending = this.processes.listPendingProposals(process.id);
      const lastActivity = this.db.prepare('SELECT id,process_id AS processId,kind,title,body,outcome,proposal_id AS proposalId,created_at AS createdAt FROM app_process_activity WHERE process_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(process.id) as AppProcessActivity | undefined;
      const latestProposal = this.db.prepare('SELECT status FROM app_process_proposals WHERE process_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(process.id) as { status: string } | undefined;
      const deferred = this.processes.listProposals(process.id, 'deferred');
      const proposedAmendment = this.processes.listAmendments(process.id).some(amendment => amendment.status === 'proposed');
      const attention: ProcessOverviewItem['attention'] = pending.length ? 'Review required' : latestProposal?.status === 'revise' ? 'Revision requested' : proposedAmendment ? 'Amendment proposed' : deferred.length ? 'Deferred proposal' : undefined;
      const outstanding = this.outstandingItems(process.id);
      const nextAction = process.lifecycle === 'paused' ? 'Resume this Process'
        : process.lifecycle !== 'active' ? undefined
          : proposedAmendment ? 'Review proposed amendment'
            : pending.length ? `Review proposal: ${pending[0].title}`
              : deferred.length ? `Reconsider deferred proposal: ${deferred[0].title}`
                : latestProposal?.status === 'revise' ? 'Record a revised proposal' : undefined;
      return { ...process, attention, lastActivity, nextAction, unresolvedCount: outstanding.length };
    });
  }

  activityFeed(projectId: string, limit = 12): (AppProcessActivity & { processTitle: string })[] {
    this.requireProject(projectId);
    const boundedLimit = Math.max(1, Math.min(50, Math.trunc(limit) || 12));
    return this.db.prepare(`SELECT a.id,a.process_id AS processId,a.kind,a.title,a.body,a.outcome,
      a.proposal_id AS proposalId,a.amendment_id AS amendmentId,a.definition_version AS definitionVersion,
      a.created_at AS createdAt,p.title AS processTitle FROM app_process_activity a
      JOIN app_processes p ON p.id=a.process_id WHERE p.project_id=?
      ORDER BY a.created_at DESC,a.rowid DESC LIMIT ?`).all(projectId, boundedLimit) as (AppProcessActivity & { processTitle: string })[];
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
      this.processes.saveInitialDefinition(process);
      this.processes.addActivity({ id: randomUUID(), processId: process.id, kind: 'update', title: 'Process created', body: intent, createdAt: now }, 'Planning');
    });
    save();
    return this.processes.findById(process.id)!;
  }

  get(id: string): { process: AppProcess; activity: AppProcessActivity[]; pendingProposals: { id: string; title: string; createdAt: string }[];
    deferredProposals: { id: string; title: string; body: string; status: string; createdAt: string }[];
    proposals: { id: string; title: string; body: string; status: string; createdAt: string }[];
    amendments: AppProcessAmendment[]; definitionVersions: AppProcessDefinitionVersion[] } {
    const process = this.processes.findById(id);
    if (!process || !this.projectInWorkspace(process.projectId)) throw new ProcessServiceError(`Process '${id}' not found`, 'NOT_FOUND');
    return { process, activity: this.processes.listActivity(id), pendingProposals: this.processes.listPendingProposals(id),
      deferredProposals: this.processes.listProposals(id, 'deferred'), proposals: this.processes.listProposals(id),
      amendments: this.processes.listAmendments(id), definitionVersions: this.processes.listDefinitionVersions(id) };
  }

  proposeAmendment(id: string, input: ProposeAmendmentInput): AppProcessAmendment {
    const { process } = this.get(id);
    if (process.lifecycle === 'completed' || process.lifecycle === 'cancelled') throw new ProcessServiceError('terminal Processes cannot be amended', 'CONFLICT');
    if (!input.reason.trim() || input.reason.trim().length > 4000) throw new ProcessServiceError('amendment reason must be between 1 and 4000 characters', 'INVALID');
    if (this.processes.listAmendments(id).some(amendment => amendment.status === 'proposed')) throw new ProcessServiceError('resolve the existing proposed amendment first', 'CONFLICT');
    const definition: AppProcessDefinition = {
      title: input.definition.title?.trim() ?? process.title,
      intent: input.definition.intent?.trim() ?? process.intent,
      desiredOutcomes: input.definition.desiredOutcomes ?? process.desiredOutcomes,
      constraints: input.definition.constraints ?? process.constraints,
      objectiveId: input.definition.objectiveId === null ? undefined : input.definition.objectiveId ?? process.objectiveId,
      repositoryIds: [...new Set(input.definition.repositoryIds ?? process.repositoryIds)],
    };
    this.validateDefinition(process.projectId, definition);
    const amendment: AppProcessAmendment = { id: randomUUID(), processId: id, baseVersion: this.processes.currentDefinitionVersion(id),
      definition, reason: input.reason.trim(), status: 'proposed', proposedBy: 'local-user', proposedAt: new Date().toISOString() };
    const save = this.db.transaction(() => {
      this.processes.saveAmendment(amendment);
      this.processes.addActivity({ id: randomUUID(), processId: id, kind: 'decision', title: 'Definition amendment proposed',
        body: amendment.reason, amendmentId: amendment.id, createdAt: amendment.proposedAt });
    });
    save();
    return amendment;
  }

  decideAmendment(processId: string, amendmentId: string, decision: 'accept' | 'reject'): AppProcessAmendment {
    const { process } = this.get(processId);
    if (process.lifecycle === 'completed' || process.lifecycle === 'cancelled') throw new ProcessServiceError('terminal Processes cannot be amended', 'CONFLICT');
    const amendment = this.processes.findAmendment(amendmentId);
    if (!amendment || amendment.processId !== processId) throw new ProcessServiceError(`Amendment '${amendmentId}' not found`, 'NOT_FOUND');
    if (amendment.status !== 'proposed') throw new ProcessServiceError('amendment has already been decided', 'CONFLICT');
    const currentVersion = this.processes.currentDefinitionVersion(processId);
    if (amendment.baseVersion !== currentVersion) throw new ProcessServiceError('Process definition changed since this amendment was proposed', 'CONFLICT');
    const decidedAt = new Date().toISOString();
    const save = this.db.transaction(() => {
      const status = decision === 'accept' ? 'accepted' : 'rejected';
      this.processes.decideAmendment(amendmentId, status, 'local-user', decidedAt);
      if (decision === 'accept') {
        this.processes.applyDefinition(processId, amendment.definition, decidedAt);
        this.processes.insertDefinitionVersion(processId, currentVersion + 1, amendment.definition, amendmentId, amendment.reason, 'local-user', decidedAt);
      }
      this.processes.addActivity({ id: randomUUID(), processId, kind: 'decision', title: decision === 'accept' ? 'Definition amendment accepted' : 'Definition amendment rejected',
        body: amendment.reason, outcome: decision === 'accept' ? 'accepted' : 'rejected', amendmentId, createdAt: decidedAt });
    });
    save();
    return this.processes.findAmendment(amendmentId)!;
  }

  reopenDeferredProposal(processId: string, proposalId: string): void {
    const { process } = this.get(processId);
    if (process.lifecycle !== 'active') throw new ProcessServiceError('only active Processes can reopen proposals', 'CONFLICT');
    const reopenedAt = new Date().toISOString();
    const reopen = this.db.transaction(() => {
      if (!this.processes.reopenDeferredProposal(processId, proposalId)) throw new ProcessServiceError('deferred proposal not found', 'NOT_FOUND');
      this.processes.addActivity({ id: randomUUID(), processId, kind: 'decision', title: 'Deferred proposal reopened',
        body: 'Returned to the review queue by the local user.', outcome: 'reopened', proposalId, createdAt: reopenedAt });
    });
    reopen();
  }

  addActivity(id: string, kind: AppProcessActivityKind, title: string, body: string, outcome?: string, proposalId?: string): AppProcessActivity {
    const { process } = this.get(id);
    if (process.lifecycle !== 'active') throw new ProcessServiceError('only active Processes can receive updates', 'CONFLICT');
    if (!title.trim() || !body.trim()) throw new ProcessServiceError('title and body are required', 'INVALID');
    if (kind === 'decision' && !outcome) throw new ProcessServiceError('decisions require an outcome', 'INVALID');
    if (kind === 'proposal') proposalId = randomUUID();
    if (kind === 'review' && (!proposalId || !outcome)) throw new ProcessServiceError('reviews require a proposal and an explicit outcome', 'INVALID');
    if (kind === 'review' && !this.processes.listPendingProposals(id).some(proposal => proposal.id === proposalId)) throw new ProcessServiceError('proposal is not pending review for this Process', 'CONFLICT');
    const activity: AppProcessActivity = { id: randomUUID(), processId: id, kind, title: title.trim(), body: body.trim(), outcome, proposalId, createdAt: new Date().toISOString() };
    this.processes.addActivity(activity);
    return activity;
  }

  setLifecycle(id: string, lifecycle: AppProcessLifecycle, outcome?: string, acknowledgeUnresolved = false): AppProcess {
    const { process } = this.get(id);
    if (process.lifecycle === 'cancelled' || process.lifecycle === 'completed') throw new ProcessServiceError('terminal Processes cannot change lifecycle', 'CONFLICT');
    if (lifecycle === 'completed' && !outcome?.trim()) throw new ProcessServiceError('completing a Process requires an accepted outcome summary', 'INVALID');
    const unresolved = lifecycle === 'completed' ? this.outstandingItems(id) : [];
    if (unresolved.length && !acknowledgeUnresolved) throw new ProcessServiceError('acknowledge unresolved proposals or amendments before completing this Process', 'CONFLICT');
    const updatedAt = new Date().toISOString();
    const update = this.db.transaction(() => {
      this.processes.updateLifecycle(id, lifecycle, updatedAt);
      this.processes.addActivity({ id: randomUUID(), processId: id, kind: 'decision', title: lifecycle === 'completed' ? 'Outcome accepted' : `Process ${lifecycle}`,
        body: lifecycle === 'completed' && unresolved.length ? `${outcome?.trim()}\n\nAcknowledged unresolved items: ${unresolved.map(item => `${item.title} (${item.status})`).join('; ')}`
          : outcome?.trim() || `Lifecycle changed from ${process.lifecycle} to ${lifecycle}.`, outcome: lifecycle === 'completed' ? 'accepted' : lifecycle, createdAt: updatedAt });
    });
    update();
    return this.processes.findById(id)!;
  }

  private requireProject(projectId: string): void {
    if (!this.projectInWorkspace(projectId)) throw new ProcessServiceError(`Project '${projectId}' not found`, 'NOT_FOUND');
  }
  private projectInWorkspace(projectId: string): boolean { return this.projects.findById(projectId)?.workspaceId === this.workspaceId; }

  private validateDefinition(projectId: string, definition: AppProcessDefinition): void {
    if (!definition.title.trim() || definition.title.length > 160) throw new ProcessServiceError('title must be between 1 and 160 characters', 'INVALID');
    if (!definition.intent.trim() || definition.intent.length > 10000) throw new ProcessServiceError('intent must be between 1 and 10000 characters', 'INVALID');
    if (definition.desiredOutcomes.length > 20 || definition.desiredOutcomes.some(value => value.length > 1000)) throw new ProcessServiceError('desired outcomes exceed the supported limits', 'INVALID');
    if (definition.constraints.length > 20 || definition.constraints.some(value => value.length > 1000)) throw new ProcessServiceError('constraints exceed the supported limits', 'INVALID');
    if (definition.objectiveId) {
      const objective = this.db.prepare('SELECT project_id FROM objectives WHERE id=?').get(definition.objectiveId) as { project_id: string } | undefined;
      if (!objective || objective.project_id !== projectId) throw new ProcessServiceError('objective must belong to this project', 'INVALID');
    }
    if (definition.repositoryIds.some(repositoryId => !this.repositories.isLinkedToProject(projectId, repositoryId))) throw new ProcessServiceError('repositories must be linked to this project', 'INVALID');
  }

  private outstandingItems(processId: string): { id: string; title: string; status: string }[] {
    const proposals = this.processes.listProposals(processId).filter(item => ['pending', 'deferred', 'revise'].includes(item.status));
    const amendments = this.processes.listAmendments(processId).filter(item => item.status === 'proposed')
      .map(item => ({ id: item.id, title: `Definition amendment: ${item.reason}`, status: 'proposed amendment' }));
    return [...proposals, ...amendments];
  }
}
