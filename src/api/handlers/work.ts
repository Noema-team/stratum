import type { Router } from '../router.js';
import type { WorkItemRepository } from '../../storage/repositories.js';
import type { WorkService, WorkServiceError } from '../../services/work-service.js';
import { ok, err } from '../types.js';
import type { WorkItem, WorkItemState } from '../../domain/index.js';

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

  // ── WorkItem creation ─────────────────────────────────────────────────────
  // Calls WorkService.createWorkItem() — validates project, workflow, and
  // repository ownership before writing. Creates the WorkItem in 'draft' state.
  router.add('POST', '/projects/:id/work', (req) => {
    const b = body(req);
    const title = b.title as string | undefined;
    const goal = b.goal as string | undefined;
    const workflowId = b.workflowId as string | undefined;
    if (!title) return err('bad_request', 'title is required');
    if (!goal) return err('bad_request', 'goal is required');
    if (!workflowId) return err('bad_request', 'workflowId is required');
    try {
      const workItem = workService.createWorkItem({
        projectId: req.params.id,
        title,
        goal,
        workflowId,
        repositoryIds: Array.isArray(b.repositoryIds) ? (b.repositoryIds as string[]) : undefined,
        priority: typeof b.priority === 'number' ? (b.priority as number) : undefined,
        acceptanceCriteria: Array.isArray(b.acceptanceCriteria)
          ? (b.acceptanceCriteria as WorkItem['acceptanceCriteria'])
          : undefined,
        constraints: Array.isArray(b.constraints)
          ? (b.constraints as WorkItem['constraints'])
          : undefined,
        requiredEvidence: Array.isArray(b.requiredEvidence)
          ? (b.requiredEvidence as WorkItem['requiredEvidence'])
          : undefined,
        workflowParameters:
          b.workflowParameters !== undefined &&
          typeof b.workflowParameters === 'object' &&
          b.workflowParameters !== null &&
          !Array.isArray(b.workflowParameters)
            ? (b.workflowParameters as Record<string, unknown>)
            : undefined,
        objectiveId: b.objectiveId as string | undefined,
        parentId: b.parentId as string | undefined,
      });
      return ok(workItem);
    } catch (e) { return svcErr(e); }
  });

  // ── Operator lifecycle commands ───────────────────────────────────────────
  // draft → ready: explicit operator command to make a WorkItem available for
  // Scheduler dispatch. Everything after ready is Scheduler-owned.
  router.add('POST', '/work/:id/ready', (req) => {
    try { return ok(workService.markReady({ workItemId: req.params.id })); }
    catch (e) { return svcErr(e); }
  });

  // Operator/admin override commands. running, in_review, and completed are
  // owned by Scheduler/execution — they are not exposed as HTTP endpoints.
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
