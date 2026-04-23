# Space Agent — Research & Borrowing Analysis

**Date:** 2026-04-24
**Status:** research
**Sources:**
- https://deepwiki.com/agent0ai/space-agent (overview)
- https://deepwiki.com/agent0ai/space-agent/1.2-repository-structure-and-documentation-system
- https://deepwiki.com/agent0ai/space-agent/3.1-onscreen-agent
- https://deepwiki.com/agent0ai/space-agent/3.3-skill-system-and-prompt-includes
- https://deepwiki.com/agent0ai/space-agent/4.2-agent-driven-widget-authoring
- https://deepwiki.com/agent0ai/space-agent/4.1-spaces-canvas-runtime
- https://deepwiki.com/agent0ai/space-agent/4-backend-server-runtime
- https://deepwiki.com/agent0ai/space-agent/4.1-request-routing-and-page-shells
- https://deepwiki.com/agent0ai/space-agent/2.1-framework-bootstrap-and-runtime-api
- https://deepwiki.com/agent0ai/space-agent/2.2-module-and-extension-system

---

## What this is

Analysis of Space Agent (agent0ai/space-agent) — a browser-first AI agent runtime where the agent lives inside the application it can modify. This document identifies concepts worth borrowing for SLE/Stratum.

---

## 1. What is Space Agent?

Space Agent is a **browser-first AI agent runtime**. The agent lives *inside* the same application framework it can modify. Unlike traditional AI chat products where the agent is a sidebar alongside a fixed UI, Space Agent treats the browser itself as the primary application runtime.

**Core philosophy:** "Thick frontend, thin backend." All orchestration, prompt construction, tool execution, and state management happen client-side. The server is explicitly a "thin infrastructure layer" for security, auth, and file system integrity.

**What the agent can do:** Create/destroy UI elements, manage files, browse the web, modify its own skill set — all from within the browser.

**Tech stack:** Vanilla JS + Alpine.js, Node.js backend, Electron desktop, any LLM API + local via Transformers.js/WebGPU.

---

## 2. Core Architecture

### 2.1 L0/L1/L2 Customware Layers

The foundational architectural pattern. All files (modules, configs, user data) are resolved through a three-tier inheritance system:

| Layer | Name | Description | Persistence |
|-------|------|-------------|-------------|
| **L0** | Firmware | Immutable core system code. Shipped with the repo. | `app/L0/` |
| **L1** | Group Customware | Runtime-editable shared modules/configs for a group/team. | `CUSTOMWARE_PATH/L1/` |
| **L2** | User Customware | Runtime-editable per-user private modules, widgets, settings. | `CUSTOMWARE_PATH/L2/` |

**Resolution order:** L2 → L1 → L0. Higher layers override lower ones (same filename = override). Different filenames under the same extension point = additive composition. Permissions enforced: users write to L2, group managers to L1, L0 is immutable.

**Relevance to SLE:** SLE already has this for rule files (`shipped defaults → .sle/rules/*.yaml → .sle/overrides/*.yaml`). Space Agent applies the same pattern to the *entire filesystem* — code, UI, skills, configs, everything. SLE could extend layered resolution to prompt templates, skill definitions, and agent configurations, allowing per-user or per-team overrides without modifying the daemon.

### 2.2 Agent Runtime

Two agent surfaces sharing the same prompt/execution protocol:

**Onscreen Agent** — Floating, draggable overlay. Compact (bubble) or Full (chat window) modes. Persistent position via `sessionStorage`, history via `~/hist/onscreen-agent.json`.

**Admin Agent** — Standalone chat at `/admin` for system management with custom instructions appended to system prompt.

**Execution protocol:** Agent emits `_____javascript` code blocks → runtime intercepts and executes in browser context → results fed back as `_____framework` messages → loop until text-only response.

### 2.3 Prompt Assembly Pipeline

Strict 5-layer ordering:

| Order | Component | Description |
|-------|-----------|-------------|
| 1 | **System Prompt** | "Firmware" instructions (`system-prompt.md`) + skill catalogs + `*.system.include.md` files |
| 2 | **Examples** | Few-shot user/assistant turns for behavioral steering |
| 3 | **Compacted History** | Summarized older turns (when token budget exceeded) |
| 4 | **Live History** | Recent conversation turns + execution outputs |
| 5 | **Transient Context** | Volatile runtime state (file trees, browser status) + `*.transient.include.md` files |

**Token budget:** `prompt_budget_ratios` splits `max_tokens` between system/history/transient sections. History compaction triggers when budget exceeded.

**Message markers:** `_____user` (human text), `_____framework` (code output), `_____transient` (mutable runtime context, not persisted).

