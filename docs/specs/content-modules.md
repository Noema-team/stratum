# Content Modules

**Type:** spec · **Status:** draft · **Updated:** 2026-04-22
**Depends on:** DDR-013 (document/node split), DDR-015 (computed backlinks), reference/types.md
**Source material:** SLE-015 (content modules)

## Overview

Content modules extend the graph system with two capabilities: a content-rich
node store and pluggable layer modules. The content store lets any node hold
arbitrary content — documents, code, logs, structured data — stored separately
from graph metadata but linked 1:1. Layer modules are pluggable processors that
attach to a single graph layer, read node content, and produce annotations,
derived nodes, or attachments without modifying the core graph.

This is a post-MVP extension. The content store and layer modules are not
required for the core cycle loop. This spec exists as a design reference for
when the core system is running and users need pluggable analysis capabilities.

DDR-013 establishes the document/node split: nodes have group scope, documents
have project scope, and source files are linked targets not embedded in the
graph. The content store operates on nodes only. Documents and source files
remain in their respective stores (`.sle/project-docs/` and the filesystem).

## Data model

### Content primitives

```typescript
export type ContentFormat =
  | 'markdown' | 'code' | 'json' | 'html' | 'yaml' | 'log' | 'binary'

export type ModuleOutputType =
  | 'annotation' | 'derived_node' | 'attachment' | 'log'

export type TriggerType =
  | 'on_node_created'
  | 'on_content_written'
  | 'on_node_state_changed'
  | 'on_cycle_complete'
  | 'on_user_action'
  | 'on_schedule'
  | 'on_demand'
```

### NodeContent

Every node can have an optional content record. The graph `data` field stays as
a summary/index for traversal; the content record holds the full substantive
data.

```typescript
export interface NodeContent {
  node_id: string
  format: ContentFormat
  body: string
  attachments: Attachment[]
  size_bytes: number
  checksum: string
  created_at: string
  updated_at: string
}
```

### Attachment

```typescript
export interface Attachment {
  id: string
  filename: string
  mime_type: string
  size_bytes: number
  storage_ref: string
}
```

Attachments are stored as separate blobs. The `storage_ref` points to a path
in the blob store under `.sle/graph/content/blobs/`.

### LayerModule

```typescript
export interface LayerModule {
  id: string
  name: string
  version: string
  layer: LayerIndex
  inputSchema: ModuleInputSchema
  outputs: ModuleOutput[]
  process(
    nodes: NodeWithContent[],
    context: ModuleContext
  ): Promise<ModuleResult>
  dashboard?: ModuleDashboard
}
```

A module attaches to exactly one layer. It reads content from nodes in that
layer, processes it, and produces outputs. Modules never modify the core graph
structure.

### ModuleInputSchema

```typescript
export interface ModuleInputSchema {
  nodeTypes: NodeType[]
  contentFormats?: ContentFormat[]
  dataFields?: string[]
}
```

Declares what a module reads. The daemon filters candidate nodes against this
schema before passing them to `process()`.

### ModuleOutput

```typescript
export interface ModuleOutput {
  type: ModuleOutputType
  schema: object
}
```

Declares what a module produces. The schema is a JSON Schema used to validate
outputs before persisting.

### ModuleContext

```typescript
export interface ModuleContext {
  graph: GraphData
  contentStore: ContentStoreReader
  logger: ModuleLogger
  config: Record<string, unknown>
}
```

Read-only context injected into every module invocation. The module cannot write
to the graph directly — it returns a `ModuleResult` and the daemon handles
persistence.

### ModuleResult

```typescript
export interface ModuleResult {
  annotations?: ModuleAnnotation[]
  derivedNodes?: ModuleDerivedNode[]
  attachments?: ModuleAttachment[]
  logs?: string[]
}

export interface ModuleAnnotation {
  node_id: string
  key: string
  value: unknown
}

export interface ModuleDerivedNode {
  label: string
  type: NodeType
  data: NodeData
  content?: Partial<NodeContent>
  edges: Array<{
    target_node_id: string
    type: EdgeType
  }>
}

export interface ModuleAttachment {
  node_id: string
  filename: string
  mime_type: string
  data: string
}
```

