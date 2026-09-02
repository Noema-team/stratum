import { z } from 'zod';
import { UUIDSchema, TimestampSchema } from './primitives.js';

export const ProjectStatusEnum = z.enum(['active', 'paused', 'archived']);
export type ProjectStatus = z.infer<typeof ProjectStatusEnum>;

export const ProjectSchema = z.object({
  id: UUIDSchema,
  workspaceId: UUIDSchema,
  name: z.string().min(1),
  description: z.string().optional(),
  status: ProjectStatusEnum,
  priority: z.number().int().nonnegative(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export type Project = z.infer<typeof ProjectSchema>;
