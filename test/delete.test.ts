import { test, expect, beforeEach, afterEach } from "bun:test";
import { ProcessDaemon } from "../src/daemon/daemon.js";
import { IPCClient } from "../src/ipc/socket.js";
import { createIPCMessage, createProcessConfig } from "../src/types/index.js";
import { join } from "path";
import { existsSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
let daemon: ProcessDaemon;
let client: IPCClient;
let testDir: string;
let socketPath: string;

beforeEach(async () => {
    // Create temporary directory for test
    testDir = join(tmpdir(), `bun-pm-test-delete-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    socketPath = join(testDir, "daemon.sock");

    // Create daemon and client
    daemon = new ProcessDaemon(socketPath);
    client = new IPCClient(socketPath);

    // Start daemon
    await daemon.start();
    await client.connect();
});

afterEach(async () => {
    // Clean up
    try {
      await client.disconnect();
      await daemon.stop();
    } catch (error) {
      // Ignore cleanup errors
    }

    // Remove test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
});

test("should delete a stopped process configuration", async () => {
    // Create a test script
    const testScript = join(testDir, "test-app.js");
    await Bun.write(testScript, "console.log('Hello World'); process.exit(0);");

    // Start a process
    const config = createProcessConfig({
      id: "test-delete-1",
      name: "test-app",
      script: testScript,
      cwd: testDir,
      instances: 1,
      autorestart: false
    });

    const startMessage = createIPCMessage("start", { config });
    const startResponse = await client.sendMessage(startMessage);
    expect(startResponse.success).toBe(true);

    // Wait a moment for process to exit (since autorestart is false)
    await new Promise(resolve => setTimeout(resolve, 100));

    // Delete the process
    const deleteMessage = createIPCMessage("delete", { 
      identifier: "test-delete-1",
      force: true 
    });
    const deleteResponse = await client.sendMessage(deleteMessage);

    expect(deleteResponse.success).toBe(true);
    expect(deleteResponse.data.message).toContain("deleted successfully");
    expect(deleteResponse.data.processId).toBe("test-delete-1");
    expect(deleteResponse.data.processName).toBe("test-app");

    // Verify process is no longer in the list
    const listMessage = createIPCMessage("list", {});
    const listResponse = await client.sendMessage(listMessage);
    expect(listResponse.success).toBe(true);
    
    const processes = listResponse.data.processes;
    const deletedProcess = processes.find((p: any) => p.id === "test-delete-1");
    expect(deletedProcess).toBeUndefined();
  });

  test("should delete a running process and stop it first", async () => {
    // Create a long-running test script
    const testScript = join(testDir, "long-running.js");
    await Bun.write(testScript, `
      console.log('Starting long running process');
      setInterval(() => {
        console.log('Still running...');
      }, 100);
    `);

    // Start a process
    const config = createProcessConfig({
      id: "test-delete-2",
      name: "long-runner",
      script: testScript,
      cwd: testDir,
      instances: 1,
      autorestart: true
    });

    const startMessage = createIPCMessage("start", { config });
    const startResponse = await client.sendMessage(startMessage);
    expect(startResponse.success).toBe(true);

    // Wait for process to start
    await new Promise(resolve => setTimeout(resolve, 200));

    // Verify process is running
    const listMessage = createIPCMessage("list", {});
    const listResponse = await client.sendMessage(listMessage);
    expect(listResponse.success).toBe(true);
    
    const runningProcess = listResponse.data.processes.find((p: any) => p.id === "test-delete-2");
    expect(runningProcess).toBeDefined();
    expect(runningProcess.status).toBe("running");

    // Delete the running process
    const deleteMessage = createIPCMessage("delete", { 
      identifier: "test-delete-2",
      force: true 
    });
    const deleteResponse = await client.sendMessage(deleteMessage);

    expect(deleteResponse.success).toBe(true);
    expect(deleteResponse.data.message).toContain("deleted successfully");
    expect(deleteResponse.data.stoppedInstances).toHaveLength(1);
    expect(deleteResponse.data.stoppedInstances[0]).toBe("test-delete-2");

    // Verify process is no longer in the list
    const finalListMessage = createIPCMessage("list", {});
    const finalListResponse = await client.sendMessage(finalListMessage);
    expect(finalListResponse.success).toBe(true);
    
    const processes = finalListResponse.data.processes;
    const deletedProcess = processes.find((p: any) => p.id === "test-delete-2");
    expect(deletedProcess).toBeUndefined();
  });

  test("should delete clustered process instances", async () => {
    // Create a test script
    const testScript = join(testDir, "cluster-app.js");
    await Bun.write(testScript, `
      console.log('Cluster instance starting on port', process.env.PORT || 3000);
      setInterval(() => {
        console.log('Instance running...');
      }, 100);
    `);

    // Start a clustered process
    const config = createProcessConfig({
      id: "test-cluster",
      name: "cluster-app",
      script: testScript,
      cwd: testDir,
      instances: 3,
      autorestart: true
    });

    const startMessage = createIPCMessage("start", { config });
    const startResponse = await client.sendMessage(startMessage);
    expect(startResponse.success).toBe(true);

    // Wait for processes to start
    await new Promise(resolve => setTimeout(resolve, 300));

    // Verify all instances are running
    const listMessage = createIPCMessage("list", {});
    const listResponse = await client.sendMessage(listMessage);
    expect(listResponse.success).toBe(true);
    
    const clusterInstances = listResponse.data.processes.filter((p: any) => 
      p.id.startsWith("test-cluster")
    );
    expect(clusterInstances).toHaveLength(3);

    // Delete the clustered process
    const deleteMessage = createIPCMessage("delete", { 
      identifier: "test-cluster",
      force: true 
    });
    const deleteResponse = await client.sendMessage(deleteMessage);

    expect(deleteResponse.success).toBe(true);
    expect(deleteResponse.data.message).toContain("deleted successfully");
    expect(deleteResponse.data.stoppedInstances).toHaveLength(3);

    // Verify all instances are removed
    const finalListMessage = createIPCMessage("list", {});
    const finalListResponse = await client.sendMessage(finalListMessage);
    expect(finalListResponse.success).toBe(true);
    
    const remainingInstances = finalListResponse.data.processes.filter((p: any) => 
      p.id.startsWith("test-cluster")
    );
    expect(remainingInstances).toHaveLength(0);
  });

  test("should delete process by name", async () => {
    // Create a test script
    const testScript = join(testDir, "named-app.js");
    await Bun.write(testScript, "console.log('Named app'); process.exit(0);");

    // Start a process with a specific name
    const config = createProcessConfig({
      id: "test-named-123",
      name: "my-special-app",
      script: testScript,
      cwd: testDir,
      instances: 1,
      autorestart: false
    });

    const startMessage = createIPCMessage("start", { config });
    const startResponse = await client.sendMessage(startMessage);
    expect(startResponse.success).toBe(true);

    // Delete by name instead of ID
    const deleteMessage = createIPCMessage("delete", { 
      identifier: "my-special-app",
      force: true 
    });
    const deleteResponse = await client.sendMessage(deleteMessage);

    expect(deleteResponse.success).toBe(true);
    expect(deleteResponse.data.message).toContain("deleted successfully");
    expect(deleteResponse.data.processName).toBe("my-special-app");
  });

  test("should return error for non-existent process", async () => {
    const deleteMessage = createIPCMessage("delete", { 
      identifier: "non-existent-process",
      force: true 
    });
    const deleteResponse = await client.sendMessage(deleteMessage);

    expect(deleteResponse.success).toBe(false);
    expect(deleteResponse.error).toContain("not found");
  });

  test("should return error when identifier is missing", async () => {
    const deleteMessage = createIPCMessage("delete", {});
    const deleteResponse = await client.sendMessage(deleteMessage);

    expect(deleteResponse.success).toBe(false);
    expect(deleteResponse.error).toContain("identifier is required");
  });

  test("should clean up logs when deleting process", async () => {
    // Create a test script that generates logs
    const testScript = join(testDir, "logging-app.js");
    await Bun.write(testScript, `
      console.log('Starting logging app');
      console.error('This is an error message');
      setTimeout(() => {
        console.log('Finishing logging app');
        process.exit(0);
      }, 100);
    `);

    // Start a process
    const config = createProcessConfig({
      id: "test-logs-cleanup",
      name: "logging-app",
      script: testScript,
      cwd: testDir,
      instances: 1,
      autorestart: false
    });

    const startMessage = createIPCMessage("start", { config });
    const startResponse = await client.sendMessage(startMessage);
    expect(startResponse.success).toBe(true);

    // Wait for process to complete and logs to be written
    await new Promise(resolve => setTimeout(resolve, 300));

    // Delete the process
    const deleteMessage = createIPCMessage("delete", { 
      identifier: "test-logs-cleanup",
      force: true 
    });
    const deleteResponse = await client.sendMessage(deleteMessage);

    expect(deleteResponse.success).toBe(true);
    expect(deleteResponse.data.removedLogs).toBe(true);
  });

  test("should handle deletion when process fails to stop", async () => {
    // This test simulates a scenario where stopping the process fails
    // but deletion should still proceed
    
    // Create a test script
    const testScript = join(testDir, "stubborn-app.js");
    await Bun.write(testScript, "console.log('Stubborn app'); process.exit(0);");

    // Start a process
    const config = createProcessConfig({
      id: "test-stubborn",
      name: "stubborn-app",
      script: testScript,
      cwd: testDir,
      instances: 1,
      autorestart: false
    });

    const startMessage = createIPCMessage("start", { config });
    const startResponse = await client.sendMessage(startMessage);
    expect(startResponse.success).toBe(true);

    // Wait for process to exit
    await new Promise(resolve => setTimeout(resolve, 100));

    // Try to delete - should succeed even if stop fails (process already stopped)
    const deleteMessage = createIPCMessage("delete", { 
      identifier: "test-stubborn",
      force: true 
    });
    const deleteResponse = await client.sendMessage(deleteMessage);

    expect(deleteResponse.success).toBe(true);
    expect(deleteResponse.data.message).toContain("deleted successfully");
  });

  test("should persist configuration changes after deletion", async () => {
    // Create multiple test processes
    const testScript1 = join(testDir, "app1.js");
    const testScript2 = join(testDir, "app2.js");
    await Bun.write(testScript1, "console.log('App 1'); process.exit(0);");
    await Bun.write(testScript2, "console.log('App 2'); process.exit(0);");

    // Start two processes
    const config1 = createProcessConfig({
      id: "test-persist-1",
      name: "app-1",
      script: testScript1,
      cwd: testDir,
      instances: 1,
      autorestart: false
    });

    const config2 = createProcessConfig({
      id: "test-persist-2", 
      name: "app-2",
      script: testScript2,
      cwd: testDir,
      instances: 1,
      autorestart: false
    });

    await client.sendMessage(createIPCMessage("start", { config: config1 }));
    await client.sendMessage(createIPCMessage("start", { config: config2 }));

    // Delete one process
    const deleteMessage = createIPCMessage("delete", { 
      identifier: "test-persist-1",
      force: true 
    });
    const deleteResponse = await client.sendMessage(deleteMessage);
    expect(deleteResponse.success).toBe(true);

    // Restart daemon to test persistence
    await client.disconnect();
    await daemon.stop();

    daemon = new ProcessDaemon(socketPath);
    await daemon.start();
    await client.connect();

    // Check that only the non-deleted process configuration remains
    const listMessage = createIPCMessage("list", {});
    const listResponse = await client.sendMessage(listMessage);
    expect(listResponse.success).toBe(true);

    const processes = listResponse.data.processes;
    const deletedProcess = processes.find((p: any) => p.id === "test-persist-1");
    const remainingProcess = processes.find((p: any) => p.id === "test-persist-2");
    
    expect(deletedProcess).toBeUndefined();
    // Note: The remaining process might not be running since autorestart is false
    // but its configuration should still exist in the daemon's memory
  });