# DDR-041: Trusted Definition → Execution Handoff

**Status:** accepted (2026-09-18)
**Trigger:** E5 preflight — a static capability inspection at main `4607af8`, performed before Pilot A preregistration.
**Historical chain:** E4-H qualification closed (Flash NOT QUALIFIED at the 15/15 bar) → E5 preflight performed → H1 ("can canonical Definition flow into implementation without human translation?") **statically falsified** → Pilot A did not start → concrete missing capability identified → one narrow handoff change authorized. This is a pre-Pilot static finding, not Pilot runtime evidence.

## Problem

Two authority chains existed with no trusted connection between them:

```text
define-work → .sle/work/<wi>/definition.md → commit → STOP

caller creates full-build WorkItem → caller-authored goal → scheduler → full-build
```

The builder's context was assembled from project-doc role slices plus the
caller-typed `goal` string; the canonical Definition could reach execution only
through operator paraphrase, a "read this path" pointer, or manual copying —
all forbidden. The existing `inputArtifactRefs` seam was insufficient: refs
materialize against the *current* work item, full-build declares none, and
declaring them *replaces* role-default slices.

## Decision

One sentence:

> **An execution WorkItem names the exact completed define-work WorkItem it
> implements (`workflowParameters.definitionSource`); the system resolves that
> reference through recorded artifact provenance and sha256-pins the canonical
> Definition as authoritative input before any step runs — the model never
> selects, reconstructs, or summarizes it.**

## Mechanism (smallest supported by the existing architecture)

- **Reference**: `workflowParameters: { definitionSource: { workItemId: <A> } }`
  on the execution WorkItem — the existing validated pass-through; no new
  columns, tables, or chaining subsystem.
- **Freeze**: the engine already freezes workflow parameters into
  `WorkflowRun.resolvedParameters` at initial dispatch and restores them from
  the persisted cursor on resume (never re-reading the mutable WorkItem field);
  the adapter already prefers the persisted run's parameters. Resume therefore
  required **zero new code** — the DDR-040 lesson applied by construction.
- **Validation** (`src/execution/definition-source.ts`, fail-closed chain,
  mirroring the dynamic decision-request provenance discipline):
  exact single-key shape → repositories configured → source WorkItem exists →
  same project → Objective matches when the execution WorkItem has one →
  source `completed` → latest-per-ref artifact rows contain **exactly one**
  `type: 'definition'` (zero or many ⇒ fail; no filename/recency/text/Objective
  inference) → recorded path safe and under `.sle/work/` → bytes fit the
  128 KiB authoritative-context boundary (explicit failure, never silent
  truncation) → on-disk sha256 equals the recorded provenance hash (post-commit
  mutation fails) → bytes parse as a canonical Definition.
- **Presentation**: resolved once per dispatch/resume by `StratumAgentAdapter`
  (before any step; failure aborts the run rather than degrading to goal text),
  threaded through `WorkflowEngine` onto every `StepRunContext`, rendered by
  `ContextManager` verbatim under its own `## AUTHORITATIVE DEFINITION` header
  with source WorkItem, artifact ref, and pinning hash. Role-default context is
  untouched — the Definition is added, never substituted for the slices.

## Alternatives considered and rejected

- **`inputArtifactRefs` on full-build steps** — would replace role-default
  slices and materialize against the *execution* work item's directory (no
  cross-work-item reference exists); wrong seam.
- **Automatic spawn of a full-build WorkItem at define-work commit** — generic
  chaining is out of scope; a frozen explicit reference closes the invariant
  without an orchestration subsystem.
- **Goal overloading (operator pastes/points at the Definition)** — operator
  translation, explicitly forbidden.
- **Copying the Definition into `.sle/project-docs/`** — manual augmentation;
  destroys provenance and single-source authority.

## Not solved here (deliberately)

Pilot PR creation, ci-toolkit status consumption, define-work → full-build
auto-spawning, multi-task orchestration. If Pilot A later evidences any of
these as real deficiencies, they get their own DDR.

## Regression

`tests/d35-ddr041-definition-execution-handoff.test.ts` — 20 tests: resolver
fail-closed matrix (shape, deps, missing execution/source WorkItem,
cross-project, Objective mismatch, not-completed, zero/ambiguous provenance,
hash-pin mutation, invalid bytes, oversized, cross-work-item substitution),
parameter contract, generic-workflow passthrough, verbatim ContextManager
rendering with role-default slices preserved, and the live lifecycle through
the real adapter + engine: dispatch halts at the scoping checkpoint with every
step carrying the verbatim Definition; the reference freezes into
`resolvedParameters`; a post-halt mutation of the WorkItem's parameters cannot
substitute a source; resume (exactly as ResumeService dispatches it) runs
through BUILD with byte-identical authority; unverifiable provenance aborts
before any model-visible step.
