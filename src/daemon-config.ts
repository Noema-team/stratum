export interface DaemonConfig {
  port: number;
  projectRoot: string;
  foreground: boolean;
  noOpen: boolean;
}

export interface InitCommand {
  command: 'init';
  name?: string;
  description?: string;
  type?: string;
  taskStore?: string;
  noEditor?: boolean;
  noDaemon?: boolean;
  resume?: boolean;
  reset?: boolean;
}

export interface StartCommand {
  command: 'start';
  port?: number;
  foreground?: boolean;
}

export interface StopCommand {
  command: 'stop';
}

export interface StatusCommand {
  command: 'status';
}

export interface DiscoverCommand {
  command: 'discover';
}

export type DaemonCommand =
  | InitCommand
  | StartCommand
  | StopCommand
  | StatusCommand
  | DiscoverCommand;

export function parseCLIArgs(argv: string[]): DaemonCommand {
  const args = argv.slice(2);

  if (args.length === 0) {
    throw new Error('No command specified');
  }

  const command = args[0];

  switch (command) {
    case 'init':
      return parseInit(args.slice(1));
    case 'start':
      return parseStart(args.slice(1));
    case 'stop':
      return { command: 'stop' };
    case 'status':
      return { command: 'status' };
    case 'discover':
      return { command: 'discover' };
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

function parseInit(args: string[]): InitCommand {
  const result: InitCommand = { command: 'init' };
  let i = 0;

  while (i < args.length) {
    switch (args[i]) {
      case '--name':
        result.name = args[++i];
        break;
      case '--description':
        result.description = args[++i];
        break;
      case '--type':
        result.type = args[++i];
        break;
      case '--task-store':
        result.taskStore = args[++i];
        break;
      case '--no-editor':
        result.noEditor = true;
        break;
      case '--no-daemon':
        result.noDaemon = true;
        break;
      case '--resume':
        result.resume = true;
        break;
      case '--reset':
        result.reset = true;
        break;
      default:
        throw new Error(`Unknown option: ${args[i]}`);
    }
    i++;
  }

  return result;
}

function parseStart(args: string[]): StartCommand {
  const result: StartCommand = { command: 'start' };
  let i = 0;

  while (i < args.length) {
    switch (args[i]) {
      case '--port':
        result.port = parseInt(args[++i], 10);
        break;
      case '--foreground':
        result.foreground = true;
        break;
      default:
        throw new Error(`Unknown option: ${args[i]}`);
    }
    i++;
  }

  return result;
}
