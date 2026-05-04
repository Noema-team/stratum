# State Machine

**Type:** spec · **Status:** draft · **Updated:** 2026-04-17
**Depends on:** DDR-020, DDR-021, DDR-026
**Source material:** SLE-024 §2

## Overview

The SLE system maintains exactly one machine state at all times. States are
mutually exclusive and exhaustive. The state machine governs the lifecycle of
discovery sessions and development cycles — the two units of work the daemon
tracks.

Chat and confirmation pauses are **not** machine states. Chat is an orthogonal
layer tracked by a boolean flag on the chat record. Confirmation pauses are
boolean flags on the cycle record. Neither consumes a state slot. This keeps
the state machine simple (5 states) while allowing chat and confirmation to
overlap freely with the active state.

The machine starts in `idle` and must return to `idle` before a different
session type can begin.

## Data model

### System state

```
type SystemStatus =
  | "idle"
  | "discovering"
  | "cycling"
  | "halted"
  | "complete"
```

Stored in `map.yaml → meta.status`. Updated atomically on every transition.

### Cycle record flags

Cycle flags are boolean fields on the active cycle record in `map.yaml`. They
represent pause points where the system waits for an external response. They do
**not** change the machine state — the state remains `cycling` while any flag
is set.

| Flag | Field | Set when | Cleared when |
|---|---|---|---|
| `awaiting_scoping` | `cycle.awaiting_scoping` | SCOPING node active and waiting for user input | User confirms scope |
| `awaiting_confirmation` | `cycle.awaiting_confirmation` | CONFIRM gate reached (post-TEST, pre-BUILD) | User approves, modifies, or halts |
| `awaiting_sharding_approval` | `cycle.awaiting_sharding_approval` | Planner proposes sharding split | User approves or rejects the split |

All flags may be `false` simultaneously (normal execution within `cycling`).
At most one flag is `true` at a time — the system does not prompt for
scoping, confirmation, and sharding approval concurrently.

### Chat session layer

```
type ChatSession = {
  session_open: boolean
  started_at:   string | null
}
```

Stored in `map.yaml → chat`. The `session_open` boolean is entirely independent
of `system.state`. Chat can be open in any machine state. Chat never blocks,
interrupts, or otherwise affects state transitions.

When `session_open` is `true`, the Facilitator operates in **chat mode**
(freeform Q&A). When any of `awaiting_scoping`, `awaiting_confirmation`, or
`awaiting_sharding_approval` is `true`, the Facilitator simultaneously operates
in **decision mode** (structured gate actions). These two modes coexist — chat
mode does not replace decision mode.

### State context

```
type StateContext = {
  state:                SystemStatus
  active_session_id:    string | null
  active_cycle_id:      string | null
  discovery_status:     "not_started" | "in_progress" | "complete"
  iteration:            number
  revision:             number
}
```

Populated from `map.yaml` on every daemon tick. Exposed via the status API.

## Behavior

### State diagram

```
                        ┌─────────┐
                        │  idle   │◄──────────────────────────────┐
                        └────┬────┘                               │
                             │                                    │
                 ┌───────────┼───────────┐                        │
                 │           │           │                        │
                 ▼           ▼           ▼                        │
          ┌────────────┐          ┌────────────┐                  │
          │discovering │          │  cycling   │◄─┐               │
          └─────┬──────┘          └──┬─┬─┬─────┘  │ T12 (resume)  │
                │                    │ │ │        │               │
                │           ┌────────┘ │ └──────────┐             │
                │           │          │            │             │
                │           ▼          ▼            ▼             │
                │    ┌──────────┐ ┌────────┐ ┌──────────┐        │
                │    │ halted   │ │complete│ │(remains   │        │
                │    └────┬─────┘ └───┬────┘ │ cycling)  │        │
                │         │  T12        │      │ via flag   │      │
                │         └──► cycling  │      └───────────┘       │
                │              (see ↑)  │                          │
                └─────────┴────────────┴──────────────────────────┘

   Flag-based pauses (state stays "cycling"):
    ┌────────────────────────────┬──────────────────────────────────┐
    │ Flag                       │ Effect                           │
    ├────────────────────────────┼──────────────────────────────────┤
    │ awaiting_scoping           │ DAG pauses at SCOPING node       │
    │ awaiting_confirmation      │ DAG pauses pre-BUILD             │
    │ awaiting_sharding_approval │ DAG pauses pre-shard-split       │
    └────────────────────────────┴──────────────────────────────────┘

   Orthogonal chat layer:
   ┌────────────────────────────┬──────────────────────────────────┐
   │ chat.session_open          │ Facilitator in chat mode         │
   │ + any awaiting_* flag      │ Facilitator also in decision mode│
   └────────────────────────────┴──────────────────────────────────┘
```

