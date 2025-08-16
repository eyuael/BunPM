import { resolve, dirname } from "path";
import { existsSync, mkdirSync } from "fs";
import { writeFile, readFile, unlink } from "fs/promises";
import { getDefaultSocketPath, isDaemonRunning } from "../ipc/index.js";

/**
 * Daemon state information
 */
export interface DaemonInfo {
  pid: number;
  startTime: Date;
  socketPath: string;
  version?: string;
}

/**
 * Daemon manager for handling daemon lifecycle and PID file management
 */
export class DaemonManager {
  private pidFilePath: string;
  private socketPath: string;

  constructor(socketPath?: string) {
    this.socketPath = socketPath || getDefaultSocketPath();
    this.pidFilePath = this.getPidFilePath();
  }

  /**
   * Get the PID file path
   */
  private getPidFilePath(): string {
    const daemonDir = dirname(this.socketPath);
    return resolve(daemonDir, 'daemon.pid');
  }

  /**
   * Ensure daemon directory exists
   */
  private ensureDaemonDirectory(): void {
    const daemonDir = dirname(this.socketPath);
    if (!existsSync(daemonDir)) {
      mkdirSync(daemonDir, { recursive: true });
    }
  }

  /**
   * Write daemon PID file
   */
  async writePidFile(pid: number): Promise<void> {
    this.ensureDaemonDirectory();
    
    const daemonInfo: DaemonInfo = {
      pid,
      startTime: new Date(),
      socketPath: this.socketPath,
      version: process.env.npm_package_version || '1.0.0'
    };

    await writeFile(this.pidFilePath, JSON.stringify(daemonInfo, null, 2));
  }

  /**
   * Read daemon PID file
   */
  async readPidFile(): Promise<DaemonInfo | null> {
    try {
      if (!existsSync(this.pidFilePath)) {
        return null;
      }

      const content = await readFile(this.pidFilePath, 'utf8');
      const daemonInfo = JSON.parse(content) as DaemonInfo;
      
      // Convert startTime back to Date object
      daemonInfo.startTime = new Date(daemonInfo.startTime);
      
      return daemonInfo;
    } catch (error) {
      // If we can't read or parse the PID file, consider it invalid
      return null;
    }
  }

  /**
   * Remove daemon PID file
   */
  async removePidFile(): Promise<void> {
    try {
      if (existsSync(this.pidFilePath)) {
        await unlink(this.pidFilePath);
      }
    } catch (error) {
      // Ignore errors when removing PID file
    }
  }

  /**
   * Check if daemon process is actually running
   */
  async isDaemonProcessRunning(pid: number): Promise<boolean> {
    try {
      // On Unix systems, sending signal 0 checks if process exists
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // Process doesn't exist or we don't have permission
      return false;
    }
  }

  /**
   * Get daemon status with comprehensive health check
   */
  async getDaemonStatus(): Promise<{
    isRunning: boolean;
    pidFileExists: boolean;
    processRunning: boolean;
    socketResponding: boolean;
    daemonInfo: DaemonInfo | null;
    healthStatus: 'healthy' | 'unhealthy' | 'unknown';
  }> {
    const daemonInfo = await this.readPidFile();
    const pidFileExists = daemonInfo !== null;
    
    let processRunning = false;
    if (daemonInfo) {
      processRunning = await this.isDaemonProcessRunning(daemonInfo.pid);
    }

    const socketResponding = await isDaemonRunning(this.socketPath);

    // Determine overall health status
    let healthStatus: 'healthy' | 'unhealthy' | 'unknown' = 'unknown';
    if (pidFileExists && processRunning && socketResponding) {
      healthStatus = 'healthy';
    } else if (pidFileExists || processRunning || socketResponding) {
      healthStatus = 'unhealthy';
    }

    return {
      isRunning: socketResponding,
      pidFileExists,
      processRunning,
      socketResponding,
      daemonInfo,
      healthStatus
    };
  }

