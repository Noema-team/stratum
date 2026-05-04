# DDR-030 — Agent runtime environment and multi-turn execution

**Date:** 2026-05-04 · **Status:** deferred (post-MVP)
**Affects:** types.md, daemon-api.md, dag-execution.md, context-manager.md, prompt-templates.md, job-dispatch.md

## Context

### The gap

DDR-029 defined what agents *produce* (typed output contracts). But the specs are completely silent on how agents *execute*. The following are unspecified:

1. **Agent runner** — how the daemon transforms `AgentInput` into `AgentResult` via an LLM call
2. **LLM provider interface** — DDR-003 names `OpenAICompatibleProvider` and `AnthropicProvider` but never defines their method signatures
3. **Output parsing** — how the daemon extracts typed output from raw LLM responses and writes artifacts to disk
4. **Multi-turn within a node** — agents are single-shot today. If an agent needs information the context manager didn't provide, there is no mechanism to request it
5. **Streaming** — no spec for streaming LLM responses during DAG node execution (only Facilitator chat)

### The single-shot problem

Current agent invocation model:

```
Context manager assembles slice → AgentInput → single LLM call → AgentResult → write artifacts
```

This works when the context manager can predict exactly what an agent needs. It breaks when:

- **Builder** sees `import { UserService } from './users'` in the architecture and needs to read the existing file to understand patterns, conventions, and types it must conform to
- **Builder** needs to check what dependencies exist in `package.json` before generating imports
- **Debugger** is diagnosing a failure and needs to read the actual failing source file, not just the error trace and architecture
- **Designer** needs to check what already exists in the codebase before proposing architecture that conflicts with existing structure
- **Planner** needs to understand the existing test framework setup before planning test scripts

The context manager cannot predict all of these needs — they depend on the agent's reasoning during execution. Today, if an agent lacks information, it either hallucinates or produces suboptimal output. There is no way to say "I need to see file X before I can continue."

### Principle

> Agents declare what they need. The system decides whether to provide it. The agent never accesses anything directly.

This is consistent with the existing architecture: agents don't touch the filesystem, don't run commands, don't make network requests. They produce typed declarations (DDR-029). Read requests are the same pattern in the other direction — typed declarations for information, validated and fulfilled by the DAG runner.

## Decision

### 1. Agent runner

The agent runner is a component inside the daemon that manages the lifecycle of a single agent invocation (or multi-turn loop within a single DAG node).

```typescript
export interface AgentRunner {
  invoke(input: AgentInput, config: AgentRoleConfig): Promise<AgentTurnResult>
}

export type AgentTurnResult =
  | { type: 'output'; result: AgentResult }
  | { type: 'read_request'; requests: ReadRequest[]; partial_output?: string }
```

The DAG runner calls `AgentRunner.invoke()`. The return is either:
- A final `AgentResult` (agent is done, DAG node completes)
- A `ReadRequest` (agent needs more information before it can finish)

### 2. LLM provider interface

```typescript
export interface LLMProvider {
  complete(request: LLMRequest): Promise<LLMResponse>
  stream(request: LLMRequest): AsyncIterable<LLMChunk>
}

export interface LLMRequest {
  messages: LLMMessage[]
  model: string
  temperature: number
  max_tokens: number
  response_format?: { type: 'json_object' } | { type: 'text' }
  stop_sequences?: string[]
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface LLMResponse {
  content: string
  finish_reason: 'stop' | 'max_tokens' | 'tool_call'
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
  duration_ms: number
}

export interface LLMChunk {
  content: string
  finish_reason?: 'stop' | 'max_tokens'
}
```

Two implementations (DDR-003):
- `OpenAICompatibleProvider` — covers OpenAI, OpenRouter, GLM, Zai
- `AnthropicProvider` — Claude via native SDK, adapts to the same interface

The factory reads `AgentLLMConfig` from `agents.yaml` and returns the correct implementation.

### 3. Agent invocation lifecycle

When the DAG runner reaches an L3 node:

