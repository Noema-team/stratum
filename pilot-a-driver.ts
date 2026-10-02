// Pilot A driver — experiment infrastructure, untracked. Mirrors the
// production composition root (application.ts createStratumApplication /
// buildAgentRunner) and the E4-H harness drive pattern, pointed at the
// dedicated pilot worktree. Preregistration: docs/pilots/pilot-a.md.
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { ContextManager, DEFAULT_CONFIG } from './src/context-manager.js';
import { resolveLLMProvider, buildAgentRunner } from './src/application.js';
import { RunArtifactManager } from './src/run-artifacts.js';
import { AgentStepRunner } from './src/execution/agent-step-runner.js';
import { FullBuildStepRunner } from './src/execution/full-build-step-runner.js';
import { StratumAgentAdapter } from './src/execution/stratum-agent-adapter.js';
import { ExecutorRegistry } from './src/execution/registry.js';
import { resolveDefinitionSource } from './src/execution/definition-source.js';
import { Scheduler } from './src/scheduler/scheduler.js';
import { ResumeService } from './src/services/resume-service.js';
import { WorkService } from './src/services/work-service.js';
import { ScopingService } from './src/scoping-service.js';
import { ConfirmService } from './src/confirm-service.js';
import { ExecService, ValidationGateService } from './src/exec-gate.js';
import { SnapshotService } from './src/snapshot-service.js';
import { SummariseService } from './src/summarise-service.js';
import { CriticAgent } from './src/critic-agent.js';
import { ShardingService } from './src/sharding-service.js';
import { LinkIndexManager } from './src/link-index.js';
import { TagService } from './src/tag-service.js';
import { RuntimeMapManagerImpl, RuntimeMapSchema, createInitialMap } from './src/runtime-map.js';
import { dump as dumpYaml, load as loadYaml } from 'js-yaml';
import { openDatabase } from './src/storage/database.js';
import {
  WorkspaceRepository, ProjectRepository, ObjectiveRepository,
  WorkItemRepository, ArtifactRepository, DecisionRepository, WorkflowRunRepository,
} from './src/storage/repositories.js';
import type { WorkflowEngineDeps } from './src/workflow/engine.js';
import type { StepRunContext } from './src/workflow/types.js';

const ROOT = '/home/theo/Documents/coding/repos/student-platform';
const EVIDENCE = '/home/theo/Documents/coding/repos/pilot-a/evidence';
const DB_PATH = path.join(ROOT, '.sle', 'stratum.db');
const WORKSPACE_ID = 'ws-pilot-a';
const PROJECT_ID = 'proj-pilot-a';
const OBJECTIVE_ID = 'obj-108';
const DEFINE_WI = 'wi-define-108';
const EXEC_WI = 'wi-exec-108';

// E27r (second merge review) — the attempt-19 edit authorization lives HERE,
// in the frozen pilot fixture (WorkItem workflowParameters → run
// resolvedParameters), never in FULL_BUILD, which must stay project-agnostic.
// Positively authorizes and requires exactly the worker main.py edit; BUILD
// alone is bound (appliesToSteps), so design/plan/test publish docs and
// tests unaffected; everything else — rag-api included — is out of scope.
const WORKER_MAIN = 'apps/ai-server/rag-worker-service/main.py';
const ATTEMPT19_EDIT_POLICY = {
  appliesToSteps: ['build'],
  allowedEditPaths: [WORKER_MAIN],
  requiredEditPaths: [WORKER_MAIN],
};

function journal(entry: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  appendFileSync(path.join(EVIDENCE, 'run-journal.jsonl'), line + '\n');
  console.log('[journal]', line);
}

function db() {
  mkdirSync(path.join(ROOT, '.sle'), { recursive: true });
  return openDatabase(DB_PATH);
}

