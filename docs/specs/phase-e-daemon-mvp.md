# Phase E — Daemon MVP
**Status:** Implementation spec · **Depends on:** Phases A–D
**Spec coverage:** See `implementation-tracking.md` for per-section breakdown
**Source specs:** `specs/daemon-api.md` (11 of 85 endpoints), `specs/daemon-api-endpoints.md` (health, state, init, discovery groups only), `specs/init-and-discovery.md` (simplified init, solo discovery only)
**Canonical types:** `reference/types.md`
**State machine:** `specs/state-machine.md`

---

## 1. Overview

The Daemon MVP is the first executable vertical slice of the SLE system. It takes the type definitions (Phase A), runtime map (Phase B), state machine (Phase C), and rule file schemas (Phase D) and wires them into a running daemon process with a REST API, CLI, init flow, and discovery flow.

**Scope:** The smallest set of features that makes the daemon runnable, testable, and useful:
- Daemon HTTP server (port 7700)
- 11 core REST endpoints (health, info, system state, transitions, flags, init, discovery rounds)
- CLI entry point (`sle init`, `sle start`, `sle status`, `sle stop`)
- Init flow: project setup (git detection, rule file generation, map.yaml creation)
- Discovery flow: single-round interactive Q&A with approval gate
- Rule file loader + default generator
- Integration tests against the running daemon

**Out of scope:** Full 85-endpoint API, WebSocket events, beads integration, DAG execution engine, context manager, validation engine, job dispatch, intake, knowledge engine, UI, chat.

---

## 2. Data Model

### DaemonInfo

Existing type in `types.ts`. Extended with runtime data:

```typescript
interface DaemonInfo {
  version: string
  pid: number
  port: number
  started_at: string
  uptime_ms: number
  project_root: string
  sle_version: string
}
```

### Envelope types

Existing in `types.ts`: `APIResponse<T>`, `APIError`

### DaemonConfig

New internal config, not persisted:

```typescript
interface DaemonConfig {
  port: number
  projectRoot: string
  foreground: boolean
  noOpen: boolean          // don't open browser
}
```

### CLI args

```typescript
type DaemonCommand =
  | { command: 'init'; name?: string; description?: string; type?: string; taskStore?: string; noEditor: boolean; noDaemon: boolean; resume: boolean; reset: boolean }
  | { command: 'start'; port?: number; foreground: boolean }
  | { command: 'stop' }
  | { command: 'status' }
  | { command: 'discover'; solo: boolean; revisit: boolean }
```

### StateContext (runtime snapshot)

Returned by `GET /api/v2/system/state`. Live-computed from the runtime map + state machine:

```typescript
interface StateContext {
  state: SystemStatus
  active_session_id: string | null
  active_cycle_id: string | null
  discovery_status: DiscoveryStatus
  iteration: number
  revision: number
  awaiting_confirmation: boolean
  awaiting_sharding_approval: boolean
  awaiting_scoping: boolean
  chat: { session_open: boolean }
}
```

### HealthData

```typescript
interface HealthData {
  status: 'healthy'
  uptime_ms: number
  version: string
}
```

### InitResult

```typescript
interface InitResult {
  project_root: string
  map_yaml_path: string
  rules_generated: number
  init_state_path: string
}
```

### DiscoveryResult

```typescript
interface DiscoveryResult {
  session_id: string
  round: number
  total_rounds: number
  artifacts_written: string[]
  discovery_status: DiscoveryStatus
}
```

---

## 3. Modules

### Module: DaemonServer

File: `src/daemon.ts`

The HTTP server. Built on Node.js `http` module (no Express dependency — keeps deps minimal). Uses inline routing.

```typescript
interface DaemonServer {
  start(config: DaemonConfig, pidFile: PIDFile): Promise<void>
  stop(): Promise<void>
  getPort(): number
  getUptimeMs(): number
  attachStateAPI(api: StateAPI): void
  attachInitService(service: InitService): void
  attachDiscoveryService(service: DiscoveryService): void
  attachRuleLoader(loader: RuleLoader): void
}
```

**Routes:**

| Method | Path | Handler | Depends on |
|--------|------|---------|------------|
| GET | `/api/v2/health` | Return health status | Daemon startup |
| GET | `/api/v2/info` | Return DaemonInfo | Daemon startup |
| GET | `/api/v2/system/state` | Return StateContext | StateAPI |
| POST | `/api/v2/system/state/transition` | Request state transition | StateMachine |
| GET | `/api/v2/system/flags` | Return current flags | StateAPI |
| PATCH | `/api/v2/system/flags` | Update flags | StateAPI |
| POST | `/api/v2/init` | Start init sequence | InitService |
| GET | `/api/v2/init/state` | Get init progress | InitService |
| POST | `/api/v2/discovery/start` | Start discovery session | DiscoveryService |
| POST | `/api/v2/discovery/round/{n}/response` | Submit response for round n | DiscoveryService |
| POST | `/api/v2/discovery/round/{n}/approve` | Approve draft for round n | DiscoveryService |

