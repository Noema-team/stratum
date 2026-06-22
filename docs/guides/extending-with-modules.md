# Extending with Modules

**Type:** guide · **Updated:** 2026-05-02
**Source:** SLE-015 (content modules), specs/content-modules, specs/context-manager

How to write, register, and debug custom content modules (layer processors) for
SLE v2. Content modules are pluggable processors that attach to a graph layer,
read node content, and produce outputs without modifying the core graph.

---

## What are content modules?

Content modules extend the graph system with pluggable analysis capabilities.
They run after the core cycle loop -- the daemon functions identically with zero
modules registered. Built-in modules cover standard concerns (requirements,
architecture, plan, build, test). Custom modules address project-specific needs:
benchmark analysis, security linting, documentation generation, compliance
checking.

Modules produce four output types:

| Output type | Description |
|---|---|
| `annotation` | Key-value metadata attached to existing nodes |
| `derived_node` | New nodes owned by the module |
| `attachment` | Binary or text blobs stored alongside a node |
| `log` | Text entries appended to the module's process log |

Full type definitions: specs/content-modules §Data model.

---

## Module architecture

### The LayerModule interface

Every module implements `LayerModule`:

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

Constraints:

- A module attaches to **exactly one layer** (`LayerIndex`: `0 | 1 | 2 | 3 | 4`).
- Cross-layer analysis requires separate modules per layer that communicate via
  annotations.
- Modules **never modify the core graph directly**. They return `ModuleResult`
  and the daemon handles persistence.

### Registration in map.yaml

Modules are declared in `map.yaml → graph.modules`:

```yaml
graph:
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
```

Adding a module requires a `map.yaml` write followed by a daemon config reload.

### Module lifecycle

```
1. Register    -- declared in map.yaml
2. Resolve     -- daemon validates config, input/output schemas
3. Enable      -- project sets enabled: true
4. Trigger     -- event matches a trigger rule
5. Filter      -- daemon selects nodes matching inputSchema + trigger filter
6. Process     -- module.process() runs
7. Validate    -- daemon validates outputs against declared schemas
8. Persist     -- annotations, derived nodes, attachments written
9. Render      -- dashboard renders visual extensions
```

The daemon filters candidate nodes against `inputSchema` before passing them to
`process()`. Your module only receives nodes whose type, content format, and
data fields match what you declared.

---

## Registering a custom module

### Step 1: Add the module entry to map.yaml

```yaml
graph:
  modules:
    doc-coverage:
      enabled: true
      layer: 3
      config:
        min_coverage_pct: 80
        check_public_api: true
      triggers:
        - type: on_content_written
          filter:
            nodeTypes: [code_change]
            contentFormats: [code]
        - type: on_demand
```

### Step 2: Configure triggers

Each trigger has a `type` and optional `filter`:

| Trigger type | When it fires |
|---|---|
| `on_node_created` | New node added to the layer |
| `on_content_written` | Content written to a node |
| `on_node_state_changed` | Node state transition |
| `on_workflow_run_complete` | A workflow run finishes |
| `on_user_action` | User clicks a toolbar button |
| `on_schedule` | Cron-like interval |
| `on_demand` | Explicit API call (`POST /api/v2/graph/modules/{id}/trigger`) |

The `filter` narrows candidate nodes:

```yaml
triggers:
  - type: on_content_written
    filter:
      nodeTypes: [code_change]
      contentFormats: [code]
      states: [completed]
      group_id: auth-module
    debounce_ms: 500
```

`group_id` restricts the module to a single group. `debounce_ms` batches events
within the window into a single `process()` call.

### Step 3: Verify registration

After reloading the daemon, confirm the module appears:

```
GET /api/v2/graph/modules
```

The module's storage directory (`.sle/graph/modules/{id}/`) is created
automatically on first run.

---

## Writing a layer processor

### Implementing the interface

Here is a complete documentation coverage checker:

