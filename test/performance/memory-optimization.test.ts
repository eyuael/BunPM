import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { ProcessDaemon } from "../../src/daemon/daemon.js";
import { IPCClient } from "../../src/ipc/socket.js";
import { createIPCMessage } from "../../src/types/index.js";
import { CircularBuffer, MemoryTracker, StringPool } from "../../src/core/memory-optimizer.js";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "fs";
import { resolve } from "path";
import { tmpdir } from "os";

describe("Performance Tests - Memory Optimization", () => {
  let testDir: string;
  let socketPath: string;

  beforeEach(() => {
    testDir = resolve(tmpdir(), `bun-pm-memory-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    socketPath = resolve(testDir, "daemon.sock");
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test("CircularBuffer should maintain constant memory usage", () => {
    const buffer = new CircularBuffer<number>(100);
    
    // Fill buffer beyond capacity
    for (let i = 0; i < 200; i++) {
      buffer.push(i);
    }
    
    expect(buffer.getSize()).toBe(100);
    expect(buffer.getCapacity()).toBe(100);
    
    // Should contain the last 100 items
    const items = buffer.toArray();
    expect(items).toHaveLength(100);
    expect(items[0]).toBe(100); // First item should be 100 (items 0-99 were overwritten)
    expect(items[99]).toBe(199); // Last item should be 199
  });

  test("StringPool should reduce memory usage for duplicate strings", () => {
    const pool = new StringPool(50);
    
    const str1 = "test-process-name";
    const str2 = "test-process-name"; // Same content, different object
    
    const interned1 = pool.intern(str1);
    const interned2 = pool.intern(str2);
    
    // Should return the same object reference
    expect(interned1).toBe(interned2);
    expect(pool.getSize()).toBe(1);
  });

  test("MemoryTracker should monitor daemon memory usage", () => {
    const tracker = new MemoryTracker(10);
    
    // Record some measurements
    tracker.recordMeasurement();
    
    // Simulate memory usage
    const largeArray = new Array(10000).fill("memory test");
    tracker.recordMeasurement();
    
    const stats = tracker.getMemoryStats();
    expect(stats).not.toBeNull();
    expect(stats!.current.heapUsed).toBeGreaterThan(0);
    expect(stats!.measurements).toBe(2);
    
    // Clean up
    largeArray.length = 0;
  });

  test("daemon memory usage should remain stable under load", async () => {
    const daemon = new ProcessDaemon(socketPath);
    await daemon.start();
    
    const client = new IPCClient(socketPath);
    await client.connect();
    
    // Record initial memory
    const initialMemory = process.memoryUsage();
    
    // Create and start many processes
    const processCount = 50;
    const processes: string[] = [];
    
    for (let i = 0; i < processCount; i++) {
      const testScript = resolve(testDir, `memory-load-test-${i}.js`);
      writeFileSync(testScript, `
        console.log("Memory load test ${i}");
        let counter = 0;
        setInterval(() => {
          console.log(\`Process ${i} tick \${counter++}\`);
        }, 1000);
      `);
      
      const config = {
        id: `memory-load-test-${i}`,
        name: `memory-load-test-${i}`,
        script: testScript,
        cwd: testDir,
        instances: 1,
        autorestart: true,
        maxRestarts: 10
      };
      
      const message = createIPCMessage('start', { config });
      const response = await client.sendMessage(message);
      expect(response.success).toBe(true);
      processes.push(config.id);
    }
    
    // Wait for processes to start and generate logs
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Perform various operations to stress the system
    for (let i = 0; i < 10; i++) {
      // List processes
      const listMessage = createIPCMessage('list', {});
      await client.sendMessage(listMessage);
      
      // Get logs from random processes
      const randomProcess = processes[Math.floor(Math.random() * processes.length)];
      const logsMessage = createIPCMessage('logs', { 
        identifier: randomProcess, 
        lines: 100 
      });
      await client.sendMessage(logsMessage);
      
      // Get monitoring data
      const monitMessage = createIPCMessage('monit', {});
      await client.sendMessage(monitMessage);
    }
    
    // Record final memory
    const finalMemory = process.memoryUsage();
    
    // Memory growth should be reasonable (less than 100MB)
    const memoryGrowth = finalMemory.rss - initialMemory.rss;
    const memoryGrowthMB = memoryGrowth / 1024 / 1024;
    
    console.log(`Memory growth: ${memoryGrowthMB.toFixed(2)}MB`);
    console.log(`Initial RSS: ${(initialMemory.rss / 1024 / 1024).toFixed(2)}MB`);
    console.log(`Final RSS: ${(finalMemory.rss / 1024 / 1024).toFixed(2)}MB`);
    
    expect(memoryGrowthMB).toBeLessThan(100);
    
    // Cleanup
    await client.disconnect();
    await daemon.stop();
  }, 30000);

  test("log manager memory optimization should prevent memory leaks", async () => {
    const daemon = new ProcessDaemon(socketPath);
    await daemon.start();
    
    const client = new IPCClient(socketPath);
    await client.connect();
    
    // Create a process that generates lots of logs
    const testScript = resolve(testDir, "log-spam-test.js");
    writeFileSync(testScript, `
      console.log("Log spam test started");
      let counter = 0;
      const interval = setInterval(() => {
        console.log(\`Log message \${counter++} - \${new Date().toISOString()}\`);
        console.error(\`Error message \${counter} - \${new Date().toISOString()}\`);
        
        if (counter > 1000) {
          clearInterval(interval);
          process.exit(0);
        }
      }, 10);
    `);
    
    const config = {
      id: "log-spam-test",
      name: "log-spam-test", 
      script: testScript,
      cwd: testDir,
      instances: 1,
      autorestart: false,
      maxRestarts: 0
    };
    
    const startMessage = createIPCMessage('start', { config });
    const startResponse = await client.sendMessage(startMessage);
    expect(startResponse.success).toBe(true);
    
    // Wait for process to generate logs
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Repeatedly request logs to test memory efficiency
    const initialMemory = process.memoryUsage();
    
    for (let i = 0; i < 20; i++) {
      const logsMessage = createIPCMessage('logs', { 
        identifier: "log-spam-test", 
        lines: 500 
      });
      const response = await client.sendMessage(logsMessage);
      expect(response.success).toBe(true);
    }
    
    const finalMemory = process.memoryUsage();
    const memoryGrowth = finalMemory.heapUsed - initialMemory.heapUsed;
    const memoryGrowthMB = memoryGrowth / 1024 / 1024;
    
    console.log(`Log retrieval memory growth: ${memoryGrowthMB.toFixed(2)}MB`);
    
    // Memory growth should be minimal (less than 10MB)
    expect(memoryGrowthMB).toBeLessThan(10);
    
    await client.disconnect();
    await daemon.stop();
  }, 20000);

  test("IPC connection pool should handle connection cleanup", async () => {
    const daemon = new ProcessDaemon(socketPath);
    await daemon.start();
    
    const clients: IPCClient[] = [];
    
    // Create many connections
    for (let i = 0; i < 20; i++) {
      const client = new IPCClient(socketPath);
      await client.connect();
      clients.push(client);
    }
    
    // Send messages from all clients
    const messagePromises = clients.map(async (client, index) => {
      const message = createIPCMessage('list', {});
      return client.sendMessage(message);
    });
    
    const responses = await Promise.all(messagePromises);
    expect(responses.every(r => r.success)).toBe(true);
    
    // Disconnect half the clients
    for (let i = 0; i < 10; i++) {
      await clients[i].disconnect();
    }
    
    // Wait for cleanup
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Remaining clients should still work
    const remainingClients = clients.slice(10);
    const finalMessages = remainingClients.map(client => {
      const message = createIPCMessage('status', {});
      return client.sendMessage(message);
    });
    
    const finalResponses = await Promise.all(finalMessages);
    expect(finalResponses.every(r => r.success)).toBe(true);
    
    // Cleanup remaining clients
    await Promise.all(remainingClients.map(client => client.disconnect()));
    await daemon.stop();
  }, 15000);

  test("monitoring system should use optimized data structures", async () => {
    const daemon = new ProcessDaemon(socketPath);
    await daemon.start();
    
    const client = new IPCClient(socketPath);
    await client.connect();
    
    // Start processes for monitoring
    const processCount = 10;
    for (let i = 0; i < processCount; i++) {
      const testScript = resolve(testDir, `monitor-opt-test-${i}.js`);
      writeFileSync(testScript, `
        console.log("Monitor optimization test ${i}");
        setInterval(() => {
          // Create some CPU load
          let sum = 0;
          for (let j = 0; j < 100000; j++) {
            sum += Math.random();
          }
        }, 1000);
      `);
      
      const config = {
        id: `monitor-opt-test-${i}`,
        name: `monitor-opt-test-${i}`,
        script: testScript,
        cwd: testDir,
        instances: 1,
        autorestart: true,
        maxRestarts: 10
      };
      
      const message = createIPCMessage('start', { config });
      await client.sendMessage(message);
    }
    
    // Wait for monitoring data to accumulate
    await new Promise(resolve => setTimeout(resolve, 10000));
    
    // Collect monitoring data multiple times
    const initialMemory = process.memoryUsage();
    
    for (let i = 0; i < 50; i++) {
      const monitMessage = createIPCMessage('monit', {});
      const response = await client.sendMessage(monitMessage);
      expect(response.success).toBe(true);
      expect(response.data.processes).toHaveLength(processCount);
    }
    
    const finalMemory = process.memoryUsage();
    const memoryGrowth = finalMemory.heapUsed - initialMemory.heapUsed;
    const memoryGrowthMB = memoryGrowth / 1024 / 1024;
    
    console.log(`Monitoring data collection memory growth: ${memoryGrowthMB.toFixed(2)}MB`);
    
    // Memory growth should be minimal
    expect(memoryGrowthMB).toBeLessThan(5);
    
    await client.disconnect();
    await daemon.stop();
  }, 25000);
});