import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { ProcessDaemon } from "../src/daemon/daemon.js";
import { existsSync } from "fs";
import { unlink } from "fs/promises";

describe("ProcessDaemon", () => {
  let daemon: ProcessDaemon;
  let testSocketPath: string;

  beforeEach(() => {
    // Use unique socket path for each test
    testSocketPath = `/tmp/bun-pm-test-${Date.now()}.sock`;
    daemon = new ProcessDaemon(testSocketPath);
  });

  afterEach(async () => {
    // Clean up daemon
    if (daemon.isActive()) {
      await daemon.stop();
    }

    // Clean up test files
    try {
      if (existsSync(testSocketPath)) {
        await unlink(testSocketPath);
      }
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  test("should start and stop daemon", async () => {
    expect(daemon.isActive()).toBe(false);

    await daemon.start();
    expect(daemon.isActive()).toBe(true);

    await daemon.stop();
    expect(daemon.isActive()).toBe(false);
  });

  test("should not allow starting daemon twice", async () => {
    await daemon.start();
    
    await expect(daemon.start()).rejects.toThrow("Daemon is already running");
    
    await daemon.stop();
  });

  test("should handle graceful shutdown when not running", async () => {
    expect(daemon.isActive()).toBe(false);
    
    // Should not throw error
    await daemon.stop();
    
    expect(daemon.isActive()).toBe(false);
  });

  test("should create daemon directory if it doesn't exist", async () => {
    const customSocketPath = `/tmp/bun-pm-test-dir-${Date.now()}/daemon.sock`;
    const customDaemon = new ProcessDaemon(customSocketPath);
    
    await customDaemon.start();
    expect(customDaemon.isActive()).toBe(true);
    
    await customDaemon.stop();
  });
});