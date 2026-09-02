import { promises as nodeFsPromises } from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'node:crypto';
import yaml from 'js-yaml';
import type { AgentRole, AssembledContext } from './types.js';
import type { ContextManager } from './context-manager.js';
import type { ILLMProvider, LLMCompletionParams } from './llm-provider.js';
import type { RunArtifactManager } from './run-artifacts.js';
import type { StepRunContext } from './workflow/types.js';
import type { ArtifactRepository } from './storage/repositories.js';
import { AgentLoop } from './agent-loop.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AgentRunResult {
  success: boolean;
  artifacts_written: string[];
  tokens_used: number;
  duration_ms: number;
  raw_output_path: string;
  error?: string;
}

export interface SLEOutputPreamble {
  role: string;
  node: string;
  artifacts: Array<{ id: string; path: string }>;
}

export interface ParsedOutput {
  preamble: SLEOutputPreamble;
  sections: Array<{ path: string; content: string }>;
}

// ─── Write-path validation (DDR-019) ─────────────────────────────────────────

// Roles with no entry (builder, explorer, debugger) may write to any path.
// Entries ending with '/' are prefix matches (any path under that directory).
const ROLE_OUTPUT_PATHS: Partial<Record<AgentRole, string[]>> = {
  facilitator: ['docs/cycle-charter.md'],
  designer:    ['docs/requirements.md', 'docs/architecture.md'],
  planner:     ['docs/plan.md', 'docs/test-plan.md'],
  tester:      ['docs/test-plan.md', '.sle/runs/'],
  historian:   ['docs/decisions.md', 'docs/cycle-summary.md'],
  evaluator:   ['docs/evaluation.md'],
  critic:      ['docs/critique.md', 'docs/cycle-critique.md', 'docs/critique-report.md'],
  // Debugger can write source code (fixing implementation bugs)
  debugger:    ['src/', 'tests/', 'scripts/', '.sle/runs/'],
  // D.1b — conservative ceiling for declarative-artifact steps (see
  // define-work in Milestone D). No full-build/draft-artifact step uses the
  // explorer role today, so this closes a fail-open gap (an absent table
  // entry previously meant unrestricted writes) without touching any
  // legacy role's behavior. A declared outputArtifact.path must still fall
  // within this ceiling — it narrows further, it never grants more.
  explorer:    ['.sle/work/'],
};

// Builder can write anywhere except system dirs and docs (which belong to agent roles).
const BUILDER_DENY_PREFIXES = ['.sle/', 'docs/'];

export function validateOutputPath(filePath: string, role: AgentRole): boolean {
  if (role === 'builder') {
    return !BUILDER_DENY_PREFIXES.some((prefix) => filePath.startsWith(prefix));
  }
  const allowed = ROLE_OUTPUT_PATHS[role];
  if (!allowed) return true;
  return allowed.some((p) => (p.endsWith('/') ? filePath.startsWith(p) : filePath === p));
}

// D.1b — path-traversal guard, checked before any filesystem mutation for
// every write (legacy and declared). Rejects absolute paths and any `..`
// segment that would escape projectRoot, regardless of separator style.
export function isSafeRelativePath(projectRoot: string, relPath: string): boolean {
  if (!relPath || path.isAbsolute(relPath)) return false;
  const rootResolved = path.resolve(projectRoot);
  const resolved = path.resolve(rootResolved, relPath);
  return resolved === rootResolved || resolved.startsWith(rootResolved + path.sep);
}

// Paths where new content is appended after existing content (not overwritten).
// decisions.md accumulates entries across cycles; all other artifacts are overwritten.
export const APPEND_ONLY_PATHS = new Set(['docs/decisions.md']);

// ─── Context → LLM message ────────────────────────────────────────────────────

export function buildUserMessage(context: AssembledContext): string {
  const parts: string[] = [context.state_summary, '', context.task];

  if (context.failure_context) {
    parts.push('', context.failure_context);
  }

  const sliceKeys = Object.keys(context.artifact_slices);
  if (sliceKeys.length > 0) {
    parts.push('', '## Relevant Artifacts');
    for (const [id, content] of Object.entries(context.artifact_slices)) {
      parts.push('', `### ${id}`, '', content);
    }
  }

  return parts.join('\n');
}

