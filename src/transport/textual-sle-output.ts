// D.3d.5 commit 1 — the textual SLE-OUTPUT fallback transport.
//
// This module OWNS the two textual wire shapes that workflow methodology
// used to teach (moved verbatim in spirit from the former
// PRODUCE_OUTPUT_FORMAT_CONTRACT / REVIEW_OUTPUT_FORMAT_CONTRACT):
//
//   multi-turn produce:   <<<SLE-OUTPUT>>> / '### <path>' sections /
//                         <<<END-SLE-OUTPUT>>>   (parsed by output-parser.ts)
//   single-turn produce:  '<!-- SLE-OUTPUT' YAML preamble + '## <path>'
//                         headers                  (parsed by agent-runner.ts)
//   single-turn review:   same preamble shape, plus the `verdict:` line
//                         (and, during migration only, the legacy `route:`
//                         token — see extractLegacyReviewRoute)
//
// The multi-turn and single-turn shapes must never be taught to the same
// step — mixing them made a real model emit the wrong one (D.3d Layer B,
// first live failure) — so formatInstruction selects by
// TransportContext.execution and adds the verdict requirement only for
// review steps.
//
// Extraction delegates to the existing parsers, so commit 1 changes
// transport OWNERSHIP, not the accepted syntax — semantic workflow behavior
// is unchanged.
import { parseAgentOutputV3, ParseError } from '../output-parser.js';
import type { ParsedOutput } from '../output-parser.js';
import type { SLEOutputPreamble } from '../agent-runner.js';
import {
  type ResultTransport,
  type StepResult,
  type TransportContext,
  TransportParseError,
} from './step-result.js';

export const SLE_OPEN = '<<<SLE-OUTPUT>>>';
export const SLE_CLOSE = '<<<END-SLE-OUTPUT>>>';
export const SLE_PREAMBLE_MARK = '<!-- SLE-OUTPUT';

const MULTI_TURN_FORMAT_INSTRUCTION = `OUTPUT FORMAT (mandatory — your reply is consumed by a machine):
End your final message with the artifact wrapped in exactly these literal delimiters, as a
single '### <path>' section whose path is the declared output artifact path named in the task:

${SLE_OPEN}
### .sle/work/<workItemId>/<artifact>.md
<the full artifact content>
${SLE_CLOSE}

- Use the declared output artifact path exactly as named in the task — never a path you
  invented, and never more than one artifact section.
- The delimiters are literal structural requirements: a reply without them cannot be parsed
  and fails the step regardless of content quality. Never reply in prose alone, in any other
  comment or preamble style, or with any wrapper other than these exact delimiters.`;

function singleTurnFormatInstruction(requiresReviewVerdict: boolean): string {
  return `OUTPUT FORMAT (mandatory — your reply is consumed by a machine):
Begin your reply with an HTML-comment YAML preamble, then give the artifact body under a
'## <path>' header matching the declared output artifact path named in the task:

${SLE_PREAMBLE_MARK}
role: explorer
node: <this step's id, shown in Current State above>
artifacts:
  - id: readiness
    path: .sle/work/<workItemId>/readiness.md
${requiresReviewVerdict ? 'verdict: pass\n-->\n' : '-->'}
## .sle/work/<workItemId>/readiness.md

<the full artifact content>${
    requiresReviewVerdict
      ? `\n\n- The preamble must carry 'verdict: pass' or 'verdict: fail' — never omit the verdict line —
  plus a 'route: <token>' line chosen from the routing contract above when, and only when,
  the verdict is fail.`
      : ''
  }

- The preamble comment and the '## <path>' header are literal structural requirements: a
  reply without them cannot be parsed and fails the step regardless of content quality.`;
}

export class TextualSleOutputTransport implements ResultTransport {
  readonly name = 'textual-sle-output';

  formatInstruction(ctx: TransportContext): string {
    if (ctx.execution === 'multi-turn') return MULTI_TURN_FORMAT_INSTRUCTION;
    return singleTurnFormatInstruction(ctx.requiresReviewVerdict);
  }

