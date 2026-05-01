# Backlog System

| Type | Status | Updated |
|------|--------|---------|
| Spec | Draft | 2026-05-01 |

**Depends on:** ui-shell.md, project-overview.md, document-linking.md, beads-integration.md
**Source material:** vision/SLE-021-backlog-system.md
**Resolves:** —

## Overview

The backlog system is a lightweight mechanism for capturing latent work items
directly inside documents and nodes via a standard `## Backlog` markdown
section. It is **explicitly post-MVP** — this spec captures the design so the
architecture is preserved, but no implementation is planned for the initial
release.

The backlog is distinct from Beads (beads-integration.md). Beads tracks active
work through a DAG-driven cycle; the backlog captures latent work that has not
yet been promoted. The relationship is: **Beads is the engine; backlog is the
fuel tank.**

Any document or node can contain a single `## Backlog` section. Items are
plain markdown — bullet lists, paragraphs, or a mix. The system extracts items
from source files, enriches them with context metadata (group, layer, links),
and presents them in a queryable index. Promotion to Beads is manual only;
items are never auto-promoted.

Key design goals:

1. **Markdown-first.** Backlog items live in source files as standard markdown.
   The index is fully reconstructable from disk — no database.
2. **Append-friendly.** New items go at the bottom. No reordering required.
3. **Tag-optional.** Priority, effort, and area tags are available but never
   required. Items without tags are valid and appear last in sorted views.
4. **Manual promotion.** A backlog item becomes a Beads issue only when a human
   explicitly promotes it. The system never promotes automatically.

---

## Data model

### BacklogItem

```typescript
interface BacklogItem {
  id: string
  text: string
  sourceId: string
  sourceType: 'document' | 'node'
  group?: string
  layer?: string
  tags: InlineTag[]
  state: BacklogItemState
  beadsId?: string
  createdAt: string
  updatedAt: string
}
```

| Field | Description |
|---|---|
| `id` | Composite: `${sourceId}-${index}`, where index is the item's ordinal position within the `## Backlog` section |
| `text` | Raw markdown of the item, with inline tags stripped for display |
| `sourceId` | The document key or node address that contains this item |
| `sourceType` | `'document'` for project-scoped artifacts, `'node'` for group-scoped artifacts |
| `group` | Group name from SLE-016, present only when `sourceType` is `'node'` |
| `layer` | Lifecycle layer (Design, Plan, Build, etc.), present only when `sourceType` is `'node'` |
| `tags` | Extracted inline tags (priority, effort, area). May be empty. |
| `state` | Current lifecycle state (see States and transitions below) |
| `beadsId` | Beads issue ID after promotion. `undefined` until promoted. |
| `createdAt` | ISO timestamp of first extraction from source |
| `updatedAt` | ISO timestamp of most recent state change or text edit |

### InlineTag

```typescript
type InlineTag =
  | { kind: 'priority'; value: 'P0' | 'P1' | 'P2' | 'P3' }
  | { kind: 'effort'; value: 'S' | 'M' | 'L' | 'XL' }
  | { kind: 'area'; value: string }
```

| Tag | Values | Meaning |
|---|---|---|
| `@P` | P0 (urgent) → P3 (someday) | Priority ranking |
| `@effort` | S (minutes), M (hours), L (session), XL (multi-session) | Estimated effort |
| `@area` | freeform string — security, perf, ux, infra, docs, etc. | Categorization |

**Tag syntax in markdown:**

```
- Fix the auth token expiry race condition **@P1** **@effort:M** **@area:security**
- Rewrite pagination to use cursor-based approach @P2 @effort:L @area:perf
- Consider GraphQL federation someday @P3 @area:infra
```

Both bold (`**@TAG**`) and plain (`@TAG`) forms are accepted. The parser strips
tags from `text` and stores them in `tags[]`. Tags may appear anywhere in the
item text — beginning, middle, or end.

### BacklogItemState

```typescript
type BacklogItemState = 'captured' | 'acknowledged' | 'promoted' | 'done'
```

