# Agent-Authored HTML Components (AAHC)

**Date:** 2026-05-10
**Status:** proposal
**Sources:** [html-content-vision.md](html-content-vision.md) + [../research/space-agent-research.md](../research/space-agent-research.md)

---

## What this is

A synthesis of two analyses: HTML as a first-class agent content format in SLE, and Space Agent's widget authoring system. The core insight is that **Space Agent gives HTML a lifecycle, SLE gives HTML a quality gate**. Combined, agents don't just write HTML — they author, validate, iterate, and improve HTML artifacts within the DAG.

---

## The combined model

### 1. The artifact format

Borrow Space Agent's widget manifest but adapt it to SLE's node content store:

```yaml
# .sle/html-components/{component-id}/manifest.yaml
id: architecture-diagram
renderer: renderer.html       # HTML + inline CSS/JS
schema: data-schema.json      # JSON schema for input data
dependencies: []              # CDN links or local assets
sandbox: iframe               # iframe | shadow-dom
```

The agent writes the manifest + renderer as node content. The content store already supports this — it's just `format: 'html'` with structured attachments. No new storage needed.

### 2. The mutation model (from Space Agent)

Borrow staged-turn mutation but enforce it through the DAG, not per-turn:

```
DESIGN node:
  Agent reads requirements → decides "I need an architecture diagram component"
  → writes manifest.yaml (declaration only)

PLAN node:
  Agent reads manifest → designs data flow → writes data-schema.json

BUILD node:
  Agent reads manifest + schema → writes renderer.html
  → gate validates (XSS, semantic HTML, accessibility)

EVALUATE node:
  Dashboard renders component in sandboxed iframe
  → agent sees screenshot (node attachment)
  → evaluates: does this communicate what requirements.md intended?
```

This is the read-before-write discipline from Space Agent, but enforced by DAG ordering rather than turn protocol. Each node can only write what the previous node declared.

### 3. Prompt includes for HTML behavior (from Space Agent)

Connect the self-writing memory pattern directly to HTML generation:

```
.sle/prompts/builder/
  00-base.md                    ← shipped default
  10-project.md                 ← "this project uses Tailwind"
  20-html-behavioral.md         ← learned HTML patterns
  90-override.md                ← human override
```

After each cycle, the Evaluator writes behavioral notes:

```markdown
## HTML behavioral notes (auto-generated, cycle 7)

- Architecture diagrams must use `<nav>` landmarks for clickable regions
- Tables require `<caption>` elements (learned from accessibility failure, cycle 6)
- This project renders in dark mode — use CSS custom properties, not hardcoded colors
- Chart components must degrade gracefully without JS (learned from security audit, cycle 5)
```

Human approves at CONFIRM gate. Next cycle's Builder gets this as standing context.

### 4. L0/L1/L2 for HTML templates (from Space Agent)

```
.sle/html-templates/
  L0/                           ← shipped with daemon (immutable)
    validation-report.html
    architecture-diagram.html
    test-results-table.html
  L1/                           ← project-level (checked in)
    custom-report.html          ← overrides L0 validation-report
  L2/                           ← user-level (gitignored)
    my-preferred-layout.html    ← personal preference
```

Agents compose from templates rather than writing HTML from scratch. The Builder reads a template from L0, injects data, and writes the result as node content. Projects override templates in L1. Users override in L2.

### 5. The validation pipeline (SLE's unique contribution)

Space Agent has no built-in validation. The combined model applies three validation layers to agent-authored HTML:

**static-check** (L4, no LLM):
- DOMPurify sanitization pass
- HTML validator (no unclosed tags, valid attributes)
- CSP header check (no inline event handlers)

**llm-check** (L3, accessibility/security templates):
- Semantic HTML structure validation
- XSS vector detection
- Keyboard navigability audit

**exec-check** (L4, browser-harness):
- Render the HTML in a headless browser
- Screenshot → attach to node
- Run accessibility audit (axe-core)
- Verify responsive behavior at 3 breakpoints

All three feed results into `context-pack.md`. The Debugger gets the screenshot + failure context. The next iteration's Builder gets behavioral notes via prompt includes.

### 6. The full flow

```
User intent: "Add an architecture diagram to the project docs"

INTENT → CONTEXT ASSEMBLY
  → DESIGN: Designer declares component manifest
  → PLAN: Planner defines data schema + template selection (L0/L1/L2 resolution)
  → TEST: Tester writes accessibility + security test contracts
  → CONFIRM GATE: Human reviews plan + chosen template
  → BUILD: Builder reads template, injects data, writes HTML to node content store
  → HISTORY: Audit entry
  → EXEC:
      static-check: DOMPurify + HTML validation
      llm-check: semantic structure + XSS audit
      exec-check: headless render + screenshot + axe-core
  → VALIDATION GATE:
      pass → EVALUATE → screenshot shown → "does this communicate the architecture?"
      fail → DEBUG (gets screenshot + context-pack) → PLAN (retry with behavioral notes)
  → SNAPSHOT: HTML component locked as node content
```

---

## Capability comparison

| Capability | Space Agent alone | HTML vision alone | Combined (AAHC) |
|---|---|---|---|
| Agent writes HTML | Yes (widgets) | Yes (content store) | Yes — structured manifests + content store |
| Validates HTML quality | No | Yes (3 sub-phases) | Yes — validated before it reaches the dashboard |
| Sandbox rendering | Yes (canvas) | Proposed (iframe) | Yes — sandbox mode per component |
| Self-improving | Yes (prompt includes) | Mentioned (gap #5) | Yes — evaluator writes behavioral notes to prompt includes |
| Template reuse | No | No | Yes — L0/L1/L2 layered templates |
| Read-before-write | Yes (staged turns) | No | Yes — enforced by DAG node ordering |
| Screenshot feedback | No | Proposed (gap #2) | Yes — exec-check produces screenshot as node attachment |

---

## Spec changes required

1. **`ContentFormat`** already includes `'html'` — no change needed.
2. **New: `html-component` node type** — a graph node type that carries a manifest + renderer + schema, rendered by the dashboard.
3. **New: `html-templates/` directory** with L0/L1/L2 resolution — extends the existing rule file layering pattern.
4. **New: `20-html-behavioral.md` prompt include** — auto-generated by Evaluator, human-approved, loaded into Builder context.
5. **New: browser-harness exec-check** — headless render + screenshot + axe-core as a validation sub-phase for HTML content.
6. **New: `sandbox` field on node content** — `'iframe'` or `'shadow-dom'`, controls how the dashboard renders untrusted agent HTML.

---

## Relationship to other ideas

| Document | Connection |
|---|---|
| [html-content-vision.md](html-content-vision.md) | Source analysis — HTML as content format in current spec |
| [../research/space-agent-research.md](../research/space-agent-research.md) | Source research — widget authoring, prompt includes, staged mutation, L0/L1/L2 |
| [hermes-stratum-integration.md](hermes-stratum-integration.md) | Self-improving prompts concept — complements prompt includes for HTML |
| [ideal-state-and-validation-vision.md](ideal-state-and-validation-vision.md) | Self-improving validation rules — applies to HTML behavioral learning |
