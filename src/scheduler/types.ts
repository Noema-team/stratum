export interface SchedulerConfig {
  maxConcurrentPerProject: number;
  maxConcurrentPerRepo: number;
  globalExecutionLimit: number;
  leaseExpiryMs: number;
  maxAttempts: number;
}

export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  maxConcurrentPerProject: 2,
  maxConcurrentPerRepo: 1,
  globalExecutionLimit: 10,
  leaseExpiryMs: 5 * 60 * 1000,
  maxAttempts: 3,
};

export interface WorkLease {
  id: string;
  workItemId: string;
  repositoryId: string | null;
  leaseType: 'write' | 'read';
  acquiredAt: string;
  expiresAt: string;
  heartbeatAt: string;
}

export type DispatchOutcome =
  | 'dispatched'
  | 'skipped_deps'
  | 'skipped_concurrency'
  | 'skipped_lease'
  | 'skipped_no_adapter'
  | 'skipped_already_active'
  | 'failed';

export interface DispatchResult {
  workItemId: string;
  outcome: DispatchOutcome;
  stepExecutionId?: string;
  workflowRunId?: string;
  error?: string;
}
