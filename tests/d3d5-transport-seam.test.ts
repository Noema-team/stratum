// D.3d.5 commit 1 — the unified StepResult transport seam.
//
// Locks the new boundary established by this commit:
//
//   - the canonical StepResult contract (artifacts + optional review
//     verdict, NEVER a route — the route is a control transition Stratum
//     will derive deterministically in commit 3, not model authority);
//   - the textual SLE-OUTPUT fallback as the only transport current
//     providers genuinely get, with a structured transport injectable for
//     providers/adapters that have real structured-output capability;
//   - bounded format repair for BOTH non-compliance kinds: a reply whose
//     result block is malformed (the old parseWithRetry path) AND a reply
//     with no result block at all (previously an immediate fatal failure —
//     the GPT-OSS-120B live failure mode);
//   - repair exhaustion fails closed;
//   - honest diagnostics: ordinary turns and format-repair attempts are
//     counted and reported separately (the pre-D.3d.5 "after N turn(s)"
//     message implied N repair attempts where none had happened);
//   - the legacy textual `route:` token keeps flowing through the interim
//     D.3c1a allowlist gate unchanged during migration, but lives OUTSIDE
//     the canonical StepResult.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentLoop, type IMultiTurnProvider, type MultiTurnResult, type MultiTurnParams } from '../src/agent-loop.js';
import { AgentRunner, type AgentRunnerConfig, validateOutputPath } from '../src/agent-runner.js';
import type { RunArtifactManager } from '../src/run-artifacts.js';
import { ContextManager, DEFAULT_CONFIG } from '../src/context-manager.js';
import {
  type ResultTransport,
  type StepResult,
  type TransportContext,
  MAX_FORMAT_REPAIRS,
  TransportParseError,
} from '../src/transport/step-result.js';
import {
  TextualSleOutputTransport,
  extractLegacyReviewRoute,
  resolveResultTransport,
} from '../src/transport/textual-sle-output.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const PRODUCE_CTX: TransportContext = { role: 'explorer', requiresReviewVerdict: false, execution: 'multi-turn' };

function endTurn(text: string, tokens = 10): MultiTurnResult {
  return { stop_reason: 'end_turn', text, tool_uses: [], tokens_used: tokens };
}

function sleBlock(path: string, content: string): string {
  return `<<<SLE-OUTPUT>>>\n### ${path}\n${content}\n<<<END-SLE-OUTPUT>>>\n`;
}

function makeLoop(provider: IMultiTurnProvider, opts: Partial<Parameters<typeof AgentLoop.prototype.run> extends never ? never : Record<string, unknown>> = {}): AgentLoop {
  return new AgentLoop(provider, {
    model: 'test',
    projectRoot: mkdtempSync(join(tmpdir(), 'd3d5-loop-')),
    role: 'explorer',
    workflowRunId: 'r',
    iteration: 1,
    nodeId: 'n',
    runArtifacts: { updateNodeStatus: async () => {} } as unknown as RunArtifactManager,
    ...opts,
  });
}

// A minimal real-shaped structured transport — stands in for a future
// provider-native structured-output adapter. It accepts raw replies that
// are JSON StepResults, on BOTH execution paths. No provider capability is
// faked: this object exists to prove the SEAM carries a non-textual
// StepResult end to end, including single-turn review.
class JsonStepResultTransport implements ResultTransport {
  readonly name = 'json-step-result';
  formatInstruction(): string {
    return 'Reply with a single JSON object: {"artifacts":[{"path":"...","content":"..."}]}';
  }
  extractProduce(raw: string): StepResult {
    return this.parse(raw);
  }
  extractSingleTurn(raw: string): StepResult {
    return this.parse(raw);
  }
  private parse(raw: string): StepResult {
    try {
      const obj = JSON.parse(raw) as StepResult;
      if (!Array.isArray(obj.artifacts)) throw new Error('missing artifacts');
      return obj;
    } catch (err) {
      throw new TransportParseError('invalid JSON StepResult', raw, (err as Error).message);
    }
  }
  repairInstruction(): string {
    return 'Reply with a single valid JSON StepResult object.';
  }
}

