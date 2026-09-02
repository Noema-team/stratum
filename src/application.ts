// createStratumApplication — single composition root for the new control-plane stack.
//
// Owns: SQLite, WorkService, EvidenceService, ResumeService, Scheduler,
//       SchedulerLoop, StratumAgentAdapter, WorkflowEngine deps, all project
//       services needed by FullBuildStepRunner, and ControlPlaneServer.
//
// Does NOT start a legacy daemon. cli.ts is not switched to this module yet.
// That happens after the cutover E2E test passes (Commit C).

import path from 'node:path';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';

import { openDatabase } from './storage/database.js';
import { WorkService } from './services/work-service.js';
import { EvidenceService } from './services/evidence-service.js';
import { ResumeService } from './services/resume-service.js';
import { WorkflowRunRepository } from './storage/repositories.js';

import { ExecutorRegistry } from './execution/registry.js';
import { StratumAgentAdapter } from './execution/stratum-agent-adapter.js';
import { AgentStepRunner } from './execution/agent-step-runner.js';
import { FullBuildStepRunner } from './execution/full-build-step-runner.js';
import type { FullBuildCallbacks } from './execution/full-build-step-runner.js';

import { Scheduler } from './scheduler/scheduler.js';

import { ControlPlaneServer } from './api/control-plane-server.js';

import { AgentRunner } from './agent-runner.js';
import { ContextManager } from './context-manager.js';
import { createLLMProvider, DynamicLLMProvider } from './llm-provider.js';
import type { ILLMProvider } from './llm-provider.js';
import type { AgentLLMConfig, LLMProvider } from './types.js';
import { CriticAgent } from './critic-agent.js';
import { ConfirmService } from './confirm-service.js';
import { ExecService, ValidationGateService } from './exec-gate.js';
import { SnapshotService } from './snapshot-service.js';
import { SummariseService } from './summarise-service.js';
import { ScopingService } from './scoping-service.js';
import { TagService } from './tag-service.js';
import { RunArtifactManager } from './run-artifacts.js';
import { RuntimeMapManagerImpl } from './runtime-map.js';
import { ShardingService } from './sharding-service.js';
import { LinkIndexManager } from './link-index.js';

// ── SchedulerLoop ─────────────────────────────────────────────────────────────

export interface SchedulerLoopOptions {
  intervalMs?: number;
}

export class SchedulerLoop {
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private currentTick: Promise<void> | null = null;

  constructor(
    private readonly scheduler: Scheduler,
    opts: SchedulerLoopOptions = {},
  ) {
    this.intervalMs = opts.intervalMs ?? 5_000;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Await any in-flight tick so callers can safely close DB/HTTP after stop().
    if (this.currentTick) {
      await this.currentTick;
    }
  }

  // Drive a single tick immediately, regardless of the interval timer.
  // Overlapping ticks are blocked — returns without doing work when one
  // is already in flight. Useful for tests and for wake-on-ready semantics.
  async tickNow(): Promise<void> {
    if (this.currentTick) return;
    this.currentTick = this.scheduler.tick().then(
      () => { this.currentTick = null; },
      (err) => {
        this.currentTick = null;
        console.error('[SchedulerLoop] tick() threw:', err);
      },
    );
    await this.currentTick;
  }

  private scheduleNext(): void {
    if (!this.running) return;
    this.timer = setTimeout(async () => {
      await this.tickNow();
      this.scheduleNext();
    }, this.intervalMs);
  }
}

// ── Application ───────────────────────────────────────────────────────────────

export interface StratumApplicationOptions {
  projectRoot: string;
  workspaceId: string;
  dbPath?: string;
  port?: number;
  schedulerIntervalMs?: number;
  requireAuth?: boolean;
}

