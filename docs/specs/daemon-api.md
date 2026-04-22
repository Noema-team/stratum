# Daemon API

**Type:** spec · **Status:** draft · **Updated:** 2026-04-22
**Depends on:** DDR-020, DDR-021, DDR-026
**Source material:** SLE-005 (SDK + interfaces)

## Overview

The SDK daemon is a long-running Node.js process that serves as the single
coordination point for all SLE operations. Every interface — CLI, web UI,
Obsidian plugin — connects to the daemon over REST (commands) and WebSocket
(live events). No interface reimplements system logic.

The daemon owns the DAG runner, rule loader, context manager, artifact store,
Beads bridge, and `map.yaml` writer. It validates configuration on startup,
restores state after crashes, and enforces the state machine across all
connections.

**Transport:** HTTP REST + WebSocket on a single port (default 7700).

**System states:** `idle | discovering | cycling | halted | complete`
(see [state-machine.md](state-machine.md)).

**Cycle flags:** `cycle.awaiting_confirmation` (DDR-021),
`cycle.awaiting_sharding_approval` (DDR-026). These are boolean fields on the
cycle record, not machine states.

**Canonical types:** [../reference/types.md](../reference/types.md).
**State machine:** [state-machine.md](state-machine.md).
**WebSocket events:** [../reference/websocket-events.md](../reference/websocket-events.md).
**Error codes:** [../reference/error-codes.md](../reference/error-codes.md).

---

## Data model

### Daemon identity

```typescript
interface DaemonInfo {
  version: string
  pid: number
  port: number
  started_at: string
  uptime_ms: number
  project_root: string
  sle_version: string
}
```

Populated at startup from package.json, `process.pid`, and `map.yaml → meta`.

### Connection state

```typescript
interface ConnectionState {
  clients: number
  subscriptions: string[]
  max_clients: number
}
```

The daemon tracks connected WebSocket clients. It broadcasts events to all
subscribers. There is no per-client filtering — every client receives every
event for the active project.

### Request envelope

All REST responses share a common envelope:

```typescript
interface APIResponse<T> {
  ok: boolean
  data: T
  meta?: {
    request_id: string
    timestamp: string
  }
}

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

`request_id` is a UUID generated per request. Included in daemon logs for
correlation with WebSocket events.

### WebSocket connection

```
ws://localhost:7700/events
```

All messages are JSON. The daemon pushes events to connected clients. Clients
send a small set of commands (approval responses, category confirmations).
Full event catalogue: [../reference/websocket-events.md](../reference/websocket-events.md).

### API versioning

All endpoints are prefixed with `/api/v2`. The daemon serves exactly one API
version. Breaking changes require a major version bump of the daemon package
itself — there is no plan to serve multiple API versions concurrently.

---

## Behavior

### Startup sequence

```
1. Parse CLI flags (port, foreground, config-dir)
2. Load map.yaml — parse and validate schema
3. Validate rule files in .sle/rules/ (all seven files)
4. Check agent.md exists and map: reference block resolves
5. Verify all required: true artifacts exist or are not-yet-generated
6. Check Beads remote reachable (bd status)
7. Check docs remote reachable (git -C .server status)
8. If any check fails → exit with descriptive error
9. Restore state from map.yaml
   - If meta.status is cycling and awaiting flag is set → resume at gate
   - If meta.status is cycling with no flag → resume from last DAG node
   - If halted → stay halted, await user acknowledgement
   - If idle or complete → transition to idle
