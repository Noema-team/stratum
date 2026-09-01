import { promises as fs } from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import type { SLETask, ShardingProposal, CoherenceFinding } from './types.js';
import type { LinkIndexManager } from './link-index.js';
import { slugify } from './intake-service.js';

export interface TaskStore {
  createTask(task: Omit<SLETask, 'id' | 'created_at' | 'updated_at'>): Promise<SLETask>;
  getReadyTasks(): Promise<SLETask[]>;
  updateStatus(id: string, status: SLETask['status']): Promise<void>;
  closeTask(id: string): Promise<void>;
  getStale(): Promise<SLETask[]>;
  addDependency(taskId: string, dependencyTaskId: string): Promise<void>;
}

export class LocalTaskStore implements TaskStore {
  private tasksFile: string;

  constructor(private projectRoot: string) {
    this.tasksFile = path.join(this.projectRoot, '.sle', 'tasks.yaml');
  }

  private async loadTasks(): Promise<SLETask[]> {
    try {
      const content = await fs.readFile(this.tasksFile, 'utf8');
      const data = yaml.load(content) as { tasks?: SLETask[] };
      return data?.tasks || [];
    } catch {
      return [];
    }
  }

  private async saveTasks(tasks: SLETask[]): Promise<void> {
    await fs.mkdir(path.dirname(this.tasksFile), { recursive: true });
    const content = yaml.dump({ tasks });
    await fs.writeFile(this.tasksFile, content, 'utf8');
  }

  async createTask(task: Omit<SLETask, 'id' | 'created_at' | 'updated_at'>): Promise<SLETask> {
    const tasks = await this.loadTasks();
    const now = new Date().toISOString();
    const id = `task-${slugify(task.title)}`;

    // Idempotent upsert: if a task with this ID already exists, return it unchanged.
    const existing = tasks.find(t => t.id === id);
    if (existing) return existing;

    const newTask: SLETask = {
      ...task,
      id,
      created_at: now,
      updated_at: now,
    };

    tasks.push(newTask);
    await this.saveTasks(tasks);
    return newTask;
  }

  async getReadyTasks(): Promise<SLETask[]> {
    const tasks = await this.loadTasks();
    const closedTaskIds = new Set(
      tasks.filter(t => t.status === 'closed').map(t => t.id)
    );

    return tasks.filter(task => {
      if (task.status === 'closed') return false;
      // All dependencies must be closed to be ready
      return task.dependencies.every(depId => closedTaskIds.has(depId));
    });
  }

  async updateStatus(id: string, status: SLETask['status']): Promise<void> {
    const tasks = await this.loadTasks();
    const task = tasks.find(t => t.id === id);
    if (!task) {
      throw new Error(`Task with ID ${id} not found.`);
    }
    task.status = status;
    task.updated_at = new Date().toISOString();
    await this.saveTasks(tasks);
  }

  async closeTask(id: string): Promise<void> {
    await this.updateStatus(id, 'closed');
  }

  async getStale(): Promise<SLETask[]> {
    const tasks = await this.loadTasks();
    return tasks.filter(t => t.stale === true);
  }

  async addDependency(taskId: string, dependencyTaskId: string): Promise<void> {
    const tasks = await this.loadTasks();
    const task = tasks.find(t => t.id === taskId);
    if (!task) {
      throw new Error(`Task with ID ${taskId} not found.`);
    }
    if (!task.dependencies.includes(dependencyTaskId)) {
      task.dependencies.push(dependencyTaskId);
      task.updated_at = new Date().toISOString();
      await this.saveTasks(tasks);
    }
  }

  async getTasksReferencing(documentId: string, sectionId?: string): Promise<SLETask[]> {
    const tasks = await this.loadTasks();
    return tasks.filter(task => {
      if (!task.context_declarations) return false;
      return task.context_declarations.some(decl => {
        return decl.slices.some(slice => {
          const [docRef, anchor] = slice.split('#');
          const refDocId = docRef.replace(/^doc:/, '');
          if (refDocId !== documentId) return false;
          if (sectionId) {
            return anchor === sectionId;
          }
          return true;
        });
      });
    });
  }

  async flagStale(id: string, isStale: boolean): Promise<void> {
    const tasks = await this.loadTasks();
    const task = tasks.find(t => t.id === id);
    if (!task) return;
    task.stale = isStale;
    task.updated_at = new Date().toISOString();
    await this.saveTasks(tasks);
  }
}

export class ShardingService {
  private localTaskStore: LocalTaskStore;

