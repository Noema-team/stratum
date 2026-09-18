// D.34 C4 — the Definition output contract (DDR-034 §7, §8.3): the semantic
// proposal a Definition produce step owes Stratum, the zod schema that is
// the single structural authority for it, the deterministic renderer that
// materializes the canonical Definition artifact bytes, and the mechanical
// validator — validateDefinition wrapped VERBATIM (definition-artifact.ts),
// with DECIDED provenance resolution arriving through the findDecision
// closure baked at the composition root.
//
// Principle (DDR-034): models propose; Stratum materializes. A produce step
// returns { goal, facts, …, bodyMarkdown } — pure semantic content. It does
// NOT author schemaVersion, front-matter delimiters, YAML, or artifact
// paths. renderDefinition is the system's canonical-byte author;
// parseDefinition (definition-artifact.ts) remains the load path for
// persisted / human-edited / cross-run artifacts and is unchanged. The
// canonical on-disk format is UNCHANGED (schemaVersion 1 + front matter +
// body).
//
// Serialization teaching moves into the generated projection (DDR-034
// §8.3): DEFINITION_CONTRACT's YAML shape block is replaced by this
// contract's projection + schemaAnnotations, so the drafter's prompt keeps
// the MEANING of every field while the schema teaches the exact shape.
import { z } from 'zod';
import yaml from 'js-yaml';

import {
  DEFINITION_SCHEMA_VERSION,
  FACT_STATUSES,
  FACT_SOURCES,
  FACT_KINDS,
  validateDefinition,
  parseDefinition,
  type CanonicalDefinition,
  type CanonicalFact,
  type CanonicalConstraint,
  type CanonicalAcceptanceCriterion,
  type DecisionOwnership,
} from './definition-artifact.js';
import {
  type ContractDefect,
  type OutputContract,
  type OutputContractContext,
} from '../contracts.js';

// ─── Semantic proposal (what the model owes Stratum) ──────────────────────────

/**
 * The Definition's semantic content, exactly as the methodology has always
 * defined it (DEFINITION_CONTRACT) — minus every serialization concern.
 * schemaVersion is system-injected at materialization. Optional sections
 * are omitted when the Definition has none; an explicitly empty array is
 * meaningful and preserved (§10.3: explicit [] vs omitted optional).
 */
export interface DefinitionProposal {
  goal: string;
  facts: CanonicalFact[];
  constraints?: CanonicalConstraint[];
  requirements?: string[];
  nonGoals?: string[];
  acceptance?: CanonicalAcceptanceCriterion[];
  /** The human-facing Markdown body (rationale, design, tradeoffs). */
  bodyMarkdown: string;
}

// ─── Zod schema — THE single structural authority ─────────────────────────────
//
// Same projection-fidelity discipline as the readiness contract (DDR-034
// §5.1): provider-facing representations use only projection-safe
// structural constraints; zod decode is always the runtime authority. The
// non-empty-after-trim refinements are deliberately NOT projected; their
// violation is a producer-result defect on the bounded result-repair seam.
// Cross-field mechanical invariants (DECIDED↔decision provenance pairing,
// reference resolution) are NOT schema constraints — they belong
// exclusively to `validate` (validateDefinitionProposal), which produces
// structured defects with the EXACT wording the refine path has always
// consumed.

/** Decode-authoritative, deliberately NOT projected (fidelity gap is fine). */
function nonEmptyAfterTrim(label: string) {
  return z
    .string()
    .refine((s) => s.trim().length > 0, {
      message: `${label} must be a non-empty, non-whitespace string`,
    });
}

export const DEFINITION_PROPOSAL_SCHEMA = z
  .object({
    goal: nonEmptyAfterTrim('goal'),
    facts: z
      .array(
        z
          .object({
            id: nonEmptyAfterTrim('fact id'),
            statement: nonEmptyAfterTrim('fact statement'),
            status: z.enum(FACT_STATUSES),
            source: z.enum(FACT_SOURCES),
            kind: z.enum(FACT_KINDS).optional(),
            decisionRef: z.string().optional(),
            evidenceRef: z.string().optional(),
          })
          .strict(),
      ),
    constraints: z
      .array(
        z
          .object({
            description: nonEmptyAfterTrim('constraint description'),
            type: z.enum(['must', 'must_not', 'prefer', 'prefer_not']),
          })
          .strict(),
      )
      .optional(),
    requirements: z.array(nonEmptyAfterTrim('requirement')).optional(),
    nonGoals: z.array(nonEmptyAfterTrim('non-goal')).optional(),
    acceptance: z
      .array(
        z
          .object({
            description: nonEmptyAfterTrim('acceptance criterion'),
            met: z.boolean().optional(),
          })
          .strict(),
      )
      .optional(),
    bodyMarkdown: z.string(),
  })
  // Unknown fields (e.g. a model-emitted schemaVersion or transport debris)
  // are producer-result defects — rejected at decode, never silently
  // stripped. The projection is unaffected (additionalProperties: false
  // either way); this only sharpens decode authority.
  .strict();

