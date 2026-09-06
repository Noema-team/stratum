// D.3d — shared, non-production harness used by BOTH Layer A (tests/d3d-
// behavioral-qualification.test.ts, scripted/deterministic) and Layer B
// (scripts/eval-define-work.ts, live-provider). Nothing here is imported by
// any production module — it exists only to observe a define-work
// WorkflowRun (which steps ran, what verdict/route each review declared,
// whether repository inspection actually happened) and to judge the result
// against fixed, scenario-specific deterministic assertions, without
// judging a run with the same model that produced it.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { strict as assert } from 'node:assert';

import { ContextManager, DEFAULT_CONFIG } from '../../../src/context-manager.js';
import { AgentRunner } from '../../../src/agent-runner.js';
import { AgentStepRunner } from '../../../src/execution/agent-step-runner.js';
import { StratumAgentAdapter } from '../../../src/execution/stratum-agent-adapter.js';
import { ExecutorRegistry } from '../../../src/execution/registry.js';
import { Scheduler } from '../../../src/scheduler/scheduler.js';
import { ResumeService } from '../../../src/services/resume-service.js';
import { openDatabase } from '../../../src/storage/database.js';
import {
  ArtifactRepository, WorkspaceRepository, ProjectRepository, ObjectiveRepository,
  WorkItemRepository, WorkflowRunRepository, DecisionRepository,
} from '../../../src/storage/repositories.js';
import type { WorkflowEngineDeps, WorkflowEngineOptions } from '../../../src/workflow/engine.js';
import type { StepRunner, StepRunContext, StepRunOutcome, WorkflowStep } from '../../../src/workflow/types.js';
import type { ILLMProvider, LLMCompletionParams, LLMCompletionResult } from '../../../src/llm-provider.js';
import type { Objective } from '../../../src/domain/index.js';
import type { ObjectiveIntent, FixtureFile } from './fixtures.js';
import { materializeFixtureRepo } from './fixtures.js';

// ============================================================================
// RecordingStepRunner — captures the exact step/verdict/route trace of a run,
// independent of whether the underlying StepRunner is driven by a scripted
// provider (Layer A) or a real one (Layer B).
// ============================================================================

export interface RecordedStep {
  stepId: string;
  success: boolean;
  reviewVerdict?: 'pass' | 'fail';
  reviewRoute?: string;
  artifactsWritten: string[];
  error?: string;
}

export class RecordingStepRunner implements StepRunner {
  readonly steps: RecordedStep[] = [];
  constructor(private readonly inner: StepRunner) {}

  async run(step: WorkflowStep, ctx: StepRunContext): Promise<StepRunOutcome> {
    const result = await this.inner.run(step, ctx);
    this.steps.push({
      stepId: step.id,
      success: result.success,
      reviewVerdict: result.reviewVerdict,
      reviewRoute: result.reviewRoute,
      artifactsWritten: result.artifacts_written,
      error: result.error,
    });
    return result;
  }
}

// ============================================================================
// RecordingProvider — wraps any ILLMProvider (scripted or real) to count
// single-turn vs multi-turn calls and how many multi-turn calls actually
// used a tool (a real repository-inspection round trip), without changing
// behavior. Mirrors DynamicLLMProvider's own pattern of only exposing
// completeMultiTurn when the wrapped provider genuinely supports it.
// ============================================================================

export class RecordingProvider implements ILLMProvider {
  singleTurnCalls = 0;
  multiTurnCalls = 0;
  toolUseRoundTrips = 0;

  constructor(private readonly inner: ILLMProvider) {
    const innerAny = inner as unknown as { completeMultiTurn?: (params: unknown) => Promise<{ tool_uses?: unknown[] }> };
    if (typeof innerAny.completeMultiTurn === 'function') {
      (this as unknown as { completeMultiTurn: (params: unknown) => Promise<unknown> }).completeMultiTurn =
        async (params: unknown) => {
          this.multiTurnCalls++;
          const result = await innerAny.completeMultiTurn!(params);
          if (result?.tool_uses && result.tool_uses.length > 0) this.toolUseRoundTrips++;
          return result;
        };
    }
  }

