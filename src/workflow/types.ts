import type { AgentRole, FailureReport, FacilitatorMode } from '../types.js';

// ============================================================================
// Step kinds — six generic primitives (DDR-031)
// ============================================================================

export type StepKind = 'gather' | 'produce' | 'review' | 'checkpoint' | 'execute' | 'commit';

// ============================================================================
// WorkflowStep — one node in a workflow's step graph
// ============================================================================

// A step's exact, narrow output contract (D.1b). Declaring this NARROWS the
// role's broad write-path ceiling (ROLE_OUTPUT_PATHS in agent-runner.ts) —
// it never bypasses it. See docs/developmentPlan/d1a-declarative-contract-spike.md §5.
export interface DeclaredOutputArtifact {
  type: string;
  ref: string;
  // Project-root-relative path. Must be exactly the path the step's single
  // output section is written to; validated as safe (no traversal) and
  // against the role's ceiling before any filesystem write.
  path: string;
}

export interface WorkflowStep {
  id: string;
  kind: StepKind;
  label?: string;

  // produce — LLM-driven generation
  agentRole?: AgentRole;
  // templateId is declared by every builtin step but has no resolution
  // semantics yet (D.1a finding) — deliberately left inert in D.1b so
  // full-build/draft-artifact prompts cannot change by accident. Use
  // `instruction` below for the new declarative channel.
  templateId?: string;
  // D.1b — the step's own instruction, consulted by ContextManager before
  // the legacy NODE_TASK_DESCRIPTIONS map.
  instruction?: string;
  // D.1b — this step's exact declared output. When set, AgentRunner requires
  // the produced output to be exactly one section at this path (cardinality
  // + exact-match), still subject to the role's write-path ceiling.
  outputArtifact?: DeclaredOutputArtifact;
  // D.1b — explicit artifact refs this step's context is built from. When
  // set, ContextManager loads exactly these refs instead of the role's
  // default slice set (getRoleSlices()).
  inputArtifactRefs?: string[];

  // review — pass/fail evaluation; explicit routing on pass/fail
  on_pass?: { target_step_id: string };  // explicit target on pass (default: __next__)
  on_fail?: {
    target_step_id: string;       // must be a 'produce' step in this workflow
    iteration_loop?: boolean;     // increment iteration counter before routing (full-build pattern)
  };
  // D.3c1a — bounded semantic-fail routing. An ALLOWLIST of named routes a
  // requiresReviewVerdict review step authorizes for a semantic `verdict:
  // fail`, each mapping a workflow-declared token to its own target step +
  // iteration behavior. Only meaningful together with requiresReviewVerdict
  // — see the SLE-OUTPUT preamble's `route: <token>` (agent-runner.ts) and
  // WorkflowEngine.executeReview, which maps the token through this table
  // (never the reverse — the model supplies a token, never a step id).
  // A review step that leaves this unset keeps exactly today's single
  // on_fail target, byte-for-byte unchanged. WorkflowEngine itself carries
  // no knowledge of what any route token *means* (no HUMAN_DECISION/
  // CAN_RESOLVE/define-work awareness) — the mapping is pure declarative
  // data the workflow author supplies.
  on_fail_routes?: Record<string, { target_step_id: string; iteration_loop?: boolean }>;

  // commit — write + claim-release; optionally appends to decisions log
  logs_decision?: boolean;

  // D.3c0 — checkpoint: opt-in declarative source for a dynamic
  // DecisionRequest. When set, this checkpoint's halt is resolved by
  // reading, materializing ({workItemId}/{objectiveId}, the same mechanism
  // as outputArtifact/inputArtifactRefs — see artifact-refs.ts), and
  // structurally validating the JSON DecisionRequest at this path (a prior
  // 'produce' step is expected to have written it) — see
  // StratumAgentAdapter.execute(). WorkflowEngine itself never reads this
  // field or the file it names; it is inert here, exactly like templateId,
  // consulted only by the execution-layer checkpoint translation. A
  // checkpoint step that leaves this unset gets the existing generic
  // approve/reject behavior, byte-for-byte unchanged.
  decisionRequestArtifact?: string;

