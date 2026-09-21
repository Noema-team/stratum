import { promises as nodeFsPromises } from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import type { AgentRunner } from './agent-runner.js';
import type { RuntimeMapManager } from './runtime-map.js';
import type { TagService } from './tag-service.js';
import type { StepRunContext } from './workflow/types.js';

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

// E19 — the charter's deterministic structural contract, shared by begin()
// (fail closed BEFORE any approval state is set — an invalid charter must
// never reach the checkpoint) and approve() (the consumer that historically
// owned these checks alone — too late: A8 reached the checkpoint with a
// charter no consumer could accept). The regexes are approve()'s original
// ones, unchanged; the only new behavior is that the SAME check now also
// gates the produce step itself.
export function validateCharterStructure(
  draft: string,
): { ok: true } | { ok: false; error: string } {
  const hasScope = /^#{1,3}\s*scope\b/im.test(draft);
  const hasPurpose = /^#{1,3}\s*purpose\b/im.test(draft);
  if (!hasScope || !hasPurpose) {
    return {
      ok: false,
      error:
        'Charter is missing required Scope and/or Purpose sections. ' +
        'Required heading syntax (validated deterministically): `## Scope` and `## Purpose`.',
    };
  }
  return { ok: true };
}

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
    ctx: StepRunContext,
  ): Promise<ScopingBeginResult> {
    this.pendingResponse = null;
    this.roundCount = 0;

    const taggedRefs = this.tagService
      ? (await this.tagService.getTagged('next-cycle')).map((t) => t.target_ref)
      : [];

    const scopingCtx: StepRunContext = {
      ...ctx,
      stepId: 'scoping.produce',
      role: 'facilitator',
      facilitatorMode: 'scoping',
      ...(taggedRefs.length > 0
        ? { ephemeral: { ...ctx.ephemeral, next_cycle_tagged_refs: taggedRefs.join(', ') } }
        : {}),
    };
    const result = await this.agentRunner.run('facilitator', scopingCtx);

    if (!result.success) {
      throw Object.assign(
        new Error(`SCOPING node failed: ${result.error}`),
        { code: 'scoping_failed' }
      );
    }

    // E19 — fail closed BEFORE any approval state: the step declares
    // docs/cycle-charter.md as its single output artifact (AgentRunner
    // enforces and materializes it), so a missing file here is a failed
    // step — never an awaiting-approval state for a charter that does not
    // exist (the exact trap A8 died in at approve() time).
    const draft = await this.getDraft();
    if (draft === null) {
      throw Object.assign(
        new Error('Scoping produced no cycle charter at docs/cycle-charter.md.'),
        { code: 'no_scoping_draft' }
      );
    }
    const structural = validateCharterStructure(draft);
    if (!structural.ok) {
      throw Object.assign(
        new Error(`Cycle charter failed structural validation: ${structural.error}`),
        { code: 'charter_validation_failed' }
      );
    }

    await this.mapManager.update((m) => ({
      ...m,
      cycle: { ...m.cycle, awaiting_scoping: true },
    }));

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
    ctx?: StepRunContext,
  ): Promise<void> {
    this.pendingResponse = response;
    if (ctx) {
      await this.processResponse(response, ctx);
    }
  }

  async processResponse(response: string, ctx: StepRunContext): Promise<void> {
    const maxRounds = await this.readMaxRounds();
    this.roundCount++;
    if (this.roundCount > maxRounds) {
      throw Object.assign(
        new Error(`Scoping max rounds (${maxRounds}) exceeded`),
        { code: 'scoping_timeout' }
      );
    }

    const refinementCtx: StepRunContext = {
      ...ctx,
      stepId: 'scoping.produce',
      role: 'facilitator',
      facilitatorMode: 'scoping',
      ephemeral: { ...ctx.ephemeral, scoping_response: response },
    };

    const result = await this.agentRunner.run('facilitator', refinementCtx);
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

    // E19 — same shared structural contract begin() enforces; a charter
    // that passed the produce step cannot fail here (defense in depth for
    // charters written by other paths).
    const structural = validateCharterStructure(draft);
    if (!structural.ok) {
      throw Object.assign(
        new Error(`Charter validation failed: ${structural.error}`),
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
