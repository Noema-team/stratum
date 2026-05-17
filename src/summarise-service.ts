import { promises as nodeFsPromises } from 'fs';
import path from 'path';
import type { RuntimeMapManager } from './runtime-map.js';
import type { RunArtifactManager } from './run-artifacts.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SummariseResult {
  success: boolean;
  summary_path: string;
}

// ─── SummariseService ─────────────────────────────────────────────────────────

export class SummariseService {
  private fs: typeof import('fs').promises;

  constructor(
    private mapManager: RuntimeMapManager,
    private runArtifacts: RunArtifactManager,
    private projectRoot: string,
    fsModule?: typeof import('fs').promises
  ) {
    this.fs = fsModule ?? nodeFsPromises;
  }

  async run(cycleNumber: number, iteration: number): Promise<SummariseResult> {
    const startedAt = new Date().toISOString();

    await this.runArtifacts.updateNodeStatus(cycleNumber, iteration, 'SUMMARISE', {
      status: 'running',
      started_at: startedAt,
    });
    await this.mapManager.update((m) => ({
      ...m,
      meta: {
        ...m.meta,
        dag: m.meta.dag ? { ...m.meta.dag, current_node: 'SUMMARISE' } : undefined,
      },
    }));

    const map = await this.mapManager.read();
    const manifest = await this.runArtifacts.readManifest(cycleNumber, iteration);

    const completedNodes = (map.meta.dag?.completed_nodes ?? []).filter(
      (n) => n !== 'SUMMARISE'
    );
    const artifactPaths = (map.artifacts ?? []).map((a: { path: string }) => a.path);
    const totalTokens = manifest.nodes.reduce(
      (sum, n) => sum + (n.tokens_used ?? 0),
      0
    );
    const intent = (map.cycle as { intent?: string }).intent ?? '';

    const lines = [
      `# Cycle ${cycleNumber} Summary`,
      '',
      `**Intent:** ${intent}`,
      `**Cycle:** ${cycleNumber}`,
      `**Iteration:** ${iteration}`,
      `**Started:** ${map.cycle.started_at ?? ''}`,
      `**Completed:** ${startedAt}`,
      '',
      `## Nodes Completed (${completedNodes.length})`,
      completedNodes.join(', '),
      '',
      `## Artifacts Produced (${artifactPaths.length})`,
      ...artifactPaths.map((p) => `- ${p}`),
      '',
      '## Token Usage',
      `Total: ${totalTokens.toLocaleString()} tokens`,
    ];

    const summaryContent = lines.join('\n');
    const summaryRelPath = 'docs/cycle-summary.md';
    const summaryPath = path.join(this.projectRoot, summaryRelPath);
    await this.fs.mkdir(path.dirname(summaryPath), { recursive: true });
    await this.fs.writeFile(summaryPath, summaryContent, 'utf-8');

    const completedAt = new Date().toISOString();
    await this.runArtifacts.updateNodeStatus(cycleNumber, iteration, 'SUMMARISE', {
      status: 'complete',
      completed_at: completedAt,
      artifacts_written: [summaryRelPath],
    });

    // Advance DAG state: SUMMARISE → SNAPSHOT
    const completedNodesList = [...(map.meta.dag?.completed_nodes ?? [])];
    if (!completedNodesList.includes('SUMMARISE')) completedNodesList.push('SUMMARISE');
    await this.mapManager.update((m) => ({
      ...m,
      meta: {
        ...m.meta,
        dag: m.meta.dag
          ? { ...m.meta.dag, current_node: 'SNAPSHOT', completed_nodes: completedNodesList }
          : undefined,
      },
    }));

    return { success: true, summary_path: summaryRelPath };
  }
}
