/**
 * Phase B: DDR-029 Typed Output Contracts — 18 unit tests.
 *
 * Tests cover: happy paths, all 8 validation rules, retry path (via AgentRunner mock),
 * and the warning/drop behaviour for out-of-role paths.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseAgentOutputV3, parseWithRetry, ParseError } from '../src/output-parser.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function wrap(body: string): string {
  return `<<<SLE-OUTPUT>>>\n${body}\n<<<END-SLE-OUTPUT>>>`;
}

function section(path: string, content: string): string {
  return `### ${path}\n${content}`;
}

// ─── Happy path tests ─────────────────────────────────────────────────────────

test('DDR-029: single section parsed correctly', () => {
  const raw = wrap(section('docs/requirements.md', '# Requirements\n\nBuild a widget.'));
  const result = parseAgentOutputV3(raw, 'designer');

  assert.strictEqual(result.sections.length, 1);
  assert.strictEqual(result.sections[0].path, 'docs/requirements.md');
  assert.ok(result.sections[0].content.includes('Build a widget'));
  assert.deepStrictEqual(result.warnings, []);
});

test('DDR-029: three sections parsed correctly', () => {
  // Use builder role (deny-list only) so all src/ paths are valid
  const raw = wrap([
    section('src/index.ts', 'export const a = 1;'),
    section('src/lib/db.ts', 'export const db = null;'),
    section('src/api/routes.ts', 'export const router = {};'),
  ].join('\n'));
  const result = parseAgentOutputV3(raw, 'builder');

  assert.strictEqual(result.sections.length, 3);
  assert.strictEqual(result.sections[0].path, 'src/index.ts');
  assert.strictEqual(result.sections[1].path, 'src/lib/db.ts');
  assert.strictEqual(result.sections[2].path, 'src/api/routes.ts');
});

test('DDR-029: whitespace trimmed from paths and content', () => {
  const raw = wrap(`### docs/requirements.md   \n\n  # Content  \n\n`);
  const result = parseAgentOutputV3(raw, 'designer');

  assert.strictEqual(result.sections[0].path, 'docs/requirements.md');
  assert.ok(!result.sections[0].content.startsWith(' '));
  assert.ok(!result.sections[0].content.endsWith(' '));
});

// ─── Structural validation ────────────────────────────────────────────────────

test('DDR-029: missing <<<SLE-OUTPUT>>> → ParseError', () => {
  const raw = 'Here is some output\n<<<END-SLE-OUTPUT>>>';
  assert.throws(() => parseAgentOutputV3(raw, 'designer'), ParseError);
});

test('DDR-029: missing <<<END-SLE-OUTPUT>>> → ParseError', () => {
  const raw = '<<<SLE-OUTPUT>>>\n### docs/requirements.md\n# Req';
  assert.throws(() => parseAgentOutputV3(raw, 'designer'), ParseError);
});

// ─── Path validation ──────────────────────────────────────────────────────────

test('DDR-029: path with .. → ParseError', () => {
  const raw = wrap(section('../secret.md', '# Secret'));
  assert.throws(
    () => parseAgentOutputV3(raw, 'designer'),
    (err: ParseError) => {
      assert.ok(err instanceof ParseError);
      assert.ok(err.message.includes('..'));
      return true;
    }
  );
});

test('DDR-029: path with leading / → ParseError', () => {
  const raw = wrap(section('/etc/passwd.md', '# Contents'));
  assert.throws(
    () => parseAgentOutputV3(raw, 'designer'),
    (err: ParseError) => {
      assert.ok(err instanceof ParseError);
      assert.ok(err.message.includes('leading /'));
      return true;
    }
  );
});

test('DDR-029: unknown extension → ParseError', () => {
  const raw = wrap(section('docs/output.exe', '# Binary'));
  assert.throws(
    () => parseAgentOutputV3(raw, 'designer'),
    (err: ParseError) => {
      assert.ok(err instanceof ParseError);
      assert.ok(err.message.includes('.exe'));
      return true;
    }
  );
});

// ─── Content validation ───────────────────────────────────────────────────────

test('DDR-029: empty section content → ParseError', () => {
  const raw = wrap('### docs/requirements.md\n\n   \n\n### docs/architecture.md\n# Arch');
  assert.throws(
    () => parseAgentOutputV3(raw, 'designer'),
    (err: ParseError) => {
      assert.ok(err instanceof ParseError);
      assert.ok(err.message.includes('Empty content'));
      return true;
    }
  );
});

test('DDR-029: duplicate path in one output → ParseError', () => {
  const raw = wrap([
    section('docs/requirements.md', '# First'),
    section('docs/requirements.md', '# Second'),
  ].join('\n'));
  assert.throws(
    () => parseAgentOutputV3(raw, 'designer'),
    (err: ParseError) => {
      assert.ok(err instanceof ParseError);
      assert.ok(err.message.includes('Duplicate'));
      return true;
    }
  );
});

test('DDR-029: more than 20 sections → ParseError', () => {
  const sections = Array.from({ length: 21 }, (_, i) =>
    section(`docs/file${i}.md`, `# File ${i}`)
  ).join('\n');
  const raw = wrap(sections);
  assert.throws(
    () => parseAgentOutputV3(raw, 'designer'),
    (err: ParseError) => {
      assert.ok(err instanceof ParseError);
      assert.ok(err.message.includes('20'));
      return true;
    }
  );
});

test('DDR-029: section content exceeding 100 KB → ParseError', () => {
  const bigContent = 'x'.repeat(100 * 1024 + 1);
  const raw = wrap(section('docs/requirements.md', bigContent));
  assert.throws(
    () => parseAgentOutputV3(raw, 'designer'),
    (err: ParseError) => {
      assert.ok(err instanceof ParseError);
      assert.ok(err.message.includes('100 KB'));
      return true;
    }
  );
});

// ─── Role path enforcement ────────────────────────────────────────────────────

test('DDR-029: path outside ROLE_OUTPUT_PATHS → dropped with warning, rest of output proceeds', () => {
  // designer can only write docs/requirements.md and docs/architecture.md
  // docs/plan.md is NOT allowed for designer
  const raw = wrap([
    section('docs/requirements.md', '# Requirements'),
    section('docs/plan.md', '# Plan'),  // not in designer's allowed paths
  ].join('\n'));
  const result = parseAgentOutputV3(raw, 'designer');

  assert.strictEqual(result.sections.length, 1);
  assert.strictEqual(result.sections[0].path, 'docs/requirements.md');
  assert.strictEqual(result.warnings.length, 1);
  assert.ok(result.warnings[0].includes('docs/plan.md'));
  assert.ok(result.warnings[0].includes('dropped'));
});

test('DDR-029: multiple out-of-role paths → all dropped, all warnings recorded', () => {
  // designer's allowed: docs/requirements.md, docs/architecture.md
  const raw = wrap([
    section('docs/plan.md', '# Plan'),
    section('docs/test-plan.md', '# Tests'),
    section('docs/requirements.md', '# Requirements'),
  ].join('\n'));
  const result = parseAgentOutputV3(raw, 'designer');

  assert.strictEqual(result.sections.length, 1);
  assert.strictEqual(result.warnings.length, 2);
});

test('DDR-029: warning sections not written: only valid sections in result', () => {
  const raw = wrap([
    section('docs/requirements.md', '# Requirements — valid'),
    section('src/index.ts', "export const x = 1;"),  // designer can't write src/
  ].join('\n'));
  const result = parseAgentOutputV3(raw, 'designer');

  // Only requirements.md (valid designer path) should be in sections
  assert.strictEqual(result.sections.length, 1);
  assert.strictEqual(result.sections[0].path, 'docs/requirements.md');
  assert.strictEqual(result.warnings.length, 1);
});

test('DDR-029: valid output with warnings — valid sections still include their content', () => {
  const raw = wrap([
    section('docs/requirements.md', '# Feature Requirements\n\nBuild it.'),
    section('docs/plan.md', '# The Plan'),  // dropped
  ].join('\n'));
  const result = parseAgentOutputV3(raw, 'designer');

  assert.strictEqual(result.sections[0].content, '# Feature Requirements\n\nBuild it.');
});

// ─── Retry path ──────────────────────────────────────────────────────────────

test('DDR-029: retry prompt sent on first parse failure — second attempt succeeds', async () => {
  const badOutput = 'This is not a valid SLE-OUTPUT block at all.';
  const goodOutput = wrap(section('docs/requirements.md', '# Requirements'));
  let rePromptCalled = false;
  let rePromptReason = '';

  const result = await parseWithRetry(badOutput, 'designer', async (reason) => {
    rePromptCalled = true;
    rePromptReason = reason;
    return goodOutput;
  });

  assert.ok(rePromptCalled, 'rePrompt should have been called');
  assert.ok(rePromptReason.includes('SLE-OUTPUT'), 'reason should mention the missing delimiter');
  assert.strictEqual(result.sections.length, 1);
  assert.strictEqual(result.sections[0].path, 'docs/requirements.md');
});

test('DDR-029: second parse failure propagates ParseError', async () => {
  const badOutput = 'No delimiters here.';
  const alsoInvalid = 'Still no delimiters.';

  await assert.rejects(
    () => parseWithRetry(badOutput, 'designer', async () => alsoInvalid),
    ParseError
  );
});

test('DDR-029: builder can write src/ paths (no deny-list restriction for recognised files)', () => {
  const raw = wrap([
    section('src/index.ts', "export const app = () => 'hello';"),
    section('src/lib/db.ts', 'export const db = null;'),
  ].join('\n'));
  const result = parseAgentOutputV3(raw, 'builder');

  assert.strictEqual(result.sections.length, 2);
  assert.deepStrictEqual(result.warnings, []);
});
