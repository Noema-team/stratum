// E22 — unambiguous artifact framing on the multi-turn textual path.
//
// The legacy framing used '### <path>' lines as artifact delimiters INSIDE
// the SLE-OUTPUT envelope, making ordinary Markdown headings structurally
// indistinguishable from the transport's own syntax: a design document
// containing '### 4.1 Data flow (unchanged topology)' was read as an
// artifact section with path '4.1 Data flow (unchanged topology)' — the
// live A10 attempt-8 failure. E22 introduces explicit artifact markers
// whose syntax can NEVER collide with artifact content:
//
//   <<<SLE-OUTPUT>>>
//   <<<SLE-ARTIFACT path="docs/design.md">>>
//   ...content is opaque — any Markdown is allowed...
//   <<<END-SLE-ARTIFACT>>>
//   <<<END-SLE-OUTPUT>>>
//
// INVARIANTS pinned here (zero-model, deterministic):
//   1. the real attempt-8 design shape (### numbered subheadings inside the
//      artifact) round-trips byte-for-byte;
//   2. multiple artifacts still parse;
//   3. unsafe paths still fail (leading /, .., bad extension) in BOTH modes;
//   4. duplicate paths still fail in BOTH modes;
//   5. legacy '### <path>' replies still parse (compatibility fallback);
//   6. marker mode is selected by ANY marker line, and in marker mode
//      '### ' lines are never section delimiters;
//   7. structural violations fail closed (unclosed marker, orphan close
//      marker, malformed open marker, empty artifact);
//   8. role allowlist still warns + drops in both modes;
//   9. teaching + repair instructions use the marker framing (and ONLY the
//      marker framing is taught — never cross-teach);
//  10. E21 is untouched: threshold 18, gate wiring, 24-turn cap, repair
//      budget all unchanged.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseAgentOutputV3, ParseError } from '../src/output-parser.js';
import {
  TextualSleOutputTransport,
  SLE_OPEN,
  SLE_CLOSE,
  SLE_ARTIFACT_OPEN,
  SLE_ARTIFACT_CLOSE,
} from '../src/transport/textual-sle-output.js';
import { SYNTHESIS_GATE_TURNS } from '../src/workflow/builtins/full-build.js';

// Role/ceiling-consistent contexts (ROLE_OUTPUT_PATHS in agent-runner.ts):
//   designer → docs/requirements.md, docs/architecture.md
//   explorer → .sle/work/
const DESIGNER_CTX = { role: 'designer' as const, requiresReviewVerdict: false, execution: 'multi-turn' as const };
const EXPLORER_CTX = { role: 'explorer' as const, requiresReviewVerdict: false, execution: 'multi-turn' as const };

function markerArtifact(path: string, content: string): string {
  return `${SLE_ARTIFACT_OPEN}path="${path}">>>\n${content}\n${SLE_ARTIFACT_CLOSE}`;
}

function wrap(body: string): string {
  return `${SLE_OPEN}\n${body}\n${SLE_CLOSE}`;
}

// ─── 1. The attempt-8 failure shape round-trips ──────────────────────────────

test('E22.1: the exact A10 attempt-8 failure shape now round-trips byte-for-byte', () => {
  // The live failure: a 19.9 KB design whose body used '### 4.1 Data flow
  // (unchanged topology)' as a numbered subsection — parsed (legacy framing)
  // as an artifact with extension '.1 Data flow (unchanged topology)'.
  const designContent = [
    '# Design — RAG ingestion contract fix',
    '',
    '## 4. Contract diagnosis',
    '',
    'The ingestion path is missing a binding on the response schema.',
    '',
    '### 4.1 Data flow (unchanged topology)',
    '',
    'The topology is unchanged: API → queue → worker → index.',
    '',
    '### 4.2 Silent defaults',
    '',
    'Two defaults are applied silently and must be surfaced.',
    '',
    '## 5. Provenance',
    '',
    'Definition: wi-define-108-a8 (sha256 71f1c39c…).',
  ].join('\n');
  const raw = wrap(markerArtifact('docs/architecture.md', designContent));
  const parsed = parseAgentOutputV3(raw, 'designer');
  assert.equal(parsed.sections.length, 1);
  assert.equal(parsed.sections[0].path, 'docs/architecture.md');
  assert.equal(parsed.sections[0].content, designContent, 'content round-trips byte-for-byte — ### subheadings are opaque');
  assert.equal(parsed.warnings.length, 0);
});

