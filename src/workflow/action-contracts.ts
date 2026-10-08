// BUILD Edit Protocol v1 — the ActionContract seam (docs/specs/build-edit-protocol-v1.md §3).
//
// A sibling of OutputContract, deliberately NOT a variant of it: OutputContract
// materializes ONE canonical artifact string, while an action proposal stages a
// MULTI-FILE changeset against repository state. The seams share the DDR-034
// vocabulary (modelSchema as the single structural authority, structured
// ContractDefect validation, bounded in-loop repair) and the identity discipline
// (no `id` field; identity is exclusively the trusted WorkflowStep declaration
// — here `actionArtifact.type` → actionContracts[type] — resolved at the
// composition root; the model, the transport, and the provider never name a
// contract).
//
// Ownership / dependency direction mirrors contracts.ts: methodology owns
// meaning (schemas, validators, staging); THIS module owns only the shape of
// the seam. It imports no transport, no runner, no loop.

import type { z } from 'zod';
import type {
  ContractDefect,
  OutputContractContext,
  ResultAcceptor,
  SchemaAnnotations,
} from './contracts.js';
import { toJsonSchema } from './contracts.js';
import type { EditPolicy } from './types.js';
import type { SourceAnchor, SourceAnchorRecord } from './anchored-edits.js';

// ─── Contexts ─────────────────────────────────────────────────────────────────

/**
 * Context for in-loop proposal validation. `resolveAnchor` is the runner-
 * injected, run-scoped resolution view over the step execution's AnchorRegistry
 * — an anchor minted in another execution resolves to undefined (fail closed,
 * repairable). Contracts receive NO raw fs access.
 */
export interface ActionContractContext {
  workItemId?: string;
  /**
   * P2-B — trusted, runner-computed authority fact: are file-create
   * operations legal under the frozen task authority at all? Computed
   * mechanically (every editPolicy.allowedEditPaths entry already exists on
   * disk ⇒ no legal create target ⇒ false). Absent/true ⇒ the full action
   * surface, unchanged. NEVER derived from model output.
   */
  createsAuthorized?: boolean;
  resolveAnchor?(anchorId: string): SourceAnchor | undefined;
  /** The step's task-scoped edit authorization when declared (E27r). */
  editPolicy?: EditPolicy;
}

/** Minimal read-only disk view staging may use (runner-injected; fakes in tests). */
export interface ActionStageIo {
  readFile(relPath: string): Promise<string>;
  fileExists(relPath: string): Promise<boolean>;
}

export interface ActionStageContext {
  workItemId?: string;
  io: ActionStageIo;
  /**
   * Run-scoped anchor resolution for stage-time re-verification (same
   * registry view the in-loop validate used). Cross-execution anchors are
   * unresolvable here too.
   */
  resolveStageAnchor?(anchorId: string): SourceAnchor | undefined;
}

// ─── Staged changeset ─────────────────────────────────────────────────────────

export interface StagedEdit {
  op: 'replace' | 'create';
  path: string;
  /** Present for replace — the anchor this edit was staged against. */
  anchor_id?: string;
  /**
   * P2-B — evidence that this replace was materialized by deterministic
   * boundary composition (protocol v1.1): the source anchor ids that were
   * composed, in ascending span order. Absent for plain single-anchor edits.
   */
  composed_from?: string[];
  /** Full-file sha256 before the edit; null for creates. */
  before_sha256: string | null;
  after_sha256: string;
  /** Final whole-file bytes Stratum decided. */
  content: string;
  /** Stratum-generated unified diff — audit evidence, never applied. */
  diff: string;
}

/**
 * P2-B — authoritative per-composition evidence, emitted by staging (NEVER
 * reconstructed by the runner): one record per boundary-composed span.
 * `replacement_sha256` hashes the composed replacement bytes (the exact
 * `A + B[1:]` string that was spliced); `result_file_sha256` hashes the final
 * staged file bytes after ALL spans for that file were applied. Both are
 * computed here, from the correct bytes, at the moment of staging.
 */
