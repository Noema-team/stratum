// DDR-036 — escalation ownership contracts. Evidence-triggered completion of
// DDR-034's "models propose; Stratum materializes" for the escalation
// subworkflow (E4-A/E4-B qualification failures: decision identity lost
// across prose hops, decisionRef miscopied or never applied, exploration
// artifacts dropped — see docs/decisions/ddr-036-escalation-ownership.md).
//
// Three contracts, one principle: the model owns SEMANTICS (which gap to
// escalate, what the options are, what the selected choice MEANS, what the
// exploration must answer); Stratum owns IDENTITY AND PROVENANCE (the fact
// linkage, the resolved Decision id, the DECIDED/source/decisionRef
// transition, canonical serialization). No proposal schema below contains a
// field the model could use to author, copy, or reconstruct control-plane
// identity — the mechanical fields are either validated selections against
// the current readiness (decision-request, exploration-need) or not
// model-authoable at all (decision-application).
//
// Trusted inputs arrive exclusively through OutputContractContext — the
// runner resolves the step's declared input artifacts to text and threads
// the resolved DecisionContext; contracts never touch the fs/network/clock.
// Compatibility posture: load old, never infer authority — a legacy
// decision-request without targetFactId reaching deterministic application
// fails explicitly as legacy/unlinked.
import { z } from 'zod';
import yaml from 'js-yaml';

import { type CanonicalFact } from './definition-artifact.js';
import {
  renderDefinition,
  definitionProposalFromPersisted,
  validateDefinitionProposal,
  type DefinitionProposal,
  type DefinitionContractDeps,
} from './definition-contract.js';
import { parseReadinessArtifact } from './readiness-artifact.js';
import {
  type ContractDefect,
  type OutputContract,
  type OutputContractContext,
  findInputArtifact,
} from '../contracts.js';

/** Decode-authoritative, deliberately NOT projected (fidelity gap is fine). */
function nonEmptyAfterTrim(label: string) {
  return z
    .string()
    .refine((s) => s.trim().length > 0, {
      message: `${label} must be a non-empty, non-whitespace string`,
    });
}

/** Pinned js-yaml options — IDENTICAL to the definition/readiness pins. */
const YAML_DUMP_OPTIONS = {
  indent: 2,
  lineWidth: 120,
  noRefs: true,
  sortKeys: false,
  quotingType: '"' as const,
  forceQuotes: false,
} as const;

function toLf(s: string): string {
  return s.replace(/\r\n?/g, '\n');
}

// ─── Shared trusted-input resolution (fail closed, never guess) ───────────────

/**
 * Resolve the current readiness gaps from the step's trusted readiness.md
 * input artifact. Absent/unparseable → undefined; every caller fails closed
 * with precise wording (a contract must never guess the gap landscape).
 */
function currentReadinessGaps(ctx: OutputContractContext):
  | { ok: true; gaps: ReturnType<typeof parseReadinessArtifact>['readiness']['gaps'] }
  | { ok: false; reason: 'missing' | 'unparseable' } {
  const text = findInputArtifact(ctx, 'readiness.md');
  if (text === undefined) return { ok: false, reason: 'missing' };
  try {
    return { ok: true, gaps: parseReadinessArtifact(text).readiness.gaps };
  } catch {
    return { ok: false, reason: 'unparseable' };
  }
}

/** Defect wording when the trusted readiness input is unavailable. */
function readinessUnavailableDefect(reason: 'missing' | 'unparseable'): ContractDefect {
  return {
    code: 'READINESS_UNAVAILABLE',
    message:
      `the current readiness artifact could not be ${reason === 'missing' ? 'read from the declared inputs' : 'parsed'} — ` +
      'escalation identity is validated against the live gap ledger; it is never guessed',
  };
}

// ─── decision-request ─────────────────────────────────────────────────────────

