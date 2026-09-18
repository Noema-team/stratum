// D.3d.5 commit 3 — deterministic review-route derivation.
//
// Removes the LAST model authority over control flow: the semantic reviewer
// used to both DESCRIBE epistemic state (gap classifications) and SELECT
// control flow (the legacy textual `route:` token). Now the reviewer only
// classifies gaps in the readiness artifact's canonical front matter, and
// Stratum derives the route deterministically from
// GAP_CLASSIFICATION_PRECEDENCE, constrained to the routes the workflow
// author declared for the step.
//
// Locked here:
//   - parseReadinessArtifact: structural fail-closed parsing (the
//     parseDefinition discipline, applied to the readiness artifact);
//   - deriveReviewRoute: mechanical precedence, enum membership, declared-
//     route constraint, fail-closed on anything unclassifiable;
//   - the AgentRunner seam: derivation before any output is written;
//     single-route fallback without a deriver; multi-route authoring error
//     without a deriver; the model-declared `route:` token ignored;
//   - precedence is ENFORCED by Stratum even when a model classifies
//     multiple gaps (a DEFER + HUMAN_DECISION + EXPLORE_AS_WORK artifact
//     routes to defer — the cheap/non-blocking transition first).

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseReadinessArtifact,
  deriveReviewRoute,
  createReviewRouteDeriver,
  ReadinessParseError,
  READINESS_SCHEMA_VERSION,
  type ReadinessGap,
} from '../src/workflow/methodology/readiness-artifact.js';
import { GAP_CLASSIFICATION_PRECEDENCE } from '../src/workflow/methodology/definition-readiness.js';
import { AgentRunner } from '../src/agent-runner.js';
import { ContextManager, DEFAULT_CONFIG } from '../src/context-manager.js';
import type { RunArtifactManager } from '../src/run-artifacts.js';
import type { ILLMProvider, LLMCompletionParams, LLMCompletionResult } from '../src/llm-provider.js';

// ─── Parsing ─────────────────────────────────────────────────────────────────

function artifact(gapsYaml: string, body = '## Readiness\n\nProse.'): string {
  return `---\nschemaVersion: ${READINESS_SCHEMA_VERSION}\ngaps:\n${gapsYaml}\n---\n\n${body}`;
}

test('D.3d.5.3: a canonical readiness artifact parses into typed gaps', () => {
  const { readiness, body } = parseReadinessArtifact(artifact(
    '  - {"target":"networking-layer","description":"no measured latency","classification":"EXPLORE_AS_WORK","reason":"needs a benchmark","closure":"prototype + measure"}',
  ));
  assert.equal(readiness.schemaVersion, 1);
  assert.equal(readiness.gaps[0].target, 'networking-layer');
  assert.equal(readiness.gaps[0].classification, 'EXPLORE_AS_WORK');
  assert.equal(readiness.gaps[0].closure, 'prototype + measure');
  assert.ok(body.includes('Prose.'));
});

test('D.3d.5.3: empty gaps parse (a pass verdict carries gaps: [])', () => {
  const { readiness } = parseReadinessArtifact(artifact('  []'));
  assert.deepEqual(readiness.gaps, []);
});

test('D.3d.5.3: readiness parsing fails closed on every malformed shape', () => {
  const cases: Array<[string, string, string]> = [
    ['missing front matter', '## Just markdown', 'FRONT_MATTER_MISSING'],
    ['malformed YAML', '---\nschemaVersion: 1\ngaps: [unclosed\n---\n', 'YAML_MALFORMED'],
    ['unsupported schemaVersion', '---\nschemaVersion: 9\ngaps: []\n---\n', 'SCHEMA_VERSION_UNSUPPORTED'],
    ['gaps not an array', '---\nschemaVersion: 1\ngaps: "none"\n---\n', 'SHAPE_INVALID'],
    ['gap not a mapping', '---\nschemaVersion: 1\ngaps:\n  - "a fact"\n---\n', 'SHAPE_INVALID'],
    ['gap missing target', '---\nschemaVersion: 1\ngaps:\n  - {"description":"d","classification":"DEFER","reason":"r"}\n---\n', 'SHAPE_INVALID'],
    ['gap classification not a string', '---\nschemaVersion: 1\ngaps:\n  - {"target":"t","description":"d","classification":["DEFER"],"reason":"r"}\n---\n', 'SHAPE_INVALID'],
    ['gap closure not a string', '---\nschemaVersion: 1\ngaps:\n  - {"target":"t","description":"d","classification":"DEFER","reason":"r","closure":7}\n---\n', 'SHAPE_INVALID'],
  ];
  for (const [label, text, code] of cases) {
    try {
      parseReadinessArtifact(text);
      assert.fail(`expected ReadinessParseError for ${label}`);
    } catch (err) {
      assert.ok(err instanceof ReadinessParseError, label);
      assert.equal((err as ReadinessParseError).code, code, label);
    }
  }
});

