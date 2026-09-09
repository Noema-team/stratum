// D.3d — Layer A: deterministic CI scenario regression for the D.3a/D.3b/
// D.3c "progressive formalization" north star — that Stratum formalizes
// intent only as far as necessary to authorize the next bounded useful
// scope. Uses a scripted provider (so execution is reproducible in CI,
// with no network/credentials), against the REAL DEFINE_WORK workflow and
// REAL control-plane components (WorkflowEngine, AgentRunner, ContextManager,
// StratumAgentAdapter, Scheduler, ResumeService, ArtifactRepository) —
// nothing here mocks the mechanism itself, only the model's answers.
//
// This locks scenario state, route sequence, iteration counts, Decision
// lifecycle, and final artifacts — but scripting the expected LLM answer
// does NOT prove a real model follows the methodology. That is Layer B's
// job (scripts/eval-define-work.ts, run out-of-band via `npm run
// eval:define-work`, never part of `npm test`/`npm run verify`).
//
// No production code is assumed frozen INCORRECTLY here — this file adds
// no new runtime mechanism; it only exercises D.3b/D.3c's existing,
// already-proven mechanisms (CAN_RESOLVE refinement, repository reads,
// bounded routes, DEFER, dynamic Decisions, EXPLORE_AS_WORK, iteration
// caps) against three realistic Objective-maturity scenarios.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { MultiTurnParams, MultiTurnResult, ToolUseBlock } from '../src/agent-loop.js';
import type { LLMCompletionParams } from '../src/llm-provider.js';
import { DEFINE_WORK } from '../src/workflow/builtins/define-work.js';
import { ContextManager, DEFAULT_CONFIG } from '../src/context-manager.js';
import { TextualSleOutputTransport } from '../src/transport/textual-sle-output.js';
import { parseDefinition } from '../src/workflow/methodology/definition-artifact.js';

import {
  EARLY_OBJECTIVE, EARLY_FIXTURE_FILES,
  PARTIAL_OBJECTIVE, PARTIAL_FIXTURE_FILES,
  MATURE_OBJECTIVE, MATURE_FIXTURE_FILES,
  findSamePlatformOnlyOption,
} from './fixtures/d3d/fixtures.js';
import {
  driveDefineWorkRun, runOracle,
  type DefineWorkTrace, type ScenarioId,
} from './fixtures/d3d/harness.js';

// ============================================================================
// Scripted dual-mode provider — multi-turn (produce steps) + single-turn
// (review steps, forced single-turn by D.3b0 regardless of provider
// capability). Each queue entry may be a fixed response or a function of
// the actual call params, so a later step (e.g. apply-human-decision) can
// extract the REAL Decision id from the assembled context rather than a
// value hardcoded ahead of time — exactly as tests/d3c1b-define-work-
// routing.test.ts already does for the single-checkpoint case.
// ============================================================================

type MultiTurnEntry = MultiTurnResult | ((params: MultiTurnParams) => MultiTurnResult);
type SingleTurnEntry = string | ((params: LLMCompletionParams) => string);

class DualModeProvider {
  multiTurnCallCount = 0;
  singleTurnCallCount = 0;
  constructor(private multiTurnSequence: MultiTurnEntry[], private singleTurnSequence: SingleTurnEntry[]) {}

  async complete(params: LLMCompletionParams) {
    this.singleTurnCallCount++;
    const entry = this.singleTurnSequence[this.singleTurnCallCount - 1] ?? '';
    const content = typeof entry === 'function' ? entry(params) : entry;
    return { content, tokens_used: 10, duration_ms: 1 };
  }

  async completeMultiTurn(params: MultiTurnParams): Promise<MultiTurnResult> {
    this.multiTurnCallCount++;
    const entry = this.multiTurnSequence[this.multiTurnCallCount - 1];
    if (!entry) return { stop_reason: 'end_turn', text: '', tool_uses: [], tokens_used: 1 };
    return typeof entry === 'function' ? entry(params) : entry;
  }
}

