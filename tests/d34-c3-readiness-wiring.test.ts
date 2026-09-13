// D.34 C3 — readiness wiring: the live review path is on the output-contract
// path (DDR-034 §7). Locks the C3 acceptance criteria from
// docs/developmentPlan/d34-output-contracts.md:
//
//   - PROMPT SLIMMING: mechanical serialization instructions are GONE from
//     the readiness-review prompts (no front matter, no verdict-line
//     mechanics) while the methodology stays intact (seven dimensions,
//     classification semantics, precedence, closure rule, EXPLORE line).
//     The Definition (produce-path) prompt is UNCHANGED — C4 has not run.
//   - the textual fallback teaches and carries the generated proposal
//     schema when the runner injects it (proposal mode), and stays
//     byte-for-byte legacy otherwise;
//   - the composition root registers the contract under the workflow's own
//     declared type — proven end-to-end through buildAgentRunner;
//   - LIVE result repair end-to-end: garbage → format repair; valid-JSON-
//     but-methodology-invalid → result repair; then success with route
//     derived from TYPED gaps and system-rendered canonical bytes;
//   - exhaustion fails closed before write/provenance.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentRunner, type AgentRunResult } from '../src/agent-runner.js';
import { buildAgentRunner } from '../src/application.js';
import { DEFINE_WORK } from '../src/workflow/builtins/define-work.js';
import { READINESS_ROUTE_CONTRACT, DEFINITION_CONTRACT } from '../src/workflow/methodology/definition-readiness.js';
import { renderReadiness, type ReadinessProposal } from '../src/workflow/methodology/readiness-contract.js';
import {
  TextualSleOutputTransport,
} from '../src/transport/textual-sle-output.js';
import type {
  ILLMProvider,
  LLMCompletionParams,
  LLMCompletionResult,
} from '../src/llm-provider.js';
import type { ContextManager } from '../src/context-manager.js';
import type { AssembledContext } from '../src/types.js';
import type { StepRunContext } from '../src/workflow/types.js';
import type { RunArtifactManager } from '../src/run-artifacts.js';
import type { ArtifactRepository } from '../src/storage/repositories.js';

// ─── Prompt slimming (the review artifact, asserted mechanically) ─────────────

test('D.34.C3 PROMPTS: readiness review steps teach the proposal — no serialization mechanics', () => {
  const reviewSteps = DEFINE_WORK.steps.filter((s) => s.kind === 'review');
  assert.ok(reviewSteps.length >= 3, 'three readiness review steps exist');
  for (const step of reviewSteps) {
    const instruction = step.instruction ?? '';
    assert.ok(!instruction.includes('front matter'), `${step.id}: no front-matter mechanics`);
    assert.ok(!instruction.includes('never omit the verdict line'), `${step.id}: no verdict-line mechanics`);
    assert.ok(!instruction.includes('verdict: pass` only if'), `${step.id}: no legacy verdict-token declaration`);
    // Methodology intact:
    assert.ok(instruction.includes('seven dimensions'), `${step.id}: rubric anchor kept`);
    assert.ok(instruction.includes('precedence'), `${step.id}: precedence semantics kept`);
    assert.ok(instruction.includes('closure'), `${step.id}: closure rule kept`);
  }
});

test('D.34.C3 PROMPTS: READINESS_ROUTE_CONTRACT is proposal-framed, methodology unchanged', () => {
  const text = READINESS_ROUTE_CONTRACT(['CAN_RESOLVE', 'DEFER', 'HUMAN_DECISION', 'EXPLORE_AS_WORK']);
  assert.ok(!text.includes('front matter'), 'no front-matter mechanics');
  assert.ok(!text.includes('canonical YAML'), 'no YAML mechanics');
  assert.ok(text.includes('proposal'), 'proposal framing present');
  assert.ok(text.includes('precedence'), 'precedence kept');
  assert.ok(text.includes('Never classify cheap repository inspection as EXPLORE_AS_WORK'), 'EXPLORE line kept');
  assert.ok(text.includes('recording the DEFERRED transition'), 'DEFER closure semantics kept');
  assert.ok(text.includes('Stratum derives the next step deterministically'), 'route authority rule kept');
});

test('D.34.C3 PROMPTS: the Definition (produce-path) contract is UNTOUCHED — C4 has not run', () => {
  assert.ok(DEFINITION_CONTRACT.includes('front matter'), 'definition serialization teaching remains until C4');
});

// ─── Transport proposal mode ──────────────────────────────────────────────────

const SCHEMA_TEXT = 'RESULT SHAPE: {"verdict":"pass|fail","gaps":[...],"bodyMarkdown":"..."}';

test('D.34.C3 TRANSPORT: proposal mode teaches the injected schema, never the envelope', () => {
  const t = new TextualSleOutputTransport();
  const teaching = t.formatInstruction({
    role: 'explorer', requiresReviewVerdict: true, execution: 'single-turn',
    declaredArtifactId: 'definition-readiness',
    resultSchemaText: SCHEMA_TEXT,
  });
  assert.ok(teaching.includes(SCHEMA_TEXT), 'generated schema embedded verbatim');
  assert.ok(teaching.includes('SINGLE JSON'), 'payload framing');
  assert.ok(!teaching.includes('SLE-OUTPUT'), 'no envelope teaching in proposal mode');
});

