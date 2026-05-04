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

## 5. Agent output contracts and runtime environment (DDR-029, DDR-030)

**Design captured in:**
- `decisions/ddr-029-agent-output-contracts.md` — typed AgentOutput discriminated union, BuilderOutput declarative file operations, per-role output schemas
- `decisions/ddr-030-agent-runtime-environment.md` — agent runner, LLM provider interface, multi-turn read-request mechanism, per-role read permissions, two-phase safety gate + intelligent fulfillment

**Why deferred:** Both DDRs are architecturally sound but have 14 critical specification gaps that would require significant additional design work before implementation. The existing single-shot model (context manager assembles slice → single LLM call → write artifacts) is sufficient for MVP. Deferring lets us learn from real usage what agents actually need.

**MVP baseline:** `AgentResult.output: unknown` (types.md:244). The daemon calls the LLM, parses the response, writes artifacts. No typed output validation, no multi-turn read requests, no structured file operations.

### Critical gaps to resolve before implementation

| # | Gap | Source | Issue |
|---|-----|--------|-------|
| C1 | FailureReport naming collision | DDR-029 | `FailureReportRich` (Debugger output) doesn't replace gate's `FailureReport` (VALIDATION_GATE pointer). Both must coexist with distinct names. Need to rename to e.g. `DebuggerDiagnosis`. |
| C2 | Builder retry vs patch operations | DDR-029 | Spec says "regenerate from scratch on retry" but `PatchFile`/`SymbolReplace` are most useful on retry. Constraint must be relaxed for targeted category-specific fixes. |
| C3 | Artifact persistence mapping | DDR-029 | DDR changes agents from "write artifacts" to "return typed JSON" but never defines the mapping from output fields to artifact paths. DAG runner can't persist without it. |
| C4 | Validation only for Builder | DDR-029 | All roles return typed JSON but only BuilderOutput has Zod validation. Other roles have no parse-failure behavior. |
| C5 | Facilitator role identity | DDR-029 | `AgentRole` = `'facilitator'` but 3 templates/modes exist. Discriminated union can't dispatch on mode. Need either 3 role values or a mode field on AgentResult. |
| C6 | `LLMProvider` name collision | DDR-030 | types.md defines `LLMProvider` as string union. DDR-030 redefines as interface. Must rename one (e.g., `LLMProviderClient`). |
| C7 | "No conversation history" invariant | DDR-030 | Multi-turn builds a conversation array that objectively is conversation history. Must formally amend the invariant in context-manager.md to scope it to "no history from other DAG nodes or prior iterations." |
| C8 | No context window limit for accumulated turns | DDR-030 | 3,500-token initial cap + 100KB read limit + growing message array can blow past model context window with no guard. Need `total_context_token_limit`. |
| C9 | Parse routing ambiguity | DDR-030 | No reliable way to distinguish "read request" from "final output" — especially for prose roles with fragile `<read_request>` XML markers. Need top-level discriminator key or envelope. |
| C10 | Turn budget vs iteration/retry undefined | DDR-030 | Does turn budget reset per iteration? Global LLM-call cap? Does `agent_timeout` apply per-turn or per-invocation? All unspecified. |
| C11 | Read fulfillment failure modes | DDR-030 | File not found, symbol not found, binary files, symlink escape, encoding issues — none specified. Need typed `ReadResult` success/failure union. |
| C12 | TDD isolation bypass via Planner reads | DDR-030 | Planner can read implementation files via `symbol_lookup`, then embed implementation details in `test-plan.md`, which Tester reads. Indirect information leakage past context manager. Need artifact-aware safety gate. |
| C13 | Redundant `role` field in AgentOutput | DDR-029/030 | `AgentResult.role` already carries it. LLM must produce it again inside JSON, creating mismatch risk. Should remove from inner type. |
| C14 | Safety gate rejections unbounded | DDR-030 | Rejections don't count against turn budget → agent could loop forever on invalid requests. Need max consecutive rejections (e.g., 3). |

### Medium gaps to resolve (13 total)

- `AgentRoleConfig` not updated for read permissions / turn config
- No output-to-artifact mapping table
- `FileReadConfig` has no config-file home (which YAML file?)
- `dependency_check` assumes Node.js
- Forced output on max_turns may produce garbage — no quality/confidence flag
- No WebSocket events for intra-node multi-turn progress
- `partial_output` lifecycle undefined across turns
- `CritiqueResult` has two incompatible definitions across DDR-029 and dag-node-reference.md
- `agent_timeout` doesn't account for multi-turn (per-turn vs per-invocation)
- Prose `<read_request>` marker parsing fragile and underspecified
- LLM must choose between two output schemas at runtime (read request vs final output)
- `AgentResult.tokens_used` / `duration_ms` unclear if cumulative across turns
- Multiple concurrent read requests within a single turn unspecified

### Implementation items

| # | Item | Effort | Depends on |
|---|------|--------|------------|
| 5.1 | Resolve 14 critical gaps | Large | Design review |
| 5.2 | Update existing specs (context-manager, dag-execution, types.md, prompt-templates, dag-node-reference) | Large | 5.1 |
| 5.3 | Implement typed AgentOutput discriminated union + Zod validation | Medium | 5.2 |
| 5.4 | Implement BuilderOutput declarative file operations | Medium | 5.3 |
| 5.5 | Implement AgentRunner component + LLMProvider interface | Medium | 5.2 |
| 5.6 | Implement multi-turn read-request loop | Large | 5.5 |
| 5.7 | Implement two-phase safety gate + intelligent fulfillment | Large | 5.6 |
| 5.8 | Implement read-request-aware prompt templates | Medium | 5.6 |

---

## 6. Open questions from specs

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
