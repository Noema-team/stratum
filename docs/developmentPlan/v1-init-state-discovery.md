# Vertical Slice 1: Init + State Machine + Discovery

**Type:** implementation plan · **Status:** in progress · **Updated:** 2026-05-10
**Slice:** v1 · **Prerequisite:** None (this is the first slice)

## Implementation Progress

| Phase | Component | Status | Commit |
|-------|-----------|--------|--------|
| A | Foundation Types | ✅ Complete | bf690b2 |
| B | Runtime Map | ✅ Complete | 0801381, eb592f7 |
| C | State Machine | ✅ Complete | ad59035 |
| D | Rule File Schemas | ✅ Complete | -- |
| E | Daemon Shell | ✅ Complete | (se implementation-tracking.md) |
| F | State API | ✅ Complete | (se implementation-tracking.md) |
| G | sle init | ✅ Complete | (se implementation-tracking.md) |
| H | Init API | ✅ Complete | (se implementation-tracking.md) |
| I | Facilitator LLM | ✅ Complete | (se implementation-tracking.md) |
| J | sle discover | ✅ Complete | (se implementation-tracking.md) |
| K | Discovery API | ✅ Complete | (se implementation-tracking.md) |
| L | Integration Test | ⏳ Pending | -- |

**Phase A Summary:**
- Implemented all 57 type definitions from types.md
- Created 27 Zod enum validators
- Comprehensive unit tests (17 tests) for all schemas
- Full TypeScript compilation with no errors
- Implementation location: `src/sdk-orchestrator/v2/src/types.ts`

**Phase B Summary:**
- Complete RuntimeMap schema with all required nested objects
- Atomic write semantics: temp file → rename (crash-safe)
- FileMutex for concurrent write serialization
- RuntimeMapManager with read/write/update operations
- createInitialMap factory for initialization
- Orphaned temp file cleanup
- Support for Git and Dolt remotes
- 10 unit tests with mock filesystem
- Implementation location: `src/sdk-orchestrator/v2/src/runtime-map.ts`

---

## 1. Overview

This slice implements the entry point of the entire SLE system. It covers three
user-facing commands (`sle init`, `sle discover`, `sle daemon start`) and the
foundational infrastructure they depend on (types, state machine, rule files,
map.yaml, daemon shell, LLM provider abstraction).

### Why this slice is first

1. Every other slice depends on types, map.yaml, and the state machine
2. `sle init` creates the file system layout all other slices read from
3. `sle discover` produces the discovery artifacts that cycle agents consume
4. The daemon shell is the runtime all API endpoints are registered on
5. Validation of the type system and Zod schemas happens here first

### Scope summary

| In scope | Out of scope |
|---|---|
| All types from `types.md` (Zod schemas + TS interfaces) | Context assembly (context-manager.md behavior) |
| RuntimeMap (map.yaml) schema + atomic read/write | DAG runner and cycle execution |
| State machine (5 states, 12 transitions, 3 flags) | L3 agent runtime (Designer, Planner, Tester, Builder, etc.) |
| 7 rule file Zod schemas + template generation | L4 job dispatch / Docker execution |
| Daemon HTTP server + startup validation + shutdown | Validation gate + EXEC node |
| State API endpoints | Cycle endpoints (start, halt, approve, revise) |
| Init sequence (11 steps) | Sharding pipeline |
| Init API endpoints | Intake pipeline |
| Facilitator LLM integration (discovery mode only) | Facilitator chat mode / decision mode |
| Discovery flow (4-round + synthesis + planning) | Knowledge engine (Cognee) |
| Discovery API endpoints (12 endpoints) | Content store / modules / document linking |
| LocalTaskStore only | BeadsTaskStore (delegates to `bd` CLI) |
| Facilitator prompt templates (3 files) | All other agent prompt templates (install only) |

### Estimated complexity

| Component | Effort | Risk |
|---|---|---|
| Foundation types + Zod schemas | Medium | Low |
| RuntimeMap + atomic I/O | Medium | Medium (atomic write correctness) |
| State machine | Medium | Low (well-specified transitions) |
| Rule file schemas + generation | Medium | Low |
| Daemon shell | Medium | Medium (server lifecycle, WebSocket) |
| State API | Low | Low |
| `sle init` (11 steps) | High | Medium (side effects, resume logic) |
| Init API | Medium | Low |
| Facilitator LLM integration | High | High (LLM provider, prompt engineering) |
| `sle discover` (full flow) | High | High (multi-round conversation, state persistence) |
| Discovery API (12 endpoints) | High | Medium |
| Integration test | Medium | Low |

---

## 2. Dependency Map

```
External dependencies (this slice consumes):
  types.md                  all type definitions
  state-machine.md          transition table, flags, constraints
  init-and-discovery.md     init sequence, discovery flow
  daemon-api.md             daemon architecture, startup sequence
  daemon-api-endpoints.md   HTTP endpoint schemas
  rule-files.md             7 rule file schemas, defaults
  prompt-templates.md       Facilitator templates (3 modes)
  context-manager.md        SliceRule, ContextManagerConfig interfaces only
  architecture.md           L1/L2/L3 tier model
  agent-roles.md            Facilitator role definition
  dag-node-reference.md     DISCOVERY node (inputs/outputs)
  dag-execution.md          Where discovery fits (before cycles)
  beads-integration.md      TaskStore interface, LocalTaskStore
  conversation.md           Facilitator mode switching for discovery
  validation.md             ValidationConfig type for rule files

This slice produces (consumed by future slices):
  v2: DAG execution + context manager assembly
  v3: Remaining agent roles (Designer, Planner, etc.)
  v4: Job dispatch / Docker
  Post-MVP: BeadsTaskStore, knowledge engine, chat mode
```

```
Dependency flow within this slice:

  Phase A (Types)
    |
    v
  Phase B (RuntimeMap)
    |
    v
  Phase C (State Machine) ──────────────────────────┐
    |                                                 |
    v                                                 v
  Phase D (Rule Files)                         Phase E (Daemon Shell)
    |                                                 |
    v                                                 v
  Phase G (sle init)  <─ Phase F (State API) ── Phase H (Init API)
    |
    v
  Phase I (Facilitator LLM)
    |
    v
  Phase J (sle discover) ── Phase K (Discovery API)
    |
    v
  Phase L (Integration Test)
```

---

## 3. Implementation Phases

### Phase A: Foundation Types

**Spec reference:** `types.md` (all sections)
**Implements:** Zod schemas and TypeScript type definitions for the entire system.

**Type names and their fields:**

#### Enumerations (`types.md` §1)

| Type name | Values | Zod schema |
|---|---|---|
| `ProjectType` | `'api' \| 'ui' \| 'library' \| 'research' \| 'custom'` | `z.enum([...])` |
| `PlanningDepth` | `'minimal' \| 'standard' \| 'deep' \| 'research'` | `PlanningDepthEnum` |
| `SystemStatus` | `'idle' \| 'discovering' \| 'cycling' \| 'halted' \| 'complete'` | `z.enum([...])` |
| `CycleOutcome` | `'cycling' \| 'completed' \| 'halted'` | `z.enum([...])` |
| `DiscoveryStatus` | `'not_started' \| 'in_progress' \| 'complete'` | `z.enum([...])` |
| `AgentRole` | `'designer' \| 'explorer' \| 'planner' \| 'tester' \| 'builder' \| 'debugger' \| 'evaluator' \| 'critic' \| 'historian' \| 'facilitator'` | `AgentRoleEnum` |
| `GeneratorRole` | `AgentRole \| 'discovery'` | Union type |
| `ValidationMethod` | `'llm' \| 'executable' \| 'both'` | `ValidationMethodEnum` |
| `CategoryStatus` | `'passed' \| 'failed' \| 'pending' \| 'skipped'` | `z.enum([...])` |
| `CapBehavior` | `'halt_with_report' \| 'user_prompt' \| 'force_pass'` | `CapBehaviorEnum` |
| `ErrorBehavior` | `'halt' \| 'retry_once' \| 'notify_and_wait'` | `ErrorBehaviorEnum` |
| `TimeoutAction` | `'auto_approve' \| 'halt' \| 'notify_and_wait'` | `TimeoutActionEnum` |
| `SummaryFormat` | `'markdown' \| 'html' \| 'json'` | `SummaryFormatEnum` |
| `TestCommandFormat` | `'shell' \| 'npm_script' \| 'makefile'` | `TestCommandFormatEnum` |
| `ArtifactFormat` | `'markdown' \| 'json' \| 'yaml'` | `ArtifactFormatEnum` |
| `OutputType` | `'executable' \| 'html' \| 'markdown'` | `OutputTypeEnum` |
| `GeneratedAt` | `'gate_pass' \| 'cycle_end' \| 'always'` | `GeneratedAtEnum` |
| `LLMProvider` | `'openai_compatible' \| 'anthropic'` | `LLMProviderEnum` |
| `ArtifactScope` | `'project' \| 'group' \| 'run' \| 'ephemeral'` | `z.enum([...])` |
| `ArtifactRef` | `` `doc:${string}` \| `node:${string}:${string}` `` | Template literal type |
| `ContextAssemblyMode` | `'declared' \| 'inferred'` | `z.enum([...])` |
| `SourceWeight` | `'user_defined' \| 'cycle_produced' \| 'inferred'` | `z.enum([...])` |
| `TagPrefix` | `'next-cycle' \| 'scope' \| 'area'` | `z.enum([...])` |
| `VersionBump` | `'major' \| 'minor' \| 'patch'` | `z.enum([...])` |
| `SubPhase` | `'static-check' \| 'llm-check' \| 'exec-check'` | `z.enum([...])` |
| `OpenQuestionBlocking` | `` `phase:${number}` \| 'not_blocking' `` | Template literal type |
| `NodeTag` | `{ prefix, value?, source, applied_at }` | `z.object({...})` |
| `DiscoveryMode` | `'full' \| 'solo'` | `z.enum([...])` |

