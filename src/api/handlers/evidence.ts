import type { Router } from '../router.js';
import type { EvidenceRepository } from '../../storage/repositories.js';
import type { EvidenceService } from '../../services/evidence-service.js';
import { ok, err } from '../types.js';
import type { EvidenceStatus } from '../../domain/index.js';

export function makeEvidenceHandlers(
  router: Router,
  evidenceRepo: EvidenceRepository,
  evidenceService: EvidenceService,
): void {
  router.add('GET', '/work/:id/evidence', (req) => ok(evidenceRepo.listByWorkItem(req.params.id)));

  router.add('POST', '/work/:id/evidence', (req) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (!b.type || !b.source || !b.status) {
        return err('bad_request', 'type, source, and status are required');
      }
      const e = evidenceService.record({
        workItemId: req.params.id,
        type: b.type as string,
        source: b.source as string,
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
