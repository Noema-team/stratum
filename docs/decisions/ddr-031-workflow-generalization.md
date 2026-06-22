# DDR-031 — Workflow generalization: cycle → workflow run

**Date:** 2026-06-21 · **Status:** accepted
**Affects:** types.md, map-yaml-schema.md, state-machine.md, conversation.md, dag-execution.md (deleted, merged into workflow-execution.md), dag-node-reference.md (deleted, merged into step-kind-reference.md), workflow-execution.md (new), workflow-authoring.md (new), step-kind-reference.md (new), ui-shell.md, user-flow.md, job-dispatch.md, context-manager.md, beads-integration.md, intake-and-sharding.md, document-linking.md, project-overview.md, daemon-api.md, daemon-api-endpoints.md, run-artifacts.md, init-and-discovery.md, validation.md, rule-files.md, prompt-templates.md, knowledge-engine.md, error-codes.md, websocket-events.md, artifact-registry.md, tasks-dashboard.md, backlog-system.md, content-modules.md, validation-prompts.md, glossary.md, what-is-sle.md, cycle-model.md (renamed workflow-model.md), architecture.md, agent-roles.md

## Context

The system currently has exactly one unit of work: the cycle, a single fixed
15-node DAG (SCOPING → ... → SNAPSHOT). Two constraints follow directly from
this design:

- Only one cycle can be active project-wide at a time (`active_cycle_id` is
  singular; `meta.status` is a single project-wide value).
- The only way to produce anything is to run the entire pipeline. There is no
  way to do something small — produce one spec document, run one review
  checkpoint — without paying for all 15 nodes.

This blocks the chat-centric experience the product is moving toward: chat
should be able to dispatch to short, targeted units of work as easily as it
dispatches to a full build, and several of these should be able to run at
once (different groups, different layers, even different nodes in the same
group) as long as they don't touch the same artifact. Users should also be
able to define their own workflows without a bespoke builder UI.

The groups/layers/project-graph model, the 5 edge types, and the document/
node typed-reference and linking system are unaffected by this decision —
they are preserved exactly as specified elsewhere (project-overview.md,
document-linking.md).

## Options considered

1. **Keep the fixed DAG, add a second hardcoded pipeline for "small" changes.**
   Rejected — doesn't generalize past two cases, doubles the maintenance
   surface, and still can't support user-authored workflows.
2. **Fully generic step-graph engine with no built-in presets.** Rejected —
   too much surface area for v1 with no proof the primitive set is right
   without dogfooding it via a known-good pipeline first.
3. **Six generic step kinds + two built-in workflow presets (`full-build`,
   `draft-artifact`) + user authoring via `draft-artifact` itself.** Chosen.
   `full-build` proves the primitives are sufficient by reproducing today's
   entire pipeline behaviorally unchanged; `draft-artifact` is small enough
   to be both a useful preset and the workflow creator, so no separate
   builder UI is needed.

## Decision

### Terminology

"Cycle" is renamed **workflow run** everywhere it denotes a unit of
execution. `full-build` is the built-in workflow that reproduces today's
fixed pipeline; "cycle" survives only as an informal synonym for a
`full-build` run, never as the general term. `sle start "goal"` becomes
`sle run [workflow-id] "target description"`, with `full-build` as the
default `workflow-id` when omitted — preserving today's UX for the common
case.

### Six step kinds replace the 15-node DAGNode enum

```
gather      — assemble context, no artifact produced
produce     — LLM-driven artifact generation
review      — pass/fail evaluation, deterministic where possible; declares on_fail routing
checkpoint  — pause for human input
execute     — run code/tests; non-LLM, deterministic
commit      — write + version-bump + claim-release; optional decision-log append
```

**HISTORY folds into `commit`** as a `logs_decision: boolean` side effect,
not a separate step — it was already specified as non-blocking, append-only,
"log and proceed" behavior bundled with a write, never an independently
gated stage.

**DEBUG is not a 7th kind.** Any `review` step may declare
`on_fail: { action: 'produce', target_step_id }`; the validation gate's
failure path is the only place `full-build` uses this, but the mechanism is
generic.

**SCOPING decomposes into three explicit steps** — `gather` → `produce` →
`checkpoint` — instead of remaining one atomic composite node. Behaviorally
identical to today; this is purely a modeling-clarity choice so
`workflow-authoring.md` has a clean, composable worked example.

**EVALUATE is modeled as `produce`**, not `review` — it generates a verdict
artifact; the validation gate's `review` step already owns the halt/proceed
decision, so EVALUATE has no independent blocking failure mode.

