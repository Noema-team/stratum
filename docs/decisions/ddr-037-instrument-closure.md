# DDR-037: Qualification Instrument Closure — factId Selection Domain and MATURE Fixture Consistency

**Status:** accepted (2026-09-16)
**Extends:** DDR-036 (escalation ownership)
**Trigger:** E4 residual failure audit — deterministic counterfactuals on E4-D evidence (`E4D-residual-audit.md` in the E4-D evidence clone)

## Decision

One sentence:

> **A finite selection Stratum can enumerate at runtime is exposed to the
> model as a finite selection — in the initial teaching, in the schema
> annotation, and in the repair instruction — and a qualification scenario
> must not punish the behavior its sibling scenario demands.**

Two residual confounders were measured in the E4-C/E4-D instrument, closed
here without touching the WorkflowEngine, routes, repair budgets, the
validator's strictness, or the 15/15 qualification rule.

## Evidence (E4-D, revision d2c4856 — post-DDR-036)

GLM-5.3 (full) scored 11/15. The audit attributed nearly the whole deficit
to instrument, not model:

1. **Both readiness-contract rejections were pure identity-encoding
   failures, proven by counterfactual.** The model paraphrased fact ids its
   own drafting step had written minutes earlier
   (`cross-platform-increment-membership` vs its own `f-xplat-undecided`).
   Substituting ONLY the factId values — every other byte unchanged — flips
   both historically rejected proposals to fully accepted under the frozen
   DDR-036 validator. Classification, targets, and routes were correct.
2. **The repair interface observably degraded a near-miss into an
   omission** (E4-D inv5): rejected near-miss ids → ids removed → rejected
   as missing → exhausted. The defect message named the invalid id while
   withholding the legal set the validator had already extracted.
3. **The MATURE extra-refine class is cross-model convergent on one fact
   and methodology-correct.** All three Sonnet E4-C MATURE failures and
   GLM's one MATURE failure verified the SAME ASSUMED fact
   (event-repository wiring — documented all along in the fixture's
   `src/domain/objective-events.ts` comment). Review caught it; refine
   verified it; iteration 2 passed clean. The MATURE oracle punishes
   exactly the verification the EARLY oracle demands ("KNOWN with
   repository provenance") — internally inconsistent.

Historical scores stand unchanged (E4-C Sonnet 10/15; E4-D GLM 11/15) but
are annotated as measured through an instrument containing these two
confounders; they are not clean estimates of the models' ceiling.

## The slice

- **A — repair-interface closure:** `GAP_FACT_ID_UNRESOLVED` and
  `GAP_FACT_ID_MISSING` defect messages now enumerate the exact valid fact
  IDs derived from the trusted current Definition, plus the CAN_RESOLVE
  fallback rule (no ledger fact for the concern → classify CAN_RESOLVE,
  omit factId, refinement adds the fact). Exposing the domain of a
  constrained field is not coaching the semantic answer.
- **B — schema annotation:** `/gaps/items/factId` now teaches exact-copy
  semantics (copy an existing ledger ID exactly; never invent or
  paraphrase; CAN_RESOLVE when no fact represents the concern).
- **C — initial candidate list:** `OutputContract` gains an optional
  `contextTeaching(ctx)` hook — a PURE derivation of ephemeral teaching
  text from the trusted `OutputContractContext` (no clock, no fs, no env,
  no persistence). The readiness contract projects `VALID FACT IDs` from
  the declared `definition.md` input before the first submission. It is a
  projection of the canonical ledger, never a second authority; the
  consumer is the generic `renderResultTeaching` combinator, so AgentRunner
  still carries no methodology logic. `factId` remains a plain optional
  string — no dynamic enums, no alternative identity representations.
- **D — MATURE fixture closure:** the MATURE objective now supplies the
  repository-verified event-source knowledge the fixture always documented,
  so a competent v1 draft records the wiring KNOWN with repository
  provenance. The oracle's `iterations = 1` requirement is UNCHANGED — a
  corrected scenario, not a loosened criterion; a reviewer that invents an
  unnecessary gap still fails it.

## Recorded, deliberately NOT redesigned

The inv1 early "misroute" was exonerated: the gate review escalated
correctly with valid ids (HUMAN_DECISION + EXPLORE_AS_WORK); the
human-decision cycle consumed the route; the terminal post-human review's
re-escalation foundered on the same factId interface. Sequential
escalation is recorded as observed behavior: if post-A+B+C the post-human
review emits the remaining EXPLORE_AS_WORK gap correctly, sequencing is
merely serialized; if it still strands the second gap, THAT is evidence
for a separate workflow defect (out of scope here).

## Regressions

`tests/d34-ddr037-instrument-closure.test.ts` (14 tests) pins: both
enriched repair messages (legal set + fallback rule; no invented set
without a trusted ledger); the candidate-list teaching (exact ids,
deterministic, ledger-only derivation, never invented, no second
authority, byte-stable static path); the historical E4-D counterfactuals
on byte-for-byte fixture copies of the rejected proposals and their
Definitions (correcting only factId → accepted; uncorrected → historical
rejections reproduce); the MATURE objective's repository knowledge; and
the unchanged `iterations = 1` oracle criterion.

## Qualification protocol consequence

The instrument changed, so the next series is **E4-E** — not numerically
comparable to E4-D, by design. Same model (GLM-5.3), same wire, same 16K
budget, same temperature, same methodology, same 15/15 rule.