10. Bind HTTP server on configured port (default 7700)
11. Bind WebSocket server on same port
12. Emit system.ready event
13. Accept connections
```

### Request lifecycle

```
1. Client sends HTTP request
2. Daemon validates request schema
3. Daemon checks system state preconditions
4. Daemon executes command (may trigger DAG node, flag mutation, etc.)
5. Daemon writes result atomically to map.yaml (if state changed)
6. Daemon sends REST response
7. Daemon broadcasts WebSocket event (if state changed)
```

Steps 4–7 are synchronous from the client's perspective — the REST response
is sent only after all side effects (map.yaml writes, WebSocket broadcasts)
have completed.

### WebSocket lifecycle

```
1. Client connects to ws://localhost:7700/events
2. Daemon sends system.ready event (current state snapshot)
3. Daemon sends buffered events since client's last connection (if reconnect)
4. Client subscribes to event stream
5. Daemon pushes all subsequent events to client
6. Client may send commands (approval.respond, categories.confirm)
7. On disconnect → client removed from broadcast list
8. No event buffering after disconnect — events are fire-and-forget
```

### Concurrent client handling

Multiple clients may connect simultaneously. The daemon broadcasts events to
all connected clients. REST commands are serialized — only one state-changing
command executes at a time. If a second command arrives while the first is
executing, the daemon responds with 409 `session_conflict`.

Read endpoints (`GET`) are never blocked by state-changing commands.

### Error propagation

REST errors use the `APIError` envelope with structured error codes from
[../reference/error-codes.md](../reference/error-codes.md). WebSocket errors
are emitted as `error` events (event §8.1 in websocket-events.md).

| Channel | Error shape | Recoverable? |
|---------|-------------|--------------|
| REST 4xx | `APIError` with `code` and `message` | Client corrects and retries |
| REST 5xx | `APIError` with `code` and `message` | Daemon bug or infrastructure failure |
| WebSocket | `ErrorPayload` with `recoverable` flag | `true` → cycle continues; `false` → user action required |

---

## API contract

### Health check

```
GET /api/v2/health

Response 200:
{
  "ok": true,
  "data": {
    "status": "healthy",
    "uptime_ms": number,
    "version": string
  }
}
```

Returns 503 if the daemon is shutting down or startup validation failed
partway through.

### Daemon info

```
GET /api/v2/info

Response 200:
{
  "ok": true,
  "data": DaemonInfo
}
```

### System state

```
GET /api/v2/system/state

Response 200:
{
  "ok": true,
  "data": {
    "state": "idle" | "discovering" | "cycling" | "halted" | "complete",
    "active_session_id": string | null,
    "active_cycle_id": string | null,
    "discovery_status": "none" | "in_progress" | "complete",
    "iteration": number,
    "revision": number,
    "awaiting_confirmation": boolean,
    "awaiting_sharding_approval": boolean,
    "chat": {
      "session_open": boolean
    }
  }
}
```

### Transition state

```
POST /api/v2/system/state/transition

Request:
{
  "target": "idle" | "discovering" | "cycling" | "halted" | "complete",
  "trigger": string,
  "payload": object | null
}

Response 200:
{
  "ok": true,
  "data": {
    "previous": SystemState,
    "current": SystemState,
    "cycle_id": string | null
  }
}

Response 409:
{
  "ok": false,
  "error": {
    "code": "invalid_transition",
    "message": "Transition from {from} to {to} is not valid.",
    "details": {
      "from": SystemState,
      "to": SystemState,
      "allowed": SystemState[]
    }
  }
}
```

Valid transitions are defined in [state-machine.md](state-machine.md) §Transition table.

---

### Start discovery

```
POST /api/v2/discovery/start

Request:
{
  "resume": boolean
}

Response 200:
{
  "ok": true,
  "data": {
    "session_id": string,
    "status": "in_progress",
    "phases_total": number
  }
}

Response 409:
{
  "ok": false,
  "error": {
    "code": "session_conflict",
    "message": "System is {state}. Discovery requires idle.",
    "details": {
      "state": SystemState
    }
  }
}

Response 409:
{
  "ok": false,
  "error": {
    "code": "discovery_already_complete",
    "message": "Discovery has already been completed. Use --force to rerun."
  }
}
```

### Discovery status

```
GET /api/v2/discovery/status

Response 200:
{
  "ok": true,
  "data": {
    "status": "none" | "in_progress" | "complete",
    "session_id": string | null,
    "current_phase": number,
    "total_phases": number,
    "completed_at": string | null,
    "artifacts": string[],
    "open_questions_count": number,
    "blocking_questions_count": number
  }
}
```

### Halt discovery

```
POST /api/v2/discovery/halt