function seed(defineWi: string) {
  mkdirSync(path.join(ROOT, '.sle'), { recursive: true });
  writeFileSync(path.join(ROOT, '.sle', 'settings.json'), JSON.stringify({
    provider: 'openrouter', model: 'z-ai/glm-5.3-flash',
    base_url: 'https://openrouter.ai/api/v1', max_tokens: 16384,
    api_key_env: 'OPENROUTER_API_KEY',
  }, null, 2));
  const mapPath = path.join(ROOT, '.sle', 'map.yaml');
  if (!existsSync(mapPath)) {
    // E17 — the seed crosses the SAME validation boundary production state
    // crosses: the written map must parse against RuntimeMapSchema, or the
    // seed fails loudly BEFORE any run depends on it. (The old
    // createInitialMap({... as never}) write let schema-invalid values
    // survive from A2 until A6's first post-step sync exposed them.)
    const seededMap = dumpYaml(createInitialMap({
      projectName: 'student-platform', projectType: 'custom',
      codeRemote: { url: 'https://github.com/magtheo/student-platform', branch: 'pilot-a/issue-108' },
      issuesRemote: { type: 'git', url: 'https://github.com/magtheo/student-platform', branch: 'main' },
      docsRemote: { url: 'https://github.com/magtheo/student-platform', pending: true },
      taskStore: { type: 'local' },
      agents: {},
    } as never));
    writeFileSync(mapPath, seededMap, 'utf-8');
    RuntimeMapSchema.parse(loadYaml(seededMap));
    journal({ event: 'map_bootstrapped', mapPath, schema_validated: true });
  }
  const d = db();
  const now = new Date().toISOString();
  const workspaces = new WorkspaceRepository(d);
  if (!workspaces.findById(WORKSPACE_ID)) {
    workspaces.save({ id: WORKSPACE_ID, name: 'pilot-a', createdAt: now });
  }
  const projects = new ProjectRepository(d);
  if (!projects.findById(PROJECT_ID)) {
    projects.save({
      id: PROJECT_ID, workspaceId: WORKSPACE_ID, name: 'student-platform',
      status: 'active', priority: 0, createdAt: now, updatedAt: now,
    });
  }
  const objectives = new ObjectiveRepository(d);
  const issue = JSON.parse(readFileSync('/tmp/opencode/pilot-a/issue-108.json', 'utf8'));
  const body: string = issue.body;
  const criteria = [...body.matchAll(/- \[ \] (.+)/g)].map(m => m[1]);
  const objective: {
    id: string; projectId: string; title: string; description: string;
    priority: number; status: string; constraints: string[]; successCriteria: string[];
    createdAt: string; updatedAt: string;
  } = {
    id: OBJECTIVE_ID, projectId: PROJECT_ID,
    title: issue.title, description: body,
    priority: 0, status: 'active',
    constraints: [], successCriteria: criteria,
    createdAt: now, updatedAt: now,
  };
  if (!objectives.findById(OBJECTIVE_ID)) {
    objectives.save(objective as never);
  }
  new WorkItemRepository(d).save({
    id: defineWi, projectId: PROJECT_ID, objectiveId: OBJECTIVE_ID, repositoryIds: [],
    title: issue.title, goal: issue.title, workflowId: 'define-work',
    state: 'ready', priority: 0,
    acceptanceCriteria: criteria, constraints: [], requiredEvidence: [],
    dependencies: [], createdAt: now, updatedAt: now,
  });
  journal({ event: 'seeded', defineWi, criteriaCount: criteria.length });
  console.log('seeded:', defineWi, '| acceptance criteria:', criteria.length);
}

