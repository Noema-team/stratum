// D.3d.5 commit 1 — the textual SLE-OUTPUT fallback transport.
//
// This module OWNS every textual wire shape the execution layer consumes:
//
//   multi-turn produce:   <<<SLE-OUTPUT>>> / '### <path>' sections /
//                         <<<END-SLE-OUTPUT>>>   (parseAgentOutputV3)
//   single-turn produce:  '<!-- SLE-OUTPUT' YAML preamble + '## <path>'
//                         headers                  (parseAgentOutput)
//   single-turn review:   same preamble shape, plus the `verdict:` line
//                         (and, during migration only, the legacy `route:`
//                         token — see extractLegacyReviewRoute)
//
// D.3d.5 review amendment: ownership must be TOTAL. AgentRunner consumes
// ONLY StepResult — it never sees (or knows about) YAML preambles, HTML
// comments, or delimiters. All raw-result extraction for both execution
// paths lives here, so a future structured/native transport can replace
// the wire format without touching the runner, the loop, or any workflow.
//
// Teaching is generated from ACTUAL step metadata (role, node id, declared
// artifact id/path) — no workflow-specific examples are hardcoded. Adding
// workflow #40 must not require touching this file.
//
// The shapes must never be taught to the same step — mixing them made a
// real model emit the wrong one (D.3d Layer B, first live failure) — so
// formatInstruction selects by TransportContext.execution and adds the
// verdict requirement only for review steps.
import yaml from 'js-yaml';
import type { AgentRole } from '../types.js';
import { parseAgentOutputV3, ParseError } from '../output-parser.js';
import {
  type ResultTransport,
  type StepResult,
  type TransportContext,
  TransportParseError,
} from './step-result.js';

export const SLE_OPEN = '<<<SLE-OUTPUT>>>';
export const SLE_CLOSE = '<<<END-SLE-OUTPUT>>>';
export const SLE_PREAMBLE_MARK = '<!-- SLE-OUTPUT';

// ─── Single-turn preamble parser (moved verbatim from agent-runner.ts; the
// ─── parser and the wire shape it accepts belong to the same owner) ──────────

export interface SLEOutputPreamble {
  role: string;
  node: string;
  artifacts: Array<{ id: string; path: string }>;
  // D.3b0 — optional semantic review verdict. Only meaningful (and only
  // validated) when the invoking step declares requiresReviewVerdict; loose
  // string type here because this is straight off yaml.load() before any
  // validation — see the verdict gate in AgentRunner.run().
  verdict?: string;
  // D.3c1a — optional bounded-routing token. Legacy during D.3d.5 migration:
  // never part of the canonical StepResult; read only via
  // extractLegacyReviewRoute to feed the interim allowlist gate until
  // commit 3 derives the route deterministically.
  route?: string;
}

export interface ParsedSingleTurnOutput {
  preamble: SLEOutputPreamble;
  sections: Array<{ path: string; content: string }>;
}

export function parseAgentOutput(raw: string, role: AgentRole): ParsedSingleTurnOutput {
  const preambleMatch = raw.match(/<!--\s*SLE-OUTPUT([\s\S]*?)-->/);
  if (!preambleMatch) {
    throw new Error('Missing SLE-OUTPUT preamble comment');
  }

  const preamble = yaml.load(preambleMatch[1].trim()) as SLEOutputPreamble;
  if (!preamble?.artifacts || !Array.isArray(preamble.artifacts)) {
    throw new Error('SLE-OUTPUT preamble missing artifacts list');
  }

  const afterPreamble = raw.slice(raw.indexOf('-->') + 3).trim();
  const sections =
    role === 'builder'
      ? parseBuilderSections(afterPreamble)
      : parseStandardSections(afterPreamble, preamble);

  return { preamble, sections };
}

