// DDR-040 — creation-time identity propagation on EVERY Decision path.
// E4-G inv 4's lifecycle gap, root-caused: DDR-036 bound
// DecisionRequest.targetFactId into the durable Decision on Scheduler's
// INITIAL dispatch only — ResumeService's next-checkpoint creation (the path
// that fires whenever a resumed run chains a SECOND decision) dropped it, so
// any chained decision was structurally unbound from birth and its
// application deterministically failed DECISION_APPLICATION_DECISION_
// UNLINKED regardless of the model's proposal (the prepare contract
// REQUIRES targetFactId; inv 4's persisted request artifact carried it).
//
// This regression walks the actual E4-G inv 4 authority chain live: a
// topology decision created at initial dispatch (bound), then a chained
// scope decision created DURING the resume — bound from birth post-fix —
// each independently human-resolved and applied to exactly its own fact,
// the remaining exploration need preserved, and a clean commit.
//
// Scope note (review closure): an earlier draft of DDR-040 also introduced
// a generic on_error_routes recovery subsystem for UNLINKED applications.
// The root-cause audit falsified its premise — post-fix, a current-run
// unlinked durable Decision is unreachable by construction (both creation
// paths bind; the contract requires the fact id) — so the subsystem was
// removed rather than kept on spec. Genuinely legacy/unlinked Decisions
// keep the deterministic fail-closed refusal; if a real run ever surfaces
// one, that evidence decides whether recovery machinery is justified.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { MultiTurnParams, MultiTurnResult, ToolUseBlock } from '../src/agent-loop.js';
import type { LLMCompletionParams } from '../src/llm-provider.js';
import { parseDefinition } from '../src/workflow/methodology/definition-artifact.js';

import {
  EARLY_OBJECTIVE, EARLY_FIXTURE_FILES, findCrossPlatformExclusionOption,
} from './fixtures/d3d/fixtures.js';
import { driveDefineWorkRun } from './fixtures/d3d/harness.js';

// ============================================================================
// Scripted dual-mode provider (multi-turn produce steps + single-turn
// reviews), following tests/d3d-behavioral-qualification.test.ts.
// ============================================================================

type MultiTurnEntry = MultiTurnResult | ((params: MultiTurnParams) => MultiTurnResult);

function submitProposalTurn(proposal: unknown, id: string): MultiTurnResult {
  return { stop_reason: 'tool_use', text: '', tokens_used: 5, tool_uses: [{ type: 'tool_use', id, name: 'submit_result', input: proposal }] };
}

function toolUseTurn(name: string, input: Record<string, string>, id: string): MultiTurnResult {
  const tu: ToolUseBlock = { type: 'tool_use', id, name, input };
  return { stop_reason: 'tool_use', text: '', tool_uses: [tu], tokens_used: 5 };
}

function definitionProposal(
  goal: string,
  facts: Array<{ id: string; statement: string; status: string; source: string }>,
  body = '',
): Record<string, unknown> {
  return { goal, facts, bodyMarkdown: body };
}

function reviewOutput(
  verdict: 'pass' | 'fail',
  gaps: Array<{ target: string; factId?: string; description: string; classification: string; reason: string }>,
  body: string,
): string {
  return JSON.stringify({ verdict, gaps: gaps.map((g) => ({ closure: 'see body', ...g })), bodyMarkdown: body });
}

const GOAL = 'Two players can join and play a shared real-time session together.';
const F2 = 'cross-platform-scope';
const F5 = 'session-topology';

const EARLY_V1 = definitionProposal(GOAL, [
  { id: 'networking-layer', statement: 'Whether the repository already has a networking/transport layer.', status: 'UNKNOWN', source: 'repository' },
  { id: F5, statement: 'Which session authority model the two-player session should use.', status: 'UNKNOWN', source: 'human' },
  { id: F2, statement: 'Whether cross-platform play belongs in this bounded increment.', status: 'UNKNOWN', source: 'human' },
  { id: 'sync-latency-feasibility', statement: 'Whether client-side prediction with server reconciliation can meet the required latency/frame budget.', status: 'UNKNOWN', source: 'human' },
  { id: 'wider-multiplayer-features', statement: 'Matchmaking, voice chat, spectating, and more-than-two-player sessions.', status: 'ASSUMED', source: 'human' },
]);