// ─── Canonical contract ───────────────────────────────────────────────────────

test('D.3d.5.1: the canonical StepResult carries no route — the legacy route token stays outside the contract', () => {
  const t = new TextualSleOutputTransport();
  const raw =
    '<!-- SLE-OUTPUT\n' +
    'role: explorer\nnode: review\n' +
    'artifacts:\n  - id: readiness\n    path: .sle/work/w/readiness.md\n' +
    'verdict: fail\nroute: human\n-->\n\n## .sle/work/w/readiness.md\n\nbody';
  const stepResult = t.extractSingleTurn(raw, { role: 'explorer', requiresReviewVerdict: true, execution: 'single-turn' });
  assert.deepEqual(Object.keys(stepResult).sort(), ['artifacts', 'review'], 'StepResult has exactly artifacts and (optionally) review');
  assert.equal(stepResult.review?.verdict, 'fail');
  assert.equal((stepResult as Record<string, unknown>)['route'], undefined, 'route must never appear on StepResult');
  // The legacy token is still extractable for the interim allowlist gate…
  assert.equal(extractLegacyReviewRoute(raw), 'human');
  // …and only via the deprecated migration helper, never via the transport contract.
  assert.equal(resolveResultTransport(undefined).name, 'textual-sle-output', 'default transport is the textual fallback');
});

// ─── Textual fallback extraction ─────────────────────────────────────────────

test('D.3d.5.1: textual transport extracts a produce reply into a StepResult', () => {
  const t = new TextualSleOutputTransport();
  const result = t.extractProduce(sleBlock('.sle/work/w/definition.md', '# Definition body'), PRODUCE_CTX);
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0].path, '.sle/work/w/definition.md');
  assert.equal(result.review, undefined, 'produce replies carry no review');
});

test('D.3d.5.1: textual transport raises TransportParseError with a reason for malformed blocks', () => {
  const t = new TextualSleOutputTransport();
  const malformed = '<<<SLE-OUTPUT>>>\n### .sle/work/w/definition.md\n\n<<<END-SLE-OUTPUT>>>'; // empty content
  assert.throws(() => t.extractProduce(malformed, PRODUCE_CTX), TransportParseError);
});

// ─── Structured result path (seam, honestly labeled) ─────────────────────────

test('D.3d.5.1: a structured transport is injectable and its StepResult flows through the loop unchanged', async () => {
  const jsonReply = JSON.stringify({ artifacts: [{ path: '.sle/work/w/definition.md', content: '# Structured' }] });
  const provider: IMultiTurnProvider = { async completeMultiTurn() { return endTurn(jsonReply); } };
  const loop = makeLoop(provider, { resultTransport: new JsonStepResultTransport() });
  const result = await loop.run('System', 'Produce.');
  assert.equal(result.success, true);
  assert.equal(result.format_repairs, 0);
  assert.equal(result.parsedOutput?.sections[0].path, '.sle/work/w/definition.md');
  assert.equal(result.parsedOutput?.sections[0].content, '# Structured');
});

// ─── Bounded format repair: absent result block (the GPT-OSS fix) ────────────

test('D.3d.5.1: a reply with NO result block receives bounded format repair and can still succeed', async () => {
  const replies = [
    endTurn('Here is my analysis in plain prose, no block at all.'),
    endTurn(sleBlock('.sle/work/w/definition.md', '# After repair')),
  ];
  const seen: MultiTurnParams[] = [];
  const provider: IMultiTurnProvider = {
    async completeMultiTurn(params) {
      seen.push(params);
      return replies[seen.length - 1] ?? endTurn('', 1);
    },
  };
  const loop = makeLoop(provider);
  const result = await loop.run('System', 'Produce.');

  assert.equal(result.success, true, result.error);
  assert.equal(result.format_repairs, 1, 'exactly one bounded repair attempt');
  // The repair turn must contain the transport's absence-repair prompt AND
  // the assistant's non-compliant reply for context.
  const lastUser = seen[1].messages.at(-1);
  assert.equal(lastUser?.role, 'user');
  assert.ok(String(lastUser?.content).includes('did not contain the required machine-readable output block'));
  const assistantTurn = seen[1].messages.at(-2);
  assert.equal(assistantTurn?.role, 'assistant');
  assert.ok(String(assistantTurn?.content).includes('plain prose'));
  // The first call's instruction injection teaches the syntax up front.
  assert.ok(String(seen[0].messages[0].content).includes('<<<SLE-OUTPUT>>>'));
});

