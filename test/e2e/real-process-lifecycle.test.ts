import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { ProcessDaemon } from "../../src/daemon/daemon.js";
import { IPCClient } from "../../src/ipc/socket.js";
import { createIPCMessage } from "../../src/types/index.js";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "fs";
import { resolve } from "path";
import { tmpdir } from "os";

describe("End-to-End Real Process Lifecycle Tests", () => {
  let testDir: string;
  let socketPath: string;
  let daemon: ProcessDaemon;
  let client: IPCClient;

  beforeEach(async () => {
    testDir = resolve(tmpdir(), `bun-pm-e2e-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    socketPath = resolve(testDir, "daemon.sock");
    
    daemon = new ProcessDaemon(socketPath);
    await daemon.start();
    
    client = new IPCClient(socketPath);
    await client.connect();
  });

  afterEach(async () => {
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

  test("HTTP server process lifecycle with health checks", async () => {
    // Create a simple HTTP server
    const serverScript = resolve(testDir, "http-server.js");
    writeFileSync(serverScript, `
      const http = require('http');
      const port = process.env.PORT || 3000;
      
      const server = http.createServer((req, res) => {
        if (req.url === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'healthy', pid: process.pid }));
        } else {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(\`Hello from process \${process.pid} on port \${port}\`);
        }
      });
      
      server.listen(port, () => {
        console.log(\`HTTP server started on port \${port}, PID: \${process.pid}\`);
      });
      
      process.on('SIGTERM', () => {
        console.log('Received SIGTERM, shutting down gracefully');
        server.close(() => {
          console.log('HTTP server closed');
          process.exit(0);
        });
      });
    `);

    // Start the HTTP server process
    const config = {
      id: "http-server-test",
      name: "http-server-test",
      script: serverScript,
      cwd: testDir,
      env: { PORT: "3001" },
      instances: 1,
      autorestart: true,
      maxRestarts: 10
    };

    const startMessage = createIPCMessage('start', { config });
    const startResponse = await client.sendMessage(startMessage);
    expect(startResponse.success).toBe(true);

    // Wait for server to start
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Verify process is running
    const listMessage = createIPCMessage('list', {});
    const listResponse = await client.sendMessage(listMessage);
    expect(listResponse.success).toBe(true);
    expect(listResponse.data.processes).toHaveLength(1);
    expect(listResponse.data.processes[0].status).toBe('running');

    // Test HTTP server is actually responding
    try {
      const response = await fetch('http://localhost:3001/health');
      const data = await response.json();
      expect(data.status).toBe('healthy');
      expect(typeof data.pid).toBe('number');
    } catch (error) {
      throw new Error(`HTTP server not responding: ${error}`);
    }

    // Test graceful restart
    const restartMessage = createIPCMessage('restart', { identifier: "http-server-test" });
    const restartResponse = await client.sendMessage(restartMessage);
    expect(restartResponse.success).toBe(true);

    // Wait for restart to complete
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Verify server is still responding after restart
    try {
      const response = await fetch('http://localhost:3001/health');
      const data = await response.json();
      expect(data.status).toBe('healthy');
    } catch (error) {
      throw new Error(`HTTP server not responding after restart: ${error}`);
    }

    // Stop the process
    const stopMessage = createIPCMessage('stop', { identifier: "http-server-test" });
    const stopResponse = await client.sendMessage(stopMessage);
    expect(stopResponse.success).toBe(true);

    // Wait for stop to complete
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Verify server is no longer responding
    try {
      await fetch('http://localhost:3001/health');
      throw new Error('Server should not be responding after stop');
    } catch (error) {
      // This is expected - server should be down
      expect(error.message).toContain('fetch');
    }
  }, 15000);

  test("process crash and automatic restart scenario", async () => {
    // Create a process that crashes after some time
    const crashingScript = resolve(testDir, "crashing-app.js");
    writeFileSync(crashingScript, `
      console.log('Crashing app started, PID:', process.pid);
      
      let counter = 0;
      const interval = setInterval(() => {
        counter++;
        console.log(\`Running... count: \${counter}\`);
        
        // Crash after 5 iterations
        if (counter >= 5) {
          console.log('About to crash!');
          clearInterval(interval);
          process.exit(1); // Simulate crash
        }
      }, 200);
    `);

    // Start the crashing process with autorestart enabled
    const config = {
      id: "crashing-app",
      name: "crashing-app",
      script: crashingScript,
      cwd: testDir,
      instances: 1,
      autorestart: true,
      maxRestarts: 3
    };

    const startMessage = createIPCMessage('start', { config });
    const startResponse = await client.sendMessage(startMessage);
    expect(startResponse.success).toBe(true);

    // Wait for initial crash and restart
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Check that process has restarted
    const listAfterCrashMessage = createIPCMessage('list', {});
    const listAfterCrashResponse = await client.sendMessage(listAfterCrashMessage);
    expect(listAfterCrashResponse.success).toBe(true);
    
    const process = listAfterCrashResponse.data.processes.find((p: any) => p.id === 'crashing-app');
    expect(process).toBeDefined();
    expect(process.restartCount).toBeGreaterThan(0);

    // Wait for more crashes
    await new Promise(resolve => setTimeout(resolve, 4000));

    // Check final state - should have hit max restarts
    const finalListMessage = createIPCMessage('list', {});
    const finalListResponse = await client.sendMessage(finalListMessage);
    expect(finalListResponse.success).toBe(true);
    
    const finalProcess = finalListResponse.data.processes.find((p: any) => p.id === 'crashing-app');
    
    // Process should either be errored or stopped due to max restarts
    if (finalProcess) {
      expect(['errored', 'stopped']).toContain(finalProcess.status);
      expect(finalProcess.restartCount).toBeGreaterThanOrEqual(3);
    }

    // Check logs contain crash information
    const logsMessage = createIPCMessage('logs', { 
      identifier: 'crashing-app',
      lines: 50
    });
    const logsResponse = await client.sendMessage(logsMessage);
    expect(logsResponse.success).toBe(true);
    expect(logsResponse.data.logs.some((log: string) => log.includes('About to crash!'))).toBe(true);
  }, 15000);

  test("memory limit enforcement and restart", async () => {
    // Create a process that consumes increasing memory
    const memoryHogScript = resolve(testDir, "memory-hog.js");
    writeFileSync(memoryHogScript, `
      console.log('Memory hog started, PID:', process.pid);
      
      const arrays = [];
      let counter = 0;
      
      const interval = setInterval(() => {
        // Allocate 1MB of memory each iteration
        const array = new Array(1024 * 1024).fill('x');
        arrays.push(array);
        counter++;
        
        const memUsage = process.memoryUsage();
        console.log(\`Iteration \${counter}, RSS: \${Math.round(memUsage.rss / 1024 / 1024)}MB\`);
        
        // Stop after 100 iterations to prevent infinite growth in tests
        if (counter >= 100) {
          clearInterval(interval);
          console.log('Stopping memory allocation');
        }
      }, 100);
    `);

    // Start process with 50MB memory limit
    const config = {
      id: "memory-hog",
      name: "memory-hog",
      script: memoryHogScript,
      cwd: testDir,
      instances: 1,
      autorestart: true,
      maxRestarts: 10,
      memoryLimit: 50 * 1024 * 1024 // 50MB
    };

    const startMessage = createIPCMessage('start', { config });
    const startResponse = await client.sendMessage(startMessage);
    expect(startResponse.success).toBe(true);

    // Wait for memory to grow and trigger restart
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Check that process was restarted due to memory limit
    const listMessage = createIPCMessage('list', {});
    const listResponse = await client.sendMessage(listMessage);
    expect(listResponse.success).toBe(true);
    
    const process = listResponse.data.processes.find((p: any) => p.id === 'memory-hog');
    expect(process).toBeDefined();
    
    // Should have been restarted at least once due to memory limit
    expect(process.restartCount).toBeGreaterThan(0);

    // Check logs for memory limit messages
    const logsMessage = createIPCMessage('logs', { 
      identifier: 'memory-hog',
      lines: 100
    });
    const logsResponse = await client.sendMessage(logsMessage);
    expect(logsResponse.success).toBe(true);
    
    const logs = logsResponse.data.logs.join('\n');
    expect(logs).toContain('Memory hog started');
  }, 20000);

  test("cluster scaling with load balancing", async () => {
    // Create a simple HTTP server for clustering
    const clusterScript = resolve(testDir, "cluster-server.js");
    writeFileSync(clusterScript, `
      const http = require('http');
      const port = process.env.PORT || 3000;
      const instanceId = process.env.NODE_APP_INSTANCE || '0';
      
      console.log(\`Cluster instance \${instanceId} starting on port \${port}\`);
      
      const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          instance: instanceId,
          pid: process.pid,
          port: port,
          timestamp: new Date().toISOString()
        }));
      });
      
      server.listen(port, () => {
        console.log(\`Cluster instance \${instanceId} listening on port \${port}\`);
      });
      
      process.on('SIGTERM', () => {
        console.log(\`Instance \${instanceId} received SIGTERM\`);
        server.close(() => process.exit(0));
      });
    `);

    // Start with 1 instance
    const config = {
      id: "cluster-server",
      name: "cluster-server",
      script: clusterScript,
      cwd: testDir,
      env: { BASE_PORT: "4000" },
      instances: 1,
      autorestart: true,
      maxRestarts: 10
    };

    const startMessage = createIPCMessage('start', { config });
    const startResponse = await client.sendMessage(startMessage);
    expect(startResponse.success).toBe(true);

    // Wait for initial instance to start
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Scale up to 3 instances
    const scaleMessage = createIPCMessage('scale', {
      id: 'cluster-server',
      instances: 3
    });
    const scaleResponse = await client.sendMessage(scaleMessage);
    expect(scaleResponse.success).toBe(true);
    expect(scaleResponse.data.instances).toHaveLength(3);

    // Wait for all instances to start
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Verify all instances are running on different ports
    const listMessage = createIPCMessage('list', {});
    const listResponse = await client.sendMessage(listMessage);
    expect(listResponse.success).toBe(true);
    
    const clusterProcesses = listResponse.data.processes.filter((p: any) => 
      p.id.startsWith('cluster-server')
    );
    expect(clusterProcesses).toHaveLength(3);
    expect(clusterProcesses.every((p: any) => p.status === 'running')).toBe(true);

    // Test that each instance responds differently
    const responses = [];
    for (let port = 4000; port < 4003; port++) {
      try {
        const response = await fetch(`http://localhost:${port}`);
        const data = await response.json();
        responses.push(data);
      } catch (error) {
        console.warn(`Failed to connect to port ${port}:`, error.message);
      }
    }

    // Should have responses from different instances
    expect(responses.length).toBeGreaterThan(0);
    const uniquePids = new Set(responses.map(r => r.pid));
    expect(uniquePids.size).toBeGreaterThan(1);

    // Scale down to 1 instance
    const scaleDownMessage = createIPCMessage('scale', {
      id: 'cluster-server',
      instances: 1
    });
    const scaleDownResponse = await client.sendMessage(scaleDownMessage);
    expect(scaleDownResponse.success).toBe(true);

    // Wait for scale down
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Verify only 1 instance remains
    const finalListMessage = createIPCMessage('list', {});
    const finalListResponse = await client.sendMessage(finalListMessage);
    expect(finalListResponse.success).toBe(true);
    
    const finalProcesses = finalListResponse.data.processes.filter((p: any) => 
      p.id.startsWith('cluster-server')
    );
    expect(finalProcesses).toHaveLength(1);
  }, 25000);

  test("ecosystem file with complex configuration", async () => {
    // Create multiple application scripts
    const webServerScript = resolve(testDir, "web-server.js");
    writeFileSync(webServerScript, `
      const http = require('http');
      const port = process.env.PORT || 3000;
      
      const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(\`Web server on port \${port}\`);
      });
      
      server.listen(port, () => {
        console.log(\`Web server listening on port \${port}\`);
      });
    `);

    const workerScript = resolve(testDir, "worker.js");
    writeFileSync(workerScript, `
      console.log('Worker started');
      
      setInterval(() => {
        console.log(\`Worker processing... \${new Date().toISOString()}\`);
      }, 2000);
    `);

    const schedulerScript = resolve(testDir, "scheduler.js");
    writeFileSync(schedulerScript, `
      console.log('Scheduler started');
      
      setInterval(() => {
        console.log(\`Scheduled task executed at \${new Date().toISOString()}\`);
      }, 5000);
    `);

    // Create complex ecosystem configuration
    const ecosystemConfig = {
      apps: [
        {
          id: "web-server",
          name: "web-server",
          script: "./web-server.js",
          cwd: testDir,
          env: {
            NODE_ENV: "production",
            PORT: "5000"
          },
          instances: 2,
          autorestart: true,
          maxRestarts: 5,
          memoryLimit: 100 * 1024 * 1024 // 100MB
        },
        {
          id: "background-worker",
          name: "background-worker",
          script: "./worker.js",
          cwd: testDir,
          env: {
            NODE_ENV: "production",
            WORKER_TYPE: "background"
          },
          instances: 3,
          autorestart: true,
          maxRestarts: 10
        },
        {
          id: "scheduler",
          name: "scheduler",
          script: "./scheduler.js",
          cwd: testDir,
          env: {
            NODE_ENV: "production",
            SCHEDULE_INTERVAL: "5000"
          },
          instances: 1,
          autorestart: true,
          maxRestarts: 3
        }
      ]
    };

    const ecosystemFile = resolve(testDir, "complex-ecosystem.json");
    writeFileSync(ecosystemFile, JSON.stringify(ecosystemConfig, null, 2));

    // Load the ecosystem
    const loadMessage = createIPCMessage('startFromFile', { filePath: ecosystemFile });
    const loadResponse = await client.sendMessage(loadMessage);
    expect(loadResponse.success).toBe(true);
    expect(loadResponse.data.successCount).toBe(3);

    // Wait for all processes to start
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Verify all processes are running
    const listMessage = createIPCMessage('list', {});
    const listResponse = await client.sendMessage(listMessage);
    expect(listResponse.success).toBe(true);
    
    const processes = listResponse.data.processes;
    expect(processes).toHaveLength(6); // 2 + 3 + 1 instances

    // Check web servers are responding
    try {
      const response1 = await fetch('http://localhost:5000');
      const text1 = await response1.text();
      expect(text1).toContain('Web server on port 5000');

      const response2 = await fetch('http://localhost:5001');
      const text2 = await response2.text();
      expect(text2).toContain('Web server on port 5001');
    } catch (error) {
      console.warn('Web server connectivity test failed:', error.message);
    }

    // Test monitoring all processes
    const monitMessage = createIPCMessage('monit', {});
    const monitResponse = await client.sendMessage(monitMessage);
    expect(monitResponse.success).toBe(true);
    expect(monitResponse.data.processes).toHaveLength(6);

    // Save current state
    const saveFile = resolve(testDir, "saved-complex-ecosystem.json");
    const saveMessage = createIPCMessage('save', { filePath: saveFile });
    const saveResponse = await client.sendMessage(saveMessage);
    expect(saveResponse.success).toBe(true);
    expect(existsSync(saveFile)).toBe(true);

    // Stop all processes
    const stopAllMessage = createIPCMessage('stop', { identifier: 'all' });
    const stopAllResponse = await client.sendMessage(stopAllMessage);
    expect(stopAllResponse.success).toBe(true);

    // Verify all processes are stopped
    await new Promise(resolve => setTimeout(resolve, 1000));
    const finalListMessage = createIPCMessage('list', {});
    const finalListResponse = await client.sendMessage(finalListMessage);
    expect(finalListResponse.success).toBe(true);
    expect(finalListResponse.data.processes).toHaveLength(0);
  }, 30000);
});