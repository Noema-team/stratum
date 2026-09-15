// E3a — failure evidence closure (C7/F6): a FAILED multi-turn step must leave
// evidence that explains itself. The raw node output carries a bounded
// step-failure-observation (stop_reason, text_length in real UTF-8 bytes,
// tool names + argument byte lengths, repair counters, negotiated transport)
// instead of being silently replaced with '', and the loop's -loop.json turn
// metadata exists on the failure path exactly as on success. Never reply
// text, never hidden reasoning text.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AgentLoop,
  type MultiTurnResult,
  type AgentLoopResult,
  type AgentLoopOptions,
} from '../src/agent-loop.js';
import { AgentRunner } from '../src/agent-runner.js';
import { RunArtifactManager } from '../src/run-artifacts.js';
import type { StepRunContext } from '../src/workflow/types.js';
import type { AssembledContext } from '../src/context-manager.js';

class ScriptedContextManager {
  async assemble(): Promise<AssembledContext> {
    return {
      system_prompt: 'sys',
      artifact_slices: {},
      state_summary: 'state',
      task: 'task',
      token_count: 1,
      truncated: [],
    };
  }
}

function makeCtx(overrides: Partial<StepRunContext> = {}): StepRunContext {
  return {
    workflowRunId: 'run-e3a',
    workflowId: 'define-work',
    stepId: 'synthesize_definition',
    iteration: 1,
    revision: 0,
    goal: 'g',
    projectRoot: '/proj',
    role: 'explorer',
    ...overrides,
  } as StepRunContext;
}

function loopOpts(root: string, extra: Partial<AgentLoopOptions> = {}): AgentLoopOptions {
  return {
    model: 'test-model',
    projectRoot: root,
    role: 'explorer',
    workflowRunId: 'run-e3a',
    iteration: 1,
    nodeId: 'synthesize_definition',
    runArtifacts: new RunArtifactManager({ projectRoot: root }),
    ...extra,
  };
}

