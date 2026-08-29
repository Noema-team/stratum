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

export function testPolicyAllowsWhenNoRequirements() {
  const policy = new CompletionPolicy();
  const result = policy.evaluate([], []);
  assert.equal(result.outcome, 'allow');
}

export function testPolicyDeniesWhenEvidenceMissing() {
  const policy = new CompletionPolicy();
  const result = policy.evaluate(
    [{ type: 'github.ci' }],
    [],
  );
  assert.equal(result.outcome, 'deny');
  assert.ok(result.reason.includes('github.ci'));
}

export function testPolicyAllowsWhenEvidencePassed() {
  const policy = new CompletionPolicy();
  const evidence: Evidence[] = [{
    id: randomUUID(), workItemId: 'wi1',
    type: 'github.ci', source: 'github', status: 'passed',
    payload: {}, collectedAt: new Date().toISOString(),
  }];
  const result = policy.evaluate([{ type: 'github.ci' }], evidence);
  assert.equal(result.outcome, 'allow');
}

export function testPolicyDeniesWhenEvidenceFailed() {
  const policy = new CompletionPolicy();
  const evidence: Evidence[] = [{
    id: randomUUID(), workItemId: 'wi1',
    type: 'github.ci', source: 'github', status: 'failed',
    payload: {}, collectedAt: new Date().toISOString(),
  }];
  const result = policy.evaluate([{ type: 'github.ci' }], evidence);
  assert.equal(result.outcome, 'deny', 'failed evidence should not satisfy requirement');
}

export function testPolicyChecksConditions() {
  const policy = new CompletionPolicy();
  const evidence: Evidence[] = [{
    id: randomUUID(), workItemId: 'wi1',
    type: 'ci_toolkit.semantic_review', source: 'ci_toolkit', status: 'passed',
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
}

export function testPolicyRejectsExecutorSelfReport() {
  const policy = new CompletionPolicy();
  // Evidence sourced by the executor adapter must not satisfy github.ci requirement.
  const selfReported: Evidence[] = [{
    id: randomUUID(), workItemId: 'wi1',
    type: 'github.ci', source: 'executor', status: 'passed',
    payload: {}, collectedAt: new Date().toISOString(),
  }];
  const result = policy.evaluate([{ type: 'github.ci' }], selfReported);
  assert.equal(result.outcome, 'deny', 'executor self-report must not satisfy github.ci');
}

export function testPolicyRejectsAdapterPrefixedSource() {
  const policy = new CompletionPolicy();
  const selfReported: Evidence[] = [{
    id: randomUUID(), workItemId: 'wi1',
    type: 'github.review', source: 'adapter:stratum-agent', status: 'passed',
    payload: {}, collectedAt: new Date().toISOString(),
  }];
  const result = policy.evaluate([{ type: 'github.review' }], selfReported);
  assert.equal(result.outcome, 'deny', 'adapter-prefixed source must not satisfy github.review');
}

export function testPolicyAllowsInternalEvidenceForNonExternalTypes() {
  const policy = new CompletionPolicy();
  // 'acceptance_criteria' is not in EXTERNAL_ONLY_TYPES — can be self-reported
  const internal: Evidence[] = [{
    id: randomUUID(), workItemId: 'wi1',
    type: 'acceptance_criteria', source: 'executor', status: 'passed',
    payload: {}, collectedAt: new Date().toISOString(),
  }];
  const result = policy.evaluate([{ type: 'acceptance_criteria' }], internal);
  assert.equal(result.outcome, 'allow');
}

export function testPolicyMultipleRequirementsAllMustPass() {
  const policy = new CompletionPolicy();
  const evidence: Evidence[] = [
    { id: randomUUID(), workItemId: 'wi1', type: 'github.ci', source: 'github', status: 'passed', payload: {}, collectedAt: new Date().toISOString() },
    // Missing ci_toolkit.semantic_review
  ];
  const result = policy.evaluate(
    [{ type: 'github.ci' }, { type: 'ci_toolkit.semantic_review' }],
    evidence,
  );
  assert.equal(result.outcome, 'deny');
  assert.ok(result.reason.includes('ci_toolkit.semantic_review'));
}

// ============================================================================
// EvidenceService
// ============================================================================

export function testEvidenceServiceRecord() {
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
}

export function testEvidenceServiceEvaluateCompletion() {
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
}

export function testEvidenceServiceNoRequirementsAlwaysAllows() {
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
}

// ============================================================================
// WorkService.complete() — evidence guard integration
// ============================================================================

export function testCompleteBlockedByEvidencePolicy() {
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
}

export function testCompleteAllowedAfterEvidenceSatisfied() {
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
}

export function testCompleteWithNoRequirementsNeedsNoEvidence() {
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
}

// ============================================================================
// GithubCiCollector
// ============================================================================

export async function testGithubCiCollectorPassed() {
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
  assert.equal(results[0].subjectRef, 'abc123');
}

export async function testGithubCiCollectorFailed() {
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
}

export async function testGithubCiCollectorPending() {
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
}

// ============================================================================
// GithubReviewCollector
// ============================================================================

export async function testGithubReviewCollectorApproved() {
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
}

export async function testGithubReviewCollectorChangesRequested() {
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
}

// ============================================================================
// ScopeDiffCollector
// ============================================================================

export async function testScopeDiffWithinScope() {
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
}

export async function testScopeDiffForbiddenChange() {
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
}

export async function testScopeDiffMaterialExpansion() {
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
}

// ============================================================================
// EvidenceService.collectAll with registered collectors
// ============================================================================

export async function testEvidenceServiceCollectAll() {
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
}
