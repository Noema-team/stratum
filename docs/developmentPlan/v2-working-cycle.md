# Vertical Slice 2: Working Cycle

**Type:** implementation plan · **Status:** complete · **Updated:** 2026-05-16
**Slice:** v2 · **Prerequisite:** VS1 complete (init + discovery + daemon shell)

---

## Implementation Progress

| Phase | Component | Status | Commit |
|-------|-----------|--------|--------|
| A | Cycle Lifecycle (state + API) | ✅ Complete | `07dadb6` — CycleService: start/halt/resume/acknowledge + 5 REST endpoints |
| B | Run Artifacts + DAG Node State | ✅ Complete | `18b5a70` — RunArtifactManager, RuntimeDAGState in map.yaml, 2 REST endpoints |
| C | Context Manager | ✅ Complete | `6faf866` — ContextManager: role-aware artifact slices, token budget, failure context |
| D | Agent Runner | ✅ Complete | `1ba3f51` — AgentRunner, parseAgentOutput, AnthropicProvider (fetch-based) |
| E | SCOPING Node | ✅ Complete | `9d88f31` — ScopingService, 3 REST endpoints (draft/response/approve) |
| F | DESIGN Node | ✅ Complete | `340bf87` — DAGRunner, write-path validation (DDR-019), CRITIQUE skip logic |
| G | PLAN Node | ✅ Complete | `e3eaf62` — buildCycleStateContext, failure report I/O, PLAN node + failure context injection |
| H | TEST Node + CONFIRM Gate | ✅ Complete | `93945ba` — ConfirmService (gate/approve/revise), tester prefix paths, revision context, 4 daemon endpoints |
| I | BUILD Node + HISTORY | ✅ Complete | `35fb3b2` — APPEND_ONLY_PATHS for decisions.md, builder unrestricted paths confirmed, 21 tests |
| J | EXEC (stub) + Validation Gate | ✅ Complete | `f317342` — ExecService (always-pass stub), ValidationGateService (deterministic manifest check), FailureReport on failure, 21 tests |
| K | EVALUATE + SUMMARISE + SNAPSHOT | ✅ Complete | `e51ac1b` — SnapshotService (copies artifacts, writes snapshot.json, finalizes manifest), 22 tests |
| L | Integration Test | ✅ Complete | `6f13382` — CycleRunner (SCOPING→SNAPSHOT orchestration), 10 tests (9 unit + 1 full integration) |

---

## 1. Overview

### What this slice delivers

After VS2, a user who has completed `sle discover` can run `sle start "intent"` and get:

1. A guided scoping conversation that produces a `cycle-charter.md`
2. Automated sequential execution of all core DAG nodes (DESIGN → PLAN → TEST → CONFIRM → BUILD → EXEC → EVALUATE → SUMMARISE → SNAPSHOT)
3. Real LLM calls for every agent node
4. A locked, versioned snapshot of all produced artifacts under `.sle/snapshots/`
5. API endpoints and WebSocket events for all of the above

The cycle is **end-to-end but not hardened**. Docker execution is stubbed (validation always passes). Multi-turn agent reads are deferred. Builder output uses simplified parsing, not the full DDR-029 typed contract. These are VS3 concerns.

### Why this structure

The previous structure in `implementation-tracking.md` listed VS2 as eight disconnected capability groups (Full API, WebSocket, DAG Runner, Validation, Context, Dispatch, Intake & Knowledge, UI Shell). That is a catalogue, not a plan. Building in that order produces nothing usable until all eight groups are complete.

This slice inverts the approach: deliver the minimum set of things that, together, make a cycle actually run. Every phase leaves the system in a more runnable state than before. The integration test in Phase L is the proof of the whole.

### Deliberate deferrals

The following are **explicitly out of scope for VS2**:

| Item | Why deferred | Where it goes |
|---|---|---|
| Real Docker execution (EXEC) | Major infrastructure dependency, separate risk | VS3 |
| DDR-029 typed output contracts (full) | 14 critical gaps unresolved; simplified contract sufficient | VS3 |
| DDR-030 multi-turn agent reads | Complex; single-turn is sufficient to prove the cycle | VS3 |
| Debugger agent | Requires real EXEC failures; EXEC is stubbed here | VS3 |
| Explorer agent | Conditionally triggered; not on critical path | VS3 |
| Critic agent at depth deep/research | Depth defaults to `standard` in VS2 | VS3 |
| SHARDING approval gate | Optional feature; not on critical path | VS3 |
| Chat mode (Facilitator decision mode) | Orthogonal; does not block cycle | VS3 |
| Intake pipeline | Not needed for a manual `sle start` cycle | VS4 |
| Knowledge engine (Cognee) | Large external dependency | VS4 |
| UI Shell | Separate concern; daemon API is the interface | VS4 |
| Anthropic provider (full) | OpenAI-compatible covers the interface; Anthropic can be wired later | VS3 |
| WebSocket (full event suite) | Core cycle events only in VS2; extended events in VS3 | VS3 |
| Remaining 60+ API endpoints | Only cycle-critical endpoints in VS2 | VS3 |

### Scope summary

| In scope | Out of scope |
|---|---|
| Cycle start / halt / resume API | Chat endpoints |
| DAG execution: all 10 core nodes (sequential) | Sharding endpoints |
| SCOPING node (simplified: 1-round guided discussion) | Full 4-round scoping discussion |
| CONFIRM gate (approve / revise) | Sharding approval gate |
| EXEC node (stub: validation always passes) | Real Docker container execution |
| VALIDATION gate (deterministic logic, full spec) | Container management / job dispatch |
| All 10 agent roles (real LLM calls, single-turn) | Multi-turn agent read-requests (DDR-030) |
| Context manager (per-role slice assembly) | Declared context mode (task-declared slices) |
| Run artifacts (manifest, context-pack) | Run artifact compression / archival |
| Snapshot (versioned artifact lock) | CHANGELOG.md generation |
| Core WebSocket events (cycle, node, gate) | Full 63-event WebSocket suite |
| Cycle-critical REST endpoints (~18) | Remaining 57+ endpoints |

---

## 2. Dependency Map

```
External spec dependencies (this slice consumes):
  dag-execution.md          DAG runner model, iteration logic, node sequence
  dag-node-reference.md     Per-node inputs, outputs, agent role, error behavior
  context-manager.md        Slice assembly, token budget, per-role defaults
  validation.md             Category model, gate logic, FailureReport
  conversation.md           Facilitator scoping mode (single-round subset)
  run-artifacts.md          Manifest, context-pack, snapshot structure
  agent-roles.md            Role definitions, artifact ownership, isolation rules
  artifact-registry.md      Canonical artifact paths and scope
  daemon-api-endpoints.md   Cycle, scoping, gate, DAG state endpoint schemas
  websocket-events.md       Core cycle + node + gate events
  DDR-019                   Designer/Planner artifact ownership split
  DDR-022                   Critic conditional at deep/research depth
  DDR-023                   Explorer trigger conditions (excluded from VS2)
  DDR-028                   SCOPING replaces INTENT node; charter flow
  DDR-029                   Agent output model (simplified subset)
  DDR-030                   Agent runner model (single-turn subset)

This slice produces (consumed by VS3+):
  VS3: Real Docker EXEC, multi-turn agent reads, typed output contracts
  VS3: Debugger agent, Critic (deep mode), Explorer
  VS4: UI Shell connecting to cycle API + WebSocket
```

