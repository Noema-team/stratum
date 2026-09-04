import { promises as fs } from 'node:fs';
import path from 'node:path';
import { WorkflowEngine } from '../workflow/engine.js';
import { getWorkflow } from '../workflow/registry.js';
import { materializeTemplate } from '../workflow/artifact-refs.js';
import type { WorkflowEngineDeps, WorkflowEngineOptions } from '../workflow/engine.js';
import type { ExecutionAdapter, ExecutionRequest, ExecutionResult, ArtifactReference, DecisionRequest, ExecutionFailureInfo, CapabilitySet, ExecutorCapability } from './types.js';
import type { ArtifactRepository } from '../storage/repositories.js';
import { resolveWorkflowInvocation } from './workflow-invocation.js';
import { getCheckpointDecisionOptions } from './checkpoint-resolver.js';
import { parseDecisionRequest } from './decision-request.js';

const STRATUM_CAPABILITIES: ReadonlySet<ExecutorCapability> = new Set<ExecutorCapability>([
  'repo.read',
  'repo.write',
  'shell',
  'tests.run',
  'long_context',
  'structured_output',
]);

// Maps an ExecutionRequest onto WorkflowEngine.run() and translates the result.
// The engineDeps/engineOpts are injected so adapters in tests can use stubs.
export class StratumAgentAdapter implements ExecutionAdapter {
  readonly id = 'stratum-agent';

  constructor(
    private readonly engineDeps: WorkflowEngineDeps,
    private readonly engineOpts: WorkflowEngineOptions,
    // D.1b — optional so existing construction sites/tests are unaffected.
    // When present, populates ExecutionResult.artifacts from declaratively-
    // recorded provenance after the run completes (see WorkflowRunResult,
    // which stays unchanged — this queries ArtifactRepository directly
    // rather than threading artifacts through the engine's return type).
    private readonly artifactRepository?: ArtifactRepository,
  ) {}

  getCapabilities(): CapabilitySet {
    return STRATUM_CAPABILITIES;
  }

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const start = Date.now();

    // Derive the entry step from the workflow definition.
    // For unknown workflows the engine's own unknown-workflow path fails closed.
    const def = getWorkflow(request.workflowId);
    const entryStepId = request.stepId !== '__start__'
      ? request.stepId
      : def?.steps[0]?.id;

    // Load frozen resolved parameters from the persisted WorkflowRun when available.
    const persistedRun = this.engineDeps.workflowRunRepository?.findById(request.workflowRunId);
    const rawParams = persistedRun?.resolvedParameters ?? request.workflowParameters;

    // Resolve workflow-specific parameter contract and cap semantics via seam.
    const invocation = resolveWorkflowInvocation(request.workflowId, rawParams);

    const mergedOpts: WorkflowEngineOptions = {
      ...this.engineOpts,
      onCapHit: invocation.onCapHit,
    };

    const engine = new WorkflowEngine(this.engineDeps, mergedOpts);
    const result = await engine.run(
      request.workflowId,
      request.workflowRunId,
      request.goal,
      entryStepId,
      request.workItemId,
      invocation.maxIterations,
      invocation.normalizedParams,
      request.objectiveId,
      request.constraints,
      request.acceptanceCriteria,
      request.objectiveContext,
      request.decisionContext,
    );

    // 'halted' without an error means the workflow is waiting at a checkpoint —
    // that is a structured 'blocked' outcome, not a failure (unless the
    // checkpoint declared a dynamic DecisionRequest that failed to resolve —
    // see resolveCheckpointDecisionRequests below, which then fails closed).
    const isCheckpoint = result.status === 'halted' && !result.error;
    const checkpoint = isCheckpoint
      ? await this.resolveCheckpointDecisionRequests(request, def, result.final_step_id)
      : { decisionRequests: [] as DecisionRequest[], failure: undefined as ExecutionFailureInfo | undefined };

    const outcome: ExecutionResult['outcome'] =
      result.status === 'complete' ? 'succeeded'
      : result.error ? 'failed'
      : checkpoint.failure ? 'failed'
      : 'blocked';

    const artifacts: ArtifactReference[] = this.artifactRepository
      ? this.artifactRepository.listLatestByWorkflowRun(request.workflowRunId).map((a) => ({
          ref: a.ref ?? a.id,
          path: a.path,
          type: a.type,
        }))
      : [];

    return {
      schemaVersion: 1,
      stepExecutionId: request.stepExecutionId,
      outcome,
      artifacts,
      evidenceClaims: [],
      checkpointStepId: (isCheckpoint && !checkpoint.failure) ? (result.final_step_id ?? undefined) : undefined,
      decisionRequests: checkpoint.decisionRequests,
      usage: { durationMs: Date.now() - start },
      failure: checkpoint.failure
        ?? (result.error ? { code: 'workflow_error', message: result.error } : undefined),
    };
  }

  // D.3c0 — translates a checkpoint halt into the DecisionRequest(s) the
  // adapter reports. A checkpoint step with no decisionRequestArtifact
  // declared gets exactly today's synthesized generic approve/reject
  // request — byte-for-byte unchanged, including for full-build (whose
  // steps never declare this field) and any other non-opted-in checkpoint.
  // A step that DOES declare one has its materialized path read and
  // structurally validated; any failure (unknown placeholder, missing
  // file, malformed JSON, or a structural violation) fails closed — this
  // never silently falls back to the generic approve/reject request.
  private async resolveCheckpointDecisionRequests(
    request: ExecutionRequest,
    def: ReturnType<typeof getWorkflow>,
    checkpointStepId: string | null,
  ): Promise<{ decisionRequests: DecisionRequest[]; failure?: ExecutionFailureInfo }> {
    const checkpointStep = def?.steps.find((s) => s.id === checkpointStepId);
    const declaredArtifact = checkpointStep?.decisionRequestArtifact;

    if (!declaredArtifact) {
      return {
        decisionRequests: [{
          type: 'checkpoint',
          title: 'Workflow paused',
          summary: `Waiting at step: ${checkpointStepId ?? 'unknown'}`,
          options: getCheckpointDecisionOptions(request.workflowId, checkpointStepId),
        }],
      };
    }

    const materialized = materializeTemplate(declaredArtifact, {
      workItemId: request.workItemId,
      objectiveId: request.objectiveId,
    });
    if (!materialized.ok) {
      return {
        decisionRequests: [],
        failure: { code: 'invalid_decision_request', message: materialized.error },
      };
    }

    const projectRoot = this.engineDeps.projectRoot ?? process.cwd();
    const absPath = path.join(projectRoot, materialized.value);
    let raw: string;
    try {
      raw = await fs.readFile(absPath, 'utf-8');
    } catch (err) {
      return {
        decisionRequests: [],
        failure: {
          code: 'missing_decision_request',
          message: `Declared decisionRequestArtifact '${materialized.value}' could not be read: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }

    const parsed = parseDecisionRequest(raw);
    if (!parsed.ok) {
      return {
        decisionRequests: [],
        failure: { code: 'invalid_decision_request', message: parsed.error },
      };
    }

    return { decisionRequests: [parsed.value] };
  }

  async cancel(_stepExecutionId: string): Promise<void> {
    // TODO: signal a running engine to halt when async execution is introduced
  }
}
