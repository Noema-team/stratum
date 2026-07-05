/**
 * Sandbox abstraction tests.
 *
 * Unit tests inject a fake spawn to verify argv construction, availability
 * probing, and sandbox selection without touching Docker. A guarded
 * integration test runs a real container when the offline base image
 * `sle-sandbox-base:local` is present (built in the dev environment); it
 * self-skips otherwise so the suite stays portable.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HostSandbox,
  DockerSandbox,
  resolveSandbox,
  defaultSandboxConfig,
  type SpawnFn,
  type SandboxConfig,
} from '../src/sandbox.js';
import { ExecServiceReal } from '../src/exec-service.js';
import type { RuntimeMap, RuntimeMapManager } from '../src/runtime-map.js';

// ─── Fake spawn ─────────────────────────────────────────────────────────────

interface FakeResult {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  error?: Error;
  hang?: boolean; // never closes → exercises timeout path
}

interface SpawnCall {
  cmd: string;
  args: string[];
  opts: { cwd?: string; env?: Record<string, string> };
}

function fakeSpawn(handler: (cmd: string, args: string[]) => FakeResult) {
  const calls: SpawnCall[] = [];
  const killed: string[] = [];
  const fn = ((cmd: string, args: string[], opts: unknown) => {
    calls.push({ cmd, args, opts: (opts ?? {}) as SpawnCall['opts'] });
    const res = handler(cmd, args);
    const stdoutH: Array<(d: Buffer) => void> = [];
    const stderrH: Array<(d: Buffer) => void> = [];
    const closeH: Array<(code: number | null) => void> = [];
    const errorH: Array<(e: Error) => void> = [];
    const child = {
      stdout: { on: (_e: string, f: (d: Buffer) => void) => stdoutH.push(f) },
      stderr: { on: (_e: string, f: (d: Buffer) => void) => stderrH.push(f) },
      on: (e: string, f: (...a: unknown[]) => void) => {
        if (e === 'close') closeH.push(f as (c: number | null) => void);
        if (e === 'error') errorH.push(f as (er: Error) => void);
      },
      kill: (_sig: string) => {
        killed.push(cmd);
        // A real process emits 'close' after being signalled; mirror that so
        // spawnCapture's timeout path resolves.
        Promise.resolve().then(() => closeH.forEach((f) => f(null)));
      },
    };
    Promise.resolve().then(() => {
      if (res.error) { errorH.forEach((f) => f(res.error!)); return; }
      if (res.stdout) stdoutH.forEach((f) => f(Buffer.from(res.stdout!)));
      if (res.stderr) stderrH.forEach((f) => f(Buffer.from(res.stderr!)));
      if (!res.hang) closeH.forEach((f) => f(res.exitCode ?? 0));
    });
    return child as unknown as ChildProcess;
  }) as SpawnFn;
  return { fn, calls, killed };
}

const dockerConfig = (over: Partial<SandboxConfig> = {}): SandboxConfig =>
  defaultSandboxConfig({ kind: 'docker', image: 'test-image:1', ...over });

// ─── HostSandbox ────────────────────────────────────────────────────────────

test('HostSandbox: captures stdout and exit code', async () => {
  const { fn } = fakeSpawn(() => ({ stdout: 'hi\n', exitCode: 0 }));
  const sb = new HostSandbox(fn);
  const r = await sb.run({ command: 'echo hi', cwd: '/tmp/x', timeoutMs: 1000 });
  assert.strictEqual(r.stdout, 'hi\n');
  assert.strictEqual(r.exitCode, 0);
  assert.strictEqual(r.isolation, 'host');
});

test('HostSandbox: splits command into cmd + args, cwd forwarded, env is PATH-only', async () => {
  const { fn, calls } = fakeSpawn(() => ({ exitCode: 0 }));
  const sb = new HostSandbox(fn);
  await sb.run({ command: 'node --test a.test.ts', cwd: '/proj', timeoutMs: 1000, env: { SECRET: 'x' } });
  assert.strictEqual(calls[0].cmd, 'node');
  assert.deepStrictEqual(calls[0].args, ['--test', 'a.test.ts']);
  assert.strictEqual(calls[0].opts.cwd, '/proj');
  assert.deepStrictEqual(Object.keys(calls[0].opts.env ?? {}), ['PATH']);
});

test('HostSandbox: spawn error → exitCode 1, stderr carries the message', async () => {
  const { fn } = fakeSpawn(() => ({ error: new Error('spawn nope ENOENT') }));
  const sb = new HostSandbox(fn);
  const r = await sb.run({ command: 'nope', cwd: '/tmp', timeoutMs: 1000 });
  assert.strictEqual(r.exitCode, 1);
  assert.ok(r.stderr.includes('ENOENT'));
});

test('HostSandbox: timeout → timedOut true and process killed', async () => {
  const { fn, killed } = fakeSpawn(() => ({ hang: true }));
  const sb = new HostSandbox(fn);
  const r = await sb.run({ command: 'sleep 999', cwd: '/tmp', timeoutMs: 5 });
  assert.strictEqual(r.timedOut, true);
  assert.ok(killed.length >= 1);
});

// ─── DockerSandbox: argv construction ─────────────────────────────────────────

test('DockerSandbox.buildRunArgs: isolation, limits, mount, image, shell command', () => {
  const sb = new DockerSandbox(dockerConfig());
  const args = sb.buildRunArgs({ command: 'npm test', cwd: '/proj', timeoutMs: 1000 }, 'c1');
  assert.deepStrictEqual(args.slice(0, 6), ['run', '--rm', '--name', 'c1', '--network', 'none']);
  assert.ok(args.includes('--memory') && args.includes('512m'));
  assert.ok(args.includes('--cpus') && args.includes('1'));
  assert.ok(args.includes('--pids-limit') && args.includes('256'));
  assert.ok(args.includes('-v') && args.includes('/proj:/sle/project'));
  assert.ok(args.includes('-w') && args.includes('/sle/project'));
  // image, then shell invocation, in order
  const tail = args.slice(-4);
  assert.deepStrictEqual(tail, ['test-image:1', '/bin/sh', '-c', 'npm test']);
});

test('DockerSandbox.buildRunArgs: read_only_project → :ro mount', () => {
  const sb = new DockerSandbox(dockerConfig({ read_only_project: true }));
  const args = sb.buildRunArgs({ command: 'ls', cwd: '/proj', timeoutMs: 1000 }, 'c1');
  assert.ok(args.includes('/proj:/sle/project:ro'));
});

test('DockerSandbox.buildRunArgs: bridge network + env vars', () => {
  const sb = new DockerSandbox(dockerConfig({ network: 'bridge' }));
  const args = sb.buildRunArgs(
    { command: 'x', cwd: '/p', timeoutMs: 1, env: { SLE_RUN_ID: 'r1', SLE_CATEGORY: 'c' } },
    'c1'
  );
  assert.ok(args.includes('bridge'));
  assert.ok(args.includes('-e') && args.includes('SLE_RUN_ID=r1') && args.includes('SLE_CATEGORY=c'));
});

// ─── DockerSandbox: availability probing ──────────────────────────────────────

test('DockerSandbox.isAvailable: daemon unreachable → docker_unreachable', async () => {
  const { fn } = fakeSpawn((_c, a) => (a[0] === 'version' ? { exitCode: 1 } : { exitCode: 0 }));
  const sb = new DockerSandbox(dockerConfig(), fn);
  assert.deepStrictEqual(await sb.isAvailable(), { ok: false, reason: 'docker_unreachable' });
});

test('DockerSandbox.isAvailable: no image configured → no_image_configured', async () => {
  const { fn } = fakeSpawn(() => ({ exitCode: 0 }));
  const sb = new DockerSandbox(defaultSandboxConfig({ kind: 'docker' }), fn);
  assert.deepStrictEqual(await sb.isAvailable(), { ok: false, reason: 'no_image_configured' });
});

test('DockerSandbox.isAvailable: image missing → image_missing', async () => {
  const { fn } = fakeSpawn((_c, a) => (a[0] === 'image' ? { exitCode: 1 } : { exitCode: 0 }));
  const sb = new DockerSandbox(dockerConfig(), fn);
  assert.deepStrictEqual(await sb.isAvailable(), { ok: false, reason: 'image_missing' });
});

test('DockerSandbox.isAvailable: daemon up + image present → ok', async () => {
  const { fn } = fakeSpawn(() => ({ exitCode: 0 }));
  const sb = new DockerSandbox(dockerConfig(), fn);
  assert.deepStrictEqual(await sb.isAvailable(), { ok: true });
});

// ─── resolveSandbox: selection policy ─────────────────────────────────────────

test('resolveSandbox: kind=host always yields HostSandbox', async () => {
  const { fn } = fakeSpawn(() => ({ exitCode: 0 }));
  const r = await resolveSandbox(defaultSandboxConfig({ kind: 'host' }), fn);
  assert.strictEqual(r.sandbox.isolation, 'host');
  assert.strictEqual(r.fallbackReason, undefined);
});

test('resolveSandbox: kind=auto + docker available → DockerSandbox', async () => {
  const { fn } = fakeSpawn(() => ({ exitCode: 0 }));
  const r = await resolveSandbox(dockerConfig({ kind: 'auto' }), fn);
  assert.strictEqual(r.sandbox.isolation, 'docker');
  assert.strictEqual(r.fallbackReason, undefined);
});

test('resolveSandbox: kind=auto + docker unavailable → HostSandbox with reason', async () => {
  const { fn } = fakeSpawn((_c, a) => (a[0] === 'version' ? { exitCode: 1 } : { exitCode: 0 }));
  const r = await resolveSandbox(dockerConfig({ kind: 'auto' }), fn);
  assert.strictEqual(r.sandbox.isolation, 'host');
  assert.strictEqual(r.fallbackReason, 'docker_unreachable');
});

test('resolveSandbox: kind=docker + unavailable → DockerSandbox with reason (strict)', async () => {
  const { fn } = fakeSpawn((_c, a) => (a[0] === 'image' ? { exitCode: 1 } : { exitCode: 0 }));
  const r = await resolveSandbox(dockerConfig({ kind: 'docker' }), fn);
  assert.strictEqual(r.sandbox.isolation, 'docker');
  assert.strictEqual(r.fallbackReason, 'image_missing');
});

// ─── ExecServiceReal: sandbox integration ─────────────────────────────────────

function makeBaseMap(exec?: Record<string, unknown>): RuntimeMap {
  return {
    meta: {
      status: 'cycling', cycle: 1, version_id: 'v1', initialized_at: '', updated_at: '',
      dag: { current_node: null, completed_nodes: [], iteration: 1, revision: 0, started_at: '', nodes: {} },
    },
    project: { name: 't', description: '', type: 'api' },
    remotes: { code: { type: 'git', url: '', branch: 'main' }, issues: { type: 'git', url: '', branch: 'main' }, docs: { url: '', pending: false } },
    task_store: { type: 'local' }, agents: {},
    discovery: { status: 'complete', mode: 'full', completed_at: '', artifacts: [], current_round: 0, total_rounds: 1, current_phase: 0, total_phases: 0, open_questions_count: 0, blocking_questions_count: 0 },
    cycle: { number: 1, iteration: 1, revision: 0, max_iterations: 5, planning_depth: 'standard', started_at: '', outcome: 'cycling', approval_gate: null, awaiting_scoping: false, awaiting_confirmation: false, awaiting_sharding_approval: false },
    artifacts: [],
    ...(exec ? { exec } : {}),
  } as unknown as RuntimeMap;
}

class InMemoryMapManager implements RuntimeMapManager {
  public map: RuntimeMap;
  constructor(map: RuntimeMap) { this.map = JSON.parse(JSON.stringify(map)); }
  async read() { return JSON.parse(JSON.stringify(this.map)); }
  async update(fn: (m: RuntimeMap) => RuntimeMap) { this.map = fn(JSON.parse(JSON.stringify(this.map))); }
  async write(m: RuntimeMap) { this.map = JSON.parse(JSON.stringify(m)); }
  [key: string]: unknown;
}

class MockRunArtifacts {
  public statusUpdates: Array<{ node: string; update: Record<string, unknown> }> = [];
  public failureReports: Record<string, unknown>[] = [];
  async updateNodeStatus(_c: number, _i: number, node: string, update: Record<string, unknown>) {
    this.statusUpdates.push({ node, update });
  }
  async writeFailureReport(_c: number, _i: number, report: Record<string, unknown>) {
    this.failureReports.push(report);
  }
  runDir(c: number, i: number) { return `.sle/runs/${c}-${i}`; }
  [key: string]: unknown;
}

async function makeTempRoot(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'sle-sandbox-test-'));
  await fs.mkdir(join(root, '.sle', 'runs', '1-1'), { recursive: true });
  return root;
}

test('ExecServiceReal: strict docker mode fails closed when docker unavailable', async () => {
  const root = await makeTempRoot();
  const mgr = new InMemoryMapManager(
    makeBaseMap({ command: 'echo hi', sandbox: 'docker', image: 'nonexistent-image-zzz:0' })
  );
  const artifacts = new MockRunArtifacts();
  // No runner injected → resolves from config. Image cannot exist → fail closed.
  const svc = new ExecServiceReal(mgr, artifacts as never, root);

  const r = await svc.run(1, 1);

  assert.strictEqual(r.success, false);
  assert.strictEqual(artifacts.failureReports.length, 1);
  const cat = (artifacts.failureReports[0].failed_categories as Array<{ name: string; error_summary: string }>)[0];
  assert.strictEqual(cat.name, 'exec_environment');
  assert.ok(cat.error_summary.startsWith('docker_unavailable'));
  await fs.rm(root, { recursive: true, force: true });
});

test('ExecServiceReal: injected Sandbox is used and isolation recorded in map', async () => {
  const root = await makeTempRoot();
  const mgr = new InMemoryMapManager(makeBaseMap({ command: 'echo hi' }));
  const artifacts = new MockRunArtifacts();
  // Inject a fake docker sandbox (arg construction verified elsewhere).
  const { fn } = fakeSpawn(() => ({ stdout: 'hi\n', exitCode: 0 }));
  const dockerSb = new DockerSandbox(dockerConfig(), fn);
  const svc = new ExecServiceReal(mgr, artifacts as never, root, dockerSb);

  const r = await svc.run(1, 1);

  assert.strictEqual(r.success, true);
  assert.strictEqual(r.isolation, 'docker');
  const execResult = ((await mgr.read()).meta as { dag?: { exec_result?: { isolation?: string } } }).dag?.exec_result;
  assert.strictEqual(execResult?.isolation, 'docker');
  await fs.rm(root, { recursive: true, force: true });
});

// ─── Real container integration (guarded) ─────────────────────────────────────

const OFFLINE_IMAGE = 'sle-sandbox-base:local';

function imageAvailable(image: string): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = nodeSpawn('docker', ['image', 'inspect', image], {
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
        shell: false,
      });
    } catch { resolve(false); return; }
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

test('DockerSandbox integration: runs a real container, captures stdout + exit code', async (t) => {
  if (!(await imageAvailable(OFFLINE_IMAGE))) { t.skip(`image ${OFFLINE_IMAGE} not available`); return; }
  const sb = new DockerSandbox(dockerConfig({ image: OFFLINE_IMAGE }));
  const ok = await sb.run({ command: 'echo hello-docker', cwd: '/tmp', timeoutMs: 30_000 });
  assert.strictEqual(ok.exitCode, 0);
  assert.strictEqual(ok.isolation, 'docker');
  assert.ok(ok.stdout.includes('hello-docker'), `stdout was: ${JSON.stringify(ok.stdout)}`);

  const bad = await sb.run({ command: 'exit 7', cwd: '/tmp', timeoutMs: 30_000 });
  assert.strictEqual(bad.exitCode, 7);
});

test('ExecServiceReal integration: config-resolved docker sandbox runs a real container', async (t) => {
  if (!(await imageAvailable(OFFLINE_IMAGE))) { t.skip(`image ${OFFLINE_IMAGE} not available`); return; }
  const root = await makeTempRoot();
  const mgr = new InMemoryMapManager(
    makeBaseMap({ command: 'echo hello-from-real-exec', sandbox: 'docker', image: OFFLINE_IMAGE })
  );
  const artifacts = new MockRunArtifacts();
  const svc = new ExecServiceReal(mgr, artifacts as never, root); // no injection → real resolution

  const r = await svc.run(1, 1);

  assert.strictEqual(r.success, true);
  assert.strictEqual(r.isolation, 'docker');
  const stdoutFile = await fs.readFile(join(root, '.sle', 'runs', '1-1', 'exec', 'stdout.txt'), 'utf-8');
  assert.ok(stdoutFile.includes('hello-from-real-exec'));
  const execResult = ((await mgr.read()).meta as { dag?: { exec_result?: { isolation?: string } } }).dag?.exec_result;
  assert.strictEqual(execResult?.isolation, 'docker');
  await fs.rm(root, { recursive: true, force: true });
});
