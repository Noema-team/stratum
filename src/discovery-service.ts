import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { z } from 'zod';
import type { StateAPI, TransitionRequest } from './state-api.js';
import type { RuntimeMapManager } from './runtime-map.js';
import type { DiscoveryState } from './types.js';

const DiscoverySessionStateSchema = z.object({
  session_id: z.string().uuid(),
  mode: z.enum(['full', 'solo']),
  current_round: z.number().nonnegative(),
  round_status: z.enum(['collecting', 'drafting', 'approved']),
  completed_rounds: z.array(z.number().nonnegative()),
  artifacts_written: z.array(z.string()),
  open_questions_deferred: z.array(
    z.object({
      title: z.string(),
      status: z.enum(['open', 'resolved']),
      blocking: z.union([z.string().regex(/^phase:\d+$/), z.literal('not_blocking')]),
      owner: z.string().optional(),
      resolve_by: z.string().optional(),
      context: z.string(),
    })
  ),
  started_at: z.string().datetime(),
  last_interaction_at: z.string().datetime(),
});

type DiscoverySessionState = z.infer<typeof DiscoverySessionStateSchema>;

interface StartParams {
  mode?: 'full' | 'solo';
  revisit?: boolean;
}

interface DiscoverySession {
  session_id: string;
  mode: 'full' | 'solo';
  current_round: number;
  round_status: 'collecting' | 'drafting' | 'approved';
  total_rounds: number;
  started_at: string;
}

interface RoundResult {
  session_id: string;
  round: number;
  status: 'collecting' | 'drafting' | 'approved';
  artifact_path?: string;
  next_round?: number;
  completed?: boolean;
}

interface DiscoveryResult {
  session_id: string;
  status: 'not_started' | 'in_progress' | 'complete';
  mode: 'full' | 'solo';
  current_round: number;
  total_rounds: number;
  artifacts: string[];
  open_questions_count: number;
  blocking_questions_count: number;
}

export class DiscoveryService {
  private stateAPI: StateAPI;
  private mapManager: RuntimeMapManager;
  private projectRoot: string;

  constructor(stateAPI: StateAPI, mapManager: RuntimeMapManager, projectRoot: string) {
    this.stateAPI = stateAPI;
    this.mapManager = mapManager;
    this.projectRoot = projectRoot;
  }

  async start(projectRoot: string, params: StartParams = {}): Promise<DiscoverySession> {
    const sleDir = path.join(projectRoot, '.sle');
    const sessionPath = path.join(sleDir, 'discovery-session.json');

    const mode = params.mode ?? 'full';
    const totalRounds = mode === 'solo' ? 1 : 4;

    const sessionState: DiscoverySessionState = {
      session_id: randomUUID(),
      mode,
      current_round: 1,
      round_status: 'collecting',
      completed_rounds: [],
      artifacts_written: [],
      open_questions_deferred: [],
      started_at: new Date().toISOString(),
      last_interaction_at: new Date().toISOString(),
    };

    DiscoverySessionStateSchema.parse(sessionState);

    await fs.mkdir(sleDir, { recursive: true });
    await fs.writeFile(sessionPath, JSON.stringify(sessionState, null, 2));

    await this.mapManager.update((map) => {
      const updated = { ...map };
      updated.discovery = {
        ...updated.discovery,
        status: 'in_progress',
        mode,
        current_round: 1,
        total_rounds: totalRounds,
      };
      return updated;
    });

    const transitionRequest: TransitionRequest = {
      target: 'discovering',
      trigger: 'discovery.start',
      payload: { session_id: sessionState.session_id, mode },
    };

    await this.stateAPI.transition(transitionRequest);

    return {
      session_id: sessionState.session_id,
      mode,
      current_round: 1,
      round_status: 'collecting',
      total_rounds: totalRounds,
      started_at: sessionState.started_at,
    };
  }

