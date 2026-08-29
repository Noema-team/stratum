import { randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
import { join } from 'path';
import type { Evidence } from '../../domain/evidence.js';
import type { EvidenceCollector, EvidenceCollectionRequest } from '../collector.js';

// Shape expected from a ci-toolkit result file.
export interface CiToolkitResult {
  schemaVersion: number;
  blockingFindings: number;
  warningFindings: number;
  summary: string;
  checks: Array<{
    name: string;
    status: 'passed' | 'failed' | 'warning';
    message?: string;
  }>;
}

// Reads ci-toolkit output from a known file inside the project root.
//
// TRUST BOUNDARY: This collector reads from `.sle/ci-toolkit-result.json`,
// a path that the executor CAN write. Therefore evidence produced here is
// classified as 'informational' — it cannot satisfy requirements that need
// independent external verification (e.g. 'ci_toolkit.semantic_review' with
// status: 'passed'). For authoritative ci-toolkit evidence, use the GitHub
// Actions / check-runs path (GitHubCiCollector), which retrieves results
// from the GitHub API after the check completes independently.
export class CiToolkitCollector implements EvidenceCollector {
  readonly type = 'ci_toolkit.semantic_review';

  private static readonly RESULT_PATH = '.sle/ci-toolkit-result.json';

  constructor(private readonly projectRoot: string) {}

  async collect(req: EvidenceCollectionRequest): Promise<Evidence[]> {
    const resultPath = join(this.projectRoot, CiToolkitCollector.RESULT_PATH);
    let raw: CiToolkitResult;

    try {
      const contents = await readFile(resultPath, 'utf8');
      raw = JSON.parse(contents) as CiToolkitResult;
    } catch {
      // File not present — ci-toolkit has not run yet. Return informational.
      return [{
        id: randomUUID(),
        workItemId: req.workItemId,
        stepExecutionId: req.stepExecutionId,
        type: 'ci_toolkit.semantic_review',
        source: 'ci_toolkit:local_file',
        collectorId: 'ci_toolkit.semantic_review',
        candidateRef: req.candidateRef,
        status: 'informational',
        payload: { reason: 'ci-toolkit result file not found' } as unknown as Record<string, unknown>,
        collectedAt: new Date().toISOString(),
      }];
    }

    // Regardless of what the file reports, evidence from an executor-writable
    // path is 'informational'. The completion policy will not accept it as
    // satisfying an external-only requirement with status: 'passed'.
    return [{
      id: randomUUID(),
      workItemId: req.workItemId,
      stepExecutionId: req.stepExecutionId,
      type: 'ci_toolkit.semantic_review',
      source: 'ci_toolkit:local_file',
      collectorId: 'ci_toolkit.semantic_review',
      candidateRef: req.candidateRef,
      // Always informational — executor-writable path, cannot be authoritative.
      status: 'informational',
      payload: {
        blockingFindings: raw.blockingFindings,
        warningFindings: raw.warningFindings,
        summary: raw.summary,
        // Preserve the raw result so operators can inspect it.
        localFileReport: true,
        // blockingFindings are still surfaced so humans can decide.
        passed: raw.blockingFindings === 0,
      } as unknown as Record<string, unknown>,
      collectedAt: new Date().toISOString(),
    }];
  }
}
