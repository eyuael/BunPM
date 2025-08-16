import { test, expect, beforeEach, afterEach } from "bun:test";
import { DaemonManager, type DaemonInfo } from "../src/core/daemon-manager.js";
import { existsSync } from "fs";
import { unlink, mkdir } from "fs/promises";
import { resolve, dirname } from "path";

const TEST_SOCKET_PATH = "/tmp/bun-pm-test-daemon.sock";

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
    
    // Ensure test directory exists
    const testDir = dirname(TEST_SOCKET_PATH);
    if (!existsSync(testDir)) {
      await mkdir(testDir, { recursive: true });
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

test("DaemonManager - PID file management", async () => {
  const daemonManager = new DaemonManager(TEST_SOCKET_PATH);
  
  // Initially no PID file should exist
  const initialInfo = await daemonManager.readPidFile();
  expect(initialInfo).toBeNull();
  
  // Write PID file
  const testPid = process.pid;
  await daemonManager.writePidFile(testPid);
  
  // Read PID file back
  const daemonInfo = await daemonManager.readPidFile();
  expect(daemonInfo).not.toBeNull();
  expect(daemonInfo!.pid).toBe(testPid);
  expect(daemonInfo!.socketPath).toBe(TEST_SOCKET_PATH);
  expect(daemonInfo!.startTime).toBeInstanceOf(Date);
  
  // Remove PID file
  await daemonManager.removePidFile();
  
  // Verify it's gone
  const finalInfo = await daemonManager.readPidFile();
  expect(finalInfo).toBeNull();
});

test("DaemonManager - process running check", async () => {
  const daemonManager = new DaemonManager(TEST_SOCKET_PATH);
  
  // Current process should be running
  const isRunning = await daemonManager.isDaemonProcessRunning(process.pid);
  expect(isRunning).toBe(true);
  
  // Non-existent process should not be running
  const isNotRunning = await daemonManager.isDaemonProcessRunning(999999);
  expect(isNotRunning).toBe(false);
});

test("DaemonManager - daemon status when not running", async () => {
  const daemonManager = new DaemonManager(TEST_SOCKET_PATH);
  
  const status = await daemonManager.getDaemonStatus();
  
  expect(status.isRunning).toBe(false);
  expect(status.pidFileExists).toBe(false);
  expect(status.processRunning).toBe(false);
  expect(status.socketResponding).toBe(false);
  expect(status.daemonInfo).toBeNull();
  expect(status.healthStatus).toBe('unknown');
});

test("DaemonManager - daemon status with stale PID file", async () => {
  const daemonManager = new DaemonManager(TEST_SOCKET_PATH);
  
  // Create a PID file with a non-existent process
  await daemonManager.writePidFile(999999);
  
  const status = await daemonManager.getDaemonStatus();
  
  expect(status.pidFileExists).toBe(true);
  expect(status.processRunning).toBe(false);
  expect(status.socketResponding).toBe(false);
  expect(status.healthStatus).toBe('unhealthy');
});

test("DaemonManager - cleanup stale state", async () => {
  const daemonManager = new DaemonManager(TEST_SOCKET_PATH);
  
  // Create a stale PID file
  await daemonManager.writePidFile(999999);
  
  // Verify PID file exists
  let daemonInfo = await daemonManager.readPidFile();
  expect(daemonInfo).not.toBeNull();
  
  // Clean up stale state
  await daemonManager.cleanupStaleState();
  
  // Verify PID file is removed
  daemonInfo = await daemonManager.readPidFile();
  expect(daemonInfo).toBeNull();
});

test("DaemonManager - daemon status with healthy daemon simulation", async () => {
  const daemonManager = new DaemonManager(TEST_SOCKET_PATH);
  
  // Simulate a healthy daemon by creating PID file with current process
  await daemonManager.writePidFile(process.pid);
  
  const status = await daemonManager.getDaemonStatus();
  
  expect(status.pidFileExists).toBe(true);
  expect(status.processRunning).toBe(true);
  expect(status.daemonInfo).not.toBeNull();
  expect(status.daemonInfo!.pid).toBe(process.pid);
  
  // Note: socketResponding will be false since we're not actually running a daemon
  // but the test verifies the PID file management works correctly
});

test("DaemonManager - error handling for invalid PID file", async () => {
  const daemonManager = new DaemonManager(TEST_SOCKET_PATH);
  
  // Get the actual PID file path that DaemonManager uses
  const pidFilePath = resolve(dirname(TEST_SOCKET_PATH), 'daemon.pid');
  
  // Create an invalid PID file
  const fs = require('fs');
  fs.writeFileSync(pidFilePath, "invalid json content");
  
  // Should handle invalid JSON gracefully
  const daemonInfo = await daemonManager.readPidFile();
  expect(daemonInfo).toBeNull();
  
  // Clean up
  try {
    await unlink(pidFilePath);
  } catch (error) {
    // Ignore cleanup errors
  }
});