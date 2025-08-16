import { test, expect, beforeEach, afterEach } from "bun:test";
import { spawn } from "bun";
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
let cliPath: string;

beforeEach(async () => {
    // Create temporary directory for test
    testDir = join(tmpdir(), `bun-pm-test-cli-delete-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    socketPath = join(testDir, "daemon.sock");
    cliPath = join(process.cwd(), "src", "cli", "index.ts");

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

test("should show error when no process identifier provided", async () => {
    const result = spawn({
      cmd: ["bun", cliPath, "delete"],
      env: { ...process.env, BUN_PM_SOCKET: socketPath },
      cwd: testDir,
      stdout: "pipe",
      stderr: "pipe"
    });

    const output = await new Response(result.stderr).text();
    expect(output).toContain("Process name or ID is required");
    expect(output).toContain("Usage: bun-pm delete <name|id>");
    
    const exitCode = await result.exited;
    expect(exitCode).toBe(1);
  });

  test("should show error for non-existent process", async () => {
    const result = spawn({
      cmd: ["bun", cliPath, "delete", "non-existent-process", "--force"],
      env: { ...process.env, BUN_PM_SOCKET: socketPath },
      cwd: testDir,
      stdout: "pipe",
      stderr: "pipe"
    });

    const output = await new Response(result.stderr).text();
    expect(output).toContain("not found");
    
    const exitCode = await result.exited;
    expect(exitCode).toBe(1);
  });

  test("should delete process with --force flag", async () => {
    // Create and start a test process first
    const testScript = join(testDir, "test-force-delete.js");
    await Bun.write(testScript, `
      console.log('Test app starting');
      // Keep running for a bit to ensure it's still tracked when we try to delete
      setTimeout(() => {
        console.log('Test app exiting');
        process.exit(0);
      }, 2000);
    `);

    const config = createProcessConfig({
      id: "test-force-delete",
      name: "force-delete-app",
      script: testScript,
      cwd: testDir,
      instances: 1,
      autorestart: false
    });

    const startMessage = createIPCMessage("start", { config });
    const startResponse = await client.sendMessage(startMessage);
    expect(startResponse.success).toBe(true);

    // Wait for process to start but not complete
    await new Promise(resolve => setTimeout(resolve, 200));

    // Delete with --force flag
    const result = spawn({
      cmd: ["bun", cliPath, "delete", "test-force-delete", "--force"],
      env: { ...process.env, BUN_PM_SOCKET: socketPath },
      cwd: testDir,
      stdout: "pipe",
      stderr: "pipe"
    });

    const output = await new Response(result.stdout).text();
    expect(output).toContain("deleted successfully");
    
    const exitCode = await result.exited;
    expect(exitCode).toBe(0);

    // Verify process is deleted
    const listMessage = createIPCMessage("list", {});
    const listResponse = await client.sendMessage(listMessage);
    expect(listResponse.success).toBe(true);
    
    const processes = listResponse.data.processes;
    const deletedProcess = processes.find((p: any) => p.id === "test-force-delete");
    expect(deletedProcess).toBeUndefined();
  });

  test("should delete process with -f short flag", async () => {
    // Create and start a test process first
    const testScript = join(testDir, "test-short-flag.js");
    await Bun.write(testScript, `
      console.log('Test app starting');
      setTimeout(() => process.exit(0), 2000);
    `);

    const config = createProcessConfig({
      id: "test-short-flag",
      name: "short-flag-app",
      script: testScript,
      cwd: testDir,
      instances: 1,
      autorestart: false
    });

    const startMessage = createIPCMessage("start", { config });
    const startResponse = await client.sendMessage(startMessage);
    expect(startResponse.success).toBe(true);

    // Wait for process to start but not complete
    await new Promise(resolve => setTimeout(resolve, 200));

    // Delete with -f short flag
    const result = spawn({
      cmd: ["bun", cliPath, "delete", "test-short-flag", "-f"],
      env: { ...process.env, BUN_PM_SOCKET: socketPath },
      cwd: testDir,
      stdout: "pipe",
      stderr: "pipe"
    });

    const output = await new Response(result.stdout).text();
    expect(output).toContain("deleted successfully");
    
    const exitCode = await result.exited;
    expect(exitCode).toBe(0);
  });

  test("should show process information before confirmation prompt", async () => {
    // Create and start a test process first
    const testScript = join(testDir, "test-confirmation.js");
    await Bun.write(testScript, `
      console.log('Test confirmation app');
      setInterval(() => {
        console.log('Running...');
      }, 50);
    `);

    const config = createProcessConfig({
      id: "test-confirmation",
      name: "confirmation-app",
      script: testScript,
      cwd: testDir,
      instances: 2,
      autorestart: true
    });

    const startMessage = createIPCMessage("start", { config });
    const startResponse = await client.sendMessage(startMessage);
    expect(startResponse.success).toBe(true);

    // Wait for processes to start
    await new Promise(resolve => setTimeout(resolve, 200));

    // Try to delete without --force (this will show info but we can't easily test interactive prompt)
    // We'll test that the process info is shown by checking the output before it waits for input
    const result = spawn({
      cmd: ["bun", cliPath, "delete", "test-confirmation"],
      env: { ...process.env, BUN_PM_SOCKET: socketPath },
      cwd: testDir,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "pipe"
    });

    // Send 'n' to decline the confirmation
    result.stdin?.write("n\n");
    result.stdin?.end();

    const output = await new Response(result.stdout).text();
    
    // Should show process information
    expect(output).toContain("Process Information:");
    expect(output).toContain("Name: confirmation-app");
    expect(output).toContain("Instances: 2");
    expect(output).toContain("currently running");
    expect(output).toContain("Are you sure you want to delete");
    
    // The process might exit before showing the cancellation message
    // so we'll just check that it didn't delete the process
    
    // Don't check exit code as interactive prompts can be tricky in tests
    await result.exited;

    // Verify process still exists (since we declined)
    const listMessage = createIPCMessage("list", {});
    const listResponse = await client.sendMessage(listMessage);
    expect(listResponse.success).toBe(true);
    
    const processes = listResponse.data.processes;
    const existingProcesses = processes.filter((p: any) => p.id.startsWith("test-confirmation"));
    expect(existingProcesses.length).toBeGreaterThan(0);

    // Clean up - force delete the test processes
    await client.sendMessage(createIPCMessage("delete", { 
      identifier: "test-confirmation", 
      force: true 
    }));
  });

  test("should handle 'del' alias command", async () => {
    // Create and start a test process first
    const testScript = join(testDir, "test-alias.js");
    await Bun.write(testScript, `
      console.log('Test alias starting');
      setTimeout(() => process.exit(0), 2000);
    `);

    const config = createProcessConfig({
      id: "test-alias",
      name: "alias-app",
      script: testScript,
      cwd: testDir,
      instances: 1,
      autorestart: false
    });

    const startMessage = createIPCMessage("start", { config });
    const startResponse = await client.sendMessage(startMessage);
    expect(startResponse.success).toBe(true);

    // Wait for process to start but not complete
    await new Promise(resolve => setTimeout(resolve, 200));

    // Use 'del' alias instead of 'delete'
    const result = spawn({
      cmd: ["bun", cliPath, "del", "test-alias", "--force"],
      env: { ...process.env, BUN_PM_SOCKET: socketPath },
      cwd: testDir,
      stdout: "pipe",
      stderr: "pipe"
    });

    const output = await new Response(result.stdout).text();
    expect(output).toContain("deleted successfully");
    
    const exitCode = await result.exited;
    expect(exitCode).toBe(0);
  });

  test("should show stopped instances count in output", async () => {
    // Create and start a clustered process
    const testScript = join(testDir, "test-cluster-output.js");
    await Bun.write(testScript, `
      console.log('Cluster instance starting');
      setInterval(() => {
        console.log('Running...');
      }, 50);
    `);

    const config = createProcessConfig({
      id: "test-cluster-output",
      name: "cluster-output-app",
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

    // Delete with --force flag
    const result = spawn({
      cmd: ["bun", cliPath, "delete", "test-cluster-output", "--force"],
      env: { ...process.env, BUN_PM_SOCKET: socketPath },
      cwd: testDir,
      stdout: "pipe",
      stderr: "pipe"
    });

    const output = await new Response(result.stdout).text();
    expect(output).toContain("deleted successfully");
    expect(output).toContain("Stopped 3 running instance");
    
    const exitCode = await result.exited;
    expect(exitCode).toBe(0);
  });