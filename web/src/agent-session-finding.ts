export type AgentFindingKind = 'update' | 'proposal';
export interface AgentFindingSource { sessionId: string; eventSeq: number }
export interface AgentFindingDraft {
  kind: AgentFindingKind;
  title: string;
  body: string;
  source: AgentFindingSource;
}

export function createAgentFindingDraft(kind: AgentFindingKind, title: string, body: string, source: AgentFindingSource): AgentFindingDraft {
  return { kind, title, body, source: { ...source } };
}

export function updateAgentFindingDraft(draft: AgentFindingDraft, change: Pick<AgentFindingDraft, 'title' | 'body'>): AgentFindingDraft {
  return { ...draft, ...change, source: { ...draft.source } };
}

export function agentFindingDraftKey(draft: AgentFindingDraft): string {
  return `${draft.source.sessionId}:${draft.source.eventSeq}`;
}

export function agentEventElementId(sessionId: string, eventSeq: number): string {
  return `agent-event-${encodeURIComponent(sessionId)}-${eventSeq}`;
}
