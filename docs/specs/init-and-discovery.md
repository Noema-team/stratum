# Init and Discovery

**Type:** spec · **Status:** draft · **Updated:** 2026-04-22
**Depends on:** DDR-024, DDR-019, DDR-022, DDR-023
**Source material:** SLE-009 (init sequence), SLE-011 (project discovery), init-specs/07-init-state.md

## Overview

This spec covers two CLI commands that run before any development cycle:

- **`sle init`** — one-time project setup. Creates `.sle/`, generates rule files,
  initialises the task store, clones the docs remote, produces `agent.md` and
  `map.yaml`, and starts the daemon. Runs exactly once per project.

- **`sle discover`** — guided discovery that produces foundational documents
  (product brief, constraints, vision, project plan, etc.) before the first
  development cycle. Uses the Facilitator role in a multi-round interactive
  conversation with the user.

Together they form the onboarding path: `sle init` → `sle discover` → `sle start`.

The daemon refuses cycle start (`POST /cycle/start`) until `map.yaml → discovery.status`
is `complete`, unless the caller passes `skip_discovery: true`.

### Key decisions reflected

| Decision | What it changes |
|---|---|
| G28 | Init creates artifact scaffolding and agent configuration for all 10 roles |
| DDR-024 | User chooses TaskStore provider (Beads or local `.sle/tasks.yaml`) at init |
| DDR-019 | Designer/Planner split reflected in agents.yaml defaults |
| DDR-022 | Critic runs at DESIGN node, reflected in agents.yaml defaults |
| DDR-023 | Explorer is user-initiated only, `active: false` by default |

---

## Data model

### InitState

Tracks partial progress during `sle init`. Written to `.sle/init-state.json` on
every step, deleted on successful completion.

```typescript
export interface InitState {
  last_completed_step: number
  project: {
    name: string
    description: string
    description_long?: string
    type: ProjectType
  }
  remotes: {
    code: { url: string; branch: string }
    issues: { url: string; prefix: string; local_only: boolean }
    docs: { url: string; pending: boolean }
  }
  task_store: {
    provider: 'beads' | 'local'
  }
  beads_initialised: boolean
  docs_cloned: boolean
  committed: boolean
}
```

`task_store.provider` records the user's choice at step 3b (DDR-024). Written
into `map.yaml → remotes.issues` and used to select `BeadsTaskStore` or
`LocalTaskStore` at daemon startup.

### DiscoveryState

Persisted in `map.yaml → discovery`. Updated incrementally during the discovery
flow.

```typescript
export type DiscoveryStatus = 'not_started' | 'in_progress' | 'complete'

export type DiscoveryMode = 'full' | 'solo'

export interface DiscoveryState {
  status: DiscoveryStatus
  mode: DiscoveryMode
  completed_at?: string
  artifacts: string[]
  current_round: number
  total_rounds: number
  current_phase: number
  total_phases: number
  open_questions_count: number
  blocking_questions_count: number
}
```

### DiscoverySessionState

Tracks in-progress discovery. Written to `.sle/discovery-session.json` on every
interaction, deleted on completion or when the user ends the session.

```typescript
export interface DiscoverySessionState {
  session_id: string
  mode: DiscoveryMode
  current_round: number
  round_status: 'collecting' | 'drafting' | 'reviewing' | 'approved'
  completed_rounds: number[]
  artifacts_written: string[]
  open_questions_deferred: string[]
  started_at: string
  last_interaction_at: string
}
```

### OpenQuestion

Entries in `docs/open-questions.md`. Tracked by the daemon for blocking
warnings.

```typescript
export type OpenQuestionBlocking = `phase:${number}` | 'not_blocking'

export interface OpenQuestion {
  title: string
  status: 'open' | 'resolved'
  blocking: OpenQuestionBlocking
  owner?: string
  resolve_by?: string
  context: string
}
```

### Project type defaults

Selected at step 2. Determines rule file templates, validation categories,
prompt templates, and planning depth.

