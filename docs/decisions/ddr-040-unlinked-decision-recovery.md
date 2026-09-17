# DDR-040: Unlinked Durable Decision Recovery — Binding at Every Creation Path, One Bounded Authority Re-Cycle

**Status:** accepted (2026-09-17)
**Extends:** DDR-036 (escalation ownership), DDR-039 (oracle identity join; audited-not-fixed lifecycle gap)
**Trigger:** E4-G inv 4 (EARLY) — a chained decision created during a resume applied as `DECISION_APPLICATION_DECISION_UNLINKED` and the run halted without commit; the repair instruction told the model to re-run the checkpoint, but no machinery existed to accept that correction.

## Decision

One sentence:

> **A durable Decision's subject identity is immutable after creation. Every
> path that creates a Decision binds its escalation target at birth — and if a
> current-run human-decision application discovers that the resolved Decision
> was created without its required escalation target, Stratum may perform one
> bounded recovery by re-running the decision-preparation/checkpoint authority
> cycle and creating a fresh bound Decision. It never retroactively binds or
> transfers authority onto the old Decision.**

## Root cause — the binding existed on only one of two creation paths

DDR-036 bound `subjectRef.targetFactId` into the durable Decision at creation
on **Scheduler's initial dispatch** (scheduler.ts). **ResumeService's
next-checkpoint creation** — the path that fires whenever a resumed run chains
a *second* decision — threaded workflowRunId/workItemId/stepId but silently
dropped `DecisionRequest.targetFactId`. Any chained decision created during a
resume was therefore structurally unbound, and its application
deterministically failed `DECISION_APPLICATION_DECISION_UNLINKED` regardless
of the model's proposal: E4-G inv 4's persisted request artifact carried the
fact id, and the prepare contract *requires* `targetFactId` (a compliant model
cannot propose an unlinked request at all). The E4-G attribution is refined,
not rewritten: inv 4 remains a system-side lifecycle defect (raw 13/15,
adjudicated 14/15 unchanged); the model's proposals were compliant
throughout — the resume path dropped the binding between the artifact and the
durable record. inv 5 remains a genuine Flash terminal-submission lapse.

**Fix:** the resume path now mirrors the scheduler's spread, binding
`nextDecisionReq.targetFactId` into the next Decision's `subjectRef` at
creation. The integration regression walks the exact inv 4 chain — topology
decision (scheduler-created, bound) applied, then a chained scope decision
created **during the resume**, bound from birth, applied, exploration
recorded, clean commit.

## The recovery route — `WorkflowStep.on_error_routes`

With both creation paths binding, a *current-run* unlinked durable Decision
is unreachable by construction. The demonstrated lifecycle gap still leaves
two real surfaces: legacy pre-DDR-036 rows resumed against a new binary, and
defense-in-depth against any future creation path that fails to bind. For
those, the recovery machinery the UNLINKED error always promised:

- `StepRunOutcome.contract_error_code` — the terminal output-contract defect
  code rides **structurally** from the acceptor
  (`ResultAcceptor` failure branch) through AgentLoop (`error_code`),
  AgentRunner, and AgentStepRunner; the engine never string-matches error
  text.
- `WorkflowStep.on_error_routes` — an opt-in, per-step, per-code route table.
  A produce step failing with a declared code, under the run's durable
  recovery budget, routes to the declared target instead of halting. The
  route re-enters the authority cycle (`apply-human-decision` →
  `prepare-human-decision`); the old Decision stays untouched historical
  evidence, its resolution is never transferred, and the human answers the
  fresh bound Decision again. No equivalence/supersession machinery exists.
- **Recovery bound:** `workflow_runs.error_recoveries_json` (migration 11)
  counts recoveries per code per run, loaded at engine start and persisted on
  the routing write (COALESCE — ordinary cursor updates never erase it), so
  the budget survives checkpoint resumes. A replacement cycle that again
  produces an unlinked Decision halts deterministically
  (`Error-recovery bound for '<code>' reached (…)`) instead of cycling
  prepare→checkpoint→apply forever. Default limit: 1.

Declared in define-work on exactly one step, for exactly one code:

```text
apply-human-decision
  on_error_routes:
    DECISION_APPLICATION_DECISION_UNLINKED → prepare-human-decision
```

Every other application defect — `DECISION_APPLICATION_TARGET_MISMATCH`
(the valid-A→valid-B substitution guard), `…_TARGET_MISSING`,
`…_ALREADY_APPLIED`, malformed/unverifiable requests, wrong work item,
`LEGACY_UNLINKED` — keeps the fail-closed halt. There is no generic retry
architecture: no table, no route; a step without `on_error_routes` is
byte-for-byte unchanged.

## Scope guards honored

Readiness methodology, gap classifications, factId semantics, decision
identity semantics, model prompts, provider behavior, result-repair budgets,
the qualification oracle, and DDR-039 harness logic are untouched. No
model-specific or Flash-specific logic anywhere. Production changes:
resume-service binding spread; the structural defect-code thread (types
only, inert until read); the engine's opt-in routing seam + migration 11;
the define-work route declaration.

## Regressions

`tests/d34-ddr040-unlinked-decision-recovery.test.ts` (6 tests):

- engine seam — UNLINKED routes once (budget persisted); a second UNLINKED
  in the same run halts at the frozen bound; an undeclared code (TARGET_
  MISMATCH) never routes on a step declaring a UNLINKED route; no table →
  fail-closed halt unchanged; the budget bounds a second engine instance on
  the same run (resume posture).
- integration — the full E4-G inv 4 authority chain walked live: dual
  decisions on two facts, the second created during the resume and bound
  from birth, both applied with their own decisionRef, every other fact
  verbatim, exploration recorded, clean commit, route sequence
  refine→defer→human→human→explore.
