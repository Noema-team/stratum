# D.3b0 — generic contracts required by define-work

**Status:** Complete. No production workflow (`define-work` included) is
registered in this phase — that is D.3b1, which begins only after this
phase's review. This phase is scoped strictly to three generic engine/
execution seams the D.3a contract's implementation exposed, each proven
against synthetic, unfamiliar workflow/step ids, never against a
`define-work` id.
**Milestone:** D, phase D.3b → D.3b0 → D.3b1 (see
`docs/developmentPlan/d3a-definition-readiness-methodology.md`, as
amended by its own §8 D.3a.1 correction)

## 1. Why a seam phase before the workflow itself

Building `define-work` directly against D.3a's contract would have hit
three real gaps in generic infrastructure, each of which is either a
genuine kernel-adjacent bug (§2A) or missing plumbing that D.1b/D.1c's
declarative contract didn't anticipate (§2B, §2C). Fixing these inside
`define-work`'s own step definitions would have meant workflow-id or
step-id special-casing in `WorkflowEngine`/`FullBuildStepRunner`/
`AgentStepRunner`/`AgentRunner` — exactly what D.1's declarative contract
exists to prevent. None of the three fixes below reference `define-work`,
`readiness-review`, or any other D.3-specific identifier anywhere in `src/`.

## 2. What was built

### 2A. Opt-in semantic review verdict contract

`AgentRunner.success`/`StepRunOutcome.success` means the LLM call, output
parsing, and write succeeded — it says nothing about whether a review's
semantic judgment passed. `WorkflowEngine.executeReview` previously used
that one boolean for both, which would have routed a correctly-produced
`NOT_READY` review artifact through `on_pass` as if it were a pass.

- `WorkflowStep.requiresReviewVerdict?: boolean` (`workflow/types.ts`) —
  opt-in; every full-build/draft-artifact review step leaves it unset.
- The SLE-OUTPUT preamble may carry `verdict: pass | fail`
  (`SLEOutputPreamble.verdict?: string` in `agent-runner.ts`, loose until
  validated).
- `AgentRunner.run()` parses the preamble's verdict only from the
  single-turn path (the multi-turn `AgentLoop` path uses an entirely
  different delimiter format with no preamble concept at all — untouched,
  out of scope). When `ctx.requiresReviewVerdict` is set, a missing or
  invalid verdict on an otherwise-successful execution fails the whole
  execution closed (`AgentRunResult.success = false`) **before** the
  write step — it is never treated as a semantic result. A valid `pass`
  or `fail` proceeds through the unchanged write + provenance path and is
  exposed as `AgentRunResult.reviewVerdict`.
