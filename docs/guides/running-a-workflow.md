# Running a Workflow

**Type:** guide · **Updated:** 2026-06-22
**Source:** SLE-023 (user flow), specs/workflow-execution, specs/step-kind-reference, specs/state-machine

This guide covers starting, monitoring, and controlling SLE v2 workflow
runs. It assumes you have completed the getting-started guide and have a
running daemon with discovery artifacts in place. Examples use the
`full-build` workflow, the built-in preset that reproduces the system's
original full design-build-test-review pipeline; the same commands and
endpoints work for any `WorkflowDefinition`.

---

## Pre-run scoping

Before starting a workflow run, you can discuss what you want to build with
the Facilitator in the Chat page. Together you can:

1. **Tag nodes** — Right-click a node in the Graph or ask the Facilitator to
   mark nodes/layers as `#next-run`. Tagged nodes are loaded first in the
   Planner's context.
2. **Create a scope draft** — The Facilitator helps you draft an informal scope
   document capturing your goals, requirements, and boundaries.
3. **Defer ideas** — Out-of-scope ideas are captured in the scope draft's
   deferred section for future runs.

When you're satisfied with the scope, start the run with
`sle run full-build --scope <draft-id>`.

Pre-run discussion is optional. You can skip it with `sle run full-build "goal"`
for quick changes.

---

## Starting a workflow run

### The `sle run` command

A workflow run begins with one of three start methods:

```
# Preferred: start with a pre-created scope draft
$ sle run full-build --scope draft-abc123

# Quick start with a goal string (auto-generates minimal scope)
$ sle run full-build "Add rate-limiting middleware to the auth service"

# Empty start — SCOPING's produce/checkpoint steps will define scope from scratch
$ sle run full-build
```

Under the hood this sends `POST /api/v2/workflow-runs` to the daemon on port 7700:

```json
POST /api/v2/workflow-runs
{
  "workflow_id": "full-build",
  "scope_draft_id": "draft-abc123",        // optional
  "quick_start_goal": "Add rate limiting",  // optional, alternative to scope_draft_id
  "version_bump": "patch",                  // optional, inferred during SCOPING
  "depth_override": "standard",             // optional
  "category_hints": ["correctness"]         // optional
}
```

The daemon responds with a `run_id` and the starting step:

```
201 Created
{
  "ok": true,
  "data": {
    "run_id": "full-build-5-i1-20260502T143000Z",
    "workflow_id": "full-build",
    "current_step_id": "scoping_gather",
    "started_at": "2026-05-02T14:30:00Z"
  }
}
```

### State transition

`sle run` calls transition R1 in the state machine (state-machine.md
§Transition table): `(none)` → `active` for the new `WorkflowRun`. Two
preconditions must hold:

- `discovery_status` must be `complete` if the workflow requires discovery
  (e.g. `full-build`), unless you pass `--force`.
- No conflicting artifact claim. If the run's target artifacts are already
  claimed by a different active run, the daemon returns 409
  `claim_conflict` — rejected immediately, not retried. Unrelated runs are
  never blocked by this check.

```
$ sle run full-build "Fix the pagination bug" --force
```

The `--force` flag bypasses the discovery guard. Use it when you want to run
without prior discovery artifacts.

### The goal string (quick start)

The goal string is a shorthand. The `quick_start_goal` parameter
auto-generates a minimal scope draft and SCOPING's gather/produce steps
still run but skip the guided discussion — the charter is produced from your
goal directly. It should be a single, specific instruction — not a wish
list.

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
| `--bump <major\|minor\|patch>` | Override the version_bump for this run |
| `--depth minimal\|standard\|deep\|research` | Override the planning depth for this run only |
| `--force` | Bypass the discovery-completed precondition |

---

## Workflow-run lifecycle

### `full-build`'s 14 step instances

`full-build` walks through 14 step instances spanning the six generic
`StepKind` values (`gather`, `produce`, `review`, `checkpoint`, `execute`,
`commit` — see step-kind-reference.md §Part 1). Six are conditional and may
be skipped. The daemon executes steps in strict sequence, pausing at
checkpoint steps and looping on validation failure.

The full flow (see step-kind-reference.md §Part 2 for the worked example):

```
SCOPING (gather→produce→checkpoint) → DESIGN → [CRITIQUE] → PLAN → TEST
→ [SHARDING_APPROVAL] → [CONFIRM] → BUILD → EXEC → VALIDATION_GATE
→ (fail → DEBUG → PLAN ...) | (pass → EVALUATE → SUMMARISE → SNAPSHOT)
```

