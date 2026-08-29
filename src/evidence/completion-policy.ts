import type { Evidence } from '../domain/evidence.js';
import type { EvidenceRequirement } from '../domain/primitives.js';
import type { PolicyEvaluation } from '../domain/policy.js';

// Evidence types that MUST come from an independent external source.
// Evidence from the executor adapter itself (source prefix 'executor:' or
// source === 'executor') is rejected for these types — the security invariant
// from DDR-032 §20: "Executor self-report cannot satisfy independent
// review/CI evidence requirements."
const EXTERNAL_ONLY_TYPES = new Set([
  'github.ci',
  'github.review',
  'ci_toolkit.semantic_review',
  'scope_diff',
]);

export class CompletionPolicy {
  // Returns 'allow' only if every requirement has at least one matching,
  // trusted evidence record.
  evaluate(requirements: EvidenceRequirement[], evidence: Evidence[]): PolicyEvaluation {
    for (const req of requirements) {
      const matched = evidence.filter(
        e => e.type === req.type
          && this.conditionsMet(e, req.conditions)
          && this.sourceTrusted(e, req.type),
      );
      if (matched.length === 0) {
        return {
          outcome: 'deny',
          reason: `Missing evidence: '${req.type}'${this.conditionSummary(req.conditions)}`,
        };
      }
    }
    return { outcome: 'allow', reason: 'All evidence requirements satisfied' };
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

  // Rejects evidence sourced by the executor itself for external-only types.
  private sourceTrusted(evidence: Evidence, requirementType: string): boolean {
    if (!EXTERNAL_ONLY_TYPES.has(requirementType)) return true;
    return (
      evidence.source !== 'executor'
      && !evidence.source.startsWith('executor:')
      && !evidence.source.startsWith('adapter:')
    );
  }

  private conditionSummary(conditions?: Record<string, string | number | boolean>): string {
    if (!conditions || Object.keys(conditions).length === 0) return '';
    const parts = Object.entries(conditions).map(([k, v]) => `${k}=${JSON.stringify(v)}`);
    return ` (conditions: ${parts.join(', ')})`;
  }
}