### ModuleTrigger

```typescript
export interface ModuleTrigger {
  type: TriggerType
  filter?: {
    nodeTypes?: NodeType[]
    states?: NodeState[]
    group_id?: string
  }
  debounce_ms?: number
}
```

**G34 resolution:** The `filter.group_id` field is added to the trigger filter.
When set, the module only processes nodes belonging to the specified group.
This enables per-group module activation within a single project. When absent,
the module processes all matching nodes regardless of group.

### ModuleDashboard

```typescript
export interface ModuleDashboard {
  nodeRenderer?: string
  sidebarPanel?: string
  toolbarActions?: ModuleAction[]
  inspectorTabs?: InspectorTab[]
}

export interface ModuleAction {
  id: string
  label: string
  icon?: string
}

export interface InspectorTab {
  id: string
  label: string
  component: string
}
```

Dashboard extensions are component identifiers, not inline code. The dashboard
loads registered components by name. Modules ship their own UI bundles or fall
back to generic renderers.

### ContentStoreReader

```typescript
export interface ContentStoreReader {
  getContent(nodeId: string): Promise<NodeContent | null>
  getAttachment(nodeId: string, attachmentId: string): Promise<Buffer>
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>
  getHistory(nodeId: string): Promise<ContentVersion[]>
}
```

Read-only interface provided to modules via `ModuleContext`. Modules cannot
write content through this interface — they return results and the daemon
handles persistence.

### SearchOptions

```typescript
export interface SearchOptions {
  format?: ContentFormat
  layer?: LayerIndex
  limit?: number
}
```

### SearchResult

```typescript
export interface SearchResult {
  node_id: string
  node_label: string
  layer: LayerIndex
  format: ContentFormat
  snippet: string
  rank: number
}
```

### ContentVersion

```typescript
export interface ContentVersion {
  version: number
  content: NodeContent
  timestamp: string
}
```

### NodeWithContent

```typescript
export interface NodeWithContent extends GraphNode {
  content: NodeContent | null
  moduleAnnotations: Record<string, unknown>
}
```

Extended graph node passed to module `process()`. Includes content and any
existing annotations from prior module runs.

### Module registration in map.yaml

```yaml
graph:
  content:
    inline_threshold_kb: 256
    max_attachment_size_mb: 500
    compression: gzip
    full_text_search: true

  modules:
    benchmark-analyzer:
      enabled: true
      layer: 0
      config:
        baseline_cycles: 3
        alert_threshold_pct: 15
      triggers:
        - type: on_node_created
          filter:
            nodeTypes: [benchmark]
        - type: on_user_action
    code-review:
      enabled: true
      layer: 3
      config:
        max_complexity: 20
      triggers:
        - type: on_content_written
          filter:
            nodeTypes: [code_change]
            contentFormats: [code]
    log-analyzer:
      enabled: false
      layer: 4
```

### Graph types used from SLE-013

These types are defined in SLE-013 and reproduced here for reference. The
authoritative source is the graph dashboard spec.

```typescript
export type LayerIndex = 0 | 1 | 2 | 3 | 4
export type NodeState = 'pending' | 'running' | 'completed' | 'failed' | 'skipped'

export type NodeType =
  | 'spike' | 'finding' | 'benchmark' | 'exploration'
  | 'chat_session' | 'decision' | 'trade_off' | 'discovery_round' | 'synthesis'
  | 'requirements' | 'architecture' | 'test_plan' | 'design_decision'
  | 'code_change' | 'test_script' | 'generated_artifact' | 'changelog'
  | 'validation_llm' | 'validation_exec' | 'gate' | 'version_snapshot' | 'cycle_complete'

export type EdgeType =
  | 'data_flow' | 'dependency' | 'derived_from' | 'informed_by'
  | 'triggers' | 'produces' | 'captures' | 'supersedes'
```

## Behavior

### Content store

#### Content writing

Content is written by four sources:

1. **SLE agents.** The Designer writes requirements and architecture content.
   The Builder writes implementation code content. The Historian writes
   decisions content. Content is written when the DAG runner completes a node
   that owns an artifact with content enabled.
