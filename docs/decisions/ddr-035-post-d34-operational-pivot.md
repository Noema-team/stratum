# DDR-035: Post-D.34 Operational Pivot

**Status:** accepted (2026-09-15)
**Supersedes:** the build-first cadence of DDR-034's slice plan (C1–C7)
**Companion plan:** `docs/developmentPlan/post-d34-roadmap.md`

## Decision

With D.34 frozen, the project changes modes: **from building the machinery needed to
trust agent output, to proving that the machinery can reliably produce useful software
work.** New architecture is added only when a real run demonstrates that something is
missing.

Three eras frame the roadmap:

```text
Era I   — trustworthy agent boundary   (COMPLETE: DDR-034 / D.34, C1–C7)
Era II  — trustworthy autonomous worker (STARTS NOW: qualification → Pilot A →
          evidence-driven hardening → multi-task pilot)
Era III — usable autonomous development platform (many repos, concurrent agents,
          minimal UI, remote control, external quality evidence, long-duration
          operation) — explicitly NOT the current goal
```

Building Era III now would reproduce the speculative control-plane growth this project
has systematically removed.

## Operating rules (binding from the moment D.34 freezes)

1. **Pilots create the milestones.** No architectural milestone is planned in advance.
   A concrete deficiency observed in a real run — with tier, evidence, and frequency —
   is the only valid trigger for new architecture.
2. **Never patch mid-pilot.** When a defect appears during a measurement run, the run
   finishes or is deliberately aborted; the deficiency is recorded with its diagnosis
   and evidence; the patch is narrow; the run is repeated. Patching inside a running
   pilot destroys the reliability measurement.
3. **Evidence before architecture.** Same discipline as D.34's review gates: observe a
   violated invariant, patch narrowly, re-run. "Respond to evidence" stages have one
   failure mode — resuming building whenever a run is clean. A clean run advances to
   the next stage immediately; it never triggers a refactor impulse.
4. **Clean results increase difficulty.** A clean run triggers the next harder
   experiment, never a refactor. "Respond to evidence" stages have one failure mode —
   resuming building whenever a run is clean.
5. **Capability-specific qualification.** Models are qualified for roles/capabilities
   (e.g. `define-work` semantic reasoning), not globally labeled good or bad.
6. **Success criteria are pre-registered.** Pilot A's criteria are written down before
   launch (see companion plan) so outcomes cannot be rationalized post hoc. Both
   "passed" and "instructive failure with diagnosis" are valid outcomes; only an
   undiagnosable run is a bad one.
7. **ci-toolkit stays external.** GitHub owns branches/commits/PRs; ci-toolkit owns
   quality evidence and merge confidence; Stratum consumes both as fail-closed
   external evidence attached to work. Stratum does not duplicate CI logic or absorb
   the toolkit.
8. **Pilots run against immutable revisions.** Baseline SHA, model id, provider,
   temperature, max tokens, scenario definitions, and repetition counts are recorded
   before the run and unchanged while it runs.

The companion plan (`docs/developmentPlan/post-d34-roadmap.md`) turns this decision
into gated milestones E0–E10, each with a concrete deliverable and exit decision.
Nothing beyond E10 is planned in detail — the experiments exist to determine what
comes afterward.

## Rationale

D.34 answered "can we safely accept AI-produced state?" — yes, via contracts,
validation, system materialization, and fail-closed transport. None of that proves a
single autonomous process can deliver good software. The next unknowns (model
suitability, end-to-end delivery, unattended recovery, multi-task orchestration) are
empirical questions; architecture spent before the evidence arrives is the rot vector
this decision exists to prevent.
