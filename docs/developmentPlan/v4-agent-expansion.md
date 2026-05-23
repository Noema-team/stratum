# Vertical Slice 4: Agent Expansion & Daemon Surface

**Type:** implementation plan · **Status:** not started · **Updated:** 2026-05-18
**Slice:** v4 · **Prerequisite:** VS3 complete (real EXEC subprocess, multi-turn agents, debugger recovery loop)

> **Spec audit corrections applied 2026-05-18.** The original draft of this plan contained four critical conflicts with the SLE spec. All have been corrected here. See §1.4 for a summary of the changes and §1.5 for VS3 divergences that carry forward into VS5.

---

## Implementation Progress

| Phase | Component | Status | Commit |
|-------|-----------|--------|--------|
| A | Critic Agent (CRITIQUE node — after DESIGN, before PLAN) | Not started | — |
| B | SHARDING_APPROVAL gate (between TEST and CONFIRM) | Not started | — |
| C | Event Bus (typed, SLE-005 compliant) | Not started | — |
| D | WebSocket server + REST API gap-fill | Not started | — |
| E | Integration tests (Critic cycle, Sharding gate, WS events, REST) | Not started | — |

---

## 1. Overview

### 1.1 What this slice delivers

After VS4, the system can:

1. Run a **Critic agent** at the DESIGN node on `deep` and `research` planning depth — it reviews architecture and requirements, routes back to the Designer on blocking issues, and proceeds to PLAN once satisfied (or when the pass limit is hit)
2. Pause at a **SHARDING_APPROVAL gate** when the Planner proposes decomposing the cycle into sub-tasks — user approves or rejects before proceeding to CONFIRM
3. Emit **SLE-005 compliant typed events** from every significant lifecycle moment through a shared `EventBus`
4. Serve those events in real time over a **WebSocket connection** at `ws://localhost:7700/events`
5. Respond to the **REST API gaps** identified in VS3: artifact reads (by registry ID), map reads, rule reads, and report reads

The integration tests prove: a `deep`-depth cycle where the Critic routes back to the Designer once then approves; a sharding gate approve/reject flow; a WebSocket client receiving all node events in correct sequence.

### 1.2 Theme: make agents structurally correct

VS3 proved execution is real and recoverable. VS4 corrects the agent roster and DAG structure to match the spec:

| VS3 | VS4 |
|-----|-----|
| CRITIQUE in `DEPTH_SKIP_NODES`, not in `DAG_SEQUENCE` | CRITIQUE at node 3 — after DESIGN, before PLAN |
| No SHARDING_APPROVAL node | SHARDING_APPROVAL at node 6 — between TEST and CONFIRM |
| `ROLE_OUTPUT_PATHS['critic'] = ['docs/critique.md']` (project file) | Critique output is run-scoped: `.sle/runs/{cycle}/{iteration}/critique.json` |
| DESIGN re-routing not implemented | On BLOCKING: cycle routes back to DESIGN with critique injected into context |
| Events emitted ad hoc | Typed `EventBus` with SLE-005 compliant envelope and dotted event names |
| `GET /api/v2/artifacts/*` (path glob) | `GET /api/v2/artifacts/:id` (registry ID, full response shape) |

### 1.3 Deliberate deferrals

| Item | Why deferred | Where it goes |
|---|---|---|
| Sharding task mechanics (actual sub-cycle split) | Complex system; SHARDING_APPROVAL gate is enough for VS4 | VS5 |
| EXPLORE node | Retired by DDR-028 (collapsed into SCOPING). Explorer research is now part of the Facilitator's guided scoping discussion | — (retired) |
| Docker container execution | Subprocess covers the interface; Docker is infra risk | VS5 |
| Knowledge engine (Cognee / embeddings) | Large external dependency | VS5 |
| Chat / facilitator agent (multi-turn with user) | Orthogonal to agent expansion | VS5 |
| UI shell | Frontend is a separate concern; WS events in VS4 are its foundation | VS5 |
| Full per-role tool permissions (DDR-030) | Both DDR-029 and DDR-030 are marked "deferred (post-MVP)" | VS5 |

### 1.4 Corrections from original draft

The first draft of this plan contained four critical conflicts with the SLE spec. All are corrected here:

| # | Original error | Correction |
|---|---|---|
| 1 | CRITIQUE placed after TEST, before CONFIRM (reviewing Planner output) | CRITIQUE runs after DESIGN, before PLAN (reviewing Designer output) per DDR-022 and `dag-node-reference.md` node 3 |
| 2 | EXPLORE added as an automatic node triggered by `src/` non-empty | EXPLORE was retired by DDR-028 (collapsed into SCOPING). DDR-023 explicitly prohibits auto-trigger. EXPLORE is removed from VS4. |
| 3 | SHARDING_APPROVAL missing from DAG_SEQUENCE | SHARDING_APPROVAL is canonical node 6. Added in Phase B. |
| 4 | `SLEEvent` used underscore names and inline union shape | SLE-005 specifies dotted names (`cycle.started`, `node.completed`) and flat envelope `{ type, cycle, iteration, timestamp, payload }` |

### 1.5 VS3 known divergences (carry forward to VS5)

These VS3 architectural decisions deviate from the spec but are not corrected in VS4 because correcting them would break all VS3 tests. They are documented here for VS5.