function toolUseTurn(name: string, input: Record<string, string>, id: string): MultiTurnResult {
  const tu: ToolUseBlock = { type: 'tool_use', id, name, input };
  return { stop_reason: 'tool_use', text: '', tool_uses: [tu], tokens_used: 5 };
}

function mtOutput(content: string, outPath: string): MultiTurnResult {
  return {
    stop_reason: 'end_turn', tool_uses: [], tokens_used: 10,
    text: ['<<<SLE-OUTPUT>>>', `### ${outPath}`, content, '<<<END-SLE-OUTPUT>>>'].join('\n'),
  };
}

function mtJsonOutput(content: unknown, outPath: string): MultiTurnResult {
  return mtOutput(JSON.stringify(content), outPath);
}

// Reads the real Decision id + selected option id straight out of the
// assembled "## Human Decision" context (see ContextManager.
// formatDecisionContext) — the same extraction pattern
// tests/d3c1b-define-work-routing.test.ts uses.
function extractDecisionFromContext(userMessage: string): { decisionId: string; selectedOptionId: string } {
  const decisionIdMatch = userMessage.match(/Decision id: `([^`]+)`/);
  const optionIdMatch = userMessage.match(/option id: `([^`]+)`/);
  assert.ok(decisionIdMatch, `expected a rendered Decision id in the assembled context: ${userMessage}`);
  assert.ok(optionIdMatch, `expected a rendered selected option id: ${userMessage}`);
  return { decisionId: decisionIdMatch![1], selectedOptionId: optionIdMatch![1] };
}

function stOutput(verdict: 'pass' | 'fail', route: string | undefined, content: string, outPath: string): string {
  const lines = ['<!-- SLE-OUTPUT', 'role: explorer', 'node: define-work', `verdict: ${verdict}`];
  if (route !== undefined) lines.push(`route: ${route}`);
  lines.push('artifacts:', '  - id: readiness', `    path: ${outPath}`, '-->', '', `## ${outPath}`, '', content);
  return lines.join('\n');
}

interface ScenarioScript {
  scenarioId: ScenarioId;
  fixtureFiles: typeof EARLY_FIXTURE_FILES;
  objectiveIntent: typeof EARLY_OBJECTIVE;
  multiTurnSequence: MultiTurnEntry[];
  singleTurnSequence: SingleTurnEntry[];
  /** Called if the run halts at a checkpoint — must resolve the Decision. */
  resolveDecision?: (options: Array<{ id: string; label: string; description?: string }>) => { selectedOptionId: string; rationale: string };
  /** D.3d.2 — optional resolved completion budget (Layer A omits it → 4096). */
  maxTokens?: number;
}

// Both layers share the SAME orchestration (driveDefineWorkRun in
// tests/fixtures/d3d/harness.ts) — this file only supplies the scripted
// provider and the scenario-specific scripted content.
async function runScenario(script: ScenarioScript): Promise<{ trace: DefineWorkTrace; root: string }> {
  const root = mkdtempSync(path.join(tmpdir(), `d3d-${script.scenarioId}-`));
  const provider = new DualModeProvider(script.multiTurnSequence, script.singleTurnSequence);

  const trace = await driveDefineWorkRun({
    scenarioId: script.scenarioId,
    root,
    fixtureFiles: script.fixtureFiles,
    objectiveIntent: script.objectiveIntent,
    provider: provider as any,
    maxTokens: script.maxTokens,
    resolveDecision: (options, decision) => {
      assert.ok(script.resolveDecision, `scenario '${script.scenarioId}' raised a Decision (${decision.title}) but declared no resolveDecision policy`);
      return script.resolveDecision!(options);
    },
  });

  return { trace, root };
}

function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

// ============================================================================
// Scenario A — EARLY
// ============================================================================

const EARLY_GOAL = 'Make Evershift multiplayer-capable: two players can join and play a shared real-time session together.';

// D.3d.5 commit 2 — scripted definitions are CANONICAL artifacts (YAML front
// matter carries the fact ledger; the markdown body stays human-facing).
// JSON flow style per fact is valid YAML and keeps the helper trivial.
function canonicalDefinition(
  goal: string,
  facts: Array<{ id: string; statement: string; status: string; source: string; decisionRef?: string; selected?: string }>,
  body = '',
): string {
  const fm = [
    '---',
    'schemaVersion: 1',
    `goal: ${JSON.stringify(goal)}`,
    'facts:',
    ...facts.map((f) => '  - ' + JSON.stringify(f)),
    '---',
  ].join('\n');
  return body ? `${fm}\n\n${body}` : fm;
}

