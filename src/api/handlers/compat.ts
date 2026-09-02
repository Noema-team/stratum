// Compatibility HTTP handlers that bridge the canonical ControlPlaneServer to
// the routes the existing frontend (public/index.js) still calls.
//
// Design rules:
//   - GET routes derive state from canonical SQLite; no RuntimeMap mutation.
//   - POST routes for settings/init/intake delegate to project-local services
//     with no WorkItem/WorkflowRun lifecycle side-effects.
//   - Cycle/discovery/halt routes are NOT migrated (no live_client consumer).
//   - This file must not import CycleService, StateMachine, or RuntimeMapManager
//     as competing execution authorities.

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { load as yamlLoad } from 'js-yaml';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import type { Router } from '../router.js';
import type { InitService } from '../../init-service.js';
import type { IntakeService } from '../../intake-service.js';
import type { ChatService } from '../../chat-service.js';
import type { DynamicLLMProvider } from '../../llm-provider.js';
import { ok, err } from '../types.js';
import { getCompatSystemState } from '../compat-state.js';
import type { WsEvent } from '../events-ws.js';

const SettingsPayloadSchema = z.object({
  provider: z.enum(['openai_compatible', 'anthropic', 'glm', 'openrouter']),
  base_url: z.string().optional().nullable(),
  model: z.string().min(1, 'model is required'),
  api_key: z.string().optional().nullable(),
});

export interface CompatHandlerOptions {
  db: Database.Database;
  workspaceId: string;
  projectRoot: string;
  port: number;
  startedAt: Date;
  llmProvider?: DynamicLLMProvider;
  initService?: InitService;
  intakeService?: IntakeService;
  chatService?: ChatService;
  // Called after chat message handling to deliver the facilitator response
  // to connected WS clients.
  broadcast?: (event: WsEvent) => void;
}

