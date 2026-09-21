# Pilot A6 — Preregistration (E15)

**Frozen:** 2026-09-21, before any model-driven run.
**Status:** Preregistered; Pilot A6 has NOT started. Execution begins only after this document is reviewed and merged, on the merge commit of its PR.

A6 changes exactly **one** behavioral variable: **the define-work / synthesize-definition completion budget: 16,384 → 32,768 tokens** — step-scoped, because A5's failure point was precisely that one step. Every other step, including the not-yet-exercised later define-work stages (definition-readiness-review, refine-definition) and all of full-build, keeps 16,384. Everything else is frozen from A5.

## 1. Evidence basis (the five-run series)

- **A2**: transport death — `UND_ERR_HEADERS_TIMEOUT` at turn 16 after 301,237 ms (Coding Plan route; cause captured by the PR #25 instrumentation).
- **A3**: submission reached the real `submit_result` channel (15,550 bytes, substantively correct); rejected twice on ONE contract-vocabulary defect (`facts[13].kind='artifact'`); repair exhausted.
- **A4**: 24-turn exploration exhaustion — 38 unique reads, zero repeats, never submitted.
- **A5**: turn 19 `stop_reason=max_tokens` — the full frozen 16,384 completion budget consumed mid-generation with no result block; five turn slots remained.
- **Transport, A3–A5**: 72 provider calls, zero observed headers timeouts — positive evidence only, not proof of permanent resolution.
- **E12 source/kind teaching remains empirically untested**: A4 and A5 never submitted.

## 2. The one delta — and its exact seam

`.sle/settings.json` gains an optional declarative section:

```json
"workflow_max_tokens": { "define-work/synthesize-definition": 32768 }
```

**Plumbing (traced):** settings → `resolveCompletionBudget`/`resolveLLMProvider` → `AgentRunnerConfig.max_tokens` → AgentRunner → AgentLoop/completeMultiTurn. The global budget is applied at three runner call sites (multi-turn loop, structured single-turn, plain single-turn) for every workflow.

**Seam:** `AgentRunnerConfig.workflowMaxTokens?: Record<string, number>` keyed by compact `"workflowId/stepId"` (explicit composition-root argument) with a strict project-settings fallback read by the runner from `projectRoot` — required because the frozen pilot driver's 8-argument `buildAgentRunner` call cannot pass new arguments. One lookup helper (`completionBudgetFor(ctx)`, key `\`${ctx.workflowId}/${ctx.stepId}\` `` ``` ``) applied at the three existing call sites. Fail-closed whole-map validation: absent file/key, wrong shape, or ANY invalid entry (malformed key, non-integer, ≤ 0) discards the ENTIRE map → the existing global budget applies everywhere; never an error, never a partial map.

**Scope guarantee (regression-pinned):** define-work/synthesize-definition receives 32,768; definition-readiness-review, refine-definition, and full-build keep 16,384; repairs/retries inside synthesize-definition retain 32,768 (in-run continuation calls ride the same step lookup); the override also reaches the runner through the pilot driver's actual 8-argument `buildAgentRunner` path with settings declared before construction; `MAX_AGENT_TURNS = 24` and `MAX_RESULT_REPAIRS = 1` constants pinned; retry policy, result schema, and submit_result teaching untouched (existing E12/C5/C1 pins); absent/malformed settings preserve byte-for-byte backward compatibility. No budget-policy framework, no provider- or model-specific branching, no pilot-specific identifiers, no reasoning configuration, no new stages, no prompt/teaching changes.

## 3. Provider qualification (completed 2026-09-21, minimal non-pilot call)

POST `/chat/completions`, model `z-ai/glm-5.3-flash`, `max_tokens: 32768`, one `read_file` tool declared, `tool_choice: auto` → **HTTP 200**, model echoed `z-ai/glm-5.3-flash`, content `'ok'`, `finish_reason: stop`, usage accepted (`completion_tokens: 3`, reasoning_tokens 0). The route accepts the 32,768 budget and the tool-calling wire unchanged. Not inferred from documentation.

## 4. Frozen inputs (everything else from A5)

| Item | Value |
| --- | --- |
| Stratum A6 execution revision | The merge commit of this PR — delta vs `cc0ba2b…`: the budget seam + regressions + this document |
| Target / branch | `86ec0871d64ecca8732434c11d015fd8e08ddc7e`, `pilot-a/issue-108`, never merged |
| Issue | `magtheo/student-platform#108` (re-verify OPEN at Gate A) |
| Model / route | `z-ai/glm-5.3-flash` via OpenRouter, `OPENROUTER_API_KEY`, **global max_tokens 16384 unchanged; define-work/synthesize-definition generation 32768 via the step-scoped override** |
| Limits | `MAX_AGENT_TURNS` 24 · `MAX_RESULT_REPAIRS` 1 · single `UND_ERR_HEADERS_TIMEOUT` retry · E12 teaching · `hard_ceiling` 4000 · minimal/5/halt · budgets 2/3/2 · 120-min clock |
| Pilot driver | sha256 `09bd01f68a9637ae47b2364c1ace6c4837102688cecd7ae94b9a04a635f42654` (verified 2026-09-21); any post-T0 change = integrity failure |
| WorkItems / state | Fresh `wi-define-108-a6` / `wi-exec-108-a6`; A5 `.sle` archived then removed; the `workflow_max_tokens` settings section is added as a logged mechanical pre-T0 seeding action (the frozen driver seeds only the base settings) |

## 5. Primary hypothesis and closeout rules

**H1 (unchanged):** fresh valid Definition → canonical materialization → `definitionSource` → `full-build`, no human translation. H2/H3 conditional on H1.

Closeout rules (frozen):
- Valid submission → continue through Gate B and H1 normally.
- Exhausts 32,768 completion tokens → **STOP**; preserved as evidence that more generation budget alone does not solve convergence at the synthesize-definition failure point.
- Hits the 24-turn cap instead → **STOP**; no mid-run raise.
- `source`/`kind` rejection returns → preserve and **STOP** under the existing repair policy.
- Any new failure class → diagnosed independently, without attributing to prior classes.

## 6. Outcome classification and evidence

Successful / Diagnosed failure / Undiagnosable failure; positive sub-results preserved; token data NOT PERSISTED where absent; operator actions attributed. Evidence under `evidence/` with an `a6-` prefix; driver hash verified at T0 and run end.
