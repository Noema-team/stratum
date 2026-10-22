import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase } from '../src/storage/database.js';
import { AppProcessRepository, ProjectRepository, RepositoryRepository, WorkspaceRepository } from '../src/storage/repositories.js';
import { ProcessService } from '../src/application/processes/service.js';
import { AgentSessionService, AgentSessionServiceError } from '../src/application/agent-sessions/service.js';
import type { AgentRuntime, AgentRuntimeCallbacks, RuntimePermissionResult } from '../src/application/agent-sessions/runtime.js';
import type { AgentSession, RuntimeWorkspace } from '../src/application/agent-sessions/types.js';
import { createReadOnlySnapshot, resolveWorkspaceReadPath } from '../src/application/agent-sessions/workspace.js';

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
    const processService = new ProcessService(db, workspaceId);
    const process = processService.create(projectId, { title: 'Investigate', intent: 'Understand the repository', repositoryIds: [repositoryId] });
    class FakeRuntime implements AgentRuntime {
      calls: string[] = []; handle = false;
      async start(session: AgentSession, _workspace: RuntimeWorkspace, _callbacks: AgentRuntimeCallbacks, _restore: boolean) { this.handle = true; return { engineSessionId: `goose-${session.id}`, handle: session.id }; }
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
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
