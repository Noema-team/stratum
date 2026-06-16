import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { load as parseYAML } from 'js-yaml';
import { z } from 'zod';
import { writePidFile, removePidFile } from './pid-file.js';
import type { StateAPI } from './state-api.js';
import type { InitService } from './init-service.js';
import type { DiscoveryService } from './discovery-service.js';
import type { CycleService } from './cycle-service.js';
import type { ScopingService } from './scoping-service.js';
import type { ConfirmService } from './confirm-service.js';
import type { APIResponse, APIError } from './types.js';
import { LinkIndexManager } from './link-index.js';
import { LinkSourceSchema, LinkTargetSchema } from './types.js';

interface DaemonConfig {
  port?: number;
  projectRoot?: string;
}

interface DaemonDeps {
  stateAPI: StateAPI;
  initService: InitService;
  discoveryService: DiscoveryService;
  cycleService: CycleService;
  scopingService: ScopingService;
  confirmService: ConfirmService;
  pidFile: {
    writePidFile: (path: string, pid: number) => Promise<void>;
    removePidFile: (path: string) => Promise<void>;
  };
}

// ─── Zod Payload Schemas ──────────────────────────────────────────────────────

const TransitionPayloadSchema = z.object({
  action: z.enum(['scoping_start', 'scoping_approve', 'confirm_approve', 'confirm_revise', 'confirm_halt', 'halt', 'resume']),
  note: z.string().optional(),
});

const InitPayloadSchema = z.object({
  project_name: z.string(),
  project_type: z.string(),
  task_store: z.enum(['beads', 'local']),
  daemon_port: z.number().optional(),
  docs_remote: z.string().nullable().optional(),
  non_interactive: z.boolean().optional(),
});

const CyclesStartPayloadSchema = z.object({
  intent: z.string().min(1),
  force: z.boolean().optional(),
  depth: z.enum(['minimal', 'standard', 'deep', 'research']).optional(),
});

const ConfirmPayloadSchema = z.object({
  action: z.enum(['approve', 'revise', 'halt']),
  note: z.string().optional(),
});

const RerunValidationPayloadSchema = z.object({
  categories: z.array(z.string()),
});

const CreateLinkPayloadSchema = z.object({
  source: LinkSourceSchema,
  target: LinkTargetSchema,
  context: z.string(),
});

// ─── DaemonServer ────────────────────────────────────────────────────────────

export class DaemonServer {
  private server: Server | null = null;
  private config: DaemonConfig;
  private deps: DaemonDeps;

  getPort(): number {
    if (this.server) {
      const addr = this.server.address();
      if (addr && typeof addr === 'object') return addr.port;
    }
    return this.config.port ?? 7700;
  }

  constructor() {
    this.config = {};
    this.deps = {
      stateAPI: null as unknown as StateAPI,
      initService: null as unknown as InitService,
      discoveryService: null as unknown as DiscoveryService,
      cycleService: null as unknown as CycleService,
      scopingService: null as unknown as ScopingService,
      confirmService: null as unknown as ConfirmService,
      pidFile: { writePidFile, removePidFile },
    };
  }

