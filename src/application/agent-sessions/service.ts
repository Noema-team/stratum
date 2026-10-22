import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { RepositoryRepository } from '../../storage/repositories.js';
import { ProcessService, ProcessServiceError } from '../processes/service.js';
import { createReadOnlySnapshot, resolveAuthorizedCheckout, resolveWorkspaceReadPath } from './workspace.js';
import type { AgentOperation, AgentEvent, AgentSession, PermissionRequest, RuntimeWorkspace } from './types.js';
import type { AgentRuntime, AgentRuntimeCallbacks, RuntimePermissionResult } from './runtime.js';

export class AgentSessionServiceError extends Error {
  constructor(message: string, readonly code: 'INVALID' | 'NOT_FOUND' | 'CONFLICT' | 'UNAVAILABLE' = 'INVALID') { super(message); }
}

export class AgentSessionService {
  private readonly permissionWaiters = new Map<string, (result: RuntimePermissionResult) => void>();
  private readonly activeOperations = new Set<string>();

  constructor(
    private readonly db: Database.Database,
    private readonly workspaceId: string,
    private readonly processes: ProcessService,
    private readonly repositories: RepositoryRepository,
    private readonly runtime: AgentRuntime,
    private readonly runtimeBasePath: string,
  ) {}

  reconcileHostRestart(): void {
    const rows = this.db.prepare(`SELECT id FROM app_agent_sessions WHERE lifecycle IN
      ('starting','idle','running','awaiting_permission','interrupted','outcome_unknown')`).all() as { id: string }[];
    const now = new Date().toISOString();
    for (const row of rows) {
      try { this.runtime.stopStaleContainer(row.id); } catch { /* status remains interrupted; explicit reconciliation will surface failure */ }
      this.db.transaction(() => {
        this.db.prepare(`UPDATE app_agent_session_operations SET status='outcome_unknown',updated_at=?
          WHERE session_id=? AND status='dispatching'`).run(now, row.id);
        this.db.prepare(`UPDATE app_agent_session_permissions SET status='interrupted'
          WHERE session_id=? AND status='pending'`).run(row.id);
        const unknown = this.db.prepare(`SELECT 1 FROM app_agent_session_operations WHERE session_id=? AND status='outcome_unknown' LIMIT 1`).get(row.id);
        const lifecycle = unknown ? 'outcome_unknown' : 'interrupted';
        this.db.prepare('UPDATE app_agent_sessions SET lifecycle=?,updated_at=? WHERE id=?').run(lifecycle, now, row.id);
        this.appendEvent(row.id, 'host_restarted', { lifecycle }, now);
      })();
      this.rejectPendingPermissions(row.id);
    }
  }

  findForProcess(processId: string): AgentSession | undefined {
    const process = this.getProcess(processId);
    const row = this.db.prepare(`SELECT s.*,w.repository_id,w.repository_commit,r.remote AS repository_remote
      FROM app_agent_sessions s JOIN app_runtime_workspaces w ON w.id=s.workspace_id
      JOIN repositories r ON r.id=w.repository_id WHERE s.process_id=? ORDER BY s.created_at DESC LIMIT 1`).get(process.id) as Record<string, unknown> | undefined;
    return row ? this.toSession(row) : undefined;
  }

  listEvents(sessionId: string, after = 0, limit = 200): AgentEvent[] {
    this.requireSession(sessionId);
    const bounded = Math.max(1, Math.min(500, Math.trunc(limit) || 200));
    return (this.db.prepare(`SELECT session_id AS sessionId,seq,event_type AS eventType,payload_json AS payload,created_at AS createdAt
      FROM app_agent_session_events WHERE session_id=? AND seq>? ORDER BY seq LIMIT ?`).all(sessionId, Math.max(0, after), bounded) as Array<Record<string, unknown>>)
      .map(row => ({ sessionId: row.sessionId as string, seq: row.seq as number, eventType: row.eventType as string,
        payload: JSON.parse(row.payload as string) as Record<string, unknown>, createdAt: row.createdAt as string }));
  }

