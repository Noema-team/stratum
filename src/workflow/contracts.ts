// D.34 C1 — the OutputContract seam (DDR-034 §5).
//
// Ownership (dependency direction, DDR-034 §5.4): methodology owns meaning
// (semantic types, zod schemas, validators, renderers, contract instances);
// THIS module owns only the SHAPE of the seam and the pinned schema-
// projection adapter. It imports no methodology, no transport, no runner —
// and nothing here may ever import it from AgentLoop (the loop receives a
// plain acceptor callback, typed structurally at its call sites).
//
// The principle (DDR-034): models propose; Stratum materializes. A contract
// declares what semantic information the model owes the system; the system
// decodes it (zod — always the runtime authority), validates methodology
// invariants (plain code, structured defects), projects deterministic
// control, and materializes canonical artifact bytes.
//
// IDENTITY — deliberately absent. OutputContract has NO `id` field. A
// contract's identity is exclusively the trusted registry key selected by
// the workflow's own declaration:
//
//   WorkflowStep.outputArtifact.type → outputContracts[type] → this contract
//
// An `id` would allow contradictory configuration
// (outputContracts["definition"] = { id: "definition-readiness", … }) to be
// representable; without one it is unrepresentable. Diagnostics use the
// registry key (the declared artifact type).
import type { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

// ─── Context ──────────────────────────────────────────────────────────────────

/**
 * Context the runner passes alongside a typed proposal. Deliberately tiny —
 * the same minimal context the D.3d.5 InputValidator seam carries. Anything
 * more would be a scope widening; authority resolution (e.g. Decision
 * lookup) arrives through closures baked at the composition root, not
 * through this context.
 */
export interface OutputContractContext {
  workItemId?: string;
}

// ─── Defects ──────────────────────────────────────────────────────────────────

/**
 * A structured, mechanically-decided methodology defect — the result-repair
 * layer's vocabulary. Deliberately parallel to the DefinitionDefect shape
 * the deterministic input gate already feeds the refine path, so defect
 * wording can stay identical across both seams.
 */
export interface ContractDefect {
  code: string;
  message: string;
  /** Fact id / gap target / path into the proposal, where meaningful. */
  ref?: string;
}

// ─── Structured schema annotations ────────────────────────────────────────────

/**
 * Structured teaching annotations layered OVER the generated projection —
 * never an independent field/constraint definition. `fields` keys are
 * JSON-Pointer-style paths into the generated projection and are
 * MECHANICALLY validated against it (validateSchemaAnnotations): an
 * unresolvable key fails the build. `root` is prose about the payload as a
 * whole and declares no fields.
 */
export interface SchemaAnnotations {
  readonly root?: string;
  readonly fields?: Readonly<Record<string, string>>;
}

// ─── Control derivation ───────────────────────────────────────────────────────

/**
 * Deterministic route-derivation outcome. Structurally identical to the
 * methodology-owned ReviewRouteDerivation (readiness-artifact.ts) — the
 * readiness contract's deriver returns that type and satisfies this without
 * an import; the seam stays methodology-free.
 */
export type RouteDerivation = { ok: true; route: string } | { ok: false; error: string };

// ─── The contract ─────────────────────────────────────────────────────────────

export interface OutputContract<T> {
  /**
   * THE single canonical semantic shape the model is responsible for — the
   * single authority for the STRUCTURAL model-facing schema: fields,
   * structural types, optionality, projection-safe structural constraints.
   * schemaVersion is NOT in it (system-injected at materialization).
   * Cross-field / runtime-authority methodology invariants (DECIDED↔
   * decisionRef pairing, provenance resolution) belong exclusively to
   * `validate` — constraints exist in two places by design, split by kind,
   * never duplicated. Every provider-facing representation is DERIVED from
   * this schema; nothing else is authoritative.
   */
  readonly modelSchema: z.ZodType<T>;

  /**
   * Structured teaching annotations layered OVER the generated projection —
   * never an independent field/constraint definition. `fields` keys are
   * conformance-tested against the projection; `root` is prose.
   */
  readonly schemaAnnotations?: SchemaAnnotations;

  /**
   * Context-aware mechanical methodology validation beyond the schema —
   * plain code over the decoded T, NEVER zod refinements (structured defect
   * codes and authority-resolution closures would degrade into anonymous
   * schema errors). Absent = the schema is the whole mechanical contract.
   * Violations are producer-result defects: one bounded in-step result
   * repair, never a workflow iteration; exhaustion fails closed before
   * write (DDR-034 §5.3).
   */
  validate?(value: T, ctx: OutputContractContext): readonly ContractDefect[];

  /**
   * Required exactly for review contracts (step declares
   * requiresReviewVerdict). The verdict is part of the semantic payload —
   * one judgment, one encoding; the transport preamble is not consulted on
   * the contract path.
   */
  reviewVerdict?(value: T): 'pass' | 'fail';

  /**
   * Optional deterministic control projection (review contracts). Receives
   * typed values — the contract path never parses artifact bytes to derive
   * control.
   */
  deriveRoute?(
    value: T,
    declaredRoutes: readonly string[],
  ): RouteDerivation;

  /**
   * Deterministic canonical rendering — the system, not the model, authors
   * canonical bytes. PURE: same (value, static config) → same bytes (the
   * artifact provenance dedupes by content hash). Injects schemaVersion.
   * No clock, no randomness, no fs, no env.
   */
  materialize(value: T, ctx: OutputContractContext): string;
}

/** Registry shape on AgentRunnerConfig (composition root populates it). */
export type OutputContractRegistry = Record<string, OutputContract<unknown>>;

// ─── Result-repair acceptor ───────────────────────────────────────────────────

/**
 * The generic result-acceptance callback (DDR-034 §5.3). Composed by the
 * AgentRunner from the resolved contract — decode (schema.safeParse) then
 * validate (contract.validate) — and passed to BOTH execution paths as a
 * plain function. The loop's knowledge is exactly: call it; on
 * `{ ok: false }` continue the conversation with the given instruction,
 * budget permitting. It never sees contracts or methodology.
 */
export type ResultAcceptor = (
  value: unknown,
) => { ok: true } | { ok: false; repairInstruction: string };

/**
 * Compose the acceptor for a resolved contract. Decode failures render
 * zod diagnostics; validate failures render structured defect codes with
 * the same wording discipline the refine path consumes.
 */
export function createResultAcceptor<T>(
  contract: OutputContract<T>,
  ctx: OutputContractContext,
  artifactType: string,
): ResultAcceptor {
  return (value: unknown) => {
    const parsed = contract.modelSchema.safeParse(value);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      return {
        ok: false,
        repairInstruction: renderResultRepairInstruction(
          artifactType,
          `the submitted result does not match the required semantic shape — ${issues}`,
        ),
      };
    }
    const defects = contract.validate?.(parsed.data, ctx) ?? [];
    if (defects.length > 0) {
      const rendered = defects
        .map((d) => `${d.code}${d.ref ? ` (${d.ref})` : ''}: ${d.message}`)
        .join('; ');
      return {
        ok: false,
        repairInstruction: renderResultRepairInstruction(artifactType, rendered),
      };
    }
    return { ok: true };
  };
}

