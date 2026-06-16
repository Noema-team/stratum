#!/usr/bin/env node

import { DaemonServer } from './daemon.js';
import { InitService, type InitRequest } from './init-service.js';
import { DiscoveryService } from './discovery-service.js';
import { CycleService } from './cycle-service.js';
import { ScopingService } from './scoping-service.js';
import { ConfirmService } from './confirm-service.js';
import { AgentRunner } from './agent-runner.js';
import { ContextManager } from './context-manager.js';
import { IntakeService } from './intake-service.js';
import { ShardingService } from './sharding-service.js';
import { LinkIndexManager } from './link-index.js';
import { createLLMProvider, DynamicLLMProvider, type ILLMProvider } from './llm-provider.js';
import { RunArtifactManager } from './run-artifacts.js';
import fs from 'node:fs';
import { readPidFile, removePidFile, isPidAlive, writePidFile } from './pid-file.js';
import { parseCLIArgs, type DaemonCommand, type InitCommand, type StartCommand } from './daemon-config.js';
import { RuntimeMapManagerImpl } from './runtime-map.js';
import { StateAPI } from './state-api.js';
import { StateMachine } from './state-machine.js';
import { ProjectTypeEnum } from './types.js';
import { exec } from 'node:child_process';

const projectRoot = process.cwd();

function openBrowser(url: string): void {
  const platform = process.platform;
  let cmd = '';

  switch (platform) {
    case 'darwin':
      cmd = `open "${url}"`;
      break;
    case 'win32':
      cmd = `start "" "${url}"`;
      break;
    default:
      cmd = `xdg-open "${url}"`;
      break;
  }

  exec(cmd, (error) => {
    if (error) {
      console.warn(`\n[Warning] Could not open browser automatically: ${error.message}`);
      console.log(`Please open the UI manually at: ${url}\n`);
    }
  });
}

function showHelp(): void {
  console.log(`
Usage: stratum <command> [options]

Commands:
  init              Initialize a new SLE project
  start             Start the daemon server (Default when running 'stratum' with no arguments)
  stop              Stop the daemon server
  status            Show daemon status
  discover          Start a discovery session

Init options:
  --name <name>             Project name
  --type <type>             Project type (api|ui|library|research|custom)
  --task-store <type>       Task store type (beads|local)
  --no-daemon               Don't start daemon after init
  --resume                  Resume a failed init
  --reset                   Reset project state

Start options:
  --port <port>             Daemon port (default: 7700)
  --foreground              Run in foreground
  --no-open                 Don't open the browser automatically

Global options:
  -h, --help                Show this help message
`);
}

async function handleInit(cmd: InitCommand): Promise<void> {
  const initService = new InitService({ projectRoot });

  if (cmd.reset) {
    if (!cmd.name) {
      console.error('Error: --name is required for reset');
      process.exit(1);
    }
    const result = await initService.reset({ confirm_name: cmd.name! });
    if (result.ok === true) {
      console.log('Reset completed. Removed:');
      result.data.removed.forEach((path) => console.log(`  ${path}`));
    } else {
      console.error(`Error: ${result.error.message}`);
      process.exit(1);
    }
    return;
  }

  if (cmd.resume) {
    const result = await initService.resume();
    if (result.ok === true) {
      console.log('Init resumed and completed successfully');
      console.log(`Files created: ${result.data.files_created.join(', ')}`);
    } else {
      console.error(`Error: ${result.error.message}`);
      process.exit(1);
    }
    return;
  }

  if (!cmd.name) {
    console.error('Error: --name is required for init');
    process.exit(1);
  }

  const projectType = cmd.type ? ProjectTypeEnum.parse(cmd.type) : 'api';

  const request: InitRequest = {
    project_name: cmd.name!,
    project_type: projectType,
    task_store: cmd.taskStore === 'local' ? 'local' : 'beads',
    daemon_port: 7700,
    docs_remote: null,
    non_interactive: true,
  };

  const result = await initService.init(request);
  if (result.ok === true) {
    console.log(`Init ${result.data.status}`);
    console.log(`Step: ${result.data.step}/${result.data.status === 'complete' ? result.data.step : 10}`);
    console.log(`Message: ${result.data.message}`);
    if (result.data.files_created.length > 0) {
      console.log(`Files created: ${result.data.files_created.join(', ')}`);
    }
  } else {
    console.error(`Error: ${result.error.message}`);
    process.exit(1);
  }
}

