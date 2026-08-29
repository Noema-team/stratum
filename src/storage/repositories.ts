import type Database from 'better-sqlite3';
import type {
  Workspace,
  Project,
  Repository,
  Objective,
  WorkItem,
  WorkItemState,
  StepExecution,
  StepExecutionState,
  Decision,
  DecisionStatus,
  Evidence,
  DomainEvent,
  PolicyConfig,
} from '../domain/index.js';

// Artifact metadata record (cross-run provenance stored in DB; content stays in .sle/)
export interface ArtifactRecord {
  id: string;
  workItemId?: string;
  workflowRunId?: string;
  stepExecutionId?: string;
  type: string;
  ref?: string;   // DDR-031 ArtifactRef string, e.g. "node:auth:architecture"
  path?: string;  // relative to .sle/
  hash?: string;
  createdAt: string;
}

// ============================================================================
// WorkspaceRepository
// ============================================================================

export class WorkspaceRepository {
  private readonly insert: Database.Statement;
  private readonly byId: Database.Statement;
  private readonly all: Database.Statement;

  constructor(db: Database.Database) {
    this.insert = db.prepare(
      'INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)'
    );
    this.byId = db.prepare('SELECT * FROM workspaces WHERE id = ?');
    this.all = db.prepare('SELECT * FROM workspaces ORDER BY created_at');
  }

  save(ws: Workspace): void {
    this.insert.run(ws.id, ws.name, ws.createdAt);
  }

  findById(id: string): Workspace | undefined {
    const row = this.byId.get(id) as Record<string, unknown> | undefined;
    return row ? { id: row.id as string, name: row.name as string, createdAt: row.created_at as string } : undefined;
  }

  list(): Workspace[] {
    return (this.all.all() as Record<string, unknown>[]).map(r => ({
      id: r.id as string,
      name: r.name as string,
      createdAt: r.created_at as string,
    }));
  }
}

// ============================================================================
// ProjectRepository
// ============================================================================

export class ProjectRepository {
  private readonly insert: Database.Statement;
  private readonly byId: Database.Statement;
  private readonly byWorkspace: Database.Statement;
  private readonly statusStmt: Database.Statement;
  private readonly priorityStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.insert = db.prepare(`
      INSERT INTO projects (id, workspace_id, name, description, status, priority, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.byId = db.prepare('SELECT * FROM projects WHERE id = ?');
    this.byWorkspace = db.prepare('SELECT * FROM projects WHERE workspace_id = ? ORDER BY priority DESC, created_at');
    this.statusStmt = db.prepare('UPDATE projects SET status = ?, updated_at = ? WHERE id = ?');
    this.priorityStmt = db.prepare('UPDATE projects SET priority = ?, updated_at = ? WHERE id = ?');
  }

  save(p: Project): void {
    this.insert.run(p.id, p.workspaceId, p.name, p.description ?? null, p.status, p.priority, p.createdAt, p.updatedAt);
  }

  findById(id: string): Project | undefined {
    const r = this.byId.get(id) as Record<string, unknown> | undefined;
    return r ? rowToProject(r) : undefined;
  }

  listByWorkspace(workspaceId: string): Project[] {
    return (this.byWorkspace.all(workspaceId) as Record<string, unknown>[]).map(rowToProject);
  }

  updateStatus(id: string, status: Project['status'], updatedAt: string): void {
    this.statusStmt.run(status, updatedAt, id);
  }

  updatePriority(id: string, priority: number, updatedAt: string): void {
    this.priorityStmt.run(priority, updatedAt, id);
  }
}

function rowToProject(r: Record<string, unknown>): Project {
  return {
    id: r.id as string,
    workspaceId: r.workspace_id as string,
    name: r.name as string,
    description: r.description as string | undefined ?? undefined,
    status: r.status as Project['status'],
    priority: r.priority as number,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

// ============================================================================
// RepositoryRepository
// ============================================================================

export class RepositoryRepository {
  private readonly insert: Database.Statement;
  private readonly byId: Database.Statement;
  private readonly byProject: Database.Statement;
  private readonly statusStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.insert = db.prepare(`
      INSERT INTO repositories (id, project_id, provider, remote, default_branch, local_workspace, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this.byId = db.prepare('SELECT * FROM repositories WHERE id = ?');
    this.byProject = db.prepare('SELECT * FROM repositories WHERE project_id = ? ORDER BY remote');
    this.statusStmt = db.prepare('UPDATE repositories SET status = ? WHERE id = ?');
  }

  save(r: Repository): void {
    this.insert.run(r.id, r.projectId, r.provider, r.remote, r.defaultBranch, r.localWorkspace ?? null, r.status);
  }

  findById(id: string): Repository | undefined {
    const r = this.byId.get(id) as Record<string, unknown> | undefined;
    return r ? rowToRepository(r) : undefined;
  }

  listByProject(projectId: string): Repository[] {
    return (this.byProject.all(projectId) as Record<string, unknown>[]).map(rowToRepository);
  }

  updateStatus(id: string, status: Repository['status']): void {
    this.statusStmt.run(status, id);
  }
}

function rowToRepository(r: Record<string, unknown>): Repository {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    provider: r.provider as Repository['provider'],
    remote: r.remote as string,
    defaultBranch: r.default_branch as string,
    localWorkspace: r.local_workspace as string | undefined ?? undefined,
    status: r.status as Repository['status'],
  };
}