#### System State types (`types.md` §2)

| Type name | Fields | Phase used |
|---|---|---|
| `ChatState` | `session_open: boolean, session_id?: string, started_at?: string` | C |
| `CycleFlags` | `awaiting_scoping, awaiting_confirmation, awaiting_sharding_approval: boolean` | C |

#### Agent Config types (`types.md` §3)

| Type name | Key fields |
|---|---|
| `AgentLLMConfig` | `provider, base_url?, api_key_env, model` |
| `AgentRoleConfig` | `active, node, llm, temperature, max_tokens, system_prompt, artifact_slice[], outputs[], conditional, condition?, constraints?, append_only?, session_types?, trigger_node?` |
| `AgentsConfig` | `defaults: { llm, temperature, max_tokens, system_prompt_root }, providers: Record<string, AgentLLMConfig>, agents: Record<string, AgentRoleConfig>` |

#### DAG types (`types.md` §4) -- interface-only stubs

| Type name | Key fields | Notes |
|---|---|---|
| `DAGNode` | Enum with 15 values | Stub enum only |
| `DAGState` | `current, iteration, max_iterations, started_at, history[]` | Interface only |
| `DAGEvent` | `node, type, timestamp, data?` | Interface only |
| `CycleState` | `number, iteration, revision, max_iterations, planning_depth, started_at, completed_at?, outcome, approval_gate, awaiting_scoping, awaiting_confirmation, awaiting_sharding_approval, last_summary?` | Interface only |
| `CycleExecutionSummary` | Various execution stats | Deferred |
| `VersionSnapshot` | Various snapshot fields | Deferred |

#### Artifact types (`types.md` §5)

| Type name | Key fields |
|---|---|
| `ArtifactRule` | `id, path?, generator, required, append_only, format` |
| `GeneratedOutputRule` | `id, path, type, generated_at` |
| `ArtifactsConfig` | `artifacts: ArtifactRule[], generated_outputs: GeneratedOutputRule[]` |
| `ArtifactEntry` | `path, generator, required, append_only?, scope?, source_weight?, version_produced?, last_updated, dirty` |

#### Validation types (`types.md` §6) -- interface-only stubs for config

| Type name | Key fields | Notes |
|---|---|---|
| `ValidationRuleCategory` | `name, method, executable?, llm?, pass_criteria, on_fail` | Full schema needed for rule files |
| `StaticAnalysisCheck` | `command, enabled, pass_criteria` | |
| `StaticAnalysisConfig` | `lint, typecheck, complexity` | |
| `ContainerConfig` | `base_image, install_command, timeout_ms` | |
| `ValidationConfig` | `static_analysis, container, categories[]` | Full schema needed for rule files |
| `CategoryResult` | `name, method, llm?, executable?, passed` | Deferred |
| `GateResult` | `passed, category_results[], static_analysis, failed_categories[], failure_report?` | Deferred |

#### Context types (`types.md` §7) -- interface-only

| Type name | Fields | Notes |
|---|---|---|
| `AssembledContext` | `system_prompt, artifact_slices, state_summary, task, failure_context?, token_count, truncated[]` | Interface only |
| `SliceRule` | `artifact_id, mode, max_entries?, max_tokens?, never_truncate?, source_weight?` | Interface only for Phase D |
| `ContextManagerConfig` | `artifact_slice_size, summary_max_tokens, system_prompt_max_tokens, hard_ceiling` | Interface only for Phase D |

#### Config types (`types.md` §8) -- all needed for rule files

| Type name | Key fields |
|---|---|
| `PlanningConfig` | `depth, max_iterations, artifact_slice_size, summary_max_tokens, system_prompt_max_tokens, reasoning_passes, critic_enabled, on_depth_change` |
| `ExitConfig` | `conditions: { all_categories_pass, requirements_met }, on_cap_hit, halt_behavior, on_error` |
| `UserValidationConfig` | `approval_required, review_at[], prompts, timeout_minutes, on_timeout, auto_approve_on_rerun` |
| `SummaryConfig` | `format, sections[], test_command_format, show_confidence_scores, show_failed_test_ids, what_was_built_max_tokens, next_steps_max_count, output_path` |
| `RuntimeConfig` | `planning, validation, artifacts, exit, user_validation, summary, agents` |

#### Init & Discovery types (`types.md` §9)

| Type name | Key fields |
|---|---|
| `InitState` | `last_completed_step, project: { name, description, description_long?, type }, remotes: { code, issues, docs }, task_store: { provider }, beads_initialised, docs_cloned, committed` |
| `InitOptions` | `name?, description?, type?, code_remote?, issues_remote?, docs_remote?, prefix?, no_editor?, no_daemon?, resume?, reset?, non_interactive?` |
| `OpenQuestion` | `title, status, blocking, owner?, resolve_by?, context` |
| `DiscoveryState` | `status, mode, completed_at?, artifacts[], current_round, total_rounds, current_phase, total_phases, open_questions_count, blocking_questions_count` |

#### map.yaml types (`types.md` §10)

| Type name | Fields |
|---|---|
| `GitRemote` | `type: 'git', url, branch` |
| `DoltRemote` | `type: 'dolt', url, local_dir, bd_prefix` |
| `AgentMdMapRef` | `map: string` |

#### Task Store types (`types.md` §11)

| Type name | Fields |
|---|---|
| `SLETask` | `id, title, description, status, priority, dependencies[], context_declarations?, created_at, updated_at, stale?` |
| `TaskContextDeclaration` | `task_id, slices: ArtifactRef[], intent` |
| `TaskStore` | Interface: `createTask, getReadyTasks, updateStatus, closeTask, getStale` |

#### Zod validation schemas (`types.md` §12)

All Zod schemas from `types.md` §12 must be implemented verbatim:
- `PlanningSchema`, `ValidationSchema`, `ArtifactsSchema`, `ExitSchema`, `UserValidationSchema`, `SummarySchema`, `AgentsSchema`, `RuntimeConfigSchema`
- All enum schemas: `PlanningDepthEnum`, `AgentRoleEnum`, `LLMProviderEnum`, etc.

#### Daemon types (`daemon-api.md` §Data model)

| Type name | Fields |
|---|---|
| `DaemonInfo` | `version, pid, port, started_at, uptime_ms, project_root, sle_version` |
| `ConnectionState` | `clients, subscriptions[], max_clients` |
| `APIResponse<T>` | `ok: boolean, data: T, meta?: { request_id, timestamp }` |
| `APIError` | `ok: false, error: { code, message, details? }, meta: { request_id, timestamp }` |

#### Discovery types (`init-and-discovery.md` §Data model)

| Type name | Fields |
|---|---|
| `DiscoverySessionState` | `session_id, mode, current_round, round_status, completed_rounds[], artifacts_written[], open_questions_deferred[], started_at, last_interaction_at` |

**Acceptance criteria:**
- All Zod schemas pass unit tests with valid and invalid fixtures
- All TypeScript types are exported and match the spec exactly
- `RuntimeConfigSchema.parse()` accepts valid config objects and rejects invalid ones with field paths
- No `any` types in public interfaces

**Tests needed:**
- Unit test per Zod schema with valid/invalid fixtures
- Cross-schema validation (e.g., `AgentsSchema` requires `planner` agent)

---

### Phase B: Runtime Map (map.yaml)

**Spec reference:** `state-machine.md` §Data model (map.yaml as source of truth), `types.md` §10
**Implements:** Schema definition, atomic file read/write, in-memory RuntimeMap type.

**RuntimeMap schema (composite):**

The full `map.yaml` schema is defined in `reference/map-yaml-schema.md` and built from types across multiple spec sections. For this slice, the RuntimeMap must include:

```typescript
interface RuntimeMap {
  meta: {
    status: SystemStatus
    cycle: number
    version_id: string
    initialized_at: string
    updated_at: string
  }
  project: {
    name: string
    description: string
    description_long?: string
    type: ProjectType
  }
  remotes: {
    code: GitRemote
    issues: GitRemote | DoltRemote
    docs: { url: string; pending: boolean }
  }
  task_store: {
    type: 'beads' | 'local'
    path?: string
  }
  agents: Record<string, {
    active: boolean
    node: string | null
    llm: AgentLLMConfig
  }>
  discovery: DiscoveryState
  cycle: {
    number: number
    iteration: number
    revision: number
    max_iterations: number
    planning_depth: PlanningDepth
    started_at?: string
    completed_at?: string
    outcome: CycleOutcome
    approval_gate: string | null
    awaiting_scoping: boolean
    awaiting_confirmation: boolean
    awaiting_sharding_approval: boolean
    last_summary?: { path: string; generated_at: string }
  }
  chat: ChatState
  artifacts: ArtifactEntry[]
  validation: {
    categories: ValidationCategory[]
    gate: ValidationGate
  }
}
```

**Atomic write behavior** (`daemon-api.md` constraint 5, `state-machine.md` constraint 1):
1. Write to `.sle/map.yaml.tmp` (temp file)
2. `fs.rename('.sle/map.yaml.tmp', '.sle/map.yaml')` (atomic on same filesystem)
3. On crash during write, the temp file is orphaned; `map.yaml` retains previous state
4. On daemon start, clean up any `.tmp` files found

