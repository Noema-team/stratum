import { promises as fs } from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { createHash } from 'crypto';

// ─── Tool definitions (passed to Anthropic SDK) ───────────────────────────────

export const AGENT_TOOLS = [
  {
    name: 'read_file' as const,
    description:
      'Read the contents of a file by path. Use this to inspect existing artifacts before producing output.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Relative path from project root' },
      },
      required: ['path'],
    },
  },
  {
    // E27r — bounded source-view for large files. A full read_file of a file
    // larger than the synthesis read-result budget is elided at the
    // synthesis boundary (E23), leaving the model a digest WITHOUT the exact
    // source lines a zero-fuzz unified diff requires. This tool returns a
    // bounded exact excerpt plus the authoritative full-file digest; the
    // small result is always retained through synthesis, so the model can
    // author a patch (base digest + exact context lines) at the synthesis
    // turn even for files it can never re-read in full.
    name: 'read_source_slice' as const,
    description:
      "Read a bounded line range from a file, with the file's authoritative byte count and full-content sha256. Use this instead of read_file for large files: the returned excerpt carries the exact lines a patch diff needs, and the sha256 field is the authoritative base digest to pin in the patch block.",
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Relative path from project root' },
        startLine: { type: 'integer', description: '1-based first line to return (default 1)' },
        lineCount: {
          type: 'integer',
          description: 'Maximum number of lines to return (default 120, hard-capped at 400)',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_directory' as const,
    description:
      'List files in a directory. Use this to discover what artifacts already exist.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Relative path from project root' },
      },
      required: ['path'],
    },
  },
] as const;

export type ToolName = (typeof AGENT_TOOLS)[number]['name'];

// ============================================================================
// D.3b1 — Git-tracked-file read authority
//
// Read tools may only see Git-tracked repository content — independent of
// directory or technology (docs/, src/, tests/, a Godot project's scripts/,
// a Rust workspace outside src/, firmware trees, ...). This replaces an
// earlier hardcoded directory-prefix allowlist (['docs/', '.sle/runs/',
// 'src/']), which excluded entire legitimate classes of repository content
// and had no way to generalize to a project shape it didn't anticipate.
//
// Using the tracked-file set as the read authority is also what keeps
// untracked/ignored local content (.env, caches, local credentials) out of
// reach, without a second, separate ignore-list mechanism to maintain.
//
// Fails closed: if the tracked set cannot be determined at all (not a git
// repository, git unavailable, command error), the tracked set is empty —
// every read is denied — rather than falling back to "allow everything."
// ============================================================================

export type TrackedFilesLister = (projectRoot: string) => Promise<string[]>;

export const listGitTrackedFiles: TrackedFilesLister = (projectRoot) =>
  new Promise((resolve) => {
    execFile(
      'git',
      ['ls-files'],
      { cwd: projectRoot, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve([]); // fail closed — not a repo, git missing, or any other error
          return;
        }
        resolve(stdout.split('\n').map((l) => l.trim()).filter(Boolean));
      },
    );
  });

// Normalizes a caller-supplied relative path, rejecting traversal and
// absolute paths outright (the same conservative rejection discipline as
// src/path-safety.ts, applied here to read paths rather than write paths).
// '.' and '' both mean "project root"; a trailing slash is stripped so a
// directory path compares consistently against tracked-file prefixes.
function normalizeRelPath(relPath: string): string | null {
  if (!relPath || relPath.includes('..') || path.isAbsolute(relPath)) return null;
  if (relPath === '.') return '';
  return relPath.replace(/\/+$/, '');
}

// True iff `normalized` names a tracked file (read_file) or a directory
// containing at least one tracked file (list_directory) — the project root
// ('') is always a permitted directory to list.
function isPermittedReadPath(
  normalized: string,
  trackedFiles: ReadonlySet<string>,
  isDirectoryListing: boolean,
): boolean {
  if (!isDirectoryListing) return trackedFiles.has(normalized);
  if (normalized === '') return true;
  const prefix = `${normalized}/`;
  for (const f of trackedFiles) {
    if (f === normalized || f.startsWith(prefix)) return true;
  }
  return false;
}