Response 200:
{
  "ok": true,
  "data": {
    "session_id": string,
    "status": "halted",
    "completed_phases": number,
    "total_phases": number
  }
}

Response 409:
{
  "ok": false,
  "error": {
    "code": "halt_not_discovering",
    "message": "Can only halt an active discovery session.",
    "details": {
      "state": SystemState
    }
  }
}
```

---

### Start cycle

```
POST /api/v2/cycles

Request:
{
  "goal": string,
  "depth_override": "minimal" | "standard" | "deep" | "research" | null,
  "explore": boolean,
  "category_hints": string[] | null,
  "intake": "auto" | "force" | "skip" | null
}

Response 201:
{
  "ok": true,
  "data": {
    "cycle_id": string,
    "dag_state": DAGState,
    "started_at": string
  }
}

Response 409:
{
  "ok": false,
  "error": {
    "code": "session_conflict",
    "message": "A session is already active. Halt or complete before starting.",
    "details": {
      "state": SystemState
    }
  }
}

Response 403:
{
  "ok": false,
  "error": {
    "code": "discovery_required",
    "message": "Run discovery first, or use --force to bypass."
  }
}
```

### List cycles

```
GET /api/v2/cycles

Query params:
  limit: number (default 20, max 100)
  cursor: string | null

Response 200:
{
  "ok": true,
  "data": {
    "cycles": Array<{
      "cycle_id": string,
      "number": number,
      "outcome": CycleOutcome,
      "started_at": string,
      "completed_at": string | null,
      "planning_depth": PlanningDepth
    }>,
    "next_cursor": string | null
  }
}
```

### Get cycle state

```
GET /api/v2/cycles/{cycle_id}

Response 200:
{
  "ok": true,
  "data": {
    "cycle_id": string,
    "number": number,
    "iteration": number,
    "revision": number,
    "max_iterations": number,
    "planning_depth": PlanningDepth,
    "outcome": CycleOutcome,
    "dag_state": DAGState,
    "flags": {
      "awaiting_confirmation": boolean,
      "awaiting_sharding_approval": boolean
    },
    "started_at": string,
    "completed_at": string | null
  }
}

Response 404:
{
  "ok": false,
  "error": {
    "code": "cycle_not_found",
    "message": "Cycle {cycle_id} does not exist."
  }
}
```

### Approve at gate

```
POST /api/v2/cycles/{cycle_id}/approve

Response 200:
{
  "ok": true,
  "data": {
    "cycle_id": string,
    "dag_state": DAGState
  }
}

Response 409: not_awaiting_confirmation
Response 404: cycle_not_found
```

### Revise plan at CONFIRM gate

```
POST /api/v2/cycles/{cycle_id}/revise

Request:
{
  "steps": {
    "add": [{ "description": string, "after_step": string, "constraints": string[] }] | null,
    "remove": [{ "step_id": string, "reason": string }] | null,
    "reorder": [{ "step_id": string, "new_position": number }] | null,
    "edit": [{ "step_id": string, "description": string, "constraints": string[] }] | null
  } | null,
  "test_criteria": [{ "test_id": string, "new_assertions": string[] }] | null
}

Response 200:
{
  "ok": true,
  "data": {
    "cycle_id": string,
    "revision": number,
    "affected_categories": string[],
    "dag_state": DAGState
  }
}

Response 409:
{
  "ok": false,
  "error": {
    "code": "not_awaiting_confirmation",
    "message": "CONFIRM gate is not active for this cycle."
  }
}

Response 404: cycle_not_found
```

### Halt cycle

```
POST /api/v2/cycles/{cycle_id}/halt

Response 200:
{
  "ok": true,
  "data": {
    "cycle_id": string,
    "outcome": "halted",
    "partial_report": {
      "iterations_used": number,
      "failed_categories": string[],
      "last_gate_result": GateResult | null
    }
  }
}

