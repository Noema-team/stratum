import { test } from 'node:test';
import { strict as assert } from 'assert';
import {
  WorkspaceSchema,
  ProjectSchema,
  RepositorySchema,
  ObjectiveSchema,
  WorkItemSchema,
  WorkItemStateEnum,
  StepExecutionSchema,
  DecisionSchema,
  EvidenceSchema,
  DomainEventSchema,
  PolicyConfigSchema,
  PolicyEvaluationSchema,
  isWorkItemTerminal,
  isStepExecutionTerminal,
} from '../src/domain/index.js';

const WS_ID = '00000000-0000-0000-0000-000000000001';
const PROJ_ID = '00000000-0000-0000-0000-000000000002';
const REPO_ID = '00000000-0000-0000-0000-000000000003';
const OBJ_ID = '00000000-0000-0000-0000-000000000004';
const WI_ID = '00000000-0000-0000-0000-000000000005';
const SE_ID = '00000000-0000-0000-0000-000000000006';
const DEC_ID = '00000000-0000-0000-0000-000000000007';
const EV_ID = '00000000-0000-0000-0000-000000000008';
const NOW = new Date().toISOString();

// ============================================================================
// Workspace
// ============================================================================

test('testWorkspaceValid', () => {
  const result = WorkspaceSchema.safeParse({ id: WS_ID, name: 'Magnor', createdAt: NOW });
  assert(result.success, 'valid workspace should parse');
});

test('testWorkspaceRejectsInvalidUUID', () => {
  const result = WorkspaceSchema.safeParse({ id: 'not-a-uuid', name: 'X', createdAt: NOW });
  assert(!result.success, 'bad UUID should fail');
});

test('testWorkspaceRejectsEmptyName', () => {
  const result = WorkspaceSchema.safeParse({ id: WS_ID, name: '', createdAt: NOW });
  assert(!result.success, 'empty name should fail');
});

test('testWorkspaceRoundTrip', () => {
  const ws = { id: WS_ID, name: 'Magnor', createdAt: NOW };
  const parsed = WorkspaceSchema.parse(ws);
  assert.deepEqual(parsed, ws);
});

// ============================================================================
// Project
// ============================================================================

test('testProjectValid', () => {
  const result = ProjectSchema.safeParse({
    id: PROJ_ID, workspaceId: WS_ID, name: 'Stratum',
    status: 'active', priority: 1, createdAt: NOW, updatedAt: NOW,
  });
  assert(result.success, 'valid project should parse');
});

test('testProjectRejectsInvalidStatus', () => {
  const result = ProjectSchema.safeParse({
    id: PROJ_ID, workspaceId: WS_ID, name: 'Stratum',
    status: 'running', priority: 1, createdAt: NOW, updatedAt: NOW,
  });
  assert(!result.success, 'invalid status should fail');
});

test('testProjectRejectsNegativePriority', () => {
  const result = ProjectSchema.safeParse({
    id: PROJ_ID, workspaceId: WS_ID, name: 'Stratum',
    status: 'active', priority: -1, createdAt: NOW, updatedAt: NOW,
  });
  assert(!result.success, 'negative priority should fail');
});

test('testProjectOptionalDescription', () => {
  const result = ProjectSchema.safeParse({
    id: PROJ_ID, workspaceId: WS_ID, name: 'Stratum',
    status: 'active', priority: 0, createdAt: NOW, updatedAt: NOW,
    description: 'Control plane',
  });
  assert(result.success && result.data.description === 'Control plane');
});

// ============================================================================
// Repository
// ============================================================================

test('testRepositoryValid', () => {
  const result = RepositorySchema.safeParse({
    id: REPO_ID, projectId: PROJ_ID, provider: 'github',
    remote: 'git@github.com:noema-team/stratum.git',
    defaultBranch: 'main', status: 'active',
  });
  assert(result.success, 'valid repository should parse');
});

test('testRepositoryRejectsUnknownProvider', () => {
  const result = RepositorySchema.safeParse({
    id: REPO_ID, projectId: PROJ_ID, provider: 'gitlab',
    remote: 'git@gitlab.com:x/y.git', defaultBranch: 'main', status: 'active',
  });
  assert(!result.success, 'unknown provider should fail');
});

// ============================================================================
// Objective
// ============================================================================

test('testObjectiveValid', () => {
  const result = ObjectiveSchema.safeParse({
    id: OBJ_ID, projectId: PROJ_ID,
    title: 'Fix scheduling race', description: 'Eliminate the race condition in task dispatch',
    priority: 2, status: 'active',
    constraints: [{ description: 'Must not change public API' }],
    successCriteria: [{ description: 'All race tests pass' }],
  });
  assert(result.success, 'valid objective should parse');
});

