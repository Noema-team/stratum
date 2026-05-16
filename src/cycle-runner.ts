import type { DAGRunner } from './dag-runner.js';
import { nextNode, shouldSkipAtDepth, buildCycleStateContext } from './dag-runner.js';
import type { ConfirmService } from './confirm-service.js';
import type { ExecService, ValidationGateService } from './exec-gate.js';
import type { SnapshotService } from './snapshot-service.js';
import type { RuntimeMapManager } from './runtime-map.js';
import type { RunArtifactManager } from './run-artifacts.js';
import type { CycleStateContext } from './context-manager.js';
import type { FailureReport } from './types.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CycleRunResult {
  completed: boolean;
  final_node: string | null;
  snapshot_dir?: string;
  failure_report?: FailureReport;
  error?: string;
}

export interface CycleRunnerDeps {
  dagRunner: DAGRunner;
  confirmService: ConfirmService;
  execService: ExecService;
  validationGateService: ValidationGateService;
  snapshotService: SnapshotService;
  mapManager: RuntimeMapManager;
  runArtifacts: RunArtifactManager;
}

export interface CycleRunnerOptions {
  // Called when CONFIRM gate is reached. Defaults to 'approve'.
  onConfirmGate?: (
    cycleNumber: number,
    iteration: number
  ) => Promise<'approve' | 'revise' | 'halt'>;
}

// ─── CycleRunner ──────────────────────────────────────────────────────────────

export class CycleRunner {
  constructor(private deps: CycleRunnerDeps) {}

  async run(options?: CycleRunnerOptions): Promise<CycleRunResult> {
    const map = await this.deps.mapManager.read();
    const cycleNumber = map.cycle.number;
    const iteration = map.cycle.iteration;

    let cycleState: CycleStateContext = buildCycleStateContext(map, null);

    // Resolve cycleId from manifest (set during cycle start)
    let cycleId = 'unknown';
    try {
      const manifest = await this.deps.runArtifacts.readManifest(cycleNumber, iteration);
      cycleId = manifest.cycle_id;
    } catch {
      cycleId = String(cycleNumber);
    }

    const dag = map.meta.dag as
      | { current_node?: string | null; completed_nodes?: string[] }
      | undefined;
    let currentNode: string | null = dag?.current_node ?? 'DESIGN';

    const onGate =
      options?.onConfirmGate ?? (async () => 'approve' as const);

    while (currentNode !== null) {
      const nodeId = currentNode;
      cycleState = { ...cycleState, current_node: nodeId };

      // Depth-based skip (e.g. CRITIQUE at standard depth)
      if (shouldSkipAtDepth(nodeId, cycleState.planning_depth)) {
        await this.deps.dagRunner.skipNode(
          nodeId,
          cycleNumber,
          iteration,
          'planning_depth'
        );
        currentNode = nextNode(nodeId);
        continue;
      }

      // ── Gate / system nodes ──────────────────────────────────────────────

      if (nodeId === 'SCOPING') {
        // SCOPING is handled at cycle start by ScopingService; skip here.
        currentNode = nextNode('SCOPING');
        continue;
      }

      if (nodeId === 'CONFIRM') {
        await this.deps.confirmService.gate(cycleNumber, iteration);
        const action = await onGate(cycleNumber, iteration);

        if (action === 'halt') {
          return { completed: false, final_node: 'CONFIRM' };
        }
        if (action === 'revise') {
          const r = await this.deps.confirmService.revise(cycleNumber, iteration);
          currentNode = r.next_node; // returns to PLAN
          continue;
        }
        // approve
        const r = await this.deps.confirmService.approve(cycleNumber, iteration);
        currentNode = r.next_node;
        continue;
      }

      if (nodeId === 'EXEC') {
        const r = await this.deps.execService.run(cycleNumber, iteration);
        currentNode = r.next_node;
        continue;
      }

      if (nodeId === 'VALIDATION_GATE') {
        const r = await this.deps.validationGateService.run(
          cycleNumber,
          iteration,
          cycleId
        );
        if (!r.passed) {
          return {
            completed: false,
            final_node: 'VALIDATION_GATE',
            failure_report: r.failure_report,
          };
        }
        currentNode = r.next_node;
        continue;
      }

      if (nodeId === 'SNAPSHOT') {
        const r = await this.deps.snapshotService.run(cycleNumber, iteration);
        return {
          completed: true,
          final_node: null,
          snapshot_dir: r.snapshot_dir,
        };
      }

      // ── LLM nodes via DAGRunner ──────────────────────────────────────────

      const result = await this.deps.dagRunner.runNode(nodeId, cycleState);
      if (!result.success) {
        return {
          completed: false,
          final_node: nodeId,
          error: result.error,
        };
      }
      currentNode = result.next_node;
    }

    return { completed: true, final_node: null };
  }
}