// ─── Output parsing ───────────────────────────────────────────────────────────

export function parseAgentOutput(raw: string, role: AgentRole): ParsedOutput {
  const preambleMatch = raw.match(/<!--\s*SLE-OUTPUT([\s\S]*?)-->/);
  if (!preambleMatch) {
    throw new Error('Missing SLE-OUTPUT preamble comment');
  }

  const preamble = yaml.load(preambleMatch[1].trim()) as SLEOutputPreamble;
  if (!preamble?.artifacts || !Array.isArray(preamble.artifacts)) {
    throw new Error('SLE-OUTPUT preamble missing artifacts list');
  }

  const afterPreamble = raw.slice(raw.indexOf('-->') + 3).trim();
  const sections =
    role === 'builder'
      ? parseBuilderSections(afterPreamble)
      : parseStandardSections(afterPreamble, preamble);

  return { preamble, sections };
}

function parseStandardSections(
  body: string,
  preamble: SLEOutputPreamble
): Array<{ path: string; content: string }> {
  const rawSections = body.split(/\n---+\n/);
  const results: Array<{ path: string; content: string }> = [];

  for (const raw of rawSections) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    const lines = trimmed.split('\n');
    const headerMatch = lines[0].trim().match(/^##\s+(.+)$/);
    if (!headerMatch) continue;

    const headerPath = headerMatch[1].trim();
    const artifact = preamble.artifacts.find(
      (a) => a.path === headerPath || a.path.endsWith(headerPath) || headerPath.endsWith(a.path)
    );
    if (!artifact) continue;

    results.push({ path: artifact.path, content: lines.slice(1).join('\n').trim() });
  }

  // Fallback: positional matching when headers don't match declared paths
  if (results.length === 0 && preamble.artifacts.length > 0) {
    const nonEmpty = rawSections.filter((s) => s.trim());
    for (let i = 0; i < Math.min(nonEmpty.length, preamble.artifacts.length); i++) {
      const lines = nonEmpty[i].trim().split('\n');
      const skip = lines[0].trim().startsWith('#') ? 1 : 0;
      results.push({
        path: preamble.artifacts[i].path,
        content: lines.slice(skip).join('\n').trim(),
      });
    }
  }

  return results;
}

function parseBuilderSections(body: string): Array<{ path: string; content: string }> {
  const results: Array<{ path: string; content: string }> = [];
  const fileHeaderRegex = /^## File:\s+(.+)$/gm;
  const matches: Array<{ filePath: string; headerStart: number; contentStart: number }> = [];

  let m: RegExpExecArray | null;
  while ((m = fileHeaderRegex.exec(body)) !== null) {
    matches.push({
      filePath: m[1].trim(),
      headerStart: m.index,
      contentStart: m.index + m[0].length,
    });
  }

  for (let i = 0; i < matches.length; i++) {
    const { filePath, contentStart } = matches[i];
    const nextStart = i + 1 < matches.length ? matches[i + 1].headerStart : body.length;
    const rawBlock = body.slice(contentStart, nextStart).trim();

    const fenceMatch = rawBlock.match(/^```(?:\w+)?\n([\s\S]*?)\n?```\s*$/);
    results.push({ path: filePath, content: fenceMatch ? fenceMatch[1] : rawBlock });
  }

  return results;
}

// ─── AgentRunner ──────────────────────────────────────────────────────────────

export interface AgentRunnerConfig {
  model: string;
  temperature?: number;
  max_tokens?: number;
}

const RUNNER_DEFAULTS: Required<Omit<AgentRunnerConfig, 'model'>> = {
  temperature: 0.7,
  max_tokens: 4096,
};

export class AgentRunner {
  private fs: typeof import('fs').promises;

