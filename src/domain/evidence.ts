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

  // candidateRef: the commit SHA (or other immutable ref) this evidence is
  // bound to. Evidence for SHA A must never satisfy a requirement for SHA B.
  // Optional for backward compatibility; new collectors must always set it.
  candidateRef: z.string().optional(),

  // collectorId: set by the registered EvidenceCollector, not by the caller.
  // Allows the completion policy to distinguish trust tiers without relying on
  // the caller-supplied source string alone.
  collectorId: z.string().optional(),

  subjectRef: z.string().optional(), // e.g. PR URL, check run URL

  status: EvidenceStatusEnum,
  payload: JsonValueSchema,

  collectedAt: TimestampSchema,
});

export type Evidence = z.infer<typeof EvidenceSchema>;
