# Knowledge Engine

**Type:** spec · **Status:** deprecated · **Updated:** 2026-05-23
**Depends on:** DDR-005, DDR-025, [../reference/types.md](../reference/types.md) §1–§7, [context-manager.md](context-manager.md) §Assembly algorithm
**Source material:** SLE-014 (Cognee knowledge engine integration)

> [!IMPORTANT]
> **Specification Status: Deprecated & Replaced**
> The third-party Cognee FastAPI integration described in this specification is **deprecated** and will not be used. The system instead utilizes a custom, deterministic **Link Index DAG** (as specified in `document-linking.md`) to establish, track, and query code-to-specification traceability. This keeps the orchestrator completely local, fast, and free of external Docker container dependencies.

## Overview

The knowledge engine is an **optional** semantic search and knowledge graph layer
that augments the deterministic context manager (context-manager.md). When enabled,
it provides three capabilities: semantic artifact search across all generated
artifacts, cross-session memory that persists across context window resets, and
knowledge distillation that extracts reusable patterns from completed cycles.

It is never in the critical path. When disabled or unreachable, every SLE cycle
completes identically to a system without it. The `KnowledgeProvider` interface
has a `NoopProvider` that is used when the service is off, making the knowledge
engine transparent to all other subsystems.

The engine runs as a Cognee FastAPI container (DDR-005) behind a provider
interface. The SLE daemon communicates via HTTP. Activation is a Docker Compose
profile flag, not a code change.

**Canonical types:** [../reference/types.md](../reference/types.md).
**Context assembly integration:** [context-manager.md](context-manager.md) §Assembly algorithm step 6.
**DDR-005 summary:** Cognee as optional Layer 3 REST API container, `--profile knowledge`.

---

## Data model

### SearchType

```typescript
export type SearchType = 'insights' | 'chunks' | 'graph'
```

Discriminated search mode. Maps to Cognee query types:

| SLE SearchType | Cognee queryType | Returns |
|----------------|-------------------|---------|
| `insights` | `INSIGHTS` | Pre-summarised insights from the knowledge graph |
| `chunks` | `CHUNKS` | Raw text chunks with similarity scores |
| `graph` | `GRAPH_COMMUNITIES` | Knowledge graph community summaries |

`insights` is the default for context enhancement. `chunks` is for direct
similarity search. `graph` is for structural knowledge graph queries.

### SearchResult

```typescript
export interface SearchResult {
  id: string
  text: string
  score: number
  metadata: Record<string, string>
  source: string
}
```

A single result from a knowledge search. `metadata` contains the unified
metadata fields defined in §Unified metadata schema. `source` is the original
ingestion source path. `score` is a normalised similarity value in [0, 1].

### KnowledgeConfig

```typescript
export interface KnowledgeConfig {
  enabled: boolean
  url: string
  timeout_ms: number
  max_results: number
  search_type: SearchType
  dataset_prefix: string
}
```

Configuration block within `agents.yaml`. When `enabled` is `false`, the factory
returns `NoopProvider` — no network calls, no logs, no errors.

| Field | Default | Notes |
|-------|---------|-------|
| `enabled` | `false` | Opt-in via `agents.yaml` or Docker Compose profile |
| `url` | `http://cognee:8000` | Internal Docker network address |
| `timeout_ms` | `5000` | Per-request HTTP timeout |
| `max_results` | `3` | Maximum results per context enhancement query |
| `search_type` | `'insights'` | Default search type for context enhancement |
| `dataset_prefix` | `'sle-'` | Prepended to project name for dataset IDs |

### KnowledgeProvider

```typescript
export interface KnowledgeProvider {
  ingest(content: string, metadata: Record<string, string>): Promise<void>
  cognify(): Promise<void>
  search(query: string, type: SearchType): Promise<SearchResult[]>
  health(): Promise<boolean>
}
```

The provider interface is the only surface area the rest of the SLE daemon sees.
Two implementations: `CogneeClient` (live) and `NoopProvider` (disabled).

| Method | CogneeClient | NoopProvider |
|--------|-------------|-------------|
| `ingest` | POST to Cognee `/api/v1/add` | Resolves immediately, no-op |
| `cognify` | POST to Cognee `/api/v1/cognify` | Resolves immediately, no-op |
| `search` | POST to Cognee `/api/v1/search` | Returns `[]` |
| `health` | GET Cognee `/api/v1/health` | Returns `false` |

