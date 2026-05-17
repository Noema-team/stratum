import { promises as nodeFsPromises } from 'fs';
import path from 'path';
import type {
  AgentRole,
  AssembledContext,
  ContextManagerConfig,
  FailureReport,
  PlanningDepth,
} from './types.js';

export interface CycleStateContext {
  cycle_number: number;
  iteration: number;
  planning_depth: PlanningDepth;
  intent: string;
  current_node: string | null;
  failure_report?: FailureReport;
  revision_count?: number;
  revision_note?: string;
}

// ─── Per-role artifact slice defaults ────────────────────────────────────────

const ROLE_ARTIFACT_PATHS: Record<AgentRole, string[]> = {
  facilitator:  ['docs/discovery-summary.md', 'docs/cycle-charter.md'],
  designer:     ['docs/cycle-charter.md', 'docs/discovery-summary.md'],
  critic:       ['docs/requirements.md', 'docs/architecture.md'],
  planner:      ['docs/requirements.md', 'docs/architecture.md', 'docs/cycle-charter.md'],
  tester:       ['docs/requirements.md', 'docs/test-plan.md'],
  builder:      ['docs/requirements.md', 'docs/architecture.md', 'docs/plan.md', 'docs/test-plan.md'],
  historian:    ['docs/cycle-charter.md', 'docs/decisions.md'],
  evaluator:    ['docs/requirements.md', 'docs/test-plan.md', 'docs/evaluation-criteria.md'],
  explorer:     [],
  debugger:     ['docs/requirements.md', 'docs/test-plan.md'],
};

// ─── Task description inference ───────────────────────────────────────────────

const NODE_TASK_DESCRIPTIONS: Record<string, string> = {
  SCOPING:        'Lead a scoping discussion to refine the following intent into a detailed cycle charter.',
  DESIGN:         'Design the requirements and architecture to fulfill the cycle charter.',
  PLAN:           'Create a detailed implementation plan based on the requirements and architecture.',
  TEST:           'Define test cases and a test plan to validate the implementation.',
  CONFIRM:        'Review the plan and test cases, then approve, request revisions, or halt.',
  BUILD:          'Implement all code changes according to the plan and test cases.',
  HISTORY:        'Document key decisions and architectural choices made during this cycle.',
  EXEC:           'Execute the test suite and report results.',
  VALIDATION_GATE:'Validate test results against acceptance criteria.',
  EVALUATE:       'Evaluate cycle outcomes against the defined success criteria.',
  SUMMARISE:      'Generate a cycle summary report.',
  SNAPSHOT:       'Lock and version the cycle artifacts into an immutable snapshot.',
};

function inferTaskDescription(node: string | null, intent: string): string {
  const base = node ? (NODE_TASK_DESCRIPTIONS[node] ?? `Execute the ${node} step.`) : 'Prepare for the cycle.';
  return `${base}\n\nCycle intent: "${intent}"`;
}

// ─── Token counting (VS2: chars ÷ 4 approximation) ───────────────────────────

const CHARS_PER_TOKEN = 4;

function charsToTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

function tokensToChars(tokens: number): number {
  return tokens * CHARS_PER_TOKEN;
}

// ─── Truncation (prefer dropping earlier sections) ───────────────────────────

const TRUNCATION_MARKER = '[...earlier content truncated...]\n';

function truncateContent(content: string, maxChars: number): { text: string; truncated: boolean } {
  if (content.length <= maxChars) return { text: content, truncated: false };
  const keepChars = maxChars - TRUNCATION_MARKER.length;
  return {
    text: TRUNCATION_MARKER + content.slice(content.length - keepChars),
    truncated: true,
  };
}

// ─── ContextManager ───────────────────────────────────────────────────────────

export const DEFAULT_CONFIG: ContextManagerConfig = {
  artifact_slice_size: 8_000,
  summary_max_tokens: 500,
  system_prompt_max_tokens: 4_000,
  hard_ceiling: 32_000,
};

export class ContextManager {
  private fs: typeof import('fs').promises;

  constructor(
    private projectRoot: string,
    private config: ContextManagerConfig = DEFAULT_CONFIG,
    fsModule?: typeof import('fs').promises
  ) {
    this.fs = fsModule ?? nodeFsPromises;
  }

  async assemble(role: AgentRole, cycleState: CycleStateContext): Promise<AssembledContext> {
    const systemPrompt = await this.loadSystemPrompt(role);
    const stateSummary = this.buildStateSummary(cycleState);
    const task = inferTaskDescription(cycleState.current_node, cycleState.intent);

    const failureContext =
      cycleState.iteration > 1 && cycleState.failure_report
        ? this.formatFailureContext(cycleState.failure_report)
        : undefined;

    const { slices, truncated } = await this.loadArtifactSlices(
      role,
      cycleState,
      systemPrompt,
      stateSummary,
      task,
      failureContext
    );

    const totalTokens = this.estimateTotalTokens(systemPrompt, stateSummary, task, slices, failureContext);

    return {
      system_prompt: systemPrompt,
      artifact_slices: slices,
      state_summary: stateSummary,
      task,
      failure_context: failureContext,
      token_count: totalTokens,
      truncated,
    };
  }

