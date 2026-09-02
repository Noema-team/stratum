import { createServer as createHttpServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import { createServer as createHttpsServer } from 'https';
import { readFileSync } from 'fs';
import type Database from 'better-sqlite3';
import { Router } from './router.js';
import { AttentionService } from './attention-service.js';
import {
  ProjectRepository,
  WorkItemRepository,
  DecisionRepository,
  EvidenceRepository,
  EventRepository,
  StepExecutionRepository,
  ArtifactRepository,
} from '../storage/repositories.js';
import { ObjectiveService } from '../services/objective-service.js';
import { makeAttentionHandlers } from './handlers/attention.js';
import { makeProjectHandlers } from './handlers/projects.js';
import { makeWorkHandlers } from './handlers/work.js';
import { makeDecisionHandlers } from './handlers/decisions.js';
import { makeEvidenceHandlers } from './handlers/evidence.js';
import { makeEventHandlers } from './handlers/events.js';
import { makeWorkflowHandlers } from './handlers/workflows.js';
import { makeArtifactHandlers } from './handlers/artifacts.js';
import { makeObjectiveHandlers } from './handlers/objectives.js';
import type { WorkService } from '../services/work-service.js';
import type { EvidenceService } from '../services/evidence-service.js';
import type { ResumeService } from '../services/resume-service.js';
import { TokenStore } from '../auth/token-store.js';
import { AuditLogger } from '../audit/audit-logger.js';
import { NotificationService } from '../notifications/notification-service.js';
import { ok, err } from './types.js';
import { dashboardHtml } from './dashboard.js';

export interface ControlPlaneServerOptions {
  db: Database.Database;
  workspaceId: string;
  workService: WorkService;
  evidenceService: EvidenceService;
  // When provided, checkpoint Decisions route through ResumeService for full
  // durable lifecycle (cursor advance + execution continuation).
  resumeService?: ResumeService;
  port?: number;
  requireAuth?: boolean;
  // TLS: provide both certPath and keyPath to serve HTTPS instead of HTTP.
  tls?: { certPath: string; keyPath: string };
}

export type ControlPlaneProtocol = 'http' | 'https';

export class ControlPlaneServer {
  private readonly server: Server;
  readonly port: number;
  readonly protocol: ControlPlaneProtocol;

  constructor(opts: ControlPlaneServerOptions) {
    this.port = opts.port ?? 7373;
    this.protocol = opts.tls ? 'https' : 'http';

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
    const stepExecutions = new StepExecutionRepository(opts.db);
    const artifacts = new ArtifactRepository(opts.db);
    const objectiveService = new ObjectiveService(opts.db, opts.workspaceId);

    if (opts.requireAuth) {
      router.setAuth(raw => tokens.validate(raw));
    }

    makeAttentionHandlers(router, attention, projects, opts.workspaceId);
    makeProjectHandlers(router, projects, opts.workspaceId);
    makeWorkHandlers(router, workItems, opts.workService, projects, opts.workspaceId);
    makeDecisionHandlers(router, decisions, opts.workService, opts.resumeService, projects, opts.workspaceId);
    makeEvidenceHandlers(router, evidence, opts.evidenceService, workItems, projects, opts.workspaceId);
    makeEventHandlers(router, events, opts.workspaceId, workItems, projects);
    makeArtifactHandlers(router, artifacts, workItems, projects, opts.workspaceId);
    makeObjectiveHandlers(router, objectiveService, workItems, projects, opts.workspaceId);
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

    // ── §30 Observability endpoints ──────────────────────────────────────────

    router.add('GET', '/observability/summary', _req => {
      const active = workItems.countByStateInWorkspace(opts.workspaceId, 'running');
      const ready = workItems.countByStateInWorkspace(opts.workspaceId, 'ready');
      const failed = workItems.countByStateInWorkspace(opts.workspaceId, 'failed');
      const blocked = workItems.countByStateInWorkspace(opts.workspaceId, 'blocked');
      const needsDecision = workItems.countByStateInWorkspace(opts.workspaceId, 'needs_decision');
      const completed = workItems.countByStateInWorkspace(opts.workspaceId, 'completed');
      const cancelled = workItems.countByStateInWorkspace(opts.workspaceId, 'cancelled');
      const inReview = workItems.countByStateInWorkspace(opts.workspaceId, 'in_review');
      const paused = workItems.countByStateInWorkspace(opts.workspaceId, 'paused');
      const draft = workItems.countByStateInWorkspace(opts.workspaceId, 'draft');
      return ok({
        workspaceId: opts.workspaceId,
        counts: {
          active,
          ready,
          inReview,
          draft,
          paused,
          failed,
          blocked,
          needsDecision,
          completed,
          cancelled,
        },
        total: active + ready + inReview + draft + paused + failed + blocked + needsDecision + completed + cancelled,
      });
    });

    router.add('GET', '/observability/work/:id', req => {
      const item = workItems.findById(req.params.id);
      if (!item) return err('not_found', `WorkItem ${req.params.id} not found`);
      const p = projects.findById(item.projectId);
      if (!p || p.workspaceId !== opts.workspaceId)
        return err('not_found', `WorkItem ${req.params.id} not found`);

      const steps = stepExecutions.listByWorkItem(req.params.id);
      const ev = evidence.listByWorkItem(req.params.id);

      const stepSummaries = steps.map(s => ({
        id: s.id,
        stepId: s.stepId,
        executor: s.executor,
        state: s.state,
        attempt: s.attempt,
        durationMs: s.startedAt && s.completedAt
          ? new Date(s.completedAt).getTime() - new Date(s.startedAt).getTime()
          : null,
        failureCode: s.failure?.code ?? null,
        failureMessage: s.failure?.message ?? null,
        startedAt: s.startedAt ?? null,
        completedAt: s.completedAt ?? null,
      }));

      const failureCategories = stepSummaries
        .filter(s => s.failureCode)
        .reduce<Record<string, number>>((acc, s) => {
          const code = s.failureCode!;
          acc[code] = (acc[code] ?? 0) + 1;
          return acc;
        }, {});

      return ok({
        workItemId: item.id,
        state: item.state,
        stepExecutions: stepSummaries,
        failureCategories,
        evidenceCount: ev.length,
        evidenceTypes: [...new Set(ev.map(e => e.type))],
        totalDurationMs: stepSummaries.reduce((sum, s) => sum + (s.durationMs ?? 0), 0),
      });
    });

    const html = dashboardHtml();

    const handler = (req: IncomingMessage, res: ServerResponse) => {
      const pathname = (req.url ?? '/').split('?')[0];
      if ((pathname === '/' || pathname === '/dashboard') && req.method === 'GET') {
        const buf = Buffer.from(html, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': buf.byteLength });
        res.end(buf);
        return;
      }
      router.handle(req, res).catch(e => {
        const msg = e instanceof Error ? e.message : String(e);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: { code: 'internal_error', message: msg } }));
      });
    };

    if (opts.tls) {
      const cert = readFileSync(opts.tls.certPath);
      const key = readFileSync(opts.tls.keyPath);
      this.server = createHttpsServer({ cert, key }, handler);
    } else {
      this.server = createHttpServer(handler);
    }
  }

  listen(): Promise<void> {
    return new Promise(resolve => this.server.listen(this.port, () => {
      // When port 0 is requested the OS assigns one — update this.port so callers can read it.
      const addr = this.server.address();
      if (addr && typeof addr === 'object') (this as { port: number }).port = addr.port;
      (resolve as () => void)();
    }));
  }

  close(): Promise<void> {
    return new Promise<void>((resolve, reject) =>
      this.server.close(e => (e ? reject(e) : resolve())),
    );
  }
}
