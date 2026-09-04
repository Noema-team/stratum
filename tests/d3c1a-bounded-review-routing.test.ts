// D.3c1a — generic bounded semantic-review routing. Extends the D.3b0
// requiresReviewVerdict contract so a semantic `verdict: fail` can choose
// among several WORKFLOW-DECLARED resolution paths (WorkflowStep.
// on_fail_routes — an ALLOWLIST of tokens, never a raw step id) instead of
// the single legacy `on_fail` target. See src/workflow/types.ts,
// src/agent-runner.ts (the route-gate, mirroring the existing verdict-gate),
// src/execution/agent-step-runner.ts, and src/workflow/engine.ts
// (executeReview's route-mapping + defensive re-validation).
//
// WorkflowEngine carries no knowledge of what any route token *means* — no
// HUMAN_DECISION/CAN_RESOLVE/define-work awareness anywhere in this file or
// in the engine. Every workflow/step id here is synthetic and unfamiliar.
//
// Part A: AgentRunner's route-gate — token validated against ctx.
//         on_fail_routes, exposed as reviewRoute; missing/unknown route
//         fails closed before any output is written; pass never requires
//         a route.
// Part B: WorkflowEngine's routing — a declared route reaches its own
//         target; iteration_loop is route-specific; the existing iteration
//         cap still applies only to iterating routes; legacy on_fail (no
//         on_fail_routes declared) and non-opted-in reviews are unchanged;
//         WorkflowEngine defensively re-validates the route mapping itself,
//         independent of AgentRunner's own gate; full-build never declares
//         on_fail_routes.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'crypto';

import { AgentRunner } from '../src/agent-runner.js';
import { AgentStepRunner } from '../src/execution/agent-step-runner.js';
import { ContextManager, DEFAULT_CONFIG } from '../src/context-manager.js';
import { WorkflowEngine } from '../src/workflow/engine.js';
import { registerWorkflow, getWorkflow } from '../src/workflow/registry.js';
import type { WorkflowEngineDeps, WorkflowEngineOptions } from '../src/workflow/engine.js';
import type { StepRunner, StepRunContext, StepRunOutcome, WorkflowStep } from '../src/workflow/types.js';
import type { ILLMProvider, LLMCompletionParams, LLMCompletionResult } from '../src/llm-provider.js';

// ============================================================================
// Shared fixtures
// ============================================================================

function mockFs(): typeof import('fs').promises {
  return {
    mkdir: async () => {},
    writeFile: async () => {},
    appendFile: async () => {},
    readFile: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
  } as unknown as typeof import('fs').promises;
}

function makeRunArtifactsStub() {
  return {
    async writeNodeOutput() {},
    async updateNodeStatus() {},
    async createRunDir() {},
    async createManifest() {},
  } as any;
}

function produceOutput(content: string, path: string): string {
  return [
    '<!-- SLE-OUTPUT', 'role: explorer', 'node: produce',
    'artifacts:', '  - id: doc', `    path: ${path}`, '-->', '',
    `## ${path}`, '', content,
  ].join('\n');
}

function reviewOutput(verdict: 'pass' | 'fail', route: string | undefined, note: string, path: string): string {
  const lines = ['<!-- SLE-OUTPUT', 'role: explorer', 'node: review', `verdict: ${verdict}`];
  if (route !== undefined) lines.push(`route: ${route}`);
  lines.push('artifacts:', '  - id: review', `    path: ${path}`, '-->', '', `## ${path}`, '', note);
  return lines.join('\n');
}

// ============================================================================
// Part A — AgentRunner's route-gate
// ============================================================================

function makeCtx(overrides: Partial<StepRunContext> = {}): StepRunContext {
  return {
    workflowRunId: 'r1', workflowId: 'd3c1a-synthetic-not-in-registry', stepId: 'review',
    iteration: 1, revision: 0, goal: 'D.3c1a route-gate test', projectRoot: '/proj',
    requiresReviewVerdict: true,
    ...overrides,
  };
}

