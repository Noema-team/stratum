# Stratum v2 — Spec vs. Implementation Divergence Audit

**Date:** 2026-05-23  
**Status:** Canonical Reference  
**Scope:** Stratum v2 Codebase (`src/sdk-orchestrator/v2/`) vs. Specifications (`docs/apps/sdk-orchestrator/v2/specs/`)

---

## Executive Summary

To deliver a functional, end-to-end learning cycle within three Vertical Slices, a **pragmatic execution model** was chosen. This allowed the system to boot, scope an intent, run a sequential chain of agents (Design, Plan, Test, Build), execute commands, capture failures, auto-debug, and snapshot the workspace. 

As a consequence of prioritizing this vertical slice flow, several horizontal architectures—such as secure sandboxing, parallel execution grids, semantic graph storage, and the web-based UI shell—were intentionally simplified or deferred.

This document serves as the canonical audit of every specification file in `specs/`, detailing its current implementation status, specific divergences, and architectural implications.

---

## Comprehensive Spec-by-Spec Audit

### 1. Backlog System (`specs/backlog-system.md`)
* **Status:** 📝 **Spec Only (100% Deferred)**
* **Spec Requirements:** A dynamic database layer managing features, bugs, tasks, and project debt with automated priority scoring, dependency mapping, and assignment to cycle shards.
* **Actual Implementation:** Zero implementation. There is no `backlog-service.ts` or local database manager, and cycle execution proceeds directly from a high-level intent pack.

### 2. Beads Integration (`specs/beads-integration.md`)
* **Status:** 📝 **Spec Only (100% Deferred)**
* **Spec Requirements:** Decomposing workspace requirements and file changes into "Beads" (fine-grained requirements metadata tracked via Git/Dolt remotes) to enforce strict schema-level tracking of changes.
* **Actual Implementation:** Zero implementation. The system tracks files using standard filesystem diffs and local JSON snapshot metadata, skipping granular semantic Beads synchronization.

### 3. Content Modules (`specs/content-modules.md`)
* **Status:** 📝 **Spec Only (100% Deferred)**
* **Spec Requirements:** A unified abstract filesystem layer managing modular repository directories, checking dependency imports, and preventing unrestricted file edits during execution.
* **Actual Implementation:** Zero implementation. Code generation and file edits are performed using raw Node.js `fs` calls directly on the user's workspace path.

### 4. Context Manager (`specs/context-manager.md`)
* **Status:** 🔶 **Partially Implemented (Major Divergence)**
* **Spec Requirements:** Smart, semantic, token-bounded context packing leveraging an active Vector database (Cognee) to pull relevant workspace symbols, dynamic sliding window token adjustment, and context indexing.
* **Actual Implementation:** `context-manager.ts` parses a basic local directory structure and performs simple text-slicing based on role rules. There is **no semantic crawler**, **no vector database lookup (RAG)**, and **no dynamic sliding window token optimization**. 

### 5. Conversation System (`specs/conversation.md`)
* **Status:** 🔶 **Partially Implemented (Minor Divergence)**
* **Spec Requirements:** A persistent, transactional conversation database recording multi-agent chat logs, dynamic prompt expansion, and REST API support for chat thread management.
* **Actual Implementation:** The multi-turn interaction log is kept purely in-memory inside the execution runner loop (`agent-loop.ts`) to manage step retries. There is no persistent conversation database or API endpoints implemented for external chat management.

### 6. Daemon API & Endpoints (`specs/daemon-api.md`, `specs/daemon-api-endpoints.md`)
* **Status:** 🔶 **Partially Implemented (Major Divergence)**
* **Spec Requirements:** 85 REST endpoints and a robust WebSocket event gateway for bidirectional real-time cycle status updates, dashboard actions, token counts, and chat interventions.
* **Actual Implementation:** Implements exactly **18 REST endpoints** (~21% coverage) necessary for cycle execution, scoping approval, and state machine transition gates. There is **no WebSocket server** (only stubbed event emitters in code) and no support for sharding, tags, task dashboards, or linking endpoints.

