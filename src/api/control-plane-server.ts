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

export interface ControlPlaneServerOptions {
  db: Database.Database;
  workspaceId: string;
  workService: WorkService;
  evidenceService: EvidenceService;
  port?: number;
}

export class ControlPlaneServer {
  private readonly server: Server;
  readonly port: number;

  constructor(opts: ControlPlaneServerOptions) {
    this.port = opts.port ?? 7373;

    const router = new Router();
    const attention = new AttentionService(opts.db);
    const projects = new ProjectRepository(opts.db);
    const workItems = new WorkItemRepository(opts.db);
    const decisions = new DecisionRepository(opts.db);
    const evidence = new EvidenceRepository(opts.db);
    const events = new EventRepository(opts.db);

    makeAttentionHandlers(router, attention, projects, opts.workspaceId);
    makeProjectHandlers(router, projects, opts.workspaceId);
    makeWorkHandlers(router, workItems, opts.workService);
    makeDecisionHandlers(router, decisions, opts.workService);
    makeEvidenceHandlers(router, evidence, opts.evidenceService);
    makeEventHandlers(router, events, opts.workspaceId);
    makeWorkflowHandlers(router);

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
