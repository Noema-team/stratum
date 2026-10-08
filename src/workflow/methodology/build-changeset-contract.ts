// BUILD Edit Protocol v1 — the build-changeset ActionContract (methodology instance).
//
// docs/specs/build-edit-protocol-v1.md. The model submits ONLY:
//   { edits: [{ anchor_id, replacement }], creates: [{ path, content }] }
// Everything byte-sensitive about the OLD world — hunk counts, oldStart
// arithmetic, context whitespace, base-hash strings, SLE patch/artifact
// markers, diff line prefixes — is absent from the schema, so the campaign's
// six-for-six BUILD serialization failures are unrepresentable by construction.
// The model proposes; Stratum materializes (exact spans from hash-pinned
// anchors, exact old bytes from disk).

import { z } from 'zod';
import { createHash } from 'crypto';
import { toSafeRelativePath } from '../../path-safety.js';
import {
  renderCreatedFileDiff,
  renderSpanDiff,
  spliceLineSpan,
  spansOverlap,
} from '../anchored-edits.js';
import type {
  ActionContract,
  ActionContractContext,
  ActionStageContext,
  CompositionEvidence,
  StagedEdit,
  StageOutcome,
} from '../action-contracts.js';
import type { ContractDefect } from '../contracts.js';

export const BUILD_CHANGESET_ARTIFACT_TYPE = 'build-changeset';

// Parity with the legacy textual patch path's extension allowlist
// (src/output-parser.ts ALLOWED_EXTENSIONS). Deliberately a separate constant:
// the transport layer stays import-free of methodology, and vice versa.
const CREATABLE_EXTENSIONS = ['.md', '.ts', '.js', '.json', '.yaml', '.yml', '.txt', '.sh', '.py'] as const;

/** Whole-proposal cardinality bounds (generous; the wire budget binds first). */
const MAX_EDITS = 64;
const MAX_CREATES = 64;

export const BuildEditProposalSchema = z
  .object({
    edits: z
      .array(
        z
          .object({
            anchor_id: z.string().min(1),
            replacement: z.string(),
          })
          .strict(),
      )
      .max(MAX_EDITS),
    // P2-B (protocol v1.1 deterministic closure, part A): an omitted `creates`
    // is semantically identical to an empty one — the model is never asked to
    // serialize that distinction. The key remains STRICT when present (no
    // unknown keys), and the authoritative post-submission create checks
    // (safety, extension, task-scoped authorization, no-overwrite) are
    // unchanged: a NON-EMPTY creates is still fully validated, never dropped.
    creates: z
      .array(
        z
          .object({
            path: z.string().min(1),
            content: z.string(),
          })
          .strict(),
      )
      .max(MAX_CREATES)
      .default([]),
  })
  .strict();

// P2-B (part B) — the policy-specialized action surface. When the frozen task
// authority leaves zero legal create targets (see ActionContractContext
// .createsAuthorized), the MODEL-FACING schema omits `creates` entirely: the
// model can never spend tokens proposing an operation Stratum knows is
// impossible. A submission that carries `creates` anyway is an unknown-key
// decode rejection (repairable, never silently discarded). This projection can
// only NARROW — every proposal valid under it is valid under the canonical
// schema, and all authoritative checks still run on whatever is decoded.
export const BuildEditProposalNoCreatesSchema = z
  .object({
    edits: BuildEditProposalSchema.shape.edits,
  })
  .strict();

export type BuildEditProposal = z.infer<typeof BuildEditProposalSchema>;

// ─── validate (in-loop, repairable) ───────────────────────────────────────────