```
1. Determine agent role from node definition (e.g., PLAN → planner)
2. Load AgentRoleConfig from agents.yaml (merge chain)
3. Set state.current_task (instruction text)
4. Context manager assembles AssembledContext
5. Construct AgentInput { role, context, instruction }
6. Call AgentRunner.invoke(input, config)
7. Agent runner:
   a. Build LLMMessage[] from AssembledContext:
      - system → AssembledContext.system_prompt
      - user → formatted artifact slices + state_summary + task + failure_context
   b. Call LLMProvider.complete(request) or LLMProvider.stream(request)
   c. Parse LLM response:
      - If JSON output expected → parse and validate against role's output schema
      - If prose output expected → extract markdown content
   d. Return AgentTurnResult
8. DAG runner handles result:
   - If type: 'output' → write artifacts, record DAGEvent, advance node
   - If type: 'read_request' → fulfill requests, append context, invoke again (§4)
```

### 4. Read requests — multi-turn within a node

#### Mechanism

When an agent determines it needs information not in its context slice, it produces a `ReadRequest` instead of a final output:

```typescript
export interface ReadRequest {
  type: ReadRequestType
  path?: string
  query?: string
  reason: string
}

export type ReadRequestType =
  | 'file'              // read a specific file by path
  | 'file_search'       // find files matching a glob pattern
  | 'symbol_lookup'     // find a specific symbol (function, class, type) across the project
  | 'dependency_check'  // check if a package/dependency exists
```

#### Full request types

```typescript
export interface FileReadRequest extends ReadRequest {
  type: 'file'
  path: string                   // e.g., "src/services/user.ts"
  range?: { start: number; end: number }  // optional line range
}

export interface FileSearchRequest extends ReadRequest {
  type: 'file_search'
  pattern: string                // glob, e.g., "src/**/*.service.ts"
  max_results?: number           // default 10
}

export interface SymbolLookupRequest extends ReadRequest {
  type: 'symbol_lookup'
  symbol: string                 // e.g., "UserService"
  file_hint?: string             // optional: "src/services/user.ts"
}

export interface DependencyCheckRequest extends ReadRequest {
  type: 'dependency_check'
  package: string                // e.g., "zod"
  check_type: 'prod' | 'dev' | 'any'
}
```

#### How it works in practice

```
Turn 1:
  Context manager assembles Builder's slice (architecture, requirements, test-plan, plan)
  Builder starts reasoning:
    "I need to implement a UserService. The architecture says it's in src/services/.
     Let me check if there's an existing pattern..."
  Builder produces ReadRequest:
    { type: 'file_search', pattern: 'src/services/*.ts', reason: 'Check existing service patterns' }

Turn 2:
  DAG runner runs safety gate: role=Builder, type=file_search → allowed. Budget OK.
  DAG runner fulfills with intelligent ranking:
    "3 files matched:
     1. src/services/auth.ts (48 lines) — Classes: AuthService
     2. src/services/item.ts (62 lines) — Classes: ItemService
     3. src/services/orderProcessor.ts (340 lines, 12.4KB) — Note: large file"
  Builder sees the listing:
    "auth.ts is small and probably the canonical pattern. Let me read it."
  Builder produces ReadRequest:
    { type: 'file', path: 'src/services/auth.ts', reason: 'Understand existing service pattern for consistency' }

Turn 3:
  DAG runner runs safety gate: path OK, file is small (under 5KB threshold) → return full content.
  Builder sees the full file:
    "I see — services use dependency injection via constructor, return Result<T> types,
     and follow the repository pattern. I also see they import from '../types/result'.
     Let me check that type."
  Builder produces ReadRequest:
    { type: 'symbol_lookup', symbol: 'Result', reason: 'Understand return type used by existing services' }

Turn 4:
  DAG runner fulfills symbol lookup: finds Result in src/types/result.ts, returns definition + imports.
  Builder sees the Result type:
    "Good — Result<T> is { ok: boolean; value?: T; error?: string }. Now I have enough context."
  Builder produces final BuilderOutput with file operations that follow the discovered patterns.
```

#### Turn budget

Each DAG node with an L3 agent has a configurable **turn budget** — maximum number of round-trips before the agent MUST produce a final output.

```typescript
export interface AgentTurnConfig {
  max_turns: number              // default 5, hard cap 10
  max_read_requests_per_turn: number  // default 3
  total_read_bytes_limit: number      // default 100KB across all turns
}
```

If the agent hits `max_turns` without producing a final output, the DAG runner forces termination:
- The agent receives a final user message: "Maximum turns reached. Produce your output now with available information."
- One final LLM call, which MUST produce output (not another read request)
- If the final call still produces a read request, it's treated as `agent_empty_output` (retry once, then halt)

### 5. Read request processing — two-phase gate

