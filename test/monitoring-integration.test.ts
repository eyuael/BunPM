import { test, expect } from "bun:test";
import { ProcessDaemon } from "../src/daemon/daemon.js";
import { IPCClient } from "../src/ipc/socket.js";
import { createIPCMessage, createProcessConfig } from "../src/types/index.js";
import { mkdirSync, rmSync, existsSync } from "fs";
import { resolve } from "path";

test("Monitoring Integration - monit and show commands", async () => {
  const testDir = `/tmp/bun-pm-monitoring-test-${Date.now()}`;
  const socketPath = resolve(testDir, "test.sock");

  // Create test directory
  mkdirSync(testDir, { recursive: true });

  const daemon = new ProcessDaemon(socketPath);
  
  try {
    // Start daemon
    await daemon.start();

    // Create a simple test script
    const testScript = resolve(testDir, "test-app.js");
    await Bun.write(testScript, `
      console.log("Test app started");
      setInterval(() => {
        console.log("Test app running...");
      }, 1000);
    `);

    const client = new IPCClient(socketPath);
    await client.connect();

    // Start a test process
    const config = createProcessConfig({
      id: "monitoring-test",
      name: "monitoring-test",
      script: testScript,
      cwd: testDir,
      memoryLimit: 100 * 1024 * 1024 // 100MB
    });

    const startMessage = createIPCMessage('start', { config });
    const startResponse = await client.sendMessage(startMessage);
    expect(startResponse.success).toBe(true);

    // Wait a moment for the process to start and monitoring to begin
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Test monit command
    const monitMessage = createIPCMessage('monit', {});
    const monitResponse = await client.sendMessage(monitMessage);
    expect(monitResponse.success).toBe(true);
    expect(monitResponse.data.processes).toBeDefined();
    expect(monitResponse.data.systemInfo).toBeDefined();
    
    const processes = monitResponse.data.processes;
    expect(processes.length).toBeGreaterThan(0);
    
    const testProcess = processes.find((p: any) => p.name === "monitoring-test");
    expect(testProcess).toBeDefined();
    expect(testProcess.metrics).toBeDefined();
    expect(typeof testProcess.metrics.cpu).toBe("number");
    expect(typeof testProcess.metrics.memory).toBe("number");
    expect(typeof testProcess.metrics.uptime).toBe("number");
    expect(typeof testProcess.metrics.restarts).toBe("number");

    // Test show command
    const showMessage = createIPCMessage('show', { identifier: "monitoring-test" });
    const showResponse = await client.sendMessage(showMessage);
    expect(showResponse.success).toBe(true);
    expect(showResponse.data.process).toBeDefined();
    expect(showResponse.data.metrics).toBeDefined();
    expect(showResponse.data.history).toBeDefined();

    const processInfo = showResponse.data.process;
    expect(processInfo.name).toBe("monitoring-test");
    expect(processInfo.memoryLimit).toBe(100 * 1024 * 1024);

    // Stop the process
    const stopMessage = createIPCMessage('stop', { identifier: "monitoring-test" });
    const stopResponse = await client.sendMessage(stopMessage);
    expect(stopResponse.success).toBe(true);

    await client.disconnect();
  } finally {
    await daemon.stop();
    
    // Clean up test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  }
}, 10000); // 10 second timeout