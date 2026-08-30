import { test } from 'node:test';
import { strict as assert } from 'assert';
import { randomUUID } from 'crypto';
import { openDatabase } from '../src/storage/database.js';
import { WorkspaceRepository, ProjectRepository, WorkItemRepository } from '../src/storage/repositories.js';
import { WorkService } from '../src/services/work-service.js';
import { EvidenceService } from '../src/services/evidence-service.js';
import { CompletionPolicy } from '../src/evidence/completion-policy.js';
import { GithubCiCollector } from '../src/evidence/github/ci-collector.js';
import { GithubReviewCollector } from '../src/evidence/github/review-collector.js';
import { ScopeDiffCollector } from '../src/evidence/scope-diff/collector.js';
import type { GitHubAdapter, GithubCiStatus, GithubReviewStatus } from '../src/evidence/github/adapter.js';
import type { Evidence } from '../src/domain/evidence.js';
import type { EvidenceRequirement } from '../src/domain/primitives.js';
import type { WorkItem, Workspace, Project } from '../src/domain/index.js';

// ============================================================================
// Test helpers
// ============================================================================

function openTestDb() { return openDatabase(':memory:'); }

function makeWorkspace(): Workspace {
  return { id: randomUUID(), name: 'ws', createdAt: new Date().toISOString() };
}

function makeProject(workspaceId: string): Project {
  const now = new Date().toISOString();
  return { id: randomUUID(), workspaceId, name: 'proj', status: 'active', priority: 0, createdAt: now, updatedAt: now };
}

function makeWorkItem(projectId: string, requiredEvidence: EvidenceRequirement[] = []): WorkItem {
  const now = new Date().toISOString();
  return {
    id: randomUUID(), projectId, repositoryIds: [], title: 'T', goal: 'G',
    workflowId: 'draft-artifact', state: 'in_review', priority: 0,
    acceptanceCriteria: [], constraints: [], requiredEvidence, dependencies: [],
    createdAt: now, updatedAt: now,
  };
}

function makeEvidence(workItemId: string, overrides: Partial<Evidence> = {}): Evidence {
  return {
    id: randomUUID(),
    workItemId,
    type: 'github.ci',
    source: 'github',
    collectorId: 'github.ci',
    status: 'passed',
    payload: {},
    collectedAt: new Date().toISOString(),
    ...overrides,
  };
}

class StubGitHubAdapter implements GitHubAdapter {
  constructor(
    private readonly ciResult: GithubCiStatus,
    private readonly reviewResult: GithubReviewStatus,
  ) {}

  async getCiStatus(_remote: string, sha: string): Promise<GithubCiStatus> {
    return { ...this.ciResult, sha };
  }

  async getReviewStatus(_remote: string, prNumber: number): Promise<GithubReviewStatus> {
    return { ...this.reviewResult, prNumber };
  }
}

// ============================================================================
// CompletionPolicy — unit tests
// ============================================================================

test('testPolicyAllowsWhenNoRequirements', () => {
  const policy = new CompletionPolicy();
  const result = policy.evaluate([], []);
  assert.equal(result.outcome, 'allow');
});

test('testPolicyDeniesWhenEvidenceMissing', () => {
  const policy = new CompletionPolicy();
  const result = policy.evaluate(
    [{ type: 'github.ci' }],
    [],
  );
  assert.equal(result.outcome, 'deny');
  assert.ok(result.reason.includes('github.ci'));
});

test('testPolicyAllowsWhenEvidencePassed', () => {
  const policy = new CompletionPolicy();
  const evidence: Evidence[] = [{
    id: randomUUID(), workItemId: 'wi1',
    type: 'github.ci', source: 'github', collectorId: 'github.ci', status: 'passed',
    payload: {}, collectedAt: new Date().toISOString(),
  }];
  const result = policy.evaluate([{ type: 'github.ci' }], evidence);
  assert.equal(result.outcome, 'allow');
});

