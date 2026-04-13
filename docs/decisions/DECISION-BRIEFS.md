# Decision Briefs — DDR-019 through DDR-026

**Purpose:** Prepare for a human decision session on 8 blocking architectural decisions.

**Source material:** `gaps/open-questions.md`, SLE-024, SLE-002, SLE-001, SLE-019, SLE-005, SLE-007

**Session order:** Decisions are ordered so that earlier decisions unblock later ones.
G20/G21 (state machine) should be decided together. G11 (artifact ownership) unblocks
G7 (DAG rewrite) and G8 (context manager slices).

---

## DDR-020 — Is chat a system state or orthogonal to state?

**Gap:** G20, G13

**Question:** Should `chatting` be removed from the SLE-024 state machine and modelled as an orthogonal session independent of system state?

### Background

SLE-024 §2 opens with "The system is always in exactly one state. States are mutually exclusive," but its own notes state "chatting and cycling can overlap. Chat is always available; it never blocks or interrupts a running cycle." These directly contradict — if chatting and cycling can coexist, states are not mutually exclusive and the state machine as drawn cannot be implemented.

Meanwhile, SLE-012 states "Conversation mode is always available, regardless of system state" and lists `idle` as a chat-available state but does not list `discovering`, creating a separate contradiction (G13) about whether chat is available during discovery.

### Options

| # | Option | Description |
|---|--------|-------------|
| A | Remove `chatting` from state machine; model chat as orthogonal session | `chatting` is removed from the top-level state machine. System state tracks only cycle/discovery progress: `idle \| discovering \| cycling \| confirming \| halted \| complete`. Chat session is modelled independently (`open \| closed`) and is available regardless of system state. `map.yaml` uses a `chat.session_open: boolean` field instead of a status value. |
| B | Keep `chatting` as a state; make states non-exclusive | `chatting` remains in the state machine. The "mutually exclusive" invariant is relaxed to allow concurrent states. Code reading `meta.status` must handle compound states (e.g. `chatting+cycling`). |

### Tradeoffs

- **Option A:** Resolves both G20 and G13 in one decision. Produces a clean, implementable state machine. The Facilitator can be active during any system state. Requires updating `map.yaml` schema, SLE-024 §2 diagram and table, and any daemon logic that branches on `chatting`. But it is a breaking change to the state model that all consumers must adopt.
- **Option B:** Preserves the current SLE-024 diagram structure. But "mutually exclusive" is a core invariant — relaxing it makes the state machine ambiguous and harder to reason about. Every `switch` on `meta.status` now needs compound-state handling. Does not resolve G13 (chat during discovery still needs a separate decision).

### Recommendation

Option A. The gap analysis explicitly recommends this: "Chat should not be a system state." Removing `chatting` from the state machine produces a clean, implementable model and resolves G13 as a side effect. The alternative requires pervasive compound-state handling throughout the daemon.

### Downstream impact

- SLE-024 §2 (state machine diagram and table)
- SLE-001 (SystemStatus type)
- map-yaml-schema.md (`meta.status` values)
- SLE-010 (error codes referencing `chatting`)
- G9, G13, G18 (all depend on the state model being final)

---

## DDR-021 — Is `confirming` a top-level state or a sub-state of `cycling`?

**Gap:** G21

**Question:** Should `confirming` be a top-level system state or expressed as a sub-state/flag on the cycle record?

### Background

SLE-024 §2 says in its notes: "`confirming` is a sub-state, not a full system state — the cycle is still 'running' from the daemon's perspective, just paused." But the state diagram draws `confirming` as a peer node of `idle`, `cycling`, and `halted`, and the state table lists it alongside those states with its own description row. Any code that reads `map.yaml → meta.status` and branches on `confirming` will have different behaviour depending on whether the implementation treats it as a peer state or a sub-state.

### Options

