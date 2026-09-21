# Pilot A7 — Preregistration (E16)

**Frozen:** 2026-09-21, before any model-driven run.
**Status:** Preregistered; Pilot A7 has NOT started. Execution begins only after this document is reviewed and merged, on the merge commit of its PR.

A7 changes exactly **one thing relative to A6's frozen configuration**: the pilot driver's seed — two enum values corrected to Stratum's own map schema (`projectType: 'python'` → `'custom'`; `taskStore type: 'sqlite'` → `'local'`), which changes the frozen driver hash. This is the **A6 postmortem's evidence-driven correction** (roadmap NEXT GATE): a mechanical control-plane fix, not a model, prompt, teaching, budget, or workflow-behavior change. The A6 experimental variable carries over unchanged.

## 1. Evidence basis — A6 outcome (the A6 postmortem)

A6 (execution revision `6f9e6c9…`, step-scoped `define-work/synthesize-definition` completion budget 32,768) produced the series' first successes and a new, precisely diagnosed terminal failure:

- **First successful synthesis:** `synthesize-definition` completed in 9 turns / 16 tool calls / 14 m 22 s (A5 died at turn 19 on the 16,384 budget). The single-variable delta demonstrably worked; the budget was not exhausted.
- **First accepted submission:** the 18,282-byte Definition passed the real `submit_result` channel **first-try with zero rejections** — the A3 contract-vocabulary failure class did not recur, and the E12 source/kind teaching is now empirically validated live.
- **First materialized canonical Definition with D.1 provenance:** `.sle/work/wi-define-108-a6/definition.md`, sha256 `b2166598…`, artifacts-table row with matching hash.
- **New failure class (terminal):** after node success, the engine's first-ever post-step map sync (`engine.ts:589` → `updateArtifactEntries` → `mapManager.update` → `RuntimeMapSchema.parse` of `.sle/map.yaml`) rejected the frozen driver's seeded values — Zod `invalid_enum_value` ×2: `project.type: "python"` (expected `api|ui|library|research|custom`), `task_store.type: "sqlite"` (expected `beads|local`). The adapter caught the ZodError → `adapter_exception` → WI failed at 11:33:32.389Z.
- **Root cause:** the driver's `seed` has written these two values since A2 via `dumpYaml(createInitialMap({...} as never))` — written with no schema validation. A2–A5 always died inside `synthesize-definition`, so the post-success map path never executed before A6. The mismatch predates A6 and is independent of the budget change.

**Implication (per the operator's A6 decision boundary):** the limiting factor at this gate is a control-plane seed/schema contract defect — not `define-work` model capability, which just completed synthesis within budget and passed validation first-try. The correction is therefore mechanical, not a model substitution.

## 2. The one correction — and its proof

`pilot-a-driver.ts` seed values only:

```diff
-      projectName: 'student-platform', projectType: 'python',
+      projectName: 'student-platform', projectType: 'custom',
...
-      taskStore: { type: 'sqlite' },
+      taskStore: { type: 'local' },
```

- **New frozen driver hash:** `718374b4f334be5655d2d6b41c606917a87a221b3bf3c044a3522171ddc3f693` (verified 2026-09-21; replaces `09bd01f6…`). No other byte of the driver changes; any further change = integrity failure.
- **Proof (completed 2026-09-21, throwaway — no pilot state touched):** the corrected seed's exact `createInitialMap` → `dumpYaml` → `RuntimeMapSchema.parse` round-trip passes: `custom | local | parse OK`. This is the exact parse that killed A6.
- Rationale for the chosen values: `custom` is the schema's honest catch-all for a multi-service repository (python services + mobile client); `local` is the schema's non-Beads task store. Neither activates behavior the pilot does not use.

## 3. Carried over unchanged from A6 (frozen)

| Item | Value |
| --- | --- |
| Experimental variable | `workflow_max_tokens: {"define-work/synthesize-definition": 32768}` — seeded as the logged mechanical pre-T0 action on the freshly seeded settings; global `max_tokens` stays 16384; every other step 16384 |
| Stratum A7 execution revision | The merge commit of this PR (delta vs `6f9e6c9…`: this preregistration + the tracking-doc work-pointer update; both docs-only) |
| Target / branch | `86ec0871d64ecca8732434c11d015fd8e08ddc7e`, `pilot-a/issue-108`, never merged |
| Issue | `magtheo/student-platform#108` (re-verify OPEN at Gate A) |
| Model / route | `z-ai/glm-5.3-flash` via OpenRouter, `OPENROUTER_API_KEY` — provider qualification carried from A6 (32,768 + tool wire accepted live, 2026-09-21); route/model unchanged, no re-qualification required |
| Limits | `MAX_AGENT_TURNS` 24 · `MAX_RESULT_REPAIRS` 1 · single `UND_ERR_HEADERS_TIMEOUT` retry · E12 teaching · `hard_ceiling` 4000 · minimal/5/halt · budgets 2/3/2 · 120-min clock |
| WorkItems / state | Fresh `wi-define-108-a7`; A6 `.sle` already archived (`evidence/pilot-a6-sle-archive.tgz`) and removed; fresh seed via the corrected driver |

## 4. Pre-T0 checks (Gate A)

1. Driver hash equals `718374b4…`; target at `86ec087…`; issue OPEN; A6 archive present.
2. Seed with the corrected driver; then the logged mechanical settings action (the `workflow_max_tokens` section).
3. **Safeguard 1 (effective budget, per operator):** the capturing-stub probe through the driver's exact `resolveLLMProvider` → 8-arg `buildAgentRunner` order must show wire budgets `[32768, 32768]` for `define-work/synthesize-definition` and `[16384, …]` for `definition-readiness-review`.
4. **Safeguard 2 (seed validity, A6's lesson):** the on-disk seeded `.sle/map.yaml` must pass `RuntimeMapSchema.parse` before T0.

## 5. Primary hypothesis and closeout rules

**H1 (unchanged):** fresh valid Definition → canonical materialization → `definitionSource` → `full-build`, no human translation. H2/H3 conditional on H1. A7 additionally expects the post-step map path to admit the artifact and let define-work proceed past synthesis (readiness review, refine, etc., at the global 16384).

Closeout rules (frozen, identical to A6):
- Valid submission → continue through Gate B and H1 normally.
- Exhausts 32,768 completion tokens in synthesis → **STOP**.
- Hits the 24-turn cap → **STOP**; no mid-run raise.
- `source`/`kind` rejection returns → preserve and **STOP** under the existing repair policy.
- Any new failure class → diagnosed independently, without attributing to prior classes.

## 6. Outcome classification and evidence

Successful / Diagnosed failure / Undiagnosable failure; positive sub-results preserved; operator actions attributed; evidence under `evidence/` with an `a7-` prefix; driver hash verified at T0 and run end.
