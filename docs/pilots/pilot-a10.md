# Pilot A10 — Downstream-Isolated Full-Build Capability Pilot

**Status:** preregistered 2026-09-21, before execution.
**Classification:** downstream capability isolation — **explicitly NOT an end-to-end H1 rerun**. Fresh Definition synthesis and pristine integrated H1 reproduction are intentionally held out (Track B, later). A10 tests downstream execution given an already-validated canonical Definition.

## Rationale (recorded before execution)

A9 closed the question "is define-work a seam problem?" — it is not. It is **capable but not reliably convergent** under the frozen 24-turn protocol (3 successes / 1 circling exhaustion; A9's failure signature was non-converging looping, distinct from A4's thoroughness). That is a known limitation, frozen as-is. The highest-value unknown is: **can Stratum take a good Definition and produce a correct software change?** Every downstream experiment that pays the define-work lottery first is bad experimental design.

## Project state (recorded precisely — no history rewriting)

```text
DEFINE-WORK                capability: demonstrated (A6/A7/A8)
                           reliability: NOT qualified / stochastic (A4, A9)
DDR-041 AUTHORITY HANDOFF  mechanism: live-proven (A8)
                           pristine integrated reproduction: PENDING
FULL-BUILD                 scoping model execution: demonstrated (A8)
                           scoping publication seam: deterministically repaired (PR #34)
                           design/plan/test/build: NOT YET EXERCISED on this pilot
H2 — correct code          UNKNOWN
H3 — trustworthy delivery  UNKNOWN
```

Mechanistic H1/DDR-041 is live-proven. **Pristine zero-intervention end-to-end H1 is NOT claimed.**

## Freeze

| Item | Value |
| --- | --- |
| Authority | **The exact A8 canonical Definition** — 16,141 bytes, SHA-256 `71f1c39c97ecea575b1195b63de510fa403dad4fecaa1df0c774d04fae89cac5`, transplanted byte-for-byte from the A8 archive (no summarization, no rewriting, no "improvement"). Readiness artifact `b5a96b17…` transplanted with it. Source WorkItem `wi-define-108-a8` (completed), artifact provenance rows and the historical define-work run row transplanted verbatim. |
| Source provenance | A8 run `23a3141f-2f93-49f5-99e7-02c59b346723` (define-work, complete at commit) |
| Target repo | magtheo/student-platform @ `86ec0871…`, branch `pilot-a/issue-108` (never merged) |
| Issue | #108 — rag-worker → rag-api failure payload contract mismatch |
| Execution revision | `37c3acda6e8e248965ed88c2e2e1cc32c6c64298` (post-PR-#34 main) |
| Driver | SHA-256 `0ffea302eb1464230f29958d80b1c7c66322e82b7a0184345cf3943bfbd0748c` (adds the deterministic `instantiate` fixture command; verified pre/post; **no mid-run edits permitted** — a needed edit halts the run as a preserved failure) |
| Model/route | z-ai/glm-5.3-flash via OpenRouter (unchanged) |
| Budgets | ordinary focus ceiling 4,000; authoritative lane 32,768; all full-build steps 16,384; `define-work/synthesize-definition` 32,768 on disk (inert in A10 — no synthesis) |
| Planning depth | minimal, max_iterations 5, on_cap_hit halt (frozen in `wi-exec-108.workflowParameters`) |
| Repair limits | MAX_RESULT_REPAIRS 1, single `UND_ERR_HEADERS_TIMEOUT` retry (production defaults) |
| Review policy | production review steps as declared in FULL_BUILD (critique skipped at minimal depth; validation_gate on_fail → debug with iteration increment); decisions 2/3/2 — scoping checkpoint `approve` per the A8 rationale pattern; confirm checkpoint `approve` if the plan matches the Definition's bounded scope, otherwise halt and preserve |
| Protocol | decisions logged with rationale attributed to operator; tokens not persisted; activity counts authoritative |

## Starting state (deterministic fixture, zero model calls)

Built by `pilot-a-driver.ts instantiate` + `execute-wi` on a **wiped, re-seeded `.sle`**:

- exactly 2 WorkItems: `wi-define-108-a8` **completed** (the authority), `wi-exec-108` **ready** with `definitionSource: {workItemId: 'wi-define-108-a8'}`, `dependencies: [wi-define-108-a8]`, frozen workflowParameters;
- exactly 2 artifact rows (definition + definition-readiness) hash-pinned to the transplanted bytes;
- exactly 1 workflow run row (the historical A8 define-work run, complete);
- fresh map.yaml (schema-validated), settings with the (inert) step-scoped budget override.

## Gate A (all deterministic, ZERO model calls — T0 is the FIRST real full-build model invocation)

1. Resolver selects the INTENDED Definition: `resolveDefinitionSource` from `wi-exec-108`'s frozen `definitionSource` resolves to `wi-define-108-a8`'s artifact.
2. Hash matches the preregistered pin (`71f1c39c…`).
3. Definition bytes verified byte-identical to the A8 evidence copy (`evidence/a8-definition-materialized.md`).
4. Two-lane context assembles: verbatim Definition in-payload, ordinary components within the 4,000 ceiling (gate-b probe).
5. E19 scoping output contract present at this revision (`CYCLE_CHARTER_OUTPUT` on `FULL_BUILD.scoping.produce`; exact `## Scope` grammar in the prompt).
6. Scoping publication reaches approval deterministically: `tests/e19-scoping-publication.test.ts` green at this revision (canonical charter → materialize → validate → approve).
7. Provider resolution journaled, zero model invocations in the entire fixture + Gate A sequence.
8. Driver hash == `0ffea302…`; node 22; key resolvable.

## Decision rules (frozen before execution)

- **T0 = first real full-build model invocation** (`drive wi-exec-108`). From there:
- **Scoping publication failure** (charter path/heading — now fail-closed by E19) → preserve exactly; falsifies E19's live assumption; STOP for diagnosis.
- **Checkpoint resolution** → per the frozen review policy above (2/3/2 budget).
- **Failure at design/plan/test/build** → preserve exactly; classify: deterministic integration seam → ONE zero-model E-phase qualifying exactly that seam, then rerun (standing loop, unchanged); **model/product behavior (bad code, wrong contract understanding, hallucinated APIs, non-convergence) → DO NOT harden Stratum — that IS the H2 result; record and evaluate it.**
- **BUILD executes** → the pivot threshold: stop seam-hardening; the question becomes "did it write the right code?" (H2), then delivery (H3).
- **No repairs of any kind** (DB, driver, state) during the run; residue (e.g. entry-replay artifacts, if run) is logged, never mutated.
- H2 judgment criteria (for the record, applied only if BUILD completes): the change must make the right cross-service contract change (worker persists `error_message` + `stage` aligned with rag-api's shape), touch only the scoped surface, and produce tests that protect the behavior.

## Evidence plan

`gate-a-a10.md` · `gate-b-a10.md` · `a10-outcome.md` · charter · per-step artifacts/loops/manifests · drive consoles · `pilot-a10-sle-archive.tgz` · driver hash re-verification.
