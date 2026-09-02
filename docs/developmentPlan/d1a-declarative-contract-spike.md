# D.1a — Declarative workflow contract spike

**Status:** D.1a spike accepted with five corrections (§5); D.1b (the
production implementation) landed, was reviewed, and D.1c (five further
corrections — §7) is complete. D.1 as a whole is closed. The original spike
test file (`tests/d1a-declarative-contract-spike.test.ts`) was observational
and has been deleted; its claims and every D.1c correction are now proven by
the permanent suite `tests/declarative-workflow-contract.test.ts` plus the
`/work/:id/artifacts` endpoint tests in `tests/api.test.ts`, both exercising
the real (now-modified) `ContextManager`, `agent-runner.ts`,
`StratumAgentAdapter`, and `FullBuildStepRunner` code, part of the ordinary
regression suite going forward.
**Milestone:** D, phase D.1a → D.1b → D.1c (see
`CURRENT_FOCUS_INTENT_TO_READY_WORK.md` §9, as amended)
**Question:** Can a genuinely new workflow define its own instructions and
output Artifact without adding its step IDs to `WorkflowEngine`,
`FullBuildStepRunner`, `ContextManager`'s task maps, or `AgentRunner`'s
role/path special cases?

**Original spike answer: not yet, for the produce/review path.**
`WorkflowEngine`'s dispatch was already clean; the block was entirely
inside the shared produce/review path: `AgentStepRunner` → `ContextManager`
→ `AgentRunner`. §1–§4 below are the original spike's trace and findings,
preserved for the record with one correction (§2, the execute-kind claim
was too strong). §5 is the contract as actually implemented in D.1b, after
review.

---

## 1. The traced path

```text
WorkflowDefinition (workflow/types.ts)
    ↓
WorkflowEngine.run()              (workflow/engine.ts)
    ↓
deps.stepRunner.run(step, ctx)    — ONE StepRunner instance for the whole
    ↓                                application (application.ts:210); today
FullBuildStepRunner.run()            it is FullBuildStepRunner, wired once
    ↓                                at daemon startup, not per-workflow.
  (no step.id match → falls through)
    ↓
AgentStepRunner.run(step, ctx)    (execution/agent-step-runner.ts)
    ↓ extracts step.agentRole only — step.templateId is dropped here
AgentRunner.run(role, ctx)        (agent-runner.ts)
    ↓
ContextManager.assemble(role, ctx)   (context-manager.ts) — no `step`
    ↓                                   parameter at all, only `role`
LLM call → parseAgentOutput() → validateOutputPath() → fs.writeFile()
    ↓
updateArtifactEntries()           (workflow/artifact-utils.ts) — writes
                                      one entry to .sle/map.yaml
```

**`ArtifactRepository`** (`storage/repositories.ts:635`, the SQLite table
matching DDR-032 §8.11's provenance schema — WorkItem/WorkflowRun/
StepExecution/type/ref/path/hash) **has zero callers anywhere in `src/`.**
Grep confirms this; nothing in the produce path, `FullBuildStepRunner`, or
`WorkflowEngine` writes to it. Today "artifact provenance" is exactly one
thing: an entry in `.sle/map.yaml`'s `artifacts` list (path + generating
role + timestamp), which is workflow-blind and not control-plane-queryable.

## 2. What is already clean (do not touch in D.1b)

- **`WorkflowEngine`** (`workflow/engine.ts`) has no `step.id` branching at
  all — its only `next_step_id === null` check is structural, not
  methodology. It is exactly as generic as DDR-031/032 claim.
- **`FullBuildStepRunner`**'s `step.id === '...'` branches
  (original: `full-build-step-runner.ts:57-73, 97`) are legitimately
  full-build-scoped and hit the `StepRunner` interface's *optional*
  kind-override hooks (`handleCheckpoint`/`handleExecute`/`handleCommit`).
  For an unrecognized step ID, `run()`'s produce/review fallback
  (`agentStepRunner.run(step, ctx)`) and `handleCommit`'s fallback
  (`markRunning` → `markComplete` → done) were already genuinely generic.
