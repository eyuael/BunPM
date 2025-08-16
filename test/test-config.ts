/**
 * Test Configuration and Utilities
 * 
 * Shared configuration and helper functions for all test suites
 */

import { mkdirSync, rmSync, existsSync } from "fs";
import { resolve } from "path";
import { tmpdir } from "os";

export interface TestConfig {
  // Timeouts for different test types
  timeouts: {
    unit: number;
    integration: number;
    performance: number;
    stress: number;
    e2e: number;
  };
  
  // Performance thresholds
  performance: {
    daemonStartup: number;      // ms
    daemonShutdown: number;     // ms
    ipcConnection: number;      // ms
    processStart: number;       // ms
    listCommand: number;        // ms
    daemonMemory: number;       // MB
  };
  
  // Stress test limits
  stress: {
    maxConcurrentProcesses: number;
    maxConcurrentClients: number;
    rapidCycles: number;
    logFrequency: number;       // ms
  };
  
  // Test environment
  environment: {
    cleanupDelay: number;       // ms
    processStartDelay: number;  // ms
    processStopDelay: number;   // ms
  };
}

export const testConfig: TestConfig = {
  timeouts: {
    unit: 10000,      // 10 seconds
    integration: 30000, // 30 seconds
    performance: 60000, // 1 minute
    stress: 120000,     // 2 minutes
    e2e: 180000        // 3 minutes
  },
  
  performance: {
    daemonStartup: 100,    // 100ms
    daemonShutdown: 50,    // 50ms
    ipcConnection: 10,     // 10ms
    processStart: 200,     // 200ms
    listCommand: 50,       // 50ms
    daemonMemory: 50       // 50MB
  },
  
  stress: {
    maxConcurrentProcesses: 100,
    maxConcurrentClients: 10,
    rapidCycles: 100,
    logFrequency: 1        // 1ms between log messages
  },
  
  environment: {
    cleanupDelay: 100,     // 100ms
    processStartDelay: 500, // 500ms
    processStopDelay: 200   // 200ms
  }
};

/**
 * Test Environment Manager
 * Handles creation and cleanup of test directories and resources
 */
export class TestEnvironment {
  public testDir: string;
  public socketPath: string;
  
  constructor(testName: string) {
    this.testDir = resolve(tmpdir(), `bun-pm-test-${testName}-${Date.now()}`);
    this.socketPath = resolve(this.testDir, "daemon.sock");
  }
  
  /**
   * Set up test environment
   */
  setup(): void {
    mkdirSync(this.testDir, { recursive: true });
  }
  
  /**
   * Clean up test environment
   */
  cleanup(): void {
    if (existsSync(this.testDir)) {
      rmSync(this.testDir, { recursive: true, force: true });
    }
  }
  
  /**
   * Get path for test file
   */
  getTestFilePath(filename: string): string {
    return resolve(this.testDir, filename);
  }
}

/**
 * Performance Measurement Utilities
 */
export class PerformanceMeasurement {
  private startTime: number = 0;
  
  start(): void {
    this.startTime = performance.now();
  }
  
  end(): number {
    return performance.now() - this.startTime;
  }
  
  static async measure<T>(fn: () => Promise<T>): Promise<{ result: T; duration: number }> {
    const start = performance.now();
    const result = await fn();
    const duration = performance.now() - start;
    return { result, duration };
  }
  
  static measureSync<T>(fn: () => T): { result: T; duration: number } {
    const start = performance.now();
    const result = fn();
    const duration = performance.now() - start;
    return { result, duration };
  }
}

/**
 * Test Script Generator
 * Creates common test scripts for various scenarios
 */
export class TestScriptGenerator {
  /**
   * Generate a simple test script
   */
  static simple(message: string = "Test app"): string {
    return `
      console.log("${message} started, PID:", process.pid);
      setTimeout(() => {
        console.log("${message} finished");
        process.exit(0);
      }, 100);
    `;
  }
  
  /**
   * Generate a long-running test script
   */
  static longRunning(message: string = "Long running app", interval: number = 1000): string {
    return `
      console.log("${message} started, PID:", process.pid);
      let counter = 0;
      setInterval(() => {
        console.log("${message} running... count:", ++counter);
      }, ${interval});
    `;
  }
  
  /**
   * Generate a crashing test script
   */
  static crashing(crashAfter: number = 5, interval: number = 200): string {
    return `
      console.log("Crashing app started, PID:", process.pid);
      let counter = 0;
      const interval = setInterval(() => {
        counter++;
        console.log(\`Running... count: \${counter}\`);
        if (counter >= ${crashAfter}) {
          console.log("About to crash!");
          clearInterval(interval);
          process.exit(1);
        }
      }, ${interval});
    `;
  }
  
  /**
   * Generate a memory-consuming test script
   */
  static memoryHog(allocatePerIteration: number = 1024 * 1024, maxIterations: number = 100): string {
    return `
      console.log("Memory hog started, PID:", process.pid);
      const arrays = [];
      let counter = 0;
      
      const interval = setInterval(() => {
        const array = new Array(${allocatePerIteration}).fill('x');
        arrays.push(array);
        counter++;
        
        const memUsage = process.memoryUsage();
        console.log(\`Iteration \${counter}, RSS: \${Math.round(memUsage.rss / 1024 / 1024)}MB\`);
        
        if (counter >= ${maxIterations}) {
          clearInterval(interval);
          console.log("Stopping memory allocation");
        }
      }, 100);
    `;
  }
  