// ============================================================================
// ObjectiveRepository
// ============================================================================

export class ObjectiveRepository {
  private readonly insert: Database.Statement;
  private readonly byId: Database.Statement;
  private readonly byProject: Database.Statement;
  private readonly statusStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.insert = db.prepare(`
      INSERT INTO objectives (id, project_id, title, description, priority, status, constraints_json, success_criteria_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.byId = db.prepare('SELECT * FROM objectives WHERE id = ?');
    this.byProject = db.prepare('SELECT * FROM objectives WHERE project_id = ? ORDER BY priority DESC, title');
    this.statusStmt = db.prepare('UPDATE objectives SET status = ? WHERE id = ?');
  }

  save(o: Objective): void {
    this.insert.run(o.id, o.projectId, o.title, o.description, o.priority, o.status,
      JSON.stringify(o.constraints), JSON.stringify(o.successCriteria));
  }

  findById(id: string): Objective | undefined {
    const r = this.byId.get(id) as Record<string, unknown> | undefined;
    return r ? rowToObjective(r) : undefined;
  }

  listByProject(projectId: string): Objective[] {
    return (this.byProject.all(projectId) as Record<string, unknown>[]).map(rowToObjective);
  }

  updateStatus(id: string, status: Objective['status']): void {
    this.statusStmt.run(status, id);
  }
}

function rowToObjective(r: Record<string, unknown>): Objective {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    title: r.title as string,
    description: r.description as string,
    priority: r.priority as number,
    status: r.status as Objective['status'],
    constraints: JSON.parse(r.constraints_json as string),
    successCriteria: JSON.parse(r.success_criteria_json as string),
  };
}

// ============================================================================
// WorkItemRepository
// ============================================================================

export class WorkItemRepository {
  private readonly insert: Database.Statement;
  private readonly byId: Database.Statement;
  private readonly byProject: Database.Statement;
  private readonly byState: Database.Statement;
  private readonly allByState: Database.Statement;
  private readonly countForProject: Database.Statement;
  private readonly countAll: Database.Statement;
  private readonly unmetDepsCount: Database.Statement;
  private readonly stateStmt: Database.Statement;
  private readonly addDep: Database.Statement;
  private readonly removeDep: Database.Statement;
  private readonly getDeps: Database.Statement;

  constructor(db: Database.Database) {
    this.insert = db.prepare(`
      INSERT INTO work_items
        (id, project_id, objective_id, repository_ids_json, title, goal, workflow_id,
         state, priority, acceptance_criteria_json, constraints_json, required_evidence_json,
         parent_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.byId = db.prepare('SELECT * FROM work_items WHERE id = ?');
    this.byProject = db.prepare('SELECT * FROM work_items WHERE project_id = ? ORDER BY priority DESC, created_at');
    this.byState = db.prepare('SELECT * FROM work_items WHERE project_id = ? AND state = ? ORDER BY priority DESC, created_at');
    this.allByState = db.prepare('SELECT * FROM work_items WHERE state = ? ORDER BY priority DESC, created_at');
    this.countForProject = db.prepare('SELECT COUNT(*) as count FROM work_items WHERE project_id = ? AND state = ?');
    this.countAll = db.prepare('SELECT COUNT(*) as count FROM work_items WHERE state = ?');
    this.unmetDepsCount = db.prepare(`
      SELECT COUNT(*) as count FROM work_dependencies wd
      JOIN work_items wi ON wi.id = wd.depends_on_id
      WHERE wd.work_item_id = ? AND wi.state != 'completed'
    `);
    this.stateStmt = db.prepare('UPDATE work_items SET state = ?, updated_at = ? WHERE id = ?');
    this.addDep = db.prepare('INSERT INTO work_dependencies (work_item_id, depends_on_id) VALUES (?, ?)');
    this.removeDep = db.prepare('DELETE FROM work_dependencies WHERE work_item_id = ? AND depends_on_id = ?');
    this.getDeps = db.prepare('SELECT depends_on_id FROM work_dependencies WHERE work_item_id = ?');
  }

  save(wi: WorkItem): void {
    this.insert.run(
      wi.id, wi.projectId, wi.objectiveId ?? null,
      JSON.stringify(wi.repositoryIds), wi.title, wi.goal, wi.workflowId,
      wi.state, wi.priority,
      JSON.stringify(wi.acceptanceCriteria),
      JSON.stringify(wi.constraints),
      JSON.stringify(wi.requiredEvidence),
      wi.parentId ?? null, wi.createdAt, wi.updatedAt,
    );
    for (const depId of wi.dependencies) {
      this.addDep.run(wi.id, depId);
    }
  }

  findById(id: string): WorkItem | undefined {
    const r = this.byId.get(id) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    const deps = (this.getDeps.all(id) as { depends_on_id: string }[]).map(d => d.depends_on_id);
    return rowToWorkItem(r, deps);
  }

  listByProject(projectId: string): WorkItem[] {
    return (this.byProject.all(projectId) as Record<string, unknown>[]).map(r => {
      const deps = (this.getDeps.all(r.id as string) as { depends_on_id: string }[]).map(d => d.depends_on_id);
      return rowToWorkItem(r, deps);
    });
  }

  listByState(projectId: string, state: WorkItemState): WorkItem[] {
    return (this.byState.all(projectId, state) as Record<string, unknown>[]).map(r => {
      const deps = (this.getDeps.all(r.id as string) as { depends_on_id: string }[]).map(d => d.depends_on_id);
      return rowToWorkItem(r, deps);
    });
  }

  // All items globally with the given state — used by the scheduler.
  listAllByState(state: WorkItemState): WorkItem[] {
    return (this.allByState.all(state) as Record<string, unknown>[]).map(r => {
      const deps = (this.getDeps.all(r.id as string) as { depends_on_id: string }[]).map(d => d.depends_on_id);
      return rowToWorkItem(r, deps);
    });
  }

  countByStateForProject(projectId: string, state: WorkItemState): number {
    return ((this.countForProject.get(projectId, state) as { count: number }).count);
  }

  countAllByState(state: WorkItemState): number {
    return ((this.countAll.get(state) as { count: number }).count);
  }

  // True if all blocking dependencies are in the 'completed' state.
  areDependenciesMet(workItemId: string): boolean {
    const row = this.unmetDepsCount.get(workItemId) as { count: number };
    return row.count === 0;
  }

  updateState(id: string, state: WorkItemState, updatedAt: string): void {
    this.stateStmt.run(state, updatedAt, id);
  }

  addDependency(workItemId: string, dependsOnId: string): void {
    this.addDep.run(workItemId, dependsOnId);
  }

  removeDependency(workItemId: string, dependsOnId: string): void {
    this.removeDep.run(workItemId, dependsOnId);
  }
}

function rowToWorkItem(r: Record<string, unknown>, dependencies: string[]): WorkItem {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    objectiveId: r.objective_id as string | undefined ?? undefined,
    repositoryIds: JSON.parse(r.repository_ids_json as string),
    title: r.title as string,
    goal: r.goal as string,
    workflowId: r.workflow_id as string,
    state: r.state as WorkItemState,
    priority: r.priority as number,
    acceptanceCriteria: JSON.parse(r.acceptance_criteria_json as string),
    constraints: JSON.parse(r.constraints_json as string),
    requiredEvidence: JSON.parse(r.required_evidence_json as string),
    parentId: r.parent_id as string | undefined ?? undefined,
    dependencies,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

// ============================================================================
// StepExecutionRepository
// ============================================================================

export class StepExecutionRepository {
  private readonly insert: Database.Statement;
  private readonly byId: Database.Statement;
  private readonly byWorkItem: Database.Statement;
  private readonly byWorkflowRun: Database.Statement;
  private readonly activeByWorkItem: Database.Statement;
  private readonly stateStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.insert = db.prepare(`
      INSERT INTO step_executions
        (id, work_item_id, workflow_run_id, step_id, executor, state, attempt,
         started_at, completed_at, cost_json, tokens, failure_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.byId = db.prepare('SELECT * FROM step_executions WHERE id = ?');
    this.byWorkItem = db.prepare('SELECT * FROM step_executions WHERE work_item_id = ? ORDER BY started_at');
    this.byWorkflowRun = db.prepare('SELECT * FROM step_executions WHERE workflow_run_id = ? ORDER BY started_at');
    this.activeByWorkItem = db.prepare(
      "SELECT * FROM step_executions WHERE work_item_id = ? AND state IN ('dispatched', 'running') LIMIT 1"
    );
    this.stateStmt = db.prepare(`
      UPDATE step_executions
      SET state = ?, started_at = COALESCE(?, started_at), completed_at = ?, failure_json = COALESCE(?, failure_json)
      WHERE id = ?
    `);
  }

  save(se: StepExecution): void {
    this.insert.run(
      se.id, se.workItemId, se.workflowRunId, se.stepId, se.executor,
      se.state, se.attempt,
      se.startedAt ?? null, se.completedAt ?? null,
      se.cost ? JSON.stringify(se.cost) : null,
      se.tokens ?? null,
      se.failure ? JSON.stringify(se.failure) : null,
    );
  }

  findById(id: string): StepExecution | undefined {
    const r = this.byId.get(id) as Record<string, unknown> | undefined;
    return r ? rowToStepExecution(r) : undefined;
  }

  listByWorkItem(workItemId: string): StepExecution[] {
    return (this.byWorkItem.all(workItemId) as Record<string, unknown>[]).map(rowToStepExecution);
  }

  listByWorkflowRun(workflowRunId: string): StepExecution[] {
    return (this.byWorkflowRun.all(workflowRunId) as Record<string, unknown>[]).map(rowToStepExecution);
  }

  // Returns a dispatched or running execution for this work item, if any.
  findActiveByWorkItem(workItemId: string): StepExecution | undefined {
    const r = this.activeByWorkItem.get(workItemId) as Record<string, unknown> | undefined;
    return r ? rowToStepExecution(r) : undefined;
  }

  updateState(
    id: string,
    state: StepExecutionState,
    opts: { startedAt?: string; completedAt?: string; failure?: StepExecution['failure'] },
  ): void {
    this.stateStmt.run(
      state, opts.startedAt ?? null, opts.completedAt ?? null,
      opts.failure ? JSON.stringify(opts.failure) : null, id,
    );
  }
}

function rowToStepExecution(r: Record<string, unknown>): StepExecution {
  return {
    id: r.id as string,
    workItemId: r.work_item_id as string,
    workflowRunId: r.workflow_run_id as string,
    stepId: r.step_id as string,
    executor: r.executor as string,
    state: r.state as StepExecutionState,
    attempt: r.attempt as number,
    startedAt: r.started_at as string | undefined ?? undefined,
    completedAt: r.completed_at as string | undefined ?? undefined,
    cost: r.cost_json ? JSON.parse(r.cost_json as string) : undefined,
    tokens: r.tokens as number | undefined ?? undefined,
    failure: r.failure_json ? JSON.parse(r.failure_json as string) : undefined,
  };
}

// ============================================================================
// DecisionRepository
// ============================================================================

export class DecisionRepository {
  private readonly insert: Database.Statement;
  private readonly byId: Database.Statement;
  private readonly byProject: Database.Statement;
  private readonly byWorkItem: Database.Statement;
  private readonly pending: Database.Statement;
  private readonly statusStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.insert = db.prepare(`
      INSERT INTO decisions
        (id, project_id, work_item_id, type, subject_ref_json, title, summary,
         options_json, recommended_option_id, recommendation_reason,
         impact, reversibility, urgency, status, resolution_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.byId = db.prepare('SELECT * FROM decisions WHERE id = ?');
    this.byProject = db.prepare('SELECT * FROM decisions WHERE project_id = ? ORDER BY urgency DESC, status');
    this.byWorkItem = db.prepare('SELECT * FROM decisions WHERE work_item_id = ? ORDER BY urgency DESC');
    this.pending = db.prepare("SELECT * FROM decisions WHERE project_id = ? AND status = 'pending' ORDER BY urgency DESC");
    this.statusStmt = db.prepare('UPDATE decisions SET status = ?, resolution_json = ? WHERE id = ?');
  }

  save(d: Decision): void {
    this.insert.run(
      d.id, d.projectId, d.workItemId ?? null, d.type,
      JSON.stringify(d.subjectRef), d.title, d.summary,
      JSON.stringify(d.options),
      d.recommendedOptionId ?? null, d.recommendationReason ?? null,
      d.impact, d.reversibility, d.urgency, d.status,
      d.resolution ? JSON.stringify(d.resolution) : null,
    );
  }

  findById(id: string): Decision | undefined {
    const r = this.byId.get(id) as Record<string, unknown> | undefined;
    return r ? rowToDecision(r) : undefined;
  }

  listByProject(projectId: string): Decision[] {
    return (this.byProject.all(projectId) as Record<string, unknown>[]).map(rowToDecision);
  }

  listByWorkItem(workItemId: string): Decision[] {
    return (this.byWorkItem.all(workItemId) as Record<string, unknown>[]).map(rowToDecision);
  }

  listPending(projectId: string): Decision[] {
    return (this.pending.all(projectId) as Record<string, unknown>[]).map(rowToDecision);
  }

  updateStatus(id: string, status: DecisionStatus, resolution?: Decision['resolution']): void {
    this.statusStmt.run(status, resolution ? JSON.stringify(resolution) : null, id);
  }
}

function rowToDecision(r: Record<string, unknown>): Decision {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    workItemId: r.work_item_id as string | undefined ?? undefined,
    type: r.type as string,
    subjectRef: JSON.parse(r.subject_ref_json as string),
    title: r.title as string,
    summary: r.summary as string,
    options: JSON.parse(r.options_json as string),
    recommendedOptionId: r.recommended_option_id as string | undefined ?? undefined,
    recommendationReason: r.recommendation_reason as string | undefined ?? undefined,
    impact: r.impact as Decision['impact'],
    reversibility: r.reversibility as Decision['reversibility'],
    urgency: r.urgency as Decision['urgency'],
    status: r.status as DecisionStatus,
    resolution: r.resolution_json ? JSON.parse(r.resolution_json as string) : undefined,
  };
}

// ============================================================================
// PolicyRepository
// ============================================================================

export class PolicyRepository {
  private readonly upsert: Database.Statement;
  private readonly byProject: Database.Statement;

  constructor(db: Database.Database) {
    this.upsert = db.prepare(`
      INSERT INTO policies (project_id, config_json) VALUES (?, ?)
      ON CONFLICT(project_id) DO UPDATE SET config_json = excluded.config_json
    `);
    this.byProject = db.prepare('SELECT * FROM policies WHERE project_id = ?');
  }

  upsertPolicy(config: PolicyConfig): void {
    this.upsert.run(config.projectId, JSON.stringify(config));
  }

  findByProject(projectId: string): PolicyConfig | undefined {
    const r = this.byProject.get(projectId) as Record<string, unknown> | undefined;
    return r ? JSON.parse(r.config_json as string) : undefined;
  }
}

// ============================================================================
// EvidenceRepository
// ============================================================================

export class EvidenceRepository {
  private readonly insert: Database.Statement;
  private readonly byId: Database.Statement;
  private readonly byWorkItem: Database.Statement;
  private readonly byType: Database.Statement;

  constructor(db: Database.Database) {
    this.insert = db.prepare(`
      INSERT INTO evidence
        (id, work_item_id, step_execution_id, type, source, subject_ref, status, payload_json, collected_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.byId = db.prepare('SELECT * FROM evidence WHERE id = ?');
    this.byWorkItem = db.prepare('SELECT * FROM evidence WHERE work_item_id = ? ORDER BY collected_at');
    this.byType = db.prepare('SELECT * FROM evidence WHERE work_item_id = ? AND type = ? ORDER BY collected_at');
  }

  save(e: Evidence): void {
    this.insert.run(
      e.id, e.workItemId, e.stepExecutionId ?? null,
      e.type, e.source, e.subjectRef ?? null, e.status,
      JSON.stringify(e.payload), e.collectedAt,
    );
  }

  findById(id: string): Evidence | undefined {
    const r = this.byId.get(id) as Record<string, unknown> | undefined;
    return r ? rowToEvidence(r) : undefined;
  }

  listByWorkItem(workItemId: string): Evidence[] {
    return (this.byWorkItem.all(workItemId) as Record<string, unknown>[]).map(rowToEvidence);
  }

  listByType(workItemId: string, type: string): Evidence[] {
    return (this.byType.all(workItemId, type) as Record<string, unknown>[]).map(rowToEvidence);
  }
}

function rowToEvidence(r: Record<string, unknown>): Evidence {
  return {
    id: r.id as string,
    workItemId: r.work_item_id as string,
    stepExecutionId: r.step_execution_id as string | undefined ?? undefined,
    type: r.type as string,
    source: r.source as string,
    subjectRef: r.subject_ref as string | undefined ?? undefined,
    status: r.status as Evidence['status'],
    payload: JSON.parse(r.payload_json as string),
    collectedAt: r.collected_at as string,
  };
}

// ============================================================================
// ArtifactRepository
// ============================================================================

export class ArtifactRepository {
  private readonly insert: Database.Statement;
  private readonly byId: Database.Statement;
  private readonly byWorkItem: Database.Statement;
  private readonly byWorkflowRun: Database.Statement;

  constructor(db: Database.Database) {
    this.insert = db.prepare(`
      INSERT INTO artifacts (id, work_item_id, workflow_run_id, step_execution_id, type, ref, path, hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.byId = db.prepare('SELECT * FROM artifacts WHERE id = ?');
    this.byWorkItem = db.prepare('SELECT * FROM artifacts WHERE work_item_id = ? ORDER BY created_at');
    this.byWorkflowRun = db.prepare('SELECT * FROM artifacts WHERE workflow_run_id = ? ORDER BY created_at');
  }

  save(a: ArtifactRecord): void {
    this.insert.run(
      a.id, a.workItemId ?? null, a.workflowRunId ?? null,
      a.stepExecutionId ?? null, a.type, a.ref ?? null,
      a.path ?? null, a.hash ?? null, a.createdAt,
    );
  }

  findById(id: string): ArtifactRecord | undefined {
    const r = this.byId.get(id) as Record<string, unknown> | undefined;
    return r ? rowToArtifact(r) : undefined;
  }

  listByWorkItem(workItemId: string): ArtifactRecord[] {
    return (this.byWorkItem.all(workItemId) as Record<string, unknown>[]).map(rowToArtifact);
  }

  listByWorkflowRun(workflowRunId: string): ArtifactRecord[] {
    return (this.byWorkflowRun.all(workflowRunId) as Record<string, unknown>[]).map(rowToArtifact);
  }
}

function rowToArtifact(r: Record<string, unknown>): ArtifactRecord {
  return {
    id: r.id as string,
    workItemId: r.work_item_id as string | undefined ?? undefined,
    workflowRunId: r.workflow_run_id as string | undefined ?? undefined,
    stepExecutionId: r.step_execution_id as string | undefined ?? undefined,
    type: r.type as string,
    ref: r.ref as string | undefined ?? undefined,
    path: r.path as string | undefined ?? undefined,
    hash: r.hash as string | undefined ?? undefined,
    createdAt: r.created_at as string,
  };
}

// ============================================================================
// EventRepository — append-only
// ============================================================================

export class EventRepository {
  private readonly insertStmt: Database.Statement;
  private readonly byId: Database.Statement;
  private readonly byWorkspace: Database.Statement;
  private readonly byWorkItem: Database.Statement;
  private readonly after: Database.Statement;
  private readonly byType: Database.Statement;

  constructor(db: Database.Database) {
    this.insertStmt = db.prepare(`
      INSERT INTO events
        (id, schema_version, type, workspace_id, project_id, work_item_id, workflow_run_id, occurred_at, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.byId = db.prepare('SELECT * FROM events WHERE id = ?');
    this.byWorkspace = db.prepare('SELECT * FROM events WHERE workspace_id = ? ORDER BY occurred_at, id');
    this.byWorkItem = db.prepare('SELECT * FROM events WHERE work_item_id = ? ORDER BY occurred_at, id');
    this.after = db.prepare(
      'SELECT * FROM events WHERE workspace_id = ? AND occurred_at > ? ORDER BY occurred_at, id LIMIT ?'
    );
    this.byType = db.prepare(
      'SELECT * FROM events WHERE workspace_id = ? AND type = ? ORDER BY occurred_at, id'
    );
  }

  append(event: DomainEvent): void {
    this.insertStmt.run(
      event.id, event.schemaVersion, event.type,
      event.workspaceId, event.projectId ?? null,
      event.workItemId ?? null, event.workflowRunId ?? null,
      event.occurredAt, JSON.stringify(event.payload),
    );
  }

  findById(id: string): DomainEvent | undefined {
    const r = this.byId.get(id) as Record<string, unknown> | undefined;
    return r ? rowToEvent(r) : undefined;
  }

  listByWorkspace(workspaceId: string): DomainEvent[] {
    return (this.byWorkspace.all(workspaceId) as Record<string, unknown>[]).map(rowToEvent);
  }

  listByWorkItem(workItemId: string): DomainEvent[] {
    return (this.byWorkItem.all(workItemId) as Record<string, unknown>[]).map(rowToEvent);
  }

  listAfter(workspaceId: string, occurredAt: string, limit = 100): DomainEvent[] {
    return (this.after.all(workspaceId, occurredAt, limit) as Record<string, unknown>[]).map(rowToEvent);
  }

  listByType(workspaceId: string, type: string): DomainEvent[] {
    return (this.byType.all(workspaceId, type) as Record<string, unknown>[]).map(rowToEvent);
  }
}

function rowToEvent(r: Record<string, unknown>): DomainEvent {
  return {
    id: r.id as string,
    schemaVersion: 1,
    type: r.type as string,
    workspaceId: r.workspace_id as string,
    projectId: r.project_id as string | undefined ?? undefined,
    workItemId: r.work_item_id as string | undefined ?? undefined,
    workflowRunId: r.workflow_run_id as string | undefined ?? undefined,
    occurredAt: r.occurred_at as string,
    payload: JSON.parse(r.payload_json as string),
  };
}