### Transition table

| # | From | To | Trigger | Precondition | Side effects |
|---|---|---|---|---|---|
| T1 | `idle` | `discovering` | `sle discover` | `discovery_status ≠ complete` | Create discovery session, set `active_session_id` |
| T2 | `discovering` | `idle` | Discovery session ends (synthesis + planning complete) | Discovery session is in terminal round | Write discovery artifacts, set `discovery_status := complete`, clear `active_session_id` |
| T3 | `idle` | `cycling` | `sle start "goal"` | `discovery_status = complete` | Create cycle record, set `active_cycle_id`, set `iteration := 1`, `revision := 0` |
| T4 | `cycling` | `cycling` | VALIDATION gate fails, iteration cap not reached | `iteration < iteration_cap` | `iteration++`, inject FailureReport into next PLAN context, clear run artifacts |
| T5 | `cycling` | `halted` | User issues `sle halt` | `system.state = cycling` | Write partial report, preserve run artifacts |
| T6 | `cycling` | `halted` | VALIDATION gate fails, iteration cap reached | `iteration ≥ iteration_cap` | Write partial report with cap-exceeded notice |
| T7 | `cycling` | `halted` | Unrecoverable error | Any node | Write error report, preserve artifacts produced so far |
| T8 | `cycling` | `complete` | SNAPSHOT node finishes | All validation categories pass, EVALUATE done | Lock snapshot, write changelog, increment version |
| T9 | `complete` | `idle` | Snapshot acknowledgement (automatic after lock) | Snapshot is locked | Clear `active_cycle_id`, persist versioned artifacts |
| T10 | `halted` | `idle` | User acknowledges halt report | Halt report has been read | Clear `active_cycle_id` |
| T11 | `idle` | `cycling` | `sle start "goal"` with `--force` | None (skips discovery check) | Same as T3 but no discovery guard |
| T12 | `halted` | `cycling` | `sle resume` | Halted state, user confirmation | Resume keeps cycle context. Iteration count preserved. |

### Intra-cycle transitions (flag-based, state stays `cycling`)

These are not state machine transitions. They are flag mutations on the cycle
record that pause or resume DAG execution.

| Flag transition | Trigger | Effect on DAG |
|---|---|---|
| `awaiting_scoping := true` | SCOPING node active, needs user input | DAG pauses at SCOPING node |
| `awaiting_scoping := false` (confirm) | User confirms scope | DAG resumes past SCOPING to DESIGN node |
| `awaiting_confirmation := true` | CONFIRM gate reached (post-TEST) | DAG pauses before BUILD node |
| `awaiting_confirmation := false` (approve) | User approves plan + tests | DAG resumes at BUILD node |
| `awaiting_confirmation := false` (modify) | User modifies plan or tests | `revision++`, DAG resumes at TEST node for re-derivation |
| `awaiting_confirmation := false` (halt) | User rejects at CONFIRM gate | Triggers T5 (→ halted) |
| `awaiting_sharding_approval := true` | Planner proposes sharding | DAG pauses before sharding execution |
| `awaiting_sharding_approval := false` (approve) | User approves sharding | DAG resumes sharding execution |
| `awaiting_sharding_approval := false` (reject) | User rejects sharding | DAG resumes without sharding, Planner re-plans without split |