```
Dependency flow within this slice:

  Phase A (Cycle Lifecycle)
    |
    v
  Phase B (Run Artifacts + DAG State)     ← depends on A (cycle record)
    |
    v
  Phase C (Context Manager)               ← depends on B (artifact paths)
    |
    v
  Phase D (Agent Runner)                  ← depends on C (slice assembly)
    |
    ├──────────────────────────────────────┐
    v                                      v
  Phase E (SCOPING)                     Phase F (DESIGN)
    |                                      |
    v                                      v
  Phase G (PLAN)  ←───────────────────────┘
    |
    v
  Phase H (TEST + CONFIRM)
    |
    v
  Phase I (BUILD)
    |
    v
  Phase J (EXEC stub + Validation Gate)
    |
    v
  Phase K (EVALUATE + SUMMARISE + SNAPSHOT)
    |
    v
  Phase L (Integration Test)
```

---

## 3. Implementation Phases

---

### Phase A: Cycle Lifecycle

**Spec reference:** `state-machine.md` (transitions T3–T12), `daemon-api-endpoints.md` §Cycles
**Implements:** Cycle record management, cycle start/halt/acknowledge, REST endpoints for the cycle lifecycle.

#### Cycle record (extension of map.yaml)

The `cycle` section of map.yaml (already typed in Phase C/VS1) gains runtime meaning:

```typescript
// map.yaml cycle section — all fields must be populated when cycling starts
interface CycleRecord {
  number: number            // increments each new cycle
  iteration: number         // 1-based; increments on validation gate failure
  revision: number          // 0-based; increments on CONFIRM revise
  max_iterations: number    // from planning.yaml
  planning_depth: PlanningDepth
  started_at: string        // ISO timestamp, set on T3/T11
  completed_at?: string     // ISO timestamp, set on T8
  outcome: 'cycling' | 'completed' | 'halted'
  approval_gate: string | null
  awaiting_scoping: boolean
  awaiting_confirmation: boolean
  awaiting_sharding_approval: boolean
  last_summary?: { path: string; generated_at: string }
}
```

A new `active_cycle_id` field is added to map.yaml meta (UUID, set on cycle start, cleared on cycle end).

#### Transitions to implement

| Transition | From | To | Precondition | Side effects |
|---|---|---|---|---|
| T3 | idle | cycling | `discovery_status === 'complete'` | Create cycle record, set active_cycle_id, iteration=1, revision=0 |
| T4 | cycling | cycling | `iteration < max_iterations` | iteration++, clear run artifacts |
| T5 | cycling | halted | state is cycling (user halt) | Write partial report, preserve artifacts |
| T6 | cycling | halted | `iteration >= max_iterations` (cap) | Write partial report with cap notice |
| T7 | cycling | halted | unrecoverable error | Write error report |
| T8 | cycling | complete | snapshot node finishes | Lock snapshot, write changelog |
| T9 | complete | idle | snapshot acknowledgement | Clear active_cycle_id, persist artifacts |
| T10 | halted | idle | user acknowledges halt report | Clear active_cycle_id |
| T11 | idle | cycling | none (--force, skips discovery check) | Same as T3 |
| T12 | halted | cycling | halted state + user confirmation | Iteration count preserved |

T3–T12 all call `this.stateMachine.transition(id)` via StateAPI; precondition logic lives in the state machine (already exists for T3 as a guard — expand the `validateTransition` table).

#### REST endpoints (Phase A)

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/v2/cycles/start` | Start a new cycle (T3 or T11) |
| `GET` | `/api/v2/cycles/current` | Get current cycle record from map.yaml |
| `POST` | `/api/v2/cycles/halt` | Halt current cycle (T5) |
| `POST` | `/api/v2/cycles/acknowledge-halt` | Acknowledge halt report (T10) |
| `POST` | `/api/v2/cycles/resume` | Resume a halted cycle (T12) |

**POST /api/v2/cycles/start request:**
```typescript
{
  intent: string          // user's goal description, min 10 chars
  depth?: PlanningDepth   // default: from planning.yaml
  force?: boolean         // skip discovery guard (T11)
}
```

**POST /api/v2/cycles/start response 200:**
```typescript
{
  ok: true,
  data: {
    cycle_id: string        // UUID
    cycle_number: number    // 1-based
    planning_depth: PlanningDepth
    intent: string
    started_at: string
    initial_node: 'SCOPING'
  }
}
```

**Errors:** 409 `discovery_required` if `discovery_status !== 'complete'` and `force !== true`; 409 `cycle_already_active` if already cycling.

#### WebSocket events (Phase A)

```typescript
// cycle.started
{ cycle_id, cycle_number, planning_depth, intent, started_at }

// cycle.halted
{ cycle_id, reason: 'user' | 'cap_exceeded' | 'error', iteration, partial_report_path? }

// cycle.completed
{ cycle_id, cycle_number, snapshot_path, completed_at }
```

**Acceptance criteria:**
- `POST /cycles/start` transitions map.yaml to cycling, sets active_cycle_id, returns cycle record
- Calling start when already cycling returns 409 `cycle_already_active`
- Calling start with `discovery_status !== 'complete'` (no `--force`) returns 409 `discovery_required`
- `POST /cycles/halt` transitions to halted, preserves iteration counter
- `POST /cycles/acknowledge-halt` transitions halted → idle, clears active_cycle_id
- T3–T12 preconditions enforced by state machine with error codes
- All three WebSocket events emitted at correct state transitions

**Tests needed:**
- Unit: T3–T12 transitions with valid and invalid preconditions (extend state-machine.test.ts)
- Integration: start cycle → map.yaml updated to cycling
- Integration: halt cycle → map.yaml updated to halted
- Integration: acknowledge halt → map.yaml updated to idle
- Integration: cycle_already_active error on double start
- Integration: discovery_required error when discovery not complete

---

### Phase B: Run Artifacts + DAG Node State

**Spec reference:** `run-artifacts.md` (complete), `dag-execution.md` §DAG state tracking
**Implements:** .sle/runs/ directory structure, run manifest, DAG node state tracking in map.yaml.

#### Run directory structure (`run-artifacts.md`)

Each cycle-iteration pair creates an isolated directory:

```
.sle/runs/
  {cycle_number}-{iteration}/
    manifest.json           # node timestamps, outputs, status
    context-pack.json       # per-node assembled context snapshot
    validation/
      results.json          # category pass/fail results
      metrics.json          # token usage, durations
    node-outputs/
      scoping.md            # raw LLM output per node
      design.md
      plan.md
      test.md
      build.md
      evaluate.md
