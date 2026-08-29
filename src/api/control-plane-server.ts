import { createServer, type Server } from 'http';
import type Database from 'better-sqlite3';
import { Router } from './router.js';
import { AttentionService } from './attention-service.js';
import {
  ProjectRepository,
  WorkItemRepository,
  DecisionRepository,
  EvidenceRepository,
  EventRepository,
} from '../storage/repositories.js';
import { makeAttentionHandlers } from './handlers/attention.js';
import { makeProjectHandlers } from './handlers/projects.js';
import { makeWorkHandlers } from './handlers/work.js';
import { makeDecisionHandlers } from './handlers/decisions.js';
import { makeEvidenceHandlers } from './handlers/evidence.js';
import { makeEventHandlers } from './handlers/events.js';
import { makeWorkflowHandlers } from './handlers/workflows.js';
import type { WorkService } from '../services/work-service.js';
import type { EvidenceService } from '../services/evidence-service.js';
import { TokenStore } from '../auth/token-store.js';
import { AuditLogger } from '../audit/audit-logger.js';
import { NotificationService } from '../notifications/notification-service.js';
import { ok, err } from './types.js';

export interface ControlPlaneServerOptions {
  db: Database.Database;
  workspaceId: string;
  workService: WorkService;
  evidenceService: EvidenceService;
  port?: number;
  requireAuth?: boolean;
}

export class ControlPlaneServer {
  private readonly server: Server;
  readonly port: number;

  constructor(opts: ControlPlaneServerOptions) {
    this.port = opts.port ?? 7373;

    const router = new Router();
    const tokens = new TokenStore(opts.db);
    const audit = new AuditLogger(opts.db);
    const notifications = new NotificationService(opts.db);
    const attention = new AttentionService(opts.db);
    const projects = new ProjectRepository(opts.db);
    const workItems = new WorkItemRepository(opts.db);
    const decisions = new DecisionRepository(opts.db);
    const evidence = new EvidenceRepository(opts.db);
    const events = new EventRepository(opts.db);

    if (opts.requireAuth) {
      router.setAuth(raw => tokens.validate(raw));
    }

    makeAttentionHandlers(router, attention, projects, opts.workspaceId);
    makeProjectHandlers(router, projects, opts.workspaceId);
    makeWorkHandlers(router, workItems, opts.workService);
    makeDecisionHandlers(router, decisions, opts.workService);
    makeEvidenceHandlers(router, evidence, opts.evidenceService);
    makeEventHandlers(router, events, opts.workspaceId);
    makeWorkflowHandlers(router);

    // Token management
    router.add('POST', '/tokens', req => {
      const body = req.body as Record<string, unknown> | null;
      const name = body?.name as string | undefined;
      if (!name?.trim()) return err('bad_request', 'name is required');
      const { token, record } = tokens.create(name.trim());
      audit.log('token.created', 'token', record.id, { tokenId: req.auth?.tokenId });
      return ok({ token, id: record.id, name: record.name, createdAt: record.createdAt });
    });

    router.add('GET', '/tokens', _req => {
      return ok(tokens.list().map(t => ({
        id: t.id,
        name: t.name,
        createdAt: t.createdAt,
        lastUsedAt: t.lastUsedAt ?? null,
        revokedAt: t.revokedAt ?? null,
      })));
    });

    router.add('DELETE', '/tokens/:id', req => {
      const revoked = tokens.revoke(req.params.id);
      if (!revoked) return err('not_found', `Token ${req.params.id} not found`);
      audit.log('token.revoked', 'token', req.params.id, { tokenId: req.auth?.tokenId });
      return ok({ revoked: true });
    });

    // Audit log
    router.add('GET', '/audit', req => {
      const limit = parseInt(req.query.limit ?? '50', 10);
      return ok(audit.listRecent(isNaN(limit) ? 50 : limit));
    });

    router.add('GET', '/audit/:resourceType/:resourceId', req => {
      return ok(audit.listByResource(req.params.resourceType, req.params.resourceId));
    });

    // Notification channels
    router.add('POST', '/notifications/channels', req => {
      const body = req.body as Record<string, unknown> | null;
      const name = body?.name as string | undefined;
      const url = (body?.config as Record<string, unknown> | undefined)?.url as string | undefined;
      if (!name?.trim()) return err('bad_request', 'name is required');
      if (!url?.trim()) return err('bad_request', 'config.url is required');
      const config = body?.config as { url: string; secret?: string; headers?: Record<string, string> };
      const record = notifications.addWebhook(name.trim(), config);
      return ok(record);
    });

    router.add('GET', '/notifications/channels', _req => {
      return ok(notifications.listChannels());
    });

    router.add('DELETE', '/notifications/channels/:id', req => {
      const removed = notifications.removeChannel(req.params.id);
      if (!removed) return err('not_found', `Channel ${req.params.id} not found`);
      return ok({ removed: true });
    });

    this.server = createServer((req, res) => {
      router.handle(req, res).catch(e => {
        const msg = e instanceof Error ? e.message : String(e);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: { code: 'internal_error', message: msg } }));
      });
    });
  }

  listen(): Promise<void> {
    return new Promise(resolve => this.server.listen(this.port, resolve as () => void));
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) =>
      this.server.close(e => (e ? reject(e) : resolve())),
    );
  }
}
