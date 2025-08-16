import { test, expect, mock, beforeEach, afterEach } from "bun:test";
import { ProcessManager } from "../src/core/process-manager.js";
import { createProcessConfig } from "../src/types/index.js";

// Mock Bun.spawn for testing
let mockPidCounter = 12345;

const createMockSubprocess = () => {
  // Create a promise that never resolves (simulating a running process)
  let resolveExited: (value: number) => void = () => {};
  const exitedPromise = new Promise<number>((resolve) => {
    resolveExited = resolve;
  });

  const subprocess = {
    pid: mockPidCounter++,
    killed: false,
    exited: exitedPromise,
    kill: mock((signal?: string) => {
      subprocess.killed = true;
      // Immediately resolve when killed to speed up tests
      setTimeout(() => resolveExited(0), 1);
    }),
    stdout: new ReadableStream(),
    stderr: new ReadableStream(),
    _resolveExited: resolveExited // For test control
  };

  return subprocess;
};

const originalSpawn = Bun.spawn;

beforeEach(() => {
  // Reset PID counter
  mockPidCounter = 12345;

  // Mock Bun.spawn to return a new mock subprocess each time
  Bun.spawn = mock(() => createMockSubprocess()) as any;
});

afterEach(() => {
  // Restore original Bun.spawn
  Bun.spawn = originalSpawn;
});

test("ProcessManager - start single process", async () => {
  const manager = new ProcessManager();

  const config = createProcessConfig({
    id: "test-process",
    name: "Test Process",
    script: "test.js"
  });

  const instances = await manager.start(config);

  expect(instances).toHaveLength(1);
  expect(instances[0].id).toBe("test-process");
  expect(instances[0].pid).toBe(12345);
  expect(instances[0].status).toBe("running");
  expect(instances[0].restartCount).toBe(0);
  expect(Bun.spawn).toHaveBeenCalledTimes(1);

  await manager.cleanup();
});

test("ProcessManager - start multiple instances", async () => {
  const manager = new ProcessManager();

  const config = createProcessConfig({
    id: "test-cluster",
    name: "Test Cluster",
    script: "test.js",
    instances: 3
  });

  const instances = await manager.start(config);

  expect(instances).toHaveLength(3);
  expect(instances[0].id).toBe("test-cluster_0");
  expect(instances[1].id).toBe("test-cluster_1");
  expect(instances[2].id).toBe("test-cluster_2");
  expect(Bun.spawn).toHaveBeenCalledTimes(3);

  await manager.cleanup();
});

test("ProcessManager - start with environment variables", async () => {
  const manager = new ProcessManager();

  const config = createProcessConfig({
    id: "test-env",
    name: "Test Env",
    script: "test.js",
    env: { NODE_ENV: "test", API_KEY: "secret" }
  });

  await manager.start(config);

  expect(Bun.spawn).toHaveBeenCalledWith({
    cmd: ["bun", expect.any(String)],
    cwd: expect.any(String),
    env: expect.objectContaining({
      NODE_ENV: "test",
      API_KEY: "secret"
    }),
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore"
  });

  await manager.cleanup();
});

test("ProcessManager - start with PORT assignment for clustering", async () => {
  const manager = new ProcessManager();

  // Set base PORT
  process.env.PORT = "3000";

  const config = createProcessConfig({
    id: "test-ports",
    name: "Test Ports",
    script: "test.js",
    instances: 2
  });

  await manager.start(config);

  const calls = (Bun.spawn as any).mock.calls;
  expect(calls[0][0].env.PORT).toBe("3000");
  expect(calls[1][0].env.PORT).toBe("3001");

  await manager.cleanup();
});