### Phase 1: Scoping through Planning

These steps define scope, design the solution, and decide what to build.

**SCOPING** (`gather` → `produce` → `checkpoint`) — The first step group in
every run. The Facilitator guides you through a structured discussion to
define scope, purpose, requirements, and boundaries. This produces a
`doc:cycle-charter` artifact. If you used a quick-start goal, the charter is
auto-generated. Max rounds: configurable via `planning.yaml` (default 5,
hard cap 10). `WorkflowRun.awaiting_checkpoint` is set to this checkpoint
step's id while waiting for your input.

**DESIGN** (`produce`) — The Designer receives the charter from SCOPING and
produces `architecture.md` and `requirements.md`. It is the sole owner of
these artifacts — no other role writes them (DDR-019). At `minimal` depth
the Designer runs one pass; at `standard`, two passes.

**CRITIQUE** (`review`, conditional) — Runs at `deep` and `research` depth
only. The Critic reviews the Designer's output (architecture + requirements,
not the plan). If it finds blocking issues, `on_fail` routes back to DESIGN
for revision, and the Critic re-reviews. Pass limit is `reasoning_passes -
1`. The Critic is advisory — it never halts the run at the system level
(DDR-022).

**PLAN** (`produce`) — The Planner reads the charter from SCOPING as its
primary input, alongside the architecture and requirements produced by
DESIGN. It produces `plan.md` and `test-plan.md`. At `deep`/`research` depth
it also produces `build-plan.md`. On retry iterations (iteration > 1), the
Planner receives the `FailureReport` from the Debug step and rewrites only
sections relevant to failed categories.

### Phase 2: Testing through Snapshot

These steps validate and commit the work.

**TEST** (`produce`) — The Tester writes executable test scripts from
requirements only. It never sees the architecture or implementation — this
is the TDD separation. One script per active validation category, written
to `scripts/test_{category}.ts`.

**SHARDING_APPROVAL** (`checkpoint`, conditional) — Only when the Planner
produced a sharding proposal (DDR-026). Sets `awaiting_checkpoint` to this
step's id.

**CONFIRM** (`checkpoint`, conditional) — The primary human checkpoint,
controlled by `user_validation.yaml → approval_required`. Sets
`awaiting_checkpoint` to this step's id and presents the plan, test suite,
and coverage mapping for your review.

**BUILD** (`produce`) — The Builder reads the confirmed plan, architecture,
and test-plan, then produces implementation code and instrumented test
scripts. On retry, it regenerates from scratch (does not patch previous
output).

**EXEC** (`execute`) — All validation categories run in parallel. Within
each category, three sub-phases execute in order: `static-check` →
`llm-check` → `exec-check`. A `static-check` failure skips the remaining
sub-phases for that category.

**VALIDATION_GATE** (`review`) — Deterministic pass/fail. No LLM
involvement. All active categories must pass. On pass, the run proceeds to
EVALUATE. On fail, `on_fail` routes to the Debug step and the iteration
counter increments.

**DEBUG** (`produce`, the failure path of VALIDATION_GATE) — Runs only on
gate failure. The Debugger reads run artifacts from `.sle/runs/{id}/` and
produces a `FailureReport` with root causes. If it cannot diagnose, the
gate's raw report is passed to the Planner as-is. The run then loops back to
PLAN.

**EVALUATE** (`produce`) — The Evaluator produces `evaluation.md` — a
structured verdict on whether the implementation satisfied the original
intent. This document feeds into the next run's context.

**SUMMARISE** (`produce`) — Produces three artifacts:
`reports/validation-latest.html`, `scripts/run-tests.ts`, and
`reports/changelog-{version}.md`. Also generates a user-facing summary with
what was built, what changed, and how to test.

**SNAPSHOT** (`commit`, `logs_decision: true`) — The terminal step. Assigns
a `version_id`, commits artifacts to the docs and code remotes, releases the
run's artifact claims, appends a `decisions.md` entry, and sets the run's
`status → complete`.

---

## Monitoring progress

### Using `sle status`

```
$ sle status full-build-5-i1-20260502T143000Z
Run:         full-build-5-i1-20260502T143000Z
Workflow:    full-build
Status:      active
Iteration:   1 / 3
Revision:    0
Current:     build
Depth:       standard
Awaiting:    (none)
Started:     2026-05-02T14:30:00Z (12m ago)
```

