# Vertical Slice 3: Hardened Execution & Recovery

**Type:** implementation plan · **Status:** complete · **Updated:** 2026-05-17
**Slice:** v3 · **Prerequisite:** VS2 complete (full cycle SCOPING→SNAPSHOT, stub EXEC)

---

## Implementation Progress

| Phase | Component | Status | Commit |
|-------|-----------|--------|--------|
| A | Full Anthropic SDK Provider | ✅ Complete | 2b1a2de |
| B | DDR-029 Typed Output Contracts | ✅ Complete | 2432008 |
| C | DDR-030 Multi-turn Agent Loop | ✅ Complete | 1692ac8 |
| D | Real EXEC Service (subprocess) | ✅ Complete | e1c3bd3 |
| E | Debugger Agent + DAG Recovery Loop | ✅ Complete | 6758473 |
| F | Integration Tests (fail → debug → recover) | ✅ Complete | 99b37ae |

---

## 1. Overview

### What this slice delivers

After VS3, the cycle can:

1. Call real LLM agents via the full Anthropic SDK (with prompt caching)
2. Run multi-turn agent interactions — agents can read files and ask clarifying questions before producing output
3. Produce and validate structured, typed SLE-OUTPUT sections (full DDR-029 contract)
4. Execute real commands (subprocess or Docker) in the EXEC node
5. Detect execution failures and automatically invoke the Debugger agent
6. Retry execution after Debugger proposes a fix, up to a configurable max

The integration test proves this with a cycle that **intentionally fails on first EXEC**, is fixed by Debugger, and **completes on second EXEC**.

### Theme: make it real, make it recoverable

VS2 proved the structure. VS3 makes the substance real:

| VS2 | VS3 |
|-----|-----|
| Fetch-based Anthropic provider | Full `@anthropic-ai/sdk` with caching |
| Single-turn agent (one LLM call) | Multi-turn loop with tool use |
| Simplified SLE-OUTPUT parsing | Typed, validated section contracts |
| EXEC always passes | Real subprocess; exit code determines outcome |
| VALIDATION_GATE failure halts cycle | Debugger agent invoked; execution retried |

### Deliberate deferrals

| Item | Why deferred | Where it goes |
|---|---|---|
| Docker container management | Subprocess covers the interface; Docker is infra risk | VS4 |
| Explorer agent | Conditional trigger; not on critical path | VS4 |
| Critic agent (deep/research depth) | Depth defaults to `standard`; small addition | VS4 |
| SHARDING approval gate | Optional feature | VS4 |
| Chat / facilitator mode | Orthogonal to execution hardening | VS4 |
| Full WebSocket event suite | Core events remain from VS2 | VS4 |
| Remaining API endpoints | Not cycle-critical | VS4 |
| Knowledge engine (Cognee) | Large external dependency | VS5 |
| UI Shell | Separate concern | VS4 |

---

## 2. Dependency Map

```
This slice consumes (from VS2 + specs):
  cycle-runner.ts           CycleRunner orchestration (extended with Debugger loop)
  dag-runner.ts             DAGRunner.runNode, skipNode, buildCycleStateContext
  agent-runner.ts           AgentRunner (single-turn, to be extended)
  exec-gate.ts              ExecService (stub, to be replaced)
  run-artifacts.ts          RunArtifactManager (manifest, failure reports)
  DDR-029                   Full agent output model (typed sections)
  DDR-030                   Full agent runner model (multi-turn)

This slice produces (consumed by VS4+):
  VS4: Docker execution, Explorer, Critic, Chat mode
  VS4: UI Shell reading WebSocket events from real execution
```