**Middleware:**
- JSON body parser (content-type: application/json)
- Request ID generation (UUID per request)
- Response envelope wrapper (automatically wraps in `APIResponse<T>` or `APIError`)
- Error handler (catches unhandled errors → 500 `internal_error`)
- State lock (deferred to Phase G — requires request queuing, out of scope for MVP)

**Startup sequence:**
1. Parse CLI flags
2. Load map.yaml (via RuntimeMapManager)
3. Validate rule files (via RuleLoader)
4. Restore state from map.yaml
5. Bind HTTP server on port
6. Log "Daemon ready on port {port}"
7. Write PID file to .sle/daemon.pid

### Module: StateAPI

File: `src/state-api.ts` — **already implemented** in Phase D.

Extends existing `StateAPI` class with:
- `getStateContext(): StateContext` — builds runtime snapshot from map.yaml + state machine
- `getFlags(): CycleFlags` — returns current flag state
- `setFlags(flags: Partial<CycleFlags>): void` — mutates flags with exclusivity check

### Module: RuleLoader

File: `src/rule-loader.ts`

Loads, validates, and generates default rule files.

```typescript
interface RuleLoader {
  /**
   * Load all 7 rule files from .sle/rules/ and validate against Zod schemas.
   * Returns { errors: string[], valid: boolean, rules: RuleSet }
   */
  loadAll(projectRoot: string): Promise<RuleLoadResult>

  /**
   * Generate default rule files for a project type.
   * Creates .sle/rules/ directory with all 7 files.
   * Returns list of file paths created.
   */
  generateDefaults(projectRoot: string, projectType: ProjectType): Promise<string[]>

  /**
   * Validate a single rule file against its schema.
   */
  validate(filePath: string, schema: z.ZodSchema): Promise<ValidationError[]>
}

type RuleSet = {
  planning: unknown
  validation: unknown
  artifacts: unknown
  exit: unknown
  user_validation: unknown
  summary: unknown
  agents: unknown
}

interface RuleLoadResult {
  valid: boolean
  errors: string[]
  rules: RuleSet | null
}
```

Default rule file templates — minimal working versions:

- **planning.yaml**: planning_depth, max_iterations per project type
- **validation.yaml**: static_analysis (lint/typecheck/complexity), container config, categories (correctness only)
- **artifacts.yaml**: minimal artifact set (requirements.md, plan.md, summary.md)
- **exit.yaml**: default exit config (cap_behaviour: halt_with_report)
- **user_validation.yaml**: minimal user validation categories
- **summary.yaml**: markdown format, default sections
- **agents.yaml**: all 10 roles with default LLM config (openai_compatible/gpt-4o), basic prompts

### Module: InitService

File: `src/init-service.ts`

Handles `sle init` workflow — a simplified version of the full init spec (no interactive prompts, no Beads, no docs remote clone for MVP).

```typescript
interface InitService {
  /**
   * Run init sequence for a project.
   * Creates .sle/ structure, rule files, map.yaml, agent.md.
   * Does NOT start daemon.
   */
  init(projectRoot: string, params: InitParams): Promise<InitResult>

  /**
   * Resume an interrupted init sequence.
   */
  resume(projectRoot: string): Promise<InitResult>

  /**
   * Destroy all init artifacts (reset).
   */
  reset(projectRoot: string, confirmationName: string): Promise<void>
}

interface InitParams {
  name: string
  description: string
  type: ProjectType
  taskStore: 'beads' | 'local'
  noEditor: boolean
  noDaemon: boolean
}
```

**Init steps (simplified for MVP):**

| Step | Action | Type | Notes |
|------|--------|------|-------|
| 0 | Prerequisite check: git repo, Node 20+, .sle/ absent | Idempotent | |
| 1 | Create .sle/ directory structure | Idempotent | mkdir -p .sle/rules/ |
| 2 | Generate 7 rule files from project type templates | Idempotent | Uses RuleLoader |
| 3 | Create map.yaml (status: idle, cycle: 0, version_id: v0.0.0) | Idempotent | |
| 4 | Create agent.md (basic template) | Idempotent | |
| — | Write progress to .sle/init-state.json after each step | — | Enables resume |
| — | On completion: delete .sle/init-state.json | — | |