const EARLY_V1 = canonicalDefinition(EARLY_GOAL, [
  { id: 'networking-layer', statement: 'Whether the repository already has a networking/transport layer.', status: 'UNKNOWN', source: 'repository' },
  { id: 'cross-platform-scope', statement: 'Whether cross-platform play belongs in this bounded increment.', status: 'UNKNOWN', source: 'human' },
  { id: 'sync-latency-feasibility', statement: 'Whether client-side prediction with server reconciliation can meet the required latency/frame budget.', status: 'UNKNOWN', source: 'human' },
  { id: 'wider-multiplayer-features', statement: 'Matchmaking, voice chat, spectating, and more-than-two-player sessions.', status: 'ASSUMED', source: 'human' },
], `## Requirements
- Two players can join and play a shared real-time session together.`);

const EARLY_V2 = canonicalDefinition(EARLY_GOAL, [
  { id: 'networking-layer', statement: 'The repository has no networking/transport layer today (docs/architecture.md: single-player, no network transport, session, or replication code anywhere).', status: 'KNOWN', source: 'repository' },
  { id: 'cross-platform-scope', statement: 'Whether cross-platform play belongs in this bounded increment.', status: 'UNKNOWN', source: 'human' },
  { id: 'sync-latency-feasibility', statement: 'Whether client-side prediction with server reconciliation can meet the required latency/frame budget.', status: 'UNKNOWN', source: 'human' },
  { id: 'wider-multiplayer-features', statement: 'Matchmaking, voice chat, spectating, and more-than-two-player sessions.', status: 'ASSUMED', source: 'human' },
], `## Requirements
- Two players can join and play a shared real-time session together.

## Acceptance Model
- description: Two players can join and play a shared real-time session together.
  met: false`);

const EARLY_V3_DEFERRED = canonicalDefinition(EARLY_GOAL, [
  { id: 'networking-layer', statement: 'The repository has no networking/transport layer today.', status: 'KNOWN', source: 'repository' },
  { id: 'cross-platform-scope', statement: 'Whether cross-platform play belongs in this bounded increment.', status: 'UNKNOWN', source: 'human' },
  { id: 'sync-latency-feasibility', statement: 'Whether client-side prediction with server reconciliation can meet the required latency/frame budget.', status: 'UNKNOWN', source: 'human' },
  { id: 'wider-multiplayer-features', statement: 'Matchmaking, voice chat, spectating, and more-than-two-player sessions — real, but does not block this bounded 2-player increment.', status: 'DEFERRED', source: 'human' },
], `## Non-Goals
- Matchmaking, voice chat, spectating, and more-than-two-player sessions are out of scope for this bounded increment (see wider-multiplayer-features).

## Acceptance Model
- description: Two players can join and play a shared real-time session together.
  met: false`);

const AUTHORITY_DECISION_REQUEST = {
  type: 'human_decision',
  title: 'Cross-platform scope for this increment',
  summary: 'Whether cross-platform play belongs in this bounded multiplayer increment is a genuine product/architecture tradeoff.',
  options: [
    { id: 'same-platform-only', label: 'Same-platform only', description: 'Ship this increment for a single platform only; cross-platform play is out of scope for now.' },
    { id: 'cross-platform-day-one', label: 'Cross-platform from day one', description: 'Support cross-platform play as part of this increment.' },
    { id: 'cross-platform-later', label: 'Cross-platform in a later increment', description: 'Design for same-platform now, revisit cross-platform play separately later.' },
  ],
};