function makeAgentRunner(content: string): { runner: AgentRunner; calls: LLMCompletionParams[] } {
  const calls: LLMCompletionParams[] = [];
  const provider: ILLMProvider = {
    async complete(params: LLMCompletionParams): Promise<LLMCompletionResult> {
      calls.push(params);
      return { content, tokens_used: 1, duration_ms: 1 };
    },
  };
  const cm = {
    async assemble() {
      return { system_prompt: 's', artifact_slices: {}, state_summary: '', task: 't', token_count: 1, truncated: [] };
    },
  };
  const runner = new AgentRunner(cm as any, provider, '/proj', makeRunArtifactsStub(), { model: 'test' }, mockFs());
  return { runner, calls };
}

const ROUTES = {
  refine: { target_step_id: 'produce', iteration_loop: true },
  human: { target_step_id: 'prepare-human' },
  explore: { target_step_id: 'prepare-explore' },
};

test('D.3c1a: a valid route token is validated against ctx.on_fail_routes and exposed as reviewRoute', async () => {
  const { runner } = makeAgentRunner(reviewOutput('fail', 'refine', 'needs another pass', '.sle/work/review.md'));
  const result = await runner.run('explorer', makeCtx({ on_fail_routes: ROUTES }));

  assert.ok(result.success, result.error);
  assert.equal(result.reviewVerdict, 'fail');
  assert.equal(result.reviewRoute, 'refine');
});

test('D.3c1a: a missing route on a routed-fail review fails closed before any output is written', async () => {
  const { runner } = makeAgentRunner(reviewOutput('fail', undefined, 'x', '.sle/work/review.md'));
  const result = await runner.run('explorer', makeCtx({ on_fail_routes: ROUTES }));

  assert.equal(result.success, false);
  assert.deepStrictEqual(result.artifacts_written, []);
  assert.match(result.error ?? '', /route/);
});

test('D.3c1a: an unknown route token fails closed', async () => {
  const { runner } = makeAgentRunner(reviewOutput('fail', 'bogus-route', 'x', '.sle/work/review.md'));
  const result = await runner.run('explorer', makeCtx({ on_fail_routes: ROUTES }));

  assert.equal(result.success, false);
  assert.deepStrictEqual(result.artifacts_written, []);
  assert.match(result.error ?? '', /route/);
});

test('D.3c1a: the model cannot route directly to an undeclared step id — a raw step id is not a valid route token', async () => {
  // 'produce' is a REAL step id in the routing workflows below, but it was
  // never declared as a route TOKEN on this ctx — proving the token space
  // is a controlled allowlist, never a step-id passthrough.
  const { runner } = makeAgentRunner(reviewOutput('fail', 'produce', 'x', '.sle/work/review.md'));
  const result = await runner.run('explorer', makeCtx({ on_fail_routes: ROUTES }));

  assert.equal(result.success, false);
  assert.match(result.error ?? '', /route/);
});

test('D.3c1a: verdict pass never requires (or validates) a route, even when on_fail_routes is declared', async () => {
  const { runner } = makeAgentRunner(reviewOutput('pass', undefined, 'all good', '.sle/work/review.md'));
  const result = await runner.run('explorer', makeCtx({ on_fail_routes: ROUTES }));

  assert.ok(result.success, result.error);
  assert.equal(result.reviewVerdict, 'pass');
  assert.equal(result.reviewRoute, undefined);
});

test('D.3c1a: without on_fail_routes declared, a route in the preamble is simply irrelevant — verdict:fail still succeeds with reviewRoute absent', async () => {
  const { runner } = makeAgentRunner(reviewOutput('fail', 'refine', 'x', '.sle/work/review.md'));
  const result = await runner.run('explorer', makeCtx({ on_fail_routes: undefined }));

  assert.ok(result.success, result.error);
  assert.equal(result.reviewVerdict, 'fail');
  assert.equal(result.reviewRoute, undefined);
});

// ============================================================================
// Part B — WorkflowEngine's routing
// ============================================================================