  async complete(params: LLMCompletionParams): Promise<LLMCompletionResult> {
    this.singleTurnCalls++;
    return this.inner.complete(params);
  }
}

// ============================================================================
// Trace + oracle
// ============================================================================

export interface ArtifactSummary {
  type: string;
  ref: string;
  path: string;
  hash: string;
}

export interface DecisionSummary {
  id: string;
  title: string;
  summary: string;
  options: Array<{ id: string; label: string; description: string }>;
  selectedOptionId?: string;
}

export type ScenarioId = 'early' | 'partial' | 'mature';

export interface DefineWorkTrace {
  scenarioId: ScenarioId;
  workflowRunId: string;
  finalStatus: 'complete' | 'halted';
  finalStepId: string | null;
  error?: string;
  iterationsUsed: number;
  steps: RecordedStep[];
  decisions: DecisionSummary[];
  artifacts: ArtifactSummary[];
  definitionText: string;
  readinessText: string | null;
  explorationNeedText: string | null;
  toolUseRoundTrips: number;
  noExtraWorkItemsCreated: boolean;
}

export interface OracleCheck {
  name: string;
  pass: boolean;
  detail?: string;
}

export interface OracleResult {
  scenarioId: ScenarioId;
  checks: OracleCheck[];
  pass: boolean;
}

// Extracts one fact's block (`- id: <factId>` up to the next `- id:` or end
// of text) from a Definition's rendered fact-ledger text — the same
// convention used throughout the D.3c1a/D.3c1b test suites.
export function extractFactBlock(text: string, factId: string): string {
  const m = text.match(new RegExp(`- id: ${factId}[\\s\\S]*?(?=\\n- id: |$)`));
  return m ? m[0] : '';
}

function check(name: string, pass: boolean, detail?: string): OracleCheck {
  return { name, pass, detail };
}

const REVIEW_STEP_IDS = ['definition-readiness-review', 'post-defer-readiness-review', 'post-human-readiness-review'];

function reviewSteps(trace: DefineWorkTrace): RecordedStep[] {
  return trace.steps.filter((s) => REVIEW_STEP_IDS.includes(s.stepId));
}

export function oracleEarly(trace: DefineWorkTrace): OracleResult {
  const reviews = reviewSteps(trace);
  const firstReview = reviews[0];
  const refineIdx = trace.steps.findIndex((s) => s.reviewRoute === 'refine');
  const escalationIdx = trace.steps.findIndex((s) => s.reviewRoute === 'human' || s.reviewRoute === 'explore');
  const networkingFact = extractFactBlock(trace.definitionText, 'networking-layer')
    || extractFactBlock(trace.definitionText, 'networking');
  const resolvedDecision = trace.decisions.find((d) => d.selectedOptionId);

  const checks: OracleCheck[] = [
    check('initial review is not pass', firstReview?.reviewVerdict === 'fail',
      `first review (${firstReview?.stepId}) verdict=${firstReview?.reviewVerdict}`),
    check('a CAN_RESOLVE (refine) round occurs before human/explore escalation',
      refineIdx !== -1 && (escalationIdx === -1 || refineIdx < escalationIdx),
      `refineIdx=${refineIdx} escalationIdx=${escalationIdx}`),
    check('repository investigation actually occurred (a tool-use round trip)',
      trace.toolUseRoundTrips >= 1, `toolUseRoundTrips=${trace.toolUseRoundTrips}`),
    check('the networking fact is KNOWN with repository/investigation provenance, not guessed',
      /status: KNOWN/.test(networkingFact) && /source: (repository|investigation)/.test(networkingFact),
      networkingFact || '(no networking fact block found)'),
    check('a real Decision exists for the product/platform-scope question',
      trace.decisions.length >= 1, `decisions=${trace.decisions.length}`),
    check('the human question was not merely a repository lookup',
      !trace.decisions.some((d) => /already have networking|networking code|does the repository/i.test(d.title)),
      trace.decisions.map((d) => d.title).join(' | ')),
    check('the resolved Decision\'s real id is referenced in the Definition',
      !resolvedDecision || trace.definitionText.includes(resolvedDecision.id),
      resolvedDecision ? `decision ${resolvedDecision.id}` : '(no decision resolved)'),
    check('an exploration-need Artifact exists for the empirical latency/feasibility question',
      trace.explorationNeedText !== null && /latency|frame budget|feasib/i.test(trace.explorationNeedText ?? ''),
      trace.explorationNeedText?.slice(0, 120) ?? '(none)'),
    check('exploration-need Artifact is recorded in provenance',
      trace.artifacts.some((a) => a.type === 'exploration-need'),
      trace.artifacts.map((a) => a.type).join(', ')),
    check('no exploration WorkItem/WorkProposal was created or applied',
      trace.noExtraWorkItemsCreated && !trace.artifacts.some((a) => a.type === 'work-item' || a.type === 'work-proposal'),
      `noExtraWorkItemsCreated=${trace.noExtraWorkItemsCreated}`),
    check('the run never declared verdict:pass (a genuinely early request must not pass merely because a plausible draft exists)',
      !trace.steps.some((s) => s.reviewVerdict === 'pass'), ''),
    check('the run terminates cleanly (commit), with the empirical blocker preserved rather than the run hanging/erroring',
      trace.finalStatus === 'complete' && trace.finalStepId === 'commit', `status=${trace.finalStatus} step=${trace.finalStepId}`),
  ];

  return { scenarioId: 'early', checks, pass: checks.every((c) => c.pass) };
}