Read requests go through two phases: **mechanical safety validation** then **intelligent fulfillment**. Most requests pass validation cleanly — the safety gate is a hard boundary, not a judgment call. The intelligence is in *how* the DAG runner fulfills, not *whether* it fulfills.

#### Phase 1: Mechanical safety gate

The DAG runner checks hard rules before any fulfillment. These are non-negotiable safety constraints:

1. **Role permission** — does this role have read access? (see per-role table below)
2. **Request type permission** — is this request type allowed for this role?
3. **Budget check** — has the turn budget been exhausted? Has the byte budget been exceeded?
4. **Path rules:**
   - No `.sle/` access — agents never read internal state
   - No absolute paths — all paths relative to project root
   - No `..` traversal — no escaping project root
   - No `.env`, `.git/`, `credentials.*`, `*.pem`, `*.key` — blocked patterns (configurable in `agents.yaml → read_restrictions.blocked_patterns`)
   - No `.ssh/`, `secrets/`, `private/` — blocked directories (configurable in `agents.yaml → read_restrictions.blocked_paths`)
5. **File size limit** — files exceeding `max_file_read_bytes` (default 20KB) trigger intelligent extraction instead of full return

If any check fails, the request is rejected with a structured reason injected into context:

```
[READ REJECTED]
Request: file read "secrets/api-keys.json"
Reason: path matches blocked pattern (secrets/)
You have {remaining_turns} turns remaining.
```

Most requests pass this gate. It is not filtering for relevance — that's the fulfillment phase.

#### Phase 2: Intelligent fulfillment

Once a request passes safety validation, the DAG runner fulfills it. Fulfillment is where the intelligence lives — the DAG runner returns *useful* content, not raw dumps.

**File reads — targeted extraction:**

When an agent requests a file that exceeds a size threshold (configurable, default 5KB), the DAG runner performs targeted extraction rather than returning the whole file:

```typescript
export interface FileReadConfig {
  max_full_return_bytes: number   // default 5KB — files smaller returned whole
  targeted_window_lines: number   // default 50 lines per window
  max_windows_per_file: number    // default 3
}
```

The DAG runner reads the file and returns:
- **Small files** (under 5KB): full content, no extraction needed
- **Large files**: the agent must provide a `focus` hint in the request. The DAG runner extracts the most relevant section(s) based on the hint. If no hint is provided, the DAG runner returns a structured summary:

```
[READ RESULT — file (truncated)]
Source: src/services/orderProcessor.ts (340 lines, 12.4KB)
Reason: Understand existing service pattern for consistency
Note: File exceeds full-return threshold. Showing structure summary.
---
Lines 1-15: imports (express, zod, Result, Logger)
Lines 17-42: interface OrderProcessorConfig { ... }
Lines 44-89: class OrderProcessor
  Lines 46-58: constructor(config, repository, eventBus)
  Lines 60-78: async processOrder(order): Promise<Result<Order>>
  Lines 80-88: private validateOrder(order): ValidationResult
Lines 91-120: class OrderProcessorFactory
Lines 122-340: tests
---
To read a specific section, request with focus hint:
{ type: 'file', path: 'src/services/orderProcessor.ts', focus: 'class OrderProcessor' }
```

The agent can then request a targeted follow-up to get the specific lines it needs.

**File search — ranked results:**

When an agent searches for files, the DAG runner doesn't just return a flat glob match. It ranks and annotates:

```
[READ RESULT — file_search]
Pattern: src/services/*.ts
Reason: Check existing service patterns
---
3 files matched (showing all):

1. src/services/auth.ts (48 lines, 1.2KB)
   Classes: AuthService
   Exports: AuthService, AuthConfig

2. src/services/item.ts (62 lines, 1.8KB)
   Classes: ItemService
   Exports: ItemService, ItemRepository

3. src/services/orderProcessor.ts (340 lines, 12.4KB)
   Classes: OrderProcessor, OrderProcessorFactory
   Exports: OrderProcessor, OrderProcessorFactory
   Note: large file — request with focus for targeted read
---
You have {remaining_turns} turns remaining.
```

Ranking signals (in priority order):
1. Files already referenced in the agent's context (path proximity — mentioned in architecture, plan, etc.)
2. Recency of modification (git mtime)
3. File size (smaller files first — more likely to be focused utilities)

**Symbol lookup — definition with context:**

