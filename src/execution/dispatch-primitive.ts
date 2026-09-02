// ============================================================================
// Shared dispatch primitives for Scheduler and ResumeService.
// ============================================================================

import type { ExecutorRegistry } from './registry.js';
import type { ExecutionAdapter, RepositoryContext } from './types.js';
import type { RepositoryRepository } from '../storage/repositories.js';

// Resolves repository contexts from the DB. Throws if any ID is not registered —
// a WorkItem referencing an unknown repository is a kernel integrity error.
export function resolveRepositories(
  ids: string[],
  repoRepo: RepositoryRepository,
): RepositoryContext[] {
  return ids.map(id => {
    const stored = repoRepo.findById(id);
    if (!stored) {
      throw new Error(`Repository '${id}' not found — dispatch denied`);
    }
    return { id, remote: stored.remote, branch: stored.defaultBranch };
  });
}

// Selects the execution adapter for any workflow. Same logic as Scheduler.tryDispatch.
export function selectAdapter(registry: ExecutorRegistry): ExecutionAdapter | undefined {
  return registry.findById('stratum-agent')
    ?? registry.findByCapabilities(new Set(['repo.read']));
}