// Derives a directory listing entirely from the tracked-file set — never
// from fs.readdir — so an untracked entry sitting alongside tracked content
// in the same real directory can never leak into the result. Subdirectory
// entries are reported once, with a trailing '/' marker.
function trackedChildrenOf(dirPrefix: string, trackedFiles: ReadonlySet<string>): string[] {
  const prefix = dirPrefix === '' ? '' : `${dirPrefix}/`;
  const children = new Set<string>();
  for (const f of trackedFiles) {
    if (prefix !== '' && !f.startsWith(prefix)) continue;
    const rest = f.slice(prefix.length);
    const slashIdx = rest.indexOf('/');
    children.add(slashIdx === -1 ? rest : `${rest.slice(0, slashIdx)}/`);
  }
  return [...children].sort();
}

// ─── D.3b1.1 — symlink-safe read resolution ───────────────────────────────────
//
// The lexical tracked-set check above (isPermittedReadPath) only proves that
// the *requested path string* names a tracked entry. It says nothing about
// what that path actually resolves to on disk: a Git-tracked symlink (or a
// tracked path whose parent directory has since been replaced by a symlink
// on disk, while the index still lists a path through it) can point outside
// the project root, or at untracked content such as a local .env — and a
// plain fs.readFile would silently follow it.
//
// read_file therefore additionally requires that the REAL (symlink-resolved)
// target: (a) stays inside the real, resolved project root, and (b) is
// itself — at its resolved, project-relative path — present in the tracked
// set. This allows a tracked symlink to another tracked file (both
// conditions hold) while denying escapes and tracked-symlink-to-untracked
// content. Fails closed on any resolution error.
//
// Mocks used by hermetic (non-real-filesystem) tests generally have no
// symlink concept and may not implement `realpath` at all; such mocks fall
// back to trusting the lexical check already performed by the caller.
async function resolveTrackedRealPath(
  fsModule: typeof fs,
  projectRoot: string,
  normalized: string,
  trackedFiles: ReadonlySet<string>,
): Promise<string | null> {
  const realpathFn = (fsModule as Partial<typeof fs>).realpath;
  if (typeof realpathFn !== 'function') {
    return path.join(projectRoot, normalized);
  }
  try {
    const realRoot = await realpathFn(projectRoot);
    const realTarget = await realpathFn(path.join(projectRoot, normalized));
    const rel = path.relative(realRoot, realTarget);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      return null; // resolves outside the project root
    }
    const relPosix = rel.split(path.sep).join('/');
    if (!trackedFiles.has(relPosix)) {
      return null; // real target is not itself git-tracked content
    }
    return realTarget;
  } catch {
    return null; // fail closed on any realpath error (dangling symlink, etc.)
  }
}

// ─── Tool input validation ────────────────────────────────────────────────────

export interface ToolInput {
  path?: string;
  startLine?: number;
  lineCount?: number;
}

// read_source_slice bounds — the result must stay small enough to survive
// synthesis untouched (E23 never elides non-read_file results, but a huge
// slice would still crowd the request) and to keep the model working on a
// bounded edit region rather than re-consuming the whole file.
export const DEFAULT_SLICE_LINES = 120;
export const MAX_SLICE_LINES = 400;

// ─── Tool handlers ────────────────────────────────────────────────────────────

export interface ToolResult {
  content: string;
}

