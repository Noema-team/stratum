import { z } from 'zod';
import type { Router } from '../router.js';
import { ok, err } from '../types.js';
import { ProcessService, ProcessServiceError } from '../../application/processes/service.js';

const createSchema = z.object({ title: z.string(), intent: z.string(), objectiveId: z.string().uuid().optional(),
  desiredOutcomes: z.array(z.string().max(1000)).max(20).optional(), constraints: z.array(z.string().max(1000)).max(20).optional(),
  repositoryIds: z.array(z.string().uuid()).max(50).optional() });
const activitySchema = z.object({ kind: z.enum(['update','proposal','review','decision']), title: z.string().max(160),
  body: z.string().max(10000), outcome: z.enum(['accepted','rejected','revise','deferred']).optional() });
const lifecycleSchema = z.object({ lifecycle: z.enum(['active','paused','completed','cancelled']), outcome: z.string().max(10000).optional() });

function failure(error: unknown) {
  if (error instanceof ProcessServiceError) return err(error.code === 'NOT_FOUND' ? 'not_found' : error.code === 'CONFLICT' ? 'conflict' : 'bad_request', error.message);
  throw error;
}

export function makeProcessHandlers(router: Router, service: ProcessService): void {
  router.add('GET', '/projects/:id/processes', req => {
    try { return ok(service.list(req.params.id)); } catch (error) { return failure(error); }
  });
  router.add('POST', '/projects/:id/processes', req => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return err('bad_request', parsed.error.message);
    try { return ok(service.create(req.params.id, parsed.data)); } catch (error) { return failure(error); }
  });
  router.add('GET', '/processes/:id', req => {
    try { return ok(service.get(req.params.id)); } catch (error) { return failure(error); }
  });
  router.add('POST', '/processes/:id/activity', req => {
    const parsed = activitySchema.safeParse(req.body);
    if (!parsed.success) return err('bad_request', parsed.error.message);
    try { return ok(service.addActivity(req.params.id, parsed.data.kind, parsed.data.title, parsed.data.body, parsed.data.outcome)); }
    catch (error) { return failure(error); }
  });
  router.add('PATCH', '/processes/:id/lifecycle', req => {
    const parsed = lifecycleSchema.safeParse(req.body);
    if (!parsed.success) return err('bad_request', parsed.error.message);
    try { return ok(service.setLifecycle(req.params.id, parsed.data.lifecycle, parsed.data.outcome)); } catch (error) { return failure(error); }
  });
}