// ─── Deterministic derivation ────────────────────────────────────────────────

function gap(classification: string): Pick<ReadinessGap, 'classification'> {
  return { classification: classification as ReadinessGap['classification'] };
}

test('D.3d.5.3: precedence is mechanical — the highest-priority classification present wins', () => {
  const allRoutes = ['refine', 'defer', 'human', 'explore'];
  for (const [i, expected] of GAP_CLASSIFICATION_PRECEDENCE.entries()) {
    const present = GAP_CLASSIFICATION_PRECEDENCE.slice(i).map((c) => gap(c));
    const derived = deriveReviewRoute(present, allRoutes);
    assert.deepEqual(derived, { ok: true, route: ['refine', 'defer', 'human', 'explore'][i] });
    void i;
  }
});

test('D.3d.5.3: multiple classifications route to the CHEAPEST transition first (defer beats human/explore)', () => {
  const derived = deriveReviewRoute(
    [gap('HUMAN_DECISION'), gap('EXPLORE_AS_WORK'), gap('DEFER')],
    ['refine', 'defer', 'human', 'explore'],
  );
  assert.deepEqual(derived, { ok: true, route: 'defer' });
});

test('D.3d.5.3: derivation is constrained to the routes the step declares', () => {
  const derived = deriveReviewRoute([gap('DEFER')], ['refine', 'human', 'explore']);
  assert.equal(derived.ok, false);
  if (!derived.ok) assert.match(derived.error, /DEFER/);
  assert.match(deriveReviewRoute([gap('EXPLORE_AS_WORK')], ['refine']).error as string, /EXPLORE_AS_WORK|explore/);
});

test('D.3d.5.3: an invalid classification fails closed — no default route exists', () => {
  const derived = deriveReviewRoute([gap('SOUNDS_BAD')], ['refine', 'defer', 'human', 'explore']);
  assert.equal(derived.ok, false);
  if (!derived.ok) assert.match(derived.error, /SOUNDS_BAD/);
});

test('D.3d.5.3: an artifact containing ONLY an invalid classification fails closed at parse', () => {
  try {
    parseReadinessArtifact(artifact(
      '  - {"target":"f","description":"d","classification":"MADE_UP_CLASS","reason":"r"}',
    ));
    assert.fail('expected ReadinessParseError');
  } catch (err) {
    assert.ok(err instanceof ReadinessParseError);
    assert.equal((err as ReadinessParseError).code, 'SHAPE_INVALID');
    assert.match((err as ReadinessParseError).message, /MADE_UP_CLASS/);
  }
  // And through the composition the deriver registers (parse + derive).
  const viaDeriver = createReviewRouteDeriver()(artifact(
    '  - {"target":"f","description":"d","classification":"MADE_UP_CLASS","reason":"r"}',
  ), ['refine', 'defer', 'human', 'explore']);
  assert.equal(viaDeriver.ok, false);
  if (!viaDeriver.ok) assert.match(viaDeriver.error, /MADE_UP_CLASS/);
});

test('D.3d.5.3: a MIXED artifact (valid + invalid classification) fails closed and cannot derive a route', () => {
  // The critical case: precedence must never silently route on the valid
  // entry while ignoring the malformed one beside it.
  const mixed = artifact(
    '  - {"target":"fact-ok","description":"d","classification":"CAN_RESOLVE","reason":"r"}\n' +
    '  - {"target":"fact-bad","description":"d","classification":"MADE_UP_CLASS","reason":"r"}',
  );
  try {
    parseReadinessArtifact(mixed);
    assert.fail('expected ReadinessParseError for the mixed artifact');
  } catch (err) {
    assert.ok(err instanceof ReadinessParseError);
    assert.equal((err as ReadinessParseError).code, 'SHAPE_INVALID');
    assert.match((err as ReadinessParseError).message, /MADE_UP_CLASS/);
  }
  const viaDeriver = createReviewRouteDeriver()(mixed, ['refine', 'defer', 'human', 'explore']);
  assert.equal(viaDeriver.ok, false, 'a mixed artifact must never yield a route');
  if (!viaDeriver.ok) assert.match(viaDeriver.error, /MADE_UP_CLASS/);
});

