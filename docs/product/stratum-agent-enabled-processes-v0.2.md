# Stratum v0.2 — Agent-Enabled Processes

**Status:** bounded read-only implementation; provider-backed acceptance remains blocked on local Goose configuration and credentials
**Date:** 2026-10-22
**Base:** `feat/process-functional-maturity` at `99f473a40f5afb2f7b39f477ad7ce9af1e9e4a22`
**Related:** [DDR-042](../decisions/ddr-042-process-centric-application.md), [Process Application v0.1](stratum-process-application-v0.1.md), [Functional Maturity](process-application-functional-maturity.md), and the [collaborative workspace proposal](../ideas/collaborative-agent-workspace-platform-proposal.md) (DISCUSSION reference, not an authority).

## Assessment

The v0.1 application has durable Process definitions, proposal/review history, project-scoped repository membership, and a React Process Workspace. The execution kernel exposes its own `ExecutionAdapter` for authorized WorkItems; this increment does not route Process chat through that adapter or alter its lifecycle.

The Goose ACP spike at PR #54's head (Goose 1.54.0, 2026-10-20) is useful runtime evidence: it exercised `session/new`, `session/load`, `session/list`, multi-turn conversation restoration, cancellation during observed work, and one `allow_once` permission exchange under `GOOSE_MODE=approve`. It also showed that a client disconnect is distinct from an engine-host restart. The spike explicitly did not qualify filesystem/process isolation, writable workspace safety, multi-session concurrency, or every recovery edge. Its conclusions are implementation evidence, not permission to reuse its scratch-repository setup as a sandbox.

The current runtime environment has Docker 28.4.0 and can enforce a read-only container root and read-only bind mounts. Linux user namespaces are blocked here (`bwrap` cannot write `/proc/self/uid_map`), so bubblewrap is not a usable fallback. No Goose executable, Goose configuration, or provider credentials are present. Consequently this implementation is limited to an explicitly read-only repository workspace. Writable coding operations remain unavailable until a separate worktree and write-permission boundary is built and verified. A real provider-backed Goose acceptance run is an external prerequisite and will not be reported as passed here.

## Ownership and authority

- A Process owns the enduring intent, accepted scope, and human decisions.
- An AgentSession is a durable Stratum record attached to exactly one Process and its Project. At most one non-terminal session may belong to a Process.
- A RuntimeWorkspace is a Stratum-managed, read-only Docker workspace mounted from exactly one repository that is linked to the Process's Project and selected in its accepted definition.
- Goose owns its engine-native conversation handle. Stratum stores the session identity, operation intents, observed normalized events, and permission decisions. The host log is the application projection; it does not claim to replace Goose's transcript.
- The user owns Process decisions. Agent messages and tool results remain claims until the user explicitly records or reviews them through existing Process mechanisms.
- The WorkflowEngine, WorkService, Scheduler, WorkItems, WorkflowRuns, and evidence authority remain independent.

## Runtime boundary

The first connector is Goose 1.54.0 over ACP stdio, behind a Stratum-owned connector interface. It runs in a container with no Docker socket, dropped capabilities, `no-new-privileges`, PID and memory bounds, a read-only root filesystem, a per-session writable engine-state directory, and one explicitly authorized repository bind mounted read-only at `/workspace`. The workspace manager resolves the configured local checkout, rejects symlink/non-directory paths, verifies its Git root and canonical remote against the linked repository, and captures the starting commit before mounting it.

The pinned container reference is `ghcr.io/aaif-goose/goose:1.54.0@sha256:c8a6b66718fafc405055bb642ab1cccbb9a31ed76d1fbd1e4385d18c43cdb4d0`. A local container smoke check confirmed the image reports Goose 1.54.0 and answers ACP `initialize`. This does not qualify provider authentication, a real model turn, restore behavior through the Stratum connector, or the full acceptance scenario.

Only one repository is visible in this first slice. File requests are normalized and checked to remain under `/workspace`; file writes, directory creation, terminal execution, push, merge, deployment, and any host path outside the mounted repository are refused. Permission requests are durable and tied to one exact ACP tool operation. Only `allow_once` and `reject_once` are valid outcomes; `allow_always` is never selected. Read-only container and bind-mount restrictions remain in force even when a permission is granted.

Docker is a required runtime boundary. If Docker is absent or the isolation options cannot be applied, session creation fails closed. The ordinary local Process UI stays usable. The application does not silently fall back to running Goose on the host.

This slice does not claim to prevent a model provider from receiving repository context that Goose reads. It also does not claim multi-user isolation. The user must trust the configured Goose provider for repository content. Provider secrets must not be inserted into prompts or Stratum events.

## Durable session and recovery semantics

Session state distinguishes `starting`, `idle`, `running`, `awaiting_permission`, `interrupted`, `outcome_unknown`, `stopped`, and `failed`. Terminal states do not imply Process completion.

Every user prompt has a client idempotency key and a durable host operation ID. Stratum records prompt intent before dispatch. Repeating a key returns its recorded operation and never calls Goose again. If the server cannot establish whether a prompt reached ACP, the operation becomes `outcome_unknown`; the UI does not offer a blind resend. Browser refresh only reads the session and event cursor; it never creates a session or replays a prompt.

On host restart, non-terminal session records become interrupted and in-flight prompt intents become outcome-unknown. Recovery starts a fresh Goose ACP process against the same per-session engine state directory and asks Goose to list/load the persisted native session. Reconciliation may update the engine handle and restore the transcript projection, but it never submits the uncertain user prompt again. If the engine store is missing or inconsistent, Stratum preserves its own event history and exposes that native conversation restoration is unavailable; it does not invent a successful turn.

Engine stream events are appended with monotonically increasing Stratum sequence numbers. Clients fetch after a sequence cursor, so missed events are recoverable without a general event-processing service or browser-specific mutations. Permission requests and decisions are stored separately from model-generated claims.

## Delivery slices and gates

1. **Session foundation implemented:** append-only session/workspace/event/operation/permission persistence, workspace validation, Docker isolation configuration, ACP connector, and a pinned-commit snapshot regression. Additional connector/API ownership and idempotency integration tests remain necessary.
2. **Process Workspace implemented:** session status, event cursor refresh, prompts, permission decisions, cancel/reconcile controls, and explicit user actions to record agent claims as Process updates or proposals. A refresh reads the existing session and does not submit a prompt.
3. **Real Goose qualification not complete:** local checks covered the pinned image/version, ACP initialization, and Docker read-only container behavior. No provider-backed session or model turn ran because this environment has no Goose configuration or provider credentials. The accepted end-to-end Process scenario remains unqualified.

Writable repository changes, automated shell execution, multiple repositories per session, tool-network allowlisting, multiple concurrent sessions per Process, remote/multi-user access, merge/deployment, WorkItem handoff, and multi-agent scheduling are out of scope.
