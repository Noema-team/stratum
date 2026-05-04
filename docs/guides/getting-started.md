# Getting Started

**Type:** guide · **Updated:** 2026-05-02
**Source:** SLE-009 (daemon interfaces), specs/init-and-discovery, specs/dag-execution

This guide walks you through installing SLE, initializing a project, running
discovery, and completing your first development cycle. By the end you will
understand the core workflow: `sle init` → `sle discover` → (discuss scope with Facilitator) → `sle start`.

---

## Prerequisites

Before you begin, make sure you have:

- **Node.js 20 or later** — SLE requires the modern V8 runtime. Check with
  `node --version`.
- **Git** — every SLE project lives inside a git repository with a configured
  `origin` remote. Verify with `git remote -v`.
- **An LLM API key** — SLE uses a large language model under the hood. Set
  `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` in your shell environment. The
  default provider is OpenAI (`gpt-4o`).
- **A codebase to work on** — clone or create a repository, then `cd` into its
  root directory.

Optional but recommended:

- **Dolt** — if you plan to use the Beads task store for cross-device issue
  tracking, install the `dolt` CLI and authenticate with DoltHub.
- **Docker** — the EXEC node runs validation scripts inside containers. Without
  Docker, EXEC falls back to local script execution.

> The daemon binds to `localhost` only on port 7700. There is no
> authentication layer — it is designed for single-user local development.
> Remote access requires an SSH tunnel or reverse proxy.

---

## Installation

Install the SLE CLI globally:

```bash
npm install -g @sle/cli
```

Verify the installation:

```bash
sle --version
# 0.1.0
```

The `sle` binary provides all user-facing commands: `init`, `discover`, `start`,
`status`, `halt`, `resume`, `chat`, and `daemon`. Additional subcommands are
covered in their respective guides.

---

## Initializing a project

Run `sle init` from the root of your git repository. The command performs a
one-time setup that creates the `.sle/` directory, generates rule files,
initializes the task store, and starts the daemon.

```bash
cd my-project
sle init
```

### What `sle init` does

The init sequence runs through ten steps (see init-and-discovery.md §Step
sequence). Here is what happens at each stage:

**Step 0 — Prerequisites.** SLE checks that you are inside a git repo with an
`origin` remote, that Node.js 20+ is available, and that `.sle/` does not
already exist. If any check fails, init exits immediately with a specific
error code.

**Step 1 — Project identity.** SLE infers the project name from your `origin`
URL (for example, `git@github.com:org/my-project.git` becomes `my-project`).
You can edit it. A short description is required.

**Step 2 — Project type.** Choose from `api`, `ui`, `library`, `research`, or
`custom`. This sets default validation categories, planning depth, and the
artifact set. For example, `api` projects default to `correctness`,
`performance`, and `security` checks (init-and-discovery.md §Project type
defaults).

**Step 3 — Remote configuration.** SLE detects your code remote from `git
remote get-url origin`. Then you choose a task store provider:

| Provider | Storage | Sync | Requires |
|---|---|---|---|
| `beads` | `.beads/` (Dolt database) | Cross-device via DoltHub | DoltHub account, `bd` CLI |
| `local` | `.sle/tasks.yaml` | None | Nothing |

Choose `local` for a quick start. You can always reinitialize later.

Finally, SLE suggests a docs remote URL (your code remote with a `.server`
suffix). If the remote is unavailable, init records it as `pending` and
continues.

**Step 4 — Rule file generation.** SLE generates seven rule files in
`.sle/rules/`:

```
planning.yaml
validation.yaml
artifacts.yaml
exit.yaml
user_validation.yaml
summary.yaml
agents.yaml
```

These are plain YAML files that you can edit after init. SLE never overwrites
them. The `agents.yaml` file configures all ten agent roles with sensible
defaults — for instance, Explorer is disabled by default and Critic only
activates for deep/research planning depth (init-and-discovery.md §agents.yaml
defaults).

**Step 5 — Task store initialization.** For `local`, SLE writes
`.sle/tasks.yaml` with an empty task list. For `beads`, it runs `bd init` and
configures the DoltHub remote.

