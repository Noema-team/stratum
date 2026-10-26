import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ControlPlaneServer } from '../src/api/control-plane-server.js';
import type { AgentRuntime, AgentRuntimeCallbacks, RuntimePermissionResult } from '../src/application/agent-sessions/runtime.js';
import type { AgentSession, RuntimeWorkspace } from '../src/application/agent-sessions/types.js';
import { ProcessService } from '../src/application/processes/service.js';
import { EvidenceService } from '../src/services/evidence-service.js';
import { WorkService } from '../src/services/work-service.js';
import { openDatabase } from '../src/storage/database.js';
import { AppProcessRepository, ProjectRepository, RepositoryRepository, WorkflowRunRepository, WorkItemRepository, WorkspaceRepository } from '../src/storage/repositories.js';

class SimulatedAcp implements AgentRuntime {
  readonly starts: Array<{ session: AgentSession; workspace: RuntimeWorkspace }> = [];
  readonly prompts: Array<{ sessionId: string; text: string }> = [];
  readonly callbacks = new Map<string, AgentRuntimeCallbacks>();
  private readonly handles = new Set<string>();
  holdPromptText?: string;
  private releaseHeldPrompt?: () => void;
  async start(session: AgentSession, workspace: RuntimeWorkspace, callbacks: AgentRuntimeCallbacks) {
    this.starts.push({ session, workspace }); this.callbacks.set(session.id, callbacks); this.handles.add(session.id);
    return { engineSessionId: session.engineSessionId ?? `sim-${session.id}`, handle: session.id };
  }
  async prompt(handle: string, _engineSessionId: string, text: string) {
    this.prompts.push({ sessionId: handle, text });
    if (this.holdPromptText && text.includes(this.holdPromptText)) await new Promise<void>(resolve => { this.releaseHeldPrompt = resolve; });
    if (!text.startsWith('You are ')) this.callbacks.get(handle)?.onEvent('agent_message_complete', { text: `Simulated finding for ${text}` });
    return { stopReason: 'end_turn' };
  }
  releasePrompt() { this.releaseHeldPrompt?.(); this.releaseHeldPrompt = undefined; }
  async cancel() {}
  async stop(handle: string) { this.handles.delete(handle); }
  stopStaleContainer(sessionId: string) { this.handles.delete(sessionId); }
  respondToPermission(_handle: string, _requestId: string, _result: RuntimePermissionResult) {}
  hasHandle(handle: string) { return this.handles.has(handle); }
}

