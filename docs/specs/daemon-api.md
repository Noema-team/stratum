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

## API endpoints

All REST endpoint definitions (request/response schemas, status codes, error
codes) are documented in [daemon-api-endpoints.md](daemon-api-endpoints.md).

The daemon exposes 85 endpoints across 18 groups covering health checks, system
state, init, discovery, cycles, sharding, dispatch, artifacts, map/rules,
reports, chat, context, tasks, intake, knowledge engine, content store,
modules, and document linking.

---

## WebSocket events

The daemon emits events over `ws://localhost:7700/events`. The full event
catalogue (62 server-to-client events across 14 groups) is defined in
[../reference/websocket-events.md](../reference/websocket-events.md).

### Client-to-daemon commands (WebSocket)

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

### Server-to-client events (summary)

All 62 server-to-client events are fully specified in
[../reference/websocket-events.md](../reference/websocket-events.md).
The groups are:

| Group | Events | Count |
|-------|--------|-------|
| System lifecycle | `system.state_changed`, `system.ready`, `system.shutdown` | 3 |
| DAG execution | `cycle.started`, `cycle.completed`, `cycle.halted`, `cycle.iteration_started`, `node.started`, `node.completed` | 6 |
| Validation | `validation.category.started`, `validation.category.completed`, `gate.result` | 3 |
| Gates & actions | `approval.required`, `action.required` | 2 |
| Chat | `chat.message`, `chat.decision_captured`, `chat.session_changed` | 3 |
| Run artifacts | `run.artifact_written`, `run.manifest_ready`, `run.context_pack_ready` | 3 |
| Artifacts | `artifact.updated` | 1 |
| Errors | `error` | 1 |
| Init / Discovery | `init.step_completed`, `init.complete`, `discovery.round_started`, `discovery.draft_ready`, `discovery.round_approved`, `discovery.complete` | 6 |
| Intake / sharding | `intake.coherence_checked`, `intake.sharding_proposed`, `intake.sharding_approved`, `intake.sharding_rejected`, `intake.document_promoted`, `intake.task_stale` | 6 |
| Job dispatch | `dispatch.started`, `dispatch.job_status_changed`, `dispatch.static_gate_passed`, `dispatch.static_gate_failed`, `dispatch.category_completed`, `dispatch.completed`, `dispatch.worker_status_changed` | 7 |
| Task / store | `task.claimed`, `task.resolved`, `task.comment_added`, `task.stale_detected`, `task_store.sync` | 5 |
| Document linking | `link.created`, `link.deleted`, `link.index_rebuilt`, `link.index_updated`, `link.file_updated` | 5 |
| Content & modules | `content.written`, `content.deleted`, `module.triggered`, `module.completed`, `module.failed`, `module.registered` | 6 |

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
| 400 | `init_already_initialised` | `.sle/` exists (E100) |
| 404 | `no_init_state` | No `init-state.json` to resume (E108) |
| 403 | `name_mismatch` | Reset confirmation name wrong (E100) |
| 409 | `discovery_already_complete` | Discovery run without `--revisit` (E110) |
| 409 | `not_idle` | System not in `idle` state (E112) |
| 400 | `invalid_round` | Round N ≠ current round (E115) |

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
