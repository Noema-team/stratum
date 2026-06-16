import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { EventBus } from '../src/event-bus.js';
import { RuntimeMapManagerImpl, createInitialMap } from '../src/runtime-map.js';

console.log('# Running WebSocket EventBus tests...');

function getFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.listen(0, () => {
      const port = (server.address() as any).port;
      server.close(() => resolve(port));
    });
  });
}

async function initValidMapManager(mapPath: string): Promise<RuntimeMapManagerImpl> {
  const mapManager = new RuntimeMapManagerImpl({ mapPath });
  const initialMap = createInitialMap({
    projectName: 'event-bus-test',
    projectType: 'api',
    codeRemote: { url: 'https://github.com/test/repo.git', branch: 'main' },
    issuesRemote: { type: 'git', url: 'https://github.com/test/issues', branch: 'main' },
    docsRemote: { url: 'https://github.com/test/docs.git', pending: false },
    taskStore: { type: 'local' },
    agents: {},
  });
  await mapManager.write(initialMap);
  return mapManager;
}

test('EventBus: client receives system.ready state snapshot on connection', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'event-bus-test-'));
  mkdirSync(join(tmpDir, '.sle'), { recursive: true });
  const mapPath = join(tmpDir, '.sle', 'map.yaml');
  const mapManager = await initValidMapManager(mapPath);

  // Initialize map.yaml cycle details by merging with default properties
  await mapManager.update((m) => ({
    ...m,
    cycle: {
      ...m.cycle,
      number: 5,
      iteration: 2,
    },
  }));

  const port = await getFreePort();
  const server = http.createServer();
  const bus = new EventBus(server, mapManager);

  await new Promise<void>((resolve) => server.listen(port, resolve));

  const ws = new WebSocket(`ws://localhost:${port}/events`);

  const readyMsg = await new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout waiting for system.ready')), 2000);
    ws.on('message', (data: string) => {
      clearTimeout(timer);
      resolve(JSON.parse(data));
    });
  });

  assert.strictEqual(readyMsg.type, 'system.ready');
  assert.strictEqual(readyMsg.cycle, 5);
  assert.strictEqual(readyMsg.iteration, 2);
  assert.ok(readyMsg.payload.version);
  assert.ok(readyMsg.payload.uptime_ms >= 0);

  ws.close();
  bus.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('EventBus: multi-client broadcast distributes events using correct dotted types and envelopes', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'event-bus-test-'));
  mkdirSync(join(tmpDir, '.sle'), { recursive: true });
  const mapPath = join(tmpDir, '.sle', 'map.yaml');
  const mapManager = await initValidMapManager(mapPath);

  await mapManager.update((m) => ({
    ...m,
    cycle: {
      ...m.cycle,
      number: 1,
      iteration: 1,
    },
  }));

  const port = await getFreePort();
  const server = http.createServer();
  const bus = new EventBus(server, mapManager);

  await new Promise<void>((resolve) => server.listen(port, resolve));

  const ws1 = new WebSocket(`ws://localhost:${port}/events`);
  const ws2 = new WebSocket(`ws://localhost:${port}/events`);

  // Wait for connections and discard system.ready
  await Promise.all([
    new Promise<void>((resolve) => ws1.once('open', () => resolve())),
    new Promise<void>((resolve) => ws2.once('open', () => resolve())),
  ]);

  const p1 = new Promise<any>((resolve) => {
    ws1.on('message', (data: string) => {
      const parsed = JSON.parse(data);
      if (parsed.type === 'intake.coherence_checked') resolve(parsed);
    });
  });

  const p2 = new Promise<any>((resolve) => {
    ws2.on('message', (data: string) => {
      const parsed = JSON.parse(data);
      if (parsed.type === 'intake.coherence_checked') resolve(parsed);
    });
  });

  // Emit test event
  const payload = { file: 'docs/specs.md', status: 'clean' };
  const sessionId = 'session-999';
  await bus.emit('intake.coherence_checked', payload, sessionId);

  const [res1, res2] = await Promise.all([p1, p2]);

  for (const res of [res1, res2]) {
    assert.strictEqual(res.type, 'intake.coherence_checked');
    assert.strictEqual(res.cycle, 1);
    assert.strictEqual(res.iteration, 1);
    assert.strictEqual(res.session_id, sessionId);
    assert.deepEqual(res.payload, payload);
  }

  ws1.close();
  ws2.close();
  bus.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('EventBus: routes client command approval.respond & categories.confirm', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'event-bus-test-'));
  mkdirSync(join(tmpDir, '.sle'), { recursive: true });
  const mapPath = join(tmpDir, '.sle', 'map.yaml');
  const mapManager = await initValidMapManager(mapPath);

  const port = await getFreePort();
  const server = http.createServer();
  const bus = new EventBus(server, mapManager);

  let approvalResult: any = null;
  let confirmResult: any = null;

  bus.registerCallbacks({
    onApprovalRespond: async (data) => {
      approvalResult = data;
    },
    onCategoriesConfirm: async (data) => {
      confirmResult = data;
    },
  });

  await new Promise<void>((resolve) => server.listen(port, resolve));

  const ws = new WebSocket(`ws://localhost:${port}/events`);

  // Wait until we receive system.ready before sending commands
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout waiting for system.ready')), 2000);
    ws.on('message', (data: string) => {
      const parsed = JSON.parse(data);
      if (parsed.type === 'system.ready') {
        clearTimeout(timer);
        resolve();
      }
    });
  });

  // Send approval.respond command
  ws.send(JSON.stringify({
    type: 'approval.respond',
    gate: 'CONFIRM',
    decision: 'approve',
  }));

  // Send categories.confirm command
  ws.send(JSON.stringify({
    type: 'categories.confirm',
    categories: ['correctness', 'performance'],
  }));

  // Wait a bit for message processing
  await new Promise<void>((resolve) => setTimeout(resolve, 300));

  assert.ok(approvalResult);
  assert.strictEqual(approvalResult.type, 'approval.respond');
  assert.strictEqual(approvalResult.gate, 'CONFIRM');
  assert.strictEqual(approvalResult.decision, 'approve');

  assert.ok(confirmResult);
  assert.strictEqual(confirmResult.type, 'categories.confirm');
  assert.deepEqual(confirmResult.categories, ['correctness', 'performance']);

  ws.close();
  bus.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

console.log('# ✅ All WebSocket EventBus tests passed!');
