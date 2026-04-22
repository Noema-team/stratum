# Architecture

**Type:** overview · **Status:** draft · **Updated:** 2026-04-17
**Related:** [what-is-sle.md](what-is-sle.md), [../reference/types.md](../reference/types.md)

---

## What this is

This document describes how the Software Lifecycle Engine is built: which
components exist, where they sit in the platform layer stack, how they
communicate, and what data flows between them.

It is the structural companion to [what-is-sle.md](what-is-sle.md), which
covers the conceptual model. Read that first, then come here for the wiring.

---

## Why it exists

SLE spans five platform layers and integrates with infrastructure it does not
own (PostgreSQL, Redis, MinIO, AI Executor). Without a single architecture
document, the placement rules and integration boundaries are scattered across
vision specs and decision records. This doc consolidates them.

The governing decisions:

| Decision | What it sets |
|---|---|
| **DDR-004** | SLE lives primarily at Layer 3; execution delegates to Layer 2 |
| **DDR-005** | Cognee is an optional Layer 3 REST API container |
| **DDR-024** | TaskStore provider: `BeadsTaskStore` or `LocalTaskStore` |
| **DDR-002** | Seven YAML rule files govern all system behaviour |

---

## Key ideas

### 1. The daemon is the centre

The SDK daemon (`@sle/sdk`, port 7700) is the only component that knows about
the DAG, rule files, agents, and the artifact store. Everything else — CLI,
web UI, Obsidian plugin — is a thin client that talks to the daemon over
REST + WebSocket. No system logic exists outside the daemon.

### 2. Layers are strict

Each platform layer has a single responsibility. Components never reach across
layers. The daemon (Layer 3) never manages Docker containers directly — it
calls the AI Executor (Layer 2). The CLI (Layer 4) contains zero business
logic. Infrastructure (Layer 1) provides storage and messaging, nothing more.

### 3. Rules as config, not code

All system behaviour is governed by seven YAML files. Agents, the DAG runner,
and the context manager read these files at runtime. Changing how the system
behaves means changing a rule file, not editing application code.

### 4. Provider interfaces for optional capabilities

Optional capabilities (knowledge engine, task store) are abstracted behind
provider interfaces with noop implementations. When disabled, the system
operates exactly as if the capability never existed.

---

## How it fits

### Platform layer stack