### CogneeClient

```typescript
export class CogneeClient implements KnowledgeProvider {
  constructor(private baseUrl: string, private timeoutMs: number = 5000) {}
}
```

HTTP client with retry and circuit breaker:

| Property | Value |
|----------|-------|
| Retry attempts | 3 |
| Backoff | Exponential: 1s, 2s, 4s |
| Circuit breaker threshold | 5 consecutive failures |
| Circuit breaker reset | 60 seconds |
| Timeout per request | `timeout_ms` from config |

When the circuit breaker is open, all methods return immediately without
network I/O: `ingest` succeeds, `search` returns `[]`, `health` returns `false`.

### NoopProvider

```typescript
export class NoopProvider implements KnowledgeProvider {}
```

Every method is a no-op. No logging, no errors, no network calls. Returned by
the factory when:
1. `knowledge.enabled` is `false` in `agents.yaml`
2. Cognee health check fails at daemon startup (daemon logs a single warning,
   then proceeds with `NoopProvider` — it does not exit)

### Unified metadata schema (resolves G32)

SLE-014 (knowledge engine) and SLE-017 (link index) both tag entities with
metadata. G32 identified that these schemas were incompatible — queries from
one system could not filter by fields owned by the other.

**Resolution:** A single shared metadata schema used by both ingestion and the
link index. All metadata fields are optional strings. Systems populate what
they know; consumers filter on what they need.

```typescript
export interface UnifiedMetadata {
  role?: AgentRole | 'discovery'
  artifact?: string
  cycle?: string
  project?: string
  path?: string
  link_type?: string
  link_source?: string
  link_target?: string
  link_weight?: string
  group?: string
}
```

| Field | Populated by | Purpose |
|-------|-------------|---------|
| `role` | Knowledge engine ingestion | Agent role that generated the artifact |
| `artifact` | Knowledge engine ingestion | Artifact type key (`requirements`, `architecture`, etc.) |
| `cycle` | Knowledge engine ingestion | Cycle ID string |
| `project` | Knowledge engine ingestion | Project name for multi-project isolation |
| `path` | Knowledge engine ingestion | File path (Builder artifacts only) |
| `link_type` | Link index (SLE-017) | Structural/semantic link classification |
| `link_source` | Link index (SLE-017) | Source entity reference |
| `link_target` | Link index (SLE-017) | Target entity reference |
| `link_weight` | Link index (SLE-017) | Link strength value |
| `group` | Knowledge engine + link index | Feature group for group-scoped artifacts (DDR-025) |

When the knowledge engine ingests a link from the SLE-017 link index, it
preserves `link_type`, `link_source`, `link_target`, and `link_weight` alongside
the SLE-014 `role`, `artifact`, and `cycle` fields. An agent can then query
Cognee for "all structural links from the planner role" by filtering on both
`link_type=structural_dag` and `role=planner`.

Conversely, when the link index surfaces knowledge-engine-originated entities,
it can use `role` and `cycle` for filtering. Neither system needs to understand
all fields — they ignore fields they do not use.

### KnowledgeSlice

```typescript
export interface KnowledgeSlice {
  results: SearchResult[]
  token_count: number
  truncated: boolean
}
```

The optional 6th context component produced by the enhancement step. Included
in `AssembledContext` when the knowledge engine is enabled and healthy.

### Dataset organisation

Cognee organises data into datasets. SLE uses one dataset per project:

```
dataset: "{config.dataset_prefix}{project_name}"
```

Default: `sle-my-api`. All artifacts for a project are ingested into the same
dataset. Metadata fields enable filtering without separate datasets per role or
cycle.

### AssembledContext extension

The `AssembledContext` type gains one optional field when the knowledge engine
is enabled:

```typescript
export interface AssembledContext {
  system_prompt: string
  artifact_slices: Record<string, string>
  state_summary: string
  task: string
  failure_context?: string
  knowledge_context?: string
  token_count: number
  truncated: string[]
}
```

