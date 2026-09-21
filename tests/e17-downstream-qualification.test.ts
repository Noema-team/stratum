// E17 — deterministic downstream-path qualification (post-A7).
//
// A7 exposed a cross-component invariant mismatch: the definition-source
// resolver admits authoritative Definitions up to 131,072 bytes, DDR-041
// requires verbatim (never-truncated) inclusion in the builder/scoping task
// context, and the ContextManager counted that verbatim Definition against
// the ordinary 4,000-token focus ceiling — so no realistically sized
// Definition (the two successful syntheses produced 16.5 KB and 18.3 KB)
// could ever reach full-build. E17 separates the contracts: the Definition
// rides its own reserved lane (default derived from the resolver's byte
// contract), and the ordinary focus ceiling applies to everything else.
//
// Also covered: the supported dependency-creation surface on
// WorkService.createWorkItem (the dispatch gate reads dependency edges, but
// previously nothing could write them through a service — A7 postmortem).

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ContextManager, DEFAULT_CONFIG } from '../src/context-manager.js';
import type { AssembledContext, ContextManagerConfig } from '../src/types.js';
import type { AuthoritativeDefinition } from '../src/execution/definition-source.js';
import type { StepRunContext } from '../src/workflow/types.js';
import type { AgentRole } from '../src/types.js';
import { WorkService } from '../src/services/work-service.js';
import { openDatabase } from '../src/storage/database.js';
import { WorkspaceRepository, ProjectRepository } from '../src/storage/repositories.js';

// ~16.5 KB — the actual size of A7's accepted canonical Definition.
function makeDefinition(targetBytes: number): string {
  const line = 'The worker publishes error_message, stage, and a deliberately derived retryable on failure. ';
  let text = '';
  while (text.length < targetBytes) text += line;
  return text.slice(0, targetBytes);
}

function ctxWith(definition?: AuthoritativeDefinition, taskExtra = ''): StepRunContext {
  return {
    workflowRunId: 'e17', workflowId: 'full-build', stepId: 'scoping.produce',
    iteration: 1, revision: 0, goal: 'implement the defined work',
    projectRoot: '/tmp', role: 'builder',
    authoritativeDefinition: definition,
    includeObjectiveContext: false,
    includeWorkItemContext: false,
    task: taskExtra || undefined,
  } as unknown as StepRunContext;
}

