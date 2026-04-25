# Conversation Mode

**Type:** spec · **Status:** draft · **Updated:** 2026-04-22
**Depends on:** DDR-020, [types.md](../reference/types.md) §2, [state-machine.md](state-machine.md), [prompt-templates.md](prompt-templates.md), [context-manager.md](context-manager.md)
**Source material:** SLE-012 (conversation mode), DDR-020 (orthogonal chat layer)

## Overview

Conversation mode provides a persistent, freeform interaction layer between the
user and the Facilitator agent. The user can explore ideas, ask questions about
the project, discuss trade-offs, and make decisions — without starting a cycle.
When the user is ready to act, conversation context transitions into the next
development cycle via a compressed ChatContext summary.

Chat is orthogonal to system state (DDR-020). It is tracked by a boolean flag on
the chat session record, not by a machine state. Chat can be open in any of the
five system states (`idle`, `discovering`, `cycling`, `halted`, `complete`)
without blocking, interrupting, or affecting state transitions. This resolves
gap G13: SLE-012's "conversation mode is always available" no longer
contradicts the state machine.

The Facilitator operates in two modes — chat mode (freeform Q&A) and decision
mode (structured gate actions) — that can coexist when both a chat session is
open and a cycle flag is set. This spec defines the mode switching mechanism,
prompt template selection, context assembly per mode, session persistence,
decision capture, and ChatContext injection.

## Data model

### Chat session

```typescript
interface ChatSession {
  session_id: string
  session_open: boolean
  started_at: string | null
  last_active_at: string | null
  total_exchanges: number
  pending_decisions: number
  last_consumed_by_cycle: number | null
}
```

Stored in `map.yaml → chat`. `session_open` is the authoritative flag checked by
the daemon for all chat operations. The remainder is informational.

### Chat message

```typescript
interface ChatMessage {
  ts: string
  role: 'user' | 'facilitator'
  content: string
  sources?: string[]
  decision_detected?: DecisionCandidate
  decision_captured?: boolean
}
```

Persisted to `.sle/chat-history.jsonl` — one JSON object per line per exchange.
The `sources` field lists artifact references the Facilitator cited in its
response.

### Decision candidate

```typescript
interface DecisionCandidate {
  id: string
  summary: string
  rationale: string
  scope: string
  confidence: 'high' | 'medium'
}
```

Produced by the Facilitator when a user message expresses a definitive choice,
constraint, priority call, or commitment to action. Only `high` confidence
candidates are surfaced to the user.

### ChatContext

```typescript
interface ChatContext {
  session_id: string
  exchanges_consumed: number
  summary: string
  key_decisions: Array<{
    summary: string
    rationale: string
    scope: string
  }>
  open_questions: string[]
  preferences: Array<{
    topic: string
    preference: string
    confidence: 'strong' | 'mild' | 'mentioned'
  }>
}
```

A compressed summary of the conversation, injected into the Planner's context
when a cycle starts after a chat session. Not the raw conversation — structured
conclusions only.

### Facilitator mode

```typescript
type FacilitatorMode = 'chat' | 'decision'
```

Determines which prompt template and context assembly the Facilitator uses. The
mode is computed from system state, not stored. Both modes can be active
simultaneously.

### Conversation config

```typescript
interface ConversationConfig {
  max_history_exchanges: number
  context_window_exchanges: number
  session_timeout_minutes: number
  auto_summarize_after: number
}
```

Embedded in `planning.yaml` under the `conversation` key. Defaults:
`max_history_exchanges: 100`, `context_window_exchanges: 20`,
`session_timeout_minutes: 60`, `auto_summarize_after: 50`.

## Behavior

### Mode switching mechanism

The Facilitator's mode is determined on every invocation by combining the chat
session state and the cycle flag state. The mode is not stored — it is computed.

```
resolveFacilitatorMode(chatState, cycleFlags):
  modes: FacilitatorMode[] = []
  if chatState.session_open:
    modes.push('chat')
  if cycleFlags.awaiting_confirmation
      OR cycleFlags.awaiting_sharding_approval:
    modes.push('decision')
  return modes
```

When the result contains both modes, the Facilitator operates in dual mode:

| Modes active | Facilitator behavior |
|---|---|
| `['chat']` only | Freeform Q&A using `facilitator-chat.md` template |
| `['decision']` only | Structured gate actions using `facilitator-decision.md` template |
| `['chat', 'decision']` | Chat context by default; switches to decision context when user input matches a gate action keyword |

