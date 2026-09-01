import type { Router } from '../router.js';
import type { DecisionRepository, ProjectRepository } from '../../storage/repositories.js';
import type { WorkService, WorkServiceError } from '../../services/work-service.js';
import type { ResumeService } from '../../services/resume-service.js';
import { ResumeServiceError } from '../../services/resume-service.js';
import { ok, err } from '../types.js';
import { DecisionResolutionSchema } from '../../domain/decision.js';

function svcErr(e: unknown) {
  if (e instanceof ResumeServiceError) {
    return err(e.code.toLowerCase(), e.message);
  }
  if (e instanceof Error) {
    const code = ((e as WorkServiceError).code ?? 'internal_error').toLowerCase();
    return err(code, e.message);
  }
  return err('internal_error', String(e));
}

export function makeDecisionHandlers(
  router: Router,
  decisions: DecisionRepository,
  workService: WorkService,
  resumeService: ResumeService | undefined,
  projects: ProjectRepository,
  workspaceId: string,
): void {
  router.add('GET', '/projects/:id/decisions', (req) => {
    const p = projects.findById(req.params.id);
    if (!p || p.workspaceId !== workspaceId)
      return err('not_found', `Project '${req.params.id}' not found`);
    return ok(decisions.listByProject(req.params.id));
  });

  router.add('GET', '/decisions/:id', (req) => {
    const d = decisions.findById(req.params.id);
    if (!d) return err('not_found', `Decision '${req.params.id}' not found`);
    const p = projects.findById(d.projectId);
    if (!p || p.workspaceId !== workspaceId)
      return err('not_found', `Decision '${req.params.id}' not found`);
    return ok(d);
  });

  router.add('POST', '/decisions/:id/resolve', async (req) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const parsed = DecisionResolutionSchema.safeParse(b.resolution);
      if (!parsed.success) {
        const msg = parsed.error.issues.map(i => i.message).join('; ');
        return err('bad_request', `Invalid resolution: ${msg}`);
      }
      const resolution = parsed.data;

      const decision = decisions.findById(req.params.id);
      if (!decision) return err('not_found', `Decision '${req.params.id}' not found`);
      const p = projects.findById(decision.projectId);
      if (!p || p.workspaceId !== workspaceId)
        return err('not_found', `Decision '${req.params.id}' not found`);

      if (decision.type === 'checkpoint') {
        // Checkpoint Decisions MUST route through ResumeService to enforce the
        // full durable lifecycle (cursor advance + continuation execution).
        // Falling back to bare WorkService would resolve the Decision while
        // leaving the WorkflowRun halted forever — never silently tolerated.
        if (!resumeService) {
          return err(
            'service_unavailable',
            'ResumeService is required for checkpoint decisions but was not configured',
          );
        }
        await resumeService.resume(req.params.id, resolution);
        return ok({ resumed: true });
      }

      // Non-checkpoint Decisions (e.g. 'architecture', 'tradeoff') use the
      // simple resolve path — no execution continuation required.
      return ok(workService.resolveDecision(req.params.id, resolution));
    } catch (e) { return svcErr(e); }
  });
}