| Divergence | VS3 behaviour | Spec (`dag-node-reference.md`) |
|---|---|---|
| Node naming | `DEBUGGER` | `DEBUG` (node 12) |
| Debugger output | `ROLE_OUTPUT_PATHS['debugger'] = ['src/', 'tests/', 'scripts/']` — writes code | Ephemeral `doc:debug-diagnosis` only; "does not plan or build" |
| Recovery routing | VALIDATION_GATE fail → DEBUGGER → EXEC retry (same iteration) | VALIDATION_GATE fail → DEBUG → PLAN (next iteration) |
| Recovery cap | `MAX_DEBUG_ATTEMPTS = 3` (separate constant) | `max_iterations` from `exit.yaml` |
| `FailureReport` schema | `{ category, node, message, detail: { command, exit_code, stdout, stderr } }` | `{ cycle, iteration, run_dir, run_id, quick_summary, failed_categories: string[], passed_categories: string[] }` |

---

## 2. Dependency Map

```
This slice consumes (from VS3 + specs):
  dag-runner.ts           DAGRunner.runNode, skipNode, shouldSkipAtDepth
  cycle-runner.ts         CycleRunner orchestration (VALIDATION_GATE handler, human gate pattern)
  confirm-service.ts      ConfirmService (pattern for SHARDING_APPROVAL gate)
  agent-runner.ts         ROLE_OUTPUT_PATHS, NODE_TO_ROLE (critic paths corrected here)
  context-manager.ts      ROLE_ARTIFACT_PATHS (critic: architecture + evaluation — corrected here)
  daemon.ts               DaemonServer HTTP routing (extended with WS + new REST routes)
  run-artifacts.ts        RunArtifactManager (critique.json written to run dir)
  runtime-map.ts          RuntimeMapManagerImpl (extended with sharding_proposal flag)
  SLE-005                 Event payload spec (dotted names, flat envelope)
  dag-node-reference.md   Node 3 (CRITIQUE), Node 6 (SHARDING_APPROVAL) definitions

This slice produces (consumed by VS5+):
  VS5: Sharding task mechanics (SHARDING_APPROVAL gate is the hook)
  VS5: Full Docker EXEC (EventBus exec events are the observability layer)
  VS5: UI shell (WebSocket event stream)
  VS5: DDR-030 full tool permissions (EventBus node events carry role info for auditing)
  VS5: VS3 divergence corrections (DEBUG rename, Debugger output paths, cross-iteration recovery)
```

```
Dependency flow within this slice:

  Phase A (Critic Agent — CRITIQUE node)
    |
    v
  Phase B (SHARDING_APPROVAL gate)    ← A and B are independent; can develop in parallel
    |
    v
  Phase C (Event Bus)                 ← depends on A+B (emits events from all new nodes)
    |
    v
  Phase D (WebSocket + REST gaps)     ← depends on C (WS server subscribes to EventBus)
    |
    v
  Phase E (Integration Tests)         ← depends on all phases
```

---

## 3. Phases

---

### Phase A — Critic Agent (CRITIQUE node)

**Goal:** Add CRITIQUE to `DAG_SEQUENCE` at node 3, immediately after DESIGN and before PLAN. At `deep` and `research` depth, the Critic reviews `architecture.md` and `requirements.md`, injects a structured `CritiqueResult` into the Designer's context, and routes back to DESIGN when blocking issues are found. The cycle proceeds to PLAN once the Critic approves or the depth's pass limit is hit. At `minimal` and `standard` depth, CRITIQUE is skipped (already pre-wired in `DEPTH_SKIP_NODES`). The Critic is advisory — it never halts the DAG at the system level.

**Files to change:**
- `src/sdk-orchestrator/v3/src/dag-runner.ts` (add CRITIQUE to `DAG_SEQUENCE` at index 2; remove comment `"excludes CRITIQUE which is always skipped"`)
- `src/sdk-orchestrator/v3/src/agent-runner.ts` (add `CRITIQUE: 'critic'` to `NODE_TO_ROLE`; correct `ROLE_OUTPUT_PATHS['critic']` from `['docs/critique.md']` to `['.sle/runs/']`)
- `src/sdk-orchestrator/v3/src/context-manager.ts` (correct `ROLE_ARTIFACT_PATHS['critic']`: `architecture + requirements + evaluation`; add `critique_result` slice for Designer re-routing)
- `src/sdk-orchestrator/v3/src/cycle-runner.ts` (add CRITIQUE handler; depth-dependent pass limit; route back to DESIGN on BLOCKING; `design_revisions_used` in `CycleRunResult`)
- `src/sdk-orchestrator/v3/src/types.ts` (extend `CycleRunResult` with `design_revisions_used: number`; extend `CycleStateContext` with `critique_result?: CritiqueResult`)
- `src/sdk-orchestrator/v4/tests/critic-agent.test.ts` (new)
- `src/sdk-orchestrator/v4/tests/cycle-runner-critique.test.ts` (new)

**DAG changes:**