### 2.4 Skill System

Skills defined as `SKILL.md` files under `ext/skills/` within any module. Two discovery mechanisms:

1. **DOM-based:** `<x-skill-context>` tags in the live DOM determine which skills are available. Tags are Alpine-bound to live state, so skill availability shifts dynamically as the user navigates.
2. **Filesystem scan:** `ext/skills/**/SKILL.md` enumerated through module resolver.

Three loading tiers:

| Tier | Mechanism | When |
|------|-----------|------|
| **Catalog** | Compact `skill-id\|name\|description` list | Always present in system prompt |
| **Auto-loaded** | Full body injected when `metadata.loaded: true` passes | Based on DOM context tags |
| **On-demand** | Agent calls `space.skills.load(path)` | When agent decides it needs the skill |

### 2.5 Prompt Includes

`*.include.md` files injected into the prompt at assembly time. Two types:

- **`*.system.include.md`** — appended as extra system-prompt sections. Stable, always-present.
- **`*.transient.include.md`** — rendered in the trailing transient message. Volatile, per-request.

**The memory system IS prompt includes:** The agent writes to `~/memory/behavior.system.include.md` (standing behavioral preferences) and `~/memory/memories.transient.include.md` (rolling notes). These are just prompt includes — the agent edits its own prompt over time.

### 2.6 Extension Seams

Three extension mechanisms:

1. **HTML Extensions** — `<x-extension id="seam/path">` declares injection points. HTML files at matching paths are loaded into those anchors. Batched via `/api/extensions_load`.
2. **JS Extension Hooks** — `space.extend(seam, callback)` registers Promise-returning functions at named seams.
3. **Component Loading** — `<x-component src="/mod/.../view.html">` dynamically loads and hydrates Alpine.js components.

### 2.7 Spaces and Widgets

**Space** = persistent canvas with camera-based infinite grid, hosting Widgets.
**Widget** = sandboxed UI unit defined by YAML manifest + JS renderer function.

File structure per space (`~/spaces/<spaceId>/`):
- `space.yaml` — manifest with `title`, `icon`, `agent_instructions`, `layout`
- `widgets/<id>.yaml` — widget definitions with `renderer` function source
- `data/` — widget-owned structured data
- `assets/` — static assets
- `scripts/` — shared JS modules

**Staged-turn mutation model:** Discovery and mutation are strictly separated across turns. Agent must `listWidgets → readWidget → seeWidget` (discovery) before `patchWidget` (mutation). After mutation, receives a transient feedback envelope.

**Two patch modes:**
- **Exact-snippet patch:** `[{ find, replace? }]` — locates exact unique snippet and replaces
- **Line edit:** `[{ from, to?, content? }]` — uses numbered lines from `readWidget()` output

### 2.8 Backend Server

Thin Node.js server. Key responsibilities:
- **Page shell delivery** — 5 HTML entry points with runtime config injected
- **Layered module resolution** — L2→L1→L0 for `/mod/...` requests
- **Authentication** — SCRAM-based challenge-response
- **API endpoints** — dynamically discovered from `server/api/` directory
- **Clustered state** — primary-worker model with monotonic `Space-State-Version`

**State versioning:** Every response includes `Space-State-Version`. Workers that fall behind return `503 RETRYABLE_STATE_SYNC_ERROR`, triggering automatic retry.

### 2.9 Git-Backed History

Writable layers (L1, L2) are local Git repositories:
- **Adaptive debounced commits:** Default 10s wait, tightening as changes age (5s at 1 min, 0s at 10 min)
- **Time Travel UI:** Browse commit history, preview diffs, rollback or revert
- **Two backends:** Native `git` binary preferred, falls back to `isomorphic-git` (pure JS)

---

## 3. Comparison with SLE/Stratum

| Concern | Space Agent | SLE/Stratum |
|---------|-------------|-------------|
| **Where intelligence runs** | Browser (frontend-first) | Daemon (server-side) |
| **Agent model** | Single agent, one context, skills extend capabilities | 10 specialized agents, DAG-orchestrated, scoped contexts |
| **Execution model** | Agent emits JS, runs in browser | Agent produces artifacts, daemon validates in Docker |
| **Validation** | None built-in — agent sees its own output and self-corrects | Dual-phase: LLM reasoning + executable tests + deterministic gates |
| **Configuration** | `params.yaml` + DOM-driven context | 7 YAML rule files + `map.yaml` |
| **State persistence** | Git-backed filesystem + clustered state | PostgreSQL + Redis + MinIO + Beads/Dolt |
| **History** | Git time travel on user data | Locked snapshots per cycle |
| **Extensibility** | L0/L1/L2 layers + extension seams + prompt includes | Rule files + provider interfaces |
| **Self-improvement** | Agent writes to own prompt includes | Not yet specified (gap) |
| **Multi-tenancy** | L1 (group) + L2 (user) filesystem isolation | Single project, single user (currently) |

