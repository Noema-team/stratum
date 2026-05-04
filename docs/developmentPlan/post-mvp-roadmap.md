# Post-MVP Roadmap

**Status:** planning · **Updated:** 2026-05-04
**Prerequisite:** SLE v2 doc suite complete (82/82 docs, Phases 0–7)

Items deferred from the MVP documentation suite. Each has a design rationale captured
in the existing spec/decision docs — this file tracks what remains to be implemented
or specified.

---

## 1. Content gaps (from Round 1 review)

### A2 — CLI command reference [MEDIUM]

| Field | Value |
|-------|-------|
| **Target** | `v2/specs/cli-reference.md` (new) |
| **Source** | SLE-005 |
| **Description** | Full `sle` CLI docs with all subcommands and flags |
| **Scope** | Every CLI command: `sle init`, `sle discover`, `sle start`, `sle halt`, `sle status`, `sle chat`, plus all flags (`--scope`, `--bump`, `--depth`, `--force`, `--category-hints`) |

### A3 — Obsidian plugin spec [MEDIUM]

| Field | Value |
|-------|-------|
| **Target** | `v2/specs/obsidian-plugin.md` (new) |
| **Source** | SLE-005 |
| **Description** | Plugin architecture, data bridge, sync behavior |
| **Scope** | How Obsidian connects to the SLE daemon, reads/writes artifacts, renders graph, integrates with chat |

### A7 — Infrastructure/deployment setup [LOW]

| Field | Value |
|-------|-------|
| **Target** | `v2/specs/knowledge-engine.md` update or new deployment appendix |
| **Source** | SLE-014 |
| **Description** | Deployment guide or appendix covering hosting and infrastructure |
| **Scope** | How to deploy SLE (self-hosted, Docker, CI/CD integration), how versioning ties into deployment pipelines via the `deployable` flag on VersionSnapshot |

---

## 2. Project versioning (DDR-028 SC-014)

**Design captured in:** `decisions/ddr-028-cycle-scoping-redesign.md` §Project versioning

The data model is already in the specs (types.md, dag-node-reference.md). Implementation
is deferred.

### Implementation items

| # | Item | Spec reference | Effort |
|---|------|----------------|--------|
| 2.1 | Semver bump inference from charter scope/purpose | `dag-node-reference.md` SCOPING node | Medium |
| 2.2 | User override of version_bump at cycle start | `daemon-api-endpoints.md` POST /cycles | Small |
| 2.3 | `version_produced` field on ArtifactEntry (populate on SNAPSHOT) | `types.md` ArtifactEntry | Small |
| 2.4 | `last_modified_version` on graph nodes | `project-overview.md` LayerNode | Small |
| 2.5 | `changed_nodes[]` in history entries | `types.md` CycleExecutionSummary | Small |
| 2.6 | `CycleExecutionSummary` generation in SNAPSHOT node | `dag-node-reference.md` SNAPSHOT | Medium |
| 2.7 | `deployable` flag on VersionSnapshot | `dag-node-reference.md` VersionSnapshot | Small |
| 2.8 | Cumulative CHANGELOG.md generation | `dag-node-reference.md` SNAPSHOT | Small |
| 2.9 | Version-aware artifact diff API (beyond existing endpoint) | `daemon-api-endpoints.md` | Medium |

### Post-implementation features

- **Context prioritization by version age** — Facilitator surfaces "node not touched in 10+ versions" notes
- **Version-aware hosting** — post-snapshot hooks gate on `deployable` flag to trigger CI/CD
- **Graph navigation by version** — "show me what changed in v1.4"

---

## 3. DDR-028 explicitly deferred items

### Split Chat + Graph view

Allow showing Chat and Graph simultaneously so the user can discuss scope while
seeing/interacting with the graph. The UI shell design should not prevent this layout.

**Status:** Deferred in DDR-028 (SC-004). No spec changes needed yet — `ui-shell.md`
already uses a flexible panel model.

### Facilitator node creation

Allow the Facilitator to create graph nodes (not just scoping artifacts). Currently
the Facilitator can only produce `doc:cycle-scope-draft` and `doc:cycle-charter`.

**Status:** Deferred in DDR-028 (SC-010). Requires updating `conversation.md` constraint 2
and `project-overview.md` graph interactions.

### Seamless scoping mode auto-detection

MVP uses an explicit toggle for FacilitatorMode 'scoping'. Post-MVP: seamless
auto-detection based on context (user just started a cycle, SCOPING node is active).

**Status:** Resolved in DDR-028 (SC-012). MVP toggle is in `conversation.md`.

---

## 4. Other deferred items from DDRs

| Item | Source | Description |
|------|--------|-------------|
| Auth strategy | DDR-006 | Security model for multi-user scenarios. Currently stubbed in `decisions/ddr-006-security-deferred.md`. |
| Backlog system | `specs/backlog-system.md` | Backlog extraction, auto-grouping, promotion — full spec exists but implementation is post-MVP. |
| Knowledge engine integration | `specs/knowledge-engine.md` | Cognee integration, vector search — full spec exists, implementation is post-MVP. |
| Content modules | `specs/content-modules.md` | Node content store, layer module system, triggers — full spec exists, implementation is post-MVP. |

---

## 5. Open questions from specs

These are tracked in individual specs' `## Open questions` sections. Not all are
post-MVP — some may be resolved during implementation. The full list is in each spec.

Key open questions worth tracking:

| ID | Spec | Question | Impact |
|----|------|----------|--------|
| DAG-006 | dag-execution.md | Should DAG history be persisted across daemon restarts? | Resolved by CycleExecutionSummary (SC-014 D4) but storage format still open |
| DL-001 | document-linking.md | Should the link index support link versioning across cycles? | Graph evolution tracking |
| PO-010 | project-overview.md | Should the graph support undo/redo for user actions? | UX |
| UI-012 | ui-shell.md | Should the UI support theme customization? | UX |
| CONV-008 | conversation.md | Should chat history be exportable in standard formats? | Data portability |
