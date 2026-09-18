# Stratum 

> ⚠️ **Status: Under Active Development**  
> Stratum is a control and orchestration plane for autonomous software work: it converts human objectives into bounded `WorkItem`s, dispatches agents through replaceable execution adapters, and surfaces only the decisions that need human attention. The control-plane migration (DDR-032) is substantially implemented — SQLite-backed domain entities, the generic `WorkflowEngine`, Scheduler authority, and durable checkpoint `Decision`s are all in place. Evidence-loop composition and the attention-first UI are still in progress. See the [Implementation Tracking](docs/developmentPlan/implementation-tracking.md) for the current coverage breakdown.

---

## What is Stratum?

Stratum is the control and orchestration plane above autonomous coding agents, not the agent itself. Human intent becomes a durable `Objective`, which is decomposed into bounded `WorkItem`s. Once a `WorkItem` is marked `READY`, the Scheduler is the sole authority for dispatching it:

```text
Control Plane (Workspace / Project / Objective)
    ↓
WorkItem — READY
    ↓
Scheduler
    ↓
ExecutionAdapter
    ↓
WorkflowEngine
    ↓
Decision / Evidence / Artifact
```

The kernel has no built-in knowledge of software-development methodology — that lives entirely in `WorkflowDefinition`s composed from six generic step kinds (`gather`, `produce`, `review`, `checkpoint`, `execute`, `commit`). `full-build` expresses the traditional design → test → build → validate pipeline as one such workflow running on the generic engine; `draft-artifact` is a lighter workflow for small, targeted changes without paying for the full pipeline. See [DDR-031](docs/decisions/ddr-031-workflow-generalization.md) (generic workflow engine), [DDR-032](docs/decisions/ddr-032-control-plane-migration.md) (control plane), and [DDR-033](docs/decisions/ddr-033-technology-independent-software-lifecycle.md) (current direction above them) for the architectural decisions.

### Key Characteristics
*   **Deterministic authority, agent proposals**: Agents propose work, artifacts, and decisions; only deterministic Stratum services (`WorkService`, `Scheduler`) mutate durable control-plane state.
*   **Generic workflow kernel**: Six step kinds replace a fixed pipeline. New methodology is added as a `WorkflowDefinition`, never by changing `WorkflowEngine`.
*   **Durable checkpoints**: Workflow checkpoints are first-class `Decision`s, persisted in SQLite and safe to resume after a restart — decision application does not depend on process memory.
*   **Evidence-based completion**: Work is not "done" because an agent says so; completion is gated on evidence (tests, CI, review) appropriate to the work contract.

---

## 📁 Repository Map

```directory
.
├── src/
│   ├── domain/                # Control-plane entities: Workspace, Project, Objective, WorkItem, Decision, Evidence, Event...
│   ├── workflow/               # Generic WorkflowEngine + built-in workflows (full-build, draft-artifact)
│   ├── scheduler/               # Scheduler authority: dispatches READY WorkItems, leases
│   ├── execution/                # ExecutionAdapter contract + adapters (StratumAgentAdapter, ClaudeCodeAdapter)
│   ├── evidence/                 # Evidence model + collectors
│   ├── storage/                  # SQLite persistence
│   ├── api/                      # Control-plane HTTP API + dashboard
│   ├── services/                  # Application services
│   ├── cli.ts                    # `stratum` CLI entry point
│   └── daemon.ts                  # Legacy single-project daemon, being retired per DDR-032
├── public/                       # Web dashboard (served by the control-plane API)
├── tests/                        # Test suite
└── docs/                         # Documentation Vault
    ├── overview/                 # Mental models (e.g. what-is-sle.md)
    ├── specs/                    # Target architectural specifications
    ├── decisions/                # Architectural Decision Records (DDR-001..033)
    └── developmentPlan/          # Implementation tracking & roadmaps
```

---

## ⚡ Quick Start

### 1. Install & Build
Ensure you are using Node.js `v20.0.0` or higher:
```bash
npm install
npm run build
```

### 2. Run Tests
```bash
npm test
```

### 3. Start Stratum
```bash
# Starts the control-plane daemon and opens the web dashboard in your browser
npx stratum

# Or manually
node dist/cli.js start
```

The dashboard is served at `http://localhost:7700` by default.

---

## 📖 Essential Reading
*   **Conceptual Overview**: [what-is-sle.md](docs/overview/what-is-sle.md)
*   **Target Blueprints**: [docs/specs/README.md](docs/specs/README.md)
*   **Implementation Coverage**: [implementation-tracking.md](docs/developmentPlan/implementation-tracking.md)
*   **Implementation Divergence**: [spec-divergence-audit.md](docs/developmentPlan/spec-divergence-audit.md)
