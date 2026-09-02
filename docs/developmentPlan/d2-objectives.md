# D.2 — Objectives

**Status:** Complete.
**Milestone:** D, phase D.2 (see `CURRENT_FOCUS_INTENT_TO_READY_WORK.md` §10,
as amended; follows D.1 — declarative workflow-step contract, closed)

## 1. Goal

Activate the `Objective` domain concept that already existed (schema only,
zero callers) so it can serve as the durable human-intent container above
`WorkItem`s:

```text
Project -> Objective -> WorkItems
```

Objective answers "what outcome are we pursuing?"; a Definition Artifact
(later, D.3) answers "what do we currently understand about it?"; a
WorkItem answers "what bounded work has been authorized?" — three distinct
questions, deliberately not collapsed into one concept.

## 2. What already existed vs. what D.2 added

Already present before D.2: `ObjectiveSchema`/`Objective` type,
`ObjectiveRepository` (save/findById/listByProject/updateStatus),
`WorkItem.objectiveId` as a schema field and DB column. All unused —
nothing constructed an `Objective`, and `WorkItem.objectiveId` was accepted
by `WorkService.createWorkItem` but never validated.

D.2 added:

- `createdAt`/`updatedAt` on `Objective` (migration 9 — every other durable
  entity already had these; `Objective` was the one exception) and the
  corresponding `ObjectiveRepository` plumbing.
- `ObjectiveService` (`src/services/objective-service.ts`): create,
  findById, listByProject — all workspace-scoped and fail-closed — plus
  three guarded lifecycle methods (`activate`/`complete`/`cancel`) over the
  transitions already implied by `ObjectiveStatusEnum` and the `objectives`
  table's `CHECK` constraint (`draft -> active -> completed`, or
  `-> cancelled` from either non-terminal state). No new lifecycle was
  invented — these methods just stop `updateStatus()` from being called
  directly, the same reasoning `WorkService`'s transition table already
  applies to `WorkItemState`.
- Three HTTP routes (`src/api/handlers/objectives.ts`), the entire D.2 API
  surface: `GET /projects/:id/objectives`, `POST /projects/:id/objectives`,
  `GET /objectives/:id`. No `activate`/`complete`/`cancel` routes yet —
  those exist as guarded service methods for later callers, not exposed
  over HTTP in this milestone.
- `WorkService.createWorkItem` now validates a supplied `objectiveId`:
  `objective.projectId === workItem.projectId` is the entire check. Since
  `req.projectId` is already proven to belong to the caller's workspace
  earlier in the same method, this one comparison rejects an unknown
  Objective, a cross-project Objective, and a cross-workspace Objective —
  no separate workspace check was needed. `parentId` (WorkItem
  decomposition) stays unexposed over HTTP; only `objectiveId` was added to
  `POST /projects/:id/work`'s accepted fields.
- `WorkItemRepository.countByObjective()` — a single `COUNT` query, used to
  attach an optional `linkedWorkItemCount` to the Objective read model's API
  responses (not a field on the `Objective` domain type itself).

## 3. What D.2 deliberately did not add

Per the milestone's explicit scope: no `Definition`/`WorkProposal`/
`Requirement` entity, no Objective dependency graph or scheduler, no
automatic WorkItem decomposition, no `define-work` workflow, no readiness/
refinement logic, no Objective context injection into `ContextManager`, no
new `StepKind`s or `AgentRole`s, no `WorkflowEngine` changes, no changes to
the D.1 declarative contract, no Objective strategy dashboard.

## 4. Test coverage

- `tests/objective-service.test.ts` — create/read/list, empty-field
  rejection, restart persistence (fresh service instance over the same DB),
  workspace isolation (cross-workspace create/lookup/list all fail closed),
  and the full guarded-transition matrix (activate/complete/cancel,
  terminal-state rejection, direct draft→completed rejection).
- `tests/commit-b.test.ts` (D.2 section, alongside the existing
  `WorkService.createWorkItem` coverage) — same-project `objectiveId`
  succeeds; cross-project (same workspace) and cross-workspace `objectiveId`
  both rejected with the same `objective.projectId !== workItem.projectId`
  check; nonexistent `objectiveId` rejected; omitting `objectiveId` retains
  prior behavior exactly.
- `tests/api.test.ts` (Objectives section) — all three routes, required-field
  validation, `linkedWorkItemCount`, and the two workspace-isolation cases
  named in the milestone: a `POST` against another workspace's Project
  fails closed, and a `GET` for another workspace's Objective fails closed.
- `tests/storage.test.ts` / `tests/domain.test.ts` — pre-existing
  `ObjectiveRepository`/`ObjectiveSchema` fixtures updated for the new
  required `createdAt`/`updatedAt` fields (caught by running the full suite;
  `tsc --noEmit` does not type-check `tests/` — see `tsconfig.json`'s
  `exclude` — so this class of break is only caught by actually running
  the tests, not by `npm run type-check` alone).

Full `npm run verify` (type-check + build + entire suite) is green.
