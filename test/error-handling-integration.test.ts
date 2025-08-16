import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { ProcessManager } from "../src/core/process-manager.js";
import { LogManager } from "../src/core/log-manager.js";
import { MonitorManager } from "../src/core/monitor-manager.js";
import { ProcessDaemon } from "../src/daemon/daemon.js";
import { IPCClient } from "../src/ipc/socket.js";
import { createProcessConfig, createIPCMessage } from "../src/types/index.js";
import {
  ProcessStartupError,
  ProcessCrashError,
  ProcessRestartLimitError,
  InvalidConfigurationError,
  FileNotFoundError
} from "../src/core/error-handler.js";
import { resolve } from "path";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";

describe("Error Handling Integration", () => {
  let processManager: ProcessManager;
  let logManager: LogManager;
  let monitorManager: MonitorManager;
  let testDir: string;
  let testScript: string;
  let invalidScript: string;

  beforeEach(async () => {
    // Create test directory and scripts
    testDir = resolve(process.cwd(), 'test-temp-error-handling');
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(testDir, { recursive: true });

    // Create a valid test script
    testScript = resolve(testDir, 'test-app.js');
    writeFileSync(testScript, `
      console.log('Test app started');
      
      // Exit after a short delay for testing
      setTimeout(() => {
        console.log('Test app exiting');
        process.exit(0);
      }, 100);
    `);

    // Create an invalid script that will crash
    const crashScript = resolve(testDir, 'crash-app.js');
    writeFileSync(crashScript, `
      console.log('Crash app started');
      
      // Crash immediately
      setTimeout(() => {
        console.log('Crash app crashing');
        process.exit(1);
      }, 50);
    `);

    // Path to non-existent script
    invalidScript = resolve(testDir, 'non-existent.js');

    // Initialize managers
    logManager = new LogManager();
    monitorManager = new MonitorManager();
    processManager = new ProcessManager(logManager, monitorManager);
  });

  afterEach(async () => {
    // Clean up
    await processManager.cleanup();
    
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("Process Startup Error Handling", () => {
    test("should handle file not found errors", async () => {
      const config = createProcessConfig({
        id: 'test-missing',
        name: 'test-missing',
        script: invalidScript,
        cwd: testDir
      });

      let caughtError: any = null;
      try {
        await processManager.start(config);
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(FileNotFoundError);
      expect(caughtError.code).toBe('FILE_NOT_FOUND');
      expect(caughtError.getUserMessage()).toContain('does not exist');

      // Check error was logged
      const errorStats = processManager.getErrorStats();
      expect(errorStats.total).toBeGreaterThan(0);
      expect(errorStats.byCategory.filesystem).toBeGreaterThan(0);
    });

    test("should handle duplicate process ID errors", async () => {
      const config = createProcessConfig({
        id: 'duplicate-test',
        name: 'duplicate-test',
        script: testScript,
        cwd: testDir
      });

      // Start first instance
      const instances = await processManager.start(config);
      expect(instances).toHaveLength(1);

      // Try to start duplicate
      let caughtError: any = null;
      try {
        await processManager.start(config);
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(ProcessStartupError);
      expect(caughtError.code).toBe('PROCESS_STARTUP_FAILED');
      expect(caughtError.getUserMessage()).toContain('Unable to start process');

      // Clean up
      await processManager.stop('duplicate-test');
    });

    test("should handle invalid working directory", async () => {
      const config = createProcessConfig({
        id: 'invalid-cwd',
        name: 'invalid-cwd',
        script: 'test-app.js', // Relative path
        cwd: '/non/existent/directory'
      });

      let caughtError: any = null;
      try {
        await processManager.start(config);
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(FileNotFoundError);
      expect(caughtError.getUserMessage()).toContain('does not exist');
    });
  });

  describe("Process Crash Error Handling", () => {
    test("should handle process crashes with restart", async () => {
      const crashScript = resolve(testDir, 'crash-app.js');
      const config = createProcessConfig({
        id: 'crash-test',
        name: 'crash-test',
        script: crashScript,
        cwd: testDir,
        autorestart: true,
        maxRestarts: 3
      });

      const instances = await processManager.start(config);
      expect(instances).toHaveLength(1);

      // Wait for the process to crash and restart
      await new Promise(resolve => setTimeout(resolve, 200));

      // Check that error was logged
      const errorHistory = processManager.getErrorHistory();
      const crashErrors = errorHistory.filter(e => e.code === 'PROCESS_CRASHED');
      expect(crashErrors.length).toBeGreaterThan(0);

      // Check error details
      const crashError = crashErrors[0];
      expect(crashError.context?.processId).toBe('crash-test');
      expect(crashError.context?.exitCode).toBe(1);

      // Clean up
      await processManager.stop('crash-test');
    });

    test("should handle restart limit exceeded", async () => {
      const crashScript = resolve(testDir, 'crash-app.js');
      const config = createProcessConfig({
        id: 'restart-limit-test',
        name: 'restart-limit-test',
        script: crashScript,
        cwd: testDir,
        autorestart: true,
        maxRestarts: 1 // Low limit for testing
      });

      const instances = await processManager.start(config);
      expect(instances).toHaveLength(1);

      // Wait for crashes and restart attempts
      await new Promise(resolve => setTimeout(resolve, 500));

      // Check for restart limit error
      const errorHistory = processManager.getErrorHistory();
      const limitErrors = errorHistory.filter(e => e.code === 'PROCESS_RESTART_LIMIT_EXCEEDED');
      expect(limitErrors.length).toBeGreaterThan(0);

      const limitError = limitErrors[0];
      expect(limitError.context?.processId).toBe('restart-limit-test');
      expect(limitError.context?.maxRestarts).toBe(1);

      // Process should be marked as errored
      const process = processManager.get('restart-limit-test');
      expect(process?.status).toBe('errored');

      // Clean up
      try {
        await processManager.stop('restart-limit-test');
      } catch (error) {
        // Process might already be stopped due to error state
      }
    });
  });

  describe("Memory Limit Error Handling", () => {
    test("should handle memory limit exceeded", async () => {
      // Create a memory-intensive script
      const memoryScript = resolve(testDir, 'memory-app.js');
      writeFileSync(memoryScript, `
        console.log('Memory app started');
        
        // Allocate memory gradually
        const arrays = [];
        const interval = setInterval(() => {
          // Allocate 10MB chunks
          arrays.push(new Array(10 * 1024 * 1024).fill('x'));
          console.log('Allocated memory chunk');
        }, 10);
        
        // Keep running
        setTimeout(() => {
          clearInterval(interval);
        }, 5000);
      `);

      const config = createProcessConfig({
        id: 'memory-test',
        name: 'memory-test',
        script: memoryScript,
        cwd: testDir,
        memoryLimit: 50 * 1024 * 1024, // 50MB limit
        autorestart: true,
        maxRestarts: 2
      });

      const instances = await processManager.start(config);
      expect(instances).toHaveLength(1);

      // Wait for memory limit to be exceeded
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Check for memory limit errors
      const errorHistory = processManager.getErrorHistory();
      const memoryErrors = errorHistory.filter(e => e.code === 'PROCESS_MEMORY_LIMIT_EXCEEDED');
      
      if (memoryErrors.length > 0) {
        const memoryError = memoryErrors[0];
        expect(memoryError.context?.processId).toBe('memory-test');
        expect(memoryError.context?.memoryLimit).toBe(50 * 1024 * 1024);
        expect(memoryError.getUserMessage).toBeDefined();
      }

      // Clean up
      await processManager.stop('memory-test');
    });
  });

  describe("Error Recovery Integration", () => {
    test("should recover from recoverable errors", async () => {
      const config = createProcessConfig({
        id: 'recovery-test',
        name: 'recovery-test',
        script: testScript,
        cwd: testDir,
        autorestart: true,
        maxRestarts: 5
      });

      const instances = await processManager.start(config);
      expect(instances).toHaveLength(1);

      // Simulate a crash by killing the process
      const process = processManager.get('recovery-test');
      if (process) {
        process.subprocess.kill('SIGTERM');
      }

      // Wait for restart
      await new Promise(resolve => setTimeout(resolve, 200));

      // Check that recovery was attempted
      const errorHistory = processManager.getErrorHistory();
      const hasRecoveryAttempt = errorHistory.some(e => 
        e.context?.processId === 'recovery-test' && 
        (e.code === 'PROCESS_CRASHED' || e.code === 'PROCESS_STARTUP_FAILED')
      );

      expect(hasRecoveryAttempt).toBe(true);

      // Clean up
      await processManager.stop('recovery-test');
    });

    test("should not recover from non-recoverable errors", async () => {
      const config = createProcessConfig({
        id: 'non-recoverable-test',
        name: 'non-recoverable-test',
        script: invalidScript, // This will cause a non-recoverable FileNotFoundError
        cwd: testDir
      });

      let caughtError: any = null;
      try {
        await processManager.start(config);
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(FileNotFoundError);
      expect(caughtError.recoverable).toBe(false);

      // Check that no recovery was attempted
      const errorHistory = processManager.getErrorHistory();
      const recoveryAttempts = errorHistory.filter(e => 
        e.context?.processId === 'non-recoverable-test' && 
        e.message.includes('recovery')
      );
      expect(recoveryAttempts).toHaveLength(0);
    });
  });

  describe("Error Statistics Integration", () => {
    test("should track error statistics across operations", async () => {
      // Perform various operations that will generate errors
      const configs = [
        createProcessConfig({
          id: 'missing-1',
          name: 'missing-1',
          script: '/non/existent/script1.js',
          cwd: testDir
        }),
        createProcessConfig({
          id: 'missing-2',
          name: 'missing-2',
          script: '/non/existent/script2.js',
          cwd: testDir
        })
      ];

      // Try to start processes with missing scripts
      for (const config of configs) {
        try {
          await processManager.start(config);
        } catch (error) {
          // Expected to fail
        }
      }

      // Check error statistics
      const stats = processManager.getErrorStats();
      expect(stats.total).toBeGreaterThanOrEqual(2);
      expect(stats.byCategory.filesystem).toBeGreaterThanOrEqual(2);
      expect(stats.bySeverity.error).toBeGreaterThanOrEqual(2);

      // Check error history
      const history = processManager.getErrorHistory();
      expect(history.length).toBeGreaterThanOrEqual(2);

      const fileErrors = history.filter(e => e.code === 'FILE_NOT_FOUND');
      expect(fileErrors.length).toBeGreaterThanOrEqual(2);
    });

    test("should provide recent error tracking", async () => {
      const initialStats = processManager.getErrorStats();
      const initialRecent = initialStats.recent;

      // Generate a new error
      try {
        const config = createProcessConfig({
          id: 'recent-error-test',
          name: 'recent-error-test',
          script: invalidScript,
          cwd: testDir
        });
        await processManager.start(config);
      } catch (error) {
        // Expected to fail
      }

      const newStats = processManager.getErrorStats();
      expect(newStats.recent).toBeGreaterThan(initialRecent);
      expect(newStats.total).toBeGreaterThan(initialStats.total);
    });
  });
});

describe("Daemon Error Handling Integration", () => {
  let daemon: ProcessDaemon;
  let client: IPCClient;
  let testDir: string;
  let socketPath: string;

  beforeEach(async () => {
    testDir = resolve(process.cwd(), 'test-temp-daemon-errors');
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(testDir, { recursive: true });

    socketPath = resolve(testDir, 'test-daemon.sock');
    daemon = new ProcessDaemon(socketPath);
    client = new IPCClient(socketPath);

    await daemon.start();
    await client.connect();
  });

  afterEach(async () => {
    try {
      await client.disconnect();
      await daemon.stop();
    } catch (error) {
      // Ignore cleanup errors
    }

    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test("should handle invalid configuration errors via IPC", async () => {
    const invalidConfig = {
      id: '', // Invalid: empty ID
      name: 'test',
      script: 'app.js',
      cwd: testDir
    };

    const message = createIPCMessage('start', { config: invalidConfig });
    const response = await client.sendMessage(message);

    expect(response.success).toBe(false);
    expect(response.error).toContain('Configuration');
    expect(response.error).toContain('id is required');
  });

  test("should handle file not found errors via IPC", async () => {
    const config = {
      id: 'missing-file-test',
      name: 'missing-file-test',
      script: 'non-existent.js',
      cwd: testDir,
      env: {},
      instances: 1,
      autorestart: true,
      maxRestarts: 10
    };

    const message = createIPCMessage('start', { config });
    const response = await client.sendMessage(message);

    expect(response.success).toBe(false);
    expect(response.error).toContain('does not exist');
  });

  test("should provide error statistics via IPC", async () => {
    // Generate some errors first
    const invalidConfig = {
      id: 'error-stats-test',
      name: 'error-stats-test',
      script: 'non-existent.js',
      cwd: testDir,
      env: {},
      instances: 1,
      autorestart: true,
      maxRestarts: 10
    };

    // Try to start invalid process
    const startMessage = createIPCMessage('start', { config: invalidConfig });
    await client.sendMessage(startMessage);

    // Get error statistics
    const statsMessage = createIPCMessage('errorStats', {});
    const statsResponse = await client.sendMessage(statsMessage);

    expect(statsResponse.success).toBe(true);
    expect(statsResponse.data).toBeDefined();
    expect(statsResponse.data.combined).toBeDefined();
    expect(statsResponse.data.combined.total).toBeGreaterThan(0);
    expect(statsResponse.data.daemon).toBeDefined();
    expect(statsResponse.data.processManager).toBeDefined();
  });

  test("should provide error history via IPC", async () => {
    // Generate an error first
    const invalidConfig = {
      id: 'error-history-test',
      name: 'error-history-test',
      script: 'non-existent.js',
      cwd: testDir,
      env: {},
      instances: 1,
      autorestart: true,
      maxRestarts: 10
    };

    const startMessage = createIPCMessage('start', { config: invalidConfig });
    await client.sendMessage(startMessage);

    // Get error history
    const historyMessage = createIPCMessage('errors', { limit: 10 });
    const historyResponse = await client.sendMessage(historyMessage);

    expect(historyResponse.success).toBe(true);
    expect(historyResponse.data).toBeDefined();
    expect(historyResponse.data.errors).toBeInstanceOf(Array);
    expect(historyResponse.data.errors.length).toBeGreaterThan(0);
    expect(historyResponse.data.totalCount).toBeGreaterThan(0);

    // Check error structure
    const error = historyResponse.data.errors[0];
    expect(error.timestamp).toBeDefined();
    expect(error.message).toBeDefined();
    expect(error.code).toBeDefined();
    expect(error.category).toBeDefined();
    expect(error.severity).toBeDefined();
  });
});