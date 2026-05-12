import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { z } from 'zod';
import {
  SystemStatusEnum,
  DaemonInfoSchema,
  type SystemStatus,
  type DaemonInfo,
  type APIResponse,
  type APIError,
} from './types.js';
import {
  StateMachine,
  StateContextSchema,
} from './state-machine.js';
import type { RuntimeMapManager } from './runtime-map.js';

export const TransitionRequestSchema = z.object({
  target: SystemStatusEnum,
  trigger: z.string().min(1),
  payload: z.record(z.unknown()).nullable().optional(),
});

export type TransitionRequest = z.infer<typeof TransitionRequestSchema>;

export const HealthDataSchema = z.object({
  status: z.literal('healthy'),
  uptime_ms: z.number().nonnegative(),
  version: z.string(),
});

export type HealthData = z.infer<typeof HealthDataSchema>;

export const FullStateSchema = StateContextSchema.extend({
  awaiting_scoping: z.boolean(),
  awaiting_confirmation: z.boolean(),
  awaiting_sharding_approval: z.boolean(),
  chat: z.object({
    session_open: z.boolean(),
  }),
});

export type FullState = z.infer<typeof FullStateSchema>;

export const TransitionResponseDataSchema = z.object({
  previous: SystemStatusEnum,
  current: SystemStatusEnum,
  cycle_id: z.string().nullable(),
});

export type TransitionResponseData = z.infer<typeof TransitionResponseDataSchema>;

export const StateChangedEventSchema = z.object({
  previous: SystemStatusEnum,
  current: SystemStatusEnum,
  trigger: z.string(),
  timestamp: z.string(),
});

export type StateChangedEvent = z.infer<typeof StateChangedEventSchema>;

export interface StateAPIOptions {
  version: string;
  sleVersion: string;
  port: number;
  projectRoot: string;
  startedAt: Date;
}

const TRANSITION_PAIRS: Array<{ from: SystemStatus; to: SystemStatus; ids: string[] }> = [
  { from: 'idle', to: 'discovering', ids: ['T1'] },
  { from: 'discovering', to: 'idle', ids: ['T2'] },
  { from: 'idle', to: 'cycling', ids: ['T3', 'T11'] },
  { from: 'cycling', to: 'cycling', ids: ['T4'] },
  { from: 'cycling', to: 'halted', ids: ['T5', 'T6', 'T7'] },
  { from: 'cycling', to: 'complete', ids: ['T8'] },
  { from: 'complete', to: 'idle', ids: ['T9'] },
  { from: 'halted', to: 'idle', ids: ['T10'] },
  { from: 'halted', to: 'cycling', ids: ['T12'] },
];

function resolveTransitionId(
  from: SystemStatus,
  to: SystemStatus
): string | undefined {
  for (const pair of TRANSITION_PAIRS) {
    if (pair.from === from && pair.to === to) {
      return pair.ids[0];
    }
  }
  return undefined;
}

export class StateAPI {
  private stateMachine: StateMachine;
  private options: StateAPIOptions;
  private events: EventEmitter;
  private stateChangeLock = false;

  constructor(mapManager: RuntimeMapManager, options: StateAPIOptions) {
    this.stateMachine = new StateMachine(mapManager);
    this.options = options;
    this.events = new EventEmitter();
  }

  onStateChanged(listener: (event: StateChangedEvent) => void): () => void {
    this.events.on('system.state_changed', listener);
    return () => {
      this.events.removeListener('system.state_changed', listener);
    };
  }

  async health(): Promise<APIResponse<HealthData>> {
    const uptimeMs = Date.now() - this.options.startedAt.getTime();
    return {
      ok: true,
      data: {
        status: 'healthy',
        uptime_ms: uptimeMs,
        version: this.options.version,
      },
      meta: {
        request_id: randomUUID(),
        timestamp: new Date().toISOString(),
      },
    };
  }

  async info(): Promise<APIResponse<DaemonInfo>> {
    const uptimeMs = Date.now() - this.options.startedAt.getTime();
    const info: DaemonInfo = {
      version: this.options.version,
      pid: process.pid,
      port: this.options.port,
      started_at: this.options.startedAt.toISOString(),
      uptime_ms: uptimeMs,
      project_root: this.options.projectRoot,
      sle_version: this.options.sleVersion,
    };
    DaemonInfoSchema.parse(info);
    return {
      ok: true,
      data: info,
      meta: {
        request_id: randomUUID(),
        timestamp: new Date().toISOString(),
      },
    };
  }

  async getSystemState(): Promise<APIResponse<FullState>> {
    const context = await this.stateMachine.getStateContext();
    const fullState: FullState = {
      ...context,
      awaiting_scoping: false,
      awaiting_confirmation: false,
      awaiting_sharding_approval: false,
      chat: {
        session_open: false,
      },
    };
    return {
      ok: true,
      data: fullState,
      meta: {
        request_id: randomUUID(),
        timestamp: new Date().toISOString(),
      },
    };
  }

  async transition(
    request: TransitionRequest
  ): Promise<APIResponse<TransitionResponseData> | APIError> {
    if (this.stateChangeLock) {
      return makeError('session_conflict', 'A state-changing operation is already in progress.');
    }

    this.stateChangeLock = true;
    try {
      const currentState = await this.stateMachine.getStateContext();
      const tid = resolveTransitionId(currentState.state, request.target);

      if (!tid) {
        const allowed = getAllowedTargets(currentState.state);
        return makeError(
          'invalid_transition',
          `Transition from ${currentState.state} to ${request.target} is not valid.`,
          {
            from: currentState.state,
            to: request.target,
            allowed,
          }
        );
      }

      const result = await this.stateMachine.transition(tid as 'T1');

      if (!result.success) {
        return makeError(
          result.error!.code,
          `Transition from ${result.from} to ${result.to} is not valid.`,
          {
            from: result.from,
            to: result.to,
            allowed: result.error!.allowedTargets,
          }
        );
      }

      const event: StateChangedEvent = {
        previous: result.from,
        current: result.to,
        trigger: request.trigger,
        timestamp: new Date().toISOString(),
      };
      StateChangedEventSchema.parse(event);
      this.events.emit('system.state_changed', event);

      return {
        ok: true,
        data: {
          previous: result.from,
          current: result.to,
          cycle_id: null,
        },
        meta: {
          request_id: randomUUID(),
          timestamp: new Date().toISOString(),
        },
      };
    } finally {
      this.stateChangeLock = false;
    }
  }
}

function getAllowedTargets(state: SystemStatus): SystemStatus[] {
  const targets = new Set<SystemStatus>();
  for (const pair of TRANSITION_PAIRS) {
    if (pair.from === state) {
      targets.add(pair.to);
    }
  }
  return [...targets];
}

function makeError(code: string, message: string, details?: unknown): APIError {
  return {
    ok: false,
    error: {
      code,
      message,
      details,
    },
    meta: {
      request_id: randomUUID(),
      timestamp: new Date().toISOString(),
    },
  };
}