function validateProposal(
  value: BuildEditProposal,
  ctx: ActionContractContext,
): readonly ContractDefect[] {
  const defects: ContractDefect[] = [];

  if (value.edits.length === 0 && value.creates.length === 0) {
    return [
      {
        code: 'empty-changeset',
        message:
          'the proposal contains no edits and no creates — read the target region with read_source_slice, then submit at least one anchored edit or file creation',
      },
    ];
  }

  // Creates: path safety, extension, task-scoped authorization, duplicates.
  const createPaths = new Set<string>();
  for (const create of value.creates) {
    const canonical = toSafeRelativePath(create.path);
    if (canonical === null) {
      defects.push({
        code: 'unsafe-create-path',
        ref: create.path,
        message: `'${create.path}' is not a safe repo-relative path`,
      });
      continue;
    }
    if (createPaths.has(canonical)) {
      defects.push({
        code: 'duplicate-create-path',
        ref: canonical,
        message: `two creates target the same path '${canonical}'`,
      });
      continue;
    }
    createPaths.add(canonical);
    if (!CREATABLE_EXTENSIONS.some((ext) => canonical.endsWith(ext))) {
      defects.push({
        code: 'create-extension-not-allowed',
        ref: canonical,
        message: `'${canonical}' does not end in an allowed extension [${CREATABLE_EXTENSIONS.join(' ')}]`,
      });
    }
    if (ctx.editPolicy && !ctx.editPolicy.allowedEditPaths.includes(canonical)) {
      defects.push({
        code: 'unauthorized-create-path',
        ref: canonical,
        message: `'${canonical}' is outside this task's authorized edit set [${ctx.editPolicy.allowedEditPaths.join(', ')}]`,
      });
    }
  }

  // Edits: anchor resolution, duplicates, authorization, per-file overlap.
  const seenAnchors = new Set<string>();
  const resolvedByPath = new Map<string, Array<{ anchor_id: string; start_line: number; end_line: number; path: string; base_sha256: string; replacement: string }>>();
  for (const edit of value.edits) {
    if (seenAnchors.has(edit.anchor_id)) {
      defects.push({
        code: 'duplicate-anchor',
        ref: edit.anchor_id,
        message: `anchor '${edit.anchor_id}' is referenced by more than one edit`,
      });
      continue;
    }
    seenAnchors.add(edit.anchor_id);
    const anchor = ctx.resolveAnchor?.(edit.anchor_id);
    if (!anchor) {
      defects.push({
        code: 'unknown-anchor',
        ref: edit.anchor_id,
        message:
          `anchor '${edit.anchor_id}' was not issued in this step execution. Use an anchor_id previously issued by ` +
          `read_source_slice in this execution. If no issued anchor represents the intended source region, the proposal ` +
          `cannot be repaired in this synthesis phase and must fail closed.`,
      });
      continue;
    }
    if (ctx.editPolicy && !ctx.editPolicy.allowedEditPaths.includes(anchor.path)) {
      defects.push({
        code: 'unauthorized-edit-path',
        ref: anchor.path,
        message: `anchored edit target '${anchor.path}' is outside this task's authorized edit set [${ctx.editPolicy.allowedEditPaths.join(', ')}]`,
      });
    }
    const list = resolvedByPath.get(anchor.path) ?? [];
    list.push({ anchor_id: edit.anchor_id, start_line: anchor.start_line, end_line: anchor.end_line, path: anchor.path, base_sha256: anchor.base_sha256, replacement: edit.replacement });
    resolvedByPath.set(anchor.path, list);
  }

  // P2-B (protocol v1.1 deterministic closure, part C) — boundary composition.
  //
  // Inclusive 1-based ranges make two NEIGHBORING reads share their boundary
  // line, and the old rule rejected any shared line as 'overlapping-edits'
  // while telling the model to "merge them into one anchored edit" — which is
  // impossible once repository tools are withdrawn and no covering anchor was
  // ever minted. When — and only when — a join is mechanically unambiguous,
  // Stratum composes it itself:
  //   same path, same base sha256, B.start === A.end (exactly ONE old source
  //   line overlaps), and A's replacement final line === B's replacement
  //   first line byte-for-byte. Chains compose transitively (every join
  //   satisfies the same rule). The composed replacement is exactly
  //   A + B[1:] — the model still owns every replacement byte; no new source
  //   authority, no guessed bytes. ANY other overlap fails exactly as before.
  const overlapsDefect = (path_: string, a: { start_line: number; end_line: number }, b: { start_line: number; end_line: number }): ContractDefect => ({
    code: 'overlapping-edits',
    ref: path_,
    message: `two edits anchor overlapping spans of '${path_}' ([${a.start_line}, ${a.end_line}] and [${b.start_line}, ${b.end_line}]) — their spans cannot be composed: two different new contents are claimed for a shared source line, or the spans overlap by more than one line`,
  });

  for (const [path_, spans] of resolvedByPath) {
    const sorted = [...spans].sort((a, b) => a.start_line - b.start_line || a.end_line - b.end_line);
    interface VirtualSpan { start_line: number; end_line: number; replacement: string; composed_from: string[] | null }
    const virtual: VirtualSpan[] = [];
    let i = 0;
    while (i < sorted.length) {
      let cur = sorted[i];
      let chainRepl = cur.replacement;
      const chainIds = [cur.anchor_id];
      let j = i + 1;
      while (j < sorted.length) {
        const next = sorted[j];
        if (next.start_line > cur.end_line) break; // strictly disjoint: a separate edit
        const oneLineTouch = next.start_line === cur.end_line;
        const sameBase = next.base_sha256 === cur.base_sha256;
        const curLines = chainRepl.split('\n');
        const nextLines = next.replacement.split('\n');
        const boundaryEqual = curLines[curLines.length - 1] === nextLines[0];
        if (oneLineTouch && sameBase && boundaryEqual) {
          chainRepl = chainRepl + '\n' + nextLines.slice(1).join('\n');
          cur = { ...cur, end_line: next.end_line };
          chainIds.push(next.anchor_id);
          j++;
          continue;
        }
        defects.push(overlapsDefect(path_, cur, next));
        j++;
      }
      virtual.push({
        start_line: cur.start_line,
        end_line: cur.end_line,
        replacement: chainRepl,
        composed_from: chainIds.length > 1 ? chainIds : null,
      });
      i = j;
    }
    // Composed (or plain) spans must still not overlap EACH OTHER — a wide
    // read plus its own boundary children compose into one chain; anything
    // else is a genuine ambiguity the model must resolve.
    for (let a = 0; a < virtual.length; a++) {
      for (let b = a + 1; b < virtual.length; b++) {
        if (spansOverlap(virtual[a], virtual[b])) {
          defects.push(overlapsDefect(path_, virtual[a], virtual[b]));
        }
      }
    }
  }

  // A path may not appear both as an anchored replace and a create.
  for (const create of value.creates) {
    const canonical = toSafeRelativePath(create.path);
    if (canonical !== null && resolvedByPath.has(canonical)) {
      defects.push({
        code: 'path-conflict',
        ref: canonical,
        message: `'${canonical}' appears both as an anchored edit target and as a create`,
      });
    }
  }

  return defects;
}

