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
    creates: z
      .array(
        z
          .object({
            path: z.string().min(1),
            content: z.string(),
          })
          .strict(),
      )
      .max(MAX_CREATES),
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
  const resolvedByPath = new Map<string, Array<{ start_line: number; end_line: number; path: string }>>();
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
          `anchor '${edit.anchor_id}' was not issued in this step execution — re-read the target region with read_source_slice and reference the anchor returned in the tool result`,
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
    list.push(anchor);
    resolvedByPath.set(anchor.path, list);
  }
  for (const [path_, spans] of resolvedByPath) {
    for (let i = 0; i < spans.length; i++) {
      for (let j = i + 1; j < spans.length; j++) {
        if (spansOverlap(spans[i], spans[j])) {
          defects.push({
            code: 'overlapping-edits',
            ref: path_,
            message: `two edits anchor overlapping spans of '${path_}' ([${spans[i].start_line}, ${spans[i].end_line}] and [${spans[j].start_line}, ${spans[j].end_line}]) — merge them into one anchored edit`,
          });
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

  for (const [path_, spans] of byPath) {
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
    // Audit diff rendered FROM THE DECIDED SPANS (ascending, delta-corrected)
    // — truthful evidence, never re-inferred from whole texts.
    const ascending = [...spans].sort((a, b) => a.start_line - b.start_line);
    edits.push({
      op: 'replace',
      path: path_,
      anchor_id: ascending.map((s) => s.anchor_id).join(','),
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

  return { ok: true, changeset: { edits } };
}

export function createBuildChangesetActionContract(): ActionContract<BuildEditProposal> {
  return {
    modelSchema: BuildEditProposalSchema,
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
