# Project Overview & Graph View

| Type | Status | Updated |
|------|--------|---------|
| Spec | Draft | 2026-05-01 |

**Depends on:** ui-shell.md, document-linking.md, daemon-api-endpoints.md, dag-execution.md
**Source material:** vision/SLE-016-project-overview.md
**Resolves:** —

> This spec defines the data model, interactions, and behavior of the Graph page.
> The page chrome (navigation, overlays, status indicator) is defined in ui-shell.md.

## Overview

The project overview is the central hub for understanding the system being built.
It provides four compositional areas that share a single data model but serve
different interaction modes:

1. **Document overview** — all project documents organized by group and layer,
   presented as a filterable, sortable list.
2. **Statistics** — health, coverage, and progress metrics tailored to the
   project type (API, library, UI, research, custom).
3. **Layered graph view** — an Obsidian-style interactive graph where nodes are
   project artifacts grouped by feature/concern, stacked vertically across
   lifecycle layers.
4. **Running/hosting view** — an interactive deployment planner with autonomous
   operation indicators, driven by a conversational AI flow through the daemon.

The graph is the primary visual surface. It renders groups as stacked-card
components where each stack row corresponds to a layer. Edges connect nodes
across groups, encoding dependency, influence, code-sharing, blocking, and
general relatedness. The graph reads from the file-based project graph store
(`.sle/project-graph/`) and the existing link index (document-linking.md).

Groups are the primary organizational unit. Every artifact, node, and edge
belongs to exactly one group. Groups follow a status lifecycle from creation
through archival, carry health metadata, and can be pinned to prevent
AI/system modifications. The system supports 8 baseline layers plus
user-approved custom layers.

The graph renders committed state only — in-progress cycle work is invisible
until the cycle completes and artifacts are committed. This ensures the graph
always reflects a consistent, reviewable snapshot.

## Data model

### Core types

```typescript
type ProjectType = 'api' | 'ui' | 'library' | 'research' | 'custom'

type LayerName =
  | 'research' | 'spikes' | 'design' | 'plans'
  | 'implementation' | 'code' | 'notes' | 'hosting'
  | string

type LayerState = 'filled' | 'partial' | 'empty' | 'not_applicable'

type NodeType =
  | 'spike' | 'finding' | 'trade_off' | 'exploration' | 'poc' | 'benchmark'
  | 'requirement' | 'architecture' | 'design_decision' | 'constraint'
  | 'plan' | 'task' | 'step'
  | 'module' | 'component' | 'service' | 'dependency'
  | 'source_file' | 'test_file' | 'config_file'
  | 'note' | 'todo' | 'observation' | 'experiment'
  | 'docker_config' | 'env_config' | 'health_check' | 'deployment'

type EdgeType = 'depends_on' | 'informed_by' | 'shares_code' | 'blocks' | 'related'
```

### ProjectGroup

```typescript
interface ProjectGroup {
  id: string
  label: string
  source: 'user' | 'ai_suggested' | 'auto_derived'
  status: 'created' | 'populated' | 'active' | 'frozen' | 'archived'
  created_by: 'user' | 'ai' | 'system'
  pinned: boolean
  health: GroupHealth
  layers: Map<LayerName, LayerNode[]>
  tags: NodeTag[]
  created_at: string
  last_modified: string
}
```

| Field | Description |
|-------|-------------|
| `id` | Stable identifier (slug-form, e.g. `rate-limiting`). Never reassigned. |
| `label` | Human-readable name (e.g. "Rate Limiting"). Mutable. |
| `source` | Origin of the group definition. `auto_derived` groups are candidates for user review. |
| `status` | Current lifecycle stage. See §Group status lifecycle. |
| `created_by` | Which actor created the group. System-created groups appear in hosting/autonomous contexts. |
| `pinned` | When `true`, AI and system actors cannot modify the group or its nodes. User retains full control. |
| `health` | Aggregated health metadata for the group. Computed on every graph refresh. |
| `layers` | Map of layer name to node list. Empty layers are stored as `[]`, absent layers are `not_applicable`. |
| `created_at` | ISO 8601 timestamp. Set once at creation. |
| `last_modified` | ISO 8601 timestamp. Updated on any mutation to the group or its nodes. |

### GroupHealth

