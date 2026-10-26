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
  readonly starts: Array<{ session: AgentSession; workspace: RuntimeWorkspace; restore: boolean }> = [];
  readonly prompts: Array<{ sessionId: string; text: string }> = [];
  readonly callbacks = new Map<string, AgentRuntimeCallbacks>();
  private readonly handles = new Set<string>();
  failStart = false;

  async start(session: AgentSession, workspace: RuntimeWorkspace, callbacks: AgentRuntimeCallbacks, restore: boolean) {
    if (this.failStart) throw new Error('Goose configuration is unavailable');
    this.starts.push({ session, workspace, restore });
    this.callbacks.set(session.id, callbacks);
    this.handles.add(session.id);
    return { engineSessionId: session.engineSessionId ?? `native-${session.id}`, handle: session.id };
  }
  async prompt(handle: string, _engineSessionId: string, text: string) { this.prompts.push({ sessionId: handle, text }); return { stopReason: 'end_turn' }; }
  async cancel() {}
  async stop(handle: string) { this.handles.delete(handle); }
  stopStaleContainer(sessionId: string) { this.handles.delete(sessionId); }
  respondToPermission(_handle: string, _requestId: string, _result: RuntimePermissionResult) {}
  hasHandle(handle: string) { return this.handles.has(handle); }
}

function makeServer(db: ReturnType<typeof openDatabase>, workspaceId: string, runtime: AgentRuntime, runtimePath: string): ControlPlaneServer {
  return new ControlPlaneServer({ db, workspaceId, workService: new WorkService(db, workspaceId), evidenceService: new EvidenceService(db),
    port: 0, agentRuntime: runtime, agentRuntimeBasePath: runtimePath });
}

