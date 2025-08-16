import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { LogManager } from "../src/core/log-manager.js";
import { ProcessManager } from "../src/core/process-manager.js";
import { ProcessDaemon } from "../src/daemon/daemon.js";
import { IPCClient } from "../src/ipc/index.js";
import { createIPCMessage, createProcessConfig } from "../src/types/index.js";
import { join } from "path";
import { existsSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";

describe("Logs Command", () => {
  let testDir: string;
  let logManager: LogManager;
  let processManager: ProcessManager;
  let daemon: ProcessDaemon;
  let socketPath: string;

  beforeEach(async () => {
    // Create temporary test directory
    testDir = join(tmpdir(), `bun-pm-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    
    // Set up test socket path
    socketPath = join(testDir, "test.sock");
    
    // Initialize components
    logManager = new LogManager(join(testDir, "logs"));
    processManager = new ProcessManager(logManager);
    daemon = new ProcessDaemon(socketPath);
  });

  afterEach(async () => {
    // Clean up daemon
    try {
      if (daemon.isActive()) {
        await daemon.stop();
      }
    } catch (error) {
      // Ignore cleanup errors
    }

    // Clean up process manager
    try {
      await processManager.cleanup();
    } catch (error) {
      // Ignore cleanup errors
    }

    // Clean up test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test("should get logs for a process", async () => {
    // Create a simple test script that outputs some text
    const testScript = join(testDir, "test-app.js");
    await Bun.write(testScript, `
      console.log("Starting test application");
      console.log("This is a test log line");
      console.error("This is an error message");
      setTimeout(() => {
        console.log("Delayed message");
        process.exit(0);
      }, 100);
    `);

    // Start daemon
    await daemon.start();

    // Create process config
    const config = createProcessConfig({
      id: "test-logs",
      name: "test-logs",
      script: testScript,
      cwd: testDir,
      env: {},
      instances: 1,
      autorestart: false
    });

    // Start process through daemon
    const client = new IPCClient(socketPath);
    await client.connect();

    const startMessage = createIPCMessage('start', { config });
    const startResponse = await client.sendMessage(startMessage);
    expect(startResponse.success).toBe(true);

    // Wait for process to generate some logs
    await new Promise(resolve => setTimeout(resolve, 200));

    // Get logs
    const logsMessage = createIPCMessage('logs', { 
      identifier: "test-logs",
      lines: 100
    });
    const logsResponse = await client.sendMessage(logsMessage);

    expect(logsResponse.success).toBe(true);
    expect(logsResponse.data.processId).toBe("test-logs");
    expect(logsResponse.data.lines).toBeInstanceOf(Array);
    expect(logsResponse.data.lines.length).toBeGreaterThan(0);

    // Check that logs contain expected content
    const logContent = logsResponse.data.lines.join('\n');
    expect(logContent).toContain("Starting test application");
    expect(logContent).toContain("This is a test log line");

    await client.disconnect();
  });

  test("should limit number of log lines returned", async () => {
    // Create a test script that outputs many lines
    const testScript = join(testDir, "multi-line-app.js");
    await Bun.write(testScript, `
      for (let i = 1; i <= 50; i++) {
        console.log(\`Log line \${i}\`);
      }
      process.exit(0);
    `);

    // Start daemon
    await daemon.start();

    // Create process config
    const config = createProcessConfig({
      id: "multi-line-test",
      name: "multi-line-test", 
      script: testScript,
      cwd: testDir,
      env: {},
      instances: 1,
      autorestart: false
    });

    // Start process through daemon
    const client = new IPCClient(socketPath);
    await client.connect();

    const startMessage = createIPCMessage('start', { config });
    const startResponse = await client.sendMessage(startMessage);
    expect(startResponse.success).toBe(true);

    // Wait for process to complete
    await new Promise(resolve => setTimeout(resolve, 300));

    // Get limited logs
    const logsMessage = createIPCMessage('logs', { 
      identifier: "multi-line-test",
      lines: 10
    });
    const logsResponse = await client.sendMessage(logsMessage);

    if (!logsResponse.success) {
      console.log("Logs error:", logsResponse.error);
    }
    expect(logsResponse.success).toBe(true);
    expect(logsResponse.data.lines.length).toBeLessThanOrEqual(10);

    await client.disconnect();
  });

  test("should filter logs by pattern", async () => {
    // Create a test script with mixed log levels
    const testScript = join(testDir, "filtered-app.js");
    await Bun.write(testScript, `
      console.log("INFO: Application started");
      console.log("DEBUG: Debug message");
      console.error("ERROR: Something went wrong");
      console.log("INFO: Processing data");
      console.error("ERROR: Another error occurred");
      console.log("DEBUG: More debug info");
      process.exit(0);
    `);

    // Start daemon
    await daemon.start();

    // Create process config
    const config = createProcessConfig({
      id: "filtered-test",
      name: "filtered-test",
      script: testScript,
      cwd: testDir,
      env: {},
      instances: 1,
      autorestart: false
    });

    // Start process through daemon
    const client = new IPCClient(socketPath);
    await client.connect();

    const startMessage = createIPCMessage('start', { config });
    const startResponse = await client.sendMessage(startMessage);
    expect(startResponse.success).toBe(true);

    // Wait for process to complete
    await new Promise(resolve => setTimeout(resolve, 200));

    // Get filtered logs (only ERROR messages)
    const logsMessage = createIPCMessage('logs', { 
      identifier: "filtered-test",
      lines: 100,
      filter: "ERROR"
    });
    const logsResponse = await client.sendMessage(logsMessage);

    expect(logsResponse.success).toBe(true);
    expect(logsResponse.data.filteredLines).toBeLessThan(logsResponse.data.totalLines);
    
    // Check that all returned lines contain "ERROR"
    for (const line of logsResponse.data.lines) {
      expect(line).toContain("ERROR");
    }

    await client.disconnect();
  });

  test("should return error for non-existent process", async () => {
    // Start daemon
    await daemon.start();

    const client = new IPCClient(socketPath);
    await client.connect();

    // Try to get logs for non-existent process
    const logsMessage = createIPCMessage('logs', { 
      identifier: "non-existent-process",
      lines: 100
    });
    const logsResponse = await client.sendMessage(logsMessage);

    expect(logsResponse.success).toBe(false);
    expect(logsResponse.error).toContain("not found");

    await client.disconnect();
  });

  test("should handle empty logs gracefully", async () => {
    // Create a test script that exits immediately without output
    const testScript = join(testDir, "silent-app.js");
    await Bun.write(testScript, `process.exit(0);`);

    // Start daemon
    await daemon.start();

    // Create process config
    const config = createProcessConfig({
      id: "silent-test",
      name: "silent-test",
      script: testScript,
      cwd: testDir,
      env: {},
      instances: 1,
      autorestart: false
    });

    // Start process through daemon
    const client = new IPCClient(socketPath);
    await client.connect();

    const startMessage = createIPCMessage('start', { config });
    const startResponse = await client.sendMessage(startMessage);
    expect(startResponse.success).toBe(true);

    // Wait for process to complete
    await new Promise(resolve => setTimeout(resolve, 200));

    // Get logs
    const logsMessage = createIPCMessage('logs', { 
      identifier: "silent-test",
      lines: 100
    });
    const logsResponse = await client.sendMessage(logsMessage);

    expect(logsResponse.success).toBe(true);
    expect(logsResponse.data.lines).toBeInstanceOf(Array);
    // Empty logs should return empty array, not error
    expect(logsResponse.data.lines.length).toBe(0);

    await client.disconnect();
  });
});

describe("LogManager", () => {
  let testDir: string;
  let logManager: LogManager;

  beforeEach(() => {
    testDir = join(tmpdir(), `log-manager-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    logManager = new LogManager(join(testDir, "logs"));
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test("should capture and retrieve logs", async () => {
    // Create a simple subprocess that outputs text
    const subprocess = Bun.spawn({
      cmd: ["echo", "test log message"],
      stdout: "pipe",
      stderr: "pipe"
    });

    // Capture output
    logManager.captureOutput("test-process", subprocess);

    // Wait for process to complete
    await subprocess.exited;

    // Wait a bit for log capture to complete
    await new Promise(resolve => setTimeout(resolve, 100));

    // Retrieve logs
    const logs = await logManager.getLogs("test-process", 10);
    expect(logs.length).toBeGreaterThan(0);
    
    const logContent = logs.join('\n');
    expect(logContent).toContain("test log message");
  });

  test("should handle log streaming", async () => {
    // Create a subprocess that outputs multiple lines
    const subprocess = Bun.spawn({
      cmd: ["sh", "-c", "echo 'line 1'; sleep 0.1; echo 'line 2'; sleep 0.1; echo 'line 3'"],
      stdout: "pipe",
      stderr: "pipe"
    });

    // Capture output
    logManager.captureOutput("stream-test", subprocess);

    // Wait for process to complete
    await subprocess.exited;

    // Wait for log capture
    await new Promise(resolve => setTimeout(resolve, 200));

    // Test streaming (get first few lines)
    const streamIterator = logManager.streamLogs("stream-test");
    const streamedLines: string[] = [];
    
    // Get first few lines from stream
    let count = 0;
    for await (const line of streamIterator) {
      streamedLines.push(line);
      count++;
      if (count >= 3) break; // Limit to avoid infinite loop in test
    }

    expect(streamedLines.length).toBeGreaterThan(0);
  });
});