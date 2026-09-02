// Evidence boundary invariants (DDR-032 §20).
//
// These tests prove the three core security invariants:
//   1. SHA binding: evidence for SHA A cannot satisfy a requirement for SHA B
//   2. Source trust: executor self-report cannot satisfy external-only requirements
//   3. Local-file ci-toolkit is informational — it never satisfies an external requirement

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { CompletionPolicy } from '../src/evidence/completion-policy.js';
import type { Evidence } from '../src/domain/evidence.js';
import type { EvidenceRequirement } from '../src/domain/primitives.js';

function makeEvidence(partial: Partial<Evidence> = {}): Evidence {
  return {
    id: 'e-1',
    workItemId: 'wi-1',
    type: 'github.ci',
    source: 'github',
    collectorId: 'github.ci',
    status: 'passed',
    payload: {},
    collectedAt: new Date().toISOString(),
    ...partial,
  };
}

const policy = new CompletionPolicy();

// ── SHA binding ──────────────────────────────────────────────────────────────

test('evidence: SHA-pinned requirement is satisfied by evidence with matching candidateRef', () => {
  const req: EvidenceRequirement = { type: 'github.ci', candidateRef: 'abc123' };
  const ev = makeEvidence({ candidateRef: 'abc123' });
  const result = policy.evaluate([req], [ev]);
  assert.equal(result.outcome, 'allow');
});

test('evidence: SHA-pinned requirement is DENIED by evidence with different candidateRef (SHA A ≠ SHA B)', () => {
  const req: EvidenceRequirement = { type: 'github.ci', candidateRef: 'abc123' };
  const ev = makeEvidence({ candidateRef: 'deadbeef' }); // different SHA
  const result = policy.evaluate([req], [ev]);
  assert.equal(result.outcome, 'deny', 'Evidence bound to a different SHA must not satisfy');
  assert.ok(result.reason?.includes('SHA mismatch') || result.reason?.includes('Missing'), `Reason: ${result.reason}`);
});

test('evidence: SHA-pinned requirement is DENIED by evidence with no candidateRef', () => {
  const req: EvidenceRequirement = { type: 'github.ci', candidateRef: 'abc123' };
  const ev = makeEvidence({ candidateRef: undefined }); // no SHA binding
  const result = policy.evaluate([req], [ev]);
  assert.equal(result.outcome, 'deny', 'Unbound evidence must not satisfy a SHA-pinned requirement');
});

test('evidence: un-pinned requirement is satisfied by any matching evidence regardless of candidateRef', () => {
  const req: EvidenceRequirement = { type: 'github.ci' }; // no candidateRef
  const ev = makeEvidence({ candidateRef: 'any-sha' });
  const result = policy.evaluate([req], [ev]);
  assert.equal(result.outcome, 'allow');
});

// ── Executor self-report rejection ───────────────────────────────────────────

test('evidence: executor self-report (source=executor) is DENIED for external-only types', () => {
  const req: EvidenceRequirement = { type: 'github.ci' };
  const ev = makeEvidence({ source: 'executor', collectorId: undefined });
  const result = policy.evaluate([req], [ev]);
  assert.equal(result.outcome, 'deny', 'Executor self-report must not satisfy github.ci');
});

test('evidence: executor self-report (source=executor:adapter) is DENIED for external-only types', () => {
  const req: EvidenceRequirement = { type: 'ci_toolkit.semantic_review' };
  const ev = makeEvidence({ type: 'ci_toolkit.semantic_review', source: 'adapter:stratum-agent', collectorId: undefined });
  const result = policy.evaluate([req], [ev]);
  assert.equal(result.outcome, 'deny');
});

test('evidence: trusted collectorId allows external-only type to pass', () => {
  const req: EvidenceRequirement = { type: 'github.ci' };
  const ev = makeEvidence({ source: 'github', collectorId: 'github.ci' });
  const result = policy.evaluate([req], [ev]);
  assert.equal(result.outcome, 'allow');
});

test('evidence: unknown collectorId is rejected for external-only types', () => {
  const req: EvidenceRequirement = { type: 'github.ci' };
  // collectorId is present but not in the trusted set — e.g. a custom executor plugin
  const ev = makeEvidence({ source: 'github', collectorId: 'custom-unregistered-plugin' });
  const result = policy.evaluate([req], [ev]);
  assert.equal(result.outcome, 'deny', 'Unknown collectorId must not satisfy external-only requirement');
});

// ── ci-toolkit local-file is informational ───────────────────────────────────

test('evidence: ci_toolkit:local_file source is DENIED for ci_toolkit.semantic_review with status=passed', () => {
  const req: EvidenceRequirement = { type: 'ci_toolkit.semantic_review' };
  const ev = makeEvidence({
    type: 'ci_toolkit.semantic_review',
    source: 'ci_toolkit:local_file',
    collectorId: 'ci_toolkit.semantic_review',
    status: 'informational', // CiToolkitCollector always sets informational for local-file
  });
  const result = policy.evaluate([req], [ev]);
  // Default conditions check status === 'passed', and informational ≠ passed.
  assert.equal(result.outcome, 'deny', 'Local-file ci-toolkit (informational) must not satisfy passed requirement');
});

test('evidence: informational evidence satisfies a requirement with status=informational condition', () => {
  const req: EvidenceRequirement = {
    type: 'ci_toolkit.semantic_review',
    conditions: { status: 'informational' },
  };
  const ev = makeEvidence({
    type: 'ci_toolkit.semantic_review',
    source: 'ci_toolkit:local_file',
    collectorId: 'ci_toolkit.semantic_review',
    status: 'informational',
  });
  // local_file source is blocked even for informational requirements on external-only types
  const result = policy.evaluate([req], [ev]);
  assert.equal(result.outcome, 'deny', 'local_file source is always untrusted for external-only types');
});

// ── No requirements → always allowed ────────────────────────────────────────

test('evidence: no requirements always allows completion', () => {
  const result = policy.evaluate([], []);
  assert.equal(result.outcome, 'allow');
});

// ── Multiple requirements — all must pass ────────────────────────────────────

test('evidence: all requirements must be satisfied — partial match is denied', () => {
  const reqs: EvidenceRequirement[] = [
    { type: 'github.ci' },
    { type: 'github.review' },
  ];
  // Only github.ci evidence present
  const ev = makeEvidence({ type: 'github.ci', source: 'github', collectorId: 'github.ci' });
  const result = policy.evaluate(reqs, [ev]);
  assert.equal(result.outcome, 'deny');
  assert.ok(result.reason?.includes('github.review'));
});
