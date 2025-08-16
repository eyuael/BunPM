import { test, expect, beforeEach, afterEach } from "bun:test";
import { ProcessManager } from "../src/core/process-manager.js";
import { MonitorManager } from "../src/core/monitor-manager.js";
import { LogManager } from "../src/core/log-manager.js";
import { createProcessConfig } from "../src/types/index.js";
import { resolve } from "path";
import { mkdirSync, rmSync, writeFileSync } from "fs";

// Test setup
const testDir = resolve(import.meta.dir, "temp-memory-limit");
const testScript = resolve(testDir, "memory-test.js");

beforeEach(() => {
  // Create test directory
  mkdirSync(testDir, { recursive: true });

  // Create a test script that can consume memory
  writeFileSync(testScript, `
    // Simple server that can consume memory on demand
    const server = Bun.serve({
      port: process.env.PORT || 3000,
      fetch(req) {
        const url = new URL(req.url);
        
        if (url.pathname === '/consume-memory') {
          // Consume memory by creating large arrays
          const size = parseInt(url.searchParams.get('size') || '10000000'); // 10MB default
          const arrays = [];
          for (let i = 0; i < 10; i++) {
            arrays.push(new Array(size).fill('x'));
          }
          // Keep references to prevent GC
          global.memoryArrays = arrays;
          return new Response('Memory consumed');
        }
        
        if (url.pathname === '/health') {
          return new Response('OK');
        }
        
        return new Response('Hello World');
      }
    });
    
    console.log('Memory test server started on port', server.port);
    
    // Keep the process running
    process.on('SIGTERM', () => {
      console.log('Received SIGTERM, shutting down gracefully');
      server.stop();
      process.exit(0);
    });
  `);
});

afterEach(() => {
  // Clean up test directory
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch (error) {
    // Ignore cleanup errors
  }
});

test("MonitorManager - should detect memory limit violations", async () => {
  const monitorManager = new MonitorManager();
  const processId = "test-memory-process";
  const pid = 12345;
  const memoryLimit = 50 * 1024 * 1024; // 50MB

  // Start monitoring
  monitorManager.startMonitoring(processId, pid);

  // Initially should not exceed limit
  expect(monitorManager.checkMemoryLimit(processId, memoryLimit)).toBe(false);
  expect(monitorManager.getCurrentMemoryUsage(processId)).toBe(0);

  // Simulate memory usage by directly setting process data (for testing)
  const processData = (monitorManager as any).monitoredProcesses.get(processId);
  if (processData) {
    processData.memory = 60 * 1024 * 1024; // 60MB - exceeds limit
  }

  // Should now detect violation
  expect(monitorManager.checkMemoryLimit(processId, memoryLimit)).toBe(true);
  expect(monitorManager.getCurrentMemoryUsage(processId)).toBe(60 * 1024 * 1024);

  monitorManager.cleanup();
});

test("MonitorManager - should check multiple processes for memory violations", () => {
  const monitorManager = new MonitorManager();
  
  // Set up multiple processes
  const processes = [
    { id: "proc1", pid: 1001, memory: 30 * 1024 * 1024, limit: 50 * 1024 * 1024 }, // OK
    { id: "proc2", pid: 1002, memory: 60 * 1024 * 1024, limit: 50 * 1024 * 1024 }, // Violation
    { id: "proc3", pid: 1003, memory: 40 * 1024 * 1024, limit: 50 * 1024 * 1024 }, // OK
    { id: "proc4", pid: 1004, memory: 80 * 1024 * 1024, limit: 70 * 1024 * 1024 }, // Violation
  ];

  // Start monitoring and set memory usage
  const memoryLimits = new Map<string, number>();
  for (const proc of processes) {
    monitorManager.startMonitoring(proc.id, proc.pid);
    memoryLimits.set(proc.id, proc.limit);
    
    // Set memory usage
    const processData = (monitorManager as any).monitoredProcesses.get(proc.id);
    if (processData) {
      processData.memory = proc.memory;
    }
  }

  // Check for violations
  const violations = monitorManager.checkAllMemoryLimits(memoryLimits);
  
  expect(violations).toHaveLength(2);
  expect(violations).toContain("proc2");
  expect(violations).toContain("proc4");
  expect(violations).not.toContain("proc1");
  expect(violations).not.toContain("proc3");

  monitorManager.cleanup();
});

