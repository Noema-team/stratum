import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import type { Evidence } from '../domain/evidence.js';
import type { WorkItem } from '../domain/work-item.js';
import type { PolicyEvaluation } from '../domain/policy.js';
import { EvidenceRepository } from '../storage/repositories.js';
import { CompletionPolicy } from '../evidence/completion-policy.js';
import type { EvidenceCollector, EvidenceCollectionRequest } from '../evidence/collector.js';

export class EvidenceService {
  private readonly repo: EvidenceRepository;
  private readonly policy: CompletionPolicy;
  private readonly collectors: Map<string, EvidenceCollector>;

  constructor(db: Database.Database, collectors: EvidenceCollector[] = []) {
    this.repo = new EvidenceRepository(db);
    this.policy = new CompletionPolicy();
    this.collectors = new Map(collectors.map(c => [c.type, c]));
  }

  // Store a pre-built evidence record (used by adapters after collection).
  record(evidence: Omit<Evidence, 'id' | 'collectedAt'> & { id?: string; collectedAt?: string }): Evidence {
    const full: Evidence = {
      id: evidence.id ?? randomUUID(),
      collectedAt: evidence.collectedAt ?? new Date().toISOString(),
      ...evidence,
    };
    this.repo.save(full);
    return full;
  }

  listByWorkItem(workItemId: string): Evidence[] {
    return this.repo.listByWorkItem(workItemId);
  }

  // Evaluates whether all requiredEvidence on the WorkItem is satisfied.
  // This is the guard used by WorkService.complete().
  evaluateCompletion(workItem: WorkItem): PolicyEvaluation {
    if (workItem.requiredEvidence.length === 0) {
      return { outcome: 'allow', reason: 'No evidence requirements defined' };
    }
    const evidence = this.repo.listByWorkItem(workItem.id);
    return this.policy.evaluate(workItem.requiredEvidence, evidence);
  }

  // Run all registered collectors for a work item and persist the results.
  async collectAll(request: EvidenceCollectionRequest): Promise<Evidence[]> {
    const collected: Evidence[] = [];
    for (const collector of this.collectors.values()) {
      const items = await collector.collect(request);
      for (const e of items) {
        this.repo.save(e);
        collected.push(e);
      }
    }
    return collected;
  }

  // Convenience: returns a function suitable for injection into WorkService
  // as the evidenceGuard option.
  asGuard(): (workItem: WorkItem) => PolicyEvaluation {
    return (workItem) => this.evaluateCompletion(workItem);
  }
}
