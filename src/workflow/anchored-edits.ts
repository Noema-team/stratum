// BUILD Edit Protocol v1 — the anchored-edit primitive (docs/specs/build-edit-protocol-v1.md).
//
// Pilot A V8–V11 falsified every model-configuration knob for BUILD publication:
// under low reasoning the model reliably computes the right semantic edit and
// unreliably serializes byte-sensitive unified-diff/transport-marker syntax.
// This module removes the serialization tasks instead of training them:
//
//   - Stratum mints an opaque ANCHOR at the moment the model reads an exact
//     source region (read_source_slice). The anchor binds path + full-file
//     base sha256 + exact line span + slice-content sha256. The model never
//     reproduces those facts; it references the anchor id.
//   - At publication the model's proposal names anchors and supplies only the
//     NEW bytes; Stratum resolves the anchor, re-verifies the frozen base
//     against disk, splices the exact span, and derives the final bytes.
//
// Design invariants (fail-closed, no fuzzy anything):
//   - anchor ids are deterministic functions of the binding (replay can
//     recompute them from evidence) but carry no authority by themselves —
//     resolution goes through a per-step-execution AnchorRegistry, so an
//     anchor minted in another execution is simply unknown.
//   - old bytes NEVER come from the model. They come from disk, gated by the
//     anchor's base hash. The V9 whitespace-truncation failure class is
//     unrepresentable by construction.

import { createHash } from 'crypto';

// ─── Anchor records ───────────────────────────────────────────────────────────

/** The authoritative facts an anchor freezes. Never model-supplied. */
export interface SourceAnchorRecord {
  /** Canonical (path-safety-normalized), repo-relative file path. */
  path: string;
  /** Full-file sha256 at read time — the frozen base the edit applies against. */
  base_sha256: string;
  /** 1-based inclusive first line of the anchored span. */
  start_line: number;
  /** 1-based inclusive last line of the anchored span. */
  end_line: number;
  /** sha256 of the exact slice content Stratum returned for the span. */
  content_sha256: string;
}

export interface SourceAnchor extends SourceAnchorRecord {
  anchor_id: string;
}

/**
 * Deterministic anchor id: `src_` + first 16 hex of sha256 over the canonical
 * binding. Opaque to the model; recomputable from evidence for replay.
 */
export function mintAnchorId(record: SourceAnchorRecord): string {
  const canonical = [
    record.path,
    record.base_sha256,
    String(record.start_line),
    String(record.end_line),
    record.content_sha256,
  ].join('\0');
  return `src_${createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16)}`;
}

/**
 * Extract an anchor record from a read_source_slice tool-result payload.
 * Returns null on ANY shape mismatch — the caller passes the result through
 * unchanged (minting must never break a read).
 */
export function anchorRecordFromSliceResult(payload: unknown): SourceAnchorRecord | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.path !== 'string' || p.path === '') return null;
  if (typeof p.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(p.sha256)) return null;
  if (typeof p.startLine !== 'number' || !Number.isInteger(p.startLine) || p.startLine < 1) return null;
  if (typeof p.endLine !== 'number' || !Number.isInteger(p.endLine) || p.endLine < p.startLine) return null;
  if (typeof p.content !== 'string') return null;
  return {
    path: p.path,
    base_sha256: p.sha256,
    start_line: p.startLine,
    end_line: p.endLine,
    content_sha256: createHash('sha256').update(p.content, 'utf8').digest('hex'),
  };
}

// ─── Registry (run-scope authority) ───────────────────────────────────────────

/**
 * One registry per step execution. Minting is idempotent (the same region
 * read twice in an unchanged file yields the same anchor); resolution is
 * scoped to this registry instance, so an anchor from another execution is
 * unknown — fail-closed by isolation, with no fuzzy fallback.
 */
export class AnchorRegistry {
  private readonly byId = new Map<string, SourceAnchor>();

  mint(record: SourceAnchorRecord): SourceAnchor {
    const existing = this.byId.get(mintAnchorId(record));
    if (existing) return existing;
    const anchor: SourceAnchor = { ...record, anchor_id: mintAnchorId(record) };
    this.byId.set(anchor.anchor_id, anchor);
    return anchor;
  }

  resolve(anchorId: string): SourceAnchor | undefined {
    return this.byId.get(anchorId);
  }

  list(): readonly SourceAnchor[] {
    return [...this.byId.values()];
  }
}

// ─── Exact span splicing ──────────────────────────────────────────────────────

/**
 * Replace the 1-based inclusive line span [startLine, endLine] of `fileText`
 * with `replacement`, using the SAME line model as read_source_slice
 * (text.split('\n'); a trailing newline lives in the final '' element).
 *
 * `replacement === ''` deletes the span outright (zero inserted lines); any
 * other replacement is inserted as replacement.split('\n'). Untouched bytes —
 * including all whitespace — come from the disk text, never from the model.
 *
 * Callers applying several spans to one file must splice bottom-up (descending
 * start_line) so earlier coordinates stay valid — stage() enforces this.
 */