| State | Meaning | Markdown representation |
|---|---|---|
| `captured` | New, not yet reviewed | Plain text or `- item` |
| `acknowledged` | Reviewed and accepted as valid work | `- [✓] item` or `- [x] item` |
| `promoted` | Converted to a Beads issue | `- ~~item~~` with `<!-- promoted: BD-42 -->` |
| `done` | Completed or marked irrelevant | Strikethrough (`~~item~~`) without promotion comment |

State is determined by parsing markdown markers — the system does not maintain
a separate state file. The index is rebuilt from source files on every change.

### State transitions

```
captured → acknowledged → promoted → done
   └─────────────────────────→ done
```

- `captured → acknowledged`: Human marks item with `[✓]` or `[x]`
- `acknowledged → promoted`: Human promotes item to Beads (creates issue, inserts comment)
- `promoted → done`: Beads issue is closed or item is struck through
- Any state → `done`: Strikethrough without promotion (item is irrelevant)

There is no backward transition. Once promoted, an item cannot become captured
again. If the Beads issue is reopened, the backlog item remains in `promoted`
state — the source of truth for active work shifts to Beads.

### Backlog section in source files

A single `## Backlog` heading marks the backlog section within any markdown file.
If multiple `## Backlog` headings appear in the same file, their contents are
merged in document order — treated as a single logical section.

```markdown
## Backlog

- Fix the off-by-one error in pagination **@P1** **@effort:S** **@area:bug**
- Consider switching to connection pooling @P3 @area:perf
- The caching layer needs a TTL eviction policy **@P2** **@effort:L** **@area:infra**

A paragraph-style item is also valid. The parser treats any top-level content
within the section as an item, not just list elements.

- [✓] This item has been acknowledged and will be considered for promotion
- ~~This item was completed without promotion~~
- ~~This item was promoted to Beads~~ <!-- promoted: mp-a1b2 -->
```

The section ends at the next `##` heading or end of file, whichever comes first.

### Backlog index

```typescript
interface BacklogIndex {
  items: BacklogItem[]
  lastRebuiltAt: string
  sourceCount: number
}
```

The index is fully in-memory and derived from source files. It is rebuilt on
daemon startup and incrementally updated on file change events. No durable
storage — the index is reconstructable from disk at any time.

### Promotion record

When an item is promoted, the source file is modified in place:

```markdown
- ~~Fix the off-by-one error in pagination~~ <!-- promoted: mp-a1b2 -->
```

The promotion record has two parts:

1. **Strikethrough** — marks the item visually as promoted
2. **HTML comment** — `<!-- promoted: {beadsId} -->` on the same line, linking
   back to the Beads issue

The comment is placed after the strikethrough text, before any trailing
whitespace. Only one promotion comment per line. If an item is re-promoted (edge
case), the comment is updated with the new Beads ID.

---

## Behavior

### Parsing pipeline

```
Document/node files
  → Section scanner (finds ## Backlog in all .md files)
  → Item parser (splits into items, extracts inline tags)
  → Context enricher (resolves sourceId → group/layer via link index)
  → Backlog index (in-memory, rebuilt on startup or file change events)
  → WebSocket push (Overview page subscribes to backlog updates — see ui-shell.md)
```

**Section scanner:**

Walks all `.md` files registered in `map.yaml → artifacts.files`. For each file,
scans for `## Backlog` headings. If found, extracts the content between that
heading and the next `##` heading (or EOF).

**Item parser:**

Splits the section content into individual items. An item is:
- A list element (`- text` or `- [✓] text` or `- [x] text`)
- A paragraph (text block between blank lines, if not a list element)

For each item:
1. Strip inline tags → store in `tags[]`, store stripped text in `text`
2. Detect state from markdown markers (strikethrough, checkbox, promotion comment)
3. Extract `beadsId` from promotion comment if present
4. Assign `id` as `${sourceId}-${ordinalIndex}`

**Context enricher:**

For each item, resolves `sourceId` to group and layer metadata using the
document-linking.md link index. Documents get `sourceType: 'document'` with no
group/layer. Nodes get `sourceType: 'node'` with group and layer populated from
the artifact registry.

### Indexing lifecycle

**Startup (full reindex):**

1. Walk all artifacts in `map.yaml → artifacts.files`
2. For each `.md` artifact, scan for `## Backlog` sections
3. Parse all items from each section
4. Enrich with group/layer metadata from link index
5. Build `BacklogIndex` in memory
6. Emit `backlog.index_rebuilt` WebSocket event

