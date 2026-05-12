# SLE v2 — Spec Implementation Tracking

**Updated:** 2026-05-12
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
| 5 | `specs/daemon-api.md` | 🔶 Phase E | See Phase E spec for exact endpoint subset |
| 6 | `specs/daemon-api-endpoints.md` | 🔶 Phase E | 10 of 85 endpoints implemented (see Phase E) |
| 7 | `specs/init-and-discovery.md` | 🔶 Phase E | Simplified init (no Beads, no docs clone, no interactive prompts). Solo-mode discovery only |
| 8 | `specs/dag-execution.md` | 📝 | — |
| 9 | `specs/dag-node-reference.md` | 📝 | — |
| 10 | `specs/validation.md` | 📝 | — |
| 11 | `specs/context-manager.md` | 📝 | — |
| 12 | `specs/prompt-templates.md` | 📝 | — |
| 13 | `specs/conversation.md` | 📝 | — |
| 14 | `specs/intake-and-sharding.md` | 📝 | — |
| 15 | `specs/job-dispatch.md` | 📝 | — |
| 16 | `specs/beads-integration.md` | 📝 | — |
| 17 | `specs/document-linking.md` | 📝 | — |
| 18 | `specs/content-modules.md` | 📝 | — |
| 19 | `specs/knowledge-engine.md` | 📝 | — |
| 20 | `specs/run-artifacts.md` | 📝 | — |
| 21 | `specs/ui-shell.md` | 📝 | — |
| 22 | `specs/tasks-dashboard.md` | 📝 | — |
| 23 | `specs/project-overview.md` | 📝 | — |
| 24 | `specs/backlog-system.md` | 📝 | — |
| 25 | `specs/user-flow.md` | 📝 | — |
| 26 | `reference/error-codes.md` | 📝 | — |
| 27 | `reference/agents-yaml-schema.md` | 📝 | — |
| 28 | `reference/rule-file-defaults.md` | 📝 | — |
| 29 | `reference/artifact-registry.md` | 📝 | — |
| 30 | `reference/websocket-events.md` | 📝 | — |

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
| Discovery | ✅ | `POST /discovery/start`, `GET /discovery/status` |
| Cycles | 📝 | 0 of many |
| Sharding | 📝 | 0 |
| Tags | 📝 | 0 |
| Scoping | 📝 | 0 |
| Dispatch | 📝 | 0 |
| Artifacts | 📝 | 0 |
| Map & rules | 📝 | 0 |
| Reports | 📝 | 0 |
| Chat | 📝 | 0 |
| Context | 📝 | 0 |
| Tasks | 📝 | 0 |
| Intake & sharding | 📝 | 0 |
| Knowledge engine | 📝 | 0 |
| Content store | 📝 | 0 |
| Modules | 📝 | 0 |
| Document linking | 📝 | 0 |

**Total:** 10 of 85 endpoints implemented (~12%)

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
| Step 8 — Prompt templates | 📝 | Skipped |
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

## Future Phases Outline

| Phase | Focus | Specs implemented | Approx. endpoints |
|---|---|---|---|
| **E** | Daemon MVP | daemon-api.md (subset), init-and-discovery.md (subset) | 10 |
| **F** | Full API | daemon-api-endpoints.md (remaining 75) | 85 |
| **G** | WebSocket & Events | websocket-events.md, daemon-api.md (WS) | — |
| **H** | DAG Runner | dag-execution.md, dag-node-reference.md | — |
| **I** | Validation Gate | validation.md, prompt-templates.md | — |
| **J** | Context Manager | context-manager.md, reference/artifact-registry.md | — |
| **K** | Job Dispatch | job-dispatch.md, beads-integration.md | — |
| **L** | Intake & Knowledge | intake-and-sharding.md, knowledge-engine.md | — |
| **M** | UI Shell | ui-shell.md, tasks-dashboard.md, user-flow.md | — |