import type { Router } from '../router.js';
import type { WorkItemRepository, ProjectRepository } from '../../storage/repositories.js';
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

function inWorkspace(projects: ProjectRepository, workspaceId: string, projectId: string): boolean {
  const p = projects.findById(projectId);
  return p?.workspaceId === workspaceId;
}

// Public lifecycle surface:
//   GET  /work/:id
//   GET  /projects/:id/work
//   POST /projects/:id/work     (create)
//   POST /work/:id/ready        (operator: draft → ready)
//
// All transitions after ready (running, in_review, completed) are
// Scheduler/execution-owned. pause/cancel/fail/block are not exposed
// externally until cooperative cancellation semantics are implemented.

export function makeWorkHandlers(
  router: Router,
  workItems: WorkItemRepository,
  workService: WorkService,
  projects: ProjectRepository,
  workspaceId: string,
): void {
  router.add('GET', '/work/:id', (req) => {
    const wi = workItems.findById(req.params.id);
    if (!wi) return err('not_found', `WorkItem '${req.params.id}' not found`);
    if (!inWorkspace(projects, workspaceId, wi.projectId))
      return err('not_found', `WorkItem '${req.params.id}' not found`);
    return ok(wi);
  });

  router.add('GET', '/projects/:id/work', (req) => {
    if (!inWorkspace(projects, workspaceId, req.params.id))
      return err('not_found', `Project '${req.params.id}' not found`);
    const { state } = req.query;
    const items = state
      ? workItems.listByState(req.params.id, state as WorkItemState)
      : workItems.listByProject(req.params.id);
    return ok(items);
  });

  // ── WorkItem creation ─────────────────────────────────────────────────────
  // All optional supplied fields are validated before use — malformed values
  // return 400 rather than being silently coerced to defaults.
  router.add('POST', '/projects/:id/work', (req) => {
    if (!inWorkspace(projects, workspaceId, req.params.id))
      return err('not_found', `Project '${req.params.id}' not found`);

    const b = body(req);

    // Required fields
    const title = b.title;
    const goal = b.goal;
    const workflowId = b.workflowId;
    if (typeof title !== 'string' || !title) return err('bad_request', 'title is required');
    if (typeof goal !== 'string' || !goal) return err('bad_request', 'goal is required');
    if (typeof workflowId !== 'string' || !workflowId) return err('bad_request', 'workflowId is required');

    // Optional field type validation — reject if supplied with wrong type
    if ('repositoryIds' in b && !Array.isArray(b.repositoryIds)) {
      return err('bad_request', 'repositoryIds must be an array');
    }
    if ('priority' in b && typeof b.priority !== 'number') {
      return err('bad_request', 'priority must be a number');
    }
    if ('acceptanceCriteria' in b && !Array.isArray(b.acceptanceCriteria)) {
      return err('bad_request', 'acceptanceCriteria must be an array');
    }
    if ('constraints' in b && !Array.isArray(b.constraints)) {
      return err('bad_request', 'constraints must be an array');
    }
    if ('requiredEvidence' in b && !Array.isArray(b.requiredEvidence)) {
      return err('bad_request', 'requiredEvidence must be an array');
    }
    if (
      'workflowParameters' in b &&
      (b.workflowParameters === null ||
        typeof b.workflowParameters !== 'object' ||
        Array.isArray(b.workflowParameters))
    ) {
      return err('bad_request', 'workflowParameters must be a plain object');
    }

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
        workflowParameters: (b.workflowParameters !== undefined &&
          b.workflowParameters !== null &&
          typeof b.workflowParameters === 'object' &&
          !Array.isArray(b.workflowParameters))
          ? (b.workflowParameters as Record<string, unknown>)
          : undefined,
      });
      return ok(workItem);
    } catch (e) { return svcErr(e); }
  });

  // ── Operator lifecycle: draft → ready ─────────────────────────────────────
  // Marks a draft WorkItem as ready for Scheduler dispatch.
  // Everything after ready (running, in_review, completed) is Scheduler-owned.
  router.add('POST', '/work/:id/ready', (req) => {
    const wi = workItems.findById(req.params.id);
    if (!wi) return err('not_found', `WorkItem '${req.params.id}' not found`);
    if (!inWorkspace(projects, workspaceId, wi.projectId))
      return err('not_found', `WorkItem '${req.params.id}' not found`);
    try { return ok(workService.markReady({ workItemId: req.params.id })); }
    catch (e) { return svcErr(e); }
  });
}