Response 409:
{
  "ok": false,
  "error": {
    "code": "halt_not_cycling",
    "message": "Can only halt a cycling session.",
    "details": {
      "state": SystemState
    }
  }
}
```

### Set cycle flags

```
PATCH /api/v2/cycles/{cycle_id}/flags

Request:
{
  "awaiting_confirmation": boolean | null,
  "awaiting_sharding_approval": boolean | null
}

Response 200:
{
  "ok": true,
  "data": {
    "cycle_id": string,
    "flags": {
      "awaiting_confirmation": boolean,
      "awaiting_sharding_approval": boolean
    }
  }
}

Response 409:
{
  "ok": false,
  "error": {
    "code": "flag_conflict",
    "message": "Cannot set both awaiting_confirmation and awaiting_sharding_approval simultaneously."
  }
}

Response 404: cycle_not_found
```

A null value in the request means "leave unchanged". Setting one flag to
`true` implicitly sets the other to `false` (flag exclusivity).

---

### Sharding approve

```
POST /api/v2/cycles/{cycle_id}/sharding/approve

Response 200:
{
  "ok": true,
  "data": {
    "cycle_id": string,
    "tasks_created": number
  }
}

Response 409: not_awaiting_sharding_approval
```

### Sharding reject

```
POST /api/v2/cycles/{cycle_id}/sharding/reject

Response 200:
{
  "ok": true,
  "data": {
    "cycle_id": string
  }
}

Response 409: not_awaiting_sharding_approval
```

### Sharding modify

```
POST /api/v2/cycles/{cycle_id}/sharding/modify

Request:
{
  "tasks": {
    "add": [{ "title": string, "description": string, "context_declarations": ArtifactRef[] }] | null,
    "remove": [{ "task_index": number }] | null,
    "edit": [{ "task_index": number, "title": string, "description": string }] | null
  }
}

Response 200:
{
  "ok": true,
  "data": {
    "cycle_id": string,
    "proposal": ShardingProposal
  }
}

Response 409: not_awaiting_sharding_approval
```

---

### List artifacts

```
GET /api/v2/artifacts

Response 200:
{
  "ok": true,
  "data": {
    "artifacts": ArtifactEntry[]
  }
}
```

Each `ArtifactEntry` includes `path`, `generator`, `required`, `append_only`,
`scope`, `last_updated`, and `dirty` fields. See [../reference/types.md](../reference/types.md) §5.2.

### Read artifact

```
GET /api/v2/artifacts/{id}

Response 200:
{
  "ok": true,
  "data": {
    "id": string,
    "path": string,
    "content": string,
    "format": ArtifactFormat,
    "last_updated": string,
    "dirty": boolean,
    "scope": ArtifactScope | null,
    "size_bytes": number
  }
}

Response 404: artifact_not_found
```

### Diff artifact

```
GET /api/v2/artifacts/{id}/diff?from_version={version}

Query params:
  from_version: string (version ID to diff against, defaults to previous version)

Response 200:
{
  "ok": true,
  "data": {
    "id": string,
    "from_version": string,
    "to_version": string,
    "diff": string
  }
}

Response 404: artifact_not_found
Response 404: version_not_found (when `from_version` does not exist)
```

---

### Get map

```
GET /api/v2/map

Response 200:
{
  "ok": true,
  "data": RuntimeMap
}
```

Returns the current `map.yaml` as a parsed object. The schema is defined in
[../reference/map-yaml-schema.md](../reference/map-yaml-schema.md).

### Get rules

```
GET /api/v2/rules

Response 200:
{
  "ok": true,
  "data": RuntimeConfig
}
```

Returns the merged configuration from all seven rule files.
See [../reference/types.md](../reference/types.md) §8.5.

---

### Latest report

```
GET /api/v2/reports/latest

Response 200:
{
  "ok": true,
  "data": {
    "cycle_id": string,
    "path": string,
    "format": SummaryFormat,
    "content": string,
    "generated_at": string,
    "iteration": number,
    "gate_result": GateResult | null
  }
}

