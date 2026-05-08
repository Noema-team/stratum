import { z } from 'zod';
import {
  SystemStatusEnum,
  ProjectTypeEnum,
  ChatStateSchema,
  CycleStateSchema,
  ArtifactEntrySchema,
  ValidationCategorySchema,
  ValidationGateSchema,
  DiscoveryStatusEnum,
  DiscoveryModeEnum,
} from './types.js';

// ============================================================================
// RuntimeMap Schema Definition
// ============================================================================

export interface RuntimeMap {
  meta: {
    status: 'idle' | 'discovering' | 'cycling' | 'halted' | 'complete';
    cycle: number;
    version_id: string;
    initialized_at: string;
    updated_at: string;
  };
  project: {
    name: string;
    description: string;
    description_long?: string;
    type: 'api' | 'ui' | 'library' | 'research' | 'custom';
  };
  remotes: {
    code: { type: 'git'; url: string; branch: string };
    issues: { type: 'git' | 'dolt'; url: string; branch?: string; local_dir?: string; bd_prefix?: string };
    docs: { url: string; pending: boolean };
  };
  task_store: {
    type: 'beads' | 'local';
    path?: string;
  };
  agents: Record<string, { active: boolean; node: string | null; llm: Record<string, unknown> }>;
  discovery: {
    status: 'not_started' | 'in_progress' | 'complete';
    mode: 'full' | 'solo';
    completed_at?: string;
    artifacts: string[];
    current_round: number;
    total_rounds: number;
    current_phase: number;
    total_phases: number;
    open_questions_count: number;
    blocking_questions_count: number;
  };
  cycle: {
    number: number;
    iteration: number;
    revision: number;
    max_iterations: number;
    planning_depth: 'minimal' | 'standard' | 'deep' | 'research';
    started_at?: string;
    completed_at?: string;
    outcome: 'cycling' | 'completed' | 'halted';
    approval_gate: string | null;
    awaiting_scoping: boolean;
    awaiting_confirmation: boolean;
    awaiting_sharding_approval: boolean;
    last_summary?: { path: string; generated_at: string };
  };
  chat: {
    session_open: boolean;
    session_id?: string;
    started_at?: string;
  };
  artifacts: Array<{
    path: string;
    generator: string;
    required: boolean;
    append_only?: boolean;
    scope?: string;
    source_weight?: string;
    version_produced?: string;
    last_updated: string;
    dirty: boolean;
  }>;
  validation: {
    categories: Array<{
      name: string;
      method: string;
      status: string;
      last_run?: string;
      executable?: string;
      prompt_template?: string;
    }>;
    gate: {
      mode: 'all_must_pass';
      last_outcome: 'passed' | 'failed' | 'halted';
      failed_categories: string[];
    };
  };
}

export const RuntimeMapSchema = z.object({
  meta: z.object({
    status: SystemStatusEnum,
    cycle: z.number().nonnegative(),
    version_id: z.string().uuid(),
    initialized_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  }),
  project: z.object({
    name: z.string().min(1),
    description: z.string().min(1),
    description_long: z.string().optional(),
    type: ProjectTypeEnum,
  }),
  remotes: z.object({
    code: z.object({
      type: z.literal('git'),
      url: z.string().url(),
      branch: z.string().min(1),
    }),
    issues: z.union([
      z.object({
        type: z.literal('git'),
        url: z.string().url(),
        branch: z.string(),
      }),
      z.object({
        type: z.literal('dolt'),
        url: z.string(),
        local_dir: z.string(),
        bd_prefix: z.string(),
      }),
    ]),
    docs: z.object({
      url: z.string().url(),
      pending: z.boolean(),
    }),
  }),
  task_store: z.object({
    type: z.enum(['beads', 'local']),
    path: z.string().optional(),
  }),
  agents: z.record(
    z.string(),
    z.object({
      active: z.boolean(),
      node: z.string().nullable(),
      llm: z.record(z.string(), z.unknown()),
    })
  ),
  discovery: z.object({
    status: DiscoveryStatusEnum,
    mode: DiscoveryModeEnum,
    completed_at: z.string().datetime().optional(),
    artifacts: z.array(z.string()),
    current_round: z.number().nonnegative(),
    total_rounds: z.number().nonnegative(),
    current_phase: z.number().nonnegative(),
    total_phases: z.number().nonnegative(),
    open_questions_count: z.number().nonnegative(),
    blocking_questions_count: z.number().nonnegative(),
  }),
  cycle: CycleStateSchema,
  chat: ChatStateSchema,
  artifacts: z.array(ArtifactEntrySchema),
  validation: z.object({
    categories: z.array(ValidationCategorySchema),
    gate: ValidationGateSchema,
  }),
});

// ============================================================================
// Atomic File I/O with Mutex
// ============================================================================

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 100;

/**
 * Simple mutex for serializing concurrent writes
 */
class FileMutex {
  private locked = false;
  private queue: Array<() => void> = [];

  async acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      if (!this.locked) {
        this.locked = true;
        resolve(() => this.release());
      } else {
        this.queue.push(() => {
          this.locked = true;
          resolve(() => this.release());
        });
      }
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }
}

const fileMutex = new FileMutex();

// ============================================================================
// RuntimeMapManager
// ============================================================================