```typescript
// Updated DAG_SEQUENCE (VS4):
export const DAG_SEQUENCE: readonly DAGNodeId[] = [
  'SCOPING', 'DESIGN', 'CRITIQUE', 'PLAN', 'TEST', 'SHARDING_APPROVAL', 'CONFIRM',
  'BUILD', 'HISTORY', 'EXEC', 'VALIDATION_GATE', 'EVALUATE', 'SUMMARISE', 'SNAPSHOT',
] as const;
// NOTE: DEBUG (VS3: DEBUGGER) is not in DAG_SEQUENCE — CycleRunner routes to it directly
// on VALIDATION_GATE failure. See VS3 known divergences in §1.5.

// NODE_TO_ROLE:
CRITIQUE: 'critic',

// DEPTH_SKIP_NODES (already correct — CRITIQUE skipped at minimal/standard):
CRITIQUE: ['minimal', 'standard'],
```

**`CritiqueResult` type (spec: `dag-node-reference.md` Node 3):**

```typescript
export interface CritiqueResult {
  blocking_issues: string[];
  warnings:        string[];
  suggestions:     string[];
  pass:            boolean;
}
```

The Critic produces `CritiqueResult` as a JSON section in its SLE-OUTPUT block, written to `.sle/runs/{cycle}/{iteration}/critique.json`. This is run-scoped (ephemeral) — it is **not** written to `docs/` as a project-level persistent file.

```
<<<SLE-OUTPUT>>>
### .sle/runs/{cycle}/{iteration}/critique.json
{
  "blocking_issues": ["Architecture section X is underspecified — missing error handling model"],
  "warnings": ["requirements.md §3.2 references a module not described in architecture"],
  "suggestions": ["Consider adding a retry policy to the API layer"],
  "pass": false
}
<<<END-SLE-OUTPUT>>>
```

**Role artifact path corrections:**

```typescript
// In agent-runner.ts — ROLE_OUTPUT_PATHS:
critic: ['.sle/runs/'],  // was: ['docs/critique.md'] — corrected per dag-node-reference.md Node 3

// In context-manager.ts — ROLE_ARTIFACT_PATHS:
critic: ['docs/architecture.md', 'docs/requirements.md', 'docs/evaluation.md'],
// Reads: architecture (Designer output) + requirements (Designer output) + evaluation (prior cycle)
// Does NOT read: docs/plan.md (plan doesn't exist yet at CRITIQUE time)
```

**CycleRunner CRITIQUE handler:**

```typescript
// Pass limit is depth-dependent (dag-node-reference.md Node 3):
// depth: 'deep'     → maxCritiquePasses = 1
// depth: 'research' → maxCritiquePasses = 3
function maxCritiquePasses(depth: PlanningDepth): number {
  return depth === 'research' ? 3 : 1;
}

if (nodeId === 'CRITIQUE') {
  const result = await this.deps.dagRunner.runNode('CRITIQUE', cycleState);
  if (!result.success) {
    // Critic LLM failure is non-fatal (dag-node-reference.md Node 3):
    // "If the Critic itself errors, the cycle proceeds without critique — a warning is logged."
    currentNode = 'PLAN';
    continue;
  }

  const critiqueResult = await this.readCritiqueResult(cycleNumber, iteration);
  if (!critiqueResult.pass) {
    this.designRevisions++;
    if (this.designRevisions > maxCritiquePasses(cycleState.planning_depth)) {
      // Pass limit hit — proceed with warnings (Critic is advisory, not blocking)
      currentNode = 'PLAN';
      continue;
    }
    // Route back to DESIGN with critique injected into cycleState
    cycleState = { ...cycleState, critique_result: critiqueResult };
    currentNode = 'DESIGN';
    continue;
  }

  currentNode = 'PLAN';
  continue;
}
```

**Designer context when re-routed from CRITIQUE:**

When `cycleState.critique_result` is present, `ContextManager.assemble()` for the `designer` role includes the critique JSON as an additional context section. The Designer reads it as a structured review of its prior draft.

```typescript
// In context-manager.ts — ContextManager.assemble() for designer role:
if (cycleState.critique_result) {
  const critiqueFormatted = this.formatCritiqueContext(cycleState.critique_result);
  // Injected after state summary, before artifact slices
}
```

`CycleRunResult` extension:

```typescript
export interface CycleRunResult {
  completed: boolean;
  final_node: DAGNodeId | null;
  debug_attempts_used: number;
  design_revisions_used: number;  // new in VS4: Critic-triggered DESIGN re-runs
  failure_report?: FailureReport;
  error?: string;
}
```

**Tests (target: 18):**

*Critic agent unit tests:*
- `roleForNode('CRITIQUE')` → `'critic'`
- `validateOutputPath('.sle/runs/1-1/critique.json', 'critic')` → true
- `validateOutputPath('docs/critique.md', 'critic')` → false (no longer a project-level file)
- `validateOutputPath('docs/requirements.md', 'critic')` → false (critic does not rewrite)
- `validateOutputPath('src/index.ts', 'critic')` → false
- `shouldSkipAtDepth('CRITIQUE', 'minimal')` → true
- `shouldSkipAtDepth('CRITIQUE', 'standard')` → true
- `shouldSkipAtDepth('CRITIQUE', 'deep')` → false
- `shouldSkipAtDepth('CRITIQUE', 'research')` → false
- `ROLE_ARTIFACT_PATHS['critic']` includes `'docs/architecture.md'` and `'docs/evaluation.md'`
- `ROLE_ARTIFACT_PATHS['critic']` does NOT include `'docs/plan.md'`
- DAG_SEQUENCE includes 'CRITIQUE' at index 2 (after 'DESIGN', before 'PLAN')
- `nextNode('DESIGN')` → `'CRITIQUE'`
- `nextNode('CRITIQUE')` → `'PLAN'`

