import { test, expect } from "bun:test";
import { MonitorManager } from "../src/core/monitor-manager.js";

test("MonitorManager - should start and stop monitoring", () => {
  const monitorManager = new MonitorManager();
    const processId = "test-process";
    const pid = 12345;
    const startTime = new Date();

    // Start monitoring
    monitorManager.startMonitoring(processId, pid, startTime);

    // Should have metrics (initially zero)
    const metrics = monitorManager.getMetrics(processId);
    expect(metrics).toBeDefined();
    expect(metrics?.cpu).toBe(0);
    expect(metrics?.memory).toBe(0);
    expect(metrics?.uptime).toBeGreaterThanOrEqual(0);
    expect(metrics?.restarts).toBe(0);

    // Stop monitoring
    monitorManager.stopMonitoring(processId);

    // Should no longer have metrics
    const metricsAfterStop = monitorManager.getMetrics(processId);
    expect(metricsAfterStop).toBeNull();

    monitorManager.cleanup();
});

test("MonitorManager - should get all metrics", () => {
  const monitorManager = new MonitorManager();
    const processId1 = "test-process-1";
    const processId2 = "test-process-2";
    const pid1 = 12345;
    const pid2 = 12346;

    // Start monitoring multiple processes
    monitorManager.startMonitoring(processId1, pid1);
    monitorManager.startMonitoring(processId2, pid2);

    const allMetrics = monitorManager.getAllMetrics();
    expect(Object.keys(allMetrics)).toHaveLength(2);
    expect(allMetrics[processId1]).toBeDefined();
    expect(allMetrics[processId2]).toBeDefined();

    monitorManager.cleanup();
});

test("MonitorManager - should check memory limits", () => {
  const monitorManager = new MonitorManager();
    const processId = "test-process";
    const pid = 12345;
    const memoryLimit = 1024 * 1024; // 1MB

    // Start monitoring
    monitorManager.startMonitoring(processId, pid);

    // Should not exceed limit initially (memory is 0)
    expect(monitorManager.checkMemoryLimit(processId, memoryLimit)).toBe(false);

    // Should return false for non-existent process
    expect(monitorManager.checkMemoryLimit("non-existent", memoryLimit)).toBe(false);

    monitorManager.cleanup();
});

test("MonitorManager - should update restart count", () => {
  const monitorManager = new MonitorManager();
    const processId = "test-process";
    const pid = 12345;

    // Start monitoring
    monitorManager.startMonitoring(processId, pid);

    // Update restart count
    monitorManager.updateRestartCount(processId, 5);

    // Should reflect in metrics (if history exists)
    const history = monitorManager.getMetricsHistory(processId);
    if (history.length > 0) {
      expect(history[history.length - 1].restarts).toBe(5);
    }

    monitorManager.cleanup();
});

test("MonitorManager - should get system info", async () => {
  const monitorManager = new MonitorManager();
    const systemInfo = await monitorManager.getSystemInfo();
    
    expect(systemInfo).toBeDefined();
    expect(typeof systemInfo.totalMemory).toBe("number");
    expect(typeof systemInfo.freeMemory).toBe("number");
    expect(typeof systemInfo.cpuCount).toBe("number");
    expect(systemInfo.cpuCount).toBeGreaterThan(0);

    monitorManager.cleanup();
});

test("MonitorManager - should get metrics history", () => {
  const monitorManager = new MonitorManager();
    const processId = "test-process";
    const pid = 12345;

    // Start monitoring
    monitorManager.startMonitoring(processId, pid);

    // Initially should have empty or minimal history
    const history = monitorManager.getMetricsHistory(processId);
    expect(Array.isArray(history)).toBe(true);

    // Non-existent process should return empty array
    const nonExistentHistory = monitorManager.getMetricsHistory("non-existent");
    expect(nonExistentHistory).toEqual([]);

    monitorManager.cleanup();
});

test("MonitorManager - should cleanup properly", () => {
  const monitorManager = new MonitorManager();
    const processId1 = "test-process-1";
    const processId2 = "test-process-2";
    const pid1 = 12345;
    const pid2 = 12346;

    // Start monitoring multiple processes
    monitorManager.startMonitoring(processId1, pid1);
    monitorManager.startMonitoring(processId2, pid2);

    // Verify they're being monitored
    expect(monitorManager.getMetrics(processId1)).toBeDefined();
    expect(monitorManager.getMetrics(processId2)).toBeDefined();

    // Cleanup
    monitorManager.cleanup();

    // Should no longer have any metrics
    expect(monitorManager.getMetrics(processId1)).toBeNull();
    expect(monitorManager.getMetrics(processId2)).toBeNull();
    expect(Object.keys(monitorManager.getAllMetrics())).toHaveLength(0);
});

