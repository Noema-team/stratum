import type { UUID } from '../domain/primitives.js';
import type { Evidence } from '../domain/evidence.js';
import type { ArtifactRefs } from './refs.js';

export interface EvidenceCollectionRequest {
  workItemId: UUID;
  stepExecutionId?: UUID;
  // Repositories the execution touched.
  repositories: Array<{ id: UUID; remote: string; defaultBranch: string }>;
  // Artefact references produced during execution.
  refs: ArtifactRefs;
  // The commit SHA the execution produced or targeted. Collectors must bind
  // any collected evidence to this ref so the completion policy can enforce
  // SHA-specific satisfaction (evidence for SHA A ≠ satisfaction for SHA B).
  candidateRef?: string;
}

// Evidence collectors are adapters (DDR-032 §20). Each collector is responsible
// for one evidence type and fetches from an independent external source — never
// from the executor that produced the work.
export interface EvidenceCollector {
  readonly type: string;
  collect(request: EvidenceCollectionRequest): Promise<Evidence[]>;
}
