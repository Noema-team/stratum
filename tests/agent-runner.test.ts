import { test } from 'node:test';
import { strict as assert } from 'assert';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import { promises as fs } from 'fs';
import { join } from 'path';
import {
  parseAgentOutput,
  buildUserMessage,
  validateOutputPath,
  AgentRunner,
  type AgentRunResult,
} from '../src/agent-runner.js';
import type { AssembledContext } from '../src/types.js';
import type { ILLMProvider, LLMCompletionParams, LLMCompletionResult } from '../src/llm-provider.js';
import type { ContextManager } from '../src/context-manager.js';
import type { StepRunContext } from '../src/workflow/types.js';
import type { RunArtifactManager } from '../src/run-artifacts.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'sle-agent-test-'));
}

function makeStepRunCtx(overrides: Partial<StepRunContext> = {}): StepRunContext {
  return {
    workflowRunId: 'test-run-1',
    workflowId: 'full-build',
    stepId: 'DESIGN',
    cycleNumber: 1,
    iteration: 1,
    revision: 0,
    planningDepth: 'standard',
    goal: 'Build a widget',
    projectRoot: '/test',
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

test('testParseStandardOutputDesigner', async () => {
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
});

test('testParseStandardOutputPlanner', async () => {
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
});

test('testParseBuilderOutputMultipleFiles', async () => {
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
});

test('testParseBuilderOutputStripsCodeFences', async () => {
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
});

test('testParseMissingPreambleThrows', async () => {
  const raw = `## docs/requirements.md\n\nSome content without preamble.`;

  assert.throws(
    () => parseAgentOutput(raw, 'designer'),
    /Missing SLE-OUTPUT preamble/
  );
});

test('testParseMissingArtifactsThrows', async () => {
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
});

test('testParsePositionalFallbackWhenHeaderPathMismatch', async () => {
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
});

test('testParseHistorianOutput', async () => {
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
});

// ─── buildUserMessage tests ───────────────────────────────────────────────────

test('testBuildUserMessageIncludesStateSummaryAndTask', async () => {
  const ctx = makeAssembledContext();
  const msg = buildUserMessage(ctx);

  assert.ok(msg.includes(ctx.state_summary));
  assert.ok(msg.includes(ctx.task));
});

test('testBuildUserMessageIncludesFailureContext', async () => {
  const ctx = makeAssembledContext({ failure_context: '## Previous Iteration Failure\nTests failed.' });
  const msg = buildUserMessage(ctx);

  assert.ok(msg.includes('Previous Iteration Failure'));
});

test('testBuildUserMessageIncludesArtifactSlices', async () => {
  const ctx = makeAssembledContext({
    artifact_slices: { requirements: '# Requirements\nContent.' },
  });
  const msg = buildUserMessage(ctx);

  assert.ok(msg.includes('Relevant Artifacts'));
  assert.ok(msg.includes('requirements'));
  assert.ok(msg.includes('Content.'));
});

test('testBuildUserMessageNoFailureContextWhenAbsent', async () => {
  const ctx = makeAssembledContext();
  const msg = buildUserMessage(ctx);

  assert.ok(!msg.includes('Previous Iteration Failure'));
  assert.ok(!msg.includes('Relevant Artifacts'));
});

test('testValidateOutputPathBuilderDenyList', async () => {
  // Builder cannot write to .sle/ or docs/
  assert.strictEqual(validateOutputPath('.sle/map.yaml', 'builder'), false);
  assert.strictEqual(validateOutputPath('.sle/runs/1-1/manifest.yaml', 'builder'), false);
  assert.strictEqual(validateOutputPath('docs/plan.md', 'builder'), false);
  assert.strictEqual(validateOutputPath('docs/architecture.md', 'builder'), false);
});

test('testValidateOutputPathBuilderAllowsSrc', async () => {
  // Builder can write to src/, tests/, config files, etc.
  assert.strictEqual(validateOutputPath('src/index.ts', 'builder'), true);
  assert.strictEqual(validateOutputPath('src/api/routes.ts', 'builder'), true);
  assert.strictEqual(validateOutputPath('package.json', 'builder'), true);
});

test('testValidateOutputPathEvaluatorAllowsEvaluationMd', async () => {
  // Evaluator output path must be docs/evaluation.md
  assert.strictEqual(validateOutputPath('docs/evaluation.md', 'evaluator'), true);
  assert.strictEqual(validateOutputPath('docs/evaluation-criteria.md', 'evaluator'), false);
});

// ─── AgentRunner integration tests ────────────────────────────────────────────

test('testRunnerWritesArtifactsToCorrectPaths', async () => {
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

  const result = await runner.run('designer', makeStepRunCtx({ stepId: 'DESIGN' }));

  assert.ok(result.success, `Expected success, got: ${result.error}`);
  assert.deepStrictEqual(result.artifacts_written, ['docs/requirements.md', 'docs/architecture.md']);
  assert.ok(written[join(root, 'docs/requirements.md')]?.includes('Feature content'));
  assert.ok(written[join(root, 'docs/architecture.md')]?.includes('Architecture content'));
  assert.strictEqual(result.tokens_used, 100);
});

test('testRunnerWritesRawOutputOnSuccess', async () => {
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

  const result = await runner.run('planner', makeStepRunCtx({ stepId: 'PLAN' }));

  assert.ok(result.success);
  assert.ok(result.raw_output_path.length > 0);
  assert.strictEqual(ram.written['PLAN'], output);
});

test('testRunnerReturnsFailureOnLLMError', async () => {
  const root = makeTempDir();
  const { mock } = makeFsMock();
  const ram = new MockRunArtifactManager();
  const cm = new MockContextManager(makeAssembledContext());
  const llm = new MockLLMProvider(new Error('Connection refused'));
  const runner = new AgentRunner(cm, llm, root, ram, { model: 'test-model' }, mock);

  const result = await runner.run('designer', makeStepRunCtx());

  assert.strictEqual(result.success, false);
  assert.ok(result.error?.includes('Connection refused'));
  assert.strictEqual(result.tokens_used, 0);
});

test('testRunnerReturnsFailureOnParseError', async () => {
  const root = makeTempDir();
  const { mock } = makeFsMock();
  const ram = new MockRunArtifactManager();
  const cm = new MockContextManager(makeAssembledContext());
  const llm = new MockLLMProvider('This output has no SLE-OUTPUT preamble at all.', 10);
  const runner = new AgentRunner(cm, llm, root, ram, { model: 'test-model' }, mock);

  const result = await runner.run('designer', makeStepRunCtx());

  assert.strictEqual(result.success, false);
  assert.ok(result.error?.includes('Output parsing failed'));
  assert.strictEqual(result.tokens_used, 10);
  // raw output still written even on parse failure
  assert.strictEqual(ram.written['DESIGN'], 'This output has no SLE-OUTPUT preamble at all.');
});

test('testRunnerPassesSystemPromptToLLM', async () => {
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

  await runner.run('tester', makeStepRunCtx({ stepId: 'TEST' }));

  assert.strictEqual(llm.calls.length, 1);
  const systemMsg = llm.calls[0].messages.find((m) => m.role === 'system');
  assert.ok(systemMsg?.content.includes('tester agent'));
});

test('testRunnerBuilderWritesMultipleFiles', async () => {
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

  const result = await runner.run('builder', makeStepRunCtx({ stepId: 'BUILD' }));

  assert.ok(result.success, `Expected success: ${result.error}`);
  assert.deepStrictEqual(result.artifacts_written, ['src/controller.ts', 'src/service.ts']);
  assert.strictEqual(written[join(root, 'src/controller.ts')], 'export const ctrl = {};');
  assert.strictEqual(written[join(root, 'src/service.ts')], 'export const svc = {};');
});

// ─── Runner ──────────────────────────────────────────────────────────────────
