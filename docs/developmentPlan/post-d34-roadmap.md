# Era II Execution Plan — Trustworthy Autonomous Worker

**Status:** active · **Updated:** 2026-09-15
**Decision:** `docs/decisions/ddr-035-post-d34-operational-pivot.md`
**Superseded plan:** `post-mvp-roadmap.md` (history)

The primary question changed at the D.34 freeze from *"what should we build next?"*
to *"what happens when we actually use it?"* This plan is a small sequence of **gated
milestones**: each stage ends in an explicit decision, and nothing beyond E10 is
planned in detail — E6–E10 exist precisely to tell us what comes afterward.

## Project rules (binding)

> **Rule 1 — Freeze during experiments.** Never patch a running qualification/pilot.
> Finish the series unless behavior is destructive or the experiment becomes invalid.
>
> **Rule 2 — Evidence before architecture.** New infrastructure requires a concrete
> observed deficiency, with tier, evidence, and frequency.
>
> **Rule 3 — Clean results increase difficulty.** A clean run triggers the next
> harder experiment, never a refactor.
>
> **Rule 4 — Capability-specific qualification.** Models are qualified for roles
> (e.g. `define-work` semantic reasoning), not globally labeled good or bad.
>
> **Rule 5 — Pilots run against immutable revisions.** SHA, model id, provider,
> temperature, max tokens, scenario definitions, and repetition counts are recorded
> before the run and unchanged while it runs.

## Era II baseline (E0 — DONE)

```text
ERA II BASELINE

Stratum SHA: 8263665  (Merge PR #9 — D.34 C7 harness + evidence)
D.34: FROZEN (C1–C7 DONE)
Tests (baseline env): 987 total / 958 pass / 29 fail
Known baseline failures: better-sqlite3 SIGSEGV cluster only (env, not logic)
```

The baseline is not touched while qualification is running.

### E1 — DONE (2026-09-15): the failure cluster was the environment, not the code

The baseline declared `node >=22` and CI runs Node 22; the local machine was on
Node 20.19.2 (unsupported). Alignment, not repair:

```text
E1 ENVIRONMENT (recorded)

nvm + Node: v22.23.2   (package.json requires >=22.0.0)
Install:     npm ci
Verify:      npm run verify  →  1496 pass / 0 fail / 0 cancelled
Eval smoke:  npm run eval:define-work  →  executes end-to-end,
             emits report.json + summary.md
```

