// D.34 C2 — the Readiness output contract (DDR-034 §7): the semantic
// proposal the readiness reviewer owes Stratum, the zod schema that is the
// single structural authority for it, and the deterministic renderer that
// materializes the canonical readiness artifact bytes.
//
// Principle (DDR-034): models propose; Stratum materializes. The reviewer
// returns { verdict, gaps, bodyMarkdown } — pure semantic judgment. It does
// NOT author schemaVersion, front-matter delimiters, YAML, artifact paths,
// or any transport envelope. renderReadiness is the system's canonical-byte
// author; parseReadinessArtifact (readiness-artifact.ts) remains the load
// path for persisted / human-edited / cross-run artifacts and is unchanged.
//
// NOT registered in production yet — that is C3. This module proves the
// semantic contract and the canonical renderer independently (C2 scope,
// docs/developmentPlan/d34-output-contracts.md).
//
// Canonical persisted format is UNCHANGED (schemaVersion 1 + gaps front
// matter + Markdown body): the verdict is proposal-level control input to
// the verdict gate, never persisted state — exactly the split the current
// artifact format already has (the legacy preamble verdict was never part
// of the front matter either).
import { z } from 'zod';
import yaml from 'js-yaml';

import {
  READINESS_SCHEMA_VERSION,
  type ReadinessGap,
  deriveReviewRoute,
  parseReadinessArtifact,
} from './readiness-artifact.js';
import { GAP_CLASSIFICATION_PRECEDENCE } from './definition-readiness.js';
import {
  type ContractDefect,
  type OutputContract,
  type OutputContractContext,
} from '../contracts.js';

// ─── Semantic proposal (what the model owes Stratum) ──────────────────────────

export interface ReadinessProposal {
  /** Part of the semantic payload — one judgment, one encoding. */
  verdict: 'pass' | 'fail';
  /** The typed gap judgments. Control derivation consumes these directly. */
  gaps: ReadinessGap[];
  /** The human-facing review explanation (artifact body). */
  bodyMarkdown: string;
}

// ─── Zod schema — THE single structural authority ─────────────────────────────
//
// Projection-fidelity discipline (DDR-034 §5.1): provider-facing schemas use
// only projection-safe structural constraints; Zod decode is always the
// runtime authority. The non-empty-after-trim refinements below are
// deliberately NOT representable in JSON Schema — they stay enforced at
// decode, and their violation is a producer-result defect handled by the
// bounded result-repair seam (AgentRunner, MAX_RESULT_REPAIRS). No
// hand-maintained mirror schema is introduced.

/** Decode-authoritative, deliberately NOT projected (fidelity gap is fine). */
function nonEmptyAfterTrim(label: string) {
  return z
    .string()
    .refine((s) => s.trim().length > 0, {
      message: `${label} must be a non-empty, non-whitespace string`,
    });
}

export const READINESS_PROPOSAL_SCHEMA = z
  .object({
    verdict: z.enum(['pass', 'fail']),
    gaps: z.array(
      z.object({
        target: nonEmptyAfterTrim('gap target'),
        description: nonEmptyAfterTrim('gap description'),
        classification: z.enum(GAP_CLASSIFICATION_PRECEDENCE),
        reason: nonEmptyAfterTrim('gap reason'),
        closure: nonEmptyAfterTrim('gap closure').optional(),
      }),
    ),
    bodyMarkdown: z.string(),
  })
  // Unknown fields (e.g. a model-emitted schemaVersion or transport debris)
  // are producer-result defects — rejected at decode, never silently
  // stripped. The projection is unaffected (additionalProperties: false
  // either way); this only sharpens decode authority.
  .strict();

// ─── Deterministic canonical renderer (DDR-034 §10 invariants) ────────────────

/**
 * Pinned js-yaml dump options. Changing ANY of these — or bumping js-yaml —
 * requires regenerating the renderReadiness golden fixtures in the same
 * commit, with the byte diff reviewed (DDR-034 §10.8).
 */
const YAML_DUMP_OPTIONS = {
  indent: 2,
  lineWidth: 120,
  noRefs: true,
  sortKeys: false,
  quotingType: '"' as const,
  forceQuotes: false,
} as const;

/** Newline normalization is representation-level (§10.6), never content-level. */
function toLf(s: string): string {
  return s.replace(/\r\n?/g, '\n');
}

/**
 * The deterministic canonical bytes for a readiness proposal. PURE: same
 * proposal + static config → same bytes → same provenance hash. Injects
 * schemaVersion. No clock, no randomness, no fs, no env.
 *
 * Envelope (§10.7): `---\n` + YAML + `\n---\n`; exactly one blank line
 * between the closing `---` and a non-empty body; empty body → the artifact
 * ends at the closing `---` newline. Final newline policy: exactly one `\n`
 * at EOF (§10.6). Gap-entry key order: target, description, classification,
 * reason, closure (§10.2). Array order is the reviewer's semantic order —
 * never sorted, deduped, or reordered (§10.4). Model strings are never
 * trimmed or reflowed (§10.5) — only CRLF→LF and the final-newline policy
 * apply. Optional fields: `closure` omitted when absent; `gaps: []` is
 * meaningful and rendered explicitly on a pass with no gaps (§10.3).
 */