```

**manifest.json schema:**
```typescript
interface RunManifest {
  cycle_id: string
  cycle_number: number
  iteration: number
  planning_depth: PlanningDepth
  started_at: string
  completed_at?: string
  outcome: 'in_progress' | 'complete' | 'halted'
  nodes: Array<{
    id: DAGNodeId          // 'SCOPING' | 'DESIGN' | 'PLAN' | 'TEST' | 'BUILD' | ...
    status: 'pending' | 'running' | 'complete' | 'failed' | 'skipped'
    started_at?: string
    completed_at?: string
    duration_ms?: number
    agent_role?: AgentRole
    tokens_used?: number
    artifacts_written: string[]
  }>
}
```

**context-pack.json** captures, per node, what was assembled and sent to the LLM:
```typescript
interface ContextPack {
  [nodeId: string]: {
    system_prompt_tokens: number
    artifact_slices: Array<{ artifact_id: string; tokens: number; truncated: boolean }>
    state_summary_tokens: number
    total_tokens: number
  }
}
```

#### DAG node state extension of map.yaml

The `meta` section gains a `dag` field:
```typescript
interface DAGState {
  current_node: DAGNodeId | null
  completed_nodes: DAGNodeId[]
  iteration: number
  revision: number
  started_at: string
  nodes: Record<DAGNodeId, { status: NodeStatus; started_at?: string; completed_at?: string }>
}
```

#### REST endpoints (Phase B)

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v2/cycles/current/dag` | Full DAG state from map.yaml |
| `GET` | `/api/v2/cycles/current/run` | Current run manifest |

**Acceptance criteria:**
- `.sle/runs/{n}-{i}/` directory created when cycle starts
- `manifest.json` created and updated as each node starts/completes
- `context-pack.json` written after each node's context is assembled
- `GET /cycles/current/dag` returns current node, completed nodes, node statuses
- Node status transitions: pending → running → complete | failed

**Tests needed:**
- Unit: RunManifest creation and update
- Unit: context-pack serialization
- Integration: run directory created on cycle start
- Integration: manifest updated as nodes complete

---

### Phase C: Context Manager

**Spec reference:** `context-manager.md` (complete document)
**Implements:** Per-role slice assembly, token budget enforcement, state summary generation, system prompt assembly.

#### Context window structure (`context-manager.md` §Context window)

Each LLM call receives a context window with five components:

```
1. System prompt         (agent.md + role's system_prompt from agents.yaml)
2. State summary         (map.yaml distilled: current node, cycle number, iteration, active flags)
3. Task description      (inferred from current node and intent)
4. Artifact slices       (role-specific files, loaded and possibly truncated)
5. Failure context       (FailureReport from previous iteration, if iteration > 1)
```

**VS2 simplification:** Context assembly uses **inferred mode** only (no declared task context from TaskStore). Declared mode (Beads tasks with artifact references) is VS3.

#### Per-role slice defaults (`context-manager.md` §Per-role defaults)

| Role | Reads | Never sees |
|---|---|---|
| Facilitator (scoping) | discovery artifacts, cycle-charter draft | implementation, test scripts |
| Designer | cycle-charter, discovery artifacts | plan, test scripts, implementation |
| Critic | requirements, architecture | plan, test scripts, implementation |
| Planner | requirements, architecture, cycle-charter | test scripts, implementation |
| Tester | requirements, test-plan | architecture, plan, implementation |
| Builder | requirements, architecture, plan, test-plan, test scripts | — |
| Historian | cycle-charter, decisions.md | — |
| Evaluator | requirements, test-plan, evaluation criteria, run results | implementation details |
| Debugger | requirements, test-plan, run artifacts, failure reports | — |

#### Token budget (`context-manager.md` §Token budget, VS2 simplified)

Hard ceiling: 32,000 tokens (safe for most models). Budget allocation:

| Component | Allocation |
|---|---|
| System prompt | up to 4,000 tokens |
| State summary | up to 500 tokens |
| Task description | up to 500 tokens |
| Artifact slices | remaining (up to ceiling - above) |
| Failure context | up to 2,000 tokens (shared with slices) |

**Token counting (VS2):** Character count ÷ 4 (rough approximation). Exact tokenizer is VS3.

**Truncation strategy:** Each artifact slice can be truncated independently. Truncation preference: prefer dropping earlier sections of a document over later ones. Truncation is logged to context-pack.json.

#### ContextManagerConfig (from `context-manager.md`)

```typescript
interface ContextManagerConfig {
  artifact_slice_size: number      // max chars per artifact slice (from planning.yaml)
  summary_max_tokens: number       // from planning.yaml
  system_prompt_max_tokens: number // from planning.yaml
  hard_ceiling: number             // absolute max tokens (32_000 for VS2)
}
```

#### Interface

```typescript
interface ContextManager {
  assemble(role: AgentRole, cycleState: CycleStateContext): Promise<AssembledContext>
}

interface AssembledContext {
  system_prompt: string
  messages: Array<{ role: 'user'; content: string }>  // single message for VS2
  token_estimate: number
  artifact_slices: Array<{ id: string; tokens: number; truncated: boolean }>
  truncated: string[]
}
```

**Acceptance criteria:**
- Context assembled for each of the 8 in-scope roles (not Debugger/Explorer)
- System prompt = agent.md content + role system_prompt from agents.yaml
- State summary includes: cycle number, current node, iteration, planning_depth, intent
- Artifact slices loaded from actual file paths; missing files logged but not fatal
- Token budget enforced: assembled context never exceeds hard ceiling
- Truncation logged to context-pack.json
- Failure context injected when iteration > 1

**Tests needed:**
- Unit: assemble() produces correct slices per role
- Unit: token budget enforced (mock with oversized artifacts)
- Unit: failure context injected correctly on iteration 2
- Unit: missing artifact files handled gracefully
- Unit: state summary contains all required fields

---

### Phase D: Agent Runner

**Spec reference:** `dag-execution.md` §Agent invocation, DDR-030 §Single-turn subset
**Implements:** LLM invocation orchestration for a single DAG node. Single-turn only (DDR-030 multi-turn reads deferred to VS3).

#### Agent runner lifecycle (single-turn, VS2)

```
1. Determine role for current DAG node (from agents.yaml + dag-node-reference.md)
2. Assemble context via ContextManager
3. Load LLM config for role from agents.yaml (provider, model, temperature, max_tokens)
4. Invoke LLMProvider.complete(params)
5. Parse raw LLM output into role-specific artifact content
6. Write artifacts to declared output paths (from artifact-registry.md)
7. Update map.yaml artifact entries (path, generator, last_updated, dirty=false)
8. Write raw LLM output to .sle/runs/{n}-{i}/node-outputs/{node}.md
9. Update manifest.json (node complete, tokens_used, artifacts_written)
```

#### Output parsing (VS2 simplified agent contract)

Rather than DDR-029's full typed output contracts, VS2 uses **structured markdown extraction**:

Each agent's system prompt instructs it to produce output with a preamble block and then artifact content:

```markdown
<!-- SLE-OUTPUT
role: designer
node: DESIGN
artifacts:
  - id: requirements
    path: docs/requirements.md
  - id: architecture
    path: docs/architecture.md
-->

## docs/requirements.md

[full requirements markdown here]

---

## docs/architecture.md

[full architecture markdown here]
```

The DAG runner parses this format:
1. Extracts the `<!-- SLE-OUTPUT ... -->` preamble (YAML inside comment)
2. Splits content by `---` section separators matched to artifact paths from preamble
3. Writes each section to its declared path

