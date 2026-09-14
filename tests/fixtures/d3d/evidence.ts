// D.34 C7 review closure — the evidence collector for the live-provider
// qualification (audit finding F6). Extracted from the eval script so it is
// UNIT-TESTABLE: a failed run's raw node-outputs and generated artifacts must
// survive the deletion of the temporary fixture root, and the diagnosis in
// report.json must be verifiable by hand against them.
//
// The run ID can be LOST: when driveDefineWorkRun() throws before completing,
// the synthetic placeholder id '(none — run threw before completion)' is all
// the report has — in that case ALL of .sle/runs is preserved, so pre-throw
// evidence from the real run (the harness uses a REAL RunArtifactManager and
// writes node-outputs under .sle/runs/<run>/<iteration>/node-outputs/) is
// never missed.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { existsSync } from 'node:fs';

/** The synthetic id the eval script records when a run threw before completion. */
export const RUN_ID_LOST = '(none — run threw before completion)';

export interface PersistedEvidence {
  /** Top-level entries actually copied, relative to evidenceDir. */
  copied: string[];
}

/**
 * Copy a failed run's evidence out of `root` into `evidenceDir` BEFORE the
 * fixture root is deleted. Idempotent, fail-soft: an absent directory is
 * simply not copied (there is nothing to preserve); a real copy error
 * propagates (silently losing evidence would defeat the whole point).
 */
export async function persistRunEvidence(
  root: string,
  evidenceDir: string,
  workflowRunId: string | null | undefined,
): Promise<PersistedEvidence> {
  await fs.mkdir(evidenceDir, { recursive: true });
  const copied: string[] = [];

  const idLooksReal =
    typeof workflowRunId === 'string' &&
    workflowRunId.length > 0 &&
    workflowRunId !== RUN_ID_LOST;

  const runsRoot = path.join(root, '.sle', 'runs');
  if (idLooksReal && existsSync(path.join(runsRoot, workflowRunId!))) {
    await fs.cp(path.join(runsRoot, workflowRunId!), path.join(evidenceDir, 'runs', workflowRunId!), { recursive: true });
    copied.push(path.join('runs', workflowRunId!));
  } else if (existsSync(runsRoot)) {
    // Run id lost (threw before completion) — preserve ALL runs so pre-throw
    // evidence from the real run is not missed.
    await fs.cp(runsRoot, path.join(evidenceDir, 'runs'), { recursive: true });
    copied.push('runs');
  }

  const workDir = path.join(root, '.sle', 'work');
  if (existsSync(workDir)) {
    await fs.cp(workDir, path.join(evidenceDir, 'work'), { recursive: true });
    copied.push('work');
  }

  return { copied };
}
