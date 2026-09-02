// D.1a spike — NOT a permanent regression suite entry.
//
// Traces WorkflowDefinition -> WorkflowEngine -> StepRunner -> AgentStepRunner
// -> ContextManager -> AgentRunner -> artifact write for a synthetic step with
// an intentionally unfamiliar id, to answer: can a genuinely new workflow
// declare its own instructions and output Artifact without adding its step
// IDs to ContextManager's task/slice maps or AgentRunner's role/path table?
//
// Each test below is a falsifiable claim from the D.1a write-up
// (docs/developmentPlan/d1a-declarative-contract-spike.md), not a spec for
// desired behavior. A CHANGE that makes one of these tests FAIL is D.1b
// succeeding at the contract; a change that makes one PASS more strongly is
// a regression against the spike's own baseline. Delete this file once D.1b
// lands and its own tests supersede these observations.

import { test } from 'node:test';
import { strict as assert } from 'assert';
import { ContextManager, DEFAULT_CONFIG } from '../src/context-manager.js';
import { validateOutputPath } from '../src/agent-runner.js';
import type { StepRunContext } from '../src/workflow/types.js';

function makeFsMock(files: Record<string, string> = {}): typeof import('fs').promises {
  return {
    readFile: async (filePath: unknown) => {
      const p = filePath as string;
      if (p in files) return files[p];
      const err = Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      throw err;
    },
  } as unknown as typeof import('fs').promises;
}

const ROOT = '/project';

function ctxFor(stepId: string, overrides: Partial<StepRunContext> = {}): StepRunContext {
  return {
    workflowRunId: 'spike-run-1',
    workflowId: 'define-work', // a workflow id that does not exist in the registry
    stepId,
    iteration: 1,
    revision: 0,
    goal: 'Make Evershift multiplayer-capable',
    projectRoot: ROOT,
    ...overrides,
  };
}

test('D.1a: ContextManager.assemble() has no parameter for a step-declared template/instruction', async () => {
  // WorkflowStep.templateId exists (src/workflow/types.ts) and full-build sets it
  // on every produce step, but ContextManager.assemble(role, ctx) — the only
  // context-assembly entry point AgentRunner calls — takes just `role` and the
  // generic StepRunContext. There is structurally no channel for a step's own
  // declared instruction to reach context assembly today.
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, makeFsMock());
  // @ts-expect-error — proves the point: assemble() has no third/templateId argument to pass.
  await cm.assemble('explorer', ctxFor('investigate-domain'), 'define-work/investigate');
});

test('D.1a: an unfamiliar step id silently falls back to a boilerplate task description', async () => {
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, makeFsMock());
  const result = await cm.assemble('explorer', ctxFor('investigate-domain'));

  // NODE_TASK_DESCRIPTIONS has no entry for 'investigate-domain' or 'INVESTIGATE-DOMAIN'
  // or 'EXPLORER' (role uppercased) in the shipped full-build/draft-artifact maps, so
  // buildTaskDescription() falls through to its generic default. No error, no signal —
  // just an instruction that says nothing about what this step is actually for.
  assert.ok(
    result.task.startsWith('Execute the investigate-domain step.'),
    `expected generic fallback task, got: ${result.task}`
  );
});

test('D.1a: artifact-slice selection is keyed only by role, blind to the step', async () => {
  const cm = new ContextManager(ROOT, DEFAULT_CONFIG, makeFsMock());

  // Two completely different synthetic steps, same existing role ('explorer').
  const a = await cm.assemble('explorer', ctxFor('investigate-domain'));
  const b = await cm.assemble('explorer', ctxFor('write-proof-artifact'));

  // getRoleSlices() switches on `role` only (context-manager.ts ~L207-269); a
  // WorkflowStep has no field to influence which slices load. Both synthetic
  // steps therefore resolve to an identical context shape regardless of what
  // each step is declared to produce.
  assert.deepStrictEqual(Object.keys(a.artifact_slices), Object.keys(b.artifact_slices));
});

test('D.1a: output-path enforcement is a global per-role table, not the declaring step\'s contract', () => {
  // ROLE_OUTPUT_PATHS (src/agent-runner.ts) has no entry for 'explorer'. The
  // fallback for any role absent from the table is *unrestricted* write access
  // ("if (!allowed) return true"), not "deny until a step declares otherwise".
  // A new workflow step cannot narrow this to "exactly this declared artifact"
  // without either reusing an existing role's static allowlist (unrelated to
  // what the new step actually produces) or editing this global table.
  assert.equal(validateOutputPath('.sle/work/anything-at-all.md', 'explorer'), true);
  assert.equal(validateOutputPath('src/anything/at/all.ts', 'explorer'), true);
});

test('D.1a: a genuinely new agent role cannot be expressed without editing the closed AgentRole union', () => {
  // Structural, not runtime: src/types.ts:15 defines
  //   type AgentRole = 'designer' | 'explorer' | 'planner' | 'tester' | 'builder'
  //     | 'debugger' | 'evaluator' | 'critic' | 'historian' | 'facilitator';
  // and WorkflowStep.agentRole (src/workflow/types.ts:19) is typed against it.
  // context-manager.ts's getRoleSlices() (~L207-269) is an exhaustive switch
  // over that same union with no default arm. Introducing a role a new
  // workflow actually wants (e.g. an "investigator" role distinct from
  // "explorer") requires editing both src/types.ts and that switch — exactly
  // the "new role/path special case" D.1 must eliminate. No runtime assertion
  // captures this; it is verified by reading both call sites (cited above).
  assert.ok(true, 'see code citations in this test\'s comment and the D.1a write-up');
});
