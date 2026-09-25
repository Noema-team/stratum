// ============================================================================
// V3 — bounded structural repair (one validator-driven repair turn).
//
// Scope contract (pilot-a V3 preregistration, evidence/v3-preregistration.json):
//   • When deterministic structural validation rejects an otherwise completed
//     stage output, the step may run EXACTLY ONE validator-driven repair turn
//     before declaring the stage failed.
//   • The repair input is: the model's submitted output, the EXACT
//     deterministic validation errors, the frozen output contract, and an
//     instruction to repair those violations without changing unrelated
//     accepted material. Nothing else.
//   • The SAME validator reruns on the repair output. PASS → the stage
//     continues with the repaired output. FAIL → stage failure.
//   • The validator remains authoritative. The model never gets to waive a
//     requirement.
//   • GENERIC and validator-derived: the instruction template below contains
//     no knowledge of any specific requirement (no section names, no paths).
//     Everything requirement-specific travels in the validator's own error
//     text and the step's declared contract.
//   • Evidence is mandatory and never overwritten: the original output, the
//     validator findings, the repair instruction as issued, the repair
//     output, and the second validation result are all persisted.
// ============================================================================

import path from 'path';

export interface StructuralRepairEvidence {
  /** The step that was rejected, e.g. 'scoping.produce' or 'design'. */
  stage_id: string;
  /** Which deterministic validator issued the rejection. */
  validator: string;
  /** The model's submitted output (original bytes, preserved verbatim). */
  original_output: string;
  /** The exact deterministic validation error, as issued by the validator. */
  validation_error: string;
  /** The frozen output contract as restated to the model. */
  output_contract: string;
  /** The repair instruction exactly as issued (validator-derived, generic). */
  repair_instruction: string;
  /** The repair turn's output bytes ('' when the repair turn itself failed). */
  repair_output: string;
  /** Result of rerunning the SAME validator on the repair output. */
  second_validation: { ok: boolean; error: string | null };
  /** Set when the repair invocation itself failed (provider/transport). */
  repair_invocation_error: string | null;
  invoked_at: string;
}

/**
 * Build the generic, validator-derived repair instruction. Every
 * requirement-specific detail arrives via `validatorError` and `contractText`
 * — this template hardcodes no requirements of any specific step.
 */
export function buildStructuralRepairInstruction(opts: {
  validatorError: string;
  contractText: string;
  originalOutput: string;
}): string {
  return [
    'A deterministic structural validator rejected your submitted output. This is a bounded repair turn: repair EXACTLY the violations listed below, without changing, removing, or rewording unrelated accepted material.',
    '',
    '## Validation errors (deterministic — these must be fixed)',
    '',
    opts.validatorError,
    '',
    '## Output contract (frozen — unchanged by this repair)',
    '',
    opts.contractText,
    '',
    '## Your submitted output (rejected)',
    '',
    '```',
    opts.originalOutput,
    '```',
    '',
    'Re-submit the COMPLETE output in exactly the same format as your original submission, with the listed violations repaired. Do not add commentary outside the output format. The same validator will rerun on your repair; if it still rejects the output, the stage fails with both results preserved.',
  ].join('\n');
}

/**
 * Persist the mandatory repair evidence under the run's node-outputs
 * directory. NEVER overwrites: if the evidence file already exists (it
 * should not — one repair per stage run), a numeric suffix is appended so
 * failure evidence can never be lost.
 */
export async function persistStructuralRepairEvidence(
  projectRoot: string,
  workflowRunId: string,
  iteration: number,
  stageId: string,
  evidence: StructuralRepairEvidence,
  fs: typeof import('fs').promises,
): Promise<string> {
  const dir = path.join(
    projectRoot, '.sle', 'runs', workflowRunId, String(iteration), 'node-outputs',
  );
  await fs.mkdir(dir, { recursive: true });
  const base = path.join(dir, `${stageId.toLowerCase()}.structural-repair.json`);
  let target = base;
  let n = 2;
  while (true) {
    try {
      await fs.access(target);
      target = path.join(dir, `${stageId.toLowerCase()}.structural-repair-${n}.json`);
      n += 1;
    } catch {
      break; // does not exist — safe to write
    }
  }
  await fs.writeFile(target, JSON.stringify(evidence, null, 2) + '\n');
  return target;
}