**Key difference:** Space Agent is a general-purpose AI assistant that can build UI. SLE is a deterministic software lifecycle orchestrator. They solve different problems. But Space Agent's *mechanisms* — how it manages context, prompts, extensions, and state — are broadly applicable.

---

## 4. What to Borrow for SLE/Stratum

### 4.1 Prompt Includes (HIGH priority)

**What Space Agent does:** `*.system.include.md` and `*.transient.include.md` files inject into the prompt pipeline. The memory system is the agent writing to its own prompt includes.

**How SLE could use it:**

Each agent role gets a prompt-include directory:

```
.sle/prompts/planner/
  00-base.md              ← shipped default (immutable)
  10-project.md           ← project-specific (from discovery)
  20-behavioral.md        ← Evaluator-generated self-tuning
  90-override.md          ← human override
```

The context manager assembles the system prompt by reading these in order. Later files override earlier ones (same section headings = replace, different headings = additive).

**Self-improving loop:** After each cycle, the Evaluator's feedback can write to `20-behavioral.md`:

```markdown
## Planner behavioral notes (auto-generated)

- This project uses functional style — avoid class-based patterns
- Test plans should cover edge cases for null/undefined inputs (learned from cycle 3 failure)
- The auth module uses JWT, not sessions — plan accordingly
```

Human reviews at CONFIRM gate as always. The daemon never applies behavioral includes without human approval.

**Why this is better than Hermes's skill system for SLE:**
- No skill catalog, no discovery, no DOM tags — just files that get concatenated
- Integrates naturally with SLE's existing context manager
- Layered resolution matches existing rule file pattern
- Agent-generated includes go through human approval (unlike Hermes where agents modify freely)

### 4.2 Git-Backed Artifact History (HIGH priority)

**What Space Agent does:** Adaptive debounced commits (10s → 5s → 0s as changes age) with Time Travel UI for browsing, diffing, and rollback.

**How SLE could use it:**

SLE has locked snapshots per cycle but no continuous history *within* a cycle. Adding git-backed history to `.sle/artifacts/` would help when iterations go wrong:

- Each DAG node completion triggers a debounced commit
- Commit message includes role name, node type, and iteration number
- `stratum log` shows artifact history with diffs
- `stratum rollback --to <version>` restores a previous artifact state
- The Debugger can reference specific commits when diagnosing failures

**Adaptive debounce for SLE:**

| Time since last change | Commit delay |
|-----------------------|-------------|
| < 1 minute | 10s |
| 1–5 minutes | 5s |
| > 5 minutes | Immediate |

This captures meaningful changes without overwhelming the git history with intermediate states.

### 4.3 Transient Context Layer (MEDIUM priority)

**What Space Agent does:** `_____transient` marker — volatile state injected into the last message, never persisted to history. Current page state, file trees, browser status.

**How SLE could use it:**

The context manager already has artifact slices, but adding an explicit transient layer would reduce context bloat:

- Current daemon state (cycle ID, iteration, depth, active rules)
- Recent validation results (pass/fail summary, not full reports)
- Current file tree of relevant project directories
- Last error message (if any)

Transient context is assembled fresh every agent call, never cached, never persisted. It supplements the artifact slice with "right now" information that doesn't belong in the historical record.

**Implementation:** Add a `transient_context` field to the `AgentContext` type. Context manager populates it from current daemon state before each invocation. Not stored in `map.yaml` — truly ephemeral.

### 4.4 Layered Filesystem for All Agent Configuration (MEDIUM priority)

**What Space Agent does:** L0/L1/L2 applies to the entire filesystem — code, UI, skills, configs, everything.

**How SLE could use it:**

Currently only rule files have layered resolution. Extending this to all agent-facing configuration:

```
.sle/
  prompts/          ← system prompt templates per role
    L0/             ← shipped defaults (immutable, from @sle/sdk)
    L1/             ← project-level overrides (checked into repo)
    L2/             ← user-level overrides (gitignored)
  rules/            ← already layered (defaults → project → overrides)
  skills/           ← future: per-project agent skills
    L0/             ← shipped with daemon
    L1/             ← project-specific (e.g., "this project uses React")
    L2/             ← user-specific (e.g., "I prefer TDD with Jest")
```

Resolution: L2 → L1 → L0 for any file. The daemon never modifies L0. Agents may propose additions to L1 (human-approved). Humans directly edit L2.

