# Document Linking

**Type:** spec · **Status:** draft · **Updated:** 2026-04-22
**Depends on:** DDR-013, DDR-025, DDR-018, types.md §1/§5, map-yaml-schema.md §context/§graph
**Source material:** SLE-017 (document / node split & linking system)

## Overview

The document linking system draws a precise boundary between two artifact
scopes — **documents** (project-level reference material) and **nodes**
(group-scoped work units) — and connects them into a traversable knowledge
graph. Every artifact managed by SLE is classified as one or the other. The
link index tracks forward links between entities, computes bidirectional
backlinks on every mutation, and exposes the result to agents as structured
memory (DDR-018).

Links are generated automatically at two operational tiers (structural and
contextual), with a third semantic tier deferred to post-MVP. Users may also
create manual links via the `[[wikilink]]` authoring syntax. The link index
is rebuilt incrementally on each change and fully on daemon startup.

The system is grounded in the DDR-025 typed reference format (`doc:{key}` and
`node:{group}:{key}`) used throughout map.yaml. It does not introduce a
parallel addressing scheme.

## Data model

### Artifact scope classification

DDR-013 established the document/node split. DDR-025 added the `scope` field
to `ArtifactEntry`. Every artifact in `map.yaml → artifacts.files` carries
exactly one scope:

```typescript
type ArtifactScope = 'project' | 'group' | 'run' | 'ephemeral'
```

| Scope | Term | Ownership | Examples |
|---|---|---|---|
| `project` | Document | No single group owns it | `requirements.md`, `architecture.md`, `decisions.md`, `evaluation.md` |
| `group` | Node | Owned by a specific group and layer | `rate-limiting/architecture.md`, `auth/test-plan.md` |

Classification is determined at artifact rule declaration in `artifacts.yaml`
and recorded in `map.yaml → artifacts.files[{key}].scope`. When `scope` is
`group`, the entry also carries a `group` field identifying the owning group.

**Classification rules:**

| Artifact | Always scope | Reason |
|---|---|---|
| `decisions.md` | `project` | Accumulates decisions across all groups |
| `requirements.md` (project) | `project` | Cross-cutting requirements document |
| `architecture.md` (project overview) | `project` | Describes the whole system |
| `evaluation.md` | `project` | Project-level evaluation output |
| `test-plan.md` (project) | `project` | Project-level test strategy |
| Architecture doc for one feature | `group` | Owned by a specific group's Design layer |
| Requirements for one feature | `group` | Owned by a specific group |
| Test plan for one feature | `group` | Owned by a specific group |
| Research findings for a spike | `group` | Owned by a specific group's Research layer |

### Typed reference format (DDR-025)

The canonical addressing scheme for artifact slices:

```typescript
type ArtifactRef = `doc:${string}` | `node:${string}:${string}`
```

| Format | Scope | Resolves to | Example |
|---|---|---|---|
| `doc:{key}` | project | `artifacts.files[{key}]` where `scope: project` | `doc:requirements` |
| `node:{group}:{key}` | group | `artifacts.files[{key}]` where `scope: group` and `group` matches | `node:rate-limiting:architecture` |

The wildcard form `node:*:{key}` loads from all groups that contain the given
key. It is permitted in `context.agent_slices` but forbidden in link index
entries (all links must resolve to exactly one target).

### Link entity types

Links connect four entity types. Source code files are first-class link targets
but live on the filesystem, not in `artifacts.files`.

```typescript
type LinkEntityKind = 'node' | 'document' | 'source_file' | 'test_file'
```

| Entity | Storage | Scope | Address format |
|---|---|---|---|
| Node artifact | `map.yaml → artifacts.files` | `group` | `node:{group}:{key}` |
| Document artifact | `map.yaml → artifacts.files` | `project` | `doc:{key}` |
| Source file | Filesystem under `repo.src` | None | Relative path: `src/middleware/rate-limit.ts` |
| Test file | Filesystem under `repo.tests` | None | Relative path: `tests/rate-limit.test.ts` |

Source and test files are discovered by walking the project tree. They are
never embedded in the graph — a Code layer node in a group holds metadata
that references a file path, and the file is a link target.

