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
Tests: 987 total / 958 pass / 29 fail
Known baseline failures: better-sqlite3 SIGSEGV cluster only (env, not logic)
```

The baseline is not touched while qualification is running.

## Milestones

| ID | Milestone | Type | Deliverable / exit gate |
| -- | --------- | ---- | ----------------------- |
| **E0** | Close Era I: merge #9, freeze D.34 | housekeeping | DONE — baseline above. |
| **E1** | Restore runnable qualification environment | environment | `better-sqlite3` failure deliberately reproduced, then the smallest environmental fix (native rebuild / compatible prebuild / dependency adjustment). Deliverable: a documented environment where `npm ci && npm run eval:define-work` executes and produces `summary.md` + `report.json`. No conclusions about the model yet. If local repair turns invasive, use the known-good CI environment instead — the purpose is to run the experiment, not perfect local native-module ergonomics. Persistence architecture is not up for revision here. |
| **E2** | GLM-5.3-Flash qualification | experiment | First real Era II experiment. Question: *is GLM reliable enough for `define-work` semantic reasoning under the D.34 output boundary* — NOT "is GLM good enough for Stratum in general" (Rule 4). Freeze config (Rule 5), then 5 repetitions × EARLY / PARTIAL / MATURE = 15 runs. Collect per run: PASS/FAIL/ERROR, SEM/TRANSPORT/CONV, iterations, repairs, human decisions, persisted evidence; series DEPLOY verdict. No patching during the series (Rule 1). |
| **E3** | Qualification review | decision | Short factual report, then exactly one decision: **A** qualified → Pilot A; **B** mostly SEM → model rejected with evidence, test a stronger model, do NOT modify Stratum to accommodate it; **C** TRANSPORT failures → inspect persisted evidence; reopen the D.34 boundary only for a demonstrated violated invariant; **D** CONV failures → investigate workflow separately. The diagnosis determines the next task. |
| **E4** | Fallback model qualification (only if needed) | experiment | 1–2 stronger candidates through the same frozen matrix. Objective: *one credible model for the pilot*, not a model benchmark — otherwise model evaluation becomes the project. |
| **E5** | Pre-register Pilot A | experiment design | Commit `docs/pilots/pilot-a.md`: exact baseline (Stratum SHA, target repo SHA, model, config, start time); the task (non-trivial, 30–120 min of skilled human work, multiple files, tests required, some ambiguity, failure not dangerous); the five success criteria below; the intervention policy; the freeze rule. |
| **E6** | Execute Pilot A | experiment | Real task on the frozen revision: definition/planning → builder → review → repair → CI → PR. Observe, don't hover. Acceptable outcomes: **successful** (PR + clean CI/review + complete evidence), **diagnosed failure** (e.g. reviewer keeps finding the same defect the builder never closes — also valuable), **undiagnosable failure** (run stopped, state unclear, evidence missing — the genuinely bad result: the supervisor itself lacks observability or integrity). |
| **E7** | Pilot A postmortem (before changing code) | analysis | `docs/pilots/pilot-a-results.md`, factual: outcome, timeline, human interventions, PR quality, review rounds, CI results, failures, recovery behavior, evidence quality. Derived deficiency table: finding / severity / evidence / action. **Only findings with actual evidence enter the engineering backlog.** |
| **E8** | Narrow hardening cycle | engineering | Fix the single highest-priority violated invariant, priority order: state corruption / unrecoverable run → incorrect autonomous behavior → repeated workflow failure → operator inconvenience. Then re-run the pilot (A0 → defect → patch → A1) and check whether reliability *actually* improved. |
| **E9** | Pilot A re-run (validation) | validation | Second execution after the patch — the A1 that makes A0→A1 a measurement, not a feeling. |
| **E10** | Pilot B: 5–10 task long-run | experiment | A small backlog (independent + dependent tasks, at least one expected to block). Evaluate the supervisor: choosing useful work, continuing past a blocked task, duplicate-work avoidance, per-task context isolation, multiple PRs, resume after interruption, surfacing only real human decisions. This is the test of the orchestration vision itself. |

### Pilot A success criteria (frozen at E5)

1. **Reviewability** — the produced PR can genuinely be evaluated for merge.
2. **Traceability** — important actions and decisions have reconstructable evidence.
3. **Diagnosability** — every failure has an identifiable cause.
4. **Human-boundary discipline** — every human intervention has a reason.
5. **State integrity** — no silent corruption or loss of authoritative state.

Both "passed" and "instructive failure with complete diagnosis" are valid outcomes;
only an undiagnosable run is a bad one.

### Pilot A intervention policy

```text
Allowed:
- answer a genuine requested Decision
- abort destructive/unsafe behavior

Not allowed:
- coaching the builder
- fixing its code
- changing prompts
- patching Stratum
- changing model/configuration
```

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
1.  Merge #9                      ✓ (8263665)
2.  Record Era II baseline SHA    ✓ (above)
3.  Fix better-sqlite3 environment     ← next
4.  Smoke eval harness
5.  Freeze GLM qualification config
6.  Run 15-run GLM series
7.  Review SEM / TRANSPORT / CONV / DEPLOY
8.  Make model decision
9.  Write Pilot A protocol
10. Launch Pilot A
```

Deliberately almost no speculative feature development in the queue.
