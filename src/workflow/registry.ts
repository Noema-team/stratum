import type { WorkflowDefinition } from './types.js';
import { FULL_BUILD } from './builtins/full-build.js';
import { DRAFT_ARTIFACT } from './builtins/draft-artifact.js';
import { DEFINE_WORK } from './builtins/define-work.js';

// Built-in workflow ids — reserved; cannot be overridden by user-authored workflows.
export const BUILTIN_IDS = new Set(['full-build', 'draft-artifact', 'define-work']);

// Registry — keyed by workflow id.
const REGISTRY = new Map<string, WorkflowDefinition>([
  ['full-build', FULL_BUILD],
  ['draft-artifact', DRAFT_ARTIFACT],
  ['define-work', DEFINE_WORK],
]);

// Register a user-authored workflow. Throws if the id is a reserved builtin.
export function registerWorkflow(def: WorkflowDefinition): void {
  if (BUILTIN_IDS.has(def.id)) {
    throw new Error(`Workflow id '${def.id}' is reserved — choose a different id`);
  }
  REGISTRY.set(def.id, def);
}

// Retrieve a workflow by id. Returns undefined for unknown ids.
export function getWorkflow(id: string): WorkflowDefinition | undefined {
  return REGISTRY.get(id);
}

// List all registered workflow ids.
export function listWorkflowIds(): string[] {
  return [...REGISTRY.keys()];
}

// Returns the step count for a given workflow (useful for tests and UI).
export function stepCount(workflowId: string): number {
  return REGISTRY.get(workflowId)?.steps.length ?? 0;
}
