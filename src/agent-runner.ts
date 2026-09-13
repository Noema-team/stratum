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
  resultRepairDecision,
  resultRepairExhaustedDiagnostic,
  resultKindNegotiationDiagnostic,
} from './transport/step-result.js';
import {
  resolveResultTransport,
} from './transport/textual-sle-output.js';
import {
  type OutputContract,
  type OutputContractRegistry,
  type ResultAcceptor,
  type OutputContractContext,
  createResultAcceptor,
  renderSchemaTeaching,
  toJsonSchema,
} from './workflow/contracts.js';

// D.3d.5 commit 1 — the single-turn preamble parser (parseAgentOutput +
// SLEOutputPreamble/ParsedSingleTurnOutput types) MOVED to the transport
// layer (src/transport/textual-sle-output.ts), which now owns ALL raw-result
// extraction for both execution paths. Re-exported here for backward
// compatibility with existing tests/importers; AgentRunner itself consumes
// ONLY StepResult — it never sees YAML preambles, HTML comments, or
// delimiters. (D.3d.5 commit 3 removed the legacy `route:` extraction —
// routes are derived, never parsed from the reply.)
export {
  parseAgentOutput,
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
  // D.3c1a — the route token, set only when reviewVerdict is 'fail' AND
  // ctx.on_fail_routes was declared. D.3d.5 commit 3 — NEVER model-authored:
  // derived deterministically from the readiness artifact's structured gap
  // classifications (GAP_CLASSIFICATION_PRECEDENCE) via the
  // deriveReviewRoute seam, then checked against the step's own declared
  // keys. Without a registered deriver, a step declaring exactly ONE
  // fail route uses it deterministically; multiple routes without a
  // deriver is a workflow-authoring error (fail closed).
  reviewRoute?: string;
  // D.3d.5 commit 1 — bounded format-repair attempts on this step's
  // multi-turn execution, tracked separately from turns_taken (which counts
  // every provider call). Precise semantics: turns_taken = all provider
  // calls; format_repairs = repair prompts issued for non-compliant replies.
  format_repairs?: number;
  // D.34 C1 — contract decode/validate repair attempts, tracked SEPARATELY
  // from format_repairs (repair taxonomy: format repair / result repair /
  // workflow refine). A result repair never consumes a workflow refinement
  // iteration; exhaustion fails the step closed before any write.
  result_repairs?: number;
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
  // D.3d.5 commit 2 — registered deterministic input validators, keyed by
  // the WorkflowStep.inputValidator declared name. A validator receives the
  // raw text of the step's FIRST declared input artifact and either accepts
  // it or returns structured defects. The runner is generic: it knows the
  // contract, never what 'definition' (or any other name) means — the
  // composition root wires the methodology-owned implementations.
  inputValidators?: Record<string, InputValidator>;
  // D.3d.5 commit 3 — the review-route derivation seam. Receives the
  // review step's produced artifact text and the step's OWN declared route
  // tokens, and returns the deterministic route (or a fail-closed error).
  // The runner is generic: it never learns what a gap classification is —
  // the composition root wires the methodology-owned deriver. When absent,
  // a step declaring exactly ONE fail route uses it deterministically;
  // multiple declared routes without a deriver fail closed (authoring
  // error) — the model is never asked to break the tie.
  deriveReviewRoute?: (
    artifactText: string,
    declaredRoutes: readonly string[],
  ) => { ok: true; route: string } | { ok: false; error: string };
  // D.34 C1 — the output-contract registry (DDR-034 §5.3), keyed by the
  // workflow's OWN declaration (WorkflowStep.outputArtifact.type). The
  // composition root wires methodology-owned contracts; the runner is
  // generic. Contract identity exists exactly once — this registry key. A
  // step whose type has no entry here runs the legacy materialized-bytes
  // path, byte-for-byte unchanged. (Typed as unknown rather than never:
  // the runner treats T opaquely through the acceptor/hooks.)
  outputContracts?: OutputContractRegistry;
}

/**
 * D.3d.5 commit 2 — the generic input-validator contract. Deliberately
 * shape-agnostic: the validator decides what the artifact must look like;
 * the runner only knows accept/reject + structured defects. The optional
 * second parameter carries the run context the runner generically knows
 * (the step's work item) so a validator can resolve references against the
 * right control-plane scope — the runner never interprets it.
 */
export type InputValidator = (
  artifactText: string,
  context?: { workItemId?: string },
) => { ok: true } | { ok: false; failure: { defects: Array<{ code: string; factId?: string; message: string }> } };