**Deferred from full spec:** Step 3a-3c (remote configuration), Step 5 (TaskStore init — accepts `taskStore` param in InitParams but only creates a stub), Step 6 (docs clone), Step 8 (prompt templates), Step 9 (git commit), Step 10 (daemon start — `noDaemon: false` means the caller must run `sle start` separately).

**Resume logic:**
- Reads `.sle/init-state.json`
- Re-runs all steps where `last_completed_step < current_step`
- Non-idempotent steps (5, 6, 9) are skipped if their boolean flag is `true`
- On completion: delete init-state.json

**Reset logic:**
- Removes `.sle/`, `.beads/`, `.server/`, `agent.md`
- Requires `confirm_name` matching project name

### Module: DiscoveryService

File: `src/discovery-service.ts`

Handles `sle discover` workflow — simplified for MVP (single round, no synthesis, no planning loop).

```typescript
interface DiscoveryService {
  /**
   * Start a discovery session.
   * Transitions system to 'discovering' state.
   * Returns initial opening question.
   */
  start(projectRoot: string, params: DiscoveryParams): Promise<DiscoverySession>

  /**
   * Submit a response for the current round.
   * Returns the next question or the draft for approval.
   */
  submitResponse(sessionId: string, round: number, response: string): Promise<RoundResult>

  /**
   * Approve a completed round's draft.
   * On final round completion, transitions system back to 'idle'.
   */
  approveRound(sessionId: string, round: number): Promise<void>

  /**
   * Get current discovery session status.
   */
  getStatus(sessionId: string): Promise<DiscoveryResult>
}

interface DiscoveryParams {
  mode: 'full' | 'solo'
  revisit: boolean
}

interface DiscoverySession {
  session_id: string
  mode: 'full' | 'solo'
  current_round: number
  total_rounds: number
  opening_question: string
}

interface RoundResult {
  round: number
  status: 'collecting' | 'drafting' | 'reviewing' | 'approved'
  draft?: string
  next_question?: string
}
```

**Discovery flow (simplified MVP, solo mode):**

1. `POST /api/v2/discovery/start` → system transitions `idle → discovering`
2. Returns `opening_question` (e.g., "What problem does your project solve?")
3. User responds via `POST /api/v2/discovery/round/1/response`
4. System generates draft from response (for MVP: echoes back as markdown)
5. User approves via `POST /api/v2/discovery/round/1/approve`
6. System transitions `discovering → idle`, updates map.yaml

### Module: CLI

File: `src/cli.ts`

Entry point. Parses arguments and dispatches to the appropriate service.

```
Usage: sle <command> [options]

Commands:
  init       Initialize a new SLE project
  start      Start the daemon
  stop       Stop the daemon
  status     Show daemon status
  discover   Run project discovery

Options:
  --port, -p         Daemon port (default: 7700)
  --foreground, -f   Run in foreground
  --help, -h         Show help
  --version, -v      Show version

Examples:
  sle init --name my-project --type api
  sle start
  sle start --port 7700 --foreground
  sle status
  sle discover --solo
```

### Module: PIDFile

File: `src/pid-file.ts`

```typescript
interface PIDFile {
  write(path: string, pid: number): Promise<void>
  read(path: string): Promise<number | null>   // returns pid or null if stale/missing
  remove(path: string): Promise<void>
  isAlive(pid: number): boolean
}
```

---

## 4. Module Dependencies

```
DaemonServer
  ├── StateAPI (existing)
  │     └── StateMachine (existing)
  │           └── RuntimeMapManager (existing)
  ├── RuleLoader (new)
  │     ├── rule-files.ts (existing)
  │     └── types.ts (existing)
  ├── InitService (new)
  │     └── RuleLoader (new)
  ├── DiscoveryService (new)
  │     ├── StateAPI (existing)
  │     └── RuntimeMapManager (existing)
  └── PIDFile (new)

CLI
  ├── DaemonServer
  ├── InitService
  ├── DiscoveryService
  └── PIDFile
```

---

## 5. Test Plan

### Unit Tests

File: `tests/daemon.test.ts`