*CycleRunner critique loop:*
- CRITIQUE `pass: true` → proceeds to PLAN; `design_revisions_used: 0`
- CRITIQUE `pass: false` (once) → routes back to DESIGN; second CRITIQUE `pass: true` → PLAN; `design_revisions_used: 1`
- CRITIQUE `pass: false` at `deep` depth × 2 → forced-proceed to PLAN after pass limit (1); `design_revisions_used: 1`
- CRITIQUE `pass: false` at `research` depth × 4 → forced-proceed to PLAN after pass limit (3); `design_revisions_used: 3`
- Critic LLM failure → proceeds to PLAN immediately; `design_revisions_used: 0`

**Testing method:** Unit tests mock `DAGRunner.runNode()` and mock `readCritiqueResult()`. Program Critic mock to return `pass: false` N times then `pass: true`. No real LLM calls.

---

### Phase B — SHARDING_APPROVAL Gate

**Goal:** Add `SHARDING_APPROVAL` to `DAG_SEQUENCE` at node 6, between TEST and CONFIRM. The Planner may produce a `ShardingProposal` alongside `plan.md`. When it does, `CycleRunner` pauses at `SHARDING_APPROVAL` and sets `map.cycle.awaiting_sharding_approval = true`. The user approves (proceed to CONFIRM with sharding flag set) or rejects (proceed to CONFIRM without sharding). When no proposal exists, the node is skipped transparently. The actual sharding task mechanics — creating sub-cycles, tracking Beads tasks — are deferred to VS5.

**Files to change:**
- `src/sdk-orchestrator/v3/src/dag-runner.ts` (SHARDING_APPROVAL already in `DAG_SEQUENCE` from Phase A; add skip logic: skip when no sharding proposal)
- `src/sdk-orchestrator/v3/src/cycle-runner.ts` (add `SHARDING_APPROVAL` handler: pause loop, expose approve/reject to daemon)
- `src/sdk-orchestrator/v3/src/daemon.ts` (add `POST /api/v2/cycles/sharding/approve` and `POST /api/v2/cycles/sharding/reject`)
- `src/sdk-orchestrator/v3/src/runtime-map.ts` (extend `RuntimeMap` Zod schema with `sharding_proposal` and `sharding_approved` fields on cycle object)
- `src/sdk-orchestrator/v4/tests/sharding-approval.test.ts` (new)

**Activation rule (from `dag-node-reference.md` Node 6):**

```typescript
// SHARDING_APPROVAL is skipped when the Planner produced no proposal.
// The proposal is written to map.cycle.sharding_proposal by the PLAN node.
// shouldSkipNode() checks for its presence.

async function shouldSkipNode(
  nodeId: DAGNodeId,
  depth: PlanningDepth,
  map: RuntimeMap
): Promise<boolean> {
  if (shouldSkipAtDepth(nodeId, depth)) return true;

  if (nodeId === 'SHARDING_APPROVAL') {
    // Skip when no sharding proposal was produced by PLAN
    return !(map.cycle as { sharding_proposal?: unknown }).sharding_proposal;
  }

  return false;
}
```

**CycleRunner SHARDING_APPROVAL handler:**

```typescript
if (nodeId === 'SHARDING_APPROVAL') {
  // Pause the loop: set flag in map, wait for external signal
  await this.deps.mapManager.update((m) => ({
    ...m,
    cycle: { ...m.cycle, awaiting_sharding_approval: true },
  }));

  // Block until shardingGateService.gate() resolves
  // (daemon's approve/reject endpoints resolve this promise)
  await this.deps.shardingGateService.gate(cycleNumber, iteration);

  const decision = await this.deps.shardingGateService.getDecision();
  await this.deps.mapManager.update((m) => ({
    ...m,
    cycle: {
      ...m.cycle,
      awaiting_sharding_approval: false,
      sharding_approved: decision === 'approve',
    },
  }));

  currentNode = 'CONFIRM';
  continue;
}
```

**New REST endpoints:**

```
POST /api/v2/cycles/sharding/approve
  → resolves shardingGateService.gate()
  → { ok: true, data: { approved: true } }

POST /api/v2/cycles/sharding/reject
  → resolves shardingGateService.gate() with 'reject'
  → { ok: true, data: { approved: false } }
```

**RuntimeMap extension:**

```typescript
// In cycle object (Zod schema extended):
sharding_proposal?: {
  task_count: number;
  task_titles: string[];
};
sharding_approved?: boolean;
```

