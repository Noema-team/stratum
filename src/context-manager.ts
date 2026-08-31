import { promises as nodeFsPromises } from 'fs';
import path from 'path';
import type {
  AgentRole,
  AssembledContext,
  ContextManagerConfig,
  FailureReport,
  PlanningDepth,
} from './types.js';
import type { StepRunContext } from './workflow/types.js';

// ─── Public Types ─────────────────────────────────────────────────────────────

export type SourceWeight = 'user_defined' | 'cycle_produced' | 'inferred';
export type FacilitatorMode = 'chat' | 'decision' | 'scoping';
export type SliceMode = 'full' | 'last_n_entries' | 'last_cycle' | 'summary_only';

export interface SliceRule {
  artifact_id: string;
  mode: SliceMode;
  max_entries?: number;
  max_tokens?: number;
  never_truncate?: boolean;
  source_weight?: SourceWeight;
}

// CycleStateContext — legacy compatibility type for callers not yet migrated to StepRunContext.
// New code must use StepRunContext from workflow/types.ts instead.
export interface CycleStateContext {
  cycle_number: number;
  iteration: number;
  planning_depth: PlanningDepth;
  intent: string;
  current_node: string | null;
  failure_report?: FailureReport;
  revision_count?: number;
  revision_note?: string;
  facilitator_mode?: FacilitatorMode;
  ephemeral?: Record<string, string>;
  source_files?: string[];
}

// ─── Internal Slice Definition ───────────────────────────────────────────────