| # | Option | Description |
|---|--------|-------------|
| A | Sub-state expressed as a boolean flag on the cycle record | `meta.status` remains `cycling`. A new field `cycle.awaiting_confirmation: boolean` (or `cycle.paused_at_gate: string`) indicates the pause. The top-level state machine has one fewer state, and all "is the system paused?" checks read the cycle flag. |
| B | Top-level peer state | `confirming` stays in the state machine as drawn in SLE-024. `meta.status` takes the value `confirming`. Code branches on this value directly. SLE-024 §2 notes are corrected to remove the "sub-state" language. |

### Tradeoffs

- **Option A:** Cleaner separation of concerns — system state answers "what is the system doing?" (cycling) and cycle state answers "where in the cycle are we?" (paused at gate). Crash recovery is simpler: on restart, `meta.status: cycling` + `cycle.awaiting_confirmation: true` unambiguously describes the state. Aligns with the gap analysis recommendation. Requires adding a field to `map.yaml → cycle`.
- **Option B:** Matches the current diagram. Simpler for code that only reads `meta.status` — no need to check two fields. But it makes the state machine larger and the "mutually exclusive" claim harder to maintain (especially if DDR-020 Option A is chosen, which removes `chatting` but keeps `confirming` as a peer).

### Recommendation

Option A. The gap analysis recommends making `confirming` a sub-state expressed as a flag on the cycle record. This produces a smaller state machine, cleaner crash recovery semantics, and avoids the ambiguity that the current dual representation creates. Coordinate with DDR-020 since both are edits to SLE-024 §2.

### Downstream impact

- SLE-024 §2 (state diagram and table)
- map-yaml-schema.md (new `cycle.awaiting_confirmation` field)
- SLE-001 (SystemStatus type — `confirming` removed)
- SLE-010 (error codes referencing `confirming`)
- G9, G18 (SystemStatus and CycleOutcome type updates)

---

## DDR-019 — Who owns `requirements.md` — Designer or Planner?

**Gap:** G11

**Question:** Does the Designer produce `requirements.md`, or does the Planner produce it based on the Designer's architecture?

### Background

SLE-024 splits the old Planner role into Designer (system shape, architecture) and Planner (specific implementation steps, test-plan). But the artifact ownership line between them is not drawn. `requirements.md` — currently owned by the Planner (SLE-002) — sits between the two new roles. If the Designer produces requirements, the Planner's artifact slice changes (it no longer writes requirements, just reads them). If the Planner still produces requirements, the Designer's output feeds into the Planner rather than producing a named artifact. SLE-024 §7.2 currently writes `docs/requirements.md` as "Designer → Planner", implying a handoff, but this is ambiguous.

### Options

| # | Option | Description |
|---|--------|-------------|
| A | Designer owns `requirements.md` | The Designer produces `requirements.md` alongside `architecture.md`. The Planner reads both as inputs and produces `test-plan.md` and step-level plans. The Designer's artifact slice needs discovery docs + intent + prior evaluation. The Planner's artifact slice drops `requirements` as a write target. |
| B | Planner owns `requirements.md` | The Planner continues to produce `requirements.md` as it does today (SLE-002 Node 3). The Designer produces only `architecture.md`. The Planner reads the Designer's architecture and derives requirements from it plus the intent. The Designer's artifact slice is narrower (no requirement-writing responsibility). |

### Tradeoffs

- **Option A:** Aligns with SLE-024 §7.2 notation ("Designer → Planner" for requirements). Requirements become a design-phase artifact, produced once before step-level planning. The Planner's job narrows to "given requirements and architecture, produce steps and tests." But it means the Designer needs a broader context window (intent + discovery docs + evaluation history) and the requirements may need revision if the Planner discovers implementation constraints during planning.
- **Option B:** Maintains backward compatibility with SLE-002's current node definition. The Planner already produces requirements today; changing ownership is a larger refactor. But it means the Planner still has a dual responsibility (requirements + step planning) that SLE-024's role split was meant to resolve. The Designer's output is less clearly defined — it produces architecture but the "why" (requirements) lives elsewhere.

