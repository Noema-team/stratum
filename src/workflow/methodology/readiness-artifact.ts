// D.3d.5 commit 3 — the canonical structured readiness Artifact and the
// deterministic gap-classification → route derivation.
//
// Until this commit the semantic readiness reviewer both DESCRIBED epistemic
// state (gap classifications in the readiness artifact) and AUTHORITATIVELY
// SELECTED control flow (the legacy textual `route:` token). Commit 3
// removes that final model authority: the reviewer classifies gaps in the
// artifact's canonical front matter, and Stratum derives the route
// deterministically from GAP_CLASSIFICATION_PRECEDENCE, constrained to the
// routes the workflow author declared for the step.
//
//   readiness artifact (fail verdict)
//   → canonical parser (this module — fail closed, structural only)
//   → deriveReviewRoute (mechanical precedence, no semantics)
//   → existing allowlist gate (the step's own on_fail_routes keys)
//
// The parser is the SINGLE owner of readiness front-matter syntax, exactly
// as parseDefinition is for the Definition artifact. It validates STRUCTURE
// only — whether a classification is CORRECT stays a semantic-review
// question; the derivation merely applies the precedence the workflow
// already documents.
import yaml from 'js-yaml';
import {
  GAP_CLASSIFICATION_PRECEDENCE,
  isGapClassification,
  ROUTE_TOKEN_FOR_CLASSIFICATION,
  type GapClassification,
} from './definition-readiness.js';

export const READINESS_SCHEMA_VERSION = 1;

export interface ReadinessGap {
  /** The fact id (or an explicit missing-area identifier) the gap is about. */
  target: string;
  description: string;
  classification: GapClassification;
  reason: string;
  /** What closure (or, for DEFER, recording the DEFERRED transition) requires. */
  closure?: string;
}

export interface CanonicalReadiness {
  schemaVersion: number;
  gaps: ReadinessGap[];
}

export interface ParsedReadinessArtifact {
  readiness: CanonicalReadiness;
  body: string;
}

export type ReadinessParseErrorCode =
  | 'FRONT_MATTER_MISSING'
  | 'YAML_MALFORMED'
  | 'SHAPE_INVALID'
  | 'SCHEMA_VERSION_UNSUPPORTED';

export class ReadinessParseError extends Error {
  constructor(
    public readonly code: ReadinessParseErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ReadinessParseError';
  }
}

const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * The single canonical parser for readiness artifacts. Structural type
 * integrity ONLY, fail closed — exactly the parseDefinition discipline:
 * no semantic adequacy judgment about any gap.
 */