export interface StratumApplication {
  readonly controlPlaneServer: ControlPlaneServer;
  readonly schedulerLoop: SchedulerLoop;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createStratumApplication(opts: StratumApplicationOptions): StratumApplication {
  const {
    projectRoot,
    workspaceId,
    dbPath = path.join(projectRoot, '.sle', 'stratum.db'),
    port,
    schedulerIntervalMs,
    requireAuth,
  } = opts;

  // ── Ensure runtime directory exists ───────────────────────────────────────
  mkdirSync(path.join(projectRoot, '.sle'), { recursive: true });

  // ── SQLite ─────────────────────────────────────────────────────────────────
  const db = openDatabase(dbPath);

  // ── Core domain services ───────────────────────────────────────────────────
  // Single canonical WorkService with the evidence guard wired in.
  // All consumers (HTTP server, Scheduler, ResumeService) share the same instance
  // so the evidence policy is applied exactly once and consistently.
  const evidenceService = new EvidenceService(db);
  const workService = new WorkService(db, workspaceId, {
    evidenceGuard: evidenceService.asGuard(),
  });

  // ExecutorRegistry is populated below; ResumeService needs it.
  const registry = new ExecutorRegistry();

  // ── Project-local file services ────────────────────────────────────────────
  const mapPath = path.join(projectRoot, '.sle', 'map.yaml');
  const mapManager = new RuntimeMapManagerImpl({ mapPath });

  const runArtifacts = new RunArtifactManager({ projectRoot });

  // ── LLM provider (reads settings file; falls back gracefully) ─────────────
  const { provider: llmProvider, model: resolvedModel } = resolveLLMProvider(projectRoot);

  // ── Agent execution stack ──────────────────────────────────────────────────
  const contextManager = new ContextManager(projectRoot);
  const agentRunner = new AgentRunner(contextManager, llmProvider, projectRoot, runArtifacts);
  const agentStepRunner = new AgentStepRunner(agentRunner);

  const tagService = new TagService(mapManager);
  const scopingService = new ScopingService(agentRunner, mapManager, projectRoot, undefined, tagService);
  const confirmService = new ConfirmService(mapManager, runArtifacts);
  const execService = new ExecService(mapManager, runArtifacts);
  const validationGateService = new ValidationGateService(mapManager, runArtifacts);
  const snapshotService = new SnapshotService(mapManager, runArtifacts, projectRoot);
  const summariseService = new SummariseService(mapManager, runArtifacts, projectRoot);
  const criticAgent = new CriticAgent(llmProvider, resolvedModel);

  const linkIndexManager = new LinkIndexManager(projectRoot, mapManager);
  const shardingService = new ShardingService(projectRoot, linkIndexManager);

  // Checkpoint callbacks: delegate to ResumeService/WorkService so the HTTP
  // decision path and the inline callback path share the same authority.
  // Inline callbacks always halt — all real resolutions come via HTTP + resolver.
  const fullBuildCallbacks: FullBuildCallbacks = {
    onCheckpoint: async (_workflowRunId, _stepId, _iteration) => 'halt',
    onConfirmGate: async (_workflowRunId, _iteration) => 'halt',
    onShardingGate: async (_workflowRunId, _iteration) => 'halt',
  };

  const fullBuildStepRunner = new FullBuildStepRunner(
    {
      agentStepRunner,
      mapManager,
      runArtifacts,
      projectRoot,
      criticAgent,
      confirmService,
      execService,
      validationGateService,
      snapshotService,
      summariseService,
      shardingService,
      scopingService,
    },
    fullBuildCallbacks,
  );

  // ── WorkflowEngine deps ────────────────────────────────────────────────────
  const workflowRunRepository = new WorkflowRunRepository(db);

  const engineDeps = {
    stepRunner: fullBuildStepRunner,
    mapManager,
    runArtifacts,
    projectRoot,
    workflowRunRepository,
  };

  const engineOpts = {
    onCheckpoint: async (_workflowRunId: string, _stepId: string, _iteration: number) =>
      'halt' as const,
  };

  // ── Adapter + registry ─────────────────────────────────────────────────────
  const adapter = new StratumAgentAdapter(engineDeps, engineOpts);
  registry.register(adapter);

  // ── Scheduler + loop ───────────────────────────────────────────────────────
  // Scheduler and ResumeService both receive the canonical workService instance.
  const scheduler = new Scheduler(db, workspaceId, registry, {}, workService);
  const schedulerLoop = new SchedulerLoop(scheduler, { intervalMs: schedulerIntervalMs });

  // ResumeService receives the canonical workService + the checkpoint resolver
  // so HTTP-driven checkpoint approvals execute the same side-effect logic as
  // the inline FullBuildStepRunner callbacks.
  const resumeService = new ResumeService(db, workspaceId, registry, {}, workService, fullBuildStepRunner);

  // ── ControlPlaneServer ─────────────────────────────────────────────────────
  const controlPlaneServer = new ControlPlaneServer({
    db,
    workspaceId,
    workService,
    evidenceService,
    resumeService,
    port,
    requireAuth,
  });

  // ── Application shell ──────────────────────────────────────────────────────
  return {
    controlPlaneServer,
    schedulerLoop,

    async start(): Promise<void> {
      await controlPlaneServer.listen();
      schedulerLoop.start();
    },

    async stop(): Promise<void> {
      // Initiate HTTP close and scheduler drain together so neither blocks the
      // other — a long in-flight tick must not delay HTTP teardown and vice versa.
      // SQLite closes last, after both are fully drained.
      await Promise.all([
        controlPlaneServer.close(),
        schedulerLoop.stop(),
      ]);
      db.close();
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

interface LLMProviderResult {
  provider: ILLMProvider;
  model: string;
}

function resolveLLMProvider(projectRoot: string): LLMProviderResult {
  const settingsPath = path.join(projectRoot, '.sle', 'settings.json');
  let config: AgentLLMConfig = {
    provider: 'openai_compatible',
    base_url: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    api_key_env: 'OPENAI_API_KEY',
  };

  if (existsSync(settingsPath)) {
    try {
      const saved = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
      if (saved.provider) {
        config = {
          provider: saved.provider as LLMProvider,
          base_url: typeof saved.base_url === 'string' ? saved.base_url : undefined,
          model: typeof saved.model === 'string' ? saved.model : 'gpt-4o',
          api_key_env: typeof saved.api_key_env === 'string'
            ? saved.api_key_env
            : deriveApiKeyEnv(String(saved.provider)),
        };
        if (saved.api_key) process.env.SLE_LLM_API_KEY = String(saved.api_key);
      }
    } catch {
      // malformed settings — fall back to default
    }
  }

  try {
    return { provider: new DynamicLLMProvider(createLLMProvider(config)), model: config.model };
  } catch {
    return {
      provider: new DynamicLLMProvider({
        complete: () => Promise.reject(new Error('LLM not configured')),
      }),
      model: config.model,
    };
  }
}

function deriveApiKeyEnv(provider: string): string {
  switch (provider) {
    case 'anthropic': return 'ANTHROPIC_API_KEY';
    case 'glm': return 'GLM_API_KEY';
    case 'openrouter': return 'OPENROUTER_API_KEY';
    default: return 'OPENAI_API_KEY';
  }
}
