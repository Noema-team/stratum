import { strict as assert } from 'assert';
import {
  RuntimeMap,
  RuntimeMapSchema,
  RuntimeMapManagerImpl,
  createInitialMap,
  cleanupOrphanedTempFiles,
} from '../src/runtime-map.js';

// ============================================================================
// Mock File System for Testing
// ============================================================================

class MockFs {
  private files: Map<string, string> = new Map();
  private renames: Array<[string, string]> = [];

  async readFile(path: string): Promise<string> {
    const content = this.files.get(path);
    if (!content) {
      const error = new Error(`ENOENT: no such file or directory, open '${path}'`);
      (error as any).code = 'ENOENT';
      throw error;
    }
    return content;
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const content = this.files.get(oldPath);
    if (!content) {
      throw new Error(`Cannot rename non-existent file: ${oldPath}`);
    }
    this.files.delete(oldPath);
    this.files.set(newPath, content);
    this.renames.push([oldPath, newPath]);
  }

  async unlink(path: string): Promise<void> {
    this.files.delete(path);
  }

  getFileContent(path: string): string | undefined {
    return this.files.get(path);
  }

  getRenames(): Array<[string, string]> {
    return this.renames;
  }

  clear(): void {
    this.files.clear();
    this.renames = [];
  }
}

function makeValidMap(): RuntimeMap {
  return {
    meta: {
      status: 'idle',
      cycle: 0,
      version_id: '123e4567-e89b-12d3-a456-426614174000',
      initialized_at: '2026-05-08T12:00:00Z',
      updated_at: '2026-05-08T12:00:00Z',
    },
    project: {
      name: 'test-project',
      description: 'A test project',
      type: 'api',
    },
    remotes: {
      code: {
        type: 'git',
        url: 'https://github.com/org/repo.git',
        branch: 'main',
      },
      issues: {
        type: 'git',
        url: 'https://github.com/org/issues',
        branch: 'main',
      },
      docs: {
        url: 'https://github.com/org/docs.git',
        pending: false,
      },
    },
    task_store: {
      type: 'local',
    },
    agents: {
      designer: {
        active: true,
        node: 'design',
        llm: { provider: 'openai_compatible', api_key_env: 'OPENAI_API_KEY', model: 'gpt-4o' },
      },
    },
    discovery: {
      status: 'not_started',
      mode: 'full',
      artifacts: [],
      current_round: 0,
      total_rounds: 4,
      current_phase: 0,
      total_phases: 0,
      open_questions_count: 0,
      blocking_questions_count: 0,
    },
    cycle: {
      number: 0,
      iteration: 0,
      revision: 0,
      max_iterations: 5,
      planning_depth: 'standard',
      started_at: '2026-05-08T12:00:00Z',
      outcome: 'cycling',
      approval_gate: null,
      awaiting_scoping: false,
      awaiting_confirmation: false,
      awaiting_sharding_approval: false,
    },
    chat: {
      session_open: false,
    },
    artifacts: [],
    validation: {
      categories: [],
      gate: {
        mode: 'all_must_pass',
        last_outcome: 'halted',
        failed_categories: [],
      },
    },
  };
}

function makeInitialMapOptions() {
  return {
    projectName: 'test-project',
    projectType: 'api' as const,
    codeRemote: { url: 'https://github.com/test/repo.git', branch: 'main' },
    issuesRemote: { type: 'git' as const, url: 'https://github.com/test/issues', branch: 'main' },
    docsRemote: { url: 'https://github.com/test/docs.git', pending: false },
    taskStore: { type: 'local' as const },
    agents: {} as Record<string, { active: boolean; node: string | null; llm: { provider: string; api_key_env: string; model: string } }>,
  };
}

// ============================================================================
// RuntimeMapSchema Tests
// ============================================================================

async function testRuntimeMapSchemaValid() {
  const result = RuntimeMapSchema.safeParse(makeValidMap());
  assert(result.success, `Valid RuntimeMap should pass validation: ${result.success ? '' : JSON.stringify((result as any).error?.issues)}`);
}

async function testRuntimeMapSchemaMissingField() {
  const invalidMap = {
    meta: {
      status: 'idle',
      cycle: 0,
      initialized_at: '2026-05-08T12:00:00Z',
      updated_at: '2026-05-08T12:00:00Z',
    },
  };

  const result = RuntimeMapSchema.safeParse(invalidMap);
  assert(!result.success, 'RuntimeMap with missing required field should fail');
  assert(result.error?.issues.length! > 0);
}

async function testRuntimeMapSchemaInvalidStatus() {
  const invalidMap = {
    meta: {
      status: 'invalid_status',
      cycle: 0,
      version_id: '123e4567-e89b-12d3-a456-426614174000',
      initialized_at: '2026-05-08T12:00:00Z',
      updated_at: '2026-05-08T12:00:00Z',
    },
  };

  const result = RuntimeMapSchema.safeParse(invalidMap);
  assert(!result.success, 'RuntimeMap with invalid status should fail');
}

