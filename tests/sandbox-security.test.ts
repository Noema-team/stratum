import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { promises as fs } from 'fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn as nodeSpawn } from 'child_process';
import { JobQueue, DockerWorkerPool } from '../src/exec-service.js';

function makeSpawnMock(options: {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
}): any {
  return ((cmd: string, args: string[]) => {
    const stdoutHandlers: Array<(d: Buffer) => void> = [];
    const stderrHandlers: Array<(d: Buffer) => void> = [];
    const closeHandlers: Array<(code: number | null) => void> = [];

    const child = {
      stdout: {
        on: (ev: string, fn: (d: Buffer) => void) => { stdoutHandlers.push(fn); },
      },
      stderr: {
        on: (ev: string, fn: (d: Buffer) => void) => { stderrHandlers.push(fn); },
      },
      on: (event: string, fn: (...args: any[]) => void) => {
        if (event === 'close') closeHandlers.push(fn);
      },
      kill: () => {},
    };

    Promise.resolve().then(() => {
      if (options.stdout) stdoutHandlers.forEach((fn) => fn(Buffer.from(options.stdout!)));
      if (options.stderr) stderrHandlers.forEach((fn) => fn(Buffer.from(options.stderr!)));
      closeHandlers.forEach((fn) => fn(options.exitCode ?? 0));
    });

    return child;
  }) as any;
}

test('Sandbox Security: worker pool startup and fallback mode detection', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sle-sandbox-test-'));
  const queue = new JobQueue();
  
  // Create a mock spawn that fails on docker info to trigger fallback mode
  const mockSpawn = makeSpawnMock({ exitCode: 1, stderr: 'docker not found' });
  const pool = new DockerWorkerPool(queue, root, null as any, {}, {}, mockSpawn);

  await pool.start();
  assert.strictEqual(pool['useFallback'], true);

  await pool.stop();
  await fs.rm(root, { recursive: true, force: true });
});

test('Sandbox Security: container spec mounts and resource limits mapping', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sle-sandbox-test-'));
  const queue = new JobQueue();

  const spec = {
    image: 'node:20-alpine',
    install_command: '',
    timeout_ms: 10000,
    env: {},
    mount_points: [{ host_path: '/foo', container_path: '/bar', read_only: true }],
    resource_limits: { memory_mb: 256, cpu_cores: 0.5, disk_mb: 256, pids_max: 64 },
    network_mode: 'none' as const,
  };

  const mockSpawn = makeSpawnMock({ exitCode: 0, stdout: 'mock' });
  const pool = new DockerWorkerPool(queue, root, null as any, {}, spec, mockSpawn);

  assert.strictEqual(pool['containerSpec'].network_mode, 'none');
  assert.strictEqual(pool['containerSpec'].resource_limits.memory_mb, 256);
  assert.strictEqual(pool['containerSpec'].mount_points[0].container_path, '/bar');

  await fs.rm(root, { recursive: true, force: true });
});
