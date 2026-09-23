// E27 — bounded source-edit publication: a strict, zero-fuzz unified-diff
// applier. The model proposes the semantic change; Stratum owns the
// mechanical application and verification. Any ambiguity, conflict, or
// mismatch fails closed — a patch either applies exactly against the pinned
// base content or it does not apply at all.

export class PatchApplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PatchApplyError';
  }
}

interface DiffEntry {
  tag: ' ' | '-' | '+';
  body: string;
}

interface Hunk {
  oldStart: number; // 1-based line in the original
  entries: DiffEntry[];
  oldCount: number;
  newCount: number;
  oldNoNewline: boolean;
  newNoNewline: boolean;
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Split file content into logical lines; a trailing newline is not a line. */
function toLines(content: string): { lines: string[]; trailingNewline: boolean } {
  if (content === '') return { lines: [], trailingNewline: false };
  if (content.endsWith('\n')) return { lines: content.slice(0, -1).split('\n'), trailingNewline: true };
  return { lines: content.split('\n'), trailingNewline: false };
}

function fromLines(lines: string[], trailingNewline: boolean): string {
  if (lines.length === 0) return trailingNewline ? '\n' : '';
  return lines.join('\n') + (trailingNewline ? '\n' : '');
}

function parseHunks(diff: string): Hunk[] {
  const lines = diff.split('\n');
  const hunks: Hunk[] = [];
  let i = 0;
  // Skip file headers (---/+++/index/diff …) — the target path comes from
  // the SLE-PATCH marker, not the diff body.
  while (i < lines.length && !lines[i].startsWith('@@')) {
    const line = lines[i];
    if (line.trim() === '') { i++; continue; }
    if (/^(--- |---\t|\+\+\+ |\+\+\+\t|index |diff |new file mode|old file mode|similarity |rename |copy )/.test(line)) { i++; continue; }
    throw new PatchApplyError(`Unexpected content before the first hunk header: '${line.slice(0, 60)}'`);
  }
  while (i < lines.length) {
    if (lines[i].trim() === '') { i++; continue; } // trailing blank line after the last hunk
    const m = lines[i].match(HUNK_HEADER_RE);
    if (!m) throw new PatchApplyError(`Malformed hunk header at diff line ${i + 1}: '${lines[i].slice(0, 60)}'`);
    const hunk: Hunk = {
      oldStart: parseInt(m[1], 10),
      oldCount: m[2] === undefined ? 1 : parseInt(m[2], 10),
      newCount: m[4] === undefined ? 1 : parseInt(m[4], 10),
      entries: [],
      oldNoNewline: false,
      newNoNewline: false,
    };
    i++;
    let seenOld = 0;
    let seenNew = 0;
    while (seenOld < hunk.oldCount || seenNew < hunk.newCount) {
      const line = lines[i];
      if (line === undefined) {
        throw new PatchApplyError(`Hunk at original line ${hunk.oldStart} is truncated: declared -${hunk.oldCount},+${hunk.newCount} but the diff ends at old=${seenOld}, new=${seenNew}`);
      }
      if (line.startsWith('\\')) {
        // "\ No newline at end of file" — attaches to the line immediately
        // preceding it (git semantics): '-' or ' ' → old side; '+' → new
        // side; ' ' (context) → both sides.
        const lastTag = hunk.entries.length ? hunk.entries[hunk.entries.length - 1].tag : ' ';
        if (lastTag === '-') hunk.oldNoNewline = true;
        else if (lastTag === '+') hunk.newNoNewline = true;
        else { hunk.oldNoNewline = true; hunk.newNoNewline = true; }
        i++;
        continue;
      }
      const tag = line.charAt(0) as DiffEntry['tag'];
      const body = line.slice(1);
      if (tag === ' ') { hunk.entries.push({ tag, body }); seenOld++; seenNew++; }
      else if (tag === '-') { hunk.entries.push({ tag, body }); seenOld++; }
      else if (tag === '+') { hunk.entries.push({ tag, body }); seenNew++; }
      else if (line === '') { hunk.entries.push({ tag: ' ', body: '' }); seenOld++; seenNew++; }
      else throw new PatchApplyError(`Malformed diff line ${i + 1} (expected ' ', '-', or '+'): '${line.slice(0, 60)}'`);
      i++;
    }
    // a "\ No newline at end of file" marker AFTER the hunk's last line
    if (lines[i] !== undefined && lines[i].startsWith('\\')) {
      const lastTag = hunk.entries.length ? hunk.entries[hunk.entries.length - 1].tag : ' ';
      if (lastTag === '-') hunk.oldNoNewline = true;
      else if (lastTag === '+') hunk.newNoNewline = true;
      else { hunk.oldNoNewline = true; hunk.newNoNewline = true; }
      i++;
    }
    hunks.push(hunk);
  }
  if (hunks.length === 0) throw new PatchApplyError('Diff contains no hunks');
  return hunks;
}

/**
 * Apply a unified diff to `original` with ZERO fuzz: every hunk's context
 * and removal lines must match the original exactly at the stated line
 * number. Returns the patched content. Throws PatchApplyError on any
 * mismatch — callers must treat that as a rejected changeset, never a
 * partial application.
 */
export function applyUnifiedDiff(original: string, diff: string): string {
  const { lines: origLines, trailingNewline: origTrailing } = toLines(original);
  const hunks = parseHunks(diff);
  const out: string[] = [];
  let cursor = 0; // 0-based index into origLines
  let trailing = origTrailing;
  for (const [idx, hunk] of hunks.entries()) {
    const start = hunk.oldStart - 1;
    if (start < cursor) {
      throw new PatchApplyError(`Hunk ${idx + 1} overlaps the previous hunk (starts at original line ${hunk.oldStart}, already consumed through line ${cursor})`);
    }
    while (cursor < start) {
      if (cursor >= origLines.length) {
        throw new PatchApplyError(`Hunk ${idx + 1} starts at original line ${hunk.oldStart} but the file has only ${origLines.length} lines`);
      }
      out.push(origLines[cursor++]);
    }
    for (const e of hunk.entries) {
      if (e.tag === '+') { out.push(e.body); continue; }
      if (cursor >= origLines.length) {
        throw new PatchApplyError(`Hunk ${idx + 1} expects original line ${cursor + 1} ('${e.body.slice(0, 40)}') but the file ends at line ${origLines.length}`);
      }
      if (origLines[cursor] !== e.body) {
        throw new PatchApplyError(`Hunk ${idx + 1} does not apply: original line ${cursor + 1} is '${origLines[cursor].slice(0, 60)}' but the patch expects '${e.body.slice(0, 60)}'`);
      }
      if (e.tag === ' ') out.push(e.body);
      cursor++;
    }
    if (hunk.oldNoNewline && cursor >= origLines.length) trailing = false;
  }
  while (cursor < origLines.length) out.push(origLines[cursor++]);
  const last = hunks[hunks.length - 1];
  if (last.newNoNewline) trailing = false;
  else if (last.oldNoNewline) trailing = true;
  return fromLines(out, trailing);
}