  async submitResponse(sessionId: string, round: number): Promise<RoundResult> {
    const sessionPath = path.join(this.projectRoot, '.sle', 'discovery-session.json');
    const sessionContent = await fs.readFile(sessionPath, 'utf-8');
    const sessionState = DiscoverySessionStateSchema.parse(JSON.parse(sessionContent));

    if (sessionState.session_id !== sessionId) {
      throw new Error('Session ID mismatch');
    }

    if (sessionState.current_round !== round) {
      throw new Error(`Round ${round} is not the current round (current: ${sessionState.current_round})`);
    }

    const updatedSession: DiscoverySessionState = {
      ...sessionState,
      round_status: 'drafting',
      last_interaction_at: new Date().toISOString(),
    };

    DiscoverySessionStateSchema.parse(updatedSession);

    await fs.writeFile(sessionPath, JSON.stringify(updatedSession, null, 2));

    return {
      session_id: sessionId,
      round,
      status: 'drafting',
    };
  }

  async approveRound(sessionId: string, round: number): Promise<void> {
    const sessionPath = path.join(this.projectRoot, '.sle', 'discovery-session.json');
    const sessionContent = await fs.readFile(sessionPath, 'utf-8');
    const sessionState = DiscoverySessionStateSchema.parse(JSON.parse(sessionContent));

    if (sessionState.session_id !== sessionId) {
      throw new Error('Session ID mismatch');
    }

    if (sessionState.current_round !== round) {
      throw new Error(`Round ${round} is not the current round (current: ${sessionState.current_round})`);
    }

    const completed_rounds = [...sessionState.completed_rounds, round];
    const isLastRound = round === (sessionState.mode === 'solo' ? 1 : 4);
    const nextRound = isLastRound ? undefined : round + 1;

    const updatedSession: DiscoverySessionState = {
      ...sessionState,
      round_status: 'approved',
      completed_rounds,
      last_interaction_at: new Date().toISOString(),
      ...(nextRound !== undefined && { current_round: nextRound, round_status: 'collecting' }),
    };

    DiscoverySessionStateSchema.parse(updatedSession);

    await fs.writeFile(sessionPath, JSON.stringify(updatedSession, null, 2));

    if (isLastRound) {
      await this.mapManager.update((map) => {
        const updated = { ...map };
        updated.discovery = {
          ...updated.discovery,
          status: 'complete',
          completed_at: new Date().toISOString(),
          artifacts: sessionState.artifacts_written,
          current_phase: 0,
          total_phases: 0,
          open_questions_count: sessionState.open_questions_deferred.length,
          blocking_questions_count: sessionState.open_questions_deferred.filter(
            (q) => q.blocking !== 'not_blocking'
          ).length,
        };
        return updated;
      });

      const transitionRequest: TransitionRequest = {
        target: 'idle',
        trigger: 'discovery.complete',
        payload: { session_id: sessionId },
      };

      await this.stateAPI.transition(transitionRequest);

      await fs.unlink(sessionPath);
    }
  }

  async getStatus(sessionId: string): Promise<DiscoveryResult> {
    const sessionPath = path.join(this.projectRoot, '.sle', 'discovery-session.json');
    const map = await this.mapManager.read();

    const discovery: DiscoveryState = map.discovery;

    let sessionState: DiscoverySessionState | undefined;
    try {
      const sessionContent = await fs.readFile(sessionPath, 'utf-8');
      sessionState = DiscoverySessionStateSchema.parse(JSON.parse(sessionContent));
    } catch {
      sessionState = undefined;
    }

    if (discovery.status === 'complete') {
      return {
        session_id: sessionId,
        status: 'complete',
        mode: discovery.mode,
        current_round: discovery.total_rounds,
        total_rounds: discovery.total_rounds,
        artifacts: discovery.artifacts,
        open_questions_count: discovery.open_questions_count,
        blocking_questions_count: discovery.blocking_questions_count,
      };
    }

    if (!sessionState || sessionState.session_id !== sessionId) {
      throw new Error('Session not found');
    }

    const totalRounds = sessionState.mode === 'solo' ? 1 : 4;

    return {
      session_id: sessionState.session_id,
      status: 'in_progress',
      mode: sessionState.mode,
      current_round: sessionState.current_round,
      total_rounds: totalRounds,
      artifacts: sessionState.artifacts_written,
      open_questions_count: sessionState.open_questions_deferred.length,
      blocking_questions_count: sessionState.open_questions_deferred.filter(
        (q) => q.blocking !== 'not_blocking'
      ).length,
    };
  }
}