type Body<T> = { ok: boolean; data?: T; error?: { code?: string; message: string } };
async function request<T>(url: string, body?: unknown): Promise<{ status: number; body: Body<T> }> {
  const response = await fetch(url, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as Body<T> };
}
async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Timed out waiting for simulated ACP'); await new Promise(resolve => setTimeout(resolve, 5)); }
}

 test('C1 association, active handoff, process promotion, authorization and prompt admission are transactional', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'stratum-promotion-c1-'));
  const db = openDatabase(path.join(root, 'promotion.db'));
  const workspaceId = randomUUID(); const projectId = randomUUID(); const otherProjectId = randomUUID(); const now = new Date().toISOString();
  const checkoutA = path.join(root, 'repo-a'); const checkoutB = path.join(root, 'repo-b');
  for (const [checkout, remote] of [[checkoutA, 'https://github.com/example/a.git'], [checkoutB, 'https://github.com/example/b.git']] as const) {
    mkdirSync(checkout); execFileSync('git', ['init', '-q', checkout]);
    execFileSync('git', ['-C', checkout, 'config', 'user.email', 'test@example.invalid']); execFileSync('git', ['-C', checkout, 'config', 'user.name', 'Test']);
    execFileSync('git', ['-C', checkout, 'remote', 'add', 'origin', remote]);
    writeFileSync(path.join(checkout, 'README.md'), remote); execFileSync('git', ['-C', checkout, 'add', 'README.md']); execFileSync('git', ['-C', checkout, 'commit', '-qm', 'init']);
  }
  const runtime = new SimulatedAcp(); let server: ControlPlaneServer | undefined;
  try {
    new WorkspaceRepository(db).save({ id: workspaceId, name: 'Workspace', createdAt: now });
    const projectStore = new ProjectRepository(db);
    for (const [id, name] of [[projectId, 'Project A'], [otherProjectId, 'Project B']] as const) {
      projectStore.save({ id, workspaceId, name, status: 'active', priority: 0, createdAt: now, updatedAt: now });
    }
    const repositories = new RepositoryRepository(db);
    const repoA = randomUUID(); const repoB = randomUUID();
    repositories.save({ id: repoA, projectId, provider: 'github', remote: 'https://github.com/example/a.git', defaultBranch: 'main', localWorkspace: checkoutA, status: 'active' });
    repositories.save({ id: repoB, projectId, provider: 'github', remote: 'https://github.com/example/b.git', defaultBranch: 'main', localWorkspace: checkoutB, status: 'active' });
    repositories.linkToProject(otherProjectId, repoA);
    const processes = new ProcessService(db, workspaceId);
    const matching = processes.create(projectId, { title: 'Match A', intent: 'Investigate repository A.', repositoryIds: [repoA] });
    const mismatch = processes.create(projectId, { title: 'Use B', intent: 'Investigate repository B.', repositoryIds: [repoB] });
    const noRepo = processes.create(projectId, { title: 'Explore broadly', intent: 'Investigate without repository files.' });
    const crossProject = processes.create(otherProjectId, { title: 'Other project', intent: 'Keep this Project private.', repositoryIds: [repoA] });
    server = new ControlPlaneServer({ db, workspaceId, workService: new WorkService(db, workspaceId), evidenceService: new EvidenceService(db),
      port: 0, agentRuntime: runtime, agentRuntimeBasePath: path.join(root, 'runtime') });
    await server.listen(); const base = `http://127.0.0.1:${server.port}`;
    const projectUrl = (sessionId: string, suffix = '') => `${base}/projects/${projectId}/explorations/${sessionId}${suffix}`;
    const createExploration = async (repositoryId?: string) => {
      const response = await request<{ session: AgentSession }>(`${base}/projects/${projectId}/explorations`, { repositoryId });
      assert.equal(response.status, 200); const session = response.body.data!.session;
      await waitFor(() => runtime.prompts.some(prompt => prompt.sessionId === session.id && prompt.text.startsWith('You are ')));
      await waitFor(() => (db.prepare('SELECT lifecycle FROM app_agent_sessions WHERE id=?').get(session.id) as { lifecycle: string }).lifecycle === 'idle');
      return session;
    };
    const associate = async (sessionId: string, processId: string, associationType: 'historical'|'active', key = randomUUID()) =>
      request<{ association: { id: string; associationType: string; processId: string }; process: { id: string } }>(projectUrl(sessionId, '/association'), { processId, associationType, idempotencyKey: key });

    const beforeProcesses = (db.prepare('SELECT count(*) AS n FROM app_processes').get() as { n: number }).n;
    const beforeWork = (db.prepare('SELECT count(*) AS n FROM work_items wi JOIN projects p ON p.id=wi.project_id WHERE p.workspace_id=?').get(workspaceId) as { n: number }).n;
    const beforeRuns = new WorkflowRunRepository(db).listActive().length;
    const historical = await createExploration();
    runtime.callbacks.get(historical.id)!.onEvent('agent_message_complete', { text: 'Historic verified-looking claim.' });
    const history = (db.prepare('SELECT seq,event_type FROM app_agent_session_events WHERE session_id=? ORDER BY seq').all(historical.id) as Array<{ seq: number; event_type: string }>);
    const key = randomUUID();
    const linked = await associate(historical.id, matching.id, 'historical', key);
    assert.equal(linked.status, 200);
    const associationId = linked.body.data!.association.id;
    assert.equal(linked.body.data!.association.associationType, 'historical');
    assert.deepEqual(db.prepare('SELECT process_id,associated_process_id FROM app_agent_sessions WHERE id=?').get(historical.id), { process_id: null, associated_process_id: matching.id });
    assert.equal((db.prepare('SELECT process_id FROM app_runtime_workspaces WHERE id=?').get(historical.workspaceId) as { process_id: string | null }).process_id, null,
      'historical association does not change runtime workspace authority');
    assert.deepEqual(db.prepare('SELECT seq,event_type FROM app_agent_session_events WHERE session_id=? AND seq<=? ORDER BY seq').all(historical.id, history.at(-1)!.seq), history,
      'prior AgentSession event identities remain unchanged');
    const retried = await associate(historical.id, matching.id, 'historical', key);
    assert.equal(retried.body.data?.association.id, associationId);
    assert.equal((db.prepare('SELECT count(*) AS n FROM app_agent_session_associations WHERE session_id=?').get(historical.id) as { n: number }).n, 1);
    const secondTargetAttempt = await associate(historical.id, mismatch.id, 'historical');
    assert.equal(secondTargetAttempt.status, 409, 'one immutable session identity cannot be associated with a second Process');
    assert.throws(() => db.prepare('UPDATE app_agent_session_associations SET process_id=? WHERE id=?').run(mismatch.id, associationId), /association identity is immutable/);
    const sourceSeq = history.find(event => event.event_type === 'agent_message_complete')!.seq;
    const proposal = await request<{ sourceEventSeq: number; sourceAgentSessionId: string; proposalId: string }>(`${base}/processes/${matching.id}/activity`, {
      kind: 'proposal', title: 'Review this claim', body: 'A separately user-authored proposal.', sourceAgentSessionId: historical.id, sourceEventSeq: sourceSeq,
    });
    assert.equal(proposal.status, 200); assert.equal(proposal.body.data?.sourceEventSeq, sourceSeq); assert.equal(proposal.body.data?.sourceAgentSessionId, historical.id);
    for (const bad of [sourceSeq + 100, 1]) {
      const invalid = await request(`${base}/processes/${matching.id}/activity`, { kind: 'update', title: 'Forged source', body: 'Must fail.', sourceAgentSessionId: historical.id, sourceEventSeq: bad });
      assert.equal(invalid.status, 400, 'unknown sequence and non-agent event identities are rejected');
    }
    const crossDeniedSession = await createExploration();
    const crossProjectAttempt = await associate(crossDeniedSession.id, crossProject.id, 'historical');
    assert.equal(crossProjectAttempt.status, 404);
    const blockedHistoricalPrompt = await request(projectUrl(historical.id, '/prompts'), { idempotencyKey: randomUUID(), text: 'continue' });
    assert.equal(blockedHistoricalPrompt.status, 409, 'historical association cannot authorize continued Process work');

    const active = await createExploration(repoA);
    const oldSnapshotPath = runtime.starts.find(item => item.session.id === active.id)!.workspace.hostPath;
    const oldCommit = active.repositoryCommit;
    const priorSeq = (db.prepare('SELECT last_event_seq FROM app_agent_sessions WHERE id=?').get(active.id) as { last_event_seq: number }).last_event_seq;
    const priorOps = db.prepare('SELECT id,status,prompt_text FROM app_agent_session_operations WHERE session_id=? ORDER BY id').all(active.id);
    const priorPerms = db.prepare('SELECT * FROM app_agent_session_permissions WHERE session_id=? ORDER BY id').all(active.id);
    const handedOff = await associate(active.id, matching.id, 'active');
    assert.equal(handedOff.status, 200);
    assert.equal((db.prepare('SELECT process_id,associated_process_id FROM app_agent_sessions WHERE id=?').get(active.id) as { process_id: string; associated_process_id: string }).process_id, matching.id);
    const updatedWorkspace = db.prepare('SELECT process_id,host_path,repository_commit FROM app_runtime_workspaces WHERE id=?').get(active.workspaceId) as { process_id: string; host_path: string; repository_commit: string };
    assert.equal(updatedWorkspace.process_id, matching.id); assert.equal(updatedWorkspace.host_path, oldSnapshotPath); assert.equal(updatedWorkspace.repository_commit, oldCommit);
    assert.deepEqual(db.prepare('SELECT id,status,prompt_text FROM app_agent_session_operations WHERE session_id=? ORDER BY id').all(active.id), priorOps);
    assert.deepEqual(db.prepare('SELECT * FROM app_agent_session_permissions WHERE session_id=? ORDER BY id').all(active.id), priorPerms);
    assert.ok((db.prepare('SELECT last_event_seq FROM app_agent_sessions WHERE id=?').get(active.id) as { last_event_seq: number }).last_event_seq > priorSeq);
    await assert.rejects(runtime.callbacks.get(active.id)!.validateWorkspaceFile('/etc/passwd'));
    const promptKey = randomUUID();
    const followup = await request<{ id: string }>(projectUrl(active.id, '/prompts'), { idempotencyKey: promptKey, text: 'What does the pinned README say?' });
    assert.equal(followup.status, 200);
    await waitFor(() => runtime.prompts.some(prompt => prompt.sessionId === active.id && prompt.text.startsWith('STRATUM_PROCESS_CONTEXT_V1')));
    const operation = db.prepare('SELECT prompt_text,dispatched_prompt,status FROM app_agent_session_operations WHERE id=?').get(followup.body.data!.id) as { prompt_text: string; dispatched_prompt: string; status: string };
    const dispatched = runtime.prompts.find(prompt => prompt.sessionId === active.id && prompt.text.includes('What does the pinned README say?'))!.text;
    assert.equal(operation.prompt_text, 'What does the pinned README say?');
    assert.equal(operation.dispatched_prompt, dispatched, 'persisted envelope exactly matches the ACP dispatch');
    assert.equal(operation.status, 'completed');
    assert.match(operation.dispatched_prompt, /"processId":"[^"]+"/);
    assert.match(operation.dispatched_prompt, /"acceptedDefinitionVersion":1/);
    assert.match(operation.dispatched_prompt, /"intent":"Investigate repository A\."/);
    assert.match(operation.dispatched_prompt, new RegExp(`"commit":"${oldCommit}"`));
    await waitFor(() => (db.prepare('SELECT lifecycle FROM app_agent_sessions WHERE id=?').get(active.id) as { lifecycle: string }).lifecycle === 'idle');
    const editAccepted = processes.proposeAmendment(matching.id, { definition: { intent: 'Version two is explicitly accepted.' }, reason: 'Confirm a human-approved change.' });
    processes.decideAmendment(matching.id, editAccepted.id, 'accept');
    const versionTwoKey = randomUUID();
    const versionTwoPrompt = await request<{ id: string }>(projectUrl(active.id, '/prompts'), { idempotencyKey: versionTwoKey, text: 'Use the current accepted Process intent.' });
    assert.equal(versionTwoPrompt.status, 200);
    await waitFor(() => runtime.prompts.some(prompt => prompt.sessionId === active.id && prompt.text.includes('Use the current accepted Process intent.')));
    const versionTwoDispatch = db.prepare('SELECT dispatched_prompt FROM app_agent_session_operations WHERE id=?').get(versionTwoPrompt.body.data!.id) as { dispatched_prompt: string };
    assert.match(versionTwoDispatch.dispatched_prompt, /"acceptedDefinitionVersion":2/);
    assert.match(versionTwoDispatch.dispatched_prompt, /"intent":"Version two is explicitly accepted\."/);
    await waitFor(() => (db.prepare('SELECT lifecycle FROM app_agent_sessions WHERE id=?').get(active.id) as { lifecycle: string }).lifecycle === 'idle');

    const mismatchSession = await createExploration(repoB);
    const mismatchHandoff = await associate(mismatchSession.id, matching.id, 'active');
    assert.equal(mismatchHandoff.status, 409);
    const historicalMismatch = await associate(mismatchSession.id, matching.id, 'historical');
    assert.equal(historicalMismatch.status, 200);
    assert.equal((db.prepare('SELECT process_id FROM app_agent_sessions WHERE id=?').get(mismatchSession.id) as { process_id: string | null }).process_id, null);
    assert.equal((db.prepare('SELECT host_path,repository_commit FROM app_runtime_workspaces WHERE id=?').get(mismatchSession.workspaceId) as { host_path: string; repository_commit: string }).host_path,
      runtime.starts.find(item => item.session.id === mismatchSession.id)!.workspace.hostPath);

    const competitionTarget = processes.create(projectId, { title: 'Already has session', intent: 'Keep one AgentSession.', repositoryIds: [repoA] });
    const competingOwner = await request<AgentSession>(`${base}/processes/${competitionTarget.id}/agent-sessions`, { repositoryId: repoA });
    assert.equal(competingOwner.status, 200);
    const competitor = await createExploration(repoA);
    const rejectedCompetition = await associate(competitor.id, competitionTarget.id, 'active');
    assert.equal(rejectedCompetition.status, 409);
    assert.match(rejectedCompetition.body.error?.message ?? '', /competing active AgentSession/);

    const unresolvedTarget = processes.create(projectId, { title: 'Unresolved state target', intent: 'Reject handoff until operations settle.', repositoryIds: [repoA] });
    const unresolvedSession = await createExploration(repoA);
    const permissionId = randomUUID();
    db.prepare(`INSERT INTO app_agent_session_permissions (id,session_id,engine_request_id,operation_json,status,created_at)
      VALUES (?,?,?,'{}','pending',?)`).run(permissionId, unresolvedSession.id, randomUUID(), now);
    const pendingPermissionHandoff = await associate(unresolvedSession.id, unresolvedTarget.id, 'active');
    assert.equal(pendingPermissionHandoff.status, 409);
    assert.match(pendingPermissionHandoff.body.error?.message ?? '', /permission requests/);
    db.prepare('DELETE FROM app_agent_session_permissions WHERE id=?').run(permissionId);
    db.prepare(`INSERT INTO app_agent_session_operations (id,session_id,idempotency_key,kind,prompt_text,status,created_at,updated_at)
      VALUES (?,?,?,'prompt','unresolved request','dispatching',?,?)`).run(randomUUID(), unresolvedSession.id, randomUUID(), now, now);
    const unresolvedOperationHandoff = await associate(unresolvedSession.id, unresolvedTarget.id, 'active');
    assert.equal(unresolvedOperationHandoff.status, 409);
    assert.match(unresolvedOperationHandoff.body.error?.message ?? '', /operations to be resolved/);

    const scopeChange = processes.proposeAmendment(matching.id, { definition: { repositoryIds: [repoB] }, reason: 'Change the accepted repository scope.' });
    processes.decideAmendment(matching.id, scopeChange.id, 'accept');
    const operationsBeforeRejectedPrompt = (db.prepare('SELECT count(*) AS n FROM app_agent_session_operations WHERE session_id=?').get(active.id) as { n: number }).n;
    const rejectedPrompt = await request(projectUrl(active.id, '/prompts'), { idempotencyKey: randomUUID(), text: 'Try an out-of-scope follow-up.' });
    assert.equal(rejectedPrompt.status, 409);
    assert.equal((db.prepare('SELECT count(*) AS n FROM app_agent_session_operations WHERE session_id=?').get(active.id) as { n: number }).n, operationsBeforeRejectedPrompt,
      'failure to build current authorized Process context persists no prompt operation and dispatches nothing');

    const newProcessSource = await createExploration();
    const definition = { title: 'Accepted from exploration', intent: 'Use the user-edited intent.', desiredOutcomes: ['Confirm a small prototype'], constraints: ['Remain read-only'], repositoryIds: [] as string[] };
    const newProcessKey = randomUUID();
    const beforeNewCount = (db.prepare('SELECT count(*) AS n FROM app_processes').get() as { n: number }).n;
    const created = await request<{ association: { id: string }; process: { id: string } }>(projectUrl(newProcessSource.id, '/process-promotion'),
      { idempotencyKey: newProcessKey, associationType: 'active', definition });
    assert.equal(created.status, 200);
    const replay = await request<{ association: { id: string }; process: { id: string } }>(projectUrl(newProcessSource.id, '/process-promotion'),
      { idempotencyKey: newProcessKey, associationType: 'active', definition });
    assert.equal(replay.status, 200); assert.equal(replay.body.data?.association.id, created.body.data?.association.id);
    assert.equal(replay.body.data?.process.id, created.body.data?.process.id);
    const promotedProcessId = created.body.data!.process.id;
    assert.equal((db.prepare('SELECT count(*) AS n FROM app_processes').get() as { n: number }).n, beforeNewCount + 1);
    assert.equal((db.prepare('SELECT count(*) AS n FROM app_process_activity WHERE process_id=?').get(promotedProcessId) as { n: number }).n, 1,
      'idempotent retry does not duplicate initial activity');
    const accepted = processes.get(promotedProcessId).definitionVersions[0]!;
    assert.equal(accepted.version, 1); assert.equal(accepted.title, definition.title); assert.equal(accepted.intent, definition.intent);
    assert.deepEqual(accepted.desiredOutcomes, definition.desiredOutcomes); assert.deepEqual(accepted.constraints, definition.constraints);
    assert.equal((db.prepare('SELECT process_id FROM app_runtime_workspaces WHERE id=?').get(newProcessSource.workspaceId) as { process_id: string }).process_id, promotedProcessId);

    const incompatibleNew = await createExploration(repoB);
    const beforeRollbackCount = (db.prepare('SELECT count(*) AS n FROM app_processes').get() as { n: number }).n;
    const failedNew = await request(projectUrl(incompatibleNew.id, '/process-promotion'), { idempotencyKey: randomUUID(), associationType: 'active',
      definition: { title: 'Invalid active handoff', intent: 'Do not change scope.', repositoryIds: [] } });
    assert.equal(failedNew.status, 409);
    assert.equal((db.prepare('SELECT count(*) AS n FROM app_processes').get() as { n: number }).n, beforeRollbackCount,
      'failed active eligibility rolls back new Process, version, activity and association together');
    assert.equal((db.prepare('SELECT associated_process_id FROM app_agent_sessions WHERE id=?').get(incompatibleNew.id) as { associated_process_id: string | null }).associated_process_id, null);

    const emptyHandoff = await createExploration();
    const emptyActive = await associate(emptyHandoff.id, noRepo.id, 'active');
    assert.equal(emptyActive.status, 200, 'repository-free handoff is eligible only for a Process with no repository scope');
    const emptyRuntimeWorkspace = db.prepare('SELECT process_id,workspace_mode,host_path FROM app_runtime_workspaces WHERE id=?').get(emptyHandoff.workspaceId) as { process_id: string; workspace_mode: string; host_path: string };
    assert.equal(emptyRuntimeWorkspace.process_id, noRepo.id); assert.equal(emptyRuntimeWorkspace.workspace_mode, 'empty');
    assert.equal(emptyRuntimeWorkspace.host_path, runtime.starts.find(item => item.session.id === emptyHandoff.id)!.workspace.hostPath);
    const emptyContextPrompt = await request<{ id: string }>(projectUrl(emptyHandoff.id, '/prompts'), { idempotencyKey: randomUUID(), text: 'Continue without repository access.' });
    assert.equal(emptyContextPrompt.status, 200);
    await waitFor(() => runtime.prompts.some(prompt => prompt.sessionId === emptyHandoff.id && prompt.text.includes('Continue without repository access.')));
    const emptyContext = db.prepare('SELECT dispatched_prompt FROM app_agent_session_operations WHERE id=?').get(emptyContextPrompt.body.data!.id) as { dispatched_prompt: string };
    assert.match(emptyContext.dispatched_prompt, /"mode":"empty"/);
    assert.match(emptyContext.dispatched_prompt, /"repositoryScope":\[\]/);

    const raceSession = await createExploration();
    const raceProcess = processes.create(projectId, { title: 'Prompt race target', intent: 'Resolve prompt/promotion ordering.' });
    const racePromptKey = randomUUID();
    runtime.holdPromptText = 'Race the immutable handoff.';
    const [racePrompt, racePromotion] = await Promise.all([
      request<{ id: string }>(projectUrl(raceSession.id, '/prompts'), { idempotencyKey: racePromptKey, text: 'Race the immutable handoff.' }),
      associate(raceSession.id, raceProcess.id, 'active'),
    ]);
    assert.equal(racePrompt.status, 200);
    const raceRow = db.prepare('SELECT process_id,associated_process_id FROM app_agent_sessions WHERE id=?').get(raceSession.id) as { process_id: string | null; associated_process_id: string | null };
    assert.ok((racePromotion.status === 200 && raceRow.process_id === raceProcess.id) || (racePromotion.status === 409 && raceRow.process_id === null),
      'the serialized winner is either prompt admission (blocking handoff) or handoff (prompt uses Process context)');
    await waitFor(() => runtime.prompts.some(prompt => prompt.sessionId === raceSession.id && prompt.text.includes('Race the immutable handoff.')));
    const raceOperation = db.prepare('SELECT dispatched_prompt FROM app_agent_session_operations WHERE session_id=? AND idempotency_key=?').get(raceSession.id, racePromptKey) as { dispatched_prompt: string };
    assert.equal(runtime.prompts.filter(prompt => prompt.sessionId === raceSession.id && prompt.text.includes('Race the immutable handoff.')).length, 1);
    if (raceRow.process_id) assert.match(raceOperation.dispatched_prompt, /STRATUM_PROCESS_CONTEXT_V1/);
    else assert.equal(raceOperation.dispatched_prompt, 'Race the immutable handoff.');
    runtime.releasePrompt(); runtime.holdPromptText = undefined;

    const afterProcesses = (db.prepare('SELECT count(*) AS n FROM app_processes').get() as { n: number }).n;
    assert.equal(afterProcesses, beforeProcesses + 4, 'the new Process, competing-session target, unresolved-state target, and race target were added once each');
    assert.equal((db.prepare('SELECT count(*) AS n FROM work_items wi JOIN projects p ON p.id=wi.project_id WHERE p.workspace_id=?').get(workspaceId) as { n: number }).n, beforeWork, 'promotion never creates execution WorkItems');
    assert.equal(new WorkflowRunRepository(db).listActive().length, beforeRuns, 'promotion never creates execution WorkflowRuns');
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally {
    if (server) await server.close(); db.close(); rmSync(root, { recursive: true, force: true });
  }
 });
