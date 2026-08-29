import { randomUUID } from 'crypto';
import type { Evidence } from '../../domain/evidence.js';
import type { EvidenceCollector, EvidenceCollectionRequest } from '../collector.js';
import type { GitHubAdapter } from './adapter.js';

// Collects GitHub Actions CI status for each commit produced by an execution.
// Source is always 'github' — never the executor — satisfying the external-only
// security invariant (DDR-032 §20).
export class GithubCiCollector implements EvidenceCollector {
  readonly type = 'github.ci';

  constructor(private readonly github: GitHubAdapter) {}

  async collect(req: EvidenceCollectionRequest): Promise<Evidence[]> {
    const results: Evidence[] = [];

    for (const commitRef of req.refs.commits ?? []) {
      const status = await this.github.getCiStatus(commitRef.repo.remote, commitRef.sha);

      let evidenceStatus: Evidence['status'];
      if (status.conclusion === 'success') {
        evidenceStatus = 'passed';
      } else if (status.conclusion === 'pending' || status.conclusion === null) {
        evidenceStatus = 'informational';
      } else {
        evidenceStatus = 'failed';
      }

      results.push({
        id: randomUUID(),
        workItemId: req.workItemId,
        stepExecutionId: req.stepExecutionId,
        type: 'github.ci',
        source: 'github',
        subjectRef: commitRef.sha,
        status: evidenceStatus,
        payload: status as unknown as Record<string, unknown>,
        collectedAt: new Date().toISOString(),
      });
    }

    // Also collect from PR head SHAs if no commits were provided explicitly.
    if ((req.refs.commits ?? []).length === 0) {
      for (const prRef of req.refs.prs ?? []) {
        const status = await this.github.getCiStatus(prRef.repo.remote, prRef.headSha);
        results.push({
          id: randomUUID(),
          workItemId: req.workItemId,
          stepExecutionId: req.stepExecutionId,
          type: 'github.ci',
          source: 'github',
          subjectRef: prRef.headSha,
          status: status.conclusion === 'success' ? 'passed'
            : (status.conclusion === null || status.conclusion === 'pending') ? 'informational'
            : 'failed',
          payload: status as unknown as Record<string, unknown>,
          collectedAt: new Date().toISOString(),
        });
      }
    }

    return results;
  }
}
