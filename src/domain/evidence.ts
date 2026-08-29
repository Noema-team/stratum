import { z } from 'zod';
import { UUIDSchema, TimestampSchema, JsonValueSchema } from './primitives.js';

export const EvidenceStatusEnum = z.enum(['passed', 'failed', 'informational']);
export type EvidenceStatus = z.infer<typeof EvidenceStatusEnum>;

export const EvidenceSchema = z.object({
  id: UUIDSchema,
  workItemId: UUIDSchema,
  stepExecutionId: UUIDSchema.optional(),

  type: z.string().min(1),       // e.g. 'github.ci', 'ci_toolkit.semantic_review'
  source: z.string().min(1),
  subjectRef: z.string().optional(), // e.g. commit SHA, PR URL

  status: EvidenceStatusEnum,
  payload: JsonValueSchema,

  collectedAt: TimestampSchema,
});

export type Evidence = z.infer<typeof EvidenceSchema>;