test('D.3d.5.3: normal multi-gap precedence remains unchanged (all classifications valid)', () => {
  const derived = deriveReviewRoute(
    [gap('HUMAN_DECISION'), gap('EXPLORE_AS_WORK'), gap('DEFER')],
    ['refine', 'defer', 'human', 'explore'],
  );
  assert.deepEqual(derived, { ok: true, route: 'defer' });
  const parses = parseReadinessArtifact(artifact(
    '  - {"target":"a","description":"d","classification":"HUMAN_DECISION","reason":"r"}\n' +
    '  - {"target":"b","description":"d","classification":"DEFER","reason":"r"}',
  ));
  assert.equal(parses.readiness.gaps.length, 2);
});

test('D.3d.5.3: a fail verdict with NO classifiable gap fails closed', () => {
  const derived = deriveReviewRoute([], ['refine', 'defer', 'human', 'explore']);
  assert.equal(derived.ok, false);
  if (!derived.ok) assert.match(derived.error, /none carries a valid classification/);
});

// ─── AgentRunner seam ────────────────────────────────────────────────────────

function reviewArtifact(gaps: Array<{ target: string; description: string; classification: string; reason: string }>, path: string): string {
  const fm = ['---', 'schemaVersion: 1', 'gaps:', ...(gaps.length > 0 ? gaps.map((g) => '  - ' + JSON.stringify({ closure: 'see body', ...g })) : ['  []']), '---'].join('\n');
  return ['<!-- SLE-OUTPUT', 'role: explorer', 'node: review', 'verdict: fail', 'artifacts:', '  - id: readiness', `    path: ${path}`, '-->', '', `## ${path}`, '', fm, '', 'Body prose.'].join('\n');
}

function makeRunner(content: string, config: Record<string, unknown>): { result: Promise<ReturnType<AgentRunner['run']>>; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'd3d5-route-'));
  const provider: ILLMProvider = {
    async complete(_params: LLMCompletionParams): Promise<LLMCompletionResult> {
      return { content, tokens_used: 1, duration_ms: 1 };
    },
  };
  const cm = {
    async assemble() {
      return { system_prompt: 's', artifact_slices: {}, state_summary: '', task: 't', token_count: 1, truncated: [] };
    },
  };
  const runner = new AgentRunner(cm as never, provider, root, { updateNodeStatus: async () => {}, writeNodeOutput: async () => {}, createRunDir: async () => {}, createManifest: async () => {} } as unknown as RunArtifactManager, config as never, undefined);
  const ctx = {
    workflowRunId: 'r', workflowId: 'wf', stepId: 'review',
    iteration: 1, revision: 0, goal: 'g', projectRoot: root,
    requiresReviewVerdict: true,
    on_fail_routes: {
      refine: { target_step_id: 'refine-definition' },
      defer: { target_step_id: 'apply-deferred-gaps' },
      human: { target_step_id: 'prepare-human-decision' },
      explore: { target_step_id: 'record-exploration-need' },
    },
    outputArtifact: { type: 'definition-readiness', ref: 'dr:1', path: '.sle/work/w/readiness.md' },
  } as never;
  return { result: runner.run('explorer', ctx), root };
}

