#!/usr/bin/env node

import { DaemonServer } from './daemon.js';
import { InitService, type InitRequest } from './init-service.js';
import { DiscoveryService } from './discovery-service.js';
import { CycleService } from './cycle-service.js';
import { ScopingService } from './scoping-service.js';
import { ConfirmService } from './confirm-service.js';
import { AgentRunner } from './agent-runner.js';
import { ContextManager } from './context-manager.js';
import { createLLMProvider, type ILLMProvider } from './llm-provider.js';
import { RunArtifactManager } from './run-artifacts.js';
import { readPidFile, removePidFile, isPidAlive, writePidFile } from './pid-file.js';
import { parseCLIArgs, type DaemonCommand, type InitCommand, type StartCommand } from './daemon-config.js';
import { RuntimeMapManagerImpl } from './runtime-map.js';
import { StateAPI } from './state-api.js';
import { StateMachine } from './state-machine.js';
import { ProjectTypeEnum } from './types.js';

const projectRoot = process.cwd();

function showHelp(): void {
  console.log(`
Usage: sle <command> [options]

Commands:
  init              Initialize a new SLE project
  start             Start the daemon server
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
  let llmProvider: ILLMProvider;
  try {
    llmProvider = createLLMProvider({
      provider: 'openai_compatible',
      base_url: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      api_key_env: 'OPENAI_API_KEY',
    });
  } catch {
    llmProvider = { complete: () => Promise.reject(new Error('LLM not configured — set OPENAI_API_KEY or SLE_LLM_API_KEY')) };
  }
  const agentRunner = new AgentRunner(contextManager, llmProvider, projectRoot, runArtifacts);
  const scopingService = new ScopingService(agentRunner, mapManager, projectRoot);
  const confirmService = new ConfirmService(mapManager, runArtifacts);

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
      pidFile: { writePidFile, removePidFile },
    }
  );

  console.log(`SLE daemon started on port ${port}`);
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

  if (args.length < 3 || args[2] === '-h' || args[2] === '--help') {
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
