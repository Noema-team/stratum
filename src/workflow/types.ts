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

  // commit — write + claim-release; optionally appends to decisions log
  logs_decision?: boolean;

  // conditional steps — skipped when predicate returns false
  skip_if?: (ctx: WorkflowStepContext) => boolean;

  // iteration cap check: which review step triggers the cap
  is_iteration_gate?: boolean;
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
}
