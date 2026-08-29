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
// ci-toolkit remains a separate component — Stratum consumes its output
// as independent semantic evidence (DDR-032 §20.2).
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
        source: 'ci_toolkit',
        status: 'informational',
        payload: { reason: 'ci-toolkit result file not found' } as unknown as Record<string, unknown>,
        collectedAt: new Date().toISOString(),
      }];
    }

    const passed = raw.blockingFindings === 0;
    return [{
      id: randomUUID(),
      workItemId: req.workItemId,
      stepExecutionId: req.stepExecutionId,
      type: 'ci_toolkit.semantic_review',
      source: 'ci_toolkit',
      status: passed ? 'passed' : 'failed',
      payload: {
        blockingFindings: raw.blockingFindings,
        warningFindings: raw.warningFindings,
        summary: raw.summary,
      } as unknown as Record<string, unknown>,
      collectedAt: new Date().toISOString(),
    }];
  }
}
