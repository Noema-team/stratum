# Process Application Functional Maturity

**Status:** implementation increment on `feat/process-functional-maturity`
**Date:** 2026-10-21
**Foundation:** [DDR-042](../decisions/ddr-042-process-centric-application.md) and [Stratum Process Application v0.1](stratum-process-application-v0.1.md)

## Audit findings

The accepted Process foundation already provided durable Projects, Objectives, repository links, Processes, activity, proposal-linked reviews, and lifecycle state. The audit found that Process intent and scope could not evolve; deferred proposals disappeared from actionable views; completion did not call out unresolved records; overview activity was only a latest-per-Process approximation; navigation lived in component state; and normal API startup did not explicitly bind to loopback. The scheduler, workflow engine, WorkService, and kernel execution model were outside these gaps and remain outside this increment.

## Delivered capabilities

- Process intent, title, outcomes, constraints, Objective, and repository links are captured as accepted definition versions. A proposed amendment is a separate record; only explicit acceptance changes the Process and appends a new version. Rejection leaves the accepted definition untouched. Activity stores the definition version under which each entry was recorded.
- Historical Processes receive a version-one definition in append-only Migration 16. The migration does not rewrite earlier migration definitions.
- Deferred proposals remain visible separately from pending reviews and rejected proposals. A user can reopen a deferred proposal, preserving the original proposal and decision history.
- Completing a Process presents pending, deferred, revision-requested proposals, and proposed definition amendments. The user must explicitly acknowledge those unresolved items and provide an outcome. Acknowledgment is recorded as an activity entry.
- Project routes and Process routes are bookmarkable hash URLs. Back/forward and direct-load behavior are supported without adding path-based SPA fallback. Missing or inaccessible Process IDs return to the safe Project root.
- The overview reads a bounded, project-wide activity feed ordered by event time. A Process next action is shown only when its records establish one (pending review, reconsidering deferred work, requested revision, proposed amendment, or resuming a paused Process). It does not infer progress from lifecycle labels or prose.
- The local CLI explicitly binds the control plane to `127.0.0.1`. The server refuses a non-loopback bind unless authentication is enabled. The existing execution dashboard routes remain served by the same server.

## Identity and authority limits

The current trusted single-user application records the local actor as `local-user`; it does not provide multi-user identity, RBAC, or a secure external-user bootstrap flow. A non-loopback server requires the existing bearer-token authentication option. Human acceptance applies only to the named proposal or Process definition amendment. It does not grant tool permission, authorize a WorkItem, or mutate a WorkItem or WorkflowRun. GitHub remains authoritative for repository and CI state.

The unresolved-items list covers persisted proposal and amendment states. It cannot claim to enumerate unrecorded concerns. Users should record concerns and decisions in the Process history before relying on completion acknowledgment.

## Verification scenarios

Automated service/API tests cover amendment acceptance and rejection, persistence across application restart, proposal reopening, completion acknowledgment, event ordering, isolation from kernel WorkItems and WorkflowRuns, local-bind policy, and safe routing parsing. The `/app/` browser smoke check covers direct Process navigation, reload, back/forward, and switching Projects without displaying stale Process data. `npm run verify` is the final repository gate.

## Next milestone

With the Process foundation durable and navigable, v0.2 can scope one persistent Goose AgentSession attached to a Process and an isolated runtime workspace, with live activity, permission mediation, and reconnection. It must preserve human authority and must not promote Process completion into execution authorization. Multi-agent orchestration, distributed hosting, and general automation remain out of scope.
