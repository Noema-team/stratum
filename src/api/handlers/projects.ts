import type { Router } from '../router.js';
import type { ProjectRepository } from '../../storage/repositories.js';
import { ok, err } from '../types.js';

export function makeProjectHandlers(
  router: Router,
  projects: ProjectRepository,
  workspaceId: string,
): void {
  router.add('GET', '/projects', (_req) => ok(projects.listByWorkspace(workspaceId)));

  router.add('GET', '/projects/:id', (req) => {
    const p = projects.findById(req.params.id);
    return p ? ok(p) : err('not_found', `Project '${req.params.id}' not found`);
  });
}
