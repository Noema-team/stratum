import { promises as nodeFsPromises, readFileSync as nodeReadFileSync } from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'node:crypto';
import type { AgentRole, AssembledContext } from './types.js';
import type { ContextManager } from './context-manager.js';
import { ContextBudgetExceededError } from './context-manager.js';
import type { ILLMProvider, LLMCompletionParams } from './llm-provider.js';
import type { RunArtifactManager } from './run-artifacts.js';
import type { StepRunContext } from './workflow/types.js';
import type { ArtifactRepository } from './storage/repositories.js';
import { toSafeRelativePath } from './path-safety.js';
import { AgentLoop } from './agent-loop.js';
import { applyUnifiedDiff, PatchApplyError } from './patch.js';
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
  renderResultTeaching,
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
  // E27 — bounded source edits: one entry per applied SLE-PATCH, with the
  // pinned base hash and the verified resulting hash.
  patches_applied?: Array<{ path: string; base_hash: string; result_hash: string; diff_bytes: number }>;
  // E27 — protected paths republished with byte-identical content: not
  // rewritten, recorded here instead.
  artifacts_unchanged?: string[];
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

// E26 — producer-contract matching: an entry ending '/' authorizes any
// path under that directory (at least one such file required); any other
// entry authorizes exactly that path (mandatory). Returns the mandatory
// entries missing from `produced` and whether `path` is authorized.
export function matchesAuthorizedOutput(path: string, entry: string): boolean {
  return entry.endsWith('/') ? path.startsWith(entry) : path === entry;
}

export function checkAuthorizedOutputs(
  produced: string[],
  authorized: string[],
): { ok: true } | { ok: false; error: string } {
  const missing = authorized.filter(
    (e) => !e.endsWith('/') && !produced.some((p) => p === e),
  );
  const deadPrefixes = authorized.filter(
    (e) => e.endsWith('/') && !produced.some((p) => p.startsWith(e)),
  );
  const extras = produced.filter((p) => !authorized.some((e) => matchesAuthorizedOutput(p, e)));
  if (missing.length > 0 || deadPrefixes.length > 0) {
    return {
      ok: false,
      error:
        `Step's producer contract is unsatisfied — produced: [${produced.join(', ') || 'none'}]; ` +
        `missing mandatory outputs: [${missing.join(', ')}]` +
        (deadPrefixes.length ? `; no file produced under: [${deadPrefixes.join(', ')}]` : ''),
    };
  }
  if (extras.length > 0) {
    return {
      ok: false,
      error:
        `Step produced sections outside its authorized output set: [${extras.join(', ')}]; ` +
        `authorized: [${authorized.join(', ')}]`,
    };
  }
  return { ok: true };
}

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
  // E15/A6 — optional completion-budget overrides, keyed by
  // "workflowId/stepId" (e.g. { 'define-work/synthesize-definition': 32768 })
  // so a raise targets ONE step. Declarative project setting (settings.json
  // `workflow_max_tokens`, fail-closed whole-map validation) or explicit
  // composition-root config; absent = the global max_tokens everywhere,
  // byte-for-byte. Deliberately NOT a budget-policy framework: one lookup,
  // no defaults beyond the existing global budget.
  workflowMaxTokens?: Record<string, number>;
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

const RUNNER_DEFAULTS: Required<Omit<AgentRunnerConfig, 'model' | 'resultTransport' | 'inputValidators' | 'deriveReviewRoute' | 'outputContracts' | 'workflowMaxTokens'>> = {
  temperature: 0.7,
  max_tokens: 4096,
};

