// Stratum-owned, self-contained runtime methodology for the define-work
// workflow (D.3a's Definition/readiness contract, reduced to exactly what
// an executing agent needs to draft, refine, and review a Definition
// Artifact). Originated in D.3b1.1 with CAN_RESOLVE-only resolution; D.3c1b
// added the DEFER/HUMAN_DECISION/EXPLORE_AS_WORK route contracts below, so
// this module now backs every step in builtins/define-work.ts, not just
// synthesize/refine/review.
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
// All four classifications now have a dedicated resolution path wired in
// builtins/define-work.ts (D.3c1b): CAN_RESOLVE through the existing
// iterating refine-definition loop, DEFER/HUMAN_DECISION/EXPLORE_AS_WORK
// through their own dedicated, non-iterating steps.

// D.3c1b — the fixed precedence order among the four gap classifications:
// cheap/direct/autonomous closure happens before human escalation or
// substantive exploration. Exported (not just embedded in prose) so both
// READINESS_ROUTE_CONTRACT below and tests can lock this exact order —
// WorkflowEngine itself carries none of this; it is pure methodology data.
export const GAP_CLASSIFICATION_PRECEDENCE = ['CAN_RESOLVE', 'DEFER', 'HUMAN_DECISION', 'EXPLORE_AS_WORK'] as const;

export type GapClassification = (typeof GAP_CLASSIFICATION_PRECEDENCE)[number];