### Recommendation

Option A. The SLE-024 role split was motivated by separating architectural thinking from step-level planning. Requirements are an architectural concern (what to build, not how), and the Designer is the architectural role. This also simplifies the Planner's artifact slice and makes the Designer → Planner handoff explicit: the Designer produces the "what" and "shape"; the Planner produces the "how" and "test plan." The gap analysis flags this as blocking G7 and G8, which should proceed after this decision.

### Downstream impact

- SLE-002 (node definitions — Designer and Planner nodes)
- SLE-007 (artifact slice assignments for Designer and Planner)
- SLE-024 §7.2 (artifact table)
- G7 (DAG rewrite), G8 (context manager slices for new roles)

---

## DDR-022 — Critic reviews at DESIGN node or PLAN node?

**Gap:** G16

**Question:** Should the Critic review the Designer's architecture output (at the DESIGN node) or the Planner's step-level plan (at the PLAN node)?

### Background

In SLE-001 and SLE-002, the Critic runs between Planner passes — post-PLAN, reviewing the plan (including requirements and architecture) before the Builder runs. In SLE-024's DAG, the Critic is listed at the DESIGN node ("+ Critic at deep/research"), which implies it reviews the Designer's architecture output before detailed planning begins. This is a meaningful change: critiquing architecture before step-level planning catches structural issues earlier, but it was implied by SLE-024 rather than explicitly decided. SLE-024 §4.2 lists the Critic's artifact slice as "Architecture + prior evaluation" and says "fed back to Designer/Planner" — the slash indicates ambiguity about who receives the critique.

### Options

| # | Option | Description |
|---|--------|-------------|
| A | Critic reviews at DESIGN node (post-Designer, pre-Planner) | The Critic runs after the Designer produces architecture, before the Planner generates step-level plans. Blocking issues force the Designer to revise architecture. The Planner receives only critiqued-and-approved architecture. Structural problems are caught before any step planning begins. |
| B | Critic reviews at PLAN node (post-Planner, pre-Builder) | The Critic runs after the Planner produces requirements, architecture, and test-plan, before the Builder. This is the current SLE-001/002 behavior. The Critic reviews the full plan including step-level details and test coverage. |

### Tradeoffs

- **Option A:** Catches structural issues (circular dependencies, missing components, scalability problems) earlier, before the Planner invests in detailed step planning. Aligns with SLE-024's DAG placement. But the Critic's artifact slice changes — it no longer sees step-level plans or test coverage, so it cannot catch issues at that granularity. A second Critic pass at PLAN could be added for deep/research depth.
- **Option B:** Maintains the existing spec. The Critic sees the complete plan (requirements + architecture + steps + tests) and can catch issues at every level. But structural problems in the architecture may not be surfaced until after the Planner has already done significant work, wasting a reasoning pass.

### Recommendation

Option A. SLE-024 places the Critic at the DESIGN node, and the rationale is sound: catching architectural issues before step planning avoids wasted Planner passes. For `research` depth where multi-pass Critic runs are expected, a final Critic pass could optionally run post-PLAN as well, but the primary review point should be at DESIGN. This decision depends on DDR-019 (Designer ownership) being resolved first — if the Designer owns requirements, the Critic at DESIGN reviews requirements + architecture together.

### Downstream impact

- SLE-002 (Critic node position in DAG)
- SLE-001 (Critic role description)
- SLE-007 (Critic artifact slice)
- SLE-008 (Critic prompt template)
- G7 (DAG rewrite — Critic node placement)

---

## DDR-023 — EXPLORE trigger: who flags unknowns, what format?

**Gap:** G23

**Question:** Who flags unknowns that trigger the EXPLORE node, through what mechanism, and what does the Explorer produce?

### Background

