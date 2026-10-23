import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { AgentSession, RuntimeWorkspace } from './types.js';
import { assertEmptyReadOnlyWorkspace } from './workspace.js';

export interface RuntimePermissionResult {
  decision: 'allow_once' | 'reject_once';
  optionId: string;
}

export interface AgentRuntimeCallbacks {
  onEvent(eventType: string, payload: Record<string, unknown>): void;
  onLifecycle(lifecycle: 'running' | 'idle' | 'awaiting_permission' | 'interrupted' | 'outcome_unknown' | 'failed', message?: string): void;
  requestToolPermission(engineRequestId: string, operation: Record<string, unknown>, options: Array<Record<string, unknown>>): Promise<RuntimePermissionResult>;
  validateWorkspaceFile(requestedPath: string): Promise<void>;
  readWorkspaceFile(engineRequestId: string, requestedPath: string): Promise<string>;
}

export interface AgentRuntime {
  start(session: AgentSession, workspace: RuntimeWorkspace, callbacks: AgentRuntimeCallbacks, restore: boolean): Promise<{ engineSessionId: string; handle: string }>;
  prompt(handle: string, engineSessionId: string, text: string): Promise<{ stopReason?: string }>;
  cancel(handle: string, engineSessionId: string): Promise<void>;
  stop(handle: string): Promise<void>;
  stopStaleContainer(sessionId: string): void;
  respondToPermission(handle: string, requestId: string, result: RuntimePermissionResult): void;
  hasHandle(handle: string): boolean;
}

interface RpcPending { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
interface RuntimeProcess { process: ChildProcessWithoutNullStreams; pending: Map<string | number, RpcPending>; callbacks: AgentRuntimeCallbacks; handle: string; nextId: number; buffer: string; replaying: boolean; exited: boolean; approvedReads: Map<string, number>; assistantChunks: string[]; }

const DEFAULT_GOOSE_IMAGE = 'ghcr.io/aaif-goose/goose:1.54.0@sha256:c8a6b66718fafc405055bb642ab1cccbb9a31ed76d1fbd1e4385d18c43cdb4d0';
const ACP_TIMEOUT_MS = 120_000;

/** Goose ACP under a read-only, single-repository Docker mount. No host fallback exists. */
export class DockerGooseRuntime implements AgentRuntime {
  private readonly processes = new Map<string, RuntimeProcess>();
  private readonly image: string;
  private readonly configDir: string;

  constructor(configDir = path.join(homedir(), '.config', 'goose'), image = process.env.STRATUM_GOOSE_IMAGE ?? DEFAULT_GOOSE_IMAGE) {
    if (!/^[a-z0-9./:_@-]+$/i.test(image)) throw new Error('STRATUM_GOOSE_IMAGE must be a Docker image reference');
    this.image = image;
    this.configDir = configDir;
  }

