import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { promises as fs } from 'fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWikilinks } from '../src/wikilink-parser.js';
import { LinkIndexManager } from '../src/link-index.js';
import { ContextManager } from '../src/context-manager.js';

test('Link Indexing: parsing double-bracket wikilinks correctly', () => {
  const text = 'Check out [[doc:requirements]] and [[node:auth:implementation]] as well as [[src/index.ts]]';
  const links = parseWikilinks(text);

  assert.strictEqual(links.length, 3);
  assert.deepEqual(links[0].target, { kind: 'document', key: 'requirements' });
  assert.deepEqual(links[1].target, { kind: 'node', group: 'auth', key: 'implementation' });
  assert.deepEqual(links[2].target, { kind: 'source_file', path: 'src/index.ts' });
});

test('Link Indexing: in-memory backlink compilation and persistent save', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sle-links-test-'));
  const linkIndex = new LinkIndexManager(root);

  await linkIndex.load();
  
  // Directly inject a forward link
  linkIndex['addForwardLink'](
    { kind: 'document', key: 'design' },
    { kind: 'document', key: 'requirements' },
    'Refers to reqs'
  );

  linkIndex['computeBacklinks']();
  await linkIndex.save();

  // Load in another manager instance to verify persistence
  const loader = new LinkIndexManager(root);
  await loader.load();

  assert.strictEqual(loader['index'].links.length, 1);
  assert.deepEqual(loader['index'].links[0].source, { kind: 'document', key: 'design' });

  await fs.rm(root, { recursive: true, force: true });
});

test('Context Manager: hard token budget truncation enforcement', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sle-context-test-'));
  
  // Create folders and files
  await fs.mkdir(join(root, 'docs'), { recursive: true });
  await fs.mkdir(join(root, '.sle', 'prompts'), { recursive: true });

  await fs.writeFile(join(root, 'agent.md'), 'a'.repeat(8000)); // ~2000 tokens
  await fs.writeFile(join(root, '.sle', 'prompts', 'facilitator.md'), 'b'.repeat(4000)); // ~1000 tokens

  const mgr = new ContextManager(root, {
    artifact_slice_size: 1000,
    summary_max_tokens: 200,
    system_prompt_max_tokens: 300,
    hard_ceiling: 1500, // small ceiling to force truncation
  });

  const context = await mgr.assemble('facilitator', {
    cycle_number: 1,
    iteration: 1,
    planning_depth: 'standard',
    intent: 'test intent',
    current_node: 'SCOPING',
  });

  // Ensure total tokens is strictly below the hard ceiling
  assert.ok(context.token_count <= 1500);

  await fs.rm(root, { recursive: true, force: true });
});