export async function handleToolCall(
  toolName: ToolName,
  input: unknown,
  projectRoot: string,
  fsModule: typeof fs = fs,
  // Defaults to an empty set — fail closed for any caller that doesn't
  // supply the run's actual tracked-file set (see AgentLoop, which computes
  // this once per run via listGitTrackedFiles or an injected override).
  trackedFiles: ReadonlySet<string> = new Set(),
): Promise<ToolResult> {
  const inp = (input ?? {}) as ToolInput;

  if (toolName === 'read_file') {
    const relPath = inp.path;
    if (!relPath || typeof relPath !== 'string') {
      return { content: JSON.stringify({ error: 'invalid input: path is required' }) };
    }
    const normalized = normalizeRelPath(relPath);
    if (normalized === null || normalized === '' || !isPermittedReadPath(normalized, trackedFiles, false)) {
      return { content: JSON.stringify({ error: 'path not permitted' }) };
    }
    const realTargetPath = await resolveTrackedRealPath(fsModule, projectRoot, normalized, trackedFiles);
    if (realTargetPath === null) {
      return { content: JSON.stringify({ error: 'path not permitted' }) };
    }
    try {
      const text = await fsModule.readFile(realTargetPath, 'utf-8');
      return { content: text };
    } catch {
      return { content: JSON.stringify({ error: 'file not found' }) };
    }
  }

  if (toolName === 'read_source_slice') {
    const relPath = inp.path;
    if (!relPath || typeof relPath !== 'string') {
      return { content: JSON.stringify({ error: 'invalid input: path is required' }) };
    }
    const normalized = normalizeRelPath(relPath);
    if (normalized === null || normalized === '' || !isPermittedReadPath(normalized, trackedFiles, false)) {
      return { content: JSON.stringify({ error: 'path not permitted' }) };
    }
    const realTargetPath = await resolveTrackedRealPath(fsModule, projectRoot, normalized, trackedFiles);
    if (realTargetPath === null) {
      return { content: JSON.stringify({ error: 'path not permitted' }) };
    }
    let text: string;
    try {
      text = await fsModule.readFile(realTargetPath, 'utf-8');
    } catch {
      return { content: JSON.stringify({ error: 'file not found' }) };
    }
    const physicalLines = text.split('\n');
    const totalLines = text.endsWith('\n') ? physicalLines.length - 1 : physicalLines.length;
    const startLine = typeof inp.startLine === 'number' && Number.isInteger(inp.startLine) && inp.startLine > 0 ? inp.startLine : 1;
    if (totalLines > 0 && startLine > totalLines) {
      return { content: JSON.stringify({ error: `startLine ${startLine} is beyond the end of the file (${totalLines} lines)` }) };
    }
    const requested = typeof inp.lineCount === 'number' && Number.isInteger(inp.lineCount) && inp.lineCount > 0 ? inp.lineCount : DEFAULT_SLICE_LINES;
    const count = Math.min(requested, MAX_SLICE_LINES);
    const slice = physicalLines.slice(startLine - 1, startLine - 1 + count);
    return {
      content: JSON.stringify({
        path: normalized,
        totalLines,
        totalBytes: Buffer.byteLength(text, 'utf-8'),
        // Authoritative full-file digest — computed by Stratum from the bytes
        // on disk, never claimed by the model. This is the value to pin as
        // the base of an SLE-PATCH block.
        sha256: createHash('sha256').update(text, 'utf-8').digest('hex'),
        startLine,
        endLine: startLine - 1 + slice.length,
        truncated: startLine - 1 + slice.length < totalLines,
        content: slice.join('\n'),
      }),
    };
  }

  if (toolName === 'list_directory') {
    const relPath = inp.path;
    if (!relPath || typeof relPath !== 'string') {
      return { content: JSON.stringify({ error: 'invalid input: path is required' }) };
    }
    const normalized = normalizeRelPath(relPath);
    if (normalized === null || !isPermittedReadPath(normalized, trackedFiles, true)) {
      return { content: JSON.stringify({ error: 'path not permitted' }) };
    }
    const files = trackedChildrenOf(normalized, trackedFiles);
    return { content: JSON.stringify({ files }) };
  }

  return { content: JSON.stringify({ error: `unknown tool: ${toolName}` }) };
}
