import { spawn as nodeSpawn } from 'child_process';
import { randomUUID } from 'node:crypto';
import os from 'os';
import type { RuntimeMapManager } from './runtime-map.js';
import type { RunArtifactManager } from './run-artifacts.js';
import type { 
  FailureCategory, 
  Job, 
  JobStatus, 
  JobPriority, 
  JobType, 
  SubPhase, 
  TaskContextDeclaration,
  DispatchPlan,
  DispatchPlanJob,
  Worker,
  WorkerPoolConfig,
  ContainerSpec,
  JobResult,
  JobError,
  JobDispatchState
} from './types.js';
import path from 'path';
import { promises as fs } from 'fs';
import { load as parseYAML } from 'js-yaml';

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

// ─── Job Queue & Dispatch Plan ──────────────────────────────────────────────

export class JobQueue {
  private jobs: Job[] = [];

  enqueue(params: {
    type: JobType;
    priority: JobPriority;
    cycle_id: string;
    iteration: number;
    run_id: string;
    category: string | null;
    sub_phase: SubPhase | null;
    task_id?: string | null;
    task_context_declaration?: TaskContextDeclaration | null;
  }): Job {
    const job: Job = {
      id: randomUUID(),
      type: params.type,
      status: 'queued',
      priority: params.priority,
      created_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
      cycle_id: params.cycle_id,
      iteration: params.iteration,
      run_id: params.run_id,
      category: params.category,
      sub_phase: params.sub_phase,
      task_id: params.task_id ?? null,
      task_context_declaration: params.task_context_declaration ?? null,
      container_id: null,
      context_pack_path: null,
      result: null,
      error: null,
    };
    this.jobs.push(job);
    return job;
  }

  dequeue(): Job | null {
    const queuedJobs = this.jobs.filter((j) => j.status === 'queued');
    if (queuedJobs.length === 0) return null;

    // Filter out jobs blocked by the static check gate
    const readyJobs = queuedJobs.filter((j) => {
      const hasActiveStaticCheck = this.jobs.some(
        (other) =>
          other.run_id === j.run_id &&
          other.iteration === j.iteration &&
          other.type === 'static-check' &&
          other.status !== 'completed' &&
          other.status !== 'failed' &&
          other.status !== 'cancelled' &&
          other.status !== 'timed_out'
      );
      if (j.type !== 'static-check' && hasActiveStaticCheck) {
        return false;
      }
      return true;
    });

    if (readyJobs.length === 0) return null;

    // Sort by priority (0 is highest), then by created_at (FIFO)
    readyJobs.sort((a, b) => {
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }
      return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    });

    const nextJob = readyJobs[0];
    nextJob.status = 'preparing';
    return nextJob;
  }

  getJob(id: string): Job | undefined {
    return this.jobs.find((j) => j.id === id);
  }

  getAllJobs(): Job[] {
    return [...this.jobs];
  }

  updateJobStatus(id: string, status: JobStatus, updates?: Partial<Job>): Job | null {
    const job = this.getJob(id);
    if (!job) return null;
    job.status = status;
    if (status === 'running' && !job.started_at) {
      job.started_at = new Date().toISOString();
    }
    if ((status === 'completed' || status === 'failed' || status === 'timed_out' || status === 'cancelled') && !job.completed_at) {
      job.completed_at = new Date().toISOString();
    }
    if (updates) {
      Object.assign(job, updates);
    }
    return job;
  }

  cancelJobsForIteration(runId: string, iteration: number): void {
    for (const job of this.jobs) {
      if (
        job.run_id === runId &&
        job.iteration === iteration &&
        (job.status === 'queued' || job.status === 'preparing')
      ) {
        job.status = 'cancelled';
        job.completed_at = new Date().toISOString();
      }
    }
  }
}