### Link target

```typescript
type LinkTarget =
  | { kind: 'node'; group: string; key: string }
  | { kind: 'document'; key: string }
  | { kind: 'source_file'; path: string }
  | { kind: 'test_file'; path: string }
```

### Link record

```typescript
interface Link {
  id: string
  source: LinkSource
  target: LinkTarget
  link_type: AutoLinkType | 'manual'
  context: string
  created_at: string
  created_by: 'sle' | 'user'
}

type LinkSource =
  | { kind: 'node'; group: string; key: string }
  | { kind: 'document'; key: string }
```

### Auto-link types

```typescript
type AutoLinkType =
  | 'structural_dag'
  | 'structural_declaration'
  | 'contextual_execution'
```

| Type | Tier | Source | Cost | Certainty |
|---|---|---|---|---|
| `structural_dag` | 1 | DAG edges between nodes | Free | Always accurate |
| `structural_declaration` | 1 | Task context declarations (`TaskContextDeclaration.slices`) | Free | Always accurate |
| `contextual_execution` | 2 | Agent context window contents during execution | Low | High — reflects actual context loaded |
| `semantic_suggested` | 3 | Post-MVP: Cognee conceptual relationships | High | Low — suggestions only |
| `semantic_confirmed` | 3 | Post-MVP: user-accepted semantic links | High | Medium — user-validated |

Tier 3 types are reserved for post-MVP. The system operates fully with Tiers
1 and 2. Tier 3 types appear in the union for forward compatibility but the
daemon never produces them in the current implementation.

### Backlink record

Backlinks are the inverse of forward links. They are computed, not stored
durably — the backlink map is rebuilt from the forward link index on every
indexing pass and kept in memory.

```typescript
interface Backlink {
  from: LinkSource
  context: string
  link_type: AutoLinkType | 'manual'
  resolved_label: string
}
```

`resolved_label` is a human-readable string such as `"plan-rate-limit (Plan · Rate Limiting)"`
derived from the source entity's metadata at computation time.

### Forward link

```typescript
interface ForwardLink {
  source: LinkSource
  target: LinkTarget
  link_type: AutoLinkType | 'manual'
  context: string
  created_at: string
}
```

### Link index

The link index is the agent memory store (DDR-018). It is persisted to disk
and loaded on daemon startup.

```typescript
interface LinkIndex {
  version: number
  last_rebuilt_at: string
  links: ForwardLink[]
  backlinks: Map<string, Backlink[]>
  file_index: FileIndex
  document_index: DocumentIndex
}
```

Storage path: `.sle/link-index/`

```
.sle/link-index/
├── forward-links.json
├── file-index.json
└── document-index.json
```

Backlinks are not persisted — they are computed from `forward-links.json` on
startup and kept in memory. They are regenerated on every link mutation.

### File index

```typescript
interface FileIndex {
  files: Map<string, FileEntry>
}

interface FileEntry {
  path: string
  language: string
  last_modified: string
  line_count: number
  referencing_nodes: string[]
  group_id: string | null
  layer: string | null
}
```

A file's `group_id` and `layer` are derived by checking which Code layer nodes
reference the file path. If no Code layer node references the file, both are
`null` — the file appears in the file index but has no graph connection.

File indexing configuration is read from `map.yaml → repo`:

```typescript
interface FileIndexConfig {
  source_dirs: string[]
  test_dirs: string[]
  exclude_patterns: string[]
}
```

Derived from `repo.src`, `repo.tests`, and a built-in exclude list
(`node_modules/`, `.git/`, `dist/`, `build/`, `coverage/`).

### Document index

```typescript
interface DocumentIndex {
  documents: Map<string, DocumentEntry>
}

interface DocumentEntry {
  key: string
  path: string
  title: string
  description: string
  tags: string[]
  source: 'user' | 'sle_generated' | 'sle_suggested'
  last_modified: string
  modified_by: 'user' | 'sle'
  backlink_count: number
}
```

Populated from `map.yaml → artifacts.files` entries where `scope: project`.
The `backlink_count` is set during backlink computation and cached here for
fast lookup without scanning the full backlink map.

