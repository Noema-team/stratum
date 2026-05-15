import { randomUUID } from 'crypto';
import type { StateMachine } from './state-machine.js';
import type { RuntimeMapManager, RuntimeDAGState } from './runtime-map.js';
import type { RunArtifactManager, RunManifest } from './run-artifacts.js';
import { initialDAGNodes } from './run-artifacts.js';
import type { PlanningDepth } from './types.js';

export interface CycleStartParams {
  intent: string;
  depth?: PlanningDepth;
  force?: boolean;
}

export interface CycleStartResult {
  cycle_id: string;
  cycle_number: number;
  planning_depth: PlanningDepth;
  intent: string;
  started_at: string;
  initial_node: 'SCOPING';
}

export interface CycleRecord {
  cycle_id: string | null;
  cycle_number: number;
  iteration: number;
  revision: number;
  planning_depth: PlanningDepth;
  intent: string | null;
  started_at: string | undefined;
  completed_at: string | undefined;
  outcome: 'cycling' | 'completed' | 'halted';
  max_iterations: number;
  approval_gate: string | null;
  awaiting_scoping: boolean;
  awaiting_confirmation: boolean;
  awaiting_sharding_approval: boolean;
}

export class CycleService {
  constructor(
    private stateMachine: StateMachine,
    private mapManager: RuntimeMapManager,
    private runArtifacts: RunArtifactManager
  ) {}

  async start(params: CycleStartParams): Promise<CycleStartResult> {
    if (params.intent.trim().length < 10) {
      throw Object.assign(new Error('Intent must be at least 10 characters.'), {
        code: 'invalid_intent',
      });
    }

    const map = await this.mapManager.read();

    if (map.meta.status === 'cycling') {
      throw Object.assign(new Error('A cycle is already active.'), {
        code: 'cycle_already_active',
      });
    }

    if (!params.force && map.discovery.status !== 'complete') {
      throw Object.assign(
        new Error('Discovery must be complete before starting a cycle. Use force=true to skip.'),
        { code: 'discovery_required' }
      );
    }

    const cycleId = randomUUID();
    const planningDepth = params.depth ?? map.cycle.planning_depth;
    const now = new Date().toISOString();

    await this.mapManager.update((m) => ({
      ...m,
      meta: {
        ...m.meta,
        active_cycle_id: cycleId,
        dag: {
          current_node: null,
          completed_nodes: [],
          iteration: 1,
          revision: 0,
          started_at: now,
          nodes: initialDAGNodes(),
        } satisfies RuntimeDAGState,
      },
      cycle: {
        ...m.cycle,
        intent: params.intent,
        planning_depth: planningDepth,
      },
    }));

    const result = await this.stateMachine.transition(params.force ? 'T11' : 'T3');

    if (!result.success) {
      await this.mapManager.update((m) => ({
        ...m,
        meta: { ...m.meta, active_cycle_id: null, dag: undefined },
      }));
      throw Object.assign(
        new Error(result.error?.reason ?? 'Failed to start cycle'),
        { code: result.error?.code ?? 'transition_failed' }
      );
    }

    const updatedMap = await this.mapManager.read();
    const cycleNumber = updatedMap.cycle.number;
    const iteration = updatedMap.cycle.iteration;

    await this.runArtifacts.createRunDir(cycleNumber, iteration);
    await this.runArtifacts.createManifest({
      cycleId,
      cycleNumber,
      iteration,
      planningDepth,
    });

    return {
      cycle_id: cycleId,
      cycle_number: cycleNumber,
      planning_depth: updatedMap.cycle.planning_depth,
      intent: params.intent,
      started_at: updatedMap.cycle.started_at!,
      initial_node: 'SCOPING',
    };
  }

  async getCurrent(): Promise<CycleRecord> {
    const map = await this.mapManager.read();
    return {
      cycle_id: map.meta.active_cycle_id ?? null,
      cycle_number: map.cycle.number,
      iteration: map.cycle.iteration,
      revision: map.cycle.revision,
      planning_depth: map.cycle.planning_depth,
      intent: map.cycle.intent ?? null,
      started_at: map.cycle.started_at,
      completed_at: map.cycle.completed_at,
      outcome: map.cycle.outcome,
      max_iterations: map.cycle.max_iterations,
      approval_gate: map.cycle.approval_gate,
      awaiting_scoping: map.cycle.awaiting_scoping,
      awaiting_confirmation: map.cycle.awaiting_confirmation,
      awaiting_sharding_approval: map.cycle.awaiting_sharding_approval,
    };
  }

  async getDAGState(): Promise<RuntimeDAGState | null> {
    const map = await this.mapManager.read();
    return map.meta.dag ?? null;
  }

  async getCurrentRun(): Promise<RunManifest | null> {
    const map = await this.mapManager.read();
    if (map.meta.status !== 'cycling' && map.meta.status !== 'halted') return null;
    const { number: cycleNumber, iteration } = map.cycle;
    try {
      return await this.runArtifacts.readManifest(cycleNumber, iteration);
    } catch {
      return null;
    }
  }

  async halt(): Promise<void> {
    const result = await this.stateMachine.halt('user');
    if (!result.success) {
      throw Object.assign(
        new Error(result.error?.reason ?? 'Failed to halt cycle'),
        { code: result.error?.code ?? 'halt_failed' }
      );
    }
    const map = await this.mapManager.read();
    try {
      await this.runArtifacts.finalizeManifest(map.cycle.number, map.cycle.iteration, 'halted');
    } catch {
      // manifest may not exist if halted before first node
    }
  }

  async acknowledgeHalt(): Promise<void> {
    const result = await this.stateMachine.acknowledgeHalt();
    if (!result.success) {
      throw Object.assign(
        new Error(result.error?.reason ?? 'Failed to acknowledge halt'),
        { code: result.error?.code ?? 'acknowledge_failed' }
      );
    }
    await this.mapManager.update((m) => ({
      ...m,
      meta: { ...m.meta, active_cycle_id: null, dag: undefined },
    }));
  }

  async resume(): Promise<void> {
    const result = await this.stateMachine.resume();
    if (!result.success) {
      throw Object.assign(
        new Error(result.error?.reason ?? 'Failed to resume cycle'),
        { code: result.error?.code ?? 'resume_failed' }
      );
    }
    const map = await this.mapManager.read();
    const cycleNumber = map.cycle.number;
    const iteration = map.cycle.iteration;

    const alreadyExists = await this.runArtifacts.dirExists(cycleNumber, iteration);
    if (!alreadyExists) {
      await this.runArtifacts.createRunDir(cycleNumber, iteration);
      await this.runArtifacts.createManifest({
        cycleId: map.meta.active_cycle_id ?? '',
        cycleNumber,
        iteration,
        planningDepth: map.cycle.planning_depth,
      });
    }
  }
}