Under the supported runtime **the entire suite is green** — all 29 baseline
failures (and the local eval-script segfaults) were the Node 20 native module.
No dependency, persistence, or code changes were made. The harness smoke also
validated the C7 diagnosis plumbing on real runs: with no provider credentials
configured, all three scenarios correctly diagnose `CONV` ("LLM call failed:
LLM not configured") — never SEM or TRANSPORT.

Note: one environment change outside the repo — `~/.npmrc` carried a
`prefix=~/local` line incompatible with nvm (backed up to `~/.npmrc.bak-pre-e1`,
then removed; nvm's own remediation).

## Milestones

| ID | Milestone | Type | Deliverable / exit gate |
| -- | --------- | ---- | ----------------------- |
| **E0** | Close Era I: merge #9, freeze D.34 | housekeeping | DONE — baseline above. |
| **E1** | Restore runnable qualification environment — **DONE 2026-09-15** | environment | `better-sqlite3` failure deliberately reproduced, then the smallest environmental fix (native rebuild / compatible prebuild / dependency adjustment). Deliverable: a documented environment where `npm ci && npm run eval:define-work` executes and produces `summary.md` + `report.json`. No conclusions about the model yet. If local repair turns invasive, use the known-good CI environment instead — the purpose is to run the experiment, not perfect local native-module ergonomics. Persistence architecture is not up for revision here. |
| **E2** | GLM-5.3-Flash qualification | experiment | First real Era II experiment. Question: *is GLM reliable enough for `define-work` semantic reasoning under the D.34 output boundary* — NOT "is GLM good enough for Stratum in general" (Rule 4). Freeze config (Rule 5), then 5 repetitions × EARLY / PARTIAL / MATURE = 15 runs. Collect per run: PASS/FAIL/ERROR, SEM/TRANSPORT/CONV, iterations, repairs, human decisions, persisted evidence; series DEPLOY verdict. No patching during the series (Rule 1). |
| **E3** | Qualification review | decision | Short factual report, then exactly one decision: **A** deployment-qualified → consider for unattended `define-work`; **B** NOT qualified but failures understood → not reliable enough for unattended use, *may still be Pilot-A-eligible under supervision or another role*; **C** repeated SEM failures → model capability problem for this role, test a stronger model, do NOT modify Stratum to accommodate it; **D** TRANSPORT/integrity failures → inspect persisted evidence; reopen the D.34 boundary only for a demonstrated violated invariant; **E** CONV failures → investigate workflow separately; **F** environment invalidated the experiment → repair environment and repeat the same frozen experiment. The gate's formal semantics are never reinterpreted: `DEPLOY qualified ⇔ every run passed` — 13/15 stays **NOT QUALIFIED**. What is separated is **qualification from usefulness**: not deployment-qualified ≠ useless. Only D and E authorize Stratum engineering at this stage. The diagnosis determines the next task. |
| **E4** | Fallback model qualification (only if needed) | experiment | 1–2 stronger candidates through the same frozen matrix. Objective: *one credible model for the pilot*, not a model benchmark — otherwise model evaluation becomes the project. |
| **E5** | Pre-register Pilot A | experiment design | Commit `docs/pilots/pilot-a.md` — deliberately SHORT (not another planning document), containing exactly the frozen block below: system/task/budget/success/interruption/human policy. |

### Pilot A frozen protocol block (the entirety of E5)

```text
SYSTEM
Stratum SHA:            <frozen>
Target repo SHA:        <frozen>
Builder model:          <frozen>
Reviewer model:         <frozen>
Configuration:          <frozen>

TASK
Exact task statement:   <one real task; non-trivial; 30–120 min of skilled
                        human work; multiple files; tests required; some
                        ambiguity; failure not dangerous>

BUDGET
Max wall-clock:         <frozen>
Max review/fix rounds:  <frozen>
Max provider retries:   <frozen — existing bounded policy>
Max decision checkpoints: <frozen>

SUCCESS (frozen at E5, unchanged from DDR-035 rule 6)
- reviewable PR
- traceable evidence
- failures diagnosable
- human interventions justified
- no silent state corruption

EXTERNAL INTERRUPTION POLICY
429 / provider outage:   pause/retry per existing bounded policy; log the
                         interruption; no coaching.
CI infra failure:        log as external interruption; retry only per frozen
                         policy.
Persistent outage:       abort the experiment as ENVIRONMENTAL — never
                         recorded as SEM/TRANSPORT/CONV.

HUMAN POLICY
Allowed:   answer a genuine Decision; abort unsafe/destructive execution;
           perform PRE-REGISTERED environmental recovery.
Forbidden: coaching the builder; fixing generated code; changing prompts;
           changing model; patching Stratum.
```

**Hard rule — no patching during Pilot A:** `observe → record → finish or abort
→ postmortem → classify → only then patch`. Never `observe → quick fix →
continue`; the second destroys the experiment.
| **E6** | Execute Pilot A | experiment | Real task on the frozen revision: definition/planning → builder → review → repair → CI → PR. Observe, don't hover. Acceptable outcomes: **successful** (PR + clean CI/review + complete evidence), **diagnosed failure** (e.g. reviewer keeps finding the same defect the builder never closes — also valuable), **undiagnosable failure** (run stopped, state unclear, evidence missing — the genuinely bad result: the supervisor itself lacks observability or integrity). |
| **E7** | Pilot A postmortem (before changing code) | analysis | `docs/pilots/pilot-a-results.md`, factual: outcome, timeline, human interventions, PR quality, review rounds, CI results, failures, recovery behavior, evidence quality. Derived deficiency table: finding / severity / evidence / action. **Only findings with actual evidence enter the engineering backlog.** |
| **E8** | Narrow hardening cycle | engineering | Fix the single highest-priority violated invariant, priority order: state corruption / unrecoverable run → incorrect autonomous behavior → repeated workflow failure → operator inconvenience. Then re-run the pilot (A0 → defect → patch → A1) and check whether reliability *actually* improved. |
| **E9** | Pilot A re-run (validation) | validation | Second execution after the patch — the A1 that makes A0→A1 a measurement, not a feeling. |
| **E10** | Pilot B: 5–10 task long-run | experiment | A small backlog (independent + dependent tasks, at least one expected to block). Evaluate the supervisor: choosing useful work, continuing past a blocked task, duplicate-work avoidance, per-task context isolation, multiple PRs, resume after interruption, surfacing only real human decisions. This is the test of the orchestration vision itself. |

### Pre-registered hypotheses (NOT tasks)

Predictions are recorded so that Pilot A can confirm or kill them. They are
deliberately not converted into engineering work — only the E7 deficiency table
(with evidence) creates tasks.

```text
H1: The builder output boundary may be insufficiently trustworthy
    (no OutputContract registered for implementation output; only
    'definition-readiness' and 'definition' exist).

    Evidence required to act: Pilot A demonstrates an actual transport or
    state-integrity failure attributable to builder output representation.

    Note: the right abstraction may turn out to be commits / workspace
    mutation rather than OutputContract<CodePatch>. Pilot A decides.
```

Valid outcomes remain: **successful**, **diagnosed failure** (also valuable),
**undiagnosable failure** (the genuinely bad result — the supervisor itself
lacks observability or integrity).

## ci-toolkit and the UI: evidence-triggered, not scheduled

Neither is a milestone. Both enter through the E7 deficiency table:

- If Pilot A reveals "Stratum finishes work but has no authoritative knowledge of PR
  CI/review state," the next narrow integration is ci-toolkit as **external quality
  evidence** consumed by Stratum (head SHA, CI status, review verdict, required
  gates) — never reimplemented. Same principle for umbrella PRs.
- When the multi-task pilot creates real operator burden, derive the minimum views
  from what actually mattered. The likely data is already visible: work item, state,
  phase, PR, CI, review, last meaningful event, decision needed? — but Pilot B
  decides, and the interface renders artifacts the system already emits.

## Immediate queue

```text
1.  Merge #9                          ✓ (8263665)
2.  Record Era II baseline SHA        ✓ (8263665)
3.  Node 22 environment + npm ci      ✓ (v22.23.2, verify 1496/0)
4.  Smoke eval harness                ✓ (report.json + summary.md; CONV on no-credentials)
5.  Freeze GLM qualification config   ← next (model id, provider, temp,
                                        completion budget, settings file)
6.  Run 15-run GLM series             (touch nothing while it runs)
7.  Review SEM / TRANSPORT / CONV / DEPLOY → decision A–F
8.  (E4 only if B) stronger-model series through the same frozen matrix
9.  Write short Pilot A protocol (the frozen block above)
10. Launch Pilot A on the frozen revision
```

Deliberately almost no speculative feature development in the queue.