```typescript
interface GroupHealth {
  layer_completion: number
  test_coverage?: number
  last_cycle_outcome?: 'pass' | 'fail' | 'halted'
  open_issues: number
}
```

| Field | Range | Description |
|-------|-------|-------------|
| `layer_completion` | 0–100 | Percentage of applicable layers that are `filled`. Partial layers count proportionally. |
| `test_coverage` | 0–100 | Optional. Only populated when the group has Code layer nodes with test associations. |
| `last_cycle_outcome` | enum | Result of the most recent cycle that touched this group. Absent if no cycle has run. |
| `open_issues` | ≥ 0 | Count of unresolved issues tagged against this group. |

### LayerNode

```typescript
interface LayerNode {
  id: string
  type: NodeType
  label: string
  artifact_path?: string
  source: 'planner' | 'tester' | 'builder' | 'historian' | 'user' | 'system'
  tags: NodeTag[]
  created_at: string
  modified_at: string
}
```

| Field | Description |
|-------|-------------|
| `id` | Unique within the group. Format: `{type}:{slug}`. |
| `type` | Discriminated node type from `NodeType` union. Determines rendering icon and interaction. |
| `label` | Short human-readable title. |
| `artifact_path` | Optional path to the backing artifact file (e.g. `rate-limiting/architecture.md`). Absent for ephemeral nodes. |
| `source` | Which actor produced this node. `system` for auto-derived entries, `user` for manual entries. |
| `created_at` | ISO 8601. Set once. |
| `modified_at` | ISO 8601. Updated on mutation. |

### ProjectEdge

```typescript
interface ProjectEdge {
  id: string
  source: string
  target: string
  type: EdgeType
}
```

`source` and `target` reference `LayerNode.id` values, which are unique within a
group. For cross-group edges, the full reference is `{group_id}:{node_id}`. The
edge store resolves ambiguity by always using fully-qualified node references
internally.

### Baseline layers

The system defines 8 baseline layers. Each has a fixed color for visual
consistency across sessions and a default position in the vertical stack.

| Layer | Color | Content | Default position |
|-------|-------|---------|-----------------|
| Research/Discussion | Purple | Spikes, trade-offs, exploration, chat decisions | 0 |
| Spikes | Violet | Technical POCs, benchmarks, experiments | 1 |
| Design documents | Amber | Requirements, architecture, design decisions | 2 |
| Plans | Yellow | Implementation plans, task breakdowns | 3 |
| Implementation | Green | Module map, file structure, dependency graph | 4 |
| Code | Teal | Source files, test files, configs | 5 |
| Notes | Gray | Ad-hoc observations, TODOs, manual annotations | 6 |
| Running/Hosting | Blue | Deployment config, Docker, CI/CD, autonomous operation | 7 |

Layer states indicate content presence:

| State | Indicator | Condition |
|-------|-----------|-----------|
| `filled` | Green dot | All expected nodes present, content committed |
| `partial` | Yellow dot | Some nodes present, others missing |
| `empty` | Hollow dot | No nodes for this layer |
| `not_applicable` | Gray dash | Layer does not apply to this group (explicitly opted out) |

### Custom layers

Beyond the 8 baseline layers, projects may define custom layers. Custom layers
require explicit user approval at the project level and are stored in the graph
configuration.

```typescript
interface CustomLayer {
  name: string
  color: string
  description: string
  position: number
  approved_by: 'user'
  approved_at: string
}
```

Custom layers appear in `ProjectGroup.layers` using their `name` as the key. The
`position` field determines vertical ordering relative to baseline layers.

### ProjectStatistics

```typescript
interface ProjectStatistics {
  project_type: ProjectType
  groups: number
  layers_filled_ratio: number
  cycles_completed: number
  api_stats?: ApiStatistics
  library_stats?: LibraryStatistics
  common_stats: CommonStatistics
}

interface ApiStatistics {
  endpoints: number
  test_coverage_pct: number
  p95_latency_ms?: number
  dependencies: number
  docker_images: number
  uptime_pct?: number
}

interface LibraryStatistics {
  exports: number
  bundle_size_kb?: number
  test_coverage_pct: number
  dependencies: number
  compatibility_targets: string[]
  published_versions: number
}

interface CommonStatistics {
  groups_count: number
  layers_filled_ratio: number
  cycles_completed: number
  code_lines: number
  failing_tests: number
  uncovered_requirements: number
}
```