**Step 6 — Docs remote clone.** SLE clones the docs remote into `.server/` and
creates a `docs` symlink pointing to `.server/docs`.

**Step 7 — agent.md and map.yaml.** Two core files are generated:

- `agent.md` — a human-readable project manifest. Written once, never touched
  by the system again.
- `.sle/map.yaml` — the machine-readable runtime state. Regenerated after every
  cycle. Contains project metadata, remotes, agent configuration, discovery
  state, and cycle history.

Both files open in your `$EDITOR` if that variable is set.

**Step 8 — Prompt templates.** SLE installs ten role prompt templates in
`.sle/prompts/` plus validation check prompts filtered by your project type.

**Step 9 — Initial commit.** SLE stages `.sle/` and `agent.md`, commits with
the message `chore: initialise SLE project`, and pushes to `origin`. A push
failure is non-fatal — your local state is valid.

**Step 10 — Daemon start.** SLE starts the daemon on port 7700 and runs a
startup validation check (see below).

### Non-interactive init (CI)

For scripted environments, pass all values as flags:

```bash
sle init \
  --name "my-project" \
  --description "REST API for item management" \
  --type api \
  --code-remote git@github.com:org/my-project.git \
  --issues-remote dolthub://org/my-project-issues \
  --docs-remote git@github.com:org/my-project.server.git \
  --prefix mp \
  --task-store local \
  --no-editor \
  --no-daemon
```

### Resuming a failed init

If init fails partway through, state is saved to `.sle/init-state.json`. Run:

```bash
sle init --resume
```

SLE re-enters at the last successful step, re-runs idempotent steps, and skips
side-effect steps that already completed. See init-and-discovery.md §Resume
behaviour for the full resume logic.

### Files created

A successful init produces this structure:

```
project-root/
  agent.md                          project manifest
  docs → .server/docs               symlink to docs remote
  .sle/
    map.yaml                        runtime state
    daemon.pid                       daemon process ID
    tasks.yaml                      task store (local mode only)
    rules/                          7 rule files
    prompts/                        10 role prompts + validation checks
    lib/                            test-runner.ts, bench-runner.ts
  .server/                          docs remote clone
```

---

## Starting the daemon

If you used `--no-daemon` during init, or if the daemon stopped, start it
manually:

```bash
sle daemon start
```

The daemon starts on port 7700 and runs a startup validation sequence (see
daemon-api.md §Startup sequence):

1. Parse CLI flags.
2. Load and validate `map.yaml`.
3. Validate all seven rule files in `.sle/rules/`.
4. Verify `agent.md` exists and its `map:` reference resolves.
5. Check required artifacts exist or are marked as not-yet-generated.
6. Verify task store is reachable (Beads remote or local `.sle/tasks.yaml`).
7. Verify docs remote is reachable (or `pending: true`).
8. Restore state — if `meta.status` was `cycling`, resume from the last DAG
   node. If `halted`, stay halted. If `idle` or `complete`, transition to
   `idle`.
9. Bind HTTP and WebSocket servers on port 7700.
10. Emit `system.ready` event.

If any validation check fails, the daemon exits with a descriptive error. It
never starts in a degraded state.

### Health check

Confirm the daemon is running:

```bash
curl http://localhost:7700/health
```

Expected response:

```json
{
  "ok": true,
  "data": {
    "status": "healthy",
    "version": "0.1.0",
    "uptime_ms": 3420
  }
}
```

### WebSocket events

The daemon pushes real-time events over WebSocket at `ws://localhost:7700/events`.
Connect with any WebSocket client to receive lifecycle updates, DAG node
transitions, validation results, and gate decisions. See daemon-api.md §WebSocket
lifecycle for the connection protocol.

---

## Running discovery

Before your first development cycle, SLE requires a discovery phase. Discovery
produces foundational documents — product brief, constraints, vision, project
plan — that give the agent roles the context they need to produce useful output.

The daemon enforces this guard: it rejects `POST /api/v2/cycles` until
`map.yaml → discovery.status` is `complete`, unless you pass `--force` (see
state-machine.md §Discovery guard).

### Starting discovery

```bash
sle discover
```