// Production-shape stack over the pilot target root (single registry serves
// define-work AND full-build, exactly like createStratumApplication).
function buildStack() {
  const d = db();
  const mapManager = new RuntimeMapManagerImpl({ mapPath: path.join(ROOT, '.sle', 'map.yaml') });
  const runArtifacts = new RunArtifactManager({ projectRoot: ROOT });
  const { provider, model, maxTokens } = resolveLLMProvider(ROOT);
  journal({ event: 'provider_resolved', model, maxTokens });

  const artifactRepository = new ArtifactRepository(d);
  const decisionRepository = new DecisionRepository(d);
  const contextManager = new ContextManager(ROOT);
  const agentRunner = buildAgentRunner(
    contextManager, provider, ROOT, runArtifacts, model, artifactRepository, maxTokens, decisionRepository,
  );
  const agentStepRunner = new AgentStepRunner(agentRunner);

  const scopingService = new ScopingService(agentRunner, mapManager, ROOT, undefined, new TagService(mapManager));
  const confirmService = new ConfirmService(mapManager, runArtifacts);
  const execService = new ExecService(mapManager, runArtifacts);
  const validationGateService = new ValidationGateService(mapManager, runArtifacts);
  const snapshotService = new SnapshotService(mapManager, runArtifacts, ROOT);
  const summariseService = new SummariseService(mapManager, runArtifacts, ROOT);
  const criticAgent = new CriticAgent(provider, model);
  const shardingService = new ShardingService(ROOT, new LinkIndexManager(ROOT, mapManager));

  const callbacks = {
    onCheckpoint: async () => 'halt' as const,
    onConfirmGate: async () => 'halt' as const,
    onShardingGate: async () => 'halt' as const,
  };
  const stepRunner = new FullBuildStepRunner({
    agentStepRunner, mapManager, runArtifacts, projectRoot: ROOT,
    criticAgent, confirmService, execService, validationGateService,
    snapshotService, summariseService, shardingService, scopingService,
  }, callbacks);

  const engineDeps: WorkflowEngineDeps = {
    stepRunner, mapManager, runArtifacts, projectRoot: ROOT,
    workflowRunRepository: new WorkflowRunRepository(d),
    workItemRepository: new WorkItemRepository(d),
  };
  const adapter = new StratumAgentAdapter(engineDeps, { onCheckpoint: async () => 'halt' as const }, artifactRepository);
  const registry = new ExecutorRegistry();
  registry.register(adapter);

  const scheduler = new Scheduler(d, WORKSPACE_ID, registry);
  const resumeService = new ResumeService(d, WORKSPACE_ID, registry, {}, undefined, stepRunner);
  return { d, scheduler, resumeService, decisionRepository, artifactRepository };
}

async function drive(stack: ReturnType<typeof buildStack>, wiId: string): Promise<void> {
  const { d, scheduler, decisionRepository } = stack;
  const wiRepo = new WorkItemRepository(d);
  const runRepo = new WorkflowRunRepository(d);
  for (let round = 0; round < 40; round++) {
    const wi = wiRepo.findById(wiId)!;
    const runs = runRepo.listByWorkItem(wiId);
    const runsTerminal = runs.length > 0 && runs.every((r: { status: string }) => r.status === 'complete' || r.status === 'failed');
    if (['completed', 'failed', 'cancelled'].includes(wi.state) || runsTerminal) {
      journal({ event: 'drive_terminal', wiId, wiState: wi.state, runs: runs.map((r: { id: string; status: string; current_step_id?: string; iteration?: number }) => ({ id: r.id, status: r.status, step: r.current_step_id, iteration: r.iteration })) });
      return;
    }
    const dispatches = await scheduler.tick();
    journal({ event: 'tick', round, dispatches });
    for (const disp of dispatches) {
      if (disp.workflowRunId) {
        const run = runRepo.findById(disp.workflowRunId);
        journal({ event: 'run_status', runId: disp.workflowRunId, status: run?.status, step: run?.current_step_id, iteration: run?.iteration });
      }
    }
    const pending = decisionRepository.listByWorkItem(wiId).find(x => x.status === 'pending');
    if (pending) {
      journal({ event: 'decision_pending', decisionId: pending.id, type: pending.type, title: pending.title, summary: pending.summary, options: pending.options });
      console.log(JSON.stringify({ decisionId: pending.id, type: pending.type, title: pending.title, summary: pending.summary, options: pending.options }, null, 2));
      process.exit(3);
    }
    const fresh = runRepo.listByWorkItem(wiId);
    const stillActive = fresh.some((r: { status: string }) => r.status !== 'complete' && r.status !== 'failed');
    if (fresh.length > 0 && !stillActive) {
      // E17 — a successful workflow run parks the WI at in_review; the
      // sanctioned lifecycle transition to completed is the WorkService's own
      // guarded complete() (guards: no pending decisions + evidence policy).
      const wiNow = wiRepo.findById(wiId)!;
      if (wiNow.state === 'in_review') {
        const workService = new WorkService(d, WORKSPACE_ID);
        const done = workService.complete({ workItemId: wiId });
        journal({ event: 'wi_completed_by_driver', wiId, state: done.state });
        console.log('wi completed:', wiId);
        return;
      }
      journal({ event: 'drive_terminal', wiId, wiState: wiNow.state, runs: fresh.map((r: { id: string; status: string }) => ({ id: r.id, status: r.status })) });
      return;
    }
  }
  journal({ event: 'drive_rounds_exhausted', wiId });
  process.exit(4);
}