  constructor(
    private contextManager: ContextManager,
    private llmProvider: ILLMProvider,
    private projectRoot: string,
    private runArtifacts: RunArtifactManager,
    private runnerConfig: AgentRunnerConfig = { model: 'default' },
    fsModule?: typeof import('fs').promises,
    // D.1b — optional so existing construction sites/tests are unaffected.
    // When present, a step with a declared outputArtifact gets its provenance
    // recorded here (idempotently) after a successful write.
    private artifactRepository?: ArtifactRepository,
  ) {
    this.fs = fsModule ?? nodeFsPromises;
  }

  async run(role: AgentRole, ctx: StepRunContext): Promise<AgentRunResult> {
    const start = Date.now();

    // 1. Assemble context
    const context = await this.contextManager.assemble(role, ctx);

    let parsed: { sections: Array<{ path: string; content: string }> };
    let tokensUsed = 0;
    let rawPath = '';

    const nodeId = ctx.stepId ?? role.toUpperCase();

    // Check if the provider supports native multi-turn execution (DDR-030 integration)
    const isMultiTurn = typeof (this.llmProvider as any).completeMultiTurn === 'function';

    if (isMultiTurn) {
      const loop = new AgentLoop(
        this.llmProvider as any,
        {
          model: this.runnerConfig.model,
          max_tokens: this.runnerConfig.max_tokens,
          projectRoot: this.projectRoot,
          role,
          workflowRunId: ctx.workflowRunId,
          iteration: ctx.iteration,
          nodeId,
          runArtifacts: this.runArtifacts,
          fsModule: this.fs,
        }
      );

      const systemPrompt = context.system_prompt || 'You are a helpful software engineering assistant.';
      const userMessage = buildUserMessage(context);

      const loopResult = await loop.run(systemPrompt, userMessage);
      tokensUsed = loopResult.tokens_used;

      if (!loopResult.success) {
        rawPath = await this.writeRaw(ctx, nodeId, '');
        return {
          success: false,
          artifacts_written: [],
          tokens_used: tokensUsed,
          duration_ms: Date.now() - start,
          raw_output_path: rawPath,
          error: loopResult.error,
        };
      }

      parsed = loopResult.parsedOutput!;
      // Write the final text as raw output (always, even on multi-turn success)
      rawPath = await this.writeRaw(ctx, nodeId, loopResult.rawText || '');

    } else {
      // Single-turn fallback (original logic)
      const params: LLMCompletionParams = {
        model: this.runnerConfig.model,
        messages: [
          {
            role: 'system',
            content: context.system_prompt || 'You are a helpful software engineering assistant.',
          },
          { role: 'user', content: buildUserMessage(context) },
        ],
        temperature: this.runnerConfig.temperature ?? RUNNER_DEFAULTS.temperature,
        max_tokens: this.runnerConfig.max_tokens ?? RUNNER_DEFAULTS.max_tokens,
      };

      let llmResult;
      try {
        llmResult = await this.llmProvider.complete(params);
      } catch (err) {
        rawPath = await this.writeRaw(ctx, nodeId, '');
        return {
          success: false,
          artifacts_written: [],
          tokens_used: 0,
          duration_ms: Date.now() - start,
          raw_output_path: rawPath,
          error: `LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      tokensUsed = llmResult.tokens_used;
      rawPath = await this.writeRaw(ctx, nodeId, llmResult.content);

      try {
        parsed = parseAgentOutput(llmResult.content, role);
      } catch (err) {
        return {
          success: false,
          artifacts_written: [],
          tokens_used: tokensUsed,
          duration_ms: Date.now() - start,
          raw_output_path: rawPath,
          error: `Output parsing failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    // 6a. D.1b — a declared output narrows what may be written: exactly one
    // section, at exactly the declared path. Checked before any path-safety/
    // role/filesystem work below, and before any filesystem mutation.
    if (ctx.outputArtifact) {
      const declaredPath = ctx.outputArtifact.path;
      if (!isSafeRelativePath(this.projectRoot, declaredPath)) {
        return {
          success: false,
          artifacts_written: [],
          tokens_used: tokensUsed,
          duration_ms: Date.now() - start,
          raw_output_path: rawPath,
          error: `Declared output path '${declaredPath}' is not a safe project-root-relative path`,
        };
      }
      if (parsed.sections.length !== 1) {
        return {
          success: false,
          artifacts_written: [],
          tokens_used: tokensUsed,
          duration_ms: Date.now() - start,
          raw_output_path: rawPath,
          error: `Step declares exactly one output artifact ('${declaredPath}') but produced ${parsed.sections.length} section(s)`,
        };
      }
      const normalizedDeclared = path.posix.normalize(declaredPath);
      const normalizedActual = path.posix.normalize(parsed.sections[0].path);
      if (normalizedActual !== normalizedDeclared) {
        return {
          success: false,
          artifacts_written: [],
          tokens_used: tokensUsed,
          duration_ms: Date.now() - start,
          raw_output_path: rawPath,
          error: `Step declared output '${declaredPath}' but produced '${parsed.sections[0].path}'`,
        };
      }
    }

    // 6b. Validate write paths: path-traversal safety, then the role's
    // broad ceiling (DDR-019). A declared output only NARROWS §6a above —
    // it never bypasses this check, so the declared path must also fall
    // within the role's ROLE_OUTPUT_PATHS ceiling.
    for (const section of parsed.sections) {
      if (!isSafeRelativePath(this.projectRoot, section.path)) {
        return {
          success: false,
          artifacts_written: [],
          tokens_used: tokensUsed,
          duration_ms: Date.now() - start,
          raw_output_path: rawPath,
          error: `Unsafe output path '${section.path}'`,
        };
      }
      if (!validateOutputPath(section.path, role)) {
        return {
          success: false,
          artifacts_written: [],
          tokens_used: tokensUsed,
          duration_ms: Date.now() - start,
          raw_output_path: rawPath,
          error: `Role '${role}' is not permitted to write '${section.path}'`,
        };
      }
    }

    // 7. Write artifacts
    const artifactsWritten: string[] = [];
    for (const section of parsed.sections) {
      const filePath = path.join(this.projectRoot, section.path);
      await this.fs.mkdir(path.dirname(filePath), { recursive: true });
      if (APPEND_ONLY_PATHS.has(section.path)) {
        await this.fs.appendFile(filePath, section.content, 'utf-8');
      } else {
        await this.fs.writeFile(filePath, section.content, 'utf-8');
      }
      artifactsWritten.push(section.path);
    }

    // 8. D.1b — record provenance for a declared output, exactly once.
    // stepExecutionId is deliberately left unset: the Scheduler creates one
    // outer StepExecution per adapter invocation, not one per WorkflowStep,
    // so there is no naturally-available per-step id here yet (see
    // docs/developmentPlan/d1a-declarative-contract-spike.md §4).
    if (ctx.outputArtifact && this.artifactRepository) {
      const already = this.artifactRepository.findByWorkflowRunAndRef(
        ctx.workflowRunId,
        ctx.outputArtifact.ref
      );
      if (!already) {
        this.artifactRepository.save({
          id: randomUUID(),
          workItemId: ctx.workItemId,
          workflowRunId: ctx.workflowRunId,
          type: ctx.outputArtifact.type,
          ref: ctx.outputArtifact.ref,
          path: artifactsWritten[0],
          hash: createHash('sha256').update(parsed.sections[0].content).digest('hex'),
          createdAt: new Date().toISOString(),
        });
      }
    }

    return {
      success: true,
      artifacts_written: artifactsWritten,
      tokens_used: tokensUsed,
      duration_ms: Date.now() - start,
      raw_output_path: rawPath,
    };
  }

  private async writeRaw(
    ctx: StepRunContext,
    nodeId: string,
    content: string
  ): Promise<string> {
    const { workflowRunId, iteration } = ctx;
    try {
      await this.runArtifacts.writeNodeOutput(workflowRunId, iteration, nodeId, content);
      return path.join(
        this.projectRoot,
        '.sle',
        'runs',
        workflowRunId,
        String(iteration),
        'node-outputs',
        `${nodeId.toLowerCase()}.md`
      );
    } catch {
      return '';
    }
  }
}
