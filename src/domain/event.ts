import { z } from 'zod';
import { UUIDSchema, TimestampSchema, JsonValueSchema } from './primitives.js';

// Control-plane event types (DDR-032 §14).
// Intra-run events (workflow_run.*, step.*) are governed by DDR-031 — not listed here.
export const CONTROL_PLANE_EVENT_TYPES = [
  'project.created',
  'objective.created',
  'objective.activated',
  'work.created',
  'work.ready',
  'work.started',
  'work.state_changed',
  'work.completed',
  'step_execution.dispatched',
  'step_execution.completed',
  'step_execution.failed',
  'decision.requested',
  'decision.resolved',
  'policy.blocked',
  'evidence.recorded',
  'artifact.created',
  'pr.created',
  'pr.ready',
] as const;

export type ControlPlaneEventType = typeof CONTROL_PLANE_EVENT_TYPES[number];

export const DomainEventSchema = z.object({
  id: UUIDSchema,
  schemaVersion: z.literal(1),
  type: z.string().min(1),

  workspaceId: UUIDSchema,
  projectId: UUIDSchema.optional(),
  workItemId: UUIDSchema.optional(),
  workflowRunId: z.string().optional(), // join key to DDR-031 WorkflowRun

  occurredAt: TimestampSchema,
  payload: JsonValueSchema,
});

export type DomainEvent = z.infer<typeof DomainEventSchema>;