async function resolve(decisionId: string, optionId: string, rationale: string): Promise<void> {
  const stack = buildStack();
  journal({ event: 'decision_resolving', decisionId, optionId, rationale });
  await stack.resumeService.resume(decisionId, {
    selectedOptionId: optionId, rationale, resolvedAt: new Date().toISOString(), resolvedBy: 'operator',
  });
  journal({ event: 'decision_resumed', decisionId });
  const wiId = stack.decisionRepository.findById(decisionId)?.workItemId ?? DEFINE_WI;
  await drive(stack, wiId);
}

async function gateB(): Promise<void> {
  const d = db();
  const deps = {
    workItemRepository: new WorkItemRepository(d),
    artifactRepository: new ArtifactRepository(d),
    projectRoot: ROOT,
  };
  const defineWi = process.argv[3] ?? DEFINE_WI;
  const result = await resolveDefinitionSource({ workItemId: defineWi }, { workItemId: EXEC_WI }, deps);
  if (!result.ok) {
    journal({ event: 'gate_b_failed', code: result.failure.code, message: result.failure.message });
    console.error('GATE B FAIL:', result.failure.code, result.failure.message);
    process.exit(5);
  }
  const v = result.value;
  journal({ event: 'gate_b_resolved', sourceWorkItemId: v.sourceWorkItemId, artifactId: v.artifactId, ref: v.ref, path: v.path, sha256: v.sha256, bytes: Buffer.byteLength(v.content, 'utf-8') });

  const cm = new ContextManager(ROOT);
  const probeCtx: StepRunContext = {
    workflowRunId: 'gate-b-probe', workflowId: 'full-build', stepId: 'build', role: 'builder',
    iteration: 1, revision: 0, goal: 'implement the defined work', projectRoot: ROOT,
    workItemId: EXEC_WI, inputArtifactRefs: undefined,
    authoritativeDefinition: {
      sourceWorkItemId: v.sourceWorkItemId, artifactId: v.artifactId, ref: v.ref,
      path: v.path, sha256: v.sha256, content: v.content,
    },
  } as StepRunContext;
  const assembled = await cm.assemble('builder', probeCtx);
  journal({ event: 'gate_b_probe_assemble', token_count: assembled.token_count, hard_ceiling: DEFAULT_CONFIG.hard_ceiling, includes_definition: assembled.task.includes(v.content) });
  console.log('GATE B PASS: sha256', v.sha256.slice(0, 12), '| probe token_count', assembled.token_count, '/', DEFAULT_CONFIG.hard_ceiling, '| verbatim:', assembled.task.includes(v.content));
}

function executeWi(defineWi: string): void {
  const d = db();
  const issue = JSON.parse(readFileSync('/tmp/opencode/pilot-a/issue-108.json', 'utf8'));
  const now = new Date().toISOString();
  new WorkItemRepository(d).save({
    id: EXEC_WI, projectId: PROJECT_ID, objectiveId: OBJECTIVE_ID, repositoryIds: [],
    title: issue.title, goal: issue.title, workflowId: 'full-build',
    state: 'ready', priority: 0,
    acceptanceCriteria: [...issue.body.matchAll(/- \[ \] (.+)/g)].map((m: RegExpExecArray) => m[1]),
    constraints: [], requiredEvidence: [], dependencies: [defineWi],
    workflowParameters: {
      planning_depth: 'minimal', max_iterations: 5, on_cap_hit: 'halt',
      definitionSource: { workItemId: defineWi },
      editPolicy: ATTEMPT19_EDIT_POLICY,
    },
    createdAt: now, updatedAt: now,
  });
  journal({ event: 'execution_wi_created', wiId: EXEC_WI, defineWi, workflowParameters: { planning_depth: 'minimal', max_iterations: 5, on_cap_hit: 'halt', definitionSource: { workItemId: defineWi }, editPolicy: ATTEMPT19_EDIT_POLICY } });
  journal({ event: 'e17_driver_integrity', fixes: ['seed schema validation', 'executeWi derives definitionSource/dependencies from its argument'] });
  console.log('execution WI created:', EXEC_WI);
}

