import { promises as fs } from 'fs';
import path from 'path';
import { execFile } from 'child_process';

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

// ─── Tool input validation ────────────────────────────────────────────────────

export interface ToolInput {
  path?: string;
}

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
    try {
      const text = await fsModule.readFile(path.join(projectRoot, normalized), 'utf-8');
      return { content: text };
    } catch {
      return { content: JSON.stringify({ error: 'file not found' }) };
    }
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
