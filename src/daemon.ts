import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { writePidFile, removePidFile } from './pid-file.js';
import type { StateAPI } from './state-api.js';
import type { InitService } from './init-service.js';
import type { DiscoveryService } from './discovery-service.js';
import type { APIResponse, APIError } from './types.js';

interface DaemonConfig {
  port?: number;
  projectRoot?: string;
}

interface DaemonDeps {
  stateAPI: StateAPI;
  initService: InitService;
  discoveryService: DiscoveryService;
  pidFile: {
    writePidFile: (path: string, pid: number) => Promise<void>;
    removePidFile: (path: string) => Promise<void>;
  };
}

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
      pidFile: { writePidFile, removePidFile },
    };
  }

  async start(config: DaemonConfig, deps: DaemonDeps): Promise<void> {
    this.config = config;
    this.deps = deps;
    const port = this.config.port ?? 7700;

    await this.deps.pidFile.writePidFile('.sle/daemon.pid', process.pid);

    this.server = createServer(async (req, res) => {
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

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const method = req.method || 'GET';
    const path = url.pathname;

    if (path === '/api/v2/health' && method === 'GET') {
      const result = await this.deps.stateAPI.health();
      this.sendResponse(res, result);
      return;
    }

    if (path === '/api/v2/info' && method === 'GET') {
      const result = await this.deps.stateAPI.info();
      this.sendResponse(res, result);
      return;
    }

    if (path === '/api/v2/system/state' && method === 'GET') {
      const result = await this.deps.stateAPI.getSystemState();
      this.sendResponse(res, result);
      return;
    }

    if (path === '/api/v2/system/state/transition' && method === 'POST') {
      const body = await this.parseBody(req);
      const result = await this.deps.stateAPI.transition(body as Parameters<StateAPI['transition']>[0]);
      this.sendResponse(res, result);
      return;
    }

    if (path === '/api/v2/system/flags' && method === 'GET') {
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

    if (path === '/api/v2/system/flags' && method === 'PATCH') {
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

    if (path === '/api/v2/init' && method === 'POST') {
      const body = await this.parseBody(req);
      const result = await this.deps.initService.init(body as Parameters<InitService['init']>[0]);
      this.sendResponse(res, result);
      return;
    }

    if (path === '/api/v2/init/state' && method === 'GET') {
      const result = await this.deps.initService.getStatus();
      this.sendResponse(res, result);
      return;
    }

    if (path === '/api/v2/discovery/start' && method === 'POST') {
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

    const roundMatch = path.match(/^\/api\/v2\/discovery\/round\/(\d+)\/(approve|response)$/);
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
        await this.deps.discoveryService.submitResponse(sessionId, round);
        this.sendResponse(res, {
          ok: true,
          data: { round, status: 'collecting' },
          meta: {
            request_id: randomUUID(),
            timestamp: new Date().toISOString(),
          },
        });
        return;
      }
    }

    if (path === '/api/v2/discovery/status' && method === 'GET') {
      const sessionId = url.searchParams.get('session_id') || '';
      const result = await this.deps.discoveryService.getStatus(sessionId);
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

    this.sendError(res, 404, 'not_found', 'Route not found');
  }

  private async parseBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (chunk) => {
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
