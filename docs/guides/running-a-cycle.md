# Running a Cycle

**Type:** guide · **Updated:** 2026-05-02
**Source:** SLE-023 (user flow), specs/dag-execution, specs/state-machine

This guide covers starting, monitoring, and controlling SLE v2 development
cycles. It assumes you have completed the getting-started guide and have a
running daemon with discovery artifacts in place.

---

## Pre-cycle scoping

Before starting a cycle, you can discuss what you want to build with the
Facilitator in the Chat page. Together you can:

1. **Tag nodes** — Right-click a node in the Graph or ask the Facilitator to
   mark nodes/layers as `#next-cycle`. Tagged nodes are loaded first in the
   Planner's context.
2. **Create a scope draft** — The Facilitator helps you draft an informal scope
   document capturing your goals, requirements, and boundaries.
3. **Defer ideas** — Out-of-scope ideas are captured in the scope draft's
   deferred section for future cycles.

When you're satisfied with the scope, start the cycle with
`sle start --scope <draft-id>`.

Pre-cycle discussion is optional. You can skip it with `sle start "goal"` for
quick changes.

---

## Starting a cycle

### The `sle start` command

A cycle begins with one of three start methods:

```
# Preferred: start with a pre-created scope draft
$ sle start --scope draft-abc123

# Quick start with a goal string (auto-generates minimal scope)
$ sle start "Add rate-limiting middleware to the auth service"

# Empty start — SCOPING node will define scope from scratch
$ sle start
```

Under the hood this sends `POST /api/v2/cycles` to the daemon on port 7700:

```json
POST /api/v2/cycles
{
  "scope_draft_id": "draft-abc123",        // optional
  "quick_start_goal": "Add rate limiting",  // optional, alternative to scope_draft_id
  "version_bump": "patch",                  // optional, inferred during SCOPING
  "depth_override": "standard",             // optional
  "category_hints": ["correctness"]         // optional
}
```

The daemon responds with a `cycle_id` and the initial `DAGState`:

```
201 Created
{
  "cycle_id": "c-20260502-001",
  "dag_state": {
    "current": "SCOPING",
    "iteration": 1,
    "max_iterations": 3,
    "started_at": "2026-05-02T14:30:00Z",
    "history": []
  }
}
```

### State transition

`sle start` triggers transition T3: `idle` → `cycling`. Two preconditions must
hold (see §state-machine.md transition table):

- `discovery_status` must be `complete`, unless you pass `--force` (transition
  T11).
- `meta.status` must be `idle`. If a session or cycle is already active, the
  daemon returns 409 `session_conflict`.

```
$ sle start "Fix the pagination bug" --force
```

The `--force` flag bypasses the discovery guard. Use it when you want to run a
cycle without prior discovery artifacts.

### The goal string (quick start)

The goal string is a backward-compatible shorthand. The `quick_start_goal`
parameter auto-generates a minimal scope draft and the SCOPING node still runs
but skips the guided discussion — the charter is produced from your goal
directly. It should be a single, specific instruction — not a wish list.

Good goal strings:

- "Add JWT refresh-token rotation to the auth module"
- "Refactor the order-processing pipeline to use event sourcing"
- "Fix the race condition in concurrent cache writes"

Avoid vague goals like "improve performance" or "make it better". The Planner
works best with concrete, bounded objectives.

For richer control over scope, requirements, and boundaries, use `--scope` with
a pre-created scope draft instead.

### Optional flags

| Flag | Effect |
|---|---|
| `--scope <draft-id>` | Start with a pre-created scope draft (preferred) |
| `--bump <major\|minor\|patch>` | Override the version_bump for this cycle |
| `--depth minimal\|standard\|deep\|research` | Override the planning depth for this cycle only |
| `--force` | Bypass the discovery-completed precondition |

---

## Cycle lifecycle

### The 15-node DAG

Every cycle walks a directed acyclic graph of up to 15 nodes. Four of those
nodes are conditional and may be skipped. The daemon executes nodes in strict
sequence, pausing at human checkpoints and looping on validation failure.

The full flow (see §dag-execution.md for the diagram):

```
SCOPING → DESIGN → [CRITIQUE] → PLAN → TEST → [SHARDING_APPROVAL] → [CONFIRM]
→ BUILD → HISTORY → EXEC → VALIDATION_GATE
→ (fail → DEBUG → PLAN ...) | (pass → EVALUATE → SUMMARISE → SNAPSHOT)
```