test('testPolicyDeniesWhenEvidenceFailed', () => {
  const policy = new CompletionPolicy();
  const evidence: Evidence[] = [{
    id: randomUUID(), workItemId: 'wi1',
    type: 'github.ci', source: 'github', status: 'failed',
    payload: {}, collectedAt: new Date().toISOString(),
  }];
  const result = policy.evaluate([{ type: 'github.ci' }], evidence);
  assert.equal(result.outcome, 'deny', 'failed evidence should not satisfy requirement');
});

test('testPolicyChecksConditions', () => {
  const policy = new CompletionPolicy();
  const evidence: Evidence[] = [{
    id: randomUUID(), workItemId: 'wi1',
    type: 'ci_toolkit.semantic_review', source: 'ci_toolkit',
    collectorId: 'ci_toolkit.semantic_review', status: 'passed',
    payload: { blockingFindings: 0, warningFindings: 2 },
    collectedAt: new Date().toISOString(),
  }];

  // blocking_findings: 0 — satisfied
  const pass = policy.evaluate(
    [{ type: 'ci_toolkit.semantic_review', conditions: { blockingFindings: 0 } }],
    evidence,
  );
  assert.equal(pass.outcome, 'allow');

  // blocking_findings: 0 but requesting 1 — denied
  const fail = policy.evaluate(
    [{ type: 'ci_toolkit.semantic_review', conditions: { blockingFindings: 1 } }],
    evidence,
  );
  assert.equal(fail.outcome, 'deny');
});

test('testPolicyRejectsExecutorSelfReport', () => {
  const policy = new CompletionPolicy();
  // Evidence sourced by the executor adapter must not satisfy github.ci requirement.
  const selfReported: Evidence[] = [{
    id: randomUUID(), workItemId: 'wi1',
    type: 'github.ci', source: 'executor', status: 'passed',
    payload: {}, collectedAt: new Date().toISOString(),
  }];
  const result = policy.evaluate([{ type: 'github.ci' }], selfReported);
  assert.equal(result.outcome, 'deny', 'executor self-report must not satisfy github.ci');
});

test('testPolicyRejectsAdapterPrefixedSource', () => {
  const policy = new CompletionPolicy();
  const selfReported: Evidence[] = [{
    id: randomUUID(), workItemId: 'wi1',
    type: 'github.review', source: 'adapter:stratum-agent', status: 'passed',
    payload: {}, collectedAt: new Date().toISOString(),
  }];
  const result = policy.evaluate([{ type: 'github.review' }], selfReported);
  assert.equal(result.outcome, 'deny', 'adapter-prefixed source must not satisfy github.review');
});

test('testPolicyAllowsInternalEvidenceForNonExternalTypes', () => {
  const policy = new CompletionPolicy();
  // 'acceptance_criteria' is not in EXTERNAL_ONLY_TYPES — can be self-reported
  const internal: Evidence[] = [{
    id: randomUUID(), workItemId: 'wi1',
    type: 'acceptance_criteria', source: 'executor', status: 'passed',
    payload: {}, collectedAt: new Date().toISOString(),
  }];
  const result = policy.evaluate([{ type: 'acceptance_criteria' }], internal);
  assert.equal(result.outcome, 'allow');
});

test('testPolicyMultipleRequirementsAllMustPass', () => {
  const policy = new CompletionPolicy();
  const evidence: Evidence[] = [
    { id: randomUUID(), workItemId: 'wi1', type: 'github.ci', source: 'github', collectorId: 'github.ci', status: 'passed', payload: {}, collectedAt: new Date().toISOString() },
    // Missing ci_toolkit.semantic_review
  ];
  const result = policy.evaluate(
    [{ type: 'github.ci' }, { type: 'ci_toolkit.semantic_review' }],
    evidence,
  );
  assert.equal(result.outcome, 'deny');
  assert.ok(result.reason.includes('ci_toolkit.semantic_review'));
});

// ============================================================================
// EvidenceService
// ============================================================================

