# SLE v2 — Spec Implementation Tracking

**Updated:** 2026-09-21
**Purpose:** Track which specs have been implemented, by which phase, and what remains.

> **Current work pointer (2026-09-21):** the supervised-pilot series on
> magtheo/student-platform#108 has run A2–A8 under the Era II roadmap
> ([post-d34-roadmap.md](post-d34-roadmap.md), current through the "close the
> first real single-task pilot" gate). Authoritative per-pilot history lives in
> [docs/pilots/](../pilots/) and the merged PRs; summary:
> **A2** transport death (`UND_ERR_HEADERS_TIMEOUT`, turn 16) → PR #25
> instrumentation + bounded retry (PR #26); **A3** first live `submit_result`,
> one contract-vocabulary defect, repair exhausted → teaching clarified (PR #28);
> Coding Plan provider removed, route moved to OpenRouter (PR #27); **A4**
> 24-turn exploration exhaustion (38 unique reads, no repeats); **A5**
> completion-budget death (`stop_reason=max_tokens`, turn 19, 16,384) → PR #29;
> **A6** (PR #30): step-scoped `define-work/synthesize-definition` budget
> 32,768 — first successful synthesis, first accepted submission, first
> materialized canonical Definition with D.1 provenance, then the map-sync
> seed defect → corrected driver (PR #31); **A7**: define-work completed
> end-to-end and DDR-041 `gate_b_resolved` on a real Definition, then the
> context-ceiling mismatch → **PR #32 (E17 two-lane context invariant +
> dependency surface)**; **A8** (PR #33): **H1 CROSSED** — clean autonomous
> define-work (`wi_completed_by_driver`, zero intervention), Gate B PASS
> (4,213 tokens incl. verbatim Definition at ceiling 4,000 via the reserved
> lane), real full-build `scoping.produce` model execution produced a
> 12,426-byte charter, then died at the scoping publication seam
> (undeclared output artifact + untruthful `artifacts_written` + charter
> grammar mismatch) → **PR #34 (E19 scoping publication contract)**:
> declared `cycle-charter` output, fail-closed `begin()` before any
> approval state, exact charter grammar taught, zero-model qualification
> (6 tests) proving the A8 shapes fail closed and the canonical charter
> flows materialize → validate → approve. Stratum `main`: `37c3acd`.
> **Next:** A9 preregistration ([pilot-a9.md](../pilots/pilot-a9.md)) —
> clean frozen rerun of the H1 transition (driver `d9d699c2…`, zero
> operator repairs), then deeper into full-build; if BUILD executes, the
> pivot criterion is reached and H2 (implementation quality) evaluation
> begins. Per-run evidence lives in `~/Documents/repos/pilot-a/evidence/`,
> not this repo. The phase table below is historical.
>
> ---
>
> **Work pointer (2026-09-18) — HISTORICAL:** the D.3 line postdates the phase table below
> (see `docs/developmentPlan/d3a…d3d*` history); **D.34 (DDR-034 output contracts,
> C1–C7) is DONE and FROZEN** at baseline SHA `8263665` (PR #9). The active execution
> plan is the Era II plan
> [post-d34-roadmap.md](post-d34-roadmap.md) (E0–E10: qualification → Pilot A →
> evidence-driven hardening → multi-task pilot), under decision
> [DDR-035](../decisions/ddr-035-post-d34-operational-pivot.md). E0 (freeze) and E1
> (environment) are DONE: under the supported runtime (Node v22.23.2, per the
> `node >=22` baseline requirement) the suite is fully green — 1561 pass / 0 fail.
>
> **Qualification (E2–E4) status:** instrument hardening landed across successive
> series — DDR-036/037/038 (escalation ownership, harness seams; PRs #13–#15 →
> `d2c4856`/`387f4e8`/`d38a1cf`), DDR-039 oracle identity join (PR #18 → `325f453`),
> DDR-040 decision creation-time identity propagation (PR #19, MERGED → `7b2d1ce`;
> root fix: the ResumeService creation path now binds `targetFactId` like the
> scheduler — E4-G inv 4's UNLINKED halt was a system lifecycle defect, not model
> omission). Series
> scores: E4-E (GLM-5.3 full) adjudicated 11/15; E4-F void-incomplete (6 valid runs
> preserved, uncounted); **E4-G (GLM-5.3-Flash, 16K, OpenRouter) raw 13/15 — best
> raw score of any candidate — adjudicated 14/15** (~$0.13/series; flash's only
> clean miss is a terminal `submit_result` lapse). Per-run evidence lives in the
> experiment clones (`~/Documents/repos/E4-*`), not this repo.
>
> **Era-II baseline is now `main`** (merge of PR #21, SHA `88c1d02`); the
> long-lived `claude/what-do-you-think-446nbb` branch is RETIRED — new work
> branches from `main`.
>
> **E4-H — the frozen FINAL qualification series — RUN and CLOSED**
> (GLM-5.3-Flash, OpenRouter `z-ai/glm-5.3-flash`, 16K, 0.7, on main
> `88c1d02`; clone `~/Documents/repos/E4-H`). **Verdict: NOT QUALIFIED for
> unattended define-work** (15/15 rule). 9 valid runs: 6 PASS / 3 FAIL —
> EARLY 1/3, PARTIAL 2/3, MATURE 3/3; with 3 valid FAILs the maximum was
> 12/15, so the verdict is mathematically determined by valid runs alone.
> All 3 FAILs are ordinary model variance: a repeat of the terminal
> `submit_result` lapse (same class as E4-G inv 5), a duplicated
> cross-platform fact that the DDR-039 identity join correctly fail-closed
> on, and a Decision raised in PARTIAL where the scenario contract expects
> none (scripted policy halts by pre-registered design). 4 further
> invocations were interrupted by an external OpenRouter degradation window
> (long generations ≥ ~2K tokens stalled; short completions fine; status
> page 503) — recorded, UNCOUNTED per the frozen interruption policy, never
> classified as model failures; the 6-run tail cannot change the verdict and
> may optionally be completed for the record once the route recovers. No
> deterministic Stratum/instrument defect was observed in any valid run.
>
> **Qualification phase: CLOSED** — no E4-I, no tuning to chase 15/15.
> Flash proceeds under the supervised/pilot posture. **Next: Pilot A
> preregistration** (E5, fresh branch from main): `docs/pilots/pilot-a.md`,
> likely target magtheo/student-platform#108 (re-verify issue still
> open/same defect before freezing). Per-run evidence lives in the
> experiment clones (`~/Documents/repos/E4-*`), not this repo. The phase
> table below is historical as of 2026-06-16 and has not been
> comprehensively modernized.

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