### Phase 1: Scoping through Planning

These nodes define scope, design the solution, and decide what to build.

**SCOPING** — The first node in every cycle. The Facilitator guides you through
a structured discussion to define scope, purpose, requirements, and boundaries.
This produces a `doc:cycle-charter` artifact. If you used a quick-start goal,
the charter is auto-generated. Max rounds: configurable via `planning.yaml`
(default 5, hard cap 10). The `awaiting_scoping` flag is set while waiting for
your input.

**DESIGN** — The Designer receives the charter from SCOPING and produces
`architecture.md` and `requirements.md`. It is the sole owner of these
artifacts — no other role writes them (DDR-019). At `minimal` depth the
Designer runs one pass; at `standard`, two passes.

**CRITIQUE** *(conditional)* — Runs at `deep` and `research` depth only. The
Critic reviews the Designer's output (architecture + requirements, not the
plan). If it finds blocking issues, the Designer revises and the Critic
re-reviews. Pass limit is `reasoning_passes - 1`. The Critic is advisory — it
never halts the DAG at the system level (DDR-022).

**PLAN** — The Planner reads the charter from SCOPING as its primary input,
alongside the architecture and requirements produced by DESIGN. It produces
`plan.md` and `test-plan.md`. At `deep`/`research` depth it also produces
`build-plan.md`. On retry iterations (iteration > 1), the Planner receives the
`FailureReport` from the Debugger and rewrites only sections relevant to failed
categories.

### Phase 2: Testing through Snapshot

These nodes validate and commit the work.

**TEST** — The Tester writes executable test scripts from requirements only. It
never sees the architecture or implementation — this is the TDD separation.
One script per active validation category, written to `scripts/test_{category}.ts`.

**SHARDING_APPROVAL** *(conditional)* — Only when the Planner produced a
sharding proposal (DDR-026). Sets `cycle.awaiting_sharding_approval = true`.

**CONFIRM** *(conditional)* — The primary human checkpoint, controlled by
`user_validation.yaml → approval_required`. Sets
`cycle.awaiting_confirmation = true` and presents the plan, test suite, and
coverage mapping for your review.

**BUILD** — The Builder reads the confirmed plan, architecture, and test-plan,
then produces implementation code and instrumented test scripts. On retry, it
regenerates from scratch (does not patch previous output).

**HISTORY** — The Historian appends a 2-3 sentence entry to `decisions.md`.
This file is append-only — entries are preserved across all iterations and
cycles.

**EXEC** — All validation categories run in parallel. Within each category,
three sub-phases execute in order: `static-check` → `llm-check` → `exec-check`.
A `static-check` failure skips the remaining sub-phases for that category.

**VALIDATION_GATE** — Deterministic pass/fail. No LLM involvement. All active
categories must pass. On pass, the DAG proceeds to EVALUATE. On fail, it
proceeds to DEBUG and the iteration counter increments.

**DEBUG** *(conditional)* — Runs only on gate failure. The Debugger reads run
artifacts from `.sle/runs/{id}/` and produces a `FailureReport` with root
causes. If it cannot diagnose, the gate's raw report is passed to the Planner
as-is. The cycle then loops back to PLAN.

**EVALUATE** — The Evaluator produces `evaluation.md` — a structured verdict on
whether the implementation satisfied the original intent. This document feeds
into the next cycle's context.

**SUMMARISE** — Produces three artifacts: `reports/validation-latest.html`,
`scripts/run-tests.ts`, and `reports/changelog-{version}.md`. Also generates a
user-facing summary with what was built, what changed, and how to test.

**SNAPSHOT** — The terminal node. Assigns a `version_id`, commits artifacts to
the docs and code remotes, sets `meta.status → complete`, then the daemon
automatically transitions to `idle` (transition T9).

---

## Monitoring progress

### Using `sle status`

```
$ sle status
State:       cycling
Cycle:       c-20260502-001 (#4)
Iteration:   1 / 3
Revision:    0
Current:     BUILD
Depth:       standard
Flags:       awaiting_confirmation=false
             awaiting_sharding_approval=false
Started:     2026-05-02T14:30:00Z (12m ago)
```

The `current` field tells you which DAG node is executing. The `iteration`
field shows how many times the BUILD → EXEC → VALIDATION_GATE loop has run.

### WebSocket events for real-time monitoring