// E27r (merge review, round 2) — deterministic fixture operation for the H2
// continuation: restore attempt 18's ORIGINAL test artifact (bytes AND
// owner) into the DESTINATION run's provenance scope BEFORE its build step
// runs. Two invariants from the review:
//
//   RUN SCOPE — ownership lookup is listByWorkflowRun(ctx.workflowRunId), so
//   the restored ownership row MUST carry the attempt-19 run id. A row
//   attributed to attempt 18's run is invisible to attempt 19 and protects
//   nothing. Attempt 18's historical rows are never mutated.
//
//   ROW MATCHING — the archive legitimately holds MULTIPLE provenance rows
//   for this path (TEST's original b3b30497… AND BUILD's later replacement
//   6b026ca9…). The requirement is therefore "at least one archived row
//   whose hash exactly equals the extracted original bytes", NOT "every row
//   equals it" — the later conflicting row is preserved as evidence of what
//   attempt 18 actually did.
//
// Usage: restore-test-artifact <destinationRunId>. The destination run must
// exist and belong to the execution WorkItem (the expected continuation).
// Idempotent: re-running verifies and re-asserts.
function restoreTestArtifact(destRunId: string): void {
  if (!destRunId) {
    throw new Error('usage: restore-test-artifact <destinationRunId> — the attempt-19 workflow run id');
  }
  const A18_RUN = 'c208fc69-53ee-4670-859e-02adbe2f8ce3';
  const TEST_PATH = 'apps/ai-server/tests/integration/test_worker_failure_payload_contract.py';
  // Full preregistered sha256 of attempt 18's ORIGINAL test artifact
  // (audit-verified against the archived inline artifact AND its
  // provenance row — not merely a prefix).
  const PREREGISTERED_SHA256 = 'b3b30497bfd8b219e1458b0e53d8ce01aece9226fea6ce317a86cd535f3a41ab';
  const member = `.sle/runs/${A18_RUN}/1/node-outputs/test.md`;
  const archive = path.join(EVIDENCE, 'pilot-a10-attempt18-sle-archive.tgz');
  const raw = execFileSync('tar', ['-xzOf', archive, member], { maxBuffer: 32 * 1024 * 1024 }).toString('utf-8');
  const marker = `<<<SLE-ARTIFACT path="${TEST_PATH}">>>`;
  const start = raw.indexOf(marker);
  if (start === -1) throw new Error(`restore-test-artifact: marker for ${TEST_PATH} not found in ${member}`);
  const afterMarker = raw.slice(start + marker.length);
  const end = afterMarker.indexOf('\n<<<END-SLE-ARTIFACT>>>');
  if (end === -1) throw new Error('restore-test-artifact: close marker not found');
  // Reproduce the exact published bytes: the parser trims the block content
  // before writing, so trim here too (drops the newline after the marker
  // and the newline before the close marker).
  const content = afterMarker.slice(0, end).trim();
  const sha256 = createHash('sha256').update(content, 'utf-8').digest('hex');
  if (sha256 !== PREREGISTERED_SHA256) {
    throw new Error(`restore-test-artifact: extracted sha256 ${sha256} != preregistered ${PREREGISTERED_SHA256} — refusing`);
  }
  const d = db();
  // The destination run must exist and be the expected continuation of the
  // execution WorkItem — never a fabricated or foreign run id.
  const destRun = new WorkflowRunRepository(d).findById(destRunId);
  if (!destRun || destRun.work_item_id !== EXEC_WI || destRun.workflow_id !== 'full-build') {
    throw new Error(`restore-test-artifact: destination run '${destRunId}' does not exist as a full-build run of ${EXEC_WI} — refusing`);
  }
  // Historical rows for this path: sourced from the attempt-18 ARCHIVE DB —
  // the current pilot DB is rebuilt per attempt and deliberately carries no
  // prior history. Extract the archived DB (+ WAL) to a temp dir and open
  // read-write so SQLite recovers the WAL on open. Require at least one
  // exact match for the ORIGINAL bytes; tolerate (and preserve) the later
  // BUILD replacement row as evidence. Attempt 18's rows are read-only here.
  const tmp = mkdtempSync(join(tmpdir(), 'a18-db-'));
  let prior: Array<{ ref: string; hash: string }> = [];
  try {
    execFileSync('tar', ['-xzf', archive, '-C', tmp, '.sle/stratum.db', '.sle/stratum.db-wal']);
    const archiveDb = openDatabase(join(tmp, '.sle', 'stratum.db'));
    prior = archiveDb
      .prepare("SELECT ref, hash FROM artifacts WHERE workflow_run_id = ? AND path = ? AND ref LIKE 'produced-file:%' ORDER BY rowid")
      .all(A18_RUN, TEST_PATH) as Array<{ ref: string; hash: string }>;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  const hasOriginalRow = prior.some((r) => r.hash === sha256);
  if (prior.length === 0 || !hasOriginalRow) {
    throw new Error(`restore-test-artifact: no archived provenance row for ${TEST_PATH} matches the extracted original (${sha256}) — refusing`);
  }
  writeFileSync(path.join(ROOT, TEST_PATH), content, 'utf-8');
  // Seed E27 ownership into the DESTINATION run's scope: owned by 'test',
  // pinned to the original bytes, so attempt 19's publication boundary
  // recognizes TEST ownership when its build step runs.
  const ref = `produced-file:test:${TEST_PATH}`;
  const destRows = new ArtifactRepository(d).listByWorkflowRun(destRunId);
  const existing = destRows.find((r) => r.ref === ref);
  if (existing) {
    if (existing.hash !== sha256) {
      throw new Error(`restore-test-artifact: destination run already has ownership row ${ref} with hash ${existing.hash} != ${sha256} — refusing`);
    }
  } else {
    new ArtifactRepository(d).save({
      id: `art-test-restore-${destRunId}`,
      workItemId: EXEC_WI, workflowRunId: destRunId, stepExecutionId: undefined,
      type: 'produced-file', ref, path: TEST_PATH, hash: sha256,
      createdAt: new Date().toISOString(),
    });
  }
  journal({
    event: 'e27r_test_artifact_restored', source_run: A18_RUN, dest_run: destRunId,
    path: TEST_PATH, sha256, bytes: Buffer.byteLength(content, 'utf-8'), owner: 'test',
    provenance_ref: ref, provenance_source: "attempt18 archive db", source_rows_total: prior.length,
    source_rows_matching_original: prior.filter((r) => r.hash === sha256).length,
    disk_bytes: Buffer.byteLength(content, 'utf-8'), idempotent_replay: Boolean(existing),
  });
  console.log('TEST artifact restored into run', destRunId + ':', TEST_PATH, 'sha256', sha256.slice(0, 12), 'owner test');
}

function status(): void {
  const d = db();
  const runRepo = new WorkflowRunRepository(d);
  const wiRepo = new WorkItemRepository(d);
  const decRepo = new DecisionRepository(d);
  console.log('WIs:', JSON.stringify([wiRepo.findById(DEFINE_WI), wiRepo.findById(EXEC_WI)].map(w => w && { id: w.id, state: w.state })));
  console.log('Decisions:', JSON.stringify(decRepo.listByWorkItem(DEFINE_WI).concat(decRepo.listByWorkItem(EXEC_WI)).map(x => ({ id: x.id, type: x.type, status: x.status, title: x.title }))));
  const runs = runRepo.listByWorkItem(DEFINE_WI).concat(runRepo.listByWorkItem(EXEC_WI));
  console.log('Runs:', JSON.stringify(runs.map((r) => ({ id: r.id, wi: r.work_item_id, status: r.status, step: r.current_step_id, iteration: r.iteration }))));
}

// A10 — deterministic downstream-authority instantiation. Builds the
// full-build starting state from a FROZEN prior authority (the A8 archive):
// the define WorkItem is constructed directly at its archived terminal state
// (completed, with the exact artifact provenance rows and run row), and the
// exact canonical Definition bytes are transplanted byte-for-byte. NO model
// calls; every step journaled; every hash re-verified after transplant.
// This is construction of a deterministic fixture — not a repair of live
// run state (that remains forbidden).
function instantiateFromArchive(archiveSle: string, defineWi: string): void {
  seed(defineWi);
  const d = db();
  const workDir = path.join(ROOT, '.sle', 'work', defineWi);
  mkdirSync(workDir, { recursive: true });

  // 1. Transplant the exact authority bytes.
  for (const f of ['definition.md', 'readiness.md']) {
    const src = path.join(archiveSle, 'work', defineWi, f);
    if (!existsSync(src)) throw new Error(`archive missing ${f}`);
    writeFileSync(path.join(workDir, f), readFileSync(src));
  }
  const definitionBytes = readFileSync(path.join(workDir, 'definition.md'));
  const readinessBytes = readFileSync(path.join(workDir, 'readiness.md'));
  const defHash = createHash('sha256').update(definitionBytes).digest('hex');
  const readyHash = createHash('sha256').update(readinessBytes).digest('hex');
  journal({ event: 'a10_bytes_transplanted', defineWi, definition_sha256: defHash, readiness_sha256: readyHash, definition_bytes: definitionBytes.length });

  // 2. Archive ground-truth rows, read verbatim from the archived DB.
  const archiveDb = openDatabase(path.join(archiveSle, 'stratum.db'), { readonly: true } as never);
  const archRun = archiveDb.prepare('SELECT * FROM workflow_runs WHERE work_item_id = ?').all(defineWi) as Array<Record<string, unknown>>;
  const archArtifacts = archiveDb.prepare('SELECT * FROM artifacts WHERE work_item_id = ? ORDER BY created_at').all(defineWi) as Array<Record<string, unknown>>;
  const archWi = archiveDb.prepare('SELECT * FROM work_items WHERE id = ?').get(defineWi) as Record<string, unknown>;
  if (archRun.length !== 1 || archArtifacts.length < 2 || !archWi) throw new Error('archive authority incomplete');

  // 3. Construct the define WI at its archived terminal state.
  d.prepare("UPDATE work_items SET state='completed', updated_at=? WHERE id=?").run(archWi.updated_at as string, defineWi);

  // 4. Historical provenance: the archived define-work run + artifact rows.
  const r = archRun[0];
  d.prepare('INSERT INTO workflow_runs (run_id, workflow_id, work_item_id, status, current_step_id, iteration, revision, awaiting_checkpoint, started_at, updated_at, resolved_parameters_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(r.run_id, r.workflow_id, r.work_item_id, r.status, r.current_step_id, r.iteration, r.revision, r.awaiting_checkpoint, r.started_at, r.updated_at, r.resolved_parameters_json ?? '{}');
  for (const a of archArtifacts) {
    d.prepare('INSERT INTO artifacts (id, work_item_id, workflow_run_id, step_execution_id, type, ref, path, hash, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(a.id, a.work_item_id, a.workflow_run_id, a.step_execution_id, a.type, a.ref, a.path, a.hash, a.created_at);
  }
  journal({ event: 'a10_rows_transplanted', runs: archRun.length, artifacts: archArtifacts.map(a => ({ type: a.type, ref: a.ref, hash: (a.hash as string).slice(0, 12) })) });

  // 5. Fail closed unless every hash pins the transplanted bytes.
  const defRow = d.prepare('SELECT hash FROM artifacts WHERE type=? AND work_item_id=?').get('definition', defineWi) as { hash: string };
  const readyRow = d.prepare('SELECT hash FROM artifacts WHERE type=? AND work_item_id=?').get('definition-readiness', defineWi) as { hash: string };
  if (defRow.hash !== defHash) throw new Error(`definition hash mismatch: artifact ${defRow.hash} vs bytes ${defHash}`);
  if (readyRow.hash !== readyHash) throw new Error(`readiness hash mismatch: artifact ${readyRow.hash} vs bytes ${readyHash}`);
  journal({ event: 'a10_authority_pinned', definition_sha256: defHash, readiness_sha256: readyHash, verify: 'artifact-rows == transplanted bytes' });
  console.log('authority instantiated:', defineWi, '| definition sha256', defHash.slice(0, 12));
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'seed') return seed(args[0] ?? DEFINE_WI);
  if (cmd === 'instantiate') return instantiateFromArchive(args[0], args[1] ?? DEFINE_WI);
  if (cmd === 'drive') return drive(buildStack(), args[0] ?? DEFINE_WI);
  if (cmd === 'resolve') return resolve(args[0], args[1], args.slice(2).join(' '));
  if (cmd === 'gate-b') return gateB();
  if (cmd === 'execute-wi') return executeWi(args[0] ?? DEFINE_WI);
  if (cmd === 'restore-test-artifact') return restoreTestArtifact(args[0] ?? '');
  if (cmd === 'status') return status();
  console.error('usage: pilot-a-driver.ts seed|instantiate <archiveSle> [wiId]|drive [wiId]|resolve <decisionId> <optionId> <rationale>|gate-b|execute-wi|restore-test-artifact <destinationRunId>|status');
  process.exit(2);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