| Type | Default depth | Default categories |
|---|---|---|
| `api` | `standard` | correctness · performance · security |
| `ui` | `standard` | correctness · usability · performance |
| `library` | `standard` | correctness · compatibility · maintainability |
| `research` | `deep` | correctness |
| `custom` | `minimal` | correctness |

---

## Behavior

### Part 1: `sle init`

#### Step sequence

```
sle init
  │
  ├── 0.  Prerequisite check
  ├── 1.  Project identity
  ├── 2.  Project type selection
  ├── 3.  Remote configuration
  │     ├── 3a. Code remote (detected from git)
  │     ├── 3b. Issues remote + TaskStore provider (DDR-024)
  │     └── 3c. Docs remote (.server)
  ├── 4.  Rule file generation (7 files including agents.yaml)
  ├── 5.  TaskStore initialisation (Beads or local)
  ├── 6.  Docs remote clone
  ├── 7.  agent.md + map.yaml generation
  ├── 8.  Prompt template installation (all 10 role prompts)
  ├── 9.  Initial commit + push
  └── 10. Daemon start + startup validation
```

#### Step 0 — Prerequisite check

Runs silently. Exits immediately with a specific error if any check fails.

| Check | Pass condition |
|---|---|
| Git repo | `git rev-parse --is-inside-work-tree` exits 0 |
| Origin remote | `git remote get-url origin` exits 0 |
| Node.js 20+ | `process.version` major ≥ 20 |
| `.sle/` absent | `!fs.existsSync('.sle/')` |

#### Step 1 — Project identity

Project name inferred from `origin` URL (`git@github.com:org/my-project.git`
→ `my-project`), editable. Description required (re-prompts if empty). Optional
long description for `agent.md`.

#### Step 2 — Project type selection

User selects from: `api` · `ui` · `library` · `research` · `custom`. Sets
default validation categories, planning depth, artifact set, and `agent.md`
template variant (see project type defaults table above).

#### Step 3a — Code remote

Detected from `git remote get-url origin`. Branch inferred from
`git branch --show-current`. Written to `map.yaml → remotes.code`.

#### Step 3b — Issues remote + TaskStore provider (DDR-024)

User chooses between two task store providers:

| Provider | Storage | Sync | Requires |
|---|---|---|---|
| `beads` | `.beads/` (Dolt database) | Cross-device via DoltHub | DoltHub account, `bd` CLI |
| `local` | `.sle/tasks.yaml` | None | Nothing |

**Beads flow:** suggests Dolt remote URL from code remote org + project name.
Collects issue ID prefix (2-4 chars, inferred from name initials). If DoltHub
unreachable, warns but continues. If user has no DoltHub account, offers
local-only Beads mode (`bd init --stealth`, no remote sync).

**Local flow:** creates `.sle/tasks.yaml` with empty `tasks: []`. Daemon uses
`LocalTaskStore` for all task operations.

Written to `InitState.task_store.provider` and `map.yaml → remotes.issues`.

#### Step 3c — Docs remote

Suggests URL from code remote with `.server` suffix. Optionally creates via
`gh repo create`. If remote unavailable, sets `map.yaml → remotes.docs.pending`
to `true` — daemon refuses to start until resolved.

#### Step 4 — Rule file generation

No user input. Generates all 7 rule files from project type template:

`planning.yaml` · `validation.yaml` · `artifacts.yaml` · `exit.yaml` ·
`user_validation.yaml` · `summary.yaml` · `agents.yaml`

**`agents.yaml` defaults for all 10 roles:**

| Role | `active` | `node` | `conditional` | Notes |
|---|---|---|---|---|
| Designer | `true` | `design` | `false` | Owns architecture + requirements (DDR-019) |
| Explorer | `false` | `explore` | `true` (`user_initiated`) | Disabled by default (DDR-023) |
| Planner | `true` | `plan` | `false` | Owns plan + test-plan (DDR-019) |
| Tester | `true` | `test` | `false` | Never sees Builder output |
| Builder | `true` | `build` | `false` | Highest token budget (16000) |
| Debugger | `true` | `debug` | `true` (`gate_failure`) | Only on validation gate fail |
| Evaluator | `true` | `evaluate` | `false` | Runs post-gate |
| Critic | `true` | `critique` | `true` (`depth_deep_or_research`) | At DESIGN node (DDR-022) |
| Historian | `true` | `history` | `false` | Append-only |
| Facilitator | `true` | `null` | `false` | Discovery + chat only |