`knowledge_context` is a formatted string of up to `max_results` search results,
joined with double newlines. It is absent when:
- The knowledge provider is `NoopProvider`
- Cognee health check fails
- Search returns zero results
- Remaining token budget is insufficient

### IngestionTag

```typescript
export interface IngestionTag {
  dag_node: DAGNode
  artifact_keys: string[]
  fire_and_forget: boolean
}
```

Defines which artifacts are ingested at each DAG integration point. All
ingestion is fire-and-forget — failures are logged but never block the cycle.

---

## Behavior

### Provider lifecycle

```
1. Daemon startup
   a. Load agents.yaml → knowledge section
   b. createKnowledgeProvider(config)
      - If config.enabled = false → return NoopProvider
      - If config.enabled = true:
        i.   Create CogneeClient(config.url, config.timeout_ms)
        ii.  Call health() with 5s timeout
        iii. If health fails → log warning, return NoopProvider
        iv.  If health passes → return CogneeClient

2. Daemon runtime
   a. Provider is injected into context manager and DAG runner
   b. Every context assembly call checks provider.health() first
   c. Ingestion calls are fire-and-forget (no await on failure)
   d. Circuit breaker state is local to CogneeClient instance

3. Daemon shutdown
   a. No graceful drain needed — pending ingestion is non-critical
   b. No state to persist — Cognee owns its data
```

### DAG integration points

The DAG runner calls the knowledge provider at five points during a cycle.
All calls are fire-and-forget. The cycle proceeds regardless of outcome.

#### Point 1 — After DESIGN node

The Designer produces `requirements.md` and `architecture.md`. Both are
ingested with the Designer's role metadata.

```
onNodeExit(DAGNode.DESIGN):
  for artifact in ['requirements', 'architecture']:
    content = readArtifact(artifact)
    knowledge.ingest(content, {
      role: 'designer',
      artifact,
      cycle: cycleState.id,
      project: map.project.name,
      group: ''                    // empty for project-scoped docs
    })
```

#### Point 2 — After PLAN node

The Planner produces `plan.md` and `test-plan.md`.

```
onNodeExit(DAGNode.PLAN):
  for artifact in ['plan', 'test-plan']:
    content = readArtifact(artifact)
    knowledge.ingest(content, {
      role: 'planner',
      artifact,
      cycle: cycleState.id,
      project: map.project.name,
      group: ''
    })
```

#### Point 3 — After BUILD node

The Builder produces implementation files. Each file is ingested individually
with its file path as metadata.

```
onNodeExit(DAGNode.BUILD):
  for (path, content) in builderOutput.fileMap:
    knowledge.ingest(content, {
      role: 'builder',
      artifact: 'implementation',
      path,
      cycle: cycleState.id,
      project: map.project.name,
      group: currentGroup            // from task or cycle context
    })
```

#### Point 4 — After HISTORY node

The Historian produces a decisions delta. Only the delta (not the full
decisions file) is ingested.

```
onNodeExit(DAGNode.HISTORY):
  delta = readArtifactDelta('decisions', sinceLastIngestion)
  knowledge.ingest(delta, {
    role: 'historian',
    artifact: 'decisions',
    cycle: cycleState.id,
    project: map.project.name,
    group: ''
  })
```

#### Point 5 — After cycle exit

Cognify builds or updates the knowledge graph from all data ingested during
the cycle. This is an async LLM-powered pipeline that runs in the Cognee
container. The daemon initiates it but does not await completion.

```
onCycleExit(outcome):
  knowledge.cognify()
```

The daemon logs cognify initiation. If cognify fails, the next cycle's search
results may be stale — this is acceptable because deterministic slices from
context-manager.md always provide correct context.

### Context enhancement

After the deterministic 5-component assembly in context-manager.md, an optional
enhancement step queries the knowledge engine for semantically relevant context.

```
enhanceWithKnowledge(window, role, state, knowledge, config):
  if !knowledge.health(): return window

  query = state.current_task
  results = knowledge.search(query, config.search_type)

  if results.length = 0: return window

  knowledgeSlice = results
    .slice(0, config.max_results)
    .map(r => `[${r.metadata.role}/${r.metadata.artifact}] ${r.text}`)
    .join('\n\n')

  knowledgeTokens = countTokens(knowledgeSlice)
  remaining = HARD_CEILING - window.token_count

  if knowledgeTokens > remaining:
    log.warn("knowledge slice exceeds budget", knowledgeTokens, remaining)
    return window

  return {
    ...window,
    knowledge_context: knowledgeSlice,
    token_count: window.token_count + knowledgeTokens
  }
```