### Full-build mapping (old DAGNode → new step)

| # | Old DAGNode | New step kind | Notes |
|---|---|---|---|
| 1 | SCOPING | gather → produce → checkpoint | produces `doc:cycle-charter`, then pauses |
| 2 | DESIGN | produce | Designer role |
| 3 | CRITIQUE (cond.) | review | `on_fail` → DESIGN's produce step |
| 4 | PLAN | produce | also the iteration-retry entry point |
| 5 | TEST | produce | Tester role |
| 6 | SHARDING_APPROVAL (cond.) | checkpoint | unchanged shape |
| 7 | CONFIRM | checkpoint | optional per `user_validation.yaml` |
| 8 | BUILD | produce | Builder role |
| 9 | HISTORY | folded into the following commit (`logs_decision: true`) | not a standalone step |
| 10 | EXEC | execute | non-LLM test runner |
| 11 | VALIDATION_GATE | review | `on_fail` → DEBUG's produce step, or a halt-report commit at the iteration cap |
| 12 | DEBUG | produce (failure path of #11) | feeds PLAN's produce step |
| 13 | EVALUATE | produce | see above |
| 14 | SUMMARISE | produce | run-summary artifact |
| 15 | SNAPSHOT | commit | generic terminal commit — same lock/version/changelog behavior |

### System state simplifies

`SystemStatus` drops `cycling | halted | complete`, keeping only
`idle | discovering`. There is no project-wide "running" state once N
workflow runs can be active at once. All per-run progress (active / halted /
complete, current step, iteration, revision) lives on `WorkflowRun.status`
and related fields, never on `meta.status`. Clients derive "is work in
progress" from a count of active runs, not from system state. Chat remains
orthogonal exactly as today (DDR-020) — unaffected.

The three boolean checkpoint flags (`awaiting_scoping`, `awaiting_confirmation`,
`awaiting_sharding_approval`) collapse into one nullable pointer,
`WorkflowRun.awaiting_checkpoint: string | null` — the id of the step
currently paused, or null. Since any workflow can declare any number of
checkpoint steps, a fixed 3-flag enum no longer fits; a single nullable
pointer preserves the old exclusivity rule (at most one pause point active)
by construction.

### Concurrency: artifact-level claims, not project-wide locking

Generalizes the existing `concurrent_modification` optimistic-concurrency
pattern (intake-and-sharding.md, currently scoped to `.sle/tasks.yaml`) and
the Beads atomic task claim (`bd update --claim`, beads-integration.md) from
"tasks only" to "any artifact a workflow run is about to write."

- `ArtifactClaim { artifact_ref, claimed_by_run_id, claimed_at, artifact_version_at_claim }`,
  stored at `.sle/claims/{artifact-ref-slug}.json`, one file per claimed
  artifact, deleted on release.
- A run claims an artifact before writing to it (atomic read-version +
  write-claim). A conflicting claim from a different active run is
  **rejected immediately at dispatch** — `claim_conflict`, not retried with
  backoff. This is a deliberate divergence from `concurrent_modification`'s
  transient-retry semantics: a task-version race is brief, but an artifact
  claim is held for an entire step's duration, so a conflict represents real
  contention and the calling run should be told immediately.
- On commit: verify `artifact.version === claim.artifact_version_at_claim`,
  then write + increment version + delete claim file atomically. A mismatch
  here (should not occur under dispatch-time rejection except via a bug or
  manual edit) is the distinct backstop error `stale_claim_commit` — halts
  the run, no auto-retry.
- On halt/crash, claims release in the run's `resolveExit`-equivalent
  finally-block (generalizing beads-integration.md's single-task release to
  "every entry in `claimed_artifacts`"). Daemon restart sweeps `.sle/claims/`
  for claims whose run has no live `status: active` `WorkflowRun`.

Unrelated runs (different groups, different layers, different nodes) never
contend, because they never claim the same artifact ref. This is the
mechanism that makes "design the auth contract" (a short `draft-artifact`
run) and "implement auth" (a long `full-build` run) safe to run concurrently
and lets other chats reference `doc:auth-contract` the moment the short run
commits it, even though "auth" overall isn't finished.

### Chat-to-workflow router

Gate-action keyword matching (approve/revise/reject/halt) is unchanged —
deterministic, safety-critical. Matching free chat text to one of N
workflow `trigger.description`s is new and LLM-assisted (new
`FacilitatorMode: 'workflow_select'`, new type
`WorkflowMatchCandidate { workflow_id, target, confidence, rationale }`),
but dispatch is **never silent**: the router always surfaces "I think you
want to run **{workflow}** against **{target}** — confirm?" and only a
deterministic confirm keyword triggers `POST /api/v2/workflow-runs`. Below a
confidence threshold, fall back to chat mode with a clarifying question; on
a near-tie between two workflows, present both and let the user pick.

### Workflow authoring has no bespoke builder

A `WorkflowDefinition` is a skill-style document at `.sle/workflows/{id}.md`
(front-matter + per-step instruction body). Authoring one is literally
running `draft-artifact` with output type "workflow definition" — there is
no separate creation endpoint or builder UI. It becomes visible to the chat
router the instant it's committed, via the same claim/commit mechanism as
any other artifact. Built-in ids (`full-build`, `draft-artifact`) are
reserved and cannot be overridden by user-authored workflows.

### Run ID format

`{workflow_id}-{run_seq}-i{iteration}-{ISO8601}`, where `run_seq` is a
per-`workflow_id` monotonic counter. Replaces `c{cycle}-i{iteration}-{ISO8601}`,
which depended on a single global cycle counter that no longer cleanly
exists under concurrency. `meta.cycle` (the project-wide completed-cycle
counter) is kept as a single global `meta.completed_run_count` for
changelog/version-numbering continuity, rather than split per-workflow-id —
version numbering wants one incrementing integer, not N parallel ones.

### Discovery stays outside the workflow model

Discovery remains a distinct pre-workflow mechanism, not a workflow itself —
it's bootstrapping, not a repeatable unit of work. `full-build` requires
discovery to have completed; other workflows may not.

## Consequences

### Positive

- One mechanism covers both today's full pipeline and small, ad-hoc artifact
  production — no second hardcoded pipeline to maintain.
- Concurrent workflow runs without project-wide locking; unrelated work never
  blocks on unrelated work.
- Users can extend the system with their own workflows without a bespoke
  builder UI.
- Cross-referencing unfinished work becomes natural: a short run's committed
  output is visible to everyone the moment it commits, independent of
  whatever longer run is still in flight elsewhere.

### Negative

- More moving parts than a single fixed pipeline; this is the
  largest-surface-area spec rewrite to date (touches nearly every file in
  `docs/specs/`).
- The run-ID and version-counter scheme changes are a breaking change to any
  tooling that parsed the old `c{n}-i{n}` format.

### Risks

- LLM-assisted workflow matching could mis-route; mitigated by the mandatory
  confirm step — the router proposes, it never dispatches silently.
- Claim-conflict-rejected-at-dispatch (rather than retried) could surprise
  users accustomed to today's transient-retry semantics; needs a clear,
  distinct error message (`claim_conflict`) so it doesn't read as a bug.

## Explicitly deferred

- A bespoke workflow-builder UI — v1 ships with `draft-artifact` as the only
  authoring path.
- More than two built-in workflows.
- Cross-project workflow sharing/import.
- Allowing user-authored workflows to override a built-in's trigger
  description without touching its steps.
- Tuning the LLM router's confidence threshold — ship with a reasonable
  default, tune from real usage.

## Open questions

| ID | Question | Impact | Status |
|---|---|---|---|
| WG-001 | Does `SystemStatus` retain a `cycling`-equivalent value, or collapse to `idle \| discovering` plus a derived active-run count? | API shape, state-machine.md structure | **Resolved** — collapses to `idle \| discovering`; see Decision above |
| WG-002 | Is EVALUATE modeled as `produce` or `review`? | step-kind-reference.md accuracy | **Resolved** — `produce`; see Decision above |
| WG-003 | `meta.cycle` counter under concurrent runs: per-workflow-id, single global, or removed? | map-yaml-schema.md, version_id generation | **Resolved** — single global `meta.completed_run_count`; see Decision above |
| WG-004 | Does discovery itself become a workflow? | init-and-discovery.md scope | **Resolved** — no, stays a distinct pre-workflow mechanism |
| WG-005 | Does workflow authoring get a thin CRUD endpoint, or strictly route through `draft-artifact`'s normal run lifecycle? | daemon-api-endpoints.md surface | **Resolved** — strictly via `draft-artifact`, zero special-casing |
| WG-006 | Can user-authored workflows override a built-in's trigger description without touching its steps? | workflow-authoring.md constraints | Open — deferred, low priority |
| WG-007 | LLM-router confidence threshold and tie-break UX | conversation.md behavior | Open — ship with a default, tune from usage; tie-break is to present both candidates |