Response 404: report_not_found
```

### Cycle report

```
GET /api/v2/reports/{cycle_id}

Response 200:
{
  "ok": true,
  "data": {
    "cycle_id": string,
    "path": string,
    "format": SummaryFormat,
    "content": string,
    "generated_at": string,
    "iterations": Array<{
      "iteration": number,
      "gate_result": GateResult,
      "categories": CategoryResult[]
    }>
  }
}

Response 404: cycle_not_found
```

---

### Open chat session

```
POST /api/v2/chat/session/open

Response 200:
{
  "ok": true,
  "data": {
    "session_open": true,
    "session_id": string
  }
}

Response 204:
(no change — session already open)
```

### Close chat session

```
DELETE /api/v2/chat/session

Response 200:
{
  "ok": true,
  "data": {
    "session_open": false
  }
}

Response 204:
(no change — session already closed)
```

### Send chat message

```
POST /api/v2/chat/message

Request:
{
  "content": string
}

Response 200:
{
  "ok": true,
  "data": {
    "message_id": string,
    "role": "user",
    "timestamp": string
  }
}

Response 409:
{
  "ok": false,
  "error": {
    "code": "chat_not_open",
    "message": "Open a chat session first."
  }
}
```

Chat is orthogonal to system state (DDR-020). Messages can be sent in any
state as long as `chat.session_open` is `true`.

---

### Assemble context

```
POST /api/v2/context/assemble

Request:
{
  "role": AgentRole,
  "cycle_state": CycleState,
  "task_id": string | null,
  "facilitator_mode": "chat" | "decision" | null
}

Response 200: { context: AssembledContext, assembly_mode, role_budget, warnings[] }
Response 400: invalid_role
Response 404: artifact_not_found
```

Full request/response shape: [context-manager.md](context-manager.md) §API contract.

### Get slice config

```
GET /api/v2/context/slices/{role}

Response 200: { role, slices: SliceRule[], budget, mode, never_truncate[] }
Response 400: invalid_role
```

### Resolve artifact reference

```
GET /api/v2/context/resolve?ref={ArtifactRef}

Response 200: { ref, path, scope, exists, tokens }
Response 400: invalid_ref
```

---

### List tasks

```
GET /api/v2/tasks

Query params:
  status: "open" | "in_progress" | "blocked" | "closed" | null
  limit: number (default 50, max 200)
  cursor: string | null

Response 200:
{
  "ok": true,
  "data": {
    "tasks": SLETask[],
    "next_cursor": string | null
  }
}
```

### Get task

```
GET /api/v2/tasks/{task_id}

Response 200:
{
  "ok": true,
  "data": SLETask
}

Response 404: task_not_found
```

### Claim task

```
POST /api/v2/tasks/{task_id}/claim

Response 200:
{
  "ok": true,
  "data": {
    "task_id": string,
    "status": "in_progress"
  }
}

Response 409:
{
  "ok": false,
  "error": {
    "code": "task_already_claimed",
    "message": "Task '{task_id}' is already claimed.",
    "details": {
      "task_id": string,
      "current_status": string
    }
  }
}

Response 404: task_not_found
```

### Close task

```
POST /api/v2/tasks/{task_id}/close

Request:
{
  "message": string
}

Response 200:
{
  "ok": true,
  "data": {
    "task_id": string,
    "status": "closed"
  }
}

Response 404: task_not_found
```

---

### WebSocket events

The daemon emits events over `ws://localhost:7700/events`. The full event
catalogue (23 events across 8 groups) is defined in
[../reference/websocket-events.md](../reference/websocket-events.md).

#### Client-to-daemon commands (WebSocket)

These are sent from the client to the daemon over the WebSocket connection.
They duplicate functionality available via REST but provide a lower-latency
path for approval flows.

```typescript
{
  type: "approval.respond",
  gate: string,
  decision: "approve" | "reject",
  message?: string
}
```