**Atomic read behavior:**
1. Read entire `map.yaml` into memory
2. Parse and validate against RuntimeMap Zod schema
3. Cache in memory; invalidate on write
4. Never read partial state

**Acceptance criteria:**
- `writeMap(map)` writes atomically (temp + rename)
- `readMap()` returns validated RuntimeMap or throws
- Concurrent writes are serialized (mutex)
- Crash recovery: orphaned `.tmp` files cleaned on startup
- Initial map.yaml generated by `sle init` validates against schema

**Tests needed:**
- Unit: atomic write produces valid YAML
- Unit: read after write round-trips correctly
- Unit: corrupted YAML throws with field path
- Unit: concurrent writes are serialized
- Integration: crash recovery cleans up temp files

---

### Phase C: State Machine

**Spec reference:** `state-machine.md` (complete document)
**Implements:** 5 states, 12 transitions, 3 flags, StateContext computation.

**State enum:** `SystemStatus = 'idle' | 'discovering' | 'cycling' | 'halted' | 'complete'`

**Complete transition table** (`state-machine.md` §Transition table):

| # | From | To | Trigger | Precondition | Side effects |
|---|---|---|---|---|---|
| T1 | `idle` | `discovering` | `sle discover` | `discovery_status !== 'complete'` | Create discovery session, set `active_session_id` |
| T2 | `discovering` | `idle` | Discovery session ends | Discovery session in terminal round | Write discovery artifacts, set `discovery_status := complete`, clear `active_session_id` |
| T3 | `idle` | `cycling` | `sle start "goal"` | `discovery_status === 'complete'` | Create cycle record, set `active_cycle_id`, `iteration := 1`, `revision := 0` |
| T4 | `cycling` | `cycling` | VALIDATION gate fails, cap not reached | `iteration < iteration_cap` | `iteration++`, inject FailureReport, clear run artifacts |
| T5 | `cycling` | `halted` | User issues `sle halt` | `system.state === 'cycling'` | Write partial report, preserve run artifacts |
| T6 | `cycling` | `halted` | VALIDATION gate fails, cap reached | `iteration >= iteration_cap` | Write partial report with cap-exceeded notice |
| T7 | `cycling` | `halted` | Unrecoverable error | Any node | Write error report, preserve artifacts |
| T8 | `cycling` | `complete` | SNAPSHOT node finishes | All categories pass, EVALUATE done | Lock snapshot, write changelog, increment version |
| T9 | `complete` | `idle` | Snapshot acknowledgement | Snapshot is locked | Clear `active_cycle_id`, persist versioned artifacts |
| T10 | `halted` | `idle` | User acknowledges halt report | Halt report has been read | Clear `active_cycle_id` |
| T11 | `idle` | `cycling` | `sle start "goal" --force` | None (skips discovery check) | Same as T3 but no discovery guard |
| T12 | `halted` | `cycling` | `sle resume` | Halted state, user confirmation | Iteration count preserved |

**StateContext computation** (`state-machine.md` §State context):

```typescript
interface StateContext {
  state: SystemStatus
  active_session_id: string | null
  active_cycle_id: string | null
  discovery_status: DiscoveryStatus
  iteration: number
  revision: number
}
```

Populated from `map.yaml` on every daemon tick. Exposed via `GET /api/v2/system/state`.

**Flag rules** (`state-machine.md` §Constraints 5-6):
- At most one of `awaiting_scoping`, `awaiting_confirmation`, `awaiting_sharding_approval` may be `true`
- Setting one to `true` implicitly sets the others to `false`
- All flags reset to `false` when cycle ends (transition to halted/complete/idle)

**Chat independence** (`state-machine.md` §Constraints 4):
- `chat.session_open` may be `true` in any state
- Transitions T1-T12 proceed regardless of chat state
- Chat never blocks, delays, or cancels a state transition

**Acceptance criteria:**
- All 12 transitions implemented with precondition checking
- Invalid transitions return 409 with `allowed` targets
- Flag exclusivity enforced on every mutation
- Flags reset on cycle-end transitions
- StateContext computed correctly from map.yaml state

**Tests needed:**
- Unit test per transition (12 tests) with valid and invalid preconditions
- Unit: flag exclusivity enforcement
- Unit: flag reset on cycle end
- Unit: StateContext computation from various map.yaml states
- Unit: discovery guard on T3 (blocked when `discovery_status !== 'complete'`)
- Unit: T11 bypasses discovery guard

---

### Phase D: Rule File Schemas

**Spec reference:** `rule-files.md` (complete document), `types.md` §8, §12
**Implements:** Zod schemas for 7 rule files, default value generation per project type, template rendering.

**The 7 rule files** (`rule-files.md` §Overview):

| File | Zod schema | Default varies by project type? |
|---|---|---|
| `planning.yaml` | `PlanningSchema` | Yes (depth, iterations) |
| `validation.yaml` | `ValidationSchema` | Yes (category set) |
| `artifacts.yaml` | `ArtifactsSchema` | No |
| `exit.yaml` | `ExitSchema` | No |
| `user_validation.yaml` | `UserValidationSchema` | No |
| `summary.yaml` | `SummarySchema` | No |
| `agents.yaml` | `AgentsSchema` | No (DDR-002) |

**Default values by project type** (`init-and-discovery.md` §Project type defaults, `rule-files.md` §Behavior):

| ProjectType | Default depth | Default categories |
|---|---|---|
| `api` | `standard` | correctness, performance, security |
| `ui` | `standard` | correctness, usability, performance |
| `library` | `standard` | correctness, compatibility, maintainability |
| `research` | `deep` | correctness, reproducibility |
| `custom` | `minimal` | correctness |

**agents.yaml defaults for all 10 roles** (`init-and-discovery.md` §Step 4):

| Role | `active` | `node` | `conditional` | Notes |
|---|---|---|---|---|
| Designer | `true` | `design` | `false` | |
| Explorer | `false` | `explore` | `true` (`user_initiated`) | DDR-023 |
| Planner | `true` | `plan` | `false` | |
| Tester | `true` | `test` | `false` | |
| Builder | `true` | `build` | `false` | Highest token budget (16000) |
| Debugger | `true` | `debug` | `true` (`gate_failure`) | |
| Evaluator | `true` | `evaluate` | `false` | |
| Critic | `true` | `critique` | `true` (`depth_deep_or_research`) | DDR-022 |
| Historian | `true` | `history` | `false` | |
| Facilitator | `true` | `null` | `false` | Discovery + chat only |

Default LLM: `provider: openai_compatible, model: gpt-4o, api_key_env: OPENAI_API_KEY`.

**Template generation:**
- `generateRuleFiles(projectType: ProjectType): Record<string, object>` produces all 7 file contents
- Each output validated against its Zod schema before writing
- Written to `.sle/rules/` during `sle init` step 4

**Loading order** (`rule-files.md` §Loading order):
1. `planning.yaml` (depth, critic_enabled)
2. `agents.yaml` (agent roles, LLM config)
3. `artifacts.yaml` (document declarations)
4. `validation.yaml` (categories)
5. `exit.yaml` (conditions)
6. `user_validation.yaml` (approval gates)
7. `summary.yaml` (format, sections)

**Merge semantics** (`rule-files.md` §Merge semantics):
- Deep merge: nested keys override individually
- Array merge: replaced wholesale (not element-wise)
- Three layers: global defaults -> `.sle/rules/` -> `.sle/overrides/`

**Acceptance criteria:**
- All 7 Zod schemas validate valid/invalid fixtures
- Default generation for each ProjectType produces valid config
- Cross-file validation (e.g., unknown generator in artifacts.yaml references agents.yaml)
- Schema validation errors include field path and (when possible) line number

**Tests needed:**
- Unit: each schema with valid fixtures per project type
- Unit: each schema rejects invalid fixtures
- Unit: default generation for all 5 project types
- Unit: cross-file consistency checks
- Unit: merge semantics (override values at each layer)

---

### Phase E: Daemon Shell

**Spec reference:** `daemon-api.md` (complete document), `architecture.md` (L3 tier)
**Implements:** HTTP server, startup validation, graceful shutdown, PID file, WebSocket server.

**Server configuration** (`daemon-api.md` §Overview):
- Transport: HTTP REST + WebSocket on single port (default 7700)
- Bind to localhost only (no auth -- `daemon-api.md` constraint 12)
- API prefix: `/api/v2`

**Startup validation sequence** (`daemon-api.md` §Behavior §Startup sequence):

```
1. Parse CLI flags (port, foreground, config-dir)
2. Load map.yaml -- parse and validate schema
3. Validate rule files in .sle/rules/ (all seven files)
4. Check agent.md exists and map: reference block resolves
5. Verify all required: true artifacts exist or are not-yet-generated
6. Check Beads remote reachable (bd status) -- SKIP for LocalTaskStore
7. Check docs remote reachable (git -C .server status) -- SKIP if pending: true
8. If any check fails -> exit with descriptive error
9. Restore state from map.yaml
   - If meta.status is cycling and awaiting flag -> resume at gate
   - If meta.status is cycling with no flag -> resume from last DAG node
   - If halted -> stay halted, await user acknowledgement
   - If idle or complete -> transition to idle
10. Bind HTTP server on configured port (default 7700)
11. Bind WebSocket server on same port
12. Emit system.ready event
13. Accept connections
```

For this slice, steps 5, 9 (cycling/halted recovery), and 12-13 (DAG-related events) are simplified:
- Step 5: Check that required artifacts from init exist (discovery artifacts may not exist yet)
- Step 9: Only `idle` and `discovering` states are recoverable at this point
- Steps 12-13: Emit `system.ready` only

