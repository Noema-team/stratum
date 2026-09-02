export type SensitiveAction =
  | 'decision.resolved'
  | 'work.cancelled'
  | 'work.failed'
  | 'work.paused'
  | 'work.resumed'
  | 'work.complete'
  | 'work.block'
  | 'token.created'
  | 'token.revoked';

export interface AuditEvent {
  id: string;
  tokenId?: string;
  action: SensitiveAction | string;
  resourceType: string;
  resourceId: string;
  details?: Record<string, unknown>;
  ipAddress?: string;
  occurredAt: string;
}
