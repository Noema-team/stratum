import type { WorkflowDefinition } from '../types.js';

// define-work (D.3b1): produces and iteratively refines a Definition
// Artifact against the readiness rubric in
// docs/developmentPlan/d3a-definition-readiness-methodology.md, then commits.
// D.3b1 implements only CAN_RESOLVE resolution (see
// docs/developmentPlan/d3b1-define-work.md) — HUMAN_DECISION/DEFER/
// EXPLORE_AS_WORK gaps are preserved as unresolved blockers, not routed.
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
      instruction:
        'Draft Definition v1 for this Objective: a goal, constraints, requirements, ' +
        'non-goals, design notes, risks, an acceptance model, and a fact ledger ' +
        '(see docs/developmentPlan/d3a-definition-readiness-methodology.md §1). ' +
        'Every fact carries a status (KNOWN, ASSUMED, UNKNOWN, DECIDED, or DEFERRED) ' +
        'and a source (human, repository, artifact, investigation, or decision) — ' +
        'status lives only in the fact ledger, never duplicated elsewhere. If a ' +
        'repository-inspection tool is available, use it to verify factual claims ' +
        'about this repository directly: mark a fact KNOWN with source: repository ' +
        'only after actually inspecting the relevant file(s), never because it seems ' +
        'probably true.',
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
      instruction:
        'Revise the Definition using the prior readiness review\'s findings (the ' +
        'readiness artifact). This phase resolves CAN_RESOLVE gaps only: facts ' +
        'answerable directly by reasoning or by inspecting this repository with the ' +
        'available tools — mark those KNOWN (source: repository or human, as ' +
        'appropriate) and update the relevant Definition section. Do not resolve or ' +
        'guess at a gap that requires a human decision, a deliberate deferral, or ' +
        'investigative work beyond reading this repository — leave those explicitly ' +
        'as unresolved blockers in the fact ledger (ASSUMED/UNKNOWN, not force-resolved) ' +
        'rather than fabricating an answer. Never promote a repository assertion to ' +
        'KNOWN merely because it seems likely — only an actual inspection does that.',
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
      instruction:
        'Evaluate the current Definition against the seven-dimension readiness rubric ' +
        '(outcome, boundary, critical constraints, consistency, risky assumptions, ' +
        'acceptance, remaining unknowns — ' +
        'docs/developmentPlan/d3a-definition-readiness-methodology.md §2) for the ' +
        'candidate bounded scope it defines. Name exactly which dimensions pass or ' +
        'fail and why, and name every remaining blocker (by gap classification, where ' +
        'applicable). Declare your verdict in the SLE-OUTPUT preamble as ' +
        '`verdict: pass` only if all seven dimensions pass, otherwise `verdict: fail` ' +
        '— never omit the verdict line.',
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