test('testEvidenceServiceRecord', () => {
  const db = openTestDb();
  const ws = new WorkspaceRepository(db);
  const workspace = makeWorkspace();
  ws.save(workspace);
  const proj = new ProjectRepository(db);
  const project = makeProject(workspace.id);
  proj.save(project);
  const items = new WorkItemRepository(db);
  const wi = makeWorkItem(project.id);
  items.save(wi);

  const svc = new EvidenceService(db);
  const e = makeEvidence(wi.id);
  svc.record(e);

  const listed = svc.listByWorkItem(wi.id);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].type, 'github.ci');
});

test('testEvidenceServiceEvaluateCompletion', () => {
  const db = openTestDb();
  const ws = new WorkspaceRepository(db);
  const workspace = makeWorkspace();
  ws.save(workspace);
  const proj = new ProjectRepository(db);
  const project = makeProject(workspace.id);
  proj.save(project);
  const items = new WorkItemRepository(db);
  const wi = makeWorkItem(project.id, [{ type: 'github.ci' }]);
  items.save(wi);

  const svc = new EvidenceService(db);

  // No evidence yet — denied
  const before = svc.evaluateCompletion(wi);
  assert.equal(before.outcome, 'deny');

  // Record passing evidence
  svc.record(makeEvidence(wi.id, { type: 'github.ci', source: 'github', status: 'passed' }));
  const after = svc.evaluateCompletion(wi);
  assert.equal(after.outcome, 'allow');
});

test('testEvidenceServiceNoRequirementsAlwaysAllows', () => {
  const db = openTestDb();
  const ws = new WorkspaceRepository(db);
  const workspace = makeWorkspace();
  ws.save(workspace);
  const proj = new ProjectRepository(db);
  const project = makeProject(workspace.id);
  proj.save(project);
  const items = new WorkItemRepository(db);
  const wi = makeWorkItem(project.id, []); // no requirements
  items.save(wi);

  const svc = new EvidenceService(db);
  const result = svc.evaluateCompletion(wi);
  assert.equal(result.outcome, 'allow');
});

// ============================================================================
// WorkService.complete() — evidence guard integration
// ============================================================================

test('testCompleteBlockedByEvidencePolicy', () => {
  const db = openTestDb();
  const ws = new WorkspaceRepository(db);
  const workspace = makeWorkspace();
  ws.save(workspace);
  const proj = new ProjectRepository(db);
  const project = makeProject(workspace.id);
  proj.save(project);
  const items = new WorkItemRepository(db);
  const wi = makeWorkItem(project.id, [{ type: 'github.ci' }]);
  items.save(wi);

  const evidenceSvc = new EvidenceService(db);
  const svc = new WorkService(db, workspace.id, { evidenceGuard: evidenceSvc.asGuard() });

  assert.throws(
    () => svc.complete({ workItemId: wi.id }),
    (err: Error) => {
      assert.ok(err.message.includes('evidence policy'));
      return true;
    },
    'complete() should throw when evidence not satisfied',
  );
});

test('testCompleteAllowedAfterEvidenceSatisfied', () => {
  const db = openTestDb();
  const ws = new WorkspaceRepository(db);
  const workspace = makeWorkspace();
  ws.save(workspace);
  const proj = new ProjectRepository(db);
  const project = makeProject(workspace.id);
  proj.save(project);
  const items = new WorkItemRepository(db);
  const wi = makeWorkItem(project.id, [{ type: 'github.ci' }]);
  items.save(wi);

  const evidenceSvc = new EvidenceService(db);
  evidenceSvc.record(makeEvidence(wi.id, { type: 'github.ci', source: 'github', status: 'passed' }));

  const svc = new WorkService(db, workspace.id, { evidenceGuard: evidenceSvc.asGuard() });
  const result = svc.complete({ workItemId: wi.id });
  assert.equal(result.state, 'completed');
});

