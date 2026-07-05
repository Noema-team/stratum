import { spawn as nodeSpawn } from 'child_process';
import type { RuntimeMapManager } from './runtime-map.js';
import type { RunArtifactManager } from './run-artifacts.js';
import type { FailureCategory } from './types.js';
import path from 'path';
import { promises as fs } from 'fs';
import {
  type Sandbox,
  type SandboxKind,
  type SandboxRunResult,
  type SpawnFn,
  HostSandbox,
  defaultSandboxConfig,
  resolveSandbox,
} from './sandbox.js';

export type { SpawnFn };

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ExecResult {
  next_node: 'VALIDATION_GATE';
  exit_code: number;
  stdout: string;
  stderr: string;
  timed_out: boolean;
  success: boolean;
  isolation?: 'docker' | 'host';
  oom_killed?: boolean;
}

/** EXEC configuration read from `map.exec`. */
interface ExecConfig {
  command?: string;
  timeout_ms?: number;
  sandbox?: SandboxKind;
  image?: string;
  network?: 'none' | 'bridge';
  read_only_project?: boolean;
  memory_mb?: number;
  cpu_cores?: number;
  pids_max?: number;
}

// ─── Truncation limit for failure reports (not artifact files) ─────────────────

const MAX_REPORT_OUTPUT_BYTES = 10 * 1024; // 10 KB

function truncate(s: string): string {
  if (Buffer.byteLength(s, 'utf-8') <= MAX_REPORT_OUTPUT_BYTES) return s;
  return s.slice(0, MAX_REPORT_OUTPUT_BYTES) + '\n... [truncated]';
}

// ─── ExecServiceReal ──────────────────────────────────────────────────────────

export class ExecServiceReal {
  private injectedSandbox?: Sandbox;
  private legacySpawn?: SpawnFn;

  /**
   * @param runner Optional execution override:
   *   - a {@link SpawnFn} → forces host execution with that spawn (legacy/tests);
   *   - a {@link Sandbox} → runs through it directly;
   *   - omitted → the sandbox is resolved from `map.exec` config (docker by
   *     default when an image is available, else host).
   */
  constructor(
    private mapManager: RuntimeMapManager,
    private runArtifacts: RunArtifactManager,
    private projectRoot: string,
    runner?: SpawnFn | Sandbox
  ) {
    if (typeof runner === 'function') this.legacySpawn = runner as SpawnFn;
    else if (runner) this.injectedSandbox = runner;
  }

