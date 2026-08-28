# SLE v2 — Spec Implementation Tracking

**Updated:** 2026-06-16
**Purpose:** Track which specs have been implemented, by which phase, and what remains.

---

## Legend

| Icon | Meaning |
|---|---|
| ✅ Fully implemented | All behaviors, types, endpoints in the spec are coded and tested |
| 🔶 Partially implemented | Only a defined subset is implemented (see phase reference) |
| 📝 Spec only | Written as a spec document, no implementation code exists |
| 🔲 Not started | No spec document exists yet |

---

## Implementation Status

| # | Spec | Status | Implemented in | What's covered |
|---|---|---|---|---|
| 1 | `reference/types.md` | ✅ Phase A | All types, Zod schemas, interfaces |
| 2 | `reference/map-yaml-schema.md` | ✅ Phase B | RuntimeMap schema, manager, YAML I/O |
| 3 | `specs/state-machine.md` | ✅ Phase C | 5 states, 12 transitions, guards, flags, confirm gate |
| 4 | `specs/rule-files.md` | ✅ Phase D | All 7 rule file schemas, validation, defaults |
| 5 | `specs/daemon-api.md` | 🔶 VS4 | Aligned REST API payload validation and response envelopes |
| 6 | `specs/daemon-api-endpoints.md` | 🔶 VS4 | Added validation status, run details, reindexing, and manual link endpoints |
| 7 | `specs/init-and-discovery.md` | 🔶 Phase E | Simplified init (no Beads, no docs clone, no interactive prompts). Solo-mode discovery only |
| 8 | `specs/dag-execution.md` | 📝 | — |
| 9 | `specs/dag-node-reference.md` | 📝 | — |
| 10 | `specs/validation.md` | ✅ VS4 | Tri-phase execution, category caching, deterministic gate manifest |
| 11 | `specs/context-manager.md` | ✅ VS5 | Strict 5-component context assembly under a hard 3,500 token ceiling; declared context mode added in VS5 |
| 12 | `specs/prompt-templates.md` | 📝 | — |
| 13 | `specs/conversation.md` | 🔶 VS5 | Facilitator chat with session persistence, mode switching (chat/scoping/decision), action pattern detection |
| 14 | `specs/intake-and-sharding.md` | ✅ VS5 | Document intake pipeline, 5-layer coherence gate, task sharding with SHARDING_APPROVAL gate |
| 15 | `specs/job-dispatch.md` | ✅ VS4 | DockerWorkerPool sandboxed execution with native fallback, 7-step extraction |
| 16 | `specs/beads-integration.md` | 📝 | — |
| 17 | `specs/document-linking.md` | ✅ VS4 | Persistent wikilink parser, memory backlink indexing, and query APIs |
| 18 | `specs/content-modules.md` | 📝 | — |
| 19 | `specs/knowledge-engine.md` | 📝 | — |
| 20 | `specs/run-artifacts.md` | 📝 | — |
| 21 | `specs/ui-shell.md` | ✅ VS6 | 3-page SPA (Overview, Chat, Graph), auto-reconnecting WebSocket client, gate overlays |
| 22 | `specs/tasks-dashboard.md` | 🔶 VS6 | Tasks panel and sharding review panel in Overview page; full task management UI deferred |
| 23 | `specs/project-overview.md` | 🔶 VS6 | Overview page with 6 panels (Actions Required, Active Jobs, Tasks, Sharding Review, Activity, Documents) |
| 24 | `specs/backlog-system.md` | 📝 | — |
| 25 | `specs/user-flow.md` | 🔶 VS6 | Core navigation flows, init wizard, and facilitator conversation implemented |
| 26 | `reference/error-codes.md` | 📝 | — |
| 27 | `reference/agents-yaml-schema.md` | 📝 | — |
| 28 | `reference/rule-file-defaults.md` | 📝 | — |
| 29 | `reference/artifact-registry.md` | 📝 | — |
| 30 | `reference/websocket-events.md` | 🔶 VS5 | Event bus broadcasting 62+ event types; reference doc not yet written |

---

## Phase Coverage Details

### Phase E — Daemon MVP

Implements a **subset** of 3 source specs:

#### From `specs/daemon-api.md`

