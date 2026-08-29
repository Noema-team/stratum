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

  // review — pass/fail evaluation; routes on failure
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
