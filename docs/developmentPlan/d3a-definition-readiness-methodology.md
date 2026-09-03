# D.3a — Definition / readiness methodology contract

**Status:** Contract accepted, including the D.3a.1 correction (§8). This
is a documentation-only phase: no production code, schema, migration,
`StepKind`, `AgentRole`, or domain entity changes. It locks the semantics
D.3b–D.3d must implement against. D.3a is closed.
**Milestone:** D, phase D.3a → D.3a.1 → D.3b → D.3c → D.3d (see DDR-033
and `CURRENT_FOCUS_INTENT_TO_READY_WORK.md`, Milestone D as amended;
follows D.2 — Objectives, closed)

## 0. The invariant this phase exists to protect

> Stratum should formalize intent only until it has enough certainty to
> authorize the next bounded useful work — not until the entire future
> system is completely specified.

Two failure modes sit on either side of that line, and both are cheaper to
rule out in a contract than to discover in review of running code:

1. **Under-specification.** An agent (or a human, in a hurry) turns a vague
   idea directly into a `WorkItem` without ever writing down what's
   actually known, assumed, or undecided. Work gets authorized against
   guesses that were never surfaced as guesses.
2. **Over-specification.** "Understand intent before authorizing work"
   gets read as "produce a complete specification of the whole Objective
   before anything is allowed to start" — a waterfall re-creation that
   contradicts the rest of this system's bias toward small, bounded,
   verifiable increments (DDR-032's `WorkItem`/`WorkflowRun` shape, D.1's
   step-level scoping).

D.3a's job is to define, precisely enough to implement without further
judgment calls, what "enough certainty" means for *one candidate bounded
scope*, and what happens to everything that isn't yet certain. Nothing here is
new kernel vocabulary: per DDR-033 §4/§6, the Definition Artifact stays an
`Artifact` (no new entity), and the workflow that will produce/refine it
(D.3b) composes the existing `gather`/`produce`/`review`/`checkpoint`
`StepKind`s — the same pattern `full-build` and D.1's declarative contract
already established.

## 1. Definition Artifact semantics

A Definition is an `Artifact` (`type: 'definition'`, `ref:
'definition:<objectiveId>'`) produced and refined by a `define-work`-family
workflow (D.3b), running as a `WorkItem` whose `objectiveId` names the
`Objective` this Definition defines. **Correction (D.3a.1):** the original
text of this section said the Definition is "attached to" the `Objective`,
which overstated the storage relationship. `ArtifactRecord` (DDR-032 §8.11,
as implemented in D.1c) links directly to `WorkItem`/`WorkflowRun`, not to
`Objective` — there is no `objectiveId` column on `Artifact` storage, and
D.3a.1 does not add one. The association to the `Objective` is logical,
not a physical foreign key: it exists through (a) the defining `WorkItem`'s
`objectiveId`, and (b) the deterministic `ref` string itself. Within one
`WorkflowRun`, D.1c's existing versioning — `(workflowRunId, ref, hash)`
dedup, `listLatestByWorkItem`/`listLatestByWorkflowRun` — is exactly what
tracks Definition v1/v2/etc.: no new persistence mechanism, no new
provenance model. Retrieving the *latest* Definition for a given
`Objective` across separate `WorkflowRun`s (e.g. a later session reopening
an earlier Definition) is not covered by the mechanism above; it is left
as a narrow retrieval path to design if/when D.3b/D.3c implementation
proves it's actually needed, not decided speculatively here.

### 1.1 Content shape

A Definition's content is structured into fixed sections, each optional
except `goal`:

| Section | Purpose | Reuses |
|---|---|---|
| `goal` | The single outcome this Definition is defining. One statement, not a list. | — |
| `constraints` | Boundaries the eventual work must respect. | `ConstraintSchema` (`description`, `type: must \| must_not \| prefer \| prefer_not`) — already exists, unchanged. |
| `requirements` | Concrete behavioral expectations the goal implies. | Plain structured list; each entry may reference fact ids from the ledger (§1.2) but carries no independent epistemic status of its own — see the sole-ownership rule at the top of §1.2. |
| `nonGoals` | What this Definition explicitly excludes. The symmetric counterpart to `constraints`: constraints bound *how*, non-goals bound *what*. | — |
| `design` | Current design thinking, if any. May be empty for an early idea — a Definition is not required to contain a design before it can be ready (§2). | — |
| `risks` | Named risks, independent of any single fact's status. | — |
| `acceptanceModel` | What "done" looks like for the goal/requirements. | `CriterionSchema` (`description`, `met: boolean`) — already exists, unchanged. |
| `facts` | The ledger described in §1.2 — the actual unit gaps are tracked against. | New within the Artifact's content shape; not a new domain entity. |

