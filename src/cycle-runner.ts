import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DAGRunner } from './dag-runner.js';
import { nextNode, shouldSkipAtDepth, buildCycleStateContext, updateArtifactEntries } from './dag-runner.js';
import type { ConfirmService } from './confirm-service.js';
import type { ExecService, ValidationGateService } from './exec-gate.js';
import type { SnapshotService } from './snapshot-service.js';
import type { SummariseService } from './summarise-service.js';
import type { StateMachine } from './state-machine.js';
import type { RuntimeMapManager } from './runtime-map.js';
import type { RunArtifactManager } from './run-artifacts.js';
import type { CycleStateContext } from './context-manager.js';
import type { FailureReport } from './types.js';
import type { CriticAgent } from './critic-agent.js';

// ─── Constants ────────────────────────────────────────────────────────────────

export const MAX_DEBUG_ATTEMPTS = 3;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CycleRunResult {
  completed: boolean;
  final_node: string | null;
  snapshot_dir?: string;
  failure_report?: FailureReport;
  error?: string;
  debug_attempts_used?: number;
}

export interface CycleRunnerDeps {
  dagRunner: DAGRunner;
  confirmService: ConfirmService;
  execService: ExecService;
  validationGateService: ValidationGateService;
  snapshotService: SnapshotService;
  summariseService: SummariseService;
  stateMachine: StateMachine;
  mapManager: RuntimeMapManager;
  runArtifacts: RunArtifactManager;
  projectRoot: string;
  criticAgent?: CriticAgent;
}

export interface CycleRunnerOptions {
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

    const onGate = options?.onConfirmGate ?? (async () => 'approve' as const);

    // debug_attempt tracks how many DEBUGGER invocations have occurred.
    // Reset to 0 at cycle start (fresh cycles don't inherit prior debug state).
    let debugAttempt = 0;

    let criticPasses = 0;

