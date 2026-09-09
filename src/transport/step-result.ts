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
// route is a CONTROL TRANSITION derived by Stratum (commit 3 will derive it
// deterministically from validated gap classifications). During migration
// the legacy textual `route:` preamble token is still extracted, but via a
// separate deprecated helper — it is not part of this contract.
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

// D.3d.5 — format repair is BOUNDED for every non-compliance kind. This
// budget is the same bound the textual fallback always had for malformed
// blocks (parseWithRetry allowed exactly one re-prompt); commit 1 extends
// the same bound to delimiter-ABSENT replies, which previously failed
// immediately with no repair at all. Exhaustion fails closed.
export const MAX_FORMAT_REPAIRS = 1;

export interface ResultTransport {
  readonly name: string;
  /**
   * Transport syntax teaching, injected by the execution layer — never by
   * workflow methodology. Shape follows TransportContext.execution: the
   * multi-turn path parses '### <path>' delimiter sections; the single-turn
   * path parses the YAML preamble + '## <path>' headers. Teaching must match
   * the parser that will actually consume the reply.
   */
  formatInstruction(ctx: TransportContext): string;
  /** Convert a multi-turn produce reply into a StepResult. Throws TransportParseError. */
  extractProduce(raw: string, ctx: TransportContext): StepResult;
  /**
   * The bounded format-repair prompt for a non-compliant reply.
   * `kind: 'absent'` — the reply carried no recognizable result block at all;
   * `kind: 'malformed'` — a block existed but could not be parsed (reason given).
   */
  repairInstruction(kind: 'absent' | 'malformed', reason?: string): string;
}
