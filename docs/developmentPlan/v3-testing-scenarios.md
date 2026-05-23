# VS3 Testing Scenarios

**Type:** test specification · **Status:** draft · **Updated:** 2026-05-16
**Slice:** v3 · **Related plan:** `v3-hardened-execution.md`

This document defines all test scenarios for VS3. It exists separately from the dev plan because VS3 introduces failure/recovery paths that require multi-scenario reasoning — the "what" of each test matters as much as the "how many."

Each scenario has:
- An ID for cross-referencing
- The phase it validates
- Setup (what state the world is in before the test)
- Mock strategy (what is real vs mocked)
- Steps (what triggers the scenario)
- Assertions (what must be true at the end)
- Edge conditions (related variants)

---

## Scenario Index

| ID | Phase | Category | Description |
|----|-------|----------|-------------|
| VS3-A-01 through VS3-A-12 | A | Provider | Anthropic SDK provider contract |
| VS3-B-01 through VS3-B-18 | B | Parser | DDR-029 typed output contracts |
| VS3-C-01 through VS3-C-16 | C | Multi-turn | Agent loop with tool use |
| VS3-D-01 through VS3-D-20 | D | EXEC | Real subprocess execution |
| VS3-E-01 through VS3-E-18 | E | Recovery | Debugger agent + DAG loop |
| VS3-INT-01 through VS3-INT-06 | F | Integration | Full cycle scenarios |

---

## Category A — Anthropic SDK Provider

**Mock strategy for all A tests:** Inject a mock `Anthropic` client class in the `AnthropicProvider` constructor. The mock records calls and returns pre-programmed responses. No real HTTP.

---

### VS3-A-01: Provider initialises with API key

**Setup:** None.
**Steps:** `new AnthropicProvider('test-key')`.
**Assertions:**
- Anthropic SDK client constructed with `apiKey: 'test-key'`
- No API calls made at construction time

---

### VS3-A-02: complete() maps request to SDK params

**Setup:** Mock client returns a valid `Message` response.
**Steps:** Call `provider.complete({ model: 'claude-opus-4-7', max_tokens: 1024, system: 'You are...', messages: [{ role: 'user', content: 'Hello' }] })`.
**Assertions:**
- SDK `messages.create()` called with `model: 'claude-opus-4-7'`
- `max_tokens: 1024`
- `messages` array passed through unmodified

---

### VS3-A-03: System prompt marked with cache_control

**Setup:** Mock client records the `create()` call.
**Steps:** Call `provider.complete()` with any valid request.
**Assertions:**
- `system` param is an array (not a string)
- First element: `{ type: 'text', text: '...', cache_control: { type: 'ephemeral' } }`

**Why this matters:** Cache hits reduce cost and latency significantly for repeated node runs.

---

### VS3-A-04: Response mapped to LLMResponse shape

**Setup:** Mock client returns `{ content: [{ type: 'text', text: 'Hello' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } }`.
**Steps:** Call `provider.complete()`.
**Assertions:**
- Returns `{ content: 'Hello', stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } }`

---

### VS3-A-05: AuthenticationError → non-retryable

**Setup:** Mock client throws `Anthropic.AuthenticationError` (status 401).
**Steps:** Call `provider.complete()`.
**Assertions:**
- Throws `LLMProviderError`
- `error.retryable === false`
- `error.status === 401`

---

### VS3-A-06: RateLimitError → retryable

**Setup:** Mock client throws `Anthropic.RateLimitError` (status 429).
**Steps:** Call `provider.complete()`.
**Assertions:**
- Throws `LLMProviderError`
- `error.retryable === true`
- `error.status === 429`

---

### VS3-A-07: InternalServerError (529) → retryable

**Setup:** Mock client throws `Anthropic.InternalServerError` (status 529).
**Steps:** Call `provider.complete()`.
**Assertions:**
- Throws `LLMProviderError`
- `error.retryable === true`

---

### VS3-A-08 through VS3-A-12: Additional provider tests

- **VS3-A-08:** Model override in request respected (different model strings)
- **VS3-A-09:** Max tokens passed through unchanged
- **VS3-A-10:** Messages array with multiple turns passed through unmodified
- **VS3-A-11:** `cache_control` NOT set on user messages (only system prompt)
- **VS3-A-12:** `stop_reason: 'tool_use'` preserved in LLMResponse (needed for Phase C)

