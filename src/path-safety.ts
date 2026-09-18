import path from 'path';

// Shared path-safety primitive (D.1c). Used by both agent-runner.ts (declared
// and legacy write paths) and context-manager.ts (declared and role-default
// artifact refs) so there is exactly one definition of "safe" rather than two
// independently-maintained ones that could drift apart.
//
// Conservative by design: rejects any '..' segment outright rather than
// resolving the path and checking whether the result stays inside some root.
// A resolve-then-contain check is insufficient on its own — an internally
// traversing path like '.sle/work/../../src/evil.ts' resolves to somewhere
// inside projectRoot (so a naive containment check passes it) while a
// string-prefix ceiling check like `.startsWith('.sle/work/')` also passes,
// because the raw string literally starts with that prefix — yet the path
// that actually gets opened for I/O is 'src/evil.ts', outside both. Banning
// '..' outright removes the entire class of divergence between what gets
// validated and what gets resolved.
//
// Returns the input's path segments with '.' and empty segments dropped, or
// null if the input is empty, absolute, or contains a '..' segment.
export function safeRelativeSegments(input: string): string[] | null {
  if (!input) return null;
  if (path.isAbsolute(input)) return null;
  const raw = input.split(/[/\\]/);
  if (raw.some((s) => s === '..')) return null;
  const segments = raw.filter((s) => s !== '' && s !== '.');
  if (segments.length === 0) return null;
  return segments;
}

// Convenience wrapper: the canonical posix-style relative path string (no
// '..', no '.', no empty segments, forward slashes only), or null if unsafe.
// This is the single value every downstream check/write/record should use —
// never re-derive a path from the original unvalidated input.
export function toSafeRelativePath(input: string): string | null {
  const segments = safeRelativeSegments(input);
  return segments ? segments.join('/') : null;
}