This begins an interactive, multi-round conversation with the Facilitator
agent. The Facilitator asks questions, you answer, and after each round it
produces a discovery artifact for your approval.

### Full mode flow

Full mode runs four rounds, a synthesis step, and a planning loop:

| Round | Artifact produced | Opening question topic |
|---|---|---|
| 1 | `docs/product-brief.md` | What are you building? |
| 2 | `docs/success-definition.md` | What does success/failure look like? |
| 3 | `docs/constraints.md` | What is out of scope? Hard constraints? |
| 4 | `docs/stakeholders.md` | Who is involved? Decision-making? |

After all four rounds, the Facilitator produces three synthesis artifacts:
`docs/system-description.md`, `docs/vision.md`, and `docs/open-questions.md`.
Any unresolved items are surfaced for you to resolve or defer.

Finally, the planning loop produces `docs/project-plan.md` with phases, exit
criteria, tasks, and dependencies. You can reorder, merge, or split phases
before approving.

### Solo mode

For solo projects, use `--solo` to collapse the flow to two rounds:

```bash
sle discover --solo
```

Solo mode merges success definition into the product brief and skips the
stakeholders document. You can upgrade to full mode later with
`sle discover --revisit` (without `--solo`).

### Injecting an existing document

If you already have a product brief or similar document:

```bash
sle discover --from brief.md
```

The Facilitator reads it as a starting point for Round 1, then asks follow-up
questions to fill gaps.

### What happens at the end

Once the plan is approved, discovery finalization:

1. Creates tasks for Phase 1 in your task store.
2. Blocks later-phase tasks on prior phase completion.
3. Sets `map.yaml → discovery.status` to `complete`.
4. Updates `agent.md` with discovery references.
5. Deletes `.sle/discovery-session.json`.

The system transitions from `discovering` to `idle` and is ready for its first
cycle.

---

## Your first cycle

With discovery complete, you have two ways to start a development cycle. The
recommended flow is to discuss scope with the Facilitator first:

1. Open a chat session and describe what you want to build:
   ```bash
   sle chat
   ```
   The Facilitator helps you identify relevant nodes, tag them with
   `#next-cycle`, and draft a scope document.

2. Start the cycle with the scope draft:
   ```bash
   sle start --scope my-draft-id
   ```

For a quick start, you can pass a goal string directly and SLE will create a
scope draft automatically:

```bash
sle start "Add rate limiting to the API"
# or with a pre-created scope draft:
sle start --scope my-draft-id
```

Either form triggers transition T3 in the state machine (state-machine.md
§Transition table): `idle` → `cycling`. The daemon creates a cycle record, sets
the iteration counter to 1, and begins walking the DAG — starting with the
SCOPING node.

### The DAG at a glance

A cycle walks through a series of 15 DAG nodes (dag-execution.md §DAG flow
diagram). On the happy path — no conditionals triggered — the sequence is:

```
SCOPING → DESIGN → PLAN → TEST → CONFIRM → BUILD → HISTORY → EXEC
→ VALIDATION_GATE → EVALUATE → SUMMARISE → SNAPSHOT
```

Here is what each node does:

**SCOPING.** The Facilitator guides you through a structured discussion.
Together you define the cycle's scope, purpose, requirements, and boundaries.
This produces a cycle-charter document that feeds into the rest of the DAG.
If you started with `sle start --scope`, the existing draft is refined; if you
passed a goal string, the Facilitator generates the charter from scratch.

**DESIGN.** The Designer agent receives the cycle-charter from SCOPING and
produces `architecture.md` and `requirements.md`. These are the canonical
design artifacts — only the Designer writes them (DDR-019).

**CRITIQUE** (conditional). Only runs at deep or research planning depth. The
Critic reviews the Designer's output for blind spots. Blocking issues trigger a
Designer revision loop. Non-blocking issues are noted for the Planner.

**PLAN.** The Planner agent produces `plan.md` and `test-plan.md`. At deep or
research depth it also produces `build-plan.md`. If the Planner identifies work
that should be sharded, it produces a sharding proposal.

**TEST.** The Tester agent writes test scripts from requirements only. It never
sees the architecture or the implementation — this is the TDD separation
constraint (dag-execution.md §TDD separation).

