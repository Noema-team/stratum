import type { Router } from '../router.js';
import type { ProjectRepository } from '../../storage/repositories.js';
import { ok, err } from '../types.js';
import { randomUUID } from 'node:crypto';
import type { RepositoryRepository } from '../../storage/repositories.js';

export function makeProjectHandlers(
  router: Router,
  projects: ProjectRepository,
  workspaceId: string,
  repositories?: RepositoryRepository,
): void {
  router.add('GET', '/projects', (_req) => ok(projects.listByWorkspace(workspaceId)));

  router.add('POST', '/projects', req => {
    const body = req.body as Record<string, unknown> | null;
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    const description = typeof body?.description === 'string' ? body.description.trim() : '';
    if (!name || name.length > 120) return err('bad_request', 'name must be between 1 and 120 characters');
    if (description.length > 2000) return err('bad_request', 'description must be at most 2000 characters');
    const now = new Date().toISOString();
    const project = { id: randomUUID(), workspaceId, name, description: description || undefined,
      status: 'active' as const, priority: 0, createdAt: now, updatedAt: now };
    try { projects.save(project); return ok(project); }
    catch (error) { return err('conflict', error instanceof Error ? error.message : 'Could not create project'); }
  });

  router.add('GET', '/projects/:id', (req) => {
    const p = projects.findById(req.params.id);
    if (!p || p.workspaceId !== workspaceId)
      return err('not_found', `Project '${req.params.id}' not found`);
    return ok(p);
  });

  if (repositories) {
    router.add('GET', '/projects/:id/repositories', req => {
      const project = projects.findById(req.params.id);
      if (!project || project.workspaceId !== workspaceId) return err('not_found', `Project '${req.params.id}' not found`);
      return ok(repositories.listByProject(project.id));
    });
    router.add('POST', '/projects/:id/repositories', req => {
      const project = projects.findById(req.params.id);
      if (!project || project.workspaceId !== workspaceId) return err('not_found', `Project '${req.params.id}' not found`);
      const body = req.body as Record<string, unknown> | null;
      const remote = typeof body?.remote === 'string' ? body.remote.trim() : '';
      const defaultBranch = typeof body?.defaultBranch === 'string' ? body.defaultBranch.trim() : 'main';
      const identity = normalizeGithubRemote(remote);
      if (!identity) return err('bad_request', 'remote must be a GitHub repository URL such as https://github.com/owner/repo');
      if (!defaultBranch || defaultBranch.length > 255) return err('bad_request', 'defaultBranch is invalid');
      const existing = repositories.findByRemote('github', identity);
      if (existing && !repositories.isLinkedToWorkspace(workspaceId, existing.id)) return err('not_found', 'Repository identity is not available in this workspace');
      const repository = existing ?? { id: randomUUID(), projectId: project.id, provider: 'github' as const,
        remote: identity, defaultBranch, status: 'active' as const };
      try {
        if (!existing) repositories.save(repository);
        repositories.linkToProject(project.id, repository.id);
        return ok({ ...repository, projectId: project.id });
      } catch (error) {
        return err('conflict', error instanceof Error ? error.message : 'Could not link repository');
      }
    });
  }
}

function normalizeGithubRemote(remote: string): string | undefined {
  const cleaned = remote.replace(/\.git$/i, '').replace(/\/$/, '');
  const https = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/i.exec(cleaned);
  const ssh = /^(?:git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/i.exec(cleaned);
  const match = https ?? ssh;
  return match ? `https://github.com/${match[1]}/${match[2]}.git` : undefined;
}