### 1.2 The fact ledger: `KNOWN / ASSUMED / UNKNOWN / DECIDED / DEFERRED`

**Correction (D.3a.1) — sole ownership of epistemic status:** an earlier
version of §1.1 said a `requirements` entry "may carry a fact status,"
which implied two possible sources of truth for the same information.
That is corrected here, explicitly: **epistemic status exists exactly
once, in the fact ledger.** `goal`, `constraints`, `requirements`,
`nonGoals`, `design`, and `risks` may *reference* a fact by id, and a fact
may carry section/category metadata pointing back to where it's discussed
— but `KNOWN`/`ASSUMED`/`UNKNOWN`/`DECIDED`/`DEFERRED` is never duplicated
as an independent property of a constraint or requirement entry. One
fact, one status, one place.

Every fact relevant to the goal — whether surfaced from a requirement, a
constraint, a risk, or discovered during drafting — is an entry `{ id,
statement, status, source, ...}` in the ledger, with exactly one status at
a time. `source` records where the fact came from — `human`, `repository`,
`artifact`, `investigation`, or `decision` — and it matters independently
of status: a human-stated product requirement can be `KNOWN` as
authoritative intent (`source: human`) without any code being read at
all, but a human's *assertion about repository reality* ("I think we
already have a network layer") is not automatically equivalent to an
observed fact — it starts `ASSUMED`, `source: human`, until something with
`source: repository` or `source: investigation` actually confirms it
(§5.1 below shows exactly this distinction in the worked example). The
status values themselves:

- **`KNOWN`** — verified. Backed by something that already exists and is
  checkable — exactly what `source` records (repository content, an
  artifact, an existing test, an explicit authoritative statement from a
  human). Not a belief; a fact.
- **`ASSUMED`** — a working belief adopted so drafting can proceed,
  explicitly *not* verified. The distinguishing property from `UNKNOWN` is
  that a value has been chosen provisionally, not left open. Every
  `ASSUMED` fact is a candidate input to the readiness rubric's "risky
  assumptions" check (§2.5) — the point of the status is to make these
  visible, not to hide provisional choices as if they were `KNOWN`.
- **`UNKNOWN`** — an acknowledged gap with no answer and no working
  assumption. The difference from `ASSUMED` is deliberate: an `UNKNOWN`
  fact is one where guessing was judged worse than leaving it open.
- **`DECIDED`** — a fact that was `UNKNOWN` or `ASSUMED`, escalated as a
  `HUMAN_DECISION` gap (§3), and resolved by an actual recorded `Decision`
  (the existing control-plane entity, produced by a `checkpoint`-kind
  step). A `DECIDED` fact carries a reference to that `Decision` (its
  `source` becomes `decision`). It does not revert to `UNKNOWN` inside the
  same Definition lineage; a later Definition version may reopen it only
  by recording a new `Decision`.
- **`DEFERRED`** — a real, acknowledged gap that is explicitly *not*
  required to be resolved for the candidate bounded scope currently being
  defined. This is the status that makes the "not the whole future system"
  half of the invariant (§0) mechanical rather than aspirational: a
  Definition can carry any number of `DEFERRED` facts about the wider
  `Objective` and still be ready (§2) for the narrow scope at hand.

`DEFERRED` is not a weaker `UNKNOWN` and `ASSUMED` is not a weaker
`KNOWN` — they are different answers to "why isn't this resolved," and
§3's gap classification depends on keeping them distinct.

## 2. Readiness rubric

A Definition version is evaluated against seven dimensions. Each is a
pass/fail-with-reason check, scoped to **the candidate bounded scope — the
next bounded outcome — this Definition is defining**, not the entire
`Objective`.

