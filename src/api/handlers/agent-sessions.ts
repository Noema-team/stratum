import { z } from 'zod';
import type { Router } from '../router.js';
import { err, ok } from '../types.js';
import { AgentSessionService, AgentSessionServiceError } from '../../application/agent-sessions/service.js';

const createSchema = z.object({ repositoryId: z.string().uuid() });
const promptSchema = z.object({ idempotencyKey: z.string().uuid(), text: z.string().min(1).max(10000) });
const permissionSchema = z.object({ decision: z.enum(['allow_once','reject_once']) });

function failure(error: unknown) {
  if (error instanceof AgentSessionServiceError) {
    return err(error.code === 'NOT_FOUND' ? 'not_found' : error.code === 'CONFLICT' ? 'conflict' : error.code === 'UNAVAILABLE' ? 'unavailable' : 'bad_request', error.message);
  }
  return err('internal_error', error instanceof Error ? error.message : 'AgentSession operation failed');
}

export function makeAgentSessionHandlers(router: Router, service: AgentSessionService): void {
  router.add('GET', '/processes/:id/agent-session', req => {
    try { return ok({ session: service.findForProcess(req.params.id) ?? null }); } catch (error) { return failure(error); }
  });
  router.add('POST', '/processes/:id/agent-sessions', req => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return err('bad_request', parsed.error.message);
    try { return ok(service.create(req.params.id, parsed.data.repositoryId)); } catch (error) { return failure(error); }
  });
  router.add('GET', '/agent-sessions/:id/events', req => {
    const after = Number.parseInt(req.query.after ?? '0', 10);
    const limit = Number.parseInt(req.query.limit ?? '200', 10);
    try { return ok(service.listEvents(req.params.id, Number.isFinite(after) ? after : 0, Number.isFinite(limit) ? limit : 200)); } catch (error) { return failure(error); }
  });
  router.add('GET', '/agent-sessions/:id/permissions', req => {
    try { return ok(service.listPermissions(req.params.id)); } catch (error) { return failure(error); }
  });
  router.add('GET', '/agent-sessions/:id/operations', req => {
    try { return ok(service.listOperations(req.params.id)); } catch (error) { return failure(error); }
  });
  router.add('POST', '/agent-sessions/:id/prompts', req => {
    const parsed = promptSchema.safeParse(req.body);
    if (!parsed.success) return err('bad_request', parsed.error.message);
    try { return ok(service.submitPrompt(req.params.id, parsed.data.idempotencyKey, parsed.data.text)); } catch (error) { return failure(error); }
  });
  router.add('POST', '/agent-sessions/:id/cancel', async req => {
    try { await service.cancel(req.params.id); return ok({ cancelled: true }); } catch (error) { return failure(error); }
  });
  router.add('POST', '/agent-sessions/:id/reconcile', async req => {
    try { return ok(await service.reconcile(req.params.id)); } catch (error) { return failure(error); }
  });
  router.add('POST', '/agent-sessions/:id/stop', async req => {
    try { return ok(await service.stop(req.params.id)); } catch (error) { return failure(error); }
  });
  router.add('POST', '/agent-sessions/:id/permissions/:permissionId/decision', req => {
    const parsed = permissionSchema.safeParse(req.body);
    if (!parsed.success) return err('bad_request', parsed.error.message);
    try { return ok(service.decidePermission(req.params.id, req.params.permissionId, parsed.data.decision)); } catch (error) { return failure(error); }
  });
  router.add('POST', '/agent-sessions/:id/operations/:operationId/acknowledge-unknown', req => {
    try { return ok(service.acknowledgeUnknownOperation(req.params.id, req.params.operationId)); } catch (error) { return failure(error); }
  });
}