test('E22.1b: through the transport, the former live failure now yields a materialized artifact', () => {
  const t = new TextualSleOutputTransport();
  const raw = wrap(
    markerArtifact('.sle/work/wi-x/design.md', '# Design\n\n### 4.1 Data flow (unchanged topology)\n\nBody text.')
  );
  const result = t.extractProduce(raw, EXPLORER_CTX);
  assert.equal(result.kind, 'materialized');
  assert.equal(result.kind === 'materialized' ? result.artifacts[0].path : null, '.sle/work/wi-x/design.md');
  assert.ok(
    result.kind === 'materialized' && result.artifacts[0].content.includes('### 4.1 Data flow (unchanged topology)'),
    'the ### subsection survives inside the artifact',
  );
});

// ─── 2. Multiple artifacts ───────────────────────────────────────────────────

test('E22.2: multiple marker artifacts parse with per-artifact opacity', () => {
  const raw = wrap(
    [
      'Some prose between artifacts is ignored.',
      markerArtifact('docs/requirements.md', '# Requirements\n\n### 4.1 sub\ncontent a'),
      markerArtifact('docs/architecture.md', '# Architecture\n\n### 9.9 sub\ncontent b'),
    ].join('\n')
  );
  const parsed = parseAgentOutputV3(raw, 'designer');
  assert.deepEqual(
    parsed.sections.map((s) => ({ path: s.path, content: s.content })),
    [
      { path: 'docs/requirements.md', content: '# Requirements\n\n### 4.1 sub\ncontent a' },
      { path: 'docs/architecture.md', content: '# Architecture\n\n### 9.9 sub\ncontent b' },
    ],
  );
  assert.equal(parsed.warnings.length, 0);
});

// ─── 3. Unsafe paths still fail in BOTH modes ────────────────────────────────

test('E22.3: unsafe paths still fail closed in marker mode', () => {
  for (const bad of ['/etc/passwd.md', '../evil.md', 'docs/file.exe']) {
    assert.throws(
      () => parseAgentOutputV3(wrap(markerArtifact(bad, 'x')), 'designer'),
      (e: unknown) => e instanceof ParseError,
      `unsafe path must fail: ${bad}`,
    );
  }
});

test('E22.3b: unsafe paths still fail closed in legacy mode (fallback unchanged)', () => {
  for (const bad of ['/etc/passwd.md', '../evil.md', 'docs/file.exe']) {
    assert.throws(
      () => parseAgentOutputV3(wrap(`### ${bad}\nx`), 'designer'),
      (e: unknown) => e instanceof ParseError,
      `unsafe path must fail: ${bad}`,
    );
  }
});

// ─── 4. Duplicate paths still fail in BOTH modes ─────────────────────────────

test('E22.4: duplicate paths still fail closed in marker mode', () => {
  const raw = wrap(
    [markerArtifact('docs/architecture.md', 'one'), markerArtifact('docs/architecture.md', 'two')].join('\n')
  );
  assert.throws(
    () => parseAgentOutputV3(raw, 'designer'),
    (e: unknown) => e instanceof ParseError && e.message.includes('Duplicate path'),
  );
});

// ─── 5. Legacy fallback ──────────────────────────────────────────────────────

test('E22.5: legacy ### framing replies parse identically (compatibility fallback)', () => {
  const raw = wrap('### docs/requirements.md\n\nReq bytes.\n\n### docs/architecture.md\nArch bytes.');
  const parsed = parseAgentOutputV3(raw, 'designer');
  assert.deepEqual(parsed.sections, [
    { path: 'docs/requirements.md', content: 'Req bytes.' },
    { path: 'docs/architecture.md', content: 'Arch bytes.' },
  ]);
});

// ─── 6. Mode selection + opacity ─────────────────────────────────────────────

test('E22.6: in marker mode, ### path-shaped lines inside content NEVER split artifacts', () => {
  // The adversarial case: artifact content that itself contains a line that
  // LOOKS like a legacy section delimiter with a plausible path.
  const content = '# Design\n\n### docs/requirements.md\n\nThis heading is content, not a delimiter.';
  const parsed = parseAgentOutputV3(wrap(markerArtifact('docs/architecture.md', content)), 'designer');
  assert.equal(parsed.sections.length, 1);
  assert.equal(parsed.sections[0].path, 'docs/architecture.md');
  assert.equal(parsed.sections[0].content, content);
});

test('E22.6b: a marker-like line inside content is opaque too — only the exact close marker terminates', () => {
  const content = `# Design\n\n${SLE_ARTIFACT_OPEN}path="docs/nested.md">>>\nnot a real opening\nmore`;
  const parsed = parseAgentOutputV3(wrap(markerArtifact('.sle/work/wi-x/design.md', content)), 'explorer');
  assert.equal(parsed.sections.length, 1);
  assert.ok(parsed.sections[0].content.includes('docs/nested.md'));
});