Connect to `ws://localhost:7700/events` to receive push events as the DAG
progresses. Key events for cycle monitoring:

| Event | When emitted |
|---|---|
| `node.started` | DAG enters a new node |
| `node.completed` | DAG exits a node (with duration) |
| `gate.result` | VALIDATION_GATE passes or fails |
| `dag.confirm_requested` | CONFIRM gate awaits your approval |
| `dag.sharding_requested` | SHARDING_APPROVAL gate awaits your decision |
| `dag.snapshot_locked` | Cycle completes and version is locked |
| `cycle.flag_changed` | An awaiting flag is set or cleared |
| `cycle.scoping_input_requested` | SCOPING node waiting for your input |
| `cycle.charter_produced` | SCOPING completed, charter ready |
| `graph.node_tagged` | A node was tagged (e.g. `#next-cycle`) |
| `graph.node_untagged` | A node tag was removed |

Example `node.started` event:

```
{
  "cycle_id": "c-20260502-001",
  "node": "BUILD",
  "iteration": 1,
  "revision": 0,
  "timestamp": "2026-05-02T14:35:00Z"
}
```

Events are fire-and-forget. If you disconnect, call `GET /api/v2/system/state`
on reconnect to synchronise. The full event catalogue is in
§reference/websocket-events.md.

### Reading cycle logs

Run artifacts are stored under `.sle/runs/{run_id}/`. Each run directory
contains:

| Path | Content |
|---|---|
| `manifest.json` | Run metadata, categories, timestamps |
| `ai/context-pack.md` | Assembled context for the Debugger |
| `tests/{category}/result.json` | Per-category test results |
| `metrics/*.json` | Performance and quality metrics |
| `traces/*.jsonl` | Execution traces |
| `logs/{service}.log` | Service-level logs |

The DAG execution history is recorded in the `DAGState.history` array on the
cycle record in `map.yaml`. Every node transition appends a `DAGEvent` with the
node name, event type (`enter | exit | error | skip`), and timestamp.

---

## Pausing and halting

### Graceful halt with `sle halt`

```
$ sle halt
```

This sends `POST /api/v2/cycles/{cycle_id}/halt` and triggers transition T5:
`cycling` → `halted`. The daemon writes a partial report and preserves run
artifacts.

Halt is a soft stop. It completes the current node, writes the partial report,
and transitions to `halted`. The cycle context is preserved — resume with
`sle resume` (transition T12: `halted` → `cycling`).

Halt only works when `meta.status = cycling`. If the system is not cycling,
the daemon returns 409 `halt_not_cycling`.

### Awaiting confirmation

When the DAG reaches the CONFIRM gate, it sets
`cycle.awaiting_confirmation = true`. The system state remains `cycling` — this
is a flag-based pause, not a state change. The Facilitator operates in decision
mode.

At the CONFIRM gate you can:

- **Approve** — `POST /api/v2/cycles/{cycle_id}/approve`.
  Clears the flag and proceeds to BUILD.
- **Modify plan steps** — `POST /api/v2/cycles/{cycle_id}/revise` with a
  `PlanModification` payload. Increments the revision counter and re-runs the
  TEST node for affected categories.
- **Modify test criteria** — Same endpoint, but with `test_criteria` changes
  only. No TEST re-run — criteria are updated and CONFIRM re-presents.
- **Halt** — Halts the cycle.

```
curl -X POST http://localhost:7700/api/v2/cycles/{cycle_id}/revise \
  -d '{"remove_steps": ["step_003"], "add_steps": ["Add input sanitisation after auth check"]}'
```

Multiple revision rounds are allowed within one iteration. The revision counter
is visible in the CONFIRM prompt. The iteration counter does not increment on
revisions — only on VALIDATION_GATE failure.

### Awaiting sharding approval

When the Planner produces a sharding proposal during the intake sub-phase, the
DAG sets `cycle.awaiting_sharding_approval = true` and pauses at
SHARDING_APPROVAL. You review the proposed task boundaries, context
declarations, and dependencies.

Actions:

- **Approve** — `POST /api/v2/cycles/{cycle_id}/sharding/approve`. Creates Beads
  tasks, updates the link index, and proceeds to CONFIRM.
- **Reject** — `POST /api/v2/cycles/{cycle_id}/sharding/reject`. Proceeds to
  CONFIRM without sharding. The Planner re-plans without a split.