Symbol lookup returns the symbol definition plus its immediate context (imports, type annotations, surrounding interface), not just the raw lines:

```
[READ RESULT — symbol_lookup]
Symbol: AuthService
File: src/services/auth.ts
---
import { Result } from '../types/result';
import { Logger } from '../utils/logger';

export interface AuthConfig {
  tokenExpiry: number;
  refreshTokenExpiry: number;
}

export class AuthService {
  constructor(
    private config: AuthConfig,
    private userRepo: UserRepository,
    private logger: Logger,
  ) {}

  async validateToken(token: string): Promise<Result<User>> { ... }
  async refreshToken(token: string): Promise<Result<string>> { ... }
}
---
```

The DAG runner extracts the symbol using pattern matching (MVP: regex on `export (function|const|class|interface|type) {symbol}`). Post-MVP: language-aware AST resolution via the knowledge engine (DDR-005).

**Dependency check — existence + version:**

```
[READ RESULT — dependency_check]
Package: zod
Found in: package.json → dependencies
Version: ^3.22.0
Installed: yes (node_modules/zod exists)
---
```

MVP: reads `package.json` directly. Post-MVP: resolves from lockfile.

#### Per-role read permissions

| Role | Can read-request? | Allowed types | Rationale |
|------|-------------------|---------------|-----------|
| Builder | Yes | `file`, `file_search`, `symbol_lookup`, `dependency_check` | Needs to understand existing code to produce consistent output |
| Debugger | Yes | `file`, `file_search`, `symbol_lookup` | Needs to read failing source files for root-cause analysis |
| Designer | Yes | `file_search`, `dependency_check` | Needs to understand project structure before proposing architecture |
| Planner | Yes | `file_search`, `symbol_lookup` | Needs to understand existing code structure for accurate plans |
| Tester | No | — | TDD isolation: Tester must not see implementation. Tests derive from requirements only. |
| Critic | No | — | Reviews architecture/requirements only. No implementation context needed. |
| Evaluator | No | — | Evaluates against intent. Already has run artifacts in context. |
| Historian | No | — | Writes audit entries only. |
| Explorer | Yes | `file`, `file_search`, `symbol_lookup`, `dependency_check` | Research role — broadest read access |
| Facilitator | No | — | Conversational role. Context manager provides what's needed. |

#### Content injection format

When the DAG runner fulfills a read request, the result is injected as a new `user` message in the conversation:

```
[READ RESULT — {type}]
Source: {path or query}
Reason: {agent's stated reason}
---
{content}
---
End of read result. You have {remaining_turns} turns remaining.
```

This is not part of the artifact store — it's ephemeral context for the current agent invocation only. It does not persist across DAG nodes or iterations.

### 6. Updated AssembledContext and message construction

The `AssembledContext` type stays the same for the initial turn. For subsequent turns, the agent runner appends to the message array:

```typescript
export interface AgentInvocationState {
  input: AgentInput
  config: AgentRoleConfig
  messages: LLMMessage[]           // grows with each turn
  turns_used: number
  read_bytes_total: number
  turn_config: AgentTurnConfig
}
```

**Turn 1 messages:**
```
[
  { role: 'system', content: AssembledContext.system_prompt },
  { role: 'user',   content: <formatted slices + state + task> }
]
```

**Turn N messages:**
```
[
  { role: 'system',    content: AssembledContext.system_prompt },
  { role: 'user',      content: <formatted slices + state + task> },
  { role: 'assistant', content: <agent's read request from turn 1> },
  { role: 'user',      content: <read result from DAG runner> },
  { role: 'assistant', content: <agent's read request from turn 2> },
  { role: 'user',      content: <read result from DAG runner> },
  ...
]
```

The `LLMMessage[]` array is the full multi-turn conversation for this single DAG node invocation. It is **ephemeral** — discarded after the DAG node completes. Only the final `AgentResult` is persisted to the artifact store.

### 7. Streaming

For DAG node execution (L3), streaming is **internal to the agent runner** only. The DAG runner does not stream agent reasoning to the UI during node execution — it waits for the final `AgentResult`.

For Facilitator chat mode, streaming is already specified via WebSocket (`chat.message` events). No change.

Post-MVP: DAG node streaming to the UI (show agent reasoning in real-time) is a candidate for the post-MVP roadmap.

### 8. LLM response parsing

The agent runner parses raw LLM responses into typed `AgentOutput` (DDR-029):