```typescript
const docCoverageModule: LayerModule = {
  id: "doc-coverage",
  name: "Documentation Coverage Analyzer",
  version: "1.0.0",
  layer: 3,

  inputSchema: {
    nodeTypes: ["code_change"],
    contentFormats: ["code"],
  },

  outputs: [
    {
      type: "annotation",
      schema: {
        type: "object",
        properties: {
          coverage_pct: { type: "number" },
          undocumented_symbols: {
            type: "array",
            items: { type: "string" },
          },
        },
        required: ["coverage_pct"],
      },
    },
    {
      type: "derived_node",
      schema: {
        type: "object",
        properties: {
          label: { type: "string" },
          type: { type: "string" },
        },
        required: ["label", "type"],
      },
    },
  ],

  async process(nodes, context) {
    const annotations: ModuleAnnotation[] = [];
    const derivedNodes: ModuleDerivedNode[] = [];
    const logs: string[] = [];
    const minCoverage = (context.config.min_coverage_pct as number) ?? 80;

    for (const node of nodes) {
      if (!node.content) {
        logs.push(`skipped ${node.id}: no content`);
        continue;
      }

      const symbols = extractPublicSymbols(node.content.body);
      const documented = symbols.filter((s) => s.hasDoc);
      const coveragePct =
        symbols.length > 0
          ? Math.round((documented.length / symbols.length) * 100)
          : 100;

      annotations.push({
        node_id: node.id,
        key: "doc_coverage",
        value: {
          coverage_pct: coveragePct,
          undocumented_symbols: symbols
            .filter((s) => !s.hasDoc)
            .map((s) => s.name),
        },
      });

      if (coveragePct < minCoverage) {
        derivedNodes.push({
          label: `doc-coverage-alert:${node.label}`,
          type: "generated_artifact",
          data: {
            severity: coveragePct < 50 ? "critical" : "warning",
            module_id: "doc-coverage",
            coverage_pct: coveragePct,
          },
          edges: [
            {
              target_node_id: node.id,
              type: "derived_from",
            },
          ],
        });
      }

      logs.push(
        `${node.id}: ${coveragePct}% (${documented.length}/${symbols.length})`
      );
    }

    return { annotations, derivedNodes, logs };
  },
};
```

### Input: what the module receives

**`nodes: NodeWithContent[]`** -- Filtered nodes matching both the trigger
filter and `inputSchema`. Each includes content and prior annotations:

```typescript
interface NodeWithContent extends GraphNode {
  content: NodeContent | null
  moduleAnnotations: Record<string, unknown>
}
```

Always check `content` for null before reading `content.body`.

**`context: ModuleContext`** -- Read-only context:

```typescript
interface ModuleContext {
  graph: GraphData
  contentStore: ContentStoreReader
  logger: ModuleLogger
  config: Record<string, unknown>
}
```

`config` contains the key-value pairs from `map.yaml → graph.modules.{id}.config`.
Cast to expected types when reading. `contentStore` provides read access to
other nodes' content, search, and version history.

### Output: what the module returns

The daemon processes `ModuleResult` fields in order:

1. **annotations** -- keyed by `(module_id, node_id, key)`. Same key overwrites.
2. **derivedNodes** -- new nodes tagged with `module_id`, connected via edges.
3. **attachments** -- written to blob store. Duplicate filenames are versioned.
4. **logs** -- appended to `.sle/graph/modules/{id}/process.log`.

### Error handling

Unhandled exceptions cause the daemon to mark the module as `errored`, emit a
`module.failed` event, and skip automatic retry. Return partial results instead:

```typescript
for (const node of nodes) {
  try {
    const result = analyzeNode(node);
    annotations.push(result);
  } catch (err) {
    logs.push(`failed ${node.id}: ${err.message}`);
  }
}

return { annotations, logs };
```

Individual output validation failures (E139) are handled by the daemon -- it
rejects the bad annotation and accepts the valid ones.

---

## Context assembly for modules