```
┌─────────────────────────────────────────────────────────────────────────┐
│                                                                         │
│  Layer 4 — Interface                                                    │
│  ┌───────────┐  ┌───────────┐  ┌──────────────────┐                    │
│  │  sle CLI  │  │  Web UI   │  │  Obsidian plugin │                    │
│  │ (thin)    │  │ (thin)    │  │  (thin)          │                    │
│  └─────┬─────┘  └─────┬─────┘  └────────┬─────────┘                    │
│        │              │                  │                               │
│        └──────── REST / WebSocket ───────┘                               │
│                         port 7700                                        │
│                                                                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Layer 3 — Applications                                                 │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  SDK daemon  (@sle/sdk)                                        │    │
│  │                                                                 │    │
│  │  ┌──────────────┐ ┌──────────────┐ ┌────────────────────────┐  │    │
│  │  │ DAG runner   │ │ Rule loader  │ │ Context manager        │  │    │
│  │  │              │ │              │ │                        │  │    │
│  │  │ Cycle state  │ │ 7 YAML files │ │ Artifact slice assembly│  │    │
│  │  │ Iteration    │ │ → Runtime-   │ │ Token budget mgmt      │  │    │
│  │  │ Node dispatch│ │   Config     │ │ Failure context        │  │    │
│  │  └──────────────┘ └──────────────┘ └────────────────────────┘  │    │
│  │                                                                 │    │
│  │  ┌──────────────────────────────────────────────────────────┐   │    │
│  │  │  Agent runtime (LLM calls inside daemon process)        │   │    │
│  │  │                                                          │   │    │
│  │  │  Designer · Explorer · Planner · Tester · Builder       │   │    │
│  │  │  Debugger · Evaluator · Critic · Historian · Facilitator│   │    │
│  │  └──────────────────────────────────────────────────────────┘   │    │
│  │                                                                 │    │
│  │  ┌──────────────┐ ┌──────────────┐ ┌────────────────────────┐  │    │
│  │  │ Beads bridge │ │ Task store   │ │ Knowledge client       │  │    │
│  │  │ (bd CLI)     │ │ provider     │ │ (HTTP to cognee)       │  │    │
│  │  └──────────────┘ └──────────────┘ └────────────────────────┘  │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                         │
│  ┌───────────────────────────────────┐                                  │
│  │  Cognee (optional)                │  ← Docker Compose profile       │
│  │  FastAPI · port 8001              │     --profile knowledge          │
│  │  Knowledge graph + vector search  │                                  │
│  └───────────────────────────────────┘                                  │
│                                                                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Layer 2 — Execution                                                    │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  AI Executor (existing)                                         │    │
│  │                                                                 │    │
│  │  Receives generated test scripts from daemon.                   │    │
│  │  Runs in isolated containers. Streams logs. Returns exit codes. │    │
│  │  Does not know about SLE.                                       │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Layer 1 — Core Infrastructure                                          │
│                                                                         │
│  ┌───────────────┐  ┌────────────┐  ┌──────────────┐                   │
│  │  PostgreSQL   │  │  Redis     │  │  MinIO       │                   │
│  │               │  │            │  │              │                   │
│  │ sle_* tables  │  │ pub/sub    │  │ artifact     │                   │
│  │ cycle/task    │  │ approval   │  │ snapshots    │                   │
│  │ metadata      │  │ gates      │  │ reports      │                   │
│  │ pgvector ext  │  │ event      │  │ docs remote  │                   │
│  │               │  │ streaming  │  │ contents     │                   │
│  └───────────────┘  └────────────┘  └──────────────┘                   │
│                                                                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Layer 0 — Host                                                         │
│  Debian Stable · Docker · SSH · tmux                                    │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Data flow through a cycle

```
                    ┌─────────┐
                    │  User   │
                    └────┬────┘
                         │ intent + depth + session ID
                         ▼
                ┌────────────────┐
                │  sle CLI / UI  │   Layer 4 — thin client
                │  (REST/WS)     │
                └───────┬────────┘
                        │ HTTP :7700
                        ▼
         ┌──────────────────────────────┐
         │        SDK daemon            │   Layer 3
         │                              │
         │  1. Rule loader              │
         │     .sle/rules/*.yaml        │
         │     → RuntimeConfig          │
         │                              │
         │  2. Context manager          │
         │     loads artifact slices    │
         │     per-role token budgets   │
         │                              │
         │  3. DAG runner dispatches    │
         │     nodes in sequence:       │
         │                              │
         │     DESIGN ──► PLAN ──► TEST ──► CONFIRM ──► BUILD ──► EXEC
         │        │                                            │
         │     [Critic reviews                        validation scripts
         │      at deep/research                           │
         │      depth if active]                           │
         │                                                  │
         │  4. VALIDATION_GATE ◄───────────────────────────┘
         │     │
         │     ├── LLM phase (Layer 3)
         │     │     Evaluator agent reads artifacts,
         │     │     produces structured verdict
         │     │
         │     └── Executable phase (Layer 2)
         │           Scripts submitted to AI Executor
         │           via HTTP :8080
         │
         │  5. Gate result
         │     all pass → SUMMARISE → SNAPSHOT
         │     any fail → FailureReport → next iteration
         │     cap hit  → halt_with_report
         │                              │
         └──────────────────────────────┘
                   │
                   ▼
         ┌────────────────┐
         │  PostgreSQL    │   Layer 1 — cycle metadata, iteration history
         │  Redis         │   Layer 1 — event stream, approval signals
         │  MinIO         │   Layer 1 — versioned artifact snapshots
         └────────────────┘
```

---

### The 10 agent roles

SLE uses distinct agent roles. Each role receives a specific artifact slice
from the context manager — it never sees the full artifact store. Roles are
configured in `agents.yaml` and dispatched by the DAG runner.

| Role | DAG node | Reads | Writes | Conditional? |
|---|---|---|---|---|
| **Designer** | `DESIGN` | requirements, architecture, decisions, evaluation | `requirements.md`, `architecture.md` | No |
| **Explorer** | `EXPLORE` | requirements, evaluation, decisions | research findings | Yes — user-initiated only |
| **Planner** | `PLAN` | requirements, architecture, decisions, evaluation | `test-plan.md`, `plan.md` | No |
| **Tester** | `TEST` | requirements, test-plan | executable test scripts | No |
| **Builder** | `BUILD` | requirements, architecture, test-plan | implementation, instrumented test scripts | No |
| **Debugger** | `DEBUG` | run artifacts, failed category slices | diagnosis, fix recommendation | Yes — gate failure only |
| **Evaluator** | `EVALUATE` | requirements, evaluation, test-plan | structured verdict | No |
| **Critic** | triggered at `DESIGN` | architecture, requirements, evaluation | verdict, issues, suggestions | Yes — deep/research depth |
| **Historian** | `HISTORY` | decisions (full, append target) | audit entry appended to `decisions.md` | No |
| **Facilitator** | null (session-based) | project context, cycle context | discovery docs, captured decisions | No |

**Conditional roles** only activate under specific conditions:

- **Explorer** — user explicitly requests research; disabled by default
- **Debugger** — only when the validation gate produces a failure report
- **Critic** — only at `deep` or `research` planning depth; runs at the
  `DESIGN` node, reviewing Designer output before it reaches the Planner

**TDD separation:** The Tester never sees Builder output. Test scripts are
written against the plan and requirements, not the implementation. The Builder
then writes implementation that satisfies those tests.

---

### The 7 rule files

All system behaviour is governed by seven YAML files in `.sle/rules/`:

| File | Controls | Key settings |
|---|---|---|
| `planning.yaml` | Reasoning depth, iteration cap, slice sizes | `depth`, `max_iterations`, `artifact_slice_size`, `reasoning_passes` |
| `validation.yaml` | Validation categories, methods, pass criteria | `categories[]` with `method`, `executable`, `llm`, `pass_criteria`, `on_fail` |
| `artifacts.yaml` | Which documents to generate, format, required flag | `artifacts[]`, `generated_outputs[]` |
| `exit.yaml` | Cycle exit conditions, cap behaviour, halt policy | `conditions`, `on_cap_hit`, `halt_behavior`, `on_error` |
| `user_validation.yaml` | When to pause for human approval | `approval_required`, `review_at`, `timeout_minutes`, `on_timeout` |
| `summary.yaml` | User-facing summary format and sections | `format`, `sections`, `test_command_format` |
| `agents.yaml` | Agent roles, system prompts, LLM provider config | `defaults`, `providers`, 10 role entries |

The rule loader merges these at daemon start into a single `RuntimeConfig`
object. Resolution chain:

```
shipped defaults (@sle/sdk)
  ↓ deep merge
.sle/rules/*.yaml            (project-level overrides)
  ↓ deep merge
.sle/overrides/*.yaml        (user-created, highest priority)
  ↓
RuntimeConfig
```

All files are validated with Zod schemas at daemon start. Invalid config
causes the daemon to refuse to start with a field path and line number.

The LLM may only append new categories to `validation.yaml` at planning
time. It cannot modify any other rule file. This boundary keeps the loop
bounded and predictable.

---

### The three-remote model

Every SLE project uses three distinct remotes with independent histories:

```
code remote (git)
  ├── source code
  ├── .sle/rules/              ← 7 rule files
  ├── .sle/prompts/            ← system prompt templates
  ├── agent.md                 ← human-authored bootstrap
  └── map.yaml                 ← auto-generated system state

issues remote (dolt — Beads)
  ├── issue tracker
  ├── task dependencies
  └── agent memory across sessions

docs remote (git — .server/)
  ├── requirements.md
  ├── architecture.md
  ├── decisions.md
  ├── evaluation.md
  └── reports/
```

The docs remote is checked out at `.server/` alongside the project root.
Documentation has its own commit history, independent from code.

This separation means:
- Documentation can be versioned and rolled back independently
- Issue history survives code repo resets
- Code can be open-sourced without exposing internal docs or issue history

---

### TaskStore provider (DDR-024)

Task persistence is abstracted behind a `TaskStore` interface:

```typescript
interface TaskStore {
  createTask(task): Promise<SLETask>
  getReadyTasks(): Promise<SLETask[]>
  updateStatus(id, status): Promise<void>
  closeTask(id): Promise<void>
  getStale(): Promise<SLETask[]>
}
```

Two implementations:

| Provider | Storage | When to use |
|---|---|---|
| `BeadsTaskStore` | Dolt remote via `bd` CLI | Default — full feature parity, cross-device sync |
| `LocalTaskStore` | `.sle/tasks.yaml` | Local-only mode — no DoltHub account needed |

Selected at `sle init`. Context manager reads from whichever store is active —
no code changes in context assembly.

**Degraded in local mode:** no cross-device sync, no DoltHub UI, no
`bd dolt push` for tasks. Staleness detection works identically in both modes.

---

### Cognee knowledge service (DDR-005)

Optional knowledge graph and vector search. Disabled by default.

| Aspect | Detail |
|---|---|
| Container | `ai-cognee` FastAPI on port 8001 |
| Enable | `docker compose --profile knowledge up` |
| Storage | pgvector extension on shared PostgreSQL; file-based KuzuDB for graph |
| Interface | `KnowledgeProvider` with `NoopProvider` when disabled |
| Config | Same ZhipuAI API key via LiteLLM `zai/` prefix |

When disabled, SLE operates exactly as specified in the core documents. Zero
behavioural difference.

---

### Daemon communication

The daemon exposes two protocols:

**REST (port 7700):**
- `POST /api/cycle/start` — begin a cycle with intent and depth
- `GET /api/cycle/status` — current cycle state, DAG position, iteration
- `POST /api/cycle/approve` — approve at an approval gate
- `POST /api/cycle/halt` — halt the running cycle
- `GET /api/config` — current merged `RuntimeConfig`
- `GET /api/artifacts` — artifact registry with dirty flags

**WebSocket (port 7700):**
- `cycle:started` — cycle begins
- `node:entered` / `node:exited` — DAG node transitions
- `agent:invoked` / `agent:completed` — agent lifecycle events
- `validation:category_result` — individual category pass/fail
- `gate:result` — gate outcome
- `cycle:summary` — user-facing summary ready
- `approval:needed` — pause for human review

All events carry the cycle ID and timestamp. Clients subscribe to a cycle's
event stream and render progress in real time.

---

### Docker Compose placement

```
dev-server/
├── core/               # Layer 1: PostgreSQL, Redis, MinIO
├── executor/           # Layer 2: AI Executor
├── bmad/               # Layer 3: BMAD Orchestrator
├── sle/                # Layer 3: SLE SDK daemon        ← new
│   ├── docker-compose.yml
│   ├── Dockerfile
│   └── packages/sle/
├── cognee/             # Layer 3: Cognee (optional)     ← new
│   ├── docker-compose.yml
│   ├── Dockerfile
│   └── .env
└── docker-compose.yml  # root orchestrator
```

Daemon service definition:

```yaml
services:
  sle-daemon:
    build: ./packages/sle
    ports:
      - "7700:7700"
    environment:
      - DATABASE_URL=${DATABASE_URL}
      - REDIS_URL=${REDIS_URL}
      - MINIO_URL=${MINIO_URL}
      - EXECUTOR_URL=http://executor:8080
      - OPENAI_API_KEY=${OPENAI_API_KEY}
    networks:
      - ai-network
```

The daemon joins `ai-network` and reaches all platform services by service
name. No hard-coded IPs or port mappings beyond the external port.

---

### Platform boundary rules

The platform boundary is enforced by four rules. Violating any of them
requires a decision record.

**1. Daemon never manages containers directly.**
All script execution goes through the AI Executor (Layer 2). The daemon
submits jobs, receives exit codes and logs. It never runs `docker` commands.

**2. Daemon never owns schemas it does not control.**
Cycle metadata goes in `sle_*` tables in the shared PostgreSQL instance.
The daemon does not create its own sidecar database.

**3. Clients contain zero business logic.**
CLI, web UI, and Obsidian plugin are thin wrappers over REST + WebSocket.
All logic lives in the daemon.

**4. Rule files and prompts are data, not code.**
They live in the project repo, not in the daemon image. Two projects with
different rule files produce completely different system behaviour from the
same daemon binary.

---

### Validation: the cross-layer component

Validation is the only component that deliberately spans layers:

```
Layer 3 — LLM phase
  Evaluator agent reads artifacts, produces structured verdict
  (verdict, confidence, issues, evidence)

Layer 2 — Executable phase
  Generated test scripts submitted to AI Executor
  Runs in isolated containers, streams logs, returns exit codes

Layer 3 — Gate
  Aggregates both phases. All categories must pass.
  FailureReport fed back to Planner for next iteration.
```

The two phases catch different classes of problems and remain independent.
A category using `method: both` must pass both phases. A category using
`method: llm` or `method: executable` runs only one phase.

---

### The agent bootstrap pair

Every agent session starts by reading two files in order:

```
1. agent.md   → intent, conventions, constraints (human-authored, never touched by system)
2. map.yaml   → current system state (auto-generated after every cycle, never touched by human)
```

Together they answer every question an agent needs: what the project is, what
the current cycle state is, where everything lives, which rules are active,
and which tasks are available.

---

### Planning depth and quality tradeoff

Planning depth is the primary knob for trading speed against quality. Set in
`planning.yaml`, overridable per-cycle.

| Depth | Reasoning passes | Critic active | Artifact slice size | Use case |
|---|---|---|---|---|
| `minimal` | 1 | No | Smallest | Prototyping, quick iteration |
| `standard` | 2 | No | Medium | Normal development |
| `deep` | 3 | Yes | Large | Production systems |
| `research` | 4+ | Yes (multiple passes) | Largest | Complex architecture decisions |

Deeper passes get larger context windows (`artifact_slice_size` in tokens).
The Critic only runs at `deep` and `research` depth, triggered at the
`DESIGN` node.

---

### What SLE reuses vs what it adds

**Reused (no changes to existing services):**

| Platform service | How SLE uses it |
|---|---|
| AI Executor | Submits generated test scripts as jobs. Executor does not know about SLE. |
| PostgreSQL | New `sle_*` tables on the shared instance. Cycle metadata, iteration history. |
| Redis | pub/sub for daemon ↔ client event streaming and approval gate signals. |
| MinIO | Versioned artifact snapshots, reports, docs remote contents. |
| Docker network | Daemon joins `ai-network`, reaches services by name. |

**Net-new (SLE adds):**

| Component | Layer | Notes |
|---|---|---|
| SDK daemon container | 3 | Fastify server + DAG engine alongside BMAD |
| `packages/sle/` | 3 | TypeScript implementation: types, config, DAG, agents |
| `.sle/rules/` | 3 | Per-project YAML rule files |
| `.sle/tasks.yaml` | 3 | Local task store fallback (DDR-024) |
| Beads/Dolt remote | — | Issue tracking, agent memory — not a platform service |
| Cognee container | 3 | Optional knowledge engine (DDR-005) |
| pgvector extension | 1 | Added to shared PostgreSQL for vector storage |

---

## See also

| Document | What it covers |
|---|---|
| [what-is-sle.md](what-is-sle.md) | Core concept, principles, intent-to-validated flow |
| [cycle-model.md](cycle-model.md) | Conceptual walkthrough of a single cycle |
| [agent-roles.md](agent-roles.md) | All 10 roles, artifact ownership, conditional activation |
| [glossary.md](glossary.md) | Terms and definitions |
| [../reference/types.md](../reference/types.md) | Authoritative TypeScript types |
| [../reference/agents-yaml-schema.md](../reference/agents-yaml-schema.md) | Full `agents.yaml` schema |
| [../reference/rule-file-defaults.md](../reference/rule-file-defaults.md) | Default values for all 7 rule files |
| [../reference/map-yaml-schema.md](../reference/map-yaml-schema.md) | Auto-generated system state schema |
| [../reference/websocket-events.md](../reference/websocket-events.md) | WebSocket event reference |
| [../reference/error-codes.md](../reference/error-codes.md) | Error code reference |
| [../decisions/ddr-004-platform-layers.md](../decisions/ddr-004-platform-layers.md) | Layer placement decision |
| [../decisions/ddr-005-cognee-integration.md](../decisions/ddr-005-cognee-integration.md) | Knowledge engine decision |
| [../decisions/ddr-024-beads-required-or-optional.md](../decisions/ddr-024-beads-required-or-optional.md) | Task store fallback decision |
| [../decisions/ddr-002-rule-files-seven.md](../decisions/ddr-002-rule-files-seven.md) | Seven rule files decision |