### 4.5 Staged-Turn Mutation as Role Contract (LOW priority)

**What Space Agent does:** Discovery and mutation are strictly separate turns. Agent must read before writing.

**Relevance to SLE:** SLE's DAG already enforces this at a coarse level — DESIGN (read) produces artifacts that PLAN (read) consumes, then BUILD (write) produces implementation. But within a single DAG node, an agent could mix reads and writes. Making "discovery first, mutation second" an explicit contract per role would prevent agents from writing before they've fully understood the current state.

**Current SLE enforcement:** The DAG enforces node ordering. Context manager enforces input scoping. This is already sufficient — staged-turn mutation is more relevant for Space Agent's single-agent model where the agent chooses its own operations.

### 4.6 Self-Writing Memory via Prompt Includes (HIGH priority)

**What Space Agent does:** Agent writes to `~/memory/behavior.system.include.md` which gets injected into every future prompt. This is continuous self-prompt-tuning.

**How SLE could use it:**

Each project accumulates a `behavioral.md` prompt include:

- Evaluator writes behavioral observations after each cycle
- "This project's test suite is flaky on timing — add waits"
- "The database module requires transaction handling for all write operations"
- "The user prefers minimal dependencies — avoid adding new packages"

These get loaded into the Planner and Builder's system prompt as standing context. Unlike Space Agent (where the agent writes freely), SLE enforces human review:

1. Evaluator proposes behavioral notes in `evaluation.md`
2. Human reviews at CONFIRM gate or in `sle chat`
3. Approved notes merged into `behavioral.md`
4. Loaded in all subsequent cycles

This creates a **project-specific institutional memory** that improves with every cycle, without the overhead of a full knowledge engine.

---

## 5. What NOT to Borrow

| Concept | Why not |
|---------|---------|
| Frontend-first philosophy | SLE is daemon-first by design. The daemon owns the DAG, the gates, the state machine. Moving orchestration to the client would undermine determinism. |
| Browser-based `_____javascript` execution | SLE runs agents server-side with Docker isolation. Browser execution is a different security model entirely. |
| Alpine.js / `<x-component>` system | UI framework choice is irrelevant to SLE's core architecture. |
| Spaces / Widgets canvas | Different domain entirely. SLE's Web UI is a thin client over REST + WebSocket. |
| DOM-driven skill discovery | SLE has no DOM. The daemon assembles context server-side. Skill/context discovery must be filesystem-based. |
| Electron desktop packaging | Not applicable to SLE's deployment model (Docker container). |
| Clustered state with version fencing | SLE uses PostgreSQL + Redis for state management. Space Agent's filesystem-based approach is interesting but SLE already has a more robust solution. |

---

## 6. Summary: Priority Borrowing List

| Priority | Concept | Source in Space Agent | SLE Integration |
|----------|---------|----------------------|-----------------|
| **HIGH** | Prompt includes | `*.system.include.md` / `*.transient.include.md` | Per-role prompt directories with layered resolution, agent-generated behavioral notes |
| **HIGH** | Self-writing memory | Agent writes to `~/memory/behavior.system.include.md` | Evaluator proposes, human approves, loaded as standing context in future cycles |
| **HIGH** | Git-backed artifact history | Adaptive debounced commits with Time Travel | Per-node commits during cycles, rollback capability, Debugger references commits |
| **MEDIUM** | Transient context layer | `_____transient` volatile state | Ephemeral daemon state in every agent call, not persisted |
| **MEDIUM** | Layered filesystem for all config | L0/L1/L2 applied to everything | Extend layering from rule files to prompts, skills, and agent configs |
| **LOW** | Staged-turn mutation | Discovery and mutation as separate turns | Already enforced by DAG; minimal additional value |

**The single most valuable concept:** Prompt includes. It's simpler than Hermes's skill system (no catalog, no discovery — just files), more powerful for SLE's use case (integrates with context manager), and enables self-improving agent behavior through human-approved prompt modifications.

---

## 7. See also

| Document | Relationship |
|---|---|
| [hermes-stratum-integration.md](hermes-stratum-integration.md) | Hermes integration levels, including self-improving prompts concept |
| [stratum-comparative-analysis.md](stratum-comparative-analysis.md) | Hermes vs Stratum comparison, gaps, skills layer proposal |
| [hermes-agent-architecture.md](hermes-agent-architecture.md) | Hermes skill system (alternative approach to prompt includes) |
| [../overview/what-is-sle.md](../overview/what-is-sle.md) | SLE core concepts |
| [../overview/agent-roles.md](../overview/agent-roles.md) | All 10 agent roles with artifact ownership |
| [../overview/cycle-model.md](../overview/cycle-model.md) | DAG execution model |
