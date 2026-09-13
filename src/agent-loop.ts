import { promises as nodeFsPromises } from 'fs';
import path from 'path';
import type { AgentRole } from './types.js';
import type { RunArtifactManager } from './run-artifacts.js';
import { handleToolCall, AGENT_TOOLS, listGitTrackedFiles, type ToolName, type TrackedFilesLister } from './tools.js';
import type { ParsedOutput } from './output-parser.js';
import {
  type ResultTransport,
  type StepResult,
  type TransportContext,
  TransportParseError,
  repairDecision,
  formatRepairExhaustedDiagnostic,
  resultRepairDecision,
  resultRepairExhaustedDiagnostic,
} from './transport/step-result.js';
import { resolveResultTransport } from './transport/textual-sle-output.js';

// ─── Types ────────────────────────────────────────────────────────────────────

// D.3d — raised from 10. The live-provider qualification showed a genuinely
// targeted investigation (orient, drill to the relevant directory, read the
// 2-3 files that answer the Objective's questions) consumes one turn per
// tool round trip, so a correct read-verify-conclude flow needs ~12+ turns;
// at 10 the loop cut off correct behavior mid-investigation. This is a turn
// budget on ONE step's tool loop — unrelated to define-work's max_iterations
// (the workflow-level refinement cap, which stays 4).
export const MAX_AGENT_TURNS = 24;

export interface MultiTurnMessage {
  role: 'user' | 'assistant';
  content: string | MultiTurnContentBlock[];
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}

export type MultiTurnContentBlock = ToolUseBlock | ToolResultBlock | { type: 'text'; text: string };

export interface MultiTurnResult {
  stop_reason: string;
  text: string;
  tool_uses: ToolUseBlock[];
  tokens_used: number;
}

export interface MultiTurnParams {
  model: string;
  system: string;
  messages: MultiTurnMessage[];
  max_tokens: number;
  // D.34 C5 — widened from `typeof AGENT_TOOLS` to a structural readonly
  // array: the transport may add the result-submission tool (derived from
  // the step's contract projection) alongside the read tools. Providers map
  // these onto their own wire formats.
  tools: ReadonlyArray<{
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
  }>;
}

export interface IMultiTurnProvider {
  completeMultiTurn(params: MultiTurnParams): Promise<MultiTurnResult>;
}

export interface AgentLoopOptions {
  model: string;
  max_tokens?: number;
  projectRoot: string;
  role: AgentRole;
  workflowRunId: string;
  iteration: number;
  nodeId: string;
  runArtifacts: RunArtifactManager;
  fsModule?: typeof import('fs').promises;
  // D.3b1 — injectable lister for the Git-tracked-file read authority (see
  // tools.ts). Defaults to the real `git ls-files`-backed implementation;
  // tests inject a synthetic tracked-file list instead of requiring a real
  // git repository.
  listTrackedFiles?: TrackedFilesLister;
  // D.3d.5 commit 1 (closure) — the executing step's actual output contract,
  // so the transport teaches from REAL metadata on this path too (never a
  // generic placeholder when the step has a declared output artifact).
  declaredArtifactId?: string;
  declaredOutputPath?: string;
  // D.3d.5 commit 1 (closure) — the step's declared artifact cardinality.
  // Absent = unconstrained: the transport must not impose a one-artifact law
  // that the step's own contract does not state.
  expectedArtifacts?: number;
  // D.3d.5 commit 1 — the result transport owns serialization: syntax
  // teaching, extraction, and bounded format repair. Defaults to the
  // textual SLE-OUTPUT fallback (the only transport any current provider
  // genuinely has); structured adapters plug in here.
  resultTransport?: ResultTransport;
  // D.34 C1 — the generic result-acceptance callback (DDR-034 §5.3),
  // composed by the AgentRunner from the step's declared output contract.
  // Deliberately a PLAIN structural type: this loop never imports contracts,
  // methodology, or the runner — its knowledge is exactly "call it; on
  // { ok: false } continue the conversation with the given instruction,
  // budget permitting (MAX_RESULT_REPAIRS)." Absent for legacy/materialized
  // steps, whose behavior is unchanged.
  acceptResult?: (value: unknown) => { ok: true } | { ok: false; repairInstruction: string };
  // D.34 C1 — runner-generated schema projections (from the step's declared
  // output contract), surfaced to the transport via TransportContext.
  // Absent = legacy path. Transports consume them verbatim.
  resultSchemaText?: string;
  resultSchemaJson?: Record<string, unknown>;
}

