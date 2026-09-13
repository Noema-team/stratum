// D.34 C7 — the four-tier diagnosis (SEM / TRANSPORT / CONV / DEPLOY).
//
// THE C7 ACCEPTANCE TEST: given the same run evidence, the evaluator
// deterministically reaches the same diagnosis — and the transport
// vocabulary it recognizes is proven against the ACTUAL producer functions
// in src/transport/step-result.ts, so the recognizer can never silently
// drift from the diagnostics the execution layer emits.
//
// These tests are pure: fixed traces in, exact diagnoses out. No provider,
// no network, no clock.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { diagnoseRun, deploymentVerdict, type DeploymentEvidence } from '../tests/fixtures/d3d/diagnosis.js';
import type { DefineWorkTrace, OracleResult, RecordedStep } from '../tests/fixtures/d3d/harness.js';
import {
  formatRepairExhaustedDiagnostic,
  resultRepairExhaustedDiagnostic,
  resultKindNegotiationDiagnostic,
  TransportParseError,
} from '../src/transport/step-result.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function step(partial: Partial<RecordedStep> & { stepId: string }): RecordedStep {
  return { success: true, artifactsWritten: [], ...partial };
}

function trace(partial: Partial<DefineWorkTrace>): DefineWorkTrace {
  return {
    scenarioId: 'early', workflowRunId: 'r1', finalStatus: 'complete', finalStepId: 'commit',
    iterationsUsed: 1, steps: [], decisions: [], artifacts: [], definitionText: 'def',
    readinessText: null, explorationNeedText: null, toolUseRoundTrips: 1,
    noExtraWorkItemsCreated: true,
    ...partial,
  };
}

function oracle(checks: Array<{ name: string; pass: boolean; detail?: string }>): OracleResult {
  return { scenarioId: 'early', checks, pass: checks.every((c) => c.pass) };
}

const PASSING_ORACLE = oracle([{ name: 'everything methodologies', pass: true }]);

// ─── Determinism (the acceptance test) ────────────────────────────────────────

test('D.34.C7 DETERMINISM: same evidence → the identical diagnosis, every time', () => {
  const t = trace({
    steps: [step({ stepId: 'synthesize-definition', success: false, error: 'LLM call failed: boom' })],
    finalStatus: 'halted',
    finalStepId: 'refine-definition',
  });
  const o = oracle([{ name: 'check', pass: false, detail: 'no' }]);
  const a = JSON.stringify(diagnoseRun(t, o));
  const b = JSON.stringify(diagnoseRun(t, o));
  const c = JSON.stringify(diagnoseRun(structuredClone(t), structuredClone(o)));
  assert.equal(a, b);
  assert.equal(a, c);
});

// ─── PASS ─────────────────────────────────────────────────────────────────────

test('D.34.C7 PASS: a converging, oracle-passing run has no diagnosis', () => {
  const d = diagnoseRun(trace({}), PASSING_ORACLE);
  assert.equal(d.tier, null);
  assert.deepEqual(d.details, []);
});

// ─── SEM ──────────────────────────────────────────────────────────────────────

test('D.34.C7 SEM: clean wire + clean convergence + oracle failure → failed check names as evidence', () => {
  const d = diagnoseRun(
    trace({
      steps: [
        step({ stepId: 'synthesize-definition' }),
        step({ stepId: 'definition-readiness-review', reviewVerdict: 'pass' }),
      ],
    }),
    oracle([
      { name: 'initial review is not pass', pass: false, detail: 'verdict=pass' },
      { name: 'a Decision genuinely concerns platform scope', pass: false },
      { name: 'the run terminates cleanly', pass: true },
    ]),
  );
  assert.equal(d.tier, 'SEM');
  assert.deepEqual(d.details, [
    'initial review is not pass — verdict=pass',
    'a Decision genuinely concerns platform scope',
  ]);
});

// ─── TRANSPORT: precedence + the real producer vocabulary ─────────────────────

test('D.34.C7 TRANSPORT: a wire failure outranks convergence and semantic failures', () => {
  const err = resultRepairExhaustedDiagnostic('definition', 'Reason: DECISION_REF_MISSING: x', 3, 1);
  const d = diagnoseRun(
    trace({
      steps: [step({ stepId: 'synthesize-definition', success: false, error: err })],
      finalStatus: 'halted',
      finalStepId: 'synthesize-definition',
    }),
    oracle([{ name: 'initial review is not pass', pass: false }]),
  );
  assert.equal(d.tier, 'TRANSPORT');
  assert.equal(d.details.length, 1);
  assert.match(d.details[0], /^synthesize-definition: /);
});