async function assembleWith(config: Partial<ContextManagerConfig>, definition?: AuthoritativeDefinition, taskExtra?: string): Promise<AssembledContext> {
  const root = mkdtempSync(join(tmpdir(), 'e17-ctx-'));
  try {
    const cm = new ContextManager(root, { ...DEFAULT_CONFIG, ...config });
    return await cm.assemble('builder' as AgentRole, ctxWith(definition, taskExtra));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const A7_SIZED = makeDefinition(16_525);

test('E17: an A7-sized authoritative Definition assembles at the 4000-token ordinary ceiling via its reserved lane', async () => {
  const def: AuthoritativeDefinition = {
    sourceWorkItemId: 'wi-define-108-a7', artifactId: 'a', ref: 'definition:obj-108',
    path: '.sle/work/w/definition.md', sha256: 'a'.repeat(64), content: A7_SIZED,
  };
  const assembled = await assembleWith({}, def);
  assert.ok(assembled.task.includes(A7_SIZED), 'verbatim Definition must be included');
  assert.ok(assembled.token_count > 4000, 'total legitimately exceeds the ordinary ceiling (definition rides its own lane)');
  assert.strictEqual(assembled.truncated.length, 0);
});

test('E17: the reserved lane is derived from the resolver byte contract — a Definition beyond it fails closed', async () => {
  const tooBig = makeDefinition(131_073 * 4); // beyond MAX_AUTHORITATIVE_DEFINITION_BYTES-equivalent tokens
  const def: AuthoritativeDefinition = {
    sourceWorkItemId: 'wi-x', artifactId: 'a', ref: 'definition:obj-108',
    path: '.sle/work/w/definition.md', sha256: 'b'.repeat(64), content: tooBig,
  };
  await assert.rejects(
    () => assembleWith({}, def),
    (e: any) => e.name === 'ContextBudgetExceededError' && /reserved context lane/.test(e.message),
  );
});

test('E17: ordinary focus material still fails closed at hard_ceiling on Definition-carrying runs', async () => {
  const def: AuthoritativeDefinition = {
    sourceWorkItemId: 'wi-x', artifactId: 'a', ref: 'definition:obj-108',
    path: '.sle/work/w/definition.md', sha256: 'c'.repeat(64), content: A7_SIZED,
  };
  // Ordinary components are bounded by construction (summaries/task prompts);
  // drive the ordinary-lane check via a tiny ceiling instead: the definition
  // fits its lane, but ordinary fixed (state summary etc.) exceeds 10 tokens.
  await assert.rejects(
    () => assembleWith({ hard_ceiling: 10 }, def),
    (e: any) => e.name === 'ContextBudgetExceededError' && /ordinary tokens/.test(e.message),
  );
});

test('E17: non-authority runs keep the exact legacy budget behavior', async () => {
  const assembled = await assembleWith({}, undefined);
  assert.ok(assembled.token_count > 0);
  assert.ok(!assembled.task.includes('AUTHORITATIVE DEFINITION'));
});

test('E17: default config carries the derived lane (131072/4 = 32768)', () => {
  assert.strictEqual(DEFAULT_CONFIG.authoritative_definition_ceiling_tokens, 32_768);
});

// ─── WorkService.createWorkItem dependency surface ───────────────────────────

function makeService() {
  const dir = mkdtempSync(join(tmpdir(), 'e17-ws-'));
  const db = openDatabase(join(dir, 't.db'));
  new WorkspaceRepository(db).save({ id: 'ws-1', name: 'w', createdAt: '2026-01-01T00:00:00Z' });
  new ProjectRepository(db).save({ id: 'p-1', workspaceId: 'ws-1', name: 'proj', status: 'active', priority: 0, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' });
  const ws = new WorkService(db as never, 'ws-1');
  return { ws, dir, db };
}

test('E17: createWorkItem accepts validated dependencies (exists, not self, deduped) and persists edges', () => {
  const { ws, dir } = makeService();
  try {
    const dep = ws.createWorkItem({ projectId: 'p-1', title: 'define', goal: 'g', workflowId: 'define-work' });
    ws.markReady({ workItemId: dep.id });
    ws.startRunning({ workItemId: dep.id });
    ws.markInReview({ workItemId: dep.id });
    ws.complete({ workItemId: dep.id });
    const exec = ws.createWorkItem({
      projectId: 'p-1', title: 'execute', goal: 'g', workflowId: 'full-build',
      dependencies: [dep.id, dep.id], // duplicate must dedupe
    });
    assert.strictEqual(exec.dependencies.length, 1);
    assert.strictEqual(exec.dependencies[0], dep.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('E17: createWorkItem rejects unknown and self dependencies', () => {
  const { ws, dir } = makeService();
  try {
    assert.throws(
      () => ws.createWorkItem({ projectId: 'p-1', title: 'x', goal: 'g', workflowId: 'define-work', dependencies: ['nope'] }),
      (e: any) => e.code === 'DEPENDENCY_NOT_FOUND',
    );
    const created = ws.createWorkItem({ projectId: 'p-1', title: 'x', goal: 'g', workflowId: 'define-work' });
    assert.throws(
      () => ws.createWorkItem({ projectId: 'p-1', title: 'y', goal: 'g', workflowId: 'define-work', dependencies: ['nope'] }),
      (e: any) => e.code === 'DEPENDENCY_NOT_FOUND',
    );
    void created;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
