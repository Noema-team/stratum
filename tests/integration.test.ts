/**
 * Phase L: Integration Test
 *
 * End-to-end acceptance test for Vertical Slice 1.
 * Covers: init → daemon start → health check → discovery lifecycle → completion.
 *
 * Spec reference: v1-init-state-discovery.md §Phase L
 *
 * Scope note: synthesis/planning approval and docs/ artifact verification are deferred
 * to a future phase. This test validates the implemented scope (solo-mode discovery).
 */

import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { execSync } from 'node:child_process';
import { load as yamlLoad } from 'js-yaml';

import { DaemonServer } from '../src/daemon.js';
import { InitService } from '../src/init-service.js';
import { DiscoveryService } from '../src/discovery-service.js';
import { StateAPI } from '../src/state-api.js';
import { RuntimeMapManagerImpl } from '../src/runtime-map.js';

// ─── Shared test fixtures ──────────────────────────────────────────────────

interface TestContext {
  tmpDir: string;
  daemon: DaemonServer;
  sessionId: string;
}

async function setupProjectDir(): Promise<string> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'sle-integration-'));
  execSync('git init', { cwd: tmpDir, stdio: 'ignore' });
  execSync('git remote add origin https://github.com/test/sle-integration-test.git', {
    cwd: tmpDir,
    stdio: 'ignore',
  });
  return tmpDir;
}

async function runInit(tmpDir: string): Promise<void> {
  const service = new InitService({ projectRoot: tmpDir });
  const result = await service.init({
    project_name: 'integration-test',
    project_type: 'api',
    task_store: 'local',
    daemon_port: 7700,
    docs_remote: null,
    non_interactive: true,
    no_editor: true,
  });
  assert.strictEqual((result as { ok: boolean }).ok, true, 'init must succeed');
  assert.strictEqual((result as { data: { status: string } }).data.status, 'complete');
}

async function startDaemon(tmpDir: string): Promise<DaemonServer> {
  const mapPath = join(tmpDir, '.sle', 'map.yaml');
  const mapManager = new RuntimeMapManagerImpl({ mapPath });

  const stateAPI = new StateAPI(mapManager, {
    version: '0.1.0',
    sleVersion: '2.0.0',
    port: 0,
    projectRoot: tmpDir,
    startedAt: new Date(),
  });

  const initService = new InitService({ projectRoot: tmpDir });
  const discoveryService = new DiscoveryService(stateAPI, mapManager, tmpDir);

  const daemon = new DaemonServer();
  await daemon.start(
    { port: 0, projectRoot: tmpDir },
    {
      stateAPI,
      initService,
      discoveryService,
      pidFile: { writePidFile: async () => {}, removePidFile: async () => {} },
    }
  );
  return daemon;
}

