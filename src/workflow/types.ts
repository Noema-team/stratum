import type { AgentRole } from '../types.js';

// ============================================================================
// Step kinds — six generic primitives (DDR-031)
// ============================================================================

export type StepKind = 'gather' | 'produce' | 'review' | 'checkpoint' | 'execute' | 'commit';

// ============================================================================
// WorkflowStep — one node in a workflow's step graph
// ============================================================================

export interface WorkflowStep {
  id: string;
  kind: StepKind;
  label?: string;

  // produce — LLM-driven generation
  agentRole?: AgentRole;
  templateId?: string;

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
  planningDepth: 'minimal' | 'standard' | 'deep' | 'research';
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

// Execution context passed to StepRunner — a forward-compatible replacement for
// the legacy CycleStateContext. Fields grow as the new path matures; legacy
// callers may populate only the fields they know.
export interface StepRunContext {
  workflowRunId: string;
  cycleNumber: number;
  iteration: number;
  planningDepth: 'minimal' | 'standard' | 'deep' | 'research';
  goal: string;
  projectRoot: string;
  // Optional legacy fields kept for backward-compat adapters that still need
  // them; new adapters should ignore these.
  _legacyCycleState?: Record<string, unknown>;
}