function earlyApplyHumanDecision(params: MultiTurnParams): MultiTurnResult {
  const userMessage = String(params.messages[0]?.content ?? '');
  const { decisionId, selectedOptionId } = extractDecisionFromContext(userMessage);
  return mtOutput(canonicalDefinition(EARLY_GOAL, [
    { id: 'networking-layer', statement: 'The repository has no networking/transport layer today.', status: 'KNOWN', source: 'repository' },
    { id: 'cross-platform-scope', statement: 'Same-platform only for this bounded increment.', status: 'DECIDED', source: 'decision', decisionRef: decisionId, selected: selectedOptionId },
    { id: 'sync-latency-feasibility', statement: 'Whether client-side prediction with server reconciliation can meet the required latency/frame budget.', status: 'UNKNOWN', source: 'human' },
    { id: 'wider-multiplayer-features', statement: 'Matchmaking, voice chat, spectating, and more-than-two-player sessions — real, but does not block this bounded 2-player increment.', status: 'DEFERRED', source: 'human' },
  ], `## Non-Goals
- Matchmaking, voice chat, spectating, and more-than-two-player sessions are out of scope for this bounded increment.

## Acceptance Model
- description: Two players can join and play a shared real-time session together.
  met: false`), `.sle/work/wi-d3d-early/definition.md`);
}

const EARLY_EXPLORATION_NEED = `Exact question: can client-side prediction with server reconciliation meet the required
latency/frame budget for real-time two-player play?

Why not CAN_RESOLVE: no existing measurement or prior art exists in this repository — there is
no networking layer at all yet, so there is nothing to read that would answer this.

Why not HUMAN_DECISION: no human preference can substitute for an empirical latency measurement.

Proposed method: prototype the synchronization approach against a representative network
condition and benchmark round-trip/perceived latency.

Expected evidence: a measured latency/jitter figure under representative network conditions.

Exit criterion: a measured figure the Definition can cite to either confirm the candidate
approach or force reconsideration of it.`;

function earlyScript(): ScenarioScript {
  const definitionPath = '.sle/work/wi-d3d-early/definition.md';
  const readinessPath = '.sle/work/wi-d3d-early/readiness.md';
  const decisionRequestPath = '.sle/work/wi-d3d-early/decision-request.json';
  const explorationPath = '.sle/work/wi-d3d-early/exploration-need.md';

  return {
    scenarioId: 'early',
    fixtureFiles: EARLY_FIXTURE_FILES,
    objectiveIntent: EARLY_OBJECTIVE,
    multiTurnSequence: [
      mtOutput(EARLY_V1, definitionPath),                                    // synthesize-definition
      toolUseTurn('read_file', { path: 'docs/architecture.md' }, 'tu-1'),    // refine-definition: inspect
      mtOutput(EARLY_V2, definitionPath),                                    // refine-definition: final
      mtOutput(EARLY_V3_DEFERRED, definitionPath),                          // apply-deferred-gaps
      mtJsonOutput(AUTHORITY_DECISION_REQUEST, decisionRequestPath),         // prepare-human-decision
      earlyApplyHumanDecision,                                              // apply-human-decision
      mtOutput(EARLY_EXPLORATION_NEED, explorationPath),                    // record-exploration-need
    ],
    singleTurnSequence: [
      stOutput('fail', 'refine', 'CAN_RESOLVE — fact networking-layer: cheap repository check needed; acceptance criteria missing.', readinessPath),
      stOutput('fail', 'defer', 'DEFER — fact wider-multiplayer-features: real gap, does not block this bounded 2-player scope. HUMAN_DECISION and EXPLORE_AS_WORK gaps also remain open.', readinessPath),
      stOutput('fail', 'human', 'HUMAN_DECISION — fact cross-platform-scope: a genuine product/architecture tradeoff only a human can authorize.', readinessPath),
      stOutput('fail', 'explore', 'EXPLORE_AS_WORK — fact sync-latency-feasibility: answering requires a prototype/benchmark, not reading or reasoning.', readinessPath),
    ],
    resolveDecision: (options) => {
      const chosen = findSamePlatformOnlyOption(options);
      assert.ok(chosen, `no same-platform-only option offered: ${JSON.stringify(options)}`);
      return { selectedOptionId: chosen!.id, rationale: 'Same-platform only for this bounded increment.' };
    },
  };
}