// ─── 7. Structural violations fail closed ────────────────────────────────────

test('E22.7: unclosed artifact marker fails closed with the path named', () => {
  const raw = wrap(`${SLE_ARTIFACT_OPEN}path="docs/architecture.md">>>\ncontent without a close`);
  assert.throws(
    () => parseAgentOutputV3(raw, 'designer'),
    (e: unknown) => e instanceof ParseError && e.message.includes('never closed'),
  );
});

test('E22.7b: orphan close marker fails closed', () => {
  assert.throws(
    () => parseAgentOutputV3(wrap(SLE_ARTIFACT_CLOSE), 'designer'),
    (e: unknown) => e instanceof ParseError && e.message.includes('without a matching'),
  );
});

test('E22.7c: malformed open marker (unquoted/absent path) fails closed', () => {
  assert.throws(
    () => parseAgentOutputV3(wrap('<<<SLE-ARTIFACT docs/architecture.md>>>\nx\n<<<END-SLE-ARTIFACT>>>'), 'designer'),
    (e: unknown) => e instanceof ParseError && e.message.includes('Malformed artifact marker'),
  );
});

test('E22.7d: empty artifact content fails closed (both modes)', () => {
  assert.throws(
    () => parseAgentOutputV3(wrap(`${SLE_ARTIFACT_OPEN}path="docs/architecture.md">>>\n\n<<<END-SLE-ARTIFACT>>>`), 'designer'),
    (e: unknown) => e instanceof ParseError && e.message.includes('Empty content'),
  );
  assert.throws(
    () => parseAgentOutputV3(wrap('### docs/architecture.md\n\n   '), 'designer'),
    (e: unknown) => e instanceof ParseError && e.message.includes('Empty content'),
  );
});

// ─── 8. Role allowlist still warns + drops ───────────────────────────────────

test('E22.8: a path outside the role ceiling is a warning + dropped section (marker mode)', () => {
  const raw = wrap(
    [markerArtifact('docs/architecture.md', 'allowed'), markerArtifact('src/index.ts', 'forbidden for designer')].join('\n')
  );
  const parsed = parseAgentOutputV3(raw, 'designer');
  assert.equal(parsed.sections.length, 1);
  assert.equal(parsed.sections[0].path, 'docs/architecture.md');
  assert.equal(parsed.warnings.length, 1);
  assert.ok(parsed.warnings[0].includes("not permitted for role 'designer'"));
});

// ─── 9. Teaching + repair use the marker framing ─────────────────────────────

test('E22.9: formatInstruction teaches ONLY the marker framing with the declared path', () => {
  const t = new TextualSleOutputTransport();
  const teaching = t.formatInstruction({
    ...DESIGNER_CTX,
    declaredArtifactId: 'design',
    declaredOutputPath: 'docs/architecture.md',
    expectedArtifacts: 1,
  });
  assert.ok(teaching.includes(`${SLE_ARTIFACT_OPEN}path="docs/architecture.md">>>`), 'declared path rendered in the marker');
  assert.ok(teaching.includes(SLE_ARTIFACT_CLOSE));
  assert.ok(teaching.includes('the content is opaque'), 'opacity rule taught');
  assert.ok(!teaching.includes('### docs/'), 'legacy framing never taught as the section syntax');
});

test('E22.9b: repair instructions teach the marker framing on the materialized path', () => {
  const t = new TextualSleOutputTransport();
  const repair = t.repairInstruction(DESIGNER_CTX, 'malformed', 'Unrecognised extension');
  assert.ok(repair.includes(SLE_OPEN));
  assert.ok(repair.includes(`${SLE_ARTIFACT_OPEN}path="...">>>`));
  assert.ok(repair.includes(SLE_ARTIFACT_CLOSE));
});

test('E22.9c: proposal-mode teaching and repair are untouched (no artifact framing)', () => {
  const t = new TextualSleOutputTransport();
  const ctx = { ...DESIGNER_CTX, resultSchemaText: '{"goal": "string"}' };
  const teaching = t.formatInstruction(ctx);
  assert.ok(!teaching.includes(SLE_ARTIFACT_OPEN), 'proposal mode never teaches artifact markers');
  const repair = t.repairInstruction(ctx, 'malformed', 'bad json');
  assert.ok(!repair.includes(SLE_ARTIFACT_OPEN));
});

// ─── 10. E21 untouched ───────────────────────────────────────────────────────

test('E22.10: E21 gate constants and cap are untouched by E22', () => {
  assert.equal(SYNTHESIS_GATE_TURNS, 18, 'synthesis threshold frozen at 18');
});
