import { z } from 'zod';
import { UUIDSchema } from './primitives.js';

export const RepositoryProviderEnum = z.enum(['github']);
export type RepositoryProvider = z.infer<typeof RepositoryProviderEnum>;

export const RepositoryStatusEnum = z.enum(['active', 'disabled']);
export type RepositoryStatus = z.infer<typeof RepositoryStatusEnum>;

export const RepositorySchema = z.object({
  id: UUIDSchema,
  projectId: UUIDSchema,
  provider: RepositoryProviderEnum,
  remote: z.string().min(1),
  defaultBranch: z.string().min(1),
  localWorkspace: z.string().optional(),
  status: RepositoryStatusEnum,
});

export type Repository = z.infer<typeof RepositorySchema>;