test('D.3d Layer A — EARLY: substantial uncertainty handling (CAN_RESOLVE -> DEFER -> HUMAN_DECISION -> EXPLORE_AS_WORK, in precedence order)', async () => {
  const { trace, root } = await runScenario(earlyScript());
  try {
    const oracle = runOracle(trace);
    assert.ok(oracle.pass, `EARLY oracle failed:\n${oracle.checks.filter((c) => !c.pass).map((c) => `- ${c.name}: ${c.detail}`).join('\n')}`);

    // Precedence, locked directly against the recorded route sequence.
    const routes = trace.steps.filter((s) => s.reviewRoute).map((s) => s.reviewRoute);
    assert.deepStrictEqual(routes, ['refine', 'defer', 'human', 'explore']);
    assert.equal(trace.iterationsUsed, 2, 'only the refine route may increment iteration');
  } finally {
    cleanup(root);
  }
});

// ============================================================================
// Scenario B — PARTIAL
// ============================================================================

const PARTIAL_GOAL = 'Faction relations affect NPC dialogue and trade prices at settlements.';

const PARTIAL_V1 = canonicalDefinition(PARTIAL_GOAL, [
  { id: 'faction-loyalty-model', statement: 'Settlements have factions (src/npc/faction.ts); NPCs have loyalty to their faction (src/npc/npc.ts).', status: 'KNOWN', source: 'human' },
  { id: 'combat-out-of-scope', statement: 'Combat is explicitly out of scope for this increment.', status: 'KNOWN', source: 'human' },
  { id: 'dialogue-trade-wiring', statement: 'The dialogue engine and trade post do not yet take faction relation as an input.', status: 'ASSUMED', source: 'human' },
], `## Non-Goals
- Combat is out of scope for this increment.`);

const PARTIAL_V2 = canonicalDefinition(PARTIAL_GOAL, [
  { id: 'faction-loyalty-model', statement: 'Settlements have factions (src/npc/faction.ts); NPCs have loyalty to their faction (src/npc/npc.ts).', status: 'KNOWN', source: 'human' },
  { id: 'combat-out-of-scope', statement: 'Combat is explicitly out of scope for this increment (src/combat/ is self-contained, no dependency on faction/dialogue state).', status: 'KNOWN', source: 'repository' },
  { id: 'dialogue-trade-wiring', statement: 'The dialogue engine (src/dialogue/dialogue-engine.ts) selects lines by disposition only; the trade post (src/trade/trade-post.ts) applies a flat multiplier — neither yet takes faction relation as an input.', status: 'KNOWN', source: 'repository' },
], `## Non-Goals
- Combat is out of scope for this increment.

## Acceptance Model
- description: An NPC's dialogue line and trade price multiplier both reflect their faction's relation to the player.
  met: false`);

function partialScript(): ScenarioScript {
  const definitionPath = '.sle/work/wi-d3d-partial/definition.md';
  const readinessPath = '.sle/work/wi-d3d-partial/readiness.md';
  return {
    scenarioId: 'partial',
    fixtureFiles: PARTIAL_FIXTURE_FILES,
    objectiveIntent: PARTIAL_OBJECTIVE,
    multiTurnSequence: [
      mtOutput(PARTIAL_V1, definitionPath),
      toolUseTurn('read_file', { path: 'docs/architecture.md' }, 'tu-1'),
      mtOutput(PARTIAL_V2, definitionPath),
    ],
    singleTurnSequence: [
      stOutput('fail', 'refine', 'CAN_RESOLVE — missing acceptance criterion for the stated goal; combat non-goal and dialogue/trade wiring need a targeted repository check.', readinessPath),
      stOutput('pass', undefined, 'All seven dimensions pass.', readinessPath),
    ],
  };
}

test('D.3d Layer A — PARTIAL: targeted refinement only, supplied facts preserved, low iteration count', async () => {
  const { trace, root } = await runScenario(partialScript());
  try {
    const oracle = runOracle(trace);
    assert.ok(oracle.pass, `PARTIAL oracle failed:\n${oracle.checks.filter((c) => !c.pass).map((c) => `- ${c.name}: ${c.detail}`).join('\n')}`);
    assert.ok(trace.iterationsUsed <= 2, `iterationsUsed=${trace.iterationsUsed}`);
    assert.equal(trace.decisions.length, 0);
    assert.equal(trace.explorationNeedText, null);
  } finally {
    cleanup(root);
  }
});