### Wikilink authoring syntax

The `[[wikilink]]` syntax is a user-facing authoring convention supported in
all text fields (node content, document bodies, task descriptions). It is
parsed at index time and converted to internal `LinkTarget` representations.

| Wikilink form | Internal resolution | Example |
|---|---|---|
| `[[doc:{key}]]` | `{ kind: 'document', key }` | `[[doc:decisions]]` |
| `[[doc:{key}#{section}]]` | `{ kind: 'document', key }` + section context | `[[doc:architecture#middleware]]` |
| `[[node:{group}:{key}]]` | `{ kind: 'node', group, key }` | `[[node:rate-limiting:architecture]]` |
| `[[src/{path}]]` | `{ kind: 'source_file', path }` | `[[src/middleware/rate-limit.ts]]` |
| `[[tests/{path}]]` | `{ kind: 'test_file', path }` | `[[tests/rate-limit.test.ts]]` |
| `[[group:{id}]]` | Resolved to all nodes in the group (expands to multiple links) | `[[group:rate-limiting]]` |

The section fragment (`#section`) is stored in the link's `context` field and
used for display but does not affect link resolution — it resolves to the
same artifact regardless of section.

Regex for extraction:

```
\[\[(doc:[a-zA-Z0-9_-]+(?:#[a-zA-Z0-9_-]+)?|node:[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+|src/[^\]]+|tests/[^\]]+|group:[a-zA-Z0-9_-]+)\]\]
```

### Link index in map.yaml

The link index metadata is surfaced in `map.yaml → graph`:

```yaml
graph:
  link_count: 47
  last_rebuilt_at: "2026-04-17T09:00:00Z"
```

These fields are updated on every link index rebuild. The full link index data
lives in `.sle/link-index/` and is not embedded in map.yaml.

## Behavior

### Indexing lifecycle

The link index follows a defined lifecycle tied to daemon startup and runtime
events.

**Startup (full reindex):**

1. Load `.sle/link-index/forward-links.json`
2. Walk all artifacts in `map.yaml → artifacts.files`
3. Parse each artifact's content for `[[wikilink]]` patterns
4. Walk source tree (`repo.src`, `repo.tests`) to rebuild `FileIndex`
5. Resolve each link target against artifact registry and filesystem
6. Compute backlink map from forward links
7. Write `map.yaml → graph.link_count` and `graph.last_rebuilt_at`
8. Emit `link.index_rebuilt` WebSocket event

**Incremental update (on mutation):**

1. On artifact save: parse the saved artifact for `[[wikilink]]` patterns
2. Diff new links against existing forward links for that source
3. Remove stale links, add new links
4. Recompute backlinks for affected targets only
5. Update `map.yaml → graph.link_count`
6. Emit `link.index_updated` WebSocket event

**File change (file watcher):**

1. Find all Code layer nodes referencing the changed file path
2. Update `FileEntry` metadata (`line_count`, `last_modified`)
3. Emit `link.file_updated` WebSocket event with affected backlinks

### Auto-linking — Tier 1: Structural

Structural links are derived directly from data the system already tracks.
No LLM inference or additional computation is required.

**From DAG edges (`structural_dag`):**

When the DAG runner completes a node, it records which upstream nodes produced
inputs. Each input→output relationship becomes a structural link.

| DAG transition | Link source | Link target |
|---|---|---|
| DESIGN consumes requirements | `node:{group}:requirements` or `doc:requirements` | `node:{group}:architecture` or `doc:architecture` |
| PLAN consumes architecture | Architecture artifact | Plan artifact |
| BUILD consumes plan + test-plan | Plan + test plan artifacts | Implementation outputs |
| TEST consumes requirements + test-plan | Requirements + test plan artifacts | Test results |
| EVALUATE consumes evaluation + requirements | Evaluation + requirements | Verdict |

Links are created after the downstream node completes successfully. The DAG
runner emits a `dag.node_completed` event carrying the input artifact refs,
which the link indexer consumes.

**From task context declarations (`structural_declaration`):**

