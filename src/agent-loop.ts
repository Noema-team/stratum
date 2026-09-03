import { promises as nodeFsPromises } from 'fs';
import path from 'path';
import type { AgentRole } from './types.js';
import type { RunArtifactManager } from './run-artifacts.js';
import { parseWithRetry } from './output-parser.js';
import { handleToolCall, AGENT_TOOLS, listGitTrackedFiles, type ToolName, type TrackedFilesLister } from './tools.js';
import type { ParsedOutput } from './output-parser.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export const MAX_AGENT_TURNS = 10;

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
}

export interface AgentLoopResult {
  success: boolean;
  parsedOutput?: ParsedOutput;
  turns_taken: number;
  tokens_used: number;
  error?: string;
  rawText?: string;
}

// ─── AgentLoop ────────────────────────────────────────────────────────────────

export class AgentLoop {
  private fs: typeof nodeFsPromises;

  constructor(
    private provider: IMultiTurnProvider,
    private opts: AgentLoopOptions
  ) {
    this.fs = opts.fsModule ?? nodeFsPromises;
  }

  async run(system: string, userMessage: string): Promise<AgentLoopResult> {
    const messages: MultiTurnMessage[] = [{ role: 'user', content: userMessage }];
    let totalTokens = 0;
    let turns = 0;
    const toolCallLog: Array<{ tool: string; path: string; turn: number }> = [];

    // D.3b1 — the tracked-file set is computed once per run (not once per
    // tool call) and reused for every read_file/list_directory invocation
    // below, so a run's read authority is fixed for its own duration.
    const trackedFiles = new Set(
      await (this.opts.listTrackedFiles ?? listGitTrackedFiles)(this.opts.projectRoot),
    );

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
        return {
          success: false,
          turns_taken: turns,
          tokens_used: totalTokens,
          error: `LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      totalTokens += result.tokens_used;

      if (result.stop_reason === 'max_tokens') {
        return {
          success: false,
          turns_taken: turns,
          tokens_used: totalTokens,
          error: 'Agent exhausted max_tokens without producing SLE-OUTPUT',
        };
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

      // stop_reason === 'end_turn': look for SLE-OUTPUT in text
      if (!result.text.includes('<<<SLE-OUTPUT>>>')) {
        return {
          success: false,
          turns_taken: turns,
          tokens_used: totalTokens,
          error: `Agent produced stop_reason='end_turn' without SLE-OUTPUT after ${turns} turn(s)`,
        };
      }

      // Parse output with one retry on ParseError
      let parsedOutput: ParsedOutput;
      try {
        parsedOutput = await parseWithRetry(
          result.text,
          this.opts.role,
          async (reason) => {
            const repairMsg = `The previous output was not parseable. Reason: ${reason}\nPlease reformat your response using the exact SLE-OUTPUT block structure.`;
            const retryResult = await this.provider.completeMultiTurn({
              model: this.opts.model,
              system,
              messages: [
                ...messages,
                { role: 'user', content: repairMsg },
              ],
              max_tokens: this.opts.max_tokens ?? 4096,
              tools: AGENT_TOOLS,
            });
            totalTokens += retryResult.tokens_used;
            return retryResult.text;
          }
        );
      } catch (err) {
        return {
          success: false,
          turns_taken: turns,
          tokens_used: totalTokens,
          error: `Output parsing failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      // Write turn metadata to run artifacts
      await this.writeTurnMetadata(turns, toolCallLog);

      return {
        success: true,
        parsedOutput,
        turns_taken: turns,
        tokens_used: totalTokens,
        rawText: result.text,
      };
    }

    return {
      success: false,
      turns_taken: MAX_AGENT_TURNS,
      tokens_used: totalTokens,
      error: `Agent did not produce SLE-OUTPUT within ${MAX_AGENT_TURNS} turns`,
    };
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