  async start(session: AgentSession, workspace: RuntimeWorkspace, callbacks: AgentRuntimeCallbacks, restore: boolean): Promise<{ engineSessionId: string; handle: string }> {
    if (!this.dockerAvailable()) throw new Error('Docker is required for the read-only agent workspace; Goose will not run on the host');
    if (!existsSync(this.configDir) || !statSync(this.configDir).isDirectory()) throw new Error('Goose configuration is missing; configure Goose locally before starting a Process session');
    const configDir = realpathSync(this.configDir);
    this.assertMountSafe(configDir);
    this.assertMountSafe(workspace.hostPath);
    this.assertMountSafe(workspace.engineStatePath);
    if (workspace.workspaceMode === 'empty') {
      if (workspace.repositoryId || workspace.repositoryCommit) throw new Error('empty AgentSession workspace must not have repository metadata');
      assertEmptyReadOnlyWorkspace(workspace.hostPath, workspace.engineStatePath);
    } else if (!workspace.repositoryId || !workspace.repositoryCommit) {
      throw new Error('repository snapshot workspace is missing its repository identity or pinned commit');
    }
    mkdirSync(workspace.engineStatePath, { recursive: true, mode: 0o700 });
    this.stopStaleContainer(session.id);

    const containerName = this.containerName(session.id);
    const args = [
      'run', '--rm', '-i', '--name', containerName,
      '--label', `stratum.agent-session=${session.id}`,
      '--network=bridge', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
      '--pids-limit=128', '--memory=2g', '--cpus=2',
      '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=64m',
      '--mount', `type=bind,source=${workspace.hostPath},target=/workspace,readonly`,
      '--mount', `type=bind,source=${workspace.engineStatePath},target=/var/lib/stratum-goose`,
      '--mount', `type=bind,source=${configDir},target=/var/lib/stratum-goose/config,readonly`,
      '--env', 'GOOSE_PATH_ROOT=/var/lib/stratum-goose',
      '--env', 'GOOSE_MODE=approve',
      '--env', 'HOME=/home/goose',
      '--workdir', '/workspace', '--entrypoint', 'goose', this.image, 'acp',
    ];
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const handle = session.id;
    const state: RuntimeProcess = { process: child, pending: new Map(), callbacks, handle, nextId: 0, buffer: '', replaying: false, exited: false, approvedReads: new Map(), assistantChunks: [] };
    this.processes.set(handle, state);
    child.stdout.on('data', chunk => this.consumeStdout(state, chunk.toString('utf8')));
    child.stderr.on('data', chunk => callbacks.onEvent('engine_diagnostic', { text: redact(chunk.toString('utf8')).slice(0, 1000) }));
    child.on('error', error => this.failProcess(handle, state, error.message));
    child.on('exit', (code, signal) => {
      state.exited = true;
      for (const pending of state.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Goose ACP process exited')); }
      state.pending.clear();
      if (this.processes.get(handle) === state) {
        this.processes.delete(handle);
        callbacks.onLifecycle('interrupted', `Goose ACP exited (${signal ?? code ?? 'unknown'}).`);
      }
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Docker did not start the Goose container')), 10_000);
      child.once('spawn', () => { clearTimeout(timer); resolve(); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
    });
    try {
      const initialized = await this.request(state, 'initialize', { protocolVersion: 1, clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: false }, terminal: false,
      } });
      const authMethods = (initialized as { authMethods?: Array<{ id?: string }> })?.authMethods;
      if (authMethods?.[0]?.id) await this.request(state, 'authenticate', { methodId: authMethods[0].id });
      let engineSessionId = session.engineSessionId;
      if (restore) {
        if (engineSessionId) {
          state.replaying = true;
          await this.request(state, 'session/load', { sessionId: engineSessionId, cwd: '/workspace', mcpServers: [] });
          state.replaying = false;
        } else {
          const listed = await this.request(state, 'session/list', { cwd: '/workspace' }) as { sessions?: Array<{ sessionId?: string }> };
          const sessions = (listed?.sessions ?? []).filter(item => typeof item.sessionId === 'string');
          if (sessions.length !== 1) throw new Error('Uncertain Goose session creation could not be reconciled to exactly one native session');
          engineSessionId = sessions[0].sessionId;
          state.replaying = true;
          await this.request(state, 'session/load', { sessionId: engineSessionId, cwd: '/workspace', mcpServers: [] });
          state.replaying = false;
        }
        if (!engineSessionId) throw new Error('Goose ACP did not expose a recoverable session id');
        callbacks.onEvent('conversation_restored', { engine: 'goose-acp', engineSessionId, replaySuppressed: true });
      } else if (engineSessionId) {
        throw new Error('Cannot start a duplicate Goose session for an existing engine session id');
      } else {
        const listed = await this.request(state, 'session/list', { cwd: '/workspace' }) as { sessions?: Array<{ sessionId?: string }> };
        const sessions = listed?.sessions ?? [];
        if (sessions.length > 0) throw new Error('Unbound Goose sessions already exist in this workspace; refusing to create a duplicate');
        const created = await this.request(state, 'session/new', { cwd: '/workspace', mcpServers: [] }) as { sessionId?: string };
        if (!created?.sessionId) throw new Error('Goose ACP did not return a session id');
        engineSessionId = created.sessionId;
      }
      return { engineSessionId, handle };
    } catch (error) {
      await this.stop(handle).catch(() => {});
      throw error;
    }
  }

  async prompt(handle: string, engineSessionId: string, text: string): Promise<{ stopReason?: string }> {
    const state = this.requireProcess(handle);
    state.approvedReads.clear();
    state.assistantChunks = [];
    state.callbacks.onLifecycle('running');
    try {
      const result = await this.request(state, 'session/prompt', { sessionId: engineSessionId, prompt: [{ type: 'text', text }] }, 10 * 60_000);
      if (state.assistantChunks.length) {
        state.callbacks.onEvent('agent_message_complete', { text: redact(state.assistantChunks.join('')), chunkCount: state.assistantChunks.length });
      }
      state.callbacks.onLifecycle('idle');
      const stopReason = (result as { stopReason?: string })?.stopReason;
      return { stopReason };
    } catch (error) {
      state.callbacks.onLifecycle('outcome_unknown', error instanceof Error ? error.message : 'Goose prompt outcome is unknown');
      throw error;
    } finally { state.approvedReads.clear(); }
  }

  async cancel(handle: string, engineSessionId: string): Promise<void> {
    const state = this.requireProcess(handle);
    await this.request(state, 'session/cancel', { sessionId: engineSessionId });
  }

  respondToPermission(handle: string, requestId: string, result: RuntimePermissionResult): void {
    const state = this.requireProcess(handle);
    this.write(state, { jsonrpc: '2.0', id: requestId, result: { outcome: { outcome: 'selected', optionId: result.optionId } } });
  }

  async stop(handle: string): Promise<void> {
    const state = this.processes.get(handle);
    if (!state) return;
    try { this.write(state, { jsonrpc: '2.0', method: 'exit' }); } catch { /* process already closing */ }
    state.process.kill('SIGTERM');
    await new Promise<void>(resolve => {
      if (state.exited) return resolve();
      const timer = setTimeout(() => { state.process.kill('SIGKILL'); resolve(); }, 5000);
      state.process.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    this.processes.delete(handle);
  }

  stopStaleContainer(sessionId: string): void {
    const name = this.containerName(sessionId);
    const found = spawnSync('docker', ['inspect', '--format', '{{ index .Config.Labels "stratum.agent-session" }}', name], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    if (found.status !== 0) return;
    if (found.stdout.trim() !== sessionId) throw new Error('Refusing to remove a Docker container not owned by this AgentSession');
    spawnSync('docker', ['rm', '--force', name], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'ignore', 'ignore'] });
  }

  hasHandle(handle: string): boolean { return this.processes.has(handle); }

  private dockerAvailable(): boolean {
    const result = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    return result.status === 0 && Boolean(result.stdout.trim());
  }

  private assertMountSafe(mountPath: string): void {
    if (!path.isAbsolute(mountPath) || mountPath.includes(',') || mountPath.includes('\0')) throw new Error('unsafe Docker mount path');
  }

  private containerName(sessionId: string): string { return `stratum-agent-${sessionId.replace(/[^a-f0-9-]/gi, '')}`; }

  private requireProcess(handle: string): RuntimeProcess {
    const state = this.processes.get(handle);
    if (!state || state.exited) throw new Error('AgentSession runtime is disconnected; reconcile it before continuing');
    return state;
  }

  private request(state: RuntimeProcess, method: string, params: Record<string, unknown>, timeoutMs = ACP_TIMEOUT_MS): Promise<unknown> {
    const id = ++state.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { state.pending.delete(id); reject(new Error(`Goose ACP request timed out: ${method}`)); }, timeoutMs);
      state.pending.set(id, { resolve, reject, timer });
      this.write(state, { jsonrpc: '2.0', id, method, params });
    });
  }

