import { z } from 'zod';

export const UUIDSchema = z.string().uuid();
export type UUID = z.infer<typeof UUIDSchema>;

export const TimestampSchema = z.string().datetime();
export type Timestamp = z.infer<typeof TimestampSchema>;

export const MoneySchema = z.object({
  amount: z.number().nonnegative(),
  currency: z.string().length(3),
});
export type Money = z.infer<typeof MoneySchema>;

export const JsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(JsonValueSchema),
  ])
);
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

export const FailureInfoSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  details: JsonValueSchema.optional(),
});
export type FailureInfo = z.infer<typeof FailureInfoSchema>;

export const ConstraintSchema = z.object({
  description: z.string().min(1),
  type: z.enum(['must', 'must_not', 'prefer', 'prefer_not']).optional(),
});
export type Constraint = z.infer<typeof ConstraintSchema>;

export const CriterionSchema = z.object({
  description: z.string().min(1),
  met: z.boolean().optional(),
});
export type Criterion = z.infer<typeof CriterionSchema>;

export const EvidenceRequirementSchema = z.object({
  type: z.string().min(1),
  conditions: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
  // When set, evidence must have a matching candidateRef — SHA A cannot
  // satisfy a requirement pinned to SHA B.
  candidateRef: z.string().optional(),
});
export type EvidenceRequirement = z.infer<typeof EvidenceRequirementSchema>;