export function oraclePartial(trace: DefineWorkTrace): OracleResult {
  const combatFact = extractFactBlock(trace.definitionText, 'combat-out-of-scope')
    || extractFactBlock(trace.definitionText, 'combat');
  const checks: OracleCheck[] = [
    check('supplied product facts (faction/loyalty/dialogue/trade) remain represented',
      ['faction', 'loyalty', 'dialogue', 'trade'].every((kw) => new RegExp(kw, 'i').test(trace.definitionText)),
      ''),
    check('combat remains an explicit non-goal/boundary',
      /combat/i.test(trace.definitionText) && /(non-?goal|out of scope|must_not|must not)/i.test(trace.definitionText),
      ''),
    check('no unnecessary Decision was created', trace.decisions.length === 0, `decisions=${trace.decisions.length}`),
    check('no unnecessary exploration Artifact was created', trace.explorationNeedText === null, ''),
    check('iteration count stays low (<=2)', trace.iterationsUsed <= 2, `iterationsUsed=${trace.iterationsUsed}`),
    check('the run reaches a clean commit', trace.finalStatus === 'complete' && trace.finalStepId === 'commit',
      `status=${trace.finalStatus} step=${trace.finalStepId}`),
    check('an authoritative supplied fact is not silently weakened to ASSUMED',
      combatFact === '' || !/status: ASSUMED/.test(combatFact), combatFact),
  ];
  return { scenarioId: 'partial', checks, pass: checks.every((c) => c.pass) };
}

export function oracleMature(trace: DefineWorkTrace): OracleResult {
  const reviews = reviewSteps(trace);
  const checks: OracleCheck[] = [
    check('iterations = 1', trace.iterationsUsed === 1, `iterationsUsed=${trace.iterationsUsed}`),
    check('no Decision was created', trace.decisions.length === 0, `decisions=${trace.decisions.length}`),
    check('no exploration Artifact was created', trace.explorationNeedText === null, ''),
    check('no DEFER route was taken', !trace.steps.some((s) => s.reviewRoute === 'defer'), ''),
    check('readiness passes on Definition v1 (exactly one review, verdict pass)',
      reviews.length === 1 && reviews[0]?.reviewVerdict === 'pass',
      `reviews=${reviews.map((r) => `${r.stepId}:${r.reviewVerdict}`).join(',')}`),
    check('the run completes through commit', trace.finalStatus === 'complete' && trace.finalStepId === 'commit',
      `status=${trace.finalStatus} step=${trace.finalStepId}`),
  ];
  return { scenarioId: 'mature', checks, pass: checks.every((c) => c.pass) };
}