**Graceful shutdown** (`daemon-api.md` constraint 14):
1. `SIGTERM` triggers shutdown
2. Stop accepting new connections
3. Complete in-flight requests
4. Emit `system.shutdown` event
5. Write current state to `map.yaml`
6. Exit

**PID file** (`daemon-api.md` constraint 2):
- Written to `.sle/daemon.pid` on start
- Contains process PID
- Stale PID file (dead process) cleaned up automatically
- Prevents duplicate daemon starts

**Request lifecycle** (`daemon-api.md` §Behavior §Request lifecycle):
1. Client sends HTTP request
2. Daemon validates request schema
3. Daemon checks system state preconditions
4. Daemon executes command
5. Daemon writes result atomically to map.yaml (if state changed)
6. Daemon sends REST response
7. Daemon broadcasts WebSocket event (if state changed)

**Concurrent client handling** (`daemon-api.md` §Behavior):
- Multiple WebSocket clients may connect simultaneously
- REST commands serialized -- only one state-changing command at a time
- Concurrent state-changing commands receive 409 `session_conflict`
- Read endpoints (`GET`) never blocked by state-changing commands

**Error propagation** (`daemon-api.md` §Error propagation):
- REST 4xx: `APIError` with `code` and `message` -- client corrects and retries
- REST 5xx: `APIError` with `code` and `message` -- daemon bug or infrastructure
- WebSocket: `ErrorPayload` with `recoverable` flag

**Acceptance criteria:**
- Daemon starts on port 7700 and responds to `GET /api/v2/health`
- Startup validation rejects invalid config with descriptive error
- `SIGTERM` triggers graceful shutdown
- PID file prevents duplicate starts
- Stale PID file cleaned up
- WebSocket clients receive `system.ready` on connect
- Concurrent state-changing requests return 409

**Tests needed:**
- Integration: daemon starts and health check succeeds
- Integration: startup fails with invalid map.yaml
- Integration: graceful shutdown completes
- Integration: PID file prevents duplicate start
- Integration: WebSocket client receives events

---

### Phase F: State API

**Spec reference:** `daemon-api-endpoints.md` §Health & info, §System state
**Implements:** Health check, daemon info, get system state, transition state.

**Endpoints:**

| Method | Path | Phase |
|---|---|---|
| `GET` | `/api/v2/health` | F |
| `GET` | `/api/v2/info` | F |
| `GET` | `/api/v2/system/state` | F |
| `POST` | `/api/v2/system/state/transition` | F |

#### GET /api/v2/health

```
Response 200:
{
  "ok": true,
  "data": {
    "status": "healthy",
    "uptime_ms": number,
    "version": string
  }
}
```

Returns 503 if shutting down or startup validation failed partway.

#### GET /api/v2/info

```
Response 200:
{
  "ok": true,
  "data": DaemonInfo
}
```

`DaemonInfo` fields: `version, pid, port, started_at, uptime_ms, project_root, sle_version`.

#### GET /api/v2/system/state

```
Response 200:
{
  "ok": true,
  "data": {
    "state": "idle" | "discovering" | "cycling" | "halted" | "complete",
    "active_session_id": string | null,
    "active_cycle_id": string | null,
    "discovery_status": "not_started" | "in_progress" | "complete",
    "iteration": number,
    "revision": number,
    "awaiting_confirmation": boolean,
    "awaiting_sharding_approval": boolean,
    "awaiting_scoping": boolean,
    "chat": {
      "session_open": boolean
    }
  }
}
```

Source: `state-machine.md` §API contract §Get system state.

#### POST /api/v2/system/state/transition

```
Request:
{
  "target": SystemStatus,
  "trigger": string,
  "payload": object | null
}

Response 200:
{
  "ok": true,
  "data": {
    "previous": SystemStatus,
    "current": SystemStatus,
    "cycle_id": string | null
  }
}

Response 409:
{
  "ok": false,
  "error": {
    "code": "invalid_transition",
    "message": "Transition from {from} to {to} is not valid.",
    "details": {
      "from": SystemStatus,
      "to": SystemStatus,
      "allowed": SystemStatus[]
    }
  }
}
```

Source: `state-machine.md` §API contract §Transition state.

**WebSocket events emitted by state changes:**

```
event: system.state_changed
{
  "previous": SystemStatus,
  "current": SystemStatus,
  "trigger": string,
  "timestamp": string
}
```

**Acceptance criteria:**
- Health check returns 200 when daemon is running
- `GET /system/state` returns current state from map.yaml
- `POST /system/state/transition` enforces transition table
- Invalid transitions return 409 with `allowed` list
- State transitions broadcast `system.state_changed` event

**Tests needed:**
- Unit: state endpoint returns correct state
- Integration: transition T1 (idle -> discovering) succeeds
- Integration: invalid transition returns 409
- Integration: WebSocket receives state_changed event

---

### Phase G: sle init

**Spec reference:** `init-and-discovery.md` §Part 1
**Implements:** 11-step init sequence, resume, reset, non-interactive mode.

**Step sequence** (`init-and-discovery.md` §Step sequence):

```
Step 0:  Prerequisite check
Step 1:  Project identity
Step 2:  Project type selection
Step 3a: Code remote (detected from git)
Step 3b: Issues remote + TaskStore provider (DDR-024)
Step 3c: Docs remote (.server)
Step 4:  Rule file generation (7 files)
Step 5:  TaskStore initialisation (Beads or local)
Step 6:  Docs remote clone
Step 7:  agent.md + map.yaml generation
Step 8:  Prompt template installation
Step 9:  Initial commit + push
Step 10: Daemon start + startup validation
```

**Step 0 -- Prerequisite check** (`init-and-discovery.md` §Step 0):

| Check | Pass condition |
|---|---|
| Git repo | `git rev-parse --is-inside-work-tree` exits 0 |
| Origin remote | `git remote get-url origin` exits 0 |
| Node.js 20+ | `process.version` major >= 20 |
| `.sle/` absent | `!fs.existsSync('.sle/')` |

**Step 1 -- Project identity** (`init-and-discovery.md` §Step 1):
- Name inferred from origin URL (`git@github.com:org/my-project.git` -> `my-project`), editable
- Description required (re-prompts if empty)
- Optional long description for agent.md

**Step 2 -- Project type selection** (`init-and-discovery.md` §Step 2):
- User selects from: `api | ui | library | research | custom`
- Sets default validation categories, planning depth, artifact set

**Step 3a -- Code remote** (`init-and-discovery.md` §Step 3a):
- Detected from `git remote get-url origin`
- Branch from `git branch --show-current`
- Written to `map.yaml -> remotes.code`

**Step 3b -- Issues remote + TaskStore** (`init-and-discovery.md` §Step 3b):
- User chooses: `beads` or `local`
- Beads: suggests Dolt remote URL, collects prefix (2-4 chars)
- Local: creates `.sle/tasks.yaml` with `tasks: []`
- Written to `InitState.task_store.provider` and `map.yaml -> remotes.issues`

For this slice, only `local` mode is fully functional. `beads` mode records the choice but `bd init` is deferred to a post-MVP slice. The `BeadsTaskStore` implementation is a stub that throws "not implemented".

**Step 3c -- Docs remote** (`init-and-discovery.md` §Step 3c):
- Suggests URL from code remote with `.server` suffix
- If unavailable, sets `remotes.docs.pending: true`
- Daemon refuses to start until resolved (or pending flag is cleared)

**Step 4 -- Rule file generation** (`init-and-discovery.md` §Step 4):
- No user input
- Generates all 7 files from project type template (see Phase D)

**Step 5 -- TaskStore initialisation** (`init-and-discovery.md` §Step 5):
- Local: writes `.sle/tasks.yaml` with `tasks: []`
- Beads: deferred (stub)

**Step 6 -- Docs remote clone** (`init-and-discovery.md` §Step 6):
- `git clone {url} .server`
- Adds `.server` to `.gitignore`
- Creates symlink `docs -> .server/docs`

**Step 7 -- agent.md + map.yaml generation** (`init-and-discovery.md` §Step 7):
- `agent.md`: written once, never touched again. Contains project description, conventions, constraints. Includes `map:` reference block pointing to `.sle/map.yaml`.
- `map.yaml`: initial state with `meta.status: idle`, `discovery.status: not_started`, all agents from `agents.yaml` defaults
- Both opened in `$EDITOR` if set and `--no-editor` not set

**Step 8 -- Prompt template installation** (`init-and-discovery.md` §Step 8):
- Installs all 10 role prompt templates to `.sle/prompts/`
- Validation check prompts filtered by project type

**Step 9 -- Initial commit** (`init-and-discovery.md` §Step 9):
- `git add .sle/ agent.md`
- `git commit -m "chore: initialise SLE project"`
- `git push origin main` (failure is non-fatal)

**Step 10 -- Daemon start** (`init-and-discovery.md` §Step 10):
- Starts daemon on port 7700
- Runs startup validation (7 checks from Phase E)
- Skipped if `--no-daemon` set

**Resume behaviour** (`init-and-discovery.md` §Resume behaviour):

Step classification:

| Type | Steps | Resume behaviour |
|---|---|---|
| Idempotent | 0, 2, 4, 7, 8, 10 | Always re-run |
| Side-effect | 5, 6, 9 | Skipped if boolean flag is `true` |
| Input collection | 1, 3 | Re-read from init-state.json |

`InitState` persisted to `.sle/init-state.json` after every step. Deleted on successful completion.

**Reset behaviour** (`init-and-discovery.md` §Reset):
- Removes `.sle/`, `.beads/`, `.server/`, `docs` symlink, `agent.md`
- Requires confirmation (project name)
- Re-runs `sle init` from step 0