export function renderReadiness(proposal: ReadinessProposal, _ctx?: OutputContractContext): string {
  const gaps = proposal.gaps.map((g: ReadinessGap) => ({
    target: toLf(g.target),
    description: toLf(g.description),
    classification: g.classification,
    reason: toLf(g.reason),
    ...(g.closure !== undefined ? { closure: toLf(g.closure) } : {}),
  }));
  const front = yaml.dump(
    { schemaVersion: READINESS_SCHEMA_VERSION, gaps },
    YAML_DUMP_OPTIONS,
  );
  const body = toLf(proposal.bodyMarkdown);
  // §10.7: exactly one blank line between the closing `---` and a non-empty
  // body; empty body → the artifact ends at the closing `---` newline.
  // §10.6: exactly one `\n` at EOF (the only body mutation is newline-level:
  // CRLF→LF above and the final-newline policy here — content untouched).
  const bodyPart = body.length > 0 ? `\n\n${body.replace(/\n+$/, '')}\n` : '\n';
  return `---\n${front}---${bodyPart}`;
}

/**
 * Reload helper: rebuild a proposal from persisted canonical bytes. The
 * verdict is NOT part of the persisted format (see the module header), so
 * the caller supplies it — this is the load path's verdict source, exactly
 * where the transport preamble verdict lived pre-D.34. Used by round-trip /
 * stability tests now, and by artifact loading in future slices.
 */
export function readinessProposalFromPersisted(
  artifactText: string,
  verdict: 'pass' | 'fail',
): ReadinessProposal {
  const { readiness, body } = parseReadinessArtifact(artifactText);
  return {
    verdict,
    gaps: readiness.gaps.map((g) => ({ ...g })),
    // renderReadiness inserts exactly one blank line after the closing
    // `---` for a non-empty body; the parser consumes `---\n`, leaving that
    // blank line as the body's first character. Strip exactly it — the
    // precise inverse of the renderer's envelope, nothing more.
    bodyMarkdown: body.replace(/^\n/, ''),
  };
}

// ─── Deterministic methodology invariants (the C1 second validation layer) ────
//
// C2 review correction: the initial DDR sketch assumed "nothing else is
// mechanical" about the readiness proposal — implementation-time discovery
// showed the EXISTING methodology (READINESS_ROUTE_CONTRACT) already
// establishes cross-field invariants that zod's structural layer must NOT
// own. They are deterministic and belong exactly here — plain code over the
// decoded proposal, structured defects, never zod refinements
// (docs/developmentPlan/d34-output-contracts.md, C2 correction note):
//
//   READINESS_ROUTE_CONTRACT: "On verdict: fail … every blocking gap … each
//   with at least these fields: … closure: what resolving it (or, for DEFER,
//   recording the DEFERRED transition) would require."
//   "On verdict: pass, the front matter carries gaps: [] (or names no
//   unresolved gap)."
//
// Violations are producer-result defects: one bounded in-step result repair
// (MAX_RESULT_REPAIRS), never a workflow iteration; exhaustion fails closed
// before write.

export function validateReadinessProposal(proposal: ReadinessProposal): readonly ContractDefect[] {
  const defects: ContractDefect[] = [];
  if (proposal.verdict === 'pass' && proposal.gaps.length > 0) {
    defects.push({
      code: 'PASS_WITH_GAPS',
      message:
        `verdict 'pass' carries ${proposal.gaps.length} gap(s) — a pass means no unresolved gaps ` +
        `(the methodology requires gaps: [] on pass); either fail with classified gaps or revise the judgment`,
    });
  }
  if (proposal.verdict === 'fail' && proposal.gaps.length === 0) {
    defects.push({
      code: 'FAIL_WITHOUT_GAPS',
      message:
        "verdict 'fail' carries no gaps — a failing review must classify at least one gap " +
        '(CAN_RESOLVE, DEFER, HUMAN_DECISION, or EXPLORE_AS_WORK)',
    });
  }
  if (proposal.verdict === 'fail') {
    proposal.gaps.forEach((gap, index) => {
      if (gap.closure === undefined) {
        defects.push({
          code: 'GAP_CLOSURE_MISSING',
          ref: gap.target,
          message:
            `gap '${gap.target}' (entry ${index + 1}) has no closure — on a fail verdict EVERY gap must state ` +
            'what resolving it (or, for DEFER, recording the DEFERRED transition) requires',
        });
      }
    });
  }
  return defects;
}

// ─── The contract (hooks + renderer) ──────────────────────────────────────────

/**
 * The Readiness output contract. Identity is the registry key under which
 * the composition root registers it in C3 ('definition-readiness') — the
 * contract itself declares no identity (DDR-034 §5.1).
 */
export const READINESS_OUTPUT_CONTRACT: OutputContract<ReadinessProposal> = {
  modelSchema: READINESS_PROPOSAL_SCHEMA,

  schemaAnnotations: {
    root:
      'Judge readiness; classify every blocking gap; explain for a human. ' +
      'The system serializes the artifact itself — never emit YAML, front ' +
      'matter, paths, or schemaVersion.',
    fields: {
      '/verdict':
        "'pass' ONLY with zero gaps (gaps: []); 'fail' requires at least one classified gap. " +
        "'pass' only if all seven rubric dimensions pass.",
      '/gaps': 'On a fail verdict: every gap keeping the verdict from pass, in semantic order.',
      '/gaps/items/classification':
        'Exactly one of CAN_RESOLVE, DEFER, HUMAN_DECISION, EXPLORE_AS_WORK.',
      '/gaps/items/closure':
        'Required for every failing gap; for DEFER, describe what recording the DEFERRED transition requires.',
    },
  },

  // C2 review correction — see validateReadinessProposal above: the
  // pre-existing cross-field methodology rules are enforced here, in plain
  // code over the decoded proposal (never zod refinements, never the
  // renderer, never route derivation).
  validate: validateReadinessProposal,

  reviewVerdict: (proposal) => proposal.verdict,

  // Deterministic control from TYPED gaps — the same pure precedence
  // function the legacy parse-back path uses. No artifact parsing anywhere.
  deriveRoute: (proposal, declaredRoutes) => deriveReviewRoute(proposal.gaps, declaredRoutes),

  materialize: renderReadiness,
};
