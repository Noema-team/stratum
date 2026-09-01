import type { Router } from '../router.js';
import type { EventRepository, WorkItemRepository, ProjectRepository } from '../../storage/repositories.js';
import { ok, err } from '../types.js';

export function makeEventHandlers(
  router: Router,
  events: EventRepository,
  workspaceId: string,
  workItems: WorkItemRepository,
  projects: ProjectRepository,
): void {
  router.add('GET', '/events', (req) => {
    const { after, limit, type } = req.query;
    if (type) return ok(events.listByType(workspaceId, type));
    if (after) return ok(events.listAfter(workspaceId, after, limit ? parseInt(limit, 10) : 100));
    return ok(events.listByWorkspace(workspaceId));
  });

  router.add('GET', '/work/:id/events', (req) => {
    const wi = workItems.findById(req.params.id);
    if (!wi) return err('not_found', `WorkItem '${req.params.id}' not found`);
    const p = projects.findById(wi.projectId);
    if (!p || p.workspaceId !== workspaceId)
      return err('not_found', `WorkItem '${req.params.id}' not found`);
    return ok(events.listByWorkItem(req.params.id));
  });
}
