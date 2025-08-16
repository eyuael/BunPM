import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { ProcessDaemon } from "../../src/daemon/daemon.js";
import { IPCClient } from "../../src/ipc/socket.js";
import { createIPCMessage } from "../../src/types/index.js";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "fs";
import { resolve } from "path";
import { tmpdir } from "os";

describe("Performance Tests - Process Management", () => {
  let testDir: string;
  let socketPath: string;
  let daemon: ProcessDaemon;
  let client: IPCClient;

  beforeEach(async () => {
    testDir = resolve(tmpdir(), `bun-pm-process-perf-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    socketPath = resolve(testDir, "daemon.sock");
    
    daemon = new ProcessDaemon(socketPath);
    await daemon.start();
    
    client = new IPCClient(socketPath);
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

  test("starting 50 processes should complete within 5 seconds", async () => {
    const testScript = resolve(testDir, "batch-test.js");
    writeFileSync(testScript, `
      console.log("Batch test process started");
      setTimeout(() => process.exit(0), 100);
    `);

    const startTime = performance.now();
    const startPromises: Promise<any>[] = [];

    // Start 50 processes concurrently
    for (let i = 0; i < 50; i++) {
      const config = {
        id: `batch-test-${i}`,
        name: `batch-test-${i}`,
        script: testScript,
        cwd: testDir,
        instances: 1,
        autorestart: false,
        maxRestarts: 0
      };

      const message = createIPCMessage('start', { config });
      startPromises.push(client.sendMessage(message));
    }

    const responses = await Promise.all(startPromises);
    const endTime = performance.now();

    const totalTime = endTime - startTime;
    console.log(`Started 50 processes in: ${totalTime.toFixed(2)}ms`);

    expect(totalTime).toBeLessThan(5000);
    expect(responses.every(r => r.success)).toBe(true);

    // Verify all processes were started
    const listMessage = createIPCMessage('list', {});
    const listResponse = await client.sendMessage(listMessage);
    expect(listResponse.success).toBe(true);
    expect(listResponse.data.processes).toHaveLength(50);
  }, 10000);

  test("stopping 50 processes should complete within 2 seconds", async () => {
    const testScript = resolve(testDir, "stop-test.js");
    writeFileSync(testScript, `
      console.log("Stop test process started");
      setInterval(() => {
        console.log("Running...");
      }, 1000);
    `);

    // Start 50 processes first
    const startPromises: Promise<any>[] = [];
    for (let i = 0; i < 50; i++) {
      const config = {
        id: `stop-test-${i}`,
        name: `stop-test-${i}`,
        script: testScript,
        cwd: testDir,
        instances: 1,
        autorestart: false,
        maxRestarts: 0
      };

      const message = createIPCMessage('start', { config });
      startPromises.push(client.sendMessage(message));
    }

    await Promise.all(startPromises);
    
    // Wait for processes to start
    await new Promise(resolve => setTimeout(resolve, 500));

    // Now stop all processes
    const startTime = performance.now();
    const stopPromises: Promise<any>[] = [];

    for (let i = 0; i < 50; i++) {
      const message = createIPCMessage('stop', { identifier: `stop-test-${i}` });
      stopPromises.push(client.sendMessage(message));
    }

    const responses = await Promise.all(stopPromises);
    const endTime = performance.now();

    const totalTime = endTime - startTime;
    console.log(`Stopped 50 processes in: ${totalTime.toFixed(2)}ms`);

    expect(totalTime).toBeLessThan(2000);
    expect(responses.every(r => r.success)).toBe(true);

    // Verify all processes were stopped
    await new Promise(resolve => setTimeout(resolve, 200));
    const listMessage = createIPCMessage('list', {});
    const listResponse = await client.sendMessage(listMessage);
    expect(listResponse.success).toBe(true);
    expect(listResponse.data.processes).toHaveLength(0);
  }, 15000);

  test("scaling process from 1 to 20 instances should complete within 1 second", async () => {
    const testScript = resolve(testDir, "scale-test.js");
    writeFileSync(testScript, `
      console.log("Scale test process started");
      setInterval(() => {
        console.log("Running...");
      }, 2000);
    `);

    // Start initial process
    const config = {
      id: "scale-perf-test",
      name: "scale-perf-test",
      script: testScript,
      cwd: testDir,
      instances: 1,
      autorestart: true,
      maxRestarts: 10
    };

    const startMessage = createIPCMessage('start', { config });
    const startResponse = await client.sendMessage(startMessage);
    expect(startResponse.success).toBe(true);

    // Wait for initial process to start
    await new Promise(resolve => setTimeout(resolve, 200));

    // Scale to 20 instances
    const scaleMessage = createIPCMessage('scale', {
      id: 'scale-perf-test',
      instances: 20
    });

    const startTime = performance.now();
    const scaleResponse = await client.sendMessage(scaleMessage);
    const endTime = performance.now();

    const scaleTime = endTime - startTime;
    console.log(`Scaled to 20 instances in: ${scaleTime.toFixed(2)}ms`);

    expect(scaleTime).toBeLessThan(1000);
    expect(scaleResponse.success).toBe(true);
    expect(scaleResponse.data.instances).toHaveLength(20);

    // Verify all instances are running
    const listMessage = createIPCMessage('list', {});
    const listResponse = await client.sendMessage(listMessage);
    expect(listResponse.success).toBe(true);
    
    const scaleProcesses = listResponse.data.processes.filter((p: any) => 
      p.id.startsWith('scale-perf-test')
    );
    expect(scaleProcesses).toHaveLength(20);
  }, 10000);

  test("restarting 20 processes should complete within 3 seconds", async () => {
    const testScript = resolve(testDir, "restart-test.js");
    writeFileSync(testScript, `
      console.log("Restart test process started");
      setInterval(() => {
        console.log("Running...");
      }, 1000);
    `);

    // Start 20 processes
    const startPromises: Promise<any>[] = [];
    for (let i = 0; i < 20; i++) {
      const config = {
        id: `restart-test-${i}`,
        name: `restart-test-${i}`,
        script: testScript,
        cwd: testDir,
        instances: 1,
        autorestart: true,
        maxRestarts: 10
      };

      const message = createIPCMessage('start', { config });
      startPromises.push(client.sendMessage(message));
    }

    await Promise.all(startPromises);
    
    // Wait for processes to start
    await new Promise(resolve => setTimeout(resolve, 500));

    // Restart all processes
    const startTime = performance.now();
    const restartPromises: Promise<any>[] = [];

    for (let i = 0; i < 20; i++) {
      const message = createIPCMessage('restart', { identifier: `restart-test-${i}` });
      restartPromises.push(client.sendMessage(message));
    }

    const responses = await Promise.all(restartPromises);
    const endTime = performance.now();

    const totalTime = endTime - startTime;
    console.log(`Restarted 20 processes in: ${totalTime.toFixed(2)}ms`);

    expect(totalTime).toBeLessThan(3000);
    expect(responses.every(r => r.success)).toBe(true);

    // Verify all processes are still running
    await new Promise(resolve => setTimeout(resolve, 500));
    const listMessage = createIPCMessage('list', {});
    const listResponse = await client.sendMessage(listMessage);
    expect(listResponse.success).toBe(true);
    expect(listResponse.data.processes).toHaveLength(20);
  }, 15000);

  test("log retrieval for 10 processes should complete within 500ms", async () => {
    const testScript = resolve(testDir, "log-test.js");
    writeFileSync(testScript, `
      console.log("Log test process started");
      for (let i = 0; i < 100; i++) {
        console.log(\`Log message \${i} from process\`);
      }
      setInterval(() => {
        console.log("Periodic log message");
      }, 100);
    `);

    // Start 10 processes
    const startPromises: Promise<any>[] = [];
    for (let i = 0; i < 10; i++) {
      const config = {
        id: `log-test-${i}`,
        name: `log-test-${i}`,
        script: testScript,
        cwd: testDir,
        instances: 1,
        autorestart: true,
        maxRestarts: 10
      };

      const message = createIPCMessage('start', { config });
      startPromises.push(client.sendMessage(message));
    }

    await Promise.all(startPromises);
    
    // Wait for processes to generate logs
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Retrieve logs from all processes
    const startTime = performance.now();
    const logPromises: Promise<any>[] = [];

    for (let i = 0; i < 10; i++) {
      const message = createIPCMessage('logs', { 
        identifier: `log-test-${i}`,
        lines: 50
      });
      logPromises.push(client.sendMessage(message));
    }

    const responses = await Promise.all(logPromises);
    const endTime = performance.now();

    const totalTime = endTime - startTime;
    console.log(`Retrieved logs from 10 processes in: ${totalTime.toFixed(2)}ms`);

    expect(totalTime).toBeLessThan(500);
    expect(responses.every(r => r.success)).toBe(true);
    expect(responses.every(r => r.data.logs.length > 0)).toBe(true);
  }, 10000);

  test("monitoring data collection for 25 processes should complete within 1 second", async () => {
    const testScript = resolve(testDir, "monitor-test.js");
    writeFileSync(testScript, `
      console.log("Monitor test process started");
      // Create some CPU load
      setInterval(() => {
        let sum = 0;
        for (let i = 0; i < 100000; i++) {
          sum += Math.random();
        }
      }, 100);
    `);

    // Start 25 processes
    const startPromises: Promise<any>[] = [];
    for (let i = 0; i < 25; i++) {
      const config = {
        id: `monitor-test-${i}`,
        name: `monitor-test-${i}`,
        script: testScript,
        cwd: testDir,
        instances: 1,
        autorestart: true,
        maxRestarts: 10
      };

      const message = createIPCMessage('start', { config });
      startPromises.push(client.sendMessage(message));
    }

    await Promise.all(startPromises);
    
    // Wait for processes to start and generate metrics
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Collect monitoring data
    const startTime = performance.now();
    const monitMessage = createIPCMessage('monit', {});
    const monitResponse = await client.sendMessage(monitMessage);
    const endTime = performance.now();

    const monitoringTime = endTime - startTime;
    console.log(`Collected monitoring data for 25 processes in: ${monitoringTime.toFixed(2)}ms`);

    expect(monitoringTime).toBeLessThan(1000);
    expect(monitResponse.success).toBe(true);
    expect(monitResponse.data.processes).toHaveLength(25);
    
    // Verify all processes have metrics
    const processes = monitResponse.data.processes;
    expect(processes.every((p: any) => p.metrics && typeof p.metrics.cpu === 'number')).toBe(true);
    expect(processes.every((p: any) => p.metrics && typeof p.metrics.memory === 'number')).toBe(true);
  }, 15000);
});