test('D.34.C3 TRANSPORT: proposal mode extracts a JSON payload as a proposal-kind result', () => {
  const t = new TextualSleOutputTransport();
  const ctx = { role: 'explorer' as const, requiresReviewVerdict: true, execution: 'single-turn' as const, resultSchemaText: SCHEMA_TEXT };
  const plain = t.extractSingleTurn('{"verdict":"fail"}', ctx);
  assert.deepEqual(plain, { kind: 'proposal', value: { verdict: 'fail' } });
  const fenced = t.extractSingleTurn('```json\n{"verdict":"pass"}\n```', ctx);
  assert.equal(fenced.kind, 'proposal');
  const prose = t.extractSingleTurn('Here is my judgment:\n{"verdict":"fail"}\nThank you.', ctx);
  assert.equal(prose.kind, 'proposal');
  assert.throws(() => t.extractSingleTurn('no json here', ctx), (e: Error) => e.name === 'TransportParseError');
  assert.throws(() => t.extractSingleTurn('{broken', ctx), (e: Error) => e.name === 'TransportParseError');
});

test('D.34.C3 TRANSPORT: legacy mode is untouched when no schema is injected', () => {
  const t = new TextualSleOutputTransport();
  const ctx = { role: 'explorer' as const, requiresReviewVerdict: true, execution: 'single-turn' as const };
  const teaching = t.formatInstruction(ctx);
  assert.ok(teaching.includes('SLE-OUTPUT'), 'legacy envelope teaching intact');
  const raw = '<!-- SLE-OUTPUT\nrole: explorer\nnode: r\nartifacts:\n  - id: readiness\n    path: .sle/work/w/readiness.md\nverdict: fail\n-->\n\n## .sle/work/w/readiness.md\n\nbytes';
  const result = t.extractSingleTurn(raw, ctx);
  assert.equal(result.kind, 'materialized', 'legacy yields materialized bytes');
  assert.equal(result.kind === 'materialized' ? result.review?.verdict : undefined, 'fail');
});

test('D.34.C3 TRANSPORT: repair instructions are mode-correct', () => {
  const t = new TextualSleOutputTransport();
  const proposal = t.repairInstruction(
    { role: 'explorer', requiresReviewVerdict: true, execution: 'single-turn', resultSchemaText: SCHEMA_TEXT },
    'malformed', 'bad json',
  );
  assert.match(proposal, /SINGLE valid JSON object/);
  assert.ok(!proposal.includes('SLE-OUTPUT'));
  const legacy = t.repairInstruction(
    { role: 'explorer', requiresReviewVerdict: true, execution: 'single-turn' },
    'absent',
  );
  assert.match(legacy, /SLE-OUTPUT/);
});

// ─── Composition-root end-to-end (registry + live result repair) ──────────────

const VALID_DEFINITION = `---
schemaVersion: 1
goal: "Ship the widget"
facts:
  - id: F1
    statement: "The widget must ship."
    status: KNOWN
    source: human
    kind: product-intent
---
Body.`;

class ScriptedProvider implements ILLMProvider {
  public calls: LLMCompletionParams[] = [];
  constructor(private replies: string[]) {}
  async complete(params: LLMCompletionParams): Promise<LLMCompletionResult> {
    this.calls.push(params);
    const reply = this.replies[Math.min(this.calls.length - 1, this.replies.length - 1)];
    return { content: reply, tokens_used: 10, duration_ms: 1 };
  }
}

class ScriptedContextManager implements ContextManager {
  async assemble(): Promise<AssembledContext> {
    return { system_prompt: 'sys', artifact_slices: {}, state_summary: 'state', task: 'task', token_count: 1, truncated: [] };
  }
}

class RecordingArtifacts implements ArtifactRepository {
  public saved: Array<{ ref: string; hash: string; path: string }> = [];
  save(record: { ref: string; hash: string; path: string } & Record<string, unknown>): void {
    this.saved.push({ ref: record['ref'] as string, hash: record['hash'] as string, path: record['path'] as string });
  }
  findByWorkflowRunRefAndHash(): unknown {
    return undefined;
  }
}

function makeHarness(replies: string[]): { runner: AgentRunner; provider: ScriptedProvider; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'd34-c3-'));
  const provider = new ScriptedProvider(replies);
  // buildAgentRunner does not expose an fs override — the runner uses the
  // REAL filesystem under `root`, which makes this genuinely end-to-end:
  // seed the Definition the input gate reads, assert artifacts on real disk.
  mkdirSync(join(root, '.sle/work/w'), { recursive: true });
  writeFileSync(join(root, '.sle/work/w/definition.md'), VALID_DEFINITION, 'utf-8');
  const artifacts = new RecordingArtifacts();
  const runner = buildAgentRunner(
    new ScriptedContextManager(),
    provider,
    root,
    { writeNodeOutput: async () => {} } as unknown as RunArtifactManager,
    'test-model',
    artifacts,
    4096,
  );
  return { runner, provider, artifacts, root };
}

