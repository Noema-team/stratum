// D.3b1.1 — Stratum-owned, self-contained runtime methodology for the
// define-work workflow (D.3a's Definition/readiness contract, reduced to
// exactly what an executing agent needs to draft, refine, and review a
// Definition Artifact).
//
// This module exists because define-work's steps run with `projectRoot` set
// to the TARGET repository being worked on (e.g. Evershift), not Stratum's
// own repository — a step instruction that told the agent to go read
// `docs/developmentPlan/d3a-definition-readiness-methodology.md` would be
// pointing at a path that only exists in Stratum's own source tree. That is
// especially unsafe for definition-readiness-review, which is deliberately
// forced onto AgentRunner's single-turn path (see agent-runner.ts) and so
// cannot use a repository-read tool to compensate for a missing doc.
//
// These constants are composed directly into define-work's `instruction`
// strings (see ../builtins/define-work.ts) instead. `templateId` stays
// deliberately inert (see WorkflowStep.templateId) — this is plain string
// composition into the existing `instruction` declarative channel, not a
// new resolution mechanism. `docs/developmentPlan/d3a-definition-readiness-
// methodology.md` remains the authoritative, human-readable design record;
// it is no longer a runtime dependency of any workflow.

// ─── Fact ledger + Definition content shape (D.3a §1) ─────────────────────────

export const DEFINITION_CONTRACT = `A Definition has these sections (all optional except goal):
- goal: the single outcome being defined — one concrete statement, not a category.
- constraints: boundaries the work must respect ({ description, type: must | must_not | prefer | prefer_not }).
- requirements: concrete behavioral expectations the goal implies.
- nonGoals: what this Definition explicitly excludes (the boundary counterpart to constraints).
- design: current design thinking, if any — may be empty.
- risks: named risks.
- acceptanceModel: criteria sufficient to know the work is done ({ description, met }).
- facts: the fact ledger below — the actual unit gaps are tracked against.

Fact ledger rules:
- Every fact relevant to the goal is one entry { id, statement, status, source } in the ledger.
  Epistemic status exists exactly once, in the ledger — never duplicated as a property of a
  requirement, constraint, or risk entry; those may reference a fact by id, no more.
- status is exactly one of:
  - KNOWN — verified, backed by something checkable (repository content, an artifact, an
    existing test, an authoritative human statement). Not a belief; a fact.
  - ASSUMED — a working belief adopted so drafting can proceed, explicitly not verified. Every
    ASSUMED fact is a candidate for the readiness rubric's risky-assumptions check.
  - UNKNOWN — an acknowledged gap with no answer and no working assumption.
  - DECIDED — was UNKNOWN or ASSUMED, escalated as a HUMAN_DECISION gap, resolved by a recorded
    Decision. Carries a reference to that Decision; source becomes 'decision'.
  - DEFERRED — a real, acknowledged gap explicitly not required to be resolved for the
    candidate bounded scope currently being defined. This is what lets a Definition be ready
    for a narrow scope while still carrying open facts about the wider Objective.
- source records where the fact came from: human, repository, artifact, investigation, or
  decision. A human's stated product requirement can be KNOWN (source: human) with no code
  read at all. A human's *assertion about repository reality* is not automatically an observed
  fact — it starts ASSUMED, source: human, until something with source: repository or
  source: investigation actually confirms it. Mark a fact KNOWN with source: repository only
  after actually inspecting the relevant file(s) with an available repository-read tool, never
  because it seems probably true.`;

// ─── Readiness rubric (D.3a §2) ────────────────────────────────────────────────

export const READINESS_RUBRIC = `Evaluate the current Definition against these seven dimensions, each scoped to the
candidate bounded scope this Definition defines — not the entire Objective:
1. Outcome — is goal a single, concrete statement? Could a reader tell whether the eventual
   work satisfies it?
2. Boundary — does nonGoals meaningfully exclude adjacent scope, so the bounded scope has an
   actual edge?
3. Critical constraints — are the must/must_not constraints that would change the shape of the
   work captured (not an exhaustive list of every constraint imaginable)?
4. Consistency — do requirements, constraints, and nonGoals contradict each other or goal?
5. Risky assumptions — among ASSUMED facts, are there any whose falsity would invalidate goal
   or a critical (must/must_not) constraint? Not every assumption is risky.
6. Acceptance — does acceptanceModel contain at least one criterion sufficient to know when the
   authorized work is done?
7. Remaining unknowns — among UNKNOWN facts, are there any that block the candidate bounded
   scope (as opposed to ones that are real but irrelevant to this particular scope)?

Readiness = pass on all seven for the current version. A failing dimension points at one or
more specific facts (or a missing fact) in the ledger — name exactly which dimensions pass or
fail and why, and name every remaining blocker.`;

// ─── Gap classification (D.3a §3) ──────────────────────────────────────────────
//
// D.3b1(.1) implements CAN_RESOLVE resolution only — HUMAN_DECISION/DEFER/
// EXPLORE_AS_WORK gaps are named but stay unresolved blockers (no checkpoint,
// no investigation WorkItem creation, no DEFERRED-marking automation yet).
// D.3c wires those three; this scope is intentionally narrower.

export const GAP_CLASSIFICATION = `Every readiness failure resolves to a specific fact (or a gap where no entry yet
exists), classified into exactly one bucket:
- CAN_RESOLVE — closeable without a human decision or exploratory work: an omitted non-goal
  obvious from the stated goal, a missing acceptance criterion for an already-stated
  requirement, a direct contradiction to fix, or information that already exists elsewhere in
  the repository and just hasn't been pulled into this Definition yet.
- HUMAN_DECISION — the gap is a choice only a human can authorize: product tradeoffs, risk
  acceptance, prioritization among competing constraints, anything costly or irreversible to
  get wrong. Never guessed by an agent, never silently downgraded to ASSUMED.
- DEFER — the gap is real but does not block the bounded scope being authorized now.
- EXPLORE_AS_WORK — the gap can't be closed by reading or reasoning; answering it requires
  doing something (building or measuring) to get an answer.

The dividing line between CAN_RESOLVE and EXPLORE_AS_WORK is cost and kind, not topic or
importance: reading existing code, tests, or docs to answer a factual question — however
consequential — is CAN_RESOLVE. EXPLORE_AS_WORK is reserved for uncertainty whose resolution is
itself substantive bounded work. Cheap/direct discovery is never EXPLORE_AS_WORK.

This phase resolves CAN_RESOLVE gaps only, inline, in the current Definition round: mark the
fact KNOWN (source: repository or human, as appropriate) and update the relevant Definition
section. Do not resolve or guess at a gap that is HUMAN_DECISION, DEFER, or EXPLORE_AS_WORK —
leave those explicitly as unresolved blockers in the fact ledger (ASSUMED/UNKNOWN, not
force-resolved) rather than fabricating an answer, a deferral, or a decision no human made.
Never promote a repository assertion to KNOWN merely because it seems likely — only an actual
inspection does that.`;