// ============================================================================
// Scenario C — MATURE
// ============================================================================

const MATURE_V1 = canonicalDefinition(
  "Add GET /objectives/:id/history, returning the Objective's recorded status transitions.",
  [
    { id: 'existing-route-pattern', statement: 'GET /objectives/:id (src/api/routes/objectives.ts) already uses requireWorkspaceAccess (src/api/guards/workspace-guard.ts) and 404s when the Objective is absent or belongs to a different workspace.', status: 'KNOWN', source: 'repository' },
    { id: 'existing-event-source', statement: 'ObjectiveEventRepository.listByObjective (src/domain/objective-events.ts) already records every status transition ordered by occurredAt — no new entity or event type is needed.', status: 'KNOWN', source: 'repository' },
  ],
  `## Constraints
- description: Do not add a new entity or event type.
  type: must_not
- description: Follow the existing GET /objectives/:id route pattern and workspace guard.
  type: must

## Non-Goals
- No new entity or event type.

## Acceptance Model
- description: Request returns the ordered transition history for an accessible Objective; 404 when absent/inaccessible.
  met: false`,
);

function matureScript(): ScenarioScript {
  const definitionPath = '.sle/work/wi-d3d-mature/definition.md';
  const readinessPath = '.sle/work/wi-d3d-mature/readiness.md';
  return {
    scenarioId: 'mature',
    fixtureFiles: MATURE_FIXTURE_FILES,
    objectiveIntent: MATURE_OBJECTIVE,
    multiTurnSequence: [
      toolUseTurn('read_file', { path: 'src/api/routes/objectives.ts' }, 'tu-1'),
      toolUseTurn('read_file', { path: 'src/domain/objective-events.ts' }, 'tu-2'),
      mtOutput(MATURE_V1, definitionPath),
    ],
    singleTurnSequence: [
      stOutput('pass', undefined, 'All seven dimensions pass on v1 — the request is already sufficiently defined.', readinessPath),
    ],
  };
}

test('D.3d Layer A — MATURE: straight through, no ideation, iterations=1', async () => {
  const { trace, root } = await runScenario(matureScript());
  try {
    const oracle = runOracle(trace);
    assert.ok(oracle.pass, `MATURE oracle failed:\n${oracle.checks.filter((c) => !c.pass).map((c) => `- ${c.name}: ${c.detail}`).join('\n')}`);
    assert.equal(trace.iterationsUsed, 1);
    assert.equal(trace.toolUseRoundTrips >= 1, true, 'mature repository facts must still be verified via reads, not merely asserted');
  } finally {
    cleanup(root);
  }
});

// ============================================================================
// Maturity comparison — the important signal is monotonic: more complete
// intent produces less definition machinery. No numerical "maturity score"
// is computed — this is a plain side-by-side of what each scenario actually
// did.
// ============================================================================

test('D.3d Layer A — maturity comparison: more complete intent produces less definition machinery', async () => {
  const early = await runScenario(earlyScript());
  const partial = await runScenario(partialScript());
  const mature = await runScenario(matureScript());
  try {
    const rows = [
      { scenario: 'early', iterations: early.trace.iterationsUsed, decisions: early.trace.decisions.length, exploration: early.trace.explorationNeedText !== null ? 1 : 0 },
      { scenario: 'partial', iterations: partial.trace.iterationsUsed, decisions: partial.trace.decisions.length, exploration: partial.trace.explorationNeedText !== null ? 1 : 0 },
      { scenario: 'mature', iterations: mature.trace.iterationsUsed, decisions: mature.trace.decisions.length, exploration: mature.trace.explorationNeedText !== null ? 1 : 0 },
    ];

    // Monotonic signal: mature <= partial <= early on every axis of process.
    assert.ok(rows[2].iterations <= rows[1].iterations, 'mature must not require more iterations than partial');
    assert.ok(rows[1].iterations <= rows[0].iterations, 'partial must not require more iterations than early');
    assert.ok(rows[2].decisions <= rows[1].decisions && rows[1].decisions <= rows[0].decisions);
    assert.ok(rows[2].exploration <= rows[1].exploration && rows[1].exploration <= rows[0].exploration);

    // The exact anti-waterfall assertion: mature never generates a Decision,
    // a DEFER route, or an exploration need at all.
    assert.equal(rows[2].decisions, 0);
    assert.equal(rows[2].exploration, 0);
    assert.equal(rows[2].iterations, 1);
  } finally {
    cleanup(early.root);
    cleanup(partial.root);
    cleanup(mature.root);
  }
});

