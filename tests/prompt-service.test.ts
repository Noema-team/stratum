import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { PromptService, validateTemplate, ALL_ROLES } from '../src/prompt-service.js';

console.log('# Running Phase D (Prompt Service) tests...');

const VALID_TEMPLATE = `# Test Role

## Role identity
You are the Test agent.

## Behavioral constraints
- MUST do the thing
- MUST NOT do the other thing

## Artifact access
- doc:requirements (read)
- doc:plan (write)

## Output format
Plain markdown.

## Reasoning approach
Think carefully.
`;

function makeFsMock(files: Record<string, string> = {}): typeof import('fs').promises {
  return {
    readFile: async (p: unknown) => {
      const key = String(p);
      if (key in files) return files[key];
      throw Object.assign(new Error(`ENOENT: ${key}`), { code: 'ENOENT' });
    },
  } as unknown as typeof import('fs').promises;
}

// ─── validateTemplate ───────────────────────────────────────────────────────

test('validateTemplate: accepts a well-formed template', () => {
  const result = validateTemplate(VALID_TEMPLATE);
  assert.strictEqual(result.valid, true, `expected valid, got errors: ${result.errors}`);
  assert.ok(result.token_count > 0);
});

test('validateTemplate: rejects missing Role identity', () => {
  const content = VALID_TEMPLATE.replace('## Role identity', '## Something else');
  const result = validateTemplate(content);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('Role identity')));
});

test('validateTemplate: rejects Behavioral constraints with zero entries', () => {
  const content = VALID_TEMPLATE.replace(
    '## Behavioral constraints\n- MUST do the thing\n- MUST NOT do the other thing',
    '## Behavioral constraints\nNo bullets here.'
  );
  const result = validateTemplate(content);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('Behavioral constraints')));
});

test('validateTemplate: rejects Artifact access with zero typed refs', () => {
  const content = VALID_TEMPLATE.replace(
    '## Artifact access\n- doc:requirements (read)\n- doc:plan (write)',
    '## Artifact access\nNothing typed here.'
  );
  const result = validateTemplate(content);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('Artifact access')));
});

test('validateTemplate: rejects an untyped artifact reference', () => {
  const content = VALID_TEMPLATE.replace(
    '- doc:requirements (read)',
    '- requirements (read)'
  );
  const result = validateTemplate(content);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('typed prefix')));
});

test('validateTemplate: allows path-like and prose refs without a typed prefix', () => {
  const content = VALID_TEMPLATE.replace(
    '- doc:plan (write)',
    '- src/** (write)\n- agent.md (read)\n- All project docs (read)'
  );
  const result = validateTemplate(content);
  assert.strictEqual(result.valid, true, `expected valid, got errors: ${result.errors}`);
});

test('validateTemplate: rejects Output format missing', () => {
  const content = VALID_TEMPLATE.replace('## Output format\nPlain markdown.\n\n', '');
  const result = validateTemplate(content);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('Output format')));
});

test('validateTemplate: rejects a template over the 500-token budget', () => {
  const longContent = VALID_TEMPLATE + 'x'.repeat(3000);
  const result = validateTemplate(longContent);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('token budget')));
});

// ─── PromptService.getTemplate ──────────────────────────────────────────────

test('PromptService.getTemplate: falls back to built-in template when no override exists', async () => {
  const fs = makeFsMock();
  const svc = new PromptService('/fake/project', fs);

  const template = await svc.getTemplate('builder');

  assert.strictEqual(template.role, 'builder');
  assert.strictEqual(template.source, 'built-in');
  assert.ok(template.validation.valid);
});

test('PromptService.getTemplate: prefers project-local override', async () => {
  const overridePath = '/fake/project/.sle/prompts/builder.md';
  const fs = makeFsMock({ [overridePath]: VALID_TEMPLATE });
  const svc = new PromptService('/fake/project', fs);

  const template = await svc.getTemplate('builder');

  assert.strictEqual(template.source, 'project-override');
  assert.ok(template.content.includes('Test agent'));
});

test('PromptService.getTemplate: throws template_missing for unknown role', async () => {
  const fs = makeFsMock();
  const svc = new PromptService('/fake/project', fs);

  await assert.rejects(
    () => svc.getTemplate('not-a-real-role' as never),
    (err: Error & { code?: string }) => err.code === 'template_missing'
  );
});

test('PromptService.getTemplate: throws template_invalid when override fails validation', async () => {
  const overridePath = '/fake/project/.sle/prompts/builder.md';
  const invalidContent = '# Bad\n\nNo required sections at all.';
  const fs = makeFsMock({ [overridePath]: invalidContent });
  const svc = new PromptService('/fake/project', fs);

  await assert.rejects(
    () => svc.getTemplate('builder'),
    (err: Error & { code?: string }) => err.code === 'template_invalid'
  );
});

// ─── PromptService.listTemplates ────────────────────────────────────────────

test('PromptService.listTemplates: returns an entry for every role', async () => {
  const fs = makeFsMock();
  const svc = new PromptService('/fake/project', fs);

  const entries = await svc.listTemplates();

  assert.strictEqual(entries.length, ALL_ROLES.length);
  for (const role of ALL_ROLES) {
    assert.ok(entries.some((e) => e.role === role), `missing entry for ${role}`);
  }
});

test('PromptService.listTemplates: marks project overrides distinctly from built-ins', async () => {
  const overridePath = '/fake/project/.sle/prompts/builder.md';
  const fs = makeFsMock({ [overridePath]: VALID_TEMPLATE });
  const svc = new PromptService('/fake/project', fs);

  const entries = await svc.listTemplates();
  const builderEntry = entries.find((e) => e.role === 'builder');

  assert.strictEqual(builderEntry?.source, 'project-override');
});

// ─── PromptService.validateAll ──────────────────────────────────────────────

test('PromptService.validateAll: never throws, returns full inventory', async () => {
  const fs = makeFsMock();
  const svc = new PromptService('/fake/project', fs);

  const entries = await svc.validateAll();

  assert.strictEqual(entries.length, ALL_ROLES.length);
});

console.log('# ✅ All Phase D (Prompt Service) tests passed!');