async function handleStart(cmd: StartCommand): Promise<void> {
  const port = cmd.port ?? 7700;
  const mapPath = `${projectRoot}/.sle/map.yaml`;

  const mapManager = new RuntimeMapManagerImpl({ mapPath });
  const stateMachine = new StateMachine(mapManager);
  const stateAPI = new StateAPI(mapManager, {
    version: '2.0.0',
    sleVersion: '2.0.0',
    port,
    projectRoot,
    startedAt: new Date(),
  });

  const initService = new InitService({ projectRoot });
  const discoveryService = new DiscoveryService(stateAPI, mapManager, projectRoot);
  const runArtifacts = new RunArtifactManager({ projectRoot });
  const cycleService = new CycleService(stateMachine, mapManager, runArtifacts);

  const contextManager = new ContextManager(projectRoot);
  const settingsPath = `${projectRoot}/.sle/settings.json`;
  let initialLLMConfig: any = {
    provider: 'openai_compatible',
    base_url: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    api_key_env: 'OPENAI_API_KEY',
  };

  if (fs.existsSync(settingsPath)) {
    try {
      const savedSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (savedSettings.provider) {
        initialLLMConfig = {
          provider: savedSettings.provider,
          base_url: savedSettings.base_url,
          model: savedSettings.model,
          api_key_env: savedSettings.api_key_env || (
            savedSettings.provider === 'openai_compatible' ? 'OPENAI_API_KEY' :
            savedSettings.provider === 'anthropic' ? 'ANTHROPIC_API_KEY' :
            savedSettings.provider === 'glm' ? 'GLM_API_KEY' :
            savedSettings.provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'OPENAI_API_KEY'
          )
        };
        if (savedSettings.api_key) {
          process.env.SLE_LLM_API_KEY = savedSettings.api_key;
        }
      }
    } catch (err) {
      console.warn('Failed to parse .sle/settings.json, falling back to default:', err);
    }
  }

  let llmProvider: ILLMProvider;
  try {
    const rawProvider = createLLMProvider(initialLLMConfig);
    llmProvider = new DynamicLLMProvider(rawProvider);
  } catch (err) {
    const fallbackProvider = { complete: () => Promise.reject(new Error('LLM not configured — set OPENAI_API_KEY or SLE_LLM_API_KEY')) };
    llmProvider = new DynamicLLMProvider(fallbackProvider);
  }
  const agentRunner = new AgentRunner(contextManager, llmProvider, projectRoot, runArtifacts);
  const scopingService = new ScopingService(agentRunner, mapManager, projectRoot);
  const confirmService = new ConfirmService(mapManager, runArtifacts);
  
  const linkIndex = new LinkIndexManager(projectRoot);
  const intakeService = new IntakeService(projectRoot, mapManager, linkIndex);
  const shardingService = new ShardingService(projectRoot, linkIndex);

  const daemon = new DaemonServer();

  await daemon.start(
    { port },
    {
      stateAPI,
      initService,
      discoveryService,
      cycleService,
      scopingService,
      confirmService,
      intakeService,
      shardingService,
      llmProvider,
      pidFile: { writePidFile, removePidFile },
    }
  );

  console.log(`SLE daemon started on port ${port}`);

  if (cmd.foreground && !cmd.noOpen) {
    openBrowser(`http://localhost:${port}`);
  }
}

async function handleStop(): Promise<void> {
  const pid = await readPidFile(`${projectRoot}/.sle/daemon.pid`);

  if (!pid) {
    console.log('No PID file found. Daemon may not be running.');
    return;
  }

  if (!isPidAlive(pid)) {
    console.log(`Daemon process ${pid} is not running. Cleaning up PID file.`);
    await removePidFile(`${projectRoot}/.sle/daemon.pid`);
    return;
  }

  process.kill(pid, 'SIGTERM');
  await removePidFile(`${projectRoot}/.sle/daemon.pid`);
  console.log(`Daemon stopped (PID: ${pid})`);
}

async function handleStatus(): Promise<void> {
  const pid = await readPidFile(`${projectRoot}/.sle/daemon.pid`);

  if (!pid) {
    console.log('Daemon not running (no PID file)');
    return;
  }

  if (!isPidAlive(pid)) {
    console.log(`Daemon not running (stale PID file: ${pid})`);
    return;
  }

  console.log(`Daemon running (PID: ${pid})`);
}

async function handleDiscover(): Promise<void> {
  const mapPath = `${projectRoot}/.sle/map.yaml`;
  const mapManager = new RuntimeMapManagerImpl({ mapPath });
  const stateAPI = new StateAPI(mapManager, {
    version: '2.0.0',
    sleVersion: '2.0.0',
    port: 7700,
    projectRoot,
    startedAt: new Date(),
  });

  const discoveryService = new DiscoveryService(stateAPI, mapManager, projectRoot);

  const session = await discoveryService.start(projectRoot, { mode: 'full' });
  console.log(`Discovery session started: ${session.session_id}`);
  console.log(`Mode: ${session.mode}`);
  console.log(`Current round: ${session.current_round}/${session.total_rounds}`);
}

async function main(): Promise<void> {
  const args = process.argv;

  if (args.length < 3) {
    // Default to starting in foreground and opening the browser
    await handleStart({ command: 'start', foreground: true });
    return;
  }

  if (args[2] === '-h' || args[2] === '--help') {
    showHelp();
    process.exit(0);
  }

  let command!: DaemonCommand;
  try {
    command = parseCLIArgs(args);
  } catch (err) {
    const error = err as Error;
    console.error(`Error: ${error.message}`);
    showHelp();
    process.exit(1);
  }

  switch (command.command) {
    case 'init':
      await handleInit(command);
      break;
    case 'start':
      await handleStart(command);
      break;
    case 'stop':
      await handleStop();
      break;
    case 'status':
      await handleStatus();
      break;
    case 'discover':
      await handleDiscover();
      break;
  }
}

main().catch((err) => {
  const error = err as Error;
  console.error(`Fatal error: ${error.message}`);
  process.exit(1);
});
