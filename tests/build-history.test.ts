import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import { AgentRunner, APPEND_ONLY_PATHS, validateOutputPath } from '../src/agent-runner.js';
import type { CycleStateContext } from '../src/context-manager.js';
import type { RuntimeMap, RuntimeMapManager } from '../src/runtime-map.js';
import type { AssembledContext } from '../src/types.js';
import type { ILLMProvider, LLMCompletionResult } from '../src/llm-provider.js';
import type { ContextManager } from '../src/context-manager.js';
import type { ManifestNodeEntry } from '../src/run-artifacts.js';

console.log('# Running Phase I (BUILD Node + HISTORY) tests...');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'sle-build-history-'));
}

function makeCycleState(overrides: Partial<CycleStateContext> = {}): CycleStateContext {
  return {
    cycle_number: 1,
    iteration: 1,
    planning_depth: 'standard',
    intent: 'Build a widget system',
    current_node: 'BUILD',
    ...overrides,
  };
}

function makeBaseMap(): RuntimeMap {
  return {
    meta: {
      status: 'cycling',
      cycle: 1,
      version_id: '123e4567-e89b-12d3-a456-426614174000',
      initialized_at: '2026-05-08T12:00:00Z',
      updated_at: '2026-05-08T12:00:00Z',
    },
    project: { name: 'test', description: 'test', type: 'api' },
    remotes: {
      code: { type: 'git', url: 'https://github.com/org/repo.git', branch: 'main' },
      issues: { type: 'git', url: 'https://github.com/org/issues.git', branch: 'main' },
      docs: { url: 'https://github.com/org/docs.git', pending: false },
    },
    task_store: { type: 'local' },
    agents: {},
    discovery: {
      status: 'complete',
      mode: 'full',
      completed_at: '2026-05-08T13:00:00Z',
      artifacts: [],
      current_round: 0,
      total_rounds: 1,
      current_phase: 0,
      total_phases: 0,
      open_questions_count: 0,
      blocking_questions_count: 0,
    },
    cycle: {
      number: 1,
      iteration: 1,
      revision: 0,
      max_iterations: 5,
      planning_depth: 'standard',
      started_at: '2026-05-08T14:00:00Z',
      outcome: 'cycling',
      approval_gate: null,
      awaiting_scoping: false,
      awaiting_confirmation: false,
      awaiting_sharding_approval: false,
    },
    artifacts: [],
  } as unknown as RuntimeMap;
}