// E15/A6 — strict reader for the optional settings.json `workflow_max_tokens`
// map: the declarative project-level completion-budget override, keyed by
// "workflowId/stepId" (e.g. { "define-work/synthesize-definition": 32768 }) so
// a budget raise can target ONE step. Lives here rather than in application.ts
// because the composition root's established call shape passes no new
// arguments: the runner resolves the override from its own projectRoot when
// config does not carry one explicitly. Fail-closed whole-map validation:
// absent file, absent key, wrong shape, or ANY invalid entry (bad key, non-
// integer, ≤ 0) discards the ENTIRE map → the existing global budget applies
// everywhere; never an error, never a partial map.
function resolveWorkflowBudgetOverridesFromSettings(
  projectRoot: string,
): Record<string, number> | undefined {
  try {
    const raw = nodeReadFileSync(path.join(projectRoot, '.sle', 'settings.json'), 'utf8');
    const saved = JSON.parse(raw) as Record<string, unknown>;
    const map = saved.workflow_max_tokens;
    if (typeof map !== 'object' || map === null || Array.isArray(map)) return undefined;
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(map as Record<string, unknown>)) {
      if (!/^[^/\s]+\/[^/\s]+$/.test(key)) return undefined; // exactly "workflowId/stepId"
      if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return undefined;
      out[key] = value;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

export class AgentRunner {
  private fs: typeof import('fs').promises;
  // D.3d.5 commit 1 — the resolved result transport (serialization seam).
  private resultTransport: ResultTransport;
  // E15/A6 — resolved per-(workflow,step) completion-budget overrides
  // (explicit config wins; else the declarative project settings).
  // Undefined = the global budget everywhere, exactly as before.
  private workflowBudgets: Record<string, number> | undefined;

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
    this.workflowBudgets =
      runnerConfig.workflowMaxTokens ?? resolveWorkflowBudgetOverridesFromSettings(projectRoot);
  }

  // E15/A6 — the completion budget for THIS step: the declared
  // per-(workflow,step) override when present, else the existing global
  // budget. One lookup — no policy framework, no provider/model branching.
  private completionBudgetFor(ctx: StepRunContext): number | undefined {
    return this.workflowBudgets?.[`${ctx.workflowId}/${ctx.stepId}`] ?? this.runnerConfig.max_tokens;
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
    // DDR-036 — the contract context carries the step's resolved trusted
    // inputs (declared input artifacts as text, the resolved checkpoint
    // decision) so escalation contracts can validate identity and merge
    // provenance deterministically. Resolved ONCE here and reused for
    // materialization; contracts never touch the fs themselves.
    let contractCtx: OutputContractContext | undefined;
    let acceptor: ResultAcceptor | undefined;
    if (contract) {
      contractCtx = {
        workItemId: ctx.workItemId,
        ...(ctx.decisionContext !== undefined ? { decisionContext: ctx.decisionContext } : {}),
        ...(await this.readDeclaredInputArtifacts(ctx)),
      };
      acceptor = createResultAcceptor(contract, contractCtx, artifactType!);
    }

    // 1. Assemble context. DDR-041 review — a fixed-component context-budget
    // overflow (e.g. an authoritative Definition that cannot fit the
    // configured boundary) fails the step HERE, BEFORE any LLM call: the
    // Definition is never truncated or summarized, and no model ever sees a
    // degraded task. Narrow catch — only the specific budget error converts;
    // any other assembly error keeps its existing propagation semantics.
    let context;
    try {
      context = await this.contextManager.assemble(role, ctx);
    } catch (err) {
      if (err instanceof ContextBudgetExceededError) {
        return {
          success: false,
          artifacts_written: [],
          tokens_used: 0,
          duration_ms: Date.now() - start,
          raw_output_path: '',
          error: `${err.code}: ${err.message}`,
        };
      }
      throw err;
    }

    // E25 — warnings carry the parse diagnostics (dropped sections) so a
    // zero-usable-output step can fail closed with its reason.
    let parsed: {
      sections: Array<{ path: string; content: string }>;
      warnings?: string[];
      patches?: Array<{ path: string; base: string; diff: string }>;
    };
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
          // E15/A6 — per-(workflow,step) completion budget (declare-scoped
          // override via declarative settings; else the global budget).
          max_tokens: this.completionBudgetFor(ctx),
          // E3b — sampling parity: the multi-turn wire runs the SAME
          // sampling configuration the single-turn/structured wires get
          // (C6 review closure 3 semantics).
          temperature: this.runnerConfig.temperature ?? RUNNER_DEFAULTS.temperature,
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
          // E21 — the engine-copied synthesis gate (WorkflowStep.synthesisGate),
          // forwarded only when declared; every ungated step is untouched.
          ...(ctx.synthesisGate ? { synthesisGate: ctx.synthesisGate } : {}),
          declaredArtifactId: ctx.outputArtifact?.type,
          declaredOutputPath: ctx.outputArtifact?.path,
          expectedArtifacts: ctx.outputArtifact ? 1 : undefined,
          // E26 — the step's producer contract, forwarded for teaching.
          ...(ctx.authorizedOutputs?.length ? { authorizedOutputs: ctx.authorizedOutputs } : {}),
          // D.34 C1 — schema projections + the result-repair seam. Both are
          // absent on the legacy path, leaving it byte-for-byte unchanged.
          ...(contract
            ? {
                acceptResult: acceptor,
                resultSchemaText: renderResultTeaching(contract, contractCtx),
                resultSchemaJson: toJsonSchema(contract.modelSchema),
              }
            : {}),
          // E10/A3 — the bounded transport retry is a define-work
          // step-execution policy ONLY (one re-issue of a headers-timeout
          // request, fail closed on repeat). Every other workflow keeps the
          // historical fail-fast behavior.
          ...(ctx.workflowId === 'define-work' ? { transportRetry: true } : {}),
        }
      );

      const systemPrompt = context.system_prompt || 'You are a helpful software engineering assistant.';
      const userMessage = buildUserMessage(context);

      const loopResult = await loop.run(systemPrompt, userMessage);
      tokensUsed = loopResult.tokens_used;
      formatRepairs = loopResult.format_repairs;
      resultRepairs = loopResult.result_repairs;

      if (!loopResult.success) {
        // E3a — a failed step's evidence must explain itself (C7/F6): the
        // raw node output carries the bounded last-turn observation (names,
        // lengths, counters — never reply text, never reasoning text)
        // instead of being silently replaced with an empty string, and the
        // loop's `-loop.json` turn metadata is written on the failure path
        // exactly as AgentLoop.writeTurnMetadata does on success.
        if (loopResult.failure_observation) {
          try {
            const metaPath = path.join(
              this.projectRoot, '.sle', 'runs', ctx.workflowRunId, String(ctx.iteration),
              'node-outputs', `${nodeId.toLowerCase()}-loop.json`,
            );
            await (this.fs).mkdir(path.dirname(metaPath), { recursive: true });
            await (this.fs).writeFile(
              metaPath,
              JSON.stringify({
                node_id: nodeId,
                failed: true,
                result_transport: loopResult.failure_observation.result_transport,
                turns_taken: loopResult.turns_taken,
                tool_calls: loopResult.failure_observation.tool_calls,
                stop_reason: loopResult.failure_observation.stop_reason,
                text_length: loopResult.failure_observation.text_length,
                // E8/A2 preflight (Pilot A E7) — provider-call failure cause
                // metadata and the bounded rejected-submission description.
                ...(loopResult.failure_observation.transport_failure
                  ? { transport_failure: loopResult.failure_observation.transport_failure }
                  : {}),
                ...(loopResult.failure_observation.rejected_result
                  ? { rejected_result: loopResult.failure_observation.rejected_result }
                  : {}),
                // E10/A3 — bounded transport-retry record on the failure path
                // (success-path metadata is written by the loop itself).
                // E23 — synthesis-boundary compaction evidence on the
                // failure path (success-path metadata is written by the loop).
                ...(loopResult.context_compaction
                  ? { context_compaction: loopResult.context_compaction }
                  : {}),
                ...(loopResult.transport_retry
                  ? { transport_retry: loopResult.transport_retry }
                  : {}),
              }, null, 2),
              'utf-8',
            );
            // E8/A2 preflight — the normalized rejected semantic payload
            // (transport-parsed value, compact JSON — not original wire
            // bytes) as a sibling file; its byte size equals the
            // observation's rejected_result.argument_bytes.
            if (loopResult.rejected_result_payload) {
              await (this.fs).writeFile(
                metaPath.replace(/-loop\.json$/, '-rejected-result.json'),
                loopResult.rejected_result_payload,
                'utf-8',
              );
            }
          } catch {
            // metadata write failures are non-fatal (same policy as the loop)
          }
        }
        rawPath = await this.writeRaw(
          ctx,
          nodeId,
          loopResult.failure_observation
            ? JSON.stringify({ kind: 'step-failure-observation', ...loopResult.failure_observation }, null, 2)
            : '',
        );
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
        const processed = this.processContractResult(contract!, loopResult.proposal.value, ctx, contractCtx);
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
      //
      // D.34 C6 — NATIVE STRUCTURED OUTPUT, the capability-1 wire for this
      // path: a schema-carrying step (registered contract) on a provider
      // that GENUINELY implements completeStructured skips envelope syntax
      // entirely — the provider enforces the projected schema and returns
      // the semantic value. Fallback is by CAPABILITY, never provider name:
      // a provider without the method keeps the textual proposal channel
      // byte-for-byte. This slots into the existing single-turn execution
      // policy (reviews stay single-turn); produce steps keep the C5
      // multi-turn negotiation — this seam never reopens multi-turn review.
      //
      // C6 review closure 1 — the channel is REVIEW-ONLY by INVARIANT, not
      // by coincidence of today's capability sets: a structured-only
      // provider must not silently turn Definition produce steps into
      // native-structured single-shots (losing read-tool investigation).
      // Produce steps reach structured output only through the C5
      // negotiation on the multi-turn loop, which needs completeMultiTurn.
      const useStructured =
        ctx.requiresReviewVerdict === true &&
        contract !== undefined &&
        typeof (this.llmProvider as { completeStructured?: unknown }).completeStructured === 'function';
      const transportCtx = {
        role,
        requiresReviewVerdict: ctx.requiresReviewVerdict === true,
        execution: 'single-turn' as const,
        nodeId,
        declaredArtifactId: ctx.outputArtifact?.type,
        declaredOutputPath: ctx.outputArtifact?.path,
        expectedArtifacts: ctx.outputArtifact ? 1 : undefined,
        // E26 — teaching input for the producer contract.
        ...(ctx.authorizedOutputs?.length ? { authorizedOutputs: ctx.authorizedOutputs } : {}),
        // D.34 C1 — runner-generated projections; absent on the legacy path.
        ...(contract
          ? {
              resultSchemaText: renderResultTeaching(contract, contractCtx),
              resultSchemaJson: toJsonSchema(contract.modelSchema),
            }
          : {}),
      };
      const userContent =
        buildUserMessage(context) +
        '\n\n' +
        // D.34 C6 — the structured wire carries semantics, never envelope
        // syntax: the schema TEXT (the contract's field-meaning annotations)
        // rides in the message, while the shape itself is enforced by the
        // provider API from the projection. The textual path keeps the
        // transport's teaching, byte-for-byte unchanged.
        (useStructured
          ? transportCtx.resultSchemaText!
          : this.resultTransport.formatInstruction(transportCtx));
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
        if (useStructured) {
          // D.34 C6 — the structured wire: one call, the value IS the
          // semantic proposal (no envelope, no extraction, no format
          // repair). A result repair re-issues the SAME conversation shape
          // (assistant raw + user repair instruction) through the same
          // constrained call — identical budget, identical counter. A
          // provider returning non-JSON violates its own capability
          // contract and fails closed via the providerError path.
          try {
            const structured = await (
              this.llmProvider as unknown as import('./llm-provider.js').IStructuredProvider
            ).completeStructured({
              model: this.runnerConfig.model,
              system: baseMessages[0].content,
              messages:
                providerCalls === 0
                  ? [{ role: 'user' as const, content: userContent }]
                  : [
                      { role: 'user' as const, content: userContent },
                      { role: 'assistant' as const, content: raw },
                      { role: 'user' as const, content: repairMessage },
                    ],
              max_tokens: this.completionBudgetFor(ctx) ?? RUNNER_DEFAULTS.max_tokens,
              // C6 review closure 3 — the SAME sampling configuration the
              // textual wire gets; switching wires must not change it.
              temperature: this.runnerConfig.temperature ?? RUNNER_DEFAULTS.temperature,
              schema: transportCtx.resultSchemaJson!,
              schemaName: ctx.outputArtifact?.type,
            });
            providerCalls++;
            tokensUsed += structured.tokens_used;
            raw = JSON.stringify(structured.value);
            stepResult = { kind: 'proposal', value: structured.value };
          } catch (err) {
            providerError = `LLM call failed: ${err instanceof Error ? err.message : String(err)}`;
            break;
          }
        } else {
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
              max_tokens: this.completionBudgetFor(ctx) ?? RUNNER_DEFAULTS.max_tokens,
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
        parsed = { sections: stepResult.artifacts, warnings: stepResult.warnings };
        reviewVerdictRaw = stepResult.review?.verdict;
      } else {
        // D.34 C1 — contract path: the acceptor gated the proposal inside
        // the loop; decode again here (deterministic, cheap) for the typed
        // value, then materialize canonical bytes.
        const processed = this.processContractResult(contract!, stepResult.value, ctx, contractCtx);
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
    // within ROLE_OUTPUT_PATHS. E26: a path explicitly authorized by the
    // STEP's producer contract (authorizedOutputs) satisfies the ceiling —
    // the table remains the default bound only where no step contract
    // exists, so a step can grant exactly the paths it declares without
    // globally widening the role.
    for (const section of canonicalSections) {
      const stepAuthorized =
        ctx.authorizedOutputs?.some((e) => matchesAuthorizedOutput(section.path, e)) ?? false;
      if (!validateOutputPath(section.path, role) && !stepAuthorized) {
        return fail(`Role '${role}' is not permitted to write '${section.path}'`);
      }
    }

    // 6b2. E26 — enforce the step's producer contract: every section must
    // sit inside the authorized set, every exact (mandatory) output must be
    // present, and every directory prefix must receive at least one file.
    // This is what makes the contract producer- AND consumer-real: PLAN and
    // BUILD can rely on the published requirements/architecture/plans
    // actually existing. The zero-section fail (§6d) still fires first for
    // the fully-empty case.
    if (ctx.authorizedOutputs?.length) {
      const check = checkAuthorizedOutputs(
        canonicalSections.map((s) => s.path),
        ctx.authorizedOutputs,
      );
      if (!check.ok) {
        const why = parsed.warnings?.length ? `; parse warnings: ${parsed.warnings.join('; ')}` : '';
        return fail(check.error + why);
      }
    }

    // 6d. E25 — a produce step that yields zero usable sections fails
    // closed BEFORE any downstream step executes. A role-forbidden path is
    // dropped by the parser with a warning; if every section was dropped
    // (the attempt-16 pilot failure), the step must NOT become a silent
    // zero-file success that EXEC and validation then run against an
    // unchanged tree. The parse warnings ARE the diagnostic. A plan or
    // prose file never counts as code: it was either a permitted section
    // (and would appear here) or a dropped one (and appears in warnings).
    const hasPatches = Array.isArray(parsed.patches) && parsed.patches.length > 0;
    if (canonicalSections.length === 0 && !hasPatches) {
      const why = parsed.warnings?.length ? `; parse warnings: ${parsed.warnings.join('; ')}` : '';
      return fail(`Step produced no usable output sections${why}`);
    }

    // 6e. E27 — inter-step ownership + bounded source-edit staging.
    //
    // OWNERSHIP: a `produced-file:<stepId>:<path>` provenance row from a
    // DIFFERENT step of this run makes that path protected — a later step
    // (e.g. BUILD) may not replace it with different content (attempt-18:
    // BUILD overwrote TEST's independent regression suite). Byte-identical
    // republication is allowed and is NOT rewritten. The same step may
    // revise its own file across iterations (debug/refine loops).
    //
    // PATCHES: SLE-PATCH blocks are validated and staged IN MEMORY here —
    // deny prefixes, ceiling/step authorization, ownership, base-hash pin,
    // strict zero-fuzz apply. Nothing touches the disk until EVERY file in
    // the changeset (sections + staged patches) has passed validation, so a
    // rejected patch can never leave a partial publication behind. Disk
    // errors mid-write are NOT transactional: they fail the step with the
    // exact list of files already written.
    const patches = 'patches' in parsed && Array.isArray(parsed.patches) ? parsed.patches : [];
    const sha256Hex = (content: string): string => createHash('sha256').update(content).digest('hex');

    interface ProtectedRow { stepId: string; path: string; hash: string }
    const protectedLatest = new Map<string, ProtectedRow>();
    const repo = this.artifactRepository as
      | { listByWorkflowRun?: (id: string) => Array<{ ref?: string; path?: string; hash?: string }> }
      | undefined;
    if (repo?.listByWorkflowRun) {
      for (const row of repo.listByWorkflowRun(ctx.workflowRunId)) {
        if (!row.ref?.startsWith('produced-file:')) continue;
        const rest = row.ref.slice('produced-file:'.length);
        const sep = rest.indexOf(':');
        if (sep === -1 || !row.path || !row.hash) continue;
        // created_at ordering: later rows overwrite earlier ones per path
        protectedLatest.set(row.path, { stepId: rest.slice(0, sep), path: row.path, hash: row.hash });
      }
    }
    const ownedByOther = (p: string): ProtectedRow | undefined => {
      const row = protectedLatest.get(p);
      return row && row.stepId !== ctx.stepId ? row : undefined;
    };

    // sections: conflict detection + unchanged classification. E27r — when
    // the task declares an edit policy, file writes outside the authorized
    // edit set fail closed: an unrelated new file cannot dodge the required
    // edits, and the task's scope is positive, not deny-by-prefix.
    const unchanged: string[] = [];
    const writableSections: Array<{ path: string; content: string }> = [];
    for (const section of canonicalSections) {
      if (ctx.editPolicy && !ctx.editPolicy.allowedEditPaths.includes(section.path)) {
        return fail(
          `File '${section.path}' is outside this task's authorized edit set ` +
          `[${ctx.editPolicy.allowedEditPaths.join(', ')}] — publishing it would exceed the task's scope.`,
        );
      }
      const other = ownedByOther(section.path);
      if (other) {
        const incoming = sha256Hex(section.content);
        if (incoming !== other.hash) {
          return fail(
            `Protected artifact conflict: '${section.path}' was published by step '${other.stepId}' ` +
            `(sha256 ${other.hash.slice(0, 12)}…) and is protected — this step attempted to replace it with ` +
            `content sha256 ${incoming.slice(0, 12)}… A protected test or artifact can only be changed by the step ` +
            `that owns it, or by an explicitly authorized revision.`,
          );
        }
        unchanged.push(section.path); // byte-identical: preserve without rewriting
        continue;
      }
      writableSections.push(section);
    }

    // patches: validate + stage (pure in-memory; no disk mutation)
    interface StagedPatch { path: string; baseHash: string; resultContent: string; resultHash: string; diffBytes: number }
    const stagedPatches: StagedPatch[] = [];
    for (const [pi, patch] of patches.entries()) {
      const canonical = toSafeRelativePath(patch.path);
      if (canonical === null) return fail(`Unsafe patch path '${patch.path}'`);
      if (canonicalSections.some((s) => s.path === canonical)) {
        return fail(`Ambiguous changeset: '${canonical}' appears both as a file section and as an SLE-PATCH target`);
      }
      // E27r — positive authorization: with an edit policy, a patch target
      // must be EXACTLY one of the task's allowed edit paths (a deny-prefix
      // formulation still permitted patching unrelated files).
      if (ctx.editPolicy && !ctx.editPolicy.allowedEditPaths.includes(canonical)) {
        return fail(
          `Patch target '${canonical}' is outside this task's authorized edit set ` +
          `[${ctx.editPolicy.allowedEditPaths.join(', ')}] — only explicitly authorized paths may be modified.`,
        );
      }
      const stepAuthorized = ctx.authorizedOutputs?.some((e) => matchesAuthorizedOutput(canonical, e)) ?? false;
      if (!validateOutputPath(canonical, role) && !stepAuthorized) {
        return fail(`Role '${role}' is not permitted to modify '${canonical}'`);
      }
      const other = ownedByOther(canonical);
      let current: string;
      try {
        current = await this.fs.readFile(path.join(this.projectRoot, canonical), 'utf-8');
      } catch {
        return fail(`Patch target '${canonical}' does not exist on disk — SLE-PATCH modifies existing files; publish new files as complete-file sections instead`);
      }
      const diskHash = sha256Hex(current);
      if (diskHash !== patch.base.toLowerCase()) {
        return fail(
          `Patch ${pi + 1}/${patches.length} for '${canonical}' is stale: pinned base sha256 ${patch.base.slice(0, 12)}… ` +
          `does not match the file on disk (sha256 ${diskHash.slice(0, 12)}…). The patch applies only against the ` +
          `expected source version — re-read the file and regenerate the diff.`,
        );
      }
      let result: string;
      try {
        result = applyUnifiedDiff(current, patch.diff);
      } catch (err) {
        if (err instanceof PatchApplyError) {
          return fail(`Patch ${pi + 1}/${patches.length} for '${canonical}' rejected: ${err.message}`);
        }
        throw err;
      }
      const resultHash = sha256Hex(result);
      if (other && resultHash !== other.hash) {
        return fail(
          `Protected artifact conflict: '${canonical}' was published by step '${other.stepId}' and is protected — ` +
          `a patch may only reproduce it byte-for-byte or must target a different path.`,
        );
      }
      if (resultHash === diskHash) continue; // no-op patch: nothing to publish
      stagedPatches.push({ path: canonical, baseHash: diskHash, resultContent: result, resultHash, diffBytes: Buffer.byteLength(patch.diff, 'utf-8') });
    }

    // E27r — editPolicy.requiredEditPaths: each named path must receive an
    // applied SLE-PATCH in this step. A docs-only or empty changeset, or an
    // adjacent new file, cannot substitute for the edit the task exists to
    // make (the previous weak "any new non-docs file" formulation could).
    if (ctx.editPolicy && ctx.editPolicy.requiredEditPaths.length > 0) {
      const patchedPaths = new Set(stagedPatches.map((s) => s.path));
      const missing = ctx.editPolicy.requiredEditPaths.filter((p) => !patchedPaths.has(p));
      if (missing.length > 0) {
        return fail(
          `This task requires an authorized edit to [${missing.join(', ')}], but the changeset ` +
          `contains no applied SLE-PATCH for ${missing.length === 1 ? 'it' : 'each of them'}. ` +
          `New files, documentation, or unrelated edits cannot substitute.`,
        );
      }
    }

    // 7. Write artifacts — canonical paths only; staged patches last. Disk
    // errors here are NOT transactional: fail explicitly with the exact
    // partial-publication evidence.
    const artifactsWritten: string[] = [];
    const writeOne = async (relPath: string, content: string, append: boolean): Promise<void> => {
      const filePath = path.join(this.projectRoot, relPath);
      await this.fs.mkdir(path.dirname(filePath), { recursive: true });
      if (append) {
        await this.fs.appendFile(filePath, content, 'utf-8');
      } else {
        await this.fs.writeFile(filePath, content, 'utf-8');
      }
    };
    try {
      for (const section of writableSections) {
        await writeOne(section.path, section.content, APPEND_ONLY_PATHS.has(section.path));
        artifactsWritten.push(section.path);
      }
      for (const staged of stagedPatches) {
        await writeOne(staged.path, staged.resultContent, false);
        artifactsWritten.push(staged.path);
      }
    } catch (err) {
      return fail(
        `Publication failed partway through (disk error: ${err instanceof Error ? err.message : String(err)}). ` +
        `Files already written in this step — NOT rolled back: [${artifactsWritten.join(', ') || 'none'}]. ` +
        `Not yet written: sections [${writableSections.map((s) => s.path).filter((p) => !artifactsWritten.includes(p)).join(', ') || 'none'}], ` +
        `patches [${stagedPatches.map((s) => s.path).filter((p) => !artifactsWritten.includes(p)).join(', ') || 'none'}].`,
      );
    }

    // 7b. E25 — publication is observable: every reported write must exist
    // (through the SAME fs layer that performed the writes) with exactly
    // the produced byte count. A write that silently no-ops (permissions,
    // path traversal normalized away, wrapper bugs) must fail the step
    // here rather than surface as a downstream validation failure against
    // an unchanged tree. Production always uses fs.promises; an injected
    // fs layer without a stat capability (test stubs modeling writes
    // in memory) is verification-incompatible and skips the check rather
    // than failing every legacy harness.
    if (typeof (this.fs as { stat?: unknown }).stat === 'function') {
      for (const staged of stagedPatches) {
        const filePath = path.join(this.projectRoot, staged.path);
        try {
          const onDisk = await this.fs.readFile(filePath, 'utf-8');
          if (sha256Hex(onDisk) !== staged.resultHash) {
            return fail(`Patched file '${staged.path}' on disk does not match the verified patch result (sha256 ${staged.resultHash.slice(0, 12)}…) — publication integrity failure`);
          }
        } catch {
          return fail(`Patched file '${staged.path}' is missing from disk after write — publication integrity failure`);
        }
      }
      for (const section of writableSections) {
        const filePath = path.join(this.projectRoot, section.path);
        let st;
        try {
          st = await this.fs.stat(filePath);
        } catch {
          return fail(`Materialized file '${section.path}' is missing from disk after write — publication integrity failure`);
        }
        const expected = Buffer.byteLength(section.content, 'utf-8');
        if (APPEND_ONLY_PATHS.has(section.path)) {
          if (st.size < expected) {
            return fail(`Appended file '${section.path}' is ${st.size} bytes on disk, shorter than the ${expected}-byte produced content — publication integrity failure`);
          }
        } else if (st.size !== expected) {
          return fail(`Materialized file '${section.path}' is ${st.size} bytes on disk but ${expected} bytes were produced — publication integrity failure`);
        }
      }
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

    // 8b. E25 — open-set provenance: an undeclared produce step (e.g. a
    // build step's multi-file changeset) records one hashed artifact row
    // per written file, so publication is auditable per path without
    // inventing a fake static output path for a dynamic changeset. The
    // declared single-output recording above is unchanged.
    if (!ctx.outputArtifact && this.artifactRepository) {
      for (const section of writableSections) {
        const hash = createHash('sha256').update(section.content).digest('hex');
        // E27 — the publishing step rides in the ref: ownership is derived
        // from these rows, so the step identity is part of the provenance.
        const ref = `produced-file:${ctx.stepId}:${section.path}`;
        const already = this.artifactRepository.findByWorkflowRunRefAndHash(
          ctx.workflowRunId,
          ref,
          hash,
        );
        if (!already) {
          this.artifactRepository.save({
            id: randomUUID(),
            workItemId: ctx.workItemId,
            workflowRunId: ctx.workflowRunId,
            type: 'produced-file',
            ref,
            path: section.path,
            hash,
            createdAt: new Date().toISOString(),
          });
        }
      }
    }

    // 8c. E27 — applied-patch provenance: one hashed row per bounded edit,
    // keyed by (run, step, path), hash of the VERIFIED resulting content.
    // The diff text itself persists in the step's raw node output.
    if (this.artifactRepository) {
      for (const staged of stagedPatches) {
        const ref = `applied-patch:${ctx.stepId}:${staged.path}`;
        const already = this.artifactRepository.findByWorkflowRunRefAndHash(ctx.workflowRunId, ref, staged.resultHash);
        if (!already) {
          this.artifactRepository.save({
            id: randomUUID(),
            workItemId: ctx.workItemId,
            workflowRunId: ctx.workflowRunId,
            type: 'applied-patch',
            ref,
            path: staged.path,
            hash: staged.resultHash,
            createdAt: new Date().toISOString(),
          });
        }
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
      ...(stagedPatches.length > 0
        ? {
            patches_applied: stagedPatches.map((p) => ({
              path: p.path,
              base_hash: p.baseHash,
              result_hash: p.resultHash,
              diff_bytes: p.diffBytes,
            })),
          }
        : {}),
      ...(unchanged.length > 0 ? { artifacts_unchanged: unchanged } : {}),
      ...(formatRepairs !== undefined ? { format_repairs: formatRepairs } : {}),
      // C1 review fix — result_repairs is externally visible only when an
      // actual result repair occurred (which is only possible on the
      // contract path). A legacy run's observable shape is byte-for-byte
      // its pre-C1 form: no zero-count result_repairs key.
      ...(resultRepairs !== undefined && resultRepairs > 0 ? { result_repairs: resultRepairs } : {}),
    };
  }

  /**
   * DDR-036 — resolve the step's declared input artifacts to text, keyed by
   * canonical declared path. Best-effort per entry (a missing input is a
   * CONTRACT-level fail-closed concern, with precise wording, not a runner
   * concern); unsafe paths are skipped the same way. Pure read — contracts
   * never see the fs.
   */
  private async readDeclaredInputArtifacts(
    ctx: StepRunContext,
  ): Promise<{ inputArtifacts?: Readonly<Record<string, string>> }> {
    if (!ctx.inputArtifactRefs || ctx.inputArtifactRefs.length === 0) return {};
    const resolved: Record<string, string> = {};
    for (const ref of ctx.inputArtifactRefs) {
      const canonical = toSafeRelativePath(ref);
      if (canonical === null) continue;
      try {
        resolved[canonical] = await this.fs.readFile(path.join(this.projectRoot, canonical), 'utf-8');
      } catch {
        // absent — omitted; contracts fail closed on absence with wording
      }
    }
    return Object.keys(resolved).length > 0 ? { inputArtifacts: resolved } : {};
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
    contractCtx?: OutputContractContext,
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
      content = contract.materialize(redecoded.data, contractCtx ?? { workItemId: ctx.workItemId });
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