2. **Layer modules.** A benchmark module writes performance data. A code
   review module writes review comments. Content is written as part of
   `ModuleResult.attachments` or `ModuleResult.derivedNodes`.
3. **User.** Through the dashboard inspector or CLI, the user can attach
   content to any node (notes, context, screenshots).
4. **External systems.** CI runners, test frameworks, monitoring can push
   content to nodes via the REST API.

#### Content storage routing

Content is routed to storage based on size:

| Condition | Storage | Mechanism |
|---|---|---|
| Body < `inline_threshold_kb` | SQLite `node_content.body` | Inline text column |
| Body >= `inline_threshold_kb` | Blob store (`{sha256}.gz`) | SQLite `node_content.blob_ref` |
| Attachments (any size) | Blob store (`attachments/{node_id}/`) | `node_attachments.storage_ref` |

The threshold defaults to 256 KB, configurable in `map.yaml → graph.content.inline_threshold_kb`.

#### Checksum verification

Every content write computes a SHA-256 checksum over `body + attachments` (in
order). The checksum is stored in `node_content.checksum` and verified on read.
A mismatch triggers error E133 (content corrupted).

#### Content versioning

The content store maintains a history of content versions per node. On each
write, the previous version is archived. History is accessible via
`ContentStoreReader.getHistory()`. The number of retained versions is bounded
by a configurable limit (default: 10 per node).

### Layer modules

#### Module lifecycle

```
1. Register    — module declares itself to the daemon via map.yaml
2. Resolve     — daemon validates module config, input/output schemas
3. Enable      — project sets `enabled: true` in map.yaml
4. Trigger     — an event matches one of the module's trigger rules
5. Filter      — daemon selects candidate nodes matching inputSchema + trigger filter
6. Process     — module reads nodes + content, produces ModuleResult
7. Validate    — daemon validates outputs against declared output schemas
8. Persist     — annotations, derived nodes, and attachments are written
9. Render      — dashboard renders module's visual extensions
```

#### Trigger evaluation

When an event occurs, the daemon evaluates all enabled modules' triggers:

1. Match trigger type against event type
2. Apply `filter.nodeTypes` — skip nodes with non-matching type
3. Apply `filter.states` — skip nodes with non-matching state
4. Apply `filter.group_id` — skip nodes not in the specified group (G34)
5. Apply `debounce_ms` — if the module ran within the debounce window, skip

Debounce batching: when `debounce_ms > 0`, events are batched until the window
expires, then all accumulated candidate nodes are processed in a single call.

#### Trigger types

| Trigger | When | Use case |
|---|---|---|
| `on_node_created` | New node added to the layer | Auto-analyze new code |
| `on_content_written` | Content written to a node in the layer | Auto-index documents |
| `on_node_state_changed` | Node state transition in the layer | React to failures |
| `on_cycle_complete` | A cycle finishes | Post-cycle analysis |
| `on_user_action` | User clicks a toolbar button | Manual analysis |
| `on_schedule` | Cron-like interval | Periodic health checks |
| `on_demand` | Explicit API call | Programmatic trigger |

#### Module output handling

The daemon processes `ModuleResult` fields in order:

1. **annotations** — Written to the module's annotation store. Annotations are
   keyed by `(module_id, node_id, key)`. Writing the same key overwrites the
   previous value for that node.
2. **derivedNodes** — Created as new nodes in the graph. Each derived node's
   edges are created as specified. Derived nodes are owned by the module and
   tagged with `module_id` in their data. Removing a module cleans up its
   derived nodes.
3. **attachments** — Written to the blob store under the target node's
   attachment directory. Duplicate filenames within a node are versioned, not
   overwritten.
4. **logs** — Appended to the module's log file at
   `.sle/graph/modules/{module_id}/process.log`.

#### Annotation overlay

Annotations are merged with core graph data at read time:

```
core graph nodes → loaded from store.jsonl
module annotations → loaded from modules/{module_id}/outputs/annotations.json
    ↓ merge
NodeWithContent[] → returned to dashboard and API consumers
```

The merge is additive. Annotations never overwrite core node fields. If two
modules produce the same annotation key for the same node, both are stored and
namespaced by `module_id`.

#### Module storage layout

