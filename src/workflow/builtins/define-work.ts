import type { WorkflowDefinition } from '../types.js';
import {
  DEFINITION_CONTRACT,
  READINESS_RUBRIC,
  GAP_CLASSIFICATION,
  REFINE_DEFINITION_SCOPE,
  READINESS_ROUTE_CONTRACT,
  DEFER_APPLICATION_CONTRACT,
  HUMAN_DECISION_PREPARE_CONTRACT,
  HUMAN_DECISION_APPLY_CONTRACT,
  EXPLORATION_NEED_CONTRACT,
} from '../methodology/definition-readiness.js';

// define-work (D.3b1, closure-fixed in D.3b1.1; D.3c1b wires all four gap
// classifications onto the generic D.3c1a bounded semantic-review routing
// contract and the D.3c0 dynamic Decision/checkpoint contract): produces
// and iteratively refines a Definition Artifact against the D.3a readiness
// rubric — composed below as Stratum-owned runtime constants (see
// ../methodology/definition-readiness.ts), not read from a Stratum-repo
// doc path, since these steps run with projectRoot set to the TARGET
// repository being worked on, where that path would not exist.
//
// No context.gather step: WorkflowEngine's generic 'gather' kind is a
// no-op (mark running -> mark complete -> next step) — a gather step here
// would claim repository evidence was collected when it was not. Repository
// inspection instead happens inside synthesize-definition/refine-definition
// themselves, via AgentRunner's existing optional read-only AgentLoop
// investigation (used automatically when the active LLM provider supports
// multi-turn tool use) — never inside WorkflowEngine.
//
// The four route tokens below (refine/defer/human/explore) mean exactly
// what D.3a's four-way gap classification means (CAN_RESOLVE/DEFER/
// HUMAN_DECISION/EXPLORE_AS_WORK, in that precedence order — see
// GAP_CLASSIFICATION_PRECEDENCE) — but that meaning belongs ONLY to this
// workflow and its methodology prompts. WorkflowEngine maps a route token
// through a step's own on_fail_routes table (engine.ts) with no knowledge
// of what any token means; AgentRunner validates a token against that same
// table's keys (agent-runner.ts) with the same ignorance. Nothing here
// teaches either of them a new concept — this file only supplies the
// declarative allowlist data and the prompt text a workflow author is
// already free to supply for any step.
//
// Structure (see docs/developmentPlan/d3a-definition-readiness-methodology.md
// for the human-readable design record):
//
//   synthesize-definition (iteration 1 only, by construction)
//   -> refine-definition (skipped on iteration 1; CAN_RESOLVE closure only)
//   -> definition-readiness-review
//        on_pass            -> commit
//        on_fail/refine     -> refine-definition (+iteration, capped)
//        on_fail/defer      -> apply-deferred-gaps -> post-defer-readiness-review
//        on_fail/human      -> prepare-human-decision -> human-decision-checkpoint
//                              -> apply-human-decision -> post-human-readiness-review
//        on_fail/explore    -> record-exploration-need -> commit
//
//   post-defer-readiness-review (no 'defer' route — a residual DEFER gap
//   after apply-deferred-gaps means that step failed its one job; fails
//   closed rather than looping indefinitely through a non-iterating route):
//        on_pass -> commit; on_fail/refine|human|explore as above.
//
//   post-human-readiness-review (supports all four routes, so several real
//   human decisions can occur across one WorkflowRun):
//        on_pass -> commit; on_fail/refine|defer|human|explore as above.
//
// Every routed-to step's OWN sequential ("next step in the array") target
// is what makes this converge correctly regardless of which review step
// jumped to it — see WorkflowEngine.run's stepIndex advance: a step's
// natural continuation depends only on its position in `steps` below, never
// on which route reached it. refine-definition is always immediately
// followed by definition-readiness-review; apply-deferred-gaps is always
// immediately followed by post-defer-readiness-review; the
// prepare-human-decision/human-decision-checkpoint/apply-human-decision
// triad is always immediately followed by post-human-readiness-review;
// record-exploration-need is always immediately followed by commit — no
// matter which of the (up to three) review steps routed there.
//
// Only 'refine' is ever declared with iteration_loop:true (see D.3a's
// termination contract): DEFER/HUMAN_DECISION/EXPLORE_AS_WORK never share
// CAN_RESOLVE's capped, iterating loop — a genuine non-blocking DEFER gap
// (or an irreducible HUMAN_DECISION, or a bounded EXPLORE_AS_WORK need)
// must remain resolvable by its own dedicated, non-iterating path even at
// the final allowed refinement iteration, when a new iteration is no
// longer available.
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
        'non-goals, design notes, risks, an acceptance model, and a fact ledger — ' +
        'as ONE canonical Definition artifact (front matter + body, exactly as the ' +
        'contract below specifies).\n\n' +
        `${DEFINITION_CONTRACT}\n\n${GAP_CLASSIFICATION}\n\n` +
        'If a repository-inspection tool is available, use it to verify factual claims ' +
        'about this repository directly before marking any fact KNOWN with source: repository. ' +
        'Inspect only repository reality that materially affects this bounded scope, and batch ' +
        'independent reads into a single turn rather than one file per turn: once the facts ' +
        'you need are verified, stop reading and produce the artifact — running out of turns ' +
        'on exhaustive reading fails the step just as surely as never reading at all. When the ' +
        'Objective leaves a scope question genuinely undecided, record it as an UNKNOWN fact ' +
        'in the ledger — never settle it yourself as a non-goal or a prefer constraint.',
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
        // D.3d.5 commit 2 — deterministic validator defects arrive through
        // the same readiness artifact: mechanical, fix exactly as stated.
        'If that artifact carries a "Definition validator defects" section, the ' +
        'Definition was rejected by deterministic validation before review. Those ' +
        'defects are mechanical (duplicate/invalid ledger entries, missing decision ' +
        'references, provenance conflicts): correct them exactly as stated — they are ' +
        'not requests for editorial judgment — and re-emit the complete canonical ' +
        'Definition artifact.\n\n' +
        `${DEFINITION_CONTRACT}\n\n${GAP_CLASSIFICATION}\n\n${REFINE_DEFINITION_SCOPE}` +
        '\n\nInspect only repository reality that materially affects this bounded scope: ' +
        'once the gap\'s answer is found, stop reading and produce the revised artifact.',
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
      // D.3d.5 commit 2 — deterministic validation BEFORE semantic review:
      // a structurally/epistemically invalid Definition routes refine with
      // structured defects (the reviewer is never called on an invalid artifact).
      inputValidator: 'definition',
      includeWorkItemContext: true,
      includeObjectiveContext: true,
      instruction:
        'Evaluate the current Definition against the readiness rubric for the candidate ' +
        'bounded scope it defines.\n\n' +
        // D.3d.3 — every readiness-review step receives the SAME Definition
        // contract the drafter received. The rubric's consistency and
        // risky-assumptions dimensions (and the epistemic discipline the
        // live qualification exposed: a Definition whose fact ledger omits
        // or weakens authoritative supplied facts must fail review, not
        // pass) are only judgeable against the contract that defines what
        // KNOWN/ASSUMED/UNKNOWN mean and where status may live. The review
        // step is single-turn, so this contract cannot be recovered by
        // reading any document at runtime.
        `${DEFINITION_CONTRACT}\n\n${READINESS_RUBRIC}\n\n${GAP_CLASSIFICATION}\n\n` +
        `${READINESS_ROUTE_CONTRACT(['CAN_RESOLVE', 'DEFER', 'HUMAN_DECISION', 'EXPLORE_AS_WORK'])}\n\n` +
        'Declare your verdict as `verdict: pass` only if all ' +
        'seven dimensions pass, otherwise `verdict: fail` — never omit the verdict line.' +
        `\n\n`,
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
      on_fail_routes: {
        refine: { target_step_id: 'refine-definition', iteration_loop: true },
        defer: { target_step_id: 'apply-deferred-gaps' },
        human: { target_step_id: 'prepare-human-decision' },
        explore: { target_step_id: 'record-exploration-need' },
      },
    },
    {
      id: 'apply-deferred-gaps',
      kind: 'produce',
      label: 'Apply Deferred Gaps',
      agentRole: 'explorer',
      includeWorkItemContext: true,
      includeObjectiveContext: true,
      instruction: `Update the Definition's fact ledger.\n\n${DEFINITION_CONTRACT}\n\n${DEFER_APPLICATION_CONTRACT}` +
        `\n\n`,
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
      id: 'post-defer-readiness-review',
      kind: 'review',
      label: 'Post-Defer Readiness Review',
      agentRole: 'explorer',
      requiresReviewVerdict: true,
      // D.3d.5 commit 2 — deterministic validation BEFORE semantic review:
      // a structurally/epistemically invalid Definition routes refine with
      // structured defects (the reviewer is never called on an invalid artifact).
      inputValidator: 'definition',
      includeWorkItemContext: true,
      includeObjectiveContext: true,
      instruction:
        'Evaluate the current Definition against the readiness rubric for the candidate ' +
        'bounded scope it defines.\n\n' +
        // D.3d.3 — same contract as the drafter (see definition-readiness-review).
        `${DEFINITION_CONTRACT}\n\n${READINESS_RUBRIC}\n\n${GAP_CLASSIFICATION}\n\n` +
        `${READINESS_ROUTE_CONTRACT(['CAN_RESOLVE', 'HUMAN_DECISION', 'EXPLORE_AS_WORK'])}\n\n` +
        'A residual DEFER gap here means apply-deferred-gaps failed to perform its declared ' +
        'job — never leave a DEFER classification standing here; either its fact is now ' +
        'DEFERRED (no longer an actionable gap — DEFER was never blocking) or it was ' +
        'misclassified and belongs to CAN_RESOLVE, ' +
        'HUMAN_DECISION, or EXPLORE_AS_WORK instead.\n\n' +
        'Declare your verdict as `verdict: pass` only if all ' +
        'seven dimensions pass, otherwise `verdict: fail` — never omit the verdict line.' +
        `\n\n`,
      inputArtifactRefs: ['.sle/work/{workItemId}/definition.md'],
      outputArtifact: {
        type: 'definition-readiness',
        ref: 'definition-readiness:{objectiveId}',
        path: '.sle/work/{workItemId}/readiness.md',
      },
      on_pass: { target_step_id: 'commit' },
      on_fail_routes: {
        refine: { target_step_id: 'refine-definition', iteration_loop: true },
        human: { target_step_id: 'prepare-human-decision' },
        explore: { target_step_id: 'record-exploration-need' },
      },
    },
    {
      id: 'prepare-human-decision',
      kind: 'produce',
      label: 'Prepare Human Decision',
      agentRole: 'explorer',
      includeWorkItemContext: true,
      includeObjectiveContext: true,
      instruction: HUMAN_DECISION_PREPARE_CONTRACT,
      inputArtifactRefs: [
        '.sle/work/{workItemId}/definition.md',
        '.sle/work/{workItemId}/readiness.md',
      ],
      outputArtifact: {
        type: 'decision-request',
        ref: 'definition-decision-request:{objectiveId}',
        path: '.sle/work/{workItemId}/decision-request.json',
      },
    },
    {
      id: 'human-decision-checkpoint',
      kind: 'checkpoint',
      label: 'Human Decision Checkpoint',
      decisionRequestArtifact: '.sle/work/{workItemId}/decision-request.json',
    },
    {
      id: 'apply-human-decision',
      kind: 'produce',
      label: 'Apply Human Decision',
      agentRole: 'explorer',
      includeWorkItemContext: true,
      includeObjectiveContext: true,
      includeDecisionContext: true,
      instruction: `Update the Definition's fact ledger.\n\n${DEFINITION_CONTRACT}\n\n${HUMAN_DECISION_APPLY_CONTRACT}` +
        `\n\n`,
      inputArtifactRefs: [
        '.sle/work/{workItemId}/definition.md',
        '.sle/work/{workItemId}/readiness.md',
        '.sle/work/{workItemId}/decision-request.json',
      ],
      outputArtifact: {
        type: 'definition',
        ref: 'definition:{objectiveId}',
        path: '.sle/work/{workItemId}/definition.md',
      },
    },
    {
      id: 'post-human-readiness-review',
      kind: 'review',
      label: 'Post-Human-Decision Readiness Review',
      agentRole: 'explorer',
      requiresReviewVerdict: true,
      // D.3d.5 commit 2 — deterministic validation BEFORE semantic review:
      // a structurally/epistemically invalid Definition routes refine with
      // structured defects (the reviewer is never called on an invalid artifact).
      inputValidator: 'definition',
      includeWorkItemContext: true,
      includeObjectiveContext: true,
      instruction:
        'Evaluate the current Definition against the readiness rubric for the candidate ' +
        'bounded scope it defines.\n\n' +
        // D.3d.3 — same contract as the drafter (see definition-readiness-review).
        `${DEFINITION_CONTRACT}\n\n${READINESS_RUBRIC}\n\n${GAP_CLASSIFICATION}\n\n` +
        `${READINESS_ROUTE_CONTRACT(['CAN_RESOLVE', 'DEFER', 'HUMAN_DECISION', 'EXPLORE_AS_WORK'])}\n\n` +
        'A further HUMAN_DECISION gap routes `human` again — one checkpoint per question, ' +
        'chained within this same WorkflowRun for as many real human decisions as remain.\n\n' +
        'Declare your verdict as `verdict: pass` only if all ' +
        'seven dimensions pass, otherwise `verdict: fail` — never omit the verdict line.' +
        `\n\n`,
      inputArtifactRefs: ['.sle/work/{workItemId}/definition.md'],
      outputArtifact: {
        type: 'definition-readiness',
        ref: 'definition-readiness:{objectiveId}',
        path: '.sle/work/{workItemId}/readiness.md',
      },
      on_pass: { target_step_id: 'commit' },
      on_fail_routes: {
        refine: { target_step_id: 'refine-definition', iteration_loop: true },
        defer: { target_step_id: 'apply-deferred-gaps' },
        human: { target_step_id: 'prepare-human-decision' },
        explore: { target_step_id: 'record-exploration-need' },
      },
    },
    {
      id: 'record-exploration-need',
      kind: 'produce',
      label: 'Record Exploration Need',
      agentRole: 'explorer',
      includeWorkItemContext: true,
      includeObjectiveContext: true,
      instruction: EXPLORATION_NEED_CONTRACT,
      inputArtifactRefs: [
        '.sle/work/{workItemId}/definition.md',
        '.sle/work/{workItemId}/readiness.md',
      ],
      outputArtifact: {
        type: 'exploration-need',
        ref: 'exploration-need:{objectiveId}',
        path: '.sle/work/{workItemId}/exploration-need.md',
      },
    },
    {
      id: 'commit',
      kind: 'commit',
      label: 'Definition Commit',
    },
  ],
};