| Section | Status | Notes |
|---|---|---|
| Data model — DaemonInfo | ✅ | Extended with uptime_ms at runtime |
| Data model — Request envelope | ✅ | APIResponse/APIError implemented |
| Behavior — Startup sequence (steps 1-3) | ✅ | CLI parse, map.yaml load, rule validation |
| Behavior — Startup sequence (steps 4-13) | 🔲 | agent.md check, Beads, docs remote, crash recovery, WebSocket |
| Behavior — Request lifecycle | 📝 | Not implemented (no state-changing commands beyond init/discovery) |
| Behavior — Error propagation | ✅ | Basic 400/404/500 error handling |
| API endpoints | 🔶 | See daemon-api-endpoints coverage below |
| WebSocket events | 📝 | Not implemented |
| Constraints | ✅ | 1 (single port), 6 (state machine authority), 12 (no auth) implemented |
| Open questions | 📝 | Not addressed |

#### From `specs/daemon-api-endpoints.md`

| Endpoint group | Status | Endpoints implemented |
|---|---|---|
| Health & info | ✅ | `GET /health`, `GET /info` |
| System state | ✅ | `GET /system/state`, `POST /system/state/transition`, `GET /system/flags`, `PATCH /system/flags` |
| Init | ✅ | `POST /init`, `GET /init/state` |
| Discovery | ✅ | `POST /discovery/start`, `POST /discovery/round/{n}/response`, `POST /discovery/round/{n}/approve`, `GET /discovery/status` |
| Cycles | ✅ | `POST /cycles/start`, `GET /cycles/current`, `GET /cycles/current/dag`, `GET /cycles/current/run`, `POST /cycles/halt`, `POST /cycles/acknowledge-halt`, `POST /cycles/resume`, `GET /cycles/scoping/draft`, `POST /cycles/scoping/response`, `POST /cycles/scoping/approve`, `POST /cycles/current/approve`, `POST /cycles/current/revise`, `POST /cycles/confirm`, `GET /cycles/{id}/validation`, `GET /cycles/{id}/runs/{runId}`, `GET /cycles/{id}/runs/{runId}/files/{path}`, `POST /cycles/{id}/validation/rerun` |
| Sharding | 📝 | 0 |
| Tags | 📝 | 0 |
| Scoping | 📝 | 0 |
| Dispatch | 📝 | 0 |
| Artifacts | 📝 | 0 |
| Map & rules | 📝 | 0 |
| Reports | 📝 | 0 |
| Chat | ✅ | `POST /chat/session/open`, `DELETE /chat/session`, `POST /chat/message` |
| Context | 📝 | 0 |
| Tasks | 📝 | 0 |
| Intake & sharding | ✅ | `GET /intake/documents`, `GET /intake/taskstore` |
| Knowledge engine | 📝 | 0 |
| Content store | 📝 | 0 |
| Modules | 📝 | 0 |
| Document linking | ✅ | `GET /links`, `GET /links/backlinks`, `POST /links`, `DELETE /links/{id}`, `POST /links/reindex`, `GET /links/files/{path}` |
| Settings | ✅ | `GET /settings`, `POST /settings` |

**Total:** ~41 of 85 endpoints implemented (~48%)

#### From `specs/init-and-discovery.md`

| Section | Status | Notes |
|---|---|---|
| InitState data model | ✅ | Implemented |
| DiscoveryState data model | ✅ | Implemented |
| DiscoverySessionState | ✅ | Implemented |
| OpenQuestion | 📝 | Not needed for MVP |
| Step 0 — Prerequisite check | ✅ | Git repo, Node 20+, .sle/ absent |
| Step 1 — Identity | ✅ | Project name |
| Step 2 — Type selection | ✅ | Project type |
| Step 3a-3c — Remotes | 🔶 | Simplified (code remote only, no Beads/docs) |
| Step 4 — Rule file generation | ✅ | Via RuleLoader |
| Step 5 — TaskStore init | 🔶 | Local only (YAML file) |
| Step 6 — Docs clone | 📝 | Skipped |
| Step 7 — agent.md + map.yaml | ✅ | Basic templates |
| Step 8 — Prompt templates | ✅ | 3 facilitator templates installed (chat, decision, scoping) |
| Step 9 — Commit | 📝 | Skipped |
| Step 10 — Daemon start | 📝 | Manual (`sle start` separate) |
| Resume behaviour | ✅ | init-state.json tracking |
| Reset | ✅ | Directory cleanup |
| Non-interactive mode | ✅ | CLI flags |
| Discovery full mode (4 rounds) | 📝 | Not implemented |
| Discovery solo mode (2 rounds) | ✅ | 1 round simplified |
| Round protocol | 📝 | Minimal echo-back draft |
| Synthesis | 📝 | Not implemented |
| Planning loop | 📝 | Not implemented |
| Finalization | 📝 | Not implemented |

---

### VS5 — Intake, Critic Agent & WebSocket Events

#### Critic Agent (`src/critic-agent.ts`)

