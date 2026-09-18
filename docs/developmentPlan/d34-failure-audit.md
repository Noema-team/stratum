# D.34-0 — Cross-run failure audit (empirical trigger for DDR-034)

**Date:** 2026-09-11 · **Status:** complete
**Method constraint:** evidence-only. Every finding below is read from persisted eval
reports and artifacts; nothing is reconstructed from memory or conversation. No
methodology or implementation was changed while performing this audit.
**Sources:** `eval-reports/define-work-*/report.json` + `summary.md` + persisted
scenario artifacts (gitignored, present locally; 40 run directories, 2026-09-07 → 2026-09-10);
git history for the methodology/system version boundaries; `scripts/eval-define-work.ts`
for report semantics.

## 1. Why this audit exists

D.3 screening produced a coarse impression — "models keep failing around representation
rather than semantics" — that was sufficient to pause screening and write DDR-034, but
insufficient to size the problem. This audit classifies **every recorded screening
failure** into a fixed taxonomy, separates pre/post-D.3d.4/D.3d.5 windows (the system and
methodology changed under the models during the screening period), and asks, for each
class: *why is the model responsible for this?*

## 2. Version windows (git-anchored)

| Window | Boundary commits | System behavior in that window |
|---|---|---|
| **W1** — pre-D.3d.4, pre-D.3d.5 | before `ec7aac3` (D.3d.4, 09-08 19:35) | No WHAT/HOW authority rule; no bounded repair on absent result block (immediate fail); `MAX_AGENT_TURNS` = 10; reviewer did not receive `DEFINITION_CONTRACT` on early runs (added D.3d.3 `72f981b`); model-authored `route:` still live until D.3d.5 (3/3) |
| **W2** — post-D.3d.4, pre-D.3d.5 | `ec7aac3`…`bdcd670` (09-08 19:35–20:19) until `2f46884` (09-09 09:46) | Authority-rule wording in; transport/mechanics still W1 |
| **W3** — post-D.3d.5 (all three commits) | `2f46884` → `30b5a2f` (09-09 09:46 → 09-10 10:32) | Symmetric bounded format repair (budget 1); turn budget raised; canonical Definition validation gate with real Decision resolution; deterministic precedence routing (model `route:` authority deleted); enum membership at parse |

Run-date → window mapping is unambiguous: all Sep 7 runs = W1; Sep 8 runs ≤ 16:04 = W1,
Sep 8 runs ≥ 16:11 = W2; Sep 9 runs ≤ 08:37 = W2, Sep 9 runs ≥ 10:00 = W3 (none); all
Sep 10 runs = W3.

## 3. Screening inventory

65 scenario-runs across 40 harness invocations, 6 models:

| Model | Scenario-runs | PASS | FAIL | ERROR | Windows |
|---|---:|---:|---:|---:|---|
| anthropic/claude-sonnet-4 | 39 | 13 | 23 | 3 | W1 |
| z-ai/glm-5.3-flash | 15 | 8 | 7 | 0 | W1 ×2, W2 ×2, W3 ×11 |
| deepseek/deepseek-v4-pro-0813 | 6 | 1 | 5 | 0 | W2 |
| deepseek/deepseek-v4-flash-0731 | 3 | 0 | 3 | 0 | W1 |
| minimax/minimax-m2.5 | 1 | 0 | 1 | 0 | W2 |
| openai/gpt-oss-120b | 1 | 0 | 1 | 0 | W2 |
| **total** | **65** | **22** | **40** | **3** | |

Note the confound the windows introduce: overall pass rates are **not comparable across
models** screened in different windows. claude-sonnet-4's 13/39 was earned entirely in W1,
against a stricter transport (no repair, 10-turn budget) and pre-authority-rule
methodology. Within-window comparison is the only fair one.

## 4. Taxonomy and per-run findings

Classes (per DDR-034 §2.2): **SYS** actual system bug / run-configuration error ·
**TRANSPORT** transport/protocol (envelope absence or malformation, result-block
mechanics, budget-as-transport) · **SER** canonical serialization (artifact-level
mechanical state: front matter, `schemaVersion`, canonical shape) · **METH**
methodology ambiguity (model behavior later cured by methodology wording — proven, not
assumed) · **SEM** semantic capability (epistemic discipline, gap/decision judgment) ·
**CONV** convergence/process (excess refinement rounds).

### 4.1 W1 — claude-sonnet-4 (39 scenario-runs: 13 PASS / 23 FAIL / 3 ERROR)