export function makeCompatHandlers(router: Router, opts: CompatHandlerOptions): void {
  const { db, workspaceId, projectRoot, port, startedAt } = opts;

  // ── GET /api/v2/info ───────────────────────────────────────────────────────
  router.add('GET', '/api/v2/info', (_req) => ok({
    version: '0.0.0',
    pid: process.pid,
    port,
    started_at: startedAt.toISOString(),
    uptime_ms: Date.now() - startedAt.getTime(),
    project_root: projectRoot,
    sle_version: '0.0.0',
  }));

  // ── GET /api/v2/system/state ───────────────────────────────────────────────
  // Derives canonical system state from workspace-scoped WorkItem counts.
  // Pending checkpoint Decisions project awaiting_confirmation/sharding_approval flags.
  router.add('GET', '/api/v2/system/state', (_req) => {
    const { state, awaitingConfirmation, awaitingShardingApproval } =
      getCompatSystemState(db, workspaceId);
    return ok({
      state,
      active_session_id: null,
      active_cycle_id: null,
      discovery_status: 'not_started',
      iteration: 0,
      revision: 0,
      awaiting_scoping: false,
      awaiting_confirmation: awaitingConfirmation,
      awaiting_sharding_approval: awaitingShardingApproval,
      chat: { session_open: false },
    });
  });

  // ── GET /api/v2/settings ───────────────────────────────────────────────────
  router.add('GET', '/api/v2/settings', async (_req) => {
    const settingsPath = path.join(projectRoot, '.sle', 'settings.json');
    let data = {
      provider: 'openai_compatible',
      base_url: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      api_key: '',
    };
    try {
      const content = await fs.readFile(settingsPath, 'utf8');
      const saved = JSON.parse(content);
      const hasKey = !!(saved.api_key);
      data = {
        provider: saved.provider || 'openai_compatible',
        base_url: saved.base_url || '',
        model: saved.model || '',
        api_key: hasKey ? '••••••••' : '',
      };
    } catch {
      const hasKey = !!(
        process.env.OPENAI_API_KEY || process.env.SLE_LLM_API_KEY ||
        process.env.ANTHROPIC_API_KEY || process.env.GLM_API_KEY ||
        process.env.OPENROUTER_API_KEY
      );
      data.api_key = hasKey ? '••••••••' : '';
    }
    return ok(data);
  });

  // ── POST /api/v2/settings ──────────────────────────────────────────────────
  router.add('POST', '/api/v2/settings', async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const parsed = SettingsPayloadSchema.safeParse(b);
    if (!parsed.success) {
      return err('bad_request', parsed.error.issues.map(i => i.message).join('; '));
    }

    const settingsPath = path.join(projectRoot, '.sle', 'settings.json');
    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    } catch {}

    const { provider, base_url, model, api_key } = parsed.data;
    const finalKey = api_key === '••••••••'
      ? ((existing.api_key as string) || process.env.SLE_LLM_API_KEY || '')
      : (api_key || '');

    const updated = { provider, base_url: base_url || '', model, api_key: finalKey };
    try {
      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      await fs.writeFile(settingsPath, JSON.stringify(updated, null, 2), 'utf8');
    } catch (e) {
      return err('internal_error', `Failed to save settings: ${(e as Error).message}`);
    }

    if (finalKey) {
      process.env.SLE_LLM_API_KEY = finalKey;
      const envVar = provider === 'anthropic' ? 'ANTHROPIC_API_KEY'
        : provider === 'glm' ? 'GLM_API_KEY'
        : provider === 'openrouter' ? 'OPENROUTER_API_KEY'
        : 'OPENAI_API_KEY';
      process.env[envVar] = finalKey;
    }

    if (opts.llmProvider?.setProvider) {
      try {
        const { createLLMProvider } = await import('../../llm-provider.js');
        const api_key_env = provider === 'anthropic' ? 'ANTHROPIC_API_KEY'
          : provider === 'glm' ? 'GLM_API_KEY'
          : provider === 'openrouter' ? 'OPENROUTER_API_KEY'
          : 'OPENAI_API_KEY';
        opts.llmProvider.setProvider(createLLMProvider({ provider, base_url: base_url || undefined, model, api_key_env }));
      } catch {}
    }

    return ok({ provider, base_url, model, api_key: finalKey ? '••••••••' : '' });
  });

  // ── POST /api/v2/init ──────────────────────────────────────────────────────
  router.add('POST', '/api/v2/init', async (req) => {
    if (!opts.initService) return err('service_unavailable', 'InitService not configured');
    const b = (req.body ?? {}) as Record<string, unknown>;
    const result = await opts.initService.init(b as Parameters<InitService['init']>[0]);
    if (!result.ok) {
      const code = result.error.code === 'already_initialised' ? 'conflict' : 'internal_error';
      return err(code, result.error.message);
    }
    return ok(result.data);
  });

  // ── GET /api/v2/init/state ─────────────────────────────────────────────────
  router.add('GET', '/api/v2/init/state', async (_req) => {
    if (!opts.initService) return err('service_unavailable', 'InitService not configured');
    const result = await opts.initService.getStatus();
    return ok(result.data);
  });

  // ── GET /api/v2/intake/documents ───────────────────────────────────────────
  router.add('GET', '/api/v2/intake/documents', async (_req) => {
    if (!opts.intakeService) return err('service_unavailable', 'IntakeService not configured');
    try {
      const docs = await opts.intakeService.runIntake();
      return ok({ documents: docs });
    } catch (e) {
      return err('internal_error', (e as Error).message);
    }
  });

  // ── GET /api/v2/intake/taskstore ───────────────────────────────────────────
  router.add('GET', '/api/v2/intake/taskstore', async (_req) => {
    const tasksFile = path.join(projectRoot, '.sle', 'tasks.yaml');
    try {
      const content = await fs.readFile(tasksFile, 'utf8');
      const data = yamlLoad(content) as { tasks?: unknown[] } | null;
      return ok({ tasks: data?.tasks ?? [] });
    } catch {
      return ok({ tasks: [] });
    }
  });

  // ── POST /api/v2/chat/session/open ─────────────────────────────────────────
  router.add('POST', '/api/v2/chat/session/open', async (_req) => {
    if (!opts.chatService) return err('service_unavailable', 'ChatService not configured');
    try {
      const result = await opts.chatService.openSession();
      return ok({ session_open: true, session_id: result.session_id });
    } catch (e) {
      return err('internal_error', (e as Error).message);
    }
  });

  // ── POST /api/v2/chat/message ──────────────────────────────────────────────
  router.add('POST', '/api/v2/chat/message', async (req) => {
    if (!opts.chatService) return err('service_unavailable', 'ChatService not configured');
    const b = (req.body ?? {}) as Record<string, unknown>;
    const content = b.content;
    if (!content || typeof content !== 'string')
      return err('bad_request', 'content is required');
    try {
      const { state, awaitingConfirmation, awaitingShardingApproval } =
        getCompatSystemState(db, workspaceId);
      const result = await opts.chatService.handleMessage(content, state, {
        awaiting_scoping: false,
        awaiting_confirmation: awaitingConfirmation,
        awaiting_sharding_approval: awaitingShardingApproval,
      });
      if (opts.broadcast) {
        opts.broadcast({
          type: 'chat.message',
          payload: {
            role: result.facilitatorMessage.role,
            content: result.facilitatorMessage.content,
          },
        });
      }
      return ok({ role: result.userMessage.role, timestamp: result.userMessage.ts });
    } catch (e) {
      const msg = (e as Error).message;
      if (msg === 'chat_not_open') return err('conflict', 'Open a chat session first.');
      return err('internal_error', msg);
    }
  });
}
