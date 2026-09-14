// D.34 C7 review closure — the evidence path must hold END TO END:
// a real RunArtifactManager writes raw node-outputs under the fixture root;
// persistRunEvidence copies them out for a failed run; the fixture root is
// deleted; the evidence (including the model's actual raw reply) survives
// under run-evidence/ and is readable. Also pins the run-id-lost path: when
// driveDefineWorkRun() threw and only the synthetic placeholder id remains,
// ALL of .sle/runs is preserved so pre-throw evidence is never missed.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RunArtifactManager } from '../src/run-artifacts.js';
import { persistRunEvidence, RUN_ID_LOST } from '../tests/fixtures/d3d/evidence.js';

test('D.34.C7 EVIDENCE: a real failed run’s raw node output survives fixture-root deletion', async () => {
  const root = mkdtempSync(join(tmpdir(), 'd34-c7-ev-'));
  const outDir = mkdtempSync(join(tmpdir(), 'd34-c7-ev-out-'));
  try {
    // The harness (post-closure) constructs a REAL RunArtifactManager — do
    // the same here and record what AgentRunner would record for a failed
    // step: the model's actual raw reply.
    const runArtifacts = new RunArtifactManager({ projectRoot: root });
    await runArtifacts.createRunDir('run-abc', 1);
    await runArtifacts.writeNodeOutput('run-abc', 1, 'SYNTHESIZE_DEFINITION', '{ "goal": "the model’s actual raw reply" }');
    await runArtifacts.writeNodeOutput('run-abc', 1, 'definition-readiness-review', 'raw review prose');
    // The real manager writes under .sle/runs/<run>/<iter>/node-outputs/.
    assert.ok(existsSync(join(root, '.sle', 'runs', 'run-abc', '1', 'node-outputs', 'synthesize_definition.md')));

    // The C7 collector copies the evidence out BEFORE the root is deleted.
    const evidenceDir = join(outDir, 'partial', 'run-evidence');
    const persisted = await persistRunEvidence(root, evidenceDir, 'run-abc');
    assert.ok(persisted.copied.includes(join('runs', 'run-abc')));

    // The fixture root goes away (the eval script’s finally block).
    rmSync(root, { recursive: true, force: true });
    assert.equal(existsSync(root), false);

    // The evidence — including the raw reply — survived and is readable.
    const survived = readFileSync(
      join(evidenceDir, 'runs', 'run-abc', '1', 'node-outputs', 'synthesize_definition.md'),
      'utf-8',
    );
    assert.match(survived, /the model’s actual raw reply/);
    assert.ok(existsSync(join(evidenceDir, 'runs', 'run-abc', '1', 'node-outputs', 'definition-readiness-review.md')));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('D.34.C7 EVIDENCE: a LOST run id preserves ALL of .sle/runs (pre-throw evidence not missed)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'd34-c7-ev2-'));
  const outDir = mkdtempSync(join(tmpdir(), 'd34-c7-ev2-out-'));
  try {
    const runArtifacts = new RunArtifactManager({ projectRoot: root });
    await runArtifacts.createRunDir('run-real-1', 1);
    await runArtifacts.writeNodeOutput('run-real-1', 1, 'SYNTHESIZE_DEFINITION', 'evidence written before the throw');

    // The run threw before completion — the report only has the placeholder.
    const evidenceDir = join(outDir, 'early', 'run-evidence');
    const persisted = await persistRunEvidence(root, evidenceDir, RUN_ID_LOST);
    assert.ok(persisted.copied.includes('runs'), 'the whole runs tree is preserved');
    const survived = readFileSync(
      join(evidenceDir, 'runs', 'run-real-1', '1', 'node-outputs', 'synthesize_definition.md'),
      'utf-8',
    );
    assert.match(survived, /evidence written before the throw/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('D.34.C7 EVIDENCE: a root with no runs/work dirs persists nothing and does not crash', async () => {
  const root = mkdtempSync(join(tmpdir(), 'd34-c7-ev3-'));
  const outDir = mkdtempSync(join(tmpdir(), 'd34-c7-ev3-out-'));
  try {
    const persisted = await persistRunEvidence(root, join(outDir, 'run-evidence'), 'run-x');
    assert.deepEqual(persisted.copied, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('D.34.C7 EVIDENCE: work artifacts (.sle/work) are preserved alongside runs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'd34-c7-ev4-'));
  const outDir = mkdtempSync(join(tmpdir(), 'd34-c7-ev4-out-'));
  try {
    mkdirSync(join(root, '.sle', 'work', 'wi-1'), { recursive: true });
    writeFileSync(join(root, '.sle', 'work', 'wi-1', 'definition.md'), '---\nschemaVersion: 1\ngoal: "g"\nfacts: []\n---\n', 'utf-8');
    const evidenceDir = join(outDir, 'run-evidence');
    const persisted = await persistRunEvidence(root, evidenceDir, null);
    assert.ok(persisted.copied.includes('work'));
    assert.match(readFileSync(join(evidenceDir, 'work', 'wi-1', 'definition.md'), 'utf-8'), /schemaVersion: 1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});