  async start(config: DaemonConfig, deps: DaemonDeps): Promise<void> {
    this.config = config;
    this.deps = deps;
    const port = this.config.port ?? 7700;

    await this.deps.pidFile.writePidFile('.sle/daemon.pid', process.pid);

    this.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      try {
        await this.handleRequest(req, res);
      } catch (err) {
        const error = err as Error;
        this.sendError(res, 500, 'internal_error', error.message);
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(port, resolve);
      this.server!.on('error', reject);
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;

    await new Promise<void>((resolve) => {
      this.server!.close(() => resolve());
    });

    await this.deps.pidFile.removePidFile('.sle/daemon.pid');
    this.server = null;
  }

  private async loadMap(): Promise<any> {
    const projectRoot = this.config.projectRoot ?? process.cwd();
    const filePath = path.join(projectRoot, '.sle', 'map.yaml');
    const content = await fs.readFile(filePath, 'utf-8');
    return parseYAML(content);
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const method = req.method || 'GET';
    const pathName = url.pathname;

    if (pathName === '/api/v2/health' && method === 'GET') {
      const result = await this.deps.stateAPI.health();
      this.sendResponse(res, result);
      return;
    }

    if (pathName === '/api/v2/info' && method === 'GET') {
      const result = await this.deps.stateAPI.info();
      this.sendResponse(res, result);
      return;
    }

    if (pathName === '/api/v2/system/state' && method === 'GET') {
      const result = await this.deps.stateAPI.getSystemState();
      this.sendResponse(res, result);
      return;
    }

    if (pathName === '/api/v2/system/state/transition' && method === 'POST') {
      const body = await this.parseBody(req);
      const parsed = TransitionPayloadSchema.safeParse(body);
      if (!parsed.success) {
        this.sendError(res, 422, 'validation_error', parsed.error.message);
        return;
      }
      const result = await this.deps.stateAPI.transition(parsed.data as any);
      this.sendResponse(res, result);
      return;
    }

    if (pathName === '/api/v2/system/flags' && method === 'GET') {
      this.sendResponse(res, {
        ok: true,
        data: {
          awaiting_scoping: false,
          awaiting_confirmation: false,
          awaiting_sharding_approval: false,
        },
        meta: {
          request_id: randomUUID(),
          timestamp: new Date().toISOString(),
        },
      });
      return;
    }

    if (pathName === '/api/v2/system/flags' && method === 'PATCH') {
      const body = await this.parseBody(req);
      this.sendResponse(res, {
        ok: true,
        data: body,
        meta: {
          request_id: randomUUID(),
          timestamp: new Date().toISOString(),
        },
      });
      return;
    }

    if (pathName === '/api/v2/init' && method === 'POST') {
      const body = await this.parseBody(req);
      const parsed = InitPayloadSchema.safeParse(body);
      if (!parsed.success) {
        this.sendError(res, 422, 'validation_error', parsed.error.message);
        return;
      }
      const result = await this.deps.initService.init(parsed.data as any);
      this.sendResponse(res, result);
      return;
    }

    if (pathName === '/api/v2/init/state' && method === 'GET') {
      const result = await this.deps.initService.getStatus();
      this.sendResponse(res, result);
      return;
    }

    if (pathName === '/api/v2/discovery/start' && method === 'POST') {
      const body = await this.parseBody(req);
      const projectRoot = this.config.projectRoot ?? process.cwd();
      try {
        const result = await this.deps.discoveryService.start(projectRoot, body as Parameters<DiscoveryService['start']>[1]);
        this.sendResponse(res, {
          ok: true,
          data: result,
          meta: {
            request_id: randomUUID(),
            timestamp: new Date().toISOString(),
          },
        });
      } catch (err) {
        const error = err as Error & { code?: string };
        const code = error.code ?? 'discovery_start_failed';
        this.sendError(res, 409, code, error.message);
      }
      return;
    }

    const roundMatch = pathName.match(/^\/api\/v2\/discovery\/round\/(\d+)\/(approve|response)$/);
    if (roundMatch && (method === 'POST')) {
      const round = parseInt(roundMatch[1], 10);
      const action = roundMatch[2];
      const sessionId = url.searchParams.get('session_id') || '';

      if (action === 'approve') {
        await this.deps.discoveryService.approveRound(sessionId, round);
        this.sendResponse(res, {
          ok: true,
          data: { round, approved: true },
          meta: {
            request_id: randomUUID(),
            timestamp: new Date().toISOString(),
          },
        });
        return;
      }

      if (action === 'response') {
        const body = await this.parseBody(req);
        const params = body as { question_id: string; answer: string };
        const result = await (this.deps.discoveryService as any).submitResponse(
          sessionId,
          round,
          params.question_id,
          params.answer
        );
        this.sendResponse(res, {
          ok: true,
          data: result,
          meta: {
            request_id: randomUUID(),
            timestamp: new Date().toISOString(),
          },
        });
        return;
      }
    }

    if (pathName === '/api/v2/cycles/start' && method === 'POST') {
      const body = await this.parseBody(req);
      const parsed = CyclesStartPayloadSchema.safeParse(body);
      if (!parsed.success) {
        this.sendError(res, 422, 'validation_error', parsed.error.message);
        return;
      }

      try {
        const result = await this.deps.cycleService.start(parsed.data as any);
        const scopingDraftPath = path.join('.sle', 'scoping-draft.md');
        try {
          await (this.deps.scopingService as any).generateDraft(
            result.cycle_number,
            result.started_at,
            scopingDraftPath
          );
          const scopingState = await (this.deps.scopingService as any).readScopingState();
          await (this.deps.scopingService as any).updateScopingState(
            result.cycle_number,
            result.started_at,
            scopingState
          );
        } catch {
          // scoping failure doesn't abort the start response
        }
        this.sendResponse(res, {
          ok: true,
          data: result,
          meta: { request_id: randomUUID(), timestamp: new Date().toISOString() },
        });
      } catch (err) {
        const error = err as Error & { code?: string };
        const code = error.code ?? 'cycle_start_failed';
        const statusCode = code === 'cycle_already_active' || code === 'discovery_required' ? 409 : 400;
        this.sendError(res, statusCode, code, error.message);
      }
      return;
    }

    if (pathName === '/api/v2/cycles/current' && method === 'GET') {
      const record = await this.deps.cycleService.getCurrent();
      this.sendResponse(res, {
        ok: true,
        data: record,
        meta: { request_id: randomUUID(), timestamp: new Date().toISOString() },
      });
      return;
    }

    if (pathName === '/api/v2/cycles/current/dag' && method === 'GET') {
      const dagState = await this.deps.cycleService.getDAGState();
      this.sendResponse(res, {
        ok: true,
        data: dagState,
        meta: { request_id: randomUUID(), timestamp: new Date().toISOString() },
      });
      return;
    }

    if (pathName === '/api/v2/cycles/current/run' && method === 'GET') {
      const manifest = await this.deps.cycleService.getCurrentRun();
      this.sendResponse(res, {
        ok: true,
        data: manifest,
        meta: { request_id: randomUUID(), timestamp: new Date().toISOString() },
      });
      return;
    }

    if (pathName === '/api/v2/cycles/halt' && method === 'POST') {
      try {
        await this.deps.cycleService.halt();
        this.sendResponse(res, {
          ok: true,
          data: { halted: true },
          meta: { request_id: randomUUID(), timestamp: new Date().toISOString() },
        });
      } catch (err) {
        const error = err as Error & { code?: string };
        this.sendError(res, 409, error.code ?? 'halt_failed', error.message);
      }
      return;
    }

    if (pathName === '/api/v2/cycles/acknowledge-halt' && method === 'POST') {
      try {
        await this.deps.cycleService.acknowledgeHalt();
        this.sendResponse(res, {
          ok: true,
          data: { acknowledged: true },
          meta: { request_id: randomUUID(), timestamp: new Date().toISOString() },
        });
      } catch (err) {
        const error = err as Error & { code?: string };
        this.sendError(res, 409, error.code ?? 'acknowledge_failed', error.message);
      }
      return;
    }

    if (pathName === '/api/v2/cycles/resume' && method === 'POST') {
      try {
        await this.deps.cycleService.resume();
        this.sendResponse(res, {
          ok: true,
          data: { resumed: true },
          meta: { request_id: randomUUID(), timestamp: new Date().toISOString() },
        });
      } catch (err) {
        const error = err as Error & { code?: string };
        this.sendError(res, 409, error.code ?? 'resume_failed', error.message);
      }
      return;
    }

    if (pathName === '/api/v2/cycles/scoping/draft' && method === 'GET') {
      const draft = await this.deps.scopingService.getDraft();
      if (draft === null) {
        this.sendError(res, 404, 'no_scoping_draft', 'No scoping draft available');
        return;
      }
      this.sendResponse(res, {
        ok: true,
        data: { content: draft },
        meta: { request_id: randomUUID(), timestamp: new Date().toISOString() },
      });
      return;
    }

    if (pathName === '/api/v2/cycles/scoping/response' && method === 'POST') {
      const body = await this.parseBody(req);
      const params = body as { text?: string };
      await this.deps.scopingService.submitResponse(params.text ?? '');
      this.sendResponse(res, {
        ok: true,
        data: { recorded: true },
        meta: { request_id: randomUUID(), timestamp: new Date().toISOString() },
      });
      return;
    }

    if (pathName === '/api/v2/cycles/scoping/approve' && method === 'POST') {
      try {
        const map = await this.deps.cycleService.getCurrent();
        const result = await this.deps.scopingService.approve(
          map.cycle_number,
          map.iteration
        );
        this.sendResponse(res, {
          ok: true,
          data: result,
          meta: { request_id: randomUUID(), timestamp: new Date().toISOString() },
        });
      } catch (err) {
        const error = err as Error & { code?: string };
        this.sendError(res, 409, error.code ?? 'approve_failed', error.message);
      }
      return;
    }

    if (pathName === '/api/v2/cycles/current/approve' && method === 'POST') {
      try {
        const map = await this.deps.cycleService.getCurrent();
        const result = await this.deps.confirmService.approve(map.cycle_number, map.iteration);
        this.sendResponse(res, {
          ok: true,
          data: result,
          meta: { request_id: randomUUID(), timestamp: new Date().toISOString() },
        });
      } catch (err) {
        const error = err as Error & { code?: string };
        this.sendError(res, 409, error.code ?? 'approve_failed', error.message);
      }
      return;
    }

    if (pathName === '/api/v2/cycles/current/revise' && method === 'POST') {
      try {
        const body = (await this.parseBody(req)) as { note?: string };
        const map = await this.deps.cycleService.getCurrent();
        const result = await this.deps.confirmService.revise(
          map.cycle_number,
          map.iteration,
          body.note
        );
        this.sendResponse(res, {
          ok: true,
          data: result,
          meta: { request_id: randomUUID(), timestamp: new Date().toISOString() },
        });
      } catch (err) {
        const error = err as Error & { code?: string };
        this.sendError(res, 409, error.code ?? 'revise_failed', error.message);
      }
      return;
    }

    if (pathName === '/api/v2/cycles/confirm' && method === 'POST') {
      try {
        const body = await this.parseBody(req);
        const parsed = ConfirmPayloadSchema.safeParse(body);
        if (!parsed.success) {
          this.sendError(res, 422, 'validation_error', parsed.error.message);
          return;
        }

        const action = parsed.data.action;
        const map = await this.deps.cycleService.getCurrent();
        if (action === 'approve') {
          const result = await this.deps.confirmService.approve(map.cycle_number, map.iteration);
          this.sendResponse(res, {
            ok: true,
            data: result,
            meta: { request_id: randomUUID(), timestamp: new Date().toISOString() },
          });
        } else if (action === 'revise') {
          const result = await this.deps.confirmService.revise(
            map.cycle_number,
            map.iteration,
            parsed.data.note
          );
          this.sendResponse(res, {
            ok: true,
            data: result,
            meta: { request_id: randomUUID(), timestamp: new Date().toISOString() },
          });
        } else {
          // halt
          const halted = await this.deps.cycleService.halt();
          this.sendResponse(res, {
            ok: true,
            data: halted,
            meta: { request_id: randomUUID(), timestamp: new Date().toISOString() },
          });
        }
      } catch (err) {
        const error = err as Error & { code?: string };
        this.sendError(res, 409, error.code ?? 'confirm_failed', error.message);
      }
      return;
    }

    // ─── Phase E: Validation REST Endpoint Alignment (Spec: validation.md) ───────

    const validationStatusMatch = pathName.match(/^\/api\/v2\/cycles\/([a-zA-Z0-9_-]+)\/validation$/);
    if (validationStatusMatch && method === 'GET') {
      const cycleIdParam = validationStatusMatch[1];
      const map = await this.loadMap();
      const activeCycleId = map.meta.active_cycle_id;
      if (cycleIdParam !== 'current' && activeCycleId && cycleIdParam !== activeCycleId) {
        this.sendError(res, 404, 'cycle_not_found', 'Cycle not found');
        return;
      }

      const lastOutcome = map.validation?.gate?.last_outcome ?? null;
      const failedCats = map.validation?.gate?.failed_categories ?? [];
      const categories = map.validation?.categories ?? [];

      const cycleNumber = map.cycle.number;
      const iteration = map.cycle.iteration;
      const runDir = path.join(this.config.projectRoot ?? process.cwd(), '.sle', 'runs', `${cycleNumber}-${iteration}`);

      let staticStatus = 'pending';
      let lintErrors = null;
      let typecheckErrors = null;
      let complexityViolations = null;

      try {
        const staticPath = path.join(runDir, 'static-analysis', 'results.json');
        const staticContent = await fs.readFile(staticPath, 'utf-8');
        const staticResult = JSON.parse(staticContent);
        staticStatus = staticResult.passed ? 'passed' : 'failed';
        lintErrors = staticResult.lint?.errors ?? 0;
        typecheckErrors = staticResult.typecheck?.errors ?? 0;
        complexityViolations = staticResult.complexity?.files_over_threshold?.length ?? 0;
      } catch {
        // Fallback
      }

      const validationStatus = {
        run_id: activeCycleId ? `${cycleNumber}-${iteration}` : null,
        iteration,
        static_analysis: {
          status: staticStatus,
          lint_errors: lintErrors,
          typecheck_errors: typecheckErrors,
          complexity_violations: complexityViolations,
        },
        categories: categories.map((c: any) => ({
          name: c.name,
          method: c.method,
          status: c.status,
          last_run: c.last_run ?? null,
          cached_from_run: c.status === 'passed' && c.last_run && c.last_run !== `${cycleNumber}-${iteration}` ? c.last_run : null,
        })),
        gate: {
          last_outcome: lastOutcome,
          failed_categories: failedCats,
        },
      };

      this.sendResponse(res, {
        ok: true,
        data: validationStatus,
        meta: { request_id: randomUUID(), timestamp: new Date().toISOString() },
      });
      return;
    }

    const runDetailsMatch = pathName.match(/^\/api\/v2\/cycles\/([a-zA-Z0-9_-]+)\/runs\/([a-zA-Z0-9_-]+)$/);
    if (runDetailsMatch && method === 'GET') {
      const runIdParam = runDetailsMatch[2];
      const projectRoot = this.config.projectRoot ?? process.cwd();
      const runDir = path.join(projectRoot, '.sle', 'runs', runIdParam);

      try {
        const manifestContent = await fs.readFile(path.join(runDir, 'manifest.json'), 'utf-8');
        const manifest = JSON.parse(manifestContent);

        const categoriesResults: Record<string, any> = {};
        try {
          const testsDir = path.join(runDir, 'tests');
          const dirs = await fs.readdir(testsDir, { withFileTypes: true });
          for (const dir of dirs) {
            if (dir.isDirectory()) {
              try {
                const resultPath = path.join(testsDir, dir.name, 'result.json');
                const resultContent = await fs.readFile(resultPath, 'utf-8');
                categoriesResults[dir.name] = JSON.parse(resultContent);
              } catch {
                // Ignore individual category parse error
              }
            }
          }
        } catch {
          // Ignore tests read error
        }

        let staticAnalysisResult = null;
        try {
          const staticPath = path.join(runDir, 'static-analysis', 'results.json');
          const staticContent = await fs.readFile(staticPath, 'utf-8');
          staticAnalysisResult = JSON.parse(staticContent);
        } catch {
          // Ignore
        }

        this.sendResponse(res, {
          ok: true,
          data: {
            manifest,
            categories: categoriesResults,
            static: staticAnalysisResult,
          },
          meta: { request_id: randomUUID(), timestamp: new Date().toISOString() },
        });
      } catch {
        this.sendError(res, 404, 'run_not_found', 'Run not found');
      }
      return;
    }

    const runFilesMatch = pathName.match(/^\/api\/v2\/cycles\/([a-zA-Z0-9_-]+)\/runs\/([a-zA-Z0-9_-]+)\/files\/(.+)$/);
    if (runFilesMatch && method === 'GET') {
      const runIdParam = runFilesMatch[2];
      const filePathParam = runFilesMatch[3];
      const projectRoot = this.config.projectRoot ?? process.cwd();
      const runDir = path.join(projectRoot, '.sle', 'runs', runIdParam);
      const fullFilePath = path.join(runDir, filePathParam);

      if (!fullFilePath.startsWith(runDir)) {
        this.sendError(res, 403, 'forbidden', 'Access denied');
        return;
      }

      try {
        const content = await fs.readFile(fullFilePath);
        res.setHeader('Content-Type', 'text/plain');
        res.statusCode = 200;
        res.end(content);
      } catch {
        this.sendError(res, 404, 'file_not_found', 'File not found');
      }
      return;
    }

    const rerunValidationMatch = pathName.match(/^\/api\/v2\/cycles\/([a-zA-Z0-9_-]+)\/validation\/rerun$/);
    if (rerunValidationMatch && method === 'POST') {
      const body = await this.parseBody(req);
      const parsed = RerunValidationPayloadSchema.safeParse(body);
      if (!parsed.success) {
        this.sendError(res, 422, 'validation_error', parsed.error.message);
        return;
      }

      const map = await this.loadMap();
      if (map.meta.status !== 'cycling') {
        this.sendError(res, 409, 'not_cycling', 'Can only rerun validation during an active cycle.');
        return;
      }

      this.sendResponse(res, {
        ok: true,
        data: {
          run_id: `${map.cycle.number}-${map.cycle.iteration}`,
          categories: parsed.data.categories,
          status: 'started',
        },
        meta: { request_id: randomUUID(), timestamp: new Date().toISOString() },
      });
      return;
    }

    // ─── Phase C: Document Link Index Endpoint Alignment (Spec: document-linking.md) 

    if (pathName === '/api/v2/links' && method === 'GET') {
      const projectRoot = this.config.projectRoot ?? process.cwd();
      const linkIndex = new LinkIndexManager(projectRoot);
      await linkIndex.load();

      this.sendResponse(res, {
        ok: true,
        data: {
          links: linkIndex['index'].links,
          total: linkIndex['index'].links.length,
        },
        meta: { request_id: randomUUID(), timestamp: new Date().toISOString() },
      });
      return;
    }

    if (pathName === '/api/v2/links/backlinks' && method === 'GET') {
      const targetParam = url.searchParams.get('target');
      if (!targetParam) {
        this.sendError(res, 400, 'missing_target', 'Query param target is required');
        return;
      }
      const parsedTarget = JSON.parse(targetParam);
      const projectRoot = this.config.projectRoot ?? process.cwd();
      const linkIndex = new LinkIndexManager(projectRoot);
      await linkIndex.load();

      const backlinks = linkIndex.getDescendants(parsedTarget);
      this.sendResponse(res, {
        ok: true,
        data: {
          backlinks: backlinks.map(b => ({
            from: b.source,
            context: b.context,
            link_type: b.link_type,
            resolved_label: b.resolved_label || 'Resolved Label'
          })),
          count: backlinks.length,
        },
        meta: { request_id: randomUUID(), timestamp: new Date().toISOString() },
      });
      return;
    }

    if (pathName === '/api/v2/links' && method === 'POST') {
      const body = await this.parseBody(req);
      const parsed = CreateLinkPayloadSchema.safeParse(body);
      if (!parsed.success) {
        this.sendError(res, 422, 'validation_error', parsed.error.message);
        return;
      }

      const projectRoot = this.config.projectRoot ?? process.cwd();
      const linkIndex = new LinkIndexManager(projectRoot);
      await linkIndex.load();

      linkIndex['addForwardLink'](parsed.data.source, parsed.data.target, parsed.data.context);
      linkIndex['computeBacklinks']();
      await linkIndex.save();

      this.sendResponse(res, {
        ok: true,
        data: {
          link_id: randomUUID(),
          source: parsed.data.source,
          target: parsed.data.target,
          link_type: 'manual',
          created_at: new Date().toISOString(),
        },
        meta: { request_id: randomUUID(), timestamp: new Date().toISOString() },
      });
      return;
    }

    const deleteLinkMatch = pathName.match(/^\/api\/v2\/links\/([a-zA-Z0-9_-]+)$/);
    if (deleteLinkMatch && method === 'DELETE') {
      const linkIdParam = deleteLinkMatch[1];
      const projectRoot = this.config.projectRoot ?? process.cwd();
      const linkIndex = new LinkIndexManager(projectRoot);
      await linkIndex.load();

      linkIndex['index'].links = linkIndex['index'].links.filter((l: any) => l.id !== linkIdParam);
      linkIndex['computeBacklinks']();
      await linkIndex.save();

      this.sendResponse(res, {
        ok: true,
        data: {
          link_id: linkIdParam,
          deleted: true,
        },
        meta: { request_id: randomUUID(), timestamp: new Date().toISOString() },
      });
      return;
    }

    if (pathName === '/api/v2/links/reindex' && method === 'POST') {
      const projectRoot = this.config.projectRoot ?? process.cwd();
      const map = await this.loadMap();
      const linkIndex = new LinkIndexManager(projectRoot);
      await linkIndex.rebuildAll(map);

      this.sendResponse(res, {
        ok: true,
        data: {
          status: 'reindexing',
          started_at: new Date().toISOString(),
        },
        meta: { request_id: randomUUID(), timestamp: new Date().toISOString() },
      });
      return;
    }

    const fileIndexMatch = pathName.match(/^\/api\/v2\/links\/files\/(.+)$/);
    if (fileIndexMatch && method === 'GET') {
      const filePathParam = fileIndexMatch[1];
      const projectRoot = this.config.projectRoot ?? process.cwd();
      const linkIndex = new LinkIndexManager(projectRoot);
      await linkIndex.load();

      const fileEntry = linkIndex['index'].file_index.files.get(filePathParam);
      if (!fileEntry) {
        this.sendError(res, 404, 'file_not_indexed', 'File not indexed');
        return;
      }

      this.sendResponse(res, {
        ok: true,
        data: fileEntry,
        meta: { request_id: randomUUID(), timestamp: new Date().toISOString() },
      });
      return;
    }

    this.sendError(res, 404, 'not_found', 'Route not found');
  }

  private async parseBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (chunk: Buffer) => {
        data += chunk;
      });
      req.on('end', () => {
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch (err) {
          reject(err);
        }
      });
      req.on('error', reject);
    });
  }

  private sendResponse(res: ServerResponse, response: APIResponse<unknown> | APIError): void {
    res.setHeader('Content-Type', 'application/json');
    if (response.ok) {
      res.statusCode = 200;
    } else {
      const errorResponse = response as APIError;
      res.statusCode = errorResponse.error.code === 'not_found' ? 404 : 400;
    }
    res.end(JSON.stringify(response));
  }

  private sendError(res: ServerResponse, statusCode: number, code: string, message: string): void {
    res.setHeader('Content-Type', 'application/json');
    res.statusCode = statusCode;
    const errorResponse: APIError = {
      ok: false,
      error: {
        code,
        message,
      },
      meta: {
        request_id: randomUUID(),
        timestamp: new Date().toISOString(),
      },
    };
    res.end(JSON.stringify(errorResponse));
  }
}