The `current` field tells you which step is executing. The `iteration`
field shows how many times the BUILD → EXEC → VALIDATION_GATE loop has run.

### WebSocket events for real-time monitoring

Connect to `ws://localhost:7700/events` to receive push events as the run
progresses. Key events for workflow-run monitoring (reference/websocket-events.md):

| Event | When emitted |
|---|---|
| `workflow_run.started` | A new workflow run begins |
| `step.started` | A step begins execution |
| `step.completed` | A step finishes execution (with duration) |
| `gate.result` | VALIDATION_GATE passes or fails |
| `workflow_run.checkpoint_requested` | A checkpoint step pauses the run, awaiting input |
| `workflow_run.checkpoint_cleared` | A checkpoint is cleared (approved, revised, or rejected) |
| `workflow_run.committed` | A `commit` step locks a new version |
| `workflow_run.completed` | Workflow run finishes successfully |
| `workflow_run.halted` | Workflow run halted (cap hit, error, or user action) |
| `workflow_run.iteration_started` | A new iteration begins within the run |
| `approval.required` | A gate requires human approval before proceeding |

Example `step.started` event:

```
{
  "run_id": "full-build-5-i1-20260502T143000Z",
  "step_id": "build",
  "iteration": 1,
  "revision": 0,
  "timestamp": "2026-05-02T14:35:00Z"
}
```

Events are fire-and-forget. If you disconnect, call `GET /api/v2/system/state`
on reconnect to synchronise, then `GET /api/v2/workflow-runs/{run_id}` for
per-run detail. The full event catalogue is in
§reference/websocket-events.md.

### Reading run logs

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

The step execution history is recorded in `map.yaml →
workflow_runs.{run_id}.steps_completed` (an ordered list of step ids), with
detailed enter/exit/error/skip events in the run's `manifest.json`.

---

## Pausing and halting

### Graceful halt with `sle halt`

```
$ sle halt full-build-5-i1-20260502T143000Z
```

This sends `POST /api/v2/workflow-runs/{run_id}/halt` and transitions that
run's `status`: `active` → `halted`. The daemon writes a partial report and
preserves run artifacts. Other active runs are unaffected.

Halt is a soft stop. It completes the current step, writes the partial
report, and transitions to `halted`. The run's context is preserved — resume
with `sle resume {run_id}`.

Halt only works when the run's `status = active`. If the run is not active,
the daemon returns 409 `halt_not_active`.

### Awaiting confirmation

When a run reaches the CONFIRM checkpoint, it sets
`WorkflowRun.awaiting_checkpoint` to this step's id. The run's `status`
remains `active` — this is a pointer-based pause, not a status change. The
Facilitator operates in decision mode.

At the CONFIRM checkpoint you can:

- **Approve** — `POST /api/v2/workflow-runs/{run_id}/approve`.
  Clears the checkpoint pointer and proceeds to BUILD.
- **Modify plan steps** — `POST /api/v2/workflow-runs/{run_id}/revise` with a
  plan-modification payload. Increments the revision counter and re-runs the
  TEST step for affected categories.
- **Modify test criteria** — Same endpoint, but with `test_criteria` changes
  only. No TEST re-run — criteria are updated and CONFIRM re-presents.
- **Halt** — Halts the run.

```
curl -X POST http://localhost:7700/api/v2/workflow-runs/{run_id}/revise \
  -d '{"steps": {"remove": [{"step_id": "step_003", "reason": "..."}], "add": [{"description": "Add input sanitisation after auth check", "after_step": "step_002", "constraints": []}]}}'
```

Multiple revision rounds are allowed within one iteration. The revision counter
is visible in the CONFIRM prompt. The iteration counter does not increment on
revisions — only on VALIDATION_GATE failure.

### Awaiting sharding approval

When the Planner produces a sharding proposal during the intake sub-phase,
the run sets `awaiting_checkpoint` to the SHARDING_APPROVAL step's id and
pauses there. You review the proposed task boundaries, context
declarations, and dependencies.

Actions:

- **Approve** — `POST /api/v2/workflow-runs/{run_id}/sharding/approve`. Creates
  Beads tasks, updates the link index, and proceeds to CONFIRM.
- **Reject** — `POST /api/v2/workflow-runs/{run_id}/sharding/reject`. Proceeds to
  CONFIRM without sharding. The Planner re-plans without a split.
- **Modify** — `POST /api/v2/workflow-runs/{run_id}/sharding/modify` with task-level
  edits (add, remove, edit). Re-presents the revised proposal.