```
Dependency flow within this slice:

  Phase A (Anthropic SDK Provider)
    |
    v
  Phase B (DDR-029 Typed Output Contracts)   ← depends on A (real provider needed for parsing tests)
    |
    v
  Phase C (DDR-030 Multi-turn Agent Loop)    ← depends on B (output contracts define loop exit)
    |
    v
  Phase D (Real EXEC Service)                ← depends on nothing else in this slice
    |
    v
  Phase E (Debugger Agent + DAG Loop)        ← depends on C (debugger is an agent) + D (needs real failures)
    |
    v
  Phase F (Integration Tests)                ← depends on all phases
```

---

## 3. Phases

---

### Phase A — Full Anthropic SDK Provider

**Goal:** Replace the fetch-based `AnthropicProvider` with a proper `@anthropic-ai/sdk` client that supports prompt caching, streaming (optional), and structured error handling.

**Files to change:**
- `src/sdk-orchestrator/v3/src/anthropic-provider.ts` (new, replaces v2 version)
- `src/sdk-orchestrator/v3/src/agent-runner.ts` (update provider interface)
- `src/sdk-orchestrator/v3/tests/anthropic-provider.test.ts` (new)

**Implementation notes:**

The v2 provider sends a raw fetch to `api.anthropic.com`. The v3 provider wraps `@anthropic-ai/sdk`:

```typescript
import Anthropic from '@anthropic-ai/sdk';

export class AnthropicProvider implements LLMProvider {
  private client: Anthropic;
  
  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const response = await this.client.messages.create({
      model: request.model,
      max_tokens: request.max_tokens,
      system: [
        {
          type: 'text',
          text: request.system,
          cache_control: { type: 'ephemeral' },  // prompt caching on system prompt
        }
      ],
      messages: request.messages,
    });
    // ...
  }
}
```

**Prompt caching strategy:**
- System prompt (role instructions + static context) → `cache_control: ephemeral`
- First message turn (artifact context, which changes per node) → no cache (content changes)
- In multi-turn (Phase C): only the base system prompt is cached; tool results are not

**Error handling surface:**
- `Anthropic.APIError` subtypes: `AuthenticationError`, `RateLimitError`, `InternalServerError`
- Map to `LLMProviderError` with `retryable: boolean`
- `RateLimitError` and 529 are retryable; 401, 400 are not

**Tests (target: 12):**
- Provider initialises with API key
- `complete()` maps request → Anthropic SDK params correctly
- System prompt marked with `cache_control: ephemeral`
- Response mapped to `LLMResponse` shape
- `AuthenticationError` → `LLMProviderError { retryable: false }`
- `RateLimitError` → `LLMProviderError { retryable: true }`
- `InternalServerError` (529) → `LLMProviderError { retryable: true }`
- Model override respected
- Max tokens passed through
- Messages array passed through unmodified
- Mock SDK client injected via constructor for tests (no real API calls)
- Cache control header not set on user messages

**Testing method:** Unit tests only. Inject a mock Anthropic client in constructor. No real API calls.

---

### Phase B — DDR-029 Typed Output Contracts

**Goal:** Replace simplified `parseAgentOutput()` in `agent-runner.ts` with a full typed parser that validates section paths, content, and structure; retries on malformed output.

**Files to change:**
- `src/sdk-orchestrator/v3/src/output-parser.ts` (new, extracted from agent-runner)
- `src/sdk-orchestrator/v3/src/agent-runner.ts` (use new parser)
- `src/sdk-orchestrator/v3/tests/output-parser.test.ts` (new)

**DDR-029 full contract (from spec):**

```
<<<SLE-OUTPUT>>>
### path/to/file.ext
[SECTION CONTENT]
### another/file.ext
[SECTION CONTENT]
<<<END-SLE-OUTPUT>>>
```