  async run(cycleNumber: number, iteration: number): Promise<ExecResult> {
    const map = await this.mapManager.read();
    const execConfig = ((map as unknown as Record<string, unknown>).exec ?? {}) as ExecConfig;
    const command = execConfig.command ?? (map.meta as { exec_command?: string }).exec_command;

    // No command configured → no-op success
    if (!command) {
      await this.runArtifacts.updateNodeStatus(cycleNumber, iteration, 'EXEC', {
        status: 'complete',
        exit_code: 0,
        timed_out: false,
      } as never);
      await this.writeExecResult(0, false);
      return { next_node: 'VALIDATION_GATE', exit_code: 0, stdout: '', stderr: '', timed_out: false, success: true };
    }

    const timeoutMs = execConfig.timeout_ms ?? 120_000;

    await this.runArtifacts.updateNodeStatus(cycleNumber, iteration, 'EXEC', {
      status: 'running',
      started_at: new Date().toISOString(),
    } as never);

    // ── Resolve the execution sandbox ────────────────────────────────────────
    const { sandbox, fallbackReason } = await this.resolveExecSandbox(execConfig);

    // Strict docker mode: fail closed rather than silently running on the host.
    if (this.usesConfig() && execConfig.sandbox === 'docker' && fallbackReason) {
      return this.failStrictDocker(cycleNumber, iteration, fallbackReason);
    }

    const outcome: SandboxRunResult = await sandbox.run({ command, cwd: this.projectRoot, timeoutMs });
    const { exitCode, stdout, stderr, timedOut, oomKilled, isolation } = outcome;
    const success = exitCode === 0 && !timedOut;

    // Write stdout/stderr artifacts
    const execDir = path.join(
      this.projectRoot, '.sle', 'runs', `${cycleNumber}-${iteration}`, 'exec'
    );
    await fs.mkdir(execDir, { recursive: true });
    await fs.writeFile(path.join(execDir, 'stdout.txt'), stdout, 'utf-8');
    await fs.writeFile(path.join(execDir, 'stderr.txt'), stderr, 'utf-8');

    await this.writeExecResult(exitCode, timedOut, isolation, oomKilled);

    if (!success) {
      const reason = timedOut
        ? `Command timed out after ${timeoutMs}ms`
        : oomKilled
          ? `Command killed (out of memory) with code ${exitCode}`
          : `Command exited with code ${exitCode}`;
      const failedCategories: FailureCategory[] = [
        {
          name: 'exec_failure',
          method: 'executable' as const,
          error_summary: reason,
          test_output: truncate(stdout + (stderr ? `\nSTDERR:\n${stderr}` : '')),
        },
      ];
      await this.runArtifacts.writeFailureReport(cycleNumber, iteration, {
        cycle: cycleNumber,
        iteration,
        run_dir: `.sle/runs/${cycleNumber}-${iteration}`,
        run_id: `${cycleNumber}-${iteration}`,
        quick_summary: `${timedOut ? 'EXEC timed out' : `EXEC failed with exit code ${exitCode}`} (isolation: ${isolation})`,
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
      isolation,
      oom_killed: oomKilled,
    };
  }

  // ─── Sandbox resolution ───────────────────────────────────────────────────

  private usesConfig(): boolean {
    return !this.injectedSandbox && !this.legacySpawn;
  }

  private async resolveExecSandbox(
    execConfig: ExecConfig
  ): Promise<{ sandbox: Sandbox; fallbackReason?: string }> {
    if (this.injectedSandbox) return { sandbox: this.injectedSandbox };
    if (this.legacySpawn) return { sandbox: new HostSandbox(this.legacySpawn) };

    const config = defaultSandboxConfig({
      kind: execConfig.sandbox ?? 'auto',
      image: execConfig.image,
      network: execConfig.network,
      read_only_project: execConfig.read_only_project,
      limits: {
        memory_mb: execConfig.memory_mb ?? 512,
        cpu_cores: execConfig.cpu_cores ?? 1.0,
        pids_max: execConfig.pids_max ?? 256,
      },
    });
    return resolveSandbox(config, nodeSpawn);
  }

  private async failStrictDocker(
    cycleNumber: number,
    iteration: number,
    reason: string
  ): Promise<ExecResult> {
    await this.writeExecResult(1, false);
    await this.runArtifacts.writeFailureReport(cycleNumber, iteration, {
      cycle: cycleNumber,
      iteration,
      run_dir: `.sle/runs/${cycleNumber}-${iteration}`,
      run_id: `${cycleNumber}-${iteration}`,
      quick_summary: `EXEC halted: docker sandbox required but unavailable (${reason})`,
      failed_categories: [
        {
          name: 'exec_environment',
          method: 'executable' as const,
          error_summary: `docker_unavailable: ${reason}`,
        },
      ],
      passed_categories: [],
    });
    await this.runArtifacts.updateNodeStatus(cycleNumber, iteration, 'EXEC', {
      status: 'failed',
      exit_code: 1,
      timed_out: false,
    } as never);
    return {
      next_node: 'VALIDATION_GATE',
      exit_code: 1,
      stdout: '',
      stderr: `docker sandbox unavailable: ${reason}`,
      timed_out: false,
      success: false,
      isolation: 'docker',
    };
  }

  private async writeExecResult(
    exitCode: number,
    timedOut: boolean,
    isolation?: 'docker' | 'host',
    oomKilled?: boolean
  ): Promise<void> {
    await this.mapManager.update((m) => ({
      ...m,
      meta: {
        ...m.meta,
        dag: m.meta.dag
          ? {
              ...m.meta.dag,
              exec_result: {
                exit_code: exitCode,
                timed_out: timedOut,
                ...(isolation ? { isolation } : {}),
                ...(oomKilled ? { oom_killed: oomKilled } : {}),
              },
            }
          : undefined,
      },
    }));
  }
}
