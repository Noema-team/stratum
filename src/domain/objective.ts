import { z } from 'zod';
import { UUIDSchema, ConstraintSchema, CriterionSchema } from './primitives.js';

export const ObjectiveStatusEnum = z.enum(['draft', 'active', 'completed', 'cancelled']);
export type ObjectiveStatus = z.infer<typeof ObjectiveStatusEnum>;

export const ObjectiveSchema = z.object({
  id: UUIDSchema,
  projectId: UUIDSchema,
  title: z.string().min(1),
  description: z.string().min(1),
  priority: z.number().int().nonnegative(),
  status: ObjectiveStatusEnum,
  constraints: z.array(ConstraintSchema),
  successCriteria: z.array(CriterionSchema),
});

export type Objective = z.infer<typeof ObjectiveSchema>;