  // conditional steps — skipped when predicate returns false
  skip_if?: (ctx: WorkflowStepContext) => boolean;

  // iteration cap check: which review step triggers the cap
  is_iteration_gate?: boolean;

  // D.3b0 — opt-in semantic review verdict contract. Generic execution
  // success (AgentRunner.success / StepRunOutcome.success) means the LLM
  // call, output parsing, and write succeeded — it is NOT the same thing as
  // whether a review step's semantic judgment passed. Without this flag,
  // WorkflowEngine.executeReview preserves its legacy behavior exactly
  // (execution success routes on_pass, execution failure routes on_fail).
  // With it set, only a successful execution that also produced a parsed
  // `verdict: pass | fail` in the SLE-OUTPUT preamble (see agent-runner.ts)
  // is treated as a semantic judgment; anything else (transport/parse/write
  // failure, or a missing/invalid verdict) halts instead of being routed
  // through on_fail/on_pass as if it were one.
  requiresReviewVerdict?: boolean;

  // D.3b0 — opt-in: render the run's WorkItem constraints/acceptance
  // criteria (threaded in from Scheduler/ResumeService, never queried by
  // ContextManager) into this step's assembled context. See
  // ContextManager.buildTaskDescription. Goal remains available via
  // ctx.goal regardless of this flag; full-build/draft-artifact steps
  // never set it, so their prompts are unaffected.
  includeWorkItemContext?: boolean;

  // D.3b1.1 — opt-in: render the Objective's own human intent (title,
  // description, constraints, successCriteria) into this step's assembled
  // context, under a header visibly separate from the WorkItem section
  // above (see ContextManager.buildTaskDescription). Threaded in the same
  // way as includeWorkItemContext — from Scheduler/ResumeService via
  // ExecutionRequest.objectiveContext, never queried by ContextManager.
  includeObjectiveContext?: boolean;

  // D.3c0 — opt-in: render the human's resolved checkpoint decision (see
  // DecisionContext below) into this step's assembled context, under a
  // header distinct from the Objective/WorkItem sections (see
  // ContextManager.buildTaskDescription). Only a resumed continuation step
  // can meaningfully set this — initial Scheduler dispatch never has a
  // DecisionContext to render.
  includeDecisionContext?: boolean;
}

// ============================================================================
// DecisionContext — an immutable snapshot of a human's resolution of a
// checkpoint Decision, threaded ONLY on ResumeService's continuation
// (Scheduler's initial dispatch never has one to supply). Uses exactly the
// fields already available from the existing Decision + its resolution —
// no new persistence, no new domain entity. Analogous in shape/threading to
// ObjectiveContext above: resolved once by the control plane
// (ResumeService, via DecisionRepository — through the Decision it already
// loads to validate the resume), never queried by WorkflowEngine,
// ContextManager, AgentRunner, or AgentLoop.
// ============================================================================

export interface DecisionContext {
  decisionId: string;
  selectedOptionId: string;
  selectedOptionLabel?: string;
  rationale?: string;
  resolvedAt?: string;
  resolvedBy?: string;
}

// ============================================================================
// ObjectiveContext — an immutable snapshot of an Objective's human intent,
// resolved once at dispatch/resume time by the control plane
// (Scheduler/ResumeService, via ObjectiveRepository) and threaded down
// through ExecutionRequest -> WorkflowEngine.run() -> StepRunContext. This
// is the ONLY way Objective content reaches execution-layer components —
// WorkflowEngine, ContextManager, AgentRunner, and AgentLoop never query
// ObjectiveRepository themselves. A subset of Objective's own fields
// (excludes projectId/priority/status/timestamps, which are control-plane
// bookkeeping, not intent).
// ============================================================================

export interface ObjectiveContext {
  id: string;
  title: string;
  description: string;
  constraints: Array<{ description: string; type?: string }>;
  successCriteria: Array<{ description: string; met?: boolean }>;
}

// ============================================================================
// WorkflowDefinition — the declarative description of a workflow
// ============================================================================

export interface WorkflowDefinition {
  id: string;
  label: string;
  steps: WorkflowStep[];

