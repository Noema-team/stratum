import { promises as nodeFsPromises } from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import type { AgentRole } from './types.js';
import type { RunArtifactManager } from './run-artifacts.js';
import { handleToolCall, AGENT_TOOLS, listGitTrackedFiles, type ToolName, type TrackedFilesLister } from './tools.js';
import type { ParsedOutput } from './output-parser.js';
import {
  type ResultTransport,
  type StepResult,
  type TransportContext,
  TransportParseError,
  repairDecision,
  formatRepairExhaustedDiagnostic,
  resultRepairDecision,
  resultRepairExhaustedDiagnostic,
} from './transport/step-result.js';
import { resolveResultTransport } from './transport/textual-sle-output.js';

// ─── Types ────────────────────────────────────────────────────────────────────

// D.3d — raised from 10. The live-provider qualification showed a genuinely
// targeted investigation (orient, drill to the relevant directory, read the
// 2-3 files that answer the Objective's questions) consumes one turn per
// tool round trip, so a correct read-verify-conclude flow needs ~12+ turns;
// at 10 the loop cut off correct behavior mid-investigation. This is a turn
// budget on ONE step's tool loop — unrelated to define-work's max_iterations
// (the workflow-level refinement cap, which stays 4).
export const MAX_AGENT_TURNS = 24;

// E21 — the synthesis-phase announcement, appended ONCE as a user turn on
// the first turn after the gate threshold. Loop-owned protocol text (taught
// by the loop exactly like the transport instruction), never workflow
// methodology: the boundary is enforced by the tool protocol — the read
// tools are no longer offered — and this instruction tells the model what
// that means for it: produce the contracted artifact now, from verified
// evidence, preserving unknowns as unknown.
export const SYNTHESIS_PHASE_INSTRUCTION =
  'Investigation phase is over: repository read tools are no longer available. ' +
  'Produce your contracted artifact NOW from the evidence you have already verified. ' +
  'Work only from that verified evidence — preserve anything unverified as unknown, ' +
  'and never invent repository facts. Your remaining turns are for producing the artifact.';

// ─── E23 — synthesis-boundary tool-result compaction ──────────────────────────
//
// Live evidence (A10 attempts 12–13) showed the gated steps reaching
// synthesis cleanly (zero repairs) while the provider truncated the
// synthesis completion against REMAINING CONTEXT: the cut point moved DOWN
// (31,997 → 27,984 chars) as the requested completion budget moved UP
// (32,768 → 65,536, probe-verified on the wire). The mechanism is the loop
// itself: investigation retains every full read_file payload, so after ~18
// investigation turns the synthesis request inherits ~68k+ tokens of raw
// repository bytes and the artifact cannot fit the remainder.
//
// E23 compacts ONLY at the synthesis transition and ONLY old read_file
// payloads, by a frozen newest-first byte budget: recent evidence stays
// verbatim, older payloads are replaced by a deterministic elision marker
// (path, bytes, sha256) so the model knows WHAT it inspected, that the
// elision was deliberate, and must not infer details no longer visible.
// Investigation turns are byte-for-byte unchanged; without the gate (or
// without a budget) nothing is ever compacted. Original bytes stay
// recoverable: the marker pins the sha256 of the exact payload, and the
// target repo at the pinned commit is the evidence source of truth.
export interface SynthesisCompactionRecord {
  phase: 'synthesis';
  policy: 'newest-first';
  budget_bytes: number;
  original_read_result_bytes: number;
  retained_read_result_bytes: number;
  elided_result_count: number;
  retained_result_count: number;
  elided: Array<{ path: string; bytes: number; sha256: string }>;
}

