# D.34 — Output contracts implementation plan (ACTIVE)

**Status:** ACTIVE execution plan · **Created:** 2026-09-11
**Architecture authority:** [DDR-034 — Models propose; Stratum materializes](../decisions/ddr-034-models-propose-stratum-materializes.md) (FROZEN after merge of PR #2 — `841bf2c`)
**Empirical trigger:** [D.34-0 cross-run failure audit](d34-failure-audit.md) (COMPLETE)

Document hierarchy:

```text
DDR-034                  = decision / frozen architecture (edit only via new DDR)
d34-failure-audit.md     = empirical evidence (complete / historical)
d34-output-contracts.md  = implementation plan / evolves   ← THIS FILE
source + tests           = implementation truth
```

## Ground rules (from DDR-034 — restated, not re-argued)

- Zero meaningful `WorkflowEngine` change across the entire sequence; `git diff src/workflow/engine.ts` empty is the standing acceptance test.
- Contract identity exists exactly once: `WorkflowStep.outputArtifact.type → outputContracts[type]`. No `id` on `OutputContract`, no identity in `StepResult`.
- `StepResult` is a discriminated union (`'materialized' | 'proposal'`), never both.
- Zod `modelSchema` is the single structural authority; JSON Schema is a generated projection (pinned adapter); `schemaAnnotations.fields` keys are mechanically validated against the projection; Zod decode is always the runtime authority.
- Decode vs validate are distinct layers; `validateDefinition` is wrapped verbatim, never a zod refinement.
- Repair taxonomy: transport syntax defect → **format repair** (`MAX_FORMAT_REPAIRS = 1`, unchanged); typed proposal defect → **result repair** (`MAX_RESULT_REPAIRS = 1`, separate `result_repairs` counter, never a workflow iteration, exhaustion fails closed before write); semantic readiness gap → **workflow refine** (unchanged).
- Canonical on-disk artifact format is unchanged (`schemaVersion: 1`); parsers remain the load path.
- Non-contract roles are byte-for-byte untouched.

## Commit sequence

| # | Scope | Acceptance tests | Status |
|---|---|---|---|
| **C1** | Contract seam: `src/workflow/contracts.ts` (types, `ResultAcceptor`, `MAX_RESULT_REPAIRS`/`resultRepairDecision`, pinned schema-projection adapter); `StepResult` union; `outputContracts` registry + generic contract path + fail-closed authoring errors in AgentRunner; `ResultAcceptor` wired into both execution paths; `result_repairs` accounting; `TransportContext.resultSchemaText`/`resultSchemaJson`. **No real contract registered.** | (1) full existing suite green with no contract registered — zero behavior change; (2) compile-time union enforcement; (3) fake-transport contract-path tests: decode→validate→materialize→write, proposal-without-contract fails closed, contract-registered-but-materialized fails closed, acceptor inactive without contract; (4) result-repair: one repair on single-turn path, `result_repairs=1`, `iterationsUsed` unchanged; exhaustion fails closed before write, no provenance; (5) multi-turn continuation via fake multi-turn provider; (6) projection golden test | **NEXT** |
| C2 | Readiness codec: `ReadinessProposal`, zod schema, generated projection + goldens, `schemaAnnotations` + key-conformance test, `renderReadiness` (DDR-034 §10 invariants), contract with `reviewVerdict`/`deriveRoute` (calls existing `deriveReviewRoute`) | Golden-byte + round-trip (`render → parseReadinessArtifact → semantic equality`) + stability (`render∘decode∘render` identity) + projection-conformance green | pending |
| C3 | Readiness wiring: register contract at composition root; review steps on contract path (acceptor active); textual transport teaches generated projection for proposal steps; prompt slimming (verdict + serialization mechanics out of prompts) | define-work review runs textual end-to-end; route gate consumes typed gaps (parse-back deleted on this path); a decode-defect run demonstrates in-step result repair (`result_repairs=1`, `iterationsUsed` unchanged) | pending |
| C4 | Definition codec + wiring: `DefinitionProposal`, schema, `validateDefinition` wrapper (plain function), renderer, goldens; produce steps on contract path | As C2/C3, plus DECIDED-referral resolution via composition-root `findDecision` closure | pending |
| C5 | `submit_result` transport: tool channel on `completeMultiTurn` for produce steps; tool schema from `resultSchemaJson`; negotiation in `resolveResultTransport` extended; negotiated transport recorded in run metadata | Multi-turn produce with read tools + submission on OpenRouter and Anthropic paths; rejection continuation via `tool_result` | pending |
| C6 | `completeStructured` provider capability + review-step structured channel | Capability-probed; textual fallback intact everywhere | pending |
| C7 | Harness split: four-tier scoring in `scripts/eval-define-work.ts` (semantic / transport / convergence / deployment); persist failing artifacts + raw node-outputs for failed steps (audit finding F6) | Tier report emitted per run; SER/TRANSPORT failures auditable from artifacts | pending |

## Review boundaries

- **C1 is a hard review gate**: it must produce **zero behavior change when no output contracts are registered**. C2 starts only after C1 passes review.
- C3 and C4 each end with a live-prompt diff review (serialization teaching must leave the prompts; epistemic contract stays).
- After C3/C4 land, `d3a-definition-readiness-methodology.md` and `d3b1-define-work.md` receive only narrowly necessary factual updates (live path uses semantic proposals / system materialization; persisted format unchanged). They are otherwise closed history — do not rewrite.

## Frozen surfaces (must NOT change)

See DDR-034 §15. Highlights: `src/workflow/engine.ts`; canonical artifact format v1; D.3d.5 fail-closed machinery and diagnostics; path safety, role ceilings, append-only policy, provenance schema; route precedence + allowlist gate semantics; DDR-029 text/status; non-contract roles' wire behavior.

## Progress log

| Date | Commit | Note |
|---|---|---|
| 2026-09-11 | `841bf2c` | PR #2 merged: D.34-0 audit + DDR-034 (architecture frozen) |
| 2026-09-11 | *(this commit)* | D.34 execution plan established; roadmap/tracking pointers repaired |
