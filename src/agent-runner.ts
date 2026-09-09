import { promises as nodeFsPromises } from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'node:crypto';
import type { AgentRole, AssembledContext } from './types.js';
import type { ContextManager } from './context-manager.js';
import type { ILLMProvider, LLMCompletionParams } from './llm-provider.js';
import type { RunArtifactManager } from './run-artifacts.js';
import type { StepRunContext } from './workflow/types.js';
import type { ArtifactRepository } from './storage/repositories.js';
import { toSafeRelativePath } from './path-safety.js';
import { AgentLoop } from './agent-loop.js';
import {
  type ResultTransport,
  type StepResult,
  TransportParseError,
  repairDecision,
  formatRepairExhaustedDiagnostic,
} from './transport/step-result.js';
import {
  extractLegacyReviewRoute,
  resolveResultTransport,
} from './transport/textual-sle-output.js';

// D.3d.5 commit 1 — the single-turn preamble parser (parseAgentOutput +
// SLEOutputPreamble/ParsedSingleTurnOutput types) MOVED to the transport
// layer (src/transport/textual-sle-output.ts), which now owns ALL raw-result
// extraction for both execution paths. Re-exported here for backward
// compatibility with existing tests/importers; AgentRunner itself consumes
// ONLY StepResult — it never sees YAML preambles, HTML comments, or
// delimiters.
export {
  parseAgentOutput,
  extractLegacyReviewRoute,
  type SLEOutputPreamble,
  type ParsedSingleTurnOutput,
} from './transport/textual-sle-output.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AgentRunResult {
  success: boolean;
  artifacts_written: string[];
  tokens_used: number;
  duration_ms: number;
  raw_output_path: string;
  error?: string;
  // D.3b0 — the semantic review verdict, set only when ctx.requiresReviewVerdict
  // was true AND execution succeeded with a valid `verdict: pass | fail` in
  // the transport-extracted StepResult. See run() below.
  reviewVerdict?: 'pass' | 'fail';
  // D.3c1a — the validated route token, set only when reviewVerdict is
  // 'fail' AND ctx.on_fail_routes was declared AND the legacy textual
  // `route:` token matched one of its keys exactly. SOLE sanctioned
  // migration exception: parsed by the transport (extractLegacyReviewRoute),
  // removed when commit 3 derives routes deterministically.
  reviewRoute?: string;
  // D.3d.5 commit 1 — bounded format-repair attempts on this step's
  // multi-turn execution, tracked separately from turns_taken (which counts
  // every provider call). Precise semantics: turns_taken = all provider
  // calls; format_repairs = repair prompts issued for non-compliant replies.
  format_repairs?: number;
}

// ─── Write-path validation (DDR-019) ─────────────────────────────────────────

// 'builder' is the only role with no entry here — it may write to any path
// except BUILDER_DENY_PREFIXES below (see the role === 'builder' branch in
// validateOutputPath). Every other role, including 'explorer' (D.1b), has an
// explicit allowlist; an absent entry for any of THOSE roles would mean
// unrestricted writes (see the `if (!allowed) return true` fallback below) —
// that fallback exists only for roles genuinely not yet assigned a ceiling,
// not as a documented behavior to rely on.
// Entries ending with '/' are prefix matches (any path under that directory),
// matched against the canonical path from path-safety.ts, never the raw
// LLM-produced string — see toSafeRelativePath's doc comment for why.
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

// filePath must already be the canonical value from toSafeRelativePath() —
// callers must canonicalize (and reject on null) before reaching here.
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

// ─── AgentRunner ──────────────────────────────────────────────────────────────

export interface AgentRunnerConfig {
  model: string;
  temperature?: number;
  max_tokens?: number;
  // D.3d.5 commit 1 — result transport override (tests, future structured
  // adapters). Defaults to the textual SLE-OUTPUT fallback transport; see
  // transport/step-result.ts for the seam contract.
  resultTransport?: ResultTransport;
}

const RUNNER_DEFAULTS: Required<Omit<AgentRunnerConfig, 'model' | 'resultTransport'>> = {
  temperature: 0.7,
  max_tokens: 4096,
};