---

## Category B — DDR-029 Typed Output Contracts

**Mock strategy for all B tests:** Pure unit tests on `parseAgentOutput(raw: string, role: AgentRole)`. No filesystem, no LLM. For retry tests: mock `AgentRunner` instance with a mock provider.

---

### VS3-B-01: Happy path — single section

**Input:**
```
<<<SLE-OUTPUT>>>
### docs/requirements.md
# Requirements
Content here.
<<<END-SLE-OUTPUT>>>
```
**Assertions:**
- `result.sections.length === 1`
- `result.sections[0].path === 'docs/requirements.md'`
- `result.sections[0].content === '# Requirements\nContent here.'`
- `result.warnings.length === 0`

---

### VS3-B-02: Happy path — three sections

**Input:** Three `###` blocks in one SLE-OUTPUT.
**Assertions:** `result.sections.length === 3`, all paths and contents correct.

---

### VS3-B-03: Missing opening delimiter → ParseError

**Input:** Raw string with `<<<END-SLE-OUTPUT>>>` but no `<<<SLE-OUTPUT>>>`.
**Assertions:** Throws `ParseError` with message containing "missing opening delimiter".

---

### VS3-B-04: Missing closing delimiter → ParseError

**Input:** Raw string with `<<<SLE-OUTPUT>>>` but no `<<<END-SLE-OUTPUT>>>`.
**Assertions:** Throws `ParseError` with message containing "missing closing delimiter".

---

### VS3-B-05: Path with `..` → ParseError

**Input:** Section with path `../../../etc/passwd`.
**Assertions:** Throws `ParseError` with message containing "path traversal".

---

### VS3-B-06: Path with leading `/` → ParseError

**Input:** Section with path `/etc/passwd`.
**Assertions:** Throws `ParseError` with message containing "absolute path".

---

### VS3-B-07: Unknown file extension → ParseError

**Input:** Section with path `docs/requirements.exe`.
**Assertions:** Throws `ParseError` with message containing "unrecognised extension".

**Edge:** `.gitignore` (no extension) → also fails. `.md.bak` → fails. `.md` → passes.

---

### VS3-B-08: Empty section content → ParseError

**Input:** Section with `### docs/requirements.md` followed immediately by another `###` header (or end delimiter) with no content between.
**Assertions:** Throws `ParseError` with message containing "empty content".

---

### VS3-B-09: Duplicate paths → ParseError

**Input:** Two sections both with path `docs/requirements.md`.
**Assertions:** Throws `ParseError` with message containing "duplicate path".

**Why this rule:** Silent last-wins behaviour would make the agent's first output silently discarded, which is confusing and hard to debug.

---

### VS3-B-10: More than 20 sections → ParseError

**Input:** 21 `###` blocks.
**Assertions:** Throws `ParseError` with message containing "too many sections".

---

### VS3-B-11: Section content exceeds 100 KB → ParseError

**Input:** One section with 100,001 bytes of content.
**Assertions:** Throws `ParseError` with message containing "section too large".

---

### VS3-B-12: Path outside ROLE_OUTPUT_PATHS → dropped, warning

**Setup:** Role = `designer`. Designer is allowed `docs/requirements.md`, `docs/architecture.md`.
**Input:** Section with path `src/index.ts` (builder territory).
**Assertions:**
- `result.sections.length === 0` (section dropped)
- `result.warnings.length === 1`
- `result.warnings[0]` contains `'src/index.ts'` and `'not permitted for role designer'`

---

### VS3-B-13: Mixed valid + out-of-role paths

**Setup:** Role = `designer`.
**Input:** Two sections — `docs/requirements.md` (valid) and `src/index.ts` (out of role).
**Assertions:**
- `result.sections.length === 1`, sections[0].path = `docs/requirements.md`
- `result.warnings.length === 1`, warning mentions `src/index.ts`

**Why warnings not errors:** The agent may legitimately propose "here is what I would write to src/index.ts" as guidance for builder without it being a security concern. Drop and warn is safer than hard fail.

---

### VS3-B-14: Whitespace trimmed