// ============================================================================
// D.3d.2 — the live-eval harness must evaluate the production completion
// budget. DriveOptions.maxTokens is what scripts/eval-define-work.ts passes
// from resolveLLMProvider's resolved value; this proves it reaches the model
// call path (AgentRunner → AgentLoop → provider params) unchanged.
// ============================================================================

test('D.3d.2: driveDefineWorkRun passes the resolved production maxTokens into every model call', async () => {
  const script = matureScript();
  const seen: number[] = [];
  const capture = (entry: MultiTurnEntry): MultiTurnEntry => (params: MultiTurnParams) => {
    seen.push(params.max_tokens);
    return typeof entry === 'function' ? entry(params) : entry;
  };
  const { trace, root } = await runScenario({
    ...script,
    multiTurnSequence: script.multiTurnSequence.map(capture),
    singleTurnSequence: script.singleTurnSequence.map((entry) => (params: LLMCompletionParams) => {
      seen.push(params.max_tokens);
      return typeof entry === 'function' ? entry(params) : entry;
    }),
    maxTokens: 16384,
  });
  try {
    const oracle = runOracle(trace);
    assert.ok(oracle.pass, 'scripted mature run must still pass with a configured budget');
    assert.ok(seen.length > 0, 'the capture provider must have observed model calls');
    assert.ok(
      seen.every((mt) => mt === 16384),
      `every model call must carry the resolved production budget, saw: ${seen.join(', ')}`,
    );
  } finally {
    cleanup(root);
  }
});

// Layer A (no maxTokens option) must behave exactly as before — AgentRunner's
// own 4096 default applies, so scripted traces are unaffected by the seam.
test('D.3d.2: omitted maxTokens keeps the historical 4096 default in the harness', async () => {
  const script = matureScript();
  const seen: number[] = [];
  const capture = (entry: MultiTurnEntry): MultiTurnEntry => (params: MultiTurnParams) => {
    seen.push(params.max_tokens);
    return typeof entry === 'function' ? entry(params) : entry;
  };
  const { trace, root } = await runScenario({
    ...script,
    multiTurnSequence: script.multiTurnSequence.map(capture),
    singleTurnSequence: script.singleTurnSequence.map((entry) => (params: LLMCompletionParams) => {
      seen.push(params.max_tokens);
      return typeof entry === 'function' ? entry(params) : entry;
    }),
  });
  try {
    assert.ok(trace.finalStatus === 'complete');
    assert.ok(seen.length > 0);
    assert.ok(
      seen.every((mt) => mt === 4096),
      `omitted maxTokens must default to 4096 everywhere, saw: ${seen.join(', ')}`,
    );
  } finally {
    cleanup(root);
  }
});

// ============================================================================
// D.3d live-provider qualification regression — the exact first Layer B
// failure, locked deterministically. Running the SAME scenarios through a
// real provider (OpenRouter / claude-sonnet-4) failed every scenario at
// synthesize-definition: the model produced sensible methodology content but
// never emitted the SLE-OUTPUT transport delimiters, and could not have — no
// prompt anywhere taught them. Layer A never caught this because its
// scripted provider emitted the correct transport by construction.
//
// The D.3d fix taught the transport shapes inside the workflow instruction
// text. D.3d.5 commit 1 INVERTED that ownership: transport syntax now lives
// exclusively in the execution layer (src/transport/textual-sle-output.ts),
// which injects the teaching at run time. These tests lock the new
// invariant: workflow methodology owns artifact MEANING; the transport owns
// serialization. A step instruction must never teach a wire shape again.
// ============================================================================

