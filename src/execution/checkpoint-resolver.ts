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
  /** True for plain "reject" on a generic checkpoint — cancel the run entirely. */
  cancel: boolean;
}

// Full set of inputs the resolver needs to execute checkpoint semantics durably.
export interface CheckpointResolverInput {
  workflowId: string;
  stepId: string;
  decisionId: string;
  selectedOptionId: string;
  /** Optional operator rationale; used as the revision note for confirm+revise. */
  rationale?: string;
  workflowRunId: string;
  iteration: number;
  /** Canonical revision from the WorkflowRun row — used for idempotency assertions. */
  revision: number;
}

export interface CheckpointResolver {
  resolveCheckpoint(input: CheckpointResolverInput): Promise<CheckpointResolution>;
}

// Maps a checkpoint step id to the Decision option list that operators see.
// Scoped by workflowId so an unrelated workflow with a step named 'confirm'
// does not accidentally inherit full-build approve/revise semantics.
export function getCheckpointDecisionOptions(
  workflowId: string,
  stepId: string | undefined | null,
): Array<{ id: string; label: string; description: string }> {
  if (workflowId === 'full-build') {
    switch (stepId) {
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
    }
  }
  // Generic fallback for all other workflows and unknown full-build step ids.
  return [
    { id: 'approve', label: 'Approve', description: 'Continue the workflow past this checkpoint' },
    { id: 'reject', label: 'Reject', description: 'Cancel the workflow run' },
  ];
}
