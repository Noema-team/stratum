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
import type { ShardingService } from './sharding-service.js';
import yaml from 'js-yaml';
import type { ShardingProposal } from './types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function readOnCapHit(projectRoot: string): Promise<'halt_with_report' | 'user_prompt' | 'force_pass'> {
  try {
    const content = await fs.readFile(path.join(projectRoot, '.sle', 'rules', 'exit.yaml'), 'utf-8');
    const cfg = yaml.load(content) as any;
    return cfg?.on_cap_hit ?? 'halt_with_report';
  } catch {
    return 'halt_with_report';
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CycleRunResult {
  completed: boolean;
  final_node: string | null;
  snapshot_dir?: string;
  failure_report?: FailureReport;
  error?: string;
  iterations_used?: number;
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
  projectRoot?: string;
  criticAgent?: CriticAgent;
  shardingService?: ShardingService;
}

export interface CycleRunnerOptions {
  onConfirmGate?: (
    cycleNumber: number,
    iteration: number
  ) => Promise<'approve' | 'revise' | 'halt'>;
  onShardingApproval?: (
    cycleNumber: number,
    iteration: number
  ) => Promise<'approve' | 'reject' | 'modify'>;
}

// ─── CycleRunner ──────────────────────────────────────────────────────────────

export class CycleRunner {
  constructor(private deps: CycleRunnerDeps) {}

  async run(options?: CycleRunnerOptions): Promise<CycleRunResult> {
    const map = await this.deps.mapManager.read();
    const projectRoot = this.deps.projectRoot || process.cwd();
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
    let currentNode: string | null = dag?.current_node ?? 'SCOPING';

    const onGate = options?.onConfirmGate ?? (async () => 'approve' as const);
    const onShard = options?.onShardingApproval ?? (async () => 'approve' as const);

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

        const archPath = path.join(projectRoot, 'docs/architecture.md');
        const reqPath = path.join(projectRoot, 'docs/requirements.md');
        const discPath = path.join(projectRoot, 'docs/discovery-summary.md');
        const decPath = path.join(projectRoot, 'docs/decisions.md');
        const evalPath = path.join(projectRoot, 'docs/evaluation.md');

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
        await this.safeWriteFile(path.join(projectRoot, 'docs/cycle-critique.md'), critiqueContent);

        if (cycleState.planning_depth === 'deep' || cycleState.planning_depth === 'research') {
          writtenFiles.push('docs/critique-report.md');
          await this.safeWriteFile(path.join(projectRoot, 'docs/critique-report.md'), critiqueContent);
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

      if (nodeId === 'SHARDING_APPROVAL') {
        const proposalPath = path.join(projectRoot, '.sle', 'sharding-proposal.yaml');
        const proposalContent = await this.safeReadFile(proposalPath);
        if (!proposalContent) {
          await this.deps.dagRunner.skipNode('SHARDING_APPROVAL', cycleNumber, iteration, 'no_sharding_proposal');
          currentNode = 'CONFIRM';
          continue;
        }

        // Set cycle.awaiting_sharding_approval = true
        await this.deps.mapManager.update(m => ({
          ...m,
          cycle: {
            ...m.cycle,
            awaiting_sharding_approval: true,
          }
        }));

        await this.deps.runArtifacts.updateNodeStatus(cycleNumber, iteration, 'SHARDING_APPROVAL', {
          status: 'running',
          started_at: new Date().toISOString(),
        });

        const action = await onShard(cycleNumber, iteration);

        // Clear cycle.awaiting_sharding_approval = false
        await this.deps.mapManager.update(m => ({
          ...m,
          cycle: {
            ...m.cycle,
            awaiting_sharding_approval: false,
          }
        }));

        if (action === 'approve') {
          if (!this.deps.shardingService) {
            throw new Error('ShardingService is required to process SHARDING_APPROVAL approval.');
          }

          const proposal = yaml.load(proposalContent) as ShardingProposal;
          await this.deps.shardingService.createTasksFromProposal(proposal);

          await this.deps.runArtifacts.updateNodeStatus(cycleNumber, iteration, 'SHARDING_APPROVAL', {
            status: 'complete',
            completed_at: new Date().toISOString(),
            artifacts_written: ['.sle/tasks.yaml'],
          });

          currentNode = 'CONFIRM';
          continue;
        } else if (action === 'reject') {
          // Reject sharding, delete proposal file
          try {
            await fs.unlink(proposalPath);
          } catch {}

          await this.deps.runArtifacts.updateNodeStatus(cycleNumber, iteration, 'SHARDING_APPROVAL', {
            status: 'skipped',
            completed_at: new Date().toISOString(),
            skip_reason: 'User rejected sharding proposal. Planner will re-plan as single task.',
          });

          currentNode = 'CONFIRM';
          continue;
        } else {
          // Modify: user edits the proposal
          currentNode = 'SHARDING_APPROVAL';
          continue;
        }
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
          cycleState = { ...cycleState, failure_report: r.failure_report };
          currentNode = 'DEBUG';
          continue;
        }
        currentNode = r.next_node;
        continue;
      }

      if (nodeId === 'DEBUG') {
        // Debugger diagnoses the failure; output feeds next PLAN invocation.
        const debugResult = await this.deps.dagRunner.runNode('DEBUG', cycleState);
        if (!debugResult.success) {
          return {
            completed: false,
            final_node: 'DEBUG',
            error: debugResult.error,
            iterations_used: cycleState.iteration,
          };
        }

        // Increment iteration counter in map.yaml (spec: increment after DEBUG, before PLAN)
        await this.deps.mapManager.update((m) => ({
          ...m,
          cycle: { ...m.cycle, iteration: m.cycle.iteration + 1 },
        }));
        const updatedMap = await this.deps.mapManager.read();
        const newIteration = updatedMap.cycle.iteration;
        cycleState = { ...cycleState, iteration: newIteration };

        // Create run artifacts dir + manifest for the new iteration
        try {
          await this.deps.runArtifacts.createRunDir(cycleNumber, newIteration);
          await this.deps.runArtifacts.createManifest({
            cycleId,
            cycleNumber,
            iteration: newIteration,
            planningDepth: cycleState.planning_depth,
          });
        } catch {
          // If manifest creation fails, continue — updateNodeStatus will just silently fail
        }

        // Check cap (spec: cap check before routing to PLAN)
        const maxIterations = updatedMap.cycle.max_iterations;
        if (newIteration >= maxIterations) {
          const onCapHit = await readOnCapHit(projectRoot);
          if (onCapHit === 'force_pass') {
            // Proceed despite failures (not recommended — caller decides)
            currentNode = 'EVALUATE';
            continue;
          }
          if (onCapHit === 'user_prompt') {
            // For now treat user_prompt as halt (UI handles re-prompt via WebSocket events)
            await this.deps.stateMachine.halt('cap_exceeded');
          }
          // halt_with_report (default)
          await this.deps.stateMachine.halt('cap_exceeded');
          return {
            completed: false,
            final_node: 'DEBUG',
            failure_report: cycleState.failure_report,
            error: `Iteration cap (${maxIterations}) reached`,
            iterations_used: newIteration,
          };
        }

        // Structural failure escalation: if any failed category is structural, loop back to DESIGN
        const failureReport = cycleState.failure_report;
        const hasStructural = failureReport?.failed_categories?.some((c) => c.structural === true) ?? false;
        currentNode = hasStructural ? 'DESIGN' : 'PLAN';
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
          iterations_used: cycleState.iteration,
        };
      }

      // ── LLM nodes via DAGRunner ──────────────────────────────────────────

      const result = await this.deps.dagRunner.runNode(nodeId, cycleState);
      if (!result.success) {
        return {
          completed: false,
          final_node: nodeId,
          error: result.error,
          iterations_used: cycleState.iteration,
        };
      }
      currentNode = result.next_node;
    }

    return { completed: true, final_node: null, iterations_used: cycleState.iteration };
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