| Run (define-work-…) | Scenario | Class(es) | Evidence (report.json / artifacts) |
|---|---|---|---|
| 2026-09-07T08-10-05 | early/partial/mature | **SYS** ×3 | `400: "test is not a valid model ID"` — settings resolved a nonexistent model; no model behavior exercised |
| 2026-09-07T08-11-42 | early | TRANSPORT | `stop_reason='end_turn' without SLE-OUTPUT after 8 turn(s)` — no repair existed; immediate fail |
| 2026-09-07T08-11-42 | partial | TRANSPORT | `did not produce SLE-OUTPUT within 10 turns` |
| 2026-09-07T08-11-42 | mature | TRANSPORT | `did not produce SLE-OUTPUT within 10 turns` |
| 2026-09-07T08-56-12 | early | METH + SEM | escalated at step 2 with no refine round first (`refineIdx=-1 escalationIdx=1`); scope Decision never raised (`decisions=0`); networking fact absent from ledger |
| 2026-09-07T08-56-12 | partial | TRANSPORT | `did not produce SLE-OUTPUT within 10 turns` |
| 2026-09-07T08-56-12 | mature | TRANSPORT | `did not produce SLE-OUTPUT within 10 turns` |
| 2026-09-07T09-04-05 | early | SEM | genuine platform-scope Decision never raised (`decisions=0`) |
| 2026-09-07T09-04-05 | partial | METH | unnecessary Decision (`decisions=1`), run halted at checkpoint — the over-escalation class D.3d.4/`7b45774` later cured |
| 2026-09-07T09-04-05 | mature | TRANSPORT | `did not produce SLE-OUTPUT within 10 turns` |
| 2026-09-07T09-11-47 | early | SEM | no exploration-need artifact for the empirical latency question (escalated `human` instead) |
| 2026-09-07T09-11-47 | partial | TRANSPORT | `prepare-human-decision: end_turn without SLE-OUTPUT after 2 turn(s)` |
| 2026-09-07T09-22-24 | early | TRANSPORT + SEM | `apply-human-decision: end_turn without SLE-OUTPUT after 2 turn(s)`; exploration-need missing |
| 2026-09-07T09-22-24 | mature | CONV | `iterationsUsed=3` (mature expects exactly 1) — `fail, fail, pass` review chain |
| 2026-09-07T09-45-16 | early | SEM | premature `verdict:pass` on a genuinely early request; networking fact not KNOWN with repository/investigation provenance; exploration-need missing |
| 2026-09-07T09-53-22 | mature | CONV | `iterationsUsed=2` |
| 2026-09-07T10-01-55 | early | SEM | scope Decision never raised (`decisions=0`) |
| 2026-09-07T10-05-41 | mature | TRANSPORT | `Output parsing failed: Unrecognised extension '1' in path: f1` — model emitted an invalid `## <path>` section header (envelope mechanics) |
| 2026-09-07T10-10-03 | partial | METH | unnecessary Decision, halted at checkpoint |
| 2026-09-07T10-13-54 | early | SEM | networking ledger entries present but none KNOWN with repository/investigation provenance |
| 2026-09-07T10-13-54 | partial | METH | unnecessary Decision, halted at checkpoint |
| 2026-09-07T10-19-12 | early | SEM | scope Decision never raised (`decisions=0`) |
| 2026-09-07T10-19-12 | partial | METH | unnecessary Decision, halted at checkpoint |
| 2026-09-07T10-19-12 | mature | CONV | `iterationsUsed=2` |

### 4.2 W1/W2 — deepseek-v4-flash, deepseek-v4-pro, minimax-m2.5, gpt-oss-120b

| Run | Model | Scenario | Window | Class(es) | Evidence |
|---|---|---|---|---|---|
| 2026-09-07T16-51-57 | deepseek-v4-flash | early | W1 | TRANSPORT | `exhausted max_tokens without producing SLE-OUTPUT` |
| 2026-09-07T16-51-57 | deepseek-v4-flash | partial | W1 | TRANSPORT + SEM | review: `Missing SLE-OUTPUT preamble comment`; oracle: supplied facts present in ledger but none KNOWN with human/repository provenance (weakening) |
| 2026-09-07T16-51-57 | deepseek-v4-flash | mature | W1 | TRANSPORT | review: `Missing SLE-OUTPUT preamble comment` |
| 2026-09-08T13-10-15 | deepseek-v4-pro | partial | W2 | METH | unnecessary Decision, halted at checkpoint |
| 2026-09-08T13-46-56 | deepseek-v4-pro | partial | W2 | SEM + METH | fact weakening — supplied facts have **no ledger entry at all**; unnecessary Decision |
| 2026-09-08T13-52-58 | deepseek-v4-pro | partial | W2 | SEM + METH | fact weakening (entries present, none KNOWN with provenance); unnecessary Decision |
| 2026-09-08T13-58-27 | deepseek-v4-pro | partial | W2 | SEM + METH | same signature as 13-52-58 |
| 2026-09-08T14-04-56 | deepseek-v4-pro | partial | W2 | SEM | fact weakening only (escalation discipline now clean) |
| 2026-09-08T16-11-49 | minimax-m2.5 | mature | W2 | SEM | review `verdict:fail` + exploration artifact created on a mature scope that should pass v1 — misjudged readiness classification |
| 2026-09-09T05-47-49 | gpt-oss-120b | mature | W2 | TRANSPORT | `end_turn without SLE-OUTPUT after 3 turn(s)` — 4 hours before D.3d.5 commit 1 added bounded repair |

