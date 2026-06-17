import { z } from 'zod';
import {
  SystemStatusEnum,
  DiscoveryStatusEnum,
  type SystemStatus,
  type DiscoveryStatus,
} from './types.js';
import type { RuntimeMap, RuntimeMapManager } from './runtime-map.js';

export type TransitionId =
  | 'T1'
  | 'T2'
  | 'T3'
  | 'T4'
  | 'T5'
  | 'T6'
  | 'T7'
  | 'T8'
  | 'T9'
  | 'T10'
  | 'T11'
  | 'T12';

export const TransitionIdSchema = z.enum([
  'T1',
  'T2',
  'T3',
  'T4',
  'T5',
  'T6',
  'T7',
  'T8',
  'T9',
  'T10',
  'T11',
  'T12',
]);

export interface TransitionRule {
  id: TransitionId;
  from: SystemStatus;
  to: SystemStatus;
  precondition: (map: RuntimeMap) => boolean;
  apply: (map: RuntimeMap) => RuntimeMap;
}

export interface TransitionResult {
  success: boolean;
  transition?: TransitionId;
  from: SystemStatus;
  to: SystemStatus;
  error?: {
    code: string;
    reason: string;
    allowedTargets: SystemStatus[];
  };
}

export const TransitionResultSchema = z.object({
  success: z.boolean(),
  transition: TransitionIdSchema.optional(),
  from: SystemStatusEnum,
  to: SystemStatusEnum,
  error: z
    .object({
      code: z.string(),
      reason: z.string(),
      allowedTargets: z.array(SystemStatusEnum),
    })
    .optional(),
});

export interface StateContext {
  state: SystemStatus;
  active_session_id: string | null;
  active_cycle_id: string | null;
  discovery_status: DiscoveryStatus;
  iteration: number;
  revision: number;
}

export const StateContextSchema = z.object({
  state: SystemStatusEnum,
  active_session_id: z.string().nullable(),
  active_cycle_id: z.string().nullable(),
  discovery_status: DiscoveryStatusEnum,
  iteration: z.number().nonnegative(),
  revision: z.number().nonnegative(),
});

export type CycleFlag = 'awaiting_scoping' | 'awaiting_confirmation' | 'awaiting_sharding_approval';

const CYCLE_FLAGS: CycleFlag[] = [
  'awaiting_scoping',
  'awaiting_confirmation',
  'awaiting_sharding_approval',
];

function resetCycleFlags(map: RuntimeMap): RuntimeMap {
  return {
    ...map,
    cycle: {
      ...map.cycle,
      awaiting_scoping: false,
      awaiting_confirmation: false,
      awaiting_sharding_approval: false,
    },
  };
}

