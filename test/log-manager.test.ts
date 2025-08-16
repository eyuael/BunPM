import { test, expect, beforeEach, afterEach } from "bun:test";
import { LogManager } from "../src/core/log-manager.js";
import { rmSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { spawn } from "bun";

const TEST_LOG_DIR = join(process.cwd(), "test-logs");

beforeEach(() => {
  // Clean up test directory
  if (existsSync(TEST_LOG_DIR)) {
    rmSync(TEST_LOG_DIR, { recursive: true, force: true });
  }
  mkdirSync(TEST_LOG_DIR, { recursive: true });
});

afterEach(() => {
  // Clean up test directory
  if (existsSync(TEST_LOG_DIR)) {
    rmSync(TEST_LOG_DIR, { recursive: true, force: true });
  }
});

test("LogManager creates log directory structure", async () => {
  const logManager = new LogManager(TEST_LOG_DIR);
  const processId = "test-process-1";
  
  // Create a simple subprocess for testing
  const subprocess = spawn(["echo", "hello world"], {
    stdout: "pipe",
    stderr: "pipe"
  });
  
  logManager.captureOutput(processId, subprocess);
  
  // Wait a bit for directory creation
  await new Promise(resolve => setTimeout(resolve, 100));
  
  const processLogDir = join(TEST_LOG_DIR, processId);
  expect(existsSync(processLogDir)).toBe(true);
  
  logManager.stopCapture(processId);
  await subprocess.exited;
});

test("LogManager captures stdout and stderr", async () => {
  const logManager = new LogManager(TEST_LOG_DIR);
  const processId = "test-process-2";
  
  // Create subprocess that outputs to both stdout and stderr
  const subprocess = spawn(["sh", "-c", "echo 'stdout message'; echo 'stderr message' >&2"], {
    stdout: "pipe",
    stderr: "pipe"
  });
  
  logManager.captureOutput(processId, subprocess);
  
  // Wait for process to complete and logs to be written
  await subprocess.exited;
  await new Promise(resolve => setTimeout(resolve, 200));
  
  const outLogPath = join(TEST_LOG_DIR, processId, "out.log");
  const errLogPath = join(TEST_LOG_DIR, processId, "error.log");
  
  expect(existsSync(outLogPath)).toBe(true);
  expect(existsSync(errLogPath)).toBe(true);
  
  const outContent = await Bun.file(outLogPath).text();
  const errContent = await Bun.file(errLogPath).text();
  
  expect(outContent).toContain("stdout message");
  expect(errContent).toContain("stderr message");
  
  logManager.stopCapture(processId);
});

test("LogManager getLogs returns correct number of lines", async () => {
  const logManager = new LogManager(TEST_LOG_DIR);
  const processId = "test-process-3";
  
  // Create subprocess that outputs multiple lines
  const subprocess = spawn(["sh", "-c", "for i in {1..5}; do echo \"Line $i\"; done"], {
    stdout: "pipe",
    stderr: "pipe"
  });
  
  logManager.captureOutput(processId, subprocess);
  
  // Wait for process to complete and logs to be written
  await subprocess.exited;
  await new Promise(resolve => setTimeout(resolve, 200));
  
  const logs = await logManager.getLogs(processId, 3);
  expect(logs.length).toBeLessThanOrEqual(3);
  
  const allLogs = await logManager.getLogs(processId);
  expect(allLogs.length).toBeGreaterThan(0);
  
  logManager.stopCapture(processId);
});

test("LogManager handles log rotation", async () => {
  const logManager = new LogManager(TEST_LOG_DIR);
  const processId = "test-process-4";
  
  // Create a large log file by writing directly
  const outLogPath = join(TEST_LOG_DIR, processId, "out.log");
  mkdirSync(join(TEST_LOG_DIR, processId), { recursive: true });
  
  // Write a large amount of data (more than 10MB)
  const largeContent = "x".repeat(11 * 1024 * 1024); // 11MB
  await Bun.write(outLogPath, largeContent);
  
  // Trigger rotation
  await logManager.rotateLogs(processId);
  
  const rotatedLogPath = join(TEST_LOG_DIR, processId, "out.log.1");
  expect(existsSync(rotatedLogPath)).toBe(true);
  
  // Original log should be cleared
  const currentLogContent = await Bun.file(outLogPath).text();
  expect(currentLogContent).toBe("");
});

test("LogManager stopCapture cleans up resources", () => {
  const logManager = new LogManager(TEST_LOG_DIR);
  const processId = "test-process-5";
  
  const subprocess = spawn(["sleep", "1"], {
    stdout: "pipe",
    stderr: "pipe"
  });
  
  logManager.captureOutput(processId, subprocess);
  
  // Stop capture should not throw
  expect(() => logManager.stopCapture(processId)).not.toThrow();
  
  // Stopping again should also not throw
  expect(() => logManager.stopCapture(processId)).not.toThrow();
  
  subprocess.kill();
});

test("LogManager handles invalid process IDs gracefully", async () => {
  const logManager = new LogManager(TEST_LOG_DIR);
  
  // Getting logs for non-existent process should return empty array
  const logs = await logManager.getLogs("non-existent-process");
  expect(logs).toEqual([]);
  
  // Rotating logs for non-existent process should not throw
  await expect(async () => {
    await logManager.rotateLogs("non-existent-process");
  }).not.toThrow();
  
  // Stopping capture for non-existent process should not throw
  expect(() => logManager.stopCapture("non-existent-process")).not.toThrow();
});

test("LogManager formats log entries with timestamps", async () => {
  const logManager = new LogManager(TEST_LOG_DIR);
  const processId = "test-process-6";
  
  const subprocess = spawn(["echo", "test message"], {
    stdout: "pipe",
    stderr: "pipe"
  });
  
  logManager.captureOutput(processId, subprocess);
  
  await subprocess.exited;
  await new Promise(resolve => setTimeout(resolve, 200));
  
  const logs = await logManager.getLogs(processId);
  expect(logs.length).toBeGreaterThan(0);
  
  // Check that logs contain timestamp format
  const logLine = logs[0];
  expect(logLine).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]/);
  expect(logLine).toContain("test message");
  
  logManager.stopCapture(processId);
});