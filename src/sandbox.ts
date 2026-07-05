import { spawn as nodeSpawn } from 'child_process';

/**
 * Execution sandbox abstraction for the EXEC node.
 *
 * The EXEC node runs project-supplied test/validation commands. Running those
 * directly as host subprocesses gives them the full privileges of the daemon
 * (network, filesystem, credentials) — the top security risk flagged in the
 * spec-divergence audit. This module isolates the "how do we run a command"
 * concern behind a {@link Sandbox} interface so the runner can be swapped:
 *
 *  - {@link DockerSandbox}: runs the command inside a throwaway container with
 *    no network, bounded CPU/memory/PIDs, and only the project directory
 *    mounted. This is the secure default when a container image is available.
 *  - {@link HostSandbox}: runs the command as a host subprocess (the legacy
 *    behaviour). Fast and dependency-free, but unisolated — dev/fallback only.
 *
 * The larger job-dispatch worker-pool machinery (specs/job-dispatch.md) can
 * grow on top of this seam later; this is the minimal isolation primitive.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type SpawnFn = typeof nodeSpawn;

export type SandboxKind = 'auto' | 'docker' | 'host';

export type NetworkMode = 'none' | 'bridge';

export interface ResourceLimits {
  memory_mb: number;
  cpu_cores: number;
  pids_max: number;
}

export interface SandboxConfig {
  /** Which sandbox to use. `auto` prefers docker when usable, else host. */
  kind: SandboxKind;
  /** Container image for docker mode. Required for docker to be "available". */
  image?: string;
  /** Container network access. `none` (default) fully isolates the network. */
  network: NetworkMode;
  /** Mount the project directory read-only inside the container. */
  read_only_project: boolean;
  limits: ResourceLimits;
}

export interface SandboxRunRequest {
  /** Full command line, e.g. `npm test`. Split on whitespace for host mode. */
  command: string;
  /** Host path to the project directory (working dir / mount source). */
  cwd: string;
  timeoutMs: number;
  /** Extra env vars. Host mode ignores these for safety (PATH only). */
  env?: Record<string, string>;
}

export interface SandboxRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  oomKilled: boolean;
  /** Which sandbox actually executed the command (for observability). */
  isolation: 'docker' | 'host';
}

export interface Availability {
  ok: boolean;
  reason?: string;
}

export interface Sandbox {
  readonly isolation: 'docker' | 'host';
  isAvailable(): Promise<Availability>;
  run(req: SandboxRunRequest): Promise<SandboxRunResult>;
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

export const DEFAULT_LIMITS: ResourceLimits = {
  memory_mb: 512,
  cpu_cores: 1.0,
  pids_max: 256,
};

export function defaultSandboxConfig(overrides: Partial<SandboxConfig> = {}): SandboxConfig {
  return {
    kind: overrides.kind ?? 'auto',
    image: overrides.image,
    network: overrides.network ?? 'none',
    read_only_project: overrides.read_only_project ?? false,
    limits: { ...DEFAULT_LIMITS, ...(overrides.limits ?? {}) },
  };
}

// ─── Shared spawn helper ───────────────────────────────────────────────────────

interface SpawnOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Spawn a process, capture stdout/stderr, enforce a timeout via SIGTERM.
 * `onTimeout` runs just before the child is signalled (used by docker mode to
 * `docker kill` the container). Rejects only on spawn error (e.g. ENOENT).
 */
function spawnCapture(
  spawnFn: SpawnFn,
  cmd: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
  onTimeout?: () => void
): Promise<SpawnOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawnFn(cmd, args, { cwd, env, shell: false });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        onTimeout?.();
      } catch {
        /* best-effort */
      }
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

// ─── HostSandbox (legacy, unisolated) ──────────────────────────────────────────

export class HostSandbox implements Sandbox {
  readonly isolation = 'host' as const;

  constructor(private spawnFn: SpawnFn = nodeSpawn) {}

  async isAvailable(): Promise<Availability> {
    return { ok: true };
  }

  async run(req: SandboxRunRequest): Promise<SandboxRunResult> {
    const [cmd, ...args] = req.command.split(/\s+/);
    // Host mode deliberately does NOT forward req.env: the command inherits only
    // PATH, never the daemon's credentials or environment.
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin' };
    try {
      const out = await spawnCapture(this.spawnFn, cmd, args, req.cwd, env, req.timeoutMs);
      return {
        exitCode: out.exitCode,
        stdout: out.stdout,
        stderr: out.stderr,
        timedOut: out.timedOut,
        oomKilled: false,
        isolation: 'host',
      };
    } catch (err) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
        timedOut: false,
        oomKilled: false,
        isolation: 'host',
      };
    }
  }
}