**Tests (target: 12):**
- `shouldSkipNode('SHARDING_APPROVAL', 'standard', map)` → true when `map.cycle.sharding_proposal` is absent
- `shouldSkipNode('SHARDING_APPROVAL', 'standard', map)` → false when `map.cycle.sharding_proposal` is set
- `shouldSkipNode('CONFIRM', 'standard', map)` → false (CONFIRM has its own approval_required skip rule, not affected)
- `nextNode('TEST')` → `'SHARDING_APPROVAL'`
- `nextNode('SHARDING_APPROVAL')` → `'CONFIRM'`
- DAG_SEQUENCE includes 'SHARDING_APPROVAL' at index 5 (after 'TEST', before 'CONFIRM')
- CycleRunner: no proposal → SHARDING_APPROVAL skipped, CONFIRM reached directly
- CycleRunner: proposal present → `awaiting_sharding_approval = true` set in map while gate is open
- `POST /api/v2/cycles/sharding/approve` → `awaiting_sharding_approval = false`, `sharding_approved = true`, cycle continues to CONFIRM
- `POST /api/v2/cycles/sharding/reject` → `awaiting_sharding_approval = false`, `sharding_approved = false`, cycle continues to CONFIRM
- `POST /api/v2/cycles/sharding/approve` when no sharding gate is open → 409 conflict
- `sharding_approved` flag is false after reject and cycle still reaches SNAPSHOT

**Testing method:** Unit tests mock `shardingGateService.gate()` to resolve immediately with a pre-programmed decision. REST endpoint tests start `DaemonServer` on an ephemeral port with a mock gate service. No real filesystem writes except under a temp directory.

---

### Phase C — Event Bus

**Goal:** Introduce a typed `EventBus` class in a new `src/event-bus.ts` module. All significant lifecycle moments emit structured events using the SLE-005 compliant envelope. The bus uses a simple subscriber model with no external dependencies. The WebSocket server (Phase D) subscribes to it and re-broadcasts to connected clients.

**Files to change:**
- `src/sdk-orchestrator/v3/src/event-bus.ts` (new)
- `src/sdk-orchestrator/v3/src/dag-runner.ts` (accept optional `EventBus`; emit `node.started`, `node.completed`, `node.skipped`, `node.failed`)
- `src/sdk-orchestrator/v3/src/cycle-runner.ts` (accept optional `EventBus`; emit `cycle.started`, `cycle.completed`, `cycle.halted`)
- `src/sdk-orchestrator/v3/src/exec-service.ts` (emit `node.started`, `node.completed`, `node.failed` for EXEC)
- `src/sdk-orchestrator/v3/src/validation-gate.ts` (emit `gate.result`, `validation.category.started`, `validation.category.completed`)
- `src/sdk-orchestrator/v4/tests/event-bus.test.ts` (new)

**SLE-005 event envelope (flat, per spec):**

```typescript
// SLE-005 §WebSocket protocol:
export interface SLEEventEnvelope {
  type:      string;      // dotted notation: 'cycle.started', 'node.completed', etc.
  cycle:     number;
  iteration: number;
  timestamp: string;      // ISO 8601
  payload:   unknown;
  sequence:  number;      // extension: monotonically incrementing per EventBus instance (not in SLE-005 but needed for ordering)
}
```

**Event types and payloads (SLE-005 §Event types + dag-execution.md §WebSocket events):**

```typescript
export type SLEEventPayloadMap = {
  'cycle.started':                  { depth: PlanningDepth; categories_pending: string[] };
  'cycle.completed':                { version_id: string; summary_path: string };
  'cycle.halted':                   { reason: string; iteration: number; report_path: string };
  'node.started':                   { node_id: DAGNodeId; agent_role?: AgentRole; revision?: number };
  'node.completed':                 { node_id: DAGNodeId; outcome: 'success' | 'skipped'; duration_ms: number };
  'node.failed':                    { node_id: DAGNodeId; error: string };
  'validation.category.started':    { category: string; method: ValidationMethod };
  'validation.category.completed':  { category: string; result: CategoryResult };
  'gate.result':                    { outcome: 'pass' | 'fail'; failed_categories: string[] };
  'approval.required':              { gate: string; prompt: string };
  'artifact.updated':               { artifact_id: string; path: string };
  'error':                          { message: string; node_id?: DAGNodeId; recoverable: boolean };
};
```

**`EventBus` class:**

```typescript
export class EventBus {
  private subscribers: Array<(envelope: SLEEventEnvelope) => void> = [];
  private sequence = 0;

  subscribe(fn: (envelope: SLEEventEnvelope) => void): () => void {
    this.subscribers.push(fn);
    return () => { this.subscribers = this.subscribers.filter(s => s !== fn); };
  }

  emit<T extends keyof SLEEventPayloadMap>(
    type: T,
    cycle: number,
    iteration: number,
    payload: SLEEventPayloadMap[T]
  ): void {
    const envelope: SLEEventEnvelope = {
      type, cycle, iteration, payload,
      timestamp: new Date().toISOString(),
      sequence: ++this.sequence,
    };
    for (const sub of this.subscribers) sub(envelope);
  }
}
```

**Injection pattern:**

All emitting services accept `EventBus` as an optional constructor parameter. If omitted, a default no-op bus is used (one with zero subscribers). Existing VS3 tests pass an `EventBus`-less service and are unaffected.

```typescript
// In DAGRunner (example):
constructor(
  private agentRunner: AgentRunner,
  private mapManager: RuntimeMapManager,
  private runArtifacts: RunArtifactManager,
  private eventBus: EventBus = new EventBus()
) {}
```

