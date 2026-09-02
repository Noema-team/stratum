# D.1a — Declarative workflow contract spike

**Status:** Investigation complete. No production code changed by this
document; see `tests/d1a-declarative-contract-spike.test.ts` for the
executable proof of each claim below.
**Milestone:** D, phase D.1a (see `CURRENT_FOCUS_INTENT_TO_READY_WORK.md` §9,
as amended)
**Question:** Can a genuinely new workflow define its own instructions and
output Artifact without adding its step IDs to `WorkflowEngine`,
`FullBuildStepRunner`, `ContextManager`'s task maps, or `AgentRunner`'s
role/path special cases?

**Answer: not yet, for the produce/review path.** `WorkflowEngine` and the
checkpoint/execute/commit fallbacks are already clean. The block is
entirely inside the shared produce/review path: `AgentStepRunner` →
`ContextManager` → `AgentRunner`. Every claim below is backed by a passing
test in `tests/d1a-declarative-contract-spike.test.ts`, run against the
real (unmodified) `ContextManager` and `agent-runner.ts` code.

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
  (`full-build-step-runner.ts:57-73, 97`) are legitimately full-build-scoped
  and hit the `StepRunner` interface's *optional* kind-override hooks
  (`handleCheckpoint`/`handleExecute`/`handleCommit`). For any step ID they
  don't recognize, `handleCommit`'s fallback is genuinely generic
  (`markRunning` → `markComplete` → done, `full-build-step-runner.ts:94-124`)
  and `run()`'s fallback for produce/review is `agentStepRunner.run(step,
  ctx)` (`full-build-step-runner.ts:64`). **A new workflow does not need to
  add branches here** as long as its step IDs don't collide with full-build's
  reserved ones (`critique`, `validation_gate`, `scoping.produce`,
  `summarise`, `debug`, `confirm`, `sharding_approval`,
  `scoping.checkpoint`, `snapshot`) — picking namespaced IDs
  (`define-work.synthesize-definition`) avoids this trivially.
- One real wrinkle worth naming even though it isn't blocking: `WorkflowEngine`
  is constructed with exactly one shared `StepRunner` for the whole running
  application (`application.ts:188-210`), not one per workflow. Today that
  works only because `FullBuildStepRunner`'s fallback for unrecognized step
  IDs happens to be generic. This is incidental, not designed — worth a
  one-line note in the eventual contract, not a redesign.

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

## 5. Smallest proposed contract change (for D.1b to implement)

Deliberately minimal — no context-query language, no per-step permission
DSL:

1. Add `WorkflowStep.instruction?: string` (inline) alongside the existing
   `templateId?: string` (file reference) as the step's own task
   description, consulted by `ContextManager` **before** the
   `NODE_TASK_DESCRIPTIONS` legacy map (which stays, for `full-build`
   compatibility, as the final fallback rather than the first hit).
2. Add `WorkflowStep.outputArtifact?: { type: string; ref: string; path:
   string }`. Thread it from `AgentStepRunner` into `StepRunContext` (a new
   optional field, e.g. `ctx.declaredOutput`) so `AgentRunner` can validate
   the LLM's actual write path against `step.outputArtifact.path` when
   present, falling back to today's `ROLE_OUTPUT_PATHS` table only when a
   step declares nothing (preserves `full-build` behavior exactly, per DDR-
   031/032 non-negotiables).
3. Add a minimal `WorkflowStep.inputContext?: ContextRef[]` (a short list —
   `'objective' | 'repository' | 'prior_artifacts' | { artifactRef: string
   }`, per the original plan's §6.5) consulted by `ContextManager` before
   falling into `getRoleSlices()`'s role switch. `getRoleSlices()` remains
   exactly as-is for steps that declare nothing.
4. After a successful produce step with a declared `outputArtifact`, call
   `ArtifactRepository` (already implemented, currently unused) to record
   provenance (WorkItem/WorkflowRun/StepExecution/type/ref/path/hash),
   instead of only appending to `.sle/map.yaml`.
5. Do **not** touch `AgentRole` or `getRoleSlices()`'s switch in D.1b. New
   workflows introduced during D.3 (`define-work`) should reuse an existing
   role (`explorer` fits synthesis/investigation) and rely on the new
   per-step `instruction`/`inputContext`/`outputArtifact` fields to make
   that role's actual behavior step-specific. Whether a role ever needs to
   stop being a closed union is a question for a later milestone with two
   real non-full-build workflows to compare, not this one.

This preserves `full-build`/`draft-artifact` behavior exactly (nothing
declares the new fields yet, so every legacy fallback path is unchanged —
confirmed by the full test suite passing unmodified in this spike) while
giving a new workflow step everywhere it currently has no channel at all.

## 6. Explicitly not attempted in this spike

- No production code was modified.
- No new `StepKind`, domain entity, or `AgentRole` value was added.
- The single-shared-`StepRunner` wrinkle (§2) is noted, not redesigned —
  D.1b does not need to solve it to satisfy D.1a's question.