test('D.34.C7 TRANSPORT: every REAL producer diagnostic string is recognized', () => {
  const tpe = new TransportParseError('Reply contained no JSON object', 'raw', 'the reply contained no JSON object (proposal replies must be a single JSON object)', 'absent');
  const realDiagnostics: Array<[string, string]> = [
    ['formatRepairExhaustedDiagnostic', formatRepairExhaustedDiagnostic(tpe, 2, 1)],
    ['resultRepairExhaustedDiagnostic', resultRepairExhaustedDiagnostic('definition-readiness', 'Reason: FAIL_WITHOUT_GAPS', 2, 1)],
    ['resultKindNegotiationDiagnostic', resultKindNegotiationDiagnostic('definition', 'the transport produced materialized bytes where an output contract is registered')],
    ['TransportParseError.reason', tpe.reason],
  ];
  for (const [name, diagnostic] of realDiagnostics) {
    const d = diagnoseRun(
      trace({ steps: [step({ stepId: 'definition-readiness-review', success: false, error: diagnostic })] }),
      PASSING_ORACLE,
    );
    assert.equal(d.tier, 'TRANSPORT', `${name} must diagnose as TRANSPORT`);
  }
});

// ─── CONV ─────────────────────────────────────────────────────────────────────

test('D.34.C7 CONV: halted run (never reached commit), no wire failure', () => {
  const d = diagnoseRun(
    trace({ finalStatus: 'halted', finalStepId: 'definition-readiness-review' }),
    PASSING_ORACLE,
  );
  assert.equal(d.tier, 'CONV');
  assert.match(d.details[0], /did not reach commit: status=halted/);
});

test('D.34.C7 CONV: a non-transport step failure', () => {
  const d = diagnoseRun(
    trace({
      steps: [step({ stepId: 'apply-deferred-gaps', success: false, error: "Role 'explorer' is not permitted to write '/docs/x'" })],
      finalStatus: 'complete',
      finalStepId: 'commit',
    }),
    PASSING_ORACLE,
  );
  assert.equal(d.tier, 'CONV');
  assert.match(d.details[0], /^apply-deferred-gaps failed: /);
});

test('D.34.C7 CONV: a run that threw before completion (harness/provider crash)', () => {
  const d = diagnoseRun(
    trace({ finalStatus: 'halted', finalStepId: null, error: 'LLM call failed: 502 Bad Gateway' }),
    PASSING_ORACLE,
  );
  assert.equal(d.tier, 'CONV');
  assert.ok(d.details.some((x) => x.includes('run error: LLM call failed: 502 Bad Gateway')));
});

// ─── DEPLOY: the series verdict ───────────────────────────────────────────────

test('D.34.C7 DEPLOY: qualified iff every run in the series passed', () => {
  const allPass: DeploymentEvidence[] = [
    { scenarioId: 'early', passed: true, iterationsUsed: 2, diagnosisTier: null },
    { scenarioId: 'partial', passed: true, iterationsUsed: 1, diagnosisTier: null },
    { scenarioId: 'mature', passed: true, iterationsUsed: 1, diagnosisTier: null },
  ];
  assert.deepEqual(deploymentVerdict(allPass), { qualified: true, reasons: [] });

  const oneFails: DeploymentEvidence[] = [
    ...allPass,
    { scenarioId: 'early', passed: false, iterationsUsed: 4, diagnosisTier: 'SEM' },
  ];
  const v = deploymentVerdict(oneFails);
  assert.equal(v.qualified, false);
  assert.deepEqual(v.reasons, ['early: not passed (SEM)']);
});

// ─── Evidence shape: repair counters ride on the recorded steps ───────────────

test('D.34.C7 EVIDENCE: recorded steps carry repair counters so a transport diagnosis is checkable', () => {
  const s: RecordedStep = {
    stepId: 'synthesize-definition', success: false, artifactsWritten: [],
    error: resultRepairExhaustedDiagnostic('definition', 'r', 2, 1),
    formatRepairs: 0, resultRepairs: 1,
  };
  assert.equal(s.resultRepairs, 1);
  const d = diagnoseRun(trace({ steps: [s] }), PASSING_ORACLE);
  assert.equal(d.tier, 'TRANSPORT');
});
