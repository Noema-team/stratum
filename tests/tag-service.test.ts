import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { TagService } from '../src/tag-service.js';
import type { RuntimeMap, RuntimeMapManager } from '../src/runtime-map.js';

console.log('# Running Phase C (Tag Service) tests...');

function makeBaseMap(): RuntimeMap {
  return {
    meta: {
      status: 'cycling', cycle: 1,
      version_id: 'v1', initialized_at: '2026-05-08T12:00:00Z', updated_at: '2026-05-08T12:00:00Z',
    },
    project: { name: 'test', description: 'test', type: 'api' },
    remotes: {
      code: { type: 'git', url: 'https://github.com/org/repo.git', branch: 'main' },
      issues: { type: 'git', url: 'https://github.com/org/issues.git', branch: 'main' },
      docs: { url: 'https://github.com/org/docs.git', pending: false },
    },
    task_store: { type: 'local' }, agents: {},
    discovery: {
      status: 'complete', mode: 'full', completed_at: '2026-05-08T13:00:00Z',
      artifacts: [], current_round: 0, total_rounds: 1,
      current_phase: 0, total_phases: 0, open_questions_count: 0, blocking_questions_count: 0,
    },
    cycle: {
      number: 1, iteration: 1, revision: 0, max_iterations: 5,
      planning_depth: 'standard', started_at: '2026-05-08T14:00:00Z',
      outcome: 'cycling', approval_gate: null,
      awaiting_scoping: false, awaiting_confirmation: false, awaiting_sharding_approval: false,
    },
    artifacts: [],
    tags: [],
  } as unknown as RuntimeMap;
}

class InMemoryMapManager implements RuntimeMapManager {
  public map: RuntimeMap;
  constructor(initial?: RuntimeMap) { this.map = JSON.parse(JSON.stringify(initial ?? makeBaseMap())); }
  async read(): Promise<RuntimeMap> { return JSON.parse(JSON.stringify(this.map)); }
  async update(fn: (m: RuntimeMap) => RuntimeMap): Promise<void> {
    this.map = JSON.parse(JSON.stringify(fn(JSON.parse(JSON.stringify(this.map)))));
  }
  async write(m: RuntimeMap): Promise<void> { this.map = JSON.parse(JSON.stringify(m)); }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

test('TagService: addTag appends a tag to map.tags', async () => {
  const mgr = new InMemoryMapManager();
  const svc = new TagService(mgr);

  const tag = await svc.addTag({ prefix: 'next-cycle', target_ref: 'node:rate-limiting' });

  assert.strictEqual(tag.prefix, 'next-cycle');
  assert.strictEqual(tag.target_ref, 'node:rate-limiting');
  assert.strictEqual(tag.source, 'user');
  assert.strictEqual(mgr.map.tags.length, 1);
});

test('TagService: addTag rejects empty target_ref', async () => {
  const mgr = new InMemoryMapManager();
  const svc = new TagService(mgr);

  await assert.rejects(
    () => svc.addTag({ prefix: 'next-cycle', target_ref: '' }),
    /target_ref/
  );
});

test('TagService: addTag with value and custom source', async () => {
  const mgr = new InMemoryMapManager();
  const svc = new TagService(mgr);

  const tag = await svc.addTag({
    prefix: 'scope',
    target_ref: 'doc:architecture',
    value: 'draft-42',
    source: 'facilitator',
  });

  assert.strictEqual(tag.value, 'draft-42');
  assert.strictEqual(tag.source, 'facilitator');
});

test('TagService: getTagged filters by prefix', async () => {
  const mgr = new InMemoryMapManager();
  const svc = new TagService(mgr);

  await svc.addTag({ prefix: 'next-cycle', target_ref: 'node:a' });
  await svc.addTag({ prefix: 'next-cycle', target_ref: 'node:b' });
  await svc.addTag({ prefix: 'area', target_ref: 'node:c', value: 'security' });

  const nextCycleTags = await svc.getTagged('next-cycle');
  const areaTags = await svc.getTagged('area');

  assert.strictEqual(nextCycleTags.length, 2);
  assert.strictEqual(areaTags.length, 1);
});

test('TagService: removeTag removes a matching tag and returns true', async () => {
  const mgr = new InMemoryMapManager();
  const svc = new TagService(mgr);

  await svc.addTag({ prefix: 'next-cycle', target_ref: 'node:a' });

  const removed = await svc.removeTag('node:a', 'next-cycle');

  assert.strictEqual(removed, true);
  assert.strictEqual(mgr.map.tags.length, 0);
});

test('TagService: removeTag returns false when no match', async () => {
  const mgr = new InMemoryMapManager();
  const svc = new TagService(mgr);

  const removed = await svc.removeTag('node:nonexistent', 'next-cycle');

  assert.strictEqual(removed, false);
});

test('TagService: removeTag matches on value when provided', async () => {
  const mgr = new InMemoryMapManager();
  const svc = new TagService(mgr);

  await svc.addTag({ prefix: 'scope', target_ref: 'doc:architecture', value: 'draft-1' });
  await svc.addTag({ prefix: 'scope', target_ref: 'doc:architecture', value: 'draft-2' });

  const removed = await svc.removeTag('doc:architecture', 'scope', 'draft-1');

  assert.strictEqual(removed, true);
  assert.strictEqual(mgr.map.tags.length, 1);
  assert.strictEqual(mgr.map.tags[0].value, 'draft-2');
});

test('TagService: clearTag removes all tags with prefix when no targetRefs given', async () => {
  const mgr = new InMemoryMapManager();
  const svc = new TagService(mgr);

  await svc.addTag({ prefix: 'next-cycle', target_ref: 'node:a' });
  await svc.addTag({ prefix: 'next-cycle', target_ref: 'node:b' });
  await svc.addTag({ prefix: 'area', target_ref: 'node:c', value: 'security' });

  const cleared = await svc.clearTag('next-cycle');

  assert.strictEqual(cleared, 2);
  assert.strictEqual(mgr.map.tags.length, 1);
  assert.strictEqual(mgr.map.tags[0].prefix, 'area');
});

test('TagService: clearTag with targetRefs only clears matching refs (DDR-028 partial clear)', async () => {
  const mgr = new InMemoryMapManager();
  const svc = new TagService(mgr);

  await svc.addTag({ prefix: 'next-cycle', target_ref: 'node:a' });
  await svc.addTag({ prefix: 'next-cycle', target_ref: 'node:b' });

  const cleared = await svc.clearTag('next-cycle', ['node:a']);

  assert.strictEqual(cleared, 1);
  assert.strictEqual(mgr.map.tags.length, 1);
  assert.strictEqual(mgr.map.tags[0].target_ref, 'node:b');
});

console.log('# ✅ All Phase C (Tag Service) tests passed!');