Default LLM: `openai_compatible`, `model: gpt-4o`, `api_key_env: OPENAI_API_KEY`.
Users customise after init. Rule files are plain YAML, never overwritten.

#### Step 5 — TaskStore initialisation

**Beads:** `bd init --quiet --prefix {prefix}`, `bd remote add origin {url}`,
`bd hooks install`, `bd push origin`.

**Local:** writes `.sle/tasks.yaml` with `tasks: []`.

#### Step 6 — Docs remote clone

`git clone {url} .server`, adds `.server` to `.gitignore`, creates symlink
`docs → .server/docs`.

#### Step 7 — agent.md + map.yaml generation

`agent.md` — written once, never touched by the system again.
`map.yaml` — written here, regenerated after every cycle. Contains:
`meta` (`status: idle`, `cycle: 0`, `version_id: v0.0.0`), `project`,
`remotes`, `agents` (from `agents.yaml` defaults for all 10 roles), `discovery`
(`status: not_started`), all other sections at post-init defaults.

Both opened in `$EDITOR` if set.

#### Step 8 — Prompt template installation

Installs all 10 role prompt templates to `.sle/prompts/`. Validation check
prompts filtered by project type (e.g. `security_check.md` for `api` only).
Full set available via `sle templates install --all`.

#### Step 9 — Initial commit

`git add .sle/ agent.md`, `git commit -m "chore: initialise SLE project"`,
`git push origin main`. Push failure is non-fatal — local state is valid.

#### Step 10 — Daemon start + startup validation

Starts daemon on port 7700. Validates:

| Check | Pass condition |
|---|---|
| `agent.md → map:` reference | Path resolves to valid YAML |
| `map.yaml` valid | Parses against RuntimeMap schema |
| Rule files valid | All 7 pass Zod validation |
| Agent roles valid | 10 roles present in agents.yaml |
| Task store | `.beads/` exists (Beads) or `.sle/tasks.yaml` exists (local) |
| Docs remote | `.server/` exists or `pending: true` |
| Discovery gate | `discovery.status` present in map.yaml |

#### Resume behaviour (`--resume`)

If init fails mid-sequence, state is saved to `.sle/init-state.json`. Running
`sle init --resume` re-enters at the last successful step.

**Step classification:**

| Type | Steps | Resume behaviour |
|---|---|---|
| Idempotent | 0, 2, 4, 7, 8, 10 | Always re-run |
| Side-effect | 5 (TaskStore init), 6 (docs clone), 9 (commit) | Skipped if boolean flag is `true` |
| Input collection | 1, 3 | Re-read from init-state.json |

```
sle init --resume
  │
  ├── Read .sle/init-state.json
  │
  ├── Validate: last_completed_step >= 0
  │   └── Missing/corrupt: "No init state found. Run: sle init"
  │
  ├── Re-run all idempotent steps (0, 2, 4, 7, 8)
  │
  ├── Check side-effect flags:
  │   ├── beads_initialised / local_tasks_created: true  → skip step 5
  │   ├── beads_initialised / local_tasks_created: false → re-run step 5
  │   ├── docs_cloned: true   → skip step 6
  │   ├── docs_cloned: false  → re-run step 6
  │   ├── committed: true     → skip step 9
  │   └── committed: false    → re-run step 9
  │
  ├── Always run step 10 (daemon start)
  │
  └── On success: delete .sle/init-state.json
```

#### Reset (`--reset`)

```
This will remove:
  .sle/          (rules, map.yaml, daemon state, tasks.yaml)
  .beads/        (Beads database — issue history lost locally)
  .server/       (docs remote clone)
  docs → .server/docs  (symlink)
  agent.md

Remote data (DoltHub, docs git remote) is NOT deleted.

Type the project name to confirm: _
```

On confirmation:

- `rm -rf .sle/ .beads/ .server/`
- `rm -f docs agent.md`
- Does NOT delete `.gitignore` entries or git history
- Re-runs `sle init` from step 0

#### Non-interactive mode (`--non-interactive`)

All values passed as flags, no prompts. Used in CI.

```bash
sle init \
  --name "my-project" \
  --description "REST API for item management" \
  --type api \
  --code-remote git@github.com:org/my-project.git \
  --issues-remote dolthub://org/my-project-issues \
  --docs-remote git@github.com:org/my-project.server.git \
  --prefix mp \
  --task-store beads \
  --no-editor \
  --no-daemon
```

| Flag | Maps to |
|---|---|
| `--name` | `project.name` |
| `--description` | `project.description` |
| `--type` | `project.type` |
| `--code-remote` | `remotes.code.url` |
| `--issues-remote` | `remotes.issues.url` |
| `--docs-remote` | `remotes.docs.url` |
| `--prefix` | `remotes.issues.bd_prefix` |
| `--task-store` | `task_store.provider` (`beads` or `local`) |
| `--no-editor` | Skip `$EDITOR` for agent.md |
| `--no-daemon` | Skip step 10 |

#### Files created by successful init

```
project-root/
  agent.md                     .sle/map.yaml       .sle/daemon.pid
  docs → .server/docs          .sle/init-state.json (deleted on completion)
  .sle/tasks.yaml              (local task store only)

  .sle/rules/                  (7 files: planning, validation, artifacts, exit,
                                 user_validation, summary, agents)

  .sle/prompts/                (10 role prompts: designer, explorer, planner,
                                 tester, builder, debugger, evaluator, critic,
                                 historian, facilitator)
                                + validation check prompts (project-type filtered)

  .sle/lib/                    test-runner.ts, bench-runner.ts
  .beads/                      (Beads database — if task-store: beads)
  .server/docs/                (empty — populated by discovery or first cycle)
```

---

### Part 2: `sle discover`

#### Prerequisites

- `sle init` completed (daemon running, remotes configured)
- `map.yaml → discovery.status` is `not_started` (or use `--revisit`)
- `map.yaml → meta.status` is `idle`

#### Commands

```bash
sle discover                    # start discovery
sle discover --revisit          # re-enter to revise existing docs
sle discover --from brief.md    # inject existing document as starting point
sle discover --solo             # lightweight mode for solo developers
sle discover --replan           # re-plan remaining phases
sle discover --status           # show progress and current phase
```

#### Full mode flow (4 rounds + synthesis + planning)

```
sle discover
  │
  ├── T1: idle → discovering
  │
  ├── Round 1: Product Brief
  │   └── Interactive Q&A → docs/product-brief.md → user approves
  │
  ├── Round 2: Problem & Success Definition
  │   └── Interactive Q&A → docs/success-definition.md → user approves
  │
  ├── Round 3: Constraints & Boundaries
  │   └── Interactive Q&A → docs/constraints.md → user approves
  │
  ├── Round 4: Stakeholders & Decision Rights
  │   └── Interactive Q&A → docs/stakeholders.md → user approves
  │
  ├── Synthesis
  │   ├── LLM reads all 4 approved docs
  │   ├── Resolve-or-defer open questions
  │   └── docs/system-description.md + docs/vision.md + docs/open-questions.md → user approves
  │
  ├── Planning Loop
  │   ├── LLM reads all 7 docs → docs/project-plan.md
  │   ├── User reviews / reorders / splits / merges phases
  │   └── User approves
  │
  ├── Finalization
  │   ├── Create tasks for Phase 1 (Beads or local)
  │   ├── Block later phases
  │   ├── Update map.yaml → discovery.status: complete
  │   └── Update agent.md with discovery references
  │
  └── T2: discovering → idle
```

#### Solo mode (`--solo`)

Collapsed flow for solo developers. 2 rounds instead of 4.

| Aspect | Full mode | Solo mode |
|---|---|---|
| Rounds | 4 + synthesis + planning | 2 + synthesis + planning |
| Documents | 8 | 6 |
| Stakeholders doc | Required | Skipped |
| Success definition | Separate | Merged into product-brief.md |
| System description | Separate synthesis step | Merged into Round 2 |
| Approval gates | After every round | After every round (same) |