Statistics are adaptive by project type. `ApiStatistics` are populated when
`project_type` is `'api'`. `LibraryStatistics` are populated when `project_type`
is `'library'`. `CommonStatistics` are always populated.

### GraphLayout

```typescript
interface GraphLayout {
  mode: 'group-centric' | 'layer-centric' | 'radial'
  group_positions: Map<string, { x: number; y: number }>
  viewport: { x: number; y: number; zoom: number }
  last_modified: string
}
```

Persisted per-session layout state. Group positions are saved on every drag
completion. The viewport captures pan and zoom for session restoration.

### File-based storage

```
.sle/project-graph/
  groups.json
  groups/{group_id}/
    research.json
    spikes.json
    design.json
    plans.json
    implementation.json
    code.json
    notes.json
    hosting.json
  edges.json
  layout.json
  statistics.json
```

| File | Content |
|------|---------|
| `groups.json` | Array of `ProjectGroup` summaries (id, label, status, health, timestamps). Full layer data lives in per-group files. |
| `groups/{group_id}/{layer}.json` | Array of `LayerNode` for that group/layer combination. Absent file = `not_applicable`. Empty array = `empty`. |
| `edges.json` | Array of `ProjectEdge`. All cross-group and intra-group edges. |
| `layout.json` | `GraphLayout` — persisted positions and viewport. |
| `statistics.json` | `ProjectStatistics` — recomputed on graph refresh. |

## Behavior

### Group status lifecycle

Groups follow a five-stage lifecycle:

```
created → populated → active → frozen → archived
```

| Transition | Trigger | Effect |
|------------|---------|--------|
| `→ created` | User creates a group, AI suggests one (accepted), or system auto-derives one | Empty group with no layers. Appears in graph as a single hollow node. |
| `created → populated` | First `LayerNode` is added to any layer | Group becomes visible in the document overview. Health computation begins. |
| `populated → active` | Group has nodes in ≥2 layers OR a cycle targets this group | Group is considered active for statistics and edge inference. |
| `active → frozen` | User explicitly freezes the group (or AI suggests freeze, accepted) | No new nodes can be added. Existing nodes are read-only. Health snapshot is preserved. |
| `frozen → archived` | User archives the group | Group is hidden from default graph view. Available via filter. Edges are preserved but grayed out. |

`pinned` groups skip AI-initiated transitions entirely. Only the user can move a
pinned group through lifecycle stages.

### Graph rendering modes

Three layout modes control how the graph presents groups and their layers:

**Group-centric (default):**

Groups are positioned as stacked-card components in a force-directed layout.
Each group renders as a vertical stack of layer rows. Edges connect nodes
between groups. This is the primary working view.

**Layer-centric:**

Groups are reorganized so that nodes sharing the same layer are horizontally
aligned. This highlights coverage gaps — an empty layer row across all groups
is immediately visible as a horizontal gap.

**Radial:**

Groups are arranged in a circle with the most-connected group at the center.
Edges render as curved arcs. Useful for understanding dependency topology and
identifying hub groups.

Layout mode is a user preference persisted in `GraphLayout.mode`.

**Tag visual indicators:**

Tagged nodes display colored badges or borders:

| Tag | Visual |
|-----|--------|
| `#next-cycle` | Highlighted border (orange) |
| `#scope:{id}` | Subtle badge linking to scope draft |
| `#area:{name}` | Categorical badge |

### Graph interactions

The graph responds to standard input patterns:

| Input | Target | Behavior |
|-------|--------|----------|
| Click | Group stack | Expand group: reveal layer details, node counts, health indicators |
| Double-click | Group stack | Focus: zoom to group, dim all other groups, highlight connected edges |
| Click | Layer node | Open node detail panel: label, artifact content, backlinks, metadata |
| Drag | Group stack | Reposition. Position persisted to `layout.json` on drag end. |
| Right-click | Any | Context menu with actions: add note, create spike, start cycle, pin/unpin, **"Tag for next cycle"** (adds `#next-cycle`), **"Tag for scope..."** (opens scope draft selector → adds `#scope:{draft-id}`), **"Remove tag..."** (shows current tags, allows removal) |
| Hover | Edge | Show tooltip with edge type and dependency description |
| Scroll | Canvas | Zoom in/out. Zoom level persisted in `GraphLayout.viewport`. |
| Pan | Canvas background | Move viewport. Position persisted in `GraphLayout.viewport`. |