  listPermissions(sessionId: string): PermissionRequest[] {
    this.requireSession(sessionId);
    return (this.db.prepare(`SELECT id,session_id AS sessionId,engine_request_id AS engineRequestId,operation_json AS operation,
      status,created_at AS createdAt,decided_at AS decidedAt FROM app_agent_session_permissions WHERE session_id=? ORDER BY created_at`).all(sessionId) as Array<Record<string, unknown>>)
      .map(row => ({ ...row, operation: JSON.parse(row.operation as string) } as PermissionRequest));
  }

  listOperations(sessionId: string): AgentOperation[] {
    this.requireSession(sessionId);
    return this.db.prepare(`SELECT id,session_id AS sessionId,idempotency_key AS idempotencyKey,kind,prompt_text AS promptText,status,
      created_at AS createdAt,updated_at AS updatedAt FROM app_agent_session_operations WHERE session_id=? ORDER BY created_at`).all(sessionId) as AgentOperation[];
  }

  create(processId: string, repositoryId: string): AgentSession {
    const details = this.processes.get(processId);
    const process = details.process;
    if (process.lifecycle !== 'active') throw new AgentSessionServiceError('Start an agent only on an active Process');
    const repository = this.repositories.findById(repositoryId);
    if (!repository || repository.projectId !== process.projectId || !this.repositories.isLinkedToProject(process.projectId, repositoryId)) {
      throw new AgentSessionServiceError('Repository is not linked to this Process Project', 'NOT_FOUND');
    }
    let checkout;
    try { checkout = resolveAuthorizedCheckout(process, repository); }
    catch (error) { throw new AgentSessionServiceError(error instanceof Error ? error.message : 'Repository checkout is not authorized'); }

    const current = this.findForProcess(processId);
    if (current && current.lifecycle !== 'stopped' && current.lifecycle !== 'failed') {
      throw new AgentSessionServiceError('This Process already has an AgentSession; resume or stop it first', 'CONFLICT');
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    const engineStatePath = path.join(this.runtimeBasePath, 'sessions', id);
    mkdirSync(engineStatePath, { recursive: true, mode: 0o700 });
    const snapshotPath = createReadOnlySnapshot(checkout.path, checkout.commit, engineStatePath);
    const workspace: RuntimeWorkspace = { id: randomUUID(), projectId: process.projectId, processId, repositoryId,
      hostPath: snapshotPath, repositoryCommit: checkout.commit, accessMode: 'read_only', engineStatePath };
    const briefing = this.makeBriefing(processId, details.definitionVersions[0]?.version ?? 1, repository.remote, checkout.commit);
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO app_runtime_workspaces (id,project_id,process_id,repository_id,host_path,repository_commit,
        access_mode,engine_state_path,status,created_at) VALUES (?,?,?,?,?,?,'read_only',?,'ready',?)`)
        .run(workspace.id, workspace.projectId, workspace.processId, workspace.repositoryId, workspace.hostPath,
          workspace.repositoryCommit, workspace.engineStatePath, now);
      this.db.prepare(`INSERT INTO app_agent_sessions (id,project_id,process_id,workspace_id,engine,lifecycle,created_by,created_at,updated_at)
        VALUES (?,?,?,?,'goose-acp','starting','local-user',?,?)`).run(id, process.projectId, processId, workspace.id, now, now);
      this.db.prepare(`INSERT INTO app_agent_session_operations (id,session_id,idempotency_key,kind,prompt_text,status,created_at,updated_at)
        VALUES (?,?,'stratum-initial-briefing-v1','briefing',?,'intent',?,?)`).run(randomUUID(), id, briefing, now, now);
      this.appendEvent(id, 'session_start_requested', { engine: 'Goose 1.54.0 via ACP', repository: repository.remote,
        repositoryCommit: checkout.commit, accessMode: 'read_only' }, now);
    })();
    const created = this.findForProcess(processId)!;
    void this.startNew(created, workspace, briefing);
    return created;
  }

  submitPrompt(sessionId: string, idempotencyKey: string, text: string): AgentOperation {
    const session = this.requireSession(sessionId);
    if (!/^[0-9a-f-]{36}$/i.test(idempotencyKey)) throw new AgentSessionServiceError('prompt idempotencyKey must be a UUID');
    const prompt = text.trim();
    if (!prompt || prompt.length > 10000) throw new AgentSessionServiceError('prompt must be between 1 and 10000 characters');
    if (containsSecretLikeValue(prompt)) throw new AgentSessionServiceError('Do not send credentials in an AgentSession prompt');
    const existing = this.findOperation(sessionId, idempotencyKey);
    if (existing) {
      if (existing.promptText !== prompt) throw new AgentSessionServiceError('idempotencyKey was already used for different prompt text', 'CONFLICT');
      return existing;
    }
    if (session.lifecycle !== 'idle' || !session.engineSessionId || !this.runtime.hasHandle(sessionId)) {
      throw new AgentSessionServiceError('AgentSession must be connected and idle before sending a new prompt', 'CONFLICT');
    }
    const now = new Date().toISOString();
    const operation: AgentOperation = { id: randomUUID(), sessionId, idempotencyKey, kind: 'prompt', promptText: prompt,
      status: 'dispatching', createdAt: now, updatedAt: now };
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO app_agent_session_operations (id,session_id,idempotency_key,kind,prompt_text,status,created_at,updated_at)
        VALUES (?,?,?,'prompt',?,'dispatching',?,?)`).run(operation.id, sessionId, idempotencyKey, prompt, now, now);
      this.db.prepare('UPDATE app_agent_sessions SET lifecycle=?,updated_at=? WHERE id=?').run('running', now, sessionId);
      this.appendEvent(sessionId, 'user_prompt', { operationId: operation.id, text: redact(prompt) }, now);
    })();
    void this.runOperation(session, operation, prompt);
    return operation;
  }

  async cancel(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    if (!['running','awaiting_permission'].includes(session.lifecycle) || !session.engineSessionId || !this.runtime.hasHandle(sessionId)) {
      throw new AgentSessionServiceError('AgentSession has no active prompt to cancel', 'CONFLICT');
    }
    if (session.lifecycle === 'awaiting_permission') {
      for (const permission of this.listPermissions(sessionId).filter(item => item.status === 'pending')) {
        this.decidePermission(sessionId, permission.id, 'reject_once');
      }
    }
    await this.runtime.cancel(sessionId, session.engineSessionId);
    this.emit(sessionId, 'cancel_requested', { actor: 'local-user' });
  }

  async reconcile(sessionId: string): Promise<AgentSession> {
    const session = this.requireSession(sessionId);
    if (this.runtime.hasHandle(sessionId)) return this.requireSession(sessionId);
    if (!['interrupted', 'outcome_unknown', 'starting', 'failed'].includes(session.lifecycle)) {
      throw new AgentSessionServiceError('Only an interrupted or uncertain AgentSession can be reconciled', 'CONFLICT');
    }
    const workspace = this.getWorkspace(session.workspaceId);
    const callbacks = this.callbacks(sessionId, workspace);
    const restored = await this.runtime.start(session, workspace, callbacks, true);
    const now = new Date().toISOString();
    const unknown = this.db.prepare(`SELECT 1 FROM app_agent_session_operations WHERE session_id=? AND status='outcome_unknown' LIMIT 1`).get(sessionId);
    this.db.prepare('UPDATE app_agent_sessions SET engine_session_id=?,lifecycle=?,error_message=NULL,updated_at=? WHERE id=?')
      .run(restored.engineSessionId, unknown ? 'outcome_unknown' : 'idle', now, sessionId);
    this.emit(sessionId, 'session_reconciled', { nativeSessionRestored: true, unresolvedPromptOutcome: Boolean(unknown) });
    const briefing = this.findOperation(sessionId, 'stratum-initial-briefing-v1');
    if (!unknown && briefing?.status === 'intent') {
      const updated = this.requireSession(sessionId);
      void this.runOperation(updated, briefing, briefing.promptText);
    }
    return this.requireSession(sessionId);
  }

  acknowledgeUnknownOperation(sessionId: string, operationId: string): AgentSession {
    const session = this.requireSession(sessionId);
    if (session.lifecycle !== 'outcome_unknown' || !this.runtime.hasHandle(sessionId)) {
      throw new AgentSessionServiceError('Restore the conversation and inspect its recorded history before acknowledging an uncertain prompt', 'CONFLICT');
    }
    const result = this.db.prepare(`UPDATE app_agent_session_operations SET status='reconciled',updated_at=?
      WHERE id=? AND session_id=? AND status='outcome_unknown'`).run(new Date().toISOString(), operationId, sessionId);
    if (!result.changes) throw new AgentSessionServiceError('Unknown operation not found or already reconciled', 'NOT_FOUND');
    const remaining = this.db.prepare(`SELECT 1 FROM app_agent_session_operations WHERE session_id=? AND status='outcome_unknown' LIMIT 1`).get(sessionId);
    if (!remaining && this.runtime.hasHandle(sessionId)) this.db.prepare('UPDATE app_agent_sessions SET lifecycle=?,updated_at=? WHERE id=?').run('idle', new Date().toISOString(), sessionId);
    this.emit(sessionId, 'unknown_operation_acknowledged', { operationId, actor: 'local-user', resent: false });
    return this.requireSession(sessionId);
  }

  async stop(sessionId: string): Promise<AgentSession> {
    const session = this.requireSession(sessionId);
    await this.runtime.stop(sessionId);
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE app_agent_sessions SET lifecycle='stopped',updated_at=? WHERE id=?`).run(now, sessionId);
    this.db.prepare(`UPDATE app_runtime_workspaces SET status='closed',closed_at=? WHERE id=?`).run(now, session.workspaceId);
    this.emit(sessionId, 'session_stopped', { actor: 'local-user' });
    return this.requireSession(sessionId);
  }

  decidePermission(sessionId: string, permissionId: string, decision: 'allow_once' | 'reject_once'): PermissionRequest {
    this.requireSession(sessionId);
    const row = this.db.prepare(`SELECT * FROM app_agent_session_permissions WHERE id=? AND session_id=?`).get(permissionId, sessionId) as Record<string, unknown> | undefined;
    if (!row || row.status !== 'pending') throw new AgentSessionServiceError('Permission request is no longer pending', 'CONFLICT');
    const operation = JSON.parse(row.operation_json as string) as Record<string, unknown>;
    const options = Array.isArray(operation.options) ? operation.options as Array<Record<string, unknown>> : [];
    const option = options.find(item => item.kind === decision);
    if (!option || typeof option.optionId !== 'string') throw new AgentSessionServiceError('Goose did not offer that one-time permission outcome', 'INVALID');
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE app_agent_session_permissions SET status=?,decided_at=?,decided_by='local-user' WHERE id=? AND status='pending'`)
      .run(decision, now, permissionId);
    const response = { decision, optionId: option.optionId } satisfies RuntimePermissionResult;
    this.permissionWaiters.get(permissionId)?.(response);
    this.permissionWaiters.delete(permissionId);
    this.db.prepare('UPDATE app_agent_sessions SET lifecycle=?,updated_at=? WHERE id=?').run('running', now, sessionId);
    this.emit(sessionId, 'permission_decided', { permissionId, decision, actor: 'local-user', scope: operation });
    return this.listPermissions(sessionId).find(item => item.id === permissionId)!;
  }

  private async startNew(session: AgentSession, workspace: RuntimeWorkspace, briefing: string): Promise<void> {
    try {
      const result = await this.runtime.start(session, workspace, this.callbacks(session.id, workspace), false);
      this.db.prepare(`UPDATE app_agent_sessions SET engine_session_id=?,lifecycle='running',updated_at=? WHERE id=?`)
        .run(result.engineSessionId, new Date().toISOString(), session.id);
      const operation = this.findOperation(session.id, 'stratum-initial-briefing-v1')!;
      await this.runOperation(this.requireSession(session.id), operation, briefing);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not start Goose ACP';
      const unknown = /timed out|exited|closed|did not return a session id/i.test(message);
      const lifecycle = unknown ? 'outcome_unknown' : 'failed';
      const now = new Date().toISOString();
      this.db.prepare('UPDATE app_agent_sessions SET lifecycle=?,error_message=?,updated_at=? WHERE id=?').run(lifecycle, message.slice(0, 500), now, session.id);
      this.db.prepare(`UPDATE app_agent_session_operations SET status=?,updated_at=? WHERE session_id=? AND idempotency_key='stratum-initial-briefing-v1' AND status IN ('intent','dispatching')`)
        .run(unknown ? 'outcome_unknown' : 'failed', now, session.id);
      this.emit(session.id, lifecycle === 'outcome_unknown' ? 'session_outcome_unknown' : 'session_failed', { message: redact(message).slice(0, 500) });
    }
  }

  private async runOperation(session: AgentSession, operation: AgentOperation, prompt: string): Promise<void> {
    if (this.activeOperations.has(operation.id)) return;
    this.activeOperations.add(operation.id);
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE app_agent_session_operations SET status='dispatching',updated_at=? WHERE id=?`).run(now, operation.id);
    try {
      if (!session.engineSessionId) throw new Error('Goose engine session id is unavailable');
      const result = await this.runtime.prompt(session.id, session.engineSessionId, prompt);
      const completedAt = new Date().toISOString();
      const cancelled = result.stopReason === 'cancelled';
      this.db.prepare(`UPDATE app_agent_session_operations SET status=?,updated_at=? WHERE id=?`).run(cancelled ? 'cancelled' : 'completed', completedAt, operation.id);
      this.db.prepare(`UPDATE app_agent_sessions SET lifecycle='idle',updated_at=? WHERE id=? AND lifecycle NOT IN ('stopped','failed')`).run(completedAt, session.id);
      this.emit(session.id, cancelled ? 'prompt_cancelled' : 'prompt_completed', { operationId: operation.id, completionSource: 'ACP response' });
    } catch (error) {
      const failedAt = new Date().toISOString();
      this.db.prepare(`UPDATE app_agent_session_operations SET status='outcome_unknown',updated_at=? WHERE id=? AND status='dispatching'`).run(failedAt, operation.id);
      this.db.prepare(`UPDATE app_agent_sessions SET lifecycle='outcome_unknown',error_message=?,updated_at=? WHERE id=? AND lifecycle NOT IN ('stopped','failed')`)
        .run(error instanceof Error ? redact(error.message).slice(0, 500) : 'Prompt outcome is unknown', failedAt, session.id);
      this.emit(session.id, 'prompt_outcome_unknown', { operationId: operation.id, resent: false });
    } finally { this.activeOperations.delete(operation.id); }
  }

  private callbacks(sessionId: string, workspace: RuntimeWorkspace): AgentRuntimeCallbacks {
    return {
      onEvent: (eventType, payload) => this.emit(sessionId, eventType, payload),
      onLifecycle: (lifecycle, message) => {
        const now = new Date().toISOString();
        const current = this.db.prepare('SELECT lifecycle FROM app_agent_sessions WHERE id=?').get(sessionId) as { lifecycle: string } | undefined;
        if (!current || ['stopped','failed'].includes(current.lifecycle)) return;
        this.db.prepare('UPDATE app_agent_sessions SET lifecycle=?,error_message=?,updated_at=? WHERE id=?')
          .run(lifecycle, message ? redact(message).slice(0, 500) : null, now, sessionId);
        this.emit(sessionId, 'session_state', { lifecycle, message: message ? redact(message).slice(0, 300) : undefined });
        if (lifecycle === 'interrupted' || lifecycle === 'failed') this.rejectPendingPermissions(sessionId);
      },
      requestToolPermission: (requestId, operation, options) => this.waitForPermission(sessionId, requestId, operation, options),
      readWorkspaceFile: async (_requestId, requestedPath) => {
        const relativePath = requestedPath.startsWith('/workspace/') ? requestedPath.slice('/workspace/'.length) : requestedPath;
        const hostPath = resolveWorkspaceReadPath(workspace.hostPath, relativePath);
        return readFileSync(hostPath, 'utf8');
      },
    };
  }

  private waitForPermission(sessionId: string, requestId: string, operation: Record<string, unknown>, options: Array<Record<string, unknown>>): Promise<RuntimePermissionResult> {
    const now = new Date().toISOString();
    const id = randomUUID();
    const safeOperation = { ...operation, options: options.map(option => ({ optionId: option.optionId, kind: option.kind, name: option.name })) };
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO app_agent_session_permissions (id,session_id,engine_request_id,operation_json,status,created_at)
        VALUES (?,?,?,?,'pending',?)`).run(id, sessionId, requestId, JSON.stringify(sanitizeValue(safeOperation)), now);
      this.db.prepare(`UPDATE app_agent_sessions SET lifecycle='awaiting_permission',updated_at=? WHERE id=?`).run(now, sessionId);
      this.appendEvent(sessionId, 'permission_requested', { permissionId: id, operation: safeOperation }, now);
    })();
    return new Promise(resolve => this.permissionWaiters.set(id, resolve));
  }

  private rejectPendingPermissions(sessionId: string): void {
    const rows = this.db.prepare(`SELECT id,operation_json FROM app_agent_session_permissions WHERE session_id=? AND status='pending'`).all(sessionId) as Array<{ id: string; operation_json: string }>;
    const now = new Date().toISOString();
    for (const row of rows) {
      this.db.prepare(`UPDATE app_agent_session_permissions SET status='interrupted',decided_at=? WHERE id=? AND status='pending'`).run(now, row.id);
      const options = (JSON.parse(row.operation_json) as { options?: Array<Record<string, unknown>> }).options ?? [];
      const reject = options.find(option => option.kind === 'reject_once' && typeof option.optionId === 'string');
      if (reject) this.permissionWaiters.get(row.id)?.({ decision: 'reject_once', optionId: reject.optionId as string });
      this.permissionWaiters.delete(row.id);
    }
  }

  private makeBriefing(processId: string, definitionVersion: number, repository: string, commit: string): string {
    const process = this.getProcess(processId);
    return [
      'You are an investigation agent attached to a Stratum Process. This briefing is context, not execution authorization.',
      `Process: ${process.title}`,
      `Accepted definition version: ${definitionVersion}`,
      `Accepted intent: ${process.intent}`,
      `Desired outcomes: ${process.desiredOutcomes.length ? process.desiredOutcomes.join('; ') : '(none recorded)'}`,
      `Constraints: ${process.constraints.length ? process.constraints.join('; ') : '(none recorded)'}`,
      `Authorized repository: ${repository}`,
      `Workspace mode: read-only; starting commit ${commit}.`,
      'Only inspect the mounted repository. Do not write files, use a terminal, access other paths, push, merge, deploy, or claim that a test passed unless the host provides evidence.',
      'Clearly label conclusions as agent claims. Ask the user before taking any action requiring permission. Suggest findings or proposals; never treat them as accepted Process decisions or completion.',
    ].join('\n\n');
  }

  private getProcess(processId: string) {
    try { return this.processes.get(processId).process; }
    catch (error) { if (error instanceof ProcessServiceError) throw new AgentSessionServiceError(error.message, 'NOT_FOUND'); throw error; }
  }

  private requireSession(sessionId: string): AgentSession {
    const row = this.db.prepare(`SELECT s.*,w.repository_id,w.repository_commit,r.remote AS repository_remote
      FROM app_agent_sessions s JOIN app_runtime_workspaces w ON w.id=s.workspace_id
      JOIN repositories r ON r.id=w.repository_id WHERE s.id=? AND s.project_id IN
      (SELECT id FROM projects WHERE workspace_id=?)`).get(sessionId, this.workspaceId) as Record<string, unknown> | undefined;
    if (!row) throw new AgentSessionServiceError('AgentSession not found', 'NOT_FOUND');
    return this.toSession(row);
  }

  private getWorkspace(workspaceId: string): RuntimeWorkspace {
    const row = this.db.prepare(`SELECT * FROM app_runtime_workspaces WHERE id=? AND project_id IN
      (SELECT id FROM projects WHERE workspace_id=?)`).get(workspaceId, this.workspaceId) as Record<string, unknown> | undefined;
    if (!row) throw new AgentSessionServiceError('RuntimeWorkspace not found', 'NOT_FOUND');
    if (!existsSync(row.host_path as string) || !existsSync(row.engine_state_path as string)) throw new AgentSessionServiceError('RuntimeWorkspace paths are no longer available', 'CONFLICT');
    const statePath = realpathSync(row.engine_state_path as string);
    const storedPath = realpathSync(row.host_path as string);
    if (lstatSync(row.host_path as string).isSymbolicLink() || storedPath !== path.join(statePath, 'workspace')) {
      throw new AgentSessionServiceError('RuntimeWorkspace path no longer matches its managed read-only snapshot', 'CONFLICT');
    }
    return { id: row.id as string, projectId: row.project_id as string, processId: row.process_id as string,
      repositoryId: row.repository_id as string, hostPath: storedPath,
      repositoryCommit: row.repository_commit as string, accessMode: 'read_only', engineStatePath: statePath };
  }

  private findOperation(sessionId: string, key: string): AgentOperation | undefined {
    const row = this.db.prepare(`SELECT id,session_id AS sessionId,idempotency_key AS idempotencyKey,kind,prompt_text AS promptText,status,
      created_at AS createdAt,updated_at AS updatedAt FROM app_agent_session_operations WHERE session_id=? AND idempotency_key=?`).get(sessionId, key) as AgentOperation | undefined;
    return row;
  }

  private emit(sessionId: string, eventType: string, payload: Record<string, unknown>): void {
    const now = new Date().toISOString();
    this.db.transaction(() => this.appendEvent(sessionId, eventType, payload, now))();
  }

  private appendEvent(sessionId: string, eventType: string, payload: Record<string, unknown>, createdAt: string): void {
    const row = this.db.prepare('SELECT last_event_seq FROM app_agent_sessions WHERE id=?').get(sessionId) as { last_event_seq: number } | undefined;
    if (!row) return;
    const seq = row.last_event_seq + 1;
    this.db.prepare('INSERT INTO app_agent_session_events (session_id,seq,event_type,payload_json,created_at) VALUES (?,?,?,?,?)')
      .run(sessionId, seq, eventType, JSON.stringify(sanitizeValue(payload)), createdAt);
    this.db.prepare('UPDATE app_agent_sessions SET last_event_seq=? WHERE id=?').run(seq, sessionId);
  }

  private toSession(row: Record<string, unknown>): AgentSession {
    return { id: row.id as string, projectId: row.project_id as string, processId: row.process_id as string,
      workspaceId: row.workspace_id as string, repositoryId: row.repository_id as string, repositoryRemote: row.repository_remote as string,
      repositoryCommit: row.repository_commit as string, engine: row.engine as 'goose-acp', engineSessionId: row.engine_session_id as string | undefined,
      lifecycle: row.lifecycle as AgentSession['lifecycle'], errorMessage: row.error_message as string | undefined,
      createdAt: row.created_at as string, updatedAt: row.updated_at as string, lastEventSeq: row.last_event_seq as number };
  }
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === 'string') return redact(value).slice(0, 20_000);
  if (Array.isArray(value)) return value.slice(0, 100).map(sanitizeValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 100).map(([key, item]) => [key,
    /(api.?key|access.?token|secret|password|authorization)/i.test(key) ? '[REDACTED]' : sanitizeValue(item)]));
  return value;
}

function redact(value: string): string {
  return value.replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|secret)\s*[:=]\s*)[^\s,"']+/gi, '$1[REDACTED]');
}

function containsSecretLikeValue(value: string): boolean {
  return /\bsk-[A-Za-z0-9_-]{12,}\b|\bBearer\s+\S+/i.test(value);
}