function makeRequest(
  daemon: DaemonServer,
  method: string,
  path: string,
  body?: unknown
): Promise<{ statusCode: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const port = daemon.getPort();
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        method,
        path,
        headers: body ? { 'Content-Type': 'application/json' } : {},
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: string) => { data += chunk; });
        res.on('end', () => {
          try {
            resolve({ statusCode: res.statusCode as number, body: JSON.parse(data) });
          } catch {
            resolve({ statusCode: res.statusCode as number, body: data });
          }
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ─── Test 1: Init creates valid project structure ─────────────────────────

async function testInitCreatesValidProjectStructure() {
  const tmpDir = await setupProjectDir();
  try {
    await runInit(tmpDir);

    // agent.md exists with required content
    const agentMd = await fs.readFile(join(tmpDir, 'agent.md'), 'utf-8');
    assert.ok(agentMd.includes('# integration-test'), 'agent.md has project name header');
    assert.ok(agentMd.includes('map: .sle/map.yaml'), 'agent.md has map reference');

    // .sle/map.yaml is valid YAML representing a RuntimeMap with correct initial state
    const mapContent = await fs.readFile(join(tmpDir, '.sle', 'map.yaml'), 'utf-8');
    assert.ok(mapContent.trim().length > 0, 'map.yaml is not empty');
    const map = yamlLoad(mapContent) as Record<string, unknown>;
    assert.strictEqual((map.meta as Record<string, unknown>).status, 'idle', 'map.yaml status is idle');
    assert.strictEqual(
      (map.discovery as Record<string, unknown>).status,
      'not_started',
      'map.yaml discovery is not_started'
    );

    // .sle/rules/ has all 7 rule files
    const ruleFiles = [
      'planning.yaml', 'validation.yaml', 'artifacts.yaml',
      'exit.yaml', 'user_validation.yaml', 'summary.yaml', 'agents.yaml',
    ];
    for (const file of ruleFiles) {
      await fs.access(join(tmpDir, '.sle', 'rules', file));
    }

    // .sle/prompts/ has facilitator templates
    const promptFiles = [
      'facilitator-chat.md', 'facilitator-decision.md', 'facilitator-scoping.md',
    ];
    for (const file of promptFiles) {
      await fs.access(join(tmpDir, '.sle', 'prompts', file));
    }

    // .sle/tasks.yaml exists (empty task store)
    await fs.access(join(tmpDir, '.sle', 'tasks.yaml'));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

// ─── Test 2: Daemon starts and health check passes ─────────────────────────

async function testDaemonStartsAfterInit() {
  const tmpDir = await setupProjectDir();
  let daemon: DaemonServer | null = null;
  try {
    await runInit(tmpDir);
    daemon = await startDaemon(tmpDir);

    const res = await makeRequest(daemon, 'GET', '/api/v2/health');
    assert.strictEqual(res.statusCode, 200);
    const body = res.body as { ok: boolean; data: { status: string } };
    assert.ok(body.ok, 'health response ok');
    assert.strictEqual(body.data.status, 'healthy');
  } finally {
    if (daemon) await daemon.stop();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

// ─── Test 3: System starts in correct initial state ────────────────────────

async function testInitialSystemState() {
  const tmpDir = await setupProjectDir();
  let daemon: DaemonServer | null = null;
  try {
    await runInit(tmpDir);
    daemon = await startDaemon(tmpDir);

    const res = await makeRequest(daemon, 'GET', '/api/v2/system/state');
    assert.strictEqual(res.statusCode, 200);
    const data = (res.body as { data: Record<string, unknown> }).data;
    assert.strictEqual(data.state, 'idle', 'initial state is idle');
    assert.strictEqual(data.discovery_status, 'not_started', 'discovery not started');
  } finally {
    if (daemon) await daemon.stop();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

// ─── Test 4: Discovery lifecycle — start, respond, approve, complete ────────

async function testDiscoveryLifecycle() {
  const tmpDir = await setupProjectDir();
  let daemon: DaemonServer | null = null;
  try {
    await runInit(tmpDir);
    daemon = await startDaemon(tmpDir);

    // Start discovery (solo mode: 1 round)
    const startRes = await makeRequest(daemon, 'POST', '/api/v2/discovery/start', { mode: 'solo' });
    assert.strictEqual(startRes.statusCode, 200);
    const startData = (startRes.body as { ok: boolean; data: Record<string, unknown> });
    assert.ok(startData.ok, 'discovery start ok');
    const sessionId = startData.data.session_id as string;
    assert.ok(typeof sessionId === 'string' && sessionId.length > 0, 'session_id returned');
    assert.strictEqual(startData.data.mode, 'solo');
    assert.strictEqual(startData.data.current_round, 1);
    assert.strictEqual(startData.data.total_rounds, 1);

    // System transitions to discovering
    const discoveringState = await makeRequest(daemon, 'GET', '/api/v2/system/state');
    assert.strictEqual(
      (discoveringState.body as { data: { state: string } }).data.state,
      'discovering',
      'state is discovering after start'
    );

    // Submit round 1 response
    const responseRes = await makeRequest(
      daemon,
      'POST',
      `/api/v2/discovery/round/1/response?session_id=${sessionId}`,
      { content: 'Building an API for managing items' }
    );
    assert.strictEqual(responseRes.statusCode, 200);
    assert.ok((responseRes.body as { ok: boolean }).ok);

    // Approve round 1 (solo mode: last round → discovery completes)
    const approveRes = await makeRequest(
      daemon,
      'POST',
      `/api/v2/discovery/round/1/approve?session_id=${sessionId}`
    );
    assert.strictEqual(approveRes.statusCode, 200);
    assert.ok((approveRes.body as { ok: boolean }).ok);

    // System transitions back to idle with discovery complete
    const finalState = await makeRequest(daemon, 'GET', '/api/v2/system/state');
    const finalData = (finalState.body as { data: Record<string, unknown> }).data;
    assert.strictEqual(finalData.state, 'idle', 'state returns to idle after discovery');
    assert.strictEqual(finalData.discovery_status, 'complete', 'discovery_status is complete');

    // Discovery status endpoint confirms completion
    const statusRes = await makeRequest(
      daemon,
      'GET',
      `/api/v2/discovery/status?session_id=${sessionId}`
    );
    assert.strictEqual(statusRes.statusCode, 200);
    const statusData = (statusRes.body as { data: { status: string } }).data;
    assert.strictEqual(statusData.status, 'complete', 'discovery status is complete');
  } finally {
    if (daemon) await daemon.stop();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

// ─── Test 5: Discovery cannot be started twice ─────────────────────────────

async function testDiscoveryIdempotency() {
  const tmpDir = await setupProjectDir();
  let daemon: DaemonServer | null = null;
  try {
    await runInit(tmpDir);
    daemon = await startDaemon(tmpDir);

    // Complete a discovery session
    const startRes = await makeRequest(daemon, 'POST', '/api/v2/discovery/start', { mode: 'solo' });
    const sessionId = (startRes.body as { data: { session_id: string } }).data.session_id;
    await makeRequest(daemon, 'POST', `/api/v2/discovery/round/1/response?session_id=${sessionId}`, {
      content: 'test',
    });
    await makeRequest(daemon, 'POST', `/api/v2/discovery/round/1/approve?session_id=${sessionId}`);

    // Attempting to start discovery again must fail
    const secondStart = await makeRequest(daemon, 'POST', '/api/v2/discovery/start', { mode: 'solo' });
    assert.ok(
      !(secondStart.body as { ok: boolean }).ok,
      'second discovery start must fail'
    );
    const errorCode = (secondStart.body as { error: { code: string } }).error.code;
    assert.ok(
      errorCode === 'discovery_already_complete' || errorCode === 'invalid_transition',
      `error code should indicate discovery is done, got: ${errorCode}`
    );
  } finally {
    if (daemon) await daemon.stop();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

// ─── Runner ───────────────────────────────────────────────────────────────

async function runAllTests() {
  const tests = [
    { name: 'Init creates valid project structure (agent.md, map.yaml, rules, prompts, tasks)', fn: testInitCreatesValidProjectStructure },
    { name: 'Daemon starts with real services after init and health check passes', fn: testDaemonStartsAfterInit },
    { name: 'System starts in idle state with discovery not_started', fn: testInitialSystemState },
    { name: 'Discovery lifecycle: start → respond → approve → idle + complete (solo mode)', fn: testDiscoveryLifecycle },
    { name: 'Discovery cannot be started after it is already complete (409)', fn: testDiscoveryIdempotency },
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
    console.error(`\n❌ ${failures.length}/${tests.length} Phase L integration tests FAILED:`);
    for (const f of failures) {
      console.error(`  - ${f.name}:`);
      console.error(`    ${f.error}`);
    }
    throw failures[0].error;
  }

  console.log(`\n✅ All ${tests.length} Phase L integration tests passed!`);
}

runAllTests();
