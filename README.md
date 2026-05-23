# Stratum 

> ⚠️ **Status: Under Active Development**  
> Stratum is currently in active development. While the codebase implements a fully functional sequential development cycle (Vertical Slice), advanced horizontal architectures (such as secure Docker sandboxing, parallel execution grids, and the web dashboard UI) detailed in the specifications are currently simplified or deferred. See the [Spec Divergence Audit](docs/developmentPlan/spec-divergence-audit.md) for details.

---

## What is Stratum?

Based on the core specifications, Stratum is a closed-loop development orchestration platform that transforms natural-language human intent into fully validated, production-ready software.

Instead of performing ad-hoc LLM code generation, Stratum executes a deterministic, multi-agent Directed Acyclic Graph (DAG) across a highly structured system lifecycle:

$$\text{Intent} \longrightarrow \text{Scoping} \longrightarrow \text{Design} \longrightarrow \text{Plan} \longrightarrow \text{Test} \longrightarrow \text{Confirm Gate} \longrightarrow \text{Build} \longrightarrow \text{Validation Gate} \longrightarrow \text{Snapshot}$$

### Key Characteristics (Spec-Driven)
*   **Bounded Multi-Agent Roles**: Orchestrates specialized agents (Designer, Planner, Tester, Builder, Debugger, Evaluator, Historian) within strict context windows to prevent LLM hallucination and scope drift.
*   **Validation-First Execution**: Code is never considered finished until it passes an automated three-phase check: static analysis (lint/type-check), semantic correctness (LLM evaluation), and functional test suites (runtime execution).
*   **Human-in-the-Loop Boundaries**: Integrates explicit confirmation gates (e.g., plans/tests review) ensuring the user remains the ultimate director of codebase evolution.

---

## 📁 Repository Map

```directory
.
├── src/                      # TS Core Engine (Sequential DAG Execution)
│   ├── daemon.ts             # REST server & state coordinator (port 8000)
│   ├── state-machine.ts      # Core lifecycle machine (5 states, 12 transitions)
│   ├── agent-loop.ts         # Multi-turn LLM reasoning loop with turn budgets
│   ├── dag-runner.ts         # DAG execution coordinator
│   └── rule-files.ts         # Validation rules validation using Zod
├── tests/                    # Core Engine Test Suite
└── docs/                     # Documentation Vault
    ├── overview/             # Mental models (e.g. what-is-sle.md)
    ├── specs/                # Target architectural specifications
    ├── decisions/            # Architectural Decision Records (DDR-001..030)
    └── developmentPlan/      # Roadmaps & spec-divergence audit files
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

### 3. Run the Daemon
```bash
node dist/cli.js start-daemon
```

---

## 📖 Essential Reading
*   **Conceptual Overview**: [what-is-sle.md](docs/overview/what-is-sle.md)
*   **Target Blueprints**: [docs/specs/README.md](docs/specs/README.md)
*   **Implementation Divergence (Must Read)**: [spec-divergence-audit.md](docs/developmentPlan/spec-divergence-audit.md)