    while (currentNode !== null) {
      const nodeId = currentNode;
      cycleState = { ...cycleState, current_node: nodeId };

      if (shouldSkipAtDepth(nodeId, cycleState.planning_depth)) {
        await this.deps.dagRunner.skipNode(nodeId, cycleNumber, iteration, 'planning_depth');
        currentNode = nextNode(nodeId);
        continue;
      }

      // ── Gate / system nodes ──────────────────────────────────────────────

      if (nodeId === 'SCOPING') {
        currentNode = nextNode('SCOPING');
        continue;
      }

      if (nodeId === 'CRITIQUE') {
        const start = Date.now();
        await this.deps.runArtifacts.updateNodeStatus(cycleNumber, iteration, 'CRITIQUE', {
          status: 'running',
          started_at: new Date().toISOString(),
        });

        const archPath = path.join(this.deps.projectRoot, 'docs/architecture.md');
        const reqPath = path.join(this.deps.projectRoot, 'docs/requirements.md');
        const discPath = path.join(this.deps.projectRoot, 'docs/discovery-summary.md');
        const decPath = path.join(this.deps.projectRoot, 'docs/decisions.md');
        const evalPath = path.join(this.deps.projectRoot, 'docs/evaluation.md');

        const [architecture, requirements, contextSummary, decisions, priorEvaluation] = await Promise.all([
          this.safeReadFile(archPath),
          this.safeReadFile(reqPath),
          this.safeReadFile(discPath),
          this.safeReadFile(decPath),
          this.safeReadFile(evalPath),
        ]);

        if (!this.deps.criticAgent) {
          throw new Error('CriticAgent is required in CycleRunner dependencies to execute CRITIQUE node.');
        }

        const critiqueResult = await this.deps.criticAgent.critique({
          architecture,
          requirements,
          contextSummary,
          decisions,
          priorEvaluation,
        });

        const critiqueContent = `# Critique for Cycle Revision

## Blocking Issues
${critiqueResult.blocking_issues.map(i => `- ${i}`).join('\n') || 'None'}

## Warnings
${critiqueResult.warnings.map(w => `- ${w}`).join('\n') || 'None'}

## Suggestions
${critiqueResult.suggestions.map(s => `- ${s}`).join('\n') || 'None'}`;

        const writtenFiles = ['docs/cycle-critique.md'];
        await this.safeWriteFile(path.join(this.deps.projectRoot, 'docs/cycle-critique.md'), critiqueContent);

        if (cycleState.planning_depth === 'deep' || cycleState.planning_depth === 'research') {
          writtenFiles.push('docs/critique-report.md');
          await this.safeWriteFile(path.join(this.deps.projectRoot, 'docs/critique-report.md'), critiqueContent);
        }

        await this.deps.runArtifacts.updateNodeStatus(cycleNumber, iteration, 'CRITIQUE', {
          status: 'complete',
          completed_at: new Date().toISOString(),
          duration_ms: Date.now() - start,
          artifacts_written: writtenFiles,
        });

        await updateArtifactEntries(this.deps.mapManager, writtenFiles, 'critic');

        const limit = cycleState.planning_depth === 'deep' ? 1 : 3;
        if (!critiqueResult.pass && criticPasses < limit) {
          criticPasses++;
          currentNode = 'DESIGN';
          continue;
        }

        currentNode = 'PLAN';
        continue;
      }

      if (nodeId === 'CONFIRM') {
        await this.deps.confirmService.gate(cycleNumber, iteration);
        const action = await onGate(cycleNumber, iteration);
        if (action === 'halt') return { completed: false, final_node: 'CONFIRM' };
        if (action === 'revise') {
          const r = await this.deps.confirmService.revise(cycleNumber, iteration);
          currentNode = r.next_node;
          continue;
        }
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
        const r = await this.deps.validationGateService.run(cycleNumber, iteration, cycleId);
        if (!r.passed) {
          debugAttempt++;
          if (debugAttempt > MAX_DEBUG_ATTEMPTS) {
            return {
              completed: false,
              final_node: 'VALIDATION_GATE',
              failure_report: r.failure_report,
              error: `Validation failed after ${MAX_DEBUG_ATTEMPTS} debug attempt(s)`,
              debug_attempts_used: debugAttempt - 1, // attempts actually run
            };
          }
          // Route to Debugger with current failure context
          cycleState = { ...cycleState, failure_report: r.failure_report };
          currentNode = 'DEBUGGER';
          continue;
        }
        currentNode = r.next_node;
        continue;
      }

      if (nodeId === 'DEBUGGER') {
        // Run Debugger agent; after it produces a fix, route back to EXEC
        const result = await this.deps.dagRunner.runNode('DEBUGGER', cycleState);
        if (!result.success) {
          return {
            completed: false,
            final_node: 'DEBUGGER',
            error: result.error,
            debug_attempts_used: debugAttempt,
          };
        }
        currentNode = 'EXEC'; // re-run execution after Debugger fix
        continue;
      }

      if (nodeId === 'SUMMARISE') {
        const r = await this.deps.summariseService.run(cycleNumber, iteration);
        if (!r.success) {
          return { completed: false, final_node: 'SUMMARISE', error: 'Summarise failed' };
        }
        currentNode = 'SNAPSHOT';
        continue;
      }

      if (nodeId === 'SNAPSHOT') {
        const r = await this.deps.snapshotService.run(cycleNumber, iteration);
        await this.deps.stateMachine.completeCycle();
        return {
          completed: true,
          final_node: null,
          snapshot_dir: r.snapshot_dir,
          debug_attempts_used: debugAttempt,
        };
      }

      // ── LLM nodes via DAGRunner ──────────────────────────────────────────

      const result = await this.deps.dagRunner.runNode(nodeId, cycleState);
      if (!result.success) {
        return {
          completed: false,
          final_node: nodeId,
          error: result.error,
          debug_attempts_used: debugAttempt,
        };
      }
      currentNode = result.next_node;
    }

    return { completed: true, final_node: null, debug_attempts_used: debugAttempt };
  }

  private async safeReadFile(filePath: string): Promise<string> {
    try {
      return await fs.readFile(filePath, 'utf8');
    } catch {
      return '';
    }
  }

  private async safeWriteFile(filePath: string, content: string): Promise<void> {
    try {
      await fs.writeFile(filePath, content, 'utf8');
    } catch {
      // ignore
    }
  }
}
