import type { Router } from '../router.js';
import type { ArtifactRepository, WorkItemRepository, ProjectRepository } from '../../storage/repositories.js';
import { ok, err } from '../types.js';

function inWorkspace(
  workItems: WorkItemRepository,
  projects: ProjectRepository,
  workspaceId: string,
  workItemId: string,
): boolean {
  const wi = workItems.findById(workItemId);
  if (!wi) return false;
  const p = projects.findById(wi.projectId);
  return p?.workspaceId === workspaceId;
}

// GET /work/:id/artifacts — D.1c (docs/developmentPlan/d1a-declarative-contract-spike.md §4).
//
// Returns the current (latest-per-ref) declaratively-recorded Artifact
// provenance for a WorkItem: metadata only (id/type/ref/path/hash/
// timestamps/linkage) — never file contents. A step may record several
// versions of the same ref over its lifetime (D.1c refinement); this route
// exposes one row per logical ref (ArtifactRepository.listLatestByWorkItem),
// matching what StratumAgentAdapter projects into ExecutionResult.artifacts.
// The full version history remains queryable directly against
// ArtifactRepository for callers that need it — no route exposes it yet,
// since nothing consumes it outside tests.
export function makeArtifactHandlers(
  router: Router,
  artifacts: ArtifactRepository,
  workItems: WorkItemRepository,
  projects: ProjectRepository,
  workspaceId: string,
): void {
  router.add('GET', '/work/:id/artifacts', (req) => {
    if (!inWorkspace(workItems, projects, workspaceId, req.params.id))
      return err('not_found', `WorkItem '${req.params.id}' not found`);
    return ok(artifacts.listLatestByWorkItem(req.params.id));
  });
}
