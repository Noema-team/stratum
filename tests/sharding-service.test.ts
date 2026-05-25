import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { LocalTaskStore, ShardingService } from '../src/sharding-service.js';
import { LinkIndexManager } from '../src/link-index.js';
import type { SLETask, ShardingProposal } from '../src/types.js';

test('LocalTaskStore - basic lifecycle and dependency resolution', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sle-taskstore-test-'));
  const store = new LocalTaskStore(root);

  const t1 = await store.createTask({
    title: 'Task One',
    description: 'Implement backend router',
    status: 'open',
    priority: 1,
    dependencies: [],
  });

  const t2 = await store.createTask({
    title: 'Task Two',
    description: 'Implement auth middleware',
    status: 'open',
    priority: 2,
    dependencies: [t1.id],
  });

  assert.equal(t1.id, 'task-task-one');
  assert.equal(t2.id, 'task-task-two');

  // getReadyTasks: only t1 should be ready because t2 is blocked by t1
  let ready = await store.getReadyTasks();
  assert.equal(ready.length, 1);
  assert.equal(ready[0].id, t1.id);

  // Close t1
  await store.closeTask(t1.id);

  // getReadyTasks: now t2 is unblocked and ready!
  ready = await store.getReadyTasks();
  assert.equal(ready.length, 1);
  assert.equal(ready[0].id, t2.id);

  await fs.rm(root, { recursive: true, force: true });
});

test('ShardingService - Layer 2 coherence checks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sle-layer2-test-'));
  const linkIndex = new LinkIndexManager(root);
  await linkIndex.load();

  const service = new ShardingService(root, linkIndex);

  // 1. Missing description blocker
  const tBad: SLETask = {
    id: 'task-bad',
    title: 'Task Bad',
    description: '',
    status: 'open',
    priority: 1,
    dependencies: [],
    created_at: '',
    updated_at: '',
  };

  let findings = await service.checkLayer2Coherence([tBad]);
  assert.ok(findings.some(f => f.type === 'missing_document' && f.severity === 'blocking'));

  // 2. Cyclic dependency blocker
  const tCyclic1: SLETask = {
    id: 'task-c1',
    title: 'Task C1',
    description: 'Desc',
    status: 'open',
    priority: 1,
    dependencies: ['task-c2'],
    created_at: '',
    updated_at: '',
  };

  const tCyclic2: SLETask = {
    id: 'task-c2',
    title: 'Task C2',
    description: 'Desc',
    status: 'open',
    priority: 1,
    dependencies: ['task-c1'],
    created_at: '',
    updated_at: '',
  };

  findings = await service.checkLayer2Coherence([tCyclic1, tCyclic2]);
  assert.ok(findings.some(f => f.type === 'contradiction' && f.severity === 'blocking'));

  // 3. Invalid prefix slice blocker
  const tInvalidSlice: SLETask = {
    id: 'task-slice',
    title: 'Task Slice',
    description: 'Desc',
    status: 'open',
    priority: 1,
    dependencies: [],
    context_declarations: [
      {
        task_id: 'task-slice',
        slices: ['invalid_prefix:requirements' as any],
        intent: 'Test',
      },
    ],
    created_at: '',
    updated_at: '',
  };

  findings = await service.checkLayer2Coherence([tInvalidSlice]);
  assert.ok(findings.some(f => f.type === 'undefined_reference' && f.severity === 'blocking'));

  // 4. Duplicate scope warning (modify same file)
  const tScope1: SLETask = {
    id: 'task-s1',
    title: 'Task S1',
    description: 'Desc',
    status: 'open',
    priority: 1,
    dependencies: [],
    context_declarations: [
      {
        task_id: 'task-s1',
        slices: ['doc:requirements'],
        intent: 'modify src/auth.ts to add JWT login',
      },
    ],
    created_at: '',
    updated_at: '',
  };

  const tScope2: SLETask = {
    id: 'task-s2',
    title: 'Task S2',
    description: 'Desc',
    status: 'open',
    priority: 1,
    dependencies: [],
    context_declarations: [
      {
        task_id: 'task-s2',
        slices: ['doc:requirements'],
        intent: 'modify src/auth.ts to add cookies support',
      },
    ],
    created_at: '',
    updated_at: '',
  };

  findings = await service.checkLayer2Coherence([tScope1, tScope2]);
  assert.ok(findings.some(f => f.type === 'terminology_conflict' && f.severity === 'warning'));

  await fs.rm(root, { recursive: true, force: true });
});

test('ShardingService - Staleness tracking and task proposal creation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sle-proposal-test-'));
  const linkIndex = new LinkIndexManager(root);
  await linkIndex.load();

  const service = new ShardingService(root, linkIndex);
  const store = service.getTaskStore();

  const proposal: ShardingProposal = {
    total_estimated_tokens: 1500,
    coherence_report: { status: 'clean', findings: [], checked_at: '', document_count: 1 },
    approved_by_user: true,
    tasks: [
      {
        id: 'task-p1',
        title: 'Task P1',
        description: 'Implements database routing schema',
        status: 'open',
        priority: 1,
        dependencies: [],
        context_declarations: [
          {
            task_id: 'task-p1',
            slices: ['doc:requirements#db-section'],
            intent: 'Database schema',
          },
        ],
        created_at: '',
        updated_at: '',
      },
    ],
  };

  const count = await service.createTasksFromProposal(proposal);
  assert.equal(count, 1);

  // Check link index updated with Tier 1 link
  assert.strictEqual(linkIndex['index'].links.length, 1);
  assert.deepEqual(linkIndex['index'].links[0].source, { kind: 'document', key: 'task-task-p1' });

  // Staleness tracking: flag document requirements changes
  const flagged = await service.flagStaleTasks('requirements', 'db-section');
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0], 'task-task-p1');

  // Verify task was marked stale
  const staleTasks = await store.getStale();
  assert.equal(staleTasks.length, 1);
  assert.equal(staleTasks[0].id, 'task-task-p1');

  await fs.rm(root, { recursive: true, force: true });
});