**Input:** Path with leading/trailing spaces; content with leading/trailing newlines.
**Assertions:** Path and content trimmed correctly in result.

---

### VS3-B-15: Retry prompt sent on first ParseError

**Setup:** Mock `LLMProvider` programmed to return malformed output on turn 1, valid SLE-OUTPUT on turn 2.
**Steps:** Call `agentRunner.run(nodeId, cycleState)`.
**Assertions:**
- LLM called twice
- Second call's messages include a "repair" message referencing the parse error
- Final result uses the second (valid) output

---

### VS3-B-16: Second ParseError propagates

**Setup:** Mock provider returns malformed output on both turn 1 and turn 2.
**Steps:** Call `agentRunner.run(nodeId, cycleState)`.
**Assertions:**
- LLM called twice (no third attempt)
- Node marked failed
- `result.success === false`
- `result.error` contains parse error message

---

### VS3-B-17: Warnings do not prevent valid sections from writing

**Setup:** Role = `designer`. Input has one valid section + one out-of-role section. Mock filesystem.
**Steps:** `agentRunner.run()` completes.
**Assertions:**
- Valid section written to disk
- Out-of-role section NOT written to disk
- `result.success === true`

---

### VS3-B-18: Recognised extensions list

**Input variants (one test each, collapsed into one scenario):** `.md`, `.ts`, `.js`, `.json`, `.yaml`, `.yml`, `.txt`, `.sh`, `.py`.
**Assertions:** Each accepted without ParseError. `.exe`, `.dll`, `.rb`, `.php` each throw ParseError with "unrecognised extension".

---

## Category C — DDR-030 Multi-turn Agent Loop

**Mock strategy for all C tests:** Mock `LLMProvider`. Pre-program response sequences. Mock filesystem for tool handlers (`read_file`, `list_directory`).

---

### VS3-C-01: Single turn — immediate SLE-OUTPUT

**Setup:** Mock provider returns SLE-OUTPUT in turn 1.
**Steps:** `agentRunner.run(nodeId, cycleState)`.
**Assertions:**
- Provider called once
- `result.success === true`
- Turn count written to run artifacts = 1

---

### VS3-C-02: Two turns — read_file then SLE-OUTPUT

**Setup:**
- Turn 1 response: `{ stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'read_file', input: { path: 'docs/requirements.md' } }] }`
- Mock fs: `docs/requirements.md` contains "# Requirements\nBuild a CLI tool."
- Turn 2 response: SLE-OUTPUT with `docs/architecture.md`

**Steps:** `agentRunner.run('DESIGN', cycleState)`.
**Assertions:**
- Provider called twice
- Turn 2 messages include tool result: `{ role: 'user', content: [{ type: 'tool_result', content: '# Requirements\nBuild a CLI tool.' }] }`
- `result.success === true`
- Turn count in run artifacts = 2

---

### VS3-C-03: Three turns — two read_file calls then SLE-OUTPUT

**Setup:** Turn 1 → tool_use(read_file), turn 2 → tool_use(read_file), turn 3 → SLE-OUTPUT.
**Assertions:** Provider called 3 times. Turn count = 3. Both tool results included in messages.

---

### VS3-C-04: Max turns exceeded

**Setup:** Mock provider always returns `tool_use` response (never SLE-OUTPUT). MAX_AGENT_TURNS = 10.
**Steps:** `agentRunner.run(nodeId, cycleState)`.
**Assertions:**
- Provider called exactly 10 times
- `result.success === false`
- `result.error` contains "max turns"

---

### VS3-C-05: Tool call with path outside read allowlist

**Setup:** Turn 1 → `tool_use(read_file, { path: '/etc/passwd' })`. Turn 2 → SLE-OUTPUT.
**Assertions:**
- Tool result in turn 2 messages: `{ error: 'path not permitted' }`
- Provider not given file contents
- Cycle continues to turn 2 (loop not broken by bad tool call)

---

### VS3-C-06: list_directory returns file list

**Setup:** Turn 1 → `tool_use(list_directory, { path: 'docs/' })`. Mock fs: docs/ contains `requirements.md`, `architecture.md`. Turn 2 → SLE-OUTPUT.
**Assertions:**
- Tool result contains `['docs/requirements.md', 'docs/architecture.md']` (or equivalent format)
- Provider called twice