Gate action keywords are matched by the daemon (not by the LLM) before
dispatching to the Facilitator:

| Pattern | Action | Mode triggered |
|---|---|---|
| `approve`, `looks good`, `proceed` | Approve pending gate | decision |
| `revise`, `change step`, `modify` | Revise at CONFIRM | decision |
| `reject sharding`, `don't shard` | Reject sharding proposal | decision |
| `halt`, `stop cycle` | Halt cycle | decision |
| Anything else | Freeform question or comment | chat |

When the daemon detects a gate action keyword, it sets `facilitator_mode:
'decision'` on the agent invocation. Otherwise it sets `facilitator_mode: 'chat'`.

### Prompt template selection

Two separate prompt templates exist for the Facilitator (DDR-020), stored at
`.sle/prompts/facilitator-chat.md` and `.sle/prompts/facilitator-decision.md`.
Full template content is defined in [prompt-templates.md](prompt-templates.md).

The context manager selects the template based on the resolved mode:

```
selectTemplate(modes: FacilitatorMode[], input: string):
  if modes includes 'decision' AND input matches gate action keyword:
    return 'facilitator-decision'
  if modes includes 'chat':
    return 'facilitator-chat'
  return 'facilitator-chat'
```

Project-local overrides follow the same convention as all other roles — place a
file at `.sle/prompts/facilitator-chat.md` or
`.sle/prompts/facilitator-decision.md` to override the built-in.

### Context assembly per mode

The context manager produces separate `AssembledContext` instances per
Facilitator mode. Full slice tables are in [context-manager.md](context-manager.md)
§Facilitator dual-mode assembly.

**Chat mode assembly:**

| Component | Source |
|---|---|
| System prompt | `facilitator-chat.md` template |
| Artifact slices | `doc:product-brief` (summary), `doc:system-description`, `doc:vision` (summary), `doc:open-questions`, `doc:project-plan` (summary), `.sle/chat-history.jsonl` (last 20), `agent.md` |
| State summary | Current cycle state if `cycling`; project state otherwise |
| Task | User's message |
| Failure context | Absent — chat mode has no retry concept |

Total budget: ~1,350 tokens.

**Decision mode assembly:**

| Component | Source |
|---|---|
| System prompt | `facilitator-decision.md` template |
| Artifact slices | `doc:plan`, `doc:test-plan`, `doc:test-script:{category}` (summaries), `.sle/chat-history.jsonl` (last 5). Plus `.sle/sharding-proposal.yaml` and `.sle/coherence-report.json` when `awaiting_sharding_approval`. Excluded: `doc:build-plan` — never presented at CONFIRM. |
| State summary | Cycle state with iteration, revision, and gate context |
| Task | "Present the pending decision to the user" |
| Failure context | Absent |

Total budget: ~1,000 tokens (base), ~1,400 tokens (with sharding artifacts).

**Dual-mode assembly:** When both modes are active, the context manager produces
two assemblies. The Facilitator receives the chat context by default. The daemon
switches to the decision context only for the turn where the user triggers a
gate action. This prevents the decision context from polluting freeform Q&A and
vice versa.

### Session lifecycle

```
sle chat
  │
  ├─ 1. Session opens
  │     POST /api/v2/chat/session/open
  │     Daemon sets chat.session_open := true, generates session_id
  │     Loads project context from discovery docs and artifact store
  │
  ├─ 2. Freeform exchange loop
  │     User sends message via POST /api/v2/chat/message
  │     Daemon assembles chat-mode context
  │     Daemon invokes Facilitator agent
  │     Daemon appends user + facilitator messages to chat-history.jsonl
  │     Decision detection runs on facilitator output (see §Decision capture)
  │     Response streamed via WebSocket event chat.message
  │
  ├─ 3. Decision capture (conditional)
  │     Facilitator output includes decision_detected field
  │     Daemon surfaces capture prompt to user
  │     User confirms / edits / skips
  │     If confirmed → append to docs/decisions.md with source: chat
  │     Emit WebSocket event chat.decision_captured
  │
  ├─ 4. Gate interaction (conditional, only during cycling)
  │     Cycle flag sets awaiting_confirmation or awaiting_sharding_approval
  │     Facilitator mode expands to include decision mode
  │     User engages with gate action → daemon processes approve/revise/reject
  │     Return to chat-mode-only after gate resolves
  │
  ├─ 5. Transition to cycle (user-initiated)
  │     User: "let's do this" / "start a cycle for X"
  │     Daemon constructs ChatContext from chat history
  │     Daemon calls POST /api/v2/cycles with ChatContext attached
  │     Chat session remains open — does not close on cycle start
  │
  └─ 6. Session closes
        User sends /exit or DELETE /api/v2/chat/session
        Daemon sets chat.session_open := false
        History persists in .sle/chat-history.jsonl
```

