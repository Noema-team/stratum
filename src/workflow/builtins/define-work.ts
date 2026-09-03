import type { WorkflowDefinition } from '../types.js';
import { DEFINITION_CONTRACT, READINESS_RUBRIC, GAP_CLASSIFICATION } from '../methodology/definition-readiness.js';

// define-work (D.3b1, closure-fixed in D.3b1.1): produces and iteratively
// refines a Definition Artifact against the D.3a readiness rubric — composed
// below as Stratum-owned runtime constants (see
// ../methodology/definition-readiness.ts), not read from a Stratum-repo
// doc path, since these steps run with projectRoot set to the TARGET
// repository being worked on, where that path would not exist — then
// commits. This phase implements only CAN_RESOLVE resolution (see
// docs/developmentPlan/d3a-definition-readiness-methodology.md, the
// human-readable design record) — HUMAN_DECISION/DEFER/EXPLORE_AS_WORK gaps
// are preserved as unresolved blockers, not routed.
//
// No context.gather step: WorkflowEngine's generic 'gather' kind is a
// no-op (mark running -> mark complete -> next step) — a gather step here
// would claim repository evidence was collected when it was not. Repository
// inspection instead happens inside synthesize-definition/refine-definition
// themselves, via AgentRunner's existing optional read-only AgentLoop
// investigation (used automatically when the active LLM provider supports
// multi-turn tool use) — never inside WorkflowEngine.
//
// Structure: synthesize-definition (iteration 1 only, by construction — the
// loop-back target is refine-definition, so this step is never revisited)
// -> refine-definition (skipped on iteration 1) -> definition-readiness-review
// -> on_pass: commit; on_fail: refine-definition (+ iteration, capped).
export const DEFINE_WORK: WorkflowDefinition = {
  id: 'define-work',
  label: 'Define Work',
  max_iterations: 4,
  steps: [
    {
      id: 'synthesize-definition',
      kind: 'produce',
      label: 'Synthesize Definition v1',
      agentRole: 'explorer',
      includeWorkItemContext: true,
      includeObjectiveContext: true,
      instruction:
        'Draft Definition v1 for this Objective: a goal, constraints, requirements, ' +
        'non-goals, design notes, risks, an acceptance model, and a fact ledger.\n\n' +
        `${DEFINITION_CONTRACT}\n\n` +
        'If a repository-inspection tool is available, use it to verify factual claims ' +
        'about this repository directly before marking any fact KNOWN with source: repository.',
      outputArtifact: {
        type: 'definition',
        ref: 'definition:{objectiveId}',
        path: '.sle/work/{workItemId}/definition.md',
      },
    },
    {
      id: 'refine-definition',
      kind: 'produce',
      label: 'Refine Definition',
      agentRole: 'explorer',
      skip_if: (ctx) => ctx.iteration === 1,
      includeWorkItemContext: true,
      includeObjectiveContext: true,
      instruction:
        'Revise the Definition using the prior readiness review\'s findings (the ' +
        'readiness artifact).\n\n' +
        `${DEFINITION_CONTRACT}\n\n${GAP_CLASSIFICATION}`,
      inputArtifactRefs: [
        '.sle/work/{workItemId}/definition.md',
        '.sle/work/{workItemId}/readiness.md',
      ],
      outputArtifact: {
        type: 'definition',
        ref: 'definition:{objectiveId}',
        path: '.sle/work/{workItemId}/definition.md',
      },
    },
    {
      id: 'definition-readiness-review',
      kind: 'review',
      label: 'Definition Readiness Review',
      agentRole: 'explorer',
      requiresReviewVerdict: true,
      includeWorkItemContext: true,
      includeObjectiveContext: true,
      instruction:
        'Evaluate the current Definition against the readiness rubric for the candidate ' +
        'bounded scope it defines.\n\n' +
        `${READINESS_RUBRIC}\n\n${GAP_CLASSIFICATION}\n\n` +
        'Declare your verdict in the SLE-OUTPUT preamble as `verdict: pass` only if all ' +
        'seven dimensions pass, otherwise `verdict: fail` — never omit the verdict line.',
      // The physical materialized path, not the semantic ref: ContextManager
      // resolves inputArtifactRefs against the filesystem, it does not query
      // ArtifactRepository for the semantic 'definition:{objectiveId}' ref.
      inputArtifactRefs: ['.sle/work/{workItemId}/definition.md'],
      outputArtifact: {
        type: 'definition-readiness',
        ref: 'definition-readiness:{objectiveId}',
        path: '.sle/work/{workItemId}/readiness.md',
      },
      on_pass: { target_step_id: 'commit' },
      on_fail: { target_step_id: 'refine-definition', iteration_loop: true },
    },
    {
      id: 'commit',
      kind: 'commit',
      label: 'Definition Commit',
    },
  ],
};
