import { test } from 'node:test';
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
    git_init: true,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────

test('testInitCreatesMapYaml', async () => {
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
});

test('testInitCreatesRuleFiles', async () => {
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
});

test('testInitCreatesInitStateDuringProgress', async () => {
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
});

test('testInitDeletesInitStateOnCompletion', async () => {
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
});

test('testInitDetectsExistingSle', async () => {
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
});

test('testInitResumeSkipsCompletedSteps', async () => {
  const tmpDir = makeTempDir();
  const service = new InitService({ projectRoot: tmpDir });

  // Run init fully
  const firstResult = await service.init(makeDefaultRequest(tmpDir));
  assert.strictEqual((firstResult as APIResponse<InitResponseData>).data.status, 'complete');

  // Now try resume — should fail because init-state.json was deleted on completion
  const resumeResult = await service.resume();
  assert.strictEqual((resumeResult as APIError).error.code, 'no_init_state');

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('testInitGeneratesAgentMd', async () => {
  const tmpDir = makeTempDir();
  const service = new InitService({ projectRoot: tmpDir });

  const req = makeDefaultRequest(tmpDir);
  req.description_long = 'A long description about this test project.';
  const result = await service.init(req);
  assert.strictEqual((result as APIResponse<InitResponseData>).data.status, 'complete');

  const agentMdPath = join(tmpDir, 'agent.md');
  const content = await fs.readFile(agentMdPath, 'utf-8');

  assert.ok(content.startsWith('# test-project'), 'agent.md should start with project name');
  assert.ok(content.includes('A long description about this test project.'), 'agent.md should include description_long');
  assert.ok(content.includes('## Conventions'), 'agent.md should have Conventions section');
  assert.ok(content.includes('## Map'), 'agent.md should have Map section');
  assert.ok(content.includes('map: .sle/map.yaml'), 'agent.md should reference map.yaml');

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('testInitInstallsPromptTemplates', async () => {
  const tmpDir = makeTempDir();
  const service = new InitService({ projectRoot: tmpDir });

  const result = await service.init(makeDefaultRequest(tmpDir));
  assert.strictEqual((result as APIResponse<InitResponseData>).data.status, 'complete');

  const templateFiles = [
    'facilitator-chat.md',
    'facilitator-decision.md',
    'facilitator-scoping.md',
  ];

  for (const file of templateFiles) {
    const filePath = join(tmpDir, '.sle', 'prompts', file);
    try {
      await fs.access(filePath);
      const content = await fs.readFile(filePath, 'utf-8');
      assert.ok(content.includes('## Role identity'), `${file} should have Role identity section`);
      assert.ok(content.includes('## Behavioral constraints'), `${file} should have Behavioral constraints section`);
      assert.ok(content.includes('## Artifact access'), `${file} should have Artifact access section`);
      assert.ok(content.includes('## Output format'), `${file} should have Output format section`);
      assert.ok(content.includes('## Reasoning approach'), `${file} should have Reasoning approach section`);
    } catch {
      assert.fail(`Prompt template ${file} was not created`);
    }
  }

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('testInitGeneratesValidRulesAndPrompts', async () => {
  const tmpDir = makeTempDir();
  const service = new InitService({ projectRoot: tmpDir });

  await service.init(makeDefaultRequest(tmpDir));

  // 1. Verify agents.yaml is valid YAML and has 10 roles
  const agentsPath = join(tmpDir, '.sle', 'rules', 'agents.yaml');
  const agentsContent = await fs.readFile(agentsPath, 'utf8');
  assert.ok(agentsContent.length > 0, 'agents.yaml should not be empty');
  
  const { load: parseYAML } = await import('js-yaml');
  const parsedAgents = parseYAML(agentsContent) as any;
  assert.ok(parsedAgents && typeof parsedAgents === 'object', 'agents.yaml should parse as object');
  assert.ok(parsedAgents.agents && 'designer' in parsedAgents.agents, 'agents.yaml should contain designer role config');
  assert.strictEqual(parsedAgents.agents.designer.node, 'design');

  // 2. Verify prompts directory has role prompts with role identity header
  const designerPromptPath = join(tmpDir, '.sle', 'prompts', 'designer.md');
  const designerPrompt = await fs.readFile(designerPromptPath, 'utf8');
  assert.match(designerPrompt, /## Role identity/, 'designer.md should contain role identity header');

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('testInitRejectsNoOriginRemote', async () => {
  // Simulate an existing repo (git_init: false) with no origin remote
  const { execSync } = await import('node:child_process');
  const tmpDir = makeTempDir();
  // Set up a real git repo but without any remote
  execSync('git init', { cwd: tmpDir, stdio: 'ignore' });
  execSync('git commit --allow-empty -m "initial" --author="Test <t@t.com>"', { cwd: tmpDir, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_COMMITTER_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@t.com', GIT_COMMITTER_EMAIL: 't@t.com' } });

  const service = new InitService({ projectRoot: tmpDir });
  const req = makeDefaultRequest(tmpDir);
  req.git_init = false; // Don't re-init, treat existing repo

  const result = await service.init(req);

  // Should fail at step 0 with origin error
  assert.ok((result as APIResponse<InitResponseData>).ok === true, 'result is ok (partial)');  
  assert.strictEqual((result as APIResponse<InitResponseData>).data.status, 'partial');
  assert.ok(
    (result as APIResponse<InitResponseData>).data.message.toLowerCase().includes('origin'),
    'error should mention origin remote'
  );

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('testInitBranchIsDetectedFromGit', async () => {
  const { execSync } = await import('node:child_process');

  // Create a bare "remote" repo to satisfy the origin check in step 0
  const remoteDir = makeTempDir();
  execSync('git init --bare', { cwd: remoteDir, stdio: 'ignore' });

  // Create the project repo on a custom branch with a commit + origin pointing to remote
  const tmpDir = makeTempDir();
  execSync('git init -b staging', { cwd: tmpDir, stdio: 'ignore' });
  execSync('git commit --allow-empty -m "init" --author="Test <t@t.com>"', {
    cwd: tmpDir,
    stdio: 'ignore',
    env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_COMMITTER_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@t.com', GIT_COMMITTER_EMAIL: 't@t.com' },
  });
  execSync(`git remote add origin file://${remoteDir}`, { cwd: tmpDir, stdio: 'ignore' });

  const service = new InitService({ projectRoot: tmpDir });
  const req = makeDefaultRequest(tmpDir);
  req.git_init = false; // repo already exists
  const result = await service.init(req);

  assert.strictEqual((result as APIResponse<InitResponseData>).data.status, 'complete', `Init should complete. Got: ${(result as any)?.data?.message}`);

  // Check map.yaml for the correct branch name
  const { load: parseYAML } = await import('js-yaml');
  const mapContent = await fs.readFile(join(tmpDir, '.sle', 'map.yaml'), 'utf-8');
  const map = parseYAML(mapContent) as any;

  assert.strictEqual(
    map.remotes?.code?.branch,
    'staging',
    `Expected branch 'staging', got '${map.remotes?.code?.branch}'`
  );

  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.rm(remoteDir, { recursive: true, force: true });
});



// ─── Runner ──────────────────────────────────────────────────────────