| Test | What it verifies |
|------|-----------------|
| InMemoryDaemon starts and responds to health check | Server lifecycle |
| GET /api/v2/health returns 200 with healthy status | Health endpoint |
| GET /api/v2/info returns DaemonInfo shape | Info endpoint |
| GET /api/v2/system/state returns StateContext | State endpoint |
| POST /api/v2/system/state/transition rejects invalid transition | State machine integration |
| POST /api/v2/system/state/transition applies valid transition | State machine integration |
| POST /api/v2/init creates .sle/ structure | Init flow |
| GET /api/v2/init/state returns init progress | Init state tracking |
| POST /api/v2/discovery/start transitions to discovering | Discovery start |
| POST /api/v2/discovery/round/1/response returns draft | Discovery round |
| JSON parse error returns 400 schema_validation | Error handling |
| Unknown route returns 404 | Routing |
| Idempotent init resume works | Resume behavior |

### File: `tests/rule-loader.test.ts`

| Test | What it verifies |
|------|-----------------|
| Generate defaults creates 7 files | Rule file generation |
| Generated planning.yaml passes Zod validation | Schema conformance |
| Generated agents.yaml includes all 10 roles | Agent completeness |
| Validate detects invalid YAML | Error detection |
| LoadAll returns RuleSet from generated files | E2E load |

### File: `tests/init-service.test.ts`

| Test | What it verifies |
|------|-----------------|
| Init creates .sle/map.yaml | Core output |
| Init creates .sle/rules/ with 7 files | Rule generation |
| Init creates .sle/init-state.json during progress | Progress tracking |
| Init deletes init-state.json on completion | Completion signal |
| Init detects existing .sle/ and fails (no overwrite) | Safety |
| Resume skips completed steps | Resume logic |

### File: `tests/discovery-service.test.ts`

| Test | What it verifies |
|------|-----------------|
| Start transitions to discovering state | State integration |
| Start returns opening question | Session init |
| Submit response creates draft | Round flow |
| Approve completes the round | Approval gate |
| Start when discovery is complete returns error | State guard |
| Solo mode returns 1 total round | Solo config |

---

## 6. Acceptance Criteria

- [ ] `sle init --name test --type api` creates `.sle/`, `map.yaml`, 7 rule files, `agent.md`
- [ ] `sle start` starts daemon on port 7700, writes `.sle/daemon.pid`
- [ ] `curl localhost:7700/api/v2/health` returns `{ ok: true, data: { status: "healthy" } }`
- [ ] `curl localhost:7700/api/v2/system/state` returns current state machine status
- [ ] State transition endpoint works: `idle → discovering` via POST /system/state/transition
- [ ] Discovery flow: start → submit response → approve → completes
- [ ] `sle stop` kills daemon, removes PID file
- [ ] `sle status` shows running/stopped state
- [ ] Invalid JSON to any endpoint returns 400 with `APIError` envelope
- [ ] Unknown route returns 404
- [ ] Init with existing `.sle/` fails cleanly (no overwrite)
- [ ] `npx tsc --noEmit` passes with zero errors
- [ ] All unit tests pass: `npx tsx --test tests/daemon.test.ts tests/rule-loader.test.ts tests/init-service.test.ts tests/discovery-service.test.ts`
- [ ] Integration test: full flow `init → start → health → discover → approve → stop`

---

## 7. Files to Create

| File | Purpose | Lines (est.) |
|------|---------|-------------|
| `src/daemon.ts` | HTTP server with inline routing | 150 |
| `src/rule-loader.ts` | Rule file generation + validation | 200 |
| `src/init-service.ts` | Init workflow | 150 |
| `src/discovery-service.ts` | Discovery workflow | 150 |
| `src/cli.ts` | CLI entry point | 100 |
| `src/pid-file.ts` | PID file management | 50 |
| `src/daemon-config.ts` | DaemonConfig type + CLI arg parser | 60 |
| `tests/daemon.test.ts` | Daemon server integration tests | 250 |
| `tests/rule-loader.test.ts` | Rule loader unit tests | 150 |
| `tests/init-service.test.ts` | Init service tests | 150 |
| `tests/discovery-service.test.ts` | Discovery service tests | 150 |

**Total new code:** ~1,460 lines

---

## 8. Implementation Order

```
1. PIDFile           (no deps)
2. DaemonConfig      (no deps)
3. CLI parser         (depends on DaemonConfig)
4. RuleLoader        (depends on rule-files.ts, types.ts)
5. InitService       (depends on RuleLoader)
6. DiscoveryService  (depends on StateAPI, RuntimeMapManager)
7. DaemonServer      (depends on StateAPI, InitService, DiscoveryService, RuleLoader)
8. CLI               (depends on DaemonServer, InitService, DiscoveryService, PIDFile)
9. Tests             (depends on all modules)
```

Each module is implemented unit-first: write the module, write its unit test, verify, then move to the next. Integration tests run last.