# Conversation Mode

**Type:** spec · **Status:** draft · **Updated:** 2026-06-21
**Depends on:** DDR-020, DDR-031, [types.md](../reference/types.md) §2, [state-machine.md](state-machine.md), [workflow-execution.md](workflow-execution.md), [prompt-templates.md](prompt-templates.md), [context-manager.md](context-manager.md)
**Source material:** SLE-012 (conversation mode), DDR-020 (orthogonal chat layer), DDR-031 (workflow generalization)

## Overview

Conversation mode provides a persistent, freeform interaction layer between the
user and the Facilitator agent. The user can explore ideas, ask questions about
the project, discuss trade-offs, and make decisions — without starting a
workflow run. When the user is ready to act, conversation context transitions
into a workflow run via a compressed ChatContext summary, after the chat-to-
workflow router identifies which workflow (and target) the user means.

Chat is orthogonal to system state (DDR-020). It is tracked by a boolean flag on
the chat session record, not by a machine state. Chat can be open in either of
the two project-wide system states (`idle`, `discovering`) and regardless of
how many workflow runs are active, without blocking, interrupting, or affecting
state transitions. This resolves gap G13: SLE-012's "conversation mode is
always available" no longer contradicts the state machine.

The Facilitator operates in four modes — chat mode (freeform Q&A), decision
mode (structured gate actions, scoped to whichever run's checkpoint is being
addressed), scoping mode (guided run scoping), and workflow-select mode
(matching free text to a workflow + target) — that can coexist when a chat
session is open, one or more runs have a checkpoint awaiting input, and/or the
user's message looks like a request to start new work. This spec defines the
mode switching mechanism, prompt template selection, context assembly per
mode, session persistence, decision capture, scoping discussion, workflow
selection, and ChatContext injection.

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
  last_consumed_by_run_id: string | null
}
```

Stored in `map.yaml → chat`. `session_open` is the authoritative flag checked by
the daemon for all chat operations. The remainder is informational.
`last_consumed_by_run_id` replaces the former `last_consumed_by_cycle` —
there is no longer a single global cycle counter to reference (DDR-031).

### Chat message

```typescript
interface ChatMessage {
  ts: string
  role: 'user' | 'facilitator'
  content: string
  sources?: string[]
  decision_detected?: DecisionCandidate
  decision_captured?: boolean
  workflow_match?: WorkflowMatchCandidate
}
```

Persisted to `.sle/chat-history.jsonl` — one JSON object per line per exchange.
The `sources` field lists artifact references the Facilitator cited in its
response. The new `workflow_match` field records a workflow-select candidate
when one was surfaced for this exchange (see §Workflow selection).

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

### Workflow match candidate

```typescript
interface WorkflowMatchCandidate {
  workflow_id:  string
  target:       { group?: string; layer?: string; node_key?: string } | null
  confidence:   number     // 0–1
  rationale:    string
}
```

Produced by the Facilitator when operating in `workflow_select` mode, matching
free chat text against the `trigger.description` of every committed
`WorkflowDefinition` (built-in and user-authored). See §Workflow selection.

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

A compressed summary of the conversation, injected into a workflow run's
SCOPING-equivalent gather/produce steps when a run starts after a chat
session. Not the raw conversation — structured conclusions only.

### Facilitator mode

```typescript
type FacilitatorMode = 'chat' | 'decision' | 'scoping' | 'workflow_select'
```

Determines which prompt template and context assembly the Facilitator uses.
The mode is computed from system state and the set of active runs' checkpoint
pointers, not stored. Multiple modes can be active simultaneously.
`workflow_select` is new (DDR-031) — it activates when the daemon's keyword
matcher does not classify the user's message as a known gate action and a
workflow-dispatch intent is plausible.

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
session state and the checkpoint pointers of every active `WorkflowRun`. The
mode is not stored — it is computed. Because checkpoints are now per-run
(`WorkflowRun.awaiting_checkpoint`) rather than three project-wide flags, the
resolver iterates active runs instead of reading singular cycle flags.

```
resolveFacilitatorMode(chatState, activeRuns: WorkflowRun[], input: string):
  modes: FacilitatorMode[] = []
  if chatState.session_open:
    modes.push('chat')
  for run in activeRuns:
    if run.awaiting_checkpoint is set:
      step = lookupStep(run.workflow_id, run.awaiting_checkpoint)
      if step.id resembles a scoping checkpoint:
        modes.push('scoping')   // scoped to that run
      else:
        modes.push('decision')  // scoped to that run
  if NOT input matches a gate action keyword
     AND NOT modes includes 'scoping'
     AND input plausibly requests new work:
    modes.push('workflow_select')
  return modes