### 7. DAG Execution & Node Reference (`specs/dag-execution.md`, `specs/dag-node-reference.md`)
* **Status:** 🔶 **Partially Implemented (Major Divergence)**
* **Spec Requirements:** A highly dynamic, parallelized execution pipeline that supports sharded execution grids, automated child-runner delegation, custom execution node tags, and dynamic I/O registry maps.
* **Actual Implementation:** `dag-runner.ts` implements a purely sequential pipeline (DESIGN $\rightarrow$ PLAN $\rightarrow$ TEST $\rightarrow$ CONFIRM $\rightarrow$ BUILD $\rightarrow$ EXEC $\rightarrow$ EVALUATE $\rightarrow$ SUMMARISE $\rightarrow$ SNAPSHOT).
  * **No Parallelism**: All nodes run synchronously on a single thread.
  * **No Sharding**: Tasks are worked on as one monolithic context.
  * **Local File Resolution**: Inputs and outputs are resolved from static directories instead of a generic dynamic registration broker.
  * **Ignored Node Tags**: Custom DAG run-tags defined in the specification are ignored at runtime.

### 8. Document Linking (`specs/document-linking.md`)
* **Status:** 📝 **Spec Only (100% Deferred)**
* **Spec Requirements:** Advanced mapping protocols establishing bidirectional trace links between workspace specs, tests, source files, and task tickets.
* **Actual Implementation:** Unimplemented.

### 9. Init and Discovery (`specs/init-and-discovery.md`)
* **Status:** 🔶 **Partially Implemented (Major Divergence)**
* **Spec Requirements:** Deep credential scanning, recursive dependency tracking, external documentation repository cloning, interactive setup CLI menus, and a multi-round solo/full synthesis discovery protocol.
* **Actual Implementation:** `init-service.ts` and `discovery-service.ts` implement a highly streamlined version:
  * **Non-Interactive Only**: The interactive CLI prompt workflow is omitted; configuration values must be supplied as CLI flags or API parameters.
  * **No Remote Documentation Cloning**: Skips cloning external document repositories or checking beads.
  * **Solo-Mode Only**: The multi-round synthesis protocol is replaced with a 1-to-2 round echo verification of project rules.

### 10. Intake and Sharding (`specs/intake-and-sharding.md`)
* **Status:** 📝 **Spec Only (100% Deferred)**
* **Spec Requirements:** Decomposing user intents into distinct implementation branches (shards) that run concurrently in isolated sandboxes before final merging.
* **Actual Implementation:** Unimplemented. The engine runs on a single codebase snapshot.

### 11. Job Dispatch (`specs/job-dispatch.md`)
* **Status:** 📝 **Spec Only (100% Deferred)**
* **Spec Requirements:** A queue-based priority scheduler designed to broker runner instances, handle execution rate-limits, and execute job retries.
* **Actual Implementation:** Unimplemented. Cycles are scheduled directly and block state machine updates until execution finishes.

### 12. Knowledge Engine (`specs/knowledge-engine.md`)
* **Status:** 🛑 **Deprecated & Replaced (with Preserved Concepts)**
* **Spec Requirements:** An active background semantic crawler and knowledge graph database layer (Cognee FastAPI container over REST) to index files and run semantic similarity searches.
* **Actual Implementation:** The external Cognee database container has been deprecated and will not be used in Stratum. It is replaced by a custom, completely local **Link Index DAG** (specified in `document-linking.md`). However, three core design concepts from the knowledge spec are **fully preserved and integrated** into active subsystems:
  1. **`UnifiedMetadata` Schema**: Resolves Gap G32 by bridging files, links, and cycles into a shared query metadata model, enabling precise deterministic graph filtering.
  2. **`AssembledContext` Integration**: Integrates the knowledge search outputs as a formatted, budget-tracked 6th context component inside the agent's LLM window.
  3. **`CircuitBreaker` Pattern**: Stateful connection protection class (`open` / `closed` / `half-open` states) reused as an architectural design pattern to safeguard remote integrations (like the Anthropic API provider).

