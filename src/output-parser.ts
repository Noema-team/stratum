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

// E22 — explicit artifact framing. The legacy framing used '### <path>' lines
// as artifact section delimiters INSIDE the envelope, making ordinary Markdown
// headings structurally ambiguous with the transport's own syntax: a design
// doc containing '### 4.1 Data flow (unchanged topology)' was read as an
// artifact whose path is '4.1 Data flow (unchanged topology)' (live A10
// attempt-8 failure). The marker framing makes artifact boundaries share NO
// syntax with valid artifact content — inside the markers the content is
// opaque. The legacy '### <path>' framing remains accepted as a compatibility
// fallback; the transport teaches only the marker framing.
export const SLE_ARTIFACT_OPEN = '<<<SLE-ARTIFACT ';
export const SLE_ARTIFACT_CLOSE = '<<<END-SLE-ARTIFACT>>>';
const ARTIFACT_MARKER_RE = /^<<<SLE-ARTIFACT path="([^"]+)">>>\s*$/;

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

  // E22 — mode selection is deterministic: ANY artifact marker line in the
  // envelope selects marker parsing, in which '### ' lines are never section
  // delimiters (content is opaque). No markers → legacy '### <path>' parsing,
  // byte-for-byte unchanged.
  const markerMode = lines.some(
    (l) => l.startsWith(SLE_ARTIFACT_OPEN) || l.trim() === SLE_ARTIFACT_CLOSE
  );

  if (markerMode) {
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (line.startsWith(SLE_ARTIFACT_OPEN)) {
        const m = line.match(ARTIFACT_MARKER_RE);
        if (!m) {
          throw new ParseError(
            `Malformed artifact marker (expected '${SLE_ARTIFACT_OPEN}path="<path>">>>'): ${line.trim()}`,
            raw
          );
        }
        const rawPath = m[1].trim();
        validateSectionPath(rawPath, raw);
        if (seenPaths.has(rawPath)) {
          throw new ParseError(`Duplicate path in output: ${rawPath}`, raw);
        }
        seenPaths.add(rawPath);

        // Content is opaque: ONLY the exact close-marker line terminates the
        // artifact. Everything else — any Markdown heading, any delimiter-like
        // text — is content.
        const contentLines: string[] = [];
        i++;
        let closed = false;
        while (i < lines.length) {
          if (lines[i].trim() === SLE_ARTIFACT_CLOSE) {
            closed = true;
            i++;
            break;
          }
          contentLines.push(lines[i]);
          i++;
        }
        if (!closed) {
          throw new ParseError(
            `Artifact marker opened but never closed (missing '${SLE_ARTIFACT_CLOSE}'): ${rawPath}`,
            raw
          );
        }
        const section = finalizeSection(rawPath, contentLines, raw, role, warnings);
        if (section === null) continue;
        sections.push(section);
        continue;
      }
      if (line.trim() === SLE_ARTIFACT_CLOSE) {
        throw new ParseError(
          `'${SLE_ARTIFACT_CLOSE}' without a matching '${SLE_ARTIFACT_OPEN}path="...">>>' marker`,
          raw
        );
      }
      // Prose between artifacts is opaque and ignored.
      i++;
    }
  } else {
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

      const section = finalizeSection(rawPath, contentLines, raw, role, warnings);
      if (section === null) continue;
      sections.push(section);
    }
  }

  if (sections.length + warnings.length > MAX_SECTIONS) {
    throw new ParseError(
      `Output contains more than ${MAX_SECTIONS} sections`,
      raw
    );
  }

  return { sections, warnings };
}

// Shared per-section finalization for both framings: emptiness, size cap,
// role allowlist (an unpermitted path is a warning + a dropped section).
function finalizeSection(
  rawPath: string,
  contentLines: string[],
  raw: string,
  role: AgentRole,
  warnings: string[]
): ParsedSection | null {
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
    return null;
  }
  return { path: rawPath, content };
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
