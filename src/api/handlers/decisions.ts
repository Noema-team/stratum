import type { Router } from '../router.js';
import type { DecisionRepository } from '../../storage/repositories.js';
import type { WorkService, WorkServiceError } from '../../services/work-service.js';
import type { ResumeService } from '../../services/resume-service.js';
import { ResumeServiceError } from '../../services/resume-service.js';
import { ok, err } from '../types.js';
import type { Decision } from '../../domain/index.js';

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
  resumeService?: ResumeService,
): void {
  router.add('GET', '/projects/:id/decisions', (req) => ok(decisions.listByProject(req.params.id)));

  router.add('GET', '/decisions/:id', (req) => {
    const d = decisions.findById(req.params.id);
    return d ? ok(d) : err('not_found', `Decision '${req.params.id}' not found`);
  });

  router.add('POST', '/decisions/:id/resolve', async (req) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const resolution = b.resolution as Decision['resolution'];
      if (!resolution) return err('bad_request', 'resolution is required');

      // Checkpoint Decisions route through ResumeService when available — this
      // enforces the full durable checkpoint/resume lifecycle (cursor advance,
      // StepExecution creation, adapter invocation) in a single atomic path.
      const decision = decisions.findById(req.params.id);
      if (!decision) return err('not_found', `Decision '${req.params.id}' not found`);

      if (decision.type === 'checkpoint' && resumeService) {
        await resumeService.resume(req.params.id, resolution);
        return ok({ resumed: true });
      }

      // Non-checkpoint Decisions (e.g. 'architecture', 'tradeoff') use the
      // simple resolve path — no execution continuation required.
      return ok(workService.resolveDecision(req.params.id, resolution));
    } catch (e) { return svcErr(e); }
  });
}
