import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { promises as fs, existsSync } from 'fs';
import path from 'path';
import { load as parseYAML } from 'js-yaml';
import { z } from 'zod';
import { writePidFile, removePidFile } from './pid-file.js';
import { type StateAPI, TransitionRequestSchema } from './state-api.js';
import type { InitService } from './init-service.js';
import type { DiscoveryService } from './discovery-service.js';
import type { CycleService } from './cycle-service.js';
import type { ScopingService } from './scoping-service.js';
import type { ConfirmService } from './confirm-service.js';
import type { APIResponse, APIError, ShardingProposal } from './types.js';
import { LinkIndexManager } from './link-index.js';
import { LinkSourceSchema, LinkTargetSchema } from './types.js';
import type { IntakeService } from './intake-service.js';
import type { ShardingService } from './sharding-service.js';
import type { TagService } from './tag-service.js';
import type { TagPrefix } from './types.js';
import { ALL_ROLES } from './prompt-service.js';
import type { PromptService, RoleName } from './prompt-service.js';
import { ChatService } from './chat-service.js';
import { EventBus } from './event-bus.js';
import { RuntimeMapManagerImpl, type RuntimeMap } from './runtime-map.js';
import yaml from 'js-yaml';

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
  intakeService?: IntakeService;
  shardingService?: ShardingService;
  chatService?: ChatService;
  tagService?: TagService;
  promptService?: PromptService;
  llmProvider?: any;
  pidFile: {
    writePidFile: (path: string, pid: number) => Promise<void>;
    removePidFile: (path: string) => Promise<void>;
  };
}

// ─── Zod Payload Schemas ──────────────────────────────────────────────────────

const InitPayloadSchema = z.object({
  project_name: z.string(),
  project_type: z.string(),
  task_store: z.enum(['beads', 'local']),
  daemon_port: z.number().optional(),
  docs_remote: z.string().nullable().optional(),
  non_interactive: z.boolean().optional(),
  git_init: z.boolean().optional(),
});

const CyclesStartPayloadSchema = z.object({
  intent: z.string().min(1),
  force: z.boolean().optional(),
  depth: z.enum(['minimal', 'standard', 'deep', 'research']).optional(),
});