**SHARDING_APPROVAL** (conditional). Only if the Planner produced a sharding
proposal. The cycle pauses, `cycle.awaiting_sharding_approval` is set to
`true`, and the Facilitator presents the proposal for your approval, rejection,
or modification.

**CONFIRM.** The cycle pauses before building. The flag
`cycle.awaiting_confirmation` is set to `true`. The Facilitator presents the
plan and test coverage for your review. You can approve, modify plan steps, or
halt. Modifying the plan increments the revision counter and loops back through
TEST.

**BUILD.** The Builder agent produces the implementation plus instrumented test
scripts. The Builder never sees the Tester's internal reasoning — only the
final test scripts as a contract to satisfy.

**HISTORY.** The Historian agent appends an entry to `decisions.md`. This file
is append-only and preserved across all iterations and cycles.

**EXEC.** The validation fan-out. For each validation category (for example,
`correctness`, `performance`, `security`), EXEC runs three sub-phases in
sequence: static-check, llm-check, exec-check. A static-check failure skips
the remaining sub-phases for that category. All categories run in parallel.

**VALIDATION_GATE.** A deterministic gate — no LLM, no user input. Passes if
all category results are green. Fails if any category reports errors.

- **Pass** → EVALUATE → SUMMARISE → SNAPSHOT → cycle complete.
- **Fail** → DEBUG → iteration increments → back to PLAN (or DESIGN on
  structural failure).

**DEBUG.** The Debugger agent reads run artifacts and failed category slices,
then produces a FailureReport with root causes. Only activates on validation
failure.

**EVALUATE.** The Evaluator checks whether the implementation actually
satisfies the original intent.

**SUMMARISE.** Produces a user-facing summary of what was built, changed, and
tested.

**SNAPSHOT.** Locks the version, commits artifacts, increments the version ID.
The cycle transitions `cycling` → `complete` → `idle`.

### Monitoring with sle status

While a cycle is running, check progress from another terminal:

```bash
sle status
```

Sample output:

```
State:      cycling
Cycle:      c-20260502-001
Iteration:  1 / 3
Revision:   0
Current:    BUILD
Started:    2026-05-02T14:32:00Z
```

For machine-readable output, query the REST API directly:

```bash
curl http://localhost:7700/api/v2/system/state
```

Response:

```json
{
  "ok": true,
  "data": {
    "state": "cycling",
    "active_cycle_id": "c-20260502-001",
    "discovery_status": "complete",
    "iteration": 1,
    "revision": 0,
    "awaiting_confirmation": false,
    "awaiting_sharding_approval": false,
    "chat": {
      "session_open": false
    }
  }
}
```

### What happens on validation failure

If the VALIDATION_GATE node fails, the system does not halt immediately. It
runs the DEBUG node to diagnose the failure, then loops back to PLAN for
another iteration. The Planner receives the FailureReport alongside only the
failed category slices — passing categories are cached and not re-tested.

This iteration loop continues until either the gate passes or the iteration cap
is reached. The cap is configured in `planning.yaml → max_iterations` and
defaults to 3. When the cap is hit, the behavior depends on
`exit.yaml → on_cap_hit`:

| Behavior | Effect |
|---|---|
| `halt_with_report` | Halt with a partial report. No snapshot. |
| `user_prompt` | Pause and ask whether to continue or halt. |
| `force_pass` | Lock the snapshot despite failures. Not recommended. |

### The CONFIRM gate in practice

When the CONFIRM gate is reached, the daemon pauses execution and waits for
your decision. You see a summary of the plan and test coverage:

```bash
sle status
```

```
State:      cycling
Cycle:      c-20260502-001
Iteration:  1 / 3
Revision:   0
Awaiting:   confirmation

Plan summary:
  5 build steps
  12 test cases
  87% requirement coverage
```

Your options at the CONFIRM gate:

- **Approve** — execution proceeds to BUILD.
- **Modify plan steps** — revision counter increments, TEST re-runs for
  affected categories, then CONFIRM re-presents the updated plan.
