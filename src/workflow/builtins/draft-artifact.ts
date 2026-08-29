import type { WorkflowDefinition } from '../types.js';

// draft-artifact: the lightweight "short run" workflow (DDR-031).
// Used for: producing a single artifact (spec document, workflow definition,
// code review, etc.) without paying for the full pipeline.
//
// Structure: gather → produce → commit
// The chat router dispatches this when a quick-start goal is provided without
// the full build pipeline intent.

export const DRAFT_ARTIFACT: WorkflowDefinition = {
  id: 'draft-artifact',
  label: 'Draft Artifact',
  steps: [
    {
      id: 'gather',
      kind: 'gather',
      label: 'Context gather',
    },
    {
      id: 'produce',
      kind: 'produce',
      label: 'Artifact produce',
      agentRole: 'designer',   // default; caller may override via dispatch options
      templateId: 'draft-artifact',
    },
    {
      id: 'commit',
      kind: 'commit',
      label: 'Artifact commit',
      logs_decision: false,
    },
  ],
};
