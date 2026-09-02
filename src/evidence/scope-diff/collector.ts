import { randomUUID } from 'crypto';
import type { Evidence } from '../../domain/evidence.js';
import type { EvidenceCollector, EvidenceCollectionRequest } from '../collector.js';

export type ScopeDriftLevel =
  | 'within_scope'
  | 'minor_expansion'
  | 'material_expansion'
  | 'forbidden_change';

export interface ScopeDiffResult {
  driftLevel: ScopeDriftLevel;
  changedFiles: string[];
  // Files changed that were not in expected scope
  unexpectedFiles: string[];
  // Files changed that are explicitly forbidden
  forbiddenFiles: string[];
}

// ScopeDiffCollector compares actual changed files to the work item's expected
// scope (DDR-032 §21). The implementation is injected so callers can provide
// a VCS-backed or stub diff provider.
export type FileDiffProvider = (ref: string, baseRef: string) => Promise<string[]>;

export class ScopeDiffCollector implements EvidenceCollector {
  readonly type = 'scope_diff';

  constructor(
    private readonly diffProvider: FileDiffProvider,
    private readonly expectedPaths: string[],
    private readonly forbiddenPaths: string[],
  ) {}

  async collect(req: EvidenceCollectionRequest): Promise<Evidence[]> {
    const results: Evidence[] = [];

    for (const prRef of req.refs.prs ?? []) {
      const changedFiles = await this.diffProvider(prRef.headSha, `${prRef.repo.remote}/main`);
      const diff = this.analyzeDiff(changedFiles);

      results.push({
        id: randomUUID(),
        workItemId: req.workItemId,
        stepExecutionId: req.stepExecutionId,
        type: 'scope_diff',
        source: 'scope_analyzer',
        collectorId: 'scope_diff',
        candidateRef: prRef.headSha,
        subjectRef: prRef.headSha,
        status: diff.driftLevel === 'within_scope' || diff.driftLevel === 'minor_expansion'
          ? 'passed'
          : diff.driftLevel === 'material_expansion' ? 'informational' : 'failed',
        payload: diff as unknown as Record<string, unknown>,
        collectedAt: new Date().toISOString(),
      });
    }

    return results;
  }

  private analyzeDiff(changedFiles: string[]): ScopeDiffResult {
    const forbiddenFiles = changedFiles.filter(f =>
      this.forbiddenPaths.some(fp => f.startsWith(fp))
    );

    if (forbiddenFiles.length > 0) {
      return {
        driftLevel: 'forbidden_change',
        changedFiles,
        unexpectedFiles: [],
        forbiddenFiles,
      };
    }

    const unexpectedFiles = this.expectedPaths.length > 0
      ? changedFiles.filter(f => !this.expectedPaths.some(ep => f.startsWith(ep)))
      : [];

    let driftLevel: ScopeDriftLevel;
    if (unexpectedFiles.length === 0) {
      driftLevel = 'within_scope';
    } else if (unexpectedFiles.length <= 2) {
      driftLevel = 'minor_expansion';
    } else {
      driftLevel = 'material_expansion';
    }

    return { driftLevel, changedFiles, unexpectedFiles, forbiddenFiles: [] };
  }
}
