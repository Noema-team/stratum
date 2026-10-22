import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DockerGooseRuntime, normalizeGuestPath } from '../src/application/agent-sessions/runtime.js';
import type { AgentRuntimeCallbacks } from '../src/application/agent-sessions/runtime.js';
import type { AgentSession, RuntimeWorkspace } from '../src/application/agent-sessions/types.js';

const fakeDocker = `#!/usr/bin/env node
const readline = require('node:readline');
const { appendFileSync } = require('node:fs');
if (process.argv.includes('info')) { process.stdout.write('28.4.0\\n'); process.exit(0); }
if (process.argv.includes('inspect')) process.exit(1);
const log = item => appendFileSync(process.env.FAKE_ACP_LOG, JSON.stringify(item) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
let promptId; let permissionId; let readId;
function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }
rl.on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'exit') { process.exit(0); return; }
  if (message.method === 'initialize') { send({ jsonrpc:'2.0', id:message.id, result:{ protocolVersion:1, authMethods:[] } }); return; }
  if (message.method === 'session/list') { send({ jsonrpc:'2.0', id:message.id, result:{ sessions:[] } }); return; }
  if (message.method === 'session/new') { send({ jsonrpc:'2.0', id:message.id, result:{ sessionId:'fake-goose-session' } }); return; }
  if (message.method === 'session/prompt') {
    promptId = message.id;
    permissionId = process.env.FAKE_PERMISSION_ID_TYPE === 'number' ? 37 : 'permission-37';
    send({ jsonrpc:'2.0', method:'session/request_permission', id:permissionId, params:{ toolCall:{ title:'Read file', rawInput:{path:'/workspace/README.md'}, meta:{goose:{toolCall:{extensionName:'developer',toolName:'read'}}}}, options:[{optionId:'allow',kind:'allow_once'},{optionId:'reject',kind:'reject_once'}] } });
    return;
  }
  if (message.id === permissionId) {
    log({ stage:'permission-response', id:message.id, result:message.result });
    readId = 'read-1'; send({ jsonrpc:'2.0', method:'fs/read_text_file', id:readId, params:{path:'/workspace/README.md'} }); return;
  }
  if (message.id === readId) {
    log({ stage:'read-response', result:message.result });
    send({ jsonrpc:'2.0', method:'session/update', params:{sessionId:'fake-goose-session',update:{sessionUpdate:'agent_message_chunk',delta:{text:'Complete '}}} });
    send({ jsonrpc:'2.0', method:'session/update', params:{sessionId:'fake-goose-session',update:{sessionUpdate:'agent_message_chunk',delta:{text:'message.'}}} });
    send({ jsonrpc:'2.0', id:promptId, result:{stopReason:'end_turn'} });
    return;
  }
  send({ jsonrpc:'2.0', id:message.id, error:{code:-32601,message:'unsupported'} });
});
`;

for (const idType of ['number','string'] as const) {
  test(`Goose ACP preserves ${idType} permission request ID and assembles message chunks`, async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'stratum-acp-contract-'));
    const previousPath = process.env.PATH; const previousType = process.env.FAKE_PERMISSION_ID_TYPE; const previousLog = process.env.FAKE_ACP_LOG;
    try {
      const bin = path.join(root, 'bin'); const config = path.join(root, 'config'); const repo = path.join(root, 'workspace'); const state = path.join(root, 'state');
      mkdirSync(bin); mkdirSync(config); mkdirSync(repo); mkdirSync(state);
      writeFileSync(path.join(repo, 'README.md'), 'pinned source');
      const dockerPath = path.join(bin, 'docker'); writeFileSync(dockerPath, fakeDocker); chmodSync(dockerPath, 0o755);
      const logPath = path.join(root, 'acp.jsonl');
      process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ''}`; process.env.FAKE_PERMISSION_ID_TYPE = idType; process.env.FAKE_ACP_LOG = logPath;
      const runtime = new DockerGooseRuntime(config, 'local/goose:test');
      const session: AgentSession = { id:'session-1', projectId:'project-1', processId:'process-1', workspaceId:'workspace-1', repositoryId:'repo-1', repositoryRemote:'https://github.com/example/repo.git', repositoryCommit:'a'.repeat(40), engine:'goose-acp', lifecycle:'starting', createdAt:new Date().toISOString(), updatedAt:new Date().toISOString(), lastEventSeq:0 };
      const workspace: RuntimeWorkspace = { id:'workspace-1', projectId:'project-1', processId:'process-1', repositoryId:'repo-1', hostPath:repo, repositoryCommit:session.repositoryCommit, accessMode:'read_only', engineStatePath:state };
      const events: Array<{type:string;payload:Record<string,unknown>}> = [];
      const callbacks: AgentRuntimeCallbacks = {
        onEvent: (type,payload) => events.push({type,payload}), onLifecycle: () => {},
        requestToolPermission: async () => ({decision:'allow_once',optionId:'allow'}),
        validateWorkspaceFile: async () => {},
        readWorkspaceFile: async () => 'pinned source',
      };
      const started = await runtime.start(session, workspace, callbacks, false);
      const result = await runtime.prompt(started.handle, started.engineSessionId, 'Read the readme');
      assert.equal(result.stopReason, 'end_turn');
      await runtime.stop(started.handle);
      const messages = readFileSync(logPath, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string,unknown>);
      const permissionResponse = messages.find(item => item.stage === 'permission-response')!;
      assert.equal(typeof permissionResponse.id, idType);
      assert.equal((messages.find(item => item.stage === 'read-response')?.result as {content:string}).content, 'pinned source');
      assert.deepEqual(events.filter(item => item.type === 'agent_message_chunk').map(item => item.payload.text), ['Complete ','message.']);
      assert.deepEqual(events.find(item => item.type === 'agent_message_complete')?.payload, { text:'Complete message.', chunkCount:2 });
    } finally {
      process.env.PATH = previousPath; process.env.FAKE_PERMISSION_ID_TYPE = previousType; process.env.FAKE_ACP_LOG = previousLog;
      rmSync(root, { recursive:true, force:true });
    }
  });
}

test('Goose permission paths reject absolute host paths, traversal, and configuration locations', () => {
  for (const candidate of ['/etc/passwd', '/var/lib/stratum-goose/config/provider.yaml', '/workspace/../../etc/passwd', '../../etc/passwd']) {
    assert.equal(normalizeGuestPath(candidate), undefined, candidate);
  }
  assert.equal(normalizeGuestPath('/workspace/src/index.ts'), '/workspace/src/index.ts');
  assert.equal(normalizeGuestPath('src/index.ts'), '/workspace/src/index.ts');
});