  /**
   * Clean up stale daemon state
   */
  async cleanupStaleState(): Promise<void> {
    const status = await this.getDaemonStatus();
    
    // If PID file exists but process is not running or socket not responding
    if (status.pidFileExists && (!status.processRunning || !status.socketResponding)) {
      console.log('Cleaning up stale daemon state...');
      await this.removePidFile();
      
      // Also try to clean up socket file if it exists
      try {
        if (existsSync(this.socketPath)) {
          await unlink(this.socketPath);
        }
      } catch (error) {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Start daemon with proper background process handling
   */
  async startDaemon(): Promise<void> {
    // First check if daemon is already running
    const status = await this.getDaemonStatus();
    if (status.healthStatus === 'healthy') {
      return; // Daemon is already running and healthy
    }

    // Clean up any stale state
    await this.cleanupStaleState();

    console.log('Starting daemon...');

    // Create daemon startup script
    const startupScript = `
      const { ProcessDaemon } = await import('${import.meta.resolve('../daemon/daemon.js')}');
      const { DaemonManager } = await import('${import.meta.resolve('./daemon-manager.js')}');
      
      const daemon = new ProcessDaemon('${this.socketPath}');
      const daemonManager = new DaemonManager('${this.socketPath}');
      
      // Write PID file
      await daemonManager.writePidFile(process.pid);
      
      // Start daemon
      await daemon.start();
      
      // Set up graceful shutdown handlers
      const shutdown = async (signal) => {
        console.log(\`Received \${signal}, shutting down daemon...\`);
        try {
          await daemon.stop();
          await daemonManager.removePidFile();
        } catch (error) {
          console.error('Error during shutdown:', error);
        }
        process.exit(0);
      };
      
      process.on('SIGTERM', () => shutdown('SIGTERM'));
      process.on('SIGINT', () => shutdown('SIGINT'));
      process.on('SIGHUP', () => shutdown('SIGHUP'));
      
      // Handle uncaught exceptions
      process.on('uncaughtException', async (error) => {
        console.error('Uncaught exception in daemon:', error);
        try {
          await daemon.stop();
          await daemonManager.removePidFile();
        } catch (cleanupError) {
          console.error('Error during cleanup:', cleanupError);
        }
        process.exit(1);
      });
      
      // Keep process running
      console.log('Daemon started successfully');
    `;

    // Start daemon as detached background process
    const daemonProcess = Bun.spawn({
      cmd: [process.execPath, '-e', startupScript],
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: true
    });

    // Unref the process so it doesn't keep the parent alive
    daemonProcess.unref();

    // Wait for daemon to start and verify it's healthy
    const maxWaitTime = 5000; // 5 seconds
    const checkInterval = 200; // 200ms
    const maxAttempts = maxWaitTime / checkInterval;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise(resolve => setTimeout(resolve, checkInterval));
      
      const currentStatus = await this.getDaemonStatus();
      if (currentStatus.healthStatus === 'healthy') {
        console.log('✓ Daemon started successfully');
        return;
      }
    }

    // If we get here, daemon failed to start properly
    await this.cleanupStaleState();
    throw new Error('Failed to start daemon - timeout waiting for healthy status');
  }

  /**
   * Stop daemon gracefully
   */
  async stopDaemon(): Promise<void> {
    const status = await this.getDaemonStatus();
    
    if (!status.isRunning) {
      console.log('Daemon is not running');
      await this.cleanupStaleState();
      return;
    }

    if (status.daemonInfo) {
      try {
        // Send SIGTERM to daemon process
        process.kill(status.daemonInfo.pid, 'SIGTERM');
        
        // Wait for graceful shutdown
        const maxWaitTime = 5000; // 5 seconds
        const checkInterval = 200; // 200ms
        const maxAttempts = maxWaitTime / checkInterval;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          await new Promise(resolve => setTimeout(resolve, checkInterval));
          
          const currentStatus = await this.getDaemonStatus();
          if (!currentStatus.isRunning) {
            console.log('✓ Daemon stopped successfully');
            return;
          }
        }

        // If graceful shutdown failed, force kill
        console.log('Graceful shutdown timeout, force killing daemon...');
        process.kill(status.daemonInfo.pid, 'SIGKILL');
        
        // Wait a bit more and clean up
        await new Promise(resolve => setTimeout(resolve, 1000));
        await this.cleanupStaleState();
        
      } catch (error) {
        // Process might already be dead
        await this.cleanupStaleState();
      }
    }
  }

  /**
   * Restart daemon
   */
  async restartDaemon(): Promise<void> {
    console.log('Restarting daemon...');
    await this.stopDaemon();
    await this.startDaemon();
  }

  /**
   * Ensure daemon is running and healthy
   */
  async ensureDaemonRunning(): Promise<void> {
    const status = await this.getDaemonStatus();
    
    switch (status.healthStatus) {
      case 'healthy':
        // Daemon is running and healthy, nothing to do
        return;
        
      case 'unhealthy':
        // Daemon state is inconsistent, clean up and restart
        console.log('Daemon state is unhealthy, restarting...');
        await this.cleanupStaleState();
        await this.startDaemon();
        break;
        
      case 'unknown':
        // No daemon running, start it
        await this.startDaemon();
        break;
    }
  }
}