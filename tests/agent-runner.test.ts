import { strict as assert } from 'assert';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import { promises as fs } from 'fs';
import { join } from 'path';
import {
  parseAgentOutput,
  buildUserMessage,
  roleForNode,
  AgentRunner,
  type AgentRunResult,
} from '../src/agent-runner.js';
import type { AssembledContext } from '../src/types.js';
import type { ILLMProvider, LLMCompletionParams, LLMCompletionResult } from '../src/llm-provider.js';
import type { ContextManager, CycleStateContext } from '../src/context-manager.js';
import type { RunArtifactManager } from '../src/run-artifacts.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'sle-agent-test-'));
}

function makeCycleState(overrides: Partial<CycleStateContext> = {}): CycleStateContext {
  return {
    cycle_number: 1,
    iteration: 1,
    planning_depth: 'standard',
    intent: 'Build a widget',
    current_node: 'DESIGN',
    ...overrides,
  };
}

function makeAssembledContext(overrides: Partial<AssembledContext> = {}): AssembledContext {
  return {
    system_prompt: 'You are a designer.',
    artifact_slices: {},
    state_summary: '## Current State\n- Cycle: 1',
    task: 'Design the requirements.',
    token_count: 100,
    truncated: [],
    ...overrides,
  };
}

// ─── Mock LLM provider ────────────────────────────────────────────────────────

class MockLLMProvider implements ILLMProvider {
  public calls: LLMCompletionParams[] = [];
  constructor(private response: string | Error, private tokensUsed = 42) {}

  async complete(params: LLMCompletionParams): Promise<LLMCompletionResult> {
    this.calls.push(params);
    if (this.response instanceof Error) throw this.response;
    return { content: this.response, tokens_used: this.tokensUsed, duration_ms: 5 };
  }
}

// ─── Mock ContextManager ──────────────────────────────────────────────────────

class MockContextManager implements ContextManager {
  constructor(private ctx: AssembledContext) {}

  async assemble(_role: unknown, _cycleState: unknown): Promise<AssembledContext> {
    return this.ctx;
  }
}

// ─── Mock RunArtifactManager ──────────────────────────────────────────────────

class MockRunArtifactManager implements RunArtifactManager {
  public written: Record<string, string> = {};

