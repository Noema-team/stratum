import { spawn } from 'child_process';
import type { ExecutionAdapter, ExecutionRequest, ExecutionResult, CapabilitySet, ExecutorCapability } from './types.js';

const CLAUDE_CODE_CAPABILITIES: ReadonlySet<ExecutorCapability> = new Set<ExecutorCapability>([
  'repo.read',
  'repo.write',
  'shell',
  'tests.run',
  'long_context',
  'structured_output',
]);

export interface ClaudeCodeAdapterOptions {
  // Path to the claude CLI binary. Defaults to 'claude' (resolved via PATH).
  binaryPath?: string;
  // Working directory for the subprocess. Defaults to process.cwd().
  cwd?: string;
  // Timeout in ms. Defaults to budget.maxRuntimeMs or 300_000 (5 min).
  defaultTimeoutMs?: number;
  // Additional CLI flags appended after --print.
  extraFlags?: string[];
}

// ClaudeCodeAdapter executes a WorkItem by running the `claude --print` CLI
// as a subprocess, piping the goal + acceptance criteria as the initial prompt.
// It is the second ExecutionAdapter beside StratumAgentAdapter, satisfying
// DDR-032 §37 criterion 13 and Phase 5 exit criterion.
export class ClaudeCodeAdapter implements ExecutionAdapter {
  readonly id = 'claude-code';

  private readonly binary: string;
  private readonly cwd: string;
  private readonly defaultTimeoutMs: number;
  private readonly extraFlags: string[];

  constructor(opts: ClaudeCodeAdapterOptions = {}) {
    this.binary = opts.binaryPath ?? 'claude';
    this.cwd = opts.cwd ?? process.cwd();
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 300_000;
    this.extraFlags = opts.extraFlags ?? [];
  }

  getCapabilities(): CapabilitySet {
    return CLAUDE_CODE_CAPABILITIES;
  }

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const start = Date.now();
    const timeoutMs = request.budget.maxRuntimeMs ?? this.defaultTimeoutMs;

    const prompt = buildPrompt(request);

    let stdout = '';
    let stderr = '';
    let outcome: ExecutionResult['outcome'] = 'failed';
    let failure: ExecutionResult['failure'] | undefined;

    try {
      const { code, out, err } = await runProcess(
        this.binary,
        ['--print', ...this.extraFlags],
        prompt,
        this.cwd,
        timeoutMs,
      );

      stdout = out;
      stderr = err;

      if (code === 0) {
        outcome = 'succeeded';
      } else {
        failure = { code: 'nonzero_exit', message: `claude exited with code ${code}`, details: { stderr: stderr.slice(0, 2000) } };
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      failure = { code: 'spawn_error', message: msg };
    }

    return {
      schemaVersion: 1,
      stepExecutionId: request.stepExecutionId,
      outcome,
      artifacts: [],
      evidenceClaims: outcome === 'succeeded'
        ? [{ type: 'agent_output', source: 'claude-code', status: 'passed', payload: { summary: stdout.slice(0, 500) } }]
        : [],
      decisionRequests: [],
      usage: { durationMs: Date.now() - start },
      failure,
    };
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function buildPrompt(req: ExecutionRequest): string {
  const lines: string[] = [
    `# Task`,
    req.goal,
    '',
  ];

  if (req.acceptanceCriteria.length) {
    lines.push('## Acceptance criteria');
    for (const ac of req.acceptanceCriteria) {
      lines.push(`- ${ac.description}`);
    }
    lines.push('');
  }

  if (req.constraints.length) {
    lines.push('## Constraints');
    for (const c of req.constraints) {
      lines.push(`- ${c.description}`);
    }
    lines.push('');
  }

  if (!req.permissions.pushBranch) {
    lines.push('Do not push to any remote branch.');
  }

  return lines.join('\n');
}

function runProcess(
  binary: string,
  args: string[],
  stdin: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });

    let out = '';
    let err = '';
    child.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { err += d.toString(); });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`claude-code timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => { clearTimeout(timer); resolve({ code: code ?? 1, out, err }); });

    child.stdin?.end(stdin, 'utf8');
  });
}