const EARLY_V2 = definitionProposal(GOAL, [
  { id: 'networking-layer', statement: 'The repository has no networking/transport layer today (docs/architecture.md: single-player, no network transport, session, or replication code anywhere).', status: 'KNOWN', source: 'repository' },
  { id: F5, statement: 'Which session authority model the two-player session should use.', status: 'UNKNOWN', source: 'human' },
  { id: F2, statement: 'Whether cross-platform play belongs in this bounded increment.', status: 'UNKNOWN', source: 'human' },
  { id: 'sync-latency-feasibility', statement: 'Whether client-side prediction with server reconciliation can meet the required latency/frame budget.', status: 'UNKNOWN', source: 'human' },
  { id: 'wider-multiplayer-features', statement: 'Matchmaking, voice chat, spectating, and more-than-two-player sessions.', status: 'ASSUMED', source: 'human' },
]);

const EARLY_V3 = definitionProposal(GOAL, [
  { id: 'networking-layer', statement: 'The repository has no networking/transport layer today.', status: 'KNOWN', source: 'repository' },
  { id: F5, statement: 'Which session authority model the two-player session should use.', status: 'UNKNOWN', source: 'human' },
  { id: F2, statement: 'Whether cross-platform play belongs in this bounded increment.', status: 'UNKNOWN', source: 'human' },
  { id: 'sync-latency-feasibility', statement: 'Whether client-side prediction with server reconciliation can meet the required latency/frame budget.', status: 'UNKNOWN', source: 'human' },
  { id: 'wider-multiplayer-features', statement: 'Matchmaking, voice chat, spectating, and more-than-two-player sessions — real, but does not block this bounded 2-player increment.', status: 'DEFERRED', source: 'human' },
]);

const TOPOLOGY_REQUEST = {
  type: 'human_decision',
  targetFactId: F5,
  title: 'Which session topology should the two-player session be built on?',
  summary: 'A genuine architecture tradeoff: where does session authority live?',
  options: [
    { id: 'dedicated-server', label: 'Dedicated authoritative server', description: 'A small always-on server runs the authoritative simulation; both clients connect remotely.' },
    { id: 'host-authority', label: 'Host-as-authority', description: "One of the two players' machines hosts the session and runs the authoritative tick." },
    { id: 'lockstep-p2p', label: 'Lockstep peer-to-peer', description: 'Both clients run the same deterministic tick and exchange inputs only.' },
  ],
};

const SCOPE_REQUEST = {
  type: 'human_decision',
  targetFactId: F2,
  title: 'Cross-platform scope for this increment',
  summary: 'Whether cross-platform play belongs in this bounded multiplayer increment is a genuine product/architecture tradeoff.',
  options: [
    { id: 'same-platform-only', label: 'Same-platform only', description: 'Ship this increment for a single platform only; cross-platform play is out of scope for now.' },
    { id: 'cross-platform-day-one', label: 'Cross-platform from day one', description: 'Support cross-platform play as part of this increment.' },
    { id: 'cross-platform-later', label: 'Cross-platform in a later increment', description: 'Design for same-platform now, revisit cross-platform play separately later.' },
  ],
};

const APPLY_TOPOLOGY_PROPOSAL = {
  factStatement: 'The session runs on a dedicated authoritative server; both clients connect remotely.',
  bodyMarkdown: 'The human resolved the session topology to a dedicated authoritative server.',
};

const APPLY_PROPOSAL = {
  factStatement: 'Same-platform only for this bounded increment.',
  nonGoals: ['Matchmaking, voice chat, spectating, and more-than-two-player sessions are out of scope for this bounded increment.'],
  acceptance: [{ description: 'Two players can join and play a shared real-time session together.', met: false }],
  bodyMarkdown: 'The human resolved the platform-scope decision to same-platform only; cross-platform play is out of scope for this increment.',
};

const EXPLORATION_PROPOSAL = {
  targetFactId: 'sync-latency-feasibility',
  question: 'Can client-side prediction with server reconciliation meet the required latency/frame budget for real-time two-player play?',
  whyNotResolvableByReading: 'No existing measurement or prior art exists in this repository — there is no networking layer at all yet.',
  requiredWork: 'Prototype the synchronization approach against a representative network condition and benchmark round-trip/perceived latency.',
  completionEvidence: 'A measured latency/jitter figure under representative network conditions.',
  bodyMarkdown: 'Exit criterion: a measured figure the Definition can cite.',
};

function makeProvider(multiTurn: MultiTurnEntry[], singleTurn: string[]) {
  let mt = 0; let st = 0;
  return {
    async complete(params: LLMCompletionParams) {
      void params;
      const content = singleTurn[st++] ?? '';
      return { content, tokens_used: 10, duration_ms: 1 };
    },
    async completeMultiTurn(): Promise<MultiTurnResult> {
      const entry = multiTurn[mt++];
      if (!entry) return { stop_reason: 'end_turn', text: '', tool_uses: [], tokens_used: 1 };
      return typeof entry === 'function' ? entry({} as MultiTurnParams) : entry;
    },
  };
}

