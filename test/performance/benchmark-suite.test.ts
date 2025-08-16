import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { ProcessDaemon } from "../../src/daemon/daemon.js";
import { IPCClient } from "../../src/ipc/socket.js";
import { createIPCMessage } from "../../src/types/index.js";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "fs";
import { resolve } from "path";
import { tmpdir } from "os";

/**
 * Comprehensive benchmark suite for performance regression testing
 */

interface BenchmarkResult {
  name: string;
  duration: number;
  throughput?: number;
  memoryUsage?: number;
  success: boolean;
  error?: string;
}

class BenchmarkRunner {
  private results: BenchmarkResult[] = [];

  async runBenchmark(
    name: string,
    fn: () => Promise<void>,
    options: { 
      expectedMaxDuration?: number;
      measureThroughput?: boolean;
      operations?: number;
    } = {}
  ): Promise<BenchmarkResult> {
    const startTime = performance.now();
    const startMemory = process.memoryUsage();
    
    try {
      await fn();
      
      const endTime = performance.now();
      const endMemory = process.memoryUsage();
      const duration = endTime - startTime;
      const memoryUsage = endMemory.heapUsed - startMemory.heapUsed;
      
      const result: BenchmarkResult = {
        name,
        duration,
        memoryUsage,
        success: true
      };
      
      if (options.measureThroughput && options.operations) {
        result.throughput = options.operations / (duration / 1000); // ops per second
      }
      
      this.results.push(result);
      
      // Check performance expectations
      if (options.expectedMaxDuration && duration > options.expectedMaxDuration) {
        throw new Error(`Benchmark '${name}' took ${duration.toFixed(2)}ms, expected < ${options.expectedMaxDuration}ms`);
      }
      
      return result;
    } catch (error) {
      const endTime = performance.now();
      const duration = endTime - startTime;
      
      const result: BenchmarkResult = {
        name,
        duration,
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
      
      this.results.push(result);
      throw error;
    }
  }

  getResults(): BenchmarkResult[] {
    return [...this.results];
  }

  printSummary(): void {
    console.log("\n=== Benchmark Results ===");
    for (const result of this.results) {
      const status = result.success ? "✓" : "✗";
      const duration = result.duration.toFixed(2);
      const memory = result.memoryUsage ? `${(result.memoryUsage / 1024 / 1024).toFixed(2)}MB` : "N/A";
      const throughput = result.throughput ? `${result.throughput.toFixed(0)} ops/sec` : "";
      
      console.log(`${status} ${result.name}: ${duration}ms, Memory: ${memory} ${throughput}`);
      if (!result.success && result.error) {
        console.log(`  Error: ${result.error}`);
      }
    }
  }
}

describe("Performance Benchmark Suite", () => {
  let testDir: string;
  let socketPath: string;
  let daemon: ProcessDaemon;
  let client: IPCClient;
  let benchmark: BenchmarkRunner;

  beforeEach(async () => {
    testDir = resolve(tmpdir(), `bun-pm-benchmark-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    socketPath = resolve(testDir, "daemon.sock");
    
    daemon = new ProcessDaemon(socketPath);
    await daemon.start();
    
    client = new IPCClient(socketPath);
    await client.connect();
    
    benchmark = new BenchmarkRunner();
  });

  afterEach(async () => {
    try {
      benchmark.printSummary();
      await client.disconnect();
      await daemon.stop();
    } catch (error) {
      // Ignore cleanup errors
    }
    
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test("daemon startup performance benchmark", async () => {
    // This test measures daemon startup in isolation
    await daemon.stop();
    await client.disconnect();
    
    const newSocketPath = resolve(testDir, "benchmark-daemon.sock");
    
    await benchmark.runBenchmark(
      "Daemon Startup",
      async () => {
        const testDaemon = new ProcessDaemon(newSocketPath);
        await testDaemon.start();
        await testDaemon.stop();
      },
      { expectedMaxDuration: 100 }
    );
  });

  test("IPC connection establishment benchmark", async () => {
    await benchmark.runBenchmark(
      "IPC Connection",
      async () => {
        const testClient = new IPCClient(socketPath);
        await testClient.connect();
        await testClient.disconnect();
      },
      { expectedMaxDuration: 10 }
    );
  });

  test("process start throughput benchmark", async () => {
    const testScript = resolve(testDir, "throughput-test.js");
    writeFileSync(testScript, 'console.log("Throughput test"); process.exit(0);');
    
    const processCount = 20;
    
    await benchmark.runBenchmark(
      "Process Start Throughput",
      async () => {
        const promises: Promise<any>[] = [];
        
        for (let i = 0; i < processCount; i++) {
          const config = {
            id: `throughput-test-${i}`,
            name: `throughput-test-${i}`,
            script: testScript,
            cwd: testDir,
            instances: 1,
            autorestart: false,
            maxRestarts: 0
          };
          
          const message = createIPCMessage('start', { config });
          promises.push(client.sendMessage(message));
        }
        
        const responses = await Promise.all(promises);
        expect(responses.every(r => r.success)).toBe(true);
      },
      { 
        expectedMaxDuration: 2000,
        measureThroughput: true,
        operations: processCount
      }
    );
  });

  test("process stop throughput benchmark", async () => {
    // First start processes
    const testScript = resolve(testDir, "stop-throughput-test.js");
    writeFileSync(testScript, `
      setInterval(() => {
        console.log("Running...");
      }, 1000);
    `);
    
    const processCount = 20;
    const processIds: string[] = [];
    
    for (let i = 0; i < processCount; i++) {
      const config = {
        id: `stop-throughput-test-${i}`,
        name: `stop-throughput-test-${i}`,
        script: testScript,
        cwd: testDir,
        instances: 1,
        autorestart: false,
        maxRestarts: 0
      };
      
      const message = createIPCMessage('start', { config });
      await client.sendMessage(message);
      processIds.push(config.id);
    }
    
    // Wait for processes to start
    await new Promise(resolve => setTimeout(resolve, 500));
    
    await benchmark.runBenchmark(
      "Process Stop Throughput",
      async () => {
        const promises = processIds.map(id => {
          const message = createIPCMessage('stop', { identifier: id });
          return client.sendMessage(message);
        });
        
        const responses = await Promise.all(promises);
        expect(responses.every(r => r.success)).toBe(true);
      },
      { 
        expectedMaxDuration: 1500,
        measureThroughput: true,
        operations: processCount
      }
    );
  });

  test("log retrieval performance benchmark", async () => {
    // Start a process that generates logs
    const testScript = resolve(testDir, "log-perf-test.js");
    writeFileSync(testScript, `
      for (let i = 0; i < 500; i++) {
        console.log(\`Log message \${i} - \${new Date().toISOString()}\`);
      }
      setInterval(() => {
        console.log("Periodic log message");
      }, 100);
    `);
    
    const config = {
      id: "log-perf-test",
      name: "log-perf-test",
      script: testScript,
      cwd: testDir,
      instances: 1,
      autorestart: true,
      maxRestarts: 10
    };
    
    const startMessage = createIPCMessage('start', { config });
    await client.sendMessage(startMessage);
    
    // Wait for logs to be generated
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    const logRequests = 50;
    
    await benchmark.runBenchmark(
      "Log Retrieval Performance",
      async () => {
        const promises: Promise<any>[] = [];
        
        for (let i = 0; i < logRequests; i++) {
          const message = createIPCMessage('logs', { 
            identifier: "log-perf-test",
            lines: 100
          });
          promises.push(client.sendMessage(message));
        }
        
        const responses = await Promise.all(promises);
        expect(responses.every(r => r.success)).toBe(true);
      },
      { 
        expectedMaxDuration: 1000,
        measureThroughput: true,
        operations: logRequests
      }
    );
  });

  test("monitoring data collection benchmark", async () => {
    // Start multiple processes for monitoring
    const processCount = 15;
    const testScript = resolve(testDir, "monitor-perf-test.js");
    writeFileSync(testScript, `
      setInterval(() => {
        // Create some CPU load
        let sum = 0;
        for (let i = 0; i < 50000; i++) {
          sum += Math.random();
        }
        console.log("CPU load simulation");
      }, 1000);
    `);
    
    for (let i = 0; i < processCount; i++) {
      const config = {
        id: `monitor-perf-test-${i}`,
        name: `monitor-perf-test-${i}`,
        script: testScript,
        cwd: testDir,
        instances: 1,
        autorestart: true,
        maxRestarts: 10
      };
      
      const message = createIPCMessage('start', { config });
      await client.sendMessage(message);
    }
    
    // Wait for monitoring data to accumulate
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    const monitoringRequests = 25;
    
    await benchmark.runBenchmark(
      "Monitoring Data Collection",
      async () => {
        const promises: Promise<any>[] = [];
        
        for (let i = 0; i < monitoringRequests; i++) {
          const message = createIPCMessage('monit', {});
          promises.push(client.sendMessage(message));
        }
        
        const responses = await Promise.all(promises);
        expect(responses.every(r => r.success)).toBe(true);
        expect(responses.every(r => r.data.processes.length === processCount)).toBe(true);
      },
      { 
        expectedMaxDuration: 800,
        measureThroughput: true,
        operations: monitoringRequests
      }
    );
  });

  test("concurrent operations benchmark", async () => {
    const testScript = resolve(testDir, "concurrent-test.js");
    writeFileSync(testScript, `
      console.log("Concurrent test process");
      setInterval(() => {
        console.log("Running...");
      }, 1000);
    `);
    
    await benchmark.runBenchmark(
      "Concurrent Operations",
      async () => {
        const operations: Promise<any>[] = [];
        
        // Mix of different operations
        for (let i = 0; i < 10; i++) {
          // Start process
          const config = {
            id: `concurrent-test-${i}`,
            name: `concurrent-test-${i}`,
            script: testScript,
            cwd: testDir,
            instances: 1,
            autorestart: true,
            maxRestarts: 10
          };
          
          const startMessage = createIPCMessage('start', { config });
          operations.push(client.sendMessage(startMessage));
          
          // List processes
          const listMessage = createIPCMessage('list', {});
          operations.push(client.sendMessage(listMessage));
          
          // Get status
          const statusMessage = createIPCMessage('status', {});
          operations.push(client.sendMessage(statusMessage));
        }
        
        const responses = await Promise.all(operations);
        expect(responses.every(r => r.success)).toBe(true);
      },
      { 
        expectedMaxDuration: 3000,
        measureThroughput: true,
        operations: 30 // 10 processes × 3 operations each
      }
    );
  });

  test("memory usage under sustained load", async () => {
    const testScript = resolve(testDir, "memory-load-test.js");
    writeFileSync(testScript, `
      let counter = 0;
      setInterval(() => {
        console.log(\`Memory load test message \${counter++}\`);
        console.error(\`Error message \${counter}\`);
      }, 50);
    `);
    
    await benchmark.runBenchmark(
      "Memory Usage Under Load",
      async () => {
        // Start multiple processes
        const processCount = 10;
        for (let i = 0; i < processCount; i++) {
          const config = {
            id: `memory-load-test-${i}`,
            name: `memory-load-test-${i}`,
            script: testScript,
            cwd: testDir,
            instances: 1,
            autorestart: true,
            maxRestarts: 10
          };
          
          const message = createIPCMessage('start', { config });
          await client.sendMessage(message);
        }
        
        // Perform sustained operations for 10 seconds
        const endTime = Date.now() + 10000;
        while (Date.now() < endTime) {
          // Rotate between different operations
          const operations = [
            () => client.sendMessage(createIPCMessage('list', {})),
            () => client.sendMessage(createIPCMessage('monit', {})),
            () => client.sendMessage(createIPCMessage('logs', { 
              identifier: `memory-load-test-${Math.floor(Math.random() * processCount)}`,
              lines: 50
            }))
          ];
          
          const randomOp = operations[Math.floor(Math.random() * operations.length)];
          await randomOp();
          
          // Small delay to prevent overwhelming
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      },
      { expectedMaxDuration: 15000 }
    );
  }, 20000);

  test("performance regression detection", () => {
    const results = benchmark.getResults();
    
    // Define performance baselines (these should be updated as optimizations are made)
    const baselines = {
      "Daemon Startup": 100,
      "IPC Connection": 10,
      "Process Start Throughput": 2000,
      "Process Stop Throughput": 1500,
      "Log Retrieval Performance": 1000,
      "Monitoring Data Collection": 800,
      "Concurrent Operations": 3000,
      "Memory Usage Under Load": 15000
    };
    
    for (const result of results) {
      if (result.success && baselines[result.name as keyof typeof baselines]) {
        const baseline = baselines[result.name as keyof typeof baselines];
        const performanceRatio = result.duration / baseline;
        
        console.log(`${result.name}: ${result.duration.toFixed(2)}ms (${(performanceRatio * 100).toFixed(1)}% of baseline)`);
        
        // Fail if performance is more than 50% worse than baseline
        if (performanceRatio > 1.5) {
          throw new Error(`Performance regression detected in '${result.name}': ${result.duration.toFixed(2)}ms > ${baseline * 1.5}ms`);
        }
      }
    }
  });
}, 60000);