`awaiting_checkpoint` can only point at one step at a time, by construction
— the system never prompts for sharding approval and plan confirmation
concurrently.

### Halt vs force-stop

| Action | Command | Effect |
|---|---|---|
| Graceful halt | `sle halt {run_id}` | Completes current step, writes partial report, transitions to `halted` |
| Resume after halt | `sle resume {run_id}` | Returns to `active`, preserves iteration count and context |
| Acknowledge halt | Acknowledge the halt report | Run stays `halted` as a historical record; you start a new run when ready |

There is no "kill" command. If the daemon process crashes, `map.yaml` preserves
the last committed state. On restart, the daemon restores from `map.yaml` —
for every `workflow_runs` entry with `status: active`: if `awaiting_checkpoint`
is set, the daemon re-enters decision mode at that checkpoint; otherwise it
resumes from `current_step_id`.

---

## Reviewing results

### Workflow-run output

A completed `full-build` run produces these artifacts:

| Artifact | Produced by | Location |
|---|---|---|
| `architecture.md` | Designer | `.sle/project-docs/` |
| `requirements.md` | Designer | `.sle/project-docs/` |
| `plan.md` / `test-plan.md` | Planner | `.sle/project-docs/` |
| Test scripts | Tester / Builder | `scripts/test_{category}.ts` |
| Implementation | Builder | Project source tree |
| `decisions.md` entry | Historian (via SNAPSHOT's `logs_decision`) | `.sle/project-docs/` (appended) |
| `evaluation.md` | Evaluator | `.sle/project-docs/` |
| Validation report | SUMMARISE | `reports/validation-latest.html` |
| Changelog | SUMMARISE | `reports/changelog-{version}.md` |

Read any artifact via `GET /api/v2/artifacts/{id}`, or diff against a previous
version with `GET /api/v2/artifacts/{id}/diff?from_version={version}`.

### Evaluation verdict

The EVALUATE step writes `evaluation.md` with a structured verdict:

- **satisfied** — Implementation meets the intent.
- **partially satisfied** — Some requirements met, others deferred.
- **not satisfied** — Core intent unmet.

Each requirement is assessed with evidence. The evaluation includes
recommendations for the next run. Retrieve reports with
`GET /api/v2/reports/latest` or `GET /api/v2/reports/{run_id}`.

### Critique output

When CRITIQUE runs (`deep`/`research` depth), the Critic produces a
`CritiqueResult` with three tiers:

- **blocking_issues** — Must be resolved before the run proceeds.
- **warnings** — Noted but non-blocking.
- **suggestions** — Advisory improvements.

At `deep`/`research` depth, the Critic also writes `doc:critique-report` — a
persistent design review note stored alongside project documents. This report
carries forward to future runs as context.

---

## Sequencing multiple workflow runs

### Sequential runs

Each run builds on the output of the previous one. After SNAPSHOT completes,
that run's `status` is `complete` and you can immediately start a new run —
no project-wide gate blocks it:

```
$ sle run full-build "Add IP-based rate limiting on top of the auth middleware"
```

The second run's SCOPING step group reads the first run's `architecture.md`,
`requirements.md`, `decisions.md` (last 3 entries), and `evaluation.md`.
This is how context carries forward across runs.

`#next-run` tags persist across runs — untouched tags remain for future use.
Scope drafts are also reusable: if you deferred ideas in a previous scope
draft, you can start a new run with `sle run full-build --scope
<same-draft-id>` and the Facilitator will use the deferred section as a
starting point.

### Concurrent runs

Unlike the old single-cycle model, you are not limited to one run at a time.
Two `full-build` runs against unrelated groups, or a `full-build` run
alongside a `draft-artifact` run, may both be `active` simultaneously —
the daemon only blocks a new run when it would claim an artifact already
held by another active run (`claim_conflict`, DDR-031). Use `GET
/api/v2/workflow-runs?status=active` to see everything in flight.

### How context carries forward

| Artifact | How it persists |
|---|---|
| `architecture.md` | Designer reads and revises (not rewrites from scratch) |
| `requirements.md` | Designer extends with new requirements |
| `decisions.md` | Append-only — all entries from all workflow runs are preserved |
| `evaluation.md` | Evaluator reads prior evaluation; Planner reads it too |
| `plan.md` | Fresh each run — the Planner writes a new plan |
| `test-plan.md` | Fresh each run |
| Version snapshots | Locked in `map.yaml` under `versions[]` |
| `CHANGELOG.md` | Cumulative — each run's SUMMARISE step appends entries |

The `version_bump` for each run can be set explicitly via `--bump` or is
inferred during SCOPING based on the scope's impact. Multiple sequential patch
runs accumulate into the CHANGELOG under a single version if no bump override
is provided.

### When to start fresh vs continue

**Continue** (sequential runs) when:

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

**`claim_conflict` (409)** — You tried to start a run whose target artifacts
are already claimed by a different active run. Check active runs with `GET
/api/v2/workflow-runs?status=active`. Wait for the conflicting run to
complete or halt it first.

**`discovery_required` (403)** — No discovery artifacts exist and `--force` was
not set. Run `sle discover` first, or use `sle run full-build "goal" --force`.

**`halt_not_active` (409)** — You tried to halt a run that is not `active`.
This can happen if the run already completed or was halted by a previous
command.

**`not_awaiting_checkpoint` (409)** — You tried to approve or revise when
the CONFIRM checkpoint is not this run's current pause point. The run may
have already moved past CONFIRM, or the checkpoint is not enabled in your
configuration.

**`agent_timeout`** — An LLM call exceeded the timeout. The daemon retries once
and then halts. Resume with `sle resume {run_id}` after the issue resolves.

**`docker_unavailable`** — EXEC requires Docker but the Docker daemon is not
running. Start Docker and resume.

**`scoping_timeout`** — SCOPING's checkpoint max rounds were exceeded and the
run halts. Increase `planning.yaml → scoping.max_rounds` or simplify the
scope. Restart with `sle run full-build` after adjusting.

**`charter_validation_failed`** — SCOPING could not produce a valid
`doc:cycle-charter`. Ensure your scope and purpose are clearly defined. For
quick starts, provide a more specific goal string.

### Stuck in a state

If the daemon crashes or you lose connectivity, run state is preserved in
`map.yaml`. On daemon restart, for every `workflow_runs` entry with
`status: active`:

- If `awaiting_checkpoint` is set, the daemon re-enters decision mode at
  that checkpoint.
- If `awaiting_checkpoint` is `null`, the daemon resumes from
  `current_step_id`.
- Entries with `status: halted` stay halted until you acknowledge or resume
  them individually.

To manually transition the project-wide state (use with caution), send
`POST /api/v2/system/state/transition`. The daemon validates the transition
against the transition table — invalid transitions return 409 with allowed
targets.

### Workflow run fails validation

When the VALIDATION_GATE fails, the Debug step produces a `FailureReport`.
Check the run state with `GET /api/v2/workflow-runs/{run_id}` and look at
the `failed_categories` field for which categories failed. For each failed
category, check the run artifacts in `.sle/runs/{run_id}/`:

- `tests/{category}/result.json` — Detailed pass/fail per test case.
- `ai/context-pack.md` — The context the Debugger used for diagnosis.

If the iteration cap is reached, the daemon halts and writes a partial report
with a cap-exceeded notice. The cap behavior is configured in
`exit.yaml → on_cap_hit`:

| Behavior | Effect |
|---|---|
| `halt_with_report` | Halt with partial report (default) |
| `user_prompt` | Pause and ask you to continue or halt |
| `force_pass` | Commit despite failures |

### Iteration and revision counters

If progress seems stuck, check both counters:

- **Iteration** — Increments on VALIDATION_GATE failure only. Resets per
  workflow run. The loop is: PLAN → TEST → CONFIRM → BUILD → EXEC →
  VALIDATION_GATE → (fail) → DEBUG → PLAN.
- **Revision** — Increments on CONFIRM checkpoint modification only. Resets
  per iteration. Multiple revisions are allowed within one iteration without
  touching the iteration counter.

If both are incrementing but the run is not converging, the
`FailureReport` may indicate a structural problem. In rare cases, the Debug
step flags a blocking issue as `structural`, which causes the iteration loop
to extend back to DESIGN instead of PLAN. This escalation is automatic — the
Designer receives the Debugger's structural diagnosis alongside the normal
report.

### Viewing dispatch progress

During the EXEC step, you can monitor per-category progress:

```
GET /api/v2/workflow-runs/{run_id}/dispatch
```

This returns the dispatch status including `category_progress` — a map of each
category to its sub-phase status (`pending | running | completed | failed |
skipped`). Use this to see which categories have passed `static-check` and are
proceeding to `llm-check` and `exec-check`.
