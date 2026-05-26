import { promises as nodeFsPromises } from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import type { AgentRole, AssembledContext } from './types.js';
import type { ContextManager, CycleStateContext } from './context-manager.js';
import type { ILLMProvider, LLMCompletionParams } from './llm-provider.js';
import type { RunArtifactManager } from './run-artifacts.js';
import { AgentLoop } from './agent-loop.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type DAGNodeId = string;

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

// ─── Node → Role mapping ─────────────────────────────────────────────────────

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

// Paths where new content is appended after existing content (not overwritten).
// decisions.md accumulates entries across cycles; all other artifacts are overwritten.
export const APPEND_ONLY_PATHS = new Set(['docs/decisions.md']);

const NODE_TO_ROLE: Record<string, AgentRole> = {
  SCOPING:   'facilitator',
  DESIGN:    'designer',
  CRITIQUE:  'critic',
  PLAN:      'planner',
  TEST:      'tester',
  BUILD:     'builder',
  HISTORY:   'historian',
  EVALUATE:  'evaluator',
  DEBUGGER:  'debugger',
  // SUMMARISE is daemon-generated (no LLM call) — handled by SummariseService
};

export function roleForNode(node: DAGNodeId): AgentRole | undefined {
  return NODE_TO_ROLE[node];
}

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
    fsModule?: typeof import('fs').promises
  ) {
    this.fs = fsModule ?? nodeFsPromises;
  }

  async run(node: DAGNodeId, cycleState: CycleStateContext): Promise<AgentRunResult> {
    const start = Date.now();
    const role = roleForNode(node);

    if (!role) {
      return {
        success: false,
        artifacts_written: [],
        tokens_used: 0,
        duration_ms: 0,
        raw_output_path: '',
        error: `No agent role mapped for node: ${node}`,
      };
    }

    // 1. Assemble context
    const context = await this.contextManager.assemble(role, cycleState);

    let parsed: { sections: Array<{ path: string; content: string }> };
    let tokensUsed = 0;
    let rawPath = '';

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
          cycleNumber: cycleState.cycle_number,
          iteration: cycleState.iteration,
          nodeId: node,
          runArtifacts: this.runArtifacts,
          fsModule: this.fs,
        }
      );

      const systemPrompt = context.system_prompt || 'You are a helpful software engineering assistant.';
      const userMessage = buildUserMessage(context);

      const loopResult = await loop.run(systemPrompt, userMessage);
      tokensUsed = loopResult.tokens_used;

      if (!loopResult.success) {
        rawPath = await this.writeRaw(cycleState, node, '');
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
      rawPath = await this.writeRaw(cycleState, node, loopResult.rawText || '');

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
        rawPath = await this.writeRaw(cycleState, node, '');
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
      rawPath = await this.writeRaw(cycleState, node, llmResult.content);

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

    // 6. Validate write paths (DDR-019)
    for (const section of parsed.sections) {
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

    return {
      success: true,
      artifacts_written: artifactsWritten,
      tokens_used: tokensUsed,
      duration_ms: Date.now() - start,
      raw_output_path: rawPath,
    };
  }

  private async writeRaw(
    cycleState: CycleStateContext,
    node: DAGNodeId,
    content: string
  ): Promise<string> {
    const { cycle_number, iteration } = cycleState;
    try {
      await this.runArtifacts.writeNodeOutput(cycle_number, iteration, node, content);
      return path.join(
        this.projectRoot,
        '.sle',
        'runs',
        `${cycle_number}-${iteration}`,
        'node-outputs',
        `${node.toLowerCase()}.md`
      );
    } catch {
      return '';
    }
  }
}
