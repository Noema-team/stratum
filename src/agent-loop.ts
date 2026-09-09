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
  tools: typeof AGENT_TOOLS;
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
}

export interface AgentLoopResult {
  success: boolean;
  parsedOutput?: ParsedOutput;
  turns_taken: number;
  tokens_used: number;
  // D.3d.5 commit 1 — bounded format-repair attempts, tracked separately
  // from ordinary turns so diagnostics never imply a repair happened when
  // only ordinary tool/answer turns occurred. Exact semantics (shared with
  // the single-turn path): turns_taken = total provider invocations by this
  // loop (INCLUDING repair-prompted ones); format_repairs = provider
  // invocations initiated specifically by a transport-format repair prompt.
  format_repairs: number;
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
    this.transport = resolveResultTransport(provider, opts.resultTransport);
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
    };
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
    const toolCallLog: Array<{ tool: string; path: string; turn: number }> = [];

    // D.3b1 — the tracked-file set is computed once per run (not once per
    // tool call) and reused for every read_file/list_directory invocation
    // below, so a run's read authority is fixed for its own duration.
    const trackedFiles = new Set(
      await (this.opts.listTrackedFiles ?? listGitTrackedFiles)(this.opts.projectRoot),
    );

    const fail = (error: string): AgentLoopResult => ({
      success: false,
      turns_taken: turns,
      tokens_used: totalTokens,
      format_repairs: formatRepairs,
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
          tools: AGENT_TOOLS,
        });
      } catch (err) {
        return fail(`LLM call failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      totalTokens += result.tokens_used;

      if (result.stop_reason === 'max_tokens') {
        return fail('Agent exhausted max_tokens without producing a result block');
      }

      if (result.stop_reason === 'tool_use') {
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

      // Write turn metadata to run artifacts
      await this.writeTurnMetadata(turns, toolCallLog);

      return {
        success: true,
        // Backward-compatible shape for AgentRunner: artifacts + (never
        // present on this path) warnings.
        parsedOutput: { sections: stepResult.artifacts, warnings: [] },
        turns_taken: turns,
        tokens_used: totalTokens,
        format_repairs: formatRepairs,
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
        JSON.stringify({ node_id: nodeId, turns_taken, tool_calls }, null, 2),
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
