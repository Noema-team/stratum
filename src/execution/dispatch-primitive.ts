// ============================================================================
// DispatchPrimitive — shared execution mechanics for Scheduler and ResumeService.
//
// Consolidation seam: both Scheduler and ResumeService use these utilities to
// ensure identical adapter selection, repository resolution, and lease semantics.
// Neither implements its own execution runtime.
// ============================================================================

import type { ExecutorRegistry } from './registry.js';
import type { ExecutionAdapter, RepositoryContext } from './types.js';
import type { RepositoryRepository } from '../storage/repositories.js';
import { LeaseManager } from '../scheduler/lease-manager.js';
import type { SchedulerConfig } from '../scheduler/types.js';
import { DEFAULT_SCHEDULER_CONFIG } from '../scheduler/types.js';

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

// DispatchGateway — wraps the shared LeaseManager and adapter registry so both
// Scheduler and ResumeService can acquire/release leases and select adapters
// through the same code path. Each service holds one DispatchGateway instance;
// sharing the same underlying SQLite DB gives them the same lease view.
export class DispatchGateway {
  readonly leaseManager: LeaseManager;
  private readonly config: SchedulerConfig;

  constructor(
    db: import('better-sqlite3').Database,
    private readonly registry: ExecutorRegistry,
    config: Partial<SchedulerConfig> = {},
  ) {
    this.config = { ...DEFAULT_SCHEDULER_CONFIG, ...config };
    this.leaseManager = new LeaseManager(db);
  }

  selectAdapter(): ExecutionAdapter | undefined {
    return selectAdapter(this.registry);
  }

  // Acquires write leases for all repositories. Returns false if any lease
  // cannot be acquired (releases all already-acquired leases before returning).
  acquireLeases(workItemId: string, repositoryIds: string[]): boolean {
    const toLease = repositoryIds.length > 0 ? repositoryIds : [null as string | null];
    for (const repoId of toLease) {
      const lease = this.leaseManager.tryAcquireWrite(workItemId, repoId, this.config.leaseExpiryMs);
      if (!lease) {
        this.leaseManager.releaseAll(workItemId);
        return false;
      }
    }
    return true;
  }

  releaseLeases(workItemId: string): void {
    this.leaseManager.releaseAll(workItemId);
  }
}
