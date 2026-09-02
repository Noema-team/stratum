import type { Router } from '../router.js';
import type { AttentionService } from '../attention-service.js';
import type { ProjectRepository } from '../../storage/repositories.js';
import { ok } from '../types.js';

export function makeAttentionHandlers(
  router: Router,
  attention: AttentionService,
  projects: ProjectRepository,
  workspaceId: string,
): void {
  router.add('GET', '/attention', (_req) => {
    const all = projects.listByWorkspace(workspaceId);
    return ok(attention.list(all.map(p => p.id)));
  });
}