SLE-024 §5.1 marks the EXPLORE node as "conditional — when unknowns flagged," and §4.2 states the Explorer runs "only when the intent or plan flags unknowns that require investigation before design can proceed." But no document specifies who flags unknowns (the user? a keyword in the intent? the Designer? the daemon?), what counts as an unknown, what "flagged" means mechanically (a field on `UserIntent`? a flag in map.yaml?), or what format the Explorer's output takes. Without answers, the EXPLORE node is a placeholder that cannot be implemented.

### Options

| # | Option | Description |
|---|--------|-------------|
| A | User flags + daemon heuristic check | The user can explicitly flag unknowns via a field on `UserIntent` (e.g. `explore: true` or `unknowns: ['Redis pub/sub performance at scale']`). Additionally, the daemon runs a lightweight heuristic on the intent (e.g. checking for technology names not in discovery docs, performance targets with no prior benchmarks) and auto-flags when confidence is low. Explorer produces a `docs/research-findings.md` artifact injected into the Designer's context. |
| B | Designer flags after reading intent | The Designer reads the intent and discovery docs. If it identifies areas where it lacks sufficient information to produce architecture, it outputs a structured `unknowns` list alongside its partial architecture. The daemon routes these unknowns to the EXPLORE node. After EXPLORE completes, the Designer re-runs with the research findings. This is a feedback loop within the DESIGN phase. |

### Tradeoffs

- **Option A:** Simple to implement — the trigger is determined before the Designer runs, so the DAG has a clean linear flow (EXPLORE → DESIGN → PLAN). The user has explicit control. But the daemon heuristic may produce false positives or miss unknowns that only become apparent during design. The Explorer runs before the Designer, so its research is not guided by architectural thinking.
- **Option B:** More accurate — the Designer is best positioned to identify what it doesn't know. The research is targeted because it is driven by specific architectural gaps. But it introduces a loop (DESIGN → EXPLORE → DESIGN) that complicates the DAG and could lead to multiple EXPLORE passes. The user has less direct control over when exploration happens.

### Recommendation

Option A with elements of B as a future enhancement. Start with the simpler model (user flag + daemon heuristic) for implementability. The `UserIntent` type already supports extension fields. The heuristic can be refined over time. The Designer-driven feedback loop (Option B) is more powerful but adds significant DAG complexity and should be deferred to a later iteration. The gap analysis recommends defining the trigger as part of the SLE-002 rewrite.

### Downstream impact

- SLE-002 (EXPLORE node definition, DAG flow)
- SLE-001 (UserIntent type — new `explore` or `unknowns` field)
- SLE-007 (Explorer artifact slice definition)
- SLE-008 (Explorer prompt template)
- G7 (DAG rewrite), G8 (context manager slices)

---

## DDR-025 — Artifact slice reference format (`doc:` vs `node:`)?

**Gap:** G30

**Question:** How should artifact slice references distinguish between project-level documents and group-level nodes?

### Background