```
sle discover --solo
  │
  ├── Round 1: Product Brief + Success Definition (merged)
  │   └── Interactive Q&A → docs/product-brief.md (includes success criteria) → approve
  │
  ├── Round 2: Constraints + System Description (merged)
  │   └── Interactive Q&A → docs/constraints.md + docs/system-description.md → approve
  │
  ├── Synthesis (auto-generated, no separate approval)
  │   └── docs/vision.md + docs/open-questions.md
  │
  └── Planning Loop
      └── docs/project-plan.md → approve
```

Solo mode sets `discovery.mode: solo` in `map.yaml`. The daemon does not warn
about missing `stakeholders.md` when mode is `solo`. Users can upgrade to full
mode later via `sle discover --revisit` (without `--solo`).

#### Round protocol

Every round follows the same protocol:

1. **Opening question** — Facilitator asks a broad question about the domain
2. **Free-form response** — user answers however they like
3. **Follow-up loop** — Facilitator asks focused follow-up questions, one at a
   time, until it has enough information for a complete draft
4. **Draft generation** — Facilitator produces the target artifact
5. **User review** — approve / edit / revise
6. **Revision loop** — if revise, user describes what's wrong, Facilitator may
   ask clarifying questions before revising, then re-presents

No cap on follow-up exchanges. The Facilitator reads all previously approved
artifacts before each round — the conversation is cumulative.

#### Discovery rounds

Each round follows the round protocol. The Facilitator reads all previously
approved artifacts before each round — context is cumulative.

| Round | Artifact | Context read | Opening question topic | Facilitator checks |
|---|---|---|---|---|
| 1 | `docs/product-brief.md` | None | "What are you building?" | Target audience, value proposition, scope, differentiation |
| 2 | `docs/success-definition.md` | product-brief | "What does success/failure look like?" | Problem statement, measurable criteria, failure modes, MVP exit criteria |
| 3 | `docs/constraints.md` | product-brief, success-definition | "What's out of scope? Hard constraints?" | Out-of-scope list, tech mandates, regulatory, integration, timeline |
| 4 | `docs/stakeholders.md` | all 3 prior | "Who's involved? Decision-making?" | Product owner, primary users, veto holders, technical direction |

**Artifact schemas** — each discovery artifact follows a standard markdown
structure with required sections. The Facilitator produces section headings and
fills content from the Q&A. Templates are shipped in `@sle/sdk` and loaded at
round start. Key sections:

- `product-brief.md`: Overview, Target Audience, Value Proposition, Core
  Workflow, Differentiation
- `success-definition.md`: Problem Statement, Pain Points, Success Criteria,
  Failure Modes, MVP Exit Criteria
- `constraints.md`: Out of Scope, Technology Mandates, Regulatory,
  Integration Requirements, Timeline
- `stakeholders.md`: Product Owner, Primary Users, Technical Direction,
  Veto Power, RACI Matrix

#### Synthesis step

The Facilitator reads all 4 approved documents and produces three derived
artifacts.

**`docs/system-description.md`** — what the system IS and IS NOT. Core entities,
API surface, data model, integration points.

**`docs/vision.md`** — MVP definition, near-term, long-term, architecture intent,
non-negotiables.

**`docs/open-questions.md`** — before generating the project plan, the
Facilitator surfaces unresolved items:

```
I noticed this is still unclear: [item]
Resolve now or defer? [r/d]:
```

- **Resolve now** — Facilitator asks follow-ups, updates relevant doc
- **Defer** — item logged in `open-questions.md`

Only user-explicitly-deferred items land in this file. The Facilitator does not
silently add entries.

User reviews and approves all three synthesis artifacts. Revision loop is the
same as discovery rounds.

#### Planning loop

The Facilitator reads all 7 documents and produces `docs/project-plan.md`.

