import { z } from 'zod';
import type { Router } from '../router.js';
import { err, ok } from '../types.js';
import { AgentSessionService, AgentSessionServiceError } from '../../application/agent-sessions/service.js';

const createSchema = z.object({ repositoryId: z.string().uuid() });
const explorationCreateSchema = z.object({ repositoryId: z.string().uuid().optional() }).strict();
const promptSchema = z.object({ idempotencyKey: z.string().uuid(), text: z.string().min(1).max(10000) });
const permissionSchema = z.object({ decision: z.enum(['allow_once','reject_once']) });
const associationSchema = z.object({ processId: z.string().uuid(), associationType: z.enum(['historical','active']), idempotencyKey: z.string().uuid() }).strict();
const processPromotionSchema = z.object({ associationType: z.enum(['historical','active']), idempotencyKey: z.string().uuid(),
  definition: z.object({ title: z.string().min(1).max(160), intent: z.string().min(1).max(10000), objectiveId: z.string().uuid().optional(),
    desiredOutcomes: z.array(z.string().max(1000)).max(20).optional(), constraints: z.array(z.string().max(1000)).max(20).optional(),
    repositoryIds: z.array(z.string().uuid()).max(50).optional() }).strict() }).strict();

function failure(error: unknown) {
  if (error instanceof AgentSessionServiceError) {
    return err(error.code === 'NOT_FOUND' ? 'not_found' : error.code === 'CONFLICT' ? 'conflict' : error.code === 'UNAVAILABLE' ? 'unavailable' : 'bad_request', error.message);
  }
  return err('internal_error', error instanceof Error ? error.message : 'AgentSession operation failed');
}

