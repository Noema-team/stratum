import { promises as nodeFsPromises } from 'fs';
import path from 'path';
import type { NodeStatus, PlanningDepth, FailureReport } from './types.js';

export const CORE_DAG_NODES = [
  'SCOPING',
  'DESIGN',
  'CRITIQUE',
  'PLAN',
  'TEST',
  'SHARDING_APPROVAL',
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
  skip_reason?: string;
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

  runDir(workflowRunId: string, iteration: number): string {
    return path.join(this.projectRoot, '.sle', 'runs', workflowRunId, String(iteration));
  }

  async createRunDir(workflowRunId: string, iteration: number): Promise<string> {
    const dir = this.runDir(workflowRunId, iteration);
    await this.fs.mkdir(path.join(dir, 'validation'), { recursive: true });
    await this.fs.mkdir(path.join(dir, 'node-outputs'), { recursive: true });
    await this.fs.mkdir(path.join(dir, 'ai'), { recursive: true });
    return dir;
  }

  async createManifest(params: {
    cycleId: string;
    cycleNumber?: number;
    iteration: number;
    planningDepth?: PlanningDepth;
    // Step IDs for this workflow run. Falls back to CORE_DAG_NODES when absent
    // (legacy full-build compatibility). Pass the WorkflowDefinition step IDs here.
    stepIds?: string[];
    // When true, skip writing if manifest.json already exists (idempotent on resume).
    ifNotExists?: boolean;
  }): Promise<void> {
    const dir = this.runDir(params.cycleId, params.iteration);
    const manifestPath = path.join(dir, 'manifest.json');
    if (params.ifNotExists) {
      try {
        await this.fs.access(manifestPath);
        return; // already exists — skip
      } catch {
        // does not exist — proceed
      }
    }
    const nodeIds = params.stepIds ?? (CORE_DAG_NODES as readonly string[]);
    const manifest: RunManifest = {
      cycle_id: params.cycleId,
      cycle_number: params.cycleNumber ?? 1,
      iteration: params.iteration,
      planning_depth: params.planningDepth ?? 'minimal',
      started_at: new Date().toISOString(),
      outcome: 'in_progress',
      nodes: nodeIds.map((id) => ({
        id,
        status: 'pending',
        artifacts_written: [],
      })),
    };
    await this.fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  }

  async readManifest(workflowRunId: string, iteration: number): Promise<RunManifest> {
    const manifestPath = path.join(this.runDir(workflowRunId, iteration), 'manifest.json');
    const content = await this.fs.readFile(manifestPath, 'utf-8');
    return JSON.parse(content) as RunManifest;
  }

  async updateManifest(
    workflowRunId: string,
    iteration: number,
    updater: (manifest: RunManifest) => RunManifest
  ): Promise<void> {
    const manifest = await this.readManifest(workflowRunId, iteration);
    const updated = updater(manifest);
    const dir = this.runDir(workflowRunId, iteration);
    await this.fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(updated, null, 2));
  }

  async updateNodeStatus(
    workflowRunId: string,
    iteration: number,
    nodeId: string,
    update: Partial<Omit<ManifestNodeEntry, 'id'>>
  ): Promise<void> {
    try {
      await this.updateManifest(workflowRunId, iteration, (manifest) => {
        // Add the node entry if it wasn't pre-declared (e.g. workflow uses stepIds
        // that differ from CORE_DAG_NODES, or the manifest predates this step).
        const existing = manifest.nodes.find(n => n.id === nodeId);
        if (!existing) {
          return {
            ...manifest,
            nodes: [...manifest.nodes, { id: nodeId, status: 'pending', artifacts_written: [], ...update }],
          };
        }
        const nodes = manifest.nodes.map((n) =>
          n.id === nodeId ? { ...n, ...update } : n
        );
        return { ...manifest, nodes };
      });
    } catch {
      // Non-fatal: manifest may not exist yet (run dir created after first step).
      // RunArtifacts are observability — updateNodeStatus must never abort execution.
    }
  }

  async finalizeManifest(
    workflowRunId: string,
    iteration: number,
    outcome: 'complete' | 'halted'
  ): Promise<void> {
    await this.updateManifest(workflowRunId, iteration, (manifest) => ({
      ...manifest,
      outcome,
      completed_at: new Date().toISOString(),
    }));
  }

  async writeContextPack(
    workflowRunId: string,
    iteration: number,
    pack: ContextPack
  ): Promise<void> {
    const dir = this.runDir(workflowRunId, iteration);
    const md = `# Context Pack\n\n\`\`\`json\n${JSON.stringify(pack, null, 2)}\n\`\`\`\n`;
    await this.fs.writeFile(path.join(dir, 'ai', 'context-pack.md'), md);
  }

  async readContextPack(workflowRunId: string, iteration: number): Promise<ContextPack> {
    const packPath = path.join(this.runDir(workflowRunId, iteration), 'ai', 'context-pack.md');
    try {
      const content = await this.fs.readFile(packPath, 'utf-8');
      const match = content.match(/```json\n([\s\S]*?)\n```/);
      if (!match) return {};
      return JSON.parse(match[1]) as ContextPack;
    } catch {
      return {};
    }
  }

  async writeNodeOutput(
    workflowRunId: string,
    iteration: number,
    nodeId: string,
    content: string
  ): Promise<void> {
    const dir = this.runDir(workflowRunId, iteration);
    await this.fs.writeFile(
      path.join(dir, 'node-outputs', `${nodeId.toLowerCase()}.md`),
      content
    );
  }

  async dirExists(workflowRunId: string, iteration: number): Promise<boolean> {
    try {
      await this.fs.access(this.runDir(workflowRunId, iteration));
      return true;
    } catch {
      return false;
    }
  }

  async writeFailureReport(
    workflowRunId: string,
    iteration: number,
    report: FailureReport
  ): Promise<void> {
    const dir = this.runDir(workflowRunId, iteration);
    await this.fs.writeFile(
      path.join(dir, 'failure-report.json'),
      JSON.stringify(report, null, 2)
    );
  }

  async readFailureReport(
    workflowRunId: string,
    iteration: number
  ): Promise<FailureReport | null> {
    const reportPath = path.join(this.runDir(workflowRunId, iteration), 'failure-report.json');
    try {
      const content = await this.fs.readFile(reportPath, 'utf-8');
      return JSON.parse(content) as FailureReport;
    } catch {
      return null;
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
