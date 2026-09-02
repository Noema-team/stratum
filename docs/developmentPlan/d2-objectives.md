# D.2 — Objectives

**Status:** Complete, including the D.2.1 correction (§5). D.2 is closed.
**Milestone:** D, phase D.2 → D.2.1 (see `CURRENT_FOCUS_INTENT_TO_READY_WORK.md`
§10, as amended; follows D.1 — declarative workflow-step contract, closed)

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

## 5. D.2.1 — review corrections

D.2's architecture was accepted; review found two correctness gaps and asked
for a more realistic restart test. Nothing here changes D.2's lifecycle, API
surface, WorkItem-linkage semantics, or `linkedWorkItemCount` — narrowly
scoped fixes only.

### 5.1 `ObjectiveSchema` is now actually enforced at the persistence boundary

The HTTP handler only ever checked `Array.isArray(b.constraints)` /
`Array.isArray(b.successCriteria)` and cast the contents — `constraints:
[null]` or `constraints: [{ foo: 'bar' }]` would pass that check and reach
`ObjectiveRepository.save()` unvalidated, even though `ObjectiveSchema`
already declares `constraints`/`successCriteria` as arrays of structured
`Constraint`/`Criterion` elements.

Fixed at the one place everything routes through before persistence:
`ObjectiveService.create()` now runs the fully-constructed candidate object
through `ObjectiveSchema.safeParse()` — the existing schema, not a new one —
immediately before `this.objectives.save(...)`. This covers every field
`ObjectiveSchema` declares (title/description/priority/status/timestamps
included), not just the two nested-array fields review named explicitly. A
failure is translated into `ObjectiveServiceError('...', 'BAD_REQUEST')`
with a short, path-qualified summary of the Zod issues (e.g.
`constraints.0: Required`) — never the raw `ZodError`. `BAD_REQUEST` was
chosen deliberately: it's already a registered `HTTP_STATUS` key (400), so
the API layer needed no changes to map it correctly, unlike several
pre-existing `WorkServiceError` codes (e.g. `REPO_NOT_FOUND`) that still
fall through to 500 — a known, separate gap, not touched here.

### 5.2 Backfill migration for pre-D.2.1 NULL Objective timestamps

Migration 9 added `created_at`/`updated_at` as nullable columns ("existing
rows get NULL" — the standard convention for every `ADD COLUMN` migration in
this file). Once `ObjectiveSchema` requires `TimestampSchema` (a valid
ISO-8601 string) for both, a row written before that requirement existed
would type as `string` at compile time while reading back as runtime `null`.

Migration 10 backfills, once, conservatively: `created_at IS NULL` rows get
a fixed migration timestamp; `updated_at IS NULL` rows fall back to the
row's `created_at` (by then always non-null, whether original or
just-backfilled in the same migration). Existing non-null values are never
touched. No table recreation — the columns stay nullable at the schema
level; the guarantee that no NULL survives comes from the one-time backfill
plus every future write going through `ObjectiveService`, which always
supplies both fields.

### 5.3 A real file-backed restart test, plus a migration-compatibility fixture

The D.2 "restart" test only constructed a second `ObjectiveService` over the
same in-memory `Database` handle — it never actually closed and reopened
anything, so it couldn't have caught a real persistence bug. Kept (as a
cheap same-handle sanity check) and supplemented with a genuine
close/reopen test against a temp-directory DB *file*.

Also added: `MIGRATIONS` is now exported (read-only) from
`storage/database.ts` specifically so a test can construct a DB at exactly
the migration-9 checkpoint, insert an `Objective` row with `NULL`
timestamps the way pre-D.2.1 raw SQL would have, and then open it normally
— proving migration 10 backfills that row into something
`ObjectiveService`/`ObjectiveSchema` accept as fully valid, and a sibling
test proving an already-timestamped row is left untouched.

### 5.4 Recorded, not fixed here

Confirmed during D.2 review: `tsconfig.json` excludes `tests/` from
`tsc --noEmit`, so `npm run type-check` alone cannot catch a test fixture
that no longer matches a changed domain schema — only actually running the
suite does. This is real CI debt worth hardening later (e.g. a second
tsconfig covering `tests/`, or including them under `strict` in some form),
but per review instruction it is out of scope for D.2.1 and was not
touched.

Full `npm run verify` (type-check + build + entire suite) is green.