When a task declares its context via `TaskContextDeclaration.slices`, each
declared `ArtifactRef` becomes a link from the task to that artifact. These
links exist in the `declared` context assembly mode.

```
Task "implement-rate-limiting" declares:
  slices: ["doc:requirements", "node:rate-limiting:architecture", "doc:test-plan"]

Produces:
  task:implement-rate-limiting → doc:requirements (structural_declaration)
  task:implement-rate-limiting → node:rate-limiting:architecture (structural_declaration)
  task:implement-rate-limiting → doc:test-plan (structural_declaration)
```

Task-to-artifact links are created when the task is claimed and removed when
the task is closed, preventing stale links from accumulating.

### Auto-linking — Tier 2: Contextual

When an agent executes a job, the context manager records which artifact
slices were actually loaded into its context window (not just declared). These
become `contextual_execution` links: "agent X was informed by artifact Y during
execution."

Contextual links may differ from declared context because:
- The context manager may have loaded a wider section than declared
- Token truncation may have removed some declared slices
- The `inferred` context assembly mode uses role-based defaults, not declarations

```typescript
interface ContextualLinkRecord {
  role: AgentRole
  cycle: number
  iteration: number
  dag_node: DAGNode
  loaded_slices: ArtifactRef[]
  truncated_slices: ArtifactRef[]
}
```

After each agent invocation completes, the context manager emits a
`context.assembled` event carrying `loaded_slices` and `truncated_slices`.
The link indexer converts each loaded slice to a `contextual_execution` link
from the DAG node's output artifact to the loaded slice.

If a slice was truncated, the link is still created but the `context` field
notes `"(truncated)"`. This preserves the provenance record even when the full
content was not available to the agent.

### Manual linking

Users create manual links by typing `[[` in any text field. The authoring
interface triggers autocomplete against the link index:

```
User types: "Informed by [["
Autocomplete shows:
  [[doc:decisions]]                        — Document · Design decisions log
  [[node:rate-limiting:architecture]]      — Node · Rate Limiting · Architecture
  [[src/middleware/rate-limit.ts]]          — Source · Rate Limiting · Code
  [[tests/rate-limit.test.ts]]             — Test · Rate Limiting · Test
```

Autocomplete results are ordered by:
1. Entity kind: documents first, then nodes, then files
2. Relevance: group-matched entities first (if viewing a group context)
3. Alphabetical within each tier

Manual links carry `created_by: 'user'` and `link_type: 'manual'`. They are
never automatically removed — they persist until the user deletes the
`[[wikilink]]` text or the target entity is deleted.

### Backlink computation

Backlinks are computed as the inverse of forward links:

```
forward_links.filter(l => l.target == entity)
  → map to Backlink { from: l.source, context: l.context, link_type: l.link_type }
```

The backlink map is a `Map<string, Backlink[]>` keyed by the stringified
`LinkTarget`. It is fully recomputed on startup and incrementally updated on
each mutation:

1. On link addition: compute backlink, append to target's array
2. On link removal: remove matching backlink from target's array
3. On source deletion: remove all backlinks originating from that source

Backlinks are exposed to the rendering layer and to agents via the link index
query API. The Facilitator uses backlinks to understand which documents a node
depends on and which nodes reference a document.

### Source file indexing

Source and test files are indexed by walking the project tree. Indexing runs:

- On daemon startup (full walk)
- On file change (incremental via file watcher)
- On `sle index` command (manual full reindex)

**Full walk algorithm:**

1. Read `map.yaml → repo.src` and `repo.tests` directories
2. Recursively walk each directory, excluding built-in patterns
3. For each file, record `FileEntry` with path, language (inferred from extension),
   `last_modified` (from filesystem stat), and `line_count`
4. Cross-reference against Code layer nodes in `map.yaml → artifacts.files`
   to populate `referencing_nodes`, `group_id`, and `layer`
5. Write `file-index.json`

**Incremental update algorithm:**

1. File watcher emits change event for a specific path
2. If the path matches a known file: update metadata in `FileIndex`
3. If the path is new: create `FileEntry`, attempt group matching
4. If the path was deleted: remove `FileEntry`, update referencing nodes
5. Write `file-index.json`

