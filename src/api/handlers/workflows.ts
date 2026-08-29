import type { Router } from '../router.js';
import { ok, err } from '../types.js';
import { listWorkflowIds, getWorkflow } from '../../workflow/index.js';

export function makeWorkflowHandlers(router: Router): void {
  router.add('GET', '/workflows', (_req) => {
    const ids = listWorkflowIds();
    return ok(
      ids
        .map(id => {
          const wf = getWorkflow(id);
          return wf ? { id: wf.id, label: wf.label, stepCount: wf.steps.length } : null;
        })
        .filter(Boolean),
    );
  });

  router.add('GET', '/workflows/:id', (req) => {
    const wf = getWorkflow(req.params.id);
    return wf ? ok(wf) : err('not_found', `Workflow '${req.params.id}' not found`);
  });
}
