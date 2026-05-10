# HTML Content in the Agent System

Source: analysis of vision docs (`SLE-003`, `SLE-004`, `SLE-005`, `SLE-008`, `SLE-013`, `SLE-015`).

---

## Summary

HTML is already a first-class content format in the SLE system. Agents can produce, consume, and validate HTML through multiple pathways. The key touchpoints:

1. **Node content store** (`SLE-015`) — `ContentFormat` includes `'html'` as a native format. Any agent (Planner, Builder, Historian) can write HTML as a node's content body via `PUT /graph/node/:id/content` with `format: 'html'`.

2. **Validation reports** (`SLE-003`, `SLE-004`) — The gate produces `reports/validation-latest.html` as a cycle artifact. The `ArtifactFormat` type supports `'html'`. The SDK interface renders this inline (`SLE-005`).

3. **Layer modules** (`SLE-015`) — Modules can consume HTML content from nodes (`inputSchema.contentFormats: ['html']`) and produce HTML attachments. Dashboard extensions (custom `nodeRenderer`, `sidebarPanel`, `inspectorTab` components) render HTML through inspector tabs.

4. **Prompt templates** (`SLE-008`) — The security validation template checks for XSS in HTML output. The accessibility template validates semantic HTML structure. Agents are expected to both produce and validate HTML.

---

## What agents can do with HTML today (per spec)

### Write HTML content to graph nodes

```typescript
// Agent writes HTML to a node via the content store API
PUT /graph/node/:id/content
{
  format: 'html',
  body: '<table><tr><td>...</td></tr></table>'
}
```

This works for any agent role that writes content — Planner (requirements), Builder (code/docs), Historian (decisions).

### Generate HTML validation reports

The gate node automatically produces `reports/validation-latest.html` — a per-category results table that users and CI can consume. This is declared in `validation.yaml`:

```yaml
artifacts:
  - path: reports/validation-latest.html
    type: html
```

### Validate HTML output

The security check template (`security_check.md`) includes:
- "Is HTML output escaped to prevent XSS where applicable?"

The accessibility check template (`accessibility_check.md`) validates:
- Semantic HTML structure (headings, landmarks, interactive elements)
- Alternative text for images
- Keyboard navigability
- ARIA usage

### Process HTML through layer modules

Modules can read HTML content from nodes and produce derived outputs — annotations, new nodes, or attachments:

```typescript
{
  inputSchema: {
    contentFormats: ['html'],
    nodeTypes: ['documentation']
  },
  process: async (nodes, ctx) => {
    const html = nodes[0].content.body
    // analyze, transform, annotate...
  }
}
```

---

## Gaps and opportunities

These are not specified in the current vision docs but represent natural extensions:

### 1. HTML as agent output format for rich artifacts

Agents currently produce markdown (requirements, architecture, test-plan) and code. An agent could produce HTML for:
- **Interactive diagrams** — architecture visualizations that agents embed in nodes
- **Dashboard widgets** — self-contained HTML/CSS/JS that the graph dashboard renders in inspector tabs
- **Report templates** — reusable HTML templates for validation reports, evaluation summaries

### 2. Browser-based validation via HTML rendering

`SLE-013` mentions a browser-harness integration for UI testing. Agents could:
- Generate HTML pages as build artifacts
- Use browser-harness to screenshot and validate layout
- Feed screenshots back as node attachments for the Evaluator

### 3. HTML in the context window

The context manager (`SLE-007`) currently loads markdown, code, and JSON artifacts. It could strip HTML tags for LLM consumption while preserving the full HTML for dashboard rendering. This keeps token budgets low while allowing rich output.

### 4. Module-rendered HTML in the dashboard

Layer modules register `inspectorTab` components. A module could register an HTML renderer that takes node content and renders it as a formatted document — think rendered markdown, syntax-highlighted code, or interactive tables. The dashboard would use an iframe or shadow DOM for safe rendering.

### 5. Self-improving HTML validation

Following the skills pattern from Hermes integration: when the security or accessibility check finds an HTML issue, the system could persist the pattern as a learned rule. Future Builder calls would have these rules in context, preventing repeat violations.

---

## Proposed additions to the spec

If we want to fully enable HTML as an agent output format:

1. **Extend `ArtifactFormat`** to include `'html'` alongside `'markdown'` and `'json'` for cycle artifacts (docs, reports).
2. **Add an HTML sanitization step** in the gate node — agents produce untrusted HTML; the dashboard must render it safely (DOMPurify or equivalent).
3. **Define `html_template` as a content module type** — a module that takes structured data from a node and renders it using an HTML template.
4. **Add `html` as a valid `context_pack` format** — when the context manager loads Component 5, HTML artifacts get stripped to text for LLM consumption but remain HTML for the dashboard.
