# Pilot A8 — Preregistration (E18): pure live continuation

**Frozen:** 2026-09-21, before any model-driven run.
**Status:** Preregistered; Pilot A8 has NOT started. Execution begins on the merge commit of this PR, under the operator's explicit authorization of 2026-09-21 (review of PR #32 + E17).

A8 changes **no experimental variable** relative to A7. It is the near-pure continuation the E17 phase prepared: every deterministic boundary up to full-build's first model request has already been exercised; A8 is the first pilot launched with that prior qualification.

## 1. Basis

- **A7 (closed):** define-work completed end-to-end (synthesis 19 turns, first-try accepted submission, readiness PASS, commit); DDR-041 resolution live-proven; terminal failure at the full-build context ceiling — a cross-component contract mismatch, fixed in PR #32 (authoritative-Definition lane: content measured against a 32,768-token lane derived from the resolver's 128 KiB byte contract; ordinary 4,000 focus ceiling unchanged).
- **E17 (closed, zero model calls):** deterministic audit of the downstream path on the real A7 fixture — lifecycle walked via supported services (dependency-creation surface added in PR #32), `resolvedParameters` freeze at dispatch verified, driver integrity defects fixed, and the full-build entry gate reached its first model request with production defaults.
- **A7 qualification caveat carried:** the H1 chain is NOT yet cleanly proven (A7 needed two operator lifecycle repairs). A8's fixed driver performs those steps itself; a clean A8 run is the required reproduction.

## 2. Frozen inputs

| Item | Value |
| --- | --- |
| Stratum A8 execution revision | The merge commit of this PR (delta vs `992a1ef…`: this document only) — includes PR #32 (context lane + dependency surface) |
| Pilot driver | `baa18ac7996113c305b39d206ebc995a37f00f9b9672b26c5d37d4801fc159fb` (E17-corrected: schema-validated seed; `executeWi` derives from its argument; driver-driven lifecycle completion) — any change = integrity failure |
| Target / branch / issue | `86ec0871…`, `pilot-a/issue-108`, #108 OPEN (re-verified at Gate A) |
| Model / route | `z-ai/glm-5.3-flash` via OpenRouter, `OPENROUTER_API_KEY` — unchanged |
| Budgets | global `max_tokens` 16384; the A6-established step-scoped override `workflow_max_tokens {"define-work/synthesize-definition": 32768}` seeded as the logged mechanical pre-T0 action — all other steps 16384 (incl. full-build's scoping.produce, which rides the ordinary 4,000 context ceiling + the Definition lane) |
| Limits | `MAX_AGENT_TURNS` 24 · `MAX_RESULT_REPAIRS` 1 · single `UND_ERR_HEADERS_TIMEOUT` retry · E12 teaching · `hard_ceiling` 4000 · minimal/5/halt · decision budgets 2/3/2 · 120-min clock |
| WorkItems / state | Fresh `wi-define-108-a8` (seed via the fixed driver); exec WI created post-run via `execute-wi` (defines `definitionSource` → the a8 define WI); A7 `.sle` archived (`pilot-a7-sle-archive.tgz`) and removed — no reuse of A7's Definition |

## 3. Gate A (all pre-T0, zero model calls)

1. Stratum revision, driver hash, target, issue, A7 archive present, fresh state.
2. Corrected seed parses: on-disk `.sle/map.yaml` passes `RuntimeMapSchema.parse` (driver journal `schema_validated: true`).
3. Effective budgets via the driver's exact construction order: synthesize-definition `[32768, …]`; readiness-review / refine-definition / full-build steps `[16384, …]`.
4. Lifecycle/dependency surface check: on a throwaway DB, `WorkService.createWorkItem` with a validated dependency edge + guarded lifecycle to `completed` (PR #32 surface).
5. Zero-cost full-build-entry replay: executed POST-define-work on the fresh A8 Definition (it cannot run earlier — no completed source WI exists pre-T0), immediately before `gate-b`.

## 4. Protocol and decision rules

`drive wi-define-108-a8` → (fixed driver auto-completes the WI via the guarded lifecycle) → zero-cost entry replay → `gate-b wi-define-108-a8` → `execute-wi wi-define-108-a8` → `drive wi-exec-108` (H2). The driver exits 3 on a pending decision (resolve per the frozen policy, logged, attributed).

- Define-work failure → preserve exactly; diagnose; STOP.
- H1 (Gate B PASS + full-build starts) → continue into H2/H3 without stopping; implementation quality and delivery evidence become the focus.
- Failure inside full-build → preserve exactly (valuable progress past the Definition frontier); diagnose independently.
- Any new failure class → diagnosed independently, never attributed to prior classes.

## 5. Outcome classification

Successful / Diagnosed failure / Undiagnosable; positive sub-results preserved; operator actions attributed; evidence under `evidence/` with an `a8-` prefix; driver hash verified at T0 and run end.