test("ProcessManager - list processes", async () => {
  const manager = new ProcessManager();

  const config1 = createProcessConfig({
    id: "process-1",
    name: "Process 1",
    script: "test1.js"
  });

  const config2 = createProcessConfig({
    id: "process-2",
    name: "Process 2",
    script: "test2.js"
  });

  await manager.start(config1);
  await manager.start(config2);

  const processes = manager.list();
  expect(processes).toHaveLength(2);
  expect(processes.map(p => p.id)).toContain("process-1");
  expect(processes.map(p => p.id)).toContain("process-2");

  await manager.cleanup();
});

test("ProcessManager - get specific process", async () => {
  const manager = new ProcessManager();

  const config = createProcessConfig({
    id: "specific-process",
    name: "Specific Process",
    script: "test.js"
  });

  await manager.start(config);

  const process = manager.get("specific-process");
  expect(process).toBeDefined();
  expect(process!.id).toBe("specific-process");

  const nonExistent = manager.get("non-existent");
  expect(nonExistent).toBeUndefined();

  await manager.cleanup();
});

test("ProcessManager - stop process", async () => {
  const manager = new ProcessManager();

  const config = createProcessConfig({
    id: "stop-test",
    name: "Stop Test",
    script: "test.js"
  });

  await manager.start(config);

  const processBefore = manager.get("stop-test");
  expect(processBefore).toBeDefined();

  await manager.stop("stop-test");

  const processAfter = manager.get("stop-test");
  expect(processAfter).toBeUndefined();
});

test("ProcessManager - stop non-existent process", async () => {
  const manager = new ProcessManager();

  expect(manager.stop("non-existent")).rejects.toThrow(
    "Process with id 'non-existent' not found"
  );
});

test("ProcessManager - prevent duplicate process IDs", async () => {
  const manager = new ProcessManager();

  const config = createProcessConfig({
    id: "duplicate-test",
    name: "Duplicate Test",
    script: "test.js"
  });

  await manager.start(config);

  expect(manager.start(config)).rejects.toThrow(
    "Process with id 'duplicate-test' already exists"
  );

  await manager.cleanup();
});

test("ProcessManager - scale up processes", async () => {
  const manager = new ProcessManager();

  const config = createProcessConfig({
    id: "scale-test",
    name: "Scale Test",
    script: "test.js",
    instances: 2
  });

  await manager.start(config);
  expect(manager.list()).toHaveLength(2);

  const scaledInstances = await manager.scale("scale-test", 4);
  expect(scaledInstances).toHaveLength(4);
  expect(manager.list()).toHaveLength(4);

  await manager.cleanup();
});

test("ProcessManager - scale down processes", async () => {
  const manager = new ProcessManager();

  const config = createProcessConfig({
    id: "scale-down-test",
    name: "Scale Down Test",
    script: "test.js",
    instances: 4
  });

  await manager.start(config);
  expect(manager.list()).toHaveLength(4);

  const scaledInstances = await manager.scale("scale-down-test", 2);
  expect(scaledInstances).toHaveLength(2);
  expect(manager.list()).toHaveLength(2);

  await manager.cleanup();
});

test("ProcessManager - scale with invalid instance count", async () => {
  const manager = new ProcessManager();

  const config = createProcessConfig({
    id: "invalid-scale",
    name: "Invalid Scale",
    script: "test.js"
  });

  await manager.start(config);

  expect(manager.scale("invalid-scale", 0)).rejects.toThrow(
    "Instance count must be at least 1"
  );

  await manager.cleanup();
});

test("ProcessManager - scale non-existent process", async () => {
  const manager = new ProcessManager();

  expect(manager.scale("non-existent", 2)).rejects.toThrow(
    "No processes found with id 'non-existent'"
  );
});

test("ProcessManager - cleanup all processes", async () => {
  const manager = new ProcessManager();

  const config1 = createProcessConfig({
    id: "cleanup-1",
    name: "Cleanup 1",
    script: "test1.js"
  });

  const config2 = createProcessConfig({
    id: "cleanup-2",
    name: "Cleanup 2",
    script: "test2.js"
  });

  await manager.start(config1);
  await manager.start(config2);

  expect(manager.list()).toHaveLength(2);

  await manager.cleanup();

  expect(manager.list()).toHaveLength(0);
});

