# Pilot A5 — Preregistration (E14)

**Frozen:** 2026-09-20, before any model-driven run.
**Status:** Preregistered; Pilot A5 has NOT started. This is an **unchanged rerun of Pilot A4** — zero system deltas — authorized to decide between run-to-run variance and a systematic turn-budget/non-convergence limitation.

## 1. What changes: NOTHING in the system

No model, route, teaching, retry, repair, turn-cap, target, driver, or workflow changes. Every frozen field is identical to A4 (docs/pilots/pilot-a4.md §3-§4):

| Item | Frozen value |
| --- | --- |
| Stratum execution revision | `c9573951937d4a9d95e2a1bc327cfcf9c528e5c6` (unchanged — the A4 execution revision; this document adds no code) |
| Target / branch | `86ec0871d64ecca8732434c11d015fd8e08ddc7e`, `pilot-a/issue-108`, never merged |
| Issue | `magtheo/student-platform#108` (re-verify OPEN at Gate A) |
| Model / route | `z-ai/glm-5.3-flash` via OpenRouter, `OPENROUTER_API_KEY`, max_tokens 16384 |
| Limits | `MAX_AGENT_TURNS` 24 · `MAX_RESULT_REPAIRS` 1 · one `UND_ERR_HEADERS_TIMEOUT` retry · `hard_ceiling` 4000 · minimal/5/halt · budgets 2/3/2 · 120-min end-to-end clock |
| Teaching | The PR #28 amended teaching (present in the frozen revision; A4 never exercised it — A5 may, if a submission occurs) |
| Pilot driver | sha256 `09bd01f68a9637ae47b2364c1ace6c4837102688cecd7ae94b9a04a635f42654` (verified 2026-09-20); any post-T0 change = integrity failure |
| WorkItems | Fresh: `wi-define-108-a5`, `wi-exec-108-a5`; fresh `.sle` (A4 state archived first); no prior Definition as input |

## 2. Evidence basis for the rerun (zero-model review, preserved)

`evidence/e14-a5-freeze-review.md`: A4's 38 tool calls were 38 UNIQUE paths, zero repeats — productive but non-converging investigation (core services covered, then scope-widening into unrelated subsystems; still surveying at the cap). Repetition is ruled out; the open question is pure variance vs systematic non-convergence. A3 submitted at turn 15; A4 never submitted by 24.

## 3. Hypotheses and gates

Unchanged: staged Gates A/B/C; H1 primary (fresh contract-valid Definition → `definitionSource` → `full-build`, DDR-041, no human translation); H2, H3 conditional on H1; honest-evaluation rule carried; transport cleanliness remains an observation, not an assumption.

## 4. Outcome → next decision (frozen by the operator, E14)

| A5 result | Next engineering decision |
| --- | --- |
| Valid Definition and H1 handoff | Continue into H2/H3; prioritize product output |
| Repeated exploration exhaustion | Inspect both turn ledgers (A4+A5), then consider a define-work-only turn-cap experiment |
| Repeated `source`/`kind` rejection | Reassess the existing repair mechanism with both runs' evidence |
| Different failure | Diagnose that failure without attributing it to the turn cap |

Explicitly NOT an automatic next step: raising `MAX_AGENT_TURNS` to 40. Two exhausted runs support investigating the turn budget; repeated file-reading or non-submission behavior may only be prolonged by more turns.

## 5. Outcome classification and evidence

Successful / Diagnosed failure / Undiagnosable failure; positive sub-results preserved; interrupted segments marked; token data NOT PERSISTED where absent; every operator action attributed. Evidence under `evidence/` with an `a5-` prefix; driver hash verified at T0 and run end.
