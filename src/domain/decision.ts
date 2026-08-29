import { z } from 'zod';
import { UUIDSchema, TimestampSchema } from './primitives.js';

export const DecisionTypeEnum = z.enum([
  'checkpoint',
  'policy.escalation',
  'merge.approval',
  'scope.expansion',
  'budget.overrun',
]);
export type DecisionType = z.infer<typeof DecisionTypeEnum>;

// Open-ended type allows future extension beyond the known enum values
export const DecisionTypeSchema = z.union([DecisionTypeEnum, z.string().min(1)]);

export const DecisionImpactEnum = z.enum(['low', 'medium', 'high', 'critical']);
export type DecisionImpact = z.infer<typeof DecisionImpactEnum>;

export const DecisionReversibilityEnum = z.enum(['easy', 'medium', 'hard', 'irreversible']);
export type DecisionReversibility = z.infer<typeof DecisionReversibilityEnum>;

export const DecisionUrgencyEnum = z.enum(['normal', 'blocking', 'urgent']);
export type DecisionUrgency = z.infer<typeof DecisionUrgencyEnum>;

export const DecisionStatusEnum = z.enum(['pending', 'resolved', 'expired', 'cancelled']);
export type DecisionStatus = z.infer<typeof DecisionStatusEnum>;

export const DecisionOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
});
export type DecisionOption = z.infer<typeof DecisionOptionSchema>;

export const DecisionResolutionSchema = z.object({
  selectedOptionId: z.string().min(1),
  rationale: z.string().optional(),
  resolvedAt: TimestampSchema,
  resolvedBy: z.string().optional(),
});
export type DecisionResolution = z.infer<typeof DecisionResolutionSchema>;

export const DecisionSubjectRefSchema = z.object({
  workflowRunId: z.string().optional(),
  stepId: z.string().optional(),
  workItemId: UUIDSchema.optional(),
  pullRequestUrl: z.string().url().optional(),
}).refine(
  obj => Object.values(obj).some(v => v !== undefined),
  { message: 'DecisionSubjectRef must reference at least one subject' }
);
export type DecisionSubjectRef = z.infer<typeof DecisionSubjectRefSchema>;

export const DecisionSchema = z.object({
  id: UUIDSchema,
  projectId: UUIDSchema,
  workItemId: UUIDSchema.optional(),

  type: DecisionTypeSchema,
  subjectRef: DecisionSubjectRefSchema,

  title: z.string().min(1),
  summary: z.string().min(1),

  options: z.array(DecisionOptionSchema).min(1),
  recommendedOptionId: z.string().optional(),
  recommendationReason: z.string().optional(),

  impact: DecisionImpactEnum,
  reversibility: DecisionReversibilityEnum,
  urgency: DecisionUrgencyEnum,

  status: DecisionStatusEnum,
  resolution: DecisionResolutionSchema.optional(),
});

export type Decision = z.infer<typeof DecisionSchema>;
