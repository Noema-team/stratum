import { promises as nodeFsPromises } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type { RuntimeMapManager } from './runtime-map.js';
import type { RunArtifactManager } from './run-artifacts.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SnapshotResult {
  success: boolean;
  snapshot_dir: string;
  snapshot_id: string;
  artifacts_copied: string[];
}

export interface SnapshotMetadata {
  snapshot_id: string;
  cycle_id: string;
  cycle: number;
  iteration: number;
  created_at: string;
  artifacts: string[];
  evaluation_verdict: 'PASS' | 'PARTIAL' | 'FAIL';
  locked: true;
}

// ─── SnapshotService ──────────────────────────────────────────────────────────

export class SnapshotService {
  private fs: typeof import('fs').promises;

  constructor(
    private mapManager: RuntimeMapManager,
    private runArtifacts: RunArtifactManager,
    private projectRoot: string,
    fsModule?: typeof import('fs').promises
  ) {
    this.fs = fsModule ?? nodeFsPromises;
  }

  snapshotDir(workflowRunId: string, iteration: number): string {
    return path.join(this.projectRoot, '.sle', 'snapshots', workflowRunId, String(iteration));
  }

  async run(workflowRunId: string, iteration: number): Promise<SnapshotResult> {
    const startedAt = new Date().toISOString();
    const snapshotId = randomUUID();

    await this.runArtifacts.updateNodeStatus(workflowRunId, iteration, 'SNAPSHOT', {
      status: 'running',
      started_at: startedAt,
    });
    await this.mapManager.update((m) => ({
      ...m,
      meta: {
        ...m.meta,
        dag: m.meta.dag ? { ...m.meta.dag, current_node: 'SNAPSHOT' } : undefined,
      },
    }));

    // Read cycle metadata from manifest and artifact paths from map
    let cycleNumber = 0;
    try {
      const manifest = await this.runArtifacts.readManifest(workflowRunId, iteration);
      cycleNumber = manifest.cycle_number;
    } catch {
      // Fallback: cycle_number unknown, use 0 for display
    }

    const map = await this.mapManager.read();
    const artifactPaths: string[] = (map.artifacts ?? []).map(
      (a: { path: string }) => a.path
    );

    // Create snapshot directory
    const snapDir = this.snapshotDir(workflowRunId, iteration);
    await this.fs.mkdir(snapDir, { recursive: true });

    // Copy each artifact; skip files that don't exist yet
    const copied: string[] = [];
    for (const artifactPath of artifactPaths) {
      const src = path.join(this.projectRoot, artifactPath);
      const dest = path.join(snapDir, artifactPath);
      try {
        const content = await this.fs.readFile(src, 'utf-8');
        await this.fs.mkdir(path.dirname(dest), { recursive: true });
        await this.fs.writeFile(dest, content, 'utf-8');
        copied.push(artifactPath);
      } catch {
        // Artifact file not present — skip
      }
    }

    // Write snapshot metadata
    const metadata: SnapshotMetadata = {
      snapshot_id: snapshotId,
      cycle_id: workflowRunId,
      cycle: cycleNumber,
      iteration,
      created_at: startedAt,
      artifacts: copied,
      evaluation_verdict: 'PASS',
      locked: true,
    };
    await this.fs.writeFile(
      path.join(snapDir, 'snapshot.json'),
      JSON.stringify(metadata, null, 2),
      'utf-8'
    );

    // Write .locked sentinel
    await this.fs.writeFile(path.join(snapDir, '.locked'), '', 'utf-8');

    const completedAt = new Date().toISOString();
    const snapshotJsonPath = path.join(
      '.sle', 'snapshots', workflowRunId, String(iteration), 'snapshot.json'
    );

    await this.runArtifacts.updateNodeStatus(workflowRunId, iteration, 'SNAPSHOT', {
      status: 'complete',
      completed_at: completedAt,
      artifacts_written: [snapshotJsonPath],
    });
    await this.runArtifacts.finalizeManifest(workflowRunId, iteration, 'complete');

    await this.mapManager.update((m) => {
      const completedNodes = [...(m.meta.dag?.completed_nodes ?? [])];
      if (!completedNodes.includes('SNAPSHOT')) completedNodes.push('SNAPSHOT');
      return {
        ...m,
        meta: {
          ...m.meta,
          dag: m.meta.dag
            ? { ...m.meta.dag, current_node: null, completed_nodes: completedNodes }
            : undefined,
        },
      };
    });

    return {
      success: true,
      snapshot_dir: snapDir,
      snapshot_id: snapshotId,
      artifacts_copied: copied,
    };
  }
}