---

### VS3-C-07: read_file on non-existent file

**Setup:** Turn 1 → `tool_use(read_file, { path: 'docs/nonexistent.md' })`. Mock fs: file does not exist. Turn 2 → SLE-OUTPUT.
**Assertions:**
- Tool result: `{ error: 'file not found' }`
- Loop continues to turn 2

---

### VS3-C-08: Turn count written to run artifacts

**Setup:** 2-turn interaction.
**Assertions:**
- `runArtifacts` updated with `{ node_id, turns_taken: 2, tool_calls: [{ tool: 'read_file', path: '...', turn: 1 }] }`

---

### VS3-C-09: Tool call log written to run artifacts

**Setup:** 3-turn interaction with 2 tool calls.
**Assertions:** `run_artifacts.tool_calls.length === 2`. Each tool call has `tool`, `path`, `turn` fields.

---

### VS3-C-10: stop_reason 'tool_use' handled

**Setup:** Turn 1 → `stop_reason: 'tool_use'`. Turn 2 → `stop_reason: 'end_turn'` with SLE-OUTPUT.
**Assertions:** Loop continues after tool_use. Exits cleanly after end_turn.

---

### VS3-C-11: stop_reason 'end_turn' without SLE-OUTPUT → error

**Setup:** Turn 1 → `stop_reason: 'end_turn'` with plain text (no SLE-OUTPUT block).
**Assertions:**
- `result.success === false`
- `result.error` contains "no SLE-OUTPUT"

---

### VS3-C-12: stop_reason 'max_tokens' → agent failure

**Setup:** Turn 1 → `stop_reason: 'max_tokens'`.
**Assertions:**
- `result.success === false`
- `result.error` contains "max_tokens"

---

### VS3-C-13: Malformed tool input

**Setup:** Turn 1 → `tool_use(read_file, {})` (missing `path`). Turn 2 → SLE-OUTPUT.
**Assertions:**
- Tool result: `{ error: 'invalid input: missing path' }`
- Loop continues

---

### VS3-C-14: Prior turn messages accumulated correctly

**Setup:** 3-turn interaction.
**Assertions:**
- Turn 2 `messages` param includes: original user message + turn 1 assistant message + tool result
- Turn 3 `messages` param includes all prior turns
- Messages are in chronological order

---

### VS3-C-15 and VS3-C-16: SLE-OUTPUT position

- **VS3-C-15:** SLE-OUTPUT in turn 1 — parsed correctly
- **VS3-C-16:** SLE-OUTPUT in turn 3 — parsed correctly from turn 3 assistant content (not from turn 1 or 2)

---

## Category D — Real EXEC Service

**Mock strategy for unit tests:** Inject a mock `spawn` factory. The mock returns a pre-programmed `ChildProcess`-like object (EventEmitter with `stdout`, `stderr` streams and a close event). One real subprocess integration test using `echo`.

---

### VS3-D-01: Exit code 0 → success

**Setup:** Mock spawn emits stdout "Tests passed", exit code 0.
**Steps:** `execService.run(1, 1)`.
**Assertions:**
- `result.next_node === 'VALIDATION_GATE'`
- `result.exit_code === 0`
- `result.timed_out === false`
- Node status in run artifacts: `{ status: 'complete', exit_code: 0 }`
- `map.meta.dag.exec_result.exit_code === 0`

---

### VS3-D-02: Exit code 1 → FailureReport written

**Setup:** Mock spawn emits stderr "Test failed: expected 1 got 2", exit code 1.
**Steps:** `execService.run(1, 1)`.
**Assertions:**
- `result.exit_code === 1`
- `result.next_node === 'VALIDATION_GATE'` (gate decides outcome, not EXEC)
- FailureReport written: `{ category: 'exec_failure', node: 'EXEC', detail: { exit_code: 1, stderr: 'Test failed...' } }`
- Node status: `{ status: 'failed', exit_code: 1 }`

---

### VS3-D-03: Exit code 127 (binary not found)

**Setup:** Mock spawn emits stderr "command not found: npm", exit code 127.
**Assertions:**
- FailureReport `detail.exit_code === 127`
- FailureReport `detail.stderr` contains "command not found"