  async writeNodeOutput(_cn: number, _it: number, node: string, content: string): Promise<void> {
    this.written[node] = content;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

// ─── Mock FS ─────────────────────────────────────────────────────────────────

function makeFsMock(files: Record<string, string> = {}): {
  mock: typeof import('fs').promises;
  written: Record<string, string>;
  dirs: Set<string>;
} {
  const written: Record<string, string> = { ...files };
  const dirs = new Set<string>();

  const mock = {
    mkdir: async (dirPath: unknown) => { dirs.add(dirPath as string); },
    writeFile: async (filePath: unknown, content: unknown) => {
      written[filePath as string] = content as string;
    },
    appendFile: async (filePath: unknown, content: unknown) => {
      const key = filePath as string;
      written[key] = (written[key] ?? '') + (content as string);
    },
    readFile: async (filePath: unknown) => {
      const p = filePath as string;
      if (p in written) return written[p];
      const err = Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      throw err;
    },
  } as unknown as typeof import('fs').promises;

  return { mock, written, dirs };
}

// ─── parseAgentOutput tests ───────────────────────────────────────────────────

async function testParseStandardOutputDesigner() {
  const raw = `<!-- SLE-OUTPUT
role: designer
node: DESIGN
artifacts:
  - id: requirements
    path: docs/requirements.md
  - id: architecture
    path: docs/architecture.md
-->

## docs/requirements.md

# Requirements

Feature A should do X.

---

## docs/architecture.md

# Architecture

Use service pattern.`;

  const parsed = parseAgentOutput(raw, 'designer');
  assert.strictEqual(parsed.preamble.role, 'designer');
  assert.strictEqual(parsed.preamble.node, 'DESIGN');
  assert.strictEqual(parsed.sections.length, 2);
  assert.strictEqual(parsed.sections[0].path, 'docs/requirements.md');
  assert.ok(parsed.sections[0].content.includes('Feature A'));
  assert.strictEqual(parsed.sections[1].path, 'docs/architecture.md');
  assert.ok(parsed.sections[1].content.includes('service pattern'));
}

async function testParseStandardOutputPlanner() {
  const raw = `<!-- SLE-OUTPUT
role: planner
node: PLAN
artifacts:
  - id: plan
    path: docs/plan.md
-->

## docs/plan.md

# Implementation Plan

Step 1: Do thing.`;

  const parsed = parseAgentOutput(raw, 'planner');
  assert.strictEqual(parsed.sections.length, 1);
  assert.strictEqual(parsed.sections[0].path, 'docs/plan.md');
  assert.ok(parsed.sections[0].content.includes('Step 1'));
}

async function testParseBuilderOutputMultipleFiles() {
  const raw = `<!-- SLE-OUTPUT
role: builder
node: BUILD
artifacts:
  - id: implementation
    path: src/
-->

## File: src/items/controller.ts

\`\`\`typescript
export class Controller {}
\`\`\`

## File: src/items/service.ts

\`\`\`typescript
export class Service {}
\`\`\``;

  const parsed = parseAgentOutput(raw, 'builder');
  assert.strictEqual(parsed.sections.length, 2);
  assert.strictEqual(parsed.sections[0].path, 'src/items/controller.ts');
  assert.ok(parsed.sections[0].content.includes('export class Controller'));
  assert.strictEqual(parsed.sections[1].path, 'src/items/service.ts');
  assert.ok(parsed.sections[1].content.includes('export class Service'));
}

async function testParseBuilderOutputStripsCodeFences() {
  const raw = `<!-- SLE-OUTPUT
role: builder
node: BUILD
artifacts:
  - id: impl
    path: src/
-->

## File: src/index.ts

\`\`\`typescript
const x = 1;
\`\`\``;

  const parsed = parseAgentOutput(raw, 'builder');
  assert.strictEqual(parsed.sections[0].content, 'const x = 1;');
}

async function testParseMissingPreambleThrows() {
  const raw = `## docs/requirements.md\n\nSome content without preamble.`;

  assert.throws(
    () => parseAgentOutput(raw, 'designer'),
    /Missing SLE-OUTPUT preamble/
  );
}

async function testParseMissingArtifactsThrows() {
  const raw = `<!-- SLE-OUTPUT
role: designer
node: DESIGN
-->

## docs/requirements.md

Content.`;

  assert.throws(
    () => parseAgentOutput(raw, 'designer'),
    /missing artifacts list/
  );
}

async function testParsePositionalFallbackWhenHeaderPathMismatch() {
  const raw = `<!-- SLE-OUTPUT
role: planner
node: PLAN
artifacts:
  - id: plan
    path: docs/plan.md
-->

## Implementation Plan

Step 1: Do thing.`;

  const parsed = parseAgentOutput(raw, 'planner');
  // fallback: positional matching assigns content to first artifact
  assert.strictEqual(parsed.sections.length, 1);
  assert.strictEqual(parsed.sections[0].path, 'docs/plan.md');
  assert.ok(parsed.sections[0].content.includes('Step 1'));
}

async function testParseHistorianOutput() {
  const raw = `<!-- SLE-OUTPUT
role: historian
node: HISTORY
artifacts:
  - id: decisions
    path: docs/decisions.md
-->

## docs/decisions.md

## 2026-05-15: Chose service pattern

Rationale: clean separation.`;

  const parsed = parseAgentOutput(raw, 'historian');
  assert.strictEqual(parsed.sections.length, 1);
  assert.ok(parsed.sections[0].content.includes('service pattern'));
}

// ─── buildUserMessage tests ───────────────────────────────────────────────────

async function testBuildUserMessageIncludesStateSummaryAndTask() {
  const ctx = makeAssembledContext();
  const msg = buildUserMessage(ctx);

  assert.ok(msg.includes(ctx.state_summary));
  assert.ok(msg.includes(ctx.task));
}

async function testBuildUserMessageIncludesFailureContext() {
  const ctx = makeAssembledContext({ failure_context: '## Previous Iteration Failure\nTests failed.' });
  const msg = buildUserMessage(ctx);

  assert.ok(msg.includes('Previous Iteration Failure'));
}

async function testBuildUserMessageIncludesArtifactSlices() {
  const ctx = makeAssembledContext({
    artifact_slices: { requirements: '# Requirements\nContent.' },
  });
  const msg = buildUserMessage(ctx);

  assert.ok(msg.includes('Relevant Artifacts'));
  assert.ok(msg.includes('requirements'));
  assert.ok(msg.includes('Content.'));
}

async function testBuildUserMessageNoFailureContextWhenAbsent() {
  const ctx = makeAssembledContext();
  const msg = buildUserMessage(ctx);

  assert.ok(!msg.includes('Previous Iteration Failure'));
  assert.ok(!msg.includes('Relevant Artifacts'));
}

// ─── roleForNode tests ────────────────────────────────────────────────────────

async function testRoleForNodeKnownNodes() {
  assert.strictEqual(roleForNode('SCOPING'), 'facilitator');
  assert.strictEqual(roleForNode('DESIGN'), 'designer');
  assert.strictEqual(roleForNode('PLAN'), 'planner');
  assert.strictEqual(roleForNode('TEST'), 'tester');
  assert.strictEqual(roleForNode('BUILD'), 'builder');
  assert.strictEqual(roleForNode('HISTORY'), 'historian');
  assert.strictEqual(roleForNode('EVALUATE'), 'evaluator');
  assert.strictEqual(roleForNode('SUMMARISE'), 'historian');
}

async function testRoleForNodeUnknownReturnsUndefined() {
  assert.strictEqual(roleForNode('EXEC'), undefined);
  assert.strictEqual(roleForNode('VALIDATION_GATE'), undefined);
  assert.strictEqual(roleForNode('SNAPSHOT'), undefined);
  assert.strictEqual(roleForNode('NONEXISTENT'), undefined);
}

// ─── AgentRunner integration tests ────────────────────────────────────────────

async function testRunnerWritesArtifactsToCorrectPaths() {
  const root = makeTempDir();
  const output = `<!-- SLE-OUTPUT
role: designer
node: DESIGN
artifacts:
  - id: requirements
    path: docs/requirements.md
  - id: architecture
    path: docs/architecture.md
-->

## docs/requirements.md

Feature content.

---

## docs/architecture.md

Architecture content.`;

  const { mock, written } = makeFsMock();
  const ram = new MockRunArtifactManager();
  const cm = new MockContextManager(makeAssembledContext());
  const llm = new MockLLMProvider(output, 100);
  const runner = new AgentRunner(cm, llm, root, ram, { model: 'test-model' }, mock);

  const result = await runner.run('DESIGN', makeCycleState({ current_node: 'DESIGN' }));

  assert.ok(result.success, `Expected success, got: ${result.error}`);
  assert.deepStrictEqual(result.artifacts_written, ['docs/requirements.md', 'docs/architecture.md']);
  assert.ok(written[join(root, 'docs/requirements.md')]?.includes('Feature content'));
  assert.ok(written[join(root, 'docs/architecture.md')]?.includes('Architecture content'));
  assert.strictEqual(result.tokens_used, 100);
}

async function testRunnerWritesRawOutputOnSuccess() {
  const root = makeTempDir();
  const output = `<!-- SLE-OUTPUT
role: planner
node: PLAN
artifacts:
  - id: plan
    path: docs/plan.md
-->

## docs/plan.md

Step 1.`;

  const { mock } = makeFsMock();
  const ram = new MockRunArtifactManager();
  const cm = new MockContextManager(makeAssembledContext());
  const llm = new MockLLMProvider(output);
  const runner = new AgentRunner(cm, llm, root, ram, { model: 'test-model' }, mock);

  const result = await runner.run('PLAN', makeCycleState({ current_node: 'PLAN' }));

  assert.ok(result.success);
  assert.ok(result.raw_output_path.length > 0);
  assert.strictEqual(ram.written['PLAN'], output);
}

async function testRunnerReturnsFailureOnLLMError() {
  const root = makeTempDir();
  const { mock } = makeFsMock();
  const ram = new MockRunArtifactManager();
  const cm = new MockContextManager(makeAssembledContext());
  const llm = new MockLLMProvider(new Error('Connection refused'));
  const runner = new AgentRunner(cm, llm, root, ram, { model: 'test-model' }, mock);

  const result = await runner.run('DESIGN', makeCycleState());

  assert.strictEqual(result.success, false);
  assert.ok(result.error?.includes('Connection refused'));
  assert.strictEqual(result.tokens_used, 0);
}

async function testRunnerReturnsFailureOnParseError() {
  const root = makeTempDir();
  const { mock } = makeFsMock();
  const ram = new MockRunArtifactManager();
  const cm = new MockContextManager(makeAssembledContext());
  const llm = new MockLLMProvider('This output has no SLE-OUTPUT preamble at all.', 10);
  const runner = new AgentRunner(cm, llm, root, ram, { model: 'test-model' }, mock);

  const result = await runner.run('DESIGN', makeCycleState());

  assert.strictEqual(result.success, false);
  assert.ok(result.error?.includes('Output parsing failed'));
  assert.strictEqual(result.tokens_used, 10);
  // raw output still written even on parse failure
  assert.strictEqual(ram.written['DESIGN'], 'This output has no SLE-OUTPUT preamble at all.');
}

async function testRunnerReturnsFailureForUnknownNode() {
  const root = makeTempDir();
  const { mock } = makeFsMock();
  const ram = new MockRunArtifactManager();
  const cm = new MockContextManager(makeAssembledContext());
  const llm = new MockLLMProvider('anything');
  const runner = new AgentRunner(cm, llm, root, ram, { model: 'test-model' }, mock);

  const result = await runner.run('EXEC', makeCycleState({ current_node: 'EXEC' }));

  assert.strictEqual(result.success, false);
  assert.ok(result.error?.includes('No agent role mapped'));
}

async function testRunnerPassesSystemPromptToLLM() {
  const root = makeTempDir();
  const output = `<!-- SLE-OUTPUT
role: tester
node: TEST
artifacts:
  - id: test-plan
    path: docs/test-plan.md
-->

## docs/test-plan.md

Test plan content.`;

  const { mock } = makeFsMock();
  const ram = new MockRunArtifactManager();
  const ctx = makeAssembledContext({ system_prompt: 'You are a tester agent.' });
  const cm = new MockContextManager(ctx);
  const llm = new MockLLMProvider(output);
  const runner = new AgentRunner(cm, llm, root, ram, { model: 'test-model' }, mock);

  await runner.run('TEST', makeCycleState({ current_node: 'TEST' }));

  assert.strictEqual(llm.calls.length, 1);
  const systemMsg = llm.calls[0].messages.find((m) => m.role === 'system');
  assert.ok(systemMsg?.content.includes('tester agent'));
}

async function testRunnerBuilderWritesMultipleFiles() {
  const root = makeTempDir();
  const output = `<!-- SLE-OUTPUT
role: builder
node: BUILD
artifacts:
  - id: impl
    path: src/
-->

## File: src/controller.ts

\`\`\`typescript
export const ctrl = {};
\`\`\`

## File: src/service.ts

\`\`\`typescript
export const svc = {};
\`\`\``;

  const { mock, written } = makeFsMock();
  const ram = new MockRunArtifactManager();
  const cm = new MockContextManager(makeAssembledContext());
  const llm = new MockLLMProvider(output);
  const runner = new AgentRunner(cm, llm, root, ram, { model: 'test-model' }, mock);

  const result = await runner.run('BUILD', makeCycleState({ current_node: 'BUILD' }));

  assert.ok(result.success, `Expected success: ${result.error}`);
  assert.deepStrictEqual(result.artifacts_written, ['src/controller.ts', 'src/service.ts']);
  assert.strictEqual(written[join(root, 'src/controller.ts')], 'export const ctrl = {};');
  assert.strictEqual(written[join(root, 'src/service.ts')], 'export const svc = {};');
}

// ─── Runner ──────────────────────────────────────────────────────────────────

async function runAllTests() {
  console.log('Running Phase D (Agent Runner) tests...\n');

  const tests: Array<{ name: string; fn: () => Promise<void> }> = [
    { name: 'parseAgentOutput: standard format (designer)', fn: testParseStandardOutputDesigner },
    { name: 'parseAgentOutput: standard format (planner)', fn: testParseStandardOutputPlanner },
    { name: 'parseAgentOutput: builder multiple files', fn: testParseBuilderOutputMultipleFiles },
    { name: 'parseAgentOutput: builder strips code fences', fn: testParseBuilderOutputStripsCodeFences },
    { name: 'parseAgentOutput: missing preamble throws', fn: testParseMissingPreambleThrows },
    { name: 'parseAgentOutput: missing artifacts throws', fn: testParseMissingArtifactsThrows },
    { name: 'parseAgentOutput: positional fallback on header mismatch', fn: testParsePositionalFallbackWhenHeaderPathMismatch },
    { name: 'parseAgentOutput: historian output', fn: testParseHistorianOutput },
    { name: 'buildUserMessage: includes state summary and task', fn: testBuildUserMessageIncludesStateSummaryAndTask },
    { name: 'buildUserMessage: includes failure context', fn: testBuildUserMessageIncludesFailureContext },
    { name: 'buildUserMessage: includes artifact slices', fn: testBuildUserMessageIncludesArtifactSlices },
    { name: 'buildUserMessage: no failure context when absent', fn: testBuildUserMessageNoFailureContextWhenAbsent },
    { name: 'roleForNode: known nodes map correctly', fn: testRoleForNodeKnownNodes },
    { name: 'roleForNode: unknown nodes return undefined', fn: testRoleForNodeUnknownReturnsUndefined },
    { name: 'AgentRunner: writes artifacts to correct paths', fn: testRunnerWritesArtifactsToCorrectPaths },
    { name: 'AgentRunner: writes raw output on success', fn: testRunnerWritesRawOutputOnSuccess },
    { name: 'AgentRunner: returns failure on LLM error', fn: testRunnerReturnsFailureOnLLMError },
    { name: 'AgentRunner: returns failure on parse error', fn: testRunnerReturnsFailureOnParseError },
    { name: 'AgentRunner: returns failure for unknown node', fn: testRunnerReturnsFailureForUnknownNode },
    { name: 'AgentRunner: passes system prompt to LLM', fn: testRunnerPassesSystemPromptToLLM },
    { name: 'AgentRunner: builder writes multiple files', fn: testRunnerBuilderWritesMultipleFiles },
  ];

  const failures: Array<{ name: string; error: unknown }> = [];

  for (const test of tests) {
    try {
      await test.fn();
      console.log(`  ✓ ${test.name}`);
    } catch (error) {
      console.error(`  ✗ ${test.name}`);
      failures.push({ name: test.name, error });
    }
  }

  if (failures.length > 0) {
    console.error(`\n❌ ${failures.length}/${tests.length} Phase D tests FAILED:`);
    for (const f of failures) {
      console.error(`  - ${f.name}`);
      console.error(`    ${f.error instanceof Error ? f.error.message : String(f.error)}`);
    }
    throw failures[0].error;
  }

  console.log(`\n✅ All ${tests.length} Phase D tests passed!`);
}

runAllTests();
