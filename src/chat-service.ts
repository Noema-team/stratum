import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import type {
  ChatMessage,
  FacilitatorMode,
  CycleFlags,
  ConversationConfig,
} from './types.js';
import { DEFAULT_CONVERSATION_CONFIG as defaultConfig } from './types.js';
import type { ILLMProvider } from './llm-provider.js';
import {
  FACILITATOR_CHAT_TEMPLATE,
  FACILITATOR_DECISION_TEMPLATE,
  FACILITATOR_SCOPING_TEMPLATE,
} from './prompt-templates.js';
import type { RuntimeMapManager } from './runtime-map.js';

const GATE_ACTION_PATTERNS: Array<{ pattern: RegExp; action: string }> = [
  { pattern: /\bapprove\b/i, action: 'approve' },
  { pattern: /\blooks good\b/i, action: 'approve' },
  { pattern: /\bproceed\b/i, action: 'approve' },
  { pattern: /\brevise\b/i, action: 'revise' },
  { pattern: /\bchange step\b/i, action: 'revise' },
  { pattern: /\bmodify\b/i, action: 'revise' },
  { pattern: /\breject sharding\b/i, action: 'reject_sharding' },
  { pattern: /\bdon't shard\b/i, action: 'reject_sharding' },
  { pattern: /\bhalt\b/i, action: 'halt' },
  { pattern: /\bstop cycle\b/i, action: 'halt' },
];

export function resolveFacilitatorMode(
  chatState: { session_open: boolean },
  systemStatus: string,
  cycleFlags: CycleFlags,
): FacilitatorMode[] {
  const modes: FacilitatorMode[] = [];
  if (chatState.session_open) {
    modes.push('chat');
  }
  if (systemStatus === 'cycling') {
    if (cycleFlags.awaiting_scoping) {
      modes.push('scoping');
    }
    if (cycleFlags.awaiting_confirmation || cycleFlags.awaiting_sharding_approval) {
      modes.push('decision');
    }
  }
  return modes;
}

export function detectGateAction(input: string): string | null {
  for (const { pattern, action } of GATE_ACTION_PATTERNS) {
    if (pattern.test(input)) return action;
  }
  return null;
}

export function selectTemplate(
  modes: FacilitatorMode[],
  input: string,
): string {
  if (modes.includes('scoping') && !detectGateAction(input)) {
    return FACILITATOR_SCOPING_TEMPLATE;
  }
  if (modes.includes('decision') && detectGateAction(input)) {
    return FACILITATOR_DECISION_TEMPLATE;
  }
  if (modes.includes('chat')) {
    return FACILITATOR_CHAT_TEMPLATE;
  }
  return FACILITATOR_CHAT_TEMPLATE;
}

export class ChatService {
  private historyPath: string;
  private config: ConversationConfig;

  constructor(
    projectRoot: string,
    private mapManager: RuntimeMapManager,
    private llmProvider: ILLMProvider | null,
    config?: Partial<ConversationConfig>,
  ) {
    this.historyPath = path.join(projectRoot, '.sle', 'chat-history.jsonl');
    this.config = { ...defaultConfig, ...config };
  }

  setLLMProvider(provider: ILLMProvider | null): void {
    this.llmProvider = provider;
  }

  async openSession(): Promise<{ session_open: boolean; session_id: string; resumed: boolean }> {
    const map = await this.mapManager.read();
    if (map.chat.session_open) {
      return {
        session_open: true,
        session_id: map.chat.session_id!,
        resumed: false,
      };
    }

    const sessionId = randomUUID();
    const now = new Date().toISOString();

    await this.mapManager.update((m) => ({
      ...m,
      chat: {
        ...m.chat,
        session_open: true,
        session_id: sessionId,
        started_at: now,
        last_active_at: now,
        total_exchanges: m.chat.total_exchanges,
        pending_decisions: m.chat.pending_decisions,
        last_consumed_by_cycle: m.chat.last_consumed_by_cycle,
      },
    }));

    return { session_open: true, session_id: sessionId, resumed: true };
  }

  async closeSession(): Promise<{ session_open: boolean }> {
    const map = await this.mapManager.read();
    if (!map.chat.session_open) {
      return { session_open: false };
    }

    await this.mapManager.update((m) => ({
      ...m,
      chat: {
        ...m.chat,
        session_open: false,
        last_active_at: new Date().toISOString(),
      },
    }));

    return { session_open: false };
  }

  async loadHistory(limit?: number): Promise<ChatMessage[]> {
    const count = limit ?? this.config.context_window_exchanges;
    try {
      const content = await fs.readFile(this.historyPath, 'utf8');
      const lines = content.trim().split('\n').filter(Boolean);
      const messages: ChatMessage[] = [];
      for (const line of lines) {
        try {
          messages.push(JSON.parse(line));
        } catch {
          continue;
        }
      }
      return messages.slice(-count);
    } catch {
      return [];
    }
  }

  async appendMessage(message: ChatMessage): Promise<void> {
    const line = JSON.stringify(message) + '\n';
    await fs.appendFile(this.historyPath, line, 'utf8');
  }

  async handleMessage(
    content: string,
    systemStatus: string,
    cycleFlags: CycleFlags,
  ): Promise<{
    userMessage: ChatMessage;
    facilitatorMessage: ChatMessage;
    modes: FacilitatorMode[];
    gateAction: string | null;
  }> {
    const map = await this.mapManager.read();
    if (!map.chat.session_open) {
      throw new Error('chat_not_open');
    }

    const now = new Date().toISOString();
    const userMessage: ChatMessage = {
      ts: now,
      role: 'user',
      content,
    };

    const modes = resolveFacilitatorMode(map.chat, systemStatus, cycleFlags);
    const gateAction = detectGateAction(content);
    const template = selectTemplate(modes, content);

    const history = await this.loadHistory();
    const historyMessages = history.map((m) => ({
      role: (m.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
      content: m.content,
    }));

    const systemStateSummary = JSON.stringify({
      status: systemStatus,
      cycle: map.cycle.number,
      iteration: map.cycle.iteration,
      awaiting_scoping: cycleFlags.awaiting_scoping,
      awaiting_confirmation: cycleFlags.awaiting_confirmation,
      awaiting_sharding_approval: cycleFlags.awaiting_sharding_approval,
    });

    const systemPrompt = `${template}\n\nCurrent project state:\n${systemStateSummary}`;

    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: systemPrompt },
      ...historyMessages.slice(-this.config.context_window_exchanges),
      { role: 'user', content },
    ];

    let reply: string;
    if (this.llmProvider) {
      try {
        const response = await this.llmProvider.complete({
          model: 'gpt-4o',
          temperature: 0.7,
          max_tokens: 500,
          messages,
        });
        reply = response.content;
      } catch {
        reply = this.buildFallbackReply(systemStatus, content);
      }
    } else {
      reply = this.buildFallbackReply(systemStatus, content);
    }

    const facilitatorMessage: ChatMessage = {
      ts: new Date().toISOString(),
      role: 'facilitator',
      content: reply,
    };

    await this.appendMessage(userMessage);
    await this.appendMessage(facilitatorMessage);

    await this.mapManager.update((m) => ({
      ...m,
      chat: {
        ...m.chat,
        last_active_at: new Date().toISOString(),
        total_exchanges: m.chat.total_exchanges + 1,
      },
    }));

    return { userMessage, facilitatorMessage, modes, gateAction };
  }

  private buildFallbackReply(systemStatus: string, _userContent: string): string {
    switch (systemStatus) {
      case 'idle':
        return 'I am the Facilitator. The system is currently idle. We are fully set to start a new cycle. Just let me know when you want to execute a task proposal!';
      case 'cycling':
        return 'The system is actively executing a cycle right now. I\'ll alert you as soon as confirmation checkpoints are hit!';
      case 'halted':
        return 'The system is halted. You can resume or acknowledge the halt when ready.';
      case 'complete':
        return 'The cycle has completed. You can start a new cycle whenever you\'re ready.';
      default:
        return 'I am the Facilitator. How can I help you?';
    }
  }
}
