import { randomUUID } from 'crypto';
import { execSync } from 'child_process';
import { promises as fs } from 'fs';
import { z } from 'zod';
import { join as pathJoin } from 'path';
import {
  type InitState,
  InitStateSchema,
  ProjectTypeEnum,
  type APIResponse,
  type APIError,
  type ProjectType,
} from './types.js';
import { FACILITATOR_TEMPLATES } from './prompt-templates.js';

export const InitRequestSchema = z.object({
  project_name: z.string().min(1),
  project_type: ProjectTypeEnum,
  task_store: z.enum(['beads', 'local']),
  daemon_port: z.number().int().positive(),
  docs_remote: z.string().url().nullable(),
  description_long: z.string().optional(),
  no_editor: z.boolean().optional(),
  non_interactive: z.boolean(),
});

export type InitRequest = z.infer<typeof InitRequestSchema>;

export const InitResponseDataSchema = z.object({
  status: z.enum(['complete', 'partial']),
  step: z.number().int().nonnegative(),
  message: z.string(),
  files_created: z.array(z.string()),
});

export type InitResponseData = z.infer<typeof InitResponseDataSchema>;

export const InitStatusResponseDataSchema = z.object({
  initialised: z.boolean(),
  current_step: z.number().nullable(),
  total_steps: z.literal(10),
  last_file_created: z.string().nullable(),
});

export type InitStatusResponseData = z.infer<typeof InitStatusResponseDataSchema>;

export const InitResetRequestSchema = z.object({
  confirm_name: z.string().min(1),
});

export type InitResetRequest = z.infer<typeof InitResetRequestSchema>;

export const InitResetResponseDataSchema = z.object({
  removed: z.array(z.string()),
});

export type InitResetResponseData = z.infer<typeof InitResetResponseDataSchema>;

export interface InitServiceOptions {
  projectRoot: string;
}

const TOTAL_INIT_STEPS = 10;

export class InitService {
  private projectRoot: string;
  private initStatePath: string;

  constructor(options: InitServiceOptions) {
    this.projectRoot = options.projectRoot;
    this.initStatePath = pathJoin(this.projectRoot, '.sle', 'init-state.json');
  }

  async init(request: InitRequest): Promise<APIResponse<InitResponseData> | APIError> {
    InitRequestSchema.parse(request);

    const sleDir = pathJoin(this.projectRoot, '.sle');

    try {
      await fs.mkdir(sleDir, { recursive: true });
    } catch (err) {
      return this.makeError('filesystem_error', `Failed to create .sle directory: ${err}`);
    }

    const existingState = await this.loadInitState();
    if (existingState) {
      return this.makeError('already_initialised', '.sle/ directory already exists.');
    }

    const initState: InitState = {
      last_completed_step: -1,
      project: {
        name: request.project_name,
        description: '',
        type: request.project_type,
      },
      remotes: {
        code: { url: '', branch: '' },
        issues: { url: '', prefix: '', local_only: request.task_store === 'local' },
        docs: { url: request.docs_remote || '', pending: !request.docs_remote },
      },
      task_store: {
        provider: request.task_store,
      },
      beads_initialised: false,
      docs_cloned: false,
      committed: false,
    };

    await this.saveInitState(initState);

    let step = 0;
    const filesCreated: string[] = [];

    for (step = 0; step <= TOTAL_INIT_STEPS; step++) {
      try {
        const result = await this.runStep(step, initState, request);
        if (result.files) {
          filesCreated.push(...result.files);
        }
        initState.last_completed_step = step;
        await this.saveInitState(initState);
      } catch (err) {
        const error = err as Error;
        return {
          ok: true,
          data: {
            status: 'partial',
            step,
            message: `Init failed at step ${step}: ${error.message}`,
            files_created: filesCreated,
          },
          meta: {
            request_id: randomUUID(),
            timestamp: new Date().toISOString(),
          },
        };
      }
    }

    await this.deleteInitState();

    return {
      ok: true,
      data: {
        status: 'complete',
        step: TOTAL_INIT_STEPS,
        message: 'Init completed successfully',
        files_created: filesCreated,
      },
      meta: {
        request_id: randomUUID(),
        timestamp: new Date().toISOString(),
      },
    };
  }

  async resume(): Promise<APIResponse<InitResponseData> | APIError> {
    const initState = await this.loadInitState();

    if (!initState) {
      return this.makeError('no_init_state', 'No init-state.json found. Run init first.');
    }

    const request: InitRequest = {
      project_name: initState.project.name,
      project_type: initState.project.type,
      task_store: initState.task_store.provider,
      daemon_port: 7700,
      docs_remote: initState.remotes.docs.pending ? null : initState.remotes.docs.url,
      non_interactive: true,
    };

    let step = initState.last_completed_step + 1;
    const filesCreated: string[] = [];

    for (; step <= TOTAL_INIT_STEPS; step++) {
      const result = await this.runStep(step, initState, request);
      if (result.files) {
        filesCreated.push(...result.files);
      }
      initState.last_completed_step = step;
      await this.saveInitState(initState);
    }

    await this.deleteInitState();

    return {
      ok: true,
      data: {
        status: 'complete',
        step: TOTAL_INIT_STEPS,
        message: 'Init resumed and completed successfully',
        files_created: filesCreated,
      },
      meta: {
        request_id: randomUUID(),
        timestamp: new Date().toISOString(),
      },
    };
  }

