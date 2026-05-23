import { promises as fs } from 'fs';
import path from 'path';

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

// Any agent can read from these prefixes regardless of role output restrictions.
export const AGENT_READ_ALLOWLIST = ['docs/', '.sle/runs/', 'src/'];

export type ToolName = (typeof AGENT_TOOLS)[number]['name'];

// ─── Tool input validation ────────────────────────────────────────────────────

export interface ToolInput {
  path?: string;
}

function isPermittedReadPath(relPath: string): boolean {
  return AGENT_READ_ALLOWLIST.some((prefix) => relPath.startsWith(prefix));
}

function resolveAndGuard(projectRoot: string, relPath: string): string | null {
  if (!relPath || relPath.includes('..') || path.isAbsolute(relPath)) return null;
  if (!isPermittedReadPath(relPath)) return null;
  return path.join(projectRoot, relPath);
}

// ─── Tool handlers ────────────────────────────────────────────────────────────

export interface ToolResult {
  content: string;
}

export async function handleToolCall(
  toolName: ToolName,
  input: unknown,
  projectRoot: string,
  fsModule: typeof fs = fs
): Promise<ToolResult> {
  const inp = (input ?? {}) as ToolInput;

  if (toolName === 'read_file') {
    const relPath = inp.path;
    if (!relPath || typeof relPath !== 'string') {
      return { content: JSON.stringify({ error: 'invalid input: path is required' }) };
    }
    const resolved = resolveAndGuard(projectRoot, relPath);
    if (!resolved) {
      return { content: JSON.stringify({ error: 'path not permitted' }) };
    }
    try {
      const text = await fsModule.readFile(resolved, 'utf-8');
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
    const resolved = resolveAndGuard(projectRoot, relPath);
    if (!resolved) {
      return { content: JSON.stringify({ error: 'path not permitted' }) };
    }
    try {
      const entries = await fsModule.readdir(resolved);
      return { content: JSON.stringify({ files: entries }) };
    } catch {
      return { content: JSON.stringify({ error: 'directory not found' }) };
    }
  }

  return { content: JSON.stringify({ error: `unknown tool: ${toolName}` }) };
}