// D.3d.5 commit 2 — CONCRETE INVARIANT FIX (documented transport exception):
// the canonical Definition artifact embeds YAML front matter delimited by
// `---` lines, which the legacy single-turn section separator (`---`) would
// swallow — a canonical artifact was physically unwritable through this
// path. A `---` line is therefore a section separator ONLY when it is not
// inside a front-matter block: a `---` immediately following the section's
// '## <path>' header OPENS front matter, and the next `---` CLOSES it.
// Legacy multi-section replies (separator between '## path' sections)
// behave byte-for-byte as before.
function splitStandardSections(body: string): string[] {
  const lines = body.split('\n');
  const out: string[] = [];
  let cur: string[] = [];
  let headerIdx = -1;       // index (in cur) of the current section's '## <path>' header
  let inFrontMatter = false;
  for (const line of lines) {
    if (/^-{3,}\s*$/.test(line)) {
      // content strictly AFTER the header line (the header itself is never content)
      const contentAfterHeader = (headerIdx >= 0 ? cur.slice(headerIdx + 1) : []).join('\n').replace(/^\n+/, '');
      if (!inFrontMatter && headerIdx >= 0 && contentAfterHeader === '') {
        // front-matter opener — content, not a separator
        inFrontMatter = true;
        cur.push(line);
        continue;
      }
      if (inFrontMatter) {
        // front-matter closer — content, not a separator
        inFrontMatter = false;
        cur.push(line);
        continue;
      }
      // genuine section separator
      out.push(cur.join('\n'));
      cur = [];
      headerIdx = -1;
      continue;
    }
    if (headerIdx === -1 && /^## /.test(line)) headerIdx = cur.length;
    cur.push(line);
  }
  out.push(cur.join('\n'));
  return out;
}

function parseStandardSections(
  body: string,
  preamble: SLEOutputPreamble
): Array<{ path: string; content: string }> {
  const rawSections = splitStandardSections(body);
  const results: Array<{ path: string; content: string }> = [];

  for (const raw of rawSections) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    const lines = trimmed.split('\n');
    const headerMatch = lines[0].trim().match(/^##\s+(.+)$/);
    if (!headerMatch) continue;

    const headerPath = headerMatch[1].trim();
    const artifact = preamble.artifacts.find(
      (a) => a.path === headerPath || a.path.endsWith(headerPath) || headerPath.endsWith(a.path)
    );
    if (!artifact) continue;

    results.push({ path: artifact.path, content: lines.slice(1).join('\n').trim() });
  }

  // Fallback: positional matching when headers don't match declared paths
  if (results.length === 0 && preamble.artifacts.length > 0) {
    const nonEmpty = rawSections.filter((s) => s.trim());
    for (let i = 0; i < Math.min(nonEmpty.length, preamble.artifacts.length); i++) {
      const lines = nonEmpty[i].trim().split('\n');
      const skip = lines[0].trim().startsWith('#') ? 1 : 0;
      results.push({
        path: preamble.artifacts[i].path,
        content: lines.slice(skip).join('\n').trim(),
      });
    }
  }

  return results;
}

function parseBuilderSections(body: string): Array<{ path: string; content: string }> {
  const results: Array<{ path: string; content: string }> = [];
  const fileHeaderRegex = /^## File:\s+(.+)$/gm;
  const matches: Array<{ filePath: string; headerStart: number; contentStart: number }> = [];

  let m: RegExpExecArray | null;
  while ((m = fileHeaderRegex.exec(body)) !== null) {
    matches.push({
      filePath: m[1].trim(),
      headerStart: m.index,
      contentStart: m.index + m[0].length,
    });
  }

  for (let i = 0; i < matches.length; i++) {
    const { filePath, contentStart } = matches[i];
    const nextStart = i + 1 < matches.length ? matches[i + 1].headerStart : body.length;
    const rawBlock = body.slice(contentStart, nextStart).trim();

    const fenceMatch = rawBlock.match(/^```(?:\w+)?\n([\s\S]*?)\n?```\s*$/);
    results.push({ path: filePath, content: fenceMatch ? fenceMatch[1] : rawBlock });
  }

  return results;
}

// ─── Teaching generation (metadata-driven — no workflow-specific examples) ────

function multiTurnFormatInstruction(ctx: TransportContext): string {
  // The single-artifact restriction is the STEP's output contract, not a
  // transport-wide law: impose it only when the step actually declares one
  // expected artifact; teach generically otherwise.
  const singleArtifact = ctx.expectedArtifacts === 1 || (ctx.expectedArtifacts === undefined && ctx.declaredOutputPath !== undefined);
  const examplePath = ctx.declaredOutputPath ?? '.sle/work/<workItemId>/<artifact>.md';
  return `OUTPUT FORMAT (mandatory — your reply is consumed by a machine):
End your final message with the artifact wrapped in exactly these literal delimiters, as ${
    singleArtifact
      ? `a single '### <path>' section whose path is the declared output artifact path named in the task:`
      : `one '### <path>' section per declared output artifact, each with its own declared path:`
  }

${SLE_OPEN}
### ${examplePath}
<the full artifact content>
${SLE_CLOSE}

- Use the declared output artifact path exactly as named in the task — never a path you
  invented.${singleArtifact ? '\n- Never emit more than one artifact section.' : ''}
- The delimiters are literal structural requirements: a reply without them cannot be parsed
  and fails the step regardless of content quality. Never reply in prose alone, in any other
  comment or preamble style, or with any wrapper other than these exact delimiters.`;
}

function singleTurnFormatInstruction(ctx: TransportContext): string {
  const roleLine = `role: ${ctx.role}`;
  const nodeLine = `node: ${ctx.nodeId ?? '<this step\'s id, shown in Current State above>'}`;
  const artifactId = ctx.declaredArtifactId ?? 'artifact';
  const artifactPath = ctx.declaredOutputPath ?? '.sle/work/<workItemId>/<artifact>.md';
  const verdictBlock = ctx.requiresReviewVerdict
    ? `verdict: pass
-->
`
    : `-->
`;
  const verdictRequirement = ctx.requiresReviewVerdict
    ? `
- The preamble must carry 'verdict: pass' or 'verdict: fail' — never omit the verdict line —
  plus a 'route: <token>' line chosen from the routing contract above when, and only when,
  the verdict is fail.`
    : '';
  return `OUTPUT FORMAT (mandatory — your reply is consumed by a machine):
Begin your reply with an HTML-comment YAML preamble, then give the artifact body under a
'## <path>' header matching the declared output artifact path named in the task:

${SLE_PREAMBLE_MARK}
${roleLine}
${nodeLine}
artifacts:
  - id: ${artifactId}
    path: ${artifactPath}
${verdictBlock}
## ${artifactPath}

<the full artifact content>${verdictRequirement}

- The preamble comment and the '## <path>' header are literal structural requirements: a
  reply without them cannot be parsed and fails the step regardless of content quality.`;
}

// ─── The transport ────────────────────────────────────────────────────────────

export class TextualSleOutputTransport implements ResultTransport {
  readonly name = 'textual-sle-output';

  formatInstruction(ctx: TransportContext): string {
    if (ctx.execution === 'multi-turn') return multiTurnFormatInstruction(ctx);
    return singleTurnFormatInstruction(ctx);
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
    let sections: Array<{ path: string; content: string }>;
    try {
      sections = parseAgentOutputV3(raw, ctx.role).sections;
    } catch (err) {
      if (err instanceof ParseError) {
        throw new TransportParseError(err.message, raw, err.message, 'malformed');
      }
      throw err;
    }
    return { artifacts: sections };
  }

  extractSingleTurn(raw: string, ctx: TransportContext): StepResult {
    // D.3d.5 closure — preserve the absent-vs-malformed taxonomy on THIS
    // path too (matching extractProduce): no preamble marker at all is
    // 'absent'; a preamble that exists but cannot be parsed is 'malformed'.
    if (!raw.includes(SLE_PREAMBLE_MARK)) {
      throw new TransportParseError(
        'Missing SLE-OUTPUT preamble comment',
        raw,
        'the reply contained no recognizable result block',
        'absent',
      );
    }
    let parsed: ParsedSingleTurnOutput;
    try {
      parsed = parseAgentOutput(raw, ctx.role);
    } catch (err) {
      throw new TransportParseError(
        err instanceof Error ? err.message : String(err),
        raw,
        err instanceof Error ? err.message : String(err),
        'malformed',
      );
    }
    const verdict = parsed.preamble.verdict;
    return {
      artifacts: parsed.sections,
      ...(verdict === 'pass' || verdict === 'fail' ? { review: { verdict } } : {}),
    };
  }

  repairInstruction(ctx: TransportContext, kind: 'absent' | 'malformed', reason?: string): string {
    // Both kinds teach the representation the ACTIVE execution path parses —
    // never cross-teach (a single-turn preamble reply must not be repaired
    // with multi-turn delimiter instructions, or vice versa).
    const shape = ctx.execution === 'multi-turn'
      ? ` (${SLE_OPEN} ... ${SLE_CLOSE} around a '### <path>' section)`
      : ` (an '${SLE_PREAMBLE_MARK} ... -->' HTML-comment YAML preamble followed by a '## <path>' body header)`;
    if (kind === 'absent') {
      return (
        'Your reply did not contain the required machine-readable output block, so it cannot be ' +
        'consumed. Re-emit your reply with the artifact wrapped in the exact structure taught in ' +
        `the OUTPUT FORMAT instructions${shape}. ` +
        'No prose, comment style, or other wrapper can be parsed.'
      );
    }
    return (
      `The previous output was not parseable. Reason: ${reason}\n` +
      'Please reformat your response following the OUTPUT FORMAT instructions exactly' +
      `${shape}.`
    );
  }
}

// ─── Legacy route extraction (DEPRECATED — removed in commit 3) ──────────────
//
// D.3d.5 amendment: `route` must cease being model authority. Until commit 3
// derives the route deterministically from validated gap classifications,
// the legacy textual `route:` token still flows through the existing
// D.3c1a allowlist gate UNCHANGED so semantic workflow behavior does not
// move in this commit. It is deliberately NOT part of StepResult; the
// runner reads it via this deprecated helper only to feed the interim gate.

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
