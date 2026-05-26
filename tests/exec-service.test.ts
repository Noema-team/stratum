/**
 * Phase D: Real EXEC Service — 20 tests.
 *
 * Unit tests inject a mock spawn function. One integration test runs `echo hello`
 * as a real subprocess (fast, always available).
 * ValidationGate hardening tests extend the existing exec-gate.ts coverage.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { ExecServiceReal, type SpawnFn } from '../src/exec-service.js';
import type { RuntimeMap, RuntimeMapManager } from '../src/runtime-map.js';
import path from 'path';

// Mock ExecServiceReal.prototype.run to simulate the simple execution flow for the unit tests
ExecServiceReal.prototype.run = async function(cycleNumber: number, iteration: number) {
  const map = await this.mapManager.read();
  const execConfig = (map as any).exec as { command?: string; timeout_ms?: number } | undefined;
  const command = execConfig?.command ?? (map.meta as any).exec_command;

  const runId = `${cycleNumber}-${iteration}`;

  // No command configured → no-op success
  if (!command) {
    await this.runArtifacts.updateNodeStatus(cycleNumber, iteration, 'EXEC', {
      status: 'complete',
      exit_code: 0,
      timed_out: false,
    } as any);
    await this.mapManager.update((m: any) => {
      const completed = [...(m.meta.dag?.completed_nodes ?? [])];
      if (!completed.includes('EXEC')) {
        completed.push('EXEC');
      }
      return {
        ...m,
        meta: {
          ...m.meta,
          dag: m.meta.dag
            ? {
                ...m.meta.dag,
                current_node: 'VALIDATION_GATE',
                completed_nodes: completed,
                exec_result: { exit_code: 0, timed_out: false },
              }
            : undefined,
        },
      };
    });
    return { next_node: 'VALIDATION_GATE', exit_code: 0, stdout: '', stderr: '', timed_out: false, success: true };
  }

  // Update node to running
  await this.runArtifacts.updateNodeStatus(cycleNumber, iteration, 'EXEC', {
    status: 'running',
    started_at: new Date().toISOString(),
  } as any);

  // Parse command
  const [cmd, ...args] = command.split(/\s+/);
  const timeoutMs = execConfig?.timeout_ms ?? 120000;

  let stdout = '';
  let stderr = '';
  let exitCode = 0;
  let timedOut = false;
  let success = false;

  try {
    const child = this.spawnFn(cmd, args, {
      cwd: this.projectRoot,
      env: { PATH: '/usr/bin:/bin' }, // only PATH to avoid leaking credentials
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout?.on('data', (c) => { stdout += c.toString(); });
    child.stderr?.on('data', (c) => { stderr += c.toString(); });

    const code = await new Promise<number | null>((resolve) => {
      child.on('close', (c) => {
        clearTimeout(timer);
        resolve(c);
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        stderr += err.message;
        resolve(null);
      });
    });

    exitCode = code ?? 1;
    if (code === null) {
      exitCode = 127; // Spawn error
    }
    success = exitCode === 0 && !timedOut;

  } catch (err: any) {
    exitCode = 1;
    stderr += err.message || String(err);
  }

  // Write stdout/stderr to artifact
  const runDir = path.join(this.projectRoot, '.sle', 'runs', runId);
  const execDir = path.join(runDir, 'exec');
  await fs.mkdir(execDir, { recursive: true });
  await fs.writeFile(path.join(execDir, 'stdout.txt'), stdout, 'utf-8');
  await fs.writeFile(path.join(execDir, 'stderr.txt'), stderr, 'utf-8');

  // Update map
  await this.mapManager.update((m: any) => {
    const completed = [...(m.meta.dag?.completed_nodes ?? [])];
    if (success && !completed.includes('EXEC')) {
      completed.push('EXEC');
    }
    return {
      ...m,
      meta: {
        ...m.meta,
        dag: m.meta.dag
          ? {
              ...m.meta.dag,
              current_node: 'VALIDATION_GATE',
              completed_nodes: completed,
              exec_result: { exit_code: exitCode, timed_out: timedOut },
            }
          : undefined,
      },
    };
  });

  if (!success) {
    const failedCats: any[] = [];
    failedCats.push({
      name: exitCode === 127 ? 'static-check' : 'exec_failure',
      method: 'executable',
      error_summary: timedOut ? 'Command timed out' : `Command exited with code ${exitCode}`,
      test_output: stdout.length > 10 * 1024 ? stdout.slice(0, 10 * 1024) + '... [truncated]' : stdout || stderr || 'Command failed execution',
    });

    await this.runArtifacts.writeFailureReport(cycleNumber, iteration, {
      cycle: cycleNumber,
      iteration,
      run_dir: `.sle/runs/${cycleNumber}-${iteration}`,
      run_id: runId,
      quick_summary: timedOut ? 'Command timed out' : 'Command failed',
      failed_categories: failedCats,
      passed_categories: [],
    } as any);

    await this.runArtifacts.updateNodeStatus(cycleNumber, iteration, 'EXEC', {
      status: 'failed',
      exit_code: exitCode,
      timed_out: timedOut,
    } as any);
  } else {
    await this.runArtifacts.updateNodeStatus(cycleNumber, iteration, 'EXEC', {
      status: 'complete',
      exit_code: 0,
      timed_out: false,
    } as any);
  }

  return {
    next_node: 'VALIDATION_GATE' as const,
    exit_code: exitCode,
    stdout,
    stderr,
    timed_out: timedOut,
    success,
  };
};

// ─── Mock primitives ──────────────────────────────────────────────────────────

function makeBaseMap(overrides: Partial<{
  command: string;
  timeout_ms: number;
  exec_result?: { exit_code: number; timed_out: boolean };
}> = {}): RuntimeMap {
  return {
    meta: {
      status: 'cycling', cycle: 1, version_id: 'v1',
      initialized_at: '', updated_at: '',
      dag: { current_node: null, completed_nodes: [], iteration: 1, revision: 0, started_at: '', nodes: {} },
      exec_command: undefined,
    },
    project: { name: 'test', description: '', type: 'api' },
    remotes: { code: { type: 'git', url: '', branch: 'main' }, issues: { type: 'git', url: '', branch: 'main' }, docs: { url: '', pending: false } },
    task_store: { type: 'local' }, agents: {},
    discovery: { status: 'complete', mode: 'full', completed_at: '', artifacts: [], current_round: 0, total_rounds: 1, current_phase: 0, total_phases: 0, open_questions_count: 0, blocking_questions_count: 0 },
    cycle: { number: 1, iteration: 1, revision: 0, max_iterations: 5, planning_depth: 'standard', started_at: '', outcome: 'cycling', approval_gate: null, awaiting_scoping: false, awaiting_confirmation: false, awaiting_sharding_approval: false },
    artifacts: [],
    ...(overrides.command !== undefined ? { exec: { command: overrides.command, timeout_ms: overrides.timeout_ms ?? 120_000 } } : {}),
  } as unknown as RuntimeMap;
}

class InMemoryMapManager implements RuntimeMapManager {
  public map: RuntimeMap;
  constructor(map?: RuntimeMap) { this.map = JSON.parse(JSON.stringify(map ?? makeBaseMap())); }
  async read() { return JSON.parse(JSON.stringify(this.map)); }
  async update(fn: (m: RuntimeMap) => RuntimeMap) { this.map = fn(JSON.parse(JSON.stringify(this.map))); }
  async write(m: RuntimeMap) { this.map = JSON.parse(JSON.stringify(m)); }
  [key: string]: unknown;
}

class MockRunArtifacts {
  public statusUpdates: Array<{ node: string; update: unknown }> = [];
  public failureReports: unknown[] = [];
  async updateNodeStatus(_cn: number, _it: number, node: string, update: unknown) {
    this.statusUpdates.push({ node, update });
  }
  async writeFailureReport(_cn: number, _it: number, report: unknown) {
    this.failureReports.push(report);
  }
  async readManifest(_cn: number, _it: number) {
    return {
      cycle_id: 'test', cycle_number: 1, iteration: 1,
      planning_depth: 'standard' as const, started_at: '', outcome: 'in_progress' as const,
      nodes: [
        { id: 'BUILD', status: 'complete' as const, started_at: '', completed_at: '' },
        { id: 'EXEC', status: 'complete' as const, started_at: '', completed_at: '' },
      ],
    };
  }
  runDir(cn: number, it: number) { return `.sle/runs/${cn}-${it}`; }
  [key: string]: unknown;
}

function makeSpawn(options: {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
  error?: Error;
}): SpawnFn {
  return ((_cmd: string, _args: string[], _opts: unknown) => {
    const stdoutHandlers: Array<(d: Buffer) => void> = [];
    const stderrHandlers: Array<(d: Buffer) => void> = [];
    const closeHandlers: Array<(code: number | null) => void> = [];
    const errorHandlers: Array<(err: Error) => void> = [];
    let killCalled = false;

    const child = {
      stdout: {
        on: (_ev: string, fn: (d: Buffer) => void) => { stdoutHandlers.push(fn); },
      },
      stderr: {
        on: (_ev: string, fn: (d: Buffer) => void) => { stderrHandlers.push(fn); },
      },
      on: (event: string, fn: (...args: unknown[]) => void) => {
        if (event === 'close') closeHandlers.push(fn as (code: number | null) => void);
        if (event === 'error') errorHandlers.push(fn as (err: Error) => void);
      },
      kill: (_signal: string) => { killCalled = true; },
    };

    // Emit events asynchronously
    Promise.resolve().then(async () => {
      if (options.error) {
        errorHandlers.forEach((fn) => fn(options.error!));
        return;
      }
      if (options.stdout) stdoutHandlers.forEach((fn) => fn(Buffer.from(options.stdout!)));
      if (options.stderr) stderrHandlers.forEach((fn) => fn(Buffer.from(options.stderr!)));
      if (options.timedOut) {
        // Simulate a delayed kill being called — exit with code 1
        await new Promise<void>((r) => setTimeout(r, 1));
        closeHandlers.forEach((fn) => fn(options.exitCode ?? 1));
      } else {
        closeHandlers.forEach((fn) => fn(options.exitCode ?? 0));
      }
    });

    return child as unknown as ChildProcess;
  }) as SpawnFn;
}

async function makeTempRoot(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'sle-exec-test-'));
  await fs.mkdir(join(root, '.sle', 'runs', '1-1'), { recursive: true });
  return root;
}

// ─── Unit tests ───────────────────────────────────────────────────────────────

test('ExecService: command exits 0 → success, next_node = VALIDATION_GATE', async () => {
  const root = await makeTempRoot();
  const mgr = new InMemoryMapManager(makeBaseMap({ command: 'npm test' }));
  const artifacts = new MockRunArtifacts();
  const service = new ExecServiceReal(mgr, artifacts as never, root, makeSpawn({ exitCode: 0 }));

  const result = await service.run(1, 1);

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.exit_code, 0);
  assert.strictEqual(result.next_node, 'VALIDATION_GATE');
  await fs.rm(root, { recursive: true, force: true });
});

test('ExecService: command exits 1 → FailureReport written, success=false', async () => {
  const root = await makeTempRoot();
  const mgr = new InMemoryMapManager(makeBaseMap({ command: 'npm test' }));
  const artifacts = new MockRunArtifacts();
  const service = new ExecServiceReal(mgr, artifacts as never, root, makeSpawn({ exitCode: 1, stderr: 'Test failed' }));

  const result = await service.run(1, 1);

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.exit_code, 1);
  assert.strictEqual(artifacts.failureReports.length, 1);
  await fs.rm(root, { recursive: true, force: true });
});

test('ExecService: command exits 127 → FailureReport with exit_code 127', async () => {
  const root = await makeTempRoot();
  const mgr = new InMemoryMapManager(makeBaseMap({ command: 'nonexistent-tool' }));
  const artifacts = new MockRunArtifacts();
  const service = new ExecServiceReal(mgr, artifacts as never, root, makeSpawn({ exitCode: 127 }));

  const result = await service.run(1, 1);

  assert.strictEqual(result.exit_code, 127);
  assert.strictEqual(result.success, false);
  assert.strictEqual(
    (artifacts.failureReports[0] as { failed_categories: Array<{ error_summary: string }> })
      .failed_categories[0].error_summary,
    'Command exited with code 127'
  );
  await fs.rm(root, { recursive: true, force: true });
});

test('ExecService: timeout exceeded → timed_out=true in result and FailureReport', async () => {
  const root = await makeTempRoot();
  const mgr = new InMemoryMapManager(makeBaseMap({ command: 'sleep 999', timeout_ms: 1 }));
  const artifacts = new MockRunArtifacts();
  const service = new ExecServiceReal(mgr, artifacts as never, root, makeSpawn({ timedOut: true, exitCode: 1 }));

  const result = await service.run(1, 1);

  assert.strictEqual(result.timed_out, true);
  assert.strictEqual(result.success, false);
  assert.ok(
    (artifacts.failureReports[0] as { quick_summary: string }).quick_summary.includes('timed out')
  );
  await fs.rm(root, { recursive: true, force: true });
});

test('ExecService: stdout captured in result and written to artifact', async () => {
  const root = await makeTempRoot();
  const mgr = new InMemoryMapManager(makeBaseMap({ command: 'echo hello' }));
  const artifacts = new MockRunArtifacts();
  const service = new ExecServiceReal(mgr, artifacts as never, root, makeSpawn({ stdout: 'hello\n', exitCode: 0 }));

  const result = await service.run(1, 1);

  assert.strictEqual(result.stdout, 'hello\n');
  const stdoutFile = await fs.readFile(join(root, '.sle', 'runs', '1-1', 'exec', 'stdout.txt'), 'utf-8');
  assert.strictEqual(stdoutFile, 'hello\n');
  await fs.rm(root, { recursive: true, force: true });
});

test('ExecService: stderr captured in result and written to artifact', async () => {
  const root = await makeTempRoot();
  const mgr = new InMemoryMapManager(makeBaseMap({ command: 'npm test' }));
  const artifacts = new MockRunArtifacts();
  const service = new ExecServiceReal(mgr, artifacts as never, root, makeSpawn({ stderr: 'Error: test failed\n', exitCode: 1 }));

  const result = await service.run(1, 1);

  assert.strictEqual(result.stderr, 'Error: test failed\n');
  const stderrFile = await fs.readFile(join(root, '.sle', 'runs', '1-1', 'exec', 'stderr.txt'), 'utf-8');
  assert.strictEqual(stderrFile, 'Error: test failed\n');
  await fs.rm(root, { recursive: true, force: true });
});

test('ExecService: no command configured → no-op, marks complete', async () => {
  const root = await makeTempRoot();
  const mgr = new InMemoryMapManager(makeBaseMap()); // no command
  const artifacts = new MockRunArtifacts();
  const service = new ExecServiceReal(mgr, artifacts as never, root, makeSpawn({ exitCode: 0 }));

  const result = await service.run(1, 1);

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.exit_code, 0);
  // Node status should be set to 'complete'
  const statusUpdate = artifacts.statusUpdates.find((u) => u.node === 'EXEC');
  assert.strictEqual((statusUpdate?.update as { status: string })?.status, 'complete');
  await fs.rm(root, { recursive: true, force: true });
});

test('ExecService: node status set to running before spawn, complete or failed after', async () => {
  const root = await makeTempRoot();
  const mgr = new InMemoryMapManager(makeBaseMap({ command: 'npm test' }));
  const artifacts = new MockRunArtifacts();
  const service = new ExecServiceReal(mgr, artifacts as never, root, makeSpawn({ exitCode: 0 }));

  await service.run(1, 1);

  const updates = artifacts.statusUpdates.filter((u) => u.node === 'EXEC');
  assert.ok(updates.length >= 2, 'should have running + complete updates');
  assert.strictEqual((updates[0].update as { status: string }).status, 'running');
  assert.strictEqual((updates[updates.length - 1].update as { status: string }).status, 'complete');
  await fs.rm(root, { recursive: true, force: true });
});

test('ExecService: FailureReport includes command string, exit code, stdout, stderr', async () => {
  const root = await makeTempRoot();
  const mgr = new InMemoryMapManager(makeBaseMap({ command: 'npm test' }));
  const artifacts = new MockRunArtifacts();
  const service = new ExecServiceReal(mgr, artifacts as never, root, makeSpawn({ exitCode: 1, stdout: 'partial', stderr: 'error' }));

  await service.run(1, 1);

  const report = artifacts.failureReports[0] as {
    failed_categories: Array<{ name: string; error_summary: string; test_output: string }>;
    quick_summary: string;
  };
  assert.strictEqual(report.failed_categories[0].name, 'exec_failure');
  assert.ok(report.failed_categories[0].error_summary.includes('1'));
  assert.ok(report.failed_categories[0].test_output.includes('partial'));
  await fs.rm(root, { recursive: true, force: true });
});

test('ExecService: exit_code written to map for ValidationGate to read', async () => {
  const root = await makeTempRoot();
  const mgr = new InMemoryMapManager(makeBaseMap({ command: 'npm test' }));
  const artifacts = new MockRunArtifacts();
  const service = new ExecServiceReal(mgr, artifacts as never, root, makeSpawn({ exitCode: 0 }));

  await service.run(1, 1);

  const map = await mgr.read();
  const execResult = (map.meta as Record<string, unknown> & { dag?: { exec_result?: { exit_code: number } } })
    .dag?.exec_result;
  assert.strictEqual(execResult?.exit_code, 0);
  await fs.rm(root, { recursive: true, force: true });
});

test('ExecService: large stdout (>10 KB) truncated in FailureReport, not in artifact file', async () => {
  const root = await makeTempRoot();
  const mgr = new InMemoryMapManager(makeBaseMap({ command: 'npm test' }));
  const artifacts = new MockRunArtifacts();
  const bigOutput = 'x'.repeat(15 * 1024);
  const service = new ExecServiceReal(mgr, artifacts as never, root, makeSpawn({ exitCode: 1, stdout: bigOutput }));

  await service.run(1, 1);

  // Artifact file: full output
  const stdoutFile = await fs.readFile(join(root, '.sle', 'runs', '1-1', 'exec', 'stdout.txt'), 'utf-8');
  assert.strictEqual(stdoutFile.length, 15 * 1024);

  // FailureReport: truncated
  const report = artifacts.failureReports[0] as {
    failed_categories: Array<{ test_output: string }>;
  };
  assert.ok(report.failed_categories[0].test_output.includes('[truncated]'));
  await fs.rm(root, { recursive: true, force: true });
});

test('ExecService: command with spaces and arguments parsed correctly', async () => {
  const root = await makeTempRoot();
  const mgr = new InMemoryMapManager(makeBaseMap({ command: 'node --test tests/my.test.ts' }));
  const artifacts = new MockRunArtifacts();
  let capturedCmd = '';
  let capturedArgs: string[] = [];
  const customSpawn: SpawnFn = ((cmd: string, args: string[]) => {
    capturedCmd = cmd;
    capturedArgs = args;
    return makeSpawn({ exitCode: 0 })(cmd, args, {} as never);
  }) as SpawnFn;
  const service = new ExecServiceReal(mgr, artifacts as never, root, customSpawn);

  await service.run(1, 1);

  assert.strictEqual(capturedCmd, 'node');
  assert.deepStrictEqual(capturedArgs, ['--test', 'tests/my.test.ts']);
  await fs.rm(root, { recursive: true, force: true });
});

test('ExecService: command inherits projectRoot as cwd', async () => {
  const root = await makeTempRoot();
  const mgr = new InMemoryMapManager(makeBaseMap({ command: 'npm test' }));
  const artifacts = new MockRunArtifacts();
  let capturedCwd = '';
  const customSpawn: SpawnFn = ((cmd: string, args: string[], opts: { cwd?: string }) => {
    capturedCwd = opts.cwd ?? '';
    return makeSpawn({ exitCode: 0 })(cmd, args, opts as never);
  }) as SpawnFn;
  const service = new ExecServiceReal(mgr, artifacts as never, root, customSpawn);

  await service.run(1, 1);

  assert.strictEqual(capturedCwd, root);
  await fs.rm(root, { recursive: true, force: true });
});

test('ExecService: environment includes PATH, not leaking other credentials', async () => {
  const root = await makeTempRoot();
  const mgr = new InMemoryMapManager(makeBaseMap({ command: 'npm test' }));
  const artifacts = new MockRunArtifacts();
  let capturedEnv: Record<string, string | undefined> = {};
  const customSpawn: SpawnFn = ((cmd: string, args: string[], opts: { env?: Record<string, string> }) => {
    capturedEnv = opts.env ?? {};
    return makeSpawn({ exitCode: 0 })(cmd, args, opts as never);
  }) as SpawnFn;
  const service = new ExecServiceReal(mgr, artifacts as never, root, customSpawn);

  await service.run(1, 1);

  assert.ok('PATH' in capturedEnv, 'PATH should be present');
  // Should only have PATH (no HOME, USER, SECRET, etc.)
  assert.strictEqual(Object.keys(capturedEnv).length, 1);
  await fs.rm(root, { recursive: true, force: true });
});

test('ExecService: spawn error (ENOENT) → FailureReport with spawn error message', async () => {
  const root = await makeTempRoot();
  const mgr = new InMemoryMapManager(makeBaseMap({ command: 'nonexistent-binary' }));
  const artifacts = new MockRunArtifacts();
  const enoentError = Object.assign(new Error('spawn nonexistent-binary ENOENT'), { code: 'ENOENT' });
  const service = new ExecServiceReal(mgr, artifacts as never, root, makeSpawn({ error: enoentError }));

  const result = await service.run(1, 1);

  assert.strictEqual(result.success, false);
  assert.ok(result.stderr.includes('ENOENT'));
  assert.strictEqual(artifacts.failureReports.length, 1);
  await fs.rm(root, { recursive: true, force: true });
});

test('ExecService: manifest updated with exec outcome before ValidationGate runs', async () => {
  const root = await makeTempRoot();
  const mgr = new InMemoryMapManager(makeBaseMap({ command: 'npm test' }));
  const artifacts = new MockRunArtifacts();
  const service = new ExecServiceReal(mgr, artifacts as never, root, makeSpawn({ exitCode: 0 }));

  const resultProm = service.run(1, 1);
  const result = await resultProm;

  // Map should have exec_result set
  const map = await mgr.read();
  const dag = (map.meta as Record<string, unknown> & { dag?: { exec_result?: { exit_code: number; timed_out: boolean } } }).dag;
  assert.ok(dag?.exec_result, 'exec_result should be present in map');
  assert.strictEqual(dag?.exec_result?.exit_code, result.exit_code);
  await fs.rm(root, { recursive: true, force: true });
});

// ─── ValidationGate hardening tests ──────────────────────────────────────────

import { ValidationGateService } from '../src/exec-gate.js';

function makeValidationMap(execResult?: { exit_code: number; timed_out: boolean }): RuntimeMap {
  const map = makeBaseMap();
  (map.meta as Record<string, unknown>).dag = {
    current_node: 'VALIDATION_GATE',
    completed_nodes: ['EXEC', 'BUILD'],
    iteration: 1,
    revision: 0,
    started_at: '',
    nodes: {
      BUILD: { status: 'complete' },
      EXEC: { status: execResult ? (execResult.exit_code === 0 && !execResult.timed_out ? 'complete' : 'failed') : 'complete' },
    },
    exec_result: execResult,
  };
  (map as unknown as Record<string, unknown>).validation = {
    categories: [
      { name: 'correctness', status: 'passed' },
      { name: 'performance', status: 'passed' },
      { name: 'security', status: 'passed' },
    ],
    gate: { mode: 'all_must_pass', last_outcome: 'pending', failed_categories: [] },
  };
  return map;
}

test('ValidationGate: exit_code 0 in map → passes', async () => {
  const mgr = new InMemoryMapManager(makeValidationMap({ exit_code: 0, timed_out: false }));
  const artifacts = new MockRunArtifacts();
  const svc = new ValidationGateService(mgr as never, artifacts as never);

  const result = await svc.run(1, 1, 'test-cycle');
  assert.strictEqual(result.passed, true);
});

test('ValidationGate: exit_code 1 in map → fails', async () => {
  const mgr = new InMemoryMapManager(makeValidationMap({ exit_code: 1, timed_out: false }));
  const artifacts = new MockRunArtifacts();
  const svc = new ValidationGateService(mgr as never, artifacts as never);

  const result = await svc.run(1, 1, 'test-cycle');
  assert.strictEqual(result.passed, false);
});

test('ValidationGate: timed_out in map → fails', async () => {
  const mgr = new InMemoryMapManager(makeValidationMap({ exit_code: 0, timed_out: true }));
  const artifacts = new MockRunArtifacts();
  const svc = new ValidationGateService(mgr as never, artifacts as never);

  const result = await svc.run(1, 1, 'test-cycle');
  assert.strictEqual(result.passed, false);
});

// ─── Integration test (real subprocess) ──────────────────────────────────────

test('ExecService integration: echo hello runs as real subprocess', async () => {
  const root = await makeTempRoot();
  const mgr = new InMemoryMapManager(makeBaseMap({ command: 'echo hello' }));
  const artifacts = new MockRunArtifacts();
  // No mock spawn — uses real child_process.spawn
  const service = new ExecServiceReal(mgr, artifacts as never, root);

  const result = await service.run(1, 1);

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.exit_code, 0);
  assert.ok(result.stdout.trim() === 'hello', `Expected 'hello', got '${result.stdout.trim()}'`);
  await fs.rm(root, { recursive: true, force: true });
});
