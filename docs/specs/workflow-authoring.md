# Workflow Authoring

**Type:** spec · **Status:** draft · **Updated:** 2026-06-21
**Depends on:** [types.md](../reference/types.md), [workflow-execution.md](workflow-execution.md), [step-kind-reference.md](step-kind-reference.md), DDR-031
**Source material:** new (DDR-031)

## Overview

This spec defines how a user creates a new `WorkflowDefinition` — a
reusable, named unit of work the chat router can dispatch alongside the two
built-in workflows (`full-build`, `draft-artifact`). There is **no bespoke
builder UI**: authoring a workflow is running the `draft-artifact` workflow
with output type "workflow definition." The same claim/commit mechanism that
governs every other artifact governs a `WorkflowDefinition`'s lifecycle —
there is no special-cased creation endpoint (DDR-031, WG-005).

A `WorkflowDefinition` is a skill-style document: front matter declaring its
identity and step graph, plus a body of per-step natural-language
instructions an agent reads when executing that step. This mirrors how a
Claude Code skill is structured — a document an agent loads and follows,
not a hardcoded program.

**Canonical types:** [../reference/types.md](../reference/types.md) §4.
**Step kinds available to authors:** [step-kind-reference.md](step-kind-reference.md) Part 1.
**Execution semantics:** [workflow-execution.md](workflow-execution.md).

---

## Storage

A `WorkflowDefinition` lives at `.sle/workflows/{id}.md`, one file per
workflow. `{id}` is the `workflow_id` used in `POST /api/v2/workflow-runs`
and in `WorkflowRun.workflow_id`.

```
.sle/workflows/
  full-build.md          (builtin, reserved id)
  draft-artifact.md      (builtin, reserved id)
  auth-contract-review.md  (user-authored example)
```

Built-in ids (`full-build`, `draft-artifact`) are reserved. A user-authored
workflow cannot declare either id — committing a document with a reserved
id is rejected at commit time with `reserved_workflow_id`.

## Document shape

```markdown
---
id: auth-contract-review
version: 1
trigger:
  description: "Review a proposed API contract for one group against its requirements"
  examples:
    - "review the auth contract"
    - "check the rate-limiting API against requirements"
checkpoints: [confirm-target]
output_contract:
  artifacts:
    - ref_pattern: "node:{group}:contract-review"
      scope: group
created_by: user
created_at: 2026-06-21T10:00:00Z
steps:
  - id: gather-context
    kind: gather
    input_context: ["node:{group}:architecture", "node:{group}:requirements"]
  - id: confirm-target
    kind: checkpoint
  - id: review-contract
    kind: produce
    agent_role: critic
    input_context: ["node:{group}:architecture", "node:{group}:requirements"]
    output_artifact:
      ref_pattern: "node:{group}:contract-review"
      scope: group
  - id: commit-review
    kind: commit
    logs_decision: true
---

## gather-context

Load the target group's architecture and requirements documents...

## confirm-target

Present the target group to the user for confirmation before reviewing...

## review-contract

Acting as the Critic, evaluate the architecture against requirements for
internal consistency and contract completeness...

## commit-review

Write the review to `node:{group}:contract-review`, release the claim, and
log a decision entry summarizing the verdict.
```

The front matter is the `WorkflowDefinition` (DDR-031 §types). The body is
one markdown section per `step.id`, giving the agent role natural-language
instructions for that step — the same authoring pattern as a per-role
prompt template (see [prompt-templates.md](prompt-templates.md)), scoped to
a single step instead of a whole role.

## Authoring is just `draft-artifact`

There is no `POST /api/v2/workflows` creation endpoint. To author a
workflow:

1. Dispatch `draft-artifact` with `output_type: "workflow definition"` and a
   natural-language description of what the new workflow should do.
2. `draft-artifact`'s `produce` step generates the front matter + step body
   above, using [step-kind-reference.md](step-kind-reference.md) Part 1 as
   its reference for valid step shapes.
3. `draft-artifact`'s `checkpoint` step presents the generated definition for
   user review — the same checkpoint mechanism as any other `draft-artifact`
   run.
4. `draft-artifact`'s `commit` step writes `.sle/workflows/{id}.md`,
   validates the id isn't reserved, and releases the claim.

The moment that commit succeeds, the new workflow is visible to the chat
router (see [conversation.md](conversation.md) §Workflow selection) for
matching against future free-text chat — no separate registration step,
restart, or cache invalidation.

## Validation at commit time

| Check | Failure | Response |
|---|---|---|
| `id` matches an existing reserved builtin | `reserved_workflow_id` | Commit rejected, draft-artifact halts with error |
| `id` collides with a different user workflow's existing id at a different version | Treated as a new `version`, not a new id | Commit proceeds, `version` increments |
| Any `step.kind` not one of the six `StepKind` values | `invalid_step_kind` | Commit rejected |
| A `review` step's `on_fail.target_step_id` does not reference a `produce` step in the same `steps` array | `invalid_on_fail_target` | Commit rejected |
| No `checkpoint` step declared anywhere | Allowed — a workflow may be fully unattended | — |
| Multiple `checkpoint` steps declared | Allowed — same exclusivity-by-construction rule as `full-build` | — |

## Worked example: SCOPING as a composable pattern

`full-build`'s SCOPING group (`gather` → `produce` → `checkpoint`) is the
canonical example of step composability cited when authoring new workflows.
A short, single-purpose workflow can reuse the same three-step shape —
gather existing context, draft something, pause for confirmation — without
needing any of `full-build`'s other eleven steps. This is precisely the
shape `draft-artifact` itself uses internally.

## Constraints

1. **No bespoke builder UI.** Workflow creation has no UI beyond chat +
   `draft-artifact`'s normal checkpoint/commit flow.
2. **Reserved ids are immutable.** `full-build` and `draft-artifact` cannot
   be overridden by a user-authored document of the same id, in this
   version of the spec (DDR-031, WG-006 — open whether a future version
   allows overriding only the `trigger.description`).
3. **Visibility is commit-gated.** A `WorkflowDefinition` is invisible to
   the chat router until its commit step succeeds — there is no "draft"
   visibility state for workflows, consistent with how every other artifact
   becomes referenceable only at commit (DDR-031, "Cross-referencing
   unfinished work").
4. **Six step kinds only.** Authors cannot declare new step kinds. If the
   six are insufficient for a use case, that's a signal to file the gap as
   an open question against this spec, not to special-case a workflow.

## Open questions

| ID | Question | Impact | Status |
|---|---|---|---|
| WA-001 | Can a user-authored workflow be edited (versioned) in place, or must changes always create a new id? | Authoring UX | Open |
| WA-002 | Should `draft-artifact` validate the generated step graph (e.g. detect unreachable steps) before presenting it at the checkpoint, or leave that entirely to user review? | Authoring safety | Open |
| WG-006 | Can user-authored workflows override a built-in's trigger description without touching its steps? | Router behavior | Open (carried from DDR-031) |