function chainedDecisionSequence(): { multiTurn: MultiTurnEntry[]; singleTurn: string[] } {
  return {
    multiTurn: [
      submitProposalTurn(EARLY_V1, 'sub-1'),                                    // synthesize-definition
      toolUseTurn('read_file', { path: 'docs/architecture.md' }, 'tu-1'),        // refine-definition: inspect
      submitProposalTurn(EARLY_V2, 'sub-2'),                                     // refine-definition: final
      submitProposalTurn(EARLY_V3, 'sub-3'),                                     // apply-deferred-gaps
      // prepare #1 — the topology question (a COMPLIANT request; the contract
      // requires targetFactId). Decision A is created by the Scheduler's
      // initial dispatch, bound.
      submitProposalTurn(TOPOLOGY_REQUEST, 'sub-dr1'),                           // prepare-human-decision #1
      submitProposalTurn(APPLY_TOPOLOGY_PROPOSAL, 'sub-app1'),                   // apply-human-decision #1
      // prepare #2 — the scope question. The checkpoint halt for THIS decision
      // happens during a RESUME. Pre-DDR-040, ResumeService's next-checkpoint
      // creation dropped the request's targetFactId, so this Decision was
      // structurally unbound from birth and its application deterministically
      // failed DECISION_APPLICATION_DECISION_UNLINKED (E4-G inv 4's exact
      // lifecycle). Post-fix it is bound from birth; the run applies it and
      // continues.
      submitProposalTurn(SCOPE_REQUEST, 'sub-dr2'),                              // prepare-human-decision #2
      submitProposalTurn(APPLY_PROPOSAL, 'sub-app2'),                            // apply-human-decision #2
      submitProposalTurn(EXPLORATION_PROPOSAL, 'sub-en'),                        // record-exploration-need
    ],
    singleTurn: [
      reviewOutput('fail', [{ target: 'networking-layer', description: 'cheap repository check needed', classification: 'CAN_RESOLVE', reason: 'closeable by reading the repository' }], 'CAN_RESOLVE.'),
      reviewOutput('fail', [
        { target: 'wider-multiplayer-features', factId: 'wider-multiplayer-features', description: 'real gap, does not block', classification: 'DEFER', reason: 'does not block the bounded scope' },
        { target: F5, factId: F5, description: 'architecture tradeoff', classification: 'HUMAN_DECISION', reason: 'only a human can authorize this tradeoff' },
        { target: F2, factId: F2, description: 'genuine tradeoff', classification: 'HUMAN_DECISION', reason: 'only a human can authorize this tradeoff' },
        { target: 'sync-latency-feasibility', factId: 'sync-latency-feasibility', description: 'needs measurement', classification: 'EXPLORE_AS_WORK', reason: 'not answerable by reading or reasoning' },
      ], 'DEFER.'),
      reviewOutput('fail', [
        { target: F5, factId: F5, description: 'architecture tradeoff', classification: 'HUMAN_DECISION', reason: 'only a human can authorize this tradeoff' },
        { target: F2, factId: F2, description: 'genuine tradeoff', classification: 'HUMAN_DECISION', reason: 'only a human can authorize this tradeoff' },
        { target: 'sync-latency-feasibility', factId: 'sync-latency-feasibility', description: 'needs measurement', classification: 'EXPLORE_AS_WORK', reason: 'not answerable by reading or reasoning' },
      ], 'HUMAN_DECISION.'),
      reviewOutput('fail', [
        { target: F2, factId: F2, description: 'genuine tradeoff', classification: 'HUMAN_DECISION', reason: 'only a human can authorize this tradeoff' },
        { target: 'sync-latency-feasibility', factId: 'sync-latency-feasibility', description: 'needs measurement', classification: 'EXPLORE_AS_WORK', reason: 'not answerable by reading or reasoning' },
      ], 'HUMAN_DECISION.'),
      reviewOutput('fail', [
        { target: 'sync-latency-feasibility', factId: 'sync-latency-feasibility', description: 'needs measurement', classification: 'EXPLORE_AS_WORK', reason: 'not answerable by reading or reasoning' },
      ], 'EXPLORE_AS_WORK.'),
    ],
  };
}