const RUNNER_DEFAULTS: Required<Omit<AgentRunnerConfig, 'model' | 'resultTransport' | 'inputValidators' | 'deriveReviewRoute' | 'outputContracts'>> = {
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

    // 0. D.3d.5 commit 2 — deterministic INPUT VALIDATION GATE. When the
    // step declares an inputValidator, the step's first declared input
    // artifact is parsed+validated BEFORE any LLM call. On defects the
    // reviewer is NEVER invoked: the step deterministically yields
    // verdict 'fail' + the refine route (the existing CAN_RESOLVE path)
    // and writes a readiness artifact carrying the structured defects,
    // which the existing refine step already consumes as input. This is
    // the narrowest seam that makes deterministic validation authoritative
    // before semantic review — no new StepKind, route, loop, or status.
    if (ctx.inputValidator !== undefined) {
      const gateResult = await this.runInputValidationGate(ctx);
      if (gateResult !== null) return gateResult;
    }

    // 0.5. D.34 C1 — output-contract resolution + fail-closed authoring
    // checks, BEFORE any LLM call. The registry key is the workflow's own
    // declaration; no transport, provider, or model ever names a contract.
    // Own-property semantics are mandatory: DeclaredOutputArtifact.type is
    // an unrestricted string, and a plain-object registry would otherwise
    // resolve inherited Object.prototype members ('toString', '__proto__',
    // 'constructor', …) into a phantom contract path. A key that is not an
    // OWN property of the registry is unregistered — full stop.
    const artifactType = ctx.outputArtifact?.type;
    const contract: OutputContract<unknown> | undefined =
      artifactType !== undefined &&
      this.runnerConfig.outputContracts !== undefined &&
      Object.hasOwn(this.runnerConfig.outputContracts, artifactType)
        ? this.runnerConfig.outputContracts[artifactType]
        : undefined;
    const contractPath = contract !== undefined;
    if (contractPath) {
      if (ctx.requiresReviewVerdict && !contract.reviewVerdict) {
        return {
          success: false,
          artifacts_written: [],
          tokens_used: 0,
          duration_ms: Date.now() - start,
          raw_output_path: '',
          error: `Step declares requiresReviewVerdict but the output contract for '${artifactType}' provides no reviewVerdict — authoring error (fail closed, no LLM call)`,
        };
      }
      if (ctx.on_fail_routes && !contract.deriveRoute) {
        return {
          success: false,
          artifacts_written: [],
          tokens_used: 0,
          duration_ms: Date.now() - start,
          raw_output_path: '',
          error: `Step declares fail routes (${Object.keys(ctx.on_fail_routes).join(', ')}) but the output contract for '${artifactType}' provides no deriveRoute — authoring error (fail closed, no LLM call)`,
        };
      }
    }
    // The acceptor gates a proposal INSIDE the executing loop (multi-turn
    // continuation / single-turn re-issue) — decode + validate against the
    // resolved contract. Built only on the contract path; absent otherwise,
    // leaving legacy steps byte-for-byte unchanged.
    let acceptor: ResultAcceptor | undefined;
    if (contract) {
      acceptor = createResultAcceptor(contract, { workItemId: ctx.workItemId } satisfies OutputContractContext, artifactType!);
    }

    // 1. Assemble context
    const context = await this.contextManager.assemble(role, ctx);

    let parsed: { sections: Array<{ path: string; content: string }> };
    let tokensUsed = 0;
    // D.3d.5 commit 1 — bounded format-repair attempts (multi-turn only).
    let formatRepairs: number | undefined;
    // D.34 C1 — contract decode/validate repair attempts (both paths).
    let resultRepairs: number | undefined;
    let rawPath = '';
    // D.3b0 — the review verdict from the transport's StepResult (review
    // is set only when the reply declared a valid 'pass' | 'fail'). Set on
    // either execution path; validated against ctx.requiresReviewVerdict
    // after both branches. On the contract path it comes from the
    // contract's reviewVerdict hook — the semantic payload is the only
    // place the verdict lives (never the transport preamble).
    let reviewVerdictRaw: string | undefined;
    // D.34 C1 — the decoded contract value, kept for the deterministic
    // route-derivation hook (typed gaps in — no artifact parse-back).
    let contractValue: unknown;

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
          // D.34 C5 — ONLY an explicitly configured override is forwarded:
          // forwarding the runner's resolved default would outrank the
          // loop's negotiation and pin every multi-turn contract step to
          // the textual channel. Without an explicit override, the loop
          // negotiates (submit-result for schema-carrying steps on
          // multi-turn-capable providers; textual everywhere else).
          ...(this.runnerConfig.resultTransport ? { resultTransport: this.resultTransport } : {}),
          // D.3d.5 closure — real execution metadata on this path too:
          // the multi-turn transport must never fall back to generic
          // placeholders when the step declares an actual output artifact.
          declaredArtifactId: ctx.outputArtifact?.type,
          declaredOutputPath: ctx.outputArtifact?.path,
          expectedArtifacts: ctx.outputArtifact ? 1 : undefined,
          // D.34 C1 — schema projections + the result-repair seam. Both are
          // absent on the legacy path, leaving it byte-for-byte unchanged.
          ...(contract
            ? {
                acceptResult: acceptor,
                resultSchemaText: renderSchemaTeaching(contract),
                resultSchemaJson: toJsonSchema(contract.modelSchema),
              }
            : {}),
        }
      );

      const systemPrompt = context.system_prompt || 'You are a helpful software engineering assistant.';
      const userMessage = buildUserMessage(context);

      const loopResult = await loop.run(systemPrompt, userMessage);
      tokensUsed = loopResult.tokens_used;
      formatRepairs = loopResult.format_repairs;
      resultRepairs = loopResult.result_repairs;

      if (!loopResult.success) {
        rawPath = await this.writeRaw(ctx, nodeId, '');
        return {
          success: false,
          artifacts_written: [],
          tokens_used: tokensUsed,
          duration_ms: Date.now() - start,
          raw_output_path: rawPath,
          ...(loopResult.format_repairs > 0 ? { format_repairs: loopResult.format_repairs } : {}),
          ...(loopResult.result_repairs > 0 ? { result_repairs: loopResult.result_repairs } : {}),
          error: loopResult.error,
        };
      }

      // Write the final text as raw output (always, even on multi-turn success)
      rawPath = await this.writeRaw(ctx, nodeId, loopResult.rawText || '');

      if (loopResult.proposal) {
        // D.34 C1 — contract path: the acceptor gated the proposal inside
        // the loop; decode again here (deterministic, cheap) for the typed
        // value, then materialize. The transport never declared a contract —
        // the workflow's registry lookup already fixed it.
        const processed = this.processContractResult(contract!, loopResult.proposal.value, ctx);
        if (!processed.ok) {
          return {
            success: false,
            artifacts_written: [],
            tokens_used: tokensUsed,
            duration_ms: Date.now() - start,
            raw_output_path: rawPath,
            ...(resultRepairs && resultRepairs > 0 ? { result_repairs: resultRepairs } : {}),
            error: processed.error,
          };
        }
        parsed = { sections: processed.sections };
        reviewVerdictRaw = processed.verdict;
        contractValue = processed.typed;
      } else {
        if (contractPath) {
          // Rule 4 (DDR-034 §5.3): a step whose type has a registered
          // contract must never receive materialized bytes — the contract
          // path cannot be silently bypassed by a stale transport.
          return {
            success: false,
            artifacts_written: [],
            tokens_used: tokensUsed,
            duration_ms: Date.now() - start,
            raw_output_path: rawPath,
            error: resultKindNegotiationDiagnostic(
              artifactType!,
              'the transport produced materialized bytes where an output contract is registered',
            ),
          };
        }
        parsed = loopResult.parsedOutput!;
      }

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
        // D.34 C1 — runner-generated projections; absent on the legacy path.
        ...(contract
          ? {
              resultSchemaText: renderSchemaTeaching(contract),
              resultSchemaJson: toJsonSchema(contract.modelSchema),
            }
          : {}),
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
      resultRepairs = 0;
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
          continue;
        }

        // D.34 C1 — the result-repair seam, single-turn mechanics (DDR-034
        // §5.3): a proposal is gated by the acceptor INSIDE the loop, so a
        // decode/validate defect re-issues the completion carrying the
        // acceptor's repair instruction — the same continuation mechanics
        // this loop already uses for format repair, but on its own budget
        // and counter, never consuming a workflow iteration. Exhaustion
        // fails the step closed BEFORE anything is written.
        if (stepResult.kind === 'proposal') {
          if (!acceptor) {
            transportError = resultKindNegotiationDiagnostic(
              artifactType!,
              'the transport produced a semantic proposal but no output contract is registered for the declared type',
            );
            break;
          }
          const acceptance = acceptor(stepResult.value);
          if (!acceptance.ok) {
            if (resultRepairDecision(resultRepairs).action === 'fail-closed') {
              transportError = resultRepairExhaustedDiagnostic(
                artifactType!,
                acceptance.repairInstruction,
                providerCalls,
                resultRepairs,
              );
              break;
            }
            resultRepairs++;
            repairMessage = acceptance.repairInstruction;
            stepResult = undefined; // loop re-issues with the repair message appended
            continue;
          }
        } else if (contractPath) {
          // Rule 4 (DDR-034 §5.3): contract registered, materialized bytes
          // produced — a stale/negotiation-broken transport. Fail closed.
          transportError = resultKindNegotiationDiagnostic(
            artifactType!,
            'the transport produced materialized bytes where an output contract is registered',
          );
          break;
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
          ...(resultRepairs !== undefined && resultRepairs > 0 ? { result_repairs: resultRepairs } : {}),
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
          ...(resultRepairs !== undefined && resultRepairs > 0 ? { result_repairs: resultRepairs } : {}),
          error: transportError ?? 'Step produced no result',
        };
      }

      // Raw output is written on success too (as before D.3d.5) — the raw
      // reply remains the debugging record regardless of parse outcome.
      rawPath = await this.writeRaw(ctx, nodeId, raw);
      if (stepResult.kind === 'materialized') {
        parsed = { sections: stepResult.artifacts };
        reviewVerdictRaw = stepResult.review?.verdict;
      } else {
        // D.34 C1 — contract path: the acceptor gated the proposal inside
        // the loop; decode again here (deterministic, cheap) for the typed
        // value, then materialize canonical bytes.
        const processed = this.processContractResult(contract!, stepResult.value, ctx);
        if (!processed.ok) {
          return {
            success: false,
            artifacts_written: [],
            tokens_used: tokensUsed,
            duration_ms: Date.now() - start,
            raw_output_path: rawPath,
            ...(resultRepairs && resultRepairs > 0 ? { result_repairs: resultRepairs } : {}),
            error: processed.error,
          };
        }
        parsed = { sections: processed.sections };
        reviewVerdictRaw = processed.verdict;
        contractValue = processed.typed;
      }
    }

    const fail = (error: string): AgentRunResult => ({
      success: false,
      artifacts_written: [],
      tokens_used: tokensUsed,
      duration_ms: Date.now() - start,
      raw_output_path: rawPath,
      ...(formatRepairs !== undefined && formatRepairs > 0 ? { format_repairs: formatRepairs } : {}),
      ...(resultRepairs !== undefined && resultRepairs > 0 ? { result_repairs: resultRepairs } : {}),
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
    // of tokens the WORKFLOW author authorized — never a raw step id).
    // D.3d.5 commit 3 — the route is NEVER model-authored. It is derived
    // deterministically from the review step's produced artifact (its
    // structured gap classifications) via the deriveReviewRoute seam,
    // then checked against the same allowlist as before. Derivation
    // failure is treated exactly like a missing/invalid verdict above:
    // fail closed, before any output is written, so no artifact/control
    // routing can ever occur from an unparseable or misclassified state.
    // 'pass' never requires (or validates) a route — on_pass stays
    // authoritative regardless of what the reply happens to contain.
    // Without a registered deriver, a step declaring exactly ONE fail
    // route uses it deterministically (no judgment involved); multiple
    // declared routes without a deriver fail closed — the model is never
    // asked to break the tie.
    let reviewRoute: string | undefined;
    if (reviewVerdict === 'fail' && ctx.on_fail_routes) {
      const allowedRoutes = Object.keys(ctx.on_fail_routes);
      if (contractPath) {
        // D.34 C1 — the contract path derives the route from TYPED values
        // (the contract's deriveRoute hook over the decoded proposal): no
        // artifact parse-back. Absence of the hook already failed closed as
        // an authoring error before the LLM call; this is defense in depth.
        if (!contract!.deriveRoute) {
          return fail(
            `Review step requires a derivable route (one of: ${allowedRoutes.join(', ')}) but the output contract for '${artifactType}' provides no deriveRoute — authoring error (fail closed)`,
          );
        }
        const derived = contract!.deriveRoute(contractValue, allowedRoutes);
        if (!derived.ok || !allowedRoutes.includes(derived.route)) {
          return fail(
            `Review step requires a derivable route (one of: ${allowedRoutes.join(', ')}) but the produced proposal does not determine one: ${derived.ok ? `derived '${derived.route}' is not declared` : derived.error}`,
          );
        }
        reviewRoute = derived.route;
      } else if (this.runnerConfig.deriveReviewRoute) {
        const artifactText = parsed.sections.find(
          (s) => !ctx.outputArtifact || s.path === ctx.outputArtifact.path,
        )?.content ?? parsed.sections[0]?.content ?? '';
        const derived = this.runnerConfig.deriveReviewRoute(artifactText, allowedRoutes);
        if (!derived.ok || !allowedRoutes.includes(derived.route)) {
          return fail(
            `Review step requires a derivable route (one of: ${allowedRoutes.join(', ')}) but the produced artifact does not determine one: ${derived.ok ? `derived '${derived.route}' is not declared` : derived.error}`,
          );
        }
        reviewRoute = derived.route;
      } else {
        if (allowedRoutes.length !== 1) {
          return fail(
            `Review step declares ${allowedRoutes.length} fail routes (one of: ${allowedRoutes.join(', ')}) but no route deriver is registered — cannot choose deterministically (fail closed)`,
          );
        }
        reviewRoute = allowedRoutes[0];
      }
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
      // C1 review fix — result_repairs is externally visible only when an
      // actual result repair occurred (which is only possible on the
      // contract path). A legacy run's observable shape is byte-for-byte
      // its pre-C1 form: no zero-count result_repairs key.
      ...(resultRepairs !== undefined && resultRepairs > 0 ? { result_repairs: resultRepairs } : {}),
    };
  }

  /**
   * D.34 C1 — contract-path post-processing of an ACCEPTED proposal (the
   * acceptor has already gated decode+validate inside the executing loop).
   * Decodes again — deterministic and cheap — for the typed value, then
   * materializes canonical artifact bytes at the DECLARED path. The model
   * never authored bytes, paths, or schema versions; this is where Stratum
   * does (DDR-034 §5.3). The returned sections flow into the SAME
   * canonicalization / role-ceiling / write / provenance pipeline as the
   * legacy path.
   */
  private processContractResult(
    contract: OutputContract<unknown>,
    value: unknown,
    ctx: StepRunContext,
  ): { ok: true; sections: Array<{ path: string; content: string }>; verdict?: string; typed: unknown } | { ok: false; error: string } {
    if (!ctx.outputArtifact) {
      return { ok: false, error: 'Contract path requires a declared outputArtifact — authoring error' };
    }
    const redecoded = contract.modelSchema.safeParse(value);
    if (!redecoded.success) {
      // Defense in depth: the acceptor approved this value inside the loop.
      // A failure here means non-deterministic decode — fail closed.
      return {
        ok: false,
        error: `Accepted proposal failed re-decode against the '${ctx.outputArtifact.type}' contract — non-deterministic decode (fail closed)`,
      };
    }
    let content: string;
    try {
      content = contract.materialize(redecoded.data, { workItemId: ctx.workItemId });
    } catch (err) {
      return { ok: false, error: `Materialization failed for '${ctx.outputArtifact.type}': ${err instanceof Error ? err.message : String(err)}` };
    }
    const verdict = contract.reviewVerdict?.(redecoded.data);
    return {
      ok: true,
      sections: [{ path: ctx.outputArtifact.path, content }],
      ...(verdict !== undefined ? { verdict } : {}),
      typed: redecoded.data,
    };
  }

  /**
   * D.3d.5 commit 2 — the deterministic input-validation gate. Returns null
   * when validation passed (execution proceeds normally) or an AgentRunResult
   * that short-circuits execution entirely (LLM reviewer never called).
   *
   * On rejection the step's own declared output artifact (the readiness
   * artifact) is written with the structured defect report, so the existing
   * refine step — which already consumes the readiness artifact as input —
   * receives exactly what the validator rejected. Deterministic system
   * identifies the mechanical defect; the model proposes the correction.
   */
  private async runInputValidationGate(ctx: StepRunContext): Promise<AgentRunResult | null> {
    const start0 = Date.now();
    const fail = (error: string, rawPath = ''): AgentRunResult => ({
      success: false,
      artifacts_written: [],
      tokens_used: 0,
      duration_ms: Date.now() - start0,
      raw_output_path: rawPath,
      error,
    });
    const validatorName = ctx.inputValidator!;
    const validator = this.runnerConfig.inputValidators?.[validatorName];
    if (!validator) {
      return fail(
        `Step declares inputValidator '${validatorName}' but no such validator is registered — workflow authoring error (fail closed, no LLM call)`,
      );
    }
    if (!ctx.inputArtifactRefs || ctx.inputArtifactRefs.length === 0) {
      return fail(`Step declares inputValidator '${validatorName}' but declares no inputArtifactRefs to validate`);
    }
    // The engine materializes {workItemId}/{objectiveId} placeholders before
    // this point; canonicalize defensively (path-safety) before reading.
    const inputPath = ctx.inputArtifactRefs[0];
    const canonical = toSafeRelativePath(inputPath);
    if (canonical === null) {
      return fail(`Step input artifact ref '${inputPath}' is not a safe relative path`);
    }
    const absolute = path.join(this.projectRoot, canonical);
    let artifactText: string | undefined;
    try {
      artifactText = await this.fs.readFile(absolute, 'utf-8');
    } catch {
      artifactText = undefined;
    }
    if (artifactText === undefined) {
      const written = await this.writeGateRejection(ctx, [
        { code: 'INPUT_ARTIFACT_MISSING', message: `input artifact '${canonical}' does not exist on disk yet` },
      ]);
      return {
        success: true,
        tokens_used: 0,
        duration_ms: Date.now() - start0,
        raw_output_path: '',
        reviewVerdict: 'fail',
        ...(ctx.on_fail_routes && Object.prototype.hasOwnProperty.call(ctx.on_fail_routes, 'refine')
          ? { reviewRoute: 'refine' }
          : {}),
        error: undefined,
        artifacts_written: written.artifacts_written,
      };
    }
    const outcome = validator(artifactText, { workItemId: ctx.workItemId });
    if (outcome.ok) return null; // valid — semantic readiness review proceeds normally
    // Deterministic rejection: verdict 'fail' routed to refine (CAN_RESOLVE).
    // 'refine' must be one of the step's OWN declared route keys — the same
    // allowlist invariant the D.3c1a route gate enforces for model tokens.
    if (!ctx.on_fail_routes || !Object.prototype.hasOwnProperty.call(ctx.on_fail_routes, 'refine')) {
      return fail(
        `Input validation rejected the artifact but the step does not declare a 'refine' route — workflow authoring error (fail closed, no LLM call)`,
      );
    }
    const written = await this.writeGateRejection(ctx, outcome.failure.defects);
    return {
      success: true,
      tokens_used: 0,
      duration_ms: Date.now() - start0,
      raw_output_path: '',
      reviewVerdict: 'fail',
      reviewRoute: 'refine',
      artifacts_written: written.artifacts_written,
    };
  }

  /**
   * Writes the readiness artifact carrying structured validator defects and
   * returns the spreadable artifacts_written record. The existing refine
   * step reads this artifact as input (inputArtifactRefs already includes
   * it), so the defect list reaches the refinement agent verbatim.
   */
  private async writeGateRejection(
    ctx: StepRunContext,
    defects: Array<{ code: string; factId?: string; message: string }>,
  ): Promise<{ artifacts_written: string[] }> {
    if (!ctx.outputArtifact) return { artifacts_written: [] };
    const canonical = toSafeRelativePath(ctx.outputArtifact.path);
    if (canonical === null) return { artifacts_written: [] };
    const lines: string[] = [
      '# Definition Validation — deterministic gate',
      '',
      'verdict: fail (route: refine)',
      '',
      'The Definition Artifact was rejected by deterministic validation BEFORE semantic review.',
      // D.34 C4 — representation-neutral repair ask: the model re-submits the
      // corrected semantic payload; Stratum serializes the artifact.
      'These are mechanical contract defects: fix them exactly as stated and re-submit',
      'the complete corrected Definition.',
      '',
      '## Definition validator defects',
      '',
    ];
    for (const d of defects) {
      lines.push(`- ${d.code}${d.factId ? ` (${d.factId})` : ''}: ${d.message}`);
    }
    lines.push('');
    lines.push('Nothing here is a semantic judgment — scope, classification, and acceptance');
    lines.push('adequacy remain the readiness review\'s questions once the artifact is structurally valid.');
    const filePath = path.join(this.projectRoot, canonical);
    await this.fs.mkdir(path.dirname(filePath), { recursive: true });
    await this.fs.writeFile(filePath, lines.join('\n'), 'utf-8');
    return { artifacts_written: [ctx.outputArtifact.path] };
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