const D3C1A_ROUTING_WF = `d3c1a-routing-${randomUUID()}`;
registerWorkflow({
  id: D3C1A_ROUTING_WF,
  label: 'D.3c1a bounded routing harness',
  max_iterations: 4,
  steps: [
    { id: 'produce', kind: 'produce', agentRole: 'explorer', outputArtifact: { type: 'doc', ref: 'doc:1', path: '.sle/work/doc.md' } },
    {
      id: 'review', kind: 'review', agentRole: 'explorer', requiresReviewVerdict: true,
      on_fail_routes: ROUTES,
      on_pass: { target_step_id: 'commit' },
      outputArtifact: { type: 'review', ref: 'review:1', path: '.sle/work/review.md' },
    },
    { id: 'prepare-human', kind: 'produce', agentRole: 'explorer', outputArtifact: { type: 'human-doc', ref: 'human:1', path: '.sle/work/human.md' } },
    { id: 'prepare-explore', kind: 'produce', agentRole: 'explorer', outputArtifact: { type: 'explore-doc', ref: 'explore:1', path: '.sle/work/explore.md' } },
    { id: 'commit', kind: 'commit' },
  ],
});

const D3C1A_CAP_WF = `d3c1a-cap-${randomUUID()}`;
registerWorkflow({
  id: D3C1A_CAP_WF,
  label: 'D.3c1a cap-boundary harness',
  max_iterations: 1,
  steps: [
    { id: 'produce', kind: 'produce', agentRole: 'explorer', outputArtifact: { type: 'doc', ref: 'doc:1', path: '.sle/work/doc.md' } },
    {
      id: 'review', kind: 'review', agentRole: 'explorer', requiresReviewVerdict: true,
      on_fail_routes: {
        refine: { target_step_id: 'produce', iteration_loop: true },
        human: { target_step_id: 'prepare-human' },
      },
      on_pass: { target_step_id: 'commit' },
      outputArtifact: { type: 'review', ref: 'review:1', path: '.sle/work/review.md' },
    },
    { id: 'prepare-human', kind: 'produce', agentRole: 'explorer', outputArtifact: { type: 'human-doc', ref: 'human:1', path: '.sle/work/human.md' } },
    { id: 'commit', kind: 'commit' },
  ],
});

const D3C1A_LEGACY_WF = `d3c1a-legacy-${randomUUID()}`;
registerWorkflow({
  id: D3C1A_LEGACY_WF,
  label: 'D.3c1a legacy on_fail (no on_fail_routes) harness',
  steps: [
    { id: 'produce', kind: 'produce', agentRole: 'explorer', outputArtifact: { type: 'doc', ref: 'doc:1', path: '.sle/work/doc.md' } },
    {
      id: 'review', kind: 'review', agentRole: 'explorer', requiresReviewVerdict: true,
      on_fail: { target_step_id: 'produce', iteration_loop: true },
      on_pass: { target_step_id: 'commit' },
      outputArtifact: { type: 'review', ref: 'review:1', path: '.sle/work/review.md' },
    },
    { id: 'commit', kind: 'commit' },
  ],
});

class SequenceLLMProvider implements ILLMProvider {
  calls: LLMCompletionParams[] = [];
  constructor(private responses: string[]) {}
  async complete(params: LLMCompletionParams): Promise<LLMCompletionResult> {
    this.calls.push(params);
    const content = this.responses[this.calls.length - 1] ?? '';
    return { content, tokens_used: 10, duration_ms: 1 };
  }
}

function makeEngine(provider: ILLMProvider, root: string): WorkflowEngine {
  const cm = new ContextManager(root, DEFAULT_CONFIG, mockFs());
  const agentRunner = new AgentRunner(cm, provider, root, makeRunArtifactsStub(), { model: 'test' }, mockFs());
  const engineDeps: WorkflowEngineDeps = {
    stepRunner: new AgentStepRunner(agentRunner),
    mapManager: { read: async () => ({ artifacts: [] }), update: async () => {} } as any,
    runArtifacts: makeRunArtifactsStub(),
    projectRoot: root,
  };
  const engineOpts: WorkflowEngineOptions = { onCheckpoint: async () => 'halt' };
  return new WorkflowEngine(engineDeps, engineOpts);
}