Language is inferred from file extension:

| Extension | Language |
|---|---|
| `.ts`, `.tsx` | typescript |
| `.js`, `.jsx` | javascript |
| `.py` | python |
| `.rs` | rust |
| `.go` | go |
| Other | `unknown` |

### Agent interaction with links

The link index serves as agent memory (DDR-018). Agents interact with it in
three ways:

**Reading (all agents):**

The context manager injects relevant backlinks into the agent's context window
alongside declared artifact slices. When the Planner reads `doc:requirements`,
it also receives the backlinks showing which nodes reference those requirements.

**Writing (via DAG runner):**

The DAG runner creates structural links on behalf of agents after each node
completion. Agents do not write links directly — the runner knows the input→output
mapping.

**Querying (Facilitator):**

The Facilitator is the primary consumer of the link index during chat and
decision modes. It queries backlinks to:
- Explain which artifacts a decision would affect
- Trace the provenance of a requirement back to its spike
- Identify orphaned documents that no node references

### Link resolution

When an agent or interface resolves an `ArtifactRef`, the following lookup
occurs:

```
doc:{key} → map.yaml.artifacts.files[{key}] where scope == 'project'
             → read file at artifacts.files[{key}].path
             → slice to token budget

node:{group}:{key} → map.yaml.artifacts.files[{key}] where scope == 'group' and group == {group}
                      → read file at artifacts.files[{key}].path
                      → slice to token budget
```

The existing `GET /api/v2/context/resolve?ref={ArtifactRef}` endpoint handles
this. See daemon-api-endpoints.md §Resolve artifact reference.

### Link rendering pipeline

Links render in all text views (graph node details, document viewer, file
inspector) through a standard pipeline:

1. Extract all `[[...]]` patterns from raw text via regex
2. Resolve each target against the link index
3. Replace with rendered chip: label + icon + click handler
4. Unresolved links render as red chips with "not found" tooltip

| Entity kind | Chip icon | Chip label |
|---|---|---|
| `node` | Layer-specific | `{key} · {group} · {layer}` |
| `document` | 📄 | `{key}` |
| `source_file` | 📝 | `{filename}` |
| `test_file` | 🧪 | `{filename}` |
| Unresolved | ⚠️ | `{raw_text}` (red) |

Hover previews show entity metadata: scope, group, layer, status, backlink
count, first line of content.

## API contract

daemon-api.md is the single source of truth for all REST endpoints. The
endpoints below are defined there and listed here for cross-reference only.

### Existing endpoints used by the linking system

| Endpoint | Method | Purpose | daemon-api.md section |
|---|---|---|---|
| `/api/v2/artifacts` | GET | List all artifacts (includes `scope` field) | List artifacts |
| `/api/v2/artifacts/{id}` | GET | Read artifact content and metadata | Read artifact |
| `/api/v2/artifacts/{id}/diff` | GET | Diff artifact against a previous version | Diff artifact |
| `/api/v2/context/resolve` | GET | Resolve an `ArtifactRef` to path, scope, token count | Resolve artifact reference |
| `/api/v2/context/slices/{role}` | GET | Get slice configuration for a role (includes typed refs) | Get slice config |
| `/api/v2/map` | GET | Full map.yaml (includes `graph.link_count`) | Get map |

### New endpoints for link index operations

These endpoints are specified here and will be added to daemon-api.md.

**List links for an entity:**

```
GET /api/v2/links?source={LinkSource}&target={LinkTarget}&link_type={string}&limit={number}

Query params (all optional):
  source:     JSON-encoded LinkSource (kind + key/group)
  target:     JSON-encoded LinkTarget (kind + key/path/group)
  link_type:  Filter by AutoLinkType | 'manual'
  limit:      Max results (default 100, max 500)

Response 200:
{
  "ok": true,
  "data": {
    "links": ForwardLink[],
    "total": number
  }
}
```

**Get backlinks for an entity:**

```
GET /api/v2/links/backlinks?target={LinkTarget}

Query params:
  target: JSON-encoded LinkTarget (required)

Response 200:
{
  "ok": true,
  "data": {
    "backlinks": Backlink[],
    "count": number
  }
}
```