**Non-interactive mode** (`init-and-discovery.md` §Non-interactive mode):
All values passed as CLI flags. `--no-daemon` skips step 10.

**Files created by successful init** (`init-and-discovery.md` §Files created):

```
project-root/
  agent.md
  docs -> .server/docs
  .sle/
    map.yaml
    daemon.pid
    tasks.yaml              (local mode only)
    rules/                  (7 files)
    prompts/                (10 role prompts + validation checks)
```

**Error codes** (`init-and-discovery.md` §Init errors E100-E109):

| Code | Name | Condition |
|---|---|---|
| E100 | `init_already_initialised` | `.sle/` exists and `--reset` not set |
| E101 | `init_no_git_repo` | Not inside git working tree |
| E102 | `init_no_origin` | No git remote named origin |
| E103 | `init_beads_failure` | `bd init` returns non-zero |
| E104 | `init_docs_clone_failure` | `git clone` for docs remote fails |
| E105 | `init_commit_failure` | `git commit` or `git add` fails |
| E106 | `init_push_failure` | `git push origin` fails (warning) |
| E107 | `init_daemon_start_failure` | Daemon process fails to start |
| E108 | `init_state_corrupted` | `.sle/init-state.json` invalid JSON |
| E109 | `init_task_store_unsupported` | `--task-store` not `beads` or `local` |

**Acceptance criteria:**
- Full init completes successfully, all files created
- Resume skips completed side-effect steps
- Reset removes all created files and re-runs
- Non-interactive mode creates identical result
- Error codes match spec (E100-E109)
- InitState persisted between steps

**Tests needed:**
- Integration: full init flow (happy path)
- Integration: resume after failure at each step
- Integration: reset and re-init
- Integration: non-interactive mode
- Unit: prerequisite checks
- Unit: project name inference from git URL
- Unit: InitState serialization/deserialization

---

### Phase H: Init API

**Spec reference:** `daemon-api-endpoints.md` §Init
**Implements:** 3 init endpoints + WebSocket events.

**Endpoints:**

| Method | Path | Phase |
|---|---|---|
| `POST` | `/api/v2/init` | H |
| `GET` | `/api/v2/init/status` | H |
| `POST` | `/api/v2/init/reset` | H |

#### POST /api/v2/init

```
Request:
{
  "project_name": string,
  "project_type": "api" | "ui" | "library" | "research" | "custom",
  "task_store": "beads" | "local",
  "daemon_port": number,
  "docs_remote": string | null,
  "non_interactive": boolean
}

Response 200:
{
  "ok": true,
  "data": {
    "status": "complete" | "partial",
    "step": number,
    "message": string,
    "files_created": string[]
  }
}

Response 409:
{
  "ok": false,
  "error": {
    "code": "already_initialised",
    "message": ".sle/ directory already exists."
  }
}
```

#### GET /api/v2/init/status

```
Response 200:
{
  "ok": true,
  "data": {
    "initialised": boolean,
    "current_step": number | null,
    "total_steps": number,
    "last_file_created": string | null
  }
}

Response 404:
{
  "ok": false,
  "error": {
    "code": "no_init_state",
    "message": "No init-state.json found. Run POST /api/v2/init first."
  }
}
```

#### POST /api/v2/init/reset

```
Request:
{
  "confirm_name": string
}

Response 200:
{
  "ok": true,
  "data": {
    "removed": string[]
  }
}

Response 403:
{
  "ok": false,
  "error": {
    "code": "name_mismatch",
    "message": "confirm_name does not match project name."
  }
}
```

**WebSocket events** (`init-and-discovery.md` §WebSocket events):

```
event: init.step_completed
{ step, name, status: "success"|"failed", message, timestamp }

event: init.complete
{ files_created, task_store: "beads"|"local", daemon_port, timestamp }
```

**Acceptance criteria:**
- `POST /init` runs full init sequence
- `GET /init/status` returns current progress
- `POST /init/reset` validates project name before deleting
- WebSocket events emitted for each step and on completion

**Tests needed:**
- Integration: full init via API
- Integration: status endpoint during init
- Integration: reset with wrong name returns 403
- Integration: WebSocket events received during init

---

### Phase I: Facilitator LLM Integration

**Spec reference:** `prompt-templates.md` §Facilitator templates, `agent-roles.md` §1. Facilitator, `init-and-discovery.md` §agent.md generation
**Implements:** LLM provider abstraction, Facilitator prompt templates (3 modes), agent.md generation.

**LLM provider abstraction:**

```typescript
interface LLMProvider {
  complete(params: {
    model: string
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
    temperature: number
    max_tokens: number
  }): Promise<{
    content: string
    tokens_used: number
    duration_ms: number
  }>
}
```

Two implementations:
- `OpenAICompatibleProvider` -- uses OpenAI API format (`LLMProvider: 'openai_compatible'`)
- `AnthropicProvider` -- uses Anthropic SDK (`LLMProvider: 'anthropic'`)

Selected from `agents.yaml -> defaults.llm.provider`. For this slice, only `openai_compatible` is required; `anthropic` is a stub.

**Facilitator prompt templates** (`prompt-templates.md`):

Three templates installed during `sle init`:

| File | Mode | Used during |
|---|---|---|
| `.sle/prompts/facilitator-chat.md` | Chat mode | `sle chat` (deferred) |
| `.sle/prompts/facilitator-decision.md` | Decision mode | Gate approvals (deferred) |
| `.sle/prompts/facilitator-scoping.md` | Scoping mode | SCOPING node (deferred) |

For this slice, the Facilitator operates in **discovery mode** (a variant of chat mode specific to the discovery flow). The discovery-specific system prompt is assembled from the template structure defined in `prompt-templates.md` §Template structure (all templates must follow):

1. `## Role identity` -- who, what, what NOT
2. `## Behavioral constraints` -- hard rules, bulleted
3. `## Artifact access` -- typed artifact refs this role may read/write
4. `## Output format` -- exact output schema
5. `## Reasoning approach` -- how to think about the task

The discovery-specific prompt template is generated dynamically during the discovery flow. It incorporates:
- Role identity: Facilitator in discovery mode
- Behavioral constraints: cannot modify code, start cycles, or modify rule files
- Artifact access: reads approved discovery docs, writes target artifact
- Output format: markdown document with required sections
- Reasoning approach: guided Q&A, cumulative context

**agent.md generation** (`init-and-discovery.md` §Step 7):

```markdown
# {project_name}

{description}
{description_long}

## Conventions
{auto-generated from project type defaults}

## Map
map: .sle/map.yaml
```

Written once at init. Never modified by the system. Opened in `$EDITOR` if set.

**Acceptance criteria:**
- `OpenAICompatibleProvider.complete()` returns structured response
- Facilitator discovery prompt follows 5-section template structure
- agent.md generated with correct map reference block
- API key loaded from environment variable specified in `agents.yaml`

**Tests needed:**
- Unit: LLM provider with mock HTTP response
- Unit: prompt template validation (5 sections present)
- Unit: agent.md generation
- Integration: LLM provider with real API key (optional, CI-skip)

---

### Phase J: sle discover

**Spec reference:** `init-and-discovery.md` §Part 2, `dag-node-reference.md` §DISCOVERY node (conceptual reference only)
**Implements:** Full discovery flow, solo mode, session state persistence.

**Prerequisites** (`init-and-discovery.md` §Prerequisites):
- `sle init` completed (daemon running, remotes configured)
- `map.yaml -> discovery.status` is `not_started` (or use `--revisit`)
- `map.yaml -> meta.status` is `idle`

**Commands** (`init-and-discovery.md` §Commands):

```bash
sle discover                  # start discovery
sle discover --revisit        # re-enter to revise existing docs
sle discover --from brief.md  # inject existing document
sle discover --solo           # lightweight mode for solo developers
sle discover --replan         # re-plan remaining phases
sle discover --status         # show progress
```

**Full mode flow** (`init-and-discovery.md` §Full mode flow):

```
1. T1: idle -> discovering
2. Round 1: Product Brief
   - Interactive Q&A -> docs/product-brief.md -> user approves
3. Round 2: Problem & Success Definition
   - Interactive Q&A -> docs/success-definition.md -> user approves
4. Round 3: Constraints & Boundaries
   - Interactive Q&A -> docs/constraints.md -> user approves
5. Round 4: Stakeholders & Decision Rights
   - Interactive Q&A -> docs/stakeholders.md -> user approves
6. Synthesis
   - LLM reads all 4 approved docs
   - Resolve-or-defer open questions
   - docs/system-description.md + docs/vision.md + docs/open-questions.md -> user approves
7. Planning Loop
   - LLM reads all 7 docs -> docs/project-plan.md
   - User reviews / reorders / splits / merges phases
   - User approves
8. Finalization
   - Create tasks for Phase 1 (via LocalTaskStore)
   - Block later phases
   - Update map.yaml -> discovery.status: complete
   - Update agent.md with discovery references
9. T2: discovering -> idle
```

**Solo mode** (`init-and-discovery.md` §Solo mode):

| Aspect | Full mode | Solo mode |
|---|---|---|
| Rounds | 4 + synthesis + planning | 2 + synthesis + planning |
| Documents | 8 | 6 |
| Stakeholders doc | Required | Skipped |
| Success definition | Separate | Merged into product-brief.md |
| System description | Separate synthesis | Merged into Round 2 |

Solo mode sets `discovery.mode: solo` in map.yaml.

**Round protocol** (`init-and-discovery.md` §Round protocol):

