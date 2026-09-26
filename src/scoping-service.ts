import { promises as nodeFsPromises } from 'fs';
import { toSafeRelativePath } from './path-safety.js';
import { persistStructuralRepairEvidence } from './bounded-structural-repair.js';
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
    let draft = await this.getDraft();
    if (draft === null) {
      throw Object.assign(
        new Error('Scoping produced no cycle charter at docs/cycle-charter.md.'),
        { code: 'no_scoping_draft' }
      );
    }
    let structural = validateCharterStructure(draft);
    // V3 — bounded structural repair for the charter gate: exactly ONE
    // validator-driven repair turn when the workflow declared it. The SAME
    // validator (validateCharterStructure) reruns on the repaired charter;
    // its verdict is final. Evidence (original charter, validator error,
    // repair instruction as issued, repair output, second validation) is
    // persisted either way and never overwrites the original failure
    // material. The contract text is derived from the step's declared
    // output artifact and the validator's own error — nothing is
    // special-cased to any particular requirement.
    if (!structural.ok && ctx.structuralRepair === true) {
      const validatorError = `Cycle charter failed structural validation: ${structural.error}`;
      const contractText = [
        `The step's declared output artifact (exact path): ${ctx.outputArtifact?.path ?? 'docs/cycle-charter.md'}`,
        `The charter structural validator's requirement, verbatim: ${structural.error}`,
      ].join('\n');
      const repair = await this.agentRunner.runStructuralRepairTurn(
        'facilitator', scopingCtx, 'scoping.produce',
        { validator: 'charter-structure', validatorError, contractText, originalOutput: draft },
      );
      // Publication authority: the candidate charter bytes are validated
      // IN MEMORY first. docs/cycle-charter.md is written ONLY when the
      // validator accepts the repair — a rejected repair is preserved as
      // evidence and the workspace artifact keeps the original bytes.
      const candidate = repair.ok
        ? this.repairedCharterCandidate(ctx, repair.parsed)
        : null;
      const second: { ok: boolean; error: string | null } = repair.ok
        ? (candidate !== null
            ? (() => { const v = validateCharterStructure(candidate); return v.ok ? { ok: true, error: null } : { ok: false, error: v.error }; })()
            : { ok: false, error: 'repair turn produced no charter artifact' })
        : { ok: false, error: `repair invocation failed: ${repair.error}` };
      await persistStructuralRepairEvidence(
        this.projectRoot, ctx.workflowRunId, ctx.iteration, 'scoping.produce',
        {
          stage_id: 'scoping.produce',
          validator: 'charter-structure',
          original_output: draft,
          validation_error: validatorError,
          output_contract: contractText,
          repair_instruction: repair.repairInstruction,
          repair_output: repair.ok ? repair.rawText : '',
          second_validation: { ok: second.ok, error: second.ok ? null : second.error },
          repair_invocation_error: repair.ok ? null : repair.error,
          invoked_at: new Date().toISOString(),
        },
        this.fs,
      );
      if (second.ok && candidate !== null) {
        await this.writeCharter(ctx, candidate);
        structural = { ok: true };
        draft = candidate;
        // The repaired charter is the material the checkpoint publishes.
      } else {
        throw Object.assign(
          new Error(`Cycle charter failed structural validation: ${structural.error}` +
            ` — bounded structural repair was attempted and did not pass (${second.error})`),
          { code: 'charter_validation_failed' }
        );
      }
    } else if (!structural.ok) {
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


  /**
   * V3 — extract the repair turn's charter CANDIDATE bytes WITHOUT writing
   * anything. Fails closed unless the repair output is EXACTLY the declared
   * single artifact at a safe canonical path: any unsafe path, any extra
   * section, or a missing charter section returns null. The validator runs
   * on the candidate BEFORE anything touches the workspace — publication
   * happens only via writeCharter after acceptance. The charter path is the
   * step's declared output artifact — never a hardcoded constant.
   */
  private repairedCharterCandidate(
    ctx: StepRunContext,
    parsed: { sections: Array<{ path: string; content: string }> },
  ): string | null {
    const declared = ctx.outputArtifact?.path ?? 'docs/cycle-charter.md';
    const canonical = parsed.sections.map((s) => ({ safe: toSafeRelativePath(s.path), content: s.content }));
    if (canonical.some((s) => s.safe === null)) return null;
    if (canonical.length !== 1 || canonical[0].safe !== declared) return null;
    return canonical[0].content;
  }

  /** V3 — publish ACCEPTED charter bytes to the declared artifact path. */
  private async writeCharter(ctx: StepRunContext, content: string): Promise<void> {
    const declared = ctx.outputArtifact?.path ?? 'docs/cycle-charter.md';
    const target = path.join(this.projectRoot, declared);
    await this.fs.mkdir(path.dirname(target), { recursive: true });
    await this.fs.writeFile(target, content);
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
