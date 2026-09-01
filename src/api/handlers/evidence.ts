import type { Router } from '../router.js';
import type { EvidenceRepository, WorkItemRepository, ProjectRepository } from '../../storage/repositories.js';
import type { EvidenceService } from '../../services/evidence-service.js';
import { ok, err } from '../types.js';
import type { EvidenceStatus } from '../../domain/index.js';

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

export function makeEvidenceHandlers(
  router: Router,
  evidenceRepo: EvidenceRepository,
  evidenceService: EvidenceService,
  workItems: WorkItemRepository,
  projects: ProjectRepository,
  workspaceId: string,
): void {
  router.add('GET', '/work/:id/evidence', (req) => {
    if (!inWorkspace(workItems, projects, workspaceId, req.params.id))
      return err('not_found', `WorkItem '${req.params.id}' not found`);
    return ok(evidenceRepo.listByWorkItem(req.params.id));
  });

  router.add('POST', '/work/:id/evidence', (req) => {
    if (!inWorkspace(workItems, projects, workspaceId, req.params.id))
      return err('not_found', `WorkItem '${req.params.id}' not found`);
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (!b.type || !b.status) {
        return err('bad_request', 'type and status are required');
      }
      // Force a system-assigned source; never accept caller-supplied collectorId
      // or caller-supplied source as authoritative provenance. Manually submitted
      // evidence will not satisfy external-only requirements (no collectorId).
      const e = evidenceService.record({
        workItemId: req.params.id,
        type: b.type as string,
        source: 'api:manual',
        status: b.status as EvidenceStatus,
        payload: b.payload ?? {},
        subjectRef: b.subjectRef as string | undefined,
        stepExecutionId: b.stepExecutionId as string | undefined,
      });
      return ok(e);
    } catch (e) {
      return err('internal_error', e instanceof Error ? e.message : String(e));
    }
  });
}