Modules do not receive agent-style assembled context. They read content directly
through `contentStore`. If you want your module's outputs visible to agents, they
must flow through the context assembly pipeline.

For background on how context is assembled, see specs/context-manager.

### Making outputs visible to agents

**In declared mode**, add your module's artifact refs to the task's slice
declarations:

```yaml
slices:
  - "doc:requirements"
  - "node:auth:doc-coverage-report"
```

**In inferred mode**, module annotations are visible on the dashboard and API
through the annotation overlay, but they are not injected into agent context
unless the role's default slice set includes the artifact.

### Reading content within your module

Use `contentStore` to discover and read content without the context manager:

```typescript
const body = await context.contentStore.getContent(targetNodeId);

const results = await context.contentStore.search("rate limiter", {
  format: "code",
  layer: 3,
  limit: 10,
});
```

---

## Integration with the link index

Module outputs participate in the link index (specs/document-linking) through
automatic structural links and manual wikilinks.

### Automatic structural links

When your module creates derived nodes with edges, the daemon creates
`structural_dag` links. Any entity viewing the target node can discover your
derived node through backlinks -- no special registration needed.

### Wikilinks in module output

If your module writes content containing `[[wikilink]]` syntax, those links are
parsed and indexed:

```typescript
const reportContent = [
  "## Coverage Report",
  "",
  "Low coverage in [[node:auth:architecture]]",
  "See [[doc:decisions]] for design rationale.",
].join("\n");
```

Supported wikilink forms (see specs/document-linking §Wikilink authoring syntax):

| Form | Resolves to |
|---|---|
| `[[doc:{key}]]` | Project document |
| `[[node:{group}:{key}]]` | Group-scoped node artifact |
| `[[src/{path}]]` | Source file |
| `[[tests/{path}]]` | Test file |

### Backlinks and discoverability

Backlinks are computed automatically from forward links. The Facilitator can
trace provenance from derived nodes back to the originating module. The
`getDescendants` query method assesses blast radius of changes to nodes your
module depends on.

---

## Testing custom modules

### Trigger a single run

```
POST /api/v2/graph/modules/doc-coverage/trigger
```

Invokes `process()` with all nodes matching `inputSchema`, bypassing trigger
filters. Check results:

```
GET /api/v2/graph/modules/doc-coverage/outputs
GET /api/v2/graph/modules/doc-coverage/annotations/{node_id}
```

### Debugging

**Process log:** `.sle/graph/modules/{id}/process.log` contains every `logs`
entry from all runs.

**Module state:** `.sle/graph/modules/{id}/state.json` records last run
timestamp, status, and cache state. If marked `errored`, error details are
included.

**WebSocket events:**

| Event | When |
|---|---|
| `module.triggered` | Run begins |
| `module.completed` | Run finishes |
| `module.failed` | Run fails (includes error code and message) |

### Common pitfalls

**Module not in `GET /api/v2/graph/modules`:** Verify the entry exists in
`map.yaml → graph.modules` and the daemon was reloaded.

**process() receives empty nodes:** Check that `inputSchema.nodeTypes` matches
nodes that exist in the layer. Check `group_id` in the trigger filter.

**Annotations not visible:** Confirm `annotation.node_id` matches an actual
node ID and the annotation key is not being overwritten by another annotation
from the same module within the same run.

**Derived nodes disconnected:** Always include at least one edge to an existing
node. A derived node without edges exists in storage but is unreachable by
traversal.

**Output validation failures (E139):** The daemon validates each output against
the `schema` in `ModuleOutput`. Ensure output shapes match declared schemas --
check `required` fields and property types.

**Content is null:** Nodes may exist without content records. Content is written
by agents, modules, users, or external systems. Guard against null.

**Cross-layer reads fail:** A module reads only its declared layer. Register
separate modules per layer and communicate through annotations.

**Processing timeout (E141):** Default is 60s. Batch large node sets, cache
intermediate results in the module's `cache/` directory, and return partial
results rather than processing everything in one pass.