```
.sle/
├── graph/
│   ├── store.jsonl                     node/edge mutations (unchanged)
│   ├── content/
│   │   ├── index.db                    SQLite: content metadata + inline body
│   │   ├── blobs/
│   │   │   ├── {sha256}.gz             compressed blob storage
│   │   │   └── ...
│   │   └── attachments/
│   │       └── {node_id}/
│   │           ├── screenshot.png
│   │           ├── trace.json
│   │           └── ...
│   └── modules/
│       ├── benchmark-analyzer/
│       │   ├── state.json              module state (last run, cache)
│       │   ├── outputs/
│       │   │   ├── annotations.json    annotations written by module
│       │   │   └── derived-nodes.jsonl derived nodes created by module
│       │   ├── cache/                  module-specific cache
│       │   ├── config.json             project-level module config
│       │   └── process.log             module process logs
│       └── ...
```

Module outputs live in their own directory tree. They are never interleaved
with core graph data. Removing a module's directory cleans up all its outputs.

### SQLite content index

```sql
CREATE TABLE node_content (
  node_id       TEXT PRIMARY KEY,
  format        TEXT NOT NULL,
  body          TEXT,
  blob_ref      TEXT,
  size_bytes    INTEGER NOT NULL,
  checksum      TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE node_attachments (
  id            TEXT PRIMARY KEY,
  node_id       TEXT NOT NULL REFERENCES node_content(node_id),
  filename      TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  storage_ref   TEXT NOT NULL
);

CREATE INDEX idx_content_format ON node_content(format);
CREATE INDEX idx_attachments_node ON node_attachments(node_id);
```

When `full_text_search: true` in map.yaml, the daemon creates an additional
FTS5 index:

```sql
CREATE VIRTUAL TABLE node_content_fts USING fts5(
  node_id,
  body,
  content='node_content',
  content_rowid='rowid'
);
```

### Content streaming

For content exceeding 10 MB, the API supports chunked transfer encoding:

`GET /api/v2/graph/node/{id}/content/stream`

Response headers include `X-Content-Size` (total bytes for progress bar) and
`X-Content-Checksum` (SHA-256 for verification). The dashboard uses streaming
for log viewers with virtual scrolling, large JSON viewers with lazy parsing,
and code viewers with syntax highlighting.

### Graph rendering with modules

#### Annotation badges

Annotations are rendered as badges beneath the node label. Badge color reflects
the annotation value — green for positive, red for regression, gray for neutral.
Multiple module annotations stack vertically.

```
┌─────────────────────────┐
│  [benchmark] p95: 142ms │  ← core node label
│  ▲ improving (-12.5%)   │  ← module annotation overlay
│  ● quality: 87          │  ← another module annotation
└─────────────────────────┘
```

#### Custom node renderers

Modules can register custom WebGL renderers with the Sigma.js graph renderer.
Custom renderers receive the node's annotations as input and replace the
default circle shape. Examples: bar chart shapes for benchmarks, circular
progress for code quality, sparklines for log analysis.

#### Inspector tabs

When a selected node has module annotations, the inspector shows additional
tabs alongside the core tab:

```
[ Core ] [ Benchmark ] [ Code Review ] [ Logs ]
```

Each tab renders the module's data for that node. The Core tab is always
present.

### DDR-013 integration

The content store operates on nodes only, respecting the DDR-013 document/node
split:

| Entity | Scope | Content store | Storage |
|---|---|---|---|
| Node | Group (`.sle/project-graph/layers/`) | Yes | Content index + blob store |
| Document | Project (`.sle/project-docs/`) | No | Filesystem |
| Source file | Filesystem | No | Filesystem (linked, not embedded) |

Modules can reference documents and source files via `[[wikilink]]` syntax but
cannot write content to them through the content store. Document modification
requires the user approval pathway defined in the core cycle spec.

The `group_id` filter (G34) in `ModuleTrigger` aligns with node group scope. A
module with `filter.group_id: "auth-module"` only processes nodes in the
`auth-module` group. When `group_id` is absent, the module processes nodes
across all groups in its layer.

## API contract

daemon-api.md is the single source of truth for all REST endpoints. The
endpoints below are defined there. This table provides cross-references.