export interface CompositionEvidence {
  path: string;
  /** The minted source anchor ids that were composed, in ascending span order. */
  source_anchor_ids: string[];
  /** The composed span in the base (source) file's line numbering. */
  start_line: number;
  end_line: number;
  /** sha256 (utf-8) of the composed replacement bytes. */
  replacement_sha256: string;
  /** sha256 (utf-8) of the final staged file bytes for `path`. */
  result_file_sha256: string;
}

export interface StagedChangeset {
  edits: StagedEdit[];
  /** Present (possibly empty) when staging succeeded — authoritative composition records. */
  compositions?: readonly CompositionEvidence[];
}

export type StageOutcome =
  | { ok: true; changeset: StagedChangeset }
  | { ok: false; error: string };

// ─── The contract ─────────────────────────────────────────────────────────────

export interface ActionContract<T> {
  /**
   * THE single canonical semantic shape the model submits — the only authority
   * for the submit_result tool projection. Strictness lives here: keys the
   * schema does not declare (a model-supplied hunk count, a copied hash) are
   * decode rejections with a bounded in-loop repair.
   */
  // input side is `unknown`: schemas may canonicalize (e.g. P2-B makes a
  // missing `creates` default to []), so input and output types differ.
  readonly modelSchema: z.ZodType<T, z.ZodTypeDef, unknown>;

  /**
   * P2-B — optional policy-specialized MODEL-FACING projection. When present,
   * the runner derives the submit_result wire schema, the loop teaching, and
   * the in-loop decode from THIS schema instead of `modelSchema`, projecting
   * the frozen action authority before the model ever submits (e.g. a task
   * whose allowed edit paths all already exist offers no create operation at
   * all). The projection may only NARROW: every value valid under it must be
   * valid under `modelSchema`, and `validate`/`stage` always re-run their
   * authoritative checks on the decoded value regardless of the projection.
   * Absent ⇒ `modelSchema` is used verbatim (ordinary full support).
   */
  projectModelSchema?(ctx: ActionContractContext): z.ZodType<unknown, z.ZodTypeDef, unknown>;

  readonly schemaAnnotations?: SchemaAnnotations;

  /** Static/contextual teaching appended to the schema projection. */
  readonly contextTeaching?: (ctx: OutputContractContext) => string | undefined;

  /**
   * In-loop, REPAIRABLE validation (bounded result repair; exhaustion fails
   * the step closed before anything is written): structural methodology over
   * the decoded proposal — anchor resolution, duplicates, overlaps, path
   * authorization. NEVER zod refinements (structured defect codes would
   * degrade into anonymous schema errors).
   */
  validate?(value: T, ctx: ActionContractContext): readonly ContractDefect[];

  /**
   * AUTHORITATIVE staging (post-loop, NOT repairable — the loop has closed;
   * failures here fail the step exactly like a stale SLE-PATCH base does
   * today): resolve anchors again, read disk, verify the frozen base hash,
   * splice exact spans, compute final bytes and the audit diff. Read-only
   * against the repository; the runner owns writes and every publication gate.
   */
  stage(value: T, ctx: ActionStageContext): Promise<StageOutcome>;
}

/** Registry shape on AgentRunnerConfig (composition root populates it). */
export type ActionContractRegistry = Record<string, ActionContract<unknown>>;

// ─── Acceptor (in-loop gate) ──────────────────────────────────────────────────

/**
 * Compose the loop acceptor for an action contract — decode (zod) then
 * validate (contract.validate). Same shape and repair discipline as
 * createResultAcceptor; the wording names the action contract layer.
 */