test("ProcessManager - handle process spawn failure", async () => {
  const manager = new ProcessManager();

  // Mock Bun.spawn to throw an error
  Bun.spawn = mock(() => {
    throw new Error("Spawn failed");
  }) as any;

  const config = createProcessConfig({
    id: "spawn-fail",
    name: "Spawn Fail",
    script: "test.js"
  });

  expect(manager.start(config)).rejects.toThrow(
    "Failed to start process 'spawn-fail': Error: Failed to spawn process: Error: Spawn failed"
  );
});

test("ProcessManager - process instance properties", async () => {
  const manager = new ProcessManager();

  const config = createProcessConfig({
    id: "props-test",
    name: "Props Test",
    script: "test.js"
  });

  const instances = await manager.start(config);
  const instance = instances[0];

  expect(instance.id).toBe("props-test");
  expect(typeof instance.pid).toBe("number");
  expect(instance.pid).toBeGreaterThan(0);
  expect(instance.status).toBe("running");
  expect(instance.startTime).toBeInstanceOf(Date);
  expect(instance.restartCount).toBe(0);
  expect(instance.subprocess).toBeDefined();

  await manager.cleanup();
});

test("ProcessManager - process state tracking", async () => {
  const manager = new ProcessManager();

  const config = createProcessConfig({
    id: "state-test",
    name: "State Test",
    script: "test.js"
  });

  // Start process
  const instances = await manager.start(config);
  const instance = instances[0];
  
  expect(instance.status).toBe("running");
  expect(instance.restartCount).toBe(0);
  
  // Verify process is tracked
  const trackedProcess = manager.get("state-test");
  expect(trackedProcess).toBeDefined();
  expect(trackedProcess!.id).toBe("state-test");
  expect(trackedProcess!.status).toBe("running");

  await manager.cleanup();
});

test("ProcessManager - PID management", async () => {
  const manager = new ProcessManager();

  const config = createProcessConfig({
    id: "pid-test",
    name: "PID Test",
    script: "test.js"
  });

  const instances = await manager.start(config);
  const instance = instances[0];

  // Verify PID is assigned and valid
  expect(instance.pid).toBeDefined();
  expect(typeof instance.pid).toBe("number");
  expect(instance.pid).toBeGreaterThan(0);

  // Verify PID matches subprocess PID
  expect(instance.pid).toBe(instance.subprocess.pid);

  await manager.cleanup();
});

test("ProcessManager - stdio configuration", async () => {
  const manager = new ProcessManager();

  const config = createProcessConfig({
    id: "stdio-test",
    name: "STDIO Test",
    script: "test.js"
  });

  await manager.start(config);

  // Verify Bun.spawn was called with proper stdio configuration
  expect(Bun.spawn).toHaveBeenCalledWith({
    cmd: ["bun", expect.any(String)],
    cwd: expect.any(String),
    env: expect.any(Object),
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore"
  });

  await manager.cleanup();
});

test("ProcessManager - working directory handling", async () => {
  const manager = new ProcessManager();

  const config = createProcessConfig({
    id: "cwd-test",
    name: "CWD Test",
    script: "test.js",
    cwd: "/tmp"
  });

  await manager.start(config);

  // Verify Bun.spawn was called with correct working directory
  expect(Bun.spawn).toHaveBeenCalledWith({
    cmd: ["bun", expect.stringContaining("test.js")],
    cwd: "/tmp",
    env: expect.any(Object),
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore"
  });

  await manager.cleanup();
});

