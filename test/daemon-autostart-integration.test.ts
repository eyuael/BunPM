import { test, expect, beforeEach, afterEach } from "bun:test";
import { DaemonManager } from "../src/core/daemon-manager.js";
import { getDefaultSocketPath } from "../src/ipc/index.js";
import { spawn } from "bun";
import { existsSync } from "fs";
import { unlink } from "fs/promises";
import { resolve, dirname } from "path";

const TEST_SOCKET_PATH = "/tmp/bun-pm-integration-test.sock";

function getTestPidFilePath(): string {
  return resolve(dirname(TEST_SOCKET_PATH), 'daemon.pid');
}

beforeEach(async () => {
  // Clean up any existing test files
  try {
    const testPidFile = getTestPidFilePath();
    
    if (existsSync(TEST_SOCKET_PATH)) {
      await unlink(TEST_SOCKET_PATH);
    }
    if (existsSync(testPidFile)) {
      await unlink(testPidFile);
    }
  } catch (error) {
    // Ignore cleanup errors
  }
});

afterEach(async () => {
  // Clean up test files
  try {
    const testPidFile = getTestPidFilePath();
    
    if (existsSync(TEST_SOCKET_PATH)) {
      await unlink(TEST_SOCKET_PATH);
    }
    if (existsSync(testPidFile)) {
      await unlink(testPidFile);
    }
  } catch (error) {
    // Ignore cleanup errors
  }
});

test("Daemon auto-start integration - CLI commands auto-start daemon", async () => {
  const daemonManager = new DaemonManager(TEST_SOCKET_PATH);
  
  // Initially daemon should not be running
  const initialStatus = await daemonManager.getDaemonStatus();
  expect(initialStatus.healthStatus).toBe('unknown');
  
  // Test that ensureDaemonRunning starts the daemon
  await daemonManager.ensureDaemonRunning();
  
  // Verify daemon is now healthy
  const runningStatus = await daemonManager.getDaemonStatus();
  expect(runningStatus.healthStatus).toBe('healthy');
  expect(runningStatus.pidFileExists).toBe(true);
  expect(runningStatus.processRunning).toBe(true);
  expect(runningStatus.socketResponding).toBe(true);
  
  // Clean up
  await daemonManager.stopDaemon();
}, 10000);

test("Daemon auto-start integration - daemon status command works", async () => {
  // Test daemon status command via CLI
  const statusResult = spawn({
    cmd: ["bun", "run", "src/cli/index.ts", "daemon", "status"],
    env: { ...process.env, BUN_PM_SOCKET_PATH: TEST_SOCKET_PATH },
    stdio: ["pipe", "pipe", "pipe"]
  });
  
  const statusOutput = await new Response(statusResult.stdout).text();
  expect(statusOutput).toContain("Overall Status: UNKNOWN");
  expect(statusOutput).toContain("Socket Responding: ✗");
  expect(statusOutput).toContain("PID File Exists: ✗");
  expect(statusOutput).toContain("Process Running: ✗");
}, 5000);

test("Daemon auto-start integration - daemon start command works", async () => {
  // Test daemon start command via CLI
  const startResult = spawn({
    cmd: ["bun", "run", "src/cli/index.ts", "daemon", "start"],
    env: { ...process.env, BUN_PM_SOCKET_PATH: TEST_SOCKET_PATH },
    stdio: ["pipe", "pipe", "pipe"]
  });
  
  const startOutput = await new Response(startResult.stdout).text();
  expect(startOutput).toContain("Starting daemon...");
  expect(startOutput).toContain("✓ Daemon started successfully");
  
  // Verify daemon is running
  const daemonManager = new DaemonManager(TEST_SOCKET_PATH);
  
  // Wait a moment for daemon to fully start
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  const status = await daemonManager.getDaemonStatus();
  expect(status.healthStatus).toBe('healthy');
  
  // Clean up
  await daemonManager.stopDaemon();
}, 10000);

test("Daemon auto-start integration - PID file management works correctly", async () => {
  const daemonManager = new DaemonManager(TEST_SOCKET_PATH);
  
  // Start daemon
  await daemonManager.startDaemon();
  
  // Verify PID file exists and contains correct information
  const daemonInfo = await daemonManager.readPidFile();
  expect(daemonInfo).not.toBeNull();
  expect(daemonInfo!.socketPath).toBe(TEST_SOCKET_PATH);
  expect(daemonInfo!.pid).toBeGreaterThan(0);
  expect(daemonInfo!.startTime).toBeInstanceOf(Date);
  
  // Stop daemon
  await daemonManager.stopDaemon();
  
  // Verify PID file is cleaned up
  const cleanedInfo = await daemonManager.readPidFile();
  expect(cleanedInfo).toBeNull();
}, 10000);

test("Daemon auto-start integration - health verification works", async () => {
  const daemonManager = new DaemonManager(TEST_SOCKET_PATH);
  
  // Test unknown state (no daemon)
  let status = await daemonManager.getDaemonStatus();
  expect(status.healthStatus).toBe('unknown');
  
  // Start daemon
  await daemonManager.startDaemon();
  
  // Test healthy state
  status = await daemonManager.getDaemonStatus();
  expect(status.healthStatus).toBe('healthy');
  expect(status.isRunning).toBe(true);
  expect(status.pidFileExists).toBe(true);
  expect(status.processRunning).toBe(true);
  expect(status.socketResponding).toBe(true);
  
  // Stop daemon
  await daemonManager.stopDaemon();
  
  // Test back to unknown state
  status = await daemonManager.getDaemonStatus();
  expect(status.healthStatus).toBe('unknown');
}, 10000);

test("Daemon auto-start integration - stale state cleanup works", async () => {
  const daemonManager = new DaemonManager(TEST_SOCKET_PATH);
  
  // Create a stale PID file with non-existent process
  await daemonManager.writePidFile(999999);
  
  // Verify stale state is detected
  let status = await daemonManager.getDaemonStatus();
  expect(status.healthStatus).toBe('unhealthy');
  expect(status.pidFileExists).toBe(true);
  expect(status.processRunning).toBe(false);
  
  // Clean up stale state
  await daemonManager.cleanupStaleState();
  
  // Verify cleanup worked
  status = await daemonManager.getDaemonStatus();
  expect(status.healthStatus).toBe('unknown');
  expect(status.pidFileExists).toBe(false);
}, 5000);