**Create manual link:**

```
POST /api/v2/links

Request:
{
  "source": LinkSource,
  "target": LinkTarget,
  "context": string
}

Response 201:
{
  "ok": true,
  "data": {
    "link_id": string,
    "source": LinkSource,
    "target": LinkTarget,
    "link_type": "manual",
    "created_at": string
  }
}

Response 409: link_already_exists
Response 400: invalid_link_target
Response 400: invalid_link_source
```

**Delete manual link:**

```
DELETE /api/v2/links/{link_id}

Response 200:
{
  "ok": true,
  "data": {
    "link_id": string,
    "deleted": true
  }
}

Response 404: link_not_found
Response 403: cannot_delete_auto_link
```

**Trigger full reindex:**

```
POST /api/v2/links/reindex

Response 202:
{
  "ok": true,
  "data": {
    "status": "reindexing",
    "started_at": string
  }
}
```

**Get file index entry:**

```
GET /api/v2/links/files/{path}

Response 200:
{
  "ok": true,
  "data": FileEntry
}

Response 404: file_not_indexed
```

### WebSocket events

```
event: link.created
{
  "link_id": string,
  "source": LinkSource,
  "target": LinkTarget,
  "link_type": string,
  "timestamp": string
}

event: link.deleted
{
  "link_id": string,
  "source": LinkSource,
  "target": LinkTarget,
  "timestamp": string
}

event: link.index_rebuilt
{
  "link_count": number,
  "file_count": number,
  "document_count": number,
  "duration_ms": number,
  "timestamp": string
}

event: link.index_updated
{
  "added": number,
  "removed": number,
  "timestamp": string
}

event: link.file_updated
{
  "path": string,
  "affected_backlinks": number,
  "timestamp": string
}
```

## Error cases

| Error code | Condition | Response | Recovery |
|---|---|---|---|
| `invalid_link_target` | Target does not resolve to any known entity | 400 with unresolved target | User corrects the wikilink |
| `invalid_link_source` | Source is not a valid artifact (not in `artifacts.files`) | 400 with invalid source | User corrects the source reference |
| `link_already_exists` | Duplicate forward link (same source + target + type) | 409 with existing link ID | Client uses existing link instead |
| `cannot_delete_auto_link` | DELETE on a structural or contextual link | 403 with link type | Auto links are managed by the system |
| `link_not_found` | DELETE for a non-existent link ID | 404 | Client refreshes link list |
| `circular_link` | Manual link would create a direct cycle (A→B→A) | 400 with cycle path | Not enforced for indirect cycles (too expensive); only direct self-references and two-node loops |
| `file_not_indexed` | GET file index entry for a path not in the index | 404 | Run `POST /links/reindex` |
| `reindex_in_progress` | POST reindex while a reindex is already running | 409 with current reindex status | Wait for completion event |
| `target_entity_deleted` | Link target was deleted (artifact removed or file deleted) | Link rendered as unresolved (red chip) | Link is NOT auto-deleted; it becomes a broken link. Full reindex prunes orphaned links. |
| `orphaned_links_detected` | After reindex, links reference non-existent entities | Logged as warning, not an error response | Pruned during reindex; emit `link.deleted` for each pruned link |
| `file_index_walk_failed` | Source directory does not exist or is unreadable | Logged as error, partial index returned | Check `repo.src` and `repo.tests` in map.yaml |
| `link_index_corrupt` | `forward-links.json` fails to parse on startup | Logged as error, full reindex triggered automatically | Automatic recovery via reindex |
| `budget_exceeded_on_index` | Link count exceeds 10,000 | Warning logged, indexing continues | User should prune or restructure. No hard limit enforced. |

## Constraints

1. **Single source of truth for scope.** The `scope` field on `ArtifactEntry`
   in map.yaml is the authoritative classification. The link index never
   duplicates or overrides scope decisions. If an artifact's scope changes,
   the link index is rebuilt for all links involving that artifact.