// ─── Deterministic canonical renderer (DDR-034 §10 invariants) ────────────────

/**
 * Pinned js-yaml dump options — IDENTICAL to the readiness renderer's pin
 * (readiness-contract.ts). Changing ANY of these — or bumping js-yaml —
 * requires regenerating the renderDefinition golden fixtures in the same
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
 * The deterministic canonical bytes for a Definition proposal. PURE: same
 * proposal + static config → same bytes → same provenance hash. Injects
 * schemaVersion. No clock, no randomness, no fs, no env.
 *
 * Envelope (§10.7): `---\n` + YAML + `\n---\n`; exactly one blank line
 * between the closing `---` and a non-empty body; empty body → the artifact
 * ends at the closing `---` newline. Final newline policy: exactly one `\n`
 * at EOF (§10.6). Fact-entry key order: id, statement, status, source,
 * kind, decisionRef, evidenceRef (§10.2). Array order is the model's
 * semantic order — never sorted, deduped, or reordered (§10.4). Model
 * strings are never trimmed or reflowed (§10.5) — only CRLF→LF and the
 * final-newline policy apply. Optional sections: omitted when absent, an
 * explicitly submitted empty array is rendered explicitly (§10.3).
 */
export function renderDefinition(proposal: DefinitionProposal, _ctx?: OutputContractContext): string {
  const facts = proposal.facts.map((f: CanonicalFact) => ({
    id: toLf(f.id),
    statement: toLf(f.statement),
    status: f.status,
    source: f.source,
    ...(f.kind !== undefined ? { kind: f.kind } : {}),
    ...(f.decisionRef !== undefined ? { decisionRef: toLf(f.decisionRef) } : {}),
    ...(f.evidenceRef !== undefined ? { evidenceRef: toLf(f.evidenceRef) } : {}),
  }));
  const front = yaml.dump(
    {
      schemaVersion: DEFINITION_SCHEMA_VERSION,
      goal: toLf(proposal.goal),
      facts,
      ...(proposal.constraints !== undefined
        ? {
            constraints: proposal.constraints.map((c: CanonicalConstraint) => ({
              description: toLf(c.description),
              type: c.type,
            })),
          }
        : {}),
      ...(proposal.requirements !== undefined ? { requirements: proposal.requirements.map(toLf) } : {}),
      ...(proposal.nonGoals !== undefined ? { nonGoals: proposal.nonGoals.map(toLf) } : {}),
      ...(proposal.acceptance !== undefined
        ? {
            acceptance: proposal.acceptance.map((a: CanonicalAcceptanceCriterion) => ({
              description: toLf(a.description),
              ...(a.met !== undefined ? { met: a.met } : {}),
            })),
          }
        : {}),
    },
    YAML_DUMP_OPTIONS,
  );
  const body = toLf(proposal.bodyMarkdown);
  // §10.7 / §10.6 — identical envelope policy to the readiness renderer.
  const bodyPart = body.length > 0 ? `\n\n${body.replace(/\n+$/, '')}\n` : '\n';
  return `---\n${front}---${bodyPart}`;
}

/**
 * Reload helper: rebuild a proposal from persisted canonical bytes — the
 * load path (parseDefinition) is the ONLY reader; this adds no parsing of
 * its own. Used by round-trip / stability tests and by any future slice
 * that needs the semantic value of an on-disk Definition.
 */
export function definitionProposalFromPersisted(artifactText: string): DefinitionProposal {
  const { definition, body } = parseDefinition(artifactText);
  return {
    goal: definition.goal,
    facts: definition.facts.map((f) => ({ ...f })),
    ...(definition.constraints !== undefined
      ? { constraints: definition.constraints.map((c) => ({ ...c })) }
      : {}),
    ...(definition.requirements !== undefined ? { requirements: [...definition.requirements] } : {}),
    ...(definition.nonGoals !== undefined ? { nonGoals: [...definition.nonGoals] } : {}),
    ...(definition.acceptance !== undefined
      ? { acceptance: definition.acceptance.map((a) => ({ ...a })) }
      : {}),
    // renderDefinition inserts exactly one blank line after the closing
    // `---` for a non-empty body; the parser consumes `---\n`, leaving that
    // blank line as the body's first character. Strip exactly it — the
    // precise inverse of the renderer's envelope, nothing more.
    bodyMarkdown: body.replace(/^\n/, ''),
  };
}