async function testRuntimeMapSchemaCorruptedYaml() {
  const result = RuntimeMapSchema.safeParse({ garbage: true });
  assert(!result.success, 'Corrupted data should fail validation');
  const path = result.error?.issues[0]?.path?.join('.') ?? '';
  assert(path.length > 0, 'Error should include field path');
}

// ============================================================================
// createInitialMap Tests
// ============================================================================

async function testCreateInitialMap() {
  const map = createInitialMap(makeInitialMapOptions());

  assert.strictEqual(map.project.name, 'test-project');
  assert.strictEqual(map.meta.status, 'idle');
  assert.strictEqual(map.discovery.status, 'not_started');
  assert(map.meta.version_id.match(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i));
}

async function testCreateInitialMapWithDoltRemote() {
  const map = createInitialMap({
    ...makeInitialMapOptions(),
    issuesRemote: {
      type: 'dolt',
      url: 'dolt://doltdb.com/org/tasks',
      local_dir: '.beads',
      bd_prefix: 'BDS',
    },
    taskStore: { type: 'beads', path: '.beads/tasks' },
  });

  assert.strictEqual(map.remotes.issues.type, 'dolt');
  assert.strictEqual(map.task_store.type, 'beads');
}

async function testCreateInitialMapPassesSchema() {
  const map = createInitialMap(makeInitialMapOptions());
  const result = RuntimeMapSchema.safeParse(map);
  assert(result.success, `createInitialMap() output should pass schema validation: ${result.success ? '' : JSON.stringify((result as any).error?.issues)}`);
}

// ============================================================================
// RuntimeMapManager Tests
// ============================================================================

async function testRuntimeMapManagerWriteAndReadRoundTrip() {
  const mockFs = new MockFs();
  const manager = new RuntimeMapManagerImpl({
    mapPath: '.sle/map.yaml',
    fsModule: mockFs as any,
  });

  const map = createInitialMap(makeInitialMapOptions());
  await manager.write(map);

  const content = mockFs.getFileContent('.sle/map.yaml');
  assert(content, 'Map should be written to actual path');
  assert(content!.includes('test-project'));

  const readBack = await manager.read();
  assert.strictEqual(readBack.project.name, 'test-project');
  assert.strictEqual(readBack.meta.status, 'idle');
}

async function testRuntimeMapManagerAtomicWrite() {
  const mockFs = new MockFs();
  const manager = new RuntimeMapManagerImpl({
    mapPath: '.sle/map.yaml',
    fsModule: mockFs as any,
  });

  const map = createInitialMap(makeInitialMapOptions());
  await manager.write(map);

  const renames = mockFs.getRenames();
  assert(renames.length > 0, 'Should have called rename');
  const [oldPath, newPath] = renames[0];
  assert(oldPath.endsWith('.tmp'), 'Should write to temp file first');
  assert.strictEqual(newPath, '.sle/map.yaml', 'Should rename to actual path');
}

async function testRuntimeMapManagerWriteDoesNotMutateInput() {
  const mockFs = new MockFs();
  const manager = new RuntimeMapManagerImpl({
    mapPath: '.sle/map.yaml',
    fsModule: mockFs as any,
  });

  const map = createInitialMap(makeInitialMapOptions());
  const originalUpdatedAt = map.meta.updated_at;
  await manager.write(map);

  assert.strictEqual(map.meta.updated_at, originalUpdatedAt, 'write() should not mutate the input object');
}

async function testRuntimeMapManagerValidationFails() {
  const mockFs = new MockFs();
  const manager = new RuntimeMapManagerImpl({
    mapPath: '.sle/map.yaml',
    fsModule: mockFs as any,
  });

  const invalidMap = { meta: { status: 'invalid' } };
  await assert.rejects(
    async () => manager.write(invalidMap as any),
    (error: Error) => {
      assert(error instanceof Error);
      return true;
    }
  );

  assert(!mockFs.getFileContent('.sle/map.yaml'), 'No file should be written on validation failure');
  assert(!mockFs.getFileContent('.sle/map.yaml.tmp'), 'No temp file should remain on validation failure');
}

async function testRuntimeMapManagerUpdate() {
  const mockFs = new MockFs();
  const manager = new RuntimeMapManagerImpl({
    mapPath: '.sle/map.yaml',
    fsModule: mockFs as any,
  });

  const initialMap = createInitialMap(makeInitialMapOptions());
  await manager.write(initialMap);

  await manager.update((map) => {
    map.meta.cycle = 5;
    map.meta.status = 'discovering';
    return map;
  });

  const readBack = await manager.read();
  assert.strictEqual(readBack.meta.cycle, 5);
  assert.strictEqual(readBack.meta.status, 'discovering');
}

async function testRuntimeMapManagerConcurrentWrites() {
  const mockFs = new MockFs();
  const manager = new RuntimeMapManagerImpl({
    mapPath: '.sle/map.yaml',
    fsModule: mockFs as any,
  });

  const map1 = createInitialMap(makeInitialMapOptions());
  await manager.write(map1);

  const executed: number[] = [];
  const updates = [
    manager.update((m) => { executed.push(1); m.meta.cycle = 1; return m; }),
    manager.update((m) => { executed.push(2); m.meta.cycle = 2; return m; }),
    manager.update((m) => { executed.push(3); m.meta.cycle = 3; return m; }),
  ];

  await Promise.all(updates);

  assert.strictEqual(executed.length, 3, 'All 3 updates must execute');
  const readBack = await manager.read();
  assert([1, 2, 3].includes(readBack.meta.cycle), 'Concurrent updates should be serialized (one of the values)');
}