**Tests (target: 16):**
- `EventBus.emit()` calls all subscribers with correct `type`, `cycle`, `iteration`, `payload`
- Emitted envelope includes `timestamp` (ISO string) and monotonically incrementing `sequence`
- `subscribe()` returns an unsubscribe function; after calling it, subscriber receives no further events
- Multiple subscribers all receive the same event
- `EventBus` with zero subscribers does not throw
- `DAGRunner.runNode()` emits `node.started` before agent runs; `node.completed` with `duration_ms` on success
- `DAGRunner.runNode()` emits `node.failed` on agent failure
- `DAGRunner.skipNode()` emits `node.completed` with `outcome: 'skipped'`
- `CycleRunner.run()` emits `cycle.started` before first node; `cycle.completed` on success; `cycle.halted` on halt
- `ValidationGateService.run()` emits `gate.result` with `outcome` and `failed_categories`
- `ValidationGateService.run()` emits `validation.category.started` and `validation.category.completed` per category
- `approval.required` emitted when CONFIRM gate opens (cycle paused for user)
- `artifact.updated` emitted when `DAGRunner.updateArtifactEntries()` writes an artifact
- `error` event includes `node_id` and `recoverable: boolean`; emitted on non-fatal errors
- Event `type` uses dotted notation throughout (`'cycle.started'`, not `'cycle_started'`)
- `payload` field at top level of envelope — not inlined (spec-compliant flat structure)

**Testing method:** Pure unit tests. Capture events via `subscribe()` into an array. Assert event type, field values, and sequence order. No real processes or API calls.

---

### Phase D — WebSocket Server + REST API Gap-Fill

**Goal:** Upgrade `DaemonServer` to serve a WebSocket endpoint at `ws://localhost:7700/events` that broadcasts `SLEEventEnvelope` payloads to connected clients. Add 7 missing REST endpoints that clients need to read state and artifacts. The server accepts an `EventBus` in its dependency injection and subscribes on start.

**Files to change:**
- `src/sdk-orchestrator/v3/src/daemon.ts` (add `WebSocketServer` on existing `http.Server`; 7 new REST routes; `ShardingGateService` in `DaemonDeps`)
- `src/sdk-orchestrator/v3/package.json` (add `ws` ^8.x dependency)
- `src/sdk-orchestrator/v4/tests/daemon-ws.test.ts` (new)
- `src/sdk-orchestrator/v4/tests/daemon-rest-gaps.test.ts` (new)

**WebSocket implementation:**

The `ws` package attaches a `WebSocketServer` to the existing `http.Server` instance. No port change; the WS upgrade is distinguished from HTTP by the `Upgrade` header.

```typescript
import { WebSocketServer, type WebSocket } from 'ws';

// In DaemonServer.start():
const wss = new WebSocketServer({ server: this.server, path: '/events' });
const clients = new Set<WebSocket>();

wss.on('connection', async (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
  // Send current state snapshot on connect so mid-cycle connections get context
  ws.send(JSON.stringify(await this.buildStateSnapshot()));
});

const unsubscribe = this.deps.eventBus.subscribe((envelope) => {
  const msg = JSON.stringify(envelope);
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
});

// In DaemonServer.stop():
unsubscribe();
wss.close();
```

**State snapshot on connect (sent before event stream begins):**

```typescript
export interface StateSnapshot {
  type: 'state_snapshot';
  timestamp: string;
  system_status: SystemStatus;
  current_cycle: number | null;
  current_node: string | null;
  dag_completed_nodes: string[];
}
```

**New REST endpoints (7):**

| Method | Path | Description | Response shape |
|--------|------|-------------|----------------|
| GET | `/api/v2/map` | Read the full `RuntimeMap` as parsed JSON | `{ ok: true, data: RuntimeMap }` |
| GET | `/api/v2/rules` | Return merged `RuntimeConfig` (parsed rule files) | `{ ok: true, data: RuntimeConfig }` |
| GET | `/api/v2/artifacts` | List all artifacts registered in the map | `{ ok: true, data: { artifacts: ArtifactEntry[] } }` |
| GET | `/api/v2/artifacts/:id` | Read artifact by **registry ID** (not path) | `{ ok: true, data: { id, path, content, last_updated, dirty } }` |
| GET | `/api/v2/reports/latest` | Read latest validation report path + content | `{ ok: true, data: { path, content, generated_at } \| null }` |
| GET | `/api/v2/runs/:cycle/:iteration/manifest` | Read run manifest JSON | `{ ok: true, data: RunManifest }` |
| GET | `/api/v2/runs/:cycle/:iteration/node-outputs/:nodeId` | Read raw LLM output for a node | `{ ok: true, data: { path, content } }` |

**Artifact endpoint note:** `GET /api/v2/artifacts/:id` uses the `id` field from `ArtifactEntry` (the registry ID, e.g. `"requirements"`, `"architecture"`), not a filesystem path. The daemon maps `id → path` via the `map.artifacts` array. A request for an unknown `id` returns 404.

**Path safety on all file-reading endpoints:**

All endpoints that read from the filesystem validate that the resolved path remains within `projectRoot`. Reject with 400 on any path that resolves outside the project root.

```typescript
function resolveSafe(projectRoot: string, relativePath: string): string | null {
  const resolved = path.resolve(projectRoot, relativePath);
  return resolved.startsWith(projectRoot + path.sep) || resolved === projectRoot
    ? resolved
    : null;
}
```