- `StepRunOutcome.reviewVerdict` carries this through `AgentStepRunner`.
- `WorkflowEngine.executeReview`: for an opted-in step, execution failure
  **or** a missing/invalid verdict both halt (`outcome: 'failed'`,
  cannot reach `on_fail`/`on_pass`); a valid `verdict: 'fail'` routes
  through `on_fail` exactly like a legacy failure does today, and
  `verdict: 'pass'` routes through `on_pass`. Every non-opted-in review
  step (full-build's `critique`/`validation_gate` included) falls through
  to the byte-for-byte original branch.

### 2B. WorkItem context threading (no ContextManager→DB query)

`ExecutionRequest` already carried `acceptanceCriteria`/`constraints`
(from D.2); `objectiveId` did not exist there. Added:

- `ExecutionRequest.objectiveId?: string` (`execution/types.ts`), set by
  `Scheduler`/`ResumeService` from `WorkItem.objectiveId` (one line each,
  alongside the existing `acceptanceCriteria`/`constraints` fields).
- `WorkflowEngine.run()` gains three trailing optional parameters
  (`objectiveId`, `workItemConstraints`, `workItemAcceptanceCriteria`),
  threaded in by `StratumAgentAdapter.execute()` from the
  `ExecutionRequest` it already receives. No new dependency was added to
  `WorkflowEngine`, `ContextManager`, or `AgentRunner` — the data is
  passed in, never queried.
- `StepRunContext` gains the same three fields, always populated by
  `WorkflowEngine.makeStepRunContext` (every step's context carries the
  data), plus `includeWorkItemContext?: boolean` copied from
  `WorkflowStep.includeWorkItemContext`.
- `ContextManager.buildTaskDescription` renders constraints/acceptance
  criteria into the assembled task text **only** when
  `ctx.includeWorkItemContext` is true — the data being present on `ctx`
  is not the same thing as it being shown to the model. `ctx.goal` is
  unaffected either way. `objectiveId` is never rendered by this
  mechanism; it is execution/provenance context only.

### 2C. Declarative artifact-ref placeholder materialization

D.3a's Definition identity, `definition:<objectiveId>`, and its physical
path under `.sle/work/<workItemId>/...`, are per-run values — a
`WorkflowStep`'s declared `outputArtifact`/`inputArtifactRefs` cannot
hardcode them without colliding across every WorkItem/Objective that
reuses the same workflow.

- `src/workflow/artifact-refs.ts` (new): `materializeTemplate(template,
  values)` substitutes `{name}` placeholders, deliberately not a general
  expression language — exactly the placeholder names present as keys in
  `values` are legal. `materializeStepRunContext(ctx)` applies this to
  `outputArtifact.ref`, `outputArtifact.path`, and every
  `inputArtifactRefs` entry, using `{ workItemId: ctx.workItemId,
  objectiveId: ctx.objectiveId }`. An unknown placeholder name, or a
  known one with no value for this run, fails closed
  (`{ok: false, error}`); a context with neither field declared is
  returned completely unchanged (true no-op, not a clone).
- Wired into `WorkflowEngine.run()`'s main loop, immediately after
  `makeStepRunContext` and **before** `executeStep` is called for any
  step kind — i.e. before `ContextManager`/`AgentRunner` (LLM call,
  filesystem write) ever sees the context. A materialization failure
  halts the run with the specific error, and `stepRunner.run()` is never
  invoked for that step.
- No `Artifact`→`Objective` foreign key was added anywhere — this is
  string substitution on declared ref/path values, nothing touches
  `ArtifactRepository`'s schema.

## 3. What D.3b0 deliberately did not touch

- No `define-work` (or any other) workflow registered — D.3b1's job.
- No new `StepKind`, `AgentRole`, domain entity, `WorkProposal`, or
  `Decision` routing.
- No `ObjectiveService`/SQLite dependency introduced into
  `WorkflowEngine`, `ContextManager`, or `AgentRunner` — §2B's data
  arrives already-resolved from `Scheduler`/`ResumeService`.
- `full-build`/`draft-artifact` step definitions, `FullBuildStepRunner`'s
  step-id branches, and every legacy (non-opted-in) review step's
  behavior are byte-for-byte unchanged — proven structurally (no
  full-build step sets `requiresReviewVerdict`) and behaviorally (§4).
- The multi-turn `AgentLoop` execution path (a materially different
  output format with no preamble/verdict concept) was left untouched;
  the semantic verdict contract only applies to the single-turn path,
  which is what every test in this phase — and D.3b1's planned
  `define-work` steps — actually exercises.

## 4. Correction to the D.3a methodology document

While implementing §2C's iteration-cap-adjacent mechanism, a factual
error in `docs/developmentPlan/d3a-definition-readiness-methodology.md`
§4 was found and fixed in place (not a new D.3a.x sub-phase — D.3a stays
closed; this is a documentation accuracy fix made while building against
it, as instructed): `WorkflowEngine` starts a run at iteration 1 and
checks whether the *next* iteration would exceed `max_iterations` before
advancing, driven by a review step's `on_fail.iteration_loop: true` (the
engine's `_iterate` flag) — `is_iteration_gate` plays no part in the cap
check at all (the field exists but is unread by that logic). An initial
Definition draft plus at most 3 refinement passes is therefore iterations
1, 2, 3, 4 — `max_iterations: 4`, not 3. The doc previously said
`max_iterations: 3` while also (correctly, but inconsistently) saying "4
Definition versions (v1 through v4)" in the same sentence.

## 5. Test coverage

`tests/d3b0-generic-seams.test.ts` (32 tests), all against synthetic
workflow/step ids (e.g. `d3b0-review-pass`, never `define-work`):

- **Semantic verdict (AgentRunner level):** valid `pass`/`fail` both
  succeed and are exposed correctly; a semantic-fail artifact is written
  and its provenance recorded; missing/invalid verdict fails closed;
  transport failure and output-parsing failure are both execution
  failures with `reviewVerdict` left `undefined`; a non-opted-in step
  ignores verdict entirely.
- **Semantic verdict (WorkflowEngine.executeReview routing):** `pass`
  routes `on_pass`; `fail` routes `on_fail`; execution failure halts at
  the review step itself (never reaches `on_fail`'s target); missing and
  invalid verdicts both halt the same way; legacy (non-opted-in) routing
  is unchanged for both success and failure; `FULL_BUILD.steps` are
  asserted to never set `requiresReviewVerdict`.
- **WorkItem context threading:** `includeWorkItemContext` renders
  constraints/acceptance criteria into the assembled task; without it,
  the same data present on `ctx` is not rendered; `ctx.goal` is
  unaffected either way; `WorkflowEngine` threads the raw data onto every
  step's context regardless of that step's own opt-in flag.
- **Placeholder materialization:** no-placeholder templates are
  unchanged; `{workItemId}`/`{objectiveId}` substitute correctly; unknown
  placeholders and missing required values both fail closed, at both the
  unit level and the full `WorkflowEngine.run()` level (with an assertion
  that `stepRunner.run()` — the LLM/filesystem boundary — is never
  called); two different WorkItems produce non-colliding materialized
  paths, again at both levels.
- **Cross-cutting threading:** `Scheduler` puts `WorkItem.objectiveId`
  (or `undefined`, when absent) onto the `ExecutionRequest`;
  `StratumAgentAdapter` forwards `objectiveId`/`constraints`/
  `acceptanceCriteria` onto `StepRunContext` unchanged.

Full `npm run verify` (type-check, build, 1199 tests) is green.