  /**
   * Generate an HTTP server test script
   */
  static httpServer(port: string = "3000", healthEndpoint: boolean = true): string {
    return `
      const http = require('http');
      const port = process.env.PORT || ${port};
      
      const server = http.createServer((req, res) => {
        ${healthEndpoint ? `
        if (req.url === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'healthy', pid: process.pid, port }));
          return;
        }
        ` : ''}
        
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(\`Hello from process \${process.pid} on port \${port}\`);
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
    `;
  }
  
  /**
   * Generate a high-frequency logging script
   */
  static highFrequencyLogger(messagesPerSecond: number = 1000, totalMessages: number = 10000): string {
    const interval = 1000 / messagesPerSecond;
    
    return `
      console.log("High frequency logger started");
      let counter = 0;
      
      const interval = setInterval(() => {
        counter++;
        console.log(\`Log message \${counter} - \${new Date().toISOString()}\`);
        console.error(\`Error message \${counter} - \${new Date().toISOString()}\`);
        
        if (counter >= ${totalMessages}) {
          clearInterval(interval);
          console.log("Logging completed");
          process.exit(0);
        }
      }, ${interval});
    `;
  }
}

/**
 * Ecosystem Configuration Generator
 */
export class EcosystemGenerator {
  /**
   * Generate a simple ecosystem configuration
   */
  static simple(appCount: number = 2, baseDir: string): any {
    const apps = [];
    
    for (let i = 0; i < appCount; i++) {
      apps.push({
        id: `simple-app-${i}`,
        name: `simple-app-${i}`,
        script: `./simple-app-${i}.js`,
        cwd: baseDir,
        env: { NODE_ENV: "test", APP_ID: i.toString() },
        instances: 1,
        autorestart: true
      });
    }
    
    return { apps };
  }
  
  /**
   * Generate a complex ecosystem configuration
   */
  static complex(baseDir: string): any {
    return {
      apps: [
        {
          id: "web-server",
          name: "web-server",
          script: "./web-server.js",
          cwd: baseDir,
          env: { NODE_ENV: "production", PORT: "5000" },
          instances: 2,
          autorestart: true,
          maxRestarts: 5,
          memoryLimit: 100 * 1024 * 1024
        },
        {
          id: "worker",
          name: "worker",
          script: "./worker.js",
          cwd: baseDir,
          env: { NODE_ENV: "production", WORKER_TYPE: "background" },
          instances: 3,
          autorestart: true,
          maxRestarts: 10
        },
        {
          id: "scheduler",
          name: "scheduler",
          script: "./scheduler.js",
          cwd: baseDir,
          env: { NODE_ENV: "production" },
          instances: 1,
          autorestart: true,
          maxRestarts: 3
        }
      ]
    };
  }
}

/**
 * Test Assertion Helpers
 */
export class TestAssertions {
  /**
   * Assert performance threshold
   */
  static assertPerformance(actualMs: number, thresholdMs: number, operation: string): void {
    if (actualMs > thresholdMs) {
      throw new Error(`Performance threshold exceeded for ${operation}: ${actualMs.toFixed(2)}ms > ${thresholdMs}ms`);
    }
  }
  
  /**
   * Assert process is running
   */
  static assertProcessRunning(process: any, expectedId: string): void {
    if (!process) {
      throw new Error(`Process ${expectedId} not found`);
    }
    if (process.status !== 'running') {
      throw new Error(`Process ${expectedId} is not running: ${process.status}`);
    }
  }
  
  /**
   * Assert HTTP endpoint is responding
   */
  static async assertHttpEndpoint(url: string, expectedStatus: number = 200): Promise<any> {
    try {
      const response = await fetch(url);
      if (response.status !== expectedStatus) {
        throw new Error(`HTTP endpoint ${url} returned status ${response.status}, expected ${expectedStatus}`);
      }
      return response;
    } catch (error) {
      throw new Error(`HTTP endpoint ${url} is not responding: ${error}`);
    }
  }
}

/**
 * Async utilities for tests
 */
export class AsyncUtils {
  /**
   * Wait for a condition to be true
   */
  static async waitFor(
    condition: () => boolean | Promise<boolean>,
    timeoutMs: number = 5000,
    intervalMs: number = 100
  ): Promise<void> {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeoutMs) {
      if (await condition()) {
        return;
      }
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    
    throw new Error(`Condition not met within ${timeoutMs}ms`);
  }
  
  /**
   * Retry an operation with exponential backoff
   */
  static async retry<T>(
    operation: () => Promise<T>,
    maxAttempts: number = 3,
    baseDelayMs: number = 100
  ): Promise<T> {
    let lastError: Error;
    
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        
        if (attempt === maxAttempts) {
          break;
        }
        
        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    throw lastError!;
  }
}