```

When the user's message addresses a specific run's checkpoint (gate action
keyword match), decision/scoping mode for that run takes priority and
`workflow_select` is not considered for that turn — gate-action classification
stays the deterministic, safety-critical mechanism it always was, unchanged by
this generalization.

| Modes active | Facilitator behavior |
|---|---|
| `['chat']` only | Freeform Q&A using `facilitator-chat.md` template |
| `['decision']` (for run R) | Structured gate actions for run R using `facilitator-decision.md` template |
| `['scoping']` (for run R) | Guided scoping discussion for run R using `facilitator-scoping.md` template |
| `['workflow_select']` | Match free text to a workflow + target using `facilitator-workflow-select.md` template |
| `['chat', 'decision']` | Chat context by default; switches to decision context (scoped to the relevant run) when user input matches a gate action keyword |
| `['scoping', 'decision']` | Scoping context primary; switches to decision context for gate actions |
| `['chat', 'scoping']` | Scoping context primary (chat subsumed while that run's SCOPING checkpoint is active) |
| `['chat', 'workflow_select']` | Chat context by default; switches to workflow-select context when the message plausibly requests new work |

Gate action keywords are matched by the daemon (not by the LLM) before
dispatching to the Facilitator:

| Pattern | Action | Mode triggered |
|---|---|---|
| `approve`, `looks good`, `proceed` | Approve pending checkpoint | decision |
| `revise`, `change step`, `modify` | Revise at CONFIRM-equivalent checkpoint | decision |
| `reject sharding`, `don't shard` | Reject sharding proposal | decision |
| `halt`, `stop the run` | Halt that workflow run | decision |
| `confirm`, `yes run it`, `go ahead` (in response to a router prompt) | Dispatch the proposed workflow run | workflow_select → dispatch |
| Anything else | Freeform question, comment, or new-work request | chat or workflow_select |

When more than one run has an active checkpoint, the daemon disambiguates by
recency (the most recently surfaced checkpoint) unless the user's message
names a specific run or target explicitly. This is the only new
disambiguation rule introduced by concurrency — everything else about gate
action keyword matching is unchanged from before DDR-031.

When the daemon detects a gate action keyword, it sets `facilitator_mode:
'decision'` (or `'scoping'`) on the agent invocation, scoped to the relevant
run_id. Otherwise, if the message plausibly requests new work, it sets
`facilitator_mode: 'workflow_select'`. Otherwise it sets `facilitator_mode: 'chat'`.

### Prompt template selection

Four separate prompt templates exist for the Facilitator (DDR-020, DDR-028,
DDR-031), stored at `.sle/prompts/facilitator-chat.md`,
`.sle/prompts/facilitator-decision.md`,
`.sle/prompts/facilitator-scoping.md`, and
`.sle/prompts/facilitator-workflow-select.md`.
Full template content is defined in [prompt-templates.md](prompt-templates.md).

The context manager selects the template based on the resolved mode:

```
selectTemplate(modes: FacilitatorMode[], input: string):
  if modes includes 'scoping' AND NOT input matches gate action keyword:
    return 'facilitator-scoping'
  if modes includes 'decision' AND input matches gate action keyword:
    return 'facilitator-decision'
  if modes includes 'workflow_select' AND NOT input matches gate action keyword:
    return 'facilitator-workflow-select'
  if modes includes 'chat':
    return 'facilitator-chat'
  return 'facilitator-chat'
```