  private write(state: RuntimeProcess, message: Record<string, unknown>): void {
    if (state.process.stdin.destroyed || !state.process.stdin.writable) throw new Error('Goose ACP input is closed');
    state.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private consumeStdout(state: RuntimeProcess, chunk: string): void {
    state.buffer += chunk;
    if (state.buffer.length > 5_000_000) { state.callbacks.onLifecycle('failed', 'Goose ACP emitted an oversized protocol line.'); void this.stop(state.handle); return; }
    let newline: number;
    while ((newline = state.buffer.indexOf('\n')) >= 0) {
      const line = state.buffer.slice(0, newline).trim(); state.buffer = state.buffer.slice(newline + 1);
      if (!line) continue;
      let message: Record<string, unknown>;
      try { message = JSON.parse(line) as Record<string, unknown>; }
      catch { state.callbacks.onEvent('engine_diagnostic', { text: redact(line).slice(0, 500) }); continue; }
      void this.handleMessage(state, message);
    }
  }

  private async handleMessage(state: RuntimeProcess, message: Record<string, unknown>): Promise<void> {
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = state.pending.get(message.id as string | number);
      if (pending) {
        clearTimeout(pending.timer); state.pending.delete(message.id as string | number);
        if (message.error) pending.reject(new Error('Goose ACP returned an error'));
        else pending.resolve(message.result);
      }
      return;
    }
    const method = message.method;
    const params = (message.params && typeof message.params === 'object' ? message.params : {}) as Record<string, unknown>;
    const id = message.id as string | number | undefined;
    try {
      if (method === 'session/update') {
        if (!state.replaying) this.handleUpdate(state, params);
        return;
      }
      if (method === 'session/request_permission' && id !== undefined) {
        const toolCall = (params.toolCall ?? {}) as Record<string, unknown>;
        const rawInput = (toolCall.rawInput ?? {}) as Record<string, unknown>;
        const toolMeta = (((toolCall.meta ?? {}) as Record<string, unknown>).goose ?? {}) as Record<string, unknown>;
        const gooseCall = (toolMeta.toolCall ?? {}) as Record<string, unknown>;
        const requestedPath = typeof rawInput.path === 'string' ? normalizeGuestPath(rawInput.path) : undefined;
        const operation = { kind: 'engine_tool', title: toolCall.title, toolName: gooseCall.toolName,
          extensionName: gooseCall.extensionName, path: requestedPath, input: rawInput };
        const options = Array.isArray(params.options) ? params.options as Array<Record<string, unknown>> : [];
        let containedRead = false;
        if (requestedPath) {
          try { await state.callbacks.validateWorkspaceFile(requestedPath); containedRead = true; } catch { /* fail closed before prompting */ }
        }
        const safeRead = gooseCall.extensionName === 'developer' && gooseCall.toolName === 'read'
          && containedRead && options.some(option => option.kind === 'allow_once')
          && options.some(option => option.kind === 'reject_once');
        if (!safeRead) {
          const reject = options.find(option => option.kind === 'reject_once');
          if (typeof reject?.optionId === 'string') this.write(state, permissionSelectionResponse(id, reject.optionId));
          else this.write(state, { jsonrpc: '2.0', id, error: { code: -32602, message: 'Unsupported permission request; no safe refusal option was offered' } });
          state.callbacks.onEvent('tool_blocked', { operation });
          return;
        }
        const result = await state.callbacks.requestToolPermission(String(id), operation, options);
        if (result.decision === 'allow_once' && requestedPath) state.approvedReads.set(requestedPath, (state.approvedReads.get(requestedPath) ?? 0) + 1);
        this.write(state, permissionSelectionResponse(id, result.optionId));
        return;
      }
      if (method === 'fs/read_text_file' && id !== undefined) {
        const requestedPath = typeof params.path === 'string' ? params.path : '';
        const guestPath = normalizeGuestPath(requestedPath);
        if (!guestPath || !state.approvedReads.has(guestPath)) throw new Error('No one-time permission authorizes this exact repository file read');
        const remaining = state.approvedReads.get(guestPath)! - 1;
        if (remaining > 0) state.approvedReads.set(guestPath, remaining); else state.approvedReads.delete(guestPath);
        const content = await state.callbacks.readWorkspaceFile(String(id), requestedPath);
        this.write(state, { jsonrpc: '2.0', id, result: { content } });
        return;
      }
      if (method === 'fs/write_text_file' || method === 'terminal/create' || method === 'terminal/kill') {
        state.callbacks.onEvent('tool_blocked', { method, reason: 'read-only investigation policy' });
      }
      if (id !== undefined && typeof method === 'string') {
        this.write(state, { jsonrpc: '2.0', id, error: { code: -32601, message: 'Operation is not available in read-only Process investigation mode' } });
      }
    } catch {
      if (id !== undefined) {
        try { this.write(state, { jsonrpc: '2.0', id, error: { code: -32000, message: 'Stratum refused the operation under the read-only workspace policy' } }); } catch { /* channel closed */ }
      }
    }
  }