### Edge types and rendering

Five edge types encode different relationships:

| Edge type | Render style | Direction | Semantics |
|-----------|-------------|-----------|-----------|
| `depends_on` | Solid line | Directed | Target must exist/be-complete before source can function |
| `informed_by` | Dashed line | Directed | Source was influenced by target's content or decisions |
| `shares_code` | Dotted line | Undirected | Both nodes reference the same source file or module |
| `blocks` | Red line | Directed | Source cannot proceed while target is unresolved |
| `related` | Thin gray line | Undirected | General association without strong dependency |

Edges are derived from two sources:
1. The existing link index (document-linking.md) — structural and contextual
   links are projected onto the graph using the group/layer mapping.
2. Explicit `ProjectEdge` entries in `edges.json` — user-created or
   auto-derived edges not present in the link index.

### Cycle → artifact auto-mapping priority

When a cycle produces artifacts, the system maps them to groups using a 5-level
priority chain. The first matching level wins:

| Priority | Level | Match method | Example |
|----------|-------|-------------|---------|
| 1 | Explicit assignment | `--group` flag on cycle command | `sle cycle --group rate-limiting` |
| 2 | Planner mapping | Plan references a group by name | Plan section titled "Rate Limiting" maps to `rate-limiting` group |
| 3 | File path matching | Output directory belongs to an existing group | `src/rate-limiting/middleware.ts` → `rate-limiting` group |
| 4 | Requirement matching | Requirement section matches a group's Design layer | Requirement "Rate limiting on API endpoints" matches `rate-limiting` design docs |
| 5 | Unmatched | Auto-derived group with user review prompt | New group `rate-limiter` created, flagged `auto_derived`, user prompted to confirm or merge |

**Tag-aware context loading:** Nodes tagged `#next-cycle` are included in the
mapping priority chain. Tagged nodes are loaded first into the Planner's context,
ensuring the cycle targets the user's indicated priorities.

Auto-derived groups (priority 5) appear in the graph with a dashed border and a
review badge. They transition to `populated` only after user acceptance. If the
user rejects the auto-derived group, its nodes are offered for merge into an
existing group or deletion.

### Statistics computation

Statistics are recomputed on:
- Graph open (full computation)
- Cycle completion (incremental: affected groups only)
- Manual refresh via `POST /api/v2/graph/statistics/refresh`

The computation reads from the file-based store and the link index. It does not
invoke the knowledge engine.

**Common statistics algorithm:**

```
1. groups_count = count(groups where status in ['populated', 'active', 'frozen'])
2. layers_filled_ratio = sum(layer_completion) / count(applicable groups)
3. cycles_completed = max(group.health.last_cycle_count) across all groups
4. code_lines = sum(line_count for Code layer nodes with artifact_path)
5. failing_tests = count(test_file nodes where last_run_outcome == 'fail')
6. uncovered_requirements = count(requirement nodes with no test backlink)
```

**Type-specific overlays:**

For `project_type: 'api'`, `ApiStatistics` are appended using test runner output
and Docker Compose introspection. For `project_type: 'library'`,
`LibraryStatistics` are appended using package manifest parsing.

### Hosting planner UI

The hosting view is not a form — it is a **conversational AI flow** routed
through the daemon. The user describes deployment requirements in natural
language, and the daemon generates deployment configurations iteratively.

Interaction model:

1. User opens hosting planner for a group
2. Conversational panel appears alongside the group's Hosting layer
3. Each message is sent to the daemon, which responds with deployment
   suggestions, config diffs, or clarifying questions
4. User has three controls per suggestion: **Approve** (accept config),
   **Modify** (edit and accept), **Reject** (discard)
5. A **Manual override** button lets the user bypass the conversation and edit
   deployment files directly
6. Approved configs are committed to the group's Hosting layer as `LayerNode`
   entries with `source: 'user'` or `source: 'system'`

The conversation state is ephemeral — it exists only while the planner panel is
open. Closing the panel discards unapproved suggestions.

### Document overview panel

The document overview is a tabular view of all project artifacts, filterable by
group, layer, source, and status. It reads from the same `ProjectGroup` data
model as the graph but presents it as a flat list.

