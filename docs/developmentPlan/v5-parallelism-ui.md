# Vertical Slice 5: Parallelism & UI Surface

**Type:** implementation plan · **Status:** not started · **Updated:** 2026-05-23  
**Slice:** v5 · **Prerequisites:** VS4 Complete (Docker execution pool, Link Index, standard REST API)

---

## 🗺️ 1. Overview

This implementation plan defines the development tasks to introduce advanced concurrency, reactive user boundaries, and a graphical shell into **Stratum v2**. Having established a secure, sandboxed core engine in VS4, we now add the advisory Critic routing loops, the 6-step Intake & Sharding pipeline, real-time WebSocket state broadcasting, and the 3-page local HTML desktop dashboard.

### 🎯 Target Specifications Reference
*   **Critic Node:** [dag-node-reference.md](../specs/dag-node-reference.md) (CRITIQUE node, advisory semantics, Designer loop-backs)
*   **Intake & Sharding:** [intake-and-sharding.md](../specs/intake-and-sharding.md) (intake, coherence gate, sharding, task creation, link updates)
*   **UI Shell Portal:** [ui-shell.md](../specs/ui-shell.md) & [tasks-dashboard.md](../specs/tasks-dashboard.md) (Overview panel array, Chat page, Graph visualization, widgets)
*   **WebSocket Event Bus:** [daemon-api.md](../specs/daemon-api.md) (dotted events, SLE-005 envelopes)

---

## 🔗 2. Dependency Map

### Files to Consume / Create

```directory
src/
├── event-bus.ts              # [NEW] Stateful EventBus mapping dotted events
├── cycle-runner.ts           # Extended: Critic routing and shard task execution loops
├── dag-runner.ts             # Extended: CRITIQUE node 3 & SHARDING_APPROVAL node 6
├── daemon.ts                 # Extended: WebSocket server handling upgrades (port 7700)
└── ui/                       # [NEW] HTML/JS Single Page UI Shell Desktop Portal
```

---

## 🛠️ 3. Phases

---

### Phase A: Critic Agent (`specs/dag-node-reference.md`)

**Goal:** Integrate the advisory Critic agent at the `CRITIQUE` node (Node 3) executing after `DESIGN` and before `PLAN` at `deep` and `research` depths, supporting Designer routing loopbacks.

#### Technical Specifications Mapping
1.  **Advisory Semantics:** The Critic cannot halt execution or trigger system failures. It compiles observations to guide Designer iterations.
2.  **Dual Outputs:**
    *   `doc:critique-feedback`: Markdown feedback injected directly into the Designer's next turn context.
    *   `node:critic:critique`: Ephemeral JSON run record logged under `.sle/runs/`.
3.  **Re-routing Mechanics:**
    *   When Critic reports `BLOCKING` status: loop DAG execution back to `DESIGN`, incrementing `design_revisions_used`.
    *   Verify loop cap checks: automatically bypass to `PLAN` once revision limits are reached.

**Files to modify/create:**
*   `src/dag-runner.ts` (re-wire node sequence)
*   `src/cycle-runner.ts` (implement re-routing and pass cap checks)
*   `tests/critic-agent.test.ts`

**Tests to Write (target: 10):**
*   Critic skipped at `minimal` and `standard` planning depths.
*   Blocking critique successfully loops execution back to the `DESIGN` node.
*   Dual outputs are written to their respective scopes.
*   Critic pass cap prevents infinite routing loops.

---

### Phase B: 6-Step Intake & Sharding Pipeline (`specs/intake-and-sharding.md`)

**Goal:** Implement the 6-step sharding pipeline decomposing high-level intents into concurrent sub-tasks under a unified cycle.

#### Technical Specifications Mapping
1.  **6-Step Pipeline sequence:**
    1.  *Document Intake*: Collect requirements and user input.
    2.  *Coherence Gate*: Check for conflict with existing `.sle/rules/`.
    3.  *Sharding*: Planner splits cycle into parallel sub-tasks (shards).
    4.  *Approval*: Pause at `SHARDING_APPROVAL` (Node 6) for user approval.
    5.  *Task Creation*: Write discrete tasks into the active workspace.
    6.  *Link Index Update*: Add trace-links connecting tasks to source documents.
2.  **Concurrency Invariant:**
    *   Sharding creates discrete sub-tasks inside a single cycle execution path. It does *not* spawn separate parallel cycles, ensuring strict lifecycle consistency.

**Files to modify:**
*   `src/cycle-runner.ts`
*   `src/dag-runner.ts`
*   `tests/intake-sharding.test.ts`

**Tests to Write (target: 10):**
*   Coherence gate detects and flags conflicting requirements.
*   DAG pauses and awaits user input at the `SHARDING_APPROVAL` gate.
*   Approved shards successfully compile as distinct tasks in `.sle/tasks.yaml`.
*   Link index updated with trace-links connecting new tasks back to design specs.

---

### Phase C: WebSocket Event Bus (`specs/daemon-api.md`)

**Goal:** Implement the typed `EventBus` and WebSocket server emitting standard `SLE-005` dotted events.

#### Technical Specifications Mapping
1.  **SLE-005 Event Envelope:**
    ```typescript
    export interface SLEEvent<T = unknown> {
      type: string;          // Dotted format: e.g. "cycle.started", "node.completed"
      cycle: string;
      iteration: number;
      timestamp: string;
      payload: T;
    }
    ```
2.  **WebSocket Gateway:**
    *   Set up upgrading handler in `src/daemon.ts` listening at `ws://localhost:7700/events`.
    *   Broadcast all events dynamically to connected clients without filtering.

**Files to modify/create:**
*   `src/event-bus.ts` (new)
*   `src/daemon.ts` (WebSocket server upgrade implementation)
*   `tests/event-bus.test.ts`

**Tests to Write (target: 8):**
*   `EventBus` correctly handles subscriptions.
*   Lifecycle state changes successfully emit correct dotted events.
*   WebSocket server upgrades connections and streams standard JSON envelopes.

---

### Phase D: UI Shell & Tasks Dashboard (`specs/ui-shell.md` & `specs/tasks-dashboard.md`)

**Goal:** Construct the 3-page local HTML desktop interface and dynamic widgets binding directly to WebSocket states.

#### Technical Specifications Mapping
1.  **3-Page Architecture:**
    *   *Overview Page*: Features 6 fixed panels (System Status, State Logs, Active Agent Window, Code Diff Viewer, Gate Control Panel, Token metrics).
    *   *Chat Page*: Interactive, multi-turn chat session interface.
    *   *Graph Page*: Interactive SVG node network visualizing the trace-link index.
2.  **Gate Overlay Modals:** Intercepts system execution during `CONFIRM` and `SHARDING_APPROVAL` states, prompting user actions.

**Files to create:**
*   `src/ui/index.html` (Overview, Chat, and Graph pages)
*   `src/ui/dashboard.js` (WebSockets and REST APIs binding)
*   `src/ui/styles.css` (Curated, harmonious HSL color styling)

**Tests to Write (target: 8):**
*   UI correctly establishes connection to local WebSocket server.
*   Dotted event streams dynamically update status and token panels.
*   Gate overlay overlays render and send REST posts on user approval.