### Session persistence

Chat history is appended to `.sle/chat-history.jsonl` after every exchange. The
file is append-only — existing lines are never modified or deleted. Each line is
a self-contained JSON object (the `ChatMessage` type above).

On session resume (`sle chat` when `chat.session_open := false` but history
exists), the daemon loads the last `context_window_exchanges` entries from the
file and injects them into the Facilitator's chat-history slice.

**History compaction:** When `total_exchanges` exceeds `auto_summarize_after`,
the daemon compacts older entries:

1. Load all entries with index < `auto_summarize_after`
2. Generate a structured summary (ChatContext format) via a single LLM call
3. Replace the compacted entries with a single summary line:

```json
{"ts":"...","role":"system","content":"[Session summary]","summary":{"key_decisions":[],"open_questions":[],"preferences":[]}}
```

4. Update `total_exchanges` to reflect the reduced count

Compaction does not delete the original file — the summary replaces the entries
in-place within the JSONL file. This keeps the file size bounded.

### Chat session state across system states

Chat is always available (DDR-020). The Facilitator's context adjusts based on
what is available:

| System state | Chat context available | Restrictions |
|---|---|---|
| `idle` | Full project context from discovery docs | None |
| `discovering` | Partial discovery docs (rounds completed so far) | No cycle artifacts |
| `cycling` (no flags) | Project context + read-only cycle state | Cannot modify cycle artifacts |
| `cycling` (`awaiting_confirmation`) | Project context + cycle artifacts + plan/test-plan for review (`doc:build-plan` excluded) | Can approve/revise/halt |
| `cycling` (`awaiting_sharding_approval`) | Project context + sharding proposal + coherence report | Can approve/reject split |
| `halted` | Full project context + halt report | None |
| `complete` | Full project context + cycle summary | None |

### Decision capture

#### Detection

The Facilitator runs lightweight detection on every user message. Detection is
conservative — false negatives are acceptable, false positives are intrusive.

A `DecisionCandidate` is produced when the user message expresses:

- A definitive choice between alternatives ("let's go with X")
- A constraint or boundary ("X is out of scope for this phase")
- A priority call ("performance matters more than readability here")
- A commitment to action ("we should do X in Phase 2")

The `confidence` field gates surfacing: only `high` confidence candidates are
presented to the user. `medium` confidence candidates are logged internally but
not surfaced.

#### Capture flow

When a `DecisionCandidate` is produced with `confidence: 'high'`:

1. The Facilitator's response includes a capture suggestion:

```
Facilitator: "You've decided to [summary]. Capture this decision?

  Summary: [auto-generated summary]
  Rationale: [inferred from conversation context]
  Scope: [which phase or component this affects]

  [y] Capture  [n] Skip  [e] Edit before capturing"
```

2. User responds with `y`, `n`, or `e`.

3. On `y`: append entry to `docs/decisions.md` with metadata. Emit
   `chat.decision_captured` WebSocket event.

4. On `n`: continue conversation. Decision is not persisted.

5. On `e`: user edits summary/rationale, then confirm. Daemon appends the
   edited version.

#### Scope protection

The Facilitator only suggests captures for decisions that fall within the
project's defined scope. If the user casually mentions an unrelated technology
preference, no capture is suggested. Scope is determined from
`doc:product-brief`, `doc:constraints`, and `doc:project-plan`.

#### decisions.md format for chat captures

```markdown
### DEC-{id} — {title}
**Date:** {ISO 8601}
**Source:** chat session
**Session:** {session_id}
**Status:** proposed

Decision: {summary}
Rationale: {rationale}
Scope: {scope}
```

Chat-sourced decisions use the same format as cycle-sourced decisions, with
`source: chat session` to distinguish provenance. They are interleaved
chronologically with Historian entries in the same file.

### Transition to development cycle

#### How it happens

The user explicitly initiates a transition, either by:

1. CLI: `sle start "intent"` — standard cycle start
2. Natural language in chat: "let's do this" / "start a cycle for X"

In option 2, the Facilitator does not call the API directly. The daemon detects
the intent to start a cycle from the user message and constructs the cycle start
request on the user's behalf. This prevents the Facilitator from having
cycle-starting capability.

