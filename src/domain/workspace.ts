import { z } from 'zod';
import { UUIDSchema, TimestampSchema } from './primitives.js';

export const WorkspaceSchema = z.object({
  id: UUIDSchema,
  name: z.string().min(1),
  createdAt: TimestampSchema,
});

export type Workspace = z.infer<typeof WorkspaceSchema>;