---

### VS3-D-04: Timeout exceeded

**Setup:** Mock spawn never emits close event. Timeout set to 50ms.
**Steps:** `execService.run(1, 1)`.
**Assertions:**
- `result.timed_out === true`
- FailureReport written with `{ timed_out: true }`
- Process killed (mock spawn's `kill()` called)
- Returned within ~100ms (doesn't hang)

---

### VS3-D-05: stdout captured

**Setup:** Mock spawn emits stdout "line 1\nline 2\n", exit code 0.
**Assertions:**
- `result.stdout === 'line 1\nline 2\n'`
- `stdout.txt` written to `.sle/runs/1/1/exec/stdout.txt`

---

### VS3-D-06: stderr captured

**Setup:** Mock spawn emits stderr "warning: deprecated", exit code 0.
**Assertions:**
- `result.stderr === 'warning: deprecated'`
- `stderr.txt` written to `.sle/runs/1/1/exec/stderr.txt`

---

### VS3-D-07: No command configured → no-op

**Setup:** `map.exec.command` not set; `map.meta.exec_command` not set.
**Assertions:**
- `spawn` never called
- Node status: `{ status: 'complete' }`
- No FailureReport written

---

### VS3-D-08: Node status set to 'running' before spawn

**Setup:** Mock spawn delays 10ms.
**Assertions:**
- During the delay, node status in run artifacts is `{ status: 'running' }`
- After close: `{ status: 'complete' }` or `{ status: 'failed' }`

---

### VS3-D-09: FailureReport includes command string

**Setup:** Map has `exec.command: 'npm test'`. Spawn exits with code 1.
**Assertions:** FailureReport `detail.command === 'npm test'`.

---

### VS3-D-10: exit_code written to map before ValidationGate

**Setup:** Spawn exits with code 1.
**Assertions:** After `execService.run()` returns, `mapManager.read()` shows `meta.dag.exec_result.exit_code === 1`.

---

### VS3-D-11: ValidationGate — exit_code 0 passes

**Setup:** Map has `meta.dag.exec_result.exit_code: 0`. Manifest shows BUILD and EXEC complete.
**Steps:** `validationGateService.run(1, 1, 'cycle-id')`.
**Assertions:** `result.passed === true`.

---

### VS3-D-12: ValidationGate — exit_code 1 fails

**Setup:** Map has `meta.dag.exec_result.exit_code: 1`. Manifest shows BUILD and EXEC complete.
**Assertions:** `result.passed === false`. FailureReport present.

---

### VS3-D-13: ValidationGate — timed_out fails

**Setup:** Map has `meta.dag.exec_result.timed_out: true` (any exit code).
**Assertions:** `result.passed === false`.

---

### VS3-D-14: ValidationGate — BUILD not complete fails

**Setup:** Manifest shows EXEC complete but BUILD status is 'running'.
**Assertions:** `result.passed === false`.

---

### VS3-D-15: Large stdout truncated in FailureReport detail

**Setup:** Mock spawn emits 200 KB of stdout, exit code 1.
**Assertions:**
- `stdout.txt` artifact contains full 200 KB
- FailureReport `detail.stdout` truncated to 10 KB with truncation marker

---

### VS3-D-16: Command with spaces and arguments

**Setup:** Map has `exec.command: 'npm run test -- --coverage'`.
**Assertions:**
- Spawn called with correct binary and args split (not passed as single string)
- No shell injection risk (spawn uses array form, not `{ shell: true }`)

---

### VS3-D-17: Command runs in projectRoot as cwd

**Setup:** Mock spawn records the options passed.
**Assertions:** `spawn` options include `cwd: projectRoot`.

---

### VS3-D-18: Spawn error (ENOENT) → FailureReport

**Setup:** Mock spawn immediately emits `error` event with `{ code: 'ENOENT', message: 'spawn npm ENOENT' }`.
**Assertions:**
- `result.exit_code === -1` (or similar sentinel)
- FailureReport written with message "spawn error: spawn npm ENOENT"

---

### VS3-D-19: Manifest updated with exec outcome

**Setup:** Spawn exits code 0.
**Assertions:**
- After `execService.run()`, manifest node entry for EXEC has `status: 'complete'`
- Manifest node entry for EXEC has `exit_code: 0`

---

### VS3-D-20: Real subprocess — echo (integration)

**Setup:** Real `ExecService` (no mock spawn). Map has `exec.command: 'echo hello'`. Temp project dir.
**Assertions:**
- `result.exit_code === 0`
- `result.stdout` contains "hello"
- `stdout.txt` written to artifact dir

**Why this test:** Proves the spawn wiring works end-to-end. `echo` is universally available and exits immediately.

---

## Category E — Debugger Agent + Recovery Loop

**Mock strategy:** Mock `DAGRunner.runNode()` for DEBUGGER calls. Mock `ExecService.run()` and `ValidationGateService.run()` to control pass/fail. Real `CycleRunner` with mock deps.

---

### VS3-E-01: DEBUGGER node resolves to 'debugger' role

**Setup:** `NODE_TO_ROLE` map.
**Assertions:** `roleForNode('DEBUGGER') === 'debugger'`.

---

### VS3-E-02: Failure report injected into CycleStateContext

**Setup:** Mock ValidationGateService returns `{ passed: false, failure_report: { category: 'exec_failure', ... } }`.
**Steps:** CycleRunner reaches VALIDATION_GATE.
**Assertions:** When `dagRunner.runNode('DEBUGGER', cycleState)` is called, `cycleState.failure_report` is set.

---

### VS3-E-03: Debugger called with correct context

**Setup:** Mock dagRunner records the cycleState passed to `runNode('DEBUGGER', ...)`.
**Assertions:** `cycleState.current_node === 'DEBUGGER'`. `cycleState.failure_report.node === 'EXEC'`.

---

### VS3-E-04: Debugger output paths — src/ allowed

**Setup:** Role = 'debugger'. Path = 'src/index.ts'.
**Assertions:** `validateOutputPath('src/index.ts', 'debugger') === true`.

---

### VS3-E-05: Debugger output paths — tests/ allowed

**Assertions:** `validateOutputPath('tests/index.test.ts', 'debugger') === true`.

---

### VS3-E-06: Debugger output paths — docs/ rejected

**Assertions:** `validateOutputPath('docs/requirements.md', 'debugger') === false`.

---

### VS3-E-07: ContextManager includes failure_report in DEBUGGER state summary

**Setup:** Build a `CycleStateContext` with `failure_report` set. Call `buildStateSummary()`.
**Assertions:** Output contains failure category, node, and message from failure_report.

---

### VS3-E-08: DEBUGGER → EXEC in recovery path

**Setup:** CycleRunner mock deps. ValidationGateService fails on attempt 1, passes on attempt 2. DAGRunner.runNode('DEBUGGER') succeeds.
**Assertions:**
- After DEBUGGER runs, `currentNode` set back to EXEC
- ExecService.run() called twice (original + retry)

---

### VS3-E-09: Single failure + recovery → completed

**Setup:** ExecService fails once, passes on retry. ValidationGate fails once, passes on retry. Debugger succeeds.
**Assertions:**
- `result.completed === true`
- `result.debug_attempts_used === 1`

---

### VS3-E-10: Double failure + recovery → completed

**Setup:** ExecService fails twice, passes on third. Debugger succeeds each time.
**Assertions:**
- `result.completed === true`
- `result.debug_attempts_used === 2`

---

### VS3-E-11: MAX_DEBUG_ATTEMPTS exhausted → cycle halts

**Setup:** ExecService always fails. MAX_DEBUG_ATTEMPTS = 3.
**Assertions:**
- Debugger called 3 times (attempts 1, 2, 3)
- `result.completed === false`
- `result.debug_attempts_used === 3`
- `result.failure_report` set (from last ValidationGate failure)
- `result.error` contains "3 debug attempts"

---

### VS3-E-12: debug_attempt counter incremented

**Setup:** Mock `mapManager.incrementDebugAttempt()`.
**Steps:** VALIDATION_GATE fails.
**Assertions:** `incrementDebugAttempt()` called once per VALIDATION_GATE failure.

---

### VS3-E-13: debug_attempt reset at cycle start

**Setup:** Previous cycle left `debug_attempt: 2` in RuntimeMap.
**Steps:** New `CycleService.start()` call.
**Assertions:** `map.meta.dag.debug_attempt === 0` after start.

---

### VS3-E-14: MAX_DEBUG_ATTEMPTS = 3 enforced

**Assertions:** The constant is 3. After 3 attempts (`debug_attempt > MAX_DEBUG_ATTEMPTS` where MAX=3), loop exits.

---

### VS3-E-15: CycleRunResult includes debug_attempts_used

**Setup:** Cycle completes after 2 debug attempts.
**Assertions:** `result.debug_attempts_used === 2`.

---

### VS3-E-16: Failure after MAX includes final failure_report

**Setup:** ExecService always fails.
**Assertions:** `result.failure_report` equals the last FailureReport returned by ValidationGateService (not the first).

---

### VS3-E-17: Debugger failure halts cycle immediately

**Setup:** DAGRunner.runNode('DEBUGGER') returns `{ success: false, error: 'LLM error' }`.
**Assertions:**
- `result.completed === false`
- `result.error` contains 'LLM error'
- ExecService NOT retried after Debugger failure

---

### VS3-E-18: shouldSkipAtDepth('DEBUGGER') is always false

**Assertions:** `shouldSkipAtDepth('DEBUGGER', 'standard') === false`, `shouldSkipAtDepth('DEBUGGER', 'deep') === false`.

---

## Category F — Integration Tests

**Mock strategy:** Real services. Mock `LLMProvider` via `DebugAwareMockLLM`. Mock `spawn` for EXEC (except VS3-INT-01 which uses `echo`). Real filesystem (temp dir per test). All tests use `CycleService.start({ intent: '...', force: true })` to bypass discovery.

---

### VS3-INT-01: Happy path — EXEC succeeds first try

**Setup:**
- `DebugAwareMockLLM` returns appropriate SLE-OUTPUT per node
- EXEC command: `echo "all tests passed"` (real subprocess)
- All agents: single-turn responses

**Steps:** Full cycle from `CycleRunner.run()`.

**Assertions:**
- `result.completed === true`
- `result.debug_attempts_used === 0`
- `manifest.outcome === 'complete'`
- Snapshot created
- `docs/requirements.md`, `docs/plan.md`, `src/index.ts` exist

**Why this test:** Regression guard. VS2 integration test should still pass with VS3 code. Real subprocess EXEC proves the exec wiring works in the full cycle, not just in isolation.

---

### VS3-INT-02: Single failure — EXEC fails once, Debugger fixes, EXEC passes

**Setup:**
- Mock spawn: first call exits code 1, stderr "ReferenceError: foo is not defined". Second call exits code 0.
- `DebugAwareMockLLM` returns valid Debugger output on DEBUGGER turn (fixes `src/index.ts`).

**Steps:** `CycleRunner.run()`.

**Assertions:**
- `result.completed === true`
- `result.debug_attempts_used === 1`
- Mock spawn called twice
- DAGRunner.runNode('DEBUGGER') called once
- `manifest.outcome === 'complete'`
- `snapshot.json` exists and has `artifacts` array

**This is the primary proof of VS3.**

---

### VS3-INT-03: Double failure — EXEC fails twice, Debugger fixes on attempt 2

**Setup:**
- Mock spawn: calls 1 and 2 exit code 1. Call 3 exits code 0.
- `DebugAwareMockLLM`: Debugger output on attempt 1 is insufficient (partial fix). Debugger output on attempt 2 is correct.

**Steps:** `CycleRunner.run()`.

**Assertions:**
- `result.completed === true`
- `result.debug_attempts_used === 2`
- Mock spawn called 3 times
- DEBUGGER node run twice

---

### VS3-INT-04: Exhaustion — EXEC fails 4 times

**Setup:**
- Mock spawn: always exits code 1.
- `DebugAwareMockLLM`: Debugger always produces some output (but can't fix a stubborn failure).
- `MAX_DEBUG_ATTEMPTS = 3`.

**Steps:** `CycleRunner.run()`.

**Assertions:**
- `result.completed === false`
- `result.debug_attempts_used === 3`
- Mock spawn called 4 times (original + 3 retries)
- DEBUGGER node run 3 times
- `result.failure_report.category === 'exec_failure'`
- `manifest.outcome === 'failed'`

---

### VS3-INT-05: Multi-turn — DESIGN agent reads a file before producing output

**Setup:**
- `DebugAwareMockLLM`: for DESIGN node, turn 1 returns `tool_use(read_file, { path: 'docs/requirements.md' })`. Turn 2 returns SLE-OUTPUT with `docs/architecture.md`.
- Other nodes: single-turn.
- EXEC: succeeds first try.

**Steps:** `CycleRunner.run()`.

**Assertions:**
- `result.completed === true`
- Run artifacts for DESIGN node show `turns_taken: 2`
- `tool_calls` log in run artifacts has 1 entry for DESIGN: `{ tool: 'read_file', path: 'docs/requirements.md', turn: 1 }`
- `docs/architecture.md` exists (produced by DESIGN)

---

### VS3-INT-06: Malformed output — agent returns broken SLE-OUTPUT, retry succeeds

**Setup:**
- `DebugAwareMockLLM`: for PLAN node, turn 1 returns a response with broken SLE-OUTPUT (missing closing delimiter). Turn 2 (repair turn) returns valid SLE-OUTPUT.
- Other nodes: single-turn.
- EXEC: succeeds.

**Steps:** `CycleRunner.run()`.

**Assertions:**
- `result.completed === true`
- LLM provider called twice for PLAN node (turn 1 + repair turn)
- Second PLAN call messages include repair prompt mentioning "missing closing delimiter"
- `docs/plan.md` exists (produced from the valid second response)

---

## Testing Infrastructure Notes

### DebugAwareMockLLM

Extends `NodeAwareMockLLM` from VS2. Key additions:

```typescript
class DebugAwareMockLLM {
  private execCallCount = 0;
  private maxFailingExecCalls: number;  // configure per-test

  complete(request: LLMRequest): Promise<LLMResponse> {
    const node = this.detectNode(request);
    
    if (node === 'DEBUGGER') {
      return this.debuggerResponse(request);
    }
    
    // For EXEC-adjacent context, control pass/fail via execCallCount
    // For multi-turn tests, return tool_use on first call for target node
    // ...
  }
}
```

### Mock spawn factory

```typescript
function makeMockSpawn(responses: Array<{ exitCode: number; stdout: string; stderr: string }>) {
  let callIndex = 0;
  return () => {
    const response = responses[callIndex++] ?? responses[responses.length - 1];
    const proc = new MockChildProcess();
    setImmediate(() => {
      proc.stdout.emit('data', response.stdout);
      proc.stderr.emit('data', response.stderr);
      proc.emit('close', response.exitCode);
    });
    return proc;
  };
}
```

### Temp directory lifecycle

```typescript
let tmpDir: string;
beforeEach(async () => { tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vs3-test-')); });
afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });
```

### Test execution

```bash
# All VS3 tests:
node --import tsx --test src/sdk-orchestrator/v3/tests/**/*.test.ts

# Per-phase:
node --import tsx --test src/sdk-orchestrator/v3/tests/anthropic-provider.test.ts
node --import tsx --test src/sdk-orchestrator/v3/tests/output-parser.test.ts
node --import tsx --test src/sdk-orchestrator/v3/tests/agent-runner-multiturn.test.ts
node --import tsx --test src/sdk-orchestrator/v3/tests/exec-service.test.ts
node --import tsx --test src/sdk-orchestrator/v3/tests/debugger-agent.test.ts
node --import tsx --test src/sdk-orchestrator/v3/tests/cycle-runner-recovery.test.ts
node --import tsx --test src/sdk-orchestrator/v3/tests/cycle-runner-integration.test.ts
```

### What is never mocked

- `RuntimeMapManagerImpl` — real YAML reads/writes in temp dir
- `RunArtifactManager` — real file I/O in temp dir
- `CycleService`, `SnapshotService`, `ContextManager` — real implementations
- File existence assertions — real disk checks at test end

### What is always mocked

- `LLMProvider` — no real Anthropic API calls in any test
- `spawn` — no real subprocesses except VS3-D-20 and VS3-INT-01
- Clock — timestamps are not asserted (avoid flake)
