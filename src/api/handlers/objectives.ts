import type { Router } from '../router.js';
import type { WorkItemRepository, ProjectRepository } from '../../storage/repositories.js';
import type { ObjectiveService, ObjectiveServiceError } from '../../services/objective-service.js';
import { ok, err } from '../types.js';
import type { Objective } from '../../domain/index.js';

function inWorkspace(projects: ProjectRepository, workspaceId: string, projectId: string): boolean {
  const p = projects.findById(projectId);
  return p?.workspaceId === workspaceId;
}

function svcErr(e: unknown) {
  if (e instanceof Error) {
    const code = ((e as ObjectiveServiceError).code ?? 'internal_error').toLowerCase();
    return err(code, e.message);
  }
  return err('internal_error', String(e));
}

// D.2 — read-model addition (§4): "trivial from existing repositories" —
// one COUNT query per Objective. Not exposed as its own field on the domain
// type; attached only in API responses.
function withWorkItemCount(objective: Objective, workItems: WorkItemRepository): Objective & { linkedWorkItemCount: number } {
  return { ...objective, linkedWorkItemCount: workItems.countByObjective(objective.id) };
}

// Objective is the durable human-intent container above WorkItems:
//   Project -> Objective -> WorkItems
// This is intentionally the entire D.2 API surface — no activate/complete/
// cancel routes yet (ObjectiveService exposes them as guarded methods for
// later use), no Objective dependency graph, no strategy dashboard.
export function makeObjectiveHandlers(
  router: Router,
  objectiveService: ObjectiveService,
  workItems: WorkItemRepository,
  projects: ProjectRepository,
  workspaceId: string,
): void {
  router.add('GET', '/projects/:id/objectives', (req) => {
    if (!inWorkspace(projects, workspaceId, req.params.id))
      return err('not_found', `Project '${req.params.id}' not found`);
    const objectives = objectiveService.listByProject(req.params.id);
    return ok(objectives.map((o) => withWorkItemCount(o, workItems)));
  });

  router.add('POST', '/projects/:id/objectives', (req) => {
    if (!inWorkspace(projects, workspaceId, req.params.id))
      return err('not_found', `Project '${req.params.id}' not found`);

    const b = (req.body ?? {}) as Record<string, unknown>;
    const title = b.title;
    const description = b.description;
    if (typeof title !== 'string' || !title) return err('bad_request', 'title is required');
    if (typeof description !== 'string' || !description) return err('bad_request', 'description is required');
    if ('priority' in b && typeof b.priority !== 'number') return err('bad_request', 'priority must be a number');
    if ('constraints' in b && !Array.isArray(b.constraints)) return err('bad_request', 'constraints must be an array');
    if ('successCriteria' in b && !Array.isArray(b.successCriteria)) return err('bad_request', 'successCriteria must be an array');

    try {
      const objective = objectiveService.create({
        projectId: req.params.id,
        title,
        description,
        priority: typeof b.priority === 'number' ? (b.priority as number) : undefined,
        constraints: Array.isArray(b.constraints) ? (b.constraints as Objective['constraints']) : undefined,
        successCriteria: Array.isArray(b.successCriteria) ? (b.successCriteria as Objective['successCriteria']) : undefined,
      });
      return ok(withWorkItemCount(objective, workItems));
    } catch (e) {
      return svcErr(e);
    }
  });

  router.add('GET', '/objectives/:id', (req) => {
    const objective = objectiveService.findById(req.params.id);
    if (!objective) return err('not_found', `Objective '${req.params.id}' not found`);
    return ok(withWorkItemCount(objective, workItems));
  });
}