function reviewCtx(): StepRunContext {
  return {
    workflowRunId: 'run-1',
    workflowId: 'define-work',
    stepId: 'definition-readiness-review',
    iteration: 1,
    revision: 0,
    goal: 'g',
    projectRoot: '/proj',
    role: 'explorer',
    requiresReviewVerdict: true,
    inputValidator: 'definition',
    inputArtifactRefs: ['.sle/work/w/definition.md'],
    outputArtifact: { type: 'definition-readiness', ref: 'definition-readiness:{objectiveId}', path: '.sle/work/w/readiness.md' },
    on_fail_routes: {
      refine: { target_step_id: 'refine-definition', iteration_loop: true },
      defer: { target_step_id: 'apply-deferred-gaps' },
      human: { target_step_id: 'prepare-human-decision' },
      explore: { target_step_id: 'record-exploration-need' },
    },
  } as StepRunContext;
}

const VALID_FAIL_PROPOSAL: ReadinessProposal = {
  verdict: 'fail',
  gaps: [
    {
      target: 'F1',
      description: 'Platform scope is a product tradeoff only a human can authorize',
      classification: 'HUMAN_DECISION',
      reason: 'Irreversible product commitment.',
      closure: 'Record a Decision and mark F1 DECIDED.',
    },
  ],
  bodyMarkdown: '## Review\n\nOne genuine human decision remains.\n',
};

test('D.34.C3 E2E: garbage → format repair → methodology-invalid → result repair → success with typed route + system bytes', async () => {
  const h = makeHarness([
    'I think this definition looks pretty good overall...',                    // not JSON → format repair
    JSON.stringify({ verdict: 'pass', gaps: [{ target: 'F1', description: 'd', classification: 'HUMAN_DECISION', reason: 'r', closure: 'c' }], bodyMarkdown: '' }), // PASS_WITH_GAPS → result repair
    JSON.stringify(VALID_FAIL_PROPOSAL),                                       // accepted
  ]);
  const result: AgentRunResult = await h.runner.run('explorer', reviewCtx());
  assert.equal(result.success, true, result.error);
  assert.equal(result.format_repairs, 1, 'garbage → format repair (envelope layer)');
  assert.equal(result.result_repairs, 1, 'PASS_WITH_GAPS → result repair (contract layer)');
  assert.equal(result.reviewVerdict, 'fail');
  assert.equal(result.reviewRoute, 'human', 'route derived from TYPED gaps — HUMAN_DECISION, no artifact parse-back');
  const readinessPath = join(h.root, '.sle/work/w/readiness.md');
  assert.equal(readFileSync(readinessPath, 'utf-8'), renderReadiness(VALID_FAIL_PROPOSAL), 'bytes are SYSTEM-rendered — identical to the pure renderer output');
  assert.deepEqual(h.artifacts.saved.map((s) => s.ref), ['definition-readiness:{objectiveId}']);
});

test('D.34.C3 E2E: result-repair exhaustion fails closed before write/provenance', async () => {
  const invalid = JSON.stringify({ verdict: 'fail', gaps: [], bodyMarkdown: '' }); // FAIL_WITHOUT_GAPS, always
  const h = makeHarness([invalid, invalid]);
  const result = await h.runner.run('explorer', reviewCtx());
  assert.equal(result.success, false);
  assert.match(result.error ?? '', /result repair is exhausted/);
  assert.match(result.error ?? '', /'definition-readiness'/);
  assert.equal(result.result_repairs, 1);
  assert.equal(h.artifacts.saved.length, 0, 'no provenance');
  assert.equal(existsSync(join(h.root, '.sle/work/w/readiness.md')), false, 'no readiness bytes written');
});

test('D.34.C3 E2E: a Definition (produce) step on the SAME runner stays on the legacy bytes path', async () => {
  const legacyReply = [
    '<!-- SLE-OUTPUT',
    'role: explorer',
    'node: synthesize-definition',
    'artifacts:',
    '  - id: definition',
    '    path: .sle/work/w/definition.md',
    '-->',
    '',
    '## .sle/work/w/definition.md',
    '',
    VALID_DEFINITION,
  ].join('\n');
  const h = makeHarness([legacyReply]);
  const ctx: StepRunContext = {
    workflowRunId: 'run-1', workflowId: 'define-work', stepId: 'synthesize-definition',
    iteration: 1, revision: 0, goal: 'g', projectRoot: '/proj', role: 'explorer',
    outputArtifact: { type: 'definition', ref: 'definition:{objectiveId}', path: '.sle/work/w/definition.md' },
  } as StepRunContext;
  const result = await h.runner.run('explorer', ctx);
  assert.equal(result.success, true, result.error);
  assert.equal('result_repairs' in result, false, 'legacy path observable shape unchanged');
  assert.equal(readFileSync(join(h.root, '.sle/work/w/definition.md'), 'utf-8'), VALID_DEFINITION, 'model-authored bytes flow through unchanged (C4 pending)');
  assert.deepEqual(h.artifacts.saved.map((s) => s.ref), ['definition:{objectiveId}']);
});
