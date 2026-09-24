import type { AgentRole } from './types.js';
import { validateOutputPath, matchesAuthorizedOutput } from './agent-runner.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ParsedSection {
  path: string;
  content: string;
}

export interface ParsedOutput {
  sections: ParsedSection[];
  warnings: string[];
  // E27 — bounded source-edit proposals (SLE-PATCH blocks), applied and
  // verified by the runner; never written as raw bytes by the parser.
  patches?: ParsedPatch[];
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
// E27r — patch transport bounds: a bounded source edit is small by
// construction. The count bound is shared with sections (the changeset as a
// whole stays bounded); the byte ceiling matches the "small hunks" teaching.
const MAX_PATCHES_TOTAL = MAX_SECTIONS;
const MAX_PATCH_BYTES = 32 * 1024; // 32 KB

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
// E27 — bounded source edits: a patch block pins the base content by sha256
// and carries a strict unified diff. Additive sibling marker inside the same
// SLE-OUTPUT envelope; the legacy '### <path>' framing never sees it.
export const SLE_PATCH_OPEN = '<<<SLE-PATCH ';
export const SLE_PATCH_CLOSE = '<<<END-SLE-PATCH>>>';
const PATCH_MARKER_RE = /^<<<SLE-PATCH path="([^"]+)" base="([a-f0-9]{64})">>>\s*$/;

export interface ParsedPatch {
  path: string;
  base: string; // sha256 of the file content the diff was computed against
  diff: string;
}

// ─── Parser ───────────────────────────────────────────────────────────────────

export function parseAgentOutputV3(
  raw: string,
  role: AgentRole,
  // E26 — the step's authorized output set. A path the role ceiling forbids
  // but the STEP's producer contract explicitly authorizes is NOT dropped:
  // the contract is the narrower, later authority (attempt-17 class bug —
  // the tester's authorized executable-test dir must survive parsing).
  authorizedOutputs?: string[]
): ParsedOutput {
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
    (l) => l.startsWith(SLE_ARTIFACT_OPEN) || l.startsWith(SLE_PATCH_OPEN) || l.trim() === SLE_ARTIFACT_CLOSE || l.trim() === SLE_PATCH_CLOSE
  );

  const patches: ParsedPatch[] = [];
  if (markerMode) {
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (line.startsWith(SLE_PATCH_OPEN)) {
        const pm = line.match(PATCH_MARKER_RE);
        if (!pm) {
          throw new ParseError(
            `Malformed patch marker (expected '${SLE_PATCH_OPEN}path="<path>" base="<sha256>">>>'): ${line.trim()}`,
            raw
          );
        }
        const patchPath = pm[1].trim();
        validateSectionPath(patchPath, raw);
        if (seenPaths.has(patchPath)) {
          throw new ParseError(`Duplicate path in output: ${patchPath}`, raw);
        }
        seenPaths.add(patchPath);
        const diffLines: string[] = [];
        i++;
        let patchClosed = false;
        while (i < lines.length) {
          if (lines[i].trim() === SLE_PATCH_CLOSE) {
            patchClosed = true;
            i++;
            break;
          }
          diffLines.push(lines[i]);
          i++;
        }
        if (!patchClosed) {
          throw new ParseError(
            `Patch marker opened but never closed (missing '${SLE_PATCH_CLOSE}'): ${patchPath}`,
            raw
          );
        }
        if (patches.some((p) => p.path === patchPath) || sections.some((sec) => sec.path === patchPath)) {
          throw new ParseError(`Duplicate path in output: ${patchPath}`, raw);
        }
        // E27r — the diff payload is preserved BYTE-FOR-BYTE: never trim it.
        // A trailing-whitespace '+' line is meaningful diff content, and the
        // zero-fuzz applier downstream must see exactly what the model sent.
        // Only a single final newline is normalized (appended when absent).
        const joinedDiff = diffLines.join('\n');
        if (Buffer.byteLength(joinedDiff, 'utf-8') > MAX_PATCH_BYTES) {
          throw new ParseError(
            `Patch content exceeds ${MAX_PATCH_BYTES / 1024} KB limit: ${patchPath} — keep hunks small and bounded`,
            raw
          );
        }
        patches.push({
          path: patchPath,
          base: pm[2].toLowerCase(),
          diff: joinedDiff.endsWith('\n') ? joinedDiff : joinedDiff + '\n',
        });
        continue;
      }
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
        const section = finalizeSection(rawPath, contentLines, raw, role, warnings, authorizedOutputs);
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

      const section = finalizeSection(rawPath, contentLines, raw, role, warnings, authorizedOutputs);
      if (section === null) continue;
      sections.push(section);
    }
  }

  // E27r — patches count toward the same changeset bound as sections: the
  // "bounded source edit" path must not become an unbounded side channel.
  if (sections.length + patches.length + warnings.length > MAX_PATCHES_TOTAL) {
    throw new ParseError(
      `Output contains more than ${MAX_PATCHES_TOTAL} sections+patches`,
      raw
    );
  }

  return patches.length > 0 ? { sections, warnings, patches } : { sections, warnings };
}

// Shared per-section finalization for both framings: emptiness, size cap,
// role allowlist (an unpermitted path is a warning + a dropped section).
function finalizeSection(
  rawPath: string,
  contentLines: string[],
  raw: string,
  role: AgentRole,
  warnings: string[],
  authorizedOutputs?: string[]
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

  const stepAuthorized = authorizedOutputs?.some((e) => matchesAuthorizedOutput(rawPath, e)) ?? false;
  if (!validateOutputPath(rawPath, role) && !stepAuthorized) {
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