const TRANSITION_TABLE: TransitionRule[] = [
  {
    id: 'T1',
    from: 'idle',
    to: 'discovering',
    precondition: (map) => map.discovery.status !== 'complete',
    apply: (map) => ({
      ...map,
      meta: { ...map.meta, status: 'discovering' },
      discovery: {
        ...map.discovery,
        status: 'in_progress',
        current_round: 1,
      },
    }),
  },
  {
    id: 'T2',
    from: 'discovering',
    to: 'idle',
    precondition: (map) =>
      map.discovery.total_rounds > 0 &&
      map.discovery.current_round >= map.discovery.total_rounds,
    apply: (map) => ({
      ...map,
      meta: { ...map.meta, status: 'idle' },
      discovery: {
        ...map.discovery,
        status: 'complete',
        completed_at: new Date().toISOString(),
      },
    }),
  },
  {
    id: 'T3',
    from: 'idle',
    to: 'cycling',
    precondition: (map) => map.discovery.status === 'complete',
    apply: (map) => {
      const nextCycle = map.meta.cycle + 1;
      return resetCycleFlags({
        ...map,
        meta: { ...map.meta, status: 'cycling', cycle: nextCycle },
        cycle: {
          ...map.cycle,
          number: nextCycle,
          iteration: 1,
          revision: 0,
          started_at: new Date().toISOString(),
          completed_at: undefined,
          outcome: 'cycling',
          approval_gate: null,
        },
      });
    },
  },
  {
    id: 'T4',
    from: 'cycling',
    to: 'cycling',
    precondition: (map) => map.cycle.iteration < map.cycle.max_iterations,
    apply: (map) =>
      resetCycleFlags({
        ...map,
        cycle: {
          ...map.cycle,
          iteration: map.cycle.iteration + 1,
          revision: 0,
        },
      }),
  },
  {
    id: 'T5',
    from: 'cycling',
    to: 'halted',
    precondition: () => true,
    apply: (map) =>
      resetCycleFlags({
        ...map,
        meta: { ...map.meta, status: 'halted' },
        cycle: {
          ...map.cycle,
          outcome: 'halted',
          completed_at: new Date().toISOString(),
        },
      }),
  },
  {
    id: 'T6',
    from: 'cycling',
    to: 'halted',
    precondition: (map) => map.cycle.iteration >= map.cycle.max_iterations,
    apply: (map) =>
      resetCycleFlags({
        ...map,
        meta: { ...map.meta, status: 'halted' },
        cycle: {
          ...map.cycle,
          outcome: 'halted',
          completed_at: new Date().toISOString(),
        },
      }),
  },
  {
    id: 'T7',
    from: 'cycling',
    to: 'halted',
    precondition: () => true,
    apply: (map) =>
      resetCycleFlags({
        ...map,
        meta: { ...map.meta, status: 'halted' },
        cycle: {
          ...map.cycle,
          outcome: 'halted',
          completed_at: new Date().toISOString(),
        },
      }),
  },
  {
    id: 'T8',
    from: 'cycling',
    to: 'complete',
    precondition: (map) => map.validation.gate.last_outcome === 'passed',
    apply: (map) =>
      resetCycleFlags({
        ...map,
        meta: { ...map.meta, status: 'complete' },
        cycle: {
          ...map.cycle,
          outcome: 'completed',
          completed_at: new Date().toISOString(),
        },
      }),
  },
  {
    id: 'T9',
    from: 'complete',
    to: 'idle',
    precondition: () => true,
    apply: (map) =>
      resetCycleFlags({
        ...map,
        meta: { ...map.meta, status: 'idle' },
      }),
  },
  {
    id: 'T10',
    from: 'halted',
    to: 'idle',
    precondition: () => true,
    apply: (map) =>
      resetCycleFlags({
        ...map,
        meta: { ...map.meta, status: 'idle' },
      }),
  },
  {
    id: 'T11',
    from: 'idle',
    to: 'cycling',
    precondition: () => true,
    apply: (map) => {
      const nextCycle = map.meta.cycle + 1;
      return resetCycleFlags({
        ...map,
        meta: { ...map.meta, status: 'cycling', cycle: nextCycle },
        cycle: {
          ...map.cycle,
          number: nextCycle,
          iteration: 1,
          revision: 0,
          started_at: new Date().toISOString(),
          completed_at: undefined,
          outcome: 'cycling',
          approval_gate: null,
        },
      });
    },
  },
  {
    id: 'T12',
    from: 'halted',
    to: 'cycling',
    precondition: () => true,
    apply: (map) =>
      resetCycleFlags({
        ...map,
        meta: { ...map.meta, status: 'cycling' },
        cycle: {
          ...map.cycle,
          outcome: 'cycling',
          completed_at: undefined,
        },
      }),
  },
];

const TRANSITION_MAP = new Map<TransitionId, TransitionRule>(
  TRANSITION_TABLE.map((rule) => [rule.id, rule])
);

function getAllowedTransitionsFromState(state: SystemStatus): TransitionId[] {
  return TRANSITION_TABLE.filter((rule) => rule.from === state).map((rule) => rule.id);
}

function getAllowedTargetStates(state: SystemStatus): SystemStatus[] {
  const targets = new Set<SystemStatus>();
  for (const rule of TRANSITION_TABLE) {
    if (rule.from === state) {
      targets.add(rule.to);
    }
  }
  return [...targets];
}

export class TransitionRejection extends Error {
  error: string;
  from: SystemStatus;
  to: SystemStatus;
  reason: string;
  allowedTargets: SystemStatus[];

  constructor(options: {
    error: string;
    from: SystemStatus;
    to: SystemStatus;
    reason: string;
    allowedTargets: SystemStatus[];
  }) {
    super(options.reason);
    this.name = 'TransitionRejection';
    this.error = options.error;
    this.from = options.from;
    this.to = options.to;
    this.reason = options.reason;
    this.allowedTargets = options.allowedTargets;
  }
}

