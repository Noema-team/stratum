import { z } from 'zod';
import { UUIDSchema, TimestampSchema, MoneySchema, FailureInfoSchema } from './primitives.js';

export const StepExecutionStateEnum = z.enum([
  'dispatched',
  'running',
  'succeeded',
  'failed',
  'cancelled',
]);
export type StepExecutionState = z.infer<typeof StepExecutionStateEnum>;

export const StepExecutionSchema = z.object({
  id: UUIDSchema,
  workItemId: UUIDSchema,
  workflowRunId: z.string().min(1),  // DDR-031 WorkflowRun.run_id
  stepId: z.string().min(1),         // WorkflowStep.id within that run

  executor: z.string().min(1),       // ExecutionAdapter id, e.g. 'stratum-agent'
  state: StepExecutionStateEnum,
  attempt: z.number().int().positive(),

  startedAt: TimestampSchema.optional(),
  completedAt: TimestampSchema.optional(),

  cost: MoneySchema.optional(),
  tokens: z.number().int().nonnegative().optional(),

  failure: FailureInfoSchema.optional(),
});

export type StepExecution = z.infer<typeof StepExecutionSchema>;

export const STEP_EXECUTION_TERMINAL_STATES: StepExecutionState[] = [
  'succeeded',
  'failed',
  'cancelled',
];

export function isStepExecutionTerminal(state: StepExecutionState): boolean {
  return STEP_EXECUTION_TERMINAL_STATES.includes(state);
}
