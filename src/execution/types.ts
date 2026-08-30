import type { UUID } from '../domain/primitives.js';

export type ExecutorCapability =
  | 'repo.read'
  | 'repo.write'
  | 'shell'
  | 'tests.run'
  | 'browser'
  | 'network'
  | 'long_context'
  | 'structured_output';

export type CapabilitySet = ReadonlySet<ExecutorCapability>;

export interface RepositoryContext {
  id: UUID;
  remote: string;
  branch: string;
}

export interface ExecutionPermissions {
  pushBranch: boolean;
  createPr: boolean;
  merge: boolean;
}

export interface ExecutionBudget {
  maxRuntimeMs?: number;
  maxTokens?: number;
  maxCostUsd?: number;
  maxAttempts?: number;
}

export interface ArtifactReference {
  ref: string;
  path?: string;
  type: string;
}

export interface EvidenceClaim {
  type: string;
  source: string;
  status: 'passed' | 'failed' | 'informational';
  payload: Record<string, unknown>;
}

export interface DecisionRequest {
  type: string;
  title: string;
  summary: string;
}

export interface ExecutionFailureInfo {
  code: string;
  message: string;
  details?: unknown;
}

// ============================================================================
// ExecutionRequest — passed to an adapter to execute one WorkItem.
// stepId is the entry step for the workflow run; workflowId drives dispatch.
// ============================================================================

export interface ExecutionRequest {
  stepExecutionId: UUID;
  workItemId: UUID;
  workflowRunId: string;
  stepId: string;
  workflowId: string;
  repositories: RepositoryContext[];
  goal: string;
  acceptanceCriteria: Array<{ description: string; met?: boolean }>;
  constraints: Array<{ description: string; type?: string }>;
  permissions: ExecutionPermissions;
  budget: ExecutionBudget;
}

// ============================================================================
// ExecutionResult — returned by an adapter when a work item execution finishes.
// schemaVersion: 1 is the only legal value; it allows future incompatible changes.
// ============================================================================

export interface ExecutionResult {
  schemaVersion: 1;
  stepExecutionId: UUID;
  outcome: 'succeeded' | 'failed' | 'blocked';
  artifacts: ArtifactReference[];
  evidenceClaims: EvidenceClaim[];
  decisionRequests: DecisionRequest[];
  // Set when outcome === 'blocked': the stepId that triggered the checkpoint pause.
  // Used by the Scheduler to populate Decision.subjectRef.stepId.
  checkpointStepId?: string;
  usage?: {
    durationMs: number;
    tokens?: number;
    cost?: number;
  };
  failure?: ExecutionFailureInfo;
}

// ============================================================================
// ExecutionAdapter — the single seam between the scheduler/kernel and any
// concrete execution implementation (Stratum agent, Claude Code, Codex, …).
// ============================================================================

export interface ExecutionAdapter {
  readonly id: string;
  getCapabilities(): CapabilitySet;
  execute(request: ExecutionRequest): Promise<ExecutionResult>;
  cancel?(stepExecutionId: UUID): Promise<void>;
}