  // ─── System prompt ──────────────────────────────────────────────────────────

  private async loadSystemPrompt(role: AgentRole): Promise<string> {
    const parts: string[] = [];

    const agentMdPath = path.join(this.projectRoot, 'agent.md');
    const agentMd = await this.safeReadFile(agentMdPath);
    if (agentMd) {
      const maxChars = tokensToChars(this.config.system_prompt_max_tokens);
      const { text } = truncateContent(agentMd, Math.floor(maxChars * 0.6));
      parts.push(text);
    }

    const rolePromptPath = path.join(this.projectRoot, '.sle', 'prompts', `${role}.md`);
    const rolePrompt = await this.safeReadFile(rolePromptPath);
    if (rolePrompt) {
      const maxChars = tokensToChars(this.config.system_prompt_max_tokens);
      const { text } = truncateContent(rolePrompt, Math.floor(maxChars * 0.4));
      parts.push(text);
    }

    return parts.join('\n\n---\n\n');
  }

  // ─── State summary ──────────────────────────────────────────────────────────

  private buildStateSummary(cycleState: CycleStateContext): string {
    const lines = [
      '## Current State',
      `- Cycle: ${cycleState.cycle_number}`,
      `- Iteration: ${cycleState.iteration}`,
      `- Planning depth: ${cycleState.planning_depth}`,
      `- Current node: ${cycleState.current_node ?? 'not started'}`,
      `- Intent: "${cycleState.intent}"`,
    ];
    if (cycleState.revision_count && cycleState.revision_count > 0) {
      lines.push(`- Revision: ${cycleState.revision_count}`);
      if (cycleState.revision_note) {
        lines.push(`- Revision note: "${cycleState.revision_note}"`);
      }
    }
    return lines.join('\n');
  }

  // ─── Failure context ─────────────────────────────────────────────────────────

  private formatFailureContext(report: FailureReport): string {
    const lines = [
      '## Previous Iteration Failure',
      `Iteration ${report.iteration} failed with ${report.failed_categories.length} category failures.`,
      '',
      `**Summary:** ${report.quick_summary}`,
      '',
      `**Failed categories:** ${report.failed_categories.map((c) => c.name).join(', ')}`,
      `**Passed categories:** ${report.passed_categories.join(', ')}`,
    ];
    const text = lines.join('\n');
    const maxChars = tokensToChars(2_000);
    return truncateContent(text, maxChars).text;
  }

  // ─── Artifact slices ─────────────────────────────────────────────────────────

  private async loadArtifactSlices(
    role: AgentRole,
    _cycleState: CycleStateContext,
    systemPrompt: string,
    stateSummary: string,
    task: string,
    failureContext: string | undefined
  ): Promise<{ slices: Record<string, string>; truncated: string[] }> {
    const usedTokens =
      charsToTokens(systemPrompt.length) +
      charsToTokens(stateSummary.length) +
      charsToTokens(task.length) +
      (failureContext ? charsToTokens(failureContext.length) : 0);

    let remainingTokens = this.config.hard_ceiling - usedTokens;
    if (remainingTokens < 0) remainingTokens = 0;

    const paths = ROLE_ARTIFACT_PATHS[role] ?? [];
    const slices: Record<string, string> = {};
    const truncated: string[] = [];

    for (const artifactPath of paths) {
      if (remainingTokens <= 0) break;

      const fullPath = path.join(this.projectRoot, artifactPath);
      const content = await this.safeReadFile(fullPath);
      if (!content) continue;

      const artifactId = path.basename(artifactPath, '.md');
      const maxChars = Math.min(
        this.config.artifact_slice_size,
        tokensToChars(remainingTokens)
      );

      const { text, truncated: wasTruncated } = truncateContent(content, maxChars);
      slices[artifactId] = text;
      remainingTokens -= charsToTokens(text.length);

      if (wasTruncated) truncated.push(artifactId);
    }

    return { slices, truncated };
  }

  // ─── Token estimate ──────────────────────────────────────────────────────────

  private estimateTotalTokens(
    systemPrompt: string,
    stateSummary: string,
    task: string,
    slices: Record<string, string>,
    failureContext: string | undefined
  ): number {
    let total = charsToTokens(systemPrompt.length);
    total += charsToTokens(stateSummary.length);
    total += charsToTokens(task.length);
    if (failureContext) total += charsToTokens(failureContext.length);
    for (const content of Object.values(slices)) {
      total += charsToTokens(content.length);
    }
    return total;
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private async safeReadFile(filePath: string): Promise<string | null> {
    try {
      return await this.fs.readFile(filePath, 'utf-8');
    } catch {
      return null;
    }
  }
}