export interface RuntimeMapManager {
  read(): Promise<RuntimeMap>;
  write(map: RuntimeMap): Promise<void>;
  update(fn: (map: RuntimeMap) => RuntimeMap): Promise<void>;
  getVersion(): string;
}

export interface RuntimeMapManagerOptions {
  mapPath: string;
  fsModule?: typeof import('fs').promises;
  pathModule?: typeof import('path');
}

/**
 * Manages atomic read/write of RuntimeMap with Zod validation
 */
export class RuntimeMapManagerImpl implements RuntimeMapManager {
  private mapPath: string;
  private fs: typeof import('fs').promises;
  private lastVersion = '';

  constructor(options: RuntimeMapManagerOptions) {
    this.mapPath = options.mapPath;
    // Dynamic import for testing compatibility
    this.fs = options.fsModule || require('fs').promises;
  }

  async read(): Promise<RuntimeMap> {
    try {
      const content = await this.readFile(this.mapPath);
      const yaml = await this.parseYaml(content);
      return RuntimeMapSchema.parse(yaml);
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to read RuntimeMap: ${error.message}`);
      }
      throw error;
    }
  }

  async write(map: RuntimeMap): Promise<void> {
    const release = await fileMutex.acquire();
    try {
      // Validate before writing
      RuntimeMapSchema.parse(map);

      // Update timestamps
      map.meta.updated_at = new Date().toISOString();

      // Write atomically: write to temp, then rename
      const tempPath = `${this.mapPath}.tmp`;
      const yaml = await this.stringifyYaml(map);

      await this.writeFile(tempPath, yaml);
      await this.renameFile(tempPath, this.mapPath);
    } finally {
      release();
    }
  }

  async update(fn: (map: RuntimeMap) => RuntimeMap): Promise<void> {
    const current = await this.read();
    const updated = fn(current);
    await this.write(updated);
  }

  getVersion(): string {
    return this.lastVersion;
  }

  // Internal helper methods (can be overridden for testing)
  private async readFile(filePath: string): Promise<string> {
    let lastError: Error | null = null;
    for (let i = 0; i < MAX_RETRIES; i++) {
      try {
        return await this.fs.readFile(filePath, 'utf-8');
      } catch (error) {
        if (error instanceof Error) {
          lastError = error;
          if (i < MAX_RETRIES - 1) {
            await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * (i + 1)));
          }
        }
      }
    }
    throw lastError || new Error(`Failed to read file after ${MAX_RETRIES} retries`);
  }

  private async writeFile(filePath: string, content: string): Promise<void> {
    await this.fs.writeFile(filePath, content, 'utf-8');
  }

  private async renameFile(oldPath: string, newPath: string): Promise<void> {
    await this.fs.rename(oldPath, newPath);
  }

  private async parseYaml(content: string): Promise<unknown> {
    // Dynamic require for YAML parsing - allows for different parsers
    const yaml = await import('js-yaml').then((m) => m.default);
    return yaml.load(content);
  }

  private async stringifyYaml(obj: unknown): Promise<string> {
    const yaml = await import('js-yaml').then((m) => m.default);
    return yaml.dump(obj, { indent: 2, lineWidth: -1 }) || '';
  }
}

// ============================================================================
// Initial RuntimeMap Factory
// ============================================================================

export interface InitialMapOptions {
  projectName: string;
  projectType: 'api' | 'ui' | 'library' | 'research' | 'custom';
  codeRemote: { url: string; branch: string };
  issuesRemote: { type: 'git' | 'dolt'; url: string; branch?: string; local_dir?: string; bd_prefix?: string };
  docsRemote: { url: string; pending: boolean };
  taskStore: { type: 'beads' | 'local'; path?: string };
  agents: Record<string, { active: boolean; node: string | null; llm: Record<string, unknown> }>;
}

export function createInitialMap(options: InitialMapOptions): RuntimeMap {
  const now = new Date().toISOString();
  const versionId = generateUUID();

  return {
    meta: {
      status: 'idle',
      cycle: 0,
      version_id: versionId,
      initialized_at: now,
      updated_at: now,
    },
    project: {
      name: options.projectName,
      description: '',
      type: options.projectType,
    },
    remotes: {
      code: {
        type: 'git',
        url: options.codeRemote.url,
        branch: options.codeRemote.branch,
      },
      issues: {
        type: options.issuesRemote.type,
        url: options.issuesRemote.url,
        ...(options.issuesRemote.type === 'git' && { branch: options.issuesRemote.branch }),
        ...(options.issuesRemote.type === 'dolt' && {
          local_dir: options.issuesRemote.local_dir,
          bd_prefix: options.issuesRemote.bd_prefix,
        }),
      } as any,
      docs: {
        url: options.docsRemote.url,
        pending: options.docsRemote.pending,
      },
    },
    task_store: options.taskStore,
    agents: options.agents,
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
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Generate a UUID v4 - simple implementation
 */
function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Clean up orphaned temp files on startup
 */
export async function cleanupOrphanedTempFiles(
  mapPath: string,
  fs: typeof import('fs').promises
): Promise<void> {
  const tempPath = `${mapPath}.tmp`;
  try {
    await fs.unlink(tempPath);
  } catch {
    // File doesn't exist, which is fine
  }
}