- **Correction (per review): `handleExecute` was overstated as generic in
  the original spike text.** It unconditionally called
  `this.deps.execService.run(workflowRunId, iteration)` — full-build's own
  `ExecService` — for *any* workflow's `execute`-kind step, regardless of
  `workflowId`. A non-full-build workflow reusing that kind would have
  silently run full-build's test-execution service against an unrelated
  run. This was a real gap, not a clean fallback; §5 below fixes it by
  guarding on `ctx.workflowId === 'full-build'` and failing closed
  otherwise, since 'execute' has no generic implementation yet.
- **A new workflow still does not need to add branches to `run()`,
  `handleCheckpoint`, or `handleCommit`** as long as its step IDs don't
  collide with full-build's reserved ones (`critique`, `validation_gate`,
  `scoping.produce`, `summarise`, `debug`, `confirm`, `sharding_approval`,
  `scoping.checkpoint`, `snapshot`) — picking namespaced IDs
  (`define-work.synthesize-definition`) avoids this trivially. D.1b also
  now guards every one of those branches on `ctx.workflowId === 'full-build'`
  explicitly (belt-and-braces against an accidental id collision), rather
  than relying on namespacing discipline alone.
- One real wrinkle worth naming even though it isn't blocking: `WorkflowEngine`
  is constructed with exactly one shared `StepRunner` for the whole running
  application (`application.ts:188-210`), not one per workflow. This is
  incidental, not designed, and D.1b does not redesign it — the workflowId
  guards above are the containment for it, not a fix to the sharing itself.

## 3. What blocks declarative behavior (produce/review path)

All five confirmed by an executable test; file:line citations are to the
current tree.

1. **`templateId` is declared but structurally unreachable.**
   `WorkflowStep.templateId` exists (`workflow/types.ts:20`) and every
   `full-build`/`draft-artifact` step sets it
   (`workflow/builtins/full-build.ts`, `.../draft-artifact.ts`). But
   `AgentStepRunner.run(step, ctx)` reads only `step.agentRole`
   (`execution/agent-step-runner.ts:11`) before calling
   `agentRunner.run(role, ctx)` — the `step` object, and `templateId` with
   it, is discarded. `ContextManager.assemble(role, ctx)`
   (`context-manager.ts:380`) has no third parameter to receive it even if
   it were passed. `grep -rn templateId src` shows it is set in exactly two
   places and read in zero.

2. **An unfamiliar step ID silently degrades to boilerplate, not an error.**
   `buildTaskDescription()` (`context-manager.ts:464-474`) looks up
   `NODE_TASK_DESCRIPTIONS[stepId]`, then `[stepId.toUpperCase()]`, then
   `[role.toUpperCase()]`, then falls back to `` `Execute the ${stepId}
   step.` ``. A new workflow's steps hit that fallback silently — no crash,
   no signal, just an instruction that says nothing about the actual task.
   Worse than a hard failure: it looks like it worked.

3. **Artifact-slice (context) selection is a closed switch keyed only by
   role.** `getRoleSlices()` (`context-manager.ts:200-270`) is an exhaustive
   `switch (role)` with no default arm, over the ten literal values of
   `AgentRole`. It has no visibility into `step.id`, `templateId`, or any
   declared input-context contract. Two structurally different synthetic
   steps sharing a role resolve to byte-identical context shapes.

4. **Output-path enforcement is a global per-role allowlist, and its
   default for an unlisted role is "unrestricted," not "deny."**
   `ROLE_OUTPUT_PATHS` (`agent-runner.ts:37-47`) has no entry for the
   `explorer` role (or several others); `validateOutputPath()`
   (`agent-runner.ts:52-59`) returns `true` for any role absent from the
   table. A workflow step cannot narrow this to "exactly this declared
   Artifact" — it either inherits an existing role's unrelated static
   allowlist, or gets no enforcement at all.

5. **A genuinely new role cannot be expressed without a kernel-adjacent type
   edit.** `AgentRole` (`types.ts:15-25`) is a closed ten-member string
   union; `WorkflowStep.agentRole` is typed against it
   (`workflow/types.ts:19`). Adding a role a new workflow actually wants
   (e.g. an `investigator` distinct from `explorer`) requires editing
   `types.ts` *and* the exhaustive switch in `getRoleSlices()` — precisely
   the "new role/path special case" D.1 exists to eliminate. This is a
   structural fact verified by reading both call sites; no runtime test can
   demonstrate a value that doesn't type-check.

