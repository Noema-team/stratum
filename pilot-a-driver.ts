// Pilot A driver — experiment infrastructure, untracked. Mirrors the
// production composition root (application.ts createStratumApplication /
// buildAgentRunner) and the E4-H harness drive pattern, pointed at the
// dedicated pilot worktree. Preregistration: docs/pilots/pilot-a.md.
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';
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

const ROOT = '/home/theo/Documents/repos/pilot-a/student-platform';
const EVIDENCE = '/home/theo/Documents/repos/pilot-a/evidence';
const DB_PATH = path.join(ROOT, '.sle', 'stratum.db');
const WORKSPACE_ID = 'ws-pilot-a';
const PROJECT_ID = 'proj-pilot-a';
const OBJECTIVE_ID = 'obj-108';
const DEFINE_WI = 'wi-define-108';
const EXEC_WI = 'wi-exec-108';

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
    },
    createdAt: now, updatedAt: now,
  });
  journal({ event: 'execution_wi_created', wiId: EXEC_WI, defineWi, workflowParameters: { planning_depth: 'minimal', max_iterations: 5, on_cap_hit: 'halt', definitionSource: { workItemId: defineWi } } });
  journal({ event: 'e17_driver_integrity', fixes: ['seed schema validation', 'executeWi derives definitionSource/dependencies from its argument'] });
  console.log('execution WI created:', EXEC_WI);
}

// E27r (merge review) — deterministic fixture operation for the H2
// continuation: restore attempt 18's ORIGINAL test artifact (bytes AND
// owner) into E27's ownership representation BEFORE the build step runs.
// Restoring bytes alone is not enough: attempt 18's provenance predates
// E27's produced-file:<stepId>:<path> ownership format, so the publication
// boundary would not recognize TEST ownership and BUILD could overwrite
// the restored file again. This op (1) extracts the exact TEST artifact
// bytes from the attempt-18 archive, (2) verifies the sha256 against the
// preregistered audit value AND the run's own provenance row, (3) writes
// the bytes to the target repo, and (4) inserts an owned-by-test
// provenance row. Idempotent: re-running verifies and re-asserts.
function restoreTestArtifact(): void {
  const A18_RUN = 'c208fc69-53ee-4670-859e-02adbe2f8ce3';
  const TEST_PATH = 'apps/ai-server/tests/integration/test_worker_failure_payload_contract.py';
  const PREREGISTERED_PREFIX = 'b3b30497'; // audit: attempt-18 TEST original sha256
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
  if (!sha256.startsWith(PREREGISTERED_PREFIX)) {
    throw new Error(`restore-test-artifact: extracted sha256 ${sha256} does not match preregistered prefix ${PREREGISTERED_PREFIX} — refusing`);
  }
  const d = db();
  const prior = new ArtifactRepository(d)
    .listByWorkflowRun(A18_RUN)
    .filter((r) => r.path === TEST_PATH && r.ref?.startsWith('produced-file:'));
  for (const row of prior) {
    if (row.hash !== sha256) {
      throw new Error(`restore-test-artifact: provenance row ${row.ref} hash ${row.hash} != extracted ${sha256} — refusing`);
    }
  }
  writeFileSync(path.join(ROOT, TEST_PATH), content, 'utf-8');
  const ref = `produced-file:test:${TEST_PATH}`;
  const existing = prior.find((r) => r.ref === ref);
  if (!existing) {
    new ArtifactRepository(d).save({
      id: `art-a18-test-restore-${A18_RUN.slice(0, 8)}`,
      workItemId: EXEC_WI, workflowRunId: A18_RUN, stepExecutionId: undefined,
      type: 'produced-file', ref, path: TEST_PATH, hash: sha256,
      createdAt: new Date().toISOString(),
    });
  }
  journal({
    event: 'e27r_test_artifact_restored', run: A18_RUN, path: TEST_PATH,
    sha256, bytes: Buffer.byteLength(content, 'utf-8'), owner: 'test',
    provenance_ref: ref, prior_rows_verified: prior.length,
    disk_bytes: Buffer.byteLength(content, 'utf-8'),
  });
  console.log('TEST artifact restored:', TEST_PATH, 'sha256', sha256.slice(0, 12), 'owner test');
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
  if (cmd === 'restore-test-artifact') return restoreTestArtifact();
  if (cmd === 'status') return status();
  console.error('usage: pilot-a-driver.ts seed|instantiate <archiveSle> [wiId]|drive [wiId]|resolve <decisionId> <optionId> <rationale>|gate-b|execute-wi|restore-test-artifact|status');
  process.exit(2);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