1. Opening question -- Facilitator asks a broad question about the domain
2. Free-form response -- user answers however they like
3. Follow-up loop -- Facilitator asks focused follow-up questions, one at a time, until it has enough information
4. Draft generation -- Facilitator produces the target artifact
5. User review -- approve / edit / revise
6. Revision loop -- if revise, user describes what's wrong, Facilitator revises, re-presents

No cap on follow-up exchanges. Facilitator reads all previously approved artifacts before each round (cumulative context).

**Discovery rounds detail** (`init-and-discovery.md` §Discovery rounds):

| Round | Artifact | Opening question topic |
|---|---|---|
| 1 | `docs/product-brief.md` | "What are you building?" |
| 2 | `docs/success-definition.md` | "What does success/failure look like?" |
| 3 | `docs/constraints.md` | "What's out of scope? Hard constraints?" |
| 4 | `docs/stakeholders.md` | "Who's involved? Decision-making?" |

**Artifact schemas** (`init-and-discovery.md` §Artifact schemas):

- `product-brief.md`: Overview, Target Audience, Value Proposition, Core Workflow, Differentiation
- `success-definition.md`: Problem Statement, Pain Points, Success Criteria, Failure Modes, MVP Exit Criteria
- `constraints.md`: Out of Scope, Technology Mandates, Regulatory, Integration Requirements, Timeline
- `stakeholders.md`: Product Owner, Primary Users, Technical Direction, Veto Power, RACI Matrix

**Synthesis step** (`init-and-discovery.md` §Synthesis step):
- `docs/system-description.md`: what the system IS and IS NOT
- `docs/vision.md`: MVP definition, near-term, long-term, architecture intent, non-negotiables
- `docs/open-questions.md`: user-explicitly-deferred items only

**Planning loop** (`init-and-discovery.md` §Planning loop):
- Each phase has: Scope, Exit criteria, Tasks, Dependencies, Complexity, Suggested categories
- User controls: Approve, Reorder, Merge, Split, Adjust scope

**Finalization** (`init-and-discovery.md` §Finalization):
1. Create tasks for Phase 1 via `LocalTaskStore.createTask()`
2. Block later phases (dependencies)
3. Update `map.yaml`: `discovery.status: complete`, record artifact paths, set phases
4. Update `map.yaml -> context.agent_slices.planner` to include discovery artifacts
5. Update `agent.md` with discovery references section
6. Delete `.sle/discovery-session.json`

**Session state persistence** (`init-and-discovery.md` §Discovery sessions are resumable):
- `.sle/discovery-session.json` written on every interaction
- On resume, flow continues at exact point of interruption

**Error codes** (`init-and-discovery.md` §Discovery errors E110-E119):

| Code | Name | Condition |
|---|---|---|
| E110 | `discovery_already_complete` | `sle discover` when status is complete |
| E111 | `discovery_not_initialised` | `sle discover` before `sle init` |
| E112 | `discovery_not_idle` | System not in idle state |
| E113 | `discovery_session_timeout` | No interaction for 30 minutes |
| E114 | `discovery_synthesis_conflict` | External modification during synthesis |
| E115 | `discovery_round_invalid` | Round N != current round |
| E116 | `discovery_plan_no_phases` | Plan generation produces zero phases |
| E117 | `discovery_task_create_failed` | TaskStore fails to create tasks |
| E118 | `discovery_from_file_not_found` | `--from` references non-existent file |
| E119 | `discovery_mode_conflict` | Mode upgrade conflict |

**Acceptance criteria:**
- Full mode: 4 rounds + synthesis + planning completes
- Solo mode: 2 rounds + synthesis + planning completes
- Each round produces approved artifact
- Synthesis produces 3 derived artifacts
- Planning produces project-plan.md with phases
- Finalization creates Phase 1 tasks in LocalTaskStore
- Session state persisted and resumable
- Open questions tracked correctly
- All error codes match spec

**Tests needed:**
- Integration: full discovery flow (mocked LLM)
- Integration: solo mode flow (mocked LLM)
- Integration: session resume after interruption
- Integration: revisit mode
- Unit: round protocol state machine
- Unit: synthesis from approved docs
- Unit: planning phase generation
- Unit: finalization (task creation, map.yaml update)
- Unit: error handling per code (E110-E119)

---

### Phase K: Discovery API

**Spec reference:** `daemon-api-endpoints.md` §Discovery
**Implements:** 12 discovery endpoints + WebSocket events.

**Endpoints:**

| Method | Path | Phase |
|---|---|---|
| `POST` | `/api/v2/discovery/start` | K |
| `POST` | `/api/v2/discovery/round/{n}/response` | K |
| `GET` | `/api/v2/discovery/round/{n}/draft` | K |
| `POST` | `/api/v2/discovery/round/{n}/approve` | K |
| `POST` | `/api/v2/discovery/round/{n}/revise` | K |
| `POST` | `/api/v2/discovery/synthesis/approve` | K |
| `POST` | `/api/v2/discovery/plan/approve` | K |
| `POST` | `/api/v2/discovery/plan/reorder` | K |
| `POST` | `/api/v2/discovery/plan/split/{phase}` | K |
| `POST` | `/api/v2/discovery/plan/merge` | K |
| `GET` | `/api/v2/discovery/status` | K |
| `POST` | `/api/v2/discovery/halt` | K |

#### POST /api/v2/discovery/start

```
Request:
{
  "resume": boolean,
  "mode": "full" | "solo",
  "from_file": string | null
}

Response 200:
{
  "ok": true,
  "data": {
    "session_id": string,
    "status": "in_progress",
    "mode": "full" | "solo",
    "current_round": 1,
    "total_rounds": 4 | 2,
    "phases_total": number,
    "opening_question": string
  }
}

Response 409: session_conflict | discovery_already_complete
```

Source: `daemon-api-endpoints.md` §Start discovery.

#### POST /api/v2/discovery/round/{n}/response

```
Request:
{
  "content": string
}

Response 200:
{
  "ok": true,
  "data": {
    "round": number,
    "status": "collecting" | "drafting" | "reviewing",
    "follow_up_question": string | null,
    "draft_available": boolean
  }
}

Response 400: invalid_round
```

Source: `daemon-api-endpoints.md` §Discovery round response.

#### GET /api/v2/discovery/round/{n}/draft

```
Response 200:
{
  "ok": true,
  "data": {
    "round": number,
    "artifact_path": string,
    "content": string,
    "status": "draft" | "approved" | "revising"
  }
}

Response 404: draft_not_ready
```

Source: `daemon-api-endpoints.md` §Get discovery round draft.

#### POST /api/v2/discovery/round/{n}/approve

```
Response 200:
{
  "ok": true,
  "data": {
    "round": number,
    "artifact_path": string,
    "next_round": number | null,
    "next_step": "round" | "synthesis" | "planning" | "complete"
  }
}
```

Source: `daemon-api-endpoints.md` §Approve discovery round.

#### POST /api/v2/discovery/round/{n}/revise

```
Request:
{
  "feedback": string
}

Response 200:
{
  "ok": true,
  "data": {
    "round": number,
    "status": "revising"
  }
}
```

Source: `daemon-api-endpoints.md` §Revise discovery round.

#### POST /api/v2/discovery/synthesis/approve

```
Response 200:
{
  "ok": true,
  "data": {
    "artifacts": string[],
    "next_step": "planning"
  }
}
```

Source: `daemon-api-endpoints.md` §Approve discovery synthesis.

#### POST /api/v2/discovery/plan/approve

```
Response 200:
{
  "ok": true,
  "data": {
    "plan_path": string,
    "total_phases": number,
    "phase1_tasks": number,
    "discovery_status": "complete"
  }
}
```

Source: `daemon-api-endpoints.md` §Approve discovery plan.

#### POST /api/v2/discovery/plan/reorder

```
Request:
{
  "phase_order": number[]
}

Response 200:
{
  "ok": true,
  "data": {
    "phase_order": number[]
  }
}
```

Source: `daemon-api-endpoints.md` §Reorder discovery plan phases.

#### POST /api/v2/discovery/plan/split/{phase}

```
Request:
{
  "split_after_task": number
}

Response 200:
{
  "ok": true,
  "data": {
    "original_phase": number,
    "new_phases": number[]
  }
}
```

Source: `daemon-api-endpoints.md` §Split discovery plan phase.

#### POST /api/v2/discovery/plan/merge

```
Request:
{
  "phases": number[]
}

Response 200:
{
  "ok": true,
  "data": {
    "merged_phase": number
  }
}
```

Source: `daemon-api-endpoints.md` §Merge discovery plan phases.

#### GET /api/v2/discovery/status

```
Response 200:
{
  "ok": true,
  "data": {
    "status": "not_started" | "in_progress" | "complete",
    "session_id": string | null,
    "mode": "full" | "solo" | null,
    "current_phase": number,
    "total_phases": number,
    "completed_rounds": number[],
    "artifacts": string[],
    "completed_at": string | null,
    "open_questions_count": number,
    "blocking_questions_count": number
  }
}
```

Source: `daemon-api-endpoints.md` §Discovery status.

#### POST /api/v2/discovery/halt

```
Response 200:
{
  "ok": true,
  "data": {
    "session_id": string,
    "status": "halted",
    "completed_phases": number,
    "total_phases": number
  }
}

Response 409: halt_not_discovering
```

Source: `daemon-api-endpoints.md` §Halt discovery.

**WebSocket events** (`init-and-discovery.md` §WebSocket events):

```
event: discovery.round_started
{ session_id, round, opening_question, timestamp }

event: discovery.draft_ready
{ session_id, round, artifact_path, timestamp }

event: discovery.round_approved
{ session_id, round, artifact_path, next_round, timestamp }

event: discovery.complete
{ session_id, artifacts, total_phases, timestamp }
```