export function createDispatchPlan(runId: string, cycleId: string, iteration: number, categories: string[]): DispatchPlan {
  const staticCheckJobId = randomUUID();
  const jobs: DispatchPlanJob[] = [
    {
      job_type: 'static-check',
      category: null,
      sub_phase: 'static-check',
      depends_on: [],
      priority: 0,
    }
  ];

  for (const cat of categories) {
    jobs.push({
      job_type: 'exec-check',
      category: cat,
      sub_phase: 'exec-check',
      depends_on: [staticCheckJobId],
      priority: 1,
    });
    jobs.push({
      job_type: 'llm-check',
      category: cat,
      sub_phase: 'llm-check',
      depends_on: [staticCheckJobId],
      priority: 2,
    });
  }

  return {
    run_id: runId,
    cycle_id: cycleId,
    iteration,
    created_at: new Date().toISOString(),
    jobs,
    static_gate: {
      job_id: staticCheckJobId,
      blocks: jobs.filter(j => j.job_type !== 'static-check').map(() => randomUUID()),
    }
  };
}

// ─── Truncation limit for failure reports ──────────────────────────────────────

const MAX_REPORT_OUTPUT_BYTES = 10 * 1024; // 10 KB

function truncate(s: string): string {
  if (Buffer.byteLength(s, 'utf-8') <= MAX_REPORT_OUTPUT_BYTES) return s;
  return s.slice(0, MAX_REPORT_OUTPUT_BYTES) + '\n... [truncated]';
}

// ─── Docker Worker Pool ──────────────────────────────────────────────────────────

export class DockerWorkerPool {
  private workers: Worker[] = [];
  private config: WorkerPoolConfig;
  private containerSpec: ContainerSpec;
  private queue: JobQueue;
  private projectRoot: string;
  private mapManager: RuntimeMapManager;
  private spawnFn: SpawnFn;
  private useFallback: boolean = false;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private scaleInterval: NodeJS.Timeout | null = null;
  private workerLastActive: Map<string, number> = new Map(); // workerId -> timestamp

  constructor(
    queue: JobQueue,
    projectRoot: string,
    mapManager: RuntimeMapManager,
    config?: Partial<WorkerPoolConfig>,
    containerSpec?: Partial<ContainerSpec>,
    spawnFn: SpawnFn = nodeSpawn
  ) {
    this.queue = queue;
    this.projectRoot = projectRoot;
    this.mapManager = mapManager;
    this.spawnFn = spawnFn;

    const cpuCount = os.cpus().length;
    this.config = {
      max_workers: config?.max_workers ?? Math.min(cpuCount, 8),
      min_workers: config?.min_workers ?? 1,
      idle_timeout_ms: config?.idle_timeout_ms ?? 30000,
      heartbeat_interval_ms: config?.heartbeat_interval_ms ?? 5000,
      max_heartbeat_misses: config?.max_heartbeat_misses ?? 3,
      container_startup_timeout_ms: config?.container_startup_timeout_ms ?? 60000,
    };

    this.containerSpec = {
      image: containerSpec?.image ?? 'node:20-alpine',
      install_command: containerSpec?.install_command ?? '',
      timeout_ms: containerSpec?.timeout_ms ?? 120000,
      env: containerSpec?.env ?? {},
      mount_points: containerSpec?.mount_points ?? [],
      resource_limits: containerSpec?.resource_limits ?? {
        memory_mb: 512,
        cpu_cores: 1.0,
        disk_mb: 512,
        pids_max: 256,
      },
      network_mode: containerSpec?.network_mode ?? 'none',
    };
  }

  async start(): Promise<void> {
    this.useFallback = !(await this.isDockerAvailable());
    if (this.useFallback) {
      console.warn('Docker daemon not found or unavailable. Falling back to native host execution.');
    } else {
      await this.cleanupOrphanedContainers();
    }

    // Pre-warm min_workers
    for (let i = 0; i < this.config.min_workers; i++) {
      await this.spawnWorker();
    }

    this.heartbeatInterval = setInterval(async () => {
      await this.checkHeartbeats();
    }, this.config.heartbeat_interval_ms);

    this.scaleInterval = setInterval(async () => {
      await this.scaleDownIdleWorkers();
      await this.dispatchJobs();
    }, 1000);

    await this.updateDispatchState();
  }