test('D.3d.5.1: repair exhaustion on absent result block fails closed with honest diagnostics', async () => {
  const provider: IMultiTurnProvider = { async completeMultiTurn() { return endTurn('Prose only, never any block.'); } };
  const loop = makeLoop(provider);
  const result = await loop.run('System', 'Produce.');

  assert.equal(result.success, false);
  assert.equal(result.format_repairs, MAX_FORMAT_REPAIRS);
  assert.ok(result.error?.includes('without emitting the required SLE-OUTPUT block'), result.error);
  // Diagnostics distinguish ordinary turns from repair attempts — the
  // pre-D.3d.5 message ("after N turn(s)") conflated them.
  assert.ok(/\d+ ordinary turn\(s\)/.test(result.error!), 'error counts ordinary turns');
  assert.ok(/\d+ format-repair attempt\(s\)/.test(result.error!), 'error counts repair attempts separately');
});

// ─── Bounded format repair: malformed result block (pre-existing behavior) ───

test('D.3d.5.1: a MALFORMED result block still receives the same bounded repair and can succeed', async () => {
  const malformed = '<<<SLE-OUTPUT>>>\n### .sle/work/w/definition.md\n\n<<<END-SLE-OUTPUT>>>'; // empty content
  const replies = [endTurn(malformed), endTurn(sleBlock('.sle/work/w/definition.md', '# Repaired'))];
  const seen: MultiTurnParams[] = [];
  const provider: IMultiTurnProvider = {
    async completeMultiTurn(params) { seen.push(params); return replies[seen.length - 1] ?? endTurn('', 1); },
  };
  const loop = makeLoop(provider);
  const result = await loop.run('System', 'Produce.');

  assert.equal(result.success, true, result.error);
  assert.equal(result.format_repairs, 1);
  const lastUser = seen[1].messages.at(-1);
  assert.ok(String(lastUser?.content).includes('not parseable'), 'malformed repair names the parse reason');
});

test('D.3d.5.1: repair exhaustion on malformed block fails closed with honest diagnostics', async () => {
  const malformed = '<<<SLE-OUTPUT>>>\n### .sle/work/w/definition.md\n\n<<<END-SLE-OUTPUT>>>';
  const provider: IMultiTurnProvider = { async completeMultiTurn() { return endTurn(malformed); } };
  const loop = makeLoop(provider);
  const result = await loop.run('System', 'Produce.');

  assert.equal(result.success, false);
  assert.equal(result.format_repairs, MAX_FORMAT_REPAIRS);
  assert.ok(result.error?.includes('malformed and format repair is exhausted'), result.error);
  assert.ok(/\d+ format-repair attempt\(s\)/.test(result.error!));
});

// ─── Runner-level seam wiring ────────────────────────────────────────────────

