// D.34 C5 — the submit-result transport (DDR-034 §6): the PREFERRED
// side-effect-free return channel for multi-turn contract steps. The model
// investigates with the read tools as usual, then submits its complete
// semantic result as the input of ONE `submit_result` tool call, whose
// input schema is the workflow-declared contract's generated projection
// (TransportContext.resultSchemaJson — the runner built it from the
// registered OutputContract; this transport never learns what a Definition
// is).
//
// THE C5 GATE: changing from textual proposal submission to submit_result
// changes ONLY the wire. Decoding (zod, runner-composed acceptor),
// methodology validation, materialization, route derivation, provenance,
// and the repair budgets are all untouched — this class produces the very
// same StepResult { kind: 'proposal', value } the textual channel does, and
// delivers a rejection as a tool_result payload instead of a user turn.
// Nothing downstream of the transport can tell which wire was used.
//
// Negotiation (resolveResultTransport in textual-sle-output.ts) selects
// this transport ONLY when the provider genuinely supports the multi-turn
// tool loop AND the step's contract projected a schema; the textual
// proposal channel (C3/C4) remains the fallback everywhere else, and an
// explicit transport override always wins.
import {
  type ResultTransport,
  type StepResult,
  type TransportContext,
  type ResultToolDef,
  type TransportToolUse,
  type TransportToolResultBlock,
  TransportParseError,
  SUBMIT_RESULT_TOOL_NAME,
} from './step-result.js';
import { extractJsonPayload } from './textual-sle-output.js';

export class SubmitResultTransport implements ResultTransport {
  readonly name = 'submit-result';

  // ─── Teaching ───────────────────────────────────────────────────────────────

  formatInstruction(ctx: TransportContext): string {
    // The tool's input schema reaches the model natively through the tools
    // list; the schema TEXT is still embedded so the structured annotations
    // (field semantics) ride along. No textual-envelope syntax is taught —
    // on this channel the final text is never the result.
    return `RESULT SUBMISSION (mandatory — your result is consumed by a machine):
When your work is done, submit your complete semantic result by calling the
${SUBMIT_RESULT_TOOL_NAME} tool EXACTLY ONCE, with one JSON object as its input. Do not put
the result in your final text, and do not emit any file content, paths, or verdict line —
the system serializes the artifact itself from your submission.

${ctx.resultSchemaText}

- Call ${SUBMIT_RESULT_TOOL_NAME} exactly once, with the complete result — every field shown
  in the shape is required unless explicitly optional.
- Investigate using read tools on EARLIER turns. When finished, call
  ${SUBMIT_RESULT_TOOL_NAME} exactly once as the ONLY tool call in that turn.
- A reply that ends without a ${SUBMIT_RESULT_TOOL_NAME} call cannot be consumed and fails
  the step regardless of content quality.`;
  }

  // On this transport the final text is NEVER the result: an end_turn
  // without a submission is an 'absent' result block and enters the same
  // bounded format repair as any other non-compliance (the loop calls this
  // on end_turn only).
  extractProduce(raw: string, _ctx: TransportContext): StepResult {
    throw new TransportParseError(
      `Reply ended without a ${SUBMIT_RESULT_TOOL_NAME} tool call`,
      raw,
      `the reply ended without a ${SUBMIT_RESULT_TOOL_NAME} call — submit the complete semantic result through the ${SUBMIT_RESULT_TOOL_NAME} tool`,
      'absent',
    );
  }

  // Kept for interface completeness (single-turn steps never negotiate this
  // transport — negotiation requires a multi-turn provider): the single-turn
  // textual channel is not the wire here.
  extractSingleTurn(raw: string, _ctx: TransportContext): StepResult {
    throw new TransportParseError(
      'submit-result transport negotiated on a non-multi-turn path',
      raw,
      'negotiation error — the submit-result channel is a multi-turn tool channel',
      'malformed',
    );
  }

  repairInstruction(_ctx: TransportContext, kind: 'absent' | 'malformed', reason?: string): string {
    return (
      `Your reply could not be consumed (${kind}). Reason: ${reason ?? `no ${SUBMIT_RESULT_TOOL_NAME} call`}\n` +
      `Reply again and submit your complete result by calling the ${SUBMIT_RESULT_TOOL_NAME} tool ` +
      'EXACTLY ONCE, with one JSON object matching the RESULT SHAPE taught above as its input. ' +
      'Do not put the result in your final text. The system serializes the artifact itself ' +
      'from your submission.'
    );
  }

  // ─── The tool channel ───────────────────────────────────────────────────────

  resultSubmissionTool(ctx: TransportContext): ResultToolDef | undefined {
    if (ctx.resultSchemaJson === undefined) return undefined;
    return {
      name: SUBMIT_RESULT_TOOL_NAME,
      description:
        'Submit the complete semantic result for this step. Call exactly once, with one ' +
        'JSON object matching this schema as input. Never put the result in your final text.',
      input_schema: ctx.resultSchemaJson,
    };
  }

  extractToolSubmission(
    toolUses: readonly TransportToolUse[],
    ctx: TransportContext,
  ): StepResult | undefined {
    const submissions = toolUses.filter((tu) => tu.name === SUBMIT_RESULT_TOOL_NAME);
    if (submissions.length === 0) return undefined; // a plain read-tool turn
    // Fail-closed cardinality (the C4 rule, on the tool channel): competing
    // semantic results are never silently resolved by the transport.
    if (submissions.length > 1) {
      throw new TransportParseError(
        `Multiple ${SUBMIT_RESULT_TOOL_NAME} calls in one turn`,
        JSON.stringify(toolUses),
        `the turn carried ${submissions.length} ${SUBMIT_RESULT_TOOL_NAME} calls — submit EXACTLY ONE result per step`,
        'malformed',
      );
    }
    // D.34 C5 review closure — submit_result is TERMINAL and EXCLUSIVE for
    // its turn: a turn that both requests more information (a read tool)
    // and declares the final authoritative result is contradictory, and a
    // proposal that drives canonical system state must never be accepted
    // while a co-declared investigation request is silently ignored. The
    // malformed → format-repair path answers every tool_use, the model
    // investigates on a clean read-only turn, and submits alone when done.
    if (toolUses.length !== 1) {
      throw new TransportParseError(
        `${SUBMIT_RESULT_TOOL_NAME} must be the only tool call in the final submission turn`,
        JSON.stringify(toolUses),
        `the submission turn carried ${toolUses.length} tool calls — investigate with read tools on EARLIER turns, then call ${SUBMIT_RESULT_TOOL_NAME} alone`,
        'malformed',
      );
    }
    const input = submissions[0].input;
    if (typeof input === 'string') {
      // Some models stringify the payload despite the structured schema —
      // same JSON tolerance the textual channel has.
      return { kind: 'proposal', value: extractJsonPayload(input) };
    }
    if (ctx.resultSchemaJson === undefined) {
      // Negotiation guarantees a schema on this transport; defense in depth.
      throw new TransportParseError(
        'Submission negotiated without a result schema',
        JSON.stringify(toolUses),
        'negotiation error — no result schema projected for this step',
        'malformed',
      );
    }
    return { kind: 'proposal', value: input };
  }

  toolRejectionTurn(toolUseId: string, repairInstruction: string): TransportToolResultBlock {
    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: repairInstruction,
    };
  }
}