Scoping takes priority over chat and workflow-select when active for the
relevant run. Decision mode takes priority over all modes when the user
triggers a gate action. Workflow-select is the lowest-priority mode — it only
activates when nothing the user said addresses an existing run's checkpoint.

Project-local overrides follow the same convention as all other roles — place
a file at `.sle/prompts/facilitator-chat.md`,
`.sle/prompts/facilitator-decision.md`,
`.sle/prompts/facilitator-scoping.md`, or
`.sle/prompts/facilitator-workflow-select.md` to override the built-in.

### Context assembly per mode

The context manager produces separate `AssembledContext` instances per
Facilitator mode. Full slice tables are in [context-manager.md](context-manager.md)
§Facilitator dual-mode assembly.

**Chat mode assembly:**

| Component | Source |
|---|---|
| System prompt | `facilitator-chat.md` template |
| Artifact slices | `doc:product-brief` (summary), `doc:system-description`, `doc:vision` (summary), `doc:open-questions`, `doc:project-plan` (summary), `.sle/chat-history.jsonl` (last 20), `agent.md` |
| State summary | Active workflow run summaries (run_id, workflow_id, current_step_id) if any are active; project state otherwise |
| Task | User's message |
| Failure context | Absent — chat mode has no retry concept |

Total budget: ~1,350 tokens.

**Decision mode assembly:**

| Component | Source |
|---|---|
| System prompt | `facilitator-decision.md` template |
| Artifact slices | `doc:plan`, `doc:test-plan`, `doc:test-script:{category}` (summaries), `.sle/chat-history.jsonl` (last 5). Plus `.sle/sharding-proposal.yaml` and `.sle/coherence-report.json` when the relevant run's checkpoint is the sharding one. Excluded: `doc:build-plan` — never presented at CONFIRM. |
| State summary | The one relevant `WorkflowRun`'s iteration, revision, and checkpoint context |
| Task | "Present the pending decision to the user" |
| Failure context | Absent |

Total budget: ~1,000 tokens (base), ~1,400 tokens (with sharding artifacts).

**Scoping mode assembly:**

| Component | Source |
|---|---|
| System prompt | `facilitator-scoping.md` template |
| Artifact slices | Tagged nodes/layers (all `#next-run` elements), `doc:cycle-scope-draft` (if exists), `doc:architecture`, `doc:requirements`, `doc:decisions`, `.sle/chat-history.jsonl` (last 20), `agent.md` |
| State summary | The relevant `WorkflowRun`'s state; `map.yaml` summary |
| Task | "Guide the user through scoping discussion" |
| Failure context | Absent |

Total budget: ~1,500 tokens.

**Workflow-select mode assembly:**

| Component | Source |
|---|---|
| System prompt | `facilitator-workflow-select.md` template |
| Artifact slices | Every committed `WorkflowDefinition`'s `trigger.description` + `trigger.examples` (built-in and user-authored), `.sle/chat-history.jsonl` (last 5) |
| State summary | `active_workflow_run_count`, list of any artifacts currently under claim (to flag likely `claim_conflict` before dispatch) |
| Task | "Identify which workflow (if any) and target the user's message requests" |
| Failure context | Absent |

Total budget: ~900 tokens. Grows with the number of committed workflow
definitions; if it exceeds budget, lower-confidence definitions (by trigger
specificity heuristic) are truncated first, never `full-build` or
`draft-artifact`.

