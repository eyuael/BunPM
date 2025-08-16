import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { spawn } from "bun";
import { join, resolve } from "path";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "fs";
import { tmpdir } from "os";

describe("CLI Workflow Integration Tests", () => {
  const cliPath = join(import.meta.dir, "../../src/cli/index.ts");
  let testDir: string;
  let testScript: string;
  let ecosystemFile: string;

  beforeEach(() => {
    // Create unique test directory
    testDir = resolve(tmpdir(), `bun-pm-cli-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    
    // Create test script
    testScript = resolve(testDir, "test-app.js");
    writeFileSync(testScript, `
      console.log("Test app started");
      let counter = 0;
      setInterval(() => {
        console.log(\`Test app running: \${++counter}\`);
      }, 1000);
    `);

    // Create ecosystem file
    ecosystemFile = resolve(testDir, "ecosystem.json");
    const ecosystemConfig = {
      apps: [
        {
          id: "test-app-1",
          name: "test-app-1",
          script: "./test-app.js",
          cwd: testDir,
          env: { NODE_ENV: "test", PORT: "3001" },
          instances: 1,
          autorestart: true
        },
        {
          id: "test-app-2",
          name: "test-app-2", 
          script: "./test-app.js",
          cwd: testDir,
          env: { NODE_ENV: "test", PORT: "3002" },
          instances: 2,
          autorestart: false
        }
      ]
    };
    writeFileSync(ecosystemFile, JSON.stringify(ecosystemConfig, null, 2));
  });

  afterEach(async () => {
    // Stop all processes
    try {
      const stopAllProc = spawn({
        cmd: ["bun", cliPath, "stop", "all"],
        stdout: "pipe",
        stderr: "pipe"
      });
      await stopAllProc.exited;
    } catch (error) {
      // Ignore cleanup errors
    }

    // Clean up test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test("complete workflow: start -> list -> logs -> restart -> stop", async () => {
    // Start a process
    const startProc = spawn({
      cmd: ["bun", cliPath, "start", testScript, "--name", "workflow-test"],
      stdout: "pipe",
      stderr: "pipe"
    });
    
    const startOutput = await new Response(startProc.stdout).text();
    expect(startOutput).toContain("Process started successfully");
    expect(startOutput).toContain("workflow-test");

    // Wait for process to start
    await new Promise(resolve => setTimeout(resolve, 1000));

    // List processes
    const listProc = spawn({
      cmd: ["bun", cliPath, "list"],
      stdout: "pipe",
      stderr: "pipe"
    });
    
    const listOutput = await new Response(listProc.stdout).text();
    expect(listOutput).toContain("workflow-test");
    expect(listOutput).toContain("running");

    // Check logs
    const logsProc = spawn({
      cmd: ["bun", cliPath, "logs", "workflow-test", "--lines", "5"],
      stdout: "pipe",
      stderr: "pipe"
    });
    
    const logsOutput = await new Response(logsProc.stdout).text();
    expect(logsOutput).toContain("Test app started");

    // Restart process
    const restartProc = spawn({
      cmd: ["bun", cliPath, "restart", "workflow-test"],
      stdout: "pipe",
      stderr: "pipe"
    });
    
    const restartOutput = await new Response(restartProc.stdout).text();
    expect(restartOutput).toContain("Process restarted successfully");

    // Wait for restart
    await new Promise(resolve => setTimeout(resolve, 500));

    // Verify process is still running
    const listAfterRestartProc = spawn({
      cmd: ["bun", cliPath, "list"],
      stdout: "pipe",
      stderr: "pipe"
    });
    
    const listAfterRestartOutput = await new Response(listAfterRestartProc.stdout).text();
    expect(listAfterRestartOutput).toContain("workflow-test");
    expect(listAfterRestartOutput).toContain("running");

    // Stop process
    const stopProc = spawn({
      cmd: ["bun", cliPath, "stop", "workflow-test"],
      stdout: "pipe",
      stderr: "pipe"
    });
    
    const stopOutput = await new Response(stopProc.stdout).text();
    expect(stopOutput).toContain("Process stopped successfully");

    // Verify process is stopped
    const finalListProc = spawn({
      cmd: ["bun", cliPath, "list"],
      stdout: "pipe",
      stderr: "pipe"
    });
    
    const finalListOutput = await new Response(finalListProc.stdout).text();
    expect(finalListOutput).toContain("No processes running");
  }, 15000);

  test("ecosystem workflow: start from file -> scale -> save -> delete", async () => {
    // Start from ecosystem file
    const startEcosystemProc = spawn({
      cmd: ["bun", cliPath, "start", ecosystemFile],
      stdout: "pipe",
      stderr: "pipe"
    });
    
    const startEcosystemOutput = await new Response(startEcosystemProc.stdout).text();
    expect(startEcosystemOutput).toContain("Started 2 applications");

    // Wait for processes to start
    await new Promise(resolve => setTimeout(resolve, 1000));

    // List processes to verify
    const listProc = spawn({
      cmd: ["bun", cliPath, "list"],
      stdout: "pipe",
      stderr: "pipe"
    });
    
    const listOutput = await new Response(listProc.stdout).text();
    expect(listOutput).toContain("test-app-1");
    expect(listOutput).toContain("test-app-2_0");
    expect(listOutput).toContain("test-app-2_1");

    // Scale test-app-1 to 3 instances
    const scaleProc = spawn({
      cmd: ["bun", cliPath, "scale", "test-app-1", "3"],
      stdout: "pipe",
      stderr: "pipe"
    });
    
    const scaleOutput = await new Response(scaleProc.stdout).text();
    expect(scaleOutput).toContain("Scaled test-app-1 to 3 instances");

    // Wait for scaling
    await new Promise(resolve => setTimeout(resolve, 500));

    // Verify scaling
    const listAfterScaleProc = spawn({
      cmd: ["bun", cliPath, "list"],
      stdout: "pipe",
      stderr: "pipe"
    });
    
    const listAfterScaleOutput = await new Response(listAfterScaleProc.stdout).text();
    expect(listAfterScaleOutput).toContain("test-app-1_0");
    expect(listAfterScaleOutput).toContain("test-app-1_1");
    expect(listAfterScaleOutput).toContain("test-app-1_2");

    // Save current configuration
    const saveFile = resolve(testDir, "saved-ecosystem.json");
    const saveProc = spawn({
      cmd: ["bun", cliPath, "save", saveFile],
      stdout: "pipe",
      stderr: "pipe"
    });
    
    const saveOutput = await new Response(saveProc.stdout).text();
    expect(saveOutput).toContain("Configuration saved");
    expect(existsSync(saveFile)).toBe(true);

    // Delete one process
    const deleteProc = spawn({
      cmd: ["bun", cliPath, "delete", "test-app-2"],
      stdout: "pipe",
      stderr: "pipe"
    });
    
    const deleteOutput = await new Response(deleteProc.stdout).text();
    expect(deleteOutput).toContain("Process deleted successfully");

    // Verify deletion
    const finalListProc = spawn({
      cmd: ["bun", cliPath, "list"],
      stdout: "pipe",
      stderr: "pipe"
    });
    
    const finalListOutput = await new Response(finalListProc.stdout).text();
    expect(finalListOutput).not.toContain("test-app-2");
    expect(finalListOutput).toContain("test-app-1");
  }, 20000);

  test("monitoring workflow: start -> show -> monit", async () => {
    // Start a process with memory limit
    const startProc = spawn({
      cmd: ["bun", cliPath, "start", testScript, "--name", "monitor-test", "--memory-limit", "50"],
      stdout: "pipe",
      stderr: "pipe"
    });
    
    await startProc.exited;

    // Wait for process to start and generate some metrics
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Show detailed process information
    const showProc = spawn({
      cmd: ["bun", cliPath, "show", "monitor-test"],
      stdout: "pipe",
      stderr: "pipe"
    });
    
    const showOutput = await new Response(showProc.stdout).text();
    expect(showOutput).toContain("monitor-test");
    expect(showOutput).toContain("Memory Limit");
    expect(showOutput).toContain("50 MB");
    expect(showOutput).toContain("CPU Usage");
    expect(showOutput).toContain("Memory Usage");

    // Monitor all processes
    const monitProc = spawn({
      cmd: ["bun", cliPath, "monit"],
      stdout: "pipe",
      stderr: "pipe"
    });
    
    // Kill monit after 2 seconds since it runs continuously
    setTimeout(() => monitProc.kill(), 2000);
    
    const monitOutput = await new Response(monitProc.stdout).text();
    expect(monitOutput).toContain("monitor-test");
    expect(monitOutput).toContain("CPU");
    expect(monitOutput).toContain("Memory");
  }, 15000);

  test("error handling workflow: invalid commands and recovery", async () => {
    // Try to stop non-existent process
    const stopNonExistentProc = spawn({
      cmd: ["bun", cliPath, "stop", "non-existent"],
      stdout: "pipe",
      stderr: "pipe"
    });
    
    const stopError = await new Response(stopNonExistentProc.stderr).text();
    expect(stopError).toContain("No processes found");

    // Try to start non-existent script
    const startInvalidProc = spawn({
      cmd: ["bun", cliPath, "start", "/non/existent/script.js"],
      stdout: "pipe",
      stderr: "pipe"
    });
    
    const startError = await new Response(startInvalidProc.stderr).text();
    expect(startError).toContain("Script file not found");

    // Try to load invalid ecosystem file
    const invalidEcosystemFile = resolve(testDir, "invalid.json");
    writeFileSync(invalidEcosystemFile, "{ invalid json }");
    
    const loadInvalidProc = spawn({
      cmd: ["bun", cliPath, "start", invalidEcosystemFile],
      stdout: "pipe",
      stderr: "pipe"
    });
    
    const loadError = await new Response(loadInvalidProc.stderr).text();
    expect(loadError).toContain("Invalid JSON");

    // Verify daemon is still responsive after errors
    const listProc = spawn({
      cmd: ["bun", cliPath, "list"],
      stdout: "pipe",
      stderr: "pipe"
    });
    
    const listOutput = await new Response(listProc.stdout).text();
    expect(listOutput).toContain("No processes running");
  }, 10000);
});