## 4. Target ownership (the spike's success criterion)

```text
role
  → broad permission ceiling: which capabilities/tools a role may ever use
    (e.g. "explorer never writes source code"), independent of any one
    workflow.

workflow step
  → the exact, concrete scope for this one execution: its own instruction
    text (not a role-keyed prompt file lookup), its own declared input
    context (not a role-keyed slice switch), and its own declared output
    Artifact (not a role-keyed path allowlist).

kernel (WorkflowEngine)
  → no methodology knowledge at all: it already satisfies this (§2) and
    must stay that way.
```

Today, role does double duty as both ceiling *and* concrete scope, because
step-level declarations (`templateId`, and no `output_artifact`/
`input_context` fields yet exist) never reach context assembly or output
validation. That collapse is the actual contract gap — not `WorkflowEngine`,
not `FullBuildStepRunner`.

## 5. The contract as implemented (D.1b, post-review)

The original §5 proposal was revised in five places before implementation;
this section describes what was actually built, in `src/`.

### 5.1 Declared output narrows role authority; it never replaces it

`WorkflowStep.outputArtifact?: { type: string; ref: string; path: string }`
(`workflow/types.ts`) is copied onto `StepRunContext.outputArtifact` by
`WorkflowEngine.makeStepRunContext` — the same way `role` is already copied
from `step.agentRole`. `AgentRunner.run()` (`agent-runner.ts`) then enforces,
in this order, **before any filesystem write**:

1. the declared path itself is a safe, project-root-relative path
   (`isSafeRelativePath()` — rejects absolute paths and any `..` traversal
   via path resolution/containment, not string matching);
2. cardinality — the produced output must be exactly one section; zero or
   more than one fails the step;
3. the single produced section's path exactly matches the declared path
   (normalized comparison);
4. **only then**, every produced path (declared or legacy) still passes
   through the existing `validateOutputPath()` role ceiling
   (`ROLE_OUTPUT_PATHS`) — a declared output can only narrow within that
   ceiling, never escalate past it.

`ROLE_OUTPUT_PATHS` previously had no `explorer` entry, which meant
*unrestricted* writes for that role (the fail-open bug the original spike
found). It now has a conservative entry, `explorer: ['.sle/work/']` — no
`full-build`/`draft-artifact` step uses the `explorer` role, so this closes
the gap without touching any legacy role's behavior or requiring a broader
audit of other roles in this change.

### 5.2 `templateId` stays inert; `instruction` is the new channel

`templateId` is unchanged — still declared, still unread. `ContextManager.
buildTaskDescription()` now checks `ctx.instruction` **first**, falling back
to the existing `NODE_TASK_DESCRIPTIONS` lookup only when a step declares
no instruction. `full-build`/`draft-artifact` steps set neither `instruction`
nor `outputArtifact`, so their prompts are byte-for-byte unchanged.

### 5.3 Input context: declared artifact refs only, no control-plane query

`WorkflowStep.inputArtifactRefs?: string[]` — plain artifact refs in the
same string format `SliceDef.ref` already uses (`doc:...`, `.sle/...`, a
bare project-relative path). `ContextManager.resolveSliceDefs()` uses these
**instead of** `getRoleSlices()`'s role switch when present, not in addition
to it — a step that declares refs is fully described by its own
declaration. No `objective | repository | prior_artifacts` resolution and
no ContextManager→control-plane-DB query were added; that remains out of
scope until `ObjectiveService` exists (D.2). Ephemeral context
(`ctx.ephemeral`) is unaffected — it is still checked first per-ref inside
`loadSliceContent()`.

### 5.4 Artifact provenance: correct WorkItem/WorkflowRun linkage, no invented StepExecution