export function compactReadHistoryForSynthesis(
  messages: MultiTurnMessage[],
  budgetBytes: number,
): SynthesisCompactionRecord | null {
  // tool_use id → { tool, path }: assistant messages carry the calls. The
  // wire shape is structural: some providers/typed blocks may omit the
  // literal `type: 'tool_use'` tag, so detect by the id+name+input shape
  // (the loop itself and handleToolCall never require the tag either).
  const callById = new Map<string, { tool: string; path: string }>();
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (const tu of m.content) {
        const b = tu as Partial<ToolUseBlock>;
        if (typeof b.id === 'string' && typeof b.name === 'string') {
          callById.set(b.id, {
            tool: b.name,
            path: (b.input as Record<string, string> | undefined)?.path ?? '',
          });
        }
      }
    }
  }

  // Completed read_file results in conversation order (oldest first).
  interface Candidate { block: ToolResultBlock; path: string; bytes: number }
  const candidates: Candidate[] = [];
  for (const m of messages) {
    if (m.role === 'user' && Array.isArray(m.content)) {
      for (const block of m.content) {
        const b = block as Partial<ToolResultBlock>;
        const isResult = b.type === 'tool_result' || typeof b.tool_use_id === 'string';
        if (!isResult) continue;
        const call = callById.get(b.tool_use_id!);
        if (!call || call.tool !== 'read_file') continue; // never touch other tools' results
        candidates.push({ block: block as ToolResultBlock, path: call.path, bytes: Buffer.byteLength(String(b.content ?? ''), 'utf-8') });
      }
    }
  }
  if (candidates.length === 0) return null;

  // Newest-first fill: retain while the payload fits the remaining budget.
  const originalTotal = candidates.reduce((a, c) => a + c.bytes, 0);
  const elided = new Set<Candidate>();
  const elidedHashes = new Map<Candidate, string>();
  let used = 0;
  for (let i = candidates.length - 1; i >= 0; i--) {
    const c = candidates[i];
    if (used + c.bytes <= budgetBytes) {
      used += c.bytes;
    } else {
      elided.add(c);
    }
  }

  for (const c of elided) {
    const original = String(c.block.content);
    const sha256 = createHash('sha256').update(original, 'utf-8').digest('hex');
    elidedHashes.set(c, sha256);
    c.block.content =
      '[earlier read_file result elided for synthesis context:\n' +
      ` path=${c.path}\n` +
      ` bytes=${c.bytes}\n` +
      ` sha256=${sha256}]\n` +
      'This result was inspected earlier in this step and is deliberately not repeated here. ' +
      'Do not infer its detailed contents; treat specifics from it as unknown.';
  }

  return {
    phase: 'synthesis',
    policy: 'newest-first',
    budget_bytes: budgetBytes,
    original_read_result_bytes: originalTotal,
    retained_read_result_bytes: used,
    elided_result_count: elided.size,
    retained_result_count: candidates.length - elided.size,
    elided: [...elided].map((c) => ({ path: c.path, bytes: c.bytes, sha256: elidedHashes.get(c) ?? '' })),
  };
}

// E10/A3 — bounded transport retry: the ONLY eligible error is undici's
// HeadersTimeoutError (UND_ERR_HEADERS_TIMEOUT), and at most ONE retry may
// occur within a step execution. A repeated timeout fails closed. Do not
// raise without preregistration.
const MAX_HEADERS_TIMEOUT_RETRIES = 1;

export interface MultiTurnMessage {
  role: 'user' | 'assistant';
  content: string | MultiTurnContentBlock[];
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}

export type MultiTurnContentBlock = ToolUseBlock | ToolResultBlock | { type: 'text'; text: string };

export interface MultiTurnResult {
  stop_reason: string;
  text: string;
  tool_uses: ToolUseBlock[];
  tokens_used: number;
}

export interface MultiTurnParams {
  model: string;
  system: string;
  messages: MultiTurnMessage[];
  max_tokens: number;
  // E3b — sampling parity across wires (C6 review closure 3 semantics): the
  // multi-turn wire must carry the SAME sampling configuration as the
  // single-turn and structured wires. Optional; absent leaves the provider
  // default (legacy behavior, byte-for-byte).
  temperature?: number;
  // D.34 C5 — widened from `typeof AGENT_TOOLS` to a structural readonly
  // array: the transport may add the result-submission tool (derived from
  // the step's contract projection) alongside the read tools. Providers map
  // these onto their own wire formats.
  tools: ReadonlyArray<{
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
  }>;
}

export interface IMultiTurnProvider {
  completeMultiTurn(params: MultiTurnParams): Promise<MultiTurnResult>;
}

export interface AgentLoopOptions {
  model: string;
  max_tokens?: number;
  // E3b — forwarded to the provider on every multi-turn call (sampling
  // parity with the single-turn/structured wires).
  temperature?: number;
  projectRoot: string;
  role: AgentRole;
  workflowRunId: string;
  iteration: number;
  nodeId: string;
  runArtifacts: RunArtifactManager;
  fsModule?: typeof import('fs').promises;
  // D.3b1 — injectable lister for the Git-tracked-file read authority (see
  // tools.ts). Defaults to the real `git ls-files`-backed implementation;
  // tests inject a synthetic tracked-file list instead of requiring a real
  // git repository.
  listTrackedFiles?: TrackedFilesLister;
  // E21 — two-phase convergence gate (WorkflowStep.synthesisGate, copied to
  // the StepRunContext by the engine). When set, repository read tools are
  // withdrawn from the tool protocol from the threshold turn on and the
  // synthesis instruction is announced once; the turn cap, validators, and
  // repair budgets are untouched. E23 — readResultBudgetBytes additionally
  // enables synthesis-boundary compaction of OLD read_file payloads
  // (newest-first byte budget; investigation turns byte-for-byte unchanged;
  // never runs without the gate or without a budget).
  synthesisGate?: { thresholdTurns: number; readResultBudgetBytes?: number };
  // D.3d.5 commit 1 (closure) — the executing step's actual output contract,
  // so the transport teaches from REAL metadata on this path too (never a
  // generic placeholder when the step has a declared output artifact).
  declaredArtifactId?: string;
  declaredOutputPath?: string;
  // E26 — the step's authorized output set for open-set produce steps
  // (exact paths and/or '/'-suffixed prefixes); rendered into teaching.
  authorizedOutputs?: string[];
  // D.3d.5 commit 1 (closure) — the step's declared artifact cardinality.
  // Absent = unconstrained: the transport must not impose a one-artifact law
  // that the step's own contract does not state.
  expectedArtifacts?: number;
  // D.3d.5 commit 1 — the result transport owns serialization: syntax
  // teaching, extraction, and bounded format repair. Defaults to the
  // textual SLE-OUTPUT fallback (the only transport any current provider
  // genuinely has); structured adapters plug in here.
  resultTransport?: ResultTransport;
  // D.34 C1 — the generic result-acceptance callback (DDR-034 §5.3),
  // composed by the AgentRunner from the step's declared output contract.
  // Deliberately a PLAIN structural type: this loop never imports contracts,
  // methodology, or the runner — its knowledge is exactly "call it; on
  // { ok: false } continue the conversation with the given instruction,
  // budget permitting (MAX_RESULT_REPAIRS)." Absent for legacy/materialized
  // steps, whose behavior is unchanged.
  acceptResult?: (value: unknown) => { ok: true } | { ok: false; repairInstruction: string };
  // D.34 C1 — runner-generated schema projections (from the step's declared
  // output contract), surfaced to the transport via TransportContext.
  // Absent = legacy path. Transports consume them verbatim.
  resultSchemaText?: string;
  resultSchemaJson?: Record<string, unknown>;
  // E10/A3 — enable the bounded transport retry: ONE re-issue of the SAME
  // failed inference request when it dies with undici HeadersTimeoutError.
  // A capability flag, not a policy engine — the CALLER decides scope
  // (production composition: define-work step executions only). Absent =
  // historical fail-fast behavior, byte-for-byte.
  transportRetry?: boolean;
}