- **Modify test criteria** — update acceptance criteria without re-running
  TEST, then CONFIRM re-presents.
- **Halt** — the cycle halts with a partial report.

You can respond via the REST API or the WebSocket:

```bash
curl -X POST http://localhost:7700/api/v2/cycles/{cycle_id}/approve
```

### Halting and resuming

To stop a cycle at any point:

```bash
sle halt
```

This transitions `cycling` → `halted`. The daemon writes a partial report,
preserves all artifacts, and waits for your acknowledgement.

To resume from a halted state:

```bash
sle resume
```

This transitions `halted` → `cycling` (transition T12). The iteration count is
preserved, and the cycle picks up where it left off.

> The daemon recovers from crashes automatically. On restart, if `map.yaml →
> meta.status` is `cycling`, it resumes from the last committed DAG node. If
> an awaiting flag was set, it re-enters decision mode at the correct gate.
> No data is lost (daemon-api.md §Crash recovery).

---

## Understanding the output

After a cycle completes, the project contains new and updated files. Here is
where to find everything.

### Artifacts directory

Cycle artifacts are organized under `.sle/` and the project root:

```
project-root/
  docs/
    product-brief.md           (from discovery)
    constraints.md             (from discovery)
    vision.md                  (from discovery)
    project-plan.md            (from discovery)
    open-questions.md          (from discovery)
  .sle/
    map.yaml                   (updated after every cycle)
    runs/
      {cycle-id}/
        manifest.json          (run manifest)
        ai/
          context-pack.md      (assembled context for agents)
        tests/
          correctness/
            result.json        (test results per category)
          performance/
            result.json
          security/
            result.json
        metrics/               (performance metrics)
        logs/                  (execution logs)
```

### map.yaml — your project's living map

`map.yaml` is the single source of truth for project state. It is updated
atomically after every state change — the daemon writes to a temp file and
renames, so it is never in a partial state (daemon-api.md §Atomic map.yaml
writes).

Key sections after a completed cycle:

```yaml
meta:
  status: idle
  cycle: 3
  version_id: v0.3.0

project:
  name: my-project
  type: api

discovery:
  status: complete
  mode: full
  completed_at: "2026-05-02T12:00:00Z"
  current_phase: 1
  total_phases: 4

cycle:
  iteration: 1
  revision: 0
```

The `meta.version_id` increments with each successful snapshot. The
`meta.cycle` count tracks total completed cycles across the project lifetime.

### Reading the cycle log

The DAG event history is recorded in `map.yaml → cycle.dag.history`. Each
entry captures the node, event type, and timestamp:

```json
[
  { "node": "SCOPING", "type": "enter", "timestamp": "2026-05-02T14:32:00Z" },
  { "node": "SCOPING", "type": "exit", "timestamp": "2026-05-02T14:32:02Z" },
  { "node": "DESIGN", "type": "enter", "timestamp": "2026-05-02T14:32:03Z" },
  { "node": "DESIGN", "type": "exit", "timestamp": "2026-05-02T14:33:15Z" },
  { "node": "PLAN", "type": "enter", "timestamp": "2026-05-02T14:33:15Z" },
  { "node": "PLAN", "type": "exit", "timestamp": "2026-05-02T14:34:40Z" }
]
```

This history is the complete execution trace of the cycle. It is not pruned
within a cycle. For a high-level view, use `sle status` or the REST API.

### The decisions log

`decisions.md` is an append-only record of architectural and planning decisions
made across all cycles. The Historian agent adds entries at the HISTORY node.
Entries from failed iterations and halted cycles are preserved — nothing is
deleted.

---

## System state reference

The SLE state machine has five states (state-machine.md §System state):

| State | Meaning |
|---|---|
| `idle` | No active session or cycle. Ready for commands. |
| `discovering` | A discovery session is in progress. |
| `cycling` | A development cycle is running through the DAG. |
| `halted` | A cycle was paused or hit the iteration cap. Awaiting user action. |
| `complete` | A cycle finished successfully. Snapshot locked. About to transition to `idle`. |

Transitions are atomic and enforced by the daemon. Only one session or cycle
may be active at a time. The `idle` state is the gateway — the system must
return to `idle` before starting a new discovery session or cycle.

