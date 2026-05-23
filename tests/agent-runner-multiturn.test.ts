/**
 * Phase C: DDR-030 Multi-turn Agent Loop — 16 unit tests.
 *
 * Tests inject a mock IMultiTurnProvider and mock filesystem. No real API calls.
 * Mock responses are pre-programmed sequences that simulate tool_use and SLE-OUTPUT turns.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentLoop,
  MAX_AGENT_TURNS,
  type IMultiTurnProvider,
  type MultiTurnResult,
  type MultiTurnParams,
  type ToolUseBlock,
} from '../src/agent-loop.js';

// ─── Mock primitives ──────────────────────────────────────────────────────────

class SequenceMockProvider implements IMultiTurnProvider {
  public calls: MultiTurnParams[] = [];
  private responses: MultiTurnResult[];
  private idx = 0;

  constructor(responses: MultiTurnResult[]) {
    this.responses = responses;
  }

  async completeMultiTurn(params: MultiTurnParams): Promise<MultiTurnResult> {
    this.calls.push(params);
    if (this.idx >= this.responses.length) {
      return { stop_reason: 'end_turn', text: '', tool_uses: [], tokens_used: 1 };
    }
    return this.responses[this.idx++];
  }
}

function toolUseResult(
  name: string,
  input: Record<string, string>,
  id = 'tu_1'
): MultiTurnResult {
  const tu: ToolUseBlock = { type: 'tool_use', id, name, input };
  return { stop_reason: 'tool_use', text: '', tool_uses: [tu], tokens_used: 5 };
}

function sle(path: string, content: string): string {
  return `<<<SLE-OUTPUT>>>\n### ${path}\n${content}\n<<<END-SLE-OUTPUT>>>`;
}

function endTurnResult(text: string, tokens = 10): MultiTurnResult {
  return { stop_reason: 'end_turn', text, tool_uses: [], tokens_used: tokens };
}

function makeMockFs(files: Record<string, string>): typeof import('fs').promises {
  return {
    readFile: async (p: unknown) => {
      const key = p as string;
      if (key in files) return files[key];
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    readdir: async (p: unknown) => {
      const prefix = (p as string).replace(/\/?$/, '/');
      return Object.keys(files)
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length).split('/')[0]);
    },
    mkdir: async () => undefined,
    writeFile: async () => undefined,
    appendFile: async () => undefined,
  } as unknown as typeof import('fs').promises;
}

function makeRunArtifacts() {
  return {
    updateNodeStatus: async () => {},
    writeNodeOutput: async () => {},
  } as never;
}

function makeLoop(
  provider: IMultiTurnProvider,
  opts: Partial<Parameters<typeof AgentLoop['prototype']['run']>[0]> = {},
  root = '/project'
) {
  const loop = new AgentLoop(provider, {
    model: 'claude-sonnet-4-6',
    projectRoot: root,
    role: 'designer',
    cycleNumber: 1,
    iteration: 1,
    nodeId: 'DESIGN',
    runArtifacts: makeRunArtifacts(),
    fsModule: makeMockFs({}),
  });
  return loop;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test('Multi-turn: single turn — agent returns SLE-OUTPUT immediately, loop exits', async () => {
  const provider = new SequenceMockProvider([
    endTurnResult(sle('docs/requirements.md', '# Requirements')),
  ]);
  const loop = makeLoop(provider);

  const result = await loop.run('System prompt', 'Build a widget.');

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.turns_taken, 1);
  assert.strictEqual(result.parsedOutput?.sections.length, 1);
  assert.strictEqual(result.parsedOutput?.sections[0].path, 'docs/requirements.md');
});

test('Multi-turn: two turns — agent calls read_file, gets result, returns SLE-OUTPUT', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sle-loop-test-'));
  const docsPath = join(root, 'docs');
  await fs.mkdir(docsPath, { recursive: true });
  await fs.writeFile(join(root, 'docs/requirements.md'), '# Existing Requirements', 'utf-8');

  const provider = new SequenceMockProvider([
    toolUseResult('read_file', { path: 'docs/requirements.md' }),
    endTurnResult(sle('docs/architecture.md', '# Architecture')),
  ]);
  const loop = new AgentLoop(provider, {
    model: 'test',
    projectRoot: root,
    role: 'designer',
    cycleNumber: 1,
    iteration: 1,
    nodeId: 'DESIGN',
    runArtifacts: makeRunArtifacts(),
  });

  const result = await loop.run('System', 'Design the architecture.');

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.turns_taken, 2);
  // Second call should have included tool_result content
  assert.strictEqual(provider.calls.length, 2);
  const secondCallMessages = provider.calls[1].messages;
  const lastMsg = secondCallMessages[secondCallMessages.length - 1];
  assert.strictEqual(lastMsg.role, 'user');
  assert.ok(Array.isArray(lastMsg.content), 'tool results are array content');

  await fs.rm(root, { recursive: true, force: true });
});

test('Multi-turn: three turns — agent calls read_file twice, then returns SLE-OUTPUT', async () => {
  const provider = new SequenceMockProvider([
    toolUseResult('read_file', { path: 'docs/requirements.md' }, 'tu_1'),
    toolUseResult('read_file', { path: 'docs/architecture.md' }, 'tu_2'),
    endTurnResult(sle('docs/requirements.md', '# Updated')),
  ]);
  const loop = makeLoop(provider);

  const result = await loop.run('System', 'Read two files then produce output.');

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.turns_taken, 3);
  assert.strictEqual(provider.calls.length, 3);
});

test('Multi-turn: max turns exceeded → error, node marked failed', async () => {
  // Always returns tool_use, never SLE-OUTPUT
  const infiniteToolUse = new SequenceMockProvider(
    Array.from({ length: MAX_AGENT_TURNS + 2 }, () =>
      toolUseResult('read_file', { path: 'docs/requirements.md' })
    )
  );
  const loop = makeLoop(infiniteToolUse);

  const result = await loop.run('System', 'Loop forever.');

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.turns_taken, MAX_AGENT_TURNS);
  assert.ok(result.error?.includes(String(MAX_AGENT_TURNS)));
});

test('Multi-turn: tool call with path outside read allowlist → tool returns error, not exception', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sle-loop-test-'));

  const provider = new SequenceMockProvider([
    toolUseResult('read_file', { path: '/etc/passwd.md' }),
    endTurnResult(sle('docs/requirements.md', '# Requirements')),
  ]);
  const loop = new AgentLoop(provider, {
    model: 'test',
    projectRoot: root,
    role: 'designer',
    cycleNumber: 1,
    iteration: 1,
    nodeId: 'DESIGN',
    runArtifacts: makeRunArtifacts(),
  });

  // Should NOT throw — error returned in tool_result content
  const result = await loop.run('System', 'Try to read a forbidden path.');

  assert.strictEqual(result.success, true); // loop continues after tool error
  assert.ok(provider.calls.length >= 2, 'should have retried after tool error');

  await fs.rm(root, { recursive: true, force: true });
});

test('Multi-turn: list_directory returns file list correctly', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sle-loop-test-'));
  const docsPath = join(root, 'docs');
  await fs.mkdir(docsPath, { recursive: true });
  await fs.writeFile(join(docsPath, 'requirements.md'), '# Req', 'utf-8');
  await fs.writeFile(join(docsPath, 'architecture.md'), '# Arch', 'utf-8');

  const provider = new SequenceMockProvider([
    toolUseResult('list_directory', { path: 'docs/' }),
    endTurnResult(sle('docs/requirements.md', '# Requirements')),
  ]);
  const loop = new AgentLoop(provider, {
    model: 'test',
    projectRoot: root,
    role: 'designer',
    cycleNumber: 1,
    iteration: 1,
    nodeId: 'DESIGN',
    runArtifacts: makeRunArtifacts(),
  });

  const result = await loop.run('System', 'List docs.');

  assert.strictEqual(result.success, true);
  // Verify the tool_result message sent to the LLM contains the file list
  const secondCall = provider.calls[1];
  const toolResultMsg = secondCall.messages[secondCall.messages.length - 1];
  const content = Array.isArray(toolResultMsg.content) ? toolResultMsg.content : [];
  const toolResult = content.find((b: { type: string }) => b.type === 'tool_result') as
    | { type: 'tool_result'; content: string }
    | undefined;
  assert.ok(toolResult?.content.includes('requirements.md'), 'file list should include requirements.md');

  await fs.rm(root, { recursive: true, force: true });
});

test('Multi-turn: read_file returns file contents correctly', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sle-loop-test-'));
  const docsPath = join(root, 'docs');
  await fs.mkdir(docsPath, { recursive: true });
  await fs.writeFile(join(docsPath, 'existing.md'), '# Existing Content', 'utf-8');

  const provider = new SequenceMockProvider([
    toolUseResult('read_file', { path: 'docs/existing.md' }),
    endTurnResult(sle('docs/requirements.md', '# Requirements')),
  ]);
  const loop = new AgentLoop(provider, {
    model: 'test',
    projectRoot: root,
    role: 'designer',
    cycleNumber: 1,
    iteration: 1,
    nodeId: 'DESIGN',
    runArtifacts: makeRunArtifacts(),
  });

  await loop.run('System', 'Read and produce.');

  const secondCall = provider.calls[1];
  const content = Array.isArray(secondCall.messages[secondCall.messages.length - 1].content)
    ? (secondCall.messages[secondCall.messages.length - 1].content as Array<{ type: string; content?: string }>)
    : [];
  const toolResult = content.find((b) => b.type === 'tool_result');
  assert.ok(toolResult?.content?.includes('Existing Content'), 'should return file contents');

  await fs.rm(root, { recursive: true, force: true });
});

test('Multi-turn: read_file on non-existent file → tool returns error (no exception)', async () => {
  const provider = new SequenceMockProvider([
    toolUseResult('read_file', { path: 'docs/nonexistent.md' }),
    endTurnResult(sle('docs/requirements.md', '# Requirements')),
  ]);
  const loop = makeLoop(provider);

  const result = await loop.run('System', 'Read missing file.');

  // Loop should continue, not throw
  assert.strictEqual(result.success, true);
  const secondCall = provider.calls[1];
  const content = Array.isArray(secondCall.messages[secondCall.messages.length - 1].content)
    ? (secondCall.messages[secondCall.messages.length - 1].content as Array<{ type: string; content?: string }>)
    : [];
  const toolResult = content.find((b) => b.type === 'tool_result');
  assert.ok(toolResult?.content?.includes('file not found'));
});

test('Multi-turn: turn count written to run artifacts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sle-loop-test-'));
  const docsPath = join(root, 'docs');
  await fs.mkdir(docsPath, { recursive: true });

  const provider = new SequenceMockProvider([
    toolUseResult('read_file', { path: 'docs/requirements.md' }),
    endTurnResult(sle('docs/requirements.md', '# Requirements')),
  ]);
  const loop = new AgentLoop(provider, {
    model: 'test',
    projectRoot: root,
    role: 'designer',
    cycleNumber: 1,
    iteration: 1,
    nodeId: 'DESIGN',
    runArtifacts: makeRunArtifacts(),
  });

  const result = await loop.run('System', 'Two turns.');

  assert.strictEqual(result.turns_taken, 2);
  // Metadata file should have been written
  const metaPath = join(root, '.sle', 'runs', '1-1', 'node-outputs', 'design-loop.json');
  const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8'));
  assert.strictEqual(meta.turns_taken, 2);

  await fs.rm(root, { recursive: true, force: true });
});

test('Multi-turn: tool call log written to run artifacts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sle-loop-test-'));
  const docsPath = join(root, 'docs');
  await fs.mkdir(docsPath, { recursive: true });

  const provider = new SequenceMockProvider([
    toolUseResult('read_file', { path: 'docs/requirements.md' }, 'tu_1'),
    endTurnResult(sle('docs/requirements.md', '# Requirements')),
  ]);
  const loop = new AgentLoop(provider, {
    model: 'test',
    projectRoot: root,
    role: 'designer',
    cycleNumber: 1,
    iteration: 1,
    nodeId: 'DESIGN',
    runArtifacts: makeRunArtifacts(),
  });

  await loop.run('System', 'With tool call.');

  const metaPath = join(root, '.sle', 'runs', '1-1', 'node-outputs', 'design-loop.json');
  const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8'));
  assert.strictEqual(meta.tool_calls.length, 1);
  assert.strictEqual(meta.tool_calls[0].tool, 'read_file');
  assert.strictEqual(meta.tool_calls[0].turn, 1);

  await fs.rm(root, { recursive: true, force: true });
});

test('Multi-turn: stop_reason=tool_use handled, stop_reason=end_turn without SLE-OUTPUT → error', async () => {
  const provider = new SequenceMockProvider([
    endTurnResult('This is my answer but it has no SLE-OUTPUT block.'),
  ]);
  const loop = makeLoop(provider);

  const result = await loop.run('System', 'Produce output.');

  assert.strictEqual(result.success, false);
  assert.ok(result.error?.includes('SLE-OUTPUT'));
});

test('Multi-turn: stop_reason=max_tokens → treated as agent failure', async () => {
  const provider = new SequenceMockProvider([
    { stop_reason: 'max_tokens', text: 'partial...', tool_uses: [], tokens_used: 4096 },
  ]);
  const loop = makeLoop(provider);

  const result = await loop.run('System', 'Produce output.');

  assert.strictEqual(result.success, false);
  assert.ok(result.error?.includes('max_tokens'));
});

test('Multi-turn: malformed tool input (missing path) → tool returns error', async () => {
  const provider = new SequenceMockProvider([
    { stop_reason: 'tool_use', text: '', tool_uses: [{ type: 'tool_use', id: 'tu_1', name: 'read_file', input: {} }], tokens_used: 5 },
    endTurnResult(sle('docs/requirements.md', '# Requirements')),
  ]);
  const loop = makeLoop(provider);

  const result = await loop.run('System', 'Bad tool call.');

  assert.strictEqual(result.success, true); // loop continues despite bad input
  const secondCallContent = provider.calls[1].messages.at(-1)?.content;
  const blocks = Array.isArray(secondCallContent) ? secondCallContent as Array<{ type: string; content?: string }> : [];
  const toolResult = blocks.find((b) => b.type === 'tool_result');
  assert.ok(toolResult?.content?.includes('invalid input'));
});

test('Multi-turn: loop messages accumulate correctly across turns', async () => {
  const provider = new SequenceMockProvider([
    toolUseResult('read_file', { path: 'docs/requirements.md' }, 'tu_1'),
    toolUseResult('list_directory', { path: 'docs/' }, 'tu_2'),
    endTurnResult(sle('docs/requirements.md', '# Updated')),
  ]);
  const loop = makeLoop(provider);

  await loop.run('System', 'Initial message.');

  // Turn 1: 1 user message
  assert.strictEqual(provider.calls[0].messages.length, 1);
  // Turn 2: 1 user + 1 assistant (tool_use) + 1 user (tool_result)
  assert.strictEqual(provider.calls[1].messages.length, 3);
  // Turn 3: above + 1 assistant + 1 user (tool_result) = 5
  assert.strictEqual(provider.calls[2].messages.length, 5);
});

test('Multi-turn: SLE-OUTPUT in turn 1 and SLE-OUTPUT in turn 3 both parsed correctly', async () => {
  // Turn 1 test
  const prov1 = new SequenceMockProvider([
    endTurnResult(sle('docs/requirements.md', '# Turn-1 Output')),
  ]);
  const loop1 = makeLoop(prov1);
  const r1 = await loop1.run('System', 'Fast.');
  assert.strictEqual(r1.success, true);
  assert.strictEqual(r1.turns_taken, 1);
  assert.ok(r1.parsedOutput?.sections[0].content.includes('Turn-1'));

  // Turn 3 test
  const prov3 = new SequenceMockProvider([
    toolUseResult('read_file', { path: 'docs/requirements.md' }, 'tu_1'),
    toolUseResult('list_directory', { path: 'docs/' }, 'tu_2'),
    endTurnResult(sle('docs/requirements.md', '# Turn-3 Output')),
  ]);
  const loop3 = makeLoop(prov3);
  const r3 = await loop3.run('System', 'Slow.');
  assert.strictEqual(r3.success, true);
  assert.strictEqual(r3.turns_taken, 3);
  assert.ok(r3.parsedOutput?.sections[0].content.includes('Turn-3'));
});

test('Multi-turn: ParseError on SLE-OUTPUT → retry prompt issued (Phase B contract)', async () => {
  const malformed = '<<<SLE-OUTPUT>>>\n### docs/requirements.md\n\n<<<END-SLE-OUTPUT>>>'; // empty content → ParseError
  const valid = sle('docs/requirements.md', '# Valid Content');
  let retryCalled = false;

  // Turn 1: malformed output; turn 2 (retry): valid output
  const provider: IMultiTurnProvider = {
    async completeMultiTurn() {
      if (!retryCalled) {
        // First call returns malformed
        retryCalled = true;
        return { stop_reason: 'end_turn', text: malformed, tool_uses: [], tokens_used: 10 };
      }
      // Retry call returns valid
      return { stop_reason: 'end_turn', text: valid, tool_uses: [], tokens_used: 10 };
    },
  };
  const loop = makeLoop(provider);

  const result = await loop.run('System', 'Produce output.');

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.parsedOutput?.sections[0].path, 'docs/requirements.md');
});