**Dual-mode assembly:** When multiple modes are active, the context manager
produces one assembly per mode. The Facilitator receives the chat context by
default. The daemon switches to the decision or scoping context (scoped to one
run) only for the turn where the user addresses that run's checkpoint, or to
the workflow-select context only for a turn that plausibly requests new work.
This prevents one mode's context from polluting another's, and prevents one
run's decision context from leaking into another concurrently active run's
turn.

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
  │     Daemon classifies: gate action (which run?) / new-work request / freeform
  │     Daemon assembles the corresponding mode's context
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
  ├─ 4. Gate interaction (conditional, per active run)
  │     A run's awaiting_checkpoint becomes set
  │     Facilitator mode expands to include decision (or scoping) mode for that run
  │     User engages with gate action → daemon processes approve/revise/reject for that run
  │     Return to chat-mode-only (for that run) after its checkpoint resolves
  │
  ├─ 5. Workflow selection (conditional, see §Workflow selection)
  │     User message plausibly requests new work
  │     Facilitator mode expands to include workflow_select
  │     Daemon surfaces "I think you want to run {workflow} against {target} — confirm?"
  │     User confirms (deterministic keyword) → daemon dispatches POST /api/v2/workflow-runs
  │     User declines or clarifies → daemon falls back to chat mode
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
| `idle`, no active runs | Full project context from discovery docs | None |
| `discovering` | Partial discovery docs (rounds completed so far) | No workflow-run artifacts |
| Any state, ≥1 active run, no checkpoint | Project context + read-only state for each active run | Cannot modify run artifacts |
| Any state, run R awaiting a scoping-shaped checkpoint | Tagged nodes/layers + scope draft + project artifacts + map.yaml summary, scoped to R | Can produce scope draft and charter for R (DDR-028) |
| Any state, run R awaiting a CONFIRM-shaped checkpoint | Project context + R's artifacts + plan/test-plan for review (`doc:build-plan` excluded) | Can approve/revise/halt R |
| Any state, run R awaiting a sharding-shaped checkpoint | Project context + R's sharding proposal + coherence report | Can approve/reject split for R |
| Any state, run R halted or complete | Full project context + R's halt/summary report | None |

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

Chat-sourced decisions use the same format as workflow-run-sourced decisions,
with `source: chat session` to distinguish provenance. They are interleaved
chronologically with `commit` step decision-log entries in the same file.

### Scoping discussion (scoping mode)

When the Facilitator is in scoping mode (during a run's SCOPING-equivalent
`gather` → `produce` → `checkpoint` group — `full-build`'s SCOPING in
particular):

1. **Guided structure.** The Facilitator follows a predefined discussion
   structure covering: scope, purpose, requirements, boundaries, deferred items.
2. **Tag awareness.** The Facilitator can see which nodes/layers are tagged
   `#next-run` and discusses their relevance.
3. **Charter production.** The discussion culminates in a `doc:cycle-charter`
   artifact. The Facilitator proposes the charter; the user approves or modifies
   it.
4. **Version bump inference.** The Facilitator infers the semver bump type from
   the scope and purpose discussion. User can override.
5. **Max rounds.** Configurable via `planning.yaml → scoping.max_rounds`
   (default 5, hard cap 10). On timeout, that run halts.
6. **Quick start bypass.** If the run was started with `quick_start_goal`,
   the Facilitator auto-generates a minimal charter from the goal string without
   guided discussion.

### Workflow selection

This is the chat-to-workflow router (DDR-031) — the mechanism that lets free
chat text dispatch any committed workflow, not just `full-build`.

#### Why it's separate from gate-action matching

Gate-action keyword matching (approve/revise/reject/halt) addresses an
**existing** run's checkpoint and stays purely deterministic — it is
safety-critical and was never LLM-assisted, before or after DDR-031.
Workflow selection addresses **starting new** work and must understand free
text against an open-ended, growing set of `trigger.description`s (including
user-authored ones) — that's inherently a matching problem, not a fixed
keyword list, so it is LLM-assisted. The two are kept structurally separate:
gate-action matching always runs first; only if it finds no match does
workflow-select activate.

#### Matching flow

```
routeChatMessage(input, activeRuns, committedWorkflows):
  if input matches a gate action keyword for some run R in activeRuns:
    return { mode: 'decision' (or 'scoping'), run_id: R.run_id }

  candidates = facilitator.matchWorkflows(input, committedWorkflows)
    // returns WorkflowMatchCandidate[], ranked by confidence

  if candidates is empty OR top candidate.confidence < threshold:
    return { mode: 'chat' }  // fall back, ask a clarifying question if useful

  if exactly one candidate clears the threshold with no near-tie:
    surface: "I think you want to run **{workflow}** against **{target}** — confirm?"
    return { mode: 'workflow_select', pending: candidates[0] }

  if top two candidates are a near-tie:
    surface both: "Did you mean **{workflow_a}** or **{workflow_b}**?"
    return { mode: 'workflow_select', pending: [candidates[0], candidates[1]] }
```

