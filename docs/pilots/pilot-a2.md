# Pilot A2 — Preregistration (E8)

**Frozen:** 2026-09-19, before any model-driven run.
**Status:** Preregistered; Pilot A2 has NOT started. Execution begins only after this document is reviewed and merged, on the merge commit of this PR.

A2 is a **controlled rerun of Pilot A** — same issue, same target SHA, same model/route, same limits — with exactly one deliberate delta set:

1. **The pilot harness is corrected and frozen as experimental input** (Pilot A's only diagnosed self-inflicted failure).
2. **Evidence-only observability** is added to the multi-turn loop (Pilot A lost provider-failure causes and rejected payloads).

Everything else is byte-identical in configuration to Pilot A. A2 exists to answer the question Pilot A never reached: *given a correctly initialized harness, can the already-demonstrated canonical Definition flow through DDR-041 into full-build and produce a correct implementation?*

## 1. Frozen baselines

| Item | Value |
| --- | --- |
| Stratum baseline | `fa51e8a1dd64f74e72bd2cbb38d897e1cd6e21f3` (Pilot A execution revision) |
| Stratum A2 execution revision | The merge commit of this PR — delta vs baseline is **evidence-only** (see §2) plus this document |
| Target repository / `main` | `magtheo/student-platform` @ `86ec0871d64ecca8732434c11d015fd8e08ddc7e` (unchanged; Pilot A generated zero target code, so there is no target drift) |
| Target issue | `magtheo/student-platform#108` — same objective, issue text verbatim; reverified OPEN at Gate A |
| Pilot A record | `DIAGNOSED FAILURE`, positive sub-result: **define-work real-repository convergence demonstrated once** (attempt 2: 13 turns, contract-valid 17,687-byte Definition, materialized, hash-verified). Evidence: `/home/theo/Documents/repos/pilot-a/evidence/{e7-extraction.md,pilot-a-outcome.md}` |

## 2. The two deltas from Pilot A (exhaustive)

**Delta 1 — harness corrected and frozen.** The untracked pilot driver caused attempt 2's loss (missing `.sle/map.yaml` bootstrap). The corrected driver (idempotent seed + production `createInitialMap` bootstrap, identical to `stratum init`) is frozen before T0:

```text
pilot-driver SHA256: 6095ffd90b64a5f0add544ab8cffa2fc0c6d4759c45f3de8b2e3dfe748c2a086
```

Any change to this file after T0 is an experiment-integrity violation ending the run as diagnosed failure.

**Delta 2 — evidence-only observability (this PR's code change).** In `src/agent-loop.ts` / `src/agent-runner.ts`:
- A failed provider call records bounded cause metadata — `duration_ms`, error name/code, undici cause name/code/message — into the failure observation (`transport_failure`), closing the "fetch failed" blind spot (r1/r4).
- A contract-rejected submission is preserved: bounded `rejected_result` in the observation — `argument_bytes` is the UTF-8 byte size of the compact normalized JSON serialization of the rejected value, plus the repair instruction as issued — and the **normalized rejected semantic payload** (the transport-parsed value, JSON-serialized; NOT original wire bytes) in a sibling `<step>-rejected-result.json`, whose byte size equals `argument_bytes` (attempt 5 lost both).

No behavior change: `MAX_AGENT_TURNS`, `MAX_RESULT_REPAIRS`, prompts, provider selection, retry behavior, and workflow semantics are untouched. This is the "safe evidence improvement" category — it changes what is recorded, not what the model or workflow does.

## 3. Explicitly unchanged (the reproduction set)

| Field | Frozen value |
| --- | --- |
| Model | `glm-5.3-flash` |
| Route | **Z.ai Coding Plan** — provider `glm`, `https://api.z.ai/api/coding/paas/v4`, `GLM_API_KEY`, max_tokens 16384. (The post-Pilot-A OpenRouter interlude is superseded by this prereg; switching provider to improve odds was rejected — no evidence requires it. Recorded in `route-decision.md`.) |
| `MAX_AGENT_TURNS` | 24 (unchanged — one observed exhaustion is insufficient evidence to raise) |
| `MAX_RESULT_REPAIRS` | 1 (unchanged — one observed rejection is insufficient evidence to raise) |
| Context `hard_ceiling` | default 4000 (unchanged) |
| `planning_depth` / `max_iterations` / `on_cap_hit` | `'minimal'` / `5` / `'halt'` |
| Wall-clock | 120 min, entire experiment, from the first model call. **Unchanged deliberately**: Pilot A's 72 minutes were consumed by failure recovery, not proven insufficient for a clean run — A2 is the test of that. |
| Human Decisions / repair budgets | 2 semantic / 3 build-debug / 2 review-fix (unchanged accounting) |
| Mid-run changes | 0 — any frozen-field change ends the run as diagnosed failure |
| Provider retries | None added. If A2 hits another long-conversation `fetch failed` under the corrected harness, bounded provider retry becomes strongly justified for a successor experiment — recorded then, not added now. |
| Review | Unchanged per Pilot A §3.1: no in-path independent model review exists; deterministic validation gate + external PR review are the channels |
| Worktrees | Same dedicated worktrees (`/home/theo/Documents/repos/pilot-a/{stratum,student-platform}`); ordinary checkouts and both `main`s untouched; pilot branch `pilot-a/issue-108` never merged |
| Publication | Unchanged: if Stratum cannot open the PR, operator publication is logged overhead; H3 judged accordingly |

## 4. Fresh-state rule

Pilot A's run state (`.sle/` in the target worktree, incl. attempt 2's `definition.md`) is archived to the evidence directory, then the worktree's `.sle/` is removed before T0. A2 uses fresh WorkItem ids (`wi-define-108-a2`, `wi-exec-108-a2`). The A2 canonical Definition must come from A2's own define-work stage; Pilot A's attempt-2 Definition is evidence, never input.

## 5. Gates and hypotheses

Staged gates as in Pilot A (docs/pilots/pilot-a.md §7): **Gate A** zero-model checks (SHAs, defect present at `86ec087`, issue OPEN, isolation, credentials, baseline suites green — per-service pytest invocation); **Gate B** post-define-work, real canonical Definition (resolver + provenance/hash + probe assemble under `hard_ceiling`); **Gate C** first natural halt/resume byte-identical authority — recorded NOT EXERCISED if no natural halt occurs.

- **A1 (reproduction):** define-work converges again on #108 under the corrected harness (step-level contract-valid Definition, as demonstrated once in Pilot A).
- **H1 (authority):** the canonical Definition reaches the builder through `definitionSource` without human translation, preserving identity/hash through dispatch and resume.
- **H2 (implementation):** #108 implemented, cross-service contract tested, deterministic gate passed, genuine findings repaired within budget (review limitation per §3 applies).
- **H3 (delivery):** reviewable PR + trustworthy external CI evidence through existing mechanisms.

A1–H3 are judged independently.

## 6. Outcome classification

Successful / Diagnosed failure / Undiagnosable failure, as Pilot A §8 — with the closeout rule: overall classification plus separately recorded positive sub-results (so partial demonstrations survive an overall failure). Interrupted segments marked as such; missing token evidence recorded as NOT PERSISTED, never zero; every operator action attributed.

## 7. Evidence

Same capture set as Pilot A (journal, step executions, run artifacts, SHAs, Definition identity, Decisions, tests, commits, PR, CI, operator log) plus the new observability artifacts (`transport_failure` in `-loop.json`, `<step>-rejected-result.json`), under `/home/theo/Documents/repos/pilot-a/evidence/` with an `a2-` prefix. The frozen driver hash is verified at T0 and again at run end.