test("MonitorManager - should handle restart monitoring after stop", () => {
  const monitorManager = new MonitorManager();
    const processId = "test-process";
    const pid1 = 12345;
    const pid2 = 12346;

    // Start monitoring
    monitorManager.startMonitoring(processId, pid1);
    expect(monitorManager.getMetrics(processId)).toBeDefined();

    // Stop monitoring
    monitorManager.stopMonitoring(processId);
    expect(monitorManager.getMetrics(processId)).toBeNull();

    // Start monitoring again with different PID
    monitorManager.startMonitoring(processId, pid2);
    const metrics = monitorManager.getMetrics(processId);
    expect(metrics).toBeDefined();
    expect(metrics?.uptime).toBeGreaterThanOrEqual(0);

    monitorManager.cleanup();
});

test("MonitorManager - should get current memory usage", () => {
  const monitorManager = new MonitorManager();
  const processId = "test-process";
  const pid = 12345;

  // Start monitoring
  monitorManager.startMonitoring(processId, pid);

  // Initially should be 0
  expect(monitorManager.getCurrentMemoryUsage(processId)).toBe(0);

  // Should return 0 for non-existent process
  expect(monitorManager.getCurrentMemoryUsage("non-existent")).toBe(0);

  // Simulate memory usage
  const processData = (monitorManager as any).monitoredProcesses.get(processId);
  if (processData) {
    processData.memory = 1024 * 1024; // 1MB
  }

  expect(monitorManager.getCurrentMemoryUsage(processId)).toBe(1024 * 1024);

  monitorManager.cleanup();
});

test("MonitorManager - should check all memory limits efficiently", () => {
  const monitorManager = new MonitorManager();
  
  // Set up test processes
  const processes = [
    { id: "proc1", pid: 1001, memory: 30 * 1024 * 1024, limit: 50 * 1024 * 1024 }, // OK
    { id: "proc2", pid: 1002, memory: 60 * 1024 * 1024, limit: 50 * 1024 * 1024 }, // Violation
    { id: "proc3", pid: 1003, memory: 40 * 1024 * 1024, limit: 50 * 1024 * 1024 }, // OK
  ];

  // Start monitoring and set memory usage
  const memoryLimits = new Map<string, number>();
  for (const proc of processes) {
    monitorManager.startMonitoring(proc.id, proc.pid);
    memoryLimits.set(proc.id, proc.limit);
    
    // Set memory usage
    const processData = (monitorManager as any).monitoredProcesses.get(proc.id);
    if (processData) {
      processData.memory = proc.memory;
    }
  }

  // Check for violations
  const violations = monitorManager.checkAllMemoryLimits(memoryLimits);
  
  expect(violations).toHaveLength(1);
  expect(violations).toContain("proc2");
  expect(violations).not.toContain("proc1");
  expect(violations).not.toContain("proc3");

  // Test with empty limits map
  const emptyViolations = monitorManager.checkAllMemoryLimits(new Map());
  expect(emptyViolations).toHaveLength(0);

  monitorManager.cleanup();
});

test("MonitorManager - should handle memory limit edge cases", () => {
  const monitorManager = new MonitorManager();
  const processId = "test-process";
  const pid = 12345;

  // Start monitoring
  monitorManager.startMonitoring(processId, pid);

  // Test with zero limit (should not violate)
  expect(monitorManager.checkMemoryLimit(processId, 0)).toBe(false);

  // Test with negative limit (should not violate)
  expect(monitorManager.checkMemoryLimit(processId, -1000)).toBe(false);

  // Set memory usage to exactly the limit
  const processData = (monitorManager as any).monitoredProcesses.get(processId);
  if (processData) {
    processData.memory = 1024 * 1024; // 1MB
  }

  // Exactly at limit should not violate
  expect(monitorManager.checkMemoryLimit(processId, 1024 * 1024)).toBe(false);

  // Just over limit should violate
  expect(monitorManager.checkMemoryLimit(processId, 1024 * 1024 - 1)).toBe(true);

  monitorManager.cleanup();
});