test('D.3d.5.3: the seam derives refine from a CAN_RESOLVE artifact and never consults the reply for the route', async () => {
  const content = reviewArtifact(
    [{ target: 'acceptance', description: 'missing criteria', classification: 'CAN_RESOLVE', reason: 'cheap' }],
    '.sle/work/w/readiness.md',
  ).replace('verdict: fail', 'verdict: fail\nroute: human'); // model tries to hijack control flow
  const { result, root } = makeRunner(content, { model: 'test', deriveReviewRoute: createReviewRouteDeriver() });
  try {
    const r = await result;
  assert.ok(r.success, r.error);
  assert.equal(r.reviewVerdict, 'fail');
  assert.equal(r.reviewRoute, 'refine', 'precedence derives refine from the artifact; the model-declared token is ignored');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('D.3d.5.3: the seam enforces precedence across multiple classified gaps (defer beats human+explore)', async () => {
  const content = reviewArtifact(
    [
      { target: 'fact-a', description: 'choice only a human can authorize', classification: 'HUMAN_DECISION', reason: 'r' },
      { target: 'fact-b', description: 'needs a benchmark', classification: 'EXPLORE_AS_WORK', reason: 'r' },
      { target: 'fact-c', description: 'real but non-blocking', classification: 'DEFER', reason: 'r' },
    ],
    '.sle/work/w/readiness.md',
  );
  const { result, root } = makeRunner(content, { model: 'test', deriveReviewRoute: createReviewRouteDeriver() });
  try {
    const r = await result;
  assert.ok(r.success, r.error);
  assert.equal(r.reviewRoute, 'defer');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('D.3d.5.3: an unparseable fail artifact fails closed BEFORE any output is written', async () => {
  const content = [
    '<!-- SLE-OUTPUT', 'role: explorer', 'node: review', 'verdict: fail',
    'artifacts:', '  - id: readiness', '    path: .sle/work/w/readiness.md', '-->', '',
    '## .sle/work/w/readiness.md', '', 'No front matter at all.',
  ].join('\n');
  const { result, root } = makeRunner(content, { model: 'test', deriveReviewRoute: createReviewRouteDeriver() });
  try {
    const r = await result;
  assert.equal(r.success, false);
  assert.deepStrictEqual(r.artifacts_written, []);
  assert.match(r.error ?? '', /FRONT_MATTER_MISSING/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('D.3d.5.3: without a deriver, ONE declared route is used deterministically; MULTIPLE declared routes fail closed', async () => {
  const routeTempRoot = mkdtempSync(join(tmpdir(), 'd3d5-route-fallback-'));
  const content = reviewArtifact(
    [{ target: 'f', description: 'd', classification: 'CAN_RESOLVE', reason: 'r' }],
    '.sle/work/w/readiness.md',
  );
  const single = new AgentRunner({ async assemble() { return { system_prompt: 's', artifact_slices: {}, state_summary: '', task: 't', token_count: 1, truncated: [] }; } } as never, { async complete() { return { content, tokens_used: 1, duration_ms: 1 }; } } as never, routeTempRoot, { updateNodeStatus: async () => {}, writeNodeOutput: async () => {}, createRunDir: async () => {}, createManifest: async () => {} } as unknown as RunArtifactManager, { model: 'test' } as never, undefined);
  const singleResult = await single.run('explorer', {
    workflowRunId: 'r', workflowId: 'wf', stepId: 'review',
    iteration: 1, revision: 0, goal: 'g', projectRoot: '/proj',
    requiresReviewVerdict: true,
    on_fail_routes: { refine: { target_step_id: 'refine-definition' } },
    outputArtifact: { type: 'definition-readiness', ref: 'dr:1', path: '.sle/work/w/readiness.md' },
  } as never);
  assert.ok(singleResult.success, singleResult.error);
  assert.equal(singleResult.reviewRoute, 'refine', 'a single declared route needs no judgment');
  try {

  const multi = new AgentRunner({ async assemble() { return { system_prompt: 's', artifact_slices: {}, state_summary: '', task: 't', token_count: 1, truncated: [] }; } } as never, { async complete() { return { content, tokens_used: 1, duration_ms: 1 }; } } as never, routeTempRoot, { updateNodeStatus: async () => {}, writeNodeOutput: async () => {}, createRunDir: async () => {}, createManifest: async () => {} } as unknown as RunArtifactManager, { model: 'test' } as never, undefined);
  const multiResult = await multi.run('explorer', {
    workflowRunId: 'r', workflowId: 'wf', stepId: 'review',
    iteration: 1, revision: 0, goal: 'g', projectRoot: '/proj',
    requiresReviewVerdict: true,
    on_fail_routes: { refine: { target_step_id: 'refine-definition' }, human: { target_step_id: 'prepare-human-decision' } },
    outputArtifact: { type: 'definition-readiness', ref: 'dr:1', path: '.sle/work/w/readiness.md' },
  } as never);
  assert.equal(multiResult.success, false);
  assert.match(multiResult.error ?? '', /no route deriver is registered/);
  assert.match(multiResult.error ?? '', /never asked to break the tie|fail closed/);
  } finally { rmSync(routeTempRoot, { recursive: true, force: true }); }
});

// ─── Composition shape ───────────────────────────────────────────────────────

test('D.3d.5.3: the deriver factory is pure — no storage, no workflow, no provider knowledge', () => {
  const deriver = createReviewRouteDeriver();
  const outcome = deriver(artifact('  - {"target":"t","description":"d","classification":"HUMAN_DECISION","reason":"r"}'), ['human']);
  assert.deepEqual(outcome, { ok: true, route: 'human' });
  // And the parse+derive composition surfaces parse diagnoses verbatim.
  const parsed = deriver('no front matter', ['human']);
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.match(parsed.error, /FRONT_MATTER_MISSING/);
});