**Correction (D.3a.1):** the original text scoped readiness to "the one
bounded `WorkItem` this Definition is about to authorize." That got the
lifecycle order backwards — readiness is evaluated *before* any `WorkItem`
exists. A ready Definition authorizes a `WorkProposal` (DDR-033 §5), and
the proposal — not this rubric — is what decomposes the scope into
concrete `WorkItem`s:

```text
Objective -> candidate bounded scope -> Definition -> readiness
          -> WorkProposal -> 1..N bounded WorkItems
```

D.3 decides whether the scope is ready; how many `WorkItem`s it becomes is
a separate concern (D.4) this contract does not resolve, and readiness
must never be made to depend on a `WorkItem` cardinality that doesn't
exist yet at evaluation time. This scoping — bounded scope, not the whole
`Objective` — is what lets a Definition be ready while still carrying open
`DEFERRED`/`UNKNOWN` facts about the larger idea; it is the rubric's
enforcement point for §0's invariant.

1. **Outcome** — is `goal` a single, concrete statement (not a category
   like "make it better")? Could a reader tell, in principle, whether the
   eventual work satisfies it?
2. **Boundary** — does `nonGoals` meaningfully exclude adjacent scope, so
   the candidate bounded scope has an actual edge, not an open-ended one?
3. **Critical constraints** — are the `must`/`must_not` constraints that
   would change the *shape* of the work captured (not an exhaustive list
   of every constraint imaginable — the rubric checks for the constraints
   that matter, not completeness for its own sake)?
4. **Consistency** — do `requirements`, `constraints`, and `nonGoals`
   contradict each other or `goal`? This check spans the whole Definition;
   it is not a property of any single fact.
5. **Risky assumptions** — among `ASSUMED` facts, are there any whose
   falsity would invalidate `goal` or a critical (`must`/`must_not`)
   constraint? Not every assumption is risky — a low-stakes one (e.g.
   wording of a UI label) doesn't block readiness; one that the goal's
   correctness depends on does.
6. **Acceptance** — does `acceptanceModel` contain at least one criterion
   sufficient to know when the authorized work is actually done?
7. **Remaining unknowns** — among `UNKNOWN` facts, are there any that
   block the candidate bounded scope (as opposed to `UNKNOWN` facts that
   are real but irrelevant to this particular scope, which are candidates
   for `DEFERRED` rather than blockers — see §3)?

**Readiness = pass on all seven for the current version.** A failing
dimension is never itself the actionable output — it points at one or
more specific facts (or a missing fact) in the ledger, which §3
classifies into what actually happens next.

## 3. Gap classification

Every readiness failure resolves to a specific fact — an `ASSUMED`/
`UNKNOWN` entry, or a gap where no entry yet exists (missing acceptance
criterion, missing non-goal, etc.). That fact is classified into exactly
one of four buckets. This classification, not the pass/fail bit alone, is
the actual decision D.3b/D.3c automate — collapsing all four into one
uniform response (always ask a human, or always spin up investigation) is
precisely the mistake this contract exists to prevent.

- **`CAN_RESOLVE`** — closeable without a human decision or exploratory
  work: an omitted non-goal obvious from the stated goal, a missing
  acceptance criterion for a requirement that's already fully stated, a
  direct contradiction to fix, information that already exists elsewhere
  in the repository (an accepted DDR, existing code, an existing test)
  and just hasn't been pulled into this Definition yet. Resolution:
  produces the next Definition version directly — the fact becomes
  `KNOWN`, or the missing section gets filled in.
- **`HUMAN_DECISION`** — the gap is a choice only a human can authorize:
  product tradeoffs, risk acceptance, prioritization among competing
  constraints, anything costly or irreversible to get wrong. Routed
  through the existing `checkpoint`-kind step and the existing `Decision`
  entity (DDR-032; the same mechanism D.1's declarative contract already
  wires through `WorkflowEngine` — no new checkpoint semantics). Never
  guessed by an agent, never silently downgraded to `ASSUMED`. Resolution:
  a `Decision` is recorded; the fact moves to `DECIDED`.
- **`DEFER`** — the gap is real but does not block the bounded scope being
  authorized now. Resolution: the fact is marked `DEFERRED`, not silently
  dropped — it stays visible in the ledger for a future Definition version
  against the same `Objective`, and readiness (§2, dimension 7)
  re-evaluates without it counting as a blocker.
