import { strict as assert } from 'node:assert';
import {
  FACILITATOR_CHAT_TEMPLATE,
  FACILITATOR_DECISION_TEMPLATE,
  FACILITATOR_SCOPING_TEMPLATE,
  FACILITATOR_TEMPLATES,
  REQUIRED_TEMPLATE_SECTIONS,
} from '../src/prompt-templates.js';

function testChatTemplateHasAllSections() {
  for (const section of REQUIRED_TEMPLATE_SECTIONS) {
    assert.ok(
      FACILITATOR_CHAT_TEMPLATE.includes(section),
      `Chat template missing section: ${section}`
    );
  }
}

function testDecisionTemplateHasAllSections() {
  for (const section of REQUIRED_TEMPLATE_SECTIONS) {
    assert.ok(
      FACILITATOR_DECISION_TEMPLATE.includes(section),
      `Decision template missing section: ${section}`
    );
  }
}

function testScopingTemplateHasAllSections() {
  for (const section of REQUIRED_TEMPLATE_SECTIONS) {
    assert.ok(
      FACILITATOR_SCOPING_TEMPLATE.includes(section),
      `Scoping template missing section: ${section}`
    );
  }
}

function testTemplatesRecordHasThreeEntries() {
  const keys = Object.keys(FACILITATOR_TEMPLATES);
  assert.strictEqual(keys.length, 3, 'Should have exactly 3 template entries');
  assert.ok(keys.includes('facilitator-chat.md'));
  assert.ok(keys.includes('facilitator-decision.md'));
  assert.ok(keys.includes('facilitator-scoping.md'));
}

function testRequiredSectionsListHasFive() {
  assert.strictEqual(REQUIRED_TEMPLATE_SECTIONS.length, 5);
  assert.ok(REQUIRED_TEMPLATE_SECTIONS.includes('## Role identity'));
  assert.ok(REQUIRED_TEMPLATE_SECTIONS.includes('## Behavioral constraints'));
  assert.ok(REQUIRED_TEMPLATE_SECTIONS.includes('## Artifact access'));
  assert.ok(REQUIRED_TEMPLATE_SECTIONS.includes('## Output format'));
  assert.ok(REQUIRED_TEMPLATE_SECTIONS.includes('## Reasoning approach'));
}

function testChatTemplateStartsWithTitle() {
  assert.ok(FACILITATOR_CHAT_TEMPLATE.startsWith('# Facilitator — Chat Mode'));
}

function testDecisionTemplateStartsWithTitle() {
  assert.ok(FACILITATOR_DECISION_TEMPLATE.startsWith('# Facilitator — Decision Mode'));
}

function testScopingTemplateStartsWithTitle() {
  assert.ok(FACILITATOR_SCOPING_TEMPLATE.startsWith('# Facilitator — Scoping Mode'));
}

function testChatTemplateHasArtifactAccessTable() {
  assert.ok(FACILITATOR_CHAT_TEMPLATE.includes('doc:product-brief'));
  assert.ok(FACILITATOR_CHAT_TEMPLATE.includes('doc:system-description'));
}

function testDecisionTemplateHasArtifactAccessTable() {
  assert.ok(FACILITATOR_DECISION_TEMPLATE.includes('doc:plan'));
  assert.ok(FACILITATOR_DECISION_TEMPLATE.includes('doc:test-plan'));
}

function testScopingTemplateHasArtifactAccessTable() {
  assert.ok(FACILITATOR_SCOPING_TEMPLATE.includes('doc:cycle-charter'));
  assert.ok(FACILITATOR_SCOPING_TEMPLATE.includes('doc:architecture'));
}

function testSectionsAreInOrder() {
  const orderedSections = [
    '## Role identity',
    '## Behavioral constraints',
    '## Artifact access',
    '## Output format',
    '## Reasoning approach',
  ];

  for (const template of [
    FACILITATOR_CHAT_TEMPLATE,
    FACILITATOR_DECISION_TEMPLATE,
    FACILITATOR_SCOPING_TEMPLATE,
  ]) {
    const indices = orderedSections.map(s => template.indexOf(s));
    for (let i = 1; i < indices.length; i++) {
      assert.ok(
        indices[i] > indices[i - 1],
        `Section "${orderedSections[i]}" must appear after "${orderedSections[i - 1]}"`
      );
    }
  }
}

function runAllTests() {
  const tests = [
    { name: 'Chat template has all 5 sections', fn: testChatTemplateHasAllSections },
    { name: 'Decision template has all 5 sections', fn: testDecisionTemplateHasAllSections },
    { name: 'Scoping template has all 5 sections', fn: testScopingTemplateHasAllSections },
    { name: 'Templates record has 3 entries', fn: testTemplatesRecordHasThreeEntries },
    { name: 'Required sections list has 5 entries', fn: testRequiredSectionsListHasFive },
    { name: 'Chat template starts with title', fn: testChatTemplateStartsWithTitle },
    { name: 'Decision template starts with title', fn: testDecisionTemplateStartsWithTitle },
    { name: 'Scoping template starts with title', fn: testScopingTemplateStartsWithTitle },
    { name: 'Chat template has typed artifact refs', fn: testChatTemplateHasArtifactAccessTable },
    { name: 'Decision template has typed artifact refs', fn: testDecisionTemplateHasArtifactAccessTable },
    { name: 'Scoping template has typed artifact refs', fn: testScopingTemplateHasArtifactAccessTable },
    { name: 'Sections appear in correct order', fn: testSectionsAreInOrder },
  ];

  const failures: Array<{ name: string; error: unknown }> = [];

  for (const test of tests) {
    try {
      test.fn();
      console.log(`  ✓ ${test.name}`);
    } catch (error) {
      console.error(`  ✗ ${test.name}`);
      failures.push({ name: test.name, error });
    }
  }

  if (failures.length > 0) {
    console.error(`\n❌ ${failures.length}/${tests.length} prompt template tests FAILED:`);
    for (const f of failures) {
      console.error(`  - ${f.name}`);
      console.error(`    ${f.error}`);
    }
    throw failures[0].error;
  }

  console.log(`\n✅ All ${tests.length} prompt template tests passed!`);
}

runAllTests();
