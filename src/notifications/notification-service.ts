import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import type { NotificationChannel, NotificationPayload, ChannelRecord, WebhookConfig } from './types.js';
import { WebhookChannel } from './webhook-channel.js';

class ChannelRepository {
  private readonly insert: Database.Statement;
  private readonly all: Database.Statement;
  private readonly byId: Database.Statement;
  private readonly setEnabledStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.insert = db.prepare(
      'INSERT INTO notification_channels (id, name, type, config_json, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    this.all = db.prepare("SELECT * FROM notification_channels ORDER BY created_at");
    this.byId = db.prepare('SELECT * FROM notification_channels WHERE id = ?');
    this.setEnabledStmt = db.prepare('UPDATE notification_channels SET enabled = ? WHERE id = ?');
  }

  save(r: ChannelRecord): void {
    this.insert.run(r.id, r.name, r.type, JSON.stringify(r.config), r.enabled ? 1 : 0, r.createdAt);
  }

  listAll(): ChannelRecord[] {
    return (this.all.all() as Record<string, unknown>[]).map(rowToChannel);
  }

  findById(id: string): ChannelRecord | undefined {
    const r = this.byId.get(id) as Record<string, unknown> | undefined;
    return r ? rowToChannel(r) : undefined;
  }

  setEnabled(id: string, enabled: boolean): void {
    this.setEnabledStmt.run(enabled ? 1 : 0, id);
  }
}

function rowToChannel(r: Record<string, unknown>): ChannelRecord {
  return {
    id: r.id as string,
    name: r.name as string,
    type: r.type as 'webhook',
    config: JSON.parse(r.config_json as string) as WebhookConfig,
    enabled: (r.enabled as number) === 1,
    createdAt: r.created_at as string,
  };
}

// ============================================================================
// NotificationService
// ============================================================================

export class NotificationService {
  private readonly repo: ChannelRepository;
  private readonly channels = new Map<string, NotificationChannel>();

  constructor(db: Database.Database) {
    this.repo = new ChannelRepository(db);
    // Hydrate channels from DB on construction
    for (const r of this.repo.listAll()) {
      if (r.enabled) this.channels.set(r.id, buildChannel(r));
    }
  }

  addWebhook(name: string, config: WebhookConfig): ChannelRecord {
    const record: ChannelRecord = {
      id: randomUUID(),
      name,
      type: 'webhook',
      config,
      enabled: true,
      createdAt: new Date().toISOString(),
    };
    this.repo.save(record);
    this.channels.set(record.id, buildChannel(record));
    return record;
  }

  removeChannel(id: string): boolean {
    const r = this.repo.findById(id);
    if (!r || !r.enabled) return false;
    this.repo.setEnabled(id, false);
    this.channels.delete(id);
    return true;
  }

  listChannels(): ChannelRecord[] {
    return this.repo.listAll();
  }

  async send(payload: NotificationPayload): Promise<{ sent: number; errors: string[] }> {
    const errors: string[] = [];
    let sent = 0;
    for (const ch of this.channels.values()) {
      try {
        await ch.send(payload);
        sent++;
      } catch (e) {
        errors.push(`${ch.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return { sent, errors };
  }
}

function buildChannel(r: ChannelRecord): NotificationChannel {
  if (r.type === 'webhook') {
    return new WebhookChannel(r.id, r.name, r.config as WebhookConfig);
  }
  throw new Error(`Unknown channel type: ${r.type}`);
}
