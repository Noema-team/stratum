# DDR-038: Qualification Instrument Validity — Semantic Option Adjudication and Run Isolation

**Status:** accepted (2026-09-17)
**Extends:** DDR-037 (instrument closure)
**Trigger:** E4-E deep-dive — three EARLY runs failed a lexical oracle on semantically-correct, human-resolved, committed decisions; an isolation concern was raised and investigated to null.

## Decision

One sentence:

> **The qualification oracle evaluates the intended outcome of a decision
> option — not its vocabulary — and every qualification run is informationally
> isolated by construction, pinned by regression.**

## Slice A — semantic option adjudication

The EARLY oracle previously recognized the legitimate conservative option via
`SAME_PLATFORM_KEYWORDS` string matching. E4-E exposed the confounder: GLM-5.3
offered genuine exclude options in 5/5 EARLY runs, the scripted human resolved
them, the runs committed — and 3/5 failed only because the option text
paraphrased ("deliberate non-goal… only the current single target platform")
rather than echoed the canonical words. Sonnet matched the keywords 5/5 and
GLM-5.3 had matched 3/3 in E4-D: pure lexical variance around correct
semantics.

Replaced with `findCrossPlatformExclusionOption`: a minimal deterministic
polarity evaluation — platform-scope axis present, explicit exclusion evidence
for this increment present, no unnegated inclusion evidence. No LLM judge, no
generic semantic subsystem; every predicate is pinned against the byte-for-byte
historical payloads of E4-D/E4-E (including the flip replay proving the three
failures invert solely under the corrected check, and that include variants,
unrelated options, and question-deferral options stay rejected). The same
finder drives the scripted human's resolution, so the policy selects the
genuine exclude option deterministically instead of `options[0]` fallback.

E4-E history is NOT rewritten: raw 8/15 stands (per Amendment 1 — the
originally reported 7/15 was transposed arithmetic); the adjudicated result
(11/15 with the three oracle false negatives credited) is recorded separately
in the E4-E review amendment.

## Slice B — run isolation

The deep-dive's "runs within an invocation observe each other's artifacts"
observation was an analysis artifact (per-invocation glob aggregation mixing
scenarios). Precise re-measurement over all E4-E persisted loop evidence:
**zero foreign reads**. The harness already isolates by construction — each
scenario invocation gets a fresh `mkdtemp` project root, an in-memory
database, and per-run workspace/objective identities. This DDR pins that
construction: a behavioral regression (two consecutive scripted runs receive
disjoint roots; equivalent clean start; no path escape) plus source pins on
the driver's per-scenario root creation and the harness's `:memory:` state.

## Residual accounting (Slice C)

Complete 15-run table in `E4E-review.md` Amendment 1: 7 failures = 3
ORACLE_FALSE_NEGATIVE + 2 SEMANTIC_OVER_ESCALATION + 1 SEMANTIC_UNDER_
ESCALATION + 1 EPISTEMIC_STATUS/PROVENANCE. There was no eighth failure — the
"7 PASS / 8 FAIL" headline was a transposition; ground truth is 8/15.

## Scope guards honored

No WorkflowEngine change; no DDR-034/036/037 production semantics touched;
the option adjudication and isolation changes live entirely in the
qualification harness (`tests/fixtures/d3d/`, `scripts/eval-define-work.ts`);
production source is unchanged.

## Consequence

The instrument is adjudicated valid and isolated; the next series is **E4-F**
(same frozen configuration as E4-E). Per the operator's pre-registration:
regardless of score, unless E4-F exposes another genuine system defect, E4-F
closes this qualification loop — the step after it is Pilot A.