class InMemoryMapManager implements RuntimeMapManager {
  public map: RuntimeMap;
  constructor(initial?: RuntimeMap) {
    this.map = JSON.parse(JSON.stringify(initial ?? makeBaseMap()));
  }
  async read(): Promise<RuntimeMap> { return JSON.parse(JSON.stringify(this.map)); }
  async update(fn: (m: RuntimeMap) => RuntimeMap): Promise<void> {
    this.map = JSON.parse(JSON.stringify(fn(JSON.parse(JSON.stringify(this.map)))));
  }
  async write(m: RuntimeMap): Promise<void> { this.map = JSON.parse(JSON.stringify(m)); }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

class MockRunArtifacts {
  public updates: Array<{ node: string; update: Partial<ManifestNodeEntry> }> = [];
  async updateNodeStatus(_cn: number, _it: number, nodeId: string, update: Partial<ManifestNodeEntry>): Promise<void> {
    this.updates.push({ node: nodeId, update });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

// ─── Mock FS that tracks appends separately from writes ───────────────────────

function makeFsMock(files: Record<string, string> = {}): {
  mock: typeof import('fs').promises;
  written: Record<string, string>;
  appended: Record<string, string[]>;
} {
  const written: Record<string, string> = { ...files };
  const appended: Record<string, string[]> = {};
  const mock = {
    mkdir: async () => {},
    writeFile: async (p: unknown, content: unknown) => {
      written[p as string] = content as string;
    },
    appendFile: async (p: unknown, content: unknown) => {
      const key = p as string;
      if (!(key in appended)) appended[key] = [];
      appended[key].push(content as string);
      written[key] = (written[key] ?? '') + (content as string);
    },
    readFile: async (p: unknown) => {
      const key = p as string;
      if (key in written) return written[key];
      throw Object.assign(new Error(`ENOENT: ${key}`), { code: 'ENOENT' });
    },
  } as unknown as typeof import('fs').promises;
  return { mock, written, appended };
}

class MockLLMProvider implements ILLMProvider {
  constructor(private content: string, private tokens = 50) {}
  async complete(): Promise<LLMCompletionResult> {
    return { content: this.content, tokens_used: this.tokens };
  }
}

class MockContextManager implements ContextManager {
  assemble(_role: unknown, _state: unknown): Promise<AssembledContext> {
    return Promise.resolve({
      system_prompt: 'system',
      state_summary: 'state',
      task_description: 'task',
      artifact_slices: {},
      truncated_artifacts: [],
      failure_context: undefined,
      token_count: 10,
    });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

class MockRunArtifactManager {
  async writeNodeOutput(): Promise<void> {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

// ─── APPEND_ONLY_PATHS tests ──────────────────────────────────────────────────

test('APPEND_ONLY_PATHS: contains docs/decisions.md', () => {
  assert.ok(APPEND_ONLY_PATHS.has('docs/decisions.md'));
});

test('APPEND_ONLY_PATHS: does not contain docs/cycle-summary.md', () => {
  assert.ok(!APPEND_ONLY_PATHS.has('docs/cycle-summary.md'));
});

test('APPEND_ONLY_PATHS: does not contain docs/plan.md', () => {
  assert.ok(!APPEND_ONLY_PATHS.has('docs/plan.md'));
});

// ─── validateOutputPath: builder unrestricted ─────────────────────────────────

test('builder: allows src/ paths', () => {
  assert.strictEqual(validateOutputPath('src/index.ts', 'builder'), true);
  assert.strictEqual(validateOutputPath('src/lib/db.ts', 'builder'), true);
});

test('builder: denies docs/ paths (deny-list)', () => {
  assert.strictEqual(validateOutputPath('docs/anything.md', 'builder'), false);
  assert.strictEqual(validateOutputPath('.sle/map.yaml', 'builder'), false);
});

test('builder: allows deep nested paths', () => {
  assert.strictEqual(validateOutputPath('src/modules/auth/handlers/login.ts', 'builder'), true);
});

// ─── validateOutputPath: historian ───────────────────────────────────────────

test('historian: allows docs/decisions.md', () => {
  assert.strictEqual(validateOutputPath('docs/decisions.md', 'historian'), true);
});

test('historian: allows docs/cycle-summary.md', () => {
  assert.strictEqual(validateOutputPath('docs/cycle-summary.md', 'historian'), true);
});

test('historian: blocks src/ paths', () => {
  assert.strictEqual(validateOutputPath('src/index.ts', 'historian'), false);
});

test('historian: blocks docs/plan.md', () => {
  assert.strictEqual(validateOutputPath('docs/plan.md', 'historian'), false);
});

// ─── AgentRunner: append-only behavior for decisions.md ──────────────────────

const HISTORIAN_OUTPUT_1 = `<!-- SLE-OUTPUT
role: historian
node: HISTORY
artifacts:
  - id: decisions
    path: docs/decisions.md
-->

## docs/decisions.md

## Decision: Use PostgreSQL

Cycle 1 decision: chose PostgreSQL for persistence.`;

const HISTORIAN_OUTPUT_2 = `<!-- SLE-OUTPUT
role: historian
node: HISTORY
artifacts:
  - id: decisions
    path: docs/decisions.md
-->

## docs/decisions.md

## Decision: Add Redis cache

Cycle 2 decision: add Redis for caching.`;

test('AgentRunner HISTORY: appends to decisions.md on first write', async () => {
  const root = makeTempDir();
  const { mock, appended } = makeFsMock();
  const ram = new MockRunArtifactManager();
  const cm = new MockContextManager();
  const llm = new MockLLMProvider(HISTORIAN_OUTPUT_1, 80);
  const runner = new AgentRunner(cm as never, llm, root, ram as never, { model: 'test' }, mock);

  const result = await runner.run('HISTORY', makeCycleState({ current_node: 'HISTORY' }));

  assert.ok(result.success, result.error);
  const decisionsKey = join(root, 'docs/decisions.md');
  assert.ok(appended[decisionsKey], 'decisions.md should have been appended');
  assert.strictEqual(appended[decisionsKey].length, 1);
});

test('AgentRunner HISTORY: second run appends (does not overwrite) decisions.md', async () => {
  const root = makeTempDir();
  const { mock, written, appended } = makeFsMock();
  const ram = new MockRunArtifactManager();
  const cm = new MockContextManager();
  const decisionsKey = join(root, 'docs/decisions.md');

  // First HISTORY run
  const llm1 = new MockLLMProvider(HISTORIAN_OUTPUT_1, 80);
  const runner1 = new AgentRunner(cm as never, llm1, root, ram as never, { model: 'test' }, mock);
  await runner1.run('HISTORY', makeCycleState({ current_node: 'HISTORY' }));

  // Second HISTORY run
  const llm2 = new MockLLMProvider(HISTORIAN_OUTPUT_2, 80);
  const runner2 = new AgentRunner(cm as never, llm2, root, ram as never, { model: 'test' }, mock);
  await runner2.run('HISTORY', makeCycleState({ current_node: 'HISTORY' }));

  // Both runs should have appended (2 total appends)
  assert.strictEqual(appended[decisionsKey]?.length, 2, 'expected 2 append operations');
  // Combined content should have both decisions
  const combined = written[decisionsKey] ?? '';
  assert.ok(combined.includes('PostgreSQL'), 'first decision should be present');
  assert.ok(combined.includes('Redis'), 'second decision should be present');
});

test('AgentRunner HISTORY: cycle-summary.md is overwritten, not appended', async () => {
  const root = makeTempDir();
  const summaryOutput = `<!-- SLE-OUTPUT
role: historian
node: HISTORY
artifacts:
  - id: cycle-summary
    path: docs/cycle-summary.md
-->

## docs/cycle-summary.md

## Cycle 1 Summary

Completed successfully.`;

  const { mock, written, appended } = makeFsMock();
  const ram = new MockRunArtifactManager();
  const cm = new MockContextManager();
  const llm = new MockLLMProvider(summaryOutput, 60);
  const runner = new AgentRunner(cm as never, llm, root, ram as never, { model: 'test' }, mock);

  await runner.run('HISTORY', makeCycleState({ current_node: 'HISTORY' }));

  const summaryKey = join(root, 'docs/cycle-summary.md');
  assert.ok(written[summaryKey]?.includes('Cycle 1 Summary'), 'cycle-summary.md should be written');
  assert.ok(!appended[summaryKey], 'cycle-summary.md should NOT be in appended (it uses writeFile)');
});

test('AgentRunner BUILD: builder writes unrestricted src/ path', async () => {
  const root = makeTempDir();
  const builderOutput = `<!-- SLE-OUTPUT
role: builder
node: BUILD
artifacts:
  - id: main
    path: src/index.ts
  - id: util
    path: src/lib/util.ts
-->

## File: src/index.ts
\`\`\`typescript
export const main = () => console.log('hello');
\`\`\`

## File: src/lib/util.ts
\`\`\`typescript
export const helper = () => 42;
\`\`\``;

  const { mock, written } = makeFsMock();
  const ram = new MockRunArtifactManager();
  const cm = new MockContextManager();
  const llm = new MockLLMProvider(builderOutput, 200);
  const runner = new AgentRunner(cm as never, llm, root, ram as never, { model: 'test' }, mock);

  const result = await runner.run('BUILD', makeCycleState({ current_node: 'BUILD' }));

  assert.ok(result.success, result.error);
  assert.deepStrictEqual(result.artifacts_written, ['src/index.ts', 'src/lib/util.ts']);
  assert.ok(written[join(root, 'src/index.ts')]?.includes("console.log('hello')"));
  assert.ok(written[join(root, 'src/lib/util.ts')]?.includes('helper'));
});

console.log('# ✅ All Phase I tests passed!');