| Feature | Status | Notes |
|---|---|---|
| LLM-backed design critique | ✅ | Runs at `deep`/`research` planning depth |
| Structured `CritiqueResult` output | ✅ | Blocking issues, warnings, suggestions |
| Revision feedback loop | ✅ | Multi-turn critic/revise cycle |

#### Document Intake Pipeline (`src/intake-service.ts`)

| Feature | Status | Notes |
|---|---|---|
| Parse `.sle/project-docs/` | ✅ | Sections with token counts |
| Layer 1 — cross-ref integrity | ✅ | |
| Layer 2 — terminology consistency | ✅ | |
| Layer 3 — contradiction detection | ✅ | |
| Layer 4 — completeness check | ✅ | |
| Layer 5 — dangling refs | ✅ | |
| `GET /intake/documents` | ✅ | |
| `GET /intake/taskstore` | ✅ | |

#### Task Sharding (`src/sharding-service.ts`)

| Feature | Status | Notes |
|---|---|---|
| Collaborative task decomposition | ✅ | |
| Layer 2 coherence validation | ✅ | |
| `SHARDING_APPROVAL` DAG gate | ✅ | Human approval required before tasks are committed |
| `TaskContextDeclaration` support | ✅ | Declared context slices in context manager |

#### WebSocket Event Bus (`src/event-bus.ts`)

| Feature | Status | Notes |
|---|---|---|
| Real-time broadcast to UI clients | ✅ | |
| 62+ event types | ✅ | System, DAG, validation, gates, chat, artifacts, intake/sharding, linking |
| Auto-reconnect on client side | ✅ | Implemented in UI shell |

#### Chat Service (`src/chat-service.ts`)

| Feature | Status | Notes |
|---|---|---|
| Session persistence | ✅ | `.sle/chat-history.jsonl` |
| Mode switching (chat/scoping/decision) | ✅ | |
| Action pattern detection | ✅ | |
| `POST /chat/session/open` | ✅ | |
| `DELETE /chat/session` | ✅ | |
| `POST /chat/message` | ✅ | |

---

### VS6 — Web Dashboard UI Shell

| Feature | Status | Notes |
|---|---|---|
| 3-page SPA (Overview, Chat, Graph) | ✅ | Hash-based routing |
| Auto-reconnecting WebSocket client | ✅ | |
| Overview page — 6 panels | ✅ | Actions Required, Active Jobs, Tasks, Sharding Review, Recent Activity, Documents |
| Chat page — Facilitator conversation | ✅ | Persistent across cycle state; mode switching |
| Graph page — force-directed artifact graph | ✅ | Color-coded node/edge types from link index |
| Gate overlay — CONFIRM | ✅ | |
| Gate overlay — SHARDING_APPROVAL | ✅ | |
| Gate overlay — Scoping | ✅ | |
| In-browser project initialization wizard | ✅ | |
| Settings page | ✅ | LLM provider hot-reloading |
| `stratum` CLI binary | ✅ | Foreground daemon with browser auto-open |

---

## Future Phases Outline

| Group / Slice | Covers Phase(s) / Features | Focus | Specs implemented | Approx. endpoints | Status |
|---|---|---|---|---|---|
| **Daemon MVP** | VS1 A–H, J–K | Init + discover + daemon shell | daemon-api.md (subset), init-and-discovery.md (subset) | 10 | ✅ |
| **Facilitator** | VS1 I | Facilitator LLM integration | prompt-templates.md, conversation.md | — | ✅ |
| **Integration** | VS1 L | End-to-end integration test | — | — | ✅ |
| **VS2 — Working Cycle** | VS2 | Complete cycle: SCOPING to SNAPSHOT | dag-execution.md (core), validation.md (basic), context-manager.md (basic) | — | ✅ |
| **VS3 — Hardened Execution** | VS3 | Real LLM, multi-turn, subprocess EXEC, Debugger & recovery | prompt-templates.md (caching), conversation.md (multi-turn), run-artifacts.md | — | ✅ |
| **VS4 — Hardened Infrastructure & APIs** | VS4 | Docker execution, persistent document linking, context token budgeting, and REST endpoints | job-dispatch.md, validation.md, document-linking.md, context-manager.md | 20 | ✅ |
| **Intake & Knowledge (VS5)** | VS5 | Intake, sharding, WS events, critic agent, chat service | intake-and-sharding.md, conversation.md, websocket-events.md (partial) | 5 | ✅ |
| **UI Shell Dashboard (VS6)** | VS6 | Dashboard SPA, Overview/Chat/Graph pages, gate overlays | ui-shell.md, project-overview.md, tasks-dashboard.md (partial), user-flow.md (partial) | 0 new REST | ✅ |