export interface AgentLoopResult {
  success: boolean;
  parsedOutput?: ParsedOutput;
  // D.34 C1 — set instead of parsedOutput when the transport produced a
  // semantic proposal (kind 'proposal') that the result acceptor approved.
  // The runner decodes it against the workflow-declared contract.
  proposal?: { value: unknown };
  turns_taken: number;
  tokens_used: number;
  // D.3d.5 commit 1 — bounded format-repair attempts, tracked separately
  // from ordinary turns so diagnostics never imply a repair happened when
  // only ordinary tool/answer turns occurred. Exact semantics (shared with
  // the single-turn path): turns_taken = total provider invocations by this
  // loop (INCLUDING repair-prompted ones); format_repairs = provider
  // invocations initiated specifically by a transport-format repair prompt.
  format_repairs: number;
  // D.34 C1 — contract decode/validate repair attempts, tracked separately
  // from format repairs (the repair taxonomy has three layers: format
  // repair / result repair / workflow refine). A result repair NEVER
  // consumes a workflow refinement iteration.
  result_repairs: number;
  error?: string;
  rawText?: string;
}

// ─── AgentLoop ────────────────────────────────────────────────────────────────

export class AgentLoop {
  private fs: typeof nodeFsPromises;
  // D.3d.5 commit 1 — result transport (serialization ownership seam).
  private transport: ResultTransport;
  private transportCtx: TransportContext;

  constructor(
    private provider: IMultiTurnProvider,
    private opts: AgentLoopOptions
  ) {
    this.fs = opts.fsModule ?? nodeFsPromises;
    // D.3d.5 commit 1 (closure) — full real metadata on the multi-turn path,
    // mirroring the single-turn context the runner builds.
    this.transportCtx = {
      role: opts.role,
      requiresReviewVerdict: false,
      execution: 'multi-turn',
      nodeId: opts.nodeId,
      declaredArtifactId: opts.declaredArtifactId,
      declaredOutputPath: opts.declaredOutputPath,
      expectedArtifacts: opts.expectedArtifacts,
      // D.34 C1 — runner-generated projections; absent on the legacy path.
      ...(opts.resultSchemaText !== undefined ? { resultSchemaText: opts.resultSchemaText } : {}),
      ...(opts.resultSchemaJson !== undefined ? { resultSchemaJson: opts.resultSchemaJson } : {}),
    };
    // D.3d.5 commit 1 — result transport (serialization ownership seam).
    // D.34 C5 — negotiation: a schema-carrying step (registered output
    // contract) on this genuinely multi-turn path negotiates the
    // submit-result tool channel; everything else stays textual.
    this.transport = resolveResultTransport(provider, opts.resultTransport, {
      resultSchemaJson: opts.resultSchemaJson,
    });
  }

