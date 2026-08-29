import type { Router } from '../router.js';
import type { WorkItemRepository } from '../../storage/repositories.js';
import type { WorkService, WorkServiceError } from '../../services/work-service.js';
import { ok, err } from '../types.js';
import type { WorkItemState } from '../../domain/index.js';

function svcErr(e: unknown) {
  if (e instanceof Error) {
    const code = ((e as WorkServiceError).code ?? 'internal_error').toLowerCase();
    return err(code, e.message);
  }
  return err('internal_error', String(e));
}

function body(req: { body: unknown }): Record<string, unknown> {
  return (req.body ?? {}) as Record<string, unknown>;
}

export function makeWorkHandlers(
  router: Router,
  workItems: WorkItemRepository,
  workService: WorkService,
): void {
  router.add('GET', '/work/:id', (req) => {
    const wi = workItems.findById(req.params.id);
    return wi ? ok(wi) : err('not_found', `WorkItem '${req.params.id}' not found`);
  });

  router.add('GET', '/projects/:id/work', (req) => {
    const { state } = req.query;
    const items = state
      ? workItems.listByState(req.params.id, state as WorkItemState)
      : workItems.listByProject(req.params.id);
    return ok(items);
  });

  router.add('POST', '/work/:id/ready', (req) => {
    try { return ok(workService.markReady({ workItemId: req.params.id })); }
    catch (e) { return svcErr(e); }
  });

  router.add('POST', '/work/:id/run', (req) => {
    try {
      const b = body(req);
      return ok(workService.startRunning({ workItemId: req.params.id, dependencyOverride: b.dependencyOverride as boolean }));
    } catch (e) { return svcErr(e); }
  });

  router.add('POST', '/work/:id/review', (req) => {
    try { return ok(workService.markInReview({ workItemId: req.params.id })); }
    catch (e) { return svcErr(e); }
  });

  router.add('POST', '/work/:id/complete', (req) => {
    try { return ok(workService.complete({ workItemId: req.params.id })); }
    catch (e) { return svcErr(e); }
  });

  router.add('POST', '/work/:id/pause', (req) => {
    try { return ok(workService.pause({ workItemId: req.params.id })); }
    catch (e) { return svcErr(e); }
  });

  router.add('POST', '/work/:id/resume', (req) => {
    try {
      const b = body(req);
      return ok(workService.resume({ workItemId: req.params.id, resumeRunning: b.resumeRunning as boolean }));
    } catch (e) { return svcErr(e); }
  });

  router.add('POST', '/work/:id/cancel', (req) => {
    try {
      const b = body(req);
      return ok(workService.cancel({ workItemId: req.params.id, reason: b.reason as string | undefined }));
    } catch (e) { return svcErr(e); }
  });

  router.add('POST', '/work/:id/fail', (req) => {
    try {
      const b = body(req);
      const reason = b.reason as string;
      if (!reason) return err('bad_request', 'reason is required');
      return ok(workService.fail({ workItemId: req.params.id, reason }));
    } catch (e) { return svcErr(e); }
  });

  router.add('POST', '/work/:id/block', (req) => {
    try {
      const b = body(req);
      const reason = b.reason as string;
      if (!reason) return err('bad_request', 'reason is required');
      return ok(workService.block({ workItemId: req.params.id, reason }));
    } catch (e) { return svcErr(e); }
  });
}