`threshold` and the near-tie margin are configuration, not hardcoded
constants — see Open questions (WG-007, carried from DDR-031). Ship with a
reasonable default; tune from real usage.

#### Dispatch is never silent

The router's output is always a proposal, never an immediate dispatch. Only a
subsequent, deterministic confirm keyword from the user
(`confirm`, `yes run it`, `go ahead`, etc. — same keyword-matching mechanism
as gate actions, not an LLM call) triggers
`POST /api/v2/workflow-runs`. This is the one hard rule DDR-031 sets for the
router: an LLM mis-match can at most produce a wrong *suggestion*, never a
wrong *dispatch* (DDR-031, "Risks").

```
User: "I think the rate-limiting design needs another pass"

Facilitator (workflow_select): "I think you want to run **full-build**
against **rate-limiting** — confirm?"

User: "yes"
  → daemon dispatches POST /api/v2/workflow-runs
    { workflow_id: 'full-build', target: { group: 'rate-limiting' } }
```

```
User: "draft a quick contract review for auth"

Facilitator (workflow_select): "I think you want to run
**auth-contract-review** (user-authored) against **auth** — confirm?"

User: "no, I meant the rate-limiting one"
  → daemon falls back to chat mode, asks for the correct target
```

#### Claim-conflict pre-check

Before surfacing a proposal, the router checks whether the candidate
workflow's expected output artifacts are already claimed by another active
run. If so, the proposal includes that warning rather than letting the user
confirm into a guaranteed `claim_conflict`:

```
Facilitator: "I think you want to run **full-build** against
**rate-limiting** — but that group's architecture doc is currently claimed
by run full-build-3-i1-... Want me to queue this, or pick a different target?"
```

### Transition to workflow run

#### How it happens

The transition from conversation to a workflow run now involves a scoping
phase only for workflows that declare one (`full-build` does; a short
`draft-artifact` run may skip straight to its own checkpoint, if any) (DDR-028,
DDR-031):

1. **Pre-run chat.** User and Facilitator discuss goals in chat mode.
2. **Scope draft creation.** Together they create a `doc:cycle-scope-draft` and
   tag relevant nodes/layers with `#next-run`.
