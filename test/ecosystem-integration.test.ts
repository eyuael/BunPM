import { test, expect, beforeEach, afterEach } from "bun:test";
import { ProcessDaemon } from "../src/daemon/daemon.js";
import { IPCClient } from "../src/ipc/socket.js";
import { createIPCMessage } from "../src/types/index.js";
import { resolve } from "path";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";

let daemon: ProcessDaemon;
let client: IPCClient;
let testDir: string;
let socketPath: string;

beforeEach(async () => {
  // Create temporary directory for tests
  testDir = resolve(tmpdir(), `bun-pm-ecosystem-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  
  socketPath = resolve(testDir, 'test.sock');
  
  // Start daemon
  daemon = new ProcessDaemon(socketPath);
  await daemon.start();
  
  // Create client
  client = new IPCClient(socketPath);
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
  
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("should start processes from ecosystem file", async () => {
    // Create test scripts
    const app1Script = resolve(testDir, 'app1.js');
    const app2Script = resolve(testDir, 'app2.js');
    
    writeFileSync(app1Script, `
      console.log('App1 starting');
      setTimeout(() => {
        console.log('App1 running');
      }, 100);
    `);
    
    writeFileSync(app2Script, `
      console.log('App2 starting');
      setTimeout(() => {
        console.log('App2 running');
      }, 100);
    `);

    // Create ecosystem configuration
    const ecosystemConfig = {
      apps: [
        {
          id: "app1",
          name: "app1",
          script: "./app1.js",
          cwd: testDir,
          env: {
            NODE_ENV: "test",
            PORT: "3001"
          },
          instances: 1,
          autorestart: true
        },
        {
          id: "app2", 
          name: "app2",
          script: "./app2.js",
          cwd: testDir,
          env: {
            NODE_ENV: "test",
            PORT: "3002"
          },
          instances: 2,
          autorestart: false
        }
      ],
      version: "1.0.0",
      created: new Date().toISOString()
    };

    const configPath = resolve(testDir, 'ecosystem.json');
    writeFileSync(configPath, JSON.stringify(ecosystemConfig, null, 2));

    // Start processes from ecosystem file
    const startMessage = createIPCMessage('startFromFile', { filePath: configPath });
    const startResponse = await client.sendMessage(startMessage);

    expect(startResponse.success).toBe(true);
    expect(startResponse.data.successCount).toBe(2);
    expect(startResponse.data.totalApps).toBe(2);
    expect(startResponse.data.results).toHaveLength(2);

    // Verify both apps started successfully
    const results = startResponse.data.results;
    expect(results[0].success).toBe(true);
    expect(results[0].id).toBe("app1");
    expect(results[0].instances).toBe(1);
    
    expect(results[1].success).toBe(true);
    expect(results[1].id).toBe("app2");
    expect(results[1].instances).toBe(2);

    // Wait a moment for processes to start
    await new Promise(resolve => setTimeout(resolve, 200));

    // Verify processes are running
    const listMessage = createIPCMessage('list', {});
    const listResponse = await client.sendMessage(listMessage);

    expect(listResponse.success).toBe(true);
    const processes = listResponse.data.processes;
    expect(processes).toHaveLength(3); // 1 + 2 instances

    // Check that we have the right processes
    const processIds = processes.map((p: any) => p.id);
    expect(processIds).toContain("app1");
    expect(processIds).toContain("app2_0");
    expect(processIds).toContain("app2_1");
  });

test("should start specific app from ecosystem file", async () => {
    // Create test scripts
    const app1Script = resolve(testDir, 'app1.js');
    const app2Script = resolve(testDir, 'app2.js');
    
    writeFileSync(app1Script, 'console.log("App1 starting");');
    writeFileSync(app2Script, 'console.log("App2 starting");');

    // Create ecosystem configuration
    const ecosystemConfig = {
      apps: [
        {
          id: "app1",
          name: "app1", 
          script: "./app1.js",
          cwd: testDir
        },
        {
          id: "app2",
          name: "app2",
          script: "./app2.js", 
          cwd: testDir
        }
      ]
    };

    const configPath = resolve(testDir, 'ecosystem.json');
    writeFileSync(configPath, JSON.stringify(ecosystemConfig, null, 2));

    // Start only app1 from ecosystem file
    const startMessage = createIPCMessage('startFromFile', { 
      filePath: configPath,
      appName: "app1"
    });
    const startResponse = await client.sendMessage(startMessage);

    expect(startResponse.success).toBe(true);
    expect(startResponse.data.successCount).toBe(1);
    expect(startResponse.data.totalApps).toBe(1);
    expect(startResponse.data.results[0].id).toBe("app1");

    // Verify only app1 is running
    const listMessage = createIPCMessage('list', {});
    const listResponse = await client.sendMessage(listMessage);

    expect(listResponse.success).toBe(true);
    const processes = listResponse.data.processes;
    expect(processes).toHaveLength(1);
    expect(processes[0].id).toBe("app1");
  });

test("should save current processes to ecosystem file", async () => {
    // Start some processes manually first
    const testScript = resolve(testDir, 'test.js');
    writeFileSync(testScript, 'console.log("Test app");');

    const config1 = {
      id: "manual1",
      name: "manual1",
      script: testScript,
      cwd: testDir,
      env: { TEST: "value1" },
      instances: 1,
      autorestart: true,
      maxRestarts: 10
    };

    const config2 = {
      id: "manual2", 
      name: "manual2",
      script: testScript,
      cwd: testDir,
      env: { TEST: "value2" },
      instances: 2,
      autorestart: false,
      maxRestarts: 5
    };

    // Start the processes
    const start1Message = createIPCMessage('start', { config: config1 });
    const start1Response = await client.sendMessage(start1Message);
    expect(start1Response.success).toBe(true);

    const start2Message = createIPCMessage('start', { config: config2 });
    const start2Response = await client.sendMessage(start2Message);
    expect(start2Response.success).toBe(true);

    // Save to ecosystem file
    const savePath = resolve(testDir, 'saved-ecosystem.json');
    const saveMessage = createIPCMessage('save', { filePath: savePath });
    const saveResponse = await client.sendMessage(saveMessage);

    expect(saveResponse.success).toBe(true);
    expect(saveResponse.data.processCount).toBe(2);
    expect(existsSync(savePath)).toBe(true);

    // Verify saved content
    const savedContent = JSON.parse(await Bun.file(savePath).text());
    expect(savedContent.apps).toHaveLength(2);
    
    const savedApps = savedContent.apps;
    const app1 = savedApps.find((app: any) => app.id === "manual1");
    const app2 = savedApps.find((app: any) => app.id === "manual2");
    
    expect(app1).toBeDefined();
    expect(app1.name).toBe("manual1");
    expect(app1.env.TEST).toBe("value1");
    expect(app1.instances).toBe(1);
    expect(app1.autorestart).toBe(true);
    
    expect(app2).toBeDefined();
    expect(app2.name).toBe("manual2");
    expect(app2.env.TEST).toBe("value2");
    expect(app2.instances).toBe(2);
    expect(app2.autorestart).toBe(false);
  });

test("should load processes from ecosystem file", async () => {
    // Create test script that runs longer
    const testScript = resolve(testDir, 'load-test.js');
    writeFileSync(testScript, `
      console.log("Load test app starting");
      setInterval(() => {
        console.log("Load test app running");
      }, 1000);
    `);

    // Create ecosystem configuration
    const ecosystemConfig = {
      apps: [
        {
          id: "load1",
          name: "load1",
          script: "./load-test.js",
          cwd: testDir,
          env: { LOAD_TEST: "true" },
          instances: 1
        },
        {
          id: "load2",
          name: "load2", 
          script: "./load-test.js",
          cwd: testDir,
          env: { LOAD_TEST: "true", PORT: "4000" },
          instances: 3
        }
      ],
      version: "1.0.0"
    };

    const configPath = resolve(testDir, 'load-ecosystem.json');
    writeFileSync(configPath, JSON.stringify(ecosystemConfig, null, 2));

    // Load processes from ecosystem file
    const loadMessage = createIPCMessage('load', { filePath: configPath });
    const loadResponse = await client.sendMessage(loadMessage);

    expect(loadResponse.success).toBe(true);
    expect(loadResponse.data.successCount).toBe(2);
    expect(loadResponse.data.totalApps).toBe(2);

    // Wait for processes to start
    await new Promise(resolve => setTimeout(resolve, 200));

    // Verify processes are running
    const listMessage = createIPCMessage('list', {});
    const listResponse = await client.sendMessage(listMessage);

    expect(listResponse.success).toBe(true);
    const processes = listResponse.data.processes;
    expect(processes).toHaveLength(4); // 1 + 3 instances

    const processIds = processes.map((p: any) => p.id);
    expect(processIds).toContain("load1");
    expect(processIds).toContain("load2_0");
    expect(processIds).toContain("load2_1");
    expect(processIds).toContain("load2_2");
  });

test("should handle ecosystem file with errors gracefully", async () => {
    // Create ecosystem with some valid and some invalid apps
    const validScript = resolve(testDir, 'valid.js');
    writeFileSync(validScript, 'console.log("Valid app");');

    const ecosystemConfig = {
      apps: [
        {
          id: "valid-app",
          name: "valid-app",
          script: "./valid.js",
          cwd: testDir
        },
        {
          id: "invalid-app",
          name: "invalid-app",
          script: "./nonexistent.js", // This file doesn't exist
          cwd: testDir
        }
      ]
    };

    const configPath = resolve(testDir, 'mixed-ecosystem.json');
    writeFileSync(configPath, JSON.stringify(ecosystemConfig, null, 2));

    // Try to start from ecosystem file
    const startMessage = createIPCMessage('startFromFile', { filePath: configPath });
    const startResponse = await client.sendMessage(startMessage);

    // Should report errors but not completely fail
    expect(startResponse.success).toBe(false);
    expect(startResponse.error).toContain('Configuration file errors');
  });

test("should handle duplicate process IDs", async () => {
    // Start a process manually first
    const testScript = resolve(testDir, 'duplicate-test.js');
    writeFileSync(testScript, 'console.log("Duplicate test");');

    const manualConfig = {
      id: "duplicate-id",
      name: "manual-process",
      script: testScript,
      cwd: testDir,
      instances: 1,
      autorestart: true,
      maxRestarts: 10
    };

    const startMessage = createIPCMessage('start', { config: manualConfig });
    const startResponse = await client.sendMessage(startMessage);
    expect(startResponse.success).toBe(true);

    // Now try to start from ecosystem file with same ID
    const ecosystemConfig = {
      apps: [
        {
          id: "duplicate-id", // Same ID as manually started process
          name: "ecosystem-process",
          script: "./duplicate-test.js",
          cwd: testDir
        }
      ]
    };

    const configPath = resolve(testDir, 'duplicate-ecosystem.json');
    writeFileSync(configPath, JSON.stringify(ecosystemConfig, null, 2));

    const loadMessage = createIPCMessage('startFromFile', { filePath: configPath });
    const loadResponse = await client.sendMessage(loadMessage);

    expect(loadResponse.success).toBe(true);
    expect(loadResponse.data.successCount).toBe(0);
    expect(loadResponse.data.results[0].success).toBe(false);
    expect(loadResponse.data.results[0].error).toContain('already exists');
});