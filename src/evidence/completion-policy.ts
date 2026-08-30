import type { Evidence } from '../domain/evidence.js';
import type { EvidenceRequirement } from '../domain/primitives.js';
import type { PolicyEvaluation } from '../domain/policy.js';

// Evidence types that MUST come from an independent external source.
// Evidence where collectorId is missing or source has an executor prefix is
// rejected for these types — DDR-032 §20: "Executor self-report cannot
// satisfy independent review/CI evidence requirements."
const EXTERNAL_ONLY_TYPES = new Set([
  'github.ci',
  'github.review',
  'ci_toolkit.semantic_review',
  'scope_diff',
]);

// Per-type mapping of allowed collector IDs (DDR-032 §20).
// A trusted collectorId for type X cannot satisfy a requirement of type Y.
// Designed as a map so each type can allow multiple implementations later.
const COLLECTOR_TRUST: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['github.ci',                 new Set(['github.ci'])],
  ['github.review',             new Set(['github.review'])],
  ['ci_toolkit.semantic_review', new Set(['ci_toolkit.semantic_review'])],
  ['scope_diff',                new Set(['scope_diff'])],
]);

export class CompletionPolicy {
  // Returns 'allow' only if every requirement has at least one matching,
  // trusted evidence record.
  evaluate(requirements: EvidenceRequirement[], evidence: Evidence[]): PolicyEvaluation {
    for (const req of requirements) {
      const matched = evidence.filter(
        e => e.type === req.type
          && this.candidateRefMatches(e, req)
          && this.conditionsMet(e, req.conditions)
          && this.sourceTrusted(e, req.type),
      );
      if (matched.length === 0) {
        return {
          outcome: 'deny',
          reason: this.buildDenyReason(req, evidence),
        };
      }
    }
    return { outcome: 'allow', reason: 'All evidence requirements satisfied' };
  }

  // SHA binding: if the requirement pins a candidateRef, the evidence must
  // carry the same ref. Evidence for SHA A never satisfies SHA B.
  private candidateRefMatches(evidence: Evidence, req: EvidenceRequirement): boolean {
    if (!req.candidateRef) return true;  // requirement is not SHA-pinned
    return evidence.candidateRef === req.candidateRef;
  }

  // Checks that an evidence record satisfies the requirement's conditions.
  // The special key 'status' is matched against evidence.status directly;
  // all other keys are matched against the flat evidence payload.
  // Default when conditions is absent: evidence.status must be 'passed'.
  private conditionsMet(
    evidence: Evidence,
    conditions?: Record<string, string | number | boolean>,
  ): boolean {
    if (!conditions) {
      return evidence.status === 'passed';
    }
    for (const [key, value] of Object.entries(conditions)) {
      if (key === 'status') {
        if (evidence.status !== value) return false;
      } else {
        const payload = evidence.payload as Record<string, unknown>;
        if (!payload || payload[key] !== value) return false;
      }
    }
    return true;
  }

  // Provenance trust: for external-only types, evidence must come from a
  // registered trusted collector (collectorId), not from executor self-report.
  // The source string alone is NOT sufficient — it is caller-controlled.
  private sourceTrusted(evidence: Evidence, requirementType: string): boolean {
    if (!EXTERNAL_ONLY_TYPES.has(requirementType)) return true;

    // Reject executor self-report regardless of source string.
    if (
      evidence.source === 'executor'
      || evidence.source.startsWith('executor:')
      || evidence.source.startsWith('adapter:')
    ) {
      return false;
    }

    // Reject local-file sources (executor-writable path) regardless of collectorId.
    // The collectorId check cannot override this: a collector that reads from a
    // path the executor controls is still untrusted.
    if (evidence.source.endsWith(':local_file') || evidence.source === 'local_file') {
      return false;
    }

    // collectorId must be present and must be the registered collector for
    // this specific evidence type. A trusted collectorId for a different
    // type does not satisfy this requirement (cross-type mismatch → deny).
    if (evidence.collectorId === undefined) return false;
    const allowed = COLLECTOR_TRUST.get(requirementType);
    return allowed !== undefined && allowed.has(evidence.collectorId);
  }

  private buildDenyReason(req: EvidenceRequirement, evidence: Evidence[]): string {
    const base = `Missing evidence: '${req.type}'${this.conditionSummary(req.conditions)}`;
    if (req.candidateRef) {
      const wrongSha = evidence.filter(
        e => e.type === req.type && e.candidateRef && e.candidateRef !== req.candidateRef,
      );
      if (wrongSha.length > 0) {
        return `${base} — evidence exists but is bound to a different candidateRef (SHA mismatch)`;
      }
    }
    return base;
  }

  private conditionSummary(conditions?: Record<string, string | number | boolean>): string {
    if (!conditions || Object.keys(conditions).length === 0) return '';
    const parts = Object.entries(conditions).map(([k, v]) => `${k}=${JSON.stringify(v)}`);
    return ` (conditions: ${parts.join(', ')})`;
  }
}
