// Narrow seam between ResumeService and the checkpoint side-effect logic that
// lives in FullBuildStepRunner. Both paths (inline execution and HTTP approval)
// must execute the same checkpoint semantics so state stays consistent.

export interface CheckpointResolution {
  /** When set, use this step id instead of the natural next-in-sequence. */
  overrideContinuationStepId?: string | null;
  /** True for "modify" — stay at the checkpoint, leave the Decision pending. */
  remainAtCheckpoint: boolean;
  /** True for "revise" — bump WorkflowRun.revision before resuming. */
  incrementRevision: boolean;
  /** True for plain "reject" — cancel the run entirely. */
  cancel: boolean;
}

export interface CheckpointResolver {
  resolveCheckpoint(
    stepId: string,
    selectedOptionId: string,
    workflowRunId: string,
    iteration: number,
  ): Promise<CheckpointResolution>;
}

// Maps a checkpoint step id to the Decision option list that operators see.
// Used by both StratumAgentAdapter (when emitting decisionRequests) and
// ResumeService (when creating the next Decision after a multi-checkpoint run).
export function getCheckpointDecisionOptions(
  checkpointStepId: string | undefined | null,
): Array<{ id: string; label: string; description: string }> {
  switch (checkpointStepId) {
    case 'confirm':
      return [
        { id: 'approve', label: 'Approve', description: 'Continue to the build phase' },
        { id: 'revise', label: 'Revise', description: 'Send back for revision (increments revision counter)' },
      ];
    case 'sharding_approval':
      return [
        { id: 'approve', label: 'Approve', description: 'Create tasks from the sharding proposal' },
        { id: 'reject', label: 'Reject', description: 'Discard the proposal and continue without sharding' },
        { id: 'modify', label: 'Modify', description: 'Keep the checkpoint open while the proposal is edited' },
      ];
    case 'scoping.checkpoint':
      return [
        { id: 'approve', label: 'Approve', description: 'Accept the cycle charter and begin the cycle' },
      ];
    default:
      return [
        { id: 'approve', label: 'Approve', description: 'Continue the workflow past this checkpoint' },
        { id: 'reject', label: 'Reject', description: 'Cancel the workflow run' },
      ];
  }
}
