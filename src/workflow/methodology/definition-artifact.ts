// D.3d.5 commit 2 — the canonical structured Definition Artifact.
//
// Definition remains an ARTIFACT at its existing path/lifecycle — no new
// kernel/domain entity. What changes is its internal shape: the machine-
// significant state lives in YAML front matter (canonical, typed, the ONLY
// authoritative representation), and the Markdown body remains the human
// explanation (rationale, design, tradeoffs). Deterministic logic must never
// regex the prose to recover canonical state.
//
//   .sle/work/<workItemId>/definition.md
//   ────────────────────────────
//   ---
//   schemaVersion: 1
//   goal: "..."
//   facts: [ {id, statement, status, source, kind?, decisionRef?, evidenceRef?} ]
//   constraints: [ {description, type} ]
//   requirements: [...]
//   nonGoals: [...]
//   acceptance: [ {description, met?} ]
//   ---
//   ## Design notes / rationale / tradeoffs  (human prose)
//
// This module is the SINGLE owner of that syntax: parseDefinition is the
// only YAML/front-matter reader for Definition artifacts anywhere in the
// codebase (production, oracle, harness). The DefinitionValidator enforces
// exactly the mechanically decidable invariants already established by
// DEFINITION_CONTRACT — nothing semantic. It does NOT classify gaps, does
// NOT decide HUMAN_DECISION/EXPLORE_AS_WORK, does NOT judge whether a
// default is reasonable, a scope boundary is sufficient, or an acceptance
// criterion captures product intent. Those remain semantic-review questions.
import yaml from 'js-yaml';

// ─── Typed canonical representation ───────────────────────────────────────────

export const DEFINITION_SCHEMA_VERSION = 1;

// Exactly the epistemic statuses DEFINITION_CONTRACT has always defined.
export const FACT_STATUSES = ['KNOWN', 'ASSUMED', 'UNKNOWN', 'DECIDED', 'DEFERRED'] as const;
export type FactStatus = (typeof FACT_STATUSES)[number];

// Exactly the provenance values DEFINITION_CONTRACT has always defined.
export const FACT_SOURCES = ['human', 'repository', 'artifact', 'investigation', 'decision'] as const;
export type FactSource = (typeof FACT_SOURCES)[number];

// D.3d.5 — the product-intent vs repository-claim distinction the contract
// has always drawn, now EXPLICIT so the validator can enforce its one
// mechanically decidable provenance rule without keyword heuristics:
// a repository-claim stated by a human cannot be KNOWN on human authority
// alone. OPTIONAL — when absent, provenance adequacy stays with semantic
// review; the validator never infers the kind from the statement text.
export const FACT_KINDS = ['product-intent', 'repository-claim'] as const;
export type FactKind = (typeof FACT_KINDS)[number];

export interface CanonicalFact {
  id: string;
  statement: string;
  status: FactStatus;
  source: FactSource;
  kind?: FactKind;
  /** Required exactly when status is DECIDED (contract: source becomes 'decision'). */
  decisionRef?: string;
  /** Optional checkable anchor for KNOWN facts (repository path, artifact id, test name). */
  evidenceRef?: string;
}

export interface CanonicalConstraint {
  description: string;
  type: 'must' | 'must_not' | 'prefer' | 'prefer_not';
}

export interface CanonicalAcceptanceCriterion {
  description: string;
  /** Optional at definition time — criteria start unmet. */
  met?: boolean;
}

export interface CanonicalDefinition {
  schemaVersion: number;
  goal: string;
  facts: CanonicalFact[];
  constraints?: CanonicalConstraint[];
  requirements?: string[];
  nonGoals?: string[];
  acceptance?: CanonicalAcceptanceCriterion[];
}

export interface ParsedDefinitionArtifact {
  definition: CanonicalDefinition;
  /** The human-facing Markdown body (everything after the front matter). */
  body: string;
}

// ─── Parsing (fail closed) ────────────────────────────────────────────────────

export type DefinitionParseErrorCode =
  | 'FRONT_MATTER_MISSING'
  | 'YAML_MALFORMED'
  | 'SHAPE_INVALID'
  | 'SCHEMA_VERSION_UNSUPPORTED';

export class DefinitionParseError extends Error {
  constructor(
    public readonly code: DefinitionParseErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DefinitionParseError';
  }
}

