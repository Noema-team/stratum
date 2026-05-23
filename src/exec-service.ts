import { spawn as nodeSpawn } from 'child_process';
import type { RuntimeMapManager } from './runtime-map.js';
import type { RunArtifactManager } from './run-artifacts.js';
import type { FailureCategory } from './types.js';
import path from 'path';
import { promises as fs } from 'fs';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ExecResult {
  next_node: 'VALIDATION_GATE';
  exit_code: number;
  stdout: string;
  stderr: string;
  timed_out: boolean;
  success: boolean;
}

export type SpawnFn = typeof nodeSpawn;

// ─── Truncation limit for failure reports (not artifact files) ─────────────────

const MAX_REPORT_OUTPUT_BYTES = 10 * 1024; // 10 KB

function truncate(s: string): string {
  if (Buffer.byteLength(s, 'utf-8') <= MAX_REPORT_OUTPUT_BYTES) return s;
  return s.slice(0, MAX_REPORT_OUTPUT_BYTES) + '\n... [truncated]';
}

// ─── ExecServiceReal ──────────────────────────────────────────────────────────

export class ExecServiceReal {
  constructor(
    private mapManager: RuntimeMapManager,
    private runArtifacts: RunArtifactManager,
    private projectRoot: string,
    private spawnFn: SpawnFn = nodeSpawn
  ) {}

  async run(cycleNumber: number, iteration: number): Promise<ExecResult> {
    const map = await this.mapManager.read();
    const execConfig = (map as unknown as Record<string, unknown>).exec as { command?: string; timeout_ms?: number } | undefined;
    const command = execConfig?.command
      ?? (map.meta as { exec_command?: string }).exec_command;

    // No command configured → no-op success
    if (!command) {
      await this.runArtifacts.updateNodeStatus(cycleNumber, iteration, 'EXEC', {
        status: 'complete',
        exit_code: 0,
        timed_out: false,
      } as never);
      await this.mapManager.update((m) => ({
        ...m,
        meta: {
          ...m.meta,
          dag: m.meta.dag
            ? { ...m.meta.dag, exec_result: { exit_code: 0, timed_out: false } }
            : undefined,
        },
      }));
      return { next_node: 'VALIDATION_GATE', exit_code: 0, stdout: '', stderr: '', timed_out: false, success: true };
    }

    const timeoutMs = execConfig?.timeout_ms ?? 120_000;

    await this.runArtifacts.updateNodeStatus(cycleNumber, iteration, 'EXEC', {
      status: 'running',
      started_at: new Date().toISOString(),
    } as never);

    let exitCode = 0;
    let timedOut = false;
    let stdout = '';
    let stderr = '';

    try {
      const result = await this.spawnCommand(command, this.projectRoot, timeoutMs, this.spawnFn);
      exitCode = result.exitCode;
      timedOut = result.timedOut;
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (err) {
      // Spawn error (e.g. ENOENT binary not found)
      stderr = err instanceof Error ? err.message : String(err);
      exitCode = 1;
    }

    const success = exitCode === 0 && !timedOut;

    // Write stdout/stderr artifacts
    const execDir = path.join(
      this.projectRoot, '.sle', 'runs', `${cycleNumber}-${iteration}`, 'exec'
    );
    await fs.mkdir(execDir, { recursive: true });
    await fs.writeFile(path.join(execDir, 'stdout.txt'), stdout, 'utf-8');
    await fs.writeFile(path.join(execDir, 'stderr.txt'), stderr, 'utf-8');

    // Update map with exec result for ValidationGate to read
    await this.mapManager.update((m) => ({
      ...m,
      meta: {
        ...m.meta,
        dag: m.meta.dag
          ? { ...m.meta.dag, exec_result: { exit_code: exitCode, timed_out: timedOut } }
          : undefined,
      },
    }));

    if (!success) {
      const failedCategories: FailureCategory[] = [
        {
          name: 'exec_failure',
          method: 'executable' as const,
          error_summary: timedOut
            ? `Command timed out after ${timeoutMs}ms`
            : `Command exited with code ${exitCode}`,
          test_output: truncate(stdout + (stderr ? `\nSTDERR:\n${stderr}` : '')),
        },
      ];
      await this.runArtifacts.writeFailureReport(cycleNumber, iteration, {
        cycle: cycleNumber,
        iteration,
        run_dir: `.sle/runs/${cycleNumber}-${iteration}`,
        run_id: `${cycleNumber}-${iteration}`,
        quick_summary: timedOut ? 'EXEC timed out' : `EXEC failed with exit code ${exitCode}`,
        failed_categories: failedCategories,
        passed_categories: [],
      });
      await this.runArtifacts.updateNodeStatus(cycleNumber, iteration, 'EXEC', {
        status: 'failed',
        exit_code: exitCode,
        timed_out: timedOut,
      } as never);
    } else {
      await this.runArtifacts.updateNodeStatus(cycleNumber, iteration, 'EXEC', {
        status: 'complete',
        exit_code: exitCode,
        timed_out: false,
      } as never);
    }

    return {
      next_node: 'VALIDATION_GATE',
      exit_code: exitCode,
      stdout,
      stderr,
      timed_out: timedOut,
      success,
    };
  }

  private spawnCommand(
    command: string,
    cwd: string,
    timeoutMs: number,
    spawnFn: SpawnFn
  ): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
    return new Promise((resolve, reject) => {
      const [cmd, ...args] = command.split(/\s+/);
      const child = spawnFn(cmd, args, {
        cwd,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
        shell: false,
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, timeoutMs);

      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code ?? 1, stdout, stderr, timedOut });
      });
    });
  }
}