The Scheduler creates one outer `StepExecution` per adapter invocation, not
one per `WorkflowStep` — so D.1b does not manufacture or guess a
`stepExecutionId` for a declaratively-recorded artifact. It records
`workItemId` (new: `StepRunContext.workItemId`, populated by
`WorkflowEngine` from the `workItemId` already passed into `run()`),
`workflowRunId`, `type`, `ref`, a project-root-relative `path` (the
`ArtifactRecord.path` doc-comment was corrected — it previously said
"relative to `.sle/`", which was never true of how `AgentRunner` writes),
`hash` (sha256 of the written content), and `createdAt`. `stepExecutionId`
is left unset.

Idempotency: `ArtifactRepository.findByWorkflowRunAndRef(workflowRunId,
ref)` is checked before every `save()` — a retried step recording the same
`(workflowRunId, ref)` is a no-op on the second attempt. This is an
application-level check, not a DB unique constraint (there wasn't one
before D.1b and none was added), so it is race-prone under true concurrent
retries of the *same* step — acceptable for now since nothing dispatches
concurrent retries of one step yet; worth a real constraint if that changes.

`StratumAgentAdapter.execute()` now populates `ExecutionResult.artifacts`
by querying `ArtifactRepository.listByWorkflowRun(request.workflowRunId)`
after the engine run returns, rather than threading artifacts through
`WorkflowRunResult` (which stays exactly as it was).

### 5.5 `FullBuildStepRunner` guarded by workflow identity

Every step-id branch in `run()` and `handleCheckpoint()` is now also gated
on `ctx.workflowId === 'full-build'`. `handleCheckpoint`'s and
`handleCommit`'s fallbacks for anything that doesn't match remain the
existing generic behavior. `handleExecute` now fails closed
(`outcome: 'failed'`) for any workflow other than `full-build`, instead of
running full-build's `ExecService` against it (§2 correction above) —
`define-work` does not need `execute`, so this is not a blocker for D.3.

### 5.6 What was deliberately not touched

- `AgentRole` and `getRoleSlices()`'s switch are unchanged. `define-work`
  (D.3) reuses the existing `explorer` role and drives its actual per-step
  behavior through `instruction`/`inputArtifactRefs`/`outputArtifact`.
- `WorkflowEngine`'s control flow/step-kind dispatch is unchanged — the only
  addition there is `makeStepRunContext` copying four more step-declared
  fields onto `ctx`, the same pattern it already used for `role`.
- The single-shared-`StepRunner` wrinkle (§2) is contained by the workflowId
  guards in §5.5, not redesigned.
- No new `StepKind`, domain entity, or DB schema/migration was added.

## 6. Test coverage

`tests/declarative-workflow-contract.test.ts` proves, against the real
implementation:

- a step's `instruction` reaches the assembled task text;
- declared `inputArtifactRefs` fully control loaded context (not additive
  to role defaults);
- an exact declared output is accepted and its provenance recorded;
- undeclared/extra output sections are rejected (cardinality);
- a declared output path outside the role's ceiling is rejected (role
  authority cannot be escalated by declaration);
- unsafe paths (`..` traversal) fail before any write;
- repeating the same step does not duplicate a provenance row (idempotency);
- the recorded row's `workItemId`/`workflowRunId` match the run;
- `full-build`'s reserved step ids still route through `FullBuildStepRunner`'s
  special-cased methods when `workflowId === 'full-build'`;
- the same step ids on a different `workflowId` do **not** trigger those
  full-build-specific branches.

## 7. D.1c — review corrections

D.1b was architecturally accepted but review found three concrete contract
bugs and two closure gaps. All five are fixed; D.1 is closed as of this
section.

### 7.1 Internal traversal could escape a role's ceiling

`isSafeRelativePath()` (D.1b) proved only that the *resolved* path stayed
inside `projectRoot` — it said nothing about whether the path still meant
what its raw string claimed once resolved. A declared path like
`.sle/work/../../src/evil.ts`:

- resolves inside `projectRoot` (passes a naive containment check);
- literally starts with the string `.sle/work/` (passes a naive
  string-prefix ceiling check on the *raw* input);
- but `path.join()` at the actual write resolves it to `src/evil.ts` —
  outside the `explorer` role's ceiling entirely.

