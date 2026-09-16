# DDR-036: Escalation Ownership — Deterministic Identity and Provenance for the Escalation Subworkflow

**Status:** accepted (2026-09-16)
**Extends:** DDR-034 (models propose; Stratum materializes)
**Trigger:** E4-A/E4-B qualification evidence (see `eval-reports/E4B-review.md`, `E4A-review.md`)

## Decision

One sentence:

> **Escalation identity and provenance are Stratum-owned; models classify gaps
> and propose semantic consequences, but never reconstruct, copy, invent, or
> serialize control-plane identity.**

DDR-034 completed deterministic ownership for the Definition/Readiness
boundary (`definition`, `definition-readiness` contracts). E4 exposed the
next incomplete boundary: the EARLY escalation subworkflow still crossed
model-authored, identity-lossy seams. This DDR is the evidence-triggered
completion of the SAME principle — not a competing architecture.

## Evidence (E4, production-parity wire, revision abbb09f)

- **Claude Sonnet 5, 10/15:** every EARLY failure involved escalation
  bookkeeping — the final Definition not referencing the resolved Decision's
  real id (4/4 failed runs), exploration-need artifact missing/unprovenanced
  (3/4), refine-ordering violations (2/4). PARTIAL was 5/5 — the core
  definition work was fine.
- **GPT-5.6 Luna, 0/15:** uniform `DECISION_REF_STRAY` — decorated every
  fact with `decisionRef`, non-compliant even under verbatim rejection.
- **Structural confirmation (pre-patch):** `DecisionRequest` carried only
  `{type, title, summary, options[]}` — no fact identity at all; readiness
  gap `target` was free-form prose never validated against the Definition's
  fact ids; `prepare-human-decision` and `record-exploration-need` ran the
  legacy path (no registered output contract).

The chain the model was asked to hold:

```text
typed fact id → prose gap target → prose request summary
  → human decision → model reconstructs the fact → model copies decisionRef
```

Two prose hops and one copy — exactly what "models propose; Stratum
materializes" forbids.

## Ownership boundaries

| Model owns                                  | Stratum owns                                 |
| ------------------------------------------- | -------------------------------------------- |
| Gap classification                          | Gap identity validation (`factId` linkage)   |
| Human-facing `target` prose                 | `factId` ↔ fact-ledger reference             |
| WHICH gap to escalate (selects `targetFactId`) | Validation that the selection is a current gap of that class |
| Decision options and explanation            | Resolved Decision ID, selected option identity |
| Semantic consequence of the selected option | `DECIDED`, `source: decision`, `decisionRef` injection |
| Whether exploration is necessary            | Link to the originating fact                 |
| Exploration question/work/evidence          | Canonical exploration artifact               |
| Definition semantic revisions (statement, sections, body) | The fact ledger's mechanical transition, serialization, provenance, merge |

## Design

1. **Readiness gaps gain machine identity.** Gap schema gains optional
   `factId`. Cross-field rule (validated, never schema-projected):

   | Classification    | `factId`     |
   | ----------------- | ------------ |
   | `CAN_RESOLVE`     | optional (a missing ledger entry is itself a CAN_RESOLVE defect) |
   | `DEFER`           | **required** |
   | `HUMAN_DECISION`  | **required** |
   | `EXPLORE_AS_WORK` | **required** |

   When present, `factId` must reference an existing fact in the current
   Definition. Goal-level questions become ledger facts first (one
   legitimate CAN_RESOLVE round) — every side-effectful route acts on stable
   canonical identity; no second provenance mechanism for "goal-level
   decisions" exists or is needed (DECIDED is defined as a fact transition).

2. **`decision-request` contract.** Model proposes semantics
   (`type/title/summary/options`) plus its SELECTION of `targetFactId`;
   Stratum validates the selection against the current readiness's
   HUMAN_DECISION gaps (reusing `parseDecisionRequest`'s structural rules)
   and always materializes `targetFactId` into the artifact.

3. **`decision-application` contract.** The proposal contains NO identity
   fields — `targetFactId`, `status`, `source`, `decisionRef` are not
   model-authoable (strict schema). The proposal carries only semantic
   consequence: optional revised fact statement, optional full-section
   replacements (requirements/constraints/nonGoals/acceptance), body.
   The AUTHORITATIVE target is the one bound into the durable Decision
   authority at creation time: the Scheduler captures the validated
   request's `targetFactId` into `Decision.subjectRef`, ResumeService
   threads it through `DecisionContext`, and application uses that frozen
   value while CROSS-CHECKING the (mutable) request artifact — a request
   that changed after the checkpoint fails closed even when the substituted
   target is itself valid. A Decision predating the binding likewise fails
   closed rather than inferring the target from the request alone. The
   materializer merges deterministically:

   ```text
   current canonical Definition (trusted input artifact)
   + DecisionApplicationProposal (semantics)
   + targetFactId (trusted, from the persisted decision-request)
   + resolved Decision (trusted, DecisionContext: id, selectedOption, rationale)
     ↓
   target fact := DECIDED / source: decision / decisionRef := Decision.id
   (all other facts carried over verbatim — the model cannot touch them)
     ↓
   existing validateDefinition (verbatim) → existing renderDefinition
   ```

4. **`exploration-need` contract.** Model proposes
   `{targetFactId (selection), question, whyNotResolvableByReading,
   requiredWork, completionEvidence}`; Stratum validates the selection
   against the current EXPLORE_AS_WORK gaps and materializes the canonical
   artifact (versioned front matter + human-readable body — not opaque
   JSON). "Cannot silently finish without the artifact" needs no new
   mechanism: AgentRunner's declared-output invariant + `commit`'s position
   already enforce it; a workflow-level regression pins the composition.

5. **Trusted context.** `OutputContractContext` gains exactly two
   already-resolved, trusted inputs: the step's declared input artifact
   contents (path → text, read by the runner) and the resolved
   `DecisionContext`. Contracts never touch the filesystem, network, clock,
   or repositories.

## Compatibility — load old, never infer authority

- Persisted formats evolve additively (`factId` on readiness gaps,
  `targetFactId` on decision-request JSON). Old artifacts parse as
  legacy/unlinked.
- **Tolerant loading never means guessing:** a legacy decision-request
  without `targetFactId` reaching deterministic decision application fails
  explicitly as legacy/unlinked — never reconstruct the fact from
  title/summary prose.
- Legacy free-form exploration markdown remains readable on the load/audit
  path (flagged legacy).

## Explicit exclusions (evidence-before-architecture)

- No `WorkflowEngine` change; no generic postcondition seam (the runner's
  declared-output invariant suffices — pinned by regression).
- No DEFER-transition redesign (apply-deferred-gaps unchanged; E4 produced
  no DEFER evidence).
- No turn-cap/over-investigation changes (isolated separately after E4-C if
  it persists).
- No generic patch/mutation language — `decision-application` is specific to
  this methodology and reuses the Definition validator/renderer.
- No new models, no Pilot A, until E4-C re-qualifies Sonnet on this patch.

## Qualification gate

E4-C (fresh clone, frozen): Sonnet 5 only, same matrix, only intentional
variable = this slice. **15/15 → qualified → Pilot A.** Residual
turn-cap-only failures isolate the next problem cleanly.
