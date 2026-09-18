// ============================================================================
// Shared dispatch primitives for Scheduler and ResumeService.
// ============================================================================

import type { ExecutorRegistry } from './registry.js';
import type { ExecutionAdapter, RepositoryContext } from './types.js';
import type { RepositoryRepository, ObjectiveRepository } from '../storage/repositories.js';
import type { ObjectiveContext } from '../workflow/types.js';

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

// D.3b1.1 — resolves the WorkItem's Objective (when it has one) into an
// immutable ObjectiveContext snapshot, once, at dispatch/resume time —
// the only place Objective content is read from ObjectiveRepository.
// WorkflowEngine/ContextManager/AgentRunner/AgentLoop never query it
// themselves; they only ever see the snapshot threaded through
// ExecutionRequest.objectiveContext.
//
// Fails closed, exactly like resolveRepositories: a WorkItem with an
// objectiveId that cannot be resolved to an Objective — not found, or found
// but not owned by the WorkItem's own project — is a kernel integrity
// error, not a soft "run without objective context" degradation. Returns
// undefined only when the WorkItem has no objectiveId at all.
export function resolveObjectiveContext(
  objectiveId: string | undefined,
  workItemProjectId: string,
  objectiveRepo: ObjectiveRepository,
): ObjectiveContext | undefined {
  if (!objectiveId) return undefined;
  const objective = objectiveRepo.findById(objectiveId);
  if (!objective) {
    throw new Error(`Objective '${objectiveId}' not found — dispatch denied`);
  }
  if (objective.projectId !== workItemProjectId) {
    throw new Error(
      `Objective '${objectiveId}' does not belong to project '${workItemProjectId}' — dispatch denied`
    );
  }
  return {
    id: objective.id,
    title: objective.title,
    description: objective.description,
    constraints: objective.constraints,
    successCriteria: objective.successCriteria,
  };
}