test('D.3c1a: a declared route (refine) reaches its own target and, with iteration_loop:true, increments iteration', async () => {
  const provider = new SequenceLLMProvider([
    produceOutput('v1', '.sle/work/doc.md'),
    reviewOutput('fail', 'refine', 'needs refinement', '.sle/work/review.md'),
    // No 3rd response — the engine must have routed back to 'produce' (not
    // 'prepare-human'/'prepare-explore') for iteration 2; the 3rd call gets
    // an empty response and fails there, proving both the target AND the
    // iteration increment in one observation.
  ]);
  const engine = makeEngine(provider, '/proj-refine');

  const result = await engine.run(D3C1A_ROUTING_WF, `run-${randomUUID()}`, 'goal', undefined, 'wi-1');

  assert.equal(result.status, 'halted');
  assert.equal(result.final_step_id, 'produce', 'the refine route must target produce again');
  assert.equal(result.iterations_used, 2, 'iteration_loop:true must have incremented the iteration counter');
});

test('D.3c1a: a declared route (human) reaches a DIFFERENT target than refine, and does not increment iteration', async () => {
  const provider = new SequenceLLMProvider([
    produceOutput('v1', '.sle/work/doc.md'),
    reviewOutput('fail', 'human', 'needs a human decision', '.sle/work/review.md'),
  ]);
  const engine = makeEngine(provider, '/proj-human');

  const result = await engine.run(D3C1A_ROUTING_WF, `run-${randomUUID()}`, 'goal', undefined, 'wi-1');

  assert.equal(result.status, 'halted');
  assert.equal(result.final_step_id, 'prepare-human', 'the human route must target prepare-human, not produce or prepare-explore');
  assert.equal(result.iterations_used, 1, 'a route without iteration_loop must not increment iteration');
});

test('D.3c1a: a declared route (explore) reaches its own distinct target and does not increment iteration', async () => {
  const provider = new SequenceLLMProvider([
    produceOutput('v1', '.sle/work/doc.md'),
    reviewOutput('fail', 'explore', 'needs exploratory work', '.sle/work/review.md'),
  ]);
  const engine = makeEngine(provider, '/proj-explore');

  const result = await engine.run(D3C1A_ROUTING_WF, `run-${randomUUID()}`, 'goal', undefined, 'wi-1');

  assert.equal(result.status, 'halted');
  assert.equal(result.final_step_id, 'prepare-explore');
  assert.equal(result.iterations_used, 1);
});

test('D.3c1a: semantic pass still follows on_pass — full happy path completes via commit', async () => {
  const provider = new SequenceLLMProvider([
    produceOutput('v1', '.sle/work/doc.md'),
    reviewOutput('fail', 'refine', 'not ready yet', '.sle/work/review.md'),
    produceOutput('v2', '.sle/work/doc.md'),
    reviewOutput('pass', undefined, 'all seven dimensions pass', '.sle/work/review.md'),
  ]);
  const engine = makeEngine(provider, '/proj-pass');

  const result = await engine.run(D3C1A_ROUTING_WF, `run-${randomUUID()}`, 'goal', undefined, 'wi-1');

  assert.equal(result.status, 'complete', result.error);
  assert.equal(result.final_step_id, 'commit');
  assert.equal(result.iterations_used, 2);
});

test('D.3c1a: at the final allowed iteration, an iterative route (refine) hits the existing cap and fails closed', async () => {
  const provider = new SequenceLLMProvider([
    produceOutput('v1', '.sle/work/doc.md'),
    reviewOutput('fail', 'refine', 'still not ready', '.sle/work/review.md'),
  ]);
  const engine = makeEngine(provider, '/proj-cap-refine');

  const result = await engine.run(D3C1A_CAP_WF, `run-${randomUUID()}`, 'goal', undefined, 'wi-1');

  assert.equal(result.status, 'halted');
  assert.match(result.error ?? '', /Iteration cap \(1\) reached/);
  assert.equal(result.iterations_used, 1, 'must never advance past the cap');
});

