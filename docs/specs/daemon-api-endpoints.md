# Daemon API — Endpoints

**Type:** spec · **Status:** draft · **Updated:** 2026-04-25 · **Depends on:** DDR-005, DDR-013, DDR-020, DDR-024, DDR-025, DDR-026, DDR-028

> This document contains all REST endpoint definitions for the SDK daemon API.
> For architecture overview, data model, authentication, error handling,
> WebSocket events, constraints, and open questions, see
> [daemon-api.md](daemon-api.md).

**API prefix:** All endpoints are prefixed with `/api/v2`.
**Response envelope:** All responses use `APIResponse<T>` or `APIError` (see [daemon-api.md](daemon-api.md) §Request envelope).

---

## Health & info

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

---

## System state

### Get system state

```
GET /api/v2/system/state

Response 200:
{
  "ok": true,
  "data": {
    "state": "idle" | "discovering" | "cycling" | "halted" | "complete",
    "active_session_id": string | null,
    "active_cycle_id": string | null,
    "discovery_status": "not_started" | "in_progress" | "complete",
    "iteration": number,
    "revision": number,
    "awaiting_confirmation": boolean,
    "awaiting_sharding_approval": boolean,
    "awaiting_scoping": boolean,
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
    "previous": SystemStatus,
    "current": SystemStatus,
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
      "from": SystemStatus,
      "to": SystemStatus,
      "allowed": SystemStatus[]
    }
  }
}
```

Valid transitions are defined in [state-machine.md](state-machine.md) §Transition table.

---

## Init

### Run init

```
POST /api/v2/init

Request:
{
  "project_name": string,
  "project_type": "api" | "ui" | "library" | "research" | "custom",
  "task_store": "beads" | "local",
  "daemon_port": number,
  "docs_remote": string | null,
  "non_interactive": boolean
}

Response 200:
{
  "ok": true,
  "data": {
    "status": "complete" | "partial",
    "step": number,
    "message": string,
    "files_created": string[]
  }
}

Response 409:
{
  "ok": false,
  "error": {
    "code": "already_initialised",
    "message": ".sle/ directory already exists."
  }
}
```

### Get init status

```
GET /api/v2/init/status

Response 200:
{
  "ok": true,
  "data": {
    "initialised": boolean,
    "current_step": number | null,
    "total_steps": number,
    "last_file_created": string | null
  }
}

Response 404:
{
  "ok": false,
  "error": {
    "code": "no_init_state",
    "message": "No init-state.json found. Run POST /api/v2/init first."
  }
}
```

### Reset init

```
POST /api/v2/init/reset

Request:
{
  "confirm_name": string
}

Response 200:
{
  "ok": true,
  "data": {
    "removed": string[]
  }
}

Response 403:
{
  "ok": false,
  "error": {
    "code": "name_mismatch",
    "message": "confirm_name does not match project name."
  }
}
```

`confirm_name` must match the project name set during init. This is a safety
guard against accidental resets.

Full init sequence and step details: [init-and-discovery.md](init-and-discovery.md) §Init sequence.

---

## Discovery

### Start discovery

```
POST /api/v2/discovery/start

Request:
{
  "resume": boolean,
  "mode": "full" | "solo",
  "from_file": string | null
}

Response 200:
{
  "ok": true,
  "data": {
    "session_id": string,
    "status": "in_progress",
    "mode": "full" | "solo",
    "current_round": 1,
    "total_rounds": 4 | 2,
    "phases_total": number,
    "opening_question": string
  }
}

Response 409:
{
  "ok": false,
  "error": {
    "code": "session_conflict",
    "message": "System is {state}. Discovery requires idle.",
    "details": {
      "state": SystemStatus
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

### Discovery round response

```
POST /api/v2/discovery/round/{n}/response

Request:
{
  "content": string
}

Response 200:
{
  "ok": true,
  "data": {
    "round": number,
    "status": "collecting" | "drafting" | "reviewing",
    "follow_up_question": string | null,
    "draft_available": boolean
  }
}

Response 400: invalid_round
```

### Get discovery round draft

```
GET /api/v2/discovery/round/{n}/draft

Response 200:
{
  "ok": true,
  "data": {
    "round": number,
    "artifact_path": string,
    "content": string,
    "status": "draft" | "approved" | "revising"
  }
}

