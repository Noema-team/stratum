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
import { WorkflowRunRepository, ArtifactRepository, DecisionRepository } from './storage/repositories.js';

import { ExecutorRegistry } from './execution/registry.js';
import { StratumAgentAdapter } from './execution/stratum-agent-adapter.js';
import { AgentStepRunner } from './execution/agent-step-runner.js';
import { createDefinitionInputValidator } from './workflow/methodology/definition-artifact.js';
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

  // D.1b — declarative-artifact provenance (see docs/developmentPlan/
  // d1a-declarative-contract-spike.md). Zero callers before D.1b.
  const artifactRepository = new ArtifactRepository(db);

  // D.3d.5 commit 2 — Decision authority lookup for the deterministic
  // Definition gate: a DECIDED fact's decisionRef must resolve to a real
  // control-plane Decision owned by the same work item. Injected as a
  // storage-free closure so the methodology-owned validator stays pure.
  const decisionRepository = new DecisionRepository(db);

  // ── LLM provider (reads settings file; falls back gracefully) ─────────────
  const { provider: llmProvider, model: resolvedModel, maxTokens: resolvedMaxTokens } = resolveLLMProvider(projectRoot);

  // ── Agent execution stack ──────────────────────────────────────────────────
  const contextManager = new ContextManager(projectRoot);
  const agentRunner = buildAgentRunner(
    contextManager, llmProvider, projectRoot, runArtifacts, resolvedModel, artifactRepository, resolvedMaxTokens,
    decisionRepository,
  );
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
  const adapter = new StratumAgentAdapter(engineDeps, engineOpts, artifactRepository);
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

export interface LLMProviderResult {
  provider: ILLMProvider;
  model: string;
  // D.3d.2 — resolved completion budget from the same `.sle/settings.json`
  // the provider/model resolve from (`"max_tokens": 16384`). Absent or
  // invalid → 4096, AgentRunner's own historical default, so existing
  // deployments behave byte-for-byte as before. This is the REAL production
  // configuration seam: reasoning-style models spend completion budget on
  // hidden reasoning tokens, so the budget must be an operator setting, not
  // a fixed assumption — and the live-eval harness resolves through this
  // exact same path so Layer B always evaluates the production budget.
  maxTokens: number;
}

// D.3d.2 — the completion-budget validation rule, matching the existing
// settings philosophy in resolveLLMProvider: strict per-field typeof checks,
// anything not a positive integer falls back to the 4096 default silently
// (same as an invalid model type falls back to the default model). Exported
// only for direct regression coverage of the validation edge cases.
export function resolveCompletionBudget(saved: unknown): number {
  const v = (saved as Record<string, unknown> | null)?.max_tokens;
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : 4096;
}

// D.3b1.2 — narrow composition-root seam. AgentRunner defaults its
// runnerConfig to { model: 'default' } when none is given, and that literal
// is truthy — so `params.model || this.defaultModel` in the provider layer
// (e.g. AnthropicSDKProvider) would send the sentinel string 'default'
// instead of falling back to the provider's own configured model. The
// composition root must always pass the resolved application model through
// explicitly. Extracted only so this specific wiring has direct regression
// coverage without exposing db/scheduler/registry or any new control-plane
// concept — createStratumApplication calls this exact function.
export function buildAgentRunner(
  contextManager: ContextManager,
  llmProvider: ILLMProvider,
  projectRoot: string,
  runArtifacts: RunArtifactManager,
  resolvedModel: string,
  artifactRepository: ArtifactRepository,
  maxTokens: number,
  decisionRepository?: DecisionRepository,
): AgentRunner {
  return new AgentRunner(
    contextManager, llmProvider, projectRoot, runArtifacts,
    {
      model: resolvedModel,
      max_tokens: maxTokens,
      // D.3d.5 commit 2 — the composition root wires the methodology-owned
      // deterministic validators into the runner's generic registry. The
      // runner itself never learns what a Definition is. When a
      // DecisionRepository is available, the validator resolves DECIDED
      // provenance against real control-plane Decisions owned by the same
      // work item — invented or borrowed authority fails deterministically.
      inputValidators: {
        definition: createDefinitionInputValidator({
          ...(decisionRepository
            ? {
                findDecision: (decisionRef: string) => {
                  const decision = decisionRepository.findById(decisionRef);
                  return decision ? { workItemId: decision.workItemId } : undefined;
                },
              }
            : {}),
        }),
      },
    }, undefined, artifactRepository,
  );
}

// D.3d — exported so the define-work live-provider evaluation harness
// (scripts/eval-define-work.ts) resolves its provider/model exactly the
// way createStratumApplication does: reading `.sle/settings.json` under
// the target project root, honoring the same env-var fallbacks, with no
// bespoke provider path or hard-coded eval-only model.
export function resolveLLMProvider(projectRoot: string): LLMProviderResult {
  const settingsPath = path.join(projectRoot, '.sle', 'settings.json');
  let config: AgentLLMConfig = {
    provider: 'openai_compatible',
    base_url: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    api_key_env: 'OPENAI_API_KEY',
  };
  let maxTokens = 4096;

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
      // D.3d.2 — optional completion budget, validated by the same strict
      // per-field philosophy as model/base_url above. Read independently of
      // the provider guard so a settings file refining only the budget still
      // applies it; absent/invalid keeps AgentRunner's 4096 default exactly.
      maxTokens = resolveCompletionBudget(saved);
    } catch {
      // malformed settings — fall back to default
    }
  }

  try {
    return { provider: new DynamicLLMProvider(createLLMProvider(config)), model: config.model, maxTokens };
  } catch {
    return {
      provider: new DynamicLLMProvider({
        complete: () => Promise.reject(new Error('LLM not configured')),
      }),
      model: config.model,
      maxTokens,
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