test('D.3c1a: at the SAME final iteration, a non-iterative declared route (human) can still proceed past the cap', async () => {
  const provider = new SequenceLLMProvider([
    produceOutput('v1', '.sle/work/doc.md'),
    reviewOutput('fail', 'human', 'still needs a human decision', '.sle/work/review.md'),
  ]);
  const engine = makeEngine(provider, '/proj-cap-human');

  const result = await engine.run(D3C1A_CAP_WF, `run-${randomUUID()}`, 'goal', undefined, 'wi-1');

  assert.equal(result.status, 'halted');
  assert.equal(result.final_step_id, 'prepare-human', `a non-iterative route must reach its target, not hit the cap: ${result.error}`);
  assert.ok(!/Iteration cap/.test(result.error ?? ''), 'the cap must never block a route with no iteration_loop');
  assert.equal(result.iterations_used, 1);
});

test('D.3c1a: without on_fail_routes declared, existing requiresReviewVerdict + on_fail behavior is byte-for-byte unchanged', async () => {
  const provider = new SequenceLLMProvider([
    produceOutput('v1', '.sle/work/doc.md'),
    reviewOutput('fail', undefined, 'legacy fail, no route at all', '.sle/work/review.md'),
    produceOutput('v2', '.sle/work/doc.md'),
    reviewOutput('pass', undefined, 'now it passes', '.sle/work/review.md'),
  ]);
  const engine = makeEngine(provider, '/proj-legacy');

  const result = await engine.run(D3C1A_LEGACY_WF, `run-${randomUUID()}`, 'goal', undefined, 'wi-1');

  assert.equal(result.status, 'complete', result.error);
  assert.equal(result.final_step_id, 'commit');
  assert.equal(result.iterations_used, 2, 'the legacy on_fail.iteration_loop must still increment exactly as before');
});

test('D.3c1a: legacy non-opt-in reviews (no requiresReviewVerdict at all) are unaffected — execution failure still routes on_fail', async () => {
  const D3C1A_NONVERDICT_WF = `d3c1a-nonverdict-${randomUUID()}`;
  registerWorkflow({
    id: D3C1A_NONVERDICT_WF,
    label: 'D.3c1a legacy non-verdict review harness',
    steps: [
      { id: 'review', kind: 'review', agentRole: 'explorer', on_fail: { target_step_id: 'produce' } },
      { id: 'produce', kind: 'produce', agentRole: 'explorer', outputArtifact: { type: 'doc', ref: 'doc:1', path: '.sle/work/doc.md' } },
    ],
  });
  // Empty response -> execution failure (no requiresReviewVerdict, so this
  // is legacy "execution success routes on_pass, failure routes on_fail").
  const provider = new SequenceLLMProvider([]);
  const engine = makeEngine(provider, '/proj-nonverdict');

  const result = await engine.run(D3C1A_NONVERDICT_WF, `run-${randomUUID()}`, 'goal', undefined, 'wi-1');

  // Legacy path routes to on_fail's target and then fails there too (also
  // an execution failure) — the important assertion is that it routed via
  // on_fail rather than halting immediately at 'review', proving the
  // legacy non-verdict path is untouched by D.3c1a.
  assert.equal(result.final_step_id, 'produce');
});

test('D.3c1a: full-build never declares on_fail_routes — its review-routing behavior is structurally unchanged', () => {
  const fullBuild = getWorkflow('full-build');
  assert.ok(fullBuild, 'full-build must still be registered');
  const reviewSteps = fullBuild!.steps.filter((s) => s.kind === 'review');
  assert.ok(reviewSteps.length > 0, 'sanity: full-build has at least one review step');
  for (const step of reviewSteps) {
    assert.equal(
      step.on_fail_routes, undefined,
      `full-build step '${step.id}' must not opt into bounded routing — its on_fail behavior must stay exactly the single legacy target`,
    );
  }
});

// -- WorkflowEngine's own defensive re-validation (independent of AgentRunner) --

