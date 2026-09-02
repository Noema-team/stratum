import type { RuntimeMapManager } from './runtime-map.js';
import type { RunArtifactManager } from './run-artifacts.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ConfirmApproveResult {
  approved: boolean;
  next_node: 'BUILD';
}

export interface ConfirmReviseResult {
  revision_count: number;
  next_node: 'TEST';
}

export class ConfirmServiceError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ConfirmServiceError';
    this.code = code;
  }
}

// ─── ConfirmService ───────────────────────────────────────────────────────────

export class ConfirmService {
  constructor(
    private mapManager: RuntimeMapManager,
    private runArtifacts: RunArtifactManager
  ) {}

  async gate(workflowRunId: string, iteration: number): Promise<void> {
    await this.runArtifacts.updateNodeStatus(workflowRunId, iteration, 'CONFIRM', {
      status: 'running',
      started_at: new Date().toISOString(),
    });
    await this.mapManager.update((m) => ({
      ...m,
      cycle: { ...m.cycle, awaiting_confirmation: true },
      meta: {
        ...m.meta,
        dag: m.meta.dag ? { ...m.meta.dag, current_node: 'CONFIRM' } : undefined,
      },
    }));
  }

  async approve(workflowRunId: string, iteration: number): Promise<ConfirmApproveResult> {
    const map = await this.mapManager.read();
    if (!map.cycle.awaiting_confirmation) {
      throw new ConfirmServiceError('not_awaiting_confirmation', 'No confirmation is pending');
    }
    const completedAt = new Date().toISOString();
    await this.runArtifacts.updateNodeStatus(workflowRunId, iteration, 'CONFIRM', {
      status: 'complete',
      completed_at: completedAt,
    });
    await this.mapManager.update((m) => {
      const completed = [...(m.meta.dag?.completed_nodes ?? [])];
      if (!completed.includes('CONFIRM')) completed.push('CONFIRM');
      return {
        ...m,
        cycle: { ...m.cycle, awaiting_confirmation: false },
        meta: {
          ...m.meta,
          dag: m.meta.dag
            ? { ...m.meta.dag, current_node: 'BUILD', completed_nodes: completed }
            : undefined,
        },
      };
    });
    return { approved: true, next_node: 'BUILD' };
  }

  async revise(
    workflowRunId: string,
    iteration: number,
    note?: string
  ): Promise<ConfirmReviseResult> {
    const map = await this.mapManager.read();
    if (!map.cycle.awaiting_confirmation) {
      throw new ConfirmServiceError('not_awaiting_confirmation', 'No confirmation is pending');
    }
    const newRevision = (map.cycle.revision ?? 0) + 1;
    await this.runArtifacts.updateNodeStatus(workflowRunId, iteration, 'CONFIRM', {
      status: 'skipped',
      skip_reason: 'revision_requested',
    });
    await this.mapManager.update((m) => ({
      ...m,
      cycle: {
        ...m.cycle,
        awaiting_confirmation: false,
        revision: newRevision,
        ...(note !== undefined ? { revision_note: note } : {}),
      },
      meta: {
        ...m.meta,
        dag: m.meta.dag
          ? { ...m.meta.dag, current_node: 'TEST' }
          : undefined,
      },
    }));
    return { revision_count: newRevision, next_node: 'TEST' };
  }
}
