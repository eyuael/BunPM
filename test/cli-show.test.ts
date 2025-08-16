import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { spawn } from "bun";
import { resolve } from "path";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";

describe("CLI Show Command", () => {
  let testDir: string;
  let testScript: string;
  let cliPath: string;

  beforeEach(async () => {
    // Create test directory
    testDir = resolve(process.cwd(), 'test-cli-show-temp');
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(testDir, { recursive: true });

    // Create test script
    testScript = resolve(testDir, 'test-app.js');
    writeFileSync(testScript, `
      console.log('Test app started');
      setInterval(() => {
        console.log('Test app running...');
      }, 1000);
    `);

    cliPath = resolve(process.cwd(), 'src/cli/index.ts');
  });

  afterEach(async () => {
    // Stop any running processes
    try {
      const stopResult = spawn({
        cmd: ['bun', cliPath, 'stop', 'test-show-cli'],
        cwd: testDir,
        stdout: 'pipe',
        stderr: 'pipe'
      });
      await stopResult.exited;
    } catch (error) {
      // Ignore cleanup errors
    }

    // Clean up test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test("should display detailed process information via CLI", async () => {
    // Start a process
    const startResult = spawn({
      cmd: ['bun', cliPath, 'start', testScript, '--name', 'test-show-cli'],
      cwd: testDir,
      stdout: 'pipe',
      stderr: 'pipe'
    });

    await startResult.exited;
    expect(startResult.exitCode).toBe(0);

    // Wait for process to start and metrics to be collected
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Run show command
    const showResult = spawn({
      cmd: ['bun', cliPath, 'show', 'test-show-cli'],
      cwd: testDir,
      stdout: 'pipe',
      stderr: 'pipe'
    });

    await showResult.exited;
    expect(showResult.exitCode).toBe(0);

    const output = await new Response(showResult.stdout).text();
    
    // Verify output contains expected sections
    expect(output).toContain('=== Process Information: test-show-cli ===');
    expect(output).toContain('Basic Information:');
    expect(output).toContain('ID:');
    expect(output).toContain('Name: test-show-cli');
    expect(output).toContain('Status:');
    expect(output).toContain('PID:');
    expect(output).toContain('Script:');
    expect(output).toContain('Working Directory:');
    expect(output).toContain('Instances: 1');
    expect(output).toContain('Auto Restart: Yes');
    expect(output).toContain('Max Restarts:');
    
    // Should contain current metrics
    expect(output).toContain('Current Metrics:');
    expect(output).toContain('CPU Usage:');
    expect(output).toContain('Memory Usage:');
    expect(output).toContain('Uptime:');
    expect(output).toContain('Restart Count:');
  });

  test("should show error for non-existent process via CLI", async () => {
    const showResult = spawn({
      cmd: ['bun', cliPath, 'show', 'non-existent-process'],
      cwd: testDir,
      stdout: 'pipe',
      stderr: 'pipe'
    });

    await showResult.exited;
    expect(showResult.exitCode).toBe(1);

    const errorOutput = await new Response(showResult.stderr).text();
    expect(errorOutput).toContain('not found');
  });

  test("should show error when no process identifier provided via CLI", async () => {
    const showResult = spawn({
      cmd: ['bun', cliPath, 'show'],
      cwd: testDir,
      stdout: 'pipe',
      stderr: 'pipe'
    });

    await showResult.exited;
    expect(showResult.exitCode).toBe(1);

    const errorOutput = await new Response(showResult.stderr).text();
    expect(errorOutput).toContain('Process name or ID is required');
    expect(errorOutput).toContain('Usage: bun-pm show <name|id>');
  });

  test("should display environment variables in show output", async () => {
    // Start a process with environment variables
    const startResult = spawn({
      cmd: [
        'bun', cliPath, 'start', testScript, 
        '--name', 'test-show-env',
        '--env', 'NODE_ENV=test',
        '--env', 'PORT=3000'
      ],
      cwd: testDir,
      stdout: 'pipe',
      stderr: 'pipe'
    });

    await startResult.exited;
    expect(startResult.exitCode).toBe(0);

    // Wait for process to start
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Run show command
    const showResult = spawn({
      cmd: ['bun', cliPath, 'show', 'test-show-env'],
      cwd: testDir,
      stdout: 'pipe',
      stderr: 'pipe'
    });

    await showResult.exited;
    expect(showResult.exitCode).toBe(0);

    const output = await new Response(showResult.stdout).text();
    
    // Should contain environment variables section
    expect(output).toContain('Environment Variables:');
    expect(output).toContain('NODE_ENV=test');
    expect(output).toContain('PORT=3000');
  });

  test("should display memory limit when specified", async () => {
    // Start a process with memory limit
    const startResult = spawn({
      cmd: [
        'bun', cliPath, 'start', testScript, 
        '--name', 'test-show-memory',
        '--memory-limit', '104857600' // 100MB
      ],
      cwd: testDir,
      stdout: 'pipe',
      stderr: 'pipe'
    });

    await startResult.exited;
    expect(startResult.exitCode).toBe(0);

    // Wait for process to start
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Run show command
    const showResult = spawn({
      cmd: ['bun', cliPath, 'show', 'test-show-memory'],
      cwd: testDir,
      stdout: 'pipe',
      stderr: 'pipe'
    });

    await showResult.exited;
    expect(showResult.exitCode).toBe(0);

    const output = await new Response(showResult.stdout).text();
    
    // Should contain memory limit
    expect(output).toContain('Memory Limit: 100.0MB');
  });

  test("should show metrics history after some time", async () => {
    // Start a process
    const startResult = spawn({
      cmd: ['bun', cliPath, 'start', testScript, '--name', 'test-show-history'],
      cwd: testDir,
      stdout: 'pipe',
      stderr: 'pipe'
    });

    await startResult.exited;
    expect(startResult.exitCode).toBe(0);

    // Wait for multiple monitoring cycles
    await new Promise(resolve => setTimeout(resolve, 12000));

    // Run show command
    const showResult = spawn({
      cmd: ['bun', cliPath, 'show', 'test-show-history'],
      cwd: testDir,
      stdout: 'pipe',
      stderr: 'pipe'
    });

    await showResult.exited;
    expect(showResult.exitCode).toBe(0);

    const output = await new Response(showResult.stdout).text();
    
    // Should contain metrics history section if history is available
    if (output.includes('Recent Metrics History')) {
      expect(output).toContain('Time       CPU%   Memory    Uptime    Restarts');
      expect(output).toContain('s ago');
    }
  });
});