- **`EXPLORE_AS_WORK`** — the gap can't be closed by reading or reasoning;
  answering it requires *doing* something — building or measuring — to
  get an answer (a prototype, a benchmark, a spike whose output is the
  actual resolution, not just its notes). Resolution: **not** resolved
  inline. It becomes its own bounded `WorkItem` — an investigation,
  created `draft` like any other `WorkItem` per DDR-033 §5's "agents
  propose, deterministic systems authorize" — whose output (evidence,
  findings) feeds the *next* Definition version as new facts. This
  mirrors D.1a's own precedent: the spike investigation that ran before
  D.1b touched production code was exactly this pattern, informally.

**The dividing line between `CAN_RESOLVE` and `EXPLORE_AS_WORK` is cost
and kind, not topic or importance.** Reading existing code, tests, or
docs to answer a factual question — however consequential the question —
is `CAN_RESOLVE`: cheap, direct, produces a `KNOWN` fact immediately, and
needs no `WorkItem`. `EXPLORE_AS_WORK` is reserved for uncertainty whose
resolution is itself substantive bounded work. **Cheap/direct discovery
is never `EXPLORE_AS_WORK`** — §5.1 below corrects an earlier version of
this document that got this specific distinction backwards.

A single Definition round may produce gaps in more than one bucket at
once (§5.1 below has three), and buckets are handled independently and in
parallel where they don't depend on each other — `CAN_RESOLVE` gaps don't
wait on a `HUMAN_DECISION` gap's checkpoint to resolve, unless one fact
genuinely depends on another.

## 4. Refinement termination

**Added (D.3a.1):** the contract established that there is no mandatory
number of refinement rounds (§5.2 demonstrates this), but it never said
when the loop must stop. That gap is closed here, conservatively, as
workflow methodology — not new kernel machinery. `WorkflowEngine` already
supports a per-workflow iteration cap (`WorkflowDefinition.max_iterations`,
a review step marked `is_iteration_gate`, enforced by the engine's
existing cap-hit handling — see `workflow/engine.ts`). D.3b's `define-work`
workflow uses that mechanism directly; nothing new is added to the engine.

**Policy:** an initial Definition draft, plus at most 3 refinement passes
(`max_iterations: 3` on the review step gating refinement) — at most 4
Definition versions (v1 through v4) before the workflow must stop looping.

At cap, in order:

- readiness is **never** forced to pass — a Definition that hasn't reached
  readiness by the cap is not silently treated as ready;
- gaps already classified `DEFER` stay (or become) `DEFERRED` in the fact
  ledger — cap exhaustion changes nothing about how a non-blocking gap is
  recorded, since `DEFERRED` is already its ordinary resting state;
- `HUMAN_DECISION` gaps route to a checkpoint/`Decision` — once D.3c wires
  that path (see below for D.3b's narrower interim behavior);
- `EXPLORE_AS_WORK` gaps become exploratory `WorkItem` proposals — once
  D.3c wires that path (same caveat);
- any `CAN_RESOLVE` gap still unresolved at cap (expected to be rare —
  `CAN_RESOLVE` gaps are meant to close within a round) fails closed: the
  workflow halts and lists the specific unresolved gaps as blockers. It is
  never silently dropped and the Definition is never force-passed.

**D.3b's actual behavior is narrower than this general policy**, because
D.3b implements only `CAN_RESOLVE` resolution (§7 below — no checkpoint,
no investigation `WorkItem` creation yet). For D.3b specifically: cap
exhaustion halts and fails closed with every outstanding gap — regardless
of classification — listed as an unresolved blocker, exactly like the
"unresolved `CAN_RESOLVE`" case above. It never loops past the cap and
never force-passes readiness. D.3c then narrows that fallback per gap
classification, per the general policy above.

## 5. Worked behavior

### 5.1 Early-stage idea: "Make Evershift multiplayer-capable"

Starting point: an `Objective` with exactly that title and a one-line
description — genuinely early, the shape existing test fixtures already
use (`tests/objective-service.test.ts`). No requirements, no constraints,
no acceptance model yet.

**Definition v1** (drafted by a `produce`-kind step): a plausible first
pass —

- `goal`: "Players can join and play a shared Evershift session together
  in real time."
- `requirements`: session join/leave, state synchronization, latency
  target — each entered as a fact, `ASSUMED` (drafted from the goal, not
  verified against the existing codebase).
- `constraints`: none yet identified.
- `nonGoals`: none yet stated.
- `design`, `risks`: empty.
- `acceptanceModel`: empty.
- Additional facts surfaced while drafting: "does Evershift currently have
  a networking layer?" (`UNKNOWN`, `source: human` — nobody has actually
  looked at the codebase yet, only asked the question), "players expect
  cross-platform play" (`ASSUMED`, `source: human` — carried over from the
  idea's phrasing, not confirmed as an authoritative requirement), and "can
  the candidate client-side-prediction-plus-reconciliation approach hold
  the required latency/frame budget for a two-player session?" (`UNKNOWN`,
  `source: human` — a real design risk implied by "real time," not yet
  answered any way).

