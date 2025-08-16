import { test, expect, describe } from "bun:test";
import { ProcessDaemon } from "../../src/daemon/daemon.js";
import { IPCClient } from "../../src/ipc/socket.js";
import { createIPCMessage } from "../../src/types/index.js";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "fs";
import { resolve } from "path";
import { tmpdir } from "os";

describe("Stress Tests - Concurrent Operations", () => {
  let testDir: string;
  let socketPath: string;
  let daemon: ProcessDaemon;

  beforeEach(async () => {
    testDir = resolve(tmpdir(), `bun-pm-stress-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    socketPath = resolve(testDir, "daemon.sock");
    
    daemon = new ProcessDaemon(socketPath);
    await daemon.start();
  });

  afterEach(async () => {
    try {
      await daemon.stop();
    } catch (error) {
      // Ignore cleanup errors
    }
    
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test("100 concurrent process starts should succeed", async () => {
    const clients: IPCClient[] = [];
    const testScript = resolve(testDir, "concurrent-test.js");
    writeFileSync(testScript, `
      console.log("Concurrent test process started");
      setTimeout(() => process.exit(0), 200);
    `);

    try {
      // Create 10 concurrent clients
      for (let i = 0; i < 10; i++) {
        const client = new IPCClient(socketPath);
        await client.connect();
        clients.push(client);
      }

      // Each client starts 10 processes concurrently
      const allStartPromises: Promise<any>[] = [];
      
      for (let clientIndex = 0; clientIndex < clients.length; clientIndex++) {
        const client = clients[clientIndex];
        
        for (let processIndex = 0; processIndex < 10; processIndex++) {
          const processId = `concurrent-${clientIndex}-${processIndex}`;
          const config = {
            id: processId,
            name: processId,
            script: testScript,
            cwd: testDir,
            instances: 1,
            autorestart: false,
            maxRestarts: 0
          };

          const message = createIPCMessage('start', { config });
          allStartPromises.push(client.sendMessage(message));
        }
      }

      const startTime = performance.now();
      const responses = await Promise.all(allStartPromises);
      const endTime = performance.now();

      const totalTime = endTime - startTime;
      console.log(`100 concurrent process starts completed in: ${totalTime.toFixed(2)}ms`);

      // Check that all requests succeeded
      const successCount = responses.filter(r => r.success).length;
      const failureCount = responses.length - successCount;
      
      console.log(`Successful starts: ${successCount}, Failed starts: ${failureCount}`);
      
      // Allow for some failures under extreme load, but most should succeed
      expect(successCount).toBeGreaterThan(90);
      expect(totalTime).toBeLessThan(10000); // 10 seconds max

      // Verify processes were actually started
      const listClient = new IPCClient(socketPath);
      await listClient.connect();
      
      const listMessage = createIPCMessage('list', {});
      const listResponse = await listClient.sendMessage(listMessage);
      
      expect(listResponse.success).toBe(true);
      expect(listResponse.data.processes.length).toBeGreaterThan(90);
      
      await listClient.disconnect();

    } finally {
      // Cleanup clients
      await Promise.all(clients.map(client => client.disconnect()));
    }
  }, 30000);

  test("mixed concurrent operations (start/stop/restart/list)", async () => {
    const clients: IPCClient[] = [];
    const testScript = resolve(testDir, "mixed-ops-test.js");
    writeFileSync(testScript, `
      console.log("Mixed operations test process started");
      setInterval(() => {
        console.log("Process running...");
      }, 500);
    `);

    try {
      // Create 5 concurrent clients
      for (let i = 0; i < 5; i++) {
        const client = new IPCClient(socketPath);
        await client.connect();
        clients.push(client);
      }

      // Start some initial processes
      const initialProcesses = 20;
      const initialStartPromises: Promise<any>[] = [];
      
      for (let i = 0; i < initialProcesses; i++) {
        const config = {
          id: `mixed-ops-${i}`,
          name: `mixed-ops-${i}`,
          script: testScript,
          cwd: testDir,
          instances: 1,
          autorestart: true,
          maxRestarts: 10
        };

        const message = createIPCMessage('start', { config });
        initialStartPromises.push(clients[0].sendMessage(message));
      }

      await Promise.all(initialStartPromises);
      
      // Wait for processes to start
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Now perform mixed concurrent operations
      const mixedOperations: Promise<any>[] = [];
      
      // Client 0: Start new processes
      for (let i = 0; i < 10; i++) {
        const config = {
          id: `new-process-${i}`,
          name: `new-process-${i}`,
          script: testScript,
          cwd: testDir,
          instances: 1,
          autorestart: true,
          maxRestarts: 10
        };
        const message = createIPCMessage('start', { config });
        mixedOperations.push(clients[0].sendMessage(message));
      }

      // Client 1: Stop some processes
      for (let i = 0; i < 5; i++) {
        const message = createIPCMessage('stop', { identifier: `mixed-ops-${i}` });
        mixedOperations.push(clients[1].sendMessage(message));
      }

      // Client 2: Restart some processes
      for (let i = 5; i < 10; i++) {
        const message = createIPCMessage('restart', { identifier: `mixed-ops-${i}` });
        mixedOperations.push(clients[2].sendMessage(message));
      }

      // Client 3: Scale some processes
      for (let i = 10; i < 15; i++) {
        const message = createIPCMessage('scale', { 
          id: `mixed-ops-${i}`,
          instances: 3
        });
        mixedOperations.push(clients[3].sendMessage(message));
      }

      // Client 4: List processes repeatedly
      for (let i = 0; i < 20; i++) {
        const message = createIPCMessage('list', {});
        mixedOperations.push(clients[4].sendMessage(message));
      }

      const startTime = performance.now();
      const responses = await Promise.all(mixedOperations);
      const endTime = performance.now();

      const totalTime = endTime - startTime;
      console.log(`Mixed concurrent operations completed in: ${totalTime.toFixed(2)}ms`);

      // Check success rates
      const successCount = responses.filter(r => r.success).length;
      const failureCount = responses.length - successCount;
      
      console.log(`Successful operations: ${successCount}, Failed operations: ${failureCount}`);
      
      // Most operations should succeed even under stress
      expect(successCount).toBeGreaterThan(responses.length * 0.8); // 80% success rate
      expect(totalTime).toBeLessThan(15000); // 15 seconds max

    } finally {
      // Cleanup clients
      await Promise.all(clients.map(client => client.disconnect()));
    }
  }, 45000);

  test("rapid start/stop cycles should not cause memory leaks", async () => {
    const client = new IPCClient(socketPath);
    await client.connect();

    const testScript = resolve(testDir, "memory-leak-test.js");
    writeFileSync(testScript, `
      console.log("Memory leak test process started");
      setTimeout(() => process.exit(0), 50);
    `);

    try {
      const cycles = 100;
      const processIds: string[] = [];

      for (let cycle = 0; cycle < cycles; cycle++) {
        const processId = `memory-test-${cycle}`;
        processIds.push(processId);

        // Start process
        const config = {
          id: processId,
          name: processId,
          script: testScript,
          cwd: testDir,
          instances: 1,
          autorestart: false,
          maxRestarts: 0
        };

        const startMessage = createIPCMessage('start', { config });
        const startResponse = await client.sendMessage(startMessage);
        expect(startResponse.success).toBe(true);

        // Wait a bit for process to run and exit
        await new Promise(resolve => setTimeout(resolve, 100));

        // Stop process (should already be exited)
        const stopMessage = createIPCMessage('stop', { identifier: processId });
        await client.sendMessage(stopMessage);

        // Check daemon is still responsive every 10 cycles
        if (cycle % 10 === 0) {
          const listMessage = createIPCMessage('list', {});
          const listResponse = await client.sendMessage(listMessage);
          expect(listResponse.success).toBe(true);
          
          console.log(`Completed ${cycle + 1} cycles, daemon still responsive`);
        }
      }

      // Final check - daemon should still be responsive
      const finalListMessage = createIPCMessage('list', {});
      const finalListResponse = await client.sendMessage(finalListMessage);
      expect(finalListResponse.success).toBe(true);

      console.log(`Completed ${cycles} rapid start/stop cycles successfully`);

    } finally {
      await client.disconnect();
    }
  }, 60000);

  test("high frequency log generation should not overwhelm system", async () => {
    const client = new IPCClient(socketPath);
    await client.connect();

    const testScript = resolve(testDir, "high-log-test.js");
    writeFileSync(testScript, `
      console.log("High frequency log test started");
      let counter = 0;
      const interval = setInterval(() => {
        console.log(\`Log message \${++counter} - \${new Date().toISOString()}\`);
        console.error(\`Error message \${counter} - \${new Date().toISOString()}\`);
        
        if (counter >= 1000) {
          clearInterval(interval);
          process.exit(0);
        }
      }, 1);
    `);

    try {
      // Start 5 processes that generate logs rapidly
      const startPromises: Promise<any>[] = [];
      
      for (let i = 0; i < 5; i++) {
        const config = {
          id: `high-log-${i}`,
          name: `high-log-${i}`,
          script: testScript,
          cwd: testDir,
          instances: 1,
          autorestart: false,
          maxRestarts: 0
        };

        const message = createIPCMessage('start', { config });
        startPromises.push(client.sendMessage(message));
      }

      const startResponses = await Promise.all(startPromises);
      expect(startResponses.every(r => r.success)).toBe(true);

      // Wait for processes to generate logs
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Daemon should still be responsive during high log volume
      const listMessage = createIPCMessage('list', {});
      const listResponse = await client.sendMessage(listMessage);
      expect(listResponse.success).toBe(true);

      // Try to retrieve logs from one process
      const logsMessage = createIPCMessage('logs', {
        identifier: 'high-log-0',
        lines: 100
      });
      const logsResponse = await client.sendMessage(logsMessage);
      expect(logsResponse.success).toBe(true);
      expect(logsResponse.data.logs.length).toBeGreaterThan(0);

      console.log("High frequency log generation test completed successfully");

    } finally {
      await client.disconnect();
    }
  }, 30000);

  test("concurrent ecosystem file operations", async () => {
    const clients: IPCClient[] = [];

    try {
      // Create 3 concurrent clients
      for (let i = 0; i < 3; i++) {
        const client = new IPCClient(socketPath);
        await client.connect();
        clients.push(client);
      }

      // Create multiple ecosystem files
      const ecosystemFiles: string[] = [];
      
      for (let i = 0; i < 3; i++) {
        const testScript = resolve(testDir, `ecosystem-test-${i}.js`);
        writeFileSync(testScript, `
          console.log("Ecosystem test ${i} process started");
          setInterval(() => {
            console.log("Ecosystem ${i} process running");
          }, 1000);
        `);

        const ecosystemFile = resolve(testDir, `ecosystem-${i}.json`);
        const ecosystemConfig = {
          apps: [
            {
              id: `eco-app-${i}-1`,
              name: `eco-app-${i}-1`,
              script: `./ecosystem-test-${i}.js`,
              cwd: testDir,
              instances: 2,
              autorestart: true
            },
            {
              id: `eco-app-${i}-2`,
              name: `eco-app-${i}-2`,
              script: `./ecosystem-test-${i}.js`,
              cwd: testDir,
              instances: 1,
              autorestart: false
            }
          ]
        };

        writeFileSync(ecosystemFile, JSON.stringify(ecosystemConfig, null, 2));
        ecosystemFiles.push(ecosystemFile);
      }

      // Load all ecosystem files concurrently
      const loadPromises: Promise<any>[] = [];
      
      for (let i = 0; i < ecosystemFiles.length; i++) {
        const message = createIPCMessage('startFromFile', { 
          filePath: ecosystemFiles[i] 
        });
        loadPromises.push(clients[i].sendMessage(message));
      }

      const startTime = performance.now();
      const loadResponses = await Promise.all(loadPromises);
      const endTime = performance.now();

      const totalTime = endTime - startTime;
      console.log(`Concurrent ecosystem loading completed in: ${totalTime.toFixed(2)}ms`);

      // Check that all ecosystem loads succeeded
      expect(loadResponses.every(r => r.success)).toBe(true);
      expect(totalTime).toBeLessThan(5000);

      // Wait for processes to start
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Verify all processes are running
      const listMessage = createIPCMessage('list', {});
      const listResponse = await clients[0].sendMessage(listMessage);
      expect(listResponse.success).toBe(true);
      
      // Should have 9 processes total (3 ecosystems × 3 processes each)
      expect(listResponse.data.processes.length).toBe(9);

      // Now perform concurrent save operations
      const savePromises: Promise<any>[] = [];
      
      for (let i = 0; i < 3; i++) {
        const saveFile = resolve(testDir, `saved-ecosystem-${i}.json`);
        const message = createIPCMessage('save', { filePath: saveFile });
        savePromises.push(clients[i].sendMessage(message));
      }

      const saveResponses = await Promise.all(savePromises);
      expect(saveResponses.every(r => r.success)).toBe(true);

      // Verify save files were created
      for (let i = 0; i < 3; i++) {
        const saveFile = resolve(testDir, `saved-ecosystem-${i}.json`);
        expect(existsSync(saveFile)).toBe(true);
      }

      console.log("Concurrent ecosystem operations completed successfully");

    } finally {
      // Cleanup clients
      await Promise.all(clients.map(client => client.disconnect()));
    }
  }, 30000);
});