**Builder output (VS2):** Builder uses fenced code blocks with file path headers:

```markdown
<!-- SLE-OUTPUT
role: builder
node: BUILD
artifacts:
  - id: implementation
    path: src/
-->

## File: src/items/controller.ts

```typescript
// implementation here
```

## File: src/items/service.ts

```typescript
// implementation here
```
```

The runner extracts code fences and writes each to the declared path.

**Parse failure handling:** If parsing fails, the node is marked `failed` and the cycle halts with error (T7). Raw LLM output is preserved in `node-outputs/` for debugging.

#### AnthropicProvider (VS2)

Complete `AnthropicProvider` using the Anthropic SDK's messages API:

```typescript
class AnthropicProvider implements ILLMProvider {
  async complete(params: LLMCompletionParams): Promise<LLMCompletionResult>
  // Uses: POST /v1/messages
  // Maps: messages array → Anthropic format
  // Handles: content[0].text extraction from response
}
```

#### AgentRunner interface

```typescript
class AgentRunner {
  constructor(
    private contextManager: ContextManager,
    private llmProvider: ILLMProvider,
    private projectRoot: string
  )

  async run(node: DAGNodeId, cycleState: CycleStateContext): Promise<AgentRunResult>
}

interface AgentRunResult {
  success: boolean
  artifacts_written: string[]
  tokens_used: number
  duration_ms: number
  raw_output_path: string
  error?: string
}
```

**Acceptance criteria:**
- `AgentRunner.run()` assembles context, calls LLM, parses output, writes artifacts
- All 8 in-scope roles produce correctly parsed artifacts
- Parse failure transitions cycle to halted (T7) with error preserved
- Raw LLM output written to `node-outputs/{node}.md` regardless of parse success/failure
- AnthropicProvider.complete() works against Anthropic Messages API
- Token usage logged to context-pack.json and manifest.json

**Tests needed:**
- Unit: output parsing for each role format (valid and malformed)
- Unit: Builder code block extraction (multiple files)
- Unit: parse failure handling (T7 transition)
- Integration: AgentRunner.run() with mock LLM — verifies artifacts written to correct paths
- Unit: AnthropicProvider maps params correctly (mock fetch)

---

### Phase E: SCOPING Node

**Spec reference:** `conversation.md` §Scoping mode, `dag-node-reference.md` §SCOPING, DDR-028
**Implements:** SCOPING node execution — Facilitator in scoping mode produces cycle-charter.md via a single-round guided discussion.

#### SCOPING node behavior (VS2 simplified)

**Full spec (DDR-028):** Multi-round guided discussion producing cycle-charter via questions, scope refinement, context from discovery artifacts.

**VS2 implementation:** Single-round:
1. Facilitator receives intent + discovery artifacts as context
2. Facilitator produces one set of clarifying questions + a draft cycle-charter
3. User optionally answers questions via `/scoping/response` endpoint
4. User approves draft via `/scoping/approve`
5. cycle-charter.md is written to `docs/cycle-charter.md`
6. SCOPING node completes; map.yaml updated; DAG advances to DESIGN

`awaiting_scoping` flag is set to `true` when scoping starts. It is cleared when the user approves the charter or when the user provides no response (auto-approve after configured timeout — default 5 minutes in non-interactive mode).

#### cycle-charter.md content

The Facilitator produces a structured charter that all downstream nodes read:

```markdown
# Cycle Charter: {cycle_number}

## Intent
{user's original intent string}

## Scope
{what is and isn't in scope for this cycle}

## Constraints
{any constraints the user mentioned}

## Success criteria
{what "done" looks like for this cycle}

## Planning notes
{Facilitator's distillation of relevant discovery context}
```

#### REST endpoints (Phase E)

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v2/cycles/scoping/draft` | Get current charter draft |
| `POST` | `/api/v2/cycles/scoping/response` | Submit answers to Facilitator questions |
| `POST` | `/api/v2/cycles/scoping/approve` | Approve draft, advance to DESIGN |

**WebSocket events:**
```typescript
// node.started — emitted when SCOPING begins
{ node: 'SCOPING', cycle_id, cycle_number }

// action.required — emitted when charter draft ready for user review
{ type: 'scoping_approval', node: 'SCOPING', draft_path: 'docs/cycle-charter.md' }

// node.completed — emitted after approval
{ node: 'SCOPING', cycle_id, artifacts: ['docs/cycle-charter.md'] }
```

**Acceptance criteria:**
- SCOPING node runs immediately after `POST /cycles/start`
- `awaiting_scoping` flag = true while draft awaiting approval
- `GET /scoping/draft` returns the charter draft content
- `POST /scoping/approve` writes `docs/cycle-charter.md`, clears `awaiting_scoping`, advances DAG to DESIGN
- Auto-advance (no human interaction) supported for `non_interactive` mode
- WebSocket events emitted at start, draft-ready, and completion

**Tests needed:**
- Unit: Facilitator context assembly for scoping mode (includes discovery artifacts)
- Unit: cycle-charter.md parsing and validation
- Integration: SCOPING → DESIGN transition on approve
- Integration: auto-approve in non-interactive mode
- Integration: `awaiting_scoping` flag state management

---

### Phase F: DESIGN Node

**Spec reference:** `dag-node-reference.md` §DESIGN §CRITIQUE, `agent-roles.md` §Designer §Critic, DDR-019, DDR-022
**Implements:** DESIGN node — Designer agent produces requirements.md and architecture.md. Critic node (conditional, deep/research depth only, skipped in VS2 standard depth).

#### DESIGN node behavior

**Inputs (Designer agent reads):**
- `docs/cycle-charter.md` (from SCOPING)
- `docs/discovery/` (all discovery artifacts: product-brief, constraints, system-description, etc.)
- `agent.md` (project conventions)

**Outputs:**
- `docs/requirements.md`
- `docs/architecture.md`

**VS2:** Planning depth defaults to `standard`. Critic node is **skipped** at standard depth (DDR-022). The Critic is implemented as a skippable node — the DAG runner checks `planning_depth` and conditionally includes CRITIQUE.

#### Agent isolation (DDR-019)

Designer owns `requirements.md` and `architecture.md`. Planner cannot modify these files — they are inputs for Planner, not outputs. This isolation is enforced at the file-write level: AgentRunner verifies each write path matches the role's declared `outputs[]` from `artifact-registry.md`.

#### Critic node (VS2 stub)

CRITIQUE node is included in the DAG sequence but **skipped** (status: `skipped`) when `planning_depth === 'standard'` or `planning_depth === 'minimal'`. When skipped:
- Node logged in manifest as `{ status: 'skipped', reason: 'depth' }`
- No LLM call
- DAG advances to PLAN

Full Critic implementation (deep/research depth) is VS3.

**Acceptance criteria:**
- DESIGN node invokes Designer agent via AgentRunner
- `docs/requirements.md` and `docs/architecture.md` written to project root
- map.yaml artifact entries updated with generator: `designer`
- CRITIQUE node skipped at standard depth with logged reason
- Write path validation: Designer cannot write outside its declared artifact paths
- DAG advances to PLAN on DESIGN completion

**Tests needed:**
- Integration: DESIGN node writes requirements.md and architecture.md (mock LLM)
- Unit: write path validation rejects out-of-scope paths
- Unit: CRITIQUE node skipped at standard depth, logged in manifest

---

### Phase G: PLAN Node

**Spec reference:** `dag-node-reference.md` §PLAN, `agent-roles.md` §Planner, DDR-019
**Implements:** PLAN node — Planner agent produces plan.md and test-plan.md.

#### PLAN node behavior

**Inputs (Planner reads):**
- `docs/requirements.md`
- `docs/architecture.md`
- `docs/cycle-charter.md`
- On iteration > 1: FailureReport from previous VALIDATION gate

**Outputs:**
- `docs/plan.md`
- `docs/test-plan.md`

**On retry (iteration > 1):** Failure context is injected into the Planner's context window. The FailureReport identifies which validation categories failed and why. Planner must revise the plan to address the failures.

#### plan.md content structure

The Planner's output for `plan.md` should follow a structure that the Builder can execute step-by-step:

```markdown
# Implementation Plan