SLE-017 introduces a document/node split: documents are project-scoped entities (e.g. `requirements.md`); nodes are group-scoped entities (e.g. the "Rate Limiting" group's architecture node). Both can contain sections that agents need. But SLE-007's artifact slices reference artifacts by key (e.g. `requirements`, `architecture`) and SLE-008's prompt templates reference artifacts by path (e.g. `docs/requirements.md`). Neither uses a type prefix. At context assembly time, if both a project document and a group node share the same artifact key (e.g. `architecture` exists as both `docs/architecture.md` and as a node in each group), the context manager has no rule for which to load.

### Options

| # | Option | Description |
|---|--------|-------------|
| A | Typed prefix references (`doc:` / `node:`) | Slice definitions use `doc:requirements` for project-level documents and `node:{group}:architecture` for group-level nodes. SLE-007 slice assignments and SLE-008 prompt templates both use this convention. The context manager parses the prefix and resolves accordingly. Unprefixed references default to `doc:` for backward compatibility. |
| B | Namespace by path convention (no prefix) | Documents live under `docs/` and nodes live under a group-specific path (e.g. `groups/{group-id}/`). References use full relative paths: `docs/requirements.md` vs `groups/rate-limiting/architecture.md`. The context manager resolves by path pattern. No prefix needed — the directory structure provides the distinction. |

### Tradeoffs

- **Option A:** Explicit and unambiguous — the prefix makes the type immediately clear in slice definitions and prompt templates. Easy to grep for all document references vs all node references. But it introduces a new convention that must be learned and consistently applied across SLE-007, SLE-008, and the context manager's resolver. The `node:{group}:` syntax may be verbose for commonly referenced artifacts.
- **Option B:** Leverages the existing file system structure. No new syntax to learn. But it ties the reference format to the file layout, which makes refactoring (moving files) a breaking change for all slice definitions. Path-based references are also more fragile — a typo in a path fails silently or at runtime, whereas a typed prefix with a known key can be validated at load time.

### Recommendation

Option A. The gap analysis explicitly recommends typed references. The prefix approach is explicit, validated at config load time, and independent of file layout. Unprefixed references defaulting to `doc:` provides backward compatibility with existing slice definitions. The `node:{group}:architecture` verbosity is acceptable because group-scoped node references are expected to be less common than project-level document references.

### Downstream impact

- SLE-007 (slice assignment table — all entries gain prefixes)
- SLE-008 (prompt template artifact references)
- SLE-019 (TaskContextDeclaration `DocumentRef` type)
- Context manager resolver logic
- G7 (DAG rewrite), G8 (context manager slices), G12 (prompt templates)

---

## DDR-024 — Beads required for intake pipeline, or local fallback?

**Gap:** G29

**Question:** When Beads is unavailable (local-only mode), should the intake pipeline require Beads or fall back to a local task store?

### Background

SLE-019's task sharding pipeline produces `SLETask` declarations and immediately maps them to Beads issues (`bd issue create`). If Beads is unavailable (SLE-006 "local-only mode" — no DoltHub account), the tasks are created but have no Beads issue IDs. The context manager uses `bd ready` to surface available tasks, but in local-only mode `bd ready` returns nothing — the sharded tasks are effectively lost. They exist in the sharding output but the context manager cannot find them. No spec defines where sharded tasks live when Beads is unavailable.

### Options

| # | Option | Description |
|---|--------|-------------|
| A | Local fallback task file | When Beads is unavailable, the daemon writes sharded tasks to a local file (e.g. `.sle/tasks.yaml`). The context manager reads from this file in local-only mode instead of calling `bd ready`. The task lifecycle (status tracking, staleness) is managed locally using the file. When Beads becomes available, tasks can be migrated to Beads issues. |
| B | Beads required — pipeline blocked without it | The intake pipeline requires Beads. If Beads is unavailable, the pipeline refuses to run and the system operates in inference mode only (no declared context, no resolver mode). SLE-006's local-only mode documentation explicitly lists intake/sharding as a degraded feature. |

### Tradeoffs

- **Option A:** Local-only projects (common for solo developers, prototypes, air-gapped environments) can still use the intake pipeline with its benefits (coherence checking, precise context declarations, collaborative sharding). But it requires maintaining two codepaths for task storage (Beads and local file), and local task tracking will inevitably be less feature-rich than Beads (no dependency wiring, no web UI for task management, no cross-session memory).
- **Option B:** Single codepath — the system always uses Beads for task tracking. Simpler implementation, no feature parity concerns. But local-only projects lose the entire intake pipeline, which is one of SLE-019's key value propositions. The inference-only fallback (current SLE-007 behavior) works but produces lower-quality context assembly at scale.

### Recommendation

Option A. The gap analysis recommends defining a fallback. Local-only projects are explicitly supported by SLE-006, and losing the intake pipeline in that mode would make local-only a significantly degraded experience. The local file format can mirror the `SLETask` type already defined in SLE-019. The migration path to Beads (when available) can be a `sle tasks sync` command. The additional complexity of maintaining two storage backends is manageable since the context manager already has resolver and inference mode branches.

### Downstream impact

- SLE-019 (pipeline fallback logic, local task file format)
- SLE-006 (local-only mode feature description)
- SLE-007 (context manager — local task reading in resolver mode)
- SLE-005 (CLI — new `sle tasks sync` command)

---

## DDR-026 — Sharding approval UI: tab, separate step, or background?

**Gap:** G38

**Question:** Where does the sharding approval interaction live in the UI — as a tab within the CONFIRM gate panel, a separate pre-CONFIRM step, or a background operation with a notification?

### Background

SLE-019 defines a sharding approval step: after the Planner produces a sharding proposal, the user reviews and approves task boundaries, context declarations, and dependencies at the CONFIRM gate. The sharding proposal can be large — potentially dozens of tasks with context declarations. SLE-020 (UI shell) does not mention sharding approval as a distinct surface or panel. SLE-023 (user flow) describes the CONFIRM gate panel for plan approval but does not include the sharding proposal in the panel layout. Embedding a large sharding proposal in the CONFIRM gate panel alongside plan steps and test coverage would make the panel unwieldy.

### Options

| # | Option | Description |
|---|--------|-------------|
| A | Tab within the CONFIRM gate panel | The CONFIRM gate panel gains a second tab: "Plan" (existing — plan steps, test coverage) and "Sharding" (new — task list, context declarations, dependencies, dependency graph). The user reviews both tabs before approving. The approval button covers both. |
| B | Separate "Sharding review" step before CONFIRM | Sharding approval is a distinct gate that runs before the CONFIRM gate. The user reviews and approves the sharding proposal first, then sees the plan+tests at the CONFIRM gate. This is a two-step approval flow. The DAG inserts a new pause point between PLAN (with intake) and CONFIRM. |
| C | Background operation with notification | Sharding is not a blocking approval step. The Planner produces the sharding proposal, and it is stored for review. The user is notified (via the "Actions required" panel or a WebSocket event) but can approve later or let it auto-approve after a timeout. The CONFIRM gate proceeds without explicit sharding approval. |

### Tradeoffs

- **Option A:** Keeps the approval flow as a single interaction point. The tab metaphor is familiar and SLE-020 already describes a tab-based shell. But it increases the cognitive load of the CONFIRM gate — the user must review two potentially complex panels before approving. Mobile UX suffers because tabs on a small screen add navigation overhead.
- **Option B:** Separates concerns — the user reviews sharding (task structure, dependencies) independently from plan+tests (implementation approach, test coverage). Each review is focused. But it adds a second blocking gate to the cycle, which slows down the flow and adds another round-trip. The DAG needs a new pause point.
- **Option C:** Lowest friction — the user is not blocked by sharding approval. Good for small sharding proposals or experienced users who trust the system. But it weakens the human-in-the-loop guarantee for task boundaries, which is a core value of SLE-019's collaborative sharding model. An auto-approved sharding with bad boundaries could cause downstream failures that are harder to debug.

### Recommendation

Option A. A tab within the CONFIRM gate panel keeps the approval flow as a single interaction point while giving the sharding proposal its own focused view. The tab approach avoids adding a new DAG pause point (which Option B requires) and maintains the human-in-the-loop guarantee (which Option C weakens). For mobile, the tab can be rendered as a swipeable section or an expandable accordion rather than a traditional tab bar. The gap analysis notes that SLE-023's CONFIRM gate panel wireframe would need to be extended with this tab.

### Downstream impact

- SLE-020 (CONFIRM gate panel — new tab, data model for sharding display)
- SLE-023 (CONFIRM gate panel wireframe — sharding tab layout)
- SLE-005 (WebSocket event payload — sharding proposal in approval payload)
- SLE-002 (CONFIRM gate node — sharding approval as part of gate flow)