```typescript
{
  type: "categories.confirm",
  categories: string[]
}
```

#### Server-to-client events (summary)

All 18 server-to-client events are fully specified in
[../reference/websocket-events.md](../reference/websocket-events.md).
The groups are:

| Group | Events | Count |
|-------|--------|-------|
| System lifecycle | `system.state_changed`, `system.ready`, `system.shutdown` | 3 |
| DAG execution | `cycle.started`, `cycle.completed`, `cycle.halted`, `cycle.iteration_started`, `node.started`, `node.completed` | 6 |
| Validation | `validation.category.started`, `validation.category.completed`, `gate.result` | 3 |
| Gates & actions | `approval.required`, `action.required` | 2 |
| Chat | `chat.message`, `chat.decision_captured` | 2 |
| Run artifacts | `run.artifact_written`, `run.manifest_ready`, `run.context_pack_ready` | 3 |
| Artifacts | `artifact.updated` | 1 |
| Errors | `error` | 1 |

---

## Error cases

### REST error codes

All REST errors use the `APIError` envelope. Error codes map to the
canonical error catalogue in [../reference/error-codes.md](../reference/error-codes.md).

| HTTP status | Error code | Condition |
|---|---|---|
| 400 | `invalid_role` | Agent role not in the AgentRole enum |
| 400 | `invalid_ref` | Artifact reference does not match typed prefix format |
| 400 | `schema_validation` | Request body fails schema validation |
| 403 | `discovery_required` | Cycle start without discovery and no `--force` |
| 404 | `cycle_not_found` | Cycle ID does not exist |
| 404 | `artifact_not_found` | Artifact ID does not exist |
| 404 | `task_not_found` | Task ID does not exist |
| 404 | `report_not_found` | No report has been generated yet |
| 404 | `version_not_found` | Requested version does not exist |
| 409 | `session_conflict` | Operation requires `idle` but state is not idle |
| 409 | `invalid_transition` | State transition not in the transition table |
| 409 | `flag_conflict` | Both awaiting flags set to true simultaneously |
| 409 | `not_awaiting_confirmation` | Revise or approve when no CONFIRM gate active |
| 409 | `not_awaiting_sharding_approval` | Sharding action when no proposal pending |
| 409 | `halt_not_cycling` | Halt when system state is not `cycling` |
| 409 | `halt_not_discovering` | Halt discovery when not `discovering` |
| 409 | `chat_not_open` | Send message when no chat session |
| 409 | `task_already_claimed` | Claim task that is already in_progress |
| 409 | `discovery_already_complete` | Start discovery when already complete |
| 500 | `internal_error` | Unhandled daemon error |
| 503 | `daemon_shutting_down` | Request during graceful shutdown |

### WebSocket errors

WebSocket errors are emitted as `error` events with the `ErrorPayload`
structure defined in [../reference/websocket-events.md](../reference/websocket-events.md) §8.
Recoverable errors (`recoverable: true`) emit a warning event and continue.
Unrecoverable errors (`recoverable: false`) emit the event and halt the cycle.

### Startup validation failures

The daemon validates configuration before accepting connections. On failure it
exits with the appropriate error code from [../reference/error-codes.md](../reference/error-codes.md):
E010 (rule file invalid), E011 (required artifact missing), E003 (port in use),
E004 (docs remote), E005 (Beads remote). The daemon never starts in a degraded
state — all checks must pass.

### Recovery behavior

REST 4xx errors return `APIError` with no side effects. REST 5xx errors log the
full stack trace and halt the cycle if active and critical. Connection loss
during a command triggers rollback — `map.yaml` is never left in a partial-write
state (atomic writes via temp file + rename).

---

## Constraints

1. **Single port.** REST and WebSocket share port 7700 (configurable). There
   is no separate port for any transport.

2. **Single daemon per project.** Only one daemon process may run per project
   root. The PID file at `.sle/daemon.pid` prevents duplicate starts. A stale
   PID file (dead process) is cleaned up automatically.

