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
   actual edge? A scope item whose membership in THIS increment the Objective leaves genuinely
   undecided keeps this dimension from passing: recording it UNKNOWN is honest bookkeeping,
   not a boundary — only a recorded human decision (include, or exclude as a deliberate
   non-goal) settles membership. Items already understood to be later-phase are excluded via
   DEFERRED and do not block this dimension.
3. Critical constraints — are the must/must_not constraints that would change the shape of the
   work captured (not an exhaustive list of every constraint imaginable)?
4. Consistency — do requirements, constraints, and nonGoals contradict each other or goal?
5. Risky assumptions — among ASSUMED facts, are there any whose falsity would invalidate goal
   or a critical (must/must_not) constraint? Not every assumption is risky. A risky assumption
   does not automatically become a human question either: the definition-side closures are a
   safe default with recorded mitigation (keep it ASSUMED, state its rationale, and add the
   fallback requirement), or EXPLORE_AS_WORK when only building/measuring could answer it.
6. Acceptance — does acceptanceModel contain at least one criterion sufficient to know when the
   authorized work is done?
7. Remaining unknowns — among UNKNOWN facts, are there any that block the candidate bounded
   scope (as opposed to ones that are real but irrelevant to this particular scope)? An
   UNKNOWN whose answer could falsify the goal or a critical (must) constraint — for example,
   whether the performance the scope requires is achievable at all — is never "irrelevant":
   it is the scope's own feasibility, and it blocks authorization until it is isolated
   (EXPLORE_AS_WORK) or resolved.

Readiness = pass on all seven for the current version. A failing dimension points at one or
more specific facts (or a missing fact) in the ledger — name exactly which dimensions pass or
fail and why, and name every remaining blocker.

Readiness is not an editorial review: do not fail a Definition for stylistic preference,
hypothetical completeness, or information nobody would need in order to authorize the bounded
scope. If all seven dimensions pass, the verdict is pass. A refinement round must be justified
by a genuine, named gap — never by polish; manufacturing definition process for an already-
sufficient intent is a failure of this rubric, not diligence.`;

// ─── Output transport contract (D.3d) ──────────────────────────────────────────
//
// The contracts above describe artifact CONTENT; these two describe the exact
// WIRE FORMAT a step's reply must use so AgentRunner/AgentLoop can physically
// consume it. AgentRunner parses two different shapes: produce steps run
// through the multi-turn AgentLoop (output-parser.ts: <<<SLE-OUTPUT>>>
// delimiters with '### <path>' sections), while review steps are forced
// single-turn (agent-runner.ts: an '<!-- SLE-OUTPUT' YAML preamble with
// '## <path>' body headers). Neither shape was ever taught by any prompt —
// Layer A's scripted provider had always emitted them by construction, so
// the D.3d live-provider qualification was the first thing able to catch the
// gap: a real model produced sensible methodology content but never emitted
// the delimiters. They are taught as TWO separate, per-step-kind contracts —
// composing both into one instruction made a real model mix the shapes
// (it emitted the preamble inside a tool conversation, which cannot parse).
// Composed into define-work's step instructions (builtins/define-work.ts).
export const PRODUCE_OUTPUT_FORMAT_CONTRACT = `OUTPUT FORMAT (mandatory — your reply is consumed by a machine):
End your final message with the artifact wrapped in exactly these literal delimiters, as a
single '### <path>' section whose path is the declared output artifact path named in the task:

<<<SLE-OUTPUT>>>
### .sle/work/<workItemId>/<artifact>.md
<the full artifact content>
<<<END-SLE-OUTPUT>>>

- Use the declared output artifact path exactly as named in the task — never a path you
  invented, and never more than one artifact section.
- The delimiters are literal structural requirements: a reply without them cannot be parsed
  and fails the step regardless of content quality. Never reply in prose alone, in any other
  comment or preamble style, or with any wrapper other than these exact delimiters.`;

export const REVIEW_OUTPUT_FORMAT_CONTRACT = `OUTPUT FORMAT (mandatory — your reply is consumed by a machine):
Begin your reply with an HTML-comment YAML preamble, then give the readiness Artifact body
under a '## <path>' header matching the declared output artifact path named in the task:

<!-- SLE-OUTPUT
role: explorer
node: <this step's id, shown in Current State above>
artifacts:
  - id: readiness
    path: .sle/work/<workItemId>/readiness.md
verdict: pass
-->

## .sle/work/<workItemId>/readiness.md

<the full readiness Artifact content>

- The preamble must carry 'verdict: pass' or 'verdict: fail' — never omit the verdict line —
  plus a 'route: <token>' line chosen from the routing contract above when, and only when,
  the verdict is fail.
- The preamble comment and the '## <path>' header are literal structural requirements: a
  reply without them cannot be parsed and fails the step regardless of content quality.`;

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
  requirement, a direct contradiction to fix, information that already exists elsewhere in
  the repository and just hasn't been pulled into this Definition yet, or an open parameter
  a competent engineer can settle by adopting a reasonable default — recording it ASSUMED
  (source: investigation) with its rationale in the ledger, never silently.
- HUMAN_DECISION — the gap is a choice only a human can authorize: product tradeoffs, risk
  acceptance, prioritization among competing constraints, anything costly or irreversible to
  get wrong. "Risk acceptance" means accepting a product-level risk on the human's behalf
  (shipping something whose failure harms users or the business) — never engineering
  uncertainty about data or behavior, which is closed by a safe default or isolated as
  exploration. Never guessed by an agent, never silently downgraded to ASSUMED. Whether an
  undecided scope item belongs inside the candidate bounded scope is itself such a choice:
  settling it by writing a prefer/must_not constraint, a non-goal, or a "does not block"
  judgment is exactly the silent guessing this classification forbids — record the item as
  UNKNOWN (or ASSUMED) and let the review classify it, so a human decides. The converse holds
  too: a question a competent engineer can settle with a reasonable stated default (recorded
  in the Definition as ASSUMED, with its rationale) is NOT HUMAN_DECISION — robustness and
  error-handling behavior for degenerate inputs being the canonical example: choose the safe
  default, record it with its rationale, and move on. An unstated implementation detail that
  connects facts the Objective already states is likewise derived design, not a fresh human
  choice — and a fact the Objective states is authoritative: never re-open it as a question.
  Reserving human attention for choices that genuinely need it is part of this classification's
  discipline.
- DEFER — the gap is real but does not block the bounded scope being defined now. DEFER is
  for items already understood to lie outside the candidate bounded scope (clearly later-phase
  work) — never a place to park an undecided question about what the bounded scope itself
  contains (that is HUMAN_DECISION).
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
  const exploreFinalization = routes.includes('EXPLORE_AS_WORK')
    ? '\n\nBefore this review may declare `verdict: pass`, every fact it (or a prior round\'s ' +
      'readiness Artifact) classified EXPLORE_AS_WORK for this Definition must have been ' +
      'actually resolved — by the measurement/build work itself (status KNOWN, source ' +
      'investigation), by a recorded human decision that eliminated the question (status ' +
      'DECIDED, source decision), or by an explicit re-classification recorded with its reason ' +
      'in the fact ledger. An EXPLORE_AS_WORK fact still ASSUMED/UNKNOWN in the ledger is not ' +
      'eligible for `pass` — arguing it "does not block" or is "an implementation choice" ' +
      'without recorded evidence or a recorded decision is exactly the silent resolution this ' +
      'classification forbids; declare `route: explore` instead so record-exploration-need can ' +
      'isolate it as bounded work.'
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

Never declare a route not listed above, and never declare a route when \`verdict: pass\`.${deferFinalization}${exploreFinalization}`;
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
