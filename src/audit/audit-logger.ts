import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import type { AuditEvent } from './types.js';

export class AuditLogger {
  private readonly insert: Database.Statement;
  private readonly byResource: Database.Statement;
  private readonly recent: Database.Statement;

  constructor(db: Database.Database) {
    this.insert = db.prepare(`
      INSERT INTO audit_events (id, token_id, action, resource_type, resource_id, details_json, ip_address, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.byResource = db.prepare(
      'SELECT * FROM audit_events WHERE resource_type = ? AND resource_id = ? ORDER BY occurred_at DESC',
    );
    this.recent = db.prepare(
      'SELECT * FROM audit_events ORDER BY occurred_at DESC LIMIT ?',
    );
  }

  log(
    action: AuditEvent['action'],
    resourceType: string,
    resourceId: string,
    opts: { tokenId?: string; details?: Record<string, unknown>; ipAddress?: string } = {},
  ): AuditEvent {
    const event: AuditEvent = {
      id: randomUUID(),
      tokenId: opts.tokenId,
      action,
      resourceType,
      resourceId,
      details: opts.details,
      ipAddress: opts.ipAddress,
      occurredAt: new Date().toISOString(),
    };
    this.insert.run(
      event.id,
      event.tokenId ?? null,
      event.action,
      event.resourceType,
      event.resourceId,
      event.details ? JSON.stringify(event.details) : null,
      event.ipAddress ?? null,
      event.occurredAt,
    );
    return event;
  }

  listByResource(resourceType: string, resourceId: string): AuditEvent[] {
    return (this.byResource.all(resourceType, resourceId) as Record<string, unknown>[]).map(rowToAudit);
  }

  listRecent(limit = 50): AuditEvent[] {
    return (this.recent.all(limit) as Record<string, unknown>[]).map(rowToAudit);
  }
}

function rowToAudit(r: Record<string, unknown>): AuditEvent {
  return {
    id: r.id as string,
    tokenId: r.token_id as string | undefined ?? undefined,
    action: r.action as string,
    resourceType: r.resource_type as string,
    resourceId: r.resource_id as string,
    details: r.details_json ? JSON.parse(r.details_json as string) : undefined,
    ipAddress: r.ip_address as string | undefined ?? undefined,
    occurredAt: r.occurred_at as string,
  };
}
