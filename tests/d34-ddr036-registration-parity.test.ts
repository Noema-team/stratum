// DDR-036 — registration parity pin. PR #12's lesson: the qualification
// harness can drift from production's contract registration while every
// test stays green (E2-B/E2-C measured a degraded protocol for that
// reason). The operator deferred a shared runner-configuration factory
// until a SECOND drift event; until then, this source-level pin is the
// guard: production (src/application.ts) and the qualification harness
// (tests/fixtures/d3d/harness.ts) must register the SAME contract registry
// keys. A key present in one and not the other fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

function registeredKeys(sourcePath: string): Set<string> {
  const text = readFileSync(join(root, sourcePath), 'utf-8');
  const keys = new Set<string>();
  // The registry literals are written one key per line:
  //   'decision-request': createDecisionRequestOutputContract(),
  const re = /^\s+'?([a-z-]+)'?:\s*(?:READINESS_OUTPUT_CONTRACT|create\w+OutputContract)/gm;
  for (const m of text.matchAll(re)) keys.add(m[1]);
  return keys;
}

test('DDR-036 PARITY: production and the qualification harness register the same output contracts', () => {
  const production = registeredKeys('src/application.ts');
  const harness = registeredKeys('tests/fixtures/d3d/harness.ts');
  assert.ok(production.size >= 5, `expected the five DDR-034/36 contracts in production, found: ${[...production]}`);
  assert.deepEqual(
    [...harness].sort(),
    [...production].sort(),
    'contract registration has drifted between production and the qualification harness — ' +
      'E2-B/C measured a degraded protocol for exactly this reason (PR #12); fix before any run',
  );
});