/** The semantic proposal a prepare-human-decision step owes Stratum. */
export interface DecisionRequestProposal {
  type: string;
  /**
   * The model's SELECTION of which HUMAN_DECISION gap to escalate — a
   * semantic choice (which question to ask first), validated to be a gap of
   * exactly that classification in the current readiness. The artifact's
   * linkage authority is this validation, not the string itself.
   */
  targetFactId: string;
  title: string;
  summary: string;
  options: Array<{ id: string; label: string; description: string }>;
}

export const DECISION_REQUEST_PROPOSAL_SCHEMA = z
  .object({
    type: nonEmptyAfterTrim('decision request type'),
    targetFactId: nonEmptyAfterTrim('target fact id'),
    title: nonEmptyAfterTrim('decision request title'),
    summary: nonEmptyAfterTrim('decision request summary'),
    options: z
      .array(
        z
          .object({
            id: nonEmptyAfterTrim('option id'),
            label: nonEmptyAfterTrim('option label'),
            description: nonEmptyAfterTrim('option description'),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export function validateDecisionRequestProposal(
  proposal: DecisionRequestProposal,
  ctx: OutputContractContext,
): readonly ContractDefect[] {
  const defects: ContractDefect[] = [];
  const optionIds = new Set(proposal.options.map((o) => o.id));
  if (optionIds.size !== proposal.options.length) {
    defects.push({ code: 'OPTION_IDS_NOT_UNIQUE', message: 'option ids must be unique' });
  }
  const readiness = currentReadinessGaps(ctx);
  if (!readiness.ok) return [readinessUnavailableDefect(readiness.reason)];
  const eligible = readiness.gaps.filter((g) => g.classification === 'HUMAN_DECISION');
  const eligibleIds = new Set(eligible.map((g) => g.factId).filter((id): id is string => id !== undefined));
  if (eligible.length > 0 && eligibleIds.size === 0) {
    defects.push({
      code: 'DECISION_REQUEST_NO_LINKED_GAPS',
      message:
        'the current readiness classifies gap(s) HUMAN_DECISION but none carries a factId — the readiness ' +
        'artifact predates escalation ownership; re-run the review so escalating gaps carry stable identity',
    });
    return defects;
  }
  if (eligibleIds.size === 0) {
    defects.push({
      code: 'DECISION_REQUEST_NO_HUMAN_GAPS',
      ref: proposal.targetFactId,
      message:
        'the current readiness classifies no gap HUMAN_DECISION — there is nothing to escalate; ' +
        'a decision request may only prepare a question the review actually raised',
    });
    return defects;
  }
  if (!eligibleIds.has(proposal.targetFactId)) {
    defects.push({
      code: 'DECISION_REQUEST_TARGET_NOT_HUMAN_GAP',
      ref: proposal.targetFactId,
      message:
        `targetFactId '${proposal.targetFactId}' is not a fact the current readiness classifies ` +
        `HUMAN_DECISION (eligible: ${[...eligibleIds].join(', ')}) — the question must answer a live gap`,
    });
  }
  return defects;
}

/**
 * Canonical decision-request bytes: deterministic JSON, key order
 * type/targetFactId/title/summary/options, 2-space indent, LF, one final
 * newline. targetFactId is ALWAYS materialized on new writes (DDR-036).
 */
export function renderDecisionRequest(proposal: DecisionRequestProposal, _ctx?: OutputContractContext): string {
  const value = {
    type: toLf(proposal.type),
    targetFactId: toLf(proposal.targetFactId),
    title: toLf(proposal.title),
    summary: toLf(proposal.summary),
    options: proposal.options.map((o) => ({
      id: toLf(o.id),
      label: toLf(o.label),
      description: toLf(o.description),
    })),
  };
  return JSON.stringify(value, null, 2) + '\n';
}

export function createDecisionRequestOutputContract(): OutputContract<DecisionRequestProposal> {
  return {
    modelSchema: DECISION_REQUEST_PROPOSAL_SCHEMA,
    schemaAnnotations: {
      root:
        'Prepare ONE human decision for a fact the latest readiness review classified ' +
        'HUMAN_DECISION. The system serializes the request artifact and carries its fact ' +
        'linkage — you choose WHICH question and WHAT the options mean.',
      fields: {
        '/type': 'A stable discriminator for this kind of decision request.',
        '/targetFactId':
          'The fact id of the HUMAN_DECISION gap this question resolves — copy it exactly from the readiness artifact.',
        '/title': 'One line a human scans under load.',
        '/summary': 'The tradeoff in the terms a human needs to decide it.',
        '/options': 'Two or more genuinely distinct resolutions, each with id, label, description.',
      },
    },
    validate: validateDecisionRequestProposal,
    materialize: renderDecisionRequest,
  };
}

// ─── decision-application ─────────────────────────────────────────────────────

/**
 * The semantic consequence of a resolved human decision. Deliberately
 * contains NO identity: no targetFactId (trusted: the persisted
 * decision-request), no status/source/decisionRef (trusted: the resolved
 * DecisionContext), no goal, and NO facts array — facts other than the
 * target are carried over verbatim and the model cannot touch them.
 * Optional sections REPLACE their persisted counterparts wholesale
 * (explicit full-section semantics — not a patch language); absent sections
 * carry over. bodyMarkdown is the model's own human-facing record.
 */
export interface DecisionApplicationProposal {
  factStatement?: string;
  requirements?: string[];
  constraints?: Array<{ description: string; type: 'must' | 'must_not' | 'prefer' | 'prefer_not' }>;
  nonGoals?: string[];
  acceptance?: Array<{ description: string; met?: boolean }>;
  bodyMarkdown: string;
}

export const DECISION_APPLICATION_PROPOSAL_SCHEMA = z
  .object({
    factStatement: nonEmptyAfterTrim('revised fact statement').optional(),
    requirements: z.array(nonEmptyAfterTrim('requirement')).optional(),
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
  .strict();

/** Trusted resolution inputs, resolved once and shared by validate+merge. */
function resolveTrustedApplicationInputs(
  ctx: OutputContractContext,
): { ok: true; targetFactId: string; definition: DefinitionProposal } | { ok: false; defects: ContractDefect[] } {
  const defects: ContractDefect[] = [];
  if (ctx.decisionContext === undefined) {
    defects.push({
      code: 'DECISION_APPLICATION_NO_RESOLVED_DECISION',
      message:
        'no resolved checkpoint decision is present in the trusted context — decision application runs ' +
        'only on a resumed step carrying the human resolution',
    });
    return { ok: false, defects };
  }
  const requestText = findInputArtifact(ctx, 'decision-request.json');
  if (requestText === undefined) {
    defects.push({
      code: 'DECISION_APPLICATION_REQUEST_UNAVAILABLE',
      message: 'the persisted decision-request artifact could not be read from the declared inputs',
    });
    return { ok: false, defects };
  }
  let targetFactId: unknown;
  try {
    targetFactId = (JSON.parse(requestText) as { targetFactId?: unknown }).targetFactId;
  } catch {
    targetFactId = undefined;
  }
  if (typeof targetFactId !== 'string' || targetFactId.trim() === '') {
    // DDR-036 compat posture: load old, NEVER infer authority.
    defects.push({
      code: 'DECISION_APPLICATION_LEGACY_UNLINKED',
      message:
        'the persisted decision-request carries no targetFactId (legacy/unlinked artifact) — deterministic ' +
        'application refuses to reconstruct the target fact from title/summary prose; the request must be ' +
        're-prepared under escalation ownership',
    });
    return { ok: false, defects };
  }
  const definitionText = findInputArtifact(ctx, 'definition.md');
  if (definitionText === undefined) {
    defects.push({
      code: 'DECISION_APPLICATION_DEFINITION_UNAVAILABLE',
      message: 'the current Definition artifact could not be read from the declared inputs',
    });
    return { ok: false, defects };
  }
  let definition: DefinitionProposal;
  try {
    definition = definitionProposalFromPersisted(definitionText);
  } catch (err) {
    defects.push({
      code: 'DECISION_APPLICATION_DEFINITION_UNPARSEABLE',
      message: `the current Definition artifact does not parse: ${err instanceof Error ? err.message : String(err)}`,
    });
    return { ok: false, defects };
  }
  return { ok: true, targetFactId, definition };
}

export function validateDecisionApplicationProposal(
  proposal: DecisionApplicationProposal,
  ctx: OutputContractContext,
  deps: DefinitionContractDeps = {},
): readonly ContractDefect[] {
  const resolved = resolveTrustedApplicationInputs(ctx);
  if (!resolved.ok) return resolved.defects;
  const target = resolved.definition.facts.find((f) => f.id === resolved.targetFactId);
  if (target === undefined) {
    return [
      {
        code: 'DECISION_APPLICATION_TARGET_MISSING',
        ref: resolved.targetFactId,
        message:
          `the decision-request targets fact '${resolved.targetFactId}' which does not exist in the current ` +
          'Definition ledger — the request and the Definition have diverged; neither is guessed',
      },
    ];
  }
  if (target.status === 'DECIDED') {
    return [
      {
        code: 'DECISION_APPLICATION_ALREADY_APPLIED',
        ref: resolved.targetFactId,
        message: `fact '${resolved.targetFactId}' is already DECIDED — this resolution was already applied`,
      },
    ];
  }
  // The MERGED Definition must satisfy the same mechanical contract as any
  // other Definition write: validate the deterministic merge itself.
  const merged = mergeDecisionApplication(proposal, ctx);
  if (!merged.ok) return merged.defects;
  return validateDefinitionProposal(merged.value, ctx, deps);
}

/**
 * The deterministic merge (DDR-036): current canonical Definition + semantic
 * proposal + trusted identity → the target fact's mechanical transition.
 * Every other fact carries over VERBATIM — the model has no field that can
 * reach them.
 */
export function mergeDecisionApplication(
  proposal: DecisionApplicationProposal,
  ctx: OutputContractContext,
): { ok: true; value: DefinitionProposal } | { ok: false; defects: ContractDefect[] } {
  const resolved = resolveTrustedApplicationInputs(ctx);
  if (!resolved.ok) return { ok: false, defects: resolved.defects };
  const { targetFactId, definition } = resolved;
  const decision = ctx.decisionContext!;
  const facts: CanonicalFact[] = definition.facts.map((f) =>
    f.id === targetFactId
      ? {
          id: f.id,
          statement: toLf(proposal.factStatement !== undefined ? proposal.factStatement : f.statement),
          status: 'DECIDED',
          source: 'decision',
          decisionRef: decision.decisionId,
          ...(f.kind !== undefined ? { kind: f.kind } : {}),
        }
      : { ...f },
  );
  const merged: DefinitionProposal = {
    goal: definition.goal,
    facts,
    ...(proposal.constraints !== undefined || definition.constraints !== undefined
      ? { constraints: proposal.constraints !== undefined ? proposal.constraints : definition.constraints! }
      : {}),
    ...(proposal.requirements !== undefined || definition.requirements !== undefined
      ? { requirements: proposal.requirements !== undefined ? proposal.requirements : definition.requirements! }
      : {}),
    ...(proposal.nonGoals !== undefined || definition.nonGoals !== undefined
      ? { nonGoals: proposal.nonGoals !== undefined ? proposal.nonGoals : definition.nonGoals! }
      : {}),
    ...(proposal.acceptance !== undefined || definition.acceptance !== undefined
      ? { acceptance: proposal.acceptance !== undefined ? proposal.acceptance : definition.acceptance! }
      : {}),
    bodyMarkdown: toLf(proposal.bodyMarkdown),
  };
  return { ok: true, value: merged };
}

/**
 * Canonical bytes: the existing Definition pipeline, unchanged — the merged
 * canonical value goes through the SAME renderer every Definition write
 * uses. No second Definition representation exists.
 */
export function renderDecisionApplication(proposal: DecisionApplicationProposal, ctx: OutputContractContext): string {
  const merged = mergeDecisionApplication(proposal, ctx);
  if (!merged.ok) {
    throw new Error(merged.defects.map((d) => `${d.code}: ${d.message}`).join('; '));
  }
  return renderDefinition(merged.value, ctx);
}

export function createDecisionApplicationOutputContract(
  deps: DefinitionContractDeps = {},
): OutputContract<DecisionApplicationProposal> {
  return {
    modelSchema: DECISION_APPLICATION_PROPOSAL_SCHEMA,
    schemaAnnotations: {
      root:
        'Record what the human\'s resolved decision MEANS for this Definition. The system already knows ' +
        'the target fact, the resolved Decision id, and the selected option — it performs the ledger ' +
        'transition itself. You propose only semantic consequences: an optional revised fact statement, ' +
        'any sections the resolution changes (full-section replacement), and the body. You have no field ' +
        'for facts, statuses, decision references, or the goal — and cannot touch them.',
      fields: {
        '/factStatement':
          "Optional: the target fact's statement, revised to reflect the resolution. Omit to keep the current statement.",
        '/requirements': 'Optional: the COMPLETE requirements list as it now stands (replaces the current list).',
        '/constraints': 'Optional: the COMPLETE constraints list as it now stands (replaces the current list).',
        '/nonGoals': 'Optional: the COMPLETE non-goals list as it now stands (replaces the current list).',
        '/acceptance': 'Optional: the COMPLETE acceptance list as it now stands (replaces the current list).',
        '/bodyMarkdown': 'The human-facing record of this decision\'s consequences.',
      },
    },
    validate: (value, ctx) => validateDecisionApplicationProposal(value, ctx, deps),
    materialize: renderDecisionApplication,
  };
}

// ─── exploration-need ─────────────────────────────────────────────────────────

export const EXPLORATION_SCHEMA_VERSION = 1;

/** The semantic proposal a record-exploration-need step owes Stratum. */
export interface ExplorationNeedProposal {
  /** The model's SELECTION of which EXPLORE_AS_WORK gap to record. */
  targetFactId: string;
  question: string;
  whyNotResolvableByReading: string;
  requiredWork: string;
  completionEvidence: string;
  /** Optional human-facing explanation below the front matter. */
  bodyMarkdown?: string;
}

export const EXPLORATION_NEED_PROPOSAL_SCHEMA = z
  .object({
    targetFactId: nonEmptyAfterTrim('target fact id'),
    question: nonEmptyAfterTrim('exploration question'),
    whyNotResolvableByReading: nonEmptyAfterTrim('why reading cannot resolve it'),
    requiredWork: nonEmptyAfterTrim('required work'),
    completionEvidence: nonEmptyAfterTrim('completion evidence'),
    bodyMarkdown: z.string().optional(),
  })
  .strict();

export function validateExplorationNeedProposal(
  proposal: ExplorationNeedProposal,
  ctx: OutputContractContext,
): readonly ContractDefect[] {
  const readiness = currentReadinessGaps(ctx);
  if (!readiness.ok) return [readinessUnavailableDefect(readiness.reason)];
  const eligibleIds = new Set(
    readiness.gaps
      .filter((g) => g.classification === 'EXPLORE_AS_WORK')
      .map((g) => g.factId)
      .filter((id): id is string => id !== undefined),
  );
  if (eligibleIds.size === 0) {
    return [
      {
        code: 'EXPLORATION_NEED_NO_EXPLORE_GAPS',
        ref: proposal.targetFactId,
        message:
          'the current readiness classifies no gap EXPLORE_AS_WORK — there is nothing to record; an ' +
          'exploration need answers a gap the review actually raised',
      },
    ];
  }
  if (!eligibleIds.has(proposal.targetFactId)) {
    return [
      {
        code: 'EXPLORATION_NEED_TARGET_NOT_EXPLORE_GAP',
        ref: proposal.targetFactId,
        message:
          `targetFactId '${proposal.targetFactId}' is not a fact the current readiness classifies ` +
          `EXPLORE_AS_WORK (eligible: ${[...eligibleIds].join(', ')})`,
      },
    ];
  }
  return [];
}

/**
 * Canonical exploration-need bytes: versioned front matter + human-readable
 * body (NOT opaque JSON — humans audit these). Same envelope discipline as
 * the definition/readiness renderers (§10.6/§10.7): `---\n` + YAML +
 * `\n---\n`, one blank line before a non-empty body, exactly one `\n` at
 * EOF, LF-normalized, model strings never trimmed or reflowed.
 */
export function renderExplorationNeed(proposal: ExplorationNeedProposal, _ctx?: OutputContractContext): string {
  const front = yaml.dump(
    {
      schemaVersion: EXPLORATION_SCHEMA_VERSION,
      targetFactId: toLf(proposal.targetFactId),
      question: toLf(proposal.question),
      whyNotResolvableByReading: toLf(proposal.whyNotResolvableByReading),
      requiredWork: toLf(proposal.requiredWork),
      completionEvidence: toLf(proposal.completionEvidence),
    },
    YAML_DUMP_OPTIONS,
  );
  const body = toLf(proposal.bodyMarkdown ?? '');
  const bodyPart = body.length > 0 ? `\n\n${body.replace(/\n+$/, '')}\n` : '\n';
  return `---\n${front}---${bodyPart}`;
}

/**
 * Tolerant load path (DDR-036 compat): canonical artifacts parse typed;
 * anything else — including legacy free-form exploration markdown — parses
 * as { legacy: true }. Legacy artifacts carry NO linkage authority: callers
 * requiring deterministic identity treat legacy as unlinked, never infer.
 */
export type ExplorationNeedParseResult =
  | { ok: true; legacy: false; value: ExplorationNeedProposal }
  | { ok: true; legacy: true }
  | { ok: false; error: string };

export function parseExplorationNeed(text: string): ExplorationNeedParseResult {
  if (!text.startsWith('---\n')) return { ok: true, legacy: true };
  const end = text.indexOf('\n---\n', 4);
  if (end === -1) return { ok: true, legacy: true };
  let front: unknown;
  try {
    front = yaml.load(text.slice(4, end + 1));
  } catch {
    return { ok: true, legacy: true };
  }
  if (front === null || typeof front !== 'object') return { ok: true, legacy: true };
  const obj = front as Record<string, unknown>;
  const required = ['targetFactId', 'question', 'whyNotResolvableByReading', 'requiredWork', 'completionEvidence'];
  if (required.some((k) => typeof obj[k] !== 'string' || (obj[k] as string).trim() === '')) {
    return { ok: true, legacy: true };
  }
  const parsed = EXPLORATION_NEED_PROPOSAL_SCHEMA.safeParse({
    targetFactId: obj.targetFactId,
    question: obj.question,
    whyNotResolvableByReading: obj.whyNotResolvableByReading,
    requiredWork: obj.requiredWork,
    completionEvidence: obj.completionEvidence,
    ...(typeof obj.bodyMarkdown === 'string' ? { bodyMarkdown: obj.bodyMarkdown } : {}),
  });
  if (!parsed.success) {
    return { ok: false, error: `Exploration-need front matter is structurally invalid: ${parsed.error.message}` };
  }
  return { ok: true, legacy: false, value: parsed.data };
}

export function createExplorationNeedOutputContract(): OutputContract<ExplorationNeedProposal> {
  return {
    modelSchema: EXPLORATION_NEED_PROPOSAL_SCHEMA,
    schemaAnnotations: {
      root:
        'Record ONE exploration need for a fact the latest readiness review classified EXPLORE_AS_WORK. ' +
        'The system serializes the artifact and carries the fact linkage — you choose what the exploration ' +
        'must answer and what completing it means.',
      fields: {
        '/targetFactId':
          'The fact id of the EXPLORE_AS_WORK gap this need records — copy it exactly from the readiness artifact.',
        '/question': 'The empirical question that blocks the fact.',
        '/whyNotResolvableByReading': 'Why reading the repository cannot answer it.',
        '/requiredWork': 'The build/measure work answering it requires.',
        '/completionEvidence': 'What observable evidence would prove it answered.',
        '/bodyMarkdown': 'Optional human-facing context below the machine-readable front matter.',
      },
    },
    validate: validateExplorationNeedProposal,
    materialize: renderExplorationNeed,
  };
}
