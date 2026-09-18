# DDR-033 — Technology-independent software lifecycle

**Date:** 2026-09-02 · **Status:** accepted
**Affects:** README.md, CURRENT_FOCUS_INTENT_TO_READY_WORK.md (Milestone D implementation plan), VISION.md. No changes to DDR-031 or DDR-032 specs.

## Context

DDR-031 replaced the fixed 15-node DAG with six generic `StepKind`s and
`WorkflowDefinition`s. DDR-032 layered a control plane (`Workspace` →
`Project` → `Objective` → `WorkItem` → `WorkflowRun` → `StepExecution`,
plus `Decision`/`Evidence`/`Artifact`/`Event`) above that kernel and is
substantially implemented: SQLite-backed domain entities, the generic
step engine running `full-build` and `draft-artifact`, `WorkService`,
`Scheduler`, durable checkpoint `Decision`s, and an early control-plane
API/dashboard all exist in the current tree.

What the repository does not yet decide explicitly is what the *next*
layer of product work — turning still-forming human intent into bounded,
ready WorkItems — is allowed to touch, and what it must not touch. Two
risks motivate recording this now, before that work starts:

1. **Scope-creep risk.** "Intent → Work" sounds like it needs new
   domain nouns (`Requirement`, `Specification`, `Research`,
   `Proposal`) and a new kernel concept for how mature an idea is. Both
   would violate DDR-032 Law 5 (new concepts must earn permanence) and
   Law 6 (the kernel stays boring) if added reflexively.
2. **Stale-documentation risk.** The root `README.md` still describes
   the pre-DDR-031 daemon/DAG architecture (`dag-runner.ts`, a 5-state
   machine, a 15-node DAG) as if it were current. Anyone reading it
   before the control-plane code would form the wrong mental model of
   the system they are about to extend.

## Options considered

1. **Start Milestone D implementation directly, document architecture
   as a side effect.** Rejected — the scope-creep risk above is
   exactly what happens when architectural boundaries are inferred
   from code review after the fact instead of decided up front.
2. **Add a new kernel-level `IntentMaturity` state machine and
   `Requirement`/`Specification` entities now, since Milestone D is
   substantial enough to justify them.** Rejected — no implementation
   yet exists to demonstrate the entities have independent lifecycle
   semantics that `Artifact` cannot represent (DDR-032 Law 5, test 4).
   `WorkProposal` is deliberately introduced as a validated-schema
   `Artifact`, not a new entity, until real usage proves otherwise.
3. **Record the direction as a DDR before writing implementation
   code, and correct the README to match current reality.** Chosen.

## Decision

1. **Stratum targets an end-to-end lifecycle:** `intent → work →
   execution → verification → delivery`. Milestone D (intent → ready
   work) is the next increment of that lifecycle; it does not replace
   or reopen the control plane DDR-032 already accepted.
2. **Discover / Define / Design / Build / Verify / Deliver are
   workflow-level concepts, not kernel states.** They are expressed as
   `WorkflowDefinition`s composed from the existing six `StepKind`s
   (`gather`, `produce`, `review`, `checkpoint`, `execute`, `commit`),
   the same way `full-build` already expresses the legacy
   SCOPING→...→SNAPSHOT methodology. No new `StepKind` is added for
   this milestone.
3. **Technology-specific behavior belongs in workflows, context,
   capabilities, adapters, and evidence collectors** — never in a
   `ProjectType`/technology enum in the kernel. A workflow step's
   behavior for a web repository versus a Godot project versus
   embedded firmware comes from repository content and declared
   context, not from kernel branching.
4. **Requirements, design, and research remain `Artifact`s** until a
   concrete implementation demonstrates distinct lifecycle semantics
   that `Artifact` cannot express (DDR-032 Law 5). This includes the
   Definition Artifact (tracking KNOWN/ASSUMED/UNKNOWN/DECIDED/DEFERRED
   facts) and the WorkProposal Artifact — neither becomes a first-class
   domain entity in this milestone.
5. **Agents propose WorkItems through a WorkProposal artifact;
   deterministic services apply them.** An agent step may write a
   WorkProposal Artifact. Only a deterministic `WorkProposalService`
   may turn an approved proposal into real `WorkItem`s, created as
   `draft`, never as `ready` — consistent with DDR-032 Law 2 (agents
   propose, deterministic systems authorize).
6. **The stable kernel vocabulary remains intentionally small.** This
   milestone adds no new entities to the DDR-032 §7 domain model
   (`Workspace`/`Project`/`Repository`/`Objective`/`WorkItem`/
   `WorkflowRun`/`StepExecution`/`Decision`/`Policy`/`Evidence`/
   `Artifact`/`Event`) and no new `StepKind`s to the DDR-031 kernel.

## Consequences

- The detailed phased implementation plan for this direction lives in
  `CURRENT_FOCUS_INTENT_TO_READY_WORK.md` and is reviewed
  independently per phase (D.0–D.5); this DDR records the boundary
  those phases must not cross, not the phase plan itself.
- `README.md` is corrected in the same change as this DDR to describe
  the current control-plane/WorkflowEngine architecture instead of the
  pre-DDR-031 daemon/DAG description.
- Any future PR that adds a new `StepKind`, a new top-level domain
  entity, or technology-specific kernel branching in service of this
  milestone is a violation of this DDR and should be rejected in
  review, per the DDR-032 Appendix B checklist.

## Explicitly deferred

- Whether `WorkProposal`, Definition, or research Artifacts ever
  graduate to first-class entities — deferred until at least one real
  implementation demonstrates the need (DDR-032 Law 5, test 4).
- Deployment/Environment/Release/Promotion/Rollback modeling — out of
  scope for this milestone; see VISION.md Milestones F/G.