  constructor(
    projectRoot: string,
    private linkIndex: LinkIndexManager,
    taskStore?: LocalTaskStore
  ) {
    this.localTaskStore = taskStore ?? new LocalTaskStore(projectRoot);
  }

  getTaskStore(): LocalTaskStore {
    return this.localTaskStore;
  }

  async checkLayer2Coherence(tasks: SLETask[]): Promise<CoherenceFinding[]> {
    const findings: CoherenceFinding[] = [];

    // 1. Boundary & Verifiability checks
    for (const task of tasks) {
      if (!task.title.trim()) {
        findings.push({
          type: 'missing_document',
          severity: 'blocking',
          document_a: `task:unknown`,
          description: `Task has an empty title.`,
        });
      }
      if (!task.description.trim()) {
        findings.push({
          type: 'missing_document',
          severity: 'blocking',
          document_a: `task:${task.id || 'unknown'}`,
          description: `Task '${task.title}' has an empty description.`,
        });
      }
    }

    // 2. Independence check: cycle detection
    const adj = new Map<string, string[]>();
    for (const t of tasks) {
      adj.set(t.id, t.dependencies);
    }

    const visited = new Set<string>();
    const recStack = new Set<string>();

    const hasCycle = (u: string): boolean => {
      if (recStack.has(u)) return true;
      if (visited.has(u)) return false;

      visited.add(u);
      recStack.add(u);

      const neighbors = adj.get(u) || [];
      for (const v of neighbors) {
        if (hasCycle(v)) return true;
      }

      recStack.delete(u);
      return false;
    };

    for (const t of tasks) {
      if (hasCycle(t.id)) {
        findings.push({
          type: 'contradiction',
          severity: 'blocking',
          document_a: `task:${t.id}`,
          description: `Cyclic dependency chain detected involving task '${t.title}'.`,
        });
        break;
      }
    }

    // 3. Declared context completeness: verify prefixes starts with doc: or node:
    for (const task of tasks) {
      if (!task.context_declarations) continue;
      for (const decl of task.context_declarations) {
        for (const slice of decl.slices) {
          const [baseRef] = slice.split('#');
          if (!baseRef.startsWith('doc:') && !baseRef.startsWith('node:')) {
            findings.push({
              type: 'undefined_reference',
              severity: 'blocking',
              document_a: `task:${task.id}`,
              description: `Context slice reference '${slice}' in task '${task.title}' must begin with 'doc:' or 'node:' prefix.`,
            });
          }
        }
      }
    }

    // 4. Duplicate scope check: verify target file path is not targeted by two tasks
    const targetScopes = new Map<string, string>(); // scope -> task.id
    for (const task of tasks) {
      if (!task.context_declarations) continue;
      for (const decl of task.context_declarations) {
        // Derive target files by searching intent or checking slice targets
        const targetMatch = decl.intent.match(/(modify|create|implement|write to)\s+([a-zA-Z0-9_\-\./]+)/i);
        if (targetMatch) {
          const target = targetMatch[2].trim();
          const existingTaskId = targetScopes.get(target);
          if (existingTaskId && existingTaskId !== task.id) {
            findings.push({
              type: 'terminology_conflict',
              severity: 'warning',
              document_a: `task:${existingTaskId}`,
              document_b: `task:${task.id}`,
              description: `Duplicate scope warning: Both tasks target identical scope '${target}'.`,
            });
          } else {
            targetScopes.set(target, task.id);
          }
        }
      }
    }

    return findings;
  }

  async flagStaleTasks(documentId: string, sectionId?: string): Promise<string[]> {
    const affected = await this.localTaskStore.getTasksReferencing(documentId, sectionId);
    const flaggedIds: string[] = [];

    for (const task of affected) {
      await this.localTaskStore.flagStale(task.id, true);
      flaggedIds.push(task.id);
    }

    return flaggedIds;
  }

  async createTasksFromProposal(proposal: ShardingProposal): Promise<number> {
    let createdCount = 0;
    for (const task of proposal.tasks) {
      const created = await this.localTaskStore.createTask(task);
      createdCount++;

      // Inject Tier 1 structural declaration links in LinkIndex
      if (task.context_declarations) {
        for (const decl of task.context_declarations) {
          for (const slice of decl.slices) {
            const [baseRef] = slice.split('#');
            const targetKey = baseRef.replace(/^(doc:|node:)/, '');
            await this.linkIndex.addLink({
              source: { kind: 'document', key: created.id },
              target: { kind: 'document', key: targetKey },
              link_type: 'structural_declaration',
              context: `Structural context link from sharded task ${created.id}`,
            });
          }
        }
      }
    }

    return createdCount;
  }
}