**Acceptance criteria:**
- All 12 endpoints return correct response shapes
- `POST /discovery/start` triggers T1 (idle -> discovering)
- `POST /plan/approve` triggers finalization + T2 (discovering -> idle)
- Round validation rejects invalid round numbers (E115)
- `POST /discovery/halt` only works during discovering state
- All WebSocket events emitted at correct times

**Tests needed:**
- Integration: start discovery -> submit response -> get draft -> approve -> next round
- Integration: full round-trip through all rounds
- Integration: synthesis and planning approval
- Integration: plan reorder/split/merge
- Integration: halt discovery
- Integration: invalid round number returns 400
- Integration: WebSocket events received

---

### Phase L: Integration Test

**Spec reference:** Cross-cutting (all above phases)
**Implements:** End-to-end acceptance test.

**Test flow:**

```
1. Create temp git repo with origin remote
2. Run sle init (non-interactive, type: api, task_store: local, no_daemon: false)
3. Verify all files created:
   - agent.md (with map: reference)
   - .sle/map.yaml (valid RuntimeMap, status: idle, discovery: not_started)
   - .sle/rules/ (7 files, all valid)
   - .sle/prompts/ (10+ files)
   - .sle/tasks.yaml (empty)
4. Start daemon
5. GET /api/v2/health -> 200
6. GET /api/v2/system/state -> status: idle, discovery_status: not_started
7. POST /api/v2/discovery/start -> session_id, mode: full, current_round: 1
8. GET /api/v2/system/state -> status: discovering
9. Round 1:
   - POST /round/1/response "Building an API for managing items"
   - (mock LLM responds with follow-up)
   - POST /round/1/response (answer follow-up)
   - GET /round/1/draft -> draft available
   - POST /round/1/approve -> next_round: 2
10. Round 2-4: same pattern (mocked LLM)
11. Synthesis:
    - POST /synthesis/approve -> artifacts: [...], next_step: planning
12. Planning:
    - POST /plan/approve -> discovery_status: complete
13. GET /api/v2/system/state -> status: idle, discovery_status: complete
14. Verify docs/ contains 8 artifact files
15. Verify .sle/tasks.yaml contains Phase 1 tasks
16. GET /api/v2/discovery/status -> status: complete
17. POST /api/v2/discovery/start -> 409 discovery_already_complete
```

**Acceptance criteria:**
- Full flow completes without errors
- All state transitions match spec
- All artifacts present and valid
- map.yaml reflects completed discovery
- Phase 1 tasks created in LocalTaskStore

---

## 4. Types Inventory

Complete list of types this slice needs, organized by implementation status:

### Fully implemented (Phase A)

| Type name | Source | Phase(s) used |
|---|---|---|
| `ProjectType` | `types.md:19` | A, D, G |
| `PlanningDepth` | `types.md:24` | A, D |
| `SystemStatus` | `types.md:29` | A, C, F |
| `CycleOutcome` | `types.md:34` | A, B |
| `DiscoveryStatus` | `types.md:39` | A, B, J |
| `DiscoveryMode` | `init-and-discovery.md:79` | A, J |
| `AgentRole` | `types.md:44` | A, D |
| `GeneratorRole` | `types.md:51` | A, D |
| `ValidationMethod` | `types.md:56` | A, D |
| `CategoryStatus` | `types.md:61` | A, B |
| `CapBehavior` | `types.md:66` | A, D |
| `ErrorBehavior` | `types.md:71` | A, D |
| `TimeoutAction` | `types.md:76` | A, D |
| `SummaryFormat` | `types.md:81` | A, D |
| `TestCommandFormat` | `types.md:86` | A, D |
| `ArtifactFormat` | `types.md:91` | A, D |
| `OutputType` | `types.md:96` | A, D |
| `GeneratedAt` | `types.md:101` | A, D |
| `LLMProvider` | `types.md:106` | A, I |
| `ArtifactScope` | `types.md:111` | A, B |
| `ArtifactRef` | `types.md:116` | A |
| `ContextAssemblyMode` | `types.md:121` | A |
| `SourceWeight` | `types.md:126` | A |
| `TagPrefix` | `types.md:131` | A |
| `NodeTag` | `types.md:136` | A |
| `VersionBump` | `types.md:146` | A |
| `SubPhase` | `types.md:151` | A |
| `OpenQuestionBlocking` | `types.md:156` | A, J |
| `ChatState` | `types.md:165` | A, B, C |
| `CycleFlags` | `types.md:174` | A, C |
| `AgentLLMConfig` | `types.md:189` | A, D, I |
| `AgentRoleConfig` | `types.md:199` | A, D |
| `AgentsConfig` | `types.md:219` | A, D |
| `ArtifactRule` | `types.md:370` | A, D |
| `GeneratedOutputRule` | `types.md:383` | A, D |
| `ArtifactsConfig` | `types.md:393` | A, D |
| `ArtifactEntry` | `types.md:403` | A, B |
| `ValidationRuleCategory` | `types.md:432` | A, D |
| `StaticAnalysisCheck` | `types.md:459` | A, D |
| `StaticAnalysisConfig` | `types.md:464` | A, D |
| `ContainerConfig` | `types.md:496` | A, D |
| `ValidationConfig` | `types.md:503` | A, D |
| `PlanningConfig` | `types.md:614` | A, D |
| `ExitConfig` | `types.md:628` | A, D |
| `UserValidationConfig` | `types.md:651` | A, D |
| `SummaryConfig` | `types.md:663` | A, D |
| `RuntimeConfig` | `types.md:679` | A, D |
| `InitState` | `types.md:698` | A, G |
| `InitOptions` | `types.md:719` | A, G |
| `OpenQuestion` | `types.md:739` | A, J |
| `DiscoveryState` | `types.md:751` | A, B, J |
| `GitRemote` | `types.md:770` | A, B |
| `DoltRemote` | `types.md:778` | A, B |
| `AgentMdMapRef` | `types.md:787` | A, G |
| `SLETask` | `types.md:799` | A, J |
| `TaskContextDeclaration` | `types.md:815` | A |
| `DaemonInfo` | `daemon-api.md:40` | A, E |
| `ConnectionState` | `daemon-api.md:56` | A, E |
| `APIResponse<T>` | `daemon-api.md:72` | A, E |
| `APIError` | `daemon-api.md:82` | A, E |
| `DiscoverySessionState` | `init-and-discovery.md:101` | A, J |

### Interface-only stubs (types defined but behavior deferred)

| Type name | Source | Deferred to |
|---|---|---|
| `AssembledContext` | `types.md:589` | v2 (context manager) |
| `SliceRule` | `context-manager.md:73` | v2 (context manager) |
| `ContextManagerConfig` | `context-manager.md:96` | v2 (context manager) |
| `AgentInput` | `types.md:236` | v3 (agent runtime) |
| `AgentResult` | `types.md:244` | v3 (agent runtime) |
| `DAGNode` | `types.md:273` | v2 (DAG execution) |
| `DAGState` | `types.md:294` | v2 (DAG execution) |
| `DAGEvent` | `types.md:305` | v2 (DAG execution) |
| `CycleState` | `types.md:315` | v2 (DAG execution) |
| `CycleExecutionSummary` | `types.md:334` | v2 (DAG execution) |
| `VersionSnapshot` | `types.md:348` | v2 (DAG execution) |
| `CategoryResult` | `types.md:514` | v2 (validation) |
| `GateResult` | `types.md:537` | v2 (validation) |
| `FailureReport` | `types.md:556` | v2 (validation) |
| `ValidationCategory` | `types.md:564` | v2 (validation) |
| `ValidationGate` | `types.md:576` | v2 (validation) |

---

## 5. API Endpoint Inventory

All endpoints this slice implements:

### Health & Info (Phase F)

| Method | Path | Request | Response 200 | Error codes |
|---|---|---|---|---|
| `GET` | `/api/v2/health` | -- | `{ ok, data: { status, uptime_ms, version } }` | 503 (shutting down) |
| `GET` | `/api/v2/info` | -- | `{ ok, data: DaemonInfo }` | -- |

### System State (Phase F)

| Method | Path | Request | Response 200 | Error codes |
|---|---|---|---|---|
| `GET` | `/api/v2/system/state` | -- | `{ ok, data: StateContext + flags + chat }` | -- |
| `POST` | `/api/v2/system/state/transition` | `{ target, trigger, payload? }` | `{ ok, data: { previous, current, cycle_id } }` | 409: invalid_transition, session_conflict, discovery_required |

### Init (Phase H)

| Method | Path | Request | Response 200 | Error codes |
|---|---|---|---|---|
| `POST` | `/api/v2/init` | `{ project_name, project_type, task_store, daemon_port, docs_remote?, non_interactive }` | `{ ok, data: { status, step, message, files_created } }` | 409: already_initialised |
| `GET` | `/api/v2/init/status` | -- | `{ ok, data: { initialised, current_step, total_steps, last_file_created } }` | 404: no_init_state |
| `POST` | `/api/v2/init/reset` | `{ confirm_name }` | `{ ok, data: { removed } }` | 403: name_mismatch |

### Discovery (Phase K)