**Incremental update (on file save):**

1. File watcher detects change to a `.md` artifact
2. Rescan only the changed file for `## Backlog` section
3. Diff new items against existing items for that `sourceId`
4. Add new items, update changed items, remove deleted items
5. Emit `backlog.index_updated` WebSocket event with counts

**File deletion:**

1. File watcher detects artifact deletion
2. Remove all items with that `sourceId` from the index
3. Emit `backlog.index_updated` WebSocket event

### Promotion flow

Promotion is always initiated by a human — via the UI or the REST API. The
system never auto-promotes.

**Steps:**

1. User selects an item and triggers promotion
2. System creates a Beads issue:
   ```
   title: first line of item text (truncated to 80 chars)
   description: full item text + source context
   priority: mapped from @P tag (P0→1, P1→2, P2→3, P3→4, no tag→3)
   ```
3. System modifies the source file:
   - Wraps item text in `~~strikethrough~~`
   - Appends `<!-- promoted: {beadsId} -->` on the same line
4. System updates the in-memory index:
   - Sets `state: 'promoted'`
   - Sets `beadsId` to the new issue ID
5. System emits `backlog.item_promoted` WebSocket event

**Rollback on failure:**

If the Beads issue creation fails (E090, E093), the source file is not modified.
The item remains in its current state. The error is surfaced to the user.

If the source file modification fails after Beads issue creation, the Beads
issue is closed with a comment noting the promotion was incomplete. The item
remains in its current state in the index.

### Ordering

No manual reordering in v1. Items are sorted for display using:

1. **Priority tag** — P0 first, P3 last, no-tag items last
2. **Chronological** — original position in source file (append order)

Within the same priority level, items maintain their source file order. This
ensures append-friendly behavior: new items go to the bottom of the `## Backlog`
section and sort naturally by priority.

### LLM interaction

**Facilitator agent:**

- Can append new items to `## Backlog` sections during chat sessions
- System prompt rules require:
  - Always use `## Backlog` heading
  - Append only (never reorder or delete existing items)
  - Tag appropriately when context allows (e.g., `@area` based on discussion)

**Planner agent:**

- Queries backlog index to find related latent work
- Uses backlog items to avoid duplicating known work in Beads
- Suggests promotions when a backlog item aligns with current active work

### UI components

**Backlog widget (Overview page — see ui-shell.md §Overview page behavior):**

A summary view showing top N items by priority, scoped to the current context. The backlog widget is an extensible panel on the Overview page (the dashboard), alongside Active Work, Jobs Processing, Actions Required, and Sharding Review.

- **Count line:** `"3 items in this group · 7 project-wide"`
- **[by source ▾] dropdown:** switches grouping modes
- Two primary views:
  - **By source:** document → group → layer — "What work is pending for feature X?"
  - **By tag:** @area → priority → effort — "Show me all security backlog items"

**Item display:**

Each item renders with:
- Stripped text (tags removed)
- Tag chips inline (P1, effort:M, area:security)
- State indicator (dot for captured, checkmark for acknowledged, Beads link for promoted, strikethrough for done)
- Source link (click to navigate to the originating document/node)

**Promotion action:**

Each non-promoted item shows a "Promote to Beads" button. On click:
1. Confirms the action (no undo — item stays as historical record)
2. Creates Beads issue and modifies source file
3. Item transitions to promoted state in-place

---

## API contract

### REST endpoints

**List backlog items:**

```
GET /api/v2/backlog

Query params (all optional):
  source_id:    Filter by source document/node ID
  source_type:  Filter by 'document' | 'node'
  group:        Filter by group name
  state:        Filter by BacklogItemState (comma-separated for multiple)
  tag_area:     Filter by @area value
  tag_priority: Filter by @P value (P0-P3)
  sort:         'priority' (default) | 'chronological'
  limit:        Max results (default 50, max 200)
  offset:       Pagination offset

Response 200:
{
  "ok": true,
  "data": {
    "items": BacklogItem[],
    "total": number,
    "counts": {
      "by_state": Record<BacklogItemState, number>,
      "by_source": Record<string, number>
    }
  }
}
```

