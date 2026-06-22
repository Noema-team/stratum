# State Machine

**Type:** spec · **Status:** draft · **Updated:** 2026-06-21
**Depends on:** DDR-020, DDR-021, DDR-026, DDR-031
**Source material:** SLE-024 §2

## Overview

The Stratum system maintains exactly one **project-wide** machine state at
all times, plus any number of independent **per-run** states — one per
active `WorkflowRun`. The two are tracked separately and never conflated
(DDR-031): project-wide state answers "is discovery in progress," per-run
state answers "where is this particular workflow run in its own step
graph."

Project-wide states are mutually exclusive and exhaustive, and govern only
the lifecycle of discovery sessions — the one piece of work that is
inherently singular and project-wide, because it bootstraps the project
graph everything else depends on (DDR-031, "Discovery stays outside the
workflow model"). Workflow runs are not part of this state machine; each
carries its own `WorkflowRun.status` and progresses independently of every
other run.

Chat and checkpoint pauses are **not** project-wide machine states, and were
never modeled as full machine states even before this generalization. Chat
is an orthogonal layer tracked by a boolean flag on the chat record.
Checkpoint pauses are a single nullable pointer (`awaiting_checkpoint`) on
each `WorkflowRun` record. Neither consumes a project-wide state slot, and
neither is shared across runs.

The machine starts in `idle`. Unlike before, it does **not** need to return
to `idle` before workflow runs can begin or proceed — only discovery itself
is gated by `idle`.

## Data model

### System state

```
type SystemStatus =
  | "idle"
  | "discovering"
```

Stored in `map.yaml → meta.status`. Updated atomically on every transition.
`cycling`, `halted`, and `complete` are **removed** as project-wide values
(DDR-031, WG-001) — those concepts now live exclusively on
`WorkflowRun.status`, scoped to one run, never to the project as a whole.
Clients derive "is work in progress" from a count of active runs
(`active_workflow_run_count`, see §API contract), not from `meta.status`.

### Workflow run status

```
type WorkflowRunStatus = "active" | "halted" | "complete"
```

Stored per-run in `map.yaml → workflow_runs.{run_id}.status`. Each
`WorkflowRun` transitions through this independently of every other run and
independently of `meta.status`. See §Per-run transitions below. Full type:
`WorkflowRun` in [../reference/types.md](../reference/types.md) §4.

### Checkpoint pointer (per run)

`WorkflowRun.awaiting_checkpoint` is a single nullable pointer to the
`step_id` of the `checkpoint` step currently pausing that run, or `null`.
It represents a pause point where that run waits for an external response.
It does **not** change `meta.status` — project-wide state stays
`idle | discovering` regardless of how many runs are paused, and it does
not change any *other* run's state either.

| Field | Set when | Cleared when |
|---|---|---|
| `awaiting_checkpoint` | A `checkpoint` step in this run's graph becomes active and waits for user input | User responds (approve/modify/halt) for that checkpoint |

At most one checkpoint per run is active at a time — guaranteed by
construction, since the field is a single pointer rather than a set of
flags (DDR-031). Different runs may each have their own `awaiting_checkpoint`
set concurrently; they are entirely independent.

### Chat session layer

```
type ChatSession = {
  session_open: boolean
  started_at:   string | null
}
```

Stored in `map.yaml → chat`. The `session_open` boolean is entirely
independent of `system.state` and of every `WorkflowRun.status`. Chat can be
open regardless of project-wide state or how many runs are active. Chat
never blocks, interrupts, or otherwise affects state transitions at either
level.

When `session_open` is `true`, the Facilitator operates in **chat mode**
(freeform Q&A). When any active run has `awaiting_checkpoint` set, the
Facilitator simultaneously operates in **decision mode** (structured gate
actions) **for that run**. These two modes coexist — chat mode does not
replace decision mode, and decision mode for one run does not preclude
chat mode about an entirely different run.

### State context

```
type StateContext = {
  state:                      SystemStatus
  active_session_id:          string | null
  discovery_status:           "not_started" | "in_progress" | "complete"
  active_workflow_run_count:  number
  active_workflow_run_ids:    string[]
}
```

Populated from `map.yaml` on every daemon tick. Exposed via the status API.
Replaces the former singular `active_cycle_id` / `iteration` / `revision`
fields — those now live per-run on each `WorkflowRun`, fetched via
`GET /api/v2/workflow-runs/{run_id}` (see
[workflow-execution.md](workflow-execution.md)), not on project-wide state.

## Behavior

### Project-wide state diagram

```
        ┌─────────┐
   ┌───►│  idle   │◄───┐
   │    └────┬────┘    │
   │         │ T1       │ T2
   │         ▼          │
   │  ┌─────────────┐   │
   └──┤ discovering │───┘
      └─────────────┘
```

Two states, two transitions. Workflow runs are not nodes in this diagram —
any number of them may be active while the system sits in `idle`, and a new
run may start without changing `meta.status` at all.

### Per-run state diagram (one instance per `WorkflowRun`)

```
                    ┌──────────┐
              ┌────►│  active  │◄────┐
              │     └─┬───┬────┘     │
       resume │       │   │          │ (no transition;
   (re-enter   │       │   │          │  checkpoint pause
    active)    │  halt │   │ commit   │  is awaiting_checkpoint,
              │       ▼   ▼          │  not a status change)
          ┌────┴───┐ ┌─────────┐     │
          │ halted │ │complete │     │
          └────────┘ └─────────┘     │
                                      │
          (awaiting_checkpoint set/cleared while status stays "active") ──┘
```

Each `WorkflowRun` walks this independently. A `checkpoint` step pausing the
run does **not** change `WorkflowRun.status` — it stays `active` with
`awaiting_checkpoint` set to the paused step's id. `status` only changes on
halt or terminal commit.

### Project-wide transition table

| # | From | To | Trigger | Precondition | Side effects |
|---|---|---|---|---|---|
| T1 | `idle` | `discovering` | `sle discover` | `discovery_status ≠ complete` | Create discovery session, set `active_session_id` |
| T2 | `discovering` | `idle` | Discovery session ends (synthesis + planning complete) | Discovery session is in terminal round | Write discovery artifacts, set `discovery_status := complete`, clear `active_session_id` |

That is the entire project-wide table. Discovery is the one mechanism this
state machine governs (DDR-031). Everything formerly modeled as T3–T12
(cycle start, retry, halt, complete, resume) is now per-run behavior — see
§Per-run transitions and [workflow-execution.md](workflow-execution.md).

### Per-run transitions

These transitions apply independently to each `WorkflowRun` and never touch
`meta.status`.

| # | From | To | Trigger | Precondition | Side effects |
|---|---|---|---|---|---|
| R1 | *(none)* | `active` | `POST /api/v2/workflow-runs` | No conflicting artifact claim (else `claim_conflict`); discovery complete if the workflow requires it | Create `WorkflowRun` record, claim target artifacts, set `iteration := 1`, `revision := 0` |
| R2 | `active` | `active` | A `review` step fails, iteration cap not reached | `iteration < max_iterations` | `iteration++`, route to `on_fail.target_step_id`, inject FailureReport, clear run artifacts |
| R3 | `active` | `halted` | User issues halt for this run | `WorkflowRun.status = active` | Write partial report, preserve run artifacts, release claims |
| R4 | `active` | `halted` | A `review` step fails, iteration cap reached | `iteration ≥ max_iterations` | Write partial report with cap-exceeded notice, release claims |
| R5 | `active` | `halted` | Unrecoverable error | Any step | Write error report, preserve artifacts produced so far, release claims |
| R6 | `active` | `complete` | The terminal `commit` step finishes | All validation categories pass (for workflows that declare a validation review step) | Write artifact(s), bump version, release claims, optionally append decision log |
| R7 | `halted` | `active` | User resumes this run | Halted state, user confirmation | Resume keeps run context (iteration count preserved); re-claims artifacts (fails with `claim_conflict` if another run claimed them meanwhile) |

`awaiting_checkpoint` mutations (a `checkpoint` step pausing or resuming)
are **not** rows in this table — the run's `status` stays `active`
throughout. They are documented as their own mechanism in
[workflow-execution.md](workflow-execution.md) §Human checkpoints, since
their specifics (what's reviewed, what actions are available) are
workflow-specific, not generic to every run.

### Chat session transitions

Chat is orthogonal to both the project-wide and per-run state machines.
These transitions can occur regardless of `meta.status` or any run's
status.

| Chat transition | Trigger | Precondition |
|---|---|---|
| `session_open := true` | `sle chat` | None |
| `session_open := false` | User ends chat session (e.g. `/exit`) | `session_open = true` |

Chat availability matrix:

| System state | Chat available | Chat mode | Decision mode |
|---|---|---|---|
| `idle` | Yes | Freeform Q&A | No (unless some active run has `awaiting_checkpoint` set) |
| `discovering` | Yes | Freeform Q&A | No |
| Any state, ≥1 run with `awaiting_checkpoint` set | Yes | Freeform Q&A | Yes — decision mode scoped to that run |

Decision mode is per-run, not per-project: with two concurrent runs, one
paused at a checkpoint and one not, the user can simultaneously chat freely
and resolve the one paused checkpoint — there is no project-wide "decision
mode" flag to coordinate.

## API contract

### Get system state

```
GET /api/v2/system/state

Response 200:
{
  "state":                       SystemStatus,
  "active_session_id":           string | null,
  "discovery_status":            "not_started" | "in_progress" | "complete",
  "active_workflow_run_count":   number,
  "active_workflow_run_ids":     string[],
  "chat": {
    "session_open": boolean
  }
}
```

Per-run detail (`iteration`, `revision`, `awaiting_checkpoint`, etc.) is
fetched per run via `GET /api/v2/workflow-runs/{run_id}`
([workflow-execution.md](workflow-execution.md)), not bundled into this
project-wide response.

### Transition project-wide state

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
  "current":   SystemStatus
}

Response 409:
{
  "error":     "invalid_transition",
  "from":      SystemStatus,
  "to":        SystemStatus,
  "reason":    string
}
```

This endpoint now only ever transitions between `idle` and `discovering`
(T1/T2). Starting, retrying, halting, resuming, or completing a workflow
run uses the per-run endpoints in
[workflow-execution.md](workflow-execution.md) (`POST /api/v2/workflow-runs`,
`/halt`, `/approve`, `/revise`), never this one.

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

event: workflow_run.checkpoint_changed
{
  "run_id":            string,
  "awaiting_checkpoint": string | null,
  "timestamp":         string
}

event: chat.session_changed
{
  "session_open": boolean,
  "timestamp":    string
}
```

Per-run lifecycle events (`step.started`, `step.completed`,
`workflow_run.checkpoint_requested`, `workflow_run.committed`, etc.) are
catalogued in [workflow-execution.md](workflow-execution.md) §WebSocket
events, not here — this file only owns the two project-wide events plus the
generic checkpoint-pointer-changed event, since checkpoint behavior is the
one per-run concept that still has a structural analog to the old project-
wide flags.

## Error cases

| Error | Condition | Response |
|---|---|---|
| `invalid_transition` | Transition not in the project-wide transition table for current state | 409 with allowed targets |
| `discovery_required` | A workflow that requires discovery is dispatched when `discovery_status ≠ complete` and `--force` not set | 403 with message suggesting `sle discover` |
| `session_conflict` | `sle discover` issued when state is not `idle` | 409 with current state |
| `claim_conflict` | A new run's target artifact is already claimed by a different active run | 409, rejected immediately at dispatch, not retried |
| `stale_claim_commit` | A run's artifact version changed since its claim was acquired | Halt that run, no auto-retry |
| `not_awaiting_checkpoint` | Action submitted for a checkpoint that isn't this run's current pause point | 409 |
| `run_not_found` | Action submitted for a `run_id` that does not exist | 404 |
| `chat_already_open` | POST open when `session_open = true` | 204 (idempotent, no-op) |
| `chat_not_open` | DELETE session when `session_open = false` | 204 (idempotent, no-op) |
| `halt_not_active` | Halt requested for a run that is not `active` | 409 with current run status |
| `iteration_cap_invalid` | `iteration_cap ≤ 0` in configuration | 500 (configuration error) |

## Constraints

1. **Single project-wide state invariant.** The system is in exactly one of
   the two project-wide states at all times. There is no "between states"
   condition. Every project-wide transition is atomic — `map.yaml` is
   updated in a single write.

2. **Idle gateway, discovery only.** Only `idle` can transition to
   `discovering`. A discovery session must fully resolve (reach `idle`)
   before a new one can start. This gateway applies to discovery alone —
   it no longer gates workflow runs.

3. **Discovery guard.** Dispatching a workflow that requires discovery
   (e.g. `full-build`) requires `discovery_status = complete` unless
   `--force` is set on that dispatch.

4. **Chat independence.** `chat.session_open` may be `true` regardless of
   project-wide state or any run's status. Project-wide and per-run
   transitions proceed regardless of chat state. Chat never blocks,
   delays, or cancels a transition at either level.

5. **Checkpoint exclusivity, per run.** At most one checkpoint may be active
   per `WorkflowRun` at any time — guaranteed by `awaiting_checkpoint` being
   a single nullable pointer, not a set of flags. This constraint is local
   to each run; it says nothing about other concurrently active runs.

6. **Checkpoint scope.** `awaiting_checkpoint` is scoped to its own run.
   When that run ends (transitions to `halted` or `complete`), its pointer
   resets to `null`. It never affects any other run's pointer.

7. **Iteration cap enforcement.** Per-run transition R2 (retry) is only
   valid when `iteration < max_iterations` for that run. When the cap is
   reached, that run must take R4 (→ halted) instead. `max_iterations` is
   read from `.sle/rules/planning.yaml` at run start, per run.

8. **Revision counter scope.** Each run's revision counter resets to 0 at
   the start of each of its own iterations. It increments only on that
   run's CONFIRM-equivalent checkpoint modification, not on review-step
   failure.

9. **Concurrent runs are the default, not an exception.** Any number of
   `WorkflowRun`s may be `active` simultaneously, scoped only by artifact
   claims (DDR-031) — there is no `active_session_id`-style singular
   pointer for workflow runs the way there is for discovery. Two runs
   contend only if they claim the same artifact ref.

10. **Terminal state liveness, per run.** `halted` and `complete` are
    terminal only for that specific run — that run must resume (R7) before
    it can progress further, or stay terminal indefinitely without
    blocking any other run. Unlike the old project-wide model, a halted or
    complete run never blocks the daemon from starting other runs.

11. **Deterministic validation gate.** Any `review` step a workflow declares
    for its terminal pass/fail decision (e.g. `full-build`'s
    VALIDATION_GATE) is a pure function of its inputs where the workflow
    specifies a deterministic check. It does not consult LLM, user input,
    or external services for that determination. The decision to retry
    (R2) or halt (R4) follows deterministically from that result.

12. **Checkpoint configurability, per workflow.** Whether a given workflow
    declares a `checkpoint` step at all (e.g. `full-build`'s CONFIRM
    equivalent) is configurable per `user_validation.yaml` for `full-build`
    specifically; other workflows declare their own checkpoints
    independently in their `WorkflowDefinition`.

## Open questions

| ID | Question | Impact | Status |
|---|---|---|---|
| SM-001 | Should `discovering` allow resumption after daemon restart, or does it always restart from scratch? | Recovery behavior, state persistence | Open |
| SM-002 | What is the maximum time a run may remain `active` with `awaiting_checkpoint` set before auto-timeout? | Resource management, user experience | Open |
| SM-003 | Should `halted` → resumed be automatic (with acknowledgment timeout) or require explicit user action, per run? | UX flow, daemon behavior | Open |
| SM-004 | Can a workflow run started with `--force` produce a valid result without any discovery artifacts, or does it only skip the status check? | Context assembly behavior, artifact availability | Open |
| SM-005 | Is there a maximum number of concurrent WebSocket subscribers that should receive state change events, now that events can originate from N concurrent runs? | Scalability, event delivery guarantees | Open |
| SM-006 | Should checkpoint mutations be audited in `decisions.md` or only in the run record? | Traceability, artifact coupling | Open |
| SM-007 | Is there a cap on the number of concurrently active workflow runs project-wide, or is the only limit artifact-claim contention? | Resource management under DDR-031's concurrency model | Open |
