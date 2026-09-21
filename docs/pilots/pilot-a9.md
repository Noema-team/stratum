# Pilot A9 — Clean Frozen H1 Transition + Deeper Full-Build

**Status:** preregistered 2026-09-21, before execution.
**Classification:** pure frozen rerun — **no new experimental variable**. The only delta from A8 is deterministic: PR #34 (E19) qualifies the scoping publication seam A8 exposed, using machinery that already existed (D.1b declared outputs).

## What A9 must prove

1. **The pristine H1 transition** that A8 could not claim: `execute-wi` → Gate B → `drive wi-exec-108` with **ZERO operator repairs** and ZERO mid-run driver changes. A8's DDR-041 result stands, but its transition required a logged driver correction + DB repair; A9 must reproduce the chain clean.
2. **Scoping publication works live**: the model's charter materializes at `docs/cycle-charter.md` via the declared output artifact, passes begin()-time structural validation, reaches the checkpoint, and approve() flows to **DESIGN** — the first time any pilot reaches DESIGN.
3. **Continue deeper** while the run allows (per the standing decision rule): design → plan → test → build. The operator's pivot criterion: **if BUILD executes real implementation, integration hardening stops and H2 (implementation quality) evaluation begins** — that judgment, not seam-connecting, is the actual product question.

## Freeze

| Item | Value |
| --- | --- |
| Execution revision | `37c3acda6e8e248965ed88c2e2e1cc32c6c64298` (post-PR-#34 `main`) |
| Driver | SHA-256 `d9d699c2c4b5ff52a09e4aa23fd31eddd0f311533b3edba4a5dda62671ac6db9` (verified pre-execution and post-run; **no mid-run edits permitted** — an A8-class latent patch failure must instead halt the run as a preserved failure) |
| Target repo | magtheo/student-platform @ `86ec0871…`, branch `pilot-a/issue-108` (never merged) |
| Issue | #108 — rag-worker → rag-api failure payload contract mismatch |
| Budgets | `define-work/synthesize-definition` 32,768; all other steps 16,384; ordinary focus ceiling 4,000; authoritative lane 32,768 (PR #32) |
| Protocol | 120-min clock, MAX_AGENT_TURNS 24, MAX_RESULT_REPAIRS 1, single `UND_ERR_HEADERS_TIMEOUT` retry, E12 teaching, minimal/5/halt, decisions 2/3/2 (checkpoint approve per A8 rationale pattern), tokens not persisted |
| Model | z-ai/glm-5.3-flash via OpenRouter (unchanged) |

## Gate A checklist (all must pass before T0)

1. Worktree detached at `37c3acd`.
2. Driver hash == `d9d699c2…`.
3. Target @ `86ec087`, branch `pilot-a/issue-108`, issue #108 OPEN.
4. A8 evidence archive present; fresh `.sle` (archive-then-remove).
5. Seed map schema-validates (`project.type: 'custom'`, `task_store.type: 'local'`).
6. Settings carry the step-scoped budget override; probe: synthesize `[32768,32768]`, readiness-review/refine/full-build/scoping.produce/build `[16384,16384]`; probe artifacts removed, 0 workflow runs.
7. **E19 contract present**: `FULL_BUILD.scoping.produce.outputArtifact` == `{type: 'cycle-charter', ref: 'doc:cycle-charter', path: 'docs/cycle-charter.md'}` (deterministic source check); scoping prompt teaches `## Scope` grammar.
8. Lifecycle + dependency surface intact (throwaway-DB `WorkService.createWorkItem` with `dependencies`).
9. Node 22 active; OpenRouter key resolvable.

## Decision rules (frozen before execution)

- **Define-work failure** → preserve exactly, diagnose, STOP (standing rule; define-work is frozen territory).
- **H1 reached** → continue into full-build without stopping.
- **Scoping publication failure** (charter path/validation — now deterministic fail-closed) → preserve exactly; this would falsify E19's live assumption and STOP for diagnosis.
- **Failure deeper (design/plan/test/build)** → preserve exactly, diagnose, classify: integration seam → next zero-model E-phase, one seam only; model/product behavior → **stop hardening, begin H2 evaluation**.
- **Any operator repair temptation** (DB fix, driver edit, state mutation): NOT permitted in A9. If the transition cannot complete without one, the run is preserved, the caveat is logged, and the rerun decision goes to the operator. This is the entire point of A9.
- Entry replay (stub provider) before/after define-work is zero-cost and permitted; its residue is logged, never repaired.

## Evidence plan

`gate-a-a9.md` · `gate-b-a9.md` · `a9-outcome.md` · charter(s) · manifests/loop JSONs · drive consoles · `pilot-a9-sle-archive.tgz` · driver hash re-verification. Per-run records land in `~/Documents/repos/pilot-a/evidence/`.