Fixed by introducing `src/path-safety.ts` (`safeRelativeSegments` /
`toSafeRelativePath`), shared by `agent-runner.ts` and `context-manager.ts`.
It rejects any `..` segment outright — conservative rejection rather than
resolve-then-hope — and returns one canonical value. `AgentRunner.run()` now
canonicalizes every produced section exactly once (§6a in the code) and
uses that single canonical value for cardinality/exact-match, the role
ceiling, the filesystem write, and `ArtifactRecord.path` — the four things
this bug could previously see different, divergent versions of the same
path. Regression test: `tests/declarative-workflow-contract.test.ts` — "D.1c:
internal traversal that stays inside projectRoot but escapes the declared
.sle/work/ ceiling is rejected before any write".

### 7.2 `inputArtifactRefs` had no traversal confinement, and `[]` was ambiguous

Two separate issues in `ContextManager`:

- `resolveArtifactPath()`/`resolveSummaryPath()` joined a ref's key straight
  into `.sle/project-docs`, `.sle/project-graph/layers`, `runDir`, or
  `projectRoot` without validating it — a declared `inputArtifactRefs` entry
  (unlike the hardcoded `SliceDef` constants) is not a trusted literal, and
  nothing stopped e.g. `doc:../../../../etc/passwd` from resolving outside
  `.sle/project-docs`. Fixed: every ref-kind branch now runs its key(s)
  through `safeRelativeSegments()` and returns `null` (already handled
  gracefully by `loadSliceContent` as "slice not loaded") on any unsafe
  segment.
- `ctx.inputArtifactRefs?.length > 0` meant `inputArtifactRefs: []` silently
  fell back to `getRoleSlices()` — indistinguishable from not declaring the
  field at all. Fixed: the check is now `!== undefined`, so an explicit `[]`
  means "no artifact slices" and only an actually-undeclared field falls
  back to role defaults.

### 7.3 Provenance idempotency went stale under iterative refinement

Deduping by `(workflowRunId, ref)` meant a second, *different* version of
the same ref within the same run (e.g. a Definition refined from v1 to v2)
was silently dropped — the DB kept recording v1's hash while the file on
disk was v2. Fixed: `ArtifactRepository.findByWorkflowRunRefAndHash(
workflowRunId, ref, hash)` replaces the old ref-only lookup — identical
content is still a no-op retry, but changed content under the same ref
records a new row. `ArtifactRepository` keeps the full version history
(`listByWorkItem`/`listByWorkflowRun`, unchanged); two new methods,
`listLatestByWorkflowRun`/`listLatestByWorkItem`, project one row per
distinct `ref` (most recently inserted, by `rowid` rather than `created_at`
— millisecond timestamps can collide). `StratumAgentAdapter.execute()` now
calls the "latest" variant for `ExecutionResult.artifacts`, so a caller
consuming that result sees current artifacts, not every historical version.

### 7.4 `GET /work/:id/artifacts`

Added, following the exact pattern of the existing `/work/:id/evidence`
handler (`src/api/handlers/evidence.ts`): workspace-scoped through the same
`inWorkspace(workItems, projects, workspaceId, id)` check, returns
`ArtifactRepository.listLatestByWorkItem(id)` — metadata only (id, type,
ref, path, hash, timestamps, `workItemId`/`workflowRunId` linkage), never
file contents, and only the current version per ref (consistent with §7.3's
adapter projection). The full version history is not exposed by any route
yet — nothing outside tests consumes it, so no endpoint was added
speculatively for it.

### 7.5 Cleanup

`ROLE_OUTPUT_PATHS`'s header comment ("Roles with no entry (builder,
explorer, debugger) may write to any path") was already stale before D.1b —
`debugger` has had an explicit entry since before this milestone — and
became doubly wrong once D.1b gave `explorer` one too. Corrected to name
`builder` as the only role with no entry.

### 7.6 What D.1c did not touch

Per review instruction: `WorkflowEngine` control flow, `templateId`
activation, Objective context, `StepKind`s, `AgentRole` values, the
`Artifact`/`StepExecution` domain shape, and the shared `StepRunner`
composition are all unchanged from D.1b.
