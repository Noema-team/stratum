import type { AgentRole } from './types.js';
import { validateOutputPath } from './agent-runner.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ParsedSection {
  path: string;
  content: string;
}

export interface ParsedOutput {
  sections: ParsedSection[];
  warnings: string[];
}

export class ParseError extends Error {
  constructor(message: string, public readonly raw: string) {
    super(message);
    this.name = 'ParseError';
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────

const ALLOWED_EXTENSIONS = new Set([
  '.md', '.ts', '.js', '.json', '.yaml', '.yml', '.txt', '.sh', '.py',
]);
const MAX_SECTIONS = 20;
const MAX_SECTION_BYTES = 100 * 1024; // 100 KB

const SLE_OPEN = '<<<SLE-OUTPUT>>>';
const SLE_CLOSE = '<<<END-SLE-OUTPUT>>>';

// ─── Parser ───────────────────────────────────────────────────────────────────

export function parseAgentOutputV3(raw: string, role: AgentRole): ParsedOutput {
  const openIdx = raw.indexOf(SLE_OPEN);
  const closeIdx = raw.indexOf(SLE_CLOSE);

  if (openIdx === -1) {
    throw new ParseError(`Missing ${SLE_OPEN} delimiter`, raw);
  }
  if (closeIdx === -1) {
    throw new ParseError(`Missing ${SLE_CLOSE} delimiter`, raw);
  }

  const body = raw.slice(openIdx + SLE_OPEN.length, closeIdx);
  const lines = body.split('\n');

  const sections: ParsedSection[] = [];
  const warnings: string[] = [];
  const seenPaths = new Set<string>();

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.startsWith('### ')) {
      i++;
      continue;
    }

    const rawPath = line.slice(4).trim();
    validateSectionPath(rawPath, raw);

    if (seenPaths.has(rawPath)) {
      throw new ParseError(`Duplicate path in output: ${rawPath}`, raw);
    }
    seenPaths.add(rawPath);

    // Collect content until next '### ' or end
    const contentLines: string[] = [];
    i++;
    while (i < lines.length && !lines[i].startsWith('### ')) {
      contentLines.push(lines[i]);
      i++;
    }

    const content = contentLines.join('\n').trim();
    if (!content) {
      throw new ParseError(`Empty content for section: ${rawPath}`, raw);
    }
    if (Buffer.byteLength(content, 'utf-8') > MAX_SECTION_BYTES) {
      throw new ParseError(
        `Section content exceeds 100 KB limit: ${rawPath}`,
        raw
      );
    }

    if (!validateOutputPath(rawPath, role)) {
      warnings.push(`Path not permitted for role '${role}': ${rawPath} (section dropped)`);
      continue;
    }

    sections.push({ path: rawPath, content });
  }

  if (sections.length + warnings.length > MAX_SECTIONS) {
    throw new ParseError(
      `Output contains more than ${MAX_SECTIONS} sections`,
      raw
    );
  }

  return { sections, warnings };
}

// ─── Retry wrapper ────────────────────────────────────────────────────────────

/**
 * Calls parseAgentOutputV3. On ParseError, fires rePromptFn with the error reason
 * and retries once with the returned output. A second ParseError propagates.
 */
export async function parseWithRetry(
  raw: string,
  role: AgentRole,
  rePromptFn: (reason: string) => Promise<string>
): Promise<ParsedOutput> {
  try {
    return parseAgentOutputV3(raw, role);
  } catch (err) {
    if (err instanceof ParseError) {
      const retried = await rePromptFn(err.message);
      return parseAgentOutputV3(retried, role); // second failure propagates
    }
    throw err;
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function validateSectionPath(rawPath: string, raw: string): void {
  if (rawPath.startsWith('/')) {
    throw new ParseError(`Path must be relative (no leading /): ${rawPath}`, raw);
  }
  if (rawPath.includes('..')) {
    throw new ParseError(`Path must not contain ..: ${rawPath}`, raw);
  }
  const ext = rawPath.slice(rawPath.lastIndexOf('.'));
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new ParseError(
      `Unrecognised extension '${ext}' in path: ${rawPath}`,
      raw
    );
  }
}
