import { test, expect } from "bun:test";
import { ProcessDaemon } from "../src/daemon/daemon.js";
import { IPCClient } from "../src/ipc/index.js";
import { createIPCMessage } from "../src/types/index.js";
import { mkdirSync, rmSync, existsSync } from "fs";
import { resolve } from "path";

test("Scale Command End-to-End Integration", async () => {
  const testDir = `/tmp/bun-pm-scale-test-${Date.now()}`;
  const socketPath = `${testDir}/daemon.sock`;
  
  // Create test directory
  mkdirSync(testDir, { recursive: true });

  const daemon = new ProcessDaemon(socketPath);
  const client = new IPCClient(socketPath);

  try {
    // Start daemon
    await daemon.start();
    await client.connect();

    // Start a process with 1 instance
    const startMessage = createIPCMessage('start', {
      config: {
        id: 'scale-e2e-test',
        name: 'scale-e2e-test',
        script: 'test/fixtures/simple-server.js',
        cwd: process.cwd(),
        env: { PORT: '4000' },
        instances: 1,
        autorestart: true,
        maxRestarts: 10
      }
    });

    const startResponse = await client.sendMessage(startMessage);
    expect(startResponse.success).toBe(true);
    expect(startResponse.data.instances).toHaveLength(1);

    // Wait for process to start
    await new Promise(resolve => setTimeout(resolve, 50));

    // Scale up to 3 instances
    const scaleUpMessage = createIPCMessage('scale', {
      id: 'scale-e2e-test',
      instances: 3
    });

    const scaleUpResponse = await client.sendMessage(scaleUpMessage);
    expect(scaleUpResponse.success).toBe(true);
    expect(scaleUpResponse.data.instances).toHaveLength(3);

    // Verify instance IDs
    const instanceIds = scaleUpResponse.data.instances.map((i: any) => i.id).sort();
    expect(instanceIds).toEqual([
      'scale-e2e-test_0',
      'scale-e2e-test_1', 
      'scale-e2e-test_2'
    ]);

    // List processes to verify
    const listMessage = createIPCMessage('list', {});
    const listResponse = await client.sendMessage(listMessage);
    expect(listResponse.success).toBe(true);
    
    const scaleProcesses = listResponse.data.processes.filter((p: any) => 
      p.id.startsWith('scale-e2e-test')
    );
    expect(scaleProcesses).toHaveLength(3);

    // Scale down to 1 instance
    const scaleDownMessage = createIPCMessage('scale', {
      id: 'scale-e2e-test',
      instances: 1
    });

    const scaleDownResponse = await client.sendMessage(scaleDownMessage);
    expect(scaleDownResponse.success).toBe(true);
    expect(scaleDownResponse.data.instances).toHaveLength(1);
    expect(scaleDownResponse.data.instances[0].id).toBe('scale-e2e-test');

    // Wait for scale down to complete
    await new Promise(resolve => setTimeout(resolve, 200));

    // Verify only 1 instance remains
    const finalListMessage = createIPCMessage('list', {});
    const finalListResponse = await client.sendMessage(finalListMessage);
    expect(finalListResponse.success).toBe(true);
    
    const finalProcesses = finalListResponse.data.processes.filter((p: any) => 
      p.id.startsWith('scale-e2e-test')
    );
    expect(finalProcesses).toHaveLength(1);
    expect(finalProcesses[0].id).toBe('scale-e2e-test');

  } finally {
    // Cleanup
    try {
      await client.disconnect();
      await daemon.stop();
    } catch (error) {
      console.error('Cleanup error:', error);
    }
    
    // Remove test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  }
});

test("Scale Command Error Handling", async () => {
  const testDir = `/tmp/bun-pm-scale-error-test-${Date.now()}`;
  const socketPath = `${testDir}/daemon.sock`;
  
  mkdirSync(testDir, { recursive: true });

  const daemon = new ProcessDaemon(socketPath);
  const client = new IPCClient(socketPath);

  try {
    await daemon.start();
    await client.connect();

    // Try to scale non-existent process
    const scaleMessage = createIPCMessage('scale', {
      id: 'non-existent-process',
      instances: 3
    });

    const scaleResponse = await client.sendMessage(scaleMessage);
    expect(scaleResponse.success).toBe(false);
    expect(scaleResponse.error).toContain('No processes found');

    // Try to scale with invalid instance count
    const invalidScaleMessage = createIPCMessage('scale', {
      id: 'any-process',
      instances: 0
    });

    const invalidScaleResponse = await client.sendMessage(invalidScaleMessage);
    expect(invalidScaleResponse.success).toBe(false);
    expect(invalidScaleResponse.error).toContain('positive integer');

  } finally {
    try {
      await client.disconnect();
      await daemon.stop();
    } catch (error) {
      console.error('Cleanup error:', error);
    }
    
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  }
});