3. **No concurrent state changes.** Only one state-changing REST command
   executes at a time. Concurrent commands receive 409 `session_conflict`.

4. **Read endpoints never block.** `GET` endpoints respond immediately
   regardless of active state-changing commands. They read from the last
   committed `map.yaml` state.

5. **Atomic map.yaml writes.** Every state change writes to `map.yaml` via
   temp file + rename. The daemon never leaves `map.yaml` in a partial state.

6. **State machine authority.** The daemon is the sole authority on system
   state. Interfaces never compute state locally — they query the daemon.
   The daemon's `map.yaml` is the source of truth.

7. **Flag exclusivity.** At most one of `awaiting_confirmation` and
   `awaiting_sharding_approval` may be `true` at any time. The daemon
   enforces this on `PATCH /flags` and on internal flag mutations.

8. **Flag scope.** Both flags are scoped to the active cycle. They reset to
   `false` when the cycle ends (transition to `halted`, `complete`, or `idle`).

9. **Chat independence.** Chat session lifecycle is independent of system
   state. Opening, using, and closing chat never blocks, delays, or cancels
   a state transition (DDR-020).

10. **WebSocket fire-and-forget.** Events are not acknowledged by clients.
    If a client disconnects, events are not re-sent on reconnect. The client
    should call `GET /system/state` after reconnect to synchronize.

11. **API versioning.** All endpoints are prefixed with `/api/v2`. There is
    no plan to serve multiple API versions. Breaking changes bump the daemon
    package major version.

12. **No authentication (local-only).** The daemon binds to `localhost` only.
    There is no authentication, authorization, or TLS. Remote access requires
    an SSH tunnel or reverse proxy.

13. **Request ID correlation.** Every REST response includes `request_id`.
    The daemon logs request IDs alongside WebSocket events for end-to-end
    tracing.

14. **Graceful shutdown.** `SIGTERM` triggers graceful shutdown: the daemon
    stops accepting new connections, completes in-flight requests, emits
    `system.shutdown` event, and exits. In-flight cycle state is preserved
    in `map.yaml` for crash recovery.

15. **Crash recovery.** On restart, if `map.yaml → meta.status` is `cycling`,
    the daemon resumes from the last committed DAG node. If an awaiting flag
    is set, it re-enters decision mode at the correct gate. No data is lost.

---

## Open questions

| ID | Question | Impact | Status |
|---|---|---|---|
| API-001 | Should the daemon support HTTP/2 or remain HTTP/1.1 only? | Performance, client library compatibility | Open |
| API-002 | What is the maximum request body size for REST endpoints? Should it be configurable? | Security, resource limits | Open |
| API-003 | Should WebSocket events be persisted to an append-only log for replay beyond reconnection? | Event sourcing, audit trail, client recovery | Open |
| API-004 | Should the artifact diff endpoint produce unified diff format, structured JSON, or both? | Client rendering, parsing complexity | Open |
| API-005 | What rate limiting strategy should the daemon apply to REST endpoints? | Resource protection, multi-client fairness | Open |
| API-006 | Should the chat message endpoint stream the Facilitator response (SSE or WebSocket), or return it as a single response? | Latency, user experience, implementation complexity | Open |
| API-007 | Is there a maximum number of concurrent WebSocket clients that should be enforced? | Resource management, event delivery guarantees | Open |
| API-008 | Should the daemon expose a Prometheus metrics endpoint for observability? | Production monitoring, operational visibility | Open |
| API-009 | How should the daemon handle a client that sends malformed JSON over WebSocket — disconnect, error event, or ignore? | Robustness, client error handling | Open |
| API-010 | Should the reports endpoint support streaming large report content, or is a single response sufficient? | Memory usage, client rendering | Open |
| API-011 | Should there be a WebSocket ping/keepalive mechanism, and if so, at what interval? | Connection stability, stale connection detection | Open |
| API-012 | Should the task endpoints delegate entirely to Beads (`bd` CLI), or should the daemon maintain a local task cache? | Latency, offline support, consistency | Open |