export interface AgentLoopResult {
  success: boolean;
  parsedOutput?: ParsedOutput;
  // D.34 C1 — set instead of parsedOutput when the transport produced a
  // semantic proposal (kind 'proposal') that the result acceptor approved.
  // The runner decodes it against the workflow-declared contract.
  proposal?: { value: unknown };
  turns_taken: number;
  tokens_used: number;
  // E3a — set on FAILURE only: a bounded observation of the last provider
  // turn, so a failed step's evidence explains itself (C7/F6: the raw
  // node output must never be silently replaced with an empty string when
  // the failure is exactly what needs diagnosing). Lengths and names only —
  // never reply text, never hidden reasoning text.
  failure_observation?: {
    result_transport: string;
    turns_taken: number;
    format_repairs: number;
    result_repairs: number;
    stop_reason: string;
    text_length: number;
    tool_calls: Array<{ tool: string; path: string; turn: number }>;
    tool_uses: Array<{ name: string; argument_bytes: number }>;
    error: string;
    // E8/A2 preflight (Pilot A E7) — evidence-only, bounded cause metadata
    // for a failed provider CALL (names/codes/duration; never payloads or
    // reply text). Pilot A r1/r4 recorded nothing but "fetch failed".
    transport_failure?: {
      duration_ms: number;
      error_name: string;
      error_code?: string;
      cause_name?: string;
      cause_code?: string;
      cause_message?: string;
    };
    // E8/A2 preflight (Pilot A E7) — bounded description of the last
    // contract-rejected submission: argument_bytes is the UTF-8 byte size of
    // the COMPACT normalized JSON serialization of the rejected value, and
    // repair_instruction is the instruction as issued. The value itself is
    // the transport-parsed semantic value — NOT original provider/wire
    // bytes — and travels separately via rejected_result_payload.
    rejected_result?: { argument_bytes: number; repair_instruction: string };
  };
  // E8/A2 preflight (Pilot A E7) — the normalized rejected semantic payload:
  // the transport-parsed submission/produce value, JSON-serialized (compact).
  // This is NOT a capture of original provider/wire bytes. Persisted by the
  // runner as a sibling file on the failure path so contract rejections
  // remain diagnosable (attempt 5 lost the value entirely).
  rejected_result_payload?: string;
  // D.3d.5 commit 1 — bounded format-repair attempts, tracked separately
  // from ordinary turns so diagnostics never imply a repair happened when
  // only ordinary tool/answer turns occurred. Exact semantics (shared with
  // the single-turn path): turns_taken = total provider invocations by this
  // loop (INCLUDING repair-prompted ones); format_repairs = provider
  // invocations initiated specifically by a transport-format repair prompt.
  format_repairs: number;
  // D.34 C1 — contract decode/validate repair attempts, tracked separately
  // from format repairs (the repair taxonomy has three layers: format
  // repair / result repair / workflow refine). A result repair NEVER
  // consumes a workflow refinement iteration.
  result_repairs: number;
  error?: string;
  rawText?: string;
  // E23 — synthesis-boundary compaction evidence: bounded metadata only
  // (byte totals, counts, elided paths + sha256). Never carries payloads.
  // Present only when a gated step with a read-result budget reached the
  // synthesis transition.
  context_compaction?: SynthesisCompactionRecord;
  // E10/A3 — bounded transport-retry observability, present ONLY when the
  // retry policy fired. Records the first attempt's bounded cause, the
  // retried request's duration, and the final outcome, so a retried call is
  // always distinguishable from an un-retried one in evidence. Never carries
  // request payloads, reply text, or credentials.
  transport_retry?: {
    attempts: number;
    first_failure: { duration_ms: number; cause_code?: string };
    retried_request_ms: number;
    outcome: 'succeeded' | 'failed';
  };
}

