# Pilot A3 — Preregistration (E10)

**Frozen:** 2026-09-19, before any model-driven run.
**Status:** Preregistered; Pilot A3 has NOT started. Execution begins only after this document is reviewed and merged, on the merge commit of this PR.

A3 is the **bounded-retry rerun of Pilot A2** — same issue, same immutable target SHA, same model/route, same limits — with exactly **one** deliberate delta set:

1. **Bounded transport retry** (this PR's code change; the operator-authorized successor policy from A2's closeout).
2. Nothing else. No model, prompt, provider, turn-cap, repair-budget, or Definition-contract changes.

## 1. Frozen baselines

| Item | Value |
| --- | --- |
| Stratum baseline | `a4a1be5617de83575122b61ab9b0b94bd92a9b09` (A2 execution revision) |
| Stratum A3 execution revision | The merge commit of this PR — delta vs baseline is the bounded retry seam + its tests + this document |
| Target repository / `main` (immutable, for controlled comparison) | `magtheo/student-platform` @ `86ec0871d64ecca8732434c11d015fd8e08ddc7e`, branch `pilot-a/issue-108`, never merged |
| Target issue | `magtheo/student-platform#108` — OPEN (re-verified 2026-09-19) |
| Pilot driver (corrected harness, unchanged since A2) | sha256 `6095ffd90b64a5f0add544ab8cffa2fc0c6d4759c45f3de8b2e3dfe748c2a086` — verified 2026-09-19. Any change after T0 = experiment-integrity failure. A3 WI ids are driver arguments (`wi-define-108-a3`); the execution WI is created as a logged mechanical seeding action (same repository API), exactly as in A2. |
| Pilot A2 record | DIAGNOSED FAILURE — single define-work attempt died at turn 16, `UND_ERR_HEADERS_TIMEOUT` after 301,237 ms. Evidence: `evidence/a2-*` (immutable). |

## 2. The one delta — bounded transport retry (exact policy)

**Scope:** define-work step executions ONLY. The runner enables the loop's retry capability iff `ctx.workflowId === 'define-work'`; every other workflow keeps historical fail-fast behavior, byte-for-byte.

**Eligible error:** `UND_ERR_HEADERS_TIMEOUT` only — detected against the already-extracted cause-code chain of the failed request (single extraction; eligibility and evidence cannot diverge).

**Budget:** maximum **one** retry per step execution. A repeated timeout **fails closed** with both attempts recorded.

**Semantics of the retry:** ONE re-issue of the SAME failed inference request — the request object is constructed once per turn and re-passed byte-identically (same model, messages snapshot, tools, max_tokens, temperature). The failed call never produced a turn, so the retry re-enters the SAME turn slot: **no extra model turn, no result-repair consumption, no replay of previously completed tool calls** (their results are already part of the conversation and are never re-executed). No retry for semantic-contract failures, format repairs, or turn exhaustion. No generic retry framework, configuration subsystem, or new workflow stages — one constant (`MAX_HEADERS_TIMEOUT_RETRIES = 1`), one eligibility check, one capability flag.

**Observability:** a bounded `transport_retry` record (attempts, first-failure duration + cause code, retried-request duration, outcome) persists on success AND failure paths (`-loop.json`), so a retried call is always distinguishable from an un-retried one. Never carries request payloads, reply text, or credentials.

**Wall-clock:** the retry may add up to ~300 s (the failing request's own duration) to a step. The 120-minute end-to-end clock from T0 is unchanged; the worst case (+≤~5 min) is accounted for here, before T0.

**Timeout attribution (corrects the A2 closeout's wording — A2 evidence itself is untouched):** the 300 s limit is **undici's library-default `headersTimeout`** — the GLM multi-turn provider issues a plain `fetch()` with no explicit dispatcher or timeout options. The client gave up at ~300 s; whether the server would have responded later is NOT established by this evidence. A3's hypothesis is therefore stated at request level (transient/slow-completion), not gateway level.

## 3. Target drift (recorded, not acted on)

student-platform `origin/main` has advanced `86ec087… → ef071455639bb89558341165342420298166a261` while #108 remains open. The defect persists at main HEAD: rag-worker `main.py:1097` still publishes `{"error": str(e)}` while rag-api still reads `details.get("error_message", …)` (now ~line 244; line numbers drifted, the mismatch did not). **A3 runs against the original immutable `86ec087…` for controlled comparison with Pilot A/A2.** Integration with newer `main` is separate verification, out of scope here.

## 4. Explicitly unchanged (the reproduction set)

Identical to Pilot A2's frozen configuration (docs/pilots/pilot-a2.md §3): model `glm-5.3-flash`; route Z.ai Coding Plan (provider `glm`, `GLM_API_KEY`, max_tokens 16384); `MAX_AGENT_TURNS` 24; `MAX_RESULT_REPAIRS` 1; context `hard_ceiling` default 4000; `planning_depth` `'minimal'` / `max_iterations` 5 / `on_cap_hit` `'halt'`; 120-min clock; 2/3/2 budgets; zero mid-run frozen-field changes; no provider retries beyond the §2 policy; no in-path independent model reviewer (deterministic validation gate + external PR review); same dedicated worktrees and isolation rules (ordinary checkouts and both `main`s untouched; pilot branch never merged); publication through existing mechanisms only, PR never merged by the experiment.

## 5. Fresh state

Pilot A2's run state is archived to evidence (`a2-` files already closed; `.sle/` tarred on closeout), then the target worktree's `.sle/` is removed before T0. Fresh WI ids: `wi-define-108-a3`, `wi-exec-108-a3`. Any A3 Definition must come from A3's own define-work; no prior Definition is ever input.

## 6. Gates and hypotheses

Staged gates as A2 (Gate A zero-model checks; Gate B real-Definition resolver + provenance/hash + `hard_ceiling` probe with no truncation; Gate C natural halt/resume byte-identical authority, else `NOT EXERCISED`).

- **A1 (reproduction under bounded retry):** define-work converges on #108 when the single eligible transport failure is retried once — i.e., the A2 failure is transient at the request level.
- **H1 / H2 / H3:** unchanged from A2 (DDR-041 authority handoff; correct tested implementation within deterministic gate; reviewable PR + trustworthy external CI).

## 7. Outcome classification

Successful / Diagnosed failure / Undiagnosable failure, with Pilot A2's closeout rule: overall classification plus separately preserved positive sub-results. A second consecutive headers-timeout death (retry exhausted → fail closed) is itself a precise experimental result: the failure is NOT transient at the request level, and the successor decision (alternate route, longer client headers timeout as an explicit, preregistered setting, or provider engagement) is then evidence-driven. Interrupted segments marked as such; operator actions attributed; token evidence NEVER PERSISTED where absent.

## 8. Evidence

Same capture set as A2 under `evidence/` with an `a3-` prefix, plus per-attempt `transport_retry` records in `-loop.json` artifacts. Driver hash verified at T0 and again at run end.
