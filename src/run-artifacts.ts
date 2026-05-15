import { promises as nodeFsPromises } from 'fs';
import path from 'path';
import type { NodeStatus, PlanningDepth } from './types.js';

export const CORE_DAG_NODES = [
  'SCOPING',
  'DESIGN',
  'PLAN',
  'TEST',
  'CONFIRM',
  'BUILD',
  'HISTORY',
  'EXEC',
  'VALIDATION_GATE',
  'EVALUATE',
  'SUMMARISE',
  'SNAPSHOT',
] as const;

export type CoreDAGNode = (typeof CORE_DAG_NODES)[number];

export interface ManifestNodeEntry {
  id: string;
  status: NodeStatus;
  started_at?: string;
  completed_at?: string;
  duration_ms?: number;
  agent_role?: string;
  tokens_used?: number;
  artifacts_written: string[];
}

export interface RunManifest {
  cycle_id: string;
  cycle_number: number;
  iteration: number;
  planning_depth: PlanningDepth;
  started_at: string;
  completed_at?: string;
  outcome: 'in_progress' | 'complete' | 'halted';
  nodes: ManifestNodeEntry[];
}

export interface ContextPackEntry {
  system_prompt_tokens: number;
  artifact_slices: Array<{ artifact_id: string; tokens: number; truncated: boolean }>;
  state_summary_tokens: number;
  total_tokens: number;
}

export type ContextPack = Record<string, ContextPackEntry>;

export interface RunArtifactManagerOptions {
  projectRoot: string;
  fsModule?: typeof import('fs').promises;
}

export class RunArtifactManager {
  private projectRoot: string;
  private fs: typeof import('fs').promises;

  constructor(options: RunArtifactManagerOptions) {
    this.projectRoot = options.projectRoot;
    this.fs = options.fsModule ?? nodeFsPromises;
  }

  runDir(cycleNumber: number, iteration: number): string {
    return path.join(this.projectRoot, '.sle', 'runs', `${cycleNumber}-${iteration}`);
  }

  async createRunDir(cycleNumber: number, iteration: number): Promise<string> {
    const dir = this.runDir(cycleNumber, iteration);
    await this.fs.mkdir(path.join(dir, 'validation'), { recursive: true });
    await this.fs.mkdir(path.join(dir, 'node-outputs'), { recursive: true });
    return dir;
  }

  async createManifest(params: {
    cycleId: string;
    cycleNumber: number;
    iteration: number;
    planningDepth: PlanningDepth;
  }): Promise<void> {
    const manifest: RunManifest = {
      cycle_id: params.cycleId,
      cycle_number: params.cycleNumber,
      iteration: params.iteration,
      planning_depth: params.planningDepth,
      started_at: new Date().toISOString(),
      outcome: 'in_progress',
      nodes: CORE_DAG_NODES.map((id) => ({
        id,
        status: 'pending',
        artifacts_written: [],
      })),
    };
    const dir = this.runDir(params.cycleNumber, params.iteration);
    await this.fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  }

  async readManifest(cycleNumber: number, iteration: number): Promise<RunManifest> {
    const manifestPath = path.join(this.runDir(cycleNumber, iteration), 'manifest.json');
    const content = await this.fs.readFile(manifestPath, 'utf-8');
    return JSON.parse(content) as RunManifest;
  }

  async updateManifest(
    cycleNumber: number,
    iteration: number,
    updater: (manifest: RunManifest) => RunManifest
  ): Promise<void> {
    const manifest = await this.readManifest(cycleNumber, iteration);
    const updated = updater(manifest);
    const dir = this.runDir(cycleNumber, iteration);
    await this.fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(updated, null, 2));
  }

  async updateNodeStatus(
    cycleNumber: number,
    iteration: number,
    nodeId: string,
    update: Partial<Omit<ManifestNodeEntry, 'id'>>
  ): Promise<void> {
    await this.updateManifest(cycleNumber, iteration, (manifest) => {
      const nodes = manifest.nodes.map((n) =>
        n.id === nodeId ? { ...n, ...update } : n
      );
      return { ...manifest, nodes };
    });
  }

  async finalizeManifest(
    cycleNumber: number,
    iteration: number,
    outcome: 'complete' | 'halted'
  ): Promise<void> {
    await this.updateManifest(cycleNumber, iteration, (manifest) => ({
      ...manifest,
      outcome,
      completed_at: new Date().toISOString(),
    }));
  }

  async writeContextPack(
    cycleNumber: number,
    iteration: number,
    pack: ContextPack
  ): Promise<void> {
    const dir = this.runDir(cycleNumber, iteration);
    await this.fs.writeFile(path.join(dir, 'context-pack.json'), JSON.stringify(pack, null, 2));
  }

  async readContextPack(cycleNumber: number, iteration: number): Promise<ContextPack> {
    const packPath = path.join(this.runDir(cycleNumber, iteration), 'context-pack.json');
    try {
      const content = await this.fs.readFile(packPath, 'utf-8');
      return JSON.parse(content) as ContextPack;
    } catch {
      return {};
    }
  }

  async writeNodeOutput(
    cycleNumber: number,
    iteration: number,
    nodeId: string,
    content: string
  ): Promise<void> {
    const dir = this.runDir(cycleNumber, iteration);
    await this.fs.writeFile(
      path.join(dir, 'node-outputs', `${nodeId.toLowerCase()}.md`),
      content
    );
  }

  async dirExists(cycleNumber: number, iteration: number): Promise<boolean> {
    try {
      await this.fs.access(this.runDir(cycleNumber, iteration));
      return true;
    } catch {
      return false;
    }
  }
}

export function initialDAGNodes(): Record<string, { status: NodeStatus }> {
  const nodes: Record<string, { status: NodeStatus }> = {};
  for (const id of CORE_DAG_NODES) {
    nodes[id] = { status: 'pending' };
  }
  return nodes;
}