Full typed validation rules:
1. `<<<SLE-OUTPUT>>>` and `<<<END-SLE-OUTPUT>>>` must both be present; malformed if either missing
2. Each `### ` header line must be a valid relative path (no `..`, no leading `/`)
3. Path must have a recognised extension (`.md`, `.ts`, `.js`, `.json`, `.yaml`, `.yml`, `.txt`, `.sh`, `.py`)
4. Section content must be non-empty after trimming
5. Maximum 20 sections per output (guard against runaway generation)
6. Maximum content size per section: 100 KB
7. Duplicate paths within one output are an error (last one does NOT silently win)
8. Paths that don't match the agent's `ROLE_OUTPUT_PATHS` are filtered and reported as warnings (not errors) — the section is dropped, the rest of the output proceeds

**Retry on malformed:**
- If `parseAgentOutput()` throws `ParseError`, `AgentRunner` re-prompts the LLM once with a repair message:
  ```
  The previous output was not parseable. Reason: {error.message}
  Please reformat your response using the exact SLE-OUTPUT block structure.
  ```
- On second failure: propagate error, mark node as failed

**`ParsedOutput` type:**
```typescript
export interface ParsedSection {
  path: string;
  content: string;
}

export interface ParsedOutput {
  sections: ParsedSection[];
  warnings: string[];  // dropped paths with reason
}

export class ParseError extends Error {
  constructor(message: string, public readonly raw: string) {
    super(message);
  }
}
```

**Tests (target: 18):**
- Happy path: 1 section parsed correctly
- Happy path: 3 sections parsed correctly
- Missing `<<<SLE-OUTPUT>>>` → `ParseError`
- Missing `<<<END-SLE-OUTPUT>>>` → `ParseError`
- Path with `..` → `ParseError`
- Path with leading `/` → `ParseError`
- Unknown extension → `ParseError`
- Empty section content → `ParseError`
- Duplicate path in one output → `ParseError`
- More than 20 sections → `ParseError`
- Section content exceeds 100 KB → `ParseError`
- Path outside ROLE_OUTPUT_PATHS → dropped, warning added, rest of output proceeds
- Multiple out-of-role paths → all dropped, all warnings recorded
- Whitespace trimmed from paths and content
- Retry prompt sent on first parse failure
- Second parse failure propagates error and marks node failed
- Warning sections are not written to disk
- Valid output with warnings: valid sections still written

**Testing method:** Pure unit tests on `parseAgentOutput()`. No LLM, no filesystem. Inject mock `AgentRunner` for retry path.

---

### Phase C — DDR-030 Multi-turn Agent Loop

**Goal:** Replace the single-turn LLM call in `AgentRunner.run()` with a multi-turn loop that supports tool use (`read_file`, `list_directory`) and exits when the agent emits `SLE-OUTPUT`.

**Files to change:**
- `src/sdk-orchestrator/v3/src/agent-runner.ts` (replace `runOnce()` with `runLoop()`)
- `src/sdk-orchestrator/v3/src/tools.ts` (new — tool definitions and handlers)
- `src/sdk-orchestrator/v3/tests/agent-runner-multiturn.test.ts` (new)

**Tools available to agents:**

```typescript
export const AGENT_TOOLS = [
  {
    name: 'read_file',
    description: 'Read the contents of a file by path. Use this to inspect existing artifacts before producing output.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Relative path from project root' } },
      required: ['path'],
    },
  },
  {
    name: 'list_directory',
    description: 'List files in a directory. Use this to discover what artifacts already exist.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Relative path from project root' } },
      required: ['path'],
    },
  },
] as const;
```

**Loop logic:**

```
Turn 1: system + context → agent
  If agent response contains SLE-OUTPUT: parse and exit
  If agent response contains tool_use block: execute tool, append tool_result, continue
  If max_turns reached: error "agent did not produce SLE-OUTPUT within N turns"

Turn N: messages + all prior turns → agent
  (same decision logic)
```

**Constraints:**
- `MAX_AGENT_TURNS = 10` (configurable per-node in future)
- Tool calls are **read-only**: `read_file` and `list_directory` only
- Tool paths are validated against `ROLE_OUTPUT_PATHS` before reading (agents can only read from their allowed paths, plus a `read_allowlist` of shared docs)
- Turn count tracked in run artifacts: `{ node_id, turns_taken, tool_calls: [{tool, path, turn}] }`
- `stop_reason: 'end_turn'` without SLE-OUTPUT after max turns → hard error