**Readiness check against v1** fails on:

- Dimension 2 (boundary) — no `nonGoals`; "multiplayer-capable" is
  unbounded as stated (voice chat? matchmaking? spectating? all
  unaddressed).
- Dimension 3 (critical constraints) — nothing captured about
  latency/platform requirements that would shape the work.
- Dimension 5 (risky assumptions) — the *cross-platform* `ASSUMED` fact
  would reshape the design if false; it's exactly the kind of assumption
  this dimension exists to surface.
- Dimension 6 (acceptance) — `acceptanceModel` is empty.
- Dimension 7 (remaining unknowns) — two `UNKNOWN` facts block the scope:
  whether a networking layer exists at all, and whether the candidate
  synchronization approach can meet the latency budget.

**Gap classification:**

- Missing `nonGoals` (dimension 2) → `CAN_RESOLVE` — a first pass at
  exclusions (no voice chat, no matchmaking, no spectator mode, in this
  bounded increment) can be written directly from the stated goal without
  a human or investigation.
- Missing acceptance criteria (dimension 6) → `CAN_RESOLVE` similarly,
  once the requirements are stated concretely enough.
- "Does Evershift currently have a networking layer?" (`UNKNOWN`,
  dimension 7) → **`CAN_RESOLVE`** — this is answered by reading the
  repository, not by building anything. **Correction (D.3a.1):** an
  earlier version of this document classified this exact fact as
  `EXPLORE_AS_WORK` and spun it into a small investigation `WorkItem`,
  which was inconsistent with §3's own rule and would have manufactured
  unnecessary work for something an inline repository inspection answers
  directly.
- "Players expect cross-platform play" (`ASSUMED`, dimension 5) →
  `HUMAN_DECISION` — whether cross-platform support is in scope for this
  increment is a product tradeoff (cost/timeline vs. reach), not something
  an agent should assume its way past. Routed to a checkpoint.