## Summary
{what this cycle builds}

## Steps
1. {step description}
   - Files: {list of files to create or modify}
   - Notes: {any implementation notes}

2. {step description}
   ...

## Dependencies
{any external packages to install}

## Risks
{known risks or ambiguities}
```

#### test-plan.md content structure

```markdown
# Test Plan

## Approach
{testing strategy}

## Test categories
### {category name}
- Category type: unit | integration | e2e
- Test file: {path}
- Tests:
  - {test description}
  - {test description}
```

**Acceptance criteria:**
- PLAN node invokes Planner agent via AgentRunner
- `docs/plan.md` and `docs/test-plan.md` written
- Failure context injected when iteration > 1
- map.yaml artifact entries updated
- DAG advances to TEST on completion

**Tests needed:**
- Integration: PLAN node writes plan.md and test-plan.md (mock LLM)
- Unit: failure context injection (iteration > 1 scenario)
- Unit: Planner reads requirements + architecture but not implementation code

---

### Phase H: TEST Node + CONFIRM Gate

**Spec reference:** `dag-node-reference.md` §TEST, `agent-roles.md` §Tester, `daemon-api-endpoints.md` §CONFIRM gate, DDR-007
**Implements:** TEST node (Tester agent produces test scripts), CONFIRM gate (human approval before BUILD).

#### TEST node behavior

**Tester isolation (DDR-007):** Tester **never sees** implementation code, architecture.md, or plan.md. This enforces test-driven discipline — tests are derived from requirements alone.

**Inputs (Tester reads):**
- `docs/requirements.md`
- `docs/test-plan.md`

**Outputs:**
- `.sle/runs/{n}-{i}/tests/` directory containing executable test scripts
- `tests/{category}.test.{ext}` (one file per test category)

**Test scripts (VS2):** Tester produces Node.js test files using the built-in `node:test` runner (consistent with existing codebase). Each test file includes setup, test cases, and teardown. Scripts must be executable without modification by the EXEC node.

#### CONFIRM gate behavior

After TEST completes, the cycle sets `awaiting_confirmation = true` and pauses. The user reviews the plan and test suite and either:
- **Approves:** BUILD proceeds, `awaiting_confirmation` cleared, `revision` unchanged
- **Revises:** User provides feedback, `revision++`, DAG returns to TEST for re-derivation

**VS2:** Revise feedback is passed back to the Planner (not Tester directly). DAG returns to PLAN → TEST on revise.

**CONFIRM auto-approve:** In `non_interactive` mode, the gate auto-approves after a configurable timeout (default: immediate).

#### REST endpoints (Phase H)

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/v2/cycles/current/approve` | Approve at CONFIRM gate |
| `POST` | `/api/v2/cycles/current/revise` | Request revisions at CONFIRM gate |

**POST /api/v2/cycles/current/revise request:**
```typescript
{ feedback: string }  // user's revision notes, injected into Planner context
```

**WebSocket events:**
```typescript
// dag.confirm_requested — emitted when awaiting CONFIRM
{ cycle_id, cycle_number, revision, plan_path: 'docs/plan.md', test_plan_path: 'docs/test-plan.md' }

// action.required — unified action panel
{ type: 'confirm_gate', cycle_id, revision, options: ['approve', 'revise'] }
```

**Acceptance criteria:**
- TEST node invokes Tester agent; test scripts written to `.sle/runs/{n}-{i}/tests/`
- Tester's context assembly never includes architecture.md, plan.md, or implementation files
- `awaiting_confirmation` = true after TEST; cycle paused
- `POST /approve` clears flag, advances DAG to BUILD
- `POST /revise` increments `revision`, clears flag, returns DAG to PLAN node
- Auto-approve in `non_interactive` mode
- `dag.confirm_requested` WebSocket event emitted with plan and test-plan paths

**Tests needed:**
- Unit: Tester context assembly excludes architecture/implementation
- Integration: TEST node writes test scripts (mock LLM)
- Integration: CONFIRM approve → BUILD transition
- Integration: CONFIRM revise → PLAN (revision counter incremented)
- Unit: revision feedback injected into Planner context on revise

---

### Phase I: BUILD Node

**Spec reference:** `dag-node-reference.md` §BUILD §HISTORY, `agent-roles.md` §Builder §Historian, DDR-029 §Builder (simplified)
**Implements:** BUILD node (Builder produces implementation files), HISTORY node (Historian appends to decisions.md).

#### BUILD node behavior

**Inputs (Builder reads):**
- `docs/requirements.md`
- `docs/architecture.md`
- `docs/plan.md`
- `docs/test-plan.md`
- `.sle/runs/{n}-{i}/tests/` (test scripts — Builder must make these pass)

**Outputs:** Implementation files at paths declared in plan.md. May include:
- Source files (`.ts`, `.js`, etc.)
- Configuration files
- Package.json updates
- Any other files needed to pass the tests

**VS2 Builder output format** (simplified from DDR-029):

Builder uses the fenced code block format described in Phase D. The runner:
1. Parses the `<!-- SLE-OUTPUT -->` preamble listing all files to create
2. Extracts each `## File: {path}` section
3. Writes the code block content to the declared path
4. Verifies the written file passes basic syntax checks (parse-only, no execution)

**File write safety:**
- Builder cannot write to `.sle/` (protected directory)
- Builder cannot write to `docs/` (artifact files, not implementation)
- Builder cannot overwrite test scripts in `.sle/runs/`
- Paths traversing outside projectRoot rejected

#### HISTORY node behavior

HISTORY runs immediately after BUILD (every iteration, regardless of outcome).

**Inputs (Historian reads):**
- `docs/cycle-charter.md`
- `docs/decisions.md` (current contents)

**Outputs:**
- Appends to `docs/decisions.md` (append-only — Historian cannot overwrite)

Entry format:
```markdown
## Cycle {n}, Iteration {i} — {timestamp}

**Intent:** {cycle intent}
**Node completed:** BUILD
**Decisions:** {Historian's summary of what was built and why}
```

**Append-only enforcement:** HISTORY node write path is restricted to `docs/decisions.md`. AgentRunner uses append mode (`fs.appendFile`) instead of `fs.writeFile` for this artifact.