interface SliceDef {
  ref: string;
  mode: SliceMode;
  max_entries?: number;
  never_truncate?: boolean;
  source_weight?: SourceWeight;
  // Only include this slice at or above this planning depth
  requires_depth?: PlanningDepth;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEPTH_ORDER: Record<PlanningDepth, number> = {
  minimal: 0,
  standard: 1,
  deep: 2,
  research: 3,
};

const SUMMARY_PREVIEW_LINES = 30;
const CHARS_PER_TOKEN = 4;
const TRUNCATION_MARKER = '[...earlier content truncated...]\n';

export const DEFAULT_CONFIG: ContextManagerConfig = {
  artifact_slice_size: 2000,
  summary_max_tokens: 300,
  system_prompt_max_tokens: 500,
  hard_ceiling: 4000,
};

// ─── Node Task Descriptions ───────────────────────────────────────────────────

const NODE_TASK_DESCRIPTIONS: Record<string, string> = {
  SCOPING: 'Lead a scoping discussion to refine the following intent into a detailed cycle charter.',
  DESIGN: 'Design the requirements and architecture to fulfill the cycle charter.',
  CRITIQUE: 'Review the architecture and requirements for blocking issues, warnings, and suggestions.',
  PLAN: 'Create a detailed implementation plan based on the requirements and architecture.',
  TEST: 'Write executable test scripts for the requirements and test plan. Derive tests from requirements only — never from implementation code.',
  CONFIRM: 'Review the plan and test cases, then approve, request revisions, or halt.',
  BUILD: 'Implement all code changes according to the plan and test cases.',
  HISTORY: 'Document key decisions and architectural choices made during this cycle.',
  EXEC: 'Execute the test suite and report results.',
  VALIDATION_GATE: 'Validate test results against acceptance criteria.',
  EVALUATE: 'Evaluate cycle outcomes against the defined success criteria.',
  SUMMARISE: 'Generate a cycle summary report.',
  SNAPSHOT: 'Lock and version the cycle artifacts into an immutable snapshot.',
};

// ─── Role Slice Definitions ───────────────────────────────────────────────────

const DESIGNER_SLICES: SliceDef[] = [
  { ref: 'doc:product-brief', mode: 'full', source_weight: 'user_defined' },
  { ref: 'doc:success-definition', mode: 'full', source_weight: 'user_defined' },
  { ref: 'doc:constraints', mode: 'full', source_weight: 'user_defined' },
  { ref: 'doc:stakeholders', mode: 'summary_only', source_weight: 'inferred' },
  { ref: 'doc:system-description', mode: 'full', source_weight: 'user_defined' },
  { ref: 'doc:vision', mode: 'summary_only', source_weight: 'inferred' },
  { ref: 'doc:open-questions', mode: 'full', source_weight: 'user_defined' },
  { ref: 'doc:project-plan', mode: 'summary_only', source_weight: 'inferred' },
  { ref: 'doc:research-findings', mode: 'full', source_weight: 'user_defined' },
  { ref: 'doc:architecture', mode: 'full', never_truncate: true, source_weight: 'user_defined' },
  { ref: 'doc:requirements', mode: 'full', never_truncate: true, source_weight: 'user_defined' },
  { ref: 'doc:evaluation', mode: 'last_cycle', source_weight: 'inferred' },
  { ref: 'doc:decisions', mode: 'last_n_entries', max_entries: 3, source_weight: 'cycle_produced' },
  { ref: 'doc:cycle-charter', mode: 'full', source_weight: 'cycle_produced' },
];

const EXPLORER_SLICES: SliceDef[] = [
  { ref: 'doc:system-description', mode: 'full', source_weight: 'user_defined' },
  { ref: 'doc:open-questions', mode: 'full', source_weight: 'user_defined' },
  { ref: 'doc:constraints', mode: 'full', source_weight: 'user_defined' },
  { ref: 'doc:evaluation', mode: 'last_cycle', source_weight: 'inferred' },
  { ref: 'doc:cycle-charter', mode: 'full', source_weight: 'cycle_produced' },
];

const PLANNER_SLICES: SliceDef[] = [
  { ref: 'doc:requirements', mode: 'full', never_truncate: true, source_weight: 'user_defined' },
  { ref: 'doc:architecture', mode: 'full', never_truncate: true, source_weight: 'user_defined' },
  { ref: 'doc:decisions', mode: 'last_n_entries', max_entries: 3, source_weight: 'cycle_produced' },
  { ref: 'doc:evaluation', mode: 'last_cycle', source_weight: 'inferred' },
  { ref: 'doc:critique-report', mode: 'full', source_weight: 'inferred', requires_depth: 'deep' },
  { ref: 'doc:cycle-critique', mode: 'full', source_weight: 'cycle_produced' },
  { ref: 'doc:cycle-charter', mode: 'full', source_weight: 'cycle_produced' },
  // doc:debug-diagnosis is ephemeral — injected via cycleState.ephemeral on retry
];

const TESTER_SLICES: SliceDef[] = [
  { ref: 'doc:requirements', mode: 'full', never_truncate: true, source_weight: 'user_defined' },
  { ref: 'doc:test-plan', mode: 'full', source_weight: 'cycle_produced' },
];

const BUILDER_SLICES: SliceDef[] = [
  { ref: 'doc:requirements', mode: 'full', never_truncate: true, source_weight: 'user_defined' },
  { ref: 'doc:architecture', mode: 'full', never_truncate: true, source_weight: 'user_defined' },
  { ref: 'doc:test-plan', mode: 'full', source_weight: 'cycle_produced' },
  { ref: 'doc:plan', mode: 'full', source_weight: 'cycle_produced', requires_depth: 'deep' },
  { ref: 'doc:build-plan', mode: 'full', source_weight: 'cycle_produced', requires_depth: 'deep' },
  // doc:test-script:{category} and source_files added dynamically in getRoleSlices()
];

const DEBUGGER_SLICES: SliceDef[] = [
  // run: refs resolve relative to failure_report.run_dir
  { ref: 'run:manifest.json', mode: 'full', source_weight: 'cycle_produced' },
  { ref: 'run:ai/context-pack.md', mode: 'full', source_weight: 'cycle_produced' },
  // Per-category result and metrics artifacts added dynamically in getRoleSlices()
  { ref: 'doc:architecture', mode: 'full', source_weight: 'user_defined' },
];

const EVALUATOR_SLICES: SliceDef[] = [
  { ref: 'doc:requirements', mode: 'full', never_truncate: true, source_weight: 'user_defined' },
  { ref: 'doc:test-plan', mode: 'full', source_weight: 'cycle_produced' },
  { ref: 'doc:evaluation', mode: 'last_cycle', source_weight: 'inferred' },
  { ref: 'run:ai/context-pack.md', mode: 'full', source_weight: 'cycle_produced' },
  { ref: 'run:manifest.json', mode: 'full', source_weight: 'cycle_produced' },
  { ref: 'doc:build-plan', mode: 'summary_only', source_weight: 'inferred', requires_depth: 'deep' },
];

const CRITIC_SLICES: SliceDef[] = [
  { ref: 'doc:architecture', mode: 'full', never_truncate: true, source_weight: 'user_defined' },
  { ref: 'doc:requirements', mode: 'full', never_truncate: true, source_weight: 'user_defined' },
  { ref: 'doc:evaluation', mode: 'last_cycle', source_weight: 'inferred' },
  { ref: 'doc:constraints', mode: 'full', source_weight: 'user_defined' },
  { ref: 'doc:system-description', mode: 'full', source_weight: 'user_defined' },
  { ref: 'doc:decisions', mode: 'last_n_entries', max_entries: 3, source_weight: 'cycle_produced' },
];

const HISTORIAN_SLICES: SliceDef[] = [
  { ref: 'doc:decisions', mode: 'full', never_truncate: true, source_weight: 'user_defined' },
];

const FACILITATOR_CHAT_SLICES: SliceDef[] = [
  { ref: 'doc:product-brief', mode: 'summary_only', source_weight: 'user_defined' },
  { ref: 'doc:system-description', mode: 'full', source_weight: 'user_defined' },
  { ref: 'doc:vision', mode: 'summary_only', source_weight: 'inferred' },
  { ref: 'doc:open-questions', mode: 'full', source_weight: 'user_defined' },
  { ref: 'doc:project-plan', mode: 'summary_only', source_weight: 'inferred' },
  { ref: '.sle/chat-history.jsonl', mode: 'last_n_entries', max_entries: 20, source_weight: 'inferred' },
];

const FACILITATOR_DECISION_SLICES: SliceDef[] = [
  { ref: 'doc:plan', mode: 'full', source_weight: 'cycle_produced' },
  { ref: 'doc:test-plan', mode: 'full', source_weight: 'cycle_produced' },
  { ref: '.sle/chat-history.jsonl', mode: 'last_n_entries', max_entries: 5, source_weight: 'inferred' },
];

const FACILITATOR_SCOPING_SLICES: SliceDef[] = [
  { ref: 'doc:cycle-scope-draft', mode: 'full', source_weight: 'user_defined' },
  { ref: 'doc:cycle-charter', mode: 'full', source_weight: 'cycle_produced' },
  { ref: 'doc:architecture', mode: 'summary_only', source_weight: 'inferred' },
  { ref: 'doc:requirements', mode: 'summary_only', source_weight: 'inferred' },
  { ref: 'doc:decisions', mode: 'last_n_entries', max_entries: 5, source_weight: 'cycle_produced' },
];

// ─── Dynamic Slice Resolution ─────────────────────────────────────────────────

function getRoleSlices(role: AgentRole, ctx: StepRunContext): SliceDef[] {
  const depth = ctx.planningDepth;

  function filterDepth(slices: SliceDef[]): SliceDef[] {
    return slices.filter(s => !s.requires_depth || meetsDepth(s.requires_depth, depth));
  }

  switch (role) {
    case 'designer':
      return filterDepth(DESIGNER_SLICES);

    case 'explorer':
      return filterDepth(EXPLORER_SLICES);

    case 'planner': {
      const base = filterDepth(PLANNER_SLICES);
      // Inject ephemeral debug-diagnosis on retry
      if (ctx.iteration > 1 && ctx.ephemeral?.['doc:debug-diagnosis']) {
        base.push({ ref: 'doc:debug-diagnosis', mode: 'full', source_weight: 'cycle_produced' });
      }
      return base;
    }

    case 'tester':
      return filterDepth(TESTER_SLICES);

    case 'builder': {
      const base = filterDepth(BUILDER_SLICES);
      if (ctx.sourceFiles) {
        for (const file of ctx.sourceFiles) {
          base.push({ ref: file, mode: 'full', source_weight: 'inferred' });
        }
      }
      return base;
    }

    case 'debugger': {
      const base = filterDepth(DEBUGGER_SLICES);
      if (ctx.failureReport) {
        const runDir = ctx.failureReport.run_dir;
        if (runDir) {
          for (const cat of ctx.failureReport.failed_categories) {
            const name = getCategoryName(cat);
            base.push({ ref: `run:tests/${name}/result.json`, mode: 'full', source_weight: 'cycle_produced' });
            base.push({ ref: `run:metrics/${name}.json`, mode: 'full', source_weight: 'cycle_produced' });
            base.push({ ref: `run:traces/${name}.jsonl`, mode: 'last_n_entries', max_entries: 20, source_weight: 'inferred' });
          }
        }
      }
      return base;
    }

    case 'evaluator':
      return filterDepth(EVALUATOR_SLICES);

    case 'critic':
      return filterDepth(CRITIC_SLICES);

    case 'historian':
      return filterDepth(HISTORIAN_SLICES);

    case 'facilitator': {
      const mode = ctx.facilitatorMode ?? 'chat';
      switch (mode) {
        case 'decision': return filterDepth(FACILITATOR_DECISION_SLICES);
        case 'scoping':  return filterDepth(FACILITATOR_SCOPING_SLICES);
        default:         return filterDepth(FACILITATOR_CHAT_SLICES);
      }
    }
  }
}

// ─── Path Resolution ──────────────────────────────────────────────────────────

function resolveArtifactPath(
  ref: string,
  projectRoot: string,
  runDir?: string
): string | null {
  if (ref.startsWith('doc:')) {
    const key = ref.slice(4);
    return path.join(projectRoot, '.sle', 'project-docs', `${key}.md`);
  }
  if (ref.startsWith('node:')) {
    const rest = ref.slice(5);
    const colonIdx = rest.indexOf(':');
    if (colonIdx === -1) return null;
    const group = rest.slice(0, colonIdx);
    const key = rest.slice(colonIdx + 1);
    return path.join(projectRoot, '.sle', 'project-graph', 'layers', group, `${key}.md`);
  }
  if (ref.startsWith('run:')) {
    if (!runDir) return null;
    return path.join(runDir, ref.slice(4));
  }
  if (ref.startsWith('.sle/')) {
    return path.join(projectRoot, ref);
  }
  // Bare path — treat as relative to project root
  return path.join(projectRoot, ref);
}

function resolveSummaryPath(projectRoot: string, ref: string): string | null {
  if (!ref.startsWith('doc:')) return null;
  const key = ref.slice(4);
  return path.join(projectRoot, '.sle', 'project-docs', `${key}.summary.md`);
}

function refToSliceKey(ref: string): string {
  if (ref.startsWith('doc:')) return ref.slice(4);
  if (ref.startsWith('node:')) {
    const parts = ref.slice(5).split(':');
    return parts[parts.length - 1];
  }
  if (ref.startsWith('run:')) {
    const filePart = ref.slice(4);
    return path.basename(filePart, path.extname(filePart));
  }
  return path.basename(ref, path.extname(ref));
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function meetsDepth(required: PlanningDepth, actual: PlanningDepth): boolean {
  return DEPTH_ORDER[actual] >= DEPTH_ORDER[required];
}

function charsToTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

function tokensToChars(tokens: number): number {
  return tokens * CHARS_PER_TOKEN;
}

function truncateContent(content: string, maxChars: number): { text: string; truncated: boolean } {
  if (content.length <= maxChars) return { text: content, truncated: false };
  const keepChars = maxChars - TRUNCATION_MARKER.length;
  if (keepChars <= 0) return { text: '', truncated: true };
  return {
    text: TRUNCATION_MARKER + content.slice(content.length - keepChars),
    truncated: true,
  };
}

function getCategoryName(c: string | { name: string }): string {
  return typeof c === 'string' ? c : c.name;
}

function applyLoadingMode(content: string, def: SliceDef): string {
  if (def.mode === 'last_n_entries' && def.max_entries) {
    const entries = content.split(/(?=^##\s)/m);
    if (entries.length > def.max_entries) {
      return entries.slice(-def.max_entries).join('');
    }
    return content;
  }
  if (def.mode === 'last_cycle') {
    const entries = content.split(/(?=^##\s*Cycle)/im);
    if (entries.length > 1) {
      return entries[entries.length - 1];
    }
    return content;
  }
  return content;
}

// ─── ContextManager ───────────────────────────────────────────────────────────

export class ContextManager {
  private fs: typeof import('fs').promises;

  constructor(
    private projectRoot: string,
    private config: ContextManagerConfig = DEFAULT_CONFIG,
    fsModule?: typeof import('fs').promises
  ) {
    this.fs = fsModule ?? nodeFsPromises;
  }

  async assemble(role: AgentRole, ctx: StepRunContext): Promise<AssembledContext> {
    const rawSystemPrompt = await this.loadSystemPrompt(role);
    const stateSummary = this.buildStateSummary(ctx);
    const task = this.buildTaskDescription(role, ctx);

    const failureContext =
      ctx.iteration > 1 && ctx.failureReport
        ? this.formatFailureContext(ctx.failureReport)
        : undefined;

    const { slices, truncated } = await this.loadArtifactSlices(
      role,
      ctx,
      rawSystemPrompt,
      stateSummary,
      task,
      failureContext
    );

    const artifactList = Object.keys(slices)
      .map(id => `- ${id}`)
      .join('\n');

    const systemPrompt = rawSystemPrompt
      ? rawSystemPrompt.replace('{artifact_list}', artifactList || 'No documents available.')
      : '';

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

  // ─── Component 1: System prompt ───────────────────────────────────────────

  private async loadSystemPrompt(role: AgentRole): Promise<string> {
    const agentMdPath = path.join(this.projectRoot, 'agent.md');
    const agentMd = await this.safeReadFile(agentMdPath);
    const rolePromptPath = path.join(this.projectRoot, '.sle', 'prompts', `${role}.md`);
    const rolePrompt = await this.safeReadFile(rolePromptPath);

    if (!agentMd && !rolePrompt) return '';

    const agentHeader = agentMd
      ? truncateContent(agentMd, tokensToChars(300)).text
      : `You are the ${role} agent in an SLE cycle.`;

    const roleDetails = rolePrompt
      ? truncateContent(rolePrompt, tokensToChars(200)).text
      : 'Review constraints and proceed with your assigned task.';

    return `${agentHeader}\n\n## Your role\n${roleDetails}\n\n## Artifacts in your context\n{artifact_list}`;
  }

  // ─── Component 3: State summary ────────────────────────────────────────────

  private buildStateSummary(ctx: StepRunContext): string {
    const lines = [
      '## Current State',
      `- Cycle: ${ctx.cycleNumber}`,
      `- Iteration: ${ctx.iteration}`,
      `- Planning depth: ${ctx.planningDepth}`,
      `- Step: ${ctx.stepId ?? 'not started'}`,
      `- Intent: "${ctx.goal}"`,
    ];
    if (ctx.revision > 0) {
      lines.push(`- Revision: ${ctx.revision}`);
      if (ctx.revisionNote) {
        lines.push(`- Revision note: "${ctx.revisionNote}"`);
      }
    }
    return truncateContent(lines.join('\n'), tokensToChars(this.config.summary_max_tokens)).text;
  }

  // ─── Component 4: Task description ────────────────────────────────────────

  private buildTaskDescription(role: AgentRole, ctx: StepRunContext): string {
    const stepId = ctx.stepId;
    // Look up by step ID directly, then by uppercase (legacy DAG node compat), then by role.
    const base = stepId
      ? (NODE_TASK_DESCRIPTIONS[stepId] ??
         NODE_TASK_DESCRIPTIONS[stepId.toUpperCase()] ??
         NODE_TASK_DESCRIPTIONS[role.toUpperCase()] ??
         `Execute the ${stepId} step.`)
      : 'Prepare for the cycle.';
    return `${base}\n\nCycle intent: "${ctx.goal}"`;
  }

  // ─── Component 5: Failure context ─────────────────────────────────────────

  private formatFailureContext(report: FailureReport): string {
    const failedNames = report.failed_categories.map(getCategoryName);
    const lines = [
      '## Previous Iteration Failure',
      `Iteration ${report.iteration} failed with ${failedNames.length} category failure(s).`,
      '',
      `**Summary:** ${report.quick_summary}`,
      '',
      `**Failed categories:** ${failedNames.join(', ')}`,
      `**Passed categories:** ${report.passed_categories.join(', ')}`,
    ];
    return truncateContent(lines.join('\n'), tokensToChars(400)).text;
  }

  // ─── Component 2: Artifact slices ─────────────────────────────────────────

  private async loadArtifactSlices(
    role: AgentRole,
    ctx: StepRunContext,
    systemPrompt: string,
    stateSummary: string,
    task: string,
    failureContext: string | undefined
  ): Promise<{ slices: Record<string, string>; truncated: string[] }> {
    // Budget = hard_ceiling minus the tokens used by the other components
    const fixedTokens =
      charsToTokens(systemPrompt.length) +
      charsToTokens(stateSummary.length) +
      charsToTokens(task.length) +
      (failureContext ? charsToTokens(failureContext.length) : 0);

    const artifactBudget = Math.max(this.config.hard_ceiling - fixedTokens, 500);

    const runDir = ctx.failureReport?.run_dir;
    const sliceDefs = this.resolveSliceDefs(role, ctx, runDir);

    // Load content for each slice
    interface LoadedSlice {
      key: string;
      content: string;
      tokens: number;
      weight: SourceWeight;
      neverTruncate: boolean;
    }

    const loaded: LoadedSlice[] = [];
    const truncated: string[] = [];

    for (const def of sliceDefs) {
      const key = refToSliceKey(def.ref);
      const content = await this.loadSliceContent(def, ctx, runDir);
      if (!content) continue;

      const processed = applyLoadingMode(content, def);
      const weight = def.source_weight ?? 'inferred';
      const neverTruncate = def.never_truncate ?? false;

      loaded.push({
        key,
        content: processed,
        tokens: charsToTokens(processed.length),
        weight,
        neverTruncate,
      });
    }

    // Enforce budget — truncate inferred first, then cycle_produced, then user_defined
    const TRUNCATION_ORDER: SourceWeight[] = ['inferred', 'cycle_produced', 'user_defined'];

    let totalTokens = loaded.reduce((sum, s) => sum + s.tokens, 0);

    if (totalTokens > artifactBudget) {
      for (const weightTier of TRUNCATION_ORDER) {
        if (totalTokens <= artifactBudget) break;
        for (const slice of loaded) {
          if (totalTokens <= artifactBudget) break;
          if (slice.neverTruncate || slice.weight !== weightTier) continue;

          const over = totalTokens - artifactBudget;
          if (slice.tokens <= over) {
            totalTokens -= slice.tokens;
            slice.content = '';
            slice.tokens = 0;
            truncated.push(slice.key);
          } else {
            const keepChars = tokensToChars(slice.tokens - over);
            const { text } = truncateContent(slice.content, keepChars);
            totalTokens -= slice.tokens - charsToTokens(text.length);
            slice.content = text;
            slice.tokens = charsToTokens(text.length);
            if (!truncated.includes(slice.key)) truncated.push(slice.key);
          }
        }
      }

      // Hard ceiling safety: if still over, truncate never_truncate as last resort
      if (totalTokens > this.config.hard_ceiling) {
        console.warn(`[ContextManager] Hard ceiling exceeded for role=${role}. Forcing truncation.`);
        for (const slice of loaded) {
          if (totalTokens <= this.config.hard_ceiling) break;
          const over = totalTokens - this.config.hard_ceiling;
          const keepChars = tokensToChars(slice.tokens - over);
          if (keepChars < 0) {
            totalTokens -= slice.tokens;
            slice.content = '';
            slice.tokens = 0;
          } else {
            const { text } = truncateContent(slice.content, keepChars);
            totalTokens -= slice.tokens - charsToTokens(text.length);
            slice.content = text;
            slice.tokens = charsToTokens(text.length);
          }
          if (!truncated.includes(slice.key)) truncated.push(slice.key);
        }
      }
    }

    // Also apply per-artifact max_tokens from config (artifact_slice_size)
    // Individual slice caps — prevent any single artifact dominating
    for (const slice of loaded) {
      if (slice.neverTruncate) continue;
      const maxChars = tokensToChars(this.config.artifact_slice_size);
      if (slice.content.length > maxChars) {
        const { text } = truncateContent(slice.content, maxChars);
        slice.content = text;
        slice.tokens = charsToTokens(text.length);
        if (!truncated.includes(slice.key)) truncated.push(slice.key);
      }
    }

    const finalSlices: Record<string, string> = {};
    for (const slice of loaded) {
      if (slice.content) {
        finalSlices[slice.key] = slice.content;
      }
    }

    return { slices: finalSlices, truncated };
  }

  // Resolve the slice definitions for a role, applying conditions
  private resolveSliceDefs(
    role: AgentRole,
    ctx: StepRunContext,
    _runDir: string | undefined
  ): SliceDef[] {
    return getRoleSlices(role, ctx);
  }

  // Load the raw content for a single slice definition
  private async loadSliceContent(
    def: SliceDef,
    ctx: StepRunContext,
    runDir: string | undefined
  ): Promise<string | null> {
    // Ephemeral artifacts — injected for this step, no disk read
    const ephemeralContent = ctx.ephemeral?.[def.ref];
    if (ephemeralContent !== undefined) return ephemeralContent;

    // summary_only: check for pre-generated summary first
    if (def.mode === 'summary_only') {
      const summaryPath = resolveSummaryPath(this.projectRoot, def.ref);
      if (summaryPath) {
        const summary = await this.safeReadFile(summaryPath);
        if (summary) return summary;
      }
      // Fall back to first N lines of the full document
      const fullPath = resolveArtifactPath(def.ref, this.projectRoot, runDir);
      if (!fullPath) return null;
      const full = await this.safeReadFile(fullPath);
      if (!full) return null;
      const lines = full.split('\n');
      if (lines.length <= SUMMARY_PREVIEW_LINES) return full;
      return (
        lines.slice(0, SUMMARY_PREVIEW_LINES).join('\n') +
        '\n[...document continues — full version available on request...]'
      );
    }

    const filePath = resolveArtifactPath(def.ref, this.projectRoot, runDir);
    if (!filePath) return null;
    return this.safeReadFile(filePath);
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