This step:
- Only runs if Cognee is healthy (checked per-invocation, not cached)
- Only adds context if there is remaining token budget within the 4,000-token
  hard ceiling (context-manager.md §Token budgets)
- Caps at `config.max_results` (default 3) to control budget impact
- Uses the `insights` search type by default for concise, pre-summarised results
- Never pushes the total past the hard ceiling

### Enhanced context window

When the knowledge engine is active and returns results, the agent receives a
6th context component:

```
┌─────────────────────────────────────┐
│ 1. System prompt        ~500 tokens │  context-manager.md
│ 2. Artifact slices     ~2000 tokens │  context-manager.md
│ 3. State summary        ~300 tokens │  context-manager.md
│ 4. Task                 ~200 tokens │  context-manager.md
│ 5. Failure context      ~400 tokens │  context-manager.md (retry only)
│ 6. Knowledge context   ~600 tokens │  knowledge-engine.md (optional)
└─────────────────────────────────────┘
                    total target: ~3400 tokens
                    hard ceiling: 4000 tokens (unchanged)
```

Component 6 is only present when all four conditions are true:
1. `knowledge.enabled` is `true` in `agents.yaml`
2. Cognee health check passes
3. Relevant search results exist
4. Token budget has remaining capacity after components 1–5

### Discovery ingestion

During discovery (init-and-discovery.md), the knowledge engine ingests discovery
artifacts as they are produced. This enables the first cycle to benefit from
semantic search over discovery documents.

```
onDiscoveryArtifactApproved(artifactPath, content):
  knowledge.ingest(content, {
    role: 'discovery',
    artifact: pathToArtifactKey(artifactPath),
    cycle: '',
    project: map.project.name,
    group: ''
  })
```

Discovery artifacts are ingested with the `discovery` pseudo-role. They become
searchable before any cycle runs, allowing the Designer's context enhancement
to surface relevant discovery insights.

### Search result formatting

Each search result in the knowledge context is formatted as:

```
[role/artifact] content text
```

Example with three results:

```
[planner/requirements] The rate limiter must enforce 100 requests per minute
per API key. Excess requests return HTTP 429 with a Retry-After header.

[builder/implementation] Rate limiter implemented as a Redis-backed sliding
window counter. TTL expiry set to 120 seconds to account for clock skew.

[historian/decisions] Chose Redis over in-memory Map for rate limit storage
to support multi-process deployments and survive restarts.
```

The `role/artifact` prefix tells the agent where each insight originated. This
is informational — the agent uses the content, not the provenance, for
decision-making.

---

## API contract

daemon-api.md is the single source of truth for all REST endpoints. The
knowledge engine adds the following endpoints to the daemon API.

### Cross-reference table

| Endpoint | Method | Purpose | Defined in |
|----------|--------|---------|------------|
| `/api/v2/knowledge/health` | GET | Check knowledge engine connectivity | daemon-api-endpoints.md §Knowledge engine |
| `/api/v2/knowledge/status` | GET | Engine status, circuit breaker state, dataset info | daemon-api-endpoints.md §Knowledge engine |
| `/api/v2/knowledge/search` | POST | Direct knowledge search (debugging, UI) | daemon-api-endpoints.md §Knowledge engine |
| `/api/v2/knowledge/ingest` | POST | Manual ingestion trigger (debugging) | daemon-api-endpoints.md §Knowledge engine |
| `/api/v2/knowledge/cognify` | POST | Manual cognify trigger (debugging) | daemon-api-endpoints.md §Knowledge engine |

These endpoints expose the knowledge engine's state for observability and
debugging. They do not change the automated ingestion or enhancement behaviour.

### Internal HTTP calls to Cognee

The SLE daemon makes these internal calls to the Cognee container. These are
not part of the daemon's external API.