### Chat session transitions

Chat is orthogonal to the state machine. These transitions can occur in any
system state.

| Chat transition | Trigger | Precondition |
|---|---|---|
| `session_open := true` | `sle chat` | None |
| `session_open := false` | User ends chat session (e.g. `/exit`) | `session_open = true` |

Chat availability matrix:

| System state | Chat available | Chat mode | Decision mode |
|---|---|---|---|
| `idle` | Yes | Freeform Q&A | No |
| `discovering` | Yes | Freeform Q&A | No |
| `cycling` (no flags) | Yes | Freeform Q&A | No |
| `cycling` (`awaiting_scoping`) | Yes | Freeform Q&A | Yes — confirm scope |
| `cycling` (`awaiting_confirmation`) | Yes | Freeform Q&A | Yes — approve/modify/halt |
| `cycling` (`awaiting_sharding_approval`) | Yes | Freeform Q&A | Yes — approve/reject split |
| `halted` | Yes | Freeform Q&A | No |
| `complete` | Yes | Freeform Q&A | No |

## API contract

### Get system state

```
GET /api/v2/system/state

Response 200:
{
  "state":               SystemStatus,
  "active_session_id":   string | null,
  "active_cycle_id":     string | null,
  "discovery_status":    "not_started" | "in_progress" | "complete",
  "iteration":           number,
  "revision":            number,
  "awaiting_scoping":             boolean,
  "awaiting_confirmation":      boolean,
  "awaiting_sharding_approval": boolean,
  "chat": {
    "session_open": boolean
  }
}
```

### Transition state

```
POST /api/v2/system/state/transition

Request:
{
  "target":     SystemStatus,
  "trigger":    string,
  "payload":    object | null
}

Response 200:
{
  "previous":  SystemStatus,
  "current":   SystemStatus,
  "cycle_id":  string | null
}

Response 409:
{
  "error":     "invalid_transition",
  "from":      SystemStatus,
  "to":        SystemStatus,
  "reason":    string
}
```

### Set cycle flag

```
PATCH /api/v2/cycles/{cycle_id}/flags

Request:
{
  "awaiting_scoping":             boolean | null,
  "awaiting_confirmation":      boolean | null,
  "awaiting_sharding_approval": boolean | null
}

Response 200:
{
  "cycle_id": string,
  "flags": {
    "awaiting_scoping":             boolean,
    "awaiting_confirmation":      boolean,
    "awaiting_sharding_approval": boolean
  }
}
```

### Open / close chat session

```
POST   /api/v2/chat/session/open
DELETE /api/v2/chat/session

Response 200:
{
  "session_open": boolean
}
```

### WebSocket events

```
event: system.state_changed
{
  "previous":      SystemStatus,
  "current":       SystemStatus,
  "trigger":       string,
  "timestamp":     string
}

event: cycle.flag_changed
{
  "cycle_id": string,
  "flag":     "awaiting_scoping" | "awaiting_confirmation" | "awaiting_sharding_approval",
  "value":    boolean,
  "timestamp": string
}

event: cycle.scoping_input_requested
{
  "cycle_id": string,
  "scope_draft_id": string,
  "timestamp":       string
}

event: chat.session_changed
{
  "session_open": boolean,
  "timestamp":    string
}
```

## Error cases

