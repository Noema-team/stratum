import type { RuntimeMapManager } from './runtime-map.js';
import type { RunArtifactManager } from './run-artifacts.js';
import type { FailureReport } from './types.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ExecResult {
  success: boolean;
  passed: boolean;
  next_node: 'VALIDATION_GATE';
  duration_ms: number;
}

export interface ValidationGateResult {
  passed: boolean;
  next_node: 'EVALUATE' | null;
  failed_nodes: string[];
  failure_report?: FailureReport;
}

// ─── ExecService (VS2 stub — always passes) ───────────────────────────────────

export class ExecService {
  constructor(
    private mapManager: RuntimeMapManager,
    private runArtifacts: RunArtifactManager
  ) {}

  async run(cycleNumber: number, iteration: number): Promise<ExecResult> {
    const startedAt = new Date().toISOString();

    await this.runArtifacts.updateNodeStatus(cycleNumber, iteration, 'EXEC', {
      status: 'running',
      started_at: startedAt,
    });
    await this.mapManager.update((m) => ({
      ...m,
      meta: {
        ...m.meta,
        dag: m.meta.dag ? { ...m.meta.dag, current_node: 'EXEC' } : undefined,
      },
    }));

    const completedAt = new Date().toISOString();
    await this.runArtifacts.updateNodeStatus(cycleNumber, iteration, 'EXEC', {
      status: 'complete',
      completed_at: completedAt,
      duration_ms: 0,
    });

    await this.mapManager.update((m) => {
      const completed = [...(m.meta.dag?.completed_nodes ?? [])];
      if (!completed.includes('EXEC')) completed.push('EXEC');
      return {
        ...m,
        meta: {
          ...m.meta,
          dag: m.meta.dag
            ? { ...m.meta.dag, current_node: 'VALIDATION_GATE', completed_nodes: completed }
            : undefined,
        },
      };
    });

    return { success: true, passed: true, next_node: 'VALIDATION_GATE', duration_ms: 0 };
  }
}

// ─── ValidationGateService (deterministic manifest check) ────────────────────

// Nodes that must be 'complete' for the validation gate to pass.
export const VALIDATION_REQUIRED_NODES = ['BUILD', 'EXEC'] as const;

export class ValidationGateService {
  constructor(
    private mapManager: RuntimeMapManager,
    private runArtifacts: RunArtifactManager
  ) {}

  async run(
    cycleNumber: number,
    iteration: number,
    cycleId: string
  ): Promise<ValidationGateResult> {
    const startedAt = new Date().toISOString();

    await this.runArtifacts.updateNodeStatus(cycleNumber, iteration, 'VALIDATION_GATE', {
      status: 'running',
      started_at: startedAt,
    });
    await this.mapManager.update((m) => ({
      ...m,
      meta: {
        ...m.meta,
        dag: m.meta.dag
          ? { ...m.meta.dag, current_node: 'VALIDATION_GATE' }
          : undefined,
      },
    }));

    const manifest = await this.runArtifacts.readManifest(cycleNumber, iteration);
    const failedNodes = (VALIDATION_REQUIRED_NODES as readonly string[]).filter((nodeId) => {
      const node = manifest.nodes.find((n) => n.id === nodeId);
      return !node || node.status !== 'complete';
    });
    const passedNodes = (VALIDATION_REQUIRED_NODES as readonly string[]).filter(
      (n) => !failedNodes.includes(n)
    );
    const passed = failedNodes.length === 0;
    const completedAt = new Date().toISOString();

    await this.runArtifacts.updateNodeStatus(cycleNumber, iteration, 'VALIDATION_GATE', {
      status: passed ? 'complete' : 'failed',
      completed_at: completedAt,
    });

    const completed = [...((await this.mapManager.read()).meta.dag?.completed_nodes ?? [])];
    if (!completed.includes('VALIDATION_GATE')) completed.push('VALIDATION_GATE');

    await this.mapManager.update((m) => {
      const updated = {
        ...m,
        meta: {
          ...m.meta,
          dag: m.meta.dag
            ? { ...m.meta.dag, current_node: passed ? 'EVALUATE' : null, completed_nodes: completed }
            : undefined,
        },
      };
      // Keep validation.gate.last_outcome in sync so T8 precondition can fire.
      if (m.validation) {
        return {
          ...updated,
          validation: {
            ...m.validation,
            gate: {
              ...m.validation.gate,
              last_outcome: passed ? ('passed' as const) : ('failed' as const),
              failed_categories: passed ? [] : failedNodes,
            },
          },
        };
      }
      return updated;
    });

    if (passed) {
      return { passed: true, next_node: 'EVALUATE', failed_nodes: [] };
    }

    const runDir = this.runArtifacts.runDir(cycleNumber, iteration);
    const failureReport: FailureReport = {
      cycle: cycleNumber,
      iteration,
      run_dir: runDir,
      run_id: cycleId,
      quick_summary: `Validation failed: nodes [${failedNodes.join(', ')}] did not complete`,
      failed_categories: failedNodes.map((name) => ({
        name,
        method: 'executable' as const,
        error_summary: `Node ${name} did not complete successfully`,
      })),
      passed_categories: passedNodes as string[],
    };
    await this.runArtifacts.writeFailureReport(cycleNumber, iteration, failureReport);

    return { passed: false, next_node: null, failed_nodes: failedNodes, failure_report: failureReport };
  }
}