test('testCompleteWithNoRequirementsNeedsNoEvidence', () => {
  const db = openTestDb();
  const ws = new WorkspaceRepository(db);
  const workspace = makeWorkspace();
  ws.save(workspace);
  const proj = new ProjectRepository(db);
  const project = makeProject(workspace.id);
  proj.save(project);
  const items = new WorkItemRepository(db);
  const wi = makeWorkItem(project.id, []); // no evidence requirements
  items.save(wi);

  const evidenceSvc = new EvidenceService(db);
  const svc = new WorkService(db, workspace.id, { evidenceGuard: evidenceSvc.asGuard() });

  // Should complete without any evidence records
  const result = svc.complete({ workItemId: wi.id });
  assert.equal(result.state, 'completed');
});

// ============================================================================
// GithubCiCollector
// ============================================================================

test('testGithubCiCollectorPassed', async () => {
  const stub: GitHubAdapter = new StubGitHubAdapter(
    { sha: 'abc123', conclusion: 'success', workflowRuns: [] },
    { prNumber: 1, approved: false, changesRequested: false, reviews: [] },
  );
  const collector = new GithubCiCollector(stub);
  const results = await collector.collect({
    workItemId: randomUUID(),
    repositories: [],
    refs: {
      commits: [{ repo: { provider: 'github', remote: 'github.com/org/repo' }, sha: 'abc123' }],
    },
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'github.ci');
  assert.equal(results[0].status, 'passed');
  assert.equal(results[0].source, 'github');
  assert.equal(results[0].collectorId, 'github.ci');
  assert.equal(results[0].candidateRef, 'abc123');
  assert.equal(results[0].subjectRef, 'abc123');
});

test('testGithubCiCollectorFailed', async () => {
  const stub = new StubGitHubAdapter(
    { sha: '', conclusion: 'failure', workflowRuns: [] },
    { prNumber: 1, approved: false, changesRequested: false, reviews: [] },
  );
  const collector = new GithubCiCollector(stub);
  const results = await collector.collect({
    workItemId: randomUUID(),
    repositories: [],
    refs: {
      commits: [{ repo: { provider: 'github', remote: 'r' }, sha: 'deadbeef' }],
    },
  });

  assert.equal(results[0].status, 'failed');
});

test('testGithubCiCollectorPending', async () => {
  const stub = new StubGitHubAdapter(
    { sha: '', conclusion: null, workflowRuns: [] },
    { prNumber: 1, approved: false, changesRequested: false, reviews: [] },
  );
  const collector = new GithubCiCollector(stub);
  const results = await collector.collect({
    workItemId: randomUUID(),
    repositories: [],
    refs: {
      commits: [{ repo: { provider: 'github', remote: 'r' }, sha: 'pending' }],
    },
  });
  assert.equal(results[0].status, 'informational');
});

// ============================================================================
// GithubReviewCollector
// ============================================================================

test('testGithubReviewCollectorApproved', async () => {
  const stub = new StubGitHubAdapter(
    { sha: '', conclusion: 'success', workflowRuns: [] },
    {
      prNumber: 42,
      approved: true,
      changesRequested: false,
      reviews: [{ author: 'alice', state: 'approved', submittedAt: new Date().toISOString() }],
    },
  );
  const collector = new GithubReviewCollector(stub);
  const results = await collector.collect({
    workItemId: randomUUID(),
    repositories: [],
    refs: {
      prs: [{ repo: { provider: 'github', remote: 'r' }, number: 42, headSha: 'sha1' }],
    },
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'github.review');
  assert.equal(results[0].status, 'passed');
  assert.equal((results[0].payload as Record<string, unknown>)['approved'], true);
});

test('testGithubReviewCollectorChangesRequested', async () => {
  const stub = new StubGitHubAdapter(
    { sha: '', conclusion: null, workflowRuns: [] },
    { prNumber: 7, approved: false, changesRequested: true, reviews: [] },
  );
  const collector = new GithubReviewCollector(stub);
  const results = await collector.collect({
    workItemId: randomUUID(),
    repositories: [],
    refs: { prs: [{ repo: { provider: 'github', remote: 'r' }, number: 7, headSha: 's' }] },
  });
  assert.equal(results[0].status, 'failed');
});

// ============================================================================
// ScopeDiffCollector
// ============================================================================

test('testScopeDiffWithinScope', async () => {
  const collector = new ScopeDiffCollector(
    async () => ['src/foo.ts', 'src/bar.ts'],
    ['src/'],
    ['infra/'],
  );
  const results = await collector.collect({
    workItemId: randomUUID(),
    repositories: [],
    refs: {
      prs: [{ repo: { provider: 'github', remote: 'r' }, number: 1, headSha: 's' }],
    },
  });
  assert.equal(results[0].status, 'passed');
  assert.equal((results[0].payload as Record<string, unknown>)['driftLevel'], 'within_scope');
});

test('testScopeDiffForbiddenChange', async () => {
  const collector = new ScopeDiffCollector(
    async () => ['src/foo.ts', 'infra/prod.tf'],
    ['src/'],
    ['infra/'],
  );
  const results = await collector.collect({
    workItemId: randomUUID(),
    repositories: [],
    refs: {
      prs: [{ repo: { provider: 'github', remote: 'r' }, number: 1, headSha: 's' }],
    },
  });
  assert.equal(results[0].status, 'failed');
  assert.equal((results[0].payload as Record<string, unknown>)['driftLevel'], 'forbidden_change');
});

test('testScopeDiffMaterialExpansion', async () => {
  const collector = new ScopeDiffCollector(
    async () => ['src/a.ts', 'docs/x.md', 'docs/y.md', 'docs/z.md'],
    ['src/'],
    [],
  );
  const results = await collector.collect({
    workItemId: randomUUID(),
    repositories: [],
    refs: {
      prs: [{ repo: { provider: 'github', remote: 'r' }, number: 1, headSha: 's' }],
    },
  });
  assert.equal((results[0].payload as Record<string, unknown>)['driftLevel'], 'material_expansion');
  assert.equal(results[0].status, 'informational');
});

// ============================================================================
// EvidenceService.collectAll with registered collectors
// ============================================================================

test('testEvidenceServiceCollectAll', async () => {
  const db = openTestDb();
  const ws = new WorkspaceRepository(db);
  const workspace = makeWorkspace();
  ws.save(workspace);
  const proj = new ProjectRepository(db);
  const project = makeProject(workspace.id);
  proj.save(project);
  const items = new WorkItemRepository(db);
  const wi = makeWorkItem(project.id, [{ type: 'github.ci' }, { type: 'github.review' }]);
  items.save(wi);

  const stub = new StubGitHubAdapter(
    { sha: 'sha1', conclusion: 'success', workflowRuns: [] },
    { prNumber: 1, approved: true, changesRequested: false, reviews: [] },
  );

  const svc = new EvidenceService(db, [
    new GithubCiCollector(stub),
    new GithubReviewCollector(stub),
  ]);

  const collected = await svc.collectAll({
    workItemId: wi.id,
    repositories: [],
    refs: {
      commits: [{ repo: { provider: 'github', remote: 'r' }, sha: 'sha1' }],
      prs: [{ repo: { provider: 'github', remote: 'r' }, number: 1, headSha: 'sha1' }],
    },
  });

  assert.ok(collected.length >= 2);
  assert.ok(collected.some(e => e.type === 'github.ci'));
  assert.ok(collected.some(e => e.type === 'github.review'));

  // After collection, completion policy should pass
  const eval_ = svc.evaluateCompletion(wi);
  assert.equal(eval_.outcome, 'allow');
});

// ============================================================================
// Collector stamps collectorId + candidateRef
// ============================================================================

test('testGithubCiCollectorStampsCollectorIdAndCandidateRef', async () => {
  const stub: GitHubAdapter = new StubGitHubAdapter(
    { sha: 'sha-abc', conclusion: 'success', workflowRuns: [] },
    { prNumber: 1, approved: false, changesRequested: false, reviews: [] },
  );
  const collector = new GithubCiCollector(stub);
  const results = await collector.collect({
    workItemId: randomUUID(), repositories: [],
    refs: { commits: [{ repo: { provider: 'github', remote: 'r' }, sha: 'sha-abc' }] },
  });
  assert.equal(results[0].collectorId, 'github.ci');
  assert.equal(results[0].candidateRef, 'sha-abc');
});

test('testGithubReviewCollectorStampsCollectorIdAndCandidateRef', async () => {
  const stub: GitHubAdapter = new StubGitHubAdapter(
    { sha: '', conclusion: 'success', workflowRuns: [] },
    { prNumber: 7, approved: true, changesRequested: false, reviews: [] },
  );
  const collector = new GithubReviewCollector(stub);
  const results = await collector.collect({
    workItemId: randomUUID(), repositories: [],
    refs: { prs: [{ repo: { provider: 'github', remote: 'r' }, number: 7, headSha: 'pr-head-sha' }] },
  });
  assert.equal(results[0].collectorId, 'github.review');
  assert.equal(results[0].candidateRef, 'pr-head-sha');
});

test('testScopeDiffCollectorStampsCollectorIdAndCandidateRef', async () => {
  const collector = new ScopeDiffCollector(async () => ['src/a.ts'], ['src/'], []);
  const results = await collector.collect({
    workItemId: randomUUID(), repositories: [],
    refs: { prs: [{ repo: { provider: 'github', remote: 'r' }, number: 1, headSha: 'diff-head-sha' }] },
  });
  assert.equal(results[0].collectorId, 'scope_diff');
  assert.equal(results[0].candidateRef, 'diff-head-sha');
});

// ============================================================================
// Legacy permissive behavior is now explicitly DENIED (deliberate regression)
// ============================================================================

test('testPolicyDeniesExternalTypeWithNoCollectorId', () => {
  // Previously: source=github with no collectorId was accepted (permissive).
  // Now: collectorId is required for all external-only types — deny when absent.
  const policy = new CompletionPolicy();
  const evidence: Evidence[] = [{
    id: randomUUID(), workItemId: 'wi1',
    type: 'github.ci', source: 'github', status: 'passed',
    payload: {}, collectedAt: new Date().toISOString(),
    // collectorId intentionally absent
  }];
  const result = policy.evaluate([{ type: 'github.ci' }], evidence);
  assert.equal(result.outcome, 'deny', 'github.ci evidence with no collectorId must be denied');
});

test('testPolicyDeniesWhenCollectorIdDoesNotMatchRequirementType', () => {
  // github.review is a trusted collectorId, but not for github.ci requirements.
  // Cross-type mismatch must be denied.
  const policy = new CompletionPolicy();
  const evidence: Evidence[] = [{
    id: randomUUID(), workItemId: 'wi1',
    type: 'github.ci',
    source: 'github',
    collectorId: 'github.review',  // wrong collector for this type
    status: 'passed',
    payload: {}, collectedAt: new Date().toISOString(),
  }];
  const result = policy.evaluate([{ type: 'github.ci' }], evidence);
  assert.equal(result.outcome, 'deny', 'github.review collector cannot satisfy github.ci requirement');
});

test('testPolicyDeniesWhenCollectorIdIsUnknown', () => {
  const policy = new CompletionPolicy();
  const evidence: Evidence[] = [{
    id: randomUUID(), workItemId: 'wi1',
    type: 'github.ci',
    source: 'github',
    collectorId: 'unknown.collector',
    status: 'passed',
    payload: {}, collectedAt: new Date().toISOString(),
  }];
  const result = policy.evaluate([{ type: 'github.ci' }], evidence);
  assert.equal(result.outcome, 'deny', 'unknown collectorId must be denied');
});

// ============================================================================
// Persistence-level security: collector → EvidenceService → SQLite → reload → CompletionPolicy
// ============================================================================

test('testTrustFieldsSurviveDbRoundTrip', async () => {
  const db = openTestDb();
  const ws = new WorkspaceRepository(db);
  const workspace = makeWorkspace(); ws.save(workspace);
  const proj = new ProjectRepository(db); const project = makeProject(workspace.id); proj.save(project);
  const items = new WorkItemRepository(db);
  const wi = makeWorkItem(project.id, [{ type: 'github.ci', candidateRef: 'sha-round-trip' }]);
  items.save(wi);

  const stub: GitHubAdapter = new StubGitHubAdapter(
    { sha: 'sha-round-trip', conclusion: 'success', workflowRuns: [] },
    { prNumber: 1, approved: false, changesRequested: false, reviews: [] },
  );
  const svc = new EvidenceService(db, [new GithubCiCollector(stub)]);

  // Collect via collector (stamps collectorId + candidateRef)
  await svc.collectAll({
    workItemId: wi.id, repositories: [],
    refs: { commits: [{ repo: { provider: 'github', remote: 'r' }, sha: 'sha-round-trip' }] },
  });

  // Reload from DB and evaluate — collectorId and candidateRef must survive
  const eval_ = svc.evaluateCompletion(wi);
  assert.equal(eval_.outcome, 'allow', 'trusted evidence must satisfy requirement after DB round-trip');
});

test('testPersistedEvidenceWithNoCollectorIdDenied', () => {
  // Simulate legacy evidence in the DB that has no collectorId (pre-migration rows).
  const db = openTestDb();
  const ws = new WorkspaceRepository(db);
  const workspace = makeWorkspace(); ws.save(workspace);
  const proj = new ProjectRepository(db); const project = makeProject(workspace.id); proj.save(project);
  const items = new WorkItemRepository(db);
  const wi = makeWorkItem(project.id, [{ type: 'github.ci' }]);
  items.save(wi);

  const svc = new EvidenceService(db);
  // Record with no collectorId — simulates old unattributed evidence
  svc.record({ workItemId: wi.id, type: 'github.ci', source: 'github', status: 'passed', payload: {} });

  const eval_ = svc.evaluateCompletion(wi);
  assert.equal(eval_.outcome, 'deny', 'evidence with no collectorId must not satisfy external-only requirement');
});

test('testShaACannotSatisfyShaBAfterPersistence', async () => {
  const db = openTestDb();
  const ws = new WorkspaceRepository(db);
  const workspace = makeWorkspace(); ws.save(workspace);
  const proj = new ProjectRepository(db); const project = makeProject(workspace.id); proj.save(project);
  const items = new WorkItemRepository(db);
  const wi = makeWorkItem(project.id, [{ type: 'github.ci', candidateRef: 'sha-B' }]);
  items.save(wi);

  const stub: GitHubAdapter = new StubGitHubAdapter(
    { sha: 'sha-A', conclusion: 'success', workflowRuns: [] },
    { prNumber: 1, approved: false, changesRequested: false, reviews: [] },
  );
  const svc = new EvidenceService(db, [new GithubCiCollector(stub)]);

  // Collect evidence for sha-A
  await svc.collectAll({
    workItemId: wi.id, repositories: [],
    refs: { commits: [{ repo: { provider: 'github', remote: 'r' }, sha: 'sha-A' }] },
  });

  // Requirement is pinned to sha-B — sha-A evidence must not satisfy it
  const eval_ = svc.evaluateCompletion(wi);
  assert.equal(eval_.outcome, 'deny', 'sha-A evidence must not satisfy a sha-B requirement after persistence');
});

test('testManuallyPostedEvidenceCannotSatisfyGithubCiRequirement', () => {
  // Manually posted evidence gets source=api:manual, no collectorId.
  // It must never satisfy an external-only requirement.
  const db = openTestDb();
  const ws = new WorkspaceRepository(db);
  const workspace = makeWorkspace(); ws.save(workspace);
  const proj = new ProjectRepository(db); const project = makeProject(workspace.id); proj.save(project);
  const items = new WorkItemRepository(db);
  const wi = makeWorkItem(project.id, [{ type: 'github.ci' }]);
  items.save(wi);

  const svc = new EvidenceService(db);
  // This is what the POST /work/:id/evidence handler does after our fix:
  svc.record({ workItemId: wi.id, type: 'github.ci', source: 'api:manual', status: 'passed', payload: {} });

  const eval_ = svc.evaluateCompletion(wi);
  assert.equal(eval_.outcome, 'deny', 'manually submitted evidence must not satisfy github.ci requirement');
});
