import type { Router } from '../router.js';
import type { DecisionRepository } from '../../storage/repositories.js';
import type { WorkService, WorkServiceError } from '../../services/work-service.js';
import { ok, err } from '../types.js';
import type { Decision } from '../../domain/index.js';

function svcErr(e: unknown) {
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
): void {
  router.add('GET', '/projects/:id/decisions', (req) => ok(decisions.listByProject(req.params.id)));

  router.add('GET', '/decisions/:id', (req) => {
    const d = decisions.findById(req.params.id);
    return d ? ok(d) : err('not_found', `Decision '${req.params.id}' not found`);
  });

  router.add('POST', '/decisions/:id/resolve', (req) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const resolution = b.resolution as Decision['resolution'];
      const resumeTo = (b.resumeTo as 'running' | 'in_review' | 'blocked') ?? 'running';
      if (!resolution) return err('bad_request', 'resolution is required');
      return ok(workService.resolveDecision(req.params.id, resolution, resumeTo));
    } catch (e) { return svcErr(e); }
  });
}
