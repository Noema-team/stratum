# Pilot A — Preregistration (E5)

**Frozen:** 2026-09-19, before any model-driven run.
**Status:** Preregistered; Pilot A has NOT started. Execution begins only after this document is reviewed and merged, on the merge commit of this PR.

Pilot A is a single, falsifiable real-world experiment: Stratum (builder, GLM-5.3-Flash, supervised posture) implements one open external issue end-to-end. It is not a qualification series and not an architecture campaign. GLM-5.3-Flash is **not** formally qualified (E4-H: 6/9 valid runs, qualification closed); it runs here under the supervised/pilot posture only.

---

## 1. Frozen baselines

| Item | Value |
| --- | --- |
| Stratum baseline (verified) | `fba9ca53995bb2eea2148a90533588a0d961a426` (includes PR #23 / DDR-041) |
| Stratum execution revision | The merge commit of the E5 PR (docs-only delta from the baseline above; no code delta) |
| Target repository | `magtheo/student-platform` |
| Target `main` (frozen) | `86ec0871d64ecca8732434c11d015fd8e08ddc7e` |
| Target issue | `magtheo/student-platform#108` (reverified OPEN 2026-09-19) |

**Task (the external objective, verbatim scope from the issue):** fix the rag-worker → rag-api failure-payload contract mismatch. Acceptance criteria from #108:

- Failure payload keys match across worker and rag-api (aligning the worker to `error_message`/`stage` matches rag-api's persisted fields and avoids a migration).
- A failed job persists the worker's actual error message and failing stage.
- `retryable` is either sent by the worker or derived deliberately — not defaulted silently.
- Contract test covering worker failure → rag-api persistence path.

Preserve unrelated behavior and the existing status-transition safeguards.

**Defect reconfirmed at the frozen SHA (2026-09-19, via GitHub API):** worker publishes `{"error": str(e)}` in the failed status update (`apps/ai-server/rag-worker-service/main.py:1097`); rag-api's failed branch reads `details.get("error_message" | "stage" | "retryable", …)` (`apps/ai-server/rag-api-service/main.py:237-239`). Defect unfixed at `86ec087`.

The issue text is the sole external objective. The builder receives no operator-written implementation plan, no paraphrase, and no post-dispatch hints.

## 2. Frozen model / provider configuration

Single route, verified live before freezing (2026-09-19): provider `glm` — Stratum's first-class Z.ai Coding Plan route (`src/llm-provider.ts`, `case 'glm'`), which uses the genuine multi-turn tool wire (`OpenAICompatibleMultiTurnProvider`; E3b evidence) at the Coding Plan endpoint.

| Setting | Frozen value |
| --- | --- |
| `provider` (`.sle/settings.json`) | `glm` |
| `base_url` | `https://api.z.ai/api/coding/paas/v4` (Stratum default) |
| `model` | `glm-5.3-flash` |
| `api_key_env` | `GLM_API_KEY` (key material never enters any repo, report, or log) |
| Completion budget (`max_tokens`) | `16384` |
| Result transport | Default textual SLE-OUTPUT fallback (no structured-output claim for this route) |
| Roles | All model calls in the run (define-work and execution, builder/debug roles) use this exact route and model; there is no separate in-path model reviewer (§3.1) |

Live verification of this exact route on 2026-09-19: HTTP 200, `model: glm-5.3-flash`, `finish_reason: stop`, correct content, usage reported.

The E4-H route (OpenRouter, `z-ai/glm-5.3-flash`) is **not** the pilot route: E4-H recorded 4 provider-degradation interruptions there, and remaining OpenRouter credit is low. Mid-run provider changes are forbidden (budget: 0); if the frozen route becomes unusable, that is a diagnosed failure (external dependency), not a config swap.

## 3. Invocation path (Definition → execution) — verified in code at the baseline SHA

1. **Workspace:** the pilot's student-platform worktree is the Stratum `projectRoot`; run state lives in its `.sle/` (SQLite, artifacts, journal). The pilot driver runs from the dedicated Stratum worktree (execution revision) and uses `createStratumApplication` — the production wiring — plus the scheduler; no bespoke provider path (same rule as `scripts/eval-define-work.ts`, which this driver mirrors and extends to execution). The driver is experiment infrastructure, kept untracked in the Stratum worktree; no Stratum source changes.
2. **define-work stage:** a define-work WorkItem for issue #108 runs to completion (`commit` terminal). Its canonical Definition artifact (type `definition`, latest ref) is recorded with a sha256 content hash. The Definition is authored by the model through define-work; the operator never writes, edits, or paraphrases it. The DDR-041 regression fixture is **not** used as the Pilot A Definition.
3. **Trusted handoff:** the execution WorkItem is created with `workflowParameters: { planning_depth: 'minimal', max_iterations: 5, on_cap_hit: 'halt', definitionSource: { workItemId: <define-work WorkItem id> } }` — `planning_depth` frozen explicitly at `'minimal'`. `StratumAgentAdapter` resolves the source (DDR-041, `src/execution/definition-source.ts`): strict shape → dependencies → same project → objective match → source `completed` → exactly one canonical artifact → path safety → ≤128 KiB → on-disk sha256 === recorded hash → parse. Reference is frozen into `WorkflowRun.resolvedParameters` at dispatch and restored from cursor on resume.
4. **Authority at execution:** every `StepRunContext` carries `authoritativeDefinition`; the ContextManager renders it verbatim under `## AUTHORITATIVE DEFINITION` with source WorkItem, ref, and sha256. If the fixed context (system + state + task + failureContext, including the verbatim Definition) exceeds the configured `hard_ceiling`, execution fails closed before any model call (`context_budget_exceeded`) — no truncation, no degradation.
5. **Halt/resume:** iteration-cap (`on_cap_hit: 'halt'`) and HUMAN_DECISION halts resume through the existing ResumeService; DDR-041 tests prove byte-identical authority across resume. The same-source-authority-survives-resume property is re-verified mechanically on the live run (§7, Gate C).

### 3.1 Independent review path — traced at the frozen revision (no new review infrastructure)

Traced in `src/workflow/builtins/full-build.ts` and `src/execution/full-build-step-runner.ts` at `fba9ca5`:

- The full-build workflow has exactly two `kind: 'review'` steps. `critique` is skipped unless `planning_depth` is `'deep'`/`'research'` (`skip_if`, full-build.ts:52-55) — at the frozen `'minimal'` it does **not** run. Even when it runs, `critique` (CriticAgent → `docs/cycle-critique.md`) reviews the **design** output immediately after the `design` step, before any implementation exists — it never receives the implementation diff.
- `validation_gate` (full-build.ts:110) calls `ValidationGateService.run` (`src/exec-gate.ts`), a **deterministic** rule evaluation over `rules/validation.yaml` and run artifacts — not a model call. Its `on_fail → debug` routing is the only existing in-path "reviewer → builder" loop, and its reviewer is rule-based.
- **Limitation, preregistered:** at the frozen configuration, **no existing step gives an independent model reviewer the implementation diff.** The independent review channels for Pilot A are (a) the deterministic validation gate with bounded debug rounds in-path, and (b) external review of the published PR (maintainer/CI) after the run. Whether the deterministic gate plus external review suffices for H2's "obtain independent review and repair genuine findings" is an **observable Pilot A outcome**, not a capability claimed here. Any genuine external review findings that arrive post-run are recorded in evidence and do not retroactively change the run's classification.

**Budget interplay to respect:** the default `hard_ceiling` is 4000 tokens (~16 KiB at 4 chars/token) including the verbatim Definition. Definitions from E4-G-class runs ran ~8.7 KiB. Execution-time preflight therefore probes `assemble` with the real Definition before dispatch (§7, Gate B). A Definition that cannot fit is a diagnosed failure of the boundary contract — the operator must not shrink or edit it.

## 4. Frozen budgets

| Budget | Limit | Mechanism / accounting |
| --- | --- | --- |
| Wall-clock (entire experiment) | 120 min | One clock covering the whole experiment: starts at the **first Pilot A model call (define-work dispatch)** and ends at PR opened or run stopped — define-work, execution, review loops, and publication are all inside it. No separate define-work budget. |
| Genuine semantic human Decisions | 2 | HUMAN_DECISION checkpoints only; routine approvals (dispatch, resume confirmations) are operator overhead, logged separately |
| Build/debug repair rounds | 3 | `debug`-step iterations counted in the run journal; abort (diagnosed failure) if exceeded even if `max_iterations` is not |
| Reviewer → builder fix rounds | 2 | `validation_gate` `on_fail` → `debug` routing — the existing in-path loop; the gate is deterministic (`rules/validation.yaml`, `src/exec-gate.ts`), not an independent model reviewer (§3.1) |
| `planning_depth` | `'minimal'` | Frozen explicitly; `critique` does not run at this depth (§3.1) |
| `max_iterations` / `on_cap_hit` | `5` / `'halt'` | Full-build parameters (system-level backstop) |
| Provider retries | Existing bounded policy | Unchanged |
| Mid-run changes to frozen models/prompts/source revisions | 0 | Any such change ends the run as diagnosed failure |

## 5. Worktree isolation and permitted Git actions

- Dedicated worktrees, created after E5 merges, before dispatch:
  - Stratum: `/home/theo/Documents/repos/pilot-a/stratum` at the execution revision (driver + evidence tooling only).
  - Target: `/home/theo/Documents/repos/pilot-a/student-platform` at `86ec087…`, pilot branch `pilot-a/issue-108` created inside this worktree.
- All generated code, tests, commits, and the pilot branch live inside the target worktree.
- Forbidden: mutating either ordinary checkout (`~/Documents/repos/stratum`, `~/Documents/repos/student-platform`); moving either frozen baseline mid-run; merging the pilot PR; pushing anywhere except the pilot branch to `magtheo/student-platform`; manual edits to generated code; manual branch publication reported as autonomous delivery.

## 6. External interruption policy

- Provider-level stall/degradation: apply the existing bounded retry policy; log each interruption with timestamps and evidence.
- More than 3 interruptions in total, or a sustained provider outage (e.g. status-page 5xx) exceeding 30 min: stop the run; classify per §8 against the interrupted stage's evidence. Per E4-H policy, provider-interrupted segments do not count as model failures and missing token evidence from an interrupted call is recorded as "not persisted", never as zero usage.
- Resume after an interruption uses the existing resume path only (no re-dispatch from scratch, no parameter changes).

## 7. Preflight gates (mechanical, staged; no DDR-041 fixture anywhere — the real canonical Definition only)

**Gate A — initial checks, zero model calls (before define-work dispatch):**

1. Both frozen revisions exist; target defect still present at `86ec087…` (re-check `main.py:1097` worker / `237-239` rag-api); issue #108 still OPEN.
2. Target workspace isolated: pilot worktrees exist at the frozen SHAs; both ordinary checkouts and both `main` refs unchanged (record `git rev-parse` before/after).
3. `GLM_API_KEY` present in environment (existence checked, value never printed); frozen test commands run green on the untouched baseline inside the target worktree: `python3 -m pytest apps/ai-server/rag-worker-service/tests apps/ai-server/rag-api-service/tests` (Python 3.13.5 / pytest 9.0.2 verified available).

**Gate B — post-define-work, pre-execution-dispatch checks (uses the real canonical Definition produced by this run's define-work stage; zero additional model calls):**

4. `resolveDefinitionSource` resolves the execution WorkItem's `workflowParameters.definitionSource` against the actual completed define-work WorkItem and returns the artifact row.
5. The source Definition is the canonical `definition` artifact (exactly one latest-per-ref row); on-disk sha256 === recorded hash.
6. A probe `ContextManager.assemble` for role `builder` with the real Definition succeeds under `hard_ceiling` (no `context_budget_exceeded`, no truncation).

**Gate C — first natural halt/resume on the live run (authority assertion):**

7. At the run's first natural halt (HUMAN_DECISION or cap halt), the resumed run's `authoritativeDefinition` sha256 is byte-identical to the pre-halt value — same source authority survives resume, recorded as evidence.

Any unsatisfied check ⇒ specific diagnosed blocker reported; the run does not proceed past that gate. No new subsystem is built to satisfy a check.

## 8. Hypotheses and outcome classifications

- **H1 — Authority:** a canonical Definition produced by `define-work` reaches the builder without human translation, preserving identity, hash, and content through dispatch and resume.
- **H2 — Implementation:** Stratum implements #108, tests the cross-service contract, obtains independent review, and repairs genuine findings within budget.
- **H3 — Delivery:** Stratum produces a reviewable PR and obtains trustworthy external CI evidence through existing mechanisms.

H1/H2/H3 are judged independently; H1/H2 can succeed even if H3 exposes a diagnosed publication gap.

| Outcome | Operational definition |
| --- | --- |
| **Successful** | Reviewable, tested PR produced with traceable Definition → execution → review → external evidence, within the intervention policy |
| **Diagnosed failure** | A specific, attributable model, implementation, workflow, publication, or external-dependency cause prevents completion (recorded with evidence) |
| **Undiagnosable failure** | The system cannot establish what happened, which artifacts were authoritative, or who owns the next action |

## 9. Evidence capture

Per-stage, preserved under `/home/theo/Documents/repos/pilot-a/evidence/` (outside both worktrees' committed trees): frozen SHAs; Definition identity (source WorkItem, artifact ref, sha256); run journal (steps, iterations, findings, repairs, Decisions with rationale); model calls and usage where persisted; test results; changed files; commits; PR identity; CI results; complete operator-action log (overhead vs. semantic Decisions). Accounting rules: interrupted segments marked as such; missing token evidence recorded as "not persisted"; every intervention attributed. If Stratum's existing mechanisms cannot open the PR or consume external CI, the branch publication / CI retrieval performed by the operator is logged as a mechanical overhead action and H3 is judged accordingly — the limitation is recorded honestly, and no PR/CI integration is added during the experiment.