**Acceptance criteria:**
- BUILD node invokes Builder agent; implementation files written to declared paths
- File safety rules enforced (cannot write .sle/, docs/, test scripts)
- HISTORY node appends entry to docs/decisions.md (not overwrites)
- map.yaml artifact entries updated for all written files
- BUILD node marked complete before HISTORY; DAG sequence: BUILD → HISTORY → EXEC
- parse failure → T7 (cycle halted)

**Tests needed:**
- Integration: BUILD node writes implementation files (mock LLM)
- Unit: file write safety rules (path validation)
- Unit: Builder fenced code block extraction (multiple files, edge cases)
- Integration: HISTORY node appends to decisions.md (mock LLM)
- Unit: append-only enforcement for HISTORY (reject overwrite attempt)

---

### Phase J: EXEC Node (stub) + Validation Gate

**Spec reference:** `validation.md` (complete), `dag-node-reference.md` §EXEC §VALIDATION GATE
**Implements:** EXEC node (VS2 stub — always passes), Validation gate (full deterministic logic), iteration retry loop.

#### EXEC node (VS2 stub)

EXEC is the Docker execution phase. In VS2, it is **stubbed**:
- Each configured validation category receives result: `{ passed: true, method: 'stubbed' }`
- No container is started, no tests are run
- All categories pass
- Results written to `.sle/runs/{n}-{i}/validation/results.json`
- Node completes immediately

The stub is clearly marked in results.json: `{ "stubbed": true, "reason": "Docker EXEC not yet implemented (VS2)" }`.

This stub allows the full cycle to complete without Docker. VS3 replaces the stub with real container execution.

#### Validation gate (full implementation, `validation.md`)

The validation gate is **deterministic — no LLM involved**. It reads `results.json` and applies the rule:

```
gate_result = ALL configured categories have passed: true
```

**On gate pass:**
- Cycle advances to EVALUATE
- map.yaml validation section updated: all categories `status: 'passed'`

**On gate failure (not possible in VS2 since EXEC is stubbed, but implemented for VS3 readiness):**

```
if iteration < max_iterations:
  T4 transition (cycling → cycling)
  iteration++
  clear run artifacts for next iteration
  advance DAG back to PLAN (with FailureReport injected)
else:
  T6 transition (cycling → halted, cap exceeded)
  write partial report
```

**FailureReport** (generated on gate failure):
```typescript
interface FailureReport {
  iteration: number
  failed_categories: Array<{
    name: string
    method: ValidationMethod
    error_summary: string
    test_output?: string
  }>
  passing_categories: string[]  // these are not re-run in next iteration
}
```

FailureReport is persisted to `.sle/runs/{n}-{i}/validation/failure-report.json` and injected into Planner context on next iteration.

#### Passing category caching (`validation.md` §Category caching)

When a category passes in iteration N, it is **not re-run in iteration N+1**. The validation gate reads the previous iteration's results and skips already-passing categories. This prevents wasting LLM calls on categories that haven't changed.

**Acceptance criteria:**
- EXEC node runs and always returns passed (VS2 stub)
- `results.json` written with stub marker
- Validation gate reads results.json and applies deterministic logic
- Gate pass → cycle advances to EVALUATE
- Gate failure (future VS3 path) → T4 if iteration < cap, T6 if at cap
- FailureReport generated on failure and injected into Planner next iteration
- Passing categories not re-run (caching logic implemented even though all pass in VS2)

**Tests needed:**
- Unit: validation gate pass logic (all pass → advance)
- Unit: validation gate failure logic (failure → T4 / T6)
- Unit: FailureReport generation
- Unit: passing category caching
- Integration: EXEC stub runs and gate passes
- Integration: T4 iteration increment with FailureReport injection

---

### Phase K: EVALUATE + SUMMARISE + SNAPSHOT

**Spec reference:** `dag-node-reference.md` §EVALUATE §SUMMARISE §SNAPSHOT, `run-artifacts.md` §Snapshot
**Implements:** Evaluator agent, Summarise node (daemon-generated), Snapshot (version lock + artifact copy).

#### EVALUATE node

**Inputs (Evaluator reads):**
- `docs/requirements.md`
- `docs/test-plan.md`
- `.sle/runs/{n}-{i}/validation/results.json`

**Outputs:**
- `docs/evaluation.md`

Evaluator produces a structured verdict on whether the cycle's intent was satisfied:

```markdown
# Evaluation — Cycle {n}, Iteration {i}

## Verdict
PASS | PARTIAL | FAIL

## Intent satisfaction
{assessment of whether the user's intent was met}

## Test coverage
{assessment of test completeness}

## Quality assessment
{brief assessment of code/artifact quality}

## Recommendations
{suggestions for next cycle, if any}
```

#### SUMMARISE node

SUMMARISE is **daemon-generated** (no LLM call). It reads the run manifest, evaluation.md, and produces a user-facing summary:

```typescript
interface CycleSummary {
  cycle_number: number
  intent: string
  verdict: 'PASS' | 'PARTIAL' | 'FAIL'
  artifacts_produced: string[]
  duration_ms: number
  iterations: number
  revisions: number
  next_steps?: string  // from Evaluator recommendations
}
```

Summary written to `reports/summary-v{version}.md` (path from `summary.yaml` config).

#### SNAPSHOT node

Snapshot locks the cycle's artifacts into an immutable versioned copy:

1. Determine version number (from `map.yaml cycle.number`, formatted as `v{n}.{i}`)
2. Create `.sle/snapshots/v{n}.{i}/` directory
3. Copy all artifacts declared in `map.yaml artifacts[]` to snapshot directory (maintaining relative paths)
4. Write `snapshot-manifest.json` with: cycle_id, version, timestamp, artifact list, evaluation verdict
5. Mark snapshot as locked (`.sle/snapshots/v{n}.{i}/.locked`)
6. Update `map.yaml meta.version_id` with the new version
7. Emit T8 transition: cycling → complete

**Version scheme (VS2):** `v{cycle_number}.{iteration}`. Semver inference from DDR-028 is VS3.

**Snapshot immutability:** The locked file (`.locked`) signals that the snapshot directory must not be modified. The daemon checks for this file before any write operation on a snapshot directory.

#### T8 → T9 flow

After SNAPSHOT:
1. T8 transition: cycling → complete (map.yaml status = complete)
2. WebSocket: `cycle.completed` event
3. System waits for acknowledgement
4. User calls `GET /api/v2/cycles/current` to see summary
5. (In non-interactive mode: T9 transitions automatically after a brief delay)
6. T9 transition: complete → idle