/**
 * Shared repair-instruction wording for the result-repair layer. The loop
 * delivers it verbatim (as a user turn on the textual channel, as a
 * tool_result payload on a submit-result channel).
 */
export function renderResultRepairInstruction(artifactType: string, reason: string): string {
  return (
    `Your submitted result was rejected by the output contract for '${artifactType}'. ` +
    `Reason: ${reason}\n` +
    'Re-submit the complete corrected result in the same required shape. Do not change ' +
    'anything that was not rejected.'
  );
}

// ─── Pinned schema-projection adapter ─────────────────────────────────────────

/**
 * Pinned conversion options. Changing ANY of these — or bumping
 * zod-to-json-schema — requires regenerating the projection golden fixtures
 * in the same commit, with the byte diff reviewed (DDR-034 §5.1).
 *
 * - target 'jsonSchema7': plain JSON Schema for tool/response-format use.
 * - $refStrategy 'none': fully inlined, self-contained projections — tool
 *   definitions must not carry external $refs.
 */
const PROJECTION_OPTIONS = {
  target: 'jsonSchema7',
  $refStrategy: 'none',
} as const;

/**
 * The pinned adapter: modelSchema → provider-facing JSON Schema. This is a
 * GENERATED PROJECTION, never a second authority; Zod decode is always the
 * runtime authority, and constraints that do not project faithfully remain
 * enforced at decode/validate (DDR-034 §5.1 projection fidelity).
 */
