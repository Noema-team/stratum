# DDR-015 — Link index — computed backlinks, not injected frontmatter

**Date:** 2026-04-13 · **Status:** accepted
**Resolves:** SLE-017, SLE-019 (Part 5)

## Context
The SLE-017 link index needs to track backlinks between entities. A decision was needed on whether backlinks are stored in document frontmatter or computed from forward links.

## Options considered
| Option | Pros | Cons |
|--------|------|------|
| Computed backlinks in a separate index | Documents remain readable as plain markdown; no noise in raw text; index fully rebuildable from forward links | Separate index to maintain |
| Injected frontmatter into document files | Backlinks visible in the file itself | Noisy raw text; document content mixed with link registry |
| No backlink tracking | Simplest | No cross-reference discovery |

## Decision
The link index is computed and stored in a separate index, not injected as frontmatter into document files. Backlinks are surfaced in the UI as a backlink panel. Frontmatter injection is opt-in for export only.

## Consequences
- Documents remain readable as plain markdown — content is signal, not link registry
- Link index can be rebuilt fully from forward links at any time
- Consistent with Obsidian's approach (backlinks computed on open)
- Export can optionally inject `backlinks:` frontmatter block (off by default)
- Link index is rebuilt incrementally on save; query latency is sub-millisecond for most lookups (in-process Map)
- Full rebuild from cold is fast enough to run on daemon startup
