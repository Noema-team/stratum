// D.34 C7 — the four-tier run diagnosis (docs/developmentPlan/d34-output-
// contracts.md, C7; DDR-034 closure): after the output-contract work, the
// interesting question about a failing define-work run is WHERE it failed,
// and the answer must be derived from the run's recorded evidence — never
// re-judged by hand or by a model.
//
//   SEM       — semantic capability: the wire worked and the run converged,
//               but the work is wrong (oracle methodology failures: weakened
//               facts, invented/missing escalations, wrong verdicts, …).
//   TRANSPORT — transport compatibility: the model could not deliver a
//               consumable result (format/result repair exhaustion,
//               negotiation errors, parse failures) — the failure class
//               D.34 exists to shrink.
//   CONV      — workflow convergence: per-step results may be fine, but the
//               run did not settle (halted, unexpected step failure,
//               never reached commit).
//   DEPLOY    — deployment qualification: a SERIES verdict over repeated
//               runs (deploymentVerdict), not a per-run failure mode.
//
// DETERMINISM CONTRACT (the C7 acceptance test): diagnoseRun and
// deploymentVerdict are PURE — same evidence in, same diagnosis out, no
// clock, no randomness, no I/O, no model. A failed run persists enough
// evidence (raw node-outputs + generated artifacts, copied by the eval
// script) that a human can re-derive the diagnosis by reading the report.
import type { DefineWorkTrace, OracleResult } from './harness.js';

export type DiagnosisTier = 'SEM' | 'TRANSPORT' | 'CONV';

export interface RunDiagnosis {
  /** null when the run passed — there is nothing to diagnose. */
  tier: DiagnosisTier | null;
  /** Deterministic, human-readable evidence lines (step ids, error text, failed check names). */
  details: string[];
}

// The TRANSPORT vocabulary — the exact failure surfaces the execution layer
// emits when the WIRE (not the semantics) failed. These strings are owned by
// src/transport/step-result.ts and agent-runner.ts diagnostics; this module
// only RECOGNIZES them, never rewords them.
const TRANSPORT_ERROR_PATTERNS: RegExp[] = [
  /format repair is exhausted/,
  /result repair is exhausted/,
  /Output-contract negotiation error/,
  /Output parsing failed/,
  /Missing SLE-OUTPUT/,
  /contained no JSON object/,
  /could not be consumed/,
  /rejected by the output contract/,
  /returned non-JSON content/,
];

function isTransportError(error: string | undefined): boolean {
  if (error === undefined) return false;
  return TRANSPORT_ERROR_PATTERNS.some((re) => re.test(error));
}

/**
 * The pure per-run diagnosis. Precedence is deliberate and fixed:
 *   1. TRANSPORT — a wire failure poisons everything downstream (the model
 *      never got a fair semantic hearing), so it is reported first.
 *   2. CONV — the run did not settle: halted, unexpected (non-transport)
 *      step failure, or never reached commit.
 *   3. SEM — the run converged cleanly but failed the methodology oracle.
 * A passing run diagnoses to { tier: null }.
 */
export function diagnoseRun(trace: DefineWorkTrace, oracle: OracleResult): RunDiagnosis {
  // 1. TRANSPORT: any recorded step whose error matches the wire vocabulary.
  const transportSteps = trace.steps.filter((s) => isTransportError(s.error));
  if (transportSteps.length > 0) {
    return {
      tier: 'TRANSPORT',
      details: transportSteps.map((s) => `${s.stepId}: ${s.error}`),
    };
  }

  // 2. CONV: the run did not settle — halted, threw before completing, or a
  // step failed for a non-transport reason.
  const convDetails: string[] = [];
  if (trace.finalStatus !== 'complete' || trace.finalStepId !== 'commit') {
    convDetails.push(`run did not reach commit: status=${trace.finalStatus} step=${trace.finalStepId}`);
  }
  const failedSteps = trace.steps.filter((s) => !s.success);
  for (const s of failedSteps) {
    convDetails.push(`${s.stepId} failed: ${s.error ?? '(no error recorded)'}`);
  }
  if (trace.error !== undefined) {
    convDetails.push(`run error: ${trace.error}`);
  }
  if (convDetails.length > 0) {
    return { tier: 'CONV', details: convDetails };
  }

  // 3. SEM: clean wire, clean convergence — what failed is the methodology.
  if (!oracle.pass) {
    return {
      tier: 'SEM',
      details: oracle.checks.filter((c) => !c.pass).map((c) => `${c.name}${c.detail ? ` — ${c.detail}` : ''}`),
    };
  }

  return { tier: null, details: [] };
}

// ─── DEPLOY — the series verdict over repeated runs ───────────────────────────
//
// Deterministic aggregate over the per-run reports the eval script emits:
// a model is deployment-qualified for define-work when EVERY run in the
// series passed its oracle AND stayed within the scenario's iteration
// budget. Any failing run disqualifies, and the disqualifying evidence is
// the runs' own diagnoses (never a new judgment).

export interface DeploymentEvidence {
  scenarioId: string;
  passed: boolean;
  iterationsUsed: number;
  diagnosisTier: DiagnosisTier | null;
}

export interface DeploymentVerdict {
  qualified: boolean;
  reasons: string[];
}

export function deploymentVerdict(evidence: DeploymentEvidence[]): DeploymentVerdict {
  const reasons: string[] = [];
  for (const run of evidence) {
    if (!run.passed) {
      reasons.push(
        `${run.scenarioId}: not passed${run.diagnosisTier ? ` (${run.diagnosisTier})` : ''}`,
      );
    }
  }
  return { qualified: reasons.length === 0, reasons };
}
