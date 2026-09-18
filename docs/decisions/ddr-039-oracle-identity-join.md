# DDR-039: Oracle Identity Join — Decision↔Fact by Durable targetFactId

**Status:** accepted (2026-09-17)
**Extends:** DDR-036 (escalation ownership), DDR-037 (instrument closure), DDR-038 (instrument validity)
**Trigger:** E4-G inv 4 (EARLY) — six oracle checks failed on a run whose genuine platform-scope Decision was bound to its fact by the DDR-036 durable identity while a different Decision that merely *cited* the fact won a lexical selection.

## Decision

One sentence:

> **The platform-scope Decision is identified by durable identity — the
> Decision whose `subjectRef.targetFactId` equals the canonical platform-scope
> fact's id — never by which Decision "sounds like" the scope question; the
> join fails closed on zero or multiple matches on either side.**

## Slice — structural selection, not a better regex

The EARLY oracle previously selected the platform-scope Decision with
`trace.decisions.find(isPlatformScopeDecision)`, a keyword predicate over
title+summary+option text. E4-G inv 4 raised two Decisions in order: a
session-topology question whose option text references "the host platform
constrains the cross-platform question (f2)", then the genuine scope question
("Does cross-platform support belong in the multiplayer increment, or is it
excluded?") offering `exclude-non-goal`, resolved to it by the scripted human.
The lexical `find()` took the topology Decision; six checks failed, including
the option-adjudication and downstream-cascade checks. Both pinned Decisions
satisfy the retired predicates — the adversarial property itself is pinned as
a regression canary.

The harness now mirrors the DDR-036 architecture end to end:

- `DecisionSummary` carries the durable Decision's `subjectRef.targetFactId`
  (surfaced by both harness builders and the eval report, so the join is
  re-derivable from `report.json` alone);
- the platform-scope **fact** is still identified semantically from the final
  Definition (canonical typed facts first, legacy markdown ledgers via the
  id-extracting fallback — `findFactsAboutWithIds`);
- the Decision is joined by exact `targetFactId === fact.id`;
- zero or multiple facts, or zero or multiple owning Decisions, fail closed
  with diagnostic detail (ids and ownership listed) — ambiguity is surfaced,
  never guessed.

Production code, model prompts, validators, route semantics, budgets, and
oracle expectations are unchanged. Fixtures pinned from the E4-G inv 4
persisted evidence: the committed Definition byte-for-byte, the two Decisions
as recorded, and the scope Decision's `targetFactId` (F2) recovered from its
provenance-verified `decision-request.json` artifact.

## Audited, not fixed (production): the durable re-bind gap

The same inv 4 evidence chain exposes a DDR-036 **lifecycle** gap beyond the
oracle:

1. The cycle-2 initial scope proposal omitted `targetFactId`, so the durable
   Decision was created unbound (`needsDecision` always creates fresh from
   the adapter's request — there is no re-bind after creation).
2. `apply-human-decision` correctly refused it
   (`DECISION_APPLICATION_DECISION_UNLINKED`), instructing that "the
   checkpoint must be re-run so the Decision is created with its escalation
   target bound".
3. The model complied: its result-repair wrote `targetFactId: F2` into the
   request artifact (the persisted artifact proves it) — but repair cannot
   re-create the durable Decision, so the instruction has no machinery behind
   it; repair exhausted, the run halted without commit.

So the remaining inv 4 failures (halted apply, no exploration artifact, no
clean commit) cascade from a deterministic system-side defect, not model
semantics — the model's escalation content was correct throughout. This is
recorded for operator adjudication (minimal production fix candidates: re-bind
on checkpoint re-halt, or route apply-contract UNLINKED back to prepare).
Production `src/` is untouched in this DDR, per mandate.

E4-G history is NOT rewritten: raw 13/15 stands; the adjudicated 14/15 stands
with corrected attribution — inv 4 is credited against oracle misselection
plus the audited lifecycle gap, not as a model semantic failure.

## Consequences

- Correct runs can no longer fail EARLY because a chained Decision paraphrases
  or cites the platform-scope fact.
- The one-in-15 flash profile risk for E4-H: repeating the omit-then-correct
  proposal pattern fails at the audited lifecycle gap (system defect — the
  pre-registered E4-H audit clause applies, not a model variance).
- Regression: `tests/d34-ddr039-oracle-identity-join.test.ts` (8 tests) pins
  the adversarial pair, the join's selections, all four fail-closed branches,
  id extraction on both ledger renderings, and the id-citation check's
  dependence on the Definition citing the joined Decision's real id.