Response 404: draft_not_ready
```

### Approve discovery round

```
POST /api/v2/discovery/round/{n}/approve

Response 200:
{
  "ok": true,
  "data": {
    "round": number,
    "artifact_path": string,
    "next_round": number | null,
    "next_step": "round" | "synthesis" | "planning" | "complete"
  }
}
```

### Revise discovery round

```
POST /api/v2/discovery/round/{n}/revise

Request:
{
  "feedback": string
}

Response 200:
{
  "ok": true,
  "data": {
    "round": number,
    "status": "revising"
  }
}
```

### Approve discovery synthesis

```
POST /api/v2/discovery/synthesis/approve

Response 200:
{
  "ok": true,
  "data": {
    "artifacts": string[],
    "next_step": "planning"
  }
}
```

### Approve discovery plan

```
POST /api/v2/discovery/plan/approve

Response 200:
{
  "ok": true,
  "data": {
    "plan_path": string,
    "total_phases": number,
    "phase1_tasks": number,
    "discovery_status": "complete"
  }
}
```

### Reorder discovery plan phases

```
POST /api/v2/discovery/plan/reorder

Request:
{
  "phase_order": number[]
}

Response 200:
{
  "ok": true,
  "data": {
    "phase_order": number[]
  }
}
```

### Split discovery plan phase

```
POST /api/v2/discovery/plan/split/{phase}

Request:
{
  "split_after_task": number
}

Response 200:
{
  "ok": true,
  "data": {
    "original_phase": number,
    "new_phases": number[]
  }
}
```

### Merge discovery plan phases

```
POST /api/v2/discovery/plan/merge

Request:
{
  "phases": number[]
}

Response 200:
{
  "ok": true,
  "data": {
    "merged_phase": number
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
    "status": "not_started" | "in_progress" | "complete",
    "session_id": string | null,
    "mode": "full" | "solo" | null,
    "current_phase": number,
    "total_phases": number,
    "completed_rounds": number[],
    "artifacts": string[],
    "completed_at": string | null,
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
      "state": SystemStatus
    }
  }
}
```

---

## Cycles

### Start cycle

```
POST /api/v2/cycles

Request:
{
  "scope_draft_id": string | null,
  "quick_start_goal": string | null,
  "depth_override": "minimal" | "standard" | "deep" | "research" | null,
  "category_hints": string[] | null,
  "version_bump": "major" | "minor" | "patch" | null
}

Response 201:
{
  "ok": true,
  "data": {
    "cycle_id": string,
    "dag_state": DAGState,
    "started_at": string,
    "first_node": "SCOPING"
  }
}

