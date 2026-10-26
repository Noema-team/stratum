export type AgentSessionLifecycle = 'starting' | 'idle' | 'running' | 'awaiting_permission' | 'interrupted' | 'outcome_unknown' | 'stopped' | 'failed';

export interface RuntimeWorkspace {
  id: string;
  projectId: string;
  processId?: string;
  repositoryId?: string;
  workspaceMode: 'repository_snapshot' | 'empty';
  hostPath: string;
  repositoryCommit?: string;
  accessMode: 'read_only';
  engineStatePath: string;
}

export interface AgentSession {
  id: string;
  projectId: string;
  processId?: string;
  associatedProcessId?: string;
  workspaceId: string;
  repositoryId?: string;
  repositoryRemote?: string;
  repositoryCommit?: string;
  explorationLabel?: string;
  engine: 'goose-acp';
  engineSessionId?: string;
  lifecycle: AgentSessionLifecycle;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  lastEventSeq: number;
}

export interface AgentSessionAssociation {
  id: string;
  sessionId: string;
  projectId: string;
  processId: string;
  associationType: 'historical' | 'active';
  idempotencyKey: string;
  createdAt: string;
}

export interface AgentEvent {
  sessionId: string;
  seq: number;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface PermissionRequest {
  id: string;
  sessionId: string;
  engineRequestId: string;
  operation: Record<string, unknown>;
  status: 'pending' | 'allow_once' | 'reject_once' | 'interrupted';
  createdAt: string;
  decidedAt?: string;
}

export interface AgentOperation {
  id: string;
  sessionId: string;
  idempotencyKey: string;
  kind: 'briefing' | 'prompt';
  promptText: string;
  status: 'intent' | 'dispatching' | 'completed' | 'cancelled' | 'failed' | 'outcome_unknown' | 'reconciled';
  createdAt: string;
  updatedAt: string;
}