async function envelope<T>(url: string, init?: RequestInit): Promise<{ status: number; body: { ok: boolean; data?: T; error?: { message: string } } }> {
  const response = await fetch(url, init);
  return { status: response.status, body: await response.json() as { ok: boolean; data?: T; error?: { message: string } } };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for simulated ACP state');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('Project-owned explorations support empty/repository scopes, Project authorization, idempotency, and restart recovery', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'stratum-project-exploration-api-'));
  const db = openDatabase(path.join(root, 'test.db'));
  const runtime = new SimulatedAcp();
  const workspaceId = randomUUID();
  const now = new Date().toISOString();
  const checkout = path.join(root, 'checkout'); mkdirSync(checkout);
  execFileSync('git', ['init', '-q', checkout]);
  execFileSync('git', ['-C', checkout, 'config', 'user.email', 'test@example.invalid']);
  execFileSync('git', ['-C', checkout, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', checkout, 'remote', 'add', 'origin', 'https://github.com/example/shared.git']);
  writeFileSync(path.join(checkout, 'README.md'), 'pinned Project source\n');
  execFileSync('git', ['-C', checkout, 'add', 'README.md']); execFileSync('git', ['-C', checkout, 'commit', '-qm', 'initial']);
  let firstServer: ControlPlaneServer | undefined;
  let restartedServer: ControlPlaneServer | undefined;
  try {
    new WorkspaceRepository(db).save({ id: workspaceId, name: 'Test workspace', createdAt: now });
    const projectStore = new ProjectRepository(db);
    const firstProject = { id: randomUUID(), workspaceId, name: 'Project A', status: 'active' as const, priority: 0, createdAt: now, updatedAt: now };
    const sharedProject = { id: randomUUID(), workspaceId, name: 'Project B', status: 'active' as const, priority: 0, createdAt: now, updatedAt: now };
    const unlinkedProject = { id: randomUUID(), workspaceId, name: 'Project C', status: 'active' as const, priority: 0, createdAt: now, updatedAt: now };
    projectStore.save(firstProject); projectStore.save(sharedProject); projectStore.save(unlinkedProject);
    const repositoryStore = new RepositoryRepository(db);
    const repositoryId = randomUUID();
    repositoryStore.save({ id: repositoryId, projectId: firstProject.id, provider: 'github', remote: 'https://github.com/example/shared.git', defaultBranch: 'main', localWorkspace: checkout, status: 'active' });
    repositoryStore.linkToProject(sharedProject.id, repositoryId);
    const legacyProcess = new ProcessService(db, workspaceId).create(firstProject.id, { title: 'Existing Process', intent: 'Keep the v0.2 session path working.', repositoryIds: [repositoryId] });

    firstServer = makeServer(db, workspaceId, runtime, path.join(root, 'runtime'));
    await firstServer.listen();
    const base = `http://127.0.0.1:${firstServer.port}`;
    const beforeProcesses = (db.prepare('SELECT count(*) AS count FROM app_processes').get() as { count: number }).count;
    const beforeWorkItems = (db.prepare('SELECT count(*) AS count FROM work_items').get() as { count: number }).count;
    const beforeRuns = new WorkflowRunRepository(db).listActive().length;

    const listed = await envelope<{ sessions: AgentSession[] }>(`${base}/projects/${firstProject.id}/explorations`);
    assert.equal(listed.status, 200); assert.deepEqual(listed.body.data?.sessions, []);
    const legacyCreated = await envelope<AgentSession>(`${base}/processes/${legacyProcess.id}/agent-sessions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repositoryId }),
    });
    assert.equal(legacyCreated.status, 200);
    await waitFor(() => runtime.starts.some(start => start.session.id === legacyCreated.body.data!.id));
    const legacyEvents = await envelope<AgentEvent[]>(`${base}/agent-sessions/${legacyCreated.body.data!.id}/events`);
    assert.equal(legacyEvents.status, 200, 'Process-owned sessions remain available through the v0.2 API');
    const emptyCreated = await envelope<{ session: AgentSession }>(`${base}/projects/${firstProject.id}/explorations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    assert.equal(emptyCreated.status, 200);
    const emptySession = emptyCreated.body.data!.session;
    assert.equal(emptySession.processId, undefined);
    assert.equal(emptySession.repositoryId, undefined);
    assert.equal(emptySession.repositoryCommit, undefined);
    await waitFor(() => runtime.starts.some(start => start.session.id === emptySession.id));
    const emptyWorkspace = runtime.starts.find(start => start.session.id === emptySession.id)!.workspace;
    assert.equal(emptyWorkspace.workspaceMode, 'empty');
    assert.equal(emptyWorkspace.repositoryId, undefined);
    assert.equal(emptyWorkspace.processId, undefined);
    assert.deepEqual(await import('node:fs').then(fs => fs.readdirSync(emptyWorkspace.hostPath)), []);
    await waitFor(() => runtime.prompts.some(prompt => prompt.sessionId === emptySession.id));
    await waitFor(() => runtime.callbacks.has(emptySession.id));
    assert.match(runtime.prompts.find(prompt => prompt.sessionId === emptySession.id)!.text, /exploratory context, not accepted Project knowledge or Process intent/);
    assert.match(runtime.prompts.find(prompt => prompt.sessionId === emptySession.id)!.text, /No repository was selected/);

    const emptyCallbacks = runtime.callbacks.get(emptySession.id)!;
    await assert.rejects(emptyCallbacks.validateWorkspaceFile('/workspace/README.md'));
    assert.equal((db.prepare('SELECT count(*) AS count FROM app_agent_session_permissions WHERE session_id=?').get(emptySession.id) as { count: number }).count, 0,
      'a forbidden empty-workspace read is rejected before permission mediation');
    const operationKey = randomUUID();
    const promptBody = { idempotencyKey: operationKey, text: 'What should I investigate?' };
    const promptUrl = `${base}/projects/${firstProject.id}/explorations/${emptySession.id}/prompts`;
    const firstPrompt = await envelope<{ id: string; status: string }>(promptUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(promptBody) });
    const retriedPrompt = await envelope<{ id: string; status: string }>(promptUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(promptBody) });
    assert.equal(firstPrompt.status, 200); assert.equal(retriedPrompt.body.data?.id, firstPrompt.body.data?.id);
    await waitFor(() => runtime.prompts.filter(prompt => prompt.sessionId === emptySession.id && prompt.text === promptBody.text).length === 1);
    const conflictingRetry = await envelope(promptUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...promptBody, text: 'different question' }) });
    assert.equal(conflictingRetry.status, 409);
    const secondEmptyCreated = await envelope<{ session: AgentSession }>(`${base}/projects/${firstProject.id}/explorations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    assert.equal(secondEmptyCreated.status, 200);
    const secondEmptySession = secondEmptyCreated.body.data!.session;
    await waitFor(() => runtime.starts.some(start => start.session.id === secondEmptySession.id));
    const beforeQuestions = await envelope<{ sessions: AgentSession[] }>(`${base}/projects/${firstProject.id}/explorations`);
    const emptyLabels = beforeQuestions.body.data!.sessions.filter(item => [emptySession.id, secondEmptySession.id].includes(item.id)).map(item => item.explorationLabel ?? `New exploration · ${item.id.slice(0, 8)}`);
    assert.equal(new Set(emptyLabels).size, 2, 'repository-free explorations have distinct stable fallback labels before a question');
    const secondPromptText = 'How could a lightweight prototype validate this?';
    const secondPrompt = await envelope<{ id: string }>(`${base}/projects/${firstProject.id}/explorations/${secondEmptySession.id}/prompts`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idempotencyKey: randomUUID(), text: secondPromptText }),
    });
    assert.equal(secondPrompt.status, 200);
    const labeled = await envelope<{ sessions: AgentSession[] }>(`${base}/projects/${firstProject.id}/explorations`);
    const firstLabeled = labeled.body.data!.sessions.find(item => item.id === emptySession.id)!;
    const secondLabeled = labeled.body.data!.sessions.find(item => item.id === secondEmptySession.id)!;
    assert.ok(firstLabeled.explorationLabel?.startsWith(promptBody.text));
    assert.ok(secondLabeled.explorationLabel?.startsWith(secondPromptText));
    assert.notEqual(firstLabeled.explorationLabel, secondLabeled.explorationLabel);
    runtime.callbacks.get(emptySession.id)!.onEvent('agent_message_complete', { text: 'An unverified agent claim.' });
    const firstHistory = await envelope<AgentEvent[]>(`${base}/projects/${firstProject.id}/explorations/${emptySession.id}/events`);
    const finding = firstHistory.body.data!.find(event => event.eventType === 'agent_message_complete')!;
    assert.ok(finding.seq > 0);

    const repoCreated = await envelope<{ session: AgentSession }>(`${base}/projects/${firstProject.id}/explorations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repositoryId }),
    });
    assert.equal(repoCreated.status, 200);
    const repoSession = repoCreated.body.data!.session;
    await waitFor(() => runtime.starts.some(start => start.session.id === repoSession.id));
    const repoWorkspace = runtime.starts.find(start => start.session.id === repoSession.id)!.workspace;
    assert.equal(repoWorkspace.workspaceMode, 'repository_snapshot');
    assert.equal(readFileSync(path.join(repoWorkspace.hostPath, 'README.md'), 'utf8'), 'pinned Project source\n');
    assert.match(runtime.prompts.find(prompt => prompt.sessionId === repoSession.id)!.text, /Explicit repository context: https:\/\/github.com\/example\/shared.git/);
    assert.match(runtime.prompts.find(prompt => prompt.sessionId === repoSession.id)!.text, /Pinned snapshot commit:/);
    await runtime.callbacks.get(repoSession.id)!.validateWorkspaceFile('/workspace/README.md');
    await assert.rejects(runtime.callbacks.get(repoSession.id)!.validateWorkspaceFile('/etc/passwd'));
    repositoryStore.updateStatus(repositoryId, 'disabled');
    await assert.rejects(runtime.callbacks.get(repoSession.id)!.validateWorkspaceFile('/workspace/README.md'), /no longer active/);
    repositoryStore.updateStatus(repositoryId, 'active');

    const unlinkedRepositoryAttempt = await envelope(`${base}/projects/${unlinkedProject.id}/explorations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repositoryId }),
    });
    assert.equal(unlinkedRepositoryAttempt.status, 404);
    const crossProjectDetail = await envelope(`${base}/projects/${sharedProject.id}/explorations/${emptySession.id}`);
    const crossProjectEvents = await envelope(`${base}/projects/${sharedProject.id}/explorations/${emptySession.id}/events`);
    const crossProjectPrompt = await envelope(`${base}/projects/${sharedProject.id}/explorations/${emptySession.id}/prompts`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idempotencyKey: randomUUID(), text: 'Not authorized' }),
    });
    const genericSessionEvents = await envelope(`${base}/agent-sessions/${emptySession.id}/events`);
    assert.equal(crossProjectDetail.status, 404); assert.equal(crossProjectEvents.status, 404); assert.equal(crossProjectPrompt.status, 404); assert.equal(genericSessionEvents.status, 404);
    const sharedRepositoryExploration = await envelope<{ session: AgentSession }>(`${base}/projects/${sharedProject.id}/explorations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repositoryId }),
    });
    assert.equal(sharedRepositoryExploration.status, 200);
    assert.notEqual(sharedRepositoryExploration.body.data?.session.id, repoSession.id, 'shared repository membership does not share conversation identity');

    const sessionsBeforeRestart = await envelope<{ sessions: AgentSession[] }>(`${base}/projects/${firstProject.id}/explorations`);
    assert.equal(sessionsBeforeRestart.body.data?.sessions.length, 3);
    const stableSessionId = emptySession.id;
    const stableSeq = firstHistory.body.data!.at(-1)!.seq;
    await firstServer.close(); firstServer = undefined;
    restartedServer = makeServer(db, workspaceId, runtime, path.join(root, 'runtime'));
    await restartedServer.listen();
    const restartBase = `http://127.0.0.1:${restartedServer.port}`;
    const restoredDetail = await envelope<{ session: AgentSession }>(`${restartBase}/projects/${firstProject.id}/explorations/${stableSessionId}`);
    assert.equal(restoredDetail.status, 200); assert.equal(restoredDetail.body.data?.session.id, stableSessionId);
    assert.equal(restoredDetail.body.data?.session.lifecycle, 'interrupted');
    const restoredEvents = await envelope<AgentEvent[]>(`${restartBase}/projects/${firstProject.id}/explorations/${stableSessionId}/events`);
    assert.equal(restoredEvents.body.data?.find(event => event.seq === stableSeq)?.seq, stableSeq);
    const callsBeforeRecovery = runtime.prompts.filter(prompt => prompt.sessionId === stableSessionId).length;
    const recovered = await envelope<AgentSession>(`${restartBase}/projects/${firstProject.id}/explorations/${stableSessionId}/reconcile`, { method: 'POST' });
    assert.equal(recovered.status, 200);
    assert.equal(recovered.body.data?.id, stableSessionId);
    assert.equal(runtime.prompts.filter(prompt => prompt.sessionId === stableSessionId).length, callsBeforeRecovery,
      'restart restoration does not resend the briefing or prior user prompt');

    runtime.failStart = true;
    const unavailable = await envelope<{ session: AgentSession }>(`${restartBase}/projects/${unlinkedProject.id}/explorations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    assert.equal(unavailable.status, 200);
    await waitFor(() => (db.prepare('SELECT lifecycle FROM app_agent_sessions WHERE id=?').get(unavailable.body.data!.session.id) as { lifecycle: string } | undefined)?.lifecycle === 'failed');
    const unavailableDetail = await envelope<{ session: AgentSession }>(`${restartBase}/projects/${unlinkedProject.id}/explorations/${unavailable.body.data!.session.id}`);
    assert.equal(unavailableDetail.body.data?.session.lifecycle, 'failed');
    const unavailableEvents = await envelope<AgentEvent[]>(`${restartBase}/projects/${unlinkedProject.id}/explorations/${unavailable.body.data!.session.id}/events`);
    assert.equal(unavailableEvents.body.data?.some(event => event.eventType === 'agent_message_complete'), false, 'unavailable Goose is never replaced with a simulated agent reply');

    assert.equal((db.prepare('SELECT count(*) AS count FROM app_processes').get() as { count: number }).count, beforeProcesses,
      'Project exploration does not create a Process');
    assert.equal((db.prepare('SELECT count(*) AS count FROM work_items').get() as { count: number }).count, beforeWorkItems);
    assert.equal(new WorkflowRunRepository(db).listActive().length, beforeRuns);
    assert.equal((db.prepare('SELECT count(*) AS count FROM app_agent_sessions WHERE project_id=? AND process_id IS NULL').get(firstProject.id) as { count: number }).count, 3);
    assert.equal(new AppProcessRepository(db).listByProject(firstProject.id).length, 1, 'only the explicitly created compatibility Process remains');
  } finally {
    if (restartedServer) await restartedServer.close();
    if (firstServer) await firstServer.close();
    db.close(); rmSync(root, { recursive: true, force: true });
  }
});