export class AgentRunner {
  private fs: typeof import('fs').promises;
  // D.3d.5 commit 1 — the resolved result transport (serialization seam).
  private resultTransport: ResultTransport;

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
    this.resultTransport = resolveResultTransport(llmProvider, runnerConfig.resultTransport);
  }

  async run(role: AgentRole, ctx: StepRunContext): Promise<AgentRunResult> {
    const start = Date.now();

    // 1. Assemble context
    const context = await this.contextManager.assemble(role, ctx);

    let parsed: { sections: Array<{ path: string; content: string }> };
    let tokensUsed = 0;
    // D.3d.5 commit 1 — bounded format-repair attempts (multi-turn only).
    let formatRepairs: number | undefined;
    let rawPath = '';
    // D.3b0 — the review verdict from the transport's StepResult (review
    // is set only when the reply declared a valid 'pass' | 'fail'). Set on
    // either execution path; validated against ctx.requiresReviewVerdict
    // after both branches.
    let reviewVerdictRaw: string | undefined;
    // D.3c1a — same story for the optional bounded-routing token.
    let reviewRouteRaw: string | undefined;

    const nodeId = ctx.stepId ?? role.toUpperCase();

    // Check if the provider supports native multi-turn execution (DDR-030 integration).
    // D.3b1 — a step that opted into requiresReviewVerdict is deliberately
    // forced onto the single-turn path even when the provider supports
    // multi-turn: REVIEW EXECUTION POLICY (D.3d.5 closure wording) — reviews
    // currently run single-turn by EXECUTION POLICY / migration behavior,
    // NOT because of a transport limitation: since D.3d.5, StepResult can
    // carry `review.verdict` on any path. Whether reviews should eventually
    // run multi-turn (with tool access) is a separate, evidence-gated
    // decision — deliberately out of scope for D.3.
    const isMultiTurn =
      !ctx.requiresReviewVerdict &&
      typeof (this.llmProvider as any).completeMultiTurn === 'function';

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
          // D.3d.5 commit 1 — the loop delegates serialization (syntax
          // teaching, extraction, bounded format repair) to the transport.
          resultTransport: this.resultTransport,
          // D.3d.5 closure — real execution metadata on this path too:
          // the multi-turn transport must never fall back to generic
          // placeholders when the step declares an actual output artifact.
          declaredArtifactId: ctx.outputArtifact?.type,
          declaredOutputPath: ctx.outputArtifact?.path,
          expectedArtifacts: ctx.outputArtifact ? 1 : undefined,
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
      formatRepairs = loopResult.format_repairs;
      // Write the final text as raw output (always, even on multi-turn success)
      rawPath = await this.writeRaw(ctx, nodeId, loopResult.rawText || '');

    } else {
      // Single-turn fallback (original logic)
      // D.3d.5 commit 1 — ALL raw-result handling is transport-owned on this
      // path too: the transport teaches the wire shape (generated from this
      // step's actual metadata) AND performs the extraction. AgentRunner
      // consumes only StepResult and cannot tell which representation the
      // provider used — a structured/native transport drops in without any
      // change here.
      const transportCtx = {
        role,
        requiresReviewVerdict: ctx.requiresReviewVerdict === true,
        execution: 'single-turn' as const,
        nodeId,
        declaredArtifactId: ctx.outputArtifact?.type,
        declaredOutputPath: ctx.outputArtifact?.path,
        expectedArtifacts: ctx.outputArtifact ? 1 : undefined,
      };
      const userContent =
        buildUserMessage(context) +
        '\n\n' +
        this.resultTransport.formatInstruction(transportCtx);
      const baseMessages: LLMCompletionParams['messages'] = [
        {
          role: 'system',
          content: context.system_prompt || 'You are a helpful software engineering assistant.',
        },
      ];

      // D.3d.5 closure — the single-turn path receives the SAME bounded
      // format-repair policy as the multi-turn loop (shared repairDecision +
      // diagnostic; budget NOT raised). Repair mechanics: a genuine
      // CONTINUATION of the original request — the repair conversation keeps
      // the original system prompt, the original task/context, and the
      // transport teaching, represents the previous non-compliant reply as
      // the previous ASSISTANT turn, and asks for a reformat via the
      // transport's repair instruction. Never a context-poor fresh task.
      // Evidence preservation: providerCalls/tokensUsed/formatRepairs/raw
      // accumulate across the original call and every repair attempt — a
      // provider exception on a repair call must not erase earlier evidence.
      let providerCalls = 0;
      formatRepairs = 0;
      let repairMessage = '';
      let raw = '';
      let stepResult: StepResult | undefined;
      let transportError: string | undefined;
      let providerError: string | undefined;

      while (providerError === undefined && transportError === undefined && stepResult === undefined) {
        let llmResult;
        try {
          llmResult = await this.llmProvider.complete({
            model: this.runnerConfig.model,
            messages:
              providerCalls === 0
                ? [...baseMessages, { role: 'user', content: userContent }]
                : [
                    ...baseMessages,
                    { role: 'user', content: userContent },
                    // the previous non-compliant reply, AS an assistant turn
                    { role: 'assistant', content: raw },
                    { role: 'user', content: repairMessage },
                  ],
            temperature: this.runnerConfig.temperature ?? RUNNER_DEFAULTS.temperature,
            max_tokens: this.runnerConfig.max_tokens ?? RUNNER_DEFAULTS.max_tokens,
          });
        } catch (err) {
          providerError = `LLM call failed: ${err instanceof Error ? err.message : String(err)}`;
          break;
        }

        providerCalls++;
        tokensUsed += llmResult.tokens_used;
        raw = llmResult.content;

        try {
          // D.3d.5 commit 1 (review amendment) — extraction is transport-owned:
          // the runner never parses raw replies itself. The route token below
          // is LEGACY, read only to feed the interim D.3c1a allowlist gate; it
          // is not part of StepResult and commit 3 replaces it with
          // deterministic derivation from validated gap classifications.
          stepResult = this.resultTransport.extractSingleTurn(raw, transportCtx);
        } catch (err) {
          if (!(err instanceof TransportParseError)) {
            transportError = `Output parsing failed: ${err instanceof Error ? err.message : String(err)}`;
            break;
          }
          if (repairDecision(formatRepairs).action === 'fail-closed') {
            transportError = formatRepairExhaustedDiagnostic(err, providerCalls, formatRepairs);
            break;
          }
          formatRepairs++;
          repairMessage = this.resultTransport.repairInstruction(transportCtx, err.kind, err.reason);
        }
      }

      if (providerError !== undefined) {
        // Repair-call (or first-call) provider exception: preserve ALL prior
        // evidence — accumulated tokens, repair attempts, latest raw reply.
        rawPath = await this.writeRaw(ctx, nodeId, raw);
        return {
          success: false,
          artifacts_written: [],
          tokens_used: tokensUsed,
          duration_ms: Date.now() - start,
          raw_output_path: rawPath,
          ...(formatRepairs > 0 ? { format_repairs: formatRepairs } : {}),
          error: providerError,
        };
      }

      if (transportError || !stepResult) {
        rawPath = await this.writeRaw(ctx, nodeId, raw);
        return {
          success: false,
          artifacts_written: [],
          tokens_used: tokensUsed,
          duration_ms: Date.now() - start,
          raw_output_path: rawPath,
          ...(formatRepairs !== undefined && formatRepairs > 0 ? { format_repairs: formatRepairs } : {}),
          error: transportError ?? 'Step produced no result',
        };
      }

      // Raw output is written on success too (as before D.3d.5) — the raw
      // reply remains the debugging record regardless of parse outcome.
      rawPath = await this.writeRaw(ctx, nodeId, raw);
      parsed = { sections: stepResult.artifacts };
      reviewVerdictRaw = stepResult.review?.verdict;
      reviewRouteRaw = extractLegacyReviewRoute(raw);
    }

    const fail = (error: string): AgentRunResult => ({
      success: false,
      artifacts_written: [],
      tokens_used: tokensUsed,
      duration_ms: Date.now() - start,
      raw_output_path: rawPath,
      error,
    });

    // 5b. D.3b0 — semantic review verdict gate (opt-in via ctx.requiresReviewVerdict,
    // copied from WorkflowStep.requiresReviewVerdict by WorkflowEngine). A
    // transport/parse/write failure already returned above and never reaches
    // here. This check treats a *missing or invalid* verdict on an otherwise-
    // successful execution as an execution failure too — fail closed, before
    // any output is written — because neither "the model didn't declare a
    // verdict" nor "it declared something unparseable" is a semantic
    // judgment WorkflowEngine.executeReview may route through on_fail/on_pass.
    // A validly declared 'pass' or 'fail' is NOT gated here; both proceed
    // through the ordinary write + provenance path below exactly the same way,
    // so a semantic-fail review artifact is preserved just like a pass.
    let reviewVerdict: 'pass' | 'fail' | undefined;
    if (ctx.requiresReviewVerdict) {
      if (reviewVerdictRaw !== 'pass' && reviewVerdictRaw !== 'fail') {
        return fail(
          `Step requires a review verdict but the reply declared '${reviewVerdictRaw ?? 'none'}' (expected 'pass' or 'fail')`,
        );
      }
      reviewVerdict = reviewVerdictRaw;
    }

    // D.3c1a — bounded semantic-fail routing gate. Only meaningful on a
    // 'fail' verdict for a step that declared on_fail_routes (an allowlist
    // of tokens the WORKFLOW author authorized — never a raw step id). A
    // missing or unrecognized token is treated exactly like a missing/
    // invalid verdict above: fail closed, before any output is written, so
    // no artifact/control routing can ever occur from an invalid route.
    // 'pass' never requires (or validates) a route — on_pass stays
    // authoritative regardless of what the reply happens to contain.
    let reviewRoute: string | undefined;
    if (reviewVerdict === 'fail' && ctx.on_fail_routes) {
      const allowedRoutes = Object.keys(ctx.on_fail_routes);
      if (!reviewRouteRaw || !allowedRoutes.includes(reviewRouteRaw)) {
        return fail(
          `Review step requires a route (one of: ${allowedRoutes.join(', ')}) but the reply declared '${reviewRouteRaw ?? 'none'}'`,
        );
      }
      reviewRoute = reviewRouteRaw;
    }

    // 6a. D.1c — canonicalize every produced path exactly once, before any
    // other check. This is THE single value used from here on for exact
    // matching, the role ceiling, the filesystem write, and (for a declared
    // output) ArtifactRecord.path — validation and the write can never
    // diverge, because there is only one path.safety.ts pass and everything
    // downstream reads its output rather than the raw LLM string again.
    const canonicalSections: Array<{ path: string; content: string }> = [];
    for (const section of parsed.sections) {
      const safe = toSafeRelativePath(section.path);
      if (safe === null) {
        return fail(`Unsafe output path '${section.path}'`);
      }
      canonicalSections.push({ path: safe, content: section.content });
    }

    // 6b. A declared output narrows what may be written: exactly one
    // section, at exactly the declared (canonical) path. Compared against
    // canonicalSections, never the raw parsed.sections.
    if (ctx.outputArtifact) {
      const declaredSafe = toSafeRelativePath(ctx.outputArtifact.path);
      if (declaredSafe === null) {
        return fail(`Declared output path '${ctx.outputArtifact.path}' is not a safe project-root-relative path`);
      }
      if (canonicalSections.length !== 1) {
        return fail(`Step declares exactly one output artifact ('${declaredSafe}') but produced ${canonicalSections.length} section(s)`);
      }
      if (canonicalSections[0].path !== declaredSafe) {
        return fail(`Step declared output '${declaredSafe}' but produced '${canonicalSections[0].path}'`);
      }
    }

    // 6c. The role's broad ceiling (DDR-019), checked against the same
    // canonical path used everywhere else. A declared output only narrows
    // §6b above — it never bypasses this: the declared path must also fall
    // within ROLE_OUTPUT_PATHS.
    for (const section of canonicalSections) {
      if (!validateOutputPath(section.path, role)) {
        return fail(`Role '${role}' is not permitted to write '${section.path}'`);
      }
    }

    // 7. Write artifacts — canonical paths only.
    const artifactsWritten: string[] = [];
    for (const section of canonicalSections) {
      const filePath = path.join(this.projectRoot, section.path);
      await this.fs.mkdir(path.dirname(filePath), { recursive: true });
      if (APPEND_ONLY_PATHS.has(section.path)) {
        await this.fs.appendFile(filePath, section.content, 'utf-8');
      } else {
        await this.fs.writeFile(filePath, section.content, 'utf-8');
      }
      artifactsWritten.push(section.path);
    }

    // 8. D.1b/D.1c — record provenance for a declared output. Deduped by
    // (workflowRunId, ref, hash) rather than just (workflowRunId, ref): a
    // retry that reproduces the same content is a no-op, but iterative
    // refinement (same ref, changed content — e.g. Definition v1 → v2)
    // records a new version rather than going stale under an unchanged row.
    // ArtifactRepository keeps the full version history; StratumAgentAdapter
    // projects the latest row per ref for ExecutionResult.artifacts.
    // stepExecutionId is deliberately left unset: the Scheduler creates one
    // outer StepExecution per adapter invocation, not one per WorkflowStep,
    // so there is no naturally-available per-step id here yet (see
    // docs/developmentPlan/d1a-declarative-contract-spike.md §4).
    if (ctx.outputArtifact && this.artifactRepository) {
      const hash = createHash('sha256').update(canonicalSections[0].content).digest('hex');
      const already = this.artifactRepository.findByWorkflowRunRefAndHash(
        ctx.workflowRunId,
        ctx.outputArtifact.ref,
        hash,
      );
      if (!already) {
        this.artifactRepository.save({
          id: randomUUID(),
          workItemId: ctx.workItemId,
          workflowRunId: ctx.workflowRunId,
          type: ctx.outputArtifact.type,
          ref: ctx.outputArtifact.ref,
          path: artifactsWritten[0],
          hash,
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
      reviewVerdict,
      reviewRoute,
      ...(formatRepairs !== undefined ? { format_repairs: formatRepairs } : {}),
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