// ─── AgentLoop ────────────────────────────────────────────────────────────────

// E10/A3 — explicit non-optional shape (the indexed optional property type
// otherwise carries `| undefined` into every reader).
export interface TransportFailureInfo {
  duration_ms: number;
  error_name: string;
  error_code?: string;
  cause_name?: string;
  cause_code?: string;
  cause_message?: string;
}

// E8/A2 preflight (Pilot A E7) — bounded, evidence-only cause extraction for
// a failed provider call: names, codes, and the undici cause chain only —
// never request/response payloads or reply text. "fetch failed" alone left
// Pilot A unable to distinguish timeout, reset, or server error.
function describeTransportFailure(
  err: unknown,
  durationMs: number,
): TransportFailureInfo {
  const e = err as {
    name?: string; code?: string;
    cause?: { name?: string; code?: string; message?: string; cause?: { code?: string } };
  };
  const cause = e.cause;
  // Compose the cause-code chain from DEFINED codes only — an absent outer
  // code must never surface as "undefined:<inner>" (evidence correctness).
  const causeCodes = [cause?.code, cause?.cause?.code].filter(
    (c): c is string => typeof c === 'string' && c.length > 0,
  );
  return {
    duration_ms: durationMs,
    error_name: e.name ?? 'unknown',
    ...(e.code ? { error_code: e.code } : {}),
    ...(cause
      ? {
          cause_name: cause.name,
          ...(causeCodes.length > 0 ? { cause_code: causeCodes.join(':') } : {}),
          ...(cause.message ? { cause_message: cause.message } : {}),
        }
      : {}),
  };
}

// E10/A3 — the ONLY retry-eligible transport failure: undici HeadersTimeout
// (UND_ERR_HEADERS_TIMEOUT), checked against the already-extracted cause-code
// chain (single extraction — eligibility and evidence can never diverge).
function isHeadersTimeoutFailure(f: { cause_code?: string }): boolean {
  return (
    typeof f.cause_code === 'string' && f.cause_code.split(':').includes('UND_ERR_HEADERS_TIMEOUT')
  );
}

export class AgentLoop {
  private fs: typeof nodeFsPromises;
  // D.3d.5 commit 1 — result transport (serialization ownership seam).
  private transport: ResultTransport;
  private transportCtx: TransportContext;

  constructor(
    private provider: IMultiTurnProvider,
    private opts: AgentLoopOptions
  ) {
    this.fs = opts.fsModule ?? nodeFsPromises;
    // D.3d.5 commit 1 (closure) — full real metadata on the multi-turn path,
    // mirroring the single-turn context the runner builds.
    this.transportCtx = {
      role: opts.role,
      requiresReviewVerdict: false,
      execution: 'multi-turn',
      nodeId: opts.nodeId,
      declaredArtifactId: opts.declaredArtifactId,
      declaredOutputPath: opts.declaredOutputPath,
      expectedArtifacts: opts.expectedArtifacts,
      // E26 — the step's authorized output set (teaching input).
      ...(opts.authorizedOutputs?.length ? { authorizedOutputs: opts.authorizedOutputs } : {}),
      // D.34 C1 — runner-generated projections; absent on the legacy path.
      ...(opts.resultSchemaText !== undefined ? { resultSchemaText: opts.resultSchemaText } : {}),
      ...(opts.resultSchemaJson !== undefined ? { resultSchemaJson: opts.resultSchemaJson } : {}),
    };
    // D.3d.5 commit 1 — result transport (serialization ownership seam).
    // D.34 C5 — negotiation: a schema-carrying step (registered output
    // contract) on this genuinely multi-turn path negotiates the
    // submit-result tool channel; everything else stays textual.
    this.transport = resolveResultTransport(provider, opts.resultTransport, {
      resultSchemaJson: opts.resultSchemaJson,
    });
  }

