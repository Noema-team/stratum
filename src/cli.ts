#!/usr/bin/env node

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { exec } from 'node:child_process';

import { InitService, type InitRequest } from './init-service.js';
import { DiscoveryService } from './discovery-service.js';
import { readPidFile, removePidFile, isPidAlive, writePidFile } from './pid-file.js';
import { parseCLIArgs, type DaemonCommand, type InitCommand, type StartCommand } from './daemon-config.js';
import { RuntimeMapManagerImpl } from './runtime-map.js';
import { StateAPI } from './state-api.js';
import { ProjectTypeEnum } from './types.js';
import { createStratumApplication } from './application.js';

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
    task_store: cmd.taskStore === 'beads' ? 'beads' : 'local',
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
    // Step 10: auto-start daemon after a complete init unless --no-daemon was passed
    if (result.data.status === 'complete' && !cmd.noDaemon) {
      console.log('\nStarting Stratum daemon...');
      await handleStart({ command: 'start', foreground: true });
    }
  } else {
    console.error(`Error: ${result.error.message}`);
    process.exit(1);
  }
}

function loadOrCreateWorkspaceId(root: string): string {
  const wsFile = path.join(root, '.sle', 'workspace.json');
  if (fs.existsSync(wsFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(wsFile, 'utf8')) as Record<string, unknown>;
      if (typeof data.workspaceId === 'string' && data.workspaceId) return data.workspaceId;
    } catch { /* fall through */ }
  }
  const workspaceId = randomUUID();
  fs.mkdirSync(path.join(root, '.sle'), { recursive: true });
  fs.writeFileSync(wsFile, JSON.stringify({ workspaceId }, null, 2) + '\n', 'utf8');
  return workspaceId;
}

async function handleStart(cmd: StartCommand): Promise<void> {
  const port = cmd.port ?? 7700;
  const pidPath = path.join(projectRoot, '.sle', 'daemon.pid');

  const existingPid = await readPidFile(pidPath);
  if (existingPid && isPidAlive(existingPid)) {
    console.log(`Stratum already running (PID: ${existingPid}) on port ${port}`);
    if (cmd.foreground && !cmd.noOpen) {
      openBrowser(`http://localhost:${port}`);
    }
    return;
  }
  if (existingPid) {
    await removePidFile(pidPath);
  }

  const workspaceId = loadOrCreateWorkspaceId(projectRoot);

  const app = createStratumApplication({ projectRoot, workspaceId, port });
  await app.start();
  await writePidFile(pidPath, process.pid);

  console.log(`Stratum started on port ${port}`);

  if (cmd.foreground && !cmd.noOpen) {
    openBrowser(`http://localhost:${port}`);
  }

  process.once('SIGTERM', () => {
    app.stop()
      .then(() => removePidFile(pidPath))
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });
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