export function validateTransition(
  id: TransitionId,
  map: RuntimeMap
): { valid: boolean; reason?: string; errorCode?: string } {
  const rule = TRANSITION_MAP.get(id);
  if (!rule) {
    return { valid: false, reason: `Unknown transition: ${id}`, errorCode: 'invalid_transition' };
  }
  if (map.meta.status !== rule.from) {
    return {
      valid: false,
      errorCode: 'invalid_transition',
      reason: `Transition ${id} requires state '${rule.from}' but current state is '${map.meta.status}'`,
    };
  }
  if (!rule.precondition(map)) {
    return {
      valid: false,
      errorCode: id === 'T3' ? 'discovery_required' : 'invalid_transition',
      reason: `Precondition for ${id} not met in current state '${map.meta.status}'`,
    };
  }
  return { valid: true };
}

export function computeStateContext(map: RuntimeMap): StateContext {
  return {
    state: map.meta.status,
    active_session_id: null,
    active_cycle_id: map.meta.active_cycle_id ?? null,
    discovery_status: map.discovery.status,
    iteration: map.cycle.iteration,
    revision: map.cycle.revision,
  };
}

export class StateMachine {
  private mapManager: RuntimeMapManager;

  constructor(mapManager: RuntimeMapManager) {
    this.mapManager = mapManager;
  }

  async transition(id: TransitionId): Promise<TransitionResult> {
    const map = await this.mapManager.read();
    const validation = validateTransition(id, map);

    if (!validation.valid) {
      return {
        success: false,
        from: map.meta.status,
        to: map.meta.status,
        error: {
          code: validation.errorCode ?? 'invalid_transition',
          reason: validation.reason!,
          allowedTargets: getAllowedTargetStates(map.meta.status),
        },
      };
    }

    const rule = TRANSITION_MAP.get(id)!;
    const from = map.meta.status;

    await this.mapManager.update((current) => rule.apply(current));

    return {
      success: true,
      transition: id,
      from,
      to: rule.to,
    };
  }

  async startDiscovery(): Promise<TransitionResult> {
    return this.transition('T1');
  }

  async endDiscovery(): Promise<TransitionResult> {
    return this.transition('T2');
  }

  async startCycle(force?: boolean): Promise<TransitionResult> {
    return this.transition(force ? 'T11' : 'T3');
  }

  async retryIteration(): Promise<TransitionResult> {
    return this.transition('T4');
  }

  async halt(reason: 'user' | 'cap_exceeded' | 'error' | 'scoping_timeout'): Promise<TransitionResult> {
    const id: TransitionId =
      reason === 'user' ? 'T5' : reason === 'cap_exceeded' ? 'T6' : 'T7';
    return this.transition(id);
  }

  async completeCycle(): Promise<TransitionResult> {
    return this.transition('T8');
  }

  async acknowledgeComplete(): Promise<TransitionResult> {
    return this.transition('T9');
  }

  async acknowledgeHalt(): Promise<TransitionResult> {
    return this.transition('T10');
  }

  async resume(): Promise<TransitionResult> {
    return this.transition('T12');
  }

  async getStateContext(): Promise<StateContext> {
    const map = await this.mapManager.read();
    return computeStateContext(map);
  }

  async getAllowedTransitions(): Promise<TransitionId[]> {
    const map = await this.mapManager.read();
    return getAllowedTransitionsFromState(map.meta.status);
  }

  async setFlag(
    flag: CycleFlag,
    value: boolean,
    confirmAction?: 'approve' | 'modify' | 'halt'
  ): Promise<TransitionResult | void> {
    if (flag === 'awaiting_confirmation' && !value && confirmAction === 'halt') {
      return this.halt('user');
    }

    await this.mapManager.update((map) => {
      const updated = { ...map, cycle: { ...map.cycle } };

      if (value) {
        for (const f of CYCLE_FLAGS) {
          updated.cycle[f] = f === flag;
        }
      } else {
        updated.cycle[flag] = false;
      }

      if (flag === 'awaiting_confirmation' && !value && confirmAction === 'modify') {
        updated.cycle.revision += 1;
      }

      return updated;
    });
  }
}
