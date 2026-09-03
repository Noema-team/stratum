# D.3a — Definition / readiness methodology contract

**Status:** Contract accepted. This is a documentation-only phase: no
production code, schema, migration, `StepKind`, `AgentRole`, or domain
entity changes. It locks the semantics D.3b–D.3d must implement against.
**Milestone:** D, phase D.3a → D.3b → D.3c → D.3d (see DDR-033 and
`CURRENT_FOCUS_INTENT_TO_READY_WORK.md`, Milestone D as amended; follows
D.2 — Objectives, closed)

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
judgment calls, what "enough certainty" means for *one bounded WorkItem*,
and what happens to everything that isn't yet certain. Nothing here is
new kernel vocabulary: per DDR-033 §4/§6, the Definition Artifact stays an
`Artifact` (no new entity), and the workflow that will produce/refine it
(D.3b) composes the existing `gather`/`produce`/`review`/`checkpoint`
`StepKind`s — the same pattern `full-build` and D.1's declarative contract
already established.

## 1. Definition Artifact semantics

A Definition is an `Artifact` (`type: 'definition'`, `ref:
'definition:<objectiveId>'`) attached to an `Objective`, produced and
refined by a `define-work`-family workflow (D.3b). It is versioned the
same way every other declared-output Artifact is versioned as of D.1c:
each refinement is a new row keyed by `(workflowRunId, ref, hash)`, and
`ArtifactRepository.listLatestByWorkItem`/`listLatestByWorkflowRun`
project the current version — no new persistence mechanism, no new
provenance model.

### 1.1 Content shape

A Definition's content is structured into fixed sections, each optional
except `goal`:

| Section | Purpose | Reuses |
|---|---|---|
| `goal` | The single outcome this Definition is defining. One statement, not a list. | — |
| `constraints` | Boundaries the eventual work must respect. | `ConstraintSchema` (`description`, `type: must \| must_not \| prefer \| prefer_not`) — already exists, unchanged. |
| `requirements` | Concrete behavioral expectations the goal implies. | Plain structured list; each entry may carry a fact status (§1.2). |
| `nonGoals` | What this Definition explicitly excludes. The symmetric counterpart to `constraints`: constraints bound *how*, non-goals bound *what*. | — |
| `design` | Current design thinking, if any. May be empty for an early idea — a Definition is not required to contain a design before it can be ready (§2). | — |
| `risks` | Named risks, independent of any single fact's status. | — |
| `acceptanceModel` | What "done" looks like for the goal/requirements. | `CriterionSchema` (`description`, `met: boolean`) — already exists, unchanged. |
| `facts` | The ledger described in §1.2 — the actual unit gaps are tracked against. | New within the Artifact's content shape; not a new domain entity. |

### 1.2 The fact ledger: `KNOWN / ASSUMED / UNKNOWN / DECIDED / DEFERRED`

Every fact relevant to the goal — whether surfaced from a requirement, a
constraint, a risk, or discovered during drafting — is an entry `{ id,
statement, status, ...}` in the ledger, with exactly one status at a time:

- **`KNOWN`** — verified. Backed by something that already exists and is
  checkable: repository content, an accepted DDR, an existing test, an
  explicit prior statement from a human. Not a belief; a fact.
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
  step). A `DECIDED` fact carries a reference to that `Decision`. It does
  not revert to `UNKNOWN` inside the same Definition lineage; a later
  Definition version may reopen it only by recording a new `Decision`.
- **`DEFERRED`** — a real, acknowledged gap that is explicitly *not*
  required to be resolved for the bounded scope currently being defined.
  This is the status that makes the "not the whole future system" half of
  the invariant (§0) mechanical rather than aspirational: a Definition can
  carry any number of `DEFERRED` facts about the wider `Objective` and
  still be ready (§2) for the narrow `WorkItem` at hand.

`DEFERRED` is not a weaker `UNKNOWN` and `ASSUMED` is not a weaker
`KNOWN` — they are different answers to "why isn't this resolved," and
§3's gap classification depends on keeping them distinct.

## 2. Readiness rubric

A Definition version is evaluated against seven dimensions. Each is a
pass/fail-with-reason check, scoped to **the one bounded `WorkItem` this
Definition is about to authorize** — not the entire `Objective`. That
scoping is what lets a Definition be ready while still carrying open
`DEFERRED`/`UNKNOWN` facts about the larger idea; it is the rubric's
enforcement point for §0's invariant.

1. **Outcome** — is `goal` a single, concrete statement (not a category
   like "make it better")? Could a reader tell, in principle, whether the
   eventual work satisfies it?
2. **Boundary** — does `nonGoals` meaningfully exclude adjacent scope, so
   the `WorkItem` this authorizes has an actual edge, not an open-ended
   one?
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
   block the bounded scope (as opposed to `UNKNOWN` facts that are real
   but irrelevant to this particular `WorkItem`, which are candidates for
   `DEFERRED` rather than blockers — see §3)?

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
- **`EXPLORE_AS_WORK`** — the gap can't be closed by reasoning or a quick
  human call; answering it requires actually doing bounded investigative
  work (a spike, a prototype, research against the real codebase or a real
  external system). Resolution: **not** resolved inline. It becomes its
  own bounded `WorkItem` — an investigation, created `draft` like any
  other `WorkItem` per DDR-033 §5's "agents propose, deterministic systems
  authorize" — whose output (evidence, findings) feeds the *next*
  Definition version as new facts. This mirrors D.1a's own precedent: the
  spike investigation that ran before D.1b touched production code was
  exactly this pattern, informally.