test('testObjectiveRejectsEmptyTitle', () => {
  const result = ObjectiveSchema.safeParse({
    id: OBJ_ID, projectId: PROJ_ID,
    title: '', description: 'desc',
    priority: 0, status: 'draft',
    constraints: [], successCriteria: [],
  });
  assert(!result.success, 'empty title should fail');
});

// ============================================================================
// WorkItem
// ============================================================================

const BASE_WORK_ITEM = {
  id: WI_ID, projectId: PROJ_ID, repositoryIds: [REPO_ID],
  title: 'Fix race condition', goal: 'Eliminate task dispatch race',
  workflowId: 'draft-artifact', state: 'draft' as const,
  priority: 1,
  acceptanceCriteria: [], constraints: [], requiredEvidence: [],
  dependencies: [], createdAt: NOW, updatedAt: NOW,
};

test('testWorkItemValid', () => {
  const result = WorkItemSchema.safeParse(BASE_WORK_ITEM);
  assert(result.success, 'valid work item should parse');
});

test('testWorkItemAllStates', () => {
  const states = ['draft', 'ready', 'running', 'in_review', 'completed',
                   'needs_decision', 'blocked', 'failed', 'paused', 'cancelled'];
  for (const state of states) {
    const result = WorkItemSchema.safeParse({ ...BASE_WORK_ITEM, state });
    assert(result.success, `state "${state}" should be valid`);
  }
});

test('testWorkItemRejectsUnknownState', () => {
  const result = WorkItemSchema.safeParse({ ...BASE_WORK_ITEM, state: 'queued' });
  assert(!result.success, 'unknown state should fail');
});

test('testWorkItemTerminalStates', () => {
  assert(isWorkItemTerminal('completed'));
  assert(isWorkItemTerminal('failed'));
  assert(isWorkItemTerminal('cancelled'));
  assert(!isWorkItemTerminal('running'));
  assert(!isWorkItemTerminal('paused'));
});

test('testWorkItemWithEvidenceRequirement', () => {
  const result = WorkItemSchema.safeParse({
    ...BASE_WORK_ITEM,
    requiredEvidence: [
      { type: 'github.ci', conditions: { status: 'passed' } },
      { type: 'ci_toolkit.semantic_review', conditions: { blocking_findings: 0 } },
    ],
  });
  assert(result.success, 'evidence requirements should parse');
});

// ============================================================================
// StepExecution
// ============================================================================

const BASE_STEP = {
  id: SE_ID, workItemId: WI_ID,
  workflowRunId: 'full-build-1-i1-20260829T100000Z',
  stepId: 'gather-context',
  executor: 'stratum-agent', state: 'dispatched' as const, attempt: 1,
};

test('testStepExecutionValid', () => {
  const result = StepExecutionSchema.safeParse(BASE_STEP);
  assert(result.success, 'valid step execution should parse');
});

test('testStepExecutionRejectsZeroAttempt', () => {
  const result = StepExecutionSchema.safeParse({ ...BASE_STEP, attempt: 0 });
  assert(!result.success, 'attempt 0 should fail');
});

test('testStepExecutionWithFailure', () => {
  const result = StepExecutionSchema.safeParse({
    ...BASE_STEP, state: 'failed',
    failure: { code: 'TIMEOUT', message: 'Agent timed out after 60s' },
  });
  assert(result.success, 'step with failure info should parse');
});

test('testStepExecutionTerminalStates', () => {
  assert(isStepExecutionTerminal('succeeded'));
  assert(isStepExecutionTerminal('failed'));
  assert(isStepExecutionTerminal('cancelled'));
  assert(!isStepExecutionTerminal('running'));
  assert(!isStepExecutionTerminal('dispatched'));
});

// ============================================================================
// Decision
// ============================================================================

const BASE_DECISION = {
  id: DEC_ID, projectId: PROJ_ID,
  type: 'checkpoint',
  subjectRef: { workflowRunId: 'full-build-1-i1-20260829T100000Z', stepId: 'confirm-target' },
  title: 'Confirm target scope',
  summary: 'The agent has identified the target group as auth-service. Please confirm.',
  options: [
    { id: 'confirm', label: 'Confirm' },
    { id: 'redirect', label: 'Redirect to payments-service' },
  ],
  impact: 'medium' as const, reversibility: 'easy' as const, urgency: 'blocking' as const,
  status: 'pending' as const,
};

test('testDecisionValid', () => {
  const result = DecisionSchema.safeParse(BASE_DECISION);
  assert(result.success, 'valid decision should parse');
});