export function parseReadinessArtifact(artifactText: string): ParsedReadinessArtifact {
  const match = artifactText.match(FRONT_MATTER_RE);
  if (!match) {
    throw new ReadinessParseError(
      'FRONT_MATTER_MISSING',
      'Readiness artifact has no canonical YAML front matter (expected leading --- block)',
    );
  }
  let raw: unknown;
  try {
    raw = yaml.load(match[1]);
  } catch (err) {
    throw new ReadinessParseError(
      'YAML_MALFORMED',
      `Readiness front matter is not valid YAML: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ReadinessParseError('SHAPE_INVALID', 'Readiness front matter must be a YAML mapping');
  }
  const obj = raw as Record<string, unknown>;
  if (obj.schemaVersion !== READINESS_SCHEMA_VERSION) {
    throw new ReadinessParseError(
      'SCHEMA_VERSION_UNSUPPORTED',
      `Readiness schemaVersion ${JSON.stringify(obj.schemaVersion)} is unsupported (expected ${READINESS_SCHEMA_VERSION})`,
    );
  }
  if (!Array.isArray(obj.gaps)) {
    throw new ReadinessParseError('SHAPE_INVALID', 'Readiness front matter must carry a "gaps" array (possibly empty)');
  }
  const gaps: ReadinessGap[] = [];
  for (const g of obj.gaps) {
    if (g === null || typeof g !== 'object' || Array.isArray(g)) {
      throw new ReadinessParseError('SHAPE_INVALID', 'every gap entry must be a mapping');
    }
    const gap = g as Record<string, unknown>;
    for (const field of ['target', 'description', 'classification', 'reason'] as const) {
      if (typeof gap[field] !== 'string' || (gap[field] as string).trim() === '') {
        throw new ReadinessParseError('SHAPE_INVALID', `every gap must carry a non-empty string "${field}"`);
      }
    }
    if (gap.closure !== undefined && typeof gap.closure !== 'string') {
      throw new ReadinessParseError('SHAPE_INVALID', `gap '${String(gap.target)}' "closure" must be a string when present`);
    }
    // Structural enum integrity at parse time: EVERY gap's classification
    // must be a member of GAP_CLASSIFICATION_PRECEDENCE — including gaps
    // that sit next to valid ones. Without this, a mixed artifact
    // (CAN_RESOLVE + MADE_UP_CLASS) would parse, and precedence would
    // silently route on the valid entry while ignoring the malformed one.
    // Membership is mechanical; correctness of the chosen classification
    // is NOT judged here.
    if (!isGapClassification(gap.classification)) {
      throw new ReadinessParseError(
        'SHAPE_INVALID',
        `gap '${String(gap.target)}' classification ${JSON.stringify(gap.classification)} is not one of: ${GAP_CLASSIFICATION_PRECEDENCE.join(', ')}`,
      );
    }
    gaps.push({
      target: gap.target as string,
      description: gap.description as string,
      classification: gap.classification as GapClassification,
      reason: gap.reason as string,
      ...(gap.closure !== undefined ? { closure: gap.closure as string } : {}),
    });
  }
  return {
    readiness: { schemaVersion: READINESS_SCHEMA_VERSION, gaps },
    body: match[2] ?? '',
  };
}

export type ReviewRouteDerivation =
  | { ok: true; route: string }
  | { ok: false; error: string };

/**
 * Deterministic route derivation from structured gap classifications.
 * Mechanical ONLY: the highest-precedence classification present among the
 * gaps (GAP_CLASSIFICATION_PRECEDENCE order) wins, constrained to the
 * route tokens the step actually declares. Enum membership of the
 * classification field is a mechanical check; whether a classification is
 * CORRECT is semantic review's judgment and is never second-guessed here.
 */
export function deriveReviewRoute(
  gaps: ReadonlyArray<Pick<ReadinessGap, 'classification'>>,
  declaredRoutes: readonly string[],
): ReviewRouteDerivation {
  // Defense in depth: the canonical parser already guarantees membership,
  // but a caller bypassing the parser must not be able to smuggle an
  // unknown classification through precedence search (which would silently
  // ignore it). Anything unclassifiable fails closed.
  const unknown = gaps.find((g) => !isGapClassification(g.classification));
  if (unknown !== undefined) {
    return {
      ok: false,
      error: `gap classification ${JSON.stringify(unknown.classification)} is not one of: ${GAP_CLASSIFICATION_PRECEDENCE.join(', ')}`,
    };
  }
  for (const classification of GAP_CLASSIFICATION_PRECEDENCE) {
    if (!gaps.some((g) => g.classification === classification)) continue;
    const route = ROUTE_TOKEN_FOR_CLASSIFICATION[classification];
    if (declaredRoutes.includes(route)) {
      return { ok: true, route };
    }
    return {
      ok: false,
      error: `gap classified ${classification} (route '${route}') but this review step declares only: ${declaredRoutes.join(', ')}`,
    };
  }
  return {
    ok: false,
    error: `fail verdict carries gaps but none carries a valid classification (expected one of: ${GAP_CLASSIFICATION_PRECEDENCE.join(', ')})`,
  };
}

/**
 * Parse + derive in one call — the shape the AgentRunner route seam
 * consumes. Parse failures surface as { ok: false } with the canonical
 * parse diagnosis (fail closed — a fail verdict whose artifact cannot be
 * mechanically understood never routes anywhere).
 */
export function createReviewRouteDeriver(): (
  readinessText: string,
  declaredRoutes: readonly string[],
) => ReviewRouteDerivation {
  return (readinessText, declaredRoutes) => {
    try {
      const { readiness } = parseReadinessArtifact(readinessText);
      return deriveReviewRoute(readiness.gaps, declaredRoutes);
    } catch (err) {
      if (err instanceof ReadinessParseError) {
        return { ok: false, error: `${err.code}: ${err.message}` };
      }
      throw err;
    }
  };
}
