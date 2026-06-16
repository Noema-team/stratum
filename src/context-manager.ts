import { promises as nodeFsPromises } from 'fs';
import path from 'path';
import type {
  AgentRole,
  AssembledContext,
  ContextManagerConfig,
  FailureReport,
  PlanningDepth,
  SLETask,
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
  task?: SLETask;
}

export type SourceWeight = 'user_defined' | 'cycle_produced' | 'inferred';

export interface SliceRule {
  artifact_id: string;
  mode: 'full' | 'last_n_entries' | 'last_cycle' | 'summary_only';
  max_entries?: number;
  max_tokens?: number;
  never_truncate?: boolean;
  source_weight?: SourceWeight;
}

// ─── Per-role artifact defaults ──────────────────────────────────────────────

const ROLE_ARTIFACT_PATHS: Record<AgentRole, string[]> = {
  facilitator:  ['docs/discovery-summary.md', 'docs/cycle-charter.md'],
  designer:     ['docs/cycle-charter.md', 'docs/discovery-summary.md', 'docs/cycle-critique.md', 'docs/critique-report.md'],
  critic:       ['docs/requirements.md', 'docs/architecture.md', 'docs/cycle-charter.md', 'docs/discovery-summary.md'],
  planner:      ['docs/requirements.md', 'docs/architecture.md', 'docs/cycle-charter.md'],
  tester:       ['docs/requirements.md', 'docs/test-plan.md'],
  builder:      ['docs/requirements.md', 'docs/architecture.md', 'docs/plan.md', 'docs/test-plan.md'],
  historian:    ['docs/cycle-charter.md', 'docs/decisions.md'],
  evaluator:    ['docs/requirements.md', 'docs/test-plan.md', 'docs/evaluation-criteria.md'],
  explorer:     [],
  debugger:     ['docs/requirements.md', 'docs/test-plan.md'],
};

// ─── Task description defaults ───────────────────────────────────────────────

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

// ─── Token counting (chars ÷ 4 approximation) ───────────────────────────

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
  if (keepChars <= 0) return { text: '', truncated: true };
  return {
    text: TRUNCATION_MARKER + content.slice(content.length - keepChars),
    truncated: true,
  };
}

// ─── Default SliceRules by ref ───────────────────────────────────────────────

const SLICE_RULES: Record<string, SliceRule> = {
  'doc:requirements': { artifact_id: 'doc:requirements', mode: 'full', never_truncate: true, source_weight: 'user_defined' },
  'doc:architecture': { artifact_id: 'doc:architecture', mode: 'full', never_truncate: true, source_weight: 'user_defined' },
  'doc:test-plan': { artifact_id: 'doc:test-plan', mode: 'full', source_weight: 'cycle_produced' },
  'doc:plan': { artifact_id: 'doc:plan', mode: 'full', source_weight: 'cycle_produced' },
  'doc:decisions': { artifact_id: 'doc:decisions', mode: 'last_n_entries', max_entries: 3, source_weight: 'cycle_produced' },
  'doc:evaluation': { artifact_id: 'doc:evaluation', mode: 'last_cycle', source_weight: 'inferred' },
  'doc:discovery-summary': { artifact_id: 'doc:discovery-summary', mode: 'full', source_weight: 'inferred' },
  'doc:cycle-charter': { artifact_id: 'doc:cycle-charter', mode: 'full', source_weight: 'cycle_produced' },
  'doc:research-findings': { artifact_id: 'doc:research-findings', mode: 'full', source_weight: 'user_defined' },
  'doc:cycle-critique': { artifact_id: 'doc:cycle-critique', mode: 'full', never_truncate: true, source_weight: 'cycle_produced' },
  'doc:critique-report': { artifact_id: 'doc:critique-report', mode: 'full', source_weight: 'inferred' },
};