  // max_iterations applies to workflows that use iteration loops in review steps
  max_iterations?: number;
}

// ============================================================================
// WorkflowRun — per-run state (tracked in map.yaml → workflow_runs.{run_id})
// ============================================================================

export interface WorkflowRun {
  run_id: string;
  workflow_id: string;
  work_item_id?: string;     // linked WorkItem if dispatched via control plane
  status: 'active' | 'halted' | 'complete';
  current_step_id: string;
  iteration: number;
  revision: number;
  awaiting_checkpoint: string | null;
  started_at: string;
  updated_at: string;
  // Validated, frozen workflow parameters for this run.
  // Set at initial dispatch from WorkItem.workflowParameters; never re-read from WorkItem on resume.
  resolvedParameters?: Record<string, unknown>;
}

// ============================================================================
// Step execution context passed to skip_if predicates and step handlers
// ============================================================================

export interface WorkflowStepContext {
  runId: string;
  workflowId: string;
  workItemId?: string;
  iteration: number;
  revision: number;
  // Opaque workflow parameters — full-build reads planning_depth from here.
  workflowParameters?: Record<string, unknown>;
}

// ============================================================================
// Step result — returned by each step handler
// ============================================================================

export type StepOutcome = 'completed' | 'skipped' | 'failed' | 'checkpoint_set';

export interface StepResult {
  outcome: StepOutcome;
  next_step_id: string | null;    // null means the workflow is done (or halted)
  artifacts_written?: string[];
  tokens_used?: number;
  duration_ms?: number;
  error?: string;
  skip_reason?: string;
  // For checkpoint steps — the awaiting_checkpoint value to set
  checkpoint_step_id?: string;
  // Signals the engine to increment WorkflowRun.revision and reset on new iteration.
  // Produced by confirm-revise; the engine handles it generically without step-id checks.
  _increment_revision?: true;
}

// ============================================================================
// Workflow run result — returned by WorkflowEngine.run()
// ============================================================================

export interface WorkflowRunResult {
  run_id: string;
  status: 'complete' | 'halted';
  final_step_id: string | null;
  iterations_used: number;
  error?: string;
}

// ============================================================================
// CapHitAction — returned by onCapHit; replaces raw 'halt' | 'force_pass' strings.
// The full-build adapter maps force_pass → { action: 'route', targetStepId: 'evaluate' }.
// ============================================================================

export type CapHitAction = { action: 'halt' } | { action: 'route'; targetStepId: string };

// ============================================================================
// StepRunner — the narrow seam between WorkflowEngine and the execution layer.
//
// WorkflowEngine calls StepRunner.run(step, ctx) for 'produce' and generic
// 'review' steps. The implementation (e.g. AgentStepRunner) maps step.agentRole
// onto whatever underlying mechanism it wraps (AgentRunner, ExecutionAdapter,
// direct LLM call, …) without leaking legacy DAGNodeId semantics into the engine.
// ============================================================================

export interface StepRunOutcome {
  success: boolean;
  artifacts_written: string[];
  tokens_used: number;
  duration_ms: number;
  error?: string;
  // Optional routing overrides — produce steps may set these to drive iteration
  // increment and/or non-sequential routing (e.g. the debug step after validation failure).
  next_step_id?: string;
  _iterate?: true;
  // D.3b0 — the semantic review verdict, set only when execution succeeded
  // AND the step opted into requiresReviewVerdict (see agent-runner.ts).
  // Absent for every non-opted-in step and for a failed/legacy execution.
  reviewVerdict?: 'pass' | 'fail';
  // D.3c1a — the validated route token, set only when reviewVerdict is
  // 'fail' AND the step declared on_fail_routes AND the model's preamble
  // supplied a token AgentRunner found among that step's declared keys
  // (see agent-runner.ts). Absent whenever on_fail_routes is not declared,
  // regardless of verdict — WorkflowEngine.executeReview still re-validates
  // this token against step.on_fail_routes itself before routing.
  reviewRoute?: string;
}