| Cognee endpoint | Method | Purpose | When called |
|-----------------|--------|---------|-------------|
| `/api/v1/add` | POST | Ingest data into a dataset | After DESIGN, PLAN, BUILD, HISTORY nodes |
| `/api/v1/cognify` | POST | Run knowledge graph pipeline | After cycle exit (fire-and-forget) |
| `/api/v1/search` | POST | Semantic search | During context enhancement |
| `/api/v1/health` | GET | Health check | Startup + per-enhancement |
| `/api/v1/datasets` | GET | List datasets | Status endpoint only |
| `/api/v1/datasets/{id}` | DELETE | Delete a dataset | Manual reset only |

All internal calls use the `CogneeClient` with retry and circuit breaker
behaviour defined in §CogneeClient.

---

## Error cases

### Ingestion failures

| Error | Condition | Response |
|-------|-----------|----------|
| `ingest_timeout` | Cognee does not respond within `timeout_ms` | Retry up to 3 times with exponential backoff. Log on final failure. Cycle continues. |
| `ingest_connection_refused` | Cognee container is down or not started | Increment circuit breaker counter. Log warning. Cycle continues. |
| `ingest_500` | Cognee returns HTTP 500 | Retry up to 3 times. Log on final failure. Cycle continues. |
| `ingest_circuit_open` | Circuit breaker has opened (5+ consecutive failures) | Skip ingestion entirely. No network call. Circuit resets after 60s. |

**Invariant:** Ingestion failures are never visible to the user or the cycle.
They are logged at `warn` level and silently skipped.

### Search failures

| Error | Condition | Response |
|-------|-----------|----------|
| `search_timeout` | Cognee search does not respond within `timeout_ms` | Return empty results. Context assembly proceeds without knowledge slice. |
| `search_connection_refused` | Cognee unreachable at context assembly time | Return empty results. No warning to cycle — graceful degradation. |
| `search_empty_dataset` | Dataset exists but contains no relevant results | Return empty results. Normal condition on first cycle. |
| `search_no_dataset` | Dataset does not exist yet (no prior ingestion) | Return empty results. Normal condition before first cognify. |

### Cognify failures

| Error | Condition | Response |
|-------|-----------|----------|
| `cognify_timeout` | Cognify call times out | Log warning. Next cycle may have stale graph. Self-corrects on next cognify. |
| `cognify_failed` | Cognee reports pipeline failure | Log warning with error details. No user-visible effect. |

Cognify is always fire-and-forget. The daemon does not track cognify completion.
Stale knowledge graph data is the worst case — deterministic context slices
always provide correct baseline context.

### Health check failures

| Error | Condition | Response |
|-------|-----------|----------|
| `health_startup_fail` | Cognee health check fails at daemon startup | Log single warning. Continue with `NoopProvider`. Daemon does not exit. |
| `health_runtime_fail` | Cognee health check fails during context enhancement | Skip enhancement. Return unenhanced context. Next call retries health. |

### Metadata errors

| Error | Condition | Response |
|-------|-----------|----------|
| `metadata_field_missing` | Required metadata field is empty or undefined | Log warning. Ingest with available fields. Missing `role` is most impactful — search filtering by role will not work for that item. |
| `metadata_unified_schema_mismatch` | Link index provides fields not in `UnifiedMetadata` | Ignore unknown fields. Log at debug level. Forward-compatible by design. |

---

## Constraints

1. **Never in the critical path.** Every SLE cycle completes successfully
   whether Cognee is running or not. If Cognee is unreachable at context
   assembly time, the context manager returns deterministic slices exactly as
   specified in context-manager.md.

2. **Fire-and-forget ingestion.** All ingestion and cognify calls are
   non-blocking. The DAG runner does not await their completion. Failures are
   logged and silently skipped — they never halt a cycle.

3. **Provider interface exclusivity.** The SLE daemon never imports or depends
   on Cognee's Python code. All communication is HTTP through the
   `KnowledgeProvider` interface. The `CogneeClient` is the sole integration
   point.

4. **NoopProvider transparency.** When `NoopProvider` is active, SLE operates
   identically to a system with no knowledge engine. No other module changes
   behaviour based on the provider implementation.

5. **Hard ceiling respected.** The knowledge context never pushes the total
   assembled context past the 4,000-token hard ceiling from context-manager.md.
   If the knowledge slice would exceed the remaining budget, it is dropped.

