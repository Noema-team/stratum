import { z } from 'zod';
import { UUIDSchema } from './primitives.js';

export const PolicyOutcomeEnum = z.enum(['allow', 'deny', 'require_decision']);
export type PolicyOutcome = z.infer<typeof PolicyOutcomeEnum>;

export const PolicyEvaluationSchema = z.object({
  outcome: PolicyOutcomeEnum,
  reason: z.string().min(1),
  decisionType: z.string().optional(), // set when outcome is 'require_decision'
});
export type PolicyEvaluation = z.infer<typeof PolicyEvaluationSchema>;

// Structured configuration for a project's policy rules.
// Evaluated deterministically by code — never inserted raw into agent prompts.
export const MergePermissionSchema = z.object({
  humanApproval: z.boolean(),
});

export const DependencyPolicySchema = z.object({
  major: z.enum(['approval_required', 'allowed', 'denied']),
  minor: z.enum(['approval_required', 'allowed', 'denied']),
  patch: z.enum(['approval_required', 'allowed', 'denied']).optional(),
});

export const AgentPermissionsSchema = z.object({
  pushBranch: z.enum(['allowed', 'denied']),
  createPr: z.enum(['allowed', 'denied']),
  merge: z.enum(['allowed', 'denied']),
  destructiveActions: z.enum(['allowed', 'denied', 'approval_required']).optional(),
});

export const BudgetPolicySchema = z.object({
  maxAttempts: z.number().int().positive().optional(),
  maxRuntimeMinutes: z.number().positive().optional(),
  maxChildWorkItems: z.number().int().positive().optional(),
  maxCostUsd: z.number().positive().optional(),
});

export const PolicyConfigSchema = z.object({
  projectId: UUIDSchema,
  merge: MergePermissionSchema.optional(),
  newInfrastructureApproval: z.boolean().optional(),
  schemaChangeApproval: z.boolean().optional(),
  dependencies: DependencyPolicySchema.optional(),
  agentPermissions: AgentPermissionsSchema.optional(),
  defaultBudget: BudgetPolicySchema.optional(),
});

export type PolicyConfig = z.infer<typeof PolicyConfigSchema>;
