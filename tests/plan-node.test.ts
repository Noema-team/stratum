import { test } from 'node:test';
import { strict as assert } from 'assert';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import { promises as fs } from 'fs';
import { join } from 'path';
import { ContextManager } from '../src/context-manager.js';
import { DEFAULT_CONFIG } from '../src/context-manager.js';
import { buildUserMessage } from '../src/agent-runner.js';
import type { CycleStateContext } from '../src/context-manager.js';
import type { FailureReport } from '../src/types.js';
import { RunArtifactManager as RealRunArtifactManager } from '../src/run-artifacts.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'sle-plan-test-'));
}

// ─── writeFailureReport / readFailureReport tests ─────────────────────────────

test('testWriteAndReadFailureReport', async () => {
  const root = makeTempDir();
  const ram = new RealRunArtifactManager({ projectRoot: root });
  await ram.createRunDir(1, 1);

  const report: FailureReport = {
    cycle: 1,
    iteration: 1,
    run_dir: '.sle/runs/1-1',
    run_id: '1-1',
    quick_summary: 'Correctness checks failed.',
    failed_categories: [
      { name: 'correctness', method: 'executable' as const, error_summary: 'Correctness check failed' },
      { name: 'coverage', method: 'executable' as const, error_summary: 'Coverage check failed' },
    ],
    passed_categories: ['style'],
  };
  await ram.writeFailureReport(1, 1, report);

  const read = await ram.readFailureReport(1, 1);
  assert.deepStrictEqual(read, report);
});

test('testReadFailureReportMissingReturnsNull', async () => {
  const root = makeTempDir();
  const ram = new RealRunArtifactManager({ projectRoot: root });
  await ram.createRunDir(1, 1);

  const result = await ram.readFailureReport(1, 1);
  assert.strictEqual(result, null);
});

// ─── Failure context injection ────────────────────────────────────────────────

test('testFailureContextInContextAssembly', async () => {
  // Verify the ContextManager includes failure_context for iteration > 1 with a report
  const root = makeTempDir();
  await fs.mkdir(join(root, 'docs'), { recursive: true });
  await fs.writeFile(join(root, 'docs/requirements.md'), '# Req\nContent.', 'utf-8');

  const fsMock = {
    readFile: async (p: unknown) => {
      const key = p as string;
      try { return await fs.readFile(key, 'utf-8'); } catch { return null as unknown as string; }
    },
  } as unknown as typeof import('fs').promises;

  const cm = new ContextManager(root, DEFAULT_CONFIG, fsMock);
  const report: FailureReport = {
    cycle: 1, iteration: 1, run_dir: '.sle/runs/1-1', run_id: '1-1',
    quick_summary: 'Correctness failed.', failed_categories: ['correctness'], passed_categories: ['style'],
  };

  const ctx = await cm.assemble('planner', {
    cycle_number: 1, iteration: 2, planning_depth: 'standard',
    intent: 'Build widgets', current_node: 'PLAN',
    failure_report: report,
  });

  assert.ok(ctx.failure_context !== undefined, 'failure_context should be set on iteration 2');
  assert.ok(ctx.failure_context!.includes('correctness'), 'failed category not in failure_context');
  assert.ok(ctx.failure_context!.includes('Correctness failed.'), 'summary not in failure_context');
});

test('testNoFailureContextOnIteration1', async () => {
  const root = makeTempDir();
  const fsMock = { readFile: async () => { throw new Error('ENOENT'); } } as unknown as typeof import('fs').promises;
  const cm = new ContextManager(root, DEFAULT_CONFIG, fsMock);

  const ctx = await cm.assemble('planner', {
    cycle_number: 1, iteration: 1, planning_depth: 'standard',
    intent: 'Build widgets', current_node: 'PLAN',
    failure_report: {
      cycle: 1, iteration: 0, run_dir: '', run_id: '',
      quick_summary: 'X', failed_categories: ['a'], passed_categories: [],
    },
  });

  // iteration=1, so failure_context should NOT be injected even with report
  assert.strictEqual(ctx.failure_context, undefined);
});

// ─── Planner artifact isolation ───────────────────────────────────────────────

test('testPlannerContextExcludesImplementationFiles', async () => {
  const root = makeTempDir();
  await fs.mkdir(join(root, '.sle', 'project-docs'), { recursive: true });
  await fs.mkdir(join(root, 'src'), { recursive: true });

  // Write all candidate artifact files in the current layout (.sle/project-docs/)
  await fs.writeFile(join(root, '.sle', 'project-docs', 'requirements.md'), '# Req', 'utf-8');
  await fs.writeFile(join(root, '.sle', 'project-docs', 'architecture.md'), '# Arch', 'utf-8');
  await fs.writeFile(join(root, '.sle', 'project-docs', 'cycle-charter.md'), '# Charter', 'utf-8');
  await fs.writeFile(join(root, 'src', 'index.ts'), 'export default {};', 'utf-8');

  const cm = new ContextManager(root, DEFAULT_CONFIG);
  const ctx = await cm.assemble('planner', {
    cycle_number: 1, iteration: 1, planning_depth: 'standard',
    intent: 'Build widgets', current_node: 'PLAN',
  });

  // Planner reads: requirements, architecture, cycle-charter
  assert.ok('requirements' in ctx.artifact_slices, 'requirements should be in planner context');
  assert.ok('architecture' in ctx.artifact_slices, 'architecture should be in planner context');
  assert.ok('cycle-charter' in ctx.artifact_slices, 'cycle-charter should be in planner context');

  // Planner does NOT read src/ implementation files
  assert.ok(!Object.values(ctx.artifact_slices).some(v => v.includes('export default')),
    'src/ files should not appear in planner context');
});

test('testFailureContextInUserMessage', async () => {
  // buildUserMessage includes failure_context when present
  const { AssembledContext } = await import('../src/types.js' as unknown as string) as never;
  void AssembledContext; // unused — just testing buildUserMessage directly

  const ctx = {
    system_prompt: 'You are a planner.',
    artifact_slices: { requirements: '# Req' },
    state_summary: '## State\n- Cycle: 1',
    task: 'Create a plan.',
    failure_context: '## Previous Failure\nCorrectness failed.',
    token_count: 100,
    truncated: [],
  };

  const msg = buildUserMessage(ctx);
  assert.ok(msg.includes('Previous Failure'), 'failure_context missing from user message');
  assert.ok(msg.includes('Correctness failed.'), 'failure summary missing from user message');
});