const SettingsPayloadSchema = z.object({
  provider: z.enum(['openai_compatible', 'anthropic', 'glm', 'openrouter']),
  base_url: z.string().optional().nullable(),
  model: z.string().min(1, 'model required'),
  api_key: z.string().optional().nullable(),
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

const TagPrefixValues = ['next-cycle', 'scope', 'area'] as const;

const AddTagPayloadSchema = z.object({
  prefix: z.enum(TagPrefixValues),
  target_ref: z.string().min(1),
  value: z.string().optional(),
});

// ─── DaemonServer ────────────────────────────────────────────────────────────

export class DaemonServer {
  private server: Server | null = null;
  private config: DaemonConfig;
  private deps: DaemonDeps;
  private eventBus: EventBus | null = null;
  private isProcessingStateCommand = false;

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

    // Instantiate EventBus attached to the HTTP server
    const projectRoot = this.config.projectRoot ?? process.cwd();
    const mapPath = path.join(projectRoot, '.sle', 'map.yaml');
    const mapManager = new RuntimeMapManagerImpl({ mapPath });
    this.eventBus = new EventBus(this.server, mapManager);

    // Forward state transitions to event bus
    this.deps.stateAPI.onStateChanged((event) => {
      if (this.eventBus) {
        this.eventBus.emit('system.state_changed', {
          previous: event.previous,
          current: event.current,
          reason: event.trigger,
        });
      }
    });

    // Wire up WebSocket client commands
    this.eventBus.registerCallbacks({
      onApprovalRespond: async (data) => {
        const map = await this.deps.cycleService.getCurrent();
        if (data.gate === 'CONFIRM') {
          if (data.decision === 'approve') {
            await this.deps.confirmService.approve(map.cycle_number, map.iteration);
          } else if (data.decision === 'revise') {
            await this.deps.confirmService.revise(map.cycle_number, map.iteration, data.message);
          } else {
            await this.deps.cycleService.halt();
          }
        } else if (data.gate === 'SHARDING_APPROVAL') {
          if (data.decision === 'approve') {
            const proposalPath = path.join(projectRoot, '.sle', 'sharding-proposal.yaml');
            try {
              const proposalContent = await fs.readFile(proposalPath, 'utf8');
              const proposal = yaml.load(proposalContent) as ShardingProposal;
              if (this.deps.shardingService) {
                await this.deps.shardingService.createTasksFromProposal(proposal);
              }
              try { await fs.unlink(proposalPath); } catch {}
              await mapManager.update((m: RuntimeMap) => ({
                ...m,
                cycle: {
                  ...m.cycle,
                  awaiting_sharding_approval: false,
                },
              }));
              if (this.eventBus) {
                await this.eventBus.emit('intake.sharding_approved', { tasks_created: proposal.tasks.length });
              }
            } catch {}
          } else {
            const proposalPath = path.join(projectRoot, '.sle', 'sharding-proposal.yaml');
            try { await fs.unlink(proposalPath); } catch {}
            await mapManager.update((m: RuntimeMap) => ({
              ...m,
              cycle: {
                ...m.cycle,
                awaiting_sharding_approval: false,
              },
            }));
            if (this.eventBus) {
              await this.eventBus.emit('intake.sharding_rejected', {});
            }
          }
        }
      },
      onCategoriesConfirm: async (data) => {
        if (this.eventBus) {
          await this.eventBus.emit('categories.confirmed', { categories: data.categories });
        }
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(port, resolve);
      this.server!.on('error', reject);
    });
  }

  async stop(): Promise<void> {
    if (this.eventBus) {
      this.eventBus.close();
      this.eventBus = null;
    }

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

  private getChatService(): ChatService {
    if (this.deps.chatService) return this.deps.chatService;
    const projectRoot = this.config.projectRoot ?? process.cwd();
    const mapPath = path.join(projectRoot, '.sle', 'map.yaml');
    const mapManager = new RuntimeMapManagerImpl({ mapPath });
    const service = new ChatService(
      projectRoot,
      mapManager,
      this.deps.llmProvider ?? null,
    );
    this.deps.chatService = service;
    return service;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const method = req.method || 'GET';
    const pathName = url.pathname;

    const isStateCommand = method !== 'GET' && pathName.startsWith('/api/v2/');

    if (isStateCommand) {
      if (this.isProcessingStateCommand) {
        this.sendError(res, 409, 'session_conflict', 'A state-changing operation is already in progress.');
        return;
      }
      this.isProcessingStateCommand = true;
    }

    try {
      await this.handleRequestInternal(req, res);
    } finally {
      if (isStateCommand) {
        this.isProcessingStateCommand = false;
      }
    }
  }

  private async handleRequestInternal(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
      try {
        const result = await this.deps.stateAPI.getSystemState();
        this.sendResponse(res, result);
      } catch {
        this.sendResponse(res, {
          ok: true,
          data: {
            state: 'idle',
            active_session_id: null,
            active_cycle_id: null,
            discovery_status: 'not_started',
            iteration: 0,
            revision: 0,
            awaiting_scoping: false,
            awaiting_confirmation: false,
            awaiting_sharding_approval: false,
            chat: { session_open: false },
          },
          meta: { request_id: randomUUID(), timestamp: new Date().toISOString() },
        });
      }
      return;
    }

    if (pathName === '/api/v2/system/state/transition' && method === 'POST') {
      const body = await this.parseBody(req);
      const parsed = TransitionRequestSchema.safeParse(body);
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

    if (pathName === '/api/v2/settings' && method === 'GET') {
      const projectRoot = this.config.projectRoot ?? process.cwd();
      const settingsPath = path.join(projectRoot, '.sle', 'settings.json');
      let data: any = {
        provider: 'openai_compatible',
        base_url: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        api_key: '',
      };

      let exists = false;
      try {
        await fs.access(settingsPath);
        exists = true;
      } catch {}

      if (exists) {
        try {
          const content = await fs.readFile(settingsPath, 'utf8');
          const saved = JSON.parse(content);
          data = {
            provider: saved.provider || 'openai_compatible',
            base_url: saved.base_url || '',
            model: saved.model || '',
            api_key: saved.api_key ? '••••••••' : '',
          };
        } catch {}
      } else {
        const hasKey = !!(
          process.env.OPENAI_API_KEY ||
          process.env.SLE_LLM_API_KEY ||
          process.env.ANTHROPIC_API_KEY ||
          process.env.GLM_API_KEY ||
          process.env.OPENROUTER_API_KEY
        );
        data.api_key = hasKey ? '••••••••' : '';
      }

      this.sendResponse(res, {
        ok: true,
        data,
        meta: {
          request_id: randomUUID(),
          timestamp: new Date().toISOString(),
        },
      });
      return;
    }

    if (pathName === '/api/v2/settings' && method === 'POST') {
      const body = await this.parseBody(req);
      const parsed = SettingsPayloadSchema.safeParse(body);
      if (!parsed.success) {
        this.sendError(res, 422, 'validation_error', parsed.error.message);
        return;
      }

      const projectRoot = this.config.projectRoot ?? process.cwd();
      const settingsPath = path.join(projectRoot, '.sle', 'settings.json');

      let existingSettings: any = {};
      try {
        const content = await fs.readFile(settingsPath, 'utf8');
        existingSettings = JSON.parse(content);
      } catch {}

      const { provider, base_url, model, api_key } = parsed.data;

      let finalApiKey = api_key;
      if (api_key === '••••••••') {
        finalApiKey = existingSettings.api_key || process.env.SLE_LLM_API_KEY || '';
      }

      const updatedSettings = {
        provider,
        base_url: base_url || '',
        model,
        api_key: finalApiKey || '',
      };

      try {
        await fs.mkdir(path.dirname(settingsPath), { recursive: true });
        await fs.writeFile(settingsPath, JSON.stringify(updatedSettings, null, 2), 'utf8');
      } catch (err) {
        this.sendError(res, 500, 'save_settings_failed', (err as Error).message);
        return;
      }

      if (this.deps.llmProvider) {
        try {
          if (finalApiKey) {
            process.env.SLE_LLM_API_KEY = finalApiKey;
          }

          const api_key_env = (
            provider === 'openai_compatible' ? 'OPENAI_API_KEY' :
            provider === 'anthropic' ? 'ANTHROPIC_API_KEY' :
            provider === 'glm' ? 'GLM_API_KEY' : 'OPENROUTER_API_KEY'
          );

          if (finalApiKey) {
            process.env[api_key_env] = finalApiKey;
          }

          const { createLLMProvider } = await import('./llm-provider.js');
          const newInner = createLLMProvider({
            provider,
            base_url: base_url || undefined,
            model,
            api_key_env,
          });

          if (typeof this.deps.llmProvider.setProvider === 'function') {
            this.deps.llmProvider.setProvider(newInner);
          } else {
            this.deps.llmProvider = newInner;
          }
        } catch (err) {
          this.sendError(res, 400, 'reload_provider_failed', (err as Error).message);
          return;
        }
      }

      this.sendResponse(res, {
        ok: true,
        data: {
          provider,
          base_url,
          model,
          api_key: finalApiKey ? '••••••••' : '',
        },
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

    if (pathName === '/api/v2/discovery/status' && method === 'GET') {
      const sessionId = url.searchParams.get('session_id') || '';
      try {
        const result = await this.deps.discoveryService.getStatus(sessionId);
        this.sendResponse(res, {
          ok: true,
          data: result,
          meta: {
            request_id: randomUUID(),
            timestamp: new Date().toISOString(),
          },
        });
      } catch (err) {
        const error = err as Error;
        this.sendError(res, 404, 'not_found', error.message);
      }
      return;
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
        try {
          await this.deps.scopingService.begin({
            workflowRunId: `daemon-${result.cycle_number}-1`,
            workflowId: 'full-build',
            stepId: 'scoping.produce',
            role: 'facilitator' as const,
            cycleNumber: result.cycle_number,
            iteration: 1,
            revision: 0,
            planningDepth: result.planning_depth,
            goal: result.intent,
            projectRoot: this.config.projectRoot ?? process.cwd(),
          });
        } catch {
          // scoping draft generation failure doesn't abort the start response
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
      try {
        const cycle = await this.deps.cycleService.getCurrent();
        await this.deps.scopingService.submitResponse(
          params.text ?? '',
          {
            workflowRunId: `daemon-${cycle.cycle_number}-${cycle.iteration}`,
            workflowId: 'full-build',
            stepId: 'scoping.produce',
            role: 'facilitator' as const,
            cycleNumber: cycle.cycle_number,
            iteration: cycle.iteration,
            revision: 0,
            planningDepth: cycle.planning_depth,
            goal: cycle.intent ?? '',
            projectRoot: this.config.projectRoot ?? process.cwd(),
            facilitatorMode: 'scoping' as const,
          },
        );
        this.sendResponse(res, {
          ok: true,
          data: { recorded: true },
          meta: { request_id: randomUUID(), timestamp: new Date().toISOString() },
        });
      } catch (err) {
        const error = err as Error & { code?: string };
        this.sendError(res, 409, error.code ?? 'scoping_response_failed', error.message);
      }
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
          const hasActionError = parsed.error.issues.some((issue) => issue.path.includes('action'));
          if (hasActionError) {
            this.sendError(res, 400, 'invalid_action', 'Invalid action');
            return;
          }
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

    if (pathName === '/api/v2/tags' && method === 'GET') {
      if (!this.deps.tagService) {
        this.sendError(res, 503, 'tag_service_unavailable', 'Tag service is not configured');
        return;
      }
      const prefixParam = url.searchParams.get('tag') ?? url.searchParams.get('prefix');
      const normalizedPrefix = prefixParam?.replace(/^#/, '');
      if (!normalizedPrefix || !TagPrefixValues.includes(normalizedPrefix as TagPrefix)) {
        this.sendError(res, 400, 'invalid_tag_prefix', 'Query param tag/prefix must be one of: next-cycle, scope, area');
        return;
      }
      const tags = await this.deps.tagService.getTagged(normalizedPrefix as TagPrefix);
      this.sendResponse(res, {
        ok: true,
        data: { tags, count: tags.length },
        meta: { request_id: randomUUID(), timestamp: new Date().toISOString() },
      });
      return;
    }

    if (pathName === '/api/v2/tags' && method === 'POST') {
      if (!this.deps.tagService) {
        this.sendError(res, 503, 'tag_service_unavailable', 'Tag service is not configured');
        return;
      }
      const body = await this.parseBody(req);
      const parsed = AddTagPayloadSchema.safeParse(body);
      if (!parsed.success) {
        this.sendError(res, 422, 'validation_error', parsed.error.message);
        return;
      }
      const tag = await this.deps.tagService.addTag(parsed.data);
      this.sendResponse(res, {
        ok: true,
        data: { tag },
        meta: { request_id: randomUUID(), timestamp: new Date().toISOString() },
      });
      return;
    }

    const deleteTagMatch = pathName.match(/^\/api\/v2\/tags\/(.+)$/);
    if (deleteTagMatch && method === 'DELETE') {
      if (!this.deps.tagService) {
        this.sendError(res, 503, 'tag_service_unavailable', 'Tag service is not configured');
        return;
      }
      const targetRef = decodeURIComponent(deleteTagMatch[1]);
      const prefixParam = url.searchParams.get('tag') ?? url.searchParams.get('prefix');
      const normalizedPrefix = prefixParam?.replace(/^#/, '');
      if (!normalizedPrefix || !TagPrefixValues.includes(normalizedPrefix as TagPrefix)) {
        this.sendError(res, 400, 'invalid_tag_prefix', 'Query param tag/prefix must be one of: next-cycle, scope, area');
        return;
      }
      const valueParam = url.searchParams.get('value') ?? undefined;
      const removed = await this.deps.tagService.removeTag(targetRef, normalizedPrefix as TagPrefix, valueParam);
      if (!removed) {
        this.sendError(res, 404, 'tag_not_found', 'No matching tag found for the given target_ref/prefix');
        return;
      }
      this.sendResponse(res, {
        ok: true,
        data: { target_ref: targetRef, deleted: true },
        meta: { request_id: randomUUID(), timestamp: new Date().toISOString() },
      });
      return;
    }

    if (pathName === '/api/v2/templates' && method === 'GET') {
      if (!this.deps.promptService) {
        this.sendError(res, 503, 'prompt_service_unavailable', 'Prompt service is not configured');
        return;
      }
      const templates = await this.deps.promptService.listTemplates();
      this.sendResponse(res, {
        ok: true,
        data: { templates },
        meta: { request_id: randomUUID(), timestamp: new Date().toISOString() },
      });
      return;
    }

    const templateRoleMatch = pathName.match(/^\/api\/v2\/templates\/([a-zA-Z0-9_-]+)$/);
    if (templateRoleMatch && method === 'GET') {
      if (!this.deps.promptService) {
        this.sendError(res, 503, 'prompt_service_unavailable', 'Prompt service is not configured');
        return;
      }
      const roleParam = templateRoleMatch[1] as RoleName;
      if (!ALL_ROLES.includes(roleParam)) {
        this.sendError(res, 400, 'invalid_role', `Unknown role: ${roleParam}`);
        return;
      }
      try {
        const template = await this.deps.promptService.getTemplate(roleParam);
        this.sendResponse(res, {
          ok: true,
          data: template,
          meta: { request_id: randomUUID(), timestamp: new Date().toISOString() },
        });
      } catch (err) {
        const error = err as Error & { code?: string };
        this.sendError(res, 404, error.code ?? 'template_missing', error.message);
      }
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

    if (pathName === '/api/v2/intake/documents' && method === 'GET') {
      if (!this.deps.intakeService) {
        this.sendError(res, 501, 'not_implemented', 'Intake Service not available');
        return;
      }
      try {
        const docs = await this.deps.intakeService.runIntake();
        this.sendResponse(res, {
          ok: true,
          data: { documents: docs },
          meta: { request_id: randomUUID(), timestamp: new Date().toISOString() },
        });
      } catch (err) {
        this.sendError(res, 500, 'intake_failed', (err as Error).message);
      }
      return;
    }

    if (pathName === '/api/v2/intake/taskstore' && method === 'GET') {
      const projectRoot = this.config.projectRoot ?? process.cwd();
      const tasksFile = path.join(projectRoot, '.sle', 'tasks.yaml');
      try {
        const content = await fs.readFile(tasksFile, 'utf8');
        const data = yaml.load(content) as { tasks?: any[] };
        this.sendResponse(res, {
          ok: true,
          data: { tasks: data?.tasks || [] },
          meta: { request_id: randomUUID(), timestamp: new Date().toISOString() },
        });
      } catch {
        this.sendResponse(res, {
          ok: true,
          data: { tasks: [] },
          meta: { request_id: randomUUID(), timestamp: new Date().toISOString() },
        });
      }
      return;
    }

    if (pathName === '/api/v2/chat/session/open' && method === 'POST') {
      try {
        const chatService = this.getChatService();
        const result = await chatService.openSession();

        if (!result.resumed) {
          if (this.eventBus) {
            await this.eventBus.emit('chat.session_changed', {
              session_open: true,
              session_id: result.session_id,
              timestamp: new Date().toISOString(),
            });
          }
          this.sendResponse(res, {
            ok: true,
            data: { session_open: true, session_id: result.session_id },
            meta: { request_id: randomUUID(), timestamp: new Date().toISOString() },
          });
        } else {
          res.statusCode = 204;
          res.end();
        }
      } catch (err) {
        this.sendError(res, 500, 'session_open_failed', (err as Error).message);
      }
      return;
    }

    if (pathName === '/api/v2/chat/session' && method === 'DELETE') {
      try {
        const chatService = this.getChatService();
        const map = await this.loadMap();
        const wasOpen = map.chat?.session_open === true;

        await chatService.closeSession();

        if (wasOpen) {
          if (this.eventBus) {
            await this.eventBus.emit('chat.session_changed', {
              session_open: false,
              timestamp: new Date().toISOString(),
            });
          }
          this.sendResponse(res, {
            ok: true,
            data: { session_open: false },
            meta: { request_id: randomUUID(), timestamp: new Date().toISOString() },
          });
        } else {
          res.statusCode = 204;
          res.end();
        }
      } catch (err) {
        this.sendError(res, 500, 'session_close_failed', (err as Error).message);
      }
      return;
    }

    if (pathName === '/api/v2/chat/message' && method === 'POST') {
      try {
        const body = await this.parseBody(req) as { content: string };
        const content = body.content;

        if (!content || typeof content !== 'string') {
          this.sendError(res, 422, 'validation_error', 'content is required');
          return;
        }

        const chatService = this.getChatService();

        let systemStatus = 'idle';
        let cycleFlags = {
          awaiting_scoping: false,
          awaiting_confirmation: false,
          awaiting_sharding_approval: false,
        };
        try {
          const map = await this.loadMap();
          systemStatus = map.meta?.status || 'idle';
          cycleFlags = {
            awaiting_scoping: map.cycle?.awaiting_scoping ?? false,
            awaiting_confirmation: map.cycle?.awaiting_confirmation ?? false,
            awaiting_sharding_approval: map.cycle?.awaiting_sharding_approval ?? false,
          };
        } catch {}

        const result = await chatService.handleMessage(content, systemStatus, cycleFlags);

        if (this.eventBus) {
          await this.eventBus.emit('chat.message', {
            role: result.userMessage.role,
            content: result.userMessage.content,
            timestamp: result.userMessage.ts,
          });

          await this.eventBus.emit('chat.message', {
            role: result.facilitatorMessage.role,
            content: result.facilitatorMessage.content,
            timestamp: result.facilitatorMessage.ts,
          });
        }

        this.sendResponse(res, {
          ok: true,
          data: {
            message_id: randomUUID(),
            role: result.userMessage.role,
            timestamp: result.userMessage.ts,
          },
          meta: { request_id: randomUUID(), timestamp: new Date().toISOString() },
        });
      } catch (err) {
        const errMsg = (err as Error).message;
        if (errMsg === 'chat_not_open') {
          this.sendError(res, 409, 'chat_not_open', 'Open a chat session first.');
          return;
        }
        this.sendError(res, 500, 'chat_failed', errMsg);
      }
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

    // ─── Static Asset Serving Fallback ───
    if (method === 'GET' && !pathName.startsWith('/api/')) {
      // Compiled: daemon.js lives in dist/, public/ is at dist/public/.
      // TSX dev context: daemon.ts lives in src/, no src/public/ exists;
      // fall back to cwd-relative public/ so tests can serve the source assets.
      const moduleDir = path.dirname(new URL(import.meta.url).pathname);
      const adjacent = path.join(moduleDir, 'public');
      const publicRoot = existsSync(adjacent) ? adjacent : path.join(process.cwd(), 'public');
      
      let relativePath = pathName === '/' ? 'index.html' : pathName.slice(1);
      relativePath = path.normalize(relativePath).replace(/^(\.\.(\/|\\))+/, '');
      
      const fullPath = path.join(publicRoot, relativePath);
      
      if (!fullPath.startsWith(publicRoot)) {
        this.sendError(res, 403, 'forbidden', 'Forbidden');
        return;
      }

      try {
        const content = await fs.readFile(fullPath);
        let contentType = 'text/plain';
        if (relativePath.endsWith('.html')) contentType = 'text/html';
        else if (relativePath.endsWith('.css')) contentType = 'text/css';
        else if (relativePath.endsWith('.js')) contentType = 'application/javascript';
        else if (relativePath.endsWith('.json')) contentType = 'application/json';
        else if (relativePath.endsWith('.png')) contentType = 'image/png';
        else if (relativePath.endsWith('.svg')) contentType = 'image/svg+xml';
        
        res.setHeader('Content-Type', contentType);
        res.statusCode = 200;
        res.end(content);
        return;
      } catch {
        // SPA Fallback: if route has no dot (extension), fallback to index.html
        if (!relativePath.includes('.')) {
          try {
            const indexContent = await fs.readFile(path.join(publicRoot, 'index.html'));
            res.setHeader('Content-Type', 'text/html');
            res.statusCode = 200;
            res.end(indexContent);
            return;
          } catch {}
        }
        this.sendError(res, 404, 'not_found', 'File not found');
        return;
      }
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