| Column | Source |
|--------|--------|
| Artifact name | `LayerNode.label` |
| Group | `ProjectGroup.label` |
| Layer | Layer name from `layers` map key |
| Type | `LayerNode.type` |
| Source | `LayerNode.source` |
| Modified | `LayerNode.modified_at` |
| Status | Derived: `filled` if `artifact_path` exists, `partial` if in-progress, `empty` if no path |

Sorting is by modified date (default), group name, or layer position. Clicking
a row opens the artifact in the document viewer.

### Graph refresh

The graph is refreshed from the file-based store at these points:

1. **On open** — full read of `groups.json`, per-group layer files, `edges.json`,
   and `layout.json`
2. **On cycle completion** — incremental: read only groups whose `last_modified`
   is newer than the cached timestamp
3. **On manual refresh** — `POST /api/v2/graph/refresh` forces full re-read
4. **On file watcher event** — if a change occurs in `.sle/project-graph/`,
   schedule a debounced refresh (500ms)

The graph never polls. All updates are event-driven via file watcher or
WebSocket events from the daemon.

## API contract

daemon-api-endpoints.md is the single source of truth for all REST endpoint definitions. The
endpoints below are specified here and will be added to daemon-api-endpoints.md.

### Cross-reference table

| Endpoint | Method | Purpose | daemon-api-endpoints.md section |
|----------|--------|---------|----------------------|
| `/api/v2/graph/groups` | GET | List all groups with health summaries | Project graph |
| `/api/v2/graph/groups/{id}` | GET | Single group with full layer data | Project graph |
| `/api/v2/graph/groups` | POST | Create a new group | Project graph |
| `/api/v2/graph/groups/{id}` | PATCH | Update group metadata (label, status, pinned) | Project graph |
| `/api/v2/graph/groups/{id}` | DELETE | Archive a group (sets status to `archived`) | Project graph |
| `/api/v2/graph/groups/{id}/nodes` | POST | Add a node to a group layer | Project graph |
| `/api/v2/graph/groups/{id}/nodes/{node_id}` | PATCH | Update a node | Project graph |
| `/api/v2/graph/groups/{id}/nodes/{node_id}` | DELETE | Remove a node from a group layer | Project graph |
| `/api/v2/graph/edges` | GET | List all edges (with optional filters) | Project graph |
| `/api/v2/graph/edges` | POST | Create an edge | Project graph |
| `/api/v2/graph/edges/{id}` | DELETE | Remove an edge | Project graph |
| `/api/v2/graph/layout` | GET | Current layout state | Project graph |
| `/api/v2/graph/layout` | PUT | Persist layout positions | Project graph |
| `/api/v2/graph/statistics` | GET | Current project statistics | Project graph |
| `/api/v2/graph/statistics/refresh` | POST | Force statistics recomputation | Project graph |
| `/api/v2/graph/refresh` | POST | Force full graph re-read from store | Project graph |
| `/api/v2/graph/hosting/{group_id}/plan` | POST | Send a message to the hosting planner conversation | Project graph |
| `/api/v2/cycles/{cycle_id}/lock-snapshot` | POST | Lock cycle snapshot (gate pass) — triggers graph refresh on completion | Cycles (user-flow.md) |
| `/api/v2/cycles/{cycle_id}/run-tests-locally` | POST | Run tests locally (gate pass) — cycle completion triggers graph update | Cycles (user-flow.md) |
| `/api/v2/tags?type={TagPrefix}&scope={group_id}` | GET | List tags, optionally filtered by type and scope | Tags (DDR-028) |
| `/api/v2/tags` | POST | Add tag to a node (`node_id` + `tag` in body) | Tags (DDR-028) |
| `/api/v2/tags/{node_id}/{tag_prefix}/{value?}` | DELETE | Remove tag from a node | Tags (DDR-028) |
| `/api/v2/tags/next-cycle` | GET | List all nodes tagged #next-cycle | Tags (DDR-028) |

### List groups

```
GET /api/v2/graph/groups?status={string}&source={string}&pinned={boolean}

Query params (all optional):
  status:  Filter by group status
  source:  Filter by group source
  pinned:  Filter pinned status

Response 200:
{
  "ok": true,
  "data": {
    "groups": ProjectGroup[],
    "total": number
  }
}
```

### Get single group

```
GET /api/v2/graph/groups/{id}

Response 200:
{
  "ok": true,
  "data": ProjectGroup
}

Response 404: group_not_found
```

### Create group