  async run(system: string, userMessage: string): Promise<AgentLoopResult> {
    // D.3d.5 commit 1 — transport syntax is taught BY THE TRANSPORT, injected
    // here, never by workflow methodology text. Appended once, up front.
    const transportInstruction = this.transport.formatInstruction(this.transportCtx);
    const messages: MultiTurnMessage[] = [
      { role: 'user', content: `${userMessage}\n\n${transportInstruction}` },
    ];
    let totalTokens = 0;
    let turns = 0;
    let formatRepairs = 0;
    // D.34 C1 — contract decode/validate repair attempts (separate budget
    // and counter from format repairs; never a workflow iteration).
    let resultRepairs = 0;
    const toolCallLog: Array<{ tool: string; path: string; turn: number }> = [];

    // D.3b1 — the tracked-file set is computed once per run (not once per
    // tool call) and reused for every read_file/list_directory invocation
    // below, so a run's read authority is fixed for its own duration.
    const trackedFiles = new Set(
      await (this.opts.listTrackedFiles ?? listGitTrackedFiles)(this.opts.projectRoot),
    );

    // D.34 C5 — the tools offered this turn: the read tools, plus the
    // result-submission tool when the negotiated transport provides one
    // (schema-carrying contract steps). Absent on every legacy path.
    const submissionTool = this.transport.resultSubmissionTool?.(this.transportCtx);
    // E21 — with the two-phase convergence gate, the tool set becomes
    // PER-TURN: investigation turns offer the full set; synthesis turns
    // offer ONLY the result-submission channel (repository read tools are
    // withdrawn at the protocol level — the requests themselves no longer
    // carry them — never by ignoring or faking results). Without the gate
    // this is the exact legacy set, computed once, as before.
    const fullTools = submissionTool ? [...AGENT_TOOLS, submissionTool] : [...AGENT_TOOLS];
    const synthesisOnlyTools = submissionTool ? [submissionTool] : [];
    const repositoryToolNames = new Set(AGENT_TOOLS.map(t => t.name as string));
    const synthesisGate = this.opts.synthesisGate;
    let synthesisAnnounced = false;
    // E23 — set once at the synthesis transition; carried on the result and
    // the persisted turn metadata so the compaction is auditable per run.
    let contextCompaction: SynthesisCompactionRecord | null = null;
    // E3a — the most recent provider turn, in bounded observation form.
    // Set after every provider call; attached by fail() so a failed step's
    // evidence explains itself (never reply text, never reasoning text).
    let lastObservation: NonNullable<AgentLoopResult['failure_observation']> | undefined;
    // E8/A2 preflight (Pilot A E7) — evidence-only failure metadata, kept
    // across turns so any later failure (turn cap, repair exhaustion) still
    // carries the last provider-call failure and the last rejected
    // submission with it.
    let lastTransportFailure: NonNullable<AgentLoopResult['failure_observation']>['transport_failure'];
    let lastRejected: NonNullable<AgentLoopResult['failure_observation']>['rejected_result'];
    let lastRejectedPayload: string | undefined;
    // E10/A3 — bounded transport-retry state, function-scoped: the ONE-retry
    // budget spans the whole step execution, and the record must survive to
    // whichever return fires (success or fail).
    let headersTimeoutRetries = 0;
    let transportRetry: AgentLoopResult['transport_retry'];
    const fail = (error: string): AgentLoopResult => ({
      success: false,
      turns_taken: turns,
      tokens_used: totalTokens,
      format_repairs: formatRepairs,
      result_repairs: resultRepairs,
      error,
      ...(lastObservation || lastTransportFailure || lastRejected
        ? {
            failure_observation: {
              ...(lastObservation ?? {
                result_transport: this.transport.name,
                turns_taken: turns,
                format_repairs: formatRepairs,
                result_repairs: resultRepairs,
                stop_reason: 'provider_error',
                text_length: 0,
                tool_calls: [],
                tool_uses: [],
              }),
              error,
              ...(lastTransportFailure ? { transport_failure: lastTransportFailure } : {}),
              ...(lastRejected ? { rejected_result: lastRejected } : {}),
            },
          }
        : {}),
      ...(lastRejectedPayload ? { rejected_result_payload: lastRejectedPayload } : {}),
      ...(transportRetry ? { transport_retry: transportRetry } : {}),
      ...(contextCompaction ? { context_compaction: contextCompaction } : {}),
    });

    while (turns < MAX_AGENT_TURNS) {
      turns++;
      // E21 — one-way phase transition: on the FIRST synthesis turn, append
      // the synthesis instruction as a user turn so the same request that
      // stops offering read tools also carries the instruction to produce
      // the contracted artifact now. Once only — never re-announced.
      if (synthesisGate && turns > synthesisGate.thresholdTurns && !synthesisAnnounced) {
        synthesisAnnounced = true;
        // E23 — synthesis-boundary compaction: compact OLD read_file payloads
        // per the frozen newest-first byte budget BEFORE the synthesis
        // instruction is appended. Investigation turns are byte-for-byte
        // unchanged; without a budget this never runs.
        if (synthesisGate.readResultBudgetBytes !== undefined) {
          contextCompaction = compactReadHistoryForSynthesis(messages, synthesisGate.readResultBudgetBytes);
        }
        messages.push({ role: 'user', content: SYNTHESIS_PHASE_INSTRUCTION });
      }
      let result: MultiTurnResult;
      // E8/A2 preflight — per-call timing so a provider failure records how
      // long the failed request ran before dying (Pilot A: NOT PERSISTED).
      const callStartedAt = Date.now();
      // E10/A3 — the request object is built ONCE per turn: the retry (when
      // eligible) re-issues byte-identical parameters by construction, not
      // by reconstruction.
      const multiTurnParams = {
        model: this.opts.model,
        system,
        messages: [...messages], // snapshot to avoid reference aliasing
        max_tokens: this.opts.max_tokens ?? 4096,
        // E3b — sampling parity across wires.
        ...(this.opts.temperature !== undefined && { temperature: this.opts.temperature }),
        // E21 — the tool set is computed PER TURN under the synthesis gate:
        // investigation turns offer the full set, synthesis turns offer only
        // the result channel. Without the gate this is the exact legacy set
        // every turn (fullTools === the old static list).
        tools: synthesisGate && turns > synthesisGate.thresholdTurns ? synthesisOnlyTools : fullTools,
      };
      try {
        result = await this.provider.completeMultiTurn(multiTurnParams);
      } catch (err) {
        const failure = describeTransportFailure(err, Date.now() - callStartedAt);
        if (
          this.opts.transportRetry === true &&
          isHeadersTimeoutFailure(failure) &&
          headersTimeoutRetries < MAX_HEADERS_TIMEOUT_RETRIES
        ) {
          headersTimeoutRetries++;
          const retryStartedAt = Date.now();
          try {
            result = await this.provider.completeMultiTurn(multiTurnParams);
            transportRetry = {
              attempts: 1,
              first_failure: {
                duration_ms: failure.duration_ms,
                ...(failure.cause_code ? { cause_code: failure.cause_code } : {}),
              },
              retried_request_ms: Date.now() - retryStartedAt,
              outcome: 'succeeded',
            };
            // Retry succeeded: the turn continues with this result. The
            // failed attempt never produced a turn — the retry re-entered
            // the SAME turn slot (no extra model turn, no repair
            // consumption); already-executed tool results are part of
            // `messages` and were never re-run (no tool replay).
          } catch (retryErr) {
            const retryFailure = describeTransportFailure(retryErr, Date.now() - retryStartedAt);
            lastTransportFailure = retryFailure;
            transportRetry = {
              attempts: 1,
              first_failure: {
                duration_ms: failure.duration_ms,
                ...(failure.cause_code ? { cause_code: failure.cause_code } : {}),
              },
              retried_request_ms: Date.now() - retryStartedAt,
              outcome: 'failed',
            };
            return fail(
              `LLM call failed after transport retry: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
            );
          }
        } else {
          lastTransportFailure = failure;
          return fail(`LLM call failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // E3a — bounded observation of THIS turn (names and byte lengths only;
      // Buffer.byteLength so multi-byte payloads count real bytes, not
      // UTF-16 code units).
      lastObservation = {
        result_transport: this.transport.name,
        turns_taken: turns,
        format_repairs: formatRepairs,
        result_repairs: resultRepairs,
        stop_reason: result.stop_reason,
        text_length: Buffer.byteLength(result.text ?? '', 'utf8'),
        tool_calls: [...toolCallLog],
        tool_uses: (result.tool_uses ?? []).map((tu) => ({
          name: tu.name,
          argument_bytes: Buffer.byteLength(JSON.stringify(tu.input ?? {}), 'utf8'),
        })),
        error: '',
      };

      totalTokens += result.tokens_used;

      if (result.stop_reason === 'max_tokens') {
        return fail('Agent exhausted max_tokens without producing a result block');
      }

      if (result.stop_reason === 'tool_use') {
        // D.34 C5 — evaluate a result submission FIRST (the negotiated tool
        // channel). The transport returns undefined for a plain read-tool
        // turn (ordinary handling proceeds below), a proposal for exactly
        // one submit call, or a TransportParseError for a malformed
        // submission turn (e.g. cardinality > 1 — the C4 fail-closed rule
        // on this channel too).
        if (this.transport.extractToolSubmission) {
          let submission: StepResult | undefined;
          try {
            submission = this.transport.extractToolSubmission(result.tool_uses, this.transportCtx);
          } catch (err) {
            if (!(err instanceof TransportParseError)) {
              return fail(`Output parsing failed: ${err instanceof Error ? err.message : String(err)}`);
            }
            // Malformed submission turn: the tool protocol requires EVERY
            // tool_use to be answered, so each gets the repair instruction
            // as its tool_result, then the bounded format-repair budget
            // applies (shared policy — never a workflow iteration).
            if (repairDecision(formatRepairs).action === 'fail-closed') {
              return fail(formatRepairExhaustedDiagnostic(err, turns, formatRepairs));
            }
            formatRepairs++;
            messages.push({ role: 'assistant', content: result.tool_uses });
            messages.push({
              role: 'user',
              content: result.tool_uses.map((tu) => ({
                type: 'tool_result' as const,
                tool_use_id: tu.id,
                content: this.transport.repairInstruction(this.transportCtx, err.kind, err.reason),
              })),
            });
            continue;
          }
          if (submission !== undefined && submission.kind === 'proposal') {
            if (!this.opts.acceptResult) {
              return fail(
                `Transport produced a semantic proposal for declared artifact '${this.opts.declaredArtifactId ?? '(undeclared)'}' but no result acceptor is registered — authoring/negotiation error (fail closed)`,
              );
            }
            // D.34 C1 — the same runner-composed acceptor gates the
            // proposal; the ONLY difference from the textual channel is
            // the delivery of a rejection: a tool_result payload on this
            // channel (same conversation, same budget, same instruction).
            const acceptance = this.opts.acceptResult(submission.value);
            if (!acceptance.ok) {
              // E8/A2 preflight (Pilot A E7) — preserve the rejected
              // submission: bounded description here; the normalized rejected
              // semantic payload (compact JSON of the transport-parsed value —
              // not wire bytes) in rejected_result_payload, so the persisted
              // file's byte size equals argument_bytes (attempt 5 lost both).
              lastRejected = {
                argument_bytes: Buffer.byteLength(JSON.stringify(submission.value)),
                repair_instruction: acceptance.repairInstruction,
              };
              lastRejectedPayload = JSON.stringify(submission.value);
              if (resultRepairDecision(resultRepairs).action === 'fail-closed') {
                return fail(
                  resultRepairExhaustedDiagnostic(
                    this.opts.declaredArtifactId ?? '(undeclared)',
                    acceptance.repairInstruction,
                    turns,
                    resultRepairs,
                  ),
                );
              }
              resultRepairs++;
              messages.push({ role: 'assistant', content: result.tool_uses });
              messages.push({
                role: 'user',
                content: result.tool_uses.map((tu) =>
                  this.transport.toolRejectionTurn!(tu.id, acceptance.repairInstruction),
                ),
              });
              continue;
            }
            // E10/A3 — the accepted-submission return must carry the retry
            // record too: define-work succeeds through THIS branch, so a
            // retried-then-accepted Definition would otherwise lose its
            // retry evidence.
            await this.writeTurnMetadata(turns, toolCallLog, transportRetry, contextCompaction);
            return {
              success: true,
              proposal: { value: submission.value },
              turns_taken: turns,
              tokens_used: totalTokens,
              format_repairs: formatRepairs,
              result_repairs: resultRepairs,
              ...(transportRetry ? { transport_retry: transportRetry } : {}),
              ...(contextCompaction ? { context_compaction: contextCompaction } : {}),
              rawText: result.text,
            };
          }
        }
        // Append assistant tool_use turn, then handle tools and append results
        messages.push({ role: 'assistant', content: result.tool_uses });
        const resultBlocks: ToolResultBlock[] = [];
        for (const tu of result.tool_uses) {
          // E21 — protocol safety: a tool call naming a repository read
          // tool during the synthesis phase is a boundary violation. It is
          // NEVER executed and NEVER answered with a fabricated result; the
          // step fails closed with an explicit, auditable error.
          if (synthesisGate && turns > synthesisGate.thresholdTurns && repositoryToolNames.has(tu.name)) {
            return fail(
              `Synthesis-phase tool-protocol violation: model invoked withdrawn repository tool '${tu.name}' at turn ${turns} — failing closed (no execution, no fabricated result).`,
            );
          }
          const toolResult = await handleToolCall(
            tu.name as ToolName,
            tu.input,
            this.opts.projectRoot,
            this.fs,
            trackedFiles,
          );
          resultBlocks.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: toolResult.content,
          });
          toolCallLog.push({
            tool: tu.name,
            path: (tu.input as Record<string, string>)?.path ?? '',
            turn: turns,
          });
        }
        messages.push({ role: 'user', content: resultBlocks });
        continue;
      }

      // stop_reason === 'end_turn' — the transport owns turning the reply
      // into a StepResult, INCLUDING classifying non-compliance ('absent'
      // vs 'malformed'). The loop never inspects raw syntax itself.
      // D.3d.5 commit 1: a reply with NO result block at all now enters the
      // SAME bounded format-repair path as a malformed block (previously
      // absence failed immediately — the GPT-OSS failure mode — with
      // diagnostics that overstated the repair effort).
      let stepResult: StepResult;
      try {
        stepResult = this.transport.extractProduce(result.text, this.transportCtx);
      } catch (err) {
        if (!(err instanceof TransportParseError)) {
          return fail(`Output parsing failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        // D.3d.5 closure — the SAME bounded-repair policy as the single-turn
        // path (shared repairDecision + diagnostic; budget NOT raised).
        if (repairDecision(formatRepairs).action === 'fail-closed') {
          return fail(formatRepairExhaustedDiagnostic(err, turns, formatRepairs));
        }
        formatRepairs++;
        messages.push({ role: 'assistant', content: result.text });
        messages.push({ role: 'user', content: this.transport.repairInstruction(this.transportCtx, err.kind, err.reason) });
        continue;
      }

      // D.34 C1 — the result-repair seam (DDR-034 §5.3). A proposal-kind
      // result is gated by the runner-composed acceptor INSIDE this loop, so
      // a decode/validate defect continues the SAME conversation (textual
      // channel: assistant reply + user repair instruction, mirroring format
      // repair; a submit-result channel — C5 — will answer with a
      // tool_result rejection instead). Exhaustion fails the step closed
      // BEFORE anything is written; it never consumes a workflow iteration.
      if (stepResult.kind === 'proposal') {
        if (!this.opts.acceptResult) {
          return fail(
            `Transport produced a semantic proposal for declared artifact '${this.opts.declaredArtifactId ?? '(undeclared)'}' but no result acceptor is registered — authoring/negotiation error (fail closed)`,
          );
        }
        const acceptance = this.opts.acceptResult(stepResult.value);
        if (!acceptance.ok) {
          // E8/A2 preflight (Pilot A E7) — same rejected-submission evidence
          // on the textual channel (symmetric with the submit-result channel):
          // normalized rejected semantic payload, not wire bytes.
          lastRejected = {
            argument_bytes: Buffer.byteLength(JSON.stringify(stepResult.value)),
            repair_instruction: acceptance.repairInstruction,
          };
          lastRejectedPayload = JSON.stringify(stepResult.value);
          if (resultRepairDecision(resultRepairs).action === 'fail-closed') {
            return fail(
              resultRepairExhaustedDiagnostic(
                this.opts.declaredArtifactId ?? '(undeclared)',
                acceptance.repairInstruction,
                turns,
                resultRepairs,
              ),
            );
          }
          resultRepairs++;
          messages.push({ role: 'assistant', content: result.text });
          messages.push({ role: 'user', content: acceptance.repairInstruction });
          continue;
        }
      }

      // Write turn metadata to run artifacts
      await this.writeTurnMetadata(turns, toolCallLog, transportRetry, contextCompaction);

      // D.34 C1 — kind-split return: a proposal replaces parsedOutput; the
      // runner decodes it against the workflow-declared contract.
      if (stepResult.kind === 'proposal') {
        return {
          success: true,
          proposal: { value: stepResult.value },
          turns_taken: turns,
          tokens_used: totalTokens,
          format_repairs: formatRepairs,
          result_repairs: resultRepairs,
          rawText: result.text,
          ...(transportRetry ? { transport_retry: transportRetry } : {}),
          ...(contextCompaction ? { context_compaction: contextCompaction } : {}),
        };
      }
      return {
        success: true,
        // Backward-compatible shape for AgentRunner: artifacts + warnings.
        // E25 — warnings are the parse diagnostics (dropped sections);
        // the runner fails closed when zero usable sections survive.
        parsedOutput: {
          sections: stepResult.artifacts,
          warnings: stepResult.kind === 'materialized' ? (stepResult.warnings ?? []) : [],
          ...(stepResult.kind === 'materialized' && stepResult.patches?.length ? { patches: stepResult.patches } : {}),
        },
        turns_taken: turns,
        tokens_used: totalTokens,
        format_repairs: formatRepairs,
        result_repairs: resultRepairs,
        rawText: result.text,
        ...(transportRetry ? { transport_retry: transportRetry } : {}),
        ...(contextCompaction ? { context_compaction: contextCompaction } : {}),
      };
    }

    return fail(`Agent did not produce a result block within ${MAX_AGENT_TURNS} turns`);
  }

  private async writeTurnMetadata(
    turns_taken: number,
    tool_calls: Array<{ tool: string; path: string; turn: number }>,
    // E10/A3 — present only when the bounded transport retry fired; persisted
    // on the success path too, so a retried call is visible in evidence even
    // when the step ultimately succeeded.
    transportRetry?: AgentLoopResult['transport_retry'],
    // E23 — synthesis-boundary compaction evidence, persisted when the gate
    // carried a read-result budget and the transition ran.
    contextCompaction?: SynthesisCompactionRecord | null
  ): Promise<void> {
    try {
      const { workflowRunId, iteration, nodeId, runArtifacts } = this.opts;
      const metaDir = path.join(
        '.sle', 'runs', workflowRunId, String(iteration), 'node-outputs'
      );
      const metaPath = path.join(metaDir, `${nodeId.toLowerCase()}-loop.json`);
      const absMetaPath = path.join(this.opts.projectRoot, metaPath);
      await this.fs.mkdir(path.join(this.opts.projectRoot, metaDir), { recursive: true });
      await this.fs.writeFile(
        absMetaPath,
        // D.34 C5 — the negotiated result transport is part of the run
        // record: which wire actually carried the semantic result.
        JSON.stringify(
          {
            node_id: nodeId,
            result_transport: this.transport.name,
            turns_taken,
            tool_calls,
            ...(transportRetry ? { transport_retry: transportRetry } : {}),
            ...(contextCompaction ? { context_compaction: contextCompaction } : {}),
          },
          null,
          2,
        ),
        'utf-8'
      );
      await runArtifacts.updateNodeStatus(workflowRunId, iteration, nodeId, {
        status: 'running',
        turns_taken,
        tool_calls: tool_calls.length,
      } as never);
    } catch {
      // metadata write failures are non-fatal
    }
  }
}