// ── stage (authoritative, post-loop) ─────────────────────────────────────────

async function stageProposal(
  value: BuildEditProposal,
  ctx: ActionStageContext,
): Promise<StageOutcome> {
  const edits: StagedEdit[] = [];
  const compositions: CompositionEvidence[] = [];

  // Group replace edits per file, resolving every anchor again through the
  // runner-injected run-scoped view (the same registry validate used — an
  // anchor from another execution is unresolvable here too).
  const byPath = new Map<string, Array<{ anchor_id: string; start_line: number; end_line: number; replacement: string; base_sha256: string }>>();
  for (const edit of value.edits) {
    const anchor = ctx.resolveStageAnchor?.(edit.anchor_id);
    if (!anchor) {
      return {
        ok: false,
        error: `Anchored edit references anchor '${edit.anchor_id}' which was not issued in this step execution — fail closed`,
      };
    }
    const list = byPath.get(anchor.path) ?? [];
    list.push({
      anchor_id: edit.anchor_id,
      start_line: anchor.start_line,
      end_line: anchor.end_line,
      replacement: edit.replacement,
      base_sha256: anchor.base_sha256,
    });
    byPath.set(anchor.path, list);
  }

  const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

  // P2-B (part C) — apply the SAME deterministic boundary composition validate
  // used, so the authoritative stage splices the composed spans (a boundary
  // chain arrives as two overlapping anchors and would otherwise fail the
  // overlap re-check below despite having been accepted in-loop). This stage
  // recomputation is independent of the loop: even if the model-facing schema
  // was narrowed or validate were bypassed, stage re-derives everything from
  // the anchors + disk and re-checks every gate on the composed spans.
  const composeChains = (
    spans: Array<{ anchor_id: string; start_line: number; end_line: number; base_sha256: string; replacement: string }>,
  ): Array<{ anchor_id: string; start_line: number; end_line: number; base_sha256: string; replacement: string; composed_from: string[] | null }> => {
    const sorted = [...spans].sort((a, b) => a.start_line - b.start_line || a.end_line - b.end_line);
    const out: Array<{ anchor_id: string; start_line: number; end_line: number; base_sha256: string; replacement: string; composed_from: string[] | null }> = [];
    let i = 0;
    while (i < sorted.length) {
      let cur = sorted[i];
      let chainRepl = cur.replacement;
      const chainIds = [cur.anchor_id];
      let j = i + 1;
      while (j < sorted.length) {
        const next = sorted[j];
        if (next.start_line > cur.end_line) break;
        const oneLineTouch = next.start_line === cur.end_line;
        const sameBase = next.base_sha256 === cur.base_sha256;
        const curLines = chainRepl.split('\n');
        const nextLines = next.replacement.split('\n');
        const boundaryEqual = curLines[curLines.length - 1] === nextLines[0];
        if (oneLineTouch && sameBase && boundaryEqual) {
          chainRepl = chainRepl + '\n' + nextLines.slice(1).join('\n');
          cur = { ...cur, end_line: next.end_line };
          chainIds.push(next.anchor_id);
          j++;
          continue;
        }
        break; // not composable: leave both spans as-is (the overlap re-check fails closed)
      }
      out.push({
        anchor_id: chainIds.length > 1 ? `composed:${chainIds.join('+')}` : cur.anchor_id,
        start_line: cur.start_line,
        end_line: cur.end_line,
        base_sha256: cur.base_sha256,
        replacement: chainRepl,
        composed_from: chainIds.length > 1 ? chainIds : null,
      });
      i = j;
    }
    return out;
  };

  for (const [path_, rawSpans] of byPath) {
    const spans = composeChains(rawSpans);
    let before: string;
    try {
      before = await ctx.io.readFile(path_);
    } catch {
      return { ok: false, error: `Anchored edit target '${path_}' does not exist on disk — fail closed` };
    }
    const beforeSha = sha256Hex(before);
    // Defensive re-checks (the loop's validate already rejected overlaps):
    // sorting bottom-up makes the splice coordinate-safe regardless.
    const sorted = [...spans].sort((a, b) => b.start_line - a.start_line);
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        if (spansOverlap(sorted[i], sorted[j])) {
          return { ok: false, error: `Anchored edits for '${path_}' overlap — fail closed` };
        }
      }
      if (sorted[i].base_sha256 !== beforeSha) {
        return {
          ok: false,
          error:
            `Anchored edit for '${path_}' is stale: anchor base sha256 ${sorted[i].base_sha256.slice(0, 12)}… ` +
            `does not match the file on disk (sha256 ${beforeSha.slice(0, 12)}…) — re-read the region and resubmit`,
        };
      }
    }
    let after = before;
    for (const span of sorted) {
      try {
        after = spliceLineSpan(after, span.start_line, span.end_line, span.replacement);
      } catch (err) {
        return {
          ok: false,
          error: `Anchored edit for '${path_}' could not be spliced: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
    const afterSha = sha256Hex(after);
    if (afterSha === beforeSha) continue; // no-op edit: nothing to publish
    // P2-B — authoritative composition evidence, computed HERE from the
    // correct bytes: one record per composed span, hashing (a) the composed
    // replacement bytes that were spliced and (b) the final staged file
    // bytes. The runner persists these records verbatim — it never
    // reconstructs them.
    for (const span of spans) {
      if (span.composed_from && span.composed_from.length > 0) {
        compositions.push({
          path: path_,
          source_anchor_ids: span.composed_from,
          start_line: span.start_line,
          end_line: span.end_line,
          replacement_sha256: sha256Hex(span.replacement),
          result_file_sha256: afterSha,
        });
      }
    }
    // Audit diff rendered FROM THE DECIDED SPANS (ascending, delta-corrected)
    // — truthful evidence, never re-inferred from whole texts.
    const ascending = [...spans].sort((a, b) => a.start_line - b.start_line);
    const composedFrom = ascending.flatMap((s) => s.composed_from ?? []);
    edits.push({
      op: 'replace',
      path: path_,
      anchor_id: ascending.map((s) => s.anchor_id).join(','),
      ...(composedFrom.length > 0 ? { composed_from: composedFrom } : {}),
      before_sha256: beforeSha,
      after_sha256: afterSha,
      content: after,
      diff: renderSpanDiff(
        path_,
        before,
        ascending.map((s) => ({
          oldStartLine: s.start_line,
          oldLineCount: s.end_line - s.start_line + 1,
          newLines: s.replacement === '' ? [] : s.replacement.split('\n'),
        })),
      ),
    });
  }

  for (const create of value.creates) {
    const canonical = toSafeRelativePath(create.path);
    if (canonical === null) {
      return { ok: false, error: `Create path '${create.path}' is not a safe repo-relative path — fail closed` };
    }
    if (await ctx.io.fileExists(canonical)) {
      return {
        ok: false,
        error:
          `Create target '${canonical}' already exists on disk — anchored protocol v1 creates new files only; ` +
          `to change an existing file, read it with read_source_slice and submit an anchored edit`,
      };
    }
    edits.push({
      op: 'create',
      path: canonical,
      before_sha256: null,
      after_sha256: sha256Hex(create.content),
      content: create.content,
      diff: renderCreatedFileDiff(canonical, create.content),
    });
  }

  return { ok: true, changeset: { edits, compositions } };
}

export function createBuildChangesetActionContract(): ActionContract<BuildEditProposal> {
  return {
    modelSchema: BuildEditProposalSchema,
    // P2-B (part B) — policy-specialized action surface. When the runner
    // determines from the FROZEN authority that zero legal create targets
    // exist (every allowedEditPath already exists on disk), the model-facing
    // schema omits `creates` entirely: the model can never propose an
    // operation Stratum knows is impossible. The projection only ever
    // NARROWS — a submitted `creates` under it is an unknown-key decode
    // rejection (repairable, never silently discarded), and every
    // authoritative post-submission check still runs.
    projectModelSchema: (ctx) => (ctx.createsAuthorized === false ? BuildEditProposalNoCreatesSchema : BuildEditProposalSchema),
    schemaAnnotations: {
      root:
        'Submit your complete changeset exactly once by calling submit_result. Reference source regions by the anchor_id Stratum returned in read_source_slice results; supply only the NEW bytes. Never invent an anchor_id, a hash, a line number, or any diff/patch syntax.',
      fields: {
        '/properties/edits': 'Each entry replaces the exact anchored line span. replacement === "" deletes the span.',
        '/properties/creates': 'Each entry creates a NEW file (path must not exist on disk).',
      },
    },
    validate: validateProposal,
    stage: stageProposal,
  };
}