  async getStatus(): Promise<APIResponse<InitStatusResponseData>> {
    const initState = await this.loadInitState();

    if (!initState) {
      return {
        ok: true,
        data: {
          initialised: false,
          current_step: null,
          total_steps: TOTAL_INIT_STEPS,
          last_file_created: null,
        },
        meta: {
          request_id: randomUUID(),
          timestamp: new Date().toISOString(),
        },
      };
    }

    return {
      ok: true,
      data: {
        initialised: true,
        current_step: initState.last_completed_step,
        total_steps: TOTAL_INIT_STEPS,
        last_file_created: null,
      },
      meta: {
        request_id: randomUUID(),
        timestamp: new Date().toISOString(),
      },
    };
  }

  async reset(request: InitResetRequest): Promise<APIResponse<InitResetResponseData> | APIError> {
    InitResetRequestSchema.parse(request);

    const initState = await this.loadInitState();

    if (!initState) {
      return this.makeError('no_init_state', 'No init state found. Nothing to reset.');
    }

    if (request.confirm_name !== initState.project.name) {
      return this.makeError('name_mismatch', 'confirm_name does not match project name.');
    }

    const removed: string[] = [];
    const sleDir = pathJoin(this.projectRoot, '.sle');
    const beadsDir = pathJoin(this.projectRoot, '.beads');
    const serverDir = pathJoin(this.projectRoot, '.server');
    const agentMdPath = pathJoin(this.projectRoot, 'agent.md');
    const docsSymlink = pathJoin(this.projectRoot, 'docs');

    const directoriesToRemove = [sleDir, beadsDir, serverDir];

    for (const dir of directoriesToRemove) {
      try {
        await fs.access(dir);
        await fs.rm(dir, { recursive: true, force: true });
        removed.push(dir);
      } catch {
      }
    }

    const filesToRemove = [agentMdPath];

    for (const file of filesToRemove) {
      try {
        await fs.access(file);
        await fs.unlink(file);
        removed.push(file);
      } catch {
      }
    }

    try {
      const stats = await fs.lstat(docsSymlink);
      if (stats.isSymbolicLink()) {
        await fs.unlink(docsSymlink);
        removed.push(docsSymlink);
      }
    } catch {
    }

    return {
      ok: true,
      data: {
        removed,
      },
      meta: {
        request_id: randomUUID(),
        timestamp: new Date().toISOString(),
      },
    };
  }

  private async loadInitState(): Promise<InitState | null> {
    try {
      const data = await fs.readFile(this.initStatePath, 'utf-8');
      const parsed = JSON.parse(data);
      const state = InitStateSchema.parse(parsed) as InitState;
      return state;
    } catch {
      return null;
    }
  }

  private async saveInitState(state: InitState): Promise<void> {
    const sleDir = pathJoin(this.projectRoot, '.sle');
    await fs.mkdir(sleDir, { recursive: true });
    await fs.writeFile(this.initStatePath, JSON.stringify(state, null, 2));
  }

  private async deleteInitState(): Promise<void> {
    try {
      await fs.unlink(this.initStatePath);
    } catch {
    }
  }

  private async runStep(
    step: number,
    state: InitState,
    request: InitRequest
  ): Promise<{ files: string[] }> {
    switch (step) {
      case 0:
        return await this.step0Prereqs();
      case 1:
        return await this.step1ProjectIdentity(state, request);
      case 2:
        return await this.step2ProjectType(state, request);
      case 3:
        return await this.step3Remotes(state, request);
      case 4:
        return await this.step4RuleFiles();
      case 5:
        return await this.step5TaskStore(state);
      case 6:
        return await this.step6DocsClone(state);
      case 7:
        return await this.step7AgentMdAndMap(state, request);
      case 8:
        return await this.step8PromptTemplates();
      case 9:
        return await this.step9Commit();
      case 10:
        return await this.step10Daemon();
      default:
        throw new Error(`Invalid step: ${step}`);
    }
  }

  private async step0Prereqs(): Promise<{ files: string[] }> {
    return { files: [] };
  }

  private async step1ProjectIdentity(state: InitState, request: InitRequest): Promise<{ files: string[] }> {
    state.project.name = request.project_name;
    state.project.description = '';
    state.project.description_long = request.description_long ?? '';
    return { files: [] };
  }

  private async step2ProjectType(state: InitState, request: InitRequest): Promise<{ files: string[] }> {
    state.project.type = request.project_type;
    return { files: [] };
  }