6. **Single dataset per project.** All artifacts for a project are ingested
   into one dataset: `{dataset_prefix}{project_name}`. Metadata fields enable
   filtering without dataset proliferation.

7. **Unified metadata schema.** All ingestion and link index entries use the
   `UnifiedMetadata` schema defined in §Unified metadata schema. This resolves
   G32 — both SLE-014 and SLE-017 share the same field taxonomy. Unknown fields
   are ignored, not rejected.

8. **No writes to artifact store.** The knowledge engine never writes to the
   artifact store, `map.yaml`, rule files, or agent prompts. It is read-only
   with respect to all SLE-managed state.

9. **No shared state with BMAD.** The knowledge engine operates within the SLE
   daemon's scope. It does not share state, databases, or API surface with the
   BMAD orchestrator (separate application, separate concerns).

10. **Circuit breaker isolation.** The circuit breaker is local to the
    `CogneeClient` instance. It does not affect any other SLE subsystem. When
    open, the provider behaves as `NoopProvider` for the duration of the reset
    period (60 seconds).

11. **Cognify does not block.** Cognify is an async LLM-powered pipeline that
    runs in the Cognee container. The daemon initiates it after cycle exit but
    never awaits completion. Stale graph data is the worst case — it
    self-corrects on the next cognify call.

12. **Docker Compose profile activation.** The Cognee container does not start
    by default. Users opt in with `docker compose --profile knowledge up`. The
    `agents.yaml → knowledge.enabled` flag controls the daemon client
    independently of the container state.

13. **Discovery ingestion uses pseudo-role.** Discovery artifacts are ingested
    with `role: 'discovery'`, matching the `GeneratorRole` type from types.md.
    This distinguishes them from cycle-generated artifacts in search results.

---

## Open questions

| ID | Question | Impact | Status |
|----|----------|--------|--------|
| KE-001 | Should the knowledge engine use Meilisearch for full-text search, Postgres FTS on the existing PG16 instance, or defer to Cognee's built-in hybrid search for all retrieval patterns? Meilisearch adds operational overhead but provides superior typo-tolerance and faceted filtering. Postgres FTS has zero infra cost but limited semantic capabilities. Cognee alone may not handle keyword-dominant queries well. | Search quality, infrastructure footprint, operational complexity | Open — defer to P5 evaluation per DDR-005 |
| KE-002 | Should `cognify` be triggered after every cycle exit, or batched (e.g., after every N cycles or on a timer)? Batching reduces Cognee LLM costs but increases staleness. | Cognee LLM costs, knowledge freshness | Open |
| KE-003 | Should the context enhancement step use `insights` search type exclusively, or should it switch to `graph` for certain roles (e.g., Historian) or planning depths (e.g., `research`)? | Context relevance per role, implementation complexity | Open |
| KE-004 | How should the knowledge engine handle multi-group artifacts (DDR-025) in search queries? Should results be filtered by group, or should all groups be searchable? | Multi-group context assembly, search precision | Open |
| KE-005 | Should the `UnifiedMetadata` schema be validated at ingestion time, or should invalid metadata be accepted with a warning? Strict validation catches errors early but may reject valid edge cases. | Data quality, ingestion robustness | Open |
| KE-006 | What is the expected resource usage ceiling for Cognee with <10k artifacts? DDR-005 targets <2GB RAM steady state. Should the daemon monitor Cognee resource usage and warn? | Production monitoring, operational visibility | Open — defer to P5 evaluation |
| KE-007 | Should the knowledge engine index implementation file contents (Builder artifacts) in full, or only structural metadata (function signatures, class definitions, imports)? Full indexing increases search surface but consumes more storage and cognify time. | Search quality, storage costs, cognify latency | Open |
| KE-008 | Should the context enhancement step cache search results within a cycle (same task, same role) to avoid redundant queries? Caching reduces latency but may miss data ingested mid-cycle. | Performance, result freshness | Open |
| KE-009 | How should the daemon handle a situation where Cognee is enabled and healthy at startup but becomes unreachable mid-cycle? The circuit breaker handles this, but should the daemon emit a WebSocket event for the UI to show a degradation indicator? | User experience, observability | Open |