**Read allowlist (any agent can read these regardless of role):**
```typescript
export const AGENT_READ_ALLOWLIST = [
  'docs/',
  '.sle/runs/',
  'src/',
];
```

**Tests (target: 16):**
- Single turn: agent returns SLE-OUTPUT immediately, loop exits
- Two turns: agent calls `read_file`, gets result, returns SLE-OUTPUT
- Three turns: agent calls `read_file` twice, then returns SLE-OUTPUT
- Max turns exceeded → error propagated, node marked failed
- Tool call with path outside read allowlist → tool returns `{ error: 'path not permitted' }` (no exception)
- `list_directory` returns file list correctly
- `read_file` returns file contents correctly
- `read_file` on non-existent file → tool returns `{ error: 'file not found' }` (no exception)
- Turn count written to run artifacts
- Tool call log written to run artifacts
- `stop_reason: 'tool_use'` handled; `stop_reason: 'end_turn'` without SLE-OUTPUT → error
- `stop_reason: 'max_tokens'` → treated as agent failure
- Malformed tool `input` (missing `path`) → tool returns `{ error: 'invalid input' }`
- Loop messages accumulate correctly (prior turns passed in subsequent calls)
- SLE-OUTPUT in turn 1 and SLE-OUTPUT in turn 3 both parsed correctly
- ParseError on SLE-OUTPUT → retry prompt issued (Phase B contract respected)

**Testing method:** Mock the `LLMProvider`. Pre-program response sequences (`turn1 → tool_use`, `turn2 → SLE-OUTPUT`). Mock filesystem for tool handlers. No real API calls.

---

### Phase D — Real EXEC Service

**Goal:** Replace the always-pass `ExecService` stub with a real implementation that runs a command string via `child_process.spawn`, captures stdout/stderr, and reports success or failure based on exit code.

**Files to change:**
- `src/sdk-orchestrator/v3/src/exec-service.ts` (new, replaces v2 stub)
- `src/sdk-orchestrator/v3/tests/exec-service.test.ts` (new)

**Interface (unchanged from v2):**
```typescript
export interface ExecResult {
  next_node: string;
  exit_code: number;
  stdout: string;
  stderr: string;
  timed_out: boolean;
}
```

**Command resolution:**
The EXEC command is read from `map.exec.command`. If not set, falls back to `map.meta.exec_command`. If still not set, EXEC is a no-op (marks complete, no failure). This covers cycles where no build/test command is defined.

**Execution:**
```typescript
import { spawn } from 'child_process';

// Runs command in projectRoot
// Captures stdout + stderr (merged into combined, also tracked separately)
// Timeout: map.exec.timeout_ms ?? 120_000 (2 minutes default)
// On exit code !== 0 OR timeout: write FailureReport, next_node stays VALIDATION_GATE
// On success (exit 0): marks EXEC complete, next_node = VALIDATION_GATE
```

**FailureReport on EXEC failure:**
```typescript
{
  category: 'exec_failure',
  node: 'EXEC',
  message: `Command exited with code ${exitCode}`,
  detail: {
    command: string,
    exit_code: number,
    stdout: string,
    stderr: string,
    timed_out: boolean,
  }
}
```

**Run artifact updates:**
- `stdout.txt` and `stderr.txt` written to `.sle/runs/{cycle}/{iteration}/exec/`
- Node status updated: `{ status: 'failed', exit_code, timed_out }`
- FailureReport written via `runArtifacts.writeFailureReport()`

**ValidationGate hardening (in this phase):**
- `ValidationGateService` already reads the manifest. Extend it to:
  - Check `map.meta.dag.exec_result.exit_code === 0` (written by ExecService)
  - If EXEC timed out → fail regardless of exit code
