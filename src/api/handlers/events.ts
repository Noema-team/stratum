import type { Router } from '../router.js';
import type { EventRepository } from '../../storage/repositories.js';
import { ok } from '../types.js';

export function makeEventHandlers(
  router: Router,
  events: EventRepository,
  workspaceId: string,
): void {
  router.add('GET', '/events', (req) => {
    const { after, limit, type } = req.query;
    if (type) return ok(events.listByType(workspaceId, type));
    if (after) return ok(events.listAfter(workspaceId, after, limit ? parseInt(limit, 10) : 100));
    return ok(events.listByWorkspace(workspaceId));
  });

  router.add('GET', '/work/:id/events', (req) => ok(events.listByWorkItem(req.params.id)));
}