// Maps each D.3c1b route token (the allowlisted keys of define-work's
// on_fail_routes — see builtins/define-work.ts) to the classification it
// exists to resolve. Never consulted by WorkflowEngine or AgentRunner —
// those validate a route token only against the step's own declared
// on_fail_routes keys; this mapping exists purely so the prompt text below
// can name the right route for each classification, in one place.
const ROUTE_TOKEN_FOR_CLASSIFICATION: Record<GapClassification, string> = {
  CAN_RESOLVE: 'refine',
  DEFER: 'defer',
  HUMAN_DECISION: 'human',
  EXPLORE_AS_WORK: 'explore',
};

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
itself substantive bounded work. Cheap/direct discovery is never EXPLORE_AS_WORK.`;

// D.3c1b — refine-definition's own scope (previously the whole of what this
// phase did, back when HUMAN_DECISION/DEFER/EXPLORE_AS_WORK gaps had no
// dedicated resolution path of their own — see the four dedicated paths
// wired in builtins/define-work.ts now). refine-definition still resolves
// CAN_RESOLVE gaps only, inline, in the current Definition round; every
// other classification has its own step and must never be guessed,
// dropped, or force-resolved here.
export const REFINE_DEFINITION_SCOPE = `Resolve CAN_RESOLVE gaps only, inline, in this Definition round: mark the fact KNOWN
(source: repository or human, as appropriate) and update the relevant Definition section. Do
not resolve or guess at a gap that is HUMAN_DECISION, DEFER, or EXPLORE_AS_WORK — leave those
facts exactly as the prior readiness review found them (ASSUMED/UNKNOWN, not force-resolved,
not silently dropped from the fact ledger) for their own dedicated step to handle. Never promote
a repository assertion to KNOWN merely because it seems likely — only an actual inspection does
that.`;

// D.3c1b — the definition-readiness-review output contract: the readiness
// Artifact stays the authoritative record of why the Definition is or is
// not ready, and the preamble's `route: <token>` (agent-runner.ts) is only
// the machine control token WorkflowEngine maps through the review step's
// own on_fail_routes (engine.ts) — never a substitute for the reasoning,
// which belongs in the Artifact body. `routes` names exactly the tokens
// THIS review step declares (its on_fail_routes keys) — a review step must
// never be told about a route it cannot actually take; see
// builtins/define-work.ts, where definition-readiness-review declares all
// four and the post-defer/post-human reviews declare a narrower subset.
//
// D.3c1b.1 — DEFER is NOT blocking (see GAP_CLASSIFICATION above: "the gap
// is real but does not block the bounded scope"). What keeps a verdict from
// `pass` is either (a) a genuinely blocking gap — CAN_RESOLVE, HUMAN_DECISION,
// or EXPLORE_AS_WORK — or (b) an actionable-but-non-blocking DEFER gap: a
// fact determined irrelevant to the candidate bounded scope but not yet
// explicitly recorded as DEFERRED in the ledger. The `defer` route means
// "at least one gap has been classified DEFER and still needs its explicit
// DEFERRED ledger transition" — never "a DEFER gap blocks this scope". The
// wording below must never collapse that distinction, or a model can
// reasonably (and wrongly) treat DEFER as just another kind of blocker to
// avoid routing.
function classificationLine(c: GapClassification): string {
  const token = ROUTE_TOKEN_FOR_CLASSIFICATION[c];
  if (c === 'DEFER') {
    return `- ${token} — at least one gap has been classified DEFER and still needs its explicit ` +
      'DEFERRED ledger transition (the gap itself does not block the candidate bounded scope — ' +
      'see apply-deferred-gaps).';
  }
  return `- ${token} — at least one ${c} gap blocks the candidate bounded scope.`;
}

export function READINESS_ROUTE_CONTRACT(routes: readonly GapClassification[]): string {
  const routeLines = routes.map(classificationLine).join('\n');
  const precedenceOrder = GAP_CLASSIFICATION_PRECEDENCE.filter((c) => routes.includes(c));
  const precedenceLines = precedenceOrder
    .map((c, i) => `${i + 1}. ${c}${i === 0 ? ' (checked first)' : ''}`)
    .join('\n');
  const deferFinalization = routes.includes('DEFER')
    ? '\n\nBefore this review may declare `verdict: pass`, every fact it (or a prior round\'s ' +
      'readiness Artifact) classified DEFER for this Definition round must already carry ' +
      '`status: DEFERRED` in the fact ledger. A DEFER classification alone does not complete ' +
      'the required ledger bookkeeping — the gap is already non-blocking, but the Definition ' +
      'is not eligible for `verdict: pass` until that scope decision is explicitly recorded as ' +
      '`status: DEFERRED`. A fact still classified DEFER but still ASSUMED/UNKNOWN in the ' +
      'ledger is not eligible for `pass`; declare `route: defer` instead so apply-deferred-gaps ' +
      'can record the transition.'
    : '';
  return `On \`verdict: fail\`, the readiness Artifact must name every gap keeping this verdict from
\`pass\`: every blocking gap (CAN_RESOLVE, HUMAN_DECISION, or EXPLORE_AS_WORK) and every gap
classified DEFER whose fact is not yet recorded as DEFERRED — each with at least these fields:
- fact id (or an explicit missing-area identifier, when no fact entry exists yet)
- description
- classification: one of ${GAP_CLASSIFICATION_PRECEDENCE.join(', ')}
- reason for that classification
- what closure (or, for DEFER, what recording the DEFERRED transition) would require

Never classify cheap repository inspection as EXPLORE_AS_WORK — see the CAN_RESOLVE/
EXPLORE_AS_WORK dividing line above.

This step may declare exactly one route token in the preamble's \`route:\` field, chosen from:
${routeLines}

When more than one classification is present among the current gaps this verdict must resolve,
precedence decides which single route to declare — cheap/direct/autonomous closure before human
escalation or substantive exploration:
${precedenceLines}

Never declare a route not listed above, and never declare a route when \`verdict: pass\`.${deferFinalization}`;
}

// D.3c1b — apply-deferred-gaps: converts every gap the readiness Artifact
// classified DEFER into an explicit DEFERRED fact, without incrementing
// iteration (see the D.3a termination contract: a genuine non-blocking
// DEFER gap must remain markable DEFERRED even when no further refinement
// iteration is available). This step never shares refine-definition's
// iterating loop — DEFER is resolved once, deterministically, by this
// dedicated step.
export const DEFER_APPLICATION_CONTRACT = `For every gap the most recent readiness Artifact classified DEFER:
- preserve the fact entry — never delete it from the fact ledger;
- change its status to DEFERRED;
- preserve (or add) a brief record of why it does not block the candidate bounded scope
  currently being defined;
- never mark it KNOWN — DEFERRED is not resolution, it is an explicit, recorded exclusion from
  the current scope.

Do not touch any fact classified HUMAN_DECISION or EXPLORE_AS_WORK by that same readiness
Artifact — this step's only job is converting DEFER gaps to DEFERRED. If a gap the prior
readiness Artifact classified DEFER cannot be converted (for example, its fact entry cannot be
identified), leave it unconverted rather than guessing — the following readiness review will
report it as a residual gap.`;

