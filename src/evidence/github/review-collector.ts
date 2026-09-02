import { randomUUID } from 'crypto';
import type { Evidence } from '../../domain/evidence.js';
import type { EvidenceCollector, EvidenceCollectionRequest } from '../collector.js';
import type { GitHubAdapter } from './adapter.js';

// Collects GitHub pull-request review status for each PR produced by an execution.
// Source is always 'github' — never the executor.
export class GithubReviewCollector implements EvidenceCollector {
  readonly type = 'github.review';

  constructor(private readonly github: GitHubAdapter) {}

  async collect(req: EvidenceCollectionRequest): Promise<Evidence[]> {
    const results: Evidence[] = [];

    for (const prRef of req.refs.prs ?? []) {
      const reviewStatus = await this.github.getReviewStatus(prRef.repo.remote, prRef.number);

      // candidateRef comes from the adapter's response — the actual GitHub head SHA,
      // not from caller-supplied EvidenceCollectionRequest metadata.
      const actualHeadSha = reviewStatus.headSha;

      // If the requested head SHA diverges from GitHub's current PR head, the review
      // does not cover the candidate in question; emit failed evidence so the policy
      // sees the mismatch rather than silently binding approval to the wrong commit.
      const shaMismatch = prRef.headSha !== actualHeadSha;

      const evidenceStatus: Evidence['status'] = shaMismatch
        ? 'failed'
        : reviewStatus.approved
        ? 'passed'
        : reviewStatus.changesRequested
        ? 'failed'
        : 'informational';

      results.push({
        id: randomUUID(),
        workItemId: req.workItemId,
        stepExecutionId: req.stepExecutionId,
        type: 'github.review',
        source: 'github',
        collectorId: 'github.review',
        candidateRef: actualHeadSha,
        subjectRef: String(prRef.number),
        status: evidenceStatus,
        payload: {
          prNumber: reviewStatus.prNumber,
          approved: reviewStatus.approved,
          changesRequested: reviewStatus.changesRequested,
          reviewCount: reviewStatus.reviews.length,
          requestedHeadSha: prRef.headSha,
          actualHeadSha,
          shaMismatch,
        } as unknown as Record<string, unknown>,
        collectedAt: new Date().toISOString(),
      });
    }

    return results;
  }
}