A single Definition round may produce gaps in more than one bucket at
once (§4.1 below has three), and buckets are handled independently and in
parallel where they don't depend on each other — `CAN_RESOLVE` gaps don't
wait on a `HUMAN_DECISION` gap's checkpoint to resolve, unless one fact
genuinely depends on another.

## 4. Worked behavior

### 4.1 Early-stage idea: "Make Evershift multiplayer-capable"

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
- Additional facts surfaced while drafting: "the current build is
  single-player with no network layer at all" (`UNKNOWN` — nobody has
  confirmed this against the actual codebase yet), "players expect
  cross-platform play" (`ASSUMED` — carried over from the idea's phrasing,
  not confirmed).

**Readiness check against v1** fails on:

- Dimension 2 (boundary) — no `nonGoals`; "multiplayer-capable" is
  unbounded as stated (voice chat? matchmaking? spectating? all
  unaddressed).
- Dimension 3 (critical constraints) — nothing captured about
  latency/platform requirements that would shape the work.
- Dimension 5 (risky assumptions) — "the current build has no network
  layer" is `UNKNOWN`, not `ASSUMED`, but it's exactly the kind of fact
  that would invalidate the whole approach if wrong; the *cross-platform*
  assumption is `ASSUMED` and would reshape the design if false.
- Dimension 6 (acceptance) — `acceptanceModel` is empty.

**Gap classification:**

- Missing `nonGoals` (dimension 2) → `CAN_RESOLVE` — a first pass at
  exclusions (no voice chat, no matchmaking, no spectator mode, in this
  bounded increment) can be written directly from the stated goal without
  a human or investigation.
- Missing acceptance criteria (dimension 6) → `CAN_RESOLVE` similarly,
  once the requirements are stated concretely enough.
- "The current build has no network layer" (`UNKNOWN`, dimension 5) →
  `EXPLORE_AS_WORK` — this is a factual claim about the actual codebase,
  not a judgment call; it becomes a small investigation `WorkItem`
  ("confirm current networking capability of Evershift's codebase") whose
  findings return as a new, now-`KNOWN`, fact.
- "Players expect cross-platform play" (`ASSUMED`, dimension 5) →
  `HUMAN_DECISION` — whether cross-platform support is in scope for this
  increment is a product tradeoff (cost/timeline vs. reach), not something
  an agent should assume its way past. Routed to a checkpoint.

**Resolution:** the two `CAN_RESOLVE` gaps produce revised sections
immediately. The `EXPLORE_AS_WORK` investigation runs and reports back:
"no network layer exists; would require a new state-sync subsystem." The
`HUMAN_DECISION` checkpoint returns a `Decision`: cross-platform play is
explicitly **out** of scope for this increment (same-platform only).

**Definition v2** incorporates all of it: "no network layer exists" is now
`KNOWN` (from the investigation's evidence); "cross-platform" is now
`DECIDED` as *excluded*, which also lets it be restated as an explicit
`nonGoal` rather than staying an open fact; `nonGoals` and
`acceptanceModel` are filled in from the `CAN_RESOLVE` round. Anything
about *later* multiplayer expansion (voice, matchmaking, spectating,
eventually revisiting cross-platform) is explicitly marked `DEFERRED` —
real, not forgotten, not blocking.

**Readiness against v2**, evaluated for the bounded scope "add a
same-platform two-player real-time session to Evershift" (not "finish
multiplayer"), now passes all seven dimensions. A `WorkProposal` can be
authorized into a real, `draft` `WorkItem` (DDR-033 §5) — while the
`Objective` as a whole still carries several `DEFERRED` facts about
everything beyond same-platform play, entirely by design.

### 4.2 Mature-spec example: no forced ideation

A request that already arrives essentially fully specified — e.g. "add a
`GET /objectives/:id/history` endpoint that returns an Objective's status
transitions, following the exact pattern `GET /objectives/:id` already
uses" — produces a **Definition v1** where nearly every fact starts
`KNOWN` (the existing route pattern, the existing `inWorkspace` guard, the
existing event log to read from), `nonGoals` is implicit and narrow (no
new entity, no new event types), and `acceptanceModel` is a direct
restatement of the ask. No `ASSUMED`, `UNKNOWN`, or open gap exists to
classify. Readiness passes on v1, with zero `HUMAN_DECISION` or
`EXPLORE_AS_WORK` gaps generated, straight to a ready `WorkItem`.

This is the deliberate proof that the methodology has no fixed number of
rounds and no mandatory ideation ritual — §2's rubric is evaluated
against whatever facts already exist, and a request that starts mature
simply has nothing left to resolve. The loop's length is a function of
how much genuine gap exists, never a process requirement imposed on top.

## 5. What D.3a deliberately does not build

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

## 6. What D.3b–D.3d build against this contract

```text
D.3a  this document — Definition semantics, readiness rubric,
      gap classification, worked behavior. No code.
  ↓
D.3b  minimal Definition -> review -> refine loop: a define-work
      workflow producing/versioning real Definition Artifacts,
      a review-kind step implementing §2's rubric mechanically,
      CAN_RESOLVE handled inline.
  ↓
D.3c  human Decision integration: HUMAN_DECISION gaps wired to a
      real checkpoint step and the existing Decision entity;
      EXPLORE_AS_WORK gaps wired to real investigation WorkItems;
      DEFER wired to the ledger's DEFERRED status.
  ↓
D.3d  early / partial / mature behavioral proof: end-to-end tests
      reproducing §4's worked scenarios (and comparable ones)
      against the real implementation, not this document's prose.
```

Each of D.3b/D.3c/D.3d is reviewed independently, following the same
pattern as D.1a→D.1b→D.1c and D.2→D.2.1→D.2.2: implement, report the
exact SHA and CI run, stop for review before the next sub-phase.
