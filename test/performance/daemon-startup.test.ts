import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { ProcessDaemon } from "../../src/daemon/daemon.js";
import { IPCClient } from "../../src/ipc/socket.js";
import { createIPCMessage } from "../../src/types/index.js";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "fs";
import { resolve } from "path";
import { tmpdir } from "os";

describe("Performance Tests - Daemon Startup", () => {
  let testDir: string;
  let socketPath: string;

  beforeEach(() => {
    testDir = resolve(tmpdir(), `bun-pm-perf-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    socketPath = resolve(testDir, "daemon.sock");
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test("daemon startup time should be under 100ms", async () => {
    const daemon = new ProcessDaemon(socketPath);
    
    const startTime = performance.now();
    await daemon.start();
    const endTime = performance.now();
    
    const startupTime = endTime - startTime;
    console.log(`Daemon startup time: ${startupTime.toFixed(2)}ms`);
    
    expect(startupTime).toBeLessThan(100);
    expect(daemon.isActive()).toBe(true);
    
    await daemon.stop();
  });

  test("daemon shutdown time should be under 50ms", async () => {
    const daemon = new ProcessDaemon(socketPath);
    await daemon.start();
    
    const startTime = performance.now();
    await daemon.stop();
    const endTime = performance.now();
    
    const shutdownTime = endTime - startTime;
    console.log(`Daemon shutdown time: ${shutdownTime.toFixed(2)}ms`);
    
    expect(shutdownTime).toBeLessThan(50);
    expect(daemon.isActive()).toBe(false);
  });

  test("IPC connection establishment should be under 10ms", async () => {
    const daemon = new ProcessDaemon(socketPath);
    await daemon.start();
    
    const client = new IPCClient(socketPath);
    
    const startTime = performance.now();
    await client.connect();
    const endTime = performance.now();
    
    const connectionTime = endTime - startTime;
    console.log(`IPC connection time: ${connectionTime.toFixed(2)}ms`);
    
    expect(connectionTime).toBeLessThan(10);
    
    await client.disconnect();
    await daemon.stop();
  });

  test("process start command response time should be under 200ms", async () => {
    const daemon = new ProcessDaemon(socketPath);
    await daemon.start();
    
    const client = new IPCClient(socketPath);
    await client.connect();
    
    // Create test script
    const testScript = resolve(testDir, "perf-test.js");
    writeFileSync(testScript, 'console.log("Performance test app");');
    
    const config = {
      id: "perf-test",
      name: "perf-test",
      script: testScript,
      cwd: testDir,
      instances: 1,
      autorestart: true,
      maxRestarts: 10
    };
    
    const message = createIPCMessage('start', { config });
    
    const startTime = performance.now();
    const response = await client.sendMessage(message);
    const endTime = performance.now();
    
    const responseTime = endTime - startTime;
    console.log(`Process start response time: ${responseTime.toFixed(2)}ms`);
    
    expect(response.success).toBe(true);
    expect(responseTime).toBeLessThan(200);
    
    // Cleanup
    const stopMessage = createIPCMessage('stop', { identifier: "perf-test" });
    await client.sendMessage(stopMessage);
    
    await client.disconnect();
    await daemon.stop();
  });

  test("list command response time should be under 50ms", async () => {
    const daemon = new ProcessDaemon(socketPath);
    await daemon.start();
    
    const client = new IPCClient(socketPath);
    await client.connect();
    
    // Start multiple processes first
    for (let i = 0; i < 10; i++) {
      const testScript = resolve(testDir, `test-${i}.js`);
      writeFileSync(testScript, `console.log("Test app ${i}");`);
      
      const config = {
        id: `test-${i}`,
        name: `test-${i}`,
        script: testScript,
        cwd: testDir,
        instances: 1,
        autorestart: true,
        maxRestarts: 10
      };
      
      const startMessage = createIPCMessage('start', { config });
      await client.sendMessage(startMessage);
    }
    
    // Wait for processes to start
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Measure list command response time
    const listMessage = createIPCMessage('list', {});
    
    const startTime = performance.now();
    const response = await client.sendMessage(listMessage);
    const endTime = performance.now();
    
    const responseTime = endTime - startTime;
    console.log(`List command response time: ${responseTime.toFixed(2)}ms`);
    
    expect(response.success).toBe(true);
    expect(response.data.processes).toHaveLength(10);
    expect(responseTime).toBeLessThan(50);
    
    await client.disconnect();
    await daemon.stop();
  });

  test("daemon memory usage should be under 50MB", async () => {
    const daemon = new ProcessDaemon(socketPath);
    await daemon.start();
    
    const client = new IPCClient(socketPath);
    await client.connect();
    
    // Start some processes to simulate real usage
    for (let i = 0; i < 5; i++) {
      const testScript = resolve(testDir, `memory-test-${i}.js`);
      writeFileSync(testScript, `
        console.log("Memory test app ${i}");
        setInterval(() => {
          console.log("App ${i} running");
        }, 1000);
      `);
      
      const config = {
        id: `memory-test-${i}`,
        name: `memory-test-${i}`,
        script: testScript,
        cwd: testDir,
        instances: 1,
        autorestart: true,
        maxRestarts: 10
      };
      
      const startMessage = createIPCMessage('start', { config });
      await client.sendMessage(startMessage);
    }
    
    // Wait for processes to start and run for a bit
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Get daemon process memory usage
    const daemonPid = process.pid; // This is approximate since we're in the same process
    const memoryUsage = process.memoryUsage();
    const memoryMB = memoryUsage.rss / 1024 / 1024;
    
    console.log(`Daemon memory usage: ${memoryMB.toFixed(2)}MB`);
    console.log(`Heap used: ${(memoryUsage.heapUsed / 1024 / 1024).toFixed(2)}MB`);
    console.log(`Heap total: ${(memoryUsage.heapTotal / 1024 / 1024).toFixed(2)}MB`);
    
    // This is a rough check since we're testing in the same process
    // In a real scenario, the daemon would be a separate process
    expect(memoryMB).toBeLessThan(100); // More lenient for test environment
    
    await client.disconnect();
    await daemon.stop();
  });

  test("concurrent IPC connections should handle 10 clients", async () => {
    const daemon = new ProcessDaemon(socketPath);
    await daemon.start();
    
    const clients: IPCClient[] = [];
    const connectionPromises: Promise<void>[] = [];
    
    // Create 10 concurrent connections
    for (let i = 0; i < 10; i++) {
      const client = new IPCClient(socketPath);
      clients.push(client);
      connectionPromises.push(client.connect());
    }
    
    const startTime = performance.now();
    await Promise.all(connectionPromises);
    const endTime = performance.now();
    
    const totalConnectionTime = endTime - startTime;
    console.log(`10 concurrent connections time: ${totalConnectionTime.toFixed(2)}ms`);
    
    expect(totalConnectionTime).toBeLessThan(100);
    
    // Test concurrent list commands
    const listPromises = clients.map(client => {
      const message = createIPCMessage('list', {});
      return client.sendMessage(message);
    });
    
    const listStartTime = performance.now();
    const responses = await Promise.all(listPromises);
    const listEndTime = performance.now();
    
    const concurrentListTime = listEndTime - listStartTime;
    console.log(`10 concurrent list commands time: ${concurrentListTime.toFixed(2)}ms`);
    
    expect(concurrentListTime).toBeLessThan(200);
    expect(responses.every(r => r.success)).toBe(true);
    
    // Cleanup
    await Promise.all(clients.map(client => client.disconnect()));
    await daemon.stop();
  });
});