| Error | Condition | Response |
|---|---|---|
| `invalid_transition` | Transition not in the transition table for current state | 409 with allowed targets |
| `discovery_required` | `sle start` when `discovery_status ≠ complete` and `--force` not set | 403 with message suggesting `sle discover` |
| `session_conflict` | `sle discover` or `sle start` when state is not `idle` | 409 with current state |
| `flag_conflict` | Attempting to set more than one of `awaiting_scoping`, `awaiting_confirmation`, and `awaiting_sharding_approval` to `true` simultaneously | 409 |
| `stale_flag` | PATCH to a flag that is already the requested value | 204 (idempotent, no-op) |
| `cycle_not_found` | PATCH flags for a cycle_id that does not exist | 404 |
| `chat_already_open` | POST open when `session_open = true` | 204 (idempotent, no-op) |
| `chat_not_open` | DELETE session when `session_open = false` | 204 (idempotent, no-op) |
| `halt_not_cycling` | `sle halt` when state is not `cycling` | 409 with current state |
| `iteration_cap_invalid` | `iteration_cap ≤ 0` in configuration | 500 (configuration error) |

## Constraints

1. **Single state invariant.** The system is in exactly one of the five states
   at all times. There is no "between states" condition. Every transition is
   atomic — `map.yaml` is updated in a single write.

2. **Idle gateway.** Only `idle` can transition to `discovering`. Only `idle`
   or `halted` can transition to `cycling`. A session or cycle must fully
   resolve (reach `complete`, `halted`, or `idle`) before a new one can start.

3. **Discovery guard.** Transition T3 (`idle` → `cycling`) requires
   `discovery_status = complete` unless `--force` is set. Transition T11
   bypasses this guard.

4. **Chat independence.** `chat.session_open` may be `true` in any state.
   Transitions T1–T12 proceed regardless of chat state. Chat never blocks,
   delays, or cancels a state transition.

5. **Flag exclusivity.** At most one of `awaiting_scoping`, `awaiting_confirmation`, and
   `awaiting_sharding_approval` may be `true` at any time. Setting one to
   `true` implicitly sets the others to `false`.

6. **Flag scope.** All flags are scoped to the active cycle. When the cycle
   ends (transition to `halted`, `complete`, or `idle`), all flags are reset
   to `false`.

7. **Iteration cap enforcement.** Transition T4 (retry) is only valid when
   `iteration < iteration_cap`. When the cap is reached, the system must take
   T6 (→ halted) instead. `iteration_cap` is read from
   `.sle/rules/planning.yaml` at cycle start.

8. **Revision counter scope.** The revision counter resets to 0 at the start
   of each iteration. It increments only on CONFIRM gate modification, not on
   VALIDATION gate failure.

9. **No concurrent sessions.** Only one discovery session or one cycle may be
   active at a time. The `active_session_id` / `active_cycle_id` fields are
   singular, not arrays.

10. **Terminal state liveness.** `halted` and `complete` are terminal only for
    the active cycle — they must transition to `idle` (T9, T10) or resume to
    `cycling` (T12) before new work can begin. The daemon does not stay in
    `halted` or `complete` indefinitely.

11. **Deterministic validation gate.** The VALIDATION gate is a pure function
    of category results. It does not consult LLM, user input, or external
    services. The decision to pass (T4/T8) or fail (T4/T6) is deterministic.

12. **CONFIRM gate configurability.** The CONFIRM gate is optional. When
    `user_validation.yaml` disables it, the DAG proceeds directly from TEST
    to BUILD without setting `awaiting_confirmation`.

## Open questions

| ID | Question | Impact | Status |
|---|---|---|---|
| SM-001 | Should `discovering` allow resumption after daemon restart, or does it always restart from scratch? | Recovery behavior, state persistence | Open |
| SM-002 | What is the maximum time the system may remain in `cycling` with a flag set before auto-timeout? | Resource management, user experience | Open |
| SM-003 | Should `halted` → `idle` be automatic (with acknowledgment timeout) or require explicit user action? | UX flow, daemon behavior | Open |
| SM-004 | Can `sle start --force` produce a valid cycle without any discovery artifacts, or does it only skip the status check? | Context assembly behavior, artifact availability | Open |
| SM-005 | Is there a maximum number of concurrent WebSocket subscribers that should receive state change events? | Scalability, event delivery guarantees | Open |
| SM-006 | Should flag mutations (`PATCH /flags`) be audited in `decisions.md` or only in the cycle record? | Traceability, artifact coupling | Open |
