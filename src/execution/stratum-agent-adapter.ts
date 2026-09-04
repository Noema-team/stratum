import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { WorkflowEngine } from '../workflow/engine.js';
import { getWorkflow } from '../workflow/registry.js';
import { materializeTemplate } from '../workflow/artifact-refs.js';
import { toSafeRelativePath } from '../path-safety.js';
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

  // D.3c0/D.3c0.1 — translates a checkpoint halt into the DecisionRequest(s)
  // the adapter reports. A checkpoint step with no decisionRequestArtifact
  // declared gets exactly today's synthesized generic approve/reject
  // request — byte-for-byte unchanged, including for full-build (whose
  // steps never declare this field) and any other non-opted-in checkpoint.
  //
  // A step that DOES declare one is resolved through a chain that never
  // trusts a bare path string: materialize the {workItemId}/{objectiveId}
  // placeholders, canonicalize with the same toSafeRelativePath primitive
  // agent-runner.ts/context-manager.ts already use (fail closed on any
  // '..' segment or absolute path), then require a CURRENT-RUN
  // ArtifactRecord (via the existing D.1 provenance mechanism — no new
  // Artifact type/table/FK) whose latest path for this workflowRunId
  // matches that exact canonical path, then re-hash the file's actual
  // bytes (same sha256-hex convention AgentRunner already uses for
  // provenance) and require it match that record's recorded hash. Only
  // then is the content parsed/structurally validated. Any failure along
  // this chain (unsafe path, no ArtifactRepository configured, no matching
  // current-run record, hash mismatch, missing file, malformed JSON, or a
  // structural violation) fails closed — this never silently falls back to
  // the generic approve/reject request. This proves the request came from
  // THIS run's own recorded step output, not merely a same-named file that
  // happens to exist on disk.
  private async resolveCheckpointDecisionRequests(
    request: ExecutionRequest,
    def: ReturnType<typeof getWorkflow>,
    checkpointStepId: string | null,
  ): Promise<{ decisionRequests: DecisionRequest[]; failure?: ExecutionFailureInfo }> {
    const checkpointStep = def?.steps.find((s) => s.id === checkpointStepId);
    const declaredArtifact = checkpointStep?.decisionRequestArtifact;

    if (!declaredArtifact) {
      // D.3c0.1 — this exact title/summary is what Scheduler/ResumeService
      // have always shown a human for a generic checkpoint (previously
      // hardcoded at the Decision-creation call site; now Scheduler takes
      // title/summary/options uniformly from this DecisionRequest instead —
      // see scheduler.ts). Keeping the text here, byte-for-byte, is what
      // makes that unification a no-op for every non-opt-in checkpoint.
      return {
        decisionRequests: [{
          type: 'checkpoint',
          title: 'Workflow reached a checkpoint',
          summary: `Workflow '${request.workflowId}' paused at step '${checkpointStepId ?? 'unknown'}' and requires operator approval to continue.`,
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

    // D.3c0.1 — canonicalize before any join/read. materializeTemplate only
    // substitutes placeholders; it performs no path-safety validation of
    // its own, so a declared '../decision-request.json' or a
    // '{workItemId}' value crafted to contain '..' must still be rejected
    // here, the same way agent-runner.ts's declared-output paths are.
    const canonical = toSafeRelativePath(materialized.value);
    if (canonical === null) {
      return {
        decisionRequests: [],
        failure: {
          code: 'invalid_decision_request',
          message: `Declared decisionRequestArtifact '${materialized.value}' is not a safe project-root-relative path`,
        },
      };
    }

    // D.3c0.1 — a dynamic DecisionRequest can only be provenance-verified
    // against the current WorkflowRun's own recorded Artifacts. A static
    // checkpoint never reaches this branch and remains usable without one.
    if (!this.artifactRepository) {
      return {
        decisionRequests: [],
        failure: {
          code: 'missing_decision_request_provenance',
          message: 'No ArtifactRepository configured — a dynamic decisionRequestArtifact cannot be provenance-verified',
        },
      };
    }

    const currentRunArtifact = this.artifactRepository
      .listLatestByWorkflowRun(request.workflowRunId)
      .find((a) => a.path === canonical);
    if (!currentRunArtifact || !currentRunArtifact.hash) {
      return {
        decisionRequests: [],
        failure: {
          code: 'missing_decision_request',
          message: `No current-run Artifact record found for declared decisionRequestArtifact '${canonical}' — a pre-existing file at this path is not sufficient provenance`,
        },
      };
    }

    const projectRoot = this.engineDeps.projectRoot ?? process.cwd();
    const absPath = path.join(projectRoot, canonical);
    let raw: string;
    try {
      raw = await fs.readFile(absPath, 'utf-8');
    } catch (err) {
      return {
        decisionRequests: [],
        failure: {
          code: 'missing_decision_request',
          message: `Declared decisionRequestArtifact '${canonical}' could not be read: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }

    const actualHash = createHash('sha256').update(raw).digest('hex');
    if (actualHash !== currentRunArtifact.hash) {
      return {
        decisionRequests: [],
        failure: {
          code: 'decision_request_hash_mismatch',
          message: `Declared decisionRequestArtifact '${canonical}' content does not match the current-run Artifact record's recorded hash`,
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