test('D.3d regression (D.3d.5): workflow instructions teach NO transport syntax — the transport layer owns serialization', () => {
  for (const step of DEFINE_WORK.steps) {
    const instruction = step.instruction;
    if (!instruction) continue;
    assert.ok(
      !instruction.includes('<<<SLE-OUTPUT>>>') && !instruction.includes('<<<END-SLE-OUTPUT>>>'),
      `step '${step.id}' instruction must not teach the multi-turn delimiter format — transport syntax belongs to src/transport, not methodology`,
    );
    assert.ok(
      !instruction.includes('<!-- SLE-OUTPUT'),
      `step '${step.id}' instruction must not teach the single-turn preamble format — transport syntax belongs to src/transport, not methodology`,
    );
    assert.ok(
      !/OUTPUT FORMAT \(mandatory/.test(instruction),
      `step '${step.id}' instruction must not contain the OUTPUT FORMAT contract — it is injected by the transport at execution time`,
    );
  }
});

test('D.3d regression (D.3d.5): the textual transport teaches exactly one shape per execution path, with the verdict only for reviews', () => {
  const transport = new TextualSleOutputTransport();

  const produce = transport.formatInstruction({ role: 'explorer', requiresReviewVerdict: false, execution: 'multi-turn' });
  assert.ok(produce.includes('<<<SLE-OUTPUT>>>') && produce.includes('<<<END-SLE-OUTPUT>>>'), 'multi-turn teaching carries the delimiters');
  assert.ok(!produce.includes('<!-- SLE-OUTPUT'), 'multi-turn teaching must NOT carry the preamble shape (mixing made a real model emit the wrong one)');
  assert.ok(produce.includes('declared output artifact path'), 'multi-turn teaching ties the transport to the declared output artifact path');

  const review = transport.formatInstruction({ role: 'explorer', requiresReviewVerdict: true, execution: 'single-turn' });
  assert.ok(review.includes('<!-- SLE-OUTPUT'), 'single-turn review teaching carries the preamble shape');
  assert.ok(review.includes("'verdict: pass' or 'verdict: fail'"), 'single-turn review teaching requires the verdict declaration');
  assert.ok(!review.includes('<<<SLE-OUTPUT>>>'), 'single-turn review teaching must NOT carry the delimiter shape');

  const singleProduce = transport.formatInstruction({ role: 'explorer', requiresReviewVerdict: false, execution: 'single-turn' });
  assert.ok(singleProduce.includes('<!-- SLE-OUTPUT'), 'single-turn produce teaching carries the preamble shape (matching parseAgentOutput)');
  assert.ok(!singleProduce.includes("'verdict: pass' or 'verdict: fail'"), 'single-turn produce teaching does not demand a verdict');
});

test('D.3d regression (live-provider failure): the declared output artifact path is rendered into the task text, and only when declared', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'd3d-output-path-'));
  try {
    const cm = new ContextManager(root, DEFAULT_CONFIG);
    const baseCtx = {
      workflowRunId: 'd3d-format-run',
      workflowId: 'define-work',
      iteration: 1,
      revision: 0,
      goal: 'Prove the declared output path is visible to the model',
      projectRoot: root,
    };

    const withOutput = await cm.assemble('explorer', {
      ...baseCtx,
      stepId: 'synthesize-definition',
      instruction: DEFINE_WORK.steps[0].instruction!,
      outputArtifact: { type: 'definition', ref: 'definition:o1', path: '.sle/work/wi-x/definition.md' },
    });
    assert.ok(
      withOutput.task.includes("Declared output artifact: write exactly one artifact section at '.sle/work/wi-x/definition.md'"),
      `task must render the declared output path:\n${withOutput.task}`,
    );

    const withoutOutput = await cm.assemble('explorer', {
      ...baseCtx,
      stepId: 'some-legacy-step',
      instruction: 'Do the legacy thing.',
    });
    assert.ok(
      !withoutOutput.task.includes('Declared output artifact:'),
      'a step with no declared outputArtifact must render byte-for-byte as before',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