export function spliceLineSpan(
  fileText: string,
  startLine: number,
  endLine: number,
  replacement: string,
): string {
  const physical = fileText.split('\n');
  if (startLine < 1 || endLine < startLine || endLine > physical.length) {
    throw new Error(`splice span [${startLine}, ${endLine}] out of bounds (${physical.length} physical lines)`);
  }
  const inserted = replacement === '' ? [] : replacement.split('\n');
  physical.splice(startLine - 1, endLine - startLine + 1, ...inserted);
  return physical.join('\n');
}

/** True when two anchored spans on the same file intersect. */
export function spansOverlap(
  a: { start_line: number; end_line: number },
  b: { start_line: number; end_line: number },
): boolean {
  return a.start_line <= b.end_line && b.start_line <= a.end_line;
}

// ─── Audit diff (evidence, never an instruction language) ─────────────────────

const AUDIT_CONTEXT_LINES = 3;

/**
 * Deterministic unified diff rendered FROM THE DECIDED SPANS (not re-inferred
 * from whole texts — the system knows exactly what changed, so the evidence is
 * truthful by construction). Pure evidence: never parsed, never applied, never
 * taught to a model. Line coordinates use the same physical-line model as
 * spliceLineSpan (1-based, text.split('\n')).
 */
export interface SpanDiffInput {
  /** 1-based first removed line in the BEFORE text. */
  oldStartLine: number;
  /** Number of removed lines (end - start + 1). */
  oldLineCount: number;
  /** Inserted lines (replacement === '' → empty array). */
  newLines: string[];
}

function hunkHeader(oldStart: number, oldCount: number, newStart: number, newCount: number): string {
  return `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`;
}

/**
 * Render the audit diff for one file from its replacement spans. Spans may be
 * given in any order; hunks are emitted ascending with non-overlapping context
 * (adjacent hunks are clamped, never merged-fuzzy).
 */
export function renderSpanDiff(
  relPath: string,
  beforeText: string,
  spans: readonly SpanDiffInput[],
): string {
  const physical = beforeText.split('\n');
  const ordered = [...spans].sort((a, b) => a.oldStartLine - b.oldStartLine);
  const out: string[] = [`--- a/${relPath}`, `+++ b/${relPath}`];
  let delta = 0;
  let prevContextOldEnd = 0;
  for (let i = 0; i < ordered.length; i++) {
    const span = ordered[i];
    const spanEnd = span.oldStartLine + span.oldLineCount - 1;
    const nextStart = i + 1 < ordered.length ? ordered[i + 1].oldStartLine : Number.MAX_SAFE_INTEGER;
    const ctxStart = Math.max(prevContextOldEnd + 1, span.oldStartLine - AUDIT_CONTEXT_LINES, 1);
    // Context never reaches into the next span's removed lines.
    const ctxEnd = Math.min(physical.length, spanEnd + AUDIT_CONTEXT_LINES, nextStart - 1);
    const ctxBefore = span.oldStartLine - ctxStart;
    const ctxAfter = ctxEnd - (span.oldStartLine + span.oldLineCount - 1);
    const oldCount = ctxBefore + span.oldLineCount + ctxAfter;
    const newCount = ctxBefore + span.newLines.length + ctxAfter;
    const oldHunkStart = ctxStart;
    const newHunkStart = ctxStart + delta;
    out.push(hunkHeader(oldHunkStart, oldCount, newHunkStart, newCount));
    for (let line = ctxStart; line < span.oldStartLine; line++) out.push(` ${physical[line - 1]}`);
    for (let line = span.oldStartLine; line < span.oldStartLine + span.oldLineCount; line++) {
      out.push(`-${physical[line - 1]}`);
    }
    for (const added of span.newLines) out.push(`+${added}`);
    for (let line = span.oldStartLine + span.oldLineCount; line <= ctxEnd; line++) {
      out.push(` ${physical[line - 1]}`);
    }
    delta += span.newLines.length - span.oldLineCount;
    prevContextOldEnd = ctxEnd;
  }
  if (out.length === 2) return '';
  return out.join('\n') + '\n';
}

/** Audit diff for a created file (everything is an addition). */
export function renderCreatedFileDiff(relPath: string, content: string): string {
  const lines = content.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const out: string[] = [`--- a/${relPath}`, `+++ b/${relPath}`, hunkHeader(0, 0, 1, Math.max(lines.length, 0))];
  for (const line of lines) out.push(`+${line}`);
  return out.join('\n') + '\n';
}