**Tests — WebSocket (target: 10):**
- Client connects to `/events` and receives `state_snapshot` as the first message
- `cycle.started` event emitted by EventBus → all connected clients receive it with correct envelope shape
- `node.completed` event → all connected clients receive it
- Client disconnects mid-cycle → no further messages sent to that client (no EPIPE)
- Second client connects after cycle starts → receives `state_snapshot`, then subsequent events
- WS client `close` event → removed from client set
- `DaemonServer.stop()` closes all WS connections cleanly
- `state_snapshot.dag_completed_nodes` reflects nodes already completed at connect time
- Message JSON parses to valid `SLEEventEnvelope` shape with `type`, `cycle`, `iteration`, `timestamp`, `payload`, `sequence`
- HTTP GET to `/events` returns 404 (not a WebSocket upgrade — standard HTTP path)

**Tests — REST gap-fill (target: 10):**
- `GET /api/v2/map` → 200, returns parsed `RuntimeMap` JSON
- `GET /api/v2/rules` → 200, returns merged `RuntimeConfig`
- `GET /api/v2/artifacts` → 200, returns `{ artifacts: ArtifactEntry[] }`
- `GET /api/v2/artifacts/requirements` → 200, returns `{ id: 'requirements', path: 'docs/requirements.md', content: '...', last_updated, dirty }`
- `GET /api/v2/artifacts/nonexistent` → 404
- `GET /api/v2/reports/latest` → 200 with `null` when no report exists
- `GET /api/v2/reports/latest` → 200 with `{ path, content, generated_at }` when report exists
- `GET /api/v2/runs/1/1/manifest` → 200, returns `RunManifest`
- `GET /api/v2/runs/1/1/node-outputs/DESIGN` → 200, returns raw output content
- `GET /api/v2/runs/99/99/manifest` → 404 when run directory does not exist

**Testing method:** `DaemonServer` started on an ephemeral port (`:0`) in each test. HTTP tests use Node.js built-in `http.request`. WS tests use the `ws` client. Mock `EventBus`, `RuntimeMapManager`, `RunArtifactManager`, `ShardingGateService`. Real temp directories for filesystem read tests.

---

### Phase E — Integration Tests

**Goal:** Prove the end-to-end VS4 paths: a `deep`-depth cycle where the Critic blocks the Designer once; a cycle where SHARDING_APPROVAL fires and is approved; a WebSocket client receiving all node events in sequence; the new REST endpoints returning correct data.

**Files:**
- `src/sdk-orchestrator/v4/tests/cycle-runner-integration.test.ts` (new — VS4 integration harness)

Real services wired together with mock LLM and real `EventBus`, real `DaemonServer` on ephemeral port.

**Integration test scenarios:**

| Test | Description | Expected |
|---|---|---|
| VS4-INT-01 | Critic approves first pass: `deep` depth, Critic returns `pass: true` | `completed: true`; `design_revisions_used: 0`; `node.completed` events for CRITIQUE in WS stream |
| VS4-INT-02 | Critic blocks once: `deep` depth, Critic returns `pass: false` then `pass: true` | `completed: true`; `design_revisions_used: 1`; two DESIGN events and two CRITIQUE events in WS stream |
| VS4-INT-03 | Critic pass limit: `deep` depth, Critic returns `pass: false` twice | `completed: true`; `design_revisions_used: 1` (pass limit for `deep` = 1); forced-proceed to PLAN |
| VS4-INT-04 | Sharding approve: Planner writes `sharding_proposal`; user approves gate | `completed: true`; `sharding_approved: true` in map; `approval.required` event emitted |
| VS4-INT-05 | Sharding reject: Planner writes `sharding_proposal`; user rejects gate | `completed: true`; `sharding_approved: false` in map; cycle still reaches SNAPSHOT |
| VS4-INT-06 | WebSocket events: full cycle at `standard` depth; WS client connected | Client receives `cycle.started`, `node.started`/`node.completed` for each node, `cycle.completed` — in monotonic sequence order; `CRITIQUE` events absent (depth=standard, skipped) |

**Real services used (VS4 integration harness):**
- `EventBus` (real — subscribers record all events in array)
- `RuntimeMapManagerImpl`
- `RunArtifactManager`
- `ContextManager`
- `AgentRunner` (mock LLM: `VS4MockLLM`)
- `DAGRunner` (real, with real `EventBus`)
- `CycleRunner` (real, with real `EventBus`)
- `ExecServiceReal` (mock spawn — always exits 0)
- `ValidationGateService`
- `SnapshotService`
- `SummariseService`
- `ConfirmService` (auto-approve)
- `ShardingGateService` (resolve programmatically per test)
- `DaemonServer` (ephemeral port for REST/WS tests)

**`VS4MockLLM`:**

Extends VS3's `VS3MockLLM`. Detects node from `Current node: ${node}` in the user message. For CRITIQUE, returns a pre-programmed `CritiqueResult` — either `pass: true` or `pass: false` based on a configurable call counter. When PLAN is called with `sharding_proposal` injected, includes a `sharding_proposal` block in the output.

Each integration test asserts:
- `result.completed`, `result.design_revisions_used`
- Map state (`sharding_approved`, DAG completed nodes)
- Events captured by subscriber (type, `node_id` in payload, monotonic sequence)
- REST endpoint response bodies (for VS4-INT-06)

**Testing method:** Mock LLM and mock spawn. Real services. Temp directories per test. `DaemonServer` on `:0`. WS client connects before cycle starts; disconnects after `cycle.completed`.