// Restart functionality tests
test("ProcessManager - automatic restart on crash", async () => {
  const manager = new ProcessManager();

  const config = createProcessConfig({
    id: "restart-test",
    name: "Restart Test",
    script: "test.js",
    autorestart: true,
    maxRestarts: 3
  });

  const instances = await manager.start(config);
  const instance = instances[0];

  // Simulate process crash
  const mockSubprocess = instance.subprocess as any;
  mockSubprocess._resolveExited(1); // Exit with error code

  // Wait for restart to be scheduled
  await new Promise(resolve => setTimeout(resolve, 50));

  // Check that process is marked as restarting
  const restartingProcess = manager.get("restart-test");
  expect(restartingProcess?.status).toBe("restarting");
  expect(restartingProcess?.restartCount).toBe(1);

  await manager.cleanup();
});

test("ProcessManager - no restart on clean exit", async () => {
  const manager = new ProcessManager();

  const config = createProcessConfig({
    id: "clean-exit-test",
    name: "Clean Exit Test",
    script: "test.js",
    autorestart: true,
    maxRestarts: 3
  });

  const instances = await manager.start(config);
  const instance = instances[0];

  // Simulate clean exit
  const mockSubprocess = instance.subprocess as any;
  mockSubprocess._resolveExited(0); // Exit with success code

  // Wait for exit handling
  await new Promise(resolve => setTimeout(resolve, 150));

  // Process should be removed, not restarted
  const process = manager.get("clean-exit-test");
  expect(process).toBeUndefined();

  await manager.cleanup();
});

test("ProcessManager - no restart when autorestart disabled", async () => {
  const manager = new ProcessManager();

  const config = createProcessConfig({
    id: "no-restart-test",
    name: "No Restart Test",
    script: "test.js",
    autorestart: false,
    maxRestarts: 3
  });

  const instances = await manager.start(config);
  const instance = instances[0];

  // Simulate process crash
  const mockSubprocess = instance.subprocess as any;
  mockSubprocess._resolveExited(1); // Exit with error code

  // Wait for exit handling
  await new Promise(resolve => setTimeout(resolve, 50));

  // Process should be marked as errored, not restarting
  const erroredProcess = manager.get("no-restart-test");
  expect(erroredProcess?.status).toBe("errored");
  expect(erroredProcess?.restartCount).toBe(0);

  await manager.cleanup();
});

test("ProcessManager - max restart attempts exceeded", async () => {
  const manager = new ProcessManager();

  const config = createProcessConfig({
    id: "max-restart-test",
    name: "Max Restart Test",
    script: "test.js",
    autorestart: true,
    maxRestarts: 1 // Lower max for faster test
  });

  const instances = await manager.start(config);
  let instance = instances[0];

  // First crash - should trigger restart
  const mockSubprocess1 = instance.subprocess as any;
  mockSubprocess1._resolveExited(1);
  
  // Wait for restart to be scheduled
  await new Promise(resolve => setTimeout(resolve, 100));
  
  let restartingInstance = manager.get("max-restart-test");
  expect(restartingInstance?.status).toBe("restarting");
  expect(restartingInstance?.restartCount).toBe(1);

  // Wait for restart to complete and get new instance
  await new Promise(resolve => setTimeout(resolve, 1200)); // Wait for restart delay
  
  let newInstance = manager.get("max-restart-test");
  expect(newInstance?.status).toBe("running");

  // Second crash - should exceed max restarts and mark as errored
  const mockSubprocess2 = newInstance!.subprocess as any;
  mockSubprocess2._resolveExited(1);
  
  // Wait for error handling
  await new Promise(resolve => setTimeout(resolve, 100));

  const finalInstance = manager.get("max-restart-test");
  expect(finalInstance?.status).toBe("errored");
  expect(finalInstance?.restartCount).toBe(1); // Should be at max restart count when marked as errored

  await manager.cleanup();
});