#### ChatContext construction

When a cycle starts and a chat session is open, the daemon constructs a
ChatContext summary:

```
buildChatContext(history: ChatMessage[], config: ConversationConfig):
  1. Collect exchanges since last cycle start (or session start)
  2. Extract key_decisions from decision_captured entries
  3. Extract open_questions from remaining discussion
  4. Extract preferences from user statements with confidence levels
  5. Generate 2-3 sentence summary of the discussion
  6. Return ChatContext
```

If the chat history is empty or the LLM call for summarization fails, the
ChatContext is omitted. The cycle starts without it. Chat context is an
enhancement, not a requirement.

#### Injection into Planner context

The Planner receives ChatContext as additional context within its artifact
slices (Component 2). It is not a sixth component — it is injected as a special
slice key `chat-context` in the Planner's assembled context.

The slice is loaded after the standard Planner slices and is bounded to ~200
tokens. If the Planner's slice budget is already exceeded, the ChatContext slice
is skipped.

#### Opting out

```bash
sle start "intent" --no-chat-context
```

This flag tells the daemon to skip ChatContext construction even if a chat
session is open.

### Interaction with running cycles

When a cycle is running and the chat session is open:

**The Facilitator can see (read-only):**

- Current cycle number, iteration, node
- Validation category statuses
- Gate outcomes
- Failure reports
- Plan and architecture content (via artifact slices)

**The Facilitator cannot see:**

- In-progress agent outputs (Planner/Builder/Evaluator working state)
- LLM call contents mid-stream
- Internal daemon state not reflected in map.yaml

**The Facilitator cannot modify:**

- Running cycle artifacts
- DAG state
- Rule files or map.yaml

If the user wants to course-correct during a cycle:

```
User: "stop the cycle, I want to change the scope"

Facilitator: "I can't modify a running cycle. Your options:
  1. Wait for this iteration to complete, then halt: sle halt
  2. Let it run and start a new cycle with adjusted scope after
  3. If the gate fails, the next iteration can incorporate your feedback"
```

The Facilitator does not have halt/approve capability — it can only inform the
user of their options. Actual cycle control goes through the REST API.

## API contract

daemon-api.md is the single source of truth for all REST endpoints. The chat-
related endpoints defined there are:

| Endpoint | Method | Purpose | daemon-api.md reference |
|---|---|---|---|
| `/api/v2/chat/session/open` | `POST` | Open or resume chat session | daemon-api.md §Open chat session |
| `/api/v2/chat/session` | `DELETE` | Close chat session | daemon-api.md §Close chat session |
| `/api/v2/chat/message` | `POST` | Send user message to Facilitator | daemon-api.md §Send chat message |
| `/api/v2/context/assemble` | `POST` | Assemble context (includes `facilitator_mode` param) | daemon-api.md §Assemble context |
| `/api/v2/cycles` | `POST` | Start cycle (carries ChatContext when chat is open) | daemon-api.md §Start cycle |

### WebSocket events

Chat events are emitted over the shared WebSocket connection at
`ws://localhost:7700/events`. Full event definitions are in
[../reference/websocket-events.md](../reference/websocket-events.md).

| Event | Trigger | Payload shape |
|---|---|---|
| `chat.message` | User message or Facilitator response | `{ session_id, payload: { role, content, decision_detected? } }` |
| `chat.decision_captured` | Decision confirmed and written to decisions.md | `{ session_id, payload: { decision_id, path, summary } }` |
| `chat.session_changed` | Session opened or closed | `{ session_open, timestamp }` |

### ChatContext in cycle start

When `POST /api/v2/cycles` is called and a chat session is open, the daemon
includes ChatContext in the internal cycle initialization. This is not a REST
field — the daemon constructs it automatically. The `--no-chat-context` flag
maps to a query parameter `?no_chat_context=true` on the cycle start endpoint.

## Error cases