3. **Workflow run start.** User triggers the run via:
   - CLI: `sle run full-build --scope <draft-id>` — start with a prepared
     scope draft
   - CLI: `sle run [workflow-id] "quick goal"` — start with a quick goal
     (`full-build` is the default `workflow_id` when omitted, preserving
     today's UX); auto-generates minimal charter for workflows that have a
     SCOPING-shaped step group, bypasses guided scoping
   - Natural language in chat: "let's do this" / "run a full build for X",
     routed through §Workflow selection above
4. **SCOPING-equivalent step group.** For `full-build`, the daemon starts the
   run and the `gather` → `produce` → `checkpoint` SCOPING group runs first
   (before DESIGN).
5. **Scoping mode.** The Facilitator switches to scoping mode for that run.
   Guided discussion produces a `doc:cycle-charter`.
6. **Charter feeds DESIGN.** The charter flows into the Designer's context as
   an additional artifact slice.

In option 3 (natural language), the Facilitator does not call the API
directly. The daemon detects the dispatch intent from the user message (via
§Workflow selection's matching + mandatory confirm) and constructs the
workflow-run start request on the user's behalf. This prevents the
Facilitator from having run-starting capability — the same separation of
concerns as before DDR-031, now generalized past `full-build` alone.

#### ChatContext construction

When a workflow run starts and a chat session is open, the daemon constructs a
ChatContext summary:

```
buildChatContext(history: ChatMessage[], config: ConversationConfig):
  1. Collect exchanges since last run start (or session start)
  2. Extract key_decisions from decision_captured entries
  3. Extract open_questions from remaining discussion
  4. Extract preferences from user statements with confidence levels
  5. Generate 2-3 sentence summary of the discussion
  6. Return ChatContext
```

If the chat history is empty or the LLM call for summarization fails, the
ChatContext is omitted. The run starts without it. Chat context is an
enhancement, not a requirement.

#### Injection into the SCOPING-equivalent step group's context

ChatContext is injected into the SCOPING-equivalent `gather`/`produce` steps'
context rather than directly into the Planner, for workflows that declare such
a group. Those steps receive ChatContext as additional context within their
artifact slices (Component 2). It is injected as a special slice key
`chat-context` in the assembled context.

The charter produced by that group (`doc:cycle-charter`, for `full-build`) is
then passed to the Designer as an artifact slice, which in turn flows to the
Planner.

If the run was started with `--scope <draft-id>`, the scope draft is also
loaded into that group's context. If started with a quick goal, the goal
string is provided directly.

The slice is loaded after the standard slices and is bounded to ~200 tokens. If
the slice budget is already exceeded, the ChatContext slice is skipped.

#### Target reference in workflow-run start API

The workflow-run start API accepts an optional `scope_draft_id` parameter and
a `target` parameter (new — identifies which group/layer/node the run applies
to, since runs are no longer always project-wide):

```
POST /api/v2/workflow-runs
{
  "workflow_id":     "string",                       // defaults to "full-build"
  "target":          "{ group?, layer?, node_key? } | null",
  "scope_draft_id":  "string | null",
  "quick_start_goal": "string | null",
  "version_bump":    "'major' | 'minor' | 'patch' | null",
  "depth_override":  "PlanningDepth | null",
  "category_hints":  "string[] | null"
}
```

Only one of `scope_draft_id` or `quick_start_goal` may be set. If neither is
set and the workflow declares a SCOPING-shaped checkpoint, the run starts with
an empty scope and that checkpoint runs its full guided discussion.

#### Opting out

```bash
sle run full-build "intent" --no-chat-context
```

This flag tells the daemon to skip ChatContext construction even if a chat
session is open.

### Interaction with running workflow runs

When a workflow run is active and the chat session is open:

**The Facilitator can see (read-only), per active run:**

- Run id, workflow id, iteration, current step
- Validation category statuses
- Checkpoint/review outcomes
- Failure reports
- Plan and architecture content (via artifact slices)

**The Facilitator cannot see:**

- In-progress agent outputs (Planner/Builder/Evaluator working state)
- LLM call contents mid-stream
- Internal daemon state not reflected in map.yaml

**The Facilitator cannot modify:**

- Running workflow-run artifacts
- Any run's step-graph position
- Rule files or map.yaml

If the user wants to course-correct during a run:

```
User: "stop the build, I want to change the scope"

Facilitator: "I can't modify a running workflow run. Your options:
  1. Wait for this iteration to complete, then halt: sle halt <run_id>
  2. Let it run and start a new run with adjusted scope after
  3. If the gate fails, the next iteration can incorporate your feedback"
```

The Facilitator does not have halt/approve capability — it can only inform the
user of their options. Actual run control goes through the REST API.

## API contract

daemon-api.md is the single source of truth for all REST endpoints. The chat-
related endpoints defined there are:

| Endpoint | Method | Purpose | daemon-api.md reference |
|---|---|---|---|
| `/api/v2/chat/session/open` | `POST` | Open or resume chat session | daemon-api-endpoints.md §Open chat session |
| `/api/v2/chat/session` | `DELETE` | Close chat session | daemon-api-endpoints.md §Close chat session |
| `/api/v2/chat/message` | `POST` | Send user message to Facilitator | daemon-api-endpoints.md §Send chat message |
| `/api/v2/context/assemble` | `POST` | Assemble context (includes `facilitator_mode` param) | daemon-api-endpoints.md §Assemble context |
| `/api/v2/workflows` | `GET` | List committed workflow definitions (for the router) | daemon-api-endpoints.md §List workflows |
| `/api/v2/workflow-runs` | `POST` | Start workflow run (carries ChatContext when chat is open) | daemon-api-endpoints.md §Start workflow run |

### WebSocket events

Chat events are emitted over the shared WebSocket connection at
`ws://localhost:7700/events`. Full event definitions are in
[../reference/websocket-events.md](../reference/websocket-events.md).

| Event | Trigger | Payload shape |
|---|---|---|
| `chat.message` | User message or Facilitator response | `{ session_id, payload: { role, content, decision_detected?, workflow_match? } }` |
| `chat.decision_captured` | Decision confirmed and written to decisions.md | `{ session_id, payload: { decision_id, path, summary } }` |
| `chat.workflow_proposed` | Router surfaced a workflow-select proposal (single or near-tie) | `{ session_id, payload: { candidates: WorkflowMatchCandidate[] } }` |
| `chat.session_changed` | Session opened or closed | `{ session_open, timestamp }` |

### ChatContext in workflow-run start

When `POST /api/v2/workflow-runs` is called and a chat session is open, the
daemon includes ChatContext in the internal run initialization. This is not a
REST field — the daemon constructs it automatically. The `--no-chat-context`
flag maps to a query parameter `?no_chat_context=true` on the workflow-run
start endpoint.

## Error cases

| Error | Condition | Recovery |
|---|---|---|
| `chat_not_open` | `POST /api/v2/chat/message` when `chat.session_open = false` | 409. Client should open session first. |
| `chat_already_open` | `POST /api/v2/chat/session/open` when `chat.session_open = true` | 204 (idempotent, no-op). Returns existing session_id. |
| `chat_history_corrupt` | `.sle/chat-history.jsonl` contains unparseable lines | Skip corrupt lines. Log warning with line number. Session continues. |
| `chat_context_failed` | LLM call for ChatContext summarization times out or fails | Omit ChatContext. Start run without it. Log warning. History preserved. |
| `decision_capture_conflict` | `docs/decisions.md` modified externally during capture (e.g., a concurrent run's commit step) | Atomic write (temp file + rename). If file changed substantially, append regardless — decisions.md is append-only. Log warning. |
| `session_timeout` | No user message within `session_timeout_minutes` | Session auto-closes. History flushed to chat-history.jsonl. No data loss. User can resume with `sle chat`. |
| `decision_scope_mismatch` | Detected decision falls outside project scope | Suppress capture suggestion. Log internally at debug level. |
| `facilitator_llm_error` | Facilitator agent invocation fails (LLM timeout, rate limit) | Return error to client. Do not retry automatically. Log error with request context. |
| `history_compaction_failed` | LLM call for history summarization fails during compaction | Abort compaction. Leave history unmodified. Retry on next compaction trigger. |
| `workflow_match_ambiguous` | Router cannot disambiguate beyond a near-tie even after presenting both candidates | Ask user to name the workflow explicitly. Log low-confidence match for router tuning. |
| `claim_conflict` (surfaced via chat) | The router's pre-check finds the proposed target already claimed | Surface the conflict in the proposal rather than confirming into a guaranteed dispatch failure |

## Constraints

1. **Orthogonal to state machine.** Chat session state (`session_open`,
   `session_id`) is independent of `map.yaml → meta.status` and of every
   `WorkflowRun.status`. Chat never blocks, delays, or cancels a transition at
   either level (DDR-020).

2. **No workflow-run modification (with scoping exception).** The Facilitator
   cannot write to a run's artifacts, modify its step-graph position, or
   change rule files. Chat during a run is read-only except for:
   1. Decision capture (writes to `docs/decisions.md`) — all modes
   2. Scoping artifacts (writes `doc:cycle-scope-draft` and `doc:cycle-charter`)
      — scoping mode only (DDR-028 SC-010)
   The Facilitator cannot produce build artifacts, test artifacts, validation
   artifacts, or graph nodes for any run.

3. **No raw history to non-Facilitator agents.** No agent other than the
   Facilitator receives chat history. A SCOPING-equivalent step group receives
   ChatContext as a compressed summary, not the raw JSONL file. The charter it
   produces then flows to the Designer and Planner.

4. **Conservative decision detection.** Only `high` confidence candidates are
   surfaced. Every false positive is an interruption. Detection runs on user
   messages only, not on Facilitator responses.

5. **Decision capture is opt-in.** The system suggests, the user confirms.
   Decisions are persisted only on explicit user confirmation.

6. **Mode isolation.** Chat-mode, decision-mode, scoping-mode, and
   workflow-select-mode context assemblies are separate `AssembledContext`
   instances. They are never merged. The daemon switches between them based on
   user input classification, and decision/scoping assemblies are additionally
   scoped to one specific run.

7. **Gate action classification is deterministic.** The daemon classifies user
   input as a gate action (and which run it addresses) using keyword matching,
   not an LLM call. This ensures deterministic routing and avoids the cost of
   a classification LLM call on every message. **Workflow-select dispatch
   confirmation is also deterministic keyword matching** — only the
   *candidate-ranking* step inside workflow-select is LLM-assisted, never the
   confirm/dispatch decision itself (DDR-031).

8. **ChatContext is optional.** If the chat history is empty, summarization
   fails, or `--no-chat-context` is set, the run starts without ChatContext.
   The system does not gate run start on chat context availability.

9. **History is append-only.** The `.sle/chat-history.jsonl` file is never
   truncated or have entries removed. Compaction replaces older entries with a
   summary line but does not delete.

10. **Session timeout preserves data.** On timeout, the session closes but the
    history file is fully flushed. No data loss on timeout or crash.

11. **Single chat session.** Only one chat session may be open at a time
    (this is unchanged by DDR-031 — chat is global, workflow runs are not).
    The daemon rejects a second `POST /chat/session/open` with 204 (idempotent),
    returning the existing session_id.

12. **Facilitator template separation.** The `facilitator-chat.md`,
    `facilitator-decision.md`, `facilitator-scoping.md`, and
    `facilitator-workflow-select.md` templates are distinct files with
    distinct role identities, behavioral constraints, and artifact access
    rules. They are never combined into a single template (DDR-020, DDR-028,
    DDR-031).

13. **Scope-aware capture.** Decision capture suggestions are filtered by
    project scope derived from `doc:product-brief`, `doc:constraints`, and
    `doc:project-plan`. Out-of-scope decisions are suppressed.

14. **Workflow dispatch is never silent.** The router always surfaces a
    confirmable proposal before calling `POST /api/v2/workflow-runs`. There is
    no code path where workflow-select mode dispatches without an explicit
    user confirm (DDR-031).

## Open questions

| ID | Question | Impact | Status |
|---|---|---|---|
| CONV-001 | Should the gate action keyword list be configurable per project, or remain hardcoded in the daemon? | Extensibility, localization | Open |
| CONV-002 | Should ChatContext injection be limited to the Planner, or also available to the Designer on workflow-run revision? | Context breadth, iteration quality | Resolved by DDR-028 — ChatContext now feeds into the SCOPING-equivalent step group, which produces charter for Designer. Direct Planner injection replaced. |
| CONV-003 | What is the optimal `context_window_exchanges` default? 20 may be too many for short sessions and too few for long ones. | Facilitator context quality, token budget | Open |
| CONV-004 | Should the Facilitator response be streamed (SSE or WebSocket chunks) or returned as a single payload? | Latency, user experience, daemon-api.md API-006 | Open |
| CONV-005 | Should chat history compaction run synchronously (blocking the next message) or asynchronously in the background? | Response latency, file consistency | Open |
| CONV-006 | Can the decision detection be improved beyond keyword heuristics without adding per-message LLM cost? | Capture accuracy, cost | Open |
| CONV-007 | Should the `--no-chat-context` flag persist across workflow runs within a session, or apply per-run only? | User intent, session state management | Open |
| CONV-008 | Is there a maximum chat session duration beyond `session_timeout_minutes` that should trigger forced close? | Resource management, daemon memory | Open |
| CONV-009 | Should scoping mode have its own `context_window_exchanges` budget, separate from chat mode? | Scoping context quality, token budget | Resolved by DDR-028 — scoping mode has its own assembly budget (~1,500 tokens). |
| WG-007 | LLM-router confidence threshold and tie-break UX for workflow selection | Router accuracy, false-dispatch risk | Open — ship with a reasonable default, tune from usage; tie-break is to present both candidates (carried from DDR-031) |