describe('DDR-040 — creation-time identity propagation on every Decision path', () => {
  it('a chained decision created during a resume is bound from birth; the run applies it and commits cleanly', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ddr040-rootcause-'));
    const seq = chainedDecisionSequence();
    let humanRounds = 0;
    try {
      const trace = await driveDefineWorkRun({
        scenarioId: 'early',
        root,
        fixtureFiles: EARLY_FIXTURE_FILES,
        objectiveIntent: EARLY_OBJECTIVE,
        provider: makeProvider(seq.multiTurn, seq.singleTurn) as any,
        resolveDecision: (options, decision) => {
          humanRounds++;
          if (decision.title.includes('session topology')) {
            return { selectedOptionId: options[0].id, rationale: 'Dedicated authoritative server.' };
          }
          const exclusion = findCrossPlatformExclusionOption(options as Array<{ id: string; label: string; description?: string }>);
          assert.ok(exclusion, `no exclusion option offered: ${JSON.stringify(options.map((o) => o.id))}`);
          return { selectedOptionId: exclusion.id, rationale: 'Same-platform only for this bounded increment.' };
        },
      });

      // Post-human review, exploration recording, clean commit.
      assert.equal(trace.finalStatus, 'complete', `run did not complete: ${trace.steps.map((s) => `${s.stepId}:${s.success}`).join(' ')}`);
      assert.equal(trace.finalStepId, 'commit');
      assert.ok(trace.steps.some((s) => s.stepId === 'post-human-readiness-review' && s.success));
      assert.ok(trace.explorationNeedText !== null && /latency|frame budget/i.test(trace.explorationNeedText));
      assert.ok(trace.artifacts.some((a) => a.type === 'exploration-need'));

      // Both applies succeeded — pre-fix, the SECOND deterministically failed
      // DECISION_APPLICATION_DECISION_UNLINKED because its durable Decision
      // (created during the resume) was structurally unbound.
      const applySteps = trace.steps.filter((s) => s.stepId === 'apply-human-decision');
      assert.equal(applySteps.length, 2);
      assert.ok(applySteps.every((s) => s.success), applySteps.map((s) => s.error).join(' | '));
      const prepareSteps = trace.steps.filter((s) => s.stepId === 'prepare-human-decision');
      assert.equal(prepareSteps.length, 2);

      // Two decisions on two different facts, BOTH bound at creation (A via
      // the scheduler path, B via the fixed resume path), each
      // human-resolved separately — no transfer.
      assert.equal(trace.decisions.length, 2);
      const [a, b] = trace.decisions;
      assert.equal(a.targetFactId, F5, 'A (topology) bound at initial dispatch');
      assert.equal(b.targetFactId, F2, 'B (scope) bound from birth through the RESUME path (the root-cause fix)');
      assert.notEqual(a.id, b.id);
      assert.equal(humanRounds, 2, 'the human answered BOTH decisions — no transfer');
      const exclusion = findCrossPlatformExclusionOption(b.options);
      assert.ok(exclusion);
      assert.equal(b.selectedOptionId, exclusion.id);
      assert.ok(a.selectedOptionId);

      // The persisted request artifact carries the fact id.
      const requestArtifact = JSON.parse(readFileSync(join(root, '.sle/work/wi-d3d-early/decision-request.json'), 'utf8'));
      assert.equal(requestArtifact.targetFactId, F2);

      // The final applications changed exactly the two targeted facts,
      // mechanically, each with its OWN decision's authority.
      const finalDefinition = parseDefinition(
        readFileSync(join(root, '.sle/work/wi-d3d-early/definition.md'), 'utf8'),
      ).definition;
      const scope = finalDefinition.facts.find((f) => f.id === F2);
      assert.equal(scope?.status, 'DECIDED');
      assert.equal(scope?.source, 'decision');
      assert.equal((scope as { decisionRef?: string }).decisionRef, b.id, 'decisionRef is the applied Decision\'s real id');
      const topology = finalDefinition.facts.find((f) => f.id === F5);
      assert.equal(topology?.status, 'DECIDED');
      assert.equal((topology as { decisionRef?: string }).decisionRef, a.id);
      assert.deepEqual(
        finalDefinition.facts.filter((f) => f.id !== F2 && f.id !== F5).map((f) => `${f.id}:${f.status}:${f.source}`),
        ['networking-layer:KNOWN:repository', 'sync-latency-feasibility:UNKNOWN:human', 'wider-multiplayer-features:DEFERRED:human'],
        'every other fact carried over verbatim',
      );

      // The reviews raised and classified the gaps (route trace).
      const routes = trace.steps.filter((s) => s.reviewRoute).map((s) => s.reviewRoute);
      assert.deepEqual(routes, ['refine', 'defer', 'human', 'human', 'explore']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