// ─── Mechanical methodology validation — validateDefinition, wrapped VERBATIM ──
//
// The deterministic DefinitionValidator (definition-artifact.ts) is the
// single owner of the mechanically decidable ledger invariants: fact-id
// uniqueness, enum vocabularies, the DECIDED↔decision provenance pairing,
// reference resolution, and the one explicit provenance rule. This wrapper
// adds NOTHING to it: it maps the proposal onto the canonical value the
// validator already consumes, adapts its defects to the ContractDefect
// shape, and resolves DECIDED provenance through the SAME composition-root
// closure (findDecision + same-work-item ownership) the input gate uses.
// Semantic questions stay exactly where they have always been — readiness
// review.

export interface DefinitionContractDeps {
  /**
   * Real Decision lookup for DECIDED provenance — the identical closure the
   * input validator receives from the composition root. When provided, a
   * decisionRef must resolve AND belong to the executing step's work item;
   * invented or borrowed authority fails deterministically.
   */
  findDecision?: (decisionRef: string) => DecisionOwnership | undefined;
}

export function validateDefinitionProposal(
  proposal: DefinitionProposal,
  ctx: OutputContractContext,
  deps: DefinitionContractDeps = {},
): readonly ContractDefect[] {
  const canonical: CanonicalDefinition = {
    schemaVersion: DEFINITION_SCHEMA_VERSION,
    goal: proposal.goal,
    facts: proposal.facts,
    ...(proposal.constraints !== undefined ? { constraints: proposal.constraints } : {}),
    ...(proposal.requirements !== undefined ? { requirements: proposal.requirements } : {}),
    ...(proposal.nonGoals !== undefined ? { nonGoals: proposal.nonGoals } : {}),
    ...(proposal.acceptance !== undefined ? { acceptance: proposal.acceptance } : {}),
  };
  const result = validateDefinition(canonical, {
    ...(deps.findDecision
      ? {
          decisionExists: (decisionRef: string) => {
            const decision = deps.findDecision!(decisionRef);
            if (decision === undefined) return false;
            // Ownership: a Decision from a DIFFERENT work item is not
            // authority for this one — the identical rule the input gate
            // enforces (createDefinitionInputValidator).
            if (ctx.workItemId !== undefined && decision.workItemId !== ctx.workItemId) {
              return false;
            }
            return true;
          },
        }
      : {}),
  });
  return result.defects.map((d) => ({
    code: d.code,
    ...(d.factId !== undefined ? { ref: d.factId } : {}),
    message: d.message,
  }));
}

// ─── The contract (hooks + renderer) ──────────────────────────────────────────

/**
 * The Definition output contract. Identity is the registry key under which
 * the composition root registers it ('definition' — define-work's produce
 * steps' outputArtifact.type); the contract itself declares no identity
 * (DDR-034 §5.1). A factory (not a literal) solely because the DECIDED
 * provenance resolver is a composition-root closure — the same reason the
 * input validator is.
 */
export function createDefinitionOutputContract(deps: DefinitionContractDeps = {}): OutputContract<DefinitionProposal> {
  return {
    modelSchema: DEFINITION_PROPOSAL_SCHEMA,

    schemaAnnotations: {
      root:
        'Propose the Definition\'s complete semantic content. The system serializes the ' +
        'canonical artifact itself — never emit YAML, front matter, delimiters, paths, or ' +
        'schemaVersion.',
      fields: {
        '/goal': 'The single outcome being defined — one concrete statement.',
        '/facts': 'The fact ledger: every fact relevant to the goal, in ledger order.',
        '/facts/items/status':
          'Exactly one of KNOWN, ASSUMED, UNKNOWN, DECIDED, DEFERRED. Epistemic status lives ' +
          'exactly once, here — never duplicated on a requirement, constraint, or acceptance entry.',
        '/facts/items/source':
          'Where the fact came from: human, repository, artifact, investigation, or decision. ' +
          'A human assertion about repository reality is not KNOWN on human authority alone; ' +
          'source: decision belongs exclusively to DECIDED facts.',
        '/facts/items/kind':
          "Optional: 'product-intent' or 'repository-claim'. One mechanical rule follows from " +
          'it: a repository-claim may not be KNOWN on source: human alone.',
        '/facts/items/decisionRef':
          'Required exactly when status is DECIDED: the id of the recorded Decision that ' +
          'resolved the fact. Never present on a non-DECIDED fact.',
        '/facts/items/evidenceRef':
          'Optional checkable anchor for KNOWN facts (a repository path, artifact id, or test name).',
        '/constraints/items/type': 'Exactly one of must, must_not, prefer, prefer_not.',
        '/bodyMarkdown':
          'The human-facing body: design thinking, named risks, tradeoffs, rationale. ' +
          'Never restates the ledger.',
      },
    },

    // validateDefinition, verbatim — no additional mechanical rule anywhere.
    validate: (value, ctx) => validateDefinitionProposal(value, ctx, deps),

    // A produce contract: no reviewVerdict, no deriveRoute. The runner's
    // authoring checks only demand those hooks on review steps.
    materialize: renderDefinition,
  };
}
