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
      case 'save':
        await handleSave(commandArgs);
        break;
      case 'load':
        await handleLoad(commandArgs);
        break;
      case 'delete':
      case 'del':
        await handleDelete(commandArgs);
        break;
      case 'monit':
        await handleMonit(commandArgs);
        break;
      case 'show':
        await handleShow(commandArgs);
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
    console.error('Error: Script path or ecosystem file is required');
    console.error('Usage: bun-pm start <script|ecosystem.json> [options]');
    console.error('       bun-pm start ecosystem.json [app-name]');
    process.exit(1);
  }

  const scriptOrConfigPath = args[0];
  
  // Check if this is an ecosystem configuration file
  if (scriptOrConfigPath.endsWith('.json')) {
    await handleStartFromEcosystem(args);
    return;
  }

  const options = parseCommandOptions(args.slice(1));

  // Validate script exists
  const fullScriptPath = resolve(process.cwd(), scriptOrConfigPath);
  if (!existsSync(fullScriptPath)) {
    console.error(`Error: Script file not found: ${scriptOrConfigPath}`);
    process.exit(1);
  }

  // Create process configuration
  const processName = options.name || basename(scriptOrConfigPath, '.ts').replace(/\.(js|ts|mjs)$/, '');
  const processId = `${processName}-${Date.now()}`;

  const config: ProcessConfig = createProcessConfig({
    id: processId,
    name: processName,
    script: scriptOrConfigPath,
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
      console.log(`  Script: ${scriptOrConfigPath}`);
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
 * Handle scale command
 */
async function handleScale(args: string[]) {
  if (args.length < 2) {
    console.error('Error: Process name/ID and instance count are required');
    console.error('Usage: bun-pm scale <name|id> <instances>');
    process.exit(1);
  }

  const processIdentifier = args[0];
  const instances = parseInt(args[1]);

  if (isNaN(instances) || instances < 1) {
    console.error('Error: Instance count must be a positive integer');
    process.exit(1);
  }

  // Check if daemon is running
  if (!(await isDaemonRunning())) {
    console.error('Error: Daemon is not running');
    process.exit(1);
  }

  const client = new IPCClient(getDefaultSocketPath());
  try {
    await client.connect();
    const message = createIPCMessage('scale', { id: processIdentifier, instances });
    const response = await client.sendMessage(message);

    if (response.success) {
      console.log(`✓ Scaled ${processIdentifier} to ${instances} instance(s)`);
      if (response.data?.instances) {
        console.log(`  Active instances: ${response.data.instances.length}`);
        response.data.instances.forEach((instance: any, index: number) => {
          console.log(`    ${index + 1}. ${instance.id} (PID: ${instance.pid})`);
        });
      }
    } else {
      console.error(`✗ Failed to scale ${processIdentifier}: ${response.error}`);
      process.exit(1);
    }
  } finally {
    await client.disconnect();
  }
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
 * Handle start from ecosystem file
 */
async function handleStartFromEcosystem(args: string[]) {
  const configPath = args[0];
  const appName = args[1]; // Optional: specific app to start

  // Validate config file exists
  const fullConfigPath = resolve(process.cwd(), configPath);
  if (!existsSync(fullConfigPath)) {
    console.error(`Error: Configuration file not found: ${configPath}`);
    process.exit(1);
  }

  // Ensure daemon is running
  await ensureDaemonRunning();

  const client = new IPCClient(getDefaultSocketPath());
  try {
    await client.connect();
    const message = createIPCMessage('startFromFile', { 
      filePath: fullConfigPath,
      appName 
    });
    const response = await client.sendMessage(message);

    if (response.success) {
      const { results, successCount, totalApps } = response.data;
      
      console.log(`✓ ${response.data.message}`);
      
      if (results && results.length > 0) {
        console.log('\nResults:');
        for (const result of results) {
          if (result.success) {
            console.log(`  ✓ ${result.name} (${result.id}) - ${result.instances} instance(s)`);
            if (result.pids) {
              result.pids.forEach((pid: number, index: number) => {
                console.log(`    Instance ${index + 1}: PID ${pid}`);
              });
            }
          } else {
            console.log(`  ✗ ${result.name} (${result.id}) - ${result.error}`);
          }
        }
        
        if (successCount < totalApps) {
          console.log(`\nWarning: ${totalApps - successCount} app(s) failed to start`);
        }
      }
    } else {
      console.error(`✗ Failed to start from ecosystem file: ${response.error}`);
      process.exit(1);
    }
  } finally {
    await client.disconnect();
  }
}

/**
 * Handle save command
 */
async function handleSave(args: string[]) {
  const filePath = args[0] || 'ecosystem.json';
  const fullPath = resolve(process.cwd(), filePath);

  // Check if daemon is running
  if (!(await isDaemonRunning())) {
    console.error('Error: Daemon is not running');
    process.exit(1);
  }

  const client = new IPCClient(getDefaultSocketPath());
  try {
    await client.connect();
    const message = createIPCMessage('save', { filePath: fullPath });
    const response = await client.sendMessage(message);

    if (response.success) {
      console.log(`✓ ${response.data.message}`);
      if (response.data.processes) {
        console.log(`  Saved ${response.data.processCount} process configuration(s):`);
        response.data.processes.forEach((proc: any) => {
          console.log(`    - ${proc.name} (${proc.id})`);
        });
      }
    } else {
      console.error(`✗ Failed to save configuration: ${response.error}`);
      process.exit(1);
    }
  } finally {
    await client.disconnect();
  }
}

/**
 * Handle load command
 */
async function handleLoad(args: string[]) {
  if (args.length === 0) {
    console.error('Error: Configuration file path is required');
    console.error('Usage: bun-pm load <ecosystem.json>');
    process.exit(1);
  }

  const configPath = args[0];
  const fullPath = resolve(process.cwd(), configPath);

  if (!existsSync(fullPath)) {
    console.error(`Error: Configuration file not found: ${configPath}`);
    process.exit(1);
  }

  // Ensure daemon is running
  await ensureDaemonRunning();

  const client = new IPCClient(getDefaultSocketPath());
  try {
    await client.connect();
    const message = createIPCMessage('load', { filePath: fullPath });
    const response = await client.sendMessage(message);

    if (response.success) {
      const { results, successCount, totalApps } = response.data;
      
      console.log(`✓ ${response.data.message}`);
      
      if (results && results.length > 0) {
        console.log('\nResults:');
        for (const result of results) {
          if (result.success) {
            console.log(`  ✓ ${result.name} (${result.id}) - ${result.instances} instance(s)`);
            if (result.pids) {
              result.pids.forEach((pid: number, index: number) => {
                console.log(`    Instance ${index + 1}: PID ${pid}`);
              });
            }
          } else {
            console.log(`  ✗ ${result.name} (${result.id}) - ${result.error}`);
          }
        }
        
        if (successCount < totalApps) {
          console.log(`\nWarning: ${totalApps - successCount} app(s) failed to start`);
        }
      }
    } else {
      console.error(`✗ Failed to load configuration: ${response.error}`);
      process.exit(1);
    }
  } finally {
    await client.disconnect();
  }
}

/**
 * Handle delete command
 */
async function handleDelete(args: string[]) {
  if (args.length === 0) {
    console.error('Error: Process name or ID is required');
    console.error('Usage: bun-pm delete <name|id>');
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
    const message = createIPCMessage('delete', { id: processIdentifier });
    const response = await client.sendMessage(message);

    if (response.success) {
      console.log(`✓ ${response.data.message}`);
    } else {
      console.error(`✗ Failed to delete process: ${response.error}`);
      process.exit(1);
    }
  } finally {
    await client.disconnect();
  }
}

/**
 * Handle monit command - real-time resource monitoring
 */
async function handleMonit(args: string[]) {
  // Check if daemon is running
  if (!(await isDaemonRunning())) {
    console.error('Error: Daemon is not running');
    process.exit(1);
  }

  console.log('Real-time process monitoring (Press Ctrl+C to exit)');
  console.log('Refreshing every 5 seconds...\n');

  const client = new IPCClient(getDefaultSocketPath());
  
  try {
    await client.connect();

    // Function to display monitoring data
    const displayMonitoring = async () => {
      try {
        const message = createIPCMessage('monit', {});
        const response = await client.sendMessage(message);

        if (response.success) {
          const { processes, systemInfo } = response.data;
          
          // Clear screen and move cursor to top
          process.stdout.write('\x1b[2J\x1b[H');
          
          // Display system information
          console.log('=== System Information ===');
          if (systemInfo) {
            const totalMemGB = (systemInfo.totalMemory / (1024 * 1024 * 1024)).toFixed(1);
            const freeMemGB = (systemInfo.freeMemory / (1024 * 1024 * 1024)).toFixed(1);
            const usedMemGB = ((systemInfo.totalMemory - systemInfo.freeMemory) / (1024 * 1024 * 1024)).toFixed(1);
            
            console.log(`CPU Cores: ${systemInfo.cpuCount}`);
            console.log(`Memory: ${usedMemGB}GB / ${totalMemGB}GB (${freeMemGB}GB free)`);
          }
          
          console.log('\n=== Process Monitoring ===');
          
          if (!processes || processes.length === 0) {
            console.log('No processes running');
            return;
          }

          // Display process monitoring table
          displayMonitoringTable(processes);
          
          console.log(`\nLast updated: ${new Date().toLocaleTimeString()}`);
        } else {
          console.error(`Error getting monitoring data: ${response.error}`);
        }
      } catch (error) {
        console.error('Error during monitoring:', error);
      }
    };

    // Initial display
    await displayMonitoring();

    // Set up periodic refresh
    const refreshInterval = setInterval(displayMonitoring, 5000);

    // Handle Ctrl+C gracefully
    process.on('SIGINT', () => {
      clearInterval(refreshInterval);
      console.log('\nMonitoring stopped');
      process.exit(0);
    });

    // Keep the process running
    await new Promise(() => {}); // Never resolves, keeps running until Ctrl+C

  } finally {
    await client.disconnect();
  }
}

/**
 * Display monitoring table
 */
function displayMonitoringTable(processes: any[]) {
  // Convert to display format with metrics
  const processInfos = processes.map((proc: any) => ({
    name: proc.name || proc.id,
    status: formatStatus(proc.status),
    pid: proc.pid || 0,
    cpu: proc.metrics?.cpu?.toFixed(1) || '0.0',
    memory: proc.metrics?.memory ? formatMemory(proc.metrics.memory) : 'N/A',
    uptime: proc.metrics?.uptime ? formatUptimeSeconds(proc.metrics.uptime) : 'N/A',
    restarts: proc.metrics?.restarts || 0
  }));

  if (processInfos.length === 0) {
    console.log('No processes running');
    return;
  }

  // Calculate column widths
  const nameWidth = Math.max(4, ...processInfos.map(p => p.name.length));
  const statusWidth = Math.max(6, ...processInfos.map(p => p.status.length));
  const pidWidth = Math.max(3, ...processInfos.map(p => p.pid.toString().length));
  const cpuWidth = Math.max(4, ...processInfos.map(p => p.cpu.length));
  const memoryWidth = Math.max(6, ...processInfos.map(p => p.memory.length));
  const uptimeWidth = Math.max(6, ...processInfos.map(p => p.uptime.length));
  const restartsWidth = Math.max(8, ...processInfos.map(p => p.restarts.toString().length));

  // Print header
  console.log(
    padRight('NAME', nameWidth) + ' │ ' +
    padRight('STATUS', statusWidth) + ' │ ' +
    padLeft('PID', pidWidth) + ' │ ' +
    padLeft('CPU%', cpuWidth) + ' │ ' +
    padLeft('MEMORY', memoryWidth) + ' │ ' +
    padRight('UPTIME', uptimeWidth) + ' │ ' +
    padLeft('RESTARTS', restartsWidth)
  );

  console.log('─'.repeat(nameWidth + statusWidth + pidWidth + cpuWidth + memoryWidth + uptimeWidth + restartsWidth + 18));

  // Print processes
  for (const proc of processInfos) {
    console.log(
      padRight(proc.name, nameWidth) + ' │ ' +
      padRight(proc.status, statusWidth) + ' │ ' +
      padLeft(proc.pid.toString(), pidWidth) + ' │ ' +
      padLeft(proc.cpu + '%', cpuWidth) + ' │ ' +
      padLeft(proc.memory, memoryWidth) + ' │ ' +
      padRight(proc.uptime, uptimeWidth) + ' │ ' +
      padLeft(proc.restarts.toString(), restartsWidth)
    );
  }
}

/**
 * Handle show command - detailed process information
 */
async function handleShow(args: string[]) {
  if (args.length === 0) {
    console.error('Error: Process name or ID is required');
    console.error('Usage: bun-pm show <name|id>');
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
    const message = createIPCMessage('show', { identifier: processIdentifier });
    const response = await client.sendMessage(message);

    if (response.success) {
      const { process: proc, metrics, history } = response.data;
      
      console.log(`=== Process Information: ${proc.name || proc.id} ===\n`);
      
      // Basic information
      console.log('Basic Information:');
      console.log(`  ID: ${proc.id}`);
      console.log(`  Name: ${proc.name || 'N/A'}`);
      console.log(`  Status: ${formatStatus(proc.status)}`);
      console.log(`  PID: ${proc.pid || 'N/A'}`);
      console.log(`  Script: ${proc.script || 'N/A'}`);
      console.log(`  Working Directory: ${proc.cwd || 'N/A'}`);
      console.log(`  Instances: ${proc.instances || 1}`);
      console.log(`  Auto Restart: ${proc.autorestart ? 'Yes' : 'No'}`);
      console.log(`  Max Restarts: ${proc.maxRestarts || 'N/A'}`);
      if (proc.memoryLimit) {
        console.log(`  Memory Limit: ${formatMemory(proc.memoryLimit)}`);
      }
      
      // Current metrics
      if (metrics) {
        console.log('\nCurrent Metrics:');
        console.log(`  CPU Usage: ${metrics.cpu?.toFixed(1) || '0.0'}%`);
        console.log(`  Memory Usage: ${metrics.memory ? formatMemory(metrics.memory) : 'N/A'}`);
        console.log(`  Uptime: ${metrics.uptime ? formatUptimeSeconds(metrics.uptime) : 'N/A'}`);
        console.log(`  Restart Count: ${metrics.restarts || 0}`);
      }
      
      // Environment variables
      if (proc.env && Object.keys(proc.env).length > 0) {
        console.log('\nEnvironment Variables:');
        for (const [key, value] of Object.entries(proc.env)) {
          console.log(`  ${key}=${value}`);
        }
      }
      
      // Recent metrics history
      if (history && history.length > 0) {
        console.log('\nRecent Metrics History (last 10 entries):');
        console.log('  Time       CPU%   Memory    Uptime    Restarts');
        console.log('  ────────── ────── ───────── ───────── ────────');
        
        const recentHistory = history.slice(-10);
        for (let i = 0; i < recentHistory.length; i++) {
          const entry = recentHistory[i];
          const timeAgo = `${(recentHistory.length - i) * 5}s ago`;
          console.log(
            `  ${padRight(timeAgo, 10)} ` +
            `${padLeft(entry.cpu?.toFixed(1) + '%' || '0.0%', 6)} ` +
            `${padLeft(entry.memory ? formatMemory(entry.memory) : 'N/A', 9)} ` +
            `${padLeft(entry.uptime ? formatUptimeSeconds(entry.uptime) : 'N/A', 9)} ` +
            `${padLeft((entry.restarts || 0).toString(), 8)}`
          );
        }
      }
      
    } else {
      console.error(`✗ Failed to get process information: ${response.error}`);
      process.exit(1);
    }
  } finally {
    await client.disconnect();
  }
}

/**
 * Format uptime in seconds to human readable format
 */
function formatUptimeSeconds(seconds: number): string {
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

  // Unref the process so it doesn't keep the parent alive
  daemonProcess.unref();

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
  start <script|config>  Start a new process or ecosystem file
  stop <name|id>         Stop a running process
  restart <name|id>      Restart a process
  scale <name|id> <n>    Scale process to n instances
  delete <name|id>       Delete a process configuration
  list, ls              List all processes
  logs <name|id>        Show process logs
  monit                 Real-time process monitoring
  show <name|id>        Show detailed process information
  save [file]           Save current processes to ecosystem file
  load <file>           Load processes from ecosystem file

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
  # Start individual processes
  bun-pm start app.ts
  bun-pm start server.js --name web-server --instances 4
  bun-pm start api.ts --env PORT=3000 --env NODE_ENV=production
  
  # Ecosystem file operations
  bun-pm start ecosystem.json           # Start all apps in ecosystem file
  bun-pm start ecosystem.json my-app    # Start specific app from ecosystem file
  bun-pm save ecosystem.json            # Save current processes to file
  bun-pm load ecosystem.json            # Load and start processes from file
  
  # Process management
  bun-pm stop web-server
  bun-pm restart api
  bun-pm scale web-server 8
  bun-pm delete old-process
  bun-pm list
  
  # Logging
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