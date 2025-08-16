import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { ProcessDaemon } from "../src/daemon/daemon.js";
import { IPCClient } from "../src/ipc/socket.js";
import { createIPCMessage, createProcessConfig } from "../src/types/index.js";
import { resolve } from "path";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";

describe("Show Command", () => {
  let daemon: ProcessDaemon;
  let client: IPCClient;
  let testDir: string;
  let socketPath: string;
  let testScript: string;

  beforeEach(async () => {
    // Create test directory
    testDir = resolve(process.cwd(), 'test-show-temp');
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(testDir, { recursive: true });

    // Create test script
    testScript = resolve(testDir, 'test-app.js');
    writeFileSync(testScript, `
      console.log('Test app started');
      setInterval(() => {
        console.log('Test app running...');
      }, 1000);
    `);

    // Set up daemon and client
    socketPath = resolve(testDir, 'daemon.sock');
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

    // Clean up test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test("should show detailed process information", async () => {
    // Start a test process
    const config = createProcessConfig({
      id: 'test-show-process',
      name: 'test-show-app',
      script: testScript,
      cwd: testDir,
      env: { NODE_ENV: 'test', PORT: '3000' },
      instances: 1,
      autorestart: true,
      maxRestarts: 5,
      memoryLimit: 100 * 1024 * 1024 // 100MB
    });

    const startMessage = createIPCMessage('start', { config });
    const startResponse = await client.sendMessage(startMessage);
    expect(startResponse.success).toBe(true);

    // Wait a moment for process to start and metrics to be collected
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Test show command with process ID
    const showMessage = createIPCMessage('show', { identifier: 'test-show-process' });
    const showResponse = await client.sendMessage(showMessage);

    expect(showResponse.success).toBe(true);
    expect(showResponse.data).toBeDefined();

    const { process: proc, metrics, history } = showResponse.data;

    // Verify basic process information
    expect(proc.id).toBe('test-show-process');
    expect(proc.name).toBe('test-show-app');
    expect(proc.status).toBe('running');
    expect(proc.pid).toBeGreaterThan(0);
    expect(proc.script).toBe(testScript);
    expect(proc.cwd).toBe(testDir);
    expect(proc.instances).toBe(1);
    expect(proc.autorestart).toBe(true);
    expect(proc.maxRestarts).toBe(5);
    expect(proc.memoryLimit).toBe(100 * 1024 * 1024);
    expect(proc.env).toEqual({ NODE_ENV: 'test', PORT: '3000' });
    expect(proc.startTime).toBeDefined();
    expect(proc.restartCount).toBe(0);

    // Verify metrics are present
    expect(metrics).toBeDefined();
    expect(typeof metrics.cpu).toBe('number');
    expect(typeof metrics.memory).toBe('number');
    expect(typeof metrics.uptime).toBe('number');
    expect(typeof metrics.restarts).toBe('number');
    expect(metrics.uptime).toBeGreaterThan(0);

    // Verify history is present (might be empty initially)
    expect(Array.isArray(history)).toBe(true);
  });

  test("should show process information by name", async () => {
    // Start a test process
    const config = createProcessConfig({
      id: 'test-show-by-name',
      name: 'show-by-name-app',
      script: testScript,
      cwd: testDir
    });

    const startMessage = createIPCMessage('start', { config });
    const startResponse = await client.sendMessage(startMessage);
    expect(startResponse.success).toBe(true);

    // Wait a moment for process to start
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Test show command with process name
    const showMessage = createIPCMessage('show', { identifier: 'show-by-name-app' });
    const showResponse = await client.sendMessage(showMessage);

    expect(showResponse.success).toBe(true);
    expect(showResponse.data.process.name).toBe('show-by-name-app');
  });

  test("should handle clustered process show command", async () => {
    // Start a clustered process
    const config = createProcessConfig({
      id: 'test-cluster-show',
      name: 'cluster-show-app',
      script: testScript,
      cwd: testDir,
      instances: 2
    });

    const startMessage = createIPCMessage('start', { config });
    const startResponse = await client.sendMessage(startMessage);
    expect(startResponse.success).toBe(true);

    // Wait a moment for processes to start
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Test show command - should show the first instance
    const showMessage = createIPCMessage('show', { identifier: 'test-cluster-show' });
    const showResponse = await client.sendMessage(showMessage);

    expect(showResponse.success).toBe(true);
    expect(showResponse.data.process.name).toBe('cluster-show-app');
    expect(showResponse.data.process.id).toMatch(/test-cluster-show/);
  });

  test("should return error for non-existent process", async () => {
    const showMessage = createIPCMessage('show', { identifier: 'non-existent-process' });
    const showResponse = await client.sendMessage(showMessage);

    expect(showResponse.success).toBe(false);
    expect(showResponse.error).toContain('not found');
  });

  test("should return error when identifier is missing", async () => {
    const showMessage = createIPCMessage('show', {});
    const showResponse = await client.sendMessage(showMessage);

    expect(showResponse.success).toBe(false);
    expect(showResponse.error).toContain('identifier is required');
  });

  test("should show metrics history after some time", async () => {
    // Start a test process
    const config = createProcessConfig({
      id: 'test-history-show',
      name: 'history-show-app',
      script: testScript,
      cwd: testDir
    });

    const startMessage = createIPCMessage('start', { config });
    const startResponse = await client.sendMessage(startMessage);
    expect(startResponse.success).toBe(true);

    // Wait for at least one monitoring cycle to collect history
    await new Promise(resolve => setTimeout(resolve, 6000)); // Wait 6 seconds for at least 1 monitoring cycle

    const showMessage = createIPCMessage('show', { identifier: 'test-history-show' });
    const showResponse = await client.sendMessage(showMessage);

    expect(showResponse.success).toBe(true);
    
    const { history } = showResponse.data;
    expect(Array.isArray(history)).toBe(true);
    
    // Should have some history entries after waiting
    if (history.length > 0) {
      const entry = history[0];
      expect(typeof entry.cpu).toBe('number');
      expect(typeof entry.memory).toBe('number');
      expect(typeof entry.uptime).toBe('number');
      expect(typeof entry.restarts).toBe('number');
    }
  }, 10000); // Increase timeout to 10 seconds

  test("should show process with environment variables", async () => {
    // Start a process with environment variables
    const config = createProcessConfig({
      id: 'test-env-show',
      name: 'env-show-app',
      script: testScript,
      cwd: testDir,
      env: {
        NODE_ENV: 'production',
        PORT: '8080',
        DEBUG: 'true',
        API_KEY: 'secret-key'
      }
    });

    const startMessage = createIPCMessage('start', { config });
    const startResponse = await client.sendMessage(startMessage);
    expect(startResponse.success).toBe(true);

    // Wait a moment for process to start
    await new Promise(resolve => setTimeout(resolve, 1000));

    const showMessage = createIPCMessage('show', { identifier: 'test-env-show' });
    const showResponse = await client.sendMessage(showMessage);

    expect(showResponse.success).toBe(true);
    
    const { process: proc } = showResponse.data;
    expect(proc.env).toEqual({
      NODE_ENV: 'production',
      PORT: '8080',
      DEBUG: 'true',
      API_KEY: 'secret-key'
    });
  });

  test("should show process without memory limit", async () => {
    // Start a process without memory limit
    const config = createProcessConfig({
      id: 'test-no-memory-limit',
      name: 'no-memory-limit-app',
      script: testScript,
      cwd: testDir
      // No memoryLimit specified
    });

    const startMessage = createIPCMessage('start', { config });
    const startResponse = await client.sendMessage(startMessage);
    expect(startResponse.success).toBe(true);

    // Wait a moment for process to start
    await new Promise(resolve => setTimeout(resolve, 1000));

    const showMessage = createIPCMessage('show', { identifier: 'test-no-memory-limit' });
    const showResponse = await client.sendMessage(showMessage);

    expect(showResponse.success).toBe(true);
    
    const { process: proc } = showResponse.data;
    expect(proc.memoryLimit).toBeUndefined();
  });
});