  async stop(): Promise<void> {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.scaleInterval) {
      clearInterval(this.scaleInterval);
      this.scaleInterval = null;
    }

    const copy = [...this.workers];
    for (const w of copy) {
      await this.destroyWorker(w.id);
    }
    this.workers = [];
    await this.updateDispatchState();
  }

  async dispatchJobs(): Promise<void> {
    await this.scaleUpWorkers();

    const idleWorkers = this.workers.filter((w) => w.status === 'idle');
    if (idleWorkers.length === 0) return;

    for (const worker of idleWorkers) {
      const job = this.queue.dequeue();
      if (!job) break;

      worker.status = 'busy';
      worker.current_job_id = job.id;
      this.queue.updateJobStatus(job.id, 'running', { container_id: worker.container_id });
      await this.updateDispatchState(true, false);

      this.runJobInWorker(worker, job).catch((err) => {
        console.error(`Error running job ${job.id} on worker ${worker.id}:`, err);
      });
    }
  }

  private async spawnWorker(): Promise<Worker> {
    const workerId = randomUUID();
    const worker: Worker = {
      id: workerId,
      status: 'idle',
      container_id: null,
      current_job_id: null,
      last_heartbeat: new Date().toISOString(),
      total_jobs_completed: 0,
      total_errors: 0,
    };

    if (!this.useFallback) {
      const containerName = `sle-worker-${workerId}`;
      const args = [
        'run',
        '-d',
        '--name', containerName,
        '--label', 'sle-worker=true',
        '--network', this.containerSpec.network_mode,
        '--memory', `${this.containerSpec.resource_limits.memory_mb}m`,
        '--cpus', `${this.containerSpec.resource_limits.cpu_cores}`,
        '--pids-limit', `${this.containerSpec.resource_limits.pids_max}`,
        '-v', `${this.projectRoot}:/sle/project:ro`,
      ];

      for (const m of this.containerSpec.mount_points) {
        args.push('-v', `${m.host_path}:${m.container_path}:${m.read_only ? 'ro' : 'rw'}`);
      }

      args.push(this.containerSpec.image, 'tail', '-f', '/dev/null');

      const spawned = await this.execCommand('docker', args);
      if (spawned.exitCode !== 0) {
        worker.status = 'dead';
        worker.total_errors++;
        console.error(`Failed to start Docker container for worker ${workerId}: ${spawned.stderr}`);
      } else {
        worker.container_id = containerName;
        if (this.containerSpec.install_command) {
          await this.execCommand('docker', ['exec', containerName, 'sh', '-c', this.containerSpec.install_command]);
        }
      }
    }

    this.workers.push(worker);
    this.workerLastActive.set(workerId, Date.now());
    await this.updateDispatchState();
    return worker;
  }

  private async destroyWorker(workerId: string): Promise<void> {
    const workerIndex = this.workers.findIndex((w) => w.id === workerId);
    if (workerIndex === -1) return;
    const worker = this.workers[workerIndex];

    if (worker.container_id) {
      await this.execCommand('docker', ['rm', '-f', worker.container_id]);
    }
    this.workers.splice(workerIndex, 1);
    this.workerLastActive.delete(workerId);
    await this.updateDispatchState();
  }

  private async scaleUpWorkers(): Promise<void> {
    const activeWorkers = this.workers.filter((w) => w.status !== 'dead' && w.status !== 'draining');
    const queuedCount = this.queue.getAllJobs().filter((j) => j.status === 'queued').length;

    if (queuedCount > 0 && activeWorkers.length < this.config.max_workers) {
      await this.spawnWorker();
    }
  }

  private async scaleDownIdleWorkers(): Promise<void> {
    const now = Date.now();
    const activeWorkers = this.workers.filter((w) => w.status !== 'dead' && w.status !== 'draining');

    for (const worker of activeWorkers) {
      if (worker.status === 'idle') {
        const lastActive = this.workerLastActive.get(worker.id) ?? now;
        const idleTime = now - lastActive;
        if (idleTime > this.config.idle_timeout_ms && activeWorkers.length > this.config.min_workers) {
          worker.status = 'draining';
          await this.destroyWorker(worker.id);
        }
      }
    }
  }

  private async checkHeartbeats(): Promise<void> {
    const now = Date.now();
    for (const worker of this.workers) {
      if (worker.status === 'dead') continue;

      let alive = false;
      if (this.useFallback) {
        alive = true;
      } else if (worker.container_id) {
        const inspect = await this.execCommand('docker', ['inspect', '-f', '{{.State.Running}}', worker.container_id]);
        alive = inspect.exitCode === 0 && inspect.stdout.trim() === 'true';
      }

      if (alive) {
        worker.last_heartbeat = new Date().toISOString();
      } else {
        const lastHbTime = new Date(worker.last_heartbeat).getTime();
        const missedMs = now - lastHbTime;
        if (missedMs > this.config.heartbeat_interval_ms * this.config.max_heartbeat_misses) {
          worker.status = 'dead';
          if (worker.current_job_id) {
            const job = this.queue.getJob(worker.current_job_id);
            if (job) {
              const errorMsg = 'Worker process or container died unexpectedly';
              this.queue.updateJobStatus(job.id, 'failed', {
                error: {
                  code: 'docker_unavailable',
                  message: errorMsg,
                  recoverable: true,
                  container_exit_code: null,
                  docker_error: errorMsg,
                  retry_count: (job.error?.retry_count ?? 0) + 1,
                },
              });
              const maxRetries = 2;
              if ((job.error?.retry_count ?? 0) < maxRetries) {
                job.status = 'queued';
              }
            }
          }
          await this.replaceDeadWorkers();
        }
      }
    }
  }

  private async replaceDeadWorkers(): Promise<void> {
    const activeWorkers = this.workers.filter((w) => w.status !== 'dead');
    if (activeWorkers.length < this.config.min_workers) {
      await this.spawnWorker();
    }
  }

  private async runJobInWorker(worker: Worker, job: Job): Promise<void> {
    const startTime = Date.now();
    const runId = job.run_id;

    const runDir = path.join(this.projectRoot, '.sle', 'runs', `${job.cycle_id}-${job.iteration}`);
    const jobDir = path.join(runDir, 'tests', job.category ?? 'static-check');
    await fs.mkdir(jobDir, { recursive: true });

    // Step 0: Write per-job context file
    const validationConfig = await this.loadValidationConfig();
    const categoryConfig = validationConfig?.categories?.find((c: any) => c.name === job.category) || null;
    const passCriteria = categoryConfig?.pass_criteria || {};

    const jobContext = {
      job_id: job.id,
      sub_phase: job.sub_phase ?? job.type,
      category: job.category,
      validation_config: categoryConfig,
      pass_criteria: passCriteria,
      expected_output_format: 'json',
    };

    await fs.writeFile(
      path.join(runDir, '.sle-job-context.json'),
      JSON.stringify(jobContext, null, 2),
      'utf-8'
    );

    let command = '';
    let timeoutMs = 120000;

    if (job.type === 'static-check') {
      const lintCmd = validationConfig?.static_analysis?.lint?.command || 'npm run lint';
      const typecheckCmd = validationConfig?.static_analysis?.typecheck?.command || 'npm run type-check';
      command = `${typecheckCmd} && ${lintCmd}`;
      timeoutMs = validationConfig?.static_analysis?.timeout_ms ?? 120000;
    } else {
      command = categoryConfig?.executable?.runner || `npm test`;
      timeoutMs = categoryConfig?.executable?.timeout_ms ?? 120000;
    }

    const map = await this.loadMap();
    if (map?.exec?.command) {
      command = map.exec.command;
      timeoutMs = map.exec.timeout_ms ?? timeoutMs;
    }

    let exitCode = 0;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let dockerError: string | null = null;

    try {
      if (this.useFallback) {
        const result = await this.spawnCommandOnHost(command, this.projectRoot, timeoutMs);
        exitCode = result.exitCode;
        stdout = result.stdout;
        stderr = result.stderr;
        timedOut = result.timedOut;
      } else {
        const containerName = worker.container_id!;
        const envArgs: string[] = [];
        const envVars = {
          SLE_RUN_DIR: '/sle/run',
          SLE_RUN_ID: runId,
          SLE_CYCLE: String(job.cycle_id),
          SLE_ITERATION: String(job.iteration),
          SLE_CATEGORY: job.category ?? 'static-check',
          SLE_SUB_PHASE: job.sub_phase ?? job.type,
          SLE_PROJECT_ROOT: '/sle/project',
          SLE_SCRIPTS_DIR: '/sle/scripts',
          SLE_TIMEOUT_MS: String(timeoutMs),
          ...this.containerSpec.env,
        };

        for (const [k, v] of Object.entries(envVars)) {
          envArgs.push('-e', `${k}=${v}`);
        }

        const args = [
          'exec',
          ...envArgs,
          containerName,
          'sh', '-c', command
        ];

        const result = await this.execCommand('docker', args, timeoutMs);
        exitCode = result.exitCode;
        stdout = result.stdout;
        stderr = result.stderr;
        timedOut = result.timedOut;
        if (result.error) {
          dockerError = result.error.message;
        }
      }
    } catch (err: any) {
      exitCode = 1;
      stderr = err.message || String(err);
    }

    const durationMs = Date.now() - startTime;

    // ─── 7-Step Extraction ───
    
    // Step 1 & 2: exitCode and capture logs
    const truncatedStdout = truncate(stdout);
    const truncatedStderr = truncate(stderr);
    await fs.writeFile(path.join(jobDir, '.sle-stdout.log'), stdout, 'utf-8');
    await fs.writeFile(path.join(jobDir, '.sle-stderr.log'), stderr, 'utf-8');

    // Step 3: Capture structured result
    let structuredResult: any = null;
    let parseFailed = false;
    const resultJsonPath = path.join(jobDir, 'result.json');

    try {
      const resultJsonContent = await fs.readFile(resultJsonPath, 'utf-8');
      structuredResult = JSON.parse(resultJsonContent);
    } catch {
      parseFailed = true;
    }

    // Step 4: Capture additional artifacts
    const artifacts: Record<string, string> = {};
    if (structuredResult?.artifacts) {
      Object.assign(artifacts, structuredResult.artifacts);
    }

    // Step 5: Capture metrics
    const metrics: Record<string, number> = {};
    if (structuredResult?.metrics) {
      Object.assign(metrics, structuredResult.metrics);
    }
    if (!this.useFallback && worker.container_id) {
      const stats = await this.execCommand('docker', ['stats', '--no-stream', '--format', '{{.MemUsage}}', worker.container_id]);
      if (stats.exitCode === 0) {
        const match = stats.stdout.match(/^([0-9.]+)([a-zA-Z]+)/);
        if (match) {
          metrics['peak_memory_mb'] = parseFloat(match[1]);
        }
      }
    }

    // Step 6: Write JobResult
    const jobResult: JobResult = {
      exit_code: exitCode,
      stdout: truncatedStdout,
      stderr: truncatedStderr,
      artifacts,
      duration_ms: durationMs,
      metrics,
    };

    await fs.writeFile(
      path.join(jobDir, '.sle-job-result.json'),
      JSON.stringify(jobResult, null, 2),
      'utf-8'
    );

    // Step 7: Update job status
    let jobError: JobError | null = null;
    if (timedOut) {
      jobError = {
        code: 'container_timeout',
        message: `Execution timed out after ${timeoutMs}ms`,
        recoverable: false,
        container_exit_code: null,
        docker_error: dockerError,
        retry_count: (job.error?.retry_count ?? 0) + 1,
      };
    } else if (exitCode !== 0) {
      jobError = {
        code: parseFailed ? 'result_parse_failed' : 'unknown',
        message: `Command exited with non-zero code ${exitCode}`,
        recoverable: true,
        container_exit_code: exitCode,
        docker_error: dockerError,
        retry_count: (job.error?.retry_count ?? 0) + 1,
      };
    } else if (parseFailed && job.type !== 'static-check') {
      jobError = {
        code: 'result_parse_failed',
        message: `Structured result.json missing or invalid`,
        recoverable: true,
        container_exit_code: 0,
        docker_error: null,
        retry_count: (job.error?.retry_count ?? 0) + 1,
      };
    }

    const finalStatus: JobStatus = jobError ? 'failed' : 'completed';
    this.queue.updateJobStatus(job.id, finalStatus, {
      result: jobResult,
      error: jobError,
      completed_at: new Date().toISOString(),
    });

    worker.status = 'idle';
    worker.current_job_id = null;
    worker.total_jobs_completed++;
    if (jobError) {
      worker.total_errors++;
    }
    this.workerLastActive.set(worker.id, Date.now());

    await this.updateDispatchState(false, true);
    await this.dispatchJobs();
  }

  private async execCommand(
    cmd: string,
    args: string[],
    timeoutMs: number = 30000
  ): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean; error?: Error }> {
    return new Promise((resolve) => {
      const child = this.spawnFn(cmd, args, { shell: false });
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });

      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({ exitCode: 1, stdout, stderr, timedOut, error });
      });

      child.on('close', (exitCode) => {
        clearTimeout(timer);
        resolve({ exitCode: exitCode ?? 1, stdout, stderr, timedOut });
      });
    });
  }

  private async spawnCommandOnHost(
    command: string,
    cwd: string,
    timeoutMs: number
  ): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
    return new Promise((resolve) => {
      const [cmd, ...args] = command.split(/\s+/);
      const child = this.spawnFn(cmd, args, {
        cwd,
        env: { ...process.env, PATH: process.env.PATH ?? '/usr/bin:/bin' },
        shell: false,
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });

      child.on('error', () => {
        clearTimeout(timer);
        resolve({ exitCode: 1, stdout, stderr, timedOut: false });
      });

      child.on('close', (exitCode) => {
        clearTimeout(timer);
        resolve({ exitCode: exitCode ?? 1, stdout, stderr, timedOut });
      });
    });
  }

  private async isDockerAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const child = this.spawnFn('docker', ['info'], { stdio: 'ignore' });
      child.on('close', (code) => {
        resolve(code === 0);
      });
      child.on('error', () => {
        resolve(false);
      });
    });
  }

  private async cleanupOrphanedContainers(): Promise<void> {
    return new Promise((resolve) => {
      const child = this.spawnFn('docker', ['ps', '-a', '--filter', 'label=sle-worker=true', '-q'], { shell: false });
      let output = '';
      child.stdout?.on('data', (chunk) => { output += chunk.toString(); });
      child.on('close', (code) => {
        if (code === 0 && output.trim()) {
          const ids = output.trim().split(/\s+/);
          this.spawnFn('docker', ['rm', '-f', ...ids], { shell: false }).on('close', () => resolve());
        } else {
          resolve();
        }
      });
      child.on('error', () => resolve());
    });
  }

  private async loadValidationConfig(): Promise<any> {
    try {
      const filePath = path.join(this.projectRoot, '.sle', 'rules', 'validation.yaml');
      const content = await fs.readFile(filePath, 'utf-8');
      return parseYAML(content);
    } catch {
      return null;
    }
  }

  private async loadMap(): Promise<any> {
    try {
      const filePath = path.join(this.projectRoot, '.sle', 'map.yaml');
      const content = await fs.readFile(filePath, 'utf-8');
      return parseYAML(content);
    } catch {
      return null;
    }
  }

  private async updateDispatchState(activeChange: boolean = false, collectChange: boolean = false): Promise<void> {
    if (!this.mapManager) return;

    const activeJobs = this.workers.filter((w) => w.status === 'busy').length;
    const queuedJobs = this.queue.getAllJobs().filter((j) => j.status === 'queued').length;
    const workerErrors = this.workers.reduce((acc, w) => acc + w.total_errors, 0);

    await this.mapManager.update((m) => {
      const dispatchState: JobDispatchState = {
        pool_size: this.workers.length,
        active_jobs: activeJobs,
        queued_jobs: queuedJobs,
        last_dispatch_at: activeChange ? new Date().toISOString() : ((m as any).dispatch?.last_dispatch_at ?? null),
        last_collect_at: collectChange ? new Date().toISOString() : ((m as any).dispatch?.last_collect_at ?? null),
        worker_errors: workerErrors,
      };

      return {
        ...m,
        dispatch: dispatchState,
      };
    });
  }
}