- "Can the candidate synchronization approach hold the latency/frame
  budget for a two-player session?" (`UNKNOWN`, dimension 7) →
  **`EXPLORE_AS_WORK`** — this is the genuinely substantive uncertainty:
  answering it means actually implementing a small prototype and
  measuring it under realistic conditions, not reading anything that
  already exists. It becomes its own bounded investigation `WorkItem`
  ("prototype and benchmark client-side-prediction sync for a two-player
  session").

**Resolution:** the `nonGoals` and acceptance-criteria `CAN_RESOLVE` gaps
produce revised sections immediately. The networking-layer `CAN_RESOLVE`
gap is closed the same way, inline: inspecting the repository confirms no
networking code exists, so the fact becomes `KNOWN`, `source: repository`.
The `EXPLORE_AS_WORK` prototype/benchmark runs and reports back: the
candidate approach holds the latency budget for a two-player,
same-network session; that finding becomes `KNOWN`, `source:
investigation`. The `HUMAN_DECISION`
checkpoint returns a `Decision`: cross-platform play is explicitly **out**
of scope for this increment (same-platform only); the fact becomes
`DECIDED`, `source: decision`.

**Definition v2** incorporates all of it: the networking-layer and
synchronization-feasibility facts are now `KNOWN`; "cross-platform" is now
`DECIDED` as *excluded*, which also lets it be restated as an explicit
`nonGoal` rather than staying an open fact; `nonGoals` and
`acceptanceModel` are filled in from the `CAN_RESOLVE` round. Anything
about *later* multiplayer expansion (voice, matchmaking, spectating,
sessions beyond two players, eventually revisiting cross-platform) is
explicitly marked `DEFERRED` — real, not forgotten, not blocking.

**Readiness against v2**, evaluated for the candidate bounded scope "add a
same-platform two-player real-time session to Evershift" (not "finish
multiplayer"), now passes all seven dimensions. That scope can be proposed
via a `WorkProposal` (DDR-033 §5) and authorized into one or more `draft`
`WorkItem`s — the exact decomposition is D.4's concern, not decided here
— while the `Objective` as a whole still carries several `DEFERRED` facts
about everything beyond same-platform play, entirely by design.

### 5.2 Mature-spec example: no forced ideation

A request that already arrives essentially fully specified — e.g. "add a
`GET /objectives/:id/history` endpoint that returns an Objective's status
transitions, following the exact pattern `GET /objectives/:id` already
uses" — produces a **Definition v1** where nearly every fact starts
`KNOWN` (the existing route pattern, the existing `inWorkspace` guard, the
existing event log to read from), `nonGoals` is implicit and narrow (no
new entity, no new event types), and `acceptanceModel` is a direct
restatement of the ask. No `ASSUMED`, `UNKNOWN`, or open gap exists to
classify. Readiness passes on v1, with zero `HUMAN_DECISION` or
`EXPLORE_AS_WORK` gaps generated, straight to a ready candidate scope,
immediately proposable as a single `WorkItem` via `WorkProposal`.

This is the deliberate proof that the methodology has no fixed number of
rounds and no mandatory ideation ritual — §2's rubric is evaluated
against whatever facts already exist, and a request that starts mature
simply has nothing left to resolve. The loop's length is a function of
how much genuine gap exists, never a process requirement imposed on top.

## 6. What D.3a deliberately does not build

- No `Definition`/`WorkProposal` domain entity. Both stay `Artifact`s per
  DDR-033 §4 (Law 5: no new entity without a implementation proving
  `Artifact` can't express it) — the fact ledger and section structure in
  §1 are content shape, not schema/table changes.
- No new `StepKind`. The eventual `define-work` workflow (D.3b) composes
  the existing `gather`/`produce`/`review`/`checkpoint` kinds, the same
  way `full-build` already does.
- No new `AgentRole`. D.3b reuses an existing role and drives behavior
  through `instruction`/`inputArtifactRefs`/`outputArtifact` — the same
  declarative contract D.1 built.
- No readiness-scoring code, gap-classification code, checkpoint wiring,
  or `WorkProposalService` — those are D.3b/D.3c's job, not this phase's.
- No changes to `ObjectiveService`, `WorkService`, `WorkflowEngine`,
  `ContextManager`, `AgentRunner`, or any D.1/D.2 code or tests.

## 7. What D.3b–D.3d build against this contract

```text
D.3a  this document (+ D.3a.1 correction) — Definition semantics,
      readiness rubric, gap classification, termination policy,
      worked behavior. No code.
  ↓
D.3b  minimal Definition -> review -> refine loop: a define-work
      workflow producing/versioning real Definition Artifacts, a
      review-kind step implementing §2's rubric and §4's termination
      policy (via the existing max_iterations/is_iteration_gate —
      no new engine machinery), CAN_RESOLVE handled inline.
  ↓
D.3c  human Decision integration: HUMAN_DECISION gaps wired to a
      real checkpoint step and the existing Decision entity;
      EXPLORE_AS_WORK gaps wired to real investigation WorkItems;
      DEFER wired to the ledger's DEFERRED status.
  ↓
D.3d  early / partial / mature behavioral proof: end-to-end tests
      reproducing §5's worked scenarios (and comparable ones)
      against the real implementation, not this document's prose.
```

Each of D.3b/D.3c/D.3d is reviewed independently, following the same
pattern as D.1a→D.1b→D.1c and D.2→D.2.1→D.2.2: implement, report the
exact SHA and CI run, stop for review before the next sub-phase.

## 8. D.3a.1 — review corrections

D.3a's methodology was accepted; review found one worked-example
inconsistency and three real gaps in the contract itself. All are fixed
above; nothing else in D.3a changed, and no production code was touched
in either D.3a or this correction. D.3a is closed as of this section.

1. **§3/§5.1 — `CAN_RESOLVE` vs. `EXPLORE_AS_WORK` in the worked example.**
   §3 already correctly defined `CAN_RESOLVE` as covering facts
   discoverable directly from the repository, but §5.1's worked example
   classified "does Evershift have a networking layer?" as
   `EXPLORE_AS_WORK`, contradicting §3 and modeling exactly the kind of
   unnecessary investigation `WorkItem` the contract is supposed to
   prevent. Fixed: that fact is now `CAN_RESOLVE` (resolved by inline
   repository inspection), and the example gained a genuinely substantive
   `EXPLORE_AS_WORK` uncertainty instead — whether a candidate
   synchronization approach can hold the required latency/frame budget,
   answerable only by prototyping and measuring. §3 also gained an
   explicit dividing-line statement: cost and kind decide the bucket, not
   topic or importance, and cheap/direct discovery is never
   `EXPLORE_AS_WORK`.
2. **New §4 — refinement termination.** The contract said rounds aren't
   fixed in number but never said when they stop. Added a conservative
   initial policy (initial draft + at most 3 refinement passes) built
   entirely on `WorkflowEngine`'s existing `max_iterations`/
   `is_iteration_gate` iteration-cap machinery — no new engine concept —
   plus an explicit, ordered cap-hit policy (never force `READY`; `DEFER`
   gaps become `DEFERRED`; `HUMAN_DECISION`/`EXPLORE_AS_WORK` route to
   their D.3c mechanisms once those exist; unresolved `CAN_RESOLVE` gaps
   fail closed with named blockers) and D.3b's narrower interim behavior
   (halt and fail closed on any outstanding gap, since D.3b implements
   only `CAN_RESOLVE`).
3. **§1/§2/§5 — "one `WorkItem`" replaced with "candidate bounded scope."**
   Readiness is evaluated before any `WorkItem` exists; a ready Definition
   authorizes a `WorkProposal`, which is what later decomposes a scope
   into `WorkItem`s (D.4's concern, not D.3's). Every place the contract
   scoped readiness to "the `WorkItem` this Definition is about to
   authorize" was corrected to "the candidate bounded scope," and the
   `Objective -> candidate bounded scope -> Definition -> readiness ->
   WorkProposal -> 1..N WorkItems` lifecycle is now stated explicitly in
   §2. Definition readiness does not, and must not, depend on future
   `WorkItem` cardinality.
4. **§1.2 — the fact ledger is the sole owner of epistemic status.** §1.1's
   content table previously said a `requirements` entry "may carry a fact
   status," alongside §1.2 saying every relevant fact also lives in the
   ledger — two possible sources of truth for the same information. Fixed
   with an explicit rule at the top of §1.2: status exists exactly once,
   in the ledger; other sections may reference a fact by id but never
   duplicate its status. Fact provenance is also now explicit: each ledger
   entry carries a `source` (`human` / `repository` / `artifact` /
   `investigation` / `decision`), and §1.2 states directly that a
   human-stated product requirement can be `KNOWN` as authoritative intent
   while a human's assertion about repository reality is not automatically
   equivalent to an observed fact — it stays `ASSUMED` until a
   `repository`- or `investigation`-sourced fact confirms it. No new
   domain schema or entity — `source` is content shape within the existing
   `Artifact`, exactly like `status` already was.
5. **§1 — Objective linkage corrected from an implied FK to a logical
   association.** The original text said a Definition is "attached to" an
   `Objective`; `ArtifactRecord` (DDR-032 §8.11, D.1c) actually links only
   to `WorkItem`/`WorkflowRun`, with no `objectiveId` column, and D.3a.1
   adds none. Fixed to state the association is logical: the defining
   `WorkItem`'s `objectiveId`, plus the deterministic `ref:
   'definition:<objectiveId>'` string. D.1c's existing `(workflowRunId,
   ref, hash)` versioning is unchanged and is exactly what tracks
   Definition v1/v2/etc. within one `WorkflowRun`. Cross-run retrieval of
   the latest Definition for an `Objective` is explicitly left as a future
   narrow retrieval path, not designed speculatively here.

Full `npm run verify` (type-check, build, entire suite) is green — this
correction touches only `docs/developmentPlan/d3a-definition-readiness-methodology.md`.