// ─── DockerSandbox (isolated) ───────────────────────────────────────────────────

const CONTAINER_PROJECT_PATH = '/sle/project';

export class DockerSandbox implements Sandbox {
  readonly isolation = 'docker' as const;

  constructor(
    private config: SandboxConfig,
    private spawnFn: SpawnFn = nodeSpawn,
    private dockerBin = 'docker'
  ) {}

  async isAvailable(): Promise<Availability> {
    const daemon = await this.probe(['version', '--format', '{{.Server.Version}}']);
    if (!daemon) return { ok: false, reason: 'docker_unreachable' };
    if (!this.config.image) return { ok: false, reason: 'no_image_configured' };
    const image = await this.probe(['image', 'inspect', this.config.image]);
    if (!image) return { ok: false, reason: 'image_missing' };
    return { ok: true };
  }

  /** Build the `docker run` argv for a request. Exposed for testing. */
  buildRunArgs(req: SandboxRunRequest, containerName: string): string[] {
    const { image, network, read_only_project, limits } = this.config;
    const args = ['run', '--rm', '--name', containerName, '--network', network];

    if (limits.memory_mb > 0) {
      args.push('--memory', `${limits.memory_mb}m`, '--memory-swap', `${limits.memory_mb}m`);
    }
    if (limits.cpu_cores > 0) args.push('--cpus', String(limits.cpu_cores));
    if (limits.pids_max > 0) args.push('--pids-limit', String(limits.pids_max));

    const mount = read_only_project
      ? `${req.cwd}:${CONTAINER_PROJECT_PATH}:ro`
      : `${req.cwd}:${CONTAINER_PROJECT_PATH}`;
    args.push('-v', mount, '-w', CONTAINER_PROJECT_PATH);

    for (const [k, v] of Object.entries(req.env ?? {})) {
      args.push('-e', `${k}=${v}`);
    }

    args.push(image ?? '', '/bin/sh', '-c', req.command);
    return args;
  }

  async run(req: SandboxRunRequest): Promise<SandboxRunResult> {
    const containerName = `sle-exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const args = this.buildRunArgs(req, containerName);
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin' };

    try {
      const out = await spawnCapture(
        this.spawnFn,
        this.dockerBin,
        args,
        req.cwd,
        env,
        req.timeoutMs,
        // On timeout, kill the container so `docker run` returns promptly.
        () => { try { this.spawnFn(this.dockerBin, ['kill', containerName], { env }); } catch { /* best-effort */ } }
      );
      // 137 = 128 + SIGKILL. When we did not time out, treat it as an OOM kill.
      const oomKilled = out.exitCode === 137 && !out.timedOut;
      return {
        exitCode: out.exitCode,
        stdout: out.stdout,
        stderr: out.stderr,
        timedOut: out.timedOut,
        oomKilled,
        isolation: 'docker',
      };
    } catch (err) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
        timedOut: false,
        oomKilled: false,
        isolation: 'docker',
      };
    }
  }

  private probe(args: string[]): Promise<boolean> {
    return new Promise((resolve) => {
      let child;
      try {
        child = this.spawnFn(this.dockerBin, args, {
          env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
          shell: false,
        });
      } catch {
        resolve(false);
        return;
      }
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
    });
  }
}

// ─── Resolution ─────────────────────────────────────────────────────────────────

export interface ResolvedSandbox {
  sandbox: Sandbox;
  /** Set when the requested kind could not be honoured (e.g. docker fell back). */
  fallbackReason?: string;
}

/**
 * Pick the sandbox to run with, honouring config.kind:
 *
 *  - `host`   → always {@link HostSandbox}.
 *  - `docker` → {@link DockerSandbox}; if unavailable, returns it anyway with a
 *               `fallbackReason` so the caller can fail closed (strict mode).
 *  - `auto`   → docker when available, otherwise host with a `fallbackReason`.
 */
export async function resolveSandbox(
  config: SandboxConfig,
  spawnFn: SpawnFn = nodeSpawn
): Promise<ResolvedSandbox> {
  if (config.kind === 'host') {
    return { sandbox: new HostSandbox(spawnFn) };
  }

  const docker = new DockerSandbox(config, spawnFn);
  const availability = await docker.isAvailable();

  if (config.kind === 'docker') {
    // Strict: caller decides what to do with an unavailable docker sandbox.
    return availability.ok
      ? { sandbox: docker }
      : { sandbox: docker, fallbackReason: availability.reason };
  }

  // auto
  if (availability.ok) return { sandbox: docker };
  return { sandbox: new HostSandbox(spawnFn), fallbackReason: availability.reason };
}