#### REST endpoints (Phase K)

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v2/cycles/current/summary` | Get current cycle summary |
| `GET` | `/api/v2/cycles/{id}/snapshot` | Get snapshot manifest |

**Acceptance criteria:**
- EVALUATE node invokes Evaluator agent; `docs/evaluation.md` written
- SUMMARISE generates `reports/summary-v{n}.{i}.md` (no LLM call)
- SNAPSHOT copies all map.yaml artifacts to `.sle/snapshots/v{n}.{i}/`
- `.sle/snapshots/v{n}.{i}/.locked` file written
- T8 transition: map.yaml status → complete
- T9 transition: map.yaml status → idle (auto in non-interactive mode)
- `cycle.completed` WebSocket event emitted
- Snapshot directories are immutable (daemon rejects writes to locked snapshots)

**Tests needed:**
- Integration: EVALUATE node writes evaluation.md (mock LLM)
- Unit: SUMMARISE produces correct summary from manifest + evaluation.md
- Unit: SNAPSHOT copies correct artifacts, writes manifest, creates .locked
- Integration: T8 → T9 flow (cycling → complete → idle)
- Unit: snapshot immutability enforcement
- Unit: version scheme: v1.1 on first cycle first iteration

---

### Phase L: Integration Test (VS2)

**Spec reference:** Cross-cutting (all above phases)
**Implements:** End-to-end acceptance test for VS2.

**Test flow:**

```
1. Reuse VS1 init: create temp git repo, run sle init, run sle discover (solo mode)
2. POST /api/v2/cycles/start with intent "Build a CRUD REST API for managing items"
3. SCOPING: GET /scoping/draft → verify charter draft; POST /scoping/approve
4. Verify DAG advances to DESIGN
5. DESIGN runs automatically (mock LLM) → verify requirements.md, architecture.md written
6. PLAN runs automatically (mock LLM) → verify plan.md, test-plan.md written
7. TEST runs automatically (mock LLM) → verify test scripts in .sle/runs/1-1/tests/
8. GET /api/v2/system/flags → awaiting_confirmation: true
9. GET /api/v2/cycles/current/dag → current_node: CONFIRM
10. POST /api/v2/cycles/current/approve
11. BUILD runs automatically (mock LLM) → verify implementation files written
12. HISTORY runs automatically (mock LLM) → verify decisions.md appended
13. EXEC runs (stub) → verify results.json with stub marker
14. Validation gate passes → DAG advances to EVALUATE
15. EVALUATE runs automatically (mock LLM) → verify evaluation.md written
16. SUMMARISE runs → verify reports/summary-v1.1.md written
17. SNAPSHOT runs → verify .sle/snapshots/v1.1/ created with .locked file
18. GET /api/v2/system/state → status: complete (then auto-T9 → idle)
19. GET /api/v2/cycles/current/snapshot → verify snapshot manifest
20. Verify map.yaml: status idle, discovery_status complete, cycle.outcome completed
```

**Mock LLM for integration test:**

```typescript
class MockLLMProvider implements ILLMProvider {
  // Returns pre-configured role-appropriate responses
  // Each response includes valid <!-- SLE-OUTPUT --> preamble and artifact content
  // Response dispatched by inspecting the system prompt for role identifier
  async complete(params: LLMCompletionParams): Promise<LLMCompletionResult>
}
```

Mock responses include:
- Scoping: valid cycle-charter.md content
- Design: valid requirements.md + architecture.md content
- Plan: valid plan.md + test-plan.md content
- Test: valid Node.js test file content
- Build: valid implementation file with fenced code blocks
- History: valid decisions.md entry
- Evaluate: PASS verdict

**Acceptance criteria:**
- Full flow completes without errors
- All state transitions match spec
- All artifacts present after snapshot
- map.yaml reflects completed cycle
- .sle/snapshots/v1.1/ exists with .locked and all artifacts
- cycle.completed WebSocket event received

---

## 4. Types Inventory

New types introduced in VS2 (beyond VS1's types.ts):

### Cycle execution types

```typescript
// DAG node identifiers
type DAGNodeId = 
  | 'SCOPING' | 'DESIGN' | 'CRITIQUE' | 'PLAN' | 'TEST'
  | 'CONFIRM' | 'BUILD' | 'HISTORY' | 'EXEC' | 'VALIDATE'
  | 'DEBUG' | 'EVALUATE' | 'SUMMARISE' | 'SNAPSHOT'

// Node status in DAG
type NodeStatus = 'pending' | 'running' | 'complete' | 'failed' | 'skipped'

// DAG execution state (persisted in map.yaml)
interface DAGExecutionState {
  current_node: DAGNodeId | null
  completed_nodes: DAGNodeId[]
  iteration: number
  revision: number
  intent: string
  started_at: string
  nodes: Record<DAGNodeId, DAGNodeRecord>
}

interface DAGNodeRecord {
  status: NodeStatus
  started_at?: string
  completed_at?: string
  duration_ms?: number
  error?: string
  skipped_reason?: string
  artifacts_written: string[]
}
```

### Context manager types

```typescript
interface AssembledContext {
  system_prompt: string
  messages: Array<{ role: 'user'; content: string }>
  token_estimate: number
  artifact_slices: Array<{ id: string; tokens: number; truncated: boolean }>
  truncated: string[]
  failure_context?: string
}

interface ContextManagerConfig {
  artifact_slice_size: number
  summary_max_tokens: number
  system_prompt_max_tokens: number
  hard_ceiling: number
}
```

### Agent runner types

```typescript
interface AgentRunResult {
  success: boolean
  artifacts_written: string[]
  tokens_used: number
  duration_ms: number
  raw_output_path: string
  error?: string
}

// VS2 simplified output header
interface AgentOutputHeader {
  role: AgentRole
  node: DAGNodeId
  artifacts: Array<{ id: string; path: string }>
}
```

### Run artifact types

```typescript
interface RunManifest {
  cycle_id: string
  cycle_number: number
  iteration: number
  planning_depth: PlanningDepth
  started_at: string
  completed_at?: string
  outcome: 'in_progress' | 'complete' | 'halted'
  nodes: RunManifestNode[]
}

interface RunManifestNode {
  id: DAGNodeId
  status: NodeStatus
  started_at?: string
  completed_at?: string
  duration_ms?: number
  agent_role?: AgentRole
  tokens_used?: number
  artifacts_written: string[]
  skipped_reason?: string
}

interface ContextPack {
  [nodeId: string]: {
    system_prompt_tokens: number
    artifact_slices: Array<{ artifact_id: string; tokens: number; truncated: boolean }>
    state_summary_tokens: number
    total_tokens: number
  }
}
```

### Validation types

```typescript
interface ValidationResult {
  category: string
  passed: boolean
  method: ValidationMethod | 'stubbed'
  error_summary?: string
  test_output?: string
}

interface ValidationResults {
  cycle_number: number
  iteration: number
  stubbed: boolean
  categories: ValidationResult[]
  gate_passed: boolean
}