test('testDecisionCustomType', () => {
  const result = DecisionSchema.safeParse({ ...BASE_DECISION, type: 'custom.approval.deploy' });
  assert(result.success, 'custom string type should be allowed');
});

test('testDecisionRejectsEmptyOptions', () => {
  const result = DecisionSchema.safeParse({ ...BASE_DECISION, options: [] });
  assert(!result.success, 'empty options should fail');
});

test('testDecisionWithResolution', () => {
  const result = DecisionSchema.safeParse({
    ...BASE_DECISION,
    status: 'resolved',
    resolution: { selectedOptionId: 'confirm', resolvedAt: NOW },
  });
  assert(result.success, 'resolved decision should parse');
});

test('testDecisionSubjectRefRequiresAtLeastOne', () => {
  const result = DecisionSchema.safeParse({ ...BASE_DECISION, subjectRef: {} });
  assert(!result.success, 'empty subjectRef should fail');
});

// ============================================================================
// Evidence
// ============================================================================

test('testEvidenceValid', () => {
  const result = EvidenceSchema.safeParse({
    id: EV_ID, workItemId: WI_ID,
    type: 'github.ci', source: 'github-actions',
    subjectRef: 'sha:abc123',
    status: 'passed',
    payload: { conclusion: 'success', workflow: 'ci.yml' },
    collectedAt: NOW,
  });
  assert(result.success, 'valid evidence should parse');
});

test('testEvidenceRejectsInvalidStatus', () => {
  const result = EvidenceSchema.safeParse({
    id: EV_ID, workItemId: WI_ID,
    type: 'github.ci', source: 'github-actions',
    status: 'unknown', payload: {}, collectedAt: NOW,
  });
  assert(!result.success, 'invalid status should fail');
});

test('testEvidencePayloadCanBeComplex', () => {
  const result = EvidenceSchema.safeParse({
    id: EV_ID, workItemId: WI_ID,
    type: 'ci_toolkit.semantic_review', source: 'ci-toolkit',
    status: 'passed',
    payload: { blocking_findings: 0, warnings: ['unused import'], score: 9.5 },
    collectedAt: NOW,
  });
  assert(result.success, 'complex payload should parse');
});

// ============================================================================
// DomainEvent
// ============================================================================

test('testDomainEventValid', () => {
  const result = DomainEventSchema.safeParse({
    id: '00000000-0000-0000-0000-000000000009',
    schemaVersion: 1,
    type: 'work.state_changed',
    workspaceId: WS_ID, projectId: PROJ_ID, workItemId: WI_ID,
    occurredAt: NOW,
    payload: { from: 'ready', to: 'running' },
  });
  assert(result.success, 'valid domain event should parse');
});

test('testDomainEventRejectsWrongSchemaVersion', () => {
  const result = DomainEventSchema.safeParse({
    id: '00000000-0000-0000-0000-000000000009',
    schemaVersion: 2,
    type: 'work.created',
    workspaceId: WS_ID,
    occurredAt: NOW,
    payload: {},
  });
  assert(!result.success, 'schema version other than 1 should fail');
});

test('testDomainEventOptionalProjectAndWorkItem', () => {
  const result = DomainEventSchema.safeParse({
    id: '00000000-0000-0000-0000-000000000009',
    schemaVersion: 1,
    type: 'project.created',
    workspaceId: WS_ID,
    occurredAt: NOW,
    payload: { name: 'Stratum' },
  });
  assert(result.success, 'event without projectId/workItemId should parse');
});

// ============================================================================
// PolicyConfig + PolicyEvaluation
// ============================================================================

test('testPolicyConfigValid', () => {
  const result = PolicyConfigSchema.safeParse({
    projectId: PROJ_ID,
    merge: { humanApproval: true },
    agentPermissions: { pushBranch: 'allowed', createPr: 'allowed', merge: 'denied' },
    defaultBudget: { maxAttempts: 3, maxCostUsd: 5 },
  });
  assert(result.success, 'valid policy config should parse');
});

test('testPolicyEvaluationAllow', () => {
  const result = PolicyEvaluationSchema.safeParse({ outcome: 'allow', reason: 'Within budget' });
  assert(result.success, 'allow outcome should parse');
});

test('testPolicyEvaluationRequireDecision', () => {
  const result = PolicyEvaluationSchema.safeParse({
    outcome: 'require_decision', reason: 'Major dependency upgrade', decisionType: 'policy.escalation',
  });
  assert(result.success, 'require_decision outcome should parse');
});

test('testPolicyEvaluationRejectsInvalidOutcome', () => {
  const result = PolicyEvaluationSchema.safeParse({ outcome: 'maybe', reason: 'unsure' });
  assert(!result.success, 'invalid outcome should fail');
});