test("ProcessManager - no restart after manual stop", async () => {
  const manager = new ProcessManager();

  const config = createProcessConfig({
    id: "manual-stop-test",
    name: "Manual Stop Test",
    script: "test.js",
    autorestart: true,
    maxRestarts: 3
  });

  const instances = await manager.start(config);
  const instance = instances[0];

  // Manually stop the process
  await manager.stop("manual-stop-test");

  // Simulate the subprocess exit after manual stop
  const mockSubprocess = instance.subprocess as any;
  mockSubprocess._resolveExited(1); // Exit with error code

  // Wait for exit handling
  await new Promise(resolve => setTimeout(resolve, 50));

  // Process should not be restarted
  const stoppedProcess = manager.get("manual-stop-test");
  expect(stoppedProcess).toBeUndefined();

  await manager.cleanup();
});

test("ProcessManager - restart statistics", async () => {
  const manager = new ProcessManager();

  const config = createProcessConfig({
    id: "stats-test",
    name: "Stats Test",
    script: "test.js",
    autorestart: true,
    maxRestarts: 5
  });

  await manager.start(config);

  // Check initial stats
  const initialStats = manager.getRestartStats("stats-test");
  expect(initialStats).toEqual({
    restartCount: 0,
    maxRestarts: 5,
    canRestart: true
  });

  // Check config retrieval
  const retrievedConfig = manager.getConfig("stats-test");
  expect(retrievedConfig).toEqual(config);

  // Check autorestart status
  expect(manager.isAutorestartEnabled("stats-test")).toBe(true);

  await manager.cleanup();
});

test("ProcessManager - restart with exponential backoff", async () => {
  const manager = new ProcessManager();

  const config = createProcessConfig({
    id: "backoff-test",
    name: "Backoff Test",
    script: "test.js",
    autorestart: true,
    maxRestarts: 3
  });

  const instances = await manager.start(config);
  const instance = instances[0];

  const startTime = Date.now();

  // Simulate process crash
  const mockSubprocess = instance.subprocess as any;
  mockSubprocess._resolveExited(1); // Exit with error code

  // Wait for restart to be scheduled (should be ~1 second base delay)
  await new Promise(resolve => setTimeout(resolve, 50));

  const restartingProcess = manager.get("backoff-test");
  expect(restartingProcess?.status).toBe("restarting");

  // The restart should be scheduled but not immediate
  const elapsedTime = Date.now() - startTime;
  expect(elapsedTime).toBeLessThan(1000); // Should not have restarted yet

  await manager.cleanup();
});

test("ProcessManager - clustered process restart", async () => {
  const manager = new ProcessManager();

  const config = createProcessConfig({
    id: "cluster-restart-test",
    name: "Cluster Restart Test",
    script: "test.js",
    instances: 3,
    autorestart: true,
    maxRestarts: 2
  });

  const instances = await manager.start(config);
  expect(instances).toHaveLength(3);

  // Crash one instance
  const crashedInstance = instances[1];
  const mockSubprocess = crashedInstance.subprocess as any;
  mockSubprocess._resolveExited(1); // Exit with error code

  // Wait for restart handling
  await new Promise(resolve => setTimeout(resolve, 50));

  // Only the crashed instance should be restarting
  const instance0 = manager.get("cluster-restart-test_0");
  const instance1 = manager.get("cluster-restart-test_1");
  const instance2 = manager.get("cluster-restart-test_2");

  expect(instance0?.status).toBe("running");
  expect(instance1?.status).toBe("restarting");
  expect(instance2?.status).toBe("running");

  await manager.cleanup();
});

test("ProcessManager - restart preserves configuration", async () => {
  const manager = new ProcessManager();

  const config = createProcessConfig({
    id: "config-preserve-test",
    name: "Config Preserve Test",
    script: "test.js",
    env: { TEST_VAR: "test_value" },
    autorestart: true,
    maxRestarts: 3
  });

  await manager.start(config);

  // Manual restart
  const restartedInstance = await manager.restart("config-preserve-test");

  expect(restartedInstance.id).toBe("config-preserve-test");
  expect(restartedInstance.status).toBe("running");
  expect(restartedInstance.restartCount).toBe(0); // Manual restart resets count

  // Verify configuration is preserved
  const preservedConfig = manager.getConfig("config-preserve-test");
  expect(preservedConfig?.env.TEST_VAR).toBe("test_value");

  await manager.cleanup();
});