export interface StepRunner {
  run(step: WorkflowStep, ctx: StepRunContext): Promise<StepRunOutcome>;
  // Optional overrides for non-produce/review kinds. When defined, the engine
  // fully delegates that kind to the runner. When absent, the engine uses its
  // generic fallback (generic checkpoint via onCheckpoint; no-op execute; workflow-
  // end commit).
  handleCheckpoint?(step: WorkflowStep, ctx: StepRunContext): Promise<StepResult>;
  handleExecute?(step: WorkflowStep, ctx: StepRunContext): Promise<StepResult>;
  handleCommit?(step: WorkflowStep, ctx: StepRunContext): Promise<StepResult>;
}

// Execution context passed to StepRunner — the canonical replacement for the
// legacy CycleStateContext. All fields are populated by the engine from its
// own state; adapters must not re-derive them from external sources.
export interface StepRunContext {
  workflowRunId: string;
  workflowId: string;
  stepId: string;
  role?: AgentRole;
  iteration: number;
  revision: number;
  goal: string;
  projectRoot: string;
  // D.1b — the control-plane WorkItem this run is dispatched for, when known.
  // Populated by WorkflowEngine from the workItemId given to run(). Used to
  // link declaratively-recorded Artifact provenance back to the WorkItem.
  workItemId?: string;
  // D.1b — copied from WorkflowStep by WorkflowEngine.makeStepRunContext, the
  // same way `role` is already copied from step.agentRole. See DeclaredOutputArtifact.
  instruction?: string;
  outputArtifact?: DeclaredOutputArtifact;
  inputArtifactRefs?: string[];
  // Workflow parameters frozen at dispatch time (from WorkflowRun.resolvedParameters).
  workflowParameters?: Record<string, unknown>;
  // Populated by debug step from durable failure report on disk.
  failureReport?: FailureReport;
  // Set by confirm-revise when a plan revision note is provided.
  revisionNote?: string;
  // Facilitator operating mode — defaults to 'chat'.
  facilitatorMode?: FacilitatorMode;
  // Ephemeral artifacts injected for a specific step execution.
  ephemeral?: Record<string, string>;
  // Builder source files (from map.yaml repo.key_files).
  sourceFiles?: string[];

  // D.3b0 — WorkItem snapshot, threaded in from Scheduler/ResumeService via
  // ExecutionRequest -> StratumAgentAdapter -> WorkflowEngine.run(), never
  // queried here or by ContextManager/AgentRunner (no ObjectiveService
  // dependency in any of those). objectiveId is execution/provenance
  // context only — used by artifact-refs.ts placeholder materialization —
  // and is not rendered into the assembled context by itself.
  objectiveId?: string;
  workItemConstraints?: Array<{ description: string; type?: string }>;
  workItemAcceptanceCriteria?: Array<{ description: string; met?: boolean }>;
  // Copied from WorkflowStep by WorkflowEngine.makeStepRunContext, same as
  // instruction/outputArtifact/inputArtifactRefs above.
  includeWorkItemContext?: boolean;
  requiresReviewVerdict?: boolean;
  // D.3c1a — copied from WorkflowStep.on_fail_routes by
  // WorkflowEngine.makeStepRunContext, the same way requiresReviewVerdict
  // is already copied. AgentRunner validates a semantic-fail route token
  // against this table's keys (never against a raw step id) — see
  // AgentRunResult.reviewRoute / StepRunOutcome.reviewRoute above.
  on_fail_routes?: Record<string, { target_step_id: string; iteration_loop?: boolean }>;

  // D.3b1.1 — the Objective's own human intent snapshot, threaded in from
  // Scheduler/ResumeService via ExecutionRequest.objectiveContext, resolved
  // once at dispatch/resume time by the control plane (never queried here).
  // See ObjectiveContext and includeObjectiveContext above.
  objectiveContext?: ObjectiveContext;
  includeObjectiveContext?: boolean;

  // D.3c0 — the human's resolved checkpoint decision, threaded in from
  // ResumeService via ExecutionRequest.decisionContext on a resumed
  // continuation only (absent on initial Scheduler dispatch). Rendering is
  // gated by includeDecisionContext — see ContextManager.buildTaskDescription.
  decisionContext?: DecisionContext;
  includeDecisionContext?: boolean;
}