Response 409:
{
  "ok": false,
  "error": {
    "code": "session_conflict",
    "message": "A session is already active. Halt or complete before starting.",
    "details": {
      "state": SystemStatus
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
      "state": SystemStatus
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
  "awaiting_sharding_approval": boolean | null,
  "awaiting_scoping": boolean | null
}

Response 200:
{
  "ok": true,
  "data": {
    "cycle_id": string,
    "flags": {
      "awaiting_confirmation": boolean,
      "awaiting_sharding_approval": boolean,
      "awaiting_scoping": boolean
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

## Sharding (cycle-scoped)

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

## Tags

Endpoints for managing node tags, including the #next-cycle tag used by the
SCOPING node (DDR-028).

### List tags

```
GET /api/v2/tags?type={TagPrefix}&scope={group_id}

Query params (all optional):
  type: TagPrefix — filter by tag prefix (e.g., "next-cycle")
  scope: string — filter by group_id

Response 200:
{
  "ok": true,
  "data": {
    "tags": Array<{ "node_id": string, "tags": NodeTag[] }>
  }
}
```

### Add tag

```
POST /api/v2/tags

Request:
{
  "node_id": string,
  "tag": {
    "prefix": TagPrefix,
    "value": string | null
  }
}

Response 201:
{
  "ok": true,
  "data": {
    "node_id": string,
    "tag": NodeTag
  }
}
```

### Remove tag

```
DELETE /api/v2/tags/{node_id}/{tag_prefix}/{value?}

Response 200:
{
  "ok": true,
  "data": {
    "node_id": string,
    "removed": true
  }
}

Response 404:
{
  "ok": false,
  "error": {
    "code": "tag_not_found",
    "message": "Tag not found on node {node_id}."
  }
}
```

### List next-cycle nodes

```
GET /api/v2/tags/next-cycle

Response 200:
{
  "ok": true,
  "data": {
    "nodes": Array<{
      "node_id": string,
      "group_id": string,
      "node_type": string,
      "tags": NodeTag[]
    }>
  }
}
```

Convenience endpoint: returns all nodes tagged #next-cycle.

---

## Scoping

Endpoints for managing scope drafts and submitting input during the SCOPING
node's guided discussion (DDR-028).

### List scope drafts

```
GET /api/v2/scoping/drafts

Response 200:
{
  "ok": true,
  "data": {
    "drafts": Array<{
      "id": string,
      "title": string,
      "created_at": string,
      "tagged_node_count": number
    }>
  }
}
```

### Create scope draft

```
POST /api/v2/scoping/drafts

Request:
{
  "title": string,
  "content": string | null
}

Response 201:
{
  "ok": true,
  "data": {
    "id": string,
    "title": string,
    "created_at": string,
    "tagged_node_count": 0
  }
}
```

### Update scope draft

```
PATCH /api/v2/scoping/drafts/{id}

Request:
{
  "title": string | null,
  "content": string | null
}

Response 200:
{
  "ok": true,
  "data": {
    "id": string,
    "title": string,
    "updated_at": string
  }
}

Response 404:
{
  "ok": false,
  "error": {
    "code": "draft_not_found",
    "message": "Scope draft {id} does not exist."
  }
}
```

### Delete scope draft

```
DELETE /api/v2/scoping/drafts/{id}

Response 200:
{
  "ok": true,
  "data": {
    "id": string,
    "deleted": true
  }
}

Response 404:
{
  "ok": false,
  "error": {
    "code": "draft_not_found",
    "message": "Scope draft {id} does not exist."
  }
}
```

### Submit scoping input

```
POST /api/v2/cycles/{cycle_id}/scoping/input

Request:
{
  "message": string,
  "approve_charter": boolean | null,
  "version_bump_override": "major" | "minor" | "patch" | null
}

Response 200:
{
  "ok": true,
  "data": {
    "cycle_id": string,
    "charter_produced": boolean,
    "dag_state": DAGState
  }
}

Response 409:
{
  "ok": false,
  "error": {
    "code": "not_awaiting_scoping",
    "message": "SCOPING node is not active for this cycle."
  }
}

Response 404: cycle_not_found
```

Submit user input during the SCOPING node's guided discussion. If
`approve_charter` is true, the charter is accepted and SCOPING completes. If
`version_bump_override` is provided, it overrides the inferred bump type.

---

## Dispatch

### Dispatch status

```
GET /api/v2/cycles/{cycle_id}/dispatch

Response 200:
{
  "ok": true,
  "data": {
    "active": boolean,
    "mode": "cycle_validation" | "task-execution" | null,
    "total_jobs": number,
    "completed_jobs": number,
    "failed_jobs": number,
    "workers": {
      "total": number,
      "idle": number,
      "busy": number
    },
    "current_sub_phase": "static-check" | "llm-check" | "exec-check" | null,
    "category_progress": Record<string, {
      "llm-check": "pending" | "running" | "completed" | "failed" | "skipped",
      "exec-check": "pending" | "running" | "completed" | "failed" | "skipped"
    }>
  }
}

Response 404: cycle_not_found
```

### Dispatch job detail

```
GET /api/v2/cycles/{cycle_id}/dispatch/jobs/{job_id}

Response 200:
{
  "ok": true,
  "data": {
    "job_id": string,
    "type": "static-check" | "llm-check" | "exec-check" | "task-execution",
    "status": "queued" | "running" | "completed" | "failed" | "timed_out",
    "category": string | null,
    "sub_phase": "static-check" | "llm-check" | "exec-check" | null,
    "created_at": string,
    "started_at": string | null,
    "completed_at": string | null,
    "duration_ms": number | null,
    "result": object | null,
    "error": object | null
  }
}

Response 404: job_not_found
```

Full dispatch internals (internal API, worker pool, context injection): [job-dispatch.md](job-dispatch.md).

---

## Artifacts

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

## Map & rules

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

## Reports

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

## Chat

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

## Context

### Assemble context

```
POST /api/v2/context/assemble

Request:
{
  "role": AgentRole,
  "cycle_state": CycleState,
  "task_id": string | null,
  "facilitator_mode": "chat" | "decision" | "scoping" | null
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

## Tasks

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
    "status": "in_progress",
    "claimed_at": string
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

### Get ready tasks

```
GET /api/v2/tasks/ready

Response 200:
{
  "ok": true,
  "data": {
    "tasks": SLETask[],
    "store_type": "beads" | "local",
    "synced_at": string | null
  }
}

Response 503: task_store_unavailable
```

### Resolve exit

```
POST /api/v2/tasks/{task_id}/resolve-exit

Request:
{
  "outcome": "completed" | "halted" | "user_halt" | "error" | "crash",
  "context": {
    "version_id": string | null,
    "reason": string | null,
    "report_path": string | null,
    "cycle": number,
    "iteration": number
  }
}

Response 200:
{
  "ok": true,
  "data": {
    "task_id": string,
    "outcome": string,
    "new_status": string,
    "comment_posted": boolean
  }
}

Response 500: resolve_exit_failed
```

When resolve-exit fails (E097), session state is preserved. Next daemon start
resolves the stale claim via E091.

### Comment on task

```
POST /api/v2/tasks/{task_id}/comments

Request:
{
  "body": string
}

Response 200:
{
  "ok": true,
  "data": {
    "task_id": string,
    "comment_posted": boolean
  }
}

Response 404: task_not_found
```

### Get task store status

```
GET /api/v2/tasks/store

Response 200:
{
  "ok": true,
  "data": {
    "type": "beads" | "local",
    "available": boolean,
    "last_sync": string | null,
    "total_tasks": number,
    "open_tasks": number,
    "stale_tasks": number
  }
}
```

### Create task

```
POST /api/v2/tasks

Request:
{
  "title": string,
  "description": string | null,
  "priority": number,
  "dependencies": string[] | null,
  "context_declarations": object[] | null
}

Response 201:
{
  "ok": true,
  "data": {
    "task": SLETask
  }
}
```

Full task store internals (BeadsTaskStore, LocalTaskStore, stale claim recovery): [beads-integration.md](beads-integration.md).

---

## Intake & sharding

Endpoints for the document intake and task sharding pipeline. Source spec:
[intake-and-sharding.md](intake-and-sharding.md).

The intake pipeline is triggered by the Planner's analysis during the PLAN node,
not by an intent parameter. Coherence checks and sharding occur when the Planner
determines the scope of work requires task decomposition (DDR-028).

### Run intake pipeline

```
POST /api/v2/intake

Request:
{
  "auto_approve": boolean,
  "documents": string[] | null
}

Response 200:
{
  "ok": true,
  "data": {
    "coherence_report": CoherenceReport,
    "proposal": ShardingProposal | null,
    "tasks_created": number
  }
}

Response 409:
{
  "ok": false,
  "error": {
    "code": "session_conflict",
    "message": "Cannot run intake while a cycle is active.",
    "details": {
      "state": SystemStatus
    }
  }
}
```

When `auto_approve` is `true`, the sharding proposal is approved automatically
if the coherence gate passes with status `clean` or `flagged`. When `false`,
the proposal is created but not approved — the user must call the approve
endpoint.

When `documents` is `null`, all files in `.sle/project-docs/` are processed.

### Get coherence report

```
GET /api/v2/intake/coherence

Response 200:
{
  "ok": true,
  "data": {
    "report": CoherenceReport
  }
}

Response 404:
{
  "ok": false,
  "error": {
    "code": "no_coherence_report",
    "message": "No intake pipeline has run for the current session."
  }
}
```

### Resolve coherence finding

```
POST /api/v2/intake/coherence/resolve

Request:
{
  "finding_index": number,
  "action": "resolved" | "suppressed",
  "resolution": string | null
}

Response 200:
{
  "ok": true,
  "data": {
    "report": CoherenceReport
  }
}

Response 404:
{
  "ok": false,
  "error": {
    "code": "finding_not_found",
    "message": "Finding index out of range."
  }
}

Response 409:
{
  "ok": false,
  "error": {
    "code": "finding_not_blocking",
    "message": "Only blocking findings require explicit resolution."
  }
}
```

### Get sharding proposal

```
GET /api/v2/intake/sharding

Response 200:
{
  "ok": true,
  "data": {
    "proposal": ShardingProposal
  }
}

Response 404:
{
  "ok": false,
  "error": {
    "code": "no_sharding_proposal",
    "message": "No sharding proposal exists. Intake may not have run."
  }
}
```

### Modify sharding proposal

```
PATCH /api/v2/intake/sharding

Request:
{
  "tasks": {
    "add": [{ "title": string, "description": string, "slices": ArtifactRef[], "dependencies": string[], "priority": number }] | null,
    "remove": [{ "task_index": number }] | null,
    "edit": [{ "task_index": number, "title": string | null, "description": string | null, "slices": ArtifactRef[] | null, "dependencies": string[] | null, "priority": number | null }] | null
  }
}

Response 200:
{
  "ok": true,
  "data": {
    "proposal": ShardingProposal
  }
}

Response 400:
{
  "ok": false,
  "error": {
    "code": "invalid_proposal",
    "message": string
  }
}
```

### Intake sharding approve

```
POST /api/v2/intake/sharding/approve

Response 200:
{
  "ok": true,
  "data": {
    "tasks_created": number
  }
}
```

### Intake sharding reject

```
POST /api/v2/intake/sharding/reject

Response 200:
{
  "ok": true,
  "data": {
    "rejected": true
  }
}
```

### Get intake task store status

```
GET /api/v2/intake/taskstore

Response 200:
{
  "ok": true,
  "data": {
    "provider": "beads" | "local",
    "tasks_count": number,
    "stale_count": number,
    "ready_count": number
  }
}
```

### List intake documents

```
GET /api/v2/intake/documents

Response 200:
{
  "ok": true,
  "data": {
    "documents": IntakeDocument[]
  }
}
```

### Promote document

```
POST /api/v2/intake/documents/{document_id}/promote

Response 200:
{
  "ok": true,
  "data": {
    "document": IntakeDocument,
    "node_id": string
  }
}

Response 404:
{
  "ok": false,
  "error": {
    "code": "document_not_found",
    "message": "Document {document_id} does not exist."
  }
}

Response 409:
{
  "ok": false,
  "error": {
    "code": "already_promoted",
    "message": "Document is already promoted.",
    "details": {
      "node_id": string
    }
  }
}
```

---

## Knowledge engine

Endpoints for the optional knowledge engine (Cognee) layer. Source spec:
[knowledge-engine.md](knowledge-engine.md).

### Knowledge health

```
GET /api/v2/knowledge/health

Response 200:
{
  "ok": true,
  "data": {
    "available": boolean,
    "provider": "cognee" | "noop",
    "circuit_breaker_open": boolean,
    "dataset": string | null
  }
}
```

### Knowledge status

```
GET /api/v2/knowledge/status

Response 200:
{
  "ok": true,
  "data": {
    "enabled": boolean,
    "provider": "cognee" | "noop",
    "url": string,
    "circuit_breaker": {
      "open": boolean,
      "consecutive_failures": number,
      "reset_at": string | null
    },
    "dataset": string,
    "last_ingestion": string | null,
    "last_cognify": string | null
  }
}
```

### Knowledge search

```
POST /api/v2/knowledge/search

Request:
{
  "query": string,
  "type": "insights" | "chunks" | "graph",
  "max_results": number | null,
  "metadata_filter": Record<string, string> | null
}

Response 200:
{
  "ok": true,
  "data": {
    "results": SearchResult[],
    "total": number,
    "search_type": string
  }
}

Response 503:
{
  "ok": false,
  "error": {
    "code": "knowledge_unavailable",
    "message": "Knowledge engine is not available."
  }
}
```

### Knowledge ingest

```
POST /api/v2/knowledge/ingest

Request:
{
  "content": string,
  "metadata": Record<string, string>
}

Response 200:
{
  "ok": true,
  "data": {
    "ingested": true
  }
}

Response 503:
{
  "ok": false,
  "error": {
    "code": "knowledge_unavailable",
    "message": "Knowledge engine is not available."
  }
}
```

### Knowledge cognify

```
POST /api/v2/knowledge/cognify

Response 200:
{
  "ok": true,
  "data": {
    "initiated": true
  }
}

Response 503:
{
  "ok": false,
  "error": {
    "code": "knowledge_unavailable",
    "message": "Knowledge engine is not available."
  }
}
```

---

## Content store

Endpoints for node content CRUD, streaming, and attachments. Source spec:
[content-modules.md](content-modules.md).

### Get node content

```
GET /api/v2/graph/node/{id}/content

Response 200:
{
  "ok": true,
  "data": {
    "node_id": string,
    "format": ContentFormat,
    "body": string,
    "attachments": Attachment[],
    "size_bytes": number,
    "checksum": string,
    "created_at": string,
    "updated_at": string
  }
}

Response 404:
{
  "ok": false,
  "error": {
    "code": "content_not_found",
    "message": "No content for node {id}."
  }
}
```

### Write node content

```
PUT /api/v2/graph/node/{id}/content

Request:
{
  "format": ContentFormat,
  "body": string
}

Response 200:
{
  "ok": true,
  "data": {
    "node_id": string,
    "format": ContentFormat,
    "size_bytes": number,
    "checksum": string,
    "updated_at": string
  }
}

Response 400:
{
  "ok": false,
  "error": {
    "code": "content_too_large",
    "message": "Content exceeds maximum size."
  }
}
```

### Stream node content

```
GET /api/v2/graph/node/{id}/content/stream

Response 200:
Transfer-Encoding: chunked
X-Content-Size: {total_bytes}
X-Content-Checksum: {sha256}

(chunked binary stream)
```

Only available for content exceeding 10 MB. Response headers include
`X-Content-Size` (total bytes for progress bar) and `X-Content-Checksum`
(SHA-256 for verification).

### Get attachment

```
GET /api/v2/graph/node/{id}/content/attachments/{attachment_id}

Response 200:
(binary download with Content-Type and Content-Disposition headers)

Response 404:
{
  "ok": false,
  "error": {
    "code": "attachment_not_found",
    "message": "Attachment {attachment_id} not found."
  }
}
```

### Add attachment

```
POST /api/v2/graph/node/{id}/content/attachments

Request (multipart/form-data):
  file: binary

Response 201:
{
  "ok": true,
  "data": {
    "attachment": Attachment
  }
}

Response 400:
{
  "ok": false,
  "error": {
    "code": "attachment_too_large",
    "message": "Attachment exceeds maximum size."
  }
}
```

### Search node content

```
GET /api/v2/graph/content/search?q={query}&format={ContentFormat}&layer={LayerIndex}&limit={number}

Query params:
  q: string (search query, required)
  format: ContentFormat | null
  layer: LayerIndex | null
  limit: number (default 20, max 100)

Response 200:
{
  "ok": true,
  "data": {
    "results": Array<{
      "node_id": string,
      "node_label": string,
      "layer": LayerIndex,
      "format": ContentFormat,
      "snippet": string,
      "rank": number
    }>
  }
}

Response 501:
{
  "ok": false,
  "error": {
    "code": "search_not_enabled",
    "message": "Full-text search is not enabled. Set graph.content.full_text_search: true in map.yaml."
  }
}
```

---

## Modules

Endpoints for layer module management. Source spec:
[content-modules.md](content-modules.md).

### List modules

```
GET /api/v2/graph/modules

Response 200:
{
  "ok": true,
  "data": {
    "modules": Array<{
      "id": string,
      "name": string,
      "version": string,
      "layer": LayerIndex,
      "enabled": boolean,
      "last_run": string | null,
      "state": "idle" | "processing" | "errored" | "timed_out"
    }>
  }
}
```

### Trigger module

```
POST /api/v2/graph/modules/{id}/trigger

Request:
{
  "trigger_type": "on_demand" | null,
  "filter": {
    "nodeTypes": string[] | null,
    "states": NodeState[] | null,
    "group_id": string | null
  } | null
}

Response 200:
{
  "ok": true,
  "data": {
    "module_id": string,
    "trigger_type": string,
    "nodes_processed": number,
    "duration_ms": number,
    "result": ModuleResult
  }
}

Response 404:
{
  "ok": false,
  "error": {
    "code": "module_not_found",
    "message": "Module {id} is not registered."
  }
}
```

### Get module annotations

```
GET /api/v2/graph/modules/{id}/annotations/{node_id}

Response 200:
{
  "ok": true,
  "data": {
    "module_id": string,
    "node_id": string,
    "annotations": Record<string, unknown>
  }
}

Response 404:
{
  "ok": false,
  "error": {
    "code": "module_not_found" | "node_not_found",
    "message": string
  }
}
```

### Get module outputs

```
GET /api/v2/graph/modules/{id}/outputs

Response 200:
{
  "ok": true,
  "data": {
    "module_id": string,
    "derived_nodes": ModuleDerivedNode[],
    "annotations_count": number,
    "last_run": string | null
  }
}

Response 404:
{
  "ok": false,
  "error": {
    "code": "module_not_found",
    "message": "Module {id} is not registered."
  }
}
```

### Update module config

```
PUT /api/v2/graph/modules/{id}/config

Request:
{
  "config": Record<string, unknown>,
  "enabled": boolean | null
}

Response 200:
{
  "ok": true,
  "data": {
    "module_id": string,
    "config": Record<string, unknown>,
    "enabled": boolean
  }
}

Response 404:
{
  "ok": false,
  "error": {
    "code": "module_not_found",
    "message": "Module {id} is not registered."
  }
}
```

---

## Document linking

Endpoints for the link index — forward links, backlinks, manual links, reindex,
and file index. Source spec: [document-linking.md](document-linking.md).

### List links

```
GET /api/v2/links?source={LinkSource}&target={LinkTarget}&link_type={string}&limit={number}

Query params (all optional):
  source: JSON-encoded LinkSource (kind + key/group)
  target: JSON-encoded LinkTarget (kind + key/path/group)
  link_type: Filter by AutoLinkType | 'manual'
  limit: Max results (default 100, max 500)

Response 200:
{
  "ok": true,
  "data": {
    "links": ForwardLink[],
    "total": number
  }
}
```

### Get backlinks

```
GET /api/v2/links/backlinks?target={LinkTarget}

Query params:
  target: JSON-encoded LinkTarget (required)

Response 200:
{
  "ok": true,
  "data": {
    "backlinks": Backlink[],
    "count": number
  }
}
```

### Create manual link

```
POST /api/v2/links

Request:
{
  "source": LinkSource,
  "target": LinkTarget,
  "context": string
}

Response 201:
{
  "ok": true,
  "data": {
    "link_id": string,
    "source": LinkSource,
    "target": LinkTarget,
    "link_type": "manual",
    "created_at": string
  }
}

Response 409:
{
  "ok": false,
  "error": {
    "code": "link_already_exists",
    "message": "A link with this source, target, and type already exists."
  }
}

Response 400: invalid_link_target
Response 400: invalid_link_source
```

### Delete manual link

```
DELETE /api/v2/links/{link_id}

Response 200:
{
  "ok": true,
  "data": {
    "link_id": string,
    "deleted": true
  }
}

Response 404: link_not_found
Response 403:
{
  "ok": false,
  "error": {
    "code": "cannot_delete_auto_link",
    "message": "Automatic links cannot be deleted via the API."
  }
}
```

### Trigger full reindex

```
POST /api/v2/links/reindex

Response 202:
{
  "ok": true,
  "data": {
    "status": "reindexing",
    "started_at": string
  }
}

Response 409:
{
  "ok": false,
  "error": {
    "code": "reindex_in_progress",
    "message": "A reindex is already in progress."
  }
}
```

### Get file index entry

```
GET /api/v2/links/files/{path}

Response 200:
{
  "ok": true,
  "data": FileEntry
}

Response 404:
{
  "ok": false,
  "error": {
    "code": "file_not_indexed",
    "message": "File {path} is not in the index."
  }
}
```

---

## WebSocket events (DDR-028 additions)

Additional WebSocket events for the SCOPING cycle start and tag system:

| Event | Payload | When |
|---|---|---|
| `cycle.scoping_input_requested` | `cycle_id, timestamp` | Fired when `awaiting_scoping` becomes true |
| `cycle.charter_produced` | `cycle_id, charter_content, timestamp` | Fired when SCOPING produces the charter |
| `graph.node_tagged` | `node_id, tag, timestamp` | Fired when a tag is added to a node |
| `graph.node_untagged` | `node_id, tag_prefix, value, timestamp` | Fired when a tag is removed from a node |

Full event catalogue: [../reference/websocket-events.md](../reference/websocket-events.md).