  private async step3Remotes(state: InitState, request: InitRequest): Promise<{ files: string[] }> {
    state.remotes.docs.url = request.docs_remote || '';
    state.remotes.docs.pending = !request.docs_remote;
    return { files: [] };
  }

  private async step4RuleFiles(): Promise<{ files: string[] }> {
    const rulesDir = pathJoin(this.projectRoot, '.sle', 'rules');
    await fs.mkdir(rulesDir, { recursive: true });

    const ruleFiles = [
      'planning.yaml',
      'validation.yaml',
      'artifacts.yaml',
      'exit.yaml',
      'user_validation.yaml',
      'summary.yaml',
      'agents.yaml',
    ];

    for (const file of ruleFiles) {
      const filePath = pathJoin(rulesDir, file);
      await fs.writeFile(filePath, '', 'utf-8');
    }

    return { files: ruleFiles.map(f => pathJoin('.sle', 'rules', f)) };
  }

  private async step5TaskStore(state: InitState): Promise<{ files: string[] }> {
    if (state.task_store.provider === 'local') {
      const tasksPath = pathJoin(this.projectRoot, '.sle', 'tasks.yaml');
      await fs.writeFile(tasksPath, 'tasks: []\n', 'utf-8');
      state.beads_initialised = false;
      return { files: [tasksPath] };
    }

    state.beads_initialised = true;
    return { files: [] };
  }

  private async step6DocsClone(state: InitState): Promise<{ files: string[] }> {
    if (!state.remotes.docs.url || state.remotes.docs.pending) {
      state.docs_cloned = false;
      return { files: [] };
    }

    state.docs_cloned = true;
    return { files: [] };
  }

  private async step7AgentMdAndMap(state: InitState, request: InitRequest): Promise<{ files: string[] }> {
    const projectName = state.project.name ?? 'untitled';
    const projectType = state.project.type ?? 'custom';
    const description = state.project.description ?? '';
    const descriptionLong = state.project.description_long ?? '';

    const agentMdContent = this.generateAgentMd(projectName, description, descriptionLong, projectType);
    const agentMdPath = pathJoin(this.projectRoot, 'agent.md');
    await fs.writeFile(agentMdPath, agentMdContent, 'utf-8');

    const mapPath = pathJoin(this.projectRoot, '.sle', 'map.yaml');
    await fs.writeFile(mapPath, '', 'utf-8');

    if (!request.no_editor && process.env.EDITOR) {
      try {
        execSync(`${process.env.EDITOR} "${agentMdPath}"`, {
          stdio: 'ignore',
          timeout: 30000,
        });
      } catch {
      }
    }

    return { files: [agentMdPath, mapPath] };
  }

  private generateAgentMd(name: string, description: string, descriptionLong: string, type: ProjectType): string {
    const conventions = this.getProjectTypeDefaults(type);
    const parts = [
      `# ${name}`,
      '',
    ];

    if (description) {
      parts.push(description);
      parts.push('');
    }

    if (descriptionLong) {
      parts.push(descriptionLong);
      parts.push('');
    }

    parts.push('## Conventions');
    parts.push(conventions);
    parts.push('');
    parts.push('## Map');
    parts.push('map: .sle/map.yaml');
    parts.push('');

    return parts.join('\n');
  }

  private getProjectTypeDefaults(type: ProjectType): string {
    const defaults: Record<ProjectType, string> = {
      api: '- TypeScript, Node.js ESM\n- JSON REST API conventions\n- Zod for runtime validation\n- Tests use Node.js built-in test runner',
      ui: '- TypeScript, React or similar framework\n- Component-based architecture\n- CSS-in-JS or utility classes\n- Tests use component testing patterns',
      library: '- TypeScript, Node.js ESM\n- Public API surface documented in types\n- Zod for input validation\n- Comprehensive unit test coverage',
      research: '- Markdown-first documentation\n- Experimental code in isolated modules\n- Clear documentation of findings\n- Reproducible experiments',
      custom: '- Follow existing project conventions\n- Maintain consistency with current codebase\n- Document any new patterns introduced',
    };
    return defaults[type];
  }

  private async step8PromptTemplates(): Promise<{ files: string[] }> {
    const promptsDir = pathJoin(this.projectRoot, '.sle', 'prompts');
    await fs.mkdir(promptsDir, { recursive: true });

    const files: string[] = [];

    for (const [filename, content] of Object.entries(FACILITATOR_TEMPLATES)) {
      const filePath = pathJoin(promptsDir, filename);
      await fs.writeFile(filePath, content, 'utf-8');
      files.push(pathJoin('.sle', 'prompts', filename));
    }

    return { files };
  }

  private async step9Commit(): Promise<{ files: string[] }> {
    return { files: [] };
  }

  private async step10Daemon(): Promise<{ files: string[] }> {
    return { files: [] };
  }

  private makeError(code: string, message: string, details?: unknown): APIError {
    return {
      ok: false,
      error: {
        code,
        message,
        details,
      },
      meta: {
        request_id: randomUUID(),
        timestamp: new Date().toISOString(),
      },
    };
  }
}