// D.3c1b — prepare-human-decision: produces exactly one validated D.3c0
// DecisionRequest (src/execution/decision-request.ts) for exactly one
// currently blocking HUMAN_DECISION fact. The output section's content must
// be the DecisionRequest as a single JSON object — valid JSON only, no
// markdown, no code fences, no surrounding prose — since the checkpoint
// step reads this file's raw bytes and parses them directly as JSON.
export const HUMAN_DECISION_PREPARE_CONTRACT = `Choose exactly one fact the most recent readiness Artifact classified HUMAN_DECISION — one
checkpoint asks one question. Produce a DecisionRequest JSON object with exactly these fields:
{
  "type": "human_decision",
  "title": "<short, concrete question — e.g. \\"Multiplayer authority model\\">",
  "summary": "<why the bounded scope needs this decided now, one or two sentences>",
  "options": [
    { "id": "<short-id>", "label": "<human label>", "description": "<what choosing this means>" },
    ...
  ]
}

Rules:
- Every option must be a genuinely legitimate alternative for this fact — never a fake
  approve/reject wrapping of "yes" and "no" when the real choice is among several paths.
- Option ids must be unique; every field (id, label, description) must be non-empty.
- Never ask about a fact already DECIDED.
- Never ask a human a CAN_RESOLVE, DEFER, or EXPLORE_AS_WORK question — this checkpoint exists
  for HUMAN_DECISION facts only.
- Never ask a human to do repository investigation — that is CAN_RESOLVE, resolved by
  refine-definition, not by a human decision.
- Output the JSON object itself as the section content — nothing else.`;

// D.3c1b — apply-human-decision: the natural continuation after
// human-decision-checkpoint resolves. Reads the resolved DecisionContext
// (rendered under "## Human Decision" — see ContextManager.
// formatDecisionContext) plus the decision-request.json this run itself
// produced (to know which fact/question was actually asked) and updates
// EXACTLY that one fact — never a different HUMAN_DECISION fact merely
// because it is also unresolved.
export const HUMAN_DECISION_APPLY_CONTRACT = `The "## Human Decision" section above records the human's resolution: the selected option and
(when available) their rationale, plus the Decision id. The decision-request.json artifact
records which fact/question this resolution answers.

Update EXACTLY the fact that decision-request.json's question was about:
- set its status to DECIDED;
- set its source to decision;
- record a reference to the actual resolved Decision (the Decision id shown above) and the
  selected option, so the fact ledger entry is traceable to a real human resolution, not merely
  asserted;
- preserve a brief record of the rationale, when one was given.

Never mark any other HUMAN_DECISION or EXPLORE_AS_WORK fact as DECIDED — only the human's actual
answer authorizes that transition for the fact it actually answered.`;

// D.3c1b — record-exploration-need: a bounded exploration request for one
// EXPLORE_AS_WORK gap. This step never creates a WorkItem or a WorkProposal
// (D.4's job, not D.3c1b's) and never claims the underlying fact is
// resolved — the Definition remains explicitly not-ready afterward, with
// its exploration blocker preserved in the fact ledger exactly as the
// readiness review found it.
export const EXPLORATION_NEED_CONTRACT = `Choose the fact the most recent readiness Artifact classified EXPLORE_AS_WORK (if more than one
exists, the one blocking the candidate bounded scope most directly) and record:
- the exact unresolved question;
- why existing information or reasoning cannot answer it (why it is not CAN_RESOLVE);
- why answering it requires doing something, not merely reading or deciding (why it is not
  HUMAN_DECISION and not DEFER);
- a proposed bounded method: spike, prototype, benchmark, measurement, or experiment;
- the expected evidence or output that method would produce;
- the exit criterion — what finding would allow the Definition to be refined again.

Do not create a WorkItem or a WorkProposal, do not authorize any work, do not claim the fact is
resolved, and do not mark it KNOWN. The Definition's fact ledger keeps this fact exactly as the
readiness review classified it — this Artifact records the exploration need alongside it, it
does not replace it.`;