export function toJsonSchema(modelSchema: z.ZodType<unknown>): Record<string, unknown> {
  return zodToJsonSchema(modelSchema, PROJECTION_OPTIONS) as Record<string, unknown>;
}

/**
 * Resolve a JSON-Pointer-style path ("/a/b" or "/facts/items/0") against a
 * generated projection. Used by the annotation conformance check.
 * `items` segments address the array-item schema JSON Schema produces.
 */
function resolvePointer(schema: unknown, pointer: string): { ok: true } | { ok: false; error: string } {
  if (!pointer.startsWith('/')) return { ok: false, error: `annotation key '${pointer}' must be a JSON-Pointer path starting with '/'` };
  let node: unknown = schema;
  for (const rawSegment of pointer.split('/').slice(1)) {
    const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (node === null || typeof node !== 'object') {
      return { ok: false, error: `annotation key '${pointer}' does not resolve: '${segment}' addresses a non-object node` };
    }
    const obj = node as Record<string, unknown>;
    if (segment === 'items' && typeof obj.items === 'object') {
      node = obj.items;
      continue;
    }
    if (typeof obj.properties === 'object' && obj.properties !== null && segment in (obj.properties as Record<string, unknown>)) {
      node = (obj.properties as Record<string, unknown>)[segment];
      continue;
    }
    if (typeof obj.additionalProperties === 'object' && obj.additionalProperties !== null) {
      node = obj.additionalProperties;
      continue;
    }
    return { ok: false, error: `annotation key '${pointer}' does not resolve in the generated projection (segment '${segment}' not found)` };
  }
  return { ok: true };
}

/**
 * The mechanical annotation-conformance check (DDR-034 §5.1): every
 * `schemaAnnotations.fields` key MUST resolve against the generated
 * projection. Fails with a build-worthy error list. `root` prose is not
 * key-checked (it declares no fields).
 */
export function validateSchemaAnnotations(
  modelSchema: z.ZodType<unknown>,
  annotations: SchemaAnnotations | undefined,
): { ok: true } | { ok: false; errors: string[] } {
  if (!annotations?.fields) return { ok: true };
  const projection = toJsonSchema(modelSchema);
  const errors: string[] = [];
  for (const key of Object.keys(annotations.fields)) {
    const resolved = resolvePointer(projection, key);
    if (!resolved.ok) errors.push(resolved.error);
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/**
 * The teaching renderer: generated projection + structured annotations.
 * Consumed verbatim by transports via TransportContext.resultSchemaText —
 * transports never learn what a Definition is.
 */
export function renderSchemaTeaching(contract: OutputContract<unknown>): string {
  const projection = toJsonSchema(contract.modelSchema);
  const lines: string[] = [
    'RESULT SHAPE (your reply must carry this semantic payload — the system serializes the artifact itself):',
    JSON.stringify(projection, null, 2),
  ];
  if (contract.schemaAnnotations?.root) {
    lines.push('', contract.schemaAnnotations.root);
  }
  if (contract.schemaAnnotations?.fields) {
    for (const [key, note] of Object.entries(contract.schemaAnnotations.fields)) {
      lines.push(`- ${key}: ${note}`);
    }
  }
  return lines.join('\n');
}
