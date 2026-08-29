// Architecture fitness: nothing under src/workflow/ may import the legacy
// dag-runner.ts, cycle-runner.ts, or agent-runner.ts modules. This ensures the
// generic step engine stays independent of the legacy execution path and remains
// testable without the full CycleRunner / AgentRunner machinery.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../../src/workflow');

function collectTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...collectTsFiles(full));
    } else if (entry.endsWith('.ts')) {
      results.push(full);
    }
  }
  return results;
}

test('src/workflow/** must not import dag-runner or cycle-runner', () => {
  const files = collectTsFiles(ROOT);
  assert.ok(files.length > 0, 'must find workflow source files');

  const violations: string[] = [];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const rel = path.relative(process.cwd(), file);
    if (/from ['"].*dag-runner/.test(src)) violations.push(`${rel}: imports dag-runner`);
    if (/from ['"].*cycle-runner/.test(src)) violations.push(`${rel}: imports cycle-runner`);
  }

  assert.deepEqual(violations, [], `Legacy seam violations found:\n${violations.join('\n')}`);
});

// WorkflowEngine must contain no hardcoded full-build step IDs. All
// full-build-specific step ID branches have moved to FullBuildStepRunner.
test('src/workflow/engine.ts must not contain hardcoded full-build step IDs', () => {
  const enginePath = path.resolve(fileURLToPath(import.meta.url), '../../src/workflow/engine.ts');
  const src = readFileSync(enginePath, 'utf8');
  const FULL_BUILD_STEP_IDS = [
    'critique', 'validation_gate', 'sharding_approval', 'confirm',
    'scoping.checkpoint', 'snapshot',
  ];
  const violations: string[] = [];
  for (const id of FULL_BUILD_STEP_IDS) {
    // Detect string literal comparisons like step.id === 'critique' or
    // step.id === "sharding_approval". Comments and imports are acceptable.
    const pattern = new RegExp(`step\\.id\\s*===?\\s*['"]${id}['"]|['"]${id}['"]\\s*===?\\s*step\\.id`);
    if (pattern.test(src)) {
      violations.push(`engine.ts contains hardcoded step ID '${id}'`);
    }
  }
  assert.deepEqual(violations, [], `Engine step-ID leakage:\n${violations.join('\n')}`);
});

test('src/workflow/** must not import agent-runner (step execution is via StepRunner interface)', () => {
  const files = collectTsFiles(ROOT);
  const violations: string[] = [];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const rel = path.relative(process.cwd(), file);
    // Allow type-only imports of AgentRunResult if needed for result shaping, but
    // forbid importing the AgentRunner class (which carries DAGNodeId semantics).
    if (/import\s+(?!type).*from ['"].*agent-runner/.test(src)) {
      violations.push(`${rel}: value-imports agent-runner`);
    }
    if (/import type.*AgentRunner[^R].*from ['"].*agent-runner/.test(src)) {
      violations.push(`${rel}: imports AgentRunner type (use StepRunner interface instead)`);
    }
  }
  assert.deepEqual(violations, [], `AgentRunner seam violations:\n${violations.join('\n')}`);
});