- **Modify** — `POST /api/v2/cycles/{cycle_id}/sharding/modify` with task-level
  edits (add, remove, edit). Re-presents the revised proposal.

At most one flag is `true` at a time. The system never prompts for sharding
approval and plan confirmation concurrently.

### Halt vs force-stop

| Action | Command | Effect |
|---|---|---|
| Graceful halt | `sle halt` | Completes current node, writes partial report, transitions to `halted` |
| Resume after halt | `sle resume` | Returns to `cycling`, preserves iteration count and context |
| Acknowledge halt | Acknowledge the halt report | Transitions `halted` → `idle`, clears cycle context |

There is no "kill" command. If the daemon process crashes, `map.yaml` preserves
the last committed state. On restart, the daemon restores from `map.yaml` — if
`meta.status = cycling` with an awaiting flag, it re-enters decision mode at
the correct gate. If cycling with no flag, it resumes from the last DAG node.

---

## Reviewing results

### Cycle output

A completed cycle produces these artifacts:

| Artifact | Produced by | Location |
|---|---|---|
| `architecture.md` | Designer | `.sle/project-docs/` |
| `requirements.md` | Designer | `.sle/project-docs/` |
| `plan.md` / `test-plan.md` | Planner | `.sle/project-docs/` |
| Test scripts | Tester / Builder | `scripts/test_{category}.ts` |
| Implementation | Builder | Project source tree |
| `decisions.md` entry | Historian | `.sle/project-docs/` (appended) |
| `evaluation.md` | Evaluator | `.sle/project-docs/` |
| Validation report | SUMMARISE | `reports/validation-latest.html` |
| Changelog | SUMMARISE | `reports/changelog-{version}.md` |

Read any artifact via `GET /api/v2/artifacts/{id}`, or diff against a previous
version with `GET /api/v2/artifacts/{id}/diff?from_version={version}`.

### Evaluation verdict

The EVALUATE node writes `evaluation.md` with a structured verdict:

- **satisfied** — Implementation meets the intent.
- **partially satisfied** — Some requirements met, others deferred.
- **not satisfied** — Core intent unmet.

Each requirement is assessed with evidence. The evaluation includes
recommendations for the next cycle. Retrieve reports with
`GET /api/v2/reports/latest` or `GET /api/v2/reports/{cycle_id}`.

### Critique output

When CRITIQUE runs (`deep`/`research` depth), the Critic produces a
`CritiqueResult` with three tiers:

- **blocking_issues** — Must be resolved before the cycle proceeds.
- **warnings** — Noted but non-blocking.
- **suggestions** — Advisory improvements.

At `deep`/`research` depth, the Critic also writes `doc:critique-report` — a
persistent design review note stored alongside project documents. This report
carries forward to future cycles as context.

---

## Multi-cycle workflows

### Sequential cycles

Each cycle builds on the output of the previous one. After SNAPSHOT completes,
the system transitions to `idle` and you can immediately start a new cycle:

```
$ sle start "Add IP-based rate limiting on top of the auth middleware"
```

The second cycle's SCOPING node reads the first cycle's `architecture.md`,
`requirements.md`, `decisions.md` (last 3 entries), and `evaluation.md`.
This is how context carries forward across cycles.

`#next-cycle` tags persist across cycles — untouched tags remain for future
use. Scope drafts are also reusable: if you deferred ideas in a previous
scope draft, you can start a new cycle with `sle start --scope <same-draft-id>`
and the Facilitator will use the deferred section as a starting point.

### How context carries forward

| Artifact | How it persists |
|---|---|
| `architecture.md` | Designer reads and revises (not rewrites from scratch) |
| `requirements.md` | Designer extends with new requirements |
| `decisions.md` | Append-only — all entries from all cycles are preserved |
| `evaluation.md` | Evaluator reads prior evaluation; Planner reads it too |
| `plan.md` | Fresh each cycle — the Planner writes a new plan |
| `test-plan.md` | Fresh each cycle |
| Version snapshots | Locked in `map.yaml` under `versions[]` |
| `CHANGELOG.md` | Cumulative — each cycle's SUMMARISE node appends entries |

The `version_bump` for each cycle can be set explicitly via `--bump` or is
inferred during SCOPING based on the scope's impact. Multiple sequential patch
cycles accumulate into the CHANGELOG under a single version if no bump override
is provided.

### When to start fresh vs continue

**Continue** (sequential cycles) when:

- You are iterating on the same feature or module.
- The previous evaluation was "partially satisfied" with clear next steps.
- You want to build on existing architecture and decisions.

**Start fresh** (re-run discovery) when:

- You are switching to a fundamentally different area of the codebase.
- The architecture has drifted significantly from the project documents.
- You need to re-establish project context after a long gap.

To start fresh:

```
$ sle discover --revisit
```

This re-enters `discovering` state and re-runs the discovery rounds.

---

## Troubleshooting

### Common failure modes

**`session_conflict` (409)** — You tried to start a cycle while the system is
not `idle`. Check current state with `sle status`. Halt or acknowledge the
active session first.

**`discovery_required` (403)** — No discovery artifacts exist and `--force` was
not set. Run `sle discover` first, or use `sle start "goal" --force`.

**`halt_not_cycling` (409)** — You tried to halt when the system is not in
`cycling` state. This can happen if the cycle already completed or was halted
by a previous command.

**`not_awaiting_confirmation` (409)** — You tried to approve or revise when the
CONFIRM gate is not active. The DAG may have already moved past CONFIRM, or the
gate is not enabled in your configuration.

**`agent_timeout`** — An LLM call exceeded the timeout. The daemon retries once
and then halts. Resume with `sle resume` after the issue resolves.

**`docker_unavailable`** — EXEC requires Docker but the Docker daemon is not
running. Start Docker and resume.

**`scoping_timeout`** — The SCOPING node's max rounds were exceeded and the
cycle halts. Increase `planning.yaml → scoping.max_rounds` or simplify the
scope. Restart with `sle start` after adjusting.

**`charter_validation_failed`** — SCOPING could not produce a valid cycle
charter. Ensure your scope and purpose are clearly defined. For quick starts,
provide a more specific goal string.

### Stuck in a state

If the daemon crashes or you lose connectivity, the system state is preserved in
`map.yaml`. On daemon restart:

- If `meta.status = cycling` and an awaiting flag is set, the daemon re-enters
  decision mode at the correct gate.
- If `meta.status = cycling` with no flag, the daemon resumes from the last
  committed DAG node.
- If `meta.status = halted`, it stays halted until you acknowledge or resume.

To manually transition state (use with caution), send
`POST /api/v2/system/state/transition`. The daemon validates the transition
against the transition table — invalid transitions return 409 with allowed
targets.

### Cycle fails validation

When the VALIDATION_GATE fails, the DEBUG node produces a `FailureReport`.
Check the cycle state with `GET /api/v2/cycles/{cycle_id}` and look at the
`dag_state.history` array for the gate result event. The `failed_categories`
field lists which categories failed. For each failed category, check the run
artifacts in `.sle/runs/{run_id}/`:

- `tests/{category}/result.json` — Detailed pass/fail per test case.
- `ai/context-pack.md` — The context the Debugger used for diagnosis.

If the iteration cap is reached, the daemon halts and writes a partial report
with a cap-exceeded notice. The cap behavior is configured in
`exit.yaml → on_cap_hit`:

| Behavior | Effect |
|---|---|
| `halt_with_report` | Halt with partial report (default) |
| `user_prompt` | Pause and ask you to continue or halt |
| `force_pass` | Lock the snapshot despite failures |

### Iteration and revision counters

If progress seems stuck, check both counters:

- **Iteration** — Increments on VALIDATION_GATE failure only. Resets per cycle.
  The loop is: PLAN → TEST → CONFIRM → BUILD → HISTORY → EXEC → VALIDATION_GATE → (fail)
  → DEBUG → PLAN.
- **Revision** — Increments on CONFIRM gate modification only. Resets per
  iteration. Multiple revisions are allowed within one iteration without
  touching the iteration counter.

If both are incrementing but the cycle is not converging, the
`FailureReport` may indicate a structural problem. In rare cases, the Debugger
flags a blocking issue as `structural`, which causes the iteration loop to
extend back to DESIGN instead of PLAN. This escalation is automatic — the
Designer receives the Debugger's structural diagnosis alongside the normal
report.

### Viewing dispatch progress

During the EXEC node, you can monitor per-category progress:

```
GET /api/v2/cycles/{cycle_id}/dispatch
```

This returns the dispatch status including `category_progress` — a map of each
category to its sub-phase status (`pending | running | completed | failed |
skipped`). Use this to see which categories have passed `static-check` and are
proceeding to `llm-check` and `exec-check`.
