import { z } from 'zod';
import { UUIDSchema, TimestampSchema, ConstraintSchema, CriterionSchema, EvidenceRequirementSchema } from './primitives.js';

// Primary states — the normal forward path
export const WorkItemPrimaryStateEnum = z.enum([
  'draft',
  'ready',
  'running',
  'in_review',
  'completed',
]);

// Side states — deviations from the forward path
export const WorkItemSideStateEnum = z.enum([
  'needs_decision',
  'blocked',
  'failed',
  'paused',
  'cancelled',
]);

export const WorkItemStateEnum = z.union([WorkItemPrimaryStateEnum, WorkItemSideStateEnum]);
export type WorkItemState = z.infer<typeof WorkItemStateEnum>;

export const WorkItemSchema = z.object({
  id: UUIDSchema,
  projectId: UUIDSchema,
  objectiveId: UUIDSchema.optional(),
  repositoryIds: z.array(UUIDSchema),

  title: z.string().min(1),
  goal: z.string().min(1),

  workflowId: z.string().min(1),
  state: WorkItemStateEnum,
  priority: z.number().int().nonnegative(),

  acceptanceCriteria: z.array(CriterionSchema),
  constraints: z.array(ConstraintSchema),
  requiredEvidence: z.array(EvidenceRequirementSchema),

  parentId: UUIDSchema.optional(),
  dependencies: z.array(UUIDSchema),

  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export type WorkItem = z.infer<typeof WorkItemSchema>;

// Terminal states — no further transitions allowed
export const WORK_ITEM_TERMINAL_STATES: WorkItemState[] = ['completed', 'failed', 'cancelled'];

export function isWorkItemTerminal(state: WorkItemState): boolean {
  return WORK_ITEM_TERMINAL_STATES.includes(state);
}