**Get single backlog item:**

```
GET /api/v2/backlog/{item_id}

Response 200:
{
  "ok": true,
  "data": BacklogItem
}

Response 404: backlog_item_not_found
```

**Promote item to Beads:**

```
POST /api/v2/backlog/{item_id}/promote

Request:
{
  "priority_override": number | null
}

Response 200:
{
  "ok": true,
  "data": {
    "item_id": string,
    "beads_id": string,
    "beads_url": string,
    "state": "promoted"
  }
}

Response 404: backlog_item_not_found
Response 409: item_already_promoted
Response 422: beads_unavailable
```

**Append item to a source file:**

```
POST /api/v2/backlog

Request:
{
  "source_id": string,
  "text": string,
  "tags": InlineTag[]
}

Response 201:
{
  "ok": true,
  "data": {
    "item_id": string,
    "source_id": string,
    "state": "captured"
  }
}

Response 404: source_not_found
Response 422: source_has_no_backlog_section
```

Note: If the source file has no `## Backlog` section, the endpoint returns 422.
The Facilitator agent is responsible for creating the section heading when
appending to a file for the first time.

**Get backlog summary:**

```
GET /api/v2/backlog/summary

Query params:
  group:  Scope to a specific group (optional)
  scope:  'project' (default) | 'group'

Response 200:
{
  "ok": true,
  "data": {
    "total_items": number,
    "by_state": Record<BacklogItemState, number>,
    "by_area": Record<string, number>,
    "by_priority": Record<string, number>,
    "top_items": BacklogItem[],
    "sources": {
      "total": number,
      "with_backlog": number
    }
  }
}
```

### WebSocket events

```
event: backlog.index_rebuilt
{
  "item_count":    number,
  "source_count":  number,
  "duration_ms":   number,
  "timestamp":     string
}

event: backlog.index_updated
{
  "added":     number,
  "removed":   number,
  "updated":   number,
  "source_id": string | null,
  "timestamp": string
}

event: backlog.item_promoted
{
  "item_id":   string,
  "beads_id":  string,
  "source_id": string,
  "timestamp": string
}

event: backlog.item_appended
{
  "item_id":   string,
  "source_id": string,
  "text":      string,
  "timestamp": string
}
```

---

## Error cases

### Parsing errors

| Error code | Condition | Response | Recovery |
|---|---|---|---|
| `backlog_parse_failed` | `## Backlog` section contains malformed markdown that cannot be split into items | Items parsed successfully are indexed; malformed content is logged as a single raw-text item | User fixes source markdown |
| `duplicate_promotion_comment` | Line contains multiple `<!-- promoted: ... -->` comments | First comment wins; subsequent comments ignored, logged as warning | User removes duplicate comment |
| `invalid_tag_value` | Tag value outside expected range (e.g., `@P5`, `@effort:Giant`) | Tag ignored, not stored in `tags[]`. Item indexed without the invalid tag. | User corrects tag syntax |

### Promotion errors

| Error code | Condition | Response | Recovery |
|---|---|---|---|
| `item_already_promoted` | Item state is already `promoted` with a valid `beadsId` | 409 with existing `beadsId` | Client shows existing Beads link |
| `beads_unavailable` | BeadsTaskStore is active but `bd` not installed or remote unreachable | 422 with message suggesting local task store or install Beads | User resolves Beads connectivity |
| `promotion_write_failed` | Source file modification fails after Beads issue creation | Beads issue closed with comment; item state unchanged; error surfaced | User retries or manually creates Beads issue |
| `source_file_changed` | Source file was modified between index and promotion (race condition) | 409 with current file content hint | Reindex and retry |

### Index errors

| Error code | Condition | Response | Recovery |
|---|---|---|---|
| `source_not_found` | `source_id` does not match any artifact in `map.yaml` | 404 | Client refreshes artifact list |
| `source_has_no_backlog_section` | Source file exists but contains no `## Backlog` heading | 422 | Client creates section first |
| `reindex_in_progress` | Full reindex triggered while another is running | 409 with current reindex status | Wait for `backlog.index_rebuilt` event |
| `index_build_failed` | Unrecoverable error during full reindex | Empty index returned, error logged | Automatic retry on next startup |

### LLM agent errors

