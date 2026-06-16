import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { CriticAgent } from '../src/critic-agent.js';
import { CritiqueResultSchema } from '../src/types.js';
import type { ILLMProvider, LLMCompletionParams, LLMCompletionResult } from '../src/llm-provider.js';

// A mock LLM provider for tests
class MockLLMProvider implements ILLMProvider {
  public callCount = 0;
  public lastParams?: LLMCompletionParams;
  public responseText = '{"blocking_issues": [], "warnings": [], "suggestions": [], "pass": true}';
  public throwError = false;

  async complete(params: LLMCompletionParams): Promise<LLMCompletionResult> {
    this.callCount++;
    this.lastParams = params;
    if (this.throwError) {
      throw new Error('Mock LLM connection error');
    }
    return {
      content: this.responseText,
      tokens_used: 120,
      duration_ms: 10,
    };
  }
}

test('CriticAgent - standard passing critique', async () => {
  const provider = new MockLLMProvider();
  provider.responseText = JSON.stringify({
    blocking_issues: [],
    warnings: ['Warning A'],
    suggestions: ['Suggestion B'],
    pass: true,
  });

  const agent = new CriticAgent(provider, 'mock-model');
  const result = await agent.critique({
    architecture: 'Arch content',
    requirements: 'Req content',
    contextSummary: 'Context summary',
    decisions: 'Decisions content',
  });

  assert.equal(provider.callCount, 1);
  assert.equal(result.pass, true);
  assert.deepEqual(result.blocking_issues, []);
  assert.deepEqual(result.warnings, ['Warning A']);
  assert.deepEqual(result.suggestions, ['Suggestion B']);
  
  // Verify structure validation passes
  CritiqueResultSchema.parse(result);
});

test('CriticAgent - parsing from markdown blocks', async () => {
  const provider = new MockLLMProvider();
  provider.responseText = `Here is the review result:
\`\`\`json
{
  "blocking_issues": ["Issue 1"],
  "warnings": [],
  "suggestions": [],
  "pass": false
}
\`\`\`
Hope this helps!`;

  const agent = new CriticAgent(provider, 'mock-model');
  const result = await agent.critique({
    architecture: 'Arch content',
    requirements: 'Req content',
    contextSummary: 'Context summary',
    decisions: 'Decisions content',
  });

  assert.equal(provider.callCount, 1);
  assert.equal(result.pass, false);
  assert.deepEqual(result.blocking_issues, ['Issue 1']);
});

test('CriticAgent - graceful LLM failure handling', async () => {
  const provider = new MockLLMProvider();
  provider.throwError = true;

  const agent = new CriticAgent(provider, 'mock-model');
  const result = await agent.critique({
    architecture: 'Arch content',
    requirements: 'Req content',
    contextSummary: 'Context summary',
    decisions: 'Decisions content',
  });

  // Must degrade gracefully: pass should be true and include a warning
  assert.equal(result.pass, true);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /Critic LLM failed to execute/);
});

test('CriticAgent - graceful parse failure handling', async () => {
  const provider = new MockLLMProvider();
  provider.responseText = 'This is not valid JSON at all!';

  const agent = new CriticAgent(provider, 'mock-model');
  const result = await agent.critique({
    architecture: 'Arch content',
    requirements: 'Req content',
    contextSummary: 'Context summary',
    decisions: 'Decisions content',
  });

  // Must degrade gracefully: pass should be true and include a warning
  assert.equal(result.pass, true);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /Critic LLM response failed to parse/);
});