### Content store endpoints

| Endpoint | Method | daemon-api.md reference | Purpose |
|---|---|---|---|
| `/api/v2/graph/node/{id}/content` | GET | Content section | Return node's full content |
| `/api/v2/graph/node/{id}/content` | PUT | Content section | Write content to a node |
| `/api/v2/graph/node/{id}/content/stream` | GET | Content section | Stream large content |
| `/api/v2/graph/node/{id}/content/attachments/{attachment_id}` | GET | Content section | Download attachment |
| `/api/v2/graph/node/{id}/content/attachments` | POST | Content section | Add attachment |
| `/api/v2/graph/content/search` | GET | Content section | Full-text search across nodes |

### Module endpoints

| Endpoint | Method | daemon-api.md reference | Purpose |
|---|---|---|---|
| `/api/v2/graph/modules` | GET | Modules section | List registered modules and status |
| `/api/v2/graph/modules/{id}/trigger` | POST | Modules section | Manually trigger a module run |
| `/api/v2/graph/modules/{id}/annotations/{node_id}` | GET | Modules section | Get annotations for a node |
| `/api/v2/graph/modules/{id}/outputs` | GET | Modules section | Get all derived nodes and outputs |
| `/api/v2/graph/modules/{id}/config` | PUT | Modules section | Update module configuration |

### WebSocket events

| Event | Payload | When |
|---|---|---|
| `content.written` | `{ node_id, format, size_bytes, checksum }` | Content written to any node |
| `content.deleted` | `{ node_id }` | Content removed from a node |
| `module.triggered` | `{ module_id, trigger_type, node_count }` | Module run begins |
| `module.completed` | `{ module_id, annotations, derived_nodes, duration_ms }` | Module run finishes |
| `module.failed` | `{ module_id, error_code, message }` | Module run fails |
| `module.registered` | `{ module_id, layer, enabled }` | New module registered |

## Error cases

### Content errors

| Code | Condition | Response |
|---|---|---|
| E130 | Content not found for node | Return null. Content may not have been written yet. Not an error condition for nodes without content |
| E131 | Content exceeds inline threshold | Not an error. Automatically routes to blob store. Transparent to caller |
| E132 | Blob store unavailable | Check MinIO/disk connectivity. Retry with exponential backoff (3 attempts, 1s/2s/4s) |
| E133 | Checksum mismatch on read | Content corrupted. Log error. Re-generate if possible (agent re-run), otherwise mark node as `corrupted` state |
| E134 | Attachment not found | Attachment may have been removed during cleanup. Return 404 |
| E135 | Content version not found | Requested version number exceeds history depth. Return latest version with warning header |

### Module errors

| Code | Condition | Response |
|---|---|---|
| E136 | Module not registered in map.yaml | Return 404. Module must be declared before use |
| E137 | Module process crashed (unhandled exception) | Log stack trace. Mark module as `errored` in state.json. Do not retry automatically. Emit `module.failed` WebSocket event |
| E138 | Module input validation failed | Node missing required content format or data fields. Skip node, process remaining. Log warning |
| E139 | Module output validation failed | Annotation schema mismatch. Reject the specific annotation. Accept valid outputs. Log rejection details |
| E140 | Module storage quota exceeded | Module cache/outputs exceed configured limit. Emit warning. Reject new writes until cache is cleaned |
| E141 | Module processing timeout | Module exceeded configurable time limit (default: 60s). Kill process. Mark as `timed_out`. Emit `module.failed` |
| E142 | Module trigger debounce collision | Module already processing. Queue trigger. Process after current run completes |

### SQLite errors

| Code | Condition | Response |
|---|---|---|
| E143 | Content index locked | Another write in progress. Retry after short delay |
| E144 | FTS index corruption | Rebuild FTS index from content table. Log warning. Search returns degraded results during rebuild |
| E145 | Disk full in content store | Reject new writes. Emit critical event. Existing reads continue |

## Constraints

1. **Content is node-scoped.** The content store operates on graph nodes only,
   consistent with DDR-013. Documents and source files are not content store
   entities. Modules that need document content read it from the filesystem,
   not from the content index.