Two boolean flags on the cycle record — `awaiting_confirmation` and
`awaiting_sharding_approval` — create pause points within the `cycling` state
without changing the machine state. At most one flag is `true` at a time.

Chat is an orthogonal layer. You can open a chat session in any state via
`sle chat`, and it never blocks or affects state transitions.

---

## Common workflows

### Quick prototype (skip discovery)

If you want to skip discovery and jump straight into a cycle:

```bash
sle start "Prototype the auth flow" --force
# or with a pre-created scope draft:
sle start --scope my-draft-id --force
```

The `--force` flag bypasses the discovery guard (transition T11 in
state-machine.md §Transition table). The cycle runs without discovery artifacts
in context, which may reduce output quality. Useful for experimentation.

### Multiple iterations

A single cycle may run multiple iterations before the VALIDATION_GATE passes.
Each iteration is a full PLAN → TEST → CONFIRM → BUILD → HISTORY → EXEC →
VALIDATION_GATE arc. The iteration cap in `planning.yaml` limits retries.

To monitor iteration progress:

```bash
sle status
```

The output shows the current iteration against the cap:

```
State:      cycling
Iteration:  2 / 3
```

### Revisiting discovery

After completing a phase, you may want to revise your project plan or
constraints:

```bash
sle discover --revisit
```

Each round offers three options: keep the existing document, revise it with
targeted questions, or rewrite from scratch. Only modified documents trigger
re-synthesis.

To re-plan remaining phases after completing a phase:

```bash
sle discover --replan
```

The Facilitator reads completed phase outcomes and proposes revisions to future
phases only. Completed phases are never modified (init-and-discovery.md
§Completed phases are immutable).

---

## Configuring the LLM provider

The default provider is OpenAI (`gpt-4o`), configured in `.sle/rules/agents.yaml`.
To switch to Anthropic:

```yaml
llm:
  provider: anthropic
  model: claude-sonnet-4-20250514
  api_key_env: ANTHROPIC_API_KEY
```

Set the environment variable before starting the daemon:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
sle daemon start
```

> SLE does not validate LLM key reachability at init time (init-and-discovery.md
> §ID-009). An invalid key surfaces as an agent error when the first LLM call
> is made during discovery or a cycle.

---

## Resetting a project

To completely reinitialize SLE:

```bash
sle init --reset
```

This removes `.sle/`, `.beads/`, `.server/`, the `docs` symlink, and
`agent.md`. Remote data on DoltHub or the docs git remote is never deleted.
You are prompted to type the project name to confirm.

---

## Troubleshooting

### Daemon will not start

Check the error code:

| Code | Cause | Fix |
|---|---|---|
| E003 | Port 7700 in use | Kill the existing process or use `--port` |
| E010 | Rule file invalid | Check YAML syntax in `.sle/rules/` |
| E011 | Required artifact missing | Run `sle discover` or check `artifacts.yaml` |

### Cycle rejected with `discovery_required`

Run `sle discover` first, or use `--force` to bypass. The guard exists because
agent roles produce better output when they have discovery context. See
state-machine.md §Discovery guard.

### Init fails mid-sequence

State is saved to `.sle/init-state.json`. Resume with:

```bash
sle init --resume
```

See init-and-discovery.md §Resume behaviour for which steps re-run and which
are skipped.

### Push failure at step 9

Non-fatal. Your local state is valid. Push manually:

```bash
git push origin main
```

### WebSocket events not received

The daemon uses fire-and-forget delivery (daemon-api.md §WebSocket
fire-and-forget). Events are not re-sent after a disconnect. On reconnect, call
`GET /api/v2/system/state` to synchronize, then resume listening for new
events.

---

## Next steps

- **[running-a-cycle.md](running-a-cycle.md)** — deeper control over cycles:
  category hints, intake modes, planning depth overrides, and sharding.
- **[configuring-validation.md](configuring-validation.md)** — customizing
  validation categories, adding custom check scripts, and tuning gate
  behavior.
- **[extending-with-modules.md](extending-with-modules.md)** — adding layer
  processors, custom agent roles, and third-party integrations.