  async run(system: string, userMessage: string): Promise<AgentLoopResult> {
    // D.3d.5 commit 1 — transport syntax is taught BY THE TRANSPORT, injected
    // here, never by workflow methodology text. Appended once, up front.
    const transportInstruction = this.transport.formatInstruction(this.transportCtx);
    const messages: MultiTurnMessage[] = [
      { role: 'user', content: `${userMessage}\n\n${transportInstruction}` },
    ];
    let totalTokens = 0;
    let turns = 0;
    let formatRepairs = 0;
    // D.34 C1 — contract decode/validate repair attempts (separate budget
    // and counter from format repairs; never a workflow iteration).
    let resultRepairs = 0;
    const toolCallLog: Array<{ tool: string; path: string; turn: number }> = [];

    // D.3b1 — the tracked-file set is computed once per run (not once per
    // tool call) and reused for every read_file/list_directory invocation
    // below, so a run's read authority is fixed for its own duration.
    const trackedFiles = new Set(
      await (this.opts.listTrackedFiles ?? listGitTrackedFiles)(this.opts.projectRoot),
    );

    // D.34 C5 — the tools offered this turn: the read tools, plus the
    // result-submission tool when the negotiated transport provides one
    // (schema-carrying contract steps). Absent on every legacy path.
    const submissionTool = this.transport.resultSubmissionTool?.(this.transportCtx);
    const tools = submissionTool ? [...AGENT_TOOLS, submissionTool] : [...AGENT_TOOLS];
    const fail = (error: string): AgentLoopResult => ({
      success: false,
      turns_taken: turns,
      tokens_used: totalTokens,
      format_repairs: formatRepairs,
      result_repairs: resultRepairs,
      error,
    });

    while (turns < MAX_AGENT_TURNS) {
      turns++;
      let result: MultiTurnResult;
      try {
        result = await this.provider.completeMultiTurn({
          model: this.opts.model,
          system,
          messages: [...messages], // snapshot to avoid reference aliasing
          max_tokens: this.opts.max_tokens ?? 4096,
          tools,
        });
      } catch (err) {
        return fail(`LLM call failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      totalTokens += result.tokens_used;

      if (result.stop_reason === 'max_tokens') {
        return fail('Agent exhausted max_tokens without producing a result block');
      }

      if (result.stop_reason === 'tool_use') {
        // D.34 C5 — evaluate a result submission FIRST (the negotiated tool
        // channel). The transport returns undefined for a plain read-tool
        // turn (ordinary handling proceeds below), a proposal for exactly
        // one submit call, or a TransportParseError for a malformed
        // submission turn (e.g. cardinality > 1 — the C4 fail-closed rule
        // on this channel too).
        if (this.transport.extractToolSubmission) {
          let submission: StepResult | undefined;
          try {
            submission = this.transport.extractToolSubmission(result.tool_uses, this.transportCtx);
          } catch (err) {
            if (!(err instanceof TransportParseError)) {
              return fail(`Output parsing failed: ${err instanceof Error ? err.message : String(err)}`);
            }
            // Malformed submission turn: the tool protocol requires EVERY
            // tool_use to be answered, so each gets the repair instruction
            // as its tool_result, then the bounded format-repair budget
            // applies (shared policy — never a workflow iteration).
            if (repairDecision(formatRepairs).action === 'fail-closed') {
              return fail(formatRepairExhaustedDiagnostic(err, turns, formatRepairs));
            }
            formatRepairs++;
            messages.push({ role: 'assistant', content: result.tool_uses });
            messages.push({
              role: 'user',
              content: result.tool_uses.map((tu) => ({
                type: 'tool_result' as const,
                tool_use_id: tu.id,
                content: this.transport.repairInstruction(this.transportCtx, err.kind, err.reason),
              })),
            });
            continue;
          }
          if (submission !== undefined && submission.kind === 'proposal') {
            if (!this.opts.acceptResult) {
              return fail(
                `Transport produced a semantic proposal for declared artifact '${this.opts.declaredArtifactId ?? '(undeclared)'}' but no result acceptor is registered — authoring/negotiation error (fail closed)`,
              );
            }
            // D.34 C1 — the same runner-composed acceptor gates the
            // proposal; the ONLY difference from the textual channel is
            // the delivery of a rejection: a tool_result payload on this
            // channel (same conversation, same budget, same instruction).
            const acceptance = this.opts.acceptResult(submission.value);
            if (!acceptance.ok) {
              if (resultRepairDecision(resultRepairs).action === 'fail-closed') {
                return fail(
                  resultRepairExhaustedDiagnostic(
                    this.opts.declaredArtifactId ?? '(undeclared)',
                    acceptance.repairInstruction,
                    turns,
                    resultRepairs,
                  ),
                );
              }
              resultRepairs++;
              messages.push({ role: 'assistant', content: result.tool_uses });
              messages.push({
                role: 'user',
                content: result.tool_uses.map((tu) =>
                  this.transport.toolRejectionTurn!(tu.id, acceptance.repairInstruction),
                ),
              });
              continue;
            }
            await this.writeTurnMetadata(turns, toolCallLog);
            return {
              success: true,
              proposal: { value: submission.value },
              turns_taken: turns,
              tokens_used: totalTokens,
              format_repairs: formatRepairs,
              result_repairs: resultRepairs,
              rawText: result.text,
            };
          }
        }
        // Append assistant tool_use turn, then handle tools and append results
        messages.push({ role: 'assistant', content: result.tool_uses });
        const resultBlocks: ToolResultBlock[] = [];
        for (const tu of result.tool_uses) {
          const toolResult = await handleToolCall(
            tu.name as ToolName,
            tu.input,
            this.opts.projectRoot,
            this.fs,
            trackedFiles,
          );
          resultBlocks.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: toolResult.content,
          });
          toolCallLog.push({
            tool: tu.name,
            path: (tu.input as Record<string, string>)?.path ?? '',
            turn: turns,
          });
        }
        messages.push({ role: 'user', content: resultBlocks });
        continue;
      }

      // stop_reason === 'end_turn' — the transport owns turning the reply
      // into a StepResult, INCLUDING classifying non-compliance ('absent'
      // vs 'malformed'). The loop never inspects raw syntax itself.
      // D.3d.5 commit 1: a reply with NO result block at all now enters the
      // SAME bounded format-repair path as a malformed block (previously
      // absence failed immediately — the GPT-OSS failure mode — with
      // diagnostics that overstated the repair effort).
      let stepResult: StepResult;
      try {
        stepResult = this.transport.extractProduce(result.text, this.transportCtx);
      } catch (err) {
        if (!(err instanceof TransportParseError)) {
          return fail(`Output parsing failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        // D.3d.5 closure — the SAME bounded-repair policy as the single-turn
        // path (shared repairDecision + diagnostic; budget NOT raised).
        if (repairDecision(formatRepairs).action === 'fail-closed') {
          return fail(formatRepairExhaustedDiagnostic(err, turns, formatRepairs));
        }
        formatRepairs++;
        messages.push({ role: 'assistant', content: result.text });
        messages.push({ role: 'user', content: this.transport.repairInstruction(this.transportCtx, err.kind, err.reason) });
        continue;
      }

      // D.34 C1 — the result-repair seam (DDR-034 §5.3). A proposal-kind
      // result is gated by the runner-composed acceptor INSIDE this loop, so
      // a decode/validate defect continues the SAME conversation (textual
      // channel: assistant reply + user repair instruction, mirroring format
      // repair; a submit-result channel — C5 — will answer with a
      // tool_result rejection instead). Exhaustion fails the step closed
      // BEFORE anything is written; it never consumes a workflow iteration.
      if (stepResult.kind === 'proposal') {
        if (!this.opts.acceptResult) {
          return fail(
            `Transport produced a semantic proposal for declared artifact '${this.opts.declaredArtifactId ?? '(undeclared)'}' but no result acceptor is registered — authoring/negotiation error (fail closed)`,
          );
        }
        const acceptance = this.opts.acceptResult(stepResult.value);
        if (!acceptance.ok) {
          if (resultRepairDecision(resultRepairs).action === 'fail-closed') {
            return fail(
              resultRepairExhaustedDiagnostic(
                this.opts.declaredArtifactId ?? '(undeclared)',
                acceptance.repairInstruction,
                turns,
                resultRepairs,
              ),
            );
          }
          resultRepairs++;
          messages.push({ role: 'assistant', content: result.text });
          messages.push({ role: 'user', content: acceptance.repairInstruction });
          continue;
        }
      }

      // Write turn metadata to run artifacts
      await this.writeTurnMetadata(turns, toolCallLog);

      // D.34 C1 — kind-split return: a proposal replaces parsedOutput; the
      // runner decodes it against the workflow-declared contract.
      if (stepResult.kind === 'proposal') {
        return {
          success: true,
          proposal: { value: stepResult.value },
          turns_taken: turns,
          tokens_used: totalTokens,
          format_repairs: formatRepairs,
          result_repairs: resultRepairs,
          rawText: result.text,
        };
      }
      return {
        success: true,
        // Backward-compatible shape for AgentRunner: artifacts + (never
        // present on this path) warnings.
        parsedOutput: { sections: stepResult.artifacts, warnings: [] },
        turns_taken: turns,
        tokens_used: totalTokens,
        format_repairs: formatRepairs,
        result_repairs: resultRepairs,
        rawText: result.text,
      };
    }

    return fail(`Agent did not produce a result block within ${MAX_AGENT_TURNS} turns`);
  }

  private async writeTurnMetadata(
    turns_taken: number,
    tool_calls: Array<{ tool: string; path: string; turn: number }>
  ): Promise<void> {
    try {
      const { workflowRunId, iteration, nodeId, runArtifacts } = this.opts;
      const metaDir = path.join(
        '.sle', 'runs', workflowRunId, String(iteration), 'node-outputs'
      );
      const metaPath = path.join(metaDir, `${nodeId.toLowerCase()}-loop.json`);
      const absMetaPath = path.join(this.opts.projectRoot, metaPath);
      await this.fs.mkdir(path.join(this.opts.projectRoot, metaDir), { recursive: true });
      await this.fs.writeFile(
        absMetaPath,
        // D.34 C5 — the negotiated result transport is part of the run
        // record: which wire actually carried the semantic result.
        JSON.stringify({ node_id: nodeId, result_transport: this.transport.name, turns_taken, tool_calls }, null, 2),
        'utf-8'
      );
      await runArtifacts.updateNodeStatus(workflowRunId, iteration, nodeId, {
        status: 'running',
        turns_taken,
        tool_calls: tool_calls.length,
      } as never);
    } catch {
      // metadata write failures are non-fatal
    }
  }
}