### 4.3 W1→W3 — glm-5.3-flash (the model with runs in all three windows)

| Run | Scenario | Window | Class(es) | Evidence |
|---|---|---|---|---|
| 2026-09-08T16-44-38 | partial | W1 | SEM + METH | fact weakening (entries present, none KNOWN with provenance); unnecessary Decision |
| 2026-09-09T06-23-04 | partial | W2 | SEM | fact weakening persisted after the D.3d.4 authority rule (which targeted escalation, not epistemics) |
| 2026-09-10T08-57-05 | partial | W3 | **SER** | review produced a readiness artifact with **no `schemaVersion`** → `SCHEMA_VERSION_UNSUPPORTED: Readiness schemaVersion undefined` → route underivable → step failed. Mechanical state the system could have injected. |
| 2026-09-10T08-59-12 | partial | W3 | TRANSPORT | `prepare-human-decision: no recognizable result block, format repair exhausted (2 provider turn(s), 1 repair)` — repair existed and was used up |
| 2026-09-10T11-09-36 | partial | W3 | CONV | `fail→refine ×3 then pass` — three consecutive valid CAN_RESOLVE rounds, `iterationsUsed=4` (trace verified: `fail/refine, fail/refine, fail/refine, pass`) |
| 2026-09-10T12-03-49 | partial | W3 | **SER** ×2 | round 1: Definition rejected by the deterministic input gate (`SHAPE_INVALID: every acceptance entry must be a mapping` — canonical shape defect, reviewer never called); round 2: review's readiness artifact had **no front matter** → `FRONT_MATTER_MISSING` → route underivable → step failed |
| 2026-09-10T12-20-00 | partial | W3 | TRANSPORT | `synthesize-definition: malformed result block, repair exhausted (6 turns, 1 repair): Unrecognised extension 's' in path: Risks` — invalid section-path syntax in the envelope |

## 5. Class totals and the "why is the model responsible?" question

Occurrences counted per scenario-run; a run may carry more than one class.

| Class | Occurrences | Models implicated | Why is the model responsible? |
|---|---:|---|---|
| TRANSPORT | 16 | sonnet-4, deepseek-flash, glm-5.3-flash, gpt-oss-120b | **Mostly it isn't.** Absent/malformed result block and section-path syntax are Stratum's wire protocol. The strongest model in the sample (sonnet-4) failed on this class 10 times in W1; post-D.3d.5 repair converted absence into a recoverable event for some, but W3 still saw 2 exhaustions. The residual question for screening is only "can the model emit a valid tool call / structured payload" — a per-triple property (DDR-034 §13), not semantic quality. |
| SER (canonical serialization) | 3 (2 runs) | glm-5.3-flash only | **It isn't at all.** `schemaVersion`, front-matter delimiters, and acceptance-entry shape are mechanically derivable by Stratum. In both W3 runs the reviewer was producing gap judgments when representation failed; route derivation then failed on unparseable bytes. This is the class DDR-034 eliminates by construction. |
| METH (methodology ambiguity) | 9 | sonnet-4, deepseek-pro, glm-5.3-flash | **It wasn't, at the time.** Every over-escalation failure (unnecessary HUMAN_DECISION on partial) predates the D.3d.4/`7b45774` WHAT/HOW authority rule; no over-escalation is observed in W3. A failure that disappears when the *prompt wording* changes is a methodology defect, not a model defect — already the D.3d.4 finding, here confirmed across three models. |
| SEM (semantic capability) | 16 | all six | **Yes — legitimately.** Fact-ledger weakening of authoritative supplied facts (deepseek ×5, glm ×2, deepseek-flash ×1, sonnet ×1), missed genuine human decisions (sonnet early ×3), premature pass (sonnet ×1), missing exploration classification (sonnet ×2), mature-scope misjudgment (minimax ×1). These are exactly what semantic qualification should measure and reject on. |
| CONV (convergence) | 4 | sonnet-4, glm-5.3-flash | **Partly.** Mature objectives refined 1–2 extra rounds (sonnet ×3); GLM burned 3 CAN_RESOLVE rounds on partial (W3). The rubric lets review N+1 rediscover improvements from scratch — the asymmetry DDR-034 §12 records for separate treatment. |
| SYS | 3 | n/a | Run-configuration error (`"test" is not a valid model ID`), not model behavior. Excluded from all model assessment. |

