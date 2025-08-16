import { test, expect } from "bun:test";
import { ProcessManager } from "../src/core/process-manager.js";
import { LogManager } from "../src/core/log-manager.js";
import { createProcessConfig } from "../src/types/index.js";

test("Scale Command Integration", async () => {
  const logManager = new LogManager();
  const processManager = new ProcessManager(logManager);

  try {
    // Test scaling up from 1 to 4 instances
    const config = createProcessConfig({
      id: "scale-integration-test",
      name: "scale-test",
      script: "test/fixtures/simple-server.js",
      instances: 1
    });

    // Start with 1 instance
    const initialInstances = await processManager.start(config);
    expect(initialInstances).toHaveLength(1);
    expect(initialInstances[0].id).toBe("scale-integration-test");

    // Scale up to 4 instances
    const scaledUpInstances = await processManager.scale("scale-integration-test", 4);
    expect(scaledUpInstances).toHaveLength(4);
    
    // Check instance IDs are correct
    const instanceIds = scaledUpInstances.map(i => i.id).sort();
    expect(instanceIds).toEqual([
      "scale-integration-test_0",
      "scale-integration-test_1", 
      "scale-integration-test_2",
      "scale-integration-test_3"
    ]);

    // Verify all instances are running
    const allProcesses = processManager.list();
    const testProcesses = allProcesses.filter(p => p.id.startsWith("scale-integration-test"));
    expect(testProcesses).toHaveLength(4);

    // Scale down to 2 instances
    const scaledDownInstances = await processManager.scale("scale-integration-test", 2);
    expect(scaledDownInstances).toHaveLength(2);

    // Wait a moment for processes to be fully stopped
    await new Promise(resolve => setTimeout(resolve, 200));

    // Verify only 2 instances remain
    const remainingProcesses = processManager.list().filter(p => p.id.startsWith("scale-integration-test"));
    expect(remainingProcesses).toHaveLength(2);

    // Scale down to 1 instance (should rename back to base ID)
    const singleInstance = await processManager.scale("scale-integration-test", 1);
    expect(singleInstance).toHaveLength(1);
    expect(singleInstance[0].id).toBe("scale-integration-test");

    // Clean up
    await processManager.cleanup();
  } catch (error) {
    await processManager.cleanup();
    throw error;
  }
});

test("PORT Assignment for Clustering", async () => {
  const logManager = new LogManager();
  const processManager = new ProcessManager(logManager);

  try {
    const config = createProcessConfig({
      id: "port-test",
      name: "port-test",
      script: "test/fixtures/simple-server.js",
      instances: 3,
      env: { PORT: "4000" }
    });

    const instances = await processManager.start(config);
    expect(instances).toHaveLength(3);

    // Verify instances have correct IDs
    const instanceIds = instances.map(i => i.id).sort();
    expect(instanceIds).toEqual([
      "port-test_0",
      "port-test_1",
      "port-test_2"
    ]);

    // Note: We can't easily test the actual PORT environment variables
    // without more complex subprocess inspection, but the logic is tested
    // in the process manager unit tests

    await processManager.cleanup();
  } catch (error) {
    await processManager.cleanup();
    throw error;
  }
});

test("Cluster-aware Restart", async () => {
  const logManager = new LogManager();
  const processManager = new ProcessManager(logManager);

  try {
    const config = createProcessConfig({
      id: "restart-cluster-test",
      name: "restart-cluster-test", 
      script: "test/fixtures/simple-server.js",
      instances: 3
    });

    const instances = await processManager.start(config);
    expect(instances).toHaveLength(3);

    // Restart a specific instance
    const instanceToRestart = instances[1]; // restart-cluster-test_1
    const restartedInstance = await processManager.restart(instanceToRestart.id);
    
    expect(restartedInstance.id).toBe(instanceToRestart.id);
    expect(restartedInstance.pid).not.toBe(instanceToRestart.pid); // Should have new PID
    expect(restartedInstance.restartCount).toBe(0); // Restart count should be reset for manual restart

    // Verify other instances are still running
    const allProcesses = processManager.list();
    const clusterProcesses = allProcesses.filter(p => p.id.startsWith("restart-cluster-test"));
    expect(clusterProcesses).toHaveLength(3);

    await processManager.cleanup();
  } catch (error) {
    await processManager.cleanup();
    throw error;
  }
});