async function testRuntimeMapManagerGetVersion() {
  const mockFs = new MockFs();
  const manager = new RuntimeMapManagerImpl({
    mapPath: '.sle/map.yaml',
    fsModule: mockFs as any,
  });

  assert.strictEqual(manager.getVersion(), '', 'Version should be empty before first write');

  const map = createInitialMap(makeInitialMapOptions());
  await manager.write(map);

  assert.strictEqual(manager.getVersion(), map.meta.version_id, 'Version should match after write');
}

// ============================================================================
// Cleanup Tests
// ============================================================================

async function testCleanupOrphanedTempFiles() {
  const mockFs = new MockFs();

  await mockFs.writeFile('.sle/map.yaml.tmp', 'orphaned content');
  assert(mockFs.getFileContent('.sle/map.yaml.tmp'), 'Temp file should exist');

  await cleanupOrphanedTempFiles('.sle/map.yaml', mockFs as any);
  assert(!mockFs.getFileContent('.sle/map.yaml.tmp'), 'Orphaned temp file should be deleted');
}

async function testCleanupNoTempFile() {
  const mockFs = new MockFs();
  let threw = false;
  try {
    await cleanupOrphanedTempFiles('.sle/map.yaml', mockFs as any);
  } catch {
    threw = true;
  }
  assert(!threw, 'Should handle missing temp file without throwing');
}

async function testManagerReadNonexistentFile() {
  const mockFs = new MockFs();
  const manager = new RuntimeMapManagerImpl({
    mapPath: '.sle/map.yaml',
    fsModule: mockFs as any,
  });

  await assert.rejects(
    async () => manager.read(),
    (error: Error) => {
      assert(error instanceof Error);
      assert(error.message.includes('Failed to read RuntimeMap'), `Error message should be descriptive: ${error.message}`);
      return true;
    }
  );
}

async function testManagerReadCorruptedYaml() {
  const mockFs = new MockFs();
  await mockFs.writeFile('.sle/map.yaml', 'meta:\n  status: not_a_real_status\n  garbage: true\n');

  const manager = new RuntimeMapManagerImpl({
    mapPath: '.sle/map.yaml',
    fsModule: mockFs as any,
  });

  await assert.rejects(
    async () => manager.read(),
    (error: Error) => {
      assert(error instanceof Error);
      assert(error.message.includes('Failed to read RuntimeMap'), `Error message should be descriptive: ${error.message}`);
      return true;
    }
  );
}

// ============================================================================
// Run All Tests
// ============================================================================

async function runAllTests() {
  console.log('Running Phase B (Runtime Map) tests...\n');

  const tests: Array<{ name: string; fn: () => Promise<void> }> = [
    { name: 'RuntimeMapSchema valid', fn: testRuntimeMapSchemaValid },
    { name: 'RuntimeMapSchema missing field', fn: testRuntimeMapSchemaMissingField },
    { name: 'RuntimeMapSchema invalid status', fn: testRuntimeMapSchemaInvalidStatus },
    { name: 'RuntimeMapSchema corrupted data', fn: testRuntimeMapSchemaCorruptedYaml },
    { name: 'createInitialMap', fn: testCreateInitialMap },
    { name: 'createInitialMap with Dolt remote', fn: testCreateInitialMapWithDoltRemote },
    { name: 'createInitialMap passes schema', fn: testCreateInitialMapPassesSchema },
    { name: 'Manager write + read round-trip', fn: testRuntimeMapManagerWriteAndReadRoundTrip },
    { name: 'Manager atomic write', fn: testRuntimeMapManagerAtomicWrite },
    { name: 'Manager write does not mutate input', fn: testRuntimeMapManagerWriteDoesNotMutateInput },
    { name: 'Manager validation fails', fn: testRuntimeMapManagerValidationFails },
    { name: 'Manager update', fn: testRuntimeMapManagerUpdate },
    { name: 'Manager concurrent writes', fn: testRuntimeMapManagerConcurrentWrites },
    { name: 'Manager getVersion', fn: testRuntimeMapManagerGetVersion },
    { name: 'Manager read nonexistent file', fn: testManagerReadNonexistentFile },
    { name: 'Manager read corrupted YAML', fn: testManagerReadCorruptedYaml },
    { name: 'Cleanup orphaned temp files', fn: testCleanupOrphanedTempFiles },
    { name: 'Cleanup no temp file', fn: testCleanupNoTempFile },
  ];

  for (const test of tests) {
    try {
      await test.fn();
      console.log(`  ✓ ${test.name}`);
    } catch (error) {
      console.error(`  ✗ ${test.name}`);
      throw error;
    }
  }

  console.log(`\n✅ All ${tests.length} Phase B tests passed!`);
}

runAllTests();