```typescript
export function parseAgentResponse(
  raw: string,
  role: AgentRole,
  outputFormat: 'json' | 'prose'
): AgentOutput | ReadRequest[] {
  if (outputFormat === 'json') {
    const parsed = JSON.parse(extractJSON(raw))
    if (isReadRequestArray(parsed)) return parsed as ReadRequest[]
    return validateRoleOutput(parsed, role)
  }

  // prose roles: check for inline read request markers
  if (containsReadRequestMarker(raw)) {
    return extractReadRequests(raw)
  }

  return wrapProseOutput(raw, role)
}
```

For JSON-producing roles (Builder, Tester, Debugger, Evaluator, Critic), the LLM is instructed to return either:
- A valid `AgentOutput` for the role (DDR-029 schema)
- An array of `ReadRequest` objects

The agent runner detects which one and routes accordingly.

For prose-producing roles (Designer, Planner, Explorer, Historian, Facilitator), read requests are indicated by a structured marker in the prose:

```
<read_request>
{"type": "file_search", "pattern": "src/**/*.service.ts", "reason": "..."}
</read_request>
```

The agent runner extracts these markers. If present, the prose is treated as a read request. If absent, the prose is the final output.

### 9. Updated prompt template structure

Prompt templates for roles with read access gain a new section:

```markdown
## Read access
You may request additional information not in your context by producing read requests.
You have {max_turns} turns total. Each turn you may request up to {max_per_turn} reads.

Available request types:
- file: read a specific file by path
- file_search: find files matching a glob pattern
- symbol_lookup: find a specific function, class, or type
- dependency_check: check if a package exists

Format: produce a JSON array of read requests instead of your final output.
The system will fulfill your requests and return results.
```

Roles without read access do not get this section. The Tester's prompt template explicitly states:

```markdown
## Read access
None. You derive tests exclusively from requirements.md and test-plan.md.
```

### 10. Integration with existing specs

#### dag-execution.md changes

The DAG runner's node execution flow gains a multi-turn loop:

```
For each L3 DAG node:
  1. Assemble context
  2. Invoke agent runner
  3. If output → write artifacts, advance node
  4. If read_request:
     a. Phase 1: safety gate (role permission, path rules, budget)
        - If rejected → inject rejection, invoke again (goto 2, doesn't count as turn)
     b. Phase 2: intelligent fulfillment (targeted extraction, ranked results)
     c. Append results to invocation state
     d. If turns_used < max_turns → invoke again (goto 2)
     e. If turns_used >= max_turns → force final output (one more call)
```

Safety gate rejections do not count against the turn budget — the agent didn't get information, so it shouldn't be penalized.

#### context-manager.md changes

No changes to context assembly. The context manager still produces the initial `AssembledContext`. Read request results are appended by the agent runner, not the context manager.

The context manager's core invariant ("no agent ever receives raw conversation history") is preserved — the multi-turn conversation within a DAG node is not "conversation history." It is structured read-request/read-response pairs scoped to the current invocation. Previous turns from other DAG nodes or iterations are never included.

#### daemon-api.md changes

New internal type: `AgentInvocationState` (not exposed via REST API — internal to daemon).

The daemon's existing request lifecycle (lines 142-154) is unchanged for REST endpoints. The agent runner operates within step 4 ("Daemon executes command").

#### prompt-templates.md changes

- Roles with read access get a new `## Read access` section in their template
- The `## Output format` section is updated to describe both final output and read request format
- Constraint 2 is updated: "Templates must not instruct the agent to run commands, access the filesystem, or make network requests directly. Agents may request reads through the structured read-request mechanism."

#### types.md changes

New types: `AgentRunner`, `AgentTurnResult`, `ReadRequest` (and subtypes), `AgentTurnConfig`, `AgentInvocationState`, `LLMProvider`, `LLMRequest`, `LLMResponse`, `LLMMessage`, `LLMChunk`.

## Consequences

### Positive

- Builder and Debugger can investigate existing codebase — produces more consistent, grounded output
- Designer can check what exists before proposing architecture — fewer conflicts with existing structure
- Planner can understand real project structure — more accurate plans
- Two-phase gate separates safety (mechanical, fast, non-negotiable) from intelligence (how to return useful content)
- Intelligent fulfillment prevents token waste — large files get structured summaries, searches get ranked results
- Multi-turn is bounded (turn budget, byte budget) — no runaway loops
- Read requests are validated and scoped per-role — Tester isolation preserved
- Consistent with existing architecture: agents declare what they need, system decides how to provide it
- LLM provider interface is now defined — unblocks implementation
- Agent invocation lifecycle is now specified — fills the biggest spec gap