export function createActionAcceptor<T>(
  contract: ActionContract<T>,
  ctx: ActionContractContext,
  artifactType: string,
  // P2-B (single projection) — the runner computes the projected schema ONCE
  // per execution and supplies the SAME instance it used for the wire
  // projection and the teaching renderer. When absent, the acceptor derives
  // it (contract-level tests / legacy call shape).
  projectedSchema?: z.ZodType<unknown, z.ZodTypeDef, unknown>,
): ResultAcceptor {
  const decodeSchema = projectedSchema ?? contract.projectModelSchema?.(ctx) ?? contract.modelSchema;
  return (value: unknown) => {
    const parsed = decodeSchema.safeParse(value);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      return {
        ok: false,
        repairInstruction: renderActionRepairInstruction(
          artifactType,
          `the submitted proposal does not match the required semantic shape — ${issues}`,
        ),
      };
    }
    // P2-B — the projected surface may only NARROW, so its decoded output is
    // always re-canonicalized through the contract's canonical schema before
    // semantic validation (e.g. an omitted `creates` becomes the canonical
    // empty list the rest of the pipeline expects). A narrowing projection's
    // output re-decoding as canonical is a structural invariant; failure here
    // is an authoring error and fails closed.
    let decoded: unknown = parsed.data;
    if (decodeSchema !== contract.modelSchema) {
      const canonical = contract.modelSchema.safeParse(parsed.data);
      if (!canonical.success) {
        return {
          ok: false,
          repairInstruction: renderActionRepairInstruction(
            artifactType,
            'the projected decode is not canonicalizable — contract authoring error (fail closed)',
          ),
        };
      }
      decoded = canonical.data;
    }
    const defects = contract.validate?.(decoded as T, ctx) ?? [];
    if (defects.length > 0) {
      const rendered = defects
        .map((d) => `${d.code}${d.ref ? ` (${d.ref})` : ''}: ${d.message}`)
        .join('; ');
      return {
        ok: false,
        repairInstruction: renderActionRepairInstruction(artifactType, rendered),
      };
    }
    return { ok: true };
  };
}

export function renderActionRepairInstruction(artifactType: string, reason: string): string {
  return (
    `Your submitted proposal was rejected by the action contract for '${artifactType}'. ` +
    `Reason: ${reason}\n` +
    'Re-submit the complete corrected proposal in the same required shape. Do not change ' +
    'anything that was not rejected.'
  );
}

// ─── Teaching ─────────────────────────────────────────────────────────────────

/**
 * Schema teaching for an action step: generated projection + structured
 * annotations + optional contextual teaching. Consumed by the loop's
 * TransportContext.resultSchemaText; transports never learn what a changeset is.
 *
 * P2-B (single projection) — the field annotations are FILTERED against the
 * actual projected schema's top-level properties: a field the projection
 * removed (e.g. `creates` under a no-create-target authority) contributes
 * ZERO teaching text, so the taught surface never names an operation the
 * wire schema does not offer.
 */
export function renderActionSchemaTeaching(contract: ActionContract<unknown>, schema?: z.ZodType<unknown>): string {
  const projection = toJsonSchema(schema ?? contract.modelSchema) as {
    properties?: Record<string, unknown>;
  };
  const lines: string[] = [
    'RESULT SHAPE (your final submit_result call must carry this semantic payload — the system materializes the edits itself):',
    JSON.stringify(projection, null, 2),
  ];
  if (contract.schemaAnnotations?.root) {
    lines.push('', contract.schemaAnnotations.root);
  }
  if (contract.schemaAnnotations?.fields) {
    const properties = projection.properties ?? {};
    for (const [key, note] of Object.entries(contract.schemaAnnotations.fields)) {
      const fieldName = key.startsWith('/properties/') ? key.slice('/properties/'.length) : undefined;
      if (fieldName !== undefined && properties[fieldName] === undefined) continue;
      lines.push(`- ${key}: ${note}`);
    }
  }
  return lines.join('\n');
}

// ─── Anchor-mint callback shape (structural; the loop stays import-free) ──────

export type MintSourceAnchor = (record: SourceAnchorRecord) => string;