Each phase has: **Scope** (what's included), **Exit criteria** (concrete "done
when" conditions), **Tasks** (high-level work items becoming TaskStore tasks),
**Dependencies** (prior phases), **Complexity** (Low/Medium/High), and
**Suggested categories** (validation categories for cycles).

User controls: **Approve** (accept as-is), **Reorder** (drag/drop phases),
**Merge** (combine granular phases), **Split** (break large phases),
**Adjust scope** (modify individual phase). Each adjustment triggers revision.
Loop continues until user approves.

#### Finalization

Once plan is approved:

1. **Create tasks for Phase 1** via active TaskStore (Beads: `bd create`,
   Local: append to `.sle/tasks.yaml`)
2. **Block later phases** — Phase 2+ tasks blocked on prior phase completion
3. **Update `map.yaml`** — set `discovery.status: complete`, record all
   artifact paths, set `current_phase` and `total_phases`
4. **Update `map.yaml → context.agent_slices.planner`** to include discovery
   artifacts
5. **Update `agent.md`** with discovery references section
6. **Delete `.sle/discovery-session.json`**

#### Re-discovery (`--revisit`)

Re-enters the flow with existing documents. Each round offers: **Keep** (skip),
**Revise** (targeted questions), or **Rewrite** (fresh start).

Only modified documents trigger re-synthesis. `open-questions.md` entries are
preserved — only the user can mark them resolved. Omitting `--solo` on revisit
upgrades to full mode with existing solo docs as starting points.

#### Phase re-planning (`--replan`)

Triggered after a phase completes. Facilitator reads completed phase outcomes
and all discovery artifacts, proposes revisions to remaining phases only.
User reviews, adjusts, approves. Tasks updated via active TaskStore. Completed
phases are never modified.

#### Document injection (`--from`)

```bash
sle discover --from brief.md
```

Injects an existing document as the starting point for Round 1. Facilitator
reads it, produces draft `product-brief.md`, then asks follow-ups to fill gaps.

---

## API contract

### Init

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/v2/init` | Run init sequence |
| `GET` | `/api/v2/init/status` | Check init progress |
| `POST` | `/api/v2/init/reset` | Reset and re-run init |

Full request/response shapes are in [daemon-api.md](daemon-api.md) §Init endpoints.

### Discovery

All discovery endpoints are defined in [daemon-api.md](daemon-api.md) §Discovery endpoints. The full list:

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/v2/discovery/start` | Start discovery session |
| `POST` | `/api/v2/discovery/round/{n}/response` | Submit user response |
| `GET` | `/api/v2/discovery/round/{n}/draft` | Get current draft |
| `POST` | `/api/v2/discovery/round/{n}/approve` | Approve round |
| `POST` | `/api/v2/discovery/round/{n}/revise` | Request revision |
| `POST` | `/api/v2/discovery/synthesis/approve` | Approve synthesis |
| `POST` | `/api/v2/discovery/plan/approve` | Approve project plan |
| `POST` | `/api/v2/discovery/plan/reorder` | Reorder phases |
| `POST` | `/api/v2/discovery/plan/split/{phase}` | Split a phase |
| `POST` | `/api/v2/discovery/plan/merge` | Merge phases |
| `GET` | `/api/v2/discovery/status` | Get discovery state |

### Error responses

All endpoints use the standard `APIError` envelope (see [daemon-api.md](daemon-api.md) §Error propagation):

```typescript
interface APIError {
  ok: false
  error: {
    code: string
    message: string
    details?: unknown
  }
  meta: {
    request_id: string
    timestamp: string
  }
}
```

| HTTP | `error.code` | When |
|---|---|---|
| 409 | `already_initialised` | `.sle/` exists |
| 404 | `no_init_state` | No `init-state.json` to resume |
| 403 | `name_mismatch` | Reset confirmation name wrong |
| 409 | `discovery_already_complete` | Discovery run without `--revisit` |
| 409 | `not_idle` | System not in `idle` state |
| 400 | `invalid_round` | Round N ≠ current round |

### WebSocket events

```
event: init.step_completed
{ step, name, status: "success"|"failed", message, timestamp }

event: init.complete
{ files_created, task_store: "beads"|"local", daemon_port, timestamp }

event: discovery.round_started
{ session_id, round, opening_question, timestamp }

event: discovery.draft_ready
{ session_id, round, artifact_path, timestamp }

event: discovery.round_approved
{ session_id, round, artifact_path, next_round, timestamp }

event: discovery.complete
{ session_id, artifacts, total_phases, timestamp }
```

---

## Error cases

### Init errors (E100–E109)

| Code | Name | Condition | Severity | Recovery |
|---|---|---|---|---|
| E100 | init_already_initialised | `.sle/` exists and `--reset` not set | critical | `sle init --reset` to reinitialise |
| E101 | init_no_git_repo | Not inside a git working tree | critical | `git init` or clone a repository |
| E102 | init_no_origin | No git remote named `origin` | critical | `git remote add origin <url>` |
| E103 | init_beads_failure | `bd init` returns non-zero exit | error | Check `.beads/` doesn't exist, permissions. Then: `sle init --resume` |
| E104 | init_docs_clone_failure | `git clone` for docs remote fails | error | Remote may not exist. Create it or skip: `sle init --resume` |
| E105 | init_commit_failure | `git commit` or `git add` fails | error | Check git status, permissions. Local state preserved: `sle init --resume` |
| E106 | init_push_failure | `git push origin` fails | warning | Local state is valid. Push manually: `git push origin main` |
| E107 | init_daemon_start_failure | Daemon process fails to start | error | Check port availability: `sle daemon start`. Init succeeds without daemon |
| E108 | init_state_corrupted | `.sle/init-state.json` exists but is invalid JSON | error | Delete file and re-run: `sle init` |
| E109 | init_task_store_unsupported | `--task-store` value is not `beads` or `local` | critical | Use `--task-store beads` or `--task-store local` |

### Discovery errors (E110–E119)

| Code | Name | Condition | Severity | Recovery |
|---|---|---|---|---|
| E110 | discovery_already_complete | `sle discover` when `discovery.status` is `complete` | error | `sle discover --revisit` to revise |
| E111 | discovery_not_initialised | `sle discover` when `sle init` has not been run | critical | Run `sle init` first |
| E112 | discovery_not_idle | `sle discover` when `meta.status` is not `idle` | critical | Complete or halt current session first |
| E113 | discovery_session_timeout | No user interaction for 30 minutes | warning | State preserved. Resume: `sle discover` (session auto-resumes) |
| E114 | discovery_synthesis_conflict | User modifies artifact externally during synthesis | warning | Auto re-read and re-synthesise |
| E115 | discovery_round_invalid | Request for round N when current round is M ≠ N | error | Check current round: `GET /api/v2/discovery/status` |
| E116 | discovery_plan_no_phases | Plan generation produces zero phases | error | Revisit discovery — insufficient scope or constraints |
| E117 | discovery_task_create_failed | TaskStore fails to create Phase 1 tasks | warning | Plan approved but no tasks. Create manually or re-run finalization |
| E118 | discovery_from_file_not_found | `--from brief.md` references non-existent file | critical | Provide valid file path |
| E119 | discovery_mode_conflict | `--solo` and `--revisit` without `--solo` on previously solo project | warning | Mode upgrade proceeds — existing docs used as starting points |

### Integration with existing error codes

Init and discovery interact with these existing error ranges:

| Range | Relevant codes | When |
|---|---|---|
| E001–E009 | E001 (daemon not running), E008 (discovery incomplete) | Post-init daemon checks; cycle start guard |
| E040–E047 | E040 (LLM timeout), E044 (LLM auth failure) | Facilitator LLM calls during discovery |
| E066 | facilitator_discovery_interrupted | Discovery session interrupted |
| E090–E099 | E090 (claim failed), E092 (sync failure) | TaskStore operations during discovery finalization |

---

## Constraints

1. **Init is idempotent-except-once.** `sle init` succeeds exactly once. After
   that, only `--resume` (for partial failures) or `--reset` (for complete
   reinitialisation) are valid.

2. **All 10 agent roles are configured at init.** `agents.yaml` is generated
   with entries for every role (G28). Roles may be `active: false` (Explorer)
   or `conditional: true` (Debugger, Critic, Explorer), but all are present.
   The daemon validates exactly 10 entries at startup.

3. **TaskStore provider is fixed after init.** The choice between Beads and
   local is recorded in `InitState.task_store.provider` and written to
   `map.yaml`. Changing provider requires `sle init --reset`. The daemon reads
   the provider at startup and instantiates the correct implementation.

4. **Discovery is a prerequisite for cycles.** The daemon rejects
   `POST /cycle/start` when `discovery.status ≠ complete` unless
   `skip_discovery: true` is passed. This guard is checked in the state machine
   transition T3.

5. **Discovery uses the Facilitator role only.** No cycle agent roles
   participate in discovery. The Facilitator operates outside the cycle DAG. It
   does not see code, start cycles, or modify rule files.

6. **Discovery artifacts are human-approved.** Every artifact produced during
   discovery must be explicitly approved by the user before the next round
   begins. There is no auto-approve mode for discovery.

7. **Discovery sessions are resumable.** State is written to
   `.sle/discovery-session.json` on every interaction. On daemon restart or
   session timeout, the flow resumes at the exact point of interruption.

8. **Init does not require network for local mode.** When `--task-store local`
   is selected and the docs remote is skipped (or pending), init completes
   without any external network calls after the prerequisite check.

9. **Non-interactive init is CI-compatible.** All required values have CLI
   flags. `--no-daemon` skips daemon start. Exit code 0 on success, non-zero
   on any failure.

10. **Reset does not delete remote data.** `sle init --reset` removes local
    directories (`.sle/`, `.beads/`, `.server/`) but never deletes data on
    DoltHub or the docs git remote.

11. **Phase planning is phase-level, not task-level.** The project plan defines
    phases with exit criteria. Individual task breakdown happens in development
    cycles where the Planner has codebase context. Discovery does not have
    enough information to decompose tasks.

12. **Solo mode is upgradeable.** A project started with `--solo` can upgrade to
    full mode via `sle discover --revisit` (without `--solo`). Existing solo
    documents become starting points for the full flow. Downgrade from full to
    solo is not supported — full mode artifacts are kept.

13. **Open questions are append-only.** Entries in `open-questions.md` are never
    removed by the system. Only the user can mark entries resolved. The
    Facilitator may add new entries during revisit but never deletes existing
    ones.

14. **Completed phases are immutable.** During re-planning (`--replan`), only
    future phases are modified. Completed phases are never changed. Phase
    history is preserved in `map.yaml → history`.

---

## Open questions

| ID | Question | Impact | Status |
|---|---|---|---|
| ID-001 | Should `sle init` auto-detect project type from `package.json` or other config files, or always prompt? | UX flow, init step count | Open |
| ID-002 | What is the migration path when a new agent role is added in a future SLE version? | Upgrade complexity, agents.yaml schema versioning | Open |
| ID-003 | Should the local TaskStore (`.sle/tasks.yaml`) support import/export for later migration to Beads? | Data portability, local-first user onboarding | Open |
| ID-004 | Is there a maximum number of discovery rounds beyond which the system should force plan generation? | Facilitator conversation length, token cost | Open |
| ID-005 | Should `sle discover --from` accept multiple files or only one? | Intake pipeline coupling, multi-document projects | Open |
| ID-006 | How does discovery interact with an existing `agent.md` that already describes the project? Should it extract information from it? | Context reuse, discover-after-edit workflow | Open |
| ID-007 | Should the daemon block startup if TaskStore (Beads or local) is in an inconsistent state, or degrade gracefully? | Startup reliability, partial failure handling | Open |
| ID-008 | What is the minimum set of discovery artifacts required for `skip_discovery: true` to produce a useful first cycle? | Cycle quality without discovery, prototyping support | Open |
| ID-009 | Should `sle init` validate LLM API key reachability (test call) or defer to first agent invocation? | Init failure rate, user feedback timing | Open |
| ID-010 | Can the planning loop produce a phase with zero tasks (placeholder for future work), or must every phase have at least one task? | Plan flexibility, empty-phase handling | Open |