2. **DDR-025 format is mandatory.** All internal link representations use the
   `doc:{key}` and `node:{group}:{key}` format. The `[[wikilink]]` syntax is
   an authoring convenience that is parsed and converted at index time. The
   link index never stores raw wikilink strings.

3. **Wildcard refs are forbidden in links.** The `node:*:{key}` form is
   permitted in `context.agent_slices` for loading slices from all groups, but
   every link in the index must resolve to exactly one target entity. A
   wildcard reference in a wikilink is an error at parse time.

4. **Backlinks are always computed.** Backlinks are never stored durably. They
   are derived from forward links on every indexing pass and kept in memory.
   This prevents stale backlinks and eliminates a consistency class.

5. **Auto links are read-only.** Structural and contextual links cannot be
   created or deleted via the API. They are managed entirely by the DAG runner
   and context manager. Manual links are the only user-writeable link type.

6. **Link index is append-friendly.** Forward links are appended to the index
   on creation. Removal is by ID, not by rewriting the file. The index is
   compacted during full reindex (removing orphaned and duplicate links).

7. **Agent memory constraint (DDR-018).** The link index doubles as agent
   memory. When the Facilitator operates in decision mode, it queries backlinks
   to assess the blast radius of a proposed change. The backlink query must
   return in under 50ms for any entity — enforced by the in-memory map.

8. **Incremental index updates are atomic.** When an artifact save triggers
   link re-extraction, the old links for that source are removed and new links
   are added in a single write to `forward-links.json`. A crash mid-write
   triggers a full reindex on next startup.

9. **System states do not block indexing.** The link index updates regardless
   of `meta.status` (idle, discovering, cycling, halted, complete). Link
   indexing never waits for a state transition. This includes the flag-based
   pauses (awaiting_confirmation, awaiting_sharding_approval) — the DAG runner
   continues to update structural links even while paused.

10. **File indexing respects exclude patterns.** The built-in exclude list
    (`node_modules/`, `.git/`, `dist/`, `build/`, `coverage/`, `.sle/`) is
    always applied. User-defined exclude patterns may be added via
    `artifacts.yaml` in a future revision.

11. **No link versioning.** Links are not versioned alongside artifacts. When
    an artifact is modified, its links are re-extracted from the new content.
    Old links are replaced, not preserved. The DAG event log (map.yaml →
    cycle.nodes_completed) provides the historical provenance record.

12. **Manual link ownership.** Manual links carry `created_by: 'user'`. When
    the source artifact is regenerated by a cycle, manual links embedded in
    the artifact's text are re-parsed and preserved. Manual links added via
    the API (not in text) are preserved across regenerations because they are
    stored by source entity, not by artifact content.

13. **Performance targets.** For a project with 50 groups, 500 nodes, 20
    documents, and 2000 source files: forward link count ~2000-5000, backlink
    computation under 500ms, full reindex under 2 seconds, incremental update
    under 100ms, link resolution O(1) per link via map lookup.

## Open questions

| ID | Question | Impact | Status |
|---|---|---|---|
| DL-001 | Should the link index support link versioning to trace how relationships evolved across cycles? | History tracking, audit trail | Open |
| DL-002 | What is the maximum number of backlinks before the rendering layer truncates or paginates? | UI performance, API pagination | Open |
| DL-003 | Should `semantic_suggested` and `semantic_confirmed` link types be pre-registered in the schema now, or deferred entirely to the Cognee integration spec? | Schema stability, forward compatibility | Open |
| DL-004 | When a group is deleted, should links from its nodes be removed immediately or marked as orphaned and pruned on next reindex? | Data consistency, recovery | Open |
| DL-005 | Should the file watcher debounce changes (e.g., 500ms) before triggering incremental index updates? | Performance during rapid file changes | Open |
| DL-006 | Should the link index expose a graph traversal API (e.g., shortest path between two entities) for the Facilitator, or limit queries to single-hop backlinks? | Facilitator capability, query complexity | Open |
| DL-007 | Is there a maximum file size beyond which source files are excluded from the file index? | Memory usage, indexing time | Open |
| DL-008 | Should link context (the surrounding text of a wikilink) be stored verbatim or summarized to a max length? | Storage size, display in backlink panel | Open |