  extractProduce(raw: string, ctx: TransportContext): StepResult {
    if (!raw.includes(SLE_OPEN)) {
      throw new TransportParseError(
        `Missing ${SLE_OPEN} delimiter`,
        raw,
        'the reply contained no SLE-OUTPUT block',
        'absent',
      );
    }
    let parsed: ParsedOutput;
    try {
      parsed = parseAgentOutputV3(raw, ctx.role);
    } catch (err) {
      if (err instanceof ParseError) {
        throw new TransportParseError(err.message, raw, err.message, 'malformed');
      }
      throw err;
    }
    return { artifacts: parsed.sections.map((s) => ({ path: s.path, content: s.content })) };
  }

  repairInstruction(kind: 'absent' | 'malformed', reason?: string): string {
    if (kind === 'absent') {
      return (
        'Your reply did not contain the required machine-readable output block, so it cannot be ' +
        'consumed. Re-emit your reply with the artifact wrapped in the exact literal delimiters ' +
        `taught in the OUTPUT FORMAT instructions (${SLE_OPEN} ... ${SLE_CLOSE} around a '### <path>' ` +
        'section). No prose, comment style, or other wrapper can be parsed — only the exact delimiters.'
      );
    }
    return (
      `The previous output was not parseable. Reason: ${reason}\n` +
      'Please reformat your response using the exact SLE-OUTPUT block structure.'
    );
  }
}

// ─── Runner-side single-turn mapping ──────────────────────────────────────────
//
// agent-runner.ts performs the actual preamble parse (parseAgentOutput — it
// lives there to avoid a runtime import cycle) and maps the result into the
// canonical StepResult through this pure function. Type-only import above:
// no runtime cycle edge.

export function stepResultFromSingleTurnParse(parsed: {
  preamble?: SLEOutputPreamble;
  sections: Array<{ path: string; content: string }>;
}): StepResult {
  const verdict = parsed.preamble?.verdict;
  return {
    artifacts: parsed.sections,
    ...(verdict === 'pass' || verdict === 'fail' ? { review: { verdict } } : {}),
  };
}

// ─── Legacy route extraction (DEPRECATED — removed in commit 3) ──────────────
//
// D.3d.5 amendment: `route` must cease being model authority. Until commit 3
// derives the route deterministically from validated gap classifications,
// the legacy textual `route:` token still flows through the existing
// D.3c1a allowlist gate UNCHANGED so semantic workflow behavior does not
// move in this commit. It is deliberately NOT part of StepResult; the
// runner keeps reading it off the parsed preamble only to feed the interim
// gate, and this helper exists for that migration window.

export function extractLegacyReviewRoute(raw: string): string | undefined {
  const match = raw.match(/<!--\s*SLE-OUTPUT([\s\S]*?)-->/);
  if (!match) return undefined;
  const routeLine = match[1].split('\n').find((l) => l.trim().startsWith('route:'));
  return routeLine?.split(':')[1]?.trim() || undefined;
}

// ─── Transport resolution (the capability-order seam) ─────────────────────────
//
// Single wiring point for the D.3d.5 capability order:
//   1. provider-native structured output (no current provider implements it —
//      probing for a capability Stratum cannot genuinely use would fake support);
//   2. submit-result/tool-call mechanism (same status);
//   3. textual SLE-OUTPUT fallback (implemented — today's transport for every
//      provider).
// Future adapters plug in HERE, keyed on a provider capability probe, not on
// workflow configuration. An explicit transport override (tests, future
// structured adapters) always wins.
export function resolveResultTransport(_provider: unknown, override?: ResultTransport): ResultTransport {
  if (override) return override;
  return new TextualSleOutputTransport();
}

// Single definition site for the multi-turn result-block marker (exported
// for tests and future adapters; the loop itself never inspects raw syntax —
// the transport classifies non-compliance via TransportParseError.kind).
export function hasResultBlock(raw: string): boolean {
  return raw.includes(SLE_OPEN);
}
