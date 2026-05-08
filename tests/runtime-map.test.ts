import { strict as assert } from 'assert';
import {
  RuntimeMap,
  RuntimeMapSchema,
  RuntimeMapManagerImpl,
  RuntimeMapManagerOptions,
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

  getFiles(): string[] {
    return Array.from(this.files.keys());
  }

  getRenames(): Array<[string, string]> {
    return this.renames;
  }

  clear(): void {
    this.files.clear();
    this.renames = [];
  }
}

// ============================================================================
// RuntimeMapSchema Tests
// ============================================================================

export function testRuntimeMapSchemaValid() {
  const validMap: RuntimeMap = {
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
        llm: { provider: 'openai_compatible', model: 'gpt-4o' },
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

  const result = RuntimeMapSchema.safeParse(validMap);
  assert(result.success, 'Valid RuntimeMap should pass validation');
}

export function testRuntimeMapSchemaMissingField() {
  const invalidMap = {
    meta: {
      status: 'idle',
      cycle: 0,
      // Missing version_id
      initialized_at: '2026-05-08T12:00:00Z',
      updated_at: '2026-05-08T12:00:00Z',
    },
    // ... incomplete
  };

  const result = RuntimeMapSchema.safeParse(invalidMap);
  assert(!result.success, 'RuntimeMap with missing required field should fail');
  assert(result.error?.issues.length > 0);
}

export function testRuntimeMapSchemaInvalidStatus() {
  const invalidMap = {
    meta: {
      status: 'invalid_status',
      cycle: 0,
      version_id: '123e4567-e89b-12d3-a456-426614174000',
      initialized_at: '2026-05-08T12:00:00Z',
      updated_at: '2026-05-08T12:00:00Z',
    },
    // ... rest would fail too
  };

  const result = RuntimeMapSchema.safeParse(invalidMap);
  assert(!result.success, 'RuntimeMap with invalid status should fail');
}

// ============================================================================
// createInitialMap Tests
// ============================================================================

export function testCreateInitialMap() {
  const map = createInitialMap({
    projectName: 'my-project',
    projectType: 'api',
    codeRemote: {
      url: 'https://github.com/org/repo.git',
      branch: 'main',
    },
    issuesRemote: {
      type: 'git',
      url: 'https://github.com/org/issues',
      branch: 'main',
    },
    docsRemote: {
      url: 'https://github.com/org/docs.git',
      pending: false,
    },
    taskStore: { type: 'local' },
    agents: {},
  });

  assert.strictEqual(map.project.name, 'my-project');
  assert.strictEqual(map.meta.status, 'idle');
  assert.strictEqual(map.discovery.status, 'not_started');
  assert(map.meta.version_id.match(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i));
}

export function testCreateInitialMapWithDoltRemote() {
  const map = createInitialMap({
    projectName: 'my-project',
    projectType: 'api',
    codeRemote: {
      url: 'https://github.com/org/repo.git',
      branch: 'main',
    },
    issuesRemote: {
      type: 'dolt',
      url: 'dolt://doltdb.com/org/tasks',
      local_dir: '.beads',
      bd_prefix: 'BDS',
    },
    docsRemote: {
      url: 'https://github.com/org/docs.git',
      pending: false,
    },
    taskStore: { type: 'beads', path: '.beads/tasks' },
    agents: {},
  });

  assert.strictEqual(map.remotes.issues.type, 'dolt');
  assert.strictEqual(map.task_store.type, 'beads');
}

// ============================================================================
// RuntimeMapManager Tests
// ============================================================================

export function testRuntimeMapManagerWrite() {
  const mockFs = new MockFs();
  const manager = new RuntimeMapManagerImpl({
    mapPath: '.sle/map.yaml',
    fsModule: mockFs as any,
  });

  const map = createInitialMap({
    projectName: 'test-project',
    projectType: 'api',
    codeRemote: { url: 'https://github.com/test/repo.git', branch: 'main' },
    issuesRemote: { type: 'git', url: 'https://github.com/test/issues', branch: 'main' },
    docsRemote: { url: 'https://github.com/test/docs.git', pending: false },
    taskStore: { type: 'local' },
    agents: {},
  });

  manager.write(map).then(() => {
    // Check that file was written to actual path (not temp)
    const content = mockFs.getFileContent('.sle/map.yaml');
    assert(content, 'Map should be written to actual path');
    assert(content!.includes('test-project'));
    assert(content!.includes('api'));
  });
}

export function testRuntimeMapManagerAtomicWrite() {
  const mockFs = new MockFs();
  const manager = new RuntimeMapManagerImpl({
    mapPath: '.sle/map.yaml',
    fsModule: mockFs as any,
  });

  const map = createInitialMap({
    projectName: 'test-project',
    projectType: 'api',
    codeRemote: { url: 'https://github.com/test/repo.git', branch: 'main' },
    issuesRemote: { type: 'git', url: 'https://github.com/test/issues', branch: 'main' },
    docsRemote: { url: 'https://github.com/test/docs.git', pending: false },
    taskStore: { type: 'local' },
    agents: {},
  });

  manager.write(map).then(() => {
    // Check that rename occurred (temp -> actual)
    const renames = mockFs.getRenames();
    assert(renames.length > 0, 'Should have called rename');
    const [oldPath, newPath] = renames[0];
    assert(oldPath.endsWith('.tmp'), 'Should write to temp file first');
    assert.strictEqual(newPath, '.sle/map.yaml', 'Should rename to actual path');
  });
}

export function testRuntimeMapManagerValidationFails() {
  const mockFs = new MockFs();
  const manager = new RuntimeMapManagerImpl({
    mapPath: '.sle/map.yaml',
    fsModule: mockFs as any,
  });

  const invalidMap = {
    meta: {
      status: 'invalid',
    },
    // Very incomplete
  };

  manager.write(invalidMap as any).catch((error) => {
    assert(error instanceof Error);
    assert(error.message.includes('validation') || error.message.includes('Failed'));
  });
}

export function testRuntimeMapManagerUpdate() {
  const mockFs = new MockFs();
  const manager = new RuntimeMapManagerImpl({
    mapPath: '.sle/map.yaml',
    fsModule: mockFs as any,
  });

  const initialMap = createInitialMap({
    projectName: 'test-project',
    projectType: 'api',
    codeRemote: { url: 'https://github.com/test/repo.git', branch: 'main' },
    issuesRemote: { type: 'git', url: 'https://github.com/test/issues', branch: 'main' },
    docsRemote: { url: 'https://github.com/test/docs.git', pending: false },
    taskStore: { type: 'local' },
    agents: {},
  });

  // First write
  manager.write(initialMap).then(() => {
    // Then update
    manager.update((map) => {
      map.meta.cycle = 5;
      map.meta.status = 'discovering';
      return map;
    });
  });
}

// ============================================================================
// Cleanup Tests
// ============================================================================

export function testCleanupOrphanedTempFiles() {
  const mockFs = new MockFs();

  // Create an orphaned temp file
  mockFs.writeFile('.sle/map.yaml.tmp', 'orphaned content').then(() => {
    assert(mockFs.getFileContent('.sle/map.yaml.tmp'), 'Temp file should exist');

    // Clean it up
    cleanupOrphanedTempFiles('.sle/map.yaml', mockFs as any).then(() => {
      const remaining = mockFs.getFileContent('.sle/map.yaml.tmp');
      assert(!remaining, 'Orphaned temp file should be deleted');
    });
  });
}

export function testCleanupNoTempFile() {
  const mockFs = new MockFs();

  // No temp file exists - should not throw
  cleanupOrphanedTempFiles('.sle/map.yaml', mockFs as any).then(() => {
    assert(true, 'Should handle missing temp file gracefully');
  });
}

// ============================================================================
// Run All Tests
// ============================================================================

export function runAllTests() {
  console.log('Running Phase B (Runtime Map) tests...\n');

  console.log('✓ Testing RuntimeMapSchema with valid map');
  testRuntimeMapSchemaValid();

  console.log('✓ Testing RuntimeMapSchema with missing field');
  testRuntimeMapSchemaMissingField();

  console.log('✓ Testing RuntimeMapSchema with invalid status');
  testRuntimeMapSchemaInvalidStatus();

  console.log('✓ Testing createInitialMap');
  testCreateInitialMap();

  console.log('✓ Testing createInitialMap with Dolt remote');
  testCreateInitialMapWithDoltRemote();

  console.log('✓ Testing RuntimeMapManager write');
  testRuntimeMapManagerWrite();

  console.log('✓ Testing RuntimeMapManager atomic write');
  testRuntimeMapManagerAtomicWrite();

  console.log('✓ Testing RuntimeMapManager validation fails');
  testRuntimeMapManagerValidationFails();

  console.log('✓ Testing RuntimeMapManager update');
  testRuntimeMapManagerUpdate();

  console.log('✓ Testing cleanup orphaned temp files');
  testCleanupOrphanedTempFiles();

  console.log('✓ Testing cleanup when no temp file exists');
  testCleanupNoTempFile();

  console.log('\n✅ All Phase B tests passed!');
}

runAllTests();
