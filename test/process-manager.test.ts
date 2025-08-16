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
    kill: mock(() => {
      subprocess.killed = true;
      resolveExited(0); // Resolve when killed
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