## 6. Findings

**F1 — The representation-failure concentration is real and window-dependent.**
In W3 (post-D.3d.5), glm-5.3-flash's five failures are 2 SER + 2 TRANSPORT + 1 CONV and
**zero SEM** — while the same model in W1/W2 failed SEM three times. Once the methodology
ambiguity was fixed and repair existed, what remained was exactly the mechanical class
DDR-034 removes.

**F2 — Transport compliance is a poor proxy for semantic ability.**
claude-sonnet-4 — the only model to pass all three scenarios in one suite
(2026-09-07T09-53-22, 2026-09-07T10-05-41, 2026-09-07T10-10-03) — also accumulated 10
TRANSPORT failures in W1, including a run whose Definition drafting failed on an invalid
`## <path>` header after apparently sound content work. gpt-oss-120b's single recorded
failure is pure transport. A screen that rejects on this class rejects models Stratum
should be able to route around.

**F3 — Serialization failures hit the review path specifically, where control depends on
it.** Both W3 SER failures occurred on `definition-readiness-review`: mechanical state was
missing from the artifact, so *route derivation* failed and the step died — representation
failure propagating into control. Under DDR-034 the route derives from typed gaps and the
bytes are system-rendered, so both halves of that failure become unrepresentable.

**F4 — The D.3d.4/D.3d.5 sequence is itself the strongest evidence for the DDR-034
method.** Class by class: over-escalation disappeared when methodology wording was
corrected (METH → fixed in prompt); absent-block failures gained bounded repair when the
transport was corrected (TRANSPORT → mitigated in system); what has *not* been fixed yet
is exactly the canonical-serialization class (SER) — the model is still asked to author
bytes no one should be asking it to author. DDR-034 is the remaining move in a sequence
D.3 has already been executing.

**F5 — Convergence is real, small, and separate.** 4 occurrences, never semantic in
nature: valid CAN_RESOLVE rounds repeating because review N+1 re-reviews from scratch.
Matches the asymmetry recorded in DDR-034 §12 (`refine-definition` sees the prior
readiness; the next review does not). No overlap with the representation fix.

**F6 — Harness evidence gap (recorded, not acted on).** Failed runs do not persist the
artifacts that failed: fixture roots are deleted (`rmSync` in eval-define-work.ts:220),
and `trace.readinessText` is null for halted runs, so the 08-57-05 readiness artifact
(missing `schemaVersion`) survives only as a route-derivation error string. C7 (DDR-034
§14) should add persistence of raw node-outputs and failing artifacts for failed steps,
so future audits can distinguish "semantic content was sound" from "content was also
wrong" in SER/TRANSPORT failures.

## 7. Caveats

- **Sample sizes are small** — single-run cells for minimax and gpt-oss-120b; glm-5.3-flash
  is the only model with runs in all three windows. Findings are directional, not
  statistical.
- **Live-model output is non-reproducible** (by harness design); hashes and exact wording
  vary per run.
- **W1 claude-sonnet-4 results are not comparable** to later windows (no repair, 10-turn
  budget, pre-authority-rule methodology) — see §3.
- **Oracle checks conflate classes** in multi-failure runs; classification above follows
  the *primary* evidence per run, and multi-class runs are marked as such.
- The three ERROR runs (invalid model id) are run-configuration, not product bugs; no
  system-bug class instance was observed in the production code path itself.

## 8. Disposition

- SER + TRANSPORT + the METH class that wording already cured → **DDR-034** (this is the
  empirical trigger it cites).
- CONV → **DDR-034 §12 follow-up workstream** (adjudicative review), deliberately not
  designed here.
- SEM → stays the object of **semantic qualification** (DDR-034 §13 tier 1). deepseek-v4-pro's
  persistent fact-weakening across five W2 runs and minimax's mature-scope misjudgment are
  the canonical examples of what screening *should* reject.
- SYS → none outstanding (config error, resolved at the time).
