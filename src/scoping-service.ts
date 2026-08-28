import { promises as nodeFsPromises } from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import type { AgentRunner } from './agent-runner.js';
import type { CycleStateContext } from './context-manager.js';
import type { RuntimeMapManager } from './runtime-map.js';
import type { TagService } from './tag-service.js';

export interface ScopingBeginResult {
  draft: string;
  charter_path: string;
  awaiting_scoping: true;
}

export interface ScopingApproveResult {
  charter_path: string;
  awaiting_scoping: false;
}

const DEFAULT_MAX_ROUNDS = 5;

export class ScopingService {
  private pendingResponse: string | null = null;
  private roundCount = 0;
  private fs: typeof import('fs').promises;

  constructor(
    private agentRunner: AgentRunner,
    private mapManager: RuntimeMapManager,
    private projectRoot: string,
    fsModule?: typeof import('fs').promises,
    private tagService?: TagService
  ) {
    this.fs = fsModule ?? nodeFsPromises;
  }

  async begin(
    _cycleNumber: number,
    _iteration: number,
    cycleState: CycleStateContext
  ): Promise<ScopingBeginResult> {
    this.pendingResponse = null;
    this.roundCount = 0;

    const taggedRefs = this.tagService
      ? (await this.tagService.getTagged('next-cycle')).map((t) => t.target_ref)
      : [];

    const scopingState: CycleStateContext = {
      ...cycleState,
      current_node: 'SCOPING',
      facilitator_mode: 'scoping',
      ...(taggedRefs.length > 0
        ? { ephemeral: { ...cycleState.ephemeral, next_cycle_tagged_refs: taggedRefs.join(', ') } }
        : {}),
    };
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

  /** Records the raw response, then runs the facilitator to refine the charter draft. */
  async submitResponse(
    response: string,
    _cycleNumber?: number,
    _iteration?: number,
    cycleState?: CycleStateContext
  ): Promise<void> {
    this.pendingResponse = response;
    if (cycleState) {
      await this.processResponse(response, cycleState);
    }
  }

  async processResponse(response: string, cycleState: CycleStateContext): Promise<void> {
    const maxRounds = await this.readMaxRounds();
    this.roundCount++;
    if (this.roundCount > maxRounds) {
      throw Object.assign(
        new Error(`Scoping max rounds (${maxRounds}) exceeded`),
        { code: 'scoping_timeout' }
      );
    }

    const refinementState: CycleStateContext = {
      ...cycleState,
      current_node: 'SCOPING',
      facilitator_mode: 'scoping',
      ephemeral: { ...cycleState.ephemeral, scoping_response: response },
    };

    const result = await this.agentRunner.run('SCOPING', refinementState);
    if (!result.success) {
      throw Object.assign(
        new Error(`SCOPING refinement failed: ${result.error}`),
        { code: 'scoping_failed' }
      );
    }
  }

  async approve(_cycleNumber: number, _iteration: number): Promise<ScopingApproveResult> {
    const draft = await this.getDraft();
    if (!draft) {
      throw Object.assign(
        new Error('No scoping draft available to approve.'),
        { code: 'no_scoping_draft' }
      );
    }

    const hasScope = /^#{1,3}\s*scope\b/im.test(draft);
    const hasPurpose = /^#{1,3}\s*purpose\b/im.test(draft);
    if (!hasScope || !hasPurpose) {
      throw Object.assign(
        new Error('Charter is missing required Scope and/or Purpose sections.'),
        { code: 'charter_validation_failed' }
      );
    }

    await this.mapManager.update((m) => ({
      ...m,
      cycle: { ...m.cycle, awaiting_scoping: false },
    }));

    if (this.tagService) {
      await this.tagService.clearTag('next-cycle');
    }

    this.pendingResponse = null;
    this.roundCount = 0;

    return {
      charter_path: 'docs/cycle-charter.md',
      awaiting_scoping: false,
    };
  }

  getPendingResponse(): string | null {
    return this.pendingResponse;
  }

  getRoundCount(): number {
    return this.roundCount;
  }

  private async readMaxRounds(): Promise<number> {
    try {
      const content = await this.fs.readFile(
        path.join(this.projectRoot, '.sle', 'rules', 'planning.yaml'),
        'utf-8'
      );
      const cfg = yaml.load(content) as { scoping?: { max_rounds?: number } } | undefined;
      return cfg?.scoping?.max_rounds ?? DEFAULT_MAX_ROUNDS;
    } catch {
      return DEFAULT_MAX_ROUNDS;
    }
  }
}