---

## 4. Test Count Summary

| Phase | Component | Unit tests | Integration tests | Total |
|-------|-----------|-----------|------------------|-------|
| A | Critic Agent (CRITIQUE node) | 18 | 0 | 18 |
| B | SHARDING_APPROVAL gate | 12 | 0 | 12 |
| C | Event Bus | 16 | 0 | 16 |
| D | WebSocket server + REST gap-fill | 20 | 0 | 20 |
| E | Integration Tests | 0 | 6 | 6 |
| **Total** | | **66** | **6** | **72** |

---

## 5. File Inventory

New files created in this slice:

```
src/sdk-orchestrator/v3/src/
  event-bus.ts              Phase C — SLE-005 typed EventBus + SLEEventEnvelope

src/sdk-orchestrator/v4/
  package.json              VS4 package (adds 'ws' dependency)
  tsconfig.json             VS4 TypeScript config (mirrors v3)

src/sdk-orchestrator/v4/tests/
  critic-agent.test.ts           Phase A — CRITIQUE node, role mapping, depth-gate, output paths
  cycle-runner-critique.test.ts  Phase A — CycleRunner critique routing and DESIGN re-routing
  sharding-approval.test.ts      Phase B — SHARDING_APPROVAL gate, approve/reject, skip logic
  event-bus.test.ts              Phase C — EventBus subscribe/emit/unsubscribe, envelope shape
  daemon-ws.test.ts              Phase D — WebSocket server, state snapshot, event broadcast
  daemon-rest-gaps.test.ts       Phase D — 7 new REST endpoints
  cycle-runner-integration.test.ts  Phase E — VS4-INT-01 through VS4-INT-06
```

**v3 source files modified in VS4:**

```
src/sdk-orchestrator/v3/src/
  dag-runner.ts         Add CRITIQUE + SHARDING_APPROVAL to DAG_SEQUENCE; shouldSkipNode() for proposal check; EventBus injection
  agent-runner.ts       Add CRITIQUE → critic in NODE_TO_ROLE; correct ROLE_OUTPUT_PATHS['critic'] to ['.sle/runs/']
  context-manager.ts    Correct ROLE_ARTIFACT_PATHS['critic']: architecture + evaluation (not requirements + plan); inject critique_result into designer context on re-routing
  cycle-runner.ts       Add CRITIQUE handler (depth-dependent passes, DESIGN re-routing); SHARDING_APPROVAL handler (gate pause); EventBus injection; design_revisions_used in CycleRunResult
  types.ts              Extend CycleRunResult with design_revisions_used; extend CycleStateContext with critique_result; extend RuntimeMap cycle object with sharding_proposal + sharding_approved
  daemon.ts             Add WebSocketServer; 7 new REST routes; EventBus + ShardingGateService in DaemonDeps
  package.json          Add 'ws' ^8.x
```

---

## 6. Definition of Done

VS4 is complete when:

- [ ] All 72 new tests pass (`node --import tsx --test`)
- [ ] All VS3 tests (90) still pass after v3 source modifications
- [ ] `cycle-runner-integration.test.ts` VS4-INT-02 passes: `deep`-depth cycle where Critic returns BLOCKING once, DESIGN re-runs with `critique_result` in `cycleState`, Critic approves on second pass, cycle completes with `design_revisions_used === 1`
- [ ] `cycle-runner-integration.test.ts` VS4-INT-04 passes: SHARDING_APPROVAL gate opens when `sharding_proposal` is in map; `POST /api/v2/cycles/sharding/approve` resolves gate; `sharding_approved: true` in final map state
- [ ] `cycle-runner-integration.test.ts` VS4-INT-06 passes: WS client receives all node events in monotonic sequence order; `cycle.started` type uses dot notation; CRITIQUE absent from events at `standard` depth
- [ ] DAG_SEQUENCE is `['SCOPING', 'DESIGN', 'CRITIQUE', 'PLAN', 'TEST', 'SHARDING_APPROVAL', 'CONFIRM', 'BUILD', 'HISTORY', 'EXEC', 'VALIDATION_GATE', 'EVALUATE', 'SUMMARISE', 'SNAPSHOT']` (14 nodes; DEBUG/DEBUGGER handled separately in CycleRunner)
- [ ] `roleForNode('CRITIQUE')` → `'critic'`; `validateOutputPath('.sle/runs/1-1/critique.json', 'critic')` → true; `validateOutputPath('docs/critique.md', 'critic')` → false
- [ ] `shouldSkipAtDepth('CRITIQUE', 'minimal')` → true; `shouldSkipAtDepth('CRITIQUE', 'deep')` → false
- [ ] Critic pass limit respects depth: 1 pass at `deep`, 3 passes at `research`
- [ ] SLEEvent envelopes use dotted type names (`cycle.started`) and flat structure `{ type, cycle, iteration, timestamp, payload, sequence }`
- [ ] `GET /api/v2/artifacts/:id` looks up by registry ID (not path); returns full `ArtifactEntry` shape
- [ ] `EventBus` is injectable into `DAGRunner`, `CycleRunner` with no breaking changes (optional param, defaults to no-op)
- [ ] VS3 known divergences documented in §1.5 and surfaced as VS5 work items
- [ ] Dev plan updated with commit hashes for all phases