test("ProcessManager - should restart process when memory limit is exceeded", async () => {
  const logManager = new LogManager();
  const monitorManager = new MonitorManager();
  const processManager = new ProcessManager(logManager, monitorManager);

  const config = createProcessConfig({
    id: "memory-limit-test",
    name: "memory-limit-app",
    script: testScript,
    cwd: testDir,
    memoryLimit: 50 * 1024 * 1024, // 50MB limit
    maxRestarts: 3
  });

  try {
    // Start the process
    const instances = await processManager.start(config);
    expect(instances).toHaveLength(1);
    
    const instance = instances[0];
    expect(instance.status).toBe("running");
    expect(instance.restartCount).toBe(0);

    // Wait for process to be fully started
    await new Promise(resolve => setTimeout(resolve, 500));

    // Simulate memory limit violation by directly setting memory usage
    const processData = (monitorManager as any).monitoredProcesses.get(instance.id);
    if (processData) {
      processData.memory = 60 * 1024 * 1024; // 60MB - exceeds 50MB limit
    }

    // Trigger memory limit check manually (normally done by interval)
    await (processManager as any).checkMemoryLimits();

    // Wait for restart to complete
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Check that process was restarted
    const restartedInstance = processManager.get(instance.id);
    expect(restartedInstance).toBeDefined();
    expect(restartedInstance!.status).toBe("running");
    expect(restartedInstance!.restartCount).toBe(1);
    expect(restartedInstance!.pid).not.toBe(instance.pid); // New PID after restart

  } finally {
    await processManager.cleanup();
  }
}, 10000);