class StubRouteStepRunner implements StepRunner {
  constructor(private readonly routeToReturn: string | undefined) {}
  async run(step: WorkflowStep): Promise<StepRunOutcome> {
    if (step.id === 'produce') {
      return { success: true, artifacts_written: ['.sle/work/doc.md'], tokens_used: 1, duration_ms: 1 };
    }
    if (step.id === 'review') {
      // Bypasses AgentRunner's own route-gate entirely — this StepRunner
      // hands WorkflowEngine an unvalidated token directly, proving the
      // engine's OWN defensive check catches it independently.
      return {
        success: true, artifacts_written: [], tokens_used: 1, duration_ms: 1,
        reviewVerdict: 'fail', reviewRoute: this.routeToReturn,
      };
    }
    // Any other step (e.g. 'prepare-human'/'prepare-explore') this stub is
    // asked to run means the engine successfully routed there — report it
    // as a distinguishable failure instead of throwing, so callers can
    // observe result.final_step_id/result.error cleanly.
    return { success: false, artifacts_written: [], tokens_used: 1, duration_ms: 1, error: `reached '${step.id}'` };
  }
}

function makeStubEngine(stepRunner: StepRunner): WorkflowEngine {
  const engineDeps: WorkflowEngineDeps = {
    stepRunner,
    mapManager: { read: async () => ({ artifacts: [] }), update: async () => {} } as any,
    runArtifacts: makeRunArtifactsStub(),
    projectRoot: '/proj-stub',
  };
  return new WorkflowEngine(engineDeps, { onCheckpoint: async () => 'halt' });
}

test('D.3c1a: WorkflowEngine defensively re-validates the route mapping itself, even when the StepRunner supplies an unrecognized token', async () => {
  const engine = makeStubEngine(new StubRouteStepRunner('an-undeclared-token'));

  const result = await engine.run(D3C1A_ROUTING_WF, `run-${randomUUID()}`, 'goal', undefined, 'wi-1');

  assert.equal(result.status, 'halted');
  assert.match(result.error ?? '', /no valid route/);
});

test('D.3c1a: WorkflowEngine defensively re-validates a missing route the same way, independent of AgentRunner', async () => {
  const engine = makeStubEngine(new StubRouteStepRunner(undefined));

  const result = await engine.run(D3C1A_ROUTING_WF, `run-${randomUUID()}`, 'goal', undefined, 'wi-1');

  assert.equal(result.status, 'halted');
  assert.match(result.error ?? '', /no valid route/);
});

test('D.3c1a.1: WorkflowEngine rejects an inherited Object.prototype member ("toString") as if it were an undeclared route, not an accepted mapping', async () => {
  const engine = makeStubEngine(new StubRouteStepRunner('toString'));

  const result = await engine.run(D3C1A_ROUTING_WF, `run-${randomUUID()}`, 'goal', undefined, 'wi-1');

  assert.equal(result.status, 'halted');
  assert.match(result.error ?? '', /no valid route/, '"toString" must never resolve to Object.prototype.toString as a truthy mapping');
});

test('D.3c1a.1: WorkflowEngine rejects "constructor" the same way — an own-key check, not a truthy property lookup', async () => {
  const engine = makeStubEngine(new StubRouteStepRunner('constructor'));

  const result = await engine.run(D3C1A_ROUTING_WF, `run-${randomUUID()}`, 'goal', undefined, 'wi-1');

  assert.equal(result.status, 'halted');
  assert.match(result.error ?? '', /no valid route/);
});

test('D.3c1a: WorkflowEngine correctly routes a StepRunner-supplied token that IS declared, end to end', async () => {
  const engine = makeStubEngine(new StubRouteStepRunner('human'));

  const result = await engine.run(D3C1A_ROUTING_WF, `run-${randomUUID()}`, 'goal', undefined, 'wi-1');

  assert.equal(result.status, 'halted');
  assert.equal(result.final_step_id, 'prepare-human');
  assert.match(result.error ?? '', /reached 'prepare-human'/, 'reaching prepare-human proves the declared token routed correctly');
});