test('E3a: failed end_turn turn (absent block, repair exhausted) carries the observation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'e3a-'));
  try {
    const provider = {
      async completeMultiTurn(_p: unknown): Promise<MultiTurnResult> {
        // both turns reply with prose and no result block → repair once, then
        // the shared fail-closed budget exhausts
        return { stop_reason: 'end_turn', text: 'prose without any result block', tool_uses: [], tokens_used: 5 } as unknown as MultiTurnResult;
      },
    };
    const loop = new AgentLoop(provider as never, loopOpts(root));
    const result: AgentLoopResult = await loop.run('system', 'user task');
    assert.equal(result.success, false);
    const obs = result.failure_observation!;
    assert.ok(obs, 'failure_observation must be present');
    assert.equal(obs.stop_reason, 'end_turn');
    assert.equal(obs.text_length, 'prose without any result block'.length);
    assert.equal(obs.format_repairs, 1);
    assert.equal(obs.turns_taken, 2);
    assert.ok(obs.result_transport.length > 0);
    // bounded observation: never the reply text itself
    const serialized = JSON.stringify(obs);
    assert.ok(!serialized.includes('prose without any result block'), 'observation must not carry reply text');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('E3a: failed max_tokens turn records stop_reason max_tokens (M1 evidence)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'e3a-mt-'));
  try {
    const provider = {
      async completeMultiTurn(): Promise<MultiTurnResult> {
        return { stop_reason: 'max_tokens', text: '', tool_uses: [], tokens_used: 4096 } as unknown as MultiTurnResult;
      },
    };
    const loop = new AgentLoop(provider as never, loopOpts(root));
    const result = await loop.run('system', 'user task');
    assert.equal(result.success, false);
    assert.equal(result.failure_observation!.stop_reason, 'max_tokens');
    assert.equal(result.failure_observation!.text_length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('E3a: a real submit-result transport failure is captured — negotiated channel, tool_use stop, cardinality violation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'e3a-submit-'));
  try {
    // stop_reason: tool_use with submit_result + a read tool on the SAME
    // turn — the C5 terminal/exclusive violation. First occurrence enters
    // format repair; the repeat fails closed. This drives the REAL
    // SubmitResultTransport via loop negotiation (resultSchemaJson present,
    // provider has completeMultiTurn).
    const violatingTurn = {
      stop_reason: 'tool_use',
      text: '',
      tool_uses: [
        { type: 'tool_use', id: 't1', name: 'submit_result', input: { result: { goal: 'x'.repeat(80) } } },
        { type: 'tool_use', id: 't2', name: 'read_file', input: { path: 'src/a.ts' } },
      ],
      tokens_used: 5,
    };
    const provider = {
      async completeMultiTurn(): Promise<MultiTurnResult> {
        return violatingTurn as unknown as MultiTurnResult;
      },
    };
    const loop = new AgentLoop(provider as never, loopOpts(root, {
      resultSchemaJson: {
        type: 'object',
        properties: { result: { type: 'object', properties: { goal: { type: 'string' } }, required: ['goal'] } },
        required: ['result'],
      },
    }));
    const result = await loop.run('system', 'user task');
    assert.equal(result.success, false);
    const obs = result.failure_observation!;
    assert.ok(obs, 'failure_observation must be present');
    assert.equal(obs.result_transport, 'submit-result', 'the negotiated submit-result transport is recorded');
    assert.equal(obs.stop_reason, 'tool_use');
    assert.equal(obs.format_repairs, 1, 'one repair attempt before fail-closed');
    assert.equal(obs.tool_uses.length, 2, 'the violating turn carried submit_result AND read_file');
    assert.equal(obs.tool_uses[0].name, 'submit_result');
    assert.equal(obs.tool_uses[1].name, 'read_file');
    assert.ok(obs.tool_uses[0].argument_bytes > 80, 'argument_bytes counts real UTF-8 bytes');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('E3a: AgentRunner.run() persists the observation to disk — raw node output non-empty + failure loop metadata present', async () => {
  // The exact defect E3a closes lives at the runner/loop/filesystem boundary:
  // drive a REAL AgentRunner.run() with a real RunArtifactManager against a
  // real temporary root and assert the evidence is ON DISK after the failure.
  const root = mkdtempSync(join(tmpdir(), 'e3a-runner-'));
  try {
    const provider = {
      async completeMultiTurn(): Promise<MultiTurnResult> {
        return { stop_reason: 'max_tokens', text: '', tool_uses: [], tokens_used: 4096 } as unknown as MultiTurnResult;
      },
    };
    const runner = new AgentRunner(
      new ScriptedContextManager(),
      provider as never,
      root,
      new RunArtifactManager({ projectRoot: root }),
      { model: 'test-model' },
    );
    const result = await runner.run('explorer', makeCtx({ projectRoot: root }));
    assert.equal(result.success, false);
    assert.ok(result.raw_output_path.length > 0, 'raw_output_path must be set');
    assert.ok(existsSync(result.raw_output_path), 'the raw node output must exist on disk');

    const raw = readFileSync(result.raw_output_path, 'utf-8');
    assert.ok(raw.length > 0, 'raw node output must NOT be empty (the C7/F6 defect)');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    assert.equal(parsed['kind'], 'step-failure-observation');
    assert.equal(parsed['stop_reason'], 'max_tokens');
    assert.equal(parsed['text_length'], 0);
    assert.equal(parsed['result_transport'], 'textual-sle-output');
    assert.equal(parsed['error'], result.error);

    // failure -loop.json: same directory, same naming as the success path
    const loopMetaPath = join(root, '.sle', 'runs', 'run-e3a', '1', 'node-outputs', 'synthesize_definition-loop.json');
    assert.ok(existsSync(loopMetaPath), 'failure loop metadata must exist under the run directory');
    const meta = JSON.parse(readFileSync(loopMetaPath, 'utf-8')) as Record<string, unknown>;
    assert.equal(meta['failed'], true);
    assert.equal(meta['node_id'], 'synthesize_definition');
    assert.equal(meta['turns_taken'], 1);
    assert.ok(Array.isArray(meta['tool_calls']));
    // both files live under root/.sle/runs/..., which the C7 evidence
    // collector (persistRunEvidence) copies out before fixture deletion —
    // survival is pinned by tests/d34-c7-evidence.test.ts.
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