```
POST /api/v2/graph/groups

Request:
{
  "label": string,
  "source": "user" | "ai_suggested" | "auto_derived",
  "pinned": boolean
}

Response 201:
{
  "ok": true,
  "data": {
    "id": string,
    "label": string,
    "status": "created",
    "created_at": string
  }
}

Response 409: group_label_exists
```

### Update group

```
PATCH /api/v2/graph/groups/{id}

Request:
{
  "label"?: string,
  "status"?: GroupStatus,
  "pinned"?: boolean
}

Response 200:
{
  "ok": true,
  "data": {
    "id": string,
    "updated_fields": string[]
  }
}

Response 404: group_not_found
Response 403: group_is_pinned (when AI/system tries to modify pinned group)
Response 400: invalid_status_transition
```

### Add node to group

```
POST /api/v2/graph/groups/{id}/nodes

Request:
{
  "layer": LayerName,
  "type": NodeType,
  "label": string,
  "artifact_path"?: string,
  "source": LayerNodeSource
}

Response 201:
{
  "ok": true,
  "data": {
    "node_id": string,
    "layer": string,
    "created_at": string
  }
}

Response 404: group_not_found
Response 400: invalid_layer_name
Response 403: group_is_pinned
```

### List edges

```
GET /api/v2/graph/edges?type={EdgeType}&source_group={string}&target_group={string}&limit={number}

Query params (all optional):
  type:          Filter by edge type
  source_group:  Filter by source group ID
  target_group:  Filter by target group ID
  limit:         Max results (default 100, max 500)

Response 200:
{
  "ok": true,
  "data": {
    "edges": ProjectEdge[],
    "total": number
  }
}
```

### Create edge

```
POST /api/v2/graph/edges

Request:
{
  "source": string,
  "target": string,
  "type": EdgeType
}

Response 201:
{
  "ok": true,
  "data": {
    "edge_id": string,
    "source": string,
    "target": string,
    "type": string
  }
}

Response 409: edge_already_exists
Response 400: source_node_not_found
Response 400: target_node_not_found
Response 400: self_edge_not_allowed
```

### Persist layout

```
PUT /api/v2/graph/layout

Request:
{
  "mode": GraphLayoutMode,
  "group_positions": Map<string, { x: number; y: number }>,
  "viewport": { x: number; y: number; zoom: number }
}

Response 200:
{
  "ok": true,
  "data": {
    "saved_at": string
  }
}
```

### Hosting planner message

```
POST /api/v2/graph/hosting/{group_id}/plan

Request:
{
  "message": string,
  "action": "send" | "approve" | "modify" | "reject" | "manual_override",
  "modified_config"?: string
}

Response 200:
{
  "ok": true,
  "data": {
    "response": string,
    "suggested_config"?: string,
    "applied": boolean
  }
}

Response 404: group_not_found
Response 400: hosting_layer_not_available
```

### WebSocket events

```
event: graph.group_created
{
  "group_id": string,
  "label": string,
  "source": string,
  "timestamp": string
}

event: graph.group_updated
{
  "group_id": string,
  "updated_fields": string[],
  "timestamp": string
}

event: graph.node_added
{
  "group_id": string,
  "node_id": string,
  "layer": string,
  "timestamp": string
}

event: graph.node_removed
{
  "group_id": string,
  "node_id": string,
  "layer": string,
  "timestamp": string
}

event: graph.edge_created
{
  "edge_id": string,
  "source": string,
  "target": string,
  "type": string,
  "timestamp": string
}

event: graph.edge_removed
{
  "edge_id": string,
  "timestamp": string
}

event: graph.statistics_updated
{
  "statistics": ProjectStatistics,
  "duration_ms": number,
  "timestamp": string
}

event: graph.refreshed
{
  "groups_count": number,
  "edges_count": number,
  "duration_ms": number,
  "timestamp": string
}

event: graph.node_tagged
{
  "node_id": string,
  "tag": NodeTag,
  "timestamp": string
}

event: graph.node_untagged
{
  "node_id": string,
  "tag_id": string,
  "timestamp": string
}
```

### Gate pass endpoints (from user-flow.md)

Cycle completion triggers graph updates (incremental refresh of affected
groups). The Graph page listens for these gate pass endpoints defined in
user-flow.md:

