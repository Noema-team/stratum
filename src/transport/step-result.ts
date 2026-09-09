// D.3d.5 commit 1 — the unified logical step-result contract and the
// transport seam.
//
// History this module replaces: the SLE-OUTPUT wire shapes (the multi-turn
// <<<SLE-OUTPUT>>> delimiters and the single-turn '<!-- SLE-OUTPUT' YAML
// preamble) were taught by workflow methodology text (see the former
// PRODUCE_OUTPUT_FORMAT_CONTRACT / REVIEW_OUTPUT_FORMAT_CONTRACT in
// workflow/methodology/definition-readiness.ts), parsed by two different
// mechanisms (agent-loop.ts/output-parser.ts vs agent-runner.ts), and the
// D.3d.5 review found the model boundary carrying too much of it: a model
// had to learn two Stratum-specific serialization languages, and a reply
// that omitted the delimiter entirely bypassed format repair and failed
// immediately (agent-loop.ts failed on absence before any repair).
//
// The seam inverts the ownership:
//
//   LLM/proposal side     → StepResult (logical: artifacts + optional review)
//   ResultTransport       → how a provider's raw reply BECOMES a StepResult:
//                           syntax teaching, extraction, bounded format repair
//   AgentRunner/AgentLoop → orchestration + fail-closed gates (unchanged)
//
// Capability order for transports (D.3d.5 direction, not yet all built):
//   1. provider-native structured output where genuinely supported;
//   2. submit-result/tool-call style mechanism where genuinely supported;
//   3. the textual SLE-OUTPUT fallback (implemented; the only transport
//      every current provider actually gets — no capability is faked).
//
// Canonical StepResult deliberately carries NO route field: the review
// route is a CONTROL TRANSITION derived by Stratum — deterministically,
// from the produced artifact's structured gap classifications
// (D.3d.5 commit 3; src/workflow/methodology/readiness-artifact.ts). The
// reply never declares a route: a model-emitted `route:` token is ignored
// by the transport and carries no authority anywhere.
import type { AgentRole } from '../types.js';

export interface StepResultArtifact {
  path: string;
  content: string;
}

export interface StepReviewProposal {
  verdict: 'pass' | 'fail';
}

export interface StepResult {
  artifacts: StepResultArtifact[];
  review?: StepReviewProposal;
}

export interface TransportContext {
  role: AgentRole;
  /** Review steps declare a verdict; produce steps do not. */
  requiresReviewVerdict: boolean;
  /** Which execution path will parse the reply — each path has its own wire shape. */
  execution: 'multi-turn' | 'single-turn';
  // ─── Actual step metadata (D.3d.5 review amendment: teaching is generated
  // ─── from this, never from workflow-specific hardcoded examples) ───────────
  /** The executing step's id — rendered into preamble teaching as `node:`. */
  nodeId?: string;
  /** The declared output artifact's semantic id (StepKinds-declared `type`). */
  declaredArtifactId?: string;
  /** The declared output artifact's physical path — rendered into teaching. */
  declaredOutputPath?: string;
  /**
   * How many artifacts the executing step's output contract expects. The
   * transport owns SERIALIZATION, not workflow semantics: it must reflect
   * the step's actual cardinality rather than impose a transport-wide
   * one-artifact law. A step that declares exactly one artifact gets the
   * single-artifact restriction; a step whose execution permits several
   * (legacy multi-artifact roles) must not have a false restriction taught.
   * Absent = unconstrained/unknown — teach generically, restrict nothing.
   */
  expectedArtifacts?: number;
}

/** Raised when a raw reply cannot be converted into a StepResult. */
export class TransportParseError extends Error {
  constructor(
    message: string,
    public readonly raw: string,
    public readonly reason: string,
    /**
     * 'absent' — the reply carried no recognizable result block at all;
     * 'malformed' — a block existed but could not be parsed. The loop maps
     * each kind to its own bounded-repair prompt; it never inspects raw
     * syntax itself.
     */
    public readonly kind: 'absent' | 'malformed' = 'malformed',
  ) {
    super(message);
    this.name = 'TransportParseError';
  }
}

// D.3d.5 — format repair is BOUNDED for every non-compliance kind on BOTH
// execution paths (single-turn repairs were previously missing entirely;
// multi-turn absence previously failed with no repair). The budget is the
// same bound the textual fallback always had for malformed blocks.
// Exhaustion fails closed — see repairDecision + the shared diagnostic
// below.

export interface ResultTransport {
  readonly name: string;
  /**
   * Transport syntax teaching, injected by the execution layer — never by
   * workflow methodology. Shape follows TransportContext.execution: the
   * multi-turn path parses '### <path>' delimiter sections; the single-turn
   * path parses the YAML preamble + '## <path>' headers. Teaching must match
   * the parser that will actually consume the reply, and artifact
   * cardinality must reflect the executing step, not a transport-wide law.
   */
  formatInstruction(ctx: TransportContext): string;
  /** Convert a multi-turn produce reply into a StepResult. Throws TransportParseError. */
  extractProduce(raw: string, ctx: TransportContext): StepResult;
  /**
   * Convert a single-turn reply (review or legacy single-turn produce) into
   * a StepResult. Throws TransportParseError. The runner consumes ONLY this
   * — it never parses raw replies itself, so a structured/native transport
   * can replace the wire format without touching the runner.
   */
  extractSingleTurn(raw: string, ctx: TransportContext): StepResult;
  /**
   * The bounded format-repair prompt for a non-compliant reply — taught in
   * the representation the ACTIVE execution context actually uses (a
   * single-turn preamble reply must never be repaired with multi-turn
   * delimiter instructions, or vice versa). `kind: 'absent'` — the reply
   * carried no recognizable result block at all; `kind: 'malformed'` — a
   * block existed but could not be parsed (reason given).
   */
  repairInstruction(ctx: TransportContext, kind: 'absent' | 'malformed', reason?: string): string;
}

// ─── Shared bounded-repair policy (D.3d.5 closure: symmetric by construction) ─
//
// ONE policy, two execution mechanics. The multi-turn loop repairs inside
// its conversation; the single-turn runner repairs by issuing another
// completion with the transport's repair instruction attached. Both obey
// the identical decision rule and emit identical diagnostic wording, so
// the rule and the wording live here — not in either call site.

/** At most MAX_FORMAT_REPAIRS repair prompts per step execution. Do not raise. */
export const MAX_FORMAT_REPAIRS = 1;

export function repairDecision(
  attemptsSoFar: number,
): { action: 'repair' } | { action: 'fail-closed' } {
  return attemptsSoFar >= MAX_FORMAT_REPAIRS ? { action: 'fail-closed' } : { action: 'repair' };
}

/**
 * The exact fail-closed diagnostic. Counters have ONE definition everywhere:
 *   providerCalls — total provider invocations performed by that execution
 *                   loop (INCLUDING repair-prompted invocations);
 *   repairAttempts — provider invocations initiated specifically by a
 *                   transport-format repair prompt.
 */
export function formatRepairExhaustedDiagnostic(
  err: TransportParseError,
  providerCalls: number,
  repairAttempts: number,
): string {
  const what = err.kind === 'absent'
    ? 'Agent reply carried no recognizable result block'
    : 'Agent reply carried a malformed result block';
  return (
    `${what} and format repair is exhausted ` +
    `(${providerCalls} provider turn(s), ${repairAttempts} format-repair attempt(s)): ${err.reason}`
  );
}