function getSliceRule(ref: string): SliceRule {
  if (SLICE_RULES[ref]) return SLICE_RULES[ref];
  return {
    artifact_id: ref,
    mode: 'full',
    source_weight: 'inferred',
  };
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function resolveArtifactPath(ref: string): string {
  const [baseRef] = ref.split('#');
  if (baseRef.startsWith('doc:')) {
    const key = baseRef.substring(4);
    return `docs/${key}.md`;
  } else if (baseRef.startsWith('node:')) {
    const parts = baseRef.substring(5).split(':');
    const group = parts[0];
    const key = parts[1];
    return `docs/${group}/${key}.md`;
  }
  return baseRef;
}

// ─── ContextManager ───────────────────────────────────────────────────────────

export const DEFAULT_CONFIG: ContextManagerConfig = {
  artifact_slice_size: 2000,
  summary_max_tokens: 300,
  system_prompt_max_tokens: 500,
  hard_ceiling: 3500,
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
    const rawSystemPrompt = await this.loadSystemPrompt(role);
    const stateSummary = this.buildStateSummary(cycleState);
    const task = inferTaskDescription(cycleState.current_node, cycleState.intent);

    const failureContext =
      cycleState.iteration > 1 && cycleState.failure_report
        ? this.formatFailureContext(cycleState.failure_report)
        : undefined;

    const { slices, truncated } = await this.loadArtifactSlices(
      role,
      cycleState,
      rawSystemPrompt,
      stateSummary,
      task,
      failureContext
    );

    // Format final system prompt including Component 2 artifact checklist
    const artifactList = Object.keys(slices)
      .map(id => `- doc:${id}`)
      .join('\n');
    
    const systemPrompt = rawSystemPrompt.replace('{artifact_list}', artifactList || 'No documents available.');

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

  // ─── System prompt (Component 1) ──────────────────────────────────────────

  private async loadSystemPrompt(role: AgentRole): Promise<string> {
    const agentMdPath = path.join(this.projectRoot, 'agent.md');
    const agentMd = await this.safeReadFile(agentMdPath);
    const agentHeader = agentMd 
      ? truncateContent(agentMd, tokensToChars(300)).text 
      : `You are the ${role} agent in an SLE cycle.`;

    const rolePromptPath = path.join(this.projectRoot, '.sle', 'prompts', `${role}.md`);
    const rolePrompt = await this.safeReadFile(rolePromptPath);
    const roleDetails = rolePrompt 
      ? truncateContent(rolePrompt, tokensToChars(200)).text 
      : 'Review constraints and proceed with your assigned task.';

    return `${agentHeader}\n\n## Your role\n${roleDetails}\n\n## Artifacts in your context\n{artifact_list}`;
  }

  // ─── State summary (Component 3) ──────────────────────────────────────────

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
    const text = lines.join('\n');
    return truncateContent(text, tokensToChars(this.config.summary_max_tokens)).text;
  }

  // ─── Failure context (Component 5) ─────────────────────────────────────────

  private formatFailureContext(report: FailureReport): string {
    const lines = [
      '## Previous Iteration Failure',
      `Iteration ${report.iteration} failed with ${report.failed_categories.length} category failures.`,
      '',
      `**Summary:** ${report.quick_summary}`,
      '',
      `**Failed categories:** ${report.failed_categories.map((c: any) => typeof c === 'string' ? c : c.name).join(', ')}`,
      `**Passed categories:** ${report.passed_categories.join(', ')}`,
    ];
    const text = lines.join('\n');
    return truncateContent(text, tokensToChars(400)).text;
  }

  // ─── Artifact slices (Component 2) ─────────────────────────────────────────

  private async loadArtifactSlices(
    role: AgentRole,
    _cycleState: CycleStateContext,
    systemPrompt: string,
    stateSummary: string,
    task: string,
    failureContext: string | undefined
  ): Promise<{ slices: Record<string, string>; truncated: string[] }> {
    const systemPromptTokens = charsToTokens(systemPrompt.length);
    const stateSummaryTokens = charsToTokens(stateSummary.length);
    const taskTokens = charsToTokens(task.length);
    const failureContextTokens = failureContext ? charsToTokens(failureContext.length) : 0;

    const nonArtifactTokens = systemPromptTokens + stateSummaryTokens + taskTokens + failureContextTokens;
    let availableArtifactBudget = this.config.hard_ceiling - nonArtifactTokens;
    if (availableArtifactBudget < 500) {
      availableArtifactBudget = 500;
    }

    let refs: string[] = [];
    const activeTask = _cycleState.task;

    if (activeTask && activeTask.context_declarations && activeTask.context_declarations.length > 0) {
      // Declared mode
      const decl = activeTask.context_declarations[0];
      refs = decl.slices;
    } else {
      // Inferred mode
      const paths = ROLE_ARTIFACT_PATHS[role] ?? [];
      refs = paths.map(p => {
        const base = path.basename(p, '.md');
        return `doc:${base}`;
      });
    }

    const loadedSlices: Array<{
      ref: string;
      content: string;
      tokens: number;
      rule: SliceRule;
    }> = [];

    const truncated: string[] = [];

    for (const ref of refs) {
      const relPath = resolveArtifactPath(ref);
      const fullPath = path.join(this.projectRoot, relPath);
      let content = await this.safeReadFile(fullPath);
      if (!content) continue;

      // Extract section if anchor exists in reference
      const [_, anchor] = ref.split('#');
      if (anchor) {
        const sections = content.split(/(?=^##\s)/m);
        const matchedSection = sections.find(sec => {
          const firstLine = sec.trim().split('\n')[0];
          const headerMatch = firstLine.match(/^##\s+(.+)$/);
          if (headerMatch) {
            return slugify(headerMatch[1].trim()) === anchor;
          }
          return false;
        });
        if (matchedSection) {
          content = matchedSection.trim();
        } else {
          content = '';
        }
      }

      const rule = getSliceRule(ref);

      if (rule.mode === 'last_n_entries' && rule.max_entries) {
        const entries = content.split(/(?=^##\s)/m);
        if (entries.length > rule.max_entries) {
          content = entries.slice(-rule.max_entries).join('');
        }
      } else if (rule.mode === 'last_cycle') {
        const entries = content.split(/(?=^##\s*Cycle)/mi);
        if (entries.length > 1) {
          content = entries[entries.length - 1];
        }
      }

      if (rule.max_tokens) {
        const maxChars = tokensToChars(rule.max_tokens);
        if (content.length > maxChars) {
          content = truncateContent(content, maxChars).text;
          truncated.push(path.basename(relPath, '.md'));
        }
      }

      loadedSlices.push({
        ref,
        content,
        tokens: charsToTokens(content.length),
        rule,
      });
    }

    let totalArtifactTokens = loadedSlices.reduce((acc, s) => acc + s.tokens, 0);

    if (totalArtifactTokens > availableArtifactBudget) {
      const inferred = loadedSlices.filter(s => s.rule.source_weight === 'inferred' && !s.rule.never_truncate);
      const cycleProduced = loadedSlices.filter(s => s.rule.source_weight === 'cycle_produced' && !s.rule.never_truncate);
      const userDefined = loadedSlices.filter(s => s.rule.source_weight === 'user_defined' && !s.rule.never_truncate);

      const truncateList = (list: typeof loadedSlices, targetBudget: number) => {
        let currentSum = loadedSlices.reduce((acc, s) => acc + s.tokens, 0);
        if (currentSum <= targetBudget) return;

        for (const item of list) {
          if (currentSum <= targetBudget) break;
          const over = currentSum - targetBudget;
          if (item.tokens <= over) {
            currentSum -= item.tokens;
            item.content = '';
            item.tokens = 0;
            truncated.push(path.basename(resolveArtifactPath(item.ref), '.md'));
          } else {
            const keepTokens = item.tokens - over;
            const keepChars = tokensToChars(keepTokens);
            const { text } = truncateContent(item.content, keepChars);
            currentSum -= (item.tokens - charsToTokens(text.length));
            item.content = text;
            item.tokens = charsToTokens(text.length);
            truncated.push(path.basename(resolveArtifactPath(item.ref), '.md'));
          }
        }
      };

      truncateList(inferred, availableArtifactBudget);
      truncateList(cycleProduced, availableArtifactBudget);
      truncateList(userDefined, availableArtifactBudget);
    }

    const finalSlices: Record<string, string> = {};
    for (const s of loadedSlices) {
      if (s.content) {
        const id = path.basename(resolveArtifactPath(s.ref), '.md');
        finalSlices[id] = s.content;
      }
    }

    return { slices: finalSlices, truncated };
  }

  // ─── Token estimation ────────────────────────────────────────────────────────

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
