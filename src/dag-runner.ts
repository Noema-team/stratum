import type { AgentRunner, DAGNodeId } from './agent-runner.js';
import { roleForNode } from './agent-runner.js';
import type { CycleStateContext } from './context-manager.js';
import type { RuntimeMapManager } from './runtime-map.js';
import type { RunArtifactManager } from './run-artifacts.js';
import type { AgentRole, PlanningDepth, FailureReport } from './types.js';
import type { RuntimeMap } from './runtime-map.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DAGNodeRunResult {
  success: boolean;
  node: DAGNodeId;
  next_node: DAGNodeId | null;
  artifacts_written: string[];
  tokens_used: number;
  duration_ms: number;
  skipped?: boolean;
  skip_reason?: string;
  error?: string;
}

// ─── DAG sequence (VS2, excludes CRITIQUE which is always skipped) ────────────

export const DAG_SEQUENCE: readonly DAGNodeId[] = [
  'SCOPING', 'DESIGN', 'PLAN', 'TEST', 'CONFIRM', 'BUILD',
  'HISTORY', 'EXEC', 'VALIDATION_GATE', 'EVALUATE', 'SUMMARISE', 'SNAPSHOT',
] as const;

export function nextNode(current: DAGNodeId): DAGNodeId | null {
  const idx = DAG_SEQUENCE.indexOf(current);
  if (idx === -1 || idx === DAG_SEQUENCE.length - 1) return null;
  return DAG_SEQUENCE[idx + 1];
}

// ─── Conditional skip rules ───────────────────────────────────────────────────

// Nodes that are skipped under specific planning depths.
const DEPTH_SKIP_NODES: Partial<Record<DAGNodeId, PlanningDepth[]>> = {
  CRITIQUE: ['minimal', 'standard'],
};

export function shouldSkipAtDepth(nodeId: DAGNodeId, depth: PlanningDepth): boolean {
  const skipAtDepths = DEPTH_SKIP_NODES[nodeId];
  return skipAtDepths ? skipAtDepths.includes(depth) : false;
}

// ─── Artifact-entry updater ───────────────────────────────────────────────────

export async function updateArtifactEntries(
  mapManager: RuntimeMapManager,
  paths: string[],
  role: AgentRole
): Promise<void> {
  if (paths.length === 0) return;
  const now = new Date().toISOString();
  await mapManager.update((m) => ({
    ...m,
    artifacts: (() => {
      const updated = [...m.artifacts];
      for (const artifactPath of paths) {
        const idx = updated.findIndex((a) => a.path === artifactPath);
        const entry = {
          path: artifactPath,
          generator: role,
          required: true,
          last_updated: now,
          dirty: false,
        };
        if (idx >= 0) {
          updated[idx] = { ...updated[idx], ...entry };
        } else {
          updated.push(entry);
        }
      }
      return updated;
    })(),
  }));
}

// ─── CycleStateContext builder ────────────────────────────────────────────────

export function buildCycleStateContext(
  map: RuntimeMap,
  currentNode: string | null,
  failureReport?: FailureReport
): CycleStateContext {
  const cycleAny = map.cycle as { intent?: string; revision?: number; revision_note?: string };
  return {
    cycle_number: map.cycle.number,
    iteration: map.cycle.iteration,
    planning_depth: map.cycle.planning_depth,
    intent: cycleAny.intent ?? '',
    current_node: currentNode,
    failure_report: failureReport,
    revision_count: cycleAny.revision ?? 0,
    revision_note: cycleAny.revision_note,
  };
}

// ─── DAGRunner ────────────────────────────────────────────────────────────────

export class DAGRunner {
  constructor(
    private agentRunner: AgentRunner,
    private mapManager: RuntimeMapManager,
    private runArtifacts: RunArtifactManager
  ) {}

  async runNode(
    nodeId: DAGNodeId,
    cycleState: CycleStateContext
  ): Promise<DAGNodeRunResult> {
    const { cycle_number, iteration } = cycleState;

    // Mark node as running in manifest
    await this.runArtifacts.updateNodeStatus(cycle_number, iteration, nodeId, {
      status: 'running',
      started_at: new Date().toISOString(),
    });

    // Update DAG current_node in map
    await this.mapManager.update((m) => ({
      ...m,
      meta: {
        ...m.meta,
        dag: m.meta.dag
          ? { ...m.meta.dag, current_node: nodeId }
          : undefined,
      },
    }));

    const result = await this.agentRunner.run(nodeId, cycleState);

    if (result.success) {
      const completedAt = new Date().toISOString();
      await this.runArtifacts.updateNodeStatus(cycle_number, iteration, nodeId, {
        status: 'complete',
        completed_at: completedAt,
        duration_ms: result.duration_ms,
        tokens_used: result.tokens_used,
        artifacts_written: result.artifacts_written,
      });

      // Update artifact entries in map
      const role = roleForNode(nodeId);
      if (role && result.artifacts_written.length > 0) {
        await updateArtifactEntries(this.mapManager, result.artifacts_written, role);
      }

      // Advance DAG state
      const next = nextNode(nodeId);
      await this.advanceDagState(nodeId, next, cycle_number, iteration);

      return {
        success: true,
        node: nodeId,
        next_node: next,
        artifacts_written: result.artifacts_written,
        tokens_used: result.tokens_used,
        duration_ms: result.duration_ms,
      };
    } else {
      await this.runArtifacts.updateNodeStatus(cycle_number, iteration, nodeId, {
        status: 'failed',
        completed_at: new Date().toISOString(),
        duration_ms: result.duration_ms,
      });

      return {
        success: false,
        node: nodeId,
        next_node: null,
        artifacts_written: [],
        tokens_used: result.tokens_used,
        duration_ms: result.duration_ms,
        error: result.error,
      };
    }
  }

  async skipNode(
    nodeId: DAGNodeId,
    cycleNumber: number,
    iteration: number,
    reason: string
  ): Promise<void> {
    // updateNodeStatus is a no-op for nodes not in the manifest (e.g. CRITIQUE)
    await this.runArtifacts.updateNodeStatus(cycleNumber, iteration, nodeId, {
      status: 'skipped',
      skip_reason: reason,
    });
  }

  private async advanceDagState(
    completedNode: DAGNodeId,
    nextNode: DAGNodeId | null,
    _cycleNumber: number,
    _iteration: number
  ): Promise<void> {
    await this.mapManager.update((m) => {
      if (!m.meta.dag) return m;
      const completed = [...(m.meta.dag.completed_nodes ?? [])];
      if (!completed.includes(completedNode)) completed.push(completedNode);
      return {
        ...m,
        meta: {
          ...m.meta,
          dag: {
            ...m.meta.dag,
            current_node: nextNode,
            completed_nodes: completed,
          },
        },
      };
    });
  }
}
