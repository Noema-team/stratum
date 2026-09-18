# DDR-040: Decision Creation-Time Identity Propagation on Every Path

**Status:** accepted (2026-09-17)
**Extends:** DDR-036 (escalation ownership), DDR-039 (oracle identity join; audited-not-fixed lifecycle gap)
**Trigger:** E4-G inv 4 (EARLY) — a chained decision created during a resume applied as `DECISION_APPLICATION_DECISION_UNLINKED` and the run halted without commit; the repair instruction told the model to re-run the checkpoint, but no machinery existed to accept that correction.

## Decision

One sentence:

> **Every dynamic Decision creation path must copy the validated
> DecisionRequest's escalation identity (`targetFactId`) into the durable
> Decision's `subjectRef` at creation time. Decision subject identity
> remains immutable thereafter.**

## Root cause — asymmetric creation-time propagation

DDR-036 bound `subjectRef.targetFactId` at creation on **Scheduler's initial
dispatch** (scheduler.ts) — and nowhere else. **ResumeService's next-checkpoint
creation** — the path that fires whenever a resumed run chains a *second*
decision — threaded workflowRunId/workItemId/stepId but silently dropped
`DecisionRequest.targetFactId`. Any chained decision created during a resume
was therefore structurally unbound from birth, and its application
deterministically failed `DECISION_APPLICATION_DECISION_UNLINKED`.

The failure was model-independent. The prepare contract *requires*
`targetFactId` (`DECISION_REQUEST_PROPOSAL_SCHEMA`, DDR-036), so a
contract-compliant request cannot reach the checkpoint without it — E4-G
inv 4's persisted request artifact carried the fact id. The binding was lost
between the validated artifact and the durable record, on one of the two
creation paths.

**Fix:** ResumeService's `needsDecision` call now mirrors the scheduler's
creation-time spread:

```ts
...(nextDecisionReq.targetFactId !== undefined
  ? { targetFactId: nextDecisionReq.targetFactId }
  : {})
```

Post-fix, a current-run unlinked durable Decision is unreachable by
construction: both creation paths bind, and the request contract mandates
the fact id.

## E4-G attribution — corrected

```text
E4-G raw:       13/15
adjudicated:    14/15

inv 4:  MODEL   correct — proposals compliant throughout; there was no
                 omit-then-repair model weakness at all
        ORACLE   had the lexical selector defect (closed by DDR-039)
        SYSTEM   ResumeService dropped the durable target binding

inv 5:  MODEL   genuine terminal submit_result lapse (Flash)
```

History is not rewritten; the raw and adjudicated scores stand, with inv 4
credited as a system-side lifecycle defect.

## Recovery machinery — implemented, then removed on review

An earlier draft of this DDR also introduced a generic recovery subsystem:
`WorkflowStep.on_error_routes` (per-step, per-code contract-error routing),
structural defect-code propagation through
`ResultAcceptor → AgentLoop → AgentRunner → StepRunner → WorkflowEngine`,
and a durable per-run recovery budget (`workflow_runs.error_recoveries_json`,
migration 11). The root-cause audit falsified its premise — the design
assumed a model could omit `targetFactId` and need a bounded authority
re-cycle, but the contract makes that unproposable and the actual creator of
unlinked decisions was the asymmetric creation path this DDR closes. Keeping
the subsystem would have been speculative architecture (11 production files)
recovering from a state that is no longer constructible — removed in review
rather than rationalized as already-written.

Genuinely legacy/unlinked Decisions (pre-DDR-036 rows) keep the deterministic
fail-closed refusal at application. If a real run ever surfaces one, that
evidence decides whether recovery machinery is justified — observed
deficiency → narrow correction → rerun.

## Regression

`tests/d34-ddr040-unlinked-decision-recovery.test.ts` walks the actual E4-G
inv 4 authority chain live: a topology decision created at initial dispatch
(bound), applied; a chained scope decision created **during the resume**,
bound from birth post-fix, applied with its own `decisionRef`; each decision
independently human-resolved (no transfer); every other fact carried over
verbatim; the remaining exploration need recorded; a clean commit; route
sequence refine→defer→human→human→explore.