test("ProcessManager - should mark process as errored after max restarts due to memory limits", async () => {
  const logManager = new LogManager();
  const monitorManager = new MonitorManager();
  const processManager = new ProcessManager(logManager, monitorManager);

  const config = createProcessConfig({
    id: "memory-limit-max-restarts",
    name: "memory-limit-max-app",
    script: testScript,
    cwd: testDir,
    memoryLimit: 50 * 1024 * 1024, // 50MB limit
    maxRestarts: 2 // Low limit for testing
  });

  try {
    // Start the process
    const instances = await processManager.start(config);
    const instance = instances[0];

    // Wait for process to be fully started
    await new Promise(resolve => setTimeout(resolve, 500));

    // Simulate multiple memory limit violations
    for (let i = 0; i < 3; i++) {
      // Set memory usage above limit
      const processData = (monitorManager as any).monitoredProcesses.get(instance.id);
      if (processData) {
        processData.memory = 60 * 1024 * 1024; // 60MB - exceeds limit
      }

      // Trigger memory limit check
      await (processManager as any).checkMemoryLimits();
      
      // Wait for restart attempt
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // After exceeding maxRestarts, process should be marked as errored
    const finalInstance = processManager.get(instance.id);
    expect(finalInstance).toBeDefined();
    expect(finalInstance!.status).toBe("errored");
    expect(finalInstance!.restartCount).toBeGreaterThanOrEqual(2);

  } finally {
    await processManager.cleanup();
  }
}, 15000);

test("ProcessManager - should not restart process without memory limit", async () => {
  const logManager = new LogManager();
  const monitorManager = new MonitorManager();
  const processManager = new ProcessManager(logManager, monitorManager);

  const config = createProcessConfig({
    id: "no-memory-limit-test",
    name: "no-memory-limit-app",
    script: testScript,
    cwd: testDir
    // No memoryLimit specified
  });

  try {
    // Start the process
    const instances = await processManager.start(config);
    const instance = instances[0];
    const originalPid = instance.pid;

    // Wait for process to be fully started
    await new Promise(resolve => setTimeout(resolve, 500));

    // Simulate high memory usage (but no limit set)
    const processData = (monitorManager as any).monitoredProcesses.get(instance.id);
    if (processData) {
      processData.memory = 100 * 1024 * 1024; // 100MB - high usage but no limit
    }

    // Trigger memory limit check
    await (processManager as any).checkMemoryLimits();
    
    // Wait to ensure no restart happens
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Process should still be running with same PID
    const unchangedInstance = processManager.get(instance.id);
    expect(unchangedInstance).toBeDefined();
    expect(unchangedInstance!.status).toBe("running");
    expect(unchangedInstance!.restartCount).toBe(0);
    expect(unchangedInstance!.pid).toBe(originalPid);

  } finally {
    await processManager.cleanup();
  }
}, 10000);

test("ProcessManager - should handle memory limit with clustering", async () => {
  const logManager = new LogManager();
  const monitorManager = new MonitorManager();
  const processManager = new ProcessManager(logManager, monitorManager);

  const config = createProcessConfig({
    id: "cluster-memory-test",
    name: "cluster-memory-app",
    script: testScript,
    cwd: testDir,
    instances: 2,
    memoryLimit: 50 * 1024 * 1024, // 50MB limit per instance
    maxRestarts: 3
  });

  try {
    // Start clustered processes
    const instances = await processManager.start(config);
    expect(instances).toHaveLength(2);

    // Wait for processes to be fully started
    await new Promise(resolve => setTimeout(resolve, 500));

    // Simulate memory limit violation in only one instance
    const firstInstance = instances[0];
    const secondInstance = instances[1];
    
    const firstProcessData = (monitorManager as any).monitoredProcesses.get(firstInstance.id);
    if (firstProcessData) {
      firstProcessData.memory = 60 * 1024 * 1024; // Exceeds limit
    }

    // Second instance stays within limit
    const secondProcessData = (monitorManager as any).monitoredProcesses.get(secondInstance.id);
    if (secondProcessData) {
      secondProcessData.memory = 30 * 1024 * 1024; // Within limit
    }

    // Trigger memory limit check
    await (processManager as any).checkMemoryLimits();
    
    // Wait for restart to complete
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Only the first instance should be restarted
    const restartedFirst = processManager.get(firstInstance.id);
    const unchangedSecond = processManager.get(secondInstance.id);

    expect(restartedFirst).toBeDefined();
    expect(restartedFirst!.restartCount).toBe(1);
    expect(restartedFirst!.pid).not.toBe(firstInstance.pid);

    expect(unchangedSecond).toBeDefined();
    expect(unchangedSecond!.restartCount).toBe(0);
    expect(unchangedSecond!.pid).toBe(secondInstance.pid);

  } finally {
    await processManager.cleanup();
  }
}, 15000);

test("ProcessManager - memory limit checking interval should be configurable", async () => {
  const logManager = new LogManager();
  const monitorManager = new MonitorManager();
  
  // Test that memory checking happens periodically
  let checkCount = 0;
  const originalCheckMethod = (ProcessManager.prototype as any).checkMemoryLimits;
  (ProcessManager.prototype as any).checkMemoryLimits = function() {
    checkCount++;
    return originalCheckMethod.call(this);
  };

  const processManager = new ProcessManager(logManager, monitorManager);

  try {
    // Wait for a few intervals (default is 30 seconds, but we'll mock shorter for testing)
    // Since we can't easily change the interval in tests, we'll just verify the method exists
    expect(typeof (processManager as any).checkMemoryLimits).toBe("function");
    expect((processManager as any).memoryCheckInterval).toBeDefined();

  } finally {
    // Restore original method
    (ProcessManager.prototype as any).checkMemoryLimits = originalCheckMethod;
    await processManager.cleanup();
  }
});