export function runOracle(trace: DefineWorkTrace): OracleResult {
  switch (trace.scenarioId) {
    case 'early': return oracleEarly(trace);
    case 'partial': return oraclePartial(trace);
    case 'mature': return oracleMature(trace);
  }
}

// ============================================================================
// Small helpers shared by both layers for reading final artifacts off disk.
// ============================================================================

export async function readIfExists(root: string, relPath: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(root, relPath), 'utf-8');
  } catch {
    return null;
  }
}

// ============================================================================
// driveDefineWorkRun — the ONE orchestration path both layers use: seeds a
// fresh control plane, dispatches the real DEFINE_WORK workflow through the
// real production components (StratumAgentAdapter, Scheduler, ResumeService,
// ArtifactRepository), and loops checkpoint resolution until the run
// terminates. The only thing that differs between Layer A and Layer B is
// the `provider` passed in — a scripted DualModeProvider for Layer A, or
// the real provider resolveLLMProvider() returns for Layer B. Neither layer
// re-implements this orchestration itself.
// ============================================================================

export interface DriveOptions {
  scenarioId: ScenarioId;
  root: string;
  fixtureFiles: FixtureFile[];
  objectiveIntent: ObjectiveIntent;
  provider: ILLMProvider;
  /**
   * Called for each pending Decision the run raises. Return the resolution
   * to apply, or `undefined` to refuse resolving it (the run is left
   * halted — used when no legitimate option represents the scenario's
   * intended choice, which is itself a qualification failure worth
   * surfacing rather than guessing).
   */
  resolveDecision: (
    options: Array<{ id: string; label: string; description?: string }>,
    decision: DecisionSummary,
  ) => { selectedOptionId: string; rationale: string } | undefined;
  /** Safety bound on repeated-checkpoint rounds — never loop forever on a misbehaving model. */
  maxCheckpointRounds?: number;
}