| Error | Condition | Recovery |
|---|---|---|
| `chat_not_open` | `POST /api/v2/chat/message` when `chat.session_open = false` | 409. Client should open session first. |
| `chat_already_open` | `POST /api/v2/chat/session/open` when `chat.session_open = true` | 204 (idempotent, no-op). Returns existing session_id. |
| `chat_history_corrupt` | `.sle/chat-history.jsonl` contains unparseable lines | Skip corrupt lines. Log warning with line number. Session continues. |
| `chat_context_failed` | LLM call for ChatContext summarization times out or fails | Omit ChatContext. Start cycle without it. Log warning. History preserved. |
| `decision_capture_conflict` | `docs/decisions.md` modified externally during capture (e.g., Historian in a running cycle) | Atomic write (temp file + rename). If file changed substantially, append regardless — decisions.md is append-only. Log warning. |
| `session_timeout` | No user message within `session_timeout_minutes` | Session auto-closes. History flushed to chat-history.jsonl. No data loss. User can resume with `sle chat`. |
| `decision_scope_mismatch` | Detected decision falls outside project scope | Suppress capture suggestion. Log internally at debug level. |
| `facilitator_llm_error` | Facilitator agent invocation fails (LLM timeout, rate limit) | Return error to client. Do not retry automatically. Log error with request context. |
| `history_compaction_failed` | LLM call for history summarization fails during compaction | Abort compaction. Leave history unmodified. Retry on next compaction trigger. |

## Constraints

1. **Orthogonal to state machine.** Chat session state (`session_open`,
   `session_id`) is independent of `map.yaml → meta.status`. Chat never blocks,
   delays, or cancels a state transition (DDR-020).

2. **No cycle modification.** The Facilitator cannot write to cycle artifacts,
   modify DAG state, or change rule files. Chat during a cycle is read-only
   except for decision capture (which writes to `docs/decisions.md`).

3. **No raw history to agents.** No agent other than the Facilitator receives
   chat history. The Planner receives ChatContext as a compressed summary, not
   the raw JSONL file.

4. **Conservative decision detection.** Only `high` confidence candidates are
   surfaced. Every false positive is an interruption. Detection runs on user
   messages only, not on Facilitator responses.

5. **Decision capture is opt-in.** The system suggests, the user confirms.
   Decisions are persisted only on explicit user confirmation.

6. **Dual-mode isolation.** Chat-mode and decision-mode context assemblies are
   separate `AssembledContext` instances. They are never merged. The daemon
   switches between them based on user input classification.

7. **Gate action classification is deterministic.** The daemon classifies user
   input as a gate action or a freeform message using keyword matching, not an
   LLM call. This ensures deterministic routing and avoids the cost of a
   classification LLM call on every message.

8. **ChatContext is optional.** If the chat history is empty, summarization
   fails, or `--no-chat-context` is set, the cycle starts without ChatContext.
   The system does not gate cycle start on chat context availability.

9. **History is append-only.** The `.sle/chat-history.jsonl` file is never
   truncated or have entries removed. Compaction replaces older entries with a
   summary line but does not delete.

10. **Session timeout preserves data.** On timeout, the session closes but the
    history file is fully flushed. No data loss on timeout or crash.

11. **Single chat session.** Only one chat session may be open at a time. The
    daemon rejects a second `POST /chat/session/open` with 204 (idempotent),
    returning the existing session_id.

12. **Facilitator template separation.** The `facilitator-chat.md` and
    `facilitator-decision.md` templates are distinct files with distinct role
    identities, behavioral constraints, and artifact access rules. They are
    never combined into a single template.

13. **Scope-aware capture.** Decision capture suggestions are filtered by
    project scope derived from `doc:product-brief`, `doc:constraints`, and
    `doc:project-plan`. Out-of-scope decisions are suppressed.

## Open questions

| ID | Question | Impact | Status |
|---|---|---|---|
| CONV-001 | Should the gate action keyword list be configurable per project, or remain hardcoded in the daemon? | Extensibility, localization | Open |
| CONV-002 | Should ChatContext injection be limited to the Planner, or also available to the Designer on cycle revision? | Context breadth, iteration quality | Open |
| CONV-003 | What is the optimal `context_window_exchanges` default? 20 may be too many for short sessions and too few for long ones. | Facilitator context quality, token budget | Open |
| CONV-004 | Should the Facilitator response be streamed (SSE or WebSocket chunks) or returned as a single payload? | Latency, user experience, daemon-api.md API-006 | Open |
| CONV-005 | Should chat history compaction run synchronously (blocking the next message) or asynchronously in the background? | Response latency, file consistency | Open |
| CONV-006 | Can the decision detection be improved beyond keyword heuristics without adding per-message LLM cost? | Capture accuracy, cost | Open |
| CONV-007 | Should the `--no-chat-context` flag persist across cycles within a session, or apply per-cycle only? | User intent, session state management | Open |
| CONV-008 | Is there a maximum chat session duration beyond `session_timeout_minutes` that should trigger forced close? | Resource management, daemon memory | Open |
