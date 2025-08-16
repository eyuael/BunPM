#!/usr/bin/env bun

import { parseArgs } from "util";
import { IPCClient, getDefaultSocketPath, isDaemonRunning } from "../ipc/index.js";
import { createIPCMessage, ProcessConfig, createProcessConfig } from "../types/index.js";
import { resolve, basename } from "path";
import { existsSync } from "fs";

/**
 * CLI command interface
 */
interface CLIOptions {
  name?: string;
  instances?: number;
  autorestart?: boolean;
  'no-autorestart'?: boolean;
  env?: string[];
  cwd?: string;
  'memory-limit'?: number;
  help?: boolean;
  version?: boolean;
}

/**
 * Process information for display
 */
interface ProcessInfo {
  id: string;
  name: string;
  status: string;
  pid: number;
  uptime: string;
  restarts: number;
  memory?: string;
}

/**
 * Main CLI entry point
 */
async function main() {
  try {
    const args = process.argv.slice(2);
    
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
      showHelp();
      process.exit(0);
    }

    if (args.includes('--version') || args.includes('-v')) {
      showVersion();
      process.exit(0);
    }

    const command = args[0];
    const commandArgs = args.slice(1);

    switch (command) {
      case 'start':
        await handleStart(commandArgs);
        break;
      case 'stop':
        await handleStop(commandArgs);
        break;
      case 'restart':
        await handleRestart(commandArgs);
        break;
      case 'list':
      case 'ls':
        await handleList(commandArgs);
        break;
      case 'logs':
        await handleLogs(commandArgs);
        break;
      case 'scale':
        await handleScale(commandArgs);
        break;
      default:
        console.error(`Unknown command: ${command}`);
        console.error('Run "bun-pm --help" for usage information');
        process.exit(1);
    }
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

/**
 * Handle start command
 */
async function handleStart(args: string[]) {
  if (args.length === 0) {
    console.error('Error: Script path is required');
    console.error('Usage: bun-pm start <script> [options]');
    process.exit(1);
  }

  const scriptPath = args[0];
  const options = parseCommandOptions(args.slice(1));

  // Validate script exists
  const fullScriptPath = resolve(process.cwd(), scriptPath);
  if (!existsSync(fullScriptPath)) {
    console.error(`Error: Script file not found: ${scriptPath}`);
    process.exit(1);
  }

  // Create process configuration
  const processName = options.name || basename(scriptPath, '.ts').replace(/\.(js|ts|mjs)$/, '');
  const processId = `${processName}-${Date.now()}`;

  const config: ProcessConfig = createProcessConfig({
    id: processId,
    name: processName,
    script: scriptPath,
    cwd: options.cwd || process.cwd(),
    env: parseEnvVars(options.env || []),
    instances: options.instances || 1,
    autorestart: options['no-autorestart'] ? false : (options.autorestart ?? true),
    memoryLimit: options['memory-limit']
  });

  // Ensure daemon is running
  await ensureDaemonRunning();

  // Send start command to daemon
  const client = new IPCClient(getDefaultSocketPath());
  try {
    await client.connect();
    const message = createIPCMessage('start', { config });
    const response = await client.sendMessage(message);

    if (response.success) {
      console.log(`✓ Started ${processName} (${processId})`);
      if (config.instances > 1) {
        console.log(`  Instances: ${config.instances}`);
      }
      console.log(`  Script: ${scriptPath}`);
      console.log(`  Working directory: ${config.cwd}`);
    } else {
      console.error(`✗ Failed to start ${processName}: ${response.error}`);
      process.exit(1);
    }
  } finally {
    await client.disconnect();
  }
}

/**
 * Handle stop command
 */
async function handleStop(args: string[]) {
  if (args.length === 0) {
    console.error('Error: Process name or ID is required');
    console.error('Usage: bun-pm stop <name|id>');
    process.exit(1);
  }

  const processIdentifier = args[0];

  // Check if daemon is running
  if (!(await isDaemonRunning())) {
    console.error('Error: Daemon is not running');
    process.exit(1);
  }

  const client = new IPCClient(getDefaultSocketPath());
  try {
    await client.connect();
    const message = createIPCMessage('stop', { identifier: processIdentifier });
    const response = await client.sendMessage(message);

    if (response.success) {
      console.log(`✓ Stopped ${processIdentifier}`);
    } else {
      console.error(`✗ Failed to stop ${processIdentifier}: ${response.error}`);
      process.exit(1);
    }
  } finally {
    await client.disconnect();
  }
}

/**
 * Handle restart command
 */
async function handleRestart(args: string[]) {
  if (args.length === 0) {
    console.error('Error: Process name or ID is required');
    console.error('Usage: bun-pm restart <name|id>');
    process.exit(1);
  }

  const processIdentifier = args[0];

  // Check if daemon is running
  if (!(await isDaemonRunning())) {
    console.error('Error: Daemon is not running');
    process.exit(1);
  }

  const client = new IPCClient(getDefaultSocketPath());
  try {
    await client.connect();
    const message = createIPCMessage('restart', { identifier: processIdentifier });
    const response = await client.sendMessage(message);

    if (response.success) {
      console.log(`✓ Restarted ${processIdentifier}`);
    } else {
      console.error(`✗ Failed to restart ${processIdentifier}: ${response.error}`);
      process.exit(1);
    }
  } finally {
    await client.disconnect();
  }
}

/**
 * Handle list command
 */
async function handleList(args: string[]) {
  // Check if daemon is running
  if (!(await isDaemonRunning())) {
    console.log('No processes running (daemon not started)');
    return;
  }

  const client = new IPCClient(getDefaultSocketPath());
  try {
    await client.connect();
    const message = createIPCMessage('list', {});
    const response = await client.sendMessage(message);

    if (response.success) {
      const processes = response.data?.processes || [];
      
      if (processes.length === 0) {
        console.log('No processes running');
        return;
      }

      // Format and display process list
      displayProcessList(processes);
    } else {
      console.error(`✗ Failed to list processes: ${response.error}`);
      process.exit(1);
    }
  } finally {
    await client.disconnect();
  }
}

/**
 * Display formatted process list
 */
function displayProcessList(processes: any[]) {
  // Convert to display format
  const processInfos: ProcessInfo[] = processes.map(proc => ({
    id: proc.id,
    name: proc.name || proc.id,
    status: formatStatus(proc.status),
    pid: proc.pid || 0,
    uptime: formatUptime(proc.startTime),
    restarts: proc.restartCount || 0,
    memory: proc.memory ? formatMemory(proc.memory) : 'N/A'
  }));

  // Calculate column widths
  const nameWidth = Math.max(4, ...processInfos.map(p => p.name.length));
  const statusWidth = Math.max(6, ...processInfos.map(p => p.status.length));
  const pidWidth = Math.max(3, ...processInfos.map(p => p.pid.toString().length));
  const uptimeWidth = Math.max(6, ...processInfos.map(p => p.uptime.length));
  const restartsWidth = Math.max(8, ...processInfos.map(p => p.restarts.toString().length));
  const memoryWidth = Math.max(6, ...processInfos.map(p => (p.memory || 'N/A').length));

  // Print header
  console.log(
    padRight('NAME', nameWidth) + ' │ ' +
    padRight('STATUS', statusWidth) + ' │ ' +
    padLeft('PID', pidWidth) + ' │ ' +
    padRight('UPTIME', uptimeWidth) + ' │ ' +
    padLeft('RESTARTS', restartsWidth) + ' │ ' +
    padLeft('MEMORY', memoryWidth)
  );

  console.log('─'.repeat(nameWidth + statusWidth + pidWidth + uptimeWidth + restartsWidth + memoryWidth + 15));

  // Print processes
  for (const proc of processInfos) {
    console.log(
      padRight(proc.name, nameWidth) + ' │ ' +
      padRight(proc.status, statusWidth) + ' │ ' +
      padLeft(proc.pid.toString(), pidWidth) + ' │ ' +
      padRight(proc.uptime, uptimeWidth) + ' │ ' +
      padLeft(proc.restarts.toString(), restartsWidth) + ' │ ' +
      padLeft(proc.memory || 'N/A', memoryWidth)
    );
  }
}

/**
 * Format process status with colors
 */
function formatStatus(status: string): string {
  switch (status) {
    case 'running':
      return '🟢 running';
    case 'stopped':
      return '🔴 stopped';
    case 'errored':
      return '🔴 errored';
    case 'restarting':
      return '🟡 restarting';
    default:
      return status;
  }
}

/**
 * Format uptime duration
 */
function formatUptime(startTime: string | Date): string {
  const start = new Date(startTime);
  const now = new Date();
  const diffMs = now.getTime() - start.getTime();
  
  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h`;
  } else if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

/**
 * Format memory usage
 */
function formatMemory(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1000) {
    return `${(mb / 1024).toFixed(1)}GB`;
  }
  return `${mb.toFixed(1)}MB`;
}

/**
 * Pad string to the right
 */
function padRight(str: string, width: number): string {
  return str.padEnd(width);
}

/**
 * Pad string to the left
 */
function padLeft(str: string, width: number): string {
  return str.padStart(width);
}

/**
 * Handle logs command
 */
async function handleLogs(args: string[]) {
  if (args.length === 0) {
    console.error('Error: Process name or ID is required');
    console.error('Usage: bun-pm logs <name|id> [options]');
    process.exit(1);
  }

  const processIdentifier = args[0];
  const options = parseLogsOptions(args.slice(1));

  // Check if daemon is running
  if (!(await isDaemonRunning())) {
    console.error('Error: Daemon is not running');
    process.exit(1);
  }

  const client = new IPCClient(getDefaultSocketPath());
  try {
    await client.connect();
    
    if (options.follow) {
      // Handle streaming logs
      await handleStreamingLogs(client, processIdentifier, options);
    } else {
      // Handle static logs
      const message = createIPCMessage('logs', { 
        identifier: processIdentifier,
        lines: options.lines,
        filter: options.filter
      });
      const response = await client.sendMessage(message);

      if (response.success) {
        const { lines, processId, totalLines, filteredLines } = response.data;
        
        if (lines.length === 0) {
          console.log(`No logs found for process '${processId}'`);
          return;
        }

        // Display log lines
        for (const line of lines) {
          console.log(line);
        }

        // Show summary if filtering was applied
        if (options.filter && filteredLines !== totalLines) {
          console.log(`\n--- Showing ${filteredLines} of ${totalLines} lines (filtered by: ${options.filter}) ---`);
        } else {
          console.log(`\n--- Showing last ${lines.length} lines ---`);
        }
      } else {
        console.error(`✗ Failed to get logs: ${response.error}`);
        process.exit(1);
      }
    }
  } finally {
    await client.disconnect();
  }
}

/**
 * Handle streaming logs with --follow flag
 */
async function handleStreamingLogs(client: IPCClient, processIdentifier: string, options: any) {
  console.log(`Following logs for process '${processIdentifier}' (Press Ctrl+C to exit)`);
  
  // First get initial logs
  const initialMessage = createIPCMessage('logs', { 
    identifier: processIdentifier,
    lines: options.lines || 50,
    filter: options.filter
  });
  const initialResponse = await client.sendMessage(initialMessage);

  if (!initialResponse.success) {
    console.error(`✗ Failed to get logs: ${initialResponse.error}`);
    process.exit(1);
  }

  const { lines, processId } = initialResponse.data;
  
  // Display initial logs
  for (const line of lines) {
    console.log(line);
  }

  // Set up streaming (simplified implementation - in a real scenario we'd need WebSocket or similar)
  // For now, we'll poll for new logs every second
  let lastLineCount = lines.length;
  
  const pollInterval = setInterval(async () => {
    try {
      const pollMessage = createIPCMessage('logs', { 
        identifier: processIdentifier,
        lines: lastLineCount + 100, // Get more lines to catch new ones
        filter: options.filter
      });
      const pollResponse = await client.sendMessage(pollMessage);

      if (pollResponse.success) {
        const newLines = pollResponse.data.lines.slice(lastLineCount);
        if (newLines.length > 0) {
          for (const line of newLines) {
            console.log(line);
          }
          lastLineCount = pollResponse.data.lines.length;
        }
      }
    } catch (error) {
      console.error('Error polling logs:', error);
    }
  }, 1000);

  // Handle Ctrl+C gracefully
  process.on('SIGINT', () => {
    clearInterval(pollInterval);
    console.log('\nLog streaming stopped');
    process.exit(0);
  });
}

/**
 * Parse logs command options
 */
function parseLogsOptions(args: string[]): { lines?: number; follow?: boolean; filter?: string } {
  const options: { lines?: number; follow?: boolean; filter?: string } = {};
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg === '--lines' && i + 1 < args.length) {
      const lines = parseInt(args[++i]);
      if (isNaN(lines) || lines < 1) {
        throw new Error('Lines must be a positive integer');
      }
      options.lines = lines;
    } else if (arg === '--follow' || arg === '-f') {
      options.follow = true;
    } else if (arg === '--filter' && i + 1 < args.length) {
      options.filter = args[++i];
    }
  }
  
  return options;
}

/**
 * Parse command line options
 */
function parseCommandOptions(args: string[]): CLIOptions {
  const options: CLIOptions = {};
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg === '--name' && i + 1 < args.length) {
      options.name = args[++i];
    } else if (arg === '--instances' && i + 1 < args.length) {
      const instances = parseInt(args[++i]);
      if (isNaN(instances) || instances < 1) {
        throw new Error('Instances must be a positive integer');
      }
      options.instances = instances;
    } else if (arg === '--autorestart') {
      options.autorestart = true;
    } else if (arg === '--no-autorestart') {
      options['no-autorestart'] = true;
    } else if (arg === '--env' && i + 1 < args.length) {
      if (!options.env) options.env = [];
      options.env.push(args[++i]);
    } else if (arg === '--cwd' && i + 1 < args.length) {
      options.cwd = args[++i];
    } else if (arg === '--memory-limit' && i + 1 < args.length) {
      const limit = parseInt(args[++i]);
      if (isNaN(limit) || limit <= 0) {
        throw new Error('Memory limit must be a positive integer (bytes)');
      }
      options['memory-limit'] = limit;
    }
  }
  
  return options;
}

/**
 * Parse environment variables from CLI format
 */
function parseEnvVars(envArgs: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  
  for (const envArg of envArgs) {
    const [key, ...valueParts] = envArg.split('=');
    if (key && valueParts.length > 0) {
      env[key] = valueParts.join('=');
    }
  }
  
  return env;
}

/**
 * Ensure daemon is running, start if needed
 */
async function ensureDaemonRunning(): Promise<void> {
  if (await isDaemonRunning()) {
    return;
  }

  console.log('Starting daemon...');
  
  // Import and start daemon
  const { ProcessDaemon } = await import('../daemon/daemon.js');
  const daemon = new ProcessDaemon(getDefaultSocketPath());
  
  // Start daemon in background
  const daemonProcess = Bun.spawn({
    cmd: [process.execPath, '-e', `
      const { ProcessDaemon } = await import('${import.meta.resolve('../daemon/daemon.js')}');
      const daemon = new ProcessDaemon('${getDefaultSocketPath()}');
      await daemon.start();
      
      // Keep daemon running
      process.on('SIGTERM', async () => {
        await daemon.stop();
        process.exit(0);
      });
      
      process.on('SIGINT', async () => {
        await daemon.stop();
        process.exit(0);
      });
    `],
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: true
  });

  // Wait a moment for daemon to start
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  // Verify daemon started
  if (!(await isDaemonRunning())) {
    throw new Error('Failed to start daemon');
  }
  
  console.log('✓ Daemon started');
}

/**
 * Show help information
 */
function showHelp() {
  console.log(`
bun-pm - Bun Process Manager

USAGE:
  bun-pm <command> [options]

COMMANDS:
  start <script>     Start a new process
  stop <name|id>     Stop a running process
  restart <name|id>  Restart a process
  list, ls          List all processes
  logs <name|id>    Show process logs

START OPTIONS:
  --name <name>           Set process name
  --instances <n>         Number of instances to start
  --autorestart          Enable automatic restart (default)
  --no-autorestart       Disable automatic restart
  --env <KEY=VALUE>      Set environment variable (can be used multiple times)
  --cwd <path>           Set working directory
  --memory-limit <bytes> Set memory limit in bytes

LOGS OPTIONS:
  --lines <n>            Number of lines to show (default: 100)
  --follow, -f           Follow log output in real-time
  --filter <pattern>     Filter logs by pattern (regex)

GLOBAL OPTIONS:
  --help, -h         Show this help message
  --version, -v      Show version information

EXAMPLES:
  bun-pm start app.ts
  bun-pm start server.js --name web-server --instances 4
  bun-pm start api.ts --env PORT=3000 --env NODE_ENV=production
  bun-pm stop web-server
  bun-pm restart api
  bun-pm list
  bun-pm logs web-server
  bun-pm logs api --lines 50 --follow
  bun-pm logs web-server --filter "error"
`);
}

/**
 * Show version information
 */
function showVersion() {
  // Read version from package.json
  const packagePath = new URL('../../package.json', import.meta.url).pathname;
  try {
    const packageJson = JSON.parse(Bun.file(packagePath).text());
    console.log(`bun-pm v${packageJson.version}`);
  } catch {
    console.log('bun-pm v1.0.0');
  }
}

// Run CLI if this is the main module
if (import.meta.main) {
  main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}