| Method | Path | Request | Response 200 | Error codes |
|---|---|---|---|---|
| `POST` | `/api/v2/discovery/start` | `{ resume?, mode, from_file? }` | `{ ok, data: { session_id, status, mode, current_round, total_rounds, phases_total, opening_question } }` | 409: session_conflict, discovery_already_complete |
| `POST` | `/api/v2/discovery/round/{n}/response` | `{ content }` | `{ ok, data: { round, status, follow_up_question?, draft_available } }` | 400: invalid_round |
| `GET` | `/api/v2/discovery/round/{n}/draft` | -- | `{ ok, data: { round, artifact_path, content, status } }` | 404: draft_not_ready |
| `POST` | `/api/v2/discovery/round/{n}/approve` | -- | `{ ok, data: { round, artifact_path, next_round?, next_step } }` | -- |
| `POST` | `/api/v2/discovery/round/{n}/revise` | `{ feedback }` | `{ ok, data: { round, status } }` | -- |
| `POST` | `/api/v2/discovery/synthesis/approve` | -- | `{ ok, data: { artifacts, next_step } }` | -- |
| `POST` | `/api/v2/discovery/plan/approve` | -- | `{ ok, data: { plan_path, total_phases, phase1_tasks, discovery_status } }` | -- |
| `POST` | `/api/v2/discovery/plan/reorder` | `{ phase_order }` | `{ ok, data: { phase_order } }` | -- |
| `POST` | `/api/v2/discovery/plan/split/{phase}` | `{ split_after_task }` | `{ ok, data: { original_phase, new_phases } }` | -- |
| `POST` | `/api/v2/discovery/plan/merge` | `{ phases }` | `{ ok, data: { merged_phase } }` | -- |
| `GET` | `/api/v2/discovery/status` | -- | `{ ok, data: { status, session_id?, mode?, current_phase, total_phases, completed_rounds, artifacts, completed_at?, open_questions_count, blocking_questions_count } }` | -- |
| `POST` | `/api/v2/discovery/halt` | -- | `{ ok, data: { session_id, status, completed_phases, total_phases } }` | 409: halt_not_discovering |

**Total: 19 endpoints**

---

## 6. Rule File Inventory

All 7 rule files, created during `sle init` step 4 (Phase D defines schemas, Phase G writes them):

| File | Zod schema | Default values | Key fields |
|---|---|---|---|
| `planning.yaml` | `PlanningSchema` | `depth: standard` (varies), `max_iterations: 5`, `artifact_slice_size: 2000` | `depth`, `max_iterations`, `reasoning_passes`, `critic_enabled` |
| `validation.yaml` | `ValidationSchema` | Categories vary by project type | `static_analysis`, `container`, `categories[]` |
| `artifacts.yaml` | `ArtifactsSchema` | Identical across all project types | `artifacts[]` (7 artifacts), `generated_outputs[]` (3 outputs) |
| `exit.yaml` | `ExitSchema` | `on_cap_hit: halt_with_report` | `conditions`, `on_cap_hit`, `halt_behavior`, `on_error` |
| `user_validation.yaml` | `UserValidationSchema` | `approval_required: true`, `timeout_minutes: 30` | `approval_required`, `review_at`, `timeout_minutes`, `on_timeout` |
| `summary.yaml` | `SummarySchema` | `format: markdown`, `output_path: reports/summary-{{version_id}}.md` | `format`, `sections[]`, `test_command_format` |
| `agents.yaml` | `AgentsSchema` | 10 roles (see Phase D table) | `defaults.llm`, `providers`, `agents.{role}` |

**Artifact declarations** (`rule-files.md` §artifacts.yaml behavioral rules):

| ID | Path | Generator | Required | Append-only |
|---|---|---|---|---|
| `requirements` | `docs/requirements.md` | designer | Yes | No |
| `architecture` | `docs/architecture.md` | designer | Yes | No |
| `test-plan` | `docs/test-plan.md` | planner | Yes | No |
| `plan` | `docs/plan.md` | planner | Yes | No |
| `decisions` | `docs/decisions.md` | historian | Yes | Yes |
| `evaluation` | `docs/evaluation.md` | evaluator | Yes | No |
| `build-plan` | `docs/build-plan.md` | planner | No | No |

---

## 7. Test Strategy

### Unit tests per phase

| Phase | Test count (est.) | Key test areas |
|---|---|---|
| A: Types | ~30 | Zod schema valid/invalid, cross-schema validation |
| B: RuntimeMap | ~10 | Atomic write, read, serialization, concurrent access |
| C: State Machine | ~20 | 12 transitions, flag rules, StateContext, error codes |
| D: Rule Files | ~15 | Schema validation, default generation, merge, cross-file |
| E: Daemon Shell | ~10 | Startup, shutdown, PID, WebSocket |
| F: State API | ~10 | Endpoint responses, transition enforcement |
| G: sle init | ~15 | Full flow, resume, reset, non-interactive, error codes |
| H: Init API | ~8 | API flow, WebSocket events |
| I: Facilitator LLM | ~8 | Provider mock, prompt validation, agent.md |
| J: sle discover | ~20 | Round protocol, synthesis, planning, solo, errors |
| K: Discovery API | ~15 | All 12 endpoints, WebSocket events |
| L: Integration | ~5 | End-to-end init+discover flow |

**Total estimated: ~166 tests**

### Integration tests

1. **Init + daemon start + health check**: Full init then verify daemon responds
2. **Init + discover (full mode)**: Init, then complete discovery with mocked LLM
3. **Init + discover (solo mode)**: Same with solo mode
4. **Resume discovery**: Interrupt at round 3, restart daemon, resume
5. **State transitions**: T1 -> T2 via API, verify map.yaml at each step

### LLM integration testing

All LLM calls in tests use a mock provider:

```typescript
class MockLLMProvider implements LLMProvider {
  private responses: Map<string, string>

  setResponse(pattern: string, response: string): void

  async complete(params): Promise<{ content, tokens_used, duration_ms }> {
    // Match pattern in messages, return preset response
  }
}
```

The mock provider:
- Returns pre-configured responses based on message content matching
- Simulates follow-up questions for discovery rounds
- Produces valid markdown for artifact drafts
- Generates structured plan JSON for planning step

Real LLM tests (optional, CI-skip):
- Tagged `@llm` and excluded from default test run
- Run with `SLE_LLM_TEST=true` environment variable
- Require valid API key

---

## 8. Out of Scope (Explicitly Deferred)

### Slice 2: DAG Execution + Context Manager

- DAG runner (15 nodes, sequential execution)
- Context assembly (5-component window, SliceRule loading, token budget enforcement)
- Cycle start/end flows (SCOPING, DESIGN, PLAN, TEST, CONFIRM, BUILD, EXEC, etc.)
- Validation gate execution
- Run artifact generation
- Container execution (Docker)
- All cycle-related API endpoints

### Slice 3: Remaining Agent Roles

- Designer agent (architecture.md, requirements.md)
- Explorer agent (research findings)
- Planner agent (plan.md, test-plan.md, build-plan.md)
- Tester agent (test scripts)
- Builder agent (implementation)
- Debugger agent (FailureReport)
- Evaluator agent (evaluation.md)
- Critic agent (review at DESIGN node)
- Historian agent (decisions.md entries)
- All non-Facilitator prompt templates (installed in Slice 1, implemented here)

### Slice 4: Job Dispatch / Docker

- AI Executor integration
- Docker container management
- Script execution isolation
- Worker pool
- Static analysis execution
- Executable test execution

### Post-MVP Items

- **BeadsTaskStore**: Full `bd` CLI integration for task operations
- **Facilitator chat mode**: Freeform Q&A outside discovery
- **Facilitator decision mode**: Gate approval interactions
- **Facilitator scoping mode**: SCOPING node guided discussion
- **Knowledge engine (Cognee)**: Optional knowledge graph
- **ChatContext compression**: Conversation -> cycle transition
- **Decision capture in chat**: Detecting and recording decisions
- **Intake / sharding pipeline**: Document intake, task sharding
- **Content store / modules**: Node content CRUD, layer modules
- **Document linking**: Forward links, backlinks, link index
- **Version snapshots**: Immutable cycle snapshots
- **`sle discover --revisit`**: Re-entering discovery to revise docs
- **`sle discover --replan`**: Re-planning remaining phases
- **`sle discover --from`**: Document injection (stub API exists, full behavior deferred)
- **History compaction**: Chat history summarization
- **Override layer**: `.sle/overrides/` rule file merging
- **Multi-provider LLM routing**: Per-agent provider override

---

## Appendix A: Open Questions from Specs

Questions from source specs that may affect this slice's implementation:

| ID | Source | Question | Impact on this slice |
|---|---|---|---|
| SM-001 | `state-machine.md` | Should `discovering` allow resumption after daemon restart? | Session persistence strategy |
| SM-004 | `state-machine.md` | Can `sle start --force` produce valid cycle without discovery artifacts? | T11 behavior |
| ID-001 | `init-and-discovery.md` | Should `sle init` auto-detect project type from package.json? | Step 2 implementation |
| ID-002 | `init-and-discovery.md` | Migration path when new agent role added? | agents.yaml schema versioning |
| ID-007 | `init-and-discovery.md` | Block startup if TaskStore inconsistent? | Daemon startup validation |
| ID-009 | `init-and-discovery.md` | Validate LLM API key reachability at init? | Step 10 behavior |
| API-006 | `daemon-api.md` | Stream Facilitator response or single payload? | Discovery round response API |
| CONV-003 | `conversation.md` | Optimal context_window_exchanges default? | Discovery session context budget |

**Recommendation:** For this slice, make conservative choices and document them:
- SM-001: Yes, resume from `discovery-session.json` on restart
- SM-004: Yes, `--force` creates minimal cycle context (deferred to Slice 2)
- ID-001: No, always prompt (can enhance later)
- ID-007: No, degrade gracefully (log warning)
- ID-009: No, defer to first LLM call (faster init)
- API-006: Single payload for MVP (can add streaming later)
- CONV-003: Use 20 (from spec default)
