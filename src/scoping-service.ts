import { promises as nodeFsPromises } from 'fs';
import path from 'path';
import type { AgentRunner } from './agent-runner.js';
import type { CycleStateContext } from './context-manager.js';
import type { RuntimeMapManager } from './runtime-map.js';

export interface ScopingBeginResult {
  draft: string;
  charter_path: string;
  awaiting_scoping: true;
}

export interface ScopingApproveResult {
  charter_path: string;
  awaiting_scoping: false;
}

export class ScopingService {
  private pendingResponse: string | null = null;
  private fs: typeof import('fs').promises;

  constructor(
    private agentRunner: AgentRunner,
    private mapManager: RuntimeMapManager,
    private projectRoot: string,
    fsModule?: typeof import('fs').promises
  ) {
    this.fs = fsModule ?? nodeFsPromises;
  }

  async begin(
    _cycleNumber: number,
    _iteration: number,
    cycleState: CycleStateContext
  ): Promise<ScopingBeginResult> {
    this.pendingResponse = null;

    const scopingState: CycleStateContext = { ...cycleState, current_node: 'SCOPING' };
    const result = await this.agentRunner.run('SCOPING', scopingState);

    if (!result.success) {
      throw Object.assign(
        new Error(`SCOPING node failed: ${result.error}`),
        { code: 'scoping_failed' }
      );
    }

    await this.mapManager.update((m) => ({
      ...m,
      cycle: { ...m.cycle, awaiting_scoping: true },
    }));

    const draft = await this.getDraft() ?? '';
    return {
      draft,
      charter_path: 'docs/cycle-charter.md',
      awaiting_scoping: true,
    };
  }

  async getDraft(): Promise<string | null> {
    const charterPath = path.join(this.projectRoot, 'docs', 'cycle-charter.md');
    try {
      return await this.fs.readFile(charterPath, 'utf-8');
    } catch {
      return null;
    }
  }

  async submitResponse(response: string): Promise<void> {
    this.pendingResponse = response;
  }

  async approve(_cycleNumber: number, _iteration: number): Promise<ScopingApproveResult> {
    const draft = await this.getDraft();
    if (!draft) {
      throw Object.assign(
        new Error('No scoping draft available to approve.'),
        { code: 'no_scoping_draft' }
      );
    }

    await this.mapManager.update((m) => ({
      ...m,
      cycle: { ...m.cycle, awaiting_scoping: false },
    }));

    this.pendingResponse = null;

    return {
      charter_path: 'docs/cycle-charter.md',
      awaiting_scoping: false,
    };
  }

  getPendingResponse(): string | null {
    return this.pendingResponse;
  }
}