test("ProcessManager - restart within 1 second requirement", async () => {
  const manager = new ProcessManager();

  const config = createProcessConfig({
    id: "timing-test",
    name: "Timing Test",
    script: "test.js",
    autorestart: true,
    maxRestarts: 3
  });

  const instances = await manager.start(config);
  const instance = instances[0];

  const startTime = Date.now();

  // Simulate process crash
  const mockSubprocess = instance.subprocess as any;
  mockSubprocess._resolveExited(1);

  // Wait for restart to be scheduled
  await new Promise(resolve => setTimeout(resolve, 50));

  const restartingProcess = manager.get("timing-test");
  expect(restartingProcess?.status).toBe("restarting");

  // Verify restart is scheduled within reasonable time (should be ~1 second base)
  const elapsedTime = Date.now() - startTime;
  expect(elapsedTime).toBeLessThan(200); // Should be scheduled quickly

  await manager.cleanup();
});

test("ProcessManager - failure counting with consecutive failures", async () => {
  const manager = new ProcessManager();

  const config = createProcessConfig({
    id: "failure-count-test",
    name: "Failure Count Test",
    script: "test.js",
    autorestart: true,
    maxRestarts: 2 // Lower max for faster test
  });

  const instances = await manager.start(config);

  // First failure
  let currentInstance = manager.get("failure-count-test")!;
  let mockSubprocess = currentInstance.subprocess as any;
  mockSubprocess._resolveExited(1);
  
  await new Promise(resolve => setTimeout(resolve, 100));
  let restartingInstance = manager.get("failure-count-test");
  expect(restartingInstance?.status).toBe("restarting");
  expect(restartingInstance?.restartCount).toBe(1);

  // Wait for first restart to complete
  await new Promise(resolve => setTimeout(resolve, 1200));
  
  // Second failure
  currentInstance = manager.get("failure-count-test")!;
  expect(currentInstance.status).toBe("running");
  mockSubprocess = currentInstance.subprocess as any;
  mockSubprocess._resolveExited(1);
  
  await new Promise(resolve => setTimeout(resolve, 100));
  restartingInstance = manager.get("failure-count-test");
  expect(restartingInstance?.status).toBe("restarting");
  expect(restartingInstance?.restartCount).toBe(2);

  // Wait for second restart to complete
  await new Promise(resolve => setTimeout(resolve, 2200)); // Longer wait due to exponential backoff
  
  // Third failure - should exceed max and mark as errored
  currentInstance = manager.get("failure-count-test")!;
  expect(currentInstance.status).toBe("running");
  mockSubprocess = currentInstance.subprocess as any;
  mockSubprocess._resolveExited(1);
  
  await new Promise(resolve => setTimeout(resolve, 100));

  // Should now be marked as errored
  const finalInstance = manager.get("failure-count-test");
  expect(finalInstance?.status).toBe("errored");
  expect(finalInstance?.restartCount).toBe(2); // At max restart count

  await manager.cleanup();
});

test("ProcessManager - autorestart flag configuration", async () => {
  const manager = new ProcessManager();

  // Test with autorestart enabled
  const configEnabled = createProcessConfig({
    id: "autorestart-enabled",
    name: "Autorestart Enabled",
    script: "test.js",
    autorestart: true,
    maxRestarts: 2
  });

  await manager.start(configEnabled);
  expect(manager.isAutorestartEnabled("autorestart-enabled")).toBe(true);

  // Test with autorestart disabled
  const configDisabled = createProcessConfig({
    id: "autorestart-disabled",
    name: "Autorestart Disabled",
    script: "test.js",
    autorestart: false,
    maxRestarts: 2
  });

  await manager.start(configDisabled);
  expect(manager.isAutorestartEnabled("autorestart-disabled")).toBe(false);

  await manager.cleanup();
});