| Error code | Condition | Response | Recovery |
|---|---|---|---|
| `append_failed` | Agent attempted to append but source file was locked or modified concurrently | Error returned to agent context; agent retries or reports to user | Agent retries on next turn |

---

## Constraints

1. **Post-MVP only.** This spec captures design intent. No implementation is
   scheduled for the initial release. All endpoints, events, and UI components
   described here are deferred.

2. **Markdown-first, no database.** The backlog index is fully derived from
   source files. It is rebuilt in memory on startup and updated incrementally
   on file changes. No persistent storage beyond the source `.md` files.

3. **Single `## Backlog` section per document.** If multiple `## Backlog`
   headings appear in the same file, their contents are merged in document
   order and treated as one logical section. The parser does not reject
   duplicates — it concatenates.

4. **Manual promotion only.** The system never auto-promotes a backlog item to
   Beads. Every promotion requires an explicit human action (UI button or API
   call). LLM agents may suggest promotions but cannot execute them.

5. **No manual reordering in v1.** Items are sorted by priority tag then
   chronological order. Drag-and-drop reordering is deferred to a future
   iteration.

6. **Tags are optional and freeform.** `@area` accepts any string. The system
   does not validate area values against a controlled vocabulary. `@P` and
   `@effort` accept only their defined enum values; invalid values are silently
   ignored.

7. **Append-only authoring.** New items are appended to the end of the `##
   Backlog` section. The system does not insert items at arbitrary positions.
   This preserves merge-friendliness in version control.

8. **Promotion is one-way.** Once an item is promoted to Beads, it cannot be
   un-promoted. The backlog copy becomes a historical record linked to the
   Beads issue. The active work lives in Beads.

9. **No item deletion.** Items are marked done (strikethrough) or promoted.
   Physical deletion from the source file is a manual edit outside the system.
   The index reflects whatever is in the source file — if an item is deleted
   from the file, it disappears from the index on the next update.

10. **Backlog index depends on link index.** Context enrichment (resolving
    `sourceId` to group/layer) requires the link index from document-linking.md
    to be built first. The backlog index build runs after the link index is
    available.

11. **Item IDs are not stable across reindex.** IDs are derived from ordinal
    position (`${sourceId}-${index}`). If items are added or removed above an
    existing item, its index — and therefore its ID — changes. Clients should
    not rely on ID stability across reindexes. Use `sourceId` + text matching
    for durable references.

12. **Beads integration requires BeadsTaskStore.** Promotion is available only
    when the active task store is `BeadsTaskStore`. In local mode, the promote
    endpoint returns `422 beads_unavailable`.

---

## Open questions

| ID | Question | Impact | Status |
|---|---|---|---|
| BL-001 | Should the backlog be a dedicated panel on the Overview page (see ui-shell.md) or a mode within the Graph page? | UI architecture, navigation | Open |
| BL-002 | Should promoted items be auto-removed from the default view (hidden unless "show promoted" is toggled)? | Default view clutter vs. completeness | Open |
| BL-003 | Should backlog items support cross-linking to other items (e.g., "related to item in doc:architecture")? | Item connectivity, deduplication | Open |
| BL-004 | Should the Planner agent be allowed to auto-promote items when it detects alignment with active work, or always require human confirmation? | Agent autonomy vs. control | Open |
| BL-005 | Should items support comments/discussion threads, or is Chat the exclusive discussion mechanism? | Feature scope, data model complexity | Open |
| BL-006 | What is the performance target for full reindex with 100+ source files containing backlog sections? | Indexing architecture, incremental vs. full | Open |
| BL-007 | Should the `## Backlog` section be auto-created when the Facilitator appends the first item to a source file, or should it require the section to already exist? | Agent authoring behavior, error handling | Open |
| BL-008 | Should the backlog index persist to disk (e.g., `.sle/backlog-index.json`) for faster startup, or always rebuild from source files? | Startup time, consistency guarantees | Open |
| BL-009 | Should the API support bulk promotion (select multiple items → promote to a single Beads epic)? | Batch operations, UI workflow | Open |
| BL-010 | How should the system handle items whose source file is deleted or moved? Orphaned item detection and cleanup? | Data consistency, edge case handling | Open |
