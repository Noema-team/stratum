import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase } from '../src/storage/database.js';
import { AppProcessRepository, ProjectRepository, RepositoryRepository, WorkspaceRepository } from '../src/storage/repositories.js';
import { ProcessService } from '../src/application/processes/service.js';
import { AgentSessionService, AgentSessionServiceError } from '../src/application/agent-sessions/service.js';
import type { AgentRuntime, AgentRuntimeCallbacks, RuntimePermissionResult } from '../src/application/agent-sessions/runtime.js';
import type { AgentSession, RuntimeWorkspace } from '../src/application/agent-sessions/types.js';
import { assertEmptyReadOnlyWorkspace, createEmptyReadOnlyWorkspace, createReadOnlySnapshot, resolveWorkspaceReadPath } from '../src/application/agent-sessions/workspace.js';

test('AgentSession snapshot is pinned to one commit and rejects traversal and symlink escape', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'stratum-agent-snapshot-'));
  try {
    const repo = path.join(root, 'repo'); const state = path.join(root, 'state'); mkdirSync(repo); mkdirSync(state);
    execFileSync('git', ['init', '-q', repo]); execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']); execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test']);
    writeFileSync(path.join(repo, 'README.md'), 'version one\n');
    execFileSync('git', ['-C', repo, 'add', 'README.md']); execFileSync('git', ['-C', repo, 'commit', '-qm', 'one']);
    const commit = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const snapshot = createReadOnlySnapshot(repo, commit, state);
    writeFileSync(path.join(repo, 'README.md'), 'version two\n');
    assert.equal(readFileSync(resolveWorkspaceReadPath(snapshot, 'README.md'), 'utf8'), 'version one\n');
    assert.throws(() => resolveWorkspaceReadPath(snapshot, '../repo/README.md'));
    assert.throws(() => resolveWorkspaceReadPath(snapshot, '/etc/passwd'));
    assert.throws(() => resolveWorkspaceReadPath(snapshot, 'missing.txt'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('repository-free workspace is a private empty read-only directory and exposes no files', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'stratum-agent-empty-'));
  try {
    const engineState = path.join(root, 'session');
    const emptyWorkspace = createEmptyReadOnlyWorkspace(engineState);
    assert.equal(emptyWorkspace, path.join(engineState, 'workspace'));
    assert.equal(readdirSync(emptyWorkspace).length, 0);
    assert.equal(statSync(emptyWorkspace).mode & 0o222, 0);
    assert.throws(() => resolveWorkspaceReadPath(emptyWorkspace, 'README.md'));
    assertEmptyReadOnlyWorkspace(emptyWorkspace, engineState);

    assert.throws(() => writeFileSync(path.join(emptyWorkspace, 'unexpected.txt'), 'host write'));
    chmodSync(emptyWorkspace, 0o700);
    writeFileSync(path.join(emptyWorkspace, 'unexpected.txt'), 'unexpected host write');
    chmodSync(emptyWorkspace, 0o500);
    assert.throws(() => assertEmptyReadOnlyWorkspace(emptyWorkspace, engineState), /must remain empty/);
  } finally {
    try { chmodSync(path.join(root, 'session', 'workspace'), 0o700); } catch { /* workspace may not have been created */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test('AgentSession is Process-scoped and duplicate prompt keys never dispatch twice', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'stratum-agent-session-'));
  const db = openDatabase(path.join(root, 'test.db'));
  try {
    const repo = path.join(root, 'repo'); mkdirSync(repo);
    execFileSync('git', ['init', '-q', repo]); execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']); execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test']);
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/example/repo.git']);
    writeFileSync(path.join(repo, 'README.md'), 'bounded source\n'); execFileSync('git', ['-C', repo, 'add', 'README.md']); execFileSync('git', ['-C', repo, 'commit', '-qm', 'initial']);
    const now = new Date().toISOString(); const workspaceId = '71000000-0000-4000-8000-000000000001'; const projectId = '71000000-0000-4000-8000-000000000002'; const repositoryId = '71000000-0000-4000-8000-000000000003';
    new WorkspaceRepository(db).save({ id: workspaceId, name: 'Test', createdAt: now });
    new ProjectRepository(db).save({ id: projectId, workspaceId, name: 'Project', status: 'active', priority: 0, createdAt: now, updatedAt: now });
    const repositoryStore = new RepositoryRepository(db);
    repositoryStore.save({ id: repositoryId, projectId, provider: 'github', remote: 'https://github.com/example/repo.git', defaultBranch: 'main', localWorkspace: repo, status: 'active' });
    const sharedProjectId = '71000000-0000-4000-8000-000000000004';
    new ProjectRepository(db).save({ id: sharedProjectId, workspaceId, name: 'Shared Project', status: 'active', priority: 0, createdAt: now, updatedAt: now });
    repositoryStore.linkToProject(sharedProjectId, repositoryId);
    const processService = new ProcessService(db, workspaceId);
    const process = processService.create(sharedProjectId, { title: 'Investigate', intent: 'Understand the repository', repositoryIds: [repositoryId] });
    class FakeRuntime implements AgentRuntime {
      calls: string[] = []; handle = false; failStart = false; callbacks?: AgentRuntimeCallbacks;
      async start(session: AgentSession, _workspace: RuntimeWorkspace, callbacks: AgentRuntimeCallbacks, _restore: boolean) { if (this.failStart) throw new Error('simulated Goose runtime unavailable'); this.handle = true; this.callbacks = callbacks; return { engineSessionId: `goose-${session.id}`, handle: session.id }; }
      async prompt(_handle: string, _engine: string, promptText: string) { this.calls.push(promptText); return {}; }
      async cancel() {}
      async stop() { this.handle = false; }
      stopStaleContainer() {}
      respondToPermission(_handle: string, _requestId: string, _result: RuntimePermissionResult) {}
      hasHandle() { return this.handle; }
    }
    const runtime = new FakeRuntime(); const service = new AgentSessionService(db, workspaceId, processService, repositoryStore, runtime, path.join(root, 'runtime'));
    const session = service.create(process.id, repositoryId);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(runtime.calls.length, 1, 'the accepted-definition briefing is dispatched once');
    assert.equal(service.findForProcess(process.id)?.id, session.id);
    assert.ok(service.listEvents(session.id).some(event => event.eventType === 'session_start_requested'));
    runtime.callbacks!.onEvent('agent_message_complete', { text: 'A grounded finding.' });
    const findingEvent = service.listEvents(session.id).find(event => event.eventType === 'agent_message_complete')!;
    const recorded = processService.addActivity(process.id, 'update', 'Goose finding', 'Agent claim from Goose.', undefined, undefined,
      { agentSessionId: session.id, eventSeq: findingEvent.seq });
    assert.equal(recorded.sourceAgentSessionId, session.id);
    assert.equal(recorded.sourceEventSeq, findingEvent.seq);
    const proposal = processService.addActivity(process.id, 'proposal', 'Grounded proposal', 'Consider the documented approach.', undefined, undefined,
      { agentSessionId: session.id, eventSeq: findingEvent.seq });
    assert.ok(proposal.proposalId);
    let decisionLoop = processService.get(process.id);
    assert.equal(decisionLoop.proposals.find(item => item.id === proposal.proposalId)?.status, 'pending');
    assert.equal(decisionLoop.activity.find(item => item.proposalId === proposal.proposalId)?.sourceEventSeq, findingEvent.seq);
    processService.addActivity(process.id, 'review', 'Revision requested', 'Please clarify the constraint.', 'revise', proposal.proposalId);
    decisionLoop = processService.get(process.id);
    assert.equal(decisionLoop.proposals.find(item => item.id === proposal.proposalId)?.status, 'revise');
    const followUp = processService.addActivity(process.id, 'proposal', 'Clarified proposal', 'The constraint is preserved.', undefined, undefined,
      { agentSessionId: session.id, eventSeq: findingEvent.seq });
    assert.notEqual(followUp.proposalId, proposal.proposalId, 'follow-up proposals have their own identity, not an implied revision number');
    processService.addActivity(process.id, 'review', 'Direction accepted', 'The clarified direction fits this Process.', 'accepted', followUp.proposalId);
    decisionLoop = processService.get(process.id);
    assert.equal(decisionLoop.proposals.find(item => item.id === followUp.proposalId)?.status, 'accepted');
    assert.equal(decisionLoop.process.intent, 'Understand the repository', 'proposal acceptance does not rewrite accepted Process intent');
    assert.throws(() => processService.addActivity(process.id, 'review', 'Wrong proposal', 'Cross-target review.', 'accepted', proposal.proposalId), /not pending/);
    const separateProject = { id: '71000000-0000-4000-8000-000000000005', workspaceId, name: 'Separate Project', status: 'active' as const, priority: 0, createdAt: now, updatedAt: now };
    new ProjectRepository(db).save(separateProject);
    const separateProcess = processService.create(separateProject.id, { title: 'Separate effort', intent: 'Keep decisions in this Process.' });
    assert.equal(processService.get(separateProcess.id).proposals.length, 0, 'proposal records are not exposed through another Project Process');
    assert.throws(() => processService.addActivity(separateProcess.id, 'review', 'Cross-Project target', 'Must not resolve another Process proposal.', 'accepted', followUp.proposalId), /not pending/);
    assert.throws(() => processService.addActivity(process.id, 'update', 'Bad source', 'Wrong Process.', undefined, undefined,
      { agentSessionId: session.id, eventSeq: findingEvent.seq + 100 }), /source must reference/);
    const key = '72000000-0000-4000-8000-000000000001';
    const first = service.submitPrompt(session.id, key, 'Inspect the readme');
    const retry = service.submitPrompt(session.id, key, 'Inspect the readme');
    assert.equal(retry.id, first.id);
    assert.throws(() => service.submitPrompt(session.id, key, 'Different prompt'), AgentSessionServiceError);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(runtime.calls.filter(call => call === 'Inspect the readme').length, 1);
    assert.equal(service.listOperations(session.id).find(operation => operation.id === first.id)?.status, 'completed');
    const otherWorkspace = '73000000-0000-4000-8000-000000000001';
    const isolated = new AgentSessionService(db, otherWorkspace, processService, repositoryStore, runtime, path.join(root, 'other-runtime'));
    assert.throws(() => isolated.listEvents(session.id), AgentSessionServiceError);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM work_items').get() as { count: number }).count, 0);
    assert.equal(new AppProcessRepository(db).findById(process.id)?.lifecycle, 'active');
    await service.stop(session.id);
    const replacement = service.create(process.id, repositoryId);
    assert.notEqual(replacement.id, session.id, 'a stopped session can be replaced using the same repository');
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(service.findForProcess(process.id)?.lifecycle, 'idle');
    await service.stop(replacement.id);
    runtime.failStart = true;
    const unavailable = service.create(process.id, repositoryId);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(service.findForProcess(process.id)?.id, unavailable.id);
    assert.equal(service.findForProcess(process.id)?.lifecycle, 'failed');
    assert.match(service.findForProcess(process.id)?.errorMessage ?? '', /runtime unavailable/);
    assert.equal(processService.get(process.id).proposals.find(item => item.id === followUp.proposalId)?.status, 'accepted', 'runtime failure leaves persisted Process decisions readable');
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
