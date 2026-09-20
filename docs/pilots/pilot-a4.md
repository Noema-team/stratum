# Pilot A4 — Preregistration (E12)

**Frozen:** 2026-09-20, before any model-driven run.
**Status:** Preregistered; Pilot A4 has NOT started. Execution begins only after this document is reviewed and merged, on the merge commit of its PR.

A4 reruns the A3 workflow with exactly **one** deliberate delta: the generated Definition schema **teaching** now explicitly disambiguates `facts[].kind` from `facts[].source` — the field-vocabulary collision that killed A3's near-valid submission.

## 1. Evidence basis (zero-model review, preserved)

`evidence/e12-a4-freeze-review.md`: both A3 rejections named the identical single defect
(`facts.13.kind: 'artifact'`); re-validating the stored 15,550-byte resubmission against
`DEFINITION_PROPOSAL_SCHEMA` yields exactly ONE zod issue — omitting `kind` (legal, and
already used correctly on three other facts) makes the ENTIRE payload valid; the model
wrote `source='artifact', kind='artifact'` on the DEFERRED fact; the teaching already
stated the enum and optionality but never said the two vocabularies are disjoint.

## 2. The one delta

Annotation text only, in `createDefinitionOutputContract`:
- `/facts/items/kind`: the two values are the ONLY kinds ever; `'artifact'` is a source, never a kind; when neither classification fits, OMIT kind (deferral is expressed via status, never by inventing a kind); the repository-claim/KNOWN mechanical rule unchanged.
- `/facts/items/source`: `'artifact'` is a source value ONLY — never a fact kind.

**Unchanged, verified by regression:** the zod schema (still rejects `kind:'artifact'`, still allows omission), the golden-pinned projection (annotation text cannot leak into the wire schema — tool `input_schema` remains byte-identical to `toJsonSchema(DEFINITION_PROPOSAL_SCHEMA)`), the validator, the materializer, and the teaching remains single-source (rendered from the same contract's annotations). No new semantics, no silent normalization of rejected values.

## 3. Explicitly unchanged from A3

`MAX_RESULT_REPAIRS` stays **1** — deliberately: raising it alongside the prompt change would confound A4's result. Deferred to a later experiment if A4 still shows repair-capacity problems. Also unchanged: model `z-ai/glm-5.3-flash` via OpenRouter (`OPENROUTER_API_KEY`, base_url https://openrouter.ai/api/v1, max_tokens 16384); `MAX_AGENT_TURNS` 24; single `UND_ERR_HEADERS_TIMEOUT` retry (define-work scoped); `hard_ceiling` 4000; `planning_depth` minimal / `max_iterations` 5 / `on_cap_hit` halt; 120-min end-to-end clock; 2/3/2 budgets; zero mid-run frozen-field changes; target `86ec0871…` (branch `pilot-a/issue-108`, never merged); no in-path independent model reviewer; publication through existing mechanisms only; PR never merged by the experiment.

## 4. Frozen inputs

| Item | Value |
| --- | --- |
| Stratum A4 execution revision | The merge commit of this PR — delta vs A3's `ab92129…`: the teaching annotation change + its regressions + this document |
| Target | `86ec0871d64ecca8732434c11d015fd8e08ddc7e` (drift to `ef07145…` recorded in pilot-a3.md §3; newer main remains separate verification) |
| Issue | `magtheo/student-platform#108` (re-verify OPEN at Gate A) |
| Pilot driver | sha256 `09bd01f68a9637ae47b2364c1ace6c4837102688cecd7ae94b9a04a635f42654` — unchanged from A3 (verified 2026-09-20); any post-T0 change = integrity failure; WI ids are driver arguments (`wi-define-108-a4`), exec WI via logged mechanical seeding |

## 5. Procedure and hypotheses

Same staged gates (A: zero-model checks incl. OpenRouter probe; B: real Definition — resolver, provenance/hash, `hard_ceiling` probe, no truncation; C: natural halt/resume identity, else NOT EXERCISED). Same fresh-state rule (A3 `.sle` archived, new WI ids, no prior Definition as input).

- **Primary — H1:** a fresh, contract-valid Definition is produced, materialized, and passes through `definitionSource` into `full-build` (DDR-041) without human translation. H2 and H3 follow only if H1 succeeds.
- **Observation (not proof):** A3's clean transport on the combined OpenRouter/retry configuration is a positive observation; the timeout problem is not assumed permanently resolved.

Honest-evaluation rule (carried from A3's review): reaching a mechanically valid proposal is not semantic acceptance, and materialization is not implementation correctness — H2's cross-service implementation and tests are judged on the actual code produced.

## 6. Outcome classification

Successful / Diagnosed failure / Undiagnosable failure, positive sub-results preserved. If A4 again dies on the same field despite the disambiguated teaching, that is precise evidence for the repair-budget lever (then isolated in its own experiment). Evidence under `evidence/` with an `a4-` prefix; driver hash verified at T0 and run end.