### 13. Project Overview (`specs/project-overview.md`)
* **Status:** 📝 **Spec Only (100% Deferred)**
* **Spec Requirements:** Auto-generating a global architectural and style system specification summarizing code layouts, frameworks, and design patterns.
* **Actual Implementation:** Unimplemented.

### 14. Prompt & Validation Templates (`specs/prompt-templates.md`, `specs/validation-prompts.md`)
* **Status:** 🔶 **Partially Implemented (Minor Divergence)**
* **Spec Requirements:** A runtime database registry of dynamic, parameterized templates with active caching rules.
* **Actual Implementation:** Caching headers are correctly set in the `AnthropicProvider` (with `@anthropic-ai/sdk`), but the prompt templates themselves are hardcoded inline strings in `prompt-templates.ts` instead of dynamic database assets.

### 15. Rule Files (`specs/rule-files.md`)
* **Status:** ✅ **Fully Implemented (Highly Compliant)**
* **Actual Implementation:** `rule-loader.ts` and `rule-files.ts` fully enforce the Zod configuration models, override priorities, default fallbacks, and layered config merges for all 7 designated files.

### 16. Run Artifacts (`specs/run-artifacts.md`)
* **Status:** 🔶 **Partially Implemented (Minor Divergence)**
* **Spec Requirements:** Tracking changes with structural delta vectors and detailed output packs.
* **Actual Implementation:** Fully tracks cycle manifests, writes Failure Reports, and logs output strings, but does not calculate granular programmatic diff maps (delta change vectors) for every file write.

### 17. State Machine (`specs/state-machine.md`)
* **Status:** ✅ **Fully Implemented (Highly Compliant)**
* **Actual Implementation:** The system state controller (`state-machine.ts`) enforces the 5 states, 12 transitions, transition guards, condition flags, and confirmation gates exactly as specified.

### 18. UI Shell, Tasks Dashboard & User Flow (`specs/ui-shell.md`, `specs/tasks-dashboard.md`, `specs/user-flow.md`)
* **Status:** 📝 **Spec Only (100% Deferred)**
* **Spec Requirements:** Web interface visualizing real-time execution steps, dynamic workspace file diffs, prompt overrides, and task boards.
* **Actual Implementation:** Zero implementation. The system is run exclusively via CLI commands (`sle init`, `sle discover`, `sle start`) or direct REST API requests to the daemon port.

### 19. Validation & Sandboxed Execution (`specs/validation.md`)
* **Status:** 🔶 **Partially Implemented (Major Divergence)**
* **Spec Requirements:** The `EXEC` node runs code in isolated Docker environments. The `VALIDATION_GATE` compiles code, runs test suites, lint rules, and security scans via an isolated runner grid.
* **Actual Implementation:** Docker sandboxing is deferred. `exec-service.ts` spawns native subprocesses directly on the host. `exec-gate.ts` reads execution exit codes and success metrics out of local map state files without performing separate test grid scans.

---

## Architectural Implications of the Divergences

1. **Security Vector**: Spawning host subprocesses in the `EXEC` node implies that running cycles has direct, unrestricted access to the user's host environment. Sandboxing (Docker) must be a high-priority integration before public SDK orchestrator deployment.
2. **Horizontal Scaling**: Because sharding, parallel execution, and queue-based dispatching are omitted, the daemon is currently restricted to running one sequential cycle on a single codebase at any given time.
3. **Intelligence Latency**: The lack of a semantic knowledge engine and active RAG queries means the LLM relies entirely on statically bundled local context slices. The agents have no mechanism to semantically search large workspaces, which may impact accuracy as codebase scale increases.
