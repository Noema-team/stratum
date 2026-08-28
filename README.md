# Stratum 

> ⚠️ **Status: Under Active Development**  
> Stratum is currently in active development. Vertical Slices 1–6 are complete: the full development cycle engine, web dashboard UI, facilitator chat, document intake pipeline, critic agent, and WebSocket event bus are all implemented. Advanced features such as the knowledge engine (Cognee integration), Beads integration, and secure Docker sandboxing remain deferred. See the [Implementation Tracking](docs/developmentPlan/implementation-tracking.md) for the current coverage breakdown.

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
├── src/                      # TS Core Engine
│   ├── daemon.ts             # REST server & state coordinator (port 8000)
│   ├── state-machine.ts      # Core lifecycle machine (5 states, 12 transitions)
│   ├── dag-runner.ts         # DAG execution coordinator
│   ├── context-manager.ts    # 5-component context assembly with token budgeting
│   ├── critic-agent.ts       # LLM-backed design critic with revision loop
│   ├── intake-service.ts     # Document intake pipeline with 5-layer coherence gate
│   ├── sharding-service.ts   # Task decomposition with SHARDING_APPROVAL gate
│   ├── chat-service.ts       # Facilitator conversation with session persistence
│   ├── event-bus.ts          # WebSocket event bus (62+ event types)
│   ├── llm-provider.ts       # Multi-provider LLM abstraction (Anthropic/GLM/OpenRouter)
│   └── rule-files.ts         # Validation rule schemas (Zod)
├── public/                   # Web Dashboard (served by daemon)
│   ├── index.html            # 3-page SPA shell (Overview, Chat, Graph)
│   ├── index.js              # Client-side routing, WebSocket client, page logic
│   └── index.css             # Dashboard styles
├── tests/                    # Test suite
└── docs/                     # Documentation Vault
    ├── overview/             # Mental models (e.g. what-is-sle.md)
    ├── specs/                # Target architectural specifications
    ├── decisions/            # Architectural Decision Records (DDR-001..030)
    └── developmentPlan/      # Implementation tracking & roadmaps
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
# Foreground mode — starts daemon and opens the web dashboard in your browser
npx stratum

# Or manually
node dist/cli.js start-daemon
```

The dashboard is served at `http://localhost:8000` by default.

---

## 📖 Essential Reading
*   **Conceptual Overview**: [what-is-sle.md](docs/overview/what-is-sle.md)
*   **Target Blueprints**: [docs/specs/README.md](docs/specs/README.md)
*   **Implementation Coverage**: [implementation-tracking.md](docs/developmentPlan/implementation-tracking.md)
*   **Implementation Divergence**: [spec-divergence-audit.md](docs/developmentPlan/spec-divergence-audit.md)
