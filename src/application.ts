// createStratumApplication — single composition root for the new control-plane stack.
//
// Owns: SQLite, WorkService, EvidenceService, ResumeService, Scheduler,
//       SchedulerLoop, StratumAgentAdapter, WorkflowEngine deps, all project
//       services needed by FullBuildStepRunner, and ControlPlaneServer.
//
// Does NOT start DaemonServer. cli.ts is not switched to this module yet.
// That happens after the cutover E2E test passes (Commit C).

import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

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

// ── SchedulerLoop ─────────────────────────────────────────────────────────────

export interface SchedulerLoopOptions {
  intervalMs?: number;
}

export class SchedulerLoop {
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private ticking = false;

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

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  // Drive a single tick immediately, regardless of the interval timer.
  // Overlapping ticks are still blocked — returns without doing work when one
  // is already in flight. Useful for tests and for wake-on-ready semantics.
  async tickNow(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.scheduler.tick();
    } catch (err) {
      // Surface errors but keep the loop alive.
      console.error('[SchedulerLoop] tick() threw:', err);
    } finally {
      this.ticking = false;
    }
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

  // ── SQLite ─────────────────────────────────────────────────────────────────
  const db = openDatabase(dbPath);

  // ── Core domain services ───────────────────────────────────────────────────
  // All three share the same db + workspaceId so they see the same data.
  // HTTP server and Scheduler receive the same WorkService instance — no
  // weaker copy is ever created for the external API.
  const workService = new WorkService(db, workspaceId);
  const evidenceService = new EvidenceService(db);

  // ExecutorRegistry is populated below; ResumeService needs it.
  const registry = new ExecutorRegistry();

  const resumeService = new ResumeService(db, workspaceId, registry);

  // ── Project-local file services ────────────────────────────────────────────
  const mapPath = path.join(projectRoot, '.sle', 'map.yaml');
  const mapManager = new RuntimeMapManagerImpl({ mapPath });

  const runArtifacts = new RunArtifactManager({ projectRoot });

  // ── LLM provider (reads settings file; falls back gracefully) ─────────────
  const llmProvider = resolveLLMProvider(projectRoot);

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
  const criticAgent = new CriticAgent(llmProvider, 'default');

  // Checkpoint callbacks: delegate to ResumeService/WorkService so the HTTP
  // decision path and the inline callback path share the same authority.
  // The inline callbacks are used when the step runner is driving execution
  // synchronously without an external HTTP approval in the loop.
  const fullBuildCallbacks: FullBuildCallbacks = {
    onCheckpoint: async (_workflowRunId, _stepId, _iteration) => 'halt',
    onConfirmGate: async (_workflowRunId, _iteration) => 'halt',
    onShardingGate: async (_workflowRunId, _iteration) => 'reject',
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
      shardingService: undefined,
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
  const scheduler = new Scheduler(db, workspaceId, registry);
  const schedulerLoop = new SchedulerLoop(scheduler, { intervalMs: schedulerIntervalMs });

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
      schedulerLoop.stop();
      await controlPlaneServer.close();
      db.close();
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveLLMProvider(projectRoot: string): ILLMProvider {
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
    return new DynamicLLMProvider(createLLMProvider(config));
  } catch {
    return new DynamicLLMProvider({
      complete: () => Promise.reject(new Error('LLM not configured')),
    });
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