```
POST /api/v2/cycles/{cycle_id}/lock-snapshot

Response 200:
{
  "ok": true,
  "data": {
    "snapshot_id": string,
    "locked_at": string
  }
}
```

```
POST /api/v2/cycles/{cycle_id}/run-tests-locally

Response 200:
{
  "ok": true,
  "data": {
    "test_run_id": string,
    "status": "running",
    "started_at": string
  }
}
```

On cycle completion, the daemon emits a `graph.refreshed` WebSocket event
and the Graph page performs an incremental refresh of affected groups.

## Error cases

| Error code | Condition | Response | Recovery |
|---|---|---|---|
| `group_not_found` | Group ID does not exist in `groups.json` | 404 with requested ID | Client refreshes group list |
| `group_label_exists` | Create group with label that already exists | 409 with existing group ID | Client uses existing group or chooses new label |
| `group_is_pinned` | Mutation attempted on a pinned group by non-user actor | 403 with group ID and actor | Only user can unpin first, then retry |
| `invalid_status_transition` | Group status change is not in the allowed transition set | 400 with current and requested status | Client shows valid transitions |
| `invalid_layer_name` | Layer name is not a baseline layer or an approved custom layer | 400 with layer name | Client presents layer options |
| `custom_layer_not_approved` | Custom layer referenced without prior user approval | 400 with layer name | User must approve custom layer first |
| `source_node_not_found` | Edge source node does not exist | 400 with node reference | Client refreshes node list |
| `target_node_not_found` | Edge target node does not exist | 400 with node reference | Client refreshes node list |
| `edge_already_exists` | Duplicate edge (same source + target + type) | 409 with existing edge ID | Client uses existing edge |
| `self_edge_not_allowed` | Edge source and target are the same node | 400 | Client corrects target selection |
| `node_not_found` | Node ID does not exist in the specified group | 404 with node ID | Client refreshes group data |
| `hosting_layer_not_available` | Hosting planner invoked for a group with no Hosting layer | 400 with group ID | Add Hosting layer nodes first |
| `graph_store_corrupt` | `groups.json` or layer file fails to parse on startup | Logged as error, graph shows empty state with warning | Manual reindex or `POST /graph/refresh` |
| `layout_persistence_failed` | `layout.json` write fails (disk full, permissions) | 200 with `saved: false`, logged as warning | Layout reverts to default on next load |
| `auto_mapping_ambiguous` | Cycle artifact matches multiple groups at the same priority level | Artifact placed in first match, warning logged | User reassigns via group node API |
| `statistics_computation_timeout` | Statistics recomputation exceeds 5 seconds | Partial statistics returned, warning logged | Retry with `POST /graph/statistics/refresh` |

## Constraints

1. **Committed state only.** The graph renders artifacts that have been committed
   to the project graph store. In-progress cycle work, uncommitted agent outputs,
   and draft artifacts are invisible until the cycle completes and the artifacts
   are written to `.sle/project-graph/`.

2. **Auto-mapping follows 5-level priority chain.** Cycle artifacts are assigned
   to groups using the priority chain defined in §Cycle → artifact auto-mapping
   priority. The chain is evaluated top-to-bottom; the first match wins. No
   heuristic scoring or multi-match merging occurs.

3. **Custom layers require user approval.** Custom layers beyond the 8 baseline
   layers must be explicitly approved by the user at the project level. AI and
   system actors can suggest custom layers but cannot create them without the
   `approved_by: 'user'` field.

4. **Groups can be pinned.** When `pinned: true`, no AI or system actor can
   modify the group's metadata, add/remove nodes, or change its status. Only the
   user can modify pinned groups. Pinned groups display a lock indicator in the
   graph.

5. **Hosting planner is conversational.** The hosting planner is not a
   form-based interface. It is a conversational AI flow routed through the
   daemon. Every deployment suggestion goes through approve/modify/reject/manual-
   override controls. The daemon does not apply configs without explicit user
   action.

6. **Knowledge engine Layer 1 always available.** The project graph and document
   overview operate without the knowledge engine. They depend only on the file-
   based store and the link index. Knowledge engine Layer 2 (Cognee) is optional
   and requires Docker — when unavailable, the graph functions identically.

7. **File-based storage is the source of truth.** The `.sle/project-graph/`
   directory is the canonical store. The API reads from and writes to these
   files. There is no intermediate database or cache. Concurrent writes are
   serialized through the daemon's write lock.