export function makeAgentSessionHandlers(router: Router, service: AgentSessionService): void {
  router.add('GET', '/projects/:projectId/explorations', req => {
    try { return ok({ sessions: service.listExplorations(req.params.projectId) }); } catch (error) { return failure(error); }
  });
  router.add('POST', '/projects/:projectId/explorations', req => {
    const parsed = explorationCreateSchema.safeParse(req.body);
    if (!parsed.success) return err('bad_request', parsed.error.message);
    try { return ok({ session: service.createExploration(req.params.projectId, parsed.data.repositoryId) }); } catch (error) { return failure(error); }
  });
  router.add('POST', '/projects/:projectId/explorations/:sessionId/association', req => {
    const parsed = associationSchema.safeParse(req.body);
    if (!parsed.success) return err('bad_request', parsed.error.message);
    try {
      service.assertProjectSession(req.params.projectId, req.params.sessionId);
      return ok(service.associateExploration(req.params.projectId, req.params.sessionId, parsed.data.processId,
        parsed.data.associationType, parsed.data.idempotencyKey));
    } catch (error) { return failure(error); }
  });
  router.add('POST', '/projects/:projectId/explorations/:sessionId/process-promotion', req => {
    const parsed = processPromotionSchema.safeParse(req.body);
    if (!parsed.success) return err('bad_request', parsed.error.message);
    try {
      service.assertProjectSession(req.params.projectId, req.params.sessionId);
      return ok(service.createProcessFromExploration(req.params.projectId, req.params.sessionId,
        parsed.data.associationType, parsed.data.idempotencyKey, parsed.data.definition));
    } catch (error) { return failure(error); }
  });
  router.add('GET', '/projects/:projectId/explorations/:sessionId', req => {
    try { return ok({ session: service.assertProjectExploration(req.params.projectId, req.params.sessionId) }); } catch (error) { return failure(error); }
  });
  router.add('GET', '/projects/:projectId/explorations/:sessionId/events', req => {
    const after = Number.parseInt(req.query.after ?? '0', 10);
    const limit = Number.parseInt(req.query.limit ?? '200', 10);
    try {
      service.assertProjectExploration(req.params.projectId, req.params.sessionId);
      return ok(service.listEvents(req.params.sessionId, Number.isFinite(after) ? after : 0, Number.isFinite(limit) ? limit : 200));
    } catch (error) { return failure(error); }
  });
  router.add('GET', '/projects/:projectId/explorations/:sessionId/permissions', req => {
    try { service.assertProjectExploration(req.params.projectId, req.params.sessionId); return ok(service.listPermissions(req.params.sessionId)); } catch (error) { return failure(error); }
  });
  router.add('GET', '/projects/:projectId/explorations/:sessionId/operations', req => {
    try { service.assertProjectExploration(req.params.projectId, req.params.sessionId); return ok(service.listOperations(req.params.sessionId)); } catch (error) { return failure(error); }
  });
  router.add('POST', '/projects/:projectId/explorations/:sessionId/prompts', req => {
    const parsed = promptSchema.safeParse(req.body);
    if (!parsed.success) return err('bad_request', parsed.error.message);
    try { service.assertProjectSession(req.params.projectId, req.params.sessionId); return ok(service.submitPrompt(req.params.sessionId, parsed.data.idempotencyKey, parsed.data.text)); } catch (error) { return failure(error); }
  });
  router.add('POST', '/projects/:projectId/explorations/:sessionId/cancel', async req => {
    try { service.assertProjectExploration(req.params.projectId, req.params.sessionId); await service.cancel(req.params.sessionId); return ok({ cancelled: true }); } catch (error) { return failure(error); }
  });
  router.add('POST', '/projects/:projectId/explorations/:sessionId/reconcile', async req => {
    try { service.assertProjectExploration(req.params.projectId, req.params.sessionId); return ok(await service.reconcile(req.params.sessionId)); } catch (error) { return failure(error); }
  });
  router.add('POST', '/projects/:projectId/explorations/:sessionId/stop', async req => {
    try { service.assertProjectExploration(req.params.projectId, req.params.sessionId); return ok(await service.stop(req.params.sessionId)); } catch (error) { return failure(error); }
  });
  router.add('POST', '/projects/:projectId/explorations/:sessionId/permissions/:permissionId/decision', req => {
    const parsed = permissionSchema.safeParse(req.body);
    if (!parsed.success) return err('bad_request', parsed.error.message);
    try { service.assertProjectExploration(req.params.projectId, req.params.sessionId); return ok(service.decidePermission(req.params.sessionId, req.params.permissionId, parsed.data.decision)); } catch (error) { return failure(error); }
  });
  router.add('POST', '/projects/:projectId/explorations/:sessionId/operations/:operationId/acknowledge-unknown', req => {
    try { service.assertProjectExploration(req.params.projectId, req.params.sessionId); return ok(service.acknowledgeUnknownOperation(req.params.sessionId, req.params.operationId)); } catch (error) { return failure(error); }
  });

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
    try { service.assertProcessSession(req.params.id); return ok(service.listEvents(req.params.id, Number.isFinite(after) ? after : 0, Number.isFinite(limit) ? limit : 200)); } catch (error) { return failure(error); }
  });
  router.add('GET', '/agent-sessions/:id/permissions', req => {
    try { service.assertProcessSession(req.params.id); return ok(service.listPermissions(req.params.id)); } catch (error) { return failure(error); }
  });
  router.add('GET', '/agent-sessions/:id/operations', req => {
    try { service.assertProcessSession(req.params.id); return ok(service.listOperations(req.params.id)); } catch (error) { return failure(error); }
  });
  router.add('POST', '/agent-sessions/:id/prompts', req => {
    const parsed = promptSchema.safeParse(req.body);
    if (!parsed.success) return err('bad_request', parsed.error.message);
    try { service.assertProcessSession(req.params.id); return ok(service.submitPrompt(req.params.id, parsed.data.idempotencyKey, parsed.data.text)); } catch (error) { return failure(error); }
  });
  router.add('POST', '/agent-sessions/:id/cancel', async req => {
    try { service.assertProcessSession(req.params.id); await service.cancel(req.params.id); return ok({ cancelled: true }); } catch (error) { return failure(error); }
  });
  router.add('POST', '/agent-sessions/:id/reconcile', async req => {
    try { service.assertProcessSession(req.params.id); return ok(await service.reconcile(req.params.id)); } catch (error) { return failure(error); }
  });
  router.add('POST', '/agent-sessions/:id/stop', async req => {
    try { service.assertProcessSession(req.params.id); return ok(await service.stop(req.params.id)); } catch (error) { return failure(error); }
  });
  router.add('POST', '/agent-sessions/:id/permissions/:permissionId/decision', req => {
    const parsed = permissionSchema.safeParse(req.body);
    if (!parsed.success) return err('bad_request', parsed.error.message);
    try { service.assertProcessSession(req.params.id); return ok(service.decidePermission(req.params.id, req.params.permissionId, parsed.data.decision)); } catch (error) { return failure(error); }
  });
  router.add('POST', '/agent-sessions/:id/operations/:operationId/acknowledge-unknown', req => {
    try { service.assertProcessSession(req.params.id); return ok(service.acknowledgeUnknownOperation(req.params.id, req.params.operationId)); } catch (error) { return failure(error); }
  });
}