const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * The single canonical parser for Definition artifacts. Fails closed on:
 * missing front matter, malformed YAML, wrong top-level shape, and an
 * unsupported schemaVersion. No caller anywhere else may parse Definition
 * YAML/front matter itself.
 */
export function parseDefinition(artifactText: string): ParsedDefinitionArtifact {
  const match = artifactText.match(FRONT_MATTER_RE);
  if (!match) {
    throw new DefinitionParseError(
      'FRONT_MATTER_MISSING',
      'Definition artifact has no canonical YAML front matter (expected leading --- block)',
    );
  }
  let raw: unknown;
  try {
    raw = yaml.load(match[1]);
  } catch (err) {
    throw new DefinitionParseError(
      'YAML_MALFORMED',
      `Definition front matter is not valid YAML: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new DefinitionParseError('SHAPE_INVALID', 'Definition front matter must be a YAML mapping');
  }
  const obj = raw as Record<string, unknown>;
  if (obj.schemaVersion !== DEFINITION_SCHEMA_VERSION) {
    throw new DefinitionParseError(
      'SCHEMA_VERSION_UNSUPPORTED',
      `Definition schemaVersion ${JSON.stringify(obj.schemaVersion)} is unsupported (expected ${DEFINITION_SCHEMA_VERSION})`,
    );
  }
  if (typeof obj.goal !== 'string' || obj.goal.trim() === '') {
    throw new DefinitionParseError('SHAPE_INVALID', 'Definition front matter must carry a non-empty string "goal"');
  }
  if (!Array.isArray(obj.facts)) {
    throw new DefinitionParseError('SHAPE_INVALID', 'Definition front matter must carry a "facts" array (possibly empty)');
  }
  for (const f of obj.facts) {
    if (f === null || typeof f !== 'object' || Array.isArray(f)) {
      throw new DefinitionParseError('SHAPE_INVALID', 'every fact entry must be a mapping');
    }
    const fact = f as Record<string, unknown>;
    if (typeof fact.id !== 'string' || fact.id.trim() === '') {
      throw new DefinitionParseError('SHAPE_INVALID', 'every fact must carry a non-empty string "id"');
    }
    if (typeof fact.statement !== 'string' || fact.statement.trim() === '') {
      throw new DefinitionParseError('SHAPE_INVALID', `fact '${String(fact.id)}' must carry a non-empty string "statement"`);
    }
    // Scalar type integrity for the epistemic fields: a successful parse must
    // never cast an array/object/null into a typed scalar. Enum MEMBERSHIP
    // stays with validateDefinition — parsing owns structure, validation owns
    // the declared vocabularies.
    if (typeof fact.status !== 'string') {
      throw new DefinitionParseError('SHAPE_INVALID', `fact '${fact.id}' must carry a string "status"`);
    }
    if (typeof fact.source !== 'string') {
      throw new DefinitionParseError('SHAPE_INVALID', `fact '${fact.id}' must carry a string "source"`);
    }
    if (fact.kind !== undefined && typeof fact.kind !== 'string') {
      throw new DefinitionParseError('SHAPE_INVALID', `fact '${fact.id}' "kind" must be a string when present`);
    }
    if (fact.decisionRef !== undefined && typeof fact.decisionRef !== 'string') {
      throw new DefinitionParseError('SHAPE_INVALID', `fact '${fact.id}' "decisionRef" must be a string when present`);
    }
    if (fact.evidenceRef !== undefined && typeof fact.evidenceRef !== 'string') {
      throw new DefinitionParseError('SHAPE_INVALID', `fact '${fact.id}' "evidenceRef" must be a string when present`);
    }
  }
  // Optional canonical sections: structural type integrity only. The parser
  // claims NO authority over their content (whether a requirement is good,
  // whether acceptance is sufficient — semantic review's territory).
  const constraints: CanonicalConstraint[] = [];
  if (obj.constraints !== undefined) {
    if (!Array.isArray(obj.constraints)) {
      throw new DefinitionParseError('SHAPE_INVALID', '"constraints" must be an array when present');
    }
    for (const c of obj.constraints) {
      if (c === null || typeof c !== 'object' || Array.isArray(c)) {
        throw new DefinitionParseError('SHAPE_INVALID', 'every constraints entry must be a mapping');
      }
      const entry = c as Record<string, unknown>;
      if (typeof entry.description !== 'string' || entry.description.trim() === '') {
        throw new DefinitionParseError('SHAPE_INVALID', 'every constraint must carry a non-empty string "description"');
      }
      if (
        typeof entry.type !== 'string' ||
        !['must', 'must_not', 'prefer', 'prefer_not'].includes(entry.type)
      ) {
        throw new DefinitionParseError(
          'SHAPE_INVALID',
          `constraint '${String(entry.description)}' must carry "type" must|must_not|prefer|prefer_not`,
        );
      }
      constraints.push({ description: entry.description, type: entry.type as CanonicalConstraint['type'] });
    }
  }
  const requirements: string[] = [];
  if (obj.requirements !== undefined) {
    if (!Array.isArray(obj.requirements)) {
      throw new DefinitionParseError('SHAPE_INVALID', '"requirements" must be an array when present');
    }
    for (const r of obj.requirements) {
      if (typeof r !== 'string' || r.trim() === '') {
        throw new DefinitionParseError('SHAPE_INVALID', 'every requirement must be a non-empty string');
      }
      requirements.push(r);
    }
  }
  const nonGoals: string[] = [];
  if (obj.nonGoals !== undefined) {
    if (!Array.isArray(obj.nonGoals)) {
      throw new DefinitionParseError('SHAPE_INVALID', '"nonGoals" must be an array when present');
    }
    for (const n of obj.nonGoals) {
      if (typeof n !== 'string' || n.trim() === '') {
        throw new DefinitionParseError('SHAPE_INVALID', 'every nonGoal must be a non-empty string');
      }
      nonGoals.push(n);
    }
  }
  const acceptance: CanonicalAcceptanceCriterion[] = [];
  if (obj.acceptance !== undefined) {
    if (!Array.isArray(obj.acceptance)) {
      throw new DefinitionParseError('SHAPE_INVALID', '"acceptance" must be an array when present');
    }
    for (const a of obj.acceptance) {
      if (a === null || typeof a !== 'object' || Array.isArray(a)) {
        throw new DefinitionParseError('SHAPE_INVALID', 'every acceptance entry must be a mapping');
      }
      const entry = a as Record<string, unknown>;
      if (typeof entry.description !== 'string' || entry.description.trim() === '') {
        throw new DefinitionParseError('SHAPE_INVALID', 'every acceptance criterion must carry a non-empty string "description"');
      }
      if (entry.met !== undefined && typeof entry.met !== 'boolean') {
        throw new DefinitionParseError('SHAPE_INVALID', `acceptance criterion '${String(entry.description)}' "met" must be a boolean when present`);
      }
      acceptance.push(entry.met === undefined ? { description: entry.description } : { description: entry.description, met: entry.met });
    }
  }
  return {
    definition: {
      schemaVersion: DEFINITION_SCHEMA_VERSION,
      goal: obj.goal,
      facts: obj.facts.map((f) => {
        const fact = f as Record<string, unknown>;
        return {
          id: fact.id,
          statement: fact.statement,
          status: fact.status,
          source: fact.source,
          ...(fact.kind !== undefined ? { kind: fact.kind } : {}),
          ...(fact.decisionRef !== undefined ? { decisionRef: fact.decisionRef } : {}),
          ...(fact.evidenceRef !== undefined ? { evidenceRef: fact.evidenceRef } : {}),
        } as CanonicalFact;
      }),
      ...(obj.constraints !== undefined ? { constraints } : {}),
      ...(obj.requirements !== undefined ? { requirements } : {}),
      ...(obj.nonGoals !== undefined ? { nonGoals } : {}),
      ...(obj.acceptance !== undefined ? { acceptance } : {}),
    },
    body: match[2] ?? '',
  };
}

// ─── Deterministic validation (mechanical invariants ONLY) ───────────────────

export type DefinitionDefectCode =
  | 'FACT_DUPLICATE_ID'
  | 'FACT_STATUS_INVALID'
  | 'FACT_SOURCE_INVALID'
  | 'FACT_KIND_INVALID'
  | 'STATUS_SOURCE_CONFLICT'
  | 'DECISION_REF_MISSING'
  | 'DECISION_REF_STRAY'
  | 'DECISION_REF_UNRESOLVED'
  | 'PROVENANCE_UNCONFIRMED';

export interface DefinitionDefect {
  code: DefinitionDefectCode;
  factId?: string;
  message: string;
}

export interface DefinitionValidationResult {
  valid: boolean;
  defects: DefinitionDefect[];
}

export interface DefinitionValidatorOptions {
  /**
   * Optional resolver for DECIDED provenance: when provided, a decisionRef
   * must resolve. The caller supplies it ONLY where Decision records are
   * actually queryable (e.g. a workflow run's DecisionRepository); the bare
   * validator never pretends to know which Decision ids exist.
   */
  decisionExists?: (decisionRef: string) => boolean;
}

/**
 * The deterministic DefinitionValidator: every mechanically decidable
 * invariant DEFINITION_CONTRACT establishes, and NOTHING else.
 *
 * Validates: fact-id presence/uniqueness; status/source/kind enums; the
 * DECIDED↔decision provenance pairing (status DECIDED requires source
 * 'decision' + a decisionRef; source 'decision' or a stray decisionRef
 * outside DECIDED is a conflict); DECIDED reference resolution when the
 * caller can supply a resolver; and the one explicit provenance rule
 * (kind: repository-claim cannot be KNOWN on source: human alone).
 *
 * Deliberately does NOT decide: whether an unresolved issue is
 * HUMAN_DECISION or EXPLORE_AS_WORK; whether a default is reasonable;
 * whether a scope boundary is sufficient; whether an acceptance criterion
 * captures product intent; or any other semantic question.
 */
export function validateDefinition(
  definition: CanonicalDefinition,
  options: DefinitionValidatorOptions = {},
): DefinitionValidationResult {
  const defects: DefinitionDefect[] = [];
  const seen = new Map<string, number>();

  for (const fact of definition.facts) {
    const dup = seen.get(fact.id);
    if (dup !== undefined) {
      defects.push({
        code: 'FACT_DUPLICATE_ID',
        factId: fact.id,
        message: `fact id '${fact.id}' occurs more than once in the ledger (first at entry ${dup + 1})`,
      });
    } else {
      seen.set(fact.id, definition.facts.indexOf(fact));
    }

    if (!(FACT_STATUSES as readonly string[]).includes(fact.status)) {
      defects.push({
        code: 'FACT_STATUS_INVALID',
        factId: fact.id,
        message: `fact '${fact.id}' has status '${String(fact.status)}' — expected one of ${FACT_STATUSES.join(', ')}`,
      });
    }
    if (!(FACT_SOURCES as readonly string[]).includes(fact.source)) {
      defects.push({
        code: 'FACT_SOURCE_INVALID',
        factId: fact.id,
        message: `fact '${fact.id}' has source '${String(fact.source)}' — expected one of ${FACT_SOURCES.join(', ')}`,
      });
    }
    if (fact.kind !== undefined && !(FACT_KINDS as readonly string[]).includes(fact.kind)) {
      defects.push({
        code: 'FACT_KIND_INVALID',
        factId: fact.id,
        message: `fact '${fact.id}' has kind '${String(fact.kind)}' — expected one of ${FACT_KINDS.join(', ')} or no kind`,
      });
    }

    // DECIDED ↔ decision provenance pairing (mechanical: the contract
    // defines source 'decision' as existing ONLY for DECIDED facts).
    const isDecided = fact.status === 'DECIDED';
    const sourceIsDecision = fact.source === 'decision';
    if (isDecided && !sourceIsDecision) {
      defects.push({
        code: 'STATUS_SOURCE_CONFLICT',
        factId: fact.id,
        message: `fact '${fact.id}' is DECIDED but its source is '${fact.source}' — a Decision-resolved fact carries source: decision`,
      });
    }
    if (!isDecided && sourceIsDecision) {
      defects.push({
        code: 'STATUS_SOURCE_CONFLICT',
        factId: fact.id,
        message: `fact '${fact.id}' has source: decision but status '${fact.status}' — decision provenance belongs exclusively to DECIDED facts`,
      });
    }
    if (isDecided && (fact.decisionRef === undefined || fact.decisionRef.trim() === '')) {
      defects.push({
        code: 'DECISION_REF_MISSING',
        factId: fact.id,
        message: `fact '${fact.id}' is DECIDED without a decisionRef — record the Decision it was resolved by`,
      });
    }
    if (!isDecided && fact.decisionRef !== undefined) {
      defects.push({
        code: 'DECISION_REF_STRAY',
        factId: fact.id,
        message: `fact '${fact.id}' carries a decisionRef but is not DECIDED — a decision reference is only meaningful on a DECIDED fact`,
      });
    }
    if (
      isDecided &&
      fact.decisionRef !== undefined &&
      fact.decisionRef.trim() !== '' &&
      options.decisionExists &&
      !options.decisionExists(fact.decisionRef)
    ) {
      defects.push({
        code: 'DECISION_REF_UNRESOLVED',
        factId: fact.id,
        message: `fact '${fact.id}' references decision '${fact.decisionRef}' which does not exist in this context`,
      });
    }

    // The ONE explicit provenance rule (mechanical only because the kind is
    // an explicit structured field — the validator never infers it from the
    // statement text): a human-stated repository-claim is not KNOWN on human
    // authority alone; it needs repository/investigation confirmation.
    if (fact.kind === 'repository-claim' && fact.status === 'KNOWN' && fact.source === 'human') {
      defects.push({
        code: 'PROVENANCE_UNCONFIRMED',
        factId: fact.id,
        message: `fact '${fact.id}' declares kind: repository-claim but is KNOWN with source: human — confirm via repository inspection (source: repository) or investigation evidence before KNOWN`,
      });
    }
  }

  return { valid: defects.length === 0, defects };
}

// ─── Gate adapter (the exact seam the execution layer consumes) ──────────────

export interface InputValidationFailure {
  defects: Array<{ code: string; factId?: string; message: string }>;
}

/**
 * Context the deterministic gate passes alongside the artifact text (what
 * the runner generically knows about the step's run). Optional and
 * deliberately tiny: ownership checks that need more context would be a
 * scope widening, reported before attempting.
 */
export interface DefinitionValidatorContext {
  workItemId?: string;
}

/**
 * Storage-free view of what the methodology needs to know about a Decision:
 * that it exists and which work item owns it. The composition root maps the
 * real DecisionRepository onto this — the methodology never imports storage
 * or repository code.
 */
export interface DecisionOwnership {
  workItemId?: string;
}

export interface DefinitionInputValidatorDeps {
  /**
   * Real Decision lookup for DECIDED provenance. When provided, a decisionRef
   * must resolve AND — when the gate supplies a workItemId context — belong
   * to that same work item, so a model cannot borrow authority from an
   * unrelated Decision elsewhere in the control plane.
   */
  findDecision?: (decisionRef: string) => DecisionOwnership | undefined;
}

/**
 * Parse + validate a Definition artifact's text in one call — the shape the
 * AgentRunner input-validator registry consumes. Parse failures are surfaced
 * as structured defects too (the refine agent needs the parse diagnosis),
 * with the canonical parse-error codes.
 *
 * The pure validator stays pure: storage access arrives ONLY through the
 * injected findDecision closure built at the composition root.
 */
export function createDefinitionInputValidator(
  deps: DefinitionInputValidatorDeps = {},
): (artifactText: string, context?: DefinitionValidatorContext) => { ok: true } | { ok: false; failure: InputValidationFailure } {
  return (artifactText, context) => {
    try {
      const { definition } = parseDefinition(artifactText);
      const result = validateDefinition(definition, {
        ...(deps.findDecision
          ? {
              decisionExists: (decisionRef: string) => {
                const decision = deps.findDecision!(decisionRef);
                if (decision === undefined) return false;
                // Ownership: a Decision from a DIFFERENT work item is not
                // authority for this one (same control-plane linkage the
                // Decision itself carries — no new authority model).
                if (context?.workItemId !== undefined && decision.workItemId !== context.workItemId) {
                  return false;
                }
                return true;
              },
            }
          : {}),
      });
      return result.valid ? { ok: true } : { ok: false, failure: { defects: result.defects } };
    } catch (err) {
      if (err instanceof DefinitionParseError) {
        return { ok: false, failure: { defects: [{ code: err.code, message: err.message }] } };
      }
      throw err;
    }
  };
}

/**
 * Existence-only validator (no Decision lookup): identical to the production
 * validator created with `createDefinitionInputValidator()` and no deps.
 * Production MUST use the composition-root-created instance with a real
 * resolver — a DECIDED fact referencing an invented Decision must fail the
 * actual gate, not just the pure validator.
 */
export const validateDefinitionArtifactText = createDefinitionInputValidator();