### Negative

- Multi-turn increases latency per DAG node — each turn is a full LLM round-trip
- Token costs increase — the multi-turn conversation grows the prompt with each turn
- Parsing complexity — detecting read requests vs final output requires careful prompt engineering and parsing
- Intelligent fulfillment adds implementation complexity (targeted extraction, ranking, structured summaries)
- LLMs may overuse read requests (explore too broadly) — mitigated by turn budget and per-turn request limit

### Risks

- LLMs may produce malformed read requests — mitigation: parse failure is treated as the final output (the agent runner wraps it as a prose output for the role)
- Context window overflow from accumulated read results — mitigation: `total_read_bytes_limit` caps total injected content; intelligent fulfillment trims individual results
- Targeted extraction for large files may miss the relevant section if the agent's focus hint is vague — mitigation: the structured summary lets the agent identify the right section before requesting it
- Ranking signals may not match actual relevance — mitigation: MVP uses simple heuristics (path proximity, file size), can be improved based on read-request logs

## Explicitly deferred

**Agent streaming to UI during DAG execution.** Showing agent reasoning in real-time during BUILD, PLAN, etc. is a UX feature deferred to post-MVP. The agent runner streams internally for timeout management but does not broadcast to WebSocket during node execution.

**Cross-agent read sharing.** Read results from one agent's invocation are not shared with other agents. Each invocation starts fresh. Sharing would require a shared scratchpad or knowledge cache, which is a larger feature.

**Smart read request routing.** The DAG runner could intelligently fulfill requests (e.g., resolve symbol lookups using an AST index rather than grep). MVP: simple file reads and glob searches. Post-MVP: indexed symbol resolution via the knowledge engine (cognee integration, DDR-005).

**Write-then-read within a node.** Builder produces file operations, then immediately needs to verify them. This would require applying writes mid-invocation, which breaks the "validate-then-apply" model. Deferred — the validation gate at EXEC catches issues.

**Read request caching.** If multiple agents in the same cycle request the same file, the results could be cached. MVP: no caching (each invocation reads fresh). Post-MVP: per-cycle read cache in the daemon.

## Open questions

| ID | Question | Impact | Status |
|----|----------|--------|--------|
| RE-001 | Should read-request results count against the artifact slice token budget, or is there a separate budget? | Token accounting | Open — likely separate `read_context_budget` (default 2000 tokens) carved out of the total per-role budget |
| RE-002 | Should the DAG runner log read requests for analytics (which files agents request most)? | Observability, context manager improvement | Open — useful for improving context assembly heuristics. Post-MVP. |
| RE-003 | Should Explorer have a higher turn budget than other roles? Explorer is a research role and may need more turns. | Explorer capability | Open — likely yes. Explorer default: 10 turns. Others: 5. |
| RE-004 | Can agents request reads of files produced earlier in the same cycle (e.g., Builder reads Designer's architecture.md via read request rather than context)? | Redundancy, consistency | Open — no, this would bypass context manager's slice control. Architecture.md should be in Builder's context slice already. Read requests are for files OUTSIDE the artifact system (source code, configs). |
| RE-005 | What is the parse failure recovery strategy? If an LLM returns something that is neither valid output nor valid read requests, what happens? | Robustness | Open — likely: (1) retry once with "produce valid output" instruction, (2) treat as `agent_empty_output` on second failure. |
| RE-006 | Should `dependency_check` actually resolve package versions, or just check existence in package.json / package-lock.json? | Scope of dependency information | Resolved: MVP shows version range from package.json + whether installed. Lockfile resolution post-MVP. |
| RE-007 | Should the turn budget be configurable per-role in agents.yaml, or is it a global daemon config? | Configuration granularity | Open — likely per-role in agents.yaml with a daemon-level default. |
| RE-008 | Should large-file summaries (the structure outline) be generated by a lightweight LLM call for accuracy, or is a regex/heuristic approach sufficient? | Summary quality vs latency | Open — MVP: regex/heuristic (line scanning for class/function/export patterns). Post-MVP: LLM-generated summaries cached per file version. |