test('D.3d.5.1: AgentRunner injects the transport teaching into the single-turn request', async () => {
  const root = mkdtempSync(join(tmpdir(), 'd3d5-runner-'));
  try {
    const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    const provider = {
      async complete(params: { messages: Array<{ role: string; content: string }>; model: string; max_tokens: number; temperature: number }) {
        requests.push(params);
        return {
          content:
            '<!-- SLE-OUTPUT\nrole: explorer\nnode: probe\nartifacts:\n  - id: probe\n    path: .sle/work/w/probe.md\n-->\n\n## .sle/work/w/probe.md\n\nProbe body.',
          tokens_used: 5,
        };
      },
    };
    const cm = new ContextManager(root, DEFAULT_CONFIG);
    const runner = new AgentRunner(
      cm,
      provider as never,
      root,
      { updateNodeStatus: async () => {} } as unknown as RunArtifactManager,
      { model: 'test' } satisfies Partial<AgentRunnerConfig> as AgentRunnerConfig,
    );
    const result = await runner.run('explorer', {
      workflowRunId: 'r', workflowId: 'wf', stepId: 'probe', iteration: 1, revision: 0,
      goal: 'probe', projectRoot: root,
      instruction: 'Do the probe.',
      outputArtifact: { type: 'probe', ref: 'probe:1', path: '.sle/work/w/probe.md' },
    } as never);

    assert.equal(result.success, true, result.error);
    assert.equal(requests.length, 1);
    const userMsg = requests[0].messages.find((m) => m.role === 'user')!;
    assert.ok(userMsg.content.includes('<!-- SLE-OUTPUT'), 'single-turn request carries the preamble-shape teaching');
    assert.ok(!userMsg.content.includes('<<<SLE-OUTPUT>>>'), 'single-turn teaching must not leak the multi-turn delimiter shape');
    assert.ok(userMsg.content.includes('Do the probe.'), 'the step instruction itself is untouched');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('D.3d.5.1: AgentRunner resolves its transport through the seam, honoring an explicit override', () => {
  const override: ResultTransport = {
    name: 'json-single-turn',
    formatInstruction: () => 'reply with JSON StepResult',
    extractProduce: (raw: string) => JSON.parse(raw) as StepResult,
    repairInstruction: () => 'reply with JSON StepResult',
  };
  const root = mkdtempSync(join(tmpdir(), 'd3d5-runner2-'));
  try {
    const cm = new ContextManager(root, DEFAULT_CONFIG);
    const runner = new AgentRunner(
      cm,
      { async complete() { return { content: '', tokens_used: 0 }; } } as never,
      root,
      { updateNodeStatus: async () => {} } as unknown as RunArtifactManager,
      { model: 'test', resultTransport: override } as AgentRunnerConfig,
    );
    const resolved = (runner as unknown as { resultTransport: ResultTransport }).resultTransport;
    assert.equal(resolved, override, 'an explicit transport override always wins');
    assert.equal(
      (new AgentRunner(cm, { async complete() { return { content: '', tokens_used: 0 }; } } as never, root, { updateNodeStatus: async () => {} } as unknown as RunArtifactManager, { model: 'test' }) as unknown as { resultTransport: ResultTransport }).resultTransport.name,
      'textual-sle-output',
      'without an override the textual fallback is resolved',
    );
    void validateOutputPath; // reference import (path-safety regression net stays hot)
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── Total extraction ownership: single-turn review through the seam ─────────

test('D.3d.5.1: a structured transport serves a REVIEW step end to end — the runner never touches the legacy preamble parser', async () => {
  const root = mkdtempSync(join(tmpdir(), 'd3d5-review-'));
  try {
    // A provider whose review reply is a JSON StepResult with a fail verdict.
    // Only the injected transport can read it; if AgentRunner still parsed
    // the legacy HTML/YAML preamble internally, this run would fail with
    // "Missing SLE-OUTPUT preamble comment".
    const provider = {
      async complete() {
        return {
          content: JSON.stringify({
            artifacts: [{ path: '.sle/work/w/readiness.md', content: 'Readiness body' }],
            review: { verdict: 'fail' },
          }),
          tokens_used: 5,
        };
      },
    };
    const cm = new ContextManager(root, DEFAULT_CONFIG);
    const runner = new AgentRunner(
      cm,
      provider as never,
      root,
      { updateNodeStatus: async () => {} } as unknown as RunArtifactManager,
      { model: 'test', resultTransport: new JsonStepResultTransport() },
    );
    const result = await runner.run('explorer', {
      workflowRunId: 'r', workflowId: 'wf', stepId: 'definition-readiness-review',
      iteration: 1, revision: 0, goal: 'review', projectRoot: root,
      instruction: 'Review the definition.',
      requiresReviewVerdict: true,
      outputArtifact: { type: 'definition-readiness', ref: 'dr:1', path: '.sle/work/w/readiness.md' },
    } as never);

    assert.equal(result.success, true, result.error);
    assert.equal(result.reviewVerdict, 'fail', 'the structured review verdict flows through the canonical contract');
    assert.equal(result.reviewRoute, undefined, 'no legacy route token exists in a structured reply');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('D.3d.5.1: the legacy textual path still serves a REVIEW step (migration behavior unchanged)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'd3d5-review2-'));
  try {
    const provider = {
      async complete() {
        return {
          content:
            '<!-- SLE-OUTPUT\nrole: explorer\nnode: definition-readiness-review\nartifacts:\n  - id: readiness\n    path: .sle/work/w/readiness.md\nverdict: fail\nroute: refine\n-->\n\n## .sle/work/w/readiness.md\n\nReadiness body',
          tokens_used: 5,
        };
      },
    };
    const cm = new ContextManager(root, DEFAULT_CONFIG);
    const runner = new AgentRunner(
      cm,
      provider as never,
      root,
      { updateNodeStatus: async () => {} } as unknown as RunArtifactManager,
      { model: 'test' },
    );
    const result = await runner.run('explorer', {
      workflowRunId: 'r', workflowId: 'wf', stepId: 'definition-readiness-review',
      iteration: 1, revision: 0, goal: 'review', projectRoot: root,
      instruction: 'Review the definition.',
      requiresReviewVerdict: true,
      on_fail_routes: { refine: { target_step_id: 'refine-definition' } },
      outputArtifact: { type: 'definition-readiness', ref: 'dr:1', path: '.sle/work/w/readiness.md' },
    } as never);

    assert.equal(result.success, true, result.error);
    assert.equal(result.reviewVerdict, 'fail');
    assert.equal(result.reviewRoute, 'refine', 'the legacy route token still flows through the interim gate');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── Metadata-driven teaching: no workflow-specific assumptions ──────────────

test('D.3d.5.1: single-turn teaching is generated from actual step metadata (role, node, artifact id/path)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'd3d5-meta-'));
  try {
    const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    const provider = {
      async complete(params: { messages: Array<{ role: string; content: string }> }) {
        requests.push(params);
        return {
          content:
            '<!-- SLE-OUTPUT\nrole: explorer\nnode: probe\nartifacts:\n  - id: probe\n    path: .sle/work/w/probe.md\n-->\n\n## .sle/work/w/probe.md\n\nProbe body.',
          tokens_used: 5,
        };
      },
    };
    const cm = new ContextManager(root, DEFAULT_CONFIG);
    const runner = new AgentRunner(
      cm,
      provider as never,
      root,
      { updateNodeStatus: async () => {} } as unknown as RunArtifactManager,
      { model: 'test' },
    );
    const result = await runner.run('explorer', {
      workflowRunId: 'r', workflowId: 'wf', stepId: 'probe', iteration: 1, revision: 0,
      goal: 'probe', projectRoot: root,
      instruction: 'Do the probe.',
      outputArtifact: { type: 'probe', ref: 'probe:1', path: '.sle/work/w/probe.md' },
    } as never);

    assert.equal(result.success, true, result.error);
    const userMsg = requests[0].messages.find((m) => m.role === 'user')!;
    // Generated from THIS step's metadata — nothing define-work-specific:
    assert.ok(userMsg.content.includes('role: explorer'), 'teaching renders the actual role');
    assert.ok(userMsg.content.includes('node: probe'), 'teaching renders the actual node id');
    assert.ok(userMsg.content.includes('id: probe'), 'teaching renders the actual artifact id');
    assert.ok(userMsg.content.includes('path: .sle/work/w/probe.md'), 'teaching renders the actual declared path');
    assert.ok(!userMsg.content.includes('readiness'), 'no workflow-specific artifact names leak into teaching');
    assert.ok(!userMsg.content.includes('workItemId'), 'no placeholder leaks when real metadata exists');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