export async function driveDefineWorkRun(opts: DriveOptions): Promise<DefineWorkTrace> {
  const { scenarioId, root, fixtureFiles, objectiveIntent, provider: rawProvider, resolveDecision } = opts;
  const maxCheckpointRounds = opts.maxCheckpointRounds ?? 5;

  await materializeFixtureRepo(root, fixtureFiles);

  const workItemId = `wi-d3d-${scenarioId}`;
  const workspaceId = `ws-d3d-${scenarioId}-${randomUUID()}`;
  const definitionPath = `.sle/work/${workItemId}/definition.md`;
  const readinessPath = `.sle/work/${workItemId}/readiness.md`;
  const explorationPath = `.sle/work/${workItemId}/exploration-need.md`;

  const db = openDatabase(':memory:');
  const now = new Date().toISOString();
  new WorkspaceRepository(db).save({ id: workspaceId, name: 'ws', createdAt: now });
  const projectId = `proj-${workspaceId}`;
  new ProjectRepository(db).save({
    id: projectId, workspaceId, name: 'proj', status: 'active', priority: 0, createdAt: now, updatedAt: now,
  });
  const objective: Objective = {
    id: randomUUID(), projectId,
    title: objectiveIntent.title, description: objectiveIntent.description,
    priority: 0, status: 'active',
    constraints: objectiveIntent.constraints, successCriteria: objectiveIntent.successCriteria,
    createdAt: now, updatedAt: now,
  };
  new ObjectiveRepository(db).save(objective);
  new WorkItemRepository(db).save({
    id: workItemId, projectId, objectiveId: objective.id, repositoryIds: [],
    title: objective.title, goal: objective.title, workflowId: 'define-work',
    state: 'ready', priority: 0,
    acceptanceCriteria: [], constraints: [], requiredEvidence: [],
    dependencies: [], createdAt: now, updatedAt: now,
  });
  const artifacts = new ArtifactRepository(db);

  const provider = new RecordingProvider(rawProvider);
  const cm = new ContextManager(root, DEFAULT_CONFIG);
  const runArtifactsStub = {
    async writeNodeOutput() {}, async updateNodeStatus() {}, async createRunDir() {}, async createManifest() {},
  } as any;
  const agentRunner = new AgentRunner(cm, provider, root, runArtifactsStub, { model: 'test' }, undefined, artifacts);
  const recordingStepRunner = new RecordingStepRunner(new AgentStepRunner(agentRunner));
  const engineDeps: WorkflowEngineDeps = {
    stepRunner: recordingStepRunner,
    mapManager: { read: async () => ({ artifacts: [] }), update: async () => {} } as any,
    runArtifacts: runArtifactsStub,
    projectRoot: root,
    workflowRunRepository: new WorkflowRunRepository(db),
  };
  const engineOpts: WorkflowEngineOptions = { onCheckpoint: async () => 'halt' };
  const adapter = new StratumAgentAdapter(engineDeps, engineOpts, artifacts);
  const registry = new ExecutorRegistry();
  registry.register(adapter);

  const workItemRepo = new WorkItemRepository(db);
  const workItemCountBefore = workItemRepo.listAllByState('ready').length + workItemRepo.listAllByState('running').length;

  const scheduler = new Scheduler(db, workspaceId, registry);
  const dispatch = await scheduler.tick();
  assert.equal(dispatch[0]?.outcome, 'dispatched', `initial dispatch failed: ${JSON.stringify(dispatch[0])}`);
  const workflowRunId = dispatch[0].workflowRunId!;

  const decisionRepo = new DecisionRepository(db);
  const resumeService = new ResumeService(db, workspaceId, registry);

  let rounds = 0;
  let pending = decisionRepo.listByWorkItem(workItemId).find((d) => d.status === 'pending');
  while (pending && rounds < maxCheckpointRounds) {
    rounds++;
    const decisionSummary: DecisionSummary = {
      id: pending.id, title: pending.title, summary: pending.summary,
      options: (pending.options ?? []) as Array<{ id: string; label: string; description: string }>,
    };
    const resolution = resolveDecision(pending.options ?? [], decisionSummary);
    if (!resolution) break; // scenario declined to resolve — run stays halted, a qualification failure to surface, not a crash.
    await resumeService.resume(pending.id, {
      ...resolution, resolvedAt: new Date().toISOString(), resolvedBy: 'eval-harness',
    });
    pending = decisionRepo.listByWorkItem(workItemId).find((d) => d.status === 'pending');
  }

  const run = new WorkflowRunRepository(db).findById(workflowRunId)!;
  const workItemCountAfter = workItemRepo.listAllByState('ready').length + workItemRepo.listAllByState('running').length
    + workItemRepo.listAllByState('in_review').length + workItemRepo.listAllByState('needs_decision').length;

  const decisions = decisionRepo.listByWorkItem(workItemId);
  const decisionSummaries: DecisionSummary[] = decisions.map((d) => ({
    id: d.id, title: d.title, summary: d.summary,
    options: (d.options ?? []) as Array<{ id: string; label: string; description: string }>,
    selectedOptionId: d.resolution?.selectedOptionId,
  }));
  const artifactSummaries: ArtifactSummary[] = artifacts.listLatestByWorkflowRun(workflowRunId).map((a) => ({
    type: a.type, ref: a.ref ?? a.id, path: a.path ?? '', hash: a.hash ?? '',
  }));

  return {
    scenarioId,
    workflowRunId,
    finalStatus: run.status === 'complete' ? 'complete' : 'halted',
    finalStepId: run.current_step_id,
    iterationsUsed: run.iteration,
    steps: recordingStepRunner.steps,
    decisions: decisionSummaries,
    artifacts: artifactSummaries,
    definitionText: (await readIfExists(root, definitionPath)) ?? '',
    readinessText: await readIfExists(root, readinessPath),
    explorationNeedText: await readIfExists(root, explorationPath),
    toolUseRoundTrips: provider.toolUseRoundTrips,
    noExtraWorkItemsCreated: workItemCountAfter === workItemCountBefore,
  };
}