- This replaces the flag-only check from VS2

**Tests (target: 20):**
- Command exits 0 → success, next_node = VALIDATION_GATE
- Command exits 1 → FailureReport written, next_node = VALIDATION_GATE, completed=false
- Command exits 127 (not found) → FailureReport with exit_code 127
- Timeout exceeded → timed_out=true in result and FailureReport
- stdout captured in result and written to artifact
- stderr captured in result and written to artifact
- No command configured → no-op, marks complete
- Node status set to `running` before spawn, `complete` or `failed` after
- FailureReport includes command string, exit code, stdout, stderr
- `exit_code` written to map for ValidationGate to read
- ValidationGate: exit_code 0 in map → passes
- ValidationGate: exit_code 1 in map → fails
- ValidationGate: timed_out in map → fails
- ValidationGate: exit_code 0 but BUILD node not complete → fails
- Large stdout (>10 KB) truncated in FailureReport detail (not in artifact file)
- Command with spaces and arguments parsed correctly
- Command inherits projectRoot as cwd
- Environment: PATH from process.env, no credential leakage
- Spawn error (e.g. ENOENT on binary) → FailureReport with spawn error message
- Manifest updated with exec outcome before ValidationGate runs

**Testing method:** Inject a mock `spawn` function to avoid real subprocess execution. Mock `RuntimeMapManager` and `RunArtifactManager`. No real processes spawned in unit tests. One integration test runs `echo hello` as a real subprocess (fast, always available).

---

### Phase E — Debugger Agent + DAG Recovery Loop

**Goal:** Add a DEBUGGER node to the cycle. When `VALIDATION_GATE` fails, `CycleRunner` routes to DEBUGGER instead of halting. After Debugger produces a fix, EXEC is retried. The loop runs up to `MAX_DEBUG_ATTEMPTS = 3`.

**Files to change:**
- `src/sdk-orchestrator/v3/src/dag-runner.ts` (add DEBUGGER to NODE_TO_ROLE, nextNode, shouldSkipAtDepth)
- `src/sdk-orchestrator/v3/src/cycle-runner.ts` (add debug loop to VALIDATION_GATE handler)
- `src/sdk-orchestrator/v3/src/runtime-map.ts` (add `debug_attempt` counter to RuntimeMap)
- `src/sdk-orchestrator/v3/tests/debugger-agent.test.ts` (new)
- `src/sdk-orchestrator/v3/tests/cycle-runner-recovery.test.ts` (new)

**DAG changes:**

```typescript
// NODE_TO_ROLE additions:
DEBUGGER: 'debugger',

// New debug-aware nextNode logic:
// VALIDATION_GATE on pass → EVALUATE (unchanged)
// VALIDATION_GATE on fail → DEBUGGER (new)
// DEBUGGER → EXEC (loops back)
```