8. **Edge consistency with link index.** Edges in `edges.json` that duplicate
   relationships already tracked by the link index (document-linking.md) are
   derived, not duplicated. The graph edge resolver merges link index edges
   with explicit `ProjectEdge` entries, preferring explicit entries on conflict.

9. **Layout persistence is best-effort.** Graph layout positions are saved to
   `layout.json` on every drag end. If the write fails (disk full, permissions),
   the graph continues to function and logs a warning. The next session loads
   the last successfully persisted layout.

10. **Statistics are eventually consistent.** Statistics are not recomputed on
    every mutation. They are recomputed on graph open, cycle completion, and
    manual refresh. Between computations, displayed statistics may be stale by
    up to one cycle. This is acceptable — statistics are informational, not
    transactional.

11. **Graph node count target: 10–50 groups.** The graph rendering is optimized
    for 10–50 group nodes with stacked-card components. Beyond 50 groups, the
    UI should offer filter/search to reduce visible nodes. The data model has no
    hard upper bound, but rendering performance degrades above ~80 groups.

12. **Technology stack.** Desktop: Tauri app (Win/Mac/Linux) wrapping a React
    webview. Graph computation uses Petgraph (Rust) locally on desktop. Phone/
    Tablet: responsive web app connecting to the daemon via HTTP/WebSocket with
    server-side graph computation. Graph rendering: D3 or custom React
    components — see open question PO-001.

13. **No graph mutations during halted state.** When the system state is
    `halted`, no auto-derived groups or auto-mapped nodes are created. The user
    may still manually create groups and nodes. The constraint lifts when the
    system transitions out of `halted`.

## Open questions

| ID | Question | Impact | Status |
|----|----------|--------|--------|
| PO-001 | Should the graph rendering use D3 force-directed layout, a custom React canvas renderer, or a hybrid (D3 computation + React rendering)? D3 provides proven physics but complex stacked-card customization. Custom React gives full control but requires implementing force simulation. | Rendering quality, implementation effort, performance at 50+ groups | Open |
| PO-002 | How much detail should the autonomous operation dashboard show? Should it display real-time health check results, container logs, resource metrics, or only pass/fail indicators? | Hosting layer complexity, monitoring requirements | Open |
| PO-003 | What is the offline mode behavior for the Tauri desktop app? Should the graph be fully functional offline with sync on reconnect, or should it show a cached read-only snapshot? | Desktop UX, data sync complexity | Open |
| PO-004 | What is the UX for enabling knowledge engine Layer 2 (Cognee + Docker)? Should it be a toggle in project settings, a one-time onboarding flow, or automatic detection of Docker availability? | Onboarding friction, Layer 2 adoption rate | Open |
| PO-005 | Should auto-derived groups (priority 5 in auto-mapping) have a time-to-live before automatic archival if the user never reviews them? | Graph clutter over time, data hygiene | Open |
| PO-006 | Should the graph support group nesting (sub-groups within a group) for large features that decompose into sub-features, or is a flat group list sufficient? | Scalability for large projects, graph complexity | Open |
| PO-007 | How should the graph handle merge operations when a user wants to combine two groups? Should edges be re-routed, or should one group absorb the other and inherit all edges? | Group management workflow, edge consistency | Open |
| PO-008 | Should the conversational hosting planner maintain conversation history across sessions, or is it truly ephemeral (discarded on panel close)? | Hosting planner UX, storage requirements | Open |
| PO-009 | Should the graph support export to standard formats (Graphviz DOT, Mermaid, SVG) for documentation and sharing outside the SLE environment? | Interoperability, documentation workflows | Open |
| PO-010 | What is the expected behavior when a group's status is `frozen` but a cycle produces artifacts that would auto-map to it? Reject the mapping, queue for review after unfreeze, or create a new group? | Frozen group semantics, cycle reliability | Open |
| PO-011 | ~~How should cycle scoping work before a cycle starts?~~ Resolved by DDR-028: tag system + pre-cycle scoping UI with scope drafts. | — | Resolved (DDR-028) |
| PO-012 | ~~Should the graph support multi-node selection for scoped cycles?~~ Resolved by DDR-028: tag system allows tagging multiple nodes independently with `#next-cycle`, replacing the need for ad-hoc multi-node selection (UF-007 in user-flow.md). | — | Resolved (DDR-028) |