// ─── ExecServiceReal ──────────────────────────────────────────────────────────

export class ExecServiceReal {
  constructor(
    private mapManager: RuntimeMapManager,
    private runArtifacts: RunArtifactManager,
    private projectRoot: string,
    private spawnFn: SpawnFn = nodeSpawn
  ) {}

  async run(workflowRunId: string, iteration: number): Promise<ExecResult> {
    const map = await this.mapManager.read();
    const execConfig = (map as unknown as Record<string, unknown>).exec as { command?: string; timeout_ms?: number } | undefined;
    const command = execConfig?.command
      ?? (map.meta as { exec_command?: string }).exec_command;

    // No command configured → no-op success
    if (!command) {
      await this.runArtifacts.updateNodeStatus(workflowRunId, iteration, 'EXEC', {
        status: 'complete',
        exit_code: 0,
        timed_out: false,
      } as never);
      await this.mapManager.update((m) => {
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



    await this.runArtifacts.updateNodeStatus(workflowRunId, iteration, 'EXEC', {
      status: 'running',
      started_at: new Date().toISOString(),
    } as never);

    const queue = new JobQueue();
    const runId = workflowRunId;

    // Enqueue static check
    const staticJob = queue.enqueue({
      type: 'static-check',
      priority: 0,
      cycle_id: workflowRunId,
      iteration,
      run_id: runId,
      category: null,
      sub_phase: 'static-check',
    });

    // Start pool
    const pool = new DockerWorkerPool(queue, this.projectRoot, this.mapManager, {}, {}, this.spawnFn);
    await pool.start();

    // Trigger initial dispatch
    await pool.dispatchJobs();

    // Await static-check completion
    while (staticJob.status !== 'completed' && staticJob.status !== 'failed' && staticJob.status !== 'timed_out' && staticJob.status !== 'cancelled') {
      await new Promise((r) => setTimeout(r, 100));
    }

    if (staticJob.status === 'completed') {
      const categories = (map as any).validation?.categories?.map((c: any) => c.name) || ['correctness', 'performance', 'security'];
      const activeJobs: Job[] = [];

      for (const cat of categories) {
        const execJob = queue.enqueue({
          type: 'exec-check',
          priority: 1,
          cycle_id: workflowRunId,
          iteration,
          run_id: runId,
          category: cat,
          sub_phase: 'exec-check',
        });
        const llmJob = queue.enqueue({
          type: 'llm-check',
          priority: 2,
          cycle_id: workflowRunId,
          iteration,
          run_id: runId,
          category: cat,
          sub_phase: 'llm-check',
        });
        activeJobs.push(execJob, llmJob);
      }

      await pool.dispatchJobs();

      while (activeJobs.some((j) => j.status === 'queued' || j.status === 'preparing' || j.status === 'running' || j.status === 'collecting')) {
        await new Promise((r) => setTimeout(r, 100));
      }
    } else {
      queue.cancelJobsForIteration(runId, iteration);
    }

    await pool.stop();

    const allJobs = queue.getAllJobs().filter((j) => j.run_id === runId);
    const passedCategories: string[] = [];
    const failedCategories: string[] = [];
    const categoriesMap: Record<string, string> = {};

    for (const job of allJobs) {
      if (!job.category) continue;
      if (job.status === 'completed') {
        categoriesMap[job.category] = 'passed';
        if (!passedCategories.includes(job.category)) passedCategories.push(job.category);
      } else if (job.status === 'failed' || job.status === 'timed_out') {
        categoriesMap[job.category] = 'failed';
        if (!failedCategories.includes(job.category)) failedCategories.push(job.category);
      } else if (job.status === 'cancelled') {
        categoriesMap[job.category] = 'skipped';
      }
    }

    const testSummary = {
      run_id: runId,
      outcome: failedCategories.length === 0 && staticJob.status === 'completed' ? 'passed' : 'failed',
      passed_count: passedCategories.length,
      failed_count: failedCategories.length,
      total_count: passedCategories.length + failedCategories.length,
      categories: categoriesMap,
    };

    const runDir = path.join(this.projectRoot, '.sle', 'runs', runId, String(iteration));
    await fs.mkdir(path.join(runDir, 'tests'), { recursive: true });
    await fs.writeFile(
      path.join(runDir, 'tests', 'summary.json'),
      JSON.stringify(testSummary, null, 2),
      'utf-8'
    );

    const success = staticJob.status === 'completed' && failedCategories.length === 0;

    await this.mapManager.update((m) => {
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
                exec_result: { exit_code: success ? 0 : 1, timed_out: staticJob.status === 'timed_out' },
              }
            : undefined,
        },
      };
    });

    if (!success) {
      const failedCats: FailureCategory[] = [];
      if (staticJob.status !== 'completed') {
        failedCats.push({
          name: 'static-check',
          method: 'executable',
          error_summary: staticJob.status === 'timed_out'
            ? `static-check timed out`
            : `static-check failed with exit code ${staticJob.result?.exit_code ?? 1}`,
          test_output: staticJob.result?.stderr || staticJob.result?.stdout || 'No static analysis logs available',
        });
      }
      for (const cat of failedCategories) {
        const jobsForCat = allJobs.filter((j) => j.category === cat);
        const errSum = jobsForCat
          .map((j) => j.error?.message)
          .filter(Boolean)
          .join(', ');
        const testOut = jobsForCat
          .map((j) => (j.result?.stderr || j.result?.stdout || ''))
          .filter(Boolean)
          .join('\n');

        failedCats.push({
          name: cat,
          method: 'executable',
          error_summary: errSum || `Category ${cat} failed`,
          test_output: testOut || `Category ${cat} failed execution`,
        });
      }

      await this.runArtifacts.writeFailureReport(workflowRunId, iteration, {
        cycle: 0,
        iteration,
        run_dir: `.sle/runs/${workflowRunId}/${iteration}`,
        run_id: runId,
        quick_summary: staticJob.status !== 'completed' ? 'Static check failed' : `${failedCategories.length} validation categories failed`,
        failed_categories: failedCats,
        passed_categories: passedCategories,
      } as any);

      await this.runArtifacts.updateNodeStatus(workflowRunId, iteration, 'EXEC', {
        status: 'failed',
        exit_code: 1,
        timed_out: staticJob.status === 'timed_out',
      } as never);
    } else {
      await this.runArtifacts.updateNodeStatus(workflowRunId, iteration, 'EXEC', {
        status: 'complete',
        exit_code: 0,
        timed_out: false,
      } as never);
    }

    return {
      next_node: 'VALIDATION_GATE',
      exit_code: success ? 0 : 1,
      stdout: staticJob.result?.stdout || '',
      stderr: staticJob.result?.stderr || '',
      timed_out: staticJob.status === 'timed_out',
      success,
    };
  }
}
