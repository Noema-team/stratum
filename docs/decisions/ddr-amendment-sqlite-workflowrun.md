# DDR Amendment: SQLite as Canonical WorkflowRun Store

**Amends**: DDR-031 (Workflow Engine), DDR-032 (Control Plane)  
**Status**: Accepted  
**Date**: 2026-08-30

## Summary

SQLite is the canonical store for `WorkflowRun` lifecycle state. The `map.yaml`
file inside `.sle/` retains workflow definitions, planning artifacts, and
observability metadata, but is **not** the source of truth for which step the
engine is currently executing or whether a run is halted at a checkpoint.

## Canonical State Boundary

| State | Canonical Store |
|---|---|
| WorkflowRun cursor (current_step_id, status, awaiting_checkpoint, iteration, revision) | SQLite `workflow_runs` table |
| StepExecution records | SQLite `step_executions` table |
| Decision records | SQLite `decisions` table |
| WorkItem state | SQLite `work_items` table |
| Workflow definitions (.steps, .max_iterations) | In-memory registry (registered at startup via `registerWorkflow`) |
| Planning artifacts, agent outputs | `.sle/` directory (RuntimeMap / RunArtifacts) |
| Observability metadata (node status in map.yaml) | `.sle/map.yaml` (legacy, advisory-only) |

## WorkflowRunRepository Invariants

1. **`createOrValidate(run)`** — INSERT OR IGNORE; if row exists, verify
   `workflow_id` and `work_item_id` match. Throws `WorkflowRunConflictError`
   on identity mismatch (a programming error, never silently tolerated).

2. **`update(run)`** — UPDATE by `run_id`; throws if `changes === 0`.
   The engine is fail-closed: a failed persist propagates as an error rather
   than allowing the engine to falsely claim a lifecycle transition succeeded.

3. **Cursor invariant**: `current_step_id` = the next step eligible to execute.
   The cursor advances to step `N+1` only after step `N` completes successfully.
   The cursor is never left pointing at a step that has already been executed
   (except for the step currently executing, which holds the cursor until done).

## `.sle/` Directory Role

`.sle/` contains config, workflow definitions (legacy YAML form), and artifacts:

- `map.yaml` — RuntimeMap: planning depth, cycle metadata, per-node observability
  status. Written by the engine as advisory telemetry; never read back for
  control-plane decisions.
- `runs/<cycle>/<iteration>/` — run artifacts (prompts, responses, diffs).
- `workflow_definitions/` — legacy YAML form of workflow definitions; new
  workflows are registered in-process via `registerWorkflow()`.

## RuntimeMap Writes — Legacy Debt

The following `mapManager` calls in the engine are retained for FullBuild
backward compatibility only and are **not** control-plane logic:

- `mapManager.read()` — only used to initialise `max_iterations` for legacy
  callers that don't supply it through `WorkflowDefinition.max_iterations`.
- `mapManager.update()` — advisory sync of iteration state; the engine's
  local `iteration` variable is authoritative.
- `runArtifacts.createRunDir/createManifest` — observability artefacts; wrapped
  in try/catch (failure is non-fatal).

These calls will be removed once `CycleRunner` and `DAGRunner` are deleted.

## Checkpoint/Resume Architecture

```
Scheduler.tick()
  → StepExecution(state='dispatched')
  → WorkItem(state='running')
  → adapter.execute()
      → WorkflowEngine.run()
          → createOrValidate WorkflowRun
          → ... execute steps ...
          → checkpoint: updateRunCursor(halted, awaiting_checkpoint=step)
          → return {status:'halted'}
  → outcome=='blocked'
  → StepExecution(state='waiting')
  → Decision(type='checkpoint', subjectRef.workflowRunId=...)
  → WorkItem(state='needs_decision')

POST /decisions/:id/resolve (checkpoint Decision)
  → ResumeService.resume()
      → verify Decision pending + type=checkpoint
      → verify WorkflowRun halted + awaiting_checkpoint matches subjectRef.stepId
      → if reject: cancel WorkItem + halt run, done
      → [atomic transaction]:
          StepExecution(waiting→succeeded)
          Decision(pending→resolved)
          WorkItem(needs_decision→running)
          WorkflowRun cursor advance past checkpoint
          StepExecution(state='dispatched') for continuation
      → adapter.execute(workflowRunId, startStepId=continuationStep)
          → WorkflowEngine.run(): createOrValidate is no-op (row exists)
          → loads persisted iteration/revision from row
          → continues from continuationStep
      → outcome=='succeeded' → WorkItem(state='in_review')
```
