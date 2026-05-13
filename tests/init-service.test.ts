import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InitService, type InitRequest, type InitResponseData, type InitStatusResponseData, type InitResetRequest, type InitResetResponseData } from '../src/init-service.js';
import type { APIResponse, APIError } from '../src/types.js';

// ─── Helpers ─────────────────────────────────────────────────────────

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'sle-init-test-'));
}

function makeDefaultRequest(projectRoot: string): InitRequest {
  return {
    project_name: 'test-project',
    project_type: 'api',
    task_store: 'local',
    daemon_port: 7700,
    docs_remote: null,
    non_interactive: true,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────

async function testInitCreatesMapYaml() {
  const tmpDir = makeTempDir();
  const service = new InitService({ projectRoot: tmpDir });

  const result = await service.init(makeDefaultRequest(tmpDir));

  assert.strictEqual((result as APIResponse<InitResponseData>).data.status, 'complete');

  // Verify .sle/map.yaml was created
  try {
    await fs.access(join(tmpDir, '.sle', 'map.yaml'));
    assert.ok(true, 'map.yaml exists');
  } catch {
    assert.fail('map.yaml was not created');
  }

  // Cleanup
  await fs.rm(tmpDir, { recursive: true, force: true });
}

async function testInitCreatesRuleFiles() {
  const tmpDir = makeTempDir();
  const service = new InitService({ projectRoot: tmpDir });

  await service.init(makeDefaultRequest(tmpDir));

  // Verify rule files directory and files
  const ruleFiles = [
    'planning.yaml',
    'validation.yaml',
    'artifacts.yaml',
    'exit.yaml',
    'user_validation.yaml',
    'summary.yaml',
    'agents.yaml',
  ];

  for (const file of ruleFiles) {
    const filePath = join(tmpDir, '.sle', 'rules', file);
    try {
      await fs.access(filePath);
      assert.ok(true, `${file} exists`);
    } catch {
      assert.fail(`Rule file ${file} was not created`);
    }
  }

  await fs.rm(tmpDir, { recursive: true, force: true });
}

async function testInitCreatesInitStateDuringProgress() {
  const tmpDir = makeTempDir();
  const service = new InitService({ projectRoot: tmpDir });

  // Init will create and save init-state.json during progress
  await service.init(makeDefaultRequest(tmpDir));

  // After completion, init-state.json should be deleted
  try {
    await fs.access(join(tmpDir, '.sle', 'init-state.json'));
    assert.fail('init-state.json should have been deleted on completion');
  } catch {
    assert.ok(true, 'init-state.json deleted after completion');
  }

  await fs.rm(tmpDir, { recursive: true, force: true });
}

async function testInitDeletesInitStateOnCompletion() {
  const tmpDir = makeTempDir();
  const service = new InitService({ projectRoot: tmpDir });

  await service.init(makeDefaultRequest(tmpDir));

  // init-state.json should not exist after completion
  const initStatePath = join(tmpDir, '.sle', 'init-state.json');
  try {
    await fs.access(initStatePath);
    assert.fail('init-state.json should be deleted after successful init');
  } catch {
    // Expected
  }

  await fs.rm(tmpDir, { recursive: true, force: true });
}

async function testInitDetectsExistingSle() {
  const tmpDir = makeTempDir();
  const service = new InitService({ projectRoot: tmpDir });

  // Create .sle/init-state.json to simulate in-progress init
  await fs.mkdir(join(tmpDir, '.sle'), { recursive: true });
  await fs.writeFile(
    join(tmpDir, '.sle', 'init-state.json'),
    JSON.stringify({
      last_completed_step: 0,
      project: { name: 'test-project', description: 'test', type: 'api' },
      remotes: { code: { url: 'https://github.com/org/repo.git', branch: 'main' }, issues: { url: 'https://github.com/org/issues.git', prefix: '', local_only: false }, docs: { url: 'https://github.com/org/docs.git', pending: false } },
      task_store: { provider: 'local' },
      beads_initialised: false,
      docs_cloned: false,
      committed: false,
    })
  );

  const result = await service.init(makeDefaultRequest(tmpDir));

  assert.strictEqual((result as { ok: boolean }).ok, false);

  await fs.rm(tmpDir, { recursive: true, force: true });
}

async function testInitResumeSkipsCompletedSteps() {
  const tmpDir = makeTempDir();
  const service = new InitService({ projectRoot: tmpDir });

  // Run init fully
  const firstResult = await service.init(makeDefaultRequest(tmpDir));
  assert.strictEqual((firstResult as APIResponse<InitResponseData>).data.status, 'complete');

  // Now try resume — should fail because init-state.json was deleted on completion
  const resumeResult = await service.resume();
  assert.strictEqual((resumeResult as APIError).error.code, 'no_init_state');

  await fs.rm(tmpDir, { recursive: true, force: true });
}

// ─── Runner ──────────────────────────────────────────────────────────

async function runAllTests() {
  const tests = [
    { name: 'Init creates .sle/map.yaml', fn: testInitCreatesMapYaml },
    { name: 'Init creates .sle/rules/ with 7 files', fn: testInitCreatesRuleFiles },
    { name: 'Init creates and cleans init-state.json during progress', fn: testInitCreatesInitStateDuringProgress },
    { name: 'Init deletes init-state.json on completion', fn: testInitDeletesInitStateOnCompletion },
    { name: 'Init detects existing .sle/ and fails (no overwrite)', fn: testInitDetectsExistingSle },
    { name: 'Resume skips completed steps', fn: testInitResumeSkipsCompletedSteps },
  ];

  const failures: Array<{ name: string; error: unknown }> = [];

  for (const test of tests) {
    try {
      await test.fn();
      console.log(`  ✓ ${test.name}`);
    } catch (error) {
      console.error(`  ✗ ${test.name}`);
      failures.push({ name: test.name, error });
    }
  }

  if (failures.length > 0) {
    console.error(`\n❌ ${failures.length}/${tests.length} Phase E init-service tests FAILED:`);
    for (const f of failures) {
      console.error(`  - ${f.name}`);
    }
    throw failures[0].error;
  }

  console.log(`\n✅ All ${tests.length} Phase E init-service tests passed!`);
}

runAllTests();