2. **Modules never modify the core graph.** Modules produce annotations,
   derived nodes, and attachments through the `ModuleResult` interface. The
   daemon handles persistence. Direct graph mutation by modules is prohibited.

3. **One layer per module.** A module attaches to exactly one `LayerIndex`. It
   can only read nodes in that layer. Cross-layer analysis requires separate
   modules for each layer that communicate via annotations.

4. **Annotations are additive.** Multiple modules can annotate the same node.
   Annotations are namespaced by `module_id`. Overwrites occur only within a
   module's own annotations for the same key.

5. **Derived nodes are module-owned.** Derived nodes created by a module are
   tagged with the module's ID. Disabling or removing a module cleans up its
   derived nodes and annotations.

6. **Content writes are append-mostly.** Writing content to a node replaces the
   current content but archives the previous version. History depth is
   configurable (default: 10 versions per node). Attachments are versioned by
   filename, not overwritten.

7. **Blob size limits.** The maximum attachment size is configurable via
   `map.yaml → graph.content.max_attachment_size_mb` (default: 500 MB).
   Writes exceeding this limit are rejected with error E140.

8. **Module processing is synchronous per trigger.** When a trigger fires, the
   daemon calls `process()` once with all candidate nodes. The module does not
   receive incremental events within a single run. Debounce batching collects
   nodes across the debounce window.

9. **Content checksums are mandatory.** Every content write must include a
   checksum. Every content read must verify the checksum. A mismatch indicates
   corruption and triggers error E133.

10. **FTS is opt-in.** Full-text search requires `full_text_search: true` in
    map.yaml. When disabled, the FTS index is not created and the search
    endpoint returns 501 (not implemented).

11. **Group scoping via triggers (G34).** Modules can filter by `group_id` in
    their trigger configuration. This filter is applied at trigger evaluation
    time, not at the module level. A module cannot read nodes outside its
    trigger filter even if they match `inputSchema`.

12. **Module registration is declarative.** Modules are declared in
    `map.yaml → graph.modules`. The daemon reads this at startup. Adding a new
    module at runtime requires a map.yaml write followed by a daemon config
    reload event.

13. **Module outputs are isolated.** Module outputs are stored in
    `.sle/graph/modules/{module_id}/`. They are never interleaved with core
    graph data in `store.jsonl`. This enables clean module removal without
    graph corruption.

14. **Streaming is size-gated.** The streaming endpoint is only available for
    content exceeding 10 MB. Content below this threshold uses the standard
    GET endpoint. Clients can check `size_bytes` from the node content metadata
    to decide whether to use streaming.

15. **Post-MVP status.** This spec is not required for the core cycle loop.
    The daemon must function identically whether the content store and modules
    are enabled or not. When no modules are registered, the graph module
    system is a no-op.

## Open questions

| ID | Question | Impact | Status |
|---|---|---|---|
| MOD-001 | Should modules support cross-layer reads (read-only) while writing to a single layer? | Module capability, graph traversal | Open |
| MOD-002 | What is the maximum number of concurrent module process runs before queuing? | Resource bounding, latency | Open |
| MOD-003 | Should the content store support content-level permissions (e.g., module A cannot read module B's annotations)? | Security, multi-tenant scenarios | Open |
| MOD-004 | Should derived nodes support recursive module processing (module B processes derived nodes from module A)? | Complexity, ordering, potential loops | Open |
| MOD-005 | What is the maximum retention period for content versions before automatic pruning? | Storage growth, historical analysis | Open |
| MOD-006 | Should the FTS index support custom tokenizers per `ContentFormat` (e.g., code-aware tokenization for `code` format)? | Search quality, format-specific matching | Open |
| MOD-007 | Should modules be distributable as npm packages with a standard loader interface? | Module ecosystem, third-party modules | Open |
| MOD-008 | Should the daemon support hot-reloading module code without restart? | Development velocity, production updates | Open |
| MOD-009 | Should module triggers support compound conditions (e.g., `on_node_created AND layer == 3`)? | Trigger expressiveness, filtering | Open |
| MOD-010 | What happens to module outputs when the module is disabled mid-project? Should derived nodes be orphaned or cleaned up? | Data integrity, user experience | Open |