`shouldSkipAtDepth('DEBUGGER', depth)` → always false (Debugger never skipped; it's only invoked on failure).

**CycleRunner VALIDATION_GATE handler (extended):**

```typescript
if (nodeId === 'VALIDATION_GATE') {
  const r = await this.deps.validationGateService.run(cycleNumber, iteration, cycleId);
  if (!r.passed) {
    const debugAttempt = await this.deps.mapManager.incrementDebugAttempt();
    if (debugAttempt > MAX_DEBUG_ATTEMPTS) {
      return {
        completed: false,
        final_node: 'VALIDATION_GATE',
        failure_report: r.failure_report,
        error: `Validation failed after ${MAX_DEBUG_ATTEMPTS} debug attempts`,
      };
    }
    // Route to Debugger
    currentNode = 'DEBUGGER';
    cycleState = { ...cycleState, failure_report: r.failure_report };
    continue;
  }
  currentNode = r.next_node;  // EVALUATE
  continue;
}
```

**Debugger agent context:**
The `CycleStateContext` passed to `runNode('DEBUGGER', cycleState)` includes `failure_report`. The ContextManager builds a Debugger-specific context slice:
- Role prompt: `docs/agent-roles/debugger.md`
- Artifacts: the files identified in the failure report's `detail.stderr` / `detail.stdout`
- Failure report: embedded in the state summary as structured detail
- Instruction: propose a concrete fix; output the corrected files via SLE-OUTPUT

**Debugger role output paths:**
```typescript
ROLE_OUTPUT_PATHS['debugger'] = ['src/', 'tests/', 'scripts/', '.sle/runs/'];
```
Debugger can write to source code (unlike most agents). This is intentional: it's fixing implementation, not producing documents.

**RuntimeMap extension:**
```typescript
// In map.meta.dag:
debug_attempt: number;  // 0 initially, incremented each time DEBUGGER is invoked
```

**Tests (target: 18):**

*Debugger agent unit tests:*
- DEBUGGER node resolves to 'debugger' role
- Failure report injected into CycleStateContext before DEBUGGER runs
- Debugger agent called with correct context (failure_report present)
- Debugger output paths: src/, tests/, scripts/ all allowed
- Debugger output paths: docs/requirements.md rejected
- ContextManager includes failure_report in state summary for DEBUGGER node
- DEBUGGER → EXEC in nextNode (after Debugger runs, CycleRunner routes to EXEC)

*CycleRunner recovery loop:*
- VALIDATION_GATE fail (attempt 1) → DEBUGGER invoked → EXEC retried → VALIDATION_GATE pass → completes
- VALIDATION_GATE fail (attempt 2) → DEBUGGER invoked again → EXEC retried → pass → completes
- VALIDATION_GATE fail (attempt 3, MAX reached) → cycle halts with failure_report
- debug_attempt counter incremented on each VALIDATION_GATE failure
- debug_attempt reset to 0 on cycle start (fresh cycles don't inherit prior debug state)
- MAX_DEBUG_ATTEMPTS=3 enforced
- CycleRunResult includes `debug_attempts_used: number` for observability
- Failure after MAX_DEBUG_ATTEMPTS includes the final failure_report

**Testing method:** Unit tests mock `DAGRunner.runNode()` for DEBUGGER, `ExecService.run()`, and `ValidationGateService.run()`. Program mock responses to fail N times then pass. Integration test in Phase F.

---

### Phase F — Integration Tests (fail → debug → recover)

**Goal:** Prove the full Phase D+E path end-to-end: a cycle that fails on first EXEC is fixed by Debugger and completes on second EXEC. Also prove the exhaustion path.

**Files:**
- `src/sdk-orchestrator/v3/tests/cycle-runner-integration.test.ts` (new)

These are heavy integration tests — real services wired together, mock LLM only.

**Integration test scenarios (see `v3-testing-scenarios.md` for full detail):**

| Test | Description | Expected |
|---|---|---|
| VS3-INT-01 | Happy path: EXEC succeeds first try | `completed: true`, no Debugger called |
| VS3-INT-02 | Single failure: EXEC fails once, Debugger fixes, EXEC passes | `completed: true`, 1 debug attempt |
| VS3-INT-03 | Double failure: EXEC fails twice, Debugger fixes on attempt 2 | `completed: true`, 2 debug attempts |
| VS3-INT-04 | Exhaustion: EXEC fails 4 times | `completed: false`, `debug_attempts_used: 3` |
| VS3-INT-05 | Multi-turn: DESIGN agent uses read_file before producing output | `completed: true`, turn count > 1 in artifacts |
| VS3-INT-06 | Malformed output: agent returns broken SLE-OUTPUT, retry succeeds | `completed: true`, repair prompt issued |

**Real services used:**
- `RuntimeMapManagerImpl`
- `RunArtifactManager`
- `CycleService`
- `ContextManager`
- `AgentRunner` (with mock LLM provider — `DebugAwareMockLLM`)
- `DAGRunner`
- `ConfirmService`
- `ExecServiceReal` (with mock `spawn`)
- `ValidationGateService`
- `SnapshotService`
- `CycleRunner`

**`DebugAwareMockLLM`:**
Extends VS2's `NodeAwareMockLLM`. Tracks how many times `complete()` has been called for EXEC-related nodes. On first `complete()` for EXEC-adjacent context, returns a pre-programmed failure output (the BUILD output contains a bug). On second call (after Debugger), returns corrected output.

Also supports `tool_use` responses: when the prompt contains "read_file" tool, returns a pre-programmed tool call on turn 1 and SLE-OUTPUT on turn 2.

**Tests (target: 6 integration scenarios × detailed assertions):**

Each integration test asserts:
- `result.completed` (true/false)
- `result.debug_attempts_used`
- Specific artifacts exist on disk
- `manifest.outcome` ('complete' or 'failed')
- Turn count in run artifacts for multi-turn tests
- Repair prompt issued in malformed output test

**Testing method:** All integration tests use mock LLM and mock spawn. No real API calls, no real subprocesses (except VS3-INT-01 uses `echo hello` as the EXEC command for one real subprocess test). Temp directories created and cleaned up per-test.

---

## 4. Test Count Summary

| Phase | Component | Unit tests | Integration tests | Total |
|-------|-----------|-----------|------------------|-------|
| A | Anthropic SDK Provider | 12 | 0 | 12 |
| B | DDR-029 Typed Output Contracts | 18 | 0 | 18 |
| C | DDR-030 Multi-turn Agent Loop | 16 | 0 | 16 |
| D | Real EXEC Service + ValidationGate | 19 | 1 | 20 |
| E | Debugger Agent + Recovery Loop | 18 | 0 | 18 |
| F | Integration Tests | 0 | 6 | 6 |
| **Total** | | **83** | **7** | **90** |

---

## 5. File Inventory

New files created in this slice:

```
src/sdk-orchestrator/v3/src/
  anthropic-provider.ts         Phase A — full SDK provider
  output-parser.ts              Phase B — typed output contract parser
  tools.ts                      Phase C — tool definitions and handlers
  exec-service.ts               Phase D — real subprocess exec
  (all other v2 files copied/extended as needed)

src/sdk-orchestrator/v3/tests/
  anthropic-provider.test.ts    Phase A
  output-parser.test.ts         Phase B
  agent-runner-multiturn.test.ts  Phase C
  exec-service.test.ts          Phase D
  debugger-agent.test.ts        Phase E
  cycle-runner-recovery.test.ts Phase E
  cycle-runner-integration.test.ts  Phase F
```

**Note on v3 directory:** VS3 extends VS2 code. For the first phase, copy v2 `src/` to v3 `src/` and modify. The v3 directory isolates the changes so VS2 tests remain green throughout.

---

## 6. Definition of Done

VS3 is complete when:

- [ ] All 90 tests pass (`node --import tsx --test`)
- [ ] `cycle-runner-integration.test.ts` VS3-INT-02 passes: a cycle that fails EXEC, runs Debugger, re-runs EXEC, and completes — all with mock LLM and mock spawn
- [ ] `anthropic-provider.ts` uses `@anthropic-ai/sdk` with `cache_control: ephemeral` on system prompt
- [ ] `output-parser.ts` enforces all 8 DDR-029 validation rules
- [ ] `agent-runner.ts` runs the multi-turn loop and writes turn counts to run artifacts
- [ ] `exec-service.ts` spawns real subprocess (or mock in tests), captures exit code, writes failure report
- [ ] `debug_attempt` counter in RuntimeMap prevents infinite retry loops
- [ ] Dev plan updated with commit hashes for all phases
- [ ] Testing scenarios doc (`v3-testing-scenarios.md`) referenced and up to date