interface FailureReport {
  iteration: number
  failed_categories: Array<{
    name: string
    method: ValidationMethod
    error_summary: string
    test_output?: string
  }>
  passing_categories: string[]
}
```

### Snapshot types

```typescript
interface SnapshotManifest {
  version: string           // e.g. "v1.1"
  cycle_id: string
  cycle_number: number
  iteration: number
  created_at: string
  evaluation_verdict: 'PASS' | 'PARTIAL' | 'FAIL'
  artifacts: Array<{
    id: string
    path: string
    snapshot_path: string
  }>
  locked: true
}
```

---

## 5. API Endpoint Inventory

VS2 adds the following endpoints (all under `/api/v2`):

### Cycle lifecycle (Phase A)

| Method | Path | Response 200 | Error codes |
|---|---|---|---|
| `POST` | `/cycles/start` | `{ cycle_id, cycle_number, planning_depth, intent, started_at, initial_node }` | 409: `discovery_required`, `cycle_already_active` |
| `GET` | `/cycles/current` | `{ cycle_id, cycle_number, intent, planning_depth, iteration, revision, started_at, outcome, current_node }` | 404: `no_active_cycle` |
| `POST` | `/cycles/halt` | `{ cycle_id, iteration, halted_at }` | 409: `not_cycling` |
| `POST` | `/cycles/acknowledge-halt` | `{ cycle_id, cleared_at }` | 409: `not_halted` |
| `POST` | `/cycles/resume` | `{ cycle_id, iteration, resumed_at }` | 409: `not_halted` |

### DAG state (Phase B)

| Method | Path | Response 200 | Error codes |
|---|---|---|---|
| `GET` | `/cycles/current/dag` | `{ current_node, completed_nodes, nodes: { [id]: { status, started_at, completed_at } } }` | 404: `no_active_cycle` |
| `GET` | `/cycles/current/run` | RunManifest | 404: `no_active_cycle` |

### Scoping (Phase E)

| Method | Path | Response 200 | Error codes |
|---|---|---|---|
| `GET` | `/cycles/scoping/draft` | `{ draft_available: boolean, content?: string, questions?: string }` | 404: `not_scoping` |
| `POST` | `/cycles/scoping/response` | `{ received: true, updated_draft_available: boolean }` | 409: `scoping_not_awaiting_response` |
| `POST` | `/cycles/scoping/approve` | `{ charter_path: string, next_node: 'DESIGN' }` | 409: `no_draft_to_approve` |

### CONFIRM gate (Phase H)

| Method | Path | Response 200 | Error codes |
|---|---|---|---|
| `POST` | `/cycles/current/approve` | `{ approved_at, next_node: 'BUILD', revision }` | 409: `not_awaiting_confirmation` |
| `POST` | `/cycles/current/revise` | `{ revision, returning_to: 'PLAN' }` | 409: `not_awaiting_confirmation` |

### Cycle summary & snapshot (Phase K)

| Method | Path | Response 200 | Error codes |
|---|---|---|---|
| `GET` | `/cycles/current/summary` | CycleSummary | 404: `no_summary_yet` |
| `GET` | `/cycles/:id/snapshot` | SnapshotManifest | 404: `snapshot_not_found` |

**Total VS2 endpoints: 14**
**Cumulative total (VS1 + VS2): 33 of 85 endpoints (~39%)**

---

## 6. WebSocket Events (VS2 core set)

VS2 implements the following subset of `websocket-events.md`. The full 63-event suite is VS3.

| Event | When emitted | Payload |
|---|---|---|
| `cycle.started` | POST /cycles/start | `{ cycle_id, cycle_number, planning_depth, intent }` |
| `cycle.halted` | T5/T6/T7 transitions | `{ cycle_id, reason, iteration }` |
| `cycle.completed` | T8 transition | `{ cycle_id, snapshot_path, evaluation_verdict }` |
| `node.started` | DAG runner begins a node | `{ node, cycle_id, agent_role? }` |
| `node.completed` | DAG runner finishes a node | `{ node, cycle_id, artifacts_written, duration_ms }` |
| `node.failed` | Agent runner error | `{ node, cycle_id, error }` |
| `dag.confirm_requested` | TEST completes | `{ cycle_id, revision, plan_path, test_plan_path }` |
| `action.required` | Gate pending | `{ type: 'scoping_approval' \| 'confirm_gate', cycle_id }` |
| `cycle.iteration_started` | T4 transition | `{ cycle_id, iteration, previous_iteration }` |

---

## 7. Test Strategy

### Unit tests per phase

| Phase | Test count (est.) | Key test areas |
|---|---|---|
| A: Cycle Lifecycle | ~15 | T3–T12 transitions, cycle record creation, API responses |
| B: Run Artifacts | ~10 | Manifest CRUD, context-pack serialization, directory creation |
| C: Context Manager | ~15 | Per-role slice assembly, token budget, truncation, failure context |
| D: Agent Runner | ~15 | Output parsing per role, Builder code extraction, parse failure |
| E: SCOPING | ~8 | Charter generation, approve flow, auto-approve, awaiting_scoping flag |
| F: DESIGN | ~8 | DESIGN node invocation, write-path isolation, Critic skip |
| G: PLAN | ~6 | PLAN node invocation, failure context injection |
| H: TEST + CONFIRM | ~10 | Tester isolation, gate approve/revise, revision counter |
| I: BUILD + HISTORY | ~10 | File write safety, append-only enforcement, code block extraction |
| J: EXEC + Gate | ~8 | Stub results, gate pass/fail logic, FailureReport, category caching |
| K: EVALUATE + SNAPSHOT | ~10 | Evaluator output, snapshot copy, immutability, T8→T9 |
| L: Integration | ~8 | Full cycle flow (mock LLM), all state transitions, all artifacts |

**Total estimated: ~123 new tests**
**Cumulative with VS1 (236 tests): ~359 tests**

### Mock LLM strategy

All tests use `MockLLMProvider`. Each call receives a role-appropriate response:
- Response format matches the `<!-- SLE-OUTPUT -->` convention
- Artifact content is minimal but valid (parseable, writable)
- Role dispatched by inspecting `system_prompt` for the role identifier header

Real LLM tests tagged `@llm`, excluded from CI, run with `SLE_LLM_TEST=true`.

### Integration test structure

Phase L uses a single shared context (one temp dir, one daemon) running sequentially. Each step asserts intermediate state before proceeding. Teardown removes the temp dir regardless of test outcome.

---

## 8. Out of Scope (VS3+)

### VS3: Hardening

| Item | Description |
|---|---|
| Real Docker execution (EXEC) | Container management, job dispatch, test runner harness |
| DDR-029 typed output contracts | Full discriminated union, Zod validation per role |
| DDR-030 multi-turn agent reads | ReadRequest loop, file search, symbol lookup |
| Debugger agent | Diagnoses validation failures, informs Planner retry |
| Critic agent (deep/research depth) | Architecture review before PLAN |
| Explorer agent (conditional) | Spike/research when triggered by SCOPING |
| Real validation categories | llm-check + exec-check per spec |
| AnthropicProvider complete | Full SDK integration |

### VS4: Breadth

| Item | Description |
|---|---|
| Chat mode (Facilitator decision) | `sle chat` command, conversation history, decision capture |
| Sharding approval gate | Plan split into shards, sharding approval UI |
| Extended API (57 remaining endpoints) | Tags, tasks, document linking, artifacts list, context, modules |
| Full WebSocket event suite | All 63 events from websocket-events.md |
| Backlog system | Task extraction, promotion, auto-grouping |

### VS5: Integrations

| Item | Description |
|---|---|
| Knowledge engine (Cognee) | Vector search over project history |
| UI Shell | Browser-based dashboard, graph, actions panel |
| Obsidian plugin | Two-way sync, plugin architecture |
| CI/CD integration | Post-snapshot hooks, deployable flag |