  private handleUpdate(state: RuntimeProcess, params: Record<string, unknown>): void {
    const callbacks = state.callbacks;
    const update = (params.update && typeof params.update === 'object' ? params.update : {}) as Record<string, unknown>;
    const kind = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : 'unknown';
    if (kind === 'agent_thought_chunk') {
      callbacks.onEvent('reasoning_activity', { state: 'working' });
      return;
    }
    if (kind === 'agent_message_chunk') {
      const delta = (update.delta && typeof update.delta === 'object' ? update.delta : {}) as Record<string, unknown>;
      const text = typeof delta.text === 'string' ? redact(delta.text) : '';
      if (text) { state.assistantChunks.push(text); callbacks.onEvent('agent_message_chunk', { text }); }
      return;
    }
    if (kind === 'tool_call' || kind === 'tool_call_update') {
      callbacks.onEvent('tool_activity', { toolCallId: update.toolCallId, title: update.title, status: update.status, kind: update.kind });
      return;
    }
    if (kind === 'usage_update') {
      callbacks.onEvent('usage', { usage: update.usage });
      return;
    }
    callbacks.onEvent('engine_activity', { kind });
  }

  private failProcess(handle: string, state: RuntimeProcess, message: string): void {
    state.callbacks.onLifecycle('failed', redact(message).slice(0, 500));
    state.exited = true;
    if (this.processes.get(handle) === state) this.processes.delete(handle);
  }
}

function redact(value: string): string {
  return value.replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/(api[_-]?key\s*[:=]\s*)[^\s,"']+/gi, '$1[REDACTED]');
}

export function normalizeGuestPath(requested: string): string | undefined {
  if (!requested || requested.includes('\0')) return undefined;
  const candidate = path.posix.resolve('/workspace', requested);
  const relative = path.posix.relative('/workspace', candidate);
  if (!relative || relative === '.' || relative === '..' || relative.startsWith('../') || path.posix.isAbsolute(relative)) return undefined;
  return candidate;
}

export function permissionSelectionResponse(id: string | number, optionId: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result: { outcome: